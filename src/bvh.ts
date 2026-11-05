import type { CompiledBvh } from './types.js';

const BINS = 16;
const MAX_LEAF = 4;
const MAX_DEPTH = 100;
const TRAVERSAL_COST = 1;
const INTERSECT_COST = 1;

/**
 * Builds a bounding volume hierarchy over triangles with the binned surface area heuristic.
 *
 * `triangles` holds v0, e1, e2 per triangle. The result lists triangle indices in `order`;
 * each leaf covers a contiguous run of it, so callers reorder their triangle data by `order`.
 * The build is iterative, so degenerate input can't overflow the call stack.
 */
export function buildBvh(triangles: Float32Array, count: number): { bvh: CompiledBvh; order: Uint32Array } {
  // No nodes at all: a leaf with no triangles would read as an inner node pointing at itself.
  if (count === 0) return { bvh: { bounds: new Float32Array(0), nodes: new Int32Array(0), nodeCount: 0 }, order: new Uint32Array(0) };
  const order = new Uint32Array(count);
  const cx = new Float32Array(count), cy = new Float32Array(count), cz = new Float32Array(count);
  const bmin = new Float32Array(count * 3), bmax = new Float32Array(count * 3);
  for (let i = 0; i < count; i++) {
    order[i] = i;
    const o = i * 9;
    const x0 = triangles[o]!, y0 = triangles[o + 1]!, z0 = triangles[o + 2]!;
    const x1 = x0 + triangles[o + 3]!, y1 = y0 + triangles[o + 4]!, z1 = z0 + triangles[o + 5]!;
    const x2 = x0 + triangles[o + 6]!, y2 = y0 + triangles[o + 7]!, z2 = z0 + triangles[o + 8]!;
    const ax = Math.min(x0, x1, x2), ay = Math.min(y0, y1, y2), az = Math.min(z0, z1, z2);
    const bx = Math.max(x0, x1, x2), by = Math.max(y0, y1, y2), bz = Math.max(z0, z1, z2);
    bmin[i * 3] = ax; bmin[i * 3 + 1] = ay; bmin[i * 3 + 2] = az;
    bmax[i * 3] = bx; bmax[i * 3 + 1] = by; bmax[i * 3 + 2] = bz;
    cx[i] = (ax + bx) * 0.5; cy[i] = (ay + by) * 0.5; cz[i] = (az + bz) * 0.5;
  }
  const centroids = [cx, cy, cz];

  const maxNodes = Math.max(1, 2 * count - 1);
  const bounds = new Float32Array(maxNodes * 6);
  const nodes = new Int32Array(maxNodes * 3);
  let nodeCount = 1;

  // Work items: node index, first, count, depth.
  const stack: number[] = [0, 0, count, 0];

  const binCount = new Int32Array(BINS);
  const binBounds = new Float32Array(BINS * 6);
  const rightArea = new Float64Array(BINS);
  const rightCount = new Int32Array(BINS);

  while (stack.length > 0) {
    const depth = stack.pop()!;
    const n = stack.pop()!;
    const first = stack.pop()!;
    const node = stack.pop()!;

    // Bounds of the node, and of its triangles' centroids.
    let nx0 = Infinity, ny0 = Infinity, nz0 = Infinity, nx1 = -Infinity, ny1 = -Infinity, nz1 = -Infinity;
    const cmin = [Infinity, Infinity, Infinity], cmax = [-Infinity, -Infinity, -Infinity];
    for (let k = first; k < first + n; k++) {
      const t = order[k]!;
      nx0 = Math.min(nx0, bmin[t * 3]!); ny0 = Math.min(ny0, bmin[t * 3 + 1]!); nz0 = Math.min(nz0, bmin[t * 3 + 2]!);
      nx1 = Math.max(nx1, bmax[t * 3]!); ny1 = Math.max(ny1, bmax[t * 3 + 1]!); nz1 = Math.max(nz1, bmax[t * 3 + 2]!);
      for (let a = 0; a < 3; a++) {
        const c = centroids[a]![t]!;
        if (c < cmin[a]!) cmin[a] = c;
        if (c > cmax[a]!) cmax[a] = c;
      }
    }
    const b = node * 6;
    if (n === 0) {
      bounds[b] = bounds[b + 1] = bounds[b + 2] = 0;
      bounds[b + 3] = bounds[b + 4] = bounds[b + 5] = -1;
    } else {
      bounds[b] = nx0; bounds[b + 1] = ny0; bounds[b + 2] = nz0;
      bounds[b + 3] = nx1; bounds[b + 4] = ny1; bounds[b + 5] = nz1;
    }

    const makeLeaf = () => {
      nodes[node * 3] = first;
      nodes[node * 3 + 1] = n;
      nodes[node * 3 + 2] = 0;
    };
    if (n <= MAX_LEAF || depth >= MAX_DEPTH) {
      makeLeaf();
      continue;
    }

    // Find the cheapest split over all three axes.
    let bestCost = Infinity, bestAxis = -1, bestSplit = -1;
    for (let axis = 0; axis < 3; axis++) {
      const lo = cmin[axis]!, extent = cmax[axis]! - lo;
      if (!(extent > 0)) continue;
      const scale = BINS / extent;
      const cent = centroids[axis]!;
      binCount.fill(0);
      for (let i = 0; i < BINS; i++) {
        const o = i * 6;
        binBounds[o] = binBounds[o + 1] = binBounds[o + 2] = Infinity;
        binBounds[o + 3] = binBounds[o + 4] = binBounds[o + 5] = -Infinity;
      }
      for (let k = first; k < first + n; k++) {
        const t = order[k]!;
        const bin = Math.min(BINS - 1, Math.floor((cent[t]! - lo) * scale));
        binCount[bin]!++;
        const o = bin * 6;
        for (let a = 0; a < 3; a++) {
          if (bmin[t * 3 + a]! < binBounds[o + a]!) binBounds[o + a] = bmin[t * 3 + a]!;
          if (bmax[t * 3 + a]! > binBounds[o + 3 + a]!) binBounds[o + 3 + a] = bmax[t * 3 + a]!;
        }
      }
      // Sweep from the right to get the area and count right of each split.
      let rx0 = Infinity, ry0 = Infinity, rz0 = Infinity, rx1 = -Infinity, ry1 = -Infinity, rz1 = -Infinity, rc = 0;
      for (let i = BINS - 1; i > 0; i--) {
        const o = i * 6;
        rc += binCount[i]!;
        rx0 = Math.min(rx0, binBounds[o]!); ry0 = Math.min(ry0, binBounds[o + 1]!); rz0 = Math.min(rz0, binBounds[o + 2]!);
        rx1 = Math.max(rx1, binBounds[o + 3]!); ry1 = Math.max(ry1, binBounds[o + 4]!); rz1 = Math.max(rz1, binBounds[o + 5]!);
        rightCount[i] = rc;
        rightArea[i] = rc > 0 ? area(rx0, ry0, rz0, rx1, ry1, rz1) : 0;
      }
      let lx0 = Infinity, ly0 = Infinity, lz0 = Infinity, lx1 = -Infinity, ly1 = -Infinity, lz1 = -Infinity, lc = 0;
      for (let i = 0; i < BINS - 1; i++) {
        const o = i * 6;
        lc += binCount[i]!;
        lx0 = Math.min(lx0, binBounds[o]!); ly0 = Math.min(ly0, binBounds[o + 1]!); lz0 = Math.min(lz0, binBounds[o + 2]!);
        lx1 = Math.max(lx1, binBounds[o + 3]!); ly1 = Math.max(ly1, binBounds[o + 4]!); lz1 = Math.max(lz1, binBounds[o + 5]!);
        const rc2 = rightCount[i + 1]!;
        if (lc === 0 || rc2 === 0) continue;
        const cost = lc * area(lx0, ly0, lz0, lx1, ly1, lz1) + rc2 * rightArea[i + 1]!;
        if (cost < bestCost) {
          bestCost = cost;
          bestAxis = axis;
          bestSplit = i;
        }
      }
    }

    let mid: number;
    if (bestAxis >= 0) {
      const parentArea = area(nx0, ny0, nz0, nx1, ny1, nz1);
      const splitCost = TRAVERSAL_COST + (INTERSECT_COST * bestCost) / Math.max(parentArea, 1e-30);
      if (splitCost >= INTERSECT_COST * n && n <= 16) {
        makeLeaf();
        continue;
      }
      const lo = cmin[bestAxis]!, scale = BINS / (cmax[bestAxis]! - lo), cent = centroids[bestAxis]!;
      let i = first, j = first + n - 1;
      while (i <= j) {
        const bin = Math.min(BINS - 1, Math.floor((cent[order[i]!]! - lo) * scale));
        if (bin <= bestSplit) i++;
        else {
          const tmp = order[i]!;
          order[i] = order[j]!;
          order[j] = tmp;
          j--;
        }
      }
      mid = i;
    } else {
      // Every centroid is in the same place: split the run in half so the leaves stay small.
      bestAxis = 0;
      mid = first + (n >> 1);
    }
    if (mid === first || mid === first + n) mid = first + (n >> 1);

    const left = nodeCount;
    nodeCount += 2;
    nodes[node * 3] = left;
    nodes[node * 3 + 1] = 0;
    nodes[node * 3 + 2] = bestAxis;
    stack.push(left, first, mid - first, depth + 1);
    stack.push(left + 1, mid, first + n - mid, depth + 1);
  }

  return {
    bvh: { bounds: bounds.slice(0, nodeCount * 6), nodes: nodes.slice(0, nodeCount * 3), nodeCount },
    order,
  };
}

function area(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number): number {
  const dx = x1 - x0, dy = y1 - y0, dz = z1 - z0;
  return dx * dy + dy * dz + dz * dx;
}

/** Result of a closest-hit query. Reused between queries to avoid allocation. */
export class Hit {
  triangle = -1;
  t = Infinity;
  /** Barycentric weights of v1 and v2. */
  u = 0;
  v = 0;
  /** True when the ray hit the triangle's front side. */
  front = true;
}

/**
 * Finds the closest triangle a ray hits between tMin and tMax.
 *
 * With `cull` set, triangles whose `sides` entry hides the side the ray meets are ignored,
 * as three.js hides them: FrontSide hides back faces and BackSide hides front faces.
 */
export function intersectClosest(
  triangles: Float32Array,
  sides: Uint8Array,
  bvh: CompiledBvh,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMin: number, tMax: number,
  cull: boolean,
  hit: Hit,
  stack: Int32Array,
): boolean {
  hit.triangle = -1;
  hit.t = tMax;
  if (bvh.nodeCount === 0) return false;
  const bounds = bvh.bounds, nodes = bvh.nodes;
  const ix = safeInverse(dx), iy = safeInverse(dy), iz = safeInverse(dz);
  const neg = [ix < 0, iy < 0, iz < 0];
  let sp = 0;
  let node = 0;
  for (;;) {
    const n3 = node * 3;
    const count = nodes[n3 + 1]!;
    if (count > 0) {
      const first = nodes[n3]!;
      for (let k = first; k < first + count; k++) {
        const o = k * 9;
        const e1x = triangles[o + 3]!, e1y = triangles[o + 4]!, e1z = triangles[o + 5]!;
        const e2x = triangles[o + 6]!, e2y = triangles[o + 7]!, e2z = triangles[o + 8]!;
        const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
        const det = e1x * px + e1y * py + e1z * pz;
        if (det === 0) continue;
        if (cull) {
          const side = sides[k]!;
          if (side === 0 && det < 0) continue;
          if (side === 1 && det > 0) continue;
        }
        const inv = 1 / det;
        const sx = ox - triangles[o]!, sy = oy - triangles[o + 1]!, sz = oz - triangles[o + 2]!;
        const u = (sx * px + sy * py + sz * pz) * inv;
        if (u < 0 || u > 1) continue;
        const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
        const v = (dx * qx + dy * qy + dz * qz) * inv;
        if (v < 0 || u + v > 1) continue;
        const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
        if (t > tMin && t < hit.t) {
          hit.t = t;
          hit.u = u;
          hit.v = v;
          hit.triangle = k;
          hit.front = det > 0;
        }
      }
    } else {
      const left = nodes[n3]!;
      // Visit the child on the ray's near side of the split first.
      const near = neg[nodes[n3 + 2]!] ? left + 1 : left;
      const far = near === left ? left + 1 : left;
      const tn = boxEntry(bounds, near, ox, oy, oz, ix, iy, iz, tMin, hit.t);
      const tf = boxEntry(bounds, far, ox, oy, oz, ix, iy, iz, tMin, hit.t);
      if (tn < Infinity) {
        if (tf < Infinity) {
          if (tf < tn) {
            stack[sp++] = near;
            node = far;
          } else {
            stack[sp++] = far;
            node = near;
          }
        } else node = near;
        continue;
      }
      if (tf < Infinity) {
        node = far;
        continue;
      }
    }
    if (sp === 0) break;
    node = stack[--sp]!;
  }
  return hit.triangle >= 0;
}

/**
 * Calls `visit` for every triangle a ray hits between tMin and tMax, in no particular order,
 * until `visit` returns false. Used for shadow rays, which only need to know what is in the way.
 */
export function intersectAny(
  triangles: Float32Array,
  bvh: CompiledBvh,
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  tMin: number, tMax: number,
  stack: Int32Array,
  visit: (triangle: number, t: number, u: number, v: number) => boolean,
): void {
  if (bvh.nodeCount === 0) return;
  const bounds = bvh.bounds, nodes = bvh.nodes;
  const ix = safeInverse(dx), iy = safeInverse(dy), iz = safeInverse(dz);
  let sp = 0;
  stack[sp++] = 0;
  while (sp > 0) {
    const node = stack[--sp]!;
    if (boxEntry(bounds, node, ox, oy, oz, ix, iy, iz, tMin, tMax) === Infinity) continue;
    const n3 = node * 3;
    const count = nodes[n3 + 1]!;
    if (count === 0) {
      stack[sp++] = nodes[n3]!;
      stack[sp++] = nodes[n3]! + 1;
      continue;
    }
    const first = nodes[n3]!;
    for (let k = first; k < first + count; k++) {
      const o = k * 9;
      const e1x = triangles[o + 3]!, e1y = triangles[o + 4]!, e1z = triangles[o + 5]!;
      const e2x = triangles[o + 6]!, e2y = triangles[o + 7]!, e2z = triangles[o + 8]!;
      const px = dy * e2z - dz * e2y, py = dz * e2x - dx * e2z, pz = dx * e2y - dy * e2x;
      const det = e1x * px + e1y * py + e1z * pz;
      if (det === 0) continue;
      const inv = 1 / det;
      const sx = ox - triangles[o]!, sy = oy - triangles[o + 1]!, sz = oz - triangles[o + 2]!;
      const u = (sx * px + sy * py + sz * pz) * inv;
      if (u < 0 || u > 1) continue;
      const qx = sy * e1z - sz * e1y, qy = sz * e1x - sx * e1z, qz = sx * e1y - sy * e1x;
      const v = (dx * qx + dy * qy + dz * qz) * inv;
      if (v < 0 || u + v > 1) continue;
      const t = (e2x * qx + e2y * qy + e2z * qz) * inv;
      if (t > tMin && t < tMax && !visit(k, t, u, v)) return;
    }
  }
}

// A large finite inverse instead of Infinity, so a ray that starts exactly on a box face and runs
// parallel to it gives 0 * 1e30 = 0, not 0 * Infinity = NaN, and isn't wrongly missed.
function safeInverse(d: number): number {
  return d !== 0 ? 1 / d : 1e30;
}

function boxEntry(
  bounds: Float32Array, node: number,
  ox: number, oy: number, oz: number,
  ix: number, iy: number, iz: number,
  tMin: number, tMax: number,
): number {
  const b = node * 6;
  let t0 = (bounds[b]! - ox) * ix, t1 = (bounds[b + 3]! - ox) * ix;
  let lo = Math.min(t0, t1), hi = Math.max(t0, t1);
  t0 = (bounds[b + 1]! - oy) * iy; t1 = (bounds[b + 4]! - oy) * iy;
  lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  t0 = (bounds[b + 2]! - oz) * iz; t1 = (bounds[b + 5]! - oz) * iz;
  lo = Math.max(lo, Math.min(t0, t1)); hi = Math.min(hi, Math.max(t0, t1));
  // hi >= lo keeps flat boxes, such as a single plane's.
  if (hi >= lo && hi >= tMin && lo <= tMax) return Math.max(lo, tMin);
  return Infinity;
}
