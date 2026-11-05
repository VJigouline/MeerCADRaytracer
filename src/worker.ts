// Web Worker entry point. Bundle a worker that imports this module, for example a file holding
// only `import 'meercad-raytracer/worker';`, and give RaytracingRenderer a factory that creates it.
import { installTileWorker, type MessagePortLike } from './protocol.js';

declare const self: MessagePortLike;

installTileWorker(self);
