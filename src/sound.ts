import { CacheStorage, SplendidGrandPiano } from "smplr";
import { midiToFreq } from "./theory";

/** Piano playback, feedback sounds and speech. All timing is in AudioContext seconds. */
export class Sound {
  private piano: ReturnType<typeof SplendidGrandPiano> | null = null;
  private out: GainNode;
  speech = true;

  constructor(readonly ctx: AudioContext) {
    this.out = ctx.createGain();
    this.out.connect(ctx.destination);
  }

  /** Loads the sampled piano. Falls back to a synth tone if the samples cannot be fetched. */
  async loadPiano(notes: number[], onProgress?: (loaded: number, total: number) => void) {
    try {
      const piano = SplendidGrandPiano(this.ctx, {
        destination: this.out,
        storage: new CacheStorage(),
        notesToLoad: { notes },
        onLoadProgress: (p) => onProgress?.(p.loaded, p.total),
      });
      await piano.ready;
      this.piano = piano;
    } catch (e) {
      console.warn("piano samples unavailable, using synth", e);
    }
  }

  playNote(midi: number, at = this.ctx.currentTime, duration = 1.2, velocity = 80) {
    if (this.piano) {
      this.piano.start({ note: midi, time: at, duration, velocity });
    } else {
      this.tone(midiToFreq(midi), at, duration, 0.25, "triangle");
    }
  }

  playChord(midis: number[], at = this.ctx.currentTime, duration = 1.6) {
    for (const m of midis) this.playNote(m, at, duration, 65);
  }

  stopAll() {
    this.piano?.stop();
  }

  /** Short cue that tells the singer to start. */
  cue(at = this.ctx.currentTime) {
    this.tone(1760, at, 0.08, 0.12, "sine");
  }

  pass(at = this.ctx.currentTime) {
    this.tone(1318.5, at, 0.12, 0.15, "sine");
    this.tone(1760, at + 0.1, 0.25, 0.15, "sine");
  }

  /** Quiet, high and short so it doesn't disturb singing (and is above the pitch detector's range). */
  ping(at = this.ctx.currentTime) {
    this.tone(2637, at, 0.07, 0.06, "sine");
  }

  fail(at = this.ctx.currentTime) {
    this.tone(220, at, 0.3, 0.15, "square");
  }

  /** Plays the pitch the user sang, then the correct pitch, so they can hear the gap. */
  compare(sungFreq: number, targetMidi: number, at = this.ctx.currentTime): number {
    this.tone(sungFreq, at, 0.6, 0.22, "sine");
    this.tone(midiToFreq(targetMidi), at + 0.75, 0.6, 0.22, "sine");
    return at + 1.4;
  }

  tone(freq: number, at: number, duration: number, gain: number, type: OscillatorType) {
    const osc = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    osc.type = type;
    osc.frequency.value = freq;
    g.gain.setValueAtTime(0, at);
    g.gain.linearRampToValueAtTime(gain, at + 0.01);
    g.gain.setValueAtTime(gain, at + Math.max(0.01, duration - 0.05));
    g.gain.linearRampToValueAtTime(0, at + duration);
    osc.connect(g).connect(this.out);
    osc.start(at);
    osc.stop(at + duration + 0.02);
  }

  /** Speaks Japanese text and resolves when done (or immediately when speech is off). */
  say(text: string): Promise<void> {
    if (!this.speech || !("speechSynthesis" in window)) return Promise.resolve();
    return new Promise((resolve) => {
      const u = new SpeechSynthesisUtterance(text);
      u.lang = "ja-JP";
      u.rate = 1.2;
      u.onend = () => resolve();
      u.onerror = () => resolve();
      // Some engines never fire onend; don't let that stall the session.
      setTimeout(resolve, 600 + text.length * 250);
      speechSynthesis.speak(u);
    });
  }

  /** iOS only allows speech after it has been started inside a user gesture. */
  unlockSpeech() {
    if ("speechSynthesis" in window) speechSynthesis.speak(new SpeechSynthesisUtterance(""));
  }
}
