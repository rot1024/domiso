import { describe, expect, it } from "vitest";
import { SlideAnalyzer } from "../src/slide";
import { midiToFreq } from "../src/theory";

const DT = 0.025;

/** Runs a pitch contour (MIDI per sample, null for silence) through the analyzer. */
function run(contour: (number | null)[], prev = 60, target = 64) {
  const a = new SlideAnalyzer(prev, target, 30, false, 0);
  contour.forEach((m, i) => a.push(i * DT, m === null ? null : midiToFreq(m)));
  return a;
}

const hold = (m: number | null, sec: number) => Array<number | null>(Math.round(sec / DT)).fill(m);
const glide = (from: number, to: number, sec: number) => {
  const n = Math.round(sec / DT);
  return Array.from({ length: n }, (_, i) => from + ((to - from) * (i + 1)) / n);
};

describe("SlideAnalyzer", () => {
  it("counts a clean slide that lands on the target as one-shot", () => {
    const a = run([...hold(60, 0.3), ...glide(60, 64.1, 0.1), ...hold(64.1, 0.4)]);
    expect(a.landing).not.toBeNull();
    expect(a.landing!.cents).toBeCloseTo(10, 0);
    expect(a.oneShot).toBe(true);
  });

  it("reports where the voice first rests when it lands off and corrects", () => {
    const a = run([...hold(60, 0.3), ...glide(60, 63.4, 0.1), ...hold(63.4, 0.3), ...glide(63.4, 64, 0.1), ...hold(64, 0.4)]);
    expect(a.landing!.cents).toBeCloseTo(-60, 0);
    expect(a.oneShot).toBe(false);
  });

  it("flags a cut voice even if the next note is right", () => {
    const a = run([...hold(60, 0.3), ...hold(null, 0.5), ...hold(64, 0.4)]);
    expect(a.broke).toBe(true);
    expect(a.oneShot).toBe(false);
  });

  it("does not land while still holding the previous note", () => {
    const a = run(hold(60, 1));
    expect(a.leftAt).toBeNull();
    expect(a.landing).toBeNull();
  });
});
