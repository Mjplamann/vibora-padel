// Venue 'club': the indoor premium club at night (SPEC §6.3). An exact FIP court plus two
// neighbouring courts in a hall with dark polished concrete, anthracite sandwich-panel walls, steel
// trusses, LED linear panels over each court, a warm cove strip, the club sign, a lounge bar behind
// the far court and a few people watching from the benches.
import * as THREE from 'three';
import { COURT } from '../../config.js';
import { concreteTexture, panelTexture, logoTexture, CONCRETE_TILE_M, PANEL_TILE_M } from '../textures.js';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { boxAt, wallPlane, merge, tint, disposeTree, seeded, keepSet, floorAround, courtFootprints } from './common.js';
import { detailNormal, addTriplanarDetail } from '../detailMaps.js';
import { createCrowd, randomLook } from '../crowd.js';

const HW = COURT.halfWidth;
const HL = COURT.halfLength;

/** Interior extent of the hall. */
export const HALL = { xMin: -21, xMax: 21, zMin: -15.5, zMax: 15.5, height: 11, trussBottom: 9.9 };

const LED_WHITE = new THREE.Color(1.0, 0.955, 0.9);
const LED_RADIANCE = 7.5; // linear HDR radiance of the diffusers (well above the bloom threshold)
const LED_RADIANCE_REFLECT = 30; // LED radiance seen in reflections (glass, steel)
const LED_RADIANCE_ENV = 2.5; // dimmer in the environment capture: spot lights already carry their light
/** Light intensities (candela for spots). Court centre illuminance ≈ 4.5 (linear units, exposure 1). */
export const LIGHT = { key: 205, fill: 18, neighbor: 175, hemi: 0.08, env: 0.45, back: 170 };

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

/** Hall floor: polished concrete with contact darkening along the walls and the court curbs. */
function addFloorOcclusion(mat) {
  mat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFloorW;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvFloorW = position;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vFloorW;')
      .replace('#include <aomap_fragment>', `#include <aomap_fragment>
        {
          float dWall = min(min(vFloorW.x - (${HALL.xMin.toFixed(1)}), ${HALL.xMax.toFixed(1)} - vFloorW.x), min(vFloorW.z - (${HALL.zMin.toFixed(1)}), ${HALL.zMax.toFixed(1)} - vFloorW.z));
          float cx = min(min(abs(vFloorW.x), abs(vFloorW.x - 13.0)), abs(vFloorW.x + 13.0));
          float dCourt = max(cx - 5.15, abs(vFloorW.z) - 10.15);
          float ao = (1.0 - 0.45 * exp(-dWall / 0.35)) * (1.0 - 0.35 * exp(-max(dCourt, 0.0) / 0.25));
          reflectedLight.indirectDiffuse *= ao;
          reflectedLight.directDiffuse *= mix(1.0, ao, 0.5);
          reflectedLight.indirectSpecular *= ao;
        }`);
  };
  mat.customProgramCacheKey = () => 'vibora-hall-floor';
}

function makeHallMaterials() {
  const concrete = concreteTexture();
  const panel = panelTexture();
  const m = {
    concrete: new THREE.MeshStandardMaterial({
      map: concrete, normalMap: concrete.userData.normalMap, roughnessMap: concrete.userData.roughnessMap,
      roughness: 1, metalness: 0, envMapIntensity: 0.8,
    }),
    wallUpper: new THREE.MeshStandardMaterial({
      map: panel, normalMap: panel.userData.normalMap, roughnessMap: panel.userData.roughnessMap, roughness: 1,
      metalness: 0.2, color: 0xb9bec6,
    }),
    wallLower: new THREE.MeshStandardMaterial({ color: 0x14171c, roughness: 0.82, metalness: 0 }),
    roof: new THREE.MeshStandardMaterial({ normalMap: panel.userData.normalMap, color: 0x50565e, roughness: 0.8, metalness: 0.0 }),
    truss: new THREE.MeshStandardMaterial({ color: 0x6b7179, roughness: 0.6, metalness: 0.0 }),
    duct: new THREE.MeshStandardMaterial({ color: 0x6f757c, roughness: 0.55, metalness: 0.9 }),
    housing: new THREE.MeshStandardMaterial({ color: 0x1b1d21, roughness: 0.45, metalness: 0.7 }),
    led: new THREE.MeshBasicMaterial({ color: LED_WHITE.clone().multiplyScalar(LED_RADIANCE) }),
    ledStrip: new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.86, 0.66).multiplyScalar(5.0) }),
    exit: new THREE.MeshBasicMaterial({ color: new THREE.Color(0.1, 1.0, 0.35).multiplyScalar(1.6) }),
    wood: new THREE.MeshStandardMaterial({ color: 0x6b4a32, roughness: 0.6 }),
    props: new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.55, metalness: 0.1 }),
    warm: new THREE.MeshBasicMaterial({ vertexColors: true }),
  };
  addCoveWash(m.wallUpper, 1);
  addCoveWash(m.wallLower, -1);
  addFloorOcclusion(m.concrete);
  // Round 6 detail normals (render/detailMaps.js): sanded wood grain on the benches, fine grit on
  // the polished concrete and the lower wall, so close surfaces hold texture under the reflections.
  addTriplanarDetail(m.wood, detailNormal('grain-normal'), { scale: 2.2, strength: 0.35, key: 'grain' });
  addTriplanarDetail(m.concrete, detailNormal('grit-normal'), { scale: 1.6, strength: 0.12, key: 'grit' });
  addTriplanarDetail(m.wallLower, detailNormal('grit-normal'), { scale: 2.5, strength: 0.2, key: 'grit' });
  addTriplanarDetail(m.props, detailNormal('grit-normal'), { scale: 6, strength: 0.08, key: 'grit' });
  return m;
}

function buildHall(group, mats, courtMats, courtXs) {
  const H = HALL;
  const floor = new THREE.Mesh(floorAround(H.xMin, H.xMax, H.zMin, H.zMax, -0.012, CONCRETE_TILE_M, courtFootprints(courtXs, HW, HL)), mats.concrete);
  floor.receiveShadow = true;
  floor.name = 'hall-floor';
  group.add(floor);
  const curbs = [];
  for (const cx of courtXs) {
    curbs.push(boxAt(HW * 2 + 0.3, 0.012, 0.15, cx, -0.006, HL + 0.07));
    curbs.push(boxAt(HW * 2 + 0.3, 0.012, 0.15, cx, -0.006, -HL - 0.07));
    curbs.push(boxAt(0.15, 0.012, HL * 2, cx + HW + 0.07, -0.006, 0));
    curbs.push(boxAt(0.15, 0.012, HL * 2, cx - HW - 0.07, -0.006, 0));
  }
  const curb = new THREE.Mesh(merge(curbs), courtMats.steel);
  curb.receiveShadow = true;
  group.add(curb);

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
  group.add(wl, wu);

  const strips = [];
  const inset = 0.06;
  strips.push(boxAt(H.xMax - H.xMin, 0.035, 0.02, 0, lowerTop + 0.02, H.zMin + inset));
  strips.push(boxAt(H.xMax - H.xMin, 0.035, 0.02, 0, lowerTop + 0.02, H.zMax - inset));
  strips.push(boxAt(0.02, 0.035, H.zMax - H.zMin, H.xMin + inset, lowerTop + 0.02, 0));
  strips.push(boxAt(0.02, 0.035, H.zMax - H.zMin, H.xMax - inset, lowerTop + 0.02, 0));
  group.add(new THREE.Mesh(merge(strips), mats.ledStrip));
  const shelf = [];
  shelf.push(boxAt(H.xMax - H.xMin, 0.03, 0.14, 0, lowerTop + 0.06, H.zMin + 0.07));
  shelf.push(boxAt(H.xMax - H.xMin, 0.03, 0.14, 0, lowerTop + 0.06, H.zMax - 0.07));
  shelf.push(boxAt(0.14, 0.03, H.zMax - H.zMin, H.xMin + 0.07, lowerTop + 0.06, 0));
  shelf.push(boxAt(0.14, 0.03, H.zMax - H.zMin, H.xMax - 0.07, lowerTop + 0.06, 0));
  group.add(new THREE.Mesh(merge(shelf), mats.housing));

  const roofG = new THREE.PlaneGeometry(H.xMax - H.xMin, H.zMax - H.zMin);
  roofG.rotateX(Math.PI / 2);
  roofG.translate(0, H.height, 0);
  const ruv = roofG.attributes.uv;
  for (let i = 0; i < ruv.count; i++) ruv.setXY(i, ruv.getX(i) * 6, ruv.getY(i) * ((H.zMax - H.zMin) / 1.2));
  group.add(new THREE.Mesh(roofG, mats.roof));

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
  group.add(truss);
  const purl = [];
  for (let x = H.xMin + 1.5; x < H.xMax; x += 3) purl.push(boxAt(0.08, 0.16, H.zMax - H.zMin, x, H.height - 0.08, 0));
  group.add(new THREE.Mesh(merge(purl), mats.truss));

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
  group.add(new THREE.Mesh(merge(ducts), mats.duct));

  // Club sign on the far wall.
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
  group.add(signGroup);

  const exits = [];
  for (const [x, rotY] of [[H.xMin + 0.06, Math.PI / 2], [H.xMax - 0.06, -Math.PI / 2]]) {
    exits.push(boxAt(0.4, 0.16, 0.03, 0, 0, 0, { rotY }).translate(x, 2.45, -6));
  }
  group.add(new THREE.Mesh(merge(exits), mats.exit));
  const doors = [];
  for (const x of [H.xMin + 0.03, H.xMax - 0.03]) doors.push(boxAt(0.05, 2.2, 1.8, x, 1.1, -6));
  group.add(new THREE.Mesh(merge(doors), new THREE.MeshStandardMaterial({ color: 0x23272d, roughness: 0.5, metalness: 0.4 })));

  const benchSeat = [], benchFrame = [];
  for (const x of [-6.6, 6.6, -19.4, 19.4]) {
    for (const z of [-1.4, 1.4]) {
      benchSeat.push(boxAt(0.4, 0.04, 1.8, x, 0.45, z));
      benchFrame.push(boxAt(0.05, 0.43, 0.05, x - 0.15, 0.215, z - 0.8), boxAt(0.05, 0.43, 0.05, x + 0.15, 0.215, z - 0.8));
      benchFrame.push(boxAt(0.05, 0.43, 0.05, x - 0.15, 0.215, z + 0.8), boxAt(0.05, 0.43, 0.05, x + 0.15, 0.215, z + 0.8));
    }
  }
  const seat = new THREE.Mesh(merge(benchSeat), mats.wood);
  const frame = new THREE.Mesh(merge(benchFrame), courtMats.steel);
  seat.castShadow = frame.castShadow = true;
  seat.receiveShadow = true;
  group.add(seat, frame);
  return { sign: signGroup };
}

/**
 * Lounge bar against the far wall, behind the main court's far glass: a long counter with a warm
 * under-glow, a back bar with shelves of bottles, pendant lamps and stools.
 */
function buildLounge(group, mats) {
  const z0 = HALL.zMin;
  const parts = [], glow = [];
  const wood = new THREE.Color(0x4a3222), stone = new THREE.Color(0xd9d4cc), dark = new THREE.Color(0x16181c), steel = new THREE.Color(0x8a9099);
  parts.push(tint(boxAt(9, 1.05, 0.62, 0, 0.525, z0 + 2.4), wood));
  parts.push(tint(boxAt(9.2, 0.05, 0.75, 0, 1.075, z0 + 2.4), stone));
  parts.push(tint(boxAt(9.6, 2.2, 0.35, 0, 1.6, z0 + 0.2), dark));
  for (const y of [1.25, 1.75, 2.25]) parts.push(tint(boxAt(9.4, 0.035, 0.32, 0, y, z0 + 0.4), wood));
  const rng = seeded(17);
  const bottleCols = [0x2f6b3d, 0x7a4b22, 0xd9c48a, 0x1d3a5a, 0x8c2a2a, 0xe8e2d4];
  for (const y of [1.25, 1.75, 2.25]) {
    for (let x = -4.5; x < 4.5; x += 0.16 + rng() * 0.08) {
      const h = 0.18 + rng() * 0.14;
      const b = new THREE.CylinderGeometry(0.03, 0.035, h, 8);
      b.translate(x, y + 0.02 + h / 2, z0 + 0.42 + (rng() - 0.5) * 0.08);
      parts.push(tint(b, new THREE.Color(bottleCols[Math.floor(rng() * bottleCols.length)])));
    }
  }
  for (let x = -3.6; x <= 3.6; x += 1.2) {
    const s = new THREE.CylinderGeometry(0.19, 0.19, 0.05, 16);
    s.translate(x, 0.78, z0 + 3.05);
    parts.push(tint(s, dark));
    const leg = new THREE.CylinderGeometry(0.025, 0.025, 0.76, 8);
    leg.translate(x, 0.38, z0 + 3.05);
    parts.push(tint(leg, steel));
  }
  // Warm glow: strip under the counter overhang, shelf back-lights, pendant shades.
  glow.push(tint(boxAt(8.8, 0.02, 0.03, 0, 0.98, z0 + 2.75), new THREE.Color(1.0, 0.62, 0.3).multiplyScalar(4)));
  for (const y of [1.27, 1.77, 2.27]) glow.push(tint(boxAt(9.3, 0.012, 0.02, 0, y + 0.03, z0 + 0.27), new THREE.Color(1.0, 0.72, 0.42).multiplyScalar(2.2)));
  for (let x = -3.6; x <= 3.6; x += 1.8) {
    const shade = new THREE.CylinderGeometry(0.1, 0.18, 0.22, 16, 1, true);
    shade.translate(x, 2.55, z0 + 2.4);
    parts.push(tint(shade, dark));
    const bulb = new THREE.SphereGeometry(0.06, 12, 8);
    bulb.translate(x, 2.46, z0 + 2.4);
    glow.push(tint(bulb, new THREE.Color(1.0, 0.7, 0.4).multiplyScalar(9)));
    const cord = boxAt(0.008, 2.3, 0.008, x, 3.8, z0 + 2.4);
    parts.push(tint(cord, dark));
  }
  const m = new THREE.Mesh(merge(parts), mats.props);
  m.castShadow = false;
  m.receiveShadow = true;
  m.name = 'lounge';
  group.add(m);
  const g = new THREE.Mesh(merge(glow), mats.warm);
  g.name = 'lounge-glow';
  group.add(g);
  // Warm light pool on the counter / floor (no shadows).
  const p = new THREE.PointLight(0xffb070, 6, 7, 2);
  p.position.set(0, 2.3, z0 + 2.2);
  group.add(p);
  return p;
}

/** Soft rounded box (bags, cushions): segments 1, radius r. */
function soft(w, h, d, r, x, y, z, rotY = 0) {
  const g = new RoundedBoxGeometry(w, h, d, 1, Math.min(r, w * 0.45, h * 0.45, d * 0.45));
  if (rotY) g.rotateY(rotY);
  g.translate(x, y, z);
  return g;
}

/**
 * Club life around the courts (round 6 set dressing, one merged draw call): racket bags, ball tubes,
 * towels and water bottles on the benches and the floor, a ball cart by the near corner, a lounge
 * corner with sofas and plants by the bar, acoustic wall panels and a match clock.
 */
function buildDressing(group, mats) {
  const p = [];
  const rng = seeded(4711);
  const C = (h) => new THREE.Color(h);
  const bagCols = [[0x16181d, 0xe8572a], [0x1d2b4a, 0xeef1f4], [0xd9f03a, 0x16181d], [0xc8263c, 0x16181d], [0xeef1f4, 0x1d2b4a]];
  const SEAT_Y = 0.47;
  const racketBag = (x, y, z, rotY, k) => {
    const [a, b] = bagCols[k % bagCols.length];
    p.push(tint(soft(0.78, 0.3, 0.32, 0.08, x, y + 0.15, z, rotY), C(a)));
    // Contrast band and the zip strip.
    p.push(tint(soft(0.8, 0.07, 0.33, 0.03, x, y + 0.2, z, rotY), C(b)));
  };
  const tube = (x, y, z, lying = false) => {
    const t = new THREE.CylinderGeometry(0.038, 0.038, 0.24, 14);
    const cap = new THREE.CylinderGeometry(0.04, 0.04, 0.025, 14);
    cap.translate(0, 0.13, 0);
    if (lying) { t.rotateZ(Math.PI / 2); cap.rotateZ(Math.PI / 2); }
    t.translate(x, y + (lying ? 0.038 : 0.12), z);
    cap.translate(x, y + (lying ? 0.038 : 0.12), z);
    p.push(tint(t, C(0xd8dde2)), tint(cap, C(0xd9f03a)));
  };
  const bottle = (x, y, z, col) => {
    const b = new THREE.CylinderGeometry(0.034, 0.036, 0.21, 12);
    b.translate(x, y + 0.105, z);
    const c = new THREE.CylinderGeometry(0.018, 0.022, 0.035, 10);
    c.translate(x, y + 0.228, z);
    p.push(tint(b, C(col)), tint(c, C(0x16181d)));
  };
  const towel = (x, z, col, side = 1) => {
    // Folded on the seat, one end hanging over the front edge.
    p.push(tint(boxAt(0.3, 0.018, 0.42, x, SEAT_Y + 0.009, z), C(col)));
    p.push(tint(boxAt(0.016, 0.24, 0.42, x + side * 0.205, SEAT_Y - 0.11, z), C(col)));
  };
  // Benches at x = ±6.6 between the courts (seat z ±[0.5, 2.3]); people sit at a few places.
  for (const cx of [-6.6, 6.6, -19.4, 19.4]) {
    const s = Math.sign(cx);
    racketBag(cx + s * 0.62, 0, -1.3 + rng() * 0.4, Math.PI / 2 + (rng() - 0.5) * 0.3, (rng() * 5) | 0);
    tube(cx - 0.08, SEAT_Y, cx < 0 ? 2.05 : -0.75);
    tube(cx + 0.06, SEAT_Y, cx < 0 ? 2.12 : -0.68, true);
    bottle(cx + s * 0.35, 0, 0.35 + rng() * 0.2, 0x2a8fd8);
    bottle(cx + s * 0.4, 0, 0.55 + rng() * 0.2, 0xeef1f4);
    towel(cx, cx < 0 ? 1.65 : -2.0, [0xeef1f4, 0xe8572a, 0x5fd8ff][(rng() * 3) | 0], -s);
  }
  // Floor kit by the near-right corner, outside the court: bags, a ball cart, a tube pile.
  racketBag(6.0, 0, 11.0, 0.3, 0);
  racketBag(6.15, 0, 11.6, -0.2, 2);
  {
    const cx = -6.2, cz = 11.2;
    for (const [dx, dz] of [[-0.22, -0.22], [0.22, -0.22], [-0.22, 0.22], [0.22, 0.22]]) {
      p.push(tint(new THREE.CylinderGeometry(0.012, 0.012, 0.95, 6).translate(cx + dx, 0.475, cz + dz), C(0x9aa0a8)));
    }
    const basket = new THREE.CylinderGeometry(0.3, 0.26, 0.42, 16, 1, true);
    basket.translate(cx, 0.78, cz);
    p.push(tint(basket, C(0x2b2f36)));
    // Ball heap in the basket.
    for (let i = 0; i < 26; i++) {
      const b = new THREE.SphereGeometry(0.033, 8, 6);
      const a = rng() * Math.PI * 2, r = Math.sqrt(rng()) * 0.24;
      b.translate(cx + Math.cos(a) * r, 0.92 + rng() * 0.08, cz + Math.sin(a) * r);
      p.push(tint(b, C(0xd9f03a)));
    }
    for (let i = 0; i < 4; i++) tube(cx + 0.6 + i * 0.09, 0, cz - 0.4, i % 2 === 1);
  }
  // Lounge corner beside the bar: two sofas, a low table, plants.
  const z0 = HALL.zMin;
  for (const [x, rot] of [[-7.4, 0], [7.4, 0]]) {
    p.push(tint(soft(2.2, 0.42, 0.9, 0.12, x, 0.21, z0 + 3.4, rot), C(0x2b2f36)));
    p.push(tint(soft(2.2, 0.5, 0.22, 0.1, x, 0.6, z0 + 3.0, rot), C(0x2b2f36)));
    for (const dx of [-0.55, 0.55]) p.push(tint(soft(1.0, 0.12, 0.7, 0.05, x + dx, 0.47, z0 + 3.45, rot), C(0x3b4250)));
    p.push(tint(soft(1.1, 0.06, 0.6, 0.02, x, 0.38, z0 + 4.5), C(0x6b4a32)));
    for (const dx of [-1.6, 1.6]) {
      const pot = new THREE.CylinderGeometry(0.22, 0.17, 0.45, 16);
      pot.translate(x + dx, 0.225, z0 + 3.0);
      p.push(tint(pot, C(0xd9d4cc)));
      for (let k = 0; k < 9; k++) {
        const leaf = new THREE.IcosahedronGeometry(0.16 + rng() * 0.08, 0);
        leaf.translate(x + dx + (rng() - 0.5) * 0.35, 0.65 + rng() * 0.75, z0 + 3.0 + (rng() - 0.5) * 0.35);
        p.push(tint(leaf, C(rng() < 0.5 ? 0x2f5a2a : 0x3c6e33)));
      }
    }
  }
  // Acoustic felt panels on the long walls (club colours, muted) and a match clock on the far wall.
  const panelCols = [0x16203a, 0x22262c, 0x16203a, 0x2a2220];
  for (const sx of [-1, 1]) {
    for (let z = -12; z <= 12; z += 4) {
      p.push(tint(boxAt(0.04, 1.2, 2.4, sx * (HALL.xMax - 0.03), 4.2, z), C(panelCols[((z + 12) / 4 + (sx > 0 ? 1 : 0)) % panelCols.length])));
    }
  }
  p.push(tint(boxAt(1.3, 0.5, 0.08, 7.5, 6.4, z0 + 0.06), C(0x0a0b0d)));
  const m = new THREE.Mesh(merge(p), mats.props);
  m.castShadow = true;
  m.receiveShadow = true;
  m.name = 'club-dressing';
  group.add(m);
  // The clock's digits: a small emissive strip (warm red LED).
  const digits = new THREE.Mesh(boxAt(1.1, 0.28, 0.01, 7.5, 6.4, z0 + 0.105), new THREE.MeshBasicMaterial({ color: new THREE.Color(1.0, 0.18, 0.08).multiplyScalar(2.2) }));
  digits.name = 'club-clock';
  group.add(digits);
}

function buildLights(group, mats, q, courtXs) {
  const lights = { keys: [], fills: [], neighbors: [], hemi: null, sun: null, all: [] };
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
    for (const z of [-5.1, 5.1]) {
      const hb = new THREE.CylinderGeometry(0.28, 0.34, 0.16, 32);
      hb.translate(cx, fixY + 0.25, z);
      housings.push(hb);
      const disc = new THREE.CircleGeometry(0.29, 32);
      disc.rotateX(Math.PI / 2);
      disc.translate(cx, fixY + 0.165, z);
      diffusers.push(disc);
    }
  }
  housing.dispose();
  diffuser.dispose();
  group.add(new THREE.Mesh(merge(housings), mats.housing));
  const ledMesh = new THREE.Mesh(merge(diffusers), mats.led);
  ledMesh.name = 'led-panels';
  group.add(ledMesh);
  group.add(new THREE.Mesh(merge(cables), mats.housing));

  const mkSpot = (intensity, x, y, z, tx, ty, tz, angle, penumbra, shadow) => {
    const s = new THREE.SpotLight(LED_WHITE, intensity, 0, angle, penumbra, 2);
    s.position.set(x, y, z);
    s.target.position.set(tx, ty, tz);
    group.add(s, s.target);
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
  // Round 5 (QA r5 presence): with both shadow keys overhead in front of a player at the baseline,
  // their own shadow fell behind them and was never seen. The near half's shadows now come from a
  // wall floodlight behind the near back glass, so the player's full-body shadow (and the racket's)
  // falls forward onto the court in view; the near overhead key lights without shadows (still two
  // shadow-casting lights).
  for (const z of [-5.1, 5.1]) lights.keys.push(mkSpot(LIGHT.key, 0, fixY + 0.15, z, 0, 0, z, 0.98, 0.55, z < 0));
  const back = mkSpot(LIGHT.back, 0, 6.4, HALL.zMax - 2.1, 0, 0, 3.5, 0.62, 0.65, true);
  back.name = 'near-back-flood';
  back.shadow.camera.far = 32;
  lights.keys.push(back);
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
  lights.hemi.userData.baseIntensity = LIGHT.hemi;
  group.add(lights.hemi);
  lights.all.push(lights.hemi);
  return lights;
}

/** A few club members watching: on the benches between the courts and at the lounge bar. */
function buildSpectators(q, haze) {
  const rng = seeded(303);
  const people = [];
  const add = (x, y, z, seated, extra = {}) => people.push({ x, y, z, seated, ...randomLook(rng), lit: 0.9, ...extra });
  add(-6.6, 0, -1.9, true); add(-6.6, 0, -1.2, true); add(-6.6, 0, 1.0, true);
  add(6.6, 0, 1.7, true); add(6.6, 0, -1.6, true);
  add(-19.4, 0, 1.2, true);
  add(-2.6, 0, HALL.zMin + 3.0, false, { lit: 0.75 }); add(-1.9, 0, HALL.zMin + 3.15, false, { lit: 0.75 });
  add(1.4, 0, HALL.zMin + 3.05, false, { lit: 0.75 }); add(3.3, 0, HALL.zMin + 2.95, false, { lit: 0.75 });
  add(-7.4, 0, 12.6, false); add(-6.9, 0, 12.9, false);
  return createCrowd({
    people, msaa: q.msaa > 0, name: 'club-spectators', light: 0xfff2e6, lightK: 1.25,
    keyDir: { x: 0.1, y: 1, z: 0.35 }, key: 0.75, sky: 0xc9ccd2, ground: 0x46556e, hemiK: 0.45, haze,
  });
}

/**
 * @param {{ scene, renderer, mats, q, courtXs }} ctx
 */
export function buildClub(ctx) {
  const { mats: courtMats, q, courtXs } = ctx;
  const group = new THREE.Group();
  group.name = 'venue-club';
  const mats = makeHallMaterials();
  const hall = buildHall(group, mats, courtMats, courtXs);
  buildLounge(group, mats);
  buildDressing(group, mats);
  const lights = buildLights(group, mats, q, courtXs);
  // A faint hall haze (lit air between the courts): depth for the far wall and the bar.
  const haze = { color: new THREE.Color(0x30343b), density: 0.0105 };
  if (ctx.scene) ctx.scene.fog = new THREE.FogExp2(haze.color, haze.density);
  const crowd = buildSpectators(q, haze);
  group.add(crowd.mesh);
  return {
    group,
    lights,
    sign: hall.sign,
    crowd,
    courts: courtXs.length,
    envIntensity: LIGHT.env,
    // Image-based light (render/ibl.js): the warehouse panorama's strip lights, walls and concrete
    // floor fill the hall's ambient and texture the reflections in the glass and steel.
    ibl: { ambient: [1, 1.3], reflect: [1, 0.5] },
    // The hall's interior for box-projected reflections in the glass (environment.js).
    reflectBox: { min: new THREE.Vector3(HALL.xMin, -0.05, HALL.zMin), max: new THREE.Vector3(HALL.xMax, HALL.height, HALL.zMax) },
    turf: { dust: 0, wear: 1, grain: 0.1, ao: 1 },
    glass: { grease: 1, felt: 1, water: 0 },
    capture: {
      ambient() { mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE_ENV); crowd.mesh.visible = false; },
      reflect() { mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE_REFLECT); },
      restore() { mats.led.color.copy(LED_WHITE).multiplyScalar(LED_RADIANCE); crowd.mesh.visible = true; },
    },
    react(kind, level) {
      crowd.react(kind, level * 0.8);
    },
    update(dt, time) {
      crowd.update(dt, time);
    },
    dispose() {
      crowd.dispose();
      if (ctx.scene && ctx.scene.fog) ctx.scene.fog = null;
      disposeTree(group, { keep: keepSet(courtMats) });
    },
  };
}
