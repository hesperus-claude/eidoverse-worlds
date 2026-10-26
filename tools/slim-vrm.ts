// slim-vrm: resize a VRM/GLB's embedded textures to web-sane dimensions (2048², the VRM norm) with sharp. Container
// surgery only: images swapped in the BIN chunk, bufferViews repacked; meshes, skins, extensions untouched.
// Usage: bun tools/slim-vrm.ts file.vrm [--max 2048] [--quality 82] [--out path]   (default: rewrites in place)

import { basename } from "node:path";

const argv = Bun.argv.slice(2);
const input = argv.find((a) => !a.startsWith("--"));
if (!input) { console.error("usage: bun tools/slim-vrm.ts file.vrm [--max 2048] [--quality 82] [--out path]"); process.exit(1); }
const flag = (n: string) => { const i = argv.indexOf(`--${n}`); return i >= 0 ? argv[i + 1] : undefined; };
const MAX = Number(flag("max") ?? 2048);
const QUALITY = Number(flag("quality") ?? 82);
const out = flag("out") ?? input;

const src = new Uint8Array(await Bun.file(input).arrayBuffer());
const dv = new DataView(src.buffer);
if (dv.getUint32(0, true) !== 0x46546c67) throw new Error("not a GLB/VRM");
let off = 12, json: any = null, bin: Uint8Array | null = null;
while (off < src.length) {
  const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
  const data = src.subarray(off + 8, off + 8 + len);
  if (type === 0x4e4f534a) json = JSON.parse(new TextDecoder().decode(data));
  else if (type === 0x004e4942) bin = data;
  off += 8 + len;
}
if (!bin) throw new Error("no BIN chunk");

// JPEG out regardless of source: MToon transparency lives in material properties, not the base colour image
const sharp = (await import("sharp")).default;
const replaced = new Map<number, Uint8Array>();
for (const [i, img] of (json.images ?? []).entries()) {
  const bv = json.bufferViews[img.bufferView];
  const bytes = bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  const meta = await sharp(bytes).metadata();
  const w = meta.width ?? 0, h = meta.height ?? 0;
  // a 2048² PNG can be 5-10MB where the JPEG is under 1MB: skip only when BOTH within MAX and already JPEG
  if (Math.max(w, h) <= MAX && meta.format === "jpeg") {
    console.log(`  image ${i}: ${w}×${h} jpeg already ≤ ${MAX}, kept`);
    continue;
  }
  const slim = new Uint8Array(await sharp(bytes)
    .resize(MAX, MAX, { fit: "inside", withoutEnlargement: true })
    .jpeg({ quality: QUALITY })
    .toBuffer());
  if (slim.length >= bytes.length) { console.log(`  image ${i}: ${w}×${h} ${meta.format} re-encode not smaller, kept`); continue; }
  replaced.set(img.bufferView, slim);
  img.mimeType = "image/jpeg";
  console.log(`  image ${i}: ${w}×${h} ${meta.format} ${(bytes.length / 1e6).toFixed(1)}MB → jpeg ${(slim.length / 1e6).toFixed(1)}MB`);
}
if (replaced.size === 0) {
  console.log("nothing to slim");
  // honor --out even as a no-op: callers treat "exit 0 but no output file" as failure
  if (out !== input) await Bun.write(out, src);
  process.exit(0);
}

// repack: every bufferView copied (or substituted) into a fresh BIN, 4-aligned
const parts: Uint8Array[] = [];
let cursor = 0;
for (const [i, bv] of (json.bufferViews as any[]).entries()) {
  const bytes = replaced.get(i) ?? bin.subarray(bv.byteOffset ?? 0, (bv.byteOffset ?? 0) + bv.byteLength);
  bv.byteOffset = cursor;
  bv.byteLength = bytes.length;
  parts.push(bytes);
  cursor += bytes.length;
  const pad = (4 - (cursor % 4)) % 4;
  if (pad) { parts.push(new Uint8Array(pad)); cursor += pad; }
}
const newBin = new Uint8Array(cursor);
{ let o = 0; for (const p of parts) { newBin.set(p, o); o += p.length; } }
json.buffers[0].byteLength = newBin.length;

const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
const jsonPad = (4 - (jsonBytes.length % 4)) % 4;
const total = 12 + 8 + jsonBytes.length + jsonPad + 8 + newBin.length;
const outBuf = new Uint8Array(total);
const odv = new DataView(outBuf.buffer);
odv.setUint32(0, 0x46546c67, true); odv.setUint32(4, 2, true); odv.setUint32(8, total, true);
odv.setUint32(12, jsonBytes.length + jsonPad, true); odv.setUint32(16, 0x4e4f534a, true);
outBuf.set(jsonBytes, 20); outBuf.fill(0x20, 20 + jsonBytes.length, 20 + jsonBytes.length + jsonPad);
const binAt = 20 + jsonBytes.length + jsonPad;
odv.setUint32(binAt, newBin.length, true); odv.setUint32(binAt + 4, 0x004e4942, true);
outBuf.set(newBin, binAt + 8);
await Bun.write(out, outBuf);
console.log(`${basename(input)}: ${(src.length / 1e6).toFixed(1)}MB → ${(total / 1e6).toFixed(1)}MB`);
