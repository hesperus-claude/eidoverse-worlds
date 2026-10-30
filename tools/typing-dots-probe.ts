// typing-dots-probe: an agent's typing dots, end to end, from a host's `channels/typing` through the MCPL door and the
// world to the pill a person sees in the full client.
//
//   bun tools/typing-dots-probe.ts
//
// Needs the door's sibling built (../mcpl-core-ts, imported by mcpl/net-server.ts) and a Chromium
// tools/probe-harness.mjs can find; two to three minutes on a loaded machine. World and door are children of this run,
// each proved ours by a per-run nonce (as tools/door-cap-gate-live-test.mjs). A raw MCPL host stands in for
// agent-framework (start when a turn begins and every 7 s, stop when it ends); the full client runs in Chromium in the
// same world, and a raw socket beside it logs what the world broadcasts, in order.
//
// Judged by the client's own state at each update. Method: docs/research/typing-dots-probe.md. The door's frame contract
// (latency, cadence, what ends or never starts the relay) is tools/typing-mcpl-test.ts; this keeps the page's side.
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { loadavg, tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { launchBrowser } from "./probe-harness.mjs";
import { foundWorlds } from "./harness.ts";

const ROOT = join(import.meta.dir, "..");

const freePort = () => new Promise<number>((resolve, reject) => {
  const s = createServer();
  s.once("error", reject);
  s.listen(0, "127.0.0.1", () => { const port = (s.address() as { port: number }).port; s.close(() => resolve(port)); });
});
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0;
const check = (name: string, ok: boolean, extra = "") => {
  console.log(`  ${ok ? "✓" : "✗"} ${name}${extra ? "  " + extra : ""}`);
  ok ? pass++ : fail++;
};

const load0 = loadavg()[0]!;
const NONCE = `dots${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
const WPORT = await freePort(), MPORT = await freePort();
const scratch = mkdtempSync(join(tmpdir(), "eido-dots-"));
const tokensPath = join(scratch, "tokens.json");
await Bun.write(tokensPath, JSON.stringify({ "dots-probe-token": { id: "claude", name: "Claude", world: "commons" } }));
// every child is registered before it can be lost and keeps its stderr's tail; world and door get only the runtime's
// own environment (paths, locale, Bun settings, the asset library) and no .env, so a real world's settings can't leak in
const kids: Array<{ p: ChildProcess; name: string; err: () => string }> = [];
const RUNTIME = /^(PATH|HOME|TMPDIR|LANG|LC_[A-Z_]+|TZ|BUN_[A-Z0-9_]+)$/;
const runtimeEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => RUNTIME.test(k)));
const child = (name: string, args: string[], env: Record<string, string>) => {
  const p = spawn(process.execPath, ["--no-env-file", ...args], { cwd: ROOT, env: { ...runtimeEnv, ...env }, stdio: ["ignore", "ignore", "pipe"] });
  let err = "";
  p.stderr!.on("data", (d) => { err = (err + String(d)).slice(-2000); });
  kids.push({ p, name, err: () => err.slice(-600) });
  return p;
};
process.on("exit", () => { for (const { p } of kids) { try { p.kill("SIGKILL"); } catch { /* gone */ } } });
class StaleListener extends Error {}
const awaitExit = (p: ChildProcess, ms = 5000) => new Promise<void>((resolve) => {
  // a child a signal ended has no exitCode, only a signalCode, and its exit event has already fired
  if (p.exitCode !== null || p.signalCode !== null) return resolve();
  const t = setTimeout(() => { try { p.kill("SIGKILL"); } catch { /* gone */ } }, ms);
  p.once("exit", () => { clearTimeout(t); resolve(); });
  try { p.kill("SIGTERM"); } catch { clearTimeout(t); resolve(); }
});
const waitFor = async (what: string, probe: () => Promise<boolean>, ms = 30000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { if (await probe()) return; } catch (e) { if (e instanceof StaleListener) throw e; /* not up yet */ }
    await sleep(250);
  }
  throw new Error(`timed out: ${what}`);
};

// the world's token and incarnation files are the run's too (the checkout's could reserve the agent's name); only
// EIDOVERSE_DIR passes through. Founded before it's served (tools/harness.ts foundWorlds); with TRUST_NAMES the viewer is the owner
foundWorlds(scratch, ["commons"], "viewer");
const world = child("world", ["server/server.ts"], { PORT: String(WPORT), WORLDS_DIR: scratch, OPT_DIR: join(scratch, "opt"), TRUST_NAMES: "1",
  AGENT_TOKENS_PATH: tokensPath, SKIP_OPT_SWEEP: "1", WORLD_INSTANCE_NONCE: NONCE,
  ...(process.env.EIDOVERSE_DIR ? { EIDOVERSE_DIR: process.env.EIDOVERSE_DIR } : {}) });
const door = child("door", ["mcpl/net-server.ts"], { MCPL_PORT: String(MPORT), WORLD_URL: `ws://127.0.0.1:${WPORT}/ws`,
  MCPL_TOKENS: tokensPath, MCPL_STATE: join(scratch, "mcpl-state.json"), MCPL_INSTANCE_NONCE: NONCE });
// this side's own event-loop stalls, which would delay the watcher's stamps: every heartbeat gap past 100 ms, as [end, excess]
let hbLast = Date.now();
const hb: Array<[number, number]> = [];
const heartbeat = setInterval(() => { const now = Date.now(); if (now - hbLast > 100) hb.push([now, now - hbLast - 100]); hbLast = now; }, 100);
// the stall a stamp at `b` was read in: a frame held by a stall is read within a few ms of the late tick that ends it,
// so only a stall ending within 20 ms of `b` counts
const waitedIn = (b: number) => Math.max(0, ...hb.filter(([end]) => Math.abs(b - end) <= 20).map(([, excess]) => excess));
let browser: { close(): Promise<void> } | null = null;
const pageLoads: string[] = [], pageSaid: string[] = [], pageBeforeLoad: string[] = [];
try {
  const launched = await launchBrowser();
  browser = launched.browser;
  const origin = `http://127.0.0.1:${WPORT}`;
  await waitFor("the world echoes our nonce", async () => {
    const r = await fetch(`${origin}/version`); if (!r.ok) return false;
    const b = await r.json().catch(() => null);
    if (b && !("instance" in b)) throw new StaleListener("a world answered without our nonce: another run's listener");
    return b?.instance === NONCE;
  });
  await waitFor("the door echoes our nonce", async () => {
    const r = await fetch(`http://127.0.0.1:${MPORT}/healthz`); if (!r.ok) return false;
    const b = (await r.text()).trim();
    if (b !== `ok ${NONCE}` && b.startsWith("ok")) throw new StaleListener(`a door answered without our nonce (${b.slice(0, 20)}): another run's listener`);
    return b === `ok ${NONCE}`;
  });
  console.log("  identity: the world and the door each echo this run's nonce");

  // a person in the world, in the full client
  const pg = await launched.page();
  const errs: string[] = [];
  pg.on("pageerror", (e: Error) => errs.push(e.message));
  pg.on("dialog", (d: any) => d.dismiss().catch(() => {}));
  // each load of the page, and the last of what it said, for a run that ends early
  const said = (line: string) => { pageSaid.push(`${new Date().toISOString().slice(11, 23)}Z ${line.slice(0, 300)}`); if (pageSaid.length > 60) pageSaid.shift(); };
  pg.on("framenavigated", (f: any) => {
    if (f !== pg.mainFrame()) return;
    pageLoads.push(`${new Date().toISOString().slice(11, 19)}Z ${f.url()}`);
    if (pageLoads.length > 1) { said(`(the page loaded again: ${f.url()})`); pageBeforeLoad.push(...pageSaid); }
  });
  // what the page says, less three's and the VRM loader's repeated deprecation notes
  pg.on("console", (m: any) => { const t = m.text(); if (!/^THREE\.TSL: |^createVRMAnimationClip: /.test(t)) said(t); });
  pg.on("pageerror", (e: Error) => said(`(error) ${e.message}`));
  // the sky's "off" tier (a person's setting): on a software renderer the default tier's bake can hold the page for minutes
  // and lose its GPU context, which reloads the page (client/lib/gpulost.js); the dots don't depend on the sky
  await pg.addInitScript(() => { try { localStorage.setItem("ew-cloud-quality", "off"); } catch { /* opaque origin */ } });
  await pg.goto(`${origin}/?world=commons&name=viewer`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await pg.waitForFunction(() => document.getElementById("splash")?.classList.contains("gone") && !!(globalThis as any).EW?.me?.(),
    null, { timeout: 120000 });

  // a raw socket in the same world, beside the browser: each typing frame the world broadcasts for the agent, by this
  // side's clock and in order
  type Seen = { t: number; seq: number };
  const frames: Seen[] = [];
  let seen = 0;
  const watcher = new WebSocket(`ws://127.0.0.1:${WPORT}/ws`);
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("watcher join timeout")), 10000);
    watcher.onmessage = (ev) => {
      const at = Date.now(), seq = ++seen;
      let m: any; try { m = JSON.parse(String(ev.data)); } catch { return; }
      if (m.type === "snapshot") { clearTimeout(t); res(); }
      if (m.type === "typing" && m.id === "claude") frames.push({ t: at, seq });
    };
    // replica: a world speaks only to clients that fold its log
    watcher.onopen = () => watcher.send(JSON.stringify({ type: "join", world: "commons", id: "watcher", avatar: "a.vrm", replica: true }));
  });

  // the host: an MCPL client on the door, as the agent `claude`
  const host = new WebSocket(`ws://127.0.0.1:${MPORT}/?token=dots-probe-token`);
  const responses = new Map<number, any>();
  const rpc = (obj: any) => host.send(JSON.stringify(obj));
  await new Promise<void>((res, rej) => {
    const t = setTimeout(() => rej(new Error("mcpl init timeout")), 10000);
    host.onopen = () => rpc({ jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2024-11-05", capabilities: { experimental: { mcpl: {} } }, clientInfo: { name: "dots-probe", version: "0" } } });
    host.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.id !== undefined && ("result" in m || "error" in m)) responses.set(m.id, m);
      if (m.id === 1) { rpc({ jsonrpc: "2.0", method: "notifications/initialized" }); clearTimeout(t); res(); }
    };
  });
  let nextId = 100;
  const typing = (op: "start" | "stop", channelId = "world:commons") => rpc({ jsonrpc: "2.0", method: "channels/typing", params: { channelId, op } });
  const say = (text: string) => rpc({ jsonrpc: "2.0", id: nextId++, method: "channels/publish",
    params: { channelId: "world:commons", content: [{ type: "text", text }] } });
  const walk = (x: number) => { const id = nextId++; rpc({ jsonrpc: "2.0", id, method: "tools/call", params: { name: "move", arguments: { to: [x, 0] } } }); return id; };
  // each start this side sends for this world, by its clock, read once sent; nextStart() resolves on the next one
  let onStart: (() => void) | null = null;
  const sendStart = () => { typing("start"); const at = Date.now(); onStart?.(); return at; };
  const nextStart = () => new Promise<void>((res) => { onStart = () => { onStart = null; res(); }; });

  await pg.waitForFunction(() => !!(globalThis as any).EW?.remotes?.get("claude")?.avatar?.label, null, { timeout: 90000 });
  // the page's log (see the header), in one sequence. A replaced avatar is wrapped, and a replaced socket listened to, at
  // the next look 100 ms on, so a frame in between would be logged on one side only; the receipt checks count both
  await pg.evaluate(() => {
    const g = globalThis as any;
    g.__log = { seq: 0, signals: [] as unknown[], updates: [] as unknown[], receipts: [] as unknown[], renders: [] as number[], avatars: 0, sockets: 0 };
    const wrap = (av: any) => {
      if (!av || av.__probed) return;
      av.__probed = true;
      g.__log.avatars++;
      const { setTyping, update } = av;
      // the window a signal set, read once the client set it, between the clock's readings either side of the call; a null
      // state shuts the window (resetTransients) and opens none, so it isn't a signal
      av.setTyping = function (...a: unknown[]) {
        const p0 = performance.now(), r = setTyping.apply(this, a), p1 = performance.now();
        if (a[0] !== null) g.__log.signals.push({ t: Date.now(), seq: ++g.__log.seq, p0, p1, until: this._typingUntil });
        return r;
      };
      // what an update left: the pill drawn or not, the bubble, and whether the window was open at the `now` it was given
      // (the render loop's, passed by client/lib/remotes.js)
      av.update = function (...a: unknown[]) {
        const now = typeof a[1] === "number" ? (a[1] as number) : performance.now();
        const r = update.apply(this, a);
        g.__log.updates.push({ t: Date.now(), seq: ++g.__log.seq, drawn: !!this.typing?.visible, bubble: !!this.bubble,
          win: now < this._typingUntil, hidden: !!this.ownPlateHidden });
        return r;
      };
    };
    // each typing frame the page's socket received: net.js applies it synchronously in onmessage, set at open, so this
    // listener, added later, logs it in the same task just after
    const listen = (sock: any) => sock?.addEventListener("message", (ev: MessageEvent) => {
      if (typeof ev.data !== "string" || !ev.data.includes('"typing"')) return;
      let m: any; try { m = JSON.parse(ev.data); } catch { return; }
      if (m.type === "typing" && m.id === "claude") g.__log.receipts.push({ t: Date.now(), seq: ++g.__log.seq });
    });
    // each frame the page rendered, after the client's own render loop in that frame
    const render = () => { g.__log.renders.push(++g.__log.seq); requestAnimationFrame(render); };
    requestAnimationFrame(render);
    let ws = g.EW.net.ws;
    listen(ws);
    const watch = () => { wrap(g.EW.remotes.get("claude")?.avatar); if (g.EW.net.ws !== ws) { ws = g.EW.net.ws; g.__log.sockets++; listen(ws); } };
    watch();
    setInterval(watch, 100);
  });
  type Signal = { t: number; seq: number; p0: number; p1: number; until: number };
  type Update = { t: number; seq: number; drawn: boolean; bubble: boolean; win: boolean; hidden: boolean };
  type Seq = { t: number; seq: number };
  type PageLog = { signals: Signal[]; updates: Update[]; receipts: Seq[]; renders: number[]; avatars: number; sockets: number };
  const readLog = () => pg.evaluate(() => (globalThis as any).__log) as Promise<PageLog>;
  // the signals and updates alone, for a wait that looks often: the renders run to thousands
  const readWindows = () => pg.evaluate(() => { const l = (globalThis as any).__log; return { signals: l.signals, updates: l.updates }; }) as Promise<Pick<PageLog, "signals" | "updates">>;
  // the first update after `since` for which pred holds, polled up to ms, or null: a far avatar updates only on its
  // level-of-detail ticks, seconds apart on a loaded page, and between updates its pill stays as the last one left it
  const pollPage = async (pred: (u: Update) => boolean, ms: number, since: number) => {
    const until = Date.now() + ms;
    while (Date.now() < until) {
      const us = await pg.evaluate((since: number) => (globalThis as any).__log.updates.filter((u: Update) => u.t > since), since) as Update[];
      const hit = us.find(pred);
      if (hit) return hit;
      await sleep(250);
    }
    return null;
  };
  // once the dots' last window has run out: the page's first update after the last signal applied since `from` that found
  // the window shut, so the rule below has an update to judge; the last signal is re-read each look
  const shut = async (name: string, from: number) => {
    const until = Date.now() + 25000;
    let last: Signal | undefined;
    while (Date.now() < until) {
      const log = await readWindows();
      last = log.signals.filter((s) => s.t >= from).at(-1);
      const u = last && log.updates.find((u) => u.seq > last!.seq && !u.win);
      if (u) return check(name, true, `the last signal at ${Math.round(last!.t - T0)} ms; the update at ${Math.round(u.t - T0)} ms found the window shut`);
      if (!last && Date.now() > from + 10000) break;
      await sleep(250);
    }
    check(name, false, last ? "no update after the last signal found the window shut" : "the page applied no signal to judge a window by");
  };

  // a turn as agent-framework runs it: start, again every 7 s until stop; it walks, speaks, and goes on until the dots
  // are back. The speech fills the longest bubble (avatar.js: at most 22 s), so it outlasts the host's next start
  const SAY = "Here now. I came over to see the frame you were building by the water, and to ask whether the beams on the east side are meant to meet the deck or to stop just short of it, as the drawing seems to show. If they stop short, I'd like to know how wide the gap is meant to be, and whether the rail along the edge runs on past it or ends at the last post. I can hold the far end while you measure, if that helps, and then we can walk the rest of the frame together.";
  if (2500 + SAY.length * 45 < 22000) throw new Error(`the speech is too short for a 22 s bubble: ${SAY.length} characters`);
  // a founded world's bounds are x and z -20…20 (shared/protocol/authority/verbs.js, create-world), so the 30 m walk runs
  // from x = -15 to x = 15, and the agent goes to its start first
  const toStart = walk(-15);
  await waitFor("the walk to the turn's start", async () => responses.has(toStart), 60000);
  const T0 = Date.now();
  sendStart();
  const refresher = setInterval(sendStart, 7000);
  await sleep(9000);
  const walkId = walk(15);   // a walk the door answers on arrival, about 19 s on
  await sleep(15000);
  // the door reads one request at a time (mcpl/net-server.ts), so the speech waits for the walk's reply and goes 300 ms
  // after a start
  await waitFor("the walk's reply", async () => responses.has(walkId), 30000).catch(() => {});
  const walkReply = responses.get(walkId);
  await nextStart(); await sleep(300);
  say(SAY); const sayAt = Date.now();
  // the bubble's waits allow the avatar's updates to come 30 s apart, past the bubble's 22 s
  const bubbleShown = await pollPage((u) => u.bubble, 30000, sayAt);
  const bubbleGone = bubbleShown && await pollPage((u) => !u.bubble, 22000 + 30000, bubbleShown.t);
  // the turn's starts keep the window open, so the update the bubble went at draws the dots already
  const backUp = bubbleGone && await pollPage((u) => u.drawn, 30000, bubbleGone.t - 1);
  await sleep(2000);
  // the stop goes 300 ms after a start too, so a relay that ignored it would go on signalling for about 10 s
  await nextStart(); await sleep(300);
  clearInterval(refresher);
  typing("stop"); const stopAt = Date.now();
  await shut("after the host's stop, the page's window runs out", T0);

  // another channel's typing raises no dots here, and starts for this world after it do
  typing("start", "world:elsewhere"); const otherAt = Date.now();
  await pollPage(() => true, 25000, otherAt + 1000);
  const ctlAt = sendStart();
  // every 7 s, as a turn sends them, until the page draws the dots: one start keeps the relay signalling ~10 s, and a
  // loaded page can update the agent's avatar further apart than that
  const ctlRefresher = setInterval(sendStart, 7000);
  const ctl = await pollPage((u) => u.drawn, 25000, ctlAt);
  clearInterval(ctlRefresher);
  typing("stop"); const ctlStopAt = Date.now();
  await shut("…and after its stop, the window runs out again", ctlAt);

  // the host disconnects mid-walk, no stop, 300 ms after a start: the door's relay ends with the connection and the dots
  // go with their window; a relay that outlived it would signal ~10 s more, until its own overdue stop
  walk(0);
  await sleep(1500);
  const goneFrom = sendStart();
  await sleep(300);
  host.close(); const closeAt = Date.now();
  // its start opened one 4 s window: a page updating further apart may never draw the dots in it (the machine's pace, not
  // a defect); receipt is the receipt checks', and drawing nothing once shut is the update rule's
  await shut("once it disconnects, the page's window runs out", goneFrom);
  // long enough after the close for a relay that outlived it to have signalled twice
  await sleep(Math.max(0, closeAt + 6000 - Date.now()));
  const log = await readLog();
  const U = log.updates, S = log.signals;

  const late = (f: Seen, from: number) => f.t - waitedIn(f.t) - from;
  // at the world, by this side's clock: after a stop or the close, nothing more until the next start for this world,
  // but a frame already on its way
  const quiet = (name: string, from: number, to: number) => {
    const after = frames.filter((f) => f.t > from && f.t < to && late(f, from) > 500);
    check(name, after.length === 0, after.length ? `at ${after.map((f) => `${f.t - from} ms (${waitedIn(f.t)} ms of it a stall)`).join(", ")} after it` : "");
  };
  quiet("after the host's stop, the world sends no typing frame later than 500 ms on, less the stall it waited in", stopAt, otherAt);
  check("…and a start for this world then draws the dots", ctl !== null, ctl === null ? "" : `drawn ${Math.round(ctl.t - ctlAt)} ms after it`);
  quiet("…and after its stop, again no typing frame later than 500 ms on", ctlStopAt, goneFrom);
  quiet("once the host disconnects, the world sends no typing frame later than 500 ms on, less the stall it waited in", closeAt, Infinity);

  // the page, by the client's own state
  const wrong = U.filter((u) => u.drawn !== (u.win && !u.bubble));
  const w0 = wrong[0];
  check("every update of the agent's avatar draws the pill exactly when its window is open and no bubble shows", U.length > 0 && wrong.length === 0,
    `${U.length - wrong.length}/${U.length} updates${w0 ? `; the first that didn't, at ${Math.round(w0.t - T0)} ms: ${w0.drawn ? "drawn" : "not drawn"}, window ${w0.win ? "open" : "shut"}, ${w0.bubble ? "a bubble" : "no bubble"}${w0.hidden ? ", its plate hidden" : ""}` : ""}`);
  const misset = S.filter((s) => !(s.until >= s.p0 + 4000 - 1e-6 && s.until <= s.p1 + 4000 + 1e-6));
  check("each signal opens a window that runs out 4 s after it", S.length > 0 && misset.length === 0,
    misset.length ? `${misset.length} of ${S.length}; the first ran ${Math.round(misset[0]!.until - misset[0]!.p0)} ms` : `${S.length} signals`);
  // the page's socket received each typing frame the world sent, and the client applied each in its turn: after the page
  // received the one before, and before the page rendered again; renders are in sequence order
  const R = log.receipts;
  check("the page's socket received each typing frame the world sent", R.length === frames.length,
    `${frames.length} frames, ${R.length} received; its socket replaced ${log.sockets} times`);
  const turns = R.map((r, i) => {
    const s = S[i], next = log.renders.find((seq) => seq > r.seq);
    return { r, s, inTurn: !!s && s.seq > (i ? R[i - 1]!.seq : 0) && next !== undefined && s.seq < next };
  });
  const outOfTurn = turns.filter((x) => !x.inTurn), o0 = outOfTurn[0];
  check("the client applied each typing frame its page received after the one before it, and before the page rendered again",
    R.length > 0 && S.length === R.length && outOfTurn.length === 0,
    `${R.length} received, ${S.length} applied${o0 ? `; ${outOfTurn.length} out of turn, the first received at ${Math.round(o0.r.t - T0)} ms and ${o0.s ? `applied ${o0.s.t - o0.r.t} ms from it` : "never applied"}` : ""}; the agent's avatar wrapped ${log.avatars} times`);

  // what the turn showed
  const bubbled = U.filter((u) => u.bubble && u.t >= sayAt);
  check("the speech shows as a bubble", !!bubbleShown);
  check("…a typing window opened while it showed, so the bubble rule was in play", bubbled.some((u) => u.win),
    `${bubbled.filter((u) => u.win).length} of ${bubbled.length} updates with the bubble had a window open`);
  check("…and the bubble goes", !!bubbleGone);
  const lastBubble = bubbled.at(-1)?.t ?? null;
  const backAt = lastBubble === null ? null : U.find((u) => u.t > lastBubble && u.drawn)?.t ?? null;
  check("after the bubble, the turn goes on and the dots are drawn again before the host's stop", !!backUp && backAt !== null && backAt < stopAt,
    `bubble last seen at ${lastBubble === null ? "-" : Math.round(lastBubble - T0)} ms, drawn again at ${backAt === null ? "-" : Math.round(backAt - T0)} ms, stop at ${stopAt - T0} ms`);
  const arrived = /^arrived at \((-?\d+(?:\.\d+)?), (-?\d+(?:\.\d+)?)\)/.exec(walkReply?.result?.content?.[0]?.text ?? "");
  check("the turn's walk arrived within 0.5 m of where it was sent, x = 15", !!arrived && !walkReply.result.isError && Math.hypot(Number(arrived[1]) - 15, Number(arrived[2])) <= 0.5,
    JSON.stringify(walkReply ?? null).slice(0, 160));

  check("the page threw nothing", errs.length === 0, errs.slice(0, 3).join(" | "));
  const long = hb.filter(([, excess]) => excess > 250);
  // how often the update rule had a decision of the client's to judge
  const gaps = U.slice(1).map((u, i) => u.t - U[i]!.t).sort((a, b) => a - b);
  console.log(`  the page rendered ${log.renders.length} frames and updated the agent's avatar ${U.length} times, a median ${gaps[gaps.length >> 1] ?? "-"} ms and at most ${gaps.at(-1) ?? "-"} ms apart; this side's heartbeat ran late ${long.length} times by over 250 ms, the most by ${Math.max(0, ...hb.map(([, excess]) => excess))} ms; the machine's load average was ${load0.toFixed(1)} at the start and ${loadavg()[0]!.toFixed(1)} at the end`);
} catch (e) {
  fail++;
  console.log(`FATAL ${(e as Error).message}\n${(e as Error).stack}`);
  console.log(`--- the page loaded ${pageLoads.length} time(s):\n${pageLoads.join("\n")}`);
  if (pageBeforeLoad.length) console.log(`--- what it said up to its next load:\n${pageBeforeLoad.join("\n")}`);
  console.log(`--- what it said last:\n${pageSaid.join("\n")}`);
} finally {
  clearInterval(heartbeat);
  await browser?.close().catch(() => {});
  await Promise.all([awaitExit(door), awaitExit(world)]);
  rmSync(scratch, { recursive: true, force: true });
}
// a failed run shows what the world and the door said last
if (fail) for (const { name, err } of kids) if (err().trim()) console.log(`--- the ${name}'s stderr, last lines:\n${err()}`);
console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
