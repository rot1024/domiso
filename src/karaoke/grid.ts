import { median } from "../pitch";
import type { SongNote } from "./song";

/** A cell counts as sung when notes cover at least this share of it. */
const COVERED_SHARE = 0.5;

/**
 * How fine the grid is, as a range for one cell's length in seconds. "16" is about a sixteenth note at
 * common tempos. A range spanning a factor of two always contains exactly one power-of-two split of the
 * beat, so a tempo detected at double or half speed still gives the same grid.
 */
export const GRID_CELL: Record<"16" | "8", [number, number]> = { "16": [0.1, 0.2], "8": [0.2, 0.4] };

/** How many cells each beat is split into so that a cell falls within `range`. */
export function divisionFor(beats: number[], range: [number, number]): number {
  const period = median(beats.slice(1).map((b, i) => b - beats[i]));
  let division = 1;
  while (period / division > range[1] && division < 16) division *= 2;
  while (period / division < range[0] && division > 1) division /= 2;
  return division;
}

/**
 * Grid lines from beat times: each beat split into `division` equal parts (4 = sixteenth notes),
 * extended at the tempo of the nearest beats to cover the whole song.
 */
export function gridLines(beats: number[], division: number, duration: number): number[] {
  if (beats.length < 2) return [];
  const periods = beats.slice(1).map((b, i) => b - beats[i]);
  const period = median(periods);
  const all = [...beats];
  while (all[0] > 0) all.unshift(all[0] - period);
  while (all[all.length - 1] < duration) all.push(all[all.length - 1] + period);
  const lines: number[] = [];
  for (let i = 0; i + 1 < all.length; i++) {
    for (let k = 0; k < division; k++) lines.push(all[i] + ((all[i + 1] - all[i]) * k) / division);
  }
  lines.push(all[all.length - 1]);
  return lines.filter((t, i) => t >= 0 || lines[i + 1] > 0).map((t) => Math.max(0, t));
}

/** Beats steadier than this (onset autocorrelation at the beat period) are trusted for the grid. */
export const MIN_BEAT_STRENGTH = 0.15;

/**
 * Snaps notes to a grid built from detected beats, or returns null when the beats aren't clear enough
 * to trust (then the notes are best left as sung).
 */
export function applyGrid(
  notes: SongNote[],
  detected: { bpm: number; beats: number[]; strength: number },
  duration: number,
  fineness: "16" | "8",
): { notes: SongNote[]; tempo: { bpm: number; beats: number[]; division: number } } | null {
  if (detected.strength < MIN_BEAT_STRENGTH || detected.beats.length < 8) return null;
  const division = divisionFor(detected.beats, GRID_CELL[fineness]);
  return {
    notes: snapToGrid(notes, gridLines(detected.beats, division, duration)),
    tempo: { bpm: detected.bpm, beats: detected.beats, division },
  };
}

/**
 * Puts notes on the grid, as a score would have them: each cell takes the note that covers most of it,
 * and consecutive cells taken by the same note become one note. Wobbles, scoops and ornaments shorter
 * than a cell disappear, while a pitch sung again (a separate note in `notes`) stays separate.
 */
export function snapToGrid(notes: SongNote[], lines: number[]): SongNote[] {
  const out: SongNote[] = [];
  let source = -1;
  let k = 0;
  for (let j = 0; j + 1 < lines.length; j++) {
    const a = lines[j];
    const b = lines[j + 1];
    while (k < notes.length && notes[k].end <= a) k++;
    let best = -1;
    let bestOverlap = 0;
    let covered = 0;
    for (let i = k; i < notes.length && notes[i].start < b; i++) {
      const overlap = Math.min(b, notes[i].end) - Math.max(a, notes[i].start);
      if (overlap <= 0) continue;
      covered += overlap;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        best = i;
      }
    }
    if (best < 0 || covered < (b - a) * COVERED_SHARE) {
      source = -1;
      continue;
    }
    const prev = out[out.length - 1];
    if (best === source && prev && prev.end === a) prev.end = b;
    else out.push({ start: a, end: b, midi: notes[best].midi });
    source = best;
  }
  return absorbOneCellNotes(out, median(lines.slice(1).map((t, i) => t - lines[i])));
}

/** A one-cell note within this many semitones of the note it leans on is part of that note's onset or tail. */
const LEAN_SEMIS = 2;

/**
 * A note one cell long, tied on to its neighbours without a break, is usually the voice on its way
 * between two notes (a slide, a scoop, a fall) rather than a note of the melody: it joins the note it
 * leads into (or out of). A repeated pitch is a syllable sung again and stays.
 */
function absorbOneCellNotes(notes: SongNote[], cell: number): SongNote[] {
  const out = notes.map((n) => ({ ...n }));
  const touches = (a: SongNote, b: SongNote) => Math.abs(b.start - a.end) < cell * 0.01;
  for (let i = 0; i < out.length; i++) {
    const n = out[i];
    if (n.end - n.start > cell * 1.5) continue;
    const prev = i > 0 && touches(out[i - 1], n) ? out[i - 1] : null;
    const next = i + 1 < out.length && touches(n, out[i + 1]) ? out[i + 1] : null;
    if ((prev && prev.midi === n.midi) || (next && next.midi === n.midi)) continue;
    let into: SongNote | null = null;
    if (prev && next) {
      const between = (n.midi - prev.midi) * (next.midi - n.midi) > 0;
      if (between) into = next;
      else if (Math.abs(next.midi - n.midi) <= LEAN_SEMIS) into = next;
      else if (Math.abs(prev.midi - n.midi) <= LEAN_SEMIS) into = prev;
    } else if (next && Math.abs(next.midi - n.midi) <= LEAN_SEMIS) into = next;
    else if (prev && Math.abs(prev.midi - n.midi) <= LEAN_SEMIS) into = prev;
    if (!into) continue;
    if (into === next) next.start = n.start;
    else prev!.end = n.end;
    out.splice(i, 1);
    i = Math.max(-1, i - 2);
  }
  return out;
}
