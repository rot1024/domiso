import type { PitchSample } from "../pitch";
import { centsOff, freqToMidi, midiToFreq } from "../theory";
import { MELODY_ATTACK, MELODY_PARTIALS, melodyRelease } from "./melody";
import { noteAt, type Song, type SongNote } from "./song";

/** What plays while you sing; any combination. */
export interface Playback {
  /** The backing track. */
  inst: boolean;
  /** The reference singer's recording. */
  voice: boolean;
  /** A synthesized guide melody played from the bars. */
  melody: boolean;
  /** The original song (vocals and backing together). */
  original: boolean;
  /** Your own recorded take (replay). */
  mine?: boolean;
  /** Put your take on the left and the reference voice on the right, to hear the difference. */
  split?: boolean;
}

/**
 * Audio elements rather than decoded buffers: they change speed while keeping pitch (preservesPitch),
 * and long songs don't have to be decoded into memory.
 */
export interface Tracks {
  /** The reference singer (the original vocal recording, or a separated vocal track). */
  voice: HTMLAudioElement | null;
  /** Where song time 0 is in the voice file, when silence at its start was skipped. */
  voiceOffset: number;
  /** The backing track. */
  inst: HTMLAudioElement | null;
  /** The original song, on the same timeline. */
  original: HTMLAudioElement | null;
  /** Your own take rendered onto the song timeline (replay only). */
  mine?: HTMLAudioElement | null;
  /** Where song time 0 is in the take, to fine-tune its alignment. */
  mineOffset?: number;
  /** Song seconds per second of the take (the speed it was sung at). */
  mineSpeed?: number;
}

/** One pitch sample of the singer, for recording a take: song time, raw MIDI pitch, AudioContext time. */
export interface SungPoint {
  t: number;
  midi: number | null;
  ctxTime: number;
}

interface ActiveTrack {
  el: HTMLAudioElement;
  /** Where song time 0 is in this element's media. */
  offset: number;
  /** Media seconds per song second (1 except for a take sung at another speed). */
  rate: number;
  gain: GainNode;
  kind: "original" | "inst" | "voice" | "mine";
}

/** Elements further than this from the master clock are moved back in line. */
const RESYNC_SEC = 0.06;
export const MIN_SPEED = 0.5;
export const MAX_SPEED = 1.5;

/** With the backing track also playing, the reference voice is a guide, so it sits lower. */
const VOICE_GAIN_UNDER_INST = 0.5;
const MELODY_GAIN = 0.22;

export interface PlayerOptions {
  play: Playback;
  /** Shift of the reference melody in octaves (e.g. -1 to sing a female part an octave down). */
  octave: number;
  tolerance: number;
  octaveFree: boolean;
  /** Extra delay compensation in seconds on top of what the browser reports. */
  extraLatency: number;
  /** Playback speed; 1 is normal. Pitch stays the same. */
  speed: number;
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
  /** Called for every scored pitch sample (raw pitch, before any octave folding). */
  onPoint: (p: SungPoint) => void = () => {};
  /** End of the range being played by playRange, and what to do there. */
  private range: { end: number; done: () => void } | null = null;

  /** Song time `pos` was at AudioContext time `ctx`; position runs on from there at `speed`. */
  private anchor = { ctx: 0, pos: 0 };
  private pausedAt = 0;
  private playing = false;
  private speedValue: number;
  /** Tracks that play this session; the first is the master clock. */
  private active: ActiveTrack[] = [];
  private melodyOut: GainNode | null = null;
  private melodyOn: boolean;
  private scheduledUntil = 0;
  private timer: number | undefined;

  constructor(
    private ctx: AudioContext,
    readonly song: Song,
    tracks: Tracks,
    private opts: PlayerOptions,
  ) {
    const shift = 12 * opts.octave + song.offsetCents / 100;
    this.notes = song.notes.map((n) => ({ ...n, midi: n.midi + shift }));
    this.stats = this.notes.map(() => ({ total: 0, hit: 0, devSum: 0, devCount: 0 }));
    this.speedValue = opts.speed;

    const { play } = opts;
    // The original already contains backing and voice, so it replaces them.
    const originalOn = play.original && !!tracks.original;
    const instOn = play.inst && !!tracks.inst && !originalOn;
    const voiceOn = play.voice && !!tracks.voice && !originalOn;
    const split = !!play.split;
    if (originalOn) this.addTrack("original", tracks.original!, 0, 1, split ? 1 : 0);
    if (instOn) this.addTrack("inst", tracks.inst!, 0, 1);
    if (voiceOn) this.addTrack("voice", tracks.voice!, tracks.voiceOffset, instOn ? VOICE_GAIN_UNDER_INST : 1, split ? 1 : 0);
    if (play.mine && tracks.mine) {
      this.addTrack("mine", tracks.mine, tracks.mineOffset ?? 0, 1, split ? -1 : 0, 1 / (tracks.mineSpeed ?? 1));
    }
    // Without the reference recording, the guide melody carries the tune instead.
    this.melodyOn = play.melody || (play.voice && !tracks.voice && !originalOn);
  }

  private addTrack(kind: ActiveTrack["kind"], el: HTMLAudioElement, offset: number, gain: number, pan = 0, rate = 1) {
    // Routed through a gain node: element.volume is read-only on iOS.
    const g = this.ctx.createGain();
    g.gain.value = gain;
    const p = this.ctx.createStereoPanner();
    p.pan.value = pan;
    this.ctx.createMediaElementSource(el).connect(g).connect(p).connect(this.ctx.destination);
    el.preservesPitch = true;
    this.active.push({ el, offset, rate, gain: g, kind });
  }

  /**
   * Turns backing, reference voice and guide melody on or off without rebuilding: the tracks keep
   * running (muted), so playback can start again without a tap on iOS. Only tracks the player was
   * built with can be turned on.
   */
  setMix(mix: { voice: boolean; inst: boolean; melody: boolean }) {
    const instOn = mix.inst && this.active.some((t) => t.kind === "inst");
    for (const t of this.active) {
      if (t.kind === "inst") t.gain.gain.value = mix.inst ? 1 : 0;
      if (t.kind === "voice") t.gain.gain.value = mix.voice ? (instOn ? VOICE_GAIN_UNDER_INST : 1) : 0;
    }
    const wasOn = this.melodyOn;
    this.melodyOn = mix.melody || (mix.voice && !this.active.some((t) => t.kind === "voice"));
    if (this.playing && this.melodyOn && !wasOn) this.startMelody();
    if (this.playing && !this.melodyOn && wasOn) {
      this.melodyOut?.disconnect();
      this.melodyOut = null;
    }
  }

  get speed(): number {
    return this.speedValue;
  }

  /** Changes the speed during playback; the guide melody is rescheduled to match. */
  set speed(v: number) {
    const s = Math.max(MIN_SPEED, Math.min(MAX_SPEED, v));
    if (this.playing) this.anchor = { ctx: this.ctx.currentTime, pos: this.position };
    this.speedValue = s;
    for (const t of this.active) t.el.playbackRate = s * t.rate;
    if (this.playing && this.melodyOut) {
      this.startMelody();
      this.tick();
    }
  }

  get duration(): number {
    return this.song.duration;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Current song time in seconds, as heard by the singer. */
  get position(): number {
    if (!this.playing) return this.pausedAt;
    return Math.min(this.duration, this.anchor.pos + (this.ctx.currentTime - this.anchor.ctx) * this.speedValue);
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
    this.playing = true;
    this.anchor = { ctx: this.ctx.currentTime, pos: this.pausedAt };
    for (const t of this.active) {
      t.el.playbackRate = this.speedValue * t.rate;
      t.el.currentTime = t.offset + this.pausedAt * t.rate;
      void t.el.play();
    }
    if (this.melodyOn) this.startMelody();
    this.timer = window.setInterval(() => this.tick(), 100);
    this.tick();
  }

  /** (Re)creates the melody bus; anything already scheduled on the old one goes silent with it. */
  private startMelody() {
    this.melodyOut?.disconnect();
    this.melodyOut = this.ctx.createGain();
    this.melodyOut.gain.value = MELODY_GAIN;
    this.melodyOut.connect(this.ctx.destination);
    this.scheduledUntil = this.position;
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
    this.range = null;
    this.pause();
  }

  /**
   * Plays song time [from, to) and calls `done` at the end (paused there). Scores inside the range are
   * cleared first, so each attempt is scored on its own.
   */
  playRange(from: number, to: number, done: () => void) {
    this.pause();
    this.range = null;
    this.clearScores(from, to);
    this.pausedAt = Math.max(0, Math.min(from, this.duration));
    this.range = { end: Math.min(to, this.duration), done };
    this.play();
  }

  /** Forgets scores and sung pitch inside [from, to). */
  clearScores(from: number, to: number) {
    this.trace = this.trace.filter((p) => p.t < from || p.t >= to);
    this.notes.forEach((n, i) => {
      if (n.end > from && n.start < to) this.stats[i] = { total: 0, hit: 0, devSum: 0, devCount: 0 };
    });
  }

  private stopOutput() {
    window.clearInterval(this.timer);
    for (const t of this.active) t.el.pause();
    // Disconnecting the melody bus silences every oscillator already scheduled on it.
    this.melodyOut?.disconnect();
    this.melodyOut = null;
  }

  private tick() {
    this.syncToMedia();
    const pos = this.position;
    if (this.range && pos >= this.range.end) {
      const { end, done } = this.range;
      this.range = null;
      this.pause();
      this.pausedAt = end;
      done();
      return;
    }
    if (pos >= this.duration) {
      this.pause();
      this.pausedAt = this.duration;
      this.onEnd();
      return;
    }
    if (this.melodyOut) this.scheduleMelody(pos + 1);
  }

  /**
   * Keeps the clock on the master track (media clocks drift, and playback takes a moment to start: the
   * bars wait for it) and pulls the other tracks back in line when they wander.
   */
  private syncToMedia() {
    const master = this.active[0];
    if (!master || !this.playing) return;
    const songPos = (t: ActiveTrack) => (t.el.currentTime - t.offset) / t.rate;
    const mediaPos = songPos(master);
    if (Math.abs(mediaPos - this.position) > 0.03) this.anchor = { ctx: this.ctx.currentTime, pos: mediaPos };
    for (const t of this.active.slice(1)) {
      if (Math.abs(songPos(t) - mediaPos) > RESYNC_SEC) t.el.currentTime = t.offset + mediaPos * t.rate;
    }
  }

  /** AudioContext time at which song time `pos` will be heard, at the current speed. */
  private ctxTimeOf(pos: number): number {
    return this.ctx.currentTime + (pos - this.position) / this.speedValue;
  }

  /**
   * Schedules guide-melody notes starting before `until` (song time). A soft flute-like tone (sine plus a
   * quiet octave) stays clear on top of a band without sounding like the singer.
   */
  private scheduleMelody(until: number) {
    const out = this.melodyOut!;
    for (const n of this.notes) {
      if (n.start < this.scheduledUntil || n.start >= until) continue;
      const at = Math.max(this.ctx.currentTime, this.ctxTimeOf(n.start));
      const end = this.ctxTimeOf(n.end);
      if (end <= at) continue;
      const release = melodyRelease(end - at);
      const g = this.ctx.createGain();
      g.gain.setValueAtTime(0, at);
      g.gain.linearRampToValueAtTime(1, at + MELODY_ATTACK);
      g.gain.setValueAtTime(1, end - release);
      g.gain.linearRampToValueAtTime(0, end);
      g.connect(out);
      for (const [mult, level] of MELODY_PARTIALS) {
        const osc = this.ctx.createOscillator();
        osc.frequency.value = midiToFreq(n.midi) * mult;
        const lv = this.ctx.createGain();
        lv.gain.value = level;
        osc.connect(lv).connect(g);
        osc.start(at);
        osc.stop(end + 0.02);
      }
    }
    this.scheduledUntil = until;
  }

  handleSample(s: PitchSample) {
    if (!this.playing) return;
    // The sample was heard `latency` seconds of real time before it arrived; at speed s that is s times as
    // much song time.
    const t = this.position - (this.ctx.currentTime - s.time + this.latency) * this.speedValue;
    if (t < 0) return;
    this.onPoint({ t, midi: s.freq === null ? null : freqToMidi(s.freq), ctxTime: s.time });
    this.score(t, s.freq);
  }

  /** Scores one pitch sample at song time `t` and adds it to the trace. */
  private score(t: number, freq: number | null) {
    const i = noteAt(this.notes, t);
    let midi = freq === null ? null : freqToMidi(freq);
    if (i >= 0) {
      const target = this.notes[i].midi;
      const st = this.stats[i];
      st.total++;
      if (freq !== null) {
        const dev = centsOff(freq, target, this.opts.octaveFree);
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

  /** Replays a recorded take's pitch through the scoring, for replay mode. */
  loadTrace(points: { t: number; midi: number | null }[]) {
    this.trace = [];
    this.stats.forEach((_, i) => (this.stats[i] = { total: 0, hit: 0, devSum: 0, devCount: 0 }));
    for (const p of points) this.score(p.t, p.midi === null ? null : midiToFreq(p.midi));
  }

  /** Duration-weighted share in tune (0-100) of the notes inside [from, to), or null if none were sung. */
  rangeScore(from: number, to: number): number | null {
    let weighted = 0;
    let total = 0;
    let any = false;
    this.notes.forEach((n, i) => {
      if (n.start < from || n.start >= to) return;
      const st = this.stats[i];
      if (st.total) any = true;
      weighted += (st.total ? st.hit / st.total : 0) * (n.end - n.start);
      total += n.end - n.start;
    });
    return any && total ? Math.round((weighted / total) * 100) : null;
  }

  /** The note in [from, to) sung worst, with its mean deviation in cents (null if never near it). */
  worstNote(from: number, to: number): { index: number; ratio: number; bias: number | null } | null {
    let worst: { index: number; ratio: number; bias: number | null } | null = null;
    this.notes.forEach((n, i) => {
      if (n.start < from || n.start >= to) return;
      const st = this.stats[i];
      const ratio = st.total ? st.hit / st.total : 0;
      if (!worst || ratio < worst.ratio) worst = { index: i, ratio, bias: st.devCount ? st.devSum / st.devCount : null };
    });
    return worst;
  }

  /** Deviation in cents from the note due at song time `t`, or null. */
  deviationAt(freq: number, t: number): { note: SongNote; cents: number } | null {
    const i = noteAt(this.notes, t - this.latency * this.speedValue);
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
