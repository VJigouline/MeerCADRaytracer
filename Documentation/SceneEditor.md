# Using it with SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) uses MeerCADRaytracer on its **Photorealistic** tab. The ray traced image either replaces the main 3D view or appears in a separate browser window that follows the main view's camera. The same approach works for any three.js app with controls on its WebGL canvas.

## How it is wired

The integration is in SceneEditor's `src/app/raytracer/raytrace.service.ts`, and the tab is `src/app/photorealistic-editor`.

**One renderer, two places to draw.** The service owns a single `RaytracingRenderer`, and with it the workers and the compiled scene. `setCanvas` moves it between a canvas over the main view and a canvas in the separate window, so switching places doesn't restart the workers or recompile the scene.

**Main view: an overlay.** The main-view canvas lies over the WebGL canvas, absolutely positioned with `pointer-events: none`. The WebGL canvas stays in place and keeps receiving the mouse, so `OrbitControls`, `TransformControls` and SceneEditor's hover selection work unchanged. The WebGL canvas is cleared, so its CSS background gradient shows through the transparent parts of the ray traced image.

**Separate window.** `window.open`, called from the click that chooses it so pop-up blockers allow it, makes a window with a canvas and a status line. The main view keeps drawing with WebGL. The window's `resize` event resizes the renderer, and `pagehide` turns ray tracing off when the user closes it. `fitAspect` keeps the main camera's proportions in a window of another shape. Without it, the view is stretched to the window.

**One render path.** `ThreeSceneService.renderView()` is the only place the view is drawn. It draws WebGL, or clears it in main-view mode, then asks the service to ray trace, which does nothing when ray tracing is off. Every change that redraws the view, such as orbiting, editing a light or assigning a material, therefore restarts the ray trace.

**Settings.** Before each render the service applies the tab's settings: `samples`, `maxBounces`, `previewBlock`, `shadows`, `globalIllumination`, `toneMapping`, `toneMappingExposure`, `outputColorSpace`, the clear colour, and a pixel ratio of resolution × `devicePixelRatio`. "Same as the main view" reads the WebGL renderer's tone mapping, colour space and clear colour. Changing the number of worker threads disposes the renderer and creates a new one on the same canvas.

**Workers.** `src/app/raytracer/raytracer.worker.ts` imports `meercad-raytracer/worker`. `tsconfig.worker.json` compiles it with the `webworker` library, and `angular.json` names it in `webWorkerTsConfig`. The service creates the workers with `new Worker(new URL('./raytracer.worker', import.meta.url), { type: 'module' })`.

**Outside Angular's zone.** The renderer is created and driven inside `NgZone.runOutsideAngular`, so worker messages don't run change detection for every tile. Progress updates, which carry `elapsed` and `stopped`, re-enter the zone to update the tab.

## What is left out of the ray traced image

Light helpers and the move gizmo are left out automatically, as helpers and `TransformControls` objects always are. In the main view, light handles therefore aren't drawn. Use the separate window, where the main view keeps them, to move lights by their handles while you watch the ray traced result.
