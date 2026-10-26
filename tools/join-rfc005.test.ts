// Integration test for the `travel` tool lane (in-session world travel). Starts its own world + MCPL door on
// verified-free ports with temp tokens and state files; covers join policy, founding vs joining, dial-time ?world=,
// epoch across transitions, host prepare/commit refusal, per-world door state, the plain-MCP lane, attach failure.
// 🔴 The harness owns its ports, state and children: a fixed port can answer green from a stale listener, and
// writing the repo's mcpl/state.json leaves artifacts that look like real failures.
import { fileURLToPath } from "node:url";
import { mkdtempSync, writeFileSync, existsSync, rmSync, statSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds } from "./harness.ts";
import { createServer } from "node:net";

/** A port nothing listens on right now (bind :0, release). Racy, so readiness verifies ownership. */
async function freePort(): Promise<number> {
  return await new Promise((res, rej) => {
    const s = createServer();
    s.once("error", rej);
    s.listen(0, "127.0.0.1", () => {
      const p = (s.address() as { port: number }).port;
      s.close(() => res(p));
    });
  });
}
const WPORT = await freePort(), MPORT = await freePort();
const worldsDir = mkdtempSync(join(tmpdir(), "eido-join-"));
const tokensPath = join(worldsDir, "tokens.json");
// the worlds an agent may join exist before the run (joining never founds one; a world is founded by its operator)
foundWorlds(worldsDir, ["commons", "annex"]);
// a world the roamer agent owns, for THE WORLD DECIDES below
foundWorlds(worldsDir, ["keep"], "agent:token:roamer");
// the door's durable state lives in this run's scratch and dies with it
const statePath = join(worldsDir, "state.json");
// repository state must be untouched by a run: snapshot before, compare after
const REPO_STATE = fileURLToPath(new URL("../mcpl/state.json", import.meta.url));
const repoStateBefore = existsSync(REPO_STATE)
  ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs, size: statSync(REPO_STATE).size }
  : { exists: false, mtimeMs: 0, size: 0 };
// a credential can only NARROW where its agent goes (docs/DESIGN-world-access.md): `worlds` lists, `create: false`
// stops founding, neither means wherever the worlds let it
writeFileSync(tokensPath, JSON.stringify({
  "bound-token":   { id: "bound",   name: "Bound",   world: "commons", worlds: ["commons"] },
  "roamer-token":  { id: "roamer",  name: "Roamer",  world: "commons", worlds: ["*"], create: true },
  "nofound-token": { id: "nofound", name: "NoFound", world: "commons", worlds: ["*"], create: false },
  "roamer2-token": { id: "roamer2", name: "Roamer2", world: "commons", worlds: ["annex"] },
  "free-token":    { id: "free",    name: "Free",    world: "commons" },
}));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "\x1b[32m✓\x1b[0m" : "\x1b[31m✗\x1b[0m"} ${name}${ok ? "" : "  " + extra}`);
  ok ? pass++ : fail++;
};

// a nonce this run owns, echoed by the door's /healthz
const NONCE = `t${process.pid}-${Math.random().toString(36).slice(2, 10)}`;

// every child is registered BEFORE it can be lost, so the finally block drains it even if a later spawn throws
const spawned: { pid: number; kill: (sig?: string) => void; exitCode: number | null }[] = [];
function spawnChild(args: string[], env: Record<string, string>) {
  const child = Bun.spawn(args, { env: { ...process.env, ...env }, stdout: "ignore", stderr: "ignore" });
  spawned.push(child as unknown as typeof spawned[number]);
  return child;
}
const world = spawnChild([process.execPath, "server/server.ts"], {
  PORT: String(WPORT), WORLDS_DIR: worldsDir, WORLD_INSTANCE_NONCE: NONCE, SKIP_OPT_SWEEP: "1",
  // the sequencer reads the SAME credential file as the door: the door asks it /access as the agent, so it must know the bearer
  AGENT_TOKENS_PATH: tokensPath, HN_SESSIONS_FILE: join(worldsDir, "sessions.json"),
});
// a stale tmp, as if a previous run died mid-write: the door must sweep it at boot (checked every run)
writeFileSync(`${statePath}.tmp`, "");
const doorEnv = {
  MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
  MCPL_TOKENS: tokensPath, MCPL_STATE: statePath, MCPL_INSTANCE_NONCE: NONCE,
};
let mcpl = spawnChild([process.execPath, "mcpl/net-server.ts"], doorEnv);
/** Restart ONLY the door (same port, state file, nonce) and wait until the new process proves it is ours (§4l). */
async function restartDoor() {
  try { mcpl.kill(); } catch { /* already gone */ }
  await Promise.race([(mcpl as unknown as { exited: Promise<unknown> }).exited, sleep(5000)]);
  mcpl = spawnChild([process.execPath, "mcpl/net-server.ts"], doorEnv);
  await waitFor("restarted door /healthz echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`);
    return r.ok && (await r.text()).trim() === `ok ${NONCE}`;
  });
}
// last-resort reap on throw or signal: process.exit does NOT run finally blocks
const reap = () => { for (const c of spawned) { try { c.kill(); } catch { /* gone */ } } };
process.on("exit", reap);
process.on("uncaughtException", (e) => { reap(); console.error(e); process.exit(1); });

/** PIDs listening on a TCP port; null when the platform can't answer (NOT "nothing listening"). Linux-only (`ss`,
 *  /proc), so a second opinion; the per-run nonce is the portable proof. */
async function listenerPids(port: number): Promise<number[] | null> {
  try {
    const p = Bun.spawn(["ss", "-lntpH"], { stdout: "pipe", stderr: "ignore" });
    const out = await new Response(p.stdout).text();
    if ((await p.exited) !== 0) return null;
    const pids: number[] = [];
    for (const line of out.split("\n")) {
      if (!new RegExp(`[:.]${port}\\s`).test(line)) continue;
      for (const m of line.matchAll(/pid=(\d+)/g)) pids.push(Number(m[1]));
    }
    return [...new Set(pids)];
  } catch { return null; }          // no `ss` on this platform
}

/** Transitive children of a pid via /proc: Bun.spawn of a .ts may exec a child that does the listening. */
function descendantsOf(root: number): number[] {
  const out: number[] = [];
  if (!existsSync("/proc")) return out;   // no procfs: caller falls back to the nonce
  const walk = (pid: number, depth = 0) => {
    if (depth > 6) return;
    let kids = "";
    try { kids = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8"); } catch { return; }
    for (const k of kids.trim().split(/\s+/).filter(Boolean)) {
      const n = Number(k); out.push(n); walk(n, depth + 1);
    }
  };
  walk(root);
  return out;
}

/** Poll until `probe()` is true, or throw; fails FAST if either child dies (how a squatted port surfaces). */
async function waitFor(what: string, probe: () => Promise<boolean>, ms = 20_000) {
  const deadline = Date.now() + ms;
  let lastErr = "";
  while (Date.now() < deadline) {
    if (world.exitCode !== null) throw new Error(`${what}: world child exited early (code ${world.exitCode})`);
    if (mcpl.exitCode !== null) throw new Error(`${what}: door child exited early (code ${mcpl.exitCode})`);
    try { if (await probe()) return; } catch (e) { lastErr = (e as Error).message; }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`${what}: not ready within ${ms}ms${lastErr ? ` (last: ${lastErr})` : ""}`);
}

/** The port must be held by our child (or a descendant), by the OS's answer: a stale listener believes it is fine. */
function ownsPort(name: string, port: number, child: { pid: number }) {
  return async () => {
    const pids = await listenerPids(port);
    // null = the platform can't answer: the nonce already proved identity; the skip is reported (osOwnership)
    if (pids === null) return true;
    if (pids.length === 0) return false;
    const ours = new Set([child.pid, ...descendantsOf(child.pid)]);
    // a foreign listener is foreign however many pids we own; the only exemption is `pids === null` above
    const foreign = pids.filter((p) => !ours.has(p));
    if (foreign.length) {
      throw new Error(`${name} port ${port} held by pid(s) ${foreign.join(",")}, not our child ${child.pid} — stale listener`);
    }
    return true;
  };
}

/** Whether the OS-level check ran on this platform: reported, never assumed. */
async function osOwnershipAvailable(): Promise<boolean> {
  return (await listenerPids(WPORT)) !== null && existsSync("/proc");
}

// identity, not liveness. Every probe runs INSIDE the try, so a startup or identity failure still reaches teardown.
let osOwnership = false;
try {
await waitFor("world /version echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${WPORT}/version`);
  if (!r.ok) return false;
  const body = await r.json().catch(() => null) as { instance?: string } | null;
  // a world answering WITHOUT our instance field is a stale listener, not a slow start
  if (body && !("instance" in body)) {
    throw new Error("a world answered but WITHOUT our nonce — stale listener on this port");
  }
  return body?.instance === NONCE;
});
await waitFor("world port is owned by OUR child", ownsPort("world", WPORT, world));
// two door proofs: the nonce (portable) AND the OS's port owner (stricter, skipped loudly where unavailable)
await waitFor("door /healthz echoes our nonce", async () => {
  const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`);
  if (!r.ok) return false;
  const body = (await r.text()).trim();
  if (body === "ok") throw new Error("a door answered but WITHOUT our nonce — stale listener on this port");
  return body === `ok ${NONCE}`;
});
await waitFor("door port is owned by OUR child", ownsPort("door", MPORT, mcpl));

// say which proofs ran: "nonce only" must not read as "nonce + OS"
osOwnership = await osOwnershipAvailable();
console.log(osOwnership
  ? "  identity: per-run nonce + OS port ownership (linux)"
  : "  identity: per-run nonce only (no ss//proc on this platform — OS check skipped)");

// the seeded stale tmp must be gone once the door answers /healthz
check("stale state tmp from a previous incarnation swept at boot", !existsSync(`${statePath}.tmp`));

/** Minimal MCPL 0.5 host: initialize, grant, request/notification I/O. Starts at the credential's HOME unless it
 *  names a world; RESUME dials with no world at all (§4l). */
const RESUME = "__resume";
const startAt = (query: string) => query === RESUME ? "" : /[?&]world=/.test(query) ? query : `${query}&world=commons`;
async function connectHost(token: string, query = "", mode: "accept" | "decline" | "mute" | "error" = "accept") {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}${startAt(query)}`);
  let nextId = 10;
  const pending = new Map<number, (m: any) => void>();
  const inbound: any[] = [];
  const rpc = (obj: any) => ws.send(JSON.stringify(obj));
  const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++; pending.set(id, resolve); rpc({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    inbound.push(m);
    if (m.id !== undefined && m.method) {
      if (m.method === "channels/changed" && mode !== "accept") {
        if (mode === "mute") return;                       // never answer: server must fail closed
        if (mode === "error") {                            // answer with an error, not a verdict
          rpc({ jsonrpc: "2.0", id: m.id, error: { code: -32000, message: "policy store unavailable" } });
          return;
        }
        const added = (m.params?.added ?? []) as { id: string }[];
        rpc({ jsonrpc: "2.0", id: m.id, result: { results: added.map((c) => ({ id: c.id, accepted: false, reason: "test_decline" })) } });
        return;
      }
      rpc({ jsonrpc: "2.0", id: m.id, result: {} });       // ack server Requests
    }
  };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("open timeout")), 6000);
    ws.onopen = () => { clearTimeout(t); res(); };
  });
  const init = await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: { experimental: { mcpl: { version: "0.5", channels: { register: true, incoming: true } } } },
    clientInfo: { name: "join-test", version: "0" },
  });
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  await request("featureSets/update", {
    effectiveCapabilities: ["tools", "channels.register", "channels.lifecycle", "channels.join", "channels.publish", "channels.incoming"],
  });
  return { ws, request, inbound, init };
}

/** A PLAIN-MCP client: `initialize` omits capabilities.experimental.mcpl, so granted() is false for everything. */
async function connectPlain(token: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=${token}${startAt("")}`);
  let nextId = 10;
  const pending = new Map<number, (m: any) => void>();
  const inbound: any[] = [];
  const rpc = (obj: any) => ws.send(JSON.stringify(obj));
  const request = (method: string, params: any = {}) => new Promise<any>((resolve, reject) => {
    const id = nextId++; pending.set(id, resolve); rpc({ jsonrpc: "2.0", id, method, params });
    setTimeout(() => { if (pending.delete(id)) reject(new Error(`${method} timed out`)); }, 15_000);
  });
  ws.onmessage = (ev) => {
    const m = JSON.parse(String(ev.data));
    if (m.id !== undefined && pending.has(m.id)) { pending.get(m.id)!(m); pending.delete(m.id); return; }
    inbound.push(m);
    if (m.id !== undefined && m.method) rpc({ jsonrpc: "2.0", id: m.id, result: {} });
  };
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("open timeout")), 6000);
    ws.onopen = () => { clearTimeout(t); res(); };
  });
  await request("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},  // NO experimental.mcpl: the point
    clientInfo: { name: "plain-mcp-test", version: "0" },
  });
  rpc({ jsonrpc: "2.0", method: "notifications/initialized" });
  return { ws, request, inbound };
}

/** Raw world-WS watcher parked in a world, recording leave/join broadcasts. */
async function watchWorld(w: string, id: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  const events: any[] = [];
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 6000);
    ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); events.push(m);
      if (m.type === "snapshot") { clearTimeout(t); res(); } };
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world: w, id, avatar: "a.vrm", replica: true }));
  });
  return { ws, events };
}

const txt = (r:any) => r.result?.content?.[0]?.text ?? "";


  // ── 1. a credential limited to its home → deny, and the session survives (the tool is the only lane) ──
  const bound = await connectHost("bound-token");
  await sleep(1200);
  const denied = await bound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("a credential limited to commons is refused elsewhere", denied.result?.isError === true && /outside the worlds this credential is limited to/.test(denied.result?.content?.[0]?.text ?? ""), JSON.stringify(denied.result));
  const still = await bound.request("channels/list", {});
  check("denied session still attached to commons", still.result?.channels?.[0]?.id === "world:commons", JSON.stringify(still.result));

  // ── 3. a sibling world id through channels/open is now an unknown channel ─
  // the sibling-join lane is gone: a clean -32023, not a silent join
  const sib = await bound.request("channels/open", { channelId: "world:annex" });
  check("sibling channels/open is -32023 (lane removed, not silently joining)",
    sib.error?.code === -32023 && /travel/.test(sib.error?.message ?? ""), JSON.stringify(sib.error));
  const unk = await bound.request("channels/open", { channelId: "discord:#nope" });
  check("unknown channel is -32023 (not legacy -32004)", unk.error?.code === -32023, JSON.stringify(unk));
  const home = await bound.request("channels/list", {});
  check("…and the session did NOT move on either refusal", home.result?.channels?.[0]?.id === "world:commons", JSON.stringify(home.result));
  bound.ws.close();

  // ── 2. worlds:["*"] → travel granted, and the host is told ───────────────
  const commonsWatch = await watchWorld("commons", "watcher");
  const roamer = await connectHost("roamer-token");
  await sleep(1200);
  const joined = await roamer.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("policied travel arrives", !joined.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(joined)), txt(joined));
  await sleep(800);
  // a successful travel tells the host in two frames: the prepare (`added` only; a question asserts nothing) and the
  // commit's departure once it's a fact (a declining host must never see it, 4f)
  const changedFrames = roamer.inbound.filter((m) => m.method === "channels/changed");
  const addedAnnex = changedFrames.some((m) => m.params?.added?.[0]?.id === "world:annex");
  const retiredCommons = changedFrames.some((m) => m.params?.removed?.includes("world:commons"));
  check("channels/changed retires old world, adds new",
    addedAnnex && retiredCommons,
    JSON.stringify(changedFrames.map((m) => m.params)));
  const after = await roamer.request("channels/list", {});
  check("channels/list agrees the session moved", after.result?.channels?.[0]?.id === "world:annex", JSON.stringify(after.result));
  // opening the channel you are already in, with optional history, keeps its ordinary MCPL meaning
  const reopen = await roamer.request("channels/open", { type: "world", address: { world: "annex" }, history: { limit: 5 } });
  check("current-channel open still plain-opens (with history)", reopen.result?.channel?.id === "world:annex", JSON.stringify(reopen));
  // atomicity, world-side: the commons watcher saw the body actually LEAVE
  await sleep(600);
  const left = commonsWatch.events.some((m) => (m.type === "leave" || m.type === "part" || m.type === "left") && (m.id === "roamer" || m.who === "roamer"));
  const ghost = commonsWatch.events.filter((m) => m.type === "say" && m.id === "roamer").length;
  check("old world saw the body leave (no dual presence)", left, "leave-ish events: " + JSON.stringify(commonsWatch.events.map((m) => m.type).slice(-12)) + ` ghost says: ${ghost}`);
  commonsWatch.ws.close();
  // in-session denial for a LISTED credential asking outside its list
  const roamer2 = await connectHost("roamer2-token");
  await sleep(1200);
  const outside = await roamer2.request("tools/call", { name: "travel", arguments: { world: "elsewhere" } });
  check("worlds:[annex] credential denied for other worlds",
    outside.result?.isError === true && /^travel refused, so you're still in "commons": world "elsewhere" is outside the worlds this credential is limited to/.test(txt(outside)), txt(outside));
  roamer2.ws.close();

  // ── 4. dial-time ?world= under the same policy ────────────────────────────
  const dialed = await connectHost("roamer2-token", "&world=annex");
  await sleep(1200);
  const dl = await dialed.request("channels/list", {});
  check("?world= honored for a policied credential", dl.result?.channels?.[0]?.id === "world:annex", JSON.stringify(dl.result));
  dialed.ws.close();
  // §3.3: a denied dial-time destination: -32001 naming the world, then close 4001 within a deadline. Dialed raw:
  // connectHost's request() resolves on any reply, refusal included.
  const denial = await new Promise<{ err: string; code: number }>((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=bound-token&world=annex`);
    let err = "";
    const done = (code: number) => resolve({ err, code });
    ws.onopen = () => ws.send(JSON.stringify({
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "denied", version: "0" } },
    }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.error?.message) err = String(m.error.message);
    };
    ws.onclose = (ev) => done(ev.code);
    setTimeout(() => { try { ws.close(); } catch { /* gone */ } done(-1); }, 8000);
  });
  check("denied ?world= refuses the connection (no silent fallback)",
    /annex/.test(denial.err) && /limited to|policy|unauthorized|not permitted/i.test(denial.err) && denial.code === 4001,
    `close=${denial.code} err=${denial.err.slice(0, 110)}`);

  // ── 4b. §3.2.7 founding is not joining ───────────────────────────────────
  const nofound = await connectHost("nofound-token");
  await sleep(1200);
  const wouldFound = await nofound.request("tools/call", { name: "travel", arguments: { world: "brand-new-place" } });
  check("create:false CANNOT found a world",
    wouldFound.result?.isError === true && /^travel refused, so you're still in "commons": no world named "brand-new-place" exists, and this credential may not found one/.test(txt(wouldFound)), txt(wouldFound));
  // act forwards any verb; the world's authority, not the door, refuses one it doesn't take
  const unknownVerb = await nofound.request("tools/call", { name: "act", arguments: { verb: "fly_away", args: {} } });
  check("an unknown verb goes to the world, which refuses it",
    unknownVerb.result?.isError === true && /"ok": false/.test(txt(unknownVerb)) && /fly_away|unknown/.test(txt(unknownVerb)), txt(unknownVerb).slice(0, 600));
  // …and wasn't created as a side effect; the positive control below gives this its meaning
  check("refused founding left NOTHING on disk", !existsSync(join(worldsDir, "brand-new-place")));
  nofound.ws.close();
  const founder = await connectHost("roamer-token");
  await sleep(1200);
  // joining never founds a world here, whatever the credential: the door asks the world (/access) and refuses first
  const founded = await founder.request("tools/call", { name: "travel", arguments: { world: "founded-place" } });
  check("create:true doesn't found by travelling either: joining never founds, and the reply says so",
    founded.result?.isError === true && /joining never founds/.test(txt(founded)), txt(founded));
  check("…and that refusal left nothing on disk", !existsSync(join(worldsDir, "founded-place")));
  // positive control: a world that WAS founded appears at the same parent path, turning the negative into evidence
  await sleep(400);              // the sequencer writes the log dir on join
  check("…and the CONTROL: a world that WAS founded IS on disk at that path",
    existsSync(join(worldsDir, "annex")), `worldsDir=${worldsDir}`);
  // the first transition travels to an existing world, the second back
  await founder.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  // ── 4c. §3.2.3d epoch across transitions ─────────────────────────────────
  // read from the channels/changed descriptor pushed to the HOST, where §3.2.3d says a client learns it
  await sleep(600);
  const epochOf = (c: any) => c.inbound.filter((m: any) => m.method === "channels/changed")
    .map((m: any) => m.params?.added?.[0]?.metadata?.epoch).filter((e: any) => typeof e === "number");
  const e1s = epochOf(founder);
  check("a transition announced an epoch to the host", e1s.length > 0, JSON.stringify(e1s));
  await founder.request("tools/call", { name: "travel", arguments: { world: "commons" } });
  await sleep(600);
  const e2s = epochOf(founder);
  check("epoch increments across transitions", e2s.length > e1s.length && e2s[e2s.length - 1] > e1s[e1s.length - 1],
    `epochs=${JSON.stringify(e2s)}`);
  // the prepare announces `epoch + 1`; read the COMMITTED value from channels/list, so announce-without-increment fails
  const committed = await founder.request("channels/list", {});
  const cEpoch = committed.result?.channels?.[0]?.metadata?.epoch;
  check("…and the COMMITTED epoch matches what prepare promised",
    typeof cEpoch === "number" && cEpoch === e2s[e2s.length - 1],
    `promised=${e2s[e2s.length - 1]} committed=${cEpoch}`);
  const conflict = await founder.request("channels/open", { channelId: "world:annex", type: "world", address: { world: "commons" } });
  check("conflicting channelId+address is -32602", conflict.error?.code === -32602, JSON.stringify(conflict.error));
  founder.ws.close();

  // ── 4d. REGRESSION: dialing your OWN world must be fine (naming your home once refused where omitting it admitted) ─
  const ownWorld = await connectHost("bound-token", "&world=commons");
  await sleep(1200);
  const ow = await ownWorld.request("channels/list", {});
  check("dialing your OWN minted world is not 'founding'", ow.result?.channels?.[0]?.id === "world:commons", JSON.stringify(ow.result));
  ownWorld.ws.close();

  // ── 4e. REGRESSION: channels/changed carries the epoch (the client's ONLY epoch source) ──
  const eh = await connectHost("roamer-token");
  await sleep(1200);
  await eh.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  await sleep(600);
  const ch = eh.inbound.find((m) => m.method === "channels/changed");
  check("channels/changed descriptor carries metadata.epoch (§3.2.3d)",
    typeof ch?.params?.added?.[0]?.metadata?.epoch === "number", JSON.stringify(ch?.params?.added?.[0]?.metadata));
  eh.ws.close();

  // ── 4f. prepare/commit REFUSAL ───────
  const decliner = await connectHost("roamer-token", "", "decline");
  await sleep(1200);
  const declined = await decliner.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("host decline aborts the join (refusal, nothing moved)",
    declined.result?.isError === true && /your host declined the move/.test(txt(declined))
      && /still in "commons"/.test(txt(declined)), txt(declined));
  const stillHome = await decliner.request("channels/list", {});
  check("declined join left the body where it was", stillHome.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stillHome.result));
  // a prepare must not announce `removed` before the change, or a declining (or slow, 5s timeout) host and the body
  // disagree about the roster
  const prepareFrames = decliner.inbound.filter((m: any) =>
    m.method === "channels/changed" && Array.isArray(m.params?.removed) && m.params.removed.length);
  check("…and the host was never told its channel was removed",
    prepareFrames.length === 0,
    `saw ${prepareFrames.length} removal claim(s): ${JSON.stringify(prepareFrames.map((f: any) => f.params.removed))}`);
  decliner.ws.close();

  const mute = await connectHost("roamer-token", "", "mute");
  await sleep(1200);
  const timedOut = await mute.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("mute host is treated as declining (fail-closed)",
    timedOut.result?.isError === true && /didn't confirm the move to "annex" within 5 seconds, so trying again may work/.test(txt(timedOut)), txt(timedOut));
  mute.ws.close();

  // a host answering with an error refuses too; only the timeout suggests retrying
  const erring = await connectHost("roamer-token", "", "error");
  await sleep(1200);
  const errored = await erring.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("an error answer is a refusal in the host's words, without its JSON-RPC code or a retry hint",
    errored.result?.isError === true
      && txt(errored) === `travel refused, so you're still in "commons": your host didn't accept the move to "annex" (policy store unavailable)`,
    txt(errored));
  erring.ws.close();

  // ── 4g. LANE 1: the `travel` tool, reachable by a plain-MCP client; both lanes MUST share one policy ──
  const tv = await connectHost("roamer-token");
  await sleep(1200);
  const listed = await tv.request("tools/list", {});
  check("travel is advertised as a tool", listed.result?.tools?.some((t: any) => t.name === "travel"), "no travel tool");

  const moved = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  const movedText = moved.result?.content?.[0]?.text ?? "";
  check("travel tool arrives", /Arrived in "annex"/.test(movedText), movedText);
  const whereNow = await tv.request("channels/list", {});
  check("travel tool actually moved the body", whereNow.result?.channels?.[0]?.id === "world:annex", JSON.stringify(whereNow.result));
  // it must ALSO tell the host, like the channels/open lane
  check("travel tool emitted channels/changed to the host",
    tv.inbound.some((m) => m.method === "channels/changed"), "host never told");

  // `worlds` lists where you are and what policy allows: the same joinAllowed travel applies, before a move
  check("worlds is advertised as a tool", listed.result?.tools?.some((t: any) => t.name === "worlds"), "no worlds tool");
  const map = await tv.request("tools/call", { name: "worlds", arguments: {} });
  const mapText = txt(map);
  check("worlds marks the current world", /^- annex ←: .*you are here/m.test(mapText), mapText);
  check("worlds lists the world you came from as travelable (worlds:[\"*\"])", /^- commons: .*may travel/m.test(mapText), mapText);
  check("worlds shows the body in its row", /^- annex ←: .*roamer \(agent\)/m.test(mapText), mapText);
  check("worlds says joining never founds a world here", /joining never founds one here/.test(mapText), mapText);

  const noop = await tv.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel to where you already are is a no-op, not an error",
    !noop.result?.isError && /Already in/.test(noop.result?.content?.[0]?.text ?? ""), JSON.stringify(noop.result));
  tv.ws.close();

  // ── 4h. the tool honours join policy, and no second lane can disagree ─────
  // not a parity check: channels/open returns -32023 for any non-current channel; the policy claim rests on the tool assertion
  const bound2 = await connectHost("bound-token");   // worlds: ["commons"] → may not roam
  await sleep(1200);
  const toolRefusal = await bound2.request("tools/call", { name: "travel", arguments: { world: "annex" } });
  check("travel tool honours join policy", toolRefusal.result?.isError === true, JSON.stringify(toolRefusal.result));
  const boundMap = txt(await bound2.request("tools/call", { name: "worlds", arguments: {} }));
  check("worlds tells a narrowed credential it may not travel", /^- annex: .*outside the worlds your credential is limited to/m.test(boundMap), boundMap);
  // there is no second lane to disagree: prove the door is shut, not merely equally guarded
  const openRefusal = await bound2.request("channels/open", { type: "world", address: { world: "annex" } });
  check("…and channels/open cannot travel at all (no second lane to disagree)",
    openRefusal.error?.code === -32023, JSON.stringify(openRefusal.error));
  const stayed = await bound2.request("channels/list", {});
  check("a refused travel moved nothing", stayed.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stayed.result));

  const badName = await bound2.request("tools/call", { name: "travel", arguments: { world: "../etc/passwd" } });
  check("travel rejects a malformed world name, with the rule, and the body stays",
    badName.result?.isError === true && txt(badName) === `travel refused, so you're still in "commons": "../etc/passwd" isn't a valid world name; a name is 1 to 64 lowercase letters, digits, _ or -`, JSON.stringify(badName.result));
  bound2.ws.close();

  // ── 4i. PLAIN-MCP travel ─────────────────────
  // granted() is false for any non-MCPL client, so travelGate must not require channels.lifecycle of a plain-MCP host
  {
    const plain = await connectPlain("roamer-token");     // NO experimental.mcpl
    await sleep(1200);
    const tools = await plain.request("tools/list", {});
    check("plain-MCP host is offered the travel tool",
      (tools.result?.tools ?? []).some((t: any) => t.name === "travel"), "travel not listed");
    const moved = await plain.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel ACTUALLY WORKS (was always -32002)",
      !moved.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(moved)), txt(moved));
    plain.ws.close();

    // the credential still gates it: authority moved from a capability plain MCP can't hold to the credential it does
    const plainBound = await connectPlain("bound-token");  // worlds: ["commons"]
    await sleep(1200);
    const refused = await plainBound.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("plain-MCP travel still obeys the join policy",
      refused.result?.isError === true && /^travel refused, so you're still in "commons": world "annex" is outside the worlds this credential is limited to/.test(txt(refused)), txt(refused));
    const noCreate = await plainBound.request("tools/call", { name: "travel", arguments: { world: "never-made" } });
    check("plain-MCP founding outside the credential's narrowing is refused",
      noCreate.result?.isError === true && /^travel refused, so you're still in "commons": /.test(txt(noCreate)), txt(noCreate));
    check("…and refused founding left nothing on disk", !existsSync(join(worldsDir, "never-made")));
    plainBound.ws.close();
  }

  // ── 4k. THE WORLD DECIDES (docs/DESIGN-world-access.md) ───────────────────
  // no list goes where worlds let it; an owner closing a world refuses BEFORE anything moves; a grant from inside admits
  {
    const free = await connectHost("free-token");          // no `worlds`, no `create`
    await sleep(1200);
    // no founding by travel; an owner changes access with ordinary requests on @world (access, roles:<id>) via act;
    // whois finds the identity a role names
    const fm = txt(await free.request("tools/call", { name: "travel", arguments: { world: "free-place" } }));
    check("a credential with no list still can't found by travelling", /joining never founds/.test(fm), fm);
    const there = txt(await free.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("…and travels to an open world it was never listed for", /Arrived in "keep"/.test(there), there);
    // whois knows the people a world has seen act or remembers, never everyone
    await free.request("tools/call", { name: "say", arguments: { text: "hello, keep" } }); await sleep(300);
    const home = txt(await free.request("tools/call", { name: "travel", arguments: { world: "commons" } }));
    check("…and back", /Arrived in "commons"/.test(home), home);

    const owner = await connectHost("roamer-token");       // keep was founded for the roamer agent, so it owns it
    await sleep(1200);
    const ot = txt(await owner.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("the owner goes to its world", /Arrived in "keep"|Already in/.test(ot), ot);
    const closed = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: "access", value: { join: "listed" } } } });
    check("the owner agent closes it (set @world.access {join: listed})", !closed.result?.isError, txt(closed));
    const refused = await free.request("tools/call", { name: "travel", arguments: { world: "keep" } });
    check("travel into the closed world is refused, saying only that it isn't open",
      refused.result?.isError === true && /"keep" isn't open to you/.test(txt(refused)), txt(refused));
    const still = await free.request("channels/list", {});
    check("…and nothing moved", still.result?.channels?.[0]?.id === "world:commons", JSON.stringify(still.result));
    const fmap = txt(await free.request("tools/call", { name: "worlds", arguments: {} }));
    check("the closed world is not on the outsider's map", !/^- keep/m.test(fmap), fmap);
    const whoText = txt(await owner.request("tools/call", { name: "whois", arguments: { name: "free" } }));
    const freeId = (whoText.match(/u-[a-z2-7]{20}/) ?? [])[0];
    const granted = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: `roles:${freeId}`, value: { role: "inhabitant" } } } });
    check("the owner lets it in from inside the world (roles:<its identity>, found by whois)", !!freeId && !granted.result?.isError, `${whoText.slice(0, 200)} / ${txt(granted).slice(0, 300)}`);
    const inNow = txt(await free.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("…and now it travels in", /Arrived in "keep"/.test(inNow), inNow);
    // a member reads the closed world's geometry AS ITSELF: an anonymous /geom fetch reads as nonexistent
    const made = txt(await owner.request("tools/call", { name: "create", arguments: { model: "eidoverse/assets/models/crate_large_red.glb", at: [2, 2], components: { label: "accbox" } } }));
    await sleep(600);
    const meas = txt(await free.request("tools/call", { name: "measure", arguments: { id: "accbox" } }));
    check("measure works for a member of a closed world", !/no such world/.test(meas) && /accbox|geometry|bbox|crate/.test(meas), `${made.slice(0, 120)} / ${meas.slice(0, 300)}`);
    const reopened = await owner.request("tools/call", { name: "act", arguments: { verb: "delete", args: { id: "@world", component: "access" } } });
    check("the owner opens it again", !reopened.result?.isError, txt(reopened));
    free.ws.close(); owner.ws.close();
  }

  // ── 4l. AN AGENT RESUMES WHERE IT WAS ─────────────────────────────────────
  // a reconnect with no world lands where the agent last was, unless that world no longer admits it or its home
  // changed; an explicit ?world= always wins
  {
    const where = async (h: any) => (await h.request("channels/list", {})).result?.channels?.[0]?.id;
    const a1 = await connectHost("nofound-token");           // home commons, worlds ["*"]
    await sleep(1200);
    const t1 = txt(await a1.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("an agent travels to annex", /Arrived in "annex"/.test(t1), t1);
    a1.ws.close(); await sleep(600);
    const a2 = await connectHost("nofound-token", RESUME);
    await sleep(1200);
    check("reconnecting with no world asked for resumes in annex", (await where(a2)) === "world:annex", String(await where(a2)));
    a2.ws.close(); await sleep(600);
    const a3 = await connectHost("nofound-token", "&world=commons");
    await sleep(1200);
    check("an explicit ?world= still wins", (await where(a3)) === "world:commons", String(await where(a3)));
    a3.ws.close(); await sleep(600);
    const a4 = await connectHost("nofound-token", RESUME);
    await sleep(1200);
    check("…and is remembered: the next plain reconnect starts there (commons)", (await where(a4)) === "world:commons", String(await where(a4)));
    // the world it leaves is `keep`, which the roamer agent owns and closes with an ordinary request on @world
    const t4 = txt(await a4.request("tools/call", { name: "travel", arguments: { world: "keep" } }));
    check("on to keep", /Arrived in "keep"/.test(t4), t4);
    a4.ws.close(); await sleep(600);
    // the world it left no longer lets it in → home, not a refusal
    const owner = await connectHost("roamer-token", "&world=keep");
    await sleep(1200);
    const closedKeep = await owner.request("tools/call", { name: "act", arguments: { verb: "set", args: { id: "@world", component: "access", value: { join: "listed" } } } });
    check("the owner closes keep (set @world.access {join: listed})", !closedKeep.result?.isError, txt(closedKeep));
    const a5 = await connectHost("nofound-token", RESUME);
    await sleep(1200);
    check("an agent whose last world is now closed to it wakes up at home", (await where(a5)) === "world:commons", String(await where(a5)));
    a5.ws.close();
    const reopenedKeep = await owner.request("tools/call", { name: "act", arguments: { verb: "delete", args: { id: "@world", component: "access" } } });
    check("the owner reopens keep", !reopenedKeep.result?.isError, txt(reopenedKeep));
    owner.ws.close(); await sleep(600);
    // an operator who changes the agent's HOME has said where it lives now
    const a6 = await connectHost("nofound-token");
    await sleep(1200);
    const t6 = txt(await a6.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("annex once more", /Arrived in "annex"/.test(t6), t6);
    a6.ws.close(); await sleep(600);
    const reg = JSON.parse(readFileSync(tokensPath, "utf8"));
    // the new home is `keep`, an existing world: joining never founds one, and free-place must stay unfounded for 4k
    reg["nofound-token"].world = "keep";
    writeFileSync(tokensPath, JSON.stringify(reg));
    const a7 = await connectHost("nofound-token", RESUME);
    await sleep(1200);
    check("after its home claim changes, it starts at the new home, not the old memory", (await where(a7)) === "world:keep", String(await where(a7)));
    a7.ws.close();
    reg["nofound-token"].world = "commons";
    writeFileSync(tokensPath, JSON.stringify(reg));
    await sleep(300);
    // the trip HOME stays allowed after a resume: roamer2 (["annex"], home commons) must not read home from where it resumed
    const b1 = await connectHost("roamer2-token");
    await sleep(1200);
    const tb1 = txt(await b1.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("roamer2 (limited to annex) travels to annex", /Arrived in "annex"/.test(tb1), tb1);
    b1.ws.close(); await sleep(600);
    const b2 = await connectHost("roamer2-token", RESUME);
    await sleep(1200);
    check("roamer2 resumes in annex", (await where(b2)) === "world:annex", String(await where(b2)));
    const homeTrip = txt(await b2.request("tools/call", { name: "travel", arguments: { world: "commons" } }));
    check("…and may still travel home (its credential's home, not where it resumed)", /Arrived in "commons"/.test(homeTrip), homeTrip);
    const backTrip = txt(await b2.request("tools/call", { name: "travel", arguments: { world: "annex" } }));
    check("…and back to annex", /Arrived in "annex"/.test(backTrip), backTrip);
    b2.ws.close(); await sleep(600);
    // a DOOR RESTART: the memory is on disk, so it outlives the process
    await restartDoor();
    const b3 = await connectHost("roamer2-token", RESUME);
    await sleep(1200);
    check("after the door itself restarts, roamer2 resumes in annex", (await where(b3)) === "world:annex", String(await where(b3)));
    b3.ws.close(); await sleep(600);
  }

  // ── 4j. THE PLAIN-MCP RELAXATION MUST NOT WIDEN MCPL AUTHORITY ───────────
  // an MCPL host that declares mcpl but is denied channels.lifecycle must still be refused
  {
    const stingy = await connectHost("roamer-token");
    await sleep(1200);
    // re-declare an effective capability set WITHOUT channels.lifecycle
    await stingy.request("featureSets/update", {
      effectiveCapabilities: ["tools", "channels.register", "channels.publish", "channels.incoming"],
    });
    const denied2 = await stingy.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("MCPL host WITHOUT channels.lifecycle is still refused (#1 did not widen)",
      denied2.result?.isError === true && txt(denied2) === `travel refused, so you're still in "commons": your host hasn't granted this door channels.lifecycle, which travel needs, and calling again won't change that; if you need it, ask whoever runs your host`, txt(denied2));
    const where = await stingy.request("channels/list", {});
    check("…and that refusal moved nothing", where.result?.channels?.[0]?.id === "world:commons", JSON.stringify(where.result));
    stingy.ws.close();

    // discriminating half: the same credential as PLAIN MCP must SUCCEED (a `true &&` mutant refuses identically above)
    const samecred = await connectPlain("roamer-token");
    await sleep(1200);
    const plainOk = await samecred.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("…while the SAME credential as plain-MCP travels fine (the mcplClient conjunct is load-bearing)",
      !plainOk.result?.isError && /(Arrived in|Founded and entered) "annex"/.test(txt(plainOk)), txt(plainOk));
    samecred.ws.close();

    // MCPL-ness is fixed at initialize (assigned once in the prelude): moving that assignment out of the prelude fails here
    const escapee = await connectHost("roamer-token");
    await sleep(1200);
    await escapee.request("featureSets/update", {
      effectiveCapabilities: ["tools", "channels.register", "channels.publish", "channels.incoming"],
    });
    // becoming "plain MCP" mid-session must not be honoured
    await escapee.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},                       // <- no experimental.mcpl
      clientInfo: { name: "escapee", version: "0" },
    }).catch(() => { /* refusing a re-initialize outright is equally fine */ });
    const escape = await escapee.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("a denied host stays denied — MCPL-ness is fixed at initialize, not re-declarable",
      escape.result?.isError === true && /your host hasn't granted this door channels\.lifecycle/.test(txt(escape)), txt(escape));
    const stillOpen = await escapee.request("channels/list", {});
    check("…and the refused host is still in its own world, undisturbed",
      stillOpen.result?.channels?.[0]?.id === "world:commons", JSON.stringify(stillOpen.result));
    escapee.ws.close();
  }

  // ── 4k. the door must be OPEN in the new world (state-desync regression) ──
  // the new world announces initiallyOpen:true: door state is per-world (like the chat cursor), not session-long
  {
    const shutter = await connectHost("roamer-token");
    await sleep(1200);
    await shutter.request("channels/close", { channelId: "world:commons" });
    const moved2 = await shutter.request("tools/call", { name: "travel", arguments: { world: "annex" } });
    check("travel after closing the door still arrives", !moved2.result?.isError, txt(moved2));
    // a plain re-open of the CURRENT channel succeeds and reports the promised channel
    const reopened = await shutter.request("channels/open", { type: "world", address: { world: "annex" } });
    check("…and the new world's door is OPEN, as its descriptor promised the host",
      reopened.result?.channel?.id === "world:annex" && reopened.result?.channel?.initiallyOpen === true,
      JSON.stringify(reopened.result?.channel));
    // the world it left is no longer this connection's channel, and the refusals name it
    const stalePublish = await shutter.request("channels/publish", { channelId: "world:commons", content: [{ type: "text", text: "hello" }] });
    check("a publish to the world it left names the current channel, and that nothing was posted",
      stalePublish.error?.code === -32023 && /this connection's channel is "world:annex", and the publish named "world:commons", so nothing was posted/.test(stalePublish.error?.message ?? ""),
      JSON.stringify(stalePublish.error));
    const staleClose = await shutter.request("channels/close", { channelId: "world:commons" });
    check("…and so does a close of it",
      staleClose.error?.code === -32023 && /this connection's channel is "world:annex", and the request named "world:commons", so nothing was closed/.test(staleClose.error?.message ?? ""),
      JSON.stringify(staleClose.error));
    const namelessClose = await shutter.request("channels/close", {});
    check("…and a close naming no channel says so, not \"undefined\"",
      namelessClose.error?.code === -32023 && /and the request named nothing, so nothing was closed/.test(namelessClose.error?.message ?? ""),
      JSON.stringify(namelessClose.error));
    const crossed = await shutter.request("channels/open", { channelId: "world:annex", type: "world", address: { world: "commons" } });
    check("an open naming two different worlds says so, and opens nothing",
      crossed.error?.code === -32602 && /name different worlds, so nothing was opened/.test(crossed.error?.message ?? ""),
      JSON.stringify(crossed.error));
    shutter.ws.close();
  }

  // ── 5. attach failure → -32024 and the connection surfaces CLOSED ─────────
  // (last: it kills the sequencer)
  const victim = await connectHost("roamer-token");
  await sleep(1200);
  world.kill();                        // the sequencer goes away mid-session
  await sleep(500);
  const failed = await victim.request("tools/call", { name: "travel", arguments: { world: "annex" } });  // exists, so this tests ATTACH failure
  // the TOOL lane reports isError + text and must say the seat is gone (channels/open: -32024). The gate asks the
  // world (/access) before detaching, so a dead sequencer moves nothing.
  check("an unreachable world server refuses travel before anything moves",
    failed.result?.isError === true
    && /didn't say whether you may go to "annex", so nothing moved/.test(txt(failed)), txt(failed));
  // nothing detached, so the host's connection to the door is still there
  await sleep(500);
  check("…and the host's connection to the door was not torn down", victim.ws.readyState === WebSocket.OPEN, `readyState=${victim.ws.readyState}`);
  // a reconnect while the world server is DOWN must not move the memory: the resume check can't run
  {
    const before = JSON.parse(readFileSync(statePath, "utf8")).__world?.roamer2?.world;
    const c5 = await Promise.race([connectHost("roamer2-token", RESUME), sleep(8000).then(() => null)]);
    await sleep(3000);
    const after = JSON.parse(readFileSync(statePath, "utf8")).__world?.roamer2?.world;
    check("a reconnect while the world server is down keeps where the agent was", before === "annex" && after === "annex", `${before} → ${after}`);
    try { (c5 as any)?.ws?.close(); } catch { /* gone */ }
  }
} finally {
  // verified termination: kill(), then AWAIT exit (escalating to SIGKILL), or children hold ports mid-write
  for (const [name, child] of [["world", world], ["door", mcpl]] as const) {
    try { child.kill(); } catch { /* already gone */ }
    const outcome = await Promise.race([
      child.exited,
      new Promise<"timeout">((r) => setTimeout(() => r("timeout"), 5000)),
    ]);
    if (outcome === "timeout") {
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      await Promise.race([child.exited, new Promise((r) => setTimeout(r, 2000))]);
    }
    check(`${name} child terminated`, child.exitCode !== null || child.signalCode !== null,
      "still running after SIGTERM+SIGKILL");
  }

  // 🔴 SOURCE-TREE CLEANLINESS: a run that mutates repository state is contamination, not a receipt
  const after = existsSync(REPO_STATE)
    ? { exists: true, mtimeMs: statSync(REPO_STATE).mtimeMs, size: statSync(REPO_STATE).size }
    : { exists: false, mtimeMs: 0, size: 0 };
  check("repository mcpl/state.json untouched",
    after.exists === repoStateBefore.exists && after.mtimeMs === repoStateBefore.mtimeMs && after.size === repoStateBefore.size,
    `before=${JSON.stringify(repoStateBefore)} after=${JSON.stringify(after)}`);
  check("no repository mcpl/state.json.tmp left behind", !existsSync(`${REPO_STATE}.tmp`));
  // …and our temp state exists, so the override was HONOURED (or "untouched" passes when nothing persists)
  check("the door persisted to OUR state path", existsSync(statePath), statePath);
  check("no temp file left in our state dir", !existsSync(`${statePath}.tmp`));
  // no "-1" watermark reaches disk: lastSeq is -1 until the first snapshot, and a persisted -1 replays the whole log
  // as mentions
  {
    // watermarks persist under `__seq` (mcpl/net-server.ts persistState); an empty map means the check went blind
    const persisted = JSON.parse(readFileSync(statePath, "utf8")) as
      { __seq?: Record<string, number> };
    const seqs = persisted.__seq ?? {};
    check("watermarks were actually persisted (the check is reading the live key)",
      Object.keys(seqs).length > 0,
      `state file keys: ${JSON.stringify(Object.keys(persisted))}`);
    const negatives = Object.entries(seqs).filter(([, v]) => typeof v === "number" && v < 0);
    check("no unsynced (-1) watermark was persisted for any world",
      negatives.length === 0,
      `negatives: ${JSON.stringify(negatives)} | all: ${JSON.stringify(seqs)}`);
  }

  try { rmSync(worldsDir, { recursive: true, force: true }); } catch { /* best effort */ }
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
