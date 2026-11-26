// The VR panel grade as pure numbers (client/lib/xr/quadgrade.js): gradeSRGB is the JS twin of the shader grade in
// quadcolour.js, and test/client/xr-quad-colour-probe.mjs holds the GPU to it at the default and both extremes. This file
// holds the twin to what the grade must mean. Also the persisted choice: garbage and out-of-range come back sane.
// Then the inverse ACES: acesFilmicInverseJS reads the SAME constant arrays the shader does, and is round-tripped
// through three's OWN forward (its constants read out of the three the client serves), so a typo'd constant, a
// swapped matrix or a three bump that changes the matrices or fit constants turns this red (the exposure /0.6 and the formula's shape are copied by hand).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/quadcolour-test.mjs
import { gradeSRGB, GRADE_DEFAULT, GRADE_RANGE, loadGrade, LUMA, acesFilmicInverseJS } from '../../client/lib/xr/quadgrade.js';
import * as QG from '../../client/lib/xr/quadgrade.js';   // the other curves' twins (sky.tonemap), read by name so a missing one fails its rows, not the file
import { THREE_AGX, THREE_NEUTRAL, AGX_POLY_SIGNED, agxForward, neutralForward, linearForward, eotf as EOTF, oetf as OETF } from './tonemap-forward.mjs';
import { readFileSync } from 'node:fs';
import { suite } from "../gate/suite.ts";
const S = suite("quadcolour");
const check = (name, ok, note) => S.check(name, ok, note);
const near = (a, b, e = 1e-9) => a.every((v, i) => Math.abs(v - b[i]) <= e);
const luma = (c) => c[0] * LUMA[0] + c[1] * LUMA[1] + c[2] * LUMA[2];
const brand = [0x8f / 255, 0xe8 / 255, 0xc8 / 255], panel = [5 / 255, 20 / 255, 20 / 255], grey = [0.3, 0.3, 0.3];
const spread = (c) => Math.max(...c) - Math.min(...c);

console.log('VR PANEL GRADE (pure)');
check('neutral (1, 1) is the identity', [brand, panel, grey, [0, 0, 0], [1, 1, 1]].every((c) => near(gradeSRGB(c, { saturation: 1, contrast: 1 }), c)));
check('saturation leaves a grey grey', near(gradeSRGB(grey, { saturation: 1.8, contrast: 1 }), grey));
check('saturation keeps luma (unclamped colour)', Math.abs(luma(gradeSRGB(brand, { saturation: 1.15, contrast: 1 })) - luma(brand)) < 1e-9);
check('saturation > 1 spreads the channels, < 1 closes them', spread(gradeSRGB(brand, { saturation: 1.5 })) > spread(brand) && spread(gradeSRGB(brand, { saturation: 0.5 })) < spread(brand));
check('saturation 0 is its luma grey', (() => { const g = gradeSRGB(brand, { saturation: 0 }); return near(g, [luma(brand), luma(brand), luma(brand)]); })());
check('contrast pivots on mid-grey', near(gradeSRGB([0.5, 0.5, 0.5], { contrast: 1.7 }), [0.5, 0.5, 0.5]));
check('contrast > 1 pushes dark down and light up', (() => { const d = gradeSRGB(panel, { contrast: 1.2 }), l = gradeSRGB([0.8, 0.8, 0.8], { contrast: 1.2 }); return d[1] < panel[1] && l[0] > 0.8; })());
check('the result stays in [0, 1] at the extremes', [brand, panel, [1, 0, 0], [0, 0, 1]].every((c) => gradeSRGB(c, { saturation: GRADE_RANGE.saturation[1], contrast: GRADE_RANGE.contrast[1] }).every((v) => v >= 0 && v <= 1)));
check('the default is a MODEST boost (both > 1, both ≤ 1.2)', GRADE_DEFAULT.saturation > 1 && GRADE_DEFAULT.saturation <= 1.2 && GRADE_DEFAULT.contrast > 1 && GRADE_DEFAULT.contrast <= 1.2, JSON.stringify(GRADE_DEFAULT));
check('the default sits inside its ranges', GRADE_DEFAULT.saturation >= GRADE_RANGE.saturation[0] && GRADE_DEFAULT.saturation <= GRADE_RANGE.saturation[1] && GRADE_DEFAULT.contrast >= GRADE_RANGE.contrast[0] && GRADE_DEFAULT.contrast <= GRADE_RANGE.contrast[1]);

// the persisted choice
const store = new Map();
globalThis.localStorage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, String(v)), removeItem: (k) => store.delete(k) };
check('nothing stored → the default', near(Object.values(loadGrade()), [GRADE_DEFAULT.saturation, GRADE_DEFAULT.contrast]));
store.set('ew-xr-panel-grade', '{not json'); check('garbage → the default', near(Object.values(loadGrade()), [GRADE_DEFAULT.saturation, GRADE_DEFAULT.contrast]));
store.set('ew-xr-panel-grade', JSON.stringify({ saturation: 99, contrast: -3 })); check('out of range → clamped to the range', near(Object.values(loadGrade()), [GRADE_RANGE.saturation[1], GRADE_RANGE.contrast[0]]));
store.set('ew-xr-panel-grade', JSON.stringify({ saturation: 1.4, contrast: 'x' })); check('a good key kept, a bad one defaulted', near(Object.values(loadGrade()), [1.4, GRADE_DEFAULT.contrast]));


console.log('INVERSE ACES (the JS twin against three\'s forward)');
{
  const src = readFileSync(new URL('../../client/node_modules/three/src/nodes/display/ToneMappingFunctions.js', import.meta.url), 'utf8');
  const nums = (s) => s.replace(/-\s+/g, '-').match(/-?\d*\.\d+/g).map(Number);
  const mat = (name) => nums(src.match(new RegExp(`const ${name} = mat3\\(([^)]*)\\)`))?.[1] ?? '');
  const IN = mat('ACESInputMat'), OUT = mat('ACESOutputMat');
  const fit = nums(src.match(/const RRTAndODTFit = [\s\S]*?return a\.div\( b \);/)?.[0] ?? '');   // [0.0245786, 0.000090537, 0.4329510, 0.983729, 0.238081]
  check('three\'s forward ACES read from source (two 3×3 matrices, five fit constants)', IN.length === 9 && OUT.length === 9 && fit.length === 5, JSON.stringify({ IN, OUT, fit }));
  const mul3 = (m, v) => [0, 1, 2].map((i) => m[i * 3] * v[0] + m[i * 3 + 1] * v[1] + m[i * 3 + 2] * v[2]);   // TSL mat3(9 scalars), as the shader reads it
  const rrt = (v) => (v * (v + fit[0]) - fit[1]) / (v * (v + fit[2]) * fit[3] + fit[4]);
  const forward = (c, e) => mul3(OUT, mul3(IN, c.map((x) => x * e / 0.6)).map(rrt)).map((x) => Math.min(1, Math.max(0, x)));
  const eotf = (s) => (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4), oetf = (l) => (l <= 0.0031308 ? l * 12.92 : 1.055 * l ** (1 / 2.4) - 0.055);
  const worst = {};
  for (const e of [0.5, 0.78, 1, 1.3]) {   // the house exposure is 0.78; the others bracket it
    let w = 0, at = null;
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {   // 52³, white included
      const back = forward(acesFilmicInverseJS([r, g, b].map((x) => eotf(x / 255)), e), e).map((x) => oetf(x) * 255);
      const err = Math.max(Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b));
      if (err > w) { w = err; at = [r, g, b]; }
    }
    worst[e] = { err: +w.toFixed(4), at };
  }
  check('forward ∘ inverse is the identity on the sRGB grid at every exposure (worst < 0.5 of an 8-bit step)', Object.values(worst).every((x) => x.err < 0.5), JSON.stringify(worst));
  const white = forward(acesFilmicInverseJS([1, 1, 1], 0.78), 0.78);
  check('white comes back white (within 1e-4, the constants\' 8 places)', white.every((v) => v > 1 - 1e-4), JSON.stringify(white));
  check('a saturated hue needs a negative linear input (why the shader does not clamp at 0)', acesFilmicInverseJS([eotf(0x8f / 255), eotf(0xe8 / 255), eotf(0xc8 / 255)], 0.78)[0] < 0);
  // the shader reads the same arrays, no literals of its own: test/client/one-binding-test.ts
}

console.log('INVERSE AGX, NEUTRAL, LINEAR (the world\'s other display transforms, sky.tonemap: the twins against three\'s forward)');
{
  // three's forward, its numbers read out of the three the client serves (tonemap-forward.mjs)
  const same = (a, b) => Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => Math.abs(v - b[i]) < 1e-12);
  check('three\'s AgX read from source (four 3×3 matrices, a 7-term sigmoid, the EV range) and Neutral\'s six literals',
    [THREE_AGX.R2S, THREE_AGX.S2R, THREE_AGX.INSET, THREE_AGX.OUTSET].every((m) => m.length === 9) && THREE_AGX.POLY.length === 7 && THREE_AGX.EV.length === 2 && THREE_NEUTRAL.length === 6,
    JSON.stringify({ THREE_AGX, THREE_NEUTRAL }));
  check('our AgX constants are three\'s (both gamut matrices, inset, outset, EV range, the signed sigmoid)',
    same(QG.REC2020_TO_SRGB, THREE_AGX.R2S) && same(QG.SRGB_TO_REC2020, THREE_AGX.S2R) && same(QG.AGX_INSET, THREE_AGX.INSET) && same(QG.AGX_OUTSET, THREE_AGX.OUTSET)
      && same([QG.AGX_EV?.min, QG.AGX_EV?.max], THREE_AGX.EV) && same(QG.AGX_POLY, AGX_POLY_SIGNED), JSON.stringify({ EV: QG.AGX_EV, POLY: QG.AGX_POLY }));
  check('our Neutral constants are three\'s (start 0.8 − 0.04, desaturation 0.15, toe 0.08 / 6.25 / 0.04)',
    Math.abs((QG.NEUTRAL?.start ?? NaN) - (THREE_NEUTRAL[0] + THREE_NEUTRAL[1])) < 1e-12 && QG.NEUTRAL?.desat === THREE_NEUTRAL[2]
      && QG.NEUTRAL?.toeAt === THREE_NEUTRAL[3] && QG.NEUTRAL?.toeK === THREE_NEUTRAL[4] && QG.NEUTRAL?.toeOff === THREE_NEUTRAL[5], JSON.stringify(QG.NEUTRAL));
  const twins = { agx: [agxForward, QG.agxInverseJS], neutral: [neutralForward, QG.neutralInverseJS], linear: [linearForward, QG.linearInverseJS] };
  check('the three twins exist (agxInverseJS, neutralInverseJS, linearInverseJS)', Object.values(twins).every(([, inv]) => typeof inv === 'function'));
  const EXPOSURES = [0.5, 0.78, 1, 1.3];   // the house exposure is 0.78; the others bracket it, as the ACES rows do
  // Exact where it can be: on what each curve PRODUCES (the forward of a linear grid, 1/64 … 16, across hues),
  // forward ∘ inverse ∘ forward = forward. Both AgX and Neutral desaturate highlights, so a bright, saturated sRGB colour is
  // OFF their image: no input makes it, and the inverse returns the nearest reachable one; that part is reported, and held
  // only to a floor (the next rows), not to exactness.
  const onImage = (fwd, inv) => { let w = 0, at = null; const L = []; for (let k = -6; k <= 4; k += 0.5) L.push(2 ** k);
    for (const e of EXPOSURES) for (const r of L) for (const g of L) for (const b of [L[0], L[6], L[12], L[18]]) {
      const y = fwd([r, g, b], e), back = fwd(inv(y, e), e);
      const err = Math.max(...y.map((v, i) => Math.abs(OETF(Math.max(0, v)) - OETF(Math.max(0, back[i]))) * 255));
      if (err > w) { w = err; at = { rgb: [r, g, b], e }; } }
    return { worst: +w.toFixed(4), at }; };
  const sweep = (fwd, inv) => { const out = {}; for (const e of EXPOSURES) { const errs = [];
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {   // 52³, white included
      const back = fwd(inv([r, g, b].map((x) => EOTF(x / 255)), e), e).map((x) => OETF(Math.min(1, Math.max(0, x))) * 255);
      errs.push(Math.max(Math.abs(back[0] - r), Math.abs(back[1] - g), Math.abs(back[2] - b))); }
    errs.sort((a, b) => a - b);
    out[e] = { worst: +errs.at(-1).toFixed(2), p50: +errs[errs.length >> 1].toFixed(3), within1: +(errs.filter((x) => x < 1).length / errs.length).toFixed(4) }; }
    return out; };
  const R = {};
  for (const [k, [fwd, inv]] of Object.entries(twins)) {
    if (typeof inv !== 'function') { check(`${k}: forward ∘ inverse on the curve's image`, false, 'no twin'); continue; }
    const img = onImage(fwd, inv), grid = sweep(fwd, inv); R[k] = { img, grid };
    check(`${k}: exact on the curve's own image (forward ∘ inverse ∘ forward = forward: worst < 0.5 of an 8-bit step, exposures ${EXPOSURES.join('/')})`, img.worst < 0.5, JSON.stringify(img));
  }
  // the floors the lab measured on 11-02 (≥ 85% within one step), and Linear, whose image is all of [0, 1]: exact
  check('linear: the whole sRGB grid comes back exact (worst < 0.5 of a step: its image is all of [0, 1])', R.linear && Object.values(R.linear.grid).every((x) => x.worst < 0.5), JSON.stringify(R.linear?.grid));
  check('neutral: ≥ 85% of the whole sRGB grid comes back within one 8-bit step, at every exposure', R.neutral && Object.values(R.neutral.grid).every((x) => x.within1 >= 0.85), JSON.stringify(R.neutral?.grid));
  check('agx: ≥ 85% of the whole sRGB grid comes back within one 8-bit step, at every exposure', R.agx && Object.values(R.agx.grid).every((x) => x.within1 >= 0.85), JSON.stringify(R.agx?.grid));
  check('neutral: the panel\'s greys and darks (r = g = b, and every colour ≤ 0x80) come back within one step',
    typeof QG.neutralInverseJS === 'function' && [0, 0x10, 0x40, 0x80, 0xc0, 0xff].every((v) => { const c = [v, v, v].map((x) => EOTF(x / 255)); const back = neutralForward(QG.neutralInverseJS(c, 0.78), 0.78).map((x) => OETF(Math.min(1, x)) * 255); return back.every((x) => Math.abs(x - v) < 1); })
      && [[5, 20, 20], [0x20, 0x40, 0x80], [0x80, 0x10, 0x10]].every((rgb) => { const back = neutralForward(QG.neutralInverseJS(rgb.map((x) => EOTF(x / 255)), 0.78), 0.78).map((x) => OETF(Math.min(1, x)) * 255); return back.every((x, i) => Math.abs(x - rgb[i]) < 1); }));
  console.log('        sRGB grid (not exact off the curve\'s image, by construction):', JSON.stringify(Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.grid]))));
  // the shader reads the same data, no literals of its own: test/client/one-binding-test.ts
}

S.done();
