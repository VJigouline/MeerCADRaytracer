import { createTileHandler, type RequestMessage, type ResponseMessage } from './protocol.js';

/** Something that renders tiles: a Web Worker, or the page itself. */
export interface TileExecutor {
  /** Sends scene data. Messages are processed in the order they are sent. */
  send(message: RequestMessage, transfer?: Transferable[]): void;
  /** Renders a tile and resolves with its premultiplied RGBA. */
  render(message: Extract<RequestMessage, { type: 'tile' }>): Promise<Float32Array>;
  /** Texture ids this executor already holds. */
  readonly textures: Set<number>;
  /** Tiles to keep in flight at once. */
  readonly concurrency: number;
  dispose(): void;
}

/** Renders in the page, one tile per macrotask, so the page stays responsive between tiles. */
export class LocalExecutor implements TileExecutor {
  readonly textures = new Set<number>();
  readonly concurrency = 1;
  private readonly handle = createTileHandler();
  private queue: Promise<unknown> = Promise.resolve();

  send(message: RequestMessage): void {
    // Queued behind tiles already requested, so messages keep their order, as with a worker.
    this.queue = this.queue.then(() => this.handle(message));
  }

  render(message: Extract<RequestMessage, { type: 'tile' }>): Promise<Float32Array> {
    const result = this.queue.then(() => new Promise<Float32Array>((resolve, reject) => {
      setTimeout(() => {
        const response = this.handle(message);
        if (response?.type === 'tile') resolve(response.data);
        else reject(new Error(response?.type === 'error' ? response.message : 'no response'));
      }, 0);
    }));
    this.queue = result.catch(() => undefined);
    return result;
  }

  dispose(): void {
    // Nothing to release.
  }
}

/** The part of the Worker interface the executor uses. */
export interface WorkerLike {
  postMessage(message: unknown, transfer?: Transferable[]): void;
  addEventListener(type: 'message', listener: (event: MessageEvent) => void): void;
  addEventListener(type: 'error', listener: (event: ErrorEvent) => void): void;
  terminate(): void;
}

/** Renders in a Web Worker that runs the `meercad-raytracer/worker` entry. */
export class WorkerExecutor implements TileExecutor {
  readonly textures = new Set<number>();
  // Two tiles in flight hide the message round trip.
  readonly concurrency = 2;
  private readonly pending = new Map<number, { resolve: (data: Float32Array) => void; reject: (error: Error) => void }>();
  private failed: Error | null = null;

  constructor(private readonly worker: WorkerLike) {
    worker.addEventListener('message', event => {
      const response = event.data as ResponseMessage;
      const job = this.pending.get(response.job);
      if (!job) return;
      this.pending.delete(response.job);
      if (response.type === 'tile') job.resolve(response.data);
      else job.reject(new Error(response.message));
    });
    worker.addEventListener('error', event => {
      this.failed = new Error(`ray tracing worker failed: ${event.message ?? 'unknown error'}`);
      for (const job of this.pending.values()) job.reject(this.failed);
      this.pending.clear();
    });
  }

  send(message: RequestMessage, transfer?: Transferable[]): void {
    this.worker.postMessage(message, transfer);
  }

  render(message: Extract<RequestMessage, { type: 'tile' }>): Promise<Float32Array> {
    if (this.failed) return Promise.reject(this.failed);
    return new Promise((resolve, reject) => {
      this.pending.set(message.job, { resolve, reject });
      this.worker.postMessage(message);
    });
  }

  dispose(): void {
    for (const job of this.pending.values()) job.reject(new Error('the renderer was disposed'));
    this.pending.clear();
    this.worker.terminate();
  }
}
