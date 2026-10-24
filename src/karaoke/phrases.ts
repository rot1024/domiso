import { solfege } from "../graph";
import { median } from "../pitch";
import type { SongNote } from "./song";

/** A rest at least this long ends a phrase. */
const PHRASE_GAP = 0.3;
/** Phrases longer than this are split at their longest internal rest. */
const MAX_PHRASE = 8;
/** Phrases shorter than this are merged into a neighbour. */
const MIN_PHRASE = 1;
/** A break at least this long (an interlude) separates blocks such as verse and chorus. */
const BLOCK_GAP = 2;
/** Blocks are practice run-throughs; longer ones are split at their longest rests between phrases. */
const MAX_BLOCK_PHRASES = 10;
const SAMPLE_SEC = 0.025;

export interface Phrase {
  id: string;
  start: number;
  end: number;
  /** Indices into the song's notes: [first, last]. */
  first: number;
  last: number;
  block: number;
}

export interface Block {
  name: string;
  start: number;
  end: number;
  phraseIds: string[];
}

/** Splits the melody into phrases at rests, and the phrases into blocks at long breaks. */
export function segment(notes: SongNote[]): { phrases: Phrase[]; blocks: Block[] } {
  // Start a new group wherever the rest before a note is long enough.
  let groups: number[][] = [];
  notes.forEach((n, i) => {
    if (i === 0 || n.start - notes[i - 1].end >= PHRASE_GAP) groups.push([i]);
    else groups[groups.length - 1].push(i);
  });
  const span = (g: number[]) => notes[g[g.length - 1]].end - notes[g[0]].start;

  // Long groups: split at the longest rest inside, repeatedly.
  const split: number[][] = [];
  const queue = [...groups];
  while (queue.length) {
    const g = queue.shift()!;
    if (span(g) <= MAX_PHRASE || g.length < 2) {
      split.push(g);
      continue;
    }
    let cut = 1;
    let gap = -Infinity;
    for (let k = 1; k < g.length; k++) {
      const r = notes[g[k]].start - notes[g[k - 1]].end;
      // Prefer cuts near the middle when rests are equal.
      const score = r - Math.abs(k - g.length / 2) * 1e-4;
      if (score > gap) {
        gap = score;
        cut = k;
      }
    }
    queue.unshift(g.slice(0, cut), g.slice(cut));
  }
  groups = split;

  // Short groups: merge with the closer neighbour, unless a long break separates them.
  for (let i = 0; i < groups.length; i++) {
    if (span(groups[i]) >= MIN_PHRASE || groups.length < 2) continue;
    const g = groups[i];
    const before = i > 0 ? notes[g[0]].start - notes[groups[i - 1].at(-1)!].end : Infinity;
    const after = i < groups.length - 1 ? notes[groups[i + 1][0]].start - notes[g.at(-1)!].end : Infinity;
    if (Math.min(before, after) >= BLOCK_GAP) continue;
    if (before <= after) {
      groups[i - 1].push(...g);
      groups.splice(i, 1);
    } else {
      groups[i + 1].unshift(...g);
      groups.splice(i, 1);
    }
    i--;
  }

  const phrases: Phrase[] = groups.map((g, i) => ({
    id: `p${i + 1}`,
    start: notes[g[0]].start,
    end: notes[g.at(-1)!].end,
    first: g[0],
    last: g.at(-1)!,
    block: 0,
  }));

  // Blocks: runs of phrases between long breaks, split further when too long.
  let runs: Phrase[][] = [];
  phrases.forEach((ph, i) => {
    if (i === 0 || ph.start - phrases[i - 1].end >= BLOCK_GAP) runs.push([ph]);
    else runs[runs.length - 1].push(ph);
  });
  const fitted: Phrase[][] = [];
  while (runs.length) {
    const r = runs.shift()!;
    if (r.length <= MAX_BLOCK_PHRASES) {
      fitted.push(r);
      continue;
    }
    // Cut at the longest rest, preferring the middle so the halves come out even.
    let cut = 1;
    let best = -Infinity;
    for (let k = 1; k < r.length; k++) {
      const score = r[k].start - r[k - 1].end - Math.abs(k - r.length / 2) * 0.05;
      if (score > best) {
        best = score;
        cut = k;
      }
    }
    runs = [r.slice(0, cut), r.slice(cut), ...runs];
  }
  const blocks: Block[] = fitted.map((r, b) => {
    r.forEach((ph) => (ph.block = b));
    return { name: `ブロック${b + 1}`, start: r[0].start, end: r.at(-1)!.end, phraseIds: r.map((ph) => ph.id) };
  });
  return { phrases, blocks };
}

export interface PhraseAssessment {
  id: string;
  /** Duration-weighted share of time in tune, 0-100. */
  score: number;
  /** Mean deviation (cents) while near the notes; negative = flat. */
  bias: number | null;
  /** Problems found, most important first, worded for the singer. */
  issues: string[];
  /** The note sung worst. */
  worst: number;
}

interface NoteFacts {
  ratio: number;
  voiced: number;
  onset: number | null;
  firstHalf: number | null;
  secondHalf: number | null;
  lateness: number | null;
}

/** How well one note was sung, from the take's pitch points. */
function noteFacts(n: SongNote, pts: { t: number; m: number | null }[], tolerance: number): NoteFacts {
  const inside = pts.filter((p) => p.t >= n.start && p.t < n.end);
  const expected = Math.max(1, (n.end - n.start) / SAMPLE_SEC);
  const voiced = inside.filter((p) => p.m !== null) as { t: number; m: number }[];
  const devs = voiced.map((p) => (p.m - n.midi) * 100).filter((d) => Math.abs(d) <= 150);
  const hit = voiced.filter((p) => Math.abs((p.m - n.midi) * 100) <= tolerance).length;
  const dev = (from: number, to: number) => {
    const d = voiced.filter((p) => p.t >= from && p.t < to).map((p) => (p.m - n.midi) * 100);
    return d.length >= 2 ? median(d) : null;
  };
  const mid = (n.start + n.end) / 2;
  return {
    ratio: Math.min(1, hit / expected),
    voiced: Math.min(1, voiced.length / expected),
    onset: dev(n.start, n.start + 0.15),
    firstHalf: devs.length ? dev(n.start + 0.1, mid) : null,
    secondHalf: devs.length ? dev(mid, n.end) : null,
    lateness: voiced.length ? voiced[0].t - n.start : null,
  };
}

/**
 * Scores each phrase from a take and names its problems: notes not sung, pitch off on the whole,
 * scooping into notes, missed leaps, sagging on long notes and late entries.
 */
export function assess(
  notes: SongNote[],
  phrases: Phrase[],
  points: { t: number; m: number | null }[],
  tolerance: number,
): PhraseAssessment[] {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  return phrases.map((ph) => {
    const pts = sorted.filter((p) => p.t >= ph.start - 0.2 && p.t < ph.end + 0.2);
    const idx = Array.from({ length: ph.last - ph.first + 1 }, (_, k) => ph.first + k);
    const facts = idx.map((i) => noteFacts(notes[i], pts, tolerance));
    const dur = (i: number) => notes[i].end - notes[i].start;
    const total = idx.reduce((s, i) => s + dur(i), 0);
    const score = Math.round((idx.reduce((s, i, k) => s + facts[k].ratio * dur(i), 0) / total) * 100);

    const near = pts
      .filter((p) => p.m !== null)
      .map((p) => {
        const k = idx.find((i) => p.t >= notes[i].start && p.t < notes[i].end);
        return k === undefined ? null : (p.m! - notes[k].midi) * 100;
      })
      .filter((d): d is number => d !== null && Math.abs(d) <= 150);
    const bias = near.length >= 8 ? near.reduce((a, b) => a + b, 0) / near.length : null;

    const issues: { weight: number; text: string }[] = [];
    const name = (i: number) => solfege(notes[i].midi);
    const missing = idx.filter((_, k) => facts[k].voiced < 0.3);
    if (missing.length) issues.push({ weight: 3, text: `声が出ていない音がある（${missing.slice(0, 3).map(name).join("・")}）` });
    if (bias !== null && Math.abs(bias) >= 20) issues.push({ weight: 2, text: `全体に${bias < 0 ? "低い" : "高い"}（${Math.round(bias)}¢）` });
    const scoops = idx.filter((i, k) => {
      const f = facts[k];
      const entry = i === ph.first || notes[i].start - notes[i - 1].end >= 0.1;
      return entry && f.onset !== null && f.onset <= -60 && f.secondHalf !== null && Math.abs(f.secondHalf) <= tolerance * 1.5;
    });
    if (scoops.length) issues.push({ weight: 2, text: `入りをずり上げている（${scoops.slice(0, 3).map(name).join("・")}）` });
    const leaps = idx.filter((i, k) => i > ph.first && Math.abs(notes[i].midi - notes[i - 1].midi) >= 5 && facts[k].ratio < 0.5);
    if (leaps.length) {
      const i = leaps[0];
      issues.push({ weight: 2, text: `跳躍で外れる（${name(i - 1)}→${name(i)}）` });
    }
    const sags = idx.filter((i, k) => {
      const f = facts[k];
      return dur(i) >= 0.6 && f.firstHalf !== null && f.secondHalf !== null && f.secondHalf - f.firstHalf <= -30;
    });
    if (sags.length) issues.push({ weight: 1, text: `伸ばしで下がる（${sags.slice(0, 3).map(name).join("・")}）` });
    const late = idx.filter((i, k) => {
      const entry = i === ph.first || notes[i].start - notes[i - 1].end >= 0.15;
      return entry && facts[k].lateness !== null && facts[k].lateness! > 0.15;
    });
    if (late.length) issues.push({ weight: 1, text: `入りが遅い（${late.slice(0, 3).map(name).join("・")}）` });

    let worst = idx[0];
    idx.forEach((i, k) => {
      if (facts[k].ratio < facts[idx.indexOf(worst)].ratio) worst = i;
    });
    return {
      id: ph.id,
      score,
      bias,
      issues: issues.sort((a, b) => b.weight - a.weight).map((x) => x.text),
      worst,
    };
  });
}

/** The phrases to practise: those under `threshold`, weakest first, at most `max` (at least `min`). */
export function pickWeak(assessed: PhraseAssessment[], threshold = 70, max = 5, min = 3): PhraseAssessment[] {
  const sorted = [...assessed].sort((a, b) => a.score - b.score);
  const under = sorted.filter((a) => a.score < threshold);
  return (under.length >= min ? under : sorted.slice(0, min)).slice(0, max);
}
