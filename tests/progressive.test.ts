import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { LocalExecutor, WorkerExecutor, type WorkerLike } from '../src/executors.js';
import { ProgressiveRenderer, makeTiles, type ProgressiveFrame, type ProgressiveOptions } from '../src/progressive.js';
import { createTileHandler, type RequestMessage } from '../src/protocol.js';
import { raytrace, traceSettings } from '../src/raytrace.js';
import { RaytracingRenderer } from '../src/RaytracingRenderer.js';
import { floor, overheadLight, topCamera } from './helpers.js';

/**
 * A stand-in Web Worker: messages are structured-cloned both ways, as postMessage does,
 * and answered by the same handler the real worker entry installs.
 */
class FakeWorker implements WorkerLike {
  readonly received: RequestMessage[] = [];
  terminated = false;
  private readonly handle = createTileHandler();
  private listener: ((event: MessageEvent) => void) | null = null;

  postMessage(message: unknown): void {
    const copy = structuredClone(message) as RequestMessage;
    this.received.push(copy);
    setTimeout(() => {
      const response = this.handle(copy);
      if (response && this.listener) this.listener({ data: structuredClone(response) } as MessageEvent);
    }, 0);
  }

  addEventListener(type: string, listener: (event: any) => void): void {
    if (type === 'message') this.listener = listener;
  }

  terminate(): void {
    this.terminated = true;
  }
}

function testScene(): THREE.Scene {
  const scene = new THREE.Scene();
  const texture = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255, 128, 128, 128, 255]), 2, 1);
  texture.needsUpdate = true;
  scene.add(floor(new THREE.MeshStandardMaterial({ map: texture, roughness: 0.6 })), overheadLight(2), new THREE.AmbientLight(0xffffff, 1));
  const box = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.5, 0.5), new THREE.MeshPhongMaterial({ color: 0xff8800 }));
  box.position.z = 0.5;
  scene.add(box);
  return scene;
}

function options(partial: Partial<ProgressiveOptions> = {}): ProgressiveOptions {
  return {
    width: 20, height: 12, settings: traceSettings({}), outputColorSpace: 'srgb', samples: 3,
    previewBlock: 1, tileSize: 8, frameInterval: 0, ...partial,
  };
}

describe('makeTiles', () => {
  it('covers the image exactly, centre first', () => {
    const tiles = makeTiles(20, 12, 8);
    expect(tiles.reduce((sum, t) => sum + t.width * t.height, 0)).toBe(240);
    const first = tiles[0]!;
    expect(first.x <= 10 && first.x + first.width >= 10).toBe(true);
  });
});

describe('ProgressiveRenderer', () => {
  it('renders the same image as raytrace, in the page', async () => {
    const scene = testScene(), camera = topCamera();
    const frames: ProgressiveFrame[] = [];
    const renderer = new ProgressiveRenderer([new LocalExecutor()]);
    const done = await renderer.render(scene, camera, options(), frame => frames.push({ ...frame, image: frame.image.slice() }));
    expect(done).toBe(true);
    const last = frames.at(-1)!;
    expect(last.done).toBe(true);
    expect(last.samples).toBe(3);
    expect([...last.image]).toEqual([...raytrace(scene, camera, 20, 12, { samples: 3 }).data]);
  });

  it('renders the same image through workers, sending scene data only when it changes', async () => {
    const scene = testScene(), camera = topCamera();
    const workers = [new FakeWorker(), new FakeWorker()];
    const renderer = new ProgressiveRenderer(workers.map(w => new WorkerExecutor(w)));
    let image: Uint8ClampedArray | null = null;
    expect(await renderer.render(scene, camera, options(), frame => (image = frame.image.slice()))).toBe(true);
    expect([...image!]).toEqual([...raytrace(scene, camera, 20, 12, { samples: 3 }).data]);
    const count = (type: string) => workers.reduce((n, w) => n + w.received.filter(m => m.type === type).length, 0);
    expect(count('geometry')).toBe(2);
    expect(count('textures')).toBe(2);
    expect(count('shading')).toBe(2);

    // Moving the camera resends nothing but tiles.
    camera.position.x = 0.3;
    camera.updateMatrixWorld();
    await renderer.render(scene, camera, options(), () => undefined);
    expect(count('geometry')).toBe(2);
    expect(count('shading')).toBe(2);

    // A colour change resends shading, but not geometry or textures.
    ((scene.children[0] as THREE.Mesh).material as THREE.MeshStandardMaterial).color.set(0x00ff00);
    await renderer.render(scene, camera, options(), () => undefined);
    expect(count('geometry')).toBe(2);
    expect(count('textures')).toBe(2);
    expect(count('shading')).toBe(4);

    // Moving a mesh resends geometry.
    scene.children[3]!.position.x = 0.2;
    await renderer.render(scene, camera, options(), () => undefined);
    expect(count('geometry')).toBe(4);
    renderer.dispose();
    expect(workers.every(w => w.terminated)).toBe(true);
  });

  it('shows a block preview first', async () => {
    const frames: number[] = [];
    const renderer = new ProgressiveRenderer([new LocalExecutor()]);
    await renderer.render(testScene(), topCamera(), options({ previewBlock: 4 }), frame => frames.push(frame.samples));
    expect(frames[0]).toBe(0);
    expect(frames.at(-1)).toBe(3);
  });

  it('stops when superseded', async () => {
    const renderer = new ProgressiveRenderer([new LocalExecutor()]);
    const first = renderer.render(testScene(), topCamera(), options({ samples: 50 }), () => undefined);
    const second = renderer.render(testScene(), topCamera(), options({ samples: 1 }), () => undefined);
    expect(await first).toBe(false);
    expect(await second).toBe(true);
    const third = renderer.render(testScene(), topCamera(), options({ samples: 50 }), () => undefined);
    renderer.stop();
    expect(await third).toBe(false);
  });

  it('carries on when a worker fails', async () => {
    const broken: WorkerLike = {
      postMessage: () => undefined,
      addEventListener: (type: string, listener: (event: any) => void) => {
        if (type === 'error') setTimeout(() => listener({ message: 'boom' }), 0);
      },
      terminate: () => undefined,
    };
    const renderer = new ProgressiveRenderer([new WorkerExecutor(broken), new WorkerExecutor(new FakeWorker())]);
    expect(await renderer.render(testScene(), topCamera(), options(), () => undefined)).toBe(true);
  });
});

describe('RaytracingRenderer', () => {
  function fakeCanvas() {
    const drawn: { data: Uint8ClampedArray; width: number; height: number }[] = [];
    const context = {
      createImageData: (width: number, height: number) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
      putImageData: (image: { data: Uint8ClampedArray; width: number; height: number }) => drawn.push({ ...image, data: image.data.slice() }),
      clearRect: () => undefined,
    };
    const canvas = { width: 300, height: 150, style: {} as Record<string, string>, getContext: () => context };
    return { canvas: canvas as unknown as HTMLCanvasElement, drawn };
  }

  it('sizes its canvas like WebGLRenderer', () => {
    const { canvas } = fakeCanvas();
    const renderer = new RaytracingRenderer({ canvas });
    renderer.setPixelRatio(2);
    renderer.setSize(40, 30);
    expect(canvas.width).toBe(80);
    expect(canvas.height).toBe(60);
    expect(canvas.style.width).toBe('40px');
    expect(renderer.getSize()).toEqual({ x: 40, y: 30 });
    renderer.setPixelRatio(1);
    expect(canvas.width).toBe(40);
    renderer.dispose();
  });

  it('copies output settings from a WebGLRenderer', () => {
    const { canvas } = fakeCanvas();
    const webgl = {
      toneMapping: THREE.ReinhardToneMapping, toneMappingExposure: 1.5, outputColorSpace: THREE.LinearSRGBColorSpace,
      getClearColor: (target: THREE.Color) => target.copy(new THREE.Color(0.25, 0.5, 1)),
      getClearAlpha: () => 0.5, getPixelRatio: () => 1,
    };
    const renderer = new RaytracingRenderer({ canvas }).copySettingsFrom(webgl);
    expect(renderer.toneMapping).toBe(THREE.ReinhardToneMapping);
    expect(renderer.toneMappingExposure).toBe(1.5);
    expect(renderer.outputColorSpace).toBe(THREE.LinearSRGBColorSpace);
    expect(renderer.getClearAlpha()).toBe(0.5);
    renderer.setClearColor(0xffffff, 1);
    expect(renderer.getClearAlpha()).toBe(1);
    renderer.dispose();
  });

  it('draws progressively into its canvas and reports progress', async () => {
    const { canvas, drawn } = fakeCanvas();
    const renderer = new RaytracingRenderer({ canvas, samples: 2, previewBlock: 4, frameInterval: 0 });
    renderer.setSize(20, 12);
    const progress: number[] = [];
    renderer.onProgress(p => progress.push(p.samples));
    expect(await renderer.renderAsync(testScene(), topCamera())).toBe(true);
    expect(drawn.length).toBeGreaterThan(1);
    expect(drawn.at(-1)!.width).toBe(20);
    expect([...drawn.at(-1)!.data]).toEqual([...raytrace(testScene(), topCamera(), 20, 12, { samples: 2 }).data]);
    expect(progress[0]).toBe(0);
    expect(renderer.progress).toEqual({ samples: 2, maxSamples: 2, done: true });
    renderer.dispose();
  });

  it('merges render calls made in the same frame', async () => {
    const { canvas } = fakeCanvas();
    const renderer = new RaytracingRenderer({ canvas, samples: 1, previewBlock: 1 });
    renderer.setSize(8, 8);
    const scene = testScene(), camera = topCamera();
    for (let i = 0; i < 5; i++) renderer.render(scene, camera);
    await new Promise(resolve => setTimeout(resolve, 20));
    expect(await renderer.whenDone()).toBe(true);
    renderer.dispose();
  });
});
