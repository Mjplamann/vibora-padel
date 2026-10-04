// Procedural footwork with foot planting (pure: no three). Each foot stays nailed to the court
// while it carries weight; when the body has moved far enough from where that foot wants to be,
// it lifts and swings along an arc to a landing spot predicted ahead of the body, so feet never
// slide. Side shuffles, crossovers, sprints, a split-step hop (both feet off the ground as the
// opponent strikes) and jumps (smash) come out of the same rules. Court frame: metres, y up.
//
// Facing convention (three.js rotation.y of a model facing +z): forward = (sin yaw, 0, cos yaw),
// the actor's right = (-cos yaw, 0, sin yaw). Stance offsets are [right, forward] in metres.

const clamp = (v, a, b) => (v < a ? a : v > b ? b : v);
const smooth = (t) => t * t * (3 - 2 * t);
const wrapPi = (a) => {
  while (a > Math.PI) a -= 2 * Math.PI;
  while (a < -Math.PI) a += 2 * Math.PI;
  return a;
};

export const STEP = Object.freeze({
  threshold: 0.075, // m of error before a planted foot steps (moving)
  idleThreshold: 0.11, // m (standing: no fidgeting)
  minGround: 0.05, // s a foot stays down before the other may lift (walking / shuffling)
  maxStride: 0.95, // m per step (sprinting)
  lead: 0.17, // s: landing spot = where the body will be this much after landing
  liftWalk: 0.06, liftRun: 0.12, liftShuffle: 0.035, // m
  hopTime: 0.26, hopLift: 0.045, // split-step
  minSep: 0.16, // m: feet never closer than this sideways (no crossing in a shuffle)
});

function makeFoot(side) {
  return {
    side, x: 0, y: 0, z: 0, yaw: 0, pitch: 0, planted: true, ground: 0,
    sx: 0, sz: 0, syaw: 0, tx: 0, tz: 0, tyaw: 0, u: 0, dur: 0.3, lift: 0.06, hop: false,
  };
}

/**
 * @returns {{ feet: {R, L}, reset(x, z, yaw, stance), update(dt, input) -> state, airborne, hopY }}
 * input: { x, z, vx, vz, yaw, stance: {R: [r, f], L: [r, f]}, footYaw?: {R, L} (rad offsets),
 *          hop?: boolean (start a split-step now), jump?: number (m, both feet off while > 0.03) }
 */
export function createStepper() {
  const feet = { R: makeFoot('R'), L: makeFoot('L') };
  const BOTH = [feet.R, feet.L];
  const state = { feet, airborne: 0, hopY: 0, stepping: 0, lastStepSide: 'L', stepCount: 0, bob: 0, sway: 0, stride: 0 };
  let hopT = -1;
  let speedS = 0;

  function home(f, inp, ahead, out) {
    const off = inp.stance[f.side];
    const fx = Math.sin(inp.yaw), fz = Math.cos(inp.yaw);
    const rx = -fz, rz = fx;
    out.x = inp.x + rx * off[0] + fx * off[1] + inp.vx * ahead;
    out.z = inp.z + rz * off[0] + fz * off[1] + inp.vz * ahead;
    out.yaw = inp.yaw + ((inp.footYaw && inp.footYaw[f.side]) || 0);
    return out;
  }
  const H = { x: 0, z: 0, yaw: 0 };

  function reset(x, z, yaw, stance) {
    for (const f of BOTH) {
      home(f, { x, z, vx: 0, vz: 0, yaw, stance }, 0, H);
      f.x = H.x; f.z = H.z; f.y = 0; f.yaw = H.yaw; f.pitch = 0;
      f.planted = true; f.ground = 1; f.u = 0; f.hop = false;
    }
    hopT = -1;
    state.airborne = 0;
    state.hopY = 0;
  }

  function lift(f, inp, dur, liftH, hop = false) {
    f.planted = false;
    f.hop = hop;
    f.u = 0;
    f.dur = dur;
    f.lift = liftH;
    f.sx = f.x; f.sz = f.z; f.syaw = f.yaw;
    f.ground = 0;
    state.stepCount++;
    state.lastStepSide = f.side;
  }

  function update(dt, inp) {
    const speed = Math.hypot(inp.vx, inp.vz);
    speedS += (speed - speedS) * (1 - Math.exp(-8 * dt));
    const fx = Math.sin(inp.yaw), fz = Math.cos(inp.yaw);
    const rx = -fz, rz = fx;
    const vRight = inp.vx * rx + inp.vz * rz;
    const vFwd = inp.vx * fx + inp.vz * fz;
    const lateral = Math.abs(vRight) > Math.abs(vFwd) * 1.1;
    const running = speed > 3.2;

    // Split-step: both feet hop together, landing a little wider.
    if (inp.hop && hopT < 0 && feet.R.planted && feet.L.planted) {
      hopT = 0;
      for (const f of BOTH) lift(f, inp, STEP.hopTime, STEP.hopLift, true);
    }
    // Jump (smash): both feet leave the ground while the pelvis is lifted.
    const jumping = (inp.jump || 0) > 0.03;
    if (jumping) {
      for (const f of BOTH) {
        if (f.planted) lift(f, inp, 0.5, 0, true);
        f.u = Math.min(f.u, 0.5); // held in the air until the jump ends
      }
    }

    // Swinging feet move toward their (continuously re-predicted) landing spot.
    for (const f of BOTH) {
      f.ground += dt;
      if (f.planted) continue;
      f.u = Math.min(1, f.u + dt / f.dur);
      const remain = (1 - f.u) * f.dur;
      home(f, inp, f.hop ? 0 : remain + (lateral && !running ? 0.06 : STEP.lead * clamp(speed / 2, 0.3, 1)), H);
      if (f.hop) {
        // Split-step lands a few cm wider (toes out), wherever the body is.
        const sgn = f.side === 'R' ? 1 : -1;
        H.x += rx * sgn * 0.03;
        H.z += rz * sgn * 0.03;
      }
      f.tx = H.x; f.tz = H.z; f.tyaw = H.yaw;
      // Never land across the other foot (shuffles keep the feet apart; sprints may come closer).
      const other = f === feet.R ? feet.L : feet.R;
      const minSep = running ? 0.06 : STEP.minSep;
      const sgn = f === feet.R ? 1 : -1; // R must stay to the right of L
      const sep = sgn * ((f.tx - other.x) * rx + (f.tz - other.z) * rz);
      if (sep < minSep) {
        f.tx += rx * sgn * (minSep - sep);
        f.tz += rz * sgn * (minSep - sep);
      }
      // Limit the stride.
      const dx = f.tx - f.sx, dz = f.tz - f.sz;
      const d = Math.hypot(dx, dz);
      if (d > STEP.maxStride) {
        f.tx = f.sx + (dx / d) * STEP.maxStride;
        f.tz = f.sz + (dz / d) * STEP.maxStride;
      }
      const e = smooth(f.u);
      f.x = f.sx + (f.tx - f.sx) * e;
      f.z = f.sz + (f.tz - f.sz) * e;
      f.yaw = f.syaw + wrapPi(f.tyaw - f.syaw) * e;
      f.y = f.hop ? f.lift * Math.sin(Math.PI * f.u) : f.lift * Math.sin(Math.PI * f.u);
      // Toe-off at the start (heel up), heel strike when landing forward.
      const fwdStep = ((f.tx - f.sx) * fx + (f.tz - f.sz) * fz) / Math.max(0.05, d);
      f.pitch = f.hop ? 0.15 * Math.sin(Math.PI * f.u) : (0.5 * Math.sin(Math.PI * Math.min(1, f.u * 2.2)) * (f.u < 0.45 ? 1 : 0)) - 0.25 * smooth(clamp((f.u - 0.7) / 0.3, 0, 1)) * Math.max(0, fwdStep) * clamp(speed / 3, 0, 1);
      if (f.u >= 1 && !(jumping && f.hop)) {
        f.planted = true;
        f.y = 0;
        f.pitch = 0;
        f.ground = 0;
        f.hop = false;
      }
    }
    if (hopT >= 0) {
      hopT += dt;
      if (feet.R.planted && feet.L.planted) hopT = -1;
    }

    // Planted feet: step when the body has left them behind.
    if (!jumping && hopT < 0) {
      const thr = speed > 0.4 ? STEP.threshold : STEP.idleThreshold;
      let best = null, bestE = thr;
      const bothDown = feet.R.planted && feet.L.planted;
      for (const f of BOTH) {
        if (!f.planted) continue;
        const other = f === feet.R ? feet.L : feet.R;
        // Fast shuffles gallop: the lead foot leaves as the trailing one lands.
        const gallop = lateral && speed > 1.5;
        const minGround = gallop ? 0.015 : STEP.minGround;
        const otherOk = other.planted ? other.ground >= minGround : (running && other.u > 0.55) || (gallop && other.u > 0.72);
        if (!otherOk || f.ground < minGround) continue;
        home(f, inp, STEP.lead, H);
        let err = Math.hypot(H.x - f.x, H.z - f.z);
        // Feet also re-plant to turn (pivot) once the body has rotated.
        err += Math.abs(wrapPi(H.yaw - f.yaw)) * 0.12;
        // Both feet down: starting from rest, the foot on the side of the motion leads (a shuffle
        // opens with the lead foot); otherwise feet alternate.
        if (bothDown) {
          const fresh = feet.R.ground > 0.25 && feet.L.ground > 0.25;
          const footRight = f === feet.R ? 1 : -1;
          if (fresh && lateral) {
            if (footRight * vRight > 0) err *= 1.5;
          } else if (f.side === state.lastStepSide) err *= 0.45;
        }
        if (err > bestE) {
          bestE = err;
          best = f;
        }
      }
      if (best) {
        const dur = running ? clamp(0.26 - 0.012 * speed, 0.17, 0.26) : lateral ? clamp(0.22 - 0.035 * speed, 0.14, 0.22) : clamp(0.32 - 0.03 * speed, 0.22, 0.32);
        const lh = running ? STEP.liftRun : lateral ? STEP.liftShuffle : STEP.liftWalk * clamp(0.5 + speed / 2, 0.5, 1);
        lift(best, inp, dur, lh);
      }
    }
    // Shuffles: the trailing foot never crosses the leading one.
    if (lateral && !running) {
      const R = feet.R, L = feet.L;
      const sepR = (R.x - L.x) * rx + (R.z - L.z) * rz; // R should be to the right of L
      if (sepR < STEP.minSep) {
        const fix = STEP.minSep - sepR;
        const mover = !R.planted ? R : !L.planted ? L : null;
        if (mover) {
          const s = mover === R ? 1 : -1;
          mover.x += rx * fix * s;
          mover.z += rz * fix * s;
        }
      }
    }

    state.airborne = (feet.R.planted ? 0 : 1) + (feet.L.planted ? 0 : 1);
    state.hopY = hopT >= 0 ? STEP.hopLift * 1.2 * Math.sin(Math.PI * clamp(hopT / STEP.hopTime, 0, 1)) : 0;
    state.stepping = !feet.R.planted || !feet.L.planted ? 1 : 0;
    // Pelvis bob: lowest while the legs are spread (double support), highest mid-swing.
    const swingU = !feet.R.planted && !feet.R.hop ? feet.R.u : !feet.L.planted && !feet.L.hop ? feet.L.u : -1;
    state.bob = swingU >= 0 ? (Math.sin(Math.PI * swingU) - 0.6) * clamp(speedS / 4, 0, 1) * 0.035 : -0.012 * clamp(speedS / 3, 0, 1);
    // Lateral sway toward the planted (weight-bearing) foot.
    const support = feet.R.planted && !feet.L.planted ? 1 : feet.L.planted && !feet.R.planted ? -1 : 0;
    state.sway += (support * 0.022 * clamp(speedS / 2, 0.2, 1) - state.sway) * (1 - Math.exp(-10 * dt));
    state.stride = Math.hypot(feet.R.x - feet.L.x, feet.R.z - feet.L.z);
    return state;
  }

  return { feet, state, reset, update, get speed() { return speedS; } };
}
