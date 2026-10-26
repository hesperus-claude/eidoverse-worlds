// shared/protocol/authority/rights.js — rights, and the views over the log that say who did what and who is sanctioned.
// A leaf over storage (isE, opsQuiet) and the ladder in roles.js.
import * as R from "../roles.js";
import { CTX } from "./ctx.js";
import { followUpsOf, isE, opsQuiet, readback } from "./storage.js";
// The ladder, permission list and effective set live in shared/protocol/roles.js (ranked membership only; banned is a state
// outside it). Every rank comparison goes through rankOf / whoRank, so a custom role stands where its rank says.
const RANK = R.RANK;
const wcOf = (st) => st.entities?.["@world"]?.c;
const ownersOf = (st) => { const c = st.entities?.["@world"]?.c ?? {}; return Object.keys(c).filter((k) => k.startsWith("roles:") && R.isOwner(c[k])); };
// §2.3: an empty owner list means NOBODY above inhabitant. `default-role` is the strangers' role (an imported
// `roles['*']`); absent means inhabitant (newer worlds write builder at founding). A guest never gets it unless
// `default-role.guests` opts guests in (never above it); an owner may still grant a guest a role by id.
function roleOf(st, actor, anon = CTX.isAnon(actor)) {
  const c = wcOf(st); if (!c) return "inhabitant";
  return R.roleIdOf(c, actor, { anon, owners: ownersOf(st).length > 0 });
}
/** A role the world doesn't define reads as inhabitant. */
const rankOf = (st, actor, anon) => R.rankOfRole(wcOf(st), roleOf(st, actor, anon));
/** The rank a `who` field names (physics.who, grabbable.who, a handler's or seat's who): a role the world doesn't define
 *  reads as owner, so a who never opens to more people than it said. */
const whoRank = (st, name) => R.roleDef(wcOf(st), name)?.rank ?? RANK.owner;
/** Absent: yes. A role id: that rank or above. {permission}: holds it (an owner holds every permission). {roles}: holds one
 *  of them, or is an owner. Anything else admits only owners. */
const admits = (st, actor, who, anon) => {
  if (who === undefined || who === null) return true;
  if (typeof who === "string") return rankOf(st, actor, anon) >= whoRank(st, who);
  const role = roleOf(st, actor, anon); if (R.isOwner(role)) return true;
  if (typeof who?.permission === "string") return effective(st, actor, anon)?.can?.[who.permission] === true;
  if (Array.isArray(who?.roles)) return who.roles.includes(role);
  return false;
};
/** Effective rights {role, name, rank, can, permissions} (roles.js effectiveOf). */
const effective = (st, actor, anon = CTX.isAnon(actor)) => R.effectiveOf(wcOf(st) ?? {}, actor, { anon, owners: ownersOf(st).length > 0 });
const may = (st, actor, sw) => roleOf(st, actor) === "owner" ? (sw !== "fly" || effective(st, actor).can.fly) : effective(st, actor).can[sw] === true;
/** Any power that acts on people (mute, kick, ban, pauseScripts)? Opens the moderation log. */
const modHolder = (st, who) => R.MOD_POWERS.some((k) => may(st, who, k));
export const effectiveIn = (st, actor, { anon = false } = {}) => R.effectiveOf(wcOf(st) ?? {}, actor, { anon, owners: ownersOf(st).length > 0 });
/** In a folded state (a view: what a client should be told it may do here). */
export const roleIn = (st, actor, { anon = false } = {}) => roleOf(st, actor, anon);
// ---------- views over the log: who did what (derived, never stored) ----------
const isScriptActor = (a) => typeof a === "string" && a.startsWith("script:");
// ---------- sanctions: views over the moderator log ----------
// Each record has an optional `until` (authority clock); expiry is computed, never written. Records name identities. No
// `until`: a permanent ban, no kick cooldown. Every in-force record since the last LIFT counts and the STRONGEST wins, so a
// weaker record never cancels a stronger one. Lifting goes through personLift.
const latestOf = (w, who, verbs) => { let r = null; for (const m of w.mod) if (m.who === who && verbs.includes(m.verb)) r = m; return r; };
const inForce = (w, m) => !!m && (m.until === undefined || m.until > w.now());
const sinceLift = (recs, verb, lifts) => { let out = []; for (const m of recs) { if (lifts.includes(m.verb)) out = []; else if (m.verb === verb) out.push(m); } return out; };
const strongest = (a) => a.reduce((x, m) => (!x ? m : x.until === undefined ? x : m.until === undefined || m.until > x.until ? m : x), null);
const recsOf = (w, who) => w.mod.filter((m) => m.who === who);
/** Every one in force on `who` now (a lift must be allowed over each). */
export function inForceOf(w, who, kind, recs = recsOf(w, who)) {
  const lifts = { ban: ["unban"], kick: ["unban"], mute: ["unmute"] }[kind];
  return sinceLift(recs, kind, lifts).filter((m) => inForce(w, m) && (kind !== "kick" || m.until !== undefined));
}
const banFrom = (w, who, recs) => strongest(inForceOf(w, who, "ban", recs));
const kickFrom = (w, who, recs) => strongest(inForceOf(w, who, "kick", recs));
const muteFrom = (w, who, channel, recs) => { const all = inForceOf(w, who, "mute", recs); if (!all.length) return null;
  const channels = [...new Set(all.flatMap((m) => m.channels ?? ["voice", "chat"]))];   // the union: a voice-only mute never narrows a both-channel one
  // asked about one channel, the record, its end and its reason are the mutes that cover it, never a voice-only one for chat
  // (a caller passing a channel reads only presence, until and reason; one reading channels passes none)
  const a = channel ? all.filter((m) => (m.channels ?? ["voice", "chat"]).includes(channel)) : all; if (!a.length) return null;
  const top = strongest(a); return { ...top, channels, until: a.some((m) => m.until === undefined) ? undefined : Math.max(...a.map((m) => m.until)) }; };
/** The strongest record, or null. */
export const banOf = (w, who) => banFrom(w, who, recsOf(w, who));
export const isBanned = (w, who) => !!banOf(w, who);
/** They can't rejoin until m.until, or null. An unban ends it early. */
export const kickOf = (w, who) => kickFrom(w, who, recsOf(w, who));
/** channels: the union of every mute in force, until: the latest; or null. `channel` narrows it. */
export const muteOf = (w, who, channel) => muteFrom(w, who, channel, recsOf(w, who));
/** Per identity (the Bans tab; the server's join and voice gates). One pass over the moderator log, so the sweep stays linear. */
export function sanctionsNow(w) {
  const by = new Map(); for (const m of w.mod) if (typeof m.who === "string") { let a = by.get(m.who); if (!a) by.set(m.who, (a = [])); a.push(m); }
  const out = {}; for (const [x, recs] of by) { const b = banFrom(w, x, recs), k = kickFrom(w, x, recs), m = muteFrom(w, x, undefined, recs);
    if (b || k || m) out[x] = { ...(b ? { ban: b } : {}), ...(k ? { kick: k } : {}), ...(m ? { mute: m } : {}) }; }
  return out;
}
// Who a change entry is "by": its cause's actor, and whose RIGHTS admitted it. Those differ for a `use`: the visitor pulled
// the lever, but the handler's author's rights made the change (capability.author). No cause act (rests, genesis-era): its own actor's.
function entryBy(w, e) {
  const c = w.entries[e.cause];
  const by = isE(c) && c.kind === "act" ? c.actor : e.actor;
  // a behaviour's results were admitted with its SPONSOR's rights. A purged cause act leaves the rights unknown:
  // null, matching nobody; never `by`, which would hand the lever-puller the author's thing
  if (isE(c) && c.kind === "act") { const b = readback(w, e.cause);
    if (b === null) return { seq: e.seq, by, rights: null };
    return { seq: e.seq, by, rights: b.capability?.author || (isScriptActor(c.actor) && b.sponsor) || by }; }
  return { seq: e.seq, by, rights: by };
}
// the change entries that may touch `id`, newest first: a live world keeps an id → seqs index; the suites scan all
function* backward(w, id) {
  if (w.touching) { const a = w.touching(id); for (let k = a.length - 1; k >= 0; k--) yield a[k]; return; }
  for (let i = w.entries.length - 1; i >= 0; i--) yield i;
}
// the creator of a thing (or component) in its CURRENT life: the entry that made it present after it was last absent.
// A follow-up set that put a value back (an undo's restore) also steps over the follow-up delete it reverses, so the
// restored value keeps its author and its life; any write of the asker's own in between ends that (a key re-created by
// someone else after a clear is a new life, never merged with the old one).
export function creatorOf(w, id, comp) {
  let found = null, restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    const ops = opsQuiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && fu.has(k)) { if (o.comp === comp) restored = true; continue; }   // the authority's follow-up (a reference cleared or put back) authors nothing
      if (o.verb === "delete" && fu.has(k) && restored && comp !== undefined && (o.comp === comp || o.comp === undefined)) { restored = false; continue; }
      if (o.verb === "set" && o.comp === comp) restored = false;
      if (comp === undefined) { if (o.verb === "create") return entryBy(w, e); if (o.verb === "delete" && o.comp === undefined) return null; continue; }
      if (o.verb === "set" && o.comp === comp) found = e;
      else if ((o.verb === "delete" && (o.comp === comp || o.comp === undefined)) || o.verb === "create") return found && entryBy(w, found); } }
  return found && entryBy(w, found);
}
// Who last set (or deleted) component `comp` on a thing: { seq, by, rights, deleted } or null if nobody ever has.
export function lastSetterOf(w, id, comp) {
  let restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue;
    const ops = opsQuiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id || o.comp !== comp || o.verb === "create") continue;
      if (fu.has(k)) { if (o.verb === "set") { restored = true; continue; } if (restored) { restored = false; continue; } }   // r9 H1, r10 M2
      return { ...entryBy(w, e), deleted: o.verb === "delete" }; } }
  return null;
}
/** The rank its setter holds NOW; a lock nobody set by hand (translated, or setter unknown) is builder-strength. */
export function lockStrength(w, st, id) { const by = lastSetterOf(w, id, "lock"); return by && !by.deleted && by.rights ? Math.max(R.RANK.builder, rankOf(st, by.rights)) : R.RANK.builder; }
// the view inspect shows (no stored `placer`)
const madeBy = (w, id) => creatorOf(w, id)?.by ?? null;

// request, undo and the hands' returns read it
const RESERVED = new Set(["system", "sim", "world"]); // the authority's own identities: a request can never be stamped as one

export { RANK, RESERVED, admits, backward, banFrom, effective, entryBy, inForce, isScriptActor, kickFrom, latestOf, madeBy, may, modHolder, muteFrom, ownersOf, rankOf, recsOf, roleOf, sinceLift, strongest, wcOf, whoRank };
