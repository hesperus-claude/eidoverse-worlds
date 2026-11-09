// Boot constants: env knobs, directories, cadences and server policy, plus the one side effect (WORLDS_DIR must exist
// before anything touches it). server.ts's FIRST import, so this runs before any other module's boot work.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { totalmem } from "node:os";
import { envNumber } from "./limits.ts";

export const PORT = envNumber("PORT", 8940, (n) => Number.isInteger(n) && n >= 1 && n <= 65535);
/** Default every interface; HOST=127.0.0.1 keeps a test world on this machine only. */
export const HOST = process.env.HOST ?? "0.0.0.0";
// Show-night door policy. Empty = open (dev on a tailnet). On a public box you
// MUST set this — the boot log shouts if you forgot. Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
// The RENDERERS' own credential (docs/decisions/WORLD-ACCESS.md): a renderer presenting it may WATCH any world, invite-only
// ones included (invisible, never authoring). Distinct from JOIN_TOKEN on purpose: the door key rides invite links and
// "renderer" is a flag any client can set, so the two together must never open a private world. Unset = none trusted.
export const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
export const UPLOAD_CAP = envNumber("UPLOAD_CAP_MB", 20, (n) => n > 0) * 1_000_000;
// narrower than the model door: a hung image is decoded into GPU memory on every client that sees it
export const IMAGE_CAP = envNumber("IMAGE_CAP_MB", 8, (n) => n > 0) * 1_000_000;
// RECORD_FRAMES=1: stage frames + roster deltas to worlds/<name>/frames-<bootTs>.jsonl. Clients are told at join:
// recording is never invisible.
export const RECORD = process.env.RECORD_FRAMES === "1";
// SKIP_OPT_SWEEP=1 skips both boot optimize sweeps (encode pump + ktx2/lod);
// serving worlds must be startable without shouldering the optimizer.
export const SKIP_OPT_SWEEP = process.env.SKIP_OPT_SWEEP === "1";
// TRUST_NAMES=1: a PRIVATE server (a dev box, the owner's own garden on 127.0.0.1) takes a typed name as an account,
// `local:<name>`, so its owner can be who they say without a login. Never set it on a server strangers can reach: there
// anyone typing the owner's name would BE the owner. Off by default; the server says so at boot.
export const TRUST_NAMES = process.env.TRUST_NAMES === "1";
// OPT_MEM_BUDGET_MB bounds the optimizer so serving never competes with encoding: each optimize child runs under
// RLIMIT_DATA of this many MB (Linux only; XNU ignores it), and an item whose ESTIMATED cost exceeds it is deferred (a
// `.deferred` marker, a count in /version). Default: half the usable memory (the cgroup limit when there is one, else
// physical memory). 0 = no cap, no gate.
function usableMemory(): number {
  try { const m = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()); if (m > 0) return Math.min(m, totalmem()); } catch { /* no cgroup v2 */ }
  return totalmem();
}
export const OPT_MEM_BUDGET_MB = envNumber("OPT_MEM_BUDGET_MB", Math.floor(usableMemory() / 2_000_000), (n) => n >= 0);
// Peak RSS of an optimize pass as a multiple of the source bytes, for the
// estimate above: measured 259MB for a 5.4MB store GLB (x48). The KTX2/LOD
// arms were not measured separately and are assumed the same order.
export const OPT_COST_FACTOR = envNumber("OPT_COST_FACTOR", 48, (n) => n > 0);
/** How long the pump waits on one optimize child before killing it (0 = never); read per child. */
export const optChildTimeoutMs = () => envNumber("OPT_CHILD_TIMEOUT_MS", 1_800_000);
// How long the screenshot broker (screenshots.ts) waits for a renderer's frame before GET /snap answers 504, in s.
// 12 suits a GPU renderer; a software one (SwiftShader) can need 10-20. At most 225: Bun.serve's idleTimeout cap (255)
// less a roamer's 25 s journey and 5 s slack; a larger value is refused and 12 used. The per-request deadline
// (screenshots.ts budgetMs) stretches to fit. A proxy must allow it: deploy/nginx-show.conf gives /snap 300 s.
export const SNAP_TIMEOUT_MS = envNumber("SNAP_TIMEOUT_SEC", 12, (n) => n > 0 && n <= 225) * 1000;
// How long after a start the screenshot broker waits before it sweeps parked roamers to agents' worlds
// (screenshots.ts sweep): renderers reconnecting after a restart rejoin the worlds they were in, and need the moment.
// Tests set 0.
export const SNAP_SWEEP_GRACE_MS = envNumber("SNAP_SWEEP_GRACE_SEC", 30, (n) => n >= 0 && n <= 600) * 1000;
// How often the broker sweeps besides a roamer joining (the backstop for anything else that leaves a world unserved).
export const SNAP_SWEEP_EVERY_MS = envNumber("SNAP_SWEEP_EVERY_SEC", 15, (n) => n >= 1 && n <= 3600) * 1000;
export const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the live worlds' logs (append-only and
// forever: a stray dev spawn is permanent).
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
// Where a world's verified copy goes before an in-place upgrade (server/backups.ts): beside WORLDS_DIR, never inside it.
export const BACKUPS_DIR = resolve(process.env.BACKUPS_DIR || join(WORLDS_DIR, "..", "backups"));
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
// Same doctrine as WORLDS_DIR: a dev or test instance points this elsewhere so it never writes derived variants or
// markers into the live store.
export const OPT_DIR = resolve(process.env.OPT_DIR ?? join(ROOT, "assets", "opt"));
try { mkdirSync(OPT_DIR, { recursive: true }); } catch { /* the first write will say why */ }   // an overridden OPT_DIR may not exist yet; the incarnation file lives here
// Deliberate ASSET fixes over the library, versioned in this repo (patched/README.md): /library serves these first, so
// every machine gets the fix by git pull while eidoverse-video stays pristine. Assets only, never engine code.
export const PATCH_DIR = resolve(process.env.PATCH_DIR ?? join(ROOT, "patched"));
// Optimized shadows of store uploads (draco+webp@1024, server/optimize.ts); originals in store/ are never touched.
// `.failed` markers stop hopeless files being retried every boot. The KTX2 shadow lives beside the original instead
// (store/<hash>.glb.ktx2.glb, server/store-variants.ts).
export const STORE_MIN = join(OPT_DIR, "store-min");
// The /library precedence ladder: patched fork > upload overlay > the asset library. Every walk of these dirs uses it.
export const LADDER = [PATCH_DIR, OPT_DIR, LIBRARY_DIR];

mkdirSync(WORLDS_DIR, { recursive: true });

/** The fold cache (server/statecache.ts) is rewritten every this many entries; 0 = off. Server policy: resuming 1000 entries
 *  costs ~4 ms at boot (fold ≈ 4.3 µs/entry measured), and a rewrite every 1000 is noise on the write path. */
export const STATE_CACHE_EVERY = envNumber("STATE_CACHE_EVERY", 1000, (n) => n >= 0);
/** A sim checkpoint once this many entries follow the last (authority checkpointSim): a boot replays at most this many; 0 = only after launches (cost: simckpt-check PC9). */
export const SIM_CHECKPOINT_EVERY = envNumber("SIM_CHECKPOINT_EVERY", 1000, (n) => n >= 0);
// ---- server policy: every limit a server runner may set, in one place (an operator surface reads these: WISHLIST) ----
/** One person's acts per window, logged entries (Matrix rc_message's shape; shared/protocol/authority/gate.js rateCheck). */
export const ACT_RATE = envNumber("ACT_RATE", 60, (n) => n > 0);
/** One person's says per window, counted apart from acts so chat and building can't starve each other. */
export const SAY_RATE = envNumber("SAY_RATE", 20, (n) => n > 0);
/** The act/say window, in seconds. */
const RATE_WINDOW_SEC = envNumber("RATE_WINDOW_SEC", 10, (n) => n > 0);
/** Bytes one account may make the log hold per window, in KiB. */
const RATE_KIB = envNumber("RATE_KIB", 256, (n) => n > 0);
/** Bytes one guest (no account) may make the log hold per window, in KiB. */
const ANON_RATE_KIB = envNumber("ANON_RATE_KIB", 32, (n) => n > 0);
/** The act rate as the authority takes it (injected: the authority is shared code, livehost opts.rate). */
export const RATE_POLICY = { n: ACT_RATE, says: SAY_RATE, ms: RATE_WINDOW_SEC * 1000, bytes: RATE_KIB * 1024, anonBytes: ANON_RATE_KIB * 1024 };
/** Seconds between two copies of one world (world-fork copies on the shared thread); 0 = no limit. */
export const FORK_GAP_SEC = envNumber("FORK_GAP_SEC", 60, (n) => n >= 0);
/** Copies one person may make per hour; 0 = no limit. */
export const FORK_PER_HOUR = envNumber("FORK_PER_HOUR", 5, (n) => n >= 0);
// Founding a world: no limits yet (server/worldlog.ts foundRefusal).
/** All messages per client per second — 15Hz of pose plus verbs plus slack; a token bucket with two seconds of burst
 *  (server/msgrate.ts), so a backlog the server itself caused isn't charged to the client. */
export const MSG_RATE = envNumber("MSG_RATE", 60, (n) => n > 0);

export const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Bytes of unsent backlog before we drop frames to a client. Keep TIGHT: nginx's and the kernel's buffers absorb a lot
// before Bun's bufferedAmount rises (33 s of latency once built up under 256KB). 32KB ≈ half a second of frames.
export const FRAME_SKIP_BUFFERED = 32_000;
