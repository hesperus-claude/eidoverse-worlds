// structure — the griddled-building realizer (TEL0S_NOTES §11.4), the hosted half of shared/structure.js: merged
// geometry per palette material plus collider boxes, rebuilt wholesale on any change so it can't drift from the fold.
// Nothing outside this file addresses a wall. Style is an index and a uniform, never a new node graph (that recompiles).

import { THREE, TSL, scene } from '../core.js';
import { bus, report } from '../base.js';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { state, onWorldChange } from '../state.js';
import { prepareObject } from '../materials.js';
import { fitStructureBoxes, removeStructureBoxes, removeCollider, fitCollider } from '../colliders.js';
import { entities } from '../world.js';
import { planStructure, makeShader } from '../../../shared/structure.js';
import { defsRegistry } from '../defs.js';

// procedural from grid-local position (no texture bytes, no visible repeat); every graph is built ONCE at load
const {
  positionLocal, attribute, vec3, float, floor: tslFloor, fract, abs: tslAbs,
  smoothstep, mx_noise_float, mx_fractal_noise_float,
} = TSL;

/** The baked AO/daylight term: colorNode REPLACES the default path, vertex colours included, so multiply it back in
 *  by hand or the shading bake is silently lost. */
const baked = () => attribute('color', 'vec3');

const fbm = (p, oct = 3) => mx_fractal_noise_float(p, oct, 2.0, 0.5).mul(0.5).add(0.5);

/** Plaster: broad patchiness plus a fine tooth, just enough that a 4 m wall isn't one flat value. */
function plaster(base) {
  const p = positionLocal;
  return base
    .mul(float(0.93).add(fbm(p.mul(0.55)).mul(0.10)).add(fbm(p.mul(6.5), 2).mul(0.05)))
    .mul(baked());
}

/** Planks along X, each its own tone, darkening into the seams. */
function boards(base) {
  const p = positionLocal;
  const u = p.x.div(0.185);
  const seam = tslAbs(fract(u).sub(0.5)).mul(2.0);
  const groove = smoothstep(0.80, 1.0, seam).mul(0.30);
  const tone = mx_noise_float(vec3(tslFloor(u).mul(0.37), 0.0, 0.0)).mul(0.5).add(0.5);
  const grain = fbm(vec3(p.x.mul(2.0), p.y, p.z.mul(20.0)), 2);
  return base
    .mul(float(0.86).add(tone.mul(0.20)).add(grain.mul(0.06)).sub(groove))
    .mul(baked());
}

/** Almost flat, a whisper of unevenness so it isn't plastic. */
function painted(base) {
  return base.mul(float(0.96).add(fbm(positionLocal.mul(3.0), 2).mul(0.06))).mul(baked());
}

/** ⚠️ `vec3(0xe4ded1)` is a vec3 of the integer 14999249 (blown-out white), not a colour: decode the hex through
 *  THREE.Color first, which also lands it in the renderer's working colour space. */
const lit = (hex, roughness, node) => {
  const c = new THREE.Color(hex);
  const m = new THREE.MeshStandardNodeMaterial({ color: hex, roughness, metalness: 0 });
  m.colorNode = node(vec3(c.r, c.g, c.b));
  return m;
};

// §24 defs: palette VALUES overlay from defs/structure/_palette.json onto the live shared materials, so a def edit
// restyles standing buildings
const FINISHES = { plaster, boards, painted };
const PALETTE = {
  wall: lit(0xe4ded1, 0.94, plaster),
  floor: lit(0xa8814f, 0.80, boards),
  trim: lit(0xf2efe8, 0.62, painted),    // lighter than the wall
  roof: lit(0x6d6257, 0.90, plaster),
  glass: new THREE.MeshPhysicalNodeMaterial({
    color: 0xcfe2e8, roughness: 0.06, metalness: 0,
    transparent: true, opacity: 0.22, side: THREE.DoubleSide,
  }),
};

function applyPaletteStyle(style) {
  for (const [slot, s] of Object.entries(style ?? {})) {
    const m = PALETTE[slot];
    if (!m || !s || typeof s !== 'object') continue;   // unknown slots: future members, skipped
    if (s.color != null) m.color.set(s.color);
    if (s.roughness != null) m.roughness = s.roughness;
    if (s.opacity != null && m.transparent) m.opacity = s.opacity;
    if (slot !== 'glass') {
      // the colour rides colorNode (see baked()): rebuild it through the chosen finish and recompile
      const c = new THREE.Color(s.color ?? m.color);
      const finish = FINISHES[s.finish]
        ?? (slot === 'floor' ? boards : slot === 'trim' ? painted : plaster);
      m.colorNode = finish(vec3(c.r, c.g, c.b));
      m.needsUpdate = true;
    }
  }
}

/** Author `mat` wins where it names a real slot, else the structural `kind` decides.
 *  A style catalog plugs in here, never by adding palette members (that costs a recompile). */
function slotFor(part) {
  if (PALETTE[part.mat]) return part.mat;
  if (part.kind === 'floor') return 'floor';
  if (part.kind === 'roof') return 'roof';
  if (part.kind === 'glass') return 'glass';
  if (part.kind === 'corner') return 'wall';
  if (part.kind === 'base' || part.kind === 'case' || part.kind === 'sill'
    || part.kind === 'lintel') return 'trim';
  return 'wall';
}

/** AO/daylight into vertex colours, a pure function of position and normal: boxes meeting at a face shade
 *  continuously with no welding. */
function paintGeometry(geo, shade) {
  const pos = geo.getAttribute('position'), nor = geo.getAttribute('normal');
  const col = new Float32Array(pos.count * 3);
  for (let i = 0; i < pos.count; i++) {
    const c = shade(pos.getX(i), pos.getY(i), pos.getZ(i),
      nor.getX(i), nor.getY(i), nor.getZ(i));
    col[i * 3] = c[0]; col[i * 3 + 1] = c[1]; col[i * 3 + 2] = c[2];
  }
  geo.setAttribute('color', new THREE.BufferAttribute(col, 3));
}

const tracked = new Map(); // entity id -> { group, sig, geoms: BufferGeometry[] }
let cutaway = false;

/** Idempotent; also applies to buildings that appear DURING the mode. */
export function setCutaway(on) {
  cutaway = !!on;
  for (const t of tracked.values()) {
    t.group.traverse((o) => { if (o.userData?.structRoof) o.visible = !cutaway; });
  }
  return cutaway;
}
export const isCutaway = () => cutaway;

const structOf = (ent) => (ent && typeof ent === 'object' ? ent.structure ?? null : null);

const transformOf = (ent) => ({
  position: Array.isArray(ent?.pos) && ent.pos.length === 3 && ent.pos.every(Number.isFinite)
    ? ent.pos : [0, 0, 0],
  yaw: Number.isFinite(ent?.yaw) ? ent.yaw : 0,
  scale: Number.isFinite(ent?.scale) && ent.scale > 0 ? ent.scale : 1,
  // the drawn group takes full q and scale3; the collider boxes stay yaw and one scale (fitStructureBoxes' frame)
  q: Array.isArray(ent?.q) && ent.q.length === 4 && ent.q.every(Number.isFinite) ? ent.q : null,
  scale3: Array.isArray(ent?.scale3) && ent.scale3.length === 3 && ent.scale3.every((x) => Number.isFinite(x) && x > 0) ? ent.scale3 : null,
});
function poseGroup(group, tf) {
  group.position.set(...tf.position);
  if (tf.q) group.quaternion.set(...tf.q); else group.rotation.set(0, tf.yaw, 0);
  if (tf.scale3) group.scale.set(...tf.scale3); else group.scale.setScalar(tf.scale);
}

/** Geometry only (no scene insertion, no colliders), so a throw in here leaks nothing. */
function buildGroup(plan) {
  const bySlot = new Map();
  for (const lv of plan.levels) {
    const shade = makeShader(lv.level, plan.grid, lv.y);
    // NON-INDEXED before normals, so each chamfer facet gets a flat normal (a hard highlight)
    for (const sw of lv.sweeps ?? []) {
      if (!sw.positions.length) continue;
      const geo = new THREE.BufferGeometry();
      geo.setAttribute('position', new THREE.Float32BufferAttribute(sw.positions, 3));
      geo.setIndex(sw.indices);
      const flat = geo.toNonIndexed();
      geo.dispose();
      flat.computeVertexNormals();
      const slot = PALETTE[sw.mat] ? sw.mat : 'wall';
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push({ g: flat, shade });
    }
    for (const b of lv.parts) {
      const w = Math.abs(b.x1 - b.x0), h = Math.abs(b.y1 - b.y0), d = Math.abs(b.z1 - b.z0);
      if (!(w > 0 && h > 0 && d > 0)) continue;
      const boxed = new THREE.BoxGeometry(w, h, d);
      boxed.translate((b.x0 + b.x1) / 2, (b.y0 + b.y1) / 2, (b.z0 + b.z1) / 2);
      // non-indexed like the sweeps: mergeGeometries refuses a mix
      const g = boxed.toNonIndexed();
      boxed.dispose();
      // nothing samples a texture, and mergeGeometries refuses a mix of attribute sets
      g.deleteAttribute('uv');
      const slot = slotFor(b);
      if (!bySlot.has(slot)) bySlot.set(slot, []);
      bySlot.get(slot).push({ g, shade });
    }
  }
  const group = new THREE.Group();
  const geoms = [];
  for (const [slot, entries] of bySlot) {
    // paint BEFORE the merge, so every part is shaded by its own level's field
    if (slot !== 'glass') for (const { g, shade } of entries) paintGeometry(g, shade);
    // mergeGeometries fails the whole slot on ANY attribute/index mismatch (saying only "index 6"): normalise, and
    // name what arrived different
    const want = slot === 'glass' ? ['position', 'normal'] : ['position', 'normal', 'color'];
    for (const e of entries) {
      let g2 = e.g;
      if (g2.index) g2 = g2.toNonIndexed();
      for (const name of Object.keys(g2.attributes)) {
        if (!want.includes(name)) g2.deleteAttribute(name);
      }
      const missing = want.filter((n) => !g2.attributes[n]);
      if (missing.length) {
        report(`structure geometry (${slot})`,
          new Error(`piece missing ${missing.join(', ')} — dropped from the merge`));
        e.g = null; continue;
      }
      e.g = g2;
    }
    const usable = entries.filter((e) => e.g);
    const merged = mergeGeometries(usable.map((e) => e.g), false);
    for (const { g } of usable) g.dispose();    // the merge copied them
    if (!merged) continue;
    const mesh = new THREE.Mesh(merged, PALETTE[slot] ?? PALETTE.wall);
    mesh.castShadow = false;   // the baked term does the work real shadows would
    mesh.receiveShadow = true;
    // THE CUTAWAY: the roof comes off while building, or no floor under it can be laid
    if (slot === 'roof') { mesh.userData.structRoof = true; mesh.visible = !cutaway; }
    group.add(mesh);
    geoms.push(merged);
  }
  // through the factory BEFORE the first compile: nothing is wrapped after it has been seen (materials.js)
  prepareObject(group, { kind: 'model' });
  return { group, geoms };
}

/** Hide the anchor: the models realizer also builds a `structure`'s `lib` (spec/PROTOCOL.md §10). Re-applied, as the
 *  models object can arrive after the structure realized. */
function hideAnchor(id) {
  const anchor = entities.get(id);
  if (!anchor) return;
  anchor.visible = false;
  // and its collider (an invisible crate, keyed by the bare id; ours are <id>#sN)
  removeCollider(id);
}

function retire(id) {
  // give the anchor back, mesh AND collider, so removing only `structure` leaves an ordinary solid crate
  const anchor = entities.get(id);
  if (anchor) {
    anchor.visible = true;
    try { fitCollider(id, anchor, { localFrame: true, scale: anchor.scale?.x || 1 }); }
    catch (e) { report(`structure anchor restore ${id}`, e); }
  }
  const t = tracked.get(id);
  if (!t) return;
  scene.remove(t.group);
  for (const g of t.geoms) g.dispose();     // palette materials are shared: never disposed
  removeStructureBoxes(id);
  tracked.delete(id);
  bus.emit('entity', { id, kind: 'collider' });   // the grass mask loses a clearing
}

/** Idempotent: same state in, same scene out. */
function realize(id, ent) {
  const data = structOf(ent);
  if (!data) { retire(id); return; }
  const tf = transformOf(ent);
  const sig = JSON.stringify(data);
  const prev = tracked.get(id);

  if (prev && prev.sig === sig) {
    // only the pose moved, yet colliders are re-declared: their bucket registration is world-space
    poseGroup(prev.group, tf);
    fitStructureBoxes(id, prev.plan.boxes, tf);
    bus.emit('entity', { id, kind: 'collider' });
    return;
  }

  const plan = planStructure(data);
  const { group, geoms } = buildGroup(plan);
  poseGroup(group, tf);

  if (prev) { scene.remove(prev.group); for (const g of prev.geoms) g.dispose(); }
  scene.add(group);
  tracked.set(id, { group, geoms, sig, plan });
  fitStructureBoxes(id, plan.boxes, tf);

  hideAnchor(id);
  bus.emit('entity', { id, kind: 'collider' });
}

/** The plan a building is realized from: lets look() answer "which room" without touching the scene. */
export const structurePlan = (id) => tracked.get(id)?.plan ?? null;
export const structureIds = () => [...tracked.keys()];

/** Full idempotent pass: hydration, world switch, late enable. */
export function reconcileStructures() {
  const seen = new Set();
  for (const [id, ent] of Object.entries(state.st.entities ?? {})) {
    if (!structOf(ent)) continue;
    seen.add(id);
    try { realize(id, ent); } catch (e) { report(`realize structure ${id}`, e); }
  }
  // tracked but no longer a building (component removed, entity removed)
  for (const id of [...tracked.keys()]) if (!seen.has(id)) retire(id);
}

function onChange({ id, what, comp }) {
  try {
    switch (what) {
      case 'comp': if (comp === 'structure') realize(id, state.st.entities[id]); break;
      // re-derive from state: a re-born thing may have dropped its structure
      case 'born': realize(id, state.st.entities[id]); break;
      case 'pose': if (tracked.has(id)) realize(id, state.st.entities[id]); break;
      case 'gone': retire(id); break;
    }
  } catch (e) { report(`realize structure ${what}`, e); }
}



/** Called once from main.js. */
export function initStructureRealizer() {
  // the §24 style overlay, on registry load or defs-updated; a failed fetch keeps the built-in style
  const restyle = () => defsRegistry()
    .then((reg) => applyPaletteStyle(reg.structurePalette))
    .catch((e) => report('structure palette', e));
  restyle();
  bus.on('defs-updated', restyle);
  // models announces every object it creates or moves (and late collider fits); hideAnchor emits nothing, so no loop
  bus.on('entity', (ev) => { if (ev?.id && tracked.has(ev.id)) hideAnchor(ev.id); });
  onWorldChange((ev) => {
    if (ev.type === 'hydrated') reconcileStructures();
    else if (ev.type === 'reset') { for (const id of [...tracked.keys()]) retire(id); }
    else if (ev.type === 'change') onChange(ev);
  });
  return true;
}

/** For tests and teardown. */
export function disposeStructures() {
  for (const id of [...tracked.keys()]) retire(id);
}
