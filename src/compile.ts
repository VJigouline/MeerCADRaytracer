import type { Camera, Object3D, Scene } from 'three';
import { buildBvh } from './bvh.js';
import { FrontSide } from './constants.js';
import { TextureTable } from './textures.js';
import {
  TRI_CAST_SHADOW,
  TRI_OPAQUE,
  TRI_RECEIVE_SHADOW,
  type CompiledBackground,
  type CompiledCamera,
  type CompiledFog,
  type CompiledGeometry,
  type CompiledLight,
  type CompiledMaterial,
  type CompiledScene,
  type RGB,
} from './types.js';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface CompileOptions {
  /**
   * Return false to leave an object and its children out of the ray traced image.
   * Helpers, transform gizmos and objects with userData.raytrace === false are always left out.
   */
  filter?: (object: Object3D) => boolean;
}

const warned = new Set<string>();
function warnOnce(message: string): void {
  if (warned.has(message)) return;
  warned.add(message);
  console.warn(`meercad-raytracer: ${message}`);
}

/** Objects that draw editing aids rather than scene content. */
export function isHelper(object: any): boolean {
  return object.isTransformControlsRoot === true || object.isTransformControlsGizmo === true ||
    object.isTransformControlsPlane === true || (typeof object.type === 'string' && object.type.endsWith('Helper')) ||
    object.userData?.raytrace === false;
}

function rgb(color: any, scale = 1): RGB {
  return color ? [color.r * scale, color.g * scale, color.b * scale] : [scale, scale, scale];
}

function positionOf(matrix: any): RGB {
  const e = matrix.elements;
  return [e[12], e[13], e[14]];
}

function normalize(v: RGB): RGB {
  const length = Math.hypot(v[0], v[1], v[2]);
  return length > 0 ? [v[0] / length, v[1] / length, v[2] / length] : [0, 0, 1];
}

function worldTarget(target: any): RGB {
  if (!target) return [0, 0, 0];
  if (!target.parent && typeof target.updateMatrixWorld === 'function') target.updateMatrixWorld();
  return positionOf(target.matrixWorld);
}

/** Visible objects three.js would draw for this camera, minus helpers and filtered ones. */
function collectObjects(scene: Scene, camera: Camera | undefined, options: CompileOptions): { meshes: any[]; lights: any[] } {
  const meshes: any[] = [];
  const lights: any[] = [];
  const visit = (object: any) => {
    if (!object.visible || isHelper(object)) return;
    if (options.filter && !options.filter(object)) return;
    const layersMatch = !camera || !object.layers || camera.layers.test(object.layers);
    if (layersMatch) {
      if (object.isLight) lights.push(object);
      else if (object.isBatchedMesh) warnOnce('BatchedMesh is not supported and is left out');
      else if (object.isMesh) meshes.push(object);
    }
    for (const child of object.children) visit(child);
  };
  visit(scene);
  return { meshes, lights };
}

function compileMaterial(material: any, table: TextureTable): CompiledMaterial {
  const standard = material.isMeshStandardMaterial === true;
  const physical = material.isMeshPhysicalMaterial === true;
  let model: CompiledMaterial['model'];
  if (standard) model = 'physical';
  else if (material.isMeshPhongMaterial) model = 'phong';
  else if (material.isMeshLambertMaterial) model = 'lambert';
  else if (material.isMeshToonMaterial) model = 'toon';
  else if (material.isMeshBasicMaterial || material.isMeshMatcapMaterial) model = 'basic';
  else {
    warnOnce(`${material.type} is not supported and is shaded as a Lambert material`);
    model = 'lambert';
  }
  if (material.isMeshMatcapMaterial) warnOnce('MeshMatcapMaterial is shaded as a basic material');
  const envMap = material.envMap
    ? table.addEnvironment(material.envMap, material.envMapIntensity ?? 1, material.envMapRotation)
    : -1;
  return {
    model,
    side: material.side ?? FrontSide,
    color: rgb(material.color),
    opacity: material.opacity ?? 1,
    transparent: material.transparent === true,
    alphaTest: material.alphaTest ?? 0,
    vertexColors: material.vertexColors === true,
    flatShading: material.flatShading === true,
    toneMapped: material.toneMapped !== false,
    map: table.add(material.map),
    alphaMap: table.add(material.alphaMap),
    emissiveMap: table.add(material.emissiveMap),
    normalMap: table.add(material.normalMap),
    aoMap: table.add(material.aoMap),
    roughnessMap: table.add(material.roughnessMap),
    metalnessMap: table.add(material.metalnessMap),
    emissive: material.emissive ? rgb(material.emissive, material.emissiveIntensity ?? 1) : [0, 0, 0],
    normalScale: material.normalScale ? [material.normalScale.x, material.normalScale.y] : [1, 1],
    aoMapIntensity: material.aoMapIntensity ?? 1,
    roughness: material.roughness ?? 1,
    metalness: material.metalness ?? 0,
    physical,
    ior: material.ior ?? 1.5,
    specularIntensity: material.specularIntensity ?? 1,
    specularColor: physical ? rgb(material.specularColor) : [1, 1, 1],
    transmission: physical ? material.transmission ?? 0 : 0,
    thickness: physical ? material.thickness ?? 0 : 0,
    shininess: material.shininess ?? 30,
    specular: material.specular ? rgb(material.specular) : [0.0666, 0.0666, 0.0666],
    envMap,
    envMapIntensity: material.envMapIntensity ?? 1,
    reflectivity: material.reflectivity ?? 1,
    combine: material.combine ?? 0,
  };
}

function compileLight(light: any): CompiledLight | null {
  const color = rgb(light.color, light.intensity ?? 1);
  if (light.isAmbientLight) return { type: 'ambient', color };
  if (light.isHemisphereLight) {
    return { type: 'hemisphere', color, groundColor: rgb(light.groundColor, light.intensity ?? 1), direction: normalize(positionOf(light.matrixWorld)) };
  }
  const position = positionOf(light.matrixWorld);
  if (light.isDirectionalLight) {
    const target = worldTarget(light.target);
    return {
      type: 'directional', color, castShadow: light.castShadow === true,
      direction: normalize([position[0] - target[0], position[1] - target[1], position[2] - target[2]]),
    };
  }
  if (light.isSpotLight) {
    const target = worldTarget(light.target);
    return {
      type: 'spot', color, position, castShadow: light.castShadow === true,
      direction: normalize([position[0] - target[0], position[1] - target[1], position[2] - target[2]]),
      distance: light.distance ?? 0, decay: light.decay ?? 2,
      coneCos: Math.cos(light.angle), penumbraCos: Math.cos(light.angle * (1 - light.penumbra)),
    };
  }
  if (light.isPointLight) {
    return { type: 'point', color, position, distance: light.distance ?? 0, decay: light.decay ?? 2, castShadow: light.castShadow === true };
  }
  warnOnce(`${light.type} is not supported and is left out`);
  return null;
}

// Column-major 4 x 4 product a * b.
function multiply4(a: ArrayLike<number>, b: ArrayLike<number>): number[] {
  const out = new Array<number>(16);
  for (let col = 0; col < 4; col++) {
    for (let row = 0; row < 4; row++) {
      out[col * 4 + row] = a[row]! * b[col * 4]! + a[4 + row]! * b[col * 4 + 1]! +
        a[8 + row]! * b[col * 4 + 2]! + a[12 + row]! * b[col * 4 + 3]!;
    }
  }
  return out;
}

/** Inverse transpose of a 4 x 4 matrix's upper 3 x 3, column-major, and that block's determinant. */
function normalMatrix(m: ArrayLike<number>): { n: number[]; det: number } {
  const a = m[0]!, b = m[4]!, c = m[8]!, d = m[1]!, e = m[5]!, f = m[9]!, g = m[2]!, h = m[6]!, i = m[10]!;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  const s = det !== 0 ? 1 / det : 0;
  // The inverse transpose is the cofactor matrix divided by the determinant.
  const n = [
    A * s, (-(b * i - c * h)) * s, (b * f - c * e) * s,
    B * s, (a * i - c * g) * s, (-(a * f - c * d)) * s,
    C * s, (-(a * h - b * g)) * s, (a * e - b * d) * s,
  ];
  // Read column by column, n is the cofactor matrix: the inverse transpose times det.
  return { n, det };
}

interface TriangleSink {
  push(p: number[], n: number[], uv: number[], color: number[] | null, material: number, flags: number, side: number): void;
}

/** Appends a mesh's triangles in world space, one instance at a time. */
function addMesh(mesh: any, materialIndex: (material: any) => number, sink: TriangleSink): void {
  const geometry = mesh.geometry;
  const position = geometry?.attributes?.position;
  if (!position) return;
  const normal = geometry.attributes.normal;
  const uv = geometry.attributes.uv;
  const colorAttribute = geometry.attributes.color;
  const index = geometry.index;
  const materials: any[] = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  const morphed = mesh.isSkinnedMesh === true || (geometry.morphAttributes?.position?.length > 0 && mesh.morphTargetInfluences);
  const Vector3 = mesh.position.constructor;
  const scratch = morphed ? new Vector3() : null;

  const total = index ? index.count : position.count;
  const start = Math.max(0, geometry.drawRange?.start ?? 0);
  const end = Math.min(total, start + (geometry.drawRange?.count ?? Infinity));
  const groups: { start: number; count: number; materialIndex: number }[] =
    geometry.groups?.length > 0 && Array.isArray(mesh.material)
      ? geometry.groups
      : [{ start: 0, count: Infinity, materialIndex: 0 }];

  const instanceCount = mesh.isInstancedMesh ? mesh.count : 1;
  const flagsBase = (mesh.castShadow ? TRI_CAST_SHADOW : 0) | (mesh.receiveShadow ? TRI_RECEIVE_SHADOW : 0);
  for (let instance = 0; instance < instanceCount; instance++) {
    const world: ArrayLike<number> = mesh.isInstancedMesh
      ? multiply4(mesh.matrixWorld.elements, mesh.instanceMatrix.array.subarray(instance * 16, instance * 16 + 16))
      : mesh.matrixWorld.elements;
    const { n: nm, det } = normalMatrix(world);
    const vertex = (i: number, out: number[], k: number) => {
      let x: number, y: number, z: number;
      if (scratch) {
        mesh.getVertexPosition(i, scratch);
        x = scratch.x; y = scratch.y; z = scratch.z;
      } else {
        x = position.getX(i); y = position.getY(i); z = position.getZ(i);
      }
      out[k] = world[0]! * x + world[4]! * y + world[8]! * z + world[12]!;
      out[k + 1] = world[1]! * x + world[5]! * y + world[9]! * z + world[13]!;
      out[k + 2] = world[2]! * x + world[6]! * y + world[10]! * z + world[14]!;
    };
    const p = new Array<number>(9), n = new Array<number>(9), t = new Array<number>(6), c = new Array<number>(12);
    for (const group of groups) {
      const material = materials[group.materialIndex ?? 0];
      if (!material || material.visible === false) continue;
      if (material.wireframe) {
        warnOnce('wireframe materials are left out');
        continue;
      }
      const matIndex = materialIndex(material);
      const opaque = material.transparent !== true && !(material.alphaTest > 0) && !(material.transmission > 0);
      const flags = flagsBase | (opaque ? TRI_OPAQUE : 0);
      const side = material.side ?? FrontSide;
      const useColors = material.vertexColors === true && colorAttribute;
      const from = Math.max(start, group.start), to = Math.min(end, group.start + group.count);
      for (let k = from; k + 2 < to; k += 3) {
        let ia = index ? index.getX(k) : k, ib = index ? index.getX(k + 1) : k + 1, ic = index ? index.getX(k + 2) : k + 2;
        // A mirroring transform reverses the winding; swap two vertices so the front side stays the front.
        if (det < 0) {
          const tmp = ib; ib = ic; ic = tmp;
        }
        const ids = [ia, ib, ic];
        for (let v = 0; v < 3; v++) {
          const id = ids[v]!;
          vertex(id, p, v * 3);
          if (normal) {
            const x = normal.getX(id), y = normal.getY(id), z = normal.getZ(id);
            const nx = nm[0]! * x + nm[3]! * y + nm[6]! * z;
            const ny = nm[1]! * x + nm[4]! * y + nm[7]! * z;
            const nz = nm[2]! * x + nm[5]! * y + nm[8]! * z;
            const length = Math.hypot(nx, ny, nz) || 1;
            n[v * 3] = nx / length; n[v * 3 + 1] = ny / length; n[v * 3 + 2] = nz / length;
          }
          if (uv) {
            t[v * 2] = uv.getX(id); t[v * 2 + 1] = uv.getY(id);
          } else {
            t[v * 2] = 0; t[v * 2 + 1] = 0;
          }
          if (useColors) {
            c[v * 4] = colorAttribute.getX(id); c[v * 4 + 1] = colorAttribute.getY(id); c[v * 4 + 2] = colorAttribute.getZ(id);
            c[v * 4 + 3] = colorAttribute.itemSize > 3 ? colorAttribute.getW(id) : 1;
          }
        }
        if (!normal || material.flatShading) {
          const ex = p[3]! - p[0]!, ey = p[4]! - p[1]!, ez = p[5]! - p[2]!;
          const fx = p[6]! - p[0]!, fy = p[7]! - p[1]!, fz = p[8]! - p[2]!;
          const face = normalize([ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx]);
          for (let v = 0; v < 3; v++) {
            n[v * 3] = face[0]; n[v * 3 + 1] = face[1]; n[v * 3 + 2] = face[2];
          }
        }
        sink.push(p, n, t, useColors ? c : null, matIndex, flags, side);
      }
    }
  }
}

/** Growable typed array, so large scenes don't need a counting pass first. */
class FloatBuffer {
  data: Float32Array;
  length = 0;
  constructor(capacity: number) {
    this.data = new Float32Array(capacity);
  }
  push(values: ArrayLike<number>, count: number): void {
    if (this.length + count > this.data.length) {
      const grown = new Float32Array(Math.max(this.data.length * 2, this.length + count));
      grown.set(this.data);
      this.data = grown;
    }
    for (let i = 0; i < count; i++) this.data[this.length + i] = values[i]!;
    this.length += count;
  }
}

/** Compiles only the geometry: triangles in world space, their BVH and per-triangle data. */
export function compileGeometry(meshes: any[], materialIndex: (material: any) => number): CompiledGeometry {
  const triangles = new FloatBuffer(1024), normals = new FloatBuffer(1024), uvs = new FloatBuffer(1024);
  const colors = new FloatBuffer(1024);
  const materialIds: number[] = [], flagList: number[] = [], sideList: number[] = [];
  let anyColors = false;
  const tri = new Array<number>(9);
  const white = [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  let maxCoordinate = 0;
  const sink: TriangleSink = {
    push(p, n, uv, color, material, flags, side) {
      tri[0] = p[0]!; tri[1] = p[1]!; tri[2] = p[2]!;
      for (let k = 0; k < 3; k++) {
        tri[3 + k] = p[3 + k]! - p[k]!;
        tri[6 + k] = p[6 + k]! - p[k]!;
      }
      for (let k = 0; k < 9; k++) maxCoordinate = Math.max(maxCoordinate, Math.abs(p[k]!));
      triangles.push(tri, 9);
      normals.push(n, 9);
      uvs.push(uv, 6);
      if (color && !anyColors) {
        // Back-fill white for the triangles before the first one with colours.
        anyColors = true;
        for (let i = 0; i < materialIds.length; i++) colors.push(white, 12);
      }
      if (anyColors) colors.push(color ?? white, 12);
      materialIds.push(material);
      flagList.push(flags);
      sideList.push(side);
    },
  };
  for (const mesh of meshes) addMesh(mesh, materialIndex, sink);

  const count = materialIds.length;
  const source = triangles.data.subarray(0, count * 9);
  const { bvh, order } = buildBvh(source, count);

  // Store everything in BVH order, so each leaf's triangles are contiguous.
  const outTriangles = new Float32Array(count * 9), outNormals = new Float32Array(count * 9);
  const outUvs = new Float32Array(count * 6), outTangents = new Float32Array(count * 4);
  const outColors = new Float32Array(anyColors ? count * 12 : 0);
  const outMaterials = new Uint32Array(count), outFlags = new Uint8Array(count), outSides = new Uint8Array(count);
  let minX = Infinity, minY = Infinity, minZ = Infinity, maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
  for (let i = 0; i < count; i++) {
    const s = order[i]!;
    outTriangles.set(source.subarray(s * 9, s * 9 + 9), i * 9);
    outNormals.set(normals.data.subarray(s * 9, s * 9 + 9), i * 9);
    outUvs.set(uvs.data.subarray(s * 6, s * 6 + 6), i * 6);
    if (anyColors) outColors.set(colors.data.subarray(s * 12, s * 12 + 12), i * 12);
    outMaterials[i] = materialIds[s]!;
    outFlags[i] = flagList[s]!;
    outSides[i] = sideList[s]!;
    const o = i * 9;
    for (let v = 0; v < 3; v++) {
      const x = outTriangles[o]! + (v === 1 ? outTriangles[o + 3]! : v === 2 ? outTriangles[o + 6]! : 0);
      const y = outTriangles[o + 1]! + (v === 1 ? outTriangles[o + 4]! : v === 2 ? outTriangles[o + 7]! : 0);
      const z = outTriangles[o + 2]! + (v === 1 ? outTriangles[o + 5]! : v === 2 ? outTriangles[o + 8]! : 0);
      if (x < minX) minX = x; if (y < minY) minY = y; if (z < minZ) minZ = z;
      if (x > maxX) maxX = x; if (y > maxY) maxY = y; if (z > maxZ) maxZ = z;
    }
    writeTangent(outTriangles, outUvs, outTangents, i);
  }
  const diagonal = count > 0 ? Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) : 1;
  return {
    triangleCount: count,
    triangles: outTriangles,
    normals: outNormals,
    uvs: outUvs,
    tangents: outTangents,
    colors: outColors,
    materials: outMaterials,
    flags: outFlags,
    sides: outSides,
    bvh,
    // Large enough to clear float32 rounding of the vertex positions, small against the scene.
    epsilon: Math.max(diagonal * 1e-5, maxCoordinate * 2e-6, 1e-7),
  };
}

/** Per-triangle tangent from its uvs, for normal mapping. Falls back to any perpendicular. */
function writeTangent(triangles: Float32Array, uvs: Float32Array, tangents: Float32Array, i: number): void {
  const o = i * 9, u = i * 6;
  const e1x = triangles[o + 3]!, e1y = triangles[o + 4]!, e1z = triangles[o + 5]!;
  const e2x = triangles[o + 6]!, e2y = triangles[o + 7]!, e2z = triangles[o + 8]!;
  const du1 = uvs[u + 2]! - uvs[u]!, dv1 = uvs[u + 3]! - uvs[u + 1]!;
  const du2 = uvs[u + 4]! - uvs[u]!, dv2 = uvs[u + 5]! - uvs[u + 1]!;
  const nx = e1y * e2z - e1z * e2y, ny = e1z * e2x - e1x * e2z, nz = e1x * e2y - e1y * e2x;
  const d = du1 * dv2 - du2 * dv1;
  let tx: number, ty: number, tz: number, sign = 1;
  if (Math.abs(d) > 1e-20) {
    const r = 1 / d;
    tx = (e1x * dv2 - e2x * dv1) * r; ty = (e1y * dv2 - e2y * dv1) * r; tz = (e1z * dv2 - e2z * dv1) * r;
    const bx = (e2x * du1 - e1x * du2) * r, by = (e2y * du1 - e1y * du2) * r, bz = (e2z * du1 - e1z * du2) * r;
    // Handedness: whether the uv bitangent agrees with N x T.
    const cx = ny * tz - nz * ty, cy = nz * tx - nx * tz, cz = nx * ty - ny * tx;
    sign = cx * bx + cy * by + cz * bz < 0 ? -1 : 1;
  } else {
    if (Math.abs(nx) < 0.9 * Math.hypot(nx, ny, nz)) {
      tx = 0; ty = -nz; tz = ny;
    } else {
      tx = nz; ty = 0; tz = -nx;
    }
  }
  const length = Math.hypot(tx, ty, tz) || 1;
  tangents[i * 4] = tx / length; tangents[i * 4 + 1] = ty / length; tangents[i * 4 + 2] = tz / length;
  tangents[i * 4 + 3] = sign;
}

function compileBackground(scene: any, table: TextureTable): CompiledBackground {
  const background = scene.background;
  if (!background) return { kind: 'clear' };
  if (background.isColor) return { kind: 'color', color: rgb(background) };
  if (background.isTexture) {
    const intensity = scene.backgroundIntensity ?? 1;
    if (background.isCubeTexture || background.mapping === 301 || background.mapping === 302 ||
        background.mapping === 303 || background.mapping === 304) {
      const environment = table.addEnvironment(background, intensity, scene.backgroundRotation);
      return environment >= 0 ? { kind: 'environment', environment, intensity } : { kind: 'clear' };
    }
    const texture = table.add(background);
    return texture >= 0 ? { kind: 'screen', texture, intensity } : { kind: 'clear' };
  }
  return { kind: 'clear' };
}

function compileFog(fog: any): CompiledFog | null {
  if (!fog) return null;
  if (fog.isFogExp2) return { kind: 'exp2', color: rgb(fog.color), near: 0, far: 0, density: fog.density };
  if (fog.isFog) return { kind: 'linear', color: rgb(fog.color), near: fog.near, far: fog.far, density: 0 };
  return null;
}

/**
 * The parts of a scene that are cheap to recompile: materials, textures, lights, background,
 * environment and fog. Kept apart from geometry, so changing a colour or a light doesn't
 * rebuild the BVH.
 */
export interface SceneShading {
  materials: CompiledMaterial[];
  textures: CompiledScene['textures'];
  environments: CompiledScene['environments'];
  lights: CompiledLight[];
  background: CompiledBackground;
  environment: number;
  fog: CompiledFog | null;
  /** Material objects in the order of `materials`, for mapping triangles to materials. */
  materialObjects: any[];
}

/** Collects the meshes and compiles the shading of a scene, as `compileScene` does. */
export function compileShading(scene: Scene, camera: Camera | undefined, options: CompileOptions = {}):
  { shading: SceneShading; meshes: any[] } {
  if ((scene as any).matrixWorldAutoUpdate !== false) scene.updateMatrixWorld();
  const { meshes, lights } = collectObjects(scene, camera, options);
  const table = new TextureTable();
  const materialObjects: any[] = [];
  const materials: CompiledMaterial[] = [];
  const indices = new Map<any, number>();
  for (const mesh of meshes) {
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      if (!material || indices.has(material)) continue;
      indices.set(material, materials.length);
      materialObjects.push(material);
      materials.push(compileMaterial(material, table));
    }
  }
  const s = scene as any;
  const background = compileBackground(s, table);
  const environment = s.environment
    ? table.addEnvironment(s.environment, s.environmentIntensity ?? 1, s.environmentRotation)
    : -1;
  return {
    shading: {
      materials,
      textures: table.textures,
      environments: table.environments,
      lights: lights.map(compileLight).filter((light): light is CompiledLight => light !== null),
      background,
      environment,
      fog: compileFog(s.fog),
      materialObjects,
    },
    meshes,
  };
}

/** Compiles a three.js scene into the plain data the ray tracer renders. */
export function compileScene(scene: Scene, camera?: Camera, options: CompileOptions = {}): CompiledScene {
  const { shading, meshes } = compileShading(scene, camera, options);
  const indices = new Map<any, number>(shading.materialObjects.map((material, i) => [material, i]));
  const geometry = compileGeometry(meshes, material => indices.get(material) ?? 0);
  return {
    geometry,
    materials: shading.materials,
    textures: shading.textures,
    environments: shading.environments,
    lights: shading.lights,
    background: shading.background,
    environment: shading.environment,
    fog: shading.fog,
  };
}

/** Compiles a three.js camera's matrices. Works for perspective and orthographic cameras. */
export function compileCamera(camera: Camera): CompiledCamera {
  if (!camera.parent) camera.updateMatrixWorld();
  const world = Array.from(camera.matrixWorld.elements);
  return {
    projectionInverse: Array.from(camera.projectionMatrixInverse.elements),
    world,
    orthographic: (camera as any).isOrthographicCamera === true,
    forward: normalize([-world[8]!, -world[9]!, -world[10]!]),
    position: [world[12]!, world[13]!, world[14]!],
  };
}

