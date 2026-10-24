import { analyze } from "./analyze";

// Typed loosely: the project compiles against the DOM lib, not the WebWorker one.
const scope = self as unknown as {
  onmessage: (e: MessageEvent<{ samples: Float32Array; sampleRate: number }>) => void;
  postMessage: (m: unknown) => void;
};

scope.onmessage = (e) => {
  const result = analyze(e.data.samples, e.data.sampleRate, (ratio) => scope.postMessage({ type: "progress", ratio }));
  scope.postMessage({ type: "done", result });
};
