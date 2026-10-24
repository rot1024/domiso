import { PitchDetector } from "pitchy";
import { describe, expect, it } from "vitest";
import { analyzeFrame } from "../src/pitch";
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
