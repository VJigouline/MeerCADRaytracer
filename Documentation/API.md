# API

Everything below is exported from `meercad-raytracer`. The worker entry is `meercad-raytracer/worker`.

## RaytracingRenderer

A canvas renderer that can stand in for `THREE.WebGLRenderer` when showing a scene.

```ts
new RaytracingRenderer(parameters?: RaytracingRendererParameters)
```

| Parameter | Default | Meaning |
|---|---|---|
| `canvas` | a new canvas | Canvas to draw into. It must support a 2D context. |
| `workerFactory` | none | Creates a `Worker` that runs `meercad-raytracer/worker`. Without it, tracing runs in the page. |
| `workers` | cores less one, at most 8 | Number of workers to start. |
| `samples` | 64 | Samples per pixel to stop at. |
| `maxBounces` | 4 | Reflection, refraction and indirect bounces per path. |
| `shadows` | `'all'` | `'all'`, `'castShadow'` or `'none'`. See [Rendering](Rendering.md#shadows). |
| `globalIllumination` | `false` | Bounce light off diffuse surfaces as well. |
| `previewBlock` | 4 | Block size, in pixels, of the first quick preview. 1 turns it off. |
| `tileSize` | 64 | Tile edge in pixels. |
| `frameInterval` | 100 | Shortest time between canvas updates, in milliseconds. |
| `toneMapping`, `toneMappingExposure`, `outputColorSpace` | as WebGLRenderer | Output settings, also settable as properties. |
| `clearColor`, `clearAlpha` | black, 0 | Shown where nothing is hit and the scene has no background. |
| `filter` | none | `(object) => boolean`. Return false to leave an object and its children out. |
| `seed` | 0 | Seed for the random sampling. |

### Properties

`domElement`, `toneMapping`, `toneMappingExposure`, `outputColorSpace`, `samples`, `maxBounces`, `shadows`, `globalIllumination`, `previewBlock` and `filter` can be changed at any time. Changes apply from the next `render`.

`progress` is `{ samples, maxSamples, done }` for the render in progress or just finished.

### Methods

| Method | Does |
|---|---|
| `render(scene, camera)` | Starts, or restarts, a progressive render and returns at once. Calls in one animation frame are merged. |
| `renderAsync(scene, camera)` | Renders and resolves with `true` when all samples are done, or `false` if restarted or stopped first. |
| `whenDone()` | Resolves when the current render ends, as `renderAsync` does. |
| `stop()` | Stops rendering. The canvas keeps what has been drawn. |
| `onProgress(listener)` | Calls `listener({ samples, maxSamples, done })` as the image refines. Returns a function that removes the listener. |
| `setSize(width, height, updateStyle = true)` | Sizes the canvas in CSS pixels, times the pixel ratio. |
| `getSize(target?)` | Size in CSS pixels. |
| `setPixelRatio(ratio)`, `getPixelRatio()` | As WebGLRenderer. |
| `setClearColor(color, alpha?)` | A three.js `Color`, an RGB array in linear values, or a hex number in sRGB, as WebGLRenderer reads it. |
| `getClearAlpha()`, `setClearAlpha(alpha)` | As WebGLRenderer. |
| `copySettingsFrom(webglRenderer)` | Copies tone mapping, exposure, output colour space, clear colour, clear alpha and pixel ratio. Returns the renderer. |
| `clear()` | Clears the canvas. |
| `dispose()` | Stops rendering and terminates the workers. |

## raytrace

```ts
raytrace(scene, camera, width, height, options?: RaytraceOptions): RaytraceResult
```

Renders in the calling thread and returns `{ width, height, data }`, where `data` holds RGBA bytes, top row first, with straight alpha. It works in Node.js. There, textures must be `DataTexture`s, because images can't be decoded without a canvas.

`RaytraceOptions` takes `samples` (default 16), `maxBounces`, `shadows`, `globalIllumination`, `toneMapping` (default `NoToneMapping`), `toneMappingExposure`, `outputColorSpace` (default `'srgb'`), `clearColor`, `clearAlpha`, `filter` and `seed`, with the meanings above.

Renders are deterministic: the same scene, camera, options and seed give the same bytes, in the page, in workers or in Node.js.

## Lower-level building blocks

| Export | Use |
|---|---|
| `compileScene(scene, camera?, options?)` | Converts a scene to plain, structured-cloneable data: world-space triangles with a BVH, materials, decoded textures, lights, background, environment and fog. |
| `compileCamera(camera)` | A camera's matrices, for perspective and orthographic cameras. |
| `raytraceCompiled(compiledScene, compiledCamera, width, height, options?)` | `raytrace` for already compiled data. |
| `Tracer` | Traces tiles of a compiled scene: `new Tracer(scene, settings).renderTile(camera, tile, width, height, pass)`. |
| `ProgressiveRenderer` | The scheduler behind `RaytracingRenderer`, without the canvas: renders onto any set of executors and reports frames as RGBA arrays. |
| `LocalExecutor`, `WorkerExecutor` | Executors that trace in the page or in a worker. |
| `createTileHandler()`, `installTileWorker(scope)` | The worker side of the message protocol, for custom worker setups. |
| `isHelper(object)` | True for objects that are always left out: helpers, transform gizmos and objects with `userData.raytrace === false`. |
| `toneMap`, `srgbToLinear`, `linearToSrgb` | The colour functions the renderer uses. |
