// tools/protocol/wire-server-check.ts — wire values at the server's door: a real server (tools/harness.ts scratchSequencer),
// real WebSockets. A message field of the wrong type is refused with a reason (an error frame, or a shape reply), and
// nothing is written, relayed or changed. One row per coercing site of the wire-values audit (notes
// WIRE-VALUES-AUDIT-2026-11-12 §4.6 S1–S17), named by its id. Each row asserts the RIGHT behaviour; the ones red today
// are on PENDING (tools/protocol/pending.ts), each also checked to be red the documented way.
// Not pinned here: S11 (typing: the audit calls the allowlist fine, so there is no right behaviour to assert yet) and
// S15 (the SFU position frame needs a running relay).
// usage: bun tools/protocol/wire-server-check.ts   (PROTOCOL_STRICT_PENDING=1: the pending rows print as FAIL)
// @ts-nocheck
import fs from "node:fs";
import path from "node:path";
import { scratch } from "./common.ts";
import { until, tryUntil, pause } from "./wait.ts";
import { scratchSequencer } from "../harness.ts";
import { readLog } from "../../shared/protocol/fold.js";
import { helloOf } from "../../shared/protocol/hello.js";
import { pendingRows } from "./pending.ts";

const PENDING: Record<string, string> = {
  S3: "world-fork.to through String() and cut to 64",
  S4: "world-found.name through String(); a non-string title dropped",
  S5: "world-reset.name through String(): ['<name>'] passes the typed confirmation",
  S6: "history/debug limit through Number(); a non-number before is Infinity",
  S7: "anim: a non-number dur is dropped with no answer",
  S8: "puppet.ragdoll.lean through Number(): [null, 0, 0] relayed as [0, 0, 0]",
  S9: "bodydrag.yaw/p through Number(): 'abc' relayed as null, strings as numbers",
  S10: "presence caption: text through String(), a bad utt → 0",
  S12: "drag: id and pos broadcast with no type check",
  S13: "server-ban: id and reason through String()",
  S14: "join: spectate by truthiness, an unknown avatar → the default body, a long id cut",
  S16: "voice-moderate: muted other than true unmutes; a non-number minutes → 60",
  S17: "HTTP query numbers: a bad value → the default",
};
const { ok, row, finish } = pendingRows("wire-server-check", PENDING);

const W = "wire", WIPE = "wipe";
const mine = scratch("wire-server");
const OPTOK = path.join(mine, "op-tokens.json"); fs.writeFileSync(OPTOK, JSON.stringify({ "tok-opal": { id: "Opal" } }));
const H = await scratchSequencer("wire-server", { worlds: [W, WIPE], owner: "Ann", serverEnv: { SKIP_OPT_SWEEP: "1", TRUST_NAMES: "1", FORK_GAP_SEC: "0", FORK_PER_HOUR: "0",
  SERVER_OPERATORS: "agent:token:opal", AGENT_TOKENS_PATH: OPTOK, BUN_RUNTIME_TRANSPILER_CACHE_PATH: "0" } });
const URL = `ws://127.0.0.1:${H.PORT}/ws`;
const logOf = (w: string) => readLog(fs.readFileSync(path.join(H.SCRATCH, "worlds", w, "world.jsonl")));
const J = (v: any) => { try { return JSON.stringify(v)?.slice(0, 300); } catch { return String(v); } };

// a client that keeps every message: req sends a request frame as given (verb and args exactly as passed, never normalized)
const clients: any[] = [];
async function client(world: string, id: string, extra: any = {}) {
  const ws = new WebSocket(URL); const msgs: any[] = []; const waiters = new Map(); let n = 0, closed: any = null;
  ws.onmessage = (ev) => { const m = JSON.parse(String(ev.data)); msgs.push(m); if (m.type === "reply") { const f = waiters.get(m.id); if (f) { waiters.delete(m.id); f(m); } } };
  ws.onclose = (ev) => { closed = ev.code; };
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
  ws.send(JSON.stringify({ type: "join", hello: helloOf(), world, id, avatar: "", replica: true, ...extra }));
  await until(`${id}'s join is answered`, () => msgs.some((m) => m.type === "snapshot" || m.type === "error"), { ms: 8000, step: 50 });
  const c = { id, ws, msgs, get closed() { return closed; }, snapshot: msgs.find((m) => m.type === "snapshot"),
    raw: (m: any) => ws.send(JSON.stringify(m)),
    frame: (msg: any) => new Promise<any>((res) => { const rid = `${id}-${++n}`; waiters.set(rid, res); ws.send(JSON.stringify({ type: "request", id: rid, ...msg }));
      setTimeout(() => { if (waiters.delete(rid)) res({ timeout: true }); }, 6000); }),
    req: (verb: string, args: any = {}) => c.frame({ verb, args }).then((m: any) => m.reply ?? m),
    after: (k: number) => msgs.slice(k), close: () => ws.close() };
  clients.push(c); return c;
}
const errorsAfter = (c: any, k: number) => c.after(k).filter((m: any) => m.type === "error");
const changesSince = (w: string, n0: number) => logOf(w).slice(n0).filter((e: any) => e.kind === "change");

try {
  const ann = await client(W, "Ann"), bob = await client(W, "Bob");
  ok(ann.snapshot?.yourRights?.role === "owner" && bob.snapshot, "setup: Ann (owner) and Bob are in the world", [ann.snapshot?.yourRights, !!bob.snapshot]);
  const BOB = bob.snapshot?.actor;
  ok((await ann.req("sky", { hours: 9 })).ok, "control: request {verb: 'sky', args: {hours: 9}} is accepted");

  // ---- S1: args that is not a plain object; S2: a verb that is not a string ----
  for (const [tag, args] of [["a string (double-encoded)", JSON.stringify({ hours: 9 })], ["an array", [9]], ["a number", 9], ["null", null]] as const) {
    const n0 = logOf(W).length; const m = await ann.frame({ verb: "sky", args });
    await pause("a refused request has had its chance to land in the log (it must not)", 150);
    const ch = changesSince(W, n0);
    row("S1", `request {verb: 'sky', args: ${tag}} is refused as shape, and the sky is not reset`, { right: m.ok === false && m.reply?.refused?.code === "shape" && !ch.length,
      wrong: m.ok === true && ch.length > 0, saw: { reply: m.reply?.refused ?? m.reply?.ok ?? m, changes: ch.length } }); }
  { const n0 = logOf(W).length; const m = await ann.frame({ verb: ["sky"], args: { hours: 9 } });
    await pause("a refused request has had its chance to land in the log (it must not)", 150);
    const ch = changesSince(W, n0);
    row("S2", "request {verb: ['sky']} (a list) is refused, not run as sky", { right: m.ok === false && !ch.length, wrong: m.ok === true && m.verb === "sky", saw: { verb: m.verb, ok: m.ok, refused: m.reply?.refused, changes: ch.length } }); }

  // ---- S3: world-fork.to; S4: world-found name/title ----
  const worldsNow = () => fs.readdirSync(path.join(H.SCRATCH, "worlds")).sort().join();
  for (const [tag, to, wrong] of [["a 70-character name", "f".repeat(70), (m: any) => m?.to === "f".repeat(64)], ["['forkx'] (a list)", ["forkx"], (m: any) => m?.to === "forkx"]] as const) {
    const k = ann.msgs.length, w0 = worldsNow(); ann.raw({ type: "world-fork", to });
    await tryUntil("the fork is answered", () => ann.after(k).some((m: any) => m.type === "world-forked" || m.type === "error"), { ms: 8000, step: 50 });
    const done = ann.after(k).find((m: any) => m.type === "world-forked"), err = errorsAfter(ann, k)[0];
    row("S3", `world-fork {to: ${tag}} is refused with an error, no world made`, { right: !!err && !done && worldsNow() === w0, wrong: wrong(done), saw: { done, err, worlds: worldsNow() } }); }
  for (const [tag, msg, wrong] of [["name: ['foundx'] (a list)", { name: ["foundx"] }, (m: any) => m?.name === "foundx"], ["title: 42", { name: "foundy", title: 42 }, (m: any) => m?.name === "foundy"]] as const) {
    const k = ann.msgs.length, w0 = worldsNow(); ann.raw({ type: "world-found", ...msg });
    await tryUntil("the founding is answered", () => ann.after(k).some((m: any) => m.type === "world-founded" || m.type === "error"), { ms: 8000, step: 50 });
    const done = ann.after(k).find((m: any) => m.type === "world-founded"), err = errorsAfter(ann, k)[0];
    row("S4", `world-found {${tag}} is refused with an error, no world founded`, { right: !!err && !done && worldsNow() === w0, wrong: wrong(done), saw: { done, err } }); }

  // ---- S5: world-reset's typed confirmation ----
  { const wa = await client(WIPE, "Ann");
    ok((await wa.req("create", { model: "test/none.glb", components: { label: "keep me" } })).ok !== undefined, "setup: something in the world to erase");
    const g0 = J(logOf(WIPE)[0]), k = wa.msgs.length; wa.raw({ type: "world-reset", name: [WIPE] });
    await tryUntil("the reset is answered", () => wa.after(k).some((m: any) => m.type === "error" || m.type === "world-reset"), { ms: 8000, step: 50 });
    const err = errorsAfter(wa, k).find((m: any) => /confirmation/.test(m.error ?? "")), reset = wa.after(k).some((m: any) => m.type === "world-reset"), fresh = J(logOf(WIPE)[0]) !== g0;
    row("S5", "world-reset {name: ['wipe']} (a list) fails the typed confirmation: nothing erased", { right: !!err && !reset && !fresh, wrong: !err && reset && fresh,
      saw: { err: errorsAfter(wa, k), types: wa.after(k).map((m: any) => m.type), newGenesis: fresh } }); }

  // ---- S6: history and debug paging ----
  for (const t of ["one", "two", "three"]) ok((await ann.req("say", { text: t })).ok, `setup: Ann says '${t}' (history pages chat lines)`);
  for (const [tag, msg, wrong] of [["history {limit: true}", { type: "history", limit: true }, (m: any) => m?.type === "history" && (m.entries ?? []).length === 1],
    ["history {before: 'abc'}", { type: "history", before: "abc" }, (m: any) => m?.type === "history"],
    ["debug {limit: true}", { type: "debug", limit: true }, (m: any) => m?.type === "debug"]] as const) {
    const k = ann.msgs.length, reqId = `h-${k}`; ann.raw({ ...msg, reqId });
    await tryUntil("the read is answered", () => ann.after(k).some((m: any) => m.reqId === reqId || m.type === "error"), { ms: 5000, step: 50 });
    const ans = ann.after(k).find((m: any) => m.reqId === reqId && m.type !== "error"), err = errorsAfter(ann, k)[0];
    row("S6", `${tag} is refused with an error (a page size is a whole number, a bound a number)`, { right: !!err && !ans, wrong: wrong(ans), saw: { ans: ans ? { type: ans.type, n: (ans.entries ?? ans.events ?? []).length } : null, err } }); }

  // ---- presence relays: S7, S8, S9, S10, S12 ----
  { const k = ann.msgs.length, kb = bob.msgs.length; ann.raw({ type: "anim", dur: "1", tracks: {} });
    await pause("a malformed anim has had its chance to be answered or relayed", 300);
    row("S7", "anim {dur: '1'} is answered with an error (not dropped silently)", { right: errorsAfter(ann, k).length > 0, wrong: !errorsAfter(ann, k).length && !bob.after(kb).some((m: any) => m.type === "anim"),
      saw: { ann: ann.after(k).map((m: any) => m.type), bob: bob.after(kb).map((m: any) => m.type) } }); }
  const relayed = async (sender: any, target: any, msg: any, type: string) => { const k = sender.msgs.length, kt = target.msgs.length; sender.raw(msg);
    await pause(`a malformed ${type} has had its chance to be answered or relayed`, 300);
    return { err: errorsAfter(sender, k), got: target.after(kt).filter((m: any) => m.type === type) }; };
  { const x = await relayed(ann, ann, { type: "puppet", target: "Ann", ragdoll: { lean: [null, 0, 0] } }, "puppet");
    row("S8", "puppet {ragdoll: {lean: [null, 0, 0]}} is refused with an error, nothing relayed", { right: x.err.length > 0 && !x.got.length, wrong: x.got.some((m: any) => J(m.ragdoll?.lean) === "[0,0,0]"), saw: x }); }
  { const x = await relayed(ann, ann, { type: "bodydrag", target: "Ann", yaw: "abc" }, "bodydrag");
    row("S9", "bodydrag {yaw: 'abc'} relays no yaw (or is refused)", { right: x.err.length > 0 || (x.got.length > 0 && x.got.every((m: any) => !("yaw" in m))), wrong: x.got.some((m: any) => "yaw" in m && m.yaw === null), saw: x }); }
  { const x = await relayed(ann, ann, { type: "bodydrag", target: "Ann", p: ["1", null, 0] }, "bodydrag");
    row("S9", "bodydrag {p: ['1', null, 0]} relays no p (or is refused)", { right: x.err.length > 0 || (x.got.length > 0 && x.got.every((m: any) => !("p" in m))), wrong: x.got.some((m: any) => J(m.p) === "[1,0,0]"), saw: x }); }
  for (const [tag, msg, wrong] of [["text: {a: 1}", { type: "caption", text: { a: 1 }, utt: 1 }, (m: any) => m.text === "[object Object]"], ["utt: 'x'", { type: "caption", text: "hello", utt: "x" }, (m: any) => m.utt === 0]] as const) {
    const x = await relayed(ann, bob, msg, "caption");
    row("S10", `presence caption {${tag}} is refused with an error, nothing relayed`, { right: x.err.length > 0 && !x.got.length, wrong: x.got.some(wrong), saw: x }); }
  for (const [tag, msg] of [["id: 5", { type: "drag", id: 5, pos: [1, 0, 1] }], ["pos: 'x'", { type: "drag", id: "anything", pos: "x" }]] as const) {
    const x = await relayed(ann, bob, msg, "drag");
    row("S12", `drag {${tag}} is not broadcast`, { right: !x.got.length, wrong: x.got.length > 0, saw: x }); }

  // ---- S13: server-ban (a server operator) ----
  { const opal = await client(W, "Opal", { agentToken: "tok-opal" }), mal = await client(W, "Mal"), zed = await client(W, "Zed");
    ok(opal.snapshot && mal.snapshot && zed.snapshot, "setup: Opal (a server operator), Mal and Zed are in the world");
    { const k = opal.msgs.length; opal.raw({ type: "server-ban", id: ["Mal"] });
      await tryUntil("the ban is answered", () => opal.after(k).some((m: any) => m.type === "mod" || m.type === "error"), { ms: 5000, step: 50 });
      await pause("a ban has had its chance to close Mal's socket", 200);
      const err = errorsAfter(opal, k)[0];
      row("S13", "server-ban {id: ['Mal']} (a list) is refused with an error, Mal not banned", { right: !!err && mal.closed == null, wrong: !err && mal.closed != null, saw: { opal: opal.after(k), malClosed: mal.closed } }); }
    { const k = opal.msgs.length; opal.raw({ type: "server-ban", id: "Zed", reason: { a: 1 } });
      await tryUntil("the ban is answered", () => opal.after(k).some((m: any) => m.type === "mod" || m.type === "error"), { ms: 5000, step: 50 });
      const err = errorsAfter(opal, k)[0]; const k2 = opal.msgs.length; opal.raw({ type: "server-bans" });
      await tryUntil("server-bans is answered", () => opal.after(k2).some((m: any) => m.type === "mod"), { ms: 5000, step: 50 });
      const list = opal.after(k2).find((m: any) => m.type === "mod")?.text ?? "";
      row("S13", "server-ban {reason: {a: 1}} is refused with an error, no ban filed", { right: !!err && !/Zed/.test(list), wrong: list.includes("[object Object]"), saw: { err, list: list.slice(0, 200) } }); }
    { const k = opal.msgs.length; opal.raw({ type: "operator-repair", id: "or-1", verb: "unban", args: JSON.stringify({ who: "Mal" }) });
      await tryUntil("the repair is answered", () => opal.after(k).some((m: any) => m.type === "reply" && m.id === "or-1"), { ms: 5000, step: 50 });
      const m = opal.after(k).find((m: any) => m.type === "reply" && m.id === "or-1");
      row("S1", "operator-repair {verb: 'unban', args: a string} is refused as shape (not run bare)", { right: m?.ok === false && m.reply?.refused?.code === "shape",
        wrong: m?.ok === false && m.reply?.refused?.code === "missing-arg", saw: m?.reply?.refused ?? m }); }
    opal.close(); }

  // ---- S14: join fields ----
  { const s = await client(W, "Sue", { spectate: "false" }); const sw = s.snapshot ? await s.req("say", { text: "am I a spectator?" }) : null;   // a spectator may read, not write
    row("S14", "join {spectate: 'false'} (a string) is refused with an error, not joined as a spectator", { right: !s.snapshot && errorsAfter(s, 0).length > 0,
      wrong: !!s.snapshot && sw?.refused?.code === "spectator", saw: { err: errorsAfter(s, 0), write: sw?.refused ?? sw?.ok } }); s.close(); }
  { const k = bob.msgs.length; const t = await client(W, "Tam", { avatar: "no-such-avatar-name" });
    await tryUntil("Bob sees Tam arrive", () => bob.after(k).some((m: any) => m.type === "arrive" && m.id === "Tam"), { ms: 3000, step: 50 });
    const arr = bob.after(k).find((m: any) => m.type === "arrive" && m.id === "Tam");
    row("S14", "join {avatar: 'no-such-avatar-name'} is refused with an error (not the default body)", { right: !t.snapshot && errorsAfter(t, 0).length > 0, wrong: !!t.snapshot && /claude\.vrm/.test(J(arr)), saw: { err: errorsAfter(t, 0), arrive: arr } }); t.close(); }
  { const long = "L" + "o".repeat(69), kb = bob.msgs.length; const u = await client(W, long);
    await tryUntil("Bob sees the long name arrive", () => bob.after(kb).some((m: any) => m.type === "arrive"), { ms: 3000, step: 50 });
    const arr = bob.after(kb).find((m: any) => m.type === "arrive");
    row("S14", "join {id: a 70-character name} is refused with an error (not cut to 64)", { right: !u.snapshot && errorsAfter(u, 0).length > 0, wrong: !!u.snapshot && arr?.id === long.slice(0, 64), saw: { err: errorsAfter(u, 0), arrive: arr?.id } }); u.close(); }

  // ---- S16: voice-moderate ----
  { const k = ann.msgs.length, kb = bob.msgs.length; ann.raw({ type: "voice-moderate", actorId: BOB, muted: "true" });
    await pause("a voice-moderate has had its chance to be answered", 400);
    row("S16", "voice-moderate {muted: 'true'} (a string) is refused with an error (not read as unmute)", { right: errorsAfter(ann, k).length > 0, wrong: !errorsAfter(ann, k).length && bob.after(kb).some((m: any) => m.type === "voice-moderated" && m.muted === false),
      saw: { ann: ann.after(k), bob: bob.after(kb).map((m: any) => m.type) } }); }
  { const k = ann.msgs.length, kb = bob.msgs.length, t0 = Date.now(); ann.raw({ type: "voice-moderate", actorId: BOB, muted: true, minutes: "5" });
    await tryUntil("the mute is answered", () => errorsAfter(ann, k).length || bob.after(kb).some((m: any) => m.type === "moderated"), { ms: 5000, step: 50 });
    const mod = bob.after(kb).find((m: any) => m.type === "moderated");
    row("S16", "voice-moderate {minutes: '5'} (a string) is refused with an error (not a 60-minute mute)", { right: errorsAfter(ann, k).length > 0 && !mod,
      wrong: !!mod && Math.abs((mod.until - t0) / 60000 - 60) < 2, saw: { err: errorsAfter(ann, k), mod } });
    if (mod) ann.raw({ type: "voice-moderate", actorId: BOB, muted: false }); }

  // ---- S17: an HTTP query number ----
  { ok((await ann.req("set", { id: "@world", component: "terrain", value: { kind: "noise" } })).ok, "setup: the world has terrain");
    const good = await fetch(`${H.BASE}/heightmap?world=${W}&res=65`); ok(good.status === 200, "control: GET /heightmap?res=65 answers 200", good.status);
    const bad = await fetch(`${H.BASE}/heightmap?world=${W}&res=abc`);
    row("S17", "GET /heightmap?res=abc answers 400 (a value that does not parse)", { right: bad.status === 400, wrong: bad.status === 200, saw: { status: bad.status } }); }
} finally {
  for (const c of clients) { try { c.close(); } catch {} }
  await H.cleanup(0);
}
finish();
