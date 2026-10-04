// First-person camera with gaze assist, plus orbit (menus) and replay views.
//
// XR integration surface (smart glasses, src/xr/; documented in SPEC §6.8): `xr` is read live
// from the third argument's getXR() (the stage passes stage.app.xr):
//   xr.getHeadQuaternion() -> {x,y,z,w} | null   head rotation relative to the last recenter, in
//       the three.js camera convention (yaw about +Y, pitch about +X, roll about +Z). While it
//       returns a quaternion, head tracking is active: the gaze assist is off and the view is
//       base * head, base = body forward (looking down -z, level: the head's own pitch replaces
//       the TV framing pitch). The stage also hides the rear-view mirror inset.
//   xr.fov (deg, optional)                         vertical field of view override (true scale).
//   xr.stereo = { enabled, ipd, render(renderer, scene, camera, composer?) }   see stage.render.
import * as THREE from 'three';
import { PLAYER, COURT } from '../config.js';
import { createGaze, GAZE, GLASS_VIEW } from './gaze.js';
import { isFiniteVec, isFiniteQuat } from './safeView.js';

const DEG = Math.PI / 180;
const BASE_PITCH = -6 * DEG;
// Gaze follow (yaw / pitch springs, phases, limits and the yaw-rate cap) lives in the pure
// gaze.js so it is tested against the real drills; the base pitch is read live from
// settings.viewPitch (deg) when present.

/**
 * @param {THREE.PerspectiveCamera} camera
 * @param {{fov?: number, gazeFollow?: boolean}} settings  (read live each frame)
 * @returns {{ update(world, dt), setFov(deg), mode: 'fp'|'replay'|'orbit', setReplayView(kind), replayView: string, snap() }}
 */
export function createFirstPersonCamera(camera, settings = {}, { getXR = () => null } = {}) {
  let mode = 'fp';
  // Safety net: the last finite eye and camera pose (a NaN camera renders a black picture).
  const lastEye = new THREE.Vector3(0, PLAYER.defaultHeight * PLAYER.eyeHeightRatio, 8);
  const lastPos = new THREE.Vector3(0, 1.64, 8);
  const lastQuat = new THREE.Quaternion();
  const safety = { eyeRestored: 0, cameraRestored: 0 };
  let headActive = false;
  let fovBase = camera.fov;
  const qHead = new THREE.Quaternion();
  const qBase = new THREE.Quaternion();
  let replayView = 'broadcast';
  const gaze = createGaze();
  let orbitT = 0;
  let blend = 1; // 0..1 transition from the pose captured at the last mode switch
  const fromPos = new THREE.Vector3();
  const fromQuat = new THREE.Quaternion();
  const toPos = new THREE.Vector3();
  const toQuat = new THREE.Quaternion();
  const look = new THREE.Vector3();
  const m4 = new THREE.Matrix4();
  const ballCamPos = new THREE.Vector3(0, 3, 14);
  const ballCamLook = new THREE.Vector3();
  const tmp = new THREE.Vector3();
  const euler = new THREE.Euler(0, 0, 0, 'YXZ');

  if (settings.fov) setFov(settings.fov);

  function setFov(deg) {
    if (!(deg > 1 && deg < 179)) return;
    fovBase = deg;
    const xr = getXR();
    camera.fov = xr && xr.fov > 1 && xr.fov < 179 ? xr.fov : deg;
    camera.updateProjectionMatrix();
  }

  /** Applies an XR fov override (or restores the settings fov) when it changes. */
  function syncFov() {
    const xr = getXR();
    const want = xr && xr.fov > 1 && xr.fov < 179 ? xr.fov : fovBase;
    if (Math.abs(camera.fov - want) > 1e-6) {
      camera.fov = want;
      camera.updateProjectionMatrix();
    }
  }

  /** XR head rotation (relative, three.js convention) or null when head tracking is off. */
  function headQuat() {
    const xr = getXR();
    if (!xr || typeof xr.getHeadQuaternion !== 'function') return null;
    let q = null;
    try {
      q = xr.getHeadQuaternion();
    } catch {
      q = null;
    }
    if (!q || !isFiniteQuat(q)) return null;
    return qHead.set(q.x, q.y, q.z, q.w).normalize();
  }

  function beginBlend() {
    fromPos.copy(camera.position);
    fromQuat.copy(camera.quaternion);
    blend = 0;
  }

  function lookFrom(pos, target, out) {
    m4.lookAt(pos, target, THREE.Object3D.DEFAULT_UP);
    return out.setFromRotationMatrix(m4);
  }

  function eyeOf(player, out) {
    if (player?.eye && isFiniteVec(player.eye)) {
      out.set(player.eye.x, player.eye.y, player.eye.z);
      lastEye.copy(out);
    } else if (player?.eye) {
      // Non-finite tracking output never reaches the camera: hold the last good eye.
      safety.eyeRestored++;
      out.copy(lastEye);
    } else {
      const h = player?.height || PLAYER.defaultHeight;
      out.set(player?.pos?.x || 0, h * PLAYER.eyeHeightRatio, player?.pos?.z ?? 8);
    }
    // Viewpoint offset (court frame, the player faces -z): a few cm behind and below the tracked
    // eyes keeps the hand holding the racket in the picture in a ready position, as in a VR
    // headset's wider view. Rendering only: hits, gaze and audio use the tracked eye.
    const off = settings.eyeOffset;
    if (off) out.set(out.x, out.y - (off.down || 0), out.z + (off.back || 0));
    return out;
  }

  /** The incoming ball's planned contact (tactical home's intercept) for contact framing, or null. */
  function predictedContact(world) {
    const ic = world?.mode?.tactics?.state?.intercept;
    const c = ic && ic.contact;
    if (!c || !world.ball || world.ball.atRest) return null;
    contactOut.x = c.x; contactOut.y = c.y; contactOut.z = c.z; contactOut.t = ic.t;
    return contactOut;
  }
  const contactOut = { x: 0, y: 0, z: 0, t: 0 };

  const basePitch = () => (Number.isFinite(settings.viewPitch) ? settings.viewPitch * DEG : BASE_PITCH);

  /** settings.glassView, defaulting to the rear-view mirror. */
  const glassView = () => (GLASS_VIEW.MODES.includes(settings.glassView) ? settings.glassView : GLASS_VIEW.DEFAULT);

  function updateFp(world, dt) {
    const eye = eyeOf(world.player, toPos);
    const head = headQuat();
    headActive = !!head;
    if (head) {
      // Head tracking (glasses): body-forward base, level, with the head rotation on top; no gaze.
      qBase.identity();
      toQuat.copy(qBase).multiply(head);
      gaze.reset(0);
      lastGaze.rear = false;
      return;
    }
    const g = gaze.update(world.ball, eye, dt, {
      basePitch: basePitch(), follow: settings.gazeFollow !== false, contact: predictedContact(world), glassView: glassView(),
    });
    lastGaze.rear = g.rear;
    euler.set(g.pitch, g.yaw, 0, 'YXZ'); // no roll
    toQuat.setFromEuler(euler);
  }
  const lastGaze = { rear: false };

  function updateOrbit(dt) {
    orbitT += dt;
    const a = orbitT * 0.06 + 0.6;
    const R = 17.5;
    toPos.set(Math.sin(a) * R, 6.2 + Math.sin(orbitT * 0.11) * 1.1, Math.cos(a) * R * 0.95);
    lookFrom(toPos, look.set(0, 0.6, 0), toQuat);
  }

  function updateReplay(world, dt) {
    const ball = world.ball;
    if (replayView === 'side') {
      // Merge pass (round 4 venues): 2.6 m outside the side wall, between it and the neighbouring
      // court (x = 13 ± 5) and in front of the stadium's side stands (x ≥ 9.6), above the benches.
      toPos.set(COURT.halfWidth + 2.6, 3.0, ball ? THREE.MathUtils.clamp(ball.pos.z * 0.3, -4, 4) : 0);
      lookFrom(toPos, look.set(0, 1, ball ? ball.pos.z * 0.5 : 0), toQuat);
    } else if (replayView === 'ball' && ball) {
      tmp.set(ball.vel?.x || 0, 0, ball.vel?.z || -1);
      if (tmp.lengthSq() < 1e-4) tmp.set(0, 0, -1);
      tmp.normalize();
      const want = look.set(ball.pos.x, ball.pos.y, ball.pos.z).addScaledVector(tmp, -2.6);
      want.y = Math.max(0.4, ball.pos.y + 0.7);
      const k = 1 - Math.exp(-5 * dt);
      ballCamPos.lerp(want, k);
      ballCamLook.lerp(tmp.multiplyScalar(1.2).add(ball.pos), k * 1.5);
      toPos.copy(ballCamPos);
      lookFrom(toPos, ballCamLook, toQuat);
    } else {
      // Broadcast: high behind the near back wall. The stage cuts that wall away while this view
      // is on (QA: its posts and rails cut through the player).
      toPos.set(0, 6.2, COURT.halfLength + 5.0);
      lookFrom(toPos, look.set(0, 0.3, 4.5), toQuat);
    }
  }

  /** dtReal: wall-clock dt for view transitions (slow-motion replays pass a scaled dt). */
  function update(world, dt = 1 / 60, dtReal = dt) {
    syncFov();
    if (!(dt >= 0)) dt = 0;
    if (!(dtReal >= 0)) dtReal = dt;
    headActive = false;
    lastGaze.rear = false;
    if (mode === 'orbit' || !world) updateOrbit(dt);
    else if (mode === 'replay') updateReplay(world, dt);
    else updateFp(world, dt);
    if (blend < 1) {
      blend = Math.min(1, blend + dtReal / 0.6);
      const s = blend * blend * (3 - 2 * blend);
      camera.position.lerpVectors(fromPos, toPos, s);
      camera.quaternion.slerpQuaternions(fromQuat, toQuat, s);
    } else {
      camera.position.copy(toPos);
      camera.quaternion.copy(toQuat);
    }
    // Final safety net: never hand three.js a non-finite camera (restore the last good pose).
    if (isFiniteVec(camera.position) && isFiniteQuat(camera.quaternion)) {
      lastPos.copy(camera.position);
      lastQuat.copy(camera.quaternion);
    } else {
      safety.cameraRestored++;
      camera.position.copy(lastPos);
      camera.quaternion.copy(lastQuat);
      blend = 1;
    }
    camera.updateMatrixWorld();
  }

  return {
    update,
    setFov,
    get mode() { return mode; },
    set mode(m) {
      if (m === mode || !['fp', 'replay', 'orbit'].includes(m)) return;
      beginBlend();
      // Into and out of a replay is a cut, like television: a 0.6 s flight between the eye and the
      // broadcast position crossed the back wall's mesh (dotted noise over the court).
      if (m === 'replay' || mode === 'replay') blend = 1;
      mode = m;
      if (m === 'fp') gaze.reset(basePitch());
    },
    /** kind: 'broadcast' | 'side' | 'ball' */
    setReplayView(kind) {
      if (kind === replayView) return;
      beginBlend();
      if (mode === 'replay') blend = 1; // a cut between replay angles
      replayView = kind;
    },
    get replayView() { return replayView; },
    /** Cancels any running transition (e.g. right after a teleport). */
    snap() { blend = 1; },
    get gaze() { return { yaw: gaze.yaw, pitch: gaze.pitch, phase: gaze.phase, limit: GAZE.BACK_LIMIT, rear: lastGaze.rear, glassView: glassView() }; },
    /** The ball is behind the eye on the player's side (first-person view with the gaze assist): the mirror's cue. */
    get rear() { return mode === 'fp' && lastGaze.rear; },
    /** XR head tracking drove the view this frame. */
    get headTracking() { return headActive; },
    /** Safety-net counters (eye / camera poses restored). */
    safety,
  };
}
