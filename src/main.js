// Víbora Padel: app wiring (SPEC §10). Boot, screen flow, the fixed-step loop, pose input,
// bus -> audio / effects / UI, training aids, instant replay and the URL flags.
// Helpers live in src/app/.
import { SIM, TRACKING } from './config.js';
import { clamp } from './util/math.js';
import { createUI } from './ui/ui.js';
import { createHandCursor } from './ui/cursor.js';
import { createAudio } from './audio/engine.js';
import { createVoice } from './audio/voice.js';
import { createFallbackControls, FALLBACK } from './input/fallback.js';
import { describeCameraError } from './tracking/camera.js';
import { createHumanController } from './game/human.js';
import { judgeMargin } from './game/world.js';
import { DRILLS, getDrill, starsFor, noteEs } from './game/drills.js';
import { createSession } from './game/session.js';
import { loadFonts } from './render/textures.js';
import { parseParams } from './app/params.js';
import { createSettingsStore, safeStorage } from './app/settings.js';
import { createSimClock } from './app/clock.js';
import { createStage } from './app/stage.js';
import { createGame, STEP } from './app/game.js';
import { bindWorld } from './app/wiring.js';
import { createAids } from './app/aids.js';
import { createRecorder, createReplayPlayer } from './app/replay.js';
import { createTracking, bodyVisibility, createMotionWatch, createFrameWatch } from './app/tracking.js';
import { createDebugOverlay } from './app/debug.js';
import { installPrivacyGuard } from './app/privacy.js';

installPrivacyGuard();

const P = parseParams(location.search);
const storage = safeStorage();
const store = createSettingsStore(storage);
const S = store.value;
// URL overrides apply to this visit only (not persisted unless changed in Settings).
if (P.quality) S.quality = P.quality;
if (P.pitch !== null) S.viewPitch = P.pitch;
if (P.fov !== null) S.fov = P.fov;
if (P.eyeBack !== null || P.eyeDown !== null) {
  S.eyeOffset = { back: P.eyeBack ?? S.eyeOffset.back, down: P.eyeDown ?? S.eyeOffset.down };
}

const clock = createSimClock({ speed: P.speed });
const errors = [];
window.addEventListener('error', (e) => errors.push(String(e.message || e)));
window.addEventListener('unhandledrejection', (e) => errors.push(String(e.reason && e.reason.message ? e.reason.message : e.reason)));

// ---------------------------------------------------------------------------------------
// App state

let ui = null;
let stage = null;
let audio = null;
let voice = null;
let cursor = null;
let tracking = null;
let human = null;
let fallback = null;
let debug = null;
const recorder = createRecorder({ seconds: 6, hz: 60 });
const aids = createAids();
const motion = createMotionWatch();
const frameWatch = createFrameWatch();
let frameWarning = null; // out-of-frame warning for the play HUD (camera input)

let inputMode = P.autopilot ? 'autopilot' : P.fallback ? 'fallback' : 'camera';
let game = null;
let unbindGame = null;
let paused = false;
let replay = null;
let results = null; // pending results { at, show() }
let pendingStart = null;
let lastSpec = null;
let introDrillId = null;
let freezeAt = null;
let freezeRule = null; // (world) => true to stop the sim at that tick (tests / screenshots)
let frozen = false;
let hubLevel = P.level;
let seedCounter = P.seed ?? ((Date.now() & 0xffff) + 1);
let lastPoseFrame = null;
let lastSample = null;
let trackingSeen = false;
let replayBadge = null;
let hudAcc = 0;
let lastMs = performance.now();
let audioUnlocked = false;

const uiRoot = document.getElementById('ui');
const canvas = document.getElementById('scene');
const video = document.getElementById('camera');

// ---------------------------------------------------------------------------------------
// Settings

function applySettings(patch) {
  const keys = store.patch(patch);
  if (!keys.length) return;
  if (stage) stage.applySettings(keys, S);
  if (keys.includes('handed') || keys.includes('height') || keys.includes('cameraPreset')) {
    human.bodyTracker.setOptions({ handed: S.handed, userHeight: S.height, hfovDeg: S.hfovDeg });
    if (fallback) fallback.setHanded(S.handed);
  }
  if (keys.includes('gainLateral') || keys.includes('gainDepth')) {
    human.locomotion.config.gainLateral = S.gainLateral;
    human.locomotion.config.gainDepth = S.gainDepth;
  }
  if (keys.includes('volumes') && audio) audio.setVolume(S.volumes);
  if (keys.includes('voice') && voice) {
    voice.setEnabled(S.voice !== 'off');
    if (S.voice !== 'off') voice.setLang(S.voice);
  }
  if (keys.includes('viewPitch')) FALLBACK.pitchDeg = S.viewPitch;
  if (keys.includes('gazeFollow') && stage) stage.setGaze(S.gazeFollow && inputMode !== 'fallback');
  if (game) game.syncSettings(S);
  if (ui) ui.settings(S);
}

// ---------------------------------------------------------------------------------------
// Sessions

function nextSeed() {
  seedCounter = ((Math.imul(seedCounter, 1103515245) + 12345) >>> 0) || 1;
  return seedCounter % 2147483647;
}

function endGame() {
  if (unbindGame) unbindGame();
  unbindGame = null;
  if (game) game.dispose();
  game = null;
  results = null;
  paused = false;
  aids.clear();
  if (stage) {
    stage.effects.targets(null);
    stage.effects.landingMarker(null);
    stage.effects.contactGhost(null);
  }
  if (!clock.running) clock.resume();
}

function ensureFallback() {
  if (!fallback) {
    fallback = createFallbackControls({ canvas, handed: S.handed });
    FALLBACK.pitchDeg = S.viewPitch;
  }
  return fallback;
}

/** Starts a session. spec: { kind: 'drill'|'rally'|'match', drillId?, level? } */
function startGame(spec, { attract = false } = {}) {
  endGame();
  replay = null;
  const input = attract ? 'autopilot' : inputMode;
  const g = createGame({
    spec,
    settings: S,
    input,
    human: input === 'camera' ? human : null,
    fallback: input === 'fallback' ? ensureFallback() : null,
    startTime: clock.now(),
    storage,
    seed: nextSeed(),
    apLatency: P.apLatency,
    apDelivery: P.apDelivery,
    attract,
    onFrame: input === 'autopilot' && !attract ? (frame) => { lastPoseFrame = frame; ui.setSkeleton(frame); } : null,
  });
  game = g;
  recorder.clear();
  unbindGame = bindWorld(g.world, {
    audio, voice, stage, ui, recorder, quiet: attract,
    onDrillEnd: (p) => scheduleResults(p),
    onMatchEnd: (p) => scheduleResults(p),
  });
  stage.effects.targets(g.drill ? g.drill.targets : null);
  if (attract) {
    stage.setView('orbit');
    return g;
  }
  lastSpec = spec;
  pendingStart = null;
  paused = false;
  stage.setGaze(S.gazeFollow && input !== 'fallback');
  stage.setView('fp');
  if (fallback) fallback.enabled = input === 'fallback';
  cursor.setEnabled(false);
  ui.show('play', { mode: spec.kind, hud: g.hud() });
  if (input === 'fallback') ui.toast('Mouse moves the racket · flick or press Space as the ball comes · WASD moves');
  if (input === 'autopilot') ui.toast('Autopilot: a virtual player drives the tracking pipeline');
  return g;
}

function startAttract() {
  if (!P.attract || (game && game.attract)) return;
  startGame({ kind: 'drill', drillId: 'live-mix' }, { attract: true });
}

function stopAttract() {
  if (game && game.attract) endGame();
  if (stage) stage.setView('orbit');
}

/** Start request from the UI: needs a camera in camera mode. */
function requestStart(spec) {
  if (inputMode === 'camera' && !(tracking && tracking.running)) {
    pendingStart = spec;
    ui.toast('Set up the camera first · or choose “Use mouse instead”');
    enterCamera();
    return;
  }
  startGame(spec);
}

function scheduleResults(payload) {
  if (!game || game.attract || results) return;
  results = { at: performance.now() + 1800, payload };
}

function showResults() {
  const g = game;
  const payload = results && results.payload;
  results = null;
  if (!g) return;
  g.done = true;
  const ses = g.session ? g.session.summary() : {};
  const sum = g.mode.summary(g.world);
  let data;
  if (g.spec.kind === 'drill') {
    const d = g.drill;
    const made = (sum.results || []).filter((r) => r.success).length;
    const best = payload && payload.best ? payload.best : null;
    const idx = DRILLS.findIndex((x) => x.id === d.id);
    const nd = DRILLS[(idx + 1) % DRILLS.length];
    data = {
      ...ses,
      mode: 'drill',
      drill: { id: d.id, name: d.name, es: d.es, targets: d.targets },
      title: d.name,
      points: sum.points,
      stars: sum.stars,
      best: best ? best.previous : null,
      newBest: !!(best && best.isNew),
      reps: { made, total: sum.reps },
      targets: d.targets,
      tips: (sum.tips || []).map((t) => ({ text: t, es: noteEs(t) })),
      nextDrill: nd ? { id: nd.id, name: nd.name, es: nd.es } : null,
    };
  } else {
    const won = g.spec.kind === 'match' ? g.mode.match.winner === 0 : null;
    const sc = sum.score || null;
    data = {
      ...ses,
      mode: g.spec.kind,
      title: g.spec.kind === 'match' ? (won ? 'Match won' : 'Match lost') : 'Rally with Coach',
      points: sc ? sc.games[0] : sum.bestRally || 0,
      stars: g.spec.kind === 'match' ? (won ? 3 : 1) : 0,
      tips: [],
    };
  }
  stage.setView('orbit');
  ui.banner('');
  ui.results(data);
  cursor.setEnabled(true);
  if (audio) audio.ui('success');
}

function hubData() {
  const reader = createSession({ storage });
  const drills = DRILLS.map((d) => getDrill(d.id, S.handed));
  const bests = {};
  for (const d of drills) {
    const p = reader.bests(d.id);
    if (p !== null) bests[d.id] = { points: p, stars: starsFor(d, p) };
  }
  const input = inputMode === 'fallback' ? 'Mouse controls' : inputMode === 'autopilot' ? 'Autopilot' : tracking && tracking.camera ? tracking.camera.label : null;
  return { drills, bests, level: hubLevel, player: input };
}

function pause() {
  if (!game || game.attract || paused || replay || ui.screen !== 'play') return;
  paused = true;
  clock.pause();
  cursor.setEnabled(true);
  if (audio) audio.ui('pause');
  ui.show('pause', { title: game.hud().title });
}

function resume() {
  if (replay) {
    stopReplay();
    return;
  }
  if (!game || !paused) {
    if (ui.screen === 'pause') ui.show('play');
    return;
  }
  paused = false;
  clock.resume();
  cursor.setEnabled(false);
  stage.setView('fp');
  ui.show('play');
}

// ---------------------------------------------------------------------------------------
// Instant replay

function startReplay() {
  const snap = recorder.snapshot();
  if (!snap || snap.t1 - snap.t0 < 0.5) {
    ui.toast('Nothing to replay yet · aún no hay repetición');
    return;
  }
  const returnTo = ui.screen === 'play' ? 'play' : ui.screen;
  if (returnTo === 'play' && game && !paused) {
    paused = true;
    clock.pause();
  }
  const last = snap.hits.length ? snap.hits[snap.hits.length - 1].t : null;
  const from = last !== null && last > snap.t0 ? Math.max(snap.t0, last - 2.0) : Math.max(snap.t0, snap.t1 - 4.5);
  replay = { player: createReplayPlayer(snap, { rate: 0.4, from }), returnTo, view: 'broadcast' };
  stage.effects.landingMarker(null);
  stage.effects.contactGhost(null);
  stage.setView('replay');
  stage.fpCam.setReplayView('broadcast');
  uiRoot.classList.add('is-replay');
  replayBadge.hidden = false;
  if (ui.screen !== 'play') ui.show('play');
}

function cycleReplayView() {
  if (!replay) return;
  const order = ['broadcast', 'side', 'ball'];
  replay.view = order[(order.indexOf(replay.view) + 1) % order.length];
  stage.fpCam.setReplayView(replay.view);
}

function stopReplay() {
  if (!replay) return;
  const to = replay.returnTo;
  replay = null;
  uiRoot.classList.remove('is-replay');
  replayBadge.hidden = true;
  if (to === 'play' && game) {
    paused = false;
    clock.resume();
    stage.setView('fp');
    ui.show('play');
  } else if (to === 'pause') {
    stage.setView('fp');
    ui.show('pause');
  } else {
    stage.setView('orbit');
    ui.show(to || 'hub');
  }
}

// ---------------------------------------------------------------------------------------
// Camera

function cameraScreenData(extra = {}) {
  const cam = tracking.camera;
  return {
    cameras: tracking.cameras,
    selectedId: cam ? cam.deviceId : null,
    presetKey: S.cameraPreset,
    ...extra,
  };
}

function showCameraError(err) {
  const e = describeCameraError(err);
  ui.show('camera', cameraScreenData({ cameras: tracking.cameras, status: `${e.title}. ${e.message}`, error: { title: e.title, message: e.message, help: e.help || [] } }));
  ui.toast(e.title);
}

let cameraBusy = false;
async function enterCamera(deviceId = null) {
  stopAttract();
  if (inputMode === 'autopilot') return;
  if (ui.screen !== 'camera') ui.show('camera', cameraScreenData({ status: 'Looking for cameras… allow camera access in the browser prompt.' }));
  if (cameraBusy) return;
  cameraBusy = true;
  try {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      throw Object.assign(new Error('No camera API'), { name: window.isSecureContext ? 'Unsupported' : 'InsecureContext' });
    }
    const cams = await tracking.list({ requestPermission: true });
    if (tracking.error) throw tracking.error;
    if (!cams.length) throw Object.assign(new Error('No camera'), { name: 'NotFoundError' });
    const prevId = tracking.camera ? tracking.camera.deviceId : null;
    const cam = await tracking.open(deviceId || prevId || null);
    if (cam.deviceId !== prevId && cam.presetKey && TRACKING.cameraPresets[cam.presetKey]) applySettings({ cameraPreset: cam.presetKey });
    inputMode = 'camera';
    if (fallback) fallback.enabled = false;
    ui.setCameraPreview(cam.video);
    if (ui.screen === 'camera') ui.show('camera', cameraScreenData());
  } catch (err) {
    if (ui.screen === 'camera') showCameraError(err);
  } finally {
    cameraBusy = false;
  }
}

/**
 * Title screen: when the browser already allows the camera (a returning player), open it and
 * the pose tracker right away so a raised hand drives the cursor from the first screen.
 * Without that permission nothing is opened (no prompt before the player asks for it).
 */
async function warmCamera() {
  try {
    if (inputMode !== 'camera' || !navigator.permissions || !navigator.permissions.query) return;
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) return;
    const st = await navigator.permissions.query({ name: 'camera' });
    if (st.state !== 'granted' || cameraBusy || (tracking && tracking.running)) return;
    cameraBusy = true;
    try {
      const cams = await tracking.list({ requestPermission: false });
      if (!cams.length || tracking.error) return;
      const cam = await tracking.open(null);
      if (cam.presetKey && TRACKING.cameraPresets[cam.presetKey] && cam.presetKey !== S.cameraPreset) applySettings({ cameraPreset: cam.presetKey });
      ui.setCameraPreview(cam.video);
    } finally {
      cameraBusy = false;
    }
  } catch {
    /* Firefox has no 'camera' permission name; the camera screen asks as before. */
  }
}

/** Every pose result from MediaPipe (real camera). */
function onPoseFrame(frame) {
  lastPoseFrame = frame;
  ui.setSkeleton(frame);
  frameWarning = frameWatch.update(frame);
  const live = game && !game.attract && !game.done && inputMode === 'camera' && !paused && !replay && ui.screen === 'play';
  let sample;
  try {
    sample = live ? human.onPoseFrame(game.world, frame, clock.simTimeOf(frame.t)) : human.bodyTracker.update(frame);
  } catch (err) {
    errors.push(String(err && err.message));
    return;
  }
  lastSample = sample;
  const m = motion.update(sample);
  const people = frame.people ? frame.people.length : 0;
  if (people) trackingSeen = true;
  if (people && sample && sample.valid) ui.setTitleHandHint(true);
  if (ui.screen === 'calibrate') {
    const vis = bodyVisibility(frame);
    const cal = human.bodyTracker.calibration;
    ui.calibration({
      bodyInFrame: vis.bodyInFrame,
      visible: vis.visible,
      distance: sample && sample.valid ? sample.room.d : null,
      still: m.still,
      tracking: people ? 'ok' : trackingSeen ? 'lost' : 'searching',
      offset: cal && cal.ok && sample && sample.valid ? sample.offset : null,
      swingAt: m.swingAt,
    });
  }
  // Hand cursor in menus; the both-hands-up pause gesture works everywhere.
  const menu = ui.screen !== 'play' || paused;
  cursor.setEnabled(menu && !replay);
  const cs = cursor.update(sample && sample.valid ? sample : null);
  if (cs && cs.visible && !audioUnlocked) tryUnlockAudio();
  if (ui.screen === 'drill-intro' && introDrillId && m.raisedFor > 0.8) {
    const id = introDrillId;
    introDrillId = null;
    startGame({ kind: 'drill', drillId: id });
  }
}

function onPoseStatus(s) {
  if (s.phase === 'loading') ui.toast(s.message || 'Loading pose model…');
  else if (s.phase === 'ready') ui.toast(s.message || 'Pose tracking ready');
  else if (s.phase === 'error') ui.toast(s.message || 'Pose tracking error');
}

// ---------------------------------------------------------------------------------------
// UI handlers

const handlers = {
  onStartDrill(id) {
    requestStart({ kind: 'drill', drillId: id });
  },
  onStartRally(level) {
    hubLevel = level || hubLevel;
    requestStart({ kind: 'rally', level: hubLevel });
  },
  onStartMatch(level) {
    hubLevel = level || hubLevel;
    requestStart({ kind: 'match', level: hubLevel });
  },
  onCalibrate() {
    const ok = human.calibrate();
    ui.toast(ok ? 'Home position saved · posición guardada' : 'Could not see you clearly. Stay in frame and try again.');
    if (audio) audio.ui(ok ? 'confirm' : 'error');
  },
  onCameraSelect(deviceId, presetKey) {
    if (presetKey && presetKey !== S.cameraPreset) applySettings({ cameraPreset: presetKey });
    const cur = tracking.camera ? tracking.camera.deviceId : null;
    if (deviceId && deviceId !== cur) enterCamera(deviceId);
  },
  onSettings(patch) {
    applySettings(patch);
  },
  onPause() {
    if (replay) stopReplay();
    else pause();
  },
  onResume() {
    resume();
  },
  onQuit() {
    replay = null;
    endGame();
    stage.setView('orbit');
    cursor.setEnabled(true);
  },
  onRestart() {
    if (lastSpec) startGame(lastSpec);
  },
  onReplay() {
    startReplay();
  },
  onUseFallbackControls() {
    inputMode = 'fallback';
    ensureFallback();
    stopAttract();
    ui.toast('Mouse / trackpad controls · flick or Space to swing · WASD moves');
    if (pendingStart) startGame(pendingStart);
    else ui.show('hub', hubData());
  },
  onCameraRetry() {
    enterCamera();
  },
  onScreen(name, data) {
    if (name !== 'title' && game && game.attract) stopAttract();
    switch (name) {
      case 'title':
        startAttract();
        break;
      case 'camera':
        enterCamera();
        break;
      case 'hub':
        ui.show('hub', hubData());
        if (pendingStart && (inputMode !== 'camera' || (tracking && tracking.running))) startGame(pendingStart);
        break;
      case 'drill-intro':
        introDrillId = data && data.drill ? data.drill.id : null;
        break;
      default:
        break;
    }
  },
};

// ---------------------------------------------------------------------------------------
// Frame loop

function tryUnlockAudio() {
  if (!audio || audioUnlocked) return;
  audio.unlock().then((ok) => {
    if (ok && !audioUnlocked) {
      audioUnlocked = true;
      audio.setVolume(S.volumes);
      audio.ambience(true);
    }
  }).catch(() => {});
}

function stepGame(nowMs, dtReal) {
  const g = game;
  const w = g.world;
  const t0 = w.time;
  let alpha = 1;
  // Camera input: the measured capture -> result delay and frame interval set the judge margin.
  if (g.input === 'camera' && tracking && tracking.stats && tracking.stats.frames > 5) {
    const ts = tracking.stats;
    w.tracking.delay = clamp(ts.latencyMs / 1000, 0, 0.4);
    w.tracking.frameDt = ts.fps > 1 ? clamp(1 / ts.fps, 1 / 120, 0.2) : 1 / 30;
  }
  if (!paused && !g.done) {
    let target = clock.simTimeOf(nowMs);
    // Catch-up cap per display frame. Accelerated test runs (?speed > 1, often on software GL)
    // may catch up 0.5 s × speed so the sim keeps lockstep with the clock.
    const maxAdv = (clock.speed > 1 ? 0.5 : SIM.maxFrameDt) * clock.speed;
    if (target - w.time > maxAdv) {
      clock.shift(w.time + maxAdv - target);
      target = w.time + maxAdv;
    }
    if (freezeAt !== null && target >= freezeAt) {
      target = freezeAt;
      if (clock.running && w.time + STEP > freezeAt) clock.pause();
    }
    g.advanceTo(target, (ww) => {
      recorder.record(ww);
      if (freezeRule && freezeRule(ww)) {
        freezeRule = null;
        frozen = true;
        freezeAt = ww.time; // the clock may be ahead of the world (catch-up): hold the world here
        clock.pause();
        return true;
      }
      return false;
    });
    alpha = clock.running ? clamp((target - w.time) / STEP, 0, 1) : 1;
    const dts = w.time - t0;
    if (g.session && dts > 0) g.session.tick(dts, { inPlay: g.inPlay(), realSpeed: w.player.speed / Math.max(1, S.gainLateral) });
    if (g.attract && g.isFinished()) {
      endGame();
      startAttract();
      return;
    }
  }
  // Animation dt: sim time while running (slow / fast motion follows ?speed), real time when frozen.
  const dtView = paused || g.done || !clock.running ? dtReal : w.time - t0;
  // Training aids.
  if (!g.attract) {
    const a = aids.update(w, { wantLanding: !!S.landingMarker && S.assist !== 'pro', wantGhost: !!S.contactGhost });
    stage.effects.landingMarker(a.landing);
    stage.effects.contactGhost(a.ghost);
  }
  // Racket display extrapolation: the age of the newest tracked pose (<= 60 ms).
  let extrapolate = 0;
  if (g.input !== 'fallback') {
    const latest = g.human.racketTrack.latest();
    if (latest) extrapolate = clamp(w.time - latest.t, 0, 0.06);
  }
  let selfActor = null;
  if (g.attract && g.feed) {
    const st = g.feed.actorStroke(w);
    const sp = Math.hypot(w.player.vel.x, w.player.vel.z);
    selfActor = {
      pos: w.player.pos, vel: w.player.vel, facing: Math.PI, handed: S.handed,
      stroke: st ? st.stroke : null, swingPhase: st ? st.swingPhase : 0, holding: st ? 'swing' : sp > 0.6 ? 'run' : 'ready',
    };
  }
  stage.syncWorld(w, dtView, { alpha, extrapolate, selfActor, showRig: !g.attract });
  // HUD at 10 Hz.
  hudAcc += dtReal;
  if (!g.attract && hudAcc >= 0.1 && (ui.screen === 'play' || ui.screen === 'pause')) {
    hudAcc = 0;
    const h = g.hud();
    // Arrow only for a ball well outside the picture (beside or behind you).
    const bi = ui.screen === 'play' ? stage.ballIndicator(w.ball) : null;
    h.ballIndicator = bi && Math.abs(bi.angle) > 1.1 ? bi : null;
    // Ball in play (until the ruling): HUD blocks near the action step back.
    h.live = g.inPlay();
    // Camera input: tell the player when the camera loses them (a living room is small).
    if (g.input === 'camera' && frameWarning && ui.screen === 'play') h.prompt = `${frameWarning.text}`;
    ui.hud(h);
    g.emitHud(h);
    // Zone labels in the 3D scene keep out from under the HUD blocks.
    stage.effects.setLabelOccluders(hudRects());
  }
  if (results && performance.now() >= results.at) showResults();
}

/** Visible HUD blocks as screen rects (0..1, y down) for the 3D label layout. */
function hudRects() {
  const W = window.innerWidth || 1, H = window.innerHeight || 1;
  const out = [];
  for (const el of uiRoot.querySelectorAll('.vp-hud .hud-tl, .vp-hud .hud-tr, .vp-hud .shotcard, .vp-hud .hud-prompt')) {
    if (el.hidden || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push([r.left / W, r.top / H, r.right / W, r.bottom / H]);
  }
  return out;
}

function stepReplay(dtReal) {
  const r = replay;
  const more = r.player.step(dtReal, 3);
  if (!more) {
    stopReplay();
    return;
  }
  if (r.player.loops === 1 && r.view === 'broadcast' && !r.switched) {
    r.switched = true;
    r.view = 'side';
    stage.fpCam.setReplayView('side');
  }
  const f = r.player.frame();
  stage.syncWorld(f.world, dtReal * r.player.rate, { alpha: 1, selfActor: f.selfActor, racketPath: f.racketPath, ghostPose: f.ghostPose, showRig: false, dtReal });
  const bar = replayBadge.querySelector('i');
  if (bar) bar.style.width = `${Math.round(clamp(f.progress, 0, 1) * 100)}%`;
}

function frame(nowMs) {
  requestAnimationFrame(frame);
  const dtReal = clamp((nowMs - lastMs) / 1000, 0, 0.1);
  lastMs = nowMs;
  try {
    if (replay) stepReplay(dtReal);
    else if (game) stepGame(nowMs, dtReal);
    else stage.syncWorld(null, dtReal, {});
    if (fallback) fallback.enabled = inputMode === 'fallback' && !!game && !game.attract && ui.screen === 'play' && !paused && !replay;
    if (audio && audioUnlocked) {
      const L = stage.listener();
      audio.setListener(L.pos, L.fwd, L.up);
    }
    stage.render(dtReal);
    if (debug) {
      debug.update(dtReal, {
        render: stage.app.stats, pose: tracking ? tracking.stats : null, poseStatus: tracking ? tracking.status.message : '',
        world: game ? game.world : null, stats: game ? game.stats : null, latency: game ? game.world.settings.latency : S.latency,
        speed: clock.speed, quality: S.quality, input: inputMode,
      });
    }
  } catch (err) {
    errors.push(String(err && err.stack ? err.stack : err));
    if (errors.length < 5) console.error('[vibora] frame error', err);
  }
}

// ---------------------------------------------------------------------------------------
// Keyboard extras (R replay, V replay view), gestures that unlock audio, tab hiding

function onKey(e) {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key;
  if (replay) {
    if (k === 'v' || k === 'V') cycleReplayView();
    else if (k === 'r' || k === 'R' || k === 'Enter' || k === ' ') stopReplay();
    return;
  }
  if ((k === 'r' || k === 'R') && game && !game.attract && (ui.screen === 'play' || ui.screen === 'pause' || ui.screen === 'results')) {
    startReplay();
  }
}

function installGestureUnlock() {
  const fn = () => {
    tryUnlockAudio();
    if (audioUnlocked) {
      window.removeEventListener('pointerdown', fn, true);
      window.removeEventListener('keydown', fn, true);
    }
  };
  window.addEventListener('pointerdown', fn, true);
  window.addEventListener('keydown', fn, true);
}

// ---------------------------------------------------------------------------------------
// Boot

async function boot() {
  ui = createUI(uiRoot, handlers);
  ui.settings(S);
  ui.setLoading(0.04, 'Loading fonts…');
  replayBadge = document.createElement('div');
  replayBadge.className = 'vp-replay';
  replayBadge.hidden = true;
  replayBadge.innerHTML = '<b>Instant replay</b><span>0.4× · cyan: your tracked racket path</span><small>V view · R / Esc exit</small><span class="rb-bar"><i></i></span>';
  uiRoot.appendChild(replayBadge);

  await Promise.race([
    Promise.all([loadFonts(), document.fonts ? document.fonts.ready : null]),
    new Promise((r) => setTimeout(r, 2500)),
  ]);
  ui.setLoading(0.15, 'Setting up the court…');
  await new Promise((r) => setTimeout(r, 0));

  stage = await createStage({
    canvas,
    settings: S,
    quality: S.quality,
    progress: async (p, text) => {
      ui.setLoading(p, text);
      await new Promise((r) => requestAnimationFrame(() => r()));
    },
  });
  window.addEventListener('resize', () => stage.resize());

  audio = P.noAudio ? null : createAudio();
  if (audio) audio.setVolume(S.volumes);
  voice = createVoice({ lang: S.voice === 'es' ? 'es' : 'en' });
  voice.setEnabled(S.voice !== 'off');
  installGestureUnlock();

  human = createHumanController({ settings: S });
  tracking = createTracking({ video, onFrame: onPoseFrame, onStatus: onPoseStatus, model: TRACKING.model });
  cursor = createHandCursor({ root: uiRoot, ui, onPause: () => handlers.onPause() });
  if (P.debug) debug = createDebugOverlay();
  window.addEventListener('keydown', onKey);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden && game && !game.attract && ui.screen === 'play' && !replay) pause();
  });

  ui.setLoading(0.95, 'Ready');
  requestAnimationFrame((t) => {
    lastMs = t;
    requestAnimationFrame(frame);
  });

  // Initial route.
  const spec = P.mode ? { kind: P.mode, level: P.level } : { kind: 'drill', drillId: P.drill && getDrill(P.drill) ? P.drill : 'fh-drive' };
  if (inputMode === 'autopilot') {
    startGame(spec);
  } else if (inputMode === 'fallback') {
    ensureFallback();
    if (P.drill || P.mode) startGame(spec);
    else ui.show('hub', hubData());
  } else if (P.drill || P.mode) {
    pendingStart = spec;
    ui.show('title');
    enterCamera();
  } else {
    ui.show('title');
    startAttract();
    warmCamera();
  }
  vibora.ready = true;
}

// ---------------------------------------------------------------------------------------
// Test / debug handle

const vibora = {
  ready: false,
  params: P,
  settings: S,
  clock,
  get world() { return game ? game.world : null; },
  get game() { return game; },
  get screen() { return ui ? ui.screen : null; },
  get replaying() { return !!replay; },
  get stage() { return stage; },
  get fallback() { return fallback; },
  get errors() { return errors.slice(); },
  get stats() {
    const s = game && !game.attract ? game.stats : null;
    return {
      playerHits: s ? s.playerHits : 0,
      reps: s ? s.reps : 0,
      inCourt: s ? s.inCourt : 0,
      judgedShots: s ? s.judgedShots : 0,
      points: s ? s.points : 0,
      feeds: s ? s.feeds : 0,
      rallies: s ? s.rallies : 0,
      outcomes: s ? { ...s.outcomes } : {},
      lateHits: game && !game.attract ? game.world.hitRejects.late : 0,
      judgeMargin: game ? judgeMargin(game.world) : null,
      errors: errors.length,
      simTime: game ? game.world.time : null,
      finished: game ? game.isFinished() : false,
      fps: stage ? stage.app.stats.fps : 0,
      drawCalls: stage ? stage.app.stats.drawCalls : 0,
    };
  },
  /** Sim time of the autopilot's next planned contact (or null). */
  nextContact() {
    return game && game.feed ? game.feed.nextContact : null;
  },
  /** Stops the simulation at sim time t (rendering continues); resume() releases it. */
  freezeAt(t) {
    freezeAt = t;
  },
  resume() {
    freezeAt = null;
    freezeRule = null;
    frozen = false;
    if (!clock.running && !paused) clock.resume();
  },
  /**
   * Deterministic freeze for screenshots: 'contact' stops `offset` s before the autopilot's
   * next planned contact, 'hit' stops `offset` s after the next player hit's contact time.
   */
  freezeOn(kind, offset = 0.06) {
    if (!game) return;
    const w = game.world;
    const t0 = w.time;
    frozen = false;
    if (kind === 'contact') {
      freezeRule = (ww) => {
        const c = game && game.feed ? game.feed.nextContact : null;
        const incoming = ww.ball && ww.flight.team !== 0;
        return incoming && c !== null && c - offset > t0 + 0.05 && ww.time >= c - offset && ww.time < c + 0.2;
      };
    } else {
      const h0 = game.stats.playerHits;
      freezeRule = (ww) => game.stats.playerHits > h0 && ww.time >= game.stats.lastShot.t + offset;
    }
  },
  get frozen() { return frozen; },
  /** Seeks the running replay to `dt` s relative to its last player contact. */
  replaySeek(dt = -0.1) {
    if (!replay) return;
    const hits = replay.player.hits;
    const ref = hits.length ? hits[hits.length - 1] : replay.player.t;
    replay.player.seek(ref + dt);
  },
  /** Test hook: feeds a PoseFrame as if it came from the camera (stops the real tracker). */
  injectPoseFrame(frame) {
    if (tracking && tracking.camera) tracking.stop();
    onPoseFrame(frame);
  },
  get calibration() { return human ? { ...human.bodyTracker.calibration } : null; },
  replayInfo() {
    if (!replay) return null;
    const f = replay.player.frame();
    const cam = stage.app.camera.position;
    return {
      t: replay.player.t, loops: replay.player.loops, ball: f.world.ball ? f.world.ball.pos : null, self: f.selfActor.stroke,
      selfPos: { x: f.selfActor.pos.x, z: f.selfActor.pos.z }, camera: { x: cam.x, y: cam.y, z: cam.z }, path: f.racketPath.length, view: replay.view,
    };
  },
  startReplay,
  stopReplay,
  pause,
  showResultsNow() {
    if (game && !game.attract) {
      results = results || { at: 0, payload: null };
      results.at = 0;
    }
  },
};
window.__vibora = vibora;

boot().catch((err) => {
  errors.push(String(err && err.stack ? err.stack : err));
  console.error('[vibora] boot failed', err);
  const el = document.createElement('div');
  el.className = 'vp-fatal';
  el.textContent = `Víbora Padel could not start: ${err && err.message ? err.message : err}. Try reloading, or a current Chrome / Safari with WebGL enabled.`;
  document.body.appendChild(el);
});
