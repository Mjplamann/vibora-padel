// Analytic shadow of the court enclosure for a low sun (sunset venue): the glass, the 50 mm welded
// mesh and the net, evaluated per ground fragment (a shadow map cannot resolve 4 mm wires).
import * as THREE from 'three';
import { COURT } from '../../config.js';

const BAND_H = 0.06;

// Enclosure shadow veil: the sun's light through the glass, the welded mesh and the net, computed
// analytically on the ground (a 5 cm mesh is far below what a shadow map resolves; at golden hour
// its shadow is a long stretched grid across the court). Shared with the venue ground materials.

export const VEIL_GLSL = /* glsl */ `
  uniform vec4 uSun;   // xyz: unit vector toward the sun (court frame), w: 1 = veil on
  // Box-filtered coverage of wires of half-width hw every P along u; the filter is the pixel
  // footprint or the sun's penumbra (0.53° disc: blur = distance × 0.0093), whichever is wider.
  float veilPulse(float u, float P, float hw, float blur) {
    float fw = max(max(fwidth(u), blur), 1e-5);
    float a = u + hw - 0.5 * fw, b = u + hw + 0.5 * fw;
    float ia = floor(a / P) * 2.0 * hw + min(fract(a / P) * P, 2.0 * hw);
    float ib = floor(b / P) * 2.0 * hw + min(fract(b / P) * P, 2.0 * hw);
    return clamp((ib - ia) / fw, 0.0, 1.0);
  }
  // Transmission of one wall at lateral coordinate a, height h (side: a = z, back: a = x).
  vec3 veilWall(float a, float h, float side, float t) {
    float blur = t * 0.0093;
    float aa = abs(a);
    float gTop = side > 0.5 ? (aa > 8.0 ? 3.0 : aa > 6.0 ? 2.0 : 0.0) : 3.0;
    float mTop = side > 0.5 ? (aa > 8.0 ? 4.0 : 3.0) : 4.0;
    float inGlass = step(0.0, h) * step(h, gTop);
    float inMesh = step(gTop, h) * step(h, mTop);
    float meshT = (1.0 - veilPulse(a, 0.05, 0.002, blur)) * (1.0 - veilPulse(h, 0.05, 0.002, blur));
    float joint = veilPulse(side > 0.5 ? a : a + 1.0, 2.0, 0.012, blur);
    vec3 glassT = vec3(0.84, 0.9, 0.87) * (1.0 - 0.55 * joint);
    return mix(vec3(1.0), glassT, inGlass) * mix(1.0, meshT, inMesh);
  }
  vec3 enclosureVeil(vec3 p, vec3 s) {
    vec3 T = vec3(1.0);
    // Side walls x = ±5 and back walls z = ±10, crossed on the way to the sun.
    for (int k = 0; k < 2; k++) {
      float X = k == 0 ? 5.0 : -5.0;
      float tx = abs(s.x) > 1e-4 ? (X - p.x) / s.x : -1.0;
      float zx = p.z + tx * s.z;
      float vx = step(1e-4, tx) * step(abs(zx), 10.0);
      vec3 wx = veilWall(zx, p.y + tx * s.y, 1.0, tx);
      T *= mix(vec3(1.0), wx, vx);
      float Z = k == 0 ? 10.0 : -10.0;
      float tz = abs(s.z) > 1e-4 ? (Z - p.z) / s.z : -1.0;
      float xz = p.x + tz * s.x;
      float vz = step(1e-4, tz) * step(abs(xz), 5.0);
      vec3 wz = veilWall(xz, p.y + tz * s.y, 0.0, tz);
      T *= mix(vec3(1.0), wz, vz);
    }
    // Net: knotted 45 mm squares, 3 mm twine, a solid white band on top.
    float tn = abs(s.z) > 1e-4 ? -p.z / s.z : -1.0;
    float xn = p.x + tn * s.x;
    float hn = p.y + tn * s.y;
    float top = ${COURT.net.centerHeight.toFixed(3)} + ${(COURT.net.postHeight - COURT.net.centerHeight).toFixed(3)} * min(1.0, abs(xn) / 5.0);
    float vn = step(1e-4, tn) * step(abs(xn), 5.0) * step(0.02, hn) * step(hn, top);
    float band = step(top - ${BAND_H.toFixed(3)}, hn);
    float netT = (1.0 - veilPulse(xn, 0.0455, 0.0016, tn * 0.0093)) * (1.0 - veilPulse(hn, 0.0455, 0.0016, tn * 0.0093));
    T *= mix(1.0, mix(netT, 0.06, band), vn);
    return T;
  }
`;

/** Adds the veil to a material's directional light (the sun) via onBeforeCompile pieces. */
export function veilLightsChunk() {
  return THREE.ShaderChunk.lights_fragment_begin.replace(
    'getDirectionalLightInfo( directionalLight, directLight );',
    'getDirectionalLightInfo( directionalLight, directLight );\n\t\tdirectLight.color *= gSunVeil;',
  );
}

