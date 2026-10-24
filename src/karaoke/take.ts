import { encodeWav } from "./melody";
import type { Song } from "./song";

/** One pitch sample of a take: song time, raw MIDI pitch (null = silence), time in the recording. */
export interface TakePoint {
  t: number;
  m: number | null;
  r: number;
}

/** A sung take: the recording plus the pitch you sang, both tied to the song's timeline. */
export interface Take {
  id: string;
  /** Which song it belongs to (see songKey). */
  songKey: string;
  title: string;
  created: string;
  mime: string;
  audio: Blob;
  points: TakePoint[];
  score: number;
}

/** Identifies a song across sessions: the same analysis gives the same key. */
export function songKey(song: Song): string {
  return `${song.title}|${song.duration.toFixed(1)}|${song.notes.length}`;
}

/**
 * How the recording lines up with the song. A take is sung at one speed `speed` (song seconds per
 * recording second); the recording is laid on a "take timeline" u = song time / speed, so it plays
 * unstretched when the song runs at that speed. Each run is a stretch played straight through, with
 * u = r + offset. Pauses, seeks and parts sung at another speed break runs; those parts' audio is left
 * out (it would need stretching), but their pitch is still kept in `points`.
 */
export function timelineRuns(points: TakePoint[]): { speed: number; runs: { r0: number; r1: number; offset: number }[] } {
  const ratios: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const dr = points[i].r - points[i - 1].r;
    if (dr > 0 && dr < 0.2) ratios.push((points[i].t - points[i - 1].t) / dr);
  }
  const sorted = ratios.filter((x) => x > 0.3 && x < 2).sort((a, b) => a - b);
  // The speed most of the take was sung at, snapped to the 0.05 steps the player offers.
  const speed = sorted.length ? Math.round(sorted[sorted.length >> 1] * 20) / 20 : 1;
  const runs: { r0: number; r1: number; offset: number }[] = [];
  let cur: { r0: number; r1: number; offsets: number[] } | null = null;
  const close = () => {
    if (cur && cur.r1 - cur.r0 > 0.2) {
      const o = [...cur.offsets].sort((a, b) => a - b)[cur.offsets.length >> 1];
      runs.push({ r0: cur.r0, r1: cur.r1, offset: o });
    }
    cur = null;
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dr = b.r - a.r;
    const dt = b.t - a.t;
    const straight = dr > 0 && dr < 0.2 && Math.abs(dt / dr - speed) < 0.1 * speed;
    if (!straight) {
      close();
      continue;
    }
    const off = (p: TakePoint) => p.t / speed - p.r;
    if (cur && Math.abs(off(b) - cur.offsets[0]) > 0.08) close();
    cur ??= { r0: a.r, r1: a.r, offsets: [off(a)] };
    cur.r1 = b.r;
    cur.offsets.push(off(b));
  }
  close();
  return { speed, runs };
}

const ENV_STEP = 0.01;

/**
 * How much later (seconds) the voice is in the recording than the points' recording times say.
 * MediaRecorder reports its start late by a device-dependent amount, so the recording's loudness is
 * matched against where the pitch detector heard a voice, within ±1 s.
 */
export function recordingLag(samples: Float32Array, rate: number, points: TakePoint[]): number {
  const hop = Math.round(rate * ENV_STEP);
  const frames = Math.floor(samples.length / hop);
  const env = new Float64Array(frames);
  for (let f = 0; f < frames; f++) {
    let s = 0;
    for (let i = f * hop; i < (f + 1) * hop; i++) s += samples[i] * samples[i];
    env[f] = Math.log10(s / hop + 1e-10);
  }
  const voiced = new Float64Array(frames);
  for (const p of points) {
    if (p.m === null) continue;
    const f = Math.round(p.r / ENV_STEP);
    for (let k = f; k < f + 3 && k < frames; k++) if (k >= 0) voiced[k] = 1;
  }
  const norm = (x: Float64Array) => {
    let mean = 0;
    for (const v of x) mean += v / x.length;
    let sd = 0;
    for (const v of x) sd += (v - mean) ** 2 / x.length;
    sd = Math.sqrt(sd) || 1;
    return x.map((v) => (v - mean) / sd);
  };
  const a = norm(env);
  const b = norm(voiced);
  const max = Math.round(1 / ENV_STEP);
  let best = -Infinity;
  let lag = 0;
  for (let l = -max; l <= max; l++) {
    let s = 0;
    for (let f = Math.max(0, -l); f < frames && f + l < frames; f++) s += b[f] * a[f + l];
    if (s > best) {
      best = s;
      lag = l;
    }
  }
  return lag * ENV_STEP;
}

/**
 * Lays the recording onto the take timeline (see timelineRuns; silence elsewhere) as a mono WAV, for replay.
 * `speed` is what the take was sung at: one second of the WAV is `speed` seconds of song.
 */
export async function takeOnTimeline(
  take: Take,
  ctx: BaseAudioContext,
  duration: number,
): Promise<{ wav: Blob; speed: number }> {
  const decoded = await ctx.decodeAudioData(await take.audio.arrayBuffer());
  const rate = decoded.sampleRate;
  const src = new Float32Array(decoded.length);
  for (let c = 0; c < decoded.numberOfChannels; c++) {
    const ch = decoded.getChannelData(c);
    for (let i = 0; i < ch.length; i++) src[i] += ch[i] / decoded.numberOfChannels;
  }
  const { speed, runs } = timelineRuns(take.points);
  const lag = recordingLag(src, rate, take.points);
  const out = new Float32Array(Math.ceil((duration / speed) * rate));
  for (const run of runs) {
    const from = Math.max(0, Math.round((run.r0 + lag) * rate));
    const to = Math.min(src.length, Math.round((run.r1 + lag) * rate));
    const shift = Math.round((run.offset - lag) * rate);
    for (let i = from; i < to; i++) {
      const j = i + shift;
      if (j >= 0 && j < out.length) out[j] = src[i];
    }
  }
  return { wav: new Blob([encodeWav(out, rate)], { type: "audio/wav" }), speed };
}

/** File extension for a recording's MIME type. */
export function audioExtension(mime: string): string {
  if (mime.includes("mp4") || mime.includes("aac")) return "m4a";
  if (mime.includes("ogg")) return "ogg";
  return "webm";
}

/** Metadata saved next to a downloaded take's audio, so it can be opened again later. */
export interface TakeFile {
  format: "domiso-take";
  version: 1;
  songKey: string;
  title: string;
  created: string;
  audioFile: string;
  mime: string;
  score: number;
  points: TakePoint[];
}

export function takeFileName(take: Take): string {
  return `${take.title}.take-${take.created.replace(/[-:]/g, "").replace(/\..*/, "").replace("T", "-")}`;
}

export function serializeTake(take: Take): { json: string; audioFile: string } {
  const base = takeFileName(take);
  const audioFile = `${base}.${audioExtension(take.mime)}`;
  // Pitch rounded to 0.01 semitone and times to 1 ms keep the file small.
  const points = take.points.map((p) => ({
    t: Math.round(p.t * 1000) / 1000,
    m: p.m === null ? null : Math.round(p.m * 100) / 100,
    r: Math.round(p.r * 1000) / 1000,
  }));
  const file: TakeFile = {
    format: "domiso-take",
    version: 1,
    songKey: take.songKey,
    title: take.title,
    created: take.created,
    audioFile,
    mime: take.mime,
    score: take.score,
    points,
  };
  return { json: JSON.stringify(file), audioFile };
}

export function parseTakeFile(text: string): TakeFile | null {
  try {
    const d = JSON.parse(text);
    return d?.format === "domiso-take" && d.version === 1 && Array.isArray(d.points) ? (d as TakeFile) : null;
  } catch {
    return null;
  }
}
