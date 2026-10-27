// The store's serving shadows, named in one place. A store upload (assets/opt/store/<hash>.glb, immutable) gets two
// from upload.ts's pump, both served by routes.ts on the ORIGINAL's address:
//   store-min/<hash>.glb        draco + webp@1024, the unflagged answer
//   store/<hash>.glb.ktx2.glb   draco + KTX2, the ?ktx2=<key> answer (beside the original, as library variants are)
// The KTX2 variant ends in .glb too: enumerate with isStoreOriginal, skip isKtx2Variant, or variants list and download
// twice (§20c). A flagged fetch falling through to webp is served no-cache, never immutable: the address is immutable,
// not the flagged answer. Side-effect-free (tools/store-variants-test.ts).

import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { join, basename } from "node:path";
import { createHash } from "node:crypto";
import { currentToolsDigest, toolVersions, toolsStamp } from "./tools-stamp.ts";
import { R_BASE, DIAG_K, LOD_FRACTION, LOD_HYST } from "../shared/lod-distance.js";

/** `<hash>.glb` + this = the KTX2 shadow's file name. */
export const KTX2_SUFFIX = ".ktx2.glb";

// ---- the texel budget ------------------------------------------------------
// the webp shadow's 1024² budget: downscale only, 4-aligned, by toktx --resize, never libvips
export const KTX2_TEXEL_CAP = 1024;

/** null when it already fits. Aspect kept; both sides a multiple of 4. */
export function capTexels(size: [number, number] | null | undefined, cap = KTX2_TEXEL_CAP): [number, number] | null {
  if (!size || !(size[0] > 0) || !(size[1] > 0)) return null;
  const [w, h] = size;
  if (w <= cap && h <= cap) return null;
  const k = cap / Math.max(w, h);
  const r = (v: number) => Math.max(4, Math.round((v * k) / 4) * 4);
  return [r(w), r(h)];
}

// a size verdict is only as durable as its RECIPE: one without the CURRENT stamp is re-measured once; content
// verdicts carry no stamp and stand
export const KTX2_RECIPE = "texel1024";
export const recipeStamp = (recipe = KTX2_RECIPE) => `recipe=${recipe}`;
/** Delimited, never a prefix: `recipe=…-min12000` must not answer for `…-min120000`. */
export const hasStamp = (content: string, recipe: string) => {
  const v = structuredVerdict(content);
  if (v) return v.recipe === recipe;
  return new RegExp(`(^|\\s)${recipeStamp(recipe).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(\\s|$)`).test(content);
};

// ---- the geometry LOD (placeable objects only) ---------
// `<rel>.lod.<recipe>.glb` beside the original. Bodies fail closed by structure (skins, VRM metadata, morphs); names,
// materials and bounds are asserted unchanged after the reduce.
// LOD_GEN: bump when weld/simplify, the gates, the tool or lodTexelCaps change: 'light' verdicts are final, and
// nothing else in the URL re-asks them.
export const LOD_GEN = 3;
export const LOD_RATIO = 0.25;      // the floor it may reach, not a quota
// screen-space budget at the closest 'auto' distance (lod-distance.js lodNearest), headset density; textures over the
// least densely mapped part. 'eco' and pressure show it at half that distance (lod_policy.js PRESSURE_EDGE). Measured on #207.
export const LOD_PX = 2;
export const LOD_PPD = 25;          // px/degree: a Quest 3's centre, stricter than a desktop 55° view
export const LOD_TEXELS_PER_PX = 1;
// texture-only LOD when vertices can't come under 0.6×: textures at most this share of the full tier's GPU memory
export const LOD_TEX_ONLY = 0.5;
// under this many vertices only textures reduce
export const LOD_MIN_VERTS = 12_000;

/** DERIVES from every parameter a variant or verdict depends on, and names the URL and every file: any change is a
 *  new generation by construction. */
export function lodRecipeFor({ gen = LOD_GEN, ratio = LOD_RATIO, px = LOD_PX, ppd = LOD_PPD, tpp = LOD_TEXELS_PER_PX,
  texOnly = LOD_TEX_ONLY, texel = KTX2_TEXEL_CAP, minVerts = LOD_MIN_VERTS,
  // the budget's DISTANCE (lod-distance.js) is a parameter too: tuning it re-budgets, so re-names, every LOD
  rBase = R_BASE, diagK = DIAG_K, fraction = LOD_FRACTION, hyst = LOD_HYST } = {}): string {
  // every decimal digit (0.25 → 25, 0.014 → 014): two settings the reducer tells apart must never share a string
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
// structural and light (content + recipe only) are final and cacheable; ineffective, preservation, gpu and anything
// unclassified stay provisional until LOD_GEN bumps
export type LodVerdictKind = "structural" | "light" | "ineffective" | "preservation" | "gpu";
const LOD_KINDS = new Set<string>(["structural", "light", "ineffective", "preservation", "gpu"]);
/** Through readVerdict, the ONE reader the route and classifyVariant share, so wire and card cannot disagree. */
export function lodVerdictKind(content: string): LodVerdictKind | null {
  const k = readVerdict(content).kind;
  return LOD_KINDS.has(k) ? k as LodVerdictKind : null;
}
/** A content-only class stamped with the running recipe (the filename binds it too; the stamp is the belt). */
export function lodVerdictFinal(content: string, recipe = LOD_RECIPE): boolean {
  const kind = lodVerdictKind(content);
  return (kind === "structural" || kind === "light") && hasStamp(content, recipe);
}

// ---- source identity: freshness by EQUALITY, never by mtime order ------------------------------------------------------
// fresh iff the source identity recorded when the pass STARTED equals the source's now (cp -p and rsync -a restore
// mtimes). No sha: the stat pair; no identity: strictly newer; `source` null (content-addressed): fresh.
export type SourceIdentity = { size: number; mtimeMs: number; sha?: string };
export type StatFn = (p: string) => SourceIdentity | null;
const digestCache = new Map<string, { key: string; sha: string }>();
/** A harness checks a cache hit reads nothing. */
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
/** A verdict marker carries its own, inline. */
export const sourceSidecar = (variant: string) => `${variant}.srcid`;
export const sameIdentity = (a: SourceIdentity | null, b: SourceIdentity | null) => !!a && !!b && a.size === b.size && a.mtimeMs === b.mtimeMs
  && (a.sha == null || b.sha == null || a.sha === b.sha);
/** Its own line, so no reader of the verdict line ever sees it. */
export const sourceToken = (id: SourceIdentity) => `source=${id.size}:${id.mtimeMs}`;
export function parseSourceToken(content: string): SourceIdentity | null {
  const m = /(?:^|\s)source=(\d+):(\d+(?:\.\d+)?)(?:\s|$)/.exec(content);
  return m ? { size: Number(m[1]), mtimeMs: Number(m[2]) } : null;
}
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
  if (!cur) return false;                     // the source is gone
  const rec = recordedSource(derived, read);
  if (rec) return sameIdentity(rec, cur);
  const d = stat(derived);                    // legacy: no identity, strictly newer
  return !!d && d.mtimeMs > cur.mtimeMs;
}
/** null = content-addressed (store/); a GLB the LIBRARY file (never OPT or PATCH); a VRM the overlay, else library. */
export function variantSource(rel: string, dirs: { opt: string; library: string }): string | null {
  if (rel.startsWith("store/")) return null;
  const inside = (base: string) => { const p = join(base, rel); return p.startsWith(base) ? p : null; };
  if (rel.endsWith(".vrm")) {
    const o = inside(dirs.opt);
    if (o && existsSync(o)) return o;
  }
  return inside(dirs.library) ?? "";   // outside the tree: nothing is fresh over it
}

// ---- the verdict RECORD: structured markers, one reader ---------------------------------------------------------
// kind is a closed enum, prose display only (RFC 9457 §3.1.4); readVerdict is the ONE parser (JSON, `[verdict]`,
// legacy text). `failure` (any exit but 2) is never final and re-asked on a tool change.
export type VerdictKind = LodVerdictKind | "size" | "nothing" | "unsupported" | "unsuitable" | "failure" | "unknown";
const VERDICT_KINDS = new Set<string>(["structural", "light", "ineffective", "preservation", "gpu", "size", "nothing", "unsupported", "unsuitable", "failure", "unknown"]);
/** A content fact (skinned body, under the floor, no rasters, non-POT) is not one: it is about the file. */
const TOOL_KINDS = new Set<string>(["size", "ineffective", "preservation", "gpu", "failure"]);
export type Verdict = {
  kind: VerdictKind; reason: string; recipe: string | null; toolsDigest: string | null;
  tools: Record<string, string> | null; source: SourceIdentity | null; exit: number | null;
};
export const VERDICT_PREFIX = "[verdict] ";
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
/** A JSON marker (v 1), or the LAST `[verdict]` line of a CLI's stderr. */
function structuredVerdict(content: string): Verdict | null {
  const t = content.trimStart();
  if (t.startsWith("{")) { try { const j = JSON.parse(t); if (j?.v === 1) return fromJson(j); } catch { /* not a record */ } }
  const line = content.split("\n").reverse().find((l) => l.startsWith(VERDICT_PREFIX));
  if (line) { try { return fromJson(JSON.parse(line.slice(VERDICT_PREFIX.length))); } catch { /* malformed: the text reads it */ } }
  return null;
}
// ---- the legacy text grammar (old markers, stand-in optimizers): read HERE and nowhere else
function textKind(content: string): VerdictKind {
  if (/\bunsupported: (skinned\/avatar asset|morph targets|animated object)/i.test(content)) return "structural";
  if (/\balready light \(\d+ verts < \d+(; textures \d+% of the full tier)?\)/i.test(content)) return "light";
  // ", permissive too": the Permissive retry ran as well; "; textures N%": the share a texture-only LOD would need
  if (/\breduction ineffective \(\d+ -> \d+ verts(, permissive too)?(; textures \d+% of the full tier)?\)/i.test(content)) return "ineffective";
  if (/\bpreservation failed:/i.test(content)) return "preservation";
  if (/\bnot lighter on the GPU \(textures /i.test(content)) return "gpu";
  if (/not smaller/i.test(content)) return "size";
  if (/no convertible|nothing to/i.test(content)) return "nothing";
  if (/unsupported:/i.test(content)) return "unsupported";
  return "unknown";
}
// "[optimize] <pass>: <verdict> (<ms>ms) — <tail>": the LAST such line, so an earlier warning never becomes the reason
const textReason = (raw: string): string => {
  const ls = raw.split("\n").filter((l) => !l.startsWith("source=")), line = [...ls].reverse().find((l) => /^\[optimize\]/.test(l)) ?? ls[0] ?? "";
  return line.replace(/^\[optimize\]\s*(?:lod:\s*)?/, "").replace(/\s*\(\d+ms\).*$/, "").replace(/,\s*\d+ms\)/, ")").replace(/\s+—\s+.*$/, "")
    .replace(/\s*recipe=\S+/, "").replace(/\s*tools=\S+/, "").trim() || "refused (no reason recorded)";
};
/** Any vintage. Never null: unreadable is kind `unknown` (not final). */
export function readVerdict(content: string): Verdict {
  const v = structuredVerdict(content);
  if (v) return v;
  return {
    kind: textKind(content), reason: textReason(content),
    recipe: /(?:^|\s)recipe=(\S+)/.exec(content)?.[1] ?? null, toolsDigest: /(?:^|\s)tools=([0-9a-f]+)(?:\s|$)/.exec(content)?.[1] ?? null,
    tools: null, source: parseSourceToken(content), exit: null,
  };
}
/** A non-2 exit is a `failure`, stamped with THIS process's tools. `source`: what the pass read, null for a store hash. */
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

/** ANY recipe generation's: old ones must stay unlisted and uncatalogued too. */
export function isLodVariant(name: string): boolean {
  return /\.lod\.[a-z0-9.-]+\.glb$/i.test(name);
}

/** RECIPE IN THE NAME, so a recipe change never serves yesterday's reduction under today's address. */
export function lodVariantPath(original: string, recipe = LOD_RECIPE): string {
  return `${original}.lod.${recipe}.glb`;
}

/** A content fact is about the file, whatever reads it: never one. */
export function toolDependent(content: string): boolean {
  return TOOL_KINDS.has(readVerdict(content).kind);
}
/** Size verdicts need the current recipe, tool-dependent ones the current tools (re-asked once, URL unrenamed);
 *  anything else stands. */
export function verdictStands(content: string, recipe = KTX2_RECIPE, tools = currentToolsDigest()): boolean {
  const v = readVerdict(content);
  if (v.kind === "size" && !hasStamp(content, recipe)) return false;
  if (TOOL_KINDS.has(v.kind) && v.toolsDigest !== tools) return false;
  return true;
}

/** `.ktx2.glb`, `.ktx2.vrm` (§20c), `<img>.ktx2` (§20d). Reached only via the ORIGINAL's path + ?ktx2=<key>; never listed. */
export function isKtx2Variant(name: string): boolean {
  return /\.ktx2(\.glb|\.vrm)?$/i.test(name);
}

/** Variants and markers: never a listing entry, since the prefetcher fetches every listed store path. */
export function isServingArtifact(name: string): boolean {
  return isKtx2Variant(name) || isLodVariant(name) || /\.(failed|tmp|deferred|srcid)$/i.test(name);
}

/** Every store/*.glb enumeration must use it. */
export function isStoreOriginal(name: string): boolean {
  return name.endsWith(".glb") && !isKtx2Variant(name) && !isLodVariant(name);
}

/** routes.ts's own resolution for a flagged fetch. */
export function ktx2VariantPath(original: string): string {
  return `${original}${KTX2_SUFFIX}`;
}

/** A `.failed` marker counts as present, EXCEPT an older recipe's KTX2 size verdict. */
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
// a person's question (the sweep's is storeShadowsMissing): built · not-needed · unsupported (by contract) · refused ·
// stale (older recipe or changed source) · deferred (host couldn't afford it) · pending
export type VariantState = "built" | "not-needed" | "unsupported" | "refused" | "stale" | "deferred" | "pending";
export type VariantStatus = { state: VariantState; reason: string | null };

/** `lod`: via lodVerdictKind, so card and x-eidoverse-lod header agree. `source`: the MUTABLE file judged; not
 *  freshOver it = `stale`. */
export type ClassifyOpts = { lod?: boolean; source?: string | null; stat?: StatFn };

/** One variant, from what is on disk beside it. `recipe`: the one its size verdicts are stamped with. */
export function classifyVariant(path: string, exists: (p: string) => boolean, read: (p: string) => string, recipe?: string,
  opts: ClassifyOpts = {}): VariantStatus {
  const fresh = (p: string) => freshOver(p, opts.source ?? null, { read, stat: opts.stat });
  const failed = `${path}.failed`;
  const failedNow = exists(failed);
  if (exists(path)) {
    if (!fresh(path)) return { state: "stale", reason: "the model changed after this variant was built; the sweep rebuilds it" };
    // a CURRENT-recipe verdict beside a variant is a refused forced rebuild: "built" would hide it. An older one is history.
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
      switch (verdict.kind) {   // LOD kinds alone: a "nothing to" here is not a content verdict
        case "structural": return { state: "unsupported", reason: reason.replace(/^unsupported:\s*/i, "") };
        case "light": return { state: "not-needed", reason };
        default: return { state: "refused", reason };
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

/** `source`: the mutable LIBRARY file the passes judge; omitted for a content-addressed upload. */
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
  // a Permissive LOD may read darker or faceted: say so in the hover, not as an ordinary build
  if (lod.state === "built" && simplifyOf(lodPath) === "permissive") lod = { state: "built", reason: "permissive: collapsed across UV seams" };
  return {
    min: classifyVariant(join(minDir, basename(original)), exists, read),
    ktx2: classifyVariant(ktx2VariantPath(original), exists, read, KTX2_RECIPE, { source, stat }),
    lod,
  };
}

const simplifyCache = new Map<string, { key: string; v: string | null }>();
/** JSON chunk only (the catalog asks per card); cached. null = absent or unreadable. */
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
