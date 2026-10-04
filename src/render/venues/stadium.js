// Venue 'stadium': a pro-tour show court inside a dark arena. Tiered stands on the long sides
// (with an upper tier) and behind both baselines hold ~3,000 instanced impostor spectators who
// react to the points (src/render/crowd.js); LED perimeter boards and a big screen run original
// animated graphics (never real brands); broadcast lighting is bright and even from a truss grid;
// camera towers in the corners, the umpire's chair at the net, ball kids at the corners and the
// players' benches complete the picture.
import * as THREE from 'three';
import { COURT } from '../../config.js';
import { ledBannerTexture } from '../textures.js';
import { boxAt, merge, tint, disposeTree, seeded, keepSet, floorPlane, floorAround, courtFootprints } from './common.js';
import { createCrowd, randomLook } from '../crowd.js';

const HW = COURT.halfWidth;
const HL = COURT.halfLength;

/** Arena layout (m). */
export const ARENA = Object.freeze({
  floor: { x: 11.5, z: 16 },
  boards: { x: 7.4, z: 13.0, h: 0.95 },
  side: { x0: 9.6, rows: 14, depth: 0.85, rise: 0.42, base: 0.75, z: 15.5 },
  upper: { gap: 1.6, rows: 9, depth: 0.85, rise: 0.5 },
  end: { z0: 16.6, rows: 12, depth: 0.85, rise: 0.42, base: 0.75, x: 10.5 },
  roof: 24,
  truss: 15.5,
  screen: { z: -29, y: 13.2, w: 15, h: 6.4 },
});

const SEAT_PITCH = 0.56;
const BRAND = { yellow: new THREE.Color(0xd9f03a), cyan: new THREE.Color(0x5fd8ff), navy: new THREE.Color(0x0e1a33) };

// ---------------------------------------------------------------------------------------------
// LED graphics shader (perimeter boards, stand fascias, big screen)

const LED_VERT = /* glsl */ `
  attribute float aU;
  varying vec2 vUv;
  varying float vU;
  void main() {
    vUv = uv;
    vU = aU;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  }
`;

const LED_FRAG = /* glsl */ `
  uniform sampler2D uBanner;
  uniform float uTime;
  uniform vec4 uFlash;   // time since flash, banner row, strength, unused
  uniform float uGain;
  uniform float uSegLen;
  uniform float uHeight; // board height (m): banner scale
  uniform float uPitch;  // LED pixel pitch (m)
  uniform vec2 uBand;    // banner band: centre and half-height in v (screen: a band, boards: all)
  varying vec2 vUv;
  varying float vU;
  float h1(float n) { return fract(sin(n * 91.345) * 47453.21); }
  vec3 bannerAt(float row, float u, float v) {
    float len = uHeight * 16.0;
    float x = fract(u / len);
    float vb = (v - uBand.x) / (2.0 * uBand.y) + 0.5;
    if (vb < 0.0 || vb > 1.0) return vec3(0.0);
    vec4 t = texture2D(uBanner, vec2(x, (7.0 - row + clamp(vb, 0.02, 0.98)) / 8.0));
    return t.rgb * t.a;
  }
  void main() {
    float seg = floor((vU + uTime * 0.0) / uSegLen);
    float phase = floor(uTime / 7.0 + h1(seg) * 3.0);
    float pick = h1(seg * 7.0 + phase);
    float row = pick < 0.22 ? 0.0 : pick < 0.4 ? 1.0 : pick < 0.58 ? 3.0 : pick < 0.74 ? 6.0 : pick < 0.88 ? 7.0 : 2.0;
    float dir = h1(seg + 3.0) < 0.5 ? 1.0 : -1.0;
    float scroll = uTime * 1.3 * dir;
    // Background: deep navy with sliding diagonal stripes in the brand colours.
    float stripe = smoothstep(0.45, 0.5, fract((vU + vUv.y * uHeight * 0.8 - uTime * 0.9) / 1.6));
    vec3 bg = mix(vec3(0.02, 0.05, 0.14), vec3(0.04, 0.12, 0.3), vUv.y) + stripe * vec3(0.0, 0.05, 0.1);
    vec3 fg = bannerAt(row, vU + scroll, vUv.y);
    vec3 c = bg * (1.0 - clamp(dot(fg, vec3(0.5)), 0.0, 1.0)) + fg * 1.6;
    // Wipe between programmes.
    float tIn = fract(uTime / 7.0 + h1(seg) * 3.0) * 7.0;
    c *= smoothstep(0.0, 0.35, tIn);
    // Point flash: the banner row of the reaction strobes over every board.
    float f = uFlash.z * exp(-uFlash.x * 0.55) * step(uFlash.x, 4.5);
    if (f > 0.01) {
      vec3 fl = bannerAt(uFlash.y, vU - uTime * 2.4, vUv.y);
      float strobe = 0.75 + 0.25 * step(0.5, fract(uFlash.x * 3.0));
      c = mix(c, vec3(0.9, 0.95, 0.2) * 0.25 + fl * 2.2 * strobe, clamp(f, 0.0, 1.0));
    }
    // LED pixel structure.
    vec2 pp = fract(vec2(vU, vUv.y * uHeight) / uPitch) - 0.5;
    float dotm = 0.62 + 0.38 * smoothstep(0.5, 0.2, length(pp));
    gl_FragColor = vec4(c * dotm * uGain, 1.0);
  }
`;

function makeLedMaterial(banner, { height, gain = 1.7, pitch = 0.012, segLen = 7.5, band = [0.5, 0.5] } = {}) {
  return new THREE.ShaderMaterial({
    uniforms: {
      uBanner: { value: banner },
      uTime: { value: 0 },
      uFlash: { value: new THREE.Vector4(99, 4, 0, 0) },
      uGain: { value: gain },
      uSegLen: { value: segLen },
      uHeight: { value: height },
      uPitch: { value: pitch },
      uBand: { value: new THREE.Vector2(...band) },
    },
    vertexShader: LED_VERT,
    fragmentShader: LED_FRAG,
    side: THREE.DoubleSide,
  });
}

/** Vertical quad strip from a polyline (court frame), facing `inward`, with aU = metres along it. */
function ribbon(points, y0, y1, u0 = 0) {
  const pos = [], uv = [], au = [], idx = [];
  let u = u0;
  for (let i = 0; i < points.length - 1; i++) {
    const [ax, az] = points[i], [bx, bz] = points[i + 1];
    const len = Math.hypot(bx - ax, bz - az);
    const base = pos.length / 3;
    pos.push(ax, y0, az, bx, y0, bz, bx, y1, bz, ax, y1, az);
    uv.push(0, 0, 1, 0, 1, 1, 0, 1);
    au.push(u, u + len, u + len, u);
    idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
    u += len;
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  g.setAttribute('aU', new THREE.Float32BufferAttribute(au, 1));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ---------------------------------------------------------------------------------------------
// Stands

/** Rows of a stand: returns the stepped concrete boxes, seat strips and the seat positions. */
function standRows({ axis, sign, start, rows, depth, rise, base, half, seatCol }, parts, seats) {
  // axis 'x': the stand runs along z at x = sign * (start + r * depth), stepping outward in x.
  const concrete = new THREE.Color(0x2a2e35), seatC = seatCol;
  for (let r = 0; r < rows; r++) {
    const d0 = start + r * depth;
    const y = base + r * rise;
    if (axis === 'x') {
      parts.push(tint(boxAt(depth, y, half * 2, sign * (d0 + depth / 2), y / 2, 0), concrete));
      parts.push(tint(boxAt(0.42, 0.06, half * 2, sign * (d0 + depth * 0.62), y + 0.43, 0), seatC));
      parts.push(tint(boxAt(0.06, 0.42, half * 2, sign * (d0 + depth * 0.86), y + 0.62, 0), seatC));
      for (let z = -half + SEAT_PITCH / 2; z < half; z += SEAT_PITCH) seats.push({ x: sign * (d0 + depth * 0.6), y, z, row: r });
    } else {
      parts.push(tint(boxAt(half * 2, y, depth, 0, y / 2, sign * (d0 + depth / 2)), concrete));
      parts.push(tint(boxAt(half * 2, 0.06, 0.42, 0, y + 0.43, sign * (d0 + depth * 0.62)), seatC));
      parts.push(tint(boxAt(half * 2, 0.42, 0.06, 0, y + 0.62, sign * (d0 + depth * 0.86)), seatC));
      for (let x = -half + SEAT_PITCH / 2; x < half; x += SEAT_PITCH) seats.push({ x, y, z: sign * (d0 + depth * 0.6), row: r });
    }
  }
}

function buildStands(group, mats, rng) {
  const parts = [];
  const seats = [];
  const A = ARENA;
  const seatBlue = new THREE.Color(0x1d3f8a);
  for (const s of [-1, 1]) {
    standRows({ axis: 'x', sign: s, start: A.side.x0, rows: A.side.rows, depth: A.side.depth, rise: A.side.rise, base: A.side.base, half: A.side.z, seatCol: seatBlue }, parts, seats);
    standRows({ axis: 'z', sign: s, start: A.end.z0, rows: A.end.rows, depth: A.end.depth, rise: A.end.rise, base: A.end.base, half: A.end.x, seatCol: seatBlue }, parts, seats);
  }
  // Upper tier on the long sides, above a fascia.
  const upperStart = A.side.x0 + A.side.rows * A.side.depth + A.upper.gap;
  const upperBase = A.side.base + A.side.rows * A.side.rise + 2.2;
  const upperSeats = [];
  for (const s of [-1, 1]) {
    standRows({ axis: 'x', sign: s, start: upperStart, rows: A.upper.rows, depth: A.upper.depth, rise: A.upper.rise, base: upperBase, half: A.side.z + 2, seatCol: seatBlue }, parts, upperSeats);
    // Fascia under the upper tier front (dark, carries an LED ribbon).
    parts.push(tint(boxAt(0.3, 2.4, (A.side.z + 2) * 2, s * (upperStart - 0.1), upperBase - 1.0, 0), new THREE.Color(0x0b0c0f)));
  }
  // Front walls of the stands (padded, dark) and the arena perimeter walls.
  const dark = new THREE.Color(0x0d1018);
  for (const s of [-1, 1]) {
    parts.push(tint(boxAt(0.2, 1.1, A.side.z * 2, s * (A.side.x0 - 0.1), 0.55, 0), dark));
    parts.push(tint(boxAt(A.end.x * 2, 1.1, 0.2, 0, 0.55, s * (A.end.z0 - 0.1)), dark));
    parts.push(tint(boxAt(0.4, A.roof, 70, s * 33, A.roof / 2, 0), new THREE.Color(0x07080a)));
    parts.push(tint(boxAt(70, A.roof, 0.4, 0, A.roof / 2, s * 33), new THREE.Color(0x07080a)));
    // Corner fills: black drapes between the side and end stands.
    for (const t of [-1, 1]) parts.push(tint(boxAt(6, 9, 0.3, s * 13.2, 4.5, t * 16.2, { rotY: s * t * 0.6 }), new THREE.Color(0x050608)));
  }
  const m = new THREE.Mesh(merge(parts), mats.stands);
  m.receiveShadow = true;
  m.name = 'stands';
  group.add(m);
  return { seats, upperSeats, upperStart, upperBase };
}

// ---------------------------------------------------------------------------------------------
// Props: umpire chair, benches, camera towers, ball baskets

function buildProps(group, mats) {
  const p = [];
  const steel = new THREE.Color(0x30343b), white = new THREE.Color(0xeeeeee), navy = new THREE.Color(0x14203a), black = new THREE.Color(0x0b0c0e);
  // Umpire chair beside the left net post (outside the mesh).
  const ux = -(HW + 1.35);
  for (const dz of [-0.35, 0.35]) for (const dx of [-0.3, 0.3]) p.push(tint(boxAt(0.05, 1.45, 0.05, ux + dx, 0.725, dz), steel));
  p.push(tint(boxAt(0.8, 0.06, 0.9, ux, 1.45, 0), steel));
  p.push(tint(boxAt(0.5, 0.06, 0.5, ux, 1.92, 0), navy));
  p.push(tint(boxAt(0.06, 0.6, 0.5, ux - 0.25, 2.2, 0), navy));
  p.push(tint(boxAt(0.42, 0.04, 0.6, ux + 0.33, 2.15, 0), white)); // desk with the score tablet
  for (let k = 0; k < 4; k++) p.push(tint(boxAt(0.35, 0.03, 0.5, ux - 0.55 + k * 0.0, 0.3 + k * 0.33, 0.65 - k * 0.0), steel));
  // Players' benches on the right, either side of the net post: chairs, towels, bags, bottles.
  for (const z of [-2.4, 2.4]) {
    const bx = HW + 1.5;
    for (const dz of [-0.45, 0.45]) {
      p.push(tint(boxAt(0.48, 0.05, 0.46, bx, 0.46, z + dz), navy));
      p.push(tint(boxAt(0.05, 0.5, 0.46, bx + 0.22, 0.72, z + dz), navy));
      for (const ox of [-0.2, 0.2]) for (const oz of [-0.2, 0.2]) p.push(tint(boxAt(0.03, 0.46, 0.03, bx + ox, 0.23, z + dz + oz), steel));
      p.push(tint(boxAt(0.36, 0.03, 0.4, bx - 0.02, 0.5, z + dz), white)); // towel
    }
    p.push(tint(boxAt(0.36, 0.34, 0.85, bx + 0.6, 0.17, z), z < 0 ? new THREE.Color(0xe8572a) : new THREE.Color(0x1d2b4a))); // racket bag
    for (let k = 0; k < 3; k++) {
      const b = new THREE.CylinderGeometry(0.035, 0.035, 0.24, 10);
      b.translate(bx - 0.35, 0.12, z - 0.3 + k * 0.1);
      p.push(tint(b, k === 1 ? BRAND.cyan : white));
    }
  }
  // Camera towers in the far corners and a gantry behind the near baseline.
  const tower = (x, z, h) => {
    for (const ox of [-0.7, 0.7]) for (const oz of [-0.7, 0.7]) p.push(tint(boxAt(0.06, h, 0.06, x + ox, h / 2, z + oz), steel));
    for (let y = 0.8; y < h; y += 1.2) {
      p.push(tint(boxAt(1.46, 0.04, 0.04, x, y, z - 0.7), steel), tint(boxAt(1.46, 0.04, 0.04, x, y, z + 0.7), steel));
      p.push(tint(boxAt(0.04, 0.04, 1.46, x - 0.7, y, z), steel), tint(boxAt(0.04, 0.04, 1.46, x + 0.7, y, z), steel));
    }
    p.push(tint(boxAt(1.7, 0.08, 1.7, x, h, z), black));
    p.push(tint(boxAt(1.7, 0.5, 0.04, x, h + 0.29, z + 0.83), steel));
    // Broadcast camera on a tripod head, long lens toward the court.
    p.push(tint(boxAt(0.22, 0.28, 0.5, x, h + 1.25, z), black));
    const lens = new THREE.CylinderGeometry(0.09, 0.11, 0.62, 12);
    lens.rotateX(Math.PI / 2);
    lens.translate(x, h + 1.28, z - Math.sign(z) * 0.52);
    p.push(tint(lens, black));
    p.push(tint(boxAt(0.05, 1.1, 0.05, x, h + 0.6, z), steel));
  };
  tower(-10.6, -15.6, 4.2);
  tower(10.6, -15.6, 4.2);
  tower(-10.6, 15.6, 3.0);
  // Ball baskets at the back corners.
  for (const sx of [-1, 1]) {
    const b = new THREE.CylinderGeometry(0.22, 0.18, 0.45, 14, 1, true);
    b.translate(sx * (HW + 0.75), 0.23, -(HL + 0.7));
    p.push(tint(b, steel));
  }
  const m = new THREE.Mesh(merge(p), mats.props);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = 'arena-props';
  group.add(m);
}

// ---------------------------------------------------------------------------------------------
// Lighting rig

function buildLights(group, mats, q) {
  const A = ARENA;
  const lights = { keys: [], fills: [], neighbors: [], hemi: null, sun: null, all: [] };
  // Truss grid over the court with LED fixtures (emissive faces) and a few accent beams.
  const truss = [], faces = [];
  const tW = 13, tL = 26;
  for (const s of [-1, 1]) {
    truss.push(tint(boxAt(0.5, 0.5, tL, s * tW / 2, A.truss, 0), new THREE.Color(0x15171b)));
    truss.push(tint(boxAt(tW, 0.5, 0.5, 0, A.truss, s * tL / 2), new THREE.Color(0x15171b)));
  }
  for (const z of [-6.5, 0, 6.5]) truss.push(tint(boxAt(tW, 0.4, 0.4, 0, A.truss, z), new THREE.Color(0x15171b)));
  for (const s of [-1, 1]) for (const t of [-1, 1]) truss.push(tint(boxAt(0.05, A.roof - A.truss, 0.05, s * tW / 2, (A.roof + A.truss) / 2, t * tL / 2), new THREE.Color(0x15171b)));
  for (const s of [-1, 1]) {
    for (let z = -tL / 2 + 1; z <= tL / 2 - 1; z += 1.6) {
      truss.push(tint(boxAt(0.42, 0.34, 0.42, s * (tW / 2 - 0.05), A.truss - 0.42, z), new THREE.Color(0x0e0f12)));
      const d = new THREE.CircleGeometry(0.17, 18);
      d.rotateX(Math.PI / 2);
      d.translate(s * (tW / 2 - 0.05), A.truss - 0.6, z);
      faces.push(tint(d, new THREE.Color(1.0, 0.97, 0.92).multiplyScalar(14)));
    }
  }
  group.add(Object.assign(new THREE.Mesh(merge(truss), mats.props), { name: 'light-truss' }));
  const faceMesh = new THREE.Mesh(merge(faces), mats.glow);
  faceMesh.name = 'fixture-faces';
  group.add(faceMesh);
  // Roof.
  const roof = floorPlane(-34, 34, -34, 34, A.roof, 4);
  roof.rotateX(Math.PI);
  roof.translate(0, A.roof * 2, 0);
  group.add(new THREE.Mesh(roof, new THREE.MeshStandardMaterial({ color: 0x08090b, roughness: 0.9 })));

  const white = new THREE.Color(1.0, 0.97, 0.93);
  const spot = (I, p, t, angle, pen, shadow) => {
    const s = new THREE.SpotLight(white, I, 0, angle, pen, 2);
    s.position.set(...p);
    s.target.position.set(...t);
    group.add(s, s.target);
    if (shadow) {
      s.castShadow = true;
      s.shadow.mapSize.set(q.shadowMapSize, q.shadowMapSize);
      s.shadow.radius = q.shadowRadius;
      s.shadow.bias = -0.0002;
      s.shadow.normalBias = 0.02;
      s.shadow.camera.near = 6;
      s.shadow.camera.far = 30;
    }
    lights.all.push(s);
    return s;
  };
  // Two shadow-casting keys straight above each half (short TV shadows) ... (round 5, QA r5
  // presence: the near half's shadows come from a broadcast flood behind the near baseline instead,
  // so the player's own shadow falls forward into their view).
  for (const z of [-5.5, 5.5]) lights.keys.push(spot(430, [0, A.truss - 0.5, z * 0.9], [0, 0, z], 0.62, 0.65, z < 0));
  {
    const back = spot(300, [0, 8.5, 16.5], [0, 0, 3.5], 0.5, 0.65, true);
    back.name = 'near-back-flood';
    back.shadow.camera.far = 40;
    lights.keys.push(back);
  }
  // ... broadcast fills from the long sides (faces, the ball against the glass) ...
  for (const sx of [-1, 1]) {
    for (const z of [-7, 0, 7]) {
      const f = spot(130, [sx * 6.5, A.truss - 0.6, z], [-sx * 1.5, 0.8, z * 0.8], 0.75, 0.7, false);
      f.userData.fill = true;
      f.visible = q.fillLights;
      lights.fills.push(f);
    }
  }
  // ... and spill onto the stands.
  for (const sx of [-1, 1]) {
    const s = spot(150, [sx * 3, A.truss, 0], [sx * 15, 4, 0], 0.85, 0.9, false);
    lights.fills.push(s);
  }
  for (const sz of [-1, 1]) lights.fills.push(spot(120, [0, A.truss, sz * 8], [0, 4, sz * 21], 0.8, 0.9, false));
  lights.hemi = new THREE.HemisphereLight(0x9fb0d0, 0x1a1d24, 0.35);
  lights.hemi.userData.baseIntensity = 0.35;
  lights.hemi.userData.noFillBoost = false;
  group.add(lights.hemi);
  lights.all.push(lights.hemi);
  return { lights, faceMesh };
}

/** Faint light shafts under the fixtures (additive cones, no depth write). */
function buildBeams(group) {
  const mat = new THREE.ShaderMaterial({
    uniforms: { uA: { value: 0.05 } },
    vertexShader: `varying float vY; varying vec3 vN; varying vec3 vV;
      void main(){ vY = position.y; vec4 mv = modelViewMatrix * vec4(position,1.0); vN = normalize(normalMatrix*normal); vV = normalize(-mv.xyz); gl_Position = projectionMatrix * mv; }`,
    fragmentShader: `varying float vY; varying vec3 vN; varying vec3 vV; uniform float uA;
      void main(){ float edge = pow(abs(dot(normalize(vN), normalize(vV))), 1.5); float fall = smoothstep(-1.0, 0.2, vY);
        float a = uA * edge * fall; gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * a, a); }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, side: THREE.DoubleSide,
  });
  const parts = [];
  for (const s of [-1, 1]) {
    for (const z of [-9, -3, 3, 9]) {
      const c = new THREE.CylinderGeometry(0.2, 2.4, 9, 20, 1, true);
      c.translate(0, -4.5, 0);
      c.rotateZ(s * -0.22);
      c.translate(s * 6.4, ARENA.truss - 0.6, z);
      parts.push(c);
    }
  }
  const m = new THREE.Mesh(merge(parts), mat);
  m.renderOrder = 9;
  m.name = 'light-shafts';
  group.add(m);
  return m;
}

// ---------------------------------------------------------------------------------------------

/**
 * @param {{ scene, renderer, mats, q }} ctx
 */
export function buildStadium(ctx) {
  const { mats: courtMats, q } = ctx;
  const group = new THREE.Group();
  group.name = 'venue-stadium';
  const rng = seeded(1717);
  const mats = {
    stands: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.85 }),
    props: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.6, metalness: 0.2 }),
    glow: new THREE.MeshBasicMaterial({ vertexColors: true }),
    floor: new THREE.MeshStandardMaterial({ color: 0x15233d, roughness: 0.55, metalness: 0.0, envMapIntensity: 0.6 }),
  };
  // Arena floor: dark blue sports flooring around the court, a lighter apron at the boards.
  const floor = new THREE.Mesh(floorAround(-30, 30, -30, 30, -0.012, 4, courtFootprints([0], COURT.halfWidth, COURT.halfLength)), mats.floor);
  floor.receiveShadow = true;
  floor.name = 'arena-floor';
  group.add(floor);

  const stands = buildStands(group, mats, rng);
  buildProps(group, mats);
  const { lights, faceMesh } = buildLights(group, mats, q);
  const beams = buildBeams(group);

  // LED boards round the court (inside face), fascias of the upper tier, the big screen.
  const banner = ledBannerTexture();
  const B = ARENA.boards;
  const boardMat = makeLedMaterial(banner, { height: B.h, gain: 1.8 });
  const ring = ribbon([[-B.x, B.z], [B.x, B.z], [B.x, -B.z], [-B.x, -B.z], [-B.x, B.z]].reverse(), 0.06, B.h);
  const boards = new THREE.Mesh(ring, boardMat);
  boards.name = 'led-boards';
  group.add(boards);
  // Board housings (backs and tops).
  const hous = [];
  for (const s of [-1, 1]) {
    hous.push(tint(boxAt(0.25, B.h + 0.08, B.z * 2 + 0.25, s * (B.x + 0.13), (B.h + 0.08) / 2, 0), new THREE.Color(0x0a0b0d)));
    hous.push(tint(boxAt(B.x * 2 + 0.25, B.h + 0.08, 0.25, 0, (B.h + 0.08) / 2, s * (B.z + 0.13)), new THREE.Color(0x0a0b0d)));
  }
  group.add(new THREE.Mesh(merge(hous), mats.props));
  const fasciaMat = makeLedMaterial(banner, { height: 0.9, gain: 1.4, segLen: 12 });
  const fx = stands.upperStart - 0.27;
  const fy = stands.upperBase - 1.6;
  const fascia = merge([
    ribbon([[-fx, ARENA.side.z + 2], [-fx, -ARENA.side.z - 2]], fy, fy + 0.9, 0),
    ribbon([[fx, -ARENA.side.z - 2], [fx, ARENA.side.z + 2]], fy, fy + 0.9, 40),
  ]);
  group.add(Object.assign(new THREE.Mesh(fascia, fasciaMat), { name: 'led-fascia' }));
  const S = ARENA.screen;
  const screenMat = makeLedMaterial(banner, { height: S.h * 0.3, gain: 1.25, pitch: 0.03, segLen: 100, band: [0.42, 0.15] });
  const screen = ribbon([[-S.w / 2, S.z], [S.w / 2, S.z]], S.y - S.h / 2, S.y + S.h / 2);
  group.add(Object.assign(new THREE.Mesh(screen, screenMat), { name: 'big-screen' }));
  group.add(new THREE.Mesh(boxAt(S.w + 0.6, S.h + 0.6, 0.5, 0, S.y, S.z - 0.3), mats.props));
  const ledMats = [boardMat, fasciaMat, screenMat];

  // Spectators: one per seat (a few empty), dimmer further up; the umpire, ball kids, camera crew.
  const people = [];
  const team = [BRAND.yellow, BRAND.cyan, new THREE.Color(0xe8572a)];
  const place = (s, lit) => {
    if (rng() < 0.07) return;
    const look = randomLook(rng);
    if (rng() < 0.12) look.shirt = '#' + team[Math.floor(rng() * team.length)].getHexString();
    people.push({ x: s.x, y: s.y, z: s.z, seated: true, ...look, lit });
  };
  for (const s of stands.seats) place(s, 1.05 - s.row * 0.03);
  for (const s of stands.upperSeats) place(s, 0.62 - s.row * 0.02);
  people.push({ x: -(HW + 1.35), y: 1.48, z: 0, seated: true, shirt: '#16223f', skin: '#c58c6a', hair: '#2e1f16', trousers: '#16181d', scale: 1, cap: 0, lit: 1.1, threshold: 2 });
  for (const [x, z] of [[-(HW + 0.85), -(HL + 0.75)], [HW + 0.85, -(HL + 0.75)], [-(HW + 0.85), HL + 0.75], [HW + 0.85, HL + 0.75], [-(HW + 0.9), -1.4], [HW + 0.9, 1.4]]) {
    people.push({ x, y: -0.26, z, seated: true, shirt: '#d9f03a', skin: '#c58c6a', hair: '#1a1310', trousers: '#16203a', scale: 0.82, cap: 1, lit: 1.1, threshold: 2 });
  }
  for (const [x, z, h] of [[-10.6, -15.6, 4.2], [10.6, -15.6, 4.2], [-10.6, 15.6, 3.0]]) {
    people.push({ x: x + 0.3 * Math.sign(-x), y: h + 0.05, z: z + 0.35, seated: false, shirt: '#111316', skin: '#a46b4b', hair: '#1a1310', trousers: '#111316', cap: 1, lit: 0.9, threshold: 2 });
  }
  const crowd = createCrowd({ people, msaa: q.msaa > 0, name: 'stadium-crowd', light: 0xf4f0ff, lightK: 0.62 });
  group.add(crowd.mesh);

  let waveAt = Infinity;
  let now = 0;
  const FLASH_ROW = { roar: 5, cheer: 4, applause: 4, wave: 1 };
  return {
    group,
    lights,
    crowd,
    courts: 1,
    envIntensity: 0.5,
    reflectScale: 1.15,
    capturePosition: new THREE.Vector3(0, 2.5, 0),
    turf: { dust: 0, wear: 0.45, grain: 0.12, ao: 1, tint: 0xf4f8ff },
    glass: { grease: 0.45, felt: 0.6, water: 0 },
    capture: {
      ambient() { beams.visible = false; faceMesh.visible = false; },
      reflect() { faceMesh.visible = true; },
      restore() { beams.visible = true; faceMesh.visible = true; },
    },
    react(kind, level, info) {
      crowd.react(kind, level);
      const row = info && info.board != null ? info.board : FLASH_ROW[kind];
      if (row != null && level >= 0.3) for (const m of ledMats) m.uniforms.uFlash.value.set(0, row, Math.min(1, level), 0);
      // After a big roar the crowd sometimes starts a Mexican wave.
      if (kind === 'roar' && level >= 0.9 && rng() < 0.5) waveAt = now + 2.6;
    },
    update(dt, time) {
      now = time;
      if (time >= waveAt) {
        waveAt = Infinity;
        crowd.react('wave', 1);
      }
      crowd.update(dt, time);
      for (const m of ledMats) {
        m.uniforms.uTime.value = time;
        m.uniforms.uFlash.value.x += dt;
      }
    },
    dispose() {
      crowd.dispose();
      disposeTree(group, { keep: keepSet(courtMats) });
    },
  };
}
