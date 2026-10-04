// Round 4 venues, atmosphere and audio: the pure parts (venue metadata, the sky model, umpire calls,
// the crowd director, the voice queue with speakers, the venue synthesis).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VENUE_IDS, venueMeta, venueId, venueOptions } from '../src/render/venues/meta.js';
import { ATMOSPHERE, airMass, sunTransmittance, skyRadiance } from '../src/render/venues/skyModel.js';
import { scoreCall, pointCall, tiebreakCall, gamesCall, openingCall, createUmpire, callerSpeaker, TEAMS } from '../src/audio/umpire.js';
import { createCrowdDirector } from '../src/audio/crowdDirector.js';
import { createVoice, voiceForSpeaker, looksSpanish, rankVoices, SPEAKERS } from '../src/audio/voice.js';
import {
  genPock, genGlassPane, glassPanelAt, paneModes, genWhoosh, genApplause, genCrowdVowel, genSea, genBreeze, genBird, genVenueIR,
} from '../src/audio/venueSynth.js';
import { createMatch } from '../src/rules/scoring.js';
import { createRng } from '../src/util/math.js';

const SR = 48000;

// ---------------------------------------------------------------------------------------------
// Venue metadata

test('venues: three venues with acoustics, crowd and grade; unknown ids fall back to the club', () => {
  assert.deepEqual([...VENUE_IDS], ['club', 'sunset', 'stadium']);
  for (const id of VENUE_IDS) {
    const m = venueMeta(id);
    assert.equal(m.id, id);
    assert.ok(m.name && m.es);
    assert.ok(['hall', 'open', 'arena'].includes(m.acoustics.kind));
    assert.ok(m.acoustics.rt60 > 0 && m.acoustics.wet >= 0);
    assert.ok(m.crowd.level >= 0 && m.crowd.level <= 1);
    assert.ok(m.crowd.sources.length >= 1);
    assert.ok(Object.isFrozen(m) && Object.isFrozen(m.acoustics));
  }
  assert.equal(venueId('moon'), 'club');
  assert.equal(venueMeta(undefined).id, 'club');
  // Open air has the shortest tail, the arena the longest; the arena crowd is the biggest.
  assert.ok(venueMeta('sunset').acoustics.rt60 < venueMeta('club').acoustics.rt60);
  assert.ok(venueMeta('stadium').acoustics.rt60 > venueMeta('club').acoustics.rt60);
  assert.ok(venueMeta('stadium').crowd.level > venueMeta('sunset').crowd.level);
  assert.equal(venueOptions('es').length, 3);
});

// ---------------------------------------------------------------------------------------------
// Sky model

test('sky: low sun is warm, the zenith is blue, the horizon toward the sun is brighter and warmer', () => {
  const el = (9.5 * Math.PI) / 180;
  const sd = { x: -Math.sin(0.9) * Math.cos(el), y: Math.sin(el), z: -Math.cos(0.9) * Math.cos(el) };
  const T = sunTransmittance(sd.y);
  assert.ok(T[0] > T[1] && T[1] > T[2], `sun colour should be warm: ${T}`);
  assert.ok(airMass(1) > 0.99 && airMass(1) < 1.01);
  assert.ok(airMass(Math.sin(el)) > 4);
  const zen = skyRadiance({ x: 0, y: 1, z: 0 }, sd);
  assert.ok(zen[2] > zen[0], 'zenith is blue');
  const toward = skyRadiance({ x: sd.x / Math.hypot(sd.x, sd.z), y: 0.03, z: sd.z / Math.hypot(sd.x, sd.z) }, sd);
  const away = skyRadiance({ x: -sd.x / Math.hypot(sd.x, sd.z), y: 0.03, z: -sd.z / Math.hypot(sd.x, sd.z) }, sd);
  assert.ok(toward[0] > away[0] * 2, 'brighter toward the sun');
  assert.ok(toward[0] > toward[2], 'warm toward the sun');
  for (const v of [...zen, ...toward, ...away]) assert.ok(Number.isFinite(v) && v >= 0);
  assert.ok(ATMOSPHERE.tauR[2] > ATMOSPHERE.tauR[0], 'Rayleigh scatters blue most');
});

// ---------------------------------------------------------------------------------------------
// Umpire

function play(match, winners) {
  const out = [];
  let prev = match.display();
  for (const w of winners) {
    match.pointWonBy(w);
    const cur = match.display();
    out.push({ cur, prev, call: scoreCall(cur, prev, { winner: w }) });
    prev = cur;
  }
  return out;
}

test('umpire: point calls, server first, in English and Spanish', () => {
  const m = createMatch({ goldenPoint: true, firstServer: { team: 0, player: 0 } });
  const r = play(m, [0, 1, 1, 0, 1, 0]);
  assert.equal(r[0].call.en, 'Fifteen – love');
  assert.equal(r[0].call.es, 'Quince – nada');
  assert.equal(r[1].call.en, 'Fifteen all');
  assert.equal(r[1].call.es, 'Quince iguales');
  assert.equal(r[2].call.en, 'Fifteen – thirty');
  assert.equal(r[2].call.es, 'Quince – treinta');
  assert.equal(r[3].call.en, 'Thirty all');
  assert.equal(r[3].call.es, 'Treinta iguales');
  assert.equal(r[4].call.en, 'Thirty – forty');
  assert.equal(r[5].call.en, 'Deuce. Golden point');
  assert.equal(r[5].call.es, 'Iguales. Punto de oro');
  assert.equal(r[5].call.kind, 'point');
});

test('umpire: the receiving team serving is called from its own side ("Love–fifteen")', () => {
  const m = createMatch({ firstServer: { team: 1, player: 0 } });
  const r = play(m, [0]);
  assert.equal(r[0].cur.server.team, 1);
  assert.equal(r[0].call.en, 'Love – fifteen');
  assert.equal(r[0].call.es, 'Nada – quince');
});

test('umpire: advantage scoring says deuce and advantage with the team', () => {
  const m = createMatch({ goldenPoint: false });
  const r = play(m, [0, 0, 0, 1, 1, 1, 1, 0, 0]);
  assert.equal(r[5].call.en, 'Deuce');
  assert.equal(r[5].call.es, 'Iguales');
  assert.equal(r[6].call.en, `Advantage ${TEAMS[1].en}`);
  assert.equal(r[6].call.es, `Ventaja ${TEAMS[1].es}`);
  assert.equal(r[7].call.en, 'Deuce');
  assert.equal(r[8].call.en, `Advantage ${TEAMS[0].en}`);
});

test('umpire: games, sets, match and the tie-break', () => {
  const m = createMatch({ goldenPoint: true, gamesPerSet: 6, setsToWin: 1 });
  const game = (w) => play(m, [w, w, w, w]).at(-1).call;
  let c = game(0);
  assert.equal(c.kind, 'game');
  assert.equal(c.en, `Game, ${TEAMS[0].en}. ${TEAMS[0].en} leads one game to love`);
  assert.equal(c.es, `Juego, ${TEAMS[0].es}. Un juego a cero, ${TEAMS[0].es}`);
  c = game(1);
  assert.equal(c.en, `Game, ${TEAMS[1].en}. One game all`);
  assert.equal(c.es, `Juego, ${TEAMS[1].es}. Uno iguales`);
  for (let i = 0; i < 5; i++) {
    game(0);
    game(1);
  }
  // 6-6: tie-break.
  assert.equal(m.display().games.join('-'), '6-6');
  assert.ok(m.display().flags.tiebreak);
  // The game that made it 6-6 was announced as the start of the tie-break.
  const m2 = createMatch({ goldenPoint: true });
  let last = null;
  for (let g = 0; g < 12; g++) last = play(m2, [g % 2, g % 2, g % 2, g % 2]).at(-1).call;
  assert.equal(last.kind, 'tiebreak-start');
  assert.match(last.en, /Six games all\. Tie-break/);
  assert.match(last.es, /Seis iguales\. Tie-break/);
  const tb = play(m2, [0, 0, 1]);
  assert.equal(tb[0].call.en, `One – zero, ${TEAMS[0].en}`);
  assert.equal(tb[0].call.es, `Uno – cero, ${TEAMS[0].es}`);
  assert.equal(tb[2].call.en, `Two – one, ${TEAMS[0].en}`);
  const fin = play(m2, [0, 0, 0, 0, 0]).at(-1).call;
  assert.equal(fin.kind, 'match');
  assert.equal(fin.en, `Game, set and match, ${TEAMS[0].en}. Seven – six`);
  assert.equal(fin.es, `Juego, set y partido, ${TEAMS[0].es}. Siete – seis`);
});

test('umpire: games call wording, tie-break ties, faults and lets, double fault prefix', () => {
  assert.equal(gamesCall([4, 2], 'en'), `${TEAMS[0].en} leads four games to two`);
  assert.equal(gamesCall([4, 2], 'es'), `Cuatro juegos a dos, ${TEAMS[0].es}`);
  assert.equal(gamesCall([1, 3], 'es'), `Tres juegos a uno, ${TEAMS[1].es}`);
  assert.equal(gamesCall([3, 3], 'en'), 'Three games all');
  assert.equal(gamesCall([3, 3], 'es'), 'Tres iguales');
  assert.equal(tiebreakCall({ points: ['2', '2'] }, 'en'), 'Two all');
  assert.equal(tiebreakCall({ points: ['2', '2'] }, 'es'), 'Dos iguales');
  assert.equal(tiebreakCall({ points: ['3', '5'] }, 'es'), `Cinco – tres, ${TEAMS[1].es}`);
  assert.deepEqual(scoreCall(null, null, { winner: null, reason: 'serve-fault' }), { en: 'Fault', es: 'Falta', kind: 'fault' });
  assert.equal(scoreCall(null, null, { winner: null, reason: 'let' }).en, 'Let');
  const m = createMatch();
  const prev = m.display();
  m.pointWonBy(1);
  const c = scoreCall(m.display(), prev, { winner: 1, reason: 'double-fault' });
  assert.equal(c.en, 'Double fault. Love – fifteen');
  assert.equal(c.es, 'Doble falta. Nada – quince');
  assert.equal(pointCall({ points: ['40', '40'], server: { team: 0 }, flags: { goldenPoint: true } }, 'es'), 'Iguales. Punto de oro');
  assert.deepEqual(openingCall({ server: { team: 0 } }), { en: `${TEAMS[0].en} to serve. Play`, es: `Saca ${TEAMS[0].es}. Tiempo`, kind: 'open' });
});

function fakeVoice() {
  const said = [];
  return { said, say: (text, o) => (said.push({ text, ...o }), true) };
}

test('umpire: speaks score calls after a pause in the chosen language; callouts by character', () => {
  const v = fakeVoice();
  const timers = [];
  const ump = createUmpire({ voice: v, lang: 'es', setTimer: (fn) => timers.push(fn) });
  const m = createMatch();
  const prev = m.display();
  ump.reset(prev);
  m.pointWonBy(0);
  const c = ump.onOutcome({ winner: 0, reason: 'winner', score: m.display() });
  assert.equal(c.es, 'Quince – nada');
  assert.equal(v.said.length, 0, 'the call waits for the pause');
  timers.forEach((f) => f());
  assert.equal(v.said[0].text, 'Fifteen – love');
  assert.equal(v.said[0].es, 'Quince – nada');
  assert.equal(v.said[0].speaker, 'umpire');
  assert.equal(v.said[0].lang, 'es');
  // A drill rally outcome without a score is not called.
  assert.equal(ump.onOutcome({ winner: 0, reason: 'winner' }), null);
  // Callouts: Spanish words keep a Spanish voice; each character has its speaker.
  ump.setLang('en');
  ump.callout({ text: '¡Mía!', who: 'partner' });
  ump.callout({ text: '¡Tuya!', who: 'rival2' });
  ump.callout({ en: 'Yours!', es: '¡Tuya!', who: 'opponent', kind: 'yours' });
  // game/callouts.js payloads: who is the partner's display name; chatter follows the app language.
  ump.callout({ text: '¡Bien jugado!', es: '¡Bien jugado!', en: 'Well played!', who: 'Lucía', kind: 'great' });
  assert.deepEqual(v.said.slice(1).map((x) => [x.text, x.speaker, x.lang, x.cut, x.expireMs]), [
    ['¡Mía!', 'partner', 'es', true, 1000],
    ['¡Tuya!', 'opponent2', 'es', true, 1000],
    ['¡Tuya!', 'opponent', 'es', true, 1000],
    ['Well played!', 'partner', 'en', false, 3000],
  ]);
  assert.equal(callerSpeaker('nobody'), 'partner');
  ump.setCallouts(false);
  assert.equal(ump.callout({ text: '¡Vamos!', who: 'partner' }), false);
});

test('umpire: bound to a bus, only matches are called and the match is opened once', () => {
  const v = fakeVoice();
  const handlers = {};
  const bus = { on: (t, fn) => ((handlers[t] = fn), () => delete handlers[t]) };
  let match = true;
  const ump = createUmpire({ voice: v, setTimer: (fn) => fn() });
  const off = ump.bindBus(bus, { isMatch: () => match, display: () => ({ server: { team: 1 } }) });
  handlers['ball:launch']({ by: 'ai' });
  handlers['ball:launch']({ by: 'ai' });
  assert.equal(v.said.length, 1);
  assert.equal(v.said[0].text, `${TEAMS[1].en} to serve. Play`);
  match = false;
  handlers['rally:outcome']({ winner: 0, reason: 'winner', score: { points: ['15', '0'], games: [0, 0], sets: [], server: { team: 0 }, flags: {} } });
  assert.equal(v.said.length, 1);
  handlers['partner:call']({ text: '¡Vamos!', who: 'partner' });
  assert.equal(v.said.length, 2);
  off();
  assert.equal(Object.keys(handlers).length, 0);
});

// ---------------------------------------------------------------------------------------------
// Crowd director

function director(mode = 'match') {
  let t = 0;
  const got = [];
  const d = createCrowdDirector({ now: () => t, mode: () => mode, onReact: (kind, level, info) => got.push({ kind, level, info }) });
  return { d, got, tick: (dt) => (t += dt), kinds: () => got.map((g) => g.kind) };
}

test('crowd: hush for the serve, ooh off the glass, applause for a winner, murmur back after', () => {
  const { d, got, tick, kinds } = director();
  d.onLaunch({ by: 'ai' });
  d.onLaunch({ by: 'coach' }); // a coach shot inside the point is not a new point
  assert.deepEqual(kinds(), ['hush']);
  d.onHit({ shot: { by: 'player' } });
  d.onHit({ shot: { by: 'ai' } });
  d.onHit({ shot: { by: 'player', afterWall: true } });
  assert.equal(kinds().at(-1), 'ooh');
  d.onHit({ shot: { by: 'player', provisional: true } });
  assert.equal(d.hits, 3, 'provisional hits are presentation only');
  d.onOutcome({ winner: 0, reason: 'winner' });
  assert.equal(kinds().at(-1), 'applause');
  assert.ok(got.at(-1).level > 0.4);
  tick(2);
  d.update();
  assert.notEqual(kinds().at(-1), 'murmur');
  tick(1.5);
  d.update();
  assert.equal(kinds().at(-1), 'murmur');
});

test('crowd: long rallies cheer, por tres roars (with the board flash), errors groan, rivals get polite applause', () => {
  const a = director();
  a.d.onLaunch({});
  for (let i = 0; i < 12; i++) a.d.onHit({ shot: { by: i % 2 ? 'ai' : 'player' } });
  a.d.onOutcome({ winner: 0, reason: 'double-bounce' });
  assert.equal(a.kinds().at(-1), 'cheer');
  assert.ok(a.kinds().includes('ooh'), 'a long rally draws an ooh');
  const b = director();
  b.d.onLaunch({});
  b.d.onOutcome({ winner: 0, reason: 'por-tres' });
  assert.deepEqual(b.kinds().slice(-2), ['aah', 'roar']);
  assert.equal(b.got.at(-1).info.board, 5);
  const c = director();
  c.d.onOutcome({ winner: 1, reason: 'net' });
  assert.equal(c.kinds().at(-1), 'groan');
  c.d.onOutcome({ winner: 1, reason: 'winner' });
  assert.equal(c.kinds().at(-1), 'applause');
  assert.ok(c.got.at(-1).level <= 0.35);
  c.d.onOutcome({ winner: null, reason: 'let' });
  assert.equal(c.kinds().at(-1), 'applause', 'lets get no reaction');
});

test('crowd: drills never groan or hush, and react at reduced level', () => {
  const { d, kinds, got } = director('drill');
  d.onLaunch({ by: 'machine' });
  d.onOutcome({ winner: 1, reason: 'out' });
  assert.deepEqual(kinds(), []);
  d.onOutcome({ winner: 0, reason: 'winner' });
  assert.equal(kinds().at(-1), 'applause');
  assert.ok(got.at(-1).level < 0.5);
  d.onMatchEnd({ summary: { winner: 0 } });
  assert.equal(kinds().at(-1), 'roar');
});

// ---------------------------------------------------------------------------------------------
// Voice queue

function fakeSpeech() {
  const voices = [
    { name: 'Samantha', lang: 'en-US', localService: true },
    { name: 'Daniel', lang: 'en-GB', localService: true },
    { name: 'Karen', lang: 'en-AU', localService: true },
    { name: 'Moira', lang: 'en-IE', localService: true },
    { name: 'Mónica', lang: 'es-ES', localService: true },
    { name: 'Jorge', lang: 'es-ES', localService: true },
    { name: 'Paulina', lang: 'es-MX', localService: true },
    { name: 'Zarvox', lang: 'en-US' },
  ];
  const spoken = [];
  let current = null;
  const synth = {
    getVoices: () => voices,
    speak: (u) => {
      spoken.push(u);
      current = u;
    },
    cancel: () => {
      current = null;
    },
    addEventListener() {},
    end() {
      const u = current;
      current = null;
      if (u && u.onend) u.onend();
    },
    get current() {
      return current;
    },
  };
  class Utterance {
    constructor(text) {
      this.text = text;
    }
  }
  let t = 0;
  const timers = [];
  return {
    synth, Utterance, spoken, voices,
    now: () => t,
    advance(ms) {
      t += ms;
      for (const tm of timers.slice()) {
        if (tm.at <= t && !tm.done) {
          tm.done = true;
          tm.fn();
        }
      }
    },
    setTimer: (fn, ms) => {
      const tm = { fn, at: t + ms, done: false };
      timers.push(tm);
      return tm;
    },
    clearTimer: (tm) => {
      if (tm) tm.done = true;
    },
  };
}

test('voice: speakers get their own installed voice, pitch and rate; novelty voices never', () => {
  const f = fakeSpeech();
  assert.equal(voiceForSpeaker(f.voices, 'en', 'coach').name, 'Samantha');
  assert.equal(voiceForSpeaker(f.voices, 'en', 'umpire').name, 'Daniel');
  assert.equal(voiceForSpeaker(f.voices, 'es', 'partner').name, 'Paulina');
  assert.ok(!rankVoices(f.voices, 'en').some((v) => v.name === 'Zarvox'));
  assert.ok(looksSpanish('¡Mía!') && looksSpanish('vamos') && !looksSpanish('Mine!'));
  const v = createVoice({ ...f, lang: 'en' });
  v.say('Fifteen – love', { speaker: 'umpire', priority: 2 });
  assert.equal(f.spoken[0].voice.name, 'Daniel');
  assert.equal(f.spoken[0].pitch, SPEAKERS.umpire.pitch);
  f.synth.end();
  f.advance(800);
  v.say('¡Mía!', { speaker: 'partner', lang: 'es', priority: 2, expireMs: 1000 });
  assert.equal(f.spoken[1].voice.lang.slice(0, 2), 'es');
  assert.equal(f.spoken[1].rate, SPEAKERS.partner.rate);
});

test('voice: never overlaps; a partner call cuts a coaching tip, but waits for the umpire; stale calls expire', () => {
  const f = fakeSpeech();
  const v = createVoice({ ...f, lang: 'en' });
  const events = [];
  v.onSpeaking((on, who) => events.push(`${on ? 'start' : 'stop'}:${who}`));
  v.say('Racket back earlier', { priority: 1 });
  assert.equal(v.speaker, 'coach');
  v.say('¡Mía!', { speaker: 'partner', lang: 'es', priority: 2, cut: true, expireMs: 1000 });
  assert.equal(v.speaker, 'partner', 'the call cut the coach');
  assert.equal(f.spoken.at(-1).text, '¡Mía!');
  assert.equal(v.stats.cut, 1);
  f.synth.end();
  f.advance(200);
  // Umpire talking: a partner call (same priority) queues instead of cutting it.
  v.say('Thirty all', { speaker: 'umpire', priority: 2 });
  f.advance(800);
  assert.equal(v.speaker, 'umpire');
  v.say('¡Tuya!', { speaker: 'partner', lang: 'es', priority: 2, cut: true, expireMs: 1000 });
  assert.equal(v.speaker, 'umpire');
  // The umpire takes 1.5 s: the call is stale by then and is dropped.
  f.advance(1500);
  f.synth.end();
  f.advance(2000);
  assert.ok(!f.spoken.some((u) => u.text === '¡Tuya!'));
  assert.ok(v.stats.expired >= 1);
  assert.deepEqual(events.slice(0, 4), ['start:coach', 'stop:coach', 'start:partner', 'stop:partner']);
  v.setVolume(0.4);
  v.say('Deuce', { speaker: 'umpire', priority: 2 });
  f.advance(1000);
  assert.equal(f.spoken.at(-1).volume, 0.4);
});

// ---------------------------------------------------------------------------------------------
// Venue synthesis

const level = (buf) => {
  const chans = Array.isArray(buf) ? buf : [buf];
  let peak = 0, ss = 0, n = 0;
  for (const c of chans) {
    for (const v of c) {
      assert.ok(Number.isFinite(v), 'finite samples');
      peak = Math.max(peak, Math.abs(v));
      ss += v * v;
      n++;
    }
  }
  return { peak, rms: Math.sqrt(ss / n) };
};
const centroid = (buf) => {
  // Zero-crossing rate as a cheap brightness proxy over the first 30 ms.
  let z = 0;
  const n = Math.min(buf.length, Math.round(0.03 * SR));
  for (let i = 1; i < n; i++) if ((buf[i - 1] < 0) !== (buf[i] < 0)) z++;
  return z;
};

test('synth: every new sound is finite, audible and below full scale', () => {
  const r = createRng(11);
  const cases = [
    genPock(SR, r, { speed: 22 }), genPock(SR, r, { speed: 18, quality: 0.1 }), genGlassPane(SR, r, { speed: 12, panel: glassPanelAt({ x: 1, y: 1.2, z: 10 }) }),
    genWhoosh(SR, r, { speed: 20 }), genWhoosh(SR, r, { speed: 30, smash: true }), genApplause(SR, r, { dur: 1.5 }), genCrowdVowel(SR, r, { kind: 'ooh', voices: 6 }),
    genCrowdVowel(SR, r, { kind: 'groan', voices: 6 }), genSea(SR, r, { seconds: 4 }), genBreeze(SR, r, { seconds: 4 }), genBird(SR, r, { kind: 'gull' }),
    genBird(SR, r, { kind: 'swift' }), genBird(SR, r, { kind: 'sparrow' }),
  ];
  for (const c of cases) {
    const l = level(c);
    assert.ok(l.peak > 0.01 && l.peak < 1, `peak ${l.peak}`);
  }
});

test('synth: pock gets louder and brighter with speed; a frame hit is brighter / clackier than the sweet spot', () => {
  const slow = genPock(SR, createRng(3), { speed: 8, quality: 1 });
  const fast = genPock(SR, createRng(3), { speed: 28, quality: 1 });
  assert.ok(level(fast).peak > level(slow).peak * 1.5);
  const sweet = genPock(SR, createRng(4), { speed: 18, quality: 1 });
  const frame = genPock(SR, createRng(4), { speed: 18, quality: 0, offCenter: 1 });
  assert.ok(centroid(frame) > centroid(sweet), `frame ${centroid(frame)} vs sweet ${centroid(sweet)}`);
  // Short: a padel pock is over in ~60 ms (no string ring).
  const tail = sweet.subarray(Math.round(0.08 * SR));
  assert.ok(level(tail).peak < level(sweet).peak * 0.05);
});

test('synth: glass panes map from court positions and ring with their own modes', () => {
  const back = glassPanelAt({ x: 1.2, y: 1.1, z: 10 });
  assert.deepEqual([back.wall, back.a, back.b, +back.x0.toFixed(2)], ['back', 2, 3, 0.2]);
  const side2 = glassPanelAt({ x: -5, y: 1, z: -7 });
  assert.deepEqual([side2.wall, side2.b], ['side', 2]);
  const side3 = glassPanelAt({ x: 5, y: 1, z: 9 });
  assert.equal(side3.b, 3);
  const neighbour = glassPanelAt({ x: 13 + 1.2, y: 1.1, z: 10 });
  assert.equal(neighbour.id, back.id, 'neighbouring courts fold onto the main one');
  const a = paneModes(back), b = paneModes({ ...back, id: back.id + 1 }), c = paneModes(side2);
  assert.ok(a.length > 10);
  assert.notDeepEqual(a.map((m) => m.f.toFixed(1)), b.map((m) => m.f.toFixed(1)), 'each pane is tuned slightly differently');
  const lowest = (pn) => Math.min(...paneModes(pn, { fMin: 0, max: 400 }).map((m) => m.f));
  assert.ok(lowest(side2) > lowest(back), 'a smaller pane rings higher');
  // The middle of a pane rings longer than a hit by the clamp.
  const mid = genGlassPane(SR, createRng(9), { speed: 12, panel: { ...back, x0: 1, y0: 1.5 } });
  const edge = genGlassPane(SR, createRng(9), { speed: 12, panel: { ...back, x0: 0.05, y0: 0.08 } });
  const after = (x) => level(x.subarray(Math.round(0.12 * SR), Math.round(0.4 * SR))).rms;
  assert.ok(after(mid) > after(edge));
});

test('synth: whoosh loudness grows with racket speed; the arena reverb is longer than the club, open air shortest', () => {
  const p = (v) => level(genWhoosh(SR, createRng(2), { speed: v })).peak;
  assert.ok(p(8) < p(14) && p(14) < p(22) && p(22) < p(30));
  const decay = (ac) => {
    const [L] = genVenueIR(SR, createRng(1), ac);
    let e = 0, late = 0;
    for (let i = 0; i < L.length; i++) {
      e += L[i] * L[i];
      if (i > 0.3 * SR) late += L[i] * L[i];
    }
    return late / e;
  };
  const club = decay(venueMeta('club').acoustics), arena = decay(venueMeta('stadium').acoustics), open = decay(venueMeta('sunset').acoustics);
  assert.ok(arena > club && club > open, `${arena} ${club} ${open}`);
  assert.ok(open < 0.05);
});

// ---------------------------------------------------------------------------------------------
// Glue: bindVenue (crowd -> stands + sound, umpire, callouts, ducking)

import { bindVenue } from '../src/audio/venueAudio.js';
import { createBus } from '../src/util/math.js';

test('bindVenue: reactions reach the stands and the crowd sound; matches get umpire calls; speech ducks', () => {
  const bus = createBus();
  const world = { bus, time: 0, mode: { id: 'match:club', hud: () => ({ score: { server: { team: 0 } } }) } };
  const env = { got: [], react(k, l) { this.got.push(k); } };
  const audio = { got: [], ducks: [], crowd(k) { this.got.push(k); }, duck(a) { this.ducks.push(a); } };
  let speakFn = null;
  const said = [];
  const voice = { say: (t, o) => (said.push({ t, ...o }), true), onSpeaking: (fn) => ((speakFn = fn), () => { speakFn = null; }) };
  const v = bindVenue({ world, audio, voice, env, lang: 'es' });
  bus.emit('ball:launch', { by: 'ai' });
  assert.deepEqual(env.got, ['hush']);
  assert.ok(said.some((x) => x.speaker === 'umpire' && /Saca/.test(x.es)), 'opening call');
  bus.emit('ball:hit', { shot: { by: 'player' } });
  bus.emit('rally:outcome', { winner: 0, reason: 'por-tres', score: null });
  assert.ok(env.got.includes('roar') && audio.got.includes('roar'));
  bus.emit('partner:call', { text: '¡Vamos!', es: '¡Vamos!', en: 'Come on!', who: 'Lucía', kind: 'vamos' });
  assert.equal(said.at(-1).t, '¡Vamos!');
  speakFn(true, 'umpire');
  speakFn(false, 'umpire');
  assert.deepEqual(audio.ducks, [1, 0]);
  v.unbind();
  assert.equal(speakFn, null);
  bus.emit('rally:outcome', { winner: 1, reason: 'net' });
  assert.ok(!env.got.includes('groan'), 'unbound');
});
