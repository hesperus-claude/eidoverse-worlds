// Boot constants (TEL0S_NOTES §15, step 7a): env knobs, directories, cadences, and the one side effect (WORLDS_DIR
// must exist first). server.ts imports it before any module with boot work of its own.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { totalmem } from "node:os";

export const PORT = Number(process.env.PORT ?? 8940);
/** Default every interface; HOST=127.0.0.1 keeps a test world on this machine only (research 44). */
export const HOST = process.env.HOST ?? "0.0.0.0";
// Empty = open (dev on a tailnet). A public box MUST set it (the boot log shouts). Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
// May WATCH any world, invisible, never authoring (docs/DESIGN-world-access.md). Never JOIN_TOKEN: the door key rides
// invite links and "renderer" is a flag any client sets, so together they must never open a private world.
export const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
export const UPLOAD_CAP = Number(process.env.UPLOAD_CAP_MB ?? 20) * 1_000_000;
// narrower than the model door: a hung image is decoded into GPU memory on every client that sees it
export const IMAGE_CAP = Number(process.env.IMAGE_CAP_MB ?? 8) * 1_000_000;
// RECORD_FRAMES=1: stage frames + roster deltas to worlds/<name>/frames-<bootTs>.jsonl. Clients are told at join:
// recording is never invisible.
export const RECORD = process.env.RECORD_FRAMES === "1";
// SKIP_OPT_SWEEP=1 skips both boot optimize sweeps (encode pump + ktx2/lod)
export const SKIP_OPT_SWEEP = process.env.SKIP_OPT_SWEEP === "1";
// TRUST_NAMES=1: a PRIVATE server takes a typed name as an account (`local:<name>`). Never on a server strangers can
// reach: anyone typing the owner's name would BE the owner.
export const TRUST_NAMES = process.env.TRUST_NAMES === "1";
// OPT_MEM_BUDGET_MB: each optimize child's RLIMIT_DATA (Linux only); an item estimated over it is deferred (`.deferred`).
// Default: half the usable memory (cgroup limit, else physical). 0 = no cap, no gate.
function usableMemory(): number {
  try { const m = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()); if (m > 0) return Math.min(m, totalmem()); } catch { /* no cgroup v2 */ }
  return totalmem();
}
// VALIDATED: not a finite number >= 0 falls back to the default with a warning (NaN silently disabled the cap)
function envNumber(name: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = process.env[name]?.trim();   // " " is not a number either — Number(" ") is 0
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not valid — using ${fallback}`);
  return fallback;
}
export const OPT_MEM_BUDGET_MB = envNumber("OPT_MEM_BUDGET_MB", Math.floor(usableMemory() / 2_000_000), (n) => n >= 0);
// peak RSS ÷ source bytes: measured 259MB for a 5.4MB GLB (x48); KTX2/LOD assumed the same order
export const OPT_COST_FACTOR = envNumber("OPT_COST_FACTOR", 48, (n) => n > 0);
// seconds; at most 225: Bun's 255 s idleTimeout less a roamer's 25 s journey and 5 s slack (snapshots.ts travelMs).
// A proxy must allow the longest wait: deploy/nginx-show.conf gives /snap 300 s (nginx's 60 s default cuts it).
export const SNAP_TIMEOUT_MS = envNumber("SNAP_TIMEOUT_SEC", 12, (n) => n > 0 && n <= 225) * 1000;
// before the first roamer sweep (snapshots.ts): renderers reconnecting after a restart need the moment. Tests set 0.
export const SNAP_SWEEP_GRACE_MS = envNumber("SNAP_SWEEP_GRACE_SEC", 30, (n) => n >= 0 && n <= 600) * 1000;
// the backstop for anything else that leaves a world unserved
export const SNAP_SWEEP_EVERY_MS = envNumber("SNAP_SWEEP_EVERY_SEC", 15, (n) => n >= 1 && n <= 3600) * 1000;
export const ROOT = resolve(import.meta.dir, "..");
// dev instances point this elsewhere: live logs are append-only and forever, so a stray dev spawn is permanent
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// the asset library checkout (models, VRMs, animations)
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
// as WORLDS_DIR: a dev or test instance points this elsewhere, never writing into the live store (#172)
export const OPT_DIR = resolve(process.env.OPT_DIR ?? join(ROOT, "assets", "opt"));
try { mkdirSync(OPT_DIR, { recursive: true }); } catch { /* the first write will say why */ }   // an overridden OPT_DIR may not exist yet; the incarnation file lives here
// ASSET fixes over the library (patched/README.md), served first; assets only (§24j), each a candidate for upstreaming
export const PATCH_DIR = resolve(process.env.PATCH_DIR ?? join(ROOT, "patched"));
// optimized shadows (server/optimize.ts); originals never touched; `.failed` stops retries; KTX2 lives beside the original
export const STORE_MIN = join(OPT_DIR, "store-min");
// The /library precedence ladder: every walk of these dirs spells it this way (seats.ts: what a wrong order costs)
export const LADDER = [PATCH_DIR, OPT_DIR, LIBRARY_DIR];

mkdirSync(WORLDS_DIR, { recursive: true });

/** Per client per second, two seconds of burst (server/msgrate.ts): a backlog the server caused isn't the client's. */
export const MSG_RATE = Number(process.env.MSG_RATE ?? 60);

export const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Keep TIGHT: proxy and kernel buffers absorb a lot first (33 s of latency never tripped 256KB). 32KB ≈ half a second.
export const FRAME_SKIP_BUFFERED = 32_000;
