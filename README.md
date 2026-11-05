# MeerCADRaytracer

A ray tracer for [three.js](https://threejs.org/) scenes, written in TypeScript. It takes the scene and camera you already draw on a three.js canvas and renders a ray traced image of them, with shadows, reflections, refraction and, optionally, global illumination.

It shades like three.js. Materials, lights, tone mapping and colour spaces follow three.js r187's shaders, so a ray traced image matches the WebGL renderer's wherever WebGL is exact, and adds what WebGL only approximates.

- **Drop-in canvas renderer.** `RaytracingRenderer` has the parts of `WebGLRenderer` an application uses to show a scene: `domElement`, `setSize`, `setPixelRatio`, `setClearColor`, `toneMapping`, `toneMappingExposure`, `outputColorSpace`, `render` and `dispose`.
- **Progressive and interactive.** A quick block preview appears first, then the image refines. Calling `render` again, for example as the camera moves, restarts it.
- **Web Workers.** Tiles are traced in parallel workers. Without workers, it traces in the page a tile at a time.
- **No runtime dependency.** three.js is a peer dependency used for types only, so the worker bundle is about 25 kB.
- **Headless.** `raytrace()` renders in Node.js too.

## Install

The package is not on the npm registry. Install it from GitHub:

```sh
npm install github:VJigouline/MeerCADRaytracer
```

`three` (r160 or later) is a peer dependency. The package builds itself on install.

## Use it in place of the WebGL canvas

```ts
import { RaytracingRenderer } from 'meercad-raytracer';

const renderer = new RaytracingRenderer({
  // Optional, but much faster: a worker that runs the library's worker entry.
  workerFactory: () => new Worker(new URL('./raytracer.worker', import.meta.url), { type: 'module' }),
  samples: 64,
});
renderer.setSize(width, height);
document.body.appendChild(renderer.domElement);

renderer.render(scene, camera);   // starts a progressive ray trace and returns at once
```

`raytracer.worker.ts` needs one line:

```ts
import 'meercad-raytracer/worker';
```

To show the ray traced image over an existing WebGL view, keeping its controls, see [Using it with SceneEditor](Documentation/SceneEditor.md).

## Render an image without a canvas

```ts
import { raytrace } from 'meercad-raytracer';

const { width, height, data } = raytrace(scene, camera, 640, 480, { samples: 64 });
// data: RGBA bytes, ready for new ImageData(data, width, height)
```

## Documentation

- [Getting started](Documentation/GettingStarted.md)
- [API](Documentation/API.md)
- [What it renders, and how it matches three.js](Documentation/Rendering.md)
- [Using it with SceneEditor](Documentation/SceneEditor.md)

## Development

```sh
npm install
npm test           # vitest
npm run typecheck
npm run build      # emits dist/
```

Requirements: Node.js 22 or later.

## Licence

MIT. `src/dfgData.ts` holds a lookup table copied from three.js, also MIT licensed.
