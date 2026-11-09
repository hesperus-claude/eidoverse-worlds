// upload-cap-test — /upload's whole-body cap (UPLOAD_CAP, server/upload.ts readCappedBytes) on a scratch door at UPLOAD_CAP_MB=1:
// one byte over is refused in the cap's own words, with a length or chunked, and nothing is stored; exactly the cap is read.
// (image-upload-test's oversize row is refused by the narrower IMAGE_CAP, so it never reaches this one.)
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/server/upload-cap-test.ts
import { mkdirSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { scratchSequencer } from "../harness/harness.ts";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => { if (ok) passed++; else failed++; console.log(`  ${ok ? "ok  " : "FAIL"} ${name}${ok || !detail ? "" : ` — ${detail}`}`); };

const KEY = "test-door";
const env: Record<string, string> = { JOIN_TOKEN: KEY, UPLOAD_CAP_MB: "1", SKIP_OPT_SWEEP: "1" };   // OPT_DIR: the scratch's own store
const door = await scratchSequencer("uploadcap", { serverEnv: env, prepare: (scratch) => { env.OPT_DIR = join(scratch, "opt"); mkdirSync(env.OPT_DIR); } });
const OPT = env.OPT_DIR;
const up = async (body: Uint8Array | ReadableStream<Uint8Array>) => {
  const res = await fetch(`${door.BASE}/upload?${new URLSearchParams({ token: KEY, name: "cap.glb" })}`, { method: "POST", body });
  return { status: res.status, text: await res.text() };
};
try {
  const over = new Uint8Array(1_000_000 + 1);
  let u = await up(over);
  check("a model upload one byte over UPLOAD_CAP (with Content-Length): 413 in the whole-body cap's words", u.status === 413 && /^too large \(1MB cap\)/.test(u.text), `${u.status} ${u.text.slice(0, 80)}`);
  const chunks = [over.subarray(0, 400_000), over.subarray(400_000, 800_000), over.subarray(800_000)];
  u = await up(new ReadableStream({ pull(c) { const n = chunks.shift(); if (n) c.enqueue(n); else c.close(); } }));
  check("...and chunked, with no length to trust: 413, the same cap", u.status === 413 && /^too large \(1MB cap\)/.test(u.text), `${u.status} ${u.text.slice(0, 80)}`);
  const stored = (() => { try { return readdirSync(join(OPT, "store"), { recursive: true }).length; } catch { return 0; } })();
  check("...and nothing refused was stored", stored === 0, `${stored} entries under store/`);
  u = await up(new Uint8Array(1_000_000));
  check("exactly UPLOAD_CAP is read (refused for what it is, not its size)", u.status !== 413, `${u.status} ${u.text.slice(0, 80)}`);
} finally { await door.cleanup(failed ? 1 : 0); }
console.log(`\n[upload-cap-test] ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
