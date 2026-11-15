/**
 * A store/ blob's original bytes are found wherever /library would serve them from, minus the patch rung (a patch is
 * not the original): the upload overlay first, then the asset library, which carries a store/ of its own. Before,
 * originalOf() looked only in the overlay, so a translated world kept library store/ models as plain paths
 * ("no bytes on this host") although the server served them.
 *
 * Run: bun tools/eidoindex-store-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const root = mkdtempSync(join(tmpdir(), "eidoindex-store-"));
const lib = join(root, "library"), opt = join(root, "opt"), patch = join(root, "patched");
for (const d of [lib, opt, patch]) mkdirSync(join(d, "store"), { recursive: true });
process.env.EIDOVERSE_DIR = lib; process.env.OPT_DIR = opt; process.env.PATCH_DIR = patch;

const blob = (bytes: string) => { const hex = createHash("sha256").update(bytes).digest("hex"); return { bytes, hex, rel: `store/${hex.slice(0, 16)}.glb` }; };
const inLib = blob("glTF library-store bytes"), inOpt = blob("glTF overlay-store bytes"), both = blob("glTF in both");
writeFileSync(join(lib, inLib.rel), inLib.bytes);
writeFileSync(join(opt, inOpt.rel), inOpt.bytes);
writeFileSync(join(opt, both.rel), both.bytes); writeFileSync(join(lib, both.rel), "glTF a different copy");
const onlyPatched = blob("glTF patched only"); writeFileSync(join(patch, onlyPatched.rel), onlyPatched.bytes);

const { originalOf, contentAddressOf, storeNameMatches } = await import("../server/eidoindex.ts");
const { PATCH_DIR } = await import("../server/config.ts");
check("the test's patch rung is the one the server uses", PATCH_DIR === patch, `PATCH_DIR=${PATCH_DIR}`);

console.log("\n━━ store/ originals, wherever /library serves them ━━");
check("a store/ blob only the asset library carries is found", originalOf(inLib.rel) === join(lib, inLib.rel), String(originalOf(inLib.rel)));
check("…and content-addresses to its own bytes", contentAddressOf(inLib.rel) === inLib.hex);
check("…and its name matches its bytes", storeNameMatches(inLib.rel));
check("an overlay store/ blob is still found", originalOf(inOpt.rel) === join(opt, inOpt.rel));
check("the overlay outranks the library, as on /library", originalOf(both.rel) === join(opt, both.rel), String(originalOf(both.rel)));
check("a patched copy is never taken for an original", originalOf(onlyPatched.rel) === null, String(originalOf(onlyPatched.rel)));
check("a missing blob is still null", originalOf("store/0000000000000000.glb") === null);

console.log("");
process.exit(failures ? 1 : 0);
