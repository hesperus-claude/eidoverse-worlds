// The sequencer's side of the build check: one at a time, each in its own process (server/buildcheck-run.ts), cached
// by model digest + scale + CHECK_VERSION. The worker checks a snapshot of the hashed bytes, never the path.
// GET /check is public, so everything is bounded (a cached or running answer is never refused). Scale isn't bucketed
// coarser than 0.01: verdicts are thresholds on scaled geometry. The queue moves on whatever the worker does.

import { mkdirSync, readdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { OPT_DIR, ROOT } from "./config.ts";
import { atomicWrite } from "./fsutil.ts";
import { windowLimiter } from "./ratewindow.ts";

/** Bump when what a check finds changes (buildcheck.ts, navgrid moves, collider rules): older reports go stale. */
export const CHECK_VERSION = 4;   // 4: the walking body is MOVER.body (radius 0.2, was 0.32)
/** Tests swap the runner for a misbehaving one. */
export const checkConfig = {
  runner: join(ROOT, "server", "buildcheck-run.ts"),
  timeoutMs: 90_000,
  /** after the soft stop, how long before SIGKILL */
  graceMs: 3_000,
  /** a report is a few KB; more is not a report */
  maxOut: 4 << 20,
  /** jobs waiting behind the running one, and the bytes of their snapshots on disk */
  queueMax: 16,
  queueBytes: 256 << 20,
  /** in memory, and files in OPT_DIR/checks */
  memoMax: 512,
  diskMax: 4096,
};
/** New checks a minute, per address and process-wide (a cached answer costs nothing). */
export const CHECK_PER_ADDRESS = 10;
export const CHECK_PER_MINUTE = 60;
const checkGate = windowLimiter(CHECK_PER_ADDRESS, CHECK_PER_MINUTE);
/** Refused before any work: 429 (rate) or 503 (queue full), with a retry. */
export class CheckRefused extends Error {
  constructor(message: string, readonly status: 429 | 503, readonly retryAfter: number) { super(message); }
}
/** to 2 places */
export const CHECK_SCALE = { min: 0.05, max: 20 };

const memo = new Map<string, unknown>();
const running = new Map<string, Promise<unknown>>();
const digests = new Map<string, { id: string; digest: string }>();
let queue: Promise<unknown> = Promise.resolve();
let waiting = 0, heldBytes = 0;
/** One snapshot per distinct model in the queue. */
const snaps = new Map<string, { refs: number; bytes: number; written: Promise<unknown> }>();
/** Tests only. */
export const checkStats = () => ({ waiting, heldBytes, snapshots: snaps.size, memo: memo.size, running: running.size });
export const resetCheckBudget = () => checkGate.reset();

/** Most recent last; the oldest go past memoMax. */
function remember(key: string, report: unknown) {
  memo.delete(key); memo.set(key, report);
  while (memo.size > checkConfig.memoMax) memo.delete(memo.keys().next().value!);
}
/** Down to 90% of diskMax, so this isn't run per write. */
function pruneDisk() {
  const dir = join(OPT_DIR, "checks");
  let names: string[];
  try { names = readdirSync(dir).filter((n) => n.endsWith(".json")); } catch { return; }
  if (names.length <= checkConfig.diskMax) return;
  const aged = names.map((n) => { try { return { n, t: statSync(join(dir, n)).mtimeMs }; } catch { return { n, t: 0 }; } }).sort((a, b) => a.t - b.t);
  for (const { n } of aged.slice(0, names.length - Math.floor(checkConfig.diskMax * 0.9))) try { unlinkSync(join(dir, n)); } catch { /* gone */ }
}

const diskPath = (key: string) => join(OPT_DIR, "checks", `${Bun.hash(key).toString(16)}.json`);

/** finite, clamped, two places */
export function checkScale(s: unknown): number {
  const n = typeof s === "string" ? Number(s) : typeof s === "number" ? s : 1;
  if (!Number.isFinite(n) || n <= 0) return 1;
  return Math.round(Math.min(CHECK_SCALE.max, Math.max(CHECK_SCALE.min, n)) * 100) / 100;
}

const sha256 = (bytes: Uint8Array) => new Bun.CryptoHasher("sha256").update(bytes).digest("hex");
const statId = (file: string) => { const st = statSync(file); return `${st.size}|${st.mtimeMs}|${st.ctimeMs}|${st.ino}`; };

/** `bytes` spares a re-read. The worker checks a snapshot of the hashed bytes, never `file`, so a report always
 *  answers for the digest it is filed under. */
export async function checkFile(file: string, scale = 1, bytes?: Uint8Array, opts: { address?: string } = {}): Promise<unknown> {
  const s = checkScale(scale);
  let id: string;
  try { id = statId(file); } catch { throw new Error("no such file"); }
  // an unchanged file is answered without reading it
  const known = digests.get(file);
  if (!bytes && known?.id === id) {
    const hit = cached(`${CHECK_VERSION}|${known.digest}|${s}`);
    if (hit !== undefined) return hit;
  }
  // otherwise its bytes, read once (asynchronously), name the check
  const data = bytes ?? new Uint8Array(await Bun.file(file).arrayBuffer());
  const digest = sha256(data);
  digests.set(file, { id, digest });   // the id from before the read: a change during it shows next time
  const key = `${CHECK_VERSION}|${digest}|${s}`;
  const hit = cached(key);
  if (hit !== undefined) return hit;
  const inflight = running.get(key);
  if (inflight) return inflight;
  // the queue's room first (a refusal there spends no one's budget), then the asker's grant
  const newBytes = snaps.has(digest) ? 0 : data.length;
  if (waiting >= checkConfig.queueMax || (heldBytes > 0 && heldBytes + newBytes > checkConfig.queueBytes))
    throw new CheckRefused(`the build check's queue is full (${waiting} waiting) — ask again in a minute`, 503, 60);
  if (opts.address !== undefined) {
    const g = checkGate.grant(opts.address);
    if (!g.ok) throw new CheckRefused(g.which === "address"
      ? `build check rate limit (${CHECK_PER_ADDRESS} new checks a minute) — a checked model is answered at once; try again in ${g.retryAfter}s`
      : `the server is busy checking models (${CHECK_PER_MINUTE} new checks a minute in all) — try again in ${g.retryAfter}s`, 429, g.retryAfter);
  }
  // frozen: the worker reads this copy of the hashed bytes, never the mutable path
  const jobs = join(OPT_DIR, "checks", "jobs");
  const snapshot = join(jobs, `${digest}.glb`);
  let snap = snaps.get(digest);
  if (!snap) {
    mkdirSync(jobs, { recursive: true });
    snap = { refs: 0, bytes: data.length, written: Bun.write(snapshot, data) };
    snaps.set(digest, snap); heldBytes += data.length;
  }
  snap.refs++; waiting++;
  const mine = snap;
  const run = queue.then(async () => {
    waiting--;
    try {
      await mine.written;
      const report: any = await runWorker(snapshot, s);
      remember(key, report);
      try { atomicWrite(diskPath(key), JSON.stringify({ key, version: CHECK_VERSION, digest, scale: s, file, report })); pruneDisk(); }
      catch { /* memory still has it */ }
      return report;
    } finally {
      if (--mine.refs === 0) { snaps.delete(digest); heldBytes -= mine.bytes; try { unlinkSync(snapshot); } catch { /* gone */ } }
    }
  });
  running.set(key, run);
  queue = run.catch(() => {});
  void run.finally(() => running.delete(key)).catch(() => {});
  return run;
}

function cached(key: string): unknown {
  if (memo.has(key)) { const r = memo.get(key); remember(key, r); return r; }
  try {
    const d = JSON.parse(readFileSync(diskPath(key), "utf8"));
    if (d?.key === key) { remember(key, d.report); return d.report; }
  } catch { /* not checked yet */ }
  return undefined;
}

/** Keeps at most `cap` bytes (head, or tail) but always drains, so the writer never blocks on a full pipe. */
async function drain(stream: ReadableStream<Uint8Array>, cap: number, tail = false): Promise<{ text: string; over: boolean }> {
  const parts: Uint8Array[] = [];
  let kept = 0, over = false;
  const reader = stream.getReader();
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      if (tail) {
        parts.push(value); kept += value.length;
        while (parts.length > 1 && kept - parts[0].length >= cap) kept -= parts.shift()!.length;
      } else if (kept < cap) {
        const take = value.subarray(0, cap - kept);
        parts.push(take); kept += take.length;
        if (take.length < value.length) over = true;
      } else over = true;
    }
  } catch { /* the stream died with the process */ }
  return { text: Buffer.concat(parts).toString("utf8"), over };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function runWorker(file: string, scale: number): Promise<unknown> {
  const { runner, timeoutMs, graceMs, maxOut } = checkConfig;
  const proc = Bun.spawn([process.execPath, runner, file, String(scale)], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
  const out = drain(proc.stdout as ReadableStream<Uint8Array>, maxOut);
  const err = drain(proc.stderr as ReadableStream<Uint8Array>, 8 << 10, true);
  let stopped = false;
  const term = setTimeout(() => { stopped = true; try { proc.kill("SIGTERM"); } catch { /* gone */ } }, timeoutMs);
  const kill = setTimeout(() => { try { proc.kill("SIGKILL"); } catch { /* gone */ } }, timeoutMs + graceMs);
  // the queue is never held past the hard kill plus a grace, whatever the process does
  const exited = await Promise.race([proc.exited.then(() => true), sleep(timeoutMs + 2 * graceMs).then(() => false)]);
  clearTimeout(term); clearTimeout(kill);
  if (!exited) {
    console.warn(`[check] worker ${proc.pid} for ${file} did not exit after SIGKILL — abandoned`);
    throw new Error("the check timed out");
  }
  if (stopped) throw new Error("the check timed out");
  // its pipes close with it; a grandchild holding them open doesn't hold the queue
  const [o, e] = await Promise.all([
    Promise.race([out, sleep(graceMs).then(() => ({ text: "", over: true }))]),
    Promise.race([err, sleep(graceMs).then(() => ({ text: "", over: false }))])]);
  if (o.over) throw new Error("the check's output was not a report");
  let report: any;
  try { report = JSON.parse(o.text.trim().split("\n").pop() ?? ""); }
  catch {
    if (e.text.trim()) console.warn(`[check] ${file}: ${e.text.trim().split("\n").slice(-3).join(" | ")}`);
    throw new Error("the check failed");
  }
  if (report?.error) throw new Error(report.error);
  return report;
}
