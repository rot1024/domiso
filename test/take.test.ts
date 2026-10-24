import { describe, expect, it } from "vitest";
import { recordingLag, timelineRuns, type TakePoint } from "../src/karaoke/take";

/** Points every 25 ms of recording time, with song time from `songAt(r)` (null = not playing). */
function points(dur: number, songAt: (r: number) => number | null): TakePoint[] {
  const out: TakePoint[] = [];
  for (let r = 0; r < dur; r += 0.025) {
    const t = songAt(r);
    if (t !== null) out.push({ t, m: 60, r });
  }
  return out;
}

describe("timelineRuns", () => {
  it("maps a straight run with a constant offset", () => {
    const { runs } = timelineRuns(points(10, (r) => r + 3.2));
    expect(runs).toHaveLength(1);
    expect(runs[0].offset).toBeCloseTo(3.2, 3);
    expect(runs[0].r1 - runs[0].r0).toBeGreaterThan(9.9);
  });

  it("splits at a seek back and drops parts played at another speed", () => {
    // 0-4 s straight from song 0; seek back to song 1 at r=4; from r=8 played at 0.75x.
    const { speed, runs } = timelineRuns(points(10, (r) => (r < 4 ? r : r < 8 ? 1 + (r - 4) : 5 + (r - 8) * 0.75)));
    expect(speed).toBe(1);
    expect(runs.map((x) => Math.round(x.offset * 10) / 10)).toEqual([0, -3]);
  });

  it("lays a take sung at 0.75x on its own timeline", () => {
    // Song time = 2 + 0.75 r; on the take timeline u = t / 0.75 = r + 2.667.
    const { speed, runs } = timelineRuns(points(10, (r) => 2 + 0.75 * r));
    expect(speed).toBe(0.75);
    expect(runs).toHaveLength(1);
    expect(runs[0].offset).toBeCloseTo(2.667, 2);
  });

  it("splits around a pause", () => {
    const { runs } = timelineRuns(points(10, (r) => (r < 3 ? r : r < 5 ? null : r - 2)));
    expect(runs.map((x) => Math.round(x.offset * 10) / 10)).toEqual([0, -2]);
  });
});

describe("recordingLag", () => {
  it("finds how late the voice sits in the recording", () => {
    const rate = 8000;
    const samples = new Float32Array(20 * rate);
    // Voice in bursts: on 1 s, off 0.5 s; in the recording it starts 0.23 s later than the points say.
    const points: { t: number; m: number | null; r: number }[] = [];
    for (let r = 0; r < 19; r += 0.025) {
      const on = r % 1.5 < 1 && r > 1;
      points.push({ t: r, m: on ? 60 : null, r });
    }
    for (let i = 0; i < samples.length; i++) {
      const r = i / rate - 0.23;
      if (r > 1 && r % 1.5 < 1) samples[i] = 0.3 * Math.sin((2 * Math.PI * 262 * i) / rate);
    }
    expect(recordingLag(samples, rate, points)).toBeCloseTo(0.23, 1);
  });
});
