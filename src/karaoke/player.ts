import type { PitchSample } from "../pitch";
import { centsOff, freqToMidi, midiToFreq } from "../theory";
import { noteAt, type Song, type SongNote } from "./song";

/** What plays while you sing: backing track and/or reference voice, a synthesized guide tone, or nothing. */
export type Guide = "both" | "inst" | "voice" | "tone" | "none";

export interface Tracks {
  /** The reference singer (the original vocal recording, or a separated vocal track). */
  voice: AudioBuffer | null;
  /** The backing track. */
  inst: AudioBuffer | null;
}

/** With the backing track also playing, the reference voice is a guide, so it sits lower. */
const VOICE_GAIN_UNDER_INST = 0.5;

export interface PlayerOptions {
  guide: Guide;
  /** Shift of the reference melody in octaves (e.g. -1 to sing a female part an octave down). */
  octave: number;
  tolerance: number;
  octaveFree: boolean;
  /** Extra delay compensation in seconds on top of what the browser reports. */
  extraLatency: number;
}

export interface NoteStat {
  /** Samples taken while the note was due. */
  total: number;
  /** Samples within tolerance. */
  hit: number;
  /** Sum and count of deviations of samples near the note (within 1.5 semitones), for bias. */
  devSum: number;
  devCount: number;
}

export interface KaraokeResult {
  /** Duration-weighted share of time in tune, 0-100. */
  score: number;
  notesHit: number;
  notesTotal: number;
  /** Mean deviation in cents while near the note; negative means flat. */
  bias: number | null;
}

/** Reaching this share of a note's time in tune counts the note as hit. */
const NOTE_HIT_RATIO = 0.5;

/** Plays a song (or a guide tone made from its notes) and scores the singer against it. */
export class KaraokePlayer {
  /**
   * The reference notes after the octave shift, in the recording's own tuning (midi may be fractional):
   * singing along with a recording that sits 15 cents sharp shouldn't be marked 15 cents off.
   */
  readonly notes: SongNote[];
  readonly stats: NoteStat[];
  /** The singer's pitch over song time. */
  trace: { t: number; midi: number | null }[] = [];
  onEnd: () => void = () => {};

  private t0 = 0;
  private pausedAt = 0;
  private playing = false;
  private sources: AudioBufferSourceNode[] = [];
  private guideOut: GainNode | null = null;
  private scheduledUntil = 0;
  private timer: number | undefined;

  constructor(
    private ctx: AudioContext,
    readonly song: Song,
    private tracks: Tracks,
    private opts: PlayerOptions,
  ) {
    const shift = 12 * opts.octave + song.offsetCents / 100;
    this.notes = song.notes.map((n) => ({ ...n, midi: n.midi + shift }));
    this.stats = this.notes.map(() => ({ total: 0, hit: 0, devSum: 0, devCount: 0 }));
  }

  get duration(): number {
    const durations = [this.tracks.voice, this.tracks.inst].filter((b) => b !== null).map((b) => b.duration);
    return durations.length ? Math.max(...durations) : this.song.duration;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current song time in seconds, as heard by the singer. */
  get position(): number {
    return this.playing ? this.ctx.currentTime - this.t0 : this.pausedAt;
  }

  /**
   * Time between a sound leaving the speakers and the matching pitch sample arriving: output latency,
   * plus about half the analysis window, plus the user's own correction.
   */
  private get latency(): number {
    const out = (this.ctx.outputLatency || 0) + (this.ctx.baseLatency || 0);
    return out + 0.03 + this.opts.extraLatency;
  }

  play() {
    if (this.playing) return;
    if (this.pausedAt >= this.duration) this.seek(0);
    const at = this.ctx.currentTime + 0.05;
    this.t0 = at - this.pausedAt;
    this.playing = true;

    const { guide } = this.opts;
    const { voice, inst } = this.tracks;
    const wantInst = guide === "both" || guide === "inst";
    const wantVoice = guide === "both" || guide === "voice";
    if (wantInst && inst) this.startTrack(inst, at, 1);
    if (wantVoice && voice) this.startTrack(voice, at, wantInst && inst ? VOICE_GAIN_UNDER_INST : 1);
    // Without the reference voice, the guide tone carries the melody instead.
    if (guide === "tone" || (wantVoice && !voice)) {
      this.guideOut = this.ctx.createGain();
      this.guideOut.connect(this.ctx.destination);
      this.scheduledUntil = this.pausedAt;
    }
    this.timer = window.setInterval(() => this.tick(), 100);
    this.tick();
  }

  private startTrack(buffer: AudioBuffer, at: number, gain: number) {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    const g = this.ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(this.ctx.destination);
    src.start(at, this.pausedAt);
    this.sources.push(src);
  }

  pause() {
    if (!this.playing) return;
    this.pausedAt = Math.min(this.position, this.duration);
    this.playing = false;
    this.stopOutput();
  }

  seek(t: number) {
    const wasPlaying = this.playing;
    this.pause();
    this.pausedAt = Math.max(0, Math.min(t, this.duration));
    // Going back means singing that part again, so forget what was scored from there on.
    this.trace = this.trace.filter((p) => p.t < this.pausedAt);
    this.notes.forEach((n, i) => {
      if (n.end > this.pausedAt) this.stats[i] = { total: 0, hit: 0, devSum: 0, devCount: 0 };
    });
    if (wasPlaying) this.play();
  }

  stop() {
    this.pause();
  }

  private stopOutput() {
    window.clearInterval(this.timer);
    for (const src of this.sources) {
      src.stop();
      src.disconnect();
    }
    this.sources = [];
    // Disconnecting the guide bus silences every oscillator already scheduled on it.
    this.guideOut?.disconnect();
    this.guideOut = null;
  }

  private tick() {
    const pos = this.position;
    if (pos >= this.duration) {
      this.pause();
      this.pausedAt = this.duration;
      this.onEnd();
      return;
    }
    if (this.guideOut) this.scheduleGuide(pos + 1);
  }

  /** Schedules guide-tone notes starting before `until` (song time). */
  private scheduleGuide(until: number) {
    const out = this.guideOut!;
    for (const n of this.notes) {
      if (n.start < this.scheduledUntil || n.start >= until) continue;
      const at = this.t0 + n.start;
      const dur = n.end - n.start;
      const osc = this.ctx.createOscillator();
      const g = this.ctx.createGain();
      osc.type = "triangle";
      osc.frequency.value = midiToFreq(n.midi);
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(0.2, at + 0.02);
      g.gain.setValueAtTime(0.2, at + Math.max(0.02, dur - 0.04));
      g.gain.linearRampToValueAtTime(0, at + dur);
      osc.connect(g).connect(out);
      osc.start(at);
      osc.stop(at + dur + 0.02);
    }
    this.scheduledUntil = until;
  }

  handleSample(s: PitchSample) {
    if (!this.playing) return;
    const t = s.time - this.t0 - this.latency;
    if (t < 0) return;
    const i = noteAt(this.notes, t);
    let midi = s.freq === null ? null : freqToMidi(s.freq);

    if (i >= 0) {
      const target = this.notes[i].midi;
      const st = this.stats[i];
      st.total++;
      if (s.freq !== null) {
        const dev = centsOff(s.freq, target, this.opts.octaveFree);
        if (Math.abs(dev) <= this.opts.tolerance) st.hit++;
        if (Math.abs(dev) <= 150) {
          st.devSum += dev;
          st.devCount++;
        }
        // Draw the voice in the reference octave when octaves don't matter.
        if (this.opts.octaveFree) midi = target + dev / 100;
      }
    }
    this.trace.push({ t, midi });
  }

  /** Deviation in cents from the note due at song time `t`, or null. */
  deviationAt(freq: number, t: number): { note: SongNote; cents: number } | null {
    const i = noteAt(this.notes, t - this.latency);
    if (i < 0) return null;
    return { note: this.notes[i], cents: centsOff(freq, this.notes[i].midi, this.opts.octaveFree) };
  }

  result(): KaraokeResult {
    let weighted = 0;
    let totalDur = 0;
    let notesHit = 0;
    let devSum = 0;
    let devCount = 0;
    this.notes.forEach((n, i) => {
      const st = this.stats[i];
      const ratio = st.total ? st.hit / st.total : 0;
      weighted += ratio * (n.end - n.start);
      totalDur += n.end - n.start;
      if (ratio >= NOTE_HIT_RATIO) notesHit++;
      devSum += st.devSum;
      devCount += st.devCount;
    });
    return {
      score: totalDur ? Math.round((weighted / totalDur) * 100) : 0,
      notesHit,
      notesTotal: this.notes.length,
      bias: devCount >= 20 ? devSum / devCount : null,
    };
  }

  /** Share of a note's time sung in tune so far, or null if it hasn't been reached. */
  noteRatio(i: number): number | null {
    const st = this.stats[i];
    return st.total ? st.hit / st.total : null;
  }

  midiOfContour(index: number): number | null {
    const m = this.song.contour[index];
    return m === null || m === undefined ? null : m + 12 * this.opts.octave;
  }
}
