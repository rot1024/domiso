import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PitchSample, PitchTracker } from "../src/pitch";
import type { Sound } from "../src/sound";
import { midiToFreq } from "../src/theory";
import type { Plan, Stage } from "../src/karaoke/plan";
import type { KaraokePlayer } from "../src/karaoke/player";
import { PracticeSession } from "../src/karaoke/practice";

// Fake timers also drive Date.now(), which stands in for AudioContext time.
const now = () => Date.now() / 1000;

const sing = (name: string, score: number, times: number, play = { voice: false, inst: true, melody: false }): Stage => ({
  name, kind: "sing", speed: 1, play, pass: { score, times },
});

/** Phrases p1 (notes 0-1) and p2 (notes 2-3) in one block. */
function makePlan(stages: Stage[], focus = ["p1"]): Plan {
  const notes = [
    { start: 1, end: 1.5, midi: 60 }, { start: 1.5, end: 2, midi: 64 },
    { start: 4, end: 4.5, midi: 67 }, { start: 4.5, end: 5, midi: 65 },
  ];
  return {
    format: "domiso-plan", version: 1, id: "x", created: "", octave: 0, tolerance: 30,
    song: { format: "domiso-karaoke", version: 1, title: "t", audioName: "a", duration: 6, hop: 0.01, offsetCents: 0, notes, contour: [] },
    phrases: [
      { id: "p1", start: 1, end: 2, first: 0, last: 1, block: 0, score: 40, issues: [], worst: 1 },
      { id: "p2", start: 4, end: 5, first: 2, last: 3, block: 0, score: 40, issues: [], worst: 3 },
    ],
    blocks: [{ name: "A", start: 1, end: 5, phraseIds: ["p1", "p2"] }],
    focus, stages, progress: {}, joined: [], finished: false,
  };
}

/**
 * Stand-ins: the player "plays" a range instantly and reports the next scripted score for the attempt;
 * the piano sets what the fake singer sings back in the note drill.
 */
function rig(plan: Plan, scores: number[]) {
  const tracker = {
    onSample: (_: PitchSample) => {},
    start: () => {},
    stop: () => {},
  };
  let singing: number | null = null;
  setInterval(() => tracker.onSample({ time: now(), freq: singing === null ? null : midiToFreq(singing), clarity: 1, rms: 1 }), 25);
  const drilled: number[] = [];
  const sound = {
    ctx: { get currentTime() { return now(); } },
    speech: false,
    playNote: (midi: number) => {
      drilled.push(midi);
      singing = midi;
    },
    pass: () => {},
    fail: () => {},
    compare: (_f: number, _m: number, at: number) => at + 1.4,
    stopAll: () => {},
    say: () => Promise.resolve(),
  } as unknown as Sound;
  const attempts: { from: number; to: number; speed: number; score: number }[] = [];
  let fresh = false;
  const player = {
    notes: plan.song.notes,
    duration: plan.song.duration,
    speed: 1,
    trace: [],
    setMix: () => {},
    stop: () => {},
    handleSample: () => {},
    playRange(from: number, to: number, done: () => void) {
      setTimeout(() => {
        fresh = true;
        done();
      }, 50);
      attempts.push({ from, to, speed: this.speed, score: scores[0] ?? 100 });
    },
    rangeScore(from: number, to: number) {
      // The score for the attempt just played, once; other lookups (weakest phrase in a join) get 50.
      if (fresh) {
        fresh = false;
        return scores.shift() ?? 100;
      }
      return from === 1 && to === 2 ? 30 : 60;
    },
    worstNote: () => ({ index: 1, ratio: 0.2, bias: -40 }),
  } as unknown as KaraokePlayer;
  const session = new PracticeSession(plan, player, sound, tracker as unknown as PitchTracker);
  const stages: string[] = [];
  session.onState = (s) => {
    const label = `${s.label}|${s.stage}`;
    if (s.stage && stages.at(-1) !== label) stages.push(label);
  };
  return { session, attempts, stages, drilled };
}

async function runAll(session: PracticeSession) {
  let finished = false;
  void session.run().then(() => (finished = true));
  for (let i = 0; i < 2000 && !finished; i++) await vi.advanceTimersByTimeAsync(100);
  expect(finished).toBe(true);
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("PracticeSession", () => {
  it("clears stages on passes, steps back after two failures, then joins the block and the song", async () => {
    const plan = makePlan([sing("一緒に", 70, 2, { voice: true, inst: true, melody: true }), sing("伴奏だけ", 70, 2)]);
    // Stage 1: pass, pass. Stage 2: fail, fail (back to 1). Stage 1: pass, pass. Stage 2: pass, pass.
    // Then the block (pass) and the whole song.
    const { session, stages } = rig(plan, [80, 80, 50, 40, 85, 85, 90, 90, 75, 88]);
    await runAll(session);
    expect(plan.progress.p1.cleared).toBe(true);
    expect(plan.progress.p1.history.map((h) => h.score)).toEqual([80, 80, 50, 40, 85, 85, 90, 90]);
    expect(stages.filter((s) => s.startsWith("p1")).map((s) => s.split("|")[1])).toEqual([
      "一緒に", "伴奏だけ", "一緒に", "伴奏だけ",
    ]);
    expect(plan.joined).toEqual(["b0"]);
    expect(plan.finished).toBe(true);
  });

  it("drills the worst notes on the piano when the easiest stage keeps failing", async () => {
    const plan = makePlan([sing("一緒に", 70, 1, { voice: true, inst: true, melody: true })]);
    const { session, drilled } = rig(plan, [30, 30, 90, 80, 80]);
    await runAll(session);
    // Worst note is index 1 (ミ): the drill covers notes 0-1 (ド, ミ), each played once and sung back.
    expect(drilled).toContain(64);
    expect(drilled).toContain(60);
    expect(plan.progress.p1.cleared).toBe(true);
  });

  it("sends the weakest phrase back to practice when a join keeps falling apart", async () => {
    const plan = makePlan([sing("一緒に", 70, 1, { voice: true, inst: true, melody: true }), sing("伴奏だけ", 70, 1)], ["p1", "p2"]);
    // p1: 2 passes; p2: 2 passes; join p1+p2 fails 3 times -> p1 (weakest) back to 伴奏だけ; p1 passes;
    // join passes; block passes; song.
    const { session, stages } = rig(plan, [90, 90, 90, 90, 40, 40, 40, 90, 85, 80, 80]);
    await runAll(session);
    const order = stages.map((s) => s.split("|")[1]);
    expect(order.filter((s) => s === "つなげて").length).toBeGreaterThanOrEqual(1);
    expect(plan.progress.p1.history.map((h) => h.score)).toEqual([90, 90, 90]);
    expect(plan.joined).toEqual(["p1+p2", "b0"]);
    expect(plan.finished).toBe(true);
  });
});
