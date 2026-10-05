// Instanced impostor crowd: thousands of spectators in one draw call.
//
// Each person is a camera-facing quad (cylindrical billboard) whose fragment shader draws a figure
// from signed distances: legs, torso (shirt), arms, hands, neck, head, hair or a cap. The vertex
// shader poses every figure from a few uniforms: idle sway, applause (hands clapping at 4–5 Hz),
// cheering (standing, arms up and waving), "ooh" (hands to the head), groan (hands on the head,
// slumped) and a Mexican wave travelling round the venue. Each spectator has a response threshold,
// so a small applause only gets part of the crowd going and a roar gets everyone up.
//
// API: createCrowd({ people, msaa, name, light, lightK, keyDir, key, sky, ground, hemiK }) -> { mesh,
//   count, react(kind, level), update(dt, t), setLight(color, k), mood, dispose() }
// Round 6: the figures are shaded as volumes (pseudo-normals per part: round limbs, a cylindrical
// torso tapering to the waist, a spherical head) under the venue's key light and a sky / ground
// hemisphere; tapered limbs, long or short sleeves, soft facial planes instead of drawn features.
// people: [{ x, y (floor of the row), z, seated, shirt, skin, hair, trousers, scale, lit, seed }]
import * as THREE from 'three';
import { createRng } from '../util/math.js';

/** Envelope timing per reaction kind: attack, hold, release (s). */
export const CROWD_REACTIONS = Object.freeze({
  applause: { slot: 0, attack: 0.25, hold: 2.2, release: 1.6 },
  cheer: { slot: 1, attack: 0.18, hold: 1.8, release: 1.8 },
  roar: { slot: 1, attack: 0.12, hold: 2.8, release: 2.2 },
  ooh: { slot: 2, attack: 0.15, hold: 0.9, release: 0.9 },
  groan: { slot: 3, attack: 0.2, hold: 1.4, release: 1.2 },
});

const SHIRTS = ['#e8572a', '#d9f03a', '#5fd8ff', '#c8263c', '#2f6b3d', '#7a4bd1', '#f2b632', '#ff7a9c', '#2a8fd8', '#4c7a5a', '#b5523b'];
const NEUTRALS = ['#eef1f4', '#16181d', '#1d2b4a', '#8a96a8', '#3b3f46', '#f4f0e6', '#2a3a55', '#5b616b', '#c9c2b4'];
const SKINS = ['#f1c7a5', '#e0ac85', '#c58c6a', '#a46b4b', '#7b4a33', '#5a3524'];
const HAIRS = ['#1a1310', '#2e1f16', '#5a3b22', '#8a6038', '#c9a26a', '#d8d2c8', '#3a3a3a'];
const TROUSERS = ['#1d2433', '#2b2f36', '#3b4a63', '#b9a888', '#16181d', '#4b5563'];

/** Random spectator look (linear colours) from a seeded rng. */
export function randomLook(rng, opts = {}) {
  const pick = (a) => a[Math.floor(rng() * a.length)];
  return {
    shirt: opts.shirt || pick(opts.shirts || (rng() < 0.55 ? NEUTRALS : SHIRTS)),
    skin: pick(SKINS),
    hair: pick(HAIRS),
    trousers: pick(TROUSERS),
    scale: 0.92 + rng() * 0.16,
    seed: rng(),
  };
}

const VERT = /* glsl */ `
  attribute vec3 iPos;
  attribute vec3 iShirt;
  attribute vec3 iSkin;
  attribute vec3 iHair;
  attribute vec4 iSeed;   // phase, response threshold, scale, standing base (0 seated, 1 standing)
  attribute vec4 iMisc;   // light factor, cap (0/1), trousers grey, long hair (0/1)
  uniform float uTime;
  uniform vec4 uMood;     // applause, cheer, ooh, groan
  uniform vec4 uWave;     // front angle, width, amplitude, hush
  uniform vec3 uCenter;
  varying vec2 vP;        // quad-local position (m, x right, y up from the floor)
  varying vec4 vPose;     // hipY, shoulderY, headY, scale
  varying vec4 vHands;    // left hand xy, right hand xy
  varying vec3 vShirt;
  varying vec3 vSkin;
  varying vec3 vHair;
  varying vec4 vMisc;
  varying vec3 vRight;
  varying vec3 vFwd;
  varying float vSeed;
  varying float vDist;
  const float W = 0.84;
  const float H = 2.3;
  float angDiff(float a, float b) { float d = a - b; return atan(sin(d), cos(d)); }
  void main() {
    float ph = iSeed.x * 6.2831853;
    float thr = iSeed.y;
    float sc = iSeed.z;
    float hush = uWave.w;
    float appl = uMood.x * smoothstep(thr * 0.8 - 0.05, thr * 0.8 + 0.05, uMood.x);
    float cheer = uMood.y * smoothstep(thr * 0.65 - 0.05, thr * 0.65 + 0.05, uMood.y);
    float ooh = uMood.z * smoothstep(thr * 0.85 - 0.05, thr * 0.85 + 0.05, uMood.z);
    float groan = uMood.w * smoothstep(thr * 0.85 - 0.05, thr * 0.85 + 0.05, uMood.w);
    float ang = atan(iPos.x - uCenter.x, iPos.z - uCenter.z);
    float wa = angDiff(ang, uWave.x) / max(uWave.y, 1e-3);
    float wave = uWave.z * exp(-wa * wa);
    float rise = max(iSeed.w, max(smoothstep(0.35, 0.85, cheer), wave));
    float t = uTime;
    float sway = (0.012 + 0.01 * (1.0 - hush)) * sin(t * (1.1 + iSeed.y * 0.6) + ph) + cheer * 0.03 * sin(t * 5.3 + ph);
    float bob = 0.012 * sin(t * 1.7 + ph * 1.3) * (1.0 - hush) + cheer * 0.04 * abs(sin(t * 4.0 + ph));
    float slump = groan * 0.05;
    float hipY = mix(0.47, 0.96, rise) * sc + bob - slump;
    float shY = hipY + 0.52 * sc;
    float headY = shY + 0.235 * sc - slump * 0.5;
    // Hand targets per pose (x is mirrored for the left hand).
    vec2 idle = mix(vec2(0.12, hipY + 0.03), vec2(0.21, hipY - 0.04), rise);
    float clapF = 4.2 + iSeed.y * 1.4;
    float clap = 0.5 + 0.5 * sin(t * 6.2831853 * clapF + ph);
    vec2 pClap = vec2(0.02 + 0.075 * clap, shY - 0.17);
    vec2 pCheer = vec2(0.24 + 0.07 * sin(t * 13.0 + ph), shY + 0.56 * sc);
    vec2 pOoh = vec2(0.13, headY + 0.02);
    vec2 pGroan = vec2(0.065, headY + 0.1);
    float wC = max(cheer, wave);
    float tot = appl + wC + ooh + groan;
    float k = tot > 1.0 ? 1.0 / tot : 1.0;
    vec2 hand = idle * (1.0 - min(1.0, tot)) + (pClap * appl + pCheer * wC + pOoh * ooh + pGroan * groan) * k;
    float asym = 0.03 * sin(t * 2.1 + ph);
    vHands = vec4(-hand.x + sway, hand.y + asym, hand.x + sway, hand.y - asym);
    vPose = vec4(hipY, shY, headY, sc);
    vec2 local = vec2((position.x) * W, (position.y + 0.5) * H);
    vP = local - vec2(sway, 0.0);
    vShirt = iShirt;
    vSkin = iSkin;
    vHair = iHair;
    vMisc = iMisc;
    vec3 toCam = cameraPosition - iPos;
    toCam.y = 0.0;
    float lc = length(toCam);
    vec3 fwd = lc > 1e-4 ? toCam / lc : vec3(0.0, 0.0, 1.0);
    vec3 right = vec3(fwd.z, 0.0, -fwd.x);
    vec3 wp = iPos + right * local.x + vec3(0.0, local.y, 0.0);
    vRight = right;
    vFwd = fwd;
    vSeed = iSeed.x;
    vec4 mv = viewMatrix * vec4(wp, 1.0);
    vDist = length(mv.xyz);
    gl_Position = projectionMatrix * mv;
  }
`;

const FRAG = /* glsl */ `
  uniform vec3 uLight;
  uniform float uA2C;
  // Round 6 lighting: a key light (direction toward the light, colour x intensity) and a hemisphere
  // (sky / ground) on volumetric pseudo-normals, so the figures read as round bodies, not cut-outs.
  uniform vec3 uKeyDir;
  uniform vec3 uKey;
  uniform vec3 uSky;
  uniform vec3 uGround;
  uniform vec4 uHaze;     // venue haze: linear colour, FogExp2 density (the stands' own fog)
  varying float vDist;
  varying vec2 vP;
  varying vec4 vPose;
  varying vec4 vHands;
  varying vec3 vShirt;
  varying vec3 vSkin;
  varying vec3 vHair;
  varying vec4 vMisc;
  varying vec3 vRight;
  varying vec3 vFwd;
  varying float vSeed;
  float sdBox(vec2 p, vec2 b, float r) { vec2 q = abs(p) - b + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
  float sdSeg(vec2 p, vec2 a, vec2 b, float r) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h) - r; }
  // Tapered segment (round cone): radius ra at a, rb at b.
  float sdCone(vec2 p, vec2 a, vec2 b, float ra, float rb) { vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0); return length(pa - ba * h) - mix(ra, rb, h); }
  // Pseudo-normal of a limb seen side-on: round across its axis.
  vec3 segN(vec2 p, vec2 a, vec2 b, float r) {
    vec2 pa = p - a, ba = b - a; float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-6), 0.0, 1.0);
    vec2 q = (pa - ba * h) / r; float l2 = min(dot(q, q), 0.98);
    return vec3(q, sqrt(1.0 - l2));
  }
  vec3 cylN(float x, float halfW, float top) { float q = clamp(x / halfW, -0.98, 0.98); return normalize(vec3(q, top, sqrt(1.0 - q * q))); }
  float h1(float n) { return fract(sin(n * 127.1) * 43758.5453); }
  void main() {
    vec2 p = vP;
    float hipY = vPose.x, shY = vPose.y, headY = vPose.z, sc = vPose.w;
    float fw = max(fwidth(p.y), 1e-4) * 0.75;
    float seated = step(hipY, 0.75 * sc);
    // Parts (signed distance, metres). Thighs come toward the viewer when seated (short legs).
    float legTop = hipY;
    float dLegs = min(sdCone(p, vec2(-0.08, legTop), vec2(-0.085, 0.06), 0.075 * sc, 0.05), sdCone(p, vec2(0.08, legTop), vec2(0.085, 0.06), 0.075 * sc, 0.05));
    float waist = 0.15 * sc, chest = 0.19 * sc;
    float ty = clamp((p.y - hipY) / max(shY - hipY, 1e-3), 0.0, 1.0);
    float halfT = mix(waist, chest, smoothstep(0.1, 0.8, ty));
    float dTorso = sdBox(p - vec2(0.0, (hipY + shY) * 0.5 - 0.01), vec2(halfT, (shY - hipY) * 0.5 + 0.01), 0.06);
    float dNeck = sdBox(p - vec2(0.0, shY + 0.045), vec2(0.045 * sc, 0.05), 0.02);
    vec2 hc = vec2(0.0, headY);
    float dHead = length((p - hc) * vec2(1.08, 0.9)) - 0.1 * sc;
    vec2 shL = vec2(-0.17 * sc, shY - 0.035), shR = vec2(0.17 * sc, shY - 0.035);
    vec2 hL = vHands.xy, hR = vHands.zw;
    vec2 elL = mix(shL, hL, 0.5) + vec2(-0.05, -0.03), elR = mix(shR, hR, 0.5) + vec2(0.05, -0.03);
    float dUpL = sdCone(p, shL, elL, 0.055, 0.045), dUpR = sdCone(p, shR, elR, 0.055, 0.045);
    float dFoL = sdCone(p, elL, hL, 0.043, 0.035), dFoR = sdCone(p, elR, hR, 0.043, 0.035);
    float dUpper = min(dUpL, dUpR), dFore = min(dFoL, dFoR);
    float dHand = min(length(p - hL) - 0.043, length(p - hR) - 0.043);
    // Hair: top / back of the head; long hair falls to the shoulders. Cap: crown and a brim.
    float crown = smoothstep(headY - 0.01 - 0.05 * vMisc.w, headY + 0.03 - 0.05 * vMisc.w, p.y + 0.02 * abs(p.x) / 0.1);
    float longHair = vMisc.w * step(sdBox(p - vec2(0.0, headY - 0.08), vec2(0.115, 0.14), 0.05), 0.0) * step(0.07, abs(p.x));
    float cap = vMisc.y * step(dHead, 0.0) * step(headY + 0.025, p.y);
    float brim = vMisc.y * step(sdBox(p - vec2(0.03, headY + 0.025), vec2(0.125, 0.011), 0.008), 0.0);
    // Coverage (anti-aliased by the pixel footprint).
    float cLegs = clamp(0.5 - dLegs / fw, 0.0, 1.0);
    float cTorso = clamp(0.5 - dTorso / fw, 0.0, 1.0);
    float cNeck = clamp(0.5 - dNeck / fw, 0.0, 1.0);
    float cHead = clamp(0.5 - dHead / fw, 0.0, 1.0);
    float cUpper = clamp(0.5 - dUpper / fw, 0.0, 1.0);
    float cFore = clamp(0.5 - dFore / fw, 0.0, 1.0);
    float cHand = clamp(0.5 - dHand / fw, 0.0, 1.0);
    // Sleeves: long (jackets, half the people) or short; shorts vs trousers by the seed.
    float longSleeve = step(0.55, h1(vSeed * 31.0));
    vec3 trousers = vec3(vMisc.z) * mix(vec3(1.0), vec3(0.85, 0.9, 1.15), step(0.5, h1(vSeed * 7.0)));
    vec3 sleeveCol = mix(vSkin, vShirt, longSleeve);
    // Albedo and pseudo-normal per part, later parts on top.
    vec3 col = trousers * 0.85;
    vec3 N = cylN(p.x - sign(p.x) * 0.08, 0.075, 0.0);
    float a = cLegs;
    vec3 nT = cylN(p.x, halfT + 0.02, smoothstep(shY - 0.1, shY + 0.02, p.y) * 0.8 - 0.25 * (1.0 - ty));
    col = mix(col, vShirt, cTorso); N = mix(N, nT, cTorso); a = max(a, cTorso);
    // Shirt hem / collar / placket detail (low contrast).
    col *= 1.0 - 0.18 * cTorso * (1.0 - smoothstep(0.0, 0.035, abs(p.y - hipY - 0.02)));
    col = mix(col, vSkin * 0.85, cNeck); N = mix(N, cylN(p.x, 0.05, 0.0), cNeck); a = max(a, cNeck);
    vec3 nUp = dUpL < dUpR ? segN(p, shL, elL, 0.055) : segN(p, shR, elR, 0.055);
    col = mix(col, vShirt * 0.96, cUpper); N = mix(N, nUp, cUpper); a = max(a, cUpper);
    vec3 nFo = dFoL < dFoR ? segN(p, elL, hL, 0.043) : segN(p, elR, hR, 0.043);
    col = mix(col, sleeveCol, cFore); N = mix(N, nFo, cFore); a = max(a, cFore);
    col = mix(col, vSkin, cHand); a = max(a, cHand);
    vec2 hq = (p - hc) / (0.1 * sc);
    vec3 nH = vec3(hq * vec2(0.92, 1.1), sqrt(max(0.02, 1.0 - dot(hq, hq))));
    // Face: soft eye sockets and a lit brow / nose ridge (no cartoon features).
    float ey = (p.y - headY - 0.005) / 0.018;
    float eyes = exp(-ey * ey) * smoothstep(0.012, 0.03, abs(p.x)) * smoothstep(0.075, 0.04, abs(p.x));
    // Nose ridge catches the light, a soft mouth line, darker ears / jaw edge (all low contrast).
    float nx = p.x / 0.012;
    float nose = exp(-nx * nx) * smoothstep(headY - 0.045, headY - 0.005, p.y) * smoothstep(headY + 0.02, headY - 0.005, p.y);
    float my = (p.y - headY + 0.052) / 0.008;
    float mouth = exp(-my * my) * smoothstep(0.04, 0.015, abs(p.x));
    float rim = smoothstep(0.06, 0.1, abs(p.x));
    vec3 face = vSkin * (1.0 - 0.3 * eyes - 0.18 * mouth - 0.15 * rim) * (1.0 + 0.12 * nose) + vec3(0.04, 0.0, 0.0) * mouth * vSkin;
    col = mix(col, face, cHead); N = mix(N, nH, cHead); a = max(a, cHead);
    float hairK = max(crown * (1.0 - vMisc.y), longHair) * cHead + longHair * (1.0 - cHead);
    col = mix(col, vHair, hairK);
    a = max(a, longHair);
    col = mix(col, vShirt * 0.85, max(cap, brim));
    a = max(a, brim);
    N = normalize(N);
    // Lighting: key (wrapped a little: cloth), hemisphere, a touch of occlusion low on the body.
    vec3 Nw = normalize(vRight * N.x + vec3(0.0, N.y, 0.0) + vFwd * N.z);
    float ndl = max(0.0, (dot(Nw, uKeyDir) + 0.25) / 1.25);
    vec3 hemi = mix(uGround, uSky, 0.5 + 0.5 * Nw.y);
    float occ = mix(0.55, 1.0, smoothstep(hipY - 0.35, hipY + 0.25, p.y)) * mix(0.8, 1.0, smoothstep(0.0, 0.35, N.z));
    // Crowds read less saturated than their shirts under arena light; a per-person exposure jitter.
    float lum = dot(col, vec3(0.2126, 0.7152, 0.0722));
    col = mix(vec3(lum), col, 0.82);
    vec3 c = col * (uKey * ndl + hemi) * occ * uLight * vMisc.x * (0.88 + 0.24 * fract(vMisc.z * 13.7 + vPose.w * 9.1));
    float hz = 1.0 - exp(-uHaze.w * uHaze.w * vDist * vDist);
    c = mix(c, uHaze.rgb, hz);
    if (uA2C < 0.5 && a < 0.5) discard;
    if (a < 0.02) discard;
    gl_FragColor = vec4(c, uA2C > 0.5 ? a : 1.0);
  }
`;

/**
 * @param {{ people: object[], msaa?: boolean, name?: string, light?: THREE.Color|number, center?: {x,z} }} o
 */
export function createCrowd({
  people, msaa = true, name = 'crowd', light = 0xffffff, lightK = 1, center = { x: 0, z: 0 },
  keyDir = { x: 0.2, y: 0.9, z: 0.4 }, key = 0.78, sky = 0x9fb0c8, ground = 0x3a3530, hemiK = 0.42, haze = null,
} = {}) {
  const n = people.length;
  const quad = new THREE.PlaneGeometry(1, 1);
  const geo = new THREE.InstancedBufferGeometry();
  geo.index = quad.index;
  geo.setAttribute('position', quad.attributes.position);
  geo.setAttribute('uv', quad.attributes.uv);
  const pos = new Float32Array(n * 3), shirt = new Float32Array(n * 3), skin = new Float32Array(n * 3), hair = new Float32Array(n * 3);
  const seed = new Float32Array(n * 4), misc = new Float32Array(n * 4);
  const c = new THREE.Color();
  const rng = createRng(4242);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity, minZ = Infinity, maxZ = -Infinity;
  people.forEach((p, i) => {
    pos[i * 3] = p.x; pos[i * 3 + 1] = p.y; pos[i * 3 + 2] = p.z;
    minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
    minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y + 2.3);
    minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z);
    c.set(p.shirt || '#888888'); shirt.set([c.r, c.g, c.b], i * 3);
    c.set(p.skin || '#c58c6a'); skin.set([c.r, c.g, c.b], i * 3);
    c.set(p.hair || '#2e1f16'); hair.set([c.r, c.g, c.b], i * 3);
    const r = p.seed ?? rng();
    seed.set([r, p.threshold ?? rng(), p.scale ?? 1, p.seated === false ? 1 : 0], i * 4);
    c.set(p.trousers || '#2b2f36');
    misc.set([p.lit ?? 1, p.cap ?? (rng() < 0.18 ? 1 : 0), (c.r + c.g + c.b) / 3, p.longHair ?? (rng() < 0.35 ? 1 : 0)], i * 4);
  });
  geo.setAttribute('iPos', new THREE.InstancedBufferAttribute(pos, 3));
  geo.setAttribute('iShirt', new THREE.InstancedBufferAttribute(shirt, 3));
  geo.setAttribute('iSkin', new THREE.InstancedBufferAttribute(skin, 3));
  geo.setAttribute('iHair', new THREE.InstancedBufferAttribute(hair, 3));
  geo.setAttribute('iSeed', new THREE.InstancedBufferAttribute(seed, 4));
  geo.setAttribute('iMisc', new THREE.InstancedBufferAttribute(misc, 4));
  geo.instanceCount = n;
  if (n) {
    const ctr = new THREE.Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
    geo.boundingSphere = new THREE.Sphere(ctr, Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + 1.5);
  }
  const uniforms = {
    uTime: { value: 0 },
    uMood: { value: new THREE.Vector4(0, 0, 0, 0) },
    uWave: { value: new THREE.Vector4(0, 0.45, 0, 0) },
    uCenter: { value: new THREE.Vector3(center.x, 0, center.z) },
    uLight: { value: new THREE.Color(light).multiplyScalar(lightK) },
    uA2C: { value: msaa ? 1 : 0 },
    uKeyDir: { value: new THREE.Vector3(keyDir.x, keyDir.y, keyDir.z).normalize() },
    uKey: { value: new THREE.Color(1, 1, 1).multiplyScalar(key) },
    uSky: { value: new THREE.Color(sky).multiplyScalar(hemiK) },
    uGround: { value: new THREE.Color(ground).multiplyScalar(hemiK) },
    uHaze: { value: haze ? new THREE.Vector4(haze.color.r, haze.color.g, haze.color.b, haze.density) : new THREE.Vector4(0, 0, 0, 0) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, alphaToCoverage: !!msaa, transparent: false, side: THREE.DoubleSide,
  });
  // scene.js applySceneTier: alpha-to-coverage under MSAA, alpha test otherwise.
  mat.userData.onTier = (q) => {
    const on = q.msaa > 0;
    if (mat.alphaToCoverage === on) return;
    mat.alphaToCoverage = on;
    uniforms.uA2C.value = on ? 1 : 0;
    mat.needsUpdate = true;
  };
  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = name;
  mesh.frustumCulled = n > 0;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  // Reaction envelopes per mood slot.
  const env = [0, 1, 2, 3].map(() => ({ peak: 0, t: Infinity, a: 0.2, h: 1, r: 1 }));
  const wave = { on: false, t: 0, front: 0, speed: 1.25, laps: 1.4, amp: 0 };
  let hush = 0, hushTarget = 0;
  const mood = uniforms.uMood.value;
  const level = (e) => {
    if (e.t === Infinity) return 0;
    if (e.t < e.a) return e.peak * (e.t / e.a);
    if (e.t < e.a + e.h) return e.peak;
    const u = (e.t - e.a - e.h) / e.r;
    return u >= 1 ? 0 : e.peak * (1 - u) * (1 - u);
  };
  return {
    mesh,
    count: n,
    get mood() {
      return { applause: mood.x, cheer: mood.y, ooh: mood.z, groan: mood.w, wave: uniforms.uWave.value.z, hush };
    },
    /** kind: 'applause'|'cheer'|'roar'|'ooh'|'groan'|'wave'|'hush'|'murmur'; level 0..1. */
    react(kind, lv = 1) {
      const l = Math.max(0, Math.min(1, lv));
      if (kind === 'wave') {
        Object.assign(wave, { on: true, t: 0, front: Math.atan2(-center.x, 8 - center.z) + Math.PI * 0.5, amp: 0 });
        return;
      }
      if (kind === 'hush') {
        hushTarget = 1;
        return;
      }
      if (kind === 'murmur') {
        hushTarget = 0;
        return;
      }
      const R = CROWD_REACTIONS[kind];
      if (!R) return;
      hushTarget = 0;
      const e = env[R.slot];
      const cur = level(e);
      e.peak = Math.max(cur, l * (kind === 'roar' ? 1 : 0.92));
      e.t = cur > 0 ? Math.min(e.a, R.attack) : 0;
      e.a = R.attack;
      e.h = R.hold * (0.6 + 0.4 * l);
      e.r = R.release;
      // A roar brings out the applause too.
      if (kind === 'roar' || kind === 'cheer') this.react('applause', l * 0.8);
    },
    update(dt, time) {
      uniforms.uTime.value = time;
      for (const e of env) if (e.t !== Infinity) e.t += dt;
      mood.set(level(env[0]), level(env[1]), level(env[2]), level(env[3]));
      hush += (hushTarget - hush) * (1 - Math.exp(-dt * 2));
      const w = uniforms.uWave.value;
      if (wave.on) {
        wave.t += dt;
        const dur = (Math.PI * 2 * wave.laps) / wave.speed;
        wave.front += wave.speed * dt;
        wave.amp = Math.min(1, wave.t / 0.8) * Math.min(1, Math.max(0, (dur - wave.t) / 1.2));
        if (wave.t > dur) wave.on = false;
      } else wave.amp = 0;
      w.set(wave.front, 0.42, wave.amp, hush);
    },
    setLight(color, k = 1) {
      uniforms.uLight.value.set(color).multiplyScalar(k);
    },
    setMsaa(on) {
      mat.alphaToCoverage = !!on;
      uniforms.uA2C.value = on ? 1 : 0;
      mat.needsUpdate = true;
    },
    dispose() {
      geo.dispose();
      quad.dispose();
      mat.dispose();
    },
  };
}
