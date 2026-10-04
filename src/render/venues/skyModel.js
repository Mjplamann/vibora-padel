// CPU twin of the analytic sky in sky.js (pure: no three). Used for the sun light colour, the
// hemisphere fill, the haze colour and the tests.

/** Zenith optical depths for R, G, B (≈ 680, 550, 440 nm) on a hazy Mediterranean evening. */
export const ATMOSPHERE = Object.freeze({
  tauR: [0.0464, 0.108, 0.265],
  tauM: 0.035,
  tauO: [0.012, 0.05, 0.002], // ozone (Chappuis band): keeps the twilight zenith blue
  mieG: 0.7,
  sunE: 20, // radiance scale of the scattered sky (linear HDR, exposure 1)
  sunDisc: 55, // sun disc radiance before transmittance
  // Reddening of the sunlight that scatters toward the viewer: rays near the horizon scatter low
  // in the atmosphere where the sunlight has crossed more air (the warm horizon band).
  redden: [0.3, 1.0, 5.0],
  multi: 0.03, // multiple-scattering lift
});

const deg = (r) => (r * 180) / Math.PI;

/** Kasten–Young relative air mass for a direction with sin(elevation) = s. */
export function airMass(s) {
  const el = Math.max(-0.5, deg(Math.asin(Math.max(-1, Math.min(1, s)))));
  return 1 / (Math.max(0, s) + 0.50572 * (el + 6.07995) ** -1.6364);
}

/** Direct sunlight transmittance [r, g, b] at sun elevation sin = s. */
export function sunTransmittance(s, A = ATMOSPHERE) {
  const m = airMass(s);
  return [0, 1, 2].map((i) => Math.exp(-(A.tauR[i] + A.tauM + A.tauO[i]) * m));
}

/** Sky radiance [r, g, b] (linear HDR) toward unit direction d for a sun direction sd. */
export function skyRadiance(d, sd, A = ATMOSPHERE) {
  const mu = d.x * sd.x + d.y * sd.y + d.z * sd.z;
  const mv = airMass(Math.max(0.0, d.y));
  const ms = airMass(sd.y);
  const phR = (3 / (16 * Math.PI)) * (1 + mu * mu);
  const g = A.mieG;
  const phM = (1 - g * g) / (4 * Math.PI * (1 + g * g - 2 * g * mu) ** 1.5);
  const out = [0, 0, 0];
  for (let i = 0; i < 3; i++) {
    const tau = A.tauR[i] + A.tauM + A.tauO[i];
    const rd = A.redden[0] + A.redden[1] * Math.exp(-Math.max(0, d.y) * A.redden[2]);
    const tsun = Math.exp(-tau * ms * rd);
    const sc = (A.tauR[i] * phR + A.tauM * phM) / (A.tauR[i] + A.tauM);
    const ext = 1 - Math.exp(-(A.tauR[i] + A.tauM) * mv);
    const ms2 = (A.multi * A.tauR[i]) / (A.tauR[i] + A.tauM);
    out[i] = A.sunE * tsun * (sc + ms2) * ext * Math.exp(-A.tauO[i] * mv * 0.5);
  }
  return out;
}

