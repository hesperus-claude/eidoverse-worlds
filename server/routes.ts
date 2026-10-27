// The HTTP surface (TEL0S_NOTES §15, step 7c): a route table, first match wins (the catch-all serves the browser
// client); server.ts's fetch() delegates here. Holds the static-file machinery and the avatar roster. Never imports
// server.ts (avatarRoster is imported the other way).

import { existsSync, readFileSync, writeFileSync, renameSync, readdirSync, mkdirSync, appendFileSync } from "node:fs";
import { addressOf } from "./peer.ts";   // the client's address, from a trusted proxy only
import { sfuDiag } from "./sfuadapter.ts";
import { join, normalize, dirname, basename } from "node:path";
import { hexOfLibRel } from "../shared/eido.js";
import { kindOf } from "../shared/protocol/kind.js";
import { isReservedAnimName } from "../shared/animdefs.js";
import { eidoFile, eidoRel } from "./eidoindex.ts";
import { randomBytes } from "node:crypto";
import { creditsFor } from "../shared/libcredits.js";
import { libraryCredits } from "./modelcatalogue.ts";
import { ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, PATCH_DIR, LADDER, JOIN_TOKEN, STORE_MIN } from "./config.ts";
import { isStoreOriginal, isServingArtifact, variantStatus, variantSource, freshOver } from "./store-variants.ts";
import { glbPerfOfFile } from "./glbperf.ts";
import { rankOf, TIER_NAMES } from "../shared/perfrank.js";
import { wantsKtx2, KTX2_KEY } from "../shared/ktx2.js";
import { normalizeSnapFrame } from "../shared/snapframe.js";
import { LOD_RECIPE, lodVariantPath, lodVerdictKind, lodVerdictFinal } from "./store-variants.ts";
import { hnSessions, hnJti, sessionFromCookie, sessionIdOf, saveSessions, SESSION_TTL_MS, HN_ISSUER_KEY, HN_ISS, HN_AUD, HN_LOGIN_URL, HN_REQUIRE_LOGIN } from "./auth.ts";
import { verifyToken } from "./aid1.ts";
import { createNativeLogin } from "./native-login.ts";
const nativeLogin = createNativeLogin({
  origin: process.env.HN_NATIVE_ORIGIN ?? "https://eidoverse.animalabs.ai",
  login: HN_LOGIN_URL, enabled: Boolean(HN_ISSUER_KEY), session: sessionFromCookie,
  issue: session => { const sid = randomBytes(32).toString("hex"); hnSessions.set(sid, session); saveSessions(); return sid; },
});
import { resolveLibFile, libraryFile, libraryRel } from "./libfile.ts";
import { summarizeGlb } from "./geometry.ts";
import { vrmHeightFor } from "./vrmheight.ts";
import { checkFile, checkScale, CheckRefused } from "./buildcheck-queue.ts";
import { worlds, getWorld, type World } from "./world.ts";
import { snapshots } from "./snapshots.ts";
import { handleUpload, optStatus, rebuildAsset } from "./upload.ts";
import { serveHeightmapExport, heightRange } from "./heightmap.ts";
import { defsPayload, avatarDefs, animationDefs } from "./defs.ts";
import { tickStats } from "./tick.ts";
import { atomicWrite } from "./fsutil.ts";
import { cspFor, cspForFile } from "./csp.ts";
// /clientlog buckets: one per world this server KNOWS (loaded or on disk), one shared for any other label, one global,
// so a made-up label can't buy quota or a file and the map stays bounded
const clientLogRate = new Map<string, { at: number; n: number }>();
const rebuildWin = new Map<string, { t: number; n: number }>();   // POST /rebuild per-IP windows (4/min, as /upload)
const clientLogGlobal = { at: 0, n: 0 };
const CLIENTLOG_DIR = process.env.CLIENTLOG_DIR ?? join(WORLDS_DIR, ".clientlogs");   // beside the worlds, never a shared temp dir
const CLIENTLOG_MAX_BODY = 4096, CLIENTLOG_MAX_FILE = 5_000_000, CLIENTLOG_PER_WORLD_MIN = 600, CLIENTLOG_GLOBAL_MIN = 2000;
// EXACT-case match against the listing (existsSync says yes to every case variant on a case-insensitive filesystem,
// each a fresh bucket and file); listed once per few seconds, never per request.
let worldDirs: Set<string> = new Set(), worldDirsAt = 0;
const knownWorld = (name: string) => {
  if (worlds.has(name)) return true;
  const now = Date.now();
  const relist = () => { try { worldDirs = new Set(readdirSync(WORLDS_DIR)); } catch { worldDirs = new Set(); } worldDirsAt = now; };
  if (now - worldDirsAt > 5000) relist();
  if (!worldDirs.has(name) && now - worldDirsAt > 1000) relist();   // a miss re-lists (at most once a second)
  return worldDirs.has(name) && hasWorldLog(name);
};
/** Reads of a world's live state (/geom?world, /snap, /worlds) sit behind the joining door: with a JOIN_TOKEN they need
 *  a join key (authority key, agent token, aid1 credential) as a Bearer header, or a signed-in session cookie from this
 *  page. An open box (no JOIN_TOKEN) is open. */
function mayRead(req: Request): boolean {
  if (!JOIN_TOKEN) return true;
  const key = bearerOf(req);
  return !!(key && (key === JOIN_TOKEN || agentTokens().byToken.has(key) || aid1JoinIdentity(key)))
    || (!!sessionFromCookie(req.headers.get("cookie")) && req.headers.get("sec-fetch-site") === "same-origin");
}
const unauthorized = () => new Response("this world's state is behind its door: send a key it takes as a Bearer header", { status: 401 });

const hasWorldLog = (name: string) => existsSync(join(WORLDS_DIR, name, "world.jsonl"));
const CLIENTLOG_UNKNOWN = "~unknown";   // '~' is outside the world-name alphabet, so no real world can share this file
try { mkdirSync(CLIENTLOG_DIR, { recursive: true }); } catch (e) { console.warn(`[clientlog] cannot create ${CLIENTLOG_DIR}: ${(e as Error)?.message ?? e}`); }
import { seatStore, announceProfileUpdate, MAX_PROPOSAL_BYTES } from "./seats.ts";
import { agentTokens, aid1JoinIdentity, bearerOf } from "./auth.ts";
import { httpCaller, visibleTo, doorFor, youAt } from "./access.ts";

import { recordComponents } from "../shared/protocol/view.js";
import { WORLD_NAME_RE } from "./limits.ts";
/** What the routes need from Bun's server object: the WS upgrade and the socket address (X-Real-IP's fallback). */
export type Srv = {
  upgrade(req: Request, opts?: { data?: unknown }): boolean;
  requestIP(req: Request): { address: string } | null;
  /** seconds; overrides Bun.serve's idleTimeout */
  timeout?(req: Request, seconds: number): void;
};

// ---- snapshots ---------------------------------------------------------------
// GET /snap?world=W&follow=ID[&view=first|third|selfie][&at=<thing>][&renderer=auto|unreal|browser][&budget=ms]
// [&dist=&height=&pitch=] → a renderer client returns one frame (`capture` / `capture-result`, server/snapshots.ts)

// ---- static serving ---------------------------------------------------------

/** The library's vrms + our overlay (assets/opt/...): drop a .vrm into either and it's an avatar, live. ?v=mtime
 *  content-versions each path. Served by GET /avatars AND carried in the join snapshot. */
export type AvatarPerf = { tris: number; draws: number; mats: number; alpha: number; bones: number; texMB: number;
  rank: number; rankName: string; worst: string; v: string };
/** POST /thumb's `perf` + `v` → a validated record with the rank recomputed here, or null. Client-written: every
 *  field must be a finite, non-negative, sane number. */
export function avatarPerfParam(raw: string | null, v: string | null): AvatarPerf | null {
  if (!raw || !v || !/^\d{1,16}$/.test(v) || raw.length > 400) return null;
  let o: any; try { o = JSON.parse(raw); } catch { return null; }
  const LIM = { tris: 5e7, draws: 1e5, mats: 1e4, alpha: 1e4, bones: 1e4, texMB: 1e5 } as const;
  const n: any = {};
  for (const [k, max] of Object.entries(LIM)) {
    const x = o?.[k];   // a number, not a coercion (Number(null), Number([]), Number("") are all 0)
    if (typeof x !== "number" || !Number.isFinite(x) || x < 0 || x > max) return null;
    n[k] = k === "texMB" ? Math.round(x * 100) / 100 : Math.round(x);
  }
  const r = rankOf(n);
  return { ...n, rank: r.rank, rankName: TIER_NAMES[r.rank], worst: r.worst, v };
}
export function avatarRoster(): { name: string; path: string; height: number | null; perf?: AvatarPerf | null; seat?: unknown }[] {
  const seen = new Map<string, { url: string; file: string; v: string }>();
  for (const base of [LIBRARY_DIR, OPT_DIR]) {
    const dir = join(base, "eidoverse/assets/vrms");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      // .ktx2.vrm files are §20c texture variants: negotiated serving artifacts, not bodies of their own
      if (f.endsWith(".vrm") && !f.endsWith(".ktx2.vrm")) {
        const v = String(Math.round(Bun.file(join(dir, f)).lastModified));
        seen.set(f.replace(".vrm", ""), { url: `eidoverse/assets/vrms/${f}?v=${v}`, file: join(dir, f), v });
      }
    }
  }
  // the def overlay (§24, defs/avatars/): declared beats discovered; a def path that doesn't resolve is refused loudly
  // and the discovered roster stands
  const defs = avatarDefs();
  for (const [name, d] of Object.entries(defs)) {
    if (!d.vrm) continue;
    const file = resolveLibFile(d.vrm);
    if (!file) { console.error(`[defs] avatar "${name}": vrm not found in library — ${d.vrm}`); continue; }
    const v = String(Math.round(Bun.file(file).lastModified));
    seen.set(name, { url: `${d.vrm}?v=${v}`, file, v });
  }
  // portrait framing heights posted by wearers (POST /thumb): stand in only when the file gives none
  let hmeta: Record<string, { h?: number; perf?: AvatarPerf }> = {};
  try {
    const mp = join(OPT_DIR, "thumbs", "meta.json");
    if (existsSync(mp)) hmeta = JSON.parse(readFileSync(mp, "utf8"));
  } catch { /* roster works without heights */ }
  // the seat verdict rides every entry PRE-JUDGED against the bytes that will serve (#101); judge()'s sha work is mtime-cached
  return [...seen].map(([name, { url, file, v }]) => {
    const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_");
    return { name, path: url,
      // a def's declared height, else the file's own stature (vrmheight.ts); a wearer's posted height only when neither
      height: defs[name]?.height ?? vrmHeightFor(file, v) ?? hmeta[safe]?.h ?? null,
      // the loupe's rank of THIS version only (its URL's v): an older export's stamp is withheld until a wearer re-measures
      perf: ((p) => p && p.v === v ? p : null)(hmeta[safe]?.perf),
      seat: seatStore.judge(name, file) };
  });
}

/** ?v=mtime: a version in the URL is the only invalidation that reaches caches we don't control. The mtime must be the
 *  SERVED file's, so follow /library's ladder (PATCH_DIR > OPT_DIR > LIBRARY_DIR). */
export function animationRoster(): { name: string; path: string; size: number }[] {
  const seen = new Map<string, { path: string; size: number }>();
  for (const base of [...LADDER].reverse()) {   // lowest-precedence first: later wins the map
    const dir = join(base, "eidoverse/assets/animations");
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".vrma")) continue;
      if (isReservedAnimName(f.replace(".vrma", ""))) { console.error(`[defs] animation "${f}": "live" is reserved (it names ad-libbed anims) — not served`); continue; }
      const file = Bun.file(join(dir, f));
      // size rides along for the prefetcher's byte budget
      seen.set(f.replace(".vrma", ""),
        { path: `eidoverse/assets/animations/${f}?v=${Math.round(file.lastModified)}`, size: file.size });
    }
  }
  // the def overlay (§24, defs/animations/), same contract as avatars; metadata rides /defs. Paths resolve as /library
  // serves them (server/libfile.ts libraryFile), so a listed clip loads.
  const resolveClip = (lib: string): string | null => libraryFile(lib, /\.vrma$/i);
  const defs = animationDefs();
  for (const [name, d] of Object.entries(defs)) {
    if (!d.vrma) continue;
    const file = resolveClip(d.vrma);
    if (!file) { console.error(`[defs] animation "${name}": vrma not found in library — ${d.vrma}`); continue; }
    const bf = Bun.file(file);
    seen.set(name, { path: `${d.vrma}?v=${Math.round(bf.lastModified)}`, size: bf.size });
  }
  return [...seen].map(([name, e]) => ({ name, ...e }));
}

function contentType(path: string): string {
  if (path.endsWith(".html")) return "text/html";
  if (path.endsWith(".js") || path.endsWith(".mjs")) return "text/javascript";
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".css")) return "text/css";
  if (path.endsWith(".md")) return "text/markdown; charset=utf-8";
  if (path.endsWith(".png")) return "image/png";
  if (path.endsWith(".jpg") || path.endsWith(".jpeg")) return "image/jpeg";
  if (path.endsWith(".webp")) return "image/webp";
  if (path.endsWith(".mp3")) return "audio/mpeg";
  if (path.endsWith(".ogg") || path.endsWith(".opus")) return "audio/ogg";
  if (path.endsWith(".wav")) return "audio/wav";
  if (path.endsWith(".webm")) return "audio/webm";
  if (path.endsWith(".m4a")) return "audio/mp4";
  if (path.endsWith(".ktx2")) return "image/ktx2";
  if (path.endsWith(".wasm")) return "application/wasm";
  if (path.endsWith(".hdr")) return "application/octet-stream";
  return "application/octet-stream";
}

// Build identity, resolved once at boot (#51): sha, commitTime and dirty are ONE provenance triple; if any comes from the
// environment the others are env-or-unknown, never filled from the local git tree
const BUILD = (() => {
  const gitLine = (...args: string[]) => {
    try {
      return new TextDecoder().decode(
        Bun.spawnSync(["git", ...args], { cwd: import.meta.dir }).stdout).trim();
    } catch { return ""; /* no git in the deploy image */ }
  };
  // PRESENCE, not truthiness: BUILD_DIRTY='' still declares an env identity, which a git-derived sha must not pair with
  const envIdentity = process.env.BUILD_SHA != null || process.env.BUILD_TIME != null
    || process.env.BUILD_DIRTY != null;
  const sha = process.env.BUILD_SHA
    || (envIdentity ? "unknown" : gitLine("rev-parse", "--short", "HEAD") || "unknown");
  const commitTime = process.env.BUILD_TIME
    || (envIdentity ? "unknown" : gitLine("show", "-s", "--format=%cI", "HEAD") || "unknown");
  const dirtyRaw = process.env.BUILD_DIRTY ?? (() => {
    if (envIdentity) return "unknown";
    const out = gitLine("status", "--porcelain");
    return gitLine("rev-parse", "HEAD") ? (out ? "true" : "false") : "unknown";
  })();
  return { sha: sha || "unknown", commitTime: commitTime || "unknown",
    dirty: dirtyRaw === "true" ? true : dirtyRaw === "false" ? false : "unknown",
    startedAt: new Date().toISOString(),
    // EIDO_BOOT_NONCE: lets a probe prove the responder is ITS child (tools/probe-harness.mjs)
    ...(process.env.EIDO_BOOT_NONCE ? { nonce: process.env.EIDO_BOOT_NONCE } : {}) };
})();

const gzCache = new Map<string, { mtime: number; gz: Uint8Array }>();

// Hard-cache (a day) only heavy, rarely edited art; avatars, animations and library code/data are no-cache (still
// ETag-revalidated): a stale copy of those reads as a bug.
const hardCacheable = (path: string) =>
  !/\.vrma?$/i.test(path) && !/\.(m?js|json)$/i.test(path);

// `provisional`: not this URL's final answer (a flagged fetch whose variant doesn't exist yet); beats `immutable`.
// A VARIANT can be rebuilt IN PLACE, so never immutable: a minute's reuse then a 304 (stale-while-revalidate ~6 min),
// letting nginx's proxy_cache_lock collapse a crowd. Also the tier for a lod ask whose verdict is final (#205).
const VARIANT_CC = "public, max-age=60, stale-while-revalidate=300";
/** `opts.variant`: a built variant (VARIANT_CC unless provisional). `opts.headers` NAME the answer (x-eidoverse-lod),
 *  on the 304 too, so devtools reads the state without a body. */
function serveFrom(base: string, rel: string, cache = false, req?: Request, immutable = false, provisional = false,
  opts: { variant?: boolean; headers?: Record<string, string> } = {}): Response {
  const variant = !!opts.variant;
  const path = normalize(join(base, rel));
  if (!path.startsWith(base)) return new Response("forbidden", { status: 403 });
  // a missing file must be a 404, not a Bun.file stream blowing up into a 500 (an rsync gap did exactly that)
  if (!existsSync(path)) return new Response("not found", { status: 404 });
  const f = Bun.file(path);
  const headers: Record<string, string> = { "content-type": contentType(path), ...(opts.headers ?? {}) };
  // a page carries its Content-Security-Policy, its own inline scripts hashed in (server/csp.ts)
  if (headers["content-type"].startsWith("text/html")) headers["content-security-policy"] = cspForFile(path, f.lastModified, () => readFileSync(path, "utf8"));
  // client code is never heuristically cached; library assets cache hard except hardCacheable's exclusions
  headers["cache-control"] = provisional ? "no-cache"
    : variant ? VARIANT_CC
    : immutable ? "public, max-age=31536000, immutable"
    : cache && hardCacheable(path) ? "public, max-age=86400" : cache ? "no-cache" : "no-store";
  // ETag from size+mtime: no-cache revalidation is a 304, not a re-download (an 11MB avatar per reload); the 304 carries
  // cache-control too (it refreshes the stored response's lifetime)
  if (f.size > 0) {
    const etag = `"${f.size}-${f.lastModified}"`;
    headers["etag"] = etag;
    if (req?.headers.get("if-none-match") === etag) return new Response(null, { status: 304, headers });
  }
  // gzip text and uncompressed binaries (three.webgpu.js 2.1MB → ~500KB; VRMs ~0.50, VRMA ~0.44); GLBs (~0.99, already
  // packed) are left out
  if (/\.(m?js|json|css|html|vrma|vrm|wasm)$/.test(path) && req?.headers.get("accept-encoding")?.includes("gzip") && f.size > 10_000) {
    let entry = gzCache.get(path);
    if (!entry || entry.mtime !== f.lastModified) {
      entry = { mtime: f.lastModified, gz: Bun.gzipSync(new Uint8Array(require("node:fs").readFileSync(path))) };
      gzCache.set(path, entry);
    }
    headers["content-encoding"] = "gzip";
    headers["vary"] = "accept-encoding";
    return new Response(entry.gz, { headers });
  }
  return new Response(f, { headers });
}

let clientVersionCache: { at: number; v: string } | null = null;

// ---- the table --------------------------------------------------------------

type RouteCtx = { req: Request; url: URL; srv: Srv };
type Route = {
  match(url: URL, req: Request): boolean;
  handler(ctx: RouteCtx): Response | Promise<Response>;
};

/** The file a KTX2-negotiating client gets at full detail, in the /library/ handler's order: PATCH_DIR, KTX2 variant,
 *  store-min (store), optimized mirror, original. The catalog ranks this file; tools/library-status-probe.mjs checks it. */
function servedGlbPath(rel: string): { path: string; as: "patched copy" | "KTX2 variant" | "compressed copy" | "optimized copy" | "original" } {
  const pt = normalize(join(PATCH_DIR, rel));
  if (pt.startsWith(PATCH_DIR) && existsSync(pt)) return { path: pt, as: "patched copy" };
  const k = join(OPT_DIR, `${rel}.ktx2.glb`);
  if (existsSync(k)) return { path: k, as: "KTX2 variant" };
  if (rel.startsWith("store/")) {
    const m = join(OPT_DIR, "store-min", rel.slice("store/".length));
    if (existsSync(m)) return { path: m, as: "compressed copy" };
  }
  const o = join(OPT_DIR, rel);
  if (existsSync(o)) return { path: o, as: "optimized copy" };
  return { path: rel.startsWith("store/") ? join(OPT_DIR, rel) : join(LIBRARY_DIR, rel), as: "original" };
}
const perfPair = (rel: string, original: string) => {
  const s = servedGlbPath(rel);
  const perf = glbPerfOfFile(s.path);
  return { perf: perf ? { ...perf, servedAs: s.as } : null, perfOriginal: s.path === original ? null : glbPerfOfFile(original) };
};

// GET /auth landing page: the token is in the URL FRAGMENT (never reaches this server's logs); this page posts it back.
// Its one inline script is hashed into its CSP.
const AUTH_PAGE = `<!doctype html><meta charset="utf-8"><title>entering…</title>
<style>body{font:16px/1.5 system-ui;max-width:36rem;margin:15vh auto;padding:0 1rem;color:#ddd;background:#111}</style>
<p id=m>entering…</p><script>
(async () => {
  const m = document.getElementById('m');
  const tok = new URLSearchParams(location.hash.slice(1)).get('token');
  if (!tok) { m.textContent = 'no token — start again from the login page'; return; }
  history.replaceState(null, '', '/auth');
  const r = await fetch('/auth', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: tok }) });
  const j = await r.json().catch(() => ({}));
  if (r.ok) {
    m.textContent = 'welcome, ' + j.name;
    let code = ''; try { code = sessionStorage.getItem('ew-native-pair-code') || ''; } catch {}
    location.replace(/^[A-F0-9]{5}-[A-F0-9]{5}$/.test(code) ? '/native#code=' + code : '/');
  }
  else m.textContent = 'login failed: ' + (j.error ?? r.status) + ' — start again from the login page';
})();
</script>`;
const AUTH_PAGE_CSP = cspFor(AUTH_PAGE);

const ROUTES: Route[] = [
  { match: u => u.pathname === "/native" || u.pathname.startsWith("/native/"), handler: ({ req }) => nativeLogin(req) },
  {
    match: (u) => u.pathname === "/ws",
    handler: ({ req, srv }) => {
      // the session rides the upgrade (browsers attach cookies to WS upgrades): a VERIFIED identity, no token client-side
      const session = sessionFromCookie(req.headers.get("cookie"));
      // the address, HASHED (never kept raw): what a guest's ban names, since a guest has no account
      const ip = addressOf(req, srv);
      const addr = new Bun.CryptoHasher("sha256").update(`eidoverse-addr:${ip}`).digest("hex").slice(0, 24);
      if (srv.upgrade(req, { data: { session, addr } })) return undefined as unknown as Response;
      return new Response("expected websocket", { status: 400 });
    },
  },
  // ---- archipelago-home doors (connectome docs/home-node.md §7) ----
  {
    match: (u) => u.pathname === "/authcfg",
    handler: () => new Response(
      JSON.stringify({ login: HN_ISSUER_KEY ? HN_LOGIN_URL : null, required: HN_REQUIRE_LOGIN && Boolean(HN_ISSUER_KEY) }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } },
    ),
  },
  {
    // client console tee: errors and [xr] lines land in a file the operator can tail ($CLIENTLOG_DIR, default
    // WORLDS_DIR/.clientlogs); timestamp + text, no address. Bounded: 4 KB/body, 600 lines/min/world, 2000/min overall,
    // 5 MB/file. An OPEN door (empty JOIN_TOKEN) accepts writes from anyone: don't run it open on a public box.
    match: (u, req) => u.pathname === "/clientlog" && req.method === "POST",
    handler: async ({ req, url }) => {
      const label = (url.searchParams.get("world") ?? "").replace(/[^a-z0-9_-]/gi, "").slice(0, 64);   // 64: the world-name limit (world.ts)
      // an unknown label shares one bucket and file. The key rides the Authorization header, NEVER the URL (query tokens
      // leak into proxy logs): a key in the query is refused outright
      if (url.searchParams.has("key")) return new Response("key belongs in the Authorization header", { status: 400 });
      if (JOIN_TOKEN && bearerOf(req) !== JOIN_TOKEN) return new Response("no", { status: 401 });   // the door is the first gate: no lookup for a stranger
      const world = label && knownWorld(label) ? label : CLIENTLOG_UNKNOWN;
      const cl = req.headers.get("content-length");
      if (cl === null) return new Response("length required", { status: 411 });   // a chunked body would be buffered whole before the slice
      const len = Number(cl);
      if (!Number.isFinite(len) || len > CLIENTLOG_MAX_BODY) return new Response("too big", { status: 413 });
      const now = Date.now();
      if (now - clientLogGlobal.at > 60_000) { clientLogGlobal.at = now; clientLogGlobal.n = 0; }
      if (++clientLogGlobal.n > CLIENTLOG_GLOBAL_MIN) return new Response("slow down", { status: 429 });
      let bucket = clientLogRate.get(world);
      if (!bucket) { bucket = { at: now, n: 0 }; clientLogRate.set(world, bucket); }   // bounded by the worlds that exist + 'unknown'
      if (now - bucket.at > 60_000) { bucket.at = now; bucket.n = 0; }
      if (++bucket.n > CLIENTLOG_PER_WORLD_MIN) return new Response("slow down", { status: 429 });
      let body = "";
      try { body = (await req.text()).slice(0, CLIENTLOG_MAX_BODY); } catch { return new Response("bad", { status: 400 }); }
      const line = JSON.stringify({ t: new Date(now).toISOString(), line: body }) + "\n";
      const dest = join(CLIENTLOG_DIR, `clientlog-${world}.log`);
      try {
        if (existsSync(dest) && Bun.file(dest).size > CLIENTLOG_MAX_FILE) return new Response("full", { status: 507 });
        // appendFileSync, not Bun.write: Bun.write has no append and silently overwrites per line
        appendFileSync(dest, line);
      } catch (e) { console.warn(`[clientlog] append failed: ${(e as Error)?.message ?? e}`); return new Response("tee failed", { status: 500 }); }
      return new Response("ok", { headers: { "cache-control": "no-store" } });
    },
  },
  {
    match: (u) => u.pathname === "/whoami",
    handler: ({ req }) => {
      const s = sessionFromCookie(req.headers.get("cookie"));
      if (!s) return new Response(JSON.stringify({ error: "no session" }), { status: 401, headers: { "content-type": "application/json" } });
      return new Response(JSON.stringify({ sub: s.sub, name: s.name, scopes: s.scopes, claims: s.claims ?? {} }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    },
  },
  {
    match: (u, req) => u.pathname === "/auth" && req.method === "GET",
    handler: () =>
      // see AUTH_PAGE: the token stays in the URL FRAGMENT, out of this server's logs
      new Response(AUTH_PAGE, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "content-security-policy": AUTH_PAGE_CSP } }),
  },
  {
    match: (u, req) => u.pathname === "/auth" && req.method === "POST",
    handler: async ({ req, url }) => {
      if (!HN_ISSUER_KEY) return new Response(JSON.stringify({ error: "identity door not configured" }), { status: 503, headers: { "content-type": "application/json" } });
      let tok = "";
      try { tok = String(((await req.json()) as { token?: string }).token ?? ""); } catch { /* fall through */ }
      const v = verifyToken(tok, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD });
      if (!v.ok) {
        console.log(`[auth] login token rejected: ${v.reason}`);
        return new Response(JSON.stringify({ error: v.reason }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const p = v.payload;
      if (p.jti && !hnJti.claim(p.jti, p.exp)) {
        console.log(`[auth] login token replayed: ${p.sub}`);
        return new Response(JSON.stringify({ error: "token already used" }), { status: 403, headers: { "content-type": "application/json" } });
      }
      const sid = randomBytes(32).toString("hex");
      // opportunistic sweep, one entry per login
      for (const [k, s] of hnSessions) if (s.exp < Date.now()) hnSessions.delete(k);
      hnSessions.set(sid, { sub: p.sub, name: p.name, scopes: p.scopes, claims: p.claims, exp: Date.now() + SESSION_TTL_MS });
      saveSessions();
      const secure = (req.headers.get("x-forwarded-proto") ?? url.protocol.replace(":", "")) === "https" ? "; Secure" : "";
      console.log(`[auth] session for ${p.sub} ("${p.name}") [${p.scopes.join(" ")}]`);
      return new Response(JSON.stringify({ ok: true, name: p.name, sub: p.sub }), {
        headers: {
          "content-type": "application/json",
          "set-cookie": `ew_sess=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}${secure}`,
        },
      });
    },
  },
  {
    match: (u) => u.pathname === "/logout",
    handler: ({ req }) => {
      const sid = sessionIdOf(req.headers.get("cookie"));
      if (sid && hnSessions.delete(sid)) saveSessions();
      return new Response(JSON.stringify({ ok: true }), {
        headers: { "content-type": "application/json", "set-cookie": "ew_sess=; Path=/; HttpOnly; Max-Age=0" },
      });
    },
  },
  {
    match: (u) => u.pathname === "/check",
    handler: async ({ req, url, srv }) => {
      // the build check (server/buildcheck.ts), advisory and public like /geom; computed once per model in its own process
      // (buildcheck-queue.ts), so the first ask can take a few seconds
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
      const lib = url.searchParams.get("lib") ?? "";
      const file = resolveLibFile(lib);
      if (!file) return j({ error: `no such asset: ${lib}` }, 404);
      // ?scale=: as placed at that scale (0.05–20, to 2 places)
      const scale = checkScale(url.searchParams.get("scale") ?? 1);
      // public, so new work is gated per address and the queue is capped (buildcheck-queue.ts)
      const ip = addressOf(req, srv);
      try { return j({ lib, ...(await checkFile(file, scale, undefined, { address: ip }) as object) }); }
      catch (err) {
        if (err instanceof CheckRefused)
          return new Response(JSON.stringify({ lib, error: err.message }), { status: err.status, headers: { "content-type": "application/json", "retry-after": String(err.retryAfter) } });
        return j({ lib, error: String((err as Error)?.message ?? err) }, 500);
      }
    },
  },
  {
    match: (u) => u.pathname === "/geom",
    handler: async ({ req, url }) => {
      // geometry as DATA, public like the world log: ?lib=<path> one asset; ?world=W&id=<entity> plus its transform;
      // ?world=W the whole scene (&boxes=0 skips the parses). Raw bytes stay at GET /library/<lib>.
      const j = (o: unknown, status = 200) =>
        new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const wname = url.searchParams.get("world");
      if (!wname) {
        const lib = url.searchParams.get("lib") ?? "";
        const file = resolveLibFile(lib);
        if (!file) return j({ error: `no such asset: ${lib}` }, 404);
        const sum = await summarizeGlb(file);
        return sum ? j({ lib, ...sum }) : j({ error: "geometry parsing unavailable" }, 503);
      }
      if (!mayRead(req)) return unauthorized();
      // read-only, LOADED or on-disk worlds, never creates one; a world closed to this caller reads exactly like one that
      // does not exist (access.ts)
      if (!WORLD_NAME_RE.test(wname)
        || (!worlds.has(wname) && !hasWorldLog(wname))) {
        return j({ error: "no such world" }, 404);
      }
      if (!visibleTo(doorFor(wname), httpCaller(req))) return j({ error: "no such world" }, 404);
      const w = getWorld(wname);
      // the view record (shared/protocol/view.js viewOf) verbatim, never a projection of it
      const record = (eid: string, e: Record<string, unknown>) => ({ id: eid, ...e, model: e.model ?? null, parent: e.parent ?? null });
      const id = url.searchParams.get("id");
      if (id) {
        const e = w.state.entities[id];
        if (!e) return j({ error: `no entity "${id}" in ${wname}` }, 404);
        const file = e.model ? resolveLibFile(e.model) : null;
        const sum = file ? await summarizeGlb(file) : null;
        return j({ ...record(id, e),
          geometry: sum,   // local frame — compose with pos/q-or-yaw/scale for world space
          note: "geometry coords are the MODEL's local frame; sockets use the same frame, so a topSurface center is a socket pos verbatim" });
      }
      const withBoxes = url.searchParams.get("boxes") !== "0";
      const out = [];
      for (const [eid, e] of Object.entries(w.state.entities)) {
        const file = withBoxes && e.model ? resolveLibFile(e.model) : null;
        const sum = file ? await summarizeGlb(file) : null;
        out.push({ ...record(eid, e), kind: kindOf(e), ...(sum ? { bbox: sum.bbox, tris: sum.tris } : {}) });
      }
      return j({ world: wname, entities: out });
    },
  },
  {
    match: (u, req) => u.pathname === "/upload" && req.method === "POST",
    handler: ({ req, url, srv }) => handleUpload(req, url, srv),
  },
  {
    // POST /seat-profile, the live proposal door (#101): a NAMED actor only (tokens.json bearer or home-vouched aid1), never the
    // door token; PROPOSALS only, announced at once. The countersign has no HTTP path (tools/seat-accept.ts).
    match: (u, req) => u.pathname === "/seat-profile" && req.method === "POST",
    handler: async ({ req, url }) => {
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const tok = url.searchParams.get("token") ?? "";
      const actor = agentTokens().byToken.get(tok) ?? aid1JoinIdentity(tok)?.slug;
      if (!actor) {
        return j({ error: "a named actor is required — a tokens.json bearer or an aid1 credential; the authority token may not write seat profiles" }, 401);
      }
      const text = await req.text();
      if (new TextEncoder().encode(text).length > MAX_PROPOSAL_BYTES) {
        return j({ error: `proposal exceeds ${MAX_PROPOSAL_BYTES} bytes` }, 413);
      }
      let record: unknown;
      try { record = JSON.parse(text); } catch { return j({ error: "body must be JSON" }, 400); }
      const r = seatStore.propose(record as Record<string, unknown>, actor);
      if (!r.ok) return j({ error: r.why }, r.status);
      const notified = announceProfileUpdate(r.name, r.pose, r.rev);
      console.log(`[seats] proposal ${r.name}/${r.pose} by ${actor} → rev ${r.rev}, ${notified} client(s) notified`);
      return j({ ok: true, status: "proposed", rev: r.rev, name: r.name, pose: r.pose });
    },
  },
  {
    match: (u) => u.pathname === "/snap",
    handler: async ({ req, url, srv }) => {
      if (!mayRead(req)) return unauthorized();
      // own timeout past the broker's longest wait, capped at Bun's 255 s idleTimeout ceiling (config.ts keeps
      // SNAP_TIMEOUT_SEC ≤ 225 so the cap never cuts it)
      srv.timeout?.(req, Math.min(255, Math.ceil(snapshots.maxWaitMs / 1000) + 5));
      const w = worlds.get(url.searchParams.get("world") ?? "commons");
      const follow = url.searchParams.get("follow") ?? "";
      if (!w || !visibleTo(doorFor(w.name), httpCaller(req))) return new Response("unknown world", { status: 404 });
      const q = url.searchParams;
      const at = (q.get("at") ?? "").slice(0, 200) || undefined;
      const frame = normalizeSnapFrame({ dist: q.get("dist"), height: q.get("height"), pitch: q.get("pitch") });
      // ?budget=<ms>: how long the caller will wait; the broker never keeps it longer. Out of range or absent: its own deadline.
      const budget = Number(q.get("budget"));
      const callerBudget = Number.isFinite(budget) && budget >= 1_000 && budget <= 600_000 ? budget : undefined;
      // req.signal aborts when the asker leaves: a waiting ask leaves the queue unserved (snapshots.ts)
      const r = await snapshots.request(w, follow, q.get("view") ?? "first", q.get("renderer") ?? "auto", frame, at, callerBudget, req.signal);
      // Retry-After only on a failure asking again soon can fix (snapshots.ts retryAfter)
      if (!r.ok) return new Response(r.err, { status: r.status, headers: { "cache-control": "no-store",
        ...(r.retryAfter ? { "retry-after": String(r.retryAfter) } : {}) } });
      return new Response(r.png, { headers: { "content-type": "image/png", "cache-control": "no-store",
        "x-content-type-options": "nosniff", "x-eidoverse-renderer": r.engine, "x-eidoverse-scene": r.scene } });
    },
  },
  {
    // a world's ground as a 16-bit grayscale PNG (server/heightmap.ts), editable and returned via POST /upload?as=heightmap;
    // behind mayRead, never creates a world. ?res= a side (default 257); ?format=json the range alone
    match: (u) => u.pathname === "/heightmap",
    handler: ({ req, url, srv }) => {
      if (!mayRead(req)) return unauthorized();
      const name = url.searchParams.get("world") ?? "commons";
      if (!WORLD_NAME_RE.test(name)) return new Response("bad world name", { status: 400 });
      if (!worlds.has(name) && !hasWorldLog(name)) return new Response("no such world", { status: 404 });
      { const door = doorFor(name); if (!door || !visibleTo(door, httpCaller(req))) return new Response("no such world", { status: 404 }); }
      const t = getWorld(name).state.terrain;
      if (!t) return new Response("this world has no terrain (it is flat)", { status: 404 });
      if (url.searchParams.get("format") === "json") return Response.json({ ...heightRange(t as Record<string, unknown>), world: name });
      // bounded work on the serving thread, gated BEFORE the work (server/heightmap.ts serveHeightmapExport)
      const ip = addressOf(req, srv);
      const out = serveHeightmapExport(t as Record<string, unknown>, Number(url.searchParams.get("res") ?? 257), name, ip);
      if (!out.ok) return new Response(out.error, { status: out.status, headers: { "retry-after": String(out.retryAfter) } });
      const { png, meta } = out;
      return new Response(png, { headers: {
        "content-type": "image/png", "cache-control": "no-store",
        "content-disposition": `attachment; filename="${name}-heightmap.png"`,
        "x-terrain-min": String(meta.min), "x-terrain-max": String(meta.max), "x-terrain-size": String(meta.size),
      } });
    },
  },
  {
    // travel discovery: loaded worlds plus on-disk worlds with a log (never creates one), behind mayRead. ONE list of
    // people, each {id, declares?} (PROTOCOL §6a); spectators and renderers appear as nothing, as in-world.
    match: (u) => u.pathname === "/worlds",
    handler: ({ req }) => {
      if (!mayRead(req)) return unauthorized();
      const names = new Set<string>(worlds.keys());
      try {
        for (const n of readdirSync(WORLDS_DIR)) {
          if (WORLD_NAME_RE.test(n) && hasWorldLog(n)) names.add(n);
        }
      } catch { /* no worlds dir yet: only loaded worlds */ }
      // PER CALLER (cookie session or bearer): a world closed to the caller is not on their map at all (access.ts)
      const caller = httpCaller(req);
      const out = [...names].sort().flatMap((name) => {
        const door = doorFor(name);
        if (!door || !visibleTo(door, caller)) return [];
        const w = worlds.get(name);
        const present = w ? [...w.clients].filter((c) => !c.spectator && !c.superseded) : [];
        const mine = youAt(door, caller).you === "enter" ? "enter" : "watch";
        return [{
          name,
          loaded: !!w,
          access: door.label,          // open | watch | members: the door for everyone not named
          you: mine,                   // enter | watch: what THIS caller may do there
          people: present.map((c) => ({ id: c.id, ...(c.declares ? { declares: c.declares } : {}) })),
        }];
      });
      return new Response(JSON.stringify({ worlds: out }),
        { headers: { "content-type": "application/json", "cache-control": "no-store" } });
    },
  },
  {
    // "May I go there?", asked BEFORE moving so a refused trip never strands a body. Signed-in callers only (else 401).
    // A world the caller may not see answers `you: "none"`, `exists: true`: a taken name can't be hidden, nothing more.
    //   { world, exists, you: "enter"|"watch"|"none", why?, found?: {ok, why?} }
    match: (u) => u.pathname === "/access",
    handler: ({ req, url }) => {
      const j = (o: unknown, status = 200) => new Response(JSON.stringify(o),
        { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
      const caller = httpCaller(req);
      if (!caller) return j({ error: "sign in (cookie) or send Authorization: Bearer <your credential>" }, 401);
      const name = url.searchParams.get("world") ?? "";
      if (!WORLD_NAME_RE.test(name)) return j({ error: `"${name}" is not a world name` }, 400);
      const door = doorFor(name);
      // joining never founds a world here: `found` says so (a person founds with world-found; an operator for an agent)
      if (!door) return j({ world: name, exists: false, you: "none", found: { ok: false, why: `there's no world called "${name}" — joining never founds one here (a signed-in person founds a world with world-found; an operator founds one for an agent)` } });
      const y = youAt(door, caller);
      return j({ world: name, exists: true, you: y.you, ...(y.why && y.you !== "enter" ? { why: y.why } : {}) });
    },
  },
  {
    match: (u) => u.pathname === "/avatars",
    handler: () => new Response(JSON.stringify(avatarRoster()),
      { headers: { "content-type": "application/json", "cache-control": "no-store",
        // the store revision the verdicts were judged at: the client cache's generation guard, so a slow response from before
        // an acceptance can never roll it back
        "x-profiles-rev": String(seatStore.rev) } }),
  },
  {
    // the heartbeat's gauges (charter §4): per-system runs / worst ms / errors; public and cheap, so tick health is a lookup
    match: (u) => u.pathname === "/tick",
    handler: () => new Response(JSON.stringify({ ...tickStats() }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // the def registry (charter §3), one fetch per client boot; no-store so an edited def reaches the next boot
    match: (u) => u.pathname === "/defs",
    handler: () => new Response(defsPayload(),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // no-store on the LISTING keeps the mtime stamps trustworthy: the listing must never be the stale thing
    match: (u) => u.pathname === "/animations",
    handler: () => new Response(JSON.stringify(animationRoster()),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // #104 diagnostics: the adapter's live SFU view (legs, gens, consent, incarnation)
    match: (u) => u.pathname === "/relay-diag",
    handler: ({ req, url }) => new Response(
      JSON.stringify((() => {
        // a world the caller may not see answers like one with no voice at all
        const name = url.searchParams.get("world") ?? "commons";   // the default world, as /snap and /heightmap
        const w = worlds.get(name);
        return w && !visibleTo(doorFor(name), httpCaller(req)) ? { transport: "sfu", active: false } : sfuDiag(name);
      })()),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    // the running build (#51): public, cheap, cache-hostile. WORLD_INSTANCE_NONCE (tests only) adds `instance`, so a harness can
    // prove the process answering is the one it spawned
    match: (u) => u.pathname === "/version",
    // the representation key and both nonces come from this running process, never inferred from a newly served disk file
    handler: () => new Response(
      JSON.stringify({
        ...BUILD,
        ktx2Key: KTX2_KEY,
        lodRecipe: LOD_RECIPE,
        // what the optimizer is doing / could not afford (config.ts OPT_MEM_BUDGET_MB)
        opt: optStatus(),
        ...(process.env.WORLD_INSTANCE_NONCE ? { instance: process.env.WORLD_INSTANCE_NONCE } : {}),
      }),
      { headers: { "content-type": "application/json", "cache-control": "no-store" } }),
  },
  {
    match: (u) => u.pathname.startsWith("/thumb/"),
    handler: async ({ url }) => {
      // thumbnails are CONTRIBUTED: whoever wears a body renders one off its loaded VRM and posts it back
      const name = decodeURIComponent(url.pathname.slice("/thumb/".length)).replace(/\.png$/, "");
      const safe = name.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      const f = Bun.file(join(OPT_DIR, "thumbs", `${safe}.png`));
      if (!(await f.exists())) return new Response("no thumb", { status: 404 });
      return new Response(f, {
        headers: { "content-type": "image/png", "cache-control": "public, max-age=3600" },
      });
    },
  },
  {
    match: (u, req) => u.pathname === "/perflog" && req.method === "POST",
    handler: async ({ req, srv }) => {
      // load-performance beacon (client/lib/loadwork.js): timing lines and a UA only, append-only JSONL, capped
      try {
        const body = await req.text();
        if (body.length < 100_000) {
          const dest = join(WORLDS_DIR, ".perflogs.jsonl");
          const big = existsSync(dest) && Bun.file(dest).size > 5_000_000;
          if (!big) {
            // the address HASHED, like everywhere else this server keeps one: tells visitors apart, never the address itself;
            // the beacon can't write its own ts/addr/ip
            const ip = addressOf(req, srv);
            const addr = new Bun.CryptoHasher("sha256").update(`eidoverse-perflog:${ip}`).digest("hex").slice(0, 24);
            const { ts: _t, ip: _i, addr: _a, ...line } = JSON.parse(body) ?? {};
            appendFileSync(dest, JSON.stringify({ ts: Date.now(), addr, ...line }) + "\n");
          }
        }
      } catch { /* malformed beacon: drop */ }
      return new Response("ok");
    },
  },
  {
    // a Build card's rebuild: re-run one object's KTX2 + LOD passes; gated (below), rate-limited, the queue dedups
    match: (u, req) => u.pathname === "/rebuild" && req.method === "POST",
    handler: ({ req, url, srv }) => {
      // the /upload sign-ins (authority key, agent token, aid1 credential) plus a signed-in session cookie. The key rides
      // `Authorization: Bearer`, never the URL (it would land in access logs); a key in ?token= is refused.
      if (!mayRead(req)) return new Response("sign in or send the authority key as a Bearer header", { status: 401 });
      // a forced rebuild skips the freshness check, so a POST loop could keep the one serial pump busy and starve uploads
      const ip = addressOf(req, srv);
      const w = rebuildWin.get(ip) ?? { t: 0, n: 0 };
      if (Date.now() - w.t > 60_000) { w.t = Date.now(); w.n = 0; }
      w.n++; rebuildWin.set(ip, w);
      if (rebuildWin.size > 1000) for (const [k, v] of rebuildWin) if (Date.now() - v.t > 60_000) rebuildWin.delete(k);   // bounded
      if (w.n > 4) return new Response("rebuild rate limit (4/min)", { status: 429 });
      const r = rebuildAsset(url.searchParams.get("path") ?? "");
      if (!r) return new Response("not a rebuildable object", { status: 400 });
      console.log(`[rebuild] ${url.searchParams.get("path")}: ${r.queued.join(" + ") || "nothing (no encoder)"}`);
      return new Response(JSON.stringify({ ok: true, ...r }), { headers: { "content-type": "application/json" } });
    },
  },
  {
    match: (u, req) => u.pathname === "/thumb" && req.method === "POST",
    handler: async ({ req, url }) => {
      // the authority key rides `Authorization: Bearer`, never the URL (access logs); ?token= is refused outright so a stale
      // client cannot keep leaking it
      if (url.searchParams.has("token")) return new Response("key belongs in the Authorization header", { status: 400 });
      if (JOIN_TOKEN && bearerOf(req) !== JOIN_TOKEN) return new Response("token required", { status: 401 });
      const safe = (url.searchParams.get("name") ?? "").replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 48);
      if (!safe) return new Response("name required", { status: 400 });
      const dir = join(OPT_DIR, "thumbs");
      mkdirSync(dir, { recursive: true });
      const dest = join(dir, `${safe}.png`);
      // the body's measured stature (skeleton-derived, client-side), so /avatars can hand catalogs a common-scale roster
      const height = Number(url.searchParams.get("height"));
      const hOk = Number.isFinite(height) && height > 0.2 && height < 20;
      // …and its loupe numbers, measured on the LOADED body (perfscope.statsOf), tied to version `v`; the rank is
      // recomputed HERE (shared/perfrank.js), never taken from the client
      const perf = avatarPerfParam(url.searchParams.get("perf"), url.searchParams.get("v"));
      if (hOk || perf) {
        const metaPath = join(dir, "meta.json");
        let meta: Record<string, { h?: number; perf?: AvatarPerf }> = {};
        try { if (existsSync(metaPath)) meta = JSON.parse(readFileSync(metaPath, "utf8")); } catch { /* fresh */ }
        meta[safe] = { ...meta[safe], ...(hOk ? { h: Math.round(height * 100) / 100 } : {}), ...(perf ? { perf } : {}) };
        atomicWrite(metaPath, JSON.stringify(meta));
      }
      // first contributor wins, unless a re-mint pass forces the refresh
      const force = url.searchParams.get("force") === "1";
      if (existsSync(dest) && !force) return new Response(JSON.stringify({ ok: true, existed: true, perf: !!perf }),
        { headers: { "content-type": "application/json" } });
      const body = new Uint8Array(await req.arrayBuffer());
      if (body.length === 0 && perf) return new Response(JSON.stringify({ ok: true, meta: true, perf: true }), { headers: { "content-type": "application/json" } });
      if (body.length > 400_000) return new Response("thumb too large", { status: 413 });
      if (body.length < 8 || body[0] !== 0x89 || body[1] !== 0x50) return new Response("not a PNG", { status: 415 });
      writeFileSync(dest, body);
      console.log(`[thumb] ${safe} (${(body.length / 1000).toFixed(0)}KB${force ? ", forced" : ""})`);
      return new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } });
    },
  },
  {
    match: (u) => u.pathname === "/library-list",
    handler: ({ url }) => {
      // a listing over the library, so the browser host DISCOVERS which toolkit modules to prime (no manifest)
      const rel = url.searchParams.get("dir") ?? "";
      const out: { path: string; size: number }[] = [];
      const walk = (base: string, sub: string, depth: number) => {
        if (depth > 4) return;
        const abs = normalize(join(base, sub));
        if (!abs.startsWith(base) || !existsSync(abs)) return;
        for (const e of readdirSync(abs, { withFileTypes: true })) {
          const childRel = sub ? `${sub}/${e.name}` : e.name;
          if (e.isDirectory()) walk(base, childRel, depth + 1);
          // serving artifacts (KTX2 variants, .failed markers, .tmp) are not entries, or the prefetcher fetches them as assets
          // (store-variants.ts)
          else if (!isServingArtifact(e.name)) out.push({ path: childRel, size: Bun.file(join(abs, e.name)).size });
        }
      };
      // opt first: the listed size must describe the file a client receives (the prefetcher budgets by it)
      for (const base of [OPT_DIR, LIBRARY_DIR]) walk(base, rel, 0);
      // the opt mirror shadows the library at the same path: first wins
      const seen = new Set<string>();
      const uniq = out.filter((f) => !seen.has(f.path) && seen.add(f.path));
      return new Response(JSON.stringify(uniq), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
  {
    match: (u) => u.pathname === "/library-models",
    handler: ({ url }) => {
      // the agents' catalog (mcpl `list_library`), served to humans; same crude filename-token scoring: parity over cleverness
      const q = (url.searchParams.get("q") ?? "").toLowerCase().split(/\s+/).filter(Boolean);
      const dirs = [join(LIBRARY_DIR, "eidoverse/assets/models"), join(OPT_DIR, "eidoverse/assets/models")];
      const files = new Map<string, number>();
      for (const d of dirs) {
        if (!existsSync(d)) continue;
        for (const f of readdirSync(d)) {
          // variants, markers and .tmp are not catalog entries (store-variants.ts isServingArtifact)
          if (!f.endsWith(".glb") || isServingArtifact(f)) continue;
          const low = f.toLowerCase();
          const score = q.length ? q.filter((t) => low.includes(t)).length : 1;
          if (score > 0) files.set(f, Math.max(files.get(f) ?? 0, score));
        }
      }
      const hits = [...files]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 60)
        .map(([f]) => {
          // the library ships a _preview.jpg beside every model: what makes the list a catalog
          const prev = f.replace(/\.glb$/i, "_preview.jpg");
          const hasPrev = dirs.some((d) => existsSync(join(d, prev)));
          // every optimization's state, from the sweep's markers (store-variants.ts variantStatus); library variants live in the
          // OPT mirror
          const libOpt = join(OPT_DIR, "eidoverse/assets/models");
          const libSrc = variantSource(`eidoverse/assets/models/${f}`, { opt: OPT_DIR, library: LIBRARY_DIR })!;
          const rebuildable = existsSync(libSrc);
          return {
            path: `eidoverse/assets/models/${f}`,
            // ↻ rebuilds from the LIBRARY source (upload.ts rebuildAsset); an OPT-only model has none and would answer 400, so the
            // card leaves the button off
            rebuildable,
            // no draco "min" pass for library models; the library file is MUTABLE, so variants and verdicts are judged freshOver
            // variantSource, as the sweep and route do
            opt: (({ min: _none, ...rest }) => rest)(variantStatus(join(libOpt, f), libOpt, { source: libSrc })),
            // the loupe's rank of the SERVED file and of the original (glbperf.ts; mtime-cached; null = unreadable)
            ...perfPair(`eidoverse/assets/models/${f}`, join(LIBRARY_DIR, "eidoverse/assets/models", f)),
            // SEO-soup filenames → something a person can read
            name: f.replace(/\.glb$/i, "").replace(/_/g, " ").slice(0, 48),
            preview: hasPrev ? `eidoverse/assets/models/${prev}` : null,
            // who made it and its licence (defs/library/credits.json; a gap says what isn't recorded)
            credits: creditsFor(libraryCredits(), `eidoverse/assets/models/${f}`),
          };
        });
      // the content-addressed store is catalog too, so a delivered object is findable, not named only by its hash. Newest
      // first, names from the manifest.
      const storeDir = join(OPT_DIR, "store");
      if (existsSync(storeDir)) {
        let man: Record<string, { name?: string; by?: string; ts?: number }> = {};
        try { man = JSON.parse(readFileSync(join(storeDir, "manifest.json"), "utf8")); } catch { /* unnamed */ }
        const store = readdirSync(storeDir)
          // a KTX2 variant (<hash>.glb.ktx2.glb) is the same model, not an entry (store-variants.ts)
          .filter(isStoreOriginal)
          .map((f) => {
            const hash = f.replace(/\.glb$/i, "");
            const m = man[hash];
            return { f, name: (m?.name ?? `conjured ${hash.slice(0, 8)}`).slice(0, 48), ts: m?.ts ?? 0,
              score: q.length ? q.filter((t) => (m?.name ?? "").toLowerCase().includes(t)).length : 1 };
          })
          .filter((s) => s.score > 0)
          .sort((a, b) => b.ts - a.ts)
          .slice(0, 30)
          // the status + perf read (a GLB parse on a cold cache) only for the 30 returned, never the whole store
          .map(({ f, name }) => ({ path: `store/${f}`, name, preview: null as string | null, rebuildable: true,
            opt: variantStatus(join(storeDir, f), STORE_MIN), ...perfPair(`store/${f}`, join(storeDir, f)) }));
        hits.push(...store);
      }
      return new Response(JSON.stringify(hits), {
        headers: { "content-type": "application/json", "cache-control": "no-store" },
      });
    },
  },
  // spec/EIDO-URIS.md §3: exactly the bytes an address names (the original upload, never a variant), cached forever
  {
    match: (u) => /^\/eido\/sha256\/[0-9a-f]{64}$/.test(u.pathname),
    handler: ({ req, url }) => {
      const file = eidoFile(url.pathname.slice("/eido/sha256/".length));
      if (!file) return new Response("not found", { status: 404 });
      return serveFrom(dirname(file), basename(file), true, req, true);
    },
  },
  {
    match: (u) => u.pathname.startsWith("/library/"),
    handler: ({ req, url }) => {
      // /library/eido/sha256/<hex>.glb (shared/eido.js libRelOf): this host's rendition of the file the address names,
      // through the same ladder as its path
      const rel0 = url.pathname.slice("/library/".length); const eh = hexOfLibRel(rel0);   // either spelling of an address (shared/eido.js)
      // url.pathname keeps percent-encoding; libraryRel() decodes it (and refuses a decoded ".."), the one function every
      // resolver reads a lib through (server/libfile.ts), so they agree on every name
      const dec = eh ? rel0 : libraryRel(rel0);
      if (dec === null) return new Response("forbidden", { status: 403 });
      const rel = eh ? eidoRel(eh) ?? rel0 : dec;
      // optimized mirror first (draco+webp): same path, ~30x smaller
      const versioned = url.searchParams.has("v") || rel.startsWith("store/"); // content-addressed = immutable
      // native importers may lack Draco/WebP decoders: ?native=1 returns the provenance bytes, never the shadow; serveFrom
      // still enforces path containment
      if (url.searchParams.get("native") === "1" && /\.(glb|vrm)$/i.test(rel)) {
        const patched = normalize(join(PATCH_DIR, rel));
        if (patched.startsWith(PATCH_DIR + "/") && existsSync(patched)) return serveFrom(PATCH_DIR, rel, true, req, versioned);
        if (rel.startsWith("store/")) return serveFrom(OPT_DIR, rel, true, req, true);
        return serveFrom(LIBRARY_DIR, rel, true, req, versioned);
      }
      // deliberate upstream forks win over EVERYTHING (patched/README.md): same URL, delete-to-fall-back
      {
        const p = normalize(join(PATCH_DIR, rel));
        if (p.startsWith(PATCH_DIR) && existsSync(p)) return serveFrom(PATCH_DIR, rel, true, req, versioned);
      }
      // KTX2/LOD variants are negotiated, never the default (§20): parsers without a KTX2 decoder throw on required
      // extensions, so only ?ktx2=<key> gets them, as its own cache entry. A VRM variant older than its original is stale:
      // serve the original. Loose images use a .ktx2 sibling, sniffed by the client.
      const negotiable = rel.endsWith(".glb") || rel.endsWith(".vrm") || /\.(png|jpe?g)$/i.test(rel);
      // the key is a generation (shared/ktx2.js): a retired one is an unflagged fetch
      const wantKtx2 = wantsKtx2(url.searchParams) && negotiable;
      // the LOD tier rides the ktx2 negotiation, only with the RECIPE /version published: a recipe change is a fresh URL,
      // so an old reduction never sits pinned under a new address
      const lodAsked = url.searchParams.get("lod");
      const wantLod = lodAsked === LOD_RECIPE && wantKtx2 && rel.endsWith(".glb");
      // the tier's answer is NAMED (x-eidoverse-lod): `variant`, `refused=<kind>` (a standing verdict: the original is final,
      // store-variants.ts lodVerdictFinal) or `provisional`
      let lodFinal = false;
      let lodState: string | null = null;
      if (wantLod) {
        const lRel = lodVariantPath(rel);
        const l = normalize(join(OPT_DIR, lRel));
        // library sources are MUTABLE: a variant or verdict about an older source falls through provisional, judged against
        // the file the sweep BUILT from (variantSource) by recorded identity (store-variants.ts freshOver)
        const src = variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR });
        const freshOverSource = (p: string) => freshOver(p, src);
        if (l.startsWith(OPT_DIR) && existsSync(l) && freshOverSource(l)) return serveFrom(OPT_DIR, lRel, true, req, versioned, false, { variant: true, headers: { "x-eidoverse-lod": "variant" } });
        const marker = `${l}.failed`;
        if (l.startsWith(OPT_DIR) && existsSync(marker) && freshOverSource(marker)) {
          let content = "";
          try { content = readFileSync(marker, "utf8"); } catch { /* unreadable = undecided */ }
          const kind = lodVerdictKind(content);
          lodFinal = lodVerdictFinal(content);
          lodState = lodFinal ? `refused=${kind}` : `provisional; verdict=${kind ?? "unknown"}`;
        } else lodState = "provisional";
      } else if (lodAsked != null) lodState = "provisional; generation=unrecognized";
      const lodHeader = lodState ? { "x-eidoverse-lod": lodState } : undefined;
      if (wantKtx2) {
        const kRel = rel.endsWith(".glb") ? `${rel}.ktx2.glb`
          : rel.endsWith(".vrm") ? `${rel}.ktx2.vrm` : `${rel}.ktx2`;
        const k = normalize(join(OPT_DIR, kRel));
        if (k.startsWith(OPT_DIR) && existsSync(k)) {
          let fresh = true;
          if (rel.endsWith(".vrm")) fresh = freshOver(k, variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR }));
          // a lod fetch answered by the plain ktx2 variant is PROVISIONAL unless a typed verdict stands (then VARIANT_CC); a
          // FINAL answer must not serve ktx2 bytes older than a re-exported source
          let ktx2Stale = false;
          if (lodFinal) ktx2Stale = !freshOver(k, variantSource(rel, { opt: OPT_DIR, library: LIBRARY_DIR }));
          const finalHere = lodFinal && !ktx2Stale;
          const header = ktx2Stale ? { "x-eidoverse-lod": `${lodState!.replace(/^refused=/, "provisional; verdict=")}; ktx2=stale` } : lodHeader;
          if (fresh) return serveFrom(OPT_DIR, kRel, true, req, versioned, lodAsked != null && !finalHere, { variant: true, headers: header });
        }
      }
      // a flagged fetch that falls through is provisional (no-cache + ETag), so the variant reaches clients once it exists;
      // an unknown lod generation must not be pinned either
      const provisional = wantKtx2 || (lodAsked != null && !wantLod);
      const deepHeader = lodFinal ? { "x-eidoverse-lod": `${lodState}; ktx2=undecided` } : lodHeader;
      // store uploads prefer the store-min shadow; the original stays as provenance and fallback until optimize lands
      if (rel.startsWith("store/")) {
        const minRel = `store-min/${rel.slice("store/".length)}`;
        const min = normalize(join(OPT_DIR, minRel));
        if (min.startsWith(OPT_DIR) && existsSync(min)) return serveFrom(OPT_DIR, minRel, true, req, true, provisional, { headers: deepHeader });
      }
      const opt = normalize(join(OPT_DIR, rel));
      if (opt.startsWith(OPT_DIR) && existsSync(opt)) return serveFrom(OPT_DIR, rel, true, req, versioned, provisional, { headers: deepHeader });
      return serveFrom(LIBRARY_DIR, rel, true, req, versioned, provisional, { headers: deepHeader });
    },
  },
  {
    match: (u) => u.pathname.startsWith("/node_modules/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1), true, req),
  },
  {
    // shared/ (shared/README.md): code, so no-store; ../../shared/… from client files clamps to /shared/ in a browser
    match: (u) => u.pathname.startsWith("/shared/"),
    handler: ({ req, url }) => serveFrom(join(ROOT, "shared"), url.pathname.slice("/shared/".length), false, req),
  },
  {
    // liveness for benches: echoes BENCH_NONCE, so a harness can prove the port it drives is ITS child
    match: (u) => u.pathname === "/health",
    handler: () => new Response(JSON.stringify({ ok: true, nonce: process.env.BENCH_NONCE ?? null, pid: process.pid }),
      { headers: { "content-type": "application/json" } }),
  },
  {
    match: (u) => u.pathname === "/client-version",
    handler: () => {
      // polled by the renderer watchdog: newest client-file mtime, so a deploy or dev edit reloads a renderer. Cached 5s.
      const now = Date.now();
      if (!clientVersionCache || now - clientVersionCache.at > 5000) {
        let newest = 0;
        const dir = join(ROOT, "client");
        const walk = (d: string, depth: number) => {
          if (depth > 3) return;
          for (const e of readdirSync(d, { withFileTypes: true })) {
            if (e.name === "node_modules") continue;
            const p = join(d, e.name);
            if (e.isDirectory()) walk(p, depth + 1);
            else newest = Math.max(newest, Bun.file(p).lastModified);
          }
        };
        try { walk(dir, 0); } catch { /* best effort */ }
        clientVersionCache = { at: now, v: String(newest) };
      }
      return new Response(clientVersionCache.v, { headers: { "content-type": "text/plain", "cache-control": "no-store" } });
    },
  },
  {
    match: (u) => u.pathname === "/favicon.ico",
    handler: () =>
      // browsers ask unprompted; without this every page load logged a 500
      new Response(
        // the mark's hand-set 32 px master, same drawing as index.html's icon, for pages that don't carry one
        `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32">
           <style>path{fill:#8fe8c8}@media (prefers-color-scheme:light){path{fill:#1d7a5f}}</style>
           <path d="M6.361 4 L25 4 L25 12 L21 12 L21 8 L2.407 8 A14.5 14.5 0 0 1 6.361 4 Z"/>
           <path d="M2.407 24 L21 24 L21 20 L25 20 L25 28 L6.361 28 A14.5 14.5 0 0 1 2.407 24 Z"/>
           <path d="M9.335 14 L28.861 14 A14.5 14.5 0 0 1 28.861 18 L9.335 18 A5.539 5.539 0 0 1 9.335 14 Z"/>
         </svg>`,
        { headers: { "content-type": "image/svg+xml", "cache-control": "public, max-age=86400" } },
      ),
  },
  {
    match: (u) => u.pathname.toLowerCase() === "/agents.md",
    handler: ({ req }) =>
      // the closed-verb-set error says "see AGENTS.md", so it is reachable from the world, in any casing
      serveFrom(ROOT, "AGENTS.md", false, req),
  },
  {
    match: (u) => u.pathname === "/" || u.pathname === "/index.html",
    handler: ({ req }) => serveFrom(join(ROOT, "client"), "index.html", false, req),
  },
  {
    // the catch-all: the browser client's static tree
    match: () => true,
    handler: ({ req, url }) => serveFrom(join(ROOT, "client"), url.pathname.slice(1), false, req),
  },
];

// COOP same-origin + COEP credentialless on EVERY response (workers too), so SharedArrayBuffer enables multithreaded
// TTS (engine-piper.js); credentialless so third-party assets still load. COOP severs window.opener, so Orrery sign-in
// polls /api/auth/me instead. Call-site audit: docs/research/cross-origin-isolation.md.
function isolate(res: Response): Response {
  // a successful /ws upgrade returns nothing (Bun owns the socket): touching it would throw on every connection
  if (!res) return res;
  // a 101 upgrade owns its handshake: never touch it
  if (res.status === 101) return res;
  res.headers.set("cross-origin-opener-policy", "same-origin");
  res.headers.set("cross-origin-embedder-policy", "credentialless");
  // every page carries a CSP: one served without (a future inline-HTML route) gets the policy with no inline script
  if ((res.headers.get("content-type") ?? "").startsWith("text/html") && !res.headers.has("content-security-policy")) res.headers.set("content-security-policy", cspFor());
  return res;
}

/** One pass over the table, first match wins (the catch-all is last); a successful /ws upgrade returns nothing. */
export function route(req: Request, srv: Srv): Response | Promise<Response> {
  const url = new URL(req.url);
  for (const r of ROUTES) {
    if (!r.match(url, req)) continue;
    const out = r.handler({ req, url, srv });
    return out instanceof Promise ? out.then(isolate) : isolate(out);
  }
  // unreachable (the catch-all matches everything), but a table must not strand a request if an edit breaks that
  return isolate(new Response("not found", { status: 404 }));
}
