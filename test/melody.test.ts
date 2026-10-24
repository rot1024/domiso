import { describe, expect, it } from "vitest";
import { encodeWav, renderMelody } from "../src/karaoke/melody";
import { PitchDetector } from "pitchy";

describe("renderMelody", () => {
  const SR = 22050;
  const notes = [
    { start: 0.2, end: 0.7, midi: 60 },
    { start: 1.0, end: 1.6, midi: 67 },
  ];

  it("sounds each note at its pitch and time, silent elsewhere", () => {
    const x = renderMelody(notes, SR, 2);
    expect(x.length).toBe(2 * SR);
    const det = PitchDetector.forFloat32Array(2048);
    const pitchAt = (t: number) => det.findPitch(x.subarray(Math.round(t * SR), Math.round(t * SR) + 2048), SR)[0];
    expect(pitchAt(0.35)).toBeCloseTo(261.6, 0);
    expect(pitchAt(1.2)).toBeCloseTo(392.0, 0);
    const quiet = x.subarray(Math.round(0.75 * SR), Math.round(0.95 * SR));
    expect(Math.max(...quiet.map(Math.abs))).toBe(0);
    expect(Math.max(...x.map(Math.abs))).toBeCloseTo(0.5, 2);
  });

  it("applies the tuning shift", () => {
    const x = renderMelody([{ start: 0, end: 1, midi: 69 }], SR, 1, 100);
    const det = PitchDetector.forFloat32Array(2048);
    expect(det.findPitch(x.subarray(4000, 6048), SR)[0]).toBeCloseTo(466.2, 0);
  });
});

describe("encodeWav", () => {
  it("writes a 16-bit mono WAV header and samples", () => {
    const w = encodeWav(Float32Array.from([0, 0.5, -1]), 8000);
    const v = new DataView(w.buffer);
    expect(String.fromCharCode(...w.slice(0, 4))).toBe("RIFF");
    expect(v.getUint32(24, true)).toBe(8000);
    expect(v.getUint32(40, true)).toBe(6);
    expect([v.getInt16(44, true), v.getInt16(46, true), v.getInt16(48, true)]).toEqual([0, 16384, -32767]);
  });
});
