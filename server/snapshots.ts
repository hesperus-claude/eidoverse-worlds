// Ephemeral screenshot broker. No fold, disk, credentials, or camera control.
import { randomUUID } from "node:crypto";
import type { Client, World } from "./world.ts";
import { doorOf } from "./access.ts";
import { LIMITS } from "./limits.ts";

export type CaptureCapability = { version: 1; engine: "unreal"; scene: "underwater-prototype" | "world-projection" };
export function captureCapability(value: unknown): CaptureCapability | undefined {
  const v = value as Partial<CaptureCapability> | null;
  return v?.version === 1 && v.engine === "unreal" && (v.scene === "underwater-prototype" || v.scene === "world-projection")
    ? { version: 1, engine: "unreal", scene: v.scene } : undefined;
}
// `retryAfter` (seconds, sent as Retry-After) only on a failure asking again soon can fix; the MCPL tool retries only
// then, so a refusal that won't change in seconds is answered at once.
type Result = { ok: true; png: Uint8Array; engine: string; scene: string }
  | { ok: false; err: string; status: number; retryAfter?: number };
type Pending = { renderer: Client; target: Client; world: World; gen?: number;
  finish: (r: Result) => void; engine: string; scene: string };
const PREFIX = "data:image/png;base64,";
// base64 in one ws message, which closes the socket past LIMITS.WS_MESSAGE_BYTES (4 MiB here was 5.6 MB on the wire)
const MAX_PNG = Math.floor((LIMITS.WS_MESSAGE_BYTES - 64 * 1024) / 4) * 3;

// Validates the container of untrusted client bytes; not a decoder, nor proof the renderer depicted the right scene.
export function pngFromDataURL(value: unknown): Buffer | null {
  if (typeof value !== "string" || !value.startsWith(PREFIX) || value.length > PREFIX.length + Math.ceil(MAX_PNG / 3) * 4) return null;
  const b64 = value.slice(PREFIX.length);
  if (!b64.length || b64.length % 4 || !/^[A-Za-z0-9+/]*={0,2}$/.test(b64)) return null;
  const png = Buffer.from(b64, "base64");
  if (png.length > MAX_PNG || png.length < 45 || !png.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))) return null;
  let at = 8, data = false;
  while (at + 12 <= png.length) {
    const len = png.readUInt32BE(at), type = png.toString("ascii", at + 4, at + 8);
    if (len > png.length - at - 12) return null;
    if (at === 8) {
      if (type !== "IHDR" || len !== 13) return null;
      const w = png.readUInt32BE(at + 8), h = png.readUInt32BE(at + 12);
      if (!w || !h || w > 4096 || h > 4096 || w * h > 8_388_608) return null;
    } else if (type === "IHDR") return null;
    if (type === "IDAT") data = true;
    at += len + 12;
    if (type === "IEND") return len === 0 && data && at === png.length ? png : null;
  }
  return null;
}

// ROAMING RENDERERS (`roam`): a snapshot of an unserved world sends an idle roamer there (`renderer-travel`); it stays
// until another world needs it. One deadline (`budgetMs`, under a host's 60 s per call) covers journey, wait and frame.
export function createSnapshotBroker({ timeoutMs = 12_000, cooldownMs = 2000, maxPending = 16, now = () => performance.now(),   // intervals only: monotonic
  travelMs = 25_000, arrivalTimeoutMs = 40_000, pollMs = 200, recentMs = 5 * 60_000,
  queueMs = 20_000, maxQueued = 16, maxQueuedTotal = 64, budgetMs = 55_000, settleMarginMs = 2_000, pinnedGraceMs = 120_000, sweepAfterMs = 30_000,
  sweepBackoffMs = 15_000, sweepBackoffMaxMs = 10 * 60_000,
  /** Tests inject their own to decide who looks first. */
  pollSleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms)),
  allClients = (() => []) as () => Iterable<Client>,
  admits = (() => true) as (world: World, c: Client) => boolean,
  log = (line: string) => console.log(line), dropLogMs = 10_000 } = {}) {
  const pending = new Map<string, Pending>();
  // ids and error text are client text: bound and escape them, or a peer could print its own "log lines"
  const quote = (v: unknown, n: number = LIMITS.ID_LEN) => typeof v === "string" ? JSON.stringify(v.slice(0, n)) : "(invalid id)";
  const who = (c: Client) => quote(c.id);
  // any connection can cause a drop for free: each logs at most once per dropLogMs, never at message rate
  const dropLogged = new WeakMap<Client, { at: number; unlogged: number }>();
  function logDrop(c: Client, line: string) {
    const t = now(), d = dropLogged.get(c);
    if (d && t - d.at < dropLogMs) { d.unlogged++; return; }
    log(d?.unlogged ? `${line} (and ${d.unlogged} more from this connection dropped unlogged since its last line)` : line);
    dropLogged.set(c, { at: t, unlogged: 0 });
  }
  const last = new WeakMap<Client, number>();
  const travelling = new Map<string, { at: number; arrived: Promise<boolean> }>();   // world → summons in flight
  const sent = new WeakMap<Client, { at: number; to: string }>();
  const pinnedSeen = new Map<string, number>();   // world → when its own (non-roamer) renderer was last seen
  // a roamer sent and never arrived is backed off: sweeps and pre-warms skip it, an ask takes it only as a last resort;
  // it clears the moment it arrives anywhere
  const roamerFailed = new WeakMap<Client, { until: number; count: number }>();
  const backedOff = (c: Client) => (roamerFailed.get(c)?.until ?? -Infinity) > now();
  // FIFO per world and renderer kind, and bounded (each waiter holds an HTTP request)
  const waiting: { world: World; engine: string; seq: number }[] = [];
  /** auto takes any; browser and unreal their own. The one place this is decided. */
  const eligible = (c: Client, engine: string) => engine === "auto" || (c.capture?.engine ?? "browser") === engine;
  // last (re)join per client (noteJoin): a ROAMER inside the arrival window may still be loading, whoever sent it
  const joinedAt = new WeakMap<Client, number>();
  // pinned only when believable: the renderers' credential, or a valid frame delivered. The flag alone is any client's claim
  const proven = new WeakSet<Client>();
  const pinned = (c: Client) => !!c.renderer && !c.roam && (!!c.trustedRenderer || proven.has(c));
  const noRenderer = (world: World, engine: string) =>
    `no ${engine === "auto" ? "" : engine + " "}renderer is currently serving world "${world.name}"`;
  let waitSeq = 0;
  const startedAt = now();
  const sleep = (ms: number) => new Promise<void>((res) => setTimeout(res, ms));
  const maxWait = () => travelMs + Math.max(arrivalTimeoutMs, timeoutMs);
  const asked = new Map<string, number>();   // world → last ask (roamer rotation)
  const active = (c: Client, w: World) => c.world === w && w.clients.has(c) && !c.superseded
    && (c.ws.readyState == null || c.ws.readyState === 1);
  function retire(c: Client, leaving = true) {
    // its grace starts now, not at the next sweep, which must not send a roamer while the renderer comes back
    if (leaving && pinned(c) && c.world) pinnedSeen.set(c.world.name, now());
    for (const [id, p] of pending) if (p.renderer === c || p.target === c) {
      log(`[snap] ${id}: ${p.renderer === c ? "renderer" : "followed body"} ${who(c)} disconnected or changed session — 503`);
      p.finish({ ok: false, err: "screenshot participant disconnected or changed session", status: 503,
        ...(p.renderer === c ? { retryAfter: 2 } : {}) });
    }
  }
  function configure(c: Client, value: unknown) {
    retire(c, false);   // ends its pending shots; not a renderer leaving its world
    c.capture = (c.surface ?? "world") === "world" ? captureCapability(value) : undefined;
  }
  function request(world: World, follow: string, view = "first", engine = "auto",
    frame: { dist?: number; height?: number; pitch?: number } = {}, at?: string, callerBudgetMs?: number, signal?: AbortSignal): Promise<Result> {
    const fail = (err: string, status: number) => Promise.resolve<Result>({ ok: false, err, status });
    if (!["auto", "unreal", "browser"].includes(engine)) return fail("renderer must be auto, unreal, or browser", 400);
    const target = [...world.clients].find(c => c.id === follow && !c.spectator && active(c, world));
    if (!target) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    asked.set(world.name, now());
    // never past maxWaitMs; a caller's ?budget= caps it, so a retry never outlasts its call
    const ownDeadline = now() + Math.min(maxWait(), Math.max(budgetMs, timeoutMs + 2 * settleMarginMs));
    const deadline = typeof callerBudgetMs === "number" && Number.isFinite(callerBudgetMs) && callerBudgetMs > 0
      ? Math.min(ownDeadline, now() + callerBudgetMs - 500) : ownDeadline;
    if (!candidatesIn(world, engine).length) {
      // roamers are browsers: an Unreal-only request is not summoned
      if (engine === "unreal") return fail(noRenderer(world, "unreal"), 503);
      // too little time for journey + frame: told a roamer is on its way and when to ask again, not held for nothing
      const late = Symbol("late");
      const journey = Math.max(0, deadline - now() - Math.min(timeoutMs, 3_000));
      let lateTimer: ReturnType<typeof setTimeout> | undefined;
      const tooLate = new Promise<typeof late>((res) => { lateTimer = setTimeout(() => res(late), journey); });
      return Promise.race([summon(world, "ask"), tooLate]).finally(() => clearTimeout(lateTimer)).then((arrived): Promise<Result> | Result => arrived === late
        ? { ok: false, err: `no renderer is serving world "${world.name}" yet; a roaming renderer is on its way, so ask again in a few seconds`, status: 503, retryAfter: 2 }
        : arrived
        ? dispatch(world, follow, view, engine, frame, target, Math.max(arrivalTimeoutMs, timeoutMs), at, deadline, signal)
        : { ok: false as const, err: doorOf(world) === "invite-only"
            ? `"${world.name}" is members-only and no roaming renderer holding the renderers' credential is free, so no snapshot can be taken there now`
            : `${noRenderer(world, "auto")}, and no roaming renderer could come`, status: 503 });
    }
    return dispatch(world, follow, view, engine, frame, target, timeoutMs, at, deadline, signal);
  }
  const candidatesIn = (world: World, engine: string) => [...world.clients].filter(c => active(c, world) && (c.renderer || c.capture)
    && eligible(c, engine))
    .sort((a, b) => Number(!!b.capture) - Number(!!a.capture));
  /** 0 parked (no agent), 1 agents but no recent ask, 2 in use; rotation takes the least, then the longest idle.
   *  An agent is tokenVerified (its credential, never a declaration, §6a). */
  const need = (c: Client) => {
    const w = c.world!;
    if (![...w.clients].some(o => o.tokenVerified && !o.spectator && active(o, w))) return 0;
    // a world with its own pinned renderer doesn't need a roamer too: one there counts as parked
    if ([...w.clients].some(o => o !== c && pinned(o) && active(o, w))) return 0;
    return now() - (asked.get(w.name) ?? -Infinity) >= recentMs ? 1 : 2;
  };
  /** One summons per world at a time, never a busy or travelling roamer. An in-use roamer goes only for an ask with no
   *  freer one; a sweep takes only a PARKED roamer. */
  function summon(world: World, mode: "ask" | "prewarm" | "sweep"): Promise<boolean> { return startSummon(world, mode).arrived; }
  /** summon(), saying which roamer it sent, if any. */
  function startSummon(world: World, mode: "ask" | "prewarm" | "sweep"): { sent: Client | null; arrived: Promise<boolean> } {
    const nothing = { sent: null, arrived: Promise.resolve(false) };
    const inFlight = travelling.get(world.name);
    if (inFlight && now() - inFlight.at < travelMs) return { sent: null, arrived: inFlight.arrived };
    const busy = new Set([...pending.values()].map(p => p.renderer));
    const enRoute = new Set([...travelling.keys()]);
    // …and only one the destination admits (server/access.ts): a refused renderer stops dead until its watchdog restarts it
    // a sent roamer not yet arrived is on its way, whatever world it still shows
    const onItsWay = (c: Client) => { const s = sent.get(c); return !!s && now() - s.at < travelMs && c.world?.name !== s.to; };
    const roamers = [...allClients()].filter(c => c.roam && c.renderer && c.world && active(c, c.world)
      && c.world !== world && !busy.has(c) && !enRoute.has(c.world.name) && !onItsWay(c) && admits(world, c))
      .map(c => ({ c, n: need(c), off: backedOff(c) }))
      .filter(r => mode === "ask" || (!r.off && (mode === "prewarm" ? r.n !== 2 : r.n === 0)))
      .sort((a, b) => Number(a.off) - Number(b.off) || a.n - b.n || (last.get(a.c) ?? 0) - (last.get(b.c) ?? 0))
      .map(r => r.c);
    const roamer = roamers[0];
    if (!roamer) return nothing;
    try { roamer.ws.send(JSON.stringify({ type: "renderer-travel", world: world.name })); }
    catch { return nothing; }
    const at = now();
    sent.set(roamer, { at, to: world.name });
    const arrived = new Promise<boolean>((resolve) => {
      const tick = () => {
        if (candidatesIn(world, "auto").length) {
          travelling.delete(world.name);
          if (roamer.world === world) roamerFailed.delete(roamer);
          return resolve(true);
        }
        if (now() - at >= travelMs) {
          travelling.delete(world.name);
          if (roamer.world !== world) {                              // it never came: back IT off, not the world
            const count = (roamerFailed.get(roamer)?.count ?? 0) + 1;
            const wait = Math.min(sweepBackoffMs * 2 ** (count - 1), sweepBackoffMaxMs);
            roamerFailed.set(roamer, { until: now() + wait, count });
            log(`[snap] roamer ${who(roamer)} did not arrive in "${world.name}" within ${travelMs / 1000}s — it is sent nowhere for ${Math.round(wait / 1000)}s unless no other roamer can go`);
          }
          return resolve(false);
        }
        setTimeout(tick, pollMs);
      };
      setTimeout(tick, pollMs);
    });
    travelling.set(world.name, { at, arrived });
    return { sent: roamer, arrived };
  }
  async function dispatch(world: World, follow: string, view: string, engine: string,
    frame: { dist?: number; height?: number; pitch?: number }, target: Client, waitMs: number, at?: string,
    deadline = now() + waitMs, signal?: AbortSignal): Promise<Result> {
    // an aborted asker leaves the queue: it neither holds back younger asks nor ties up a renderer
    const goneAway = (): Result => ({ ok: false, err: "the asker went away", status: 499 });
    if (signal?.aborted) return goneAway();
    const fail = (err: string, status: number): Result => ({ ok: false, err, status });
    // leaves to an OLDER waiter any renderer it could use (FIFO per renderer); an Unreal-only waiter never blocks a
    // browser ask for a renderer it could not use
    const free = (olderThan: number) => pending.size >= maxPending ? undefined : candidatesIn(world, engine).find(c => now() - (last.get(c) ?? -Infinity) >= cooldownMs
      && ![...pending.values()].some(p => p.renderer === c) && (c.ws.getBufferedAmount?.() ?? 0) < 256_000
      && !waiting.some(t => t.world === world && t.seq < olderThan && eligible(c, t.engine)));
    // a busy renderer is waited for (queueMs, never past the deadline), up to maxQueued; then "busy" at once
    const busy = (): Result => ({ ok: false, err: "renderers busy; retry in a few seconds", status: 429, retryAfter: 2 });
    if (!active(target, world)) return fail(`"${follow}" is not present in "${world.name}"`, 404);
    // a renderer here and gone again (roamer taken, pinned one restarting): retryable, unlike "no renderer and no roamer"
    const gone = (): Result => ({ ok: false, err: noRenderer(world, engine), status: 503, retryAfter: 2 });
    if (!candidatesIn(world, engine).length) return gone();
    let renderer = free(Infinity);
    if (!renderer) {
      // per world, so a burst in one never makes another world's first ask "busy"
      if (waiting.filter((t) => t.world === world).length >= maxQueued || waiting.length >= maxQueuedTotal) return busy();
      const ticket = { world, engine, seq: ++waitSeq };
      waiting.push(ticket);
      const queueUntil = Math.min(now() + queueMs, deadline - Math.min(timeoutMs, 3_000));
      try {
        for (;;) {
          if (now() >= queueUntil) return busy();
          await pollSleep(pollMs);
          if (signal?.aborted) return goneAway();
          if (!active(target, world)) return fail(`"${follow}" is not present in "${world.name}"`, 404);
          if (!candidatesIn(world, engine).length) return gone();
          if ((renderer = free(ticket.seq))) break;
        }
      } finally { waiting.splice(waiting.indexOf(ticket), 1); }
    }
    const chosen = renderer!;
    // a just-arrived roamer gets the arrival window; a pinned renderer keeps SNAP_TIMEOUT_SEC even after a restart
    if (chosen.roam && now() - (joinedAt.get(chosen) ?? -Infinity) < arrivalTimeoutMs) waitMs = Math.max(waitMs, arrivalTimeoutMs);
    waitMs = Math.max(1, Math.min(waitMs, deadline - now()));
    if (!["first", "third", "selfie"].includes(view)) view = "first";
    const id = `capture-${randomUUID()}`;
    last.set(chosen, now());
    return new Promise(resolve => {
      const renderer = chosen;
      const timer = setTimeout(() => {
        log(`[snap] ${id} follow=${quote(follow)} view=${view}: no frame from ${who(renderer)} in ${waitMs / 1000}s ` +
          `(renderer ws buffered=${renderer.ws.getBufferedAmount?.() ?? "?"}) — 504`);
        p.finish({ ok: false, err: "renderer timed out", status: 504, retryAfter: 2 });
      }, waitMs);
      const p: Pending = { renderer, target, world, gen: renderer.gen,
        engine: renderer.capture?.engine ?? "browser", scene: renderer.capture?.scene ?? "world-fold",
        finish(r) { if (!pending.delete(id)) return; clearTimeout(timer); resolve(r); } };
      pending.set(id, p);
      // docs/WIRE.md (`capture` → `capture-result`). `wait`: load budget (net_capture.js settle), the frame's window
      // less a margin for capture and send
      try { renderer.ws.send(JSON.stringify({ type: "capture", id, follow, view, width: 960, height: 540,
        wait: Math.max(0, waitMs - settleMarginMs),
        ...(Object.keys(frame).length ? { frame } : {}), ...(at ? { at } : {}) })); }
      catch { log(`[snap] ${id}: send to renderer ${who(renderer)} failed — 503`); p.finish({ ok: false, err: "renderer unavailable", status: 503, retryAfter: 2 }); }
    });
  }
  function receive(c: Client, msg: { id?: unknown; dataUrl?: unknown; error?: unknown }) {
    // every drop goes through logDrop; the 503/502 lines below are at most one per dispatched snap
    if (!(c.renderer || c.capture)) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)}, which is not a renderer — dropped`);
    const p = typeof msg.id === "string" ? pending.get(msg.id) : undefined;
    if (!p) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)} for an expired or unknown snap — dropped`);
    const stale = p.renderer !== c ? `it was sent to ${who(p.renderer)}` : p.gen !== c.gen ? "its session changed"
      : !active(c, p.world) ? `it is no longer in "${p.world.name}"` : !active(p.target, p.world) ? "the followed body left" : "";
    if (stale) return logDrop(c, `[snap] ${quote(msg.id)}: reply from ${who(c)} dropped — ${stale}`);
    // a renderer's own refusal reaches the asker in its words, never as a generic "invalid image"
    if (typeof msg.error === "string" && msg.error.trim()) {
      const err = msg.error.trim().slice(0, 300);
      log(`[snap] ${msg.id}: renderer ${who(c)} replied without an image: ${quote(err, 200)} — 503`);
      // retryable only for "still loading" (client/lib/net_capture.js); any other refusal would fail the same way again
      return p.finish({ ok: false, err, status: 503, ...(/still loading/i.test(err) ? { retryAfter: 2 } : {}) });
    }
    const png = pngFromDataURL(msg.dataUrl);
    if (!png) log(`[snap] ${msg.id}: renderer ${who(c)} sent no valid PNG (${typeof msg.dataUrl === "string" ? `${msg.dataUrl.length} chars` : typeof msg.dataUrl}) — 502`);
    if (png) proven.add(c);
    p.finish(png ? { ok: true, png, engine: p.engine, scene: p.scene }
      : { ok: false, err: "renderer could not supply a valid image", status: 502 });
  }
  /** PRE-WARM on an agent's arrival: send a roamer now, so the world is loaded by the first ask. Idempotent per world. */
  function prewarm(world: World) {
    if (!candidatesIn(world, "auto").length) void summon(world, "prewarm");
  }
  /** SWEEP: every world with an agent and no renderer gets a PARKED roamer; covers what pre-warm doesn't. On a roamer
   *  join and a timer; surplus worlds wait for an ask. */
  function sweep() {
    const worlds = new Set<World>();
    for (const c of allClients()) {
      if (!c.world || !active(c, c.world)) continue;
      if (c.tokenVerified && !c.spectator) worlds.add(c.world);   // its enrolment, never a declaration (§6a)
      if (pinned(c)) pinnedSeen.set(c.world.name, now());
    }
    // just after a start, renderers are still reconnecting
    if (now() - startedAt < sweepAfterMs) return;
    // a world whose own renderer was here moments ago is waiting for its restart; an ask meanwhile is still served
    for (const w of worlds) {
      if (candidatesIn(w, "auto").length) continue;
      if (now() - (pinnedSeen.get(w.name) ?? -Infinity) < pinnedGraceMs) continue;
      // a never-arriving roamer is backed off (startSummon), so a broken one can't make every world wait in turn
      void startSummon(w, "sweep");
    }
  }
  /** tests pass their own */
  function setClients(fn: () => Iterable<Client>) { allClients = fn; }
  /** Injected (server.ts: access.ts entryFor, mode "watch"), so the broker's unit test never depends on a machine's bans. Unwired = admits all. */
  function setAdmission(fn: (world: World, c: Client) => boolean) { admits = fn; }
  /** config.ts SNAP_TIMEOUT_SEC, injected: this module never loads server config. */
  function setFrameTimeout(ms: number) { timeoutMs = ms; }
  /** Called at every join, travel included. */
  function noteJoin(c: Client) { joinedAt.set(c, now()); }
  /** config.ts SNAP_SWEEP_GRACE_SEC, injected the same way. */
  function setSweepGrace(ms: number) { sweepAfterMs = ms; }
  return { request, receive, retire, configure, noteJoin, setClients, setAdmission, setFrameTimeout, setSweepGrace, prewarm, sweep,
    get pendingCount() { return pending.size; },
    /** Journey plus first frame; GET /snap sizes its HTTP timeout from this. */
    get maxWaitMs() { return maxWait(); } };
}
export const snapshots = createSnapshotBroker();
