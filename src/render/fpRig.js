// First-person arms, hands and racket, driven by world.player (court frame).
// The racket's world transform equals player.racket exactly; the dominant hand is attached
// to the racket with a canonical grip (see handPose.GRIP), fingers wrapped around the handle.
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import { buildRacket } from './racket.js';
import { RACKET } from '../config.js';
import {
  ARM_RADIUS, ALONG_CUT, segmentAlpha, stubStart, stubRaiseFactor, besideEyeFactor, sideOnAlpha,
  alongCutStart, alongCutHide, nearCutDepths, stubShown, FOREARM_MAX_RATIO,
} from './armFade.js';
import { createRacketTrail } from './racketTrail.js';
import { racketEnclosureShift } from './viewClamp.js';
import { isFiniteVec, frameOk, segmentOk } from './safeView.js';
import { createSkinMaterial, createFabricMaterial, limbGeometry, quatFromYZ, canvasTexture, cached } from './actorKit.js';
import {
  RIGHT_BIND, analyzeBind, poseHand, handleInArmature, handInRacketMatrix, chainNames,
  cradleInRacketMatrix, cradleHandleInArmature, blendPoses,
} from './handPose.js';

const UP = new THREE.Vector3(0, 1, 0);
const UPPER_ARM = 0.3;
const FOREARM = 0.265;

// ------------------------------------------------------------ hand models

/** Wraps a loaded GLB hand: bones by name, bind data, canonical frame, skinned mesh. */
function glbHand(gltf, handed, skinMat) {
  const scene = gltf.scene;
  const bones = {};
  let mesh = null;
  scene.traverse((o) => {
    if (o.isBone) bones[o.name] = o;
    if (o.isSkinnedMesh) mesh = o;
  });
  if (!mesh || !bones.wrist) throw new Error('hand glb: missing skin');
  const bind = {};
  for (const [name, b] of Object.entries(bones)) bind[name] = { pos: b.position.clone(), quat: b.quaternion.clone() };
  mesh.material = skinMat;
  mesh.frustumCulled = false;
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  const frame = analyzeBind(bind, handed);
  // Place the GLB so canonical hand space = holder space.
  scene.matrixAutoUpdate = false;
  scene.matrix.copy(frame.toCanon);
  scene.matrixWorldNeedsUpdate = true;
  return {
    object: scene,
    bind,
    frame,
    apply(pose) {
      for (const [name, t] of Object.entries(pose)) {
        const b = bones[name];
        if (!b) continue;
        b.position.copy(t.pos);
        b.quaternion.copy(t.quat);
      }
    },
  };
}

/** Procedural capsule hand sharing the GLB bind data (used until / unless the GLB loads). */
function proceduralHand(handed, skinMat) {
  const sx = handed === 'left' ? -1 : 1;
  const bind = {};
  for (const [name, p] of Object.entries(RIGHT_BIND)) {
    bind[name] = { pos: new THREE.Vector3(p[0] * sx, p[1], p[2]), quat: new THREE.Quaternion() };
  }
  const frame = analyzeBind(bind, handed);
  const root = new THREE.Group();
  const inner = new THREE.Group();
  inner.matrixAutoUpdate = false;
  inner.matrix.copy(frame.toCanon);
  root.add(inner);
  const segs = [];
  const chains = chainNames();
  const radius = { thumb: 0.0105, index: 0.0088, middle: 0.0092, ring: 0.0086, pinky: 0.0076 };
  const unit = new THREE.CapsuleGeometry(1, 1, 4, 10);
  for (const [finger, names] of Object.entries(chains)) {
    for (let i = finger === 'thumb' ? 0 : 1; i < names.length - 1; i++) {
      const m = new THREE.Mesh(unit, skinMat);
      m.castShadow = true;
      m.userData = { a: names[i], b: names[i + 1], r: radius[finger] * (1 - 0.08 * i) };
      inner.add(m);
      segs.push(m);
    }
  }
  // Palm: a flattened rounded box between wrist and knuckles.
  const palm = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 14), skinMat);
  palm.castShadow = true;
  inner.add(palm);
  const apply = (pose) => {
    for (const m of segs) {
      const a = pose[m.userData.a].pos, b = pose[m.userData.b].pos;
      const len = a.distanceTo(b);
      m.position.lerpVectors(a, b, 0.5);
      m.quaternion.setFromUnitVectors(UP, _t1.subVectors(b, a).normalize());
      m.scale.set(m.userData.r, Math.max(0.001, len * 0.5), m.userData.r);
    }
    const w = pose.wrist.pos;
    const k = _t2.copy(pose['middle-finger-phalanx-proximal'].pos).add(pose['ring-finger-phalanx-proximal'].pos).multiplyScalar(0.5);
    palm.position.lerpVectors(w, k, 0.55);
    palm.quaternion.copy(quatFromYZ(_t1.subVectors(k, w), frame.normal));
    palm.scale.set(0.043, 0.05, 0.016);
  };
  return { object: root, bind, frame, apply, procedural: true };
}

const _t1 = new THREE.Vector3();
const _t2 = new THREE.Vector3();

let handsPromise = null;
function loadHandGltfs() {
  if (!handsPromise) {
    const loader = new GLTFLoader();
    const url = (s) => new URL(`../../assets/hands/${s}.glb`, import.meta.url).href;
    handsPromise = Promise.all([loader.loadAsync(url('left')), loader.loadAsync(url('right'))])
      .then(([left, right]) => ({ left, right }));
  }
  return handsPromise;
}

// ------------------------------------------------------------ arm meshes

function sweatbandTexture() {
  return cached('sweatbandTex', () => canvasTexture(64, 64, (ctx, w, h) => {
    ctx.fillStyle = '#ecebe6';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#1d2b4a';
    ctx.fillRect(0, h * 0.44, w, h * 0.12);
    for (let i = 0; i < 400; i++) { // terry loops
      ctx.fillStyle = `rgba(0,0,0,${Math.random() * 0.06})`;
      ctx.fillRect(Math.random() * w, Math.random() * h, 2, 2);
    }
  }, { repeat: true }));
}

function buildArm(skinMat, sleeveMat, bandMat, foreSkinMat = skinMat) {
  const group = new THREE.Group();
  // Upper arm along -Y from the shoulder, nominal length UPPER_ARM.
  const upper = new THREE.Group();
  const upperSkin = new THREE.Mesh(limbGeometry(UPPER_ARM, [[0, 0.05], [0.35, 0.05], [0.65, 0.046], [1, 0.041]], { flatten: 0.9 }), skinMat);
  const sleeve = new THREE.Mesh(limbGeometry(0.17, [[0, 0.066], [0.6, 0.064], [1, 0.062]], { flatten: 0.92 }), sleeveMat);
  sleeve.position.y = 0.01;
  const hem = new THREE.Mesh(new THREE.TorusGeometry(0.061, 0.005, 8, 32), sleeveMat);
  hem.rotation.x = Math.PI / 2;
  hem.scale.set(1, 0.92, 1);
  hem.position.y = -0.165;
  upper.add(upperSkin, sleeve, hem);
  // Forearm: elbow -> wrist along -Y; cross-section wider across the radius/ulna.
  const fore = new THREE.Group();
  const foreSkin = new THREE.Mesh(limbGeometry(FOREARM, [[0, 0.04], [0.18, 0.044], [0.45, 0.038], [0.8, 0.028], [1, 0.0255]], { flatten: 0.78 }), foreSkinMat);
  const band = new THREE.Mesh(limbGeometry(0.058, [[0, 0.0285], [0.12, 0.0297], [0.88, 0.0293], [1, 0.0282]], { capSegments: 1, flatten: 0.8 }), bandMat);
  fore.add(foreSkin, band);
  group.add(upper, fore);
  group.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return {
    group, upper, upperSkin, sleeve, hem, fore, foreSkin, band,
    mats: { upper: [skinMat], fore: [foreSkinMat], band: [bandMat] }, alpha: { upper: 1, fore: 1, band: 1 },
    // Round 5 cut state: the stub is drawn or not (hysteresis), the forearm's cut start eases.
    stubOn: false, cut: NaN,
  };
}

/** Per-segment opacity (materials are per arm segment; all are transparent for the near fade). */
function setSegmentAlpha(arm, key, a) {
  const prev = arm.alpha[key];
  if (Math.abs(prev - a) < 0.01 && (a >= 1) === (prev >= 1)) return;
  arm.alpha[key] = a;
  for (const m of arm.mats[key]) {
    if (m.userData.baseOpacity === undefined) m.userData.baseOpacity = m.opacity;
    m.depthWrite = a >= 0.999;
    m.opacity = m.userData.baseOpacity * a;
  }
}

/**
 * Per-fragment cut by view depth (QA2: limbs near the camera filled 20-25% of the picture; QA r5:
 * the old wide smooth fade drew a translucent disc): a limb of `radius` is solid beyond
 * armFade.nearCutDepths(radius).far from the camera plane and gone at .near, a 3 cm band, so the part
 * of a forearm reaching toward the lens ends at a clean cut while the hand end stays solid (VR
 * style). Planar depth, so a limb in a corner of the wide frustum, drawn larger than its visual
 * angle, is cut sooner.
 */
function addNearFade(m, radius, { along = 0 } = {}) {
  const cut = nearCutDepths(radius);
  const near = cut.near.toFixed(4), far = cut.far.toFixed(4);
  const prev = m.onBeforeCompile;
  // Along-the-limb cut (forearms): uAlong = cut start c (armFade.alongCutStart); t = -position.y /
  // length (0 at the elbow end, 1 at the wrist) in the limb's own geometry units; alpha =
  // smoothstep(c, c + ALONG_CUT.band, t). c = -band draws the whole forearm.
  if (along > 0) m.userData.along = { value: -ALONG_CUT.band };
  m.onBeforeCompile = (shader, renderer) => {
    if (prev) prev.call(m, shader, renderer);
    let alongCode = '';
    if (along > 0) {
      shader.uniforms.uAlong = m.userData.along;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vLimbT;')
        .replace('#include <begin_vertex>', `#include <begin_vertex>\n\tvLimbT = clamp(-position.y / ${along.toFixed(4)}, 0.0, 1.0);`);
      shader.fragmentShader = shader.fragmentShader.replace('#include <common>', '#include <common>\nvarying float vLimbT;\nuniform float uAlong;');
      alongCode = `\n\tgl_FragColor.a *= smoothstep(uAlong, uAlong + ${ALONG_CUT.band.toFixed(3)}, vLimbT);`;
    }
    shader.fragmentShader = shader.fragmentShader.replace(
      '#include <dithering_fragment>',
      `#include <dithering_fragment>\n\tgl_FragColor.a *= smoothstep(${near}, ${far}, vViewPosition.z); // vViewPosition = -mvPosition: z is the depth${alongCode}`,
    );
  };
  const key = m.customProgramCacheKey ? m.customProgramCacheKey.call(m) : '';
  m.customProgramCacheKey = () => `${key}|nearcut-${near}-${far}${along > 0 ? `|alongcut-${along}` : ''}`;
  m.transparent = true;
  return m;
}



/**
 * Orients an arm segment group (built along -Y) from a to b; zHint sets its twist. Returns the
 * length, or 0 for a degenerate segment (non-finite or shorter than 1 mm): the caller hides it.
 * A zero-length segment scaled to 0 has a singular matrix whose NaN normals blacked out the whole
 * picture through the bloom (real-world session, side-on play: the hidden arm collapses).
 */
function placeSegment(seg, a, b, zHint, nominal, skinMesh) {
  if (!isFiniteVec(a) || !isFiniteVec(b)) return 0;
  const len = a.distanceTo(b);
  if (!(len > 1e-3)) return 0;
  seg.position.copy(a);
  _t1.subVectors(a, b).multiplyScalar(1 / len); // local +Y points back toward the segment origin
  if (!safeQuatFromYZ(_t1, zHint, seg.quaternion)) return 0;
  if (skinMesh) skinMesh.scale.y = len / nominal;
  return len;
}

/** quatFromYZ that leaves `out` untouched (returns false) for a zero / non-finite axis or hint. */
function safeQuatFromYZ(y, zHint, out) {
  if (!isFiniteVec(y) || !(y.lengthSq() > 1e-12)) return false;
  _sq.copy(out);
  quatFromYZ(y, isFiniteVec(zHint) ? zHint : _zFallback, out);
  if (!(Number.isFinite(out.x) && Number.isFinite(out.y) && Number.isFinite(out.z) && Number.isFinite(out.w)) || Math.abs(out.lengthSq() - 1) > 1e-3) {
    out.copy(_sq);
    return false;
  }
  return true;
}
const _sq = new THREE.Quaternion();
const _zFallback = new THREE.Vector3(0, 0, 1);

/** Two-bone IK: elbow position for shoulder S, wrist T and a pole direction. */
export function solveElbow(S, T, l1, l2, pole, out = new THREE.Vector3()) {
  const d = _ik1.subVectors(T, S);
  const dist = THREE.MathUtils.clamp(d.length(), Math.abs(l1 - l2) + 1e-3, l1 + l2 - 1e-3);
  d.normalize();
  const a = Math.acos(THREE.MathUtils.clamp((l1 * l1 + dist * dist - l2 * l2) / (2 * l1 * dist), -1, 1));
  const perp = _ik2.copy(pole).addScaledVector(d, -pole.dot(d)).normalize();
  return out.copy(S).addScaledVector(d, Math.cos(a) * l1).addScaledVector(perp, Math.sin(a) * l1);
}
const _ik1 = new THREE.Vector3();
const _ik2 = new THREE.Vector3();

// Integration (main.js): near-eye culling. In a follow-through the racket crosses right in front
// of the eye and would fill the screen; like a VR rig, it is hidden closer than NEAR_RACKET to
// renderOpts.eye / eye2. Arm segments fade by angular size instead (armFade.js).
const NEAR_RACKET = 0.2;
/** Racket face near the view centre (cos of the angle from the view axis) and closer than `far` (m) fades to `min`. */
const CENTRE_FADE = Object.freeze({ cosOuter: Math.cos((38 * Math.PI) / 180), cosInner: Math.cos((14 * Math.PI) / 180), near: 0.32, far: 0.58, min: 0.3 });
/** Torso yaw (rad, shoulder line vs the court x axis) beyond which arms fade by their nearest point. */
const SIDE_ON_FADE = (45 * Math.PI) / 180;
// QA framing pass: the racket head fades out between these distances (face centre to eye),
// unless the ball is near the racket (then it must stay solid: that is the contact).
const FADE_RACKET_FAR = 0.35;
const FADE_BALL_NEAR = 0.7;
const _sd = new THREE.Vector3();
/** Distance of segment a-b to the nearer of the rendered viewpoint and the tracked eye. */
function eyeDistance(o, a, b) {
  const d = segmentDistance(o.eye, a, b);
  return o.eye2 ? Math.min(d, segmentDistance(o.eye2, a, b)) : d;
}
function segmentDistance(p, a, b) {
  const ab = _sd.subVectors(b, a);
  const l2 = ab.lengthSq();
  const u = l2 > 1e-9 ? THREE.MathUtils.clamp((p.x - a.x) * ab.x + (p.y - a.y) * ab.y + (p.z - a.z) * ab.z, 0, l2) / l2 : 0;
  return Math.hypot(a.x + ab.x * u - p.x, a.y + ab.y * u - p.y, a.z + ab.z * u - p.z);
}

// ------------------------------------------------------------ rig

/**
 * @returns {{ root: THREE.Group, update(player, dt, renderOpts?), setHanded(h), setSkin(c), setSleeve(c), racketMesh: THREE.Group, ready: Promise<boolean> }}
 * renderOpts: { extrapolate?: seconds (<= 0.06), visible?: boolean }
 */
export function createFirstPersonRig({ handed = 'right', skinTone = '#c58c6a', sleeveColor = '#1d2b4a', racket = null } = {}) {
  const root = new THREE.Group();
  root.name = 'fp-rig';
  const skinMat = createSkinMaterial(skinTone);
  const sleeveMat = createFabricMaterial(sleeveColor);
  const bandMat = new THREE.MeshPhysicalMaterial({
    map: sweatbandTexture(), roughness: 0.95, sheen: 0.8, sheenRoughness: 0.8, sheenColor: new THREE.Color('#ffffff'),
  });
  const racketMesh = racket || buildRacket({ handed });
  racketMesh.userData.setHanded?.(handed);
  root.add(racketMesh);
  // Near-eye fade of the racket: its own materials (buildRacket makes them per racket).
  const racketMats = [];
  racketMesh.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
      if (!racketMats.some((r) => r.m === m)) racketMats.push({ m, opacity: m.opacity, transparent: m.transparent, depthWrite: m.depthWrite });
    }
  });
  let racketFade = 1;
  /** Robustness counters: racket poses that were not a valid frame, arm segments not drawn. */
  const stats = { racketRejected: 0, segmentsHidden: 0 };
  function setRacketFade(f) {
    if (Math.abs(f - racketFade) < 0.01 && (f === 1) === (racketFade === 1)) return;
    racketFade = f;
    for (const r of racketMats) {
      if (f >= 1) {
        r.m.opacity = r.opacity;
        r.m.transparent = r.transparent;
        r.m.depthWrite = r.depthWrite;
      } else {
        r.m.transparent = true;
        r.m.depthWrite = false;
        r.m.opacity = r.opacity * f;
      }
    }
  }

  // Arm segments fade by angular size, so each has its own materials (the hands keep skinMat).
  const skinMats = [skinMat];
  const armSkin = () => {
    const m = createSkinMaterial(skinTone);
    skinMats.push(m);
    return m;
  };

  const armSet = () => buildArm(addNearFade(armSkin(), ARM_RADIUS.upper), sleeveMat, addNearFade(bandMat.clone(), ARM_RADIUS.fore), addNearFade(armSkin(), ARM_RADIUS.fore, { along: FOREARM }));
  const arms = { L: armSet(), R: armSet() };
  // Motion-blur ribbon behind the racket head (racketTrail.js).
  const trail = createRacketTrail();
  root.add(trail.mesh);
  let trailT = NaN;
  const trailGrip = new THREE.Vector3();
  // First person: the upper arm is only a stub from the elbow (VR style), so no sleeve.
  for (const a of [arms.L, arms.R]) a.sleeve.visible = a.hem.visible = false;
  root.add(arms.L.group, arms.R.group);

  const holders = { L: new THREE.Group(), R: new THREE.Group() };
  root.add(holders.L, holders.R);
  const hands = { L: null, R: null };
  const poses = { L: null, R: null };
  let state = { handed };
  let usingGlb = false;
  let gltfs = null;

  const sideHanded = (side) => (side === 'L' ? 'left' : 'right');
  const dominantSide = () => (state.handed === 'left' ? 'L' : 'R');

  function installHand(side, model) {
    const h = holders[side];
    if (hands[side]) h.remove(hands[side].object);
    hands[side] = model;
    h.add(model.object);
    const dominant = side === dominantSide();
    if (dominant) {
      const pose = poseHand(model.bind, model.frame, { mode: 'grip', handle: handleInArmature(model.frame, sideHanded(side)) });
      model.apply(pose);
      poses[side] = pose;
      model.offPoses = null;
    } else {
      const relaxed = poseHand(model.bind, model.frame, { mode: 'relaxed' });
      const cradle = poseHand(model.bind, model.frame, {
        mode: 'grip', thumb: 'relaxed', handleRadius: RACKET.thickness / 2, handle: cradleHandleInArmature(model.frame, state.handed),
      });
      model.offPoses = { relaxed, cradle, blended: blendPoses(relaxed, relaxed, 0), w: 0 };
      model.apply(relaxed);
      poses[side] = relaxed;
    }
  }

  /** Blends the off hand's fingers between relaxed and cradling (only when it changes). */
  function applyOffBlend(side, w) {
    const op = hands[side]?.offPoses;
    if (!op || Math.abs(op.w - w) < 0.02) return;
    op.w = w;
    blendPoses(op.relaxed, op.cradle, w, op.blended);
    hands[side].apply(op.blended);
  }

  function installAll() {
    for (const side of ['L', 'R']) {
      let model = null;
      if (gltfs) {
        try {
          const src = side === 'L' ? gltfs.left : gltfs.right;
          model = glbHand({ scene: cloneSkinned(src.scene) }, sideHanded(side), skinMat);
          usingGlb = true;
        } catch {
          model = null;
        }
      }
      installHand(side, model || proceduralHand(sideHanded(side), skinMat));
    }
  }
  installAll();

  const ready = loadHandGltfs().then((g) => {
    gltfs = g;
    installAll();
    return usingGlb;
  }).catch(() => false);

  // Canonical hand-in-racket transform for the dominant hand, and the off-hand cradle.
  let handInRacket = handInRacketMatrix(state.handed);
  let cradleInRacket = cradleInRacketMatrix(state.handed);
  let cradleW = 0;
  const throatLocal = new THREE.Vector3(0, 0.1, 0);
  const vThroat = new THREE.Vector3();
  const mCradle = new THREE.Matrix4();
  const pCradle = new THREE.Vector3();
  const qCradle = new THREE.Quaternion();

  // Scratch
  const mRacket = new THREE.Matrix4();
  const mHand = new THREE.Matrix4();
  const vGrip = new THREE.Vector3();
  const vAxis = new THREE.Vector3();
  const vNorm = new THREE.Vector3();
  const vScale = new THREE.Vector3(1, 1, 1);
  const qRacket = new THREE.Quaternion();
  const wristVis = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const palmN = { L: new THREE.Vector3(), R: new THREE.Vector3() };
  const shoulder = new THREE.Vector3();
  const elbow = new THREE.Vector3();
  const fwd = new THREE.Vector3();
  const right = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3();
  const qTmp = new THREE.Quaternion();
  const stubA = new THREE.Vector3();
  const eyes = [null, null];

  function racketPoseFrom(player) {
    if (player.racket) return player.racket;
    const bc = player.bodyCourt;
    const hf = bc?.handFrames?.[bc.dominant || dominantSide()];
    return hf || null;
  }

  function bodyFacing(player) {
    const j = player.bodyCourt?.joints;
    if (j?.shoulderL && j?.shoulderR) {
      right.set(j.shoulderR.x - j.shoulderL.x, 0, j.shoulderR.z - j.shoulderL.z);
      if (right.lengthSq() > 1e-4) {
        right.normalize();
        fwd.crossVectors(UP, right); // right = +x  =>  forward = -z
        return;
      }
    }
    right.set(1, 0, 0);
    fwd.set(0, 0, -1);
  }

  function update(player, dt = 0, renderOpts = {}) {
    if (!player || renderOpts.visible === false) {
      root.visible = false;
      return;
    }
    if ((player.handed === 'left' || player.handed === 'right') && player.handed !== state.handed) setHanded(player.handed);
    // A racket pose that is not a finite, orthogonal frame is not drawn (never a degenerate matrix).
    let rp = racketPoseFrom(player);
    if (rp && !frameOk(rp)) {
      rp = null;
      stats.racketRejected++;
    }
    const bc = player.bodyCourt;
    if (!rp && !bc) {
      root.visible = false;
      return;
    }
    root.visible = true;
    arms.L.group.visible = arms.R.group.visible = renderOpts.arms !== false;
    const scale = (player.height || 1.75) / 1.75;
    const ex = THREE.MathUtils.clamp(renderOpts.extrapolate || 0, 0, 0.06);
    bodyFacing(player);
    const sideOn = Math.abs(Math.atan2(right.z, right.x)) > SIDE_ON_FADE;
    const dom = dominantSide();
    const off = dom === 'R' ? 'L' : 'R';

    // --- racket (exact pose, optionally extrapolated for display)
    racketMesh.visible = !!rp;
    if (rp) {
      vGrip.set(rp.grip.x, rp.grip.y, rp.grip.z);
      vAxis.set(rp.axis.x, rp.axis.y, rp.axis.z);
      vNorm.set(rp.normal.x, rp.normal.y, rp.normal.z);
      if (ex > 0 && rp.vel) vGrip.add(tmp.set(rp.vel.x, rp.vel.y, rp.vel.z).multiplyScalar(ex));
      if (ex > 0 && rp.angVel) {
        tmp.set(rp.angVel.x, rp.angVel.y, rp.angVel.z);
        const w = tmp.length();
        if (w > 1e-6) {
          qTmp.setFromAxisAngle(tmp.normalize(), w * ex);
          vAxis.applyQuaternion(qTmp);
          vNorm.applyQuaternion(qTmp);
        }
      }
      // Never draw the racket through the glass (tracking noise, a backswing beside the glass).
      const sh = racketEnclosureShift(vGrip, vAxis, vNorm);
      vGrip.x += sh.dx;
      vGrip.z += sh.dz;
      if (!(Number.isFinite(sh.dx) && Number.isFinite(sh.dz))) vGrip.set(rp.grip.x, rp.grip.y, rp.grip.z);
      safeQuatFromYZ(vAxis, vNorm, qRacket);
      racketMesh.position.copy(vGrip);
      racketMesh.quaternion.copy(qRacket);
      racketMesh.updateMatrix();
      // Dominant hand rides on the racket.
      mRacket.compose(vGrip, qRacket, vScale);
      mHand.multiplyMatrices(mRacket, handInRacket);
      mHand.decompose(holders[dom].position, holders[dom].quaternion, tmp2);
      wristVis[dom].copy(holders[dom].position);
      palmN[dom].set(0, 0, 1).applyQuaternion(holders[dom].quaternion);
      holders[dom].visible = true;
      // Near-eye culling / fading of the racket (follow-through or a high ready position right in
      // front of the face would fill a third of the screen).
      const ce = renderOpts.eye;
      let fade = 1;
      if (ce) {
        tmp.copy(vGrip).addScaledVector(vAxis, RACKET.length + RACKET.buttY);
        const near = eyeDistance(renderOpts, vGrip, tmp) < NEAR_RACKET;
        racketMesh.visible = !near;
        holders[dom].visible = !near;
        tmp.copy(vGrip).addScaledVector(vAxis, RACKET.faceCenterY);
        const b = renderOpts.ball;
        const ballNear = b && Math.hypot(b.x - tmp.x, b.y - tmp.y, b.z - tmp.z) < FADE_BALL_NEAR;
        if (!ballNear) {
          const d = tmp.distanceTo(ce);
          fade = THREE.MathUtils.smoothstep(d, NEAR_RACKET, FADE_RACKET_FAR) * 0.85 + 0.15;
          // A dark racket face held across the line of sight half a metre away (side-on, a high
          // ready position) covers the middle of the picture: fade it when it sits near the
          // view centre, down to CENTRE_FADE.min opacity inside CENTRE_FADE.near.
          const vd = renderOpts.viewDir;
          if (vd && d > 1e-6) {
            const cosA = ((tmp.x - ce.x) * vd.x + (tmp.y - ce.y) * vd.y + (tmp.z - ce.z) * vd.z) / d;
            const central = THREE.MathUtils.smoothstep(cosA, CENTRE_FADE.cosOuter, CENTRE_FADE.cosInner);
            const far = THREE.MathUtils.smoothstep(d, CENTRE_FADE.near, CENTRE_FADE.far);
            fade = Math.min(fade, 1 - central * (1 - far) * (1 - CENTRE_FADE.min));
          }
        }
      }
      setRacketFade(fade);
      // The ribbon ages with the racket's own (sim) time: a frozen or paused frame keeps the sweep it
      // shows; a racket without a moving timestamp ages with the frame.
      const rt = rp.t;
      let tdt = dt;
      if (Number.isFinite(rt) && rt < trailT - 1) trailT = NaN; // a new world / replay clock
      if (Number.isFinite(rt) && Number.isFinite(trailT)) {
        if (rt > trailT) tdt = Math.min(0.1, rt - trailT);
        else if (rt < trailT) tdt = Math.min(dt, 1 / 60); // a pose from the past (the strike frame, a replay loop)
        else if (vGrip.distanceToSquared(trailGrip) < 1e-12) tdt = 0;
      }
      if (Number.isFinite(rt)) trailT = Number.isFinite(trailT) ? Math.max(trailT, rt) : rt;
      trailGrip.copy(vGrip);
      if (tdt > 0) trail.update(tdt, vGrip, vAxis, player.pos, { eye: renderOpts.eye || null, fade: racketMesh.visible ? fade : 0 });
    } else {
      trail.clear();
      trailT = NaN;
    }

    // --- joints (tracked, or synthesized for mouse/fallback control)
    const j = bc?.joints;
    const eye = player.eye && isFiniteVec(player.eye) ? player.eye : tmp.set(player.pos.x, (player.height || 1.75) * 0.936, player.pos.z);
    for (const side of ['L', 'R']) {
      const sgn = side === 'R' ? 1 : -1;
      const S = j?.[`shoulder${side}`];
      if (S && isFiniteVec(S)) shoulder.set(S.x, S.y, S.z);
      else shoulder.set(eye.x, eye.y - 0.21 * scale, eye.z).addScaledVector(right, 0.19 * scale * sgn).addScaledVector(fwd, -0.06);

      if (side === off || !rp) {
        // Off hand from its tracked joints (or a relaxed default when untracked).
        const W = j?.[`wrist${side}`];
        const I = j?.[`index${side}`];
        const P = j?.[`pinky${side}`];
        const holder = holders[side];
        if (W && I && P && isFiniteVec(W) && isFiniteVec(I) && isFiniteVec(P)) {
          wristVis[side].set(W.x, W.y, W.z);
          tmp.set((I.x + P.x) / 2 - W.x, (I.y + P.y) / 2 - W.y, (I.z + P.z) / 2 - W.z);
          // Collapsed hand landmarks (hidden hand): the hand continues the forearm.
          if (tmp.lengthSq() < 1e-6) {
            const Ej = j?.[`elbow${side}`];
            if (Ej && isFiniteVec(Ej)) tmp.set(W.x - Ej.x, W.y - Ej.y, W.z - Ej.z);
            if (tmp.lengthSq() < 1e-6) tmp.set(0, -0.6, 0).addScaledVector(fwd, 0.8);
          }
          tmp.normalize();
          // Palm normal from the knuckle triangle (right: (I-W)x(P-W), left: negated).
          tmp2.set(I.x - W.x, I.y - W.y, I.z - W.z).cross(_t2.set(P.x - W.x, P.y - W.y, P.z - W.z));
          if (side === 'L') tmp2.negate();
          if (tmp2.lengthSq() < 1e-8) {
            const hf = bc?.handFrames?.[side];
            if (hf) tmp2.set(hf.normal.x, hf.normal.y, hf.normal.z);
            else tmp2.copy(right).multiplyScalar(-sgn);
          }
          tmp2.normalize();
        } else {
          wristVis[side].copy(shoulder).addScaledVector(UP, -0.52 * scale).addScaledVector(fwd, 0.16).addScaledVector(right, 0.05 * sgn);
          tmp.set(0, -0.6, 0).addScaledVector(fwd, 0.8).normalize();
          tmp2.copy(right).multiplyScalar(-sgn);
        }
        holder.position.copy(wristVis[side]);
        holder.visible = safeQuatFromYZ(tmp, tmp2, holder.quaternion) || holder.userData.oriented === true;
        holder.userData.oriented = holder.userData.oriented || holder.visible;
        palmN[side].copy(tmp2);
        // Ready-position cradle: snap the off hand onto the throat when it is close.
        if (rp && side === off && renderOpts.cradle !== false) {
          vThroat.copy(throatLocal).applyMatrix4(mRacket);
          const palmC = _t1.copy(wristVis[side]).addScaledVector(tmp, 0.07);
          const want = 1 - THREE.MathUtils.smoothstep(palmC.distanceTo(vThroat), 0.1, 0.24);
          cradleW = dt > 0 ? cradleW + (want - cradleW) * (1 - Math.exp(-10 * dt)) : want;
          if (cradleW > 0.001) {
            mCradle.multiplyMatrices(mRacket, cradleInRacket);
            mCradle.decompose(pCradle, qCradle, tmp2);
            holder.position.lerp(pCradle, cradleW);
            holder.quaternion.slerp(qCradle, cradleW);
            wristVis[side].copy(holder.position);
            palmN[side].set(0, 0, 1).applyQuaternion(holder.quaternion);
          }
          applyOffBlend(side, cradleW);
        } else if (side === off) applyOffBlend(side, 0);
      }

      // Elbow: tracked, else IK with the elbow down/out/back.
      const E = j?.[`elbow${side}`];
      if (E && isFiniteVec(E)) {
        elbow.set(E.x, E.y, E.z);
        if (side === dom && rp && ex > 0 && rp.vel) elbow.addScaledVector(tmp.set(rp.vel.x, rp.vel.y, rp.vel.z), ex * 0.5);
      } else {
        tmp.set(0, -1, 0).addScaledVector(right, 0.55 * sgn).addScaledVector(fwd, -0.35).normalize();
        solveElbow(shoulder, wristVis[side], UPPER_ARM * scale, FOREARM * scale, tmp, elbow);
      }

      const arm = arms[side];
      tmp.copy(palmN[side]);
      // Side-on play collapses the hidden arm (elbow on the wrist or the shoulder): a segment of
      // implausible length is not drawn (a squashed capsule reads as a disc in front of the eyes,
      // and a zero-length one blacked out the whole picture).
      let foreOk = segmentOk(elbow, wristVis[side], FOREARM * scale);
      // A stretched tracked forearm (the off hand reaching while the elbow lags) is drawn at most
      // FOREARM_MAX_RATIO x its length from the wrist: never a long detached limb (QA r5).
      if (foreOk) {
        const maxLen = FOREARM * scale * FOREARM_MAX_RATIO;
        const len = elbow.distanceTo(wristVis[side]);
        if (len > maxLen) elbow.sub(wristVis[side]).multiplyScalar(maxLen / len).add(wristVis[side]);
      }
      foreOk = foreOk && placeSegment(arm.fore, elbow, wristVis[side], tmp, FOREARM, arm.foreSkin) > 0;
      // Sweatband at the wrist end (unscaled), slightly overlapping the hand.
      const foreLen = foreOk ? elbow.distanceTo(wristVis[side]) : FOREARM * scale;
      arm.band.position.y = -(foreLen - 0.05);
      // Upper arm: only a stub from the elbow (VR style); twist so the elbow crease faces forward-ish.
      tmp2.copy(fwd).addScaledVector(right, -0.3 * sgn);
      stubStart(shoulder, elbow, scale, stubA);
      const upperOk = segmentOk(shoulder, elbow, UPPER_ARM * scale) && placeSegment(arm.upper, stubA, elbow, tmp2, UPPER_ARM, arm.upperSkin) > 0;
      if (!foreOk || !upperOk) stats.segmentsHidden++;
      eyes[0] = renderOpts.eye || null;
      eyes[1] = renderOpts.eye2 || null;
      // Round 5 (QA r5 "ghost bulb"): nothing is drawn half transparent over a wide area. Each factor
      // below decides WHERE a limb is cut (armFade.js ALONG_CUT / NEAR_CUT), never a global opacity:
      // - the stub is drawn solid or not at all (stubShown: elbow well away from the eye, the view
      //   not pitched down at the body, the elbow not raised / beside the eye / side-on);
      // - the forearm keeps its elbow cap only while the stub is drawn; otherwise the cut hides the
      //   cap, slides toward the wrist as the elbow comes to the eye (a cuff at the hand) and on past
      //   the wrist as the wrist itself comes to the eye, beside it or folds across the chest.
      const trueEye = eyes[1] || eyes[0];
      let fU = stubRaiseFactor(shoulder, elbow, scale);
      let fF = 1;
      if (trueEye) {
        fU *= segmentAlpha(ARM_RADIUS.upper * scale, elbow, elbow, [trueEye]) * besideEyeFactor(stubA, elbow, trueEye, fwd);
        fF *= segmentAlpha(ARM_RADIUS.fore * scale, wristVis[side], wristVis[side], [trueEye]) * besideEyeFactor(elbow, wristVis[side], trueEye, fwd);
        if (sideOn) {
          fU *= sideOnAlpha(stubA, elbow, trueEye);
          fF *= sideOnAlpha(elbow, wristVis[side], trueEye);
        }
      }
      const elbowDist = trueEye ? elbow.distanceTo(trueEye) : 1;
      const vdy = renderOpts.viewDir && Number.isFinite(renderOpts.viewDir.y) ? renderOpts.viewDir.y : 0;
      arm.stubOn = upperOk && stubShown(arm.stubOn, elbowDist, vdy, fU);
      const cutWant = alongCutHide(alongCutStart(arm.stubOn, elbowDist), fF);
      // The cut eases (no pop when the stub appears / goes); a fresh rig or a big jump snaps.
      arm.cut = !Number.isFinite(arm.cut) || !(dt > 0) ? cutWant : arm.cut + (cutWant - arm.cut) * (1 - Math.exp(-14 * Math.min(dt, 0.1)));
      const am = arm.foreSkin.material;
      if (am && am.userData.along) am.userData.along.value = arm.cut;
      // The sweatband sits at the wrist end (t > 0.8): it goes with the cut once that passes it.
      const bandA = 1 - THREE.MathUtils.smoothstep(arm.cut, 0.72, 0.9);
      setSegmentAlpha(arm, 'upper', 1);
      setSegmentAlpha(arm, 'band', bandA);
      arm.upper.visible = arm.stubOn;
      arm.fore.visible = foreOk && arm.cut < 1 + ALONG_CUT.band - 0.02;
      arm.band.visible = bandA > 0.02;
      // A cut limb casting a full shadow on the glass reads as a ghost arm.
      arm.upperSkin.castShadow = arm.stubOn;
      arm.foreSkin.castShadow = arm.band.castShadow = arm.cut < 0.3;
      // A forearm whose hand (and racket) has been culled reads as a stump: hide it too.
      if (side === dom && rp && !holders[dom].visible) arm.fore.visible = false;
    }
    void dt;
  }

  function setHanded(h) {
    state = { handed: h === 'left' ? 'left' : 'right' };
    handInRacket = handInRacketMatrix(state.handed);
    cradleInRacket = cradleInRacketMatrix(state.handed);
    racketMesh.userData.setHanded?.(state.handed);
    installAll();
  }

  return {
    root,
    racketMesh,
    stats,
    /** Motion-blur ribbon behind the racket head (racketTrail.js). */
    trail,
    /** Current near-eye fade of the racket (1 = solid). */
    get racketFade() { return racketFade; },
    ready,
    update,
    setHanded,
    setSkin(c) { for (const m of skinMats) m.color.set(c); },
    setSleeve(c) { sleeveMat.color.set(c); sleeveMat.sheenColor.set(c).lerp(new THREE.Color('#ffffff'), 0.45); },
    /**
     * Outfit (game/progression.js OUTFITS { shirt, sleeve, band }): the sleeves take the shirt / sleeve
     * colour and both wristbands the band colour.
     */
    setOutfit(o = {}) {
      const sl = o.sleeve || o.shirt;
      if (sl) {
        sleeveMat.color.set(sl);
        sleeveMat.sheenColor.set(sl).lerp(new THREE.Color('#ffffff'), 0.45);
      }
      if (o.band) {
        for (const side of ['L', 'R']) {
          const m = arms[side] && arms[side].band && arms[side].band.material;
          for (const mm of Array.isArray(m) ? m : m ? [m] : []) if (mm.color) mm.color.set(o.band);
        }
      }
    },
    /** Debug: canonical wrist position in the racket frame. */
    wristInRacket() { return new THREE.Vector3().setFromMatrixPosition(handInRacket); },
    get usingGlb() { return usingGlb; },
    get poses() { return poses; },
  };
}
