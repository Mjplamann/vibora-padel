// Ring buffer of ball snapshots, one per world tick, for lag-compensated hits:
// rewind to the contact time, apply the impact, re-simulate to the present.
// Slots are preallocated and reused, so push() does not allocate. Pure module.

import { Vec3 } from '../util/vec3.js';
import { SIM } from '../config.js';
import { cloneBall, copyBallInto } from './ball.js';

const EPS = 1e-9; // tick-time tolerance for float accumulation

function blankState() {
  return { pos: new Vec3(), vel: new Vec3(), spin: new Vec3(), t: 0, outside: false, atRest: false, lastSurface: null, id: 0 };
}

/**
 * @returns BallHistory = {
 *   push(ball), at(t, out?) -> BallState|null, indexAt(t) -> number, rewindTo(t) -> BallState|null,
 *   truncateAfter(t), clear(), latest() -> BallState|null, oldest() -> BallState|null,
 *   get(i) -> BallState (internal, read-only), length, capacity }
 */
export function createBallHistory(seconds = SIM.historySeconds, tickRate = SIM.tickRate) {
  const capacity = Math.max(2, Math.ceil(seconds * tickRate) + 1);
  const slots = Array.from({ length: capacity }, blankState);
  let start = 0;
  let len = 0;

  const get = (i) => slots[(start + i) % capacity];

  /** Index (0 = oldest) of the newest snapshot with t <= time, or -1. */
  function indexAt(time) {
    let lo = 0, hi = len - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (get(mid).t <= time + EPS) {
        ans = mid;
        lo = mid + 1;
      } else hi = mid - 1;
    }
    return ans;
  }

  /** Appends a copy of the ball. A snapshot at or before an existing time replaces the newer ones. */
  function push(ball) {
    if (len > 0 && get(len - 1).t >= ball.t - EPS) len = indexAt(ball.t - 2 * EPS) + 1;
    copyBallInto(slots[(start + len) % capacity], ball);
    if (len < capacity) len++;
    else start = (start + 1) % capacity;
  }

  /**
   * Ball state at time t, linearly interpolated between the bracketing ticks (position
   * error < 0.1 mm at 240 Hz; linear never overshoots through a bounce). Discrete fields
   * come from the earlier tick. t past the newest tick returns the newest; t before the
   * oldest (or an empty buffer) returns null. Snapshots of different balls are not mixed.
   */
  function at(time, out = null) {
    const i = indexAt(time);
    if (i < 0) return null;
    const a = get(i);
    const res = copyBallInto(out || blankState(), a);
    if (i + 1 >= len) return res;
    const b = get(i + 1);
    if (b.id !== a.id) return res;
    const span = b.t - a.t;
    const u = span > 0 ? Math.min(1, Math.max(0, (time - a.t) / span)) : 0;
    res.pos.lerpVectors(a.pos, b.pos, u);
    res.vel.lerpVectors(a.vel, b.vel, u);
    res.spin.lerpVectors(a.spin, b.spin, u);
    res.t = time;
    return res;
  }

  /** Exact deep copy of the newest snapshot at or before t, or null if there is none. */
  function rewindTo(time) {
    const i = indexAt(time);
    return i < 0 ? null : cloneBall(get(i));
  }

  /** Drops every snapshot newer than t. */
  function truncateAfter(time) {
    len = indexAt(time) + 1;
  }

  return {
    push,
    at,
    indexAt,
    rewindTo,
    truncateAfter,
    clear() {
      start = 0;
      len = 0;
    },
    latest: () => (len ? cloneBall(get(len - 1)) : null),
    oldest: () => (len ? cloneBall(get(0)) : null),
    get: (i) => (i >= 0 && i < len ? get(i) : undefined),
    get length() {
      return len;
    },
    capacity,
  };
}
