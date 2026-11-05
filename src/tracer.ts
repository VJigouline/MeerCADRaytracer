import {
  blinnPhong,
  dfg,
  distanceAttenuation,
  distributionGgx,
  fresnelWeight,
  INV_PI,
  smoothstep,
  visibilityGgx,
} from './brdf.js';
import { Hit, intersectAny, intersectClosest } from './bvh.js';
import { toneMap } from './color.js';
import { AddOperation, MixOperation, MultiplyOperation, NoToneMapping } from './constants.js';
import { Random } from './random.js';
import { sampleEnvironment, sampleTexture } from './textures.js';
import {
  TRI_CAST_SHADOW,
  TRI_OPAQUE,
  TRI_RECEIVE_SHADOW,
  type CompiledCamera,
  type CompiledEnvironment,
  type CompiledLight,
  type CompiledMaterial,
  type CompiledScene,
  type Tile,
  type TraceSettings,
} from './types.js';

/** Most transparent surfaces a single ray may pass through before it is stopped. */
const MAX_PASS_THROUGH = 64;

/**
 * Traces rays through a compiled scene. One Tracer can render any number of tiles and passes;
 * it holds scratch space, so each thread or worker needs its own.
 */
export class Tracer {
  private readonly hit = new Hit();
  private readonly stack = new Int32Array(256);
  private readonly random = new Random();
  private readonly texel = [0, 0, 0, 0];
  private readonly env = [0, 0, 0];
  private readonly dfgOut = [0, 0];
  private readonly color = [0, 0, 0];
  private readonly shadowColor = [1, 1, 1];
  private shadowCastOnly = false;
  // Distances of the see-through surfaces a shadow ray has already counted. A ray through the
  // edge two triangles share hits both, and must only be dimmed once.
  private readonly shadowHits: number[] = [];
  private readonly shadowVisit = (triangle: number, t: number, u: number, v: number): boolean =>
    this.attenuateShadow(triangle, t, u, v);

  constructor(readonly scene: CompiledScene, readonly settings: TraceSettings) {}

  /**
   * Traces one sample for every pixel of a tile and returns premultiplied RGBA, row by row.
   * Pass 0 samples pixel centres; later passes jitter within the pixel, so averaging passes
   * antialiases. With `block` above 1, one sample covers each block x block square, for a
   * fast preview.
   */
  renderTile(camera: CompiledCamera, tile: Tile, width: number, height: number, pass: number, block = 1): Float32Array {
    const out = new Float32Array(tile.width * tile.height * 4);
    const sample = [0, 0, 0, 0];
    const ray = new Float64Array(6);
    for (let y = 0; y < tile.height; y += block) {
      for (let x = 0; x < tile.width; x += block) {
        const px = tile.x + x, py = tile.y + y;
        this.random.seed(px, py, pass, this.settings.seed);
        let jx = 0.5, jy = 0.5;
        if (block > 1) {
          jx = Math.min(block, width - px) * 0.5;
          jy = Math.min(block, height - py) * 0.5;
        } else if (pass > 0) {
          jx = this.random.next();
          jy = this.random.next();
        }
        const sx = (px + jx) / width, sy = (py + jy) / height;
        cameraRay(camera, sx * 2 - 1, 1 - sy * 2, ray);
        this.samplePixel(camera, ray, sx, sy, sample);
        for (let by = y; by < Math.min(y + block, tile.height); by++) {
          for (let bx = x; bx < Math.min(x + block, tile.width); bx++) {
            out.set(sample, (by * tile.width + bx) * 4);
          }
        }
      }
    }
    return out;
  }

  /** Premultiplied, tone mapped RGBA of one camera ray. */
  samplePixel(camera: CompiledCamera, ray: Float64Array, sx: number, sy: number, out: number[]): void {
    const { scene, settings } = this;
    const geometry = scene.geometry;
    const eps = geometry.epsilon;
    const random = this.random;
    const hit = this.hit;
    const color = this.color;
    let ox = ray[0]!, oy = ray[1]!, oz = ray[2]!, dx = ray[3]!, dy = ray[4]!, dz = ray[5]!;
    let tr = 1, tg = 1, tb = 1;
    let lr = 0, lg = 0, lb = 0;
    let surfaceSeen = false;
    let toneMapped = true;
    let fogFactor = 0;
    let lastEnvironment: CompiledEnvironment | null = null;
    let lastEnvironmentScale = 1;
    let bounce = 0;
    let passes = 0;
    let cull = true;

    for (;;) {
      if (!intersectClosest(geometry.triangles, geometry.sides, geometry.bvh, ox, oy, oz, dx, dy, dz, 0, Infinity, cull, hit, this.stack)) {
        if (!surfaceSeen) {
          this.background(dx, dy, dz, sx, sy, out);
          return;
        }
        if (lastEnvironment) {
          sampleEnvironment(lastEnvironment, scene.textures, dx, dy, dz, this.env);
          lr += tr * this.env[0]! * lastEnvironmentScale;
          lg += tg * this.env[1]! * lastEnvironmentScale;
          lb += tb * this.env[2]! * lastEnvironmentScale;
        }
        break;
      }

      const k = hit.triangle;
      const material = scene.materials[geometry.materials[k]!]!;
      const t = hit.t;
      const px = ox + dx * t, py = oy + dy * t, pz = oz + dz * t;
      const w1 = hit.u, w2 = hit.v, w0 = 1 - w1 - w2;
      const o9 = k * 9;
      const tri = geometry.triangles;
      // Geometric normal of the side the ray hit.
      let gx = tri[o9 + 4]! * tri[o9 + 8]! - tri[o9 + 5]! * tri[o9 + 7]!;
      let gy = tri[o9 + 5]! * tri[o9 + 6]! - tri[o9 + 3]! * tri[o9 + 8]!;
      let gz = tri[o9 + 3]! * tri[o9 + 7]! - tri[o9 + 4]! * tri[o9 + 6]!;
      const gl = Math.hypot(gx, gy, gz) || 1;
      const face = hit.front ? 1 : -1;
      gx = (gx / gl) * face; gy = (gy / gl) * face; gz = (gz / gl) * face;

      const uvs = geometry.uvs, u6 = k * 6;
      const u = uvs[u6]! * w0 + uvs[u6 + 2]! * w1 + uvs[u6 + 4]! * w2;
      const v = uvs[u6 + 1]! * w0 + uvs[u6 + 3]! * w1 + uvs[u6 + 5]! * w2;

      // Base colour and coverage.
      let cr = material.color[0], cg = material.color[1], cb = material.color[2];
      let alpha = material.opacity;
      if (material.map >= 0) {
        sampleTexture(scene.textures[material.map]!, u, v, this.texel);
        cr *= this.texel[0]!; cg *= this.texel[1]!; cb *= this.texel[2]!; alpha *= this.texel[3]!;
      }
      if (material.vertexColors && geometry.colors.length > 0) {
        const c12 = k * 12, colors = geometry.colors;
        cr *= colors[c12]! * w0 + colors[c12 + 4]! * w1 + colors[c12 + 8]! * w2;
        cg *= colors[c12 + 1]! * w0 + colors[c12 + 5]! * w1 + colors[c12 + 9]! * w2;
        cb *= colors[c12 + 2]! * w0 + colors[c12 + 6]! * w1 + colors[c12 + 10]! * w2;
        alpha *= colors[c12 + 3]! * w0 + colors[c12 + 7]! * w1 + colors[c12 + 11]! * w2;
      }
      if (material.alphaMap >= 0) {
        sampleTexture(scene.textures[material.alphaMap]!, u, v, this.texel);
        alpha *= this.texel[1]!;
      }
      const cutOut = material.alphaTest > 0 && alpha < material.alphaTest;
      if (cutOut || (material.transparent && random.next() >= alpha)) {
        // Pass straight through: the surface isn't there for this sample.
        if (++passes > MAX_PASS_THROUGH) break;
        const side = gx * dx + gy * dy + gz * dz > 0 ? eps : -eps;
        ox = px + gx * side; oy = py + gy * side; oz = pz + gz * side;
        continue;
      }

      if (!surfaceSeen) {
        surfaceSeen = true;
        toneMapped = material.toneMapped;
        fogFactor = this.fog(camera, px, py, pz);
      }

      // Shading normal: interpolated, flipped to the side hit, then normal mapped.
      const nrm = geometry.normals;
      let nx = (nrm[o9]! * w0 + nrm[o9 + 3]! * w1 + nrm[o9 + 6]! * w2) * face;
      let ny = (nrm[o9 + 1]! * w0 + nrm[o9 + 4]! * w1 + nrm[o9 + 7]! * w2) * face;
      let nz = (nrm[o9 + 2]! * w0 + nrm[o9 + 5]! * w1 + nrm[o9 + 8]! * w2) * face;
      let nl = Math.hypot(nx, ny, nz) || 1;
      nx /= nl; ny /= nl; nz /= nl;
      if (material.normalMap >= 0) {
        sampleTexture(scene.textures[material.normalMap]!, u, v, this.texel);
        const mx = (this.texel[0]! * 2 - 1) * material.normalScale[0];
        const my = (this.texel[1]! * 2 - 1) * material.normalScale[1];
        const mz = this.texel[2]! * 2 - 1;
        const tg4 = geometry.tangents, t4 = k * 4;
        let ax = tg4[t4]!, ay = tg4[t4 + 1]!, az = tg4[t4 + 2]!;
        const along = ax * nx + ay * ny + az * nz;
        ax -= nx * along; ay -= ny * along; az -= nz * along;
        const al = Math.hypot(ax, ay, az) || 1;
        ax = (ax / al) * face; ay = (ay / al) * face; az = (az / al) * face;
        const sign = tg4[t4 + 3]!;
        const bx = (ny * az - nz * ay) * sign, by = (nz * ax - nx * az) * sign, bz = (nx * ay - ny * ax) * sign;
        nx = ax * mx + bx * my + nx * mz;
        ny = ay * mx + by * my + ny * mz;
        nz = az * mx + bz * my + nz * mz;
        nl = Math.hypot(nx, ny, nz) || 1;
        nx /= nl; ny /= nl; nz /= nl;
      }

      const vx = -dx, vy = -dy, vz = -dz;
      const dotNV = Math.min(Math.max(nx * vx + ny * vy + nz * vz, 0), 1);
      let outR = 0, outG = 0, outB = 0;

      // Emission.
      let er = material.emissive[0], eg = material.emissive[1], eb = material.emissive[2];
      if (material.emissiveMap >= 0 && (er > 0 || eg > 0 || eb > 0)) {
        sampleTexture(scene.textures[material.emissiveMap]!, u, v, this.texel);
        er *= this.texel[0]!; eg *= this.texel[1]!; eb *= this.texel[2]!;
      }

      const receive = (geometry.flags[k]! & TRI_RECEIVE_SHADOW) !== 0;
      const canContinue = bounce < settings.maxBounces;

      // Continuation candidates: the direction a path may carry on in, and its weight.
      let specR = 0, specG = 0, specB = 0;
      let diffR = 0, diffG = 0, diffB = 0;
      let transR = 0, transG = 0, transB = 0;
      let roughness = 1;
      let environment: CompiledEnvironment | null = null;
      let environmentScale = 1;

      if (material.model === 'basic') {
        outR = cr; outG = cg; outB = cb;
      } else {
        // Ambient and hemisphere irradiance, which three.js adds as indirect diffuse light.
        let ir = 0, ig = 0, ib = 0;
        for (const light of scene.lights) {
          if (light.type === 'ambient') {
            ir += light.color[0]; ig += light.color[1]; ib += light.color[2];
          } else if (light.type === 'hemisphere') {
            const w = 0.5 * (nx * light.direction[0] + ny * light.direction[1] + nz * light.direction[2]) + 0.5;
            ir += light.groundColor[0] + (light.color[0] - light.groundColor[0]) * w;
            ig += light.groundColor[1] + (light.color[1] - light.groundColor[1]) * w;
            ib += light.groundColor[2] + (light.color[2] - light.groundColor[2]) * w;
          }
        }
        let ao = 1;
        if (material.aoMap >= 0) {
          sampleTexture(scene.textures[material.aoMap]!, u, v, this.texel);
          ao = (this.texel[0]! - 1) * material.aoMapIntensity + 1;
        }

        if (material.model === 'physical') {
          let metalness = material.metalness;
          roughness = material.roughness;
          if (material.roughnessMap >= 0) {
            sampleTexture(scene.textures[material.roughnessMap]!, u, v, this.texel);
            roughness *= this.texel[1]!;
          }
          if (material.metalnessMap >= 0) {
            sampleTexture(scene.textures[material.metalnessMap]!, u, v, this.texel);
            metalness *= this.texel[2]!;
          }
          const shadeRoughness = Math.min(Math.max(roughness, 0.045), 1);
          // Specular colours: dielectric (f0) and blended with the base colour by metalness.
          let sr = 0.04, sg = 0.04, sb = 0.04, f90 = 1;
          if (material.physical) {
            const f = ((material.ior - 1) / (material.ior + 1)) ** 2;
            sr = Math.min(f * material.specularColor[0], 1) * material.specularIntensity;
            sg = Math.min(f * material.specularColor[1], 1) * material.specularIntensity;
            sb = Math.min(f * material.specularColor[2], 1) * material.specularIntensity;
            f90 = material.specularIntensity + (1 - material.specularIntensity) * metalness;
          }
          const br = sr + (cr - sr) * metalness, bg = sg + (cg - sg) * metalness, bbl = sb + (cb - sb) * metalness;
          const dr = cr * (1 - metalness), dg = cg * (1 - metalness), db = cb * (1 - metalness);
          dfg(shadeRoughness, dotNV, this.dfgOut);
          const fa = this.dfgOut[0]!, fb = this.dfgOut[1]!;
          const essMs = fa + fb, ems = 1 - essMs;
          const compR = 1 + br * (1 / essMs - 1), compG = 1 + bg * (1 / essMs - 1), compB = 1 + bbl * (1 / essMs - 1);
          const ggxAlpha = shadeRoughness * shadeRoughness;
          const transmission = material.transmission;
          const keepDiffuse = 1 - transmission;

          // Direct lights.
          for (const light of scene.lights) {
            if (!this.lightAt(light, px, py, pz)) continue;
            const lx = this.lx, ly = this.ly, lz = this.lz;
            const dotNL = nx * lx + ny * ly + nz * lz;
            if (dotNL <= 0) continue;
            let hx = lx + vx, hy = ly + vy, hz = lz + vz;
            const hl = Math.hypot(hx, hy, hz) || 1;
            hx /= hl; hy /= hl; hz /= hl;
            const dotNH = Math.min(Math.max(nx * hx + ny * hy + nz * hz, 0), 1);
            const dotVH = Math.min(Math.max(vx * hx + vy * hy + vz * hz, 0), 1);
            const fw = fresnelWeight(dotVH);
            const vd = visibilityGgx(ggxAlpha, dotNL, dotNV) * distributionGgx(ggxAlpha, dotNH);
            const specularR = (br * (1 - fw) + f90 * fw) * vd * compR;
            const specularG = (bg * (1 - fw) + f90 * fw) * vd * compG;
            const specularB = (bbl * (1 - fw) + f90 * fw) * vd * compB;
            const diffuseR = dr * INV_PI * (1 - (sr * (1 - fw) + f90 * fw)) * keepDiffuse;
            const diffuseG = dg * INV_PI * (1 - (sg * (1 - fw) + f90 * fw)) * keepDiffuse;
            const diffuseB = db * INV_PI * (1 - (sb * (1 - fw) + f90 * fw)) * keepDiffuse;
            const scale = dotNL;
            let r = (specularR + diffuseR) * scale * this.lr;
            let g = (specularG + diffuseG) * scale * this.lg;
            let b = (specularB + diffuseB) * scale * this.lb;
            if (r + g + b <= 0) continue;
            if (!this.visibleLight(light, receive, px, py, pz, gx, gy, gz)) continue;
            r *= this.shadowColor[0]!; g *= this.shadowColor[1]!; b *= this.shadowColor[2]!;
            outR += r; outG += g; outB += b;
          }

          // Indirect diffuse from ambient and hemisphere lights, less what the specular layer reflects.
          const fssR = sr * fa + f90 * fb, fssG = sg * fa + f90 * fb, fssB = sb * fa + f90 * fb;
          const scatterR = fssR + multiScatter(fssR, sr, ems), scatterG = fssG + multiScatter(fssG, sg, ems);
          const scatterB = fssB + multiScatter(fssB, sb, ems);
          outR += ir * INV_PI * dr * (1 - scatterR) * ao * keepDiffuse;
          outG += ig * INV_PI * dg * (1 - scatterG) * ao * keepDiffuse;
          outB += ib * INV_PI * db * (1 - scatterB) * ao * keepDiffuse;

          // Reflections: three.js weights its environment reflection by the single-scattering energy.
          const mfR = cr * fa + f90 * fb, mfG = cg * fa + f90 * fb, mfB = cb * fa + f90 * fb;
          specR = fssR + (mfR - fssR) * metalness;
          specG = fssG + (mfG - fssG) * metalness;
          specB = fssB + (mfB - fssB) * metalness;
          diffR = dr * (1 - scatterR) * keepDiffuse;
          diffG = dg * (1 - scatterG) * keepDiffuse;
          diffB = db * (1 - scatterB) * keepDiffuse;
          if (transmission > 0) {
            const fr = sr * fa + f90 * fb, fg = sg * fa + f90 * fb, fbl = sb * fa + f90 * fb;
            transR = transmission * (1 - fr) * cr;
            transG = transmission * (1 - fg) * cg;
            transB = transmission * (1 - fbl) * cb;
          }
          if (material.envMap >= 0) environment = scene.environments[material.envMap]!;
          else if (scene.environment >= 0) {
            environment = scene.environments[scene.environment]!;
            environmentScale = material.envMapIntensity;
          }
          // Environment light on the diffuse layer, which three.js takes from the environment
          // map. Estimated with one cosine-weighted direction when paths don't bounce diffusely.
          if (environment && !settings.globalIllumination) {
            this.cosineDirection(nx, ny, nz);
            const sx2 = this.sx, sy2 = this.sy, sz2 = this.sz;
            if (sx2 * gx + sy2 * gy + sz2 * gz > 0 &&
                this.transmittance(px + gx * eps, py + gy * eps, pz + gz * eps, sx2, sy2, sz2, Infinity, false)) {
              sampleEnvironment(environment, scene.textures, sx2, sy2, sz2, this.env);
              outR += this.env[0]! * environmentScale * diffR * this.shadowColor[0]!;
              outG += this.env[1]! * environmentScale * diffG * this.shadowColor[1]!;
              outB += this.env[2]! * environmentScale * diffB * this.shadowColor[2]!;
            }
          }
          if (!settings.globalIllumination) diffR = diffG = diffB = 0;
        } else {
          // Lambert, Phong and Toon: Lambertian diffuse, plus a Blinn-Phong highlight for Phong.
          for (const light of scene.lights) {
            if (!this.lightAt(light, px, py, pz)) continue;
            const lx = this.lx, ly = this.ly, lz = this.lz;
            const cosine = nx * lx + ny * ly + nz * lz;
            let irradiance: number;
            if (material.model === 'toon') irradiance = cosine * 0.5 + 0.5 < 0.7 ? 0.7 : 1;
            else if (cosine <= 0) continue;
            else irradiance = cosine;
            let r = cr * INV_PI, g = cg * INV_PI, b = cb * INV_PI;
            if (material.model === 'phong' && cosine > 0) {
              let hx = lx + vx, hy = ly + vy, hz = lz + vz;
              const hl = Math.hypot(hx, hy, hz) || 1;
              hx /= hl; hy /= hl; hz /= hl;
              const dotNH = Math.min(Math.max(nx * hx + ny * hy + nz * hz, 0), 1);
              const dotVH = Math.min(Math.max(vx * hx + vy * hy + vz * hz, 0), 1);
              const fw = fresnelWeight(dotVH);
              const d = blinnPhong(material.shininess, dotNH);
              r += (material.specular[0] * (1 - fw) + fw) * d;
              g += (material.specular[1] * (1 - fw) + fw) * d;
              b += (material.specular[2] * (1 - fw) + fw) * d;
            }
            r *= irradiance * this.lr; g *= irradiance * this.lg; b *= irradiance * this.lb;
            if (r + g + b <= 0) continue;
            if (!this.visibleLight(light, receive, px, py, pz, gx, gy, gz)) continue;
            outR += r * this.shadowColor[0]!; outG += g * this.shadowColor[1]!; outB += b * this.shadowColor[2]!;
          }
          outR += ir * INV_PI * cr * ao;
          outG += ig * INV_PI * cg * ao;
          outB += ib * INV_PI * cb * ao;
          if (settings.globalIllumination) {
            diffR = cr; diffG = cg; diffB = cb;
          }
        }
      }

      // Environment map on Lambert, Phong and Basic materials: three.js mixes it into the colour.
      if (material.model !== 'physical' && material.envMap >= 0) {
        const env = scene.environments[material.envMap]!;
        const dn = dx * nx + dy * ny + dz * nz;
        sampleEnvironment(env, scene.textures, dx - 2 * dn * nx, dy - 2 * dn * ny, dz - 2 * dn * nz, this.env);
        const s = material.reflectivity;
        const er2 = this.env[0]!, eg2 = this.env[1]!, eb2 = this.env[2]!;
        if (material.combine === MultiplyOperation) {
          outR *= 1 - s + s * er2; outG *= 1 - s + s * eg2; outB *= 1 - s + s * eb2;
        } else if (material.combine === MixOperation) {
          outR += (er2 - outR) * s; outG += (eg2 - outG) * s; outB += (eb2 - outB) * s;
        } else if (material.combine === AddOperation) {
          outR += er2 * s; outG += eg2 * s; outB += eb2 * s;
        }
      }

      lr += tr * (outR + er);
      lg += tg * (outG + eg);
      lb += tb * (outB + eb);

      if (!canContinue) break;

      // Carry the path on in one direction, chosen in proportion to how much light each returns.
      const ws = luminance(specR, specG, specB);
      const wt = luminance(transR, transG, transB);
      const wd = luminance(diffR, diffG, diffB);
      const total = ws + wt + wd;
      if (total <= 1e-6) break;
      const pick = random.next() * total;
      let wr: number, wg: number, wb: number, p: number;
      if (pick < ws) {
        p = ws / total;
        wr = specR; wg = specG; wb = specB;
        this.reflection(dx, dy, dz, nx, ny, nz, roughness);
        if (this.sx * gx + this.sy * gy + this.sz * gz <= 0) break;
        lastEnvironment = environment;
        lastEnvironmentScale = environmentScale;
      } else if (pick < ws + wt) {
        p = wt / total;
        wr = transR; wg = transG; wb = transB;
        if (material.thickness > 0) {
          // Refract into a solid object, or out of it when the ray is inside.
          const eta = hit.front ? 1 / material.ior : material.ior;
          if (!this.refract(dx, dy, dz, nx, ny, nz, eta)) this.reflection(dx, dy, dz, nx, ny, nz, 0);
          cull = !hit.front;
        } else {
          this.sx = dx; this.sy = dy; this.sz = dz;
        }
        lastEnvironment = environment;
        lastEnvironmentScale = environmentScale;
      } else {
        p = wd / total;
        wr = diffR; wg = diffG; wb = diffB;
        this.cosineDirection(nx, ny, nz);
        if (this.sx * gx + this.sy * gy + this.sz * gz <= 0) break;
        lastEnvironment = environment;
        lastEnvironmentScale = environmentScale;
      }
      tr *= wr / p; tg *= wg / p; tb *= wb / p;
      const side = this.sx * gx + this.sy * gy + this.sz * gz > 0 ? eps : -eps;
      ox = px + gx * side; oy = py + gy * side; oz = pz + gz * side;
      dx = this.sx; dy = this.sy; dz = this.sz;
      bounce++;
      if (bounce >= 3) {
        const q = Math.min(0.95, Math.max(tr, tg, tb));
        if (random.next() >= q) break;
        tr /= q; tg /= q; tb /= q;
      }
    }

    color[0] = lr; color[1] = lg; color[2] = lb;
    if (toneMapped && settings.toneMapping !== NoToneMapping) toneMap(color, settings.toneMapping, settings.toneMappingExposure);
    if (fogFactor > 0 && scene.fog) {
      for (let c = 0; c < 3; c++) color[c] = color[c]! + (scene.fog.color[c]! - color[c]!) * fogFactor;
    }
    out[0] = color[0]!; out[1] = color[1]!; out[2] = color[2]!; out[3] = 1;
  }

  // Direction to the light and its radiance at a point, from lightAt.
  private lx = 0; private ly = 0; private lz = 0;
  private lr = 0; private lg = 0; private lb = 0;
  private lightDistance = Infinity;

  /** Sets the direction to a punctual light and its radiance at a point. False for no light. */
  private lightAt(light: CompiledLight, px: number, py: number, pz: number): boolean {
    switch (light.type) {
      case 'directional':
        this.lx = light.direction[0]; this.ly = light.direction[1]; this.lz = light.direction[2];
        this.lr = light.color[0]; this.lg = light.color[1]; this.lb = light.color[2];
        this.lightDistance = Infinity;
        return true;
      case 'point':
      case 'spot': {
        const x = light.position[0] - px, y = light.position[1] - py, z = light.position[2] - pz;
        const distance = Math.hypot(x, y, z);
        if (distance === 0) return false;
        this.lx = x / distance; this.ly = y / distance; this.lz = z / distance;
        let scale = distanceAttenuation(distance, light.distance, light.decay);
        if (light.type === 'spot') {
          const angleCos = this.lx * light.direction[0] + this.ly * light.direction[1] + this.lz * light.direction[2];
          scale *= smoothstep(light.coneCos, light.penumbraCos, angleCos);
        }
        if (scale <= 0) return false;
        this.lr = light.color[0] * scale; this.lg = light.color[1] * scale; this.lb = light.color[2] * scale;
        this.lightDistance = distance;
        return true;
      }
      default:
        return false;
    }
  }

  /** Whether the light reaches the point, leaving its colour filter in shadowColor. */
  private visibleLight(light: CompiledLight, receive: boolean, px: number, py: number, pz: number,
                       gx: number, gy: number, gz: number): boolean {
    this.shadowColor[0] = this.shadowColor[1] = this.shadowColor[2] = 1;
    const mode = this.settings.shadows;
    if (mode === 'none') return true;
    const castOnly = mode === 'castShadow';
    if (castOnly && (!('castShadow' in light) || !light.castShadow || !receive)) return true;
    const eps = this.scene.geometry.epsilon;
    const side = gx * this.lx + gy * this.ly + gz * this.lz > 0 ? eps : -eps;
    const maxT = this.lightDistance === Infinity ? Infinity : this.lightDistance - 2 * eps;
    return this.transmittance(px + gx * side, py + gy * side, pz + gz * side, this.lx, this.ly, this.lz, maxT, castOnly);
  }

  /** Follows a shadow ray, multiplying shadowColor by what it passes through. False if blocked. */
  private transmittance(ox: number, oy: number, oz: number, dx: number, dy: number, dz: number,
                        maxT: number, castOnly: boolean): boolean {
    this.shadowColor[0] = this.shadowColor[1] = this.shadowColor[2] = 1;
    this.shadowCastOnly = castOnly;
    this.shadowHits.length = 0;
    const geometry = this.scene.geometry;
    intersectAny(geometry.triangles, geometry.bvh, ox, oy, oz, dx, dy, dz, 0, maxT, this.stack, this.shadowVisit);
    return this.shadowColor[0]! + this.shadowColor[1]! + this.shadowColor[2]! > 0;
  }

  private attenuateShadow(triangle: number, t: number, u: number, v: number): boolean {
    const geometry = this.scene.geometry;
    const flags = geometry.flags[triangle]!;
    if (this.shadowCastOnly && (flags & TRI_CAST_SHADOW) === 0) return true;
    if (flags & TRI_OPAQUE) {
      this.shadowColor[0] = this.shadowColor[1] = this.shadowColor[2] = 0;
      return false;
    }
    const material: CompiledMaterial = this.scene.materials[geometry.materials[triangle]!]!;
    let alpha = material.opacity;
    let cr = material.color[0], cg = material.color[1], cb = material.color[2];
    if (material.map >= 0 || material.alphaMap >= 0) {
      const uvs = geometry.uvs, u6 = triangle * 6, w0 = 1 - u - v;
      const tu = uvs[u6]! * w0 + uvs[u6 + 2]! * u + uvs[u6 + 4]! * v;
      const tv = uvs[u6 + 1]! * w0 + uvs[u6 + 3]! * u + uvs[u6 + 5]! * v;
      if (material.map >= 0) {
        sampleTexture(this.scene.textures[material.map]!, tu, tv, this.texel);
        alpha *= this.texel[3]!;
        cr *= this.texel[0]!; cg *= this.texel[1]!; cb *= this.texel[2]!;
      }
      if (material.alphaMap >= 0) {
        sampleTexture(this.scene.textures[material.alphaMap]!, tu, tv, this.texel);
        alpha *= this.texel[1]!;
      }
    }
    if (material.alphaTest > 0 && alpha < material.alphaTest) return true;
    if (!material.transparent) alpha = 1;
    const eps = geometry.epsilon;
    for (const seen of this.shadowHits) if (Math.abs(seen - t) <= eps) return true;
    this.shadowHits.push(t);
    // Light passes the part that isn't covered, and transmissive surfaces let through their colour.
    const open = 1 - alpha;
    const through = material.transmission;
    this.shadowColor[0] = this.shadowColor[0]! * (open + alpha * through * cr);
    this.shadowColor[1] = this.shadowColor[1]! * (open + alpha * through * cg);
    this.shadowColor[2] = this.shadowColor[2]! * (open + alpha * through * cb);
    if (this.shadowColor[0]! + this.shadowColor[1]! + this.shadowColor[2]! < 1e-4) {
      this.shadowColor[0] = this.shadowColor[1] = this.shadowColor[2] = 0;
      return false;
    }
    return true;
  }

  // Sampled direction, from the direction helpers below.
  private sx = 0; private sy = 0; private sz = 0;

  /** Cosine-weighted direction about a normal. */
  private cosineDirection(nx: number, ny: number, nz: number): void {
    const r1 = this.random.next(), r2 = this.random.next();
    const phi = 2 * Math.PI * r1;
    const radius = Math.sqrt(r2);
    this.toWorld(nx, ny, nz, radius * Math.cos(phi), radius * Math.sin(phi), Math.sqrt(Math.max(0, 1 - r2)));
  }

  /** Reflection about a GGX-distributed microfacet normal; a mirror reflection when smooth. */
  private reflection(dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, roughness: number): void {
    let hx = nx, hy = ny, hz = nz;
    if (roughness > 0.02) {
      const a = roughness * roughness;
      const r1 = this.random.next(), r2 = this.random.next();
      const phi = 2 * Math.PI * r1;
      const cosTheta = Math.sqrt((1 - r2) / (1 + (a * a - 1) * r2));
      const sinTheta = Math.sqrt(Math.max(0, 1 - cosTheta * cosTheta));
      this.toWorld(nx, ny, nz, sinTheta * Math.cos(phi), sinTheta * Math.sin(phi), cosTheta);
      hx = this.sx; hy = this.sy; hz = this.sz;
    }
    const dn = dx * hx + dy * hy + dz * hz;
    this.sx = dx - 2 * dn * hx; this.sy = dy - 2 * dn * hy; this.sz = dz - 2 * dn * hz;
  }

  /** Refracted direction for a relative index eta; false on total internal reflection. */
  private refract(dx: number, dy: number, dz: number, nx: number, ny: number, nz: number, eta: number): boolean {
    const cosi = -(dx * nx + dy * ny + dz * nz);
    const k = 1 - eta * eta * (1 - cosi * cosi);
    if (k < 0) return false;
    const s = eta * cosi - Math.sqrt(k);
    this.sx = eta * dx + s * nx; this.sy = eta * dy + s * ny; this.sz = eta * dz + s * nz;
    const length = Math.hypot(this.sx, this.sy, this.sz) || 1;
    this.sx /= length; this.sy /= length; this.sz /= length;
    return true;
  }

  /** Converts a direction from a normal's tangent frame to world space, into sx, sy, sz. */
  private toWorld(nx: number, ny: number, nz: number, a: number, b: number, c: number): void {
    // Orthonormal basis (Duff et al. 2017).
    const sign = nz >= 0 ? 1 : -1;
    const e = -1 / (sign + nz);
    const f = nx * ny * e;
    const tx = 1 + sign * nx * nx * e, ty = sign * f, tz = -sign * nx;
    const bx = f, by = sign + ny * ny * e, bz = -ny;
    this.sx = tx * a + bx * b + nx * c;
    this.sy = ty * a + by * b + ny * c;
    this.sz = tz * a + bz * b + nz * c;
  }

  /** Fog factor at a camera ray's first hit, from three.js's fog formulas. */
  private fog(camera: CompiledCamera, px: number, py: number, pz: number): number {
    const fog = this.scene.fog;
    if (!fog) return 0;
    const f = camera.forward, c = camera.position;
    const depth = (px - c[0]) * f[0] + (py - c[1]) * f[1] + (pz - c[2]) * f[2];
    if (fog.kind === 'linear') return smoothstep(fog.near, fog.far, depth);
    return 1 - Math.exp(-fog.density * fog.density * depth * depth);
  }

  /** What a camera ray that hits nothing shows: premultiplied RGBA. */
  private background(dx: number, dy: number, dz: number, sx: number, sy: number, out: number[]): void {
    const { scene, settings } = this;
    const background = scene.background;
    const c = this.color;
    switch (background.kind) {
      case 'color':
        out[0] = background.color[0]; out[1] = background.color[1]; out[2] = background.color[2]; out[3] = 1;
        return;
      case 'screen': {
        const texture = scene.textures[background.texture]!;
        sampleTexture(texture, sx, 1 - sy, this.texel);
        c[0] = this.texel[0]! * background.intensity;
        c[1] = this.texel[1]! * background.intensity;
        c[2] = this.texel[2]! * background.intensity;
        if (!texture.srgb && settings.toneMapping !== NoToneMapping) toneMap(c, settings.toneMapping, settings.toneMappingExposure);
        out[0] = c[0]!; out[1] = c[1]!; out[2] = c[2]!; out[3] = 1;
        return;
      }
      case 'environment': {
        const environment = scene.environments[background.environment]!;
        sampleEnvironment(environment, scene.textures, dx, dy, dz, c);
        const srgb = scene.textures[environment.kind === 'cube' ? environment.faces[0]! : environment.texture]!.srgb;
        // three.js tone maps a background unless its texture is sRGB encoded.
        if (!srgb && settings.toneMapping !== NoToneMapping) toneMap(c, settings.toneMapping, settings.toneMappingExposure);
        out[0] = c[0]!; out[1] = c[1]!; out[2] = c[2]!; out[3] = 1;
        return;
      }
      default: {
        const a = settings.clearAlpha;
        out[0] = settings.clearColor[0] * a; out[1] = settings.clearColor[1] * a; out[2] = settings.clearColor[2] * a; out[3] = a;
      }
    }
  }
}

function luminance(r: number, g: number, b: number): number {
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** Multiple-scattering energy, Fms * Ems, of three.js's computeMultiscattering for one channel. */
function multiScatter(fssEss: number, f0: number, ems: number): number {
  const fAvg = f0 + (1 - f0) * 0.047619;
  return ((fssEss * fAvg) / (1 - ems * fAvg)) * ems;
}

/** World-space ray through a point in normalised device coordinates: origin then direction. */
export function cameraRay(camera: CompiledCamera, x: number, y: number, out: Float64Array): void {
  const near = unproject(camera, x, y, -1);
  const far = unproject(camera, x, y, 1);
  let dx = far[0] - near[0], dy = far[1] - near[1], dz = far[2] - near[2];
  const length = Math.hypot(dx, dy, dz) || 1;
  dx /= length; dy /= length; dz /= length;
  out[0] = near[0]; out[1] = near[1]; out[2] = near[2];
  out[3] = dx; out[4] = dy; out[5] = dz;
}

function unproject(camera: CompiledCamera, x: number, y: number, z: number): [number, number, number] {
  const p = camera.projectionInverse;
  const w = p[3]! * x + p[7]! * y + p[11]! * z + p[15]!;
  const vx = (p[0]! * x + p[4]! * y + p[8]! * z + p[12]!) / w;
  const vy = (p[1]! * x + p[5]! * y + p[9]! * z + p[13]!) / w;
  const vz = (p[2]! * x + p[6]! * y + p[10]! * z + p[14]!) / w;
  const m = camera.world;
  return [
    m[0]! * vx + m[4]! * vy + m[8]! * vz + m[12]!,
    m[1]! * vx + m[5]! * vy + m[9]! * vz + m[13]!,
    m[2]! * vx + m[6]! * vy + m[10]! * vz + m[14]!,
  ];
}
