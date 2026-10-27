// The ws message table (survey §2.2): one handler per message type, bodies moved VERBATIM from server.ts. Never
// imports server.ts (the §15 verbs.ts cycle break): `expel` arrives through the ctx. The per-message preamble and `join`
// stay in server.ts, where the source-text gates pinning settledPose expect them.
// tools/voice-wiring-test.ts regexes THIS file's source: moving a body means moving its patterns with it.

import { WORLDS_DIR, FRAME_SKIP_BUFFERED } from "./config.ts";
import { LIMITS } from "./limits.ts";
import { sanePose } from "./posecheck.ts";
import { gateReach } from "./reachgate.ts";
import { BODY_RANGE } from "../shared/protocol/physconst.js";
import { currentIncarnation } from "./transport.ts";
import { isOperator } from "./operators.ts";
import { directoryFor, foldName } from "./directory.ts";
import { actorOf as actorIdOf } from "./requestwire.ts";
import { qNorm } from "../shared/rot.js";
import { decide as consentDecide, refusalWords } from "../shared/protocol/consent.js";
import { worlds, type World, type Client, authorityNow } from "./world.ts";
import { stateSampleError } from "../shared/presencewire.js";
import { snapshots } from "./snapshots.ts";
import { REMOVED_VERBS } from "../shared/protocol/verbspec.js";
import { globalBans, saveGlobalBans, banKey, ADDR_BAN_MS, bansLiftedBy } from "./moderation.ts";
import { isOwner } from "../shared/protocol/roles.js";

/** An opaque actor id (`targetActor` / `toActor`) names that identity's embodied leg, and the name beside it is NOT a
 *  fallback (it would hand the message to whoever wears the name). Without one it reaches by name: names are unique
 *  among the people here and, for accounts, across the directory (server.ts join); none is shaped like an actor id. */
const ACTOR_ID = /^u-[a-z2-7]{20}$/;

/** Body consent (PROTOCOL L6): an act on someone else's body is checked against THEIR table (shared/protocol/consent.js
 *  decide: their answer for this person, else their switch, else the world's body-default, else accept) and a sane range
 *  BEFORE forwarding, so a stranger's packet never reaches a body that said no. 'ask' is refused with how to ask.
 *  Refusal or null. */
export { BODY_RANGE };   // m between the two bodies' last frames
function bodyRefusal(c: Client, tc: Client, cls: "shove" | "pose" | "displace", kind: string): string | null {
  if (c.actorId && c.actorId === tc.actorId) return null;            // your own body
  const live = c.world?.log?.live;
  if (!live || !c.actorId || !tc.actorId) return `${tc.id}'s body isn't taking ${cls} right now`;
  // range before consent, so someone out of reach can't learn the target's switch (the door does the same)
  const a = c.lastPose?.p, b = tc.lastPose?.p, r = BODY_RANGE[cls];
  if (!Array.isArray(a) || !Array.isArray(b)) return `can't tell where you and ${tc.id} are yet — try again in a moment`;
  const m = Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  if (!(m <= r)) return `${tc.id} is ${m.toFixed(1)} m away (${cls} reaches ${r} m) — get closer`;
  const d = consentDecide(live.presence, c.actorId, tc.actorId, cls, live.now());
  if (d.mode === "deny") return refusalWords(tc.id, cls);   // one sentence whatever the cause: the real cause is theirs, not yours
  if (d.mode === "ask") return `${tc.id} asks first for ${cls}: ask with the body request — body {to: "${tc.actorId}", kind: "${kind}"}`;
  return null;
}
function presenceTarget(w: World, actor: unknown, name: string, embodied = true): { tc: Client | null; byActor: boolean; actor: string | null } {
  const leg = (o: Client) => !o.spectator && (!embodied || (o.surface ?? "world") === "world");
  if (typeof actor === "string" && ACTOR_ID.test(actor)) return { tc: [...w.clients].find((o) => o.actorId === actor && leg(o)) ?? null, byActor: true, actor };
  return { tc: name ? [...w.clients].find((o) => o.id === name && leg(o)) ?? null : null, byActor: false, actor: null };
}

export type MsgCtx = {
  c: Client;
  ws: { send(data: string): void; close?(code?: number, reason?: string): void };
  now: number;
  expel: (w: World, target: Client, why: string) => void;
};

/** 1..PAGE_MAX, else the default: NaN or 1.5 never equals a page's length, so readHistory's ceiling would never stop it. */
export const pageLimit = (v: unknown): number => { const n = Number(v ?? LIMITS.PAGE_DEFAULT); return Number.isInteger(n) && n >= 1 ? Math.min(LIMITS.PAGE_MAX, n) : LIMITS.PAGE_DEFAULT; };

/** A moment, not a fact: a socket still holding a backlog skips it rather than queueing another 64 KB (security review M5). */
export function relayLossy(w: Pick<World, "clients">, msg: unknown, except?: Client) {
  const data = JSON.stringify(msg);
  for (const t of w.clients) if (t !== except && (t.ws.getBufferedAmount?.() ?? 0) <= FRAME_SKIP_BUFFERED) t.ws.send(data);
}
export const MESSAGES: Record<string, (ctx: MsgCtx, msg: any) => void> = {
  "history": ({ c, ws, now, expel }, msg) => {
    // speech is arrival-only: a page holds only lines said since this connection arrived, unless an admin's (owner,
    // operator: world.ts sayFloorFor), who reads the master log; spectators page like anyone else
    if (!c.world) return;
    const r = c.world.readHistory({
      before: typeof msg.before === "number" ? msg.before : Infinity,
      after: typeof msg.after === "number" ? msg.after : -Infinity,
      limit: pageLimit(msg.limit),
      verbs: Array.isArray(msg.verbs) && msg.verbs.length ? new Set(msg.verbs.map(String)) : null,
      floor: c.world.sayFloorFor(c),
    });
    ws.send(JSON.stringify({ type: "history", reqId: msg.reqId ?? null, ...r }));
  },
  "debug": ({ c, ws, now, expel }, msg) => {
    // the flight recorder (World.debugLog): open to spectators, as the log itself is public
    if (!c.world) return;
    const limit = pageLimit(msg.limit);
    if (msg.script != null) {
      // one script's log ring + status: the author's console
      const b = c.world.scripts.inspect(String(msg.script));
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        script: String(msg.script),
        status: b?.status ?? "no such script",
        events: (b?.ring ?? []).slice(-limit).map((r) => ({ ts: r.ts, kind: "script-log", line: r.line })) }));
      return;
    }
    if (msg.scripts) {   // the roster: what runs here, and is it alive
      ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null,
        events: c.world.scripts.list().map((b) => ({ ts: 0, kind: "script", ...b })) }));
      return;
    }
    const kinds = Array.isArray(msg.kinds) && msg.kinds.length ? new Set(msg.kinds.map(String)) : null;
    const events = c.world.debugLog
      .filter((e) => !kinds || kinds.has(String(e.kind)))
      .slice(-limit);
    ws.send(JSON.stringify({ type: "debug", reqId: msg.reqId ?? null, events }));
  },
  // whisper was removed (direct messages belong at the identity level, not world chat): the sender is told so in the
  // registry's words (refusalcodes.js `removed`); its text is not delivered, held, or logged
  "whisper": ({ ws }, msg) => {
    const r = REMOVED_VERBS.whisper;
    ws.send(JSON.stringify({ type: "error", error: `whisper was removed: ${r.why}`, about: "whisper", refused: { code: "removed", reason: `whisper was removed: ${r.why}`, fix: r.fix }, ...(msg?.reqId !== undefined ? { reqId: msg.reqId } : {}) }));
  },
  "anim": ({ c, ws, now, expel }, msg) => {
    // relayed once, never logged (a moment, not a fact); too big for the 15Hz pose stream
    if (!c.world || c.spectator) return;
    // {stop: true}: every animation fades out, back to what the body holds beneath
    if (msg.stop === true) { c.world.broadcast({ type: "anim", id: c.id, stop: true }, c); return; }
    if (typeof msg.dur !== "number" || typeof msg.tracks !== "object") return;
    // poses are tiny: anything approaching a real asset is a mistake or an attack
    if (JSON.stringify(msg.tracks).length > LIMITS.ANIM_TRACKS_BYTES) {
      ws.send(JSON.stringify({ type: "error", error: "animation too large — keep custom clips small and sparse" }));
      return;
    }
    // a packet without replace REPLACES the previous animation (legacy); a merge must say replace: false
    relayLossy(c.world, { type: "anim", id: c.id, dur: msg.dur, tracks: msg.tracks, loop: !!msg.loop, replace: msg.replace !== false }, c);
  },
  "puppet": ({ c, ws, now, expel }, msg) => {
    // ROUTED to the target, not broadcast: each client owns its avatar (DESIGN.md), so a puppet is a REQUEST it may refuse
    if (!c.world || c.spectator) return;
    const to = String(msg.target ?? "").slice(0, LIMITS.ID_LEN);
    const { tc } = presenceTarget(c.world, msg.targetActor, to);   // the identity named, or the name
    if (!tc) { ws.send(JSON.stringify({ type: "error", error: `${to || "target"} isn't here to pose` })); return; }
    // ragdoll is `true` (undirected knock-over) or {lean:[x,y,z]} m/s; sanitized to exactly those shapes, the receiver
    // caps magnitude itself
    let rag: true | { lean: number[] } | null = null;
    if (msg.ragdoll === true) rag = true;
    else if (msg.ragdoll && Array.isArray((msg.ragdoll as { lean?: unknown }).lean)) {
      const lean = ((msg.ragdoll as { lean: unknown[] }).lean).map(Number);
      if (lean.length === 3 && lean.every(Number.isFinite)) rag = { lean };
    }
    // consent and range at the server (L6): a knock-over is a shove, a pose or an animation is a pose
    const why = (rag ? bodyRefusal(c, tc, "shove", "shove") : null) ?? (msg.pose || msg.anim ? bodyRefusal(c, tc, "pose", msg.anim ? "anim" : "pose") : null);
    if (why) { ws.send(JSON.stringify({ type: "error", error: why })); return; }
    // merge: pose only the bones sent, over what the target holds; absent means replace
    tc.ws.send(JSON.stringify({ type: "puppet", by: c.id, ...(c.actorId ? { byActor: c.actorId } : {}), pose: msg.pose ?? null, merge: msg.merge === true,
      anim: msg.anim ? { ...msg.anim, replace: msg.anim.replace !== false } : null, ragdoll: rag }));
  },
  "bc": ({ c, ws, now, expel }, msg) => {
    // dev crash forensics: the client's last N breadcrumbs, printed on disconnect. Never persisted.
    const ring = (c.bcRing ??= []);
    ring.push(String(msg.tag ?? "").slice(0, LIMITS.ID_LEN));
    if (ring.length > LIMITS.BC_RING) ring.shift();
    return;
  },
  "bodydrag": ({ c, ws, now, expel }, msg) => {
    const okSim = (v: any) => {
      if (!v || typeof v !== "object") return false;
      // both engines' snapshot() hand over {j, p, v}: joint names, positions, VELOCITIES (no quats), three finite numbers each
      const { j, p, v: vel } = { j: v.j, p: v.p, v: v.v };
      if (!Array.isArray(j) || j.length === 0 || j.length > 24) return false;
      if (!Array.isArray(p) || !Array.isArray(vel)) return false;
      if (p.length !== j.length * 3 || vel.length !== j.length * 3) return false;
      return j.every((n: unknown) => typeof n === "string" && n.length <= 24)
        && p.every((n: unknown) => Number.isFinite(n))
        && vel.every((n: unknown) => Number.isFinite(n));
    };
    // ragdoll drag: the dragger runs the sim and streams it to the owner, who applies and rebroadcasts it. Targeted like
    // puppet, never logged or queued; grab, stream and release are all requests to the owner
    if (!c.world || c.spectator) return;
    const raw = String(msg.pose ? JSON.stringify(msg.pose) : "");
    if (raw.length > LIMITS.BODYDRAG_POSE_BYTES) return;      // a pose is tiny; anything else is an attack
    const to = String(msg.target ?? "").slice(0, LIMITS.ID_LEN);
    const { tc } = presenceTarget(c.world, msg.targetActor, to, false);   // the identity named, or the name
    if (process.env.BD_DEBUG) console.log(`[bd] ${c.id} -> ${to} (${msg.grab ? "grab" : msg.end ? "end" : "sample"}) ${tc ? "relayed" : `NO TARGET among [${[...c.world.clients].map((o) => o.id).join(",")}]`}`);
    if (!tc) return;                       // the departed: moot
    // a grab takes someone's body (move, L6): their consent and reach, at the server; stream and release only ever go to a
    // body that accepted the grab
    if (msg.grab != null) { const why = bodyRefusal(c, tc, "displace", "drag"); if (why) { ws.send(JSON.stringify({ type: "error", error: why })); return; } }
    // what follows a grab is held to the same table: pulling a nail needs displace or a granted drag; once displace is deny
    // nothing more of a drag reaches them; an end always goes through, minus a refused nail
    else if ((msg.end == null || msg.unpin != null || msg.pinAt != null || msg.pins != null) && !(c.actorId && c.actorId === tc.actorId)) {
      const nail = msg.unpin != null || msg.pinAt != null || msg.pins != null;
      const endAlone = () => { if (msg.end == null) return true; delete msg.unpin; delete msg.pinAt; delete msg.pins; return false; };   // refused: an end still goes, bare
      // fails closed like bodyRefusal: with no live log or no identity on either side, nothing can say yes
      const live = c.world.log?.live;
      if (!live || !c.actorId || !tc.actorId) { if (nail) ws.send(JSON.stringify({ type: "error", error: `${tc.id}'s body isn't taking displace right now` })); if (endAlone()) return; }
      else {
      const d = consentDecide(live.presence, c.actorId, tc.actorId, "displace", live.now());
      const granted = (live.presence as any)?.bodies?.[tc.actorId]?.draggedBy === c.actorId;
      if (d.mode === "deny" || (nail && d.mode !== "allow" && !granted)) {
        if (nail) ws.send(JSON.stringify({ type: "error", error: d.mode === "deny" ? refusalWords(tc.id, "displace") : `${tc.id} asks first for displace: ask with the body request — body {to: "${tc.actorId}", kind: "drag"}` }));
        if (endAlone()) return;
      }
    } }
    tc.ws.send(JSON.stringify({
      type: "bodydrag", by: c.id, ...(c.actorId ? { byActor: c.actorId } : {}),
      ...(msg.grab != null ? { grab: msg.grab } : {}),
      ...(msg.end != null ? { end: true } : {}),
      ...(msg.pose != null ? { pose: msg.pose } : {}),
      ...(Array.isArray(msg.p) ? { p: (msg.p as unknown[]).slice(0, 3).map(Number) } : {}),
      ...(msg.yaw != null ? { yaw: Number(msg.yaw) } : {}),
      // persistent pins and the sim handover (joints, positions, velocities) so the receiver CONTINUES the sim; ≤24 joints of
      // finite numbers or it doesn't travel
      ...(okSim(msg.sim) ? { sim: msg.sim } : {}),
      ...(msg.pinAt != null ? { pinAt: msg.pinAt } : {}),
      ...(msg.unpin != null ? { unpin: msg.unpin } : {}),
      ...(Array.isArray(msg.pins) ? { pins: (msg.pins as unknown[]).slice(0, 16) } : {}),
    }));
  },
  "caption": ({ c, ws, now, expel }, msg) => {
    // sentences ride presence (never persisted); the whole utterance lands in the log as ONE say when the voice finishes.
    // The bound voice leg owns the audio clock (#57), so it paces captions; other aux legs stay mute
    const voiceLeg = c.surface === "voice" && c.auxBound === true;
    if (!c.world || (c.spectator && !voiceLeg)) return;
    const capText = String(msg.text ?? "").slice(0, LIMITS.CAPTION_LEN);
    if (!capText) return;
    const capUtt = Number(msg.utt);
    c.world.broadcast({ type: "caption", id: c.id, text: capText,
      utt: Number.isSafeInteger(capUtt) && capUtt >= 0 ? capUtt : 0 }, c);
  },
  "attest": ({ c, ws, now, expel }, msg) => {
    // the per-utterance performance receipt (#57), the only message an aux leg may send beyond signalling: verified, then
    // broadcast as `performed` (unlogged) so listeners holding local TTS skip it
    if (!c.world) return;
    // the VOICE surface's privilege alone, from a leg bound to the identity's authority (token bearer or the primary's login
    // sub): a non-voice aux leg can't mint a voice receipt
    if (c.surface !== "voice" || c.auxBound !== true) {
      ws.send(JSON.stringify({ type: "error", error: "attest is for the identity's bound voice leg" }));
      return;
    }
    const seq = Number(msg.seq);
    const digest = String(msg.digest ?? "").slice(0, 64);
    if (!Number.isSafeInteger(seq) || !digest) return;
    // attest under the current generation, or a retired leg's receipt is relabelled as the live one
    if (msg.gen !== c.gen) {
      ws.send(JSON.stringify({ type: "error", error: "attest surface-generation mismatch" }));
      return;
    }
    // the say must exist, be recent, and be THIS identity's (recentSays holds the last 256 says, worldlog.ts record);
    // misses answer with an error frame, so a leg can detect a discarded receipt
    const e = c.world.recentSays.find((x) => x.seq === seq);
    if (!e || e.verb !== "say" || e.actor !== c.id) {
      ws.send(JSON.stringify({ type: "error", error: "attest names no recent say of yours" }));
      return;
    }
    if (Date.now() - (e.ts ?? 0) > LIMITS.ATTEST_FRESH_MS) return;   // stale receipt: refuse
    const text = String((e.args as Record<string, unknown>)?.text ?? "");
    const want = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    if (digest !== want) {
      ws.send(JSON.stringify({ type: "error", error: "attest digest mismatch" }));
      return;
    }
    // NAME THE RUNG: this proves an AUTHORIZED LEG CLAIMED the performance, nothing about forwarding or hearing; the
    // incarnation scopes the claim
    const performed = JSON.stringify({ type: "performed",
      rung: "authorized-claim",
      incarnation: currentIncarnation(),
      id: c.id, seq, gen: c.gen, surface: c.surface });
    for (const t of c.world.clients) t.ws.send(performed);
    return;
  },
  "typing": ({ c, ws, now, expel }, msg) => {
    // pure presence: never logged or queued; the bound voice leg may pace it too (#57)
    const voiceLeg = c.surface === "voice" && c.auxBound === true;
    if (!c.world || (c.spectator && !voiceLeg)) return;
    // an agent's affordance glyph, whitelisted so presence stays presence: ear = hearing you, think = composing,
    // tool = working, mic = a live voice from this body
    const st = typeof msg.state === "string" && ["ear", "think", "tool", "mic"].includes(msg.state) ? msg.state : null;
    // `to` names someone present, or nobody; by identity when the sender names one (toActor), else by name
    const tt = presenceTarget(c.world, msg.toActor, typeof msg.to === "string" ? msg.to : "", false).tc;
    c.world.broadcast({ type: "typing", id: c.id, to: tt?.id ?? null, ...(tt?.actorId ? { toActor: tt.actorId } : {}), ...(st ? { state: st } : {}) }, c);
  },
  "drag": ({ c, ws, now, expel }, msg) => {
    // only the RELEASE commits (DESIGN.md); without this feedback objects teleport
    if (!c.world || c.spectator) return;
    // must agree with the RELEASE's `place` gate, or visitors slide props they can't commit: the build switch, never a
    // rank table (an unknown role must not pass)
    if (!c.world.log!.rightsOf(actorIdOf(c)).can.build) return;   // the person's directory identity, never their name
    // q: the rotate gizmo turns about any axis (design §5); relayed only as a normalized quaternion
    const q = qNorm(msg.q);
    // `end: true` is a drag's last sample: receivers drop its claim (docs/WIRE.md)
    const scale = Array.isArray(msg.scale) && msg.scale.length === 3 && msg.scale.every((n: unknown) => typeof n === "number" && Number.isFinite(n) && n > 0 && n < 1000) ? msg.scale : null;   // a scrubbed size
    c.world.broadcast({ type: "drag", id: msg.id, pos: msg.pos, yaw: msg.yaw, ...(q ? { q } : {}), ...(scale ? { scale } : {}), ...(msg.end === true ? { end: true } : {}), by: c.id }, c);
  },
  // spec/PHYSICS.md §5.1 round-trip clock: {t0} (echoed untouched) → {t0, t}, t on the world's AUTHORITY clock (the one
  // stamping entries' ts and frames' t). Offset = t − (t0 + t1) / 2.
  "clock": ({ c, ws }, msg) => {
    const t0 = typeof msg.t0 === "number" && Number.isFinite(msg.t0) ? msg.t0 : null;
    ws.send(JSON.stringify({ type: "clock", t0, t: c.world ? authorityNow(c.world) : Date.now() }));
  },
  // spec/PHYSICS.md §4.3 state-sync lane, RESERVED: {s: [{id, by, aseq, oseq, t, p, q, v, w, sleep}, …]}. Checked now so
  // no client ships another shape under this name; refused until a live simulation authority exists.
  "state": ({ c, ws }, msg) => {
    if (!c.world || c.spectator) return;
    const list = Array.isArray(msg.s) ? msg.s : null;
    const why = !list || !list.length || list.length > 64 ? "state is {s: [sample, …]} (1–64 samples)" : list.map(stateSampleError).find((x) => x) ?? null;
    ws.send(JSON.stringify({ type: "error", error: why ? `state: ${why}` : "state samples are reserved: no live simulation authority runs here yet (PHYSICS §4.3)" }));
  },
  "pose": ({ c, ws, now, expel }, msg) => {
    if (!c.world || c.spectator) return;
    const pose = sanePose(msg.pose);
    if (!pose) {                                  // non-finite / malformed: never relayed (posecheck.ts)
      const cc = c as Client & { badPose?: number };
      cc.badPose = (cc.badPose ?? 0) + 1;
      if (cc.badPose === 1 || cc.badPose % 600 === 0)
        console.log(`[world:${c.world.name}] dropped non-finite pose from ${c.id} (×${cc.badPose})`);
      return;
    }
    gateReach(c, pose);                           // a hand on another body relays only with their consent (reachgate.ts)
    c.lastPose = pose;
    // batched into stage frames by the tick loop, never persisted
    c.world.dirty.set(c.id, pose);
  },
  // a renderer (or opt-in native donor) declares what it can capture and answers `capture` (server/snapshots.ts brokers)
  "capture-capabilities": ({ c }, msg) => { if (c.world) snapshots.configure(c, msg.capture); },
  "capture-result": ({ c }, msg) => { snapshots.receive(c, msg); },
  "world-bans": ({ c, ws, now, expel }, msg) => {
    if (!c.world) return;
    // only for holders of a moderation power (research roles §7); a ban that ended isn't listed
    if (c.world.log) { const e = c.actorId ? c.world.log.rightsOf(c.actorId) : null;
      if (!e || !(isOwner(e) || ["mute", "kick", "ban", "pauseScripts"].some((k) => e.permissions.includes(k)))) { ws.send(JSON.stringify({ type: "error", error: "the ban list is for people who hold a moderation power here" })); return; } }
    const S = c.world.log!.sanctions();
    const dir = directoryFor(WORLDS_DIR);
    const list = Object.entries(S).filter(([, x]) => (x as any).ban).map(([, x]) => (x as any).ban).map((m) =>
      `${dir.entry(m.who)?.name ?? m.who} — ${new Date(m.ts).toISOString().slice(0, 10)}${m.reason ? `: ${m.reason}` : ""}`);
    ws.send(JSON.stringify({ type: "mod", text: list.length
      ? `banned from "${c.world.name}" (${list.length}):\n${list.join("\n")}`
      : `nobody is banned from "${c.world.name}"` }));
  },
  "global-mod": ({ c, ws, now, expel }, msg) => {
    // instance-wide moderation: no global log, so gated on WORLD_ADMIN, persisted in .bans.json; replies `mod`, refusals `error`
    if (!isOperator(c.account)) {   // WORLD_ADMIN names ACCOUNTS, never a typed name
      ws.send(JSON.stringify({ type: "error", error: "global moderation needs WORLD_ADMIN — per-world /ban is the owner tool" }));
      return;
    }
    if (msg.type === "global-bans") {
      const list = Object.entries(globalBans).map(([k, b]) =>
        `${b.name ?? k}${b.account ? ` (${b.account})` : b.addr ? " (a guest's connection)" : ""} — by ${b.by}, ${new Date(b.ts).toISOString().slice(0, 10)}${b.reason ? `: ${b.reason}` : ""}`);
      ws.send(JSON.stringify({ type: "mod", text: list.length ? `global bans (${list.length}):\n${list.join("\n")}` : "no global bans" }));
      return;
    }
    // an account selector keeps its whole length (an aid1 account carries its issuer's URL); cut to a display name's 64 it
    // named no one, and an unban couldn't find it (#260)
    const raw = String(msg.id ?? "").trim(), id = /^(human|agent|aid1|local):/.test(raw) ? raw.slice(0, 512) : raw.slice(0, LIMITS.ID_LEN);
    if (!id || id === "*") {
      ws.send(JSON.stringify({ type: "error", error: `${msg.type} wants {id, reason?} — a specific participant, not everyone` }));
      return;
    }
    const fold = (x: string) => foldName(x);
    const dir = directoryFor(WORLDS_DIR);
    if (msg.type === "global-unban") {
      // by the filed name, by the account named, or by an account wearing that name here
      const accts = new Set([id, ...dir.accountsNamed(id)]);
      const gone = bansLiftedBy(globalBans, id, accts, fold);
      for (const k of gone) delete globalBans[k];
      saveGlobalBans();
      console.log(`[mod] ${c.id} lifted global ban on ${id}${gone.length ? ` (${gone.length} record(s))` : " (was not banned)"}`);
      ws.send(JSON.stringify({ type: "mod", text: gone.length ? `${id} is no longer banned globally` : `${id} was not globally banned` }));
      return;
    }
    // global-ban binds what the DOOR checks (proven account, or a guest's hashed address), never a display name alone:
    // present → their account/address; absent → every account the directory knows by that name; nothing to bind → refused
    const present = [...worlds.values()].flatMap((w) => [...w.clients]).filter((o) => fold(o.id) === fold(id) || (typeof msg.id === "string" && o.account === msg.id));
    if (present.some((o) => isOperator(o.account))) {
      ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` }));
      return;
    }
    if (fold(id) === fold(c.id) || present.some((o) => o === c)) {
      ws.send(JSON.stringify({ type: "error", error: "you cannot moderate yourself" }));
      return;
    }
    const reason = msg.reason != null ? String(msg.reason).slice(0, LIMITS.BAN_REASON_LEN) : undefined;
    const accounts = new Set<string>([...present.map((o) => o.account).filter((a): a is string => !!a), ...dir.accountsNamed(id), ...(/^(human|agent|aid1|local):/.test(id) ? [id] : [])]);
    if ([...accounts].some((a) => isOperator(a))) { ws.send(JSON.stringify({ type: "error", error: `${id} is a world operator — remove them from WORLD_ADMIN first` })); return; }
    const guestAddrs = new Set<string>(present.filter((o) => !o.account && o.addr).map((o) => o.addr as string));
    if (!accounts.size && !guestAddrs.size) {
      ws.send(JSON.stringify({ type: "error", error: `can't ban "${id}" globally: nobody by that name is here, and no account wears it in the directory, so there is nothing a ban could bind to (bans bind to accounts, or a present guest's connection)` }));
      return;
    }
    const ts = Date.now();
    for (const account of accounts) globalBans[banKey(account)] = { by: c.id, ts, name: id, account, ...(reason ? { reason } : {}) };
    for (const addr of guestAddrs) globalBans[banKey(null, addr)] = { by: c.id, ts, name: id, addr, until: ts + ADDR_BAN_MS, ...(reason ? { reason } : {}) };
    saveGlobalBans();
    let expelled = 0;
    for (const w2 of worlds.values()) {
      for (const other of [...w2.clients]) {
        if (other === c) continue;
        if (!((other.account && accounts.has(other.account)) || (!other.account && other.addr && guestAddrs.has(other.addr)))) continue;
        expel(w2, other, `you were banned from these worlds by ${c.id}${reason ? ` — ${reason}` : ""}`);
        expelled++;
      }
    }
    console.log(`[mod] ${c.id} banned ${id} globally (${accounts.size} account(s), ${guestAddrs.size} guest address(es))${reason ? ` (${reason})` : ""}${expelled ? ` — ${expelled} session(s) disconnected` : ""}`);
    ws.send(JSON.stringify({ type: "mod", text: `${id} is banned from all worlds${reason ? ` — ${reason}` : ""}${expelled ? ` (${expelled} live session${expelled === 1 ? "" : "s"} disconnected)` : ""}` }));
    return;
  }
};

// the three global-moderation labels share one body
MESSAGES["global-ban"] = MESSAGES["global-mod"];
MESSAGES["global-unban"] = MESSAGES["global-mod"];
MESSAGES["global-bans"] = MESSAGES["global-mod"];
delete (MESSAGES as Record<string, unknown>)["global-mod"];
