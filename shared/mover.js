// mover — ONE locomotion integrator for every body in every runtime (agent, client, authority), so a step the mover accepts
// is one the authority accepts, to the millimetre. PURE, as shared/flight.js: the caller owns state, world queries arrive as
// `env` callbacks, config carries the spec's numbers as defaults.
// MODES. `walk` is here; `fly` is shared/flight.js's until its state moves in; `swim` and `drive` are reserved names.
// Stepping a mode the body isn't in is a no-op with a reason, never a teleport.

/** @typedef {[number, number, number]} P3 */
/** @typedef {{min:P3, max:P3}} Box */
/** @typedef {'walk'|'fly'|'swim'|'drive'} Mode */
/** @typedef {{
 *   floorAt?:(x:number, z:number, y:number)=>number,   // the floor under (x, z) for feet at y; NaN/undefined = unknown (keep y)
 *   blocked?:(box:Box, step:{from:P3, to:P3})=>any,    // truthy (an id, say) when a body in `box` would be inside something solid
 * }} MoverEnv */
/** @typedef {{pos:P3, moved:number, blocked:null|{by:any, top?:number}}} StepResult */

// ---------------------------------------------------------------- config
export const MOVER = Object.freeze({
  /** every mode this file knows; only `walk` steps here today (see MODES) */
  modes: Object.freeze(["walk", "fly", "swim", "drive"]),
  walk: Object.freeze({
    speed: 1.55,   // m/s, a walk (agent WALK; client W; VR stick at half deflection)
    run: 4.0,      // m/s, a run (Shift; run: true; full stick)
    creep: 0.55,   // m/s, the client's Alt: a slow walk for placing a chair exactly
    ease: 10,      // 1/s: a client's speed eases toward its target (easeSpeed); an agent snaps
  }),
  body: Object.freeze({
    radius: 0.2,   // m, half the body's width: the walking capsule, the authority's box
    height: 1.7,   // m, the body's height over its feet
    step: 0.8,     // m, the highest ledge a body walks onto without a mantle; the authority's box starts here
  }),
  track: Object.freeze({
    speed: 6,      // m/s the authority lets a tracked body sustain (a run with latency to spare)
    cap: 4,        // m it may cover in one step (the burst a token bucket holds)
    spawnR: 2,     // m a visitor may arrive from @world.spawn when the world declares one
    sweep: 0.05,   // m between the points at which a step is tested for solids
  }),
  arrive: Object.freeze({
    tolerance: 0.01,   // m: this close to the target is arrived (short positioning moves are honoured)
    max: 0.4,          // m: the widest tolerance a caller may ask for
  }),
  // WATER (upstream #242's law; one walker in water for client and agent): wading drags, knee-deep ~0.86 of the pace,
  // waist-deep ~0.5; deeper than `at` of the body's height at the feet, it floats at the chest and swims. Swimming is never
  // refused a step (a ledge under water isn't a ledge).
  swim: Object.freeze({
    speed: 0.9,    // m/s, a steady stroke
    run: 1.5,      // m/s, swimming hard
    at: 0.75,      // of body height: the chest; deeper water at the feet floats the body
    climb: 0.5,    // m above the SURFACE a swimmer can haul out onto; higher is a wall from the water
    // UNDER the surface (upstream #248's 3D swim, #254's diving: the float a diver returns to is the one a wader swims at):
    // stepSwim below. A diver's stroke is `dive` × the stroke; Shift is `fast` × it.
    dive: 1.4,     // × speed: the stroke under a water level (WASD where you look, Space up, C / Ctrl down)
    fast: 1.65,    // × the stroke while swimming hard under water
    buoy: 0.16,    // m/s an idle swimmer drifts up toward the surface
    latch: 0.12,   // m under the float line: a rising swimmer this close is back AT the surface (the float takes it)
    ease: 5,       // 1/s: a swimmer's velocity eases toward what it asks for
    deep: 1.3,     // of body height × at: deeper than this under the feet, a swimmer may dive (shallower is wading)
  }),
});
/** `fly` is shared/flight.js's integrator until its state moves in. */
export const MODES = Object.freeze(["walk"]);

/** The same numbers as MOVER (one source), under the authority's names: TRACK.speed, cap, step, radius, height, spawnR. */
export const TRACK = Object.freeze({
  speed: MOVER.track.speed, cap: MOVER.track.cap, spawnR: MOVER.track.spawnR,
  step: MOVER.body.step, radius: MOVER.body.radius, height: MOVER.body.height,
});

// ---------------------------------------------------------------- the body
/** As shared/presencewire.js keeps it (0.5–2; a non-number is 1), re-stated so this file stays leaf-level. */
const scaleOf = (u) => (typeof u === "number" && Number.isFinite(u) ? Math.min(2, Math.max(0.5, u)) : 1);
/** 0.5-2 (the slider's range; anything else is 1): the authority bounds a claimed size with this, so it never judges a body
 *  this file wouldn't walk. */
export const bodyScale = scaleOf;

/** Run outranks creep; the stride grows with the body. */
export function walkSpeed({ run = false, creep = false, scale = 1 } = {}) {
  const w = MOVER.walk;
  return (run ? w.run : creep ? w.creep : w.speed) * scaleOf(scale);
}

/** Half deflection is a walk, full is a run, ramping between. */
export function stickSpeed(mag, scale = 1) {
  const m = Math.min(1, Math.max(0, mag)), w = MOVER.walk;
  return (m <= 0.5 ? w.speed * (m / 0.5) : w.speed + (w.run - w.speed) * ((m - 0.5) / 0.5)) * scaleOf(scale);
}

/** Over `dt` (the walk→idle coast and the start-up ramp). */
export function easeSpeed(prev, target, dt) {
  const k = 1 - Math.exp(-MOVER.walk.ease * dt);
  const v = prev + (target - prev) * k;
  return v < 0.02 ? 0 : v;
}

/** Axis-aligned over its feet at p: from `step` up (a lower ledge is walked onto) to its height, `radius` either side; the
 *  authority tests it against solids. With `level`, the box of a body `step` below the surface, so a swimmer hauls out
 *  onto what a walker there would step onto. */
export function bodyBox(p, scale = 1, level = null) {
  const s = scaleOf(scale), r = MOVER.body.radius * s;
  const feet = level != null && Number.isFinite(level) ? level + (MOVER.swim.climb - MOVER.body.step) * s : p[1];
  return { min: [p[0] - r, feet + MOVER.body.step * s, p[2] - r], max: [p[0] + r, feet + MOVER.body.height * s, p[2] + r] };
}
/** For a client's collider pass: radius and height for its size. */
export function capsule(scale = 1) {
  const s = scaleOf(scale);
  return { r: MOVER.body.radius * s, tall: MOVER.body.height * s, step: MOVER.body.step * s };
}

/** The floor rule, every caller: a floor at `top` is walked onto when at most a step above the feet at y (any lower floor is stepped down onto). */
export const floorOk = (y, top, scale = 1) => top <= y + MOVER.body.step * scaleOf(scale) + 1e-9;

/** With a mantle (the client's jump-at-a-wall): above a step, up to its height. */
export const canMantle = (reach, scale = 1) => { const s = scaleOf(scale); return reach > MOVER.body.step * s && reach <= MOVER.body.height * s; };

// ---------------------------------------------------------------- arrival
/** In the ground plane. */
export function arrived(pos, target, tolerance = MOVER.arrive.tolerance) {
  return Math.hypot(target[0] - pos[0], target[1] - pos[2]) <= tolerance;
}
/** A finite number from 0 to the mover's max; anything else is refused (null). */
export function toleranceOf(t) {
  if (t === undefined || t === null) return MOVER.arrive.tolerance;
  return typeof t === "number" && Number.isFinite(t) && t >= 0 && t <= MOVER.arrive.max ? t : null;
}

// ---------------------------------------------------------------- the track (the authority's bucket)
/** The bucket refilled at the track's speed since its last accepted step, never over the cap. `prev` is the tokens it had
 *  (absent = full); `elapsedMs` since then. */
export function tokensAfter(prev, elapsedMs) {
  const t = MOVER.track;
  return Math.min(t.cap, (typeof prev === "number" ? prev : t.cap) + t.speed * Math.max(0, elapsedMs) / 1000);
}
/** Every `sweep` metres, ending at `to` (never `from`: a body already inside something may walk out of it). */
export function sweep(from, to, spacing = MOVER.track.sweep) {
  const n = Math.max(1, Math.ceil(Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) / spacing));
  const out = [];
  for (let k = 1; k <= n; k++) out.push(from.map((v, i) => v + (to[i] - v) * k / n));
  return out;
}

// ---------------------------------------------------------------- stepping
/** `dir` is a ground-plane [dx, dz] (zero = stand); `gain` scales the stride (1 = full); `cap` is the most this step may cover.
 *  The floor comes from env.floorAt (absent: y kept); one more than a step up is a wall; env.blocked refuses the step at the
 *  new box. → {pos, moved, blocked}. Never mutates its inputs. */
const sm01 = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
/** {y, depth, swimming, speedFactor}. speedFactor is the wading drag (1 dry, ~0.5 waist-deep); null when swimming (the stroke
 *  has its own speeds). `level` null = dry. */
export function waterStance(level, ground, height = MOVER.body.height) {
  if (level == null || !Number.isFinite(level)) return { y: ground, depth: 0, swimming: false, speedFactor: 1 };
  const depth = level - ground, floatY = level - floatDepth(height);
  if (ground < floatY) return { y: floatY, depth, swimming: true, speedFactor: null };
  const f = (depth > 0 ? depth : 0) / height;
  return { y: ground, depth, swimming: false, speedFactor: 1 - 0.5 * sm01((f - 0.08) / 0.67) };
}
/** `at` of its height (the chest at the surface). One number for the surface float (waterStance), the 3D swim's latch
 *  (stepSwim) and the dive handover, so a diver coming up meets the float exactly. */
export const floatDepth = (height = MOVER.body.height) => MOVER.swim.at * height;

/** One step of the 3D swim (upstream #248, #254); the caller substeps it. `input`: {direction:[x,y,z], dive?, rise?, fast?,
 *  height?}; `water`: {speed, surfaceAt(x, z)}. Idle swimmers drift up; diving releases the surface latch; an ascent never
 *  jumps the body out. → {pos, velocity, mode: 'swim' | 'surface'}. Pure. */
export function stepSwim(pos, velocity, input, water, dt) {
  const S = MOVER.swim, fin = (x, d) => (Number.isFinite(x) ? x : d);
  dt = Math.max(0, Math.min(0.1, fin(dt, 0)));
  const speed = fin(water.speed, S.speed) * (input.fast ? S.fast : 1);
  const raw = Array.isArray(input.direction) && input.direction.length === 3 && input.direction.every(Number.isFinite) ? input.direction : [0, 0, 0];
  const length = Math.max(1, Math.hypot(raw[0], raw[1], raw[2]));
  const target = raw.map((v) => (v / length) * speed);
  if (!input.dive && !input.rise) target[1] += S.buoy;
  const blend = 1 - Math.exp(-S.ease * dt);
  const vel = velocity.map((v, i) => v + (target[i] - v) * blend);
  const next = pos.map((v, i) => v + vel[i] * dt);
  const H = typeof input.height === "number" && input.height > 0 ? input.height : MOVER.body.height;
  const surface = water.surfaceAt(next[0], next[2]) - floatDepth(H);
  let mode = "swim";
  if (!input.dive && next[1] >= surface - S.latch) { next[1] = surface; vel[1] = 0; mode = "surface"; }
  return { pos: next, velocity: vel, mode };
}

/** A planner's price for water: 1 dry, ~2 chest-deep, ~1.7 swimming. */
export function waterCost(level, ground, height = MOVER.body.height) {
  const s = waterStance(level, ground, height);
  return s.swimming ? MOVER.walk.speed / MOVER.swim.speed : 1 / s.speedFactor;
}

/** THE FLOOR LAW for one step, in every runtime (walker and authority call this, never a copy). Feet at `y` on `ground0` in
 *  water `level0` (null: dry) step to floor `f`, water `level1` → {y, stance, swim, blocked}. Afloat at the new spot: no
 *  ledge. Afloat where it was: hauls out onto up to `climb` above the surface, higher is a wall. On its feet: floorOk. */
export function floorStep({ y, ground0 = y, level0 = undefined, f, level1 = level0, height = undefined, scale = 1 }) {
  const s = scaleOf(scale), H = typeof height === "number" && height > 0 ? height : MOVER.body.height * s;
  // a stance is reported wherever the caller has a water law (level null there: dry), as stepWalk always did
  const st0 = level0 !== undefined ? waterStance(level0, ground0, H) : null, st = level1 !== undefined ? waterStance(level1, f, H) : null;
  if (st?.swimming) return { y: st.y, stance: st, swim: true, blocked: null, level: level1 };
  if (st0?.swimming) {
    if (f > level0 + MOVER.swim.climb * s) return { y, stance: st0, swim: true, blocked: { by: "ledge", top: f }, level: level0 };
    return { y: f, stance: st ?? st0, swim: true, blocked: null, level: level0 };
  }
  if (!floorOk(y, f, scale)) return { y, stance: st0, swim: false, blocked: { by: "ledge", top: f }, level: null };
  return { y: f, stance: st, swim: false, blocked: null, level: null };
}

/** env.waterAt(x, z) → the surface's y or null: in water a step wades (slower) or swims (floats at the chest, never refused
 *  by a ledge), and `stance` picks the clip. `height` (m): the body's measured stature (absent: the mover's for its `scale`);
 *  it changes where the water reaches, never the stride. */
export function stepWalk({ pos, dir, dt, run = false, creep = false, scale = 1, gain = 1, cap = Infinity, mode = "walk", height = undefined }, env = {}) {
  const here = [pos[0], pos[1], pos[2]];
  if (mode !== "walk") return { pos: here, moved: 0, blocked: { by: `mode:${mode}` }, stance: null };
  const len = Math.hypot(dir[0], dir[1]);
  if (!(len > 0) || !(dt > 0) || !(gain > 0)) return { pos: here, moved: 0, blocked: null, stance: null };
  // judged where the body IS (the step's speed), re-judged where it lands (its y)
  const H = typeof height === "number" && height > 0 ? height : MOVER.body.height * scaleOf(scale);
  const ground0 = env.floorAt ? env.floorAt(pos[0], pos[2], pos[1]) : NaN, g0 = Number.isFinite(ground0) ? ground0 : pos[1];
  const level0 = env.waterAt ? env.waterAt(pos[0], pos[2]) : undefined;
  const st0 = env.waterAt ? waterStance(level0, g0, H) : null;
  // swimming: the dry speed asked for maps onto the stroke, so a stick ramp never goes backwards at the run threshold: below
  // a walk a fraction of the stroke; walk→run, stroke→hard
  const s = scaleOf(scale), dry = walkSpeed({ run, creep, scale }) * gain;
  const stroke = (q) => (q <= MOVER.walk.speed ? MOVER.swim.speed * (q / MOVER.walk.speed) : MOVER.swim.speed + (MOVER.swim.run - MOVER.swim.speed) * Math.min(1, (q - MOVER.walk.speed) / (MOVER.walk.run - MOVER.walk.speed)));
  const d = Math.min(cap, (st0?.swimming ? stroke(dry / s) * s : dry * (st0?.speedFactor ?? 1)) * dt);
  if (!(d > 0)) return { pos: here, moved: 0, blocked: null, stance: st0 };
  const nx = pos[0] + (dir[0] / len) * d, nz = pos[2] + (dir[1] / len) * d;
  let ny = pos[1], stance = st0, boxLevel = st0?.swimming ? level0 : null;
  if (env.floorAt) {
    const f = env.floorAt(nx, nz, pos[1]);
    if (Number.isFinite(f)) {
      const r = floorStep({ y: pos[1], ground0: g0, level0, f, level1: env.waterAt ? env.waterAt(nx, nz) : undefined, height: H, scale });
      if (r.blocked) return { pos: here, moved: 0, blocked: r.blocked, stance: st0 };
      ny = r.y; if (r.stance) stance = r.stance; boxLevel = r.swim ? r.level : null;
    }
  }
  const to = [nx, ny, nz];
  if (env.blocked) { const hit = env.blocked(bodyBox(to, scale, boxLevel), { from: here, to }); if (hit) return { pos: here, moved: 0, blocked: { by: hit }, stance: st0 }; }
  return { pos: to, moved: d, blocked: null, stance };
}

/** Arrives (no move) within `tolerance`, else steps at most the distance left (and `room`, a permit's cap).
 *  → {pos, arrived, moved, yaw, blocked}; yaw is atan2(dx, dz), the renderers' heading. */
export function walkToward({ pos, target, dt, run = false, scale = 1, tolerance = MOVER.arrive.tolerance, room = Infinity, gain = 1, height = undefined }, env = {}) {
  const dx = target[0] - pos[0], dz = target[1] - pos[2], dist = Math.hypot(dx, dz);
  const yaw = dist > 0 ? Math.atan2(dx, dz) : null;
  if (dist <= tolerance) return { pos: [pos[0], pos[1], pos[2]], arrived: true, moved: 0, yaw, blocked: null };
  const r = stepWalk({ pos, dir: [dx, dz], dt, run, scale, gain, cap: Math.min(dist, room), height }, env);
  return { ...r, arrived: false, yaw };
}
