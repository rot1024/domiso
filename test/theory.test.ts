import { describe, expect, it } from "vitest";
import { centsOff, chordName, chordTones, midiToFreq, noteOrder, patternLabels, patternTones, VOICE_PRESETS } from "../src/theory";

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

describe("ドレミファソ", () => {
  it("goes up five steps and back down", () => {
    expect(noteOrder("updown", 5)).toEqual([0, 1, 2, 3, 4, 3, 2, 1, 0]);
    expect([...noteOrder("random", 5)].sort()).toEqual([0, 1, 2, 3, 4]);
  });

  it("uses the major, minor and diminished five-note shapes from the chord's root", () => {
    expect(patternTones({ root: 0, quality: "maj" }, 60, "five")).toEqual([60, 62, 64, 65, 67]);
    expect(patternTones({ root: 9, quality: "min" }, 60, "five")).toEqual([57, 59, 60, 62, 64]);
    expect(patternTones({ root: 11, quality: "dim" }, 60, "five")).toEqual([59, 61, 62, 64, 65]);
    expect(patternTones({ root: 0, quality: "maj" }, 60, "triad")).toEqual([60, 64, 67]);
    expect(patternLabels("five")).toEqual(["ド", "レ", "ミ", "ファ", "ソ"]);
  });
});
