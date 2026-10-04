// Presence director (pure: no three). Reads the world each frame and the bus events of the
// render layer (never changes game logic) and hands every person on court a few cues:
//   split    a split-step hop timed to land as the other side strikes (an AI swing reaching its
//            contact, the ball machine about to fire, the player's planned contact)
//   react    'celebrate' (fist pump, racket up) or 'frustrate' (head down, hand on the hip) after a
//            rally outcome ('rally:outcome')
//   five     partners turn to each other and slap hands (or tap rackets) between points
//   serve    the server's pre-serve routine (bouncing the ball) while a serve is awaited
// People are keyed by their actor object; the human player by PLAYER_KEY.

export const PLAYER_KEY = 'player';

export const DIRECTOR = Object.freeze({
  splitLead: 0.16, // s before the opponent's contact the hop starts
  splitLand: 0.05, // s after the contact the feet land
  splitGap: 0.9, // s between two split-steps of one person
  reactDelay: 0.25, reactDur: 1.5, // s
  moodDur: 2.5, // s: a match player's celebrate / dejected mood (state.mood) from the point
  fiveDelay: 0.75, fiveDur: 1.3, fiveReach: 3.2, // s, s, m
});

const TEAMS = [0, 1];

/** Team of a ShotRecord / launch tag (0 near, 1 far). */
function teamOf(by, team) {
  if (team === 0 || team === 1) return team;
  if (by === 'player' || by === 'drop') return 0;
  return 1;
}

/**
 * @returns {{ attach(world), detach(), update(world, people), cue(key) -> Cue, events }}
 * people: [{ key, team, pos: {x,z}, state? }] — everyone on court this frame (AI actors with their
 * state, the human player with PLAYER_KEY).
 * Cue = { split: { t0, tLand } | null, react: { kind, t0, dur } | null, five: { with: {x,z}, t0, dur,
 *         height } | null, serve: { at } | null }
 */
export function createDirector() {
  const cues = new Map();
  let world = null;
  let unsubs = [];
  const pending = []; // bus events to apply on the next update (with their world time)
  const events = { outcomes: 0, hits: 0, splits: 0, fives: 0 };

  function cueOf(key) {
    let c = cues.get(key);
    if (!c) {
      c = { split: null, react: null, five: null, serve: null, lastSplit: -Infinity, moodAt: null };
      cues.set(key, c);
    }
    return c;
  }

  function attach(w) {
    if (w === world) return;
    detach();
    world = w;
    cues.clear();
    if (!w || !w.bus || typeof w.bus.on !== 'function') return;
    const on = (type) => unsubs.push(w.bus.on(type, (p) => pending.push({ type, p, t: w.time })));
    on('rally:outcome');
    on('ball:hit');
  }

  function detach() {
    for (const u of unsubs) if (typeof u === 'function') u();
    unsubs = [];
    world = null;
    pending.length = 0;
  }

  /** Next contact time of team `team` (an AI swing, the machine, the player's plan), or null. */
  let best = null;
  let nowT = 0;
  function consider(t) {
    if (t > nowT - 0.02 && (best === null || t < best)) best = t;
  }
  function nextContact(w, team, people) {
    const now = w.time;
    nowT = now;
    best = null;
    for (const p of people) {
      if (p.team !== team || !p.state) continue;
      const s = p.state;
      if (s.holding === 'swing' && s.stroke && s.swingPhase > 0.05 && s.swingPhase < 0.62) {
        const cp = s.stroke === 'smash' || s.stroke === 'serve' ? 0.6 : 0.55;
        const dur = s.swingT > 0 && s.swingPhase > 0 ? s.swingT / s.swingPhase : 0.9;
        consider(now + (cp - s.swingPhase) * dur);
      }
    }
    if (team === 1 && w.machine && w.machine.state && w.machine.state.feeding) {
      const ni = w.machine.state.nextIn;
      if (Number.isFinite(ni) && ni >= 0 && ni < 1) consider(now + ni);
    }
    if (team === 0) {
      const plan = w.timing && w.timing.plan;
      if (plan && Number.isFinite(plan.tStar) && w.ball && !w.ball.atRest) consider(plan.tStar);
      const ic = w.mode && w.mode.tactics && w.mode.tactics.state && w.mode.tactics.state.intercept;
      if (!plan && ic && Number.isFinite(ic.t)) consider(ic.t);
    }
    return best;
  }

  /** Server of the current point in a match (team, player) and whether the serve is awaited. */
  function serverOf(w) {
    const st = w.mode && w.mode.state;
    const sv = st && st.serving;
    if (!sv || !w.referee || !w.referee.state || !w.referee.state.awaitingServe) return null;
    return sv;
  }

  function update(w, people) {
    if (!w) return;
    if (w !== world) attach(w);
    const now = w.time;
    // Bus events.
    for (const e of pending) {
      if (e.type === 'rally:outcome') {
        events.outcomes++;
        const win = e.p && (e.p.winner === 0 || e.p.winner === 1) ? e.p.winner : null;
        if (win === null) continue;
        for (const p of people) {
          if (p.team !== 0 && p.team !== 1) continue;
          const c = cueOf(p.key);
          c.react = { kind: p.team === win ? 'celebrate' : 'frustrate', t0: e.t + DIRECTOR.reactDelay, dur: DIRECTOR.reactDur };
        }
        // Partners meet for a high five (both teams in a match; the AI partner offers it to you).
        for (const team of TEAMS) {
          const mates = people.filter((p) => p.team === team);
          if (mates.length !== 2) continue;
          const [a, b] = mates;
          const d = Math.hypot(a.pos.x - b.pos.x, a.pos.z - b.pos.z);
          if (d > DIRECTOR.fiveReach * 2.2) continue;
          events.fives++;
          const height = 1.5;
          cueOf(a.key).five = { with: b.key, t0: e.t + DIRECTOR.fiveDelay, dur: DIRECTOR.fiveDur, height, near: d < DIRECTOR.fiveReach };
          cueOf(b.key).five = { with: a.key, t0: e.t + DIRECTOR.fiveDelay, dur: DIRECTOR.fiveDur, height, near: d < DIRECTOR.fiveReach };
        }
      } else if (e.type === 'ball:hit') {
        const shot = e.p && e.p.shot;
        if (!shot) continue;
        events.hits++;
        // A strike nobody anticipated (the player's own swing seen late, a hand feed): the other
        // side split-steps now.
        const hitter = teamOf(shot.by, shot.team);
        for (const p of people) {
          if (p.team === hitter || (p.team !== 0 && p.team !== 1)) continue;
          const c = cueOf(p.key);
          if (now - c.lastSplit > DIRECTOR.splitGap && (!c.split || c.split.tLand < e.t - 0.1)) {
            c.split = { t0: e.t - 0.04, tLand: e.t + 0.16 };
            c.lastSplit = e.t;
            events.splits++;
          }
        }
      }
    }
    pending.length = 0;
    // Anticipated split-steps.
    for (const team of TEAMS) {
      const tc = nextContact(w, team, people);
      if (tc === null) continue;
      if (tc - now > DIRECTOR.splitLead || tc - now < -0.02) continue;
      for (const p of people) {
        if (p.team === team || (p.team !== 0 && p.team !== 1)) continue;
        const c = cueOf(p.key);
        if (now - c.lastSplit < DIRECTOR.splitGap) continue;
        c.split = { t0: now, tLand: tc + DIRECTOR.splitLand };
        c.lastSplit = now;
        events.splits++;
      }
    }
    // Serve routine.
    const sv = serverOf(w);
    for (const p of people) {
      const c = cueOf(p.key);
      const serving = sv && p.team === sv.team && p.serverIndex === sv.player && (!w.ball || w.ball.atRest || (w.flight && w.flight.by === 'drop'));
      c.serve = serving ? { at: p.state && Number.isFinite(p.state.serveAt) ? p.state.serveAt : null } : null;
      // A match player's mood after a point (game/modes.js state.mood { kind: 'celebrate' | 'dejected', at }):
      // the reaction lasts DIRECTOR.moodDur from the point (longer than the bus-driven one above).
      const mood = p.state && p.state.mood;
      if (mood && Number.isFinite(mood.at) && mood.at !== c.moodAt && now - mood.at < DIRECTOR.moodDur) {
        c.moodAt = mood.at;
        c.react = { kind: mood.kind === 'celebrate' ? 'celebrate' : 'frustrate', t0: mood.at + DIRECTOR.reactDelay, dur: DIRECTOR.moodDur - DIRECTOR.reactDelay };
      }
      // Expire old cues.
      if (c.split && now > c.split.tLand + 0.3) c.split = null;
      if (c.react && now > c.react.t0 + c.react.dur) c.react = null;
      if (c.five && now > c.five.t0 + c.five.dur) c.five = null;
    }
  }

  return {
    attach,
    detach,
    update,
    cue(key) { return cueOf(key); },
    /** Position of a person by key from the last people list (for high fives). */
    events,
  };
}

/** 0..1 envelope of a cue window [t0, t0 + dur] with fade in / out times. */
export function envelope(now, t0, dur, fadeIn = 0.2, fadeOut = 0.35) {
  const t = now - t0;
  if (t <= 0 || t >= dur) return 0;
  const a = Math.min(1, t / fadeIn);
  const b = Math.min(1, (dur - t) / fadeOut);
  const e = Math.min(a, b);
  return e * e * (3 - 2 * e);
}
