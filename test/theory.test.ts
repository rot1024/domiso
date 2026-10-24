import { describe, expect, it } from "vitest";
import { centsOff, chordName, chordTones, midiToFreq, noteOrder, VOICE_PRESETS } from "../src/theory";

describe("centsOff", () => {
  it("measures deviation from the target", () => {
    expect(centsOff(440, 69)).toBeCloseTo(0);
    expect(centsOff(midiToFreq(69.3), 69)).toBeCloseTo(30);
  });

  it("folds octaves when octave-free", () => {
    expect(centsOff(880, 69)).toBeCloseTo(1200);
    expect(centsOff(880, 69, true)).toBeCloseTo(0);
    expect(centsOff(midiToFreq(56.8), 69, true)).toBeCloseTo(-20);
  });
});

describe("chordTones", () => {
  it("keeps every chord near the preset's home note", () => {
    for (const { home } of VOICE_PRESETS) {
      for (let root = 0; root < 12; root++) {
        const [r, , f] = chordTones({ root, quality: "maj" }, home);
        expect(r).toBeGreaterThanOrEqual(home - 6);
        expect(f).toBeLessThanOrEqual(home + 12);
      }
    }
  });

  it("builds minor and diminished triads", () => {
    expect(chordTones({ root: 9, quality: "min" }, 60)).toEqual([57, 60, 64]);
    expect(chordTones({ root: 11, quality: "dim" }, 60)).toEqual([59, 62, 65]);
    expect(chordName({ root: 9, quality: "min" })).toBe("Am");
  });
});

describe("noteOrder", () => {
  it("random order is a permutation of the triad", () => {
    for (let i = 0; i < 20; i++) expect([...noteOrder("random")].sort()).toEqual([0, 1, 2]);
  });
});
