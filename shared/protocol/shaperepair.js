// shared/protocol/shaperepair.js — a value stored before the shape audit, in today's spelling, with the meaning its readers
// gave it. Pure: components in, repaired components out. Callers: the explicit repair command (repairShapes, never a load:
// one `repair-shapes` act ONCE per world, shapesMarked), translate-v1@12's projection, and the old-world oracle. Rules that
// read an absent field may only see pre-audit values: the marker guards that. The rules: docs/MAINTENANCE.md.
import { grassAtWrite } from "./assetref.js";
import { eidoHex } from "../eido.js";
import { COMPONENTS } from "./componentspec.js";
import { partSlot, motionType } from "./names.js";
const bag = (v) => !!v && typeof v === "object" && !Array.isArray(v);
/** Before a light said its own (client/lib/lightrig.js, three.js decay). */
export const OLD_LIGHT_DECAY = 1.7;
export const AXIS_VECTORS = Object.freeze({ x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1], "-x": [-1, 0, 0], "-y": [0, -1, 0], "-z": [0, 0, -1] });
/** The pendulum readings that once lived only in the reader (client/lib/motioneval.js). */
export const OLD_READINGS = Object.freeze({ pendulumPeriod: 3.5, pendulumDamp: 0, wholePendulumPivot: Object.freeze([0, 2, 0]) });
const isMotionKey = (k) => k === "motion" || k.startsWith("motion:");

/** Or the same object when nothing changes. */
export function repairMotion(m) {
  if (!bag(m)) return m;
  let out = m; const edit = () => (out === m ? (out = { ...m }) : out);
  // amp as the old reader read it, Number(m.amp ?? m.amplitude): a numeric string was that number, null was 0, and a null
  // amp gave way to the amplitude
  if ("amplitude" in out) { edit(); const v = Number(out.amplitude); if (out.amp == null && Number.isFinite(v)) out.amp = v; delete out.amplitude; }
  if (typeof out.axis === "string" && AXIS_VECTORS[out.axis.toLowerCase()]) { edit(); out.axis = AXIS_VECTORS[out.axis.toLowerCase()].slice(); }
  if (out.type === "pendulum") {
    if (out.period === undefined) { edit(); out.period = OLD_READINGS.pendulumPeriod; }
    if (out.damp === undefined) { edit(); out.damp = OLD_READINGS.pendulumDamp; }
  }
  return out;
}

/** {c (a new object when anything changed, else the same), set: [keys written], del: [keys removed]}. Only this family's
 *  names are touched. `pathOf(address)` → the library path an old content address names here, or null (absent: models left). */
export function repairComps(c0, { pathOf = null } = {}) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  const drop = (k) => { delete c[k]; del.add(k); set.delete(k); };
  // a keyed motion stored before the node was data: its key's tag was the node's name (motion.js read key.slice(7))
  for (const k of Object.keys(c)) if (k.startsWith("motion:") && bag(c[k]) && !(typeof c[k].node === "string" && c[k].node)) put(k, { ...c[k], node: k.slice(7) });
  // a bare motion naming a part is that node's motion: motion:<slot> {node: <the name as it was>}. partSlot is pure, so every
  // server writes the same key; a motion already on that node wins
  if (bag(c.motion) && typeof c.motion.part === "string" && c.motion.part) {
    const { part, ...rest } = c.motion; const key = `motion:${partSlot(part)}`;
    const onIt = Object.keys(c).some((k) => k.startsWith("motion:") && bag(c[k]) && c[k].node === part);
    if (!onIt && !bag(c[key])) put(key, { ...rest, node: part });
    drop("motion");
  } else if (bag(c.motion) && "part" in c.motion) { const { part: _p, ...rest } = c.motion; put("motion", rest); }   // a part that names nothing
  for (const k of Object.keys(c)) if (isMotionKey(k) && bag(c[k])) { const r = repairMotion(c[k]); if (r !== c[k]) put(k, r); }
  // a whole motion's hinge is the thing's pivot component
  if (bag(c.motion) && "pivot" in c.motion) {
    const { pivot, ...rest } = c.motion; put("motion", rest);
    if (!bag(c.pivot) && Array.isArray(pivot) && pivot.length === 3 && pivot.every(Number.isFinite)) put("pivot", { pos: pivot.slice() });
  }
  if (bag(c.motion) && c.motion.type === "pendulum" && !bag(c.pivot)) put("pivot", { pos: OLD_READINGS.wholePendulumPivot.slice() });
  if (bag(c.collider) && c.collider.shape === "exact") put("collider", { ...c.collider, shape: "mesh" });
  if (bag(c.physics)) { let p = c.physics; const edit = () => (p === c.physics ? (p = { ...c.physics }) : p);
    if (p.kind === undefined) { edit(); p.kind = "dynamic"; }
    if ("material" in p) { edit(); if (p.surface === undefined) p.surface = p.material; delete p.material; }
    for (const k of ["layers", "mask", "ccd"]) if (k in p) { edit(); delete p[k]; }
    if (p !== c.physics) put("physics", p); }
  if (bag(c.light)) { let L = c.light; const edit = () => (L === c.light ? (L = { ...c.light }) : L);
    if (L.decay === undefined) { edit(); L.decay = OLD_LIGHT_DECAY; }
    if ("day" in L) { edit(); if (L.daytime === undefined && typeof L.day === "boolean") L.daytime = L.day ? "dim" : "full"; delete L.day; }
    if (L.daytime === undefined) { edit(); L.daytime = "dim"; }
    if ("shadows" in L) { edit(); delete L.shadows; }
    if (L !== c.light) put("light", L); }
  // a model stored as its content address gets its library path back, the address kept beside it as its hash
  const hex = typeof pathOf === "function" ? eidoHex(c.model) : null;
  if (hex) { let p = null; try { p = pathOf(c.model); } catch { p = null; }
    if (typeof p === "string" && p && !eidoHex(p)) { put("model", p); if (c["model-hash"] === undefined) put("model-hash", `sha256:${hex}`); } }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}

const HEXC = /^#[0-9a-f]{6}$/i;
const hexInt = (x) => (typeof x === "string" && HEXC.test(x) ? parseInt(x.slice(1), 16) : x);
/** Or the same object. */
export function repairSky(sky) {
  if (!bag(sky)) return sky;
  let out = sky; const edit = () => (out === sky ? (out = { ...sky }) : out);
  if ("clock" in out || "dormantRated" in out) { edit();
    if (out.clock === "real") { if (typeof out.tz !== "string" || !out.tz) out.tz = "America/Los_Angeles";
      const d = out.dormantRated; if (bag(d)) { if (Number.isFinite(d.hours)) out.hours = d.hours; if (Number.isFinite(d.rate)) out.rate = d.rate; if (Number.isFinite(d.ts)) out.ts = d.ts; } }
    else delete out.tz;   // a clock other than real: the rated clock governs
    delete out.clock; delete out.dormantRated; }
  // a tz with no clock is today's spelling (it governs): kept. Degrees → radians once (the marker); a turn past a full one is
  // the same bearing (400° is 40°), so it lands inside the registry's ±2π instead of refusing the whole repair
  if (typeof out.azimuth === "number" && Number.isFinite(out.azimuth)) { edit(); out.azimuth = (out.azimuth % 360) * Math.PI / 180; }
  // weatherSeconds → transition; a value today's range can't hold (0, or over 600 s) is dropped: absent, the renderer's own ease
  if ("weatherSeconds" in out) { edit(); const ws = out.weatherSeconds; if (out.transition === undefined && Number.isFinite(ws) && ws > 0 && ws <= 600) out.transition = ws; delete out.weatherSeconds; }
  if (bag(out.forecast) && ("dwellSec" in out.forecast || "transitionSec" in out.forecast)) { edit(); const f = { ...out.forecast };
    if ("dwellSec" in f) { if (f.dwell === undefined) f.dwell = f.dwellSec; delete f.dwellSec; }
    if ("transitionSec" in f) { if (f.transition === undefined) f.transition = f.transitionSec; delete f.transitionSec; }
    out.forecast = f; }
  for (const k of ["sun", "fill", "world"]) if (k in out) { edit(); delete out[k]; }
  return out;
}
/** {c, set, del}, as repairComps; only the world's look. NOT idempotent on a sky (azimuth converts every time), so each
 *  caller hands it a stored value once (the marker: shapesMarked). */
export function repairWorld(c0) {
  if (!bag(c0)) return { c: c0, set: [], del: [] };
  const c = { ...c0 }; const set = new Set(), del = new Set();
  const put = (k, v) => { c[k] = v; set.add(k); del.delete(k); };
  if (bag(c.sky)) { const sky = withSkyDefaults(repairSky(c.sky)); if (JSON.stringify(sky) !== JSON.stringify(c.sky)) put("sky", sky); }   // the old readers' readings of absence ARE the registry's defaults (hours 12, azimuth 180° = π, …)
  if (bag(c.terrain)) { let t = c.terrain; const edit = () => (t === c.terrain ? (t = { ...c.terrain }) : t);
    if (Array.isArray(t.layers) && t.layers.some((l) => bag(l) && typeof l.color === "string" && HEXC.test(l.color))) { edit(); t.layers = t.layers.map((l) => (bag(l) ? { ...l, color: hexInt(l.color) } : l)); }
    if (t.kind === undefined || t.kind === "noise") for (const [k, v] of Object.entries(COMPONENTS.terrain.defaults)) if (t[k] === undefined) { edit(); t[k] = v; }
    if ("water" in t) { edit(); const w = t.water; delete t.water;
      if (bag(w) && !bag(c.water)) put("water", Object.fromEntries(Object.entries(w).map(([k, v]) => [k, k === "color" ? hexInt(v) : v]))); }
    if (t !== c.terrain) put("terrain", t); }
  if (bag(c.grass)) { let g = c.grass; try { g = grassAtWrite(c.grass).value; } catch { g = c.grass; }   // an unknown preset stays as it was (its readers say so)
    if (g !== c.grass) put("grass", g); }
  return set.size || del.size ? { c, set: [...set], del: [...del] } : { c: c0, set: [], del: [] };
}
const withSkyDefaults = (sky) => { const out = { ...sky }; for (const [k, v] of Object.entries(COMPONENTS.sky.defaults)) if (out[k] === undefined) out[k] = v; return out; };

/** Carried by its act (repair-shapes {v}) and a founding (create-world {shapes}). 2: an old content address → its library
 *  path, names kept rather than resolved. A log marked by any version isn't repaired again. */
export const SHAPES_VERSION = 2;
/** True for the repair's own act (any version), a founding stamped with `shapes`, or a translation by translate-v1@12 or
 *  later. A pure view over the log, so every replica answers the same. */
// the marker is the system's repair-shapes act, read by verb and actor (they survive a purge). Older markers are read through
// `bodyOf` (readback): a purged body is unknown, and unknown is MARKED (never re-running a one-way rewrite is the safe side).
export function shapesMarked(entries, bodyOf = (i) => entries?.[i]?.body ?? null) {
  const L = entries ?? []; let founded = false;
  for (let i = 0; i < L.length; i++) { const e = L[i];
    if (!e || e.kind !== "act") continue;
    if (e.verb === "repair-shapes" && e.actor === "system") return true;
    // only the founding counts: the first create-world act. A later one is a refused attempt the log keeps, whose purge must
    // never read as "marked"
    if (e.verb === "create-world" && !founded) { founded = true; const b = bodyOf(i); if (b === null) return true; if (b && typeof b === "object" && Number.isInteger(b.shapes)) return true; }
    if (e.verb === "translated" && e.actor === "system") { const b = bodyOf(i); if (b === null) return true; const m = /@(\d+)$/.exec(String(b?.from?.translator ?? "")); if (m && +m[1] >= 12) return true; } }
  return false;
}

/** {old: new} per entity ("@world" or "thing"). A pure idempotent rename, so NOT marker-gated: `rename-components` renames
 *  what it finds; a value already under the new name wins. @world `trusted` lists components, not people. */
export const RENAMED_COMPONENTS = Object.freeze({ "@world": Object.freeze({ trusted: "trusted-components" }) });
/** grabbable.pose and station.pose → anim ('two-hand' → twoHanded: true), a grip's fingers → grasp. One function for the door
 *  (writes.js resolve) and the maintenance command; idempotent, and an old field stored as null is removed.
 *  → {value, renamed: [{field, from, to}]} */
export const RENAMED_FIELDS = Object.freeze({ grabbable: Object.freeze({ pose: "anim", "grips.*.fingers": "grasp" }), station: Object.freeze({ pose: "anim" }),
  // a VALUE renamed: a motion's old type bob is oscillate, on a whole motion and on every motion:<slot>
  motion: Object.freeze({ "type=bob": "type=oscillate" }) });
/** A part's motion (motion:<slot>) is a motion. */
export const renamedFieldsKey = (comp) => (typeof comp === "string" && comp.startsWith("motion:") ? "motion" : comp);
export function renameFields(comp0, v) {
  const comp = renamedFieldsKey(comp0);
  if (!bag(v) || !Object.hasOwn(RENAMED_FIELDS, comp)) return { value: v, renamed: [] };
  if (comp === "motion") { const t = motionType(v); return t === v.type ? { value: v, renamed: [] } : { value: { ...v, type: t }, renamed: [{ field: "type", from: v.type, to: t }] }; }
  let out = v; const renamed = []; const edit = () => (out === v ? (out = { ...v }) : out);
  if ("pose" in out) { edit(); const p = out.pose; delete out.pose;
    if (comp === "grabbable" && p === "two-hand") { if (out.twoHanded === undefined) out.twoHanded = true; renamed.push({ field: "pose", from: p, to: { twoHanded: out.twoHanded } }); }
    else if (p === null) renamed.push({ field: "pose", to: null });   // a stored null is a removal (anim is never null)
    else { if (out.anim === undefined) out.anim = p; renamed.push({ field: "pose", to: "anim" }); } }
  if (comp === "grabbable" && bag(out.grips) && Object.values(out.grips).some((g) => bag(g) && "fingers" in g)) { edit();
    out.grips = Object.fromEntries(Object.entries(out.grips).map(([k, g]) => { if (!bag(g) || !("fingers" in g)) return [k, g];
      const { fingers, ...r } = g; renamed.push({ field: `grips.${k}.fingers`, to: fingers === null ? null : "grasp" });
      return [k, { ...r, ...(r.grasp === undefined && fingers !== null ? { grasp: fingers } : {}) }]; })); }
  return { value: out, renamed };
}
/** [{verb, id, comp, value?}], [] when nothing needs it. */
export function renameOps(st, purged = null) {
  const ops = [];
  for (const [id, map] of Object.entries(RENAMED_COMPONENTS)) { const c = st?.entities?.[id]?.c; if (!bag(c)) continue;
    for (const [from, to] of Object.entries(map)) { if (!(from in c) || c[from] === purged) continue;
      ops.push({ verb: "delete", id, comp: from }); if (!(to in c)) ops.push({ verb: "set", id, comp: to, value: c[from] }); } }
  for (const id of Object.keys(st?.entities ?? {}).sort()) { const c = st.entities[id].c; if (!bag(c)) continue;
    for (const comp of Object.keys(c).filter((k) => Object.hasOwn(RENAMED_FIELDS, renamedFieldsKey(k))).sort()) { if (!bag(c[comp]) || c[comp] === purged) continue;
      const r = renameFields(comp, c[comp]); if (r.renamed.length) ops.push({ verb: "set", id, comp, value: r.value, renamed: r.renamed }); } }
  return ops;
}

/** Every thing and @world's look: [{verb: "set"|"delete", id, comp, value?}], in id order; [] when nothing needs it. */
export function shapeRepairOps(st, purged = null, { pathOf = null } = {}) {
  const ops = [];
  for (const id of Object.keys(st?.entities ?? {}).sort()) {
    // a purged value is no one's to rewrite: a thing whose repair would write one of them (move data into a purged sibling)
    // is left alone, since a half-move would lose the data
    const all = st.entities[id].c, gone = purged ? new Set(Object.keys(all).filter((k) => all[k] === purged)) : new Set();
    const c0 = gone.size ? Object.fromEntries(Object.entries(all).filter(([k]) => !gone.has(k))) : all;
    const { c, set, del } = id === "@world" ? repairWorld(c0) : repairComps(c0, { pathOf });
    if ([...set, ...del].some((k) => gone.has(k))) continue;
    for (const k of del) ops.push({ verb: "delete", id, comp: k });
    for (const k of set) ops.push({ verb: "set", id, comp: k, value: c[k] }); }
  return ops;
}
