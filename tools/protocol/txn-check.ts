// tools/protocol/txn-check.ts: the transaction service and the request capability (docs/DESIGN-txn-capability.md).
// Real World, WorldLog, authority, files and REQUEST_MESSAGES; storage faults are injected at node:fs (the calls
// server/durable.ts makes), and a slow warm() is a gate held in front of the real WorldLog.request.
//   T1  a durable write throws on the 2nd line of a commit → ambiguous, `from` = that line; the 1st line is published
//   T2  fsync throws after the bytes were written → ambiguous, wedged, no ok to anyone; reopen finds the line; later writes rolled back
//   T3  a refusal is rolled back and publishes nothing; every published line was on disk when it was published
//   T4–T6, SR, RR2  one table (WAITED): banned, kicked, re-roled, the door closed, someone else, a re-join in flight,
//       superseded, closed, reset while the request waited → refused with its code and the request's id, nothing written;
//       RR1/RR3/RR5 the reset's files; SR3 the control writes
//   RR6, PR  a reset that fails partway: what the owner is told, the registry, a world that takes no writes until put back
//   T7  static: no await in the authority; none between worldlog's recheck and the synchronous commit
//   T8  a short write is looped to the end, and a write that takes nothing throws
//   T8c a log's or blob's first write into directories just made: each new directory's name is synced in its parent too,
//       a founded world's own directory included (and nothing is synced on win32, where the server can't sync a directory)
//   T8d the keys file a mint writes is synced before it's renamed into place
//   T8f a person's founding, a fork (its copied blobs too) and a reset sync each directory a new name lands in
//   T8e …and the directory that holds its name is synced after, as are directories made for it (none on win32, where the
//       server can't sync a directory)
//   T9  operator-repair: operator status revoked while queued → refused
//   T9f operator-repair from an account that isn't an operator: refused, pointed to whoever runs the server, not the world's owners
//   T10 no false refusals: 100 serial requests from an unchanged guest connection all committed
//   T11 server.ts writes only through requestwire (voice-moderate via requestAs); no direct w.log.request caller
// usage: BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/protocol/txn-check.ts
//        … --mutants   each row's mutation, applied to a scratch copy of the tree: every one must turn its rows red
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch, copyTree } from "./common.ts";
import { tryUntil } from "./wait.ts";
import { suite } from "./suite.ts";
// [name, file, find, replace, rows it must turn red]: the mutation each row exists to catch
const MUTANTS: [string, string, string, string, string[]][] = [
  ["unpublished lines: publish only when the authority returned (no finally)", "server/worldlog.ts", "    finally { this.publish(from, held); }\n    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", "    if (threw === null) this.publish(from, held);\n    const o = txnOutcome(live, from, { threw: threw !== null, error: threw, refused: !!r && typeof r === \"object\" && r.ok === false, wedgedBefore });\n    if (threw !== null) {\n      console.error(", ["T1"]],
  ["unknown called failure: a throw from a durable write reported rolled-back", "shared/protocol/authority/storage.js", "  if (newLog || newMod) return { outcome: \"ambiguous\"", "  if (false) return { outcome: \"ambiguous\"", ["T2"]],
  ["persist before publish: entries before the disk", "shared/protocol/authority/storage.js", "durably(\"log\", () => io.writeLine(line));", "entries.push(posAt(parsed, seq)); durably(\"log\", () => io.writeLine(line)); entries.pop();", ["T3c", "T3d"]],
  ["the door decided at join only: recheck without it", "server/reqcap.ts", "  if (door) return", "  if (false) return", ["T4", "T5"]],
  ["the door's kick not rechecked: a kick mid-request still writes", "server/access.ts", "    const k = actorId ? kickedHere(actorId) : null;", "    const k = null as any;", ["T4k"]],
  ["recheck without the role", "server/reqcap.ts", "  if (role && w.log.roleOf(cap.actorId) !== cap.role) return", "  if (false) return", ["T4b"]],
  ["identity read after the await: recheck without it", "server/reqcap.ts", "  if (c.actorId !== cap.actorId ||", "  if (false &&", ["T6", "T6b"]],
  ["an await in the authority's commit", "shared/protocol/authority/writes.js", "function commit(w, actor, verb, args, build) {", "async function __m() { await 0; }\nfunction commit(w, actor, verb, args, build) {", ["T7"]],
  ["new directories' names not synced: mkdir alone", "server/durable.ts", "  if (first === undefined) return;", "  return;", ["T8c"]],
  ["a founded world's directory made by plain mkdir", "server/worldlog.ts", "  mkdirDurable(dir);", "  fs.mkdirSync(dir, { recursive: true });", ["T8c"]],
  ["a replaced file renamed in unsynced", "server/durable.ts", "writeAll(fd, Buffer.from(data, \"utf8\")); fs.fsyncSync(fd); }", "writeAll(fd, Buffer.from(data, \"utf8\")); }", ["T8d"]],
  ["the keys file's directory made by plain mkdir", "server/custody.ts", "    mkdirDurable(path.dirname(file));", "    fs.mkdirSync(path.dirname(file), { recursive: true });", ["T8e"]],
  ["a replaced file's new name left unsynced", "server/durable.ts", "writeAll(fd, Buffer.from(data, \"utf8\")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }\n  fs.renameSync(tmp, file);\n  syncDir(path.dirname(file));", "writeAll(fd, Buffer.from(data, \"utf8\")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }\n  fs.renameSync(tmp, file);", ["T8e"]],
  ["short writes: writeSync's count ignored", "server/durable.ts", "    const n = fs.writeSync(fd, buf, off, buf.length - off);", "    fs.writeSync(fd, buf, off, buf.length - off); const n = buf.length - off;", ["T8", "T8b"]],
  ["operator status checked before the queue only: operator-repair rechecks liveness only", "server/requestwire.ts", "      const gone = recheck(cap, Date.now(), { role: false });", "      const gone = c.world === w && !c.superseded && w.clients.has(c) ? null : \"gone\";", ["T9"]],
  ["a non-operator sent to the world's owners", "server/requestwire.ts", 'reason: "operator-repair needs a server operator\'s account (WORLD_ADMIN)", fix: "ask whoever runs this server" } }); return; }', 'reason: "operator-repair needs a server operator\'s account (WORLD_ADMIN)", fix: "repair through the world\'s own roles: ask an owner" } }); return; }', ["T9f"]],
  ["a false refusal: operator-repair compares the world role", "server/requestwire.ts", "recheck(cap, Date.now(), { role: false })", "recheck(cap, Date.now())", ["T9c"]],
  ["a false refusal: the account compared un-normalised (undefined vs null)", "server/reqcap.ts", "(c.account ?? null) !== cap.account", "c.account !== cap.account", ["T10"]],
  ["a person's founding as it was: no sync after the rename, the ledger by atomicWrite", "server/worldlog.ts", "    fs.renameSync(tmp, dest); syncDir(WORLDS_DIR);\n    const L = foundersLedger(); L[name] = { account, actor, ts: now }; replaceDurable(foundersPath(), JSON.stringify(L, null, 1));", "    fs.renameSync(tmp, dest);\n    const L = foundersLedger(); L[name] = { account, actor, ts: now }; atomicWrite(foundersPath(), JSON.stringify(L, null, 1));", ["T8f"]],
  ["a fork's copied blobs left unsynced", "server/worldlog.ts", " syncTree(path.join(tmp, \"blobs\")); }", " }", ["T8f"]],
  ["a reset's fresh log renamed in unsynced", "server/worldlog.ts", "path.join(dir, \"world.jsonl\")); syncDir(dir);", "path.join(dir, \"world.jsonl\"));", ["T8f"]],
  ["CONTROL (no-op: must stay green)", "server/reqcap.ts", "// the door: the same decision", "// the door:  the same decision", []],
];
// T8c/T8e/T8f check directory syncs, which the server doesn't make on win32 (durable.ts syncDir): there their mutants are skipped
const DIR_SYNC_ROWS = new Set(["T8c", "T8e", "T8f"]);
if (process.argv.includes("--mutants")) {
  const ENGINE = path.resolve(import.meta.dir, "../.."); let bad = 0, ran = 0;
  for (const [name, file, find, repl, rows] of MUTANTS) {
    if (process.platform === "win32" && rows.length && rows.every((x) => DIR_SYNC_ROWS.has(x))) { console.log(`skip mutant '${name}': the server syncs no directory on win32`); continue; }
    ran++;
    const d = scratch("txnmut");
    for (const dir of ["server", "shared", "client", "mcpl"]) copyTree(path.join(ENGINE, dir), path.join(d, dir));
    fs.mkdirSync(path.join(d, "tools/protocol"), { recursive: true });
    for (const f of ["common.ts", "suite.ts", "txn-check.ts", "wait.ts"]) fs.copyFileSync(path.join(ENGINE, "tools/protocol", f), path.join(d, "tools/protocol", f));
    fs.copyFileSync(path.join(ENGINE, "package.json"), path.join(d, "package.json")); fs.symlinkSync(path.join(ENGINE, "node_modules"), path.join(d, "node_modules"), "junction");
    const f = path.join(d, file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the fix moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = Bun.spawnSync(["bun", path.join(d, "tools/protocol/txn-check.ts")], { cwd: d, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, timeout: 300_000 });
    const out = r.stdout.toString() + r.stderr.toString(); const red = [...out.matchAll(/^\s*FAIL (\S+)/gm)].map((m) => m[1]);
    const good = rows.length ? r.exitCode !== 0 && rows.every((x) => red.includes(x)) : r.exitCode === 0 && !red.length; if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → red: ${red.join(",") || "(none)"} (want ${rows.join(",")})`);
    fs.rmSync(d, { recursive: true, force: true });
  }
  console.log(`[txn-check --mutants] ${ran} mutations run${ran < MUTANTS.length ? ` (${MUTANTS.length - ran} skipped on ${process.platform})` : ""}, ${bad} wrong (each must turn its rows red; the control must stay green)`); process.exit(bad ? 1 : 0);
}
const root = scratch("txn");
process.env.WORLDS_DIR = path.join(root, "w"); process.env.OPT_DIR = path.join(root, "opt"); process.env.SKIP_OPT_SWEEP = "1";
process.env.WORLD_ADMIN = "local:opie";
fs.mkdirSync(process.env.WORLDS_DIR, { recursive: true });
const ENGINE = path.resolve(import.meta.dir, "../..");
const { foundWorld, WorldLog } = await import("../../server/worldlog.ts");
const { World } = await import("../../server/world.ts");
const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
const { directoryFor } = await import("../../server/directory.ts");
const { openLive } = await import("../../server/livehost.ts");
const { appendDurable } = await import("../../server/durable.ts");
const { OPERATORS } = await import("../../server/operators.ts");
const nodefs = (await import("node:fs")).default;
const { ok, done } = suite("txn-check");
const W = process.env.WORLDS_DIR;
const logFile = (name) => path.join(W, name, "world.jsonl");
const lines = (name) => fs.readFileSync(logFile(name), "utf8").split("\n").filter(Boolean);
const idOf = (acct, name) => directoryFor(W).resolve({ sub: acct, name });

// every log message any test client is sent: was each line it carries on disk when it was sent? (persist before publish)
let publishedNotOnDisk = [];
function world(name) {
  const { owner } = foundWorld(path.join(W, name), name, "olive");
  const w = new World(name);
  const real = WorldLog.prototype.request;
  const g = { gate: Promise.resolve(), release: () => {}, entered: 0 };
  w.log.request = function (...a) { g.entered++; return g.gate.then(() => real.apply(this, a)); };   // a held warm(): the request's await
  g.hold = () => { g.gate = new Promise((r) => { g.release = r; }); };
  return { w, owner, g, name };
}
let gens = 100;
function tab(W_, actorId, { account = undefined, spectator = false } = {}) {
  const replies = [], logs = [];
  const c = { id: `p${gens}`, world: W_.w, actorId, account, spectator, gen: gens++, legGen: 0,
    ws: { send: (d) => { const m = JSON.parse(d);
      if (m.type === "reply") replies.push(m);
      if (m.type === "log") { logs.push(m); const n = lines(W_.name).length; if (n < m.from + m.entries.length) publishedNotOnDisk.push({ world: W_.name, from: m.from, n: m.entries.length, onDisk: n }); } } } };
  W_.w.clients.add(c); return { c, replies, logs };
}
const send = (t, verb, args, type = "request") => REQUEST_MESSAGES[type]({ c: t.c, ws: t.c.ws, now: Date.now(), expel: () => {}, sweep: () => {} }, { id: `r${Math.random().toString(36).slice(2, 8)}`, verb, args });
const ownerDo = (W_, verb, args) => W_.w.log.requestSync(W_.owner, verb, args);

// storage faults at node:fs, for one world's log file: the n-th write (counted from arming) fails
//   before: writeSync throws, nothing written · after: the bytes are written, fsync throws · zero: writeSync takes nothing
function fault(name, at, mode) {
  const file = logFile(name); const fds = new Set(); let n = 0; let failFsync = new Set();
  const o = { openSync: nodefs.openSync, writeSync: nodefs.writeSync, fsyncSync: nodefs.fsyncSync };
  nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); if (path.resolve(String(p)) === file) fds.add(fd); return fd; };
  nodefs.writeSync = function (fd, ...r) { if (fds.has(fd) && ++n === at) { if (mode === "before") throw new Error("EIO: injected (before write)"); if (mode === "zero") return 0;
      const k = o.writeSync.call(nodefs, fd, ...r); failFsync.add(fd); return k; } return o.writeSync.call(nodefs, fd, ...r); };
  nodefs.fsyncSync = function (fd) { if (failFsync.has(fd)) { failFsync.delete(fd); throw new Error("EIO: injected (fsync after write)"); } return o.fsyncSync.call(nodefs, fd); };
  return () => Object.assign(nodefs, o);
}
const said = (W_, text) => W_.w.log.live.entries.some((e) => e?.kind === "say" && e.body?.text === text);
const described = (W_, label) => Object.values(W_.w.log.live.state().entities).some((e) => e.c?.description === label);

// ---------------- T1 ----------------
{ const X = world("t1"); const t = tab(X, X.owner, { account: "local:olive" });
  send(t, "create", { components: { description: "whole" } }); await tryUntil('the reply to "whole"', () => t.replies.length, { ms: 3000, step: 10 });   // a whole act first: undo's target after the reopen
  const n0 = X.w.log.live.entries.length; const logs0 = t.logs.length;
  const restore = fault("t1", 2, "before");
  send(t, "create", { components: { description: "half" } }); await tryUntil('the reply to "half"', () => t.replies.length > 1, { ms: 3000, step: 10 }); restore();
  const r = t.replies[1];
  const actPublished = t.logs.slice(logs0).some((m) => m.from === n0 && m.entries.length === 1 && m.entries[0].kind === "act");
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 + 1 && actPublished
    && lines("t1").length === n0 + 1 && X.w.log.live.entries.length === n0 + 1,
    "T1 the 2nd line's write throws: ambiguous (never ok), from = that line; the act (1st line) is durable and published", { r, logs: t.logs.map((m) => [m.from, m.entries.length]), disk: lines("t1").length, n0 });
  // what stands after a reopen: the act without its change folds (an act carries no ops), and undo finds nothing of it
  const re = openLive(path.join(W, "t1"), "t1-reopened");
  const { request: authorityRequest } = await import("../../shared/protocol/authority.js");
  const whole = (st) => Object.values(st.entities).some((e) => e.c?.description === "whole");
  const stood = whole(re.state()) && re.state().status === "ok" && re.entries.length === n0 + 1 && re.entries[n0].kind === "act" && !Object.values(re.state().entities).some((e) => e.c?.description === "half");
  const undo = authorityRequest(re, X.owner, "undo", {});
  ok(stood && undo?.ok === true && !whole(re.state()),
    "T1b reopened: the orphan act folds, nothing it asked for exists, and undo passes over it to the last act with a result (PROTOCOL §7)", { status: re.state().status, n: re.entries.length, undo }); }

// ---------------- T2 ----------------
{ const X = world("t2"); const t = tab(X, X.owner, { account: "local:olive" }); const other = tab(X, idOf("local:bea", "bea"), { account: "local:bea" }); const n0 = X.w.log.live.entries.length;
  const restore = fault("t2", 1, "after");
  send(t, "say", { text: "maybe" }); await tryUntil('the reply to "maybe"', () => t.replies.length, { ms: 3000, step: 10 }); restore();
  const r = t.replies[0];
  const anyOk = [...t.replies, ...other.replies].some((m) => m.ok === true);
  ok(r?.ok === false && r?.txn === "ambiguous" && r?.reply?.refused?.code === "ambiguous" && r?.reply?.from === n0 && !!X.w.log.live.wedged?.log && !anyOk
    && X.w.log.live.entries.length === n0 && !t.logs.length && !other.logs.length,
    "T2 fsync throws after the bytes were written: ambiguous, wedged, no one told ok, nothing published", { r, wedged: X.w.log.live.wedged, n: X.w.log.live.entries.length });
  const re = openLive(path.join(W, "t2"), "t2-reopened");
  ok(re.entries.length === n0 + 1 && re.entries[n0]?.kind === "say" && re.entries[n0]?.body?.text === "maybe",
    "T2b reopen finds the line the asker was told is unknown (so 'failed' would have been a lie)", { n: re.entries.length });
  send(t, "say", { text: "after" }); await tryUntil('the reply to "after"', () => t.replies.length > 1, { ms: 3000, step: 10 });
  const r2 = t.replies[1];
  ok(r2?.ok === false && r2?.txn === "rolled-back" && r2?.reply?.refused?.code === "server-error" && lines("t2").length === n0 + 1,
    "T2c the wedged log refuses the next write before any byte: rolled back, server-error, the file unchanged", r2);
  // what each reply tells its reader: only whoever runs the server can reopen the world, and asking again changes nothing
  // until then; neither points at a log the reader can't open, nor says to send it again
  const fx = (m) => `${m?.reply?.refused?.reason ?? ""} | ${m?.reply?.refused?.fix ?? ""}`;
  ok([r, r2].every((m) => /whoever runs (the|this) server/.test(fx(m)) && /won't change|until (then|it is reopened)/.test(fx(m)) && !/send it again|server's log/.test(fx(m))) && /refuses writes/.test(fx(r2)),
    "T2d the ambiguous reply and the wedged log's next refusal say only whoever runs the server can reopen the world, and asking again changes nothing until then", { r: fx(r), r2: fx(r2) }); }

// ---------------- T3 ----------------
{ const X = world("t3"); const t = tab(X, X.owner, { account: "local:olive" }); const n0 = X.w.log.live.entries.length;
  send(t, "inspect", { id: "nothing-here" }); await tryUntil('the reply to "after"', () => t.replies.length, { ms: 3000, step: 10 });
  const r = t.replies[0];
  ok(r?.ok === false && r?.txn === "rolled-back" && r?.reply?.refused && X.w.log.live.entries.length === n0 && !t.logs.length,
    "T3 a refusal: rolled back, nothing appended, nothing published", r);
  send(t, "say", { text: "ok" }); await tryUntil('the reply to "ok"', () => t.replies.length > 1, { ms: 3000, step: 10 });
  ok(t.replies[1]?.ok === true && t.replies[1]?.txn === "committed" && t.replies[1]?.reply?.txn === "committed" && t.replies[1]?.reply?.seq === n0,
    "T3b a write that lands: committed (envelope and reply), ok", t.replies[1]);
  const n1 = X.w.log.live.entries.length; const restore = fault("t3", 1, "before");
  send(t, "say", { text: "lost" }); await tryUntil('the reply to "lost"', () => t.replies.length > 2, { ms: 3000, step: 10 }); restore();
  ok(t.replies[2]?.txn === "ambiguous" && X.w.log.live.entries.length === n1 && !said(X, "lost") && t.logs.length === 1,
    "T3c a line whose write threw never reaches memory or anyone (persist before publish)", { r: t.replies[2], logs: t.logs.length }); }

// ---------------- T4–T6, SR, RR: what changed while the request waited ----------------
// One held-gate fixture per row: the request is inside the await, `while` changes the world or the connection, the gate
// opens. Each row is refused with its code and words, and nothing is written under any identity; the control writes.
const WAITED = [
  { id: "T4", what: "banned (the door)", code: "superseded", reason: /door/, while: (X, t) => ok(ownerDo(X, "ban", { who: t.c.actorId, reason: "test" })?.ok === true, "(T4 setup) the owner bans the asker while its request waits") },
  { id: "T4k", what: "kicked (the door)", code: "superseded", reason: /door.*kicked|kicked/, while: (X, t) => ok(ownerDo(X, "kick", { who: t.c.actorId, minutes: 5 })?.ok === true, "(T4k setup) the owner kicks the asker while its request waits") },
  { id: "T4b", what: "re-roled (an inhabitant made a builder: admitted under the old role, never silently promoted)", asker: "bea", verb: "create", code: "superseded", reason: /role/,
    setup: (X, who) => ok(ownerDo(X, "set", { id: "@world", component: `roles:${who}`, value: { role: "inhabitant" } })?.ok === true, "(T4b setup) the asker starts an inhabitant"),
    while: (X, t) => ok(ownerDo(X, "set", { id: "@world", component: `roles:${t.c.actorId}`, value: { role: "builder" } })?.ok === true, "(T4b setup) the owner makes the asker a builder while its request waits") },
  { id: "T5", what: "the door closed (members only, the asker unlisted: the same decision as join)", code: "superseded", reason: /no-access/,
    while: (X) => ok(ownerDo(X, "set", { id: "@world", component: "access", value: { join: "listed" } })?.ok === true, "(T5 setup) the door becomes members-only while the request waits") },
  { id: "T6", what: "the connection became someone else (a re-join resolved another identity)", code: "superseded", reason: /someone else/, while: (X, t) => { t.c.actorId = idOf("local:bea", "bea"); } },
  { id: "T6b", what: "a re-join in flight (actorId reset before the new one resolves): refused with the request's id, not an id-less server error", code: "superseded", reason: /./, while: (X, t) => { t.c.actorId = undefined; } },
  { id: "SR1", what: "superseded by the same account's new tab", code: "superseded", reason: /taken over/, while: (X, t) => { t.c.superseded = true; X.w.clients.delete(t.c); tab(X, t.c.actorId, { account: t.c.account }); } },
  { id: "SR2", what: "closed (out of the world's clients, c.world still set)", code: "superseded", reason: /closed/, while: (X, t) => { X.w.clients.delete(t.c); } },
  { id: "RR2", what: "the world was reset (the old log retired, a fresh one founded)", code: "reset", reason: /reset/, while: (X) => { X.old = X.w.log; X.n0 = X.w.log.live.entries.length; X.arch = X.w.resetWorld(); X.before = lines(X.name).length; } },
];
for (const row of WAITED) {
  const X = world(`w-${row.id.toLowerCase()}`); const who = idOf(`local:${row.asker ?? "vic"}`, row.asker ?? "vic"); row.setup?.(X, who);
  const t = tab(X, who, { account: `local:${row.asker ?? "vic"}` }); const n0 = X.w.log.live.entries.length;
  const label = `while-${row.id}`, rid = `q-${row.id}`, args = row.verb === "create" ? { components: { description: label } } : { text: label };
  X.g.hold(); const e0 = X.g.entered;
  REQUEST_MESSAGES.request({ c: t.c, ws: t.c.ws, now: Date.now(), expel: () => {}, sweep: () => {} }, { id: rid, verb: row.verb ?? "say", args });
  await tryUntil(`${row.id}'s request is held at the await`, () => X.g.entered > e0, { ms: 3000, step: 10 });
  row.while(X, t);
  X.g.release(); await tryUntil(`the reply to ${row.id}'s request`, () => t.replies.length, { ms: 3000, step: 10 });
  const r = t.replies[0], log = X.w.log.live, wrote = said(X, label) || described(X, label) || (X.old && (X.old.live.entries.some((e) => e?.body?.text === label)));
  const by = log.entries.slice(row.id === "RR2" ? 0 : n0).map((e) => e.actor);
  ok(r?.id === rid && r?.ok === false && r?.txn === "rolled-back" && r?.reply?.refused?.code === row.code && row.reason.test(r?.reply?.refused?.reason ?? "") && !wrote
    && (row.id === "RR2" || (!by.includes(who) && !by.includes(idOf("local:bea", "bea")))),
    `${row.id} ${row.what} while the request waited: refused (${row.code}), with the request's id, nothing written under any identity`, { r, wrote, by });
  if (row.id === "RR2") {   // the reset's own files: the old log archived, the fresh one untouched by the straggler, the old one retired for good
    ok(log !== X.old.live && fs.existsSync(path.join(X.arch, "world.jsonl")), "RR1 reset swapped the log and archived the old file", { arch: X.arch });
    ok(lines(X.name).length === X.before && !log.state().entities[label] && log.entries.length === X.before, "RR3 the new world's file (and its fresh log) gained no line from the old one", { before: X.before, after: lines(X.name).length });
    ok(X.old.requestSync(X.owner, "say", { text: "late" })?.refused?.code === "reset", "RR5 the old log stays retired for every later request"); }
}
{ const X = world("w-control"); const t = tab(X, X.owner, { account: "local:olive" });
  X.g.hold(); send(t, "create", { components: { description: "from-a-live-tab" } }); X.g.release();
  await tryUntil("the live tab's request is answered", () => t.replies.length, { ms: 3000, step: 10 });
  ok(t.replies[0]?.ok === true && described(X, "from-a-live-tab"), "SR3 (control) a connection that is still in the world writes", t.replies[0]); }

// ---------------- RR6, PR: a reset that fails partway (moved from reset-race-check) ----------------
// RR6: a failure after the fresh log is in place has erased the world; the owner is told it was, not that nothing changed
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const { owner } = foundWorld(path.join(W, "reopen"), "reopen", "olive");
  const rw = new World("reopen"); rw.openLog = () => { throw new Error("injected: the fresh log won't open"); };
  (await import("../../server/world.ts")).worlds.set("reopen", rw);   // registered, as getWorld leaves a loaded world
  const erasedId = rw.log.live.worldId;
  const casts = []; rw.broadcast = (m) => casts.push(m);   // what everyone present is sent
  const sent = []; const c = { id: "olive", world: rw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } };
  REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "reopen" });
  const e = sent.find((m) => m.type === "error")?.error ?? "";
  const archived = fs.readdirSync(path.join(W, "reopen")).some((n) => n.startsWith("reset-"));
  // (review of the house's PR #9: "stays closed" wasn't true: the World stayed registered and a reload was served the erased
  // world's state from memory) it leaves the registry, everyone present reloads, and the next join opens the fresh world from disk
  const { worlds, getWorld } = await import("../../server/world.ts");
  const gone = !worlds.has("reopen"); const next = gone ? getWorld("reopen") : null;
  const fresh = !!next && next !== rw && !next.log.retired && !!next.log.live.worldId && next.log.live.worldId !== erasedId;   // the fresh world, not the erased one
  ok(/was erased/.test(e) && /next join/.test(e) && /whoever runs this server/.test(e) && /Resetting again erases nothing more/.test(e) && !/nothing changed/.test(e) && !/stays closed/.test(e)
    && archived && casts.some((m) => m.type === "world-reset") && gone && fresh,
    "RR6 the fresh log doesn't open after the reset swapped it: the owner is told the world was erased and opens at the next join (who to ask if not), resetting again erases nothing more; everyone present reloads, and the next join opens the fresh world from disk, never the erased one from memory", { e, archived, gone, fresh, casts: casts.map((m) => m.type) }); }
// RR6b: once the fresh log is open the reset stands: a failure starting the fresh world's scripts (it has none) is the
// server log's, and everyone present is told of the reset as usual
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts"); const { WorldScripts } = await import("../../server/scripts.ts");
  const { owner } = foundWorld(path.join(W, "scripted"), "scripted", "olive");
  const sw = new World("scripted"); const sync = WorldScripts.prototype.sync;
  const sent = []; const c = { id: "olive", world: sw, actorId: owner, spectator: false, ws: { send: (d) => sent.push(JSON.parse(d)) } }; sw.clients.add(c);
  WorldScripts.prototype.sync = () => { throw new Error("injected: the scripts won't start"); };
  try { REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws }, { name: "scripted" }); } finally { WorldScripts.prototype.sync = sync; }
  const fresh = sw.log.live.entries.length, err = sent.find((m) => m.type === "error")?.error;
  ok(!err && sent.some((m) => m.type === "world-reset") && sw.log.requestSync(owner, "create", { components: { description: "after" } })?.ok === true,
    "RR6b the fresh log opened but the scripts didn't start: the reset stands, everyone present is told, and the fresh world takes requests", { err, sent: sent.map((m) => m.type), fresh }); }

// ---- PR (house 6340433633): a reset that fails after the old log was moved aside. The old log stayed live in memory and kept
// taking writes, which appendDurable (it opens by path) put in a NEW world.jsonl holding only the tail: a broken chain on disk.
// The failure is injected at the last rename (the fresh world's log into place); the rest is the real wire handler and reset.
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const dir = path.join(W, "half"); const { owner } = foundWorld(dir, "half", "olive");
  const hw = new World("half"); const n0 = hw.log.live.entries.length;
  const errs = []; const c = { id: "olive", world: hw, actorId: owner, gen: 0, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "error") errs.push(m.error); } } };
  const rename = fs.renameSync;
  fs.renameSync = function (a, b) { if (String(a).includes(".refound-")) throw new Error("EIO: injected (the fresh log into place)"); return rename.call(fs, a, b); };
  try { REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half" }); } finally { fs.renameSync = rename; }
  const said = errs[0] ?? "";
  const w1 = hw.log.requestSync(owner, "say", { text: "after the failed reset" });
  const file = fs.existsSync(path.join(dir, "world.jsonl"));
  ok(!w1?.ok && !file, "PR1 after a reset that failed partway a write is refused and no world.jsonl appears", { w1: w1?.ok ?? w1?.refused, file, lines: file ? lines("half").length : 0, n0 });
  ok(/takes no writes until the server's operator puts it back/.test(said) && /resetting again is safe/i.test(said) && /takes no writes/.test(w1?.refused?.reason ?? ""),
    "PR2 the answer and the refusal say the world takes no writes until the operator puts its log back, and whether resetting again is safe", { said, refused: w1?.refused });
  // resetting again finishes the erase; the old log stays in the first attempt's archive
  REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half" });
  const archives = fs.readdirSync(dir).filter((f) => f.startsWith("reset-")); const kept = archives.filter((a) => fs.existsSync(path.join(dir, a, "world.jsonl")));
  const w2 = hw.log.requestSync(owner, "say", { text: "in the fresh world" });
  ok(errs.length === 1 && fs.existsSync(path.join(dir, "world.jsonl")) && kept.length === 1 && w2?.ok === true,
    "PR3 resetting again finishes the erase (a fresh world that takes writes); the old log stays in the first archive", { errs, archives, kept, w2: w2?.ok ?? w2?.refused }); }
// PR4 (review of the house fixes): a failure at the SECOND rename (poses.json), twice. The second attempt finds no world.jsonl to
// move, so "did this attempt move the log" is no; the world is still retired, and the answer must say so, not "goes on as before"
{ const { REQUEST_MESSAGES } = await import("../../server/requestwire.ts");
  const dir = path.join(W, "half2"); const { owner } = foundWorld(dir, "half2", "olive");
  fs.writeFileSync(path.join(dir, "poses.json"), "{}");
  const hw = new World("half2");
  const errs = []; const c = { id: "olive", world: hw, actorId: owner, gen: 0, legGen: 0, ws: { send: (d) => { const m = JSON.parse(d); if (m.type === "error") errs.push(m.error); } } };
  const rename = fs.renameSync; const reset = () => REQUEST_MESSAGES["world-reset"]({ c, ws: c.ws, now: Date.now(), expel: () => {} }, { name: "half2" });
  fs.renameSync = function (a, b) { if (String(a).endsWith("poses.json")) throw new Error("EIO: injected (poses.json)"); return rename.call(fs, a, b); };
  try { reset(); reset(); } finally { fs.renameSync = rename; }
  const w1 = hw.log.requestSync(owner, "say", { text: "after two failed resets" });
  ok(errs.length === 2 && errs.every((e) => /takes no writes/.test(e)) && !/goes on as before/.test(errs[1]) && !w1?.ok,
    "PR4 a second failed attempt, with the log already moved by the first, still says the world takes no writes (and it doesn't)", { errs, w1: w1?.ok ?? w1?.refused });
  reset(); const w2 = hw.log.requestSync(owner, "say", { text: "fresh" });
  ok(errs.length === 2 && w2?.ok === true, "PR4 …and a third attempt that succeeds leaves a fresh world that takes writes", { errs, w2: w2?.ok ?? w2?.refused }); }

// ---------------- T7 ----------------
{ const strip = (s) => s.replace(/\/\/.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "");
  const files = ["shared/protocol/authority.js", ...fs.readdirSync(path.join(ENGINE, "shared/protocol/authority")).filter((f) => f.endsWith(".js")).map((f) => `shared/protocol/authority/${f}`)];
  const awaits = files.flatMap((f) => [...strip(fs.readFileSync(path.join(ENGINE, f), "utf8")).matchAll(/\b(await|async)\b/g)].map(() => f));
  const wl = fs.readFileSync(path.join(ENGINE, "server/worldlog.ts"), "utf8");
  const body = wl.slice(wl.indexOf("  async request(actor"), wl.indexOf("  requestSync(actor"));
  const seam = body.slice(body.indexOf("gone = still?.()"), body.indexOf("return this.requestSync("));
  ok(files.length > 10 && !awaits.length && body.length > 0 && seam.length > 0 && !/\bawait\b/.test(seam),
    "T7 no await/async in the authority (enter() to w.append is one synchronous call), none between worldlog's recheck and requestSync", { awaits, seam: seam.length }); }

// ---------------- T8 ----------------
{ const f = path.join(root, "short.jsonl"); const o = nodefs.writeSync;
  nodefs.writeSync = function (fd, buf, off = 0, len = buf.length - off) { return o.call(nodefs, fd, buf, off, Math.min(len, 5)); };   // at most 5 bytes a call
  let threw = null; try { appendDurable(f, '{"a":"a whole line"}'); } catch (e) { threw = e; } finally { nodefs.writeSync = o; }
  ok(!threw && fs.readFileSync(f, "utf8") === '{"a":"a whole line"}\n', "T8 a short write is looped until the whole line is on disk", { threw: String(threw), got: fs.readFileSync(f, "utf8") });
  nodefs.writeSync = function () { return 0; };
  let threw2 = null; try { appendDurable(f, '{"b":1}'); } catch (e) { threw2 = e; } finally { nodefs.writeSync = o; }
  ok(/short write/.test(String(threw2?.message)), "T8b a write that takes nothing throws (never a silent torn line)", String(threw2)); }
// ---------------- T8c ----------------
// a directory mkdir makes is named by an entry in its parent: a first write into new directories is durable only once
// every one of those entries is synced, the topmost new directory's parent included
{ const { putBlobFile } = await import("../../server/durable.ts");
  const base = path.join(root, "t8c"); fs.mkdirSync(base, { recursive: true });
  // founding in an existing worlds directory: its own directory is the only new name. A first founding runs before the
  // syncs are watched, since minting the keys file syncs this directory too and would hide whether founding synced it
  const worlds = path.join(base, "worlds"); fs.mkdirSync(worlds); foundWorld(path.join(worlds, "t8c-first"), "t8c-first", "olive");
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync }; const dirFds = new Map(); const synced = [];
  nodefs.openSync = function (p, flags, ...r) { const fd = o.openSync.call(nodefs, p, flags, ...r); if (flags === "r") dirFds.set(fd, path.resolve(String(p))); return fd; };
  nodefs.fsyncSync = function (fd) { if (dirFds.has(fd)) synced.push(dirFds.get(fd)); return o.fsyncSync.call(nodefs, fd); };
  try { appendDurable(path.join(base, "a", "b", "c", "world.jsonl"), '{"n":1}'); putBlobFile(path.join(base, "x", "blobs", "h.txt"), "blob", "sha256:unused");
    foundWorld(path.join(worlds, "t8c"), "t8c", "olive"); }
  finally { nodefs.openSync = o.openSync; nodefs.fsyncSync = o.fsyncSync; }
  const want = process.platform === "win32" ? [] : [base, "a", "a/b", "a/b/c", "x", "x/blobs", "worlds"].map((d) => d === base ? base : path.join(base, d));
  const missing = want.filter((d) => !synced.includes(d));
  ok(!missing.length && (process.platform !== "win32" || !synced.length) && fs.readFileSync(path.join(base, "a", "b", "c", "world.jsonl"), "utf8") === '{"n":1}\n',
    "T8c a first write into directories just made syncs each new directory's name in its parent, up to the parent of the first one made, a founded world's directory too (none on win32)", { missing: missing.map((d) => path.relative(root, d)), synced: synced.map((d) => path.relative(root, d)) }); }

// ---------------- T8f ----------------
// a person's founding, a fork and a reset are answered only once their new names are durable (the landing directory
// synced AFTER the rename; a fork's copied blobs before its directory moves); none on win32
{ const WL = await import("../../server/worldlog.ts"); const { putBlobFile } = await import("../../server/durable.ts");
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync, renameSync: nodefs.renameSync }; let fdPath = new Map(), ev = [];
  const watch = () => { fdPath = new Map(); ev = [];
    nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); fdPath.set(fd, path.resolve(String(p))); return fd; };
    nodefs.fsyncSync = function (fd) { ev.push(["fsync", fdPath.get(fd)]); return o.fsyncSync.call(nodefs, fd); };
    nodefs.renameSync = function (a, b) { ev.push(["rename", path.resolve(String(a)), path.resolve(String(b))]); return o.renameSync.call(nodefs, a, b); }; };
  const unwatch = () => Object.assign(nodefs, o);
  const syncedAfter = (to, dir) => { const i = ev.findIndex((e) => e[0] === "rename" && e[2] === path.resolve(to)); return i >= 0 && ev.slice(i + 1).some((e) => e[0] === "fsync" && e[1] === path.resolve(dir)); };
  const none = process.platform === "win32";
  // founding
  watch(); let f; try { f = WL.foundOwnedWorld("t8f-found", idOf("local:fay", "fay"), "local:fay"); } finally { unwatch(); }
  const foundOk = f?.ok && (none || (syncedAfter(path.join(W, "t8f-found"), W) && syncedAfter(path.join(W, ".founders.json"), W)));
  // fork, from a world holding a blob
  const src = world("t8f-src"); putBlobFile(path.join(W, "t8f-src", "blobs", "ab", "cafe.txt"), "a blob", "sha256:unused");
  watch(); let k; try { k = WL.forkWorld(src.w.log, "t8f-fork", src.owner); } finally { unwatch(); }
  const into = ev.find((e) => e[0] === "rename" && e[2] === path.join(W, "t8f-fork")); const tmp = into?.[1] ?? "";
  const before = into ? ev.slice(0, ev.indexOf(into)) : [];
  const blobSynced = before.some((e) => e[0] === "fsync" && e[1] === path.join(tmp, "blobs", "ab", "cafe.txt")) && before.some((e) => e[0] === "fsync" && e[1] === path.join(tmp, "blobs"));
  const forkOk = k?.ok && (none || (syncedAfter(path.join(W, "t8f-fork"), W) && blobSynced));
  // reset
  const rs = world("t8f-reset"); watch(); let arch = null; try { arch = WL.resetWorld(rs.w.log); } finally { unwatch(); }
  const dir = path.join(W, "t8f-reset");
  const resetOk = !!arch && (none || (syncedAfter(path.join(arch, "world.jsonl"), arch) && syncedAfter(path.join(dir, "world.jsonl"), dir)));
  ok(foundOk && forkOk && resetOk, "T8f a person's founding, a fork (its copied blobs too) and a reset each sync the directory a new name lands in, after the rename (none on win32)",
    { foundOk, forkOk, blobSynced, resetOk, tmp }); }

// ---------------- T8d, T8e ----------------
// a key a mint hands out must survive a crash, or the genesis it signed names a key no one holds: the keys file is
// written to a temp file and synced, renamed into place, and the directory holding its name synced after
{ const { custodyAt } = await import("../../server/custody.ts");
  const file = path.join(root, "t8d", "keys", "custody.json"), dir = path.dirname(file);
  const o = { openSync: nodefs.openSync, fsyncSync: nodefs.fsyncSync, renameSync: nodefs.renameSync }; const fdPath = new Map(), events = [];
  nodefs.openSync = function (p, ...r) { const fd = o.openSync.call(nodefs, p, ...r); fdPath.set(fd, path.resolve(String(p))); return fd; };
  nodefs.fsyncSync = function (fd) { events.push(["fsync", fdPath.get(fd)]); return o.fsyncSync.call(nodefs, fd); };
  nodefs.renameSync = function (a, b) { events.push(["rename", path.resolve(String(a)), path.resolve(String(b))]); return o.renameSync.call(nodefs, a, b); };
  let key; try { key = custodyAt(file).sequencer(); } finally { nodefs.openSync = o.openSync; nodefs.fsyncSync = o.fsyncSync; nodefs.renameSync = o.renameSync; }
  const into = events.findIndex((e) => e[0] === "rename" && e[2] === file), tmp = into >= 0 ? events[into][1] : null;
  const synced = tmp !== null && events.slice(0, into).some((e) => e[0] === "fsync" && e[1] === tmp);
  const dirSynced = into >= 0 && events.slice(into + 1).some((e) => e[0] === "fsync" && e[1] === dir)
    // the keys directory and its parent were made for this file: each is named in the directory above it
    && [path.dirname(dir), path.dirname(path.dirname(dir))].every((d) => events.some((e) => e[0] === "fsync" && e[1] === d));
  const onDisk = JSON.parse(fs.readFileSync(file, "utf8")).sequencer?.pub === key;
  ok(onDisk && synced, "T8d the keys file a mint writes is synced before it's renamed into place", { key, into, tmp, events: events.map((e) => e.map((x) => typeof x === "string" ? path.relative(root, x) : x)) });
  ok(onDisk && (process.platform === "win32" ? !dirSynced : dirSynced), "T8e …and the directory holding its name is synced after the rename, as are the directories made for it (none on win32)", { dirSynced, events: events.map((e) => e.map((x) => typeof x === "string" ? path.relative(root, x) : x)) }); }

// ---------------- T9 ----------------
{ const X = world("t9"); const opie = idOf("local:opie", "opie"); const t = tab(X, opie, { account: "local:opie" }); const bea = idOf("local:bea", "bea");
  X.g.hold(); const e0 = X.g.entered; send(t, "say", { text: "ahead-in-the-queue" }); await tryUntil('"ahead-in-the-queue" is held at the await', () => X.g.entered > e0, { ms: 3000, step: 10 });
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair");   // queued behind the held request
  OPERATORS.delete("local:opie");   // the account stops being an operator while the repair waits
  X.g.release(); await tryUntil('the reply to "operator-repair owner"', () => t.replies.length > 1, { ms: 3000, step: 10 }); OPERATORS.add("local:opie");
  const rep = t.replies.find((m) => m.operator);
  ok(rep?.ok === false && rep?.reply?.refused?.code === "superseded" && !X.w.log.live.state().entities["@world"]?.c?.[`roles:${bea}`],
    "T9 operator status revoked while the repair waited: refused, nothing written", rep);
  send(t, "set", { id: "@world", component: `roles:${bea}`, value: { role: "owner" } }, "operator-repair"); await tryUntil('the operator-repair reply (operator-repair owner)', () => t.replies.filter((m) => m.operator).length > 1, { ms: 3000, step: 10 });
  ok(t.replies.filter((m) => m.operator)[1]?.ok === true && t.replies.filter((m) => m.operator)[1]?.txn === "committed", "T9b (control) an operator's repair commits", t.replies.filter((m) => m.operator)[1]);
  // an operator's right is the account's, never the world's role: a second repair queued behind one that changed the
  // operator's own role is not refused for it
  const k0 = t.replies.filter((m) => m.operator).length; const fen = idOf("local:fen", "fen");
  X.g.hold(); const e1 = X.g.entered; send(t, "say", { text: "ahead-again" }); await tryUntil('"ahead-again" is held at the await', () => X.g.entered > e1, { ms: 3000, step: 10 });
  send(t, "set", { id: "@world", component: `roles:${opie}`, value: { role: "moderator" } }, "operator-repair");
  send(t, "set", { id: "@world", component: `roles:${fen}`, value: { role: "builder" } }, "operator-repair");
  X.g.release(); await tryUntil('the operator-repair reply (operator-repair builder)', () => t.replies.filter((m) => m.operator).length >= k0 + 2, { ms: 3000, step: 10 });
  const two = t.replies.filter((m) => m.operator).slice(k0);
  ok(two.length === 2 && two.every((m) => m.ok === true && m.txn === "committed"), "T9c an operator's repairs queued behind one that changed their own role both commit (no role compare for repairs)", two);
  // the refusal says which way the status went, and its fix follows: revoked, sending again won't change it; granted (an
  // ordinary request queued while the account became an operator), sending again is decided anew
  ok(/stopped being a server operator/.test(rep?.reply?.refused?.reason ?? "") && /won't change this/.test(rep?.reply?.refused?.fix ?? ""), "T9d revoked: said so, and that sending it again won't change it", rep?.reply?.refused);
  const gus = idOf("local:gus", "gus"); const tg = tab(X, gus, { account: "local:gus" });
  X.g.hold(); const e2 = X.g.entered; send(t, "say", { text: "ahead-a-third-time" }); await tryUntil('"ahead-a-third-time" is held at the await', () => X.g.entered > e2, { ms: 3000, step: 10 });
  const n0 = tg.replies.length; send(tg, "say", { text: "queued" }); OPERATORS.add("local:gus");
  X.g.release(); await tryUntil('the reply to "queued"', () => tg.replies.length > n0, { ms: 3000, step: 10 }); OPERATORS.delete("local:gus");
  const gr = tg.replies[n0];
  ok(gr?.ok === false && /became a server operator/.test(gr?.reply?.refused?.reason ?? gr?.refused?.reason ?? "") && !/won't change/.test(gr?.reply?.refused?.fix ?? gr?.refused?.fix ?? "") && /send it again/.test(gr?.reply?.refused?.fix ?? gr?.refused?.fix ?? ""),
    "T9e granted while a request waited: said so, and sending it again is the way (not 'won't change this')", gr);
  // T9f: an account that isn't an operator is refused at once, and told who can repair, which is never a world's owner
  const nob = idOf("local:nob", "nob"); const tn = tab(X, nob, { account: "local:nob" });
  send(tn, "set", { id: "@world", component: `roles:${bea}`, value: { role: "visitor" } }, "operator-repair"); await tryUntil('the operator-repair reply (operator-repair visitor)', () => tn.replies.some((m) => m.operator), { ms: 3000, step: 10 });
  const nr = tn.replies.find((m) => m.operator)?.reply;
  ok(nr?.ok === false && nr?.refused?.code === "rights" && /whoever runs this server/.test(nr?.refused?.fix ?? "") && !/owner/.test(nr?.refused?.fix ?? ""),
    "T9f operator-repair from an account that isn't an operator: refused, and pointed to whoever runs this server, not to an owner", nr); }

// ---------------- T10 ----------------
{ const X = world("t10"); const guest = directoryFor(W).resolve({ sub: null, name: "guest" }); const t = tab(X, guest, { account: undefined }); t.c.anonymous = true;
  // reads and writes alike (a guest may say 20 in 10 s: 15 says, 85 reads), each through both recheck seams
  for (let i = 0; i < 100; i++) if (i % 7 === 6 && i < 105) send(t, "say", { text: `n${i}` }); else send(t, "inspect", { id: "@world" });
  await tryUntil('the reply to "operator-repair visitor"', () => t.replies.length === 100, { ms: 3000, step: 10 });
  const bad = t.replies.filter((m) => !(m.ok === true && m.txn === "committed"));
  ok(t.replies.length === 100 && !bad.length && said(X, "n97") && t.replies.filter((m) => m.verb === "say").length === 14, "T10 100 serial requests from an unchanged guest connection: all committed, no false refusal", { n: t.replies.length, bad: bad.slice(0, 2) }); }

ok(!publishedNotOnDisk.length, "T3d every line any client was sent was on disk when it was sent", publishedNotOnDisk);
// ---------------- T11 ----------------
// every write a socket sends goes through requestwire (one capability, the queue, the meters, both recheck seams):
// server.ts calls w.log.request nowhere; voice-moderate goes through requestAs; the wire has no other door to a write
{ const srv = fs.readFileSync(path.join(ENGINE, "server/server.ts"), "utf8"); const rw = fs.readFileSync(path.join(ENGINE, "server/requestwire.ts"), "utf8");
  const direct = srv.split("\n").map((l, i) => [i + 1, l] as const).filter(([, l]) => /\.log\.request\(/.test(l) && !/^\s*\/\//.test(l)).map(([n, l]) => `${n}: ${l.trim().slice(0, 100)}`);
  ok(!direct.length && /requestAs\(c, ws, w,/.test(srv) && /export function requestAs\(/.test(rw) && /recheck\(cap\)/.test(rw.slice(rw.indexOf("export function requestAs"))),
    "T11 server.ts has no direct w.log.request caller (voice-moderate goes through requestwire.requestAs: capture, the connection's queue, the busy meter, recheck at both seams)", direct); }
done();
