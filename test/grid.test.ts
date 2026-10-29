import { describe, expect, it } from "vitest";
import { segment } from "../src/karaoke/analyze";
import { gridLines, snapToGrid } from "../src/karaoke/grid";

const HOP = 0.01;

/** A contour from (midi | null, seconds) segments, with optional vibrato in cents. */
function contour(segs: [number | null, number][], vibrato = 0): (number | null)[] {
  const out: (number | null)[] = [];
  for (const [m, sec] of segs) {
    for (let k = 0; k < Math.round(sec / HOP); k++) {
      out.push(m === null ? null : m + (vibrato / 100) * Math.sin(2 * Math.PI * 5.5 * out.length * HOP));
    }
  }
  return out;
}

describe("gridLines", () => {
  it("splits beats into equal parts and covers the song", () => {
    const lines = gridLines([1, 1.5, 2, 2.5], 2, 3.2);
    expect(lines.slice(0, 7)).toEqual([0, 0.25, 0.5, 0.75, 1, 1.25, 1.5]);
    expect(lines[lines.length - 1]).toBeGreaterThanOrEqual(3.2);
  });
});

describe("snapToGrid", () => {
  // 120 BPM in sixteenths: 0.125 s cells.
  const lines = gridLines([0, 0.5, 1, 1.5, 2, 2.5, 3], 4, 3);

  it("drops scoops, ornaments and vibrato shorter than a cell", () => {
    const c = contour(
      [
        [null, 0.5],
        [58.5, 0.06], // scoop into the note
        [60, 0.44],
        [62, 0.05], // a quick ornament
        [60, 0.45],
        [64, 1.0], // long note with vibrato
      ],
      40,
    );
    const notes = snapToGrid(segment(c, 0, HOP), lines);
    expect(notes.map((n) => n.midi)).toEqual([60, 64]);
    expect(notes[0].start).toBeCloseTo(0.5);
    expect(notes[1].start).toBeCloseTo(1.5);
  });

  it("keeps a repeated pitch as separate notes when it is sung again", () => {
    const c = contour([
      [62, 0.47],
      [null, 0.04], // consonant gap at the next beat
      [62, 0.46],
      [null, 0.04],
      [62, 0.5],
    ]);
    const notes = snapToGrid(segment(c, 0, HOP), lines);
    expect(notes.map((n) => n.midi)).toEqual([62, 62, 62]);
    expect(notes.map((n) => n.start)).toEqual([0, 0.5, 1]);
  });

  it("does not flicker between semitones when the pitch sits between them", () => {
    const c = contour([[60.45, 1.5]], 30);
    expect(snapToGrid(segment(c, 0, HOP), lines)).toHaveLength(1);
  });

  it("applies the recording's tuning offset", () => {
    const c = contour([[60.3, 0.5]]);
    expect(snapToGrid(segment(c, 0.3, HOP), lines)[0].midi).toBe(60);
  });
});

describe("one-cell notes between notes", () => {
  const lines = gridLines([0, 0.5, 1, 1.5, 2, 2.5, 3], 4, 3);

  it("folds a passing note on a slide into the note it leads to", () => {
    // ラ (0.5 s) slides down through ソ# (one cell) into ミ.
    const raw = [
      { start: 0, end: 0.5, midi: 69 },
      { start: 0.5, end: 0.625, midi: 68 },
      { start: 0.625, end: 1.5, midi: 64 },
    ];
    expect(snapToGrid(raw, lines)).toEqual([
      { start: 0, end: 0.5, midi: 69 },
      { start: 0.5, end: 1.5, midi: 64 },
    ]);
  });

  it("folds a scoop up into the note and keeps short syllables that stand apart", () => {
    const raw = [
      { start: 0.5, end: 0.625, midi: 62 }, // scoop, tied into ミ
      { start: 0.625, end: 1.0, midi: 64 },
      { start: 1.5, end: 1.625, midi: 67 }, // a short note on its own
      { start: 2.0, end: 2.125, midi: 64 }, // repeated pitch, sung again
      { start: 2.125, end: 2.5, midi: 64 },
    ];
    const out = snapToGrid(raw, lines);
    expect(out.map((n) => [n.start, n.midi])).toEqual([[0.5, 64], [1.5, 67], [2.0, 64], [2.125, 64]]);
  });
});
