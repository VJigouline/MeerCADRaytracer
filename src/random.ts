/** Small, fast pseudo-random generator (xorshift32), seeded per pixel and pass so renders repeat. */
export class Random {
  private state = 1;

  /** Reseeds from integers, such as pixel coordinates and the pass number. */
  seed(a: number, b: number, c: number, d: number): void {
    let h = hash(a ^ hash(b ^ hash(c ^ hash(d))));
    if (h === 0) h = 0x9e3779b9;
    this.state = h;
  }

  /** Uniform number in [0, 1). */
  next(): number {
    let x = this.state;
    x ^= x << 13;
    x ^= x >>> 17;
    x ^= x << 5;
    this.state = x >>> 0;
    return this.state / 4294967296;
  }
}

/** 32-bit integer hash (lowbias32). */
export function hash(x: number): number {
  x = (x ^ (x >>> 16)) >>> 0;
  x = Math.imul(x, 0x7feb352d) >>> 0;
  x = (x ^ (x >>> 15)) >>> 0;
  x = Math.imul(x, 0x846ca68b) >>> 0;
  x = (x ^ (x >>> 16)) >>> 0;
  return x;
}
