// shared/protocol/replica.js — a world as a CLIENT holds it. Pure; client/lib/net.js and authority-check.ts run the same code.
//   adopt(snap)        the join snapshot's cut: {state: wireState(fold), head, worldId, mine?} (a client can't refold
//                      the whole log on join; it adopts a cut);
//   ingest(entries, from, held)
//                      the `log` message's raw entries, folded with the strict reader's ops (opsOf + applyInPlace). A
//                      gap, a purge (retroactive, L1) or a genesis asks for a fresh snapshot (`resync`).
// The renderer reads view.js's viewState of this fold; `say` entries come back as chat lines ({seq, ts, actor, text, to?}).
import { opsOf, applyInPlace, emptyState, PURGED, Malformed } from "./fold.js";
import { simFolder, simCutOf, advanceSim, tickOf, carried } from "./simlayer.js";
import { viewState } from "./view.js";
import { dec, learnNames, actorName } from "./names.js";

const idOut = (s) => dec(s) ?? s;
/** A say's spoken trio (a reader's own guard; the authority validated it): display metadata only. */
export const spokenOf = (b) => (b?.spoken === true && Number.isSafeInteger(b.utt) ? { spoken: true, utt: b.utt, ...(Number.isFinite(b.t0) ? { t0: b.t0 } : {}) } : {});

/** The fold ON THE WIRE (server side): {id: {born, c: {comp: {v: value} | {purged: true}}}}, the digest's own wrapping
 *  (§2.4), so a purged value can't be mistaken for a value. Not a view: readers draw from view.js viewState. */
export function wireState(st) {
  const out = {};
  for (const id of Object.keys(st.entities)) { const e = st.entities[id]; const c = {};
    for (const k of Object.keys(e.c)) c[k] = e.c[k] === PURGED ? { purged: true } : { v: e.c[k] };
    out[id] = { born: e.born, c }; }
  return out;
}
/** …and back into a fold state (null prototypes, PURGED as the fold's own sentinel). */
export function stateFromWire(wire) {
  const st = emptyState();
  for (const id of Object.keys(wire ?? {})) { const c = Object.create(null); const e = wire[id];
    for (const k of Object.keys(e.c ?? {})) c[k] = e.c[k]?.purged === true && !("v" in e.c[k]) ? PURGED : e.c[k]?.v;
    st.entities[id] = { born: e.born ?? 0, c }; }
  return st;
}

/** Freeze in place: its bag and every value under it. The fold never mutates a value (a set replaces one), so freezing only
 *  stops a READER's stray write, which would otherwise corrupt the fold this client holds. */
function freezeRecord(e) {
  if (!e || Object.isFrozen(e.c)) return;
  const deep = (x) => { if (x && typeof x === "object" && !Object.isFrozen(x)) { Object.freeze(x); for (const k of Object.keys(x)) deep(x[k]); } };
  deep(e.c);
}
/** A shallow copy of its bag for the fold to write: the values stay frozen, only ever replaced. */
const thawed = (e) => ({ born: e.born, c: Object.assign(Object.create(null), e.c) });

/** `freeze`: dev-mode guard, on by default (client/lib/net.js passes CONFIG.dev): a reader that mutates a record throws where it stands. */
export function makeReplica({ freeze = true } = {}) {
  const v = { active: false, st: null, head: -1, worldId: null, you: null, names: Object.create(null), stats: { ingested: 0, resyncs: 0 }, frozen: !!freeze };
  const freezeAll = () => { if (freeze && v.st) for (const id of Object.keys(v.st.entities)) freezeRecord(v.st.entities[id]); };
  // tree edges indexed from the records' own `parent` fields: rebuilt at adopt, kept at every ingest from the ops' ids.
  // A gone carrier keeps its children listed, exactly as a scan would answer.
  const kids = new Map(), par = new Map();
  const link = (id, to) => { let s = kids.get(to); if (!s) kids.set(to, (s = new Set())); s.add(id); par.set(id, to); };
  const unlink = (id) => { const was = par.get(id); if (was === undefined) return; const s = kids.get(was); if (s) { s.delete(id); if (!s.size) kids.delete(was); } par.delete(id); };
  const reindex = (id) => { const to = v.st?.entities?.[id]?.c?.parent?.to; const want = typeof to === "string" ? to : null; if (par.get(id) === want) return; unlink(id); if (want !== null) link(id, want); };
  const rebuildIndex = () => { kids.clear(); par.clear(); if (v.st) for (const id of Object.keys(v.st.entities)) reindex(id); };
  /** Children of `id` in id order (the fold's edges; [] for an id with none). */
  v.childrenOf = (id) => { const s = kids.get(id); return s ? [...s].sort() : []; };
  v.parentOf = (id) => par.get(id) ?? null;
  /** The ids above `id`, nearest first; stops at a carrier that is absent or a cycle (an old log may hold one). */
  v.ancestors = (id) => { const out = []; const seen = new Set([id]); for (let p = par.get(id); p !== undefined && v.st?.entities?.[p] && !seen.has(p); p = par.get(p)) { out.push(p); seen.add(p); } return out; };
  // actors are opaque ids (u-…); their display names come from the authority's directory, never from the log (§2.3)
  const learn = (names) => { if (names && typeof names === "object") { learnNames(names); for (const [k, n] of Object.entries(names)) if (typeof n === "string") v.names[k] = n; } };
  v.nameOf = (id) => actorName(id);
  // the SAME simFolder the authority runs, fed the same entries, no catalogue of its own. It advances only by entries' ts,
  // never this machine's clock; the screen shows a COPY advanced to display time, so a flight rests bit for bit where the authority logs it.
  let E = [], folder = null;
  v.sim = null; v.simVersion = 0;
  const startSim = (snap) => {
    E = []; const cut = snap.sim ?? null;
    for (const [q, e] of Object.entries(cut?.launches ?? {})) E[Number(q)] = e;
    // a joiner decides for itself whether it carries the cut's engine build: the sender's word isn't evidence;
    // a cut with no engine state can't be flown here either: mid-epoch, a sim only ever starts from a cut
    const spec = cut?.spec ?? null, foreign = !!spec && (!carried(spec) || !cut?.sim);
    folder = simFolder(E, { models: {}, from: { st: stateFromWire(snap.state), clock: cut?.clock ?? 0, spec, foreign, sim: foreign ? null : cut?.sim ?? null, launched: cut?.launched ?? {}, lifted: cut?.lifted ?? [], unknownEpoch: !!cut?.unknownEpoch, unknownHold: !!cut?.unknownHold } });
    v.sim = folder.view(); v.simVersion++;
  };
  v.adopt = (snap) => {
    v.st = stateFromWire(snap.state); v.head = Number.isInteger(snap.head) ? snap.head : -1; v.worldId = snap.worldId ?? null; v.active = true;
    v.you = typeof snap.you === "string" ? snap.you : null; learn(snap.names);
    freezeAll();
    rebuildIndex();
    startSim(snap);
  };
  v.reset = () => { v.active = false; v.st = null; v.head = -1; v.worldId = null; E = []; folder = null; v.sim = null; v.simVersion++; kids.clear(); par.clear(); };
  /** A copy of the canonical sim (null when the world runs no carried engine), to advance for display. */
  v.simClone = () => (v.sim?.sim ? JSON.parse(JSON.stringify(v.sim.sim)) : null);
  /** At display time t (ms, the authority's clock): a cached copy, advanced forward only. */
  let pres = null, presV = -1;
  v.simAt = (t) => {
    if (!v.sim?.sim) return null;
    if (presV !== v.simVersion || !pres || tickOf(pres, t) < pres.tick) { pres = v.simClone(); presV = v.simVersion; }
    const k = tickOf(pres, t); if (k > pres.tick) advanceSim(pres, k);
    return pres;
  };
  /** The view the renderer and panels read, carrying a chat window (chat isn't in the fold). */
  v.view = (chat) => viewState(v.st, { recentChat: chat?.recentChat ?? [], chatTotal: chat?.chatTotal ?? 0 });
  /** → {changed, says: [chat lines], resync, why?, ts?, actor?}. */
  v.ingest = (entries, from, names) => {
    learn(names);
    if (!v.active) return { changed: false, says: [], resync: false };
    const says = []; let changed = false, ts = null, actor = null, lastAct = null, sky = null;
    for (let i = 0; i < (entries?.length ?? 0); i++) {
      const seq = from + i; const e = entries[i];
      if (seq <= v.head) continue;                                   // already folded (a re-delivery)
      if (seq !== v.head + 1) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: `gap ${v.head} → ${seq}` }; }
      if (e && typeof e === "object" && (e.kind === "purge" || e.kind === "genesis" || e.kind === "sequencer")) { v.stats.resyncs++; return { changed: false, says: [], resync: true, why: e.kind }; }
      let ok = !!(e && typeof e === "object" && !(e instanceof Malformed));
      if (e?.kind === "change") {
        try {
          const ops = opsOf(e);
          if (freeze) for (const o of ops) { const ent = typeof o?.id === "string" ? v.st.entities[o.id] : undefined; if (ent && Object.isFrozen(ent.c)) v.st.entities[o.id] = thawed(ent); }
          // the sky's provenance (#260 I286): a stored sky carries no seq/by (the log does), so the entry that wrote it names them
          if (ops.some(({ id, comp } = {}) => id === "@world" && comp === "sky"))   /* an op's comp field, not a record's bag */ sky = { seq, by: lastAct ?? v.nameOf(e.actor) };
          try { applyInPlace(v.st, ops, seq); changed = true; }
          finally { for (const o of ops) if (typeof o?.id === "string") { if (freeze) freezeRecord(v.st.entities[o.id]); reindex(o.id); } }
        } catch (x) { if (!(x instanceof Malformed)) throw x; ok = false; }
      }
      // (only launches are kept: a later rest names its launch as its cause; nothing else is read back)
      if (ok && folder) { const rev = v.sim?.rev; E[seq] = e; folder.feed(seq); if (!(e.kind === "sim" && e.verb === "launch")) delete E[seq]; if (v.sim?.rev !== rev) v.simVersion++; }   // the engine moved: the screen re-copies
      if (e?.kind === "say" && typeof e.body?.text === "string") says.push({ seq, ts: e.ts, actor: v.nameOf(e.actor), by: String(e.actor), text: String(e.body?.text ?? ""), ...(e.body?.to ? { to: v.nameOf(e.body.to) } : {}), ...spokenOf(e.body) });
      if (e?.kind === "act") { lastAct = v.nameOf(e.actor); if (actor === null) actor = lastAct; }
      if (Number.isInteger(e?.ts)) ts = e.ts;
      v.head = seq; v.stats.ingested++;
    }
    return { changed, says, resync: false, ts, actor, ...(sky ? { sky } : {}) };
  };
  return v;
}

/** The cut a joining client adopts (server/worldlog.ts clientCut): the fold, its head, and the sim layer at the authority's
 *  clock, so a joiner sees a flight already in the air. */
export function clientCutOf(w) {
  const sf = w.sim();
  return { state: wireState(w.state()), head: w.entries.length - 1, worldId: w.worldId ?? null, sim: simCutOf(sf, w.entries) };
}
