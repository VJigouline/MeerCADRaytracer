# Getting started

## 1. Install

```sh
npm install three github:VJigouline/MeerCADRaytracer
```

## 2. Add a worker

Rays are traced fastest in Web Workers, one per processor core. Add a worker module to your app that imports the library's worker entry:

```ts
// raytracer.worker.ts
import 'meercad-raytracer/worker';
```

Bundlers such as Vite, webpack 5, esbuild and the Angular CLI recognise `new Worker(new URL('./raytracer.worker', import.meta.url), { type: 'module' })` and bundle the worker for you. In the Angular CLI, add a `webWorkerTsConfig` to the build options, as `ng generate web-worker` does.

You can skip this step. Without workers, rendering runs in the page, one tile per task, so the page stays responsive but the image takes longer.

## 3. Create the renderer

```ts
import * as THREE from 'three';
import { RaytracingRenderer } from 'meercad-raytracer';

const scene = new THREE.Scene();
scene.add(new THREE.Mesh(new THREE.TorusKnotGeometry(1, 0.3, 128, 16), new THREE.MeshStandardMaterial({ color: 0xcc3333, roughness: 0.3 })));
const ground = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 0.5, roughness: 0.2 }));
ground.rotation.x = -Math.PI / 2;
ground.position.y = -1.5;
scene.add(ground);
const sun = new THREE.DirectionalLight(0xffffff, 3);
sun.position.set(3, 5, 2);
scene.add(sun, new THREE.AmbientLight(0xffffff, 0.5));

const camera = new THREE.PerspectiveCamera(50, innerWidth / innerHeight, 0.1, 100);
camera.position.set(0, 1, 6);
camera.lookAt(0, 0, 0);

const renderer = new RaytracingRenderer({
  workerFactory: () => new Worker(new URL('./raytracer.worker', import.meta.url), { type: 'module' }),
  samples: 128,
});
renderer.setPixelRatio(devicePixelRatio);
renderer.setSize(innerWidth, innerHeight);
renderer.toneMapping = THREE.ACESFilmicToneMapping;
document.body.appendChild(renderer.domElement);

renderer.render(scene, camera);
```

The canvas first shows a coarse preview, then a sharper image after every pass, until each pixel has 128 samples.

## 4. Follow progress

```ts
renderer.onProgress(({ samples, maxSamples, done }) => {
  status.textContent = done ? 'Done' : `${samples} / ${maxSamples}`;
});

// Or wait for the whole render:
const finished = await renderer.renderAsync(scene, camera);   // false if restarted or stopped
```

## 5. React to changes

Call `render` whenever the scene or camera changes, for example from `OrbitControls`' `change` event. Calls made in the same animation frame are merged, and each call restarts the image from the preview.

Only what changed is recompiled. A camera move sends nothing to the workers but tile requests. A material or light change resends the small shading description. Moving or editing a mesh rebuilds the geometry and its BVH, and texture pixels are sent to each worker only once.

## 6. Save the image

The canvas is an ordinary 2D canvas:

```ts
renderer.domElement.toBlob(blob => { /* save or upload it */ }, 'image/png');
```

## 7. Clean up

```ts
renderer.dispose();   // stops rendering and terminates the workers
```
