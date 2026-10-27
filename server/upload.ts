// Live asset ingestion (TEL0S_NOTES §15, 7c): POST /upload (models, avatars, pictures, sounds, scripts), its per-IP
// rate windows, and the optimize queue that builds each upload's shadows off the request path, plus the boot sweeps.

import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, rmSync } from "node:fs";
import { addressOf } from "./peer.ts";
import { join, basename, dirname, relative } from "node:path";
import { JOIN_TOKEN, UPLOAD_CAP, IMAGE_CAP, ROOT, OPT_DIR, STORE_MIN, LIBRARY_DIR, SKIP_OPT_SWEEP, OPT_MEM_BUDGET_MB, OPT_COST_FACTOR } from "./config.ts";
import { isStoreOriginal, ktx2VariantPath, lodVariantPath, storeShadowsMissing, verdictStands, freshOver, diskIdentity, sourceSidecar, recordedSource, sameIdentity, verdictMarker, readVerdict, KTX2_RECIPE, LOD_RECIPE } from "./store-variants.ts";
import { agentTokens, aid1JoinIdentity, sessionFromCookie } from "./auth.ts";
import { worlds } from "./world.ts";
import { atomicWrite } from "./fsutil.ts";
import { ingestHeightmap } from "./heightmap.ts";
import { checkFile } from "./buildcheck-queue.ts";
import { envNumber } from "./limits.ts";

/** The socket address behind the nginx front. */
type UploadSrv = { requestIP(req: Request): { address: string } | null };

const uploadWin = new Map<string, { t: number; n: number }>(); // per IP
let tripoImportBusy = false;   // one at a time: they cost CPU-seconds

// ---- store optimization -----------------------------------------------------
// a SUBPROCESS, one file at a time: draco is CPU-seconds of synchronous wasm that would freeze pose relay
type OptItem = { src: string; dest: string; mode?: "--ktx2" | "--ktx2-vrm" | "--ktx2-img" | "--lod"; force?: boolean };
const optQueue: OptItem[] = [];
let optRunning = false;
let ktx2Skip = false; // a --ktx2 run exited 3 (no encoder): stop queuing variants this boot
let lodEncoderWarned = false; // never sets ktx2Skip
/** Older recipe generations are dead (the recipe is in the URL): pruned on a bake AND a refusal. */
function pruneOldLodGenerations(src: string, dest: string) {
  const base = basename(src), dir = dirname(dest);
  const keep = new Set([dest, `${dest}.failed`, `${dest}.deferred`, `${dest}.srcid`]);
  for (const f of readdirSync(dir)) {
    const p = join(dir, f);
    if (f.startsWith(`${base}.lod.`) && /\.glb(\.failed|\.deferred|\.srcid)?$/.test(f) && !keep.has(p))
      try { rmSync(p); } catch { /* best effort */ }
  }
}

// items this host couldn't afford: informational for /version, never blocking a retry; the markers persist
const optDeferred = new Set<string>();
if (process.env.OPT_CMD) console.warn(`[optimize] OPT_CMD=${process.env.OPT_CMD} — a stand-in optimizer is in charge of every variant this boot`);
export function optStatus() {
  return { budgetMB: OPT_MEM_BUDGET_MB, queued: optQueue.length, running: optRunning, deferred: optDeferred.size };
}
function undefer(dest: string) {
  optDeferred.delete(dest);
  if (existsSync(`${dest}.deferred`)) try { rmSync(`${dest}.deferred`); } catch { /* best effort */ }
}
function defer(dest: string, why: string) {
  optDeferred.add(dest);
  try { mkdirSync(dirname(dest), { recursive: true }); writeFileSync(`${dest}.deferred`, why); } catch { /* best effort */ }
  console.log(`[optimize] deferred ${basename(dest)} — ${why}`);
}
export function queueOptimize(absPath: string) {
  let pushed = false;
  if (!optQueue.some((q) => q.src === absPath && !q.mode)) {
    optQueue.push({ src: absPath, dest: join(STORE_MIN, basename(absPath)) });
    pushed = true;
  }
  // KTX2 encodes from the ORIGINAL (the best bytes; store-min has been wrong before, #122)
  if (!ktx2Skip && !optQueue.some((q) => q.src === absPath && q.mode === "--ktx2")) {
    optQueue.push({ src: absPath, dest: ktx2VariantPath(absPath), mode: "--ktx2" });
    pushed = true;
  }
  // NOT gated on ktx2Skip (an untextured object needs no encoder); the CLI fails closed on anything skinned, judged
  // from the raw container, never a filename
  if (!optQueue.some((q) => q.src === absPath && q.mode === "--lod")) {
    optQueue.push({ src: absPath, dest: lodVariantPath(absPath), mode: "--lod" });
    pushed = true;
  }
  if (pushed) pumpOptimize();
}
// per model (0 disables): the route's per-address limit caps presses, not the ~2×9 s of encode each buys
const lastRebuild = new Map<string, number>();
/** POST /rebuild. `rel`: `eidoverse/assets/models/<f>.glb` or `store/<hash>.glb`. A built variant keeps serving until
 *  the new one lands over it. null = not a rebuildable object. */
// forced passes wait behind every upload / sweep item: rebuild presses can delay other rebuilds, never uploads
export function rebuildAsset(rel: string): { queued: string[]; cooldownS?: number; busy?: boolean } | null {
  if (!/^(eidoverse\/assets\/models\/[^/]+|store\/[^/]+)\.glb$/.test(rel) || rel.includes("..")) return null;
  const store = rel.startsWith("store/");
  const src = store ? join(OPT_DIR, rel) : join(LIBRARY_DIR, rel);
  if (!isStoreOriginal(basename(rel))) return null;   // a variant (…ktx2.glb, …lod.*.glb) is never a source
  if (!existsSync(src)) return null;
  const dests = store
    ? { "--ktx2": ktx2VariantPath(src), "--lod": lodVariantPath(src) }
    : { "--ktx2": join(OPT_DIR, ktx2VariantPath(rel)), "--lod": join(OPT_DIR, lodVariantPath(rel)) };
  const cool = envNumber("REBUILD_COOLDOWN_MS", 600_000), last = lastRebuild.get(src) ?? -Infinity;
  if (cool > 0 && Date.now() - last < cool) return { queued: [], cooldownS: Math.ceil((cool - (Date.now() - last)) / 1000) };
  // the cap bounds what WAITS after this ask, its own passes counted. An ask never fits in part; an empty wait always
  // takes one whole ask, so a cap below 2 can't lock a model's two passes out forever
  const cap = envNumber("REBUILD_WAIT_CAP", 4);
  const waitingForced = optQueue.filter((q) => q.force).length;
  const adds = (Object.keys(dests) as NonNullable<OptItem["mode"]>[])
    .filter((mode) => !(mode === "--ktx2" && ktx2Skip) && !optQueue.some((q) => q.src === src && q.mode === mode && q.force)).length;
  if (cap > 0 && waitingForced > 0 && waitingForced + adds > cap) return { queued: [], busy: true };
  const queued: string[] = [];
  for (const [mode, dest] of Object.entries(dests) as [NonNullable<OptItem["mode"]>, string][]) {
    if (mode === "--ktx2" && ktx2Skip) continue;   // it would only exit 3
    for (const m of [`${dest}.failed`, `${dest}.deferred`]) if (existsSync(m)) try { rmSync(m); } catch { /* best effort */ }
    optDeferred.delete(dest);
    const waiting = optQueue.find((q) => q.src === src && q.mode === mode);
    if (waiting) waiting.force = true; else optQueue.push({ src, dest, mode, force: true });
    queued.push(mode.slice(2));
  }
  if (queued.length) { lastRebuild.set(src, Date.now()); pumpOptimize(); }
  return { queued };
}
let optPump: Promise<void> = Promise.resolve();
/** A harness awaits this; the server never does. */
export const optIdle = () => optPump;
async function pumpOptimize() {
  if (optRunning) return;
  optRunning = true;
  let done!: () => void; optPump = new Promise<void>((r) => { done = r; });
  try {
    while (optQueue.length) {
      const next = optQueue.findIndex((q) => !q.force);
      const { src, dest, mode, force } = optQueue.splice(next < 0 ? 0 : next, 1)[0];
      const base = basename(src);
      const failed = `${dest}.failed`;
      // the file this pass is ABOUT (freshOver): null for store originals and store-min, done forever once they exist
      const source = !mode || dirname(src) === join(OPT_DIR, "store") ? null : src;
      // a verdict stands only for the current recipe AND an unchanged source (as the route reads it)
      const refused = existsSync(failed)
        && (!mode || verdictStands(readFileSync(failed, "utf8"), mode === "--lod" ? LOD_RECIPE : KTX2_RECIPE))
        && freshOver(failed, source);
      // a FORCED item is a re-ask (↻): a verdict it finds was written after the press, by a run already in flight
      if (!existsSync(src) || (refused && !force)) continue;
      // store shadows: existing = done; KTX2 variants shadow MUTABLE library files, so another version's rebuilds
      if (!force && existsSync(dest) && freshOver(dest, source)) { undefer(dest); continue; }   // a stale .deferred must not outlive the variant
      // taken BEFORE the run: a source rewritten mid-pass must not be recorded as the one the output was built from
      const srcId = source ? diskIdentity(source) : null;
      // unaffordable is deferred, not failed, and the queue keeps going (config.ts OPT_MEM_BUDGET_MB)
      const estMB = Math.ceil(Bun.file(src).size * OPT_COST_FACTOR / 1_000_000);
      if (OPT_MEM_BUDGET_MB && estMB > OPT_MEM_BUDGET_MB) { defer(dest, `estimated ${estMB}MB > budget ${OPT_MEM_BUDGET_MB}MB`); continue; }
      mkdirSync(dirname(dest), { recursive: true });
      // process.execPath: systemd's PATH has no bun. `ulimit -d` (KB): an oversized encode dies as the child (≥128),
      // never the server; not RLIMIT_AS (bun reserves far more than it touches). Wrapper: 126 no limit, 127 no exec.
      const capped = OPT_MEM_BUDGET_MB > 0 && process.platform === "linux";
      // OPT_CMD: a harness may own the child (tools/optimize-pump-test.ts)
      const cmd = [...(process.env.OPT_CMD ? [process.env.OPT_CMD] : [process.execPath, "run", join(ROOT, "server", "optimize.ts")]), ...(mode ? [mode] : []), src, dest];
      let proc: ReturnType<typeof Bun.spawn>;
      try {
        // absolute: a harness PATH may have no shell, and a failed spawn throws synchronously, dropping the queue
        proc = Bun.spawn(capped
          ? ["/bin/sh", "-c", 'ulimit -d "$0" || exit 126; exec "$@"', String(OPT_MEM_BUDGET_MB * 1024), ...cmd]
          : cmd, { stdout: "pipe", stderr: "pipe" });
      } catch (e) {
        console.error(`[optimize] cannot spawn the optimizer (${String(e).split("\n")[0]}) — nothing marked; set OPT_MEM_BUDGET_MB=0 if /bin/sh is the problem`);
        optQueue.length = 0; break;
      }
      const code = await proc.exited;
      // recorded before anything else is awaited; until then the new bytes read stale (the safe direction)
      if (code === 0 && existsSync(dest)) {
        if (srcId) try { writeFileSync(sourceSidecar(dest), JSON.stringify(srcId)); } catch { /* best effort: reads stale until rebuilt */ }
        else if (existsSync(sourceSidecar(dest))) try { rmSync(sourceSidecar(dest)); } catch { /* best effort */ }
      }
      const err = (await new Response(proc.stderr).text()).trim();
      if (capped && (code === 126 || code === 127)) {
        // environmental: no marker, and no point grinding on
        console.error(`[optimize] cap wrapper failed (exit ${code}: ${err.split("\n").pop() || "sh"}) — set OPT_MEM_BUDGET_MB within this process's hard RLIMIT_DATA, or 0`);
        optQueue.length = 0; break;
      }
      if (capped && (proc.signalCode || code >= 128)) {
        // OOM and a crash on a corrupt file look the same here: retried next boot (a signal is never a stuck verdict)
        defer(dest, `child died (${proc.signalCode ?? `exit ${code}`}) under the ${OPT_MEM_BUDGET_MB}MB cap`);
        continue;
      }
      if (code === 0) {
        undefer(dest);
        // a verdict that was re-measured and answered differently is history
        if (existsSync(failed)) try { rmSync(failed); } catch { /* best effort */ }
        if (mode === "--lod") pruneOldLodGenerations(src, dest);
        const ratio = (Bun.file(src).size / Math.max(1, Bun.file(dest).size)).toFixed(1);
        console.log(mode ? `[ktx2] ${base} → ${basename(dest)} (${ratio}x)` : `[store] optimized ${base} (${ratio}x)`);
      } else if (code === 2) {
        // not suitable: a RECORD (verdictMarker) so the sweep stops re-measuring; for --lod read at serve time too
        writeFileSync(failed, verdictMarker(err, 2, srcId)); undefer(dest);
        // a variant of OTHER content than this refusal measured would serve old bytes forever: drop it (no identity:
        // drop if older); on unchanged content keep it
        try {
          if (srcId && existsSync(dest)) {
            const rec = recordedSource(dest, (p) => readFileSync(p, "utf8"));
            if (rec ? !sameIdentity(rec, srcId) : statSync(dest).mtimeMs < srcId.mtimeMs) {
              rmSync(dest); try { rmSync(sourceSidecar(dest)); } catch { /* none */ }
              console.log(`[${mode ? "ktx2" : "store"}] ${base} — removed ${basename(dest)}: built from another version of its source, and the re-measure refused`);
            }
          }
        } catch { /* the source may have vanished mid-run */ }
        if (mode === "--lod") pruneOldLodGenerations(src, dest);
        console.log(mode ? `[ktx2] ${base} — no variant (${readVerdict(err).kind}: ${readVerdict(err).reason})`
          : `[store] ${base} already lean — serving original`);
      } else if (code === 4) {
        // failed its own image check (#122): ENVIRONMENTAL like code 3, so no .failed marker; loud, and retried
        console.error(`[${mode ? "ktx2" : "store"}] ${base} REFUSED — optimized output failed its image check, `
          + `serving the original: ${err.split("\n").filter((l) => l.includes("declares")).join(" | ") || err.split("\n").pop()}`);
      } else if (code === 3 && mode === "--lod") {
        // a TEXTURED object with no encoder: per-file and cheap, so no global skip and no purge
        if (!lodEncoderWarned) { console.log("[lod] no KTX2 encoder — textured objects keep their originals until one lands (docs/ktx2-encoder.md)"); lodEncoderWarned = true; }
      } else if (code === 3 && mode) {
        // ENVIRONMENTAL, never a .failed marker (it would skip every model forever); skip the rest this boot
        console.log("[ktx2] no encoder — set KTX2_TOKTX or put toktx/ktx on PATH (docs/ktx2-encoder.md); variants skipped this boot");
        ktx2Skip = true;
        for (let i = optQueue.length - 1; i >= 0; i--) if (optQueue[i].mode && optQueue[i].mode !== "--lod") optQueue.splice(i, 1);
      } else if (code === 5 && mode) {
        // partial conversion (its name would lie): ENVIRONMENTAL, no marker and no ktx2Skip
        console.error(`[ktx2] ${base} REFUSED — partial conversion, serving the original: ${err.split("\n").pop() ?? `exit ${code}`}`);
      } else {
        // environmental failures must NOT mark the file (every upload before `bun install` would skip forever)
        const envFail = /cannot find module|cannot resolve|error: script not found/i.test(err);
        if (!envFail) { writeFileSync(failed, verdictMarker(err, code, srcId)); undefer(dest); }   // kind "failure": never final
        console.error(`[${mode ? "ktx2" : "store"}] optimize ${envFail ? "unavailable (deps?)" : `FAILED ${base}`}: ${err.split("\n")[0] || `exit ${code}`}`);
        if (envFail) { optQueue.length = 0; break; }
      }
    }
  } finally { optRunning = false; done(); }
}
// deferred so boot stays about serving worlds
/** Named so a harness can drive it. */
export function sweepStore() {
  if (SKIP_OPT_SWEEP) return;
  const dir = join(OPT_DIR, "store");
  if (!existsSync(dir)) return;
  // isStoreOriginal, never endsWith(".glb"): KTX2 variants end in .glb too and must never queue (§20c)
  const pending = readdirSync(dir).filter((f) => {
    if (!isStoreOriginal(f)) return false;
    const m = storeShadowsMissing(join(dir, f), STORE_MIN);
    return m.min || m.ktx2 || m.lod;
  });
  if (!pending.length) return;
  console.log(`[store] boot sweep: ${pending.length} upload(s) missing a shadow queued`);
  for (const f of pending) queueOptimize(join(dir, f));
}
setTimeout(sweepStore, 5000).unref?.();   // a harness that imports this must not be held open by the timer
// Library KTX2 (§20a, VRMs §20c, loose images §20d), served only on ?ktx2=<key>; .ktx2.vrm swaps textures, all else
// byte-preserved. PATH-PRESERVING (basenames collide across rels); avatars sourced overlay over library.
/** Same seam. */
export function sweepLibrary() {
  if (SKIP_OPT_SWEEP) return;
  if (ktx2Skip) return;
  const items: OptItem[] = [];
  const seen = new Set<string>();
  const walk = (base: string, dir: string, exts: string[], mode: OptItem["mode"]) => {
    if (!existsSync(dir)) return;
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) { walk(base, p, exts, mode); continue; }
      const ext = exts.find((x) => e.name.toLowerCase().endsWith(x));
      if (!ext) continue;
      // never re-encode an encode: variants share their original's extension
      if (e.name.endsWith(`.ktx2${ext}`)) continue;
      const rel = relative(base, p);
      // keyed by (mode, rel): the ktx2 and lod walks cover the SAME rels on purpose
      if (seen.has(`${mode}:${rel}`)) continue;
      seen.add(`${mode}:${rel}`);
      // a loose image's variant IS the ktx2 (served as image/ktx2)
      const dest = join(OPT_DIR, mode === "--ktx2-img" ? `${rel}.ktx2` : mode === "--lod" ? lodVariantPath(rel) : `${rel}.ktx2${ext}`);
      // a standing verdict skips only if it is about THIS version of the source
      if (existsSync(`${dest}.failed`) && verdictStands(readFileSync(`${dest}.failed`, "utf8"), mode === "--lod" ? LOD_RECIPE : KTX2_RECIPE)
        && freshOver(`${dest}.failed`, p)) continue;
      // identity, not existence: an updated library file rebuilds next boot
      if (existsSync(dest) && freshOver(dest, p)) continue;
      // already waiting: a second copy would run the same encode twice (unforced, then forced)
      if (optQueue.some((q) => q.src === p && q.mode === mode)) continue;
      items.push({ src: p, dest, mode });
    }
  };
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "models"), [".glb"], "--ktx2");
  // the same models (the CLI's structural exclusion is the body gate)
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "models"), [".glb"], "--lod");
  // overlay first, as serving and the /avatars roster
  walk(OPT_DIR, join(OPT_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "vrms"), [".vrm"], "--ktx2-vrm");
  // §20d, CURATED dirs ONLY: --ktx2-img pre-bakes loadImageTexture's flip, mirroring any image not consumed that way
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "grass"), [".png"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "sky"), [".png", ".jpg", ".jpeg"], "--ktx2-img");
  walk(LIBRARY_DIR, join(LIBRARY_DIR, "eidoverse", "assets", "particle_textures"), [".png"], "--ktx2-img");
  if (!items.length) return;
  console.log(`[ktx2] boot sweep: ${items.length} library asset(s) queued for variants`);
  optQueue.push(...items);
  pumpOptimize();
}
setTimeout(sweepLibrary, 15_000).unref?.();

// ---- the endpoint -----------------------------------------------------------

/** By magic; the name someone typed is not evidence. */
export function sniffImage(b: Uint8Array): "png" | "jpg" | "webp" | null {
  if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47
    && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a) return "png";
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "jpg";
  if (b.length >= 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
    && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "webp";
  return null;
}

export const MAX_IMAGE_PX = 8192;
/** The cap holds only if every image's size is known: an unreadable size is refused. */
export function imageSizeRefusal(b: Uint8Array, kind: "png" | "jpg" | "webp"): { status: number; why: string } | null {
  const dims = imageDims(b, kind);
  // a remedy any uploader can take, person or agent
  if (!dims) return { status: 415, why: `this ${kind === "jpg" ? "JPEG" : kind.toUpperCase()}'s header doesn't say its pixel size, so it can't be checked against the ${MAX_IMAGE_PX}-px cap; sending these bytes again won't change that. Upload a copy whose header gives its size: any encoder writes one (a PNG always has it), so re-encode it with whatever made it, or a library such as sharp or Pillow` };
  if (Math.max(dims[0], dims[1]) > MAX_IMAGE_PX) return { status: 413, why: `image is ${dims[0]}×${dims[1]} px; at most ${MAX_IMAGE_PX} on a side (viewers draw it at 2048)` };
  return null;
}
/** A zero side is no size either (a 0×0 WebP, a JPEG whose SOF defers height): refused as unknown. */
export function imageDims(b: Uint8Array, kind: "png" | "jpg" | "webp"): [number, number] | null {
  const d = headerDims(b, kind);
  return d && d[0] > 0 && d[1] > 0 ? d : null;
}
function headerDims(b: Uint8Array, kind: "png" | "jpg" | "webp"): [number, number] | null {
  const u16 = (i: number) => (b[i] << 8) | b[i + 1], u32 = (i: number) => ((b[i] << 24) >>> 0) + (b[i + 1] << 16) + (b[i + 2] << 8) + b[i + 3];
  const le16 = (i: number) => b[i] | (b[i + 1] << 8), le24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
  try {
    if (kind === "png") return b.length >= 24 ? [u32(16), u32(20)] : null;
    if (kind === "jpg") { let i = 2; while (i + 9 < b.length) { if (b[i] !== 0xff) { i++; continue; } const m = b[i + 1];
        if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) return [u16(i + 7), u16(i + 5)];
        if (m === 0xff) { i++; continue; }   // fill byte: the marker is the byte after the last
        if (m === 0xd8 || m === 0x01 || (m >= 0xd0 && m <= 0xd7)) { i += 2; continue; } i += 2 + u16(i + 2); } return null; }
    if (kind === "webp" && b.length >= 30) { const c = String.fromCharCode(b[12], b[13], b[14], b[15]);
      if (c === "VP8X") return [1 + le24(24), 1 + le24(27)];
      if (c === "VP8 ") return [le16(26) & 0x3fff, le16(28) & 0x3fff];
      if (c === "VP8L") { const v = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24); return [1 + (v & 0x3fff), 1 + ((v >> 14) & 0x3fff)]; } }
  } catch { /* unreadable */ }
  return null;
}
export function sniffAudio(b: Uint8Array): "mp3" | "ogg" | "wav" | "webm" | "m4a" | null {
  const tag = (off: number, s: string) => b.length >= off + s.length && [...s].every((ch, i) => b[off + i] === ch.charCodeAt(0));
  if (tag(0, "ID3")) return "mp3";
  if (b.length >= 3 && b[0] === 0xff && (b[1] & 0xe6) === 0xe2 && (b[2] & 0xf0) !== 0xf0) return "mp3";   // MPEG frame sync, layer bits set, valid bitrate
  if (tag(0, "OggS")) return "ogg";
  if (tag(0, "RIFF") && tag(8, "WAVE")) return "wav";
  if (b.length >= 4 && b[0] === 0x1a && b[1] === 0x45 && b[2] === 0xdf && b[3] === 0xa3) return "webm";
  if (tag(4, "ftyp")) return "m4a";
  return null;
}

/** Auth: door token, mcpl bearer, aid1 or session, plus a per-IP rate limit; entering a world is still a role-gated
 *  door request. `?by=` is attribution only. */
export async function handleUpload(req: Request, url: URL, srv: UploadSrv): Promise<Response> {
  const upTok = url.searchParams.get("token") ?? "";
  let upAgent = agentTokens().byToken.get(upTok);
  // the join door's aid1 leg (no jti burn)
  if (!upAgent) upAgent = aid1JoinIdentity(upTok)?.slug;
  // a session cookie only from this site's own pages: SameSite=Lax lets it ride requests from sibling subdomains
  const session = sessionFromCookie(req.headers.get("cookie"));
  const upPerson = session && session.scopes.includes("worlds:join") && req.headers.get("sec-fetch-site") === "same-origin" ? session.name : null;
  if (JOIN_TOKEN && upTok !== JOIN_TOKEN && !upAgent && !upPerson)
    return new Response("sign in, or bring the door key (token required)", { status: 401 });
  // a signed-in person is who the session says, whatever ?by= claims
  const upBy = (upPerson ?? url.searchParams.get("by") ?? upAgent ?? "?").slice(0, 64);
  // X-Real-IP only from a trusted proxy (server/peer.ts)
  const ip = addressOf(req, srv);
  const u = uploadWin.get(ip) ?? { t: 0, n: 0 };
  if (Date.now() - u.t > 60_000) { u.t = Date.now(); u.n = 0; }
  u.n++; uploadWin.set(ip, u);
  if (u.n > 4) return new Response("upload rate limit (4/min)", { status: 429 });
  const body = new Uint8Array(await req.arrayBuffer());
  if (body.length > UPLOAD_CAP) return new Response(`too large (${UPLOAD_CAP / 1e6}MB cap)`, { status: 413 });
  if (url.searchParams.get("as") === "image") {
    // pictures: store/images/<hash>.<ext>, no optimize pass; the kind comes from the BYTES
    if (body.length > IMAGE_CAP) return new Response(`image too large (${IMAGE_CAP / 1e6}MB cap)`, { status: 413 });
    const kind = sniffImage(body);
    if (!kind) return new Response("not a PNG, JPEG or WebP image (judged by content, not by name)", { status: 415 });
    // a decompression bomb is refused before any viewer decodes it
    { const no = imageSizeRefusal(body, kind); if (no) return new Response(no.why, { status: no.status }); }
    const ihash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
    const idir = join(OPT_DIR, "store", "images");
    mkdirSync(idir, { recursive: true });
    const irel = `store/images/${ihash}.${kind}`;
    if (!existsSync(join(OPT_DIR, irel))) writeFileSync(join(OPT_DIR, irel), body);
    // the human name lives only here: content-addressed, the catalog would know only a hash
    const iname = (url.searchParams.get("name") ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
    {
      // the FIRST arrival is the provenance; a later upload fills a missing name, never re-attributes
      const mp = join(idir, "manifest.json");
      let man: Record<string, { name?: string; by: string; ts: number }> = {};
      try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
      const prev = man[ihash];
      if (!prev) man[ihash] = { ...(iname ? { name: iname } : {}), by: upBy, ts: Date.now() };
      else if (!prev.name && iname) prev.name = iname;
      atomicWrite(mp, JSON.stringify(man));
    }
    console.log(`[upload] image ${irel}${iname ? ` ("${iname}")` : ""} (${(body.length / 1e3).toFixed(0)}KB) by ${upBy}`);
    return new Response(JSON.stringify({ path: irel }), { headers: { "content-type": "application/json" } });
  }
  if (url.searchParams.get("as") === "heightmap") {
    // decoded HERE once (server/heightmap.ts); what changes a WORLD is still the owner's `terrain` verb
    if (body.length > IMAGE_CAP) return new Response(`heightmap too large (${IMAGE_CAP / 1e6}MB cap)`, { status: 413 });
    if (sniffImage(body) !== "png") return new Response("a heightmap must be a PNG (16-bit grayscale is best)", { status: 415 });
    const hhash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
    const r = ingestHeightmap(body, hhash);
    if ("error" in r) return new Response(r.error, { status: r.status });
    console.log(`[upload] heightmap ${r.grid} (${r.w}×${r.h}, ${r.bits}-bit) by ${upBy}`);
    return new Response(JSON.stringify(r), { headers: { "content-type": "application/json" } });
  }
  if (url.searchParams.get("as") === "audio") {
    // sounds: store/audio/<hash>.<ext>, no transcode; the kind comes from the BYTES
    const kind = sniffAudio(body);
    if (!kind) return new Response("not an MP3, Ogg, WAV, WebM or M4A audio file (judged by content, not by name)", { status: 415 });
    const ahash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
    const adir = join(OPT_DIR, "store", "audio");
    mkdirSync(adir, { recursive: true });
    const arel = `store/audio/${ahash}.${kind}`;
    if (!existsSync(join(OPT_DIR, arel))) writeFileSync(join(OPT_DIR, arel), body);
    const aname = (url.searchParams.get("name") ?? "").replace(/\.[a-z0-9]+$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
    {
      // first arrival is the provenance; a later upload only fills a missing name
      const mp = join(adir, "manifest.json");
      let man: Record<string, { name?: string; by: string; ts: number }> = {};
      try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
      const prev = man[ahash];
      if (!prev) man[ahash] = { ...(aname ? { name: aname } : {}), by: upBy, ts: Date.now() };
      else if (!prev.name && aname) prev.name = aname;
      atomicWrite(mp, JSON.stringify(man));
    }
    console.log(`[upload] audio ${arel}${aname ? ` ("${aname}")` : ""} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
    return new Response(JSON.stringify({ path: arel }), { headers: { "content-type": "application/json" } });
  }
  if (body.length < 12 || new DataView(body.buffer).getUint32(0, true) !== 0x46546c67)
    return new Response("not a GLB container (glb/vrm)", { status: 415 });
  if (url.searchParams.get("as") === "avatar") {
    const raw = url.searchParams.get("name") ?? "unnamed";
    const name = raw.replace(/\.vrm$/i, "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48) || "unnamed";
    const dir = join(OPT_DIR, "eidoverse/assets/vrms");
    mkdirSync(dir, { recursive: true });
    // a RAW TRIPO RIG (no VRM extension + Tripo bone names) runs the import in a SUBPROCESS; PASS/FAIL gates the roster
    let gjson: any = null;
    try {
      const dv = new DataView(body.buffer, body.byteOffset);
      gjson = JSON.parse(new TextDecoder().decode(body.subarray(20, 20 + dv.getUint32(12, true))));
    } catch { /* plain save; the client will complain */ }
    const isVRM = !!(gjson?.extensions?.VRMC_vrm || gjson?.extensions?.VRM);
    const nodeNames = new Set((gjson?.nodes ?? []).map((n: any) => n.name));
    if (!isVRM && ["Hip", "L_Thigh", "L_Upperarm"].every((b) => nodeNames.has(b))) {
      if (tripoImportBusy) {
        return new Response("an avatar import is already running — try again in a minute", { status: 429 });
      }
      tripoImportBusy = true;
      try {
        const tmpIn = join(OPT_DIR, `.import-${name}.glb`);
        writeFileSync(tmpIn, body);
        // never "bun" (docs/INCIDENTS.md, the Windows shim)
        const spawnArgs = [process.execPath, "run", join(ROOT, "tools/import-tripo-avatar.ts"),
          tmpIn, "--name", name, "--out", OPT_DIR];
        if (process.env.EW_AVATAR_DONOR) spawnArgs.push("--donor", process.env.EW_AVATAR_DONOR);
        const proc = Bun.spawn(spawnArgs, { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
        const killer = setTimeout(() => proc.kill(), 300_000);
        const code = await proc.exited;
        clearTimeout(killer);
        const log = (await new Response(proc.stdout).text()) + (await new Response(proc.stderr).text());
        try { Bun.spawnSync(["rm", "-f", tmpIn]); } catch { /* temp */ }
        if (code !== 0) {
          console.log(`[upload] tripo import "${name}" FAILED verification\n${log.slice(-800)}`);
          return new Response(`tripo import failed verification — not installed:\n${log.slice(-800)}`,
            { status: 422 });
        }
        renameSync(join(OPT_DIR, `${name}.vrm`), join(dir, `${name}.vrm`));
        console.log(`[upload] tripo→vrm "${name}" imported by ${upBy}\n${log.split("\n").slice(-8).join("\n")}`);
      } finally { tripoImportBusy = false; }
    } else {
      writeFileSync(join(dir, `${name}.vrm`), body);
      console.log(`[upload] avatar "${name}" (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
    }
    // avatars are name-keyed and mutable: every client in every world learns of the change; wearers hot-swap
    const rel = `eidoverse/assets/vrms/${name}.vrm`;
    const update = JSON.stringify({ type: "avatar-updated", name, path: rel, v: Date.now() });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    if (notified) console.log(`[upload] avatar-updated "${name}" → ${notified} client(s)`);
    return new Response(JSON.stringify({ name, path: rel }),
      { headers: { "content-type": "application/json" } });
  }
  const hash = new Bun.CryptoHasher("sha256").update(body).digest("hex").slice(0, 16);
  const dir = join(OPT_DIR, "store");
  mkdirSync(dir, { recursive: true });
  const rel = `store/${hash}.glb`;
  if (!existsSync(join(OPT_DIR, rel))) writeFileSync(join(OPT_DIR, rel), body);
  queueOptimize(join(OPT_DIR, rel));
  // the human name arrives ONLY here: record it, or the catalog lists this object as a hash
  const upName = (url.searchParams.get("name") ?? "").replace(/\.glb$/i, "").replace(/[^a-zA-Z0-9 _-]/g, "").slice(0, 64).trim();
  {
    const mp = join(dir, "manifest.json");
    let man: Record<string, { name?: string; by: string; ts: number }> = {};
    try { if (existsSync(mp)) man = JSON.parse(readFileSync(mp, "utf8")); } catch { /* fresh */ }
    man[hash] = { ...(upName ? { name: upName } : {}), by: upBy, ts: Date.now() };
    atomicWrite(mp, JSON.stringify(man));
  }
  console.log(`[upload] model ${rel}${upName ? ` ("${upName}")` : ""} (${(body.length / 1e6).toFixed(1)}MB) by ${upBy}`);
  // never holds the upload up or refuses it: the report is advice, waiting at `check` (server/buildcheck.ts)
  void checkFile(join(OPT_DIR, rel), 1, body).catch((err) => console.warn(`[check] ${rel}: ${String(err?.message ?? err)}`));
  return new Response(JSON.stringify({ path: rel, check: `/check?lib=${encodeURIComponent(rel)}` }), { headers: { "content-type": "application/json" } });
}
