import { describe, expect, it } from "vitest";
import { analyze } from "../src/karaoke/analyze";
import { noteAt, parseSong, serializeSong, type Song } from "../src/karaoke/song";

const SR = 22050;

/**
 * Synthesizes a voice-like signal from a pitch contour: segments of [midi | null, seconds],
 * where a [from, to] pair glides between pitches. Optional vibrato and global detune in cents.
 */
function synth(segments: [number | [number, number] | null, number][], { vibrato = 0, detune = 0 } = {}) {
  const total = segments.reduce((a, [, d]) => a + d, 0);
  const out = new Float32Array(Math.ceil(total * SR));
  let phase = 0;
  let i = 0;
  for (const [p, dur] of segments) {
    const n = Math.round(dur * SR);
    for (let k = 0; k < n; k++, i++) {
      if (p === null) continue;
      const m = Array.isArray(p) ? p[0] + ((p[1] - p[0]) * k) / n : p;
      const vib = (vibrato / 100) * Math.sin((2 * Math.PI * 5.5 * i) / SR);
      const f = 440 * 2 ** ((m + vib + detune / 100 - 69) / 12);
      phase += (2 * Math.PI * f) / SR;
      let v = 0;
      for (let h = 1; h <= 5; h++) v += Math.sin(h * phase) / h;
      out[i] = v * 0.2;
    }
  }
  return out;
}

describe("analyze", () => {
  it("finds notes through glides, vibrato, breaths and overall detune", () => {
    const audio = synth(
      [
        [null, 0.3],
        [[58.5, 60], 0.08], // scoop into the first note
        [60, 0.5],
        [[60, 64], 0.1],
        [64, 0.6],
        [null, 0.3],
        [67, 0.6],
        [[67, 65], 0.08],
        [65, 0.4],
        [null, 0.2],
      ],
      { vibrato: 35, detune: 15 },
    );
    const r = analyze(audio, SR);
    expect(r.offsetCents).toBeGreaterThan(5);
    expect(r.offsetCents).toBeLessThan(25);
    expect(r.notes.map((n) => n.midi)).toEqual([60, 64, 67, 65]);
    expect(r.notes[0].start).toBeCloseTo(0.3, 1);
    expect(r.notes[2].start).toBeCloseTo(1.88, 1);
    expect(r.contour.length).toBeGreaterThan(250);
  });

  it("finds nothing in silence", () => {
    const r = analyze(new Float32Array(SR), SR);
    expect(r.notes).toEqual([]);
  });
});

describe("song data", () => {
  const song: Song = {
    format: "domiso-karaoke",
    version: 1,
    title: "t",
    audioName: "a.m4a",
    duration: 2,
    hop: 0.01,
    offsetCents: 3,
    notes: [
      { start: 0.1, end: 0.5, midi: 60 },
      { start: 0.6, end: 1.0, midi: 64 },
    ],
    contour: [null, 60.01, 64],
  };

  it("round-trips through the file format", () => {
    expect(parseSong(serializeSong(song))).toEqual(song);
  });

  it("rejects other JSON", () => {
    expect(() => parseSong('{"a":1}')).toThrow();
  });

  it("looks up the note at a time", () => {
    expect(noteAt(song.notes, 0.3)).toBe(0);
    expect(noteAt(song.notes, 0.55)).toBe(-1);
    expect(noteAt(song.notes, 0.6)).toBe(1);
    expect(noteAt(song.notes, 2)).toBe(-1);
  });
});
