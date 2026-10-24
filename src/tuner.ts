import type { PitchSample } from "./pitch";
import { median } from "./pitch";
import { drawSemitoneGrid, prepareCanvas, solfege } from "./graph";
import { freqToMidi, midiName } from "./theory";
const GRAPH_SECONDS = 8;
/** Semitones visible above and below the center of the graph. */
const HALF_SPAN = 6;

/** Free-singing tuner: shows the nearest note and a scrolling pitch trace. */
export class Tuner {
  private history: { time: number; midi: number | null }[] = [];
  private center: number | null = null;
  private now = 0;
  private running = false;

  constructor(
    private els: { note: HTMLElement; cents: HTMLElement; needle: HTMLElement; zone: HTMLElement; canvas: HTMLCanvasElement },
    private tolerance: number,
  ) {}

  start() {
    this.history = [];
    this.center = null;
    this.els.zone.style.width = `${(this.tolerance / 100) * 50}%`;
    this.els.note.textContent = "–";
    this.els.note.classList.add("idle");
    this.els.cents.textContent = "声を出してください";
    this.els.needle.style.opacity = "0";
    this.running = true;
    requestAnimationFrame(() => this.draw());
  }

  stop() {
    this.running = false;
  }

  push(s: PitchSample) {
    this.now = s.time;
    const midi = s.freq === null ? null : freqToMidi(s.freq);
    this.history.push({ time: s.time, midi });
    while (this.history.length && s.time - this.history[0].time > GRAPH_SECONDS) this.history.shift();

    const { note, cents, needle } = this.els;
    if (midi === null) {
      // Keep the last note on screen, dimmed, so it can still be read after you stop.
      note.classList.add("idle");
      needle.style.opacity = "0";
      return;
    }
    const nearest = Math.round(midi);
    const off = (midi - nearest) * 100;
    note.textContent = solfege(nearest);
    note.classList.remove("idle");
    const rounded = Math.round(off);
    cents.textContent = `${midiName(nearest)}  ${rounded === 0 ? "±" : rounded > 0 ? "+" : "−"}${Math.abs(rounded)}¢`;
    needle.style.opacity = "1";
    needle.style.left = `${50 + off / 2}%`;
    needle.style.background = Math.abs(off) <= this.tolerance ? "var(--good)" : "var(--text)";
  }

  private draw() {
    if (!this.running) return;
    const { g, w, h, dpr } = prepareCanvas(this.els.canvas);

    // Follow the voice slowly so the grid doesn't jump with every wobble.
    const recent = this.history
      .filter((p) => p.midi !== null && this.now - p.time < 0.5)
      .map((p) => p.midi!);
    if (recent.length) {
      const c = median(recent);
      this.center = this.center === null ? c : this.center + (c - this.center) * 0.08;
    }
    const center = this.center ?? 60;
    const lo = center - HALF_SPAN;
    const y = (midi: number) => h - ((midi - lo) / (HALF_SPAN * 2)) * h;

    drawSemitoneGrid(g, w, y, lo, lo + HALF_SPAN * 2, dpr);

    // Each segment is colored by whether that moment was in tune with its nearest note.
    g.lineWidth = 3 * dpr;
    g.lineCap = "round";
    let prev: { x: number; m: number } | null = null;
    for (const p of this.history) {
      if (p.midi === null) {
        prev = null;
        continue;
      }
      const x = w - ((this.now - p.time) / GRAPH_SECONDS) * w;
      if (prev) {
        const inTune = Math.abs(p.midi - Math.round(p.midi)) * 100 <= this.tolerance;
        g.strokeStyle = inTune ? "#3ecf8e" : "#e8e9ee";
        g.beginPath();
        g.moveTo(prev.x, y(prev.m));
        g.lineTo(x, y(p.midi));
        g.stroke();
      }
      prev = { x, m: p.midi };
    }
    requestAnimationFrame(() => this.draw());
  }
}
