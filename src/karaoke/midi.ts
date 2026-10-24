import type { SongNote } from "./song";

/** Ticks per quarter note. At the fixed 120 BPM this makes 960 ticks per second. */
const PPQ = 480;
const TICKS_PER_SEC = PPQ * 2;

/**
 * Encodes the melody as a Standard MIDI File (format 0, 120 BPM), so the guide melody can be used in
 * a DAW or another player. Times keep the original seconds; pitches are the semitone bars.
 */
export function melodyToMidi(notes: SongNote[], title: string): Uint8Array<ArrayBuffer> {
  const events: { tick: number; bytes: number[] }[] = [];
  const name = [...new TextEncoder().encode(title)];
  events.push({ tick: 0, bytes: [0xff, 0x03, ...varLen(name.length), ...name] });
  events.push({ tick: 0, bytes: [0xff, 0x51, 0x03, 0x07, 0xa1, 0x20] }); // 500000 µs per quarter = 120 BPM
  for (const n of notes) {
    const key = Math.max(0, Math.min(127, Math.round(n.midi)));
    const on = Math.round(n.start * TICKS_PER_SEC);
    // Never let a note end at or after the next one starts on the same key, or players cut it oddly.
    const off = Math.max(on + 1, Math.round(n.end * TICKS_PER_SEC) - 1);
    events.push({ tick: on, bytes: [0x90, key, 90] });
    events.push({ tick: off, bytes: [0x80, key, 0] });
  }
  // Note-offs sort before note-ons at the same tick.
  events.sort((a, b) => a.tick - b.tick || (a.bytes[0] === 0x80 ? -1 : 0) - (b.bytes[0] === 0x80 ? -1 : 0));
  const last = events.length ? events[events.length - 1].tick : 0;
  events.push({ tick: last, bytes: [0xff, 0x2f, 0x00] });

  const track: number[] = [];
  let prev = 0;
  for (const e of events) {
    track.push(...varLen(e.tick - prev), ...e.bytes);
    prev = e.tick;
  }
  const header = [0x4d, 0x54, 0x68, 0x64, 0, 0, 0, 6, 0, 0, 0, 1, PPQ >> 8, PPQ & 0xff];
  const trackHeader = [0x4d, 0x54, 0x72, 0x6b, ...u32(track.length)];
  return Uint8Array.from([...header, ...trackHeader, ...track]);
}

function varLen(n: number): number[] {
  const out = [n & 0x7f];
  while ((n >>= 7) > 0) out.unshift((n & 0x7f) | 0x80);
  return out;
}

function u32(n: number): number[] {
  return [(n >>> 24) & 0xff, (n >>> 16) & 0xff, (n >>> 8) & 0xff, n & 0xff];
}
