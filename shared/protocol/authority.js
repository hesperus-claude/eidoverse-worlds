// The authority. Every request is resolved here once; the log receives the request as sent (an `act` entry) and the plain
// results it produced (a `change` entry, `cause` = the act's seq). Replay never runs this file.
// PROTOCOL L7: every state write, from every path (requests, use handlers, undo, put, create-from, rests, the authority's own
// follow-ups), is admitted by ONE function, `admit`, keyed on who asks, which components change (old and new), locks, where
// it lands, sanity and rate. Tool checks may only add to it. The only code that appends a change entry is `changeEntry`, and
// it takes only what `admit` returned. Storage is injected (server/filehost.ts): no node: imports, no process/Date of its own.
import { bodyOf, socketQ, ONE_PLACE } from "../components.js";
import { MOVER, TRACK, bodyBox, bodyScale, floorStep, sweep, tokensAfter } from "../mover.js";
import { checkSockets, checkSocket, checkStation, inOccupyReach, OCCUPY_REACH } from "../sockbody.js";
import { DEFAULT_WHO, grabOf, homeOf, checkGrabbable, wantsHome, fitsSocket, socketRadius, pickGrip, offsetOk, describeGrab } from "../grab.js";
import { fold, opsOf, applyOps, cowState, applyCow, checkIJSON, isEntityId, isComponent, isIdentity, jcs, sha256, PURGED, DIALECT, VERSION, keyOk } from "./fold.js";
import { mintId, PERSON_ID, isPlaceholder } from "./ids.js";
import { COMPONENTS, PENDULUM, defOf, registered, baseOf, isNamespaced, materialize, mapRefs, refsOf, refFields, outOfRange, rangeWords, resolveVersioned, statusOf, canonicalName, STATUSES } from "./componentspec.js";
import { validate, verbHelp, VERBSPEC, RESERVED_VERBS, REMOVED_VERBS } from "./verbspec.js";
import { dec, partSlot } from "./names.js";
import { READ_ONLY } from "./verbclasses.js";
import { isRefusalCode } from "./refusalcodes.js";
import { foldSkyEntry } from "../forecast.js";
import { normalizeCaptionArgs, captionRefusal, foldCaption } from "../captions.js";
import * as C from "./consent.js";
import * as TR from "./sculpt.js";
import * as SR from "./scriptrules.js";
import * as R from "./roles.js";
import { graphemes, cleanText } from "../text.js";
import { mediaTier, tierWords } from "../mediasrc.js";
import { saysOf } from "../says.js";
import { readOut } from "../a11y.js";
import { instanceProblem, effectFor, effectBlobName, effectProblem, EFFECT_KIND, ESSENTIAL_NAMES, isEssential, LEGACY_FIELDS } from "../particle_effects.js";
import { livePoses, digestOf, restEta, ENGINES, carried, worldPose, TICK_MS, offChain, simCutOf } from "./simlayer.js";
import { shapeRepairOps, shapesMarked, SHAPES_VERSION } from "./shaperepair.js";
import { atWrite } from "./assetref.js";
import { eidoHex } from "../eido.js";
import { trustRefusal } from "../drafts.js";
import { planLaunch } from "./launchplan.js";
import { REACH, HAND_Y, MAX_HELD, KICK, SHOVE, BODY_REACH } from "./physconst.js";
import { reachTo, massOf, shoveCap, feetOn, sweptCovers } from "../shove.js";
import { r3, noNeg0, unNegZero } from "./round.js";
import { shapeError, isBoxShape } from "./shapes.js";
import { CTX, UP } from "./authority/ctx.js";
import { SOCKETS_PER_HOST, isLegacyParent, isSocketC, socketRules, actionRules, socketsOf, allSockets, socketPoint, socketRole, liftOps, legacyHosts, liftHostOps, modelSocketNames } from "./authority/sockets.js";
import { Refusal, refuse, said } from "./authority/refuse.js";
import { LAB_CATALOGUE, modelOf, geomOf, boxOfM, geomE, withCatalogue, meshShape } from "./authority/catalogue.js";
export { LAB_CATALOGUE, withCatalogue, MESH_SIZE, meshSize, meshGeom, meshShape } from "./authority/catalogue.js";
import { readback } from "./authority/storage.js";
import { CHANGE, FOLLOW_UP, IMPORTED_ONLY, VOLATILE, clone, createOps, delOp, followUp, followUpsOf, isE, lockedC, nonce16, opsQuiet, qr3, scratch, setOp, versionOf, versionSeq } from "./authority/storage.js";
export { posAt, worldOf, seal, readback } from "./authority/storage.js";
import { NONE, aabb, ancestors, descendants, hits, localFrom, obbs, qYaw, qinv, qmul, qrot, satCost, satDepth, surfacesOf, worldT, yawQ } from "./authority/math.js";
import { SPATIAL, WORK_BUDGET, clockMs, familyOf, groundOf, groundReady, hitsIx, kidsMap, near, spatial, spend, supportBelow, supportUnder } from "./authority/spatial.js";
export { WORK_BUDGET, indexAudit } from "./authority/spatial.js";
import { RANK, RESERVED, backward, banOf, creatorOf, effective, entryBy, inForce, inForceOf, isBanned, isScriptActor, kickOf, lastSetterOf, madeBy, may, modHolder, muteOf, ownersOf, rankOf, roleOf, sanctionsNow, wcOf, whoRank } from "./authority/rights.js";
export { effectiveIn, roleIn, inForceOf, banOf, isBanned, kickOf, muteOf, sanctionsNow, creatorOf, lastSetterOf } from "./authority/rights.js";
import { BODY_VERBS, bodyGate, expireAsks, forgetReaches, inboxPush, shieldOf } from "./authority/bodyconsent.js";
export { reachAdmits, reachLetGo } from "./authority/bodyconsent.js";
import { MOD_VERBS } from "./authority/moderation.js";
import { USE_VERBS, actionsOf, offersFor, pivotOf, reactionCap, toggleOf } from "./authority/use.js";
import { READ_VERBS, buildCreateFrom, buildPublish, buildUpdate, thingSaid } from "./authority/blueprints.js";
import { actIndexOf, buildSculpt, buildSky, buildUndo, buildWeather } from "./authority/undo.js";
export { actIndexFresh, actIndexOf, entityBefore } from "./authority/undo.js";
import { DRY, DUTY, allScripts, budgetOf, dutyLeft, dutyLog, installCheck, logRt, overCpu, particlesCheck, pauseOnly, pausedBy, presentOf, rtKey, rtOf, sampleOf, scopeIds, scriptCeiling, scriptDefaults, scriptDepth, scriptMemo, scriptRights, scriptsCfg, sponsorOf, uploadEffect } from "./authority/scripts.js";
export { DUTY, scriptCeiling, scriptDefaults, setScriptConfig, setScriptDuty, unpaused } from "./authority/scripts.js";
import { SCRIPT_VERBS, activate, drainAll, heldEvent, maintain, maintenanceNeeds, writeBlock } from "./authority/scriptrun.js";
export { ORPHANS, expireRoles, liftWorld, maintain, maintenanceNeeds, presenceEvent, repairShapes, scriptsView, settle, settleOrphans, tick } from "./authority/scriptrun.js";
import { clearOccupant, leftOccupied, occupiedRefuse, occupantOf, occupyRights, setOccupant, occupantOn, vacateAt, vacateWhy, vacatesFor } from "./authority/occupants.js";
import { arrivalBox, body, buildEpoch, dist, gripPoint, gripOf, lawOf, pathBlocked, restampEngine, settleSim, shearFree, sizeOf, solidAt } from "./authority/physics.js";
import { fliesIn, flyingWorld, gripHow, homeScale, launch, recentRests, releasePos, returnDue, returnHome, returnPlan, sameHome, secondGrip, shaped, shoveGate, snapTarget, stampHomes, stampResetHomes, vec3s } from "./authority/manipulate.js";
import { EMBODIED_VERBS } from "./authority/bodyverbs.js";
import { CAPACITY, CAPACITY_CEILING, capacityCheck } from "./authority/capacity.js";
export { CAPACITY, CAPACITY_CEILING } from "./authority/capacity.js";
import { isLookAt, isNum, nearMiss, restCheck, unknownKeys, valueCheck } from "./authority/checks.js";
export { schemaRefusal } from "./authority/checks.js";
import { Admitted, REPAIR_COMP, SAY_MAX, admit, lacks, lockCheck, needWords, rateCheck, spokenOf } from "./authority/gate.js";
export { keyKind, seniorOwnerOf } from "./authority/gate.js";
import { clearRefsTo, danglingRefs, historyDiff, holdsRefs, lastTouch, opsTouching, stampMedia, stampModelHash, stampShapes, stripDry, touched, touchedOf, warnOrNot, warnings, withoutRefs } from "./authority/followups.js";
export { TOUCH_HORIZON } from "./authority/followups.js";
import { actEntry, actOf, boundsOf, buildCreate, buildDelete, buildPlace, buildSet, buildTurn, changeEntry, changeShape, commit, letGoEdited, mint, needThing, notAThing, offRefuse, outsideWorld, resolve, serverWritten } from "./authority/writes.js";
import { BATCH_VERBS, FOUNDING_VERBS, SAY_VERBS, SCHEMA_VERBS, WRITE_VERBS } from "./authority/verbs.js";


// A request as sent must itself be I-JSON (it is logged as the act). -0 is normalised; non-finite is refused.
function wire(args) {
  const walk = (v) => { if (typeof v === "number" && !Number.isFinite(v)) refuse("shape", `numbers must be finite, got ${v}`, "I-JSON: finite numbers only");
    if (v && typeof v === "object") Object.values(v).forEach(walk); };
  walk(args); const out = JSON.parse(JSON.stringify(args ?? {}));
  try { checkIJSON(out); } catch (x) { refuse("shape", `the request isn't I-JSON (${x.code})`, "RFC 7493: UTF-8, no duplicate keys, finite numbers, integers within 2^53"); }
  return out;
}

// the authority's per-call state (CTX, authority/ctx.js) and the world's per-call queues and clock: ONE save/restore for every
// entry point, so a nested call never resets the outer call's. `actor` is the asker, null for the authority's own work.
function enter(w, actor) {
  const outer = { ...CTX }, wq = { changedQ: w.changedQ, sayQ: w.sayQ, heldQ: w.heldQ, now: w.now, pinTs: w.pinTs };
  CTX.cat = w.catalogue ?? LAB_CATALOGUE; CTX.through = false; CTX.nameOf = w.nameOf ?? null; CTX.mintW = w; CTX.work = { left: WORK_BUDGET.units, until: clockMs() + WORK_BUDGET.ms, k: 0 };
  CTX.isAnon = (id) => w.kindOf?.(id) === "anon"; CTX.knownId = (id) => (actor != null && id === actor) || !w.kindOf || w.kindOf(id) != null;   // the asker is known (a founder names themself)
  return () => { Object.assign(CTX, outer); w.changedQ = wq.changedQ; w.sayQ = wq.sayQ; w.heldQ = wq.heldQ; w.now = wq.now; w.pinTs = wq.pinTs; };
}
export function request(w, actor, verb, args = {}) {
  const exit = enter(w, actor);
  // ONE clock per request (§2.1: ts is the admission time): a wall clock read twice could put a rest's digest under a later
  // ts, across a tick boundary, and every carrier re-folding the log would call the authority's own digest wrong
  const clock = w.now; const t0 = clock(); w.now = () => t0;
  try {
    if (!isIdentity(actor) || RESERVED.has(actor)) refuse("identity", `'${actor}' isn't an identity the authority can stamp`, "identities are a–z, 0–9 and '-', up to 64 (§3.1); system, sim and world are the authority's own");
    const h = Object.hasOwn(VERBS, verb) ? VERBS[verb] : undefined;   // never a prototype key (`constructor`, `__proto__`)
    if (h && !w.exists && !["create-world", "help"].includes(verb)) refuse("no-world", `there is no world called '${w.name}' yet`, `create-world {title: '…'} founds it (you become its owner); or pick a world that exists`);
    // §2.4: chain points are signed by the key genesis names (or the latest handoff); an authority holding another key would
    // write lines its own verifier calls forged (a moved dir, a lost or swapped custody file): it refuses instead (R5)
    if (h && w.exists && w.custody()?.sign && w.custody().sequencer() !== w.entries[0]?.body?.sequencer && !READ_ONLY.has(verb))
      refuse("custody", "this server doesn't hold the key that signs this world's log, so it can't write to it", "only this server's operator can fix this, by restoring the world's signing key or handing the world over to this server; asking again won't change it, and reads still work");
    if (h && w.exists && w.state().status !== "ok") refuse("unreadable", `this world's log can't be read here ('${w.state().status}': ${w.state().status === "unknown-version" ? "it's written in a protocol version this server doesn't read" : "its first entry isn't a genesis this server can read"}), and the authority won't act on a log it can't read`, "only this server's operator can fix this, by repairing the log or serving it with a server that reads its version; asking again won't change it until then");
    // writes the record itself stops (writeBlock: an altered log, a world awaiting its maintenance command): every write but
    // `leave` and the operator's own; the scripts the host sets off meet the same gate (scriptrun activate)
    if (h && w.exists && !READ_ONLY.has(verb) && verb !== "leave" && CTX.operator !== actor) { const b = writeBlock(w); if (b) refuse(b.code, b.reason, b.fix, b.extra); }
    if (!h && Object.hasOwn(REMOVED_VERBS, verb)) refuse("removed", `'${verb}' was removed: ${REMOVED_VERBS[verb].why}`, REMOVED_VERBS[verb].fix);
    if (!h && Object.hasOwn(RESERVED_VERBS, verb)) refuse("reserved", `'${verb}' is a reserved request: ${RESERVED_VERBS[verb].why}`, "help lists every verb");
    if (!h) refuse("unknown-verb", `there is no '${verb}'`, "help lists every verb", { didYouMean: guess(verb, Object.keys(VERBS)) });
    // `leave` passes: it settles their own presence (else a kicked body and what it held are never released). An operator's
    // recorded repair (operatorRepair) is not the person's own request: their sanctions and role here don't gate it
    if (w.exists && verb !== "help" && verb !== "leave" && CTX.operator !== actor && isBanned(w, actor)) refuse("banned", `${said(actor)} is banned from this world`, "the moderator log says so; ask a moderator");
    if (w.exists && verb !== "help" && verb !== "leave" && CTX.operator !== actor && kickOf(w, actor)) refuse("kicked", `${said(actor)} was removed from this world and may come back in ${Math.ceil((kickOf(w, actor).until - w.now()) / 60000)} min`, "wait; the moderator log says who and why");
    w.changedQ = []; w.sayQ = []; w.heldQ = [];
    // the authority's own follow-ups (rests, returns) are its duty, never the asker's budget: the budget starts after them.
    // They are bounded by the engine (settleSim takes at most 64 rests a request) and by the returns that are due
    if (h && w.exists) { CTX.work = { left: Infinity, until: Infinity, k: 0 }; restampEngine(w); settleSim(w); returnDue(w); expireAsks(w); CTX.work = { left: WORK_BUDGET.units, until: clockMs() + WORK_BUDGET.ms, k: 0 }; }
    args = wire(args);
    const minted = h && w.exists ? placeholders(w, verb, args) : null; if (minted) args = minted.args;
    // throughLock (§5) and expect (§3a, the values a gesture started from) are flags on any request: checked here, before
    // anything is built; admit reads throughLock
    const { throughLock, expect, ...plain } = args;
    if (throughLock !== undefined && typeof throughLock !== "boolean") refuse("shape", `throughLock is true or false, got ${JSON.stringify(throughLock)}`, "send throughLock: true to act through a lock you may remove");
    CTX.through = throughLock === true;
    const bad = validate(verb, plain); if (bad) { const { code, reason, fix, ...rest } = bad; refuse(code, reason, fix, rest); }
    if (expect !== undefined) expectCheck(w, expect);
    if (verb === "create" && args.place) { const b2 = validate("place", { ...args.place, id: "x" }); if (b2) { const { code, reason, fix, ...rest } = b2; refuse(code, `place: ${reason}`, fix, rest); } }
    const r = h(w, actor, args);
    if (minted && r && (r.ok || r.dry)) r.ids = minted.ids;   // each placeholder and the id it became (never logged: the act holds the ids)
    // grab / release: scripts whose scope covers the thing hear who took it and how it was let go; then what the request's own
    // entries trigger (changed:<comp>, say), each its own activation, in turn until neither is left
    drainAll(w);
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; }
    if (r && r.refused && !r.refused.fix) r.refused.fix = verbHelp(verb) ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb";
    if (r && r.refused) noteCode(r.refused.code);
    return r;
  } catch (e) {
    if (w.presenceDirty) { w.savePresence(); w.presenceDirty = false; } // a refusal still updates the authority's own ring and throttle (presence, unlogged)
    if (e instanceof Refusal) { noteCode(e.code); if (!UNLOGGED_REFUSALS.has(e)) logRefusal(w, actor, verb, args, e.code); const { code, reason, fix, ...rest } = e; return { ok: false, refused: { code, reason, fix: fix || (Object.hasOwn(VERBSPEC, verb) ? `help {verb: '${verb}'} shows its arguments with examples` : "help lists every verb"), ...pick(rest) } }; }
    throw e;
  } finally { exit(); }
}
// The refusal-code registry (refusalcodes.js): a code is one-way (written into signed entries), so every code a reply carries
// must be registered. One the registry lacks is noted here (never refused: the asker gets the refusal as given) and
// scars-check G1 fails on any it met.
const UNSEEN_CODES = new Set();
const noteCode = (c) => { if (!isRefusalCode(c)) UNSEEN_CODES.add(String(c)); };
/** Tests read it; empty when the registry is whole. */
export function unregisteredCodes() { return [...UNSEEN_CODES]; }
// ---- ids: writers never choose them ----
// The authority mints every id (shared/protocol/ids.js); a writer naming a thing it is making uses a request-local placeholder
// ('$table', JSON:API's lid), minted and substituted before checks and mapped in the reply, never logged. A chosen id on a
// create is refused; forkCopy and fixtureIds() keep ids (tools/protocol/ids-check.ts keeps runtime off the latter).
let FIXTURE_IDS = false;
/** Tests' fixtures seed known ids as a fork's copy does (in-process only; never called by a runtime file). */
export function fixtureIds(on = true) { FIXTURE_IDS = !!on; }
const UNLOGGED_REFUSALS = new WeakSet();   // a refusal of the placeholder pass names placeholders: the attempt isn't recorded
// keys whose string value names a thing, and keys whose list does: an undefined placeholder there is refused by name
const REF_KEYS = new Set(["id", "to", "on", "beside", "hang", "against", "near", "from", "target", "copy", "facing", "attach"]);
const REF_LISTS = new Set(["targets", "marks", "ids", "refs"]);
function placeholders(w, verb, args) {
  const creates = verb === "create" ? [[null, args]]
    : (verb === "batch" || verb === "fork-copy") && Array.isArray(args?.ops) ? args.ops.map((o, i) => [i, o && o.verb === "create" && o.args && typeof o.args === "object" ? o.args : null]).filter(([, a]) => a) : [];
  const at = (i) => (i === null ? "" : `batch op ${i}: `);
  const no = (reason, fix) => { try { refuse("shape", reason, fix); } catch (e) { UNLOGGED_REFUSALS.add(e); throw e; } };
  const keep = CTX.forking || FIXTURE_IDS; const ids = {};
  const anyPh = creates.some(([, a]) => isPlaceholder(a.id));   // placeholders never reach the log, so neither does this refusal
  for (const [i, a] of creates) { if (a.id === undefined || a.id === null) continue;
    if (isPlaceholder(a.id)) { if (a.id in ids) no(`${at(i)}the placeholder '${a.id}' is defined twice in one request`, `each placeholder names one new thing: give the other create its own ('${a.id}-2'), and refer to either by its name elsewhere in the request`); ids[a.id] = null; continue; }
    if (!keep) { const word = String(a.id).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^[-_]+/, "").slice(0, 40) || "name";
      (anyPh ? no : (r, f) => refuse("shape", r, f))( `${at(i)}a thing's id isn't chosen by the writer: the authority mints it (an id never changes, so it carries no word; what a thing is called is its label)`, `leave id out (the reply's refs name the id it gets), or write '$${word}' as a placeholder: refs to '$${word}' in the same request resolve, and the reply's ids map gives the id it became`); } }
  const st = w.state(); const ever = w.everIds?.() ?? new Set(); const fresh = new Set();
  for (const k of Object.keys(ids)) { let id; do id = mintId(); while (st.entities[id] || ever.has(id) || fresh.has(id)); fresh.add(id); ids[k] = id; }
  const sub = (v, key) => {
    if (typeof v === "string") { if (v in ids && isPlaceholder(v)) return ids[v];
      if (isPlaceholder(v) && REF_KEYS.has(key)) no(`'${v}' isn't defined in this request`, `a placeholder names a thing a create in the same request makes (create {id: '${v}', …}); a thing already here goes by its id (look lists them)`);
      return v; }
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && REF_LISTS.has(key) ? sub(x, "id") : sub(x, key)));
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = sub(x, k); return o; }
    return v; };
  const out = sub(args, null);
  return Object.keys(ids).length ? { args: out, ids } : null;
}

// R7: a refused write is recorded as {args, refused: {code}} within the byte budget, keeping only the verb, the argument NAMES
// it takes and the code, never a value (else anyone could write text into a permanent record); values go to the in-memory
// refusalRing. Never logged: reads, dry runs, and refusals that ARE the budget or a sanction (UNLOGGED).
const UNLOGGED = new Set(["rate", "identity", "no-world", "custody", "unreadable", "banned", "kicked", "muted"]);
const UNIVERSAL_ARGS = new Set(["dry", "throughLock", "expect"]);   // flags any request may carry (§3a, §5)
const PRESENCE_VERBS = new Set(["move", "body", "reach", "consent", "inbox", "wait", "leave"]);   // a refusal of these is never logged
const REFUSAL_RING = 200, RING_VALUE_BYTES = 2048;
/** The verb's own (VERBSPEC), sorted; the rest only counted. */
function argNames(verb, args) {
  const keys = args && typeof args === "object" && !Array.isArray(args) ? Object.keys(args) : [];
  const spec = Object.hasOwn(VERBSPEC, verb) ? VERBSPEC[verb] : null;
  const known = spec ? keys.filter((k) => k in spec.args || UNIVERSAL_ARGS.has(k)) : [];
  return { known: known.sort(), unknown: keys.length - known.length };
}
/** Refused requests WITH their values (what someone typed): diagnosis, never history. Not persisted (a reopened world starts
 *  empty), never written to the log. Newest last. */
export function refusalRing(w) { return (w.refusals ?? []).slice(); }
function ringRefusal(w, actor, verb, args, code) {
  let v; try { v = jcs(stripDry(args ?? {})); } catch { v = "(not I-JSON)"; }
  const rec = { ts: Math.floor(w.now()), actor, verb: String(verb).slice(0, 64), code, args: v.length > RING_VALUE_BYTES ? `${v.slice(0, RING_VALUE_BYTES)}… (${v.length} bytes)` : v };
  const ring = (w.refusals ??= []);
  ring.push(rec); if (ring.length > REFUSAL_RING) ring.splice(0, ring.length - REFUSAL_RING);
}
function logRefusal(w, actor, verb, args, code) {
  try {
    if (w.exists) ringRefusal(w, actor, verb, args, code);
    // a verb the authority doesn't have is recorded too (an agent's invented verb is part of what it tried), when it's a name
    if (!w.exists || !(Object.hasOwn(VERBS, verb) || /^[a-z][a-z0-9-]{0,31}$/.test(String(verb))) || READ_ONLY.has(verb) || args?.dry === true || !isIdentity(actor) || RESERVED.has(actor)) return;
    // a body's track is presence: a refused move (a step, an arrival or a teleport) is never recorded (a client answers a
    // refused step with a teleport several times a second: a permanent, broadcast refusal every few seconds). An ACCEPTED
    // teleport is an act.
    if (verb === "move") return;
    // …and so is everything else a body does or says about itself: a refused touch, pose or reach, a refused consent write, an
    // inbox or wait. Consent is presence, never appended: "A tried to touch B, was refused, kept trying" written into a signed,
    // forkable log is exactly what consent.js promises never happens
    if (PRESENCE_VERBS.has(verb)) return;
    if (code === "rate") { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; } // an attempt all the same: counted, not written
    // a refused contact push is a walk that met something, not a request anyone made in words: counted, not written (`shove:
    // true` is its old spelling)
    if (verb === "punt" && (args?.contact === true || args?.shove === true)) { const m = (w.unrecorded ??= new Map()); m.set(actor, (m.get(actor) ?? 0) + 1); return; }
    if (UNLOGGED.has(code)) return;
    const names = argNames(verb, args);
    const body = { args: names.known, refused: { code } }; if (names.unknown) body.unknownArgs = names.unknown;
    // an unknown verb is recorded as `unknown-verb`: its name is the visitor's text, so it goes to the ring only, as argument
    // values do
    const asVerb = Object.hasOwn(VERBS, verb) || Object.hasOwn(RESERVED_VERBS, verb) || Object.hasOwn(REMOVED_VERBS, verb) ? verb : "unknown-verb";
    const miss = (w.unrecorded ??= new Map()); const n = miss.get(actor) ?? 0; if (n) body.unrecorded = n;
    try { rateCheck(w, actor, "act", jcs(body).length + 256); } catch (x) { if (x instanceof Refusal) { miss.set(actor, n + 1); return; } throw x; }
    w.append(actEntry(w, actor, asVerb, body)); miss.delete(actor);
  } catch { /* logging a refusal never fails the request it records */ }
}
const pick = (o) => Object.fromEntries(Object.entries(o).filter(([k]) => !["message", "stack"].includes(k)));
// §3a: expect is a list of {id, component, value?}: the component must hold exactly that value now (JCS), or be absent; else
// `changed`, naming who, and nothing is written. Authority practice; the fold never reads it.
function expectCheck(w, list) {
  if (!Array.isArray(list) || !list.length || list.length > 256) refuse("shape", "expect is a list of {id, component, value?} (1–256 of them)", "e.g. expect: [{id: 'lamp-1', component: 'transform', value: {pos, q, scale}}]");
  const st = w.state();
  for (const x of list) {
    if (!x || typeof x !== "object" || Array.isArray(x) || typeof x.id !== "string" || typeof x.component !== "string" || Object.keys(x).some((k) => !["id", "component", "value"].includes(k)))
      refuse("shape", `expect entries are {id, component, value?}, got ${JSON.stringify(x)?.slice(0, 80)}`, "leave value out to expect the component to be absent");
    const e = st.entities[x.id]; const has = !!e && x.component in e.c; const cur = has ? e.c[x.component] : undefined;
    const same = "value" in x ? has && cur !== PURGED && jcs(cur) === jcs(x.value) : !has;
    if (same) continue;
    const lt = lastTouch(w, x.id, x.component);
    const why = !e ? `${x.id} is gone` : lt ? `${said(lt.actor)} changed it at ${lt.seq}` : "it isn't what you started from";
    // say THAT it changed, never WHAT it is now: expect runs before the rights checks and a dry request is never logged, so an
    // echoed value would leak any component without a trace
    refuse("changed", `${x.id}.${x.component} changed since you started: ${why}`, "look again and redo it (nothing was written); or send it without expect to overwrite what's there",
      { id: x.id, component: x.component, ...(lt ? { by: lt.actor, at: lt.seq } : {}) });
  }
}
// a guess reads at most GUESS_MAX characters: no verb, id or component name is longer, and edit distance grows with input
// times options (a long unknown name against a world's ids took seconds)
const GUESS_MAX = 80;
function guess(s, opts) {
  s = String(s).slice(0, GUESS_MAX);
  const d = (a, b) => { let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) { const row = [i]; for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j-1] + 1, prev[j-1] + (a[i-1] === b[j-1] ? 0 : 1)); prev = row; } return prev[b.length]; };
  const toks = (x) => String(x).toLowerCase().split(/[-_\s/:]+/).filter(Boolean);
  const share = (o) => { const a = toks(s), b = toks(o); return a.filter((t) => b.some((u) => u.startsWith(t) || t.startsWith(u))).length; };
  return opts.map((o) => [o, d(String(s), o) - 2 * share(o)]).sort((a, b) => a[1] - b[1]).filter(([o, n]) => n <= 3 || share(o) >= Math.max(1, toks(s).length - 1)).slice(0, 3).map(([o]) => o);
}

// ---------- the verb table's bodies: authority/verbs.js ----------
const VERBS = {
  ...EMBODIED_VERBS,
  ...BODY_VERBS,
  ...FOUNDING_VERBS,
  ...READ_VERBS,
  ...SCHEMA_VERBS,
  ...WRITE_VERBS,
  ...USE_VERBS,
  ...MOD_VERBS,
  ...SAY_VERBS,
  ...SCRIPT_VERBS,
  ...BATCH_VERBS,
};
/** Every verb the authority answers (VERBSPEC must have a row for each: scars-check's verb-row check). */
export const VERB_NAMES = Object.freeze(Object.keys(VERBS));
/** The fork's copy acts (server/worldlog.ts copyInto): the batch request, logged as verb fork-copy. */
export function forkCopy(w, actor, args) { CTX.forking = true; try { return request(w, actor, "fork-copy", args); } finally { CTX.forking = false; } }
/** A server operator's recorded repair. NARROW: set / delete of @world's door components (roles:<id>, access, default-role,
 *  role-defs), unban, and the maintenance command (repair / repair-shapes → maintain); everything else is refused before the
 *  authority is entered. RECORDED as the operator's own act (`operator: true`); shape, value, roles and last-owner checks
 *  still apply. Server-only. */
export function operatorRepair(w, actor, verb, args = {}) {
  const door = (verb === "set" || verb === "delete") && args && args.id === "@world" && REPAIR_COMP(args.component);
  // the shape repair is a maintenance command, never the load's; an operator runs it here, recorded with the operator's id
  // (the act's `by`, operator: true). Not a request word: it has no verb at the door
  if (verb === "repair" || verb === "repair-shapes") { const r = maintain(w, { by: actor, operator: true, dryRun: args?.dryRun === true });
    return r.refused ? { ok: false, refused: r.refused } : { ok: true, ...r }; }
  if (!(door || verb === "unban"))
    return { ok: false, refused: { code: "rights", reason: `an operator's repair covers @world's roles, access, default-role and role-defs (set, delete), lifting a ban or kick (unban) and the maintenance command (repair: lift-sockets, rename-components, repair-shapes); not ${String(verb).slice(0, 32)}${args?.component !== undefined ? ` ${String(args.component).slice(0, 64)}` : ""}`,
      fix: "anything else goes through the world's own roles: repair a role (set {id: '@world', component: 'roles:<id>', value: {role: 'owner'}}), then act as that person" } };
  CTX.operator = actor; try { return request(w, actor, verb, args); } finally { CTX.operator = false; }
}
// the leaves reach the layers above them through UP (authority/ctx.js): bound here, once every module has loaded
Object.assign(UP, { actEntry, actOf, activate, admit, body, boundsOf, changeEntry, changeShape, commit, danglingRefs, dist, enter, guess, gripPoint, historyDiff, holdsRefs, homeScale, isNum, lacks, lastTouch, letGoEdited, lockCheck, mint, nearMiss, needThing, needWords, notAThing, offRefuse, opsTouching, outsideWorld, rateCheck, request, resolve, restampEngine, returnDue, returnHome, returnPlan, sameHome, occupantOf, occupyRights, serverWritten, setOccupant, settleSim, occupantOn, touchedOf, unknownKeys, vec3s, warnings, withoutRefs });
