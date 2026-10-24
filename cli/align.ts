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

/** In-place iterative radix-2 FFT. `inverse` computes the unscaled inverse transform. */
export function fft(re: Float64Array, im: Float64Array, inverse: boolean) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = ((inverse ? 2 : -2) * Math.PI) / len;
    const wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const ur = re[i + k], ui = im[i + k];
        const xr = re[i + k + len / 2], xi = im[i + k + len / 2];
        const vr = xr * cr - xi * ci, vi = xr * ci + xi * cr;
        re[i + k] = ur + vr;
        im[i + k] = ui + vi;
        re[i + k + len / 2] = ur - vr;
        im[i + k + len / 2] = ui - vi;
        const t = cr * wr - ci * wi;
        ci = cr * wi + ci * wr;
        cr = t;
      }
    }
  }
}
