// The central play region of the first-person picture (round 6): where the ball flies in, bounces,
// meets the racket, and where the hands and racket are drawn. While a ball is live NOTHING of the
// HUD may sit in it (src/ui/ui.js enforces this every HUD tick and styles/app.css lays the clean HUD
// out around it). Fractions of the viewport, y down. Pure module.
//
// The far court's back glass spans ~28-40 % of the height at the default framing (fov 74°, pitch
// -14°), the opponents' contacts ~35 %, the ball's path down to the racket the rest; the hands and
// racket fill the bottom. The free bands are the top 20 % (the hall above the far glass) and the
// outer 15 % columns (the side glass).
export const PLAY_REGION = Object.freeze({ x0: 0.15, x1: 0.85, y0: 0.2, y1: 1 });

/** Top band (fraction of the height) the clean HUD lives in: bar + feedback line. */
export const TOP_BAND = PLAY_REGION.y0;

/** Pixel rect of the play region for a viewport of W x H. */
export function playRegionRect(W, H, r = PLAY_REGION) {
  return { x0: r.x0 * W, y0: r.y0 * H, x1: r.x1 * W, y1: r.y1 * H };
}

/** Does a pixel rect {x0,y0,x1,y1} (or DOMRect-like {left,top,right,bottom}) intrude into the play region? */
export function intrudesPlayRegion(rect, W, H, { margin = 0, region = PLAY_REGION } = {}) {
  if (!rect) return false;
  const x0 = rect.x0 ?? rect.left, y0 = rect.y0 ?? rect.top, x1 = rect.x1 ?? rect.right, y1 = rect.y1 ?? rect.bottom;
  if (!(x1 > x0 && y1 > y0)) return false;
  const p = playRegionRect(W, H, region);
  return x1 > p.x0 + margin && x0 < p.x1 - margin && y1 > p.y0 + margin && y0 < p.y1 - margin;
}

/** Area (px²) of a rect inside the play region. */
export function playRegionOverlap(rect, W, H, region = PLAY_REGION) {
  const x0 = rect.x0 ?? rect.left, y0 = rect.y0 ?? rect.top, x1 = rect.x1 ?? rect.right, y1 = rect.y1 ?? rect.bottom;
  const p = playRegionRect(W, H, region);
  return Math.max(0, Math.min(x1, p.x1) - Math.max(x0, p.x0)) * Math.max(0, Math.min(y1, p.y1) - Math.max(y0, p.y0));
}
