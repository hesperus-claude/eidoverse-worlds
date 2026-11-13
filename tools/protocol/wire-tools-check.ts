// tools/protocol/wire-tools-check.ts — wire values at the agent's tools (mcpl/tools.ts): a tool argument of the wrong type
// is refused in the tool's words (isError) and nothing is sent. One row per coercing site of the wire-values audit
// (notes WIRE-VALUES-AUDIT-2026-11-12 §4.7, M1–M10), named by its id. Each row asserts the RIGHT behaviour; the ones red
// today are on PENDING (tools/protocol/pending.ts), each also checked to be red the documented way.
// The harness is a STUB agent, no server: handleTool (the door's own entry) runs the real handler against an object that
// records every call the handler makes on its body (walk, face, puppet, animate, sendMod, namePlace, travel…). Requests go
// through the real WorldAgent.prototype.request onto a fake socket, so M1's rows read the JSON frame that would hit the wire.
// A handler that touches a stub member this file doesn't provide is a FAIL (a throw there would read as a refusal).
// usage: bun tools/protocol/wire-tools-check.ts   (PROTOCOL_STRICT_PENDING=1: the pending rows print as FAIL)
// @ts-nocheck
import { handleTool } from "../../mcpl/tools.ts";
import { WorldAgent } from "../../mcpl/agent.ts";
import { pendingRows } from "./pending.ts";

const PENDING: Record<string, string> = {
  M2: "act shove: strength through Number() || 2.2, clamped 0.5–4 with no word",
  M3: "act kick/ban/unban: days through Number(), reason through String(), global by truthiness",
  M4: "library: page through Number() || 1",
  M5: "move: to's elements through Number(); run by truthiness",
  M6: "face: x/z through Number(), NaN passed to face",
  M7: "anim tracks: dur through Number(); replace by truthiness",
  M8: "catch_up/world_history/world_debug: limit through Number() (default, or NaN sent on)",
  M9: "anim: at through Number()",
  M10: "names and ids through String(): a list or object becomes a lookup key",
};
const { ok, row, finish } = pendingRows("wire-tools-check", PENDING);

// ---- a local HTTP base for library's fetches (records each path; answers an empty list) ----
const hits: string[] = [];
const http = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch(req) { hits.push(new URL(req.url).pathname); return Response.json([]); } });
process.on("exit", () => http.stop(true));

const VIC = "u-" + "a".repeat(20);
/** a stub body: `sent` is everything the handler did to the world; `missing` the stub members it reached for and didn't find */
function stub() {
  const sent: any[] = [], missing = new Set<string>();
  // the real request(): its frame on a fake socket, answered ok at once
  const wire: any = { joined: true, histId: 0, pendingRequests: new Map(), water: null,
    ws: { readyState: 1, send: (s: string) => { const f = JSON.parse(s); sent.push({ kind: "frame", frame: f }); queueMicrotask(() => wire.pendingRequests.get(f.id)?.({ reply: { ok: true, entries: [], events: [] } })); } } };
  const rec = (kind: string) => (...args: any[]) => { sent.push({ kind, args }); return undefined; };
  const base: any = {
    name: "hep", joined: true, world: "w", httpBase: `http://127.0.0.1:${http.port}`, pos: { x: 0, y: 0, z: 0 }, flight: null, myOccupancy: null, anims: [], lastRefusal: null, lastSeq: 0,
    people: new Map([["vic", { pose: { p: [2, 0, 0] } }]]), entities: new Map(), actorIds: new Map([["vic", VIC]]),
    serverNow: () => Date.now(), refName: (id: string) => id,
    thingRef: (v: string) => ({ none: true }),
    request: (verb: string, args: any) => WorldAgent.prototype.request.call(wire, verb, args),
    walkTo: async (...args: any[]) => { sent.push({ kind: "walk", args }); return false; },
    face: rec("face"), puppet: rec("puppet"), animate: rec("animate"), setPose: rec("setPose"), animBegan: rec("animBegan"), sendMod: rec("mod"), stop: rec("stop"),
    modOutcome: async () => "ok", namePlace: async (...args: any[]) => { sent.push({ kind: "namePlace", args }); return { ok: true, text: "named" }; },
    firstSaidSince: async (...args: any[]) => { sent.push({ kind: "firstSaidSince", args }); return { said: [], more: false, failed: false, truncated: false }; },
    worldDebug: async (...args: any[]) => { sent.push({ kind: "worldDebug", args }); return { events: [] }; },
    walkRefusal: "stub: the walk is not run", lastWalkNote: null, lastWalkRefusal: null, walkStopReason: null, walkStall: null, placeList: () => "", mayVacate: () => true,
  };
  const ag = new Proxy(base, { get(t, k) { if (typeof k === "symbol" || k in t) return t[k]; if (k !== "then") missing.add(String(k)); return undefined; } });
  const ctx: any = { agent: ag, canPush: () => false, heldActivity: [], cursor: { caughtUpTo: null }, travel: async (w: string) => { sent.push({ kind: "travel", args: [w] }); return { content: [{ type: "text", text: `travelled to ${w}` }] }; } };
  return { ag, ctx, sent, missing };
}
const J = (v: any) => JSON.stringify(v);
/** one tool call: its reply, and what it did to the world */
async function call(tool: string, args: any) {
  const s = stub(); hits.length = 0;
  const err0 = console.error; const threw: string[] = []; console.error = (...a: any[]) => threw.push(a.map(String).join(" ").slice(0, 200));
  let r: any; try { r = await handleTool(s.ctx, tool, args); } finally { console.error = err0; }
  return { r, sent: [...s.sent], fetched: [...hits], missing: [...s.missing], threw, text: (r?.content ?? []).map((c: any) => c.text).join(" ") };
}
/** refused in the tool's own words (isError), nothing sent and nothing fetched, and no stub member reached for (a throw) */
const clean = (x: any) => x.r?.isError === true && !x.sent.length && !x.fetched.length && !x.missing.length && !x.threw.length;
const saw = (x: any) => ({ isError: !!x.r?.isError, text: x.text.slice(0, 160), sent: x.sent.map((e: any) => e.kind === "frame" ? { frame: e.frame } : e).slice(0, 3), fetched: x.fetched, missing: x.missing, threw: x.threw });
const frames = (x: any) => x.sent.filter((e: any) => e.kind === "frame").map((e: any) => e.frame);
const did = (x: any, kind: string) => x.sent.filter((e: any) => e.kind === kind);

// ---- controls: the harness sees a good call go out, and the door's own refusal ----
{ const x = await call("act", { verb: "undo", args: { act: 3 } });
  ok(!x.r?.isError && J(frames(x)) === J([{ type: "request", id: "v1", verb: "undo", args: { act: 3 } }]), "control: act {verb: 'undo', args: {act: 3}} puts exactly that request frame on the wire", saw(x)); }
{ const x = await call("face", { x: 4, z: -2 });
  ok(!x.r?.isError && J(did(x, "face")[0]?.args) === "[4,-2]", "control: face {x: 4, z: -2} turns to (4, -2)", saw(x)); }
{ const x = await call("move", { to: [1, 0, 1], tolerance: "0.1" });
  ok(clean(x), "control: move {tolerance: '0.1'} is already refused (the audit's 'tolerance unchecked' does not hold)", saw(x)); }

// ---- M1 act: verb and args ----
for (const [tag, a, want] of [["verb: ['undo']", { verb: ["undo"], args: {} }, (f: any) => f?.verb === "undo"],
  ["args: '{\"act\":3}' (a string)", { verb: "undo", args: '{"act":3}' }, (f: any) => f?.verb === "undo" && J(f.args) === "{}"],
  ["args: ['hi'] (a list)", { verb: "say", args: ["hi"] }, (f: any) => f?.verb === "say" && J(f.args) === '{"0":"hi"}']] as const) {
  const x = await call("act", a);
  row("M1", `act {${tag}} is refused, no request on the wire`, { right: clean(x), wrong: !x.r?.isError && want(frames(x)[0]), saw: saw(x) }); }

// ---- M2 shove strength ----
for (const [tag, strength, pow] of [["'lots'", "lots", 2.2], ["true", true, 1], ["100 (above 4)", 100, 4]] as const) {
  const x = await call("act", { verb: "shove", args: { target: "vic", strength } });
  const lean = did(x, "puppet")[0]?.args?.[1]?.ragdoll?.lean; const said = /\bstrength\b/.test(x.text);
  row("M2", `act shove {strength: ${tag}} is refused (or kept with a word about strength), nobody shoved`, { right: clean(x) || (strength === 100 && said),
    wrong: !x.r?.isError && Array.isArray(lean) && Math.abs(Math.hypot(...lean) - pow) < 1e-9 && !said, saw: saw(x) }); }

// ---- M3 kick / ban / unban ----
{ const x = await call("act", { verb: "ban", args: { who: "vic", days: true } });
  row("M3", "act ban {days: true} is refused, no ban sent", { right: clean(x), wrong: !x.r?.isError && frames(x).some((f: any) => f.verb === "ban" && f.args.days === 1), saw: saw(x) }); }
{ const x = await call("act", { verb: "kick", args: { who: "vic", reason: { a: 1 } } });
  row("M3", "act kick {reason: {a: 1}} is refused, no kick sent", { right: clean(x), wrong: !x.r?.isError && frames(x).some((f: any) => f.verb === "kick" && f.args.reason === "[object Object]"), saw: saw(x) }); }
{ const x = await call("act", { verb: "ban", args: { who: "vic", global: "false" } });
  row("M3", "act ban {global: 'false'} is refused, not sent as a server-wide ban", { right: clean(x), wrong: !x.r?.isError && did(x, "mod").some((m: any) => m.args[0] === "server-ban"), saw: saw(x) }); }

// ---- M4 library page ----
{ const x = await call("library", { kind: "models", page: "abc" });
  row("M4", "library {kind: 'models', page: 'abc'} is refused, nothing fetched", { right: clean(x), wrong: !x.r?.isError && x.fetched.includes("/library-models"), saw: saw(x) }); }

// ---- M5 move ----
{ const x = await call("move", { to: [true, 0, 0] });
  row("M5", "move {to: [true, 0, 0]} is refused, no walk", { right: clean(x), wrong: did(x, "walk")[0]?.args?.[0] === 1, saw: saw(x) }); }
{ const x = await call("move", { to: ["1", 0, "2"] });
  row("M5", "move {to: ['1', 0, '2']} is refused, no walk", { right: clean(x), wrong: J(did(x, "walk")[0]?.args?.slice(0, 2)) === "[1,2]", saw: saw(x) }); }
{ const x = await call("move", { to: [1, 0, 1], run: "false" });
  row("M5", "move {run: 'false'} is refused (not read as run: true), no walk", { right: clean(x), wrong: did(x, "walk")[0]?.args?.[2] === true, saw: saw(x) }); }

// ---- M6 face ----
{ const x = await call("face", { x: "abc", z: 1 });
  row("M6", "face {x: 'abc', z: 1} is refused, no turn", { right: clean(x), wrong: Number.isNaN(did(x, "face")[0]?.args?.[0]), saw: saw(x) }); }
{ const x = await call("face", { x: "4", z: true });
  row("M6", "face {x: '4', z: true} is refused, no turn", { right: clean(x), wrong: J(did(x, "face")[0]?.args) === "[4,1]", saw: saw(x) }); }

// ---- M7 anim tracks: dur, replace ----
const TRACKS = { leftUpperArm: [{ t: 0, q: [0, 0, 0, 1] }, { t: 0.5, q: [0, 0, -0.7071, 0.7071] }] };
{ const x = await call("anim", { tracks: TRACKS, dur: "2" });
  row("M7", "anim {tracks, dur: '2'} is refused, nothing played", { right: clean(x), wrong: did(x, "animate")[0]?.args?.[0]?.dur === 2, saw: saw(x) }); }
{ const x = await call("anim", { tracks: TRACKS, dur: 1, replace: "false" });
  row("M7", "anim {tracks, replace: 'false'} is refused (not read as replace: true), nothing played", { right: clean(x), wrong: did(x, "animate")[0]?.args?.[0]?.replace === true, saw: saw(x) }); }

// ---- M8 limit ----
{ const x = await call("catch_up", { limit: "abc" });
  row("M8", "catch_up {limit: 'abc'} is refused, no history read", { right: clean(x), wrong: did(x, "firstSaidSince")[0]?.args?.[1] === 60, saw: saw(x) }); }
{ const x = await call("world_history", { limit: "abc" });
  row("M8", "world_history {limit: 'abc'} is refused, no history request on the wire", { right: clean(x), wrong: frames(x).some((f: any) => f.verb === "history" && f.args.limit === null), saw: saw(x) }); }
{ const x = await call("world_debug", { limit: "abc" });
  row("M8", "world_debug {limit: 'abc'} is refused, no flight-recorder read", { right: clean(x), wrong: Number.isNaN(did(x, "worldDebug")[0]?.args?.[0]?.limit), saw: saw(x) }); }

// ---- M9 anim at ----
{ const x = await call("anim", { tracks: TRACKS, mode: "hold", at: "0.5" });
  row("M9", "anim {mode: 'hold', at: '0.5'} is refused, nothing played", { right: clean(x), wrong: did(x, "setPose").length > 0, saw: saw(x) }); }
{ const x = await call("anim", { tracks: TRACKS, mode: "hold", at: true });
  row("M9", "anim {mode: 'hold', at: true} is refused, nothing played", { right: clean(x), wrong: did(x, "setPose").length > 0, saw: saw(x) }); }

// ---- M10 names through String() ----
{ const x = await call("face", { target: ["vic"] });
  row("M10", "face {target: ['vic']} is refused (a name is a string), no turn", { right: clean(x), wrong: J(did(x, "face")[0]?.args) === "[2,0]", saw: saw(x) }); }
{ const x = await call("travel", { world: ["commons"] });
  row("M10", "travel {world: ['commons']} is refused, no travel", { right: clean(x), wrong: did(x, "travel")[0]?.args?.[0] === "commons", saw: saw(x) }); }
{ const x = await call("name_place", { name: { a: 1 } });
  row("M10", "name_place {name: {a: 1}} is refused, no place named", { right: clean(x), wrong: did(x, "namePlace")[0]?.args?.[0] === "[object Object]", saw: saw(x) }); }
{ const x = await call("act", { verb: "kick", args: { who: ["vic"] } });
  row("M10", "act kick {who: ['vic']} is refused, no kick sent", { right: clean(x), wrong: frames(x).some((f: any) => f.verb === "kick" && f.args.who === VIC), saw: saw(x) }); }

finish();
