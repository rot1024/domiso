import type { Song, SongNote } from "./song";

export type KeyMode = "major" | "minor";

/** A key that holds from `start` (song seconds) until the next span. */
export interface KeySpan {
  start: number;
  /** Pitch class of the tonic (0 = C). */
  tonic: number;
  mode: KeyMode;
}

// Krumhansl-Kessler key profiles: how strongly each scale degree (from the tonic) belongs to the key.
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

/**
 * Log-likelihood of a pitch class relative to "do", for a major key on do or a minor key on la
 * (which share do): movable do only needs to know where do is, and telling a key from its relative
 * minor from a melody alone is unreliable anyway.
 */
const DO_PROFILE = (() => {
  const p = MAJOR.map((v, r) => v + MINOR[(r - 9 + 12) % 12]);
  const sum = p.reduce((a, b) => a + b, 0);
  return p.map((v) => Math.log(v / sum));
})();

/**
 * Cost of moving do, in the same units as the evidence (seconds of melody × log-likelihood): a key
 * change needs roughly 10-15 seconds of melody that fits the new key better before it is believed,
 * so a few accidentals don't flip it.
 */
const CHANGE_COST = 5;

const mod12 = (n: number) => ((n % 12) + 12) % 12;

/** Where do is in a key: the tonic of a major key, three semitones above the tonic of a minor one. */
export function doOf(k: { tonic: number; mode: KeyMode }): number {
  return k.mode === "major" ? k.tonic : mod12(k.tonic + 3);
}

/**
 * Finds the song's key and its key changes from the notes: the most likely position of do over time
 * (a Viterbi path with a cost for every change), then major or minor for each stretch.
 */
export function detectKeys(notes: SongNote[]): KeySpan[] {
  if (!notes.length) return [{ start: 0, tonic: 0, mode: "major" }];
  const n = notes.length;
  const score = Array.from({ length: n }, () => new Float64Array(12));
  const from = Array.from({ length: n }, () => new Int8Array(12));
  for (let i = 0; i < n; i++) {
    const pc = mod12(Math.round(notes[i].midi));
    const dur = notes[i].end - notes[i].start;
    // The best place to have been at the previous note, staying or paying for a change.
    let best = 0;
    if (i > 0) for (let d = 1; d < 12; d++) if (score[i - 1][d] > score[i - 1][best]) best = d;
    for (let d = 0; d < 12; d++) {
      let prev = 0;
      if (i > 0) {
        const stay = score[i - 1][d];
        const move = score[i - 1][best] - CHANGE_COST;
        prev = stay >= move ? stay : move;
        from[i][d] = stay >= move ? d : best;
      }
      score[i][d] = prev + dur * DO_PROFILE[mod12(pc - d)];
    }
  }
  let d = 0;
  for (let k = 1; k < 12; k++) if (score[n - 1][k] > score[n - 1][d]) d = k;
  const path = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    path[i] = d;
    d = from[i][d];
  }

  const spans: KeySpan[] = [];
  let first = 0;
  for (let i = 1; i <= n; i++) {
    if (i < n && path[i] === path[first]) continue;
    const span = notes.slice(first, i);
    spans.push({ start: spans.length ? notes[first].start : 0, ...modeFor(span, path[first]) });
    first = i;
  }
  return spans;
}

/**
 * Major on do or minor on la: the key profiles' fit, plus which of the two the phrases come to rest
 * on (notes before a rest, and the last one), which says more about the tonic than how often notes occur.
 */
function modeFor(notes: SongNote[], doPc: number): { tonic: number; mode: KeyMode } {
  const laPc = mod12(doPc + 9);
  const hist = new Array<number>(12).fill(0);
  for (const n of notes) hist[mod12(Math.round(n.midi))] += n.end - n.start;
  let restDo = 0;
  let restLa = 0;
  let rests = 0;
  notes.forEach((n, i) => {
    const next = notes[i + 1];
    if (next && next.start - n.end < PHRASE_REST) return;
    const pc = mod12(Math.round(n.midi));
    rests++;
    if (pc === doPc) restDo++;
    if (pc === laPc) restLa++;
  });
  const lean = correlation(hist, MINOR, laPc) - correlation(hist, MAJOR, doPc) + (rests ? (restLa - restDo) / rests : 0);
  return lean > 0 ? { tonic: laPc, mode: "minor" } : { tonic: doPc, mode: "major" };
}

/** A gap at least this long (seconds) ends a phrase. */
const PHRASE_REST = 0.25;

function correlation(hist: number[], profile: number[], tonic: number): number {
  const p = hist.map((_, pc) => profile[mod12(pc - tonic)]);
  const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
  const mh = mean(hist);
  const mp = mean(p);
  let num = 0;
  let dh = 0;
  let dp = 0;
  for (let i = 0; i < 12; i++) {
    num += (hist[i] - mh) * (p[i] - mp);
    dh += (hist[i] - mh) ** 2;
    dp += (p[i] - mp) ** 2;
  }
  return dh && dp ? num / Math.sqrt(dh * dp) : 0;
}

const detected = new WeakMap<SongNote[], KeySpan[]>();

/** The song's keys: what the user set, or else what is detected from its notes. */
export function songKeys(song: Song): KeySpan[] {
  if (song.keys?.length) return song.keys;
  let k = detected.get(song.notes);
  if (!k) detected.set(song.notes, (k = detectKeys(song.notes)));
  return k;
}

/** The key in effect at song time `t`. */
export function keyAt(spans: KeySpan[], t: number): KeySpan {
  let k = spans[0];
  for (const s of spans) if (s.start <= t + 1e-6) k = s;
  return k;
}

const MAJOR_NAMES = ["C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"];
const MINOR_NAMES = ["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B"];

/** e.g. "E♭" for E-flat major, "Cm" for C minor. */
export function keyName(k: { tonic: number; mode: KeyMode }): string {
  return k.mode === "major" ? MAJOR_NAMES[mod12(k.tonic)] : MINOR_NAMES[mod12(k.tonic)] + "m";
}

/** Movable-do names relative to do: chromatic notes are spelled the way they usually occur. */
export const SOLFA = ["ド", "ド♯", "レ", "ミ♭", "ミ", "ファ", "ファ♯", "ソ", "ソ♯", "ラ", "シ♭", "シ"];

/** The sung syllable for each step above do: altered notes keep their natural syllable. */
export type Syllable = "do" | "re" | "mi" | "fa" | "so" | "la" | "si";
const SYLLABLES: Syllable[] = ["do", "do", "re", "mi", "mi", "fa", "fa", "so", "so", "la", "si", "si"];

export function solfa(midi: number, doPc = 0): string {
  return SOLFA[mod12(Math.round(midi) - doPc)];
}

export function syllable(midi: number, doPc = 0): Syllable {
  return SYLLABLES[mod12(Math.round(midi) - doPc)];
}

/** Do for each note: from the key at the note's start, or C for fixed do. */
export function notesDo(song: Song, fixedDo: boolean): number[] {
  if (fixedDo) return song.notes.map(() => 0);
  const spans = songKeys(song);
  return song.notes.map((n) => doOf(keyAt(spans, n.start)));
}

/** A note name as speech synthesis should read it ("ミ♭" -> "ミフラット"). */
export function spokenSolfa(name: string): string {
  return name.replace("♯", "シャープ").replace("♭", "フラット");
}
