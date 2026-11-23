// bun test/mcpl/prelude-close-test.ts — a session that ends while the door's catch-up prelude waits on the world's
// history read leaves the prelude to stop, not to write a later watermark and start the 60 s seen-timer nothing clears
// (G2-059). A proxy in front of a scratch world holds the door's history request, so the close lands inside the await.
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { scratchSequencer, freePort, ROOT } from "../harness/harness.ts";
import { until, pause } from "../gate/wait.ts";
import { suite } from "../gate/suite.ts";

const S = suite("prelude-close"), { ok, done } = S;
const registry = { "late-token": { id: "late-reader", name: "Late reader", worlds: ["*"], create: true } };
let tokenPath = "";
const serverEnv: Record<string, string> = { SKIP_OPT_SWEEP: "1", HN_REQUIRE_LOGIN: "0" };
const h = await scratchSequencer("prelude-close", {
  worlds: ["commons"], serverEnv,
  prepare: (scratch) => { tokenPath = join(scratch, "tokens.json"); writeFileSync(tokenPath, JSON.stringify(registry)); serverEnv.AGENT_TOKENS_PATH = tokenPath; },
});

// the world, as the door sees it, except that a history request is held (never forwarded): the door's read waits it out
let held = 0;
type Link = { path: string; up?: WebSocket; queue: string[] | null };
const proxy = Bun.serve<Link>({ port: 0, hostname: "127.0.0.1",
  fetch(req, server) {
    const u = new URL(req.url);
    if (u.pathname.endsWith("/ws") && server.upgrade(req, { data: { path: u.pathname + u.search, queue: [] } })) return;
    const auth = req.headers.get("authorization");
    return fetch(h.BASE + u.pathname + u.search, { method: req.method, headers: auth ? { authorization: auth } : {}, body: req.body });
  },
  websocket: {
    open(ws) {
      const up = new WebSocket(h.BASE.replace("http", "ws") + ws.data.path); ws.data.up = up;
      up.onopen = () => { for (const m of ws.data.queue ?? []) up.send(m); ws.data.queue = null; };
      up.onmessage = (e) => ws.send(typeof e.data === "string" ? e.data : new Uint8Array(e.data as ArrayBuffer));
      up.onclose = () => ws.close();
    },
    message(ws, msg) {
      const s = String(msg);
      try { if (JSON.parse(s)?.type === "history") { held++; return; } } catch { /* not JSON: forward it */ }
      if (ws.data.queue) ws.data.queue.push(s); else ws.data.up!.send(s);
    },
    close(ws) { ws.data.up?.close(); },
  },
});

const port = freePort(h.PORT + 100);
const statePath = join(h.SCRATCH, "state.json"), examplePath = join(h.SCRATCH, "tokens.example.json");
writeFileSync(examplePath, "{}");
// a cursor for this agent in this world, so the prelude asks the world what was said since it
writeFileSync(statePath, JSON.stringify({ __seq: { "late-reader@commons": 0 } }));
const door = h.track(Bun.spawn([process.execPath, "mcpl/net-server.ts"], {
  cwd: ROOT,
  env: { ...process.env, HN_ISSUER_KEY: "", MCPL_PORT: String(port), MCPL_INSTANCE_NONCE: h.NONCE,
    WORLD_URL: `ws://127.0.0.1:${proxy.port}/ws`, WORLD_TOKEN: "", EIDO_MEDIA_PORT: "0",
    MCPL_TOKENS: tokenPath, MCPL_TOKENS_EXAMPLE: examplePath, MCPL_STATE: statePath },
  stdout: Bun.file(join(h.SCRATCH, "door.log")), stderr: Bun.file(join(h.SCRATCH, "door.stderr.log")),
}));
const seen = (): number | undefined => { try { return JSON.parse(readFileSync(statePath, "utf8"))["late-reader"]; } catch { return undefined; } };

let ws: WebSocket | undefined;
try {
  await until("door ready", async () => {
    if (door.exitCode !== null) throw new Error(`door exited ${door.exitCode}; logs at ${h.SCRATCH}`);
    try { return (await (await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(1000) })).text()).trim() === `ok ${h.NONCE}`; } catch { return false; }
  }, { ms: 8000 });
  ws = new WebSocket(`ws://127.0.0.1:${port}/?token=late-token`);
  let inited: boolean | string = false;
  ws.onmessage = (ev) => { for (const line of String(ev.data).split("\n").filter(Boolean)) { const m = JSON.parse(line); if (m.id === 1) inited = m.error ? JSON.stringify(m.error) : true; } };
  await until("host socket open", () => ws!.readyState === WebSocket.OPEN, { ms: 8000 });
  ws.send(JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "prelude-close-test", version: "1" } } }) + "\n");
  await until("initialized", () => inited, { ms: 15000 });
  if (inited !== true) throw new Error(`initialize refused: ${inited}`);
  ws.send(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
  await until("the prelude asked the world for history (held at the proxy)", () => held > 0, { ms: 8000 });
  ok(seen() === undefined, "before the close, nothing has written this agent's seen-time (the prelude is waiting on history)", seen());
  ws.close();
  const atClose = await until("the session's finally wrote the seen-time", () => seen(), { ms: 8000 });
  // the held read gives up after 8 s (agent.ts history); past that, a prelude that resumed would have written again
  await pause("the held history read times out", 10_000);
  const after = seen();
  ok(after === atClose, "G2-059 a session closed during the prelude's history read: nothing writes after its finally (the prelude stops)", { atClose, after });
} catch (error) {
  ok(false, "the sequence ran to its end", String(error));
  try { console.error(readFileSync(join(h.SCRATCH, "door.stderr.log"), "utf8").slice(-3000)); } catch { /* none */ }
} finally {
  ws?.close(); proxy.stop(true);
}
await h.cleanup(S.fail ? 1 : 0);
done();
