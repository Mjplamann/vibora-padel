// The club: an exact FIP court (plus two neighbouring courts) inside an indoor hall at night.
// SPEC §6.3. Court frame: metres, Y up, net plane z = 0, interior x ∈ [-5, 5], z ∈ [-10, 10].
import * as THREE from 'three';
import { RoomEnvironment } from 'three/addons/environments/RoomEnvironment.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { COURT, netHeightAt } from '../config.js';
import { QUALITY } from './scene.js';
import {
  turfTextures, courtWearTexture, meshAlphaTexture, netAlphaTexture, concreteTexture, panelTexture,
  logoTexture, softSpriteTexture, TURF_TILE_M, MESH_TILE_M, CONCRETE_TILE_M, PANEL_TILE_M,
} from './textures.js';

const HW = COURT.halfWidth;
const HL = COURT.halfLength;
const GLASS_T = 0.012;
const GLASS_GAP = 0.006;
const POST = 0.09;
const POST_OFF = GLASS_T + POST / 2 + 0.004; // post centre distance outside the wall plane
const MESH_OFF = 0.006; // mesh sits in the glass mid-plane
const BAND_H = 0.06;

/** Court centres along x: main court plus neighbours. */
export const NEIGHBOR_OFFSET = 13;
/** Interior extent of the hall. */
export const HALL = { xMin: -21, xMax: 21, zMin: -15.5, zMax: 15.5, height: 11, trussBottom: 9.9 };

const LED_WHITE = new THREE.Color(1.0, 0.955, 0.9);
const LED_RADIANCE = 7.5; // linear HDR radiance of the diffusers (well above the bloom threshold)
const LED_RADIANCE_REFLECT = 30; // LED radiance seen in reflections (glass, steel)
const REFLECTIVE = ['glass', 'glassEdge', 'bolt', 'steel'];
const REFLECT_INTENSITY = { glass: 1.5, glassEdge: 1.0, bolt: 0.8, steel: 0.45 };
const LED_RADIANCE_ENV = 2.5; // dimmer in the environment capture: spot lights already carry their light
/** Light intensities (candela for spots). Court centre illuminance ≈ 4.5 (linear units, exposure 1). */
export const LIGHT = { key: 205, fill: 18, neighbor: 175, hemi: 0.08, env: 0.45 };

// ---------------------------------------------------------------------------------------------
// Geometry helpers

function boxAt(w, h, d, x, y, z, { rotY = 0, rotZ = 0, rotX = 0 } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  if (rotX) g.rotateX(rotX);
  if (rotZ) g.rotateZ(rotZ);
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/** Vertical plane with UVs in tiles (metres / tile). axis 'x' = spans x (normal ±z), 'z' = spans z (normal ±x). */
function wallPlane(axis, a0, a1, y0, y1, c, tile, facing = 1) {
  const w = a1 - a0, h = y1 - y0;
  const g = new THREE.PlaneGeometry(w, h);
  const uv = g.attributes.uv;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, ((uv.getX(i) * w) + a0) / tile, ((uv.getY(i) * h) + y0) / tile);
  if (axis === 'x') {
    if (facing < 0) g.rotateY(Math.PI);
    g.translate((a0 + a1) / 2, (y0 + y1) / 2, c);
  } else {
    g.rotateY(facing > 0 ? Math.PI / 2 : -Math.PI / 2);
    g.translate(c, (y0 + y1) / 2, (a0 + a1) / 2);
  }
  return g;
}

function floorPlane(x0, x1, z0, z1, y, tile) {
  const w = x1 - x0, d = z1 - z0;
  const g = new THREE.PlaneGeometry(w, d);
  g.rotateX(-Math.PI / 2);
  g.translate((x0 + x1) / 2, y, (z0 + z1) / 2);
  const uv = g.attributes.uv, pos = g.attributes.position;
  for (let i = 0; i < uv.count; i++) uv.setXY(i, pos.getX(i) / tile, pos.getZ(i) / tile);
  return g;
}

function merge(list) {
  const g = mergeGeometries(list, false);
  for (const x of list) x.dispose();
  return g;
}

function instanced(geometry, material, xs, { cast = false, receive = true, name = '' } = {}) {
  const m = new THREE.InstancedMesh(geometry, material, xs.length);
  const mat4 = new THREE.Matrix4();
  xs.forEach((x, i) => m.setMatrixAt(i, mat4.makeTranslation(x, 0, 0)));
  m.instanceMatrix.needsUpdate = true;
  m.computeBoundingSphere();
  m.castShadow = cast;
  m.receiveShadow = receive;
  m.name = name;
  return m;
}

// ---------------------------------------------------------------------------------------------
// Materials

/** Glass: specular reflections at full strength, body tint scaled by opacity (premultiplied). */
function makeGlassMaterial() {
  const m = new THREE.MeshPhysicalMaterial({
    color: 0xd6ece4,
    roughness: 0.04,
    metalness: 0,
    ior: 1.52,
    specularIntensity: 1,
    transparent: true,
    opacity: 0.14,
    premultipliedAlpha: true,
    depthWrite: false,
    envMapIntensity: 1.5,
    side: THREE.FrontSide,
  });
  m.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlassW;')
      .replace('#include <worldpos_vertex>', '#include <worldpos_vertex>\nvGlassW = (modelMatrix * vec4(transformed, 1.0)).xyz;\n#ifdef USE_INSTANCING\nvGlassW = (modelMatrix * instanceMatrix * vec4(transformed, 1.0)).xyz;\n#endif');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vGlassW;')
      .replace('#include <opaque_fragment>', `
        // Sand dust film near the bottom of the panels and faint haze overall.
        float dust = smoothstep(0.45, 0.0, vGlassW.y) * 0.16;
        // Faint grime/ball-felt haze where balls usually strike (0.4–2.2 m), broken up by noise.
        vec2 gp = vec2(vGlassW.x + vGlassW.z, vGlassW.y) * 2.3;
        vec2 gi = floor(gp), gf = fract(gp);
        gf = gf * gf * (3.0 - 2.0 * gf);
        float h00 = fract(sin(dot(gi, vec2(127.1, 311.7))) * 43758.5);
        float h10 = fract(sin(dot(gi + vec2(1.0, 0.0), vec2(127.1, 311.7))) * 43758.5);
        float h01 = fract(sin(dot(gi + vec2(0.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float h11 = fract(sin(dot(gi + vec2(1.0, 1.0), vec2(127.1, 311.7))) * 43758.5);
        float gn = mix(mix(h00, h10, gf.x), mix(h01, h11, gf.x), gf.y);
        dust += smoothstep(0.55, 1.0, gn) * smoothstep(0.3, 0.8, vGlassW.y) * smoothstep(2.4, 1.6, vGlassW.y) * 0.05;
        float a = clamp(diffuseColor.a + dust, 0.0, 1.0);
        vec3 dustCol = vec3(0.32, 0.31, 0.28) * (totalDiffuse + 0.08);
        gl_FragColor = vec4(totalDiffuse * diffuseColor.a * 0.3 + dustCol * dust + totalSpecular + totalEmissiveRadiance, a);`)
      .replace('#include <premultiplied_alpha_fragment>', '');
  };
  m.customProgramCacheKey = () => 'vibora-glass';
  return m;
}

function makeTurfMaterial(renderer, q) {
  const tt = turfTextures(renderer, { size: q.turfSize });
  const reps = new THREE.Vector2((HW * 2) / TURF_TILE_M, (HL * 2) / TURF_TILE_M);
  for (const t of [tt.map, tt.normalMap, tt.roughnessMap]) t.repeat.copy(reps);
  const wear = courtWearTexture();
  const m = new THREE.MeshPhysicalMaterial({
    map: tt.map,
    normalMap: tt.normalMap,
    normalScale: new THREE.Vector2(0.9, 0.9),
    roughnessMap: tt.roughnessMap,
    roughness: 1,
    metalness: 0,
    sheen: 0.12,
    sheenColor: new THREE.Color(0.32, 0.46, 0.72),
    sheenRoughness: 0.5,
    envMapIntensity: 0.6,
  });
  const uniforms = {
    uWear: { value: wear },
    uLineHalf: { value: COURT.lineWidth / 2 },
    uService: { value: COURT.serviceLine - COURT.lineWidth / 2 },
    uCenterEnd: { value: COURT.serviceLine + COURT.centerLineOverrun },
  };
  m.userData.uniforms = uniforms;
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, uniforms);
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec2 vCourt;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvCourt = position.xz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
        varying vec2 vCourt;
        uniform sampler2D uWear;
        uniform float uLineHalf, uService, uCenterEnd;
        float gLine = 0.0;
        float gWear = 0.0;
        float boxCov(float d, float h, float f) {
          return clamp((min(d + 0.5 * f, h) - max(d - 0.5 * f, -h)) / f, 0.0, 1.0);
        }`)
      .replace('#include <map_fragment>', `
        vec4 texel = texture2D(map, vMapUv);
        float sandMask = texture2D(roughnessMap, vRoughnessMapUv).r;
        vec4 wearS = texture2D(uWear, vec2((vCourt.x + 5.0) / 10.0, (vCourt.y + 10.0) / 20.0));
        float wear = wearS.r;
        float loose = wearS.g;
        float rollVar = wearS.b - 0.5;
        gWear = wear;
        vec3 fib = texel.rgb * (1.0 + rollVar * 1.6);
        float lum = dot(fib, vec3(0.2126, 0.7152, 0.0722));
        // Flattened fibres in worn zones read lighter and greyer; more sand shows through.
        vec3 flatCol = mix(fib, vec3(lum) * vec3(0.9, 1.0, 1.25) * 1.35, 0.45);
        vec3 col = mix(fib, flatCol, wear * 0.7);
        vec3 sandCol = vec3(0.25, 0.24, 0.215);
        col = mix(col, sandCol * (0.85 + 0.3 * lum / 0.06), clamp(wear * 0.16 * (1.0 - sandMask) + loose * 0.6, 0.0, 0.85));
        // Playing lines: exact 5 cm, box-filtered against the pixel footprint (alias-free).
        float fz = max(fwidth(vCourt.y), 1e-4);
        float fx = max(fwidth(vCourt.x), 1e-4);
        float edgeNoise = (lum - 0.05) * 0.06 * (1.0 - smoothstep(0.004, 0.02, fz));
        float az = abs(vCourt.y);
        float svc = boxCov(az - uService + edgeNoise, uLineHalf, fz);
        float ctr = boxCov(vCourt.x + edgeNoise, uLineHalf, fx) * boxCov(az, uCenterEnd, fz);
        gLine = max(svc, ctr);
        vec3 lineCol = vec3(0.74, 0.76, 0.78) * clamp(0.55 + lum * 7.0, 0.6, 1.25);
        lineCol = mix(lineCol, sandCol * 1.6, sandMask * 0.55 + loose * 0.4);
        col = mix(col, lineCol, gLine);
        diffuseColor.rgb *= col;`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
        roughnessFactor = mix(roughnessFactor, 0.93, clamp(gWear * 0.3, 0.0, 1.0));`)
      .replace('#include <normal_fragment_maps>', `#include <normal_fragment_maps>
        normal = normalize(mix(normal, nonPerturbedNormal, clamp(gWear * 0.55, 0.0, 0.8)));`);
  };
  m.customProgramCacheKey = () => 'vibora-turf';
  return m;
}

/** Warm light washing the wall above (dir 1) / below (dir -1) the cove LED strip at 2.72 m. */
const COVE_Y = 2.72;
function addCoveWash(mat, dir) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vWallY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvWallY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vWallY;')
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
        {
          float d = ${dir > 0 ? `max(0.0, vWallY - ${COVE_Y.toFixed(2)})` : `max(0.0, ${COVE_Y.toFixed(2)} - vWallY)`};
          float wash = ${dir > 0 ? 'exp(-d / 1.3) * 0.5 + exp(-d / 0.25) * 0.6' : 'exp(-d / 0.5) * 0.35'};
          totalEmissiveRadiance += vec3(1.0, 0.8, 0.58) * wash * (0.16 + diffuseColor.rgb * 2.0);
        }`);
  };
  mat.customProgramCacheKey = () => `vibora-cove-${dir}`;
}

function makeMaterials(renderer, q) {
  const a2c = q.msaa > 0;
  const meshAlpha = meshAlphaTexture();
  const netAlpha = netAlphaTexture();
  const concrete = concreteTexture();
  const panel = panelTexture();
  const m = {
    steel: new THREE.MeshStandardMaterial({ color: 0x0d0e10, roughness: 0.38, metalness: 0.0, envMapIntensity: 1.2 }),
    glass: makeGlassMaterial(),
    glassEdge: new THREE.MeshStandardMaterial({
      color: 0x78b8a2, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.38, depthWrite: false, envMapIntensity: 1.4,
    }),
    bolt: new THREE.MeshStandardMaterial({ color: 0xc9ced3, roughness: 0.22, metalness: 1.0 }),
    mesh: new THREE.MeshStandardMaterial({
      color: 0x111214, roughness: 0.5, metalness: 0.0, alphaMap: meshAlpha, side: THREE.DoubleSide,
      alphaToCoverage: a2c, transparent: !a2c, depthWrite: a2c, envMapIntensity: 1.0,
    }),
    net: new THREE.MeshStandardMaterial({
      color: 0x0c0d0f, roughness: 0.85, alphaMap: netAlpha, side: THREE.DoubleSide,
      alphaToCoverage: a2c, transparent: !a2c, depthWrite: a2c,
    }),
    netStatic: null,
    band: new THREE.MeshStandardMaterial({ color: 0xf1f1ec, roughness: 0.8 }),
    turf: makeTurfMaterial(renderer, q),
    concrete: new THREE.MeshStandardMaterial({
      map: concrete, normalMap: concrete.userData.normalMap, roughnessMap: concrete.userData.roughnessMap,
      roughness: 1, metalness: 0, envMapIntensity: 0.8,
    }),
    wallUpper: new THREE.MeshStandardMaterial({
      map: panel, normalMap: panel.userData.normalMap, roughnessMap: panel.userData.roughnessMap, roughness: 1,
      metalness: 0.2, color: 0xb9bec6,
    }),
    wallLower: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.82, metalness: 0 }),
    roof: new THREE.MeshStandardMaterial({
      normalMap: panel.userData.normalMap, color: 0x50565e, roughness: 0.8, metalness: 0.0,
    }),
    truss: new THREE.MeshStandardMaterial({ color: 0x6b7179, roughness: 0.6, metalness: 0.0 }),
    duct: new THREE.MeshStandardMaterial({ color: 0x6f757c, roughness: 0.55, metalness: 0.9 }),
    housing: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.45, metalness: 0.7 }),
    led: new THREE.MeshBasicMaterial({ color: LED_WHITE.clone().multiplyScalar(LED_RADIANCE) }),
    ledStrip: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.86, 0.66).multiplyScalar(5.0) }),
    exit: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.0, 0.35).multiplyScalar(1.6) }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 }),
    dummy: new THREE.MeshStandardMaterial({ color: 0x1c2b4a, roughness: 0.7 }),
    dummyStripe: new THREE.MeshStandardMaterial({ color: 0xd9f03a, roughness: 0.5, emissive: 0x2a3008 }),
  };
  m.netStatic = m.net.clone();
  // Wire materials use alpha-to-coverage under MSAA, alpha blending otherwise (scene.setQuality flips it).
  for (const w of [m.mesh, m.net, m.netStatic]) w.userData.alphaMode = 'coverage-or-blend';
  addCoveWash(m.wallUpper, 1);
  addCoveWash(m.wallLower, -1);
  // Concrete/panel tiling comes from geometry UVs in tiles.
  return m;
}

// ---------------------------------------------------------------------------------------------
// Court enclosure (court-local; instanced for the neighbours)

function sideBands() {
  // Mirror the config bands onto both halves: [{z0, z1, glassTop, meshTop}]
  const out = [];
  for (const b of COURT.sideWall) {
    out.push({ z0: b.zMin, z1: b.zMax, glassTop: b.glassTop, meshTop: b.meshTop });
    out.push({ z0: -b.zMax, z1: -b.zMin, glassTop: b.glassTop, meshTop: b.meshTop });
  }
  return out;
}

function buildEnclosureGeometry() {
  const steel = [], glass = [], edges = [], bolts = [], mesh = [];
  const glassPanels = [], meshPanels = [];
  const boltGeo = new THREE.CylinderGeometry(0.021, 0.021, 0.01, 14);

  const addGlass = (wall, sideSign, a0, a1, h) => {
    // wall: 'back' spans x at z = sideSign*HL; 'side' spans z at x = sideSign*HW
    const w = a1 - a0 - GLASS_GAP;
    const c = (a0 + a1) / 2;
    const off = sideSign * (wall === 'back' ? HL : HW) + sideSign * GLASS_T / 2;
    const edgeS = 0.0125;
    if (wall === 'back') {
      glass.push(boxAt(w, h, GLASS_T, c, h / 2, off));
      edges.push(boxAt(w, edgeS, edgeS, c, h - edgeS / 2, off));
      edges.push(boxAt(edgeS, h, edgeS, c - w / 2 + edgeS / 2, h / 2, off));
      edges.push(boxAt(edgeS, h, edgeS, c + w / 2 - edgeS / 2, h / 2, off));
    } else {
      glass.push(boxAt(GLASS_T, h, w, off, h / 2, c));
      edges.push(boxAt(edgeS, edgeS, w, off, h - edgeS / 2, c));
      edges.push(boxAt(edgeS, h, edgeS, off, h / 2, c - w / 2 + edgeS / 2));
      edges.push(boxAt(edgeS, h, edgeS, off, h / 2, c + w / 2 - edgeS / 2));
    }
    // Countersunk fixing bolts on the court face.
    const inner = sideSign * (wall === 'back' ? HL : HW) - sideSign * 0.004;
    for (const da of [-w / 2 + 0.11, w / 2 - 0.11]) {
      for (const y of [0.32, h - 0.32]) {
        const g = boltGeo.clone();
        if (wall === 'back') {
          g.rotateX(Math.PI / 2);
          g.translate(c + da, y, inner);
        } else {
          g.rotateZ(Math.PI / 2);
          g.translate(inner, y, c + da);
        }
        bolts.push(g);
      }
    }
    const normal = wall === 'back' ? new THREE.Vector3(0, 0, -sideSign) : new THREE.Vector3(-sideSign, 0, 0);
    const center = wall === 'back' ? new THREE.Vector3(c, h / 2, sideSign * HL) : new THREE.Vector3(sideSign * HW, h / 2, c);
    glassPanels.push({
      wall, side: (wall === 'back' ? sideSign : c) > 0 ? 'near' : 'far', center, normal, width: w, height: h,
      a0, a1, y0: 0, y1: h,
    });
  };

  const addMesh = (wall, sideSign, a0, a1, y0, y1) => {
    const plane = sideSign * ((wall === 'back' ? HL : HW) + MESH_OFF);
    const g = wallPlane(wall === 'back' ? 'x' : 'z', a0, a1, y0, y1, plane, MESH_TILE_M, -sideSign);
    mesh.push(g);
    // Frame: 35 mm tube around the panel.
    const t = 0.035, w = a1 - a0, h = y1 - y0, c = (a0 + a1) / 2, fo = plane + sideSign * 0.02;
    if (wall === 'back') {
      steel.push(boxAt(w, t, t, c, y0 + t / 2, fo), boxAt(w, t, t, c, y1 - t / 2, fo));
      steel.push(boxAt(t, h, t, a0 + t / 2, (y0 + y1) / 2, fo), boxAt(t, h, t, a1 - t / 2, (y0 + y1) / 2, fo));
    } else {
      steel.push(boxAt(t, t, w, fo, y0 + t / 2, c), boxAt(t, t, w, fo, y1 - t / 2, c));
      steel.push(boxAt(t, h, t, fo, (y0 + y1) / 2, a0 + t / 2), boxAt(t, h, t, fo, (y0 + y1) / 2, a1 - t / 2));
    }
    const normal = wall === 'back' ? new THREE.Vector3(0, 0, -sideSign) : new THREE.Vector3(-sideSign, 0, 0);
    const center = wall === 'back' ? new THREE.Vector3(c, (y0 + y1) / 2, sideSign * HL) : new THREE.Vector3(sideSign * HW, (y0 + y1) / 2, c);
    meshPanels.push({ wall, side: (wall === 'back' ? sideSign : c) > 0 ? 'near' : 'far', center, normal, width: w, height: h, a0, a1, y0, y1 });
  };

  // Back walls.
  for (const s of [-1, 1]) {
    for (let x = -HW; x < HW - 1e-6; x += COURT.postSpacing) {
      addGlass('back', s, x, x + 2, COURT.backWall.glassTop);
      addMesh('back', s, x, x + 2, COURT.backWall.glassTop, COURT.backWall.meshTop);
    }
    for (let x = -HW; x <= HW + 1e-6; x += COURT.postSpacing) {
      steel.push(boxAt(POST, COURT.backWall.meshTop, POST, x, COURT.backWall.meshTop / 2, s * (HL + POST_OFF)));
    }
    // Top rail and glass/mesh transom.
    steel.push(boxAt(HW * 2 + POST, 0.06, 0.06, 0, COURT.backWall.meshTop - 0.03, s * (HL + POST_OFF)));
    steel.push(boxAt(HW * 2, 0.05, 0.05, 0, COURT.backWall.glassTop + 0.025, s * (HL + POST_OFF - 0.02)));
  }
  // Side walls.
  for (const sx of [-1, 1]) {
    for (const b of sideBands()) {
      for (let z = b.z0; z < b.z1 - 1e-6; z += COURT.postSpacing) {
        if (b.glassTop > 0) addGlass('side', sx, z, z + 2, b.glassTop);
        addMesh('side', sx, z, z + 2, b.glassTop, b.meshTop);
      }
      const railZ = (b.z0 + b.z1) / 2;
      steel.push(boxAt(0.06, 0.06, b.z1 - b.z0, sx * (HW + POST_OFF), b.meshTop - 0.03, railZ));
      if (b.glassTop > 0) steel.push(boxAt(0.05, 0.05, b.z1 - b.z0, sx * (HW + POST_OFF - 0.02), b.glassTop + 0.025, railZ));
    }
    for (let z = -HL + COURT.postSpacing; z <= HL - COURT.postSpacing + 1e-6; z += COURT.postSpacing) {
      const az = Math.abs(z);
      const h = az >= 8 - 1e-6 ? 4 : 3;
      steel.push(boxAt(POST, h, POST, sx * (HW + POST_OFF), h / 2, z));
    }
    // Net posts (part of the static steel kit).
    steel.push(boxAt(0.07, netHeightAt(HW) + 0.05, 0.07, sx * (HW - 0.035), (netHeightAt(HW) + 0.05) / 2, 0));
  }
  // Foot plates under each post (adds grounding detail).
  boltGeo.dispose();
  return {
    steel: merge(steel), glass: merge(glass), edges: merge(edges), bolts: merge(bolts), mesh: merge(mesh), glassPanels, meshPanels,
  };
}

// ---------------------------------------------------------------------------------------------
// Net (main court gets the shake shader)

function buildNetGeometry() {
  const segX = 100, segY = 10;
  const g = new THREE.PlaneGeometry(HW * 2, 1, segX, segY);
  const pos = g.attributes.position, uv = g.attributes.uv;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i);
    const t = pos.getY(i) + 0.5;
    const top = netHeightAt(x) - BAND_H * 0.6;
    const y = 0.02 + (top - 0.02) * t;
    pos.setY(i, y);
    uv.setXY(i, x / 1.0, y / 1.0);
  }
  g.computeVertexNormals();
  return g;
}

function buildBandGeometry() {
  const parts = [];
  for (const s of [-1, 1]) {
    const rise = COURT.net.postHeight - COURT.net.centerHeight;
    const len = Math.hypot(HW, rise);
    const g = new THREE.BoxGeometry(len, BAND_H, 0.012, 60, 1, 1);
    g.translate(0, -BAND_H / 2, 0);
    g.rotateZ(Math.atan2(rise, HW) * s);
    g.translate((s * HW) / 2, (COURT.net.centerHeight + COURT.net.postHeight) / 2, 0);
    parts.push(g);
  }
  // Bottom cord.
  parts.push(boxAt(HW * 2, 0.012, 0.012, 0, 0.02, 0));
  return merge(parts);
}

function createNet(mats) {
  const group = new THREE.Group();
  group.name = 'vibora-net';
  const shake = { value: new THREE.Vector4(0, 0, 99, 0) }; // x0, amplitude, time since hit, unused
  const inject = (mat, profileExpr) => {
    mat.onBeforeCompile = (sh) => {
      sh.uniforms.uShake = shake;
      sh.vertexShader = sh.vertexShader
        .replace('#include <common>', '#include <common>\nuniform vec4 uShake;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>
          {
            float dx = abs(position.x - uShake.x);
            float t = uShake.z;
            float env = exp(-dx / 1.4) * exp(-t * 2.8);
            float wave = sin(t * 24.0 - dx * 4.5) + 0.35 * sin(t * 41.0 - dx * 9.0);
            float prof = ${profileExpr};
            transformed.z += uShake.y * env * wave * prof;
          }`);
    };
    mat.customProgramCacheKey = () => `vibora-net-${profileExpr.length}`;
  };
  const netMat = mats.net;
  const bandMat = mats.band.clone();
  inject(netMat, 'sin(clamp(position.y / 0.9, 0.0, 1.0) * 3.14159) * 0.9 + 0.1');
  inject(bandMat, '0.35');
  const mesh = new THREE.Mesh(buildNetGeometry(), netMat);
  mesh.name = 'vibora-net-mesh';
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const band = new THREE.Mesh(buildBandGeometry(), bandMat);
  band.name = 'vibora-net-band';
  band.castShadow = true;
  band.receiveShadow = true;
  group.add(mesh, band);

  const api = {
    group,
    mesh,
    band,
    heightAt: netHeightAt,
    /** Excite the net at lateral position x with an impact of `speed` m/s. */
    shake(x, speed = 5) {
      const amp = Math.min(0.11, 0.004 + Math.abs(speed) * 0.006);
      const cur = shake.value;
      const curAmp = cur.y * Math.exp(-cur.z * 2.8);
      if (amp >= curAmp * 0.8) cur.set(THREE.MathUtils.clamp(x, -HW, HW), amp, 0, 0);
    },
    update(dt) {
      shake.value.z = Math.min(99, shake.value.z + dt);
    },
  };
  group.userData.netApi = api;
  return api;
}

// ---------------------------------------------------------------------------------------------
// Hall

function buildHall(root, mats, courtXs) {
  const H = HALL;
  // Floor: dark polished concrete with saw-cut joints every 4 m, slightly below the turf.
  const floor = new THREE.Mesh(floorPlane(H.xMin, H.xMax, H.zMin, H.zMax, -0.012, CONCRETE_TILE_M), mats.concrete);
  floor.receiveShadow = true;
  floor.name = 'hall-floor';
  root.add(floor);
  // Turf pads: thin raised slab edges around each court (visible outside the glass).
  const curbs = [];
  for (const cx of courtXs) {
    curbs.push(boxAt(HW * 2 + 0.3, 0.012, 0.15, cx, -0.006, HL + 0.07));
    curbs.push(boxAt(HW * 2 + 0.3, 0.012, 0.15, cx, -0.006, -HL - 0.07));
    curbs.push(boxAt(0.15, 0.012, HL * 2, cx + HW + 0.07, -0.006, 0));
    curbs.push(boxAt(0.15, 0.012, HL * 2, cx - HW - 0.07, -0.006, 0));
  }
  const curb = new THREE.Mesh(merge(curbs), mats.steel);
  curb.receiveShadow = true;
  root.add(curb);

  // Walls: dark painted lower band, anthracite sandwich panels above.
  const lowerTop = 2.7;
  const lower = [], upper = [];
  const wallsDef = [
    ['x', H.xMin, H.xMax, H.zMin, 1],
    ['x', H.xMin, H.xMax, H.zMax, -1],
    ['z', H.zMin, H.zMax, H.xMin, 1],
    ['z', H.zMin, H.zMax, H.xMax, -1],
  ];
  for (const [axis, a0, a1, c, facing] of wallsDef) {
    lower.push(wallPlane(axis, a0, a1, 0, lowerTop, c, 1, facing));
    upper.push(wallPlane(axis, a0, a1, lowerTop, H.height, c, PANEL_TILE_M, facing));
  }
  const wl = new THREE.Mesh(merge(lower), mats.wallLower);
  const wu = new THREE.Mesh(merge(upper), mats.wallUpper);
  wl.receiveShadow = wu.receiveShadow = true;
  root.add(wl, wu);

  // Warm LED cove strip running round the hall above the lower band.
  const strips = [];
  const inset = 0.06;
  strips.push(boxAt(H.xMax - H.xMin, 0.035, 0.02, 0, lowerTop + 0.02, H.zMin + inset));
  strips.push(boxAt(H.xMax - H.xMin, 0.035, 0.02, 0, lowerTop + 0.02, H.zMax - inset));
  strips.push(boxAt(0.02, 0.035, H.zMax - H.zMin, H.xMin + inset, lowerTop + 0.02, 0));
  strips.push(boxAt(0.02, 0.035, H.zMax - H.zMin, H.xMax - inset, lowerTop + 0.02, 0));
  root.add(new THREE.Mesh(merge(strips), mats.ledStrip));
  // Cove shelf above the strip.
  const shelf = [];
  shelf.push(boxAt(H.xMax - H.xMin, 0.03, 0.14, 0, lowerTop + 0.06, H.zMin + 0.07));
  shelf.push(boxAt(H.xMax - H.xMin, 0.03, 0.14, 0, lowerTop + 0.06, H.zMax - 0.07));
  shelf.push(boxAt(0.14, 0.03, H.zMax - H.zMin, H.xMin + 0.07, lowerTop + 0.06, 0));
  shelf.push(boxAt(0.14, 0.03, H.zMax - H.zMin, H.xMax - 0.07, lowerTop + 0.06, 0));
  root.add(new THREE.Mesh(merge(shelf), mats.housing));

  // Roof deck.
  const roofG = new THREE.PlaneGeometry(H.xMax - H.xMin, H.zMax - H.zMin);
  roofG.rotateX(Math.PI / 2);
  roofG.translate(0, H.height, 0);
  const ruv = roofG.attributes.uv;
  for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * 6, ruv.getY(i) * ((H.zMax - H.zMin) / 1.2));
  root.add(new THREE.Mesh(roofG, mats.roof));

  // Steel trusses spanning the hall across x every 6 m.
  const trussParts = [];
  const span = H.xMax - H.xMin;
  const bot = H.trussBottom, top = H.height - 0.12;
  trussParts.push(boxAt(span, 0.14, 0.16, 0, bot, 0));
  trussParts.push(boxAt(span, 0.14, 0.16, 0, top, 0));
  const bay = 1.5;
  for (let x = H.xMin; x < H.xMax - 1e-6; x += bay) {
    const h = top - bot;
    trussParts.push(boxAt(0.07, h, 0.07, x, (bot + top) / 2, 0));
    const diag = Math.hypot(bay, h);
    const ang = Math.atan2(h, bay) * ((Math.round((x - H.xMin) / bay) % 2) ? 1 : -1);
    trussParts.push(boxAt(diag, 0.06, 0.06, x + bay / 2, (bot + top) / 2, 0, { rotZ: ang }));
  }
  const trussGeo = merge(trussParts);
  const trussZ = [-12, -6, 0, 6, 12];
  const truss = new THREE.InstancedMesh(trussGeo, mats.truss, trussZ.length);
  const m4 = new THREE.Matrix4();
  trussZ.forEach((z, i) => truss.setMatrixAt(i, m4.makeTranslation(0, 0, z)));
  truss.computeBoundingSphere();
  truss.name = 'trusses';
  root.add(truss);
  // Purlins along z.
  const purl = [];
  for (let x = H.xMin + 1.5; x < H.xMax; x += 3) purl.push(boxAt(0.08, 0.16, H.zMax - H.zMin, x, H.height - 0.08, 0));
  root.add(new THREE.Mesh(merge(purl), mats.truss));

  // Spiral ducts over the aisles between courts.
  const ducts = [];
  for (const x of [-8.6, 8.6]) {
    const g = new THREE.CylinderGeometry(0.42, 0.42, H.zMax - H.zMin - 1, 28, 1, true);
    g.rotateX(Math.PI / 2);
    g.translate(x, 9.2, 0);
    ducts.push(g);
    for (let z = H.zMin + 2; z < H.zMax - 1; z += 4) {
      const ring = new THREE.CylinderGeometry(0.44, 0.44, 0.05, 28, 1, true);
      ring.rotateX(Math.PI / 2);
      ring.translate(x, 9.2, z);
      ducts.push(ring);
      ducts.push(boxAt(0.02, 0.7, 0.02, x, 9.2 + 0.42 + 0.35, z));
    }
  }
  root.add(new THREE.Mesh(merge(ducts), mats.duct));

  // Club sign on the far wall (above the far court, visible from the player's eyes).
  const signGroup = new THREE.Group();
  signGroup.name = 'club-sign';
  const back = new THREE.Mesh(new THREE.BoxGeometry(10.4, 2.9, 0.12), new THREE.MeshStandardMaterial({ color: 0x0a0b0d, roughness: 0.4, metalness: 0.3 }));
  back.position.set(0, 6.4, H.zMin + 0.07);
  const logo = logoTexture('VÍBORA PADEL CLUB');
  const letters = new THREE.Mesh(
    new THREE.PlaneGeometry(9.6, 2.4),
    new THREE.MeshStandardMaterial({
      color: 0x000000, emissive: 0xffffff, emissiveMap: logo, emissiveIntensity: 2.4, map: logo,
      transparent: true, roughness: 0.4, depthWrite: false,
    }),
  );
  letters.position.set(0, 6.4, H.zMin + 0.135);
  signGroup.add(back, letters);
  root.add(signGroup);

  // Exit signs over the doors on the side walls.
  const exits = [];
  for (const [x, rotY] of [[H.xMin + 0.06, Math.PI / 2], [H.xMax - 0.06, -Math.PI / 2]]) {
    exits.push(boxAt(0.4, 0.16, 0.03, 0, 0, 0, { rotY }).translate(x, 2.45, -6));
  }
  root.add(new THREE.Mesh(merge(exits), mats.exit));
  // Doors (dark frames) under the exit signs.
  const doors = [];
  for (const x of [H.xMin + 0.03, H.xMax - 0.03]) {
    doors.push(boxAt(0.05, 2.2, 1.8, x, 1.1, -6));
  }
  const doorMesh = new THREE.Mesh(merge(doors), new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.5, metalness: 0.4 }));
  root.add(doorMesh);

  // Benches in the aisles between courts.
  const benchSeat = [], benchFrame = [];
  for (const x of [-6.6, 6.6, -19.4, 19.4]) {
    for (const z of [-1.4, 1.4]) {
      benchSeat.push(boxAt(0.4, 0.04, 1.8, x, 0.45, z));
      benchFrame.push(boxAt(0.05, 0.43, 0.05, x - 0.15, 0.215, z - 0.8), boxAt(0.05, 0.43, 0.05, x + 0.15, 0.215, z - 0.8));
      benchFrame.push(boxAt(0.05, 0.43, 0.05, x - 0.15, 0.215, z + 0.8), boxAt(0.05, 0.43, 0.05, x + 0.15, 0.215, z + 0.8));
    }
  }
  const seat = new THREE.Mesh(merge(benchSeat), mats.wood);
  const frame = new THREE.Mesh(merge(benchFrame), mats.steel);
  seat.castShadow = frame.castShadow = true;
  seat.receiveShadow = true;
  root.add(seat, frame);
  return { sign: signGroup };
}

// ---------------------------------------------------------------------------------------------
// Lighting: LED fixtures (emissive, bloom) + physically based spot lights

function buildLights(root, mats, q, courtXs) {
  const lights = { keys: [], fills: [], neighbors: [], hemi: null, all: [] };
  const fixtureZ = [-8.4, -5.0, -1.7, 1.7, 5.0, 8.4];
  const rowX = 3.4;
  const fixY = 8.7;

  const housing = new THREE.BoxGeometry(0.36, 0.08, 1.3);
  const diffuser = new THREE.PlaneGeometry(0.3, 1.22);
  diffuser.rotateX(Math.PI / 2);
  const housings = [], diffusers = [], cables = [];
  for (const cx of courtXs) {
    for (const sx of [-1, 1]) {
      for (const z of fixtureZ) {
        housings.push(housing.clone().translate(cx + sx * rowX, fixY, z));
        diffusers.push(diffuser.clone().translate(cx + sx * rowX, fixY - 0.041, z));
        cables.push(boxAt(0.006, HALL.trussBottom - fixY, 0.006, cx + sx * rowX, (HALL.trussBottom + fixY) / 2, z - 0.5));
        cables.push(boxAt(0.006, HALL.trussBottom - fixY, 0.006, cx + sx * rowX, (HALL.trussBottom + fixY) / 2, z + 0.5));
      }
    }
    // Round high-bays over the centre of each half (key lights).
    for (const z of [-5.1, 5.1]) {
      const hb = new THREE.CylinderGeometry(0.28, 0.34, 0.16, 32);
      hb.translate(cx, fixY + 0.25, z);
      housings.push(hb);
      const disc = new THREE.CircleGeometry(0.29, 32);
      disc.rotateX(Math.PI / 2);
      disc.translate(cx, fixY + 0.165, z);
      // CircleGeometry lacks nothing merge needs (position/normal/uv), keep it with the diffusers.
      diffusers.push(disc);
    }
  }
  housing.dispose();
  diffuser.dispose();
  root.add(new THREE.Mesh(merge(housings), mats.housing));
  const ledMesh = new THREE.Mesh(merge(diffusers), mats.led);
  ledMesh.name = 'led-panels';
  root.add(ledMesh);
  root.add(new THREE.Mesh(merge(cables), mats.housing));

  const mkSpot = (intensity, x, y, z, tx, ty, tz, angle, penumbra, shadow) => {
    const s = new THREE.SpotLight(LED_WHITE, intensity, 0, angle, penumbra, 2);
    s.position.set(x, y, z);
    s.target.position.set(tx, ty, tz);
    root.add(s, s.target);
    if (shadow) {
      s.castShadow = true;
      s.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      s.shadow.radius = q.shadowRadius;
      s.shadow.bias = -0.00015;
      s.shadow.normalBias = 0.015;
      s.shadow.camera.near = 3;
      s.shadow.camera.far = 22;
    }
    lights.all.push(s);
    return s;
  };

  for (const z of [-5.1, 5.1]) {
    lights.keys.push(mkSpot(LIGHT.key, 0, fixY + 0.15, z, 0, 0, z, 0.98, 0.55, true));
  }
  // Fills always exist; tiers without them hide them (scene.setQuality toggles userData.fill lights).
  for (const sx of [-1, 1]) {
    for (const z of [-6.6, 0, 6.6]) {
      const f = mkSpot(LIGHT.fill, sx * rowX, fixY - 0.05, z, sx * 1.2, 0, z, 1.05, 0.7, false);
      f.userData.fill = true;
      f.visible = q.fillLights;
      lights.fills.push(f);
    }
  }
  for (const cx of courtXs) {
    if (cx === 0) continue;
    for (const z of [-5.1, 5.1]) lights.neighbors.push(mkSpot(LIGHT.neighbor, cx, fixY + 0.15, z, cx, 0, z, 1.05, 0.6, false));
  }
  lights.hemi = new THREE.HemisphereLight(0xc5ccd8, 0x1a2130, q.fillLights ? LIGHT.hemi : LIGHT.hemi * 2.5);
  lights.hemi.userData.baseIntensity = LIGHT.hemi; // ×2.5 when fills are off
  root.add(lights.hemi);
  lights.all.push(lights.hemi);
  return lights;
}

// ---------------------------------------------------------------------------------------------
// Ball marks (pooled felt smudges that fade over 20 s)

function createBallMarks(root, count = 24) {
  const tex = softSpriteTexture({ size: 64, hardness: 0.35 });
  const geo = new THREE.PlaneGeometry(1, 1);
  const pool = [];
  for (let i = 0; i < count; i++) {
    const mat = new THREE.MeshBasicMaterial({
      color: 0xd5dabd, map: tex, transparent: true, opacity: 0, depthWrite: false,
      polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
    });
    const m = new THREE.Mesh(geo, mat);
    m.visible = false;
    m.renderOrder = 3;
    m.userData.age = Infinity;
    root.add(m);
    pool.push(m);
  }
  let next = 0;
  const tmp = new THREE.Vector3();
  const LIFE = 20;
  return {
    add(pos, normal) {
      const m = pool[next];
      next = (next + 1) % pool.length;
      const n = tmp.set(normal?.x ?? 0, normal?.y ?? 1, normal?.z ?? 0).normalize();
      m.position.set(pos.x + n.x * 0.004, pos.y + n.y * 0.004, pos.z + n.z * 0.004);
      m.lookAt(m.position.x + n.x, m.position.y + n.y, m.position.z + n.z);
      m.rotateZ(Math.random() * Math.PI * 2);
      const s = 0.075 + Math.random() * 0.02;
      m.scale.set(s * (1 + Math.random() * 0.25), s, 1);
      m.userData.age = 0;
      m.material.opacity = 0.4;
      m.visible = true;
    },
    update(dt) {
      for (const m of pool) {
        if (!m.visible) continue;
        m.userData.age += dt;
        const k = 1 - m.userData.age / LIFE;
        if (k <= 0) {
          m.visible = false;
          continue;
        }
        m.material.opacity = 0.4 * k * k;
      }
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Training mannequins standing at the far net (for drills with opponentsAtNet)

function buildOpponents(root, mats) {
  const group = new THREE.Group();
  group.name = 'opponents';
  const profile = [
    [0.0, 0.0], [0.16, 0.0], [0.17, 0.04], [0.1, 0.06], [0.05, 0.1], [0.05, 0.85],
    [0.15, 0.9], [0.19, 1.05], [0.21, 1.25], [0.23, 1.42], [0.2, 1.48], [0.07, 1.52], [0.06, 1.58],
  ].map(([r, y]) => new THREE.Vector2(r, y));
  const bodyGeo = new THREE.LatheGeometry(profile, 28);
  const headGeo = new THREE.SphereGeometry(0.11, 24, 16);
  const stripeGeo = new THREE.CylinderGeometry(0.205, 0.215, 0.05, 28, 1, true);
  const armGeo = new THREE.CapsuleGeometry(0.045, 0.5, 6, 12);
  for (const x of [-2.4, 2.4]) {
    const d = new THREE.Group();
    const body = new THREE.Mesh(bodyGeo, mats.dummy);
    const head = new THREE.Mesh(headGeo, mats.dummy);
    head.position.y = 1.7;
    const stripe = new THREE.Mesh(stripeGeo, mats.dummyStripe);
    stripe.position.y = 1.18;
    const armL = new THREE.Mesh(armGeo, mats.dummy);
    armL.position.set(-0.27, 1.25, 0.08);
    armL.rotation.set(0.5, 0, 0.25);
    const armR = armL.clone();
    armR.position.x = 0.27;
    armR.rotation.z = -0.25;
    d.add(body, head, stripe, armL, armR);
    d.traverse((o) => {
      if (o.isMesh) o.castShadow = o.receiveShadow = true;
    });
    d.position.set(x, 0, -2.9);
    group.add(d);
  }
  group.visible = false;
  root.add(group);
  return group;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {THREE.Scene} scene
 * @param {THREE.WebGLRenderer} renderer
 * @param {{quality?: string, envMode?: 'hall'|'room', neighbors?: boolean}} opts
 */
export function buildEnvironment(scene, renderer, { quality = 'high', envMode = 'hall', neighbors, overrides = null, debug = false } = {}) {
  const q = { ...(QUALITY[quality] || QUALITY.high), ...(overrides || {}) };
  const tStart = performance.now();
  let tLast = tStart;
  const mark = (label) => {
    if (!debug) return;
    const now = performance.now();
    console.info(`[env] ${label}: ${Math.round(now - tLast)} ms`);
    tLast = now;
  };
  const root = new THREE.Group();
  root.name = 'vibora-environment';
  scene.add(root);

  const pmrem = new THREE.PMREMGenerator(renderer);
  const roomEnv = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = roomEnv.texture;
  scene.environmentIntensity = 0.25;

  mark('room env');
  const mats = makeMaterials(renderer, q);
  mark('materials + textures');
  const courtXs = (neighbors ?? q.neighbors) ? [0, -NEIGHBOR_OFFSET, NEIGHBOR_OFFSET] : [0];

  // Turf.
  const turfGeo = new THREE.PlaneGeometry(HW * 2, HL * 2, 1, 1);
  turfGeo.rotateX(-Math.PI / 2);
  const turf = instanced(turfGeo, mats.turf, courtXs, { name: 'turf' });
  root.add(turf);

  // Enclosure kit.
  const kit = buildEnclosureGeometry();
  root.add(instanced(kit.steel, mats.steel, courtXs, { cast: true, name: 'steel' }));
  root.add(instanced(kit.bolts, mats.bolt, courtXs, { name: 'bolts' }));
  const meshInst = instanced(kit.mesh, mats.mesh, courtXs, { name: 'mesh' });
  root.add(meshInst);
  const edgeInst = instanced(kit.edges, mats.glassEdge, courtXs, { name: 'glass-edges' });
  edgeInst.renderOrder = 1;
  root.add(edgeInst);
  const glassInst = instanced(kit.glass, mats.glass, courtXs, { receive: false, name: 'glass' });
  glassInst.renderOrder = 2;
  root.add(glassInst);

  // Nets: the main one animates; neighbours are static instances.
  const net = createNet(mats);
  root.add(net.group);
  const others = courtXs.filter((x) => x !== 0);
  if (others.length) {
    root.add(instanced(net.mesh.geometry, mats.netStatic, others, { name: 'nets-static' }));
    root.add(instanced(net.band.geometry, mats.band, others, { name: 'bands-static' }));
  }

  mark('court geometry');
  const hall = buildHall(root, mats, courtXs);
  const lights = buildLights(root, mats, q, courtXs);
  const marks = createBallMarks(root);
  const opponents = buildOpponents(root, mats);

  let hallEnv = null;
  let reflectEnv = null;
  /**
   * Captures the hall into two PMREMs: a dim one for ambient image-based light (scene.environment)
   * and one with the LED diffusers at a realistic brightness ratio, used as the reflection map of
   * the glass and powder-coated steel so the LED rows glint in the panels as they do on real courts.
   */
  function captureEnvironment(position = new THREE.Vector3(0, 2.2, 0)) {
    const prevOpp = opponents.visible;
    opponents.visible = false;
    for (const m of REFLECTIVE) {
      mats[m].envMap = null;
      mats[m].needsUpdate = true;
    }
    mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE_ENV);
    const rt = pmrem.fromScene(scene, 0, 0.05, 80, { size: q.envSize, position });
    mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE_REFLECT);
    const rt2 = pmrem.fromScene(scene, 0, 0.05, 80, { size: q.envSize, position });
    mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE);
    opponents.visible = prevOpp;
    hallEnv?.dispose();
    reflectEnv?.dispose();
    hallEnv = rt;
    reflectEnv = rt2;
    scene.environment = rt.texture;
    scene.environmentIntensity = LIGHT.env;
    for (const m of REFLECTIVE) {
      mats[m].envMap = rt2.texture;
      mats[m].envMapIntensity = REFLECT_INTENSITY[m];
      mats[m].needsUpdate = true;
    }
    return rt.texture;
  }
  mark('hall + lights');
  if (envMode === 'hall') captureEnvironment();
  mark('hall env capture');

  let time = 0;
  return {
    root,
    glassPanels: kit.glassPanels,
    meshPanels: kit.meshPanels,
    net,
    lights,
    materials: mats,
    sign: hall.sign,
    courtXs,
    addBallMark(pos, normal) {
      marks.add(pos, normal);
    },
    update(dt) {
      time += dt;
      net.update(dt);
      marks.update(dt);
    },
    setOpponentsVisible(v) {
      opponents.visible = !!v;
    },
    captureEnvironment,
    useRoomEnvironment() {
      scene.environment = roomEnv.texture;
      scene.environmentIntensity = 0.25;
      for (const m of REFLECTIVE) {
        mats[m].envMap = null;
        mats[m].needsUpdate = true;
      }
    },
    dispose() {
      scene.remove(root);
      hallEnv?.dispose();
      reflectEnv?.dispose();
      roomEnv.dispose();
      pmrem.dispose();
      root.traverse((o) => {
        if (o.isMesh) o.geometry.dispose();
      });
    },
  };
}
