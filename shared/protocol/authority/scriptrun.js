// shared/protocol/authority/scriptrun.js — scripts, the running half: activate, withAuthority, the server's
// settle/tick/checkpoint beat, orphan settlement, liftWorld (the load's report) and maintain (the maintenance command), the
// presence and hand events and their drains, the status view, and SCRIPT_VERBS (upload, effect, adopt, scripts). The
// standing half is authority/scripts.js.
import { grabOf } from "../../grab.js";
import { isIdentity, PURGED } from "../fold.js";
import { dec } from "../names.js";
import * as SR from "../scriptrules.js";
import { effectFor, effectBlobName, EFFECT_KIND, ESSENTIAL_NAMES } from "../../particle_effects.js";
import { livePoses, digestOf, simCutOf, lostPlace, ends, endsUnder } from "../simlayer.js";
import { RENAMED_COMPONENTS, renameOps, shapeRepairOps, shapesMarked, SHAPES_VERSION } from "../shaperepair.js";
import { CTX, UP } from "./ctx.js";
import { Refusal, refuse, said } from "./refuse.js";
import { readback, delOp, holdsCustody, isE, opsQuiet, setOp, versionSeq } from "./storage.js";
import { worldT } from "./math.js";
import { legacyHosts, liftHostOps, storedLegacyHosts } from "./sockets.js";
import { creatorOf, isBanned, isScriptActor, lastSetterOf, may, roleOf } from "./rights.js";
import { bodyGate, expireAsks } from "./bodyconsent.js";
import { DRY, DUTY, allScripts, budgetOf, dutyLeft, dutyLog, limitWhose, logRt, overCpu, pausedBy, presentOf, rtKey, rtOf, sampleOf, scopeIds, scriptDepth, scriptsCfg, sponsorOf, uploadEffect } from "./scripts.js";
// layers above this one (a leaf may not import them), through UP (ctx.js)
const admit = (...a) => UP.admit(...a);
const changeEntry = (...a) => UP.changeEntry(...a);
const changeShape = (...a) => UP.changeShape(...a);
const commit = (...a) => UP.commit(...a);
const dist = (...a) => UP.dist(...a);
const enter = (...a) => UP.enter(...a);
const guess = (...a) => UP.guess(...a);
const lacks = (...a) => UP.lacks(...a);
const lastTouch = (...a) => UP.lastTouch(...a);
const needThing = (...a) => UP.needThing(...a);
const request = (...a) => UP.request(...a);
const restampEngine = (...a) => UP.restampEngine(...a);
const returnDue = (...a) => UP.returnDue(...a);
const returnHome = (...a) => UP.returnHome(...a);
const returnPlan = (...a) => UP.returnPlan(...a);
const settleSim = (...a) => UP.settleSim(...a);

// what an act records of its event: everything but what its trigger already holds (a say's text and `to`, a use's args), so
// purging that say or request purges it everywhere (an auditor reads it from the trigger: scriptaudit.js)
const recorded = (ev) => { const { text, to, args, ...rest } = ev; return ev.seq !== undefined ? rest : ev; };
// an arrival or departure records no identity (no trigger actor, no event.by): a signed act naming who came and went
// would be an attendance list. The script still hears `by` live; the auditor re-runs with a stand-in (scriptaudit.js).
const ANON_EVENTS = new Set(["enter", "leave"]), GRIP_EVENTS = new Set(["grab", "release"]);
const anonEvent = ({ by: _by, ...rest }) => rest;
const overBudget = (st, B, cfg, key, sponsor, cost) => (B.mine >= cfg.rate ? `${key} logged ${B.mine} activations in the last minute; the rate is ${cfg.rate}`
  : B.all + cost > cfg.budget ? `this world's scripts wrote ${B.all} entries in the last hour; the budget is ${cfg.budget}, ${limitWhose(st, cfg, "budget")}`
  : B.bySponsor + cost > B.share ? `${said(sponsor)}'s scripts wrote ${B.bySponsor} entries in the last hour; each of the ${B.sponsors} sponsors here gets ${B.share} of the world's ${cfg.budget}` : null);
// A script whose value stands but whom no write in the log answers for (its install act purged): it doesn't run. Nobody is on
// record as its creator, so only an owner may write the key, and adopt is the recovery that names a sponsor: a set of the
// same value changes nothing more than `paused`, and sponsorOf passes over such a write
const UNSPONSORED = "nobody in this world's log answers for it (its install isn't there, as when it was purged), so it doesn't run; an owner may adopt it (adopt {id, script}), which makes them its sponsor";
// why a script is paused for failing, with the last failure (a deterministic one fails the same way when retried)
const pausedWhy = (rt) => `paused after ${rt.fails} failed activations in a row${rt.lastFail ? ` (the last: ${rt.lastFail.code}: ${rt.lastFail.why})` : ""}; ` +
  "fix what failed, then set the script again; setting the same value only retries, which helps if the cause has passed";
// why a script's source can't run: not stored here (a host's missing file, or no blob), unreadable (fails its name's hash, or
// won't parse), or not a script's source. Each is fixed the same way.
const sourceWhy = (blob, unreadable, src) => `${unreadable ? `its source ${src} couldn't be read here` : !blob ? `its source ${src} isn't stored here`
  : `its source ${src} isn't ${SR.LANG} source`}; upload the source again (upload {text}) and set the reply's src in the script`;
// One activation. ev = {on, by?, seq?, cause?, dry?, …the event's own fields}. A refused or failed activation logs NOTHING
// (its reason goes to the script's console ring and the status view).
function activate(w, id, name, ev) {
  const st = w.state(), key = `script:${name}`, v = st.entities[id]?.c[key], cfg = scriptsCfg(st);
  const { cause, dry, requester, ...event } = ev;   // requester: who asked for a dry run (the event's `by` may be one it simulates)
  const rt = dry ? { console: [] } : rtOf(w, id, name);
  const out = (status, extra = {}) => { if (!dry) { const { logs, ...line } = extra; logRt(w, rt, { on: ev.on, status, ...line, ...(logs ? { logs } : {}) }); rt.status = status; }
    return { script: key, id, status, ...extra }; };
  if (!v || typeof v !== "object" || v === PURGED) return out("not-installed");
  if (v.paused === true) { const pb = pausedBy(w, id, key); return out("paused", { why: pb ? `paused by ${said(pb.by)} at seq ${pb.at}` : "paused: true" }); }
  if (cfg.run === false) return out("stopped", { why: "@world.script-settings.run is false (the owner's kill permission)" });
  // an activation the host sets off (a timer, an arrival, a grab) is a write too, so it meets the gate every request's write
  // does (writeBlock): not on an altered log, nor before the maintenance command, whose repair would reread what it wrote as old
  if (!dry) { const b = writeBlock(w); if (b) return out("refused", { code: b.code, why: b.reason, fix: b.fix }); }
  const sp = sponsorOf(w, id, key); if (!sp) return out("not-installed", { why: UNSPONSORED });
  if (isBanned(w, sp.sponsor)) return out("suspended", { why: `suspended: sponsor ${said(sp.sponsor)} is banned (moderator log); nothing ran` });
  const ver = lastTouch(w, id, key)?.seq; if (!dry && rt.ver !== ver) { rt.ver = ver; rt.fails = 0; rt.lastFail = null; } // a re-set (a fix) clears the failure count
  if (!dry && (rt.fails ?? 0) >= cfg.fails) return out("paused", { why: pausedWhy(rt) });
  const depth = 1 + (cause !== undefined ? scriptDepth(w, cause) : 0);
  if (depth > cfg.depth) return out("refused", { code: "depth", why: `cascade depth ${depth} > ${cfg.depth}` });
  if (!w.scripts) return out("unavailable", { why: "this server has no script sandbox" });
  let blob = null, unreadable = false; try { blob = w.getBlob(v.src); } catch (e) { unreadable = e?.code !== "ENOENT"; }
  const fail = (code, why, logs) => { if (!dry && code !== "unavailable") { rt.fails = (rt.fails ?? 0) + 1; rt.lastFail = { code, why }; } return out(code === "unavailable" ? "unavailable" : "failed", { code, why, ...(logs?.length ? { logs } : {}), ...(dry ? {} : { fails: rt.fails }) }); };
  if (!blob || blob.lang !== SR.LANG || typeof blob.text !== "string") return fail("source", sourceWhy(blob, unreadable, v.src));
  const actSeq = w.entries.length, seed = SR.seedOf(w.worldId, actSeq, `${id}/${key}`), now = w.nextTs(); // the clock is frozen at the act's own ts
  if (!dry) { const why = overCpu(w, now, id, key, sp.sponsor, cfg); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const B = budgetOf(w, st, now, id, key, sp.sponsor, cfg); // spent already: refused before it costs the authority a run
  { const why = overBudget(st, B, cfg, key, sp.sponsor, 1); if (why) return out("refused", { code: "budget", why, sponsor: sp.sponsor }); }
  const here = presentOf(w), me = worldT(st, id)?.pos ?? [0, 0, 0];
  if (dutyLeft(w.worldId) <= 0) return out("refused", { code: "busy", why: `the authority's scripts have used their share of the last second (${DUTY.maxMs} ms for every world here, ${Math.round(DUTY.maxMs * DUTY.worldShare)} for one); it runs again when there's time`, sponsor: sp.sponsor });
  if (dry) { const now0 = w.now(), who = requester ?? "?"; const D0 = ((w.presence.dryRuns ??= {})[who] ??= []).filter((t) => now0 - t < DRY.ms); w.presence.dryRuns[who] = D0;
    if (D0.length >= DRY.n) return out("refused", { code: "rate", why: `${said(who)} has asked for ${D0.length} dry runs in the last minute; at most ${DRY.n}` });
    D0.push(now0); w.presenceDirty = true; }
  const t0 = performance.now();
  const res = w.scripts.run({ text: blob.text, self: id, key, event, knobs: v.knobs ?? {}, now, seed, api: SR.API, st,
    near: (r) => [...here].filter(([, at]) => at && dist(at, me) <= r).map(([k]) => k).sort(), count: () => here.size,
    name: (who) => (typeof who === "string" && (isIdentity(who) || isScriptActor(who)) ? CTX.nameOf?.(who) ?? dec(who) ?? null : null) });
  { const ms = performance.now() - t0; dutyLog.push({ at: performance.now(), ms, w: w.worldId }); } // dry runs spend the thread too
  if (!dry) { const ms = performance.now() - t0;
    (w.presence.scriptRuns ??= []).push({ ts: now, id, key, sponsor: sp.sponsor, ms: Math.round(ms) }); w.presenceDirty = true; }
  if (!res.ok) return fail(res.code, res.why, res.logs);
  const logs = res.logs.length ? { logs: res.logs } : {};
  const ops = SR.elide(st, SR.stampMotions(st, res.ops, now));   // a motion on the authority's clock, then the batch's elision of no-op writes
  if (!ops.length && !res.says.length && !res.bodies.length) { if (!dry) rt.fails = 0; return out("nothing", { why: res.ran ? "nothing changed: no entry" : `it has no handler for '${ev.on}'`, ...logs }); }
  const cap = { kind: "script", key, id, sponsor: sp.sponsor, ids: scopeIds(st, id, v.scope?.ids), comps: v.scope?.comps ?? [], create: !!v.scope?.create };
  const mark = (code, why) => out("refused", { code, why, sponsor: sp.sponsor, ...logs });
  if (res.says.length && !v.scope?.say) return mark("scope", `${key} doesn't declare say: true`);
  for (const b of res.bodies) if (!(v.scope?.bodies ?? []).includes(b.kind)) return mark("scope", `${key} doesn't declare bodies: ['${b.kind}']`);
  { const why = overBudget(st, B, cfg, key, sp.sponsor, 1 + (ops.length ? 1 : 0) + res.says.length); if (why) return mark("budget", why); } // what it would actually write
  let plan = null;
  if (ops.length) try { plan = admit(w, st, { actor: `script:${id}`, cap }, ops); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
  if (dry) return { script: key, id, status: "would-run", would: plan?.ops ?? [], says: res.says, bodies: res.bodies, sponsor: sp.sponsor, fuel: res.fuel, note: "dry: nothing was written; body effects still meet each body's consent when it runs", ...logs };
  const gates = [];
  for (const b of res.bodies) { const g = bodyGate(w, `script:${id}`, b.to, b.kind, { spec: b.spec, script: key, sponsor: sp.sponsor }); if (!g.ok) return mark(g.code, g.reason); gates.push({ ...b, consent: g.consent, deliver: g.deliver }); }
  // arrivals, departures and unlogged hand events (presence) record no identity; a hand event with an act of its own
  // already names its actor there, so its activation keeps `trigger`
  const anon = ANON_EVENTS.has(ev.on) || (GRIP_EVENTS.has(ev.on) && ev.seq === undefined);
  const actE = { kind: "act", actor: `script:${id}`, verb: "script", ...(cause !== undefined ? { cause } : {}),
    body: { script: key, src: v.src, sponsor: sp.sponsor, sponsorAt: sp.sponsorAt, on: ev.on, ...(ev.by && !anon ? { trigger: { actor: ev.by, ...(ev.seq !== undefined ? { seq: ev.seq } : {}) } } : {}),
      event: anon ? anonEvent(recorded(event)) : recorded(event), head: actSeq - 1, seed, depth, engine: SR.ENGINE, api: SR.API, ...(res.reads ? { reads: res.reads } : {}),
      // a body effect is recorded as WHAT and ON WHOM, never which consent let it through: "allowed" vs "standing" is a
      // relationship fact, and consent is presence, never appended
      ...(gates.length ? { bodies: gates.map((g) => ({ kind: g.kind, to: `body:${g.to}` })) } : {}) } };
  const sayE = (t, c) => ({ kind: "say", actor: `script:${id}`, cause: c, verb: "say", body: { text: t } });
  let act, state = null;
  w.pinTs = now;
  try {
    try { w.fits(actE, ...(plan ? [changeShape(plan, actSeq, w)] : []), ...res.says.map((t) => sayE(t, actSeq))); } catch (e) { if (!(e instanceof Refusal)) throw e; return mark(e.code, e.reason); }
    act = w.append(actE); if (plan) { state = changeEntry(w, plan, act); UP.letGoEdited(w, plan, act, st, w.state(), `script:${id}`); }   // a script's move lets go as an edit's does
    for (const t of res.says) (w.sayQ ??= []).push(w.append(sayE(t, act)));
  } finally { w.pinTs = null; }
  for (const g of gates) g.deliver();
  rt.fails = 0; return out("ran", { act, ...(state !== null ? { state } : {}), ops: ops.length, sponsor: sp.sponsor, ...logs });
}
function withAuthority(w, fn) {
  const exit = enter(w, null);
  try { return fn(); } finally { exit(); if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } }
}
/**
 * The engine's heartbeat: advances the sim toward the authority's clock, at most `maxTicks` a pass (a stall catches up over
 * passes, never by a longer step), logs rests, returns what is due back, expires asks. → entries written.
 */
export function settle(w, { maxTicks = 8 } = {}) {
  // without the world's key nothing can be logged (append refuses), so the heartbeat doesn't start what it can't write
  if (!w.exists || w.state().status !== "ok" || !holdsCustody(w)) return 0;
  return withAuthority(w, () => {
    const clock = w.now; const t0 = clock(); const cap = w.simCapTs?.(maxTicks); const t = cap !== null && cap !== undefined && cap < t0 ? cap : t0;
    w.now = () => t;   // one clock for the pass, as a request has: a rest's digest and its ts agree
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    const n0 = w.entries.length;
    CTX.work = { left: Infinity, until: Infinity, k: 0 };
    restampEngine(w); settleSim(w); returnDue(w); expireAsks(w); checkpointSim(w);
    drainAll(w);   // what the beat logged reaches scripts, as a request's entries do
    return w.entries.length - n0;
  });
}
// a checkpoint is a persisted joiner cut, so boot needn't re-simulate every flight: at a quiet moment after launches one
// `sim:checkpoint` entry names a blob of the sim cut (simCutOf) with its engine and digest. A carrying host opens from the
// last valid one; other readers fold past it. The fold itself is never checkpointed (cheap and exact from genesis).
const CHECKPOINT_QUIET_MS = 20000;
function checkpointSim(w) {
  if (typeof w.putBlob !== "function" || !w.state().entities["@world"]?.c["physics-engine"]) return;
  // incremental, never a whole-log scan every beat: what's been counted stays counted
  const E = w.entries; const k = (w.ckptScan ??= { to: -1, launches: 0, newest: -Infinity });
  for (let s = k.to + 1; s < E.length; s++) { const e = E[s]; k.to = s; if (!e || typeof e !== "object" || e.kind !== "sim") continue;
    if (e.verb === "checkpoint") { k.launches = 0; k.newest = -Infinity; } else if (e.verb === "launch") { k.launches++; if (e.ts > k.newest) k.newest = e.ts; } }
  if (!k.launches || w.now() - k.newest < CHECKPOINT_QUIET_MS) return;
  const sf = w.sim(); if (!sf.sim || sf.foreign || Object.keys(livePoses(sf)).length || sf.rested.length || (w.unsettled?.length ?? 0)) return;
  // the cut travels as a JSON string: the blob store canonicalises objects (sorted keys), and the engine's object order is
  // the law's (statics and bodies tie by insertion order), so a re-keyed cut would be a different sim
  const cut = simCutOf(sf, E);
  const state = w.putBlob({ cutJson: JSON.stringify(cut) });
  w.append({ kind: "sim", actor: "sim", verb: "checkpoint", body: { at: E.length - 1, engine: { engine: sf.spec.engine }, tick: sf.sim.tick, clock: sf.clock, sim: digestOf(sf.sim), state } });
}
/**
 * Timers: a due script with nobody present sleeps unless `always`, then gets ONE `wake {slept}`; missed periods coalesce.
 * A timer act's cause is its sponsor's latest install. A host calls this on its own clock, never inside a request.
 */
export function tick(w) {
  // without the world's key nothing a script writes can be logged, so (as settle() and expireRoles()) the timers don't start
  if (!w.exists || w.state().status !== "ok" || !holdsCustody(w)) return [];
  return withAuthority(w, () => {
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    const now = w.now(), present = presentOf(w).size > 0, ran = [];
    for (const { id, name, v } of allScripts(w.state())) { if (!(typeof v.every === "number" && v.every >= 5)) continue; const rt = rtOf(w, id, name);
      if (rt.next === undefined) { rt.next = now + v.every * 1000; w.presenceDirty = true; continue; }
      if (now < rt.next) continue;
      rt.next = now + v.every * 1000; w.presenceDirty = true;
      if (!present && v.always !== true) { rt.sleepingSince ??= now; rt.status = "asleep"; continue; }
      const slept = rt.sleepingSince !== undefined ? Math.round((now - rt.sleepingSince) / 1000) : null; delete rt.sleepingSince;
      const sp = sponsorOf(w, id, `script:${name}`);
      ran.push(activate(w, id, name, { on: slept !== null ? "wake" : "tick", ...(slept !== null ? { slept } : {}), ...(sp ? { cause: sp.sponsorAt } : {}) }));
    }
    drainAll(w);   // what its scripts wrote sets off others, and a move that let go of a held thing tells that thing's
    return ran;
  });
}
/** TIMED GRANTS end (PROTOCOL §7 Roles): every roles:<id> past its `until` is deleted in one system act `expire-roles {ids}`,
 *  so the end is in the log. The host calls it about once a second; until then the grant stands on the log (reads judge
 *  `until` themselves: access.js listedIn). → the identities whose grant ended. */
export function expireRoles(w) {
  if (!w.exists || w.state().status !== "ok" || !holdsCustody(w)) return [];
  return withAuthority(w, () => {
    const now = w.now(), wc = w.state().entities["@world"]?.c ?? {};
    const ids = Object.keys(wc).filter((k) => k.startsWith("roles:") && Number.isSafeInteger(wc[k]?.until) && wc[k].until <= now).map((k) => k.slice(6));
    if (!ids.length) return [];
    const ops = ids.map((id) => delOp("@world", `roles:${id}`));
    let plan; try { plan = admit(w, w.state(), { actor: "system", cap: { kind: "system", ids: ["@world"], comps: ids.map((id) => `roles:${id}`) } }, ops); }
    catch (x) { if (!(x instanceof Refusal)) throw x; return []; }   // e.g. it would leave the world with no owner: never (owners don't expire)
    changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "expire-roles", body: { ids, why: "timed grants whose until has passed" } }));
    return ids;
  });
}
/** Settle holds a crashed host left: a persisted hold is dropped as `leave` would; a lost in-memory hold under physics (the
 *  thing still lifted out of the engine, a ghost) is settled by a return-held act (cause: the lift) or a return-home.
 *  `present` = identities connected now. → what it settled. */
// Bounded: it runs at world load on the shared thread, so at most ORPHANS.holders holders are settled as leave settles them
// and ORPHANS.lifts lifts returned; holds past that simply end (presence), and what the log still has lifted is settled at
// the next load. The result says how many waited ({deferred}).
export const ORPHANS = { holders: 16, lifts: 64 };
export function settleOrphans(w, present = []) {
  if (!w.exists || w.state().status !== "ok") return [];
  const here = new Set(present); const out = [];
  const holders = [...new Set(Object.values(w.presence.holds ?? {}).map((h) => h?.by))].filter((who) => !here.has(who));
  if (holders.length > ORPHANS.holders) { const late = new Set(holders.slice(ORPHANS.holders));
    for (const [id, h] of Object.entries(w.presence.holds)) if (late.has(h?.by)) delete w.presence.holds[id];
    for (const who of late) delete w.presence.bodies[who];
    out.push({ deferred: late.size, why: `more than ${ORPHANS.holders} holders at once: their holds ended; what the log still has lifted settles at the next load` }); }
  for (const who of holders.slice(0, ORPHANS.holders)) {
    const r = request(w, who, "leave", {}); out.push({ holder: who, left: r.ok, dropped: r.dropped ?? [] });
    // a holder the authority won't take requests from now (banned since): the hold just ends (presence), and what the log
    // lifted is settled below by the authority, as leave's own refusal is
    if (!r.ok) { for (const [id, h] of Object.entries(w.presence.holds)) if (h.by === who) delete w.presence.holds[id]; delete w.presence.bodies[who]; } }
  withAuthority(w, () => {
    // the holds end above (presence is this server's own); what the log lifted is settled by a server that can sign for the
    // world, since this one can't log the settlement
    const st = w.state(); if (!st.entities["@world"]?.c["physics-engine"] || !holdsCustody(w)) return;
    let settled = 0, waiting = 0;
    for (const [id, lift] of orphanLifts(w)) {
      if (w.presence.holds[id] || !st.entities[id] || lostPlace(st, id)) continue;   // a place the record lost stays where it is
      if (settled++ >= ORPHANS.lifts) { waiting++; continue; }
      const g = grabOf(st.entities[id].c);
      if (g?.release === "return" && g.home) { const { plan } = returnPlan(w, w.state(), id, g); if (plan) { returnHome(w, id, plan, lift.seq); out.push({ id, returned: "home" }); continue; } }
      const t = w.state().entities[id].c.transform; if (!t) continue;
      let plan; try { plan = admit(w, w.state(), { actor: "system", cap: { kind: "system", ids: [id], comps: ["transform"] } }, [setOp(id, "transform", t)]); } catch (x) { if (!(x instanceof Refusal)) throw x; continue; }
      changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "return-held", cause: lift.seq, body: { id, holder: lift.by, why: "orphaned: its holder's hold ended without a settlement (the host stopped)" } }));
      out.push({ id, returned: "where the log had it" });
    }
    if (waiting) out.push({ deferred: waiting, why: `more than ${ORPHANS.lifts} lifted things at once: the rest settle at the next load` });
  });
  if (out.length) w.savePresence();
  return out;
}
// ---------- maintenance: a LOAD NEVER WRITES TO THE LOG (docs/MAINTENANCE.md) ----------
// Three recorded system rewrites, run only by the repair command in this order (maintain; `bun tools/protocol/world.ts
// repair <name>` or operator-repair): lift-sockets, rename-components (shaperepair.js RENAMED_*), repair-shapes
// (marker-gated: shapesMarked). The caller keeps the pre-repair log for rollback (server/repairfiles.ts).
// A world needing a step still LOADS, but refuses writes (`repair-needed`) where no reader serves the old shape:
//   lift     un-lifted seats: BLOCKS writes
//   rename   @world trusted, a motion's old type and a station's pose are served; a grabbable's pose or a grip's fingers
//            block although shared/grab.js reads them (SERVED_RENAMES): BLOCKS writes
//   repair   azimuth in degrees reads as radians, an address model reads as "thing": BLOCKS writes
const needsCache = new WeakMap();
const SERVED_RENAMES = (op) => !(op.comp === "grabbable" || op.comp.startsWith("grabbable:"));   // what no reader serves in the old spelling
/** Why the record itself stops a write now, or null: old shapes waiting for the maintenance command (a load never writes).
 *  Reads work either way; a commit-unpurged line doesn't block (§12 reads it unknown). Requests and scripts meet it; the
 *  system's own sweeps don't (they'd hold a timed grant past its until). → {code, reason, fix, extra?} */
export function writeBlock(w) {
  const n = maintenanceNeeds(w);
  // the reader (an agent, a person in the editor) can't run the command, so the fix says who can and that asking again won't
  // help, in plain words (plainRefusal drops a fix with tool syntax); the command is named for whoever runs the host at load
  if (n.blocking.length) return { code: "repair-needed", reason: `this world needs maintenance before it can be written: ${n.blocking.join(", ")} (its values are stored in an old spelling no reader here serves); reads still work`,
    fix: `only whoever runs this server can repair it, on the host by running its maintenance command, bun tools/protocol/world.ts repair ${w.name ?? "<name>"}, or from a server operator's account with operator-repair; asking again won't change that until they do` };
  return null;
}
/** {steps: ["lift-sockets", "rename-components", "repair-shapes"] (needed, in order), blocking: the subset whose old shape no
 *  reader serves, lift: [hosts], rename: [ops], repair: bool, fix}. Cached per log length (only the command, which appends,
 *  removes a needed step). */
export function maintenanceNeeds(w) {
  if (!w.exists || w.state().status !== "ok") return { steps: [], blocking: [], lift: [], rename: [], repair: false };
  const c = needsCache.get(w); if (c && c.n === w.entries.length) return c.v;
  const st = w.state(); const lift = [];
  for (const h of legacyHosts(st, w.everIds())) { if (!st.entities[h]) continue; try { if (liftHostOps(st, w.everIds(), h).ops.length) lift.push(h); } catch { lift.push(h); } }
  // a stored format (a sockets map, a parent/home naming a slot, a body block) is stale and blocks; a host whose CATALOGUE
  // model gained sockets since (modelSeatsDue) is a library update: optional, never blocking, the new seats unseatable until
  // the command runs
  const stored = new Set(storedLegacyHosts(st)); const liftStored = lift.filter((h) => stored.has(h)), liftOptional = lift.filter((h) => !stored.has(h));
  const rename = renameOps(st, PURGED);
  const repair = !shapesMarked(w.entries, (q) => readback(w, q));   // READBACK act:create-world / act:translated: a purged one is marked
  const steps = [...(lift.length ? ["lift-sockets"] : []), ...(rename.length ? ["rename-components"] : []), ...(repair ? ["repair-shapes"] : [])];
  const optional = !liftStored.length && liftOptional.length ? ["lift-sockets"] : [];
  const blocking = steps.filter((s) => (s === "lift-sockets" ? liftStored.length > 0 : s === "rename-components" ? rename.some((o) => !SERVED_RENAMES(o)) : true));
  const words = steps.map((s) => (s === "lift-sockets" && optional.length ? `lift-sockets (optional): ${liftOptional.length} host(s)' models gained sockets; run repair to make them seatable` : s));
  const v = { steps, blocking, optional, lift, liftOptional, rename, repair, fix: steps.length ? `run \`bun tools/protocol/world.ts repair <name>\` (${words.join("; ")}: each recorded as the system's own act, with a backup to roll back), or a server operator's operator-repair {verb: 'repair'}` : null };
  needsCache.set(w, { n: w.entries.length, v }); return v;
}
/** The load. It WRITES NOTHING: it says what the world needs ([{repairNeeded: {steps, blocking, why, fix}}]) or nothing; a world
 *  this server can't sign for is said too. Kept under its old name for its callers. */
export function liftWorld(w) {
  if (!w.exists || w.state().status !== "ok") return [];
  if (w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return [{ skipped: "custody", why: "this server doesn't hold the key that signs this world" }];
  const n = maintenanceNeeds(w); if (!n.steps.length) return [];
  const stale = n.steps.filter((s) => !n.optional.includes(s));
  const why = [stale.length ? `this world holds values in an old spelling (${stale.join(", ")}); loading never rewrites them${n.blocking.length ? `, and no reader serves ${n.blocking.join(", ")}'s old shape, so every write is refused (repair-needed) until the command runs` : " (its readers serve the old spelling: it works as it is)"}` : "",
    n.optional.length ? `lift-sockets (optional): ${n.liftOptional.length} host(s)' models gained sockets since they were stored (a library update); the world stays writable and those seats aren't seatable until repair runs` : ""].filter(Boolean).join(". ");
  return [{ repairNeeded: { steps: n.steps, blocking: n.blocking, optional: n.optional, why, fix: n.fix } }];
}

/** lift-sockets, rename-components, repair-shapes, each a recorded system act (command: "repair", by, operator); what the door
 *  refuses is named in `failed`. → {steps: {lift, rename, repair}, repaired, failed, marked, seq?, dryRun?}; dryRun writes nothing. */
export function maintain(w, { by = null, operator = false, dryRun = false } = {}) {
  if (!w.exists || w.state().status !== "ok") return { refused: { code: "no-world", reason: "the world doesn't fold to a state" } };
  if (w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return { refused: { code: "custody", reason: "this server doesn't hold the key that signs this world" } };
  const prov = { command: "repair", ...(typeof by === "string" && by ? { by } : {}), ...(operator ? { operator: true } : {}) };
  return withAuthority(w, () => { const steps = {};
    // 1. lift-sockets: one host at a time, each on its own
    const lift = { made: [], failed: [] };
    for (const h of legacyHosts(w.state(), w.everIds())) {
      try { const st = w.state(); if (!st.entities[h]) continue;
        const { ops, made, moved } = liftHostOps(st, w.everIds(), h); if (!ops.length) continue;
        const author = (lastSetterOf(w, h, "sockets") ?? lastSetterOf(w, h, "model") ?? creatorOf(w, h))?.rights ?? null;
        const ids = [...new Set(ops.map((o) => o.id))], comps = [...new Set(ops.map((o) => o.comp))];
        const plan = admit(w, st, { actor: "system", cap: { kind: "system", ids, comps }, lifting: true }, ops);
        if (!dryRun) changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "lift-sockets", body: { id: h, made, moved, ...(author ? { capability: { author } } : {}), ...prov } }));
        lift.made.push({ host: h, made, moved });
      } catch (x) { if (!(x instanceof Refusal)) throw x;   // r14 H1 (10-18): a durable-write throw is the caller's ambiguous outcome, never a "refused" host
        lift.failed.push({ host: h, code: x.code, reason: String(x.reason ?? "").slice(0, 300) }); } }
    steps.lift = lift;
    // 2. rename-components: one system act, admitted PER THING
    const rename = { renamed: [], failed: [] };
    try { const all = renameOps(w.state(), PURGED);
      if (all.length) { const st = w.state(); const byId = new Map(); for (const o of all) { if (!byId.has(o.id)) byId.set(o.id, []); byId.get(o.id).push(o); }
        const kept = [];
        for (const [id, ops] of byId) {
          try { admit(w, st, { actor: "system", cap: { kind: "system", ids: [id], comps: [...new Set(ops.map((o) => o.comp))] }, lifting: true }, ops.map(({ renamed: _r, ...o }) => o)); kept.push(...ops); }
          catch (x) { if (!(x instanceof Refusal)) throw x; rename.failed.push({ id, code: x.code, reason: String(x.reason ?? "").slice(0, 300) }); } }
        rename.renamed = [...kept.filter((o) => o.verb === "delete").map((o) => ({ id: o.id, from: o.comp, to: RENAMED_TO(o.id, o.comp) })),
          ...kept.filter((o) => o.renamed).flatMap((o) => o.renamed.map((r) => ({ id: o.id, component: o.comp, ...r })))];
        if (kept.length && !dryRun) { const ids = [...new Set(kept.map((o) => o.id))], comps = [...new Set(kept.map((o) => o.comp))];
          const plan = admit(w, w.state(), { actor: "system", cap: { kind: "system", ids, comps }, lifting: true }, kept.map(({ renamed: _r, ...o }) => o));
          changeEntry(w, plan, w.append({ kind: "act", actor: "system", verb: "rename-components", body: { renamed: rename.renamed, ...(rename.failed.length ? { failed: rename.failed } : {}), ...prov, why: "component names renamed before release (protocol minor 0): the value kept, under its new name" } })); } } }
    catch (x) { if (!(x instanceof Refusal)) throw x;   // as above (repairShapesStep already rethrows)
      rename.failed.push({ id: null, code: x.code, reason: String(x.reason ?? "").slice(0, 300) }); }
    steps.rename = rename;
    // 3. repair-shapes: once per world (the act is the marker)
    const repair = repairShapesStep(w, prov, dryRun); steps.repair = repair;
    needsCache.delete(w);
    return { steps, repaired: repair.repaired ?? [], failed: repair.failed ?? [], ...(repair.marked ? { marked: true } : {}), ...(repair.seq !== undefined ? { seq: repair.seq } : {}), ...(dryRun ? { dryRun: true, ops: repair.ops ?? [] } : {}) };
  });
}
function repairShapesStep(w, prov, dryRun) {
  if (shapesMarked(w.entries, (q) => readback(w, q))) return { marked: true, repaired: [], failed: [] };
  const st = w.state(); const all = shapeRepairOps(st, PURGED, { pathOf: (m) => { try { return CTX.cat.pathOf?.(m) ?? null; } catch { return null; } } });
  const byId = new Map(); for (const o of all) { if (!byId.has(o.id)) byId.set(o.id, []); byId.get(o.id).push(o); }
  const kept = [], failed = [];
  for (const [id, ops] of byId) {
    try { admit(w, st, { actor: "system", cap: { kind: "system", ids: [id], comps: [...new Set(ops.map((o) => o.comp))] }, lifting: true }, ops); kept.push(...ops); }
    catch (x) { if (!(x instanceof Refusal)) throw x; failed.push({ id, code: x.code, reason: String(x.reason ?? "").slice(0, 300) }); } }
  const ids = [...new Set(kept.map((o) => o.id))];
  if (dryRun) return { dryRun: true, repaired: ids, failed, ops: kept.map(({ verb, id, comp }) => ({ verb, id, comp })) };
  const act = { kind: "act", actor: "system", verb: "repair-shapes", body: { v: SHAPES_VERSION, ids, ...(failed.length ? { failed } : {}), ...prov,
    why: "values stored before the shape audit (10-16), in today's spelling with the meaning their readers gave them; once per world; run as a maintenance command, never by a load" } };
  let seq;
  if (kept.length) { const plan = admit(w, w.state(), { actor: "system", cap: { kind: "system", ids, comps: [...new Set(kept.map((o) => o.comp))] }, lifting: true }, kept); seq = w.append(act); changeEntry(w, plan, seq); }
  else seq = w.append(act);
  return { repaired: ids, failed, seq };
}
/** The shape-repair step alone (its older name; the same provenance). Prefer maintain. */
export function repairShapes(w, { by = null, operator = false, dryRun = false } = {}) {
  if (!w.exists || w.state().status !== "ok") return { refused: { code: "no-world", reason: "the world doesn't fold to a state" } };
  if (w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer) return { refused: { code: "custody", reason: "this server doesn't hold the key that signs this world" } };
  const r = withAuthority(w, () => repairShapesStep(w, { command: "repair-shapes", ...(typeof by === "string" && by ? { by } : {}), ...(operator ? { operator: true } : {}) }, dryRun));
  needsCache.delete(w); return r;
}
const RENAMED_TO = (id, comp) => RENAMED_COMPONENTS[id]?.[comp] ?? null;
// Things the log has lifted out of the engine (a grab's lift, a catch) with nothing after that puts them back: no launch,
// and no write that ends the hold (simlayer's ends() and endsUnder()). An epoch cut doesn't end one: a hold outlives it,
// and the new epoch's engine leaves the held thing out, as the replay does.
function orphanLifts(w) {
  const lifted = new Map(), parentOf = new Map();   // parentOf: each thing's parent as the log has it so far
  const under = (k, id) => { for (let p = parentOf.get(k), n = 0; p && n < 33; p = parentOf.get(p), n++) if (p === id) return true; return false; };
  w.entries.forEach((e, seq) => {
    if (!isE(e)) return;
    if (e.kind === "sim" && (e.verb === "lift" || e.verb === "catch") && readback(w, seq)?.id) lifted.set(readback(w, seq).id, { seq, by: e.actor });   // READBACK: a purged lift names nothing to return
    else if (e.kind === "sim" && e.verb === "launch") lifted.delete(readback(w, seq)?.id);
    else if (e.kind === "change") { const ops = opsQuiet(e);
      for (const o of ops) if (o.comp === "parent") parentOf.set(o.id, o.verb === "set" && typeof o.value?.to === "string" ? o.value.to : null);
      // the engine's own lifecycle (simlayer ends() and endsUnder()): a write that moves, re-parents, switches off or removes
      // it (or what it hangs from) ends a hold; an engine, physics or model edit leaves it in the hand
      for (const o of ops) { if (o.verb === "create" || ends(o)) lifted.delete(o.id);
        if (endsUnder(o)) for (const k of [...lifted.keys()]) if (under(k, o.id)) lifted.delete(k); }
      for (const o of ops) if (o.verb === "delete" && o.comp === undefined) parentOf.delete(o.id); }
  });
  return lifted;
}
/** Presence, told by the host: scripts listing `enter` / `leave` hear it, with `by` (live only: the act records no identity,
 *  ANON_EVENTS). The act's cause is the entry that made the script's sponsor (an arrival isn't logged on every path). */
export function presenceEvent(w, kind, who) {
  // a world this server can't sign for: what a script writes can't be logged, so enter and leave scripts don't start (as tick)
  if (!w.exists || w.state().status !== "ok" || !["enter", "leave"].includes(kind) || !isIdentity(who) || !holdsCustody(w)) return [];
  return withAuthority(w, () => {
    w.changedQ = []; w.sayQ = []; w.heldQ = []; const ran = [];
    for (const { id, name, v } of allScripts(w.state())) if (Array.isArray(v.on) && v.on.includes(kind)) { const sp = sponsorOf(w, id, `script:${name}`);
      ran.push(activate(w, id, name, { on: kind, by: who, ...(sp ? { cause: sp.sponsorAt } : {}) })); }
    drainAll(w);   // (as tick)
    return ran;
  });
}
// grab and release: every script whose scope covers the thing and lists the event hears it, once. A grab's cause is its own
// act when logged, else the sponsor's entry; a release (logged) is its act. Fields: by, id, hand, grip? (grab); by, id, how
// (put | drop | throw | stay | return | snap), socket?, to? (release); seq when logged.
const heldEvent = (w, kind, id, ev) => { (w.heldQ ??= []).push({ kind, id, ev }); };
// Everything a write set off, until nothing is left: a hand event's scripts may write (changed:, say), and a changed: script's
// move may let go of a held thing (letGoEdited), a hand event again. So both queues are drained in turn until empty, a few rounds at most.
function drainAll(w) {
  for (let k = 0; k < 8; k++) { drainHeld(w); drainScripts(w); if (!w.heldQ?.length) return; }
  if (w.heldQ) w.heldQ.length = 0;
}
function drainHeld(w) {
  let guard = 0;
  while (w.heldQ?.length && guard++ < 64) { const { kind, id, ev } = w.heldQ.shift(); const st = w.state();
    for (const { id: sid, name, v } of allScripts(st)) {
      if (!(Array.isArray(v.on) && v.on.includes(kind)) || !scopeIds(st, sid, v.scope?.ids).includes(id)) continue;
      const sp = sponsorOf(w, sid, `script:${name}`);
      activate(w, sid, name, { on: kind, id, ...ev, ...(ev.seq !== undefined ? { cause: ev.seq } : sp ? { cause: sp.sponsorAt } : {}) }); } }
  if (w.heldQ) w.heldQ.length = 0;
}
// `changed:<comp>` for a change entry changing <comp> on an id in the script's scope; `say` for a say entry. One activation
// per (script, triggering entry); a script never hears its own.
function drainScripts(w) {
  let guard = 0;
  while ((w.changedQ?.length || w.sayQ?.length) && guard++ < 1000) {
    const st = w.state(); const scripts = allScripts(st);
    if (w.changedQ?.length) { const seq = w.changedQ.shift(); const e = w.entries[seq]; if (!isE(e)) continue;
      const watching = scripts.filter((x) => Array.isArray(x.v.on) && x.v.on.some((o) => o.startsWith("changed:"))); if (!watching.length) continue;
      const changed = opsQuiet(e).filter((o) => o.comp !== undefined);
      for (const { id, name, v } of watching) { if (e.actor === `script:${id}`) continue;
        const ids = scopeIds(st, id, v.scope?.ids); const hit = changed.find((o) => ids.includes(o.id) && v.on.includes(`changed:${o.comp}`));
        if (hit) activate(w, id, name, { on: `changed:${hit.comp}`, id: hit.id, comp: hit.comp, by: (isE(w.entries[e.cause]) ? w.entries[e.cause].actor : null) ?? e.actor, seq, cause: seq }); }
      continue; }
    const seq = w.sayQ.shift(); const e = w.entries[seq]; if (!isE(e) || e.kind !== "say") continue;
    for (const { id, name, v } of scripts) { if (!(Array.isArray(v.on) && v.on.includes("say")) || e.actor === `script:${id}`) continue;
      activate(w, id, name, { on: "say", by: e.actor, text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: e.body.to } : {}), seq, cause: seq }); }
  }
  if (w.changedQ) w.changedQ.length = 0; if (w.sayQ) w.sayQ.length = 0;
}
// The status view (41 §3.4): suspended / paused / stopped / unavailable / dormant (and why, since when) / asleep / active.
// A view, never logged.
/** true, or why not (its own available()). One with no available() runs whatever it's given, as activate runs it, so it counts. */
const sandboxUp = (w) => (typeof w.scripts?.available === "function" ? w.scripts.available() : true);
const SANDBOX_DOWN = "this server's script sandbox didn't load, so no script runs here; only the server's operator can repair it, and asking again won't change it until then";
function scriptStatus(w, st, id, name, v) {
  const key = `script:${name}`, sp = sponsorOf(w, id, key), rt = w.presence.scripts?.[rtKey(id, name)], cfg = scriptsCfg(st);
  let src = null, unreadable = false; try { src = w.getBlob(v.src); } catch (e) { unreadable = e?.code !== "ENOENT"; }
  const base = { id, script: key, src: v.src, sponsor: sp?.sponsor ?? null, sponsorAt: sp?.sponsorAt ?? null, on: v.on ?? [], ...(v.every ? { every: v.every, always: !!v.always } : {}), scope: v.scope,
    ...(src?.text && SR.looksMinified(src.text) ? { note: "the source looks minified: hard to review" } : {}), last: rt?.console?.slice(-3) ?? [] };
  if (!sp) return { ...base, status: "not-installed", why: UNSPONSORED };
  if (sp && isBanned(w, sp.sponsor)) return { ...base, status: "suspended", why: `sponsor ${said(sp.sponsor)} is banned` };
  if (v.paused === true) { const pb = pausedBy(w, id, key);
    return { ...base, status: "paused", why: pb ? `paused by ${said(pb.by)} at seq ${pb.at}` : "paused: true", ...(pb ? { pausedBy: pb.by, pausedAt: pb.at, pausedTs: pb.ts } : {}),
      resume: `set {id: '${id}', component: '${key}', value: {paused: false}, merge: true}` }; }
  if (cfg.run === false) return { ...base, status: "stopped", why: "@world.script-settings.run is false" };
  if (!src) return { ...base, status: "failed", why: sourceWhy(src, unreadable, v.src) };
  if (!w.scripts) return { ...base, status: "unavailable", why: "this server has no script sandbox" };
  // a sandbox here whose runtime didn't load says unavailable to every activation, so its status says so too, as scriptsOf's
  // `sandbox` line does (#260 I59). Its own error stays in the server's log: it names the host's files, and only the operator can mend it
  if (sandboxUp(w) !== true) return { ...base, status: "unavailable", why: SANDBOX_DOWN };
  if (rt?.fails >= cfg.fails && rt.ver === lastTouch(w, id, key)?.seq) return { ...base, status: "paused", why: pausedWhy(rt) };
  const role = roleOf(st, sp?.sponsor); const lost = [];
  for (const x of scopeIds(st, id, v.scope?.ids)) for (const c of v.scope?.comps ?? []) { if (sp?.sponsor && lacks(w, st, sp.sponsor, { verb: "set", id: x, comp: sampleOf(c) }, null, { viaCap: true })) lost.push(`${x}.${c}`); }
  if (lost.length) { const since = lastSetterOf(w, "@world", `roles:${sp.sponsor}`);
    return { ...base, status: "dormant", why: `dormant: sponsor ${said(sp.sponsor)} (${role} now${since ? `, since seq ${since.seq}` : ""}) can no longer change ${lost.join(", ")}`, adopt: `an owner may: adopt {id: '${id}', script: '${name}'}` }; }
  return { ...base, status: rt?.status === "asleep" ? "asleep" : "active" };
}
function scriptsOf(w, st, id) {
  return { scripts: allScripts(st).filter((x) => !id || x.id === id).map((x) => scriptStatus(w, st, x.id, x.name, x.v)),
    ...(id && id !== "@world" ? {} : { imported: importedBehaviours(w, st) }), config: scriptsCfg(st), sandbox: w.scripts ? (sandboxUp(w) === true ? SR.ENGINE : "unavailable") : "none" };
}
/** For a host's own readers (a server's debug panel): what `scripts {id?}` answers, without a request. */
export function scriptsView(w, id) { if (!w.exists || w.state().status !== "ok") return { scripts: [], imported: [] }; return withAuthority(w, () => scriptsOf(w, w.state(), id)); }
// an imported world carries its old bindings as @world imported-behavior:<name> (a record). The authority never runs them.
const IMPORTED_WHY = "an imported behaviour, carried by translation from the world's old log. It doesn't run here: it was written for the old script API (world.emit, world.kv) with its author's rights and no declared scope. Re-install it as script:<name> on the thing it belongs to: rewrite the source for today's script API (docs/SCRIPTS.md), upload {text}, then set script:<name> {src, scope, on}";
function importedBehaviours(w, st) {
  return Object.entries(st.entities["@world"]?.c ?? {}).filter(([k]) => k.startsWith("imported-behavior:")).map(([k, b]) => ({ id: "@world", behavior: k,
    attach: b?.attach ?? null, src: b?.src ?? null, author: b?.author ?? null, status: "needs-reinstall", why: IMPORTED_WHY }));
}
const SCRIPT_VERBS = {
  // ---- scripts (research 41) ----
  // a script's source is a blob (§2.2): stored once by its hash; not world state, so not logged. Hygiene and syntax are checked
  // here (to teach early) and again at install (what binds).
  upload(w, actor, a) {
    if (a.effect !== undefined) return uploadEffect(w, actor, a);
    if (!may(w.state(), actor, "scripts")) refuse("rights", `uploading a script needs the scripts permission; you are ${roleOf(w.state(), actor)}`, "ask the world's owner", { needs: "scripts" });
    if (typeof a.text !== "string") refuse("shape", "upload {text}: the script's JavaScript source", "docs/SCRIPTS.md");
    { const now = w.now(), U = ((w.presence.uploads ??= {})[actor] ??= []).filter((t) => now - t < 60000); w.presence.uploads[actor] = U; // presence: never logged
      if (U.length >= SR.LIMITS.uploads) refuse("rate", `${said(actor)} has uploaded ${U.length} sources in the last minute; at most ${SR.LIMITS.uploads}`, "slow down");
      U.push(now); w.presenceDirty = true; }
    const dirty = SR.hygiene(a.text); if (dirty) refuse(dirty.code, dirty.reason, dirty.fix ?? "refused: reviewers must see what runs");
    const syn = w.scripts?.checkSyntax?.(a.text); if (syn) refuse("syntax", syn.why, "docs/SCRIPTS.md shows the API");
    if (a.dry) return { ok: true, dry: true, note: "it parses and is clean; nothing stored" };
    return { ok: true, src: w.putBlob({ lang: SR.LANG, api: SR.API, text: a.text }), next: "set {id, component: 'script:<name>', value: {src, scope: {ids: 'self', comps: [...]}, on: ['use']}}" };
  },
  // a particle effect document by name (an Essential's, or one stored here): its modules and params. Unlogged; anyone here may
  // read it (it's what every visitor's machine runs)
  effect(w, actor, a) {
    if (typeof a.name !== "string") refuse("shape", "effect {name}: an Essentials name or a stored effect's address (sha256:<64 hex>)", `the Essentials: ${ESSENTIAL_NAMES.join(", ")}`);
    const b = effectBlobName(a.name); let doc = null;
    if (b) { try { doc = w.getBlob(b); } catch { /* below */ } } else doc = effectFor(a.name);
    if (!doc || doc.kind !== EFFECT_KIND) refuse("not-found", `no particle effect ${a.name} here`, `the Essentials: ${ESSENTIAL_NAMES.join(", ")}; upload {effect: {…}} stores one`, b ? undefined : { didYouMean: guess(a.name, ESSENTIAL_NAMES) });
    return { ok: true, name: a.name, effect: doc }; },
  // 41 §3.4: recovery is an explicit, logged adopt: a NEW life of the key (delete + set, one batch), so the adopter becomes its
  // creator and sponsor. §5's key rule decides who may (its creator or an owner); install checks apply with the adopter's
  // rights. `base` (the version inspect gives) makes two racing adopters one winner.
  adopt: (w, actor, a) => commit(w, actor, "adopt", a, (ctx) => { const e = needThing(ctx, a.id); const key = `script:${a.script}`; const v = e.c[key];
    if (!v || typeof v !== "object") refuse("not-found", `${a.id} has no ${key}`, "scripts lists them");
    const lt = lastTouch(w, a.id, key); const base = a.base === undefined ? undefined : versionSeq(w, a.base, "base");
    if (base !== undefined && lt && lt.seq > base) refuse("stale", `${a.id}.${key} changed since version ${base}: ${said(lt.actor)} at ${lt.seq}`, "scripts shows who sponsors it now");
    const was = sponsorOf(w, a.id, key); ctx.actExtra = { adopts: { script: key, was: was?.sponsor ?? null, wasAt: was?.sponsorAt ?? null } }; ctx.refs.add(a.id);
    return [delOp(a.id, key), setOp(a.id, key, v)]; }),
  // the status view (unlogged): every script here, its sponsor and why it does or doesn't run; imported behaviours needing
  // re-install. With {id, script, test: {on, …}}: a dry run: what it WOULD write, refused or not.
  scripts(w, actor, a) { const st = w.state();
    if (a.test !== undefined) {
      if (!may(st, actor, "build")) refuse("rights", "a dry run needs builder (it spends the authority's time)", "");
      if (!a.test || typeof a.test !== "object" || typeof a.test.on !== "string") refuse("shape", "test is an event {on: 'use'|'tick'|'wake'|'say'|'enter'|'leave'|'changed:<comp>', …}", "e.g. scripts {id: 'bell1', script: 'bell', test: {on: 'use', action: 'ring'}}");
      if (!st.entities[a.id]?.c[`script:${a.script}`]) refuse("not-found", `${a.id} has no script:${a.script}`, "scripts lists them");
      const { cause: _c, dry: _d, ...ev } = a.test; // a test event is the event's own fields; never a cause (depth) of its own
      return { ok: true, dry: true, test: activate(w, a.id, a.script, { by: actor, ...ev, dry: true, requester: actor }) }; }
    return { ok: true, ...scriptsOf(w, st, a.id) }; },
};
export { SCRIPT_VERBS, activate, drainAll, drainHeld, drainScripts, heldEvent };
