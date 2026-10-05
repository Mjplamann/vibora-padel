// Coach and AI players (SPEC §6.7): smooth skinned athletes (skinnedHuman.js — one SkinnedMesh
// with a 22-bone skeleton and blended weights, kit, skin tone, hair and headwear) animated
// procedurally from the actor state (animation/animator.js: stroke library keyed by swingPhase,
// foot planting, split-steps, reactions, looking at the ball). Same API as the old rigid
// mannequin: createHumanoid(opts) -> { root, update(actorState, dt, ctx?), setHanded(h), racket }.
import { createSkinnedHuman, kitFor } from './skinnedHuman.js';
import { createActorAnimator } from './animation/animator.js';
import { STROKE_NAMES } from './animation/strokes.js';
import { buildActorRacket } from './actorRacket.js';

/**
 * @param {object} o
 * @param {string} [o.shirt] [o.shorts] [o.skin] [o.cap] [o.shoe] [o.accent]  legacy kit colours
 * @param {object} [o.kit] full kit (skinnedHuman.js DEFAULT_KIT fields); wins over the legacy colours
 * @param {string} [o.seed] seed for the generated parts of the kit (hair, skin tone, headwear…)
 * @param {'right'|'left'} [o.handed]
 * @param {THREE.Group} [o.racket] racket to hold (default: a one-draw-call actor racket)
 * @param {string} [o.racketColor]
 * @param {number|null} [o.height] m (null: the kit's height — kitFor gives every person one)
 * @param {0|1|'auto'} [o.lod]
 * @returns {{ root, update(actorState, dt, ctx?), setHanded(h), setKit(k), setLodFor(camPos), racket, human, animator, handed }}
 *   ctx (optional): { time, ball: {x,y,z}|null, cue, partner: {x,z}|null, racket: {grip, axis, normal}|null }
 */
export function createHumanoid({
  shirt, shorts, skin, cap, shoe, accent, kit = null, seed = 'humanoid', handed = 'right', racket = null, racketColor = '#e8572a',
  height = null, lod = 'auto',
} = {}) {
  const base = {};
  if (shirt) base.shirt = shirt;
  if (shorts) base.shorts = shorts;
  if (skin) base.skin = skin;
  if (accent) base.trim = accent;
  if (shoe) base.shoe = shoe;
  if (cap) {
    base.headwear = cap;
    base.headwearKind = 'cap';
  }
  const k = kitFor(seed, { ...base, ...(kit || {}) });
  const racketObj = racket || buildActorRacket({ color: racketColor });
  racketObj.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  const human = createSkinnedHuman({ kit: k, handed, height, lod, racket: racketObj });
  const animator = createActorAnimator(human);
  const ctx0 = {};

  return {
    root: human.root,
    human,
    animator,
    racket: racketObj,
    get handed() { return human.handed; },
    update(state, dt = 1 / 60, ctx = ctx0) {
      if (!state) return;
      animator.update(state, dt, ctx || ctx0);
    },
    setHanded(h) {
      human.setHanded(h);
    },
    setKit(kk) {
      human.setKit(kk);
    },
    setLodFor(camPos) {
      human.setLodFor(camPos);
    },
    dispose() {
      human.dispose();
      // The serve routine's ball (animator.js) lives on the rig: free it with the person (QA r5:
      // one sphere geometry stayed on the GPU per match).
      const b = animator.ball;
      if (b) {
        b.removeFromParent();
        b.geometry.dispose();
        b.material.dispose();
      }
    },
  };
}

export const HUMANOID_STROKES = STROKE_NAMES;
