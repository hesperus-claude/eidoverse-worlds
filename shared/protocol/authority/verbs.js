// shared/protocol/authority/verbs.js — the verb table's own bodies, in the groups authority.js spreads into VERBS in table
// order: FOUNDING_VERBS (create-world), SCHEMA_VERBS (schema), WRITE_VERBS (create, set, delete, place, turn, publish,
// update), SAY_VERBS (say, undo, caption), BATCH_VERBS (sky, weather, sculpt, batch, fork-copy), and buildBatch.
import { cowState, applyCow, DIALECT, VERSION, emptyState, keyOk } from "../fold.js";
import { valueCheck } from "./checks.js";
import { COMPONENTS, STATUSES, defOf } from "../componentspec.js";
import { normalizeCaptionArgs, captionRefusal, foldCaption } from "../../captions.js";
import { effectFor, ESSENTIAL_NAMES } from "../../particle_effects.js";
import { SHAPES_VERSION } from "../shaperepair.js";
import { CTX, UP } from "./ctx.js";
import { BATCH_OPS, validate } from "../verbspec.js";
import { Refusal, refuse } from "./refuse.js";
import { VOLATILE, delOp, nonce16, setOp } from "./storage.js";
import { SPATIAL, clockMs, spend } from "./spatial.js";
import { muteOf } from "./rights.js";
import { buildPublish, buildUpdate } from "./blueprints.js";
import { buildSculpt, buildSky, buildUndo, buildWeather } from "./undo.js";
import { scriptCeiling, scriptDefaults, scriptMemo } from "./scripts.js";
import { CAPACITY, CAPACITY_CEILING } from "./capacity.js";
import { SAY_MAX, admit, rateCheck, spokenOf } from "./gate.js";
import { actEntry, actOf, buildCreate, buildDelete, buildPlace, buildSet, buildTurn, changeEntry, commit } from "./writes.js";

const FOUNDING_VERBS = {
  "create-world"(w, actor, a) {
    if (w.exists) refuse("exists", `world '${w.name}' exists`, "you're in it already: look shows what's here; help shows your role");
    if (a.dry) return { ok: true, dry: true, would: { found: w.name, you: "owner", title: a.title ?? w.name } };
    // a FORK names its parent with the seq it was copied at ({world, seq, head}): genesis.parent, part of the new world's
    // id and the merge base (PROTOCOL §13); a reset names its predecessor without a seq (provenance only)
    if (a.from !== undefined) { const f = a.from, hex = (x) => typeof x === "string" && /^[0-9a-f]{64}$/.test(x);
      if (!f || typeof f !== "object" || !(typeof f.world === "string" && /^sha256:[0-9a-f]{64}$/.test(f.world)) || !hex(f.head) || (f.name !== undefined && typeof f.name !== "string") || (f.seq !== undefined && !(Number.isInteger(f.seq) && f.seq >= 0)) || Object.keys(f).some((k) => !["world", "head", "name", "seq"].includes(k)))
        refuse("shape", "create-world {from} names the world it came from: {world: sha256:<64 hex>, head: <64 hex>, seq? (a fork: the seq it was copied at), name?}", ""); }
    // genesis seeds no state (§13), it names the governance keys: tier 0 the founder's OWN key when they bring one (ownerKey;
    // this server never holds it), tier 1 the operator's custody key. Without one tier 0 can never be filled later (GOV-5)
    // and the operator is the top key.
    if (a.ownerKey !== undefined && !keyOk(a.ownerKey)) refuse("shape", "ownerKey is your own governance key: ed25519:<base64url of 32 bytes> (PROTOCOL §13)", "make one on your own machine (openssl genpkey -algorithm ed25519; PROTOCOL §13, \"Whose key is tier 0\"); or leave ownerKey out");
    const cu = w.custody(); if (!cu) throw new Error("authority bug: founding needs io.custody (the sequencer and founder keys, §13)");
    if (a.ownerKey !== undefined && (a.ownerKey === cu.operator() || a.ownerKey === cu.sequencer())) refuse("shape", "ownerKey must be your own key, not this server's", "");
    const ops = [setOp("@world", "about", { name: a.title ?? w.name, text: a.text ?? "" }), setOp("@world", "bounds", { min: [-20, 0, -20], max: [20, 12, 20] }),
      setOp("@world", `roles:${actor}`, { role: "owner" }),
      // starter config: in a NEW world newcomers are builders until the owner gates it. Written, never implied: a world
      // without it (every world founded before) keeps inhabitant
      setOp("@world", "default-role", { role: "builder" })];
    // the founding writes are checked before anything is appended: a refusal after genesis would leave a world nobody owns
    for (const op of ops) valueCheck(emptyState(), op, { now: w.now() });
    w.append({ kind: "genesis", actor: "system", verb: "genesis", body: { dialect: DIALECT, v: VERSION, minor: 0, nonce: nonce16(w), owners: [a.ownerKey ? [a.ownerKey] : [], [cu.operator()]], sequencer: cu.sequencer(),
      ...(a.from?.seq !== undefined ? { parent: { world: a.from.world, seq: a.from.seq, head: a.from.head } } : {}) } });
    const plan = admit(w, w.state(), { actor, cap: { kind: "founding", ids: ["@world"], comps: ops.map((o) => o.comp) } }, ops);
    // born in today's shapes: the maintenance repair never runs on this world (shapesMarked)
    changeEntry(w, plan, w.append(actOf(w, actor, "create-world", a, { shapes: SHAPES_VERSION })));
    // …and the marker is the system's repair-shapes act beside it: read by verb and actor only, which a purge never reaches
    // (the founding's body holds the title, the first thing an owner might purge)
    w.append(actEntry(w, "system", "repair-shapes", { v: SHAPES_VERSION, ids: [], founding: true }));
    return { ok: true, world: w.name, you: "owner", ...(a.ownerKey ? {} : { governance: "tier 0 is empty: this server's operator key is the world's top governance key (PROTOCOL §13). Founding with ownerKey (your own ed25519 key) puts you there instead; tier 0 can't be filled later" }) };
  },
};
const SCHEMA_VERBS = {
  // also the Essentials and their params, each definition's status and this server's policy numbers (PROTOCOL §9.2); one
  // component is read through defOf (a keyed name or alias answers; an unknown one is refused)
  schema(w, actor, a) { const one = a.component ? defOf(String(a.component)) : undefined;
    if (a.component && !one) refuse("not-found", `no component called '${a.component}'`, "schema {} lists every component", { didYouMean: UP.guess(String(a.component), Object.keys(COMPONENTS)) });
    return { ok: true, components: a.component ? { [a.component]: one } : COMPONENTS, statuses: STATUSES,
    server: { defaults: { capacity: { ...CAPACITY }, "script-settings": scriptDefaults() }, ceilings: { capacity: { ...CAPACITY_CEILING }, "script-settings": scriptCeiling() } },
    ...(a.component === "particles" ? { effects: Object.fromEntries(ESSENTIAL_NAMES.map((k) => { const d = effectFor(k); return [k, { reads: d.reads, params: Object.fromEntries(Object.entries(d.params ?? {}).map(([n, p]) => [n, { type: p.type, ...(p.min !== undefined ? { min: p.min } : {}), ...(p.max !== undefined ? { max: p.max } : {}), ...(p.values ? { values: p.values } : {}), ...(p.help ? { help: p.help } : {}) }])) }]; })) } : {}) }; },
};
const WRITE_VERBS = {
  create: (w, actor, a) => commit(w, actor, "create", a, (ctx) => buildCreate(ctx, a)),
  set: (w, actor, a) => commit(w, actor, "set", a, (ctx) => buildSet(ctx, a)),
  delete: (w, actor, a) => commit(w, actor, "delete", a, (ctx) => buildDelete(ctx, a)),
  place: (w, actor, a) => commit(w, actor, "place", a, (ctx) => buildPlace(ctx, a)),
  turn: (w, actor, a) => commit(w, actor, "turn", a, (ctx) => buildTurn(ctx, a)),
  publish: (w, actor, a) => commit(w, actor, "publish", a, (ctx) => buildPublish(ctx, a, w)),
  update: (w, actor, a) => commit(w, actor, "update", a, (ctx) => buildUpdate(ctx, a, w)),
};
const SAY_VERBS = {
  say(w, actor, a) { if (!a.text) refuse("shape", "say needs text", "");
    // a chat mute refuses every say: a say with `to` is still a public line in the log, and world chat has no private
    // channel. The refusal says until when, and why when a reason was given
    { const m = muteOf(w, actor, "chat"); if (m)
      refuse("muted", `you're muted in this world's chat${m.until !== undefined ? ` until ${new Date(m.until).toISOString()}` : ""}${m.reason ? ` (${m.reason})` : ""}`, "it ends on its own; the moderator who muted you can lift it sooner", { until: m.until ?? null }); }
    if (typeof a.text !== "string" || a.text.length > SAY_MAX) refuse("too-big", `a say is at most ${SAY_MAX} characters (this one is ${String(a.text).length})`, "split it, or put a long text in a blob");
    if (a.to !== undefined && (typeof a.to !== "string" || a.to.length > 64)) refuse("shape", "say.to names one person: a string of at most 64 characters", "say {text, to: '<identity>'}");
    const body = { text: a.text, ...(a.to ? { to: a.to } : {}), ...spokenOf(a, w.now()) };
    rateCheck(w, actor, "say", JSON.stringify(body).length); const seq = w.append({ kind: "say", actor, verb: "say", body }); (w.sayQ ??= []).push(seq); return { ok: true, seq }; }, // w.append refuses too-big before writing
  undo: (w, actor, a) => commit(w, actor, "undo", a, (ctx) => buildUndo(ctx, a, w)),
  // ---- captions: one line of what a screen said. Rights live on the SCREEN (`captioners {ids}`, or anyone who may edit
  // it); no hand `set`. The rules are shared/captions.js's: session, rising n, the server-stamped leg `gen`, and `end`. ----
  caption: (w, actor, a) => commit(w, actor, "caption", a, (ctx) => {
    const n = normalizeCaptionArgs(a); if (!n.ok) refuse("shape", n.why, "caption {id, session, n, t0, t1, text, speaker?, title?} | {id, session, end: true}");
    const id = n.args.id; const e = ctx.st.entities[id]; if (!e) refuse("not-found", `nothing here called ${id}`, "look lists what's here");
    const args = { ...n.args, gen: Number.isSafeInteger(a.gen) && a.gen >= 0 ? a.gen : 0 };
    const why = captionRefusal(e.c.captions, args); if (why) refuse("caption", why, "a resend of a line already written is refused: read that as its receipt");
    ctx.cap = { kind: "caption", ids: [id], comps: ["captions"] };
    const next = foldCaption(e.c.captions, args);
    return [next ? setOp(id, "captions", next) : delOp(id, "captions")];
  }),
};
const BATCH_VERBS = {
  // the sky panel's two verbs (shared/forecast.js foldSkyEntry): `sky` replaces the sky, stamped with the AUTHORITY's clock
  // (hours advance from it); `weather` merges onto the standing sky. Who and which seq are derived (the log says), never stored.
  sky: (w, actor, a) => commit(w, actor, "sky", a, (ctx) => buildSky(ctx, a, w)),
  weather: (w, actor, a) => commit(w, actor, "weather", a, (ctx) => buildWeather(ctx, a, w)),
  sculpt: (w, actor, a) => commit(w, actor, "sculpt", a, (ctx) => buildSculpt(ctx, a)),
  batch(w, actor, a) { return commit(w, actor, "batch", a, (ctx) => buildBatch(ctx, a, w)); },
  // a fork's copy of its parent (server/worldlog.ts forkWorld): an ordinary batch through the same gate, logged under its own
  // verb so a reader tells inherited things from births (PROTOCOL §13), carrying what the parent holds as it is. Only
  // authority.js forkCopy reaches it: no request word does.
  "fork-copy"(w, actor, a) {
    if (!CTX.forking) refuse("rights", "fork-copy is the server's own copy of a world into its fork; it isn't a request", "fork a world with the fork request (an owner of the source)");
    return commit(w, actor, "fork-copy", a, (ctx) => buildBatch(ctx, a, w));
  },
};
function buildBatch(ctx, a, w) { {
      // the next op sees this one's result: ONE working copy for the batch, copied per entity as ops touch it (never a world
      // copy per op). Views cached on that copy drop after each op; per-thing geometry checks what it read (geoOf)
      const all = []; let st = ctx.st; let work = null;
      const forget = (x) => { SPATIAL.delete(x); scriptMemo.delete(x); };
      // every child is checked against its verb's arguments BEFORE any is built, as outside a batch: unchecked,
      // {verb: "delete", args: {id, componnent}} built a whole-entity delete
      (a.ops ?? []).forEach((o, i) => {
        if (!o || typeof o !== "object" || Array.isArray(o)) refuse("shape", `batch op ${i} is {verb, args}, got ${JSON.stringify(o)}`, "batch takes ops [{verb, args}, …]", { op: i });
        if (o.args !== undefined && (!o.args || typeof o.args !== "object" || Array.isArray(o.args))) refuse("shape", `batch op ${i}: args is an object, got ${JSON.stringify(o.args)}`, "batch takes ops [{verb, args}, …]", { op: i });
        const bad = validate(o.verb, o.args ?? {}) ?? (o.verb === "create" && o.args?.place ? validate("place", { ...o.args.place, id: "x" }) : null);
        if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, `batch op ${i}${o.verb === "create" && o.args?.place && !validate(o.verb, o.args ?? {}) ? " place" : ""}: ${reason}`, fix, { ...rest, op: i }); }
      });
      (a.ops ?? []).forEach((o, i) => {
        if (clockMs() > CTX.work.until) spend(Infinity, `a batch of ${a.ops.length} ops`, "split it into smaller batches");   // the clock backstop
        // sky/weather are sets on @world.sky with the old merge meaning: they batch like any set (one act, one undo)
        const B = { create: buildCreate, set: buildSet, delete: buildDelete, place: buildPlace, turn: buildTurn,
          sky: (c, x) => buildSky(c, x, w), weather: (c, x) => buildWeather(c, x, w) }[o.verb];
        if (!B) refuse("shape", `batch op ${i}: '${o.verb}' can't go in a batch`, `batch takes ${BATCH_OPS.join(", ")}`);
        const sub = { ...ctx, st, launches: undefined, lifts: undefined };
        let ops; try { ops = B(sub, o.args ?? {}); } catch (e) { if (e instanceof Refusal) { e.op = i; } throw e; }
        if (!work) { work = cowState(ctx.st); VOLATILE.add(work.entities); }
        all.push(...ops); st = applyCow(work, ops); forget(st); sub.refs.forEach((r) => ctx.refs.add(r));
        if (sub.cap) ctx.cap = sub.cap;
        if (sub.launches) { (ctx.launches ??= []).push(...sub.launches); sub.launches = undefined; }   // a delete's woken things (buildDelete)
        if (sub.lifts) ctx.lifts = [...new Set([...(ctx.lifts ?? []), ...sub.lifts])].sort();   // an engine's start: what is in a hand (buildSet of physics-engine)
      });
      return all;
} }
export { BATCH_VERBS, FOUNDING_VERBS, SAY_VERBS, SCHEMA_VERBS, WRITE_VERBS };
