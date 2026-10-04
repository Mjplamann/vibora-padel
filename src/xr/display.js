// Display maths for VITURE Beast glasses (pure): field of view, view profiles, side-by-side
// layouts and the head-locked HUD placement.
//
// The Beast shows a 1920×1200 (16:10) picture per eye over a 58° diagonal field of view, at 60 Hz
// on macOS (community tests: 120 Hz writes are accepted but read back 60 Hz). Its 3D mode takes a
// side-by-side frame: "full" SBS is 3840×1200 (each eye 1920×1200), "half" SBS squeezes both eyes
// into 1920×1200 (each eye 960×1200, stretched back to 16:10 by the glasses).

const DEG = Math.PI / 180;

export const BEAST = Object.freeze({
  diagonalDeg: 58,
  aspect: Object.freeze([16, 10]),
  eye: Object.freeze({ width: 1920, height: 1200 }),
  sbs: Object.freeze({ width: 3840, height: 1200 }),
  hz: 60,
  ipdMm: 63,
});

/**
 * Horizontal and vertical FOV (deg) of a flat (rectilinear) picture with the given diagonal FOV
 * and aspect ratio: tan(h/2) = tan(d/2)·w/√(w²+h²), tan(v/2) = tan(d/2)·h/√(w²+h²).
 */
export function fovFromDiagonal(diagDeg, aw = 16, ah = 10) {
  const t = Math.tan((diagDeg * DEG) / 2);
  const n = Math.hypot(aw, ah);
  return {
    diagonal: diagDeg,
    horizontal: (2 * Math.atan((t * aw) / n)) / DEG,
    vertical: (2 * Math.atan((t * ah) / n)) / DEG,
  };
}

/** Vertical FOV (deg) for a horizontal FOV at an aspect ratio, and back. */
export const vfovFromHfov = (hDeg, aspect) => (2 * Math.atan(Math.tan((hDeg * DEG) / 2) / aspect)) / DEG;
export const hfovFromVfov = (vDeg, aspect) => (2 * Math.atan(Math.tan((vDeg * DEG) / 2) * aspect)) / DEG;

const TRUE = fovFromDiagonal(BEAST.diagonalDeg, BEAST.aspect[0], BEAST.aspect[1]);

/**
 * View profiles. 'true': true scale, things look their real size (≈ 32.7° vertical, 50.3°
 * horizontal), best with head tracking. 'wide': comfort wide (50° vertical, ≈ 72° horizontal),
 * more court in view without turning your head, things look smaller. 'tv': no override (the
 * Settings field of view). 'auto': true scale with head tracking, comfort wide without.
 */
export const PROFILES = Object.freeze({
  true: Object.freeze({ id: 'true', vertical: TRUE.vertical, label: 'True scale' }),
  wide: Object.freeze({ id: 'wide', vertical: 50, label: 'Comfort wide' }),
  tv: Object.freeze({ id: 'tv', vertical: null, label: 'TV view' }),
});
export const PROFILE_IDS = Object.freeze(['auto', 'true', 'wide', 'tv']);

/** Vertical FOV override (deg) for a profile, or null to keep the app's own field of view. */
export function profileFov(profile, { headTracking = false } = {}) {
  const id = profile === 'auto' || !PROFILES[profile] ? (headTracking ? 'true' : 'wide') : profile;
  return PROFILES[id].vertical;
}

/** { vertical, horizontal } of a profile at the glasses' 16:10 aspect (horizontal null for 'tv'). */
export function profileInfo(profile, opts) {
  const v = profileFov(profile, opts);
  return { vertical: v, horizontal: v ? hfovFromVfov(v, BEAST.aspect[0] / BEAST.aspect[1]) : null };
}

/** True for an output that can only be a full side-by-side frame (3840×1200 = 3.2, 3840×1080 = 3.56). */
export function isFullSbsAspect(width, height) {
  const a = width / Math.max(1, height);
  return a >= 2.9 && a <= 3.8;
}

/**
 * Per-eye viewports (drawing-buffer or CSS pixels, y from the bottom as WebGL wants) and the
 * projection aspect each eye must use.
 * @param {number} width  output width
 * @param {number} height output height
 * @param {'auto'|'full'|'half'} mode  'auto': full when the output is ~2 × 16:10 wide, else half
 */
export function sbsLayout(width, height, mode = 'auto') {
  const kind = mode === 'full' || mode === 'half' ? mode : isFullSbsAspect(width, height) ? 'full' : 'half';
  const half = Math.floor(width / 2);
  const left = { x: 0, y: 0, width: half, height };
  const right = { x: half, y: 0, width: width - half, height };
  // Full: each half is shown 1:1. Half: each half is stretched ×2 horizontally by the glasses,
  // so the projection must use the displayed aspect (2 × half-width / height).
  const eyeAspect = kind === 'full' ? half / Math.max(1, height) : (2 * half) / Math.max(1, height);
  return { kind, eyeAspect, left, right };
}

/** Eye positions along the head's local +X (m): left eye first. */
export function eyeOffsets(ipdM = BEAST.ipdMm / 1000) {
  const h = Math.max(0, ipdM) / 2;
  return [-h, h];
}

/** Clamps an IPD in mm to the adult range used by the settings (54–74 mm). */
export const clampIpdMm = (mm) => (Number.isFinite(mm) ? Math.min(74, Math.max(54, Math.round(mm))) : BEAST.ipdMm);

/**
 * Head-locked HUD plane placement inside the eye FOV: a strip near the top edge, distance d (m),
 * at most `maxWidthFrac` of the horizontal view. Returns { width, height, y, distance } (m, y up
 * from the view centre).
 */
export function hudPlacement(vfovDeg, aspect, { distance = 2, texAspect = 4, maxWidthFrac = 0.62, topMargin = 0.08 } = {}) {
  const halfH = distance * Math.tan((vfovDeg * DEG) / 2);
  const halfW = halfH * aspect;
  const width = 2 * halfW * maxWidthFrac;
  const height = width / texAspect;
  const y = halfH * (1 - topMargin) - height / 2;
  return { width, height, y, distance };
}
