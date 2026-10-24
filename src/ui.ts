import type { Mode } from "./trainer";

export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export interface Prefs {
  voice: string;
  mode: Mode;
  tolerance: number;
  holdMs: number;
  rounds: number;
  headphones: boolean;
  speech: boolean;
  octaveFree: boolean;
  slide: boolean;
  /** Karaoke: what plays alongside you. */
  playInst: boolean;
  playVoice: boolean;
  playMelody: boolean;
  playOriginal: boolean;
  /** Karaoke: shift the reference melody by octaves. */
  octave: number;
  /** Karaoke: extra delay compensation in ms on top of what the browser reports. */
  latencyMs: number;
  /** Karaoke: draw the reference singer's raw pitch line. */
  showContour: boolean;
}

const PREFS_KEY = "domiso:prefs";

export const prefs: Prefs = {
  voice: "high-male",
  mode: "unison",
  tolerance: 30,
  holdMs: 1000,
  rounds: 10,
  headphones: true,
  speech: true,
  octaveFree: false,
  slide: false,
  playInst: true,
  playVoice: true,
  playMelody: false,
  playOriginal: false,
  octave: 0,
  latencyMs: 0,
  showContour: true,
  ...loadPrefs(),
};

/** Called after any preference changes through the controls below. */
export const prefsListeners: (() => void)[] = [];

function loadPrefs(): Partial<Prefs> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}");
  } catch {
    return {};
  }
}

export function savePrefs() {
  try {
    localStorage.setItem(PREFS_KEY, JSON.stringify(prefs));
  } catch {
    // Storage may be unavailable (private mode); preferences just won't persist.
  }
  prefsListeners.forEach((f) => f());
}

/** Renders a row of single-choice buttons bound to a preference. */
export function choices<K extends keyof Prefs>(
  container: HTMLElement,
  key: K,
  options: { value: Prefs[K]; label: string; sub?: string }[],
) {
  const render = () => {
    container.replaceChildren(
      ...options.map((o) => {
        const b = document.createElement("button");
        b.textContent = o.label;
        if (o.sub) {
          const s = document.createElement("small");
          s.textContent = o.sub;
          b.append(s);
        }
        b.classList.toggle("selected", prefs[key] === o.value);
        b.onclick = () => {
          prefs[key] = o.value;
          savePrefs();
        };
        return b;
      }),
    );
  };
  render();
  // The same preference can have controls on several screens; keep them all in sync.
  prefsListeners.push(render);
}

type BoolKey = { [K in keyof Prefs]: Prefs[K] extends boolean ? K : never }[keyof Prefs];

export function checkbox(key: BoolKey, el = $<HTMLInputElement>(key)) {
  el.checked = prefs[key];
  el.onchange = () => {
    prefs[key] = el.checked;
    savePrefs();
  };
  prefsListeners.push(() => (el.checked = prefs[key]));
}

export function errorText(e: unknown): string {
  console.error(e);
  return e instanceof DOMException && e.name === "NotAllowedError"
    ? "マイクの使用を許可してください。"
    : `開始できませんでした: ${e instanceof Error ? e.message : e}`;
}
