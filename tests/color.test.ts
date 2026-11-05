import { describe, expect, it } from 'vitest';
import { dfg, distributionGgx, fresnelWeight, smoothstep, distanceAttenuation } from '../src/brdf.js';
import { halfToFloat, linearToSrgb, srgbToLinear, toneMap } from '../src/color.js';
import {
  ACESFilmicToneMapping,
  AgXToneMapping,
  CineonToneMapping,
  LinearToneMapping,
  NeutralToneMapping,
  NoToneMapping,
  ReinhardToneMapping,
} from '../src/constants.js';
import { DFG_LUT_HALF } from '../src/dfgData.js';

const mapped = (value: number[], mapping: number, exposure = 1) => {
  const c = [...value];
  toneMap(c, mapping, exposure);
  return c;
};

describe('colour', () => {
  it('round-trips the sRGB transfer function', () => {
    for (const v of [0, 0.001, 0.02, 0.2, 0.5, 0.8, 1]) expect(srgbToLinear(linearToSrgb(v))).toBeCloseTo(v, 4);
    expect(linearToSrgb(0.5)).toBeCloseTo(0.7354, 3);
  });

  it('decodes half floats', () => {
    expect(halfToFloat(0x3c00)).toBe(1);
    expect(halfToFloat(0xc000)).toBe(-2);
    expect(halfToFloat(0x3800)).toBe(0.5);
    expect(halfToFloat(0x0000)).toBe(0);
  });

  it('applies the three.js tone mapping operators', () => {
    expect(mapped([1, 0.5, 4], NoToneMapping)).toEqual([1, 0.5, 4]);
    expect(mapped([0.5, 2, 0], LinearToneMapping, 1)).toEqual([0.5, 1, 0]);
    // Reinhard: x / (1 + x) after exposure.
    expect(mapped([1, 3, 0], ReinhardToneMapping)[0]).toBeCloseTo(0.5);
    expect(mapped([1, 3, 0], ReinhardToneMapping)[1]).toBeCloseTo(0.75);
    expect(mapped([1, 0, 0], ReinhardToneMapping, 3)[0]).toBeCloseTo(0.75);
    // Cineon of 0.18: hand-evaluated filmic curve.
    const x = 0.18 - 0.004;
    expect(mapped([0.18, 0.18, 0.18], CineonToneMapping)[0]).toBeCloseTo(Math.pow((x * (6.2 * x + 0.5)) / (x * (6.2 * x + 1.7) + 0.06), 2.2), 6);
    // Neutral leaves dark values alone apart from the toe offset, and compresses bright ones below 1.
    expect(mapped([0.5, 0.5, 0.5], NeutralToneMapping)[0]).toBeCloseTo(0.46, 6);
    for (const mapping of [ACESFilmicToneMapping, AgXToneMapping, NeutralToneMapping]) {
      const bright = mapped([20, 20, 20], mapping);
      const dark = mapped([0.05, 0.05, 0.05], mapping);
      expect(bright[0]).toBeLessThanOrEqual(1.000001);
      expect(bright[0]).toBeGreaterThan(dark[0]!);
      expect(dark[0]).toBeGreaterThanOrEqual(0);
    }
    // ACES keeps grey grey.
    const grey = mapped([0.3, 0.3, 0.3], ACESFilmicToneMapping);
    expect(grey[0]).toBeCloseTo(grey[1]!, 2);
    expect(grey[1]).toBeCloseTo(grey[2]!, 2);
  });
});

describe('BRDF terms', () => {
  it('reads three.js DFG table texels exactly at texel centres', () => {
    const out = [0, 0];
    // Texel (column 3, row 5) centre: roughness (3 + 0.5) / 16, dotNV (5 + 0.5) / 16.
    dfg(3.5 / 16, 5.5 / 16, out);
    expect(out[0]).toBeCloseTo(halfToFloat(DFG_LUT_HALF[(5 * 16 + 3) * 2]!), 6);
    expect(out[1]).toBeCloseTo(halfToFloat(DFG_LUT_HALF[(5 * 16 + 3) * 2 + 1]!), 6);
    // A smooth surface seen head-on reflects almost nothing extra: scale near 1, bias near 0.
    dfg(0, 1, out);
    expect(out[0]! + out[1]!).toBeGreaterThan(0.9);
  });

  it('normalises the GGX distribution over the hemisphere', () => {
    for (const alpha of [0.1, 0.5, 1]) {
      // Integrate D(h) cos(theta) over the hemisphere numerically.
      let sum = 0;
      const steps = 4000;
      for (let i = 0; i < steps; i++) {
        const theta = ((i + 0.5) / steps) * (Math.PI / 2);
        sum += distributionGgx(alpha, Math.cos(theta)) * Math.cos(theta) * Math.sin(theta) * 2 * Math.PI * (Math.PI / 2 / steps);
      }
      expect(sum).toBeCloseTo(1, 2);
    }
  });

  it('matches three.js helper functions', () => {
    expect(fresnelWeight(0)).toBe(1);
    expect(fresnelWeight(1)).toBeLessThan(0.001);
    expect(smoothstep(0, 1, 0.5)).toBe(0.5);
    expect(smoothstep(0.5, 0.5, 0.6)).toBe(1);
    expect(distanceAttenuation(2, 0, 2)).toBeCloseTo(0.25);
    expect(distanceAttenuation(0.01, 0, 2)).toBe(100);
    expect(distanceAttenuation(10, 10, 2)).toBe(0);
  });
});
