import { describe, expect, it } from "vitest";
import { analyze } from "../src/karaoke/analyze";
import { splitAtOnsets, syllableOnsets } from "../src/karaoke/syllables";
import { midiToFreq } from "../src/theory";

const SR = 22050;

/**
 * One pitch held for `seconds`, as a voice: harmonics shaped by a vowel-ish spectrum. `breaks` are times
 * where a consonant cuts in (70 ms of quiet noise); `vibrato` is in cents.
 */
function sung(midi: number, seconds: number, breaks: number[] = [], vibrato = 0) {
  const x = new Float32Array(Math.round((seconds + 0.6) * SR));
  let phase = 0;
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff) * 2 - 1;
  for (let i = 0; i < x.length; i++) {
    const t = i / SR - 0.3;
    if (t < 0 || t > seconds) continue;
    const f = midiToFreq(midi + (vibrato / 100) * Math.sin(2 * Math.PI * 5.5 * t));
    phase += (2 * Math.PI * f) / SR;
    let v = 0;
    for (let h = 1; h <= 8; h++) v += Math.sin(h * phase) / h;
    const inBreak = breaks.some((b) => t >= b && t < b + 0.07);
    x[i] = inBreak ? 0.02 * noise() : 0.25 * v;
  }
  return x;
}

describe("syllable onsets", () => {
  it("splits a repeated pitch where a consonant cuts in", () => {
    const x = sung(64, 2.4, [0.8, 1.6]);
    const r = analyze(x, SR);
    expect(r.notes.map((n) => n.midi)).toEqual([64, 64, 64]);
    // The new syllable starts where its consonant does.
    expect(r.notes[1].start).toBeCloseTo(0.3 + 0.8, 1);
  });

  it("keeps a long note with vibrato whole", () => {
    const x = sung(64, 2.4, [], 40);
    expect(syllableOnsets(x, SR).filter((t) => t > 0.5 && t < 2.5)).toEqual([]);
    expect(analyze(x, SR).notes).toHaveLength(1);
  });

  it("splitAtOnsets leaves pieces no shorter than the minimum", () => {
    const notes = [{ start: 0, end: 1, midi: 60 }];
    expect(splitAtOnsets(notes, [0.05, 0.5, 0.97])).toEqual([
      { start: 0, end: 0.5, midi: 60 },
      { start: 0.5, end: 1, midi: 60 },
    ]);
  });
});
