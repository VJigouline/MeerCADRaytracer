import {
  ClampToEdgeWrapping,
  CubeReflectionMapping,
  CubeRefractionMapping,
  EquirectangularReflectionMapping,
  EquirectangularRefractionMapping,
  HalfFloatType,
  MirroredRepeatWrapping,
  RedFormat,
  RGFormat,
  RGBFormat,
  SRGBColorSpace,
} from './constants.js';
import { halfToFloat, SRGB_TO_LINEAR_8BIT } from './color.js';
import type { CompiledEnvironment, CompiledTexture } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** Pixels read from an image, first row first. */
interface Pixels {
  width: number;
  height: number;
  data: Uint8Array | Float32Array;
}

const pixelCache = new WeakMap<object, { version: number; pixels: Pixels | null }>();
const warned = new Set<string>();

function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`meercad-raytracer: ${message}`);
}

/** Converts DataTexture-style data with 1 to 4 channels into RGBA. */
function expandChannels(source: ArrayLike<number>, width: number, height: number, channels: number,
                        float: boolean, half: boolean): Pixels {
  const count = width * height;
  const data = float ? new Float32Array(count * 4) : new Uint8Array(count * 4);
  for (let i = 0; i < count; i++) {
    for (let c = 0; c < 4; c++) {
      let value: number;
      if (c < channels) {
        value = source[i * channels + c]!;
        if (half) value = halfToFloat(value);
      } else value = c === 3 ? (float ? 1 : 255) : 0;
      data[i * 4 + c] = value;
    }
  }
  return { width, height, data };
}

function channelsOf(format: number): number {
  switch (format) {
    case RedFormat: return 1;
    case RGFormat: return 2;
    case RGBFormat: return 3;
    default: return 4;
  }
}

/** Reads an image's pixels without three.js: DataTexture data, or a drawable image via a canvas. */
function readImage(image: any, format: number, type: number): Pixels | null {
  if (!image) return null;
  if (image.data && image.width > 0 && image.height > 0) {
    const data = image.data;
    const channels = channelsOf(format);
    if (data instanceof Float32Array) return expandChannels(data, image.width, image.height, channels, true, false);
    if (data instanceof Uint16Array && type === HalfFloatType) {
      return expandChannels(data, image.width, image.height, channels, true, true);
    }
    if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
      if (channels === 4) return { width: image.width, height: image.height, data: new Uint8Array(data) };
      return expandChannels(data, image.width, image.height, channels, false, false);
    }
    warnOnce(`texture data of type ${data?.constructor?.name} is not supported and is ignored`);
    return null;
  }
  const width = image.naturalWidth || image.videoWidth || image.displayWidth || image.width;
  const height = image.naturalHeight || image.videoHeight || image.displayHeight || image.height;
  if (!(width > 0 && height > 0)) return null;
  if (typeof HTMLImageElement !== 'undefined' && image instanceof HTMLImageElement && !image.complete) return null;
  let context: CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null = null;
  if (typeof OffscreenCanvas !== 'undefined') {
    context = new OffscreenCanvas(width, height).getContext('2d', { willReadFrequently: true });
  } else if (typeof document !== 'undefined') {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    context = canvas.getContext('2d', { willReadFrequently: true });
  }
  if (!context) {
    warnOnce('images can only be read where a canvas is available; textures are ignored');
    return null;
  }
  try {
    context.drawImage(image, 0, 0, width, height);
    const pixels = context.getImageData(0, 0, width, height);
    return { width, height, data: new Uint8Array(pixels.data.buffer) };
  } catch (error) {
    // A cross-origin image taints the canvas, and an unloaded one can't be drawn.
    warnOnce(`a texture image could not be read (${(error as Error).message}); it is ignored`);
    return null;
  }
}

function cachedPixels(key: object, version: number, read: () => Pixels | null): Pixels | null {
  const cached = pixelCache.get(key);
  if (cached && cached.version === version) return cached.pixels;
  const pixels = read();
  pixelCache.set(key, { version, pixels });
  return pixels;
}

const IDENTITY3 = [1, 0, 0, 0, 1, 0, 0, 0, 1];

function toCompiled(texture: any, pixels: Pixels, flipY: boolean, matrix: number[]): CompiledTexture {
  return {
    width: pixels.width,
    height: pixels.height,
    data: pixels.data,
    srgb: pixels.data instanceof Uint8Array && texture.colorSpace === SRGBColorSpace,
    flipY,
    wrapS: texture.wrapS ?? ClampToEdgeWrapping,
    wrapT: texture.wrapT ?? ClampToEdgeWrapping,
    matrix,
  };
}

/**
 * Collects the textures a scene uses, so each is decoded and stored once however many
 * materials share it.
 */
export class TextureTable {
  readonly textures: CompiledTexture[] = [];
  readonly environments: CompiledEnvironment[] = [];
  private readonly textureIndex = new Map<object, number>();
  private readonly environmentIndex = new Map<string, number>();

  /** Index of a material map in `textures`, or -1 if it is absent or can't be read. */
  add(texture: any): number {
    if (!texture || !texture.isTexture || texture.isCubeTexture) return -1;
    const known = this.textureIndex.get(texture);
    if (known !== undefined) return known;
    if (texture.matrixAutoUpdate !== false && typeof texture.updateMatrix === 'function') texture.updateMatrix();
    const pixels = cachedPixels(texture, texture.version ?? 0, () => readImage(texture.image, texture.format, texture.type));
    let index = -1;
    if (pixels) {
      index = this.textures.length;
      const matrix = texture.matrix?.elements ? Array.from(texture.matrix.elements as number[]) : IDENTITY3;
      this.textures.push(toCompiled(texture, pixels, texture.flipY === true, matrix));
    } else if (texture.isRenderTargetTexture) {
      warnOnce('render target textures are not supported and are ignored');
    }
    this.textureIndex.set(texture, index);
    return index;
  }

  /**
   * Index of an environment in `environments`, or -1. Accepts cube textures and textures with
   * an equirectangular mapping, as scene.background, scene.environment and material envMaps use.
   * `rotation` is the three.js Euler applied to the lookup, such as scene.backgroundRotation.
   */
  addEnvironment(texture: any, intensity: number, rotation: any): number {
    if (!texture || !texture.isTexture) return -1;
    const matrix = eulerToMatrixTransposed(rotation);
    const key = `${texture.uuid}|${texture.version}|${intensity}|${matrix.join(',')}`;
    const known = this.environmentIndex.get(key);
    if (known !== undefined) return known;
    let environment: CompiledEnvironment | null = null;
    const mapping = texture.mapping;
    if (texture.isCubeTexture || mapping === CubeReflectionMapping || mapping === CubeRefractionMapping) {
      const images: any[] = Array.isArray(texture.image) ? texture.image : [];
      const faces: number[] = [];
      if (images.length === 6) {
        for (const image of images) {
          const pixels = cachedPixels(image, texture.version ?? 0, () =>
            readImage(image.isDataTexture ? image.image : image, texture.format, texture.type));
          if (!pixels) break;
          faces.push(this.textures.push(toCompiled(texture, pixels, false, IDENTITY3)) - 1);
        }
      }
      if (faces.length === 6) {
        environment = { kind: 'cube', faces, flipX: texture.isRenderTargetTexture !== true, rotation: matrix, intensity };
      } else {
        warnOnce('a cube texture without six readable images is ignored');
      }
    } else if (mapping === EquirectangularReflectionMapping || mapping === EquirectangularRefractionMapping) {
      const index = this.add(texture);
      if (index >= 0) environment = { kind: 'equirect', texture: index, rotation: matrix, intensity };
    } else {
      warnOnce(`environment textures with mapping ${mapping} are not supported and are ignored`);
    }
    const index = environment ? this.environments.push(environment) - 1 : -1;
    this.environmentIndex.set(key, index);
    return index;
  }
}

/**
 * The transpose (inverse) of a three.js Euler's rotation matrix, column-major, as three.js
 * builds backgroundRotation and envMapRotation. Identity when no Euler is given.
 */
function eulerToMatrixTransposed(euler: any): number[] {
  if (!euler || (euler.x === 0 && euler.y === 0 && euler.z === 0)) return IDENTITY3;
  const { x, y, z } = euler;
  const order: string = euler.order ?? 'XYZ';
  const rx = [1, 0, 0, 0, Math.cos(x), Math.sin(x), 0, -Math.sin(x), Math.cos(x)];
  const ry = [Math.cos(y), 0, -Math.sin(y), 0, 1, 0, Math.sin(y), 0, Math.cos(y)];
  const rz = [Math.cos(z), Math.sin(z), 0, -Math.sin(z), Math.cos(z), 0, 0, 0, 1];
  const byAxis: Record<string, number[]> = { X: rx, Y: ry, Z: rz };
  // Intrinsic order XYZ means the matrix Rx * Ry * Rz.
  let m = byAxis[order[0]!]!;
  m = mul3x3(m, byAxis[order[1]!]!);
  m = mul3x3(m, byAxis[order[2]!]!);
  return [m[0]!, m[3]!, m[6]!, m[1]!, m[4]!, m[7]!, m[2]!, m[5]!, m[8]!];
}

function mul3x3(a: number[], b: number[]): number[] {
  const out = new Array<number>(9);
  for (let col = 0; col < 3; col++) {
    for (let row = 0; row < 3; row++) {
      out[col * 3 + row] = a[row]! * b[col * 3]! + a[3 + row]! * b[col * 3 + 1]! + a[6 + row]! * b[col * 3 + 2]!;
    }
  }
  return out;
}

function wrap(coordinate: number, mode: number): number {
  if (mode === ClampToEdgeWrapping) return coordinate < 0 ? 0 : coordinate > 1 ? 1 : coordinate;
  if (mode === MirroredRepeatWrapping) {
    const period = coordinate - 2 * Math.floor(coordinate / 2);
    return period > 1 ? 2 - period : period;
  }
  return coordinate - Math.floor(coordinate);
}

function texelIndex(i: number, size: number, mode: number): number {
  if (mode === ClampToEdgeWrapping || mode === MirroredRepeatWrapping) return i < 0 ? 0 : i >= size ? size - 1 : i;
  return ((i % size) + size) % size;
}

/**
 * Samples a texture bilinearly at a three.js uv, after its uv transform and wrapping.
 * Writes linear RGBA into `out`.
 */
export function sampleTexture(texture: CompiledTexture, u: number, v: number, out: number[]): void {
  const m = texture.matrix;
  const tu = m[0]! * u + m[3]! * v + m[6]!;
  const tv = m[1]! * u + m[4]! * v + m[7]!;
  sampleTexel(texture, wrap(tu, texture.wrapS), wrap(tv, texture.wrapT), out);
}

/** Samples bilinearly at wrapped coordinates s, t in 0..1, where t = 0 is three.js's v = 0. */
function sampleTexel(texture: CompiledTexture, s: number, t: number, out: number[]): void {
  const w = texture.width, h = texture.height;
  const row = texture.flipY ? 1 - t : t;
  const x = s * w - 0.5, y = row * h - 0.5;
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const fx = x - x0, fy = y - y0;
  const xa = texelIndex(x0, w, texture.wrapS), xb = texelIndex(x0 + 1, w, texture.wrapS);
  const ya = texelIndex(y0, h, texture.wrapT), yb = texelIndex(y0 + 1, h, texture.wrapT);
  const data = texture.data;
  const i00 = (ya * w + xa) * 4, i10 = (ya * w + xb) * 4, i01 = (yb * w + xa) * 4, i11 = (yb * w + xb) * 4;
  const w00 = (1 - fx) * (1 - fy), w10 = fx * (1 - fy), w01 = (1 - fx) * fy, w11 = fx * fy;
  if (data instanceof Float32Array) {
    for (let c = 0; c < 4; c++) {
      out[c] = data[i00 + c]! * w00 + data[i10 + c]! * w10 + data[i01 + c]! * w01 + data[i11 + c]! * w11;
    }
    return;
  }
  const decode = texture.srgb ? SRGB_TO_LINEAR_8BIT : null;
  for (let c = 0; c < 4; c++) {
    if (decode && c < 3) {
      out[c] = decode[data[i00 + c]!]! * w00 + decode[data[i10 + c]!]! * w10 +
        decode[data[i01 + c]!]! * w01 + decode[data[i11 + c]!]! * w11;
    } else {
      out[c] = (data[i00 + c]! * w00 + data[i10 + c]! * w10 + data[i01 + c]! * w01 + data[i11 + c]! * w11) / 255;
    }
  }
}

/**
 * Looks up an environment's linear radiance in a world-space direction, as three.js samples
 * backgrounds and environment maps. Writes RGB into `out`.
 */
export function sampleEnvironment(environment: CompiledEnvironment, textures: CompiledTexture[],
                                  dx: number, dy: number, dz: number, out: number[]): void {
  const r = environment.rotation;
  let x = r[0]! * dx + r[3]! * dy + r[6]! * dz;
  const y = r[1]! * dx + r[4]! * dy + r[7]! * dz;
  const z = r[2]! * dx + r[5]! * dy + r[8]! * dz;
  if (environment.kind === 'equirect') {
    const length = Math.hypot(x, y, z) || 1;
    const u = Math.atan2(z, x) / (2 * Math.PI) + 0.5;
    const v = Math.asin(Math.max(-1, Math.min(1, y / length))) / Math.PI + 0.5;
    const texture = textures[environment.texture]!;
    sampleTexel(texture, wrap(u, texture.wrapS), Math.max(0, Math.min(1, v)), out);
  } else {
    if (environment.flipX) x = -x;
    // OpenGL cube map face selection; face images are stored first row first, which is t = 0.
    const ax = Math.abs(x), ay = Math.abs(y), az = Math.abs(z);
    let face: number, sc: number, tc: number, ma: number;
    if (ax >= ay && ax >= az) {
      face = x > 0 ? 0 : 1; ma = ax; sc = x > 0 ? -z : z; tc = -y;
    } else if (ay >= az) {
      face = y > 0 ? 2 : 3; ma = ay; sc = x; tc = y > 0 ? z : -z;
    } else {
      face = z > 0 ? 4 : 5; ma = az; sc = z > 0 ? x : -x; tc = -y;
    }
    const s = (sc / ma + 1) * 0.5, t = (tc / ma + 1) * 0.5;
    sampleTexel(textures[environment.faces[face]!]!, Math.max(0, Math.min(1, s)), Math.max(0, Math.min(1, t)), out);
  }
  out[0] = out[0]! * environment.intensity;
  out[1] = out[1]! * environment.intensity;
  out[2] = out[2]! * environment.intensity;
}
