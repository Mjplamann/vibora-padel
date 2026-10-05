// Venue 'sunset': an outdoor Mediterranean club at golden hour. The court sits on a limestone
// terrace above the sea; the sun is low over the water to the far left, so the glass, the mesh
// and the posts throw long shadows across the court (the 5 cm mesh and the glass are an analytic
// veil in the ground shaders, environment.js VEIL_GLSL; posts, palms, poles and players use the
// shadow map). Date palms along the balustrade glow against the sun, a white village climbs the
// hill behind, the clubhouse pergola has its string lights on.
import * as THREE from 'three';
import { COURT } from '../../config.js';
import { pavingTexture, PAVING_TILE_M } from '../textures.js';
import { boxAt, merge, tint, instancedFrom, disposeTree, seeded, keepSet, NEIGHBOR_OFFSET, floorAround, courtFootprints } from './common.js';
import { createSky, skyRadiance } from './sky.js';
import { createCrowd, randomLook } from '../crowd.js';
import { detailNormal, addTriplanarDetail } from '../detailMaps.js';
import { VEIL_GLSL, veilLightsChunk } from './veil.js';

/** Sun: 9.5° above the sea, 52° to the left of looking down the court from the near baseline. */
export const SUN = Object.freeze({ elevationDeg: 9.5, azimuthDeg: 52 });
const TERRACE = { xMin: -16, xMax: 25, zMin: -24, zMax: 27 };
const SUN_K = 9; // direct-sun irradiance scale (linear, exposure 1)
const SUNSET_COURTS = 2; // main court + the right-hand neighbour (courtXs order: 0, +13, -13)

export function sunDirection({ elevationDeg, azimuthDeg } = SUN) {
  const el = THREE.MathUtils.degToRad(elevationDeg), az = THREE.MathUtils.degToRad(azimuthDeg);
  // Azimuth measured from -z (down the court) toward -x (the player's left).
  return new THREE.Vector3(-Math.sin(az) * Math.cos(el), Math.sin(el), -Math.cos(az) * Math.cos(el)).normalize();
}

/** Ground shading shared by the terrace and the land: analytic enclosure shadow + world varyings. */
function addGroundVeil(mat, key, extraFrag = '') {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSun = mat.userData.uSun;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGW = (modelMatrix * vec4(transformed, 1.0)).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec3 vGW;
        ${VEIL_GLSL}
        vec3 gSunVeil = vec3(1.0);`)
      .replace('#include <map_fragment>', `#include <map_fragment>
        gSunVeil = enclosureVeil(vec3(vGW.x, 0.0, vGW.z), uSun.xyz) * enclosureVeil(vec3(vGW.x - ${NEIGHBOR_OFFSET.toFixed(1)}, 0.0, vGW.z), uSun.xyz);
        ${extraFrag}`)
      .replace('#include <lights_fragment_begin>', veilLightsChunk());
  };
  mat.customProgramCacheKey = () => `vibora-ground-${key}`;
}

/** Back-lit foliage: leaves glow warm when the low sun is behind them. */
function addTranslucency(mat, sunDir, sunCol, k) {
  mat.onBeforeCompile = (sh) => {
    sh.uniforms.uSunT = { value: sunDir };
    sh.uniforms.uSunC = { value: sunCol.clone().multiplyScalar(k) };
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform vec3 uSunT;\nuniform vec3 uSunC;\nvarying vec3 vWorldPosT;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          vec3 Vw = normalize(cameraPosition - vWorldPosT);
          float back = pow(max(dot(-Vw, uSunT), 0.0), 5.0);
          totalEmissiveRadiance += uSunC * diffuseColor.rgb * (0.08 + back * 1.6);
        }`);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWorldPosT;')
      .replace('#include <worldpos_vertex>', `#include <worldpos_vertex>
        vWorldPosT = (modelMatrix * vec4(transformed, 1.0)).xyz;
        #ifdef USE_INSTANCING
        vWorldPosT = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;
        #endif`);
  };
  mat.customProgramCacheKey = () => 'vibora-foliage';
}

/** Hills behind the terrace (+x / +z); flat on and around the terrace. */
function hillHeight(x, z) {
  const dx = Math.max(0, x - (TERRACE.xMax + 2)), dz = Math.max(0, z - (TERRACE.zMax + 2));
  const d = Math.hypot(dx, dz);
  const n = Math.sin(x * 0.07) * Math.cos(z * 0.05) + 0.5 * Math.sin(x * 0.13 + z * 0.11);
  return Math.max(0, 24 * THREE.MathUtils.smoothstep(d, 4, 70) * (0.85 + 0.15 * n) + (d > 2 ? n * 0.8 : 0));
}

// ---------------------------------------------------------------------------------------------
// Palms (Phoenix date palm): curved, ringed trunk; a crown of arching pinnate fronds.

function palmTrunkGeometry(rng) {
  const H = 9.5;
  const rings = 56, seg = 14;
  const pos = [], nor = [], uv = [], idx = [];
  const bend = (t) => new THREE.Vector3(0.55 * t * t, H * t, 0.12 * Math.sin(t * 3));
  for (let i = 0; i <= rings; i++) {
    const t = i / rings;
    const c = bend(t);
    const r = (0.3 - 0.11 * t) * (1 + 0.07 * Math.sin(t * 160)) * (i === 0 ? 1.25 : 1);
    for (let j = 0; j <= seg; j++) {
      const a = (j / seg) * Math.PI * 2;
      const nx = Math.cos(a), nz = Math.sin(a);
      pos.push(c.x + nx * r, c.y, c.z + nz * r);
      nor.push(nx, 0, nz);
      uv.push(j / seg, t * 12);
    }
  }
  for (let i = 0; i < rings; i++) {
    for (let j = 0; j < seg; j++) {
      const a = i * (seg + 1) + j, b = a + seg + 1;
      idx.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setIndex(idx);
  g.userData.top = bend(1);
  return g;
}

function palmCrownGeometry(rng, top) {
  const pos = [], col = [], idx = [];
  const green = new THREE.Color(0x587a2c), dry = new THREE.Color(0x8a7a48), dark = new THREE.Color(0x34501c);
  const v = new THREE.Vector3(), tng = new THREE.Vector3(), side = new THREE.Vector3(), up = new THREE.Vector3(0, 1, 0);
  const fronds = 22;
  const golden = Math.PI * (3 - Math.sqrt(5));
  const push = (p, c) => {
    pos.push(p.x, p.y, p.z);
    col.push(c.r, c.g, c.b);
    return pos.length / 3 - 1;
  };
  for (let f = 0; f < fronds; f++) {
    const phi = f * golden + rng() * 0.3;
    const age = f / fronds; // young fronds point up, old ones droop
    const elev = THREE.MathUtils.lerp(1.0, -0.55, age) + (rng() - 0.5) * 0.2;
    const L = 3.3 + rng() * 1.1;
    const dir = new THREE.Vector3(Math.cos(phi) * Math.cos(elev), Math.sin(elev), Math.sin(phi) * Math.cos(elev));
    const droop = 0.12 + 0.12 * age;
    const base = top.clone().add(new THREE.Vector3(0, -0.15, 0));
    const at = (s) => base.clone().addScaledVector(dir, s).add(new THREE.Vector3(0, -droop * s * s, 0));
    const c = age > 0.92 ? dry : green.clone().lerp(dark, rng() * 0.5);
    // Round 6: leaflets are tapered blades (3 triangles), in two ranks per side folded up and down
    // into the V of a Phoenix frond, and dense enough to read as a plume rather than a fishbone.
    const steps = 32;
    const tipC = c.clone().lerp(new THREE.Color(0x8fa45a), 0.25);
    for (let k = 0; k < steps; k++) {
      const s = 0.3 + (k / steps) * (L - 0.3);
      const p = at(s);
      tng.copy(at(s + 0.05)).sub(p).normalize();
      side.crossVectors(tng, up).normalize();
      const len = (0.95 * Math.sin(Math.PI * Math.min(1, (s / L) * 1.05)) ** 0.7 + 0.1) * (0.85 + rng() * 0.3);
      for (const sgn of [-1, 1]) {
        for (const rank of [0.28, -0.42]) {
          const dirL = side.clone().multiplyScalar(sgn).addScaledVector(tng, 0.5 + rng() * 0.15).addScaledVector(up, rank + (rng() - 0.5) * 0.15).normalize();
          const w0 = 0.012, w1 = 0.03;
          const shade = 0.85 + rng() * 0.3;
          const cb = c.clone().multiplyScalar(0.75 * shade), cm = c.clone().multiplyScalar(shade), ct = tipC.clone().multiplyScalar(shade);
          const a = push(v.copy(p).addScaledVector(tng, -w0), cb);
          const b = push(v.copy(p).addScaledVector(tng, w0), cb);
          const m1 = push(v.copy(p).addScaledVector(dirL, len * 0.45).addScaledVector(tng, w1), cm);
          const m2 = push(v.copy(p).addScaledVector(dirL, len * 0.45).addScaledVector(tng, -w1 * 0.6), cm);
          const t = push(v.copy(p).addScaledVector(dirL, len), ct);
          idx.push(a, b, m1, a, m1, m2, m2, m1, t);
        }
      }
    }
    // Rachis.
    for (let k = 0; k < 12; k++) {
      const s0 = (k / 12) * L, s1 = ((k + 1) / 12) * L;
      const p0 = at(s0), p1 = at(s1);
      const w = 0.035 * (1 - k / 12) + 0.01;
      const a = push(v.copy(p0).add(new THREE.Vector3(0, w, 0)), dry);
      const b = push(v.copy(p0).add(new THREE.Vector3(0, -w, 0)), dry);
      const c2 = push(v.copy(p1).add(new THREE.Vector3(0, w, 0)), dry);
      const d = push(v.copy(p1).add(new THREE.Vector3(0, -w, 0)), dry);
      idx.push(a, b, c2, b, d, c2);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {{ scene, renderer, mats, q, courtXs }} ctx
 */
export function buildSunset(ctx) {
  const { scene, mats: courtMats, q } = ctx;
  const group = new THREE.Group();
  group.name = 'venue-sunset';
  const rng = seeded(808);
  const sunDir = sunDirection();
  const sky = createSky({ sunDir, cloud: 0.6 });
  group.add(sky.mesh);
  const T = sky.sunTransmittance;
  const tMax = Math.max(...T);
  const sunCol = new THREE.Color(T[0] / tMax, T[1] / tMax, T[2] / tMax);
  const uSun = { value: new THREE.Vector4(sunDir.x, sunDir.y, sunDir.z, 1) };

  // ---- lights -------------------------------------------------------------------------------
  const sun = new THREE.DirectionalLight(sunCol, SUN_K * tMax);
  sun.name = 'sun';
  sun.position.copy(sunDir).multiplyScalar(70);
  sun.target.position.set(0, 0, 0);
  sun.castShadow = true;
  sun.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  sun.shadow.radius = Math.max(2, q.shadowRadius * 0.6);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.035;
  {
    // Ortho shadow window around the courts' receivers (casters up-sun are inside the depth range).
    const cam = sun.shadow.camera;
    const view = new THREE.Matrix4().lookAt(sun.position, sun.target.position, new THREE.Vector3(0, 1, 0));
    const inv = view.clone().invert();
    const box = [];
    for (const x of [-15, NEIGHBOR_OFFSET + 6]) for (const y of [0, 4.5]) for (const z of [-21, 21]) box.push(new THREE.Vector3(x, y, z));
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of box) {
      const l = p.clone().sub(sun.position).applyMatrix4(inv);
      minX = Math.min(minX, l.x); maxX = Math.max(maxX, l.x);
      minY = Math.min(minY, l.y); maxY = Math.max(maxY, l.y);
    }
    cam.left = minX; cam.right = maxX; cam.bottom = minY; cam.top = maxY;
    cam.near = 1;
    cam.far = 150;
    cam.updateProjectionMatrix();
  }
  group.add(sun, sun.target);
  const zen = skyRadiance({ x: 0, y: 1, z: 0 }, sunDir);
  const hemi = new THREE.HemisphereLight(new THREE.Color(zen[0], zen[1], zen[2]).multiplyScalar(1.6), new THREE.Color(0.62, 0.42, 0.28), 1.0);
  hemi.userData.baseIntensity = 1.0;
  hemi.userData.noFillBoost = true;
  group.add(hemi);
  // Warm bounce off the sunlit terrace and the white clubhouse (no shadows).
  const bounce = new THREE.DirectionalLight(new THREE.Color(1.0, 0.66, 0.42), 0.55);
  bounce.position.set(6, 3, 14);
  bounce.target.position.set(0, 1, 0);
  group.add(bounce, bounce.target);
  // Round 5 (QA r5 presence): the low sun ahead-left throws the player's shadow far behind them. The
  // court floodlights have come on for the evening: one behind the near back glass casts the
  // player's shadow forward onto the court in view (the second shadow-casting light).
  const flood = new THREE.SpotLight(new THREE.Color(1.0, 0.93, 0.82), 55, 0, 0.6, 0.7, 2);
  flood.name = 'near-back-flood';
  flood.position.set(0, 7.0, 14.5);
  flood.target.position.set(0, 0, 3.5);
  flood.castShadow = true;
  flood.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
  flood.shadow.radius = q.shadowRadius;
  flood.shadow.bias = -0.00015;
  flood.shadow.normalBias = 0.02;
  flood.shadow.camera.near = 3;
  flood.shadow.camera.far = 32;
  group.add(flood, flood.target);
  const lights = { keys: [sun, flood], fills: [bounce], neighbors: [], hemi, sun, all: [sun, flood, bounce, hemi] };

  // ---- materials ----------------------------------------------------------------------------
  const pave = pavingTexture();
  const terraceMat = new THREE.MeshStandardMaterial({
    map: pave, normalMap: pave.userData.normalMap, roughnessMap: pave.userData.roughnessMap, roughness: 1, envMapIntensity: 0.5,
  });
  terraceMat.userData.uSun = uSun;
  addGroundVeil(terraceMat, 'terrace');
  const landMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.95, envMapIntensity: 0.3 });
  landMat.userData.uSun = uSun;
  addGroundVeil(landMat, 'land', `
    {
      vec2 lp = vGW.xz;
      float n1 = sin(lp.x * 0.31) * sin(lp.y * 0.27) * 0.5 + 0.5;
      float n2 = fract(sin(dot(floor(lp * 1.7), vec2(12.9898, 78.233))) * 43758.5453);
      vec3 dryGrass = vec3(0.36, 0.3, 0.16), scrub = vec3(0.16, 0.2, 0.09), soil = vec3(0.42, 0.3, 0.2);
      vec3 c = mix(dryGrass, scrub, smoothstep(0.55, 0.85, n1 * 0.7 + n2 * 0.3));
      c = mix(c, soil, smoothstep(0.75, 0.95, n2) * 0.5);
      diffuseColor.rgb *= c;
    }`);
  const stone = new THREE.MeshStandardMaterial({ color: 0xe9e0d0, roughness: 0.85 });
  const props = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7 });
  const glow = new THREE.MeshBasicMaterial({ vertexColors: true });
  const trunkMat = new THREE.MeshStandardMaterial({ color: 0x6a5a48, roughness: 0.95 });
  addTriplanarDetail(trunkMat, detailNormal('grit-normal'), { scale: 2.5, strength: 0.6, key: 'bark' });
  const frondMat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.7, side: THREE.DoubleSide });
  addTranslucency(frondMat, sunDir, sunCol, 2.2);
  const houseMat = new THREE.MeshStandardMaterial({ color: 0xf1ebe0, roughness: 0.9 });
  houseMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHL;\nvarying vec3 vHN;\nvarying float vHSeed;')
      .replace('#include <begin_vertex>', `#include <begin_vertex>
        #ifdef USE_INSTANCING
        vec3 hs = vec3(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz), length(instanceMatrix[2].xyz));
        vHSeed = fract(sin(dot(instanceMatrix[3].xz, vec2(12.9898, 78.233))) * 43758.5453);
        #else
        vec3 hs = vec3(1.0);
        vHSeed = 0.5;
        #endif
        vHL = (position + vec3(0.0, 0.5, 0.0)) * hs;
        vHN = normal;`);
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vHL;\nvarying vec3 vHN;\nvarying float vHSeed;\nfloat gWin = 0.0;\nfloat gLit = 0.0;')
      .replace('#include <map_fragment>', `#include <map_fragment>
        {
          float lat = abs(vHN.x) > 0.5 ? vHL.z : vHL.x;
          float wall = step(abs(vHN.y), 0.5);
          vec2 cell = vec2(lat / 2.6, (vHL.y - 0.6) / 3.0);
          vec2 f = fract(cell);
          float win = step(0.3, f.x) * step(f.x, 0.72) * step(0.25, f.y) * step(f.y, 0.75) * wall * step(0.6, vHL.y);
          float h = fract(sin(dot(floor(cell) + vHSeed * 17.0, vec2(41.3, 289.1))) * 15731.7);
          gWin = win;
          gLit = win * step(0.72, h);
          vec3 tint = mix(vec3(1.0), vec3(1.0, 0.86, 0.66), step(0.7, vHSeed)) * mix(1.0, 0.92, step(0.4, fract(vHSeed * 7.0)));
          diffuseColor.rgb *= mix(tint, vec3(0.05, 0.06, 0.07), win);
        }`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        totalEmissiveRadiance += vec3(1.0, 0.62, 0.32) * 1.6 * gLit;`);
  };
  houseMat.customProgramCacheKey = () => 'vibora-houses';
  const roofMat = new THREE.MeshStandardMaterial({ color: 0xa4512e, roughness: 0.8 });
  const cypressMat = new THREE.MeshStandardMaterial({ color: 0x1f3518, roughness: 0.9 });

  // ---- ground -------------------------------------------------------------------------------
  const shown = (ctx.courtXs || [0]).slice(0, SUNSET_COURTS);
  const terrace = new THREE.Mesh(floorAround(TERRACE.xMin, TERRACE.xMax, TERRACE.zMin, TERRACE.zMax, -0.012, PAVING_TILE_M, courtFootprints(shown, COURT.halfWidth, COURT.halfLength)), terraceMat);
  terrace.receiveShadow = true;
  terrace.name = 'terrace';
  group.add(terrace);
  {
    const W = 120, D = 120, nx = 60, nz = 60;
    const g = new THREE.PlaneGeometry(W, D, nx, nz);
    g.rotateX(-Math.PI / 2);
    g.translate(TERRACE.xMin + W / 2, -0.05, TERRACE.zMin + D / 2);
    const p = g.attributes.position;
    for (let i = 0; i < p.count; i++) {
      const x = p.getX(i), z = p.getZ(i);
      const inT = x > TERRACE.xMin && x < TERRACE.xMax && z > TERRACE.zMin && z < TERRACE.zMax;
      p.setY(i, inT ? -0.05 : hillHeight(x, z) - 0.05);
    }
    g.computeVertexNormals();
    const land = new THREE.Mesh(g, landMat);
    land.receiveShadow = true;
    land.name = 'land';
    group.add(land);
  }

  // ---- balustrade along the cliff (far end and left side) ------------------------------------
  {
    const prof = [[0, 0], [0.075, 0], [0.075, 0.05], [0.05, 0.08], [0.045, 0.2], [0.075, 0.42], [0.04, 0.62], [0.06, 0.7], [0.075, 0.74], [0, 0.74]]
      .map(([r, y]) => new THREE.Vector2(r, y));
    const baluster = new THREE.LatheGeometry(prof, 10);
    const mats4 = [];
    const m4 = new THREE.Matrix4();
    for (let x = TERRACE.xMin + 0.2; x < TERRACE.xMax; x += 0.24) mats4.push(m4.clone().makeTranslation(x, 0.12, TERRACE.zMin + 0.15));
    for (let z = TERRACE.zMin + 0.4; z < TERRACE.zMax; z += 0.24) mats4.push(m4.clone().makeTranslation(TERRACE.xMin + 0.15, 0.12, z));
    group.add(instancedFrom(baluster, stone, mats4, { name: 'balusters' }));
    const rails = [];
    rails.push(boxAt(TERRACE.xMax - TERRACE.xMin, 0.12, 0.34, (TERRACE.xMin + TERRACE.xMax) / 2, 0.06, TERRACE.zMin + 0.15));
    rails.push(boxAt(TERRACE.xMax - TERRACE.xMin, 0.1, 0.36, (TERRACE.xMin + TERRACE.xMax) / 2, 0.91, TERRACE.zMin + 0.15));
    rails.push(boxAt(0.34, 0.12, TERRACE.zMax - TERRACE.zMin, TERRACE.xMin + 0.15, 0.06, (TERRACE.zMin + TERRACE.zMax) / 2));
    rails.push(boxAt(0.36, 0.1, TERRACE.zMax - TERRACE.zMin, TERRACE.xMin + 0.15, 0.91, (TERRACE.zMin + TERRACE.zMax) / 2));
    for (let x = TERRACE.xMin; x <= TERRACE.xMax; x += 4) rails.push(boxAt(0.3, 0.98, 0.3, x, 0.49, TERRACE.zMin + 0.15));
    for (let z = TERRACE.zMin; z <= TERRACE.zMax; z += 4) rails.push(boxAt(0.3, 0.98, 0.3, TERRACE.xMin + 0.15, 0.49, z));
    // Cliff face below the terrace edge (seen from the overview).
    rails.push(boxAt(TERRACE.xMax - TERRACE.xMin + 1, 14, 0.6, (TERRACE.xMin + TERRACE.xMax) / 2, -7.1, TERRACE.zMin - 0.15));
    rails.push(boxAt(0.6, 14, TERRACE.zMax - TERRACE.zMin + 1, TERRACE.xMin - 0.15, -7.1, (TERRACE.zMin + TERRACE.zMax) / 2));
    const rail = new THREE.Mesh(merge(rails), stone);
    rail.receiveShadow = true;
    group.add(rail);
  }

  // ---- palms ----------------------------------------------------------------------------------
  {
    const trunk = palmTrunkGeometry(rng);
    const crown = palmCrownGeometry(rng, trunk.userData.top);
    const spots = [
      [-13.5, -22.6], [-8.2, -23.0], [-2.6, -22.8], [3.4, -23.1], [9.6, -22.7], [16.5, -22.9], [22.6, -22.5],
      [-14.6, -15.5], [-14.4, -6.2], [-14.7, 3.5], [-14.3, 12.8],
      [-11.5, 18.5], [11.8, 18.8], [21.5, 16.5],
    ];
    const list = spots.map(([x, z]) => {
      const s = 0.85 + rng() * 0.35;
      return new THREE.Matrix4().compose(new THREE.Vector3(x, 0, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rng() * Math.PI * 2), new THREE.Vector3(s, s * (0.9 + rng() * 0.25), s));
    });
    group.add(instancedFrom(trunk, trunkMat, list, { cast: true, name: 'palm-trunks' }));
    group.add(instancedFrom(crown, frondMat, list, { cast: true, name: 'palm-crowns' }));
  }

  // ---- village on the hill, cypresses -----------------------------------------------------------
  {
    const unit = new THREE.BoxGeometry(1, 1, 1);
    unit.translate(0, 0.5, 0);
    const roofG = new THREE.CylinderGeometry(0.72, 0.72, 1, 4, 1);
    roofG.rotateY(Math.PI / 4);
    roofG.scale(1, 0.32, 1);
    roofG.translate(0, 0.16, 0);
    const houses = [], roofs = [], cyp = [];
    const place = (x, z) => {
      const w = 5 + rng() * 5, d = 5 + rng() * 4, h = 3.2 + Math.floor(rng() * 3) * 2.9;
      const y = hillHeight(x, z) - 0.6;
      const rot = (rng() - 0.5) * 0.4 + (rng() < 0.5 ? 0 : Math.PI / 2);
      const q4 = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), rot);
      houses.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), q4, new THREE.Vector3(w, h + 0.6, d)));
      if (rng() < 0.45) roofs.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y + h + 0.6, z), q4, new THREE.Vector3(w * 1.02, 4, d * 1.02)));
    };
    for (let i = 0; i < 70; i++) {
      const a = rng() * Math.PI * 0.5; // the land quadrant (+x, +z)
      const r = 40 + rng() * 48;
      const x = TERRACE.xMax - 6 + Math.cos(a) * r * 0.9, z = TERRACE.zMax - 6 + Math.sin(a) * r * 0.9;
      if (Math.hypot(x, z) > 104) continue;
      place(x, z);
    }
    for (let i = 0; i < 46; i++) {
      const a = rng() * Math.PI * 0.5;
      const r = 12 + rng() * 70;
      const x = TERRACE.xMax + Math.cos(a) * r, z = TERRACE.zMax + Math.sin(a) * r * 0.9 - 8;
      if (Math.hypot(x, z) > 104 || (x < TERRACE.xMax + 1 && z < TERRACE.zMax + 1)) continue;
      const s = 0.8 + rng() * 0.6;
      cyp.push(new THREE.Matrix4().compose(new THREE.Vector3(x, hillHeight(x, z) - 0.2, z), new THREE.Quaternion(), new THREE.Vector3(s, s * (1 + rng() * 0.5), s)));
    }
    group.add(instancedFrom(unit, houseMat, houses, { name: 'village' }));
    group.add(instancedFrom(roofG, roofMat, roofs, { name: 'village-roofs' }));
    const cone = new THREE.ConeGeometry(0.9, 9, 10, 1);
    cone.translate(0, 4.5, 0);
    group.add(instancedFrom(cone, cypressMat, cyp, { name: 'cypresses' }));
  }

  // ---- clubhouse with a pergola and string lights (behind the near baseline) ------------------
  {
    const parts = [], glows = [];
    const white = new THREE.Color(0xf2ece2), wood = new THREE.Color(0x5b3d26), glass = new THREE.Color(0x1b2a33), terracotta = new THREE.Color(0xa4512e);
    const z0 = 21.5;
    parts.push(tint(boxAt(18, 3.4, 4.6, 0, 1.7, z0 + 2.3), white));
    parts.push(tint(boxAt(10, 3.0, 4.2, -2, 4.9, z0 + 2.4), white));
    parts.push(tint(boxAt(18.4, 0.18, 5.0, 0, 3.49, z0 + 2.3), white));
    for (let x = -7.5; x <= 7.5; x += 2.5) parts.push(tint(boxAt(1.8, 2.4, 0.06, x, 1.3, z0 + 0.0), glass));
    for (let x = -5.5; x <= 1.5; x += 2) parts.push(tint(boxAt(1.2, 1.5, 0.06, x, 5.0, z0 + 0.28), glass));
    parts.push(tint(boxAt(10.4, 0.25, 4.6, -2, 6.45, z0 + 2.4), terracotta));
    // Pergola.
    for (let x = -8; x <= 8; x += 2.67) for (const z of [z0 - 3.4, z0 - 0.2]) parts.push(tint(boxAt(0.14, 2.7, 0.14, x, 1.35, z), wood));
    for (let x = -8; x <= 8; x += 1.0) parts.push(tint(boxAt(0.08, 0.16, 3.8, x, 2.78, z0 - 1.8), wood));
    parts.push(tint(boxAt(16.4, 0.18, 0.16, 0, 2.65, z0 - 3.4), wood), tint(boxAt(16.4, 0.18, 0.16, 0, 2.65, z0 - 0.2), wood));
    // Tables and chairs under the pergola.
    for (let x = -6; x <= 6; x += 3) {
      const t = new THREE.CylinderGeometry(0.4, 0.4, 0.04, 16);
      t.translate(x, 0.74, z0 - 1.8);
      parts.push(tint(t, white));
      const leg = new THREE.CylinderGeometry(0.04, 0.05, 0.72, 8);
      leg.translate(x, 0.36, z0 - 1.8);
      parts.push(tint(leg, wood));
    }
    // String lights: catenaries between the pergola posts, warm bulbs.
    for (const z of [z0 - 3.4, z0 - 0.2]) {
      for (let x = -8; x < 8; x += 2.67) {
        for (let k = 1; k < 8; k++) {
          const u = k / 8;
          const b = new THREE.SphereGeometry(0.035, 8, 6);
          b.translate(x + u * 2.67, 2.55 - Math.sin(u * Math.PI) * 0.28, z);
          glows.push(tint(b, new THREE.Color(1.0, 0.72, 0.4).multiplyScalar(6)));
        }
      }
    }
    // Warm interior behind the ground-floor glass.
    glows.push(tint(boxAt(16, 2.2, 0.02, 0, 1.3, z0 + 0.12), new THREE.Color(1.0, 0.68, 0.38).multiplyScalar(0.9)));
    // Outdoor court floodlight poles (lamps just switched on).
    const poles = [];
    for (const sx of [-1, 1]) {
      for (const z of [-5.2, 5.2]) {
        poles.push(tint(new THREE.CylinderGeometry(0.06, 0.09, 7.4, 10).translate(sx * 5.75, 3.7, z), new THREE.Color(0x2a2d31)));
        poles.push(tint(boxAt(0.62, 0.12, 0.36, sx * 5.45, 7.35, z, { rotZ: sx * 0.35 }), new THREE.Color(0x1a1c20)));
        glows.push(tint(boxAt(0.56, 0.01, 0.3, sx * 5.43, 7.28, z, { rotZ: sx * 0.35 }), new THREE.Color(1.0, 0.95, 0.85).multiplyScalar(3.0)));
      }
    }
    const pm = new THREE.Mesh(merge(poles), props);
    pm.castShadow = true;
    pm.name = 'flood-poles';
    group.add(pm);
    // Spectator chairs on the left terrace.
    for (let z = -6; z <= 6; z += 1.1) {
      parts.push(tint(boxAt(0.46, 0.04, 0.44, -7.3, 0.45, z), new THREE.Color(0xeeeeee)));
      parts.push(tint(boxAt(0.04, 0.45, 0.44, -7.53, 0.68, z), new THREE.Color(0xeeeeee)));
      for (const dz of [-0.19, 0.19]) for (const dx of [-0.19, 0.19]) parts.push(tint(boxAt(0.03, 0.45, 0.03, -7.3 + dx, 0.225, z + dz), new THREE.Color(0x9aa0a8)));
    }
    const cm = new THREE.Mesh(merge(parts), props);
    cm.castShadow = true;
    cm.receiveShadow = true;
    cm.name = 'clubhouse';
    group.add(cm);
    const gm = new THREE.Mesh(merge(glows), glow);
    gm.name = 'clubhouse-glow';
    group.add(gm);
  }

  // ---- terrace life (round 6): bougainvillea planters, parasols and loungers by the balustrade ---
  {
    const parts = [], leaves = [];
    const rd = seeded(2024);
    const terracotta = new THREE.Color(0xb0603a), canvas = new THREE.Color(0xf3eee4), teak = new THREE.Color(0x7a5232), steelC = new THREE.Color(0x9aa0a8);
    const greens = [0x3f6a2c, 0x4d7a33, 0x2f5524], blooms = [0xc2266e, 0xd8408a, 0xe86aa6];
    const planter = (x, z, big = 1) => {
      const pot = new THREE.CylinderGeometry(0.38 * big, 0.3 * big, 0.62 * big, 18);
      pot.translate(x, 0.31 * big, z);
      parts.push(tint(pot, terracotta));
      const rim = new THREE.TorusGeometry(0.38 * big, 0.03, 6, 18);
      rim.rotateX(Math.PI / 2);
      rim.translate(x, 0.62 * big, z);
      parts.push(tint(rim, terracotta.clone().multiplyScalar(0.85)));
      for (let k = 0; k < 16; k++) {
        const r = 0.14 + rd() * 0.12;
        const g = new THREE.IcosahedronGeometry(r, 1);
        const a = rd() * Math.PI * 2, d = Math.sqrt(rd()) * 0.42 * big;
        g.translate(x + Math.cos(a) * d, (0.7 + rd() * 0.75) * big, z + Math.sin(a) * d);
        const bloom = rd() < 0.38;
        leaves.push(tint(g, new THREE.Color((bloom ? blooms : greens)[(rd() * 3) | 0])));
      }
    };
    for (let z = -9; z <= 9; z += 4.5) planter(-10.2, z, 1.1);
    for (let x = -11; x <= 9; x += 5) planter(x, -21.6, 1.15);
    const parasol = (x, z) => {
      const top = new THREE.ConeGeometry(1.35, 0.42, 12, 1, true);
      top.translate(x, 2.42, z);
      parts.push(tint(top, canvas));
      const pole = new THREE.CylinderGeometry(0.025, 0.03, 2.5, 8);
      pole.translate(x, 1.25, z);
      parts.push(tint(pole, teak));
      const base = new THREE.CylinderGeometry(0.22, 0.25, 0.08, 12);
      base.translate(x, 0.04, z);
      parts.push(tint(base, steelC));
      for (const dx of [-0.75, 0.75]) {
        // Teak lounger with a white cushion, back rest raised.
        parts.push(tint(boxAt(0.62, 0.06, 1.9, x + dx, 0.32, z + 0.35), teak));
        parts.push(tint(boxAt(0.6, 0.07, 1.35, x + dx, 0.39, z + 0.62), canvas));
        parts.push(tint(boxAt(0.6, 0.07, 0.6, x + dx, 0.62, z - 0.42, { rotX: -0.75 }), canvas));
        for (const [ox, oz] of [[-0.26, -0.5], [0.26, -0.5], [-0.26, 1.2], [0.26, 1.2]]) parts.push(tint(boxAt(0.04, 0.3, 0.04, x + dx + ox, 0.15, z + oz), teak));
      }
    };
    parasol(-8.5, -17.5);
    parasol(-3.5, -18.2);
    parasol(4.0, -17.8);
    parasol(-12.6, -12.0);
    const pm = new THREE.Mesh(merge(parts), props);
    pm.castShadow = true;
    pm.receiveShadow = true;
    pm.name = 'terrace-dressing';
    group.add(pm);
    const lm = new THREE.Mesh(merge(leaves), frondMat);
    lm.castShadow = true;
    lm.name = 'terrace-planting';
    group.add(lm);
  }

  // ---- spectators -----------------------------------------------------------------------------
  const people = [];
  {
    const rl = seeded(909);
    for (let z = -6; z <= 6; z += 1.1) {
      if (rl() < 0.3) continue;
      people.push({ x: -7.25, y: 0, z, seated: true, ...randomLook(rl), lit: 1 });
    }
    for (const [x, z] of [[-6.4, -9.4], [-6.0, -8.7], [6.3, 9.6], [-3, 19.4], [-2.4, 19.7], [3.2, 19.2], [5.6, 19.5], [-6.2, 19.6]]) {
      people.push({ x, y: 0, z, seated: false, ...randomLook(rl), lit: 1 });
    }
  }
  const crowd = createCrowd({
    people, msaa: q.msaa > 0, name: 'sunset-spectators', light: new THREE.Color(1, 1, 1), lightK: 1.5,
    keyDir: sunDir, key: 0.95, sky: new THREE.Color(zen[0], zen[1], zen[2]).multiplyScalar(1.6).getHex(), ground: 0x9a7356, hemiK: 0.4,
  });
  crowd.mesh.material.uniforms.uKey.value.copy(sunCol).multiplyScalar(0.95);
  group.add(crowd.mesh);

  // ---- atmosphere -----------------------------------------------------------------------------
  const hz = skyRadiance(new THREE.Vector3(-sunDir.z, 0.06, sunDir.x).normalize(), sunDir);
  const hz2 = skyRadiance(new THREE.Vector3(sunDir.x, 0.05, sunDir.z).normalize(), sunDir);
  const fogCol = new THREE.Color((hz[0] * 0.6 + hz2[0] * 0.4) * 0.9, (hz[1] * 0.6 + hz2[1] * 0.4) * 0.9, (hz[2] * 0.6 + hz2[2] * 0.4) * 0.9);
  scene.fog = new THREE.FogExp2(fogCol, 0.0085);

  return {
    group,
    lights,
    crowd,
    sky,
    sunDir,
    courts: SUNSET_COURTS,
    envIntensity: 0.6,
    reflectScale: 1.1,
    // Image-based light: the photographed seafront at sunset below the horizon (paving, buildings);
    // above it the venue's own analytic sky stays in charge (sky weight 0.25).
    ibl: { ambient: [1, 0.8], reflect: [1, 0.45], sky: 0.25 },
    capturePosition: new THREE.Vector3(0, 2.2, 0),
    turf: { dust: 0.55, wear: 1.15, grain: 0.14, ao: 0.9 },
    glass: { grease: 1.1, felt: 1, water: 1 },
    capture: {
      ambient() { crowd.mesh.visible = false; },
      reflect() {},
      restore() { crowd.mesh.visible = true; },
    },
    react(kind, level) {
      crowd.react(kind, level);
    },
    update(dt, time) {
      sky.update(time);
      crowd.update(dt, time);
    },
    dispose() {
      crowd.dispose();
      if (scene.fog) scene.fog = null;
      disposeTree(group, { keep: keepSet(courtMats) });
    },
  };
}
