import { midiName } from "./theory";

export const SOLFEGE = ["ド", "ド#", "レ", "レ#", "ミ", "ファ", "ファ#", "ソ", "ソ#", "ラ", "ラ#", "シ"];

export function solfege(midi: number): string {
  return SOLFEGE[((Math.round(midi) % 12) + 12) % 12];
}

/** Resizes the canvas to its CSS size at device resolution and returns a cleared context. */
export function prepareCanvas(canvas: HTMLCanvasElement): { g: CanvasRenderingContext2D; w: number; h: number; dpr: number } {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth * dpr;
  const h = canvas.clientHeight * dpr;
  if (canvas.width !== w || canvas.height !== h) {
    canvas.width = w;
    canvas.height = h;
  }
  const g = canvas.getContext("2d")!;
  g.clearRect(0, 0, w, h);
  return { g, w, h, dpr };
}

/** Horizontal line per semitone between `lo` and `hi`, labeled on natural notes, C emphasized. */
export function drawSemitoneGrid(
  g: CanvasRenderingContext2D,
  w: number,
  y: (midi: number) => number,
  lo: number,
  hi: number,
  dpr: number,
) {
  g.font = `${12 * dpr}px system-ui`;
  for (let m = Math.ceil(lo); m <= hi; m++) {
    const pc = ((m % 12) + 12) % 12;
    const natural = ![1, 3, 6, 8, 10].includes(pc);
    g.strokeStyle = pc === 0 ? "rgba(255,255,255,0.35)" : natural ? "rgba(255,255,255,0.16)" : "rgba(255,255,255,0.06)";
    g.lineWidth = dpr;
    g.beginPath();
    g.moveTo(0, y(m));
    g.lineTo(w, y(m));
    g.stroke();
    if (natural) {
      g.fillStyle = "#8b90a0";
      g.fillText(`${SOLFEGE[pc]} ${midiName(m)}`, 6 * dpr, y(m) - 3 * dpr);
    }
  }
}
