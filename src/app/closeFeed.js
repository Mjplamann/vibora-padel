// Close-mode autopilot feed (round 4): the virtual player stands ~1.7 m from a camera at chest
// height, so only the head, shoulders and arms are in the picture and the legs are MediaPipe-style
// guesses (synthetic.js crop). Like app/game.js installRealisticFeed: 30 fps capture, each pose
// result `delivery` + U(0, jitter) s later (in order), optional webcam landmark noise. Pure module.
import { createRng } from '../util/math.js';
import { createAutopilot, CLOSE_ENVELOPE, USER1_SETUP } from '../tracking/autopilot.js';
import { createSyntheticCamera } from '../tracking/synthetic.js';

/** Where the close-mode autopilot stands and how the camera sees it. */
export const CLOSE_FEED = Object.freeze({ distance: 1.7, cameraHeight: 1.25, pitchDeg: 0 });

/** Landmark noise σ of a webcam at noise = 1: image (normalised) and world (m) (app/game.js WEBCAM_NOISE). */
const NOISE = Object.freeze({ image: 0.0016, world: 0.012, worldZ: 0.03 });

/**
 * Replaces an autopilot feed's player and camera with the close-mode ones (call before the
 * calibration stand-still, as createGame does with installRealisticFeed).
 * @param feed createAutopilotFeed() result (its beforeTick and autopilot are replaced)
 * @param o { handed, height, hfovDeg, seed, delivery, jitter, noise, fps, distance, cameraHeight,
 *   pitchDeg, profile ('precise' | 'human' | 'user1'), blur (synthetic.js blur options or null), armOut
 *   (synthetic.js out-of-frame arm landmarks: { mode: 'drift' | 'clamp', ... } or null = the truth),
 *   envelope (the room the player keeps to, autopilot.js CLOSE_ENVELOPE), overrides (profile fields) }
 *   Profile 'user1' (round 6) defaults distance, camera, envelope, armOut and blur to the real
 *   session it was fitted to (autopilot.js USER1_SETUP: 1.23 m from a MacBook Air camera).
 */
export function installCloseFeed(feed, o = {}) {
  const profile = o.profile || 'precise';
  const setup = profile === 'user1' ? USER1_SETUP : {};
  const pick = (k, d) => (o[k] !== undefined ? o[k] : setup[k] !== undefined ? setup[k] : d);
  const {
    handed = 'right', height = 1.75, hfovDeg = 68, seed = 1, delivery = 0.15, jitter = 0.02, noise = 0, fps = 30,
  } = o;
  const distance = pick('distance', CLOSE_FEED.distance);
  const cameraHeight = pick('cameraHeight', CLOSE_FEED.cameraHeight);
  const pitchDeg = pick('pitchDeg', CLOSE_FEED.pitchDeg);
  const blur = pick('blur', null);
  const armOut = pick('armOut', null);
  const envelope = pick('envelope', CLOSE_ENVELOPE);
  const ap = createAutopilot({ rng: createRng(seed), handed, height, skill: 0.9, room0: { x: 0, d: distance }, envelope });
  if (profile !== 'precise') ap.setProfile(profile, { seed: seed * 7919 + 13, overrides: o.overrides || null });
  const cam = createSyntheticCamera({ hfovDeg, cameraHeight, pitchDeg, crop: { seed: seed + 5 }, blur, armOut });
  const rng = createRng(seed + 991);
  const pending = [];
  let next = null;
  let last = null;
  const perturb = (frame) => {
    if (!(noise > 0)) return frame;
    for (const p of frame.people || []) {
      for (const l of p.landmarks) {
        l.x += rng.normal(0, NOISE.image * noise);
        l.y += rng.normal(0, NOISE.image * noise);
      }
      for (const l of p.world) {
        l.x += rng.normal(0, NOISE.world * noise);
        l.y += rng.normal(0, NOISE.world * noise);
        l.z += rng.normal(0, NOISE.worldZ * noise);
      }
    }
    return frame;
  };
  feed.beforeTick = (world, human, onFrame = null) => {
    if (next === null) next = world.time;
    if (world.tracking) {
      world.tracking.delay = delivery + jitter / 2;
      world.tracking.frameDt = 1 / fps;
    }
    if (world.time >= next - 1e-9) {
      const body = ap.update(world, world.time);
      const at = Math.max(world.time + delivery + rng() * jitter, pending.length ? pending[pending.length - 1].at : 0);
      pending.push({ at, frame: perturb(cam.frame(world.time * 1000, [body])), t: world.time });
      next += 1 / fps;
      if (next < world.time) next = world.time + 1 / fps;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      last = f.frame;
      const sample = human.onPoseFrame(world, f.frame, f.t);
      if (onFrame) onFrame(f.frame, sample);
    }
  };
  Object.defineProperty(feed, 'autopilot', { get: () => ap, configurable: true });
  Object.defineProperty(feed, 'lastFrame', { get: () => last, configurable: true });
  Object.defineProperty(feed, 'nextContact', {
    get: () => {
      const p = ap.plan;
      return p && !p.none && Number.isFinite(p.t) ? p.t : null;
    },
    configurable: true,
  });
  feed.camera = cam;
  return feed;
}
