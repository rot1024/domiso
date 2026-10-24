import { PitchDetector } from "pitchy";
import { describe, expect, it } from "vitest";
import { analyzeFrame, fixSubharmonic } from "../src/pitch";
import { centsOff, midiToFreq } from "../src/theory";

const SR = 48000;
const N = 2048;

/** A voice-like tone: fundamental plus decaying harmonics. */
function voice(freq: number, amp = 0.2): Float32Array {
  const buf = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    let v = 0;
    for (let h = 1; h <= 5; h++) v += Math.sin((2 * Math.PI * freq * h * i) / SR) / h;
    buf[i] = v * amp;
  }
  return buf;
}

describe("analyzeFrame", () => {
  const detector = PitchDetector.forFloat32Array(N);

  it("detects pitch within a few cents across the vocal range", () => {
    for (const midi of [43, 55, 60, 67, 72, 79]) {
      const r = analyzeFrame(detector, voice(midiToFreq(midi)), SR, 0.85, 0.008);
      expect(r.freq).not.toBeNull();
      expect(Math.abs(centsOff(r.freq!, midi))).toBeLessThan(5);
    }
  });

  it("rejects silence and noise", () => {
    expect(analyzeFrame(detector, new Float32Array(N), SR, 0.85, 0.008).freq).toBeNull();
    const noise = Float32Array.from({ length: N }, () => (Math.random() - 0.5) * 0.4);
    expect(analyzeFrame(detector, noise, SR, 0.85, 0.008).freq).toBeNull();
  });
});

describe("fixSubharmonic", () => {
  /** Harmonic tone whose fundamental is scaled by `fundGain` (to mimic a weak fundamental). */
  const tone = (freq: number, fundGain = 1) => {
    const buf = new Float32Array(N);
    for (let i = 0; i < N; i++) {
      let v = fundGain * Math.sin((2 * Math.PI * freq * i) / SR);
      for (let h = 2; h <= 5; h++) v += Math.sin((2 * Math.PI * freq * h * i) / SR) / h;
      buf[i] = v * 0.2;
    }
    return buf;
  };

  it("moves a report two octaves too low up to the sung note", () => {
    const e4 = midiToFreq(64);
    expect(centsOff(fixSubharmonic(tone(e4), SR, e4 / 4), 64)).toBeCloseTo(0, 0);
  });

  it("moves a report an octave and a fifth too low up to the sung note", () => {
    const a4 = midiToFreq(69);
    expect(centsOff(fixSubharmonic(tone(a4), SR, a4 / 3), 69)).toBeCloseTo(0, 0);
  });

  it("keeps a correct low note, even when a phone mic weakens its fundamental", () => {
    for (const midi of [40, 45, 52]) {
      const f = midiToFreq(midi);
      expect(fixSubharmonic(tone(f), SR, f)).toBe(f);
      expect(fixSubharmonic(tone(f, 0.15), SR, f)).toBe(f); // fundamental about 16 dB down
    }
  });
});
