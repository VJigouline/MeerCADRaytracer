# Using it with SceneEditor

[SceneEditor](https://github.com/VJigouline/SceneEditor) uses MeerCADRaytracer for its ray traced view: on the **Scene** tab, **Ray traced view** replaces the WebGL image with a ray traced one. The same approach works for any three.js app with controls on its WebGL canvas.

## How it is wired

The integration is in SceneEditor's `src/app/raytracer` folder.

**An overlay, not a replacement element.** `RaytraceService.attach` puts the `RaytracingRenderer` canvas over the WebGL canvas, absolutely positioned with `pointer-events: none`. The WebGL canvas stays in place and keeps receiving the mouse, so `OrbitControls`, `TransformControls` and SceneEditor's hover selection work unchanged in both views.

**One render path.** `ThreeSceneService.renderView()` is the only place the view is drawn. With the ray traced view on, it clears the WebGL canvas, so its CSS background gradient shows through the transparent ray traced canvas, and calls `RaytracingRenderer.render`. Otherwise it hides the overlay and draws with WebGL. Every change that used to redraw the WebGL view, such as orbiting, editing a light or assigning a material, therefore restarts the ray trace.

**Same output settings.** `copySettingsFrom(webglRenderer)` copies Reinhard tone mapping, linear output, the transparent clear colour and the pixel ratio, so both views show the same colours.

**Workers.** `src/app/raytracer/raytracer.worker.ts` imports `meercad-raytracer/worker`. `tsconfig.worker.json` compiles it with the `webworker` library, and `angular.json` names it in `webWorkerTsConfig`. The service creates the workers with `new Worker(new URL('./raytracer.worker', import.meta.url), { type: 'module' })`.

**Outside Angular's zone.** The renderer is created and driven inside `NgZone.runOutsideAngular`, so worker messages don't run change detection for every tile. Progress updates re-enter the zone to update the Scene tab.

**Sizing.** Every place that resizes the WebGL renderer also calls `RaytraceService.setSize`.

## What is left out of the ray traced view

Light helpers and the move gizmo are left out automatically, as helpers and `TransformControls` objects always are. So light handles are not drawn in the ray traced view; switch it off to move lights by their handles.
