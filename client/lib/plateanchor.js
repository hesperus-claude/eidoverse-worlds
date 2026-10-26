// plateanchor — WHERE a nameplate hangs, following posture. Pure (tools/plateanchor-test.ts); avatar.js calls it per frame.
//
// The crown is measured ONCE at rest; the plate hangs over the LIVE HIPS at the rest hips→crown height (BasisVR's
// way; tracking the live head reads as broken); the head term wins only when the head rises above that.
// Lying blends over the head only when the head is low AND the torso has gone over: sitting lowers the head too.
// Y is smoothed (critically damped, a small dead zone); X/Z aren't (sideways trail reads as lag).
// Standing is rigid (STAND_SLOTS), so a jump clip can't swing it; the chase runs only on a posture change.
// Why this shape: docs/research/nameplates.md.

export const EYE_K = 1.35;        // crown = eye + 1.35·(eye − head bone)            (Basis)
export const NO_EYE_K = 0.45;     // no eyes: crown = head + 0.45·(head − hips)       (Basis)
export const BOUNDS_CAP_K = 1.8;  // mesh bounds may raise the crown to head + 1.8·(that span), no further (Basis):
                                  // hair and hats count, wings and a crown of tentacles don't launch the plate
export const GAP_K = 0.05, GAP_MIN = 0.03, GAP_MAX = 0.15;   // gap over the crown: 5% of height, 3–15 cm (Basis)
export const LIE_START = 0.5, LIE_FULL = 0.3;   // head height above feet, as a fraction of rest: blend band
export const TORSO_START = 0.7, TORSO_FULL = 0.5;   // head height over the hips, as a fraction of rest: blend band
export const TAU = 0.12;          // s — Y smoothing time constant (tuned by eye; research says 0.1–0.15)
export const DEAD = 0.02;         // m — Y dead zone (head sway, breathing)

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const fin = (x) => typeof x === 'number' && Number.isFinite(x);

/** The crown at rest, model units (heights along up). → { crown, headSpan, hipsToCrown } or null without head/hips.
 *  eye: the eyes' mean height (at or under the head bone → the no-eye fallback); boundsTop: the mesh's top at rest. */
export function crownEstimate({ hips, head, eye = null, boundsTop = null }) {
  if (!fin(hips) || !fin(head) || head <= hips) return null;
  const eyeCrown = fin(eye) && eye > head ? eye + EYE_K * (eye - head) : head + NO_EYE_K * (head - hips);
  const cap = head + BOUNDS_CAP_K * (eyeCrown - head);
  const crown = fin(boundsTop) ? Math.max(eyeCrown, Math.min(boundsTop, cap)) : eyeCrown;
  return { crown, headSpan: crown - head, hipsToCrown: crown - hips };
}

/** The gap between crown and plate, for a body `height` metres tall (world). */
export const plateGap = (height) => clamp(GAP_K * (fin(height) ? height : 0), GAP_MIN, GAP_MAX);

const band = (x, rest, start, full) => {
  if (!fin(x) || !fin(rest) || rest <= 0) return 0;
  const t = clamp((start - x / rest) / (start - full), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 0 (upright/sitting) … 1 (lying): head-above-feet vs rest, gated by head-over-hips vs rest (omit that pair to skip it). */
export function lieAmount(headAboveFeet, restHeadAboveFeet, headOverHips = null, restHeadOverHips = null) {
  const low = band(headAboveFeet, restHeadAboveFeet, LIE_START, LIE_FULL);
  return fin(headOverHips) && fin(restHeadOverHips) ? Math.min(low, band(headOverHips, restHeadOverHips, TORSO_START, TORSO_FULL)) : low;
}

/** Where the plate wants to be (WORLD, y up), before smoothing. hips, head: live [x,y,z]; feetY: the lower foot (or
 *  ground); rest: crownEstimate() + restHeadAboveFeet (model units); s: model→world; gap, lift: world m (lift is the
 *  wearer's offset, 0 = auto, added to both anchors). → { p, lie }, into `out` (per body per frame: no garbage). */
export function plateAnchor({ hips, head, feetY, rest, s = 1, gap, lift = 0 }, out = { p: [0, 0, 0], lie: 0 }) {
  const up = gap + (fin(lift) ? lift : 0);
  const stand = Math.max(hips[1] + rest.hipsToCrown * s, head[1] + rest.headSpan * s) + up;
  const lie = lieAmount(head[1] - feetY, rest.restHeadAboveFeet * s, head[1] - hips[1], (rest.hipsToCrown - rest.headSpan) * s);
  const lieY = head[1] + rest.headSpan * s + up;
  out.p[0] = hips[0] + (head[0] - hips[0]) * lie; out.p[1] = stand + (lieY - stand) * lie; out.p[2] = hips[2] + (head[2] - hips[2]) * lie;
  out.lie = lie;
  return out;
}

/** Chase only the error outside the dead zone, at 1 − exp(−dt/τ); no prev lands on target; continuous at the edge. */
export function smoothY(prev, target, dt, { tau = TAU, dead = DEAD } = {}) {
  if (!fin(prev)) return target;
  const err = target - prev;
  if (Math.abs(err) <= dead) return prev;
  const goal = target - Math.sign(err) * dead;
  return prev + (goal - prev) * (1 - Math.exp(-Math.max(0, dt) / tau));
}

/** Standing slots (a fall off a ledge plays the jump); flight, climbing and seat/lie keep the live anchor. */
export const STAND_SLOTS = new Set(['idle', 'walk', 'run', 'jump']);

/** Standing: the rest anchor with no dead zone, so it lands exactly and never moves; else the live anchor. Only a
 *  posture change eases. */
export function plateOffset(prev, { standing, standY, liveY }, dt, opts = {}) {
  if (!standing) return smoothY(prev, liveY, dt, opts);
  return smoothY(prev, standY, dt, opts.tau == null ? RIGID : { tau: opts.tau, dead: 0 });   // per frame: no garbage
}
const RIGID = { dead: 0 };

// ---- seen from above ------
// looking down, the gap foreshortens onto the face: slide along camera up by the least that keeps the eye-level
// stand-off from the head ball; 0 at or above level, continuous

/** eye, up, fwd: camera world position, unit up / forward; plate: centre (world); drop: centre → crown (m); headR,
 *  halfH: head radius, half the drawn pill height (m). → the lift (m, ≥ 0) along `up`. */
export function plateViewLift({ eye, up, fwd, plate, drop, headR, halfH }) {
  const px = plate[0] - eye[0], py = plate[1] - eye[1], pz = plate[2] - eye[2];
  const zP = px * fwd[0] + py * fwd[1] + pz * fwd[2];
  const down = drop + headR;   // plate centre → the head ball's centre, straight down
  const zH = zP - down * fwd[1];
  if (!(fwd[1] < 0) || !(zP > 1e-3) || !(zH > 1e-3)) return 0;   // level or looking up; behind the eye (or NaN)
  const yP = px * up[0] + py * up[1] + pz * up[2], yH = yP - down * up[1];
  return Math.max(0, zP * (yH + headR + drop - halfH) / zH - yP + halfH);
}
