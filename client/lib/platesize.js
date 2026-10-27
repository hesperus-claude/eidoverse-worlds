// platesize — a nameplate's size and visibility from WORLD distance to the eye. Pure (tools/platesize-test.ts).
//
// Size: s = 1 up close; once capitals would fall under 0.6° (the mixed-reality legibility guidance) it holds 0.6°;
// past MAX_GROW perspective shrinks it again so a far crowd recedes.
// Occlusion: hidden by scenery and other bodies, never its own: depth is written as if plateClear() m nearer the eye
// (ownClearance, measured once per body); only the depth TEST moves.
// Hold-to-reveal: every plate in range draws through everything at ≥0.6°, fading past REVEAL_FULL–REVEAL_GONE;
// `k` is the eased reveal level 0..1 (revealLevel, REVEAL_EASE_MS). Why this shape: docs/research/nameplates.md.

export const PLATE_W = 0.9;            // metres: the sprite's width at s = 1 (512 px canvas)
// cap height of the 40 px name, MEASURED in headless Chromium: 30 px, at 0.9 m per 512 px
export const PLATE_CAP_H = 30 * PLATE_W / 512;   // ≈ 0.0527 m
export const TEXT_DEG = 0.6;           // the comfortable-reading angle
export const MAX_GROW = 3;             // then perspective takes over again
export const PLATE_D0 = PLATE_CAP_H / Math.tan(TEXT_DEG * Math.PI / 180);   // ≈ 5.0 m: where 0.6° starts needing help
export const FADE_FULL = 20, FADE_GONE = 30;   // metres: full to 20, gone by 30 (VRChat's 30 m cut, softened)

export const REVEAL_FULL = 50, REVEAL_GONE = 60;   // metres: the held reveal's fade — 'every name within ~60 m'
export const REVEAL_EASE_MS = 120;                 // press and release both

const fade = (d, full, gone) => Math.min(1, Math.max(0, 1 - (d - full) / (gone - full)));

/** d = world distance eye→body (m); k = reveal level 0..1 (0 = normal). → { s: size factor, lw: sprite width (m),
 *  vis: opacity 0..1 } */
export function plateSize(d, k = 0) {
  const held = Math.max(1, d / PLATE_D0);   // 0.6° at any range, never under world size
  const s0 = Math.min(MAX_GROW, held);
  const s = s0 + (held - s0) * k;
  const vis = fade(d, FADE_FULL, FADE_GONE) + (fade(d, REVEAL_FULL, REVEAL_GONE) - fade(d, FADE_FULL, FADE_GONE)) * k;
  return { s, lw: PLATE_W * s, vis };
}

// ---- own-body clearance ------------------------------------------------------------------------------------------
// Only body points above (anchor − CLEAR_BAND) count: what stands between an eye and the plate. MARGIN covers swinging
// hair. Clamped: at least a head (an unmeasured body), at most a stride (past that it shows through a nearby wall).
export const CLEAR_BAND = 0.5, CLEAR_MARGIN = 0.12, CLEAR_MIN = 0.35, CLEAR_MAX = 1.2;
/** reach: the farthest (m) counted own-body point from the anchor. */
export const ownClearance = (reach) => Math.min(CLEAR_MAX, Math.max(CLEAR_MIN, (Number.isFinite(reach) ? reach : 0) + CLEAR_MARGIN));
/** Over a flat [x,y,z,…] list in the body's frame (anchor at [0,ay,0]); points under ay − CLEAR_BAND are skipped. */
export function reachAbove(xyz, ay) {
  let best = 0;
  for (let i = 0; i + 2 < xyz.length; i += 3) {
    const y = xyz[i + 1];
    if (y < ay - CLEAR_BAND) continue;
    const r = Math.hypot(xyz[i], y - ay, xyz[i + 2]);
    if (r > best) best = r;
  }
  return best;
}
/** The depth pull (m): the clearance, plus, while revealing, enough to pass the eye (clamped to the near plane), so
 *  held plates draw through everything. */
export const plateClear = (own, d, k = 0) => own + 2 * Math.max(0, d) * k;

// ---- the reveal level ------------------------------------------------------------------------------------------
/** Linear toward held (1) or released (0) from k0 at t0 (ms), REVEAL_EASE_MS per full swing. */
export const revealRamp = (held, t0, k0, now) => Math.min(1, Math.max(0, k0 + (held ? 1 : -1) * (now - t0) / REVEAL_EASE_MS));
/** Smoothstep: no velocity jump at either end. */
export const revealEase = (r) => r * r * (3 - 2 * r);


// ---- the plate's box ----------------------------------------------------------------------------------------
// width from measured ink, height from reference glyphs so "ggg" and "HHH" match; never fontBoundingBox* (its line
// gap makes the text look low)
export const PLATE_TEX_W = 512, PLATE_PAD_Y = 12, PLATE_PAD_X = 24, PLATE_MARGIN = 6;
/** ink: {asc, desc, width}; ref: the reference glyphs' {asc, desc} (px at the bake font) → integer px. */
export function plateBox(ink, ref) {
  const asc = Math.ceil(Math.max(ink.asc || 0, ref.asc || 0)), desc = Math.ceil(Math.max(ink.desc || 0, ref.desc || 0));
  const pillH = asc + desc + 2 * PLATE_PAD_Y;
  const pillW = Math.min(PLATE_TEX_W - 2 * PLATE_MARGIN, Math.ceil(ink.width || 0) + 2 * PLATE_PAD_X);
  return { w: PLATE_TEX_W, h: pillH + 2 * PLATE_MARGIN, pillW, pillH, top: PLATE_MARGIN, baseline: PLATE_MARGIN + PLATE_PAD_Y + asc };
}
