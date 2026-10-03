// Rally referee: turns physics events (SPEC §2.2) and racket hits into padel
// rulings (FIP Reglamento de Juego). Pure module: no DOM, no three.
//
// Teams: 0 = near half (z > 0), 1 = far half (z < 0).
//
// Lifecycle of one point:
//   - With `serving = { team, box }` the referee waits for the serve
//     (`onHit(serving.team, { isServe: true })`). Events before that (the
//     server's drop bounce, a dead faulted ball still rolling) are ignored.
//   - With `serving = null` the ball is a fed ball (ball machine / coach feed)
//     and the referee starts already in the rally:
//       * default: the feed is judged as a shot by `feedTeam` (1, the machine's
//         team). A feed that lands out, hits the near glass on the full or dies
//         in the net is ruled exactly like an opponent's shot (point to team 0).
//       * `feedIsNeutral: true`: the feed itself is not judged. Only the
//         receiving player's subsequent shot is. If the player never plays it,
//         a second bounce (or an exit after a bounce) on the receiver's side is
//         ruled a 'double-bounce' / 'por-tres' / 'por-cuatro' against them with
//         detail 'missed'; a feed that never becomes playable ends 'dead-feed'.
//
// onOutcome fires exactly once per rally (or per serve attempt that ends in a
// fault or let), with:
//   { winner: 0|1|null, reason, label, pos: Vec3|null, detail: string|null,
//     by: team that last struck (or null), rallyLength, pointOver, replay, faults }
// `winner === null` happens only for 'serve-fault' (first fault: replay with a
// second serve), 'let' (replay, fault count unchanged) and 'dead-feed'.

import { Vec3 } from '../util/vec3.js';
import { COURT } from '../config.js';

export const OUTCOME_LABELS = Object.freeze({
  'double-bounce': 'Second bounce',
  net: 'Net',
  out: 'Out',
  'own-side': 'Own side',
  'serve-fault': 'Fault',
  'double-fault': 'Double fault',
  'volleyed-serve': 'Volleyed the serve',
  'por-tres': '¡Por tres!',
  'por-cuatro': '¡Por cuatro!',
  ceiling: 'Ceiling',
  winner: 'Winner',
  // Additions beyond SPEC §3.1 (documented in the module report):
  let: 'Let',
  'double-hit': 'Double hit',
  'dead-feed': 'No play',
});

/** Court half that a team defends. */
export function teamSide(team) {
  return team === 0 ? 'near' : 'far';
}

/** 'near' for z > 0, 'far' otherwise (local twin of court.sideOf). */
function sideOfZ(z) {
  return z > 0 ? 'near' : 'far';
}

/**
 * Diagonal service box test (SPEC §2.6). `box` is named from the receiver's
 * own view: near receiver (facing -z) has its right box at x >= 0, far receiver
 * (facing +z) at x <= 0. Lines count as in (the center line belongs to both).
 */
export function inDiagonalBox(x, z, receivingSide, box) {
  if (Math.abs(x) > COURT.halfWidth) return false;
  const L = COURT.serviceLine;
  if (receivingSide === 'near') {
    if (z <= 0 || z > L) return false;
    return box === 'right' ? x >= 0 : x <= 0;
  }
  if (z >= 0 || z < -L) return false;
  return box === 'right' ? x <= 0 : x >= 0;
}

function copyPos(p) {
  return p ? new Vec3(p.x, p.y, p.z) : null;
}

/** 'por-tres' over the back wall, 'por-cuatro' over the side wall. */
function exitReason(evt) {
  if (evt.via === 'side') return 'por-cuatro';
  if (evt.via === 'back') return 'por-tres';
  const p = evt.pos;
  if (p && Math.abs(p.x) >= COURT.halfWidth - 1e-6 && Math.abs(p.z) < COURT.halfLength) return 'por-cuatro';
  return 'por-tres';
}

/**
 * @param {object} o
 * @param {{team:0|1, box:'right'|'left'}|null} [o.serving]
 * @param {(outcome:object)=>void} [o.onOutcome]
 * @param {boolean} [o.feedIsNeutral] fed ball only: do not judge the feed itself
 * @param {0|1} [o.feedTeam] fed ball only: team credited with the feed (default 1, far)
 * @param {boolean} [o.ownMeshLegal] allow a shot to use the hitter's own wire mesh
 *   before crossing (default false: FIP rules it a lost point; own glass is legal)
 * @param {(x,z,side,box)=>boolean} [o.inBox] service box test, defaults to inDiagonalBox
 */
export function createReferee({
  serving = null,
  onOutcome = null,
  feedIsNeutral = false,
  feedTeam = 1,
  ownMeshLegal = false,
  inBox = inDiagonalBox,
} = {}) {
  const state = {
    phase: 'rally', // 'serve' | 'rally' | 'dead'
    serving: null, // { team, box } | null
    awaitingServe: false, // waiting for the server to strike
    isServe: false, // the ball in flight is a serve
    faults: 0, // faults already committed on this point (0 or 1)
    lastHitter: null, // 0 | 1 | null
    lastHitVolley: false,
    hits: 0, // strokes in this rally (serve included, feed excluded)
    fed: false, // ball was put in play by a feed (serving === null)
    neutralFeed: false, // feed in flight that is not judged
    feedTeam,
    bouncesOnSide: 0, // floor bounces on the receiving side since the last hit
    legalBounce: false, // ball has made its legal first bounce
    wallBeforeBounce: false, // touched the hitter's own glass before crossing
    wallsAfterBounce: 0,
    netTouched: false, // touched net body or cord since the last hit
    letPending: false, // serve clipped the net and landed in the box
    outcome: null, // last outcome object fired
  };

  function newShot(team, volley) {
    state.lastHitter = team;
    state.lastHitVolley = !!volley;
    state.bouncesOnSide = 0;
    state.legalBounce = false;
    state.wallBeforeBounce = false;
    state.wallsAfterBounce = 0;
    state.netTouched = false;
    state.letPending = false;
  }

  function fire(outcome) {
    state.outcome = outcome;
    if (onOutcome) onOutcome(outcome);
    return outcome;
  }

  function makeOutcome(winner, reason, pos, detail, pointOver) {
    return {
      winner,
      reason,
      label: OUTCOME_LABELS[reason],
      pos: copyPos(pos),
      detail: detail || null,
      by: state.lastHitter,
      rallyLength: state.hits,
      pointOver,
      replay: !pointOver,
      faults: state.faults,
    };
  }

  /** Ends the point. Ignored if the rally is already dead. */
  function end(winner, reason, pos, detail) {
    if (state.phase === 'dead') return null;
    state.phase = 'dead';
    state.isServe = false;
    state.neutralFeed = false;
    state.awaitingServe = false;
    return fire(makeOutcome(winner, reason, pos, detail, true));
  }

  function backToServe() {
    state.phase = 'serve';
    state.awaitingServe = true;
    state.isServe = false;
    state.hits = 0;
    newShot(null, false);
  }

  function serveFault(pos, detail) {
    if (state.phase === 'dead') return null;
    const server = state.serving.team;
    if (state.faults >= 1) {
      state.faults = 2;
      return end(1 - server, 'double-fault', pos, detail);
    }
    state.faults = 1;
    const o = makeOutcome(null, 'serve-fault', pos, detail, false);
    backToServe();
    return fire(o);
  }

  function callLet(pos) {
    const o = makeOutcome(null, 'let', pos, 'net', false);
    backToServe();
    return fire(o);
  }

  function reset({ serving: sv = null, feedIsNeutral: neutral = false, feedTeam: ft = state.feedTeam } = {}) {
    state.serving = sv ? { team: sv.team, box: sv.box === 'left' ? 'left' : 'right' } : null;
    state.faults = 0;
    state.outcome = null;
    state.feedTeam = ft;
    state.hits = 0;
    state.isServe = false;
    if (state.serving) {
      state.fed = false;
      state.neutralFeed = false;
      backToServe();
    } else {
      state.phase = 'rally';
      state.awaitingServe = false;
      state.fed = true;
      state.neutralFeed = !!neutral;
      newShot(neutral ? null : ft, false);
    }
  }

  // ---- hits ---------------------------------------------------------------

  function onHit(team, { isServe = false, volley = false } = {}) {
    if (team !== 0 && team !== 1) return false;
    if (state.phase === 'dead') return false;

    if (state.awaitingServe) {
      if (team !== state.serving.team) return false; // receiver cannot start the point
      state.awaitingServe = false;
      state.isServe = true;
      state.phase = 'serve';
      state.hits = 1;
      newShot(team, false);
      return true;
    }

    if (state.isServe) {
      const server = state.lastHitter;
      if (team === server) {
        end(1 - team, 'double-hit', null, 'server struck twice');
        return true;
      }
      if (state.letPending) {
        callLet(null);
        return true;
      }
      if (!state.legalBounce) {
        end(server, 'volleyed-serve', null, null);
        return true;
      }
      state.isServe = false;
      state.phase = 'rally';
      state.hits++;
      newShot(team, volley);
      return true;
    }

    if (state.neutralFeed) {
      if (team === state.feedTeam) return false; // the feeder itself, not judged
      state.neutralFeed = false;
      state.hits = 1;
      newShot(team, volley);
      return true;
    }

    // Rally.
    if (team === state.lastHitter) {
      if (state.fed && state.hits === 0) {
        newShot(team, false); // integrator announcing the feed itself
        return true;
      }
      end(1 - team, 'double-hit', null, null);
      return true;
    }
    state.hits++;
    newShot(team, volley);
    return true;
  }

  // ---- physics events -----------------------------------------------------

  function onNeutralEvent(evt) {
    const ft = state.feedTeam;
    const recvSide = teamSide(1 - ft);
    switch (evt.type) {
      case 'bounce': {
        const side = evt.side || sideOfZ(evt.pos.z);
        if (side !== recvSide) return; // the feed's own business
        state.bouncesOnSide++;
        state.legalBounce = true;
        if (state.bouncesOnSide >= 2) end(ft, 'double-bounce', evt.pos, 'missed');
        return;
      }
      case 'exit':
      case 'outside-bounce':
        if (state.bouncesOnSide >= 1) end(ft, exitReason(evt), evt.pos, 'missed');
        else end(null, 'dead-feed', evt.pos, evt.type);
        return;
      case 'ceiling':
        if (state.bouncesOnSide >= 1) end(ft, 'ceiling', evt.pos, 'missed');
        else end(null, 'dead-feed', evt.pos, 'ceiling');
        return;
      case 'rest':
        if (state.bouncesOnSide >= 1) end(ft, 'double-bounce', evt.pos, 'missed');
        else end(null, 'dead-feed', evt.pos, 'rest');
        return;
      default:
        // walls, net, cord: the feed is not judged
    }
  }

  function beforeBounce(evt, T, R) {
    const hitterSide = teamSide(T);
    const recvSide = teamSide(R);
    const serve = state.isServe;
    switch (evt.type) {
      case 'bounce': {
        const side = evt.side || sideOfZ(evt.pos.z);
        if (side === recvSide) {
          if (serve) {
            if (!inBox(evt.pos.x, evt.pos.z, recvSide, state.serving.box)) {
              serveFault(evt.pos, state.netTouched ? 'net then out of the box' : 'out of the box');
              return;
            }
            if (state.netTouched) state.letPending = true;
          }
          state.legalBounce = true;
          state.bouncesOnSide = 1;
          return;
        }
        if (serve) serveFault(evt.pos, state.netTouched ? 'net' : 'own side');
        else end(R, state.netTouched ? 'net' : 'own-side', evt.pos, null);
        return;
      }
      case 'wall': {
        const side = evt.side || sideOfZ(evt.pos.z);
        if (serve) {
          serveFault(evt.pos, evt.surface === 'mesh' ? 'fence before the bounce' : 'wall before the bounce');
          return;
        }
        if (side === hitterSide) {
          if (evt.surface === 'mesh' && !ownMeshLegal) {
            end(R, 'own-side', evt.pos, 'own fence');
            return;
          }
          state.wallBeforeBounce = true;
          return;
        }
        end(R, 'out', evt.pos, evt.surface === 'mesh' ? 'fence before the bounce' : 'glass before the bounce');
        return;
      }
      case 'net':
      case 'netcord':
        state.netTouched = true;
        return;
      case 'exit':
      case 'outside-bounce':
        if (serve) serveFault(evt.pos, 'out');
        else end(R, 'out', evt.pos, 'left the court before the bounce');
        return;
      case 'ceiling':
        if (serve) serveFault(evt.pos, 'ceiling');
        else end(R, 'ceiling', evt.pos, null);
        return;
      case 'rest':
        if (serve) serveFault(evt.pos, state.netTouched ? 'net' : 'no bounce');
        else end(R, state.netTouched ? 'net' : 'own-side', evt.pos, null);
        return;
      default:
    }
  }

  function afterBounce(evt, T) {
    const serve = state.isServe;
    const letNow = serve && state.letPending;
    switch (evt.type) {
      case 'bounce':
        state.bouncesOnSide++;
        if (letNow) callLet(evt.pos);
        else end(T, 'double-bounce', evt.pos, serve ? 'ace' : null);
        return;
      case 'wall':
        state.wallsAfterBounce++;
        // Serve: the wire mesh before the second bounce is a fault, even on a let.
        if (serve && evt.surface === 'mesh') serveFault(evt.pos, 'fence after the bounce');
        return;
      case 'net':
      case 'netcord':
        return; // ball drifting back over the net; the receiver still has to play it
      case 'exit':
      case 'outside-bounce':
        if (letNow) callLet(evt.pos);
        else end(T, exitReason(evt), evt.pos, serve ? 'ace' : null);
        return;
      case 'ceiling':
        if (letNow) callLet(evt.pos);
        else end(T, 'ceiling', evt.pos, null);
        return;
      case 'rest':
        if (letNow) callLet(evt.pos);
        else end(T, 'winner', evt.pos, null);
        return;
      default:
    }
  }

  function onEvent(evt) {
    if (!evt || state.phase === 'dead' || state.awaitingServe) return;
    if (state.neutralFeed) {
      onNeutralEvent(evt);
      return;
    }
    const T = state.lastHitter;
    if (T !== 0 && T !== 1) return;
    if (state.legalBounce) afterBounce(evt, T);
    else beforeBounce(evt, T, 1 - T);
  }

  // ---- queries ------------------------------------------------------------

  /** Whether `team` may legally strike the ball right now. */
  function canHit(team) {
    if (state.phase === 'dead') return false;
    if (state.awaitingServe) return team === state.serving.team;
    if (state.isServe) return team !== state.lastHitter && state.legalBounce;
    if (state.neutralFeed) return team !== state.feedTeam;
    return team !== state.lastHitter;
  }

  /**
   * Whether a contact by `team` should be reported to onHit (it will be judged,
   * possibly as a fault). Unlike canHit this is true for a receiver swinging at
   * a serve before it bounces, so a volleyed serve costs the point as in padel.
   */
  function canContact(team) {
    if (state.phase === 'dead') return false;
    if (state.isServe) return team !== state.lastHitter;
    return canHit(team);
  }

  /** External ruling (e.g. ball hits a player's body): ends the point. */
  function award(team, reason = 'winner', pos = null, detail = null) {
    return end(team, OUTCOME_LABELS[reason] ? reason : 'winner', pos, detail);
  }

  reset({ serving, feedIsNeutral, feedTeam });

  return {
    onHit,
    onEvent,
    canHit,
    canContact,
    award,
    reset,
    get state() {
      return state;
    },
  };
}
