import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  ReinhardToneMapping,
} from './constants.js';

/** sRGB transfer function decode: encoded value 0..1 to linear. */
export function srgbToLinear(c: number): number {
  return c < 0.04045 ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);
}

/** sRGB transfer function encode: linear to encoded value 0..1. */
export function linearToSrgb(c: number): number {
  return c < 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 0.41666) - 0.055;
}

/** Linear values of the 256 sRGB-encoded 8-bit levels. */
export const SRGB_TO_LINEAR_8BIT = (() => {
  const table = new Float32Array(256);
  for (let i = 0; i < 256; i++) table[i] = srgbToLinear(i / 255);
  return table;
})();

/** Decodes an IEEE half float stored in a 16-bit integer. */
export function halfToFloat(h: number): number {
  const sign = h & 0x8000 ? -1 : 1;
  const exponent = (h >> 10) & 0x1f;
  const fraction = h & 0x3ff;
  if (exponent === 0) return sign * Math.pow(2, -14) * (fraction / 1024);
  if (exponent === 31) return fraction ? NaN : sign * Infinity;
  return sign * Math.pow(2, exponent - 15) * (1 + fraction / 1024);
}

function saturate(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function rrtAndOdtFit(v: number): number {
  const a = v * (v + 0.0245786) - 0.000090537;
  const b = v * (0.983729 * v + 0.432951) + 0.238081;
  return a / b;
}

function agxContrast(x: number): number {
  const x2 = x * x;
  const x4 = x2 * x2;
  return 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}

// Column-major 3 x 3 matrix times a vector, written into out.
function mul3(m: readonly number[], out: number[]): void {
  const x = out[0]!, y = out[1]!, z = out[2]!;
  out[0] = m[0]! * x + m[3]! * y + m[6]! * z;
  out[1] = m[1]! * x + m[4]! * y + m[7]! * z;
  out[2] = m[2]! * x + m[5]! * y + m[8]! * z;
}

// The matrices below are three.js's GLSL mat3 constructors, which list columns.
const ACES_INPUT = [0.59719, 0.076, 0.0284, 0.35458, 0.90834, 0.13383, 0.04823, 0.01566, 0.83777];
const ACES_OUTPUT = [1.60475, -0.10208, -0.00327, -0.53108, 1.10813, -0.07276, -0.07367, -0.00605, 1.07602];
const SRGB_TO_REC2020 = [0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.088, 0.0433, 0.0113, 0.8956];
const REC2020_TO_SRGB = [1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187];
const AGX_INSET = [
  0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591,
  0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859,
];
const AGX_OUTSET = [
  1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272,
  -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405,
];
const AGX_MIN_EV = -12.47393;
const AGX_MAX_EV = 4.026069;

/**
 * Applies a three.js tone mapping operator to a linear colour in place, matching the
 * tonemapping_pars_fragment shader chunk. NoToneMapping and CustomToneMapping leave it unchanged.
 */
export function toneMap(c: number[], mapping: number, exposure: number): void {
  switch (mapping) {
    case LinearToneMapping:
      for (let i = 0; i < 3; i++) c[i] = saturate(exposure * c[i]!);
      return;
    case ReinhardToneMapping:
      for (let i = 0; i < 3; i++) {
        const v = exposure * c[i]!;
        c[i] = saturate(v / (1 + v));
      }
      return;
    case CineonToneMapping:
      for (let i = 0; i < 3; i++) {
        const v = Math.max(0, exposure * c[i]! - 0.004);
        c[i] = Math.pow((v * (6.2 * v + 0.5)) / (v * (6.2 * v + 1.7) + 0.06), 2.2);
      }
      return;
    case ACESFilmicToneMapping:
      for (let i = 0; i < 3; i++) c[i] = (c[i]! * exposure) / 0.6;
      mul3(ACES_INPUT, c);
      for (let i = 0; i < 3; i++) c[i] = rrtAndOdtFit(c[i]!);
      mul3(ACES_OUTPUT, c);
      for (let i = 0; i < 3; i++) c[i] = saturate(c[i]!);
      return;
    case AgXToneMapping:
      for (let i = 0; i < 3; i++) c[i] = c[i]! * exposure;
      mul3(SRGB_TO_REC2020, c);
      mul3(AGX_INSET, c);
      for (let i = 0; i < 3; i++) {
        const v = (Math.log2(Math.max(c[i]!, 1e-10)) - AGX_MIN_EV) / (AGX_MAX_EV - AGX_MIN_EV);
        c[i] = agxContrast(saturate(v));
      }
      mul3(AGX_OUTSET, c);
      for (let i = 0; i < 3; i++) c[i] = Math.pow(Math.max(0, c[i]!), 2.2);
      mul3(REC2020_TO_SRGB, c);
      for (let i = 0; i < 3; i++) c[i] = saturate(c[i]!);
      return;
    case NeutralToneMapping: {
      const startCompression = 0.8 - 0.04;
      const desaturation = 0.15;
      for (let i = 0; i < 3; i++) c[i] = c[i]! * exposure;
      const x = Math.min(c[0]!, c[1]!, c[2]!);
      const offset = x < 0.08 ? x - 6.25 * x * x : 0.04;
      for (let i = 0; i < 3; i++) c[i] = c[i]! - offset;
      const peak = Math.max(c[0]!, c[1]!, c[2]!);
      if (peak < startCompression) return;
      const d = 1 - startCompression;
      const newPeak = 1 - (d * d) / (peak + d - startCompression);
      const g = 1 - 1 / (desaturation * (peak - newPeak) + 1);
      for (let i = 0; i < 3; i++) c[i] = (c[i]! * newPeak) / peak * (1 - g) + newPeak * g;
      return;
    }
    default:
      return;
  }
}
