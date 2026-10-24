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

export type Order = "updown" | "up" | "random";

/** Indices into the triad (0=root, 1=3rd, 2=5th) in singing order. */
export function noteOrder(order: Order, rand = Math.random): number[] {
  switch (order) {
    case "updown":
      return [0, 1, 2, 1, 0];
    case "up":
      return [0, 1, 2];
    case "random": {
      const a = [0, 1, 2];
      for (let i = a.length - 1; i > 0; i--) {
        const j = Math.floor(rand() * (i + 1));
        [a[i], a[j]] = [a[j], a[i]];
      }
      return a;
    }
  }
}

export const DEGREE_LABELS = ["ド", "ミ", "ソ"];
