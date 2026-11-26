// tonemap-forward — three's OWN forward tone curves (r186 src/nodes/display/ToneMappingFunctions.js), transcribed to JS
// with every constant READ OUT OF that source, never typed here, so a three bump that changes a curve changes these.
// Test-side only: quadcolour-test round-trips the product's inverse twins (client/lib/xr/quadgrade.js) through these,
// and xr-quad-colour-probe uses them to predict what the GPU's output pass must paint.
// The transcription's SHAPE (the order of the steps) is copied by hand from that file; its numbers are not.
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../../client/node_modules/three/src/nodes/display/ToneMappingFunctions.js', import.meta.url), 'utf8');
const nums = (s) => (s.replace(/-\s+/g, '-').match(/-?\d*\.\d+/g) ?? []).map(Number);
// `const NAME = /*@__PURE__*/ mat3( vec3( … ), … );` or `const NAME = mat3( … );`: nine numbers in three's listing order
const mat = (name) => nums(src.match(new RegExp(`const ${name} = [^m]*mat3\\(([^;]*)\\);`))?.[1] ?? '');
export const THREE_AGX = Object.freeze({
  R2S: mat('LINEAR_REC2020_TO_LINEAR_SRGB'), S2R: mat('LINEAR_SRGB_TO_LINEAR_REC2020'),
  INSET: mat('AgXInsetMatrix'), OUTSET: mat('AgXOutsetMatrix'),
  // the sigmoid's magnitudes, x⁶ … x⁰ (its signs live in .sub / .add, so they are read as magnitudes)
  POLY: nums(src.match(/const agxDefaultContrastApprox = [\s\S]*?\} \);/)?.[0] ?? ''),
  EV: [...nums(src.match(/AgxMinEv = float\(([^)]*)\)/)?.[1] ?? ''), ...nums(src.match(/AgxMaxEv = float\(([^)]*)\)/)?.[1] ?? '')],
});
// neutralToneMapping's literals in source order: 0.8, -0.04 (StartCompression = float( 0.8 - 0.04 ), read signed), 0.15 (Desaturation),
// then the toe's 0.08, 6.25, 0.04
export const THREE_NEUTRAL = Object.freeze(nums(src.match(/const neutralToneMapping = [\s\S]*?\} \)\.setLayout/)?.[0] ?? ''));

// as TSL's mat3(9 scalars) * vec3 is read by the twins (quadgrade.js mul3): the same convention on both sides
const mul3 = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);
const c01 = (x) => Math.min(1, Math.max(0, x));
const SIGN = [1, -1, 1, -1, 1, 1, -1];   // agxDefaultContrastApprox: 15.5x⁶ − 40.14x⁵ + 31.96x⁴ − 6.868x³ + 0.4298x² + 0.1191x − 0.00232
export const AGX_POLY_SIGNED = Object.freeze(THREE_AGX.POLY.map((k, i) => SIGN[i] * k));
const poly = (x) => AGX_POLY_SIGNED.reduce((s, k) => s * x + k, 0);

/** three r186 agxToneMapping(color, exposure). */
export function agxForward(c, e) {
  const { R2S, S2R, INSET, OUTSET, EV } = THREE_AGX;
  let t = mul3(INSET, mul3(S2R, c.map((x) => x * e))).map((x) => c01((Math.log2(Math.max(x, 1e-10)) - EV[0]) / (EV[1] - EV[0])));
  t = mul3(OUTSET, t.map(poly)).map((x) => Math.max(0, x) ** 2.2);
  return mul3(R2S, t).map(c01);
}
/** three r186 neutralToneMapping(color, exposure) (Khronos PBR Neutral). */
export function neutralForward(c0, e) {
  const [a, b, desat, toeAt, toeK, toeOff] = THREE_NEUTRAL, S = a + b;   // 0.8 + (−0.04)
  let c = c0.map((x) => x * e);
  const x = Math.min(...c), off = x < toeAt ? x - toeK * x * x : toeOff;
  c = c.map((v) => v - off);
  const peak = Math.max(...c);
  if (peak < S) return c;
  const d = 1 - S, np = 1 - (d * d) / (peak + d - S);
  c = c.map((v) => (v * np) / peak);
  const g = 1 - 1 / (desat * (peak - np) + 1);
  return c.map((v) => v + (np - v) * g);
}
/** three r186 linearToneMapping: exposure, then a clamp. */
export const linearForward = (c, e) => c.map((x) => c01(x * e));

export const eotf = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4);
export const oetf = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
