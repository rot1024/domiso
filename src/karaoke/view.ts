import { drawSemitoneGrid, prepareCanvas, solfege } from "../graph";
import type { KaraokePlayer } from "./player";
import { noteAt } from "./song";

/** Seconds of the past shown left of the "now" line, and of the future to its right. */
const PAST = 2.4;
const FUTURE = 5.6;
const NOW_X = PAST / (PAST + FUTURE);
const HALF_SPAN = 7;
const BAR_HEIGHT = 0.8;
/**
 * Consecutive points further apart than this (semitones) are not joined: a voice can't glide that fast,
 * so it's a detection blip (consonant, octave error) and a line would draw a misleading vertical stroke.
 */
const MAX_JUMP = 2.5;

/** Scrolling karaoke view: upcoming bars flow in from the right; your voice is drawn up to "now". */
export class KaraokeView {
  private center: number | null = null;
  private lastNow = 0;

  /** Song time under a horizontal position (0 = left edge, 1 = right edge) as last drawn. */
  timeAtX(fraction: number): number {
    return this.lastNow + (fraction - NOW_X) * (PAST + FUTURE);
  }

  constructor(
    private canvas: HTMLCanvasElement,
    private player: KaraokePlayer,
    private opts: { tolerance: number; showContour: boolean },
  ) {}

  draw() {
    const { g, w, h, dpr } = prepareCanvas(this.canvas);
    const p = this.player;
    const now = p.position;
    this.lastNow = now;
    const x = (t: number) => w * NOW_X + ((t - now) / (PAST + FUTURE)) * w;

    // Center on the melody around "now" (biased toward what's coming) and move smoothly.
    const near = p.notes.filter((n) => n.end > now - 1 && n.start < now + 4).map((n) => n.midi);
    if (near.length) {
      const c = (Math.min(...near) + Math.max(...near)) / 2;
      this.center = this.center === null ? c : this.center + (c - this.center) * 0.05;
    }
    const center = this.center ?? 60;
    const lo = center - HALF_SPAN;
    const y = (midi: number) => h - ((midi - lo) / (HALF_SPAN * 2)) * h;

    drawSemitoneGrid(g, w, y, lo, lo + HALF_SPAN * 2, dpr);

    // Bars: upcoming in blue, the current one brighter, finished ones green or red by how well they went.
    const tol = this.opts.tolerance / 100;
    p.notes.forEach((n, i) => {
      if (n.end < now - PAST || n.start > now + FUTURE) return;
      const x0 = x(n.start);
      const x1 = x(n.end);
      const ratio = p.noteRatio(i);
      const active = n.start <= now && now < n.end;
      let fill: string;
      if (n.end <= now && ratio !== null) fill = ratio >= 0.5 ? "rgba(62,207,142,0.45)" : "rgba(255,107,107,0.35)";
      else fill = active ? "rgba(91,140,255,0.75)" : "rgba(91,140,255,0.4)";
      g.fillStyle = fill;
      const top = y(n.midi + BAR_HEIGHT / 2);
      roundRect(g, x0, top, Math.max(2 * dpr, x1 - x0), y(n.midi - BAR_HEIGHT / 2) - top, 4 * dpr);
      g.fill();
      // A faint band shows how far off still counts as in tune.
      if (active) {
        g.fillStyle = "rgba(62,207,142,0.12)";
        g.fillRect(x0, y(n.midi + tol), x1 - x0, y(n.midi - tol) - y(n.midi + tol));
      }
      if (x1 - x0 > 22 * dpr) {
        g.fillStyle = "rgba(255,255,255,0.85)";
        g.font = `${11 * dpr}px system-ui`;
        g.fillText(solfege(n.midi), x0 + 4 * dpr, top - 3 * dpr);
      }
    });

    if (this.opts.showContour) {
      const hop = p.song.hop;
      const from = Math.max(0, Math.floor((now - PAST) / hop));
      const to = Math.min(p.song.contour.length, Math.ceil((now + FUTURE) / hop));
      g.strokeStyle = "rgba(255,255,255,0.28)";
      g.lineWidth = 1.5 * dpr;
      g.beginPath();
      let last: number | null = null;
      for (let i = from; i < to; i++) {
        const m = p.midiOfContour(i);
        if (m !== null && last !== null && Math.abs(m - last) <= MAX_JUMP) g.lineTo(x(i * hop), y(m));
        else if (m !== null) g.moveTo(x(i * hop), y(m));
        last = m;
      }
      g.stroke();
    }

    // Your voice, colored per segment by whether it was in tune with the bar due at that moment.
    g.lineWidth = 3 * dpr;
    g.lineCap = "round";
    let prev: { t: number; m: number } | null = null;
    for (const s of p.trace) {
      if (s.t < now - PAST || s.midi === null) {
        prev = null;
        continue;
      }
      if (prev && s.t - prev.t < 0.1 && Math.abs(s.midi - prev.m) <= MAX_JUMP) {
        const i = noteAt(p.notes, s.t);
        const inTune = i >= 0 && Math.abs(s.midi - p.notes[i].midi) <= tol;
        g.strokeStyle = inTune ? "#3ecf8e" : "#e8e9ee";
        g.beginPath();
        g.moveTo(x(prev.t), y(prev.m));
        g.lineTo(x(s.t), y(s.midi));
        g.stroke();
      }
      prev = { t: s.t, m: s.midi };
    }

    g.strokeStyle = "rgba(255,255,255,0.6)";
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    g.moveTo(w * NOW_X, 0);
    g.lineTo(w * NOW_X, h);
    g.stroke();
  }
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.roundRect(x, y, w, h, rr);
}
