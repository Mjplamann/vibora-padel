// The crowd's mind (pure: no DOM, no audio): turns the world's bus events into reactions for the
// venue's stands (render/crowd.js via env.react) and its sound (engine.crowd):
//   'hush' before a serve, 'murmur' back between points,
//   'ooh' at a retrieve off the glass or a long rally, 'aah' at a por tres exit,
//   'applause' for winners (louder after long rallies), 'cheer' / 'roar' for great points,
//   'groan' for the player's errors (never in drills: nobody groans at a learner).
// The crowd backs the player's pair (team 0); a rival's winner gets polite applause.

const ERRORS = new Set(['net', 'out', 'own-side', 'double-fault', 'ceiling', 'volleyed-serve']);
const WINNERS = new Set(['winner', 'double-bounce']);
const EXITS = new Set(['por-tres', 'por-cuatro']);

/**
 * @param {{ onReact: (kind, level, info) => void, mode?: () => 'drill'|'rally'|'match'|null,
 *   now?: () => number (s), oohGap?: number }} o
 */
export function createCrowdDirector({ onReact = () => {}, mode = () => 'match', now = () => 0, oohGap = 3.5 } = {}) {
  let hits = 0;
  let inPoint = false;
  let lastOoh = -Infinity;
  let murmurAt = Infinity;
  const log = [];
  const react = (kind, level, info = null) => {
    const l = Math.max(0, Math.min(1, level));
    log.push({ t: now(), kind, level: l });
    if (log.length > 60) log.shift();
    onReact(kind, l, info);
  };
  const drill = () => mode() === 'drill';

  const api = {
    get hits() {
      return hits;
    },
    get log() {
      return log.slice();
    },
    /** A ball comes into play: the arena hushes for the serve / feed. */
    onLaunch() {
      // Coach / AI shots are launches too: only the first one after a ruling starts a point.
      if (inPoint) return;
      hits = 0;
      inPoint = true;
      murmurAt = Infinity;
      if (!drill()) react('hush', 1);
    },
    onHit({ shot } = {}) {
      if (!shot || shot.provisional) return;
      hits++;
      const t = now();
      if (t - lastOoh < oohGap) return;
      const glass = !!shot.afterWall;
      const long = hits >= 8 && hits % 4 === 0;
      if ((glass && hits >= 3) || long) {
        lastOoh = t;
        react('ooh', Math.min(1, 0.45 + hits * 0.04));
      }
    },
    onOutcome(o = {}) {
      inPoint = false;
      const { winner, reason } = o;
      murmurAt = now() + 3;
      if (winner !== 0 && winner !== 1) return;
      const k = drill() ? 0.6 : 1;
      const longRally = Math.min(1, hits / 14);
      if (EXITS.has(reason)) {
        react('aah', 0.8 * k);
        react(winner === 0 ? 'roar' : 'cheer', (winner === 0 ? 1 : 0.6) * k, { board: 5 });
        return;
      }
      const score = o.score;
      if (winner === 0) {
        if (WINNERS.has(reason)) {
          if (hits >= 10) react('cheer', (0.65 + 0.35 * longRally) * k, { board: 4 });
          else react('applause', (0.5 + 0.4 * longRally) * k, { board: 4 });
        } else react('applause', 0.35 * k);
        if (score && score.isOver) react('roar', 1);
      } else if (ERRORS.has(reason)) {
        if (!drill()) react('groan', 0.55 + 0.3 * longRally);
      } else {
        react('applause', 0.3 * k);
      }
    },
    onMatchEnd({ summary } = {}) {
      const won = summary && summary.winner === 0;
      react(won ? 'roar' : 'applause', won ? 1 : 0.6, { board: won ? 4 : 0 });
    },
    /** Call every frame (or tick): brings the murmur back a few seconds after a point. */
    update() {
      if (now() >= murmurAt) {
        murmurAt = Infinity;
        react('murmur', 1);
      }
    },
    /** Subscribes to a world bus. Returns an unsubscribe fn. */
    bindBus(bus) {
      const offs = [
        bus.on('ball:launch', (p) => api.onLaunch(p)),
        bus.on('ball:hit', (p) => api.onHit(p)),
        bus.on('rally:outcome', (p) => api.onOutcome(p)),
        bus.on('match:end', (p) => api.onMatchEnd(p)),
      ];
      return () => offs.forEach((off) => off && off());
    },
  };
  return api;
}
