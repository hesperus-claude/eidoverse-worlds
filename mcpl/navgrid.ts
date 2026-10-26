// navgrid: routes for a walking body through placed models, found by asking the collision code that will carry the
// walk out (colliders.resolveColliders, as agent.ts stepFeet does), never an opinion of its own.
//
// A* over (column, height) on a lattice offset from round coordinates (NAV_OFF): a height is standable where
// resolveColliders neither pushes the capsule nor answers another floor; a move is walkable within STEP. Then
// string-pulled by stepping the same resolver along the line, as the feet will.
//
// Pure: the world arrives through NavProbe (physics.ts navProbe). Keep one grid per collider generation
// (physics.ts collidersGeneration).

import { MOVER } from "../shared/mover.js";

/** Under the planning radius (physics.ts PLAN_R, ~0.33 m), so a wall cannot fall between two neighbouring standing columns. */
export const NAV_CELL = 0.2;
/** Off round metres: on a wall face (authored on round coordinates) resolveColliders has no push direction, so the
 *  point would read as standing room inside the wall. */
export const NAV_OFF = 0.0131;
const at = (i: number) => i * NAV_CELL + NAV_OFF;
const cell = (x: number) => Math.round((x - NAV_OFF) / NAV_CELL);
/** Most a walk climbs or drops between neighbouring columns: the mover's step (shared/mover.js MOVER.body.step), one
 *  height for walker, feet and planner; drops too, so a route never steps off a balcony. */
export const NAV_STEP = MOVER.body.step;
/** A push under this is a nudge, not a wall; routed walks arrive at waypoints within it (agent.ts). */
export const NAV_NUDGE = 0.05;
/** How far around the walk's own box the search may wander for a way round. */
export const NAV_PAD = 8;
/** Bounds the time a walk can block the process (every agent in it shares one event loop). */
export const NAV_MAX_EXPANSIONS = 40_000;

export type NavProbe = {
  /** height of the topmost surface at or below maxY at (x, z), terrain if none */
  surfaceUnder(x: number, z: number, maxY: number): number;
  /** a standing body's answer at (x, y, z): the ground it finds, and how far it is pushed sideways */
  stand(x: number, y: number, z: number): { ground: number; push: number };
};
export type NavPoint = { x: number; y: number; z: number };
export type NavTarget = { x: number; z: number; y?: number; reach?: number; above?: number; below?: number;
  inside?: (x: number, z: number) => boolean };
export type NavResult = { points: NavPoint[]; snapped: boolean } | { refusal: string };

/** Longest horizontal move between collision checks, for feet and planner alike: browser scale (2.6 cm a frame
 *  walking at 60 fps), or an agent slips past hip-band edges that hold a person. */
export const NAV_SUBSTEP = 0.03;
const SUBSTEP = NAV_SUBSTEP;
/** Planner step over level ground (see walkable). */
const COARSE = 0.1;
const DIRS: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]];

/** Probes one plan may make (line checks and column reads included), so no destination, however far, can hold
 *  the event loop. Past it the plan is refused. */
export const NAV_MAX_PROBES = 200_000;
/** Columns a grid remembers before starting over (it is only a cache). */
const NAV_MAX_COLUMNS = 300_000;
const OVER_BUDGET = new Error("navgrid: over budget");

export function makeNavGrid(raw: NavProbe) {
  let budget = Infinity;
  const probe: NavProbe = {
    surfaceUnder: (x, z, m) => { if (--budget < 0) throw OVER_BUDGET; return raw.surfaceUnder(x, z, m); },
    stand: (x, y, z) => { if (--budget < 0) throw OVER_BUDGET; return raw.stand(x, y, z); },
  };
  const cols = new Map<string, number[]>();

  /** Standing heights in column (i, j), highest first. */
  function layers(i: number, j: number): number[] {
    const key = `${i},${j}`;
    let out = cols.get(key);
    if (out) return out;
    out = [];
    const x = at(i), z = at(j);
    let maxY = Infinity;
    for (let n = 0; n < 16; n++) {
      const y = probe.surfaceUnder(x, z, maxY);
      if (!Number.isFinite(y) || y > maxY) break;          // only the terrain is left, and it is above the search
      const s = probe.stand(x, y, z);
      // a surface the floor probe overrules (a slab's underside answers with its top) is the other surface found again: dedupe
      if (s.push < NAV_NUDGE && s.ground >= y - 0.01 && !out.some((v) => Math.abs(v - s.ground) < 0.05)) out.push(s.ground);
      maxY = y - 0.02;
    }
    out.sort((a, b) => b - a);
    if (cols.size >= NAV_MAX_COLUMNS) { cols.clear(); steps.clear(); level.clear(); }
    cols.set(key, out);
    return out;
  }

  function match(i: number, j: number, y: number, within = NAV_STEP): number | null {
    let best: number | null = null;
    for (const v of layers(i, j)) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
    return best;
  }

  /** Stepped as agent.ts stepFeet steps: no push, ground within a step of the last. */
  function clear(a: NavPoint, b: NavPoint): boolean {
    return roughlyClear(a, b) && walkable(a, b);
  }

  const steps = new Map<string, boolean>();
  const level = new Map<string, boolean>();
  /** Two slabs at one height with a gap between are two places to stand, not a path: the midpoint must hold the
   *  body up, at that height, unpushed. */
  function levelOK(i0: number, j0: number, i1: number, j1: number, y: number): boolean {
    const k = `${i0},${j0}>${i1},${j1},${Math.round(y * 100)}`;
    let ok = level.get(k);
    if (ok === undefined) {
      const st = probe.stand((at(i0) + at(i1)) / 2, y, (at(j0) + at(j1)) / 2);
      level.set(k, ok = st.push < NAV_NUDGE && Math.abs(st.ground - y) < 0.05);
    }
    return ok;
  }
  /** Cached: the answer is as durable as the columns. */
  function stepOK(i0: number, j0: number, y0: number, i1: number, j1: number, y1: number): boolean {
    const k = `${i0},${j0},${Math.round(y0 * 100)}>${i1},${j1},${Math.round(y1 * 100)}`;
    let ok = steps.get(k);
    if (ok === undefined) steps.set(k, ok = walkable({ x: at(i0), y: y0, z: at(j0) }, { x: at(i1), y: y1, z: at(j1) }));
    return ok;
  }

  /** The eight neighbours standing within a step, no diagonal corner-cutting, height changes stepped as the feet
   *  will. The search and server/buildcheck.ts both move by exactly this. */
  function moves(i0: number, j0: number, y0: number): { i: number; j: number; y: number }[] {
    const out: { i: number; j: number; y: number }[] = [];
    for (const [di, dj] of DIRS) {
      const i = i0 + di, j = j0 + dj;
      const y = match(i, j, y0);
      if (y === null) continue;
      if (di && dj && (match(i0 + di, j0, y0) === null || match(i0, j0 + dj, y0) === null)) continue;
      // a level move can only lose its floor; a height change can push (an edge in the hip band), so step it as the feet will
      if (Math.abs(y - y0) > 0.01 ? !stepOK(i0, j0, y0, i, j, y) : !levelOK(i0, j0, i, j, y)) continue;
      out.push({ i, j, y });
    }
    return out;
  }

  /** The cheap half: along the line, the nearest lattice column offers a standing height within a step of the last.
   *  Rejects most hopeless shortcuts without stepping any physics. */
  function roughlyClear(a: NavPoint, b: NavPoint): boolean {
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / (NAV_CELL / 2)));
    let y = a.y;
    for (let s = 1; s <= n; s++) {
      const t = s / n;
      const v = match(cell(a.x + (b.x - a.x) * t), cell(a.z + (b.z - a.z) * t), y);
      if (v === null) return false;
      y = v;
    }
    return true;
  }

  function walkable(a: NavPoint, b: NavPoint): boolean {
    // coarse steps on level ground (a capsule-wide push zone can't be missed), the feet's fine steps where height changes
    const d = Math.hypot(b.x - a.x, b.z - a.z);
    const n = Math.max(1, Math.ceil(d / COARSE));
    let y = a.y, px = a.x, pz = a.z;
    for (let s = 1; s <= n; s++) {
      const t = s / n, x = a.x + (b.x - a.x) * t, z = a.z + (b.z - a.z) * t;
      const st = probe.stand(x, y, z);
      if (st.push > NAV_NUDGE || Math.abs(st.ground - y) > NAV_STEP) return false;
      if (Math.abs(st.ground - y) > 0.01) {
        const m = Math.max(1, Math.ceil(Math.hypot(x - px, z - pz) / SUBSTEP));
        for (let k = 1; k <= m; k++) {
          const fine = probe.stand(px + (x - px) * k / m, y, pz + (z - pz) * k / m);
          if (fine.push > NAV_NUDGE || Math.abs(fine.ground - y) > NAV_STEP) return false;
          y = fine.ground;
        }
      } else y = st.ground;
      px = x; pz = z;
    }
    return Math.abs(y - b.y) < 0.05;
  }


  /** Within `reach` m; a floor within a step of `ref` beats a nearer one that isn't (the top of the wall a goal sits in
   *  is never what was meant). */
  function standingNear(x: number, z: number, pick: (ls: number[]) => number | null, ref: number, reach = 0.6) {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const found: Spot[] = [];
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const i = ci + di, j = cj + dj, d = Math.hypot(at(i) - x, at(j) - z);
      if (d > reach) continue;
      const y = pick(layers(i, j));
      if (y === null) continue;
      found.push({ i, j, y, d, score: d + (Math.abs(y - ref) > NAV_STEP ? 100 + Math.abs(y - ref) : 0) });
    }
    return found.sort((a, b) => a.score - b.score);
  }

  /** Each standing height of each column within reach, with its distance from the point. */
  function spotsNear(x: number, z: number, reach = 0.6, inside?: (x: number, z: number) => boolean): Spot[] {
    const ci = cell(x), cj = cell(z), R = Math.ceil(reach / NAV_CELL);
    const out: Spot[] = [];
    for (let di = -R; di <= R; di++) for (let dj = -R; dj <= R; dj++) {
      const i = ci + di, j = cj + dj, d = Math.hypot(at(i) - x, at(j) - z);
      if (d > reach || (inside && !inside(at(i), at(j)))) continue;
      const ls = layers(i, j);
      ls.forEach((y, k) => out.push({ i, j, y, d, score: 0, lowest: k === ls.length - 1 }));
    }
    return out;
  }

  /** Route from a standing body to (to.x, to.z), arriving on the floor the walk means:
   *   - `to.y`: the place to stand nearest that height, at most a step above it ("on the floor at about this
   *     height": 0 is a ground floor raised 0.3m), or at most `to.above` above when the floor's height is exact (a
   *     named room's: a stair tread inside it is not its floor); a sealed-off upper room is a refusal, not the room
   *     below (`to.below` bounds it from beneath the same way);
   *   - `to.inside`: only spots inside a region count (a named room, reached anywhere on its floor);
   *   - otherwise the body's own storey when the destination has a floor within a step of it, else the lowest place
   *     to stand there (another building's ground floor, the ground under a balcony), failing those any reachable
   *     place to stand, at a cost (the treads of a stair whose ground beneath is solid).
   *  Every such spot is a goal; the search takes the cheapest, counting distance from the point asked for twice, so a
   *  point inside a wall is reached on the side the body is already on, not round by the door. */
  function route(from: NavPoint, to: NavTarget): NavResult {
    budget = NAV_MAX_PROBES;
    try { return routeIn(from, to); }
    catch (err) {
      if (err !== OVER_BUDGET) throw err;
      return { refusal: `too far to plan through what is placed in one go (${Math.hypot(to.x - from.x, to.z - from.z).toFixed(0)}m) — walk part of the way first` };
    } finally { budget = Infinity; }
  }

  function routeIn(from: NavPoint, to: NavTarget): NavResult {
    const start = standingNear(from.x, from.z, (ls) => nearestOf(ls, from.y, NAV_STEP), from.y)[0];
    if (!start) return { refusal: `nowhere to stand within 0.6m of where the body is (${from.x.toFixed(2)}, ${from.y.toFixed(2)}, ${from.z.toFixed(2)})` };
    const want = to.y != null && Number.isFinite(to.y) ? to.y : null;
    // the destination itself when its own cell stands (arriving there IS arriving at the point), else the spot
    const exactAt = new Map<number, boolean>();
    const exactOf = (g: Spot) => {
      if (Math.abs(to.x - at(g.i)) > NAV_CELL / 2 || Math.abs(to.z - at(g.j)) > NAV_CELL / 2) return false;
      // a standing cell is no proof the point does: a point a hand's width inside a box is beside a cell that stands
      let ok = exactAt.get(g.y);
      if (ok === undefined) {
        const st = probe.stand(to.x, g.y, to.z);
        ok = st.push < NAV_NUDGE && Math.abs(st.ground - g.y) < 0.05
          && walkable({ x: at(g.i), y: g.y, z: at(g.j) }, { x: to.x, y: g.y, z: to.z });
        exactAt.set(g.y, ok);
      }
      return ok;
    };
    const spots = spotsNear(to.x, to.z, to.reach ?? 0.6, to.inside);
    const sameStorey = spots.some((g) => Math.abs(g.y - from.y) <= NAV_STEP);
    // the floor y picks: over every place to stand near the point (not per column), the height closest to y, at most
    // a step above it; closest, not highest, so a footstool beside a spot isn't that spot
    let floorY = -Infinity;
    if (want != null) for (const g of spots) {
      if (g.y > want + (to.above ?? NAV_STEP) || (to.below != null && g.y < want - to.below)) continue;
      const better = Math.abs(g.y - want) < Math.abs(floorY - want) - 1e-6
        || (Math.abs(Math.abs(g.y - want) - Math.abs(floorY - want)) <= 1e-6 && g.y > floorY);
      if (better) floorY = g.y;
    }
    const preferred = (g: Spot) => want != null ? Math.abs(g.y - floorY) < 0.05
      : sameStorey ? Math.abs(g.y - from.y) <= NAV_STEP : g.lowest;
    const goals = spots
      .filter((g) => want == null || preferred(g))
      .map((g) => ({ ...g, score: 2 * (exactOf(g) ? 0 : g.d) + (preferred(g) ? 0 : OTHER_FLOOR_COST) }))
      .sort((a, b) => a.score - b.score);
    const goal = goals[0];
    if (!goal) {
      const where = to.inside ? `anywhere in it` : `within ${(to.reach ?? 0.6).toFixed(1)}m of (${to.x.toFixed(2)}, ${to.z.toFixed(2)})`;
      const height = want == null ? "" : to.below != null ? ` on its floor (${want.toFixed(2)}m)` : ` at or below ${(want + (to.above ?? NAV_STEP)).toFixed(2)}m`;
      return { refusal: `nowhere to stand ${where}${height}: ${to.inside ? "no floor there, or none with room for a body" : "it is inside something solid, or closer to a wall than a body fits"}` };
    }
    const startP = { x: from.x, y: start.y, z: from.z };
    const outOf = (g: Spot): NavPoint => exactOf(g) ? { x: to.x, y: g.y, z: to.z } : { x: at(g.i), y: g.y, z: at(g.j) };
    if (clear(startP, outOf(goal))) return { points: [outOf(goal)], snapped: !exactOf(goal) };

    // bounded to the walk's own box plus NAV_PAD
    const lo = { i: Math.floor((Math.min(from.x, to.x) - NAV_PAD) / NAV_CELL), j: Math.floor((Math.min(from.z, to.z) - NAV_PAD) / NAV_CELL) };
    const hi = { i: Math.ceil((Math.max(from.x, to.x) + NAV_PAD) / NAV_CELL), j: Math.ceil((Math.max(from.z, to.z) + NAV_PAD) / NAV_CELL) };
    type Node = { i: number; j: number; y: number; g: number; f: number; parent: Node | null; done?: Spot };
    const key = (i: number, j: number, y: number) => `${i},${j},${Math.round(y * 100)}`;
    const goalAt = new Map(goals.map((g) => [key(g.i, g.j, g.y), g]));
    const h = (i: number, j: number, y: number) => {
      let m = Infinity;
      for (const g of goals) m = Math.min(m, Math.hypot((g.i - i) * NAV_CELL, (g.j - j) * NAV_CELL, g.y - y));
      return m;
    };
    const heap: Node[] = [];
    const push = (n: Node) => {
      heap.push(n);
      for (let c = heap.length - 1; c > 0;) { const p = (c - 1) >> 1; if (heap[p].f <= heap[c].f) break; [heap[p], heap[c]] = [heap[c], heap[p]]; c = p; }
    };
    const pop = (): Node => {
      const top = heap[0], last = heap.pop()!;
      if (heap.length) {
        heap[0] = last;
        for (let p = 0; ;) {
          const l = 2 * p + 1, r = l + 1; let m = p;
          if (l < heap.length && heap[l].f < heap[m].f) m = l;
          if (r < heap.length && heap[r].f < heap[m].f) m = r;
          if (m === p) break; [heap[p], heap[m]] = [heap[m], heap[p]]; p = m;
        }
      }
      return top;
    };
    const best = new Map<string, number>();
    const closed = new Set<string>();
    push({ i: start.i, j: start.j, y: start.y, g: 0, f: h(start.i, start.j, start.y), parent: null });
    best.set(key(start.i, start.j, start.y), 0);
    let reached: Node | null = null, expansions = 0;
    while (heap.length) {
      const n = pop();
      if (n.done) { reached = n; break; }            // a goal, its distance from the point asked for paid
      const k = key(n.i, n.j, n.y);
      if (closed.has(k)) continue;
      closed.add(k);
      const at = goalAt.get(k);
      if (at) push({ ...n, g: n.g + at.score, f: n.g + at.score, done: at });
      if (++expansions > NAV_MAX_EXPANSIONS) {
        return { refusal: `gave up looking for a way to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}) after ${NAV_MAX_EXPANSIONS} steps of search — walk part of the way first` };
      }
      for (const { i, j, y } of moves(n.i, n.j, n.y)) {
        if (i < lo.i || i > hi.i || j < lo.j || j > hi.j) continue;
        const g = n.g + Math.hypot((i - n.i) * NAV_CELL, (j - n.j) * NAV_CELL, y - n.y);
        const kk = key(i, j, y);
        if (g >= (best.get(kk) ?? Infinity)) continue;
        best.set(kk, g);
        push({ i, j, y, g, f: g + h(i, j, y), parent: n });
      }
    }
    if (!reached) {
      const w = (hi.i - lo.i) * NAV_CELL, d = (hi.j - lo.j) * NAV_CELL;
      return { refusal: `no walkable way to (${to.x.toFixed(2)}, ${to.z.toFixed(2)}) at ${goal.y.toFixed(2)}m from here ` +
        `within ${w.toFixed(0)}×${d.toFixed(0)}m around the walk — it may be sealed off, or reached only by a climb or drop of more than ${NAV_STEP}m` };
    }
    const path: NavPoint[] = [];
    // from the goal itself (the finished node stands on it), so the search's last turn survives the goal's replacement below
    for (let n: Node | null = reached; n; n = n.parent) path.push({ x: at(n.i), y: n.y, z: at(n.j) });
    path.reverse();
    if (path.length < 2) path.push(path[0]);       // start and goal share a cell
    path[0] = startP;
    path[path.length - 1] = outOf(reached.done!);
    // string-pull: keep only the corners the straight walk cannot cut
    const out: NavPoint[] = [];
    let anchor = 0;
    while (anchor < path.length - 1) {
      let k = path.length - 1;
      while (k > anchor + 1 && !clear(path[anchor], path[k])) k--;
      out.push(path[k]);
      anchor = k;
    }
    return { points: out, snapped: !exactOf(reached.done!) };
  }

  return { route, layers, clear, moves, match, stepOK, at, cell };
}

type Spot = { i: number; j: number; y: number; d: number; score: number; lowest?: boolean };
/** In metres of walking: the right floor wins unless it is out of reach. */
const OTHER_FLOOR_COST = 10;

function nearestOf(ls: number[], y: number, within: number): number | null {
  let best: number | null = null;
  for (const v of ls) if (Math.abs(v - y) <= within && (best === null || Math.abs(v - y) < Math.abs(best - y))) best = v;
  return best;
}
