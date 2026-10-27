// v1/v2 → v4 translator. Runs the REAL v1 fold (../fold.js) one entry at a time, projects its state into v4
// entity/component form, and emits, per old entry:
//   - the old entry as sent: an `act` (verb "imported", body {verb, args, from: old seq}, ts: old ts), or a `say`, and
//   - at most one change entry with the plain results that bring v4 to the same place (cause = that act).
// The output is in the PROTOCOL-v4 §2.4 wire format, and every name and id follows §2.3: an old id or name the grammar
// refuses is mapped by `enc`, names.js's encRaw (deterministic and injective: a name in the hashed form is escaped like
// any other, and a log holding a lone surrogate, the one pair it maps alike, isn't imported at all). After every entry
// it folds the v4 entry with the v4 fold and checks the projections agree. The original log is never written (R9); the
// output is a regenerable cache. Hashing and hex come from ./hash.js (no node: imports: the browser may import this file);
// the CLI is tools/protocol/sweep.ts.
import { emptyState as v1Empty, foldEntry } from "./fold.js";
import { emptyState as v4Empty, applyInPlace, opsOf, worldIdOf, DIALECT, VERSION } from "../../../shared/protocol/fold.js";
import { unNegZero } from "../../../shared/protocol/round.js";
// an old log's names are never ids, so a name in the hashed form is escaped too (encRaw, @19)
import { encRaw as enc, encNameRaw as encName, dec, partSlot, motionType } from "../../../shared/protocol/names.js";
import { qNorm } from "../../../shared/rot.js";
import { sha256 } from "../../../shared/protocol/hash.js";
import { COMPONENTS, registered } from "../../../shared/protocol/componentspec.js";
import { modernize as newParticles, hashSeed } from "../../../shared/particle_effects.js";
import { repairComps, repairWorld, SHAPES_VERSION } from "../../../shared/protocol/shaperepair.js";
import * as eidosim from "./eidosim-v1.js";   // the first eidosim (dialect 3): what a v1 punt did. Importer-only.
import { ENGINES, DEFAULT_ENGINE } from "../../../shared/protocol/simlayer.js";

// the translator has its own name (it projects the engine's v1 fold); the fold build is stamped beside it.
// v1 {impulse: x} is v4's {kind: "impulse", angular: x}; a v1 key the closed v4 component lacks rides in imported:<component>
// v1 took a CSS hex colour where three.js does ("#fff"); v4's colours are 0xRRGGBB integers. Lossless.
export const hexColor = (x) => { if (typeof x !== "string") return x; const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(x.trim());
  if (!m) return x; const h = m[1].length === 3 ? [...m[1]].map((d) => d + d).join("") : m[1]; return parseInt(h, 16); };
function splitUnknown(c) {
  if (c.light && typeof c.light === "object" && "color" in c.light) c.light = { ...c.light, color: hexColor(c.light.color) };
  if (c.light && typeof c.light === "object" && !Array.isArray(c.light) && "keep" in c.light) { const { keep, ...l } = c.light; c.light = { ...l, important: keep }; } // @7: v1's keep is light.important
  for (const [k, v] of Object.entries(c)) {
    const name = k.split(":")[0], def = COMPONENTS[name];
    if (!def?.fields || name === "imported" || !v || typeof v !== "object" || Array.isArray(v)) continue;
    const extra = Object.keys(v).filter((f) => !(f in def.fields));
    if (!extra.length) continue;
    const lk = keyed("imported", dec(k));
    if (lk in c) continue;   // a v1 top-level field of the same name already holds that slot: leave the component whole
    const keep = { ...v }, left = {};
    for (const f of extra) { left[f] = v[f]; delete keep[f]; }
    c[k] = keep; c[lk] = left;
  }
}
// every v1 socket was a seat: {pos, yaw?, pose?, part?} → {pos, q?, part?, body: {pose?}} (a person attaches by
// using it). A v1 socket key v4 doesn't define rides in imported:sockets {<slot>: {key: value}}.
function newSockets(S, c) {
  if (!S || typeof S !== "object" || Array.isArray(S)) return S;
  const out = {}, left = {};
  for (const [slot, s] of Object.entries(S)) {
    if (!s || typeof s !== "object" || Array.isArray(s)) { out[slot] = s; continue; }
    const { pos, yaw: yaw0, part, pose, ...rest } = s;
    // v1's renderer turned the seat by `yaw ?? 0` through three.js, which coerces ("1.5" turns it); what can't turn is carried
    const yaw = yaw0 == null ? 0 : Number(yaw0);
    if (!Number.isFinite(yaw)) rest.yaw = yaw0;
    out[slot] = { ...(pos !== undefined ? { pos } : {}), ...(Number.isFinite(yaw) && yaw !== 0 ? { q: yawQ(yaw) } : {}), ...(part !== undefined ? { part } : {}), body: pose !== undefined ? { pose } : {} };
    if (Object.keys(rest).length) left[slot] = rest;
  }
  if (Object.keys(left).length) c[keyed("imported", "sockets")] = left;
  return out;
}
// v1's captions bag held the session's newest lines (`window`) and the playhead (`mediaTime`); v4's holds the current line
// once (componentspec captions). The earlier lines are the log's own caption acts, so the window is derived, not carried.
function newCaptions(v) {
  if (!v || typeof v !== "object" || Array.isArray(v) || !Array.isArray(v.window) || !v.window.length) return v;
  const { window, mediaTime: _m, ...rest } = v;
  return { ...rest, line: window[window.length - 1] };
}
function newStory(v) {
  const out = { ...v };
  if (typeof v.practice === "string" && v.practice.trim()) out.text = (typeof v.text === "string" && v.text ? `${v.text}\n\n` : "") + v.practice.trim();
  if (typeof v.markedEntity === "string" && v.markedEntity) out.marks = [enc(v.markedEntity)];
  return out; // practice, markedEntity and anything else story doesn't define move to imported:story (splitUnknown)
}
// v1's spin took rpm or degPerSec; v4's is degPerSec (rpm × 6, lossless: the renderer read rpm × 6); degPerSec wins
// when both were written, as the renderer had it.
// @14: v1's back-and-forth along an axis is written under today's name, oscillate (motionType: its one reading).
function newMotion(m0) {
  if (!m0 || typeof m0 !== "object" || Array.isArray(m0)) return m0;
  const m = motionType(m0) === m0.type ? m0 : { ...m0, type: motionType(m0) };
  if (!("rpm" in m)) return m;
  const { rpm, ...rest } = m;
  if (rest.degPerSec !== undefined) return rest;
  // the renderer's own reading, (rpm ?? 6) * 6 with JS coercion: a numeric string spun; a rate that isn't a number stays
  // in the motion, so splitUnknown carries it in imported:motion (R10)
  const rate = (rpm ?? 6) * 6;
  return Number.isFinite(rate) ? { ...rest, degPerSec: rate } : m;
}
// what the shape repair (shared/protocol/shaperepair.js) fixes in a stored v4 world, the translation writes already:
// motion:<part>, amp, axis vectors, a pendulum's 3.5 s / 0 defaults and [0, 2, 0] pivot, collider exact as mesh; no parent order
function shapeRepaired(c) {
  return repairComps(c).c;   // a node's motion is motion:<partSlot(name)> {node: name}: its key is already in the §2.3 grammar
}
function newReactions(rx) {
  if (!rx || typeof rx !== "object") return rx;
  const out = {};
  for (const [k, h] of Object.entries(rx)) {
    if (h && typeof h === "object" && h.kind == null && typeof h.impulse === "number") {
      const { impulse, ...rest } = h;
      out[k] = { ...rest, kind: "impulse", angular: impulse };
    } else if (h && typeof h === "object" && h.component === "door") out[k] = { ...h, component: "openable" };
    else out[k] = h;
  }
  return out;
}

export const TRANSLATOR = "eidoverse/translate-v1@20";
/** The version number in a translator name ("eidoverse/translate-v1@20" → 20), or NaN. Compare numbers, never a regex
 *  of version digits. */
export const translatorVersion = (name) => { const m = /@(\d+)$/.exec(String(name ?? "")); return m ? Number(m[1]) : NaN; };
// the name says which output you got: bump BOTH names (TRANSLATOR, TRANSLATOR_SIM) on any change to the output; two
// translators never share a name. Live rules sit beside the code that applies them (withoutAccounts, isAccount, noAcct);
// what each version changed: README.md#translator-versions
export const TRANSLATOR_SIM = "eidoverse/translate-v1@20";
export const LAB_DOOR_KEY = "ed25519:rRoIPhqlc8rDxC1GZlfHOe1IBJYWQ8MDNg9QuZzMsic"; // the conformance suite's fixed sequencer key
const b64url = (bytes) => { let s = ""; for (const x of bytes) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
// a real authority passes the operator's governance key (tier 1, never the sequencer's) and a random nonce; pure tests get a
// source-derived nonce and one fixed key. Tier 0 stays EMPTY: v1 logs record accounts, never keys, so a translation names no
// founder (README.md, "The Commons and governance keys"). The governance draft (§13) must allow one attested fill of it
// later.
export function translatedGenesis(oldEntries, { key = LAB_DOOR_KEY, operator = key, nonce } = {}) {
  if (!nonce) { const h = sha256(oldEntries.map((e) => JSON.stringify(e)).join("\n")); nonce = b64url(Uint8Array.from(h.slice(0, 32).match(/../g), (x) => parseInt(x, 16))); }
  return { dialect: DIALECT, v: VERSION, minor: 0, nonce, owners: [[], [operator]], sequencer: key };
}
export { enc, encName, dec };
const yawQ = (y) => [0, Math.sin(y / 2), 0, Math.cos(y / 2)];
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// §2.3 grammar for old names: names.js (one encoding, shared with the live authority).
const keyed = (prefix, k) => `${prefix}:${enc(k)}`;

// The projection: what the old fold's state MEANS, in v4 terms. Every deliberate difference is named in DROPPED.
const ENTITY_SKIP = new Set(["actor", "ts", "born"]); // provenance lives in the entry envelope in v4; born is per-log
export const DROPPED = {
  "entity.actor / entity.ts": "last writer and time: in v4 these are the entry envelope's actor and the act's at, not state",
  "entity.born": "incarnation seq: re-derived from the v4 log (the translated create's seq)",
  "mounts": "bodies sitting: presence in v4, never history (00:50 ruling 1); their old entries survive as acts",
  "recentChat / chatTotal": "the chat window: a reader of `say` entries does this in v4, not world state",
  "placer": "who placed it: a view over the log in v4 (L2: no stored derived values); the old value survives in the old entry",
  "roles.<person> spectator / none": "there is no rung below inhabitant (@17, R 10-21): the grant is carried as @world imported-roles:<id> as it was, and the person holds the world's newcomer role; v1's visitor is written inhabitant",
  "roles['*']": "becomes @world `default-role` (the declared role for anyone not named); '*' is not an identity (§2.3); a `*` of none / spectator (upstream world access) becomes @world `access` {join: listed (, watch: anyone)}",
  "comp.guard": "merged into `lock` (PROTOCOL-v4 §5, R 19:58): a truthy guard becomes lock {rank: 'builder'} (@12; was true), which binds everyone (the placer too) and any builder may lift; the guard's authorship protection is dropped by design. stats.guards counts the things this happened to, so the world's owners can be told",
  "roles.<person>.caption": "a v1 caption deed (to caption one thing while it is the incarnation the deed was granted for) becomes the person's place in that thing's captioners {ids}; a deed on a timed grant, or for a thing replaced or gone, stays carried in imported:roles:<id> (captioners has no end)",
  "captions.window / captions.mediaTime": "v1's bag kept the session's newest lines and the playhead; v4's captions holds the current line (the window's last). The earlier lines are the log's own caption acts",
  "comp.door": "renamed `openable` (R 10-07), and a reaction's component 'door' with it: the same value under v4's name (@5)",
  "roles.sub / bans.sub": "an account subject is person data (PROTOCOL §9.2): never written into a value (@12). With an identity mapper it is how the person's id is found (the key); without one it is dropped. A ban's `by`, who banned, stays as v1 kept it, unless it is itself an account: then it is that person's id (@19), or dropped without a mapper",
  "behaviors.authorSub, and any other account in a value": "the binding's author's account (the v1 server's bySub), and any account-shaped sub or *Sub a value carries: never written into a value (@16). With an identity mapper the binding's is how its author's id is found; without one it is dropped. A sub or *Sub that isn't account-shaped is ordinary data and stays, except a grant's or a ban's own top-level sub, the server's stamp of the person's account (roles.sub / bans.sub)",
  "an entry keyed by an account in a value, and a component an account names and fills": "an entry keyed by an account in a value, or a component whose name has an account's (`ownerSub`) and whose whole value is one, is person data (PROTOCOL §9.2): in the state it is dropped with what it held (@19); in a copied request (the translated act's genesis, an old request) an entry keyed by one is keyed by its person's id, and a comp request's data becomes it, each dropped without an identity mapper. A role or ban kept by its account isn't a value: it is kept, keyed by its person's id (with a mapper) or by its account, encoded (without one)",
  "comp['particles:<name>']": "a thing's second (third, …) emitter (upstream #256) becomes a child thing carrying it: parent {to: the thing}, label <name>, its own `particles`, its seed the one v1 drew it with (@15). v4 keeps one particles per thing",
  "particles.wobble / up / spread / gravity / grow / swirl / twinkle / converge / rotate / color / blending": "upstream #256's preset overrides (the old builder's table): carried in imported:particles, not drawn; v4 says that look in an effect document's modules (velocity, forces.gravity, size.curve, color, render.blend, drift, swirl, converge, flicker, rotation). `scale` is the instance's own scale",
  "motion.rpm": "becomes degPerSec = rpm × 6 (@5): the rate the renderer drew, under the authority's one name for it",
  "motion.type": "the back-and-forth along an axis is written oscillate (@14, R 10-17 21:40; shared/protocol/names.js OLD_MOTION_TYPES holds the old word): the same motion under today's name",
  "motion.part": "a bare motion naming a part becomes motion:<slot> {node: <the part's name>} (@12; the slot is shared/protocol/names.js partSlot of the name: the name itself when it is a §2.3 tag, else a sanitized form with 8 hex of its sha256): when the thing already has a motion on that node, that one wins and the bare one is dropped (the renderer drew both on one node, the keyed one last). A keyed motion carries node (its key's tag, the old reading)",
  "a mounted thing's own pos/yaw/q": "v1 keeps a riding thing's pre-mount pose, unused until a dismount; v4's transform IS the pose it rides at (local to its parent: v1's offset, or its socket's pos, and q/yaw). The parent's offset/yaw/q are that transform, not a second copy (L2)",
};
// v1 features v4 doesn't carry yet (tools/water/README.md): a log using one is REFUSED at `translate`, naming each use
// (deferredFeatures). `water` on @world is v4's world water level; elsewhere, or shaped as a volume, it's deferred
export const DEFERRED = {
  water:     { feature: "water volume", since: "main #248 (Unreal native client) / #254", shape: "water {center, size, absorption?, scatter?, speed?, waves?} on an entity" },
  air:       { feature: "air box (dry interior)", since: "main #248", shape: "air {boxes: [{center, size, q?}]}" },
  traversal: { feature: "climb route", since: "main #248", shape: "traversal {routes: [{name, path, radius, speed}]}" },
  vehicle:   { feature: "vehicle", since: "main #248", shape: "vehicle {helm, exit, speed, turnRate, minY?, maxY?, probes}" },
  collision: { feature: "collision on/off toggle", since: "main #248", shape: "collision {enabled: false}" },
};
const VOLUME_FIELDS = ["center", "size", "absorption", "scatter", "waves"];
/** Every use in a v1 log of a feature v4 doesn't carry yet that still stands at its end: [{component, feature, id, seq,
 *  actor, ts}], in log order. A `comp` that removes one (data null), or a `remove` of its thing, ends the uses before it,
 *  so removing it on the old server (the refusal's remedy) clears the refusal. */
export function deferredFeatures(oldEntries) {
  const standing = new Map();   // `${id}\0${type}` → the uses since it was last removed
  oldEntries.forEach((e, k) => {
    if (e?.verb === "remove" && e.args?.id != null) { const pre = `${String(e.args.id)}\0`; for (const key of [...standing.keys()]) if (key.startsWith(pre)) standing.delete(key); return; }
    if (e?.verb !== "comp" || typeof e.args?.type !== "string") return;
    const t = e.args.type, d = e.args.data;
    if (!Object.hasOwn(DEFERRED, t)) return;
    const key = `${String(e.args.id)}\0${t}`;
    if (d == null) { standing.delete(key); return; }
    if (t === "water" && e.args.id === "@world" && !(d && typeof d === "object" && VOLUME_FIELDS.some((f) => f in d))) { standing.delete(key); return; }   // the world's water level: carried
    const uses = standing.get(key) ?? []; standing.set(key, uses);
    uses.push({ component: t, feature: DEFERRED[t].feature, id: String(e.args.id), seq: Number.isInteger(e.seq) ? e.seq : k, actor: String(e.actor ?? "?"), ...(Number.isInteger(e.ts) ? { ts: e.ts } : {}), at: k });
  });
  return [...standing.values()].flat().sort((x, y) => x.at - y.at).map(({ at: _a, ...u }) => u);
}
/** The refusal, in words: which feature, on what, by whom, when (seq). One line per use; null when nothing is deferred. */
export function deferredRefusal(uses, world = "this world") {
  if (!uses.length) return null;
  const kinds = [...new Set(uses.map((u) => u.feature))];
  return `can't translate ${world}: it uses ${uses.length} thing(s) this protocol does not carry yet — ${kinds.join(", ")} — and translating would drop them silently. `
    + `Nothing was written. Where:\n` + uses.map((u) => `  seq ${u.seq}: ${u.feature} (\`${u.component}\` component) on "${u.id}", set by ${u.actor}${u.ts ? ` at ${new Date(u.ts).toISOString()}` : ""}`).join("\n")
    + `\nThese came from main's merges (${[...new Set(uses.map((u) => DEFERRED[u.component].since))].join("; ")}) and are deferred in this protocol. Either wait for the protocol to carry them, or remove them from the old world first (the old server's \`comp\` with data null) and translate again.`;
}

// v1's mount as the renderer realizes it (shared/hierarchy.js localOf, written independently): at parent.offset, else the
// socket's pos, else the carrier's origin; turned by parent.q, else parent.yaw, else the socket's yaw. With the carrier
// gone it stays where its own pose puts it (as worldT reads a parent that names nothing)
const fin = (n) => { n = Number(n); return Number.isFinite(n) ? n : 0; };
function rideOf(st, e) {
  const rel = e.parent; if (!rel || typeof rel !== "object" || typeof rel.to !== "string" || !Object.hasOwn(st.entities ?? {}, rel.to)) return null;
  const socks = st.entities[rel.to]?.comp?.sockets; const s0 = rel.slot && socks && typeof socks === "object" && Object.hasOwn(socks, rel.slot) ? socks[rel.slot] : null;
  const sock = s0 && typeof s0 === "object" ? s0 : null;
  const pos = (Array.isArray(rel.offset) ? rel.offset : Array.isArray(sock?.pos) ? sock.pos : [0, 0, 0]).map(fin);
  const q = qNorm(rel.q) ?? yawQ(fin(rel.yaw ?? sock?.yaw ?? 0));
  return { pos, q };
}
const PARENT_POSE = new Set(["offset", "yaw", "q"]);
// who(name, {sub}) → a v1 person's v4 identity (the directory's mapping); without one, names are escaped. `sub` never stays in a value
// v1's own system actors (the v1 server wrote "door"); in v4 the authority's own acts are actor `system`
const SYSTEM = new Set(["door", "world", "sim"]);
// an account subject: a property named `sub` or ending in `Sub` whose string has an account's shape. The shape, not the name
// alone: v1's `comp` folded any data, so `sub` can be a sign's subtitle. A name joins an account only where v1's server wrote
// the pair (a grant's or ban's sub, a placer {id, sub}, a binding's bySub: noAcct), never from a value
export const isAccount = (s) => typeof s === "string" && /^(human|agent|aid1|local):/.test(s);
/** A NAME that is an account (a role or a ban keyed by it, an actor that is one): every shape but local:, which a private
 *  server gives a bare name in a sub position only, so a person may well be called `local:ann` and isn't an account. */
export const isAccountName = (s) => typeof s === "string" && /^(human|agent|aid1):/.test(s);
const ACCOUNT_KEY = /^sub$|Sub$/;
/** Whether a component's name has an account's, read as written under its namespace and its escape (`imported/x--…`):
 *  the one reading the scrub and the writer's check share. */
const accountNamed = (n) => typeof n === "string" && ACCOUNT_KEY.test(dec(n.slice(n.lastIndexOf("/") + 1)) ?? n);
/** `v` with every account subject in it, at any depth, replaced by what `map(sub)` gives, or dropped where that's undefined
 *  (the default). The same object when nothing in it is an account (the projection's values can be the old fold's own). */
export function withoutAccounts(v, map = () => undefined) {
  if (Array.isArray(v)) { let out = null; v.forEach((x, i) => { const y = withoutAccounts(x, map); if (y !== x) (out ??= v.slice())[i] = y; }); return out ?? v; }
  if (!v || typeof v !== "object") return v;
  let out = null;
  for (const [k, x] of Object.entries(v)) {
    if (ACCOUNT_KEY.test(k) && isAccount(x)) {
      out ??= { ...v }; const to = map(x);
      if (to === undefined) delete out[k]; else out[k] = to; continue; }
    // a map keyed by an account (a genesis role, a ban, as v1 could key them): the entry under its person's id, or dropped
    if (isAccountName(k)) { out ??= { ...v }; delete out[k]; const to = map(k); if (to !== undefined && !Object.hasOwn(out, to)) out[to] = withoutAccounts(x, map); continue; }
    const y = withoutAccounts(x, map); if (y !== x) (out ??= { ...v })[k] = y;
  }
  return out ?? v;
}
/** The first account subject a log still carries, as {seq, path}, or null: the writer's check (world.ts
 *  translateV1World). It reads what the scrub reads (properties, keys, a person's id, an imported ban's `by`, a component
 *  so named); elsewhere an `id`, like any other key, holds data. */
export function accountIn(entries) {
  const named = (v) => [["comp", "value"], ["component", "value"], ["type", "data"]].find(([n, x]) => accountNamed(v[n]) && isAccount(v[x]));
  // an id is an account where it names a person, as the scrub (noAcct) maps one; and an imported ban's `by` (project's unby)
  const banBy = (v) => { const c = v.comp ?? v.component; return typeof c === "string" && c.startsWith("imported-bans:") && v.value && typeof v.value === "object" && isAccountName(v.value.by); };
  const person = (v) => (banBy(v) ? "value.by" : !v.args || typeof v.args !== "object" ? null : PERSON_REQUESTS.has(v.verb) && isAccountName(v.args.id) ? "args.id"
    : (v.verb === "spawn" || v.verb === "light") && v.args.placer && typeof v.args.placer === "object" && isAccountName(v.args.placer.id) ? "args.placer.id" : null);
  const find = (v, path) => {
    if (Array.isArray(v)) { for (let i = 0; i < v.length; i++) { const f = find(v[i], `${path}[${i}]`); if (f) return f; } return null; }
    if (!v || typeof v !== "object") return null;
    const n = named(v); if (n) return path ? `${path}.${n[1]}` : n[1];
    const pn = person(v); if (pn) return path ? `${path}.${pn}` : pn;
    for (const [k, x] of Object.entries(v)) { const p = path ? `${path}.${k}` : k;
      if ((ACCOUNT_KEY.test(k) && isAccount(x)) || isAccountName(k)) return p; const f = find(x, p); if (f) return f; }
    return null; };
  for (const [i, e] of entries.entries()) { const p = find(e, ""); if (p) return { seq: Number.isInteger(e?.seq) ? e.seq : i, path: p }; }
  return null;
}
/** a v1 actor name → the v4 actor, by grammar only (no directory): v1's "door" is v4's `system`, anything else enc() */
export const actorOf = (a) => (a === "door" ? "system" : enc(a));
const asSub = (k) => (isAccountName(k) ? k : undefined);   // a role or ban keyed by its account (@19)
const PERSON_REQUESTS = new Set(["grant", "ban", "unban"]);   // the old requests whose id names a person
// bare names are the registry's: a v1 world's own inventions come across as `<namespace>/heart` (the world's name, else
// "imported"), so the registry can promote a word later without rereading this world's values in a new meaning
export const NAMESPACE = "imported";
/** A world's name as a §3.1 namespace (lowercase letters, digits, '-', '.'), or the default. */
export const namespaceOf = (name) => { const s = String(name ?? "").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^[-.]+|[-.]+$/g, "").replace(/\.{2,}/g, "."); return /^[a-z0-9]/.test(s) ? s.slice(0, 63).replace(/[-.]+$/, "") : NAMESPACE; };
function namespaceUnknown(c, ns) {
  for (const k of Object.keys(c)) { const base = k.split(":")[0];
    if (base.includes("/") || registered(base)) continue;
    const to = `${ns}/${k}`; if (to in c) continue;   // never overwrite (a world that already used both spellings keeps the bare one)
    c[to] = c[k]; delete c[k]; }
}
// a model is its LIBRARY PATH as v1 wrote it (it loads anywhere the library exists); model-hash sha256:<64 hex> rides beside
// it when the caller's content(path) knows the bytes, and a path it can't hash is listed
const hashOf = (a) => { if (typeof a !== "string") return null; const m = /^(?:sha256:|eido:sha256\/)([0-9a-f]{64})$/.exec(a); return m ? `sha256:${m[1]}` : null; };
// upstream #256's emitter name, and the id of the child thing a named emitter becomes (@15): readable (its name first), the
// same from every translation of the same world, never a person's id
const EMITTER_NAME = /^[A-Za-z0-9_-]{1,32}$/;
export const emitterChildId = (host, name) => `${name.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 20).replace(/-+$/, "") || "emitter"}-${sha256(`eido-emitter\0${host}\0${name}`).slice(0, 26)}`;
export function project(st, seen = null, who = null, ns = NAMESPACE, content = null) {
  const out = {};
  // a key the v1 fold lowercased (a ban's) isn't an account as written: who() restores its case first, then reads it
  const person = (k, v, lowered = false) => (who && !SYSTEM.has(k) ? who(k, { sub: (v && typeof v === "object" && typeof v.sub === "string" ? v.sub : undefined) ?? (lowered ? undefined : asSub(k)), ...(lowered ? { lowered } : {}) }) : enc(k));
  const unsub = (v) => { if (!v || typeof v !== "object" || Array.isArray(v) || !("sub" in v)) return v; const { sub, ...rest } = v; return rest; };   // @12: always
  for (const [id, e] of Object.entries(st.entities ?? {})) {
    const c = {};
    const t = { pos: e.pos ?? [0, 0, 0], q: Array.isArray(e.q) ? e.q : yawQ(e.yaw ?? 0), scale: typeof e.scale === "number" ? [e.scale, e.scale, e.scale] : (e.scale ?? [1, 1, 1]) };
    const ride = rideOf(st, e); if (ride) { t.pos = ride.pos; t.q = ride.q; }
    c.transform = t;
    if (e.lib !== undefined) { c.model = e.lib; const h = content && typeof e.lib === "string" ? hashOf(content(e.lib)) : null; if (h) c["model-hash"] = h; }
    if (e.kind === "light") c.light = Object.fromEntries(["color", "intensity", "range", "keep", "day"].filter((k) => e[k] !== undefined).map((k) => [k, e[k]]));
    const emitters = [];   // v1 particles:<name> (upstream #256): each becomes a child thing (@15)
    for (const [k, v] of Object.entries(e.comp ?? {})) if (k !== "guard") {
      if (accountNamed(k) && isAccount(v)) continue;   // a component whose name has an account's, holding one (@19)
      if (k.startsWith("particles:") && EMITTER_NAME.test(k.slice(10))) { if (v != null) emitters.push([k.slice(10), v]); continue; }
      // a node's motion (v1 motion:<node name>): the name is data, motion:<partSlot(name)> {node: name} (@12)
      if (k.startsWith("motion:") && v && typeof v === "object" && !Array.isArray(v)) { const node = k.slice(7); c[`motion:${partSlot(node)}`] = { ...newMotion(v), node: typeof v.node === "string" && v.node ? v.node : node }; continue; }
      c[encName(k === "door" && !e.comp.openable ? "openable" : k)] = k === "reactions" ? newReactions(v) : k === "sockets" ? newSockets(v, c) : k === "motion" ? newMotion(v) : k === "particles" ? newParticles(v) : k === "captions" ? newCaptions(v) : v; }
    if (e.comp?.guard && !e.comp.lock) { c.lock = true; seen?.guards.add(id); } // §5: guard merges into lock
    if (c.lock === true) c.lock = { rank: "builder" };   // @12: the one spelling (a v1 lock and a guard were builder-level)
    if (c.story && typeof c.story === "object" && !Array.isArray(c.story)) c.story = newStory(c.story); // @5: a marker's words, in story's shape
    if (e.parent) c.parent = typeof e.parent.to === "string"
      ? { to: enc(e.parent.to), ...Object.fromEntries(Object.entries(e.parent).filter(([k]) => k !== "to" && !PARENT_POSE.has(k)).map(([k, v]) => [k === "slot" ? "socket" : k, v])) }   // v1's slot is v4's socket (@7)
      : e.parent; // not a v1 mount (the v1 fold writes `to` as a string): carried as it is
    for (const [k, v] of Object.entries(e)) {
      if (["pos", "yaw", "q", "scale", "lib", "kind", "color", "intensity", "range", "keep", "day", "comp", "parent", "placer"].includes(k) || ENTITY_SKIP.has(k)) continue;
      c[keyed("imported", k)] = v; // anything the mapping doesn't know is carried, never dropped (R10)
    }
    out[enc(id)] = shapeRepaired(c);
    for (const [name, v] of emitters) {
      const seeded = v && typeof v === "object" && !Array.isArray(v) && !Number.isFinite(v.seed) ? { ...v, seed: hashSeed(`${id}:particles:${name}:${v.preset ?? ""}`) } : v;
      out[emitterChildId(enc(id), name)] = shapeRepaired({ transform: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, parent: { to: enc(id) }, label: name, particles: newParticles(seeded) });
    }
  }
  const w = {};
  for (const k of ["sky", "terrain", "grass"]) if (st[k] != null) w[k] = st[k];
  // v1 dialect 3's physics epoch is carried like any field the mapping doesn't know: imported:epoch (@12; was imported-epoch)
  // v1 echoed into the sky value who set it (`by`, a display name) and at which seq: derived, and a person's name inside
  // a value. Dropped; the log says who set the sky (History, inspect's touched).
  if (w.sky && typeof w.sky === "object") { const { seq, by, ...sky } = w.sky;
    if (sky.forecast && typeof sky.forecast === "object") { const { seq: _s, by: _b, ...fc } = sky.forecast; sky.forecast = fc; }
    w.sky = sky; }
  for (const a of st.assets ?? []) w[keyed("assets", typeof a === "string" ? a : a.path ?? JSON.stringify(a))] = typeof a === "string" ? {} : a;
  // v1's `fly` and `gen` grants are the fly and generate switches, can.fly / can.generate (@7); a `caption` deed is a place
  // in its screen's captioners (below)
  const toCan = (v) => { if (!v || typeof v !== "object" || !("fly" in v || "gen" in v)) return v; const { fly, gen, ...rest } = v;
    const can = { ...(rest.can ?? {}), ...(fly === true ? { fly: true } : {}), ...(gen === true ? { generate: true } : {}) };
    return Object.keys(can).length ? { ...rest, can } : rest; };
  // `*` none = members only, `*` spectator = watch only: entry is @world.access (shared/protocol/access.js); a person's own
  // none / spectator lists no one. A timed grant keeps its `until` (the load's sweep ends one already past)
  const DOOR_OF = { none: { join: "listed" }, spectator: { join: "listed", watch: "anyone" } };
  for (const [k, v] of Object.entries(st.roles ?? {})) {
    if (k === "*") { if (DOOR_OF[v?.role]) { w.access = { ...DOOR_OF[v.role] }; const { role: _r, until: _u, ...rest } = toCan(v); if (Object.keys(rest).length) w["default-role"] = { role: "inhabitant", ...rest }; } else { const { until: _u, ...dr } = toCan(v) ?? {}; w["default-role"] = dr.role === "visitor" ? { ...dr, role: "inhabitant" } : dr; } }
    else { let r = toCan(unsub(v)); const id = person(k, v);
      // a caption deed (v1: to caption one thing, while it is the incarnation the deed was granted for) is a place in that
      // screen's captioners; a timed one stays carried, since captioners has no end
      const deed = r && typeof r === "object" ? r.caption : null, host = deed && typeof deed === "object" && typeof deed.id === "string" && Object.hasOwn(st.entities ?? {}, deed.id) ? st.entities[deed.id] : null;
      const screen = host && (deed.born == null || host.born === deed.born) && r.until == null ? out[enc(deed.id)] : null;
      if (screen && (screen.captioners === undefined || Array.isArray(screen.captioners?.ids))) {
        const ids = screen.captioners?.ids ?? []; screen.captioners = { ids: ids.includes(id) ? ids : [...ids, id] };
        const { caption: _c, ...rest } = r; r = rest; }
      if (r && (r.role === "spectator" || r.role === "none")) w[`imported-roles:${id}`] = r;   // no rung below inhabitant (@17): carried, not granted
      else w[`roles:${id}`] = r && r.role === "visitor" ? { ...r, role: "inhabitant" } : r; }
  }
  // the v1 fold lowercased a ban's key. Its `by` is who banned, the act's actor as v1 kept it: a name stays as it was, and
  // one that is itself an account is that person's id, as their acts' actor is (dropped without a mapper)
  const unby = (v) => (!v || typeof v !== "object" || Array.isArray(v) || !isAccountName(v.by) ? v
    : who ? { ...v, by: who(v.by, {}) } : (({ by: _b, ...rest }) => rest)(v));
  for (const [k, v] of Object.entries(st.bans ?? {})) w[`imported-bans:${person(k, v, true)}`] = unby(unsub(v));
  // a binding's author is their identity, found through the account v1 stamped on it (authorSub), never through `by`,
  // which a request could set to anyone; the account itself is dropped below
  for (const [k, v] of Object.entries(st.behaviors ?? {})) { const sub = isAccount(v?.authorSub) ? v.authorSub : undefined;
    w[keyed("imported-behavior", k)] = who && v && sub ? { ...v, author: who(sub, { sub }) }   // the stamp first: `by` can't make it the system's
      : who && v && typeof v.author === "string" && !SYSTEM.has(v.author) ? { ...v, author: who(v.author, {}) } : v; }
  const known = new Set(["entities", "sky", "terrain", "grass", "assets", "roles", "bans", "behaviors", "mounts", "recentChat", "chatTotal"]);
  for (const [k, v] of Object.entries(st)) if (!known.has(k) && v != null) w[keyed("imported", k)] = v;
  // @12, wave 2 (render-media-env): the world's look in today's spelling, as the load repairs a stored one (repairWorld: the sky's
  // clock as tz, radians, transition; the terrain's int colours and the sim's defaults, its water as the water component;
  // grass in the flora spelling, a preset kept by its name)
  out["@world"] = repairWorld(w).c; // @world is live from genesis (§2.3)
  // no account subject in any value, wherever the v1 fold kept it (@16: a binding's authorSub, or anything carried as it was)
  for (const c of Object.values(out)) for (const [k, v] of Object.entries(c)) { const x = withoutAccounts(v); if (x !== v) c[k] = x; }
  for (const c of Object.values(out)) { splitUnknown(c); namespaceUnknown(c, ns); }
  return clone(out); // a copy: the old fold mutates some records in place (bstate), and aliasing would hide the change
}

// dialect 3: the instant fold COMPOSED with the first eidosim (foldEntry, then simEntry): the epoch is @world physics-engine,
// a logged rest holds until the law releases it (P5), and a v1 lib's stamped box is physics.shape (Covenant III), keyed by
// the v1 lib. With no epoch ever entered this returns project()'s value untouched
function physical(st, sim, recorded, out, dynamic = () => false) {
  if (!st.epoch && !recorded.size && !sim.boxes) return out;
  const w = out["@world"];
  // what the old sim made of the epoch: its own law (carried) → today's eidosim runs from here on; an engine it didn't
  // carry (foreign: nothing flew) → that name, with no build, so nothing flies here either; an epoch it refused (a bad
  // tickMs: it never started) → no physics, only the imported record
  if (sim.epoch && !sim.epoch.foreign) { delete w[keyed("imported", "epoch")]; w["physics-engine"] = { engine: DEFAULT_ENGINE, build: ENGINES[DEFAULT_ENGINE].build, tickMs: sim.epoch.tickMs }; }   // the old sim's tick (a later epoch it refused doesn't replace it)
  else if (sim.epoch?.foreign) { delete w[keyed("imported", "epoch")]; w["physics-engine"] = { engine: sim.epoch.sim, build: null, tickMs: sim.epoch.tickMs }; }
  for (const [id, p] of recorded) { const c = out[enc(id)]; if (sim.bodies[id] && c) c.transform = { ...c.transform, pos: p.slice() }; }
  if (sim.boxes) for (const [id, e] of Object.entries(st.entities ?? {})) { const c = out[enc(id)]; if (c && typeof e?.lib === "string" && sim.boxes[e.lib]) c.physics = { kind: dynamic(id) ? "dynamic" : "static", shape: clone(sim.boxes[e.lib]) }; }
  return out;
}
/** Which thing an id names, as the v1 fold tells them apart (fold.js bornOf): a spawn it accepts (an id, and a lib that's
 *  absent or real) is a NEW thing when the id was free (never spawned, or removed) or held a different lib or a light; a
 *  same-lib re-spawn is the same thing. `of(id)` is the id's life count; "punted → dynamic" is per thing. */
export function lifeTracker() {
  // an id is a property key to the v1 fold (st.entities[a.id]): 7 and "7" name one thing
  const lib = new Map(), n = new Map();
  return { of: (id) => n.get(String(id)) ?? 0, step(e) { const raw = e?.args?.id;
    if (e?.verb === "remove") { lib.delete(String(raw)); return; }   // the fold deletes entities[a.id] whatever a.id is (null → "null")
    if (raw == null) return; const id = String(raw);
    if (!raw) return;   // spawn and light ignore a falsy id (fold.js: !a?.id), as remove does not
    else if (e.verb === "light") lib.set(id, "\0light");
    else if (e.verb === "spawn" && id && !(e.args.lib != null && !e.args.lib)) { const l = e.args.lib ?? null;
      if (!lib.has(id) || lib.get(id) !== l) n.set(id, (n.get(id) ?? 0) + 1); lib.set(id, l); } } };
}
/** The things (`id#life`) a v1 log ever punts: these come across `dynamic`, every other collider `static`. */
export function puntedLives(entries) {
  const t = lifeTracker(), out = new Set();
  for (const e of entries) { t.step(e); const id = e?.args?.id; if (e?.verb === "punt" && id != null) out.add(`${String(id)}#${t.of(id)}`); }
  return out;
}
/** Whether a v1 log enters a physics epoch (the v1 fold's own test: a sim name and an integer tick). */
export const hasEpoch = (oldEntries) => oldEntries.some((e) => e?.verb === "epoch" && typeof e.args?.sim === "string" && Number.isInteger(e.args?.tickMs));

const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
export function diff(prev, now) {
  const ops = [];
  for (const id of Object.keys(prev)) if (!(id in now)) ops.push({ verb: "delete", id });
  for (const [id, comps] of Object.entries(now)) {
    if (!(id in prev)) { ops.push({ verb: "create", id }); for (const [k, v] of Object.entries(comps)) ops.push({ verb: "set", id, comp: k, value: clone(v) }); continue; }
    for (const k of Object.keys(prev[id])) if (!(k in comps)) ops.push({ verb: "delete", id, comp: k });
    for (const [k, v] of Object.entries(comps)) if (!eq(prev[id][k], v)) ops.push({ verb: "set", id, comp: k, value: clone(v) });
  }
  return ops;
}
export const v4project = (s) => Object.fromEntries(Object.keys(s.entities).map((id) => [id, { ...s.entities[id].c }]));
export const canon = (o) => JSON.stringify(o, (k, v) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
// one entry in the §2.4 envelope; the authority's re-read discipline applies: what we emit must parse back unchanged
export const changeBody = (ops) => (ops.length === 1 ? (({ verb, ...body }) => ({ verb, body }))(ops[0]) : { verb: "batch", body: { ops } });
// I-JSON has no -0; an old log may hold one (the same number, written as 0)
export { unNegZero };

export function translate(oldEntries, { onDivergence, foldBuild, key, operator, nonce, who, founder, namespace, content, approved } = {}) {
  if (founder !== undefined) throw new Error("a translation names no founder: nothing can yet bind a key to the old world's owner (v1 logs record accounts, not keys); tier 0 stays empty");
  const ns = namespace === undefined ? NAMESPACE : namespaceOf(namespace);
  const seenModels = new Map();   // path → its hash (or null): each path hashed once, and counted
  const addr = content ? (p) => { if (!seenModels.has(p)) seenModels.set(p, content(p) ?? null); return seenModels.get(p); } : null;
  const v1 = v1Empty(); const v4 = v4Empty(); const out = [];
  const stats = { in: oldEntries.length, out: 0, change: 0, verbs: {}, ops: 0, divergences: 0, firstDivergence: null, renamed: 0, guards: 0, guardsLive: 0 };
  const seen = { guards: new Set() }; // ids whose v1 guard became a lock at some point (§5: their owners should be told)
  let world = null;
  let lastTs = -Infinity; // §2.1: ts never decreases. v1 voice says carry speech time, which can run behind; clamp,
  // and stats.tsClamped counts them (the original ts stays in the source log, which is never overwritten, R9)
  const push = (e) => { if (e.kind !== "genesis") e = { world, ...e };
    if (Number.isInteger(e.ts)) { if (e.ts < lastTs) { e.ts = lastTs; stats.tsClamped = (stats.tsClamped ?? 0) + 1; } lastTs = e.ts; }
    const seq = out.length; out.push(e);
    if (e.kind === "genesis") world = worldIdOf(e); if (e.kind === "change") applyInPlace(v4, opsOf(e), seq); return seq; };
  const genesis = oldEntries[0]?.verb === "genesis" ? oldEntries[0].args : { v: 1, dialect: "eidoverse-log", implicit: true };
  const t0 = Number.isInteger(oldEntries[0]?.ts) ? { ts: oldEntries[0].ts } : {};
  push({ kind: "genesis", actor: "system", verb: "genesis", ...t0, body: translatedGenesis(oldEntries, { ...(key ? { key } : {}), ...(operator ? { operator } : {}), ...(nonce ? { nonce } : {}) }) });
  const physics = hasEpoch(oldEntries);
  // @19: the name beside an account is joined to it only where v1's server wrote both (a grant's or ban's id and sub, a
  // spawn's or light's placer, a behaviour's bySub with the act's actor); any other account is its own person's alone
  const mapAcct = who ? (sub) => who(sub, { sub }) : undefined;
  // the old genesis as it was, but never an account (@19): a genesis role's sub becomes its person's id, as in an old request
  push({ kind: "act", actor: "system", verb: "translated", ts: t0.ts ?? 0, body: { from: unNegZero(withoutAccounts({ ...genesis, translator: physics ? TRANSLATOR_SIM : TRANSLATOR, ...(foldBuild ? { fold: foldBuild } : {}) }, mapAcct)) } });
  // the translation writes the repaired spelling, so its log carries the load's once-per-world marker from the start: the
  // system's repair-shapes act, read by verb and actor only (the translated act's body is purgeable)
  push({ kind: "act", actor: "system", verb: "repair-shapes", ts: t0.ts ?? 0, body: { v: SHAPES_VERSION, ids: [], translated: true } });
  // the operator's approval of this translation (import-v1/world.ts), written here, before any cause is taken
  if (approved) push({ kind: "act", actor: "system", verb: "translation-approved", ts: t0.ts ?? 0, body: approved });
  // an old request keeps its words but never an account: a grant's or ban's top-level sub always, any other sub or *Sub
  // when account-shaped; it becomes the person's id with a mapper, else is dropped. A non-account sub elsewhere is data
  const noAcct = (e, a) => { let x = a;
    if (x && typeof x === "object" && !Array.isArray(x)) {
      // a top-level sub: a grant's or a ban's is the server's own stamp, beside the id it names, read as the person's account
      // whatever its shape; any other request's is an account alone, joined to no name, or, not being one, ordinary data
      // that stays (DROPPED)
      const pair = (e.verb === "grant" || e.verb === "ban") && typeof x.sub === "string";
      if ("sub" in x && (e.verb === "grant" || e.verb === "ban" || isAccount(x.sub))) {
        // the pair is one person: an id that is itself an account names them too
        if (who && pair) { const id = who(typeof x.id === "string" ? x.id : x.sub, { sub: x.sub }); x = { ...x, sub: id, ...(isAccountName(x.id) ? { id } : {}) }; }
        else if (who && isAccount(x.sub)) x = { ...x, sub: who(x.sub, { sub: x.sub }) };
        else { const { sub: _s, ...rest } = x; x = rest; } }
      // a person named by their account (a grant, ban or unban keyed by it): their id, as a role or ban keyed by it is. v1
      // matched a ban's and an unban's id in any case, so theirs is the account whatever its case in the log (world.ts)
      if (PERSON_REQUESTS.has(e.verb) && isAccountName(x.id) && !(who && pair)) {
        if (!who) { const { id: _i, ...rest } = x; x = rest; }
        else x = { ...x, id: e.verb === "grant" ? who(x.id, { sub: x.id }) : who(x.id.toLowerCase(), { lowered: true }) }; }
      // a placer is the person the server stamped, {id: their name, sub: their account}: both are that person's id, and a
      // name that is itself an account is theirs too (dropped without a mapper)
      const p = x.placer;
      if ((e.verb === "spawn" || e.verb === "light") && p && typeof p === "object" && !Array.isArray(p)) {
        if (who && isAccount(p.sub)) { const id = who(typeof p.id === "string" ? p.id : p.sub, { sub: p.sub }); x = { ...x, placer: { ...p, sub: id, ...(isAccountName(p.id) ? { id } : {}) } }; }
        else if (isAccountName(p.id)) { const { id: _i, ...q } = p; x = { ...x, placer: who ? { ...q, id: who(p.id, {}) } : q }; } }
      // a v1 comp's data is the component's value: under a name that has an account's, an account is one (@19)
      if (e.verb === "comp" && accountNamed(x.type) && isAccount(x.data)) {
        if (who) x = { ...x, data: who(x.data, { sub: x.data }) }; else { const { data: _d, ...rest } = x; x = rest; } }
      if (who && e.verb === "behavior" && isAccount(x.bySub))
        x = { ...x, bySub: who(typeof e.actor === "string" && !SYSTEM.has(e.actor) && !/^bhv:/i.test(e.actor) ? e.actor : x.bySub, { sub: x.bySub }) }; }
    return withoutAccounts(x, mapAcct); };
  const actorFor = (a) => (who && !SYSTEM.has(a ?? "door") ? who(String(a), {}) : actorOf(a ?? "door"));
  // ---- dialect 3 (@10): the old sim beside the v1 fold. Inert until an epoch: simEntry ignores everything before one, and
  // physical() returns project() as it is, so a log without one translates exactly as @9 did.
  const sim = eidosim.emptySim();
  const recorded = new Map();     // v1 id → its last LOGGED rest pose (held until the old law releases the body)
  const launchSeq = {};           // v1 id → the seq of the launch its current flight came from
  const restLogged = new Set();   // bodies whose CURRENT flight's rest is logged
  const restTicks = {};           // v1 id → the tick it came to rest
  // a thing the v1 log ever punts is a dynamic collider, every other one static: known up front, so the kind is right from
  // the moment its collider appears (no static → dynamic flip at the punt, which an undo of the punt's act would take
  // back), and per incarnation: an id spawned again is a new thing
  const lives = puntedLives(oldEntries); const lifeNow = lifeTracker(); const dynamic = (id) => lives.has(`${id}#${lifeNow.of(id)}`);
  if (physics) Object.assign(stats, { launches: 0, rests: 0, worldDivergences: 0 });
  const diverged = (kind, e, extra) => { stats.divergences++; if (physics) stats[kind]++;
    if (!stats.firstDivergence) { stats.firstDivergence = { oldSeq: e?.seq ?? null, verb: e?.verb ?? null, ...(physics ? { kind } : {}), ...extra }; } };
  const view = () => physical(v1, sim, recorded, project(v1, seen, who, ns, addr), dynamic);
  const stepTo = (tick) => { // single steps while anything flies, so each rest's real tick is known
    while (sim.epoch && !sim.epoch.foreign && sim.tick < tick) {
      const flying = Object.keys(sim.bodies).filter((id) => !sim.bodies[id].resting);
      if (!flying.length) { eidosim.advanceSim(sim, tick); break; }
      eidosim.advanceSim(sim, sim.tick + 1);
      for (const id of flying) if (sim.bodies[id]?.resting) restTicks[id] = sim.tick;
    }
  };
  let prev = view();
  const clock = () => (Number.isFinite(lastTs) ? lastTs : 0);   // the latest ts written (push clamps to it)
  const logRests = (ts) => { // P5: one result per body that came to rest, in the order they stopped
    const fresh = Object.keys(sim.bodies).filter((id) => sim.bodies[id].resting && launchSeq[id] !== undefined && !restLogged.has(id))
      .sort((a, b) => restTicks[a] - restTicks[b]);
    for (const id of fresh) {
      // the old sim's rest: a plain change by `sim`, caused by the punt's imported act (@11: no launch, no digest)
      recorded.set(id, sim.bodies[id].p.slice()); restLogged.add(id);
      const now = view(); const ops = diff(prev, now); prev = now;
      push({ kind: "change", actor: "sim", ts, cause: launchSeq[id], ...changeBody(unNegZero(ops)) }); stats.change++; stats.ops += ops.length;
      stats.rests++;
    }
  };
  for (const e of oldEntries) {
    if (e.verb === "genesis") continue;
    stats.verbs[e.verb] = (stats.verbs[e.verb] ?? 0) + 1;
    const ts = Number.isInteger(e.ts) ? e.ts : undefined; // §2.1: the authority's admission time, carried from the old entry
    if (sim.epoch && ts !== undefined) { stepTo(eidosim.tickOf(sim, ts)); logRests(Math.max(ts, clock())); }
    foldEntry(v1, e); eidosim.simEntry(sim, e, v1);
    lifeNow.step(e);
    const actor = actorFor(e.actor); if (actor !== e.actor) stats.renamed++;
    const tl = push({ ...(e.verb === "say" ? { kind: "say", actor, verb: "say", body: unNegZero(((b) => (who && typeof b.to === "string" && !SYSTEM.has(b.to) ? { ...b, to: who(b.to, {}) } : b))(clone(e.args) ?? {})) }
      : { kind: "act", actor, verb: "imported", body: unNegZero({ verb: e.verb, args: noAcct(e, clone(e.args) ?? null), from: e.seq ?? null }) }), ...(ts !== undefined ? { ts } : {}) });
    const b = sim.bodies[e.args?.id];
    if (e.verb === "punt" && b && b.seq === e.seq) { // a punt started (or kicked) a body: its rest will be caused by this act
      launchSeq[e.args.id] = tl;
      restLogged.delete(e.args.id); stats.launches++;
    }
    for (const id of [...recorded.keys(), ...Object.keys(launchSeq), ...Object.keys(restTicks)]) if (!sim.bodies[id]) { recorded.delete(id); restLogged.delete(id); delete launchSeq[id]; delete restTicks[id]; } // released by the old law (or a new epoch)
    const now = view();
    const ops = diff(prev, now);
    if (ops.length) { push({ kind: "change", actor, cause: tl, ...changeBody(unNegZero(ops)), ...(ts !== undefined ? { ts } : {}) }); stats.change++; stats.ops += ops.length; }
    if (canon(v4project(v4)) !== canon(now)) { diverged("worldDivergences", e); if (stats.divergences === 1) onDivergence?.(e, now, v4project(v4)); }
    prev = now;
  }
  // settle, as the replaybench does: far past the last entry, then log what came to rest
  if (sim.epoch && !sim.epoch.foreign) {
    stepTo(sim.tick + 100000);
    const tsAt = (tick) => sim.epoch.ts + tick * sim.epoch.tickMs;
    logRests(Object.values(restTicks).reduce((m, t) => Math.max(m, tsAt(t)), clock()));
  }
  stats.out = out.length;
  if (addr) { stats.modelsHashed = [...seenModels.values()].filter(Boolean).length; stats.modelsUnhashed = [...seenModels].filter(([, a]) => !a).map(([p]) => p); }
  stats.guards = seen.guards.size; stats.guardsLive = Object.values(v1.entities ?? {}).filter((e) => e?.comp?.guard && !e.comp.lock).length;
  return { out, stats, final: { v1: physical(v1, sim, recorded, project(v1, null, who, ns, addr), dynamic), translated: v4project(v4) }, ...(physics ? { theirs: sim } : {}) };
}
