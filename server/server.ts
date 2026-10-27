// eidoverse-worlds sequencer: a sequencer and archivist, NOT a simulator:
//  - orders + persists per-world event logs (the authored plane)
//  - relays presence (the embodied plane, never persisted)
//  - serves the browser client and the eidoverse-video asset library
// No world manifest: everything about a world arrives through its log.

import { nameAtDoor } from "./names.ts";
import { existsSync, appendFileSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
// config FIRST: this import order IS the boot order, mkdir → session restore → ban restore (§15, step 7a)
import { TRUST_NAMES } from "./config.ts";
// how often a person may change the name they show (moderation: a name is how people recognise who did what)
const RENAME_COOLDOWN_MS = envNumber("RENAME_COOLDOWN_DAYS", 7) * 86400000;
import { PORT, HOST, JOIN_TOKEN, RENDERER_TOKEN, RECORD, ROOT, WORLDS_DIR, LIBRARY_DIR, OPT_DIR, MSG_RATE, FRAME_MS, FRAME_SKIP_BUFFERED, SNAP_TIMEOUT_MS, SNAP_SWEEP_GRACE_MS, SNAP_SWEEP_EVERY_MS } from "./config.ts";
import { type HnSession, agentTokens, aid1JoinIdentity } from "./auth.ts";
import { addrSanctionsFor, saveAddrSanctions } from "./moderation.ts";
import { entryFor, doorOfWorld, whoOf, settleAccess, sweepAccess, setLoadedWorlds, NOT_YET_CLOSE, type Expel } from "./access.ts";
import { isOperator } from "./operators.ts";
import { resolveLibFile } from "./libfile.ts";
import { summarizeGlb } from "./geometry.ts";
// the world and its registry; the boot sweep stays here (boot policy, not world mechanics)
import { World, type Client, worlds, getWorld, worldExists, wireSettledPose, wireRights, authorityNow } from "./world.ts";
import { isWorldSaved } from "./worldlog.ts";
import { oldWorldAt, bootNotice, noFoldRefusal } from "./oldworlds.ts";
import { isNativeSession } from "./native-login.ts";
import { custodyFileIn, directoryFileIn } from "./keyfiles.ts";
import { requestHandler, actorOf as actorIdOf, gagged, guestSanctionByAddress, requestAs } from "./requestwire.ts";
import { withoutOnceAnim } from "../shared/onceanim.js";
import { directoryFor, foldName } from "./directory.ts";
// the HTTP surface: one route table, /upload in upload.ts (§15, 7c)
import { route, avatarRoster } from "./routes.ts";
import { snapshots } from "./snapshots.ts";
import { registerSystem, startTick } from "./tick.ts";
import { MESSAGES } from "./messages.ts";
import { LIMITS, envNumber } from "./limits.ts";
import { defsFingerprint } from "./defs.ts";
// seat profiles (#101, §24r): routes.ts owns the HTTP half, seats.ts the one store and the update push
import { seatStore } from "./seats.ts";
import { announceProfileUpdate } from "./seats.ts";
import { OPT_DIR, PATCH_DIR } from "./config.ts";
// relay floor (#104)
import { relayEnabled, bootIncarnation, currentIncarnation, voiceTransport } from "./transport.ts";
import { installSfuTransportGuard } from "./sfuguard.ts";
import { onVoiceServiceChange, markVoiceDegraded, voiceServiceState } from "./sfusupervisor.ts";
import { isOwner } from "../shared/protocol/roles.js";
import { newBucket, admitMessage } from "./msgrate.ts";
import { mintSfuCredential, setSfuConsent, setSfuModeratorMute, revokeSfuLeg, sfuDiag,
  sfuAcceptAnswer, sfuAcceptIce, sfuNegotiate, sfuSetPosition, registerSfuSender, admitSfuLeg, liveLegState, sfuLegAdmitted, markSfuLegAdmitted } from "./sfuadapter.ts";
// the incarnation is DURABLE (tmp+rename), so a restart strands every old credential (transport.ts)
bootIncarnation(process.env.RELAY_STATE_DIR ?? OPT_DIR);

// installed here once, never as a side effect of constructing an Sfu; a voice fault leaves text, presence and builds up
installSfuTransportGuard((err, kind) => markVoiceDegraded(`${kind}: ${String(err).slice(0, 120)}`));

// stamped with the incarnation, so a client tells "restarted" (one fresh join) from "flapped"
onVoiceServiceChange((state, incarnation, why) => {
  const msg = JSON.stringify({ type: "voice-service", state, incarnation, reason: why });
  for (const w of worlds.values()) for (const t of w.clients) t.ws.send(msg);
  console.log(`[sfu] voice-service ${state} (${incarnation})`);
});

/** Same funnel as every surface death: revoke, burn the credential, broadcast. A relay outage must never wedge a close. */
function retireRelayLeg(w: World, id: string) {
  if (!relayEnabled()) return;
  // the SFU leg must retire too, or a reconnect inherits a consent the fresh leg never gave (fail-open on privacy)
  const leg = revokeSfuLeg(w.name, id);
  if (leg) {
    const retire = JSON.stringify({ type: "surface-transition",
      id, surface: "voice-relay", gen: null, retired: leg.gen });
    for (const t of w.clients) t.ws.send(retire);
    console.log(`[world:${w.name}] ${id}/voice-relay revoked — gen ${leg.gen}`);
  }
}

/** The pose to hand to SOMEONE ELSE: no one-shot anims (a moment, not a place), no ragdoll (only the faller's session
 *  can get up); held bones survive (#61). */
function settledPose(pose: unknown): Record<string, unknown> | null {
  if (!pose) return null;
  // mic/hear are a live reading: remembered, a new session would replay a voice state it never had
  // t/seq: a sample's capture time and count (spec/PHYSICS.md §5.1) belong to that one sample, never to a remembered body
  const { mic: _mic, hear: _hear, t: _t, seq: _seq, ...still } = withoutOnceAnim(pose as Record<string, unknown>);
  if (still.clip === "ragdoll") { still.clip = "idle"; delete still.pose; }
  return still;
}
// one settle rule for both planes, injected into world.ts; settled-pose-test's source gates (§15.1) pin it here
wireSettledPose(settledPose);
// a role change re-sends everyone's rights, and whoever may no longer be here is removed (access.ts settleAccess, 4010)
wireRights(
  (w) => { for (const c of w.clients) { try { c.ws.send(JSON.stringify({ type: "your-rights", rights: rightsFor(w, c) })); } catch { /* gone */ } }
    settleAccess(w, expel as Expel); },
);

// ------------------------------------------------------------------ presence

// ---- surface-session retirement (#57): one broadcast + one reap on every death path (listeners key TTS fallback on it)

/** Announce one accepted aux leg's death; no gen, no session, no event (a refused impostor leaves zero trace). */
function retireAuxLeg(w: World, leg: Client, except?: Client) {
  if ((leg.surface ?? "world") === "world" || leg.gen == null) return;
  const retire = JSON.stringify({ type: "surface-transition",
    id: leg.id, surface: leg.surface, gen: null, retired: leg.gen ?? null });
  for (const t of w.clients) if (t !== leg && t !== except) t.ws.send(retire);
}

/** A primary died (close, expel, travel): reap every aux leg of its identity. Retire BEFORE unmapping, or the ws close
 *  handler finds nothing and never broadcasts. */
function reapAuxLegs(w: World, primary: Client, closeReason: string) {
  // the RELAY leg dies with its primary (#104 A1): primary retirement revokes the media credential
  retireRelayLeg(w, primary.id);
  for (const t of [...w.clients]) {
    if (t !== primary && t.id === primary.id && (t.surface ?? "world") !== "world") {
      retireAuxLeg(w, t, primary);
      snapshots.retire(t);
      w.clients.delete(t); clients.delete(t.ws);
      t.ws.close?.(4007, closeReason);
      console.log(`[world:${w.name}] ${primary.id}/${t.surface} reaped — ${closeReason}`);
    }
  }
}

/** NOW (kick/ban): roster, client map, socket and the leave broadcast, or a ghost is left. */
function expel(w: World, target: Client, why: string, until?: number | null, code = 4006) {
  // `until`: when they may come back (an agent host reconnects then)
  // `code`: 4006 moderation, 4010 access ended (access.ts ACCESS_CLOSE); neither is redialled
  try { target.ws.send(JSON.stringify({ type: "error", error: why, ...(until ? { until } : {}) })); } catch { /* going anyway */ }
  const wasEmbodied = !target.spectator;
  snapshots.retire(target);
  // an expelled AUX leg announces its own death; an expelled PRIMARY takes its aux legs with it (kick/ban target the identity)
  retireAuxLeg(w, target);
  if (wasEmbodied) reapAuxLegs(w, target, "primary removed by moderation");
  if (wasEmbodied && target.lastPose && target.actorId && !target.anonymous) w.rememberPose(target.actorId, target.lastPose); // by identity, never by name
  target.superseded = true;   // the close path must not double-handle it
  w.clients.delete(target);
  clients.delete(target.ws);
  target.world = null;
  target.ws.close?.(code, code === 4010 ? "access ended" : "removed by moderation");
  if (wasEmbodied) { w.broadcast({ type: "leave", id: target.id }); w.scripts.onPresence("leave", target.id, target.actorId); }
  if (wasEmbodied && target.actorId) w.log?.departed(target.actorId); // what they held drops into the world (design 20)
}

// Operator-log census: people are people, eyes are eyes.
function describe(w: World): string {
  const real = [...w.clients].filter((c) => !c.spectator).length;
  const eyes = w.clients.size - real;
  return `${real} present${eyes ? `, ${eyes} watching` : ""}`;
}

// access expiry: a grant stands until the authority writes its end (expire-roles), so a replay agrees
setLoadedWorlds(() => worlds);
registerSystem({ name: "access-sweep", everyMs: Math.max(250, envNumber("ACCESS_SWEEP_MS", 1000)),
  fn: (now) => sweepAccess(worlds.values(), expel as Expel, now) });

// countersign has no HTTP path (#101): tools/seat-accept.ts edits the store from another process; this notices and pushes
registerSystem({ name: "seat-store-poll", everyMs: 5000, fn: () => {
  const ext = seatStore.pollExternalChange();
  if (!ext) return;
  for (const ch of ext.changed) {
    const notified = announceProfileUpdate(ch.name, ch.pose, ext.rev);
    console.log(`[seats] external change ${ch.name}/${ch.pose} rev ${ext.rev} → ${notified} client(s)`);
  }
} });

// the engine's heartbeat, not inside whoever's request comes next; bounded by engine ticks, a stall catches up over beats
registerSystem({ name: "physics", everyMs: FRAME_MS, fn: () => {
  for (const w of worlds.values()) { try { w.log?.settle(); } catch (err) { console.error(`[world:${w.name}] physics settle`, err); } }
} });
// script timers run with nobody connected: the point of scripts living server-side
registerSystem({ name: "behaviors", everyMs: 1000, fn: (now) => {
  for (const w of worlds.values()) {
    try { w.scripts.tick(now); } catch (err) { console.error(`[world:${w.name}] behavior tick`, err); }
  }
} });

// def hot-reload (overhaul-charter §3): one `defs-updated` when defs/'s fingerprint moves; the first is the baseline
let defsFp: string | null = null;
registerSystem({ name: "defs-watch", everyMs: 1000, fn: () => {
  const fp = defsFingerprint();
  if (defsFp !== null && fp !== defsFp) {
    const update = JSON.stringify({ type: "defs-updated" });
    let notified = 0;
    for (const w of worlds.values()) for (const c of w.clients) { c.ws.send(update); notified++; }
    console.log(`[defs] changed on disk → defs-updated pushed to ${notified} client(s)`);
  }
  defsFp = fp;
} });

// shared key files under their current names (server/keyfiles.ts), before any world or join reads them
try { custodyFileIn(WORLDS_DIR); directoryFileIn(WORLDS_DIR); } catch (err) { console.error("[boot] key files", err); }

// a world with scripts wakes WITH the server; a byte-scan decides (a false hit just loads once for nothing)
try {
  let woken = 0;
  for (const name of readdirSync(WORLDS_DIR)) {
    try {
      if (!/^[a-z0-9_-]{1,64}$/i.test(name) || !isWorldSaved(name)) continue;
      if (readFileSync(join(WORLDS_DIR, name, "world.jsonl"), "utf8").includes('"script:')) { getWorld(name); woken++; }
    } catch (err) { console.error(`[boot] world ${name} peek failed`, err); }
  }
  if (woken) console.log(`[boot] ${woken} scripted world(s) woken — their scripts run without visitors`);
} catch (err) { console.error("[boot] world sweep failed", err); }
// old-format worlds are not served, and the operator is told how to translate each (server/oldworlds.ts)
try { const notice = bootNotice(WORLDS_DIR); if (notice) console.log(notice); } catch (err) { console.error("[boot] old-world notice failed", err); }

let nextClientNum = 1;
const clients = new Map<unknown, Client>();
snapshots.setClients(() => clients.values());   // roaming renderers are found across worlds
// …and sent only where they will be let in (access.ts)
snapshots.setAdmission((w, c) => entryFor(doorOfWorld(w), whoOf(c), "watch") === null);
snapshots.setFrameTimeout(SNAP_TIMEOUT_MS);
snapshots.setSweepGrace(SNAP_SWEEP_GRACE_MS);
// the backstop; a roamer joining also sweeps
setInterval(() => { try { snapshots.sweep(); } catch (e) { console.error("[snap] sweep failed:", e); } }, SNAP_SWEEP_EVERY_MS);
// transport-epoch source (#57): global, so a gen never collides across worlds or reloads; never persisted
let GEN = 0;
// `session` on arrive/present: the page's own id (outlives a reconnect), else a fresh token; observational only, never authority
const PAGE_SESSION_RE = /^[A-Za-z0-9_-]{8,64}$/;
const presenceSession = (c: Client) => (c.presenceSession ??= crypto.randomUUID());

/** Sent AFTER the snapshot: summaries are async, and the join must stay synchronous or messages interleave. */
function sendGeomFollowup(w: World, c: Client) {
  const libs = new Set<string>();
  for (const e of Object.values(w.state.entities)) if (e.model) libs.add(e.model);
  if (!libs.size) return;
  (async () => {
    const geom: Record<string, { bbox: unknown }> = {};
    for (const lib of libs) {
      try {
        const file = resolveLibFile(lib);
        const sum = file ? await summarizeGlb(file) : null;
        if (sum?.bbox) geom[lib] = { bbox: sum.bbox };
      } catch { /* no placeholder */ }
    }
    if (Object.keys(geom).length && c.ws.readyState === 1) {
      c.ws.send(JSON.stringify({ type: "geom", geom }));
    }
  })().catch((err) => console.error(`[world:${w.name}] geom followup`, err));
}

// -------------------------------------------------------------- http + ws

// ---- join: ADMISSION BEFORE TAKEOVER, by structure: admitJoin only answers or refuses (never the roster), installJoin
// is the only place a join mutates the roster, buildSnapshot is a pure read

/** PROTOCOL §6a: one lowercase word of its own, up to 32 characters (not a role id), else null. */
function declarationOf(v: unknown): string | null {
  return typeof v === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(v) ? v : null;
}
function admitJoin(c: Client, ws: { send(d: string): void; close(code?: number, reason?: string): void }, msg: any, auth: HnSession | null): World | null {
    // a malformed world name is a bad LINK: refuse with a close code the client won't retry
    const wname = String(msg.world ?? "commons");
    if (!/^[a-z0-9_-]{1,64}$/i.test(wname)) {
      ws.send(JSON.stringify({ type: "error", error: `"${wname}" is not a world name — check the link that brought you here` }));
      c.ws.close?.(4005, "bad world name");
      return null;
    }
    // joining never FOUNDS a world (RFC-005 §3.2.7): a name with no world behind it is refused
    if (worldExists(wname) && !isWorldSaved(wname)) {   // old format (server/oldworlds.ts); no old log = no world
      const old = oldWorldAt(WORLDS_DIR, wname);
      ws.send(JSON.stringify({ type: "error", error: old ? old.visitor : `there's no world called "${wname}" here — check the link that brought you here` }));
      c.ws.close?.(4005, old ? "old-format world" : "no such world");
      return null;
    }
    if (!worldExists(wname)) {
      // nothing to watch YET is not a refusal (#258: 4011, redialled); a body is refused (joining never founds)
      if (msg.spectate || msg.renderer) {
        ws.send(JSON.stringify({ type: "error", error: `there's no world called "${wname}" yet — nothing to watch` }));
        c.ws.close?.(NOT_YET_CLOSE, "no such world yet");
        return null;
      }
      ws.send(JSON.stringify({ type: "error", error: `there's no world called "${wname}" here — check the link that brought you here` }));
      c.ws.close?.(4005, "no such world");
      return null;
    }
    const w = getWorld(wname);
    // what this join proves comes from THIS join's credentials: nothing an earlier join on the socket proved carries over
    c.tokenVerified = false; c.auxBound = false; c.actorId = undefined;
    // a verified session OWNS the id: the client's msg.id is ignored
    c.id = (auth ? auth.name : String(msg.id ?? c.id)).slice(0, LIMITS.ID_LEN);
    // actor names are the log's ink: strip control characters, and (below) refuse names that forge system or script
    // authorship ("world", "script:*": the behavior loop-guard trusts that prefix)
    c.id = c.id.replace(/[\u0000-\u001f\u007f]/g, "").trim();
    // format characters (zero-width, bidi overrides) and compatibility forms are how one name passes for another
    c.id = c.id.normalize("NFKC").replace(/\p{Cf}/gu, "").trim();
    // no markup in a name: typed, refused in words; from the identity service, a look-alike (server/names.ts)
    {
      const n = nameAtDoor(c.id, { typed: !auth });
      if (n.refused) {
        ws.send(JSON.stringify({ type: "error", error: n.refused }));
        ws.close(4004, "name has markup");
        return null;
      }
      c.id = n.name;
    }
    // an identity is never a name — a name shaped like one (u-…) would pass for the person who wears it
    if (!c.id || /^(world|\*|system|sim)$/i.test(c.id) || /^script:/i.test(c.id) || /^u-[a-z2-7]{20}$/i.test(c.id)) {
      ws.send(JSON.stringify({ type: "error", error: `that name is reserved for the world itself` }));
      ws.close(4004, "reserved name");
      return null;
    }
    {
    // a bare NAME resolves server-side against the snapshot's roster
    const a = String(msg.avatar ?? "");
    c.avatar = !a ? "eidoverse/assets/vrms/claude.vrm"
      : a.includes("/") ? a
      : (avatarRoster().find((r) => r.name === a)?.path ?? "eidoverse/assets/vrms/claude.vrm");
  }
    // which leg is arriving; "world" alone gets a body. A surface that sanitizes to EMPTY is refused, never defaulted:
    // "world" has takeover power, so defaulting would let a broken sidecar kick its own user and skip the aux gates
    {
      const rawSurface = msg.surface == null ? "world" : String(msg.surface);
      c.surface = rawSurface.toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, LIMITS.SURFACE_LEN);
      if (!c.surface) {
        ws.send(JSON.stringify({ type: "error", error: `unusable surface name — letters, digits, - and _ only` }));
        ws.close(4005, "bad surface");
        clients.delete(ws);
        return null;
      }
    }
    c.spectator = Boolean(msg.spectate) || c.surface !== "world";
    // a DECLARED status (PROTOCOL §6a): presence only, never inferred, never logged, never read by a gate
    c.declares = declarationOf(msg.declares) ?? undefined;
    // the page's own id (#234/#217), relayed as `session`: its typing and attention follow its own session
    if (typeof msg.session === "string" && PAGE_SESSION_RE.test(msg.session)) c.presenceSession = msg.session;
    c.renderer = Boolean(msg.renderer);
    c.roam = c.renderer && Boolean(msg.roam);
    // re-derived every join: the renderers' credential, presented with the renderer flag on this very join
    c.trustedRenderer = c.renderer && Boolean(RENDERER_TOKEN) && String(msg.token ?? "") === RENDERER_TOKEN;
    snapshots.configure(c, msg.capture);
    if (c.renderer) c.spectator = true;
    // ---- who this join is: an ACCOUNT, proven by this join's credential: a session's sub; an enrolled bearer's
    // "agent:token:<id>"; an aid1 agent's enrolment, else "aid1:<iss>:<sub>"; TRUST_NAMES "local:<name>"; else anonymous.
    // A reserved name is claimable only with its enrolment's own proof.
    {
      const at = agentTokens();
      const tokStr = String(msg.agentToken ?? "");
      let account: string | null = auth && c.sub ? c.sub : null;
      let agentName: string | null = null;
      const enrolled = at.byToken.get(tokStr);
      if (enrolled) { account = `agent:token:${enrolled.toLowerCase()}`; agentName = enrolled; }
      else if (tokStr) {
        const a = aid1JoinIdentity(tokStr);
        if (!a || a.payload.kind !== "agent") {
          ws.send(JSON.stringify({ type: "error", error: a ? "that credential isn't an agent's — sign in as yourself instead" : "that agent credential didn't verify" }));
          c.ws.close?.(4004, "bad agent credential");
          return null;
        }
        const viaEnrolment = at.bySub.get(a.payload.sub);
        account = viaEnrolment ? `agent:token:${viaEnrolment.toLowerCase()}` : `aid1:${a.payload.iss}:${a.payload.sub}`;
        agentName = viaEnrolment ?? a.slug;
      }
      if (agentName) { c.id = nameAtDoor(agentName.slice(0, LIMITS.ID_LEN), { typed: false }).name; c.tokenVerified = true; }   // no markup in an aid1 slug either; the credential proves WHO, never what kind (§6a)
      // a reserved name is matched FOLDED (foldName: case, spaces, punctuation); only the enrolment's own proof wears it
      const reservedAs = [...at.names].find((n) => foldName(n) === foldName(c.id)) ?? null;
      if (reservedAs && account !== `agent:token:${reservedAs}`) {
        console.log(`[perm] join refused: "${c.id}" is a reserved agent name (no proof of that enrolment)`);
        ws.send(JSON.stringify({ type: "error", error: `"${c.id}" is a reserved agent name` }));
        c.ws.close?.(4004, "reserved name");
        return null;
      }
      // a private door: the account is the client's kept msg.account, else the typed name, so a rename keeps who they are
      if (!account && TRUST_NAMES) { const keep = typeof msg.account === "string" ? nameAtDoor(msg.account.trim().slice(0, LIMITS.ID_LEN), { typed: false }).name : "";
        account = `local:${(keep || c.id).toLowerCase()}`; }
      // a connection that has joined stays who it proved it was: travel keeps the identity; a new one needs a new socket
      if (c.account !== undefined && c.account !== account) {
        ws.send(JSON.stringify({ type: "error", error: "this connection already joined as someone else — reconnect to join as another identity" }));
        c.ws.close?.(4004, "identity is fixed per connection");
        return null;
      }
      c.account = account;
      c.anonymous = !account;
    }
    // a display name proves nothing: no two people show one at once, a guest never wears a claimed name.
    // Inside the RENAME COOLDOWN the old name stands; a case change is free; a sign-in's name is the provider's.
    c.renamed = false; c.renameRefused = undefined;
    // the newcomer is the one renamed; the collision pass runs FIRST, so the cooldown judges the name actually worn
    const typed = c.id;
    if (!c.spectator) {
      const dir = directoryFor(WORLDS_DIR);
      const taken = (n: string) => [...w.clients].some((o) => o !== c && !o.spectator && foldName(o.id) === foldName(n) && (!c.account || o.account !== c.account))   // two guests are never one account
        || (!!c.anonymous && dir.claimedName(n))
        || (!!c.account && dir.claimedByOther(n, c.account));   // nor an account under another account's name, here or not
      if (taken(c.id)) {
        const base = c.anonymous ? `${c.id} (guest)` : `${c.id}-${(c.account ?? "").replace(/[^a-z0-9]/gi, "").slice(-4) || "2"}`;
        let n = base.slice(0, LIMITS.ID_LEN), k = 2;
        while (taken(n)) n = `${base.slice(0, LIMITS.ID_LEN - 3)} ${k++}`;
        c.id = n;
      }
    }
    if (!c.spectator && c.account && !auth && !c.tokenVerified) {
      const dir = directoryFor(WORLDS_DIR); const id0 = dir.idOfSub(c.account); const e0 = id0 ? dir.entry(id0) : null;
      if (e0 && foldName(e0.name) !== foldName(c.id)) {
        const until = (e0.renamedAt ?? 0) + RENAME_COOLDOWN_MS;
        if (Date.now() < until) { c.renameRefused = { tried: typed, until }; c.id = e0.name; }
        else c.renamed = foldName(c.id) === foldName(typed);   // a suffixed name wasn't their choice: no cooldown starts on it
      }
    }
    // an OPAQUE id (server/directory.ts) reached only through an account: typing a name never yields a role.
    // A spectator skipped the name checks, so it records no name
    { const dir = directoryFor(WORLDS_DIR);
      const kept = c.spectator && c.account ? dir.idOfSub(c.account) : null;
      c.actorId = kept ?? dir.resolve({ sub: c.account ?? null,
        name: c.spectator && c.account ? dir.spectatorName(c.id, c.account, LIMITS.ID_LEN) : c.id }); }
    if (c.renamed && c.actorId) directoryFor(WORLDS_DIR).markRenamed(c.actorId);
    // ENTRY, once identity is SETTLED and before the body enters (server/access.ts entryFor)
    {
      const here = [...w.clients].filter((o) => !o.spectator && (o.surface ?? "world") === "world" && o.actorId !== c.actorId).length;
      const r = entryFor(doorOfWorld(w), whoOf(c), c.spectator ? "watch" : "embody", { here });
      if (r) {
        console.log(`[world:${w.name}] join refused: ${c.id} — ${r.reason}`);
        ws.send(JSON.stringify({ type: "error", error: r.why, ...(r.until ? { until: r.until } : {}) }));
        // "full" is transient (a client waits and retries); the others won't change by retrying
        c.ws.close?.(r.code, r.reason === "full" ? "full" : r.reason === "banned" ? "banned" : r.reason === "kicked" ? "kicked" : "no access");
        return null;
      }
    }
    if (w.log && c.actorId && !isOperator(c.account)) {
      // a guest's address mute (moderation.ts) is re-written as the moderator's own act on each new guest from that address,
      // so it shows, applies and lifts like any other
      if (c.anonymous && c.addr && !c.spectator && (c.surface ?? "world") === "world") {
        let carried = 0;
        for (const s of addrSanctionsFor(w.name, c.addr)) {
          if (s.kind !== "mute" || w.log.mutedHere(c.actorId)) continue;   // only mutes carry, never onto someone muted here
          w.log.live.appendMod({ actor: s.actor, verb: s.kind, who: c.actorId, ...(s.kind === "mute" ? { channels: s.channels ?? ["voice", "chat"] } : {}), until: s.until, ...(s.reason ? { reason: s.reason } : {}), carried: "address" });
          if (!s.ids.includes(c.actorId)) s.ids.push(c.actorId); carried++;
        }
        if (carried) { saveAddrSanctions(); console.log(`[world:${w.name}] a guest's ${carried} sanction(s) carried to ${c.id} by address`); }
      }
    }
    c.world = w;
    // ADMISSION BEFORE TAKEOVER: every refusing check runs before the kick, so only a join that WILL be accepted retires anyone
    if (c.surface !== "world") {
      // An aux leg without a living primary is an orphan mic: refuse it.
      const primary = [...w.clients].find(t => t !== c && t.id === c.id && (t.surface ?? "world") === "world" && !t.spectator);
      if (!primary) {
        ws.send(JSON.stringify({ type: "error", error: `no embodied "${c.id}" here to attach a ${c.surface} leg to — join the world first` }));
        ws.close(4008, "aux without primary");
        // c isn't in w.clients yet: only the global map needs cleaning
        clients.delete(ws);
        return null;
      }
      // an aux leg binds by proven ACCOUNT: a matching display name is presence, not authority (else anyone could stamp
      // voice packets as an unreserved human)
      const auxBound = !!c.account && c.account === primary.account;
      // the voice gates (messages.ts) admit the same binding
      if (auxBound) c.auxBound = true;
      if (!auxBound) {
        console.log(`[world:${w.name}] aux refused: "${c.id}"/${c.surface} has no binding to the primary's identity authority`);
        ws.send(JSON.stringify({ type: "error", error: `a ${c.surface} leg for "${c.id}" must present that identity's credential (agent bearer, or the primary's own login)` }));
        ws.close(4009, "unbindable aux");
        clients.delete(ws);
        return null;
      }
      // bounded legs per identity (#57), counted before the kick, EXCLUDING a same-surface predecessor (replaced, not stacked)
      const auxCount = [...w.clients].filter(t => t !== c && t.id === c.id
        && (t.surface ?? "world") !== "world" && t.surface !== c.surface).length;
      if (auxCount >= LIMITS.AUX_LEGS) {
        ws.send(JSON.stringify({ type: "error", error: "too many auxiliary legs for this identity" }));
        ws.close(4008, "aux cap");
        // c isn't in w.clients yet: only the global map needs cleaning
        clients.delete(ws);
        return null;
      }
    }
  return w;
}

function installJoin(c: Client, w: World) {
    // identity takeover, PER (account, surface): no leave broadcast (it's re-arriving); plain spectators never duel
    let retiredGen: number | undefined;
    if (!(c.spectator && c.surface === "world")) {
      for (const other of [...w.clients]) {
        // a takeover is the SAME ACCOUNT re-arriving, under any name: a typed name never kicks anyone, and guests never take over
        if (other !== c && !!c.account && other.account === c.account
            && (other.surface ?? "world") === c.surface
            && !(other.spectator && (other.surface ?? "world") === "world")) {
          other.superseded = true;
          snapshots.retire(other);
          retiredGen = other.gen;
          w.clients.delete(other);
          clients.delete(other.ws);
          other.ws.close?.(4002, "session takeover");
          console.log(`[world:${w.name}] ${c.id}/${c.surface} takeover — gen ${other.gen} retired`);
          // retire the PREDECESSOR's relay leg under its own id (bound to the retired primaryGen; the successor mints fresh, #104)
          if ((c.surface ?? "world") === "world" && !other.spectator) retireRelayLeg(w, other.id);
          // …and under a new name, the old avatar leaves everyone's view (the superseded close says nothing)
          if ((c.surface ?? "world") === "world" && !other.spectator && other.id !== c.id) {
            w.dirty.delete(other.id);
            { w.broadcast({ type: "leave", id: other.id }); w.scripts.onPresence("leave", other.id, other.actorId); }
          }
        }
      }
    }
    c.gen = ++GEN;   // issued on acceptance
    c.legGen = w.legGen();
    w.clients.add(c);
    snapshots.noteJoin(c);
    // an enrolled agent (its credential, never a declaration: §6a): prewarm a roamer
    if (c.tokenVerified && !c.spectator) snapshots.prewarm(w);
    // a joining roamer is swept a second later, once its own join has settled
    if (c.roam) setTimeout(() => { try { snapshots.sweep(); } catch (e) { console.error("[snap] sweep failed:", e); } }, 1_000);
    // every aux join is broadcast (#57): a leg joining after a listener's snapshot would otherwise be invisible (double-speak)
    if (c.surface && c.surface !== "world") {
      const transition = JSON.stringify({ type: "surface-transition",
        id: c.id, surface: c.surface, gen: c.gen, retired: retiredGen ?? null });
      for (const t of w.clients) if (t !== c) t.ws.send(transition);
    }
    // an owner is named when the world is FOUNDED, never by being first in
}

/** The authority's role (it admits every write) plus body and spend permissions (@world roles:<id>, else default-role;
 *  a guest never wears the default). `open` = no owner. */
function rightsFor(w: World, c: Client) {
  // rights come from the authority alone (by identity); an operator (WORLD_ADMIN, by account) flies and spends everywhere
  const op = isOperator(c.account);
  const wc = (w.log.live.state().entities?.["@world"]?.c ?? {}) as Record<string, any>;
  const open = !Object.entries(wc).some(([k, v]) => k.startsWith("roles:") && isOwner(v));
  if (!c.actorId) return { role: "inhabitant", roleName: "Inhabitant", rank: 0, permissions: [] as string[], gen: op, fly: op, open };
  const e = w.log.rightsOf(c.actorId); const m = w.log.mutedHere(c.actorId);
  return { role: e.role, roleName: e.name, rank: e.rank, permissions: e.permissions, ...(c.anonymous ? { guest: true } : {}), gen: op || e.permissions.includes("generate"), fly: op || e.permissions.includes("fly"), open,
    ...(m ? { muted: { channels: m.channels, until: m.until } } : {}) };
}
/** identity → until (the people list's muted glyph) */
function mutedIn(S: Record<string, unknown>): Record<string, number> {
  const muted: Record<string, number> = {}; for (const [id, x] of Object.entries(S)) if ((x as any).mute) muted[id] = (x as any).mute.until ?? 0;
  return muted;
}
/** Nothing is written when a sanction ends: this matches SFU mute, your-rights and mod-state to the moderator log by
 *  the authority's clock, acting only on a change. */
export function sanctionSweep(w: World) {
  if (!w.log) return;
  const S = w.log.sanctions();   // once per world per sweep, never per client
  for (const c of [...w.clients]) {
    if (c.spectator || (c.surface ?? "world") !== "world" || !c.actorId) continue;
    const x = S[c.actorId] as any; const voice = !!x?.mute?.channels?.includes("voice");
    if (voice !== !!c.sfuMuted && (voice || c.sfuMuted !== undefined)) { try { setSfuModeratorMute(w.name, c.id, voice); } catch (err) { console.error(`[world:${w.name}] sfu mute`, err); } }
    c.sfuMuted = voice;
    const mine = JSON.stringify([x?.mute?.until ?? null, x?.mute?.channels ?? null]);
    if (c.sanctionKey !== mine) { const first = c.sanctionKey === undefined; c.sanctionKey = mine;
      if (!first) { try { c.ws.send(JSON.stringify({ type: "your-rights", rights: rightsFor(w, c) })); } catch { /* gone */ } } }
  }
  // the SFU keys its mute on display id: release it once that person is gone, so a mute never carries across people
  const live = new Set([...w.clients].filter((c) => c.sfuMuted).map((c) => c.id));
  for (const id of [...(w.sfuMutedIds ?? [])]) if (!live.has(id)) { try { setSfuModeratorMute(w.name, id, false); } catch { /* relay gone */ } }
  w.sfuMutedIds = live;
  const muted = mutedIn(S);
  const key = JSON.stringify(muted);
  if (w.modStateKey !== key) { w.modStateKey = key; w.broadcast({ type: "mod-state", muted }); }
}
registerSystem({ name: "sanctions", everyMs: 2000, fn: () => { for (const w of worlds.values()) { try { sanctionSweep(w); } catch (err) { console.error(`[world:${w.name}] sanction sweep`, err); }
  try { w.regateReaches(); } catch (err) { console.error(`[world:${w.name}] re-gating reaches`, err); } } } });   // a timed allow ends with no request

function buildSnapshot(w: World, c: Client) {
    return {
      type: "snapshot",
      // no renderSceneVersion: #248's projection isn't served here, so a native client isn't told to ask for it
      world: w.name,
      you: c.id,
      ...(c.account && !c.tokenVerified ? { renameAfter: (directoryFor(WORLDS_DIR).entry(c.actorId ?? "")?.renamedAt ?? 0) + RENAME_COOLDOWN_MS, renameCooldownDays: RENAME_COOLDOWN_MS / 86400000 } : {}),
      ...(c.renameRefused ? { renameRefused: c.renameRefused } : {}),
      ...(c.sub ? { yourSub: c.sub } : {}),
      gen: c.gen,   // echo it in attestations
      // your OWN live aux legs, so a reconnected page doesn't double-speak over its voice leg
      yourSurfaces: [...w.clients]
        .filter(x => x !== c && x.id === c.id && (x.surface ?? "world") !== "world")
        .map(x => ({ surface: x.surface, gen: x.gen })),
      recording: RECORD,
      // the authority's cut, advanced by the `log` stream: a joiner's cost is the size of the WORLD, not its history
      cut: { ...w.log.info(), ...w.log.clientCut(actorIdOf(c)) },
      // speech is arrival-only, so the window is always empty; chatTotal = what a history page could show (admins only)
      state: { recentChat: [], chatTotal: w.isAdmin(c) ? (w.state.chatTotal ?? 0) : 0 },
      throughSeq: w.log.snapSeq,
      // bbox geometry follows as its own message
      avatars: avatarRoster(),
      // a role change re-sends it (your-rights)
      yourRights: rightsFor(w, c),
      restore: c.spectator || !c.actorId ? null : (w.poses[c.actorId] ?? null),   // by identity: a name is anyone's to wear
      present: [...w.clients].filter(o => o !== c && !o.spectator).map(o => ({
        // never lastPose: a joiner must not inherit someone's mid-ragdoll frame (#61)
        id: o.id, avatar: o.avatar, pose: settledPose(o.lastPose), ...(o.declares ? { declares: o.declares } : {}), session: presenceSession(o),   // §6a: relayed as declared; absent = undeclared
        // granting a role names this id, never a name
        ...(o.actorId ? { actorId: o.actorId } : {}),
        ...(w.log && o.anonymous ? { guest: true } : {}),   // no account: the people list's 'guest' badge
        // live aux legs: a summary on the one roster, never a second body
        surfaces: [...w.clients]
          .filter(x => x.id === o.id && (x.surface ?? "world") !== "world")
          .map(x => ({ surface: x.surface, gen: x.gen })),
      })),
    };
}

const server = Bun.serve({
  port: PORT,
  hostname: HOST,
  // Bun's maximum (s): the 10 s default cuts a big download over a slow link. A WebSocket has its own
  // websocket.idleTimeout (left at Bun's default)
  idleTimeout: 255,
  async fetch(req, srv) {
    // the whole HTTP surface is routes.ts's table (§15, 7c); a successful /ws upgrade returns no Response
    return route(req, srv);
  },
  websocket: {
    maxPayloadLength: LIMITS.WS_MESSAGE_BYTES,
    // every ws callback catches: an uncaught throw exits the process, and close reaches disk (EIO/ENOSPC: a log line)
    open(ws) {
      try {
        const c: Client = { id: `anon-${nextClientNum++}`, ws, world: null, avatar: "", lastPose: null, spectator: false,
          msgs: newBucket(2 * MSG_RATE) };
        const data = (ws as unknown as { data?: { session?: HnSession | null; addr?: string } }).data;
        const sess = data?.session;
        if (sess && sess.exp > Date.now()) { c.auth = sess; c.sub = sess.sub; }
        c.addr = data?.addr ?? null;
        clients.set(ws, c);
      } catch (err) {
        console.error(`[ws] open failed server-side:`, err);
      }
    },
    close(ws) {
      try {
        const c = clients.get(ws);
        if (!c) return;
        snapshots.retire(c);
        clients.delete(ws);
        // ?bc=1: printed at the only moment we learn it died
        if (c.bcRing?.length) {
          console.log(`[bc] ${c.id} last breadcrumbs: ${c.bcRing.join(" | ")}`);
        }
        if (c.world) {
          c.world.clients.delete(c);
          // carries the dying gen (an out-of-order successor wins); not on takeover, already announced at join
          if (!c.superseded) retireAuxLeg(c.world, c);
          if (!c.spectator) {
            if (!c.superseded) {
              try { if (c.actorId && !c.anonymous) c.world.rememberPose(c.actorId, c.lastPose); } // by identity; a guest's id is new each visit
              catch (err) { console.error(`[world:${c.world.name}] rememberPose for ${c.id} on close`, err); }
            }
            c.world.broadcast({ type: "leave", id: c.id }); c.world.scripts.onPresence("leave", c.id, c.actorId);
            if (!c.superseded && c.actorId) c.world.log?.departed(c.actorId); // a takeover keeps the body; a departure drops what it held
            // the primary is gone: reap its aux legs, unless a successor took over (they transfer to it)
            if (!c.superseded) reapAuxLegs(c.world, c, "primary session gone");
          }
          console.log(`[world:${c.world.name}] ${describe(c.world)} — ${c.id} ${c.spectator ? "stopped watching" : "left"}`);
        }
      } catch (err) {
        console.error(`[ws] close failed server-side:`, err);
      }
    },
    message(ws, raw) {
      const c = clients.get(ws);
      if (!c) return;
      // a superseded generation is DEAD while its socket drains (#57): backstop for marking superseded without unmapping
      if (c.superseded) return;
      let msg: any;
      try { msg = JSON.parse(String(raw)); } catch { return; }

      // over the cap a REQUEST is still answered (its client awaits a reply by id), up to MSG_RATE a second; the rest drop
      const now = Date.now();
      const verdict = admitMessage(c.msgs, now, MSG_RATE);
      if (verdict !== "run") {
        if (msg?.type === "request" && verdict === "refuse") { try { ws.send(JSON.stringify({ type: "reply", id: msg.id ?? null, verb: String(msg.verb ?? "").slice(0, 32), ok: false,
          reply: { ok: false, refused: { code: "rate", reason: `more than ${MSG_RATE} messages a second from this connection: this request wasn't run`, fix: "slow down and send it again" } } })); } catch { /* gone */ } }
        return;
      }

      // no message may ever kill the process (a reconnecting client makes it a crash loop): refusals are messages, failures logs
      try {
      switch (msg.type) {
        case "join": {
          // a verified session (bound at WS upgrade) passes without JOIN_TOKEN; everyone else needs it
          const auth = c.auth && c.auth.exp > Date.now() ? c.auth : null;
          // …or a renderer, on the renderers' credential (config.ts RENDERER_TOKEN)
          const rendererKey = Boolean(RENDERER_TOKEN) && Boolean(msg.renderer) && String(msg.token ?? "") === RENDERER_TOKEN;
          if (!auth && JOIN_TOKEN && String(msg.token ?? "") !== JOIN_TOKEN && !rendererKey) {
            ws.send(JSON.stringify({ type: "error", error: "bad or missing join token" }));
            c.ws.close?.(4003, "bad token");
            return;
          }
          if (auth) {
            const need = msg.spectate ? ["worlds:spectate", "worlds:join"] : ["worlds:join"];
            if (!need.some((s) => auth.scopes.includes(s))) {
              ws.send(JSON.stringify({ type: "error", error: msg.spectate ? "your login lacks spectate access" : "your login lacks embodied access — try ?spectate" }));
              c.ws.close?.(4003, "insufficient scope");
              return;
            }
          }
          // travel is leave A, join B, and never runs the ws-close handler: reap here, or an orphan mic stays behind
          if (c.world) {
            snapshots.retire(c);
            c.world.clients.delete(c);
            retireAuxLeg(c.world, c);
            if (!c.spectator) {
              c.world.broadcast({ type: "leave", id: c.id }); c.world.scripts.onPresence("leave", c.id, c.actorId);
              if (c.actorId) c.world.log?.departed(c.actorId);
              reapAuxLegs(c.world, c, "primary traveled");
            }
          }
          const w = admitJoin(c, ws, msg, auth);
          if (!w) return;
          // a world talks only to clients that fold its log (4005, not redialled); an aux surface carries no world state
          if (w.log && msg.replica !== true && (c.surface ?? "world") === "world") {
            ws.send(JSON.stringify({ type: "error", error: noFoldRefusal(w.name, !!auth && isNativeSession(auth)) }));
            ws.close(4005, "this client doesn't fold the log");
            clients.delete(ws);
            return;
          }
          c.replica = msg.replica === true;
          installJoin(c, w);
          // speech is arrival-only: nothing at or below this cut is read back, unless by an admin (world.ts sayFloor)
          c.arrivedSeq = w.log.head;
          // the authority clock (spec/PHYSICS.md §5.1) BEFORE the snapshot, whose transfer time would bias the first sample
          if (msg.clock === true) ws.send(JSON.stringify({ type: "clock", t: authorityNow(w) }));
          ws.send(JSON.stringify(buildSnapshot(w, c)));
          // broadcast only on a change, so a joiner is told the badges already in force
          if (w.log) ws.send(JSON.stringify({ type: "mod-state", muted: mutedIn(w.log.sanctions()) }));
          sendGeomFollowup(w, c);
          if (!c.spectator) w.broadcast({ type: "arrive", id: c.id, avatar: c.avatar, ...(c.declares ? { declares: c.declares } : {}), session: presenceSession(c), ...(c.actorId ? { actorId: c.actorId } : {}), ...(w.log && c.anonymous ? { guest: true } : {}) }, c);
          if (w.log) sanctionSweep(w);   // a voice mute in force is re-applied on join (keyed on the identity, never a name)
          if (!c.spectator) w.scripts.onPresence("enter", c.id, c.actorId);
          console.log(`[world:${w.name}] ${describe(w)}${c.spectator ? ` — ${c.id} watching` : ` — ${c.id} joined`}`);
          break;
        }
        // ── SFU signaling (VOICE_TRANSPORT=sfu) ──────────────────────────
        // one end IS the sequencer: no recipient to address; never logged, SDP-sized cap, dropped if the leg is gone
        case "sfu-answer": {
          if (!c.world || !relayEnabled()) return;
          // relay-cred's gate: a spectator or aux leg keeps the primary's c.id and would otherwise reach a real SFU leg
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // admission (admitSfuLeg's refusals) runs on the first answer: it must prove it is the leg the credential was minted for
          {
            // once per LEG: the nonce is single-use and every renegotiation re-answers, so a second admission revokes a working leg
            if (sfuLegAdmitted(c.world.name, c.id)) {
              const sdpOk = String(msg.sdp ?? "");
              if (sdpOk.length > 20000) return;
              void sfuAcceptAnswer(c.world.name, c.id, sdpOk, Number((msg as { gen?: unknown }).gen ?? NaN) || undefined);
              return;
            }
            const cl = (msg as { cred?: Record<string, unknown> }).cred;
            const verdict = cl
              ? admitSfuLeg(c.world.name, {
                  world: String(cl.world ?? ""), id: String(cl.id ?? ""),
                  primaryGen: Number(cl.primaryGen ?? -1), mediaGen: Number(cl.mediaGen ?? -1),
                  incarnation: String(cl.incarnation ?? ""), nonce: String(cl.nonce ?? ""),
                }, liveLegState(c.world.name, c.id, c.gen))
              : { admit: false as const, reason: "no credential presented" };
            if (verdict.admit) markSfuLegAdmitted(c.world.name, c.id);
            if (!verdict.admit) {
              console.warn(`[sfu] answer REFUSED for ${c.id}: ${verdict.reason}`);
              ws.send(JSON.stringify({ type: "error", error: `voice leg refused: ${verdict.reason}` }));
              revokeSfuLeg(c.world.name, c.id);
              return;
            }
          }
          const sdp = String(msg.sdp ?? "");
          if (sdp.length > 20000) return;
          void sfuAcceptAnswer(c.world.name, c.id, sdp, Number((msg as { gen?: unknown }).gen ?? NaN) || undefined);
          return;
        }
        case "sfu-ice": {
          if (!c.world || !relayEnabled()) return;
          // relay-cred's gate: a spectator or aux leg keeps the primary's c.id and would otherwise reach a real SFU leg
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          // gen required end-to-end (#130): the adapter refuses a missing or stale one
          sfuAcceptIce(c.world.name, c.id, msg.candidate, typeof msg.gen === "number" ? msg.gen : undefined);
          return;
        }
        case "sfu-pos": {
          // optional: the proximity gate fails open on unknown positions
          if (!c.world || !relayEnabled()) return;
          // relay-cred's gate: a spectator or aux leg keeps the primary's c.id and would otherwise reach a real SFU leg
          // (here, a forged distant position for someone else is a remote mute)
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
          sfuSetPosition(c.world.name, c.id, n(msg.x), n(msg.y), n(msg.z));
          return;
        }
        case "sfu-want-negotiate": {
          // the client asks for an offer rather than offering: the server owns every offer (glare)
          if (!c.world || !relayEnabled()) return;
          // relay-cred's gate: a spectator or aux leg keeps the primary's c.id and would otherwise reach a real SFU leg
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          sfuNegotiate(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
          return;
        }
        // no `rtc` verb (#104): the mesh's ungated client↔client lane is gone with the mesh
        case "relay-cred": {
          // least-authority media credential (#104): the embodied primary's ask only; a surface session like any other
          if (!c.world) return;
          if (!relayEnabled()) { ws.send(JSON.stringify({ type: "error", error: "no voice relay configured" })); return; }
          if (c.spectator || (c.surface ?? "world") !== "world") {
            ws.send(JSON.stringify({ type: "error", error: "relay-cred is the embodied primary's ask" }));
            return;
          }
          // NOT YET ENFORCED: askable-down scopes; every credential is a publishing credential until the SFU has a per-leg flag
          const mediaGen = ++GEN;
          {
            // mint FIRST: it revokes the old leg's sender, so registering before would hand the fresh leg a deleted send path
            const cred = mintSfuCredential(c.world.name, c.id, c.gen!, mediaGen);
            registerSfuSender(c.world.name, c.id, (payload) => ws.send(JSON.stringify(payload)));
            // retirement reset the SFU mute (revokeSfuLeg): forget it so the sweep re-applies
            c.sfuMuted = undefined;
            if (c.world.log) sanctionSweep(c.world);
            const transition = JSON.stringify({ type: "surface-transition",
              id: c.id, surface: "voice-relay", gen: mediaGen, retired: null });
            for (const t of c.world.clients) if (t !== c) t.ws.send(transition);
            ws.send(JSON.stringify({ type: "relay-cred", ...cred, gen: mediaGen,
              service: { enabled: true, ...voiceServiceState(), transport: "sfu" } }));
            return;
          }
        }
        case "voice-moderate": {
          // keyed on IDENTITY: msg.actorId, else the PRESENT person named msg.id (never an absent name, so a typed name can't
          // frame anyone)
          if (!c.world?.log) return;
          if (c.spectator || (c.surface ?? "world") !== "world") return;
          const w = c.world;
          const target = typeof msg.actorId === "string" ? msg.actorId : [...w.clients].find((t) => t.id === String(msg.id ?? "") && (t.surface ?? "world") === "world" && !t.spectator)?.actorId;
          if (!target) { ws.send(JSON.stringify({ type: "error", error: "nobody here by that name to mute" })); return; }
          const muted = msg.muted === true;
          const minutes = typeof msg.minutes === "number" ? msg.minutes : 60;
          // a mute that also covers chat is lifted where its whole record is, never from a voice button
          if (!muted && w.log.mutedHere(target, "chat")) { ws.send(JSON.stringify({ type: "error", error: "that mute covers chat too: lift it in Moderation › Bans (or /unmute)" })); return; }
          // one capability, the connection's queue, the meters, both recheck seams
          void requestAs(c, ws, w, muted ? "mute" : "unmute", muted ? { who: target, minutes, channels: ["voice"], ...(typeof msg.reason === "string" ? { reason: msg.reason } : {}) } : { who: target })
            .then((r: any) => {
              if (!r?.ok) { ws.send(JSON.stringify({ type: "error", error: r?.refused?.reason ?? "that mute was refused" })); return; }
              sanctionSweep(w);
              guestSanctionByAddress(w, actorIdOf(c), c.id, muted ? "mute" : "unmute", target, typeof msg.reason === "string" ? msg.reason : undefined);
              if (muted) for (const t of w.clients) if (t.actorId === target) { try { t.ws.send(JSON.stringify({ type: "moderated", verb: "mute", by: c.id, you: true, channels: ["voice"], until: r.until })); } catch { /* gone */ } }
              // moderation is world-visible by design: a silence nobody can see the cause of is indistinguishable from a bug
              const name = [...w.clients].find((t) => t.actorId === target)?.id ?? target;
              const note = JSON.stringify({ type: "voice-moderated", id: name, actorId: target, muted, by: c.id, ...(muted ? { until: r.until } : {}) });
              for (const t of w.clients) { try { t.ws.send(note); } catch { /* gone */ } }
              console.log(`[world:${w.name}] ${c.id} ${muted ? "muted" : "unmuted"} ${name} (${target}) for everyone`);
            });
          return;
        }
        case "voice-consent": {
          // listener-authored receive consent: server-enforced, gen-bound (a reconnect starts fail-closed), idempotent
          if (!c.world || c.spectator) return;
          if (!relayEnabled()) return;
          const r = setSfuConsent(c.world.name, c.id, c.gen ?? 0, msg.recv === true);
          ws.send(JSON.stringify({ type: "voice-consent", recv: msg.recv === true,
            applied: r.changed, ...(r.reason ? { note: r.reason } : {}) }));
          return;
        }
        default: {
          // requestwire.ts first, then messages.ts; unknown types are silence, OWN keys only ("__proto__" never reaches Object.prototype)
          const h = requestHandler(msg.type) ?? (typeof msg.type === "string" && Object.hasOwn(MESSAGES, msg.type) ? MESSAGES[msg.type] : undefined);
          if (h && !gagged(c, String(msg.type))) h({ c, ws, now, expel, sweep: sanctionSweep }, msg);
        }
      }
      } catch (err) {
        console.error(`[ws] "${String(msg?.type)}" from ${c.id} failed server-side:`, err);
        try { ws.send(JSON.stringify({ type: "error", error: "that request failed server-side — it has been logged" })); } catch { /* gone */ }
      }
    },
  },
});

// ---- stage-frame tick: one frame per world with every changed pose; disposable, so a backed-up socket skips ticks
registerSystem({ name: "stage-frames", everyMs: FRAME_MS, fn: () => {
  // one world's failure costs that world one tick, never the process
  for (const w of worlds.values()) {
    try {
    if (w.dirty.size === 0) continue;
    // t is the AUTHORITY's clock (spec/PHYSICS.md §5.1), never raw wall time: a log can run ahead of the wall clock
    const data = JSON.stringify({ type: "frame", seq: w.frameSeq++, t: authorityNow(w), poses: Object.fromEntries(w.dirty) });
    w.dirty.clear();
    if (RECORD) {
      if (!w.recPath) {
        w.recPath = join(WORLDS_DIR, w.name, `frames-${Date.now()}.jsonl`);
        console.log(`[world:${w.name}] ⏺ recording stage frames → ${w.recPath}`);
      }
      const roster = JSON.stringify([...w.clients].filter((c) => !c.spectator).map((c) => ({ id: c.id, avatar: c.avatar })));
      if (roster !== w.lastRoster) { w.lastRoster = roster; appendFileSync(w.recPath, `{"type":"roster","t":${Date.now()},"roster":${roster}}\n`); }
      appendFileSync(w.recPath, data + "\n");
    }
    for (const c of w.clients) {
      if ((c.ws.getBufferedAmount?.() ?? 0) > FRAME_SKIP_BUFFERED) continue; // stale frames die here, not in the kernel
      c.ws.send(data);
    }
    } catch (err) { console.error(`[world:${w.name}] frame tick`, err); }
  }
} });

// the heartbeat starts once every system is on it; its base is the finest cadence (stage frames)
startTick(FRAME_MS);

// on the way out, everyone connected sleeps where they stand (every log line is already fsynced)
let shuttingDown = false;
for (const sig of ["SIGINT", "SIGTERM"] as const) {
  process.on(sig, () => {
    if (shuttingDown) process.exit(0);
    shuttingDown = true;
    for (const w of worlds.values()) {
      // ws close handlers never run on exit
      for (const c of w.clients) {
        if (!c.spectator && !c.superseded && c.lastPose && c.actorId && !c.anonymous) w.rememberPose(c.actorId, c.lastPose);
      }
    }
    process.exit(0);
  });
}

console.log(`eidoverse-worlds sequencer on http://${HOST}:${PORT}`);
console.log(`  library: ${LIBRARY_DIR}`);
console.log(`  worlds:  ${WORLDS_DIR}`);
if (TRUST_NAMES) console.log(`  ⚠ TRUST_NAMES=1: a typed name IS an account here (local:<name>). Private servers only: anyone who can reach ${HOST}:${PORT} can be anyone.`);
if (!JOIN_TOKEN) console.log("  ⚠ NO JOIN_TOKEN — the server is OPEN. Fine on a tailnet, wrong on a public box.");
// without client/node_modules every import 404s and the splash hangs: say it where the operator looks
if (!existsSync(join(ROOT, "client", "node_modules", "three"))) {
  console.log("  ⚠ client/node_modules is MISSING — browsers will hang at the splash. Run: cd client && bun install");
}
if (!existsSync(join(LIBRARY_DIR, "eidoverse"))) {
  console.log(`  ⚠ no eidoverse-video library at ${LIBRARY_DIR} — avatars/sky/vegetation will be absent. Set EIDOVERSE_DIR.`);
}
