import { fft } from "../fft";

/** Nominal onset envelope frame step, in seconds; frames step by a whole number of samples. */
const STEP = 0.01;
const FFT_SIZE = 1024;
const MIN_BPM = 50;
const MAX_BPM = 240;
/** Tempo prior: log-normal around this BPM, one octave wide (most songs sit between 70 and 180). */
const PRIOR_BPM = 120;
/** How strongly beat spacing is held to the tempo when tracking (higher = steadier). */
const TIGHTNESS = 100;

export interface Beats {
  bpm: number;
  /** Beat times in seconds. */
  beats: number[];
  /** Autocorrelation of the onset envelope at the beat period (0-1): how clearly the music pulses. */
  strength: number;
}

/**
 * How much new sound starts in each 10 ms frame: positive change in log spectrum (spectral flux), with
 * its slow trend removed. Drums and syllables make peaks here.
 */
export function onsetEnvelope(samples: Float32Array, rate: number): Float32Array {
  const hop = frameHop(rate);
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / hop) + 1);
  const bins = Math.floor((FFT_SIZE / 2) * Math.min(1, 8000 / (rate / 2)));
  const window = Float64Array.from({ length: FFT_SIZE }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / FFT_SIZE));
  const re = new Float64Array(FFT_SIZE);
  const im = new Float64Array(FFT_SIZE);
  let prev = new Float64Array(bins);
  const flux = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[f * hop + i] * window[i];
      im[i] = 0;
    }
    fft(re, im, false);
    const cur = new Float64Array(bins);
    let sum = 0;
    for (let k = 1; k < bins; k++) {
      cur[k] = Math.log1p(100 * Math.hypot(re[k], im[k]));
      if (f > 0) sum += Math.max(0, cur[k] - prev[k]);
    }
    flux[f] = sum;
    prev = cur;
  }
  // Subtract a 0.4 s moving average and keep what rises above it.
  const half = Math.round(0.2 / STEP);
  const out = new Float32Array(frames);
  let acc = 0;
  const prefix = new Float64Array(frames + 1);
  for (let f = 0; f < frames; f++) prefix[f + 1] = prefix[f] + flux[f];
  for (let f = 0; f < frames; f++) {
    const a = Math.max(0, f - half);
    const b = Math.min(frames, f + half + 1);
    out[f] = Math.max(0, flux[f] - (prefix[b] - prefix[a]) / (b - a));
    acc += out[f] * out[f];
  }
  const sd = Math.sqrt(acc / Math.max(1, frames)) || 1;
  for (let f = 0; f < frames; f++) out[f] /= sd;
  return out;
}

const frameHop = (rate: number) => Math.round(rate * STEP);

/** Time of an onset envelope frame: its flux peaks when an onset is about three quarters into the window. */
export const onsetTime = (frame: number, rate: number) => (frame * frameHop(rate) + 0.75 * FFT_SIZE) / rate;

/** The beat period (frames) from the envelope's autocorrelation, weighted toward common tempos. */
function beatPeriod(env: Float32Array, fps: number): { period: number; strength: number } {
  const lo = Math.floor((60 / MAX_BPM) * fps);
  const hi = Math.ceil((60 / MIN_BPM) * fps);
  const ac = new Float64Array(hi + 2);
  for (let l = 0; l <= hi + 1; l++) {
    let s = 0;
    for (let t = 0; t + l < env.length; t++) s += env[t] * env[t + l];
    ac[l] = s / Math.max(1, env.length - l);
  }
  let best = lo;
  let bestScore = -Infinity;
  for (let l = lo; l <= hi; l++) {
    const bpm = (60 * fps) / l;
    const prior = Math.exp(-0.5 * Math.log2(bpm / PRIOR_BPM) ** 2);
    if (ac[l] * prior > bestScore) {
      bestScore = ac[l] * prior;
      best = l;
    }
  }
  // Refine between frames with a parabola through the peak.
  const a = ac[best - 1];
  const b = ac[best];
  const c = ac[best + 1];
  const shift = a - 2 * b + c === 0 ? 0 : (0.5 * (a - c)) / (a - 2 * b + c);
  return { period: best + Math.max(-0.5, Math.min(0.5, shift)), strength: ac[0] ? b / ac[0] : 0 };
}

/**
 * Beat times by dynamic programming (Ellis 2007): each beat sits on strong onsets while the spacing
 * stays close to the period, so slight tempo drift is followed.
 */
function trackBeats(env: Float32Array, period: number): number[] {
  const n = env.length;
  // Smooth the envelope a little around each onset.
  const sigma = period / 32;
  const radius = Math.ceil(sigma * 3);
  const local = new Float64Array(n);
  for (let t = 0; t < n; t++) {
    let s = 0;
    for (let k = -radius; k <= radius; k++) {
      const v = env[t + k];
      if (v !== undefined) s += v * Math.exp(-0.5 * (k / sigma) ** 2);
    }
    local[t] = s;
  }
  const score = new Float64Array(n);
  const back = new Int32Array(n).fill(-1);
  for (let t = 0; t < n; t++) {
    let best = 0;
    let from = -1;
    for (let p = Math.max(0, Math.round(t - 2 * period)); p <= t - Math.round(period / 2); p++) {
      const v = score[p] - TIGHTNESS * Math.log((t - p) / period) ** 2;
      if (from < 0 || v > best) {
        best = v;
        from = p;
      }
    }
    score[t] = local[t] + (from >= 0 ? Math.max(0, best) : 0);
    back[t] = from >= 0 && best > 0 ? from : -1;
  }
  // End on the best-scoring frame within the last period, then follow the links back.
  let t = n - 1;
  for (let k = Math.max(0, Math.floor(n - period)); k < n; k++) if (score[k] > score[t]) t = k;
  const beats: number[] = [];
  while (t >= 0) {
    beats.push(t);
    t = back[t];
  }
  return beats.reverse();
}

/** Tempo and beat times of a recording. */
export function detectBeats(samples: Float32Array, rate: number): Beats {
  const env = onsetEnvelope(samples, rate);
  const frameSec = frameHop(rate) / rate;
  const { period, strength } = beatPeriod(env, 1 / frameSec);
  const frames = trackBeats(env, period);
  const time = (f: number) => Math.round(onsetTime(f, rate) * 1000) / 1000;
  return { bpm: Math.round((60 / (period * frameSec)) * 10) / 10, beats: frames.map(time), strength };
}
