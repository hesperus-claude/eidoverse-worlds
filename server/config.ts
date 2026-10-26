// eidoverse-worlds sequencer — boot constants (TEL0S_NOTES §15, step 7a).
// Env knobs, directories, and cadences, plus the one directory side effect
// (WORLDS_DIR must exist before anything touches it). This module is
// server.ts's FIRST import, so everything here runs before any other
// module's boot work — the same order the constants had inline.

import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { totalmem } from "node:os";

export const PORT = Number(process.env.PORT ?? 8940);
/** Where the server listens. Default every interface, as always; HOST=127.0.0.1 keeps a test world on this machine
 *  only (research 44: R's first world is served locally, and exposed on the tailnet separately, after a check). */
export const HOST = process.env.HOST ?? "0.0.0.0";
// Show-night door policy. Empty = open (dev on a tailnet). On a public box you
// MUST set this — the boot log shouts if you forgot. Checked at join and upload.
export const JOIN_TOKEN = process.env.JOIN_TOKEN ?? "";
// The RENDERERS' credential (docs/DESIGN-world-access.md): a renderer presenting it may WATCH any world, invisible and
// never authoring. Distinct from JOIN_TOKEN on purpose: the door key rides invite links and "renderer" is a flag any client
// sets, so the two together must never open a private world. Unset = no renderer trusted beyond what the world allows.
export const RENDERER_TOKEN = process.env.RENDERER_TOKEN ?? "";
export const UPLOAD_CAP = Number(process.env.UPLOAD_CAP_MB ?? 20) * 1_000_000;
// Pictures are textures, not models: a hung image is decoded into GPU memory
// on every client that sees it, so the door is narrower than the model door.
export const IMAGE_CAP = Number(process.env.IMAGE_CAP_MB ?? 8) * 1_000_000;
// RECORD_FRAMES=1 appends every broadcast stage frame (plus roster deltas) to worlds/<name>/frames-<bootTs>.jsonl: with
// the log and store, enough to re-render offline. Clients are told at join: recording is never invisible.
export const RECORD = process.env.RECORD_FRAMES === "1";
// SKIP_OPT_SWEEP=1 skips both boot optimize sweeps (encode pump + ktx2/lod);
// serving worlds must be startable without shouldering the optimizer.
export const SKIP_OPT_SWEEP = process.env.SKIP_OPT_SWEEP === "1";
// TRUST_NAMES=1: a PRIVATE server (a dev box, the owner's own garden on 127.0.0.1) takes a typed name as an account,
// `local:<name>`, so its owner can be who they say without a login. Never set it on a server strangers can reach: there
// anyone typing the owner's name would BE the owner (round-2 review R2). Off by default; the server says so at boot.
export const TRUST_NAMES = process.env.TRUST_NAMES === "1";
// OPT_MEM_BUDGET_MB: each optimize child runs under RLIMIT_DATA of this (Linux only; XNU ignores it), and an item whose
// estimated cost exceeds it is deferred (a `.deferred` marker, counted in /version), not attempted. Default: half the
// usable memory (the cgroup limit if any, else physical). 0 = no cap, no gate.
function usableMemory(): number {
  try { const m = Number(readFileSync("/sys/fs/cgroup/memory.max", "utf8").trim()); if (m > 0) return Math.min(m, totalmem()); } catch { /* no cgroup v2 */ }
  return totalmem();
}
// Env values are VALIDATED: a budget that is not a finite number >= 0 ("banana", -1) falls back to the default
// with a warning — NaN used to disable the cap silently and serialise as null; a negative one deferred everything.
function envNumber(name: string, fallback: number, ok: (n: number) => boolean): number {
  const raw = process.env[name]?.trim();   // " " is not a number either — Number(" ") is 0
  if (raw === undefined || raw === "") return fallback;
  const n = Number(raw);
  if (Number.isFinite(n) && ok(n)) return n;
  console.warn(`[config] ${name}=${JSON.stringify(raw)} is not valid — using ${fallback}`);
  return fallback;
}
export const OPT_MEM_BUDGET_MB = envNumber("OPT_MEM_BUDGET_MB", Math.floor(usableMemory() / 2_000_000), (n) => n >= 0);
// Peak RSS of an optimize pass as a multiple of the source bytes, for the
// estimate above: measured 259MB for a 5.4MB store GLB (x48). The KTX2/LOD
// arms were not measured separately and are assumed the same order.
export const OPT_COST_FACTOR = envNumber("OPT_COST_FACTOR", 48, (n) => n > 0);
// GET /snap's frame wait (SNAP_TIMEOUT_SEC, default 12; software renderers can need 10-20). At most 225: Bun's 255 s
// idleTimeout less a roamer's 25 s journey and 5 s slack; journey, waits and frame share one deadline (snapshots.ts budgetMs).
// A proxy must allow the longest wait: deploy/nginx-show.conf gives `location = /snap` 300 s (nginx's 60 s default cuts it).
export const SNAP_TIMEOUT_MS = envNumber("SNAP_TIMEOUT_SEC", 12, (n) => n > 0 && n <= 225) * 1000;
// How long after a start the snapshot broker waits before it sweeps parked roamers to agents' worlds
// (snapshots.ts sweep): renderers reconnecting after a restart rejoin the worlds they were in, and need the moment.
// Tests set 0.
export const SNAP_SWEEP_GRACE_MS = envNumber("SNAP_SWEEP_GRACE_SEC", 30, (n) => n >= 0 && n <= 600) * 1000;
// How often the broker sweeps besides a roamer joining (the backstop for anything else that leaves a world unserved).
export const SNAP_SWEEP_EVERY_MS = envNumber("SNAP_SWEEP_EVERY_SEC", 15, (n) => n >= 1 && n <= 3600) * 1000;
export const ROOT = resolve(import.meta.dir, "..");
// Dev instances point this elsewhere so a scratch sequencer can't append to the
// live worlds' logs (they are append-only and forever — a stray dev spawn is
// permanent). Default keeps the production path unchanged.
export const WORLDS_DIR = resolve(process.env.WORLDS_DIR ?? join(ROOT, "worlds"));
// The eidoverse-video checkout = the asset library (models, VRMs, animations).
export const LIBRARY_DIR = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));
// Same doctrine as WORLDS_DIR: a dev or test instance points this elsewhere so it can never write derived
// variants or markers into the live store (#172).
export const OPT_DIR = resolve(process.env.OPT_DIR ?? join(ROOT, "assets", "opt"));
try { mkdirSync(OPT_DIR, { recursive: true }); } catch { /* the first write will say why */ }   // an overridden OPT_DIR may not exist yet; the incarnation file lives here
// Deliberate ASSET fixes over the library, versioned here (patched/README.md): /library serves them first, so every machine
// gets a fix by git pull. Assets only (§24j), each a candidate for upstreaming; a test instance points it elsewhere.
export const PATCH_DIR = resolve(process.env.PATCH_DIR ?? join(ROOT, "patched"));
// Optimized shadows of store uploads (draco+webp@1024, server/optimize.ts); originals are never touched, and `.failed`
// markers stop hopeless files retrying every boot. The KTX2 shadow lives beside the original (server/store-variants.ts).
export const STORE_MIN = join(OPT_DIR, "store-min");
// The /library precedence ladder, NAMED: patched fork > upload overlay
// > the asset library. Every walk of these three dirs should spell it this
// way — seats.ts documents what a wrong-order copy costs.
export const LADDER = [PATCH_DIR, OPT_DIR, LIBRARY_DIR];

mkdirSync(WORLDS_DIR, { recursive: true });

/** How many entries may accumulate past a snapshot before folding again.
 *  Small enough that a joiner's tail stays trivial, large enough that a busy
 *  world is not writing a snapshot per action. */
export const FOLD_EVERY = Number(process.env.FOLD_EVERY ?? 150);
/** Authored verbs allowed per client per 4s. A griefer gets silence; a person
 *  arranging furniture must not. Configurable because a build session and a
 *  show night want different answers. */
export const VERB_RATE = Number(process.env.VERB_RATE ?? 12);
/** All messages per client per second — 15Hz of pose plus verbs plus slack; a token bucket with two seconds of burst
 *  (server/msgrate.ts), so a backlog the server itself caused isn't charged to the client. */
export const MSG_RATE = Number(process.env.MSG_RATE ?? 60);

export const FRAME_MS = 66;                 // ~15Hz, matches the client's send throttle
// Bytes of unsent backlog before frames to a client drop. Keep TIGHT: nginx's and the kernel's buffers absorb a lot
// before bufferedAmount rises (33 s of latency never tripped 256KB). 32KB ≈ half a second: a slow client skips ahead.
export const FRAME_SKIP_BUFFERED = 32_000;
