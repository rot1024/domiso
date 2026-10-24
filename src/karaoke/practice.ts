import type { PitchSample, PitchTracker } from "../pitch";
import type { Sound } from "../sound";
import { solfege } from "../graph";
import { median } from "../pitch";
import { centsOff, midiToFreq } from "../theory";
import { JOIN_STAGE, progressOf, type Plan, type PlanPhrase, type Stage } from "./plan";
import type { KaraokePlayer } from "./player";

/** What the practice works on next. */
export type Item =
  | { kind: "review"; id: string }
  | { kind: "phrase"; id: string }
  | { kind: "join"; ids: [string, string] }
  | { kind: "block"; block: number }
  | { kind: "song" };

/**
 * Picks the next thing to practise, the way a teacher would:
 * 1. phrases cleared in an earlier session get one quick review,
 * 2. two neighbouring cleared phrases are joined,
 * 3. a block whose phrases are all cleared is sung through,
 * 4. otherwise the next phrase not yet cleared (phrases skipped this session come after the others),
 * 5. and when everything is cleared, the whole song once.
 */
export function nextItem(
  plan: Plan,
  reviewed: Set<string>,
  reviewDue: Set<string>,
  skipped: Set<string> = new Set(),
): Item | null {
  for (const id of plan.focus) {
    if (reviewDue.has(id) && !reviewed.has(id)) return { kind: "review", id };
  }
  const cleared = (id: string) => !!plan.progress[id]?.cleared;
  const phrase = (id: string) => plan.phrases.find((p) => p.id === id)!;
  for (let i = 0; i + 1 < plan.focus.length; i++) {
    const a = plan.focus[i];
    const b = plan.focus[i + 1];
    if (cleared(a) && cleared(b) && phrase(a).block === phrase(b).block && !plan.joined.includes(`${a}+${b}`)) {
      return { kind: "join", ids: [a, b] };
    }
  }
  for (let b = 0; b < plan.blocks.length; b++) {
    const ids = plan.focus.filter((id) => phrase(id).block === b);
    if (ids.length && ids.every(cleared) && !plan.joined.includes(`b${b}`)) return { kind: "block", block: b };
  }
  const todo = plan.focus.find((id) => !cleared(id) && !skipped.has(id)) ?? plan.focus.find((id) => !cleared(id));
  if (todo) return { kind: "phrase", id: todo };
  return plan.finished ? null : { kind: "song" };
}

/** Context played before the phrase so the entry can be felt, and after so its end isn't clipped. */
const LEAD_IN = 1.5;
const TAIL = 0.3;
/** After this many failures in a row, the stage steps back (or drills the worst notes). */
const FAILS_TO_STEP_BACK = 2;
/** A join or block failed this many times sends its weakest phrase back to practice. */
const JOIN_TRIES = 3;

export interface PracticeState {
  item: Item | null;
  /** What is being practised, for the header. */
  label: string;
  stage: string;
  speed: number;
  attempt: number;
  /** Passes in a row towards clearing the stage, and how many are needed. */
  passes: number;
  needed: number;
  lastScore: number | null;
  message: string;
  paused: boolean;
  done: boolean;
}

class Stopped extends Error {}

/** The first stage where the phrase is sung and scored: stepping back stops there. */
const firstSingStage = (stages: Stage[]) => Math.max(0, stages.findIndex((s) => s.kind === "sing"));

/** The first stage sung with the backing alone: where a phrase that slipped picks up again. */
function backingStage(stages: Stage[]): number {
  const i = stages.findIndex((s) => s.kind === "sing" && !s.play.voice && !s.play.melody);
  return i >= 0 ? i : stages.length - 1;
}

/**
 * Runs a practice plan hands-free: plays each attempt, scores it, speaks short feedback, and moves
 * through stages, joins, blocks and the final run-through, saving progress after every attempt.
 */
export class PracticeSession {
  state: PracticeState;
  onState: (s: PracticeState) => void = () => {};
  /** Called whenever progress changes, to persist the plan. */
  onProgress: (plan: Plan) => void = () => {};
  private stopped = false;
  private skipRequested = false;
  private pauseWaiter: (() => void) | null = null;
  private reviewed = new Set<string>();
  private skipped = new Set<string>();
  private reviewDue: Set<string>;
  private silent = 0;

  constructor(
    private plan: Plan,
    private player: KaraokePlayer,
    private sound: Sound,
    private tracker: PitchTracker,
  ) {
    // Phrases cleared before this session get a quick review first.
    this.reviewDue = new Set(plan.focus.filter((id) => plan.progress[id]?.cleared));
    this.state = {
      item: null,
      label: "",
      stage: "",
      speed: 1,
      attempt: 0,
      passes: 0,
      needed: 0,
      lastScore: null,
      message: "",
      paused: false,
      done: false,
    };
  }

  async run() {
    this.tracker.onSample = (s) => this.player.handleSample(s);
    this.tracker.start();
    try {
      await this.say("練習をはじめます");
      for (;;) {
        const item = nextItem(this.plan, this.reviewed, this.reviewDue, this.skipped);
        if (!item) break;
        this.skipRequested = false;
        if (item.kind === "phrase") {
          await this.practisePhrase(item.id);
          if (this.skipRequested) this.skipped.add(item.id);
        }
        else if (item.kind === "review") await this.review(item.id);
        else if (item.kind === "join") await this.join(item, this.phrase(item.ids[0]).start, this.phrase(item.ids[1]).end, `${item.ids[0]}+${item.ids[1]}`, "つなげて");
        else if (item.kind === "block") {
          const b = this.plan.blocks[item.block];
          await this.join(item, b.start, b.end, `b${item.block}`, `${b.name}を通して`);
        } else await this.wholeSong();
      }
      this.set({ done: true, message: "このプランの練習はすべて終わりました" });
      await this.say("おつかれさまでした。プランの練習はすべて終わりです");
    } catch (e) {
      if (!(e instanceof Stopped)) throw e;
    } finally {
      this.tracker.stop();
      this.player.stop();
    }
  }

  stop() {
    this.stopped = true;
    this.player.stop();
    this.sound.stopAll();
    speechSynthesis?.cancel();
    this.pauseWaiter?.();
  }

  /** Moves on from the current phrase or join without clearing it. */
  skip() {
    this.skipRequested = true;
    this.player.stop();
  }

  togglePause() {
    if (this.state.paused) {
      this.set({ paused: false });
      this.pauseWaiter?.();
      this.pauseWaiter = null;
    } else {
      this.set({ paused: true, message: "一時停止中" });
      this.player.stop();
    }
  }

  // --- Phrases ---

  private phrase(id: string): PlanPhrase {
    return this.plan.phrases.find((p) => p.id === id)!;
  }

  private label(ph: PlanPhrase): string {
    return `${ph.id}（${this.plan.blocks[ph.block]?.name ?? ""} ${clock(ph.start)}）`;
  }

  private async practisePhrase(id: string) {
    const ph = this.phrase(id);
    const prog = progressOf(this.plan, id);
    const stages = this.plan.stages;
    let fails = 0;
    let passes = 0;
    let attempt = 0;
    this.set({ item: { kind: "phrase", id }, label: this.label(ph), lastScore: null });
    if (ph.issues.length) await this.say(`次のフレーズ。${ph.issues[0].replace(/（.*）/, "")}`);

    while (!prog.cleared && !this.skipRequested) {
      const stage = stages[prog.stage];
      attempt++;
      this.set({ stage: stage.name, speed: stage.speed, attempt, passes, needed: stage.pass?.times ?? 0 });
      if (stage.kind === "listen") {
        await this.listen(ph.start, ph.end, stage);
        this.advance(prog, ph);
        passes = fails = 0;
        continue;
      }
      if (stage.kind === "notes") {
        const ok = await this.noteDrill(ph.first, ph.last);
        if (ok) this.advance(prog, ph);
        passes = fails = 0;
        continue;
      }
      // The starting note on the piano while there is still help; not once only the backing is left.
      const score = await this.attempt(ph.start, ph.end, stage, attempt === 1 || stage.play.voice || stage.play.melody);
      this.record(prog, score);
      if (score === null) continue;
      if (score >= stage.pass!.score) {
        passes++;
        fails = 0;
        if (passes >= stage.pass!.times) {
          this.advance(prog, ph);
          passes = 0;
          if (prog.cleared) await this.say("クリア。よくできました");
          else await this.say(`合格。次は${stages[prog.stage].name}`);
        }
      } else {
        passes = 0;
        fails++;
        if (fails >= FAILS_TO_STEP_BACK) {
          fails = 0;
          if (prog.stage > firstSingStage(stages)) {
            prog.stage--;
            await this.say(`ひとつ戻って、${stages[prog.stage].name}`);
          } else {
            // Already at the most help: drill the notes that keep going wrong.
            const worst = this.player.worstNote(ph.start, ph.end);
            if (worst) {
              await this.say("苦手な音だけ練習します");
              await this.noteDrill(Math.max(ph.first, worst.index - 1), Math.min(ph.last, worst.index + 1));
            }
          }
        }
      }
      this.onProgress(this.plan);
    }
  }

  private advance(prog: ReturnType<typeof progressOf>, ph: PlanPhrase) {
    if (prog.stage + 1 >= this.plan.stages.length) prog.cleared = true;
    else prog.stage++;
    if (prog.cleared) this.reviewDue.delete(ph.id);
    this.onProgress(this.plan);
  }

  private record(prog: ReturnType<typeof progressOf>, score: number | null) {
    prog.history.push({ date: new Date().toISOString(), stage: prog.stage, score });
    if (score !== null) prog.best = Math.max(prog.best, score);
    this.onProgress(this.plan);
  }

  /** A phrase cleared last time: one go at full speed; if it has slipped, it goes back to practice. */
  private async review(id: string) {
    this.reviewed.add(id);
    const ph = this.phrase(id);
    const prog = progressOf(this.plan, id);
    const last = this.plan.stages[this.plan.stages.length - 1];
    this.set({ item: { kind: "review", id }, label: this.label(ph), stage: "前回のおさらい", speed: last.speed, attempt: 1, passes: 0, needed: 1 });
    await this.say("前回クリアしたフレーズのおさらい");
    const score = await this.attempt(ph.start, ph.end, last, true);
    this.record(prog, score);
    if (score !== null && score < last.pass!.score) {
      prog.cleared = false;
      // Back to backing-only practice, not from scratch.
      prog.stage = backingStage(this.plan.stages);
      await this.say("少し崩れているので、もう一度練習します");
    }
    this.onProgress(this.plan);
  }

  /** Two phrases joined, or a whole block: sung at full speed with backing only. */
  private async join(item: Item, from: number, to: number, key: string, name: string) {
    const ids = this.plan.focus.filter((id) => this.phrase(id).start >= from && this.phrase(id).end <= to);
    this.set({ item, label: `${clock(from)}〜${clock(to)}`, stage: name, speed: JOIN_STAGE.speed, passes: 0, needed: 1, lastScore: null });
    await this.say(name === "つなげて" ? "2つのフレーズをつなげて歌います" : `${name}歌います`);
    for (let tries = 1; tries <= JOIN_TRIES && !this.skipRequested; tries++) {
      this.set({ attempt: tries });
      const score = await this.attempt(from, to, JOIN_STAGE, false);
      if (score !== null && score >= JOIN_STAGE.pass!.score) {
        this.plan.joined.push(key);
        this.onProgress(this.plan);
        await this.say("つながりました");
        return;
      }
    }
    if (this.skipRequested) {
      this.plan.joined.push(key);
      this.onProgress(this.plan);
      return;
    }
    // Still not holding together: the weakest phrase in it goes back to practice.
    const weakest = ids
      .map((id) => ({ id, s: this.player.rangeScore(this.phrase(id).start, this.phrase(id).end) ?? 0 }))
      .sort((a, b) => a.s - b.s)[0];
    if (weakest) {
      const prog = progressOf(this.plan, weakest.id);
      prog.cleared = false;
      prog.stage = backingStage(this.plan.stages);
      await this.say("通すと崩れるフレーズがあるので、そこをもう一度練習します");
    } else {
      this.plan.joined.push(key);
    }
    this.onProgress(this.plan);
  }

  private async wholeSong() {
    this.set({ item: { kind: "song" }, label: "曲全体", stage: "通して歌う", speed: 1, attempt: 1, passes: 0, needed: 0, lastScore: null });
    await this.say("最後に、曲を通して歌います");
    const score = await this.attempt(0, this.player.duration, JOIN_STAGE, false, false);
    this.plan.finished = true;
    this.onProgress(this.plan);
    if (score !== null) await this.say(`通しで${score}点`);
  }

  // --- Attempts ---

  /** Plays the range for listening only. */
  private async listen(from: number, to: number, stage: Stage) {
    this.set({ message: "まず聴いてください" });
    this.player.setMix(stage.play);
    this.player.speed = stage.speed;
    await this.playRange(Math.max(0, from - LEAD_IN), to + TAIL);
  }

  /**
   * Sings the range once and returns its score (null if nothing was sung). Gives a starting note on
   * the piano when `cue` is set, and spoken feedback on the weakest note when `feedback` is set.
   */
  private async attempt(from: number, to: number, stage: Stage, cue: boolean, feedback = true): Promise<number | null> {
    await this.waitIfPaused();
    this.player.setMix(stage.play);
    this.player.speed = stage.speed;
    const first = this.player.notes.find((n) => n.start >= from);
    if (cue && first) {
      this.set({ message: "最初の音" });
      this.sound.playNote(Math.round(first.midi), this.sound.ctx.currentTime + 0.05, 0.8);
      await this.wait(1.1);
    }
    this.set({ message: "歌って" });
    await this.playRange(Math.max(0, from - LEAD_IN), to + TAIL);
    if (this.skipRequested) return null;
    // Paused partway: this attempt doesn't count; sing it again after resuming.
    if (this.state.paused) return this.attempt(from, to, stage, cue, feedback);
    const score = this.player.rangeScore(from, to);
    if (score === null) {
      this.silent++;
      this.set({ lastScore: null, message: "声が聞こえませんでした" });
      if (this.silent >= 2) await this.waitForVoice();
      return null;
    }
    this.silent = 0;
    this.set({ lastScore: score });
    if (!feedback) return score;
    const passed = stage.pass && score >= stage.pass.score;
    const worst = this.player.worstNote(from, to);
    if (passed || !worst || worst.bias === null) {
      this.set({ message: `${score}点` });
      await this.say(`${score}点`);
      return score;
    }
    const n = this.player.notes[worst.index];
    const dir = worst.bias < 0 ? "低い" : "高い";
    this.set({ message: `${score}点・「${solfege(n.midi)}」が${dir}（${Math.round(worst.bias)}¢）` });
    await this.say(`${score}点。${solfege(n.midi)}が${dir}`);
    // What you sang on that note, then the right pitch.
    const sung = this.player.trace.filter((p) => p.t >= n.start && p.t < n.end && p.midi !== null).map((p) => p.midi!);
    if (sung.length) {
      const end = this.sound.compare(midiToFreq(median(sung)), n.midi);
      await this.wait(end - this.sound.ctx.currentTime + 0.2);
    }
    return score;
  }

  /**
   * Piano plays each note slowly; you sing it back and hold it. Returns whether most notes were found.
   * Samples are ignored while the piano sounds, in case it is heard through a speaker.
   */
  private async noteDrill(first: number, last: number): Promise<boolean> {
    this.set({ stage: "音取り", message: "ピアノのあとに同じ音を出してください" });
    await this.say("ピアノのあとに、同じ音を出してください");
    let ok = 0;
    const notes = this.player.notes.slice(first, last + 1);
    for (const n of notes) {
      let passed = false;
      for (let tries = 0; tries < 2 && !passed; tries++) {
        await this.waitIfPaused();
        this.set({ message: `「${solfege(n.midi)}」` });
        const at = this.sound.ctx.currentTime + 0.05;
        this.sound.playNote(Math.round(n.midi), at, 0.9);
        await this.wait(1.1);
        const r = await this.listenNote(n.midi, 0.35, 4);
        passed = r.passed;
        if (passed) this.sound.pass();
        else if (r.freq !== null) {
          const end = this.sound.compare(r.freq, n.midi);
          await this.wait(end - this.sound.ctx.currentTime + 0.2);
        }
      }
      if (passed) ok++;
    }
    this.tracker.onSample = (s) => this.player.handleSample(s);
    const good = ok >= Math.ceil(notes.length * 0.8);
    await this.say(good ? "音が取れました" : "もう一度、ゆっくり合わせていきましょう");
    return good;
  }

  /** Listens for `target` held within tolerance for `hold` seconds, giving up after `max` seconds. */
  private listenNote(target: number, hold: number, max: number): Promise<{ passed: boolean; freq: number | null }> {
    const tol = this.plan.tolerance;
    return new Promise((resolve) => {
      const start = this.sound.ctx.currentTime;
      let inSince: number | null = null;
      const heard: number[] = [];
      const finish = (passed: boolean) => {
        this.tracker.onSample = () => {};
        clearInterval(guard);
        resolve({ passed, freq: heard.length ? median(heard.slice(-10)) : null });
      };
      const guard = setInterval(() => {
        if (this.stopped || this.sound.ctx.currentTime - start > max) finish(false);
      }, 100);
      this.tracker.onSample = (s: PitchSample) => {
        if (s.freq === null) {
          inSince = null;
          return;
        }
        heard.push(s.freq);
        if (Math.abs(centsOff(s.freq, target, true)) > tol) {
          inSince = null;
          return;
        }
        inSince ??= s.time;
        if (s.time - inSince >= hold) finish(true);
      };
    });
  }

  private playRange(from: number, to: number): Promise<void> {
    this.check();
    return new Promise<void>((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearInterval(guard);
        resolve();
      };
      this.player.playRange(from, to, finish);
      // Stop, skip and pause all stop the player, which never reaches the end of the range.
      const guard = setInterval(() => {
        if (this.stopped || this.skipRequested || this.state.paused) {
          this.player.stop();
          finish();
        }
      }, 100);
    }).then(() => this.check());
  }

  /** After two silent attempts: wait until the singer is back (a voice for 0.3 s). */
  private waitForVoice(): Promise<void> {
    this.set({ message: "声を出すと再開します" });
    void this.say("声を出すと再開します");
    return new Promise<void>((resolve) => {
      let since: number | null = null;
      this.tracker.onSample = (s) => {
        if (this.stopped) return resolve();
        if (s.freq === null) {
          since = null;
          return;
        }
        since ??= s.time;
        if (s.time - since > 0.3) {
          this.silent = 0;
          this.tracker.onSample = (x) => this.player.handleSample(x);
          resolve();
        }
      };
    }).then(() => this.check());
  }

  private waitIfPaused(): Promise<void> {
    this.check();
    if (!this.state.paused) return Promise.resolve();
    return new Promise<void>((r) => (this.pauseWaiter = r)).then(() => this.check());
  }

  private set(patch: Partial<PracticeState>) {
    this.state = { ...this.state, ...patch };
    this.onState(this.state);
  }

  private async say(text: string) {
    this.check();
    await this.sound.say(text);
    this.check();
  }

  private async wait(sec: number) {
    this.check();
    await new Promise((r) => setTimeout(r, Math.max(0, sec) * 1000));
    this.check();
  }

  private check() {
    if (this.stopped) throw new Stopped();
  }
}

function clock(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
