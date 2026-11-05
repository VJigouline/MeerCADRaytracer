import type { Camera, Object3D, Scene } from 'three';
import { LinearSRGBColorSpace, NoToneMapping, SRGBColorSpace } from './constants.js';
import { LocalExecutor, WorkerExecutor, type TileExecutor, type WorkerLike } from './executors.js';
import { ProgressiveRenderer, type ProgressiveFrame } from './progressive.js';
import { traceSettings, type RaytraceOptions } from './raytrace.js';
import type { RGB, TraceSettings } from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface RaytracingRendererParameters extends RaytraceOptions {
  /** Canvas to draw into. One is created when omitted. */
  canvas?: HTMLCanvasElement;
  /**
   * Creates a Web Worker running the `meercad-raytracer/worker` entry. Without it, rendering
   * runs in the page, a tile at a time.
   */
  workerFactory?: () => WorkerLike;
  /** Workers to start. Default: logical processors less one, at most 8. */
  workers?: number;
  /** Block size of the quick preview drawn first; 1 turns it off. Default 4. */
  previewBlock?: number;
  /** Tile edge in pixels. Default 64. */
  tileSize?: number;
  /** Shortest time between redraws while rendering, in milliseconds. Default 100. */
  frameInterval?: number;
  /**
   * Keep the camera's proportions when the canvas is shaped differently from the camera's view,
   * widening or narrowing the view horizontally. Default false: stretch, as WebGLRenderer does.
   */
  fitAspect?: boolean;
}

export interface RaytracingProgress {
  /** Samples every pixel has received; 0 while only the preview is showing. */
  samples: number;
  maxSamples: number;
  /** Every pixel has maxSamples samples. */
  done: boolean;
  /** stop() ended the render before it was done. */
  stopped: boolean;
  /** Milliseconds since the render started. */
  elapsed: number;
}

type ProgressListener = (progress: RaytracingProgress) => void;

/**
 * A canvas renderer with the parts of three.js's WebGLRenderer interface that applications use
 * to show a scene, so it can stand in for one: domElement, setSize, setPixelRatio,
 * setClearColor, toneMapping, toneMappingExposure, outputColorSpace, render and dispose.
 *
 * `render` starts a progressive ray trace and returns at once: a block preview appears first,
 * then the image refines until `samples` samples per pixel. Calling `render` again, for example
 * when the camera moves, restarts it; calls in the same animation frame are merged.
 */
export class RaytracingRenderer {
  /** The canvas drawn into. setCanvas changes it. */
  domElement: HTMLCanvasElement;
  toneMapping = NoToneMapping;
  toneMappingExposure = 1;
  outputColorSpace: string = SRGBColorSpace;
  samples: number;
  maxBounces: number;
  shadows: TraceSettings['shadows'];
  globalIllumination: boolean;
  previewBlock: number;
  fitAspect: boolean;
  filter: ((object: Object3D) => boolean) | undefined;

  private context: CanvasRenderingContext2D;
  private updateStyle = true;
  private startTime = 0;
  private readonly progressive: ProgressiveRenderer;
  private readonly tileSize: number;
  private readonly frameInterval: number;
  private width: number;
  private height: number;
  private cssWidth: number;
  private cssHeight: number;
  private pixelRatio = 1;
  private clearColor: RGB = [0, 0, 0];
  private clearAlpha = 0;
  private seed: number;
  private pending: { scene: Scene; camera: Camera } | null = null;
  private scheduled = false;
  private current: Promise<boolean> = Promise.resolve(true);
  private readonly listeners = new Set<ProgressListener>();
  private lastProgress: RaytracingProgress = { samples: 0, maxSamples: 0, done: true, stopped: false, elapsed: 0 };
  private imageData: ImageData | null = null;
  private disposed = false;

  constructor(parameters: RaytracingRendererParameters = {}) {
    this.domElement = parameters.canvas ?? document.createElement('canvas');
    const context = this.domElement.getContext('2d');
    if (!context) throw new Error('meercad-raytracer: the canvas has no 2D context');
    this.context = context;
    this.width = this.cssWidth = this.domElement.width;
    this.height = this.cssHeight = this.domElement.height;
    this.samples = parameters.samples ?? 64;
    this.maxBounces = parameters.maxBounces ?? 4;
    this.shadows = parameters.shadows ?? 'all';
    this.globalIllumination = parameters.globalIllumination ?? false;
    this.previewBlock = parameters.previewBlock ?? 4;
    this.fitAspect = parameters.fitAspect ?? false;
    this.filter = parameters.filter;
    this.tileSize = parameters.tileSize ?? 64;
    this.frameInterval = parameters.frameInterval ?? 100;
    this.seed = parameters.seed ?? 0;
    if (parameters.toneMapping !== undefined) this.toneMapping = parameters.toneMapping;
    if (parameters.toneMappingExposure !== undefined) this.toneMappingExposure = parameters.toneMappingExposure;
    if (parameters.outputColorSpace !== undefined) this.outputColorSpace = parameters.outputColorSpace;
    if (parameters.clearColor) this.clearColor = parameters.clearColor;
    if (parameters.clearAlpha !== undefined) this.clearAlpha = parameters.clearAlpha;

    const executors: TileExecutor[] = [];
    if (parameters.workerFactory) {
      const cores = typeof navigator !== 'undefined' && navigator.hardwareConcurrency ? navigator.hardwareConcurrency : 4;
      const count = Math.max(1, Math.floor(parameters.workers ?? Math.min(8, cores - 1)));
      for (let i = 0; i < count; i++) executors.push(new WorkerExecutor(parameters.workerFactory()));
    } else {
      executors.push(new LocalExecutor());
    }
    this.progressive = new ProgressiveRenderer(executors);
  }

  /** Copies the output settings of a three.js WebGLRenderer, so both draw the same way. */
  copySettingsFrom(renderer: any): this {
    if (renderer.toneMapping !== undefined) this.toneMapping = renderer.toneMapping;
    if (renderer.toneMappingExposure !== undefined) this.toneMappingExposure = renderer.toneMappingExposure;
    if (renderer.outputColorSpace !== undefined) this.outputColorSpace = renderer.outputColorSpace;
    if (typeof renderer.getClearColor === 'function') {
      // getClearColor copies into its target, so give it something with copy().
      const target = { r: 0, g: 0, b: 0, copy(c: any) { this.r = c.r; this.g = c.g; this.b = c.b; return this; } };
      const color = renderer.getClearColor(target);
      this.clearColor = [color.r, color.g, color.b];
    }
    if (typeof renderer.getClearAlpha === 'function') this.clearAlpha = renderer.getClearAlpha();
    if (typeof renderer.getPixelRatio === 'function') this.setPixelRatio(renderer.getPixelRatio());
    return this;
  }

  setPixelRatio(value: number): void {
    this.pixelRatio = value;
    this.setSize(this.cssWidth, this.cssHeight, false);
  }

  getPixelRatio(): number {
    return this.pixelRatio;
  }

  /**
   * Draws into another canvas from now on, such as one in a separate window, keeping the
   * workers and the compiled scene. The new canvas is given the current size; call setSize
   * for a different one, and render to fill it.
   */
  setCanvas(canvas: HTMLCanvasElement): void {
    if (canvas === this.domElement) return;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('meercad-raytracer: the canvas has no 2D context');
    this.stop();
    this.domElement = canvas;
    this.context = context;
    this.setSize(this.cssWidth, this.cssHeight, this.updateStyle);
  }

  /** Sets the canvas size in CSS pixels; the canvas holds width x pixel ratio pixels. */
  setSize(width: number, height: number, updateStyle = true): void {
    this.updateStyle = updateStyle;
    this.cssWidth = width;
    this.cssHeight = height;
    this.width = Math.max(0, Math.floor(width * this.pixelRatio));
    this.height = Math.max(0, Math.floor(height * this.pixelRatio));
    this.domElement.width = this.width;
    this.domElement.height = this.height;
    if (updateStyle) {
      this.domElement.style.width = `${width}px`;
      this.domElement.style.height = `${height}px`;
    }
    this.imageData = null;
  }

  /** Size in CSS pixels, written into target when given, as WebGLRenderer.getSize. */
  getSize<T extends { x: number; y: number; set?: (x: number, y: number) => T }>(target?: T): T | { x: number; y: number } {
    const x = this.cssWidth, y = this.cssHeight;
    if (!target) return { x, y };
    if (target.set) return target.set(x, y);
    target.x = x;
    target.y = y;
    return target;
  }

  /** Background where nothing is hit and the scene has no background, as WebGLRenderer.setClearColor. */
  setClearColor(color: any, alpha?: number): void {
    if (Array.isArray(color)) this.clearColor = [color[0], color[1], color[2]];
    else if (color && typeof color === 'object' && 'r' in color) this.clearColor = [color.r, color.g, color.b];
    else if (typeof color === 'number') {
      // A hex colour is sRGB, as three.js reads one; store it linear.
      const decode = (c: number) => (c < 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
      this.clearColor = [decode(((color >> 16) & 255) / 255), decode(((color >> 8) & 255) / 255), decode((color & 255) / 255)];
    }
    if (alpha !== undefined) this.clearAlpha = alpha;
  }

  getClearAlpha(): number {
    return this.clearAlpha;
  }

  setClearAlpha(alpha: number): void {
    this.clearAlpha = alpha;
  }

  /** Starts, or restarts, a progressive ray trace of the scene. Returns at once. */
  render(scene: Scene, camera: Camera): void {
    if (this.disposed) return;
    this.pending = { scene, camera };
    if (this.scheduled) return;
    this.scheduled = true;
    const start = () => {
      this.scheduled = false;
      const job = this.pending;
      this.pending = null;
      if (job && !this.disposed) this.current = this.start(job.scene, job.camera);
    };
    if (typeof requestAnimationFrame !== 'undefined') requestAnimationFrame(start);
    else setTimeout(start, 0);
  }

  /** Renders and resolves when done: true when all samples completed, false if restarted or stopped. */
  renderAsync(scene: Scene, camera: Camera): Promise<boolean> {
    this.pending = null;
    this.current = this.start(scene, camera);
    return this.current;
  }

  /** Resolves when the render in progress ends, as renderAsync does. */
  whenDone(): Promise<boolean> {
    return this.current;
  }

  /** Stops rendering; the canvas keeps what has been drawn. */
  stop(): void {
    this.pending = null;
    this.progressive.stop();
    if (!this.lastProgress.done && !this.lastProgress.stopped) {
      this.report({ ...this.lastProgress, stopped: true, elapsed: Date.now() - this.startTime });
    }
  }

  /** Samples per pixel so far, and whether the render has finished. */
  get progress(): RaytracingProgress {
    return this.lastProgress;
  }

  /** Calls the listener as the render progresses. Returns a function that removes it. */
  onProgress(listener: ProgressListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Clears the canvas. */
  clear(): void {
    this.context.clearRect(0, 0, this.width, this.height);
  }

  dispose(): void {
    this.disposed = true;
    this.stop();
    this.progressive.dispose();
    this.listeners.clear();
  }

  private start(scene: Scene, camera: Camera): Promise<boolean> {
    this.startTime = Date.now();
    this.report({ samples: 0, maxSamples: Math.max(1, Math.floor(this.samples)), done: false, stopped: false, elapsed: 0 });
    const settings = traceSettings({
      maxBounces: this.maxBounces,
      shadows: this.shadows,
      globalIllumination: this.globalIllumination,
      toneMapping: this.toneMapping,
      toneMappingExposure: this.toneMappingExposure,
      clearColor: this.clearColor,
      clearAlpha: this.clearAlpha,
      seed: this.seed,
    });
    return this.progressive.render(scene, camera, {
      width: this.width,
      height: this.height,
      settings,
      outputColorSpace: this.outputColorSpace === LinearSRGBColorSpace ? LinearSRGBColorSpace : SRGBColorSpace,
      samples: this.samples,
      previewBlock: this.previewBlock,
      tileSize: this.tileSize,
      ...(this.filter ? { filter: this.filter } : {}),
      frameInterval: this.frameInterval,
      fitAspect: this.fitAspect,
    }, frame => this.draw(frame));
  }

  private report(progress: RaytracingProgress): void {
    this.lastProgress = progress;
    for (const listener of this.listeners) listener(progress);
  }

  private draw(frame: ProgressiveFrame): void {
    if (frame.width !== this.width || frame.height !== this.height) return;
    if (!this.imageData || this.imageData.width !== frame.width || this.imageData.height !== frame.height) {
      this.imageData = this.context.createImageData(frame.width, frame.height);
    }
    this.imageData.data.set(frame.image);
    this.context.putImageData(this.imageData, 0, 0);
    this.report({ samples: frame.samples, maxSamples: frame.maxSamples, done: frame.done, stopped: false, elapsed: Date.now() - this.startTime });
  }
}
