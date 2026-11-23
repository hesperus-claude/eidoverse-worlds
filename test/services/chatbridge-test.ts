// chatbridge-test — the Discord chat bridge (services/chatbridge) against an owned scratch world, Discord played by
// the bridge's own DRY_RUN (stdin lines "Name: text" are Discord messages; world lines print as "→ discord [who]").
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/services/chatbridge-test.ts
//
// The world speaks the protocol: the bridge must join with replica, read chat from the log stream's `say` entries
// (actors are opaque ids, named by the stream), and speak through a door `say` request.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT, foundWorlds, freePort, saysIn } from "../harness/harness.ts";
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";
import { helloOf } from "../../shared/protocol/hello.js";

const BRIDGE = process.env.CHATBRIDGE ?? "services/chatbridge/index.ts";   // another build, for a red-first control
const W = mkdtempSync(join(tmpdir(), "ew-chatbridge-"));
foundWorlds(W, ["commons"]);
const PORT = freePort(9720);
const srv = Bun.spawn([process.execPath, "server/server.ts"], { cwd: ROOT,
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: W, JOIN_TOKEN: "", SKIP_OPT_SWEEP: "1" }, stdout: "ignore", stderr: "ignore" });
let bridge: Bun.Subprocess<"pipe", "pipe", "pipe"> | null = null;
const cleanup = () => { try { bridge?.kill(); } catch {} try { srv.kill(); } catch {} rmSync(W, { recursive: true, force: true }); };
// up = the door answers; with JOIN_TOKEN /worlds is 401 (public reads gated 10-14)
if (!await tryUntil("the scratch server answers", async () => (await fetch(`http://127.0.0.1:${PORT}/worlds`)).status < 500, { ms: 20_000 })) {
  console.error("scratch server never came up"); cleanup(); process.exit(2);
}

const join_ = (id: string) => new Promise<{ ws: WebSocket; msgs: any[] }>((res, rej) => {
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`); const msgs: any[] = [];
  const t = setTimeout(() => rej(new Error(`${id} join timed out`)), 8000);
  ws.onmessage = (e) => { const m = JSON.parse(String(e.data)); msgs.push(m); if (m.type === "snapshot") { clearTimeout(t); res({ ws, msgs }); } if (m.type === "error") { clearTimeout(t); rej(new Error(m.error)); } };
  ws.onopen = () => ws.send(JSON.stringify({ type: "join", hello: helloOf(), world: "commons", id, replica: true }));
});
const say = (c: { ws: WebSocket }, text: string) => c.ws.send(JSON.stringify({ type: "request", id: `t-${Math.random()}`, verb: "say", args: { text } }));

const S = suite("chatbridge");
const check = (what: string, c: unknown, detail?: unknown) => S.check(what, c, detail);

const alice = await join_("alice");
say(alice, "before the bridge (history: must not be mirrored)");
await tryUntil("the history line is in the log", () => saysIn(alice.msgs).some((x) => /before the bridge/.test(x.text)));
bridge = Bun.spawn([process.execPath, BRIDGE], { cwd: ROOT,
  env: { ...process.env, DRY_RUN: "1", WORLD_URL: `ws://127.0.0.1:${PORT}/ws`, WORLD_NAME: "commons", BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" },
  stdin: "pipe", stdout: "pipe", stderr: "pipe" });
let out = "";
(async () => { for await (const c of bridge!.stdout) out += Buffer.from(c).toString(); })();
await tryUntil("the bridge joins", () => /joined "commons"/.test(out));
say(alice, "hello from the world");
bridge.stdin.write("Ann: hi from discord\n"); bridge.stdin.flush();
await tryUntil("both directions crossed", () => /→ discord \[alice\]/.test(out) && saysIn(alice.msgs).some((x) => x.actor === "discord"));
// the fence: the bridge mirrors the log in order, so a wrongly echoed own say would print before this line does
say(alice, "fence after the discord line");
await tryUntil("the fence line reaches Discord", () => /→ discord \[alice\]: fence after the discord line/.test(out));

console.log("\nchatbridge — world ⇄ Discord (DRY_RUN) on a world\n");
// the Discord → world loop gate, as the bridge's messageCreate reads it (no Discord in this test: the gate itself)
{ const { skipFromDiscord: skip } = await import(join(ROOT, BRIDGE)); const own = { hookId: "h1", selfId: "me" };
  check("loop gate: our own webhook mirror and a bot are skipped, a person is not (humans only by default)", skip({ webhookId: "h1", author: { id: "me", bot: true } }, own, false) && skip({ author: { id: "b2", bot: true } }, own, false) && !skip({ author: { id: "p1" } }, own, false));
  check("loop gate: with ALLOW_BOTS and no webhook, the bridge's own posts (its bot account) are still skipped, another bot is not", skip({ author: { id: "me", bot: true } }, { hookId: null, selfId: "me" }, true) && !skip({ author: { id: "b2", bot: true } }, own, true)); }
check('the bridge joins (replica) embodied, as "discord"', /joined "commons" as discord/.test(out), out.slice(-300));
check("a world say reaches Discord, attributed to its speaker's display name (not the opaque id)", /→ discord \[alice\]: hello from the world/.test(out), out.slice(-300));
check("history from before the join is not mirrored", !/before the bridge/.test(out));
check("a Discord line enters the world as the bridge's door say, attributed inside the text", saysIn(alice.msgs).some((x) => x.actor === "discord" && x.text === "Ann: hi from discord"), JSON.stringify(saysIn(alice.msgs)));
check("the bridge's own say is not echoed back to Discord (and the fence after it was mirrored)", /→ discord \[alice\]: fence after the discord line/.test(out) && !/→ discord \[discord\]/.test(out) && !/hi from discord\n.*→ discord/.test(out));
check("nothing was refused", !/refused/.test(out), out.slice(-300));

// a burst faster than the say limit (20 per 10 s per actor, authority/gate.js): the bridge paces itself under it (SEND_GAP_MS) and every line lands, in order (#260 house I1)
const N = 25, burst = Array.from({ length: N }, (_, i) => `Bo: burst ${i}`);
bridge.stdin.write(burst.join("\n") + "\n"); bridge.stdin.flush();
const landed = () => saysIn(alice.msgs).filter((x) => x.actor === "discord" && /^Bo: burst \d+$/.test(x.text)).map((x) => x.text);
await tryUntil("the whole burst lands", () => landed().length >= N, { ms: 40_000 });
check(`a burst of ${N} Discord lines all enter the world, in order`, JSON.stringify(landed()) === JSON.stringify(burst), `${landed().length} landed: ${landed().slice(-3).join(" | ")}`);
check("…none dropped: no refusal but the rate one, which is retried in place", !/refused/.test(out), out.split("\n").filter((l) => /refused/.test(l)).slice(0, 3).join(" | "));
check("…paced under the limit: the world never had to ask the bridge to slow down (the rate retry path is not exercised here)", !/slow down/.test(out), out.split("\n").filter((l) => /slow down/.test(l)).slice(0, 2).join(" | "));
// the world goes away: Discord lines keep coming, and the bridge's queue toward the world stays bounded (MAX_BACKLOG 50)
srv.kill(); await srv.exited;
await tryUntil("the bridge sees the world go", () => /world socket closed/.test(out), { ms: 8000 });
const drops0 = (out.match(/world backlog — dropped/g) ?? []).length;
for (let i = 0; i < 60; i++) bridge.stdin.write(`Off: offline line ${i}\n`); bridge.stdin.flush();
await tryUntil("the offline overflow is dropped", () => (out.match(/world backlog — dropped/g) ?? []).length - drops0 >= 10, { ms: 3000 });
const dropped = (out.match(/world backlog — dropped/g) ?? []).length - drops0;
check("while the world is down, 60 Discord lines leave 50 queued: the 10 oldest are dropped, out loud, not held", dropped === 10 && /dropped "Off: offline line 0/.test(out), `${dropped} dropped`);
// a server that refuses the hello (this build's dialect is not its own): the bot says why and stops; it never redials
{ let joins = 0;
  const fake = Bun.serve({ port: 0, fetch: (req, s) => (s.upgrade(req) ? undefined : new Response("ws only", { status: 400 })),
    websocket: { message(ws, m) { if (JSON.parse(String(m))?.type !== "join") return; joins++;
      ws.send(JSON.stringify({ type: "refused", code: "update-required", need: { dialect: "eidoverse", v: 999 } })); ws.close(4005, "update-required"); } } });
  const p = Bun.spawn([process.execPath, BRIDGE], { cwd: ROOT, env: { ...process.env, DRY_RUN: "1", WORLD_URL: `ws://127.0.0.1:${fake.port}/ws`, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" }, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  let said = ""; (async () => { for await (const c of p.stdout) said += Buffer.from(c).toString(); })();
  await tryUntil("the refused bot stops", () => p.exitCode !== null, { ms: 5000 });
  const stopped = p.exitCode !== null; try { p.kill(); } catch {} fake.stop(true);
  check("a hello refusal is said and the bot stops: one join, no redial", stopped && joins === 1 && /update the client/.test(said) && /not redialing/.test(said), `exited ${stopped}, ${joins} joins: ${said.slice(-300)}`); }
cleanup();
S.done();
