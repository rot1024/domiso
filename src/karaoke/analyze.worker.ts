import { analyze } from "./analyze";
import { applyGrid } from "./grid";
import { detectBeats } from "./tempo";

// Typed loosely: the project compiles against the DOM lib, not the WebWorker one.
const scope = self as unknown as {
  onmessage: (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => void;
  postMessage: (m: unknown) => void;
};

scope.onmessage = (e) => {
  const { samples, sampleRate } = e.data;
  const result = analyze(samples, sampleRate, (ratio) => scope.postMessage({ type: "progress", ratio }));
  // Only the voice is at hand here; its syllables usually carry the beat well enough.
  const grid = applyGrid(result.notes, detectBeats(samples, sampleRate), samples.length / sampleRate, "16");
  scope.postMessage({ type: "done", result: grid ? { ...result, notes: grid.notes, tempo: grid.tempo } : result });
};
