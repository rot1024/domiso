import { describe, expect, it } from "vitest";
import { melodyToMidi } from "../src/karaoke/midi";

/** Minimal SMF reader: returns note-on/off events with absolute times in seconds (120 BPM, header PPQ). */
function readMidi(data: Uint8Array) {
  const ppq = (data[12] << 8) | data[13];
  let i = 22; // after MThd (14) and MTrk header (8)
  let tick = 0;
  const notes: { type: "on" | "off"; key: number; t: number }[] = [];
  const varLen = () => {
    let v = 0;
    let b;
    do {
      b = data[i++];
      v = (v << 7) | (b & 0x7f);
    } while (b & 0x80);
    return v;
  };
  while (i < data.length) {
    tick += varLen();
    const status = data[i++];
    if (status === 0xff) {
      const type = data[i++];
      const len = varLen();
      i += len;
      if (type === 0x2f) break;
    } else {
      const key = data[i++];
      i++;
      notes.push({ type: status === 0x90 ? "on" : "off", key, t: tick / (ppq * 2) });
    }
  }
  return { ppq, notes, text: String.fromCharCode(...data.slice(0, 4)) };
}

describe("melodyToMidi", () => {
  it("writes a format 0 file whose notes keep their pitches and times", () => {
    const midi = melodyToMidi(
      [
        { start: 0.5, end: 1.0, midi: 60 },
        { start: 1.0, end: 1.25, midi: 60 },
        { start: 2.0, end: 3.5, midi: 67 },
      ],
      "ドミソ",
    );
    const r = readMidi(midi);
    expect(r.text).toBe("MThd");
    expect(r.ppq).toBe(480);
    const ons = r.notes.filter((n) => n.type === "on");
    expect(ons.map((n) => n.key)).toEqual([60, 60, 67]);
    expect(ons.map((n) => n.t)).toEqual([0.5, 1.0, 2.0]);
    // A repeated key is released before it strikes again.
    const at1 = r.notes.filter((n) => n.key === 60 && Math.abs(n.t - 1.0) < 0.01);
    expect(at1.map((n) => n.type)).toEqual(["off", "on"]);
  });
});
