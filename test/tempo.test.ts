import { describe, expect, it } from "vitest";
import { detectBeats } from "../src/karaoke/tempo";

const SR = 22050;

/** A drum-like pattern: a click on every beat (louder on 1 and 3), plus off-beat hi-hats. */
function drums(bpm: number, seconds: number, start = 0.5, drift = 0) {
  const x = new Float32Array(Math.round(seconds * SR));
  let seed = 1;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  const beats: number[] = [];
  let t = start;
  let period = 60 / bpm;
  for (let i = 0; t < seconds - 0.2; i++) {
    beats.push(t);
    const hit = (at: number, amp: number, len: number) => {
      const a = Math.round(at * SR);
      for (let k = 0; k < len * SR && a + k < x.length; k++) x[a + k] += amp * noise() * Math.exp(-k / (0.01 * SR));
    };
    hit(t, i % 2 === 0 ? 0.8 : 0.5, 0.08);
    hit(t + period / 2, 0.2, 0.03);
    t += period;
    period *= 1 + drift;
  }
  return { x, beats };
}

describe("detectBeats", () => {
  for (const bpm of [80, 100, 128, 150]) {
    it(`finds ${bpm} BPM and its beats`, () => {
      const { x, beats } = drums(bpm, 20);
      const r = detectBeats(x, SR);
      expect(Math.abs(r.bpm - bpm) / bpm).toBeLessThan(0.02);
      // Most true beats have a detected beat within 30 ms.
      const near = beats.filter((b) => r.beats.some((d) => Math.abs(d - b) < 0.03)).length;
      expect(near / beats.length).toBeGreaterThan(0.9);
    });
  }

  it("follows a tempo that drifts slightly", () => {
    const { x, beats } = drums(120, 30, 0.5, 0.0015); // slows about 5% over the song
    const r = detectBeats(x, SR);
    const near = beats.filter((b) => r.beats.some((d) => Math.abs(d - b) < 0.03)).length;
    expect(near / beats.length).toBeGreaterThan(0.85);
  });
});
