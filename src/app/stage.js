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
import { createBallReconciler } from '../render/reconcile.js';
import { setActorQuality } from '../render/actorKit.js';
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

  const viewSettings = { fov: settings.fov, gazeFollow: settings.gazeFollow, viewPitch: settings.viewPitch, eyeOffset: settings.eyeOffset };
  const fpCam = createFirstPersonCamera(app.camera, viewSettings);
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

  /**
   * @param {object} w World (or replay frame: {time, ball, player, coach, ai, machine, mode})
   * @param {number} dt display dt (s, already scaled for slow motion)
   * @param {object} o { alpha, extrapolate, selfActor: actorState|null, showRig, racketPath: [{x,y,z}], ghostPose }
   */
  const reconciler = createBallReconciler();

  function syncWorld(w, dt, o = {}) {
    // Lag-compensated hits rewrite the ball's path; the reconciler hides the jump.
    const rb = reconciler.update(w ? w.ball : null, w ? w.ballCorrection || null : null, dt);
    ballView.update(rb, dt, o.alpha ?? 1);
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
    if (showRig) {
      const e = w.player.eye, off = viewSettings.eyeOffset;
      viewEye = tmpEye.set(e.x, e.y - (off ? off.down || 0 : 0), e.z + (off ? off.back || 0 : 0));
    }
    rig.update(showRig ? w.player : null, dt, {
      extrapolate: o.extrapolate || 0, visible: !!showRig, eye: viewEye, eye2: showRig ? w.player.eye : null, ball: rb && !rb.atRest ? rb.pos : null,
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
    fpCam.update(w, dt, o.dtReal ?? dt);
    setCutaway(view === 'replay' ? fpCam.replayView : null);
    effects.update(dt);
    env.update(dt);
  }

  /**
   * Off-screen ball indicator for the HUD: { angle } (0 = ahead, + right, PI = behind) or null
   * while the ball is inside the view.
   */
  function ballIndicator(ball) {
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

  function resize() {
    app.resize(window.innerWidth, window.innerHeight);
  }

  return {
    app,
    env,
    effects,
    ballView,
    reconciler,
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
    render(dt) { app.render(dt); },
    /** Glass normal (into the court) for a wall event. */
    wallNormal(evt) {
      if (evt.wall === 'back') return { x: 0, y: 0, z: evt.pos.z > 0 ? -1 : 1 };
      return { x: evt.pos.x > 0 ? -1 : 1, y: 0, z: 0 };
    },
    RACKET_SWEET: RACKET.sweetSpotY,
    COURT,
  };
}
