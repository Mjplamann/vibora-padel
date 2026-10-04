// Render stage: renderer, hall, actors, first-person rig and cameras, synced from a World
// (or from a recorded replay frame shaped like one) every display frame.
import * as THREE from 'three';
import { createRenderer } from '../render/scene.js';
import { buildEnvironment } from '../render/environment.js';
import { createEffects } from '../render/effects.js';
import { createBallView } from '../render/ballView.js';
import { buildBallMachine } from '../render/machineView.js';
import { createHumanoid } from '../render/humanoid.js';
import { buildRacket } from '../render/racket.js';
import { createFirstPersonRig } from '../render/fpRig.js';
import { createFirstPersonCamera } from '../render/fpCamera.js';
import { createViewSync, elbowForRacket } from '../render/reconcile.js';
import { setActorQuality } from '../render/actorKit.js';
import { createRearView } from '../render/rearView.js';
import { isFiniteVec, ballOk, matrixOk } from '../render/safeView.js';
import { GLASS_VIEW } from '../render/gaze.js';
import { RACKET, COURT } from '../config.js';

const KIT = {
  coach: { shirt: '#e8572a', shorts: '#1b2a44', skin: '#9a6648', cap: '#1d2b4a' },
  partner: { shirt: '#eef1f4', shorts: '#1d2b4a', skin: '#c58c6a', cap: '#eef1f4' },
  rival: { shirt: '#c8263c', shorts: '#16181d', skin: '#b07a5a', cap: '#16181d' },
  rival2: { shirt: '#c8263c', shorts: '#16181d', skin: '#7b4a33', cap: '#c8263c' },
  static: { shirt: '#d9dde2', shorts: '#2b2f36', skin: '#a46b4b', cap: '#2b2f36' },
};

const tmpV = new THREE.Vector3();
const tmpEye = new THREE.Vector3();
const tmpV2 = new THREE.Vector3();
const fwdV = new THREE.Vector3();
const upV = new THREE.Vector3();
const viewDirV = new THREE.Vector3();

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
  // The environment first: it captures the hall into the PMREM reflection maps.
  const env = buildEnvironment(app.scene, app.renderer, { quality });
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

  // Third-person stand-in for the player (replay, attract mode).
  const self = createHumanoid({ shirt: '#1d2b4a', shorts: '#10131a', skin: settings.skinTone || '#c58c6a', handed: settings.handed, cap: '#e8572a' });
  self.root.visible = false;
  app.scene.add(self.root);

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
  function humanoidFor(e) {
    let h = pool.get(e.key);
    if (h) return h;
    const s = e.state || {};
    let kit = KIT.coach;
    if (e.static) kit = KIT.static;
    else if (s.team === 0) kit = KIT.partner;
    else if (s.team === 1 && s.name) kit = rivalCount++ % 2 ? KIT.rival2 : KIT.rival;
    h = createHumanoid({ ...kit, handed: s.handed || 'right' });
    app.scene.add(h.root);
    pool.set(e.key, h);
    return h;
  }
  const live = new Set();
  function syncActors(entries, dt) {
    live.clear();
    for (const e of entries) {
      if (!e || !e.state) continue;
      const h = humanoidFor(e);
      h.root.visible = true;
      h.update(e.state, dt);
      live.add(e.key);
    }
    for (const [k, h] of pool) {
      if (live.has(k)) continue;
      // Actors of a finished session never come back: free their GPU buffers.
      app.scene.remove(h.root);
      h.root.traverse((o) => { if (o.geometry) o.geometry.dispose(); });
      pool.delete(k);
    }
  }
  function actorEntries(w, skip) {
    const out = [];
    if (!w) return out;
    if (w.actors) return w.actors; // replay frame
    if (w.coach) out.push({ key: w.coach, state: w.coach.state, static: !!w.coach.static });
    if (w.ai) for (const a of w.ai) if (a !== skip) out.push({ key: a, state: a.state, static: !!a.static });
    return out;
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
    syncActors(actorEntries(w, o.skipActor), dt);
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
    rig.update(rigOk ? (predicted ? rigPlayer(w.player, vs.racket) : w.player) : null, dt, {
      extrapolate: predicted ? 0 : o.extrapolate || 0, visible: rigOk, eye: viewEye, eye2: rigOk ? w.player.eye : null, ball: rb && !rb.atRest ? rb.pos : null,
      viewDir: app.camera.getWorldDirection(viewDirV),
    });
    if (o.selfActor) {
      self.root.visible = true;
      self.update(o.selfActor, dt);
      // In replay the tracked racket (ghost) is the racket; the mannequin's own one is hidden.
      if (self.racket) self.racket.visible = !o.ghostPose;
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
      ghostRacket.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, z));
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
    }
    if (keys.includes('racketColor')) rig.racketMesh?.userData?.setColor?.(s.racketColor);
    if (keys.includes('handed')) {
      rig.setHanded(s.handed);
      self.setHanded(s.handed);
    }
    if (keys.includes('quality')) {
      app.setQuality(s.quality);
      setActorQuality(s.quality);
    }
  }

  function setGaze(on) {
    viewSettings.gazeFollow = !!on;
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
        if (rearView.visible && view === 'fp') rearView.render([rig.root]);
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
    viewSettings,
    setView,
    get view() { return view; },
    syncWorld,
    ballIndicator,
    listener,
    applySettings,
    setGaze,
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
