// Guided axis test for glasses head tracking (pure). The player is asked to turn the head LEFT,
// then look UP, then tilt the head LEFT (left ear toward the shoulder). For each step the device
// rotation since the step began is measured in the device's own axes; the dominant axis and its
// sign tell which device axis is our yaw / pitch / roll and in which sense. The result is a
// signed axis permutation for qRemap (v'_i = sign[i] * v[src[i]]).
//
// The three.js camera convention the result maps to: turning left = +yaw about +Y (index 1),
// looking up = +pitch about +X (index 0), tilting left = +roll about +Z (index 2).
import { qConj, qMul, remapDet, qAngleBetween } from './quat.js';

export const AXIS_STEPS = Object.freeze([
  Object.freeze({ id: 'yaw', out: 1, prompt: 'Turn your head to the LEFT and hold it', es: 'Gira la cabeza a la IZQUIERDA y mantén' }),
  Object.freeze({ id: 'pitch', out: 0, prompt: 'Look UP and hold it', es: 'Mira ARRIBA y mantén' }),
  Object.freeze({ id: 'roll', out: 2, prompt: 'Tilt your head LEFT (left ear to shoulder) and hold it', es: 'Inclina la cabeza a la IZQUIERDA (oreja al hombro)' }),
]);

const DEG = Math.PI / 180;

/** Rotation vector (device body frame) from base to q: axis * angle (rad). */
function localDelta(base, q) {
  const d = qMul(qConj(base, {}), q, {});
  if (d.w < 0) {
    d.x = -d.x; d.y = -d.y; d.z = -d.z; d.w = -d.w;
  }
  const s = Math.hypot(d.x, d.y, d.z);
  const angle = 2 * Math.atan2(s, d.w);
  const k = s > 1e-12 ? angle / s : 0;
  return { v: [d.x * k, d.y * k, d.z * k], angle };
}

/**
 * @param {object} [o]
 * @param {number} [o.thresholdDeg=20]  rotation that completes a step
 * @param {number} [o.purity=0.75]      share of the rotation on the dominant axis to accept it
 * @param {boolean} [o.roll=true]       ask for the roll step (else it is derived)
 * @param {number} [o.settleFeeds=8]     still samples (< 0.4° apart) before a step is armed, so
 *                                       motion left over from the previous step is not counted
 */
export function createAxisTest({ thresholdDeg = 20, purity = 0.75, roll = true, settleFeeds = 8 } = {}) {
  const steps = roll ? AXIS_STEPS : AXIS_STEPS.slice(0, 2);
  let i = -1;
  let base = null;
  const found = []; // { out, src, sign, angle }
  let state = 'idle'; // idle | running | done | failed
  let message = '';
  let progress = 0;
  let prev = null;
  let still = 0;

  function start() {
    i = 0;
    base = null;
    prev = null;
    still = 0;
    found.length = 0;
    state = 'running';
    message = steps[0].prompt;
    progress = 0;
  }

  /** Feeds the current device quaternion; returns the public state. */
  function feed(q) {
    if (state !== 'running' || !q) return status();
    const moved = prev ? qAngleBetween(prev, q) : Infinity;
    prev = { x: q.x, y: q.y, z: q.z, w: q.w };
    if (!base) {
      // Arm the step once the head has been held still for a moment.
      still = moved < 0.4 * DEG ? still + 1 : 0;
      if (still >= settleFeeds) {
        base = { ...prev };
        still = 0;
      }
      return status();
    }
    const { v, angle } = localDelta(base, q);
    progress = Math.min(1, angle / (thresholdDeg * DEG));
    if (angle < thresholdDeg * DEG) return status();
    const abs = v.map(Math.abs);
    const k = abs.indexOf(Math.max(...abs));
    const share = abs[k] / (abs[0] + abs[1] + abs[2] || 1);
    const step = steps[i];
    if (share < purity) {
      message = `${step.prompt} — keep the movement to one direction`;
      base = null;
      still = 0;
      progress = 0;
      return status();
    }
    if (found.some((f) => f.src === k)) {
      state = 'failed';
      message = `That moved the same sensor axis as the ${found.find((f) => f.src === k).id} step. Try the test again.`;
      return status();
    }
    found.push({ id: step.id, out: step.out, src: k, sign: v[k] > 0 ? 1 : -1, angle });
    i++;
    base = null;
    progress = 0;
    if (i >= steps.length) {
      state = 'done';
      message = 'Axis test complete. Face forward again.';
    } else message = steps[i].prompt;
    return status();
  }

  /** { src, sign, proper, derivedRoll } once done (null before). */
  function result() {
    if (state !== 'done') return null;
    const src = [-1, -1, -1], sign = [1, 1, 1];
    for (const f of found) {
      src[f.out] = f.src;
      sign[f.out] = f.sign;
    }
    let derivedRoll = false;
    if (src[2] < 0) {
      src[2] = [0, 1, 2].find((a) => a !== src[0] && a !== src[1]);
      sign[2] = 1;
      if (remapDet(src, sign) < 0) sign[2] = -1;
      derivedRoll = true;
    }
    return { src, sign, proper: remapDet(src, sign) > 0, derivedRoll };
  }

  function status() {
    return { state, step: state === 'running' ? steps[i].id : null, armed: !!base, index: Math.max(0, i), count: steps.length, message: state === 'running' && !base ? `Hold still… then: ${message}` : message, progress };
  }

  function cancel() {
    state = 'idle';
    i = -1;
    base = null;
    message = '';
  }

  return { start, feed, result, status, cancel, get state() { return state; } };
}
