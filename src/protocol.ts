import { Tracer } from './tracer.js';
import type {
  CompiledBackground,
  CompiledCamera,
  CompiledEnvironment,
  CompiledFog,
  CompiledGeometry,
  CompiledLight,
  CompiledMaterial,
  CompiledTexture,
  Tile,
  TraceSettings,
} from './types.js';

/** A texture without its pixels, which travel separately and only once. */
export type TextureRef = Omit<CompiledTexture, 'data'> & { id: number };

/** Everything in a compiled scene apart from geometry and texture pixels. */
export interface ShadingPayload {
  materials: CompiledMaterial[];
  textures: TextureRef[];
  environments: CompiledEnvironment[];
  lights: CompiledLight[];
  background: CompiledBackground;
  environment: number;
  fog: CompiledFog | null;
}

export type RequestMessage =
  | { type: 'geometry'; version: number; geometry: CompiledGeometry }
  | { type: 'textures'; items: { id: number; data: Uint8Array | Float32Array }[] }
  | { type: 'shading'; version: number; shading: ShadingPayload }
  | {
      type: 'tile';
      job: number;
      geometryVersion: number;
      shadingVersion: number;
      camera: CompiledCamera;
      settings: TraceSettings;
      tile: Tile;
      width: number;
      height: number;
      pass: number;
      block: number;
    };

export type ResponseMessage =
  | { type: 'tile'; job: number; data: Float32Array }
  | { type: 'error'; job: number; message: string };

/**
 * The renderer's side of a worker: keeps the latest geometry, shading and texture pixels it was
 * sent, and renders tiles with them. Runs inside a Web Worker, or in the page when there are none.
 */
export function createTileHandler(): (message: RequestMessage) => ResponseMessage | null {
  let geometry: { version: number; value: CompiledGeometry } | null = null;
  let shading: { version: number; value: ShadingPayload } | null = null;
  const pixels = new Map<number, Uint8Array | Float32Array>();
  let tracer: Tracer | null = null;
  let tracerKey = '';

  return message => {
    switch (message.type) {
      case 'geometry':
        geometry = { version: message.version, value: message.geometry };
        tracer = null;
        return null;
      case 'textures':
        for (const item of message.items) pixels.set(item.id, item.data);
        return null;
      case 'shading':
        shading = { version: message.version, value: message.shading };
        tracer = null;
        return null;
      case 'tile': {
        try {
          if (!geometry || geometry.version !== message.geometryVersion || !shading || shading.version !== message.shadingVersion) {
            throw new Error('the tile refers to a scene this worker has not received');
          }
          const key = JSON.stringify(message.settings);
          if (!tracer || key !== tracerKey) {
            const textures: CompiledTexture[] = shading.value.textures.map(ref => {
              const data = pixels.get(ref.id);
              if (!data) throw new Error(`texture ${ref.id} was not sent`);
              const { id: _id, ...meta } = ref;
              return { ...meta, data };
            });
            tracer = new Tracer({
              geometry: geometry.value,
              materials: shading.value.materials,
              textures,
              environments: shading.value.environments,
              lights: shading.value.lights,
              background: shading.value.background,
              environment: shading.value.environment,
              fog: shading.value.fog,
            }, message.settings);
            tracerKey = key;
          }
          const data = tracer.renderTile(message.camera, message.tile, message.width, message.height, message.pass, message.block);
          return { type: 'tile', job: message.job, data };
        } catch (error) {
          return { type: 'error', job: message.job, message: (error as Error).message };
        }
      }
      default:
        return null;
    }
  };
}

/** The part of a Worker, or of a worker's global scope, the protocol uses. */
export interface MessagePortLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
}

/** Answers requests arriving on a worker's global scope. Called by the `meercad-raytracer/worker` entry. */
export function installTileWorker(scope: MessagePortLike): void {
  const handle = createTileHandler();
  scope.addEventListener('message', event => {
    const response = handle(event.data as RequestMessage);
    if (!response) return;
    if (response.type === 'tile') scope.postMessage(response, [response.data.buffer]);
    else scope.postMessage(response);
  });
}
