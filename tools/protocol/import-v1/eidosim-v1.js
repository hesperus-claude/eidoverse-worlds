// sim: the deterministic sim fold (spec/history/PROTOCOL-v2-sim.md, dialect 3), as one pure module: the reference eidosim. Fold
// an epoch's sim-scoped entries through it, advance to a tick, and every conforming implementation holds bit-identical
// state: that is the whole covenant.
//
// Covenant I (owned numerics): ONLY IEEE-754 exact host operations (+ − × ÷, sqrt, comparisons, min/max/abs). No
// Math.sin/cos/exp/pow (yaw goes through simmath's sinT/cosT), no Date.now(), no randomness, no unordered iteration
// (bodies/statics are plain objects in the log's entry order). Number→string is ECMA shortest-round-trip, so JSON of
// this state is a deterministic serialization: digests may be taken over it directly.
//
// This build carries each retired sim unchanged (Covenant II: old logs replay under the law they were written under, bit
// for bit); what each version's law is: README.md#eidosim-v1-versions.
//
// Shared by all:
//   - one intent: `punt` (dialect-3 form: dir REQUIRED — Covenant III, the
//     entry carries everything; presence never enters the sim);
//   - ballistic integration, semi-implicit Euler at the epoch's fixed tick;
//   - authored word wins: place/spawn/remove/mount/dismount/motion naming a
//     live body releases it to the instant fold (§6 draft ruling);
//   - a foreign epoch (a sim this build does not carry) is honored by
//     REFUSAL: recorded, never recomputed (Covenant II — a wrong answer is
//     worse than no answer; the barrier snapshot is the truth then).
//
// Conformance order (normative for callers): per entry, foldEntry FIRST,
// then simEntry — punts read the instant fold's entity as it stood when the
// intent landed, and a collider change takes effect at ITS entry's tick
// (simEntry advances to it before touching the statics). Advancement is
// per-tick fixed-step, so any advance schedule reaching tick T yields the
// same state: snapshots may cut anywhere.

import { terrainParams, makeHeightField } from '../../../shared/terrainmath.js';
import { sinT, cosT } from '../../../shared/simmath.js';

// What the epoch verb MINTS (new epochs enter this sim)…
export const SIM_ID = 'eidosim@0.5.0';
// …and what this build can still REPLAY (a carried sim is never foreign).
const V1 = 'eidosim@0.1.0';
const V2 = 'eidosim@0.2.0';
const V3 = 'eidosim@0.3.0';
const V4 = 'eidosim@0.4.0';
const CARRIED = new Set([V1, V2, V3, V4, SIM_ID]);
/** The law a carried name means, as a rung: 1 flat floor · 2 terrain ·
 *  3 endpoint · 4 first contact · 5 remaining-motion sweeps. 0 = not carried. */
const lawOf = (name) => name === V1 ? 1 : name === V2 ? 2 : name === V3 ? 3 : name === V4 ? 4 : name === SIM_ID ? 5 : 0;

// the physics constants ARE the sim version: editing any is an epoch bump, never a patch (Covenant II)
const G = 9.8;                  // m/s² downward
const RESTITUTION = 0.45;       // bounce keep — vertical off ground, horizontal off a wall (0.3)
const BOUNCE_FRICTION = 0.75;   // tangential keep per bounce
const GROUND_FRICTION = 0.85;   // horizontal keep per grounded tick (slide)
const REST_SPEED2 = 0.0225;     // (0.15 m/s)² — below this, grounded: rest
const MAX_POWER = 20;           // m/s launch cap
const MIN_TICK_MS = 16, MAX_TICK_MS = 1000;
const MAX_FLIGHT_TICKS = 20000; // runaway backstop: force rest (~22min @66ms)
const STEP_DOWN = 0.3;          // 0.3: a glued slider follows ground down at most this far per tick; beyond it, it falls

/** @typedef {{ p: number[], v: number[], yaw: number, ground: number,
 *              seq: number, born: number, resting: boolean,
 *              box?: number[][] | null, scale?: number,
 *              ext?: { cx: number, cz: number, hx: number, hz: number, y0: number, y1: number } | null,
 *              on?: string | null }} SimBody */
/** @typedef {{ epoch: { sim: string, tickMs: number, ts: number, seq: number,
 *                       foreign?: boolean } | null,
 *              tick: number, bodies: Record<string, SimBody>,
 *              terrain?: ReturnType<typeof terrainParams> | null,
 *              boxes?: Record<string, number[][]>,
 *              statics?: Record<string, { aabb: number[][] }> }} SimState */

/** @returns {SimState} */
export const emptySim = () => ({ epoch: null, tick: 0, bodies: {}, terrain: null });

/** The Covenant-IV quantization: the first tick boundary at or after ts.
 *  @param {SimState} sim @param {number} ts */
export function tickOf(sim, ts) {
  if (!sim.epoch) return 0;
  const raw = (ts - sim.epoch.ts) / sim.epoch.tickMs;
  const t = Math.ceil(raw);
  return t > 0 ? t : 0;
}

// ---- 0.3 geometry: boxes, extents, world AABBs ------------------------------

const vec3ok = (a) => Array.isArray(a) && a.length === 3
  && Number.isFinite(a[0]) && Number.isFinite(a[1]) && Number.isFinite(a[2]);
/** A stamped box: [[minx,miny,minz],[maxx,maxy,maxz]], min ≤ max per axis. */
const boxOk = (b) => Array.isArray(b) && b.length === 2 && vec3ok(b[0]) && vec3ok(b[1])
  && b[0][0] <= b[1][0] && b[0][1] <= b[1][1] && b[0][2] <= b[1][2];

/** A scaled, yaw-rotated local box's world AABB: centre offset (cx, cz), half-extents (hx, hz), and bottom/top
 *  offsets (y0, y1) from the origin. Yaw goes through simmath (Covenant I). */
function extentsOf(box, scale, yaw) {
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const cx = (box[0][0] + box[1][0]) * 0.5 * s, cz = (box[0][2] + box[1][2]) * 0.5 * s;
  const hx = (box[1][0] - box[0][0]) * 0.5 * s, hz = (box[1][2] - box[0][2]) * 0.5 * s;
  const c = cosT(yaw), sn = sinT(yaw);
  const ac = Math.abs(c), as = Math.abs(sn);
  return { cx: cx * c + cz * sn, cz: -cx * sn + cz * c,
    hx: hx * ac + hz * as, hz: hx * as + hz * ac, y0: box[0][1] * s, y1: box[1][1] * s };
}
const aabbAt = (p, e) => [[p[0] + e.cx - e.hx, p[1] + e.y0, p[2] + e.cz - e.hz],
  [p[0] + e.cx + e.hx, p[1] + e.y1, p[2] + e.cz + e.hz]];

/** (0.3) Make the fold entity `id` a static collider from its lib's box, or drop it if its lib has none. */
function setStatic(sim, id, ent) {
  if (!sim.statics) return;
  const box = ent && typeof ent.lib === 'string' ? sim.boxes?.[ent.lib] : null;
  if (!box || !vec3ok(ent.pos)) { delete sim.statics[id]; return; }
  const e = extentsOf(box, ent.scale, typeof ent.yaw === 'number' ? ent.yaw : 0);
  sim.statics[id] = { aabb: aabbAt(ent.pos, e) };
}
/** (0.3) A body at rest is a static again, at its own word. */
function restStatic(sim, id, b) {
  if (!sim.statics || !b.ext) return;
  sim.statics[id] = { aabb: aabbAt(b.p, b.ext) };
}

/** 0.5 only: consume the remaining time after each contact, including a
 *  time-zero landing. Contact ties follow static insertion order, then x/y/z.
 *  Existing overlaps still belong to the endpoint resolver below. */
function sweepMotion(sim, id, b, dt, hf) {
  const e = b.ext;
  let remaining = dt;
  for (let contacts = 0; contacts < 8 && remaining > 0; contacts++) {
    const d = [b.v[0] * remaining, b.v[1] * remaining, b.v[2] * remaining];
    const [lo, hi] = aabbAt(b.p, e);
    let hitT = Infinity, hitAxis = -1, hit = null;
    // the support plane participates too: on a coarse tick a gravity-displaced endpoint below ground can miss a wall
    // above it; terrain is sampled again at contact and by the final ground resolver
    const floor = hf ? hf(b.p[0], b.p[2]) : b.ground;
    const floorT = d[1] < 0 ? Math.max(0, (floor - b.p[1]) / d[1]) : Infinity;
    if (floorT <= 1) { hitT = floorT; hitAxis = 1; }
    for (const sid in sim.statics) {
      if (sid === id) continue;
      const s = sim.statics[sid].aabb;
      let enter = -Infinity, exit = Infinity, axis = -1;
      for (let k = 0; k < 3; k++) {
        if (d[k] === 0) {
          if (hi[k] <= s[0][k] || lo[k] >= s[1][k]) { enter = Infinity; break; }
          continue;
        }
        const inv = 1 / d[k];
        const a = (d[k] > 0 ? s[0][k] - hi[k] : s[1][k] - lo[k]) * inv;
        const z = (d[k] > 0 ? s[1][k] - lo[k] : s[0][k] - hi[k]) * inv;
        if (a > enter) { enter = a; axis = k; }
        if (z < exit) exit = z;
      }
      if (enter >= 0 && enter <= 1 && enter < exit && enter < hitT) {
        hitT = enter; hitAxis = axis; hit = s;
      }
    }
    if (hitT === Infinity) {
      for (let k = 0; k < 3; k++) b.p[k] = b.p[k] + d[k];
      return;
    }
    for (let k = 0; k < 3; k++) b.p[k] = b.p[k] + d[k] * hitT;
    // exact face placement avoids sinking into the support on the next sweep
    if (!hit) b.p[1] = hf ? hf(b.p[0], b.p[2]) : b.ground;
    else if (hitAxis === 0) b.p[0] = d[0] > 0 ? hit[0][0] - e.hx - e.cx : hit[1][0] + e.hx - e.cx;
    else if (hitAxis === 2) b.p[2] = d[2] > 0 ? hit[0][2] - e.hz - e.cz : hit[1][2] + e.hz - e.cz;
    else b.p[1] = d[1] > 0 ? hit[0][1] - e.y1 : hit[1][1] - e.y0;
    if (hitAxis === 1 && d[1] < 0) {
      if (-b.v[1] > 2 * G * dt) {
        b.v[1] = -b.v[1] * RESTITUTION;
        b.v[0] = b.v[0] * BOUNCE_FRICTION;
        b.v[2] = b.v[2] * BOUNCE_FRICTION;
      } else b.v[1] = 0;
    } else {
      b.v[hitAxis] = -b.v[hitAxis] * RESTITUTION;
      for (let k = 0; k < 3; k++) if (k !== hitAxis) b.v[k] = b.v[k] * BOUNCE_FRICTION;
    }
    remaining = remaining * (1 - hitT);
  }
}

/** Advance every live body to `toTick` by fixed steps. Pure of wall time.
 *  @param {SimState} sim @param {number} toTick */
export function advanceSim(sim, toTick) {
  if (!sim.epoch || sim.epoch.foreign) { sim.tick = toTick > sim.tick ? toTick : sim.tick; return sim; }
  const dt = sim.epoch.tickMs / 1000;
  const law = lawOf(sim.epoch.sim);
  const v2 = law >= 2, v3 = law >= 3, v4 = law >= 4, v5 = law >= 5;
  const hf = v2 && sim.terrain ? heightFieldOf(sim) : null;
  // no live body: only the counter could change, so jump (a long gap must not be walked tick by tick); the live count
  // lets settling the last body mid catch-up jump the rest too
  let live = 0;
  for (const id in sim.bodies) if (!sim.bodies[id].resting) live++;
  if (!live) { if (toTick > sim.tick) sim.tick = toTick; return sim; }
  while (sim.tick < toTick) {
    sim.tick++;
    for (const id in sim.bodies) {
      const b = sim.bodies[id];
      if (b.resting) continue;
      const prevBottom = b.ext ? b.p[1] + b.ext.y0 : b.p[1];
      const p0x = b.p[0], p0y = b.p[1], p0z = b.p[2];
      b.v[1] = b.v[1] - G * dt;
      b.p[0] = b.p[0] + b.v[0] * dt;
      b.p[1] = b.p[1] + b.v[1] * dt;
      b.p[2] = b.p[2] + b.v[2] * dt;
      // the floor under the body THIS tick: the terrain law (0.2+ epochs with a terrain), else the flat launch-height floor
      // (0.1 law, and the fallback for terrainless worlds)
      let g = hf ? hf(b.p[0], b.p[2]) : b.ground;
      let sweptLanding = false;
      if (v5 && b.ext && sim.statics) {
        b.p[0] = p0x; b.p[1] = p0y; b.p[2] = p0z;
        sweepMotion(sim, id, b, dt, hf);
        g = hf ? hf(b.p[0], b.p[2]) : b.ground;
      } else if (v4 && b.ext && sim.statics) {
        // 0.4: SWEEP the body's box along this tick's displacement and take the earliest contact (a slab test per static, exact ops)
        const dx = b.p[0] - p0x, dy = b.p[1] - p0y, dz = b.p[2] - p0z;
        const e = b.ext;
        const lo = [p0x + e.cx - e.hx, p0y + e.y0, p0z + e.cz - e.hz];
        const hi = [p0x + e.cx + e.hx, p0y + e.y1, p0z + e.cz + e.hz];
        const d = [dx, dy, dz];
        let hitT = Infinity, hitAxis = -1, hitId = null;
        for (const sid in sim.statics) {
          if (sid === id) continue;
          const s = sim.statics[sid].aabb;
          let tEnter = -Infinity, tExit = Infinity, axis = -1;
          for (let k = 0; k < 3; k++) {
            if (d[k] === 0) {
              if (hi[k] <= s[0][k] || lo[k] >= s[1][k]) { tEnter = Infinity; break; }
              continue;
            }
            const inv = 1 / d[k];
            const tA = (d[k] > 0 ? s[0][k] - hi[k] : s[1][k] - lo[k]) * inv;
            const tB = (d[k] > 0 ? s[1][k] - lo[k] : s[0][k] - hi[k]) * inv;
            if (tA > tEnter) { tEnter = tA; axis = k; }
            if (tB < tExit) tExit = tB;
          }
          // a contact WITHIN this tick, not already overlapping (0.3's endpoint code owns that) and not merely grazing
          if (tEnter >= 0 && tEnter <= 1 && tEnter < tExit && tEnter < hitT) { hitT = tEnter; hitAxis = axis; hitId = sid; }
        }
        if (hitId !== null) {
          const s = sim.statics[hitId].aabb;
          // to the contact, exactly: the touching face placed by the static's own coordinate, the free axes by the fraction
          b.p[0] = hitAxis === 0 ? (dx > 0 ? s[0][0] - e.hx - e.cx : s[1][0] + e.hx - e.cx) : p0x + dx * hitT;
          b.p[2] = hitAxis === 2 ? (dz > 0 ? s[0][2] - e.hz - e.cz : s[1][2] + e.hz - e.cz) : p0z + dz * hitT;
          b.p[1] = hitAxis === 1 ? (dy > 0 ? s[0][1] - e.y1 : s[1][1] - e.y0) : p0y + dy * hitT;
          if (hitAxis === 1 && dy < 0) {
            // a top met from above: a LANDING under the contact law
            g = s[1][1] - e.y0; b.on = hitId; sweptLanding = true;
            if (-b.v[1] > 2 * G * dt) {
              b.v[1] = -b.v[1] * RESTITUTION;
              b.v[0] = b.v[0] * BOUNCE_FRICTION;
              b.v[2] = b.v[2] * BOUNCE_FRICTION;
            } else {
              b.v[1] = 0;
            }
          } else {
            // a side (or an underside): the wall bounce, at the wall
            b.v[hitAxis] = -b.v[hitAxis] * RESTITUTION;
            for (let k = 0; k < 3; k++) if (k !== hitAxis && k !== 1) b.v[k] = b.v[k] * BOUNCE_FRICTION;
            if (hitAxis !== 1) b.v[1] = b.v[1] * BOUNCE_FRICTION;
          }
          g = hf ? Math.max(g, hf(b.p[0], b.p[2])) : g;   // the terrain under the contact point
        }
      }
      if (v3 && b.ext && sim.statics && !sweptLanding) {
        // 0.3: the world's things. Statics in insertion order (the log's).
        let on = null;
        let bb = aabbAt(b.p, b.ext);
        for (const sid in sim.statics) {
          if (sid === id) continue;
          const s = sim.statics[sid].aabb;
          if (bb[1][0] <= s[0][0] || bb[0][0] >= s[1][0] || bb[1][2] <= s[0][2] || bb[0][2] >= s[1][2]) continue;
          if (prevBottom >= s[1][1]) {
            // it was above this thing's top: the top is ground for it
            const gs = s[1][1] - b.ext.y0;
            if (gs > g) { g = gs; on = sid; }
          } else if (bb[1][1] > s[0][1] && bb[0][1] < s[1][1]) {
            // it met a side: push out along the shallower horizontal overlap and reflect that velocity (a wall bounce)
            const px = Math.min(bb[1][0] - s[0][0], s[1][0] - bb[0][0]);
            const pz = Math.min(bb[1][2] - s[0][2], s[1][2] - bb[0][2]);
            if (px <= pz) {
              const toward = (b.p[0] + b.ext.cx) < (s[0][0] + s[1][0]) * 0.5;
              b.p[0] = b.p[0] + (toward ? -px : px);
              b.v[0] = -b.v[0] * RESTITUTION;
              b.v[2] = b.v[2] * BOUNCE_FRICTION;
            } else {
              const toward = (b.p[2] + b.ext.cz) < (s[0][2] + s[1][2]) * 0.5;
              b.p[2] = b.p[2] + (toward ? -pz : pz);
              b.v[2] = -b.v[2] * RESTITUTION;
              b.v[0] = b.v[0] * BOUNCE_FRICTION;
            }
            bb = aabbAt(b.p, b.ext);
          }
        }
        b.on = on;
      }
      if (sweptLanding) {
        // already resolved at the contact above; only the grounded slide/rest logic below may still apply (v[1] === 0 ⇒ it does)
      } else if (b.p[1] < g && b.v[1] < 0) {
        b.p[1] = g;
        // an impact slower than two gravity-ticks is resting CONTACT, not a bounce, or the terminal micro-bounce feeds v[1]
        // from gravity forever and rest is never reached
        if (-b.v[1] > 2 * G * dt) {
          b.v[1] = -b.v[1] * RESTITUTION;
          b.v[0] = b.v[0] * BOUNCE_FRICTION;
          b.v[2] = b.v[2] * BOUNCE_FRICTION;
        } else {
          b.v[1] = 0;
        }
      } else if (v2 && b.p[1] <= g && b.v[1] >= 0) {
        // 0.2+: flying INTO rising ground (a hillside) splats to contact; a grounded slider (v[1] === 0) is GLUED to the
        // terrain, following it down and up rather than launching off every bump
        b.p[1] = g;
        b.v[1] = 0;
      } else if (v2 && b.v[1] === 0) {
        // 0.3 only: a step down is followed; a drop (the crate edge) is a fall, gravity's next tick. 0.2 glues unconditionally.
        if (!v3 || b.p[1] - g <= STEP_DOWN) b.p[1] = g;
      }
      if (b.p[1] === g && b.v[1] === 0) {
        // grounded: slide out under friction, then rest
        b.v[0] = b.v[0] * GROUND_FRICTION;
        b.v[2] = b.v[2] * GROUND_FRICTION;
        if (b.v[0] * b.v[0] + b.v[2] * b.v[2] < REST_SPEED2) {
          b.v[0] = 0; b.v[2] = 0; b.resting = true;
          if (v3) restStatic(sim, id, b);
        }
      }
      if (!b.resting && sim.tick - b.born > MAX_FLIGHT_TICKS) {
        b.v[0] = 0; b.v[1] = 0; b.v[2] = 0;
        b.p[1] = hf ? hf(b.p[0], b.p[2]) : b.ground;
        b.resting = true;
        if (v3) restStatic(sim, id, b);
      }
      if (b.resting) live--;
    }
    if (!live) { if (toTick > sim.tick) sim.tick = toTick; break; }
  }
  return sim;
}

// compiled height functions, keyed by the terrain PARAMS OBJECT's identity and kept outside SimState so it stays plain JSON
const _fields = new WeakMap();
function heightFieldOf(sim) {
  let f = _fields.get(sim.terrain);
  if (!f) { f = makeHeightField(sim.terrain); _fields.set(sim.terrain, f); }
  return f;
}

/** The verbs whose authoring RELEASES a body: the instant fold's word wins over recomputation once the entity is re-authored. */
const RELEASERS = new Set(['place', 'spawn', 'remove', 'mount', 'dismount', 'motion', 'light']);   // light: a lamp may reuse an entity id wholesale
/** (0.3) …and of those, the ones after which the entity stands still where the fold says (a collider again), vs. moves
 *  in ways the sim cannot follow. */
const RESEATERS = new Set(['place', 'spawn', 'dismount', 'light']);   // (a light has no box: setStatic drops it)

/** Fold one entry into the sim. Total, like the instant fold: nothing here
 *  may throw, and a malformed intent shapes nothing. Call AFTER foldEntry.
 *  @param {SimState} sim
 *  @param {{ seq: number, ts: number, actor: string, verb: string,
 *            args: Record<string, unknown> }} entry
 *  @param {{ entities: Record<string, { pos: number[], yaw?: number, lib?: string, scale?: number }> }} st
 *    the instant fold, already folded through this entry */
export function simEntry(sim, entry, st) {
  const a = /** @type {any} */ (entry.args);
  if (entry.verb === 'epoch') {
    if (a && a.sim === null) {
      // `sim: null` (literally) ENDS the epoch, after the sequencer released every body into the fold; a missing or
      // malformed `sim` is not an exit and shapes nothing
      if (!sim.epoch) return;
      sim.epoch = null; sim.tick = 0; sim.bodies = {}; sim.terrain = null;
      delete sim.boxes; delete sim.statics;
      return;
    }
    const simName = typeof a?.sim === 'string' ? a.sim : null;
    const tickMs = a?.tickMs;
    if (!simName || !Number.isInteger(tickMs) || tickMs < MIN_TICK_MS || tickMs > MAX_TICK_MS) return;
    // a new epoch REPLACES: old bodies are released where the last barrier (or the sequencer's epoch-release places) left
    // them; the barrier fold around the entry makes that safe (PROTOCOL_v2 §3)
    sim.epoch = { sim: simName, tickMs, ts: entry.ts, seq: entry.seq,
      ...(CARRIED.has(simName) ? {} : { foreign: true }) };
    sim.tick = 0;
    sim.bodies = {};
    // 0.2+ epochs adopt the world's standing terrain (the instant fold's word, already folded through this entry); 0.1
    // epochs keep their flat law: sim.terrain stays null so the old advance path cannot see it
    sim.terrain = simName !== V1 && CARRIED.has(simName) && /** @type {any} */(st)?.terrain
      ? terrainParams(/** @type {any} */(st).terrain) : null;
    // 0.3 epochs adopt the sequencer's word on the world's geometry: the stamped lib → box table, every standing entity it
    // covers a static. Older laws never see these fields (their JSON is unchanged)
    if (lawOf(simName) >= 3) {
      sim.boxes = {};
      const bx = a.boxes;
      if (bx && typeof bx === 'object' && !Array.isArray(bx)) {
        for (const lib in bx) if (boxOk(bx[lib])) sim.boxes[lib] = bx[lib];
      }
      sim.statics = {};
      const ents = st?.entities ?? {};
      for (const id in ents) setStatic(sim, id, ents[id]);
    } else {
      delete sim.boxes; delete sim.statics;
    }
    return;
  }
  if (!sim.epoch || sim.epoch.foreign) return;   // pre-epoch logs keep v1 semantics whole
  const v3 = lawOf(sim.epoch.sim) >= 3;
  if (entry.verb === 'terrain' && sim.epoch.sim !== V1) {
    // the ground moved wholesale: adopt the new law and release EVERY body to the instant fold, which re-seats them on
    // the new terrain (the sim must not keep flying over a floor that no longer exists)
    advanceSim(sim, tickOf(sim, entry.ts));
    sim.terrain = terrainParams(a ?? {});
    sim.bodies = {};
    if (sim.statics) {
      // …and the statics are rebuilt from the instant fold: a rested body's static sits at its SIM-rest pose, which
      // the fold doesn't know, so left standing it would be an invisible box away from the rendered thing
      sim.statics = {};
      const ents = st?.entities ?? {};
      for (const id in ents) setStatic(sim, id, ents[id]);
    }
    return;
  }
  if (entry.verb === 'punt') {
    if (!a?.id || !vec3ok(a.dir)) return;        // dialect-3 punt carries its vector or is inert
    const ent = st.entities[a.id];
    if (!ent || !vec3ok(ent.pos)) return;
    const len2 = a.dir[0] * a.dir[0] + a.dir[1] * a.dir[1] + a.dir[2] * a.dir[2];
    if (!(len2 > 0)) return;
    const len = Math.sqrt(len2);
    let power = Number.isFinite(a.power) ? a.power : 6;
    if (power <= 0) return;
    if (power > MAX_POWER) power = MAX_POWER;
    advanceSim(sim, tickOf(sim, entry.ts));
    const prior = sim.bodies[a.id];              // re-punting a flying body kicks it mid-air
    const p = prior ? prior.p : [ent.pos[0], ent.pos[1], ent.pos[2]];
    const ground = prior ? prior.ground : ent.pos[1];
    const yaw = typeof ent.yaw === 'number' ? ent.yaw : 0;
    const k = power / len;
    delete sim.bodies[a.id];                     // re-insert: body order follows LAST intent
    const body = { p, v: [a.dir[0] * k, a.dir[1] * k, a.dir[2] * k],
      yaw, ground, seq: entry.seq, born: sim.tick, resting: false };
    if (v3) {
      // 0.3: the body carries its own box (its lib's stamped one) and is no longer a static: it is the thing that moves now
      const box = typeof ent.lib === 'string' ? sim.boxes?.[ent.lib] ?? null : null;
      const scale = Number.isFinite(ent.scale) && ent.scale > 0 ? ent.scale : 1;
      Object.assign(body, { box, scale, ext: box ? extentsOf(box, scale, yaw) : null, on: null });
      if (sim.statics) delete sim.statics[a.id];
    }
    sim.bodies[a.id] = body;
    return;
  }
  if (v3 && entry.verb === 'spawn' && a?.id && typeof a.lib === 'string' && boxOk(a.box)) {
    // the sequencer's stamp for a model this epoch had not seen
    sim.boxes[a.lib] = a.box;
  }
  if (RELEASERS.has(entry.verb) && a?.id != null) {
    if (v3 && sim.statics) {
      // a collider change takes effect at ITS entry's tick: advance first, so any schedule reaching a later tick agrees (Covenant IV)
      advanceSim(sim, tickOf(sim, entry.ts));
      if (RESEATERS.has(entry.verb)) setStatic(sim, a.id, st.entities[a.id]);
      else delete sim.statics[a.id];
    }
    if (sim.bodies[a.id]) delete sim.bodies[a.id];
  }
}

/** The composition read: where the sim says this entity is, or null if the instant fold owns it.
 *  @param {SimState} sim @param {string} id */
export function simPose(sim, id) {
  const b = sim.bodies[id];
  return b ? { p: b.p, yaw: b.yaw, resting: b.resting } : null;
}

/** Deterministic serialization for digests and wire: plain JSON is exact, keys in the fold's insertion order.
 *  `terrain`, `boxes` and `statics` ride so a restored snapshot collides as the live fold did; older laws carry none. */
export const simSnapshot = (sim) => ({ epoch: sim.epoch, tick: sim.tick, bodies: sim.bodies,
  ...(sim.terrain ? { terrain: sim.terrain } : {}),
  ...(sim.boxes ? { boxes: sim.boxes } : {}),
  ...(sim.statics ? { statics: sim.statics } : {}) });
