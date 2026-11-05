import type { Camera, Object3D, Scene } from 'three';
import { compileCamera, compileScene } from './compile.js';
import { LinearSRGBColorSpace, NoToneMapping, SRGBColorSpace } from './constants.js';
import { encodeTile } from './progressive.js';
import { Tracer } from './tracer.js';
import type { CompiledScene, RGB, TraceSettings } from './types.js';

/** Options shared by `raytrace` and `RaytracingRenderer`. */
export interface RaytraceOptions {
  /** Samples per pixel. More samples smooth edges, soft reflections and transparency. Default 16. */
  samples?: number;
  /** Times a path may bounce: reflections, refraction and indirect light. Default 4. */
  maxBounces?: number;
  /**
   * 'all' (default): every light casts shadows from every object.
   * 'castShadow': only lights and meshes with castShadow, onto meshes with receiveShadow, as three.js does.
   * 'none': no shadows.
   */
  shadows?: TraceSettings['shadows'];
  /** Light bounces off diffuse surfaces too (path tracing). Slower to converge. Default false. */
  globalIllumination?: boolean;
  /** three.js tone mapping constant. Default NoToneMapping, as for WebGLRenderer. */
  toneMapping?: number;
  toneMappingExposure?: number;
  /** 'srgb' (default) or 'srgb-linear', as WebGLRenderer.outputColorSpace. */
  outputColorSpace?: string;
  /** Linear RGB shown where nothing is hit and the scene has no background. Default black. */
  clearColor?: RGB;
  /** Alpha of the clear colour. Default 0, a transparent background. */
  clearAlpha?: number;
  /** Return false to leave an object and its children out. Helpers are always left out. */
  filter?: (object: Object3D) => boolean;
  /** Seed for the random sampling. Default 0. */
  seed?: number;
}

export interface RaytraceResult {
  width: number;
  height: number;
  /** RGBA, 8 bits per channel, top row first, straight alpha: ready for ImageData. */
  data: Uint8ClampedArray;
}

/** Fills in defaults for the settings the tracer reads. */
export function traceSettings(options: RaytraceOptions): TraceSettings {
  return {
    maxBounces: Math.max(0, Math.floor(options.maxBounces ?? 4)),
    shadows: options.shadows ?? 'all',
    globalIllumination: options.globalIllumination ?? false,
    toneMapping: options.toneMapping ?? NoToneMapping,
    toneMappingExposure: options.toneMappingExposure ?? 1,
    clearColor: options.clearColor ?? [0, 0, 0],
    clearAlpha: options.clearAlpha ?? 0,
    seed: options.seed ?? 0,
  };
}

/**
 * Ray traces a three.js scene in the calling thread and returns the image. Works in Node.js as
 * well as browsers; in Node.js, textures must be DataTextures because images can't be decoded.
 * For interactive use in a page, RaytracingRenderer renders progressively and in workers.
 */
export function raytrace(scene: Scene, camera: Camera, width: number, height: number, options: RaytraceOptions = {}): RaytraceResult {
  const compiled = compileScene(scene, camera, options.filter ? { filter: options.filter } : {});
  return raytraceCompiled(compiled, compileCamera(camera), width, height, options);
}

/** As `raytrace`, for a scene and camera already compiled with compileScene and compileCamera. */
export function raytraceCompiled(scene: CompiledScene, camera: ReturnType<typeof compileCamera>, width: number, height: number,
                                 options: RaytraceOptions = {}): RaytraceResult {
  const settings = traceSettings(options);
  const tracer = new Tracer(scene, settings);
  const samples = Math.max(1, Math.floor(options.samples ?? 16));
  const tile = { x: 0, y: 0, width, height };
  const sum = new Float32Array(width * height * 4);
  const data = new Uint8ClampedArray(width * height * 4);
  const srgb = (options.outputColorSpace ?? SRGBColorSpace) !== LinearSRGBColorSpace;
  for (let pass = 0; pass < samples; pass++) {
    encodeTile(data, width, tile, tracer.renderTile(camera, tile, width, height, pass), sum, pass + 1, srgb);
  }
  return { width, height, data };
}
