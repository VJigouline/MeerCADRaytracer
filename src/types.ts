// Plain-data form of a three.js scene, as the ray tracer uses it. Everything here survives
// structured cloning, so a compiled scene can be posted to Web Workers unchanged.

/** RGB triple in linear sRGB. */
export type RGB = [number, number, number];

/** A texture's pixels, decoded once so they can be sampled without three.js or the DOM. */
export interface CompiledTexture {
  width: number;
  height: number;
  /** RGBA texels, first row first. 8-bit textures stay 8-bit to save memory. */
  data: Uint8Array | Float32Array;
  /** 8-bit colour channels are sRGB encoded and must be decoded to linear when sampled. */
  srgb: boolean;
  /** three.js flipY: texture v = 0 is the last row of the data instead of the first. */
  flipY: boolean;
  wrapS: number;
  wrapT: number;
  /** three.js Texture.matrix, a column-major 3 x 3 uv transform. */
  matrix: number[];
}

export type CompiledEnvironment =
  | {
      kind: 'cube';
      /** Texture indices of the faces, in three.js order: +x, -x, +y, -y, +z, -z. */
      faces: number[];
      /** Mirror x, as three.js does for cube textures that are not render targets. */
      flipX: boolean;
      /** Column-major 3 x 3 matrix applied to a direction before the lookup. */
      rotation: number[];
      intensity: number;
    }
  | {
      kind: 'equirect';
      texture: number;
      rotation: number[];
      intensity: number;
    };

export type MaterialModel = 'physical' | 'phong' | 'lambert' | 'toon' | 'basic';

export interface CompiledMaterial {
  model: MaterialModel;
  /** three.js FrontSide, BackSide or DoubleSide. */
  side: number;
  color: RGB;
  opacity: number;
  transparent: boolean;
  alphaTest: number;
  vertexColors: boolean;
  flatShading: boolean;
  toneMapped: boolean;
  /** Texture indices into CompiledScene.textures, or -1. */
  map: number;
  alphaMap: number;
  emissiveMap: number;
  normalMap: number;
  aoMap: number;
  roughnessMap: number;
  metalnessMap: number;
  /** Emissive colour multiplied by emissiveIntensity. */
  emissive: RGB;
  normalScale: [number, number];
  aoMapIntensity: number;
  // Physical model.
  roughness: number;
  metalness: number;
  /** True for MeshPhysicalMaterial, whose specular colour comes from ior and the specular inputs. */
  physical: boolean;
  ior: number;
  specularIntensity: number;
  specularColor: RGB;
  transmission: number;
  thickness: number;
  // Phong model.
  shininess: number;
  specular: RGB;
  // Environment reflections.
  envMap: number;
  envMapIntensity: number;
  reflectivity: number;
  combine: number;
}

export type CompiledLight =
  | { type: 'ambient'; color: RGB }
  | { type: 'hemisphere'; color: RGB; groundColor: RGB; direction: RGB }
  | { type: 'directional'; color: RGB; direction: RGB; castShadow: boolean }
  | {
      type: 'point';
      color: RGB;
      position: RGB;
      distance: number;
      decay: number;
      castShadow: boolean;
    }
  | {
      type: 'spot';
      color: RGB;
      position: RGB;
      direction: RGB;
      distance: number;
      decay: number;
      coneCos: number;
      penumbraCos: number;
      castShadow: boolean;
    };

export interface CompiledFog {
  kind: 'linear' | 'exp2';
  color: RGB;
  near: number;
  far: number;
  density: number;
}

export type CompiledBackground =
  | { kind: 'clear' }
  | { kind: 'color'; color: RGB }
  | { kind: 'screen'; texture: number; intensity: number }
  | { kind: 'environment'; environment: number; intensity: number };

/**
 * Triangle flags, one byte per triangle.
 * OPAQUE: the triangle always blocks light, so shadow rays can stop at it.
 */
export const TRI_OPAQUE = 1;
export const TRI_CAST_SHADOW = 2;
export const TRI_RECEIVE_SHADOW = 4;

export interface CompiledGeometry {
  triangleCount: number;
  /** Per triangle: v0, edge v1 - v0, edge v2 - v0, in world space. 9 floats. */
  triangles: Float32Array;
  /** Per triangle: the three vertex normals in world space, facing the front side. 9 floats. */
  normals: Float32Array;
  /** Per triangle: the three vertex uvs. 6 floats. */
  uvs: Float32Array;
  /** Per triangle: tangent xyz and handedness, for normal maps. 4 floats. */
  tangents: Float32Array;
  /** Per triangle: the three vertex colours, RGBA. 12 floats. Empty when no mesh has colours. */
  colors: Float32Array;
  materials: Uint32Array;
  flags: Uint8Array;
  /** Per triangle, which side the ray tracer culls: three.js FrontSide, BackSide or DoubleSide. */
  sides: Uint8Array;
  bvh: CompiledBvh;
  /** Distance to push secondary ray origins off a surface, scaled to the scene's size. */
  epsilon: number;
}

export interface CompiledBvh {
  /** Per node: min xyz, max xyz. */
  bounds: Float32Array;
  /**
   * Per node: first, count, axis. A leaf has count > 0 and covers triangles first to
   * first + count - 1. An inner node has count 0, children first and first + 1, and the split axis.
   */
  nodes: Int32Array;
  nodeCount: number;
}

export interface CompiledScene {
  geometry: CompiledGeometry;
  materials: CompiledMaterial[];
  textures: CompiledTexture[];
  environments: CompiledEnvironment[];
  lights: CompiledLight[];
  background: CompiledBackground;
  /** scene.environment, used for reflections that leave the scene, or -1. */
  environment: number;
  fog: CompiledFog | null;
}

export interface CompiledCamera {
  /** Column-major projectionMatrixInverse. */
  projectionInverse: number[];
  /** Column-major matrixWorld. */
  world: number[];
  orthographic: boolean;
  /** World-space viewing direction, for fog depth. */
  forward: RGB;
  position: RGB;
}

/** Settings that change how rays are traced and pixels are written, but not the scene. */
export interface TraceSettings {
  maxBounces: number;
  shadows: 'all' | 'castShadow' | 'none';
  globalIllumination: boolean;
  toneMapping: number;
  toneMappingExposure: number;
  /** Clear colour and alpha used when scene.background is null. Linear RGB. */
  clearColor: RGB;
  clearAlpha: number;
  /** Seed mixed into every random sequence, so separate renders can differ. */
  seed: number;
}

export interface Tile {
  x: number;
  y: number;
  width: number;
  height: number;
}
