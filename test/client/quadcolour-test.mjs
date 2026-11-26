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
  const greys = [0.01, 0.18, 1, 4, 64].map((k) => agxForward([k, k, k], 1));
  check('three\'s AgX, as transcribed, keeps a grey grey (its matrices are vec3 COLUMNS: read as rows, a grey turns magenta)',
    greys.every((g) => Math.max(...g) - Math.min(...g) < 2e-3), JSON.stringify(greys.map((g) => g.map((v) => +v.toFixed(4)))));
  check('our AgX constants are three\'s, as three means them (rows of the matrices three lists as columns; EV range, the signed sigmoid)',
    same(QG.REC2020_TO_SRGB, THREE_AGX.R2S) && same(QG.SRGB_TO_REC2020, THREE_AGX.S2R) && same(QG.AGX_INSET, THREE_AGX.INSET) && same(QG.AGX_OUTSET, THREE_AGX.OUTSET)
      && same([QG.AGX_EV?.min, QG.AGX_EV?.max], THREE_AGX.EV) && same(QG.AGX_POLY, AGX_POLY_SIGNED), JSON.stringify({ EV: QG.AGX_EV, POLY: QG.AGX_POLY }));
  check('our Neutral constants are three\'s (start 0.8 − 0.04, desaturation 0.15, toe 0.08 / 6.25 / 0.04)',
    Math.abs((QG.NEUTRAL?.start ?? NaN) - (THREE_NEUTRAL[0] + THREE_NEUTRAL[1])) < 1e-12 && QG.NEUTRAL?.desat === THREE_NEUTRAL[2]
      && QG.NEUTRAL?.toeAt === THREE_NEUTRAL[3] && QG.NEUTRAL?.toeK === THREE_NEUTRAL[4] && QG.NEUTRAL?.toeOff === THREE_NEUTRAL[5], JSON.stringify(QG.NEUTRAL));
  const twins = { agx: [agxForward, QG.agxInverseJS], neutral: [neutralForward, QG.neutralInverseJS], linear: [linearForward, QG.linearInverseJS] };
  check('the three twins exist (agxInverseJS, neutralInverseJS, linearInverseJS)', Object.values(twins).every(([, inv]) => typeof inv === 'function'));
  const EXPOSURES = [0.5, 0.78, 1, 1.3];   // the house exposure is 0.78; the others bracket it, as the ACES rows do
  // Exact where it can be: on what each curve PRODUCES (the forward of a linear grid, 1/64 … 16, across hues),
  // forward ∘ inverse ∘ forward = forward. Neutral desaturates highlights, so a bright, saturated sRGB colour is OFF its
  // image: no input makes it, and its inverse scales the colour down onto the image first (the NEUTRAL OFF ITS IMAGE rows
  // below hold that exactly); so on the whole grid Neutral is held only to a floor (the next rows). AgX, read the right way
  // round, reaches the whole sRGB cube, and is held to exactness there.
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
  // Neutral: the floor the lab measured on 11-02 (≥ 85% within one step); Linear, whose image is all of [0, 1]: exact
  check('linear: the whole sRGB grid comes back exact (worst < 0.5 of a step: its image is all of [0, 1])', R.linear && Object.values(R.linear.grid).every((x) => x.worst < 0.5), JSON.stringify(R.linear?.grid));
  check('neutral: ≥ 85% of the whole sRGB grid comes back within one 8-bit step, at every exposure', R.neutral && Object.values(R.neutral.grid).every((x) => x.within1 >= 0.85), JSON.stringify(R.neutral?.grid));
  // AgX, read the right way round, reaches the whole sRGB cube (its sigmoid spans [0, 1] and nothing in it mixes toward
  // white), so its undo is exact everywhere, not only on a floor: held to that
  check('agx: the whole sRGB grid comes back exact (worst < 0.5 of a step), at every exposure', R.agx && Object.values(R.agx.grid).every((x) => x.worst < 0.5), JSON.stringify(R.agx?.grid));
  check('neutral: the panel\'s greys and darks (r = g = b, and every colour ≤ 0x80) come back within one step',
    typeof QG.neutralInverseJS === 'function' && [0, 0x10, 0x40, 0x80, 0xc0, 0xff].every((v) => { const c = [v, v, v].map((x) => EOTF(x / 255)); const back = neutralForward(QG.neutralInverseJS(c, 0.78), 0.78).map((x) => OETF(Math.min(1, x)) * 255); return back.every((x) => Math.abs(x - v) < 1); })
      && [[5, 20, 20], [0x20, 0x40, 0x80], [0x80, 0x10, 0x10]].every((rgb) => { const back = neutralForward(QG.neutralInverseJS(rgb.map((x) => EOTF(x / 255)), 0.78), 0.78).map((x) => OETF(Math.min(1, x)) * 255); return back.every((x, i) => Math.abs(x - rgb[i]) < 1); }));
  console.log('        sRGB grid (not exact off the curve\'s image, by construction):', JSON.stringify(Object.fromEntries(Object.entries(R).map(([k, v]) => [k, v.grid]))));
  // the shader reads the same data, no literals of its own: test/client/one-binding-test.ts
}

console.log('NEUTRAL OFF ITS IMAGE (a warning red stays red in any world look: hue and saturation kept, brightness given up)');
{
  // Khronos PBR Neutral maps a highlight of peak p to peak n(p) < 1 and mixes it toward grey by g(p), so its output's
  // min/max ratio is at least g at that peak: a bright saturated authored colour is off its image. The inverse brings it
  // back onto the image by scaling all three channels by one factor (hue and saturation exact, brightness given up).
  // Hue and saturation are read on the LINEAR display colour (HSV's hue and 1 − min/max): a uniform scale keeps both exactly,
  // a mix toward grey keeps the hue but not the saturation, a per-channel clamp moves the hue. Tolerances: hue 0.1° (one
  // 8-bit step moves a full-chroma hue by 60°/255 ≈ 0.24°), saturation 1e-4, brightness (Rec.709 luma) 1e-9 relative.
  const inv = QG.neutralInverseJS, ok = typeof inv === 'function';
  const EXPOSURES = [0.5, 0.78, 1, 1.3];
  const hue = (c) => { const M = Math.max(...c), m = Math.min(...c), C = M - m; if (C <= 0) return NaN; const [r, g, b] = c;
    const h = M === r ? ((g - b) / C) % 6 : M === g ? (b - r) / C + 2 : (r - g) / C + 4; return (h * 60 + 360) % 360; };
  const dHue = (a, b) => { const d = Math.abs(hue(a) - hue(b)) % 360; return Math.min(d, 360 - d); };
  const sat = (c) => (Math.max(...c) > 0 ? 1 - Math.min(...c) / Math.max(...c) : 0);
  const lin = (hex) => [0, 2, 4].map((i) => EOTF(parseInt(hex.slice(i, i + 2), 16) / 255));
  const round = (c, e) => (ok ? neutralForward(inv(c, e), e) : c.map(() => NaN));
  const START = THREE_NEUTRAL[0] + THREE_NEUTRAL[1];   // three's StartCompression: a fully saturated colour's ceiling
  // The ceiling for a given saturation, from three's FORWARD alone (not the product's formula): a pure-red input keeps its
  // min at 0 through the toe, so its output (n, n·g, n·g) traces the curve's desaturation g against its output peak n;
  // the brightest peak a colour of min/max ratio r can show is the n at which g reaches r (bisected on the input peak).
  const ceilingFor = (r) => { let lo = START, hi = 1e6; for (let i = 0; i < 200; i++) { const m = Math.sqrt(lo * hi), y = neutralForward([m, 0, 0], 1);
    if (y[1] / y[0] <= r) lo = m; else hi = m; } return neutralForward([lo, 0, 0], 1)[0]; };
  const COLS = ['ff0000', '0000ff', 'ffff00', 'ff2040', '2040ff', 'ffd000'];
  const rows = COLS.flatMap((hex) => EXPOSURES.map((e) => { const a = lin(hex), b = round(a, e);
    return { hex, e, a, b, dh: dHue(a, b), ds: Math.abs(sat(a) - sat(b)), k: luma(b) / luma(a), peak: Math.max(...b), ceil: Math.min(Math.max(...a), ceilingFor(Math.min(...a) / Math.max(...a))) }; }));
  const show = (f) => JSON.stringify(rows.filter((x) => x.e === 0.78).map((x) => ({ [x.hex]: f(x) })));
  check('neutral: pure red, blue, yellow and #ff2040 #2040ff #ffd000 keep their hue (within 0.1°), at exposures 0.5/0.78/1/1.3',
    rows.every((x) => x.dh <= 0.1), show((x) => +x.dh.toFixed(4)));
  check('neutral: … and their saturation (1 − min/max of the linear colour, within 1e-4): not desaturated toward white',
    rows.every((x) => x.ds <= 1e-4), show((x) => [+sat(x.a).toFixed(4), +sat(x.b).toFixed(4)]));
  check(`neutral: … never brighter than authored, and at most ${((1 - START) * 100).toFixed(0)}% darker (luma ≥ start × authored: a fully saturated colour's ceiling)`,
    rows.every((x) => x.k <= 1 + 1e-9 && x.k >= START - 1e-9), show((x) => +x.k.toFixed(4)));
  // white and a near-white tint too: there the ceiling is the inverse's own cap (0.9999, NEUTRAL.ceil: the curve's peak
  // only approaches 1), typed here so a cap lowered in the product (0.995 leaves white at 254.4, inside the greys row's one
  // step) is caught
  const CAP = 0.9999, PALE = ['ffffff', 'fff0f0'].map((hex) => { const a = lin(hex), b = round(a, 0.78);
    return { hex, e: 0.78, peak: Math.max(...b), ceil: Math.min(Math.max(...a), CAP, ceilingFor(Math.min(...a) / Math.max(...a))) }; });
  check('neutral: … and no darker than they have to be (their peak is the brightest Neutral shows at their saturation, read off three\'s forward, and never above the 0.9999 cap; white and #fff0f0 too; within 1e-5)',
    [...rows, ...PALE].every((x) => Math.abs(x.peak - x.ceil) <= 1e-5), JSON.stringify([...rows, ...PALE].filter((x) => x.e === 0.78).map((x) => ({ [x.hex]: [+x.peak.toFixed(6), +x.ceil.toFixed(6)] }))));
  check('neutral: the brightness given up does not depend on the exposure (the same colour comes back at 0.5, 0.78, 1 and 1.3)',
    COLS.every((hex) => rows.filter((x) => x.hex === hex).every((x, _, all) => near(x.b, all[0].b, 1e-6))));
  // the whole sRGB grid: no hue moved, no saturation lost, never brighter; report the share the projection scaled
  const grid = {};
  for (const e of EXPOSURES) { let n = 0, hueOff = 0, satOff = 0, brighter = 0, dimmed = 0, worstH = 0, worstS = 0;
    for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {
      const a = [r, g, b].map((x) => EOTF(x / 255)), back = round(a, e); n++;
      const ds = Math.abs(sat(a) - sat(back)), dh = r === g && g === b ? 0 : dHue(a, back);
      if (!(dh <= 0.1)) hueOff++; if (!(ds <= 1e-4)) satOff++; if (!(luma(back) <= luma(a) * (1 + 1e-9) + 1e-12)) brighter++; if (luma(back) < luma(a) * (1 - 1e-6)) dimmed++;
      worstH = Math.max(worstH, dh || 0); worstS = Math.max(worstS, ds || 0); }
    grid[e] = { hueOff: +(hueOff / n).toFixed(4), satOff: +(satOff / n).toFixed(4), brighter, dimmed: +(dimmed / n).toFixed(4), worstHue: +worstH.toFixed(3), worstSat: +worstS.toFixed(4) }; }
  check('neutral: across the whole sRGB grid (52³) no colour comes back with its hue moved more than 0.1°, at every exposure',
    ok && Object.values(grid).every((x) => x.hueOff === 0), JSON.stringify(grid));
  check('neutral: … nor its saturation moved more than 1e-4, nor brighter than authored', ok && Object.values(grid).every((x) => x.satOff === 0 && x.brighter === 0));
  // The cost, pinned (the numbers the PR states): the share of the 52³ grid the projection darkens, at a neutral grade and
  // under the default VR panel grade (gradeSRGB runs before the inverse, and its boost pushes more colours off the image):
  // darkened at all (luma < 1 − 1e-6 of authored), by more than 10%, and by the full 24% (luma ≤ start + 1e-6).
  const cost = (G) => { let n = 0, dim = 0, big = 0, full = 0; for (let r = 0; r <= 255; r += 5) for (let g = 0; g <= 255; g += 5) for (let b = 0; b <= 255; b += 5) {
    n++; const a = gradeSRGB([r, g, b].map((x) => x / 255), G).map(EOTF), la = luma(a); if (!la) continue; const k = luma(round(a, 0.78)) / la;
    if (k < 1 - 1e-6) dim++; if (k < 0.9) big++; if (k <= START + 1e-6) full++; }
    return [dim, big, full].map((x) => +(100 * x / n).toFixed(2)); };
  const costs = { neutralGrade: cost({ saturation: 1, contrast: 1 }), defaultGrade: cost(GRADE_DEFAULT) };
  check('neutral: the cost is as stated: darkened / > 10% / the full 24%, % of the 52³ grid: 13.00 / 3.82 / 0.22 at a neutral grade, 34.92 / 17.38 / 5.60 under the default VR grade',
    ok && near(costs.neutralGrade, [13.00, 3.82, 0.22], 1e-9) && near(costs.defaultGrade, [34.92, 17.38, 5.60], 1e-9), JSON.stringify(costs));
}

S.done();
