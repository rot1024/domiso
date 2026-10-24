import type { Analysis } from "./analyze";

/** Analysis doesn't need more bandwidth than this, and a lower rate keeps long songs light on phones. */
export const ANALYSIS_RATE = 22050;

/** Decodes audio straight to mono at the analysis rate. */
export async function decodeForAnalysis(data: ArrayBuffer): Promise<{ samples: Float32Array; duration: number }> {
  const ctx = new OfflineAudioContext(1, 1, ANALYSIS_RATE);
  const buf = await ctx.decodeAudioData(data.slice(0));
  const samples = new Float32Array(buf.length);
  for (let c = 0; c < buf.numberOfChannels; c++) {
    const ch = buf.getChannelData(c);
    for (let i = 0; i < ch.length; i++) samples[i] += ch[i] / buf.numberOfChannels;
  }
  return { samples, duration: buf.duration };
}

export interface AnalysisJob {
  promise: Promise<Analysis>;
  cancel: () => void;
}

/** Runs the analysis off the main thread so the page stays responsive. */
export function analyzeInWorker(samples: Float32Array, onProgress: (ratio: number) => void): AnalysisJob {
  const worker = new Worker(new URL("./analyze.worker.ts", import.meta.url), { type: "module" });
  let cancel = () => {};
  const promise = new Promise<Analysis>((resolve, reject) => {
    cancel = () => {
      worker.terminate();
      reject(new Error("cancelled"));
    };
    worker.onmessage = (e) => {
      if (e.data.type === "progress") onProgress(e.data.ratio);
      else {
        worker.terminate();
        resolve(e.data.result);
      }
    };
    worker.onerror = (e) => {
      worker.terminate();
      reject(new Error(e.message));
    };
    worker.postMessage({ samples, sampleRate: ANALYSIS_RATE }, [samples.buffer]);
  });
  return { promise, cancel };
}
