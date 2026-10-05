// Third-person "behind the player" camera for small screens (swipe mode on a phone). A broadcast-like
// view from high behind the near back wall that follows the player, keeps the ball and the coming
// contact in frame and lets the player see their own skinned athlete swing (stage.syncWorld
// selfActor). Landscape and portrait presets; first person stays available (stage view 'fp').
//
// Pure: it only reads the world and writes camera.position / camera.fov and calls camera.lookAt and
// camera.updateProjectionMatrix, so it needs no three.js import and runs under node --test with a
// stand-in camera. Works with any stage view whose own camera update runs first (stage.syncWorld);
// the near back wall is cut away by the stage's 'broadcast' cutaway (view 'replay' + replay view
// 'broadcast' today, or a 'chase' view, see the integration notes in src/app/mobile.js).

import { COURT } from '../config.js';

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const DEG = Math.PI / 180;

/**
 * Framing presets (m, degrees). height / back: the camera above the floor and behind the player
 * (capped at maxZ, inside the space every venue keeps clear behind the court for the broadcast replay
 * camera); lookAhead: how far toward the net the view centres; follow: share of the player's
 * sideways position the camera follows; fov: vertical field of view, widened up to fovMax to keep
 * both the player's feet and the ball in the picture.
 */
export const CHASE = Object.freeze({
  landscape: Object.freeze({ height: 5.0, back: 6.0, lookAhead: 7.0, lookY: 0.5, follow: 0.6, fov: 46, fovMax: 58, maxZ: 15.0 }),
  portrait: Object.freeze({ height: 6.8, back: 8.2, lookAhead: 5.8, lookY: 0.6, follow: 0.75, fov: 68, fovMax: 80, maxZ: 15.2 }),
  /** Margins (share of the half field of view) kept free at the top / bottom of the picture. */
  margin: 0.82,
  /** Critically damped follow rates (1/s): position, look target, field of view. */
  kPos: 3.2,
  kLook: 4.5,
  kFov: 2.5,
});

/** The preset for an aspect ratio (width / height). */
export const presetFor = (aspect) => (aspect < 1 ? CHASE.portrait : CHASE.landscape);

/**
 * Desired camera for a world state: { pos {x,y,z}, look {x,y,z}, fov } (no smoothing).
 * world: { player: { pos, height }, ball (shown ball or null), timing.plan (pStar) }.
 */
export function chaseTarget(world, aspect = 16 / 9, out = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, fov: 46 }) {
  const C = presetFor(aspect);
  const pl = world && world.player;
  const px = pl && pl.pos ? pl.pos.x : 0;
  const pz = pl && pl.pos ? pl.pos.z : 8;
  const b = world && world.ball && !world.ball.atRest && !world.ball.outside ? world.ball.pos : null;
  const P = world && world.timing && world.timing.plan;
  const c = P && P.pStar ? P.pStar : null;
  // Sideways: mostly the player, a little toward the ball (or the coming contact).
  const fx = c ? c.x : b ? b.x : px;
  out.pos.x = clamp(C.follow * px + 0.15 * fx, -3.2, 3.2);
  out.pos.y = C.height;
  out.pos.z = Math.min(C.maxZ, pz + C.back);
  out.look.x = clamp(0.45 * px + 0.2 * fx, -3, 3);
  out.look.y = C.lookY;
  out.look.z = Math.max(-COURT.halfLength + 1, pz - C.lookAhead);
  // Vertical fit: the player's feet above the bottom edge and the ball (a high lob) below the top
  // edge (margins kept); when both cannot fit, the view widens up to fovMax.
  const dzL = out.pos.z - out.look.z;
  const feet = Math.atan2(-out.pos.y, Math.max(0.5, out.pos.z - pz)); // below the horizon
  const base = Math.atan2(out.look.y - out.pos.y, Math.max(0.5, dzL));
  const top = b && out.pos.z - b.z > 1 ? Math.atan2(b.y - out.pos.y, out.pos.z - b.z) : -Infinity;
  let fov = C.fov;
  let half = (fov * DEG * CHASE.margin) / 2;
  let pitch;
  if (top - half <= feet + half) pitch = clamp(base, top - half, feet + half);
  else {
    half = (top - feet) / 2;
    fov = Math.min(C.fovMax, (2 * half) / CHASE.margin / DEG);
    pitch = (top + feet) / 2;
  }
  out.fov = fov;
  // Re-aim the look point along that pitch (same horizontal distance).
  out.look.y = out.pos.y + Math.tan(pitch) * dzL;
  return out;
}

/**
 * @param {object} camera three.js PerspectiveCamera (or any { position, fov, aspect, lookAt(), updateProjectionMatrix() })
 * @returns {{ update(world, dt), snap(), get target() }}
 */
export function createChaseCam(camera) {
  const want = { pos: { x: 0, y: 5, z: 14 }, look: { x: 0, y: 0.5, z: 1 }, fov: CHASE.landscape.fov };
  const cur = { pos: { x: 0, y: 5, z: 14 }, look: { x: 0, y: 0.5, z: 1 }, fov: CHASE.landscape.fov };
  const vel = { pos: { x: 0, y: 0, z: 0 }, look: { x: 0, y: 0, z: 0 }, fov: 0 };
  let init = false;

  const spring = (k, dt, key, sub) => {
    const x = sub ? cur[key][sub] : cur[key];
    const v = sub ? vel[key][sub] : vel[key];
    const g = sub ? want[key][sub] : want[key];
    // Critically damped (semi-implicit), stable for the frame steps used here.
    const a = k * k * (g - x) - 2 * k * v;
    const nv = v + a * dt;
    const nx = x + nv * dt;
    if (sub) {
      cur[key][sub] = nx;
      vel[key][sub] = nv;
    } else {
      cur[key] = nx;
      vel[key] = nv;
    }
  };

  function apply() {
    camera.position.x = cur.pos.x;
    camera.position.y = cur.pos.y;
    camera.position.z = cur.pos.z;
    camera.lookAt(cur.look.x, cur.look.y, cur.look.z);
    if (Math.abs(camera.fov - cur.fov) > 1e-4) {
      camera.fov = cur.fov;
      camera.updateProjectionMatrix();
    }
    if (camera.updateMatrixWorld) camera.updateMatrixWorld();
  }

  function snap() {
    cur.pos = { ...want.pos };
    cur.look = { ...want.look };
    cur.fov = want.fov;
    vel.pos = { x: 0, y: 0, z: 0 };
    vel.look = { x: 0, y: 0, z: 0 };
    vel.fov = 0;
    init = true;
  }

  return {
    /** After the stage's own camera update, before rendering. dt: real seconds since the last frame. */
    update(world, dt = 1 / 60) {
      const aspect = camera.aspect || 16 / 9;
      chaseTarget(world, aspect, want);
      if (!init) snap();
      else {
        const h = clamp(dt, 0, 0.1);
        // Two half steps keep the spring stable on a slow frame.
        for (let i = 0; i < 2; i++) {
          for (const s of ['x', 'y', 'z']) {
            spring(CHASE.kPos, h / 2, 'pos', s);
            spring(CHASE.kLook, h / 2, 'look', s);
          }
          spring(CHASE.kFov, h / 2, 'fov', null);
        }
      }
      if (![cur.pos.x, cur.pos.y, cur.pos.z, cur.look.x, cur.look.y, cur.look.z, cur.fov].every(Number.isFinite)) snap();
      apply();
    },
    snap,
    get target() { return want; },
    get current() { return cur; },
  };
}
