import { describe, expect, it } from "vitest";
import { detectKeys, doOf, keyAt, keyName, notesDo, solfa, syllable } from "../src/karaoke/key";
import type { Song, SongNote } from "../src/karaoke/song";

/**
 * A melody walking the scale of `tonic` (major or natural minor): phrases of seven 0.4 s notes and a
 * long tonic, then a rest.
 */
function melody(tonic: number, minor: boolean, seconds: number, from = 0, seed = 1): SongNote[] {
  const steps = minor ? [0, 2, 3, 5, 7, 8, 10] : [0, 2, 4, 5, 7, 9, 11];
  let r = seed;
  const rand = () => (r = (r * 16807) % 2147483647) / 2147483647;
  const notes: SongNote[] = [];
  let deg = 0;
  for (let t = from, i = 0; t < from + seconds - 0.01; i++) {
    const end = i % 8 === 7;
    deg = end ? 0 : Math.max(-3, Math.min(8, deg + Math.floor(rand() * 5) - 2));
    const midi = 60 + tonic + steps[((deg % 7) + 7) % 7] + 12 * Math.floor(deg / 7);
    const len = end ? 0.8 : 0.4;
    notes.push({ start: t, end: t + len - 0.02, midi });
    t += len + (end ? 0.6 : 0);
  }
  return notes;
}

describe("detectKeys", () => {
  it("finds a major key", () => {
    const k = detectKeys(melody(3, false, 40));
    expect(k).toHaveLength(1);
    expect(keyName(k[0])).toBe("E♭");
  });

  it("finds a minor key and puts do on its relative major", () => {
    const k = detectKeys(melody(9, true, 40));
    expect(k).toHaveLength(1);
    expect(keyName(k[0])).toBe("Am");
    expect(doOf(k[0])).toBe(0);
  });

  it("follows a key change up a semitone or a tone", () => {
    for (const up of [1, 2]) {
      const notes = [...melody(0, false, 60), ...melody(up, false, 30, 60, 7)];
      const k = detectKeys(notes);
      expect(k.map(keyName)).toEqual(["C", keyName({ tonic: up, mode: "major" })]);
      expect(Math.abs(k[1].start - 60)).toBeLessThan(4);
    }
  });

  it("is not moved by a few accidentals", () => {
    const notes = melody(7, false, 60);
    for (const i of [10, 30, 31, 70]) notes[i].midi += 1;
    expect(detectKeys(notes).map(keyName)).toEqual(["G"]);
  });
});

describe("movable do", () => {
  it("names notes from do, spelling altered notes", () => {
    expect(solfa(63, 3)).toBe("ド");
    expect(solfa(65, 3)).toBe("レ");
    expect(solfa(68, 0)).toBe("ソ♯");
    expect(solfa(70, 0)).toBe("シ♭");
    expect(syllable(70, 0)).toBe("si");
    expect(syllable(61, 0)).toBe("do");
  });

  it("uses the hand-set keys over detection, and C for fixed do", () => {
    const notes = melody(0, false, 20);
    const song = { notes, keys: [{ start: 0, tonic: 0, mode: "major" }, { start: 10, tonic: 2, mode: "major" }] } as Song;
    const dos = notesDo(song, false);
    expect(dos[0]).toBe(0);
    expect(dos.at(-1)).toBe(2);
    expect(notesDo(song, true).every((d) => d === 0)).toBe(true);
    expect(keyAt(song.keys!, 9.99).tonic).toBe(0);
  });
});
