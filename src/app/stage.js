// Render stage: renderer, hall, actors, first-person rig and cameras, synced from a World
// (or from a recorded replay frame shaped like one) every display frame.
import * as THREE from 'three';
import { createRenderer } from '../render/scene.js';
import { buildEnvironment } from '../render/environment.js';
import { createEffects } from '../render/effects.js';
import { createBallView } from '../render/ballView.js';
import { buildBallMachine } from '../render/machineView.js';
import { createHumanoid } from '../render/humanoid.js';
import { createFirstPersonBody, createTrackedPoser } from '../render/fpBody.js';
import { humanTemplate } from '../render/humanModel.js';
import { createDirector, PLAYER_KEY } from '../render/animation/director.js';
import { buildRacket } from '../render/racket.js';
import { createFirstPersonRig } from '../render/fpRig.js';
import { createFirstPersonCamera } from '../render/fpCamera.js';
import { createViewSync, elbowForRacket } from '../render/reconcile.js';
import { setActorQuality } from '../render/actorKit.js';
import { createRearView } from '../render/rearView.js';
import { isFiniteVec, ballOk, matrixOk, frameOk } from '../render/safeView.js';
import { GLASS_VIEW } from '../render/gaze.js';
import { RACKET, COURT } from '../config.js';

// Kits per role: team colours fixed, the rest (skin tone, hair, headwear, shoes) generated from a
// seed (skinnedHuman.js kitFor), so every person looks different but stays the same all session.
const KIT = {
  coach: { seed: 'coach', kit: { shirt: '#e8572a', trim: '#1d2b4a', shorts: '#1b2a44', shortsTrim: '#e8572a', skin: '#9a6648', headwear: '#1d2b4a', headwearKind: 'cap', hairStyle: 'short', hair: '#16110e' } },
  partner: { seed: 'partner-B', kit: { shirt: '#eef1f4', trim: '#1d2b4a', shorts: '#1d2b4a', shortsTrim: '#eef1f4' } },
  rival: { seed: 'rival-C', kit: { shirt: '#c8263c', trim: '#16181d', shorts: '#16181d', shortsTrim: '#c8263c' } },
  rival2: { seed: 'rival-D', kit: { shirt: '#c8263c', trim: '#eef1f4', shorts: '#16181d', shortsTrim: '#c8263c' } },
  static: { seed: 'static', kit: { shirt: '#d9dde2', trim: '#2b2f36', shorts: '#2b2f36', shortsTrim: '#d9dde2' } },
};
/** The player's own kit (first-person body, replay): navy shirt with orange trim, like the rig's sleeves. */
function playerKit(settings) {
  return {
    shirt: '#1d2b4a', trim: '#e8572a', shorts: '#10131a', shortsTrim: '#e8572a', shoe: '#f4f4f4', shoeAccent: '#e8572a',
    skin: settings.skinTone || '#c58c6a', hair: '#2a1d16', hairStyle: 'short', headwearKind: 'none', sockHeight: 0.11, wristband: 'racket', panels: true,
  };
}
const SERVER_INDEX = { A: 0, B: 1, C: 0, D: 1 };
/**
 * A career player's colours (game/career.js: { shirt, shorts, cap: colour | null, skin, hair? })
 * over the role kit; the rest of the look (hair style, shoes…) comes from the name seed.
 */
function careerKit(base, ck) {
  if (!ck) return base;
  const k = { ...base };
  if (ck.shirt) { k.shirt = ck.shirt; k.shortsTrim = ck.shirt; }
  if (ck.shorts) { k.shorts = ck.shorts; k.trim = ck.shorts; }
  if (ck.skin) k.skin = ck.skin;
  if (ck.hair) k.hair = ck.hair;
  if ('cap' in ck) {
    if (ck.cap) { k.headwearKind = 'cap'; k.headwear = ck.cap; k.headwearAccent = ck.shirt || k.headwearAccent; } else k.headwearKind = 'none';
  }
  return k;
}

const tmpV = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const fwdV = new THREE.Vector3();
const upV = new THREE.Vector3();
const viewDirV = new THREE.Vector3();
const basisM = new THREE.Matrix4();

/**
 * @param {object} o
 * @param {HTMLCanvasElement} o.canvas
 * @param {object} o.settings live app settings
 * @param {string} o.quality
 * @param {(p:number, text:string) => Promise<void>|void} [o.progress]
 */
export async function createStage({ canvas, settings, quality, progress = () => {} }) {
  const tick = () => new Promise((r) => setTimeout(r, 0));
  setActorQuality(quality);
  const app = createRenderer(canvas, { quality, fov: settings.fov });
  app.resize(window.innerWidth, window.innerHeight);
  await progress(0.3, 'Building the club…');
  await tick();
  // The environment first: it captures the hall into the PMREM reflection maps. The venue (club, sunset,
  // stadium: render/venues/*) is the free-play one from the settings; sessions may switch it (setVenue).
  const env = buildEnvironment(app.scene, app.renderer, { quality, venue: settings.venue || 'club' });
  env.setOpponentsVisible(false);
  await progress(0.55, 'Stringing the rackets…');
  await tick();

  const effects = createEffects(app.scene, { net: env.net });
  const ballView = createBallView(app.scene, { halo: !!settings.halo });
  const machine = buildBallMachine();
  machine.visible = false;
  app.scene.add(machine);

  const racket = buildRacket({ color: settings.racketColor || '#e8572a', handed: settings.handed });
  const rig = createFirstPersonRig({ handed: settings.handed, skinTone: settings.skinTone || '#c58c6a', racket });
  app.scene.add(rig.root);

  // The skinned athlete template (signed-distance body, polygonized once) before any person.
  await progress(0.6, 'Warming up the players…');
  await tick();
  humanTemplate(1);
  await tick();
  humanTemplate(0);
  await tick();

  // Third-person stand-in for the player (replay, attract mode): the same skinned athlete as the
  // first-person body, its racket hand following the recorded racket in replays.
  const self = createHumanoid({ kit: playerKit(settings), seed: 'player', handed: settings.handed, height: settings.height || 1.8, racketColor: settings.racketColor || '#e8572a' });
  self.root.visible = false;
  app.scene.add(self.root);
  // Replays recorded with the tracked joints (replay.js frame.player.bodyCourt) pose the stand-in
  // from the real upper body instead of the stroke animation.
  const selfPoser = createTrackedPoser(self.human);
  // The player's own body in first person (torso, legs, shoes) and its full-body shadow.
  const fpBody = createFirstPersonBody({ handed: settings.handed, height: settings.height || 1.75, kit: playerKit(settings) });
  fpBody.root.visible = false;
  app.scene.add(fpBody.root);
  // Presence cues (split-steps, reactions, high fives) from the world and its bus events.
  const director = createDirector();

  // Real racket path (replay): the tracked sweet spot around the contact.
  const pathMax = 90;
  const pathGeo = new THREE.BufferGeometry();
  pathGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pathMax * 3), 3));
  const pathLine = new THREE.Line(pathGeo, new THREE.LineBasicMaterial({ color: 0x8be4ee, transparent: true, opacity: 0.85, depthTest: true }));
  pathLine.frustumCulled = false;
  pathLine.visible = false;
  app.scene.add(pathLine);
  const ghostRacket = buildRacket({ color: '#8be4ee', handed: settings.handed, cord: false });
  ghostRacket.traverse((o) => {
    if (!o.isMesh || !o.material) return;
    const ghost = (m) => {
      const c = m.clone();
      c.transparent = true;
      c.opacity = 0.8;
      c.depthWrite = false;
      return c;
    };
    o.material = Array.isArray(o.material) ? o.material.map(ghost) : ghost(o.material);
    o.castShadow = false;
  });
  ghostRacket.visible = false;
  app.scene.add(ghostRacket);

  const viewSettings = {
    fov: settings.fov, gazeFollow: settings.gazeFollow, viewPitch: settings.viewPitch, eyeOffset: settings.eyeOffset,
    glassView: GLASS_VIEW.MODES.includes(settings.glassView) ? settings.glassView : GLASS_VIEW.DEFAULT,
  };
  // XR integration surface (glasses, src/xr/): app.xr = { getHeadQuaternion(), fov?, stereo? } or
  // null; see fpCamera.js and render() below (SPEC §6.8).
  if (app.xr === undefined) app.xr = null;
  const fpCam = createFirstPersonCamera(app.camera, viewSettings, { getXR: () => app.xr });
  const rearView = createRearView(app);
  rearView.warm();
  fpCam.mode = 'orbit';
  fpCam.snap();
  app.refreshQuality();
  await rig.ready;
  await progress(0.8, 'Warming up the lights…');

  // ---- humanoid pool keyed by actor object -------------------------------------
  // Entries are { key, state, static }: live actors use the actor itself as key; replay
  // frames reuse the recorded actor reference, so the same humanoid is driven.
  const pool = new Map();
  let rivalCount = 0;
  let staticCount = 0;
  function humanoidFor(e) {
    let h = pool.get(e.key);
    if (h) return h;
    const s = e.state || {};
    let kit = KIT.coach;
    let seed = kit.seed;
    if (e.static) {
      kit = KIT.static;
      seed = `static-${staticCount++}`;
    } else if (s.team === 0) {
      kit = KIT.partner;
      seed = `partner-${s.displayName || s.name || 'B'}`;
    } else if (s.team === 1 && s.name) {
      kit = rivalCount++ % 2 ? KIT.rival2 : KIT.rival;
      seed = `rival-${s.displayName || s.name}`;
    }
    // Career players (game/career.js): their colours over the role kit, the rest of the look from the
    // name seed (the same person looks the same in every match); handedness from the player card.
    h = createHumanoid({ kit: careerKit(kit.kit, s.kit), seed: seed || kit.seed, handed: s.handed || 'right' });
    h.ctx = { time: 0, ball: null, cue: null, partner: null, racket: null };
    app.scene.add(h.root);
    pool.set(e.key, h);
    return h;
  }
  const live = new Set();
  const ballPos = { x: 0, y: 0, z: 0 };
  // People on court for the director (reused objects, no per-frame allocation).
  const people = [];
  const peopleBuf = [];
  function personAt(i) {
    if (!peopleBuf[i]) peopleBuf[i] = { key: null, team: null, pos: { x: 0, z: 0 }, state: null, serverIndex: -1 };
    return peopleBuf[i];
  }
  function gatherPeople(w, entries) {
    people.length = 0;
    let i = 0;
    if (w.player && w.player.pos) {
      const p = personAt(i++);
      p.key = PLAYER_KEY; p.team = 0; p.state = null; p.serverIndex = 0;
      p.pos.x = w.player.pos.x; p.pos.z = w.player.pos.z;
      people.push(p);
    }
    for (const e of entries) {
      if (!e || !e.state || e.static) continue;
      const s = e.state;
      // The match autopilot (name A) shares the player's position: it is the player.
      if (s.name === 'A' && w.player && s.pos === w.player.pos) continue;
      const p = personAt(i++);
      p.key = e.key; p.team = s.team === 0 || s.team === 1 ? s.team : 1; p.state = s;
      p.serverIndex = SERVER_INDEX[s.name] ?? 0;
      p.pos.x = s.pos.x; p.pos.z = s.pos.z;
      people.push(p);
    }
  }
  function partnerOf(key, team) {
    for (const p of people) if (p.team === team && p.key !== key) return p.pos;
    return null;
  }
  function syncActors(entries, dt, w, liveWorld) {
    live.clear();
    const b = shownBall && !shownBall.atRest && !shownBall.outside ? shownBall.pos : null;
    if (b) { ballPos.x = b.x; ballPos.y = b.y; ballPos.z = b.z; }
    const camPos = app.camera.position;
    for (const e of entries) {
      if (!e || !e.state) continue;
      const h = humanoidFor(e);
      h.root.visible = true;
      h.setLodFor(camPos);
      const c = h.ctx;
      c.time = w ? w.time : c.time + dt;
      c.ball = b ? ballPos : null;
      c.cue = liveWorld && !e.static ? director.cue(e.key) : null;
      c.partner = c.cue && c.cue.five ? partnerOf(e.key, e.state.team) : null;
      h.update(e.state, dt, c);
      live.add(e.key);
    }
    for (const [k, h] of pool) {
      if (live.has(k)) continue;
      // Actors of a finished session never come back: free their GPU buffers.
      app.scene.remove(h.root);
      h.dispose ? h.dispose() : h.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      pool.delete(k);
    }
  }
  // Live actors: entries reused frame to frame (no per-frame allocation).
  const entryOut = [];
  const entryOf = new Map();
  function entry(a) {
    let e = entryOf.get(a);
    if (!e) {
      e = { key: a, state: null, static: false };
      entryOf.set(a, e);
    }
    e.state = a.state;
    e.static = !!a.static;
    return e;
  }
  function actorEntries(w, skip) {
    entryOut.length = 0;
    if (!w) return entryOut;
    if (w.actors) return w.actors; // replay frame
    if (entryOf.size > 32) entryOf.clear();
    if (w.coach) entryOut.push(entry(w.coach));
    if (w.ai) for (const a of w.ai) if (a !== skip) entryOut.push(entry(a));
    return entryOut;
  }

  // Replay cutaway: the enclosure wall between a replay camera and the court (posts, rails,
  // glass, mesh) is clipped away, like a broadcast camera behind the glass.
  const CUT_MATS = ['steel', 'bolt', 'mesh', 'glassEdge', 'glass'].map((k) => env.materials && env.materials[k]).filter(Boolean);
  const cutPlanes = {
    broadcast: new THREE.Plane(new THREE.Vector3(0, 0, -1), COURT.halfLength - 0.15), // keeps z < 9.85
    side: new THREE.Plane(new THREE.Vector3(-1, 0, 0), COURT.halfWidth - 0.15), // keeps x < 4.85
  };
  let cutKind = null;
  function setCutaway(kind) {
    const k = kind && cutPlanes[kind] ? kind : null;
    if (k === cutKind) return;
    cutKind = k;
    app.renderer.localClippingEnabled = true;
    for (const m of CUT_MATS) {
      m.clippingPlanes = k ? [cutPlanes[k]] : null;
      // Merge pass: an alpha-to-coverage material (the wire mesh on MSAA tiers) is not fully clipped
      // (three.js fades a2c clipping by fwidth), and the cut-away mesh between a replay camera and
      // the court rendered as dotted noise over the whole court. While the cutaway is on the material
      // blends instead (as on the balanced tier).
      if (k && m.alphaToCoverage) {
        m.userData.cutA2C = true;
        m.alphaToCoverage = false;
        m.transparent = true;
        m.depthWrite = false;
      } else if (!k && m.userData.cutA2C) {
        m.userData.cutA2C = false;
        m.alphaToCoverage = true;
        m.transparent = false;
        m.depthWrite = true;
      }
      m.needsUpdate = true;
    }
  }

  let view = 'orbit';
  function setView(v) {
    if (v === view) return;
    view = v;
    fpCam.mode = v === 'replay' ? 'replay' : v === 'fp' ? 'fp' : 'orbit';
    if (v === 'fp') fpCam.snap();
  }

  // What is shown of the ball and racket (render/reconcile.js): the speculatively struck ball
  // and the predicted racket of a live world, a smooth blend over every path correction, and the
  // strike frame (ball on the strings, racket at the contact pose).
  const viewSync = createViewSync();
  const reconciler = viewSync.reconciler;
  let shownBall = null;

  // First-person body to draw: the player with the shown (predicted) racket and an arm that
  // follows it. One proxy per player object, reused every frame.
  const selfCtx = { time: 0, ball: null, racket: null, cue: null };
  const mirrorHidden = [rig.root, fpBody.root];
  let rigFor = null, rigProxy = null, rigBody = null;
  const elbowOut = { x: 0, y: 0, z: 0 };
  function rigPlayer(player, racket) {
    if (!racket || racket === player.racket || !player.racket) return player;
    if (rigFor !== player) {
      rigFor = player;
      rigProxy = Object.create(player);
      rigBody = null;
    }
    rigProxy.racket = racket;
    const bc = player.bodyCourt;
    rigProxy.bodyCourt = bc;
    if (bc && bc.joints) {
      const side = bc.dominant === 'L' ? 'L' : 'R';
      const S = bc.joints[`shoulder${side}`], E = bc.joints[`elbow${side}`], W = bc.joints[`wrist${side}`];
      if (S && E && W && elbowForRacket(S, E, W, player.racket, racket, elbowOut)) {
        if (!rigBody || rigBody.src !== bc || rigBody.side !== side) {
          rigBody = { src: bc, side, joints: Object.create(bc.joints), handFrames: bc.handFrames, dominant: bc.dominant, eye: bc.eye, elbow: new THREE.Vector3() };
          rigBody.joints[`elbow${side}`] = rigBody.elbow;
        }
        rigBody.dominant = bc.dominant;
        rigBody.elbow.set(elbowOut.x, elbowOut.y, elbowOut.z);
        rigProxy.bodyCourt = rigBody;
      }
    }
    return rigProxy;
  }
  // Camera / gaze follow the shown ball.
  let camFor = null, camWorld = null;
  function cameraWorld(w) {
    if (!w || !shownBall || shownBall === w.ball) return w;
    if (camFor !== w) {
      camFor = w;
      camWorld = Object.create(w);
    }
    camWorld.ball = shownBall;
    return camWorld;
  }

  /**
   * @param {object} w World (or replay frame: {time, ball, player, coach, ai, machine, mode})
   * @param {number} dt display dt (s, already scaled for slow motion)
   * @param {object} o { alpha, extrapolate, selfActor: actorState|null, showRig, racketPath: [{x,y,z}], ghostPose }
   */
  function syncWorld(w, dt, o = {}) {
    // Speculative hits, their confirmation and lag-compensated rewrites change the ball's path;
    // the view sync hides the jumps and pairs the shown ball with the predicted racket.
    const vs = viewSync.update(w, dt);
    let rb = vs.ball;
    // Safety net: a non-finite ball is not drawn (nor followed by the gaze / mirror).
    if (rb && !ballOk(rb)) {
      rb = null;
      safety.ballHidden++;
    }
    shownBall = rb;
    ballView.update(rb, dt, vs.hitFrame ? 1 : o.alpha ?? 1);
    const entries = actorEntries(w, o.skipActor);
    // Presence cues only for a live world (replay frames have no bus and are rebuilt every frame).
    const liveWorld = !!(w && w.bus && typeof w.bus.on === 'function');
    if (liveWorld) {
      gatherPeople(w, entries);
      director.update(w, people);
    }
    syncActors(entries, dt, w, liveWorld);
    // Machine.
    const m = w && w.machine;
    machine.visible = !!m;
    if (m) {
      machine.position.set(m.pos.x, 0, m.pos.z);
      machine.update(dt, m.state);
    }
    // Player: first-person rig, or a humanoid in third-person views.
    const showRig = o.showRig !== false && view === 'fp' && w && w.player;
    // Near-eye culling / fading measures from the rendered viewpoint (tracked eye + view offset).
    let viewEye = null;
    let rigOk = !!showRig;
    if (showRig) {
      const e = w.player.eye, off = viewSettings.eyeOffset;
      if (isFiniteVec(e)) viewEye = tmpEye.set(e.x, e.y - (off ? off.down || 0 : 0), e.z + (off ? off.back || 0 : 0));
      else {
        // Non-finite tracking reached the eye: no rig this frame (the camera holds its last pose).
        rigOk = false;
        safety.rigHidden++;
      }
    }
    // A live world's racket is already predicted for this frame (game/swingPredict.js); a
    // replay frame's recorded one may still be extrapolated by the caller.
    const predicted = !!(rigOk && vs.racket && w.player.renderRacket !== undefined);
    const rigSubject = rigOk ? (predicted ? rigPlayer(w.player, vs.racket) : w.player) : null;
    rig.update(rigSubject, dt, {
      extrapolate: predicted ? 0 : o.extrapolate || 0, visible: rigOk, eye: viewEye, eye2: rigOk ? w.player.eye : null, ball: rb && !rb.atRest ? rb.pos : null,
      viewDir: app.camera.getWorldDirection(viewDirV),
    });
    // Own body under the camera + its full-body shadow (same tracked joints and shown racket).
    if (rigSubject && o.body !== false) {
      fpBody.update(rigSubject, dt, {
        visible: true, racket: rigSubject.racket || null, time: w.time, cue: liveWorld ? director.cue(PLAYER_KEY) : null, viewDir: viewDirV, camPos: app.camera.position,
      });
    } else fpBody.update(null);
    if (o.selfActor) {
      self.root.visible = true;
      selfCtx.time = w && Number.isFinite(w.time) ? w.time : selfCtx.time + dt;
      selfCtx.ball = rb && !rb.atRest ? rb.pos : null;
      // Replay: the racket hand follows the recorded (tracked) racket, drawn as the ghost racket.
      selfCtx.racket = o.ghostPose && frameOk(o.ghostPose) ? o.ghostPose : null;
      const pl = w && w.player;
      const tracked = !!(pl && pl.bodyCourt && pl.bodyCourt.joints && pl.bodyCourt.joints.shoulderL);
      if (tracked) {
        self.root.position.set(pl.pos.x, 0, pl.pos.z);
        self.human.setLodFor(app.camera.position);
        selfPoser.update(pl, dt, { racket: selfCtx.racket, time: selfCtx.time });
      } else self.update(o.selfActor, dt, selfCtx);
      if (self.racket) self.racket.visible = !selfCtx.racket;
    } else self.root.visible = false;
    // Replay aids.
    const path = o.racketPath;
    if (path && path.length > 1) {
      const arr = pathGeo.attributes.position.array;
      const n = Math.min(pathMax, path.length);
      for (let i = 0; i < n; i++) {
        const p = path[path.length - n + i];
        arr[i * 3] = p.x; arr[i * 3 + 1] = p.y; arr[i * 3 + 2] = p.z;
      }
      pathGeo.attributes.position.needsUpdate = true;
      pathGeo.setDrawRange(0, n);
      pathLine.visible = true;
    } else pathLine.visible = false;
    const gp = o.ghostPose;
    if (gp) {
      ghostRacket.visible = true;
      ghostRacket.position.set(gp.grip.x, gp.grip.y, gp.grip.z);
      const y = tmpV.set(gp.axis.x, gp.axis.y, gp.axis.z).normalize();
      const z = tmpV2.set(gp.normal.x, gp.normal.y, gp.normal.z);
      z.addScaledVector(y, -z.dot(y)).normalize();
      const x = fwdV.crossVectors(y, z);
      ghostRacket.quaternion.setFromRotationMatrix(basisM.makeBasis(x, y, z));
    } else ghostRacket.visible = false;
    fpCam.update(cameraWorld(w), dt, o.dtReal ?? dt);
    // Rear-view mirror (settings.glassView 'mirror'): while the ball is behind the eye in the
    // first-person view, unless head tracking (glasses) drives the view.
    const mirrorWanted = view === 'fp' && viewSettings.glassView === 'mirror' && viewSettings.gazeFollow !== false
      && !fpCam.headTracking && !stereoOn() && fpCam.rear && !!showRig;
    rearView.update(o.dtReal ?? dt, { want: mirrorWanted, eye: w && w.player && isFiniteVec(w.player.eye) ? w.player.eye : null, ball: rb });
    if (view !== 'fp' || fpCam.headTracking || stereoOn()) rearView.update(10, { want: false });
    setCutaway(view === 'replay' ? fpCam.replayView : null);
    effects.update(dt);
    env.update(dt);
  }

  /**
   * Off-screen ball indicator for the HUD: { angle } (0 = ahead, + right, PI = behind) or null
   * while the ball is inside the view.
   */
  function ballIndicator(ball) {
    // The live ball's arrow points at the ball as shown (speculative / reconciled).
    if (ball && shownBall && shownBall.id === ball.id) ball = shownBall;
    if (!ball || ball.atRest || ball.outside) return null;
    const cam = app.camera;
    tmpV.set(ball.pos.x, ball.pos.y, ball.pos.z);
    const rel = tmpV2.copy(tmpV).applyMatrix4(cam.matrixWorldInverse);
    tmpV.project(cam);
    const onScreen = rel.z < 0 && Math.abs(tmpV.x) < 0.96 && Math.abs(tmpV.y) < 0.96;
    if (onScreen) return null;
    // Horizontal angle relative to the view direction.
    const a = Math.atan2(rel.x, -rel.z);
    return { angle: a };
  }

  /** Listener pose for spatial audio (court frame). */
  function listener() {
    const cam = app.camera;
    cam.getWorldDirection(fwdV);
    upV.set(0, 1, 0).applyQuaternion(cam.quaternion);
    return { pos: cam.position, fwd: fwdV, up: upV };
  }

  function applySettings(keys, s) {
    viewSettings.glassView = GLASS_VIEW.MODES.includes(s.glassView) ? s.glassView : GLASS_VIEW.DEFAULT;
    viewSettings.fov = s.fov;
    viewSettings.viewPitch = s.viewPitch;
    viewSettings.eyeOffset = s.eyeOffset;
    if (keys.includes('fov')) fpCam.setFov(s.fov);
    if (keys.includes('halo')) ballView.setHalo(!!s.halo);
    if (keys.includes('skinTone')) {
      rig.setSkin(s.skinTone);
      fpBody.setKit({ skin: s.skinTone });
      self.setKit({ skin: s.skinTone });
    }
    if (keys.includes('height') && s.height) fpBody.setHeight(s.height);
    if (keys.includes('racketColor')) rig.racketMesh?.userData?.setColor?.(s.racketColor);
    if (keys.includes('handed')) {
      rig.setHanded(s.handed);
      self.setHanded(s.handed);
      fpBody.setHanded(s.handed);
    }
    if (keys.includes('quality')) {
      app.setQuality(s.quality);
      setActorQuality(s.quality);
    }
  }

  function setGaze(on) {
    viewSettings.gazeFollow = !!on;
  }

  /**
   * Venue of the hall (render/environment.js env.setVenue: club | sunset | stadium; a no-op when it is
   * already up). Court materials, actors and the rig persist across venues. Returns the venue metadata.
   */
  function setVenue(v) {
    return env.setVenue(v);
  }

  // ---- render safety net ------------------------------------------------------
  // Reproduced (tests/robust.test.mjs, tools/blackscreen.mjs): ONE visible mesh with a singular or
  // non-finite world matrix blacks out the whole WebGL picture (its NaN fragments are smeared by
  // the bloom mip chain) while the HUD and camera PiP stay: "a black screen with image on the
  // side". Before every frame the dynamic part of the scene (everything but the static hall) is
  // checked and any such mesh is hidden for that frame; scene.js also zeroes non-finite pixels
  // before the bloom. Counters: stage.safety (main.js puts them in __vibora.stats / ?debug=1).
  const safety = { ballHidden: 0, rigHidden: 0, meshesHidden: 0, framesWithHidden: 0, lastHidden: null };
  const hiddenNow = [];
  const dynRoots = [];
  function guardMeshes() {
    dynRoots.length = 0;
    for (const c of app.scene.children) if (c !== env.root && c.visible) dynRoots.push(c);
    let n = 0;
    for (const r of dynRoots) {
      r.updateWorldMatrix(false, true);
      r.traverseVisible((o) => {
        if (!o.isMesh && !o.isLine && !o.isPoints && !o.isSprite) return;
        let ok = matrixOk(o.matrixWorld.elements);
        if (ok && o.isSkinnedMesh && o.skeleton) {
          for (const b of o.skeleton.bones) {
            if (!matrixOk(b.matrixWorld.elements)) { ok = false; break; }
          }
        }
        if (!ok) {
          hiddenNow.push(o);
          n++;
          safety.lastHidden = o.name || (o.parent && o.parent.name) || o.type;
        }
      });
    }
    for (const o of hiddenNow) o.visible = false;
    if (n) {
      safety.meshesHidden += n;
      safety.framesWithHidden++;
    }
  }
  function unguardMeshes() {
    for (const o of hiddenNow) o.visible = true;
    hiddenNow.length = 0;
  }

  /** XR stereo (3D side-by-side) renders this frame instead of the composer. */
  function stereoOn() {
    const st = app.xr && app.xr.stereo;
    return !!(st && st.enabled && typeof st.render === 'function');
  }

  /**
   * One frame: the composer render (or the XR stereo override app.xr.stereo.render(renderer,
   * scene, camera, composer) when enabled), then the rear-view mirror inset.
   */
  let lastXrT = 0;
  function render(dt) {
    guardMeshes();
    try {
      const xr = app.xr;
      const st = xr && xr.stereo;
      if (st && st.enabled && typeof st.render === 'function') {
        // The stereo branch skips app.render: keep the frame-rate stats (debug, diagnostics) alive.
        const now = performance.now();
        if (lastXrT) {
          const d = (now - lastXrT) / 1000;
          if (d > 0) app.stats.fps = app.stats.fps ? app.stats.fps + (1 / d - app.stats.fps) * 0.1 : 1 / d;
        }
        lastXrT = now;
        st.render(app.renderer, app.scene, app.camera, app.composer);
      } else {
        lastXrT = 0;
        app.render(dt);
        if (rearView.visible && view === 'fp') rearView.render(mirrorHidden);
      }
    } finally {
      unguardMeshes();
    }
  }

  /** Installs (or removes with null) the XR integration object (SPEC §6.8). */
  function setXR(x) {
    app.xr = x || null;
    fpCam.setFov(viewSettings.fov || app.camera.fov);
  }

  function resize() {
    app.resize(window.innerWidth, window.innerHeight);
  }

  return {
    app,
    env,
    effects,
    ballView,
    reconciler,
    viewSync,
    /** The ball as drawn this frame (null without one). */
    get shownBall() { return shownBall; },
    machine,
    rig,
    fpCam,
    self,
    fpBody,
    director,
    /** Presence counters: people drawn, their triangles, fp body and director stats. */
    get presence() {
      let tris = 0;
      for (const h of pool.values()) tris += h.human.triangles;
      return { humans: pool.size, humanTriangles: tris, fpBody: { ...fpBody.stats, visible: fpBody.root.visible }, director: { ...director.events } };
    },
    viewSettings,
    setView,
    get view() { return view; },
    syncWorld,
    ballIndicator,
    listener,
    applySettings,
    setGaze,
    setVenue,
    resize,
    render,
    rearView,
    setXR,
    /** The XR integration object (app.xr) or null. */
    get xr() { return app.xr; },
    /** Render safety-net counters (stage, camera, rig, tracking-free). */
    get safety() {
      return { ...safety, camera: { ...fpCam.safety }, rig: { ...rig.stats }, mirrorFrames: rearView.stats.frames };
    },
    /** Glass normal (into the court) for a wall event. */
    wallNormal(evt) {
      if (evt.wall === 'back') return { x: 0, y: 0, z: evt.pos.z > 0 ? -1 : 1 };
      return { x: evt.pos.x > 0 ? -1 : 1, y: 0, z: 0 };
    },
    RACKET_SWEET: RACKET.sweetSpotY,
    COURT,
  };
}
