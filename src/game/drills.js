// Training curriculum (SPEC §5.4): 13 drills with realistic feeds, target zones,
// scoring and coaching cues. Coordinates are for a right-handed player on the near half
// (z > 0, facing -z); `mirrorDrill` mirrors x for a left-hander. Speeds in km/h.
// Pure module: data + pure functions.
//
// Feed extensions used here (machine.planFeed understands them): via {x,y,z} (the ball
// must pass this point: volleys at chest height), offsetX (launch point x offset of the
// machine head, e.g. corner feeds and serves), launchHeight, drop (serve drill: the
// mode drops the ball next to the player), drillId (live mix).
//
// `ap` holds hints for the autopilot (contact type, stroke family, aim) and `opponents`
// optional static opponents for the renderer.

import { COURT } from '../config.js';

const Z_SVC = COURT.serviceLine;

/** Speed (km/h) above which a bandeja is penalised: it is a control shot. */
export const BANDEJA_MAX_KMH = 85;
/** Chiquita must be softer than this (km/h) and clear the net by less than CHIQUITA_MAX_CLEAR (m). */
export const CHIQUITA_MAX_KMH = 45;
export const CHIQUITA_MAX_CLEAR = 0.5;
/** Lob over net players: apex (ball centre) above this (m). */
export const LOB_MIN_APEX = 4.5;
/** Drive net-clearance bonus threshold (m above the tape). */
export const DRIVE_CLEARANCE_BONUS = 0.9;

const OVERHEADS = new Set(['bandeja', 'vibora', 'smash']);

const zone = (id, label, x0, x1, z0, z1, points, kind = 'land') => Object.freeze({ id, label, x0, x1, z0, z1, points, kind });

/** Whether a court point {x, z} lies inside a zone (lines count as in). */
export function inZone(zn, p) {
  return !!p && p.x >= zn.x0 - 1e-9 && p.x <= zn.x1 + 1e-9 && p.z >= zn.z0 - 1e-9 && p.z <= zn.z1 + 1e-9;
}

/** Best-scoring 'land' zone of a drill containing p, or null. */
export function landZone(drill, p) {
  let best = null;
  for (const zn of drill.targets) {
    if (zn.kind !== 'land' || !inZone(zn, p)) continue;
    if (!best || zn.points > best.points) best = zn;
  }
  return best;
}

const kmh = (shot) => (shot && Number.isFinite(shot.speedOut) ? shot.speedOut * 3.6 : 0);
const clearance = (shot) => (shot && Number.isFinite(shot.netClearance) ? shot.netClearance : null);

function base(result) {
  return { points: 0, success: false, notes: [] };
}

/** Faults that end a rep regardless of the drill: returns notes or null. */
function failNotes(result) {
  switch (result.reason) {
    case 'net': return ['Lift it: clear the net by half a metre to a metre'];
    case 'out': return [result.detail && result.detail.includes('fence') ? 'Too long – it hit the fence on the full' : 'Too long – it hit the glass on the full; more topspin or less pace'];
    case 'own-side': return ['Hit up and through – the ball stayed on your side'];
    case 'volleyed-serve': return ['Let the serve bounce before you return it'];
    case 'double-hit': return ['One clean stroke – no double hits'];
    default: return null;
  }
}

// ---------------------------------------------------------------------------
// Scoring per drill

function scoreDrive(drill, shot, result) {
  const r = base(result);
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  r.points = zn ? zn.points : 30;
  r.success = !!zn;
  if (!zn) r.notes.push('Aim deeper and cross-court, past the service line');
  const c = clearance(shot);
  if (zn && c !== null && c < DRIVE_CLEARANCE_BONUS) {
    r.points += 25;
    r.notes.push('Flat and penetrating – great net clearance');
  }
  return r;
}

function scoreBackGlass(drill, shot, result) {
  const r = base(result);
  if (!shot.afterWall) {
    r.notes.push('Let it come off the glass first');
    return r;
  }
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  if (zn) {
    r.points = zn.points;
    r.success = true;
  } else r.notes.push('Good read off the glass – now send it deep');
  return r;
}

function scoreVolley(drill, shot, result) {
  const r = base(result);
  if (shot.afterBounce) {
    r.notes.push('Volley it – take the ball before it bounces');
    return r;
  }
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  r.points = zn ? zn.points : 30;
  r.success = !!zn;
  if (!zn) r.notes.push('Punch it deep into the corners');
  return r;
}

function requireOverhead(shot, r) {
  if (!OVERHEADS.has(shot.stroke)) {
    r.notes.push('Take it in the air, above your head');
    return false;
  }
  return true;
}

function scoreBandeja(drill, shot, result) {
  const r = base(result);
  if (!requireOverhead(shot, r)) return r;
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  r.points = zn ? zn.points : 30;
  r.success = !!zn;
  if (!zn) r.notes.push('Deeper – make them play off the back glass');
  if (kmh(shot) > BANDEJA_MAX_KMH) {
    r.points = Math.round(r.points * 0.5);
    r.success = false;
    r.notes.push('Control, not power – the bandeja keeps you at the net');
  }
  return r;
}

function scoreVibora(drill, shot, result) {
  const r = base(result);
  if (!requireOverhead(shot, r)) return r;
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  r.points = zn ? zn.points : 30;
  r.success = !!zn;
  if (!zn) r.notes.push('Aim for the side-glass corner');
  if (result.sideGlassAfterBounce) {
    r.points += 50;
    r.notes.push('¡Víbora! It died off the side glass');
  }
  return r;
}

function scoreSmash(drill, shot, result) {
  const r = base(result);
  if (!requireOverhead(shot, r)) return r;
  if (result.reason === 'por-tres') {
    r.points = 100 + 500;
    r.success = true;
    r.notes.push('¡Por tres! Out over the back wall');
    return r;
  }
  if (result.reason === 'por-cuatro') {
    r.points = 100 + 250;
    r.success = true;
    r.notes.push('¡Por cuatro! Out over the side');
    return r;
  }
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  r.points = zn ? zn.points : 20;
  r.success = !!zn;
  if (!zn) r.notes.push('Hit down: land it between the service line and the net');
  if (shot.stroke !== 'smash') r.notes.push('Hit through it – full smash');
  return r;
}

function scoreLob(drill, shot, result) {
  const r = base(result);
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const high = (shot.apex ?? 0) > LOB_MIN_APEX;
  const zn = landZone(drill, result.landing);
  if (zn && high) {
    r.points = zn.points;
    r.success = true;
  } else {
    r.points = high ? 30 : 10;
    if (!high) r.notes.push('Higher – over the volleyers\' reach (above 4.5 m)');
    if (!zn) r.notes.push('Deeper – land it in the last 2.5 m');
  }
  return r;
}

function scoreChiquita(drill, shot, result) {
  const r = base(result);
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep it in the court']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  const soft = kmh(shot) < CHIQUITA_MAX_KMH;
  const c = clearance(shot);
  const low = c !== null && c < CHIQUITA_MAX_CLEAR;
  if (zn && soft && low) {
    r.points = zn.points;
    r.success = true;
    return r;
  }
  r.points = zn ? 40 : 10;
  if (!soft) r.notes.push('Softer – take pace off so it dies at their feet');
  if (!low) r.notes.push('Lower over the net – make them volley up');
  if (!zn) r.notes.push('Land it short, between the net and the service line');
  return r;
}

function scoreServe(drill, shot, result, ctx = {}) {
  const r = base(result);
  const hip = ctx.hipHeight ?? 0.53 * (ctx.height ?? 1.75);
  if (shot.contact && shot.contact.y > hip + 0.02) {
    r.notes.push('Serve at or below the waist (FIP rule)');
    return r;
  }
  if (result.reason === 'serve-fault' || result.reason === 'double-fault') {
    r.notes.push(result.detail === 'out of the box' ? 'Land it in the diagonal box' : `Fault – ${result.detail || 'try again'}`);
    return r;
  }
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Land it in the diagonal box']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  if (!zn) {
    r.notes.push('Land it in the diagonal box');
    return r;
  }
  r.points = zn.points;
  r.success = true;
  if (result.landing && -result.landing.z >= Z_SVC - 1.0) {
    r.points += 50;
    r.notes.push('Deep serve – within a metre of the service line');
  }
  if (result.sideGlassAfterBounce) {
    r.points += 50;
    r.notes.push('Into the side glass – hard to return');
  }
  return r;
}

function scoreReturn(drill, shot, result) {
  const r = base(result);
  if (!result.legal) {
    r.notes.push(...(failNotes(result) || ['Keep the return in play']));
    return r;
  }
  const zn = landZone(drill, result.landing);
  const lob = (shot.apex ?? 0) > LOB_MIN_APEX && result.landing && result.landing.z <= -7;
  if (zn || lob) {
    r.points = 100;
    r.success = true;
    if (lob && !zn) r.notes.push('Good lob return – take the net from them');
  } else {
    r.points = 30;
    r.notes.push('Return cross-court and deep, or lob');
  }
  return r;
}

// ---------------------------------------------------------------------------
// Feeds

const r2 = (rng, a, b) => rng.range(a, b);

const feedDrive = (cx) => (i, rng) => ({
  target: { x: cx + r2(rng, -0.6, 0.6), z: r2(rng, 5.5, 6.5) },
  speedKmh: r2(rng, 55, 70),
  spinRpm: { top: r2(rng, 500, 1000), side: 0 },
});

const ALL_DRILLS = [
  {
    id: 'fh-drive', name: 'Forehand Drive', es: 'Derecha', skill: 'Groundstrokes', level: 1,
    home: { x: 2.3, z: 7.8 }, side: 'right', reps: 20, interval: 3.2, mirrorForLefty: true,
    feeds: feedDrive(2.6),
    targets: [zone('deep-cross', 'Deep cross-court', -5, 0, -9.5, -Z_SVC, 100)],
    scoring: (shot, result) => scoreDrive(DRILL_BY_ID['fh-drive'], shot, result),
    cues: {
      intro: 'Forehand drive: turn early, meet the ball in front of your front hip, aim deep cross-court.',
      introEs: 'Derecha: gira pronto, golpea delante de la cadera y busca la diagonal profunda.',
      tips: ['Racket back as the ball crosses the net', 'Contact in front of your front hip', 'Low to high, finish over your shoulder'],
      tipsEs: ['Pala atrás cuando la bola pasa la red', 'Golpea delante de la cadera', 'De abajo arriba, termina sobre el hombro'],
    },
    ap: { contact: 'ground', family: 'fh', aim: { x: -2.4, z: -8.2 }, speedKmh: 74, top: 1100 },
  },
  {
    id: 'bh-drive', name: 'Backhand Drive', es: 'Revés', skill: 'Groundstrokes', level: 1,
    home: { x: -2.3, z: 7.8 }, side: 'left', reps: 20, interval: 3.2, mirrorForLefty: true,
    feeds: feedDrive(-2.6),
    targets: [zone('deep-cross', 'Deep cross-court', 0, 5, -9.5, -Z_SVC, 100)],
    scoring: (shot, result) => scoreDrive(DRILL_BY_ID['bh-drive'], shot, result),
    cues: {
      intro: 'Backhand drive: shoulder turn, racket prepared early, contact in front, cross-court deep.',
      introEs: 'Revés: gira los hombros, prepara pronto y golpea delante; diagonal profunda.',
      tips: ['Turn your shoulders before the bounce', 'Keep the racket face firm at contact', 'Finish toward the target'],
      tipsEs: ['Gira los hombros antes del bote', 'Cara de la pala firme al golpear', 'Termina hacia el objetivo'],
    },
    ap: { contact: 'ground', family: 'bh', aim: { x: 2.4, z: -8.2 }, speedKmh: 66, top: 700 },
  },
  {
    id: 'back-glass', name: 'Off the Back Glass', es: 'Salida de pared', skill: 'Walls', level: 2,
    home: { x: 2.0, z: 7.0 }, side: 'right', reps: 15, interval: 3.8, mirrorForLefty: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 1.2, 3.0), z: r2(rng, 7.6, 8.6) },
      flightTime: r2(rng, 1.15, 1.3),
      spinRpm: { top: r2(rng, 300, 700), side: 0 },
    }),
    targets: [zone('deep', 'Deep', -5, 5, -10, -6.0, 100)],
    scoring: (shot, result) => scoreBackGlass(DRILL_BY_ID['back-glass'], shot, result),
    cues: {
      intro: 'Off the back glass: let the ball pass, turn with it and play it as it comes off the glass.',
      introEs: 'Salida de pared: deja pasar la bola, gira con ella y juégala al salir del cristal.',
      tips: ['Don\'t rush – let it come off the glass', 'Side-on to the glass, racket low', 'Lift it deep, not hard'],
      tipsEs: ['Sin prisa: deja que salga del cristal', 'De lado al cristal, pala baja', 'Levántala profunda, no fuerte'],
    },
    ap: { contact: 'glass', family: 'fh', aim: { x: -1.2, z: -7.4 }, speedKmh: 50, top: 700 },
  },
  {
    id: 'double-wall', name: 'Corner Exit', es: 'Doble pared', skill: 'Walls', level: 3,
    home: { x: 2.4, z: 7.0 }, side: 'right', reps: 15, interval: 4.0, mirrorForLefty: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 3.4, 4.0), z: r2(rng, 7.8, 8.5) },
      flightTime: r2(rng, 1.1, 1.25),
      spinRpm: { top: r2(rng, 200, 600), side: 0 },
      offsetX: -3.0,
    }),
    targets: [zone('deep', 'Deep', -5, 5, -10, -6.0, 100)],
    scoring: (shot, result) => {
      const r = scoreBackGlass(DRILL_BY_ID['double-wall'], shot, result);
      if (!r.success && result.legal && shot.afterWall) {
        r.points = 50;
        r.notes.push('Out of the corner – now deeper');
      }
      return r;
    },
    cues: {
      intro: 'Corner exit: the ball hits the back glass then the side glass. Read both rebounds, then lift it deep.',
      introEs: 'Doble pared: la bola toca el fondo y luego el lateral. Lee los dos rebotes y levántala profunda.',
      tips: ['Stay away from the corner – let it come out', 'Short steps to adjust', 'Play it as it leaves the side glass'],
      tipsEs: ['Aléjate de la esquina, deja que salga', 'Pasos cortos para ajustar', 'Juégala al salir del lateral'],
    },
    ap: { contact: 'glass', family: 'fh', aim: { x: -1.0, z: -7.4 }, speedKmh: 50, top: 700 },
  },
  {
    id: 'volleys', name: 'Net Volleys', es: 'Voleas', skill: 'Net', level: 1,
    home: { x: 1.6, z: 3.2 }, side: 'right', reps: 20, interval: 2.8, mirrorForLefty: true,
    feeds: (i, rng, ctx = {}) => {
      const h = ctx.home || { x: 1.6, z: 3.2 };
      const fh = i % 2 === 0;
      return {
        via: { x: h.x + (fh ? 0.62 : -0.48), y: r2(rng, 1.05, 1.35), z: h.z - 0.42 },
        speedKmh: r2(rng, 50, 65),
        spinRpm: { top: r2(rng, 0, 200), side: 0 },
      };
    },
    targets: [
      zone('deep-left', 'Deep left corner', -5, -2.5, -9.5, -7, 100),
      zone('deep-right', 'Deep right corner', 2.5, 5, -9.5, -7, 100),
    ],
    scoring: (shot, result) => scoreVolley(DRILL_BY_ID.volleys, shot, result),
    cues: {
      intro: 'Net volleys: compact punch, racket head up, step in and send it deep to the corners.',
      introEs: 'Voleas: golpe corto, cabeza de la pala arriba, paso adelante y profunda a las esquinas.',
      tips: ['No backswing – just block and punch', 'Contact in front of your body', 'Step toward the ball'],
      tipsEs: ['Sin armado: bloquea y empuja', 'Golpea delante del cuerpo', 'Da un paso hacia la bola'],
    },
    ap: { contact: 'volley', family: 'auto', aim: { x: -3.6, z: -8.2 }, aimBh: { x: 3.6, z: -8.2 }, speedKmh: 50, top: 0 },
  },
  {
    id: 'bandeja', name: 'Bandeja', es: 'Bandeja', skill: 'Overheads', level: 2,
    home: { x: 1.6, z: 4.4 }, side: 'right', reps: 15, interval: 4.2, mirrorForLefty: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 0.9, 2.4), z: r2(rng, 7.1, 7.9) },
      apex: r2(rng, 6.0, 7.0),
      spinRpm: { top: r2(rng, 100, 400), side: 0 },
    }),
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -7, 100)],
    scoring: (shot, result) => scoreBandeja(DRILL_BY_ID.bandeja, shot, result),
    cues: {
      intro: 'Bandeja: side-on, racket up early, slice through the ball and keep your net position. Control over power.',
      introEs: 'Bandeja: de perfil, pala arriba pronto, corta la bola y mantén la red. Control, no potencia.',
      tips: ['Turn sideways and point at the ball', 'Contact in front, above your head', 'Slice it deep – no more than 85 km/h'],
      tipsEs: ['Ponte de perfil y señala la bola', 'Golpe delante, por encima de la cabeza', 'Cortada y profunda, sin pasar de 85 km/h'],
    },
    ap: { contact: 'overhead', family: 'oh', aim: { x: -1.2, z: -8.3 }, speedKmh: 62, top: -500 },
  },
  {
    id: 'vibora', name: 'Víbora', es: 'Víbora', skill: 'Overheads', level: 3,
    home: { x: 1.6, z: 4.4 }, side: 'right', reps: 15, interval: 4.2, mirrorForLefty: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 0.9, 2.4), z: r2(rng, 6.6, 7.4) },
      apex: r2(rng, 5.5, 6.5),
      spinRpm: { top: r2(rng, 100, 400), side: 0 },
    }),
    targets: [
      zone('side-corner', 'Side-glass corner', -5, -3, -9.5, -6.5, 100),
      zone('side-glass', 'Side glass after the bounce', -5, -4.8, -10, -6, 50, 'glass-after'),
    ],
    scoring: (shot, result) => scoreVibora(DRILL_BY_ID.vibora, shot, result),
    cues: {
      intro: 'Víbora: an aggressive bandeja with side-spin, cut across the ball toward the side-glass corner.',
      introEs: 'Víbora: bandeja agresiva con efecto lateral; corta hacia la esquina del lateral.',
      tips: ['Contact a little to the side of your head', 'Cut across the ball, finish low on the left', 'Aim so it dies off the side glass'],
      tipsEs: ['Golpe algo al lado de la cabeza', 'Corta la bola y termina abajo a la izquierda', 'Que muera en el cristal lateral'],
    },
    ap: { contact: 'overhead', family: 'oh', aim: { x: -3.9, z: -8.2 }, speedKmh: 72, top: -300 },
  },
  {
    id: 'smash-x3', name: 'Smash Por Tres', es: 'Remate por tres', skill: 'Overheads', level: 3,
    home: { x: 1.2, z: 3.6 }, side: 'right', reps: 12, interval: 4.2, mirrorForLefty: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 0.6, 2.0), z: r2(rng, 4.1, 4.9) },
      apex: r2(rng, 5.0, 5.5),
      spinRpm: { top: r2(rng, 0, 300), side: 0 },
    }),
    targets: [
      // To z -1: a steep smash that bounces close to the net is the one that can go por tres.
      zone('service-area', 'Between service line and net', -5, 5, -Z_SVC, -1.0, 100),
      zone('por-tres', '¡Por tres! over the back wall', -5, 5, -10.3, -10, 500, 'exit'),
    ],
    scoring: (shot, result) => scoreSmash(DRILL_BY_ID['smash-x3'], shot, result),
    cues: {
      intro: 'Smash por tres: get under the short lob, full flat smash into the service area so it bounces out over the back wall.',
      introEs: 'Remate por tres: colócate bajo el globo corto y remata plano al cuadro para sacarla por el fondo.',
      tips: ['Move back fast, side-on', 'Contact high and in front', 'Hit down and through – bounce it near the service line'],
      tipsEs: ['Retrocede rápido, de perfil', 'Golpe alto y delante', 'Hacia abajo: bote cerca de la línea de saque'],
    },
    ap: { contact: 'overhead', family: 'sm', aim: { x: 0.3, z: -5.0 }, speedKmh: 120, top: 400 },
  },
  {
    id: 'lob-defense', name: 'Defensive Lob', es: 'Globo', skill: 'Tactics', level: 2,
    home: { x: 1.8, z: 8.2 }, side: 'right', reps: 15, interval: 3.8, mirrorForLefty: true, opponentsAtNet: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 0.5, 3.2), z: r2(rng, 6.4, 7.4) },
      speedKmh: r2(rng, 58, 72),
      spinRpm: { top: r2(rng, 400, 900), side: 0 },
    }),
    targets: [zone('deep', 'Deep lob', -5, 5, -9.5, -7.5, 100)],
    scoring: (shot, result) => scoreLob(DRILL_BY_ID['lob-defense'], shot, result),
    cues: {
      intro: 'Defensive lob: the opponents are at the net. Lift it high (over 4.5 m) and deep to push them back.',
      introEs: 'Globo: los rivales están en la red. Súbela alta (más de 4,5 m) y profunda para echarlos atrás.',
      tips: ['Open the racket face', 'Long, slow swing from low to high', 'Deep – but not onto the glass on the full'],
      tipsEs: ['Abre la cara de la pala', 'Swing largo y lento de abajo arriba', 'Profundo, sin tocar el cristal directo'],
    },
    ap: { contact: 'ground', family: 'fh', aim: { x: -1.0, z: -8.6 }, apex: 6.2, top: 300 },
    opponents: [{ x: -2.0, z: -3.0 }, { x: 2.0, z: -3.0 }],
  },
  {
    id: 'chiquita', name: 'Chiquita', es: 'Chiquita', skill: 'Tactics', level: 2,
    home: { x: 1.8, z: 6.2 }, side: 'right', reps: 15, interval: 3.6, mirrorForLefty: true, opponentsAtNet: true,
    feeds: (i, rng) => ({
      target: { x: r2(rng, 1.2, 2.8), z: r2(rng, 4.2, 5.0) },
      speedKmh: r2(rng, 40, 50),
      spinRpm: { top: r2(rng, 300, 700), side: 0 },
    }),
    targets: [zone('feet', 'At their feet', -5, 5, -4.5, -1.5, 100)],
    scoring: (shot, result) => scoreChiquita(DRILL_BY_ID.chiquita, shot, result),
    cues: {
      intro: 'Chiquita: step in from mid-court and play it soft and low at the net players\' feet (under 45 km/h), so they must volley up.',
      introEs: 'Chiquita: suave y baja a los pies de los voleadores (menos de 45 km/h), que tengan que subirla.',
      tips: ['Short swing, soft hands', 'Just over the tape', 'Then move up to the net'],
      tipsEs: ['Swing corto, manos suaves', 'Justo por encima de la red', 'Y luego sube a la red'],
    },
    ap: { contact: 'ground', family: 'fh', aim: { x: -1.0, z: -2.6 }, speedKmh: 37, maxClear: 0.3, top: 900 },
    opponents: [{ x: -2.0, z: -3.0 }, { x: 2.0, z: -3.0 }],
  },
  {
    id: 'serve', name: 'Serve', es: 'Saque', skill: 'Serve', level: 1,
    home: { x: 2.0, z: 7.4 }, side: 'right', reps: 15, interval: 4.5, mirrorForLefty: true,
    serving: { team: 0, box: 'right' },
    feeds: () => ({ drop: true, at: { dx: 0.62, dz: -0.36 }, height: 1.0 }),
    targets: [
      zone('box', 'Diagonal box', -5, 0, -Z_SVC, 0, 100),
      zone('deep-box', 'Within 1 m of the service line', -5, 0, -Z_SVC, -(Z_SVC - 1), 50, 'land'),
      zone('side-glass', 'Side glass after the bounce', -5, -4.8, -8, -2, 50, 'glass-after'),
    ],
    scoring: (shot, result, ctx) => scoreServe(DRILL_BY_ID.serve, shot, result, ctx),
    cues: {
      intro: 'Serve: bounce the ball behind the service line, strike it at or below the waist, cross-court into the box.',
      introEs: 'Saque: bota la bola detrás de la línea, golpea a la altura de la cintura o por debajo, a la diagonal.',
      tips: ['Drop the ball beside your front foot', 'Contact at waist height or lower', 'Aim deep, toward the glass'],
      tipsEs: ['Bota la bola junto al pie delantero', 'Golpe a la cintura o más bajo', 'Profundo, hacia el cristal'],
    },
    ap: { contact: 'serve', family: 'fh', aim: { x: -2.6, z: -6.0 }, speedKmh: 68, top: -200 },
  },
  {
    id: 'return', name: 'Return of Serve', es: 'Resto', skill: 'Serve', level: 2,
    home: { x: 2.6, z: 8.6 }, side: 'right', reps: 15, interval: 4.2, mirrorForLefty: true,
    serving: { team: 1, box: 'right' },
    feeds: (i, rng) => ({
      target: { x: r2(rng, 1.0, 3.8), z: r2(rng, 4.9, 6.5) },
      speedKmh: r2(rng, 55, 65),
      spinRpm: { top: r2(rng, -400, 100), side: 0 },
      offsetX: -2.2,
      launchHeight: 0.9,
      serve: true,
    }),
    targets: [zone('deep-cross', 'Deep cross-court', -5, 0, -9.5, -Z_SVC, 100)],
    scoring: (shot, result) => scoreReturn(DRILL_BY_ID.return, shot, result),
    cues: {
      intro: 'Return of serve: let it bounce, short backswing, return cross-court deep – or lob them.',
      introEs: 'Resto: déjala botar, armado corto, cruzado y profundo, o un globo.',
      tips: ['Split-step as the server strikes', 'Compact swing – use the serve\'s pace', 'Cross-court deep, or lob'],
      tipsEs: ['Split-step cuando saca el rival', 'Swing compacto: usa la velocidad del saque', 'Cruzado profundo o globo'],
    },
    ap: { contact: 'ground', family: 'fh', aim: { x: -2.4, z: -8.2 }, speedKmh: 66, top: 900 },
  },
  {
    id: 'live-mix', name: 'Live Ball Mix', es: 'Bola viva', skill: 'Tactics', level: 3,
    home: { x: 0.8, z: 7.4 }, side: 'right', reps: 24, interval: 3.8, mirrorForLefty: true,
    mix: ['fh-drive', 'bh-drive', 'back-glass', 'double-wall', 'lob-defense', 'chiquita'],
    feeds: (i, rng, ctx) => {
      const id = rng.pick(DRILL_BY_ID['live-mix'].mix);
      const f = DRILL_BY_ID[id].feeds(i, rng, ctx);
      return { ...f, drillId: id };
    },
    targets: [zone('deep', 'Deep', -5, 5, -9.5, -6.95, 100)],
    scoring: (shot, result, ctx) => {
      const id = result.feed && result.feed.drillId;
      const sub = id && DRILL_BY_ID[id];
      if (sub) return sub.scoring(shot, result, ctx);
      return scoreDrive(DRILL_BY_ID['live-mix'], shot, result);
    },
    cues: {
      intro: 'Live ball mix: drives, glass, corners, lobs and short balls at random. Read it, move, choose the right shot.',
      introEs: 'Bola viva: drives, cristal, esquinas, globos y bolas cortas al azar. Lee, muévete y elige.',
      tips: ['Split-step on every feed', 'Read the bounce before you move', 'Recover to the middle after each shot'],
      tipsEs: ['Split-step en cada bola', 'Lee el bote antes de moverte', 'Vuelve al centro tras cada golpe'],
    },
    ap: { contact: 'any', family: 'auto', aim: { x: -1.5, z: -8.2 }, speedKmh: 66, top: 900 },
  },
];

/** id -> DrillDef (right-handed geometry). */
export const DRILL_BY_ID = Object.fromEntries(ALL_DRILLS.map((d) => [d.id, d]));

for (const d of ALL_DRILLS) Object.freeze(d.targets);
export const DRILLS = Object.freeze(ALL_DRILLS);

/** The drill with this id, mirrored for a left-hander when requested and allowed. */
export function getDrill(id, handed = 'right') {
  const d = DRILL_BY_ID[id];
  if (!d) return null;
  return handed === 'left' && d.mirrorForLefty ? mirrorDrill(d) : d;
}

const mx = (p) => (p ? { ...p, x: -p.x } : p);

function mirrorFeed(f) {
  if (!f) return f;
  const out = { ...f };
  if (f.target) out.target = mx(f.target);
  if (f.via) out.via = mx(f.via);
  if (f.offsetX) out.offsetX = -f.offsetX;
  if (f.at) out.at = { ...f.at, dx: -f.at.dx };
  if (f.spinRpm) out.spinRpm = { top: f.spinRpm.top, side: -(f.spinRpm.side || 0) };
  return out;
}

const mirrorZone = (zn) => zone(zn.id, zn.label, 0 - zn.x1 + 0, 0 - zn.x0 + 0, zn.z0, zn.z1, zn.points, zn.kind);

/** Left-handed version: x mirrored for home, feeds, targets, aims and opponents. */
export function mirrorDrill(d) {
  const m = {
    ...d,
    mirrored: true,
    home: mx(d.home),
    side: d.side === 'right' ? 'left' : 'right',
    feeds: (i, rng, ctx = {}) => mirrorFeed(d.feeds(i, rng, { ...ctx, home: ctx.home ? mx(ctx.home) : mx(d.home) })),
    targets: d.targets.map(mirrorZone),
    ap: d.ap ? { ...d.ap, aim: mx(d.ap.aim), aimBh: d.ap.aimBh ? mx(d.ap.aimBh) : undefined } : d.ap,
    opponents: d.opponents ? d.opponents.map(mx) : d.opponents,
  };
  if (d.serving) m.serving = { ...d.serving, box: d.serving.box === 'right' ? 'left' : 'right' };
  m.scoring = (shot, result, ctx) => d.scoring(shot, { ...result, landing: mx(result.landing), mirrored: true }, ctx);
  return m;
}

/** Spanish versions of the coaching notes (voice coach in ES). */
export const NOTE_ES = Object.freeze({
  'Aim deeper and cross-court, past the service line': 'Más profunda y cruzada, pasando la línea de saque',
  'Aim for the side-glass corner': 'Busca la esquina del cristal lateral',
  'Contact further in front': 'Golpea más adelante',
  'Control, not power – the bandeja keeps you at the net': 'Control, no potencia: la bandeja te mantiene en la red',
  'Deep serve – within a metre of the service line': 'Saque profundo, a menos de un metro de la línea',
  'Deeper – land it in the last 2.5 m': 'Más profundo: que bote en los últimos 2,5 m',
  'Deeper – make them play off the back glass': 'Más profunda: que jueguen de pared',
  'Flat and penetrating – great net clearance': 'Plana y penetrante: buena altura sobre la red',
  'Get lower for the low ball': 'Flexiona más para la bola baja',
  'Give yourself room – step away from the ball': 'Deja espacio: sepárate de la bola',
  'Good lob return – take the net from them': 'Buen resto en globo: gánales la red',
  'Good read off the glass – now send it deep': 'Buena lectura del cristal: ahora mándala profunda',
  "Higher – over the volleyers' reach (above 4.5 m)": 'Más alto: por encima de los voleadores (más de 4,5 m)',
  'Hit down: land it between the service line and the net': 'Hacia abajo: que bote entre la línea de saque y la red',
  'Hit through it – full smash': 'Atraviesa la bola: remate completo',
  'Hit up and through – the ball stayed on your side': 'Golpea hacia arriba y a través: se quedó en tu campo',
  'Into the side glass – hard to return': 'Al cristal lateral: difícil de restar',
  'Keep it in the court': 'Mantén la bola dentro',
  'Keep the return in play': 'Mantén el resto en juego',
  'Land it in the diagonal box': 'Que bote en el cuadro cruzado',
  'Land it short, between the net and the service line': 'Que bote corta, entre la red y la línea de saque',
  'Let it come off the glass first': 'Deja que salga del cristal primero',
  'Let the ball come to you': 'Deja que la bola venga a ti',
  'Let the serve bounce before you return it': 'Deja botar el saque antes de restar',
  'Lift it: clear the net by half a metre to a metre': 'Levántala: pasa la red con medio metro o un metro',
  'Lower over the net – make them volley up': 'Más baja sobre la red: que tengan que subirla',
  'Move your feet closer to the ball': 'Mueve los pies, acércate a la bola',
  'Move your feet early and get the racket back': 'Mueve los pies pronto y prepara la pala',
  'No play – free rep': 'Bola nula: repetición libre',
  'One clean stroke – no double hits': 'Un solo golpe limpio: sin dobles',
  'Out of the corner – now deeper': 'Saliste de la esquina: ahora más profunda',
  'Punch it deep into the corners': 'Empújala profunda a las esquinas',
  'Racket back earlier': 'Pala atrás antes',
  'Return cross-court and deep, or lob': 'Resta cruzado y profundo, o globo',
  'Serve at or below the waist (FIP rule)': 'Saca a la altura de la cintura o por debajo (regla FIP)',
  'Softer – take pace off so it dies at their feet': 'Más suave: quítale velocidad para que muera a sus pies',
  'Take it in the air, above your head': 'Tómala en el aire, por encima de la cabeza',
  'Too long – it hit the glass on the full; more topspin or less pace': 'Larga: tocó el cristal sin botar; más liftado o menos velocidad',
  'Too long – it hit the fence on the full': 'Larga: tocó la reja sin botar',
  'Volley it – take the ball before it bounces': 'Volea: tómala antes del bote',
  'Watch the ball onto the sweet spot': 'Mira la bola hasta el centro de la pala',
  '¡Por cuatro! Out over the side': '¡Por cuatro! Fuera por el lateral',
  '¡Por tres! Out over the back wall': '¡Por tres! Fuera por el fondo',
  '¡Víbora! It died off the side glass': '¡Víbora! Murió en el cristal lateral',
});

/** Spanish version of a coaching note (falls back to null for untranslated text). */
export function noteEs(text) {
  if (!text) return null;
  if (NOTE_ES[text]) return NOTE_ES[text];
  if (text.startsWith('Fault')) return 'Falta';
  return null;
}

/**
 * Collects generic coaching notes from the contact analysis (SPEC §5.4 cue style).
 */
export function coachingNotes(shot, result = {}) {
  const notes = [];
  if (!shot) return notes;
  if (shot.timing === 'late') notes.push('Contact further in front');
  else if (shot.timing === 'early') notes.push('Let the ball come to you');
  if (shot.spacing === 'cramped') notes.push('Give yourself room – step away from the ball');
  else if (shot.spacing === 'stretched') notes.push('Move your feet closer to the ball');
  const fam = shot.stroke || '';
  if (shot.contact && shot.contact.y < 0.5 && !OVERHEADS.has(fam) && fam !== 'serve') notes.push('Get lower for the low ball');
  if (shot.swing && Number.isFinite(shot.swing.prepTime) && shot.swing.prepTime < 0.2) notes.push('Racket back earlier');
  if (Number.isFinite(shot.quality) && shot.quality < 0.35) notes.push('Watch the ball onto the sweet spot');
  return notes;
}

/**
 * Scores one rep. outcomeInfo is built by the drill mode:
 * { outcome, reason, detail, winner, legal, landing: {x,z}|null, sideGlassAfterBounce,
 *   backGlassAfterBounce, exitVia, feed, ... }.
 * @returns { points, success, notes[], zone: id|null }
 */
export function scoreShot(drill, shotRecord, outcomeInfo = {}, ctx = {}) {
  const result = { legal: false, landing: null, ...outcomeInfo };
  if (!shotRecord) {
    return { points: 0, success: false, notes: ['Move your feet early and get the racket back'], zone: null };
  }
  const r = drill.scoring(shotRecord, result, ctx) || { points: 0, success: false, notes: [] };
  const notes = [...(r.notes || [])];
  for (const n of coachingNotes(shotRecord, result)) if (notes.length < 3 && !notes.includes(n)) notes.push(n);
  const zn = result.legal ? landZone(drill, result.landing) : null;
  return { points: Math.max(0, Math.round(r.points || 0)), success: !!r.success, notes: notes.slice(0, 3), zone: zn ? zn.id : null };
}

/** 0..3 stars against a nominal 100 points per rep (reps defaults to the drill's), unless drill.stars sets thresholds. */
export function starsFor(drill, totalPoints, reps = drill.reps) {
  const max = reps * 100;
  const th = drill.stars || [0.2 * max, 0.45 * max, 0.7 * max];
  let s = 0;
  for (const t of th) if (totalPoints >= t) s++;
  return s;
}
