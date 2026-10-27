export function isPow2(n: number): boolean {
  return n > 0 && (n & (n - 1)) === 0;
}

export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      const tr = re[i] as number;
      re[i] = re[j] as number;
      re[j] = tr;
      const ti = im[i] as number;
      im[i] = im[j] as number;
      im[j] = ti;
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    const wr = Math.cos(ang);
    const wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cwr = 1;
      let cwi = 0;
      for (let j = 0; j < len / 2; j++) {
        const ur = re[i + j] as number;
        const ui = im[i + j] as number;
        const vr = re[i + j + len / 2] as number;
        const vi = im[i + j + len / 2] as number;
        const tr = vr * cwr - vi * cwi;
        const ti = vr * cwi + vi * cwr;
        re[i + j] = ur + tr;
        im[i + j] = ui + ti;
        re[i + j + len / 2] = ur - tr;
        im[i + j + len / 2] = ui - ti;
        const nwr = cwr * wr - cwi * wi;
        cwi = cwr * wi + cwi * wr;
        cwr = nwr;
      }
    }
  }
}

export function ifft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  for (let i = 0; i < n; i++) im[i] = -(im[i] as number);
  fft(re, im);
  for (let i = 0; i < n; i++) {
    re[i] = (re[i] as number) / n;
    im[i] = -(im[i] as number) / n;
  }
}

export function nextPow2(n: number): number {
  let p = 1;
  while (p < n) p <<= 1;
  return p;
}
