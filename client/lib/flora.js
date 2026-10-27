// flora — the DOM/THREE-bound browser host for the vegetation brush (`createFlora`): GPU-instanced species with
// PBR map sets, self-animating wind, pushers that part foliage around walkers.
// Pure logic, tested by tools/flora.test.ts: flora_args.js (bag mapping, strokes), flora_field.js (field lifecycle),
// flora_lod.js (blade-LOD index subsets, §17b).
import { THREE, TSL, camera, renderer } from './core.js';
import { bus, CONFIG } from './base.js';
import { primeFiles } from './assets.js';
import { colliders } from './colliders.js';
import { myState } from './controller.js';
import { remotes } from './remotes.js';
import { mapGrassArgs, presetStrokes } from './flora_args.js';
import { composeField } from './flora_field.js';
import { bladeLodIndex, bladeCoarseIndex } from './flora_lod.js';
import { densityCount } from './grass_quality.js';
import { pushHostHook } from './autohooks.js';

export { mapGrassArgs, presetStrokes } from './flora_args.js';
export { retireField } from './flora_field.js';

let floraMod = null;
/** Lazy (client/lib/vegetation/, §24j): it reads globalThis.THREE and the asset shim, and stays off the boot path. */
export async function loadFloraModule() {
  if (!floraMod) {
    floraMod = import('./vegetation/vegetation.js').then(async (m) => {
      // §24: hydrate the species registry BEFORE anyone resolves the module (a pre-defs build has its table baked in)
      await m.ensureFloraDefs?.();
      // engine parity: the loader shim registers these globally
      globalThis.createFlora = m.createFlora;
      globalThis.FLORA_SPECIES = m.FLORA_SPECIES;
      globalThis.GRASS_COLORS = m.GRASS_COLORS;
      globalThis.resetFloraOccupancy = m.resetFloraOccupancy;
      return m;
    });
  }
  return floraMod;
}

const GRASS_DIR = 'eidoverse/assets/grass';
/** The module reads them synchronously, Deno-style; missing optional maps degrade inside it. */
async function ensureFloraAssets(mod, species) {
  const spec = mod.FLORA_SPECIES[species];
  if (!spec) return;
  const paths = [];
  if (spec.maps) {
    for (const kind of ['albedo', 'normal', 'roughness', 'translucency']) {
      paths.push(`${GRASS_DIR}/${spec.maps}_${kind}.png`);
    }
  }
  if (spec.stem) {
    for (const kind of ['albedo', 'normal', 'roughness']) {
      paths.push(`${GRASS_DIR}/${spec.stem}_${kind}.png`);
    }
  }
  // blade grasses and the sunflower fit card widths to an alpha-envelope json; unprimed, built-in envelopes
  if (spec.archetype === 'blades' || spec.archetype === 'sunflower') {
    paths.push(`${GRASS_DIR}/${spec.maps}_fit.json`);
  }
  if (spec.archetype === 'shrub') paths.push(`${GRASS_DIR}/shrub_anchors.json`);
  await primeFiles(paths); // missing files warn + degrade, never throw
}

// ---- interior clearings: ONE mask per FIELD, disposed with it (a module-global mask orphans earlier strokes).
// It samples the plant's world XZ (positionNode output): positionLocal is per-plant space under instancing.
const MASK = 256;

function makeClearingMask(W, D) {
  const canvas = document.createElement('canvas');
  canvas.width = canvas.height = MASK;
  const ctx = canvas.getContext('2d');
  const tex = new THREE.CanvasTexture(canvas);
  tex.flipY = false;
  const paint = () => {
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, MASK, MASK);
    ctx.fillStyle = '#000';
    for (const [, e] of colliders) {
      if (!e.interior) continue;                    // things with a real floor only
      const { obj, box } = e;
      const s = obj.scale?.x || 1;
      const hw = ((box.max.x - box.min.x) / 2) * s + 0.15;  // small apron past the wall
      const hd = ((box.max.z - box.min.z) / 2) * s + 0.15;
      const bx = ((box.max.x + box.min.x) / 2) * s, bz = ((box.max.z + box.min.z) / 2) * s;
      const c = Math.cos(obj.rotation.y), n = Math.sin(obj.rotation.y);
      const wx = obj.position.x + bx * c + bz * n;
      const wz = obj.position.z - bx * n + bz * c;
      ctx.save();
      ctx.translate(((wx + W / 2) / W) * MASK, ((wz + D / 2) / D) * MASK);
      ctx.rotate(-obj.rotation.y);
      ctx.fillRect((-hw / W) * MASK, (-hd / D) * MASK, (2 * hw / W) * MASK, (2 * hd / D) * MASK);
      ctx.restore();
    }
    tex.needsUpdate = true;
  };
  const unsubscribe = bus.on('entity', paint);      // spawns/moves/rescales repaint
  paint();
  /** Composes with the stroke's own positionNode (instancing + wind + pushers live there). */
  const wire = (mat) => {
    if (!mat) return;
    const { Fn, texture, vec2, vec3, float } = TSL;
    const orig = mat.positionNode;
    mat.positionNode = Fn(() => {
      const p = vec3(orig).toVar();
      const uv = p.xz.add(vec2(W / 2, D / 2)).div(vec2(W, D));
      const mask = texture(tex, uv).r;              // 1 = meadow, 0 = interior
      const sink = float(1).sub(mask).mul(4);       // deep enough for corn, not just blades
      return p.sub(vec3(0, sink, 0));
    })();
  };
  return { tex, paint, wire, dispose: () => { unsubscribe(); tex.dispose(); } };
}

// ---- density dial: per-instance arrays are shuffled once, deterministically, so InstancedMesh.count thins uniformly
function wireDensityDial(field) {
  const geo = field.mesh.geometry;
  const attrs = ['aPosRot', 'aScaleVar', 'aPhase'].map((n) => geo.getAttribute(n)).filter(Boolean);
  const n = field.count;
  if (!n || !attrs.length) return;
  const order = Array.from({ length: n }, (_, i) => i);
  let seed = 0x6d2b79f5;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x80000000);
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (const a of attrs) {
    const sz = a.itemSize, src = a.array.slice();
    for (let i = 0; i < n; i++) {
      const s = order[i] * sz, d = i * sz;
      for (let k = 0; k < sz; k++) a.array[d + k] = src[s + k];
    }
    a.needsUpdate = true;
  }
  // the stem mesh shares the attribute OBJECTS: only the count needs mirroring
  field.setDensity = (f) => {
    // densityCount owns the clamp, including genuine zero for `off` (#60)
    const keep = densityCount(n, f);
    field.mesh.count = keep;
    if (field.stemMesh) field.stemMesh.count = keep;
  };
}

// ---- frustum culling (§13.2 G1): instanceMatrix is all identity (transforms ride aPosRot), so three would cull a
// half-metre sphere at the origin; we assign a real world sphere (a non-null one is never recomputed).
function wireFieldCulling(field) {
  const geo = field.mesh.geometry;
  const posRot = geo.getAttribute('aPosRot');
  const scaleVar = geo.getAttribute('aScaleVar');
  if (!posRot || !field.count) return;
  const box = new THREE.Box3();
  const v = new THREE.Vector3();
  for (let i = 0; i < field.count; i++) {
    box.expandByPoint(v.set(posRot.getX(i), posRot.getY(i), posRot.getZ(i)));
  }
  // plant height × the tallest instance + the engine's 0.6 tanh lean ceiling, conservative on every axis
  geo.computeBoundingBox();   // per-plant LOCAL bounds (positions, not instances)
  const plantH = Math.max(0.5, geo.boundingBox.max.y - Math.min(0, geo.boundingBox.min.y));
  let maxScale = 1;
  if (scaleVar) {
    for (let i = 0; i < field.count; i++) maxScale = Math.max(maxScale, scaleVar.getY(i));
  }
  box.expandByScalar(plantH * maxScale + 0.6);
  const sphere = new THREE.Sphere();
  box.getBoundingSphere(sphere);
  // the field group is at the scene root with identity transform: world space is what the frustum test wants
  field.mesh.boundingSphere = sphere;
  field.mesh.frustumCulled = true;
  if (field.stemMesh) {   // shrub wood is a CHILD mesh — culled independently
    field.stemMesh.boundingSphere = sphere;
    field.stemMesh.frustumCulled = true;
  }
}

// ---- tiling (§13.2 G2, §16.2.B) + blade LOD (§17b): big strokes re-cut into XZ tiles sharing attributes and one
// material, sized by occupancy (§16.1b). instanceMatrix is allocated past the uniform limit ON PURPOSE so every tile
// shares one count-independent program (TEL0S_NOTES §16.2) — see docs/research/grass-tiling-lod.md.

// §22 grassdiag toggles — normal operation leaves all of these alone
let pushersFrozen = false;
let lodForce = null;               // null | 'near' | 'far'
let diagScope = null;              // {near, far} density multipliers by diag band
const DIAG_SCOPE_EDGE = 20;        // m — grassdiag's near/far split
export function freezePushers(on) { pushersFrozen = !!on; }
export function forceBladeLod(mode) { lodForce = mode ?? null; }   // takes effect within one 300ms tile tick
/** §22c: scope a density cut to the near ring or the far sea (WHERE does a density win come from?). null restores. */
export function setDiagDensityScope(scope) { diagScope = scope ?? null; }

const TILE_MIN_INSTANCES = 2000;   // shrubs/yucca are hundreds — stay whole
const TILE_MAX_EDGE = 28;          // m — §22h: the nearest-edge budget over-submits by ~a tile radius, and
                                   // dither-killed instances aren't free; smaller tiles halve the waste
const TILE_MIN_OCC = 256;          // can't reach this per tile → stay whole
// GLOBAL-RANK tiling: a blades stroke the rules above refuse still tiles. Every tuft keeps its whole-stroke rank; a
// tile's count is a ceiling at its nearest XZ point (less GR_MARGIN) the shader's keep test refines. ?grassgrank=0 off.
const GR_ON = CONFIG.params.get('grassgrank') !== '0';
const GR_MIN_INSTANCES = 1000;
const GR_MIN_OCC = 128;
const GR_MARGIN = 2;               // m — re-applied per GR_MARGIN/2 of eye travel; one frame behind, so a teleport
                                   // can under-draw ONE frame
const TILE_MAX_AXIS = 12;          // §22n: finer tiles pin the nearest-edge budget to the dither curve; 16 adds nothing
// §22d: at distance FEWER tufts, not thinner ones (subpixel cards are near-pure per-instance overhead)
const GRASS_NEAR = 15;             // full density inside this
const GRASS_FAR = 90;              // invisible beyond this
const GRASS_FALL_EXP = 2.5;        // shared with the shader's dither (§22f): CPU budget and visible density, one law
const BLADE_LOD_KEEP = 0.4;        // far tiles keep ceil(0.4 × perBunch) blades per tuft (§17b)
// Coarse far twin (§22n): off by default (measured inert), ?grassvlod=on opts in, forceBladeLod('far') diags it.
// Shaped density (§22q): thins by DENSE_BASE, widens survivors by 1/√DENSE_BASE, full density at the feet.
// ?grassdense=N, 1 = kill switch. Why each step: docs/research/grass-tiling-lod.md.
const DENSE_DEFAULT = 0.65;        // §22q: the least thinning that held the frame cap on the probe meadow
export const DENSE_BASE = (() => {
  const v = Number(CONFIG.params.get('grassdense'));
  return Number.isFinite(v) && v > 0 && v <= 1 ? v : DENSE_DEFAULT;
})();
const DENSE_GUARD_NEAR = 2;        // m — full density inside this…
const DENSE_GUARD_FAR = 8;         // m — …ramped to DENSE_BASE by this
/** CPU mirror of the shader's guard ramp. */
const denseAt = (d) => {
  if (DENSE_BASE >= 1) return 1;
  const t = Math.min(1, Math.max(0, (d - DENSE_GUARD_NEAR) / (DENSE_GUARD_FAR - DENSE_GUARD_NEAR)));
  return 1 + (DENSE_BASE - 1) * t * t * (3 - 2 * t);   // smoothstep, same knots
};
const VLOD_ON = CONFIG.params.get('grassvlod') === 'on';
const BLADE_LOD_OUT = VLOD_ON ? 45 : Infinity;   // m — tile swaps to coarse past this
const BLADE_LOD_IN = VLOD_ON ? 38 : Infinity;    // m — and back only inside this
const _tv = new THREE.Vector3();
const _eye = new THREE.Vector3();   // WORLD space (see applyTiles)

/** Read off the live backend's uniform-buffer limit. `threshold` = target occupancy; `cross` = the smallest allocation
 *  on the shared-program path, 0 when an exotic limit makes forcing it wasteful (degraded, never wrong). */
function matrixPathCaps() {
  let limit = 65536;
  try { limit = renderer.backend.capabilities.getUniformBufferLimit() || 65536; }
  catch { /* pre-init or stubbed backend — assume the WebGPU default */ }
  const threshold = Math.floor(Math.min(65536, limit) / 64);
  const cross = Math.floor(limit / 64) + 1;
  return { threshold, cross: cross * 64 <= 262144 ? cross : 0 };
}

function tileField(f, bladeLod = false, globalRank = false) {
  // the shrub archetype pairs a stem mesh sharing backing arrays — skip it
  if (f.stemMesh || (f.count ?? 0) < (globalRank ? GR_MIN_INSTANCES : TILE_MIN_INSTANCES)) return false;
  const src = f.mesh.geometry;
  const names = ['aPosRot', 'aScaleVar', 'aPhase'];
  const inst = names.map((n) => src.getAttribute(n));
  if (inst.some((a) => !a)) return false;
  const posRot = inst[0], scaleVar = inst[1];
  const n = f.count;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, maxScale = 1;
  for (let i = 0; i < n; i++) {
    const x = posRot.getX(i), z = posRot.getZ(i);
    if (x < minX) minX = x; if (x > maxX) maxX = x;
    if (z < minZ) minZ = z; if (z > maxZ) maxZ = z;
    const s = scaleVar.getY(i);
    if (s > maxScale) maxScale = s;
  }
  const spanX = (maxX - minX) || 1, spanZ = (maxZ - minZ) || 1;
  const { threshold, cross } = matrixPathCaps();
  // the edge cap may ADD columns/rows a sparse stroke can't afford: the occupancy floor below refuses those
  const afford = Math.max(1, Math.floor(n / threshold));
  // ?grasstiles=N — §22n diag override: finer tiles fit the §22h budget to the dither curve, at more draw calls
  const axisCap = Number(CONFIG.params.get('grasstiles')) || TILE_MAX_AXIS;
  let nx = Math.min(axisCap, Math.max(1, Math.round(Math.sqrt(afford * spanX / spanZ))));
  let nz = Math.min(axisCap, Math.max(1, Math.round(afford / nx)));
  nx = Math.max(nx, Math.ceil(spanX / TILE_MAX_EDGE));
  nz = Math.max(nz, Math.ceil(spanZ / TILE_MAX_EDGE));
  if (nx * nz < 4) return false;     // culling can't win on a postage stamp
  if (n / (nx * nz) < (globalRank ? GR_MIN_OCC : TILE_MIN_OCC)) return false;   // sparse: stroke sphere already culls
  if (globalRank) {                  // the untiled path's whole-stroke rank, written BEFORE slicing (buildFloraField)
    const ph = src.getAttribute('aPhase');
    for (let k = 0; k < n; k++) ph.array[k * 3] = (Math.PI * 2 * k) / n;
    ph.needsUpdate = true;
  }
  const buckets = Array.from({ length: nx * nz }, () => []);
  for (let i = 0; i < n; i++) {      // STABLE scan — preserves the shuffle
    const tx = Math.min(nx - 1, Math.floor((posRot.getX(i) - minX) / spanX * nx));
    const tz = Math.min(nz - 1, Math.floor((posRot.getZ(i) - minZ) / spanZ * nz));
    buckets[tz * nx + tx].push(i);
  }
  src.computeBoundingBox();          // per-plant LOCAL bounds (tiny)
  const plantH = Math.max(0.5, src.boundingBox.max.y - Math.min(0, src.boundingBox.min.y));
  const pad = plantH * maxScale + 0.6;   // tallest plant + the wind/push lean ceiling
  // §17b: ONE far-LOD index per stroke, shared by every tile's far twin (flora_lod.js re-verifies the layout)
  let farIndex = null;
  if (bladeLod) {
    const srcIdx = src.getIndex();
    // §22n: the far twin is the COARSE index; the count-subset builder stays for diag/weak-tier use
    const sub = srcIdx && (bladeCoarseIndex(srcIdx.array, src.getAttribute('position').count)
      ?? bladeLodIndex(srcIdx.array, src.getAttribute('position').count, BLADE_LOD_KEEP));
    if (sub) farIndex = new THREE.BufferAttribute(sub, 1);
  }
  const container = new THREE.Group();
  container.userData = { ...f.mesh.userData };
  const tiles = [];
  const lodGeos = new Map();         // tile → { near, far } geometry twins (§17b)
  const grTiles = new Map();         // tile → { gIdx (ascending global indices), XZ bounds } — global-rank path
  const m4 = new THREE.Matrix4();
  for (const idx of buckets) {
    if (!idx.length) continue;
    const tg = new THREE.BufferGeometry();
    tg.setIndex(src.getIndex());
    for (const name of ['position', 'normal', 'uv', 'aH', 'color']) {
      const a = src.getAttribute(name);
      if (a) tg.setAttribute(name, a);   // SHARED objects — one GPU upload
    }                                    // 'color' (§22m vertex palette): a tile without it draws BLACK
    const box = new THREE.Box3();
    names.forEach((name, j) => {
      const a = inst[j], sz = a.itemSize;
      const arr = new a.array.constructor(idx.length * sz);
      for (let k = 0; k < idx.length; k++) {
        for (let c = 0; c < sz; c++) arr[k * sz + c] = a.array[idx[k] * sz + c];
      }
      tg.setAttribute(name, new THREE.InstancedBufferAttribute(arr, sz));
    });
    // §22f: rank into the flutter-phase lane; the dither keeps an instance iff rank < keep(distance), no seams
    if (!globalRank) {
      const ph = tg.getAttribute('aPhase');
      if (ph) for (let k = 0; k < idx.length; k++) ph.array[k * 3] = (Math.PI * 2 * k) / idx.length;
    }
    for (const i of idx) box.expandByPoint(_tv.set(posRot.getX(i), posRot.getY(i), posRot.getZ(i)));
    box.expandByScalar(pad);
    // past the uniform-buffer limit: one shared program (section header)
    const alloc = Math.max(idx.length, cross);
    const tm = new THREE.InstancedMesh(tg, f.mesh.material, alloc);
    for (let k = 0; k < alloc; k++) tm.setMatrixAt(k, m4.identity());   // the engine's identity contract
    tm.count = idx.length;             // the DRAW count is live; the allocation is not
    const sphere = box.getBoundingSphere(new THREE.Sphere());
    tm.boundingSphere = sphere;        // the SAME sphere goes on the geometry: the render sort reads that one
    tg.boundingSphere = sphere;
    tm.frustumCulled = true;
    Object.assign(tm.userData, f.mesh.userData);   // noWalkable/noSupportCheck/…
    tm.castShadow = false;
    tm.receiveShadow = f.mesh.receiveShadow;
    tm.userData.fullCount = idx.length;
    if (globalRank) {
      let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
      for (const i of idx) {
        const x = posRot.getX(i), z = posRot.getZ(i);
        if (x < x0) x0 = x; if (x > x1) x1 = x; if (z < z0) z0 = z; if (z > z1) z1 = z;
      }
      grTiles.set(tm, { gIdx: Int32Array.from(idx), x0, x1, z0, z1 });   // idx ascending: the stable scan
    }
    // §17b: layout keys use an index PRESENCE flag, never its identity, so the near/far swap re-keys nothing
    if (farIndex) {
      const fg = new THREE.BufferGeometry();
      fg.setIndex(farIndex);           // per-STROKE object, shared by every tile
      for (const name of ['position', 'normal', 'uv', 'aH', 'color']) {
        const a = src.getAttribute(name);
        if (a) fg.setAttribute(name, a);
      }
      for (const name of names) fg.setAttribute(name, tg.getAttribute(name));
      // the SAME sphere object as the near geometry: sort and culling stay true across every swap
      fg.boundingSphere = sphere;
      tm.userData.lodFar = false;      // observable per-tile state (EW.grass)
      lodGeos.set(tm, { near: tg, far: fg });
    }
    container.add(tm);
    tiles.push(tm);
  }
  // the container answers for the stroke: applied truth (#74) reads .count
  Object.defineProperty(container, 'count', {
    get: () => tiles.reduce((s, t) => s + (t.visible ? t.count : 0), 0),
  });
  const origDispose = f.dispose;
  f.mesh = container;
  f.tiled = true;
  f.tiles = tiles;
  let eff = 1;
  let grEyeX = Infinity, grEyeZ = Infinity;   // where the global-rank budget was last evaluated
  const applyTiles = () => {
    // WORLD position: in XR the camera is a child of the rig (xr.js), so camera.position is rig-relative
    camera.getWorldPosition(_eye);
    grEyeX = _eye.x; grEyeZ = _eye.z;
    for (const t of tiles) {
      const gr = grTiles.get(t);
      if (gr) {
        const dx = Math.max(gr.x0 - _eye.x, 0, _eye.x - gr.x1), dz = Math.max(gr.z0 - _eye.z, 0, _eye.z - gr.z1);
        const dN = Math.max(0, Math.hypot(dx, dz) - GR_MARGIN);
        const fall = dN >= GRASS_FAR ? 0
          : dN <= GRASS_NEAR ? 1
            : (1 - (dN - GRASS_NEAR) / (GRASS_FAR - GRASS_NEAR)) ** GRASS_FALL_EXP;
        const scope = diagScope ? (dN < DIAG_SCOPE_EDGE ? diagScope.near : diagScope.far) : 1;
        // +2: the shader keeps rank ≤ keep (so rank 0 survives keep 0) and compares float32 ranks
        const lim = Math.min(eff <= 0 ? 0 : densityCount(n, eff), Math.floor(fall * scope * denseAt(dN) * n) + 2);
        let lo = 0, hi = gr.gIdx.length;           // count of entries with global index < lim
        while (lo < hi) { const m = (lo + hi) >> 1; if (gr.gIdx[m] < lim) lo = m + 1; else hi = m; }
        t.count = lo;
        t.visible = lo > 0;
        continue;
      }
      const d = _tv.copy(t.boundingSphere.center).distanceTo(_eye);
      // §22f: the CPU count is a BUDGET at the tile's NEAREST point (keep(dNearest) ≥ keep(d) for all its instances)
      const dN = Math.max(0.01, d - t.boundingSphere.radius);
      const fall = dN >= GRASS_FAR ? 0
        : dN <= GRASS_NEAR ? 1
          : (1 - (dN - GRASS_NEAR) / (GRASS_FAR - GRASS_NEAR)) ** GRASS_FALL_EXP;
      const scope = diagScope ? (d < DIAG_SCOPE_EDGE ? diagScope.near : diagScope.far) : 1;
      // §22q: denseAt(nearest) ≥ every instance's keep multiplier: a ceiling, never a seam
      t.count = densityCount(t.userData.fullCount, eff * fall * scope * denseAt(dN));
      t.visible = t.count > 0;
      // §17b: blade LOD one band later, with hysteresis; the swap is a pointer write, never a compile
      const pair = lodGeos.get(t);
      if (pair) {
        // lodForce (§22 grassdiag) overrides the bands; null = the hysteresis
        const wantFar = lodForce ? lodForce === 'far'
          : (t.userData.lodFar ? d > BLADE_LOD_IN : d >= BLADE_LOD_OUT);
        if (wantFar && !t.userData.lodFar) {
          t.geometry = pair.far; t.userData.lodFar = true;
        } else if (!wantFar && t.userData.lodFar) {
          t.geometry = pair.near; t.userData.lodFar = false;
        }
      }
    }
  };
  f.setDensity = (k) => { eff = k; applyTiles(); };
  f._applyTiles = applyTiles;        // warmField re-settles counts post-warm
  let lastTick = 0;
  f._tileTick = () => {              // buildFloraField hangs this on autoHooks
    const now = performance.now();
    if (grTiles.size) {
      camera.getWorldPosition(_tv);
      if ((_tv.x - grEyeX) ** 2 + (_tv.z - grEyeZ) ** 2 > (GR_MARGIN / 2) ** 2) { lastTick = now; applyTiles(); return; }
    }
    if (now - lastTick < 300) return;
    lastTick = now;
    applyTiles();
  };
  applyTiles();
  f.dispose = () => {
    for (const t of tiles) {                       // shared buffers die with the field;
      const pair = lodGeos.get(t);
      if (pair) (t.geometry === pair.far ? pair.near : pair.far).dispose();
      t.geometry.dispose();                        // …the unmounted LOD twin too
    }
    origDispose?.call(f);
  };
  return true;
}

// ---- pushers: up to 4 slots part the plants; slot 0 is the local avatar, the rest the nearest remotes
function wirePushers(field) {
  const R = 1.1;
  // reused across frames: a per-frame hook must not allocate (§14.1)
  const list = [];
  const cand = [];
  const hook = () => {
    list.length = 0;
    // diag freeze (§22 grassdiag): an empty list zeroes the shader's displacement work
    if (pushersFrozen) { field.setPushers(list); return; }
    if (myState?.pos) list.push({ x: myState.pos.x, y: myState.pos.y, z: myState.pos.z, r: R });
    if (remotes?.size) {
      cand.length = 0;
      for (const [, rb] of remotes) {
        const p = rb?.avatar?.root?.position;
        if (p) cand.push(p);
      }
      if (myState?.pos && cand.length > 3) {
        cand.sort((a, b) => a.distanceToSquared(myState.pos) - b.distanceToSquared(myState.pos));
      }
      for (let i = 0; i < Math.min(3, cand.length); i++) {
        const p = cand[i];
        list.push({ x: p.x, y: p.y, z: p.z, r: R });
      }
    }
    field.setPushers(list);
  };
  pushHostHook(hook);
  return hook;
}

/** Build a flora field from a `grass` verb bag (terrain.js setGrass contract). Added to the scene here; setGrass
 *  owns removing and disposing it. */
export async function buildFloraField(rawArgs, { scene, heightFn }) {
  const mod = await loadFloraModule();
  const args = mapGrassArgs(rawArgs);
  // presets: the def registry (§24), populated since the module resolved after ensureFloraDefs
  const strokes = presetStrokes(args, mod.FLORA_PRESETS);
  const species = [...new Set(strokes.map((st) => st.species ?? 'grass'))];
  for (const sp of species) await ensureFloraAssets(mod, sp);
  // a fresh occupancy registry per build, or a replaced field's plants still claim their ground
  mod.resetFloraOccupancy();
  const W = args.width ?? args.size ?? 30, D = args.depth ?? args.size ?? 30;
  const mask = makeClearingMask(W, D);
  const group = new THREE.Group();
  const fields = [];
  try {
    for (const st of strokes) {
      // §22e: blades get density-compensation grow, constants MATCHED to the falloff; shrubs/yucca get none.
      // §22i A/B: ?grasslod=off (no grow), =nodither (grow only), default = §22h.
      const lodMode = CONFIG.params.get('grasslod') ?? 'full';
      // §22l: one albedo fetch (fastShade); a 4 cm blade can't show the rest. ?grassshade=full for A/B.
      const shadeMode = CONFIG.params.get('grassshade') ?? 'fast';
      // §22m: opaque geometry blades (fitted envelope, vertex-color palette, no alpha test). ?grassgeo=cards for A/B.
      const geoMode = CONFIG.params.get('grassgeo') ?? 'opaque';
      const isBladeSpecies = mod.FLORA_SPECIES?.[st.species]?.archetype === 'blades';
      const blades = isBladeSpecies && lodMode !== 'off';
      const f = await mod.createFlora({
        ...st, heightFn,
        ...(blades ? { lodGrow: { near: GRASS_NEAR, far: GRASS_FAR, cap: 1.7,
          ...(lodMode !== 'nodither' ? { exp: GRASS_FALL_EXP, vertsPerBlade: 10, bladeKeepFar: 0.4,
            // §22q (DENSE_BASE above); absent (=1) the shader is byte-identical
            ...(DENSE_BASE < 1 ? { baseKeep: DENSE_BASE,
              guardNear: DENSE_GUARD_NEAR, guardFar: DENSE_GUARD_FAR } : {}),
          } : {}),
        } } : {}),
        ...(isBladeSpecies && shadeMode === 'fast' ? { fastShade: true } : {}),
        ...(isBladeSpecies && geoMode === 'opaque' ? { opaqueBlades: true } : {}),
      });
      // named so an applied-truth report can identify the stroke
      f.strokeLabel = `${fields.length}:${st.species ?? 'grass'}`;
      // §22m: read from the material, since the palette sampler can fall back silently
      f.grassMode = !isBladeSpecies ? 'n/a'
        : f.material?.alphaTest === 0 ? 'opaque'
        : f.material?.type === 'MeshSSSNodeMaterial' ? 'cards-sss' : 'cards-fast';
      if (isBladeSpecies) console.log(`[flora] ${f.strokeLabel} blades mode: ${f.grassMode}`);
      wireDensityDial(f);
      mask.wire(f.material);
      // only 'blades' carries LOD twins (§17b): other geometry has no per-blade runs
      const arch = mod.FLORA_SPECIES[st.species ?? 'grass']?.archetype;
      // global-rank: only while the shader dither owns density (it refines the ceiling)
      const grOk = GR_ON && blades && lodMode !== 'nodither';
      if (!tileField(f, arch === 'blades') && !(grOk && tileField(f, arch === 'blades', true))) {
        wireFieldCulling(f);
        // §22f: the dither needs the rank wherever lodGrow.exp rides (tiled strokes write it per tile)
        const ph = f.mesh?.geometry?.getAttribute?.('aPhase');
        if (ph && f.count) {
          for (let k = 0; k < f.count; k++) ph.array[k * 3] = (Math.PI * 2 * k) / f.count;
          ph.needsUpdate = true;
        }
      }
      group.add(f.mesh);
      fields.push(f);
    }
  } catch (e) {
    // a half-built field must not leak its listener or its finished strokes
    for (const f of fields) f.dispose?.();
    mask.dispose();
    throw e;
  }
  const field = composeField({ group, fields, mask });
  field._strokes = fields;   // warmField re-settles per-tile falloff after the warm
  field.autoHooks.push(wirePushers(field));   // setGrass unhooks everything the field owns
  for (const f of fields) {
    if (f._tileTick) { pushHostHook(f._tileTick); field.autoHooks.push(f._tileTick); }
  }
  // the sky's scene-diff claim must never own the meadow (§17c): builds overlap at boot
  group.userData.skyExempt = true;
  group.userData.odTag = 'grass';   // overdraw.js category
  scene.add(group);
  return field;
}

// ---- the warm (§16.2.B): compileAsync skips culled objects and a cold tile codegens in its first render, so each
// warms detached with culling defeated. LOD twins share the layout cache key: no second pass.

/** Compiles off the render path, then re-settles tile counts against the live camera. Awaited between
 *  prepareObject and setGrass (world.js); errors are swallowed like every warm. */
export async function warmField(field, renderer, camera, scene) {
  const root = field?.mesh;
  if (!root) return;
  const meshes = [];
  root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  // the field leaves the scene: a real frame mid-warm must never meet a cold sibling and compile inside render()
  const sceneParent = root.parent;
  sceneParent?.remove(root);
  try {
    for (const o of meshes) {
      const parent = o.parent;
      parent?.remove(o);               // detached: never drawn mid-compile —
      const save = { visible: o.visible, frustumCulled: o.frustumCulled, count: o.count };
      o.visible = true;                // …compileAsync(o, …) still walks it
      o.frustumCulled = false;
      if (o.isInstancedMesh && o.count < 2) o.count = 2;  // count-0 tiles still compile
      try {
        await renderer.compileAsync(o, camera, scene).catch(() => {});
      } finally {
        o.visible = save.visible;
        o.frustumCulled = save.frustumCulled;
        if (o.isInstancedMesh) o.count = save.count;
        parent?.add(o);
      }
      // a REAL frame between objects: scheduler.yield-style continuations starve rAF on Chromium
      await new Promise((r) => requestAnimationFrame(r));
    }
  } finally {
    sceneParent?.add(root);
  }
  // settled at BUILD time against the boot camera; re-settle now the camera is live
  for (const f of field._strokes ?? []) f._applyTiles?.();
}
