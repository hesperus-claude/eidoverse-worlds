// surface-matrix-owned.ts: owns the server surface-test.py inspects (free port, scratch worlds, per-run join token, child
// diagnostics). The served /version startedAt must postdate this harness's start, so a stale server on the port fails loudly.
//   bun tools/surface-matrix-owned.ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds } from "./harness.ts";

const PORT = 8420 + (process.pid % 150);
const worldsDir = mkdtempSync(join(tmpdir(), "eido-surfmatrix-"));
foundWorlds(worldsDir, ["ownprobe", "surftest", "elsewhere"]);   // joining never founds a world
const TOK = `surf-${Math.random().toString(36).slice(2, 10)}`;   // per-run fixture

// own the AGENT-token fixture too (AGENT_TOKENS_PATH): the run never borrows the checkout's mcpl/tokens.json
const agentTokensPath = join(worldsDir, "agent-tokens.json");
writeFileSync(agentTokensPath, JSON.stringify({
  "surf-lab-hesp": { id: "hesp" },
  "surf-lab-hesp2": { id: "hesp2" },
  "surf-lab-hesp3": { id: "hesp3" },
  "surf-lab-w2o": { id: "watcher2-owner" },
}));

const server = Bun.spawn(["bun", "server/server.ts"], {
  env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: TOK, AGENT_TOKENS_PATH: agentTokensPath,
    SKIP_OPT_SWEEP: "1" },
  stdout: "pipe", stderr: "pipe",
});
const drain = async (label: string, stream: unknown) => {
  const text = await new Response(stream as ReadableStream).text().catch(() => "");
  if (text.trim()) console.log(`--- server ${label} (tail) ---\n${text.split("\n").slice(-20).join("\n")}`);
};

let code = 1;
try {
  // readiness + ownership in ONE probe: only our child knows the per-run JOIN_TOKEN, so a foreign listener refuses our join
  let owned = false;
  for (let i = 0; i < 40 && !owned; i++) {
    await new Promise((r) => setTimeout(r, 250));
    owned = await new Promise<boolean>((res) => {
      const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
      const t = setTimeout(() => { ws.close(); res(false); }, 1500);
      ws.onopen = () => ws.send(JSON.stringify({ type: "join", token: TOK, world: "ownprobe", id: "harness-probe", spectate: true, replica: true }));
      ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data));
        clearTimeout(t);
        if (m.type === "snapshot") { ws.close(); res(true); }
        else { ws.close(); throw new Error(`port ${PORT} is served by a server that refused OUR token — foreign process, refusing to test it (${JSON.stringify(m).slice(0, 80)})`); } };
      ws.onerror = () => { clearTimeout(t); res(false); };
    });
  }
  if (!owned) throw new Error("owned server never became ready");
  console.log(`owned server up on :${PORT} (worlds: ${worldsDir}, per-run token)`);

  const py = Bun.spawn(["python3", "tools/surface-test.py"], {
    env: { ...process.env, SURF_URL: `ws://127.0.0.1:${PORT}/ws`, SURF_TOK: TOK },
    stdout: "inherit", stderr: "inherit",
  });
  code = await py.exited;
} catch (e) {
  console.log(`\x1b[31mFATAL\x1b[0m ${(e as Error).message}`);
  await drain("out", server.stdout); await drain("err", server.stderr);
} finally {
  server.kill();
}
process.exit(code);
