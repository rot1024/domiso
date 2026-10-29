import type { SongNote } from "./song";
import { onsetEnvelope, onsetTime } from "./tempo";

/** An onset counts when its flux rises this far (envelope SDs) above the local mean... */
const MIN_RISE = 1.0;
/** ...and either the voice dips this much (dB) just before it, as a consonant makes it, */
const CONSONANT_DIP = 4;
/** ...or the rise is this strong (a clear change of vowel). Vibrato rarely gets either. */
const STRONG_RISE = 2.0;
/** Syllables closer than this are one. */
const MIN_GAP = 0.08;

/**
 * Where new syllables start in a vocal track, even without a change of pitch: spectral flux peaks
 * that come with a dip in loudness (a consonant) or a strong change of sound (a new vowel).
 */
export function syllableOnsets(samples: Float32Array, rate: number): number[] {
  const env = onsetEnvelope(samples, rate);
  const level = (from: number, to: number) => {
    let s = 0;
    let n = 0;
    for (let i = Math.max(0, Math.round(from * rate)); i < Math.min(samples.length, Math.round(to * rate)); i++) {
      s += samples[i] * samples[i];
      n++;
    }
    return 10 * Math.log10(s / Math.max(1, n) + 1e-12);
  };
  const out: number[] = [];
  for (let i = 10; i < env.length - 10; i++) {
    let peak = true;
    for (let k = -3; k <= 3 && peak; k++) if (env[i + k] > env[i]) peak = false;
    if (!peak) continue;
    let mean = 0;
    for (let k = -10; k <= 10; k++) mean += env[i + k] / 21;
    const rise = env[i] - mean;
    if (rise < MIN_RISE) continue;
    const t = onsetTime(i, rate);
    if (rise < STRONG_RISE) {
      // Quietest 20 ms just before the onset, against the louder side around it.
      let low = Infinity;
      for (let s = t - 0.1; s < t + 0.02; s += 0.01) low = Math.min(low, level(s, s + 0.02));
      const around = Math.max(level(t - 0.2, t - 0.1), level(t + 0.03, t + 0.13));
      if (around - low < CONSONANT_DIP) continue;
    }
    if (out.length && t - out[out.length - 1] < MIN_GAP) continue;
    out.push(t);
  }
  return out;
}

/** Splits notes where a new syllable starts inside them, so a repeated pitch is sung (and shown) again. */
export function splitAtOnsets(notes: SongNote[], onsets: number[], minPart = 0.08): SongNote[] {
  const out: SongNote[] = [];
  for (const n of notes) {
    let start = n.start;
    for (const o of onsets) {
      if (o <= start + minPart || o >= n.end - minPart) continue;
      out.push({ start, end: o, midi: n.midi });
      start = o;
    }
    out.push({ start, end: n.end, midi: n.midi });
  }
  return out;
}
