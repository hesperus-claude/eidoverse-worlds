// shared/protocol/authority/storage.js — a world over injected storage, the chain, ops and previews. A leaf below math and
// the spatial index; VOLATILE and opsQuiet live here because this is where they are read.
import { readLog, fold, opsOf, followUpsOf, applyInPlace, cloneState, cowState, applyCow, checkEntry, jcs, sha256, utf8Len, worldIdOf, Malformed, PURGED } from "../fold.js";
import { sha256Bytes, hexBytes } from "../hash.js";
import * as R from "../roles.js";
import { simFold } from "../simlayer.js";
import { r3 } from "../round.js";
import { refuse } from "./refuse.js";
import { migratePresence } from "../consent.js";
// a state changed in place after it's read (a batch's working copy, its previews): indexed whole, never derived from or kept
// as the last (a derivation compares entity objects, which such a state changes under them)
const VOLATILE = new WeakSet();
const CHANGE = Symbol("admitted change write");
export const posAt = (e, i) => { if (e && typeof e === "object") Object.defineProperty(e, "seq", { value: i, enumerable: false, configurable: true }); return e; };
/**
 * A world over injected storage.
 * @param {{ name: string, entries: any[], getBlob: (h: string) => any, putBlob: (v: any) => string,
 *   writeLine: (line: string) => void, now: () => number,
 *   presence?: { bodies: object, holds: object }, savePresence?: (p: object) => void }} io
 *   entries: what readLog returned, each with its seq attached by posAt (unenumerable).
 *   getBlob must verify a blob against its name and throw if it doesn't match (§2.2).
 *   writeLine appends one already-checked line (no trailing LF) to durable storage.
 *   now: the authority's clock in ms (§2.1 ts); pace (optional): a monotonic ms clock for the speed track (a stepped-back
 *   wall clock holds `now` still); presence: the unlogged presence plane.
 */
export function worldOf(io) {
  const { name, entries, getBlob, putBlob } = io;
  const w = { name, entries, getBlob, putBlob, exists: entries.length > 0, catalogue: io.catalogue ?? null };
  w.worldId = entries[0] && !(entries[0] instanceof Malformed) ? worldIdOf(entries[0]) : null;
  w.random = io.random ?? null;
  w.kindOf = io.kindOf ?? null; // id → account|anon|imported (§6a: about the account, never what holds it); only "anon" is read (a guest gets a smaller budget)
  w.nameOf = io.nameOf ?? null; // id → display name (the directory, §2.3); null = old escaped ids only
  w.now = io.now;
  // presence pacing (the speed track): elapsed ms no wall-clock step moves; null = pace by w.now
  w.pace = io.pace ?? null;
  // scripts: the sandbox is injected ({run, checkSyntax, available}: shared/protocol/sandbox.js), never imported
  // here (browsers import this file). No sandbox: scripts install, and every activation says "unavailable".
  w.scripts = io.scripts ?? null;
  // who is present beyond the authority's own bodies: () => [{id, at: [x,y,z] | null}]
  w.present = io.present ?? null;
  // speech is arrival-only: the newest seq at or below which this asker may NOT read a say's body, from the host (it knows
  // arrivals and admins): () => number | null. null = no floor (an admin, a lab, a replay). The log keeps every say; this
  // only gates who READS one back.
  w.sayFloor = io.sayFloor ?? null;
  // the presence plane: bodies and holds. Transient, never logged
  w.presence = io.presence ?? { bodies: {}, holds: {} };
  // an older presence file named who occupies what `seats`: read it as `occupants`, keep only the new key
  if (w.presence.seats && !w.presence.occupants) w.presence.occupants = w.presence.seats;
  delete w.presence.seats;
  // …and consent tables in older words (strangers/everyone/nobody/move, one friends list): read them, rewrite them in
  // today's (consent.js migratePresence: once, marked in the plane)
  if (migratePresence(w.presence)) w.presenceDirty = true;
  w.savePresence = () => io.savePresence?.(w.presence);
  // Governance keys (§2.4) live outside the log. Custody is authority practice (§5 identity), injected like storage:
  // io.custody = { sequencer() → "ed25519:…", keyOf(who, make?) → "ed25519:…" | null } (server/filehost.ts keeps the keys).
  w.custody = () => io.custody ?? null;
  // §2.1: moderation lives in a SEPARATE moderator log with the authority's enforcement, never in the world log
  w.mod = io.mod ?? [];
  // persist before publishing: a line reaches memory only after durable storage took it. A failed write leaves the file's
  // state unknown, so it is wedged (fail closed) until reopened from disk. wedgedAt: the seq being written (txnOutcome's `from`).
  w.wedged = {}; w.wedgedAt = null;
  const durably = (what, write) => {
    // the wedge's own refusal names its file (`wedged`), so the reply can tell it from any other throw (txnOutcome)
    if (w.wedged[what]) throw Object.assign(new Error(`storage: ${name}'s ${what} is not written: an earlier write failed (${w.wedged[what]}), so what is on disk is unknown; reopen the world from disk`), { wedged: what });
    try { write(); } catch (x) { w.wedged[what] = String(x?.message ?? x); if (what === "log") w.wedgedAt = entries.length; throw x; } };
  w.appendMod = (e) => { const r = { ts: Math.floor(w.now()), ...e }; durably("moderator log", () => io.appendMod?.(r)); w.mod.push(r); };
  let cache = null; // the folded state is a view, rebuilt when the log grows (callers never mutate it)
  // incremental when the new lines are plain entries this server wrote (state/act/sim/say): clone + apply their ops, as the
  // fold does; anything else (a purge, a governance entry, a malformed line, a value stripped to its commit) re-folds whole
  w.state = () => { if (cache?.n === entries.length) return cache.st;
    const fresh = entries.slice(cache?.n ?? 0);
    if (cache && cache.st.status === "ok" && fresh.every((e) => isE(e) && ["change", "act", "sim", "say"].includes(e.kind))) {
      const st = cloneState(cache.st);
      try { fresh.forEach((e, k) => { if (e.kind === "change") applyInPlace(st, opsOf(e), cache.n + k); });
        return (cache = { n: entries.length, st }).st; } catch (x) { if (!(x instanceof Malformed)) throw x; } }
    return (cache = { n: entries.length, st: fold(entries) }).st; };
  // §2.4 chain heads as a view over the log: head(i) = sha256(head(i-1) ‖ sha256(JCS(skeleton(i)))), exactly as
  // spec/conformance/chain.py computes them. A version is {seq, head} (§3d M7).
  const heads = [];
  w.headAt = (seq) => { for (let i = heads.length; i <= seq && i < entries.length; i++) { const e = entries[i], prev = i === 0 ? "00".repeat(32) : heads[i - 1];
      heads[i] = isE(e) && prev ? chainStep(prev, e) : null; } return heads[seq] ?? null; };
  // §3d H7: every id this world has ever created (a log view, kept incrementally): an id is never reused
  const ever = { n: 0, ids: new Set() };
  w.everIds = () => { for (; ever.n < entries.length; ever.n++) { const e = entries[ever.n]; if (isE(e) && e.kind === "change") for (const o of opsQuiet(e)) if (o.verb === "create") ever.ids.add(o.id); } return ever.ids; };
  w.sim = () => simFold(entries, w.now());
  w.stateAt = (seq) => fold(entries, { until: seq });
  // The authority re-reads every line it writes with the strict reader: it can never write what a reader would refuse.
  // §2.1: ts = admission time, an integer never decreasing along the log (a clock stepping back must not make the authority
  // write a line every reader refuses)
  w.nextTs = () => { let lastTs = 0; for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastTs = entries[i].ts; break; }
    return Math.max(Math.floor(w.now()), lastTs); };
  // §2.4 the chain: "the authority signs at least every write it commits". When custody can sign, every entry after genesis
  // is a chain point {head, sig} (genesis can't be: the world id is its hash). head(i) is over the skeleton, which leaves
  // head/sig out, so headAt reads a signed log and an unsigned one alike.
  const render = (e, seq, chained = false) => {
    const obj = { ...(e.kind === "genesis" ? {} : { world: w.worldId }), ...e, ts: w.pinTs ?? w.nextTs() };
    // §2.4: the chain commits an act/say/sim body as sha256(body.salt ‖ JCS(rest)). Unsalted, a purged chat line could be
    // recovered by guessing it against the commit, so in a chained log every such body carries 16 random bytes. Readers
    // take bodies by field, so the salt is invisible to them.
    if (io.custody?.sign && ["act", "say", "sim"].includes(e.kind) && obj.body && typeof obj.body === "object" && !Array.isArray(obj.body) && !("salt" in obj.body))
      obj.body = { ...obj.body, salt: nonce16(w) };
    if (chained && e.kind !== "genesis" && io.custody?.sign && w.worldId) {
      // "size": the line as it will be written, for fits(): later heads can't be known yet, but a head is always 64 hex and a
      // signature always its scheme's length, so the bytes are the same
      const head = chained === "size" ? "0".repeat(64) : chainStep(seq === 0 ? "00".repeat(32) : w.headAt(seq - 1), obj);
      obj.head = head; obj.sig = io.custody.sign(`eidoverse-head:${w.worldId}:${seq}:${head}`); }
    const line = JSON.stringify(obj);
    const [parsed] = readLog(line); let bad = parsed instanceof Malformed ? parsed : null;
    if (!bad) try { checkEntry(parsed, seq); } catch (x) { bad = x; }
    return { line, parsed, bad };
  };
  // Would these entries, appended in order, all be lines a reader accepts? Checked BEFORE any is written, so a request is all
  // or nothing (an act is never left without its result, 33 C2). A size or depth cap is a refusal.
  w.fits = (...es) => { for (const [k, e] of es.entries()) { const { bad } = render(e, entries.length + k, "size"); if (!bad) continue;   // with the chain fields append adds
    if (/^cap-/.test(bad.code)) refuse("too-big", `that would be a ${bad.code === "cap-size" ? `${bad.detail}-byte` : "too deeply nested"} ${e.kind} entry; a log line is at most 1 MiB, 64 deep (§1)`, "split it into smaller requests, or put big data in a blob and store its hash");
    throw new Error(`authority bug: would write a malformed entry (${bad.code} ${bad.detail})`); } };
  w.append = (e, token) => {
    if (e.kind === "change" && token !== CHANGE) throw new Error("authority bug: a change entry must come from changeEntry (§7: one gate)");
    // §2.4: an authority without the key genesis names would sign lines its own verifier calls forged. Every writing path
    // comes here (requests, logged refusals, timers, settles), so this is where it stops
    if (e.kind !== "genesis" && io.custody?.sign && entries.length && io.custody.sequencer() !== entries[0]?.body?.sequencer)
      refuse("custody", "this server doesn't hold the key that signs this world's log, so it can't write to it", "only this server's operator can fix this, by restoring the world's signing key or handing the world over to this server; asking again won't change it, and reads still work");
    w.fits(e); const { line, parsed, bad } = render(e, entries.length, true); const seq = entries.length;
    if (bad) throw new Error(`authority bug: would write a malformed entry (${bad.code} ${bad.detail})`); // e.g. the chain fields tipped it over a cap
    durably("log", () => io.writeLine(line));   // on disk first; only then the live chain and fold see it
    entries.push(posAt(parsed, seq)); Object.defineProperty(parsed, "bytes", { value: utf8Len(line), enumerable: false });
    if (e.kind === "genesis") w.worldId = worldIdOf(parsed);
    w.exists = true; return seq;
  };
  return w;
}
/** It holds the sequencer key genesis names (or can't sign at all). */
export const holdsCustody = (w) => !w.custody?.()?.sign || w.custody().sequencer() === w.entries[0]?.body?.sequencer;
export const anyWedged = (w) => !!(w.wedged?.log || w.wedged?.["moderator log"]);
export const wedgedOf = (w) => ({ log: !!w.wedged?.log, mod: !!w.wedged?.["moderator log"] });
// txnOutcome (PROTOCOL §7, "Every request ends in one of three outcomes"): committed {from, to} (durable and in entries);
// rolled-back (none reached disk); ambiguous {from, wedged} (a durable write threw, world or moderator log, or was cut off
// mid-write). Never reported as ok or a plain failure; a throw that wedges no new file rolls back.
// from: lines below it stand. The authority's own lines (attempt records, due rests) may still be written, and are not
// the asker's.
export function txnOutcome(w, from, { threw = false, error = null, refused = false, wedgedBefore = { log: false, mod: false } } = {}) {
  const grew = w.entries.length > from;
  if (!threw) return refused ? { outcome: "rolled-back" } : { outcome: "committed", from, to: w.entries.length };
  const now = wedgedOf(w), newLog = now.log && !wedgedBefore.log, newMod = now.mod && !wedgedBefore.mod;
  if (newLog || newMod) return { outcome: "ambiguous", from: newLog ? w.wedgedAt ?? w.entries.length : w.entries.length, wedged: true, ...(newLog ? {} : { file: "moderator log" }) };
  if (grew) return { outcome: "ambiguous", from: w.entries.length, wedged: anyWedged(w) };
  // wedged: the throw was the old wedge's own refusal (durably), naming its file; any other throw is a plain failure
  const wedge = error && typeof error === "object" ? error.wedged : undefined;
  return { outcome: "rolled-back", ...(wedge ? { wedged: true, ...(wedge === "log" ? {} : { file: wedge }) } : {}) };
}
const REOPEN_FIX = "only whoever runs this server can reopen it from disk, and asking again won't change that until they do";
/** When a request did not end committed or refused: never ok, always a registered code. The outcome is named `txn` (never
 *  `outcome`: the body verbs' replies already say asked | allowed there). */
export function txnRefusal(o) {
  if (o.outcome === "ambiguous") return { ok: false, txn: "ambiguous", from: o.from, refused: o.wedged
    ? (o.file === "moderator log" ? { code: "ambiguous", reason: `the write's result is unknown: storage failed while writing the moderator log, so whether the record is on disk isn't known; this world refuses moderation writes until it is reopened from disk`, fix: `only whoever runs this server can reopen it from disk, and asking again won't change that until they do; once it is reopened, the moderator log says what stands` }
      : { code: "ambiguous", reason: `the write's result is unknown: storage failed while writing it, so whether line ${o.from} is on disk isn't known; this world refuses writes until it is reopened from disk`, fix: `only whoever runs this server can reopen it from disk, and asking again won't change that until they do; once it is reopened, history from seq ${o.from} says what stands` })
    : { code: "ambiguous", reason: `the request was cut off after part of it was written: lines before ${o.from} stand, the rest was not written`, fix: `history from seq ${o.from} says what stands; send what is missing again` } };
  // an earlier write wedged a file: this one was refused before any byte, as every write will be until the world is reopened.
  // Sending it again can't help, so the reply doesn't say to
  if (o.wedged) return { ok: false, txn: "rolled-back", refused: { code: "server-error", reason: `nothing it asked for was written: an earlier write to this world's ${o.file ?? "log"} failed, so what is on disk is unknown, and the world refuses ${o.file ? "moderation writes" : "writes"} until it is reopened from disk (reads still work)`, fix: REOPEN_FIX } };
  return { ok: false, txn: "rolled-back", refused: { code: "server-error", reason: "the server failed while handling the request; nothing it asked for was written", fix: "send it again; if it keeps failing, whoever runs this server can find why in its log" } };
}
// READBACK (verbclasses.js): §12 may purge an act's whole body, so every read of one goes through readback(): the body, or
// null when purged. Null is UNKNOWN, and each reader says what unknown means for it, never "the default".
const purgeIx = new WeakMap();   // entries array → {n, seqs}: purge targets whose whole body is gone, kept incrementally
export function purgedSeqs(w) {
  const E = w.entries; let c = purgeIx.get(E); if (!c) purgeIx.set(E, (c = { n: 0, seqs: new Set() }));
  for (; c.n < E.length; c.n++) { const e = E[c.n];
    if (isE(e) && e.kind === "purge" && Array.isArray(e.body?.values)) for (const t of e.body.values) if (t && typeof t === "object" && Number.isInteger(t.seq) && t.seq < c.n && t.op === undefined) c.seqs.add(t.seq); }
  return c.seqs;
}
const isCommitStub = (b) => !!b && typeof b === "object" && !Array.isArray(b) && Object.keys(b).length > 0 && Object.keys(b).every((k) => k === "commit" || k === "salt");
/** An entry's body as the authority reads it back; null when purged (unknown: each reader says what that means). */
export function readback(w, seq) {
  const e = w.entries[seq]; if (!isE(e) || !e.body || typeof e.body !== "object") return null;
  if (!["act", "say", "sim"].includes(e.kind)) return e.body;   // a change's ops and genesis are never purged whole
  if (purgedSeqs(w).has(seq)) return null;
  return isCommitStub(e.body) ? null : e.body;
}
// 16 random bytes as base64url (a genesis nonce, a set's salt). io.random(n) → Uint8Array may be injected (two runs compared
// byte for byte); otherwise Web Crypto.
const nonce16 = (w) => { const b = w?.random ? w.random(16) : globalThis.crypto.getRandomValues(new Uint8Array(16)); let s = ""; for (const x of b) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); };
const isE = (e) => e && !(e instanceof Malformed) && typeof e === "object";
// §2.4 "The chain": the skeleton keeps each set's value and salt only as commit = sha256(salt ‖ JCS(value)), and an
// act/say/sim body only as {commit}; a body or op already {commit} is purged and stays as it is.
const opCommit = (o) => ("commit" in o && !("value" in o) ? o.commit : sha256((o.salt ?? "") + jcs(o.value)));
const skelOp = (o) => { const { value, salt, commit, ...rest } = o; return "value" in o || "commit" in o ? { ...rest, commit: opCommit(o) } : rest; };
const bodyCommit = (b) => { const ks = Object.keys(b); if (ks.length === 1 && ks[0] === "commit") return b.commit; const { salt, ...rest } = b; return sha256((salt ?? "") + jcs(rest)); };
function skeleton(e) {
  const { head, sig, ...s } = e;
  if (["act", "say", "sim"].includes(e.kind)) s.body = { commit: bodyCommit(e.body) };
  else if (e.kind === "change") s.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map((o) => (o?.verb === "set" ? skelOp(o) : o)) } : e.verb === "set" ? skelOp(e.body) : e.body;
  return s;
}
const chainStep = (prevHex, e) => { const b = new Uint8Array(64); b.set(hexBytes(prevHex), 0); b.set(hexBytes(sha256(jcs(skeleton(e)))), 32); return sha256Bytes(b); };
/** Seal a whole log the authority didn't write line by line (a translation): the same salts and chain points render gives
 *  (§2.4). entries[0] is genesis (never a chain point); every later entry gets salts, then {head, sig}. → new objects;
 *  `sign(msg)` is the sequencer key's, `random(n)` optional. */
export function seal(entries, { sign, random } = {}) {
  if (typeof sign !== "function") throw new Error("seal needs the sequencer's sign()");
  const w = { random: random ?? null }; const out = []; let prev = "00".repeat(32); const wid = worldIdOf(entries[0]);
  for (let i = 0; i < entries.length; i++) {
    let e = JSON.parse(JSON.stringify(entries[i])); delete e.head; delete e.sig;
    if (i > 0) {
      if (e.kind === "change") { const salt = (o) => (o?.verb === "set" && "value" in o && o.salt === undefined ? { ...o, salt: nonce16(w) } : o);
        e.body = e.verb === "batch" ? { ...e.body, ops: (e.body.ops ?? []).map(salt) } : e.verb === "set" ? salt({ verb: "set", ...e.body }) : e.body;
        if (e.verb === "set") { const { verb: _v, ...b } = e.body; e.body = b; } }
      else if (["act", "say", "sim"].includes(e.kind) && e.body && typeof e.body === "object" && !Array.isArray(e.body) && !("salt" in e.body)) e.body = { ...e.body, salt: nonce16(w) };
    }
    prev = chainStep(prev, e);
    if (i > 0) { e.head = prev; e.sig = sign(`eidoverse-head:${wid}:${i}:${prev}`); }
    out.push(e);
  }
  return out;
}
// §3d M7: expect by version is {seq, head}, never a bare seq. A head this history lacks at that seq means the version was
// read on a rewound branch (or another world): refused, never compared by seq alone.
function versionSeq(w, v, what) {
  if (!(v && typeof v === "object" && !Array.isArray(v) && Number.isInteger(v.seq) && typeof v.head === "string" && Object.keys(v).length === 2))
    refuse("shape", `${what} is a version {seq, head}, never a bare seq`, "inspect {id} → versions gives {seq, head} for each component; a write's result carries its own seq and head");
  if (v.seq < 0 || v.seq >= w.entries.length || w.headAt(v.seq) !== v.head)
    refuse("other-branch", `${what} {seq: ${v.seq}} names a head this world's history doesn't have at that seq: it was read on a branch that was rewound, or elsewhere`, "inspect again and redo the change on what's here");
  return v.seq;
}
const versionOf = (w, seq) => (seq === undefined || seq === null ? null : { seq, head: w.headAt(seq) });
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// PROTOCOL §5: `lock` keeps the first protocol's meaning (on when truthy; the authority stores `true`, an old {rank} reads
// as on). A purged value is absent, not a lock.
const lockedC = (c) => { const v = c?.lock; return v !== undefined && v !== PURGED && !!v; };
// a rotation written to the log: rounded like a position, then made unit again (0.707 per axis isn't unit, and a reader
// composing it through a parent drifts off unit)
const qr3 = (q) => { const r = q.map(r3); const n = Math.hypot(r[0], r[1], r[2], r[3]); return n > 0 ? r.map((v) => v / n) : [0, 0, 0, 1]; };
const setOp = (id, comp, value) => ({ verb: "set", id, comp, value });
const IMPORTED_ONLY = (comp) => typeof comp === "string" && /^imported(?:-(?:behavior|bans))?(?::|$)/.test(comp);   // imported-epoch is imported:epoch; imported-guard was never registered
const delOp = (id, comp) => (comp === undefined ? { verb: "delete", id } : { verb: "delete", id, comp });
const createOps = (id, comps) => [{ verb: "create", id }, ...Object.entries(comps).map(([k, v]) => setOp(id, k, v))];
// a preview of ops on st: copy-on-write (the same state applyOps gives, sharing every entity the ops don't touch; values are
// never mutated in place), never a deep copy per preview
const scratch = (st, ops) => { const s = applyCow(cowState(st), ops); if (VOLATILE.has(st.entities)) VOLATILE.add(s.entities); return s; };
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "thing";

const opsQuiet = (e) => { try { return opsOf(e); } catch { return []; } };
// the authority's follow-up ops inside a person's write (clearing refs a delete removed, an undo putting them back), marked
// by a Symbol (request JSON can't carry one): admitted with no rights, key, seniority, lock or scope check, so a third
// party's reference can't veto your delete or undo. Shape and value checks still apply.
const FOLLOW_UP = Symbol("follow-up");
const followUp = (o) => { o[FOLLOW_UP] = true; return o; };
export { followUpsOf };
export { CHANGE, FOLLOW_UP, IMPORTED_ONLY, VOLATILE, bodyCommit, chainStep, clone, createOps, delOp, followUp, isE, lockedC, nonce16, opCommit, opsQuiet, qr3, scratch, setOp, skelOp, skeleton, slug, versionOf, versionSeq };
