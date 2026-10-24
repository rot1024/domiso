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
  const [freq, clarity] = detector.findPitch(buf, sampleRate);
  if (clarity < minClarity || freq < MIN_FREQ || freq > MAX_FREQ) return { freq: null, clarity, rms };
  return { freq, clarity, rms };
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
