// terrainshape — the terrain you SHAPE, over the noise you roll (terrainmath.js); both travel in the `terrain` verb:
//   features   placed shapes, applied in order over the base:
//                {type:'hill',    x, z, radius, height}         a round bump; negative height = a pit
//                {type:'ridge',   x1, z1, x2, z2, radius, height} a raised line; negative = a valley/channel
//                {type:'flatten', x, z, radius, height, edge?}  level a circle to an ABSOLUTE height
//   heightmap  {grid: 'store/heightmaps/<hash>.json', min, max}: an uploaded grayscale image REPLACES the noise base
//              (black = min m, white = max, over the `size` square; image x → +x, image down → +z). Features apply on top.
// One implementation for the client mesh, the agents and the sim, so it holds to the sim's exact-op set (Covenant I:
// + - * /, sqrt, floor; no pow or hypot). A world with neither key never reaches it.

import { MOVER, waterStance, waterCost } from './mover.js';   // the water law (below): one walker, one law

export const MAX_FEATURES = 64;
export const MAX_GRID = 1025;          // per side; a 1025² map is ~2 MB of samples
const TYPES = new Set(['hill', 'ridge', 'flatten']);

const num = (v, d) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const GRID_REF = /^store\/heightmaps\/[0-9a-f]{16}\.json$/;

/** Or null when the world uses none (the caller keeps its plain noise law, untouched). Malformed features are dropped, not guessed at.
 *  @param {Record<string, any>} a */
export function shapeParams(a) {
  const features = [];
  for (const f of Array.isArray(a?.features) ? a.features.slice(0, MAX_FEATURES) : []) {
    if (!f || !TYPES.has(f.type)) continue;
    const radius = clamp(num(f.radius, 0), 0, 2000);
    const height = clamp(num(f.height, 0), -500, 500);
    if (!(radius > 0.05)) continue;
    if (f.type === 'ridge') {
      if (![f.x1, f.z1, f.x2, f.z2].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      features.push({ type: 'ridge', x1: f.x1, z1: f.z1, x2: f.x2, z2: f.z2, radius, height });
    } else {
      if (![f.x, f.z].every((v) => typeof v === 'number' && Number.isFinite(v))) continue;
      const g = { type: f.type, x: f.x, z: f.z, radius, height };
      if (f.type === 'flatten') g.edge = clamp(num(f.edge, radius * 0.5), 0.01, 2000);
      features.push(g);
    }
  }
  let heightmap = null;
  const h = a?.heightmap;
  if (h && typeof h.grid === 'string' && GRID_REF.test(h.grid)) {
    const min = num(h.min, 0), max = num(h.max, 10);
    heightmap = { grid: h.grid, min, max };
  }
  return features.length || heightmap ? { features, heightmap } : null;
}

// ---- heightmap grids ---------------------------------------------------------
// {w, h, data: Uint16Array}, row-major from the image's top-left; on the wire base64 of little-endian uint16s, decoded once
// by the server at upload so every consumer reads integers.

// grids cached by ref (last GRID_CACHE kept); a disk miss is remembered MISS_RETRY_MS, a failed fetch backs off from
// FETCH_RETRY_MS. No ground commits for a heightmap until its grid is here (shapeReady).
const GRID_CACHE = 8;
const MISS_RETRY_MS = 30_000;
const FETCH_RETRY_MS = 1_000;
const grids = new Map();
const misses = new Map();     // ref -> when the loader last failed on it
const fetchMisses = new Map();   // ref -> { until, n }: no fetch before `until`; n failures in a row
const inflight = new Map();   // ref -> the fetch in progress
let loader = null, fetcher = null;

function keep(ref, g) {
  grids.delete(ref); grids.set(ref, g); misses.delete(ref); fetchMisses.delete(ref);
  while (grids.size > GRID_CACHE) grids.delete(grids.keys().next().value);
}
const missedLately = (ref) => { const t = misses.get(ref); return t != null && Date.now() - t < MISS_RETRY_MS; };

/** Make a grid available to every height function that names it. */
export function registerGrid(ref, grid) { keep(ref, grid); }
/** A synchronous source (the server's disk). Clients and agents can't block: see setGridFetcher. */
export function setGridLoader(fn) { loader = fn; }
/** `fn(ref)` resolves to the wire form ({w, h, data}) or throws. */
export function setGridFetcher(fn) { fetcher = fn; }
export function gridFor(ref) {
  let g = grids.get(ref);
  if (g) { grids.delete(ref); grids.set(ref, g); return g; }
  if (!loader || missedLately(ref)) return null;
  try { g = loader(ref); } catch { g = null; }
  if (g) keep(ref, g); else misses.set(ref, Date.now());
  return g ?? null;
}
/** Once at a time per ref: the grid, or null (then not asked again until MISS_RETRY_MS has passed). */
export function requestGrid(ref) {
  const have = gridFor(ref);
  if (have) return Promise.resolve(have);
  if (!fetcher || gridRetryIn(ref) > 0) return Promise.resolve(null);
  let p = inflight.get(ref);
  if (!p) {
    p = (async () => {
      try { const g = decodeGrid(await fetcher(ref)); keep(ref, g); return g; }
      catch {
        const n = (fetchMisses.get(ref)?.n ?? 0) + 1;
        fetchMisses.set(ref, { until: Date.now() + Math.min(MISS_RETRY_MS, FETCH_RETRY_MS * 2 ** (n - 1)), n });
        return null;
      }
      finally { inflight.delete(ref); }
    })();
    inflight.set(ref, p);
  }
  return p;
}
/** 0: now. */
export function gridRetryIn(ref) { const m = fetchMisses.get(ref); return m ? Math.max(0, m.until - Date.now()) : 0; }
/** False while its heightmap grid is missing (the height law would fall back to noise, which nothing should commit to). */
export function shapeReady(shape) { return !shape?.heightmap || !!gridFor(shape.heightmap.grid); }

/** Integer byte assembly, so it is exact everywhere. */
export function decodeGrid(obj) {
  const w = obj?.w | 0, h = obj?.h | 0;
  if (w < 2 || h < 2 || w > MAX_GRID || h > MAX_GRID || typeof obj.data !== 'string') throw new Error('bad heightmap grid');
  const bin = atob(obj.data);
  if (bin.length !== w * h * 2) throw new Error(`heightmap grid has ${bin.length / 2} samples, want ${w * h}`);
  const data = new Uint16Array(w * h);
  for (let i = 0; i < data.length; i++) data[i] = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8);
  return { w, h, data };
}

/** Grid → wire/disk form. */
export function encodeGrid(grid) {
  let s = '';
  const CH = 0x8000;
  const bytes = new Uint8Array(grid.data.length * 2);
  for (let i = 0; i < grid.data.length; i++) { bytes[2 * i] = grid.data[i] & 0xff; bytes[2 * i + 1] = grid.data[i] >> 8; }
  for (let i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
  return { w: grid.w, h: grid.h, data: btoa(s) };
}

// ---- the height law ------------------------------------------------------------

const sm = (t) => (t <= 0 ? 0 : t >= 1 ? 1 : t * t * (3 - 2 * t));
// 1 at the centre, 0 at r, flat at both ends: (1-t²)²
const bell = (d2, r) => { const t2 = d2 / (r * r); if (t2 >= 1) return 0; const k = 1 - t2; return k * k; };

/** @param {(x: number, z: number) => number} base  the noise law (toolkit or terrainmath)
 *  @param {NonNullable<ReturnType<typeof shapeParams>>} S
 *  @param {number} size  the terrain square the heightmap stretches over
 *  @returns {(x: number, z: number) => number} */
export function shapeHeight(base, S, size) {
  const hm = S.heightmap, feats = S.features;
  const half = size / 2;
  const sample = (g, x, z) => {
    // image-space, clamped (outside the square the edge rows extend)
    const u = clamp((x + half) / size, 0, 1) * (g.w - 1), v = clamp((z + half) / size, 0, 1) * (g.h - 1);
    const i = Math.floor(u), j = Math.floor(v);
    const i1 = i + 1 < g.w ? i + 1 : i, j1 = j + 1 < g.h ? j + 1 : j;
    const fu = u - i, fv = v - j, d = g.data, W = g.w;
    const a = d[j * W + i] + (d[j * W + i1] - d[j * W + i]) * fu;
    const b = d[j1 * W + i] + (d[j1 * W + i1] - d[j1 * W + i]) * fu;
    return hm.min + (hm.max - hm.min) * ((a + (b - a) * fv) / 65535);
  };
  // HELD once first found: a built terrain keeps its image however the cache turns over; until then looked up per call
  let held = hm ? gridFor(hm.grid) : null;
  return (x, z) => {
    let h;
    if (hm) {
      const g = held ?? (held = gridFor(hm.grid));
      h = g ? sample(g, x, z) : base(x, z);
    } else h = base(x, z);
    for (let n = 0; n < feats.length; n++) {
      const f = feats[n];
      if (f.type === 'hill') {
        const dx = x - f.x, dz = z - f.z;
        h += f.height * bell(dx * dx + dz * dz, f.radius);
      } else if (f.type === 'ridge') {
        // distance to the segment, squared
        const ex = f.x2 - f.x1, ez = f.z2 - f.z1, L2 = ex * ex + ez * ez;
        let t = L2 > 0 ? ((x - f.x1) * ex + (z - f.z1) * ez) / L2 : 0;
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        const dx = x - (f.x1 + ex * t), dz = z - (f.z1 + ez * t);
        h += f.height * bell(dx * dx + dz * dz, f.radius);
      } else {   // flatten: level to an absolute height, softening out over `edge`
        const dx = x - f.x, dz = z - f.z, d = Math.sqrt(dx * dx + dz * dz);
        const w = d <= f.radius ? 1 : sm(1 - (d - f.radius) / f.edge);
        h += (f.height - h) * w;
      }
    }
    return h;
  };
}

// ---- water ---------------------------------------------------------------------
// One level per world (`water: {level, color?, opacity?}`); the sim ignores it. Wading and swimming live in shared/mover.js:
// these are re-exports, never a copy.
export { waterStance, waterCost };
export const SWIM_AT = MOVER.swim.at;         // of body height: deeper than this at the feet, the body floats
export const SWIM_SPEED = MOVER.swim.speed;   // m/s, a steady stroke
export const SWIM_RUN = MOVER.swim.run;       // m/s, swimming hard (shift)
export const WALK_SPEED = MOVER.walk.speed;   // the walking pace waterCost prices against
/** @deprecated wading has no depth limit now; kept so old callers still read one. */
export const WADE_DEPTH = 1.0;
const HEX = /^#[0-9a-fA-F]{6}$/;
/** @world.water (an older world's terrain.water until the maintenance command moves it), or undefined.
 *  @param {Record<string, any>} c  @world's components (or a view: {water, terrain}) */
export const worldWater = (c) => c?.water ?? c?.terrain?.water;
/** Or null when it has none. Colour is an int (0xRRGGBB) or an older '#rrggbb'.
 *  @param {Record<string, any>} a  terrain-verb args carrying `water` */
export function waterParams(a) {
  const w = a?.water;
  if (!w || typeof w.level !== 'number' || !Number.isFinite(w.level)) return null;
  return {
    level: clamp(w.level, -500, 500),
    color: Number.isInteger(w.color) && w.color >= 0 && w.color <= 0xffffff ? `#${w.color.toString(16).padStart(6, '0')}` : typeof w.color === 'string' && HEX.test(w.color) ? w.color : '#1d5a6e',
    opacity: clamp(num(w.opacity, 0.82), 0.1, 1),
  };
}

/** @deprecated swimming means no step is refused; kept so old callers read "allowed". */
export function wadeAllowed() { return true; }
/** With swimming, water never blocks a move: ask waterCost for what it costs instead. */
export function waterBlocks() { return false; }

/** Or the base itself when the args shape nothing. What the client and agents call. */
export function shapedHeightAt(base, args) {
  const S = shapeParams(args);
  return S ? shapeHeight(base, S, num(args?.size, 80)) : base;
}
