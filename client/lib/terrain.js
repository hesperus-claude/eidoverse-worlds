// terrain — the world's ground height (and water, grass budget); its own module to break the controller ↔ world.js cycle

import { scene, ground, grid, axisLines } from './core.js';
import { bus } from './base.js';
import { retireField } from './flora_field.js';
import { makeGrassQuality, GRASS_QUALITY } from './grass_quality.js';

let current = null;
let environmentFloor = null;
export function setEnvironmentFloor(y) {
  environmentFloor = Number.isFinite(y) ? y : null;
  if (!current) {
    if (ground) ground.visible = environmentFloor === null;
    if (grid) grid.visible = environmentFloor === null;
  }
}

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : (environmentFloor ?? 0));
// the water for floaters (ammodoll.js), set by client/lib/water.js or mcpl/physics.ts
// {level, sample(x, z) → shared/waterkind.js sample | null, time() → wave seconds} or null for no water
let water = null;
export const waterField = () => water;
export function setWaterField(f) { water = f ?? null; bus.emit('ground-changed'); }
export const hasTerrain = () => current !== null;

/** The rain's splash ground: the higher of terrain and water, null past the terrain's edge.
 *  Baked into a heightfield around the camera, not per frame; 'ground-changed' re-bakes. */
export function rainSurfaceAt(x, z) {
  if (!current) return heightAt(x, z);
  const box = extentOf(current);
  if (box && (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ)) return null;
  const h = current.heightAt(x, z);
  const level = water?.level;
  return typeof level === 'number' && level > h ? level : h;
}
// world-space footprint from the mesh; agents' terrains have no mesh: no edge, ground everywhere
const extents = new WeakMap();
function extentOf(t) {
  if (!t.mesh?.geometry) return null;
  let e = extents.get(t);
  if (!e) {
    const g = t.mesh.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const p = t.mesh.position ?? { x: 0, z: 0 };
    e = { minX: g.boundingBox.min.x + p.x, maxX: g.boundingBox.max.x + p.x, minZ: g.boundingBox.min.z + p.z, maxZ: g.boundingBox.max.z + p.z };
    extents.set(t, e);
  }
  return e;
}
/** §22m diag: the terrain mesh, for cost-attribution phases. */
export const getTerrainMesh = () => current?.mesh ?? null;

export function setTerrain(t) {
  if (current) {
    scene.remove(current.mesh);
    // dispose wholesale (§13.1): WebGPU pins uploaded geometry and textures, and terrain resources are per-build
    current.mesh?.traverse?.((o) => {
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose?.();
      }
    });
    // layer textures ride the colorNode, not material properties (world.js stashes them for this pass)
    for (const tex of current.layerTextures ?? []) tex?.dispose?.();
  }
  current = t;
  // ground/grid are null under the headless core stub (an agent's settle sim has no stage floor; issue #17)
  if (t) {
    if (t.mesh) {
      // exempt from the sky's scene-diff claim, or the next sky rebuild removes the ground (§17c)
      if (t.mesh.userData) { t.mesh.userData.skyExempt = true; t.mesh.userData.odTag = 'terrain'; }
      scene.add(t.mesh);
    }
    if (ground) ground.visible = false;
    if (grid) grid.visible = false;
    if (axisLines) axisLines.visible = false;
  } else {
    if (ground) ground.visible = environmentFloor === null;
    if (grid) grid.visible = environmentFloor === null;
    if (axisLines) axisLines.visible = environmentFloor === null;
  }
  // whatever stands on it by height (the rain's splashes, via sky.js) re-reads it
  bus.emit('ground-changed');
}

// ---- grass -----------------------------------------------------------------
// replacing a field must undo its mesh AND its per-frame hooks (retireField); the mesh is a Group, so prefer its dispose()
let currentGrass = null;

export function setGrass(field) {
  retireField(currentGrass, globalThis._autoParticleSystems, scene);
  currentGrass = field ?? null;
  // sticky budget: a thinned meadow (or a resident's cap) survives re-grows, instead of re-finding the slow frame rate
  if (field && budget.effective() < 1) applyGrassBudget();
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;
/** grassdiag's toggle surface (§22). */
export const getGrassField = () => currentGrass;

// the resident's persisted cap and the governor's session shed; grass_quality.js owns the semantics
const budget = makeGrassQuality(globalThis.localStorage);

function applyGrassBudget() {
  const eff = budget.effective();
  if (currentGrass) {
    // `off` hides the group too (spares raycasts/shadows); the field stays whole, so a cap raise restores it in place
    if (currentGrass.mesh) currentGrass.mesh.visible = eff > 0;
    currentGrass.setDensity?.(eff);
  }
  // the dials (grass⚙ row) hear every change, the governor's included, or they go stale until the panel reopens
  bus.emit('grass-budget');
}

// the perf governor's handle: may thin below the resident's cap, never above it
export function setGrassDensity(f) {
  budget.shedTo(f);
  applyGrassBudget();
}
/** REQUESTED density, not applied: a stroke without a working count dial draws denser (see getGrassApplied). */
export const getGrassDensity = () => budget.effective();

/** The budget→draw chain (#74), down to what was verifiably APPLIED (live instance counts).
 *  status: 'applied' | 'partial' | 'unavailable' | 'not-applied' | 'unknown' | 'no-field'. */
export function getGrassApplied() {
  const base = {
    quality: budget.quality, cap: budget.cap,
    shed: budget.shed, requested: budget.effective(),
  };
  if (!currentGrass) return { ...base, field: false, status: 'no-field', strokes: [] };
  const rep = currentGrass.applied?.(base.requested);
  // a field that cannot report draw state must not read as success
  if (!rep) return { ...base, field: true, status: 'unknown', strokes: [] };
  return { ...base, field: true, ...rep };
}

/** Tile-level stats (§13.2): how each stroke is cut and what it draws right now. */
export function grassTiles() {
  if (!currentGrass) return { field: false, strokes: [] };
  const strokes = (currentGrass._strokes ?? []).map((f, i) => {
    const tiles = f.tiles ?? [];
    return {
      stroke: f.strokeLabel ?? `stroke ${i}`,
      // §22m: the material this stroke built: 'opaque' (palette blades), 'cards-fast', 'cards-sss', or species default
      mode: f.grassMode ?? 'n/a',
      tiled: !!f.tiled,
      // tiled: f.count is the LIVE summing getter (#74), so the planted total is the tiles' fullCount
      planted: tiles.length
        ? tiles.reduce((s, t) => s + (t.userData.fullCount ?? 0), 0)
        : (f.count ?? 0),
      tiles: tiles.length,
      visible: tiles.filter((t) => t.visible).length,
      drawn: tiles.length
        ? tiles.reduce((s, t) => s + t.count, 0)
        : (f.mesh?.count ?? f.count ?? 0),
      // §17b: `lod` = carries far-index twins; `lodTiles` = tiles drawing the thinned tuft now. Keep fields (bootjank prints them).
      lod: tiles.some((t) => t.userData.lodFar !== undefined),
      lodTiles: tiles.filter((t) => t.userData.lodFar === true).length,
    };
  });
  return { field: true, strokes };
}

// the resident's dial (#60): full | medium | low | off, per browser; never a verb (the field is world state, its draw cost is not)
export function setGrassQuality(q) {
  const applied = budget.setQuality(q);
  applyGrassBudget();
  return applied;
}
export const getGrassQuality = () => budget.quality;
/** the governor's uncapped session dial, for inspection */
export const getGrassShed = () => budget.shed;
export { GRASS_QUALITY };
