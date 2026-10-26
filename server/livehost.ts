// The authority (shared/protocol/authority.js) over one world directory, every view kept INCREMENTALLY:
//   state   the strict fold, copy-on-write per entry (a held state never changes); a purge refolds (L1).
//   sim     the sim layer as a running folder (simFolder), viewed at the authority's clock.
//   index   id → seqs of the change entries that touch it, so creatorOf / lastTouch cost a thing's own history.
//   clock   monotonic: max(wall clock, every ts already written) (§2.1).
//   presence the presence plane (bodies, holds): memory only, never a file (L6).
// <dir>/world.jsonl (§2.4); blobs at <dir>/blobs/sha256-<hex>.json, the full hash of their JCS bytes, written once,
// verified on read (§2.2). Each line is fsynced (durable.ts) before the request returns.
import fs from "node:fs";
import path from "node:path";
import { custodyFileIn } from "./keyfiles.ts";
import { readLog, fold, opsOf, applyInPlace, purgesIn, jcs, sha256, Malformed, DIALECT, VERSION } from "../shared/protocol/fold.js";
import { worldOf, posAt } from "../shared/protocol/authority.js";
import { simFolder, carried, digestOf } from "../shared/protocol/simlayer.js";
import { readLogBytes, appendDurable, putBlobFile } from "./durable.ts";
import { custodyAt, modLogAt } from "./custody.ts";
import { directoryFor } from "./directory.ts";
import { SANDBOX } from "../shared/protocol/sandbox.js";

type Any = any; // the authority is JSDoc-typed JS; the server holds it structurally

const isE = (e: Any) => e && !(e instanceof Malformed) && typeof e === "object";
const opsQuiet = (e: Any) => { try { return opsOf(e); } catch { return []; } };

/** A COPY of st sharing every entity the entry doesn't touch. */
export function applyShared(st: Any, ops: Any[], seq: number) {
  const entities = Object.create(null);
  for (const id of Object.keys(st.entities)) entities[id] = st.entities[id];
  const copied = new Set<string>();
  for (const o of ops) { const id = o?.id; if (typeof id !== "string" || copied.has(id)) continue; copied.add(id);
    const e = entities[id]; if (e) entities[id] = { born: e.born, c: Object.assign(Object.create(null), e.c) }; }
  return applyInPlace({ ...st, entities, diagnostics: st.diagnostics }, ops, seq);
}

export type LiveOpts = { now?: () => number; /** the speed track's elapsed-time clock (ms); default: performance.now, or `now` when given */ pace?: () => number; catalogue?: Any; simModels?: Any; onAppend?: (seq: number, e: Any) => void;
  /** the authority's governance keys file (§2.4); default <worlds dir>/.custody.json, shared by every world in it */ custodyFile?: string;
  /** default: that worlds dir's directory (server/directory.ts) */ nameOf?: (id: string) => string | null;
  /** account|anon|imported (the authority reads only "anon") */ kindOf?: (id: string) => string | null;
  /** the script sandbox (default QuickJS, shared/protocol/sandbox.js; null = none) */ scripts?: Any;
  /** connected beyond the authority's own bodies (server/worldlog.ts) */ present?: () => { id: string; at: number[] | null }[];
  /** speech is arrival-only: the seq at or below which this asker may not read a say's body; null = no floor (storage.js worldOf) */ sayFloor?: (actor: string) => number | null };

export function openLive(dir: string, name: string, opts: LiveOpts = {}) {
  const logPath = path.join(dir, "world.jsonl");
  const blobDir = path.join(dir, "blobs");
  const entries: Any[] = readLog(readLogBytes(logPath)).map(posAt);
  // governance is RESERVED (§13): this server neither writes nor validates `sequencer` entries, and one may have moved the
  // writer role somewhere it can't check, so it refuses to serve the world rather than fold past the entry and write on
  { const g = entries.findIndex((e) => isE(e) && e.kind === "sequencer");
    if (g >= 0) throw new Error(`"${name}" can't be served: its log holds a governance (sequencer) entry at seq ${g}, and governance is reserved in this server (PROTOCOL §13): it can't check who that entry made the writer, so it won't write after it. Nothing was changed.`); }
  const blobPath = (h: string) => path.join(blobDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  const getBlob = (h: string) => {
    if (!/^sha256:[0-9a-f]{64}$/.test(String(h))) throw new Error(`not a blob name: ${h}`);
    const s = fs.readFileSync(blobPath(h), "utf8");
    if (`sha256:${sha256(s)}` !== h) throw new Error(`blob ${h} doesn't match its name`);
    return JSON.parse(s);
  };
  const putBlob = (v: unknown) => {
    const s = jcs(v); const h = `sha256:${sha256(s)}`;
    putBlobFile(blobPath(h), s, h);
    return h;
  };
  // the clock: never behind anything already written, never backwards
  let lastNow = 0;
  for (let i = entries.length - 1; i >= 0; i--) if (isE(entries[i]) && Number.isInteger(entries[i].ts)) { lastNow = entries[i].ts; break; }
  const wall = opts.now ?? (() => Date.now());
  const now = () => (lastNow = Math.max(lastNow, Math.floor(wall())));
  // monotonic: a stepped-back wall (NTP, a VM host sync) holds `now` still, and a body's allowance would refill nothing.
  // A host that brings its own clock (a lab pinning time) is paced by it.
  const pace = opts.pace ?? (opts.now ? now : () => performance.now());

  const w: Any = worldOf({
    name, entries, getBlob, putBlob, now, pace, catalogue: opts.catalogue,
    scripts: opts.scripts === undefined ? SANDBOX : opts.scripts, present: opts.present, sayFloor: opts.sayFloor,
    writeLine: (line: string) => appendDurable(logPath, line),
    presence: { bodies: {}, holds: {} }, savePresence: () => {},
    custody: custodyAt(opts.custodyFile ?? custodyFileIn(path.dirname(dir))),
    nameOf: opts.nameOf ?? directoryFor(path.dirname(dir)).nameOf,
    kindOf: opts.kindOf ?? ((id: string) => directoryFor(path.dirname(dir)).entry(id)?.kind ?? null),
    ...modLogAt(path.join(dir, "world.mod.jsonl")),
  });

  // ---- the views, built once from the log, then advanced per entry ----
  let st = fold(entries);
  const touching = new Map<string, number[]>();
  // the last VALID checkpoint (checkpointSim): blob verifies, at = seq - 1, no purge after it (its bytes may sit in the cut),
  // an engine this host carries, and the cut's sim matches the recorded digest. Anything else: from genesis.
  const ckpt = (() => {
    let lastPurge = -1; for (let s = entries.length - 1; s >= 0; s--) if (isE(entries[s]) && entries[s].kind === "purge") { lastPurge = s; break; }
    for (let s = entries.length - 1; s > lastPurge; s--) { const e = entries[s]; if (!isE(e) || e.kind !== "sim" || e.verb !== "checkpoint") continue;
      const b = e.body ?? {}; if (b.at !== s - 1 || typeof b.state !== "string") { w.log?.(`checkpoint at ${s} malformed; skipped`); continue; }
      let blob: Any; try { blob = getBlob(b.state); } catch (err) { console.warn(`[world:${name}] checkpoint ${s}: ${(err as Error).message}; skipped`); continue; }
      let cut: Any = null; try { cut = typeof blob?.cutJson === "string" ? JSON.parse(blob.cutJson) : null; } catch { cut = null; }
      if (!cut?.spec || !carried(cut.spec) || !cut.sim || digestOf(cut.sim) !== b.sim) { console.warn(`[world:${name}] checkpoint ${s}: ${!cut ? "no cut in the blob" : !carried(cut.spec) ? `engine ${cut.spec?.engine}@${cut.spec?.build} not carried` : "digest mismatch"}; skipped`); continue; }
      return { seq: s, cut }; }
    return null;
  })();
  // the engine view needs the state AT the cut, or the first edit after a reopen drops the thing from the engine
  let sim = simFolder(entries, { models: opts.simModels ?? {}, purged: purgesIn(entries), ...(ckpt ? { from: { ...ckpt.cut, st: fold(entries, { until: ckpt.seq }) } } : {}) });
  const index = (seq: number, e: Any) => { if (!isE(e) || e.kind !== "change") return;
    for (const id of new Set(opsQuiet(e).map((o: Any) => o.id))) { let a = touching.get(id as string); if (!a) touching.set(id as string, (a = [])); a.push(seq); } };
  const bad = new Set(st.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed")).map(([q]: Any) => q));
  for (let s = 0; s < entries.length; s++) { index(s, entries[s]); if (st.status === "ok" && isE(entries[s]) && !bad.has(s) && (!ckpt || s > ckpt.seq)) sim.feed(s); }
  w.bootedFrom = ckpt ? ckpt.seq : null;

  // sandboxes start now, so a first activation doesn't wait for one
  if (st.status === "ok" && Object.values(st.entities ?? {}).some((e: Any) => Object.keys(e.c).some((k) => k.startsWith("script:")))) w.scripts?.warm?.();
  w.state = () => st;
  w.sim = () => sim.view(w.now()); // the authority's clock: one per request (authority.js request pins it)
  w.simCapTs = (maxTicks: number) => sim.capTs(maxTicks);
  w.simPeek = () => sim.view();   // where the engine stands, without advancing it (checks)
  w.touching = (id: string) => touching.get(id) ?? [];
  const baseAppend = w.append;
  w.append = (e: Any, token: Any) => {
    const seq = baseAppend(e, token); const x = entries[seq];
    if (x.kind === "genesis" || x.kind === "purge") st = fold(entries); // genesis starts the world; a purge is retroactive (L1)
    else if (x.kind === "change") st = applyShared(st, opsOf(x), seq);
    if (x.kind === "purge") for (const e of entries) if (isE(e) && e.kind === "sim" && e.verb === "checkpoint" && typeof e.body?.state === "string") {   // the purged bytes may sit in a cut: gone (§12)
      try { fs.unlinkSync(blobPath(e.body.state)); } catch { /* already gone */ } }
    index(seq, x);
    // rebuilt from the whole log, as a fresh reader folds it; a checkpoint can't stand in (it may hold the purged bytes)
    if (x.kind === "purge") { const bad = new Set(st.diagnostics.filter(([, c]: Any) => String(c).startsWith("malformed")).map(([q]: Any) => q));
      sim = simFolder(entries, { models: opts.simModels ?? {}, purged: purgesIn(entries) });
      if (st.status === "ok") for (let s = 0; s < entries.length; s++) if (isE(entries[s]) && !bad.has(s)) sim.feed(s); }
    else if (st.status === "ok") sim.feed(seq);
    opts.onAppend?.(seq, x);
    return seq;
  };
  return w;
}

/** Only the first 64 KiB is looked at. */
function genesisAt(p: string): any {
  if (!fs.existsSync(p)) return null;
  try {
    const fd = fs.openSync(p, "r"); const buf = Buffer.alloc(1 << 16); const n = fs.readSync(fd, buf, 0, buf.length, 0); fs.closeSync(fd);
    const [g] = readLog(buf.subarray(0, n).toString("utf8").split("\n")[0]);
    return isE(g) && g.kind === "genesis" ? g : null;
  } catch { return null; }
}
/** Line 0 is a genesis saying {dialect: "eidoverse-log", v: 4} (§2.4: the number is stated there and nowhere else). */
export function isWorldDir(dir: string): boolean {
  const g = genesisAt(path.join(dir, "world.jsonl"));
  return !!g && g.body?.dialect === DIALECT && g.body?.v === VERSION;
}
/** This protocol's family, saved before the names pass (older file name, or the number in its own field).
 *  Never opened. */
export function isPreNamesDir(dir: string): boolean {
  if (isWorldDir(dir) || !fs.existsSync(dir)) return false;
  try { return fs.readdirSync(dir).some((f) => f.endsWith(".jsonl") && !!genesisAt(path.join(dir, f))); } catch { return false; }
}
