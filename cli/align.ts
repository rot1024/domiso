import { fft } from "../src/fft";

/**
 * Finds how far `b` must be shifted to line up with `a`: a[t] ≈ b[t − lag].
 * A positive lag means b starts later in a. Cross-correlation via FFT.
 */
export function alignmentLag(a: Float32Array, b: Float32Array): { lag: number; correlation: number } {
  let n = 1;
  while (n < a.length + b.length) n <<= 1;
  const ar = new Float64Array(n), ai = new Float64Array(n);
  const br = new Float64Array(n), bi = new Float64Array(n);
  ar.set(a);
  br.set(b);
  fft(ar, ai, false);
  fft(br, bi, false);
  // A · conj(B), then back to the time domain.
  for (let i = 0; i < n; i++) {
    const re = ar[i] * br[i] + ai[i] * bi[i];
    const im = ai[i] * br[i] - ar[i] * bi[i];
    ar[i] = re;
    ai[i] = im;
  }
  fft(ar, ai, true);

  let best = 0;
  for (let i = 1; i < n; i++) if (ar[i] > ar[best]) best = i;
  const lag = best < n / 2 ? best : best - n;

  let ea = 0, eb = 0;
  for (const x of a) ea += x * x;
  for (const x of b) eb += x * x;
  return { lag, correlation: ar[best] / n / Math.sqrt(ea * eb) };
}
