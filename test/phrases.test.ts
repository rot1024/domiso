import { describe, expect, it } from "vitest";
import { assess, pickWeak, segment } from "../src/karaoke/phrases";
import type { SongNote } from "../src/karaoke/song";

/** Notes from [midi, start, length] triples. */
const mk = (xs: [number, number, number][]): SongNote[] => xs.map(([midi, start, len]) => ({ midi, start, end: start + len }));

/** Pitch points every 25 ms: what was sung at song time t (null = silence). */
function sing(from: number, to: number, at: (t: number) => number | null) {
  const out: { t: number; m: number | null }[] = [];
  for (let t = from; t < to; t += 0.025) out.push({ t, m: at(t) });
  return out;
}

describe("segment", () => {
  it("splits phrases at rests and blocks at long breaks", () => {
    const notes = mk([
      [60, 0, 0.5], [62, 0.5, 0.5], [64, 1.0, 0.8], // phrase 1
      [65, 2.2, 0.5], [67, 2.7, 1.0], // phrase 2 (rest 0.4)
      [60, 7.0, 0.6], [64, 7.6, 0.6], // block 2 (break 3.3)
    ]);
    const { phrases, blocks } = segment(notes);
    expect(phrases.map((p) => [p.first, p.last, p.block])).toEqual([[0, 2, 0], [3, 4, 0], [5, 6, 1]]);
    expect(blocks.map((b) => b.phraseIds)).toEqual([["p1", "p2"], ["p3"]]);
  });

  it("splits a long phrase at its longest rest and merges tiny ones", () => {
    const notes = mk([
      [60, 0, 2], [62, 2.0, 2], [64, 4.25, 2], [65, 6.25, 2], [67, 8.25, 2], // 10 s, longest rest 0.25 at 4
      [69, 10.6, 0.3], // tiny phrase right after
    ]);
    const { phrases } = segment(notes);
    expect(phrases.map((p) => [p.first, p.last])).toEqual([[0, 1], [2, 5]]);
  });
});

describe("assess", () => {
  const notes = mk([[60, 0, 0.8], [67, 0.8, 0.8], [64, 1.6, 1.2]]);
  const { phrases } = segment(notes);

  it("gives a clean take a high score and no issues", () => {
    const pts = sing(0, 2.8, (t) => (t < 0.8 ? 60 : t < 1.6 ? 67 : 64));
    const [a] = assess(notes, phrases, pts, 30);
    expect(a.score).toBeGreaterThan(90);
    expect(a.issues).toEqual([]);
  });

  it("names a flat leap, scooped entries and a sagging long note", () => {
    const pts = sing(0, 2.8, (t) => {
      if (t < 0.12) return 59.2; // scoop into the first note
      if (t < 0.8) return 60;
      if (t < 1.6) return 66.3; // the leap up to ソ falls short
      return t < 2.2 ? 64 : 63.5; // 長い音 sags
    });
    const [a] = assess(notes, phrases, pts, 30);
    expect(a.issues.some((x) => x.startsWith("跳躍で外れる（ド→ソ）"))).toBe(true);
    expect(a.issues.some((x) => x.startsWith("入りをずり上げている"))).toBe(true);
    expect(a.issues.some((x) => x.startsWith("伸ばしで下がる（ミ）"))).toBe(true);
    expect(notes[a.worst].midi).toBe(67);
  });

  it("flags notes that were not sung", () => {
    const pts = sing(0, 2.8, (t) => (t < 0.8 ? 60 : t < 1.6 ? null : 64));
    const [a] = assess(notes, phrases, pts, 30);
    expect(a.issues[0]).toBe("声が出ていない音がある（ソ）");
  });
});

describe("pickWeak", () => {
  const a = (id: string, score: number) => ({ id, score, bias: null, issues: [], worst: 0 });
  it("takes the phrases under the threshold, weakest first", () => {
    expect(pickWeak([a("1", 90), a("2", 40), a("3", 65), a("4", 50), a("5", 30)]).map((x) => x.id)).toEqual(["5", "2", "4", "3"]);
  });
  it("still picks the weakest few when everything is fine", () => {
    expect(pickWeak([a("1", 95), a("2", 80), a("3", 85), a("4", 90)]).map((x) => x.id)).toEqual(["2", "3", "4"]);
  });
});

describe("makePlan", () => {
  it("embeds the song, finds phrases and round-trips through the file format", async () => {
    const { makePlan, parsePlan, serializePlan } = await import("../src/karaoke/plan");
    const notes = mk([[60, 0, 0.8], [67, 0.8, 0.8], [64, 1.6, 1.2], [62, 3.5, 1.0], [60, 4.5, 1.0]]);
    const song = {
      format: "domiso-karaoke" as const, version: 1 as const, title: "t", audioName: "a.wav",
      duration: 6, hop: 0.01, offsetCents: 0, notes, contour: [],
    };
    const pts = sing(0, 6, (t) => (t < 3 ? null : t < 4.5 ? 62 : 60)); // first phrase not sung at all
    const plan = makePlan(song, notes, pts, { octave: 0, tolerance: 30 });
    expect(plan.phrases.map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(plan.focus[0]).toBe("p1");
    expect(plan.phrases[0].score).toBe(0);
    // A take that only reached the first phrase judges nothing after it.
    const partial = makePlan(song, notes, sing(0, 3, (t) => (t < 0.8 ? 60 : t < 1.6 ? 67 : 64)), { octave: 0, tolerance: 30 });
    expect(partial.phrases[1].score).toBeNull();
    expect(partial.focus).toEqual(["p1"]);
    const back = parsePlan(serializePlan(plan))!;
    expect(back.song.notes).toEqual(notes);
    expect(back.stages.length).toBeGreaterThan(5);
    expect(parsePlan('{"format":"domiso-karaoke"}')).toBeNull();
  });
});
