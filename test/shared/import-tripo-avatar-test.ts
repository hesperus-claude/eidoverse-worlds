// import-tripo-avatar's spring stage on a synthetic Tripo rig (a node tree + a one-triangle skinned mesh), run headless.
//
//   bun test/shared/import-tripo-avatar-test.ts
//
// Wings get springbones so observers see a fallen body's wings move; they once rode inside the hair branch, so a
// hairless winged rig shipped frozen wings (G2-091).

import { join } from "node:path";
import { tmpdir } from "node:os";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { Document, NodeIO } from "@gltf-transform/core";
import { suite } from "../gate/suite.ts";

const { check, done } = suite("import-tripo-avatar");
const TOOL = join(import.meta.dir, "..", "..", "tools", "assets", "import-tripo-avatar.ts");
const dir = mkdtempSync(join(tmpdir(), "tripo-import-"));

// every bone the tool's MAP needs, at a plausible standing height (head 1.6, feet 0.1)
const bones: [string, number[]][] = [
  ["Hip", [0, 1, 0]], ["Waist", [0, 1.1, 0]], ["Spine01", [0, 1.2, 0]], ["Spine02", [0, 1.3, 0]],
  ["NeckTwist01", [0, 1.5, 0]], ["Head", [0, 1.6, 0]],
];
for (const [s, x] of [["L", 1], ["R", -1]] as const) {
  bones.push([`${s}_Eye`, [0.03 * x, 1.65, 0.05]], [`${s}_Clavicle`, [0.05 * x, 1.45, 0]], [`${s}_Upperarm`, [0.15 * x, 1.45, 0]],
    [`${s}_Forearm`, [0.4 * x, 1.45, 0]], [`${s}_Hand`, [0.6 * x, 1.45, 0]],
    [`${s}_Thigh`, [0.1 * x, 0.95, 0]], [`${s}_Calf`, [0.1 * x, 0.5, 0]], [`${s}_Foot`, [0.1 * x, 0.1, 0]], [`${s}_ToeBase`, [0.1 * x, 0.02, 0.12]]);
  for (let i = 0; i < 3; i++) bones.push([`${s}_Thumb${i}`, [(0.62 + 0.02 * i) * x, 1.43, 0.03]]);
  for (const f of ["Index", "Middle", "Ring", "Pinky"]) for (let i = 1; i <= 3; i++) bones.push([`${s}_${f}${i}`, [(0.65 + 0.03 * i) * x, 1.45, 0]]);
}
const WINGS: [string, number[]][] = [["L_Wing_Upper", [0.1, 1.4, -0.1]], ["L_Wing_Upper_1", [0.4, 1.5, -0.15]], ["L_Wing_Upper_2", [0.7, 1.6, -0.2]]];

async function rig(path: string, opts: { hair: boolean; wings: boolean }) {
  const doc = new Document();
  doc.createBuffer();
  const all = [...bones, ...(opts.wings ? WINGS : []),
    ...(opts.hair ? [["Hair_0_0", [0, 1.7, -0.05]], ["Hair_0_1", [0, 1.6, -0.1]]] as [string, number[]][] : [])];
  const root = doc.createNode("Armature");
  const joints = all.map(([name, t]) => { const n = doc.createNode(name).setTranslation(t as [number, number, number]); root.addChild(n); return n; });
  const skin = doc.createSkin("skin");
  for (const j of joints) skin.addJoint(j);
  const ibm = new Float32Array(16 * joints.length);
  for (let i = 0; i < joints.length; i++) for (const e of [0, 5, 10, 15]) ibm[16 * i + e] = 1;   // identity: the rest pose is the bind
  skin.setInverseBindMatrices(doc.createAccessor().setType("MAT4").setArray(ibm));
  const acc = (type: "VEC3" | "VEC4", arr: Float32Array | Uint16Array) => doc.createAccessor().setType(type).setArray(arr);
  const prim = doc.createPrimitive()
    .setAttribute("POSITION", acc("VEC3", new Float32Array([0, 1, 0, 0.1, 1, 0, 0, 1.1, 0])))
    .setAttribute("JOINTS_0", acc("VEC4", new Uint16Array(12)))
    .setAttribute("WEIGHTS_0", acc("VEC4", new Float32Array([1, 0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0])));
  const body = doc.createNode("Body").setMesh(doc.createMesh("body").addPrimitive(prim)).setSkin(skin);
  doc.createScene().addChild(root).addChild(body);
  await new NodeIO().write(path, doc);
}

async function springsOf(label: string, opts: { hair: boolean; wings: boolean }) {
  const inp = join(dir, `${label}.glb`);
  await rig(inp, opts);
  const p = Bun.spawn(["bun", TOOL, inp, "--name", label, "--out", dir, "--donor", join(dir, "none.glb")], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = [await new Response(p.stdout).text(), await new Response(p.stderr).text()];
  await p.exited;
  let names: string[] = [], wrote = false;
  try {
    const buf = readFileSync(join(dir, `${label}.vrm`));
    const g = JSON.parse(buf.subarray(20, 20 + buf.readUInt32LE(12)).toString());
    wrote = true;
    names = (g.extensions?.VRMC_springBone?.springs ?? []).map((s: { name: string }) => s.name);
  } catch { /* no vrm written: names stays empty and the checks say so */ }
  return { names, wrote, log: (out + err).trim().split("\n").slice(-6).join(" | ") };
}

console.log("wing springs are written with or without hair");
{
  const winged = await springsOf("winged", { hair: false, wings: true });
  check("a hairless winged rig gets its wing spring (G2-091)", winged.names.includes("wing_L_Wing_Upper"), `${winged.names} ${winged.log}`);
  const both = await springsOf("both", { hair: true, wings: true });
  check("a haired winged rig gets both", both.names.includes("wing_L_Wing_Upper") && both.names.includes("hair_0"), `${both.names} ${both.log}`);
  const bare = await springsOf("bare", { hair: false, wings: false });
  check("a rig with neither declares no springs", bare.wrote && bare.names.length === 0, `${bare.names} ${bare.log}`);
}

rmSync(dir, { recursive: true, force: true });
done();
