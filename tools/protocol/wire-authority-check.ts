// tools/protocol/wire-authority-check.ts — wire values at the authority, in-process: a value of the wrong type is refused
// with a reason (shape), and nothing is written or changed. One row per coercing site of the wire-values audit
// (notes WIRE-VALUES-AUDIT-2026-11-12 §4.1 A1–A18, §4.2 T1–T3), named by its id. Each row asserts the RIGHT behaviour;
// the ones red today are on PENDING (tools/protocol/pending.ts), each also checked to be red the documented way.
// usage: bun tools/protocol/wire-authority-check.ts   (PROTOCOL_STRICT_PENDING=1: the pending rows print as FAIL)
// @ts-nocheck
import { scratch } from "./common.ts";
import { request, fixtureIds } from "../../shared/protocol/authority.js";
import { openWorld } from "../../server/filehost.ts";
import { labClock } from "./clock.ts";
import { pendingRows } from "./pending.ts";
fixtureIds(true);   // the fixtures name their things (R 10-17: a writer never chooses an id; ids-check covers the refusal)

// the audit ids red on main today; a fix takes its id off this list in the same commit that turns it green
const PENDING: Record<string, string> = {
  A1: "transform.yaw shorthand coerced (null → no turn, '30' → 30 rad, true/[1] → 1 rad); bareYaw on hep/nissa-names",
  A2: "a transform value that is not an object (null, 0, false, absent, merge {pos: null}) → the default transform",
  A3: "place.side: the other mode's words are read as a side",
  A4: "put.q: null → the hold's orientation",
  A5: "move.height / move.scale clamped with no note",
  A6: "create-world title/text: null → the world's name / ''",
  A7: "say's spoken trio: a malformed one is dropped, the say logged as ordinary; t0 clamped with no note",
  A8: "caption n/t0/t1/text/speaker/title converted with Number()/String()",
  A9: "mute.channels: null → both",
  A10: "sky.forecast/ts/override: dropped or overwritten",
  A11: "weather.keepSky: anything but false keeps the sky",
  A12: "use.args.impulse: null → the default push; strings multiplied; extra elements counted",
  A13: "use.args.phase / held: any phase but 'up' is down; a non-boolean held ignored",
  A14: "reach.at: a non-array at is ignored and relayed",
  A15: "adopt/scripts .script built into a key by template string",
  A16: "find.kind: any kind but 'blueprint' lists models",
  A17: "publish.name: null → the id; an object stored as the name",
  A18: "update.resolve: null reads as no resolve",
  T1: "set transform value 5 / 'abc' throws (\"yaw\" in value)",
  T2: "batch.requests not an array throws (forEach)",
  T3: "use.args.impulse: 5 throws (spread of a non-iterable)",
};
const { ok, row, finish } = pendingRows("wire-authority-check", PENDING);

const root = scratch("wire-authority");
const clock = labClock();
const W = (name: string) => openWorld(root, name);
const callIn = (name: string) => (actor: string, verb: string, args: any = {}) => { clock.advance(700);   // 700 ms: under the request rate
  try { return request(W(name), actor, verb, args); } catch (e) { return { crashed: `${e?.constructor?.name}: ${e?.message}`.slice(0, 160) }; } };
const J = (v: any) => JSON.stringify(v);
/** one request and what it did: its reply, the log entries it added, and `read` of the state before and after. */
function attempt(name: string, actor: string, verb: string, args: any, read: (w: any) => any = () => null) {
  const w0 = W(name); const n0 = w0.entries.length, before = J(read(w0));
  const r = callIn(name)(actor, verb, args);
  const w1 = W(name); return { r, added: w1.entries.slice(n0), before, after: J(read(w1)), w: w1 };
}
/** refused with one of `codes`, the log gained nothing but the refused act itself, and `read` is as it was. */
const clean = (x: any, codes = ["shape"]) => x.r?.ok === false && codes.includes(x.r.refused?.code)
  && x.added.every((e: any) => e.kind === "request" && e.body?.refused) && x.before === x.after;
const saw = (x: any) => ({ reply: x.r?.crashed ? `CRASH ${x.r.crashed}` : x.r?.ok ? "ok" : x.r?.refused ? `${x.r.refused.code}: ${String(x.r.refused.reason).slice(0, 120)}` : x.r,
  added: x.added.map((e: any) => `${e.kind}:${e.verb ?? e.op ?? ""}${e.body?.refused ? "(refused)" : ""}`), after: x.after?.slice(0, 200) });
const crashed = (x: any) => !!x.r?.crashed;
const okd = (x: any) => x.r?.ok === true || x.r?.dry === true;
const comp = (id: string, c: string) => (w: any) => w.state().entities[id]?.c?.[c];

// ---------------- transform: A1, A2, T1 ----------------
{ const N = "tf", call = callIn(N);
  call("olive", "create-world", { title: "tf" });
  call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -50, -50], max: [50, 50, 50] } });
  ok(call("olive", "create", { id: "crate", components: { mesh: { shape: "box", size: [0.5, 0.5, 0.5] }, transform: { pos: [1, 0, 1] } } }).ok, "setup: a crate at [1, 0, 1]");
  const tf = comp("crate", "transform");
  const reset = () => ok(call("olive", "set", { id: "crate", component: "transform", value: { pos: [1, 0, 1], q: [0, 0, 0, 1], scale: [1, 1, 1] } }).ok, "setup: the crate back at [1, 0, 1], unturned");
  const atOrigin = (x: any) => J(JSON.parse(x.after ?? "null")?.pos) === "[0,0,0]";
  { reset(); const x = attempt(N, "olive", "set", { id: "crate", component: "transform", value: { pos: [1, 0, 1], yaw: 0.5 } }, tf);
    ok(x.r.ok && Math.abs(JSON.parse(x.after).q[1] - Math.sin(0.25)) < 1e-3, "control: set transform {yaw: 0.5} turns it 0.5 rad", saw(x)); }
  for (const [tag, yaw] of [["null", null], ["'30'", "30"], ["true", true], ["[1]", [1]]] as const) { reset();
    const x = attempt(N, "olive", "set", { id: "crate", component: "transform", value: { pos: [1, 0, 1], yaw } }, tf);
    row("A1", `set transform {yaw: ${tag}} is refused as shape, the transform unchanged`, { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
  for (const [tag, args] of [["value: null", { value: null }], ["value: 0", { value: 0 }], ["value: false", { value: false }], ["no value", {}],
    ["merge, value: null", { value: null, merge: true }], ["merge, no value", { merge: true }], ["merge, value: {pos: null}", { value: { pos: null }, merge: true }]] as const) { reset();
    const x = attempt(N, "olive", "set", { id: "crate", component: "transform", ...args }, tf);
    row("A2", `set transform {${tag}} is refused, the thing left where it was`, { right: clean(x, ["shape", "missing-arg"]), wrong: x.r?.ok === true && atOrigin(x), saw: saw(x) }); }
  { const x = attempt(N, "olive", "create", { id: "t2", components: { transform: null, mesh: {} } }, (w) => Object.keys(w.state().entities).sort());
    row("A2", "create {components: {transform: null}} is refused as shape, nothing made", { right: clean(x), wrong: x.r?.ok === true && J(x.w.state().entities.t2?.c.transform?.pos) === "[0,0,0]", saw: saw(x) }); }
  for (const [tag, value] of [["5", 5], ["'abc'", "abc"]] as const) { reset();
    const x = attempt(N, "olive", "set", { id: "crate", component: "transform", value }, tf);
    row("T1", `set transform {value: ${tag}} is refused as shape (not a server error)`, { right: clean(x), wrong: crashed(x), saw: saw(x) }); }
}

// ---------------- place.side by mode: A3 ----------------
{ const N = "place", call = callIn(N);
  call("olive", "create-world", { title: "place" });
  call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -50, -50], max: [50, 50, 50] } });
  const box = (id: string, size: number[], pos: number[]) => ok(call("olive", "create", { id, components: { mesh: { shape: "box", size }, transform: { pos } } }).ok, `setup: ${id}`);
  box("crate", [0.5, 0.5, 0.5], [1, 0, 1]); box("wall", [4, 2, 0.2], [5, 0, 5]); box("box2", [0.5, 0.5, 0.5], [-5, 0, -5]);
  const posOf = (r: any) => okd(r) ? J((r.would ?? []).filter((o: any) => o.comp === "transform").at(-1)?.value?.pos) : null;
  const dry = (a: any) => attempt(N, "olive", "place", { id: "crate", ...a, dry: true }, comp("crate", "transform"));
  const A1p = posOf(dry({ against: "wall", side: 1 }).r), Am1 = posOf(dry({ against: "wall", side: -1 }).r);
  const Bl = posOf(dry({ beside: "box2", side: "left" }).r), Br = posOf(dry({ beside: "box2", side: "right" }).r);
  ok(A1p && Am1 && A1p !== Am1 && Bl && Br && Bl !== Br, "control: against side 1 / -1, and beside left / right, are each two different spots", { A1p, Am1, Bl, Br });
  for (const [mode, side, same] of [["against", "left", Am1], ["against", "right", Am1], ["beside", 1, Br], ["beside", -1, Br]] as const) {
    const x = dry({ [mode]: mode === "against" ? "wall" : "box2", side });
    row("A3", `place {${mode}, side: ${J(side)}} (the other mode's word) is refused`, { right: clean(x, ["shape", "doesnt-apply"]), wrong: okd(x.r) && posOf(x.r) === same, saw: { ...saw(x), pos: posOf(x.r) } }); }
}

// ---------------- body verbs: A4, A5, A13, A14 ----------------
{ const N = "body", call = callIn(N);
  call("olive", "create-world", { title: "body" });
  call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -50, -50], max: [50, 50, 50] } });
  ok(call("olive", "create", { id: "crate", components: { mesh: { shape: "box", size: [0.5, 0.5, 0.5] }, transform: { pos: [1, 0, 1] }, grabbable: {} } }).ok, "setup: a grabbable crate");
  ok(call("olive", "create", { id: "tap", components: { mesh: { shape: "box", size: [0.3, 0.3, 0.3] }, transform: { pos: [1.6, 0, 0.4] }, grabbable: {}, openable: { open: false },
    reactions: { open: { kind: "toggle", component: "openable", field: "open" } } } }).ok, "setup: a grabbable tap with a toggle");
  ok(call("olive", "move", { to: [1, 0, 0.2] }).ok, "setup: olive's body beside them");
  // A4
  ok(call("olive", "grab", { id: "crate" }).ok, "setup: olive grabs the crate");
  { const x = attempt(N, "olive", "put", { id: "crate", q: null }, (w) => [w.state().entities.crate.c.transform, w.presence.holds?.crate?.by ?? null]);
    row("A4", "put {q: null} is refused as shape: still held, not set down", { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
  // A5
  const sizeNow = (w: any) => w.presence.bodies?.olive?.size ?? null;
  for (const [k, v] of [["height", 100], ["scale", 5]] as const) {
    const x = attempt(N, "olive", "move", { to: [1, 0, 0.25], [k]: v }, sizeNow);
    const said = x.r?.ok === true && J(x.r.notes ?? []).includes(`"${k}"`);
    row("A5", `move {${k}: ${v}} (out of range) is refused, or kept with a note naming ${k}`, { right: clean(x, ["shape", "bounds"]) || said,
      wrong: x.r?.ok === true && !said && JSON.parse(x.after ?? "null")?.[k] !== v, saw: { ...saw(x), notes: x.r?.notes } }); }
  // A13: phase and held
  { const x = attempt(N, "olive", "use", { id: "tap", action: "open", args: { held: "yes" } }, comp("tap", "openable"));
    row("A13", "use {args: {held: 'yes'}} (not a boolean) is refused as shape, nothing toggled", { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
  ok(call("olive", "drop", { id: "crate" }).ok !== undefined && call("olive", "grab", { id: "tap" }).ok, "setup: olive holds the tap");
  { const x = attempt(N, "olive", "use", { id: "tap", action: "open", args: { phase: "upp" } }, comp("tap", "openable"));
    row("A13", "use {args: {phase: 'upp'}} while holding is refused as shape (not read as down)", { right: clean(x), wrong: x.r?.ok === true && x.r.held?.phase === "down", saw: { ...saw(x), held: x.r?.held } }); }
  // A14: a reach at your own body (no consent needed), with a junk `at`
  { const x = attempt(N, "olive", "reach", { who: "olive", point: "shoulder_l", at: "junk" }, (w) => w.presence.reaches ?? null);
    row("A14", "reach {who, point, at: 'junk'} is refused as shape (at is [x, y, z] when present)", { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
}

// ---------------- founding: A6 ----------------
for (const [k, tag] of [["title", "title"], ["text", "text"]] as const) {
  const N = `found-${k}`;
  const x = attempt(N, "olive", "create-world", { title: "t", [k]: null }, (w) => w.exists);
  row("A6", `create-world {${tag}: null} is refused as shape, no world founded`, { right: clean(x), wrong: x.r?.ok === true, saw: { ...saw(x), about: x.w.state().entities["@world"]?.c.about } });
}

// ---------------- say and caption: A7, A8 ----------------
{ const N = "talk", call = callIn(N);
  call("olive", "create-world", { title: "talk" });
  ok(call("olive", "create", { id: "screen", components: { mesh: { shape: "box", size: [2, 1, 0.1] }, transform: { pos: [0, 1, 3] } } }).ok, "setup: a screen");
  const lastSay = (x: any) => x.added.find((e: any) => e.kind === "request" && e.verb === "say")?.body;
  { const x = attempt(N, "olive", "say", { text: "hi", spoken: true, utt: 1 });
    ok(x.r.ok && lastSay(x)?.spoken === true && lastSay(x)?.utt === 1, "control: a well-formed spoken say keeps spoken and utt", saw(x)); }
  for (const [tag, a] of [["spoken: 'yes'", { spoken: "yes", utt: 2 }], ["utt: '1'", { spoken: true, utt: "1" }], ["t0: '5'", { spoken: true, utt: 3, t0: "5" }]] as const) {
    const x = attempt(N, "olive", "say", { text: "hi", ...a });
    const b = lastSay(x);
    row("A7", `say {${tag}} (a malformed spoken trio) is refused as shape, not logged as an ordinary say`, { right: clean(x),
      wrong: x.r?.ok === true && (tag.startsWith("t0") ? b?.spoken === true && !("t0" in b) : !("spoken" in (b ?? {}))), saw: { ...saw(x), body: b } }); }
  { const t0 = 9e12;   // far in the future: clamped to now
    const x = attempt(N, "olive", "say", { text: "hi", spoken: true, utt: 4, t0 }); const b = lastSay(x);
    const said = x.r?.ok === true && J(x.r.notes ?? []).includes("t0");
    row("A7", "say {t0} outside the utterance window: refused, or clamped with a note naming t0", { right: clean(x, ["shape", "bounds"]) || said, wrong: x.r?.ok === true && !said && b?.t0 !== t0, saw: { ...saw(x), body: b, notes: x.r?.notes } }); }
  let n = 1; const S = "2026-09-16T20:00:00.000Z-k3f9";
  const caps = comp("screen", "captions");
  { const x = attempt(N, "olive", "caption", { id: "screen", session: S, n: n++, t0: 0, t1: 1, text: "hello" }, caps);
    ok(x.r.ok && JSON.parse(x.after)?.line?.text === "hello", "control: a well-formed caption line is written", saw(x)); }
  for (const [tag, a] of [["n: '7'", { n: "7" }], ["n: [8]", { n: [8] }], ["t0: null", { t0: null }], ["t0: '0.5'", { t0: "0.5" }], ["t1: [2]", { t1: [2] }],
    ["text: {a: 1}", { text: { a: 1 } }], ["text: 42", { text: 42 }], ["speaker: {x: 1}", { speaker: { x: 1 } }], ["title: {x: 1}", { title: { x: 1 } }]] as const) {
    // n: '7' and [8] come first (above the control's 1); every later line's n is above both, so only the bad field can refuse it
    const x = attempt(N, "olive", "caption", { id: "screen", session: S, n: 10 + n++, t0: 0, t1: 1, text: "line", ...a }, caps);
    row("A8", `caption {${tag}} is refused as shape, the captions unchanged`, { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
}

// ---------------- moderation, sky, weather: A9, A10, A11 ----------------
{ const N = "mod", call = callIn(N);
  call("olive", "create-world", { title: "mod" });
  call("olive", "set", { id: "@world", component: "roles:vic", value: { role: "member" } });
  { const x = attempt(N, "olive", "mute", { who: "vic", minutes: 5, channels: null }, (w) => w.mod.length);
    row("A9", "mute {channels: null} is refused as shape, no mute recorded", { right: clean(x), wrong: x.r?.ok === true && J(x.r.channels) === '["voice","chat"]', saw: { ...saw(x), channels: x.r?.channels } }); }
  const sky = comp("@world", "sky");
  ok(call("olive", "sky", { hours: 9 }).ok, "setup: a sky at 9 h");
  for (const [tag, a, gone] of [["forecast: 'storm'", { forecast: "storm" }, (s: any) => !s?.forecast], ["ts: 5", { ts: 5 }, (s: any) => s?.ts !== 5], ["override: {x: 1}", { override: { x: 1 } }, (s: any) => !s?.override]] as const) {
    const x = attempt(N, "olive", "sky", { hours: 3, ...a }, sky);
    row("A10", `sky {${tag}} is refused (shape, or stamped as set says), the sky unchanged`, { right: clean(x, ["shape", "stamped"]), wrong: x.r?.ok === true && gone(JSON.parse(x.after ?? "null")), saw: saw(x) }); }
  { const x = attempt(N, "olive", "weather", { weather: "rain", keepSky: "false" }, sky);
    row("A11", "weather {keepSky: 'false'} (a string) is refused as shape, the sky unchanged", { right: clean(x), wrong: x.r?.ok === true, saw: saw(x) }); }
}

// ---------------- use impulse: A12, T3 ----------------
{ const N = "swing", call = callIn(N);
  call("olive", "create-world", { title: "swing" });
  call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -50, -50], max: [50, 50, 50] } });
  ok(call("olive", "create", { id: "swing", components: { mesh: {}, transform: { pos: [8, 1, 8] }, pivot: { pos: [0, 2, 0] }, motion: { type: "pendulum" }, reactions: { push: { kind: "impulse" } } } }).ok, "setup: a swing");
  const mo = comp("swing", "motion");
  { const x = attempt(N, "olive", "use", { id: "swing", action: "push", args: { impulse: [0, 0, 2] } }, mo);
    ok(x.r.ok && x.before !== x.after, "control: use {impulse: [0, 0, 2]} swings it", saw(x)); }
  for (const [tag, impulse, wrong] of [["null", null, (x: any) => x.r?.ok === true], ["['0','0','2']", ["0", "0", "2"], (x: any) => x.r?.ok === true],
    ["[0,0,1,9,9]", [0, 0, 1, 9, 9], (x: any) => x.r?.refused?.code === "sideways"]] as const) {
    const x = attempt(N, "olive", "use", { id: "swing", action: "push", args: { impulse } }, mo);
    row("A12", `use {impulse: ${tag}} is refused as shape (three finite numbers), the swing unchanged`, { right: clean(x), wrong: wrong(x), saw: saw(x) }); }
  { const x = attempt(N, "olive", "use", { id: "swing", action: "push", args: { impulse: 5 } }, mo);
    row("T3", "use {impulse: 5} is refused as shape (not a server error)", { right: clean(x), wrong: crashed(x), saw: saw(x) }); }
}

// ---------------- scripts, blueprints, batch: A15, A16, A17, A18, T2 ----------------
{ const N = "lib", call = callIn(N);
  call("olive", "create-world", { title: "lib" });
  call("olive", "set", { id: "@world", component: "bounds", value: { min: [-50, -50, -50], max: [50, 50, 50] } });
  ok(call("olive", "create", { id: "bell1", model: "bell", place: { at: [0, 0] } }).ok, "setup: a bell");
  const up = call("olive", "upload", { text: `world.on("use", (e) => { world.say("ding"); });\n` });
  ok(up.ok && call("olive", "set", { id: "bell1", component: "script:bell", value: { src: up.src, scope: { say: true }, on: ["use"] } }).ok, "setup: script:bell installed on it", up);
  { const x = attempt(N, "olive", "adopt", { id: "bell1", script: "bell", dry: true });
    ok(okd(x.r), "control: adopt {script: 'bell', dry} is accepted", saw(x)); }
  { const x = attempt(N, "olive", "adopt", { id: "bell1", script: ["bell"], dry: true });
    row("A15", "adopt {script: ['bell']} (a list) is refused as shape, not read as 'bell'", { right: clean(x), wrong: okd(x.r), saw: saw(x) }); }
  { const x = attempt(N, "olive", "scripts", { id: "bell1", script: ["bell"], test: { on: "use" } });
    row("A15", "scripts {script: ['bell'], test} (a list) is refused as shape, not run as script:bell", { right: clean(x), wrong: okd(x.r), saw: saw(x) }); }
  { const x = attempt(N, "olive", "find", { kind: "banana" });
    row("A16", "find {kind: 'banana'} is refused as shape (model | blueprint)", { right: clean(x), wrong: x.r?.ok === true && Array.isArray(x.r.models), saw: saw(x) }); }
  const bps = (w: any) => Object.entries(w.state().entities["@world"].c).filter(([k]) => k.startsWith("blueprints:")).map(([, v]) => v);
  for (const [tag, name, wrong] of [["null", null, (v: any) => v?.name === "bell1"], ["{x: 1}", { x: 1 }, (v: any) => J(v?.name) === '{"x":1}']] as const) {
    const x = attempt(N, "olive", "publish", { from: "bell1", name }, bps);
    const made = JSON.parse(x.after).find((v: any) => !JSON.parse(x.before).some((b: any) => J(b) === J(v)));
    row("A17", `publish {name: ${tag}} is refused as shape, no blueprint written`, { right: clean(x), wrong: x.r?.ok === true && wrong(made), saw: { ...saw(x), made } }); }
  // A18: a copy of a blueprint, and a newer version of it with no conflicts; update dry with each falsy resolve
  ok(call("olive", "create", { id: "lamp", model: "crate", place: { at: [3, 3] } }).ok, "setup: a lamp");
  const v1 = call("olive", "publish", { from: "lamp", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
  ok(v1 && call("olive", "create", { id: "a", from: v1, at: { pos: [5, 0, 5] } }).ok && call("olive", "create", { id: "b", from: v1, at: { pos: [9, 0, 5] } }).ok, "setup: copies a and b of it", v1);
  call("olive", "set", { id: "a", component: "label", value: "lamp v2" });
  const v2 = call("olive", "publish", { from: "a", name: "lamp" }).notes?.find((n: any) => n.record)?.record;
  { const x = attempt(N, "olive", "update", { copy: "b", to: v2, dry: true });
    ok(okd(x.r), "control: update {copy: b, to: v2, dry} (no conflicts) is accepted", saw(x)); }
  for (const [tag, resolve] of [["null", null], ["false", false], ["0", 0], ["''", ""]] as const) {
    const x = attempt(N, "olive", "update", { copy: "b", to: v2, resolve, dry: true });
    row("A18", `update {resolve: ${tag}} is refused as shape (resolve is an object), not read as no resolve`, { right: clean(x), wrong: okd(x.r), saw: saw(x) }); }
  for (const [tag, requests] of [["'abc'", "abc"], ["{}", {}]] as const) {
    const x = attempt(N, "olive", "batch", { requests });
    row("T2", `batch {requests: ${tag}} is refused as shape (not a server error)`, { right: clean(x), wrong: crashed(x), saw: saw(x) }); }
}

finish();
