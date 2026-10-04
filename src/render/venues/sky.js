// Analytic golden-hour sky: single scattering of sunlight by air molecules (Rayleigh, λ^-4) and
// haze (Mie, Henyey-Greenstein forward lobe) through a plane-parallel atmosphere, with ozone
// absorption, Kasten-Young air mass, a limb-darkened sun disc, drifting lit cloud streaks and,
// below the horizon, a distant sea reflecting the sky with a sun-glitter path.
//
// The same model runs on the CPU (skyRadiance / sunTransmittance) so the sun light, the hemisphere
// fill and the haze colour match what the dome shows.
import * as THREE from 'three';

import { ATMOSPHERE, airMass, sunTransmittance, skyRadiance } from './skyModel.js';

export { ATMOSPHERE, airMass, sunTransmittance, skyRadiance };

export const SKY_GLSL = /* glsl */ `
  uniform vec3 uSunDir;
  uniform vec3 uTauR;
  uniform vec3 uTauO;
  uniform float uTauM;
  uniform float uMieG;
  uniform float uSunE;
  uniform float uSunDisc;
  uniform float uTime;
  uniform float uCloud;
  uniform vec3 uSeaCol;
  uniform vec4 uRedden; // r0, r1, r2, multiple scattering
  const float PI_S = 3.14159265;
  float airMassS(float s) {
    float el = max(-0.5, degrees(asin(clamp(s, -1.0, 1.0))));
    return 1.0 / (max(0.0, s) + 0.50572 * pow(el + 6.07995, -1.6364));
  }
  vec3 skyScatter(vec3 d) {
    float mu = dot(d, uSunDir);
    float mv = airMassS(max(0.0, d.y));
    float ms = airMassS(uSunDir.y);
    float phR = 3.0 / (16.0 * PI_S) * (1.0 + mu * mu);
    float g = uMieG;
    float phM = (1.0 - g * g) / (4.0 * PI_S * pow(1.0 + g * g - 2.0 * g * mu, 1.5));
    vec3 tauS = uTauR + vec3(uTauM);
    vec3 tau = tauS + uTauO;
    vec3 tsun = exp(-tau * ms * (uRedden.x + uRedden.y * exp(-max(0.0, d.y) * uRedden.z)));
    vec3 sc = (uTauR * phR + vec3(uTauM * phM)) / tauS;
    vec3 ext = 1.0 - exp(-tauS * mv);
    vec3 ms2 = uRedden.w * uTauR / tauS;
    return uSunE * tsun * (sc + ms2) * ext * exp(-uTauO * mv * 0.5);
  }
  float hashS(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noiseS(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    f = f * f * (3.0 - 2.0 * f);
    return mix(mix(hashS(i), hashS(i + vec2(1.0, 0.0)), f.x), mix(hashS(i + vec2(0.0, 1.0)), hashS(i + vec2(1.0, 1.0)), f.x), f.y);
  }
  float fbmS(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noiseS(p); p = p * 2.03 + vec2(1.7, 9.2); a *= 0.5; }
    return v;
  }
  vec3 sunColorS() { return exp(-(uTauR + vec3(uTauM) + uTauO) * airMassS(uSunDir.y)); }
  vec3 skyColor(vec3 d, bool withSun) {
    vec3 L = skyScatter(d);
    vec3 tsun = sunColorS();
    // Cloud streaks (alto-stratus / cirrus) on a plane, lit warm from below by the low sun.
    float up = max(d.y, 0.0);
    vec2 cuv = d.xz / (up + 0.06) * 0.55 + vec2(uTime * 0.004, uTime * 0.0015);
    float n = fbmS(cuv * vec2(1.0, 2.6));
    float dens = smoothstep(0.52, 0.82, n) * uCloud * smoothstep(0.015, 0.12, up) * (1.0 - smoothstep(0.5, 0.9, up));
    float mu = dot(d, uSunDir);
    float fwd = pow(max(mu, 0.0), 6.0);
    vec3 cloudCol = tsun * uSunE * (0.05 + 0.22 * fwd) + L * 0.6 + vec3(0.06, 0.03, 0.05);
    L = mix(L, cloudCol, dens * 0.8);
    if (withSun) {
      float ang = acos(clamp(mu, -1.0, 1.0));
      float r0 = 0.0095;
      float disc = smoothstep(r0, r0 * 0.85, ang);
      float limb = sqrt(max(0.0, 1.0 - (ang / r0) * (ang / r0)));
      L += disc * uSunDisc * tsun * (0.6 + 0.4 * limb) * (1.0 - dens * 0.7);
    }
    return L;
  }
  // Sea below the horizon (the terrace stands on a ~30 m cliff): Fresnel sky reflection, deep
  // water, wind waves in world units that fade to sub-pixel with distance, sun glitter.
  vec3 seaColor(vec3 d) {
    float dn = max(-d.y, 1e-4);
    float dist = 32.0 / dn;
    vec2 wp = d.xz * dist;
    float near = clamp(90.0 / dist, 0.0, 1.0);
    vec2 n1 = vec2(noiseS(wp * 0.11 + uTime * 0.25), noiseS(wp * 0.13 - uTime * 0.21 + 3.1)) - 0.5;
    vec2 n2 = vec2(noiseS(wp * 0.47 + uTime * 0.9), noiseS(wp * 0.53 - uTime * 0.8 + 7.0)) - 0.5;
    vec2 nn = n1 * 0.09 + n2 * 0.05 * near;
    vec3 n = normalize(vec3(nn.x, 1.0, nn.y));
    vec3 r = reflect(d, n);
    r.y = abs(r.y);
    float cosT = clamp(dot(-d, n), 0.0, 1.0);
    float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
    vec3 refl = skyColor(r, false);
    vec3 body = uSeaCol * (0.25 + 0.75 * skyScatter(vec3(0.0, 1.0, 0.0)));
    vec3 col = mix(body, refl, F);
    // Sun glitter: many facets catch the low sun in a band toward it.
    vec3 h = normalize(uSunDir - d);
    float spec = pow(max(dot(n, h), 0.0), 700.0) * 700.0;
    float band = pow(max(dot(normalize(vec3(d.x, 0.0, d.z)), normalize(vec3(uSunDir.x, 0.0, uSunDir.z))), 0.0), 30.0);
    col += sunColorS() * uSunDisc * 0.015 * spec * (0.25 + band);
    // Haze toward the horizon.
    return mix(col, skyScatter(vec3(d.x, 0.002, d.z)), exp(-dn * 45.0));
  }
`;

const VERT = /* glsl */ `
  varying vec3 vDir;
  void main() {
    vDir = normalize(position);
    vec4 p = viewMatrix * vec4(position, 0.0); // rotation only: the dome is centred on the camera
    gl_Position = projectionMatrix * vec4(p.xyz, 1.0);
    gl_Position.z = gl_Position.w * 0.99999; // never clipped, always behind everything
  }
`;

const FRAG = /* glsl */ `
  ${SKY_GLSL}
  varying vec3 vDir;
  void main() {
    vec3 d = normalize(vDir);
    vec3 c = d.y >= 0.0 ? skyColor(d, true) : seaColor(d);
    gl_FragColor = vec4(c, 1.0);
  }
`;

/**
 * @param {{ sunDir: THREE.Vector3, cloud?: number, sea?: THREE.Color|number }} o
 * @returns {{ mesh: THREE.Mesh, uniforms, sunColor: THREE.Color (normalised transmittance), update(t) }}
 */
export function createSky({ sunDir, cloud = 0.55, sea = 0x123a4f, atmosphere = ATMOSPHERE } = {}) {
  const A = atmosphere;
  const uniforms = {
    uSunDir: { value: sunDir.clone().normalize() },
    uTauR: { value: new THREE.Vector3(...A.tauR) },
    uTauO: { value: new THREE.Vector3(...A.tauO) },
    uTauM: { value: A.tauM },
    uMieG: { value: A.mieG },
    uSunE: { value: A.sunE },
    uSunDisc: { value: A.sunDisc },
    uTime: { value: 0 },
    uCloud: { value: cloud },
    uSeaCol: { value: new THREE.Color(sea) },
    uRedden: { value: new THREE.Vector4(A.redden[0], A.redden[1], A.redden[2], A.multi) },
  };
  const mat = new THREE.ShaderMaterial({
    uniforms, vertexShader: VERT, fragmentShader: FRAG, side: THREE.BackSide, depthWrite: false, depthTest: true, fog: false,
  });
  const mesh = new THREE.Mesh(new THREE.SphereGeometry(100, 64, 32), mat);
  mesh.name = 'sky';
  mesh.frustumCulled = false;
  mesh.renderOrder = -100;
  const t = sunTransmittance(uniforms.uSunDir.value.y, A);
  return {
    mesh,
    uniforms,
    sunTransmittance: t,
    update(time) {
      uniforms.uTime.value = time;
    },
    radiance(dir) {
      return skyRadiance(dir, uniforms.uSunDir.value, A);
    },
  };
}
