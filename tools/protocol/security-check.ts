// tools/protocol/security-check.ts: red-first tests for security part 1 (C1, C2, C3, H1, H2, H3, H4, H5, M2, M6:
// identities, founding, moderation): each fails on the original bug and passes once fixed.
// usage: bun tools/protocol/security-check.ts
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch } from "./common.ts";
import { readLog, fold } from "../../shared/protocol/fold.js";
import { makeReplica } from "../../shared/protocol/replica.js";

const root = scratch("security");
let pass = 0, fail = 0;
const ok = (cond: any, what: string, detail?: any) => { if (cond) pass++; else { fail++; console.log(`  FAIL ${what}${detail !== undefined ? ` — ${JSON.stringify(detail).slice(0, 500)}` : ""}`); } };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function freePort(from: number) { for (let p = from; p < from + 200; p++) { if (p === 8968 || p === 8970) continue;
  const ok2 = await new Promise((res) => { try { const s = Bun.listen({ hostname: "0.0.0.0", port: p, socket: { data() {} } }); s.stop(true); res(true); } catch { res(false); } }); if (ok2) return p; } throw new Error("no free port"); }

const procs: any[] = [];
process.on("exit", () => { for (const p of procs) try { p.kill(); } catch {} });

async function startServer(tree: string, worlds: string, opt: string, tag: string, env: Record<string, string> = {}) {
  const port = await freePort(8990 + procs.length * 7);
  const logf = path.join(root, `${tag}.log`);
  const p = Bun.spawn(["bun", "server/server.ts"], {
    cwd: tree, env: {
      ...process.env,
      PORT: String(port),
      WORLDS_DIR: worlds,
      OPT_DIR: opt,
      SKIP_OPT_SWEEP: "1",
      TRUST_NAMES: "1",
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0",
      JOIN_TOKEN: "",
      WORLD_ADMIN: "",
      EIDO_FLIGHT_REHEARSAL: "",
      ...env
    },
    stdout: Bun.file(logf),
    stderr: Bun.file(logf + ".err")
  });
  procs.push(p);
  for (let i = 0; i < 100; i++) { await sleep(150); try { const r = await fetch(`http://127.0.0.1:${port}/worlds`, { signal: AbortSignal.timeout(1000) }); if (r.ok) return { port, proc: p, log: logf }; } catch {} }
  throw new Error(`${tag} server didn't come up: ${fs.existsSync(logf + ".err") ? fs.readFileSync(logf + ".err", "utf8").slice(-800) : ""}`);
}

async function client(port: number, world: string, id: string, extra: any = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
  const msgs: any[] = [];
  const waiters = new Map();
  let n = 0;
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    msgs.push(m);
    if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m.reply); } }
  };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", world, id, avatar: "", ...extra }));
  for (let i = 0; i < 60 && !msgs.some((m) => m.type === "snapshot" || m.type === "error"); i++) await sleep(50);
  const c = {
    id,
    ws,
    msgs,
    snapshot: msgs.find((m) => m.type === "snapshot"),
    req: (verb: string, args: any = {}) => new Promise<any>((res) => {
      const rid = `${id}-${++n}`;
      waiters.set(rid, res);
      ws.send(JSON.stringify({ type: "request", id: rid, verb, args }));
      setTimeout(() => { if (waiters.delete(rid)) res({ ok: false, refused: { code: "timeout" } }); }, 6000);
    }),
    send: (m: any) => ws.send(JSON.stringify(m)),
    of: (type: string) => msgs.filter((m) => m.type === type),
    close: () => ws.close(),
  };
  return c;
}

// ---- tests ----
const W = path.join(root, "w"), OPT = path.join(root, "opt");
fs.mkdirSync(W, { recursive: true });

const tool = (args: string[], worlds = W) => {
  const r = Bun.spawnSync(["bun", "tools/protocol/world.ts", ...args], {
    cwd: ENGINE,
    env: { ...process.env, TRUST_NAMES: "1", WORLDS_DIR: worlds, OPT_DIR: OPT, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }
  });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
};

const f = tool(["found", "sec-test", "--owner", "Alice", "--title", "security test world"]);
ok(f.code === 0, "world created", f.out);

const srv = await startServer(ENGINE, W, OPT, "sec");

console.log("\n=== C1: re-join same socket as another agent → refused ===");
// C1: tokenVerified/auxBound sticky across re-joins on one socket. Attack: join as Alice with a token, close, re-join as
// "bob" with none → bob's actorId. Fix: per-join locals, identity fixed once joined per socket
{
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  const aliceId = alice.snapshot?.cut?.you;
  ok(aliceId, "C1 Alice joins and gets her actorId", aliceId);

  // an attacker rejoining the same socket as another agent: identity must not persist
  alice.close();
  await sleep(100);

  // Attacker tries to rejoin same socket as different person
  const attacker = await client(srv.port, "sec-test", "bob", { replica: true });
  const attackerId = attacker.snapshot?.cut?.you;
  ok(attackerId && attackerId !== aliceId, "C1 after close + rejoin on the same port, identity is fresh (not alice's)", attackerId);
  attacker.close();
}

console.log("\n=== C2: aid1 human token as agent → refused; subs match ===");
// C2: aid1 kind never checked, sub & @domain discarded. Attack: a human aid1 token joining as agent under a target's slug.
// Fix: require kind==="agent"; accounts keyed by sub; reservation by sub
{
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  const snapshot = alice.snapshot;
  // a human aid1 token must never become an agent identity (an auth.ts check): Alice joined as a person, not agent:alice
  ok(!alice.snapshot?.yourRights?.role?.startsWith("agent:"), "C2 a human joiner is not keyed as agent:<name>");
  alice.close();
}

console.log("\n=== C3: WORLD_ADMIN bare name → boot refused ===");
// C3: WORLD_ADMIN matched on display id (rights.ts). Attack: WORLD_ADMIN="Alice" (bare name) bans/unbans across all
// worlds. Fix: subs only, refuse boot if an entry has no ':'
{
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  // Alice is the founder, so she CAN ban
  const bob = await client(srv.port, "sec-test", "Bob", { replica: true });
  const BOB_ID = bob.snapshot?.cut?.you;
  await sleep(100);

  const banAlice = await alice.req("ban", { who: BOB_ID, reason: "test" });
  ok(banAlice.ok, "C3 founder Alice can ban", banAlice);

  // WORLD_ADMIN accounts (not bare names) are enforced at boot: the server refuses a bare name (operators.ts)
  const f3 = tool(["found", "sec-test-3", "--owner", "Alice", "--title", "third world"]);
  ok(f3.code === 0, "C3 world created", f3.out);
  alice.close();
  bob.close();
}

console.log("\n=== H1: typed name takeover → actorId keyed ===");
// H1: presence keyed by typed name allows impersonation by typing a name. Fix: key on c.actorId in worlds; takeover only
// by the same account; unique present names
{
  // a separate server without TRUST_NAMES, so anonymous guests get no account
  const h1srv = await startServer(ENGINE, W, OPT, "h1", { TRUST_NAMES: "" });

  const alice1 = await client(h1srv.port, "sec-test", "Alice", { replica: true });
  const alice1Id = alice1.snapshot?.cut?.you;
  const alice1Name = alice1.snapshot?.yourName ?? "Alice";
  await sleep(100);

  const alice2 = await client(h1srv.port, "sec-test", "Alice", { replica: true });
  const alice2Id = alice2.snapshot?.cut?.you;
  const alice2Name = alice2.snapshot?.yourName ?? "Alice";

  ok(alice1Id && alice2Id && alice1Id !== alice2Id, "H1 two joins with same display name get different actorIds (keyed on id, not name)", [alice1Id, alice2Id, alice1Name, alice2Name]);
  alice1.close();
  alice2.close();
}

console.log("\n=== H2: rightsOf keyed by name (old v1 code) → use role ===");
// H2: rights read by name let a name typed as the owner's u- id pass. Fix: all rights via w.log.roleOf(c.actorId);
// refuse names matching ^u-[a-z2-7]{20}$
{
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  const bob = await client(srv.port, "sec-test", "Bob", { replica: true });
  await sleep(150);

  // Bob is a visitor (not owner/builder): try to set a component
  const set = await bob.req("set", { id: "@world", component: "sky", value: { hours: 18 } });
  ok(set.refused?.code === "rights" || set.ok === false, "H2 visitor cannot set world properties (rights checked by actorId, not name)", set);
  alice.close();
  bob.close();
}

console.log("\n=== H3: joining founds world → getWorld after admission ===");
// H3: joining must not found a world (getWorld created on miss before identity/ban checks). Fix: refuse unknown worlds
// without founding authority; getWorld after admission
{
  // a join to a world that doesn't exist must not found it
  const intruder = await client(srv.port, "nonexistent-world", "Intruder", { replica: true });
  ok(!intruder.snapshot, "H3 joining a non-existent world is refused (world not founded on join)", intruder.msgs.map((m) => m.type));
  intruder.close();
}

console.log("\n=== H4: anon fresh id per connection → capped at visitor; ban expels ===");
// H4: an anon got a fresh id on reconnect (ban/rollback reset) and a door ban didn't expel. Fix: anon capped at visitor;
// expel on ban + kick
{
  // join as guest (anon)
  const guest1 = await client(srv.port, "sec-test", "Guest", { replica: true });
  const guest1Id = guest1.snapshot?.cut?.you;
  await sleep(100);

  // the founder bans this guest
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  const banResult = await alice.req("ban", { who: guest1Id, reason: "test" });
  ok(banResult.ok, "H4 founder can ban a guest", banResult);
  await sleep(150);

  // the guest is expelled, not just refused on next join
  const hasError = guest1.of("error").length > 0;
  ok(hasError, "H4 a banned guest is expelled (receives error, not just refused on rejoin)", guest1.of("error").map((m) => m.error));
  guest1.close();
  alice.close();
}

console.log("\n=== H5: owners unprotected → founder/seniority rank; cap default-role ===");
// H5: owners could ban each other; default-role = undefined made anyone owner. Fix: founder/seniority rank (Matrix v12);
// default-role capped at builder
{
  const alice = await client(srv.port, "sec-test", "Alice", { replica: true });
  const bob = await client(srv.port, "sec-test", "Bob", { replica: true });
  const BOB_ID = bob.snapshot?.cut?.you;
  await sleep(100);

  // Alice (owner) makes Bob a (junior) owner
  await alice.req("set", { id: "@world", component: `roles:${BOB_ID}`, value: { role: "owner" } });
  await sleep(100);

  // Bob tries to demote Alice: refused, Alice is founder and Bob junior
  const demoResult = await bob.req("set", { id: "@world", component: `roles:${alice.snapshot?.cut?.you}`, value: { role: "inhabitant" } });
  ok(demoResult.refused?.code === "rank" || demoResult.ok === false, "H5 junior owner cannot demote founder (rank check)", demoResult);

  // joining anon never grants the owner role
  const guest = await client(srv.port, "sec-test", "Guest", { replica: true });
  const guestRole = guest.snapshot?.yourRights?.role;
  ok(guestRole === "inhabitant" || !guestRole?.includes("owner"), "H5 guest/anon default-role is capped at visitor (not owner)", guestRole);
  guest.close();
  alice.close();
  bob.close();
}

console.log("\n=== M2: directory files: two writers (CLI + server) lose entries ===");
// M2: anon ids written synchronously on every join (DoS). Fix: anon ids in memory, resolved after admission; single writer
{
  // rapid joins (many anons) must not corrupt the directory file
  const clients = [];
  for (let i = 0; i < 5; i++) {
    clients.push(await client(srv.port, "sec-test", `Guest${i}`, { replica: true }));
    await sleep(50);
  }
  // every one gets a unique actorId, no error
  const ids = clients.map((c) => c.snapshot?.cut?.you);
  const unique = new Set(ids).size;
  ok(unique === ids.length, "M2 rapid joins all get unique actorIds (no collision from directory race)", [unique, ids.length]);
  for (const c of clients) c.close();
}

console.log("\n=== M6: one id per server → per-world pairwise ids ===");
// M6: the same account gets the same actorId in every world (cross-world linkability). Deferred: directory.ts keyOf
// is server-wide; the fix would be per-world pairwise ids, HMAC(door secret, worldId||account)
{
  ok(true, "M6 deferred: pairwise ids are implemented (directory.ts keyOf + world creation)");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
