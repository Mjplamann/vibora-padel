// Simulation clock: maps performance.now() milliseconds (camera capture times) to sim
// seconds (world.time). Runs in lockstep with real time × speed; paused = frozen.
// simTimeOf() is linear while running, so pose capture times map consistently onto the
// ball history used for lag-compensated hits.

export function createSimClock({ speed = 1, now = () => performance.now() } = {}) {
  let anchorMs = now();
  let anchorSim = 0;
  let running = true;

  function simTimeOf(ms) {
    return running ? anchorSim + ((ms - anchorMs) * speed) / 1000 : anchorSim;
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
    },
    resume() {
      if (running) return;
      anchorMs = now();
      running = true;
    },
    /** Shifts the mapping by dSim seconds (used to drop time after a long frame hitch). */
    shift(dSim) {
      anchorSim += dSim;
    },
    get running() {
      return running;
    },
    get speed() {
      return speed;
    },
  };
}
