// Music theory helpers: pitch math, chords, voice presets and exercise generation.

export const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

export function midiToFreq(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function freqToMidi(freq: number): number {
  return 69 + 12 * Math.log2(freq / 440);
}

export function midiName(midi: number): string {
  const m = Math.round(midi);
  return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1);
}

/** Deviation of `freq` from `targetMidi` in cents. With `octaveFree`, folds into [-600, 600). */
export function centsOff(freq: number, targetMidi: number, octaveFree = false): number {
  const cents = (freqToMidi(freq) - targetMidi) * 100;
  if (!octaveFree) return cents;
  return ((((cents + 600) % 1200) + 1200) % 1200) - 600;
}

export type ChordQuality = "maj" | "min" | "dim";

const INTERVALS: Record<ChordQuality, [number, number, number]> = {
  maj: [0, 4, 7],
  min: [0, 3, 7],
  dim: [0, 3, 6],
};

export interface Chord {
  /** Pitch class of the root relative to the key (0-11). */
  root: number;
  quality: ChordQuality;
}

export function chordName(chord: Chord, keyPc = 0): string {
  const name = NOTE_NAMES[(chord.root + keyPc) % 12];
  return name + (chord.quality === "min" ? "m" : chord.quality === "dim" ? "dim" : "");
}

/** Japanese reading of a chord name for speech synthesis (e.g. "Am" -> "エーマイナー"). */
export function chordReading(chord: Chord, keyPc = 0): string {
  const readings = ["シー", "シーシャープ", "ディー", "イーフラット", "イー", "エフ", "エフシャープ", "ジー", "エーフラット", "エー", "ビーフラット", "ビー"];
  const suffix = chord.quality === "min" ? "マイナー" : chord.quality === "dim" ? "ディミニッシュ" : "";
  return readings[(chord.root + keyPc) % 12] + suffix;
}

export interface VoicePreset {
  id: string;
  label: string;
  /** MIDI note of "do" for the home key. Chord roots are placed within [home-6, home+5]. */
  home: number;
}

export const VOICE_PRESETS: VoicePreset[] = [
  { id: "high-female", label: "女声・高め", home: 72 }, // C5
  { id: "low-female", label: "女声・低め", home: 67 }, // G4
  { id: "high-male", label: "男声・高め", home: 60 }, // C4
  { id: "low-male", label: "男声・低め", home: 55 }, // G3
];

/** MIDI notes of the triad (root, 3rd, 5th), voiced to stay near the preset's range. */
export function chordTones(chord: Chord, home: number): [number, number, number] {
  let root = home + chord.root;
  if (root > home + 5) root -= 12;
  const [a, b, c] = INTERVALS[chord.quality];
  return [root + a, root + b, root + c];
}

export type Progression = "fixed" | "diatonic" | "random";

const DIATONIC: Chord[] = [
  { root: 0, quality: "maj" },
  { root: 5, quality: "maj" },
  { root: 7, quality: "maj" },
  { root: 0, quality: "maj" },
  { root: 9, quality: "min" },
  { root: 2, quality: "min" },
  { root: 7, quality: "maj" },
  { root: 4, quality: "min" },
];

export function nextChord(progression: Progression, index: number, rand = Math.random): Chord {
  switch (progression) {
    case "fixed":
      return { root: 0, quality: "maj" };
    case "diatonic":
      return DIATONIC[index % DIATONIC.length];
    case "random": {
      const qualities: ChordQuality[] = ["maj", "maj", "min", "min", "dim"];
      return { root: Math.floor(rand() * 12), quality: qualities[Math.floor(rand() * qualities.length)] };
    }
  }
}

/** What is sung over each chord: the triad (ドミソ) or the first five scale steps (ドレミファソ). */
export type Pattern = "triad" | "five";

/** The five steps above the root for each chord quality: major, natural minor, and minor with a flat 5th. */
const FIVE: Record<ChordQuality, number[]> = {
  maj: [0, 2, 4, 5, 7],
  min: [0, 2, 3, 5, 7],
  dim: [0, 2, 3, 5, 6],
};

/** MIDI notes to sing over the chord, low to high, voiced like chordTones. */
export function patternTones(chord: Chord, home: number, pattern: Pattern): number[] {
  if (pattern === "triad") return chordTones(chord, home);
  const root = chordTones(chord, home)[0];
  return FIVE[chord.quality].map((i) => root + i);
}

/** Movable-do names of the pattern's notes. */
export function patternLabels(pattern: Pattern): string[] {
  return pattern === "triad" ? ["ド", "ミ", "ソ"] : ["ド", "レ", "ミ", "ファ", "ソ"];
}

export type Order = "updown" | "up" | "random";

/** Indices into the pattern's notes (0 = root) in singing order. */
export function noteOrder(order: Order, count = 3, rand = Math.random): number[] {
  const up = Array.from({ length: count }, (_, i) => i);
  switch (order) {
    case "updown":
      // Up and back down: ドミソミド, ドレミファソファミレド.
      return [...up, ...up.slice(0, -1).reverse()];
    case "up":
      return up;
    case "random": {
      const a = [...up];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  }
}

