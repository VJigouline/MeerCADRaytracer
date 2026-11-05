// BRDF terms written to match three.js r187's shader chunks (lights_physical_pars_fragment,
// bsdfs and common), so the ray traced image shades like the WebGL renderer's.
import { halfToFloat } from './color.js';
import { DFG_LUT_HALF, DFG_LUT_SIZE } from './dfgData.js';

export const INV_PI = 1 / Math.PI;

const DFG = (() => {
  const table = new Float32Array(DFG_LUT_HALF.length);
  for (let i = 0; i < table.length; i++) table[i] = halfToFloat(DFG_LUT_HALF[i]!);
  return table;
})();

/**
 * Samples three.js's DFG table bilinearly, as texture2D( dfgLUT, vec2( roughness, dotNV ) ) does.
 * Writes the scale into out[0] and the bias into out[1].
 */
export function dfg(roughness: number, dotNV: number, out: number[]): void {
  const n = DFG_LUT_SIZE;
  const x = Math.min(Math.max(roughness * n - 0.5, 0), n - 1);
  const y = Math.min(Math.max(dotNV * n - 0.5, 0), n - 1);
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, n - 1), y1 = Math.min(y0 + 1, n - 1);
  const fx = x - x0, fy = y - y0;
  for (let c = 0; c < 2; c++) {
    const a = DFG[(y0 * n + x0) * 2 + c]!, b = DFG[(y0 * n + x1) * 2 + c]!;
    const d = DFG[(y1 * n + x0) * 2 + c]!, e = DFG[(y1 * n + x1) * 2 + c]!;
    out[c] = (a * (1 - fx) + b * fx) * (1 - fy) + (d * (1 - fx) + e * fx) * fy;
  }
}

/** three.js's Schlick fresnel weight for f0 * (1 - w) + f90 * w. */
export function fresnelWeight(dotVH: number): number {
  return Math.pow(2, (-5.55473 * dotVH - 6.98316) * dotVH);
}

/** V_GGX_SmithCorrelated: the visibility term, with the 1 / (4 NdotL NdotV) folded in. */
export function visibilityGgx(alpha: number, dotNL: number, dotNV: number): number {
  const a2 = alpha * alpha;
  const gv = dotNL * Math.sqrt(a2 + (1 - a2) * dotNV * dotNV);
  const gl = dotNV * Math.sqrt(a2 + (1 - a2) * dotNL * dotNL);
  return 0.5 / Math.max(gv + gl, 1e-6);
}

/** D_GGX: the GGX normal distribution. */
export function distributionGgx(alpha: number, dotNH: number): number {
  const a2 = alpha * alpha;
  const denom = dotNH * dotNH * (a2 - 1) + 1;
  return (INV_PI * a2) / (denom * denom);
}

/** D_BlinnPhong times three.js's implicit geometry term of 0.25. */
export function blinnPhong(shininess: number, dotNH: number): number {
  return 0.25 * INV_PI * (shininess * 0.5 + 1) * Math.pow(dotNH, shininess);
}

/** Smoothstep as GLSL defines it, with a hard step when the edges meet. */
export function smoothstep(edge0: number, edge1: number, x: number): number {
  if (edge0 === edge1) return x < edge0 ? 0 : 1;
  const t = Math.min(Math.max((x - edge0) / (edge1 - edge0), 0), 1);
  return t * t * (3 - 2 * t);
}

/** getDistanceAttenuation: inverse power falloff, windowed to zero at the light's distance. */
export function distanceAttenuation(distance: number, cutoff: number, decay: number): number {
  let falloff = 1 / Math.max(Math.pow(distance, decay), 0.01);
  if (cutoff > 0) {
    const r = Math.min(Math.max(1 - Math.pow(distance / cutoff, 4), 0), 1);
    falloff *= r * r;
  }
  return falloff;
}
