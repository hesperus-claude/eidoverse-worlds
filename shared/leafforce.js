// leafforce — make a REAL ragdoll fall like a leaf by adding the forces a leaf feels, not animating a curve (flight.js's
// leafAt() is deterministic kinematics; this lets the body be hit, snag and land badly). Bullet integrates; nothing here moves.
//   1. NORMAL DRAG: drag scales with velocity ALONG the plate normal, so a plate seeks edge-on and overshoots.
//   2. A DISPLACED CENTRE OF PRESSURE: forward of centre, a torque that turns the overshoot into a periodic tumble.
// Together they flutter on their own; `periodAssist` nudges the emergent period toward the spec's 3.4 s (on purpose).
// PURE (shared/README.md): plain numbers in, force/torque vectors out — see docs/research/leaf-flutter.md.

/** @typedef {{x:number,y:number,z:number}} V3 */
/** @typedef {{ rho:number, cdNormal:number, cdEdge:number, copOffset:number,
 *              swirl:number, damp:number, periodAssist:number, period:number,
 *              vMax:number }} LeafForceCfg */
/** @typedef {{ mass:number, halfExtents:number[], vel:V3, normal:V3, right:V3 }} PlateBody */

export const DEFAULT_LEAF_FORCE = {
  // air at sea level; a parameter only because halving it is the cheapest way to make a body fall faster
  rho: 1.225,                 // kg/m^3

  // per body: a box; its largest face is the plate, its normal the plate normal
  cdNormal: 1.28,             // flat plate, broadside (classic value)
  cdEdge: 0.06,               // edge-on: nearly nothing
  copOffset: 0.42,            // centre of pressure, a fraction of the plate's half-width, forward of centre. THE flutter term.

  // how much oscillation survives the solver on a jointed doll: set against the assembly, not one plate (a joint chain absorbs most torque)
  swirl: 2.4,                 // torque gain, N.m per (m/s)^2 of normal flow
  damp: 0.06,                 // angular damping. LOWER is more flutter: a swing survives into the next instead of being eaten

  // periodAssist: a weak couple about world-up, phase-locked to the caller's clock; 0 = purely physical, 1 = herded
  periodAssist: 0.6,
  period: 3.4,                // s, the target when periodAssist > 0

  // terminal speed is a CONSEQUENCE (drag balances weight); this clamps only the runaway case, and is not the dial to tune
  vMax: 45,
};

/**
 * Aerodynamic force and torque for ONE rigid body this step.
 * @param {LeafForceCfg} cfg   from DEFAULT_LEAF_FORCE (spread and override)
 * @param {PlateBody} body
 *   `normal`: the largest-face normal in WORLD space; `right`: any perpendicular in the plate (places the centre of pressure).
 * @param {number} t        seconds since the fall began (for periodAssist)
 * @returns {{force:V3, torque:V3, angularDamping:number}}
 *   apply with applyCentralForce / applyTorque / setDamping
 */
export function leafForceFor(cfg, body, t) {
  const he = body.halfExtents;
  // the two largest half-extents span the plate, the smallest is thickness
  const dims = [he[0], he[1], he[2]];
  const thinAxis = dims.indexOf(Math.min(...dims));
  const a = dims[(thinAxis + 1) % 3], b = dims[(thinAxis + 2) % 3];
  const area = 4 * a * b;                       // full face, both half-extents
  const halfWidth = Math.max(a, b);

  const v = body.vel;
  const speed = Math.hypot(v.x, v.y, v.z);
  if (speed < 1e-4 || area < 1e-6) return zero();

  const n = norm(body.normal);
  // the airflow along the plate normal is what a plate feels; the tangential part slides past almost free
  const vn = v.x * n.x + v.y * n.y + v.z * n.z;
  const absVn = Math.abs(vn);
  // blend the two drag coefficients by how broadside the flow is
  const broadside = absVn / speed;
  const cd = cfg.cdEdge + (cfg.cdNormal - cfg.cdEdge) * broadside;

  // F = 1/2 rho v^2 Cd A, opposing the motion, dominated by the normal part: flat is slowed hard, edge-on barely
  const q = 0.5 * cfg.rho * speed * Math.min(speed, cfg.vMax) * cd * area;
  const force = { x: -v.x / speed * q, y: -v.y / speed * q, z: -v.z / speed * q };

  // the FLUTTER TORQUE: the normal force acts at the centre of pressure, a little forward of centre, so its couple rotates
  // the plate toward edge-on, past it, and back. r x F, with r along the plate.
  const r = norm(body.right);
  const nf = 0.5 * cfg.rho * vn * absVn * cfg.cdNormal * area;   // signed
  const lever = cfg.copOffset * halfWidth;
  const rv = { x: r.x * lever, y: r.y * lever, z: r.z * lever };
  const fv = { x: -n.x * nf, y: -n.y * nf, z: -n.z * nf };
  let torque = cross(rv, fv);
  torque = scale(torque, cfg.swirl);

  // PERIOD ASSIST: a sinusoidal couple about world-up at the authored period; it can't place the body, only bias the tumble
  // so an emergent flutter phase-locks near 3.4 s
  if (cfg.periodAssist > 0) {
    const w = (2 * Math.PI) / Math.max(0.05, cfg.period);
    const bias = Math.sin(w * t) * cfg.periodAssist * body.mass * absVn * 0.5;
    torque.y += bias;
  }

  // the caller applies angular damping on the body (Bullet has a setter); returned for a caller without one
  return { force, torque, angularDamping: cfg.damp };
}

/** The whole assembly at once. `bodies` is an array of the shape above. */
/**
 * @param {LeafForceCfg} cfg
 * @param {PlateBody[]} bodies
 * @param {number} t
 */
export function leafForces(cfg, bodies, t) {
  return bodies.map(b => leafForceFor(cfg, b, t));
}

/** So a caller can SAY what the physics implies: mg = 1/2 rho v^2 Cd A  =>  v = sqrt(2mg / (rho Cd A)). */
/**
 * @param {LeafForceCfg} cfg
 * @param {{mass:number, halfExtents:number[]}} body
 * @param {number} [g]
 */
export function terminalOf(cfg, { mass, halfExtents }, g = 9.81) {
  const dims = halfExtents.slice().sort((x, y) => x - y);
  const area = 4 * dims[1] * dims[2];
  if (area < 1e-9) return Infinity;
  return Math.sqrt((2 * mass * g) / (cfg.rho * cfg.cdNormal * area));
}

const zero = () => ({ force: { x: 0, y: 0, z: 0 }, torque: { x: 0, y: 0, z: 0 }, angularDamping: 0 });
const norm = (v) => { const m = Math.hypot(v.x, v.y, v.z) || 1; return { x: v.x / m, y: v.y / m, z: v.z / m }; };
const scale = (v, k) => ({ x: v.x * k, y: v.y * k, z: v.z * k });
const cross = (a, b) => ({ x: a.y * b.z - a.z * b.y, y: a.z * b.x - a.x * b.z, z: a.x * b.y - a.y * b.x });
