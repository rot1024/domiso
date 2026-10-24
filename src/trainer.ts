import type { PitchSample } from "./pitch";
import { median } from "./pitch";
import type { Sound } from "./sound";
import {
  centsOff,
  chordName,
  chordReading,
  chordTones,
  DEGREE_LABELS,
  nextChord,
  noteOrder,
  type Chord,
  type Order,
  type Progression,
} from "./theory";

export type Mode = "unison" | "chords" | "random" | "fade";

export interface Settings {
  home: number;
  mode: Mode;
  headphones: boolean;
  /** Allowed deviation in cents. */
  tolerance: number;
  /** Number of chords per session; 0 means endless. */
  rounds: number;
  speech: boolean;
  octaveFree: boolean;
}

/**
 * How much help the piano gives, from most to least.
 * 0: piano sounds the note while you sing
 * 1: piano sounds the note, then you sing
 * 2: only the chord is played
 * 3: only the root is played
 * 4: nothing is played after the first chord
 */
export const AID_LABELS = ["重ねる", "先に鳴らす", "和音だけ", "根音だけ", "最初だけ"];
export const MAX_AID = AID_LABELS.length - 1;

interface ModeConfig {
  progression: Progression;
  order: Order;
  aid: number;
  adaptive: boolean;
}

export const MODES: Record<Mode, ModeConfig & { label: string; description: string }> = {
  unison: { label: "重ねる", description: "ピアノと一緒にドミソ", progression: "fixed", order: "updown", aid: 0, adaptive: false },
  chords: { label: "コードチェンジ", description: "いろんなコードでドミソ", progression: "diatonic", order: "updown", aid: 1, adaptive: false },
  random: { label: "ランダム順", description: "ドミソの順番がバラバラ", progression: "diatonic", order: "random", aid: 1, adaptive: false },
  fade: { label: "補助輪フェード", description: "できるほど手助けが減る", progression: "random", order: "random", aid: 0, adaptive: true },
};

export type Phase = "prompt" | "listen" | "feedback" | "paused" | "done";

export interface NoteResult {
  degree: number;
  target: number;
  passed: boolean;
  voiced: boolean;
  /** Median deviation over the attempt, in cents. */
  deviation: number;
  /** Median deviation during the first 200ms after the voice started, in cents. */
  onset: number;
  sungFreq: number | null;
}

export interface TrainerState {
  phase: Phase;
  message: string;
  chord: string;
  tones: number[];
  order: number[];
  step: number;
  target: number | null;
  aid: number;
  round: number;
  passed: number;
  attempted: number;
  /** Whether the current note's attempt is inside tolerance right now. */
  inTune: boolean;
}

class Stopped extends Error {}

const HOLD_MS = 400;
const ONSET_MS = 200;

export class Trainer {
  state: TrainerState;
  onState: (s: TrainerState) => void = () => {};
  private stopped = false;
  private listener: ((s: PitchSample) => void) | null = null;
  private results: NoteResult[] = [];
  private cfg: ModeConfig;
  /** Until this AudioContext time the piano may still be audible through a speaker. */
  private pianoUntil = 0;

  constructor(
    private sound: Sound,
    private settings: Settings,
  ) {
    const m = MODES[settings.mode];
    this.cfg = { ...m };
    // Without headphones the mic hears the piano, so singing along is impossible.
    if (!settings.headphones && this.cfg.aid === 0) this.cfg.aid = 1;
    this.state = {
      phase: "prompt",
      message: "",
      chord: "",
      tones: [],
      order: [],
      step: 0,
      target: null,
      aid: this.cfg.aid,
      round: 0,
      passed: 0,
      attempted: 0,
      inTune: false,
    };
    sound.speech = settings.speech;
  }

  handleSample(s: PitchSample) {
    if (!this.settings.headphones && s.time < this.pianoUntil) return;
    this.listener?.(s);
  }

  stop() {
    this.stopped = true;
    this.listener = null;
    this.sound.stopAll();
    speechSynthesis?.cancel();
  }

  async run() {
    try {
      await this.loop();
    } catch (e) {
      if (!(e instanceof Stopped)) throw e;
    }
  }

  private async loop() {
    const { rounds } = this.settings;
    let successStreak = 0;
    let failStreak = 0;
    let silentStreak = 0;

    await this.say("はじめます");
    for (let round = 0; rounds === 0 || round < rounds; round++) {
      const chord = nextChord(this.cfg.progression, round);
      const tones = chordTones(chord, this.settings.home);
      const order = noteOrder(this.cfg.order);
      this.set({ round: round + 1, chord: chordName(chord), tones, order, step: 0, target: null });

      await this.promptChord(chord, tones, round === 0);

      let roundClean = true;
      for (let step = 0; step < order.length; step++) {
        const degree = order[step];
        const target = tones[degree];
        this.set({ step, target });

        // Each note gets one retry after hearing the comparison, so you can correct yourself.
        let r: NoteResult | null = null;
        for (let attempt = 0; attempt < 2; attempt++) {
          await this.promptNote(degree, step);
          r = await this.listen(degree, target);
          if (!r.voiced) break;
          this.results.push(r);
          this.set({ attempted: this.state.attempted + 1, passed: this.state.passed + (r.passed ? 1 : 0) });
          await this.feedback(r);
          if (r.passed) break;
          roundClean = false;
        }

        if (r && !r.voiced) {
          roundClean = false;
          silentStreak++;
          if (silentStreak >= 2) {
            await this.pause();
            silentStreak = 0;
          }
          step--; // Repeat the same note after silence or a pause.
          continue;
        }
        silentStreak = 0;
      }

      if (this.cfg.adaptive) {
        if (roundClean) {
          successStreak++;
          failStreak = 0;
        } else {
          failStreak++;
          successStreak = 0;
        }
        if (successStreak >= 2 && this.cfg.aid < this.maxAid()) {
          this.cfg.aid++;
          successStreak = 0;
          this.set({ aid: this.cfg.aid });
          await this.say(`補助輪をひとつ外します。${AID_LABELS[this.cfg.aid]}`);
        } else if (failStreak >= 2 && this.cfg.aid > this.minAid()) {
          this.cfg.aid--;
          failStreak = 0;
          this.set({ aid: this.cfg.aid });
          await this.say(`ひとつ戻します。${AID_LABELS[this.cfg.aid]}`);
        }
      }
    }
    await this.finish();
  }

  private minAid() {
    return this.settings.headphones ? 0 : 1;
  }

  private maxAid() {
    return MAX_AID;
  }

  private async promptChord(chord: Chord, tones: number[], first: boolean) {
    const aid = this.cfg.aid;
    this.set({ phase: "prompt", message: chordName(chord) });
    if (aid >= 3 || this.cfg.progression !== "fixed") await this.say(chordReading(chord));
    const now = this.sound.ctx.currentTime + 0.05;
    if (aid <= 2 || (aid === 4 && first)) {
      this.sound.playChord(tones, now, 1.6);
      this.pianoUntil = now + 2.0;
      await this.wait(1.8);
    } else if (aid === 3) {
      this.sound.playNote(tones[0], now, 1.2);
      this.pianoUntil = now + 1.6;
      await this.wait(1.4);
    }
  }

  private async promptNote(degree: number, step: number) {
    const aid = this.cfg.aid;
    const target = this.state.tones[degree];
    this.set({ phase: "prompt", message: DEGREE_LABELS[degree] });
    const now = this.sound.ctx.currentTime + 0.05;
    if (aid === 1) {
      this.sound.playNote(target, now, 1.0);
      this.pianoUntil = now + 1.4;
      await this.wait(1.4);
    } else if (aid >= 2 && step === 0 && this.cfg.order === "random") {
      // In random order the first note isn't implied, so name it.
      await this.say(DEGREE_LABELS[degree]);
    }
    if (aid !== 0) this.sound.cue();
  }

  private listen(degree: number, target: number): Promise<NoteResult> {
    const { tolerance, octaveFree } = this.settings;
    const aid = this.cfg.aid;
    const ctx = this.sound.ctx;
    const start = ctx.currentTime;
    const maxSec = aid === 0 ? 6 : 5;
    const devs: number[] = [];
    const onsetDevs: number[] = [];
    const freqs: number[] = [];
    let voiceStart: number | null = null;
    let inSince: number | null = null;
    let lastStrike = -Infinity;

    this.set({ phase: "listen", message: `${DEGREE_LABELS[degree]}を歌って`, inTune: false });

    return new Promise((resolve, reject) => {
      const done = (passed: boolean) => {
        this.listener = null;
        clearInterval(guard);
        resolve({
          degree,
          target,
          passed,
          voiced: voiceStart !== null,
          deviation: devs.length ? median(devs.slice(-20)) : 0,
          onset: onsetDevs.length ? median(onsetDevs) : 0,
          sungFreq: freqs.length ? median(freqs.slice(-15)) : null,
        });
      };
      // The sample stream drives everything, but stop/timeout must work even if it goes quiet.
      const guard = setInterval(() => {
        if (this.stopped) {
          clearInterval(guard);
          this.listener = null;
          reject(new Stopped());
        } else if (ctx.currentTime - start > maxSec) done(false);
      }, 100);

      this.listener = (s) => {
        // Singing along: re-strike the decaying piano note so it stays audible.
        if (aid === 0 && s.time - lastStrike > 1.6) {
          this.sound.playNote(target, s.time, 1.6, 70);
          lastStrike = s.time;
        }
        if (s.freq === null) {
          inSince = null;
          if (this.state.inTune) this.set({ inTune: false });
          return;
        }
        const dev = centsOff(s.freq, target, octaveFree);
        if (voiceStart === null) voiceStart = s.time;
        if ((s.time - voiceStart) * 1000 <= ONSET_MS) onsetDevs.push(dev);
        devs.push(dev);
        freqs.push(s.freq);

        const ok = Math.abs(dev) <= tolerance;
        if (ok !== this.state.inTune) this.set({ inTune: ok });
        if (!ok) {
          inSince = null;
          return;
        }
        inSince ??= s.time;
        if ((s.time - inSince) * 1000 >= HOLD_MS) done(true);
      };
    });
  }

  private async feedback(r: NoteResult) {
    this.sound.stopAll();
    const label = DEGREE_LABELS[r.degree];
    const now = this.sound.ctx.currentTime + 0.05;
    if (r.passed) {
      this.set({ phase: "feedback", message: "OK!" });
      this.sound.pass(now);
      await this.wait(0.5);
      return;
    }
    const dir = r.deviation < 0 ? "低い" : "高い";
    const amount = Math.abs(r.deviation) > 150 ? "かなり" : Math.abs(r.deviation) > 60 ? "" : "少し";
    this.set({ phase: "feedback", message: `${label}が${amount}${dir} (${Math.round(r.deviation)}¢)` });
    if (this.settings.speech) {
      await this.say(`${amount}${dir}`);
    } else {
      this.sound.fail(now);
      await this.wait(0.4);
    }
    if (r.sungFreq !== null) {
      const at = this.sound.ctx.currentTime + 0.05;
      const end = this.sound.compare(r.sungFreq, r.target, at);
      this.pianoUntil = end + 0.2;
      await this.wait(end - at + 0.3);
    }
  }

  private async pause() {
    this.set({ phase: "paused", message: "一時停止中。声を出すと再開します" });
    await this.say("一時停止します。声を出すと再開します");
    await new Promise<void>((resolve, reject) => {
      let since: number | null = null;
      const guard = setInterval(() => {
        if (this.stopped) {
          clearInterval(guard);
          reject(new Stopped());
        }
      }, 100);
      this.listener = (s) => {
        if (s.freq === null) {
          since = null;
          return;
        }
        since ??= s.time;
        if (s.time - since > 0.3) {
          this.listener = null;
          clearInterval(guard);
          resolve();
        }
      };
    });
    await this.say("再開します");
  }

  private async finish() {
    const { passed, attempted } = this.state;
    const rate = attempted ? Math.round((passed / attempted) * 100) : 0;
    const summary = [`おわり。正解率${rate}パーセント`];
    const bias = this.biasComment();
    if (bias) summary.push(bias);
    this.set({ phase: "done", message: summary.join("。"), target: null });
    await this.say(summary.join("。"));
  }

  /** Points out a consistent tendency, e.g. "ミが低めになりがち". */
  biasComment(): string | null {
    let worst: { label: string; bias: number } | null = null;
    for (let d = 0; d < 3; d++) {
      const devs = this.results.filter((r) => r.degree === d).map((r) => r.onset);
      if (devs.length < 2) continue;
      const bias = devs.reduce((a, b) => a + b, 0) / devs.length;
      if (Math.abs(bias) >= 15 && (!worst || Math.abs(bias) > Math.abs(worst.bias))) {
        worst = { label: DEGREE_LABELS[d], bias };
      }
    }
    if (!worst) return null;
    return `${worst.label}が${worst.bias < 0 ? "低め" : "高め"}になりがちです`;
  }

  private set(patch: Partial<TrainerState>) {
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
    await new Promise((r) => setTimeout(r, sec * 1000));
    this.check();
  }

  private check() {
    if (this.stopped) throw new Stopped();
  }
}
