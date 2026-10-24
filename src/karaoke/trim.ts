/** Frames quieter than the loudest frame by this much (dB) count as silence. */
const SILENCE_BELOW_PEAK_DB = 60;
const FRAME_SEC = 0.01;
/** Kept around the sound so a soft attack or a reverb tail isn't cut off. */
const PAD_BEFORE = 0.2;
const PAD_AFTER = 0.5;

/**
 * The part of a recording worth keeping: from just before the first sound to just after the last,
 * dropping silence that some sources have at the start or end. Times in seconds.
 */
export function soundRange(samples: Float32Array, sampleRate: number): { start: number; end: number } {
  const hop = Math.max(1, Math.round(sampleRate * FRAME_SEC));
  const frames = Math.floor(samples.length / hop);
  const total = samples.length / sampleRate;
  const db = new Float32Array(frames);
  let peak = -Infinity;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) sum += samples[i] * samples[i];
    db[f] = 10 * Math.log10(sum / hop + 1e-20);
    if (db[f] > peak) peak = db[f];
  }
  const threshold = peak - SILENCE_BELOW_PEAK_DB;
  let first = 0;
  while (first < frames && db[first] < threshold) first++;
  if (first === frames) return { start: 0, end: total }; // all silent: leave it alone
  let last = frames - 1;
  while (last > first && db[last] < threshold) last--;
  return {
    start: Math.max(0, first * FRAME_SEC - PAD_BEFORE),
    end: Math.min(total, (last + 1) * FRAME_SEC + PAD_AFTER),
  };
}
