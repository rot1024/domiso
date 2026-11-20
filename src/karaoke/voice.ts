import { midiToFreq } from "../theory";
import type { Syllable } from "./key";

/**
 * A synthetic singer for solfège: harmonics of the sung pitch shaped by vowel formants (source-filter
 * synthesis), with simple consonants in front. It is plain and a bit robotic, but every note is
 * exactly on pitch and says its name, and it can be made for any note, length and speed on the spot.
 */

type Formants = [number, number, number];

/** Japanese vowels, for a female-range voice (scaled down for low notes). */
const VOWELS: Record<"a" | "i" | "u" | "e" | "o", Formants> = {
  a: [850, 1350, 2800],
  i: [320, 2700, 3300],
  u: [380, 1500, 2600],
  e: [520, 2200, 2900],
  o: [500, 880, 2700],
};
const F4 = 3800;
const BANDWIDTHS = [90, 110, 170, 250];

interface Consonant {
  /** Seconds before the vowel starts on the beat. */
  lead: number;
  /** Voicing level over the consonant, as (time from its start, level) points. */
  voice: [number, number][];
  /** Formants the vowel glides from, and over how long. */
  locus: Formants;
  glide: number;
  /** Damps the highs while voiced, like a nasal murmur. */
  nasal?: boolean;
  /** A noise band (Hz) and level over the consonant, as (time, level) points. */
  noise?: { lo: number; hi: number; level: [number, number][] };
}

const CONSONANTS: Record<"d" | "r" | "m" | "f" | "s" | "sh", Consonant> = {
  // Voice bar, then a short burst.
  d: {
    lead: 0.045,
    voice: [[0, 0], [0.01, 0.07], [0.04, 0.07], [0.045, 0.3]],
    locus: [250, 1700, 2700],
    glide: 0.05,
    noise: { lo: 2500, hi: 5500, level: [[0, 0], [0.03, 0], [0.033, 0.5], [0.045, 0.05]] },
  },
  // A tap: voiced, with a quick dip.
  r: {
    lead: 0.04,
    voice: [[0, 0], [0.012, 0.45], [0.028, 0.15], [0.04, 0.5]],
    locus: [300, 1500, 2500],
    glide: 0.04,
  },
  m: {
    lead: 0.06,
    voice: [[0, 0], [0.015, 0.35], [0.058, 0.35], [0.06, 0.5]],
    locus: [280, 1100, 2400],
    glide: 0.05,
    nasal: true,
  },
  // Japanese ふ: a soft breath between the lips.
  f: {
    lead: 0.07,
    voice: [[0, 0], [0.06, 0], [0.07, 0.3]],
    locus: [500, 1000, 2400],
    glide: 0.05,
    noise: { lo: 900, hi: 4000, level: [[0, 0], [0.02, 0.12], [0.06, 0.12], [0.072, 0]] },
  },
  s: {
    lead: 0.09,
    voice: [[0, 0], [0.085, 0], [0.09, 0.3]],
    locus: [400, 1500, 2600],
    glide: 0.05,
    noise: { lo: 4500, hi: 9500, level: [[0, 0], [0.025, 0.3], [0.08, 0.3], [0.092, 0]] },
  },
  sh: {
    lead: 0.09,
    voice: [[0, 0], [0.085, 0], [0.09, 0.3]],
    locus: [300, 2200, 2900],
    glide: 0.04,
    noise: { lo: 2200, hi: 6000, level: [[0, 0], [0.025, 0.3], [0.08, 0.3], [0.092, 0]] },
  },
};

const PARTS: Record<Syllable, [keyof typeof CONSONANTS, keyof typeof VOWELS]> = {
  do: ["d", "o"],
  re: ["r", "e"],
  mi: ["m", "i"],
  fa: ["f", "a"],
  so: ["s", "o"],
  la: ["r", "a"],
  si: ["sh", "i"],
};

/** Seconds of consonant sung before the note's start, so the vowel lands on it. */
export function syllableLead(s: Syllable): number {
  return CONSONANTS[PARTS[s][0]].lead;
}

const VOWEL_ATTACK = 0.02;
const release = (len: number) => Math.min(0.06, len / 3);
/** Level (RMS) of the sustained vowel. */
const LEVEL = 0.25;
/** Harmonic amplitudes are recomputed every this many samples. */
const BLOCK = 32;

/** Piecewise-linear value at `t` through (time, value) points, held flat outside them. */
function curve(points: [number, number][], t: number): number {
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return v0 + ((v1 - v0) * (t - t0)) / (t1 - t0);
    }
  }
  return points[points.length - 1][1];
}

/** Magnitude of a two-pole resonance at `f`, 1 at 0 Hz. */
function resonance(f: number, freq: number, bw: number): number {
  const f2 = freq * freq;
  return f2 / Math.sqrt((f2 - f * f) ** 2 + (bw * f) ** 2);
}

/**
 * Sings one syllable on `midi` (may be fractional) whose vowel lasts `length` seconds. The result starts
 * `syllableLead(s)` seconds before the vowel.
 */
export function renderSyllable(s: Syllable, midi: number, length: number, sampleRate: number, seed = 1): Float32Array<ArrayBuffer> {
  const [cName, vName] = PARTS[s];
  const c = CONSONANTS[cName];
  const f0 = midiToFreq(midi);
  // Smaller formants for lower voices; the first formant follows a high pitch up (as sopranos do).
  const scale = f0 < 180 ? 0.87 : 1;
  const vowel = VOWELS[vName].map((f) => f * scale) as Formants;
  const locus = c.locus.map((f) => f * scale) as Formants;
  vowel[0] = Math.max(vowel[0], f0 * 1.1);
  const total = c.lead + length;
  const out = new Float32Array(Math.ceil(total * sampleRate));
  const rel = release(length);
  const maxF = Math.min(6000, sampleRate * 0.45);
  const harmonics = Math.max(1, Math.floor(maxF / (f0 * 1.01)));
  const amps = new Float64Array(harmonics + 1);

  let phase = 0;
  let level = 0;
  for (let i0 = 0; i0 < out.length; i0 += BLOCK) {
    const t = i0 / sampleRate;
    const tv = t - c.lead; // time into the vowel
    level = tv < 0 ? curve(c.voice, t) : Math.min(curve(c.voice, c.lead) + (1 - curve(c.voice, c.lead)) * Math.min(1, tv / VOWEL_ATTACK), 1);
    if (tv > length - rel) level *= Math.max(0, (length - tv) / rel);
    const g = Math.min(1, Math.max(0, tv / c.glide));
    const fm = [0, 1, 2].map((k) => locus[k] + (vowel[k] - locus[k]) * g);
    const nasal = c.nasal && tv < 0.01 ? 1 - Math.max(0, tv) / 0.01 : 0;
    // Harmonic amplitudes from the formants, scaled so the voiced part has the target loudness.
    let power = 0;
    for (let k = 1; k <= harmonics; k++) {
      const f = k * f0;
      let a = 1 / k;
      for (let j = 0; j < 3; j++) a *= resonance(f, fm[j], BANDWIDTHS[j]);
      a *= resonance(f, F4 * scale, BANDWIDTHS[3]);
      if (nasal) a *= (1 / (1 + (f / 400) ** 2)) ** nasal;
      amps[k] = a;
      power += a * a;
    }
    const norm = power ? (LEVEL * Math.SQRT2 * level) / Math.sqrt(power) : 0;
    // A light vibrato on long notes, fading in after the start.
    const vib = tv > 0.3 ? 0.12 * Math.min(1, (tv - 0.3) / 0.25) * Math.sin(2 * Math.PI * 5.5 * tv) : 0;
    const dphi = (2 * Math.PI * midiToFreq(midi + vib)) / sampleRate;
    const end = Math.min(out.length, i0 + BLOCK);
    for (let i = i0; i < end; i++) {
      phase += dphi;
      if (phase > 2 * Math.PI) phase -= 2 * Math.PI;
      if (!norm) continue;
      // sin(kφ) by the Chebyshev recurrence.
      const s1 = Math.sin(phase);
      const c2 = 2 * Math.cos(phase);
      let prev = 0;
      let cur = s1;
      let v = 0;
      for (let k = 1; k <= harmonics; k++) {
        v += amps[k] * cur;
        const next = c2 * cur - prev;
        prev = cur;
        cur = next;
      }
      out[i] = v * norm;
    }
  }

  if (c.noise) addNoise(out, c.noise, sampleRate, seed);
  return out;
}

/** Adds band-limited noise shaped by its level curve (the hiss of s, sh, f and the burst of d). */
function addNoise(out: Float32Array, noise: NonNullable<Consonant["noise"]>, sampleRate: number, seed: number) {
  const len = Math.min(out.length, Math.ceil(noise.level[noise.level.length - 1][0] * sampleRate) + 1);
  const hp = biquad("highpass", noise.lo, sampleRate);
  const lp = biquad("lowpass", Math.min(noise.hi, sampleRate * 0.45), sampleRate);
  let r = seed * 2654435761 || 1;
  for (let i = 0; i < len; i++) {
    r = (r * 16807) % 2147483647;
    const white = (r / 2147483647) * 2 - 1;
    // Filtered white noise has about a third of its RMS left per octave or so; make up for it.
    out[i] += lp(hp(white)) * curve(noise.level, i / sampleRate) * LEVEL * 3;
  }
}

/** A second-order filter (RBJ cookbook, Q = 0.707) as a sample-by-sample function. */
function biquad(type: "lowpass" | "highpass", freq: number, sampleRate: number): (x: number) => number {
  const w = (2 * Math.PI * freq) / sampleRate;
  const alpha = Math.sin(w) / (2 * Math.SQRT1_2);
  const cos = Math.cos(w);
  const b1 = type === "lowpass" ? 1 - cos : -(1 + cos);
  const b0 = Math.abs(b1) / 2;
  const a0 = 1 + alpha;
  const [nb0, nb1, nb2, na1, na2] = [b0 / a0, b1 / a0, b0 / a0, (-2 * cos) / a0, (1 - alpha) / a0];
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  return (x) => {
    const y = nb0 * x + nb1 * x1 + nb2 * x2 - na1 * y1 - na2 * y2;
    x2 = x1;
    x1 = x;
    y2 = y1;
    y1 = y;
    return y;
  };
}

/**
 * Sings the whole melody in solfège to mono samples, like renderMelody. `shiftCents` moves every
 * note (the recording's tuning offset).
 */
export function renderSolfa(
  notes: { start: number; end: number; midi: number }[],
  syllables: Syllable[],
  sampleRate: number,
  duration: number,
  shiftCents = 0,
): Float32Array {
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  notes.forEach((n, i) => {
    const s = syllables[i];
    const v = renderSyllable(s, n.midi + shiftCents / 100, n.end - n.start, sampleRate, i + 1);
    const at = Math.round((n.start - syllableLead(s)) * sampleRate);
    for (let j = Math.max(0, -at); j < v.length && at + j < out.length; j++) out[at + j] += v[j];
  });
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.5 / peak;
  return out;
}
