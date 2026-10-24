import { describe, expect, it } from "vitest";
import { DEFAULT_STAGES, type Plan } from "../src/karaoke/plan";
import { nextItem } from "../src/karaoke/practice";

/** A plan with phrases p1..p5: p1-p3 in block 0, p4-p5 in block 1; focus on p1, p2 and p4. */
function plan(): Plan {
  const ph = (i: number, block: number) => ({
    id: `p${i}`, start: i * 5, end: i * 5 + 3, first: i, last: i, block, score: 40, issues: [], worst: i,
  });
  return {
    format: "domiso-plan", version: 1, id: "x", created: "", octave: 0, tolerance: 30,
    song: { format: "domiso-karaoke", version: 1, title: "t", audioName: "a", duration: 40, hop: 0.01, offsetCents: 0, notes: [], contour: [] },
    phrases: [ph(1, 0), ph(2, 0), ph(3, 0), ph(4, 1), ph(5, 1)],
    blocks: [
      { name: "A", start: 5, end: 18, phraseIds: ["p1", "p2", "p3"] },
      { name: "B", start: 20, end: 28, phraseIds: ["p4", "p5"] },
    ],
    focus: ["p1", "p2", "p4"],
    stages: DEFAULT_STAGES,
    progress: {},
    joined: [],
    finished: false,
  };
}

const clear = (p: Plan, id: string) => (p.progress[id] = { stage: 6, cleared: true, best: 80, history: [] });

describe("nextItem", () => {
  it("walks phrases, joins, blocks and the whole song in a teacher's order", () => {
    const p = plan();
    const none = new Set<string>();
    expect(nextItem(p, none, none)).toEqual({ kind: "phrase", id: "p1" });
    clear(p, "p1");
    expect(nextItem(p, none, none)).toEqual({ kind: "phrase", id: "p2" });
    clear(p, "p2");
    expect(nextItem(p, none, none)).toEqual({ kind: "join", ids: ["p1", "p2"] });
    p.joined.push("p1+p2");
    expect(nextItem(p, none, none)).toEqual({ kind: "block", block: 0 });
    p.joined.push("b0");
    expect(nextItem(p, none, none)).toEqual({ kind: "phrase", id: "p4" });
    clear(p, "p4");
    // p2 and p4 are in different blocks: no join, straight to block B.
    expect(nextItem(p, none, none)).toEqual({ kind: "block", block: 1 });
    p.joined.push("b1");
    expect(nextItem(p, none, none)).toEqual({ kind: "song" });
    p.finished = true;
    expect(nextItem(p, none, none)).toBeNull();
  });

  it("puts phrases skipped this session after the others", () => {
    const p = plan();
    const none = new Set<string>();
    expect(nextItem(p, none, none, new Set(["p1"]))).toEqual({ kind: "phrase", id: "p2" });
    clear(p, "p2");
    clear(p, "p4");
    p.joined.push("b1");
    expect(nextItem(p, none, none, new Set(["p1"]))).toEqual({ kind: "phrase", id: "p1" });
  });

  it("reviews phrases cleared in an earlier session first, once each", () => {
    const p = plan();
    clear(p, "p2");
    const due = new Set(["p2"]);
    expect(nextItem(p, new Set(), due)).toEqual({ kind: "review", id: "p2" });
    expect(nextItem(p, new Set(["p2"]), due)).toEqual({ kind: "phrase", id: "p1" });
  });
});
