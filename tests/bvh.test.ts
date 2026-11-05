import { describe, expect, it } from 'vitest';
import { buildBvh, Hit, intersectAny, intersectClosest } from '../src/bvh.js';

function randomTriangles(count: number, seed: number): Float32Array {
  let s = seed;
  const rand = () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
  const data = new Float32Array(count * 9);
  for (let i = 0; i < count; i++) {
    const cx = rand() * 20 - 10, cy = rand() * 20 - 10, cz = rand() * 20 - 10;
    const v = [0, 1, 2].map(() => [cx + rand() * 2 - 1, cy + rand() * 2 - 1, cz + rand() * 2 - 1]);
    data.set(v[0]!, i * 9);
    data.set([v[1]![0]! - v[0]![0]!, v[1]![1]! - v[0]![1]!, v[1]![2]! - v[0]![2]!], i * 9 + 3);
    data.set([v[2]![0]! - v[0]![0]!, v[2]![1]! - v[0]![1]!, v[2]![2]! - v[0]![2]!], i * 9 + 6);
  }
  return data;
}

function reorder(data: Float32Array, order: Uint32Array): Float32Array {
  const out = new Float32Array(data.length);
  order.forEach((source, i) => out.set(data.subarray(source * 9, source * 9 + 9), i * 9));
  return out;
}

// Brute-force Möller-Trumbore over every triangle, for comparison.
function bruteForce(data: Float32Array, o: number[], d: number[]): { t: number; tri: number; all: number } {
  let best = Infinity, tri = -1, all = 0;
  for (let k = 0; k < data.length / 9; k++) {
    const b = k * 9;
    const e1 = [data[b + 3]!, data[b + 4]!, data[b + 5]!], e2 = [data[b + 6]!, data[b + 7]!, data[b + 8]!];
    const p = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
    const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
    if (det === 0) continue;
    const s = [o[0]! - data[b]!, o[1]! - data[b + 1]!, o[2]! - data[b + 2]!];
    const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) / det;
    if (u < 0 || u > 1) continue;
    const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
    const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) / det;
    if (v < 0 || u + v > 1) continue;
    const t = (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) / det;
    if (t > 0) {
      all++;
      if (t < best) {
        best = t;
        tri = k;
      }
    }
  }
  return { t: best, tri, all };
}

describe('BVH', () => {
  const count = 3000;
  const raw = randomTriangles(count, 7);
  const { bvh, order } = buildBvh(raw, count);
  const data = reorder(raw, order);
  const sides = new Uint8Array(count).fill(2);
  const stack = new Int32Array(256);

  it('keeps every triangle exactly once, in leaves whose bounds contain them', () => {
    expect([...order].sort((a, b) => a - b)).toEqual([...Array(count).keys()]);
    let covered = 0;
    for (let n = 0; n < bvh.nodeCount; n++) {
      const first = bvh.nodes[n * 3]!, c = bvh.nodes[n * 3 + 1]!;
      if (c === 0) continue;
      covered += c;
      for (let k = first; k < first + c; k++) {
        for (let v = 0; v < 3; v++) {
          for (let a = 0; a < 3; a++) {
            const x = data[k * 9 + a]! + (v > 0 ? data[k * 9 + v * 3 + a]! : 0);
            expect(x).toBeGreaterThanOrEqual(bvh.bounds[n * 6 + a]! - 1e-4);
            expect(x).toBeLessThanOrEqual(bvh.bounds[n * 6 + 3 + a]! + 1e-4);
          }
        }
      }
    }
    expect(covered).toBe(count);
  });

  it('finds the same closest hit and the same set of hits as brute force', () => {
    const hit = new Hit();
    let hits = 0;
    for (let i = 0; i < 400; i++) {
      const o = [Math.sin(i) * 30, Math.cos(i * 1.3) * 30, Math.sin(i * 0.7) * 30];
      const target = [Math.sin(i * 2.1) * 8, Math.cos(i * 0.4) * 8, Math.sin(i * 1.7) * 8];
      const d = target.map((t, a) => t - o[a]!);
      const length = Math.hypot(d[0]!, d[1]!, d[2]!);
      const dir = d.map(x => x / length);
      const expected = bruteForce(data, o, dir);
      const found = intersectClosest(data, sides, bvh, o[0]!, o[1]!, o[2]!, dir[0]!, dir[1]!, dir[2]!, 0, Infinity, true, hit, stack);
      expect(found).toBe(expected.tri >= 0);
      if (found) {
        hits++;
        expect(hit.t).toBeCloseTo(expected.t, 3);
        expect(hit.triangle).toBe(expected.tri);
      }
      let all = 0;
      intersectAny(data, bvh, o[0]!, o[1]!, o[2]!, dir[0]!, dir[1]!, dir[2]!, 0, Infinity, stack, () => {
        all++;
        return true;
      });
      expect(all).toBe(expected.all);
    }
    expect(hits).toBeGreaterThan(100);
  });

  it('culls back faces for FrontSide and front faces for BackSide', () => {
    // One triangle in z = 0 whose front faces +z (counter-clockwise seen from +z).
    const tri = new Float32Array([-1, -1, 0, 2, 0, 0, 0, 2, 0]);
    const built = buildBvh(tri, 1);
    const hit = new Hit();
    const fromFront = (side: number) => intersectClosest(tri, new Uint8Array([side]), built.bvh, 0, 0, 5, 0, 0, -1, 0, Infinity, true, hit, stack);
    const fromBack = (side: number) => intersectClosest(tri, new Uint8Array([side]), built.bvh, 0, 0, -5, 0, 0, 1, 0, Infinity, true, hit, stack);
    expect(fromFront(0)).toBe(true);
    expect(hit.front).toBe(true);
    expect(fromBack(0)).toBe(false);
    expect(fromFront(1)).toBe(false);
    expect(fromBack(1)).toBe(true);
    expect(hit.front).toBe(false);
    expect(fromFront(2) && fromBack(2)).toBe(true);
  });

  it('hits a flat, axis-aligned box from a ray running along its face', () => {
    // Two triangles making a square in z = 0, hit by rays parallel to z starting on x = -1, the box edge.
    const quad = new Float32Array([-1, -1, 0, 2, 0, 0, 2, 2, 0, -1, -1, 0, 2, 2, 0, 0, 2, 0]);
    const built = buildBvh(quad, 2);
    const ordered = reorder(quad, built.order);
    const hit = new Hit();
    expect(intersectClosest(ordered, new Uint8Array(2).fill(2), built.bvh, -1, 0, 3, 0, 0, -1, 0, Infinity, true, hit, stack)).toBe(true);
    expect(hit.t).toBeCloseTo(3);
  });

  it('builds for coincident triangles without running away', () => {
    const same = new Float32Array(9 * 500);
    for (let i = 0; i < 500; i++) same.set([0, 0, 0, 1, 0, 0, 0, 1, 0], i * 9);
    const built = buildBvh(same, 500);
    expect(built.bvh.nodeCount).toBeGreaterThan(1);
    const hit = new Hit();
    expect(intersectClosest(same, new Uint8Array(500).fill(2), built.bvh, 0.2, 0.2, 1, 0, 0, -1, 0, Infinity, true, hit, stack)).toBe(true);
  });

  it('handles an empty scene', () => {
    const built = buildBvh(new Float32Array(0), 0);
    const hit = new Hit();
    expect(intersectClosest(new Float32Array(0), new Uint8Array(0), built.bvh, 0, 0, 0, 0, 0, 1, 0, Infinity, true, hit, stack)).toBe(false);
  });
});
