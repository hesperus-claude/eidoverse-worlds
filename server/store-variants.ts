// store-variants — the store's serving shadows, named in one place.
//
// A store upload (content-addressed: assets/opt/store/<hash>.glb, immutable) gets two shadows from upload.ts's
// optimize pump, both served by routes.ts on the ORIGINAL's address:
//   store-min/<hash>.glb        draco + webp@1024, the unflagged answer
//   store/<hash>.glb.ktx2.glb   draco + KTX2, the ?ktx2=<key> answer (beside the original, as library variants are)
// The KTX2 variant ends in .glb too: enumerate store/*.glb with isStoreOriginal and skip isKtx2Variant in listings, or
// variants ghost-list and download twice (§20c). A flagged fetch that falls through to webp is served no-cache
// (provisional), never immutable: content-addressing makes the address immutable, not the flagged answer.
// DOM-free and side-effect-free: unit-tested in tools/store-variants-test.ts.

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { currentToolsDigest, toolVersions, toolsStamp } from "./tools-stamp.ts";
import { R_BASE, DIAG_K, LOD_FRACTION, LOD_HYST } from "../shared/lod-distance.js";

/** The variant suffix. `<hash>.glb` + this = the KTX2 shadow's file name. */
export const KTX2_SUFFIX = ".ktx2.glb";

// ---- the texel budget ------------------------------------------------------
// the KTX2 arm keeps the webp shadow's 1024² house budget (optimize.ts), GPU-native: downscale only, longest side
// KTX2_TEXEL_CAP, 4-aligned; toktx does it (--resize), never libvips. From full-res sources variants came out bigger.
export const KTX2_TEXEL_CAP = 1024;

/** The resize a texture of `size` needs to fit the budget, or null when it
 *  already does. Aspect kept; both sides rounded to a multiple of 4. */
export function capTexels(size: [number, number] | null | undefined, cap = KTX2_TEXEL_CAP): [number, number] | null {
  if (!size || !(size[0] > 0) || !(size[1] > 0)) return null;
  const [w, h] = size;
  if (w <= cap && h <= cap) return null;
  const k = cap / Math.max(w, h);
  const r = (v: number) => Math.max(4, Math.round((v * k) / 4) * 4);
  return [r(w), r(h)];
}

// a size verdict ("not smaller") is only as durable as its RECIPE: the CLI stamps it, and a verdict without the
// CURRENT stamp is re-measured once. Content verdicts (no raster images, a corrupt container) carry no stamp and stand.
export const KTX2_RECIPE = "texel1024";
export const recipeStamp = (recipe = KTX2_RECIPE) => `recipe=${recipe}`;
/** Does `content` carry the stamp for exactly `recipe`? Delimited, never a prefix: `recipe=…-min12000` must not answer
 *  for `…-min120000`. */
export const hasStamp = (content: string, recipe: string) => {
  const v = structuredVerdict(content);   // a JSON marker / the CLI's [verdict] line: its recipe field, exactly
  if (v) return v.recipe === recipe;
  return new RegExp(`(^|\\s)${recipeStamp(recipe).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(content);
};

// ---- the geometry LOD (placeable objects only) ---------
// `<rel>.lod.<recipe>.glb` beside the original: weld + meshopt-simplify at LOD_RATIO, ktx2 texel budget, draco; identity
// in asset.extras. Bodies fail closed by structure (skins, VRM metadata, morphs) with a typed verdict; names, materials
// and bounds are asserted unchanged after the reduce.
// LOD_GEN: bump when weld/simplify semantics, the gates, the tool or the texel-density measure (optimize.ts
// lodTexelCaps) change: 'light' verdicts are final, and nothing else in the URL re-asks them.
export const LOD_GEN = 3;
export const LOD_RATIO = 0.25;      // meshopt-simplify target ratio: the floor it may reach, not a quota
// screen-space budget at the closest distance 'auto' shows the LOD (shared/lod-distance.js lodNearest), at headset
// density: geometry error ≤ LOD_PX px; textures ≥ LOD_TEXELS_PER_PX texels/px over the least densely mapped part, unused
// mips dropped. 'eco' and pressure show it at half that distance (lod_policy.js PRESSURE_EDGE). Values measured on #207.
export const LOD_PX = 2;
export const LOD_PPD = 25;          // pixels per degree: a Quest 3's centre, stricter than a desktop 55° view
export const LOD_TEXELS_PER_PX = 1;
// texture-only LOD: a model whose vertices can't come under 0.6× still gets a LOD when its textures fall to at most this
// share of the full tier's GPU texture memory
export const LOD_TEX_ONLY = 0.5;
// Under this many vertices geometry is not simplified; textures still are (a texture-only LOD). The real geometry lever
// is a LOD chain, a follow-up, not this floor.
export const LOD_MIN_VERTS = 12_000;

/** The recipe string DERIVES from every parameter a variant or verdict depends on, and it is in the URL and every
 *  filename, so changing any of them is a new generation by construction (fresh names, a fresh sweep). */
export function lodRecipeFor({ gen = LOD_GEN, ratio = LOD_RATIO, px = LOD_PX, ppd = LOD_PPD, tpp = LOD_TEXELS_PER_PX,
  texOnly = LOD_TEX_ONLY, texel = KTX2_TEXEL_CAP, minVerts = LOD_MIN_VERTS,
  // the DISTANCE the budget is taken at (shared/lod-distance.js lodNearest) is a parameter too: the client's residency
  // radius and switch fraction live in a shared module, and tuning them re-budgets every LOD — so it re-names them
  rBase = R_BASE, diagK = DIAG_K, fraction = LOD_FRACTION, hyst = LOD_HYST } = {}): string {
  // the fraction's own decimal digits, every one of them — 0.25 → 25, 0.014 → 014: two settings the reducer tells
  // apart must never share a string (a rounded percent read 0.014 as 0.01, and the sweep would have skipped every
  // existing file under the unchanged address)
  const frac = (x: number, what: string) => {
    const s = x.toString();
    if (!(x > 0 && x < 1) || !/^0\.\d+$/.test(s)) throw new Error(`lod ${what} must be a plain decimal in (0, 1): ${s}`);
    return s.slice(2);
  };
  // a positive decimal, every digit kept, the point spelled p: 2 → 2, 1.5 → 1p5, 0.75 → 0p75
  const dec = (x: number, what: string) => {
    const s = x.toString();
    if (!(x > 0) || !/^\d+(\.\d+)?$/.test(s)) throw new Error(`lod ${what} must be a plain positive decimal: ${s}`);
    return s.replace(".", "p");
  };
  if (!Number.isInteger(texel) || !Number.isInteger(minVerts) || !Number.isInteger(gen) || !Number.isInteger(ppd) || !(ppd > 0))
    throw new Error("lod gen/ppd/texel/minVerts must be integers");
  return `lod${gen}-r${frac(ratio, "ratio")}-px${dec(px, "px")}ppd${ppd}-tpp${dec(tpp, "tpp")}-tx${frac(texOnly, "texOnly")}`
    + `-d${dec(rBase, "rBase")}k${dec(diagK, "diagK")}f${frac(fraction, "fraction")}h${frac(hyst, "hyst")}-texel${texel}-min${minVerts}`;
}
export const LOD_RECIPE = lodRecipeFor();   // "lod3-r25-px2ppd25-tpp1-tx5-d80k4f45h25-texel1024-min12000"

// ---- standing verdicts -------------------------------------------------------
// refusals that depend only on content + recipe (both in the URL: structural, light) are final and cacheable;
// ineffective, preservation and gpu depend on the reducer, encoder or host and stay provisional until LOD_GEN bumps;
// anything unclassified stays provisional
export type LodVerdictKind = "structural" | "light" | "ineffective" | "preservation" | "gpu";
const LOD_KINDS = new Set<string>(["structural", "light", "ineffective", "preservation", "gpu"]);
/** Which class of typed refusal a lod `.failed` marker records — or null for anything else. Read through readVerdict,
 *  the ONE reader: the route (serve time) and classifyVariant (the catalog's card) both call it, so the wire and the
 *  card cannot disagree. */
export function lodVerdictKind(content: string): LodVerdictKind | null {
  const k = readVerdict(content).kind;
  return LOD_KINDS.has(k) ? k as LodVerdictKind : null;
}
/** Does this marker make the original the FINAL answer under `recipe`? A
 *  content-only class (structural, light) stamped with the running recipe —
 *  the filename binds the recipe too; the stamp is the belt to that brace. */
export function lodVerdictFinal(content: string, recipe = LOD_RECIPE): boolean {
  const kind = lodVerdictKind(content);
  return (kind === "structural" || kind === "light") && hasStamp(content, recipe);
}

// ---- source identity: freshness by EQUALITY, never by mtime order ------------------------------------------------------
// a derived file is fresh iff the source identity recorded when its pass STARTED equals the source's now: size +
// mtimeMs + sha256 (cp -p and rsync -a restore mtimes). The sha is cached per path under (size, mtimeMs, ino, ctimeMs).
// No sha: compare the stat pair; no identity: strictly newer than its source; `source` null (content-addressed): fresh.
export type SourceIdentity = { size: number; mtimeMs: number; sha?: string };
export type StatFn = (p: string) => SourceIdentity | null;
const digestCache = new Map<string, { key: string; sha: string }>();
/** Bytes diskIdentity hashed since start (a harness checks a cache hit reads nothing). */
export const identityIo = { bytes: 0 };
export const diskIdentity: StatFn = (p) => {
  try {
    const s = statSync(p);
    const key = `${s.size}:${s.mtimeMs}:${s.ino}:${s.ctimeMs}`;
    let hit = digestCache.get(p);
    if (hit?.key !== key) {
      const bytes = readFileSync(p);
      identityIo.bytes += bytes.length;
      hit = { key, sha: createHash("sha256").update(bytes).digest("hex") };
      digestCache.set(p, hit);
    }
    return { size: s.size, mtimeMs: s.mtimeMs, sha: hit.sha };
  } catch { return null; }
};
/** Where a VARIANT's recorded source identity lives (a verdict marker carries its own, inline). */
export const sourceSidecar = (variant: string) => `${variant}.srcid`;
export const sameIdentity = (a: SourceIdentity | null, b: SourceIdentity | null) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs
  && (a.sha == null || b.sha == null || a.sha === b.sha);
/** The marker's token for a source identity — its own line, so no reader of the verdict line ever sees it. */
export const sourceToken = (id: SourceIdentity) => `source=${id.size}:${id.mtimeMs}`;
export function parseSourceToken(content: string): SourceIdentity | null {
  const m = /(?:^|\s)source=(\d+):(\d+(?:\.\d+)?)(?:\s|$)/.exec(content);
  return m ? { size: Number(m[1]), mtimeMs: Number(m[2]) } : null;
}
/** The identity a derived file recorded: a `.failed` marker's inline token, a variant's `.srcid` sidecar. */
export function recordedSource(derived: string, read: (p: string) => string): SourceIdentity | null {
  if (derived.endsWith(".failed")) return readVerdict(read(derived)).source;
  try {
    const j = JSON.parse(read(sourceSidecar(derived)) || "null");
    return asId(j);
  } catch { return null; }
}
const readOrEmpty = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } };
/** THE freshness rule, for the sweep, the pump, the route and the catalog alike. */
export function freshOver(derived: string, source: string | null,
  { read = readOrEmpty, stat = diskIdentity }: { read?: (p: string) => string; stat?: StatFn } = {}): boolean {
  if (source == null) return true;
  const cur = stat(source);
  if (!cur) return false;                     // the source is gone: nothing current to be fresh over
  const rec = recordedSource(derived, read);
  if (rec) return sameIdentity(rec, cur);
  const d = stat(derived);                    // legacy: no identity recorded — the old strictly-newer rule
  return !!d && d.mtimeMs > cur.mtimeMs;
}
/** The source a rel's variants and verdicts are ABOUT, the file the build read: null = content-addressed (store/); a GLB
 *  from the LIBRARY file (never the OPT mirror or PATCH copy); a VRM from the overlay if it has one, else the library. */
export function variantSource(rel: string, dirs: { opt: string; library: string }): string | null {
  if (rel.startsWith("store/")) return null;
  const inside = (base: string) => { const p = join(base, rel); return p.startsWith(base) ? p : null; };
  if (rel.endsWith(".vrm")) {
    const o = inside(dirs.opt);
    if (o && existsSync(o)) return o;
  }
  return inside(dirs.library) ?? "";   // outside the tree: no file, so nothing is fresh over it
}

// ---- the verdict RECORD: structured markers, one reader ---------------------------------------------------------
// a marker's kind is a closed enum, its prose display only (RFC 9457 §3.1.4): the CLI names each refusal's kind where it
// mints the phrase (`[verdict] {json}`), the pump writes JSON markers, and readVerdict is the ONE parser (JSON, else
// `[verdict]`, else the legacy text). `failure` (a crash, any exit but 2) is never final and re-asked on a tool change.
export type VerdictKind = LodVerdictKind | "size" | "nothing" | "unsupported" | "unsuitable" | "failure" | "unknown";
const VERDICT_KINDS = new Set<string>(["structural", "light", "ineffective", "preservation", "gpu", "size", "nothing", "unsupported", "unsuitable", "failure", "unknown"]);
/** The refusals a different tool could overturn (verdictStands re-asks them when the tools change). A content fact — a
 *  skinned body, under the floor, no raster images, a non-POT image — is not: it is about the file (tools-stamp.ts). */
const TOOL_KINDS = new Set<string>(["size", "ineffective", "preservation", "gpu", "failure"]);
export type Verdict = {
  kind: VerdictKind; reason: string; recipe: string | null; toolsDigest: string | null;
  tools: Record<string, string> | null; source: SourceIdentity | null; exit: number | null;
};
export const VERDICT_PREFIX = "[verdict] ";
/** The CLI's machine line for a refusal it just printed: kind, display reason, the recipe and the tools it ran with. */
export function verdictLine(kind: VerdictKind, reason: string, recipe: string | null): string {
  return VERDICT_PREFIX + JSON.stringify({ kind, reason, recipe, toolsDigest: currentToolsDigest(), tools: toolVersions() });
}
function asId(x: any): SourceIdentity | null {
  if (!x || !Number.isFinite(x.size) || !Number.isFinite(x.mtimeMs)) return null;
  return typeof x.sha === "string" && /^[0-9a-f]{64}$/.test(x.sha) ? { size: x.size, mtimeMs: x.mtimeMs, sha: x.sha } : { size: x.size, mtimeMs: x.mtimeMs };
}
function fromJson(j: any, exit: number | null = null): Verdict | null {
  if (!j || typeof j !== "object" || !VERDICT_KINDS.has(j.kind)) return null;
  return {
    kind: j.kind, reason: typeof j.reason === "string" && j.reason ? j.reason : "refused (no reason recorded)",
    recipe: typeof j.recipe === "string" ? j.recipe : null, toolsDigest: typeof j.toolsDigest === "string" ? j.toolsDigest : null,
    tools: j.tools && typeof j.tools === "object" ? j.tools : null, source: asId(j.source), exit: Number.isInteger(j.exit) ? j.exit : exit,
  };
}
/** A structured verdict in `content` — a JSON marker (v 1), or the LAST `[verdict]` line of a CLI's stderr — or null. */
function structuredVerdict(content: string): Verdict | null {
  const t = content.trimStart();
  if (t.startsWith("{")) { try { const j = JSON.parse(t); if (j?.v === 1) return fromJson(j); } catch { /* not a record */ } }
  const line = content.split("\n").reverse().find((l) => l.startsWith(VERDICT_PREFIX));
  if (line) { try { return fromJson(JSON.parse(line.slice(VERDICT_PREFIX.length))); } catch { /* malformed: the text reads it */ } }
  return null;
}
// ---- the legacy text grammar (markers written before the record; stand-in optimizers) — read HERE and nowhere else
function textKind(content: string): VerdictKind {
  if (/\bunsupported: (skinned\/avatar asset|morph targets|animated object)/i.test(content)) return "structural";
  if (/\balready light \(\d+ verts < \d+(; textures \d+% of the full tier)?\)/i.test(content)) return "light";
  // ", permissive too": the reducer tried the Permissive retry as well (optimize.ts reduce)
  // "; textures N% of the full tier": gen 3 names the texture share a texture-only LOD would have needed
  if (/\breduction ineffective \(\d+ -> \d+ verts(, permissive too)?(; textures \d+% of the full tier)?\)/i.test(content)) return "ineffective";
  if (/\bpreservation failed:/i.test(content)) return "preservation";
  if (/\bnot lighter on the GPU \(textures /i.test(content)) return "gpu";
  if (/not smaller/i.test(content)) return "size";
  if (/no convertible|nothing to/i.test(content)) return "nothing";
  if (/unsupported:/i.test(content)) return "unsupported";
  return "unknown";
}
// the CLI's line: "[optimize] <pass>: <verdict> (<ms>ms) — <tail>" — keep the verdict, drop the log dressing. The verdict
// is the LAST "[optimize]" line (the pump logs the same one): a warning printed before it (the no-sharp resize note, a
// gltf-transform logger line) must not become the card's reason
const textReason = (raw: string): string => {
  const ls = raw.split("\n").filter((l) => !l.startsWith("source=")), line = [...ls].reverse().find((l) => /^\[optimize\]/.test(l)) ?? ls[0] ?? "";
  return line.replace(/^\[optimize\]\s*(?:lod:\s*)?/, "").replace(/\s*\(\d+ms\).*$/, "").replace(/,\s*\d+ms\)/, ")").replace(/\s+—\s+.*$/, "")
    .replace(/\s*recipe=\S+/, "").replace(/\s*tools=\S+/, "").trim() || "refused (no reason recorded)";
};
/** THE reader of a verdict, whatever its vintage. Never null: unreadable content is kind `unknown` (not final, stands
 *  as the old rule did). */
export function readVerdict(content: string): Verdict {
  const v = structuredVerdict(content);
  if (v) return v;
  return {
    kind: textKind(content), reason: textReason(content),
    recipe: /(?:^|\s)recipe=(\S+)/.exec(content)?.[1] ?? null, toolsDigest: /(?:^|\s)tools=([0-9a-f]+)(?:\s|$)/.exec(content)?.[1] ?? null,
    tools: null, source: parseSourceToken(content), exit: null,
  };
}
/** The marker the pump writes for a pass that exited `exit` with stderr `err`: the CLI's own record when it printed one,
 *  else its text read by the legacy grammar (an older or stand-in optimizer); a non-2 exit is a `failure`, stamped with
 *  THIS process's tools (the CLI printed no verdict). `source`: what the pass read (freshOver), null for a store hash. */
export function verdictMarker(err: string, exit: number, source: SourceIdentity | null, now = new Date()): string {
  const v = readVerdict(err);
  const failure = exit !== 2;
  const kind: VerdictKind = failure ? "failure" : v.kind;
  const toolsDigest = failure ? currentToolsDigest() : v.toolsDigest;
  const tools = v.tools ?? (failure ? toolVersions() : null);
  const reason = failure ? (err.trim() ? v.reason : `exit ${exit}`) : v.reason;
  const stamp = [v.recipe ? recipeStamp(v.recipe) : "", toolsDigest ? toolsStamp(toolsDigest) : ""].filter(Boolean).join(" ");
  return JSON.stringify({ v: 1, kind, reason, stamp, recipe: v.recipe, toolsDigest, tools, source, exit,
    tail: err.slice(-2000), at: now.toISOString() });
}

/** A geometry-LOD serving artifact — ANY recipe generation's, not only the
 *  current one (old generations must stay unlisted and uncatalogued too). */
export function isLodVariant(name: string): boolean {
  return /\.lod\.[a-z0-9.-]+\.glb$/i.test(name);
}

/** Where the LOD shadow of an original lives: beside it, with the RECIPE IN THE NAME as in the URL, so a recipe change
 *  can never serve yesterday's reduction under today's address. */
export function lodVariantPath(original: string, recipe = LOD_RECIPE): string {
  return `${original}.lod.${recipe}.glb`;
}

/** Is this verdict a REFUSAL a different tool could overturn (size gate, ineffective or unpreservable reduce, GPU gate)?
 *  A content fact (a skinned body, under the floor, no raster images) is about the file, whatever reads it. */
export function toolDependent(content: string): boolean {
  return TOOL_KINDS.has(readVerdict(content).kind);
}
/** Does a `.failed` verdict still stand under the current recipe AND tools? Size verdicts need the current recipe,
 *  tool-dependent ones the current tools (re-asked once without renaming a variant URL, as is one from before the
 *  tools stamp); anything else stands. */
export function verdictStands(content: string, recipe = KTX2_RECIPE, tools = currentToolsDigest()): boolean {
  const v = readVerdict(content);
  if (v.kind === "size" && !hasStamp(content, recipe)) return false;
  if (TOOL_KINDS.has(v.kind) && v.toolsDigest !== tools) return false;
  return true;
}

/** Any KTX2 serving artifact: `<rel>.ktx2.glb` (models), `<rel>.ktx2.vrm` (bodies, §20c), `<img>.ktx2` (loose images,
 *  §20d). Reached only through the ORIGINAL's path + ?ktx2=<key>; never a listing entry. */
export function isKtx2Variant(name: string): boolean {
  return /\.ktx2(\.glb|\.vrm)?$/i.test(name);
}

/** Anything the opt tree holds that a client doesn't address by name: a KTX2 or LOD variant, or a `.failed`, `.tmp`,
 *  `.deferred` or `.srcid` marker. None is a listing entry: the prefetcher fetches every listed store path. */
export function isServingArtifact(name: string): boolean {
  return isKtx2Variant(name) || isLodVariant(name) || /\.(failed|tmp|deferred|srcid)$/i.test(name);
}

/** Is this store/ entry an upload, not a variant of one? Every store/*.glb enumeration (catalog, boot sweep) must use it. */
export function isStoreOriginal(name: string): boolean {
  return name.endsWith(".glb") && !isKtx2Variant(name) && !isLodVariant(name);
}

/** Where the KTX2 shadow of a store original lives: beside it, `<path>.ktx2.glb`
 *  — routes.ts's own resolution for a flagged fetch (`${rel}.ktx2.glb` under
 *  OPT_DIR), so serving needs no change to find it. */
export function ktx2VariantPath(original: string): string {
  return `${original}${KTX2_SUFFIX}`;
}

/** Which shadows a store original still lacks. A `.failed` marker counts as present (the pass answered), EXCEPT a KTX2
 *  size verdict from an older recipe (verdictStands). `exists`/`read` are injectable for tests. */
export function storeShadowsMissing(
  original: string,
  minDir: string,
  exists: (p: string) => boolean = existsSync,
  read: (p: string) => string = (p) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
): { min: boolean; ktx2: boolean; lod: boolean } {
  const min = join(minDir, basename(original));
  const k = ktx2VariantPath(original);
  const kFailed = `${k}.failed`;
  const l = lodVariantPath(original);
  const lFailed = `${l}.failed`;
  return {
    min: !exists(min) && !exists(`${min}.failed`),
    ktx2: !exists(k) && !(exists(kFailed) && verdictStands(read(kFailed))),
    lod: !exists(l) && !(exists(lFailed) && verdictStands(read(lFailed), LOD_RECIPE)),
  };
}

// ---- status, for people: nothing may silently fail getting LODs ----------------------------------
// storeShadowsMissing answers the SWEEP's question; this answers a person's: what each optimization looks like and why.
// built · not-needed (too light, nothing to convert) · unsupported (by contract) · refused (failed a gate) · stale (older
// recipe, or a changed source) · deferred (host couldn't afford it) · pending (not reached yet)
export type VariantState = "built" | "not-needed" | "unsupported" | "refused" | "stale" | "deferred" | "pending";
export type VariantStatus = { state: VariantState; reason: string | null };

/** Classify one variant from what is on disk beside it. `recipe` is the one its size verdicts are stamped with. */
// (a legacy marker's reason is read by readVerdict: the verdict is the LAST "[optimize]" line, minus the log dressing)

/** How classifyVariant reads one pass. `lod`: read through lodVerdictKind, the route's own reader, so card and
 *  x-eidoverse-lod header agree. `source`: the MUTABLE file judged (variantSource); not freshOver it = `stale`. Store
 *  originals pass none. `stat` is injectable for tests. */
export type ClassifyOpts = { lod?: boolean; source?: string | null; stat?: StatFn };

export function classifyVariant(path: string, exists: (p: string) => boolean, read: (p: string) => string, recipe?: string,
  opts: ClassifyOpts = {}): VariantStatus {
  const fresh = (p: string) => freshOver(p, opts.source ?? null, { read, stat: opts.stat });
  const failed = `${path}.failed`;
  const failedNow = exists(failed);
  if (exists(path)) {
    if (!fresh(path)) return { state: "stale", reason: "the model changed after this variant was built; the sweep rebuilds it" };
    // A CURRENT-recipe verdict beside a variant can only be a forced rebuild that was refused (the pump never runs over
    // one that stands, and ↻ clears it first): the old bytes still serve, and "built" would hide the refusal.
    // An older recipe's verdict beside a variant is just history — a later build succeeded.
    if (failedNow && recipe !== undefined) {
      const raw = read(failed);
      if (verdictStands(raw, recipe) && fresh(failed)) return { state: "refused", reason: `rebuild refused (${readVerdict(raw).reason}); the earlier variant still serves` };
    }
    return { state: "built", reason: null };
  }
  if (failedNow) {
    const raw = read(failed);
    const verdict = readVerdict(raw), reason = verdict.reason;
    if (recipe !== undefined && !verdictStands(raw, recipe)) return { state: "stale", reason };
    if (!fresh(failed)) return { state: "stale", reason: `the model changed after this verdict: ${reason}` };
    if (opts.lod) {
      switch (verdict.kind) {   // the LOD arm's grammar is the LOD kinds alone: a "nothing to" here is not a content verdict
        case "structural": return { state: "unsupported", reason: reason.replace(/^unsupported:\s*/i, "") };
        case "light": return { state: "not-needed", reason };
        default: return { state: "refused", reason };   // ineffective / preservation / gpu, and anything unclassified
      }
    }
    switch (verdict.kind) {
      case "nothing": return { state: "not-needed", reason };
      case "structural": case "unsupported": return { state: "unsupported", reason: reason.replace(/^unsupported:\s*/i, "") };
      default: return { state: "refused", reason };
    }
  }
  if (exists(`${path}.deferred`)) return { state: "deferred", reason: read(`${path}.deferred`).trim().slice(0, 200) || null };
  return { state: "pending", reason: null };
}

/** Every optimization's status for one store/library original. `source` is the mutable file the passes judge (the
 *  LIBRARY model — the one the sweep builds from and compares against); omit it for a content-addressed store upload. */
export function variantStatus(
  original: string,
  minDir: string,
  { exists = existsSync, read = (p: string) => { try { return readFileSync(p, "utf8"); } catch { return ""; } },
    simplifyOf = lodSimplifyOf, source = null, stat }: {
    exists?: (p: string) => boolean; read?: (p: string) => string; simplifyOf?: (p: string) => string | null;
    source?: string | null; stat?: StatFn;
  } = {},
): { min: VariantStatus; ktx2: VariantStatus; lod: VariantStatus } {
  const lodPath = lodVariantPath(original);
  let lod = classifyVariant(lodPath, exists, read, LOD_RECIPE, { lod: true, source, stat });
  // a Permissive LOD collapsed across UV/normal seams (optimize.ts): it serves, but it may read darker or faceted —
  // say so in the hover rather than let it pass as an ordinary build
  if (lod.state === "built" && simplifyOf(lodPath) === "permissive") lod = { state: "built", reason: "permissive: collapsed across UV seams" };
  return {
    min: classifyVariant(join(minDir, basename(original)), exists, read),
    ktx2: classifyVariant(ktx2VariantPath(original), exists, read, KTX2_RECIPE, { source, stat }),
    lod,
  };
}

const simplifyCache = new Map<string, { key: string; v: string | null }>();
/** asset.extras.simplify of a LOD variant, read from the GLB's JSON chunk only (the catalog asks per card); cached on
 *  (size, mtime). null = absent or unreadable. */
export function lodSimplifyOf(path: string): string | null {
  try {
    const st = statSync(path), key = `${st.size}:${st.mtimeMs}`, hit = simplifyCache.get(path);
    if (hit?.key === key) return hit.v;
    const fd = openSync(path, "r");
    try {
      const head = Buffer.alloc(20); readSync(fd, head, 0, 20, 0);
      let v: string | null = null;
      if (head.readUInt32LE(0) === 0x46546c67 && head.readUInt32LE(16) === 0x4e4f534a) {   // 'glTF', chunk 0 = 'JSON'
        const len = head.readUInt32LE(12), json = Buffer.alloc(len); readSync(fd, json, 0, len, 20);
        const x = JSON.parse(json.toString("utf8"))?.asset?.extras?.simplify; v = typeof x === "string" ? x : null;
      }
      simplifyCache.set(path, { key, v }); return v;
    } finally { closeSync(fd); }
  } catch { return null; }
}
