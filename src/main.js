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
import { createGame, STEP, timingKey } from './app/game.js';
import { sharedTimingProfile, resetTimingProfile } from './game/timingProfile.js';
import { activeHitting } from './game/swingAssist.js';
import { bindWorld } from './app/wiring.js';
import { createAids } from './app/aids.js';
import { createRecorder, createReplayPlayer, createReplayDirector } from './app/replay.js';
import { createTracking, bodyVisibility, createMotionWatch, createFrameWatch } from './app/tracking.js';
import { createDebugOverlay } from './app/debug.js';
import { installPrivacyGuard } from './app/privacy.js';
import { initPwa } from './app/pwa.js';
import { buildDiagnostics, browserEnv } from './app/diagnostics.js';
import { installGlasses } from './xr/boot.js';
// Swipe mode for phones and tablets (iPhone first): touch input, chase camera, mobile render tier.
import { createMobile, savePrefs } from './app/mobile.js';
import { QUALITY } from './render/scene.js';
// Round 4: career, arcade, progression, achievements.
import { createProgress, xpForSession, levelOf, rankTitle, RACKETS, OUTFITS, racketById, outfitById, unlockText } from './game/progression.js';
import { createCareer, EVENT_BY_ID, PARTNERS, PAIRS, VENUES, venueById, playerCard, matchSpec, trophyName } from './game/career.js';
import { CHALLENGES, CHALLENGE_BY_ID, createLeaderboards, dailyChallenge, dateKey } from './game/challenges.js';
import { ACHIEVEMENTS, createAchievementTracker } from './game/achievements.js';
import { createGlassTargets } from './render/glassTargets.js';
import { createMatch } from './rules/scoring.js';

installPrivacyGuard();

const P = parseParams(location.search);
// Round 4 URL flags (?challenge, ?career, ?quick, ?autoreplay, ?screen, ?venue...) are parsed with the
// rest in app/params.js; P4 keeps the old name for them.
const P4 = P;
const storage = safeStorage();
const store = createSettingsStore(storage);
const S = store.value;
const progress = createProgress({ storage });
const career = createCareer({ storage });
const boards = createLeaderboards({ storage });
// The equipped racket / outfit live in the profile; the settings mirror them for the renderer.
if (S.racketModel !== progress.data.racket) S.racketModel = progress.data.racket;
if (S.outfit !== progress.data.outfit) S.outfit = progress.data.outfit;
if (P4.venue) S.venue = P4.venue;
// URL overrides apply to this visit only (not persisted unless changed in Settings).
if (P.quality) S.quality = P.quality;
if (P.assist) S.assist = P.assist;
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
let pwa = null; // app packaging: service worker, install button, display mode
let xrBoot = null; // glasses mode (src/xr/boot.js): app.xr, recentre keys, stereo HUD, panels
let glassTargets = null; // Glass Breaker targets (render/glassTargets.js)
let director = null; // automatic replays of special moments (app/replay.js)
let tracker = null; // achievements of the session (game/achievements.js)
let sessionAch = []; // achievements earned this session (results screen)
let sessionStartLevel = 1; // level at the session start (level-ups shown on the results)
let sessionUnlocks = []; // rackets / outfits unlocked by achievement XP during the session
const recorder = createRecorder({ seconds: 6, hz: 60 });
const aids = createAids();
const motion = createMotionWatch();
// Close mode (round 4): only the head and shoulders must be in the picture; the legs are never asked for.
const frameWatch = createFrameWatch({ upperBody: true, handsTop: true });
let frameWarning = null; // out-of-frame warning for the play HUD (camera input)

let inputMode = P.autopilot ? 'autopilot' : P.fallback ? 'fallback' : 'camera';
// Swipe mode ('touch'): on by default on touch-first devices (iPhone / iPad), or ?input=swipe;
// ?autopilot and ?fallback still win, and the Mac keeps the camera (src/app/mobile.js decideInput).
const mobile = createMobile({ storage, QUALITY });
if (mobile.input === 'touch' && inputMode === 'camera') inputMode = 'touch';
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
let venueBinding = null; // the session's crowd / umpire / callouts (audio/venueAudio.js bindVenue via wiring.js)
let hudAcc = 0;
/** First-time timing prompt (startGame): { done } or null. */
let firstHits = null;
const FIRST_HITS = 5;
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
  // The lens preset also sets the capture-time offset used when the browser gives no
  // capture timestamps (Safari); the off-axis yaw correction is an experimental toggle.
  if (keys.includes('cameraPreset') && tracking) tracking.setCameraPreset(S.cameraPreset);
  if (keys.includes('offAxisYaw') && tracking) tracking.setYawCorrection(!!S.offAxisYaw);
  if (keys.includes('gainLateral') || keys.includes('gainDepth')) {
    human.locomotion.config.gainLateral = S.gainLateral;
    human.locomotion.config.gainDepth = S.gainDepth;
  }
  if (keys.includes('volumes') && audio) audio.setVolume(S.volumes);
  if (keys.includes('volumes') && voice) voice.setVolume(S.volumes.master ?? 1);
  if (keys.includes('voice') && voice) {
    // Voice coach off silences the coach only: the umpire and the players' calls have their own settings.
    voice.setCoach(S.voice !== 'off');
    if (S.voice !== 'off') voice.setLang(S.voice);
  }
  // Umpire language / partner callouts apply to the running session at once (audio/umpire.js).
  if ((keys.includes('umpireLang') || keys.includes('callouts')) && venueBinding && venueBinding.umpire) {
    const u = venueBinding.umpire;
    u.setEnabled(S.umpireLang !== 'off');
    if (S.umpireLang === 'en' || S.umpireLang === 'es') u.setLang(S.umpireLang);
    u.setCallouts(S.callouts !== false);
  }
  if (keys.includes('viewPitch')) FALLBACK.pitchDeg = S.viewPitch;
  if (keys.includes('cameraTilt')) applyCameraTilt();
  // Round 4: racket model (render/racket.js setModel) and outfit (first-person kit; presence engineer's rig API).
  if (keys.includes('racketModel') && stage) applyRacketModel();
  if (keys.includes('outfit') && stage) applyOutfit();
  // Free-play venue: the menu scene behind the screens switches at once (a session keeps its own).
  if (keys.includes('venue') && stage && (!game || game.attract)) setVenue(S.venue);
  if (keys.includes('gazeFollow') && stage) stage.setGaze(S.gazeFollow && inputMode !== 'fallback');
  if (game) game.syncSettings(S);
  if (ui) ui.settings(S);
}

function setVenue(venue) {
  if (!stage) return;
  try {
    if (typeof stage.setVenue === 'function') stage.setVenue(venue);
    else if (stage.env && typeof stage.env.setVenue === 'function') stage.env.setVenue(venue);
    // Mobile tier: one shadow-casting light per venue.
    mobile.applyBudget(stage);
    // The venue's acoustics, ambience bed and crowd (audio/engine.js setVenue; a no-op when unchanged).
    if (audio && stage.env) audio.setVenue(stage.env.venue);
  } catch (err) {
    errors.push(`venue: ${String(err && err.message ? err.message : err)}`);
  }
}

function applyRacketModel() {
  const r = stage && stage.rig && stage.rig.racketMesh;
  if (r && r.userData && r.userData.setModel) r.userData.setModel(S.racketModel, S.racketColor);
}

/** Outfit colours on the player's own bodies: first-person body, replay body, first-person rig sleeves. */
function applyOutfit() {
  const o = outfitById(S.outfit);
  const kit = { shirt: o.shirt, trim: o.band, shorts: o.shorts, shortsTrim: o.band };
  for (const body of [stage && stage.fpBody, stage && stage.self]) {
    if (body && typeof body.setKit === 'function') body.setKit(kit);
  }
  if (stage && stage.rig && typeof stage.rig.setOutfit === 'function') stage.rig.setOutfit(o);
}

// ---------------------------------------------------------------------------------------
// Sessions

function nextSeed() {
  seedCounter = ((Math.imul(seedCounter, 1103515245) + 12345) >>> 0) || 1;
  return seedCounter % 2147483647;
}

/** Enters the play view: first person, or in swipe mode the player's choice (behind / first person). */
function playView() {
  if (inputMode === 'touch') mobile.enterPlayView(stage);
  else stage.setView('fp');
}

function endGame() {
  if (unbindGame) unbindGame();
  unbindGame = null;
  venueBinding = null;
  mobile.detachGame();
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
  if (glassTargets) glassTargets.clear();
  director = null;
  tracker = null;
  if (!clock.running) clock.resume();
  clock.setRate(1);
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
  // Venue of this session: render/environment.js env.setVenue(id) swaps the venue layer (a no-op when
  // it is already up); a stage-level setVenue (lights, mirror, crowd wiring) is preferred when present.
  setVenue(attract ? S.venue : spec.venue || S.venue || 'club');
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
    apProfile: P.apProfile,
    apJitter: P.apJitter,
    apNoise: P.apNoise,
    apClose: P.apClose,
    attract,
    onFrame: input === 'autopilot' && !attract ? (frame) => { lastPoseFrame = frame; ui.setSkeleton(frame); } : null,
  });
  game = g;
  if (input === 'touch') mobile.attachGame(g, { clock });
  else mobile.detachGame();
  // Fun review r5 ("guided first rally", the cheap part): a player who has never finished a session
  // gets a timing prompt on the HUD until their first FIRST_HITS hits (`?firsthits=1` forces it).
  const life = progress.data && progress.data.lifetime;
  firstHits = !attract && (input !== 'autopilot' || P.firstHits) && (P.firstHits || !(life && (life.sessions > 0 || life.shots > 0)))
    ? { done: false } : null;
  recorder.clear();
  sessionAch = [];
  sessionUnlocks = [];
  sessionStartLevel = progress.level.level;
  tracker = attract ? null : createAchievementTracker({ has: (id) => !!progress.data.achievements[id], ctx: { kind: spec.kind } });
  const autoReplay = P4.autoReplay ?? (S.autoReplay !== false && input !== 'autopilot');
  // Drills replay only the rare moments (por tres, perfect-timing streaks), at most every 45 s;
  // a timed arcade run keeps its flow: one or two highlights (a por tres is routine in Por Tres
  // Party, so there only the rarer por cuatro); a match replays at most the best moment of each game
  // (and 45 s apart), a rally one per 2 min (QA r5: one point in three was replayed).
  director = attract || !autoReplay ? null : createReplayDirector(spec.kind === 'drill'
    ? { minGap: 45, kinds: ['por-tres', 'por-cuatro', 'perfect'] }
    : spec.kind === 'challenge'
      ? { minGap: 40, kinds: String(spec.challengeId || '').includes('por-tres') ? ['por-cuatro', 'long-rally'] : ['por-tres', 'por-cuatro', 'target', 'long-rally'] }
      : spec.kind === 'match' ? { minGap: 45, perGame: true } : { minGap: 120 });
  const wctx = {
    audio, voice, stage, ui, recorder, quiet: attract,
    // The umpire calls the player's pair "Víbora"; a career rival pair by its name.
    umpireTeams: spec.career && spec.pairName ? [{ en: 'Víbora', es: 'Víbora' }, { en: spec.pairName, es: spec.pairName }] : null,
    onDrillEnd: (p) => scheduleResults(p),
    onMatchEnd: (p) => scheduleResults(p),
    onChallengeEnd: (p) => scheduleResults(p),
    onMatchPoint: (p) => { if (g.spec.career && !g.done) career.saveMidMatch(p.points); },
    achievements: tracker,
    onAchievement: (a) => earnAchievement(a),
    director,
    glassTargets,
    arcade: spec.kind === 'challenge',
  };
  // Swipe mode: wiring sees the behind (chase) view as a play view (approach circle, ghost, timing tick).
  if (input === 'touch') wctx.stage = mobile.playStage(stage);
  unbindGame = bindWorld(g.world, wctx);
  venueBinding = wctx.venue || null;
  stage.effects.targets(g.drill ? g.drill.targets : null);
  if (attract) {
    stage.setView('orbit');
    return g;
  }
  lastSpec = spec;
  pendingStart = null;
  paused = false;
  stage.setGaze(S.gazeFollow && input !== 'fallback');
  playView();
  if (fallback) fallback.enabled = input === 'fallback';
  cursor.setEnabled(false);
  ui.show('play', { mode: spec.kind, hud: g.hud() });
  if (input === 'fallback') ui.toast('Mouse moves the racket · flick or press Space as the ball comes · WASD moves');
  if (input === 'autopilot') ui.toast('Autopilot: a virtual player drives the tracking pipeline');
  // Glasses: recentre the head-tracked view at every drill / rally / match start (setting).
  if (xrBoot) xrBoot.onSessionStart();
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
  // Swings: the tracking's swing events, else the strokes (session log / player hits).
  const swings = Math.max(ses.swings || 0, g.stats.playerHits || 0);
  const fitness = { activeSeconds: ses.activeSeconds, swings, kcal: ses.kcal, peakSwingKmh: ses.peakSwingKmh };
  let data;
  let xpIn = { kind: g.spec.kind, activeSeconds: ses.activeSeconds };
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
      misses: sum.misses || null,
    };
    xpIn = { ...xpIn, stars: sum.stars, points: sum.points };
  } else if (g.spec.kind === 'challenge') {
    const lb = boards.submit(sum.boardId, { score: sum.score, combo: sum.maxCombo, perfect: sum.perfect });
    data = { ...ses, ...sum, mode: 'challenge', leaderboard: lb, title: sum.name };
    xpIn = { ...xpIn, score: sum.score, daily: !!sum.daily, newBest: lb.isBest && lb.previousBest !== null };
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
      misses: sum.misses || null,
      // Match / rally header and stats (ui.js renderResults): scoreline, points won, best rally.
      scoreline: sc ? { names: sum.teamNames || null, games: sc.games.slice(), sets: (sc.sets || []).map((x) => x.slice()), won } : null,
      pointsWon: sc ? (sum.points || []).filter((q) => q.winner === 0).length : sum.won || 0,
      pointsPlayed: sc ? (sum.points || []).length : (sum.won || 0) + (sum.lost || 0),
      bestRally: sum.bestRally || ses.bestRally || 0,
      cleanGames: sum.cleanGames || 0,
    };
    xpIn = { ...xpIn, won, gamesWon: sc ? sc.games[0] : 0, bestRally: sum.bestRally || ses.bestRally || 0, playerHits: sum.playerHits || 0 };
    if (g.spec.career) {
      const res = career.recordMatch({ won: !!won, score: sc, pointsWon: data.pointsWon, pointsPlayed: data.pointsPlayed });
      if (res) {
        const ev = EVENT_BY_ID[res.eventId];
        data.career = g.spec.career;
        data.careerResult = {
          ...res,
          eventName: ev.name,
          nextPair: res.nextMatch ? res.nextMatch.pairName : null,
          unlockedName: res.unlockedEvent ? EVENT_BY_ID[res.unlockedEvent].name : null,
        };
        data.title = won ? `${g.spec.career.round} won` : `${g.spec.career.round} lost`;
        if (res.eventDone) {
          const tr = progress.awardTrophy(res.eventId, res.place);
          data.careerResult.trophyUnlocks = tr.unlocks;
          for (const a of tracker ? tracker.onCareer(res) : []) earnAchievement(a, { toast: false });
        }
        xpIn.career = { eventWon: res.eventWon, eventDone: res.eventDone, tier: ev.tier };
        if (res.unlockedByAttempts) data.careerResult.unlockedName = EVENT_BY_ID[res.unlockedByAttempts].name;
      }
    }
  }
  // Lifetime fitness, streak, achievements of the session, XP.
  progress.recordSession({ activeSeconds: ses.activeSeconds, kcal: ses.kcal, swings, shots: g.stats.playerHits, bestRally: ses.bestRally, drillId: g.spec.kind === 'drill' ? g.drill.id : null });
  if (tracker) for (const a of tracker.onSession(ses, progress.data, DRILLS.length)) earnAchievement(a, { toast: false });
  // Achievement XP was added as each was earned (earnAchievement); the session's XP now.
  const xp = xpForSession(xpIn);
  const achXp = sessionAch.reduce((n, a) => n + a.xp, 0);
  const lvl = progress.addXp(xp.xp);
  const levelUps = [];
  for (let l = sessionStartLevel + 1; l <= lvl.after; l++) levelUps.push(l);
  const unlocks = [...sessionUnlocks, ...lvl.unlocks, ...((data.careerResult && data.careerResult.trophyUnlocks) || [])];
  sessionUnlocks = [];
  data.rewards = {
    xp: lvl.gained + achXp, parts: achXp ? [...xp.parts, { xp: achXp, en: 'Achievements', es: 'Logros' }] : xp.parts,
    levelUps, unlocks, achievements: sessionAch.slice(), profile: profileInfo(),
  };
  data.fitness = fitness;
  stage.setView('orbit');
  ui.banner('');
  ui.results(data);
  cursor.setEnabled(true);
  if (audio) audio.ui('success');
  if (levelUps.length) ui.toast(`Level ${lvl.after}! · ¡Nivel ${lvl.after}!`);
}

/** Records an earned achievement (profile + toast); its XP is added with the session's. */
function earnAchievement(a, { toast = true } = {}) {
  if (!a || !progress.unlockAchievement(a.id)) return;
  sessionAch.push(a);
  // Its XP counts at once (kept even if the session is left before its results).
  sessionUnlocks.push(...progress.addXp(a.xp).unlocks);
  if (toast && ui) ui.achievement(a);
  if (audio && audio.ui) audio.ui('success');
}

/** Profile summary for the hub, career and results. */
function profileInfo() {
  const p = progress.data;
  const L = levelOf(p.xp);
  return {
    ...L, xp: p.xp, title: rankTitle(L.level), racket: racketById(p.racket), outfit: outfitById(p.outfit),
    trophies: Object.values(p.trophies).filter((t) => t.place === 1).length,
    achievements: Object.keys(p.achievements).length, achievementsTotal: ACHIEVEMENTS.length,
    streak: p.streak.days, lifetime: { ...p.lifetime },
    newUnlocks: RACKETS.filter((r) => progress.isNew('racket', r.id)).length + OUTFITS.filter((o) => progress.isNew('outfit', o.id)).length,
  };
}

function roundLabel(e) {
  if (!e || !e.matches) return '';
  const m = e.matches[Math.min(e.matchIndex || 0, e.matches.length - 1)];
  return `${m.round} vs ${PAIRS[m.pair].name}`;
}

function careerData() {
  const evs = career.events().map((e) => ({ ...e, venueName: venueById(e.venue).name, roundLabel: e.status === 'in-progress' ? roundLabel(e) : '' }));
  const cur = career.current();
  return {
    events: evs,
    currentId: cur ? cur.id : null,
    anyInProgress: evs.some((e) => e.status === 'in-progress'),
    partner: career.partner,
    partners: PARTNERS.map((id) => playerCard(id)),
    profile: profileInfo(),
  };
}

const TIPS = {
  lobber: 'They lob a lot: stay ready to move back, play a bandeja and win the net back.',
  'big-hitter': 'Big hitters miss: keep the ball deep and low, let the glass slow their drives.',
  'wall-master': 'They return everything off the glass: go to their feet with chiquitas and volley.',
  'net-rusher': 'They rush the net: lob over them and pass down the middle.',
  chiquita: 'Soft balls at your feet: bend your knees, block the low volley deep.',
  'all-rounder': 'No obvious weakness: be patient, play to the middle and wait for the short ball.',
};

function eventIntroData(eventId) {
  const ev = EVENT_BY_ID[eventId];
  if (!ev) return {};
  const evs = career.events();
  const e = evs.find((x) => x.id === eventId);
  const act = career.active && career.active.eventId === eventId ? career.active : null;
  const mi = act ? act.matchIndex : 0;
  const spec = matchSpec(eventId, mi, career.partner, { resume: act && act.points.length ? { points: act.points } : null, form: career.form });
  const opp = spec.opponents.map((o) => playerCard(o.id));
  let resumeScore = null;
  if (act && act.points.length) {
    // The score the match will resume at (replayed through the real scoring).
    const m = createMatch({ gamesPerSet: spec.games, setsToWin: 1, goldenPoint: true, tiebreakAt: spec.games, firstServer: { team: 1, player: 0 } });
    for (const w of act.points) if (!m.isOver) m.pointWonBy(w);
    const d = m.display();
    resumeScore = `${d.games[0]}–${d.games[1]} · ${d.points[0] || '0'}–${d.points[1] || '0'}`;
  }
  const persona = opp.map((o) => o.personality);
  return {
    event: { ...ev, venueName: venueById(ev.venue).name },
    spec, matchIndex: mi, opponents: opp, partner: playerCard(career.partner), pairName: spec.pairName,
    resumeScore, canAbandon: !!act, racketName: racketById(progress.data.racket).name,
    tip: TIPS[persona[0]] || TIPS['all-rounder'],
    status: e ? e.status : 'open',
  };
}

function trophiesData(tab = 'trophies') {
  const p = progress.data;
  const evs = career.events();
  return {
    tab,
    profile: profileInfo(),
    events: evs,
    rackets: RACKETS.map((r) => ({
      ...r, unlocked: progress.isUnlocked('racket', r.id), equipped: p.racket === r.id, isNew: progress.isNew('racket', r.id),
      unlockText: unlockText(r.unlock, trophyName).en,
    })),
    outfits: OUTFITS.map((o) => ({
      ...o, unlocked: progress.isUnlocked('outfit', o.id), equipped: p.outfit === o.id, isNew: progress.isNew('outfit', o.id),
      unlockText: unlockText(o.unlock, trophyName).en,
    })),
    achievements: ACHIEVEMENTS.map((a) => ({ ...a, earned: !!p.achievements[a.id] })),
    lifetime: { ...p.lifetime },
    streak: { ...p.streak },
  };
}

function arcadeData(selected = null) {
  const d = dailyChallenge(dateKey());
  const base = CHALLENGE_BY_ID[d.base];
  const daily = {
    ...base, ...d, id: d.id, isDaily: true, baseName: base.name, best: boards.best(d.id), desc: base.desc, rules: base.rules, duration: d.duration,
  };
  const challenges = CHALLENGES.map((c) => ({ ...c, best: boards.best(c.id) }));
  const ids = [daily.id, ...challenges.map((c) => c.id)];
  const out = {};
  for (const id of ids) out[id] = boards.board(id, 8);
  return { daily, challenges, boards: out, selected };
}

function hubData() {
  const reader = createSession({ storage });
  const drills = DRILLS.map((d) => getDrill(d.id, S.handed));
  const bests = {};
  for (const d of drills) {
    const p = reader.bests(d.id);
    if (p !== null) bests[d.id] = { points: p, stars: starsFor(d, p) };
  }
  const input = inputMode === 'touch' ? 'Swipe controls' : inputMode === 'fallback' ? 'Mouse controls' : inputMode === 'autopilot' ? 'Autopilot' : tracking && tracking.camera ? tracking.camera.label : null;
  const cur = career.current();
  const evs = career.events();
  const d = dailyChallenge(dateKey());
  const earned = Object.values(bests).reduce((n, b) => n + (b.stars || 0), 0);
  return {
    drills, bests, level: hubLevel, player: input,
    profile: profileInfo(),
    career: {
      current: cur ? { ...cur, roundLabel: cur.status === 'in-progress' ? roundLabel(cur) : `${cur.matches.length} ${cur.matches.length === 1 ? 'match' : 'matches'} · ${venueById(cur.venue).name}` } : null,
      won: evs.filter((e) => e.status === 'won').length, total: evs.length,
    },
    daily: { ...d, baseName: CHALLENGE_BY_ID[d.base].name, best: boards.best(d.id) },
    stars: { earned, total: drills.length * 3 },
  };
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
  playView();
  ui.show('play');
}

// ---------------------------------------------------------------------------------------
// Instant replay

/**
 * Instant replay. With a moment (app/replay.js director: por tres, winner, long rally, perfect streak,
 * glass target), an automatic slow-motion highlight from cinematic angles, played once and skippable.
 */
function startReplay(moment = null) {
  const snap = recorder.snapshot();
  if (!snap || snap.t1 - snap.t0 < 0.5) {
    if (!moment) ui.toast('Nothing to replay yet · aún no hay repetición');
    return false;
  }
  const returnTo = ui.screen === 'play' ? 'play' : ui.screen;
  if (returnTo === 'play' && game && !paused) {
    paused = true;
    clock.pause();
  }
  let player;
  let view = 'broadcast';
  if (moment && Number.isFinite(moment.t)) {
    const lead = moment.kind === 'long-rally' ? 2.4 : 1.3;
    const tail = moment.kind === 'por-tres' || moment.kind === 'por-cuatro' ? 2.6 : 2.0;
    player = createReplayPlayer(snap, { rate: moment.rate || 0.45, from: Math.max(snap.t0, moment.t - lead), to: Math.min(snap.t1, moment.t + tail) });
    view = (moment.views && moment.views[0]) || 'broadcast';
  } else {
    const last = snap.hits.length ? snap.hits[snap.hits.length - 1].t : null;
    const from = last !== null && last > snap.t0 ? Math.max(snap.t0, last - 2.0) : Math.max(snap.t0, snap.t1 - 4.5);
    player = createReplayPlayer(snap, { rate: 0.4, from });
  }
  replay = { player, returnTo, view, auto: moment, switched: false };
  stage.effects.landingMarker(null);
  stage.effects.contactGhost(null);
  stage.setView('replay');
  stage.fpCam.setReplayView(view);
  uiRoot.classList.add('is-replay');
  setReplayBadge(moment);
  replayBadge.hidden = false;
  if (ui.screen !== 'play') ui.show('play');
  // The first automatic replay says how to turn them off (QA r5).
  if (moment) {
    try {
      if (!storage.getItem('vibora.autoReplayHint.v1')) {
        storage.setItem('vibora.autoReplayHint.v1', '1');
        ui.toast('Auto-replays: On · change in Settings → Game & venue · repeticiones automáticas');
      }
    } catch {
      /* private mode: no hint memory */
    }
  }
  return true;
}

function setReplayBadge(moment) {
  if (moment) {
    replayBadge.innerHTML = `<b>Replay</b><span class="rb-moment"></span><span>${Math.round((moment.rate || 0.45) * 100) / 100}× · slow motion</span><button type="button" class="btn btn-sm rb-skip">Skip ›<span class="es">Saltar · any key</span></button><span class="rb-bar"><i></i></span>`;
    replayBadge.querySelector('.rb-moment').textContent = moment.label || '';
    replayBadge.querySelector('.rb-skip').addEventListener('click', () => stopReplay());
  } else {
    replayBadge.innerHTML = '<b>Instant replay</b><span>0.4× · cyan: your tracked racket path</span><small>V view · R / Esc exit</small><span class="rb-bar"><i></i></span>';
  }
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
    playView();
    ui.show('play');
  } else if (to === 'pause') {
    playView();
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
      // Close mode (ui/calibrate.js): the tracker's estimator, head + shoulders in view, camera tilt,
      // and the movement-gain boost of a close calibration.
      trackMode: sample && sample.valid ? sample.trackMode : null,
      upper: vis.upper,
      tiltDeg: human.bodyTracker.tilt ? human.bodyTracker.tilt.deg : 0,
      // Round 5: the pitch fit of the play-area steps and the overhead check (ui.js area step).
      tilt: human.bodyTracker.tilt ? { deg: human.bodyTracker.tilt.deg, confidence: human.bodyTracker.tilt.confidence, locked: human.bodyTracker.tilt.locked } : null,
      overhead: overheadCheck(frame, sample),
      boost: human.locomotion && human.locomotion.config ? human.locomotion.config.boost || null : null,
      // No capture timestamps from the browser (Safari): the latency step becomes recommended.
      needsLatencyTest: !!(tracking && tracking.needsLatencyTest),
    });
  }
  // Hand cursor in menus; the both-hands-up pause gesture works everywhere.
  const menu = ui.screen !== 'play' || paused;
  cursor.setEnabled(menu && !replay);
  const cs = cursor.update(sample && sample.valid ? sample : null);
  if (cs && cs.visible && !audioUnlocked) tryUnlockAudio();
  // A raised racket skips an automatic replay.
  if (replay && replay.auto && m.raisedFor > 0.6) stopReplay();
  if (ui.screen === 'drill-intro' && introDrillId && m.raisedFor > 0.8) {
    const id = introDrillId;
    introDrillId = null;
    startGame({ kind: 'drill', drillId: id });
  }
}

/** Calibration overhead check: the racket hand raised above the head, and whether it leaves the picture. */
function overheadCheck(frame, sample) {
  const domR = S.handed !== 'left';
  const p0 = frame && frame.people && frame.people[0];
  const l = p0 && p0.landmarks && p0.landmarks[domR ? 16 : 15];
  const w = sample && sample.valid ? sample.joints[domR ? 'wristR' : 'wristL'] : null;
  return {
    raised: !!(w && Number.isFinite(sample.eyeHeight) && w.y > sample.eyeHeight + 0.12),
    out: !!(l && (l.y <= 0.01 || l.x <= 0.005 || l.x >= 0.995)),
  };
}

/** Settings → Camera tilt: 'auto' (measured in calibration and play) or a fixed pitch in degrees. */
function applyCameraTilt() {
  if (!human) return;
  const v = S.cameraTilt;
  if (v === 'auto' || v === undefined) {
    if (human.bodyTracker.tilt && human.bodyTracker.tilt.locked) human.bodyTracker.setTilt(null);
  } else if (Number.isFinite(Number(v))) human.bodyTracker.setTilt(Number(v), { lock: true });
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
  // ---- Round 4: career, arcade, free play, unlocks -------------------------------------------
  onStartCareer(eventId) {
    const spec = career.startEvent(eventId, { quick: P4.quick });
    if (!spec) {
      ui.toast('Win the previous event to unlock it · Gana el torneo anterior');
      return;
    }
    requestStart(spec);
  },
  onAbandonEvent() {
    career.abandon();
    ui.show('career', careerData());
  },
  onCareerPartner(id) {
    if (!career.setPartner(id)) return;
    ui.show('career', careerData());
  },
  onStartChallenge(id) {
    const isDaily = String(id).startsWith('daily');
    const d = isDaily ? dailyChallenge(String(id).split(':')[1] || dateKey()) : null;
    requestStart({ kind: 'challenge', challengeId: d ? d.base : id, daily: d, venue: d ? d.venue : S.venue });
  },
  onEquip(kind, id) {
    if (!progress.equip(kind, id)) return;
    if (kind === 'racket') applySettings({ racketModel: id, racketColor: racketById(id).color });
    else applySettings({ outfit: id });
    const tab = kind === 'racket' ? 'rackets' : 'outfits';
    ui.show('trophies', trophiesData(tab));
    ui.toast(kind === 'racket' ? `${racketById(id).name} equipped · pala elegida` : `${outfitById(id).name} · equipación`);
    if (audio) audio.ui('confirm');
  },
  /** The 3D court behind the menus shows the venue being chosen. */
  onPreviewVenue(venue) {
    if (!game || game.attract) setVenue(venue);
  },
  onStartFree({ mode = 'rally', level = 'club', venue = null, games = 4 } = {}) {
    hubLevel = level || hubLevel;
    if (venue && venue !== S.venue) applySettings({ venue });
    if (mode === 'match') requestStart({ kind: 'match', level: hubLevel, games: games || 4, venue: S.venue });
    else requestStart({ kind: 'rally', level: hubLevel, venue: S.venue });
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
    // A career match left half-way is saved point by point: resume it from the career map.
    if (game && !game.attract && !game.done && game.spec.career) ui.toast('Match saved · resume it from the career · partido guardado');
    endGame();
    stage.setView('orbit');
    cursor.setEnabled(true);
  },
  onRestart() {
    if (!lastSpec) return;
    if (lastSpec.career && career.active && career.active.eventId === lastSpec.career.eventId) {
      // Restart the career match from 0-0 (a finished match continues with the next round instead).
      career.saveMidMatch([]);
      const spec = career.startEvent(lastSpec.career.eventId, { quick: P4.quick });
      if (spec) startGame(spec);
      return;
    }
    startGame(lastSpec);
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
  /** Copy diagnostics (Pause, Settings, D on the pause screen): app/diagnostics.js. */
  onDiagnostics() {
    return diagnosticsData();
  },
  /** Settings → Play: the personal timing readout (round 6). */
  onTimingInfo() {
    return timingInfo();
  },
  /** Settings → Play → Reset timing: forgets the learned timing bias and swing speeds of this camera. */
  onResetTiming() {
    resetTimingProfile(storage, timingKey(S));
    if (audio) audio.ui('confirm');
    return timingInfo();
  },
  onScreen(name, data) {
    // Glasses panel in Settings and Help (idempotent; remounts after each re-render).
    if (xrBoot) xrBoot.onScreen(name);
    // Calibration fits the camera pitch from the spot and play-area steps (tracking/body.js TILT_CAL).
    if (human) human.bodyTracker.setCalibrating(name === 'calibrate');
    if (name !== 'title' && game && game.attract) stopAttract();
    switch (name) {
      case 'title':
        startAttract();
        break;
      case 'camera':
        // Swipe mode: Settings → Camera switches the controls to the camera (saved, then a reload), as the
        // swipe settings sheet's "Use the camera instead" does, instead of tracking under the swipe overlay.
        if (inputMode === 'touch') {
          mobile.prefs.controls = 'camera';
          savePrefs(storage, mobile.prefs);
          location.reload();
          break;
        }
        enterCamera();
        break;
      case 'hub':
        ui.show('hub', hubData());
        if (pendingStart && (inputMode !== 'camera' || (tracking && tracking.running))) startGame(pendingStart);
        break;
      case 'training':
        ui.show('training', hubData());
        break;
      case 'career':
        ui.show('career', careerData());
        break;
      case 'event-intro': {
        const id = data && data.eventId ? data.eventId : data && data.event ? data.event.id : null;
        ui.show('event-intro', eventIntroData(id));
        // The court behind the intro is the event's venue.
        if (EVENT_BY_ID[id] && (!game || game.attract)) setVenue(EVENT_BY_ID[id].venue);
        break;
      }
      case 'trophies':
        ui.show('trophies', trophiesData(data && data.tab ? data.tab : 'trophies'));
        progress.markSeen();
        break;
      case 'arcade':
        ui.show('arcade', arcadeData(data && data.selected ? data.selected : null));
        break;
      case 'freeplay':
        ui.show('freeplay', { mode: data && data.mode ? data.mode : 'rally', level: hubLevel, venue: S.venue, venues: VENUES });
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
    // Learning slow motion off the glass (game/swingAssist.js): the clock runs at speed × rate.
    clock.setRate(g.attract ? 1 : g.timeScale());
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
  // The live racket is drawn as predicted for this frame (player.renderRacket, game/swingPredict.js),
  // so no display extrapolation is passed here (fpRig's extrapolation only serves replay frames).
  // Swipe mode, behind view: the player's own body is drawn as an actor (src/app/mobile.js).
  let selfActor = !g.attract && inputMode === 'touch' ? mobile.selfActor(w) : null;
  if (g.attract && g.feed) {
    const st = g.feed.actorStroke(w);
    const sp = Math.hypot(w.player.vel.x, w.player.vel.z);
    selfActor = {
      pos: w.player.pos, vel: w.player.vel, facing: Math.PI, handed: S.handed,
      stroke: st ? st.stroke : null, swingPhase: st ? st.swingPhase : 0, holding: st ? 'swing' : sp > 0.6 ? 'run' : 'ready',
    };
  }
  stage.syncWorld(w, dtView, { alpha, selfActor, showRig: !g.attract });
  if (!g.attract && inputMode === 'touch') mobile.afterSync(w, dtReal);
  // HUD at 10 Hz.
  hudAcc += dtReal;
  if (!g.attract && hudAcc >= 0.1 && (ui.screen === 'play' || ui.screen === 'pause')) {
    hudAcc = 0;
    const h = g.hud();
    // Arrow only for a ball well outside the picture (beside or behind you).
    const bi = ui.screen === 'play' ? stage.ballIndicator(w.ball) : null;
    h.ballIndicator = bi && Math.abs(bi.angle) > 1.1 ? bi : null;
    // The rear-view mirror already shows a ball behind you: no duplicate arrow.
    if (stage.rearView && stage.rearView.visible) h.ballIndicator = null;
    // Ball in play (until the ruling): HUD blocks near the action step back.
    h.live = g.inPlay();
    // Camera input: tell the player when the camera loses them (a living room is small).
    if (g.input === 'camera' && frameWarning && ui.screen === 'play') h.prompt = `${frameWarning.text}`;
    if (firstHits && !firstHits.done && ui.screen === 'play' && !h.prompt) {
      const n = g.stats.playerHits;
      if (n < FIRST_HITS) {
        // Round 6: the approach circle (render/approach.js) closes on the ball at the moment to swing.
        h.prompt = n === 0
          ? 'Swing when the circle closes on the ball (it turns green) · golpea cuando el círculo se cierra'
          : `${n} of ${FIRST_HITS} · same again: swing as the circle closes`;
      } else {
        firstHits.done = true;
        ui.toast("That's the timing · ¡eso es! Swing as the circle closes on the ball");
      }
    }
    ui.hud(h);
    if (xrBoot) xrBoot.hud(h);
    g.emitHud(h);
    // Zone labels in the 3D scene keep out from under the HUD blocks (round 6: the UI's own list, with
    // the clean bar and the feedback line, hidden blocks skipped).
    stage.effects.setLabelOccluders(ui.hudRects ? ui.hudRects() : hudRects());
  }
  // Automatic replay of a special moment once the ball is dead (point over / rep judged, before the
  // next feed or serve), never with a live ball: the player is never pulled out of a rally. A
  // moment whose point runs on for more than 5.5 s is dropped by the director (recorder window).
  if (director && !replay && !results && !paused && !g.done && ui.screen === 'play' && director.pending) {
    const ref = w.referee;
    const dead = !w.ball || w.ball.atRest || w.ball.outside || (ref && ref.state && ref.state.phase === 'dead');
    if (dead) {
      const m = director.take(w);
      if (m) startReplay(m);
    }
  }
  if (results && performance.now() >= results.at) showResults();
}

/** Visible HUD blocks as screen rects (0..1, y down) for the 3D label layout (fallback: ui.hudRects). */
function hudRects() {
  const W = window.innerWidth || 1, H = window.innerHeight || 1;
  const out = [];
  for (const el of uiRoot.querySelectorAll('.vp-hud .hud-tl, .vp-hud .hud-tr, .vp-hud .shotcard, .vp-hud .hud-prompt, .vp-hud .hud-timing, .vp-hud .hud-clock, .vp-hud .hud-partner')) {
    if (el.hidden || el.closest('[hidden]')) continue;
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) continue;
    out.push([r.left / W, r.top / H, r.right / W, r.bottom / H]);
  }
  return out;
}

function stepReplay(dtReal) {
  const r = replay;
  const more = r.player.step(dtReal, r.auto ? 1 : 3);
  if (!more) {
    stopReplay();
    return;
  }
  if (r.auto) {
    // Highlight: cut to the second angle at the moment itself.
    const v2 = r.auto.views && r.auto.views[1];
    if (!r.switched && v2 && r.player.t >= r.auto.t - 0.05) {
      r.switched = true;
      r.view = v2;
      stage.fpCam.setReplayView(v2);
    }
  } else if (r.player.loops === 1 && r.view === 'broadcast' && !r.switched) {
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
    // Glasses: play context (3D side-by-side only renders during play) and the true eye position
    // while head tracking runs; before syncWorld / render.
    if (xrBoot) xrBoot.frame({ playing: !!game && !game.attract && ui.screen === 'play' && !replay });
    if (replay) stepReplay(dtReal);
    else if (game) stepGame(nowMs, dtReal);
    else stage.syncWorld(null, dtReal, {});
    if (fallback) fallback.enabled = inputMode === 'fallback' && !!game && !game.attract && ui.screen === 'play' && !paused && !replay;
    if (audio && audioUnlocked) {
      const L = (inputMode === 'touch' && game && !game.attract && !replay && mobile.listener(game.world)) || stage.listener();
      audio.setListener(L.pos, L.fwd, L.up);
    }
    // Glass Breaker targets and shatters run on sim time (slow motion, pauses and freezes apply).
    if (glassTargets) glassTargets.update(replay || paused || !clock.running ? 0 : dtReal * (clock.rate || 1) * (clock.speed || 1));
    stage.render(dtReal);
    mobile.frame({ screen: ui.screen, playing: !!game && !game.attract && ui.screen === 'play', paused, replay: !!replay, now: nowMs });
    if (debug) {
      debug.update(dtReal, {
        render: stage.app.stats, pose: tracking ? tracking.stats : null, poseStatus: tracking ? tracking.status.message : '',
        world: game ? game.world : null, stats: game ? game.stats : null, latency: game ? game.world.settings.latency : S.latency,
        speed: clock.speed, quality: S.quality, input: inputMode,
        safety: stage.safety, tracker: activeHuman() ? activeHuman().bodyTracker.stats : null, timeRate: clock.rate,
        glasses: glassesLine(),
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
    else if (replay.auto || k === 'r' || k === 'R' || k === 'Enter' || k === ' ') stopReplay();
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
  pwa = initPwa({
    ui,
    isPlaying: () => !!game && !game.attract && ui.screen === 'play' && !paused && !replay,
    onFullscreenExit: () => pause(),
  });
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
    // Phones and tablets: the mobile tier (QUALITY.mobile, registered by createMobile) unless ?quality=.
    // Never stored in S: settings.js clamps quality to ultra / high / balanced.
    quality: P.quality ? S.quality : (mobile.quality || S.quality),
    progress: async (p, text) => {
      ui.setLoading(p, text);
      await new Promise((r) => requestAnimationFrame(() => r()));
    },
  });
  window.addEventListener('resize', () => stage.resize());
  glassTargets = createGlassTargets(stage.app.scene);
  if (S.racketModel && S.racketModel !== 'fang') applyRacketModel();
  if (S.outfit && S.outfit !== 'club') applyOutfit();
  // Glasses mode (VITURE, experimental): settings under 'vibora.xr.v1', ?glasses=1 / ?stereo=1 / ?xrsim=1.
  try {
    xrBoot = installGlasses({ stage, settings: S, storage, uiRoot, toast: (t) => ui.toast(t) });
  } catch (err) {
    xrBoot = null;
    errors.push(`glasses: ${String(err && err.message ? err.message : err)}`);
  }

  audio = P.noAudio ? null : createAudio();
  if (audio) {
    audio.setVolume(S.volumes);
    if (stage.env) audio.setVenue(stage.env.venue);
  }
  voice = createVoice({ lang: S.voice === 'es' ? 'es' : 'en' });
  voice.setCoach(S.voice !== 'off');
  voice.setVolume(S.volumes.master ?? 1);
  installGestureUnlock();
  // Swipe mode overlay (pause / view buttons, trails, tutorial, swipe settings), touch input on the
  // canvas, the mobile shadow budget and the iOS audio unlock on touchend.
  // Only on phones / tablets or in swipe mode: on the Mac (camera, mouse, autopilot) the page keeps its
  // desktop layout (mobile.css applies under html.vp-mobile) and shows no swipe overlay.
  if (mobile.swipe || mobile.device.touchPrimary) mobile.install({
    canvas, stage, ui,
    handlers: {
      pause: () => pause(),
      isPlaying: () => !!game && !game.attract && ui.screen === 'play' && !paused && !replay,
      isReplay: () => !!replay,
      skipReplay: () => stopReplay(),
      unlockAudio: () => {
        tryUnlockAudio();
        return audioUnlocked;
      },
      // The choice is saved under 'vibora.mobile.v1' before the reload.
      useCamera: () => location.reload(),
      useSwipe: () => location.reload(),
    },
  });

  human = createHumanController({ settings: S });
  applyCameraTilt();
  tracking = createTracking({
    video, onFrame: onPoseFrame, onStatus: onPoseStatus, model: TRACKING.model,
    cameraPreset: S.cameraPreset, yawCorrection: !!S.offAxisYaw,
  });
  // The both-hands-up pause gesture is ignored while a ball is live (overhead preparation).
  cursor = createHandCursor({
    root: uiRoot, ui, onPause: () => handlers.onPause(),
    isLive: () => !!(game && !game.attract && ui.screen === 'play' && game.inPlay()),
  });
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
  let spec = P.mode ? { kind: P.mode, level: P.level } : { kind: 'drill', drillId: P.drill && getDrill(P.drill) ? P.drill : 'fh-drive' };
  if (P4.challenge) {
    const d = P4.challenge === 'daily' || P4.challenge.startsWith('daily:') ? dailyChallenge(P4.challenge.split(':')[1] || dateKey()) : null;
    spec = { kind: 'challenge', challengeId: d ? d.base : CHALLENGE_BY_ID[P4.challenge] ? P4.challenge : 'por-tres-party', daily: d, venue: d ? d.venue : S.venue };
  } else if (P4.career && EVENT_BY_ID[P4.career]) {
    spec = career.startEvent(P4.career, { quick: P4.quick }) || matchSpec(P4.career, 0, career.partner, { quick: P4.quick });
  }
  const direct = P.drill || P.mode || P4.challenge || P4.career;
  if (P4.screen && !direct && inputMode !== 'autopilot') {
    if (inputMode === 'fallback') ensureFallback();
    ui.show('hub', hubData());
    if (P4.screen === 'settings' || P4.screen === 'help') ui.show(P4.screen, P4.screen === 'settings' ? S : undefined);
    else handlers.onScreen(P4.screen, P4.screen === 'event-intro' ? { eventId: P.event || career.current().id } : P4.screen === 'trophies' ? { tab: P.tab || 'trophies' } : P4.screen === 'freeplay' ? { mode: P.fpMode || 'rally' } : {});
    markReady();
    return;
  }
  // Swipe mode: no title camera warm-up and no enterCamera, so MediaPipe is never downloaded and the
  // camera never asked for. First visit: the 3-step swipe tutorial, then the hub (or the ?drill / ?mode).
  if (inputMode === 'touch') {
    const go = () => (direct ? startGame(spec) : ui.show('hub', hubData()));
    if (mobile.needsTutorial()) mobile.showTutorial(go);
    else go();
    markReady();
    return;
  }
  if (inputMode === 'autopilot') {
    startGame(spec);
  } else if (inputMode === 'fallback') {
    ensureFallback();
    if (direct) startGame(spec);
    else ui.show('hub', hubData());
  } else if (direct) {
    pendingStart = spec;
    ui.show('title');
    enterCamera();
  } else {
    ui.show('title');
    startAttract();
    warmCamera();
  }
  markReady();
}

/**
 * __vibora.ready once the first frame has rendered (its batch shader compile, render/scene.js warm-up,
 * belongs to the start-up, not to play). Two animation frames: the loop's first frame runs in the second.
 */
function markReady() {
  const done = () => { vibora.ready = true; };
  requestAnimationFrame(() => requestAnimationFrame(done));
  setTimeout(done, 60000); // no animation frames (hidden tab): never block the ready flag for long
}

// ---------------------------------------------------------------------------------------
// Diagnostics

/** The human controller in use (a session's, else the shared camera one). */
function activeHuman() {
  return game && !game.attract ? game.human : human;
}

/** One-line glasses status for ?debug=1 (null when glasses mode is off). */
function glassesLine() {
  if (!xrBoot) return null;
  const g = xrBoot.glasses;
  if (!g || !g.enabled) return null;
  const xr = stage && stage.xr;
  const head = xr && xr.headTracking ? 'head on' : 'head off';
  const st = xr && xr.stereo && xr.stereo.enabled ? '3D' : '2D';
  return `${head} · ${st} · fov ${xr && xr.fov ? xr.fov.toFixed(1) : '—'}°`;
}

/** Copy diagnostics payload (app/diagnostics.js buildDiagnostics). */
function diagnosticsData() {
  const cam = tracking ? tracking.camera : null;
  const h = activeHuman();
  const bt = h ? h.bodyTracker : null;
  const last = bt && bt.last ? bt.last : lastSample;
  return buildDiagnostics({
    world: game && !game.attract ? game.world : null,
    settings: S,
    tracking: tracking ? {
      camera: cam ? { label: cam.label, kind: cam.kind, presetKey: cam.presetKey, settings: cam.settings || null } : null,
      stats: tracking.stats,
    } : null,
    calibration: human ? human.bodyTracker.calibration : null,
    pwa,
    stats: vibora.stats,
    params: P,
    env: browserEnv(),
    glasses: xrBoot ? xrBoot.diagnostics() : null,
    safety: stage ? stage.safety : null,
    robust: bt ? { stats: bt.stats, yawDeg: last ? last.yawDeg : null, sideOn: last ? last.sideOn : null } : null,
    // Close mode: the estimator in use, the learned camera tilt and the tracker counters.
    bodyTracker: bt ? { mode: bt.mode, tilt: bt.tilt, ...bt.stats } : null,
    // Round 6: the hitting mode with no game running and the camera player's learned timing.
    input: inputMode,
    timingProfile: game && !game.attract ? game.world.timingProfile : inputMode === 'camera' ? sharedTimingProfile(storage, timingKey(S)) : null,
  });
}

/**
 * Settings → Play: "Timing tuned to you: −0.14 s" (the camera player's learned timing bias,
 * game/timingProfile.js; per device and camera preset) or null before enough swings / when off.
 */
function timingInfo() {
  const prof = sharedTimingProfile(storage, timingKey(S));
  const h = activeHitting({ settings: S, input: 'camera', profile: prof });
  return { text: h.mode === 'timing' && S.timingAdapt !== false ? h.text : null, n: prof.n, adapt: S.timingAdapt !== false, mode: h.mode };
}

// ---------------------------------------------------------------------------------------
// Test / debug handle

/** Counters of game/world.js specStats (the per-hit arrays summarised as medians). */
function specSummary(st) {
  if (!st) return null;
  const med = (a) => (a && a.length ? a.slice().sort((x, y) => x - y)[a.length >> 1] : null);
  return {
    strikes: st.strikes, confirmed: st.confirmed, reverted: st.reverted, cancelled: st.cancelled,
    lateOnly: st.lateOnly, heldDropped: st.heldDropped, dirDiffDegMedian: med(st.dirDiffDeg), dtContactMedian: med(st.dtContact),
  };
}

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
  get pwa() { return pwa; },
  /** Swipe mode layer (src/app/mobile.js) and the sim clock (tests: the swipe bot times touches with them). */
  get mobile() { return mobile; },
  get clock() { return clock; },
  get inputMode() { return inputMode; },
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
      // Predictive hitting: strikes shown, confirmed, reverted (game/world.js specStats).
      speculative: game && !game.attract ? specSummary(game.world.specStats) : null,
      judgeMargin: game ? judgeMargin(game.world) : null,
      errors: errors.length,
      simTime: game ? game.world.time : null,
      finished: game ? game.isFinished() : false,
      fps: stage ? stage.app.stats.fps : 0,
      drawCalls: stage ? stage.app.stats.drawCalls : 0,
      // Black-screen safety net (stage) and side-on tracker guards (tracking/body.js).
      safety: stage ? stage.safety : null,
      tracker: activeHuman() ? activeHuman().bodyTracker.stats : null,
      timeRate: clock.rate,
    };
  },
  /** Glasses mode diagnostics (src/xr) or null. */
  get glasses() { return xrBoot ? xrBoot.diagnostics() : null; },
  /** The glasses integration (src/xr/boot.js installGlasses) or null. */
  get xr() { return xrBoot; },
  /** Camera + pose tracker (Copy diagnostics). */
  get tracking() { return tracking; },
  /** The Copy diagnostics object (same as the Pause / Settings button). */
  diagnostics() { return diagnosticsData(); },
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
   * next planned contact, 'hit' stops `offset` s after the next player hit's contact time,
   * 'strike' stops on the tick a predicted hit is shown (the racket meets the ball on screen).
   */
  freezeOn(kind, offset = 0.06) {
    if (!game) return;
    const w = game.world;
    const t0 = w.time;
    frozen = false;
    if (kind === 'strike') {
      const s0 = w.specStats.strikes;
      freezeRule = (ww) => ww.specStats.strikes > s0;
    } else if (kind === 'contact') {
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
  // Round 4: progression, career, arcade boards, automatic replays (tests / screenshots).
  get progress() { return progress; },
  get career() { return career; },
  get leaderboards() { return boards; },
  get director() { return director; },
  get glassTargets() { return glassTargets; },
  handlers,
  /** Plays an automatic highlight of the last player hit (screenshots of the replay badge). */
  replayMoment(kind = 'winner') {
    const snap = recorder.snapshot();
    const t = snap && snap.hits.length ? snap.hits[snap.hits.length - 1].t : snap ? snap.t1 - 1 : 0;
    return startReplay({ kind, t, label: kind === 'por-tres' ? '¡Por tres!' : 'Winner', views: ['broadcast', 'side'], rate: 0.45 });
  },
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
