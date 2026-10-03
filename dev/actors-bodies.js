// Dev helper: hand-built player / bodyCourt data in the shapes main.js produces (SPEC §5.1).
import * as THREE from 'three';
import { v3 } from '../src/util/vec3.js';
import { solveElbow } from '../src/render/fpRig.js';

// ---------------------------------------------------------------- hand-built ready body
const _a = new THREE.Vector3();
/** Plausible bodyCourt for a right-handed player in ready position at court (px, pz). */
export function readyBody(px, pz, { racketAxis = [-0.22, 0.72, -0.66], faceNormal = [-0.92, 0.05, 0.35], wristR = [0.2, 1.2, -0.42], wristL = [-0.2, 1.12, -0.4] } = {}) {
  const P = (x, y, z) => v3(px + x, y, pz + z);
  const axis = new THREE.Vector3(...racketAxis).normalize();
  const normal = new THREE.Vector3(...faceNormal);
  normal.addScaledVector(axis, -normal.dot(axis)).normalize();
  const xr = new THREE.Vector3().crossVectors(axis, normal); // thumb side for the right hand
  // body.js convention: hand dir = racket axis rotated 15 deg away from the thumb side.
  const dh = axis.clone().multiplyScalar(Math.cos(0.26)).addScaledVector(xr, -Math.sin(0.26)).normalize();
  const wR = P(...wristR);
  const grip = _a.set(wR.x, wR.y, wR.z).addScaledVector(dh, 0.115);
  const kn = new THREE.Vector3(wR.x, wR.y, wR.z).addScaledVector(dh, 0.085);
  const lat = new THREE.Vector3().crossVectors(normal, dh).normalize(); // toward the thumb for right hand
  const wL = P(...wristL);
  const dl = new THREE.Vector3(0.25, -0.15, -1).normalize();
  const nl = new THREE.Vector3(0.75, 0.15, 0.2).normalize(); // left palm faces in/right
  const latL = new THREE.Vector3().crossVectors(dl, nl).normalize(); // left: thumb side = f x n
  const knL = new THREE.Vector3(wL.x, wL.y, wL.z).addScaledVector(dl, 0.085);
  const vv = (v) => v3(v.x, v.y, v.z);
  const ik = (S, W, sgn) => vv(solveElbow(new THREE.Vector3(S.x, S.y, S.z), new THREE.Vector3(W.x, W.y, W.z), 0.3, 0.265,
    new THREE.Vector3(0.6 * sgn, -1, 0.35).normalize()));
  const joints = {
    nose: P(0, 1.66, -0.1), eyeL: P(-0.032, 1.64, -0.08), eyeR: P(0.032, 1.64, -0.08), earL: P(-0.075, 1.62, 0), earR: P(0.075, 1.62, 0),
    shoulderL: P(-0.19, 1.43, 0.0), shoulderR: P(0.19, 1.43, 0.0),
    elbowL: ik(P(-0.19, 1.43, 0), wL, -1), elbowR: ik(P(0.19, 1.43, 0), wR, 1),
    wristL: wL, wristR: wR,
    indexR: vv(kn.clone().addScaledVector(lat, 0.025)), pinkyR: vv(kn.clone().addScaledVector(lat, -0.035)),
    thumbR: vv(kn.clone().addScaledVector(lat, 0.04).addScaledVector(dh, -0.03)),
    indexL: vv(knL.clone().addScaledVector(latL, 0.025)), pinkyL: vv(knL.clone().addScaledVector(latL, -0.035)),
    thumbL: vv(knL.clone().addScaledVector(latL, 0.04)),
    hipL: P(-0.1, 0.93, 0.02), hipR: P(0.1, 0.93, 0.02), kneeL: P(-0.14, 0.5, -0.05), kneeR: P(0.14, 0.5, -0.05),
    ankleL: P(-0.17, 0.08, 0), ankleR: P(0.17, 0.08, 0),
  };
  const racket = { grip: vv(grip), axis: vv(axis), normal: vv(normal), vel: v3(), t: 0 };
  return {
    pos: v3(px, 0, pz), eye: P(0, 1.64, -0.06), handed: 'right', height: 1.75, racket,
    bodyCourt: {
      joints,
      handFrames: { R: { grip: racket.grip, axis: racket.axis, normal: racket.normal }, L: { grip: vv(knL), axis: vv(dl), normal: vv(nl) } },
      dominant: 'R', eye: P(0, 1.64, -0.06),
    },
  };
}

