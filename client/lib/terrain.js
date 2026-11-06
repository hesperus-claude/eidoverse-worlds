// terrain — the world's ground truth for "how high is the floor here".
//
// Its own module (rather than living in world.js) purely to break a cycle:
// the controller needs ground height every frame, and world.js needs the
// controller's position to place things. Both depend on this instead.

import { scene, ground, grid, axisLines } from './core.js';
import { bus } from './base.js';
import { retireField } from './flora_field.js';
import { makeGrassQuality, GRASS_QUALITY } from './grass_quality.js';

let current = null;
// with no terrain mesh the stage floor is the ground: at 0, or at a flat terrain's height (componentspec terrain kind flat)
let floorY = 0;
export function setFlatGround(y) {
  floorY = Number.isFinite(y) ? y : 0;
  for (const [o, lift] of [[ground, 0], [grid, 0.02], [axisLines, 0.04]]) if (o) o.position.y = floorY + lift;
  bus.emit('ground-changed');
}

export const heightAt = (x, z) => (current ? current.heightAt(x, z) : floorY);
// The water, for whatever floats in it (ammodoll.js). Browser and headless agents each hand in their own
// (client/lib/water.js, mcpl/physics.ts setWaterField).
// {level, sample(x, z) → shared/waterkind.js sample | null, time() → wave seconds} or null for no water.
let water = null;
export const waterField = () => water;
export function setWaterField(f) { water = f ?? null; bus.emit('ground-changed'); }
export const hasTerrain = () => current !== null;

/** Where the rain lands (weather_system's groundHeightAt): the terrain or the water over it, whichever
 *  is higher; null past the terrain's edge (no splash). Baked into a heightfield, not called per frame;
 *  'ground-changed' re-bakes it. */
export function rainSurfaceAt(x, z) {
  if (!current) return heightAt(x, z);
  const box = extentOf(current);
  if (box && (x < box.minX || x > box.maxX || z < box.minZ || z > box.maxZ)) return null;
  const h = current.heightAt(x, z);
  const level = water?.level;
  return typeof level === 'number' && level > h ? level : h;
}
// The terrain's horizontal footprint in world space, from its mesh (a PlaneGeometry of the verb's
// `size`, centred where the mesh stands). Agents' terrains have no mesh: no edge, ground everywhere.
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
    // …and FREE it (§13.1): three's renderer pins uploaded geometry/textures in strong maps. Terrain
    // resources are per-build, nothing shared, so dispose wholesale.
    current.mesh?.traverse?.((o) => {
      o.geometry?.dispose?.();
      for (const m of Array.isArray(o.material) ? o.material : o.material ? [o.material] : []) {
        for (const v of Object.values(m)) if (v?.isTexture) v.dispose();
        m.dispose?.();
      }
    });
    // layer textures ride the colorNode, not material properties (world.js
    // stashes them at build for exactly this pass)
    for (const tex of current.layerTextures ?? []) tex?.dispose?.();
  }
  current = t;
  // ground/grid are null under the headless core stub (an agent's settle sim has no stage floor)
  if (t) {
    if (t.mesh) {
      // the sky's scene-diff claim must never own the ground, or a sky rebuild would remove it (§17c)
      if (t.mesh.userData) { t.mesh.userData.skyExempt = true; t.mesh.userData.odTag = 'terrain'; }
      scene.add(t.mesh);
    }
    // terrain replaces the stage floor
    if (ground) ground.visible = false;
    if (grid) grid.visible = false;
    if (axisLines) axisLines.visible = false;
  } else {
    if (ground) ground.visible = true;
    if (grid) grid.visible = true;
    if (axisLines) axisLines.visible = true;
  }
  // the ground moved: whatever stands on it by height (the rain's splashes, via sky.js) re-reads it
  bus.emit('ground-changed');
}

// ---- grass -----------------------------------------------------------------
// A flora field adds its mesh to the scene AND pushes per-frame hooks into
// globalThis._autoParticleSystems; replacing or clearing must undo BOTH.
// setGrass owns that, retireField does the work (via the field's own dispose():
// its mesh is a Group, so walking mesh.geometry/material would free nothing).
let currentGrass = null;

export function setGrass(field) {
  retireField(currentGrass, globalThis._autoParticleSystems, scene);
  currentGrass = field ?? null;
  // sticky budget: a machine that had to thin its meadow keeps it thin
  // across re-grows, instead of re-discovering the same slow frame rate —
  // and a resident's chosen cap (persisted) survives them the same way
  if (field && budget.effective() < 1) applyGrassBudget();
}
export const clearGrass = () => setGrass(null);
export const hasGrass = () => currentGrass !== null;
/** The live field object — grassdiag's toggle surface (§22). */
export const getGrassField = () => currentGrass;

// The meadow budget: the resident's persisted cap × the governor's session
// shed (grass_quality.js owns the semantics — effective is their min).
const budget = makeGrassQuality(globalThis.localStorage);

function applyGrassBudget() {
  const eff = budget.effective();
  if (currentGrass) {
    // `off` hides the group too (spares raycasts/shadows); the field stays whole for a later raise
    if (currentGrass.mesh) currentGrass.mesh.visible = eff > 0;
    currentGrass.setDensity?.(eff);
  }
  // the dials (the grass⚙ row) hear every budget change, the governor's included
  bus.emit('grass-budget');
}

// Perf governor's handle on the meadow — may thin below the resident's cap,
// never raises above it (the cap wins in effective()).
export function setGrassDensity(f) {
  budget.shedTo(f);
  applyGrassBudget();
}
/** effective REQUESTED density — what the two dials agreed to ask for.
 *  Whether the renderer actually applied it is getGrassApplied()'s answer:
 *  a stroke without a working count dial draws denser than this number. */
export const getGrassDensity = () => budget.effective();

/** The full budget→draw chain: the resident's chosen level,
 *  the governor's shed, the requested effective factor, and what the
 *  renderer verifiably APPLIED — read from live instance counts, never from
 *  policy arithmetic. status: 'applied' | 'partial' | 'unavailable' |
 *  'not-applied' | 'unknown' (field predates draw-state reporting) |
 *  'no-field'. Strokes carry per-stroke truth so partial failure names the
 *  affected stroke(s). Shared authored grass state is never touched. */
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

/** Tile-level truth (§13.2): how each stroke is cut and what it draws right now. */
export function grassTiles() {
  if (!currentGrass) return { field: false, strokes: [] };
  const strokes = (currentGrass._strokes ?? []).map((f, i) => {
    const tiles = f.tiles ?? [];
    return {
      stroke: f.strokeLabel ?? `stroke ${i}`,
      // §22m: the material this stroke built: 'opaque', 'cards-fast', 'cards-sss', or species default
      mode: f.grassMode ?? 'n/a',
      tiled: !!f.tiled,
      // tiled strokes: f.count is the LIVE summing getter, so the
      // planted total lives on the tiles' fullCount
      planted: tiles.length
        ? tiles.reduce((s, t) => s + (t.userData.fullCount ?? 0), 0)
        : (f.count ?? 0),
      tiles: tiles.length,
      visible: tiles.filter((t) => t.visible).length,
      drawn: tiles.length
        ? tiles.reduce((s, t) => s + t.count, 0)
        : (f.mesh?.count ?? f.count ?? 0),
      // §17b blade LOD: `lod` = the stroke carries far-index twins; `lodTiles` = tiles drawing the thinned tuft now
      lod: tiles.some((t) => t.userData.lodFar !== undefined),
      lodTiles: tiles.filter((t) => t.userData.lodFar === true).length,
    };
  });
  return { field: true, strokes };
}

// The resident's own dial: full | medium | low | off, persisted per
// browser. Never a verb — the shared field is world state, the draw cost is
// not.
export function setGrassQuality(q) {
  const applied = budget.setQuality(q);
  applyGrassBudget();
  return applied;
}
export const getGrassQuality = () => budget.quality;
/** the governor's uncapped session dial, for inspection */
export const getGrassShed = () => budget.shed;
export { GRASS_QUALITY };
