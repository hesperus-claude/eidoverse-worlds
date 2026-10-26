// WHICH tools a verdict was measured with, so an upgrade re-asks the verdicts it could change. Rides the verdict
// STAMP, never the recipe (it would rename every variant); only refusals are re-asked (store-variants.ts verdictStands).
// The KTX encoder is identified by stat of its real file, never by running it (a test's fake encoder counts calls).
// No heavy imports: the route reads this on the sequencer thread.

import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { createHash } from "node:crypto";

/** Encoder probe: KTX2_TOKTX env (absolute path) → toktx on PATH → ktx on PATH. Absent is an ENVIRONMENT, not a
 *  failure: the CLI exits 3 so the caller env-skips without a .failed marker. */
export function findKtx2Encoder(): string | null {
  const env = process.env.KTX2_TOKTX;
  if (env && existsSync(env)) return env;
  const which = Bun.which("toktx") ?? Bun.which("ktx");
  if (which) return which;
  // docs/ktx2-encoder.md's install: a PATH-less install must not silently exit-3 the sweep
  const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
  for (const p of [`${home}/.local/ktx/bin/toktx`, `${home}/.local/ktx/bin/ktx`])
    if (home && existsSync(p)) return p;
  return null;
}

/** null when there is no nested copy. RESOLUTION ONLY: only absence (not import failure) makes a bare import safe. */
export function resolveNestedSharp(): string | null {
  try {
    const fnDir = dirname(Bun.resolveSync("@gltf-transform/functions", import.meta.dir));
    const npDir = dirname(Bun.resolveSync("ndarray-pixels", fnDir));
    return Bun.resolveSync("sharp", npDir);
  } catch {
    return null;
  }
}

/** "absent" when unresolvable. */
function versionAbove(file: string | null, name: string): string {
  if (!file) return "absent";
  for (let d = dirname(file), i = 0; i < 8; d = dirname(d), i++) {
    const pj = join(d, "package.json");
    try { const j = JSON.parse(readFileSync(pj, "utf8")); if (j?.name === name && typeof j.version === "string") return j.version; } catch { /* keep climbing */ }
    if (dirname(d) === d) break;
  }
  return "absent";
}
const resolved = (spec: string): string | null => { try { return Bun.resolveSync(spec, import.meta.dir); } catch { return null; } };

export type ToolVersions = Record<string, string>;
/** `encoder` is injectable (a harness names its stand-in). */
export function toolVersions(encoder: string | null = findKtx2Encoder()): ToolVersions {
  let enc = "none";
  if (encoder) {
    try { const real = realpathSync(encoder), st = statSync(real); enc = `${basename(encoder)}:${st.size}:${st.mtimeMs}`; }
    catch { enc = `${basename(encoder)}:unreadable`; }
  }
  const nested = resolveNestedSharp();
  return {
    "gltf-transform/core": versionAbove(resolved("@gltf-transform/core"), "@gltf-transform/core"),
    "gltf-transform/functions": versionAbove(resolved("@gltf-transform/functions"), "@gltf-transform/functions"),
    "gltf-transform/extensions": versionAbove(resolved("@gltf-transform/extensions"), "@gltf-transform/extensions"),
    meshoptimizer: versionAbove(resolved("meshoptimizer"), "meshoptimizer"),
    draco3dgltf: versionAbove(resolved("draco3dgltf"), "draco3dgltf"),
    sharp: versionAbove(nested ?? resolved("sharp"), "sharp"),
    encoder: enc,
  };
}
/** Key-sorted, so the digest is canonical. */
export function toolsDigest(v: ToolVersions = toolVersions()): string {
  const canon = JSON.stringify(Object.keys(v).sort().map((k) => [k, v[k]]));
  return createHash("sha256").update(canon).digest("hex").slice(0, 12);
}
let memo: { at: number; d: string } | null = null;
/** Re-read at most once a minute, so a new encoder is noticed live. */
export function currentToolsDigest(): string {
  if (!memo || Date.now() - memo.at > 60_000) memo = { at: Date.now(), d: toolsDigest() };
  return memo.d;
}
export const toolsStamp = (digest = currentToolsDigest()) => `tools=${digest}`;
/** Delimited, like hasStamp. */
export const hasToolsStamp = (content: string, digest = currentToolsDigest()) =>
  new RegExp(`(^|\\s)tools=${digest}(\\s|$)`).test(content);
