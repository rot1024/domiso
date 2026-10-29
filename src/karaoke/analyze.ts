import { PitchDetector } from "pitchy";
import { freqToMidi } from "../theory";
import { fixSubharmonic, median } from "../pitch";
import type { SongNote } from "./song";

/** Analysis frame step in seconds. The contour is stored at this resolution. */
export const HOP = 0.01;
const FRAME = 1024;
const MIN_FREQ = 70;
const MAX_FREQ = 1200;
// Lower than the live mic's 0.85: on separated vocals 0.85 drops about a third of the singing, while at 0.7
// two independent separations still agree on 97% of frames.
const MIN_CLARITY = 0.7;
/** Unvoiced gaps up to this long are bridged when the pitch on both sides is close. */
const MAX_GAP_FRAMES = 8;
/** A new note starts only when the pitch stays this far (semitones) from the current one... */
const SWITCH_SEMIS = 0.65;
/** ...for this many frames. Shorter excursions (vibrato, scoops) stay in the current note. */
const SWITCH_FRAMES = 6;
const MIN_NOTE_SEC = 0.08;

export interface Analysis {
  /** MIDI pitch per frame (see `hop`), null where there is no voice. Not offset-corrected. */
  contour: (number | null)[];
  /**
   * Seconds per contour frame. Frames step by a whole number of samples, so this is close to HOP but
   * not equal (22050 Hz × 10 ms = 220.5, rounded to 221 samples = 10.023 ms): using HOP would put
   * notes 0.23 % early, 0.4 s by 3 minutes.
   */
  hop: number;
  /** Set when the notes were snapped to a beat grid. */
  tempo?: { bpm: number; beats: number[]; division: number };
  /** How far the whole recording sits from equal temperament (A=440), in cents. */
  offsetCents: number;
  notes: SongNote[];
}

/** Turns a mono vocal recording into a pitch contour and semitone-quantized notes. */
export function analyze(samples: Float32Array, sampleRate: number, onProgress?: (ratio: number) => void): Analysis {
  const hop = Math.round(sampleRate * HOP) / sampleRate;
  // A frame's pitch belongs to its window's middle: pad the front so index × hop is that time.
  const pad = Math.round(FRAME / 2 / sampleRate / hop);
  const raw = [...new Array<null>(pad).fill(null), ...detect(samples, sampleRate, onProgress)];
  const contour = bridgeGaps(medianFilter(raw));
  const offsetCents = tuningOffset(contour);
  const notes = segment(contour, offsetCents / 100, hop);
  return { contour: contour.map((m) => (m === null ? null : Math.round(m * 100) / 100)), hop, offsetCents, notes };
}

function detect(samples: Float32Array, sampleRate: number, onProgress?: (ratio: number) => void): (number | null)[] {
  const hop = Math.round(sampleRate * HOP);
  const detector = PitchDetector.forFloat32Array(FRAME);
  const frames = Math.max(0, Math.floor((samples.length - FRAME) / hop) + 1);

  // The voice threshold adapts to the recording: a fraction of its loud level, above the noise floor.
  const rms = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let sum = 0;
    for (let j = i * hop, end = j + FRAME; j < end; j++) sum += samples[j] * samples[j];
    rms[i] = Math.sqrt(sum / FRAME);
  }
  const sorted = Float32Array.from(rms).sort();
  const loud = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
  const threshold = Math.max(0.005, loud * 0.08);

  const out: (number | null)[] = new Array(frames).fill(null);
  for (let i = 0; i < frames; i++) {
    if (rms[i] < threshold) continue;
    const frame = samples.subarray(i * hop, i * hop + FRAME);
    const [freq, clarity] = detector.findPitch(frame, sampleRate);
    if (clarity >= MIN_CLARITY && freq >= MIN_FREQ && freq <= MAX_FREQ) {
      out[i] = freqToMidi(fixSubharmonic(frame, sampleRate, freq));
    }
    if (onProgress && i % 500 === 0) onProgress(i / frames);
  }
  return out;
}

/** 5-frame median over voiced neighbours, to remove isolated octave errors. */
function medianFilter(xs: (number | null)[]): (number | null)[] {
  return xs.map((x, i) => {
    if (x === null) return null;
    const win: number[] = [];
    for (let j = i - 2; j <= i + 2; j++) {
      const v = xs[j];
      if (v !== undefined && v !== null) win.push(v);
    }
    return median(win);
  });
}

function bridgeGaps(xs: (number | null)[]): (number | null)[] {
  const out = [...xs];
  let i = 0;
  while (i < out.length) {
    if (out[i] !== null) {
      i++;
      continue;
    }
    let j = i;
    while (j < out.length && out[j] === null) j++;
    const before = out[i - 1];
    const after = out[j];
    if (before != null && after != null && j - i <= MAX_GAP_FRAMES && Math.abs(before - after) < 1.5) {
      for (let k = i; k < j; k++) out[k] = before + ((after - before) * (k - i + 1)) / (j - i + 1);
    }
    i = j;
  }
  return out;
}

/** Circular mean of the fractional part of every voiced frame: the singer's overall tuning. */
export function tuningOffset(contour: (number | null)[]): number {
  let s = 0;
  let c = 0;
  for (const m of contour) {
    if (m === null) continue;
    s += Math.sin(2 * Math.PI * m);
    c += Math.cos(2 * Math.PI * m);
  }
  if (s === 0 && c === 0) return 0;
  return Math.round((Math.atan2(s, c) / (2 * Math.PI)) * 100);
}

/** Splits voiced runs into notes with hysteresis, then snaps each note to a semitone. */
export function segment(contour: (number | null)[], offsetSemis: number, hop = HOP): SongNote[] {
  const notes: SongNote[] = [];
  let start = -1;
  let cur = 0;
  let away = 0;
  const close = (end: number) => {
    if (start < 0) return;
    const pitches = contour.slice(start, end).filter((m): m is number => m !== null);
    if (pitches.length && (end - start) * hop >= MIN_NOTE_SEC) {
      notes.push({ start: start * hop, end: end * hop, midi: Math.round(median(pitches) - offsetSemis) });
    }
    start = -1;
  };

  for (let i = 0; i <= contour.length; i++) {
    const m = contour[i];
    if (m === null || m === undefined) {
      close(i);
      away = 0;
      continue;
    }
    const x = m - offsetSemis;
    if (start < 0) {
      start = i;
      cur = Math.round(x);
      away = 0;
      continue;
    }
    if (Math.abs(x - cur) > SWITCH_SEMIS) {
      away++;
      if (away >= SWITCH_FRAMES) {
        const boundary = i - away + 1;
        close(boundary);
        start = boundary;
        // The latest frames are closest to where a glide is heading.
        cur = Math.round(median(contour.slice(i - 2, i + 1).map((v) => v! - offsetSemis)));
        away = 0;
      }
    } else {
      away = 0;
    }
  }

  // Re-joining same-pitch neighbours separated only by a breath-free blip keeps long notes whole.
  const merged: SongNote[] = [];
  for (const n of absorbPassingNotes(notes)) {
    const last = merged[merged.length - 1];
    if (last && last.midi === n.midi && n.start - last.end < 0.03) last.end = n.end;
    else merged.push({ ...n });
  }
  return merged;
}

const PASSING_SEC = 0.15;

/**
 * Glides between notes leave short notes behind: one in between two pitches, or a scoop just below
 * (or above) the first note of a phrase. Those belong to the note that follows.
 */
function absorbPassingNotes(notes: SongNote[]): SongNote[] {
  const out: SongNote[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i];
    const next = notes[i + 1];
    const prev = out[out.length - 1];
    const joinsNext = next && next.start - n.end < 0.02;
    const joinsPrev = prev && n.start - prev.end < 0.02;
    if (n.end - n.start < PASSING_SEC && joinsNext) {
      const between = joinsPrev && (n.midi - prev.midi) * (next.midi - n.midi) > 0;
      const scoop = !joinsPrev && Math.abs(n.midi - next.midi) <= 2;
      if (between || scoop) {
        next.start = n.start;
        continue;
      }
    }
    out.push(n);
  }
  return out;
}
