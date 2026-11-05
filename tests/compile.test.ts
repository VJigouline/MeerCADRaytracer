import * as THREE from 'three';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { describe, expect, it, vi } from 'vitest';
import { compileCamera, compileScene } from '../src/compile.js';
import { TRI_CAST_SHADOW, TRI_OPAQUE, TRI_RECEIVE_SHADOW } from '../src/types.js';
import { sampleTexture } from '../src/textures.js';
import { topCamera } from './helpers.js';

function vertices(scene: ReturnType<typeof compileScene>, k: number): number[][] {
  const t = scene.geometry.triangles, o = k * 9;
  const v0 = [t[o]!, t[o + 1]!, t[o + 2]!];
  return [v0, v0.map((x, a) => x + t[o + 3 + a]!), v0.map((x, a) => x + t[o + 6 + a]!)];
}

describe('compileScene', () => {
  it('places triangles in world space through nested transforms', () => {
    const scene = new THREE.Scene();
    const group = new THREE.Group();
    group.position.set(10, 0, 0);
    group.rotation.z = Math.PI / 2;
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
    mesh.position.set(1, 0, 0);
    group.add(mesh);
    scene.add(group);
    const compiled = compileScene(scene);
    expect(compiled.geometry.triangleCount).toBe(2);
    const xs: number[] = [], ys: number[] = [];
    for (let k = 0; k < 2; k++) for (const v of vertices(compiled, k)) { xs.push(v[0]!); ys.push(v[1]!); }
    // The plane spans -1..1 around (1, 0), rotated 90 degrees about z and moved to x = 10: x 9..11, y 0..2.
    expect(Math.min(...xs)).toBeCloseTo(9);
    expect(Math.max(...xs)).toBeCloseTo(11);
    expect(Math.min(...ys)).toBeCloseTo(0);
    expect(Math.max(...ys)).toBeCloseTo(2);
  });

  it('keeps normals perpendicular to surfaces under non-uniform scale', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
    mesh.rotation.x = Math.PI / 4;
    mesh.scale.set(1, 3, 1);
    scene.add(mesh);
    const compiled = compileScene(scene);
    const t = compiled.geometry.triangles, n = compiled.geometry.normals;
    for (let k = 0; k < 2; k++) {
      for (let v = 0; v < 3; v++) {
        const normal = [n[k * 9 + v * 3]!, n[k * 9 + v * 3 + 1]!, n[k * 9 + v * 3 + 2]!];
        expect(Math.hypot(...normal)).toBeCloseTo(1);
        for (const e of [3, 6]) {
          const edge = [t[k * 9 + e]!, t[k * 9 + e + 1]!, t[k * 9 + e + 2]!];
          expect(normal[0]! * edge[0]! + normal[1]! * edge[1]! + normal[2]! * edge[2]!).toBeCloseTo(0, 5);
        }
      }
    }
  });

  it('keeps the front side in front under a mirroring scale', () => {
    for (const sx of [1, -1]) {
      const scene = new THREE.Scene();
      const mesh = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshStandardMaterial());
      mesh.scale.set(sx, 1, 1);
      scene.add(mesh);
      const t = compileScene(scene).geometry.triangles;
      // Geometric normal e1 x e2 must face +z, the plane's front, either way.
      const nz = t[3]! * t[7]! - t[4]! * t[6]!;
      expect(nz).toBeGreaterThan(0);
    }
  });

  it('maps geometry groups to the materials of a material array', () => {
    const scene = new THREE.Scene();
    const materials = [0, 1, 2, 3, 4, 5].map(i => new THREE.MeshLambertMaterial({ color: new THREE.Color(i / 5, 0, 0) }));
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(), materials));
    const compiled = compileScene(scene);
    expect(compiled.materials).toHaveLength(6);
    expect(compiled.geometry.triangleCount).toBe(12);
    const counts = new Map<number, number>();
    for (const m of compiled.geometry.materials) counts.set(m, (counts.get(m) ?? 0) + 1);
    expect([...counts.values()]).toEqual([2, 2, 2, 2, 2, 2]);
  });

  it('expands instanced meshes', () => {
    const scene = new THREE.Scene();
    const mesh = new THREE.InstancedMesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial(), 3);
    for (let i = 0; i < 3; i++) mesh.setMatrixAt(i, new THREE.Matrix4().makeTranslation(i * 10, 0, 0));
    scene.add(mesh);
    const compiled = compileScene(scene);
    expect(compiled.geometry.triangleCount).toBe(6);
    const xs = [0, 1, 2, 3, 4, 5].map(k => vertices(compiled, k)[0]![0]!);
    expect(Math.max(...xs)).toBeGreaterThan(19);
  });

  it('leaves out hidden objects, helpers, gizmos, wireframes, other layers and filtered objects', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const scene = new THREE.Scene();
    const camera = topCamera();
    const keep = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    const hidden = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    hidden.visible = false;
    const wire = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ wireframe: true }));
    const otherLayer = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    otherLayer.layers.set(3);
    const filtered = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    filtered.name = 'skip me';
    const optedOut = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial());
    optedOut.userData.raytrace = false;
    const light = new THREE.PointLight();
    const helper = new THREE.PointLightHelper(light);
    const controls = new TransformControls(camera);
    controls.attach(keep);
    scene.add(keep, hidden, wire, otherLayer, filtered, optedOut, light, helper, controls.getHelper());
    const compiled = compileScene(scene, camera, { filter: object => object.name !== 'skip me' });
    expect(compiled.geometry.triangleCount).toBe(2);
    expect(compiled.lights).toHaveLength(1);
    warn.mockRestore();
  });

  it('compiles lights with three.js colours, directions and cone angles', () => {
    const scene = new THREE.Scene();
    const ambient = new THREE.AmbientLight(0xff0000, 2);
    const sun = new THREE.DirectionalLight(0xffffff, 3);
    sun.position.set(0, 10, 0);
    sun.target.position.set(0, 0, 0);
    const spot = new THREE.SpotLight(0xffffff, 5, 20, Math.PI / 6, 0.5, 1);
    spot.position.set(1, 2, 3);
    spot.target.position.set(1, 2, 0);
    scene.add(ambient, sun, spot, spot.target);
    const lights = compileScene(scene).lights;
    expect(lights[0]).toEqual({ type: 'ambient', color: [2, 0, 0] });
    expect(lights[1]).toMatchObject({ type: 'directional', color: [3, 3, 3], direction: [0, 1, 0] });
    const s = lights[2]!;
    expect(s.type).toBe('spot');
    if (s.type !== 'spot') return;
    expect(s.direction).toEqual([0, 0, 1]);
    expect(s.coneCos).toBeCloseTo(Math.cos(Math.PI / 6));
    expect(s.penumbraCos).toBeCloseTo(Math.cos(Math.PI / 12));
    expect(s.distance).toBe(20);
    expect(s.decay).toBe(1);
  });

  it('sets the shadow and opacity flags per triangle', () => {
    const scene = new THREE.Scene();
    const opaque = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial());
    opaque.castShadow = true;
    const glass = new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshStandardMaterial({ transparent: true, opacity: 0.5 }));
    glass.receiveShadow = true;
    glass.position.x = 5;
    scene.add(opaque, glass);
    const compiled = compileScene(scene);
    const flags = [...compiled.geometry.flags];
    expect(flags.filter(f => f === (TRI_OPAQUE | TRI_CAST_SHADOW))).toHaveLength(2);
    expect(flags.filter(f => f === TRI_RECEIVE_SHADOW)).toHaveLength(2);
  });

  it('decodes DataTextures and samples them with the texture transform and wrapping', () => {
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const texture = new THREE.DataTexture(data, 2, 2);
    texture.needsUpdate = true;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    texture.repeat.set(2, 1);
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture })));
    const compiled = compileScene(scene);
    expect(compiled.textures).toHaveLength(1);
    const t = compiled.textures[0]!;
    expect(t.srgb).toBe(false);
    const out = [0, 0, 0, 0];
    // Repeat 2 on u: u = 0.125 and 0.625 both land on the first column's centre.
    sampleTexture(t, 0.125, 0.25, out);
    expect(out.slice(0, 3)).toEqual([1, 0, 0]);
    sampleTexture(t, 0.625, 0.25, out);
    expect(out.slice(0, 3)).toEqual([1, 0, 0]);
    sampleTexture(t, 0.375, 0.75, out);
    expect(out.slice(0, 3)).toEqual([1, 1, 1]);
  });

  it('uses the current pose of morph targets', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(2, 2);
    const moved = geometry.attributes.position!.clone();
    for (let i = 0; i < moved.count; i++) moved.setZ(i, 5);
    geometry.morphAttributes.position = [moved];
    const mesh = new THREE.Mesh(geometry, new THREE.MeshBasicMaterial());
    mesh.updateMorphTargets();
    mesh.morphTargetInfluences![0] = 0.5;
    scene.add(mesh);
    const compiled = compileScene(scene);
    // Morph targets are absolute positions blended by influence: z = 0 + 0.5 * (5 - 0).
    expect(vertices(compiled, 0)[0]![2]).toBeCloseTo(2.5);
  });

  it('reads half-float DataTextures', () => {
    const half = (v: number) => THREE.DataUtils.toHalfFloat(v);
    const texture = new THREE.DataTexture(new Uint16Array([half(0.25), half(2), half(4), half(1)]), 1, 1, THREE.RGBAFormat, THREE.HalfFloatType);
    texture.needsUpdate = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(), new THREE.MeshBasicMaterial({ map: texture })));
    const out = [0, 0, 0, 0];
    sampleTexture(compileScene(scene).textures[0]!, 0.5, 0.5, out);
    expect(out).toEqual([0.25, 2, 4, 1]);
  });

  it('compiles cameras', () => {
    const camera = topCamera();
    const compiled = compileCamera(camera);
    expect(compiled.orthographic).toBe(true);
    expect(compiled.forward[2]).toBeCloseTo(-1);
    expect(compiled.position).toEqual([0, 0, 10]);
  });

  it('compiles backgrounds, environments and fog', () => {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0.5, 0.25, 0);
    scene.fog = new THREE.Fog(0xffffff, 1, 10);
    const env = new THREE.DataTexture(new Float32Array([1, 1, 1, 1, 2, 2, 2, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
    env.mapping = THREE.EquirectangularReflectionMapping;
    env.needsUpdate = true;
    scene.environment = env;
    const compiled = compileScene(scene);
    expect(compiled.background).toEqual({ kind: 'color', color: [0.5, 0.25, 0] });
    expect(compiled.fog).toMatchObject({ kind: 'linear', near: 1, far: 10 });
    expect(compiled.environment).toBe(0);
    expect(compiled.environments[0]!.kind).toBe('equirect');
  });
});
