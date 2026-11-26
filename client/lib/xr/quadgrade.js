// quadgrade — the VR panels' saturation/contrast grade as pure numbers (no three): the defaults, the ranges, the
// persisted choice, and gradeSRGB, the JS twin of the shader grade in quadcolour.js. VR panels only: never the design
// tokens, never the desktop (colours read less vibrant in VR: a modest default boost).
export const LUMA = [0.2126, 0.7152, 0.0722];   // Rec. 709, the weights the shader uses
// VR panel grade: modest by default; the Settings › VR sliders drive these
export const GRADE_DEFAULT = Object.freeze({ saturation: 1.15, contrast: 1.08 });
export const GRADE_RANGE = Object.freeze({ saturation: [0.5, 2], contrast: [0.5, 1.8] });
const LS = 'ew-xr-panel-grade';
export const clampTo = (v, [lo, hi], d) => (Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : d);
export const storeGrade = (g) => { try { localStorage.setItem(LS, JSON.stringify(g)); } catch {} };
export function loadGrade() {
  let o = {}; try { o = JSON.parse(localStorage.getItem(LS) || '{}') ?? {}; } catch {}
  return { saturation: clampTo(Number(o.saturation), GRADE_RANGE.saturation, GRADE_DEFAULT.saturation),
    contrast: clampTo(Number(o.contrast), GRADE_RANGE.contrast, GRADE_DEFAULT.contrast) };
}
/** The grade in sRGB-encoded [0,1] (the JS twin of the shader): saturation about Rec.709 luma, contrast about mid-grey. */
export function gradeSRGB([r, g, b], { saturation = 1, contrast = 1 } = {}) {
  const y = r * LUMA[0] + g * LUMA[1] + b * LUMA[2];
  return [r, g, b].map((v) => Math.min(1, Math.max(0, (y + (v - y) * saturation - 0.5) * contrast + 0.5)));
}

// The inverse of three's acesFilmicToneMapping (ToneMappingFunctions.js), one copy shared by the quadcolour.js shader
// and acesFilmicInverseJS below; test/client/quadcolour-test.mjs round-trips them through three's forward.
// Matrices are in the row order three lists its forward ones.
export const ACES_IN_INV = Object.freeze([1.76474097, -0.67577768, -0.08896329, -0.14702785, 1.16025151, -0.01322366, -0.03633683, -0.16243644, 1.19877327]);
export const ACES_OUT_INV = Object.freeze([0.64303825, 0.31118675, 0.04577546, 0.05926869, 0.93143649, 0.00929492, 0.0059619, 0.06392902, 0.93011838]);
export const ACES_FIT = Object.freeze({ A: 0.0245786, B: 0.000090537, C: 0.983729, D: 0.4329510 * 0.983729, E: 0.238081 });   // RRTAndODTFit's

const mul3 = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);   // as TSL's mat3(9 scalars) reads them
/** One channel of RRTAndODTFit⁻¹: y = (v² + Av − B)/(Cv² + Dv + E) solved for v ≥ 0 (the shader's rrtInv). */
function acesFitInverse(y) {
  const { A, B, C, D, E } = ACES_FIT, yc = Math.min(1, Math.max(0, y));
  const a = 1 - yc * C, b = A - yc * D, c = B + yc * E;
  return (-b + Math.sqrt(Math.max(b * b + 4 * a * c, 0))) / (2 * a);
}
/** The JS twin of quadcolour.js acesFilmicInverse: the linear working colour whose ACES Filmic at `exposure` is `lin`. */
export function acesFilmicInverseJS(lin, exposure = 1) {
  const y = mul3(ACES_OUT_INV, lin.map((v) => Math.min(1, Math.max(0, v))));
  return mul3(ACES_IN_INV, y.map(acesFitInverse)).map((v) => v * 0.6 / exposure);
}

// The world's other display transforms (sky.tonemap; render/tonemap.js): the inverses of three r186's agxToneMapping (its
// sigmoid solved by bisection), neutralToneMapping (Khronos PBR Neutral, closed form) and linearToneMapping, as data the
// quadcolour.js shader reads plus their JS twins; test/client/quadcolour-test.mjs reads three's own constants out of its
// source and round-trips these twins through three's forward. Orientation: TSL's mat3 of nine scalars is a Matrix3, read
// as ROWS (ACES's above), but three writes AgX's four as three vec3 COLUMNS; each is listed here in three's own order and
// turned into rows once (fromCols), so mul3, the shader's mat3(...9 scalars) and three all mean the same matrix.
const fromCols = (l) => Object.freeze([0, 3, 6, 1, 4, 7, 2, 5, 8].map((i) => l[i]));
const inv3 = (m) => {
  const [a, b, c, d, e, f, g, h, i] = m, A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g, det = a * A + b * B + c * C;
  return Object.freeze([A, -(b * i - c * h), b * f - c * e, B, a * i - c * g, -(a * f - c * d), C, -(a * h - b * g), a * e - b * d].map((x) => x / det));
};
// ceil: the inverse's own ceiling, not three's: the curve's peak only approaches 1, and 0.9999 is a peak of 576 (finite, and
// far under a HalfFloat's 65504 even at exposure 0.5)
export const NEUTRAL = Object.freeze({ start: 0.8 - 0.04, desat: 0.15, toeAt: 0.08, toeK: 6.25, toeOff: 0.04, ceil: 0.9999 });
export const SRGB_TO_REC2020 = fromCols([0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0113, 0.8956]);
export const REC2020_TO_SRGB = fromCols([1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187]);
export const AGX_INSET = fromCols([0.856627153315983, 0.137318972929847, 0.11189821299995, 0.0951212405381588, 0.761241990602591, 0.0767994186031903, 0.0482516061458583, 0.101439036467562, 0.811302368396859]);
export const AGX_OUTSET = fromCols([1.1271005818144368, -0.1413297634984383, -0.14132976349843826, -0.11060664309660323, 1.157823702216272, -0.11060664309660294, -0.016493938717834573, -0.016493938717834257, 1.2519364065950405]);
export const AGX_EV = Object.freeze({ min: -12.47393, max: 4.026069 });
export const AGX_POLY = Object.freeze([15.5, -40.14, 31.96, -6.868, 0.4298, 0.1191, -0.00232]);   // the sigmoid, x⁶ … x⁰
export const AGX_BISECT = 20;   // halvings of [0, 1]: 2⁻²⁰ of the log range, far under an 8-bit step
// each forward matrix undone by its exact inverse (three's two gamut matrices are rounded, not each other's inverse)
export const INV = Object.freeze({ toRec: inv3(SRGB_TO_REC2020), toSrgb: inv3(REC2020_TO_SRGB), inset: inv3(AGX_INSET), outset: inv3(AGX_OUTSET) });
const clamp01 = (v) => Math.min(1, Math.max(0, v));
const agxPoly = (x) => AGX_POLY.reduce((s, k) => s * x + k, 0);
/** The JS twin of quadcolour.js agxInverse: the linear working colour whose AgX at `exposure` is `lin`. */
export function agxInverseJS(lin, exposure = 1) {
  const c = mul3(INV.toSrgb, lin.map(clamp01)).map((v) => Math.max(v, 0) ** (1 / 2.2));
  const enc = mul3(INV.outset, c).map(clamp01).map((y) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < AGX_BISECT; i++) { const m = (lo + hi) / 2; if (agxPoly(m) <= y) lo = m; else hi = m; }
    return 2 ** (((lo + hi) / 2) * (AGX_EV.max - AGX_EV.min) + AGX_EV.min);
  });
  return mul3(INV.toRec, mul3(INV.inset, enc)).map((v) => v / exposure);
}
/** Neutral's image, from its own maths: a highlight of output peak n ≥ start is mixed toward grey by g(n), so its min/max
 *  ratio r is at least g(n); g grows with n, so the brightest peak a colour of ratio r can show is the n where g(n) = r:
 *  1 − u with u = 2d²w / (2dw + r + √(r(4dw + r))), d = 1 − start, w = (1 − r)·desat (start at r = 0, a fully saturated
 *  colour; → 1 at r = 1, a grey). Below start everything is on the image. Exposure plays no part (the inverse divides by it
 *  last, and the linear input is unbounded), so neither does it here. The shader's neutralInverse computes the same.
 *  Known limits (a hard clip, taken knowingly; see quadcolour.js neutralInverse): off-image colours of one hue and
 *  saturation all land on this one peak, so they merge, and the peak rises as √r near r = 0, so a saturated colour's first
 *  step off pure (min channel 0 → 1/255) brightens it by about 3 codes. */
export function neutralPeakFor(r) {
  const d = 1 - NEUTRAL.start, w = (1 - r) * NEUTRAL.desat;
  return 1 - (2 * d * d * w) / (2 * d * w + r + Math.sqrt(r * (4 * d * w + r)));
}
/** The JS twin of quadcolour.js neutralInverse: the linear working colour whose PBR Neutral at `exposure` is `lin`.
 *  The rule: a colour off Neutral's image is scaled down, all three channels by one factor, to the brightest colour of its
 *  hue and saturation the curve shows (neutralPeakFor, and never above NEUTRAL.ceil): hue and saturation kept exactly,
 *  brightness given up (at most 1 − start = 24% in luma, for a fully saturated colour at full peak); a colour on the image
 *  is untouched. */
export function neutralInverseJS(lin, exposure = 1) {
  const { start: S, desat: D, toeAt, toeK, toeOff, ceil } = NEUTRAL, d = 1 - S;
  let y = lin.map(clamp01);
  const pk = Math.max(...y), cap = Math.min(ceil, neutralPeakFor(Math.min(...y) / Math.max(pk, 1e-6)));
  y = y.map((v) => v * Math.min(1, cap / Math.max(pk, 1e-6)));   // onto the image: one factor for all three channels
  const np = Math.max(...y);
  if (np >= S) {   // undo the highlight compression: newPeak np → the peak it came from, then the desaturation mix
    const p = (d * d) / (1 - np) - d + S, g = 1 - 1 / (D * (p - np) + 1);
    y = y.map((v) => Math.max(0, ((v - np * g) / (1 - g)) * (p / np)));   // ≥ 0 on the image; max() only absorbs rounding
  }
  // the toe: the darkest channel m came from x with m = x − offset(x); below toeAt offset is x − toeK·x² (so m = toeK·x²), else toeOff
  const m = Math.max(0, Math.min(...y)), x = m < toeK * toeAt * toeAt ? Math.sqrt(m / toeK) : m + toeOff, off = x < toeAt ? x - toeK * x * x : toeOff;
  return y.map((v) => (v + off) / exposure);
}
/** The JS twin of quadcolour.js's linear branch: three's linearToneMapping is exposure, then a clamp. */
export const linearInverseJS = (lin, exposure = 1) => lin.map((v) => clamp01(v) / exposure);
