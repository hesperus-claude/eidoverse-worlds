// shared/protocol/authority/scripts.js — scripts, the standing half: settings, rights and install checks, particles and
// effect uploads, the console ring, sponsors and pauses, the per-state memo, and the budgets (rate, duty, CPU). The
// running half is authority/scriptrun.js.
import { isEntityId, isComponent, jcs, utf8Len, PURGED } from "../fold.js";
import { COMPONENTS, registered, baseOf } from "../componentspec.js";
import * as SR from "../scriptrules.js";
import { instanceProblem, effectFor, effectBlobName, effectProblem, EFFECT_KIND, ESSENTIAL_NAMES, isEssential } from "../../particle_effects.js";
import { UP } from "./ctx.js";
import { refuse, said } from "./refuse.js";
import { VOLATILE, followUpsOf, isE, opsQuiet } from "./storage.js";
import { descendants } from "./math.js";
import { backward, creatorOf, entryBy, isScriptActor, may, roleOf } from "./rights.js";
import * as Roles from "../roles.js";
// layers above this one (a leaf may not import them), through UP (ctx.js)
const guess = (...a) => UP.guess(...a);
const lacks = (...a) => UP.lacks(...a);
const nearMiss = (...a) => UP.nearMiss(...a);
const needWords = (...a) => UP.needWords(...a);

// ---------- behaviours (L4, L7; research 41) ----------
// A script is a keyed component `script:<name>` naming a source blob and a SCOPE. Its sponsor is whose rights admitted
// the LATEST write to the key in its current life (§5 "Two views"), a view, never stored. Each activation is a fresh
// admission with the sponsor's rights NOW, narrowed to the scope; the triggering visitor adds nothing. A change is ONE
// act plus ONE all-or-nothing batch caused by it, plus its says; replay never runs code. No-op writes are dropped (SR.elide).
// Owners set run, max, budget, cpu (@world.script-settings), never above scriptCeiling(); rate, depth, fails, runs are the server's.
const SCRIPTS = { max: 12, budget: 600, rate: 6, depth: 8, fails: 5, run: true, cpu: SR.LIMITS.cpu, runs: SR.LIMITS.runs };
const OWNER_SCRIPT_FIELDS = ["run", "max", "budget", "cpu"];
/** And the most an owner may set (live: an operator may change SCRIPTS). */
export const scriptDefaults = () => Object.fromEntries(OWNER_SCRIPT_FIELDS.map((k) => [k, SCRIPTS[k]]));
export const scriptCeiling = () => ({ max: 64, budget: SCRIPTS.budget, cpu: SCRIPTS.cpu });
/** An operator's (and a test's); returns what it was, to restore. Never a world's. */
export function setScriptConfig(over = {}) { const was = { ...SCRIPTS }; Object.assign(SCRIPTS, over); return was; }
// what the owner wrote in @world.script-settings ({} when nothing, or not an object)
const ownScriptSettings = (st) => { const c = st.entities["@world"]?.c["script-settings"]; return c && typeof c === "object" && !Array.isArray(c) && c !== PURGED ? c : {}; };
const scriptsCfg = (st) => { const own = ownScriptSettings(st);
  const out = { ...SCRIPTS }; for (const k of OWNER_SCRIPT_FIELDS) if (own[k] !== undefined) out[k] = own[k];
  // above this server's ceiling is lowered to it; if the owner's, `capped` keeps what they asked for, so a refusal can say so
  for (const [k, top] of Object.entries(scriptCeiling())) if (Number.isFinite(out[k]) && out[k] > top) { if (own[k] !== undefined) (out.capped ??= {})[k] = out[k]; out[k] = top; }
  return out; };
// whose limit it is, for a refusal: this server's ceiling when it lowered the owner's value (`capped`), the owner's when
// it stands, else this server's own (the owner may lower, not raise)
const limitWhose = (st, cfg, k) => (cfg.capped?.[k] !== undefined ? `this server's ceiling: the owner's @world.script-settings.${k} asks ${cfg.capped[k]}, and this server caps it`
  : ownScriptSettings(st)[k] !== undefined ? `which the world's owner sets in @world.script-settings.${k}`
  : `this server's limit, which the world's owner may lower in @world.script-settings.${k} but not raise`);
// the registry's lists (componentspec script.itemEnums), read here, never restated
const BODY_EFFECTS = COMPONENTS.script.itemEnums["scope.bodies"];
const SCRIPT_EVENTS = COMPONENTS.script.itemEnums.on.filter((e) => !e.endsWith(":*"));
const scopeIds = (st, id, ids) => (ids === "self" ? [id] : ids === "subtree" ? [id, ...descendants(st, id)] : Array.isArray(ids) ? ids.map((x) => (x === "self" ? id : x)) : []);
const inComps = (comps, c) => typeof c === "string" && comps.some((p) => p === c || (p.endsWith(":*") && c.startsWith(p.slice(0, -1))));
const sampleOf = (p) => (p.endsWith(":*") ? p.slice(0, -1) + "x" : p);
function scriptRights(w, st, cap, op, at, made) {
  if (op.verb === "create") { if (!cap.create) refuse("scope", `${cap.key} doesn't declare create: true`, "its scope is data: what it may touch is fixed at install"); (cap.made ??= new Set()).add(op.id); }
  else { const mine = cap.ids.includes(op.id) || cap.made?.has(op.id);
    if (!mine || (op.comp !== undefined && !inComps(cap.comps, op.comp)) || (op.comp === undefined && !cap.made?.has(op.id)))
      refuse("scope", `${cap.key} on ${cap.id} may change only ${cap.comps.join("/") || "nothing"} of ${cap.ids.join(", ") || "nothing"}, not ${op.verb} ${at}`, "a script acts only inside the scope it declared at install"); }
  const r = roleOf(st, cap.sponsor); const need = lacks(w, st, cap.sponsor, op, new Set([...(made ?? []), ...(cap.made ?? [])]), { viaCap: true });
  if (need) refuse("rights", `${cap.key}'s sponsor ${said(cap.sponsor)} can't change ${at} any more (${r} now; it needs ${needWords(need)})`, "dormant: a behaviour has its sponsor's rights now, never more (§8). An owner may adopt it: adopt {id, script}");
}
// at install, by whoever's rights carry the write: the install rank, a scope within those rights NOW (no promotion by
// proxy), a clean parsing source, the timer floor, `always` only by an owner, the world's script count.
// particles: an effect's params must be ones it declares, within bounds and EFFECT_LIMITS; the old bag is read, never written
function particlesCheck(w, op) {
  const one = (v, at) => { if (!v || typeof v !== "object" || Array.isArray(v)) return;
    const b = isEssential(v.effect) ? null : effectBlobName(v.effect); let doc = null;   // an Essential's address is its own document, not this world's blob
    if (b) { try { doc = w.getBlob(b); } catch { /* not stored here: said below */ }
      if (doc && (doc.kind !== EFFECT_KIND || effectProblem(doc))) refuse("shape", `${at}.effect: ${b} isn't a particle effect this protocol runs (${doc.kind !== EFFECT_KIND ? "not a particle-effect document" : effectProblem(doc)})`, "upload {effect: {kind: 'particle-effect', v: 1, emitters: [...]}} stores one and says why it can't"); }
    else doc = effectFor(v.effect);
    const bad = instanceProblem(v, doc);
    if (bad) refuse(b && !doc ? "not-found" : /^params\.[\w-]+ is (a number|\[x, y, z\])/.test(bad) || /out of bounds/.test(bad) ? "bounds" : "shape", `${at}: ${bad}`, `PROTOCOL §4 (effects are documents): {effect: '${ESSENTIAL_NAMES[0]}'} or an uploaded effect's address; schema {component: 'particles'} lists the Essentials and their params`,
      b && !doc ? undefined : { didYouMean: typeof v.effect === "string" && !b ? guess(v.effect, ESSENTIAL_NAMES) : [] }); };
  if (baseOf(op.comp) === "particles") one(op.value, `${op.id}.${op.comp}`);
  if (baseOf(op.comp) === "grabbable" && op.value?.fx?.particles) one(op.value.fx.particles, `${op.id}.${op.comp}.fx.particles`);
}
// upload {effect}: stored by content (a blob, §9: not world state, so not logged), checked whole first (effectProblem).
// Building rights: naming it in a particles value is the write that's logged.
function uploadEffect(w, actor, a) {
  if (!may(w.state(), actor, "build")) refuse("rights", `storing a particle effect needs build; you are ${roleOf(w.state(), actor)}`, "ask the world's owner", { needs: "build" });
  { const now = w.now(), U = ((w.presence.uploads ??= {})[actor] ??= []).filter((t) => now - t < 60000); w.presence.uploads[actor] = U; // presence: never logged
    if (U.length >= SR.LIMITS.uploads) refuse("rate", `${said(actor)} has uploaded ${U.length} documents in the last minute; at most ${SR.LIMITS.uploads}`, "slow down");
    U.push(now); w.presenceDirty = true; }
  const bad = effectProblem(a.effect);
  if (bad) refuse(/ is reserved: not built yet/.test(bad) ? "reserved" : "shape", `effect: ${bad}`, "PROTOCOL §4 (effects are documents): {kind: 'particle-effect', v: 1, emitters: [{spawn: {amount, lifetime}, …}], params?}; effect {name: 'fire'} shows an Essential's");
  if (a.dry) return { ok: true, dry: true, note: "a particle effect this protocol runs; nothing stored" };
  const h = w.putBlob(a.effect);
  return { ok: true, effect: h, next: `set {id, component: 'particles', value: {effect: '${h}'}}` };
}
function installCheck(w, st, s, who, op) {
  const { actor, cap } = who; const installer = cap?.kind === "script" ? cap.sponsor : cap?.kind === "reaction" ? cap.author : actor;
  const role = roleOf(st, installer), cfg = scriptsCfg(st), v = op.value, at = `${op.id}.${op.comp}`;
  // the `scripts` permission is the install gate (role-defs: the owner sets each role's)
  if (!may(st, installer, "scripts")) refuse("rights", `installing a script here needs the scripts permission; ${said(installer)} is ${role}`, "the role's scripts permission says who may (the owner sets it in role-defs)", { needs: "scripts" });
  if (typeof v.src !== "string" || !/^sha256:[0-9a-f]{64}$/.test(v.src)) refuse("shape", `${at}.src must be a blob name sha256:<64 hex>`, "upload {text} stores the source and returns its name");
  let blob = null; try { blob = w.getBlob(v.src); } catch { /* missing or doesn't match its name: refused below */ }
  if (!blob) refuse("not-found", `${at}.src: no blob ${v.src} here`, "upload {text} first");
  if (blob.lang !== SR.LANG || typeof blob.text !== "string") refuse("shape", `${at}.src isn't JavaScript source ({lang: '${SR.LANG}', text})`, "upload {text}");
  const dirty = SR.hygiene(blob.text); if (dirty) refuse(dirty.code, `${at}: ${dirty.reason}`, dirty.fix ?? "refused at install: reviewers must see what runs");
  w.scripts?.warm?.(); // a world that gets a script gets warm sandbox processes
  const syn = w.scripts?.checkSyntax?.(blob.text); if (syn) refuse("syntax", `${at}: ${syn.why}`, "docs/SCRIPTS.md shows the API; scripts {id, script, test: {on: 'use'}} runs it dry");
  const sc = v.scope; if (!sc || typeof sc !== "object" || Array.isArray(sc)) refuse("shape", `${at} needs a scope {ids, comps}`, COMPONENTS.script.help);
  if (!(sc.ids === "self" || sc.ids === "subtree" || (Array.isArray(sc.ids) && sc.ids.length <= 32 && sc.ids.every((x) => x === "self" || isEntityId(x)))))
    refuse("shape", `${at}.scope.ids must be 'self', 'subtree' or up to 32 ids`, COMPONENTS.script.help);
  if (!Array.isArray(sc.comps) || sc.comps.length > 16 || !sc.comps.every((c) => typeof c === "string" && isComponent(sampleOf(c)))) refuse("shape", `${at}.scope.comps must be up to 16 component names ('name:*' for keyed)`, COMPONENTS.script.help);
  if (sc.bodies !== undefined && (!Array.isArray(sc.bodies) || sc.bodies.some((b) => !BODY_EFFECTS.includes(b)))) refuse("shape", `${at}.scope.bodies may name ${BODY_EFFECTS.join(", ")}`, "each lands only where that body's consent allows it (§5)");
  if (sc.create && sc.ids !== "subtree") refuse("scope", `${at}: create needs ids: 'subtree' (what it makes must hang under it)`, "");
  // a scope that names a typo of a registered component could never write it (admit refuses the name): say so now
  for (const c of sc.comps) { const n = sampleOf(c).split(":")[0]; const near = !registered(n) && !n.includes("/") ? nearMiss(n) : [];
    if (near.length) refuse("schema", `${at}.scope.comps: '${n}' isn't a component; did you mean '${near[0]}'?`, `a component of your own carries a namespace (e.g. 'example.org/${n}')`, { didYouMean: near });
    // PROTOCOL §4: a script may only write what the authority takes, so an unregistered bare name is refused here, at install
    if (!registered(n) && !n.includes("/")) refuse("schema", `${at}.scope.comps: '${n}' isn't a registered component; bare names belong to the registry (PROTOCOL §4)`, `a component of your own carries a namespace: 'example.org/${n}'`, { didYouMean: [`example.org/${n}`] }); }
  for (const id of scopeIds(s, op.id, sc.ids)) for (const c of sc.comps) { const need = lacks(w, st, installer, { verb: "set", id, comp: sampleOf(c) }, new Set(s.entities[id] && !st.entities[id] ? [id] : []), { viaCap: true });
    if (need) refuse("rights", `${at}'s scope reaches ${id}.${c}, which needs ${needWords(need)}; ${said(installer)} is ${role}`, "a script can never do more than its installer could do directly: narrow the scope, or ask an owner to install or adopt it"); }
  const on = v.on ?? [];
  if (!Array.isArray(on) || on.some((e) => typeof e !== "string" || !(SCRIPT_EVENTS.includes(e) || (e.startsWith("changed:") && isComponent(e.slice(8))))))
    refuse("shape", `${at}.on lists ${SCRIPT_EVENTS.join(", ")} and changed:<comp>`, "timers come from every (they deliver tick, and wake after sleeping)");
  if (v.every !== undefined && !(typeof v.every === "number" && v.every >= 5)) refuse("shape", `${at}.every is ${v.every} s; the floor is 5 s`, "sub-second behaviour belongs in client presence or the engine; motion is a function of time");
  if (v.knobs !== undefined && utf8Len(jcs(v.knobs)) > 4096) refuse("too-big", `${at}.knobs is ${utf8Len(jcs(v.knobs))} bytes; at most 4 KiB`, "big data goes in a blob");
  const prev = st.entities[op.id]?.c[op.comp];
  if (v.always === true && prev?.always !== true && !Roles.isOwner(role)) refuse("rights", `${at}.always (run with nobody present) needs an owner`, "it costs the host while nobody benefits");
  if (prev === undefined || prev === PURGED) { const n = allScripts(s).length;   // a purged slot holds no live script: filling it is a new one
    if (n > cfg.max) refuse("too-many", `this world would have ${n} scripts; it allows ${cfg.max}`, "@world.script-settings.max (owner)"); }
}
const rtKey = (id, name) => `${id}|${name}`;
const rtOf = (w, id, name) => ((w.presence.scripts ??= {})[rtKey(id, name)] ??= { console: [] });
const logRt = (w, rt, line) => { rt.console.push({ ts: Math.floor(w.now()), ...line }); if (rt.console.length > 20) rt.console.shift(); w.presenceDirty = true; };
// how many behaviour acts sit in the cause chain behind entry `seq` (41 §3.9: a reader computes it from the log)
function scriptDepth(w, seq) { let n = 0, e = w.entries[seq], guard = 0;
  while (isE(e) && isScriptActor(e.actor) && guard++ < 1000) { if (e.kind === "act") n++; e = w.entries[e.cause]; } return n; }
// writes to a script: key in its current life, newest first: [{e, value}] (value undefined if purged)
function scriptWrites(w, id, key) {
  const out = []; let restored = false;
  for (const i of backward(w, id)) { const e = w.entries[i]; if (!isE(e) || e.kind !== "change") continue; const ops = opsQuiet(e); const fu = followUpsOf(e);
    for (let k = ops.length - 1; k >= 0; k--) { const o = ops[k]; if (o.id !== id) continue;
      if (o.verb === "set" && o.comp === key) { if (fu.has(k)) restored = true; else { restored = false; out.push({ e, value: o.value }); } }   // a follow-up never sponsors
      else if (o.verb === "delete" && fu.has(k) && restored && (o.comp === key || o.comp === undefined)) { restored = false; continue; }   // reversed by a follow-up restore
      else if (o.verb === "create" || (o.verb === "delete" && (o.comp === key || o.comp === undefined))) return out; } }
  return out;
}
// `paused` is a permission, not the script: a write that changes only it (pause, resume) is a "pause write"
export const unpaused = (v) => { if (!v || typeof v !== "object" || Array.isArray(v)) return v; const { paused, ...rest } = v; return rest; };
const pauseOnly = (v, prev) => v !== undefined && prev !== undefined && jcs(unpaused(v)) === jcs(unpaused(prev));
// §5 "Two views": the sponsor is whose rights admitted the latest write to the key in its current life THAT CHANGED MORE
// THAN `paused`. Pausing adopts nothing: an owner who pauses a builder's script stops it, and the builder still answers
// for it (an explicit adopt is how to take it on).
function sponsorOf(w, id, key) {
  if (!creatorOf(w, id, key)) return null;
  const W = scriptWrites(w, id, key);
  for (let k = 0; k < W.length; k++) if (k === W.length - 1 || !pauseOnly(W[k].value, W[k + 1].value)) { const sp = entryBy(w, W[k].e).rights; return sp ? { sponsor: sp, sponsorAt: W[k].e.seq } : null; }   // READBACK: a purged install act names no sponsor: nothing runs on nobody's rights
  return null;
}
// who paused it: the write that turned `paused` on, in the run of writes since (a view: never a name in the value)
function pausedBy(w, id, key) {
  const W = scriptWrites(w, id, key); let at = null;
  for (const x of W) { if (x.value?.paused !== true) break; at = x; }
  if (!at) return null; const c = w.entries[at.e.cause]; const by = isE(c) && c.kind === "act" ? c.actor : at.e.actor;
  return { by, at: at.e.seq, ts: at.e.ts };
}
// who is here: the authority's own bodies plus whoever the host says is connected, id → position | null
function presentOf(w) { const out = new Map();
  for (const [id, b] of Object.entries(w.presence.bodies ?? {})) out.set(id, Array.isArray(b?.at) ? b.at : null);
  for (const p of w.present?.() ?? []) if (p && typeof p.id === "string" && !out.has(p.id)) out.set(p.id, Array.isArray(p.at) && p.at.length === 3 && p.at.every(Number.isFinite) ? p.at : null);
  return out; }
const scriptMemo = new WeakMap();
// per state, from each entity's own list (cached on its entity object: a write's next state re-reads only what it touched)
const scriptsOfEnt = new WeakMap();
function allScripts(st) { let out = scriptMemo.get(st); if (out) return out; out = []; const vol = VOLATILE.has(st.entities);
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; let mine = vol ? null : scriptsOfEnt.get(e);
    if (!mine || mine.id !== id) { mine = { id, list: [] }; for (const k of Object.keys(e.c)) { const v = e.c[k]; if (k.startsWith("script:") && v && typeof v === "object" && !Array.isArray(v) && v !== PURGED) mine.list.push({ id, name: k.slice(7), v }); } if (!vol) scriptsOfEnt.set(e, mine); }
    for (const x of mine.list) out.push(x); }
  scriptMemo.set(st, out); return out; }
// budgets (authority practice, stated in @world.script-settings; §3d M3): per script per minute; per world per hour; each
// sponsor a fair share of the world's hour, keyed on the sponsor (spreading over things or hashes gains nothing)
function budgetOf(w, st, now, id, key, sponsor, cfg) {
  let mine = 0, all = 0, bySp = 0;
  const sponsors = new Set(allScripts(st).map((x) => sponsorOf(w, x.id, `script:${x.name}`)?.sponsor).filter(Boolean));
  for (let i = w.entries.length - 1; i >= 0; i--) { const e = w.entries[i]; if (!isE(e)) continue; if (Number.isInteger(e.ts) && now - e.ts > 3600000) break;
    if (!isScriptActor(e.actor)) continue; all++;
    const a = e.kind === "act" ? e : w.entries[e.cause];
    if (isE(a) && a.kind === "act" && a.body?.sponsor === sponsor) bySp++;
    if (e.kind === "act" && e.actor === `script:${id}` && e.body?.script === key && now - e.ts <= 60000) mine++; }
  return { mine, all, bySponsor: bySp, sponsors: sponsors.size, share: Math.floor(cfg.budget / Math.max(1, sponsors.size)) };
}
// script time is capped for the PROCESS (one thread for every world): at most DUTY.maxMs per rolling second, then "busy".
// With the per-activation deadline nothing holds the thread past ~DUTY.maxMs + one deadline (I2).
export const DUTY = { windowMs: 1000, maxMs: 500, worldShare: 0.6 }; // one world gets at most worldShare of it (fairness between worlds)
/** A big server may give scripts more; a test firing a thousand activations opens it wide. → the previous setting. */
export function setScriptDuty({ windowMs = DUTY.windowMs, maxMs = DUTY.maxMs, worldShare = DUTY.worldShare } = {}) { const was = { ...DUTY }; Object.assign(DUTY, { windowMs, maxMs, worldShare }); dutyLog.length = 0; return was; }
const dutyLog = [];
// what's left of the duty for world `wid`: the process's, and that world's share of it
const dutyLeft = (wid) => { const t = performance.now(); while (dutyLog.length && t - dutyLog[0].at > DUTY.windowMs) dutyLog.shift();
  const all = dutyLog.reduce((n, d) => n + d.ms, 0), mine = dutyLog.reduce((n, d) => n + (d.w === wid ? d.ms : 0), 0);
  return Math.min(DUTY.maxMs - all, DUTY.maxMs * DUTY.worldShare - mine); };
const DRY = { n: 10, ms: 60000 }; // dry runs (use {dry}, scripts {test}) per person per minute: they run code and log nothing
// authority practice: what the authority spends, logged or not (presence, never the log): an activation that writes nothing still ran
function overCpu(w, now, id, key, sponsor, cfg) {
  const R = (w.presence.scriptRuns ?? []).filter((r) => now - r.ts < 60000); w.presence.scriptRuns = R;
  const runs = R.filter((r) => r.id === id && r.key === key).length; if (runs >= cfg.runs) return `${key} ran ${runs} times in the last minute; at most ${cfg.runs}, this server's limit (its operator sets it, not the world's owner)`;
  const ms = R.filter((r) => r.sponsor === sponsor).reduce((t, r) => t + r.ms, 0); if (ms >= cfg.cpu) return `${said(sponsor)}'s scripts used ${ms} ms of the authority's time in the last minute; at most ${cfg.cpu}, ${limitWhose(w.state(), cfg, "cpu")}`;
  const all = R.reduce((t, r) => t + r.ms, 0); if (all >= cfg.cpu * 3) return `this world's scripts used ${all} ms of the authority's time in the last minute; at most ${cfg.cpu * 3}`;
  return null;
}
export { DRY, allScripts, budgetOf, dutyLeft, dutyLog, installCheck, limitWhose, logRt, overCpu, particlesCheck, pauseOnly, pausedBy, presentOf, rtKey, rtOf, sampleOf, scopeIds, scriptDepth, scriptMemo, scriptRights, scriptsCfg, sponsorOf, uploadEffect };
