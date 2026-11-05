import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { dfg, fresnelWeight } from '../src/brdf.js';
import { raytrace } from '../src/raytrace.js';
import { floor, ONE_LEVEL, overheadLight, render, topCamera } from './helpers.js';

const centre = (r: ReturnType<typeof render>) => r.at(8, 8);

describe('raytrace shading matches three.js formulas', () => {
  it('Lambert: irradiance times colour over pi', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.5, 0.25, 1) })), overheadLight(Math.PI));
    const [r, g, b, a] = centre(render(scene, topCamera()));
    expect(r).toBeCloseTo(0.5, 2);
    expect(g).toBeCloseTo(0.25, 2);
    expect(b).toBeCloseTo(1, 2);
    expect(a).toBe(1);
  });

  it('ambient light: colour times intensity over pi', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) })), new THREE.AmbientLight(0xffffff, Math.PI));
    expect(Math.abs(centre(render(scene, topCamera()))[0] - 0.5)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('hemisphere light: sky colour on surfaces facing it', () => {
    const scene = new THREE.Scene();
    const hemi = new THREE.HemisphereLight(0xffffff, 0x000000, Math.PI);
    hemi.position.set(0, 0, 1);
    scene.add(floor(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) })), hemi);
    expect(Math.abs(centre(render(scene, topCamera()))[0] - 0.5)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('MeshStandardMaterial: GGX specular with multi-scattering compensation plus Fresnel-weighted diffuse', () => {
    const scene = new THREE.Scene();
    const c = 0.5;
    scene.add(floor(new THREE.MeshStandardMaterial({ color: new THREE.Color(c, c, c), roughness: 1, metalness: 0 })), overheadLight(Math.PI));
    // Head-on: N = V = L = H, so dotNL = dotNV = dotNH = dotVH = 1. With roughness 1, alpha = 1:
    // D = 1 / pi, V = 0.5 / 2. three.js's DFG table supplies the compensation.
    const fw = fresnelWeight(1);
    const F = 0.04 * (1 - fw) + fw;
    const out = [0, 0];
    dfg(1, 1, out);
    const compensation = 1 + 0.04 * (1 / (out[0]! + out[1]!) - 1);
    const specular = F * 0.25 * (1 / Math.PI) * compensation;
    const diffuse = (c / Math.PI) * (1 - F);
    const expected = Math.PI * (specular + diffuse);
    expect(Math.abs(centre(render(scene, topCamera()))[0] - expected)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('MeshPhongMaterial: Lambert plus Blinn-Phong highlight', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshPhongMaterial({ color: new THREE.Color(0.2, 0.2, 0.2), specular: new THREE.Color(0.1, 0.1, 0.1), shininess: 10 })), overheadLight(Math.PI));
    const fw = fresnelWeight(1);
    const specular = (0.1 * (1 - fw) + fw) * 0.25 * (1 / Math.PI) * (10 * 0.5 + 1);
    const expected = Math.PI * (0.2 / Math.PI + specular);
    expect(Math.abs(centre(render(scene, topCamera()))[0] - expected)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('point light: inverse square falloff', () => {
    const scene = new THREE.Scene();
    const light = new THREE.PointLight(0xffffff, 4, 0, 2);
    light.position.set(0, 0, 2);
    scene.add(floor(new THREE.MeshLambertMaterial({ color: 0xffffff })), light);
    // Irradiance 4 / 2^2 = 1, radiance 1 / pi.
    expect(Math.abs(centre(render(scene, topCamera()))[0] - 1 / Math.PI)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('spot light: lit inside the cone, dark outside', () => {
    const scene = new THREE.Scene();
    const spot = new THREE.SpotLight(0xffffff, 20, 0, Math.PI / 12, 0, 0);
    spot.position.set(0, 0, 2);
    scene.add(floor(new THREE.MeshLambertMaterial({ color: 0xffffff })), spot, spot.target);
    const image = render(scene, topCamera());
    expect(centre(image)[0]).toBeGreaterThan(0.5);
    expect(image.at(0, 0)[0]).toBe(0);
  });

  it('emission, with no lights', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshStandardMaterial({ color: 0x000000, emissive: 0xff0000, emissiveIntensity: 0.5 })));
    const [r, g] = centre(render(scene, topCamera()));
    expect(Math.abs(r - 0.5)).toBeLessThanOrEqual(ONE_LEVEL);
    expect(g).toBe(0);
  });

  it('vertex colours multiply the material colour', () => {
    const scene = new THREE.Scene();
    const geometry = new THREE.PlaneGeometry(4, 4);
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(new Array(4).fill([0, 1, 0]).flat(), 3));
    scene.add(new THREE.Mesh(geometry, new THREE.MeshBasicMaterial({ vertexColors: true })));
    expect(centre(render(scene, topCamera())).slice(0, 3)).toEqual([0, 1, 0]);
  });

  it('textures: the DataTexture texel under each pixel', () => {
    // Rows bottom to top, as DataTexture data is: red, green / blue, white.
    const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
    const texture = new THREE.DataTexture(data, 2, 2);
    texture.needsUpdate = true;
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), new THREE.MeshBasicMaterial({ map: texture })));
    const image = render(scene, topCamera());
    const near = (p: number[], q: number[]) => p.slice(0, 3).every((v, i) => Math.abs(v - q[i]!) < 0.2);
    expect(near(image.at(3, 12), [1, 0, 0])).toBe(true); // bottom left
    expect(near(image.at(12, 12), [0, 1, 0])).toBe(true); // bottom right
    expect(near(image.at(3, 3), [0, 0, 1])).toBe(true); // top left
    expect(near(image.at(12, 3), [1, 1, 1])).toBe(true); // top right
  });

  it('Reinhard tone mapping, as WebGLRenderer.toneMapping', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshLambertMaterial({ color: 0xffffff })), overheadLight(Math.PI));
    const value = centre(render(scene, topCamera(), { toneMapping: THREE.ReinhardToneMapping }))[0];
    expect(Math.abs(value - 0.5)).toBeLessThanOrEqual(ONE_LEVEL);
  });

  it('sRGB output encodes the linear result', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshBasicMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) })));
    const image = render(scene, topCamera(), { outputColorSpace: 'srgb' });
    expect(Math.abs(centre(image)[0] - 0.7354)).toBeLessThanOrEqual(ONE_LEVEL * 1.5);
  });

  it('linear fog at the first surface', () => {
    const scene = new THREE.Scene();
    scene.fog = new THREE.Fog(0xffffff, 0, 20);
    scene.add(floor(new THREE.MeshBasicMaterial({ color: 0x000000 })));
    // The floor is 10 from the camera: smoothstep(0, 20, 10) = 0.5.
    expect(Math.abs(centre(render(scene, topCamera()))[0] - 0.5)).toBeLessThanOrEqual(ONE_LEVEL);
  });
});

describe('raytrace visibility', () => {
  it('shows the clear colour where nothing is hit, transparent by default', () => {
    const scene = new THREE.Scene();
    expect(centre(render(scene, topCamera()))).toEqual([0, 0, 0, 0]);
    expect(centre(render(scene, topCamera(), { clearColor: [0, 0, 1], clearAlpha: 1 }))).toEqual([0, 0, 1, 1]);
    scene.background = new THREE.Color(1, 0, 0);
    expect(centre(render(scene, topCamera()))).toEqual([1, 0, 0, 1]);
  });

  it('culls back faces of FrontSide materials and shows both sides of DoubleSide ones', () => {
    const scene = new THREE.Scene();
    const material = new THREE.MeshLambertMaterial({ color: 0xffffff });
    const plane = floor(material);
    plane.rotation.x = Math.PI; // now faces -z, away from the camera
    scene.add(plane, overheadLight(Math.PI));
    expect(centre(render(scene, topCamera()))[3]).toBe(0);
    material.side = THREE.DoubleSide;
    // The back face is shaded with its normal flipped towards the viewer, so the overhead light lights it.
    const [r, , , a] = centre(render(scene, topCamera()));
    expect(a).toBe(1);
    expect(r).toBeCloseTo(1, 2);
  });

  it('casts shadows, with three.js-style castShadow flags as an option', () => {
    const scene = new THREE.Scene();
    const ground = floor(new THREE.MeshLambertMaterial({ color: new THREE.Color(0.5, 0.5, 0.5) }));
    // A blocker facing away from the camera: culled for camera rays, but still in the light's way.
    const blocker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial());
    blocker.rotation.x = Math.PI;
    blocker.position.z = 2;
    const sun = overheadLight(Math.PI);
    scene.add(ground, blocker, sun, new THREE.AmbientLight(0xffffff, Math.PI * 0.2));
    const camera = topCamera();
    const lit = 0.5 * 1.2, shadowed = 0.5 * 0.2;
    const near = (v: number, e: number) => Math.abs(v - e) <= ONE_LEVEL;
    expect(near(centre(render(scene, camera))[0], shadowed)).toBe(true);
    expect(near(render(scene, camera).at(0, 0)[0], lit)).toBe(true);
    expect(near(centre(render(scene, camera, { shadows: 'none' }))[0], lit)).toBe(true);
    expect(near(centre(render(scene, camera, { shadows: 'castShadow' }))[0], lit)).toBe(true);
    sun.castShadow = blocker.castShadow = ground.receiveShadow = true;
    expect(near(centre(render(scene, camera, { shadows: 'castShadow' }))[0], shadowed)).toBe(true);
  });

  it('lets light through transparent and transmissive blockers', () => {
    const scene = new THREE.Scene();
    const ground = floor(new THREE.MeshLambertMaterial({ color: 0xffffff }));
    const blocker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshLambertMaterial({ transparent: true, opacity: 0.25 }));
    blocker.rotation.x = Math.PI;
    blocker.position.z = 2;
    scene.add(ground, blocker, overheadLight(Math.PI));
    expect(centre(render(scene, topCamera()))[0]).toBeCloseTo(0.75, 2);
  });

  it('reflects other objects in a mirror', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0 })));
    // A red panel behind the camera, facing the mirror. Camera rays start in front of it.
    const panel = new THREE.Mesh(new THREE.PlaneGeometry(10, 10), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    panel.rotation.x = Math.PI;
    panel.position.z = 20;
    scene.add(panel);
    const [r, g, b] = centre(render(scene, topCamera()));
    expect(r).toBeGreaterThan(0.85);
    expect(g).toBe(0);
    expect(b).toBe(0);
    // Without bounces there is nothing to reflect.
    expect(centre(render(scene, topCamera(), { maxBounces: 0 }))[0]).toBe(0);
  });

  it('reflects an environment map where reflections leave the scene', () => {
    const scene = new THREE.Scene();
    const env = new THREE.DataTexture(new Float32Array([0.5, 0.25, 0, 1, 0.5, 0.25, 0, 1]), 2, 1, THREE.RGBAFormat, THREE.FloatType);
    env.mapping = THREE.EquirectangularReflectionMapping;
    env.needsUpdate = true;
    scene.environment = env;
    scene.add(floor(new THREE.MeshStandardMaterial({ color: 0xffffff, metalness: 1, roughness: 0 })));
    const [r, g] = centre(render(scene, topCamera()));
    expect(r).toBeGreaterThan(0.4);
    expect(g / r).toBeCloseTo(0.5, 1);
    scene.background = env;
    const [br, bg] = render(scene, topCamera()).at(8, 8);
    expect(br).toBeGreaterThan(0);
    expect(bg).toBeGreaterThan(0);
  });

  it('blends transparent surfaces with what is behind them over many samples', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshBasicMaterial({ color: 0xff0000, transparent: true, opacity: 0.5 })));
    const [r, , b, a] = centre(render(scene, topCamera(), { samples: 200, clearColor: [0, 0, 1], clearAlpha: 1 }));
    expect(r).toBeCloseTo(0.5, 1);
    expect(b).toBeCloseTo(0.5, 1);
    expect(a).toBe(1);
  });

  it('cuts out texels below alphaTest', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshBasicMaterial({ color: 0xff0000, opacity: 0.2, alphaTest: 0.5 })));
    expect(centre(render(scene, topCamera()))[3]).toBe(0);
  });

  it('sees through perspective cameras', () => {
    const scene = new THREE.Scene();
    scene.add(new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ color: 0xffffff })));
    const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 100);
    camera.position.set(0, 0, 5);
    camera.updateMatrixWorld();
    const image = render(scene, camera);
    expect(centre(image)).toEqual([1, 1, 1, 1]);
    expect(image.at(0, 0)[3]).toBe(0);
  });

  it('bounces light between diffuse surfaces with global illumination on', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshLambertMaterial({ color: 0xffffff }), 40));
    // A large red emitter above the floor and behind the camera lights the floor only by bouncing.
    const lamp = new THREE.Mesh(new THREE.PlaneGeometry(40, 40), new THREE.MeshBasicMaterial({ color: 0xff0000 }));
    lamp.rotation.x = Math.PI;
    lamp.position.z = 20;
    scene.add(lamp);
    const off = centre(render(scene, topCamera(), { samples: 8 }));
    const on = centre(render(scene, topCamera(), { samples: 64, globalIllumination: true }));
    expect(off[0]).toBe(0);
    expect(on[0]).toBeGreaterThan(0.3);
    expect(on[1]).toBe(0);
  });

  it('refracts through MeshPhysicalMaterial transmission', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshBasicMaterial({ color: 0x00ff00 })));
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshPhysicalMaterial({ transmission: 1, roughness: 0, thickness: 1, color: 0xffffff }));
    glass.position.z = 1;
    scene.add(glass);
    const [r, g, , a] = centre(render(scene, topCamera(), { samples: 32 }));
    expect(a).toBe(1);
    expect(g).toBeGreaterThan(0.6);
    expect(r).toBeLessThan(0.1);
  });

  it('absorbs light inside volumes with attenuationColor and attenuationDistance', () => {
    // A white floor seen through a 1-unit glass slab whose attenuation keeps half the red per unit.
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshBasicMaterial({ color: 0xffffff })));
    const glass = (attenuated: boolean) => new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transmission: 1, roughness: 0, thickness: 1,
      ...(attenuated ? { attenuationColor: new THREE.Color(0.5, 1, 1), attenuationDistance: 1 } : {}),
    });
    const slab = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 1), glass(true));
    slab.position.z = 1;
    scene.add(slab);
    const [r, g, b] = centre(render(scene, topCamera(), { samples: 16 }));
    // Straight through, red keeps 0.5, less what the two surfaces reflect.
    expect(r / g).toBeCloseTo(0.5, 1);
    expect(b).toBeCloseTo(g, 2);
    expect(g).toBeGreaterThan(0.7);
    // Twice as thick, red keeps a quarter.
    slab.scale.z = 2;
    slab.position.z = 1.5;
    const [r2, g2] = centre(render(scene, topCamera(), { samples: 16 }));
    expect(r2 / g2).toBeCloseTo(0.25, 1);
    // Without attenuation the glass stays clear.
    slab.material = glass(false);
    const [r3, g3] = centre(render(scene, topCamera(), { samples: 16 }));
    expect(r3 / g3).toBeCloseTo(1, 2);
  });

  it('tints shadows by the absorption along the path through a volume', () => {
    // Light reaches a white floor through the slab, and the camera sees the floor through it too.
    // Red keeps about 0.5 per crossing: 0.5 without shadows, and about 0.25 with them. The light's
    // slant makes its path slightly longer than 1.
    const scene = new THREE.Scene();
    // The light comes in at an angle, so the glass doesn't reflect it straight into the camera.
    const light = new THREE.DirectionalLight(0xffffff, Math.PI);
    light.position.set(1, 0.5, 10);
    scene.add(floor(new THREE.MeshLambertMaterial({ color: 0xffffff })), light);
    const slab = new THREE.Mesh(new THREE.BoxGeometry(3, 3, 1), new THREE.MeshPhysicalMaterial({
      color: 0xffffff, transmission: 1, roughness: 0, thickness: 1,
      attenuationColor: new THREE.Color(0.5, 1, 1), attenuationDistance: 1,
    }));
    slab.position.z = 1;
    scene.add(slab);
    const ratio = (shadows: 'all' | 'none') => {
      const [r, g] = centre(render(scene, topCamera(), { samples: 32, shadows }));
      return r / g;
    };
    expect(ratio('none')).toBeCloseTo(0.5, 1);
    expect(ratio('all')).toBeCloseTo(0.25, 1);
  });

  it('repeats exactly for the same seed', () => {
    const scene = new THREE.Scene();
    scene.add(floor(new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.5 })), overheadLight(2), new THREE.AmbientLight(0xffffff, 1));
    const a = raytrace(scene, topCamera(), 8, 8, { samples: 4 }).data;
    const b = raytrace(scene, topCamera(), 8, 8, { samples: 4 }).data;
    expect([...a]).toEqual([...b]);
  });
});
