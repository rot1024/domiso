import { describe, expect, it } from "vitest";
import { analyze } from "../src/karaoke/analyze";
import type { Syllable } from "../src/karaoke/key";
import { renderSolfa, renderSyllable, syllableLead } from "../src/karaoke/voice";

const SR = 22050;
const ALL: Syllable[] = ["do", "re", "mi", "fa", "so", "la", "si"];

describe("solfège voice", () => {
  it("sings every syllable without clipping, and the lead comes before the vowel", () => {
    for (const s of ALL) {
      for (const midi of [50, 62, 76]) {
        const v = renderSyllable(s, midi, 0.5, SR);
        expect(v.length).toBe(Math.ceil((0.5 + syllableLead(s)) * SR));
        let peak = 0;
        for (const x of v) {
          expect(Number.isFinite(x)).toBe(true);
          peak = Math.max(peak, Math.abs(x));
        }
        expect(peak).toBeGreaterThan(0.1);
        expect(peak).toBeLessThan(1);
      }
    }
  });

  it("is heard on the right pitch, on time", () => {
    // ドレミファソラシド in C, then back down a few notes.
    const midis = [60, 62, 64, 65, 67, 69, 71, 72, 67, 64, 60];
    const notes = midis.map((midi, i) => ({ start: 0.3 + i * 0.5, end: 0.3 + i * 0.5 + 0.45, midi }));
    const syl: Syllable[] = ["do", "re", "mi", "fa", "so", "la", "si", "do", "so", "mi", "do"];
    const out = renderSolfa(notes, syl, SR, 6.3);
    const a = analyze(out, SR);
    expect(Math.abs(a.offsetCents)).toBeLessThanOrEqual(10);
    expect(a.notes.map((n) => n.midi)).toEqual(midis);
    a.notes.forEach((n, i) => expect(Math.abs(n.start - notes[i].start)).toBeLessThan(0.08));
  });
});
