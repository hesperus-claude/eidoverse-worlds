// quadcolour — the VR panels' colour, delivered as authored.
//
// WebGPURenderer ignores material.toneMapped: tone mapping and the sRGB encode happen in one output pass over the whole
// frame, so panel pixels went through ACES Filmic at the world's exposure and read washed out
// (test/client/xr-quad-colour-probe.mjs). The cure: the quad's output node applies the inverse of the live curve at the
// live exposure, so the output pass lands on the authored value. The curve is the world's (sky.tonemap, render/tonemap.js:
// aces | agx | neutral | linear), chosen per frame by uTonemap, so a quad built under one curve follows a change.
// On top, a VR-only saturation/contrast grade in sRGB space, quads only (never the design tokens or the desktop);
// quadgrade.js holds its JS twin: test/client/quadcolour-test.mjs tests the twin, test/client/xr-quad-colour-probe.mjs
// holds the GPU's output to it.
import * as THREE from 'three';
import { GRADE_DEFAULT, GRADE_RANGE, LUMA, loadGrade, clampTo, storeGrade, ACES_IN_INV, ACES_OUT_INV, ACES_FIT, INV, AGX_EV, AGX_POLY, AGX_BISECT, NEUTRAL } from './quadgrade.js';
import { uTonemap, TONEMAPS } from '../render/tonemap.js';
import { Fn, If, float, vec3, vec4, mat3, texture, uniform, toneMappingExposure, sRGBTransferOETF, sRGBTransferEOTF, dot, mix, clamp, sqrt, max, min, pow, exp2, step, select } from 'three/tsl';

const { A, B, C, D, E } = ACES_FIT;

const uSat = uniform(1), uCon = uniform(1);
export function setGrade(g, persist = true) {
  const cur = loadGrade();
  const next = { saturation: clampTo(Number(g.saturation ?? cur.saturation), GRADE_RANGE.saturation, cur.saturation),
    contrast: clampTo(Number(g.contrast ?? cur.contrast), GRADE_RANGE.contrast, cur.contrast) };
  uSat.value = next.saturation; uCon.value = next.contrast;
  if (persist) storeGrade(next);
  return next;
}
export { GRADE_DEFAULT, GRADE_RANGE };
export const currentGrade = () => ({ saturation: uSat.value, contrast: uCon.value });
setGrade(loadGrade(), false);

// one channel of RRTAndODTFit⁻¹: y = (v² + Av − B)/(Cv² + Dv + E) solved for v ≥ 0
const rrtInv = (y) => {
  const yc = clamp(y, 0, 1);
  const a = yc.mul(C).oneMinus(), b = yc.mul(D).negate().add(A), c = yc.mul(E).add(B);
  return b.negate().add(sqrt(max(b.mul(b).add(a.mul(c).mul(4)), 0))).div(a.mul(2));
};
/** Linear working colour whose ACES Filmic (at the live exposure) is `lin` — the output pass's exact undo. */
export const acesFilmicInverse = Fn(([lin]) => {
  const y = mat3(...ACES_OUT_INV).mul(clamp(lin, 0, 1));
  const v = vec3(rrtInv(y.x), rrtInv(y.y), rrtInv(y.z));
  // not clamped at 0: saturated hues need a negative linear input for ACES's input matrix to land them; the output
  // pass reads a HalfFloat target, which carries it
  return mat3(...ACES_IN_INV).mul(v).mul(0.6).div(toneMappingExposure);
});

/** Linear working colour whose AgX (at the live exposure) is `lin` (quadgrade.js agxInverseJS's twin; the sigmoid bisected).
 *  Exact on the whole sRGB cube: AgX, its matrices read as three means them (quadgrade.js fromCols), reaches every
 *  displayable colour, so there is no off-image case here. */
const agxPoly = (x) => AGX_POLY.reduce((acc, k) => (acc === null ? vec3(k) : acc.mul(x).add(k)), null);
export const agxInverse = Fn(([lin]) => {
  const c = pow(max(mat3(...INV.toSrgb).mul(clamp(lin, 0, 1)), 0), vec3(1 / 2.2));
  const y = clamp(mat3(...INV.outset).mul(c), 0, 1);
  const lo = vec3(0).toVar(), hi = vec3(1).toVar();
  for (let i = 0; i < AGX_BISECT; i++) { const m = lo.add(hi).mul(0.5), s = step(agxPoly(m), y); lo.assign(mix(lo, m, s)); hi.assign(mix(m, hi, s)); }
  const enc = exp2(lo.add(hi).mul(0.5).mul(AGX_EV.max - AGX_EV.min).add(AGX_EV.min));
  return mat3(...INV.toRec).mul(mat3(...INV.inset).mul(enc)).div(toneMappingExposure);
});
/** Linear working colour whose Khronos PBR Neutral (at the live exposure) is `lin` (quadgrade.js neutralInverseJS's twin,
 *  closed form). Exact on Neutral's image; a colour off it (bright and saturated: Neutral mixes highlights toward grey) is
 *  first scaled down, all three channels by one factor, to the brightest colour of its hue and saturation the curve shows
 *  (quadgrade.js neutralPeakFor): hue and saturation kept, brightness given up (at most 24% in luma).
 *  Known limits of this hard clip, taken knowingly (the old behaviour turned every off-image colour near white): every
 *  off-image colour of one hue and saturation shows as the same colour, so the top of a saturated ramp goes flat (#e60000
 *  and #ff0000 both show (226,0,0)) and a bright saturated control's hover/pressed states can merge; and the ceiling's √r
 *  shape at r = 0 gives a 3-step jump where a saturated colour's darkest channel goes 0 → 1 (#ff0000 → 226, #ff0101 → 229).
 *  The real answer is (b), panels drawn after the output transform (see quadMaterial). */
export const neutralInverse = Fn(([lin]) => {
  const S = float(NEUTRAL.start), d = float(1 - NEUTRAL.start);
  const y0 = clamp(lin, 0, 1), pk = max(max(y0.x, max(y0.y, y0.z)), 1e-6), r = min(y0.x, min(y0.y, y0.z)).div(pk);
  const w = r.oneMinus().mul(NEUTRAL.desat), dw2 = d.mul(w).mul(2);
  const cap = min(float(1).sub(d.mul(d).mul(w).mul(2).div(dw2.add(r).add(sqrt(r.mul(dw2.mul(2).add(r)))))), NEUTRAL.ceil);   // neutralPeakFor(r)
  const y = y0.mul(min(cap.div(pk), 1)).toVar();   // onto the image: one factor for all three channels
  const np = max(y.x, max(y.y, y.z));
  If(np.greaterThanEqual(S), () => {   // undo the highlight compression, then its desaturation mix
    const p = d.mul(d).div(np.oneMinus()).sub(d).add(S), g = float(1).sub(float(1).div(p.sub(np).mul(NEUTRAL.desat).add(1)));
    y.assign(max(y.sub(np.mul(g)).div(g.oneMinus()).mul(p.div(np)), 0));   // ≥ 0 on the image; max() only absorbs rounding
  });
  const m = max(min(y.x, min(y.y, y.z)), 0);
  const x = select(m.lessThan(NEUTRAL.toeK * NEUTRAL.toeAt * NEUTRAL.toeAt), sqrt(m.div(NEUTRAL.toeK)), m.add(NEUTRAL.toeOff));
  return y.add(select(x.lessThan(NEUTRAL.toeAt), x.sub(x.mul(x).mul(NEUTRAL.toeK)), float(NEUTRAL.toeOff))).div(toneMappingExposure);
});
/** The undo of whichever curve the world shows (render/tonemap.js uTonemap), chosen per frame: a uniform branch, so a
 *  change of curve recompiles nothing here. linear (exposure, then a clamp) is the fall-through. */
const CURVE_AT = Object.fromEntries(TONEMAPS.map((k, i) => [k, i]));
export const tonemapInverse = Fn(([lin]) => {
  const out = vec3(clamp(lin, 0, 1)).div(toneMappingExposure).toVar();
  If(uTonemap.equal(CURVE_AT.aces), () => { out.assign(acesFilmicInverse(lin)); })
    .ElseIf(uTonemap.equal(CURVE_AT.agx), () => { out.assign(agxInverse(lin)); })
    .ElseIf(uTonemap.equal(CURVE_AT.neutral), () => { out.assign(neutralInverse(lin)); });
  return out;
});

/** Swap a textured quad's material (an HTMLMesh's, or a head-locked canvas plate's) for one whose output is the
 *  authored (graded) colour after the renderer's output pass. Blending and depth settings carry over.
 *  A stopgap: the per-fragment inverse is for want of (b) "draw panels after the output transform, in their own pass".
 *  That is possible on the desktop through the post pipeline, but not in a headset today: XR draws straight to the
 *  session's framebuffer with the curve applied inline, and there is no post pipeline in XR, so the inverse stays (with
 *  its off-image cases: Neutral's bright saturated colours come back darker, hue kept) until XR has a post path. */
export function quadMaterial(mesh, _renderer) {   // the renderer is no longer read: the curve to undo is uTonemap's, live
  const old = mesh.material, map = old.map;
  const m = new THREE.MeshBasicNodeMaterial({ map, transparent: old.transparent, alphaTest: old.alphaTest, side: old.side,
    depthTest: old.depthTest, depthWrite: old.depthWrite, fog: false });
  const t = texture(map);   // decoded to linear by the texture's own colorSpace (sRGB)
  const s = sRGBTransferOETF(t.rgb);
  const y = dot(s, vec3(...LUMA));
  const graded = clamp(mix(vec3(y), s, uSat).sub(0.5).mul(uCon).add(0.5), 0, 1);
  const lin = sRGBTransferEOTF(graded);
  // outputNode, not colorNode: NodeMaterial clamps its lit result at 0 and the inverse needs negatives. The map stays
  // the diffuse colour, so alphaTest still cuts the rounded corners from the texture's alpha.
  m.outputNode = vec4(tonemapInverse(lin), t.a);
  m.toneMapped = false;   // honoured by the classic WebGLRenderer only; kept so the intent reads the same
  mesh.material = m; old.dispose();
  // HTMLMesh.dispose() disposes `material` from its closure (the old one) — keep ours from leaking
  const dispose = mesh.dispose; if (dispose) mesh.dispose = function () { m.dispose(); return dispose.call(this); };
  return m;
}
