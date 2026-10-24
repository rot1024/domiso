import { midiToFreq } from "../theory";
import type { SongNote } from "./song";

/**
 * The guide melody's sound, shared by live playback and file export: a sine plus a quiet octave
 * (soft, flute-like, clear over a band without sounding like the singer).
 */
export const MELODY_PARTIALS: readonly (readonly [multiple: number, level: number])[] = [
  [1, 1],
  [2, 0.25],
];
export const MELODY_ATTACK = 0.025;
/** Release time, never more than a third of a short note. */
export const melodyRelease = (duration: number) => Math.min(0.06, duration / 3);

/**
 * Renders the guide melody to mono samples. `shiftCents` moves every note (e.g. the recording's
 * overall tuning offset), so the result lines up with the song it was made from.
 */
export function renderMelody(notes: SongNote[], sampleRate: number, duration: number, shiftCents = 0): Float32Array {
  const out = new Float32Array(Math.ceil(duration * sampleRate));
  for (const n of notes) {
    const a = Math.round(n.start * sampleRate);
    const b = Math.min(out.length, Math.round(n.end * sampleRate));
    if (b <= a) continue;
    const len = (b - a) / sampleRate;
    const release = melodyRelease(len);
    const f = midiToFreq(n.midi + shiftCents / 100);
    for (let i = a; i < b; i++) {
      const t = (i - a) / sampleRate;
      const env = Math.min(1, t / MELODY_ATTACK, (len - t) / release);
      let v = 0;
      for (const [mult, level] of MELODY_PARTIALS) v += level * Math.sin(2 * Math.PI * f * mult * t);
      out[i] += v * env;
    }
  }
  // Leave headroom: peak at -6 dBFS.
  let peak = 0;
  for (const v of out) peak = Math.max(peak, Math.abs(v));
  if (peak > 0) for (let i = 0; i < out.length; i++) out[i] *= 0.5 / peak;
  return out;
}

/** 16-bit PCM WAV file from mono samples. */
export function encodeWav(samples: Float32Array, sampleRate: number): Uint8Array<ArrayBuffer> {
  const data = samples.length * 2;
  const buf = new ArrayBuffer(44 + data);
  const v = new DataView(buf);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, "RIFF");
  v.setUint32(4, 36 + data, true);
  str(8, "WAVE");
  str(12, "fmt ");
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // mono
  v.setUint32(24, sampleRate, true);
  v.setUint32(28, sampleRate * 2, true);
  v.setUint16(32, 2, true);
  v.setUint16(34, 16, true);
  str(36, "data");
  v.setUint32(40, data, true);
  for (let i = 0; i < samples.length; i++) {
    v.setInt16(44 + i * 2, Math.round(Math.max(-1, Math.min(1, samples[i])) * 32767), true);
  }
  return new Uint8Array(buf);
}
