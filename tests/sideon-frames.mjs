// Test fixture (not a test file): what MediaPipe BlazePose really does when a player at
// 2.1-3.0 m turns side-on to a MacBook camera, applied to synthetic PoseFrames.
// Real-session report: "a couple of the modes just show a black screen with image on the side
// if you turn left or right far enough". These corruptions reproduce the side-on conditions:
//   - the body turns ±60…±110° (turnBody) so shoulders and hips overlap in the image;
//   - the far arm is occluded: low visibility and its landmarks collapse / wander;
//   - left / right labels swap for a few frames at a time once side-on;
//   - degenerate hands (wrist = index = pinky), zero-length forearms;
//   - frames with nobody in them, single wild outliers, and non-finite values.
import { createRng } from '../src/util/math.js';
import { cloneBody, turnBody } from '../src/tracking/synthetic.js';

const PAIRS = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const ARM = { L: [13, 15, 17, 19, 21], R: [14, 16, 18, 20, 22] };

const copyPerson = (p) => ({
  landmarks: p.landmarks.map((q) => ({ ...q })),
  world: p.world.map((q) => ({ ...q })),
});

/** Swaps every left / right landmark pair (MediaPipe's side-on label flip). */
export function swapLabels(person) {
  for (const arr of [person.landmarks, person.world]) {
    for (const [a, b] of PAIRS) {
      const t = arr[a];
      arr[a] = arr[b];
      arr[b] = t;
    }
  }
  return person;
}

/** Far arm hidden behind the torso: low visibility, landmarks collapsed toward its shoulder. */
export function occludeArm(person, side, { collapse = 0.85, vis = 0.12 } = {}) {
  const s = side === 'L' ? 11 : 12;
  for (const arr of [person.landmarks, person.world]) {
    const S = arr[s];
    for (const i of ARM[side]) {
      const q = arr[i];
      q.x += (S.x - q.x) * collapse;
      q.y += (S.y - q.y) * collapse;
      q.z += (S.z - q.z) * collapse;
      q.visibility = vis;
    }
  }
  return person;
}

/** Hand landmarks of one side on top of each other (and optionally the elbow too). */
export function collapseHand(person, side, { elbow = false } = {}) {
  const [e, w, p, i, t] = ARM[side];
  for (const arr of [person.landmarks, person.world]) {
    for (const k of [p, i, t]) arr[k] = { ...arr[w] };
    if (elbow) arr[e] = { ...arr[w] };
  }
  return person;
}

/** Yaw schedule (deg) of a turn from facing the camera to `peak` and back. */
export function turnYaw(t, { start = 0.5, ramp = 0.8, hold = 1.2, peak = 95 } = {}) {
  const u = t - start;
  if (u <= 0) return 0;
  const s = (x) => x * x * (3 - 2 * x);
  if (u < ramp) return peak * s(u / ramp);
  if (u < ramp + hold) return peak;
  if (u < 2 * ramp + hold) return peak * (1 - s((u - ramp - hold) / ramp));
  return 0;
}

/**
 * A body turned by `yawDeg` about its hips (clone; the autopilot's body is not modified).
 * + = facing the player's right.
 */
export function turnedBody(body, yawDeg) {
  const b = cloneBody(body);
  if (yawDeg) turnBody(b, yawDeg);
  return b;
}

/**
 * Applies MediaPipe's side-on behaviour to a frame for a body turned by `yawDeg`.
 * kinds: subset of ['occlude', 'swap', 'collapse', 'empty', 'outlier', 'nan', 'inf', 'zeroseg'].
 * Deterministic for a seed.
 */
export function createSideOnCorruptor({ seed = 7, kinds = ['occlude', 'swap', 'collapse', 'empty', 'outlier'] } = {}) {
  const rng = createRng(seed);
  const on = new Set(kinds);
  let swapLeft = 0;
  let n = 0;
  return function corrupt(frame, yawDeg) {
    n++;
    if (!frame.people || !frame.people.length) return frame;
    const side = Math.abs(yawDeg) > 55;
    if (on.has('empty') && side && rng() < 0.05) return { ...frame, people: [] };
    const p = copyPerson(frame.people[0]);
    // The far arm: turning to face the right (+yaw) hides the right arm behind the body.
    if (on.has('occlude') && side) occludeArm(p, yawDeg > 0 ? 'R' : 'L', { collapse: 0.4 + 0.6 * rng(), vis: 0.05 + 0.25 * rng() });
    if (on.has('collapse') && side && rng() < 0.3) collapseHand(p, yawDeg > 0 ? 'R' : 'L', { elbow: rng() < 0.5 });
    if (on.has('zeroseg') && side && rng() < 0.3) {
      // Shoulders, hips and the torso sides collapse to zero length in the image and the world.
      for (const arr of [p.landmarks, p.world]) {
        arr[12] = { ...arr[11] };
        arr[24] = { ...arr[23] };
      }
    }
    if (on.has('swap') && side) {
      if (swapLeft <= 0 && rng() < 0.12) swapLeft = 2 + Math.floor(rng() * 8);
      if (swapLeft > 0) {
        swapLabels(p);
        swapLeft--;
      }
    }
    if (on.has('outlier') && rng() < 0.03) {
      const i = Math.floor(rng() * 33);
      p.landmarks[i].x += (rng() - 0.5) * 3;
      p.landmarks[i].y += (rng() - 0.5) * 3;
      p.world[i].x += (rng() - 0.5) * 4;
      p.world[i].z += (rng() - 0.5) * 6;
    }
    if (on.has('nan') && side && rng() < 0.04) {
      const i = Math.floor(rng() * 33);
      p.world[i].z = NaN;
      p.landmarks[(i + 7) % 33].visibility = NaN;
    }
    if (on.has('inf') && side && rng() < 0.03) {
      const i = Math.floor(rng() * 33);
      p.landmarks[i].x = Infinity;
    }
    void n;
    return { ...frame, people: [p] };
  };
}
