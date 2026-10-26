import { routeLevel, prepareWallCheck, routeGeometryFor, terrainCells, ROUTE_STEP_METRES, NON_FINITE_ENDPOINT } from './structure-route.js';
export { ROUTE_STEP_METRES };
// structure — the griddled building's pure half (TEL0S_NOTES §11.4: no THREE, no DOM, no scheduler): the boxes to draw and collide,
// the rooms the walls enclose, and the doorways that join them. client/lib/realize/structure.js executes the plan;
// tools/structure-field-test.ts holds it to the light. A grid writes topology down, so "you are in the kitchen; the hall
// is through the south door" is a derivation, not a guess.
// Walls live on grid EDGES, not in cells: an edge is shared by exactly two cells, so a wall between two rooms is ONE wall,
// with no ownership rule to leak.
// COORDINATES. Cell (x, z) covers grid-local [x, x+1) × [z, z+1) on the ground plane. Edges are canonical by construction:
//   axis 0 — runs along X, from (x, z) to (x+1, z): the boundary between cell (x, z-1) and cell (x, z).
//   axis 1 — runs along Z, from (x, z) to (x, z+1): the boundary between cell (x-1, z) and cell (x, z).
// One name per edge, so no canonicalization pass or de-duplication can be forgotten. All coordinates are GRID-LOCAL: a grid
// is an entity with its own position and yaw, and grids at arbitrary angles never need to agree about anything.

/** @typedef {{ x0:number, y0:number, z0:number, x1:number, y1:number, z1:number,
 *              mat:string, kind:'floor'|'wall'|'jamb'|'sill'|'lintel' }} Box */

/** @typedef {{ id:string, label:string|null, cells:string[], area:number,
 *              min:[number,number], max:[number,number],
 *              centre:[number,number] }} Room */

/** @typedef {{ axis:0|1, x:number, z:number, kind:'door'|'window',
 *              between:[string|null, string|null] }} Portal */

/** Defaults are a CONTRACT: every part generated against a grid assumes them, so changing one invalidates content.
 *  1 m tiles at a 1.7 m avatar, 2.8 m floor-to-floor, 0.15 m walls. */
export const GRID_DEFAULTS = Object.freeze({
  tile: 1.0,      // metres per cell
  wallH: 2.8,     // wall height / floor-to-floor
  wallT: 0.15,    // wall thickness
  slabT: 0.10,    // floor slab thickness (top sits at the level's y)
});

/** An aperture is a parametric HOLE owning a whole wall segment (wall left above and below), so geometry and collision just
 *  omit boxes: a doorway is walkable by absence. No side jambs on purpose: a jamb thinner than a body radius ejects bodies
 *  along the wall, through the frame; a decorative frame must not collide. */
export const APERTURES = Object.freeze({
  door:   { bottom: 0.00, top: 2.10 },
  window: { bottom: 0.90, top: 2.10 },
  arch:   { bottom: 0.00, top: 2.40 },
});

/** Where makeShader's contact terms stop biting: the wall profile samples AT them (a kink no vertex sits on bands every
 *  wall), so they're named once. */
export const SHADE_KINKS = Object.freeze({
  floorContact: 0.55, ceilContact: 0.40,   // interior
  groundContact: 0.45, eave: 0.85,         // exterior: the outside face has its own breakpoints; the profile is shared
});

export const cellKey = (x, z) => `${x},${z}`;
export const edgeKey = (axis, x, z) => `${axis}:${x},${z}`;

/** In grid-local coords, stable order: [negative side, positive side] along the edge's normal. */
export function edgeCells(axis, x, z) {
  return axis === 0
    ? [[x, z - 1], [x, z]]     // an X-running edge separates north from south
    : [[x - 1, z], [x, z]];    // a Z-running edge separates west from east
}

/** Or null if not neighbours. The inverse of edgeCells: flood fill asks "is there a wall in my way" in O(1). */
export function edgeBetween(ax, az, bx, bz) {
  if (ax === bx && az === bz - 1) return [0, ax, bz];       // b is south of a
  if (ax === bx && az === bz + 1) return [0, ax, az];       // b is north of a
  if (az === bz && ax === bx - 1) return [1, bx, az];       // b is east of a
  if (az === bz && ax === bx + 1) return [1, ax, az];       // b is west of a
  return null;
}

/** A rotated grid has its own north; the describer composes it with the grid's yaw. Differs from look()'s world compass on purpose. */
export const SIDES = Object.freeze({ N: 'north', E: 'east', S: 'south', W: 'west' });

/** Which local side of `cell` this edge lies on. */
export function sideOfCell(axis, x, z, cx, cz) {
  if (axis === 0) return cz === z ? 'N' : 'S';
  return cx === x ? 'W' : 'E';
}

// ---- diagonals --------------------------------------------------------------
// a diagonal crosses a cell corner to corner (axis 2 ↘, axis 3 ↗) and cuts it into two rooms, so graph walks run on nodes
// (one per whole cell, two per cut cell); a half is named by the pair of sides it touches

/** The diagonal cutting a cell, or null. */
export function diagOf(level, x, z) {
  if (level.walls.has(edgeKey(2, x, z))) return 2;
  if (level.walls.has(edgeKey(3, x, z))) return 3;
  return null;
}

/** Which half of a cell touches `side` ('N'|'E'|'S'|'W'); '' when uncut. */
export function halfFor(level, x, z, side) {
  const d = diagOf(level, x, z);
  if (!d) return '';
  if (d === 2) return (side === 'N' || side === 'E') ? ':A' : ':B';
  return (side === 'N' || side === 'W') ? ':A' : ':B';
}

/** Every node a cell contributes to the room/route graph. */
export function cellNodes(level, x, z) {
  const k = cellKey(x, z);
  if (!diagOf(level, x, z)) return [k];
  const only = level.halves?.get(k);
  return only ? [`${k}:${only}`] : [`${k}:A`, `${k}:B`];
}

/** An unfloored half is outside the building: no node, no room, no route, no floor. */
export function halfFloored(level, x, z, half) {
  const only = level.halves?.get(cellKey(x, z));
  return !only || only === half.replace(':', '');
}

/** The node of cell (x,z) that touches `side`. */
export const nodeOnSide = (level, x, z, side) => cellKey(x, z) + halfFor(level, x, z, side);

/** The describer's and router's way in: ↘ splits on u = v; ↗ splits on u + v = 1. */
export function nodeAtPoint(level, g, lx, lz) {
  const x = Math.floor(lx / g.tile), z = Math.floor(lz / g.tile);
  const d = diagOf(level, x, z);
  const k = cellKey(x, z);
  if (!d) return k;
  const u = lx / g.tile - x, v = lz / g.tile - z;
  if (d === 2) return u > v ? `${k}:A` : `${k}:B`;
  return (u + v) < 1 ? `${k}:A` : `${k}:B`;
}

const SIDE_OF = [['N', 'S'], ['E', 'W'], ['S', 'N'], ['W', 'E']];
const STEP = [[0, -1], [1, 0], [0, 1], [-1, 0]];

/** TWO GRAPHS, ONE NODE SET: a ROOM is bounded by walls whatever holes they carry; a ROUTE passes through the holes
 *  (throughApertures). Conflating them collapses every doored pair of rooms into one. */
export function nodeNeighbours(level, x, z, throughApertures = false) {
  const out = [];
  for (let i = 0; i < 4; i++) {
    const [side, back] = SIDE_OF[i], [dx, dz] = STEP[i];
    const nx = x + dx, nz = z + dz;
    if (!level.tiles.has(cellKey(nx, nz))) continue;
    const e = edgeBetween(x, z, nx, nz);
    const ek = e && edgeKey(e[0], e[1], e[2]);
    if (ek && level.walls.has(ek)
      && !(throughApertures && ['door', 'arch'].includes(level.apertures.get(ek)))) continue;
    const here = nodeOnSide(level, x, z, side), there = nodeOnSide(level, nx, nz, back);
    const ok = (n, cx, cz) => !n.includes(':') || halfFloored(level, cx, cz, n.split(':')[1]);
    if (!ok(here, x, z) || !ok(there, nx, nz)) continue;
    out.push([here, there]);
  }
  // across the diagonal itself, if it is holed
  const d = diagOf(level, x, z);
  if (d && throughApertures) {
    const dk = edgeKey(d, x, z);
    if (['door', 'arch'].includes(level.apertures.get(dk))) {
      if (halfFloored(level, x, z, 'A') && halfFloored(level, x, z, 'B')) {
        out.push([`${cellKey(x, z)}:A`, `${cellKey(x, z)}:B`]);
      }
    }
  }
  return out;
}

/** The whole node graph for a level. */
export function nodeGraph(level, throughApertures = false) {
  const adj = new Map();
  const add = (a, b) => {
    if (!adj.has(a)) adj.set(a, new Set());
    if (!adj.has(b)) adj.set(b, new Set());
    adj.get(a).add(b); adj.get(b).add(a);
  };
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    for (const n of cellNodes(level, x, z)) if (!adj.has(n)) adj.set(n, new Set());
    for (const [a, b] of nodeNeighbours(level, x, z, throughApertures)) add(a, b);
  }
  return adj;
}

// ---- normalization ----------------------------------------------------------

/** Total: a malformed structure yields an EMPTY plan, never a throw (one neighbour's broken house must not stop yours drawing). */
export function normalize(data) {
  const d = (data && typeof data === 'object') ? data : {};
  const num = (v, dflt) => (Number.isFinite(v) && v > 0 ? v : dflt);
  const g = {
    tile: num(d.tile, GRID_DEFAULTS.tile),
    wallH: num(d.wallH, GRID_DEFAULTS.wallH),
    wallT: num(d.wallT, GRID_DEFAULTS.wallT),
    slabT: num(d.slabT, GRID_DEFAULTS.slabT),
    levels: [],
    labels: (d.labels && typeof d.labels === 'object') ? d.labels : {},
  };
  const int = (v) => (Number.isInteger(v) ? v : null);
  for (const raw of Array.isArray(d.levels) ? d.levels : []) {
    const lv = (raw && typeof raw === 'object') ? raw : {};
    const tiles = new Map();     // cellKey -> mat
    const halves = new Map();    // cellKey -> 'A'|'B' when only one half is floored
    const walls = new Map();     // edgeKey -> {axis, x, z, mat}
    const apertures = new Map(); // edgeKey -> kind
    for (const t of Array.isArray(lv.tiles) ? lv.tiles : []) {
      const x = int(t?.[0]), z = int(t?.[1]);
      if (x == null || z == null) continue;
      const k0 = cellKey(x, z);
      tiles.set(k0, typeof t[2] === 'string' ? t[2] : 'floor');
      // a cell cut by a diagonal may be floored on only ONE side: what makes a diagonal read as the CORNER OF A BUILDING,
      // not a wall standing on a floor that carries on past it
      if (t[3] === 'A' || t[3] === 'B') halves.set(k0, t[3]);
    }
    for (const w of Array.isArray(lv.walls) ? lv.walls : []) {
      const axis = [0, 1, 2, 3].includes(w?.[0]) ? w[0] : null;
      const x = int(w?.[1]), z = int(w?.[2]);
      if (axis == null || x == null || z == null) continue;
      walls.set(edgeKey(axis, x, z), { axis, x, z, mat: typeof w[3] === 'string' ? w[3] : 'wall' });
    }
    for (const a of Array.isArray(lv.apertures) ? lv.apertures : []) {
      const axis = [0, 1, 2, 3].includes(a?.[0]) ? a[0] : null;
      const x = int(a?.[1]), z = int(a?.[2]);
      const kind = APERTURES[a?.[3]] ? a[3] : null;
      if (axis == null || x == null || z == null || !kind) continue;
      // an aperture with no wall to sit in is nothing: dropped here, so every later stage may assume the wall exists
      const k = edgeKey(axis, x, z);
      if (!walls.has(k)) continue;
      apertures.set(k, kind);
    }
    g.levels.push({ y: Number.isFinite(lv.y) ? lv.y : 0, tiles, halves, walls, apertures });
  }
  return g;
}

// ---- geometry + collision ---------------------------------------------------

/** Fill each external corner's missing t/2 quadrant with its own box, faces adjacent, never overlapping, so nothing z-fights
 *  (stretching a wall z-fights at L-corners and pokes through at T-junctions). A quadrant is a corner exactly when both
 *  opposite walls are present; free ends grow nothing. */
export function cornerFills(level, g, y0, y1) {
  const h = g.wallT / 2;
  const pts = new Set();
  for (const [, e] of level.walls) {
    if (e.axis === 0) { pts.add(`${e.x},${e.z}`); pts.add(`${e.x + 1},${e.z}`); }
    else { pts.add(`${e.x},${e.z}`); pts.add(`${e.x},${e.z + 1}`); }
  }
  const out = [];
  for (const p of [...pts].sort()) {
    const [px, pz] = p.split(',').map(Number);
    const W = level.walls.has(edgeKey(0, px - 1, pz));
    const E = level.walls.has(edgeKey(0, px, pz));
    const N = level.walls.has(edgeKey(1, px, pz - 1));
    const S = level.walls.has(edgeKey(1, px, pz));
    //        sx  sz   would cover it   makes it a corner
    for (const [sx, sz, a, b, c, d] of [
      [+1, -1, E, N, W, S],   // NE
      [+1, +1, E, S, W, N],   // SE
      [-1, +1, W, S, E, N],   // SW
      [-1, -1, W, N, E, S],   // NW
    ]) {
      if (a || b || !c || !d) continue;
      const cx = px * g.tile, cz = pz * g.tile;
      out.push({
        x0: cx + (sx < 0 ? -h : 0), x1: cx + (sx < 0 ? 0 : h),
        y0, y1,
        z0: cz + (sz < 0 ? -h : 0), z1: cz + (sz < 0 ? 0 : h),
        mat: 'wall', kind: 'corner',
      });
    }
  }
  return out;
}

/** RUNS: maximal contiguous collinear aperture-free chains sharing a material. One box per run (no interior seams, a
 *  continuous baseboard); apertured segments stay solitary (a different profile). */
export function wallRuns(level, g) {
  const lines = new Map();   // "axis:cross" -> [{ along, mat }]
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    // runs are AXIS-ALIGNED (they merge collinear collision boxes); a diagonal read as one made a phantom wall across the cell
    if (e.axis >= 2) continue;
    const cross = e.axis === 0 ? e.z : e.x;
    const along = e.axis === 0 ? e.x : e.z;
    const lk = `${e.axis}:${cross}`;
    if (!lines.has(lk)) lines.set(lk, []);
    lines.get(lk).push({ along, mat: e.mat });
  }
  const runs = [];
  for (const [lk, items] of lines) {
    const [axis, cross] = lk.split(':').map(Number);
    items.sort((a, b) => a.along - b.along);
    let run = null;
    for (const it of items) {
      if (run && it.along === run.hi + 1 && it.mat === run.mat) { run.hi = it.along; continue; }
      if (run) runs.push(run);
      run = { axis, cross, lo: it.along, hi: it.along, mat: it.mat };
    }
    if (run) runs.push(run);
  }
  // deterministic: two agents folding the same log must build the same house
  runs.sort((a, b) => a.axis - b.axis || a.cross - b.cross || a.lo - b.lo);
  return runs;
}

/** A run's along-axis span in metres, extended into whatever joints it meets. */
export function runSpan(run, level, g) {
  const startEdge = run.axis === 0 ? [0, run.lo, run.cross] : [1, run.cross, run.lo];
  const endEdge = run.axis === 0 ? [0, run.hi, run.cross] : [1, run.cross, run.hi];
  // a run stops where it stops; corners are closed by cornerFills, never by stretching past the wall it meets
  void startEdge; void endEdge;
  return [run.lo * g.tile, (run.hi + 1) * g.tile];
}

/** One box, or with an aperture at most a sill and a lintel spanning the segment (a door has no sill). Degenerate boxes are
 *  never emitted, so no sliver reaches the solver. */
export function wallBoxes(edge, aperture, g, y, ext = [0, 0]) {
  const { axis, x, z, mat } = edge;
  const t = g.wallT, h = g.wallH, half = t / 2;
  // Along-axis span in metres, and the fixed cross-axis band the wall occupies.
  const a0 = (axis === 0 ? x * g.tile : z * g.tile) - ext[0];
  const a1 = (axis === 0 ? x * g.tile : z * g.tile) + g.tile + ext[1];
  const cross = (axis === 0 ? z : x) * g.tile;
  const c0 = cross - half, c1 = cross + half;
  // built in (along, low, high) terms, then projected onto world axes once: the aperture arithmetic is written once, not twice
  const spans = [];
  const ap = aperture ? APERTURES[aperture] : null;
  if (!ap) {
    spans.push([a0, a1, 0, h, 'wall']);
  } else {
    const top = Math.min(ap.top, h);
    if (ap.bottom > 0) spans.push([a0, a1, 0, ap.bottom, 'sill']);
    if (top < h) spans.push([a0, a1, top, h, 'lintel']);
  }
  return spans.map(([s0, s1, lo, hi, kind]) => (axis === 0
    ? { x0: s0, y0: y + lo, z0: c0, x1: s1, y1: y + hi, z1: c1, mat, kind }
    : { x0: c0, y0: y + lo, z0: s0, x1: c1, y1: y + hi, z1: s1, mat, kind }));
}

/** A level's `y` is where its FOUNDATION rests: the slab occupies [y, y + slabT] and the walk surface is its top (`floorY`),
 *  so a floor is never coplanar with the ground and needs no depth bias. */
export function tileBox(x, z, mat, g, y) {
  return {
    x0: x * g.tile, y0: y, z0: z * g.tile,
    x1: (x + 1) * g.tile, y1: y + g.slabT, z1: (z + 1) * g.tile,
    mat, kind: 'floor',
  };
}

// ---- rooms ------------------------------------------------------------------

/** Blocked by walls. A DOOR DOES NOT MERGE TWO ROOMS (a wall with a hole still separates); only a missing wall merges. Scans in
 *  sorted key order, so labels are a pure function of the data and two agents hear the same house. */
export function deriveRooms(level, g) {
  const adj = nodeGraph(level);
  const seen = new Set();
  const rooms = [];
  const keys = [...adj.keys()].sort();
  for (const start of keys) {
    if (seen.has(start)) continue;
    const cells = [];
    const stack = [start];
    seen.add(start);
    while (stack.length) {
      const k = stack.pop();
      cells.push(k);
      for (const n of adj.get(k) ?? []) {
        if (seen.has(n)) continue;
        seen.add(n); stack.push(n);
      }
    }
    cells.sort();
    // a node key may carry a half suffix; the CELL is the part before it
    const cellOf = (k) => k.split(':')[0].split(',').map(Number);
    let minX = Infinity, minZ = Infinity, maxX = -Infinity, maxZ = -Infinity;
    for (const k of cells) {
      const [cx, cz] = cellOf(k);
      if (cx < minX) minX = cx; if (cx + 1 > maxX) maxX = cx + 1;
      if (cz < minZ) minZ = cz; if (cz + 1 > maxZ) maxZ = cz + 1;
    }
    // a half-cell is half a tile of floor
    const area = cells.reduce((t, k) => t + (k.includes(':') ? 0.5 : 1), 0) * g.tile * g.tile;
    rooms.push({
      id: `r${rooms.length + 1}`,
      label: g.labels[cells[0]] ?? cells.map((k) => g.labels[k] ?? g.labels[k.split(':')[0]]).find((v) => typeof v === 'string') ?? null,
      cells,
      area,
      min: [minX * g.tile, minZ * g.tile],
      max: [maxX * g.tile, maxZ * g.tile],
      centre: [((minX + maxX) / 2) * g.tile, ((minZ + maxZ) / 2) * g.tile],
    });
  }
  return rooms;
}

/** Each resolved to the two rooms it joins (null = outdoors: how the way out is found without an "exit" marker). */
export function derivePortals(level, rooms) {
  const roomOf = new Map();
  for (const r of rooms) for (const c of r.cells) roomOf.set(c, r.id);
  const portals = [];
  for (const [k, kind] of level.apertures) {
    const w = level.walls.get(k);
    if (!w) continue;
    if (w.axis >= 2) {
      // a diagonal's two sides are the two halves of its own cell
      const k = cellKey(w.x, w.z);
      portals.push({ axis: w.axis, x: w.x, z: w.z, kind,
        between: [roomOf.get(`${k}:A`) ?? null, roomOf.get(`${k}:B`) ?? null] });
      continue;
    }
    const [[ax, az], [bx, bz]] = edgeCells(w.axis, w.x, w.z);
    const sideA = sideOfCell(w.axis, w.x, w.z, ax, az);
    const sideB = sideOfCell(w.axis, w.x, w.z, bx, bz);
    portals.push({
      axis: w.axis, x: w.x, z: w.z, kind,
      between: [
        roomOf.get(nodeOnSide(level, ax, az, sideA)) ?? null,
        roomOf.get(nodeOnSide(level, bx, bz, sideB)) ?? null,
      ],
    });
  }
  return portals;
}

// ---- the plan ---------------------------------------------------------------

/** Floor tiles, solid wall runs, apertured remainders, corner fills and a diagonal's stair steps. planStructure's `boxes` and
 *  the authority's solids (collisionBoxes) share it, so the browser's colliders and the door's walls can't disagree. */
function levelBoxes(level, g) {
  const boxes = [];
  const floorY = level.y + g.slabT;
  for (const [k, mat] of level.tiles) {
    const [x, z] = k.split(',').map(Number);
    boxes.push(tileBox(x, z, mat, g, level.y));
  }
  // solid stretches collide as one box per run; apertured segments keep their own decomposition (a hole makes another shape)
  const half = g.wallT / 2;
  for (const run of wallRuns(level, g)) {
    const [a0, a1] = runSpan(run, level, g);
    boxes.push(edgeSpan(run.axis, run.cross * g.tile, a0, a1, -half, half,
      floorY, floorY + g.wallH, run.mat, 'wall'));
  }
  for (const [k, edge] of level.walls) {
    const ap = level.apertures.get(k);
    if (!ap) continue;
    boxes.push(...wallBoxes(edge, ap, g, floorY));
  }
  boxes.push(...cornerFills(level, g, floorY, floorY + g.wallH));
  // diagonal COLLISION is stair-stepped axis-aligned boxes (the collider entry has ONE yaw per building). Steps ~18 cm apart
  // are under the 20 cm body radius (MOVER.body), so nothing slips between; the visual wall is a true mitre.
  for (const [k, e] of level.walls) {
    if (e.axis < 2) continue;
    const [[sx, sz], [ex, ez]] = segmentEnds(e, g);
    const open = ['door', 'arch'].includes(level.apertures.get(k));
    const N = 8, r = g.wallT * 0.8;
    for (let i = 0; i <= N; i++) {
      const t = i / N;
      const cx = sx + (ex - sx) * t, cz = sz + (ez - sz) * t;
      boxes.push({
        x0: cx - r, x1: cx + r,
        y0: open ? floorY + (APERTURES[level.apertures.get(k)]?.top ?? 0) : floorY,
        y1: floorY + g.wallH,
        z0: cz - r, z1: cz + r, mat: e.mat, kind: 'wall',
      });
    }
  }
  return boxes;
}

/** Without the visual derivation: what a headless reader needing only where the walls are (the door) asks for. */
export function collisionBoxes(data) {
  const g = normalize(data);
  return g.levels.flatMap((level) => levelBoxes(level, g));
}

/** What to draw, what to collide, the rooms and what joins them. Pure and total. The hosted half rebuilds on every reconcile
 *  rather than patching, so it can't drift from the state. */
export function planStructure(data) {
  const g = normalize(data);
  const boxes = [];
  const levels = [];
  for (const level of g.levels) {
    // the walk surface, the top of this level's foundation: walls rise from it, apertures are measured from it, a body stands on it
    const floorY = level.y + g.slabT;
    boxes.push(...levelBoxes(level, g));
    const rooms = deriveRooms(level, g);
    levels.push({
      y: floorY, base: level.y, rooms, portals: derivePortals(level, rooms),
      // visual geometry travels alongside, never inside, the collision boxes
      parts: levelParts(level, g, floorY),
      sweeps: levelSweeps(level, g, floorY),
      level,
    });
  }
  return { grid: g, boxes, levels };
}

// ---- visual parts -----------------------------------------------------------
// a second derivation from the same grid, for rendering only (trim, casings, roof); collision keeps `boxes`. One source, so a
// doorway can't be open to the eye and shut to the body.

export const TRIM = Object.freeze({
  base: { h: 0.11, proud: 0.020 },    // baseboard
  case: { w: 0.09, proud: 0.028 },    // door/window casing
  sill: { out: 0.055, t: 0.045 },     // window sill, protruding both faces
  roof: { over: 0.20, t: 0.16 },      // flat roof slab + overhang
  glass: { t: 0.02 },
});

/** The only place the axis distinction lives, so every part below is written once. */
function edgeSpan(axis, cross, a0, a1, c0, c1, y0, y1, mat, kind) {
  return axis === 0
    ? { x0: a0, y0, z0: cross + c0, x1: a1, y1, z1: cross + c1, mat, kind }
    : { x0: cross + c0, y0, z0: a0, x1: cross + c1, y1, z1: a1, mat, kind };
}

/** Which of an edge's two faces look into a floored cell (and so get interior trim): signed offsets, -1 or +1. */
function facesOf(level, axis, x, z) {
  const [[ax, az], [bx, bz]] = edgeCells(axis, x, z);
  const out = [];
  if (level.tiles.has(cellKey(ax, az))) out.push(-1);
  if (level.tiles.has(cellKey(bx, bz))) out.push(+1);
  return out;
}

/** Every visual part for one level. */
export function levelParts(level, g, floorY) {
  const parts = [];
  const t = g.wallT, half = t / 2, h = g.wallH;

  for (const [k, mat] of level.tiles) {
    const [x, z] = k.split(',').map(Number);
    if (level.halves?.has(k)) continue;      // half-cells are prisms, see levelSweeps
    parts.push(tileBox(x, z, mat, g, floorY - g.slabT));
  }

  // solid stretches and skirting are SWEPT (levelSweeps), so they mitre and run at any angle; only box-shaped pieces stay here

  for (const [k, edge] of level.walls) {
    const ap = level.apertures.get(k) ?? null;
    if (!ap) continue;                       // solid stretches are swept (levelSweeps)
    // lintel/sill are SWEPT (levelSweeps): only the glass and the aperture's own trim remain box-shaped here

    const { axis, x, z } = edge;
    const a0 = (axis === 0 ? x : z) * g.tile, a1 = a0 + g.tile;
    const cross = (axis === 0 ? z : x) * g.tile;
    const faces = facesOf(level, axis, x, z);
    const prof = APERTURES[ap];

    const oB = floorY + prof.bottom, oT = floorY + Math.min(prof.top, h);
    const prevK = axis === 0 ? edgeKey(0, x - 1, z) : edgeKey(1, x, z - 1);
    const nextK = axis === 0 ? edgeKey(0, x + 1, z) : edgeKey(1, x, z + 1);
    const cw0 = level.walls.has(prevK) ? TRIM.case.w : 0;
    const cw1 = level.walls.has(nextK) ? TRIM.case.w : 0;
    const cw = TRIM.case.w;
    // no casing boxes: a box can't agree with the swept profile's surface; the profile's reveal is the soffit and sill
    void faces; void oB; void oT; void cw; void cw0; void cw1;
    // glass is swept in levelSweeps — edgeSpan cannot express a diagonal
  }

  // flat roof with an overhang: the eave's shadow line is most of a building's silhouette. Pitched roofs (a straight-skeleton
  // problem) are deferred on purpose.
  let lo = null, hi = null;
  for (const k of level.tiles.keys()) {
    const [x, z] = k.split(',').map(Number);
    lo = lo ? [Math.min(lo[0], x), Math.min(lo[1], z)] : [x, z];
    hi = hi ? [Math.max(hi[0], x + 1), Math.max(hi[1], z + 1)] : [x + 1, z + 1];
  }
  if (lo) {
    const o = TRIM.roof.over;
    parts.push({
      x0: lo[0] * g.tile - o, y0: floorY + h, z0: lo[1] * g.tile - o,
      x1: hi[0] * g.tile + o, y1: floorY + h + TRIM.roof.t, z1: hi[1] * g.tile + o,
      mat: 'roof', kind: 'roof',
    });
  }
  return parts;
}

// ---- analytic shading -------------------------------------------------------
// interior shading is baked analytically at build time: the scene has no AO pass, and a light per room is what the
// fixed-slot lightrig.js can't afford. The walls, concave joins, depth and windows are already known.

/** BFS'd out from the apertures through open edges and doorways: bright at the glass, dimmer at the back wall and in rooms
 *  reached only through a door. */
export function opennessField(level, g) {
  const dist = new Map();
  const q = [];
  for (const k of level.apertures.keys()) {
    const w = level.walls.get(k);
    if (!w) continue;
    for (const [cx, cz] of edgeCells(w.axis, w.x, w.z)) {
      const ck = cellKey(cx, cz);
      if (!level.tiles.has(ck) || dist.has(ck)) continue;
      dist.set(ck, 0); q.push([cx, cz]);
    }
  }
  for (let i = 0; i < q.length; i++) {
    const [cx, cz] = q[i], d = dist.get(cellKey(cx, cz));
    for (const [nx, nz] of [[cx, cz - 1], [cx + 1, cz], [cx, cz + 1], [cx - 1, cz]]) {
      const nk = cellKey(nx, nz);
      if (!level.tiles.has(nk) || dist.has(nk)) continue;
      const e = edgeBetween(cx, cz, nx, nz);
      const ek = e && edgeKey(e[0], e[1], e[2]);
      // a wall blocks light unless it is holed
      if (ek && level.walls.has(ek) && !level.apertures.has(ek)) continue;
      dist.set(nk, d + 1); q.push([nx, nz]);
    }
  }
  const out = new Map();
  for (const k of level.tiles.keys()) {
    const d = dist.get(k);
    // the floor of how dim a windowless corner gets: below ~0.38 an interior reads "broken", not "dim"
    out.set(k, d == null ? 0.38 : Math.max(0.38, 1 / (1 + 0.38 * d)));
  }
  return out;
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Distance from a point to one edge's line segment, in grid-local metres. */
function distToEdge(px, pz, axis, x, z, tile) {
  const a0 = (axis === 0 ? x : z) * tile, a1 = a0 + tile;
  const cross = (axis === 0 ? z : x) * tile;
  const along = axis === 0 ? px : pz;
  const perp = axis === 0 ? pz : px;
  const clampedAlong = along < a0 ? a0 : along > a1 ? a1 : along;
  return Math.hypot(along - clampedAlong, perp - cross);
}

/** A pure function of position and normal → a linear multiplier. Sampling at `p + n·ε` lets a wall's two faces shade
 *  differently (daylight outside, the room inside). */
export function makeShader(level, g, floorY) {
  const open = opennessField(level, g);
  return function shade(px, py, pz, nx, ny, nz) {
    const E = 0.07;
    const sx = px + nx * E, sy = py + ny * E, sz = pz + nz * E;
    const cx = Math.floor(sx / g.tile), cz = Math.floor(sz / g.tile);
    const ck = cellKey(cx, cz);
    const inside = level.tiles.has(ck) && sy > floorY - 0.05 && sy < floorY + g.wallH;
    let v = inside ? (open.get(ck) ?? 0.30) : 1.0;

    if (inside) {
      // concave joins as a PRODUCT of per-wall falloffs, not a min, so a corner compounds darker than a flat wall
      for (const [axis, ex, ez] of [[0, cx, cz], [0, cx, cz + 1], [1, cx, cz], [1, cx + 1, cz]]) {
        if (!level.walls.has(edgeKey(axis, ex, ez))) continue;
        const d = distToEdge(sx, sz, axis, ex, ez, g.tile);
        v *= 0.56 + 0.44 * clamp01(d / 0.62);
      }
      // contact shadow up from the floor
      const hAbove = py - floorY;
      if (hAbove < SHADE_KINKS.floorContact) v *= 0.62 + 0.38 * clamp01(hAbove / SHADE_KINKS.floorContact);
      // and down from the ceiling
      const below = floorY + g.wallH - py;
      if (below < SHADE_KINKS.ceilContact) v *= 0.82 + 0.18 * clamp01(below / SHADE_KINKS.ceilContact);
      // floor bounce: a downward face indoors is lit by the floor, so ceilings read bright, not cellar-black
      if (ny < -0.5) v *= 1.24;
    } else {
      // outside, openness is 1.0 everywhere; the eave shadow and grade contact are what model an exterior wall
      const underEave = floorY + g.wallH - py;
      if (underEave < SHADE_KINKS.eave) v *= 0.62 + 0.38 * clamp01((underEave + 0.35) / 1.2);
      // and the ground steals light back at the base
      const above = py - floorY;
      if (above < SHADE_KINKS.groundContact) v *= 0.76 + 0.24 * clamp01(above / SHADE_KINKS.groundContact);
      // a convex corner catches the sky from two sides: lifted a little, so massing reads as volume, not one continuous surface
      const near = Math.min(
        Math.abs(sx - Math.round(sx / g.tile) * g.tile),
        Math.abs(sz - Math.round(sz / g.tile) * g.tile));
      if (near < 0.10) v *= 1.0 + 0.05 * (1 - near / 0.10);
    }
    // sky above, ground below: the hemisphere term the scene's single hemi light would give if anything ever occluded it
    v *= 0.84 + 0.16 * ny;
    v = clamp01(v * 1.06);
    // daylight warm, bounce cool: a touch of hue separation does more for "lit" than another 10% of value
    const warm = inside ? 0.06 * (open.get(ck) ?? 0.3) : 0.05;
    return [clamp01(v + warm), clamp01(v + warm * 0.45), clamp01(v * 0.99)];
  };
}

// ---- perception -------------------------------------------------------------
// reads the plan only (no scene, triangles or raycast), so an agent with folded state answers "which room am I in and how do
// I leave" as well as a browser

/** For a building entity: mirrors the collider convention exactly (subtract position, un-rotate yaw, divide by scale), so
 *  perception and collision can never disagree about where a wall is. */
export function localizePoint(ent, wx, wy, wz) {
  const [px, py, pz] = Array.isArray(ent?.pos) ? ent.pos : [0, 0, 0];
  const yaw = Number.isFinite(ent?.yaw) ? ent.yaw : 0;
  const s = Number.isFinite(ent?.scale) && ent.scale > 0 ? ent.scale : 1;
  const dx = wx - px, dz = wz - pz;
  const c = Math.cos(yaw), n = Math.sin(yaw);
  return [(dx * c - dz * n) / s, (wy - py) / s, (dx * n + dz * c) / s];
}

/** Each named by the side of THIS room it sits on and what lies beyond; `null` beyond is outdoors (how an agent finds its way
 *  out without anyone marking an exit). */
export function openingsOf(level, room) {
  const mine = new Set(room.cells);
  const byId = new Map(level.rooms.map((r) => [r.id, r]));
  const out = [];
  for (const p of level.portals) {
    const [[ax, az], [bx, bz]] = edgeCells(p.axis, p.x, p.z);
    const aK = cellKey(ax, az), bK = cellKey(bx, bz);
    const near = mine.has(aK) ? [ax, az] : mine.has(bK) ? [bx, bz] : null;
    if (!near) continue;
    const other = mine.has(aK) ? p.between[1] : p.between[0];
    out.push({
      kind: p.kind,
      side: SIDES[sideOfCell(p.axis, p.x, p.z, near[0], near[1])],
      to: other ? (byId.get(other)?.label ?? other) : null,
    });
  }
  return out;
}

/** One sentence for the room a point stands in, or null. Sides are the GRID's compass, and the phrasing says so. */
export function describeHere(plan, lx, lz, ly = 0) {
  // resolve the room's own level, never one from the cell key alone (keys are x,z: on a stacked building that's the ground
  // floor; ew#140)
  const here = levelAt(plan, lx, lz, ly);
  if (!here) return null;
  const { level, room } = here;
  const w = (room.max[0] - room.min[0]).toFixed(0), d = (room.max[1] - room.min[1]).toFixed(0);
  const name = room.label ? `the ${room.label}` : `an unnamed room (${room.id})`;
  const ways = openingsOf(level, room);
  const doors = ways.filter((o) => o.kind !== 'window');
  const wins = ways.filter((o) => o.kind === 'window');
  const phrase = (o) => `a ${o.kind} on its ${o.side} to ${o.to ?? 'outside'}`;
  const parts = [`You are in ${name} — ${w}×${d}m, ${room.area}m².`];
  parts.push(doors.length
    ? `Ways out: ${doors.map(phrase).join('; ')}.`
    : `No doors — this room is sealed.`);
  if (wins.length) parts.push(`Also ${wins.map(phrase).join('; ')}.`);
  return parts.join(' ');
}

/** What look() prints for a building instead of a bare `components: structure`. */
export function describeStructure(data) {
  const plan = planStructure(data);
  let rooms = 0, doors = 0, windows = 0, walls = 0;
  for (const lv of plan.levels) {
    rooms += lv.rooms.length;
    for (const p of lv.portals) (p.kind === 'window' ? windows++ : doors++);
  }
  for (const lv of plan.grid.levels) walls += lv.walls.size;
  const n = (c, s) => `${c} ${s}${c === 1 ? '' : 's'}`;
  const bits = [n(rooms, 'room'), n(walls, 'wall')];
  if (doors) bits.push(n(doors, 'door'));
  if (windows) bits.push(n(windows, 'window'));
  const storeys = plan.levels.length > 1 ? `${plan.levels.length}-storey ` : '';
  return `a ${storeys}building: ${bits.join(', ')}`;
}

/** The describer's entry point: "which room am I in" in O(1), not a geometric query against triangles. */
export function roomAt(plan, lx, lz, ly = 0) {
  return levelAt(plan, lx, lz, ly)?.room ?? null;
}

/** Resolved once: the highest level whose surface is at most 0.5 m above the point and has a room at that cell. roomAt and the
 *  describer both use it. Null when in no room. */
export function levelAt(plan, lx, lz, ly = 0) {
  let best = null;
  for (const lv of plan.levels) {
    if (lv.y > ly + 0.5) continue;
    if (!best || lv.y > best.y) {
      const room = lv.rooms.find((r) => r.cells.includes(nodeAtPoint(lv.level, plan.grid, lx, lz)));
      if (room) best = { y: lv.y, level: lv, room };
    }
  }
  return best ? { level: best.level, room: best.room } : null;
}

// ---- routing ----------------------------------------------------------------
// the grid IS the navigation graph: cells are nodes, a neighbour edge is passable unless a wall stands on it. Without it a
// headless agent's walkTo walks straight through walls.

/** A door or an arch is a hole you can walk through; a window is not, and neither is a wall. */
export function passable(level, ax, az, bx, bz) {
  const e = edgeBetween(ax, az, bx, bz);
  if (!e) return false;
  const k = edgeKey(e[0], e[1], e[2]);
  if (!level.walls.has(k)) return true;
  const ap = level.apertures.get(k);
  return ap === 'door' || ap === 'arch';
}

/** Cell keys, both ends included, or null. BFS on purpose: floor plans are tiny and "no route" is a real answer; neighbours in
 *  a fixed order so agents walk the same path. */
export function routeCells(level, fromKey, toKey) {
  const adj = nodeGraph(level, true);      // routes go through doorways
  if (!adj.has(fromKey) || !adj.has(toKey)) return null;
  if (fromKey === toKey) return [fromKey];
  const prev = new Map([[fromKey, null]]);
  const q = [fromKey];
  for (let i = 0; i < q.length; i++) {
    for (const nk of [...(adj.get(q[i]) ?? [])].sort()) {
      if (prev.has(nk)) continue;
      prev.set(nk, q[i]);
      if (nk === toKey) {
        const path = [];
        for (let c2 = nk; c2 != null; c2 = prev.get(c2)) path.push(c2);
        return path.reverse();
      }
      q.push(nk);
    }
  }
  return null;
}

/** Prepare one immutable plan snapshot against a walking basis (owned by the standing resolver): terrain {heightAt(localX,
 * localZ), step?, scale?} or floor {height, level?, step?, scale?}; a floor's `level` makes THIS structure the support
 * owner (omit it on other structures: they constrain walls but offer no support). step is the feet-to-step band in
 * local metres; scale (world metres per local metre, 1 when omitted) only puts refusals in world metres. A preparation that can't be made
 * says why in `failed` (route() refuses, clear() is false). */
export function prepareRouteLocal(plan, basis) {
  // freeze the chosen mode/identity and function for this walk: a floor can't turn into terrain halfway through validation
  basis = basis ? { ...basis } : basis;
  const blocked = reason => ({ kind: 'blocked', reason, points: [], confined: basis?.kind === 'floor' && basis.level != null });
  const unusable = reason => ({ failed: reason, route: () => blocked(reason), clear: () => false, confined: false });
  if (!basis || !['terrain','floor'].includes(basis.kind)) return unusable('walking support basis is required');
  let clear;
  try { clear = prepareWallCheck(plan,basis); }
  catch (e) { return unusable(String(e.message)); }
  const confined = basis.kind === 'floor' && basis.level != null;
  const scale = Number.isFinite(basis.scale) && basis.scale > 0 ? basis.scale : 1;
  // the plan's cached local geometry has no support/transform state; each received component revision is a different plan
  return {
    confined,
    clear: (ax,az,bx,bz) => clear([ax,az],[bx,bz]),
    route(fromX,fromZ,toX,toZ) {
      const from=[fromX,fromZ], to=[toX,toZ];
      if (![...from,...to].every(Number.isFinite)) return blocked(NON_FINITE_ENDPOINT);
      if (basis.kind === 'terrain') {
        if (clear(from,to)) return { kind: 'clear', points: [from,to], confined: false };
        // the search covers every level's geometry; the diagonals cutting its cells are the ones this walk's terrain meets
        const cells = terrainCells(plan, basis.heightAt, basis.step ?? ROUTE_STEP_METRES);
        return { ...routeLevel(cells,plan.grid,from,to,true,clear,{ bounds: routeGeometryFor(plan).bounds, scale }), confined: false };
      }
      if (!Number.isFinite(basis.height)) return blocked('non-finite floor height');
      if (!confined) return clear(from,to)
        ? {kind:'clear',points:[from,to],confined:false}
        : blocked('another structure obstructs the identified-floor route');
      const lv=Number.isInteger(basis.level) ? plan.levels[basis.level] : null;
      if (!lv || Math.abs(lv.y-basis.height)>1e-7)
        return blocked('identified support floor does not match supplied feet height');
      return { ...routeLevel(lv.level,plan.grid,from,to,false,clear,{ scale }), confined:true };
    },
  };
}

/** On a flat terrain basis at height `y` (a walking plane, not floor support): walls of every level are checked against its
 * feet-to-step band, and an outdoor endpoint is routed around. → prepareRouteLocal's route(): 'clear', 'routed' with
 * waypoints, or 'blocked' with the reason. */
export function planRouteLocal(plan, fromX, fromZ, toX, toZ, y = 0) {
  return prepareRouteLocal(plan,{kind:'terrain',heightAt:()=>y,step:ROUTE_STEP_METRES}).route(fromX,fromZ,toX,toZ);
}
/** Whether the straight leg clears every wall, on planRouteLocal's flat terrain basis. */
export function routeSegmentClear(plan, fromX, fromZ, toX, toZ, y = 0) {
  return prepareRouteLocal(plan,{kind:'terrain',heightAt:()=>y,step:ROUTE_STEP_METRES}).clear(fromX,fromZ,toX,toZ);
}
/** planRouteLocal's waypoints in grid-local metres, both ends included, or null when refused; collinear runs merged. */
export function routeLocal(plan, fromX, fromZ, toX, toZ, y = 0) {
  const result = planRouteLocal(plan, fromX, fromZ, toX, toZ, y);
  return result.kind === 'blocked' ? null : result.points;
}

// ---- swept wall geometry ----------------------------------------------------
// a cross-section swept along the wall's own direction (not boxes on world axes): true mitres at any angle, chamfers in the
// profile, and diagonal walls are a change of path, not of pipeline

/** The per-vertex shade bake lerps across a face, so a storey-tall quad steps against a lintel's own samples; cutting at every
 *  aperture height gives an exact shared sample where a wall meets a lintel or sill. */
export function refineProfile(profile, vs) {
  const cuts = [...new Set(vs)].sort((a, b) => a - b);
  const out = [];
  for (let i = 0; i < profile.length; i++) {
    const cur = profile[i], prev = profile[i - 1];
    if (prev) {
      const lo = Math.min(prev[1], cur[1]), hi = Math.max(prev[1], cur[1]);
      const between = cuts.filter((v) => v > lo + 1e-9 && v < hi - 1e-9);
      if (prev[1] > cur[1]) between.reverse();
      for (const v of between) {
        const t = (v - prev[1]) / (cur[1] - prev[1]);
        out.push([prev[0] + (cur[0] - prev[0]) * t, v]);
      }
    }
    out.push(cur);
  }
  return out;
}

/** [across, up] pairs (across −t/2..+t/2, up from the walk surface); chamfered top arrises catch a highlight line. */
export function wallProfile(g, chamfer = 0.02, plinth = null, cuts = null) {
  const h = g.wallT / 2, H = g.wallH;
  const c = Math.max(0, Math.min(chamfer, h * 0.6, H * 0.1));
  const pr = plinth ?? { h: TRIM.base.h, out: TRIM.base.proud };
  const b = Math.min(pr.h, H * 0.25), o = Math.max(0, pr.out);
  // the skirting is a step in the swept profile, so it is one board mitred with the wall and can't come apart from it
  const base = [
    [-h - o, 0], [-h - o, b], [-h, b + o], [-h, H - c],
    [-h + c, H], [h - c, H],
    [h, H - c], [h, b + o], [h + o, b], [h + o, 0],
  ].filter((pt, i, a) => i === 0 || Math.abs(pt[0] - a[i - 1][0]) > 1e-9 || Math.abs(pt[1] - a[i - 1][1]) > 1e-9);
  // a ladder up the wall, plus an exact cut at every aperture height so a lintel or sill shares its boundary sample with the wall
  const apHeights = Object.values(APERTURES).flatMap((a) => [a.bottom, a.top]).filter((v) => v > 0 && v < H);
  // the shading curve kinks where its contact terms end (makeShader): sample the kinks, since interpolation follows a curve
  // only with a sample on the corner
  const kinks = [SHADE_KINKS.floorContact, H - SHADE_KINKS.ceilContact,
    SHADE_KINKS.groundContact, H - SHADE_KINKS.eave];
  const ladder = [];
  for (let v = 0.3; v < H - c; v += 0.3) ladder.push(v);
  return refineProfile(base, cuts ?? [...apHeights, ...kinks, ...ladder].filter((v) => v > 0 && v < H));
}

const nodePt = (k) => k.split(',').map(Number);

/** Continuing through a node by the STRAIGHTEST onward segment, so a T-junction's crossing wall runs through and the stem ends
 *  against it. Apertured segments are emitted separately. */
export function wallPolylines(level, g) {
  const segs = [];
  for (const [k, e] of level.walls) {
    if (level.apertures.has(k)) continue;
    const [start, end] = segmentEnds(e, { tile: 1 }); // vertex keys, before metre scaling
    const a = cellKey(...start), b = cellKey(...end);
    segs.push({ a, b, mat: e.mat, used: false });
  }
  const inc = new Map();
  segs.forEach((s, i) => {
    for (const n of [s.a, s.b]) { if (!inc.has(n)) inc.set(n, []); inc.get(n).push(i); }
  });
  const dir = (from, to) => {
    const [ax, az] = nodePt(from), [bx, bz] = nodePt(to);
    const d = Math.hypot(bx - ax, bz - az) || 1;
    return [(bx - ax) / d, (bz - az) / d];
  };
  /** the straightest unused continuation at `node` arriving along `d` */
  const onward = (node, from, d) => {
    let best = -1, bestDot = -2;
    // at a plain corner a run turns and mitres; at a JUNCTION it continues only if something carries straight on, or it picks
    // a branch at random and swallows a divider into the wall it meets
    const degree = (inc.get(node) ?? []).length;
    const minDot = degree > 2 ? 0.7 : -2;
    for (const i of inc.get(node) ?? []) {
      const s = segs[i];
      if (s.used) continue;
      const other = s.a === node ? s.b : s.a;
      if (other === from) continue;
      const e = dir(node, other);
      const dot = d[0] * e[0] + d[1] * e[1];
      if (dot > bestDot && dot >= minDot) { bestDot = dot; best = i; }
    }
    return best;
  };
  const lines = [];
  const grow = (startSeg) => {
    const s = segs[startSeg];
    s.used = true;
    const pts = [s.a, s.b];
    const mat = s.mat;
    // extend forward, then backward
    for (const forward of [true, false]) {
      for (;;) {
        const tip = forward ? pts[pts.length - 1] : pts[0];
        const prev = forward ? pts[pts.length - 2] : pts[1];
        const i = onward(tip, prev, dir(prev, tip));
        if (i < 0) break;
        segs[i].used = true;
        const nxt = segs[i].a === tip ? segs[i].b : segs[i].a;
        if (pts.includes(nxt)) {
          // a closed ring repeats the first point so the sweep wraps (else the last corner is unmitred: a seam)
          if (nxt === pts[0]) { if (forward) pts.push(nxt); else pts.unshift(nxt); }
          break;
        }
        if (forward) pts.push(nxt); else pts.unshift(nxt);
      }
    }
    lines.push({ pts: pts.map(nodePt).map(([x, z]) => [x * g.tile, z * g.tile]), mat });
  };
  // start at ends and junctions first so open runs are not cut mid-line
  for (let i = 0; i < segs.length; i++) {
    if (segs[i].used) continue;
    const dA = (inc.get(segs[i].a) ?? []).length, dB = (inc.get(segs[i].b) ?? []).length;
    if (dA !== 2 || dB !== 2) grow(i);
  }
  for (let i = 0; i < segs.length; i++) if (!segs[i].used) grow(i);   // pure loops
  return lines;
}

/** Mitring at every turn (offset along the normals' bisector, × 1/cos(θ/2)), so any angle takes the same code. → flat positions
 *  + indices; the realizer computes normals. */
export function sweepProfile(path, profile, y0, ends = null) {
  if (path.length < 2 || profile.length < 2) return { positions: [], indices: [] };
  const closed = path.length > 2
    && Math.abs(path[0][0] - path[path.length - 1][0]) < 1e-9
    && Math.abs(path[0][1] - path[path.length - 1][1]) < 1e-9;
  const pts = closed ? path.slice(0, -1) : path;
  const n = pts.length;
  const segDir = [];
  for (let i = 0; i < n - (closed ? 0 : 1); i++) {
    const a = pts[i], b = pts[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const L = Math.hypot(dx, dz) || 1;
    segDir.push([dx / L, dz / L]);
  }
  /** unit normal (left of travel) */
  const nrm = (d) => [-d[1], d[0]];
  const offsets = [];
  for (let i = 0; i < n; i++) {
    // `ends` lets a piece mitre against a neighbour it isn't chained to (an apertured segment is swept alone); a butt joint
    // hides at 90° but leaves a visible wedge at 45°
    let dIn = closed ? segDir[(i - 1 + n) % n] : segDir[Math.max(0, i - 1)];
    let dOut = closed ? segDir[i % n] : segDir[Math.min(segDir.length - 1, i)];
    if (!closed && i === 0 && ends?.inDir) dIn = ends.inDir;
    if (!closed && i === n - 1 && ends?.outDir) dOut = ends.outDir;
    const nIn = nrm(dIn), nOut = nrm(dOut);
    let mx = nIn[0] + nOut[0], mz = nIn[1] + nOut[1];
    const mL = Math.hypot(mx, mz);
    if (mL < 1e-6) { offsets.push(nOut); continue; }   // 180° doubling back
    mx /= mL; mz /= mL;
    // 1/cos(θ/2): the amount the mitre must reach to keep both faces flush
    const scale = 1 / Math.max(0.35, mx * nOut[0] + mz * nOut[1]);
    offsets.push([mx * scale, mz * scale]);
  }
  const positions = [];
  for (let i = 0; i < n; i++) {
    const [px, pz] = pts[i], [ox, oz] = offsets[i];
    for (const [u, v] of profile) positions.push(px + ox * u, y0 + v, pz + oz * u);
  }
  const P = profile.length;
  const indices = [];
  const rings = closed ? n : n - 1;
  for (let i = 0; i < rings; i++) {
    const a = i * P, b = ((i + 1) % n) * P;
    for (let j = 0; j < P - 1; j++) {
      // winding: the lateral offset is the LEFT normal of travel, so the obvious quad order points normals into the wall.
      // Reversed here; pinned by the outward-normal test.
      indices.push(a + j, b + j + 1, b + j, a + j, a + j + 1, b + j + 1);
    }
  }
  // END CAPS on an open run, else it is a hollow tube and a doorway shows the inside of the wall (a missing jamb)
  if (!closed) {
    const cap = capProfile(profile);
    const last = (n - 1) * P;
    for (let t = 0; t < cap.length; t += 3) {
      // the far cap faces along travel, the near cap against it, so their windings are opposites
      indices.push(last + cap[t], last + cap[t + 1], last + cap[t + 2]);
      indices.push(cap[t + 2], cap[t + 1], cap[t]);
    }
  }
  return { positions, indices, ringSize: P, rings: n };
}


/** A wall segment's two endpoints in grid-local metres, for any axis. */
export function segmentEnds(e, g) {
  // both diagonals cut their OWN cell, as nodeAtPoint/halfTriangle define: axis 3 starts at NE and ends at SW, never the NW corner
  const a = [(e.x + (e.axis === 3 ? 1 : 0)) * g.tile, e.z * g.tile];
  const b = e.axis === 0 ? [(e.x + 1) * g.tile, e.z * g.tile]
    : e.axis === 1 ? [e.x * g.tile, (e.z + 1) * g.tile]
    : e.axis === 2 ? [(e.x + 1) * g.tile, (e.z + 1) * g.tile]
    : [e.x * g.tile, (e.z + 1) * g.tile];
  return [a, b];
}

/** So an apertured segment's swept ends mitre into the run they interrupt. */
function neighbourDirs(level, g, key, e) {
  const [a, b] = segmentEnds(e, g);
  const unit = (p, q) => {
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]) || 1;
    return [(q[0] - p[0]) / d, (q[1] - p[1]) / d];
  };
  const own = unit(a, b);
  /** `leaving` picks the neighbour's direction: ARRIVING at the node for a path's start, LEAVING it for its end (arriving for
     *  both flips the bisector and overshoots the corner). */
  const at = (node, want, leaving) => {
    let best = null, bestDot = -2;
    for (const [k2, e2] of level.walls) {
      if (k2 === key) continue;
      const [c, d] = segmentEnds(e2, g);
      for (const [p, q] of [[c, d], [d, c]]) {
        if (Math.hypot(p[0] - node[0], p[1] - node[1]) > 1e-9) continue;
        const dir = leaving ? unit(p, q) : unit(q, p);
        const dot = dir[0] * want[0] + dir[1] * want[1];
        if (dot > bestDot) { bestDot = dot; best = dir; }
      }
    }
    return best;
  };
  return { inDir: at(a, own, false) ?? undefined, outDir: at(b, own, true) ?? undefined };
}

/** Swept geometry for one level: every solid wall run, mitred. */
export function levelSweeps(level, g, floorY) {
  const prof = wallProfile(g);
  const out = [];
  for (const line of wallPolylines(level, g)) {
    const sw = sweepProfile(line.pts, prof, floorY);
    if (sw.positions.length) out.push({ ...sw, mat: line.mat, kind: 'wall' });
  }
  // a half-floored cell's slab is a TRIANGLE, else the floor runs past the diagonal out of the building and a cut corner looks
  // like a wall standing on a floor
  for (const [k, mat] of level.tiles) {
    const half = level.halves?.get(k);
    if (!half) continue;
    const [x, z] = k.split(',').map(Number);
    const d = diagOf(level, x, z);
    if (!d) continue;
    const pr = triPrism(halfTriangle(x, z, d, half, g), floorY - g.slabT, floorY);
    out.push({ ...pr, mat, kind: 'floor' });
  }

  // an apertured segment is the same swept profile clipped vertically, so panels over doors and under windows line up
  for (const [k, e] of level.walls) {
    const ap = level.apertures.get(k);
    if (!ap) continue;
    const prf = APERTURES[ap];
    const [a, b] = segmentEnds(e, g);
    const top = Math.min(prf.top, g.wallH);
    const nd = neighbourDirs(level, g, k, e);
    for (const [lo, hi] of [[0, prf.bottom], [top, g.wallH]]) {
      if (hi - lo < 1e-6) continue;
      const cp = clipProfileV(prof, lo, hi);
      if (cp.length < 2) continue;
      const sw = sweepProfile([a, b], cp, floorY, nd);
      if (sw.positions.length) out.push({ ...sw, mat: e.mat, kind: 'wall' });
    }
    // GLASS IS SWEPT TOO: as a box through edgeSpan ("not axis 0" means axis 1) a diagonal window came out axis-aligned
    if (prf.bottom > 0) {
      const gt = TRIM.glass.t / 2;
      const pane = [[-gt, prf.bottom], [-gt, top], [gt, top], [gt, prf.bottom], [-gt, prf.bottom]];
      const gs = sweepProfile([a, b], pane, floorY, nd);
      if (gs.positions.length) out.push({ ...gs, mat: 'glass', kind: 'glass' });
    }
  }
  return out;
}

/** A lintel is [top, H], a sill [0, bottom], each keeping the wall's chamfer, plinth and thickness; the flat cut is the reveal
 *  (soffit, ledge). */
export function clipProfileV(profile, vMin, vMax) {
  const out = [];
  const lerp = (a, b, v) => {
    const t = (v - a[1]) / (b[1] - a[1]);
    return [a[0] + (b[0] - a[0]) * t, v];
  };
  for (let i = 0; i < profile.length; i++) {
    const cur = profile[i], prev = profile[i - 1];
    if (prev) {
      for (const edge of [vMin, vMax]) {
        if ((prev[1] < edge && cur[1] > edge) || (prev[1] > edge && cur[1] < edge)) {
          out.push(lerp(prev, cur, edge));
        }
      }
    }
    if (cur[1] >= vMin - 1e-9 && cur[1] <= vMax + 1e-9) out.push(cur);
  }
  // drop duplicates the clipping can produce at a vertex sitting on a cut
  return out.filter((p, i, a) => i === 0
    || Math.abs(p[0] - a[i - 1][0]) > 1e-9 || Math.abs(p[1] - a[i - 1][1]) > 1e-9);
}

/** As an END CAP (else a doorway shows the hollow inside of the wall). The profile is v-monotone by construction, so it
 *  triangulates by merge-walking the two chains: no ear clipping. */
export function capProfile(profile) {
  const n = profile.length;
  if (n < 3) return [];
  let apex = 0;
  for (let i = 1; i < n; i++) if (profile[i][1] > profile[apex][1]) apex = i;
  const left = [], right = [];
  for (let i = 0; i <= apex; i++) left.push(i);
  for (let i = n - 1; i >= apex; i--) right.push(i);
  const tris = [];
  let li = 0, ri = 0;
  while (li < left.length - 1 || ri < right.length - 1) {
    const advanceLeft = ri >= right.length - 1
      || (li < left.length - 1 && profile[left[li + 1]][1] <= profile[right[ri + 1]][1]);
    if (advanceLeft) { tris.push(left[li], left[li + 1], right[ri]); li++; }
    else { tris.push(right[ri], left[li], right[ri + 1]); ri++; }
  }
  return tris;
}

/** The three corners of a floored half-cell, in grid-local metres. */
export function halfTriangle(x, z, diag, half, g) {
  const t = g.tile, X = x * t, Z = z * t;
  const c = { nw: [X, Z], ne: [X + t, Z], se: [X + t, Z + t], sw: [X, Z + t] };
  if (diag === 2) {                                   // ↘ from nw to se
    return half === 'A' ? [c.nw, c.ne, c.se] : [c.nw, c.se, c.sw];
  }
  return half === 'A' ? [c.nw, c.ne, c.sw] : [c.ne, c.se, c.sw];   // ↗ from ne to sw
}

/** With outward normals (the slab under a half-cell); orientation is DERIVED by the cross product, never assumed per case. */
export function triPrism(corners, y0, y1) {
  let [p0, p1, p2] = corners;
  const a = [p1[0] - p0[0], p1[1] - p0[1]], b = [p2[0] - p0[0], p2[1] - p0[1]];
  if (a[1] * b[0] - a[0] * b[1] <= 0) { const s = p1; p1 = p2; p2 = s; }
  const tri = [p0, p1, p2];
  const positions = [];
  for (const y of [y1, y0]) for (const p of tri) positions.push(p[0], y, p[1]);
  const indices = [0, 1, 2, 5, 4, 3];                 // top up, bottom down
  for (let i = 0; i < 3; i++) {
    const j = (i + 1) % 3;
    // the caps' winding makes the sides run the other way: the outward side needs the reversed order (checked by signed volume)
    indices.push(i, j + 3, j, i, i + 3, j + 3);       // side quad, outward
  }
  return { positions, indices };
}
