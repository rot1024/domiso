import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Sound } from "../src/sound";
import { midiToFreq } from "../src/theory";
import { Trainer, type Settings, type TrainerState } from "../src/trainer";

// Fake timers also drive Date.now(), which stands in for AudioContext time.
const now = () => Date.now() / 1000;

function fakeSound(): Sound {
  const noop = () => {};
  return {
    ctx: { get currentTime() { return now(); } },
    speech: false,
    playNote: noop,
    playChord: noop,
    stopAll: noop,
    cue: noop,
    pass: noop,
    fail: noop,
    ping: noop,
    compare: (_f: number, _m: number, at: number) => at + 1.4,
    say: () => Promise.resolve(),
  } as unknown as Sound;
}

const base: Settings = {
  home: 60,
  mode: "unison",
  headphones: true,
  tolerance: 30,
  holdMs: 1000,
  rounds: 1,
  speech: false,
  octaveFree: false,
  slide: false,
};

/**
 * Simulated singer: while the trainer listens it glides toward `goal(state)` and keeps singing;
 * otherwise it is silent.
 */
function sing(trainer: Trainer, goal: (s: TrainerState, t: number) => number | null) {
  let pitch: number | null = null;
  return setInterval(() => {
    const s = trainer.state;
    const g = s.phase === "listen" ? goal(s, now()) : null;
    if (g === null) pitch = null;
    else if (pitch === null) pitch = g;
    else pitch += Math.sign(g - pitch) * Math.min(Math.abs(g - pitch), 0.5); // ~80ms per 4 semitones
    trainer.handleSample({ time: now(), freq: pitch === null ? null : midiToFreq(pitch), clarity: 1, rms: 1 });
  }, 25);
}

async function runToEnd(trainer: Trainer) {
  const messages: string[] = [];
  trainer.onState = (s) => {
    if (messages[messages.length - 1] !== s.message) messages.push(s.message);
  };
  let finished = false;
  void trainer.run().then(() => (finished = true));
  for (let i = 0; i < 240 && !finished; i++) await vi.advanceTimersByTimeAsync(500);
  expect(finished).toBe(true);
  return messages;
}

beforeEach(() => vi.useFakeTimers({ now: 0 }));
afterEach(() => vi.useRealTimers());

describe("Trainer", () => {
  it("passes notes held for the hold time", async () => {
    const trainer = new Trainer(fakeSound(), base);
    sing(trainer, (s) => s.target);
    await runToEnd(trainer);
    expect(trainer.state).toMatchObject({ phase: "done", passed: 5, attempted: 5 });
  });

  it("does not pass notes held shorter than the hold time", async () => {
    const trainer = new Trainer(fakeSound(), { ...base, holdMs: 1000 });
    // In tune for 0.6s, then 50 cents sharp for 0.2s, repeating.
    sing(trainer, (s, t) => (t % 0.8 < 0.6 ? s.target : s.target! + 0.5));
    await runToEnd(trainer);
    expect(trainer.state.passed).toBe(0);

    const lenient = new Trainer(fakeSound(), { ...base, holdMs: 500 });
    sing(lenient, (s, t) => (t % 0.8 < 0.6 ? s.target : s.target! + 0.5));
    await runToEnd(lenient);
    expect(lenient.state.passed).toBe(5);
  });

  it("scores slides by where the voice first lands and retries the phrase", async () => {
    const trainer = new Trainer(fakeSound(), { ...base, slide: true, rounds: 2 });
    let missedOnce = false;
    let missUntil = 0;
    sing(trainer, (s, t) => {
      // On the very first move to ミ, land 60 cents flat and correct after 0.4s.
      if (s.step === 1 && !missedOnce) {
        missedOnce = true;
        missUntil = t + 0.5;
      }
      return t < missUntil ? s.target! - 0.6 : s.target;
    });
    const messages = await runToEnd(trainer);

    expect(messages).toContainEqual(expect.stringMatching(/^一発 3\/4・ミが(少し)?低く着地 \(-6\d¢\)$/));
    expect(messages.filter((m) => m.startsWith("全部一発")).length).toBe(2);
    // Round 1: 3/4 then 4/4 on retry; round 2: 4/4.
    expect(trainer.state).toMatchObject({ phase: "done", passed: 11, attempted: 12 });
  });

  it("flags a slide where the voice was cut", async () => {
    const trainer = new Trainer(fakeSound(), { ...base, slide: true });
    let gapUntil: number | null = null;
    sing(trainer, (s, t) => {
      if (s.step === 2 && gapUntil === null) gapUntil = t + 0.5;
      return gapUntil !== null && t < gapUntil ? null : s.target;
    });
    const messages = await runToEnd(trainer);
    expect(messages).toContain("一発 3/4・ソで声が途切れた");
  });
});
