import { describe, expect, it } from "vitest";
import { soundRange } from "../src/karaoke/trim";

const SR = 8000;

/** `lead` s of near-silence (faint noise), `body` s of tone, `tail` s of silence. */
function padded(lead: number, body: number, tail: number) {
  const x = new Float32Array(Math.round((lead + body + tail) * SR));
  for (let i = 0; i < x.length; i++) {
    const t = i / SR;
    x[i] = t >= lead && t < lead + body ? 0.5 * Math.sin(2 * Math.PI * 220 * t) : 1e-5 * Math.sin(i);
  }
  return x;
}

describe("soundRange", () => {
  it("drops silence at both ends, keeping a little margin", () => {
    const r = soundRange(padded(2, 3, 4), SR);
    expect(r.start).toBeCloseTo(1.8, 1);
    expect(r.end).toBeCloseTo(5.5, 1);
  });

  it("leaves audio without silence untouched", () => {
    const r = soundRange(padded(0, 3, 0), SR);
    expect(r.start).toBe(0);
    expect(r.end).toBeCloseTo(3, 2);
  });

  it("keeps a quiet intro that is still sound", () => {
    const x = padded(1, 3, 0);
    for (let i = 0; i < SR; i++) x[i] = 0.005 * Math.sin((2 * Math.PI * 220 * i) / SR); // about -49 dB below
    expect(soundRange(x, SR).start).toBe(0);
  });

  it("leaves an all-silent file alone", () => {
    expect(soundRange(new Float32Array(SR), SR)).toEqual({ start: 0, end: 1 });
  });
});
