// flight — the deterministic flight integrator: glide polar, falling leaf, stamina, and the state machine that decides which
// of them owns the body.
//
// Implements the physical half of flight-spec-v0.md (SHA-256
// 641da611754c7097142e16b355a6dd79b4d431646e0c1d890759884f86fbe805) and the
// airborne clause of down-spec-v0.1.md v0.1.1 (SHA-256
// 71e4fff28fbc6145f452df9a8b7a03b3fbbcd0bf9eba471f207edbd3435c0a91).
//
// PURE: ONE deterministic function every runtime integrates. Authority is the server's verb-RECEIPT timestamps, not position
// streaming: a late verb is a new input from its receipt forward, and the trajectory before it stays true. So it takes `now`
// from its caller, holds no clock, and keeps all state in a value the caller owns.
//
// SCOPE. This is the body. It consumes trusted events and never asks why:
//
//     bodyDown({ eventId, state: 'DOWN' })
//     bodyRecovered({ eventId, recoveryGeneration })
//
// The detector that produces them is harness-side (down spec §6) and deliberately NOT here: this layer can't tell a cut from
// a crash from a rehearsal button, and must not try.

/** @typedef {'GROUND'|'LAUNCH'|'GLIDE'|'CLIMB'|'CIRCLE'|'PILOT'|'LEAF'|'RECOVER'|'LANDED'|'RAGDOLL'} Phase */
/** @typedef {'OPEN'|'FOLDED'|'LIMP'} Wings */
/** @typedef {'live'|'plan'|'reflex'} Mode */
/** @typedef {{x:number,y:number,z:number}} Vec3 */
/** @typedef {{t:number, kind:string, [k:string]:any}} FlightEvent */
/** @typedef {{
 *   phase:Phase, wings:Wings, mode:Mode, t:number,
 *   pos:Vec3, vel:Vec3, yaw:number, pitch:number, bank:number,
 *   airspeed:number, stamina:number, phaseT:number, leafV0:number,
 *   recoverAt:number|null,
 *   recoverPlan:{beatEnds:number, reopenEnds:number, ground:boolean}|null,
 *   flownAs:Phase, launchV:number, launchV0?:number, launchT?:number, launchNow?:number,
 *   lastEvent:{eventId:string|null, kind:string}|null,
 *   downEventId:string|null, recoveryGeneration:string|null,
 *   events:FlightEvent[], [k:string]:any
 * }} FlightState */
/** @typedef {{
 *   groundY?:(x:number,z:number)=>number,
 *   lift?:(x:number,y:number,z:number)=>number,
 *   input?:{bank?:number,pitch?:number,yawRate?:number,flap?:boolean,spoil?:boolean},
 *   consent?:{canLandAt:(flier:any,target:any)=>boolean}
 * }} FlightEnv */

// ---------------------------------------------------------------- config
// every tunable has the spec's value as its DEFAULT, so tuning is a config diff (the stamina numbers are guesses, spec §9 Q5).
// The 3.4 s BREATH (wing idle, stamina tick, leaf; spec §5, §2, T8) is shared/breath.js's, re-exported.

export { BREATH } from './breath.js';
import { BREATH } from './breath.js';

export const DEFAULT_CONFIG = {
  breath: BREATH,

  // ---- glide polar (spec §1 glide_to, §0 "albatross, not hummingbird")
  // a single-parabola sink polar about minimum sink (±5%). Two optima: minSinkSpeed (slowest sink) and best glide (furthest
  // per metre, always faster). Best-glide numbers are DERIVED from the curve, never asserted, so range is never over-promised
  // (T2). Speeds scaled to read at human scale; the ratio (~12.9) is unchanged.
  polar: {
    minSinkSpeed: 5.5,        // m/s: minimum sink. The shape parameter.
    sinkAtMinSink: 5.5 / 12,  // m/s at that speed
    minSpeed: 3,              // stall (spec R1 triggers below this)
    maxSpeed: 15,             // never-exceed; drag rises steeply past best
    curvature: 3,             // how sharply sink rises either side of min-sink
  },

  // ---- stamina, "shaped like breath" (spec §5)
  stamina: {
    pool: 100,
    climbPerMetre: 1,         // -1/m
    flapSustainPerSec: 2,     // -2/s, deliberately expensive: a glider
    refillGroundPerSec: 0.5,
    // NOT IMPLEMENTED IN STAGE 1: no perch detection and no runtime consumer. The spec's figure (§5), kept OUT of every surface
    // that would imply it works; don't re-advertise it without a refill path and a test that measures one.
    refillPerchPerSec: 2,     // perches are the social choice: SPEC ONLY, no runtime
    refillAirPerSec: 0,       // never refills airborne
  },

  // ---- R2 falling leaf (spec §3 R2, down-spec §3 airborne case)
  // a leaf is a survivable slow spiral that must LAND (no flare, no hover; T4). Two amplitudes: bank (degrees, attitude) and
  // lateral (metres, path). The path is the tunable (spec 1.2-1.8 m); drift speed is derived from the period.
  leaf: {
    period: BREATH,             // s: one full oscillation
    bankAmplitudeDeg: 35,       // DEGREES of roll at peak. Attitude, not path.
    lateralAmplitudeM: 0.8,     // METRES from centreline at peak (1.6 m peak-to-peak, mid of the spec's 1.2-1.8 m band)
    dampingPerCycle: 0.08,      // FRACTION of swing lost per CYCLE (spec 0.05-0.1); converted to a per-second rate in leafAt
    dampingFloor: 0.35,         // the swing decays TOWARD this, not to zero: a body going rigid on the way down reads as a prop
    // terminalV is contested: the spec's 2-3 m/s (survivable by design) is the default; LEAF_PRESETS offer a heavier fall to
    // try
    terminalV: 2.5,             // m/s downward. Spec says 2-3.
    spinUpTime: 0.9,            // s to reach terminalV from whatever v it had
    yawPerBank: 0.55,           // rad/s of yaw per radian of bank: the spiral
    pitchCoupling: 0.35,        // how much bank leaks into pitch; 0 = pure roll
  },

  // ---- recovery (down-spec §3: "the aerial sit-up")
  // not instant and not longer than one breath: the body finishes its beat, then reloads its wings
  recover: {
    finishBeat: true,         // finish the current oscillation to its zero crossing
    reopenTime: 1.1,          // s of visible wing reload after the beat ends
    maxTotal: BREATH,         // hard ceiling on beat + reopen (acceptance band)
    minTotal: 0.35,           // floor: anything faster reads as a teleport
  },

  // ---- bounds and ceiling (spec R3)
  bounds: {
    ceiling: 60,              // m; soft: banks you back, never a wall-slam
    softMargin: 8,            // m of authority band below the ceiling
    // 110 m circumscribes the ~160 m terrain's half-diagonal (113 m) closely enough to keep fliers over terrain without
    // fencing the corners people stand on
    radius: 110,              // m from origin
    groundClearance: 0.15,    // m; below this counts as ground contact
  },

  // ---- the stick, when a person is holding it.
  // named config so things outside the integrator (the client's wing animation scales against the launch boost) agree with the physics
  pilot: {
    spoilSink: 2.5,      // m/s of extra sink with the spoilers out (Shift)
    flapClimb: 2.2,      // m/s of climb while Space is held; costs stamina
    launchBoost: 9.0,    // m/s launch impulse, SHAPED over ~1.5 s in stepPilot (3 bought under a second of air: a stumble)
  },

  // ---- watchdog (spec R2, open question Q1: unresolved): the proposal is the default, and the question is reported
  watchdogSec: 90,
};

/** Named leaf characters, so "too slow" is a word rather than a patch: `spec` the authored default, `heavy` a real-weight fall
 *  that still wanders, `brisk` between. The period shortens as the fall speeds up (at 12 m/s a 3.4 s swing isn't visible):
 *  the one place the body falls rather than breathes.
 */
export const LEAF_PRESETS = {
  spec:  { terminalV: 2.5,  period: BREATH, lateralAmplitudeM: 0.8, bankAmplitudeDeg: 35, spinUpTime: 0.9 },
  brisk: { terminalV: 6.5,  period: 2.2,    lateralAmplitudeM: 1.1, bankAmplitudeDeg: 40, spinUpTime: 0.8 },
  heavy: { terminalV: 12.0, period: 1.5,    lateralAmplitudeM: 1.4, bankAmplitudeDeg: 45, spinUpTime: 0.7 },
};

/** Deep-merge over the defaults, REJECTING anything it doesn't consume: unknown keys, non-finite and out-of-range values throw
 *  when the config is built, so an editor can never report an edit the physics ignores.
 */
export function makeConfig(over = {}) {
  const out = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  const bad = [];
  for (const [k, v] of Object.entries(over)) {
    if (!(k in out)) { bad.push(`unknown section '${k}'`); continue; }
    if (v && typeof v === 'object' && !Array.isArray(v) && typeof out[k] === 'object') {
      for (const [k2, v2] of Object.entries(v)) {
        if (!(k2 in out[k])) { bad.push(`unknown key '${k}.${k2}'`); continue; }
        if (typeof out[k][k2] === 'number' && !Number.isFinite(v2)) {
          bad.push(`'${k}.${k2}' must be a finite number, got ${v2}`); continue;
        }
        out[k][k2] = v2;
      }
    } else {
      if (typeof out[k] === 'number' && !Number.isFinite(v)) {
        bad.push(`'${k}' must be a finite number, got ${v}`); continue;
      }
      out[k] = v;
    }
  }
  // ranges that would make a nonsense body, not a differently-tuned one: this rejects the impossible, not the unwise
  const R = [
    ['leaf.period', out.leaf.period, 0.05, 60],
    ['leaf.dampingPerCycle', out.leaf.dampingPerCycle, 0, 0.999],
    ['leaf.dampingFloor', out.leaf.dampingFloor, 0, 1],
    ['leaf.terminalV', out.leaf.terminalV, 0.01, 100],
    ['polar.minSpeed', out.polar.minSpeed, 0.1, out.polar.maxSpeed],
    ['polar.minSinkSpeed', out.polar.minSinkSpeed, out.polar.minSpeed, out.polar.maxSpeed],
    ['stamina.pool', out.stamina.pool, 0, 1e6],
    ['bounds.softMargin', out.bounds.softMargin, 0.01, out.bounds.ceiling],
  ];
  for (const [name, v, lo, hi] of R) {
    if (!(v >= lo && v <= hi)) bad.push(`'${name}' = ${v} is outside [${lo}, ${hi}]`);
  }
  if (bad.length) throw new Error(`flight config: ${bad.join('; ')}`);
  return out;
}

// ---------------------------------------------------------------- polar

/** m/s, positive = descending: parabolic about the minimum, clamped below stall (R1's territory), never extrapolated. */
export function sinkRate(cfg, airspeed) {
  const p = cfg.polar;
  const v = clamp(airspeed, p.minSpeed, p.maxSpeed);
  const k = p.sinkAtMinSink / (p.minSinkSpeed * p.minSinkSpeed);
  const d = v - p.minSinkSpeed;
  return p.sinkAtMinSink + k * d * d * p.curvature;
}

/** The polar's ACTUAL best-glide point, searched on the curve, never asserted beside it: anything predicting range must
 *  consult this. Memoised per config object (~2400 evaluations; glideRange() runs per verb).
 *  @returns {{speed:number, ratio:number, sink:number}}
 */
const _bestCache = new WeakMap();
export function bestGlide(cfg) {
  const hit = _bestCache.get(cfg);
  if (hit) return hit;
  const p = cfg.polar;
  let best = { speed: p.minSinkSpeed, ratio: 0, sink: 0 };
  // coarse sweep then a bisection refine: the curve is smooth and unimodal in ratio, so this lands on the true optimum
  for (let v = p.minSpeed; v <= p.maxSpeed; v += 0.01) {
    const r = v / sinkRate(cfg, v);
    if (r > best.ratio) best = { speed: v, ratio: r, sink: sinkRate(cfg, v) };
  }
  for (let stepSize = 0.005; stepSize > 1e-6; stepSize /= 2) {
    for (const dir of [-1, 1]) {
      const v = clamp(best.speed + dir * stepSize, p.minSpeed, p.maxSpeed);
      const r = v / sinkRate(cfg, v);
      if (r > best.ratio) best = { speed: v, ratio: r, sink: sinkRate(cfg, v) };
    }
  }
  _bestCache.set(cfg, best);
  return best;
}

/** Metres forward per metre down. */
export function glideRatio(cfg, airspeed) {
  const v = clamp(airspeed, cfg.polar.minSpeed, cfg.polar.maxSpeed);
  return v / sinkRate(cfg, v);
}

/** Nose down trades altitude for speed, nose up trades it back, so a stall is reachable by holding the nose up (R1 is a
 *  reflex, not a scripted event). PHYSICS, so it lives here: a verb-flown climb spends speed on the same curve as a hand-flown one.
 */
export function airspeedAfter(cfg, airspeed, pitch, dt) {
  const p = cfg.polar;
  const g = 9.81;
  const accel = -Math.sin(pitch) * g * 0.55;      // 0.55: drag eats the rest
  const toward = (p.minSinkSpeed - airspeed) * 0.25;  // drag pulls toward min sink
  const v = airspeed + (accel + toward) * dt;
  return clamp(v, p.minSpeed * 0.6, p.maxSpeed);
}

/** At best glide, metres: `glide_to` beyond range lands SHORT here, never rubber-banding to the target (spec T2). */
export function glideRange(cfg, altitude) {
  return Math.max(0, altitude) * bestGlide(cfg).ratio;
}

// ---------------------------------------------------------------- leaf
// the falling leaf as a pure function of elapsed time, not an accumulator, so runtimes agree without exchanging a byte. A
// damped oscillation in BANK, yaw following bank (the spiral), pitch coupled, descent settling to terminalV; the swing
// decays toward a steady spiral, never to zero.

/** At elapsed time `t`.
 *  @returns {{bank:number, yawRate:number, pitch:number, vy:number, drift:number, beatPhase:number, envelope:number}}
 *    bank/pitch in radians, yawRate rad/s, vy m/s (negative = down),
 *    drift m/s lateral, beatPhase 0..1 through the current oscillation.
 */
export function leafAt(cfg, t, v0 = 0) {
  const L = cfg.leaf;
  const w = (2 * Math.PI) / L.period;

  // DAMPING is authored per CYCLE and applied per second, so the config's number means the same whatever the period:
  // a fraction f lost per cycle is a rate of -ln(1-f)/period
  const ratePerSec = -Math.log(Math.max(1e-9, 1 - L.dampingPerCycle)) / L.period;
  const floor = L.dampingFloor;
  const env = floor + (1 - floor) * Math.exp(-ratePerSec * t);

  const bank = (L.bankAmplitudeDeg * Math.PI / 180) * env * Math.sin(w * t);
  const yawRate = L.yawPerBank * bank;
  const pitch = L.pitchCoupling * bank;

  // vertical speed eases exponentially from whatever it was into terminal, continuous with the glide before it (6 m/s of
  // sink doesn't jump to 2.5)
  const k = 1 - Math.exp(-t / Math.max(1e-3, L.spinUpTime));
  const vy = -(Math.abs(v0) + (L.terminalV - Math.abs(v0)) * k);

  // drift is a velocity but the authored thing is DISPLACEMENT: wandering A metres needs peak speed A*w, derived so retuning
  // the period doesn't rescale the wander
  const drift = L.lateralAmplitudeM * w * env * Math.cos(w * t);

  const beatPhase = ((t % L.period) + L.period) % L.period / L.period;
  return { bank, yawRate, pitch, vy, drift, beatPhase, envelope: env };
}

/** Over its first `cycles` cycles: the specified quantity (1.2-1.8 m), shown beside the attitude so the two amplitudes aren't confused. */
export function leafLateralSwing(cfg, cycles = 3, dt = 1 / 120) {
  let x = 0, lo = 0, hi = 0;
  const n = Math.round((cfg.leaf.period * cycles) / dt);
  for (let i = 0; i < n; i++) {
    x += leafAt(cfg, i * dt, 0).drift * dt;
    if (x < lo) lo = x;
    if (x > hi) hi = x;
  }
  return hi - lo;
}

/** Until the oscillation next crosses zero bank ("finish the current beat", down-spec §3): the sit-up waits for level before
 *  the wings reload. Always in [0, period/2).
 */
export function beatRemaining(cfg, t) {
  const half = cfg.leaf.period / 2;
  const since = ((t % half) + half) % half;
  return since < 1e-9 ? 0 : half - since;
}

// ---------------------------------------------------------------- state

/** The caller owns this value; the integrator returns a new one each step and never mutates in place, so a replay from a
 *  snapshot is exact and a caller may keep history cheaply. */
/**
 * @param {Partial<FlightState>} [over]
 * @param {{stamina?:{pool?:number}}|null} [cfg]  bind the stamina pool to an effective config
 * @returns {FlightState}
 */
export function initialState(over = {}, cfg = null) {
  // the stamina pool comes from the EFFECTIVE config when one is supplied, so a body starts at its config's pool
  const pool = cfg?.stamina?.pool ?? DEFAULT_CONFIG.stamina.pool;
  return {
    phase: /** @type {Phase} */ ('GROUND'),
    wings: /** @type {Wings} */ ('OPEN'),
    mode: /** @type {Mode} */ ('live'),   // supplied by the CALLER (spec §4)
    t: 0,                      // seconds since the world's flight epoch
    pos: { x: 0, y: 0, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0, pitch: 0, bank: 0,
    airspeed: 0,
    stamina: pool,
    // --- phase-local clocks, all derived from t, so a snapshot is complete
    phaseT: 0,                 // seconds in the current phase
    leafV0: 0,                 // sink rate at the moment LEAF began
    recoverAt: null,           // t at which RECOVER was requested
    recoverPlan: null,         // { beatEnds, reopenEnds } once computed
    // --- provenance, so a log line can always say WHY the body did that
    lastEvent: null,           // { eventId, kind } of the last trusted event
    flownAs: 'PILOT',        // the phase a cut interrupted; recovery restores it
    launchV: 0,              // launch impulse (takeOff); shaped by launchT
    launchV0: 0, launchT: 0, launchNow: 0,
    downEventId: null,
    recoveryGeneration: null,
    events: [],                // emitted this step; caller drains
    ...over,
  };
}

// ---------------------------------------------------------------- events
// the adapter seam: the ONLY way the body learns it is down or recovered. Trusted, unverifiable here on purpose: the local
// HUD emits them for rehearsal, an adapter for real, and the body behaves identically.

/** Involuntary; never enterable by verb (down-spec §4). In the air it enters LEAF; on the ground it is a ragdoll where you
 *  stand (down-spec §2). */
/**
 * @param {FlightState} state
 * @param {{eventId?:string, state?:string}} [ev]
 * @returns {FlightState}
 */
export function bodyDown(state, ev = {}) {
  const { eventId, state: kind = 'DOWN' } = ev;
  const s = { ...state, events: [] };
  if (s.phase === 'LEAF' || s.phase === 'RAGDOLL') return s;   // already telling the truth
  s.downEventId = eventId ?? null;
  s.lastEvent = { eventId: eventId ?? null, kind };
  s.wings = 'LIMP';
  s.mode = 'reflex';
  // airborne: the leaf; grounded: ragdoll in place. Both involuntary, neither ever plays a landing animation. Remember who
  // had the controls, so recovery can hand them back.
  if (s.phase === 'PILOT' || s.phase === 'GLIDE') s.flownAs = s.phase;
  const airborne = s.pos.y > 0.5;
  s.phase = airborne ? 'LEAF' : 'RAGDOLL';
  s.phaseT = 0;
  s.leafV0 = Math.abs(s.vel.y);
  s.recoverAt = null; s.recoverPlan = null;
  s.events = [{ t: s.t, kind: airborne ? 'down.airborne' : 'down.grounded',
                eventId: eventId ?? null, altitude: s.pos.y }];
  return s;
}

/** The exit signal is capability itself (down-spec §3): mid-air this begins the sit-up, its plan computed here. */
/**
 * @param {FlightState} state
 * @param {{eventId?:string, recoveryGeneration?:string}} [ev]
 * @returns {FlightState}
 */
export function bodyRecovered(state, ev = {}) {
  const { eventId, recoveryGeneration } = ev;
  const s = { ...state, events: [] };
  if (s.phase !== 'LEAF' && s.phase !== 'RAGDOLL') return s;
  s.lastEvent = { eventId: eventId ?? null, kind: 'RECOVERED' };
  s.recoveryGeneration = recoveryGeneration ?? null;
  s.recoverAt = s.t;
  if (s.phase === 'RAGDOLL') {
    // ground case: SIT UP first, taking the full breath (down-spec §3): nothing that comes back should look like it never left
    s.phase = 'RECOVER';
    s.phaseT = 0;
    s.recoverPlan = { beatEnds: 0, reopenEnds: BREATH, ground: true };
    s.events = [{ t: s.t, kind: 'recover.situp', eventId: eventId ?? null }];
    return s;
  }
  return s;   // airborne: the plan is built by step(), which knows the beat phase
}

// ---------------------------------------------------------------- step
// one fixed timestep: same (cfg, state, dt, inputs) in, same state out, on any runtime. No clock, no randomness.

/**
 * @param {object} cfg          from makeConfig()
 * @param {FlightState} state   from initialState() or a previous step
 * @param {number} dt           fixed timestep, seconds
 * @param {FlightEnv} [env]
 * @returns {FlightState}
 */
export function step(cfg, state, dt, env = {}) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  const groundY = env.groundY ?? (() => 0);
  s.t += dt;
  s.phaseT += dt;

  switch (s.phase) {
    case 'LEAF':      stepLeaf(cfg, s, dt, groundY); break;
    case 'RECOVER':   stepRecover(cfg, s, dt, groundY); break;
    case 'GLIDE':     stepGlide(cfg, s, dt, env); break;
    case 'PILOT':     stepPilot(cfg, s, dt, env); break;
    case 'RAGDOLL':   /* the ragdoll owns the body; nothing to integrate */ break;
    case 'GROUND':
    case 'LANDED':    stepGround(cfg, s, dt); break;
    default:          break;
  }
  return s;
}

/** GLIDE's physics with the attitude from `env.input` (shared/flightpilot.js) instead of an autopilot; polar, stamina,
 *  bounds, ground contact and the leaf are identical, so a pilot and an agent fly the same. */
function stepPilot(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0);
  const inp = env.input || { bank: 0, pitch: 0, yawRate: 0, flap: false, spoil: false };
  s.bank = inp.bank ?? 0;
  s.pitch = inp.pitch ?? 0;
  s.yaw += (inp.yawRate ?? 0) * dt;

  // Airspeed is the pilot's to spend: nose down buys it, nose up sells it.
  s.airspeed = airspeedAfter(cfg, s.airspeed || bestGlide(cfg).speed, s.pitch, dt);

  // R1 STALL RECOVERY, a reflex, not a punishment (spec §3 R1): below stall the nose drops and the polar resumes. No flap-panic.
  if (s.airspeed < cfg.polar.minSpeed) {
    s.pitch = Math.min(s.pitch, -0.25);
    s.airspeed = cfg.polar.minSpeed;
    if (s.mode !== 'reflex') s.events.push({ t: s.t, kind: 'reflex.r1_stall' });
  }

  const lift = env.lift ? env.lift(s.pos.x, s.pos.y, s.pos.z) : 0;
  let sink = sinkRate(cfg, s.airspeed);
  if (inp.spoil) sink += (cfg.pilot?.spoilSink ?? 2.5);

  // Flapping is the expensive way to stay up (spec §5: -2/s, "I am a glider").
  let climb = 0;
  if (inp.flap && s.stamina > 0) {
    climb = cfg.pilot?.flapClimb ?? 2.2;
    s.stamina = Math.max(0, s.stamina - cfg.stamina.flapSustainPerSec * dt);
    if (s.stamina === 0) s.events.push({ t: s.t, kind: 'winded' });
  }

  // a launch impulse eases IN over ~1.5 s, peaks, then bleeds off: stepPilot assigns vel.y from the polar every frame,
  // so a one-frame boost would be thrown away
  if (s.launchV > 0.01 || (s.launchT ?? 0) > 0) {
    s.launchT = (s.launchT ?? 0) + dt;
    const spool = 1 - Math.exp(-s.launchT / 0.55);      // ~1.5s to full
    const fade = Math.exp(-Math.max(0, s.launchT - 1.2) / 1.4);
    s.launchNow = (s.launchV0 ?? s.launchV) * spool * fade;
    if (s.launchNow < 0.02 && s.launchT > 1.2) { s.launchV = 0; s.launchT = 0; s.launchNow = 0; }
  } else s.launchNow = 0;
  s.vel.y = -sink + lift + climb + (s.launchNow || 0);
  s.vel.x = Math.cos(s.yaw) * s.airspeed;
  s.vel.z = Math.sin(s.yaw) * s.airspeed;
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;

  bounds(cfg, s, dt);
  groundContact(cfg, s, groundY, /*ragdoll=*/false);
}

/** R3 bounds, authoritative for every airborne phase (live, plan, reflex; spec §3, §4). Soft: climb rate bleeds to zero across
 *  a margin, never a wall-slam. A LIMP body isn't steered (R2 owns it); its altitude is only capped.
 */
function bounds(cfg, s, dt) {
  const b = cfg.bounds;
  const limp = s.wings === 'LIMP';

  const r = Math.hypot(s.pos.x, s.pos.z);
  if (r > b.radius && !limp) {
    const inward = Math.atan2(-s.pos.z, -s.pos.x);
    // authority ramps in over the margin: a bank you see beginning is a bank, a discontinuity is a wall
    const over = Math.min(1, (r - b.radius) / Math.max(1e-6, b.softMargin));
    s.yaw += angleTo(s.yaw, inward) * Math.min(1, 1.5 * over * dt);
    if (!s._boundNote) { s.events.push({ t: s.t, kind: 'reflex.r3_bounds', radius: r }); s._boundNote = 1; }
  } else if (r <= b.radius) s._boundNote = 0;

  const soft = b.ceiling - b.softMargin;
  if (s.pos.y > soft && s.vel.y > 0 && !limp) {
    // bleed the climb out across the margin; at the ceiling it is zero
    const k = Math.min(1, (s.pos.y - soft) / Math.max(1e-6, b.softMargin));
    s.vel.y *= (1 - k);
    if (!s._ceilNote) { s.events.push({ t: s.t, kind: 'reflex.r3_ceiling', altitude: s.pos.y }); s._ceilNote = 1; }
  } else if (s.pos.y <= soft) s._ceilNote = 0;
  // a hard stop only as a backstop for a body above the ceiling some other way (a teleport, a bad initial state)
  if (s.pos.y > b.ceiling) { s.pos.y = b.ceiling; if (s.vel.y > 0) s.vel.y = 0; }
}

function angleTo(from, to) {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

function stepLeaf(cfg, s, dt, groundY) {
  const a = leafAt(cfg, s.phaseT, s.leafV0);
  s.bank = a.bank; s.pitch = a.pitch;
  s.yaw += a.yawRate * dt;
  s.vel.y = a.vy;
  // LATERAL is perpendicular to the heading: forward is (cos yaw, sin yaw), so sideways is (-sin yaw, cos yaw)
  s.vel.x = -Math.sin(s.yaw) * a.drift;
  s.vel.z = Math.cos(s.yaw) * a.drift;
  bounds(cfg, s, dt);
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;

  // a recovery request: plan it now the beat phase is known, and clamp the WHOLE transition to the acceptance band
  if (s.recoverAt != null && !s.recoverPlan) {
    const beat = cfg.recover.finishBeat ? beatRemaining(cfg, s.phaseT) : 0;
    let total = beat + cfg.recover.reopenTime;
    total = clamp(total, cfg.recover.minTotal, cfg.recover.maxTotal);
    const beatEnds = Math.min(beat, Math.max(0, total - 0.05));
    s.recoverPlan = { beatEnds: s.phaseT + beatEnds, reopenEnds: s.phaseT + total, ground: false };
    s.events.push({ t: s.t, kind: 'recover.begin', altitude: s.pos.y,
                    beatWait: beatEnds, total });
  }
  if (s.recoverPlan && s.phaseT >= s.recoverPlan.reopenEnds) {
    // wings reload; flight resumes (recovery altitude is logged, down-spec §3), back to whoever was flying: `flownAs`
    // restores PILOT or GLIDE
    s.phase = s.flownAs === 'PILOT' ? 'PILOT' : 'GLIDE';
    s.wings = 'OPEN'; s.mode = 'live';
    s.bank = 0; s.pitch = 0;        // wings level on waking; the leaf's attitude was not yours
    s.phaseT = 0; s.recoverPlan = null;
    s.airspeed = Math.max(cfg.polar.minSpeed, bestGlide(cfg).speed * 0.8);
    s.events.push({ t: s.t, kind: 'recover.airborne', altitude: s.pos.y,
                    recoveryGeneration: s.recoveryGeneration });
  }

  groundContact(cfg, s, groundY, /*ragdoll=*/true);
}

function stepRecover(cfg, s, dt, groundY) {
  // ground sit-up: the caller animates it over `reopenEnds` seconds, but the phase is held so nothing else claims the body
  // mid-rise, and onlookers see the honest middle state
  if (s.phaseT >= (s.recoverPlan?.reopenEnds ?? BREATH)) {
    // standing up puts you on your feet: from y=0 stepPilot would find ground and flip to LANDED. takeOff() is the way back.
    s.phase = 'GROUND';
    s.wings = 'OPEN'; s.mode = 'live';
    s.bank = 0; s.pitch = 0;
    s.phaseT = 0; s.recoverPlan = null;
    s.events.push({ t: s.t, kind: 'recover.stood' });
  }
}

function stepGlide(cfg, s, dt, env) {
  const groundY = env.groundY ?? (() => 0);
  const lift = env.lift ? env.lift(s.pos.x, s.pos.y, s.pos.z) : 0;
  const sink = sinkRate(cfg, s.airspeed || bestGlide(cfg).speed);
  s.vel.y = -sink + lift;
  s.vel.x = Math.cos(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  s.vel.z = Math.sin(s.yaw) * (s.airspeed || bestGlide(cfg).speed);
  bounds(cfg, s, dt);
  s.pos.x += s.vel.x * dt;
  s.pos.y += s.vel.y * dt;
  s.pos.z += s.vel.z * dt;
  // Glide is stamina-neutral (spec §5).
  groundContact(cfg, s, groundY, /*ragdoll=*/false);
}

function stepGround(cfg, s, dt) {
  const r = cfg.stamina.refillGroundPerSec;
  s.stamina = Math.min(cfg.stamina.pool, s.stamina + r * dt);
}

/** NO AUTOLAND: a body in LEAF hits the ground as a ragdoll, no landing animation and no last-metre mercy hover (T4's whole
 *  point, and why this takes a flag instead of deciding). */
function groundContact(cfg, s, groundY, ragdoll) {
  const gy = groundY(s.pos.x, s.pos.z);
  if (s.pos.y - gy > cfg.bounds.groundClearance) return;
  // capture the impact BEFORE zeroing it: the receipt reports the speed it hit the ground at
  const impactV = Math.abs(s.vel.y);
  const impactSpeed = Math.hypot(s.vel.x, s.vel.y, s.vel.z);
  s.pos.y = gy;
  s.vel = { x: 0, y: 0, z: 0 };
  if (ragdoll) {
    s.phase = 'RAGDOLL'; s.wings = 'LIMP'; s.mode = 'reflex';
    s.events.push({ t: s.t, kind: 'ground.ragdoll',
                    impactV, impactSpeed, entrySink: s.leafV0,
                    eventId: s.downEventId });
  } else {
    s.phase = 'LANDED'; s.mode = 'live';
    s.events.push({ t: s.t, kind: 'ground.landed', impactV, impactSpeed });
  }
  s.phaseT = 0;
}

/** fold_down (spec §1): ground only; grounds the flier (the vigil posture, §2 FOLDED). A body in the air is told to land
 *  first. Unfolding is explicit; take_off never does it for you. */
export function foldDown(cfg, state) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  if (s.phase !== 'GROUND' && s.phase !== 'LANDED') {
    // limp wings are a body down (LEAF, RAGDOLL, RECOVER), in the air or on the ground; open ones a body flying
    const reason = s.wings === 'LIMP'
      ? `you're not on your feet (${s.phase.toLowerCase()}); you can fold them once you're standing again`
      : `airborne (${s.phase.toLowerCase()}); wings fold only on the ground, so land first`;
    s.events.push({ t: s.t, kind: 'fold.refused', reason });
    return s;
  }
  if (s.wings === 'LIMP') {
    s.events.push({ t: s.t, kind: 'fold.refused', reason: "your wings are limp; you can fold them once you're standing again" });
    return s;
  }
  if (s.wings === 'FOLDED') {
    s.events.push({ t: s.t, kind: 'fold.refused', reason: 'already folded' });
    return s;
  }
  s.wings = 'FOLDED';
  s.events.push({ t: s.t, kind: 'wings.folded' });
  return s;
}

/** The explicit act that ends the vigil. */
export function unfold(cfg, state) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  if (s.wings !== 'FOLDED') {
    const reason = s.wings === 'LIMP'
      ? "they're limp, not folded; they open again once you've recovered"
      : 'already open';
    s.events.push({ t: s.t, kind: 'unfold.refused', reason });
    return s;
  }
  s.wings = 'OPEN';
  s.events.push({ t: s.t, kind: 'wings.open' });
  return s;
}

/** take_off (spec §1): ground -> air. Needs standing and unfolded wings (refuses rather than unfolding); costs the climb it
 *  grants; the jump-launch boost (9 m/s ≈ 4 s, 4 m) tells flying from a stumble. */
export function takeOff(cfg, state, { launchSpeed = null, boost = null, groundY = null } = {}) {
  const s = { ...state, pos: { ...state.pos }, vel: { ...state.vel }, events: [] };
  // the config's boost unless overridden, so `cfg.pilot.launchBoost` is the one number take-off and its watchers read
  boost = boost ?? cfg.pilot?.launchBoost ?? 9.0;
  if (s.wings === 'FOLDED') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: 'your wings are folded; unfold them first' });
    return s;
  }
  if (s.wings === 'LIMP') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: "your wings are limp; they open again once you've recovered" });
    return s;
  }
  if (s.phase !== 'GROUND' && s.phase !== 'LANDED') {
    s.events.push({ t: s.t, kind: 'takeoff.refused', reason: `already airborne (${s.phase.toLowerCase()})` });
    return s;
  }
  s.phase = 'PILOT'; s.mode = 'live';
  s.airspeed = launchSpeed ?? bestGlide(cfg).speed;
  // clear the GROUND, not the world origin: the caller passes the height under the feet (terrain isn't at zero)
  s.pos.y = (groundY ?? 0) + cfg.bounds.groundClearance + 0.6;
  s.launchV = boost; s.launchV0 = boost; s.launchT = 0;   // shaped in stepPilot
  s.bank = 0; s.pitch = 0;
  s.phaseT = 0;
  s.stamina = Math.max(0, s.stamina - boost * cfg.stamina.climbPerMetre);
  s.events.push({ t: s.t, kind: 'took off', altitude: s.pos.y });
  return s;
}

// ---------------------------------------------------------------- consent
// `consent.canLandAt(flier, target)` is INJECTED and fakeable: the production registry is out of scope, and a gate that
// can't be tested with a stub has never been seen to fail.

/** The always-deny default: a caller that forgets to inject a consent provider gets refusal, not permission (spec §1
 *  land_at(person) is a HARD GATE; a missing dependency must fail safe). */
export const denyAllConsent = {
  canLandAt: () => false,
};

/** Build a consent stub for tests: allow/deny, and revocable mid-descent. */
export function fakeConsent(initial = false) {
  let allowed = initial;
  return {
    canLandAt: () => allowed,
    grant() { allowed = true; },
    revoke() { allowed = false; },
  };
}

// ---------------------------------------------------------------- util
function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
