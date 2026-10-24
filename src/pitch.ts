import { PitchDetector } from "pitchy";

export interface PitchSample {
  /** AudioContext time of the sample. */
  time: number;
  /** Detected frequency in Hz, or null when no clear voice is present. */
  freq: number | null;
  clarity: number;
  rms: number;
}

const MIN_FREQ = 70;
const MAX_FREQ = 1200;

/** Classifies one analysis frame. Exported separately so it can be unit tested without a microphone. */
export function analyzeFrame(
  detector: PitchDetector<Float32Array>,
  buf: Float32Array,
  sampleRate: number,
  minClarity: number,
  minRms: number,
): { freq: number | null; clarity: number; rms: number } {
  let sum = 0;
  for (let i = 0; i < buf.length; i++) sum += buf[i] * buf[i];
  const rms = Math.sqrt(sum / buf.length);
  if (rms < minRms) return { freq: null, clarity: 0, rms };
  const [raw, clarity] = detector.findPitch(buf, sampleRate);
  if (clarity < minClarity || raw < MIN_FREQ || raw > MAX_FREQ) return { freq: null, clarity, rms };
  return { freq: fixSubharmonic(buf, sampleRate, raw), clarity, rms };
}

/** A harmonic this much weaker (dB) than the strongest one is treated as absent. */
const ABSENT_HARMONIC_DB = 25;

/**
 * Corrects the detector locking onto a multiple of the true period (reporting an octave or two too low,
 * or an octave and a fifth too low). On real singing these show up as sudden drops; the reported
 * fundamental then has next to no energy while a multiple of it carries the voice. Picks the lowest
 * multiple k·f (k = 1..4) whose energy is within ABSENT_HARMONIC_DB of the strongest one.
 */
export function fixSubharmonic(buf: Float32Array, sampleRate: number, freq: number): number {
  const powers: number[] = [];
  for (let k = 1; k <= 4 && k * freq <= MAX_FREQ; k++) powers.push(powerAt(buf, sampleRate, k * freq));
  const max = Math.max(...powers);
  const k = powers.findIndex((p) => p >= max - ABSENT_HARMONIC_DB) + 1;
  return k * freq;
}

/** Power (dB) of one frequency in a Hann-windowed frame, by the Goertzel algorithm. */
function powerAt(buf: Float32Array, sampleRate: number, freq: number): number {
  const n = buf.length;
  const coeff = 2 * Math.cos((2 * Math.PI * freq) / sampleRate);
  let s1 = 0;
  let s2 = 0;
  for (let i = 0; i < n; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const s0 = buf[i] * w + coeff * s1 - s2;
    s2 = s1;
    s1 = s0;
  }
  return 10 * Math.log10(s1 * s1 + s2 * s2 - coeff * s1 * s2 + 1e-20);
}

/** Continuously reads the microphone and emits pitch samples. */
export class PitchTracker {
  private analyser: AnalyserNode;
  private detector: PitchDetector<Float32Array>;
  private buf: Float32Array<ArrayBuffer>;
  private timer: number | undefined;
  private recent: number[] = [];
  minClarity = 0.85;
  minRms = 0.008;
  onSample: (s: PitchSample) => void = () => {};

  private constructor(
    private ctx: AudioContext,
    private stream: MediaStream,
  ) {
    const source = ctx.createMediaStreamSource(stream);
    this.analyser = ctx.createAnalyser();
    // 2048 samples at 48kHz is ~43ms, enough for the lowest male voices.
    this.analyser.fftSize = 2048;
    source.connect(this.analyser);
    this.buf = new Float32Array(this.analyser.fftSize);
    this.detector = PitchDetector.forFloat32Array(this.analyser.fftSize);
  }

  static async open(ctx: AudioContext): Promise<PitchTracker> {
    const stream = await navigator.mediaDevices.getUserMedia({
      // Browser voice processing distorts pitch, so turn all of it off.
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    return new PitchTracker(ctx, stream);
  }

  start() {
    if (this.timer !== undefined) return;
    // setInterval rather than requestAnimationFrame so detection keeps its rate regardless of rendering.
    this.timer = window.setInterval(() => this.tick(), 25);
  }

  stop() {
    window.clearInterval(this.timer);
    this.timer = undefined;
  }

  close() {
    this.stop();
    this.stream.getTracks().forEach((t) => t.stop());
  }

  private tick() {
    this.analyser.getFloatTimeDomainData(this.buf);
    const r = analyzeFrame(this.detector, this.buf, this.ctx.sampleRate, this.minClarity, this.minRms);
    let freq = r.freq;
    if (freq === null) {
      this.recent = [];
    } else {
      // Median of the last few frames suppresses single-frame octave errors.
      this.recent.push(freq);
      if (this.recent.length > 5) this.recent.shift();
      freq = median(this.recent);
    }
    this.onSample({ time: this.ctx.currentTime, freq, clarity: r.clarity, rms: r.rms });
  }
}

export function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}
