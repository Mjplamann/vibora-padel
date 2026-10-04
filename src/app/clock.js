// Simulation clock: maps performance.now() milliseconds (camera capture times) to sim
// seconds (world.time). Runs in lockstep with real time × speed × rate; paused = frozen.
// simTimeOf() is piecewise linear while running, so pose capture times map consistently onto
// the ball history used for lag-compensated hits.
//
// rate (setRate) is the learning slow motion off the glass (game.timeScale(), 0.7× around a
// glass contact). Every rate change re-anchors the mapping, and the anchors of the last ~3 s are
// kept: pose frames arrive 0.1–0.3 s after their capture, so a capture time from before a rate
// change must map with the rate of the segment it falls in (a single anchor would misplace it by
// up to ~90 ms).

const HISTORY_MS = 3000;
const MAX_SEGMENTS = 512;

export function createSimClock({ speed = 1, now = () => performance.now() } = {}) {
  let anchorMs = now();
  let anchorSim = 0;
  let running = true;
  let rate = 1;
  /** Earlier rate segments, ascending ms: segment i covers [segs[i].ms, segs[i+1].ms or anchorMs). */
  const segs = [];

  function simTimeOf(ms) {
    if (!running) return anchorSim;
    if (ms >= anchorMs || !segs.length) return anchorSim + ((ms - anchorMs) * speed * rate) / 1000;
    for (let i = segs.length - 1; i > 0; i--) {
      const s = segs[i];
      if (ms >= s.ms) return s.sim + ((ms - s.ms) * s.k) / 1000;
    }
    const s0 = segs[0];
    return s0.sim + ((ms - s0.ms) * s0.k) / 1000;
  }

  function prune(t) {
    while (segs.length > 1 && segs[1].ms < t - HISTORY_MS) segs.shift();
    if (segs.length && anchorMs < t - HISTORY_MS) segs.length = 0;
    while (segs.length > MAX_SEGMENTS) segs.shift();
  }

  return {
    simTimeOf,
    /** Current sim time. */
    now() {
      return simTimeOf(now());
    },
    pause() {
      if (!running) return;
      const t = now();
      anchorSim = simTimeOf(t);
      anchorMs = t;
      running = false;
      segs.length = 0;
    },
    resume() {
      if (running) return;
      anchorMs = now();
      running = true;
      segs.length = 0;
    },
    /**
     * Sim rate multiplier (1 = real time × speed; < 1 slow motion). Re-anchors at now() so the
     * sim time stays continuous; earlier capture times keep their own segment's rate.
     */
    setRate(r) {
      const v = Number.isFinite(r) && r > 0 ? Math.min(4, r) : 1;
      if (v === rate) return;
      if (running) {
        const t = now();
        const sim = simTimeOf(t);
        segs.push({ ms: anchorMs, sim: anchorSim, k: speed * rate });
        anchorSim = sim;
        anchorMs = t;
        prune(t);
      }
      rate = v;
    },
    /** Shifts the mapping by dSim seconds (used to drop time after a long frame hitch). */
    shift(dSim) {
      anchorSim += dSim;
      for (const s of segs) s.sim += dSim;
    },
    get running() {
      return running;
    },
    get speed() {
      return speed;
    },
    get rate() {
      return rate;
    },
  };
}
