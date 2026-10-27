// shared/protocol/view.js — the fold as the records the renderer, the panels and the agent's tools read. PROTOCOL.md §0:
// "the scene a client draws … is a view: derived, disposable, rebuildable from the log." A VIEW, not a protocol: no verbs,
// no second fold, nothing a reader can't rebuild from the fold. Pure; browser, server and agent run the same code.
//   viewOf(id, c)      one entity: its components, flat, in the protocol's own names — model, transform, sockets, label,
//                      light, … — plus the DERIVED conveniences every reader wants: pos / q / yaw (q's heading) / scale
//                      (one number) / scale3 (non-uniform, when it is) / parent {to, offset, q} (the local transform
//                      said as an offset). DERIVED names the derived set; recordComponents(rec) is the rest.
//   tf(c) / parentOf(c) / compOf(c)  the shared accessors of a fold record: its transform, its parent, its bag
//   viewState(folded) the whole world: {entities, sky, terrain, grass, assets, roles, bans, …}
//   - ids, roles and parent targets come back through names.dec (an imported world's x-- escapes undone);
//   - imported:<field> (a field an imported world's translation carried) → that field;
//   - @world: roles:<id> → roles, default-role → roles['*'], imported-bans:<id> → bans, assets:<k> → assets,
//     sky/terrain/grass → themselves, imported:<k> → st[k]. Not shown: physics-engine, about, bounds, spawn, imported-behavior:<k>.
// tools/protocol/vocab-check.ts keeps the old protocol's names out.
import { dec } from "./names.js";
import { qNorm, qHeading } from "../rot.js";

export const idOut = (id) => dec(id) ?? id;
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
const HIDDEN_WORLD = new Set(["physics-engine", "about", "bounds", "spawn"]);
const IMP = "imported:", IMP_BANS = "imported-bans:";
/** The record's derived fields (and its stamps): not components. The authority refuses a component named like one. */
export const DERIVED = new Set(["id", "pos", "q", "yaw", "scale", "scale3", "born", "kind", "actor", "ts", "placer"]);
/** The components on a record (its facts), without the derived fields. */
export const recordComponents = (rec) => { const out = {}; for (const k in rec ?? {}) if (!DERIVED.has(k)) out[k] = rec[k]; return out; };
export const emptyView = () => ({ entities: {}, terrain: null, grass: null, sky: null, water: null, assets: [], recentChat: [], chatTotal: 0, roles: {}, bans: {} });

/** {pos, q, yaw, scale (one number), scale3? ([x,y,z] when non-uniform)}. A missing or malformed part is its default
 *  (origin, no turn, unit scale), never undefined. */
export function tf(c) {
  const t = c?.transform ?? {};
  const pos = Array.isArray(t.pos) && t.pos.length === 3 ? t.pos.slice() : [0, 0, 0];
  const q = qNorm(t.q) ?? [0, 0, 0, 1];
  const s = Array.isArray(t.scale) && t.scale.length === 3 ? t.scale : [1, 1, 1];
  const uniform = s[0] === s[1] && s[1] === s[2];
  return { pos, q, yaw: qHeading(q), scale: uniform ? s[0] : s[1], ...(uniform ? {} : { scale3: s.slice() }) };
}
/** {to (names.dec'd)}, or null when it stands on its own (a legacy parent.socket is lifted at the door, never shown). */
export function parentOf(c) {
  const p = c?.parent;
  return p && typeof p.to === "string" ? { to: idOut(p.to) } : null;
}
/** Is this key of a fold record a component (not its model/transform/parent, not an imported:* field)? */
export const isCompKey = (k) => k !== "model" && k !== "transform" && k !== "parent" && !k.startsWith(IMP);
/** The record's component keys, as the fold spells them. */
export const compKeys = (c) => Object.keys(c ?? {}).filter(isCompKey);
/** …and its [key, value] pairs. */
export const compEntries = (c) => Object.entries(c ?? {}).filter(([k]) => isCompKey(k));
/** Every key but model/transform/parent/imported:*, keys names.dec'd, values cloned; undefined when empty. */
export function compOf(c) {
  let comp;
  for (const [k, v] of Object.entries(c ?? {})) {
    if (!isCompKey(k)) continue;
    (comp ??= {})[idOut(k)] = clone(v);
  }
  return comp;
}

/** A fold record reads as its view; a view record passes through. A view is told by ITS invariant (viewOf always writes
 *  `pos`), since a fold record may be {label} alone. Limit: a component named `pos` would be misread (the door refuses it). */
export const isFoldRecord = (x) => !!x && typeof x === "object" && !Array.isArray(x) && x.pos === undefined;
/** A fold record through viewOf; anything else (the OLD test shape, {pos, yaw, lib, comp}) as is. A TEST-CORPUS adapter for
 *  fixtures under tools/; nothing at runtime takes the old shape (tools/protocol/vocab-check.ts). */
export const recordOf = (x, id = "") => (isFoldRecord(x) ? viewOf(id, x) : x);

/** One entity's components as the record readers use. */
export function viewOf(id, c) {
  const rec = {};
  const t = tf(c);
  rec.pos = t.pos; rec.yaw = t.yaw; rec.q = t.q; rec.scale = t.scale;
  if (t.scale3) rec.scale3 = t.scale3;
  const p = parentOf(c);
  if (p) rec.parent = { ...p, offset: t.pos.slice(), q: t.q.slice() };
  for (const [k, v] of Object.entries(c)) {
    if (k === "transform" || k === "parent" || k.startsWith(IMP)) continue;
    rec[idOut(k)] = clone(v);
  }
  // imported:<name> shows under its name only where nothing else does: the active component, the derived pose fields and
  // the parent stay as they are
  for (const [k, v] of Object.entries(c)) if (k.startsWith(IMP)) { const n = idOut(k.slice(IMP.length)); if (!(n in rec) && !DERIVED.has(n) && n !== "parent") rec[n] = clone(v); }
  return rec;
}

/** chat: an optional recentChat window to carry (chat isn't in the fold). */
export function viewState(folded, { recentChat = [], chatTotal = 0 } = {}) {
  const st = emptyView();
  st.recentChat = clone(recentChat); st.chatTotal = chatTotal;
  for (const id of Object.keys(folded.entities ?? {})) {
    const c = folded.entities[id].c;
    if (id === "@world") {
      for (const [k, v] of Object.entries(c)) {
        if (HIDDEN_WORLD.has(k) || k.startsWith("imported-behavior:")) continue;
        if (k === "sky" || k === "terrain" || k === "grass" || k === "water") st[k] = clone(v);   // water: its own component
        else if (k === "default-role") st.roles["*"] = clone(v);
        else if (k.startsWith("roles:")) st.roles[idOut(k.slice(6))] = clone(v);
        else if (k.startsWith(IMP_BANS)) st.bans[idOut(k.slice(IMP_BANS.length))] = clone(v);
        else if (k.startsWith("assets:")) st.assets.push(v && typeof v === "object" && Object.keys(v).length ? clone(v) : idOut(k.slice("assets:".length)));
      }
      // imported:<name> fills only a slot nothing else holds (as viewOf): never the active sky, terrain, grass or water,
      // nor the view's own fields (entities, roles, bans, assets, chat)
      for (const [k, v] of Object.entries(c)) if (k.startsWith(IMP)) { const n = idOut(k.slice(IMP.length)); if (st[n] == null) st[n] = clone(v); }
      continue;
    }
    st.entities[idOut(id)] = { ...viewOf(id, c), born: folded.entities[id].born };
  }
  return st;
}
