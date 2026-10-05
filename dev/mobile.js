// Dev page for swipe mode: a lean boot of the REAL app modules (src/app/stage.js, game.js,
// wiring.js, the UI's HUD and pause screen, audio) driven by src/app/mobile.js exactly as the
// main.js integration does (createMobile -> install -> attachGame -> enterPlayView -> selfActor /
// afterSync around stage.syncWorld -> frame). Sessions restart when they finish, so a swipe bot can
// play for as long as it likes. Not shipped (dev/ is not precached).
import { SIM } from '../src/config.js';
import { clamp } from '../src/util/math.js';
import { createUI } from '../src/ui/ui.js';
import { createAudio } from '../src/audio/engine.js';
import { createVoice } from '../src/audio/voice.js';
import { loadFonts } from '../src/render/textures.js';
import { QUALITY } from '../src/render/scene.js';
import { createSettingsStore, safeStorage } from '../src/app/settings.js';
import { createSimClock } from '../src/app/clock.js';
import { createStage } from '../src/app/stage.js';
import { createGame, STEP } from '../src/app/game.js';
import { bindWorld } from '../src/app/wiring.js';
import { createAids } from '../src/app/aids.js';
import { createMobile } from '../src/app/mobile.js';
import { getDrill } from '../src/game/drills.js';

const q = new URLSearchParams(location.search);
const errors = [];
addEventListener('error', (e) => errors.push(String(e.message || e)));
addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

const storage = safeStorage();
const store = createSettingsStore(storage);
const S = store.value;
if (q.get('assist')) S.assist = q.get('assist');
if (q.get('venue')) S.venue = q.get('venue');
if (q.get('quality')) S.quality = q.get('quality');
const speed = Number(q.get('speed')) > 0 ? Number(q.get('speed')) : 1;
// ?lockstep=1: a virtual clock the swipe bot advances (__vpm.step) — real touch events carry virtual
// timestamps, so a slow software renderer cannot skew the timing being measured.
const lockstep = q.get('lockstep') === '1';
let vnow = 0;
const clock = lockstep ? createSimClock({ speed, now: () => vnow }) : createSimClock({ speed });
let seed = Number(q.get('seed')) || 7;

const spec = q.get('mode') === 'rally' || q.get('mode') === 'match'
  ? { kind: q.get('mode'), level: q.get('level') || 'club', games: 4 }
  : { kind: 'drill', drillId: getDrill(q.get('drill') || 'fh-drive') ? q.get('drill') || 'fh-drive' : 'fh-drive' };

const mobile = createMobile({ search: location.search, storage, QUALITY, forceInput: 'touch' });
if (mobile.quality && !q.get('quality')) S.quality = mobile.quality;

const canvas = document.getElementById('scene');
const uiRoot = document.getElementById('ui');
let ui, stage, audio, voice, game = null, unbind = null, paused = false, hudAcc = 0, lastMs = performance.now();
let audioOn = false;
const aids = createAids();
const sessions = { started: 0, finished: 0, hits: 0, shots: [] };

const handlers = {
  onResume: () => resume(),
  onPause: () => pause(),
  onRestart: () => startGame(),
  onQuit: () => startGame(),
  onScreen: () => {},
};

function pause() {
  if (!game || paused) return;
  paused = true;
  clock.pause();
  ui.show('pause', { title: game.hud().title });
}

function resume() {
  if (!paused) return;
  paused = false;
  clock.resume();
  mobile.enterPlayView(stage);
  ui.show('play');
}


function startGame() {
  if (unbind) unbind();
  if (game) {
    mobile.detachGame();
    game.dispose();
  }
  aids.clear();
  try {
    stage.setVenue(S.venue || 'club');
    mobile.applyBudget(stage);
  } catch (err) {
    errors.push(`venue: ${err.message}`);
  }
  const g = createGame({ spec, settings: S, input: 'touch', startTime: clock.now(), storage, seed: seed++ });
  game = g;
  mobile.attachGame(g, { clock });
  const ctx = {
    audio, voice, stage: mobile.playStage(stage), ui, recorder: null, quiet: false,
    onDrillEnd: () => { sessions.finished++; setTimeout(startGame, 1500); },
    onMatchEnd: () => { sessions.finished++; setTimeout(startGame, 1500); },
    onChallengeEnd: () => {},
  };
  unbind = bindWorld(g.world, ctx);
  g.world.bus.on('ball:hit', ({ shot }) => {
    if (shot.by === 'player' && !shot.provisional) {
      sessions.hits++;
      sessions.shots.push({
        id: shot.id, t: shot.t, kmh: Math.round(shot.speedOut * 3.6), stroke: shot.stroke, effort: shot.effort ?? null,
        type: shot.timingHit ? shot.timingHit.type : null, e: shot.timingHit ? shot.timingHit.e : null,
        landing: shot.predictedLanding ? { x: +shot.predictedLanding.x.toFixed(2), z: +shot.predictedLanding.z.toFixed(2) } : null,
        top: shot.spinRpm ? Math.round(shot.spinRpm.top) : null, side: shot.spinRpm ? Math.round(shot.spinRpm.side) : null,
      });
      if (sessions.shots.length > 400) sessions.shots.shift();
    }
  });
  stage.effects.targets(g.drill ? g.drill.targets : null);
  paused = false;
  stage.setGaze(S.gazeFollow !== false);
  mobile.enterPlayView(stage);
  ui.show('play', { mode: spec.kind, hud: g.hud() });
  sessions.started++;
}

function stepGame(nowMs, dtReal) {
  const g = game;
  const w = g.world;
  const t0 = w.time;
  let alpha = 1;
  if (!paused && !g.done) {
    clock.setRate(g.timeScale());
    let target = clock.simTimeOf(nowMs);
    const maxAdv = (clock.speed > 1 ? 0.5 : SIM.maxFrameDt) * clock.speed;
    if (target - w.time > maxAdv) {
      clock.shift(w.time + maxAdv - target);
      target = w.time + maxAdv;
    }
    g.advanceTo(target);
    alpha = clock.running ? clamp((target - w.time) / STEP, 0, 1) : 1;
    if (g.session && w.time > t0) g.session.tick(w.time - t0, { inPlay: g.inPlay(), realSpeed: w.player.speed });
  }
  const dtView = paused || !clock.running ? dtReal : w.time - t0;
  const a = aids.update(w, { wantLanding: !!S.landingMarker && S.assist !== 'pro', wantGhost: !!S.contactGhost });
  stage.effects.landingMarker(a.landing);
  stage.effects.contactGhost(a.ghost);
  stage.syncWorld(w, dtView, { alpha, selfActor: mobile.selfActor(w), showRig: true });
  mobile.afterSync(w, dtReal);
  hudAcc += dtReal;
  if (hudAcc >= 0.1 && (ui.screen === 'play' || ui.screen === 'pause')) {
    hudAcc = 0;
    const h = g.hud();
    h.live = g.inPlay();
    ui.hud(h);
    g.emitHud(h);
  }
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  if (lockstep) return; // __vpm.step drives the frames
  tick(nowMs, nowMs);
}

function tick(nowMs, perfNow, render = true) {
  const dtReal = clamp((nowMs - lastMs) / 1000, 0, 0.1);
  lastMs = nowMs;
  try {
    if (game) stepGame(nowMs, dtReal);
    else stage.syncWorld(null, dtReal, {});
    if (audio && audioOn) {
      const L = mobile.listener(game && game.world) || stage.listener();
      audio.setListener(L.pos, L.fwd, L.up);
    }
    if (render) stage.render(dtReal);
    mobile.frame({ screen: ui.screen, playing: !!game && ui.screen === 'play', paused, replay: false, now: perfNow });
  } catch (err) {
    errors.push(String(err && err.stack ? err.stack : err));
    if (errors.length < 5) console.error('[vpm] frame error', err);
  }
}

async function boot() {
  ui = createUI(uiRoot, handlers);
  ui.settings(S);
  ui.setLoading(0.05, 'Loading fonts…');
  await Promise.race([Promise.all([loadFonts(), document.fonts ? document.fonts.ready : null]), new Promise((r) => setTimeout(r, 2500))]);
  stage = await createStage({ canvas, settings: S, quality: S.quality, progress: async (p, text) => { ui.setLoading(p, text); await new Promise((r) => requestAnimationFrame(() => r())); } });
  addEventListener('resize', () => stage.resize());
  audio = q.get('mute') === '1' ? null : createAudio();
  if (audio) audio.setVolume(S.volumes);
  voice = createVoice({ lang: 'en' });
  mobile.install({
    canvas, stage, ui,
    handlers: {
      pause, isPlaying: () => !!game && ui.screen === 'play' && !paused, isReplay: () => false, skipReplay: () => {},
      unlockAudio: async () => {
        if (!audio) return true;
        const ok = await audio.unlock();
        if (ok && !audioOn) {
          audioOn = true;
          audio.setVolume(S.volumes);
          audio.ambience(true);
        }
        return ok;
      },
      useCamera: () => { location.href = '../index.html?input=camera'; },
    },
  });
  requestAnimationFrame((t) => {
    lastMs = lockstep ? vnow : t;
    requestAnimationFrame(frame);
  });
  if (mobile.needsTutorial() && q.get('tutorial') !== '0') {
    ui.show('loading');
    mobile.showTutorial(() => startGame());
  } else startGame();
  requestAnimationFrame(() => requestAnimationFrame(() => { vpm.ready = true; }));
}

// ---- test handle (the swipe bot) -----------------------------------------------------------
const vpm = {
  ready: false,
  get errors() { return errors.slice(); },
  get mobile() { return mobile; },
  get game() { return game; },
  get clock() { return clock; },
  get stage() { return stage; },
  get screen() { return ui ? ui.screen : null; },
  /** The live timing plan: { key, tStar, family, serve, kind } or null. */
  plan() {
    const w = game && game.world;
    const P = w && w.timing && w.timing.plan;
    if (!P || !w.ball || P.key !== `${w.ball.id}:${w.flight.startT}`) return null;
    const dec = w.timing.decided && w.timing.decided.key === P.key;
    return { key: P.key, tStar: P.tStar, family: P.family, serve: !!P.serve, kind: P.kind, decided: !!dec };
  },
  simNow() { return clock.now(); },
  /** performance.now() ms (lockstep: virtual ms) at which the sim clock reaches simT (current rate). */
  perfAt(simT) {
    const now = lockstep ? vnow : performance.now();
    return now + ((simT - clock.simTimeOf(now)) * 1000) / ((clock.speed || 1) * (clock.rate || 1));
  },
  log() { return mobile.controller.log.map((l) => ({ ...l })); },
  stats() {
    const g = game;
    return {
      sessions: { ...sessions, shots: sessions.shots.length }, controller: { ...mobile.controller.stats }, gain: mobile.controller.gain,
      game: g ? { playerHits: g.stats.playerHits, reps: g.stats.reps, inCourt: g.stats.inCourt, judged: g.stats.judgedShots } : null,
      fps: stage ? stage.app.stats.fps : 0, drawCalls: stage ? stage.app.stats.drawCalls : 0, pixelRatio: stage ? stage.app.stats.pixelRatio : 0,
      view: stage ? stage.view : null, chase: mobile.chase ? mobile.chase.current : null, quality: S.quality,
    };
  },
  shots() { return sessions.shots.slice(); },
  misses() {
    const w = game && game.world;
    return w && w.timing ? w.timing.log.misses : null;
  },
  pause, resume, startGame,
  lockstep,
  get vnow() { return vnow; },
  /** Lockstep: advance the virtual clock by ms (one app frame), optionally rendering it. Returns the plan. */
  step(ms = 1000 / 60, render = false) {
    vnow += ms;
    tick(vnow, vnow, render);
    return { vnow, sim: clock.now(), plan: vpm.plan() };
  },
};
window.__vpm = vpm;

boot().catch((err) => {
  errors.push(String(err && err.stack ? err.stack : err));
  console.error('[vpm] boot failed', err);
});
