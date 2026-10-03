// Autopilot feed: the virtual player (tracking/autopilot.js) rendered by the synthetic camera
// at 30 fps of sim time, delivered `delivery` s later (pose inference) into the REAL pipeline
// through human.onPoseFrame. Used by ?autopilot=1, the title-screen attract mode and the smoke
// test. Nothing is short-circuited: hits come from the tracked synthetic body.
import { createRng } from '../util/math.js';
import { createAutopilot } from '../tracking/autopilot.js';
import { createSyntheticCamera } from '../tracking/synthetic.js';

const FAMILY_STROKE = { fh: 'forehand', bh: 'backhand', vfh: 'volley-fh', vbh: 'volley-bh', oh: 'bandeja', sm: 'smash' };

export function createAutopilotFeed({ handed = 'right', height = 1.75, hfovDeg = 68, seed = 1, fps = 30, delivery = 0.045, skill = 0.9 } = {}) {
  const cam = createSyntheticCamera({ hfovDeg });
  const ap = createAutopilot({ rng: createRng(seed), handed, height, skill });
  const pending = [];
  let nextFrame = null;
  let lastFrame = null;

  /** Call before every stepWorld: captures and delivers synthetic frames on the sim clock. */
  function beforeTick(world, human, onFrame = null) {
    if (nextFrame === null) nextFrame = world.time;
    // The synthetic pipeline's delays are known exactly: they drive the adaptive judge margin.
    if (world.tracking) {
      world.tracking.delay = delivery;
      world.tracking.frameDt = 1 / fps;
    }
    if (world.time >= nextFrame - 1e-9) {
      const body = ap.update(world, world.time);
      pending.push({ at: world.time + delivery, frame: cam.frame(world.time * 1000, [body]), t: world.time });
      nextFrame += 1 / fps;
      if (nextFrame < world.time) nextFrame = world.time + 1 / fps;
    }
    while (pending.length && pending[0].at <= world.time + 1e-9) {
      const f = pending.shift();
      lastFrame = f.frame;
      const sample = human.onPoseFrame(world, f.frame, f.t);
      if (onFrame) onFrame(f.frame, sample);
    }
  }

  /**
   * The stroke the virtual player is playing right now, for a third-person humanoid
   * (attract mode): { stroke, swingPhase, holding } keyed to the planned contact time.
   */
  function actorStroke(world) {
    const p = ap.plan;
    if (!p || p.none || !Number.isFinite(p.t)) return null;
    const stroke = world.flight.by === 'drop' ? 'serve' : FAMILY_STROKE[p.fam] || 'forehand';
    const dur = stroke.startsWith('volley') ? 0.6 : 0.9;
    const phase = 0.55 + (world.time - p.t) / dur;
    if (phase < 0 || phase > 1) return null;
    return { stroke, swingPhase: phase, holding: 'swing' };
  }

  return {
    beforeTick,
    actorStroke,
    reset() {
      pending.length = 0;
      nextFrame = null;
      ap.reset();
    },
    get autopilot() { return ap; },
    get lastFrame() { return lastFrame; },
    /** Sim time of the planned contact (or null). */
    get nextContact() {
      const p = ap.plan;
      return p && !p.none && Number.isFinite(p.t) ? p.t : null;
    },
  };
}
