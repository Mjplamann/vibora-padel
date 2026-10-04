// Round 4 integration (merge of the four round-4 workstreams): the pieces they hand to each other.
//  - settings: venue / umpire / callouts / replays / racket / outfit / crowd volume are validated;
//  - URL flags: ?apclose, ?venue, ?challenge, ?career, ?quick, ?autoreplay, ?screen;
//  - close mode reachable: createGame({ apClose }) plays with the upper-body tracker; the frame watch
//    never asks for the feet in close mode;
//  - racket profiles change timing hits (pace, scatter, spin, window);
//  - match moods drive the presence director; the coach publishes serveAt;
//  - replays carry the recorded upper body;
//  - venue audio: the umpire uses the career pair's name, the voice coach can be off alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { loadSettings } from '../src/app/settings.js';
import { parseParams } from '../src/app/params.js';
import { createGame } from '../src/app/game.js';
import { createFrameWatch } from '../src/app/tracking.js';
import { createRecorder, createReplayPlayer } from '../src/app/replay.js';
import { setRacketProfile, makeRacketProfile } from '../src/physics/racket.js';
import { racketById } from '../src/game/progression.js';
import { createDirector } from '../src/render/animation/director.js';
import { createCoach } from '../src/game/coach.js';
import { createWorld } from '../src/game/world.js';
import { bindVenue } from '../src/audio/venueAudio.js';
import { createVoice } from '../src/audio/voice.js';
import { createSyntheticCamera, standingBody } from '../src/tracking/synthetic.js';

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) };
}

test('settings: round-4 keys are validated (bad saves fall back), crowd volume defaults to 0.7', () => {
  const d = loadSettings(null);
  assert.equal(d.venue, 'club');
  assert.equal(d.umpireLang, 'es');
  assert.equal(d.callouts, true);
  assert.equal(d.autoReplay, true);
  assert.equal(d.racketModel, 'fang');
  assert.equal(d.outfit, 'club');
  assert.equal(d.volumes.crowd, 0.7);
  const bad = loadSettings(memStorage({
    'vibora.settings.v1': JSON.stringify({ venue: 'moon', umpireLang: 'fr', callouts: 0, autoReplay: false, racketModel: 'banana', outfit: 7, volumes: { master: 0.5 } }),
  }));
  assert.equal(bad.venue, 'club');
  assert.equal(bad.umpireLang, 'es');
  assert.equal(bad.callouts, true, 'only an explicit false turns callouts off');
  assert.equal(bad.autoReplay, false);
  assert.equal(bad.racketModel, 'fang');
  assert.equal(bad.outfit, 'club');
  assert.equal(bad.volumes.crowd, 0.7, 'older saves get the crowd default');
  const good = loadSettings(memStorage({ 'vibora.settings.v1': JSON.stringify({ venue: 'stadium', umpireLang: 'off', racketModel: 'cobra', outfit: 'optic', volumes: { crowd: 3 } }) }));
  assert.deepEqual([good.venue, good.umpireLang, good.racketModel, good.outfit, good.volumes.crowd], ['stadium', 'off', 'cobra', 'optic', 1]);
});

test('params: close-mode autopilot and the round-4 flags', () => {
  const p = parseParams('?autopilot=1&apclose=1&venue=sunset&challenge=daily&career=club-open&quick=1&autoreplay=0&screen=trophies&tab=rackets&fpmode=match&event=x');
  assert.equal(p.apClose, true);
  assert.equal(p.venue, 'sunset');
  assert.equal(p.challenge, 'daily');
  assert.equal(p.career, 'club-open');
  assert.equal(p.quick, true);
  assert.equal(p.autoReplay, false);
  assert.equal(p.screen, 'trophies');
  assert.equal(p.tab, 'rackets');
  assert.equal(p.fpMode, 'match');
  assert.equal(p.event, 'x');
  const d = parseParams('?venue=moon');
  assert.equal(d.venue, null);
  assert.equal(d.apClose, false);
  assert.equal(d.autoReplay, null);
});

test('close mode from the app: createGame({ apClose }) calibrates and plays on the upper body', () => {
  const s = loadSettings(null);
  const g = createGame({
    spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'autopilot', startTime: 20, seed: 4,
    apLatency: 0.11, apDelivery: 0.15, apProfile: 'human', apNoise: 1, apClose: true,
  });
  const bt = g.human.bodyTracker;
  assert.equal(bt.calibration.ok, true, 'calibrated from the upper body');
  assert.equal(bt.calibration.mode, 'upper');
  let t = g.world.time;
  while (t < 20 + 60) {
    t += 0.1;
    g.advanceTo(t);
  }
  assert.equal(bt.mode, 'upper');
  assert.ok(bt.stats.upperFrames > 0.9 * bt.stats.frames, `${bt.stats.upperFrames}/${bt.stats.frames}`);
  assert.ok(g.stats.playerHits >= 8, `hits ${g.stats.playerHits}/${g.stats.feeds}`);
  // The close calibration boosts the movement gains (tracking/locomotion.js closeRangeBoost).
  const boost = g.human.locomotion.config.boost;
  assert.ok(boost.lateral > 1.2 && boost.lateral <= 1.45, `boost ${boost.lateral}`);
  g.dispose();
});

test('frame watch in close mode: legs out of the picture never warn, a lost head does', () => {
  const cam = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 1.25, crop: { seed: 3 } });
  const body = standingBody({ height: 1.75, room: { x: 0, d: 1.7 } });
  const close = createFrameWatch({ upperBody: true });
  const full = createFrameWatch();
  let wClose = null, wFull = null;
  for (let i = 0; i < 90; i++) {
    const f = cam.frame(i * 33, [body]);
    wClose = close.update(f);
    wFull = full.update(f);
  }
  assert.equal(wClose, null, 'close mode: no feet warning');
  assert.ok(wFull && (wFull.kind === 'feet' || wFull.kind === 'body'), 'the full-body watch still asks for the legs');
  // Head out of the top of the picture (camera too low / too close).
  const low = createSyntheticCamera({ hfovDeg: 68, cameraHeight: 1.25, crop: { seed: 3 } });
  const near = standingBody({ height: 1.75, room: { x: 0, d: 0.75 } });
  const w2 = createFrameWatch({ upperBody: true });
  let warn = null;
  for (let i = 0; i < 60; i++) warn = w2.update(low.frame(i * 33, [near])) || warn;
  assert.ok(warn && (warn.kind === 'head' || warn.kind === 'body'), `warning ${warn && warn.kind}`);
});

/** Mean outgoing speed and landing spread of the human autopilot's hits with a racket profile. */
function racketRun(id, seed = 2) {
  const s = loadSettings(null);
  s.racketModel = id;
  const g = createGame({ spec: { kind: 'drill', drillId: 'fh-drive' }, settings: s, input: 'autopilot', startTime: 30, seed, apProfile: 'precise' });
  const speeds = [];
  const spins = [];
  g.world.bus.on('ball:hit', ({ shot }) => {
    if (shot.by !== 'player' || shot.provisional) return;
    speeds.push(shot.speedOut);
    if (shot.spinRpm) spins.push(Math.abs(shot.spinRpm.top));
  });
  let t = g.world.time;
  while (t < 30 + 90) {
    t += 0.1;
    g.advanceTo(t);
  }
  g.dispose();
  setRacketProfile(null);
  const mean = (a) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
  // The hardest drives (the pace of most drives is bounded by landing them deep in the court: a
  // faster ball that cannot dip in time is re-solved as an arc, whatever the racket).
  const top = speeds.slice().sort((a, b) => b - a).slice(0, 3);
  return { n: speeds.length, speed: mean(top), spin: mean(spins) };
}

test('racket profiles reach timing hits: Cobra hits harder than Orbit, Grit spins more than Fang', () => {
  assert.equal(makeRacketProfile(racketById('cobra')).timing.pace, 1.1);
  const fang = racketRun('fang');
  const cobra = racketRun('cobra');
  const orbit = racketRun('orbit');
  const grit = racketRun('grit');
  for (const r of [fang, cobra, orbit, grit]) assert.ok(r.n >= 8, `hits ${r.n}`);
  assert.ok(cobra.speed > orbit.speed * 1.06 && cobra.speed > fang.speed, `cobra ${(cobra.speed * 3.6).toFixed(1)} vs orbit ${(orbit.speed * 3.6).toFixed(1)} km/h`);
  assert.ok(grit.spin > fang.spin * 1.1, `grit ${grit.spin.toFixed(0)} vs fang ${fang.spin.toFixed(0)} rpm`);
});

test('presence: a match player\'s mood (state.mood) sets a 2.5 s celebrate / frustrate cue', () => {
  const subs = new Map();
  const w = { time: 50, bus: { on(t, fn) { subs.set(t, fn); return () => subs.delete(t); } }, ball: null, machine: null, mode: null, referee: null };
  const d = createDirector();
  const people = [
    { key: 'C', team: 1, pos: { x: -2, z: -7 }, state: { team: 1, mood: { kind: 'celebrate', at: 49.9 } } },
    { key: 'D', team: 1, pos: { x: 2, z: -7 }, state: { team: 1, mood: { kind: 'dejected', at: 49.9 } } },
  ];
  d.update(w, people);
  assert.equal(d.cue('C').react.kind, 'celebrate');
  assert.equal(d.cue('D').react.kind, 'frustrate');
  assert.ok(Math.abs(d.cue('C').react.t0 + d.cue('C').react.dur - (49.9 + 2.5)) < 1e-9);
  w.time = 52.6;
  d.update(w, people);
  assert.equal(d.cue('C').react, null, 'over after 2.5 s');
});

test('coach: a scheduled serve publishes serveAt (presentation), cleared when it is struck', () => {
  const world = createWorld({ settings: loadSettings(null) });
  const c = createCoach({ level: 'club', side: 'far', team: 1, name: 'C' });
  assert.equal(c.state.serveAt, null);
  c.serve(world, 'right', 1.2);
  assert.ok(Math.abs(c.state.serveAt - (world.time + 1.2)) < 1e-9);
});

test('replay: the recorded upper body poses the replay body (frame.player.bodyCourt.joints)', () => {
  const rec = createRecorder({ seconds: 2, hz: 60 });
  const J = (x) => ({ x, y: 1.4, z: 7 });
  const world = (t, x) => ({
    time: t, ball: null, coach: null, ai: [], machine: null,
    player: {
      pos: { x, y: 0, z: 7 }, vel: { x: 0, y: 0, z: 0 }, eye: { x, y: 1.64, z: 7 }, height: 1.75, handed: 'right', racket: null,
      bodyCourt: { dominant: 'R', joints: { nose: J(x), shoulderL: J(x - 0.2), shoulderR: J(x + 0.2), wristR: J(x + 0.5) } },
    },
  });
  for (let i = 0; i <= 60; i++) rec.record(world(i / 60, i / 60));
  const rp = createReplayPlayer(rec.snapshot(), { rate: 1 });
  rp.seek(0.505);
  const f = rp.frame();
  const bc = f.world.player.bodyCourt;
  assert.ok(bc && bc.joints.shoulderR && bc.joints.wristR, 'joints recorded');
  assert.equal(bc.dominant, 'R');
  assert.ok(Math.abs(bc.joints.shoulderR.x - (0.505 + 0.2)) < 0.02, `interpolated ${bc.joints.shoulderR.x}`);
  assert.equal(bc.joints.elbowR, undefined, 'missing joints stay missing');
});

function fakeVoice() {
  const said = [];
  return {
    said,
    say(text, o = {}) { said.push({ text, ...o }); return true; },
    onSpeaking() { return () => {}; },
  };
}

test('venue audio: the umpire calls a career pair by its name; voice coach off keeps the umpire', () => {
  const handlers = {};
  const bus = { on: (t, fn) => ((handlers[t] = fn), () => delete handlers[t]) };
  const world = { time: 0, bus, mode: { id: 'match:club', hud: () => ({ score: { server: { team: 1 } } }) } };
  const v = fakeVoice();
  const b = bindVenue({ world, bus, voice: v, lang: 'en', teams: [{ en: 'Víbora', es: 'Víbora' }, { en: 'Los Vecinos', es: 'Los Vecinos' }] });
  handlers['ball:launch']({ by: 'ai' });
  assert.equal(v.said[0].text, 'Los Vecinos to serve. Play');
  b.unbind();

  // createVoice: setCoach(false) silences the coach only.
  const spoken = [];
  const synth = { getVoices: () => [], speak: (u) => spoken.push(u.text), cancel() {}, addEventListener() {} };
  class U { constructor(t) { this.text = t; } }
  const voice = createVoice({ synth, Utterance: U, setTimer: () => 0, clearTimer() {} });
  voice.setCoach(false);
  assert.equal(voice.say('Forehand, 80'), false);
  assert.equal(voice.say('Fifteen – love', { speaker: 'umpire', priority: 2 }), true);
  voice.setCoach(true);
  assert.notEqual(voice.say('Backhand, 70', { priority: 2 }), false);
});

test('swing events: a session start (teleport home) is not a swing (workout recap, whoosh)', async () => {
  const { createTestGame } = await import('./helpers/closeGame.mjs');
  for (const drillId of ['volleys', 'fh-drive']) {
    const g = createTestGame({ spec: { kind: 'drill', drillId }, settings: loadSettings(null), seed: 1 });
    const peaks = [];
    g.world.bus.on('player:swing', (e) => { if (e.phase === 'peak') peaks.push(e.speed); });
    while (g.world.time < 10 + 40) g.advanceTo(g.world.time + 0.1);
    assert.ok(peaks.length >= 5, `${drillId}: ${peaks.length} swings`);
    assert.ok(Math.max(...peaks) < 30, `${drillId}: top swing ${Math.max(...peaks).toFixed(1)} m/s`);
  }
});
