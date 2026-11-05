import * as THREE from 'three';
import { raytrace, type RaytraceOptions } from '../src/raytrace.js';

/** Orthographic camera at z = 10 looking down -z at the square -1..1. */
export function topCamera(): THREE.OrthographicCamera {
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 100);
  camera.position.set(0, 0, 10);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  return camera;
}

/** A 4 x 4 plane in z = 0 facing +z. */
export function floor(material: THREE.Material, size = 4): THREE.Mesh {
  return new THREE.Mesh(new THREE.PlaneGeometry(size, size), material);
}

export interface Rendered {
  /** Pixel as 0..1 RGBA. */
  at(x: number, y: number): [number, number, number, number];
  width: number;
  height: number;
}

/** Ray traces with linear output and no tone mapping unless asked, so values are easy to predict. */
export function render(scene: THREE.Scene, camera: THREE.Camera, options: RaytraceOptions = {}, width = 16, height = 16): Rendered {
  const result = raytrace(scene, camera, width, height, { outputColorSpace: 'srgb-linear', samples: 1, ...options });
  return {
    width,
    height,
    at(x, y) {
      const i = (y * width + x) * 4;
      return [result.data[i]! / 255, result.data[i + 1]! / 255, result.data[i + 2]! / 255, result.data[i + 3]! / 255];
    },
  };
}

/** Directional light shining straight down -z from +z. */
export function overheadLight(intensity: number): THREE.DirectionalLight {
  const light = new THREE.DirectionalLight(0xffffff, intensity);
  light.position.set(0, 0, 10);
  return light;
}

export const ONE_LEVEL = 1 / 255 + 1e-6;
