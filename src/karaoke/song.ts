/** A semitone-quantized note of the reference melody. Times are in seconds from the start of the audio. */
export interface SongNote {
  start: number;
  end: number;
  midi: number;
}

/** Analysis data that can be downloaded and opened again without re-analyzing. */
export interface Song {
  format: "domiso-karaoke";
  version: 1;
  title: string;
  /** File name of the audio this was made from, to warn when opened with a different file. */
  audioName: string;
  /**
   * Where song time 0 is in the `audioName` file, in seconds, when silence at its start was skipped.
   * Tracks written by the CLI are already trimmed and start at 0.
   */
  audioStart?: number;
  /** File name of the separated vocal track, when the CLI made one (played as the reference voice). */
  vocalsFile?: string;
  /** File name of the instrumental track, when there is one (played as the backing track). */
  instFile?: string;
  /** File name of the original song cut to the same timeline, when the CLI made one. */
  originalFile?: string;
  duration: number;
  /** Contour resolution in seconds. */
  hop: number;
  offsetCents: number;
  notes: SongNote[];
  /** Reference pitch (MIDI) per hop, null where there is no voice. */
  contour: (number | null)[];
}

export function serializeSong(song: Song): string {
  // One note per line keeps the file readable and diffable without bloating the contour.
  const notes = song.notes.map((n) => "    " + JSON.stringify(n)).join(",\n");
  const { notes: _n, contour, ...meta } = song;
  const head = JSON.stringify(meta, null, 2).slice(0, -2);
  return `${head},\n  "notes": [\n${notes}\n  ],\n  "contour": ${JSON.stringify(contour)}\n}\n`;
}

export function parseSong(text: string): Song {
  const d = JSON.parse(text);
  if (d?.format !== "domiso-karaoke") throw new Error("domiso の解析データではありません");
  if (d.version !== 1) throw new Error(`対応していないバージョンです (${d.version})`);
  if (!Array.isArray(d.notes) || !Array.isArray(d.contour)) throw new Error("解析データが壊れています");
  for (const k of ["vocalsFile", "instFile", "originalFile"]) {
    if (d[k] !== undefined && typeof d[k] !== "string") throw new Error("解析データが壊れています");
  }
  if (d.audioStart !== undefined && typeof d.audioStart !== "number") throw new Error("解析データが壊れています");
  for (const n of d.notes) {
    if (typeof n?.start !== "number" || typeof n?.end !== "number" || typeof n?.midi !== "number") {
      throw new Error("解析データが壊れています");
    }
  }
  return d as Song;
}

/** Index of the note sounding at `t`, or -1. Notes are sorted and non-overlapping. */
export function noteAt(notes: SongNote[], t: number): number {
  let lo = 0;
  let hi = notes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (notes[mid].end <= t) lo = mid + 1;
    else if (notes[mid].start > t) hi = mid - 1;
    else return mid;
  }
  return -1;
}
