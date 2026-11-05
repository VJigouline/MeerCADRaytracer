# What it renders, and how it matches three.js

The ray tracer reads the same scene graph three.js draws. It evaluates each surface with the formulas from three.js r187's shader chunks, then adds what rasterising can't do exactly: shadows, reflections of other objects, refraction and indirect light.

## How a pixel is traced

1. **Camera ray.** A ray leaves the camera through the pixel. Perspective and orthographic cameras both work, including `zoom` and view offsets, because the ray comes from the camera's inverse projection matrix. Pass 0 samples pixel centres, and later passes jitter within the pixel, which antialiases edges as passes accumulate.
2. **Closest hit.** A bounding volume hierarchy (binned surface area heuristic) finds the nearest triangle. Back faces of `FrontSide` materials and front faces of `BackSide` materials are skipped, as three.js culls them.
3. **Surface.** The tracer interpolates normals, uvs and vertex colours, then applies `map`, `alphaMap`, `normalMap`, `emissiveMap`, `roughnessMap`, `metalnessMap` and `aoMap`, including each texture's `offset`, `repeat`, `rotation`, wrapping and `flipY`.
4. **Direct light.** Each light's contribution uses three.js's BRDF for the material type, and a shadow ray decides whether the light is visible.
5. **Ambient light.** Ambient and hemisphere lights add indirect diffuse light, as in three.js.
6. **Continuation.** The path carries on in one direction: a reflection, a refraction or, with global illumination, a diffuse bounce. Each is chosen in proportion to the light it returns, and Russian roulette ends weak paths after the third bounce.
7. **Output.** The result is tone mapped, fogged and encoded to the output colour space as three.js does. Each sample is tone mapped before averaging, as WebGL multisampling resolves tone mapped fragments.

## Materials

| three.js material | Shading |
|---|---|
| `MeshStandardMaterial`, `MeshPhysicalMaterial` | GGX specular with Smith visibility, three.js's multiple-scattering compensation (from its DFG table) and Fresnel-weighted Lambert diffuse. Physical materials use `ior`, `specularIntensity`, `specularColor`, `transmission`, `thickness`, `attenuationColor` and `attenuationDistance`. |
| `MeshPhongMaterial` | Lambert diffuse plus three.js's Blinn-Phong highlight (`specular`, `shininess`). |
| `MeshLambertMaterial` | Lambert diffuse. |
| `MeshToonMaterial` | Two-tone diffuse, using three.js's default gradient. |
| `MeshBasicMaterial` | Unlit colour. |
| `MeshMatcapMaterial` | Unlit colour: matcap textures are not used. |
| Other materials (`ShaderMaterial`, `MeshNormalMaterial` and so on) | Shaded as Lambert, with a console warning. |

Common properties: `color`, `opacity`, `transparent` (stochastic, so many samples blend correctly), `alphaTest`, `side`, `vertexColors`, `flatShading`, `emissive`, `emissiveIntensity`, `toneMapped`, `visible` and `normalScale`.

**Reflections.** Standard and physical materials reflect the scene, weighted by the same split-sum energy three.js uses for environment maps. Rough surfaces sample a GGX-distributed microfacet normal, so reflections blur with roughness. Reflection rays that leave the scene see the material's `envMap`, else `scene.environment`, else black, which is also what WebGL shows without an environment map. Lambert, Phong and Basic materials mix in their `envMap` with `combine` and `reflectivity`, as three.js does.

**Transmission.** A physical material with `transmission` lets light through, tinted by its colour. With `thickness` above 0, the ray refracts by `ior` into and out of the object, and can reflect inside it. With `thickness` 0, the default, the surface is thin-walled and rays pass straight through.

**Coloured glass.** Inside a thick volume, `attenuationColor` and `attenuationDistance` (glTF's `KHR_materials_volume`) absorb light by the distance travelled, as Beer–Lambert absorption: after `attenuationDistance`, light keeps `attenuationColor` of itself. The ray tracer measures the true distance through the object, so thin parts look pale and thick parts deep, and shadows through the volume are tinted the same way. `thickness` and `thicknessMap` only decide that the object is solid, since the ray tracer doesn't need their estimate of the distance.

## Lights

| Light | Notes |
|---|---|
| `AmbientLight` | Indirect diffuse, `color * intensity / pi`, as in three.js. |
| `HemisphereLight` | Sky to ground colour by the normal's direction, as in three.js. |
| `DirectionalLight` | Direction from the light's position to its `target`. |
| `PointLight` | three.js's inverse-power falloff (`decay`) and `distance` window. |
| `SpotLight` | Falloff as a point light, with three.js's cone (`angle`) and `penumbra` smoothstep. |
| `RectAreaLight`, `LightProbe` | Not supported; left out with a warning. |

Intensities use three.js's physically based units, as since r155, so lights look the same in both renderers.

## Shadows

The `shadows` option chooses how shadows are cast:

- `'all'` (default): every light casts shadows from every object. This is usually what you want from a ray tracer, and it doesn't need any shadow set-up in the scene.
- `'castShadow'`: as three.js decides, only lights with `castShadow` cast shadows, from meshes with `castShadow`, onto meshes with `receiveShadow`.
- `'none'`: no shadows.

Shadows are hard, from punctual lights. Transparent and transmissive surfaces let light through in proportion to their opacity and transmission. Unlike three.js shadow maps, every face blocks light whatever its `side`, and there is no shadow bias to set.

## Global illumination

With `globalIllumination`, light also bounces off diffuse surfaces: colours bleed and corners darken. It is path tracing with the lights sampled directly at every bounce, so it needs more samples to settle, typically 256 or more. Ambient and hemisphere lights still add their constant light, so turn them down to see bounce light on its own.

## Backgrounds and environments

| `scene.background` | Ray traced as |
|---|---|
| `null` | The renderer's clear colour and alpha, so a transparent canvas stays transparent. |
| `Color` | That colour, not tone mapped, as WebGL clears with it. |
| Cube texture, or equirectangular texture | Looked up by ray direction, with `backgroundIntensity` and `backgroundRotation`. Tone mapped unless the texture is sRGB, as in three.js. |
| Other textures | Stretched over the screen. |

`scene.environment`, `environmentIntensity` and `environmentRotation` light standard materials that have no `envMap` of their own.

`scene.fog` (`Fog` and `FogExp2`) is applied at a camera ray's first hit with three.js's formulas.

## Geometry

The tracer draws meshes made of triangles: `Mesh`, `InstancedMesh` (instance matrices; `instanceColor` is ignored) and `SkinnedMesh` and morph targets (in their current pose). It honours `drawRange`, groups with material arrays, `visible` and camera `layers`. Mirroring transforms keep the correct front face.

**Always left out:** `Line`, `Points`, `Sprite`, `BatchedMesh`, wireframe materials, objects whose type ends in `Helper`, `TransformControls` gizmos, and objects with `userData.raytrace = false`. Pass `filter` to leave out more.

## Textures

Images are read once through a canvas and cached until the texture's `version` changes. 8-bit sRGB textures are decoded to linear when sampled, and `DataTexture`s with 8-bit, half-float or float data are read directly. Sampling is bilinear without mipmaps, so distant, finely detailed textures can shimmer until enough samples average them. Compressed textures and render-target textures, including PMREM output, are not read.

## Differences from WebGL to expect

- **Shadows and reflections** appear where WebGL showed none, unless the scene set up shadow maps or environment maps.
- **Mirror-like surfaces** reflect other objects, not just the environment map.
- **Anisotropy, clearcoat, sheen, iridescence and diffuse roughness** of `MeshPhysicalMaterial` are ignored.
- **Light maps, bump maps, displacement maps, specular maps and gradient maps** are ignored.
- **Clipping planes, depth test and depth write settings, and polygon offset** have no effect.
- **Large scenes** take time to compile: triangles are gathered and the BVH is built in the page, which took about 2.4 seconds per million triangles on a desktop PC in Node.js. It happens again only when geometry or transforms change, not when the camera, materials or lights do.
