import { describe, expect, it } from "vitest";
import { alignmentLag } from "../cli/align";

/** Deterministic noise so the correlation peak is unambiguous. */
function noise(n: number, seed = 1) {
  const out = new Float32Array(n);
  let s = seed;
  for (let i = 0; i < n; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out[i] = s / 0x7fffffff - 0.5;
  }
  return out;
}

describe("alignmentLag", () => {
  const inst = noise(20000);

  it("finds an instrumental that starts later in the song", () => {
    const song = new Float32Array(20500);
    song.set(inst, 500);
    for (let i = 0; i < song.length; i++) song[i] += 0.3 * Math.sin(i / 7); // the "vocal"
    const r = alignmentLag(song, inst);
    expect(r.lag).toBe(500);
    expect(r.correlation).toBeGreaterThan(0.8);
  });

  it("finds an instrumental with extra lead-in", () => {
    const song = inst.slice(300);
    expect(alignmentLag(song, inst).lag).toBe(-300);
  });
});
