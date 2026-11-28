// test/protocol/interior-check.ts — interior {ambientColor?, ambientColorEnergy?} on a zone (Godot ReflectionProbe.interior with
// ambient_mode Color, ambient_color, ambient_color_energy): inside the box the sky's ambient gives way to a flat one. This
// suite holds the protocol half: the door, the registry entry, shared/zone.js's reader (interiorsOf), the slot ranking that
// bounds a hostile world (interiorSlots) and the change filter. The pixels are test/client/interior-pixels-check.ts.
//   bun test/protocol/interior-check.ts                 every case
//   bun test/protocol/interior-check.ts --only I1,I4    just those
//   bun test/protocol/interior-check.ts --tree <dir>    against another checkout's shared/ (a mutant, or the base)
//   bun test/protocol/interior-check.ts --mutants       each rule broken in turn (a copy of the tree): its cases must go red
// @ts-nocheck
import "../harness/fixture-ids.ts";
import fs from "node:fs";
import path from "node:path";
import { ENGINE, scratch, copyTree } from "../gate/common.ts";
import { readLogBytes, appendDurable, putBlobFile } from "../../server/durable.ts";
import { custodyAt, modLogAt } from "../../server/custody.ts";
import { labClock, pinned } from "../gate/clock.ts";
import { LAB_CATALOGUE, MODELS as LAB_MODELS } from "../harness/labmodels.js";
import { suite } from "../gate/suite.ts";

const argv = process.argv.slice(2);
const opt = (k: string) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const MUTANTS: [string, string, string, string, string[]][] = [
  ["any zone holds an interior", "protocol/authority/checks.js", "if (c.interior !== undefined && !(c.zone?.shape === \"box\" || c.zone?.global === true)) return", "if (false) return", ["I1"]],
  ["a dark default (energy 0)", "zone.js", "export const INTERIOR_DEFAULTS = Object.freeze({ color: Object.freeze([1, 1, 1]), energy: 0.25 });", "export const INTERIOR_DEFAULTS = Object.freeze({ color: Object.freeze([1, 1, 1]), energy: 0 });", ["I3"]],
  ["a switched-off box still cuts", "zone.js", "a = c.interior;\n    if (id === \"@world\" || !a || typeof a !== \"object\" || !c.zone || offChain(st, id)) continue;", "a = c.interior;\n    if (id === \"@world\" || !a || typeof a !== \"object\" || !c.zone) continue;", ["I3"]],
  ["the thing's scale is ignored", "zone.js", "size: z.size.map((x, i) => Math.abs(x) * scale[i])", "size: z.size.map((x) => Math.abs(x))", ["I3"]],
  ["the weight is unread", "zone.js", "const weight = fin(z.weight) ? Math.max(0, Math.min(1, z.weight)) : 1", "const weight = 1", ["I3"]],
  ["ranked by priority, not nearness", "zone.js", ".sort((x, y) => x.d - y.d || y.b.priority - x.b.priority ||", ".sort((x, y) => y.b.priority - x.b.priority || x.d - y.d ||", ["I4"]],
  ["blended lowest priority first", "zone.js", "return kept.sort((x, y) => y.priority - x.priority ||", "return kept.sort((x, y) => x.priority - y.priority ||", ["I4"]],
  ["no cap on the slots", "zone.js", "const kept = ranked.slice(0, n).map(", "const kept = ranked.map(", ["I4", "I5"]],
  ["the handover is a swap", "zone.js", "const fade = (d) => (d === 0 || edge === Infinity ? 1 :", "const fade = (d) => (true ? 1 :", ["I7"]],
  ["a NaN turn holds a box", "zone.js", "if (!pose || !finN(pose.pos, 3) || (pose.q != null && !finN(pose.q, 4))) continue;", "if (!pose) continue;", ["I8"]],
  ["energy unclamped in the reader", "zone.js", "? Math.min(INTERIOR_ENERGY_MAX, a.ambientColorEnergy) :", "? a.ambientColorEnergy :", ["I8"]],
  ["the ids are unread", "zone.js", "for (const id of ids ?? Object.keys(st.entities)) {", "for (const id of Object.keys(st.entities)) {", ["I9"]],
  ["distance from the centre, not the box", "zone.js", "const d = Math.abs(l[k]) - b.size[k] / 2; if (d > 0) s += d * d;", "const d = Math.abs(l[k]); s += d * d;", ["I4"]],
  ["the filter misses interior", "zone.js", "const INTERIOR_READS = new Set([\"zone\", \"interior\", \"disabled\"]);", "const INTERIOR_READS = new Set([\"zone\", \"disabled\"]);", ["I6"]],
  ["the filter misses a carrier", "zone.js", "for (const v of owners) for (let p = entities?.[v]?.parent?.to, n = 0; p && n < 33; p = entities?.[p]?.parent?.to, n++) if (p === id) return true;   // a carrier above one", "", ["I6"]],
  ["CONTROL (no-op: must stay green)", "zone.js", "// shared/zone.js — a world's", "//  shared/zone.js — a world's", []],
];
async function runSelf(tree: string, only: string[] | null) {
  const r = Bun.spawnSync(["bun", path.join(ENGINE, "test/protocol/interior-check.ts"), "--tree", tree, ...(only ? ["--only", only.join(",")] : [])], { cwd: ENGINE, env: { ...process.env, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
  return { code: r.exitCode, out: r.stdout.toString() + r.stderr.toString() };
}
if (argv.includes("--mutants")) {
  let bad = 0, ran = 0;
  for (const [name, file, find, repl, cases] of MUTANTS) {
    ran++; const d = scratch("intmut"); for (const sub of ["shared", "server"]) copyTree(path.join(ENGINE, sub), path.join(d, sub));
    const f = path.join(d, "shared", file); const src = fs.readFileSync(f, "utf8");
    if (src.split(find).length !== 2) { bad++; console.log(`FAIL mutant '${name}': its text isn't found exactly once in ${file} (the rule moved?)`); continue; }
    fs.writeFileSync(f, src.replace(find, repl));
    const r = await runSelf(d, cases.length ? cases : null);
    const redIds = [...r.out.matchAll(/^FAIL (\S+)/gm)].map((m) => m[1]);
    const good = cases.length ? r.code !== 0 && cases.every((c) => redIds.includes(c)) : r.code === 0;
    if (!good) bad++;
    console.log(`${good ? "ok  " : "FAIL"} mutant '${name}' → ${cases.length ? `red: ${redIds.join(",") || "(none)"} (want ${cases.join(",")})` : `exit ${r.code} (want 0)`}`);
    if (!good) console.log(r.out.split("\n").slice(-12).join("\n"));
  }
  console.log(`[interior-check --mutants] ${ran} mutations run, ${bad} wrong (each must turn its cases red; the control must stay green)`); process.exit(bad ? 1 : 0);
}

const TREE = path.resolve(opt("tree") ?? ENGINE) + "/";
const imp = async (p: string) => { try { return await import(TREE + p); } catch (e) { return { __missing: String(e?.message ?? e).slice(0, 160) }; } };
const D = await import(TREE + "shared/protocol/authority.js");
D.fixtureIds?.(true);
const F = await import(TREE + "shared/protocol/fold.js");
const Z = await imp("shared/zone.js");
const SPEC = await import(TREE + "shared/protocol/componentspec.js");
const ONLY = opt("only")?.split(",") ?? null;
const root = scratch("interior");

function openWorld(name: string) {
  const logPath = path.join(root, "worlds", `${name}.jsonl`), storeDir = path.join(root, "store");
  const blobPath = (h: string) => path.join(storeDir, `${String(h).replace(/[^a-z0-9]/g, "-")}.json`);
  return D.worldOf({ catalogue: LAB_CATALOGUE, simModels: LAB_MODELS, name, entries: F.readLog(readLogBytes(logPath)).map(D.posAt), getBlob: (h: string) => JSON.parse(fs.readFileSync(blobPath(h), "utf8")),
    putBlob: (v: unknown) => { const s = F.jcs(v); const h = `sha256:${F.sha256(s)}`; putBlobFile(blobPath(h), s, h); return h; },
    now: () => pinned(), writeLine: (line: string) => appendDurable(logPath, line), presence: { bodies: {}, holds: {} }, savePresence: () => {}, scripts: null,
    custody: custodyAt(path.join(root, "keys", "custody.json")), ...modLogAt(path.join(root, "worlds", `${name}.mod.jsonl`)) });
}
const clock = labClock(); let N = 0;
const tf = (pos: number[], q = [0, 0, 0, 1], scale = [1, 1, 1]) => ({ pos, q, scale });
// a room: an 8 × 3 × 6 m box centred at [0, 1.5, 0]
const ROOM = (interior: any = {}, zone: any = { shape: "box", size: [8, 3, 6] }, pos = [0, 1.5, 0]) => ({ transform: tf(pos), zone, interior });
function session() {
  const name = `i${++N}`; let w: any = null; const Wd = () => (w ??= openWorld(name));
  const call = (verb: string, args: any = {}, actor = "olive", ms = 1000) => { clock.advance(ms);
    try { return D.request(Wd(), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 200) }; } };
  call("create-world", { title: name });
  return { call, st: () => Wd().state() };
}
const show = (r: any) => (r?.crashed ? `CRASH ${r.crashed}` : r?.ok ? "ok" : `${r?.refused?.code}: ${String(r?.refused?.reason).slice(0, 160)}`);
const near = (a: number, b: number, e = 1e-9) => Math.abs(a - b) <= e;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const need = (...names: string[]) => { const gone = names.filter((n) => typeof Z[n] !== "function" && Z[n] === undefined); return Z.__missing || gone.length ? [false, Z.__missing ?? `shared/zone.js has no ${gone.join(", ")}`] : null; };

const S = suite("interior-check", { cap: 900 });
async function C(id: string, what: string, fn: () => any) {
  if (ONLY && !ONLY.includes(id)) return;
  let r: any; try { r = await fn(); } catch (e) { r = [false, `threw: ${e?.stack ?? e}`]; }
  const [good, info] = Array.isArray(r) ? r : [r, undefined];
  S.ok(good, `${id} ${what}`, good ? undefined : info);
}

await C("I1", "the door: interior needs a sibling box (or global) zone; a sphere zone is refused, as water's are; colour 0..1 each and energy 0..16, wrong types refused; a bare {} on a box is fine; deleting the zone under one is refused", () => {
  const s = session(); const mk = (id: string, components: any) => s.call("create", { id, components });
  const r: any = { bare: mk("a", { transform: tf([0, 0, 0]), interior: {} }), ball: mk("b", ROOM({}, { shape: "sphere", radius: 3 })),
    hot: mk("c", ROOM({ ambientColor: [1.2, 1, 1] })), dim: mk("d", ROOM({ ambientColorEnergy: -1 })), bright: mk("e", ROOM({ ambientColorEnergy: 17 })),
    int: mk("f", ROOM({ ambientColor: 0xff8800 })), word: mk("g", ROOM({ ambientColorEnergy: "2" })),
    box: mk("h", ROOM()), set: mk("i", ROOM({ ambientColor: [1, 0.8, 0.6], ambientColorEnergy: 16 })), global: mk("j", ROOM({}, { shape: "box", size: [1, 1, 1], global: true })) };
  r.unzone = s.call("delete", { id: "h", component: "zone" });
  r.later = s.call("set", { id: "h", component: "interior", value: { ambientColorEnergy: 0.5 } });
  const kept = s.st().entities.i?.c?.interior;
  return [r.bare.refused?.code === "needs" && /sibling zone/.test(r.bare.refused?.reason ?? "") && r.ball.refused?.code === "shape" && /box zone or a global/.test(r.ball.refused?.reason ?? "")
    && r.hot.refused?.code === "bounds" && r.dim.refused?.code === "bounds" && r.bright.refused?.code === "bounds" && r.int.refused?.code === "shape" && r.word.refused?.code === "shape"
    && r.box.ok && r.set.ok && r.global.ok && !r.unzone.ok && r.later.ok && same(kept, { ambientColor: [1, 0.8, 0.6], ambientColorEnergy: 16 }),
    Object.fromEntries(Object.entries(r).map(([k, v]) => [k, show(v)]))]; });

await C("I2", "the registry: interior is a thing's, {ambientColor: vec3 0..1, ambientColorEnergy: number 0..16}, no stored default (absent stores nothing), absence and meaning written, and each field's doc names its Godot counterpart", () => {
  const K = SPEC.COMPONENTS.interior; if (!K) return [false, "no interior in componentspec"];
  return [K.on === "thing" && same(Object.keys(K.fields), ["ambientColor", "ambientColorEnergy"]) && K.fields.ambientColor === "vec3" && K.fields.ambientColorEnergy === "number"
    && K.ranges?.ambientColor?.min === 0 && K.ranges?.ambientColor?.max === 1 && K.ranges?.ambientColorEnergy?.min === 0 && K.ranges?.ambientColorEnergy?.max === 16 && !K.defaults
    && /white/.test(K.absentMeans?.ambientColor ?? "") && /0\.25/.test(K.absentMeans?.ambientColorEnergy ?? "")
    && /ambient_color\b/.test(K.docs?.ambientColor ?? "") && /ambient_color_energy/.test(K.docs?.ambientColorEnergy ?? "") && /ReflectionProbe/.test(K.help ?? ""), K]; });

await C("I3", "shared/zone.js interiorsOf: a box in world space (turned, scaled, carried), the zone's priority, blend, weight (absent 0, 0, 1), absent fields white at 0.25; a global zone holds one everywhere; a sphere zone, no zone, @world or a switched-off thing hold none", () => {
  const miss = need("interiorsOf", "INTERIOR_DEFAULTS"); if (miss) return miss;
  const q90 = [0, Math.SQRT1_2, 0, Math.SQRT1_2];
  const st = { entities: {
    "@world": { c: { interior: {} } },
    room: { c: ROOM() },
    hall: { c: { transform: tf([10, 1, 0], q90, [2, 1, 1]), zone: { shape: "box", size: [4, 2, 1], priority: 3, blend: 0.5, weight: 0.4 }, interior: { ambientColor: [1, 0.5, 0.25], ambientColorEnergy: 2 } } },
    cart: { c: { transform: tf([0, 0, 20]) } },
    hut: { c: { transform: tf([1, 0, 0]), parent: { to: "cart" }, zone: { shape: "box", size: [2, 2, 2] }, interior: {} } },
    cave: { c: { transform: tf([0, 0, 0]), zone: { shape: "box", size: [1, 1, 1], global: true }, interior: { ambientColorEnergy: 0 } } },
    ball: { c: { transform: tf([0, 0, 0]), zone: { shape: "sphere", radius: 2 }, interior: {} } },
    loose: { c: { transform: tf([0, 0, 0]), interior: {} } },
    off: { c: { ...ROOM(), disabled: true } },
    under: { c: { ...ROOM(), parent: { to: "off" } } },
  } };
  const L = Z.interiorsOf(st), by = Object.fromEntries(L.map((b: any) => [b.id, b]));
  const r = by.room, h = by.hall, hut = by.hut, cave = by.cave;
  const ids = L.map((b: any) => b.id).sort();
  const hallIn = h && Z.interiorDistance(h, [10, 1, 3.9]) === 0, hallOut = h && near(Z.interiorDistance(h, [10, 1, 4.5]), 0.5, 1e-9);   // its x (4 m × scale 2 = 8 m) now lies along z
  return [same(ids, ["cave", "hall", "hut", "room"]) && same(Z.INTERIOR_DEFAULTS.color, [1, 1, 1]) && Z.INTERIOR_DEFAULTS.energy === 0.25
    && r && same(r.color, [1, 1, 1]) && r.energy === 0.25 && r.priority === 0 && r.blend === 0 && r.weight === 1 && same(r.center, [0, 1.5, 0]) && same(r.size, [8, 3, 6]) && r.global === false
    && h && same(h.color, [1, 0.5, 0.25]) && h.energy === 2 && h.priority === 3 && h.blend === 0.5 && h.weight === 0.4 && same(h.size, [8, 2, 1]) && hallIn && hallOut
    && hut && same(hut.center, [1, 0, 20]) && cave && cave.global === true && cave.energy === 0 && Z.interiorDistance(cave, [1e5, 0, 0]) === 0,
    { ids, room: r && { ...r, toLocal: undefined }, hall: h && { ...h, toLocal: undefined }, hallIn, hallOut, hut: hut?.center, cave }]; });

await C("I4", "shared/zone.js interiorSlots: the nearest boxes to the eye are kept (0 inside, a global one 0), the higher priority then the later id breaking a tie; kept boxes come back in blend order, highest priority first, a tie the later id first; never more than max", () => {
  const miss = need("interiorsOf", "interiorSlots"); if (miss) return miss;
  const box = (x: number, priority = 0, size = [2, 2, 2]) => ({ c: { transform: tf([x, 0, 0]), zone: { shape: "box", size, priority }, interior: {} } });
  const st = { entities: { a: box(0), b: box(5, 2), c: box(10, 1), d: box(20), e: box(40, 9), f: box(-6), big: box(100, -1, [300, 4, 4]) } };
  const L = Z.interiorsOf(st), at = (eye: number[], max = 4) => Z.interiorSlots(L, eye, max).map((b: any) => b.id);
  const s0 = at([0, 0, 0]);          // kept: inside a and big (0; a the higher priority), b (4 m out), f (5 m out); blend order b (2), f and a (0: the later id first), big (-1)
  const s1 = at([0, 0, 0], 2);       // a and big tie at 0: kept both; blend order a (0) before big (-1)
  const tie = Z.interiorSlots(Z.interiorsOf({ entities: { m: box(0), n: box(0) } }), [0, 0, 0], 1).map((b: any) => b.id);   // a tie of nearness and priority: the later id
  const order = Z.interiorSlots(Z.interiorsOf({ entities: { m: box(0, 1), n: box(0, 1), o: box(0, 5), p: box(0, -2) } }), [0, 0, 0], 4).map((b: any) => b.id);
  const none = Z.interiorSlots([], [0, 0, 0], 4), zero = at([0, 0, 0], 0);
  return [same(s0, ["b", "f", "a", "big"]) && same(s1, ["a", "big"]) && same(tie, ["n"]) && same(order, ["o", "n", "m", "p"]) && none.length === 0 && zero.length === 0,
    { s0, s1, tie, order, none, zero }]; });

await C("I5", "a hostile world: a thousand overlapping boxes keep exactly the slot count, the same ones every time, and ranking them is cheap (under 50 ms on this machine, CPU)", () => {
  const miss = need("interiorsOf", "interiorSlots"); if (miss) return miss;
  const entities: any = {}; for (let i = 0; i < 1000; i++) entities[`x${String(i).padStart(4, "0")}`] = { c: { transform: tf([i % 7, 0, i % 5]), zone: { shape: "box", size: [30, 30, 30], priority: i % 3 }, interior: {} } };
  const L = Z.interiorsOf({ entities }); const t0 = performance.now(); const a = Z.interiorSlots(L, [3, 0, 2], 4), b = Z.interiorSlots(L, [3, 0, 2], 4); const ms = performance.now() - t0;
  return [L.length === 1000 && a.length === 4 && same(a.map((x: any) => x.id), b.map((x: any) => x.id)) && a.every((x: any) => x.priority === 2) && ms < 50, { n: L.length, kept: a.map((x: any) => x.id), ms }]; });

await C("I6", "shared/zone.js interiorChangeTouches: an interior, zone or disabled change on a holder touches it, and so does a holder's carrier moving; an unrelated component or a sky change does not; hydrated and reset always do", () => {
  const miss = need("interiorChangeTouches"); if (miss) return miss;
  const ents: any = { room: { interior: {}, zone: { shape: "box", size: [1, 1, 1] }, parent: { to: "ship" } }, ship: {}, lamp: { light: {} } };
  const owners = new Set(["room"]), t = (ev: any) => Z.interiorChangeTouches(ev, ents, owners);
  const fresh = Z.interiorChangeTouches({ type: "change", id: "new", what: "comp", comp: "interior" }, { new: { interior: {}, zone: {} } }, new Set());
  const r = { interior: t({ type: "change", id: "room", what: "comp", comp: "interior" }), zone: t({ type: "change", id: "room", what: "comp", comp: "zone" }),
    carrier: t({ type: "change", id: "ship", what: "pose" }), fresh, lamp: t({ type: "change", id: "lamp", what: "comp", comp: "light" }),
    sky: t({ type: "world", key: "sky" }), hydrated: t({ type: "hydrated" }), reset: t({ type: "reset" }) };
  return [r.interior && r.zone && r.carrier && r.fresh && !r.lamp && !r.sky && r.hydrated && r.reset, r]; });


await C("I7", "the handover with more boxes than slots is never a swap on screen: six rooms in a row, the eye jittering ±5 mm where two rooms tie for the last slot, and the eye swept along the row in 1 cm steps: no box's weight on the GPU (0 when not kept) moves more than 0.02 in a step; a room the eye is inside keeps its full weight; with no more boxes than slots nothing fades", () => {
  const miss = need("interiorsOf", "interiorSlots"); if (miss) return miss;
  const e: any = {}; for (let i = 0; i < 6; i++) e[`r${i}`] = { c: { transform: tf([i * 10, 1.5, 0]), zone: { shape: "box", size: [8, 3, 8] }, interior: {} } };
  const L = Z.interiorsOf({ entities: e }), seen = (eye: number[]) => new Map(Z.interiorSlots(L, eye, 4).map((b: any) => [b.id, b.weight]));
  const step = (a: Map<string, number>, b: Map<string, number>) => Math.max(0, ...[...new Set([...a.keys(), ...b.keys()])].map((k) => Math.abs((a.get(k) ?? 0) - (b.get(k) ?? 0))));
  let jitter = 0, prev = seen([19.995, 1.5, 0]);   // r0 and r4 both 16 m away from x = 20 (each 4 m half wide)
  for (let i = 0; i < 100; i++) { const now = seen([20 + (i % 2 ? 0.005 : -0.005), 1.5, 0]); jitter = Math.max(jitter, step(prev, now)); prev = now; }
  let sweep = 0, worstAt = 0; prev = seen([-10, 1.5, 0]);
  for (let x = -10; x <= 60; x += 0.01) { const now = seen([x, 1.5, 0]); const d = step(prev, now); if (d > sweep) { sweep = d; worstAt = x; } prev = now; }
  const inside = seen([20, 1.5, 0]).get("r2"), few = Z.interiorSlots(L.slice(0, 4), [30, 1.5, 0], 4).map((b: any) => b.weight);
  return [jitter <= 0.02 && sweep <= 0.02 && inside === 1 && few.every((w: number) => w === 1), { jitter, sweep, worstAt: Math.round(worstAt * 100) / 100, inside, few }]; });

await C("I8", "a hostile or broken record: a box whose pose is not finite (a NaN turn, an infinite centre) holds nothing and leaves the others as they are; an energy past 16 that reached the fold unchecked is read as 16", () => {
  const miss = need("interiorsOf"); if (miss) return miss;
  const st = { entities: { ok: { c: ROOM() }, hot: { c: ROOM({ ambientColorEnergy: 1e9 }, undefined, [0, 1.5, 30]) } } };
  const poses: any = { ok: { pos: [0, 1.5, 0], q: [0, 0, 0, 1] }, hot: { pos: [0, 1.5, 30], q: [0, 0, 0, 1] }, nanq: { pos: [50, 0, 0], q: [NaN, NaN, NaN, NaN] }, far: { pos: [Infinity, 0, 0], q: [0, 0, 0, 1] } };
  (st.entities as any).nanq = { c: ROOM({}, undefined, [50, 0, 0]) }; (st.entities as any).far = { c: ROOM() };
  const L = Z.interiorsOf(st, { poseOf: (id: string) => poses[id] }), ids = L.map((b: any) => b.id).sort();
  return [same(ids, ["hot", "ok"]) && L.find((b: any) => b.id === "hot")?.energy === 16 && same(L.find((b: any) => b.id === "ok")?.center, [0, 1.5, 0]), { ids, hot: L.find((b: any) => b.id === "hot")?.energy }]; });

await C("I9", "interiorsOf({ids}) reads only those records (the renderer's per-frame pass over the boxes it found): with 2,000 other things beside one box, none of the others is even looked at", () => {
  const miss = need("interiorsOf"); if (miss) return miss;
  let looked = 0; const entities: any = { room: { c: ROOM() } };
  for (let i = 0; i < 2000; i++) Object.defineProperty(entities, `t${i}`, { enumerable: true, get() { looked++; return { c: { transform: tf([i, 0, 0]) } }; } });
  const L = Z.interiorsOf({ entities }, { ids: new Set(["room"]) }), some = looked; const all = Z.interiorsOf({ entities });
  return [L.length === 1 && L[0].id === "room" && some === 0 && all.length === 1 && looked >= 2000, { kept: L.map((b: any) => b.id), looked: some, thenAll: looked }]; });

S.done();
