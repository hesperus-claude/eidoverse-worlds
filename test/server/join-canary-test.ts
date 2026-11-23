// tools/operator/join-canary.mjs against a stub server whose /ws admits one key and closes any other 4003.
//   bun test/server/join-canary-test.ts
// The canary builds its socket URL from the one it is given; a trailing slash once made //ws, which /ws doesn't match (G2-098).
import { join } from "node:path";
import { suite } from "../gate/suite.ts";

const { ok, done } = suite("join-canary");
const CANARY = join(import.meta.dir, "..", "..", "tools", "operator", "join-canary.mjs");
const server = Bun.serve({
  port: 0,
  fetch(req, s) { return new URL(req.url).pathname === "/ws" && s.upgrade(req) ? undefined : new Response("not found", { status: 404 }); },
  websocket: { message(ws, m) { const j = JSON.parse(String(m)); if (j.token === "good") ws.send(JSON.stringify({ type: "snapshot" })); else ws.close(4003, "bad key"); } },
});
const run = async (url: string) => { const p = Bun.spawn(["bun", CANARY, url, "porch", "good"], { stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text(); return { code: await p.exited, out: out.trim() }; };
const base = `http://127.0.0.1:${server.port}`;
const plain = await run(base), slashed = await run(`${base}/`), many = await run(`${base}//`);
ok(plain.code === 0, "JC1 the canary passes against a server that admits the good key and refuses a made-up one", plain);
ok(slashed.code === 0 && many.code === 0, "JC2 a URL with trailing slashes reaches the same /ws (G2-098)", { slashed, many });
server.stop(true);
done();
