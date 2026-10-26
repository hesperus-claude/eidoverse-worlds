// net — the wire. One socket carrying two planes: the world log (ordered,
// persisted, replayed on join) and presence (batched, lossy, never persisted).

import { CONFIG, report, bus, nameFromJoinAck } from './base.js';
import { avatarMounts } from './mounts.js';   // not world.js: that pulls core.js (the renderer) into lite
// The world as data (TEL0S_NOTES §11.2): every snapshot and live entry folds here, synchronously, through
// shared/protocol/replica.js (the same fold the sequencer runs), and the realizers project it into the scene.
// EW.foldParity() measures fold-vs-scene drift on demand.
import { hydrate as shadowHydrate, reset as shadowReset, state as shadowState, applyView } from './state.js';
import { hear } from '../../shared/chatwindow.js';
import { refusalText } from '../../shared/protocol/refusal.js';
import { pending, P } from './scheduler.js';
// The realizers (TEL0S_NOTES §11.4) own the scene; fold-inert causes (use/punt/force, moderation narration, live say)
// go over the bus as 'live-entry' (livechat.js), emitted rather than imported to stay out of the net → chat → net cycle.

import { wingFoldPresence } from '../../shared/wingpresence.js';
import { presenceWire, voiceWire, bodyWire } from '../../shared/presencewire.js';
import { serverNow, localNow, noteRoundTrip, clockRtt, noteServerFloor, onClockDoubt } from './serverclock.js';
import { presence } from './presence.js';
import { logChat, noteTyping, noteHistoryContext, resyncChatAfter } from './chat.js';
import { markPhase, refuseBoot, waitBoot } from './boot.js';
// this client folds the authority's own stream (shared/protocol/replica.js) and derives the view the realizers draw from it,
// locally; edit mode sends requests (editwrites.js) and waits for the authority.
import { makeReplica } from '../../shared/protocol/replica.js';
import { redialer, REDIAL } from '../../shared/redial.js';
import { actorName } from '../../shared/protocol/names.js';
// the fold's records are frozen on a dev host (a reader that writes into one throws where it stands, C7); a visitor's
// browser skips the walk
export const replica = makeReplica({ freeze: CONFIG.dev });
/** Is this client in a world (it has adopted the authority's cut)? */
export const replicaActive = () => replica.active;
// the wire takes a notifier rather than importing the UI; the default logs, so a dropped-connection notice can't vanish
let toast = (m, kind) => console.log(`[net:${kind ?? 'info'}] ${m}`);

export const net = {
  ws: null,
  joined: false,
  myId: null,
  mySub: null,
  status: 'connecting',   // connecting | live | retrying | rejected
  latency: null,
};

let restoredPose = false;
let hydrating = false;
let pendingLive = [];
let lastSeq = -1;
// when to dial again after a close (shared/redial.js: exponential with full jitter, up to a minute; the agent's rule too).
// Reset only by a join the server ACCEPTED (the snapshot): a socket that opens and is refused again keeps backing off
// (review r4 F5: reset on open, a full world's waiting pages redialled every 5 s, in step).
const redial = redialer();

// Supplied by main.js so net can read/write body state without importing the
// controller (which imports ui, which imports assets…).
let hooks = {
  myAvatarPath: () => '',
  myState: null,
  me: () => null,
  onRestore: () => {},
  onSnapshotDone: () => {},
  myVoice: () => null,   // { mic, hear } — main.js reads the HUD glyphs' own state (mictoggle.js)
};

// The participant registry, asset ledger and capture renderer are INJECTED: importing them (three.js, the GPU) would
// drag the engine into lite.js. `let` bindings keep the original names so call sites read as imports did; defaults
// are inert, and main.js / lite.js (participants_lite.js) wire them explicitly.
let remotes = new Map();
let ensureRemote = async () => null;
let dropRemote = () => null;
let pushPose = () => {};
let noteServerTime = () => {};
let noteSpeaking = () => {};
let forgetBytes = () => {};
// reachnet.js reaches the engine through landmarks.js. Only sendPose() reads this, and
// a client with no body never sends a pose (hooks.myState is null, which returns early
// above) — so undefined here is both safe and correct: absence means "let go".
let myReachBag = () => undefined;
// A client with no renderer must still ANSWER a snap — the asker is blocked on the
// reply id — so the default is an honest error, not silence.
const noRenderer = async () => ({ error: 'this client has no renderer' });
let capture = noRenderer;
let warnedNoRenderer = false;

export function wireNet(h) {
  const { participants, forgetBytes: fb, capture: cap, myReachBag: rb, toast: tf, ...rest } = h;
  if (participants) ({ remotes, ensureRemote, dropRemote, pushPose, noteServerTime, noteSpeaking } = participants);
  if (fb) forgetBytes = fb;
  if (rb) myReachBag = rb;
  if (tf) toast = tf;
  if (cap) capture = cap;
  hooks = { ...hooks, ...rest };
}

// ---------------------------------------------------------------- sending

// Every write is a request (sendRequest below; edits go through editwrites.js sendOps). No verb crosses the wire.

/** People present, by the name they show → the identity the world knows them by (u-…, from the authority's directory;
 *  the server sends it on arrive and in the join roster). A role, a ban or a rollback goes to THIS, never to a typed
 *  name (round-2 R1/R2; security review 10-06 H2). */
export const identities = new Map();
/** A presence message names its person by IDENTITY too (security pass 3, H2): the server routes it to that identity, and
 *  a name someone else wears never catches it. `key` is the field the server reads (targetActor / toActor). */
const actorFor = (name, key) => { const a = name ? identities.get(name) : null; return a ? { [key]: a } : {}; };
// A message about someone's BODY or to them (puppet, bodydrag, typing) goes only to an identity: sent without one the
// server routes it by name (messages.ts presenceTarget), and a name is whatever someone else chose to wear (house I197).
const hasActor = (name) => !!(name && identities.get(name));
/** Display ids of people here without an account (the server marks them on arrive/present): the 'guest' badge. */
export const guests = new Set();
/** Who is muted here now, by identity → until (the server's mod-state; research roles S6: the muted glyph). */
net.modMuted = {};
export const identityOf = (name) => (name === CONFIG.name ? net.you ?? null : identities.get(name) ?? null);
/** Say something in the world (the authority's `say`). Resolves with the authority's reply. Never silent (Commons audit #6): a
 *  line typed while the connection is down is QUEUED and sent when the world is back, and a refused say (the rate
 *  limit, a ban, too long) is shown to the person in plain words. */
const sayQueue = [];   // {args, resolve}: says typed while reconnecting, sent in order on the next snapshot
const SAY_QUEUE_MAX = 20;
const excerpt = (t) => { const s = String(t ?? '').replace(/\s+/g, ' ').trim(); return `“${s.length > 40 ? `${s.slice(0, 39)}…` : s}”`; };
export function sayRefusalWords(r, text) {
  const x = r?.refused ?? {}; const q = excerpt(text);
  switch (x.code) {
    case 'rate': return `slow down — you've said a lot in the last few seconds, so ${q} wasn't sent. Try again in a moment.`;
    case 'banned': return `${q} wasn't sent: you're banned from this world.`;
    case 'too-big': return `${q} is too long to send — ${x.reason ?? 'split it into shorter messages'}.`;
    case 'timeout': return `the world didn't confirm ${q} — it may still arrive; look before sending it again.`;
    case 'offline': return `${q} wasn't sent: not connected to the world.`;
    default: return `${q} wasn't sent: ${x.reason ?? x.code ?? 'the world refused it'}${x.fix ? ` (${x.fix})` : ''}.`;
  }
}
function sendSay(args) {
  return sendRequest('say', args).then((r) => { if (!r?.ok) logChat('*', sayRefusalWords(r, args.text)); return r; });
}
/** extra: to (a whisper); spoken/utt/t0 (the words were voice-performed: the authority logs the trio, display only);
 *  live: true for a transcript of speech (stt.js), which is never queued for a reconnect: sent later it would publish
 *  after the mic went off, with nothing to check it again, so offline it is dropped. */
export function say(text, extra = {}) {
  const args = { text: String(text ?? ''), ...(extra.to ? { to: extra.to } : {}),
    ...(extra.spoken === true && Number.isSafeInteger(extra.utt) ? { spoken: true, utt: extra.utt, ...(Number.isFinite(extra.t0) ? { t0: extra.t0 } : {}) } : {}) };
  if (net.joined && net.ws?.readyState === 1) return sendSay(args);
  if (extra.live) return Promise.resolve({ ok: false, refused: { code: 'offline', reason: 'not connected to the world' } });
  // removed, taken over, or refused at the authority: nothing will reconnect, so nothing is queued (it would wait forever)
  if (sayQueue.length >= SAY_QUEUE_MAX || net.status === 'rejected') { const r = { ok: false, refused: { code: 'offline', reason: 'not connected to the world' } }; logChat('*', sayRefusalWords(r, args.text)); return Promise.resolve(r); }
  logChat('*', `queued ${excerpt(args.text)} — reconnecting… it will be sent when the world is back`);
  return new Promise((resolve) => sayQueue.push({ args, resolve }));
}
/** The connection won't come back (a kick, a ban, a takeover, a refused join): what was queued is told so, not kept. */
function failSays() {
  while (sayQueue.length) { const { args, resolve } = sayQueue.shift(); const r = { ok: false, refused: { code: 'offline', reason: 'not connected to the world' } };
    logChat('*', sayRefusalWords(r, args.text)); resolve(r); }
}
/** Send what was typed while the connection was down, in order (called once the snapshot has landed). */
function flushSays() {
  while (sayQueue.length && net.joined && net.ws?.readyState === 1) { const { args, resolve } = sayQueue.shift(); sendSay(args).then(resolve); }
}
/** A one-off animation — sent once, relayed to everyone, never logged. */
export function sendAnim(data) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'anim', ...data }));
  }
}
/** Ask another body to hold a pose or play an animation. `merge`: pose only
 *  the bones sent, over what they already hold (a null bone releases it);
 *  without it the pose replaces theirs whole. */
export function sendPuppet(target, { pose = null, merge = false, anim = null, ragdoll = null } = {}) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'puppet', target, ...actorFor(target, 'targetActor'), pose, ...(merge ? { merge: true } : {}), anim, ragdoll }));
  }
}

/** Ask the world for a page of its own history (folding means a joiner isn't handed everything).
 *  No answer (not joined, or nothing within 8 s) rejects, so a caller can tell it from an empty page. */
const pendingHistory = new Map();
let histId = 0;
export function requestHistory(opts = {}) {
  if (!net.joined || net.ws?.readyState !== 1) return Promise.reject(new Error('history: not connected'));
  const reqId = `h${++histId}`;
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { pendingHistory.delete(reqId); reject(new Error('history: no answer within 8 s')); }, 8000);
    pendingHistory.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    net.ws.send(JSON.stringify({ type: 'history', reqId, ...opts }));
  });
}

/** The world's flight recorder: why things bounced (denials, rejections,
 *  rate limits, reaction outcomes). Same request shape as history. */
export function requestDebug(opts = {}) {
  if (!net.joined || net.ws?.readyState !== 1) return Promise.resolve({ events: [] });
  const reqId = `d${++histId}`;
  return new Promise((resolve) => {
    const t = setTimeout(() => { pendingHistory.delete(reqId); resolve({ events: [] }); }, 8000);
    pendingHistory.set(reqId, (m) => { clearTimeout(t); resolve(m); });
    net.ws.send(JSON.stringify({ type: 'debug', reqId, ...opts }));
  });
}

/** Copy the current world into a brand-new name (server: owner-only). */
export function sendWorldFork(to) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-fork', to }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Found a new, empty world you own (server: a signed-in person, within its caps). The reply is world-founded. */
export function sendWorldFound(name, title) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-found', name, ...(title ? { title } : {}) }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Erase the current world back to zero (server: owner-only, archived not
 *  destroyed). Carries the world's own name as the confirmation the server
 *  demands — the caller is responsible for having made the user type it. */
export function sendWorldReset() {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'world-reset', name: CONFIG.world }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** Moderation messages that are not world verbs: 'world-bans' (list this
 *  world's bans — anyone), 'global-ban' / 'global-unban' / 'global-bans'
 *  (operator only; the server enforces). Replies arrive as `mod` messages. */
export function sendMod(type, extra = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type, ...extra }));
  } else logChat('*', 'not connected — try again in a moment');
}

/** #104 phase-1: ask the sequencer to mint this body's media credential. */
export function sendRelayCredRequest(scopes = {}) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'relay-cred', ...scopes }));
}
/** #104 amendment 3: listener-authored receive consent, server-enforced. */
export function sendVoiceConsent(recv) {
  if (net.joined && net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'voice-consent', recv: !!recv }));
}
export function sendTyping(to, state) {
  if (net.joined && net.ws?.readyState === 1 && (!to || hasActor(to))) net.ws.send(JSON.stringify({ type: 'typing', to, ...actorFor(to, 'toActor'), ...(state ? { state } : {}) }));
}

/** Transient, never-logged relay — used while a build drag is in flight so
 *  other people see the object moving before the single committed `place`. */
export function sendDrag(id, pos, yaw, q = null, { end = false, scale = null } = {}) {
  if (net.joined && net.ws?.readyState === 1) {
    net.ws.send(JSON.stringify({ type: 'drag', id, pos, yaw, ...(q ? { q } : {}), ...(scale ? { scale } : {}), ...(end ? { end: true } : {}) }));
  }
}

/** This page's presence session, sent with every join so listeners can tell a reconnect (counter goes on) from a new
 *  page (counter restarts). index.html's early socket sends the first join with the same id. */
const PAGE_SESSION = (globalThis.__ewPageSession ??= globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`);

export function sendJoin() {
  const id = CONFIG.renderer ? `renderer-${CONFIG.name}`
    : CONFIG.spectate ? `retina-${CONFIG.name}` : CONFIG.name;
  // ?renderer asks to be a renderer; only a client with a capture renderer wired is one (lite.js wires none), since the
  // server routes snapshots and roaming by the flag. Without one it's an invisible spectator, or refused (4003) on the
  // renderers' own credential. Reads `capture` at send; main.js wires it before start() (tools/renderer-join-test.ts).
  const rendering = CONFIG.renderer && capture !== noRenderer;
  if (CONFIG.renderer && !rendering && !warnedNoRenderer) {
    warnedNoRenderer = true;
    console.warn("[net] ?renderer, but this client has no renderer: it does not join as one. A door key admits it as a spectator; the renderers' credential admits renderers only, so with that it is refused.");
  }
  net.ws.send(JSON.stringify({
    type: 'join', world: CONFIG.world, id,
    avatar: hooks.myAvatarPath(),
    spectate: CONFIG.spectate || CONFIG.renderer,
    renderer: rendering,
    ...(rendering && CONFIG.roam ? { roam: true } : {}),
    token: CONFIG.token,
    ...(CONFIG.account ? { account: CONFIG.account } : {}),
    // this client folds the world's log stream itself (the server refuses a client that doesn't)
    replica: true,
    session: PAGE_SESSION,
    clock: true,   // the server's time just before the snapshot ('clock' below)
  }));
}

// ---- requests: {type: 'request', id, verb, args} → {type: 'reply', id, ok, reply} (server/requestwire.ts) ----
let requestSeq = 0;
const pendingRequests = new Map();   // id → {resolve, timer}
/** One request; resolves with the authority's own reply ({ok, …} or {ok: false, refused: {code, reason, fix}}).
 *  Never rejects: a lost socket or a timeout is a refusal the caller shows like any other. When the request was sent
 *  and no answer came (a timeout, or the socket dropping after it went), the refusal also carries mayHaveLanded: true,
 *  since the authority may have done what it asked; one never sent (not connected) doesn't. */
export function sendRequest(verb, args = {}, { timeoutMs = 15000 } = {}) {
  if (!(net.joined && net.ws?.readyState === 1)) return Promise.resolve({ ok: false, refused: { code: 'offline', reason: 'not connected to the world', fix: 'wait for the connection to come back, then try again' } });
  const id = ++requestSeq;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { pendingRequests.delete(id); resolve({ ok: false, refused: { code: 'timeout', reason: `the authority didn't answer '${verb}' in ${timeoutMs / 1000} s`, fix: 'it may still land: look before trying again', mayHaveLanded: true } }); }, timeoutMs);
    pendingRequests.set(id, { resolve, timer, verb, ws: net.ws });   // the socket it went on: only that one's close fails it (I62)
    net.ws.send(JSON.stringify({ type: 'request', id, verb, args }));
  });
}
// The socket closed: no reply can come on it (request ids don't carry over to the next one), so every request still in flight
// is answered now, not by its 15 s timer (which held the body track that long after a reconnect, then spoke a stale timeout)
function failPending(ws = null) {
  for (const [id, p] of pendingRequests) { if (ws && p.ws !== ws) continue; pendingRequests.delete(id); clearTimeout(p.timer);
    p.resolve({ ok: false, refused: { code: 'offline', reason: `the connection dropped before the authority answered '${p.verb}'`, fix: 'it may have landed: look before trying again', mayHaveLanded: true } }); }
}
function onReply(msg) {
  const p = pendingRequests.get(msg.id); if (!p) return;
  pendingRequests.delete(msg.id); clearTimeout(p.timer);
  p.resolve(msg.reply ?? { ok: false, refused: { code: 'no-reply', reason: 'the authority sent no reply body' } });
}
/** The authority's fresh entries: fold them (replica.ingest), then hand state.js the new view of that fold (it tells the
 *  realizers what changed, in the protocol's terms). Chat lines take the chat path (they aren't world state). */
function onLog(msg) {
  if (!replica.active) return;
  // each entry's ts was the authority's clock no later than now: a floor that catches a clock step before the next ask
  for (const e of msg.entries ?? []) noteServerFloor(e?.ts);
  const r = replica.ingest(msg.entries ?? [], msg.from ?? -1, msg.names);
  if (r.resync) { console.warn(`[replica] can't continue this client's cut (${r.why}): asking for a fresh snapshot`); rejoin(); return; }
  // a chat line: into the window (the shared rule), then the live causes (bubbles, voice, chat log).
  // Numbered seq × 1000, as the server numbers it in its window and history.
  for (const x of r.says) {
    // the spoken trio (validated at the authority) rides along: chat merges a spoken utterance and places it by t0
    const e = { seq: x.seq * 1000, ts: x.ts, actor: x.actor, verb: 'say', args: { text: x.text, ...(x.to ? { to: x.to } : {}), ...(x.spoken ? { spoken: true, utt: x.utt, ...(x.t0 !== undefined ? { t0: x.t0 } : {}) } : {}) } };
    hear(shadowState.st, { actor: e.actor, text: x.text, ts: e.ts, seq: e.seq });
    if (hydrating) pendingLive.push(e);
    else if (e.seq > lastSeq) { lastSeq = e.seq; bus.emit('live-entry', e); noteSpeaking(e.actor); }
  }
  if (r.changed) narrate(applyView(replica.view(shadowState.st), { ts: r.ts ?? undefined }), r.actor);
  bus.emit('log-applied', { from: msg.from, n: msg.entries?.length ?? 0, entries: msg.entries ?? [] });
}
/** Say in chat who changed someone's role here, as the world's own narration (a ban or a kick arrives as `moderated`). */
function narrate(d, actor) {
  const who = actor === 'world' || !actor ? 'the world' : actor; const st = shadowState.st;
  // people by name (the directory's, sent beside the entries), never their u-… id (Commons audit #1); '*' is everyone
  const person = (id) => (id === '*' ? 'everyone without a role' : actorName(id));
  for (const id of d?.ids?.roles ?? []) {
    const rec = st.roles?.[id];
    if (!rec) { logChat('*', `${who} took away ${person(id)}'s role here`); continue; }
    const bits = [rec.role, rec.gen != null ? (rec.gen ? '+gen' : '-gen') : null].filter(Boolean);
    logChat('*', `${who} made ${person(id)} ${bits.join(' ')}`);
  }
}

let lastPoseSent = 0;
/** Targeted ragdoll-drag traffic (grab / sim stream / release). Presence
 *  semantics: fire-and-forget, never logged. The target's client decides. */
export function sendBodyDrag(target, payload) {
  if (net.joined && net.ws?.readyState === 1 && hasActor(target)) {
    net.ws.send(JSON.stringify({ type: 'bodydrag', target, ...actorFor(target, 'targetActor'), ...payload }));
  }
}

// XR: the wire carries the AVATAR's actual yaw (root + its own chase of the head) and the look
// pitch while presenting — porch-old sent head yaw (index.html:11066–11072); remotes turn with the head.
let poseOverride = null;
export const setPoseOverride = (fn) => { poseOverride = fn; };
// spec/PHYSICS.md §5.1: one time base. Each sample carries its capture time on the authority's clock (once a round trip
// has measured it: a one-way guess runs late) and this sender's own count; the clock is re-measured every CLOCK_MS.
let poseSeq = 0, clockTimer = null;
const CLOCK_MS = 10_000;
function askClock() { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify({ type: 'clock', t0: localNow() })); }
onClockDoubt(askClock);   // a stamp from the authority says our clock estimate is stale (it stepped): measure it now
function startClock() { clearInterval(clockTimer); askClock(); setTimeout(askClock, 1000); clockTimer = setInterval(askClock, CLOCK_MS); }
export function sendPose(now) {
  const s = hooks.myState;
  if (!net.joined || !hooks.me() || !s || now - lastPoseSent < 66) return;
  lastPoseSent = now;
  const ov = poseOverride?.();
  const pose = {
    p: [s.pos.x, s.pos.y, s.pos.z],
    yaw: ov?.yaw ?? s.yaw, speed: s.speed, clip: s.clip,
    pitch: Math.round((ov?.pitch ?? s.pitch ?? 0) * 100) / 100,
    ...wingFoldPresence(s.wingsFolded),
    ...(s.bodyMode ? { bodyMode: s.bodyMode } : {}),   // the body-mode (shared/bodymode.js; R 10-17: was the posture, read off the clip)
    ...presenceWire(presence()),        // present / away / busy — for the Who panel (R, 09-05)
    ...voiceWire(hooks.myVoice()),      // mic live / headphones on — the hover card, agents' look
  };
  const avatar = hooks.me();
  Object.assign(pose, bodyWire({ scale: avatar.userScale, plateY: avatar.plateY }));   // this body's size / plate lift — only when not default
  if (!avatar.onceAnim && !avatar._limp && Number.isFinite(avatar.current?.time)) {
    pose.clipTime = avatar.current.time;
    pose.clipTimeSlot = avatar.currentSlot;
    pose.clipRate = avatar.current.paused ? 0 : avatar.current.timeScale ?? 1;
  }
  if (ov?.xr) pose.xr = ov.xr;   // C18: tracked head/hands, facing-relative (xrbody.js) — presence, never the log
  if (s.anim) { pose.anim = s.anim; s.anim = null; } // an anim played once (pose.anim): sent once
  // what I press while I hold a thing (grabbable's presence tier: every receiver draws its fx while this rides;
  // absent = not pressing). Never logged: a use.down/up that changes the world is a request of its own
  if (s.useHeld) pose.use = s.useHeld;
  // full-body orientation and a locomotion bag (docs/UNDERWATER-PRESENCE.md): presence only, optional, never authority
  if (s.q) pose.q = s.q;
  if (s.locomotion) pose.locomotion = s.locomotion;
  // A held custom pose rides the presence packet (and therefore lastPose, so
  // late joiners see it) — but never the log. `null` explicitly clears it.
  if (s.pose !== undefined) pose.pose = s.pose;
  // Persistent body pins (bodydrag nails) ride presence the same way: state
  // of a BODY, visible to everyone, never the log. Null clears.
  if (s.pins !== undefined) pose.pins = s.pins;
  // Reach descriptors (shared/reachwire.js): a relation, not bones — every
  // receiver re-solves it live. Rides while active; absence means let go.
  const reach = myReachBag();
  if (reach !== undefined) pose.reach = reach;
  // my seat rides every frame while I sit (presence; world.js setBodySeat): {to: <socket id>}; absence means standing
  const seat = avatarMounts.get(CONFIG.name);
  // …with the pose I chose from its menu (and when: a sync group follows the latest), and my input where the socket
  // routes it (throttle/steer, aimYaw/aimPitch: signals every client computes my pose from; client/lib/socksignals.js)
  if (seat?.to) pose.seat = { to: seat.to, ...(seat.pose ? { pose: seat.pose, at: seat.at ?? 0 } : {}),
    ...(seat.in && Object.keys(seat.in).length ? { in: Object.fromEntries(Object.entries(seat.in).map(([k, v]) => [k, Math.round(v * 1000) / 1000])) } : {}) };
  if (clockRtt() !== null) pose.t = Math.round(serverNow());
  pose.seq = ++poseSeq;
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
}

// ---------------------------------------------------------------- connecting

/** Re-send a KNOWN pose verbatim plus a one-shot, for a client with no body: composing from defaults would reset fields
 *  it doesn't know (sit, wings, held pose). A pose is the whole public body, not a delta.
 *  @returns {boolean} whether it went out. */
export function sendPoseExact(pose) {
  if (!net.joined || net.ws?.readyState !== 1) return false;
  net.ws.send(JSON.stringify({ type: 'pose', pose }));
  return true;
}

/** Re-enter the world as somebody else: the server keys a client by id, so a rename is a visible leave and arrive.
 *  Anything filed under the old name (the remembered sleeping place) doesn't follow. */
export function rejoin() {
  intentionalClose = net.ws ?? true;   // the socket being replaced: its close is the one rejoin() answers for
  try { net.ws?.close(); } catch { /* already gone */ }
  net.joined = false;
  connect();
}

let intentionalClose = false;   // false, or the socket whose close rejoin() drives (true: one with no socket to name)

// archipelago-home session: the server may know us from the ew_sess cookie (set by /auth after a Discord login);
// fetched once, and a verified name overrides localStorage (the server ignores a self-asserted id anyway)
let identity;   // undefined = not asked yet, null = no session
let authCfg = null;

async function fetchIdentity() {
  if (identity !== undefined) return;
  [identity, authCfg] = await Promise.all([
    fetch('/whoami').then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch('/authcfg').then((r) => (r.ok ? r.json() : null)).catch(() => null),
  ]);
  if (identity) {
    CONFIG.authed = true;
    CONFIG.sub = identity.sub;
    // Remember that this browser entered verified — when the session later
    // expires (or a deploy predating session persistence dropped it), the
    // right move is back through the login, not the key door.
    localStorage.setItem('ew-authed', '1');
    if (identity.name && identity.name !== CONFIG.name) {
      CONFIG.name = identity.name;
      localStorage.setItem('ew-name', identity.name);
    }
  }
}

/** A logged-out returning Discord user goes back through the login (silent while Discord knows them). Key-link
 *  visitors (CONFIG.token) are never bounced; one bounce a minute, so a down identity node can't redirect-loop. */
export function bounceToLogin() {
  if (identity || !authCfg?.login || CONFIG.token) return false;
  if (localStorage.getItem('ew-authed') !== '1') return false;
  const last = Number(sessionStorage.getItem('ew-login-bounce') ?? 0);
  if (Date.now() - last < 60_000) return false;
  sessionStorage.setItem('ew-login-bounce', String(Date.now()));
  location.href = authCfg.login;
  return true;
}

/** Resolve the verified identity BEFORE any UI reads CONFIG.name — main.js
 *  awaits this ahead of the front door, so the door greets the person Discord
 *  says they are instead of a stale localStorage name. Memoized. */
export async function initIdentity() {
  await fetchIdentity();
  return identity;
}

/** The deployment's login URL, if identity is wired up — the authority offers it as
 *  the keyless way in. Only meaningful after initIdentity()/connect(). */
export function loginUrl() {
  return authCfg?.login ?? null;
}

export async function connect() {
  await fetchIdentity();
  // Login-required deployment and we have neither a session nor a door key:
  // go get one. The home node round-trips through /auth back to here.
  if (!identity && authCfg?.required && authCfg?.login && !CONFIG.token) {
    location.href = authCfg.login;
    return;
  }
  // Not required, but this browser used to be logged in and isn't anymore —
  // re-login is silent while Discord still authorizes, so don't make them
  // rediscover the authority.
  if (bounceToLogin()) return;
  // the early socket (index.html's boot script) may have sent this exact join while modules parsed: adopt it only when
  // that join is byte-identical to ours, else close it and connect fresh. An optimization, never an authority.
  const early = globalThis.__ewEarlySocket;
  globalThis.__ewEarlySocket = null;
  if (early) {
    const wantJoin = JSON.stringify({ world: CONFIG.world, id: CONFIG.name,
      avatar: hooks.myAvatarPath(), token: CONFIG.token, ...(CONFIG.account ? { account: CONFIG.account } : {}) });
    const same = JSON.stringify(early.sent) === wantJoin;
    if (!early.failed && early.ws.readyState <= 1 && same) {
      net.status = 'connecting';
      bus.emit('net', net);
      net.ws = early.ws;
      joinRefusal = null;
      // drain what raced ahead IN ORDER while the boot script's handler still buffers; the rewire below is synchronous
      // with the final empty check, so nothing slips between
      while (early.buffered.length) {
        const raw = early.buffered.shift();
        // When the boot script's message handler ran, so the server's `t` it
        // carries is sampled then rather than after the wait for this drain. Undefined
        // from a boot script older than `arrived`: the sample is taken now.
        const at = early.arrived?.shift();
        let msg;
        try { msg = JSON.parse(raw); } catch { continue; }
        try { await handle(msg, at); } catch (e) { report(`net ${msg.type}`, e); }
      }
      wireSocket(net.ws);   // live delivery takes over (onopen stays the boot script's)
      return;
    }
    // A socket mid-close (CLOSING) is about to say why: wait for its close (bounded) rather than dial over it.
    if (!early.closeInfo && early.ws.readyState === 2) await new Promise((res) => {
      const prev = early.ws.onclose; early.ws.onclose = (ev) => { try { prev?.(ev); } finally { res(); } }; setTimeout(res, 2000);
    });
    // a 4xxx close of the early join is the answer, not a reason to redial: close as a live socket would, with the
    // server's buffered words. Only for this page's own join; a refusal of any other join is discarded with the socket.
    if (same && early.closeInfo?.code >= 4000) {
      net.status = 'connecting';
      for (const raw of early.buffered) {
        let msg; try { msg = JSON.parse(raw); } catch { continue; }
        if (msg?.type === 'error') noteRefusal(msg.error);
      }
      onSocketClosed(early.closeInfo);
      return;
    }
    try { early.ws.close(); } catch { /* already dead */ }
  }
  joinRefusal = null;
  net.status = 'connecting';
  bus.emit('net', net);
  net.ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  net.ws.onopen = () => { sendJoin(); };
  wireSocket(net.ws);
}

/** close/error/message wiring, shared by a fresh connect and an adopted
 *  early socket (the inline boot script in index.html — see connect()). */
function wireSocket(ws) {
  ws.onclose = onSocketClosed;

  ws.onerror = () => { /* onclose always follows; nothing useful here */ };

  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    try { await handle(msg); } catch (e) { report(`net ${msg.type}`, e); }
  };
}

/** What the server said when it refused this join: the `error` that arrives before the snapshot is the refusal's own
 *  words, and the close (4005 …) that follows shows THEM rather than a guess from the code. Reset per connection. */
let joinRefusal = null;
function noteRefusal(text) { if (!net.joined && text) joinRefusal = String(text); }

/** A refused join, shown where the person is looking: the splash stays (or comes back) with the server's sentence on
 *  it (boot.js refuseBoot) — never a toast under the splash over an empty world. */
function showRefusal(text) {
  net.status = 'rejected';
  bus.emit('net', net);
  failSays();
  refuseBoot(text);
  bus.emit('join-refused', { text });
}

/** The socket's close, live or the early socket's (connect()). One place decides what each close code means. */
function onSocketClosed(ev) {
  // a socket already replaced (rejoin dials before the old close lands: it waits at most 2 s) answers its own requests
  // and nothing else: the live socket's requests, its join and its clock are not its to end (house review I62)
  const sock = ev?.target ?? null;
  failPending(sock);
  if (sock && net.ws && sock !== net.ws) { if (sock === intentionalClose) intentionalClose = false; return; }
  clearInterval(clockTimer); clockTimer = null;
  net.joined = false;
  // rejoin() drives its own reconnect, for the socket it replaced only: the NEW socket dropping before the old close
  // lands must still redial (review of I62: a shared flag let the new socket's close use it up, and nothing redialled)
  if (intentionalClose && (intentionalClose === true || intentionalClose === sock || !sock)) { intentionalClose = false; return; }
  // 4002 = session takeover: this identity re-arrived elsewhere. Retrying
  // would kick THAT session and ping-pong forever.
  if (ev.code === 4002) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    toast(`"${CONFIG.name}" is connected in another tab. This one has yielded — reload to take over.`, 'warn', 60000);
    return;
  }
  // 4006 = removed by moderation; the server already explained. No retry: an auto-rejoin would make a kick meaningless.
  if (ev.code === 4006) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    toast('you were removed from this world — reload if you believe you may return', 'warn', 60000);
    return;
  }
  // 4010 = this world is not open to you (access.ts ACCESS_CLOSE): refused at the door (listed people only, watch only),
  // or your access just ended or was changed. The server said why in an `error` just before closing. No retry — the
  // door won't open on its own; coming back is a deliberate reload (or ?spectate, when it said you may watch).
  if (ev.code === 4010) {
    showRefusal(joinRefusal ?? `you're not in "${CONFIG.world}" — reload if your access changes`);
    return;
  }
  // 4011 = there's nothing to watch here YET (a spectator of a world nobody has founded): not a refusal — try again,
  // backing off, so an observer started early joins once the world exists.
  if (ev.code === 4011) {
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  // 4005 = a refused join: no retry (the answer won't change); show the server's preceding `error`, else words from the
  // close reason. 4005 "full" is TRANSIENT (the access max): say so and retry with backoff, never pinned as the answer.
  if (ev.code === 4005 && String(ev.reason ?? '') === 'full') {
    const text = `${joinRefusal ?? `"${CONFIG.world}" is full`} — trying again by itself`;
    if (!waitBoot(text)) toast(text, 'warn', 8000);
    net.status = 'retrying';
    bus.emit('net', net);
    setTimeout(connect, redial.next(REDIAL.full));
    return;
  }
  if (ev.code === 4005) {
    const why = String(ev.reason ?? '');
    showRefusal(joinRefusal ?? (
      /old-format/i.test(why) ? `"${CONFIG.world}" was saved by an older version of Eidoverse and needs a one-time conversion by whoever runs this server. Nothing is lost.`
      : /no such world/i.test(why) ? `there's no world called "${CONFIG.world}" here — check the link that brought you here`
      : /world name/i.test(why) ? `"${CONFIG.world}" is not a valid world name — check the link that brought you here`
      : `"${CONFIG.world}" refused this visit${why ? ` (${why})` : ''} — reload to try again`));
    return;
  }
  // 4003 = bad or missing door key. This used to fall through to the generic
  // retry, so a wrong key hammered the authority forever while the client said
  // "disconnected — retrying…" and never explained why.
  if (ev.code === 4003) {
    net.status = 'rejected';
    bus.emit('net', net);
    failSays();
    // entered verified: this refusal means the session died server-side; drop the stale identity and re-login rather
    // than ask for a key this person never had
    if (CONFIG.authed) {
      identity = null;
      CONFIG.authed = false;
      if (bounceToLogin()) return;
    }
    bus.emit('bad-key');
    return;
  }
  net.status = 'retrying';
  bus.emit('net', net);
  setTimeout(connect, redial.next()); // back off instead of hammering
}

// ---------------------------------------------------------------- handling

/** ONE teardown for a departed participant: every leave-shaped exit funnels here so the whole generation dies together
 *  (#95). Drag custody goes first (a drag sim holds bone refs into the avatar), then the body and all that hangs off it.
 *  `expected` makes the drop generation-conditional (see dropRemote). */
export function teardownParticipant(id, expected) {
  // the generation check comes BEFORE any side effect: a predecessor's stale cleanup must be a complete no-op
  if (expected && remotes.get(id) !== expected) return null;
  bus.emit('participant-teardown', id);   // bodydrag releases custody before the bones vanish
  const dropped = dropRemote(id, expected);
  return dropped;
}

/** Presence for an id the world never announced (or already dismissed) is
 *  dropped, counted, and said a few times — the flight-recorder spirit,
 *  the noteMalformed bound. */
let stalePresenceSeen = 0;
export const stalePresenceCount = () => stalePresenceSeen;
/** test seam — the wire, minus the socket (tools/remotes-lifecycle-test.ts
 *  drives the dispatch directly; the server's per-socket FIFO is the test's
 *  license to sequence messages by hand) */
export const _dispatch = (msg) => handle(msg);
function noteStalePresence(id) {
  if (stalePresenceSeen++ >= 5) return;
  console.warn(`[net] presence for unannounced id "${id}" dropped (straggler from a departed generation?)`);
}

/** `at`: the performance.now() when the boot script's handler took an
 *  early-socket message (the drain in connect()); undefined for a message
 *  handled as its event runs. */
async function handle(msg, at) {
  switch (msg.type) {
    case 'snapshot': startClock(); return onSnapshot(msg);

    // two answers share the name: a round trip's ({t0, t}, askClock) and the server's one-way time sent before each
    // snapshot ({t} alone), so the first seek isn't on this machine's clock (serverclock.js says how each is kept)
    case 'clock': if (msg.t0 !== undefined) noteRoundTrip(msg.t0, msg.t, localNow()); else noteServerTime(msg.t, at); break;

    case 'your-rights': {
      // Personalized effective rights, folded by the authority after every
      // grant. This is the live answer for wildcard/sub/name precedence; the
      // browser never has to approximate it from one partial delta.
      if (msg.rights) {
        net.myRights = msg.rights;
        bus.emit('your-rights', net.myRights);
      }
      break;
    }

    case 'arrive':
      // `authority: true`: an arrive is the world SAYING this person exists. On a takeover (same id re-arriving) the
      // predecessor retires whole first (the teardown event releases drag custody), and ensureRemote resets the mesh's
      // transient expressions
      if (remotes.has(msg.id)) bus.emit('participant-teardown', msg.id);
      bus.emit('participant-session', { id: msg.id, session: msg.session });
      ensureRemote(msg.id, msg.avatar, { declares: msg.declares ?? null, authority: true });   // §6a: a declared status (any word), absent = undeclared; shown as said, never sorted into kinds
      if (msg.actorId) identities.set(msg.id, msg.actorId);
      if (msg.guest) guests.add(msg.id); else guests.delete(msg.id);
      logChat('*', `${msg.id} arrived`);
      bus.emit('roster');
      break;

    case 'leave':
      teardownParticipant(msg.id);
      logChat('*', `${msg.id} left`);
      bus.emit('roster');
      break;

    case 'pose': {
      // presence UPDATES bodies, never creates them (#95): the server orders a living body's authority before its
      // first sample, so a pose for an unknown id is a departed generation's straggler, and creating would rebuild a ghost
      if (remotes.has(msg.id)) pushPose(msg.id, msg.pose, msg.t);
      else noteStalePresence(msg.id);
      break;
    }

    case 'frame': {
      // batched poses (latest per id per tick): same law as `pose`, update-only, never create
      noteServerTime(msg.t, at);
      for (const [id, pose] of Object.entries(msg.poses)) {
        if (id === net.myId) continue; // our own echo — local prediction owns this body
        if (remotes.has(id)) pushPose(id, pose, msg.t);
        else noteStalePresence(id);
      }
      break;
    }

    case 'drag': {
      // transient build feedback — apply without logging anything
      bus.emit('drag', msg);
      break;
    }

    case 'history': case 'debug': {
      const p = pendingHistory.get(msg.reqId);
      if (p) { pendingHistory.delete(msg.reqId); p(msg); }
      break;
    }

    // SFU transport (VOICE_TRANSPORT=sfu). No default branch: an unrouted type is dropped silently
    case 'sfu-offer': bus.emit('sfu-offer', msg); break;
    case 'sfu-ice':   bus.emit('sfu-ice', msg);   break;
    case 'sfu-route': bus.emit('sfu-route', msg); break;
    case 'relay-cred':          // #104: the minted media credential (voicerelay.js)
      window.__voiceRelayAbsent = false;   // a relay answered: an earlier "no relay" (a server restarted without voice) is over
      bus.emit('relay-cred', msg);
      break;
    case 'voice-consent':       // #104: server's ack of a receive-consent change
      bus.emit('voice-consent-ack', msg);
      break;
    case 'voice-service':       // #104 A2: relay service state, incarnation-stamped
      bus.emit('voice-service', { state: msg.state, incarnation: msg.incarnation });
      break;
    // #57 B1/B4 presence messages (never logged):
    // performed — an authenticated voice leg attested it aired this say;
    // surface-transition — an aux leg joined or took over (capability signal).
    case 'performed':
      bus.emit('performed', { actor: msg.id, seq: msg.seq, gen: msg.gen });
      break;
    case 'surface-transition':
      bus.emit('surface-transition', { actor: msg.id, surface: msg.surface, gen: msg.gen, retired: msg.retired });
      break;

    case 'caption':
      // live speech pacing (presence, never logged) — the bubble speaks in
      // real time; the log gets the whole utterance as one say at the end
      bus.emit('caption', { actor: msg.id, text: msg.text });
      break;

    case 'typing':
      if (msg.id !== net.myId) {
        noteTyping(msg.id);                                // chat window "X is typing…"
        remotes.get(msg.id)?.avatar?.setTyping(msg.state); // dots — or a state glyph
      }
      break;

    case 'anim': {
      if (msg.id === net.myId) break;
      remotes.get(msg.id)?.avatar?.playAnimation(msg);
      break;
    }

    case 'puppet':
      // Someone wants to pose US. A puppet is an INPUT to our own body, not a
      // pose asserted onto it — main.js decides whether to honour it and then
      // drives our avatar through the normal presence path.
      bus.emit('puppet', msg);
      break;

    case 'bodydrag':
      // someone is (asking to be, or currently) dragging MY body — same
      // doctrine as puppet: an input my client applies to itself, or refuses
      bus.emit('bodydrag', msg);
      break;

    case 'holds':
      // who holds what (the authority's presence plane, design 20 P2): thingphysics.js draws each held thing in its holder's hand
      bus.emit('holds', msg.holds ?? {});
      break;

    case 'geom':
      // the placeholder tier's bbox side-channel — arrives a beat after the
      // snapshot (async summaries; the join send stays synchronous). Bus,
      // not import: the models realizer listens (net must not import it).
      bus.emit('lib-geom', msg.geom ?? {});
      break;

    case 'body-inbox':
      // the authority's body inbox (PROTOCOL L6): asks waiting for me, replies to my asks, acts delivered, revocations.
      // people.js holds them (consentinbox.js), marks the asker's row in People Here and offers Allow / Not now / Never.
      bus.emit('body-inbox', msg);
      break;
    case 'log': onLog(msg); break;
    case 'reply': onReply(msg); break;

    case 'renderer-travel':
      // a roaming renderer is wanted elsewhere (server/snapshots.ts summon): go there — the same in-page re-join a
      // person's travel uses. Only a roaming renderer obeys; anyone else ignores it.
      if (CONFIG.renderer && CONFIG.roam && typeof msg.world === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(msg.world) && msg.world !== CONFIG.world) {
        CONFIG.world = msg.world; rejoin();
      }
      return;

    case 'capture':
      // The reply is the snapshot's to produce and the wire's to send, so a client
      // without a renderer answers with an error instead of going quiet on an id
      // someone is waiting for. See net_capture.js (wired by main.js).
      capture(msg).then((r) => net.ws?.send(JSON.stringify({ type: 'capture-result', id: msg.id, ...r })));
      return;

    case 'avatar-updated': {
      // an avatar file was re-uploaded: drop stale bytes and hot-swap wearers
      const fresh = `${msg.path}?v=${msg.v}`;
      forgetBytes(msg.path);
      bus.emit('avatar-updated', { ...msg, fresh });
      for (const [id, r] of remotes) {
        if (r.avatarPath && r.avatarPath.split('?')[0] === msg.path) ensureRemote(id, fresh);
      }
      logChat('*', `avatar "${msg.name}" updated (v${msg.v})`);
      break;
    }

    case 'avatar-profile-updated': {
      // a seat profile was proposed or countersigned (#101) — occupants.js holds
      // the cache and the generation guard; this is just the wire → bus hop
      bus.emit('avatar-profile-updated', msg);
      break;
    }

    case 'defs-updated': {
      // a def changed on disk (§24 hot reload) — wire → bus hop; world.js
      // re-fetches the registry and regrows what the changed content shapes
      bus.emit('defs-updated', msg);
      break;
    }

    case 'world-forked': {
      // The link stands alone at the end of the line, never inside brackets —
      // naive linkifiers (ours included, once) swallow closing punctuation
      // into the URL, and ?world=name) points at a world that cannot exist.
      const link = `${location.origin}/?world=${encodeURIComponent(msg.to)}`;
      logChat('*', `world copied — "${msg.from}" → "${msg.to}" — visit: ${link}`);
      toast(`copied to "${msg.to}" — open ?world=${msg.to} to visit`, 'info', 12000);
      break;
    }

    case 'world-founded': {
      const link = `${location.origin}/?world=${encodeURIComponent(msg.name)}`;
      logChat('*', `your new world "${msg.name}" is ready — you own it — visit: ${link}`);
      toast(`founded "${msg.name}" — open ?world=${msg.name} to go there`, 'info', 12000);
      bus.emit('world-founded', msg);
      break;
    }

    case 'world-reset': {
      // the world was reset: everything here was built from a now-empty log, and a reload through the normal join is
      // the one rebuild that can't disagree with the server
      toast(`${msg.by} reset "${msg.world}" to zero — reloading…`, 'warn', 4000);
      logChat('*', `${msg.by} reset this world to zero`);
      shadowReset();
      setTimeout(() => location.reload(), 1800);
      break;
    }

    case 'mod':
      // Moderation replies (ban lists, global-ban confirmations) — chat is
      // where the person is looking when they issue the command.
      for (const line of String(msg.text ?? '').split('\n')) logChat('*', line);
      break;
    case 'moderated':
      // someone was removed or banned here (or a ban lifted): what everyone else is told (names only).
      // `you`: the act was on you (a mute): said to you, with how long
      if (msg.you) { const until = msg.until ? ` until ${new Date(msg.until).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : '';
        const what = msg.verb === 'mute' ? `muted your ${(msg.channels ?? ['voice', 'chat']).join(' and ')}` : msg.verb;
        logChat('*', `${msg.by} ${what}${until}${msg.reason ? ` — ${msg.reason}` : ''}`); bus.emit('moderated-me', msg); }
      else logChat('*', String(msg.text ?? ''));
      break;
    case 'warned':
      // a warning (research roles §5): a notice you dismiss, and a line in chat to keep
      logChat('*', `${msg.by} warned you: ${String(msg.reason ?? '')}`);
      bus.emit('warned', msg);
      break;
    case 'mod-state':
      net.modMuted = msg.muted && typeof msg.muted === 'object' ? msg.muted : {};
      bus.emit('roster');
      break;

    case 'access-state':        // the world panel's 🔒 access tab (accesspanel.js)
    case 'access-directory':
      bus.emit(msg.type, msg);
      break;

    case 'notice':
      // a notice that isn't a refusal (today: access ending soon): toast and chat. Not an `error`, which would tell
      // every optimistic preview its verb was refused.
      toast(String(msg.text ?? ''), 'warn', 20000);
      logChat('*', String(msg.text ?? ''));
      break;

    case 'error':
      // the world tells us it has no voice relay only when we try to use one —
      // remember it, so the mic glyph can say WHY it stays off (R, 09-04)
      if (/no voice relay/i.test(String(msg.error ?? ''))) window.__voiceRelayAbsent = true;
      noteRefusal(msg.error);   // before the snapshot, an error is the join's refusal: its close shows these words
      // Server-side refusals are the user's problem to see, not the console's.
      toast(msg.error, 'warn');
      // ...and optimistic previews must hear it: a refused verb never folds (lights.js rolls back off this). The wire
      // names no verb; every refusal on this socket is ours.
      bus.emit('verb-refused', { error: String(msg.error ?? '') });
      break;
  }
}

async function onSnapshot(msg) {
  // what the server says you may do here; live grants keep it fresh via world.js
  net.myRights = msg.yourRights ?? { role: 'builder', gen: true };
  // the body roster rides the snapshot — resolveMyAvatarPath and the avatar
  // panel read it with no /avatars round-trip (older servers: field absent,
  // consumers fall back to the lazy fetch)
  if (msg.avatars) { net.avatars = msg.avatars; bus.emit('avatars', msg.avatars); }
  bus.emit('your-rights', net.myRights);
  markPhase('connect', 1);
  net.joined = true;
  redial.reset();
  net.status = 'live';
  net.myId = msg.you;
  net.mySub = msg.yourSub ?? null;
  net.renameAfter = msg.renameAfter ?? null; net.renameCooldownDays = msg.renameCooldownDays ?? null;   // profile.js's name dialog
  if (msg.renameRefused) { const d = new Date(msg.renameRefused.until);
    toast(`still “${msg.you}”: names change once every ${msg.renameCooldownDays} days — “${msg.renameRefused.tried}” can be yours from ${d.toLocaleDateString([], { month: 'short', day: 'numeric' })}`, 'info', 12000); }   // the durable subject the authority vouched for, if any — what guarded things match on
  // the server's `you` is authoritative (verified identity, or a suffixed name): adopt it and say so. Strip the
  // transport prefix ("renderer-"/"retina-") first or ew-name grows one per reload, unless the ack is a verified
  // identity (base.js nameFromJoinAck)
  const you = nameFromJoinAck(msg.you, { renderer: CONFIG.renderer, spectate: CONFIG.spectate, verified: !!msg.yourSub });
  if (you && you !== CONFIG.name && !msg.renameRefused) {
    CONFIG.name = you;
    localStorage.setItem('ew-name', you);
    toast(`you're appearing as “${msg.you}”`, 'info', 8000);
  } else if (msg.renameRefused) { CONFIG.name = msg.you; localStorage.setItem('ew-name', msg.you);
    try { const u = new URL(location.href); if (u.searchParams.has('name')) { u.searchParams.set('name', msg.you); history.replaceState(null, '', u); } } catch { /* fine */ } }
  // a RE-join: what was said after lastSeq may be trimmed from this snapshot's chat window, so fetch it first (lastSeq
  // is in chat numbering, seq × 1000). A first join is a no-op.
  if (lastSeq >= 0) void resyncChatAfter(lastSeq);
  if (typeof msg.throughSeq === 'number' && msg.throughSeq > lastSeq) lastSeq = msg.throughSeq;
  bus.emit('net', net);
  bus.emit('participant-sessions', msg.present ?? []);
  // #57 matrix 7: who has which aux legs live NOW (surface-transition keeps it
  // current after this). Consumers key hold-then-fallback TTS on it.
  bus.emit('surfaces', [...(msg.present ?? []),
    ...(msg.yourSurfaces?.length ? [{ id: msg.you, surfaces: msg.yourSurfaces }] : [])]);

  if (msg.recording && !onSnapshot._noted) {
    onSnapshot._noted = true;
    logChat('*', '⏺ this performance is being recorded (movement + chat, for the archive)');
  }

  // wake where you fell asleep — but never teleport a body that has already
  // moved this session (mid-session reconnects keep local truth)
  const s = hooks.myState;
  // no live body can't have moved, so the restore lands (a renderer-free client has none, #188); the guard only
  // protects a body that already moved this session
  if (msg.restore && !restoredPose && (!s || s.speed === 0)) {
    restoredPose = true;
    hooks.onRestore(msg.restore);
  }
  restoredPose = true; // first snapshot decides, restore or not

  // reconcile: the snapshot is authoritative; tear down absent participants through the same funnel a leave uses
  // (custody, then body), or stale ghosts survive reconnects
  const present = new Set(msg.present.map((p) => p.id));
  for (const id of [...remotes.keys()]) if (!present.has(id)) teardownParticipant(id);

  // remote avatars build in parallel and never block log replay — the
  // roster is an AUTHORITY: a same-id record here is a fresh generation
  identities.clear(); guests.clear(); if (msg.cut?.you) net.you = msg.cut.you;
  for (const p of msg.present) {
    if (p.actorId) identities.set(p.id, p.actorId);
    if (p.guest) guests.add(p.id);
    ensureRemote(p.id, p.avatar, { declares: p.declares ?? null, authority: true })
      .then(() => { if (p.pose) pushPose(p.id, p.pose); })
      .catch((e) => report(`present ${p.id}`, e));
  }

  // State adopts the snapshot FIRST, synchronously: the authority's own cut, drawn as the view of THIS client's fold of it
  // (the snapshot's `state` is the chat window: chat isn't world state).
  if (!msg.cut?.state) { replica.reset(); report('snapshot', new Error('the server sent no world cut (an old server?)')); return; }
  replica.adopt(msg.cut); bus.emit('my-acts', msg.cut.mine ?? []); bus.emit('cut-adopted'); bus.emit('holds', msg.cut.holds ?? {});
  shadowHydrate(replica.view(msg.state), typeof msg.throughSeq === 'number' ? msg.throughSeq : -1);

  hydrating = true; pendingLive = [];
  // flush the chat lines that raced us, in order, once, after the hydration window so a raced say lands below the
  // arrival chat window, not above it.
  const backlog = pendingLive.filter((e) => (e.seq ?? -1) > lastSeq).sort((a, b) => a.seq - b.seq);
  pendingLive = []; hydrating = false;
  for (const e of backlog) {
    lastSeq = e.seq;
    bus.emit('live-entry', e);
  }

  const rc = msg.state?.recentChat ?? [];
  noteHistoryContext({
    total: msg.state?.chatTotal ?? null,
    // what was actually rendered (state.recentChat, 40-line cap); older lines are fetchable by paging, and this count
    // drives the "showing N of M" hint
    shown: rc.length,
    spanMs: rc.length > 1 ? rc[rc.length - 1].ts - rc[0].ts : null,
  });

  // world progress tracks the scheduler's outstanding entity loads (boot.js weights 'world' at 40); the curtain
  // doesn't wait on it (checkReady: body + state + terrain + the first sky's warm)
  const initialPending = pending(P.FAR);
  if (initialPending > 0) {
    markPhase('world', Math.max(0.15, 1 - initialPending / (initialPending + 1)));
    const tickProgress = setInterval(() => {
      const left = pending(P.FAR);
      markPhase('world', 1 - 0.85 * (left / initialPending));
      if (!left) { clearInterval(tickProgress); markPhase('world', 1); }
    }, 200);
  } else markPhase('world', 1);
  bus.emit('hydrated');
  bus.emit('roster');
  hooks.onSnapshotDone();
  flushSays();   // what was typed while we were away, now that the world is back (after its chat window, so it reads in order)
}
