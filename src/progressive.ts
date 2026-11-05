import type { Camera, Object3D, Scene } from 'three';
import { linearToSrgb } from './color.js';
import { compileCamera, compileGeometry, compileShading, type SceneShading } from './compile.js';
import { SRGBColorSpace } from './constants.js';
import type { TileExecutor } from './executors.js';
import type { RequestMessage, ShadingPayload, TextureRef } from './protocol.js';
import type { CompiledGeometry, CompiledTexture, Tile, TraceSettings } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** One update of a progressive render. */
export interface ProgressiveFrame {
  /** RGBA, 8 bits per channel, top row first; straight (not premultiplied) alpha. */
  image: Uint8ClampedArray;
  width: number;
  height: number;
  /** Samples every pixel has received; 0 while only the preview is showing. */
  samples: number;
  maxSamples: number;
  done: boolean;
}

export interface ProgressiveOptions {
  width: number;
  height: number;
  settings: TraceSettings;
  /** three.js output colour space: 'srgb' encodes, 'srgb-linear' writes linear values. */
  outputColorSpace: string;
  /** Samples per pixel to stop at. */
  samples: number;
  /** Size of the blocks of a quick first preview; 1 or less skips it. */
  previewBlock: number;
  tileSize: number;
  filter?: (object: Object3D) => boolean;
  /** Shortest interval between frames, in milliseconds, apart from the last. */
  frameInterval: number;
  /** Keep the camera's proportions when the image's aspect differs, instead of stretching. */
  fitAspect?: boolean;
}

let nextTextureId = 1;
const textureIds = new WeakMap<object, number>();
function textureId(data: object): number {
  let id = textureIds.get(data);
  if (id === undefined) {
    id = nextTextureId++;
    textureIds.set(data, id);
  }
  return id;
}

/** A key that changes whenever a mesh's triangles, transform or culling would change. */
function geometryKey(meshes: any[]): string {
  const parts: string[] = [];
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const a = g?.attributes ?? {};
    parts.push(
      `${mesh.id}:${g?.id}:${a.position?.version}:${a.normal?.version}:${a.uv?.version}:${a.color?.version}:` +
      `${g?.index?.version}:${g?.drawRange?.start}:${g?.drawRange?.count}:${g?.groups?.length}:` +
      `${mesh.castShadow ? 1 : 0}${mesh.receiveShadow ? 1 : 0}:${(mesh.matrixWorld.elements as number[]).join(',')}`,
    );
    if (mesh.isInstancedMesh) parts.push(`i${mesh.count}:${mesh.instanceMatrix.version}`);
    if (mesh.isSkinnedMesh) parts.push(`s${Math.random()}`);
    if (mesh.morphTargetInfluences) parts.push(`m${mesh.morphTargetInfluences.join(',')}`);
    for (const m of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!m) continue;
      parts.push(`${m.id}:${m.side}:${m.transparent ? 1 : 0}:${m.alphaTest > 0 ? 1 : 0}:${m.transmission > 0 ? 1 : 0}:` +
        `${m.wireframe ? 1 : 0}:${m.visible ? 1 : 0}:${m.vertexColors ? 1 : 0}:${m.flatShading ? 1 : 0}`);
    }
  }
  return parts.join('|');
}

/**
 * Compiles scenes for a set of executors and keeps them up to date with as little copying as
 * possible: geometry is rebuilt and resent only when it changes, shading only when it changes,
 * and texture pixels are sent to each executor once.
 */
export class SceneSync {
  geometry: CompiledGeometry | null = null;
  geometryVersion = 0;
  shadingVersion = 0;
  private shading: ShadingPayload | null = null;
  private textures: CompiledTexture[] = [];
  private textureIdList: number[] = [];
  private geometryKeyValue = '';
  private shadingKey = '';
  private readonly sent = new Map<TileExecutor, { geometry: number; shading: number }>();

  /** Recompiles what changed since the last update. */
  update(scene: Scene, camera: Camera, filter?: (object: Object3D) => boolean): void {
    const { shading, meshes } = compileShading(scene, camera, filter ? { filter } : {});
    const key = geometryKey(meshes);
    const indices = new Map<any, number>(shading.materialObjects.map((material, i) => [material, i]));
    if (!this.geometry || key !== this.geometryKeyValue) {
      this.geometry = compileGeometry(meshes, material => indices.get(material) ?? 0);
      this.geometryKeyValue = key;
      this.geometryVersion++;
    }
    const payload = this.toPayload(shading);
    const shadingKey = JSON.stringify(payload);
    if (shadingKey !== this.shadingKey) {
      this.shading = payload;
      this.shadingKey = shadingKey;
      this.textures = shading.textures;
      this.shadingVersion++;
    }
  }

  private toPayload(shading: SceneShading): ShadingPayload {
    this.textureIdList = shading.textures.map(texture => textureId(texture.data));
    const textures: TextureRef[] = shading.textures.map((texture, i) => {
      const { data: _data, ...meta } = texture;
      return { ...meta, id: this.textureIdList[i]! };
    });
    return {
      materials: shading.materials,
      textures,
      environments: shading.environments,
      lights: shading.lights,
      background: shading.background,
      environment: shading.environment,
      fog: shading.fog,
    };
  }

  /** Sends an executor whatever it is missing of the current scene. */
  sync(executor: TileExecutor): void {
    let state = this.sent.get(executor);
    if (!state) {
      state = { geometry: 0, shading: 0 };
      this.sent.set(executor, state);
    }
    if (state.geometry !== this.geometryVersion && this.geometry) {
      executor.send({ type: 'geometry', version: this.geometryVersion, geometry: this.geometry });
      state.geometry = this.geometryVersion;
    }
    if (state.shading !== this.shadingVersion && this.shading) {
      const items: { id: number; data: Uint8Array | Float32Array }[] = [];
      this.textures.forEach((texture, i) => {
        const id = this.textureIdList[i]!;
        if (!executor.textures.has(id)) {
          items.push({ id, data: texture.data });
          executor.textures.add(id);
        }
      });
      if (items.length > 0) executor.send({ type: 'textures', items });
      executor.send({ type: 'shading', version: this.shadingVersion, shading: this.shading });
      state.shading = this.shadingVersion;
    }
  }

  forget(executor: TileExecutor): void {
    this.sent.delete(executor);
  }
}

/** Splits an image into tiles, ordered from the centre outwards so the middle appears first. */
export function makeTiles(width: number, height: number, size: number): Tile[] {
  const tiles: Tile[] = [];
  for (let y = 0; y < height; y += size) {
    for (let x = 0; x < width; x += size) {
      tiles.push({ x, y, width: Math.min(size, width - x), height: Math.min(size, height - y) });
    }
  }
  const cx = width / 2, cy = height / 2;
  const distance = (t: Tile) => Math.hypot(t.x + t.width / 2 - cx, t.y + t.height / 2 - cy);
  return tiles.sort((a, b) => distance(a) - distance(b));
}

/**
 * Runs progressive renders on a set of executors. Each tile gets one sample per pass; the
 * running average of a tile is written to the image as soon as the tile returns, and frames are
 * reported at most every `frameInterval` milliseconds. Starting a new render stops the old one.
 */
export class ProgressiveRenderer {
  private generation = 0;
  private job = 0;
  readonly sync = new SceneSync();

  constructor(private executors: TileExecutor[]) {}

  /** Stops the current render. Its promise resolves with false. */
  stop(): void {
    this.generation++;
  }

  /**
   * Renders `scene` from `camera`, calling `onFrame` as the image improves. Resolves with true
   * when every pixel has `samples` samples, or false if stopped or superseded first.
   */
  async render(scene: Scene, camera: Camera, options: ProgressiveOptions, onFrame: (frame: ProgressiveFrame) => void): Promise<boolean> {
    const generation = ++this.generation;
    const { width, height } = options;
    if (width <= 0 || height <= 0 || this.executors.length === 0) return false;
    this.sync.update(scene, camera, options.filter);
    const compiledCamera = compileCamera(camera, options.fitAspect ? width / height : undefined);
    const image = new Uint8ClampedArray(width * height * 4);
    const sum = new Float32Array(width * height * 4);
    const tiles = makeTiles(width, height, options.tileSize);
    const tileSamples = new Int32Array(tiles.length);
    const srgb = options.outputColorSpace === SRGBColorSpace;
    const maxSamples = Math.max(1, Math.floor(options.samples));

    // Work list: the preview, then one item per tile per pass.
    const work: { tile: number; pass: number; block: number }[] = [];
    if (options.previewBlock > 1) tiles.forEach((_, i) => work.push({ tile: i, pass: 0, block: Math.floor(options.previewBlock) }));
    for (let pass = 0; pass < maxSamples; pass++) tiles.forEach((_, i) => work.push({ tile: i, pass, block: 1 }));
    let next = 0;
    let lastFrame = 0;
    const live = () => generation === this.generation;
    const minSamples = () => {
      let min = Infinity;
      for (const s of tileSamples) min = Math.min(min, s);
      return min === Infinity ? 0 : min;
    };
    const emit = (force: boolean) => {
      const now = Date.now();
      if (!force && now - lastFrame < options.frameInterval) return;
      lastFrame = now;
      const samples = minSamples();
      onFrame({ image, width, height, samples, maxSamples, done: samples >= maxSamples });
    };

    const run = async (executor: TileExecutor): Promise<void> => {
      while (live() && next < work.length) {
        const item = work[next++]!;
        const tile = tiles[item.tile]!;
        this.sync.sync(executor);
        const message: Extract<RequestMessage, { type: 'tile' }> = {
          type: 'tile', job: ++this.job,
          geometryVersion: this.sync.geometryVersion, shadingVersion: this.sync.shadingVersion,
          camera: compiledCamera, settings: options.settings, tile, width, height, pass: item.pass, block: item.block,
        };
        let data: Float32Array;
        try {
          data = await executor.render(message);
        } catch (error) {
          if (!live()) return;
          // Give the tile back and drop this executor; the others carry on.
          work.splice(next, 0, item);
          this.executors = this.executors.filter(e => e !== executor);
          this.sync.forget(executor);
          if (this.executors.length === 0) throw error;
          return;
        }
        if (!live()) return;
        if (item.block > 1) {
          if (tileSamples[item.tile] === 0) writeTile(image, width, tile, data, null, 1, srgb);
        } else {
          tileSamples[item.tile]!++;
          writeTile(image, width, tile, data, sum, tileSamples[item.tile]!, srgb);
        }
        emit(false);
      }
    };

    const runners: Promise<void>[] = [];
    for (const executor of [...this.executors]) {
      for (let i = 0; i < executor.concurrency; i++) runners.push(run(executor));
    }
    await Promise.all(runners);
    if (!live()) return false;
    emit(true);
    return minSamples() >= maxSamples;
  }

  dispose(): void {
    this.stop();
    for (const executor of this.executors) executor.dispose();
    this.executors = [];
  }
}

/**
 * Adds a tile's samples to the running sum (when given) and writes the average into the image,
 * converting premultiplied linear RGBA to straight 8-bit RGBA in the output colour space.
 */
function writeTile(image: Uint8ClampedArray, width: number, tile: Tile, data: Float32Array,
                   sum: Float32Array | null, count: number, srgb: boolean): void {
  const scale = 1 / count;
  for (let y = 0; y < tile.height; y++) {
    for (let x = 0; x < tile.width; x++) {
      const s = (y * tile.width + x) * 4;
      const d = ((tile.y + y) * width + tile.x + x) * 4;
      let r = data[s]!, g = data[s + 1]!, b = data[s + 2]!, a = data[s + 3]!;
      if (sum) {
        r = sum[d] = sum[d]! + r; g = sum[d + 1] = sum[d + 1]! + g;
        b = sum[d + 2] = sum[d + 2]! + b; a = sum[d + 3] = sum[d + 3]! + a;
        r *= scale; g *= scale; b *= scale; a *= scale;
      }
      if (a > 0) {
        r /= a; g /= a; b /= a;
      }
      if (srgb) {
        r = linearToSrgb(Math.max(0, r)); g = linearToSrgb(Math.max(0, g)); b = linearToSrgb(Math.max(0, b));
      }
      image[d] = r * 255 + 0.5;
      image[d + 1] = g * 255 + 0.5;
      image[d + 2] = b * 255 + 0.5;
      image[d + 3] = a * 255 + 0.5;
    }
  }
}

export { writeTile as encodeTile };
