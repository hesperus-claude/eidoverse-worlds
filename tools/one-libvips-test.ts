// One libvips per optimize process (#122). `bun tools/one-libvips-test.ts`
// The root manifest declares `sharp: ^0.33.5`; @gltf-transform/functions reaches sharp via ndarray-pixels at
// `^0.35.0`. The ranges can't dedupe, so a bare `import("sharp")` in optimize.ts loads a SECOND native libvips; the
// two disagree about libvips' enums and the encode goes wrong:
//   win32     GLib-GObject-CRITICAL: value "32" ... 'VipsInterpretation'
//             Error: colourspace: parameter space not set   (it THROWS)
//   show box  no throw: the encode returns uninitialized memory, stamped `image/webp`, served as an image that isn't (#122)
// Case 1 (end to end) fails on unmodified main here; a machine that dedupes would pass it by luck, so case 2 asserts
// the STRUCTURE (the resolver reaches the nested copy whenever one exists). Case 3 censuses the native binaries this
// process actually mapped: "loads one libvips", not "avoids the bare specifier", is the fix.

import { existsSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Document, NodeIO } from "@gltf-transform/core";
import { optimizeGlb } from "../server/optimize.ts";

// getSharp doesn't exist on main: pulled dynamically so this file RUNS there and shows the failure, not dies at import
const OPT = await import("../server/optimize.ts") as {
  getSharp?: () => Promise<{ sharp: any; from: string }>;
};
const getSharp = OPT.getSharp
  ?? (async () => ({ sharp: (await import("sharp")).default, from: "sharp (bare specifier)" }));

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const MAGIC: [number[], string][] = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
];
/** Declared mimeType vs actual container magic: compared against what the image CLAIMS, never one hardcoded format. */
function sniff(b: Uint8Array): string {
  if (b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46
      && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50) return "image/webp";
  for (const [m, name] of MAGIC) if (m.every((v, i) => b[i] === v)) return name;
  return `UNKNOWN(${[...b.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join(" ")})`;
}

function imagesOf(glb: Uint8Array): { mime: string; bytes: Uint8Array }[] {
  const dv = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  let off = 12, json: any = null, bin: Uint8Array | null = null;
  while (off < glb.length) {
    const len = dv.getUint32(off, true), ty = dv.getUint32(off + 4, true);
    const chunk = glb.subarray(off + 8, off + 8 + len);
    if (ty === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(chunk));
    else if (ty === 0x004e4942) bin = chunk;
    off += 8 + len;
  }
  return (json.images ?? []).map((im: any) => {
    const v = json.bufferViews[im.bufferView];
    const start = v.byteOffset ?? 0;
    return { mime: im.mimeType, bytes: bin!.subarray(start, start + v.byteLength) };
  });
}

console.log("\none libvips per optimize process (#122):\n");

// ---------------------------------------------- 1. the encode, end to end
// a JPEG source: JPEG and webp go through the CONVERTING path, where the two libvips meet. Scaffolding resolves
// gltf-transform's own sharp directly, so a setup failure can't mask the checks.
const fixtureSharp = await (async () => {
  try {
    const fd = dirname(Bun.resolveSync("@gltf-transform/functions", join(import.meta.dir, "../server")));
    return (await import(Bun.resolveSync("sharp", dirname(Bun.resolveSync("ndarray-pixels", fd))))).default;
  } catch { return (await import("sharp")).default; }
})();
const { from } = await getSharp();
const sharp = fixtureSharp;
const tmp = mkdtempSync(join(tmpdir(), "ew-libvips-"));
try {
  // a 256² JPEG gradient: it must VARY, or prune() folds a solid texture into baseColorFactor and there's nothing to encode
  const W = 256, px = Buffer.alloc(W * W * 3);
  for (let y = 0; y < W; y++)
    for (let x = 0; x < W; x++) {
      const i = (y * W + x) * 3;
      px[i] = x; px[i + 1] = y; px[i + 2] = (x ^ y) & 0xff;
    }
  const jpeg = await sharp(px, { raw: { width: W, height: W, channels: 3 } }).jpeg().toBuffer();

  const doc = new Document();
  const buf = doc.createBuffer();  // GLB resources need one, images included
  const tex = doc.createTexture("probe").setImage(new Uint8Array(jpeg)).setMimeType("image/jpeg");
  const mat = doc.createMaterial("probeMat").setBaseColorTexture(tex);
  const prim = doc.createPrimitive().setMaterial(mat)
    .setAttribute("POSITION",
      doc.createAccessor().setType("VEC3").setBuffer(buf)
        .setArray(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0])))
    // TEXCOORD_0 is load-bearing: without UVs prune() reads the baseColor texture as unreferenced and drops it
    .setAttribute("TEXCOORD_0",
      doc.createAccessor().setType("VEC2").setBuffer(buf)
        .setArray(new Float32Array([0, 0, 1, 0, 0, 1])));
  const mesh = doc.createMesh("probeMesh").addPrimitive(prim);
  const node = doc.createNode("probeNode").setMesh(mesh);
  doc.createScene("probeScene").addChild(node);

  const io = new NodeIO();
  const src = await io.writeBinary(doc);

  let out: Uint8Array | null = null;
  let threw = "";
  try { out = await optimizeGlb(src); } catch (e) { threw = (e as Error).message; }
  check("optimizeGlb completes — two libvips make this throw on win32",
    out !== null, threw);

  if (out) {
    const imgs = imagesOf(out);
    check("the pass produced an image at all", imgs.length > 0, `${imgs.length} images`);
    for (const [i, im] of imgs.entries()) {
      const actual = sniff(im.bytes);
      check(`image ${i}: declared ${im.mime}, and actually is`, actual === im.mime,
        `actual ${actual}, ${im.bytes.length} bytes`);
      let decoded = "";
      try {
        const m = await sharp(Buffer.from(im.bytes)).metadata();
        decoded = `${m.width}x${m.height}`;
      } catch (e) { decoded = `FAILED: ${(e as Error).message}`; }
      check(`image ${i}: decodes for real, not just the right header`,
        /^\d+x\d+$/.test(decoded), decoded);
    }
  }
} finally {
  rmSync(tmp, { recursive: true, force: true });
}

// ------------------------------------------- 2. the structure, not the luck
// case 1 passes by luck on a machine with one copy; this pins it
const fnDir = dirname(Bun.resolveSync("@gltf-transform/functions", join(import.meta.dir, "../server")));
const npDir = dirname(Bun.resolveSync("ndarray-pixels", fnDir));
let nested: string | null = null;
try { nested = Bun.resolveSync("sharp", npDir); } catch { /* deduped install */ }

if (nested && existsSync(nested)) {
  check("the resolver reaches gltf-transform's OWN sharp, not the root copy",
    from === nested, `from=${from}`);
  check("...and that is a genuinely different copy (else this proves nothing)",
    !from.includes(join("node_modules", "sharp").replace(/\\/g, "/"))
      || from.includes("ndarray-pixels"), `from=${from}`);
} else {
  // not a failure: a deduped install is the state this fix is chasing
  console.log("  \x1b[36m—\x1b[0m single sharp install; the bare specifier is safe here");
  console.log(`     resolved: ${from}`);
}

// ------------------------------------------- 3. the process, not the resolver
// count what the process LOADED: report.sharedObjects lists mapped native binaries; two install roots with a sharp
// binding means two libvips. Measured after case 1's real optimizeGlb run.
const report = (process as any).report?.getReport?.();
if (!report || !Array.isArray(report.sharedObjects)) {
  console.log("  [36m—[0m process.report unavailable on this runtime; skipping the load census");
} else {
  const installs = [...new Set((report.sharedObjects as string[])
    .filter((s) => /sharp/i.test(s) && s.endsWith(".node"))
    .map((s) => dirname(s)))];
  check("exactly one sharp install is loaded in this process",
    installs.length === 1,
    installs.length === 0
      ? "none loaded — the texture pass never ran, so this proves nothing"
      : `${installs.length} loaded:${installs.map((i) => `
     ${i}`).join("")}`);
}


// ----------------------------------------- 4. the fail-closed seam (#136)
// a nested copy that resolves but fails to IMPORT must not fall back to bare "sharp" (two libvips again). Through
// pickSharp's injected effects; the load hook records every specifier, and "sharp" must never appear.
if (typeof (OPT as any).pickSharp !== "function") {
  check("pickSharp is exported (resolution split from import)", false, "absent — pre-#136 optimize.ts");
} else {
  const pickSharp = (OPT as any).pickSharp as (
    r: () => string | null, l: (s: string) => Promise<any>,
  ) => Promise<{ sharp: any; from: string }>;
  const NESTED = "/probe/ndarray-pixels/node_modules/sharp/index.js";

  const attempted: string[] = [];
  let rejection = "";
  try {
    await pickSharp(() => NESTED, async (spec) => {
      attempted.push(spec);
      throw new Error(`native import failed: ${spec}`);
    });
  } catch (e) { rejection = (e as Error).message; }

  check("a nested copy that fails to import REJECTS instead of falling back",
    /native import failed/.test(rejection),
    rejection || "returned a module instead of rejecting");
  check("...and the bare specifier is never even attempted",
    !attempted.includes("sharp"),
    `load() was handed: ${attempted.join(", ") || "(nothing)"}`);
  check("...having attempted exactly the nested path, once",
    attempted.length === 1 && attempted[0] === NESTED,
    `load() was handed: ${attempted.join(", ") || "(nothing)"}`);

  // with NO nested copy, the bare specifier is the single install and must still be used, or a deduped machine loses its texture pass
  const bare: string[] = [];
  const picked = await pickSharp(() => null, async (spec) => { bare.push(spec); return { default: {} }; });
  check("a genuinely absent nested copy DOES fall back to the bare specifier",
    bare.length === 1 && bare[0] === "sharp" && picked.from === "sharp (bare specifier)",
    `load() was handed: ${bare.join(", ")}, from=${picked.from}`);
}


console.log(`\n${failures === 0 ? "\x1b[32m" : "\x1b[31m"}${failures} failed\x1b[0m\n`);
process.exit(failures ? 1 : 0);
