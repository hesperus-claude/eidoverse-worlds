// shared/protocol/requests.js — the authority requests an edit plans: {verb, args}, one per change, or one `batch` for a
// gesture (= one act = one undo); every planner builds these and every sender sends them as they are. Ids and component
// names arrive as the VIEW shows them and are encoded here, once. A transform is always written whole ({pos, q, scale});
// for a child it is LOCAL to its parent (PROTOCOL §9.3). Pure; browser, server, agent.
import { socketsIn } from "../sockbody.js";
import { enc, encName } from "./names.js";
import { isPlaceholder } from "./ids.js";
import { qNorm, qFromYaw, qWithHeading } from "../rot.js";

const E = (id) => (id === "@world" || isPlaceholder(id) ? id : enc(String(id ?? "")));   // @world is itself, never escaped; a placeholder ('$lamp') is the authority's to mint
const finite3 = (a) => Array.isArray(a) && a.length === 3 && a.every(Number.isFinite);
const scale3 = (s) => (Number.isFinite(s) ? [s, s, s] : finite3(s) ? [...s] : null);

/** `merge: true` merges an object value into the current one. */
export const set = (id, component, value, { merge = false } = {}) =>
  ({ verb: "set", args: { id: E(id), component: encName(String(component)), value, ...(merge ? { merge: true } : {}) } });
/** remove one component. */
export const unset = (id, component) => ({ verb: "delete", args: { id: E(id), component: encName(String(component)) } });
/** its children go with it (the authority's rule). */
export const remove = (id) => ({ verb: "delete", args: { id: E(id) } });
/** a thing's reactions (a swing's push, a door's open). */
/** With no action the authority does the thing's one action or names what it offers (never 'use' by default). */
export const use = (id, action = null, args = null) => ({ verb: "use", args: { id: E(id), ...(action != null ? { action: String(action) } : {}), ...(args ? { args } : {}) } });
/** components: {name: value}; the transform is whole (missing parts default). The authority mints the id (writers never
 *  choose ids): pass null, or a placeholder ('$lamp') when the same batch refers to it or the reply's ids should map it. */
export function create(id, { model = null, transform = {}, components = {}, from = null } = {}) {
  // a transform among the components joins the transform argument, so it is still whole. Absent defaults; malformed is
  // passed on for the authority to refuse with its reason, never turned into a valid transform at the origin
  const bad = (v) => v != null && (typeof v !== "object" || Array.isArray(v));   // null/undefined: absent, so defaulted
  const comps = {}; let t = transform == null || bad(transform) ? {} : transform, raw = bad(transform) ? transform : undefined;
  for (const [k, v] of Object.entries(components)) { if (encName(k) === "transform") { if (bad(v)) raw = v; else if (v != null) t = { ...t, ...v }; } else comps[encName(k)] = v; }
  const field = (v, ok, dflt) => (v === undefined ? dflt : ok(v) ?? v);
  const whole = raw !== undefined ? raw : { pos: field(t.pos, (p) => (finite3(p) ? [...p] : undefined), [0, 0, 0]), q: field(t.q, qNorm, [0, 0, 0, 1]), scale: field(t.scale, scale3, [1, 1, 1]) };
  return { verb: "create", args: { ...(id == null ? {} : { id: E(id) }), ...(model ? { model } : {}), ...(from ? { from } : {}),
    components: { ...comps, transform: whole } } };
}

/** The whole transform after a pose edit, from the view (`ent`: {pos, q, yaw, scale, scale3}). `patch`: pos?, q? (wins),
 *  yaw? (a heading: keeps a tilted thing's tilt, turns it about up), scale? (number or [x,y,z]). */
export function transformOf(ent, patch = {}) {
  const q0 = qNorm(ent?.q) ?? qFromYaw(Number.isFinite(ent?.yaw) ? ent.yaw : 0);
  const q = qNorm(patch.q) ?? (Number.isFinite(patch.yaw) ? qWithHeading(q0, patch.yaw) : q0);
  return {
    pos: finite3(patch.pos) ? [...patch.pos] : finite3(ent?.pos) ? [...ent.pos] : [0, 0, 0],
    q,
    scale: scale3(patch.scale) ?? scale3(ent?.scale3) ?? scale3(ent?.scale) ?? [1, 1, 1],
  };
}
/** local to its parent if it has one */
export const setTransform = (ent, id, patch) => set(id, "transform", transformOf(ent, patch));

/** occupy `to`: parent + the local pose. `socket` names one of `to`'s socket children, occupied instead and, with no pose,
 *  landed on (as is a `to` that is a socket); else the carrier's origin. An unknown socket name goes as the old
 *  {to, socket}, which the door lifts or refuses. `world` is the view ({entities}). */
export function parent(world, id, to, { socket = null, pos = null, q = null, yaw = null } = {}) {
  const E0 = world?.entities ?? {};
  const ent = E0[id] ?? null;
  const kid = socket != null ? socketsIn(E0, to).find((x) => x.name === String(socket)) : null;
  if (kid) { to = kid.id; socket = null; }
  const local = {
    pos: finite3(pos) ? pos : [0, 0, 0],
    q: qNorm(q) ?? (Number.isFinite(yaw) ? qFromYaw(yaw) : [0, 0, 0, 1]),
  };
  const t = set(id, "transform", { ...local, scale: scale3(ent?.scale3) ?? scale3(ent?.scale) ?? [1, 1, 1] });
  if (socket == null && ent?.parent?.to === to) return t;
  return batch([set(id, "parent", { to: E(to), ...(socket != null ? { socket: String(socket) } : {}) }), t]);
}
/** vacate: drop the parent and stand at a world pose (the caller computes it: hierarchy.worldPose). */
export const unparent = (ent, id, worldPatch) => batch([unset(id, "parent"), set(id, "transform", transformOf({ ...ent, parent: null }, worldPatch))]);

/** a single op as itself, several as one batch (nested batches flattened) */
export function batch(ops) {
  const flat = ops.filter(Boolean).flatMap((o) => (o.verb === "batch" ? o.args.ops : [o]));
  if (!flat.length) return null;
  return flat.length === 1 ? flat[0] : { verb: "batch", args: { ops: flat } };
}
/** the (id, component) pairs a request sets: what a gesture's `expect` covers (ids as the authority has them) */
export function writesOf(req) {
  if (!req) return [];
  const ops = req.verb === "batch" ? req.args.ops : [req];
  return ops.filter((o) => o.verb === "set").map((o) => [o.args.id, o.args.component]);
}
