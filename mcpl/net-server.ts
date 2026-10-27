// net-server: the network MCPL door. One WS server, ?token= -> identity, one Session per connection
// (@animalabs/mcpl-core). World chat is an MCPL channel (says -> channels/incoming; channels/publish speaks
// in-world); tools ride the same connection. A session's WorldAgent lives exactly as long as its connection.
//
// Usage:  bun run mcpl/net-server.ts            (port 8941)
// Tokens: mcpl/tokens.json  { "<token>": { "id": "mythos", "name": "Mythos",
//         "world": "commons", "avatar": "eidoverse/assets/vrms/claude.vrm" } }

import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, writeFileSync, renameSync, rmSync } from "node:fs";
import { WebSocketServer, type WebSocket } from "ws";
import {
  McplConnection,
  method,
  type McplInitializeParams,
  type McplInitializeResult,
  type McplCapabilities,
  type InitializeCapabilities,
  type ChannelDescriptor,
  type ChannelsRegisterParams,
  type ChannelsIncomingParams,
  type ChannelsPublishParams,
  type ChannelsPublishResult,
} from "@animalabs/mcpl-core";
import {
  CHAT, EIDO, CAP, tags, capabilityMatches, MCPL_ADVERTISEMENT, FEATURE_SETS,
} from "./declaration.ts";
import { WorldAgent } from "./agent.ts";
import { shown } from "../shared/shown.js";
import { toolList, handleTool, type ToolCtx } from "./tools.ts";
import { pingDelivery, type WirePing } from "./ping-wire.ts";
import { eventTags, catchupHeaderTags, catchupReplayTags } from "./event-wire.ts";
import { TypingRelay } from "./typing-relay.ts";
import { MANIFEST_WITH_REVISION } from "./manifest.ts";
import { verifyToken, aid1Slug } from "../server/aid1.ts";
import { atomicWrite } from "../server/fsutil.ts";
import { displayNameIndex, lookupToken, readTokenRegistry, wireAuthors, type TokenAuth } from "./token-registry.ts";
import { WORLD_NAME_RE } from "../server/limits.ts";

const PORT = Number(process.env.MCPL_PORT ?? 8941);
// archipelago-home door (connectome docs/home-node.md §7): a `?token=aid1.…` home-node token verified offline, no
// tokens.json entry (`hn mint --aud eidoverse --scopes worlds:join`). tokens.json remains the legacy/fleet door.
const HN_ISSUER_KEY = process.env.HN_ISSUER_KEY ?? "";
const HN_ISS = process.env.HN_ISS ?? "id.animalabs.ai";
const HN_AUD = process.env.HN_AUD ?? "eidoverse";
const ts = () => new Date().toISOString().slice(11, 19);
const TOKENS_PATH = process.env.MCPL_TOKENS ?? fileURLToPath(new URL("./tokens.json", import.meta.url));
const TOKENS_EXAMPLE_PATH = process.env.MCPL_TOKENS_EXAMPLE ?? fileURLToPath(new URL("./tokens.example.json", import.meta.url));

type Auth = TokenAuth & { dropMentionQualifiers?: boolean };
// read PER CONNECTION ATTEMPT: minting/revoking is a file edit, never a restart
function readTokens(): Record<string, Auth> {
  return readTokenRegistry(TOKENS_PATH, TOKENS_EXAMPLE_PATH);
}

// per-agent durable state (missed-mention cursors, chosen bodies), tmp+rename. Plain ids map to lastSeen
// timestamps; __-prefixed keys are sections. MCPL_STATE overrides mcpl/state.json so tests never write repo state (PR #125).
const STATE_PATH = process.env.MCPL_STATE ?? fileURLToPath(new URL("./state.json", import.meta.url));
const STATE_TMP = STATE_PATH + ".tmp";
// a tmp at boot is an interrupted atomic write: STATE_PATH still holds the last good state, so sweep it
try { rmSync(STATE_TMP, { force: true }); } catch (e) { console.error("[mcpl] stale state tmp not removable:", (e as Error).message); }
const _state: Record<string, unknown> = (() => {
  try { if (existsSync(STATE_PATH)) return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { /* fresh */ }
  return {};
})();
/** Per-agent world-log position (see the catch-up note in serve()), restored at boot so a door restart doesn't
 *  forget where each agent had read to. */
const lastSeenSeq: Record<string, number> = (_state.__seq as Record<string, number>) ?? {};
/** Outlives sessions: set_avatar is a decision, not a costume for one connection. Wins over the credential's default. */
const chosenAvatar: Record<string, string> = (_state.__avatar as Record<string, string>) ?? {};
/** Activity-sense tuning (pulse cadence / radius) is the agent's own decision and outlives sessions, like a body. */
const activityCfg: Record<string, { pulseSec?: number; radiusM?: number }> =
  (_state.__activity as Record<string, { pulseSec?: number; radiusM?: number }>) ?? {};
/** So a reconnect resumes there; stored with its home, and yields when the operator changes that home. Position
 *  inside the world is the sequencer's (rememberPose). */
const lastWorld: Record<string, { world: string; home: string }> =
  (_state.__world as Record<string, { world: string; home: string }>) ?? {};
function rememberWorld(id: string, world: string, home: string) {
  if (lastWorld[id]?.world === world && lastWorld[id]?.home === home) return;
  lastWorld[id] = { world, home };
  persistState();
}
const lastSeen: Record<string, number> = Object.fromEntries(
  Object.entries(_state).filter(([k, v]) => !k.startsWith("__") && typeof v === "number"),
) as Record<string, number>;
function persistState() {
  try {
    // atomicWrite (server/fsutil.ts), plus this door's own orphan-tmp cleanup below
    atomicWrite(STATE_PATH, JSON.stringify({ ...lastSeen, __seq: lastSeenSeq, __avatar: chosenAvatar, __activity: activityCfg, __world: lastWorld }));
  } catch (e) {
    // a failed persist must not leave its tmp: an orphan reads as a mid-write crash. STATE_PATH keeps the last good state.
    try { rmSync(STATE_TMP, { force: true }); } catch { /* the boot sweep gets it */ }
    console.error("[mcpl] state persist failed:", (e as Error).message);
  }
}

// without a handler SIGTERM can land between persistState's write and rename; a handler makes it
// event-loop-ordered so the pair can't split. SIGKILL mid-write is left to the boot sweep above.
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    try { rmSync(STATE_TMP, { force: true }); } catch { /* best effort */ }
    process.exit(0);
  });
}



// ---- session ---------------------------------------------------------------

class Session {
  private conn: McplConnection;
  private agent: WorldAgent;
  private channelId: string;
  private channelOpen = true;   // the world channel is home: open unless the agent closes it
  /** Each `start` names the body it signals through; the body's speech, travel and the session's close stop it. */
  private typing = new TypingRelay();
  /** Did the client declare capabilities.experimental.mcpl at initialize? Plain-MCP hosts get tools only
   *  (chat through look/catch_up): an MCPL frame to a host that never opted in stalls the door. */
  private mcplClient = false;
  /** As advertised at initialize (§5.2), or null. */
  private hostMcplVersion: string | null = null;
  /** The effective grant (§5.4), the only authorization input; null = no policy yet (granted()). Never
   *  derived from our own declaration, never widened by a receipt (§6.7). */
  private grant: Set<string> | null = null;
  /** Opens once the first §5.3 featureSets/update is answered; serve()'s prelude waits on it concurrently
   *  with the read loop, which alone can process the policy frame. */
  private policyAnswered!: () => void;
  private policyGate: Promise<void> = new Promise((resolve) => { this.policyAnswered = resolve; });
  /** RFC-005 §3.2.3d attachment generation: increments at each commit, which is the cutoff; surfaced as
   *  metadata.epoch. */
  private epoch = 0;
  /** THIS attachment founded its world (§3.2.7): on the descriptor so founding is never done unknowingly. */
  private foundedHere = false;
  caughtUpTo: number | null = null;   // ToolCtx.cursor: the shared table writes it
  /** Held for a push-less host until the `activity` tool's next call; a small ring. */
  private heldActivity: string[] = [];

  /** The credential's `world` claim, whatever world this session travelled to: what lastWorld is recorded against. */
  readonly home: string;
  /** Record where this session starts, once joined? False when the resume check couldn't run, so an unverified
   *  fallback never overwrites the memory (#261). */
  private readonly recordStart: boolean;
  constructor(private auth: Auth, ws: WebSocket, private agentToken = "", home?: string, recordStart = true) {
    this.home = home ?? auth.world ?? "commons";
    this.recordStart = recordStart;
    this.conn = McplConnection.fromWebSocket(ws as never);
    this.agent = this.createAgent(auth.world ?? "commons");
    this.channelId = `world:${this.agent.world}`;
    // the body's speech ends the dots; if the turn goes on, the host's next `start` raises them. Travel hands this on.
    this.agent.onSaid = () => this.typing.stop();
    // typing is taken on arrival, not when serve() next reads: a minute-long tool call would let the relay's overdue
    // stop drop the dots. Judged against the grant held now; the next refresh (≤7 s) retries.
    this.conn.on("notification", (n) => {
      if (n.method !== method.CHANNELS_TYPING) return;
      try {
        this.onTyping(n.params);
      } catch (e) {
        // a listener's throw would land in the connection's line reader
        console.error(`[${ts()}] [mcpl:${this.auth.id}] typing signal failed: ${(e as Error).message?.slice(0, 160)}`);
      }
    });
    // a host that goes away ends its dots at once: serve() reaches close() only after a running tool call returns, and
    // a walk can run for a minute
    this.conn.on("close", () => this.typing.stop());
  }

  /** Initial attachment and travel keep the same authenticated identity. */
  private createAgent(world: string): WorldAgent {
    return new WorldAgent({
      name: this.auth.id,
      displayName: this.auth.name,
      dropMentionQualifiers: this.auth.dropMentionQualifiers ?? true,
      world,
      avatar: chosenAvatar[this.auth.id] ?? this.auth.avatar,
      url: process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws",
      // the bearer that opened THIS door: the sequencer verifies the name against it (agent names are reserved there)
      agentToken: this.agentToken,
    });
  }

  /** The loopback media bridge. One sidecar at a time: a second connection replaces the first, because two
   *  publishers for one identity is the double-speak bug (#57). */
  private mediaSock: WebSocket | null = null;
  /** So session teardown releases the port (or the next session can't bind it). */
  private mediaServer: { stop: (closeActiveConnections?: boolean) => void } | null = null;

  private startMediaBridge(port: number) {
    // idempotent: a re-entry must not try to bind a port we already hold
    if (this.mediaServer) {
      console.log(`[door] media bridge already listening on :${port} — reusing`);
      return;
    }
    try {
    this.mediaServer = Bun.serve({
      port, hostname: "127.0.0.1",
      fetch: (req, srv) => srv.upgrade(req) ? undefined : new Response("media bridge: websocket only", { status: 426 }),
      websocket: {
        open: (ws) => {
          if (this.mediaSock) { try { this.mediaSock.close(4001, "replaced"); } catch {} }
          this.mediaSock = ws as never;
          console.log(`[door] media sidecar attached on :${port} — asking for a credential`);
          // the sidecar cannot ask for itself (the server refuses a non-primary), so attaching IS the ask. subscribe:false:
          // this leg speaks; hearing is the door's job on the text tier.
          try { this.agent.requestMediaCredential({ publish: true, subscribe: false }); }
          catch (e) { console.warn("[door] credential ask failed:", (e as Error).message); }
        },
        message: (_ws, raw) => {
          // sidecar -> world, whitelisted in sendMedia; the sidecar's malformed JSON must not take the door down (house rule #3)
          try {
            const frame = JSON.parse(String(raw)) as { type?: string; seq?: number };
            // `aired`: an utterance left the encoder. The receipt is ours, never the sidecar's: attest is identity-bearing,
            // and a peer minting receipts could suppress listeners' fallback for unaired audio.
            if (frame?.type === "aired") { void this.attestAired(Number(frame.seq)); return; }
            this.agent.sendMedia(frame as never);
          } catch (e) { console.warn("[door] bad media frame:", (e as Error).message); }
        },
        close: (ws) => { if (this.mediaSock === (ws as never)) this.mediaSock = null; },
      },
      // a bind failure must not end the session: the door is still useful mute
      error: (e: Error) => { console.warn("[door] media bridge error:", e.message); return undefined; },
    });
    } catch (e) {
      // a bind failure is a mute door, not a dead one: throwing here would end the whole connection
      this.mediaServer = null;
      console.warn(`[door] media bridge could NOT bind :${port} (${(e as Error).message}) — continuing WITHOUT a voice; text is unaffected`);
      return;
    }
    // world -> sidecar; dropped with nothing attached (no peer to answer; the server retires the leg on its own)
    this.agent.onMedia = (frame) => {
      try { this.mediaSock?.send(JSON.stringify(frame)); } catch { /* sidecar died mid-frame */ }
    };
  }

  /** Mint the receipt for an aired utterance. Silent on an unknown seq: a missing receipt degrades to the
   *  listener-side fallback by design. */
  private async attestAired(seq: number): Promise<void> {
    if (!Number.isSafeInteger(seq)) return;
    const ok = await this.agent.attestSay(seq).catch(() => false);
    if (!ok) console.warn(`[door] could not attest seq ${seq} (unknown say or not joined)`);
  }

  close() {
    this.typing.stop();
    this.agent.close(); // deliberate death: stops the body's auto-reconnect
    this.conn.close();
    // release the media port, or the next session can't bind it; closeActiveConnections drops a still-attached
    // sidecar now rather than leave it against a dead session
    if (this.mediaServer) {
      try { this.mediaServer.stop(true); } catch (e) { console.warn("[door] media bridge stop:", (e as Error).message); }
      this.mediaServer = null;
    }
  }

  /** Classifies, never closes: JoinDeclined means nothing moved; anything else is past the detach, so the
   *  connection must close. Pair with finishFatalJoin(), which defers the close a tick so the reply flushes. */
  private classifyJoinFailure(e: unknown): { fatal: boolean; code: number; why: string } {
    // the tool lane's sentence says which case, so the message is the cause alone (the code keeps the JSON-RPC name)
    if (e instanceof JoinDeclined)
      return { fatal: false, code: -32017, why: (e as Error).message };
    return { fatal: true, code: -32024, why: (e as Error).message };
  }

  /** §3.2.5: never half-attached; the old body is gone, so close. Deferred a tick so whatever the caller is about to
   *  send (or return) reaches the wire first. */
  private finishFatalJoin() { setTimeout(() => this.close(), 0); }

  /** The world-change gate: host capability, MCPL hosts only (-32002; a plain host's authority is its
   *  credential); credential narrowing and the world's /access (-32017); exists or may be founded (-32023);
   *  -32024 if the world server can't be asked. */
  private async travelGate(target: string): Promise<
    { ok: true; founding: boolean } | { ok: false; code: number; why: string }
  > {
    // granted() is always false for plain MCP, whose authority is its credential (joinAllowed + accessProbe, below)
    if (this.mcplClient && !this.granted(CAP.channelsLifecycle))
      return { ok: false, code: -32002, why: `your host hasn't granted this door ${CAP.channelsLifecycle}, which travel needs, and calling again won't change that; if you need it, ask whoever runs your host` };
    // the credential can only NARROW; the WORLD decides who may come in. Both are asked before anything moves, so a
    // refusal leaves the body where it was.
    if (!joinAllowed(this.auth, target, this.home))
      return { ok: false, code: -32017, why: `world "${target}" is outside the worlds this credential is limited to; worlds marks where you may travel` };
    const a = await accessProbe(target, this.agentToken);
    if (!a) return { ok: false, code: -32024, why: `the world server didn't say whether you may go to "${target}", so nothing moved; try again in a moment` };
    if (a.exists) {
      if (a.you === "enter") return { ok: true, founding: false };
      return { ok: false, code: -32017, why: a.you === "watch"
        ? `you may watch "${target}" but not travel into it; its owners decide who comes in`
        : `"${target}" isn't open to you; its owners decide who comes in` };
    }
    if (this.auth.create === false)
      return { ok: false, code: -32023, why: `no world named "${target}" exists, and this credential may not found one; worlds lists the worlds that exist` };
    if (!a.found?.ok)
      return { ok: false, code: -32023, why: `no world named "${target}" exists, and you can't found it right now: ${a.found?.why ?? "the world server refused"}` };
    return { ok: true, founding: true };
  }

  /** RFC-005 §3.2: move this connection's body to another world atomically, the old body dying before the
   *  new one dials. Throws on attach failure; the caller must then close the connection (§3.2.5). */
  private async joinWorld(w: string, founding = false): Promise<void> {
    // ── PREPARE (RFC-005 §3.2.3a-c) ── the host's acceptance is part of the transition; no answer or no
    // support counts as declining (fail-closed, §5.3). `leaving` is captured before this.agent can change.
    const leaving = `world:${this.agent.world}`;
    if (this.granted(CAP.channelsRegister)) {
      const proposed: ChannelDescriptor = {
        ...this.channelDescriptors()[0],
        id: `world:${w}`,
        label: `eidoverse — ${w}`,
        address: { world: w },
        // §3.2.3d: metadata.epoch is the only place the client learns it; prepare states the epoch this
        // transition would commit to, and the client defers the assignment until commit is observed
        metadata: { epoch: this.epoch + 1, ...(founding ? { created: true } : {}) },
      } as ChannelDescriptor;
      // which refusal: a host that said no, one that errored, or one that timed out (a later try can get past); the
      // timeout rejects with its own error so the catch can tell
      let accepted = false, declined = "";
      const noAnswer = new Error("no answer within 5 seconds");
      try {
        const res = await Promise.race([
          // prepare asks, it never announces the departure: a declining or slow host would be told its channel
          // is gone while the body stays. `removed` is stated on commit, below (§14.5 results are per-added).
          this.conn.sendRequest(method.CHANNELS_CHANGED, {
            added: [proposed],
          }) as Promise<{ results?: { id: string; accepted?: boolean }[] }>,
          new Promise<never>((_, rej) => setTimeout(() => rej(noAnswer), 5_000)),
        ]);
        // no itemized result = accepted (§14.5 REQUIRES the itemized form only of hosts whose policy can reject)
        const mine = res?.results?.find((r) => r.id === `world:${w}`);
        accepted = mine ? mine.accepted !== false : true;
        declined = `your host declined the move to "${w}"`;
      } catch (e) {
        console.log(`[${ts()}] [mcpl:${this.auth.id}] join "${w}" declined at prepare: ${(e as Error).message}`);
        accepted = false;
        // the log line keeps mcpl-core's RpcError code before the host's words; the agent gets the words alone
        declined = e === noAnswer
          ? `your host didn't confirm the move to "${w}" within 5 seconds, so trying again may work`
          : `your host didn't accept the move to "${w}" (${(e as Error).message.replace(/^RPC error -?\d+: /, "")})`;
      }
      if (!accepted) throw new JoinDeclined(declined);
    }
    // ── COMMIT (§3.2.3d-g) ────────────────────────────────────────────────
    // the epoch increments only once the new attachment is LIVE: it names the cutoff, so a transition that dies
    // mid-flight must not advance it
    const old = this.agent;
    const next = this.createAgent(w);
    next.onEvent = old.onEvent;
    next.onPing = old.onPing;
    next.onSaid = old.onSaid;
    // the activity dial is the resident's, so travel keeps it; set before connect(), as serve() does
    if (activityCfg[this.auth.id]) next.setActivity(activityCfg[this.auth.id]);
    // detach BEFORE close: queued ws frames can still fire the old body's onmessage after close() returns, and the
    // shared closures would attribute a late commons say to the annex channel
    old.onEvent = null;
    old.onPing = null;
    old.onSaid = null;
    // the host's typing named the old world's channel; the new world hears dots only when the host types there
    // (close() below silences the old body; this stops the timer)
    this.typing.stop();
    old.close();                       // detach: persists exactly what a disconnect persists
    this.agent = next;
    this.channelId = `world:${w}`;
    this.caughtUpTo = null;            // catch_up cursors are per-world context
    this.heldActivity.length = 0;      // held ambient lines are old-world context
    // the new descriptor says initiallyOpen:true, so the door must be open: it is per-world state
    this.channelOpen = true;
    await next.connect();
    this.epoch++;                      // the cutoff instant, after the fact of it
    this.foundedHere = founding;
    // now the departure is a fact, so state it; a notification, not a Request: the host has no veto
    // over a move that has already happened
    try {
      this.conn.sendNotification(method.CHANNELS_CHANGED, { removed: [leaving] });
    } catch { /* peer gone: the close path handles it */ }
    console.log(`[${ts()}] [mcpl:${this.auth.id}] joined world "${w}" epoch=${this.epoch}${founding ? " (FOUNDED)" : ""} (RFC-005)`);
    if (sessions.get(this.auth.id) === this) rememberWorld(this.auth.id, w, this.home);   // a reconnect resumes here (current sessions only)
    // §3.4 audit: a join is an authorization event, and a founding join is TWO; logged as one (§13.2)
    console.log(`[${ts()}] [audit] join granted: ${this.auth.id} → world:${w}${founding ? " (created)" : ""} epoch=${this.epoch}`);
    // no second channels/changed: PREPARE announced the roster change and the host accepted it (§3.2.3a)
  }

  /** The §5.4 gate for the channel verbs (publish, lifecycle, typing): the same semantics as granted(). */
  private capAllowed(cap: string): boolean {
    // granted(), not toolsAllowed()'s shape: channel verbs are MCPL-only, so the plain-MCP and §5.3 fences apply
    return this.granted(cap);
  }

  /** Plain MCP negotiates tools itself; once an MCPL grant exists, it decides (§5.4). */
  private toolsAllowed(): boolean {
    return this.grant ? this.granted(CAP.tools) : true;
  }

  /** Is cap in the effective grant (§5.4: the sole allowlist; absence is denial)? Before any grant, 0.5+
   *  hosts are denied until featureSets/update (§5.3); pre-0.5 peers keep 0.4 semantics (negotiation,
   *  never widening). */
  private granted(cap: string): boolean {
    if (!this.mcplClient) return false; // plain-MCP host: no MCPL frames, ever
    if (this.grant) { for (const g of this.grant) if (capabilityMatches(g, cap)) return true; return false; }
    const major = Number(this.hostMcplVersion?.split(".")[0] ?? 0);
    const minor = Number(this.hostMcplVersion?.split(".")[1] ?? 0);
    return !(major > 0 || minor >= 5);
  }

  /**
   * Handle `featureSets/update` (§6.7): the degradation receipt, or an error tuple when malformed. The
   * receipt says what the door will stop doing, never what it should get; never `accepted: false` (§6.7 coercion).
   */
  private applyPolicy(params: Record<string, unknown>): { error: string } | Record<string, unknown> {
    const eff = Array.isArray(params.effectiveCapabilities) ? params.effectiveCapabilities.map(String) : null;
    const denied = Array.isArray(params.deniedCapabilities) ? params.deniedCapabilities.map(String) : [];
    if (eff) {
      // §5.4: a path in both lists is malformed and MUST fail closed: keep the previous grant, not an ambiguous one
      const both = eff.filter((c) => denied.includes(c));
      if (both.length) return { error: `capability in both effectiveCapabilities and deniedCapabilities: ${both.join(", ")}` };
      this.grant = new Set(eff);
      // a grant withdrawing channels.typing ends the relay now, not at its overdue stop
      if (!this.capAllowed(CAP.channelsTyping)) this.typing.stop();
    }
    // `enabled`/`disabled` name FEATURE SETS, which carry no authority (§6.4): recorded for the log and the receipt,
    // never consulted to decide whether something is allowed
    const disabled = Array.isArray(params.disabled) ? params.disabled.map(String) : [];
    const unavailable: { featureSet: string; missingCapabilities: string[]; effect: string }[] = [];
    for (const [name, fs] of Object.entries(FEATURE_SETS)) {
      const missing = this.grant ? fs.uses.filter((u) => !this.granted(u)) : [];
      if (missing.length) unavailable.push({ featureSet: name, missingCapabilities: missing, effect: "disabled" });
      else if (disabled.includes(name)) unavailable.push({ featureSet: name, missingCapabilities: [], effect: "disabled" });
    }
    console.log(`[${ts()}] [mcpl:${this.auth.id}] policy: grant=${this.grant ? [...this.grant].join(",") : "(none given)"}${unavailable.length ? ` degraded=${unavailable.map((u) => u.featureSet).join(",")}` : ""}`);
    return {
      accepted: true,
      mode: unavailable.length ? "degraded" : "full",
      ...(unavailable.length ? { unavailableFeatures: unavailable } : {}),
      notes: [],
    };
  }

  private deliver(text: string, author: { id: string; name: string }, opts?: { tags?: string[]; mentioned?: boolean; metadata?: Record<string, unknown> }) {
    // a plain-MCP host never gets an MCPL frame; channels/incoming is content injection plus wake
    // authority (§14.1), so it is gated on the grant, never on a declaration or a tag (§16.6)
    if (!this.granted(CAP.channelsIncoming)) return;
    // author is rendered into the text (hosts don't label it); the prefix is the id, never the display
    // name, so a host matching its own name isn't woken by a body whose display name contains it
    const rendered = wire.renderLine(author, text);
    const params: ChannelsIncomingParams = {
      messages: [{
        channelId: this.channelId,
        messageId: `ev-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        author,
        timestamp: new Date().toISOString(),
        content: [{ type: "text", text: rendered }],
        ...(opts?.tags ? { tags: opts.tags } : {}),
        // transition shim (issue #1 item 3): `tags` is the contract (§16); these booleans stay until hosts (ConversationRouter
        // `mentioned`, wake-policies `isExplicitMention`) route on tags
        ...((opts?.mentioned || opts?.metadata)
          ? { metadata: { ...(opts?.metadata ?? {}), ...(opts?.mentioned ? { mentioned: true, isExplicitMention: true } : {}) } }
          : {}),
      }],
    };
    this.conn.sendRequest(method.CHANNELS_INCOMING, params).catch((e) => {
      console.error(`[${ts()}] [deliver:${this.auth.id}] channels/incoming failed: ${(e as Error).message?.slice(0, 120)}`);
    });
  }

  async serve() {
    await this.handshake();
    // the agent's own ambient-activity tuning, restored before the body joins: a decision, not a per-session default
    if (activityCfg[this.auth.id]) this.agent.setActivity(activityCfg[this.auth.id]);
    await this.agent.connect();
    // remember the world only after the join, never for a fallback start, and only if this is still the
    // agent's current session: a superseded one finishing late must not overwrite it (#261)
    if (this.recordStart && sessions.get(this.auth.id) === this) rememberWorld(this.auth.id, this.agent.world, this.home);

    // tags describe what an event is; waking is decided from world state (channelOpen, ev.mention), never a tag (§16.6).
    // Media bridge (#104): with EIDO_MEDIA_PORT set, relay media-signalling frames to a local synth (whitelist:
    // WorldAgent.onMedia / sendMedia), loopback only: it can publish audio as this identity. Off by default.
    const mediaPort = Number(process.env.EIDO_MEDIA_PORT ?? 0);
    if (mediaPort > 0) this.startMediaBridge(mediaPort);

    this.agent.onEvent = (ev) => {
      // §16.2 sender facet: status is only its own declaration (PROTOCOL §6a rule 3), verbatim in
      // metadata.declares; only "agent" maps to chat:from-agent (declaration.ts senderFacet; tags per event in event-wire.ts)
      const declares = this.agent.declaresOf(ev.who);
      const md = declares ? { metadata: { declares } } : {};
      if (ev.kind === "say") {
        if (!this.channelOpen && !ev.mention) return; // door closed: chatter stops, knocks get through
        this.deliver(ev.text!, authorOf(ev.who), ev.mention
          ? { tags: eventTags("say", { declares, mention: true }), mentioned: true, ...md }
          : { tags: eventTags("say", { declares }), ...md });
      } else if (ev.kind === "act") {
        // embodied transitions (a gesture, a pose struck or released, sitting down): ambient, so a closed door mutes them
        if (this.channelOpen) this.deliver(`* ${ev.who} ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: eventTags("act", { declares }), ...md });
      } else if (ev.kind === "activity") {
        // the activity pulse: at most one per window, only while something happens in the activity radius;
        // ambient + chat:system, never addressed (hosts opt in on eidoverse:activity-digest or chat:ambient; event-wire.ts)
        if (!this.granted(CAP.channelsIncoming)) {
          // no push channel for this digest: hold it for the `activity` tool (deliver() would drop it silently)
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: eventTags("activity"), metadata: { activity: true } });
      } else if (ev.kind === "weather") {
        // the sky changed on its own: one ambient chat:system line per boundary (RFC-001 rev 3); pull-only hosts read the `activity` ring
        if (!this.granted(CAP.channelsIncoming)) {
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: eventTags("weather"), metadata: { weather: true } });
      } else if (ev.kind === "world-change") {
        // a visible change near this body (an emitter starting, changing, ending): ambient, held like weather
        if (!this.granted(CAP.channelsIncoming)) {
          this.heldActivity.push(`[${new Date(ev.ts).toISOString().slice(11, 16)}Z] ${ev.text}`);
          if (this.heldActivity.length > 8) this.heldActivity.shift();
        } else if (this.channelOpen) this.deliver(`* ${ev.text}`, { id: "world", name: this.agent.world },
          { tags: eventTags("world-change"), metadata: { worldChange: true, ...(declares ? { declares } : {}) } });
      } else if (this.channelOpen) {
        this.deliver(`* ${ev.who} ${ev.kind === "arrive" ? "arrived in the world" : "left the world"}`,
          { id: "world", name: this.agent.world }, { tags: eventTags(ev.kind), ...md });
      }
    };
    this.agent.onPing = (p) => {
      // the ping->channel mapping lives in ping-wire.ts, where a test holds it to what declaration.ts promises
      const d = pingDelivery(p as WirePing, this.agent.declaresOf(p.who));
      if (d) this.deliver(d.text, { id: "world", name: this.agent.world },
        { tags: d.tags, ...(d.mentioned ? { mentioned: true } : {}), ...(d.declares ? { metadata: { declares: d.declares } } : {}) });
    };

    // §5.3: nothing runs between initialize and the read loop, which alone can answer the policy Request;
    // grant-dependent work waits concurrently behind the gate (inline would deadlock). 20 s bounds a silent host.
    const hostMajor = Number(this.hostMcplVersion?.split(".")[0] ?? 0);
    const hostMinor = Number(this.hostMcplVersion?.split(".")[1] ?? 0);
    const awaitsPolicy = this.mcplClient && (hostMajor > 0 || hostMinor >= 5);
    let seenTimer: ReturnType<typeof setInterval> | undefined;
    const prelude = async () => {
    if (awaitsPolicy) await Promise.race([this.policyGate, new Promise((r) => setTimeout(r, 20_000))]);
    if (this.conn.isClosed) return;
    // not awaited: a host that drops unknown requests would deadlock the session; MCPL clients only (mcplClient)
    if (this.granted(CAP.channelsRegister)) this.registerChannels();

    // missed-mention replay, tagged eidoverse:catchup alongside the original addressing (§16). Speech is
    // arrival-only, so only an admin's door gets anything back. Cursor by seq, not timestamp: the inbox
    // no longer holds old history.
    const sinceSeq = lastSeenSeq[seqKey(this.auth.id, this.agent.world)] ?? lastSeenSeq[this.auth.id];
    // "since you last looked" starts at the persisted cursor, not the replayed tail's start; gap mentions are
    // delivered below, scrollback stays on catch_up
    if (sinceSeq != null) this.agent.skipInboxThrough(sinceSeq);
    if (sinceSeq != null) {
      // the live body's matcher: catch-up honours the same alias policy and degrades safely with no matchable name
      const said = await this.agent.missedSince(sinceSeq);
      const missedSeq = said.filter((m) => m.who !== this.auth.id && this.agent.mentionsMe(m.text));
      if (missedSeq.length) {
        this.deliver(`While you were away, ${missedSeq.length} message${missedSeq.length === 1 ? "" : "s"} mentioned you:`,
          { id: "world", name: this.agent.world }, { tags: catchupHeaderTags() });
        for (const m of missedSeq.slice(-10)) {
          // original addressing + the catchup marker (#39); deliver() renders the author itself
          this.deliver(m.text, authorOf(m.who),
            { tags: catchupReplayTags(), mentioned: true });
        }
      }
    }
    const since = sinceSeq != null ? null : lastSeen[this.auth.id];
    if (since != null) {
      const missed = this.agent.inbox.filter((m) => m.kind === "say" && m.ts > since && m.who !== this.auth.id && this.agent.mentionsMe(m.text ?? ""));
      if (missed.length) {
        this.deliver(`While you were away, ${missed.length} message${missed.length === 1 ? "" : "s"} mentioned you:`,
          { id: "world", name: this.agent.world }, { tags: catchupHeaderTags() });
        for (const m of missed.slice(-10)) this.deliver(m.text ?? "", authorOf(m.who),
          { tags: catchupReplayTags(), mentioned: true });
      }
    }
    lastSeen[this.auth.id] = Date.now();
    lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
    persistState();
    seenTimer = setInterval(() => {
      lastSeen[this.auth.id] = Date.now();
      // never persist a watermark from an unsynced body: lastSeq is -1 until the first snapshot, and a stored -1
      // makes the next connect replay the world's whole history as mentions
      if (this.agent.lastSeq >= 0) {
        lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
      }
      persistState();
    }, 60_000);
    };
    prelude().catch((e) => console.error(`[${ts()}] [mcpl:${this.auth.id}] prelude failed: ${(e as Error).message?.slice(0, 160)}`));

    try {
      while (!this.conn.isClosed) {
        const msg = await this.conn.nextMessage();
        // typing was taken on arrival (the constructor's listener); other notifications, stream chunks among them, drop
        if (msg.type !== "request") continue;
        const req = msg.request;
        const params = (req.params ?? {}) as Record<string, unknown>;
        try {
          switch (req.method) {
            // §5.4: a denied `tools` grant behaves as if never advertised, in both handlers
            case "tools/list":
              this.conn.sendResponse(req.id, { tools: this.toolsAllowed()
                ? toolList({ travel: true })
                : [] });   // denied ⇒ as if never advertised
              break;
            case "tools/call":
              if (!this.toolsAllowed()) {
                // -32601: not available to THIS host, not an error about the tool's arguments
                this.conn.sendError(req.id, -32601, "your host hasn't granted this door the tools capability, so the call didn't run, and calling it again won't change that; if you need it, ask whoever runs your host");
                break;
              }
              this.conn.sendResponse(req.id, await handleTool(this.toolCtx(), String(params.name), (params.arguments ?? {}) as Record<string, any>));
              break;
            case "mcpl/manifest":
              // §17.4: the complete manifest, never a delta, same shape and snapshot as initialize; ungated (fetch is
              // host-initiated)
              this.conn.sendResponse(req.id, MANIFEST_WITH_REVISION);
              break;
            case method.FEATURE_SETS_UPDATE: {
              // §5.3/§6.7: the host's policy opens a 0.5 host's door; a malformed one fails closed, keeping the grant
              const receipt = this.applyPolicy(params);
              if ("error" in receipt && typeof receipt.error === "string") {
                this.conn.sendError(req.id, -32602, receipt.error);
                break;
              }
              this.conn.sendResponse(req.id, receipt);
              this.policyAnswered();
              break;
            }
            case method.CHANNELS_LIST:
              this.conn.sendResponse(req.id, { channels: this.channelDescriptors() });
              break;
            case method.CHANNELS_PUBLISH: {
              // the capability gate answers FIRST (-32003, ungranted = as if never advertised); a granted publish that errors
              // answers -32023 (#125, #129)
              if (!this.capAllowed(CAP.channelsPublish)) {
                this.conn.sendError(req.id, -32003, "your host hasn't granted this door channels.publish, so nothing was posted, and posting again won't change that; if you need it, ask whoever runs your host");
                break;
              }
              const pub = this.handlePublish(params as unknown as ChannelsPublishParams);
              if (pub.error) { this.conn.sendError(req.id, -32023, pub.error); break; }
              this.conn.sendResponse(req.id, pub);
              break;
            }
            case method.CHANNELS_OPEN: {
              if (!this.capAllowed(CAP.channelsLifecycle)) {
                this.conn.sendError(req.id, -32003, LIFECYCLE_NOT_GRANTED);
                break;
              }
              // the host's channel_open tool performs the server-side open op here (optional history atomically with it)
              const p = params as { channelId?: string; type?: string; address?: { world?: string }; history?: { limit: number } };
              // §3.2.6: two disagreeing destinations are refused before the current-channel shortcut,
              // or a pair with one half naming the current world would pass as a re-open
              {
                const cid = p.channelId?.startsWith("world:") ? p.channelId.slice(6) : undefined;
                const adr = p.type === "world" ? p.address?.world : undefined;
                if (cid && adr && cid !== adr) {
                  this.conn.sendError(req.id, -32602, `channelId ${shown(p.channelId)} and address.world ${shown(adr)} name different worlds, so nothing was opened; name one world, in either field or in both`);
                  break;
                }
              }
              const matches = p.channelId === this.channelId ||
                (p.channelId == null && p.type === "world" && p.address?.world === this.agent.world);
              if (!matches) {
                // one lane only: cross-world moves go through the travel tool (travelGate, joinWorld); a sibling world's id
                // here is an unknown channel. On the plain-MCP lane the credential is the only gate.
                this.conn.sendError(req.id, -32023,
                  `unknown channel: ${p.channelId ?? JSON.stringify(p.address)} (this door opens only its current world; use the \`travel\` tool to move)`);
                break;
              }
              this.channelOpen = true;
              const limit = Math.min(Math.max(p.history?.limit ?? 0, 0), 100);
              const says = this.agent.inbox.filter((m) => m.kind === "say").slice(-limit);
              this.conn.sendResponse(req.id, {
                channel: this.channelDescriptors()[0],
                ...(limit ? {
                  history: says.map((m, i) => ({
                    channelId: this.channelId,
                    messageId: `hist-${m.ts}-${i}`,
                    author: authorOf(m.who),
                    timestamp: new Date(m.ts).toISOString(),
                    content: [{ type: "text", text: wire.renderLine(authorOf(m.who), m.text ?? "") }],
                  })),
                  historyTruncated: this.agent.inbox.filter((m) => m.kind === "say").length > limit,
                } : {}),
              });
              break;
            }
            case method.CHANNELS_CLOSE: {
              if (!this.capAllowed(CAP.channelsLifecycle)) {
                this.conn.sendError(req.id, -32003, LIFECYCLE_NOT_GRANTED);
                break;
              }
              const p = params as { channelId?: string };
              if (p.channelId !== this.channelId) {
                this.conn.sendError(req.id, -32023, `unknown channel: this connection's channel is "${this.channelId}", and the request named ${shown(p.channelId)}, so nothing was closed`);
                break;
              }
              // the agent shuts their door: ambient chatter stops; mentions and walk-ups get through (a knock is not chatter)
              this.channelOpen = false;
              this.conn.sendResponse(req.id, { closed: true });
              break;
            }
            default:
              this.conn.sendError(req.id, -32601, `Method not found: ${req.method}`);
          }
        } catch (e) {
          this.conn.sendError(req.id, -32000, (e as Error).message);
        }
      }
    } catch (e) {
      if ((e as Error).name !== "ConnectionClosedError") throw e;
    } finally {
      clearInterval(seenTimer);
      lastSeen[this.auth.id] = Date.now();
      // same guard as the timer: a fatally failed travel leaves lastSeq at -1 on the way out
      if (this.agent.lastSeq >= 0) {
        lastSeenSeq[seqKey(this.auth.id, this.agent.world)] = this.agent.lastSeq;
      }
      persistState();
      this.close();
    }
  }

  private async handshake() {
    const msg = await this.conn.nextMessage();
    if (msg.type !== "request" || msg.request.method !== "initialize") {
      this.conn.close();
      throw new Error("expected initialize first");
    }
    const initParams = msg.request.params as unknown as McplInitializeParams | undefined;
    const hostMcpl = initParams?.capabilities?.experimental?.mcpl;
    const mcplRequested = hostMcpl !== undefined;
    this.mcplClient = mcplRequested;
    this.hostMcplVersion = typeof hostMcpl?.version === "string" ? hostMcpl.version : null;
    // the manifest (§5.1) with its §17.2 revision, as mcpl/manifest answers; cast because the pinned
    // mcpl-core-ts types describe 0.4's shape while the wire follows 0.5
    const serverCaps = MANIFEST_WITH_REVISION as unknown as McplCapabilities;
    const capabilities: InitializeCapabilities = { tools: {}, ...(mcplRequested ? { experimental: { mcpl: serverCaps } } : {}) };
    const result: McplInitializeResult = {
      protocolVersion: "2024-11-05",
      capabilities,
      serverInfo: { name: "eidoverse-worlds", version: "0.1.0" },
    };
    this.conn.sendResponse(msg.request.id, result);
    const inited = await this.conn.nextMessage();
    if (!(inited.type === "notification" && inited.notification.method === "notifications/initialized")) {
      this.conn.close();
      throw new Error("expected notifications/initialized");
    }
  }

  private channelDescriptors(): ChannelDescriptor[] {
    return [{
      id: this.channelId,
      type: "world",
      label: `eidoverse — ${this.agent.world}`,
      direction: "bidirectional" as const,
      address: { world: this.agent.world },
      // channels bootstrap closed unless declared open; the embodied world must be open from the start
      initiallyOpen: true,
      metadata: { epoch: this.epoch, ...(this.foundedHere ? { created: true } : {}) },   // RFC-005 §3.2.3d/§3.2.7

    } as ChannelDescriptor];
  }

  private async registerChannels() {
    const params: ChannelsRegisterParams = { channels: this.channelDescriptors() };
    try { await this.conn.sendRequest(method.CHANNELS_REGISTER, params); } catch { /* non-MCPL host: tools still work */ }
  }

  /** `start` at a turn (again every 7 s), `stop` at its end; the relay keeps the dots up between (typing-relay.ts).
   *  Not from the stream, whose chunks may arrive only on publish. */
  private onTyping(params: unknown): void {
    // a signal parsed after the session closed would re-arm the relay on a closed body
    if (this.conn.isClosed) return;
    // a notification, so without the channels.typing grant it is dropped silently (hosts may not withhold, §14.1)
    if (!this.capAllowed(CAP.channelsTyping)) return;
    const p = params as { channelId?: string; op?: string } | undefined;
    if (p?.channelId !== this.channelId) return;
    // `op` isn't in the spec's params: missing reads as start, unknown is ignored
    if (p?.op === "stop") this.typing.stop();
    else if (p?.op === undefined || p.op === "start") this.typing.start(this.agent);
  }

  private handlePublish(params: ChannelsPublishParams): ChannelsPublishResult & { error?: string } {
    // §3.2.3 cutoff: a publish to a channel we've left is answered, not dropped (the caller maps it to -32023)
    if (params.channelId !== this.channelId) {
      return { delivered: false, error: `unknown channel: this connection's channel is "${this.channelId}", and the publish named ${shown(params.channelId)}, so nothing was posted` };
    }
    const text = (params.content ?? [])
      .filter((b): b is { type: "text"; text: string } => b.type === "text")
      .map((b) => b.text).join("\n").trim();
    if (!text) return { delivered: false };
    this.agent.say(text.slice(0, 4000));
    return { delivered: true };
  }

  // vision is the world's own API: the sequencer routes /snap to whatever renderer serves that world
  /** The session's half of the shared tool table (tools.ts): per-identity persistence, the push/hold truth for
   *  ambient activity, the catch_up cursor, and the travel machinery only a channel session has. */
  private toolCtx(): ToolCtx {
    return {
      agent: this.agent,
      canPush: () => this.granted(CAP.channelsIncoming),
      heldActivity: this.heldActivity,
      cursor: this,
      rememberAvatar: (path) => { chosenAvatar[this.auth.id] = path; persistState(); },
      rememberActivity: (cfg) => { activityCfg[this.auth.id] = cfg; persistState(); },
      travel: (world) => this.travelTool(world),
      worldPolicy: { canJoin: (world) => joinAllowed(this.auth, world, this.home), canFound: this.auth.create !== false },
    };
  }

  private async travelTool(target: string) {
    const text = (t: string) => ({ content: [{ type: "text" as const, text: t }] });
    // every refusal before the detach leaves the body where it was
    const stayed = `travel refused, so you're still in "${this.agent.world}": `;
    if (!WORLD_NAME_RE.test(target))
      return { content: [{ type: "text", text: `${stayed}${shown(target)} isn't a valid world name; a name is 1 to 64 lowercase letters, digits, _ or -` }], isError: true };
    if (target === this.agent.world) return text(`Already in "${target}".`);
    const gate = await this.travelGate(target);
    if (!gate.ok) return { content: [{ type: "text", text: `${stayed}${gate.why}` }], isError: true };
    try {
      await this.joinWorld(target, gate.founding);
    } catch (e) {
      const f = this.classifyJoinFailure(e);
      // safe before the return only because finishFatalJoin defers a macrotask and the send is synchronous:
      // an await between this return and the send would kill the socket with the reply unwritten
      if (f.fatal) this.finishFatalJoin();
      return { content: [{ type: "text", text: f.fatal
        // say plainly that the seat is gone: an agent told only "travel failed" keeps issuing verbs into a closed connection
        ? `travel failed past the point of no return: ${f.why}. Your old body was already released, so this connection is now CLOSED; your host has to reconnect to the door for a new body.`
        : `${stayed}${f.why}` }], isError: true };
    }
    // written for the agent: an MCPL host learns the move from channels/changed, but for a plain-MCP host
    // this string is the only thing it ever learns, so it states what moved and what did not
    return text(
      `${gate.founding ? "Founded and entered" : "Arrived in"} "${target}" (attachment ${this.epoch}). ` +
      `Your identity, avatar and attention settings came with you; your anims and body-mode did not (they are world-local). Your chat cursor starts fresh here. Use \`look\` to see where you are.`,
    );
  }
}

// ---- server ----------------------------------------------------------------

// discovery: an agent who finds this door without credentials must leave knowing WHERE they come from; the
// refusal carries the instructions (teach-by-bounce)
const GUIDE_URL = `https://${HN_ISS}/agents.md`;
const DOOR_HELP =
  `This is the eidoverse-worlds agent door: MCP over WebSocket (newline-delimited JSON-RPC).\n` +
  `Connect with an identity token: wss://<this host>/mcpl?token=aid1...\n` +
  `How to get one (agents & operators, no Connectome required): ${GUIDE_URL}\n`;

// echoed by /healthz (unset: exactly "ok") so a harness can tell its own child from a stale door on the port
const INSTANCE_NONCE = process.env.MCPL_INSTANCE_NONCE ?? "";
const http = createServer((req, res) => {
  // a plain HTTP GET is someone curious (curl, a browser, an agent probing): answer with the pointer, not a hang-up
  res.writeHead(req.url === "/healthz" ? 200 : 426, { "content-type": "text/plain; charset=utf-8", upgrade: "websocket" });
  res.end(req.url === "/healthz" ? (INSTANCE_NONCE ? `ok ${INSTANCE_NONCE}\n` : "ok\n") : DOOR_HELP);
});
const wss = new WebSocketServer({ server: http });

/** Answer the first request(s) with a JSON-RPC error naming the fix: clients surface those verbatim, unlike a WS
 *  close reason. */
function refuseWithGuidance(ws: WebSocket, why: string) {
  console.log(`[${ts()}] [mcpl] unauthenticated connection: ${why} — teaching, then closing`);
  const timer = setTimeout(() => { try { ws.close(4001, "unauthorized"); } catch { /* gone */ } }, 15_000);
  ws.on("message", (raw) => {
    for (const line of String(raw).split("\n")) {
      if (!line.trim()) continue;
      let id: unknown = null;
      try { id = (JSON.parse(line) as { id?: unknown }).id ?? null; } catch { /* not json: still answer below */ }
      if (id === null || id === undefined) continue; // notification: nothing to answer
      ws.send(JSON.stringify({
        jsonrpc: "2.0", id,
        error: { code: -32001, message: `unauthorized: ${why}. This door needs an identity token (aid1) in the URL: wss://eidoverse.animalabs.ai/mcpl?token=... — how to get one: ${GUIDE_URL}` },
      }) + "\n");
      // one taught answer is enough; close after it flushes
      clearTimeout(timer);
      setTimeout(() => { try { ws.close(4001, "unauthorized — see " + GUIDE_URL); } catch { /* gone */ } }, 100);
      return;
    }
  });
}
/** Host declined the new descriptor at PREPARE (RFC-005 §3.2.3b). Unlike an attach failure nothing has moved, so
 *  the caller answers -32017 and leaves the connection exactly where it was. */
class JoinDeclined extends Error {}

/** Refused for a host without the grant. */
const LIFECYCLE_NOT_GRANTED = "your host hasn't granted this door channels.lifecycle, so no channel was opened or closed, and calling again won't change that; if you need it, ask whoever runs your host";

/** "May this identity go to `name`?", asked of the sequencer's /access as the agent (server/access.ts).
 *  Null when it couldn't be asked (callers fail closed); time-bounded so an unreachable sequencer fails fast. */
type AccessAnswer = { exists: boolean; you: "enter" | "watch" | "none"; why?: string; found?: { ok: boolean; why?: string } };
async function accessProbe(name: string, token: string): Promise<AccessAnswer | null> {
  // URL surgery, not string surgery: a WORLD_URL with a query string or mount path defeats a regex replace
  const u = new URL(process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws");
  u.protocol = u.protocol === "wss:" ? "https:" : "http:";
  u.pathname = u.pathname.replace(/\/ws$/, "") + "/access";
  u.search = `?world=${encodeURIComponent(name)}`;
  try {
    const r = await fetch(u, { signal: AbortSignal.timeout(2_000), headers: { authorization: `Bearer ${token}` } });
    if (!r.ok) return null;
    const a = (await r.json()) as AccessAnswer;
    return typeof a?.exists === "boolean" && typeof a?.you === "string" ? a : null;
  } catch { return null; }
}

/** RFC-005 join policy for both lanes: the credential can only narrow (no list = no narrowing; the world
 *  decides via accessProbe, docs/DESIGN-world-access.md). The name shape is the sequencer's (server/limits.ts). */
function joinAllowed(auth: Auth, world: string, home = auth.world ?? "commons"): boolean {
  if (!WORLD_NAME_RE.test(world)) return false;
  if (!auth.worlds) return true;
  // home is always allowed, passed explicitly: a session's auth.world may have been rewritten (#261)
  return world === home || auth.worlds.some((w) => w === "*" || w === world);
}
/** Per-world watermark key for missed-mention replay (a seq means nothing in another world); bare-id
 *  entries are still read as a fallback. */
const seqKey = (id: string, world: string) => `${id}@${world}`;
// registry hints refresh per attempt; admitted identities survive reloads and disconnects for replay. Neither
// grants authentication authority.
const wire = wireAuthors(new Map<string, string>());
const authorOf = (id: string) => wire.authorOf(id);
const sessions = new Map<string, Session>(); // identity -> live session (newest wins)
wss.on("connection", (ws, req) => {
  const token = new URL(req.url ?? "/", "http://localhost").searchParams.get("token");
  const registry = readTokens();
  wire.refreshIndex(displayNameIndex(registry));
  let auth: Auth | undefined = token ? lookupToken(registry, token) : undefined;
  let aidReason: string | null = null;
  if (!auth && token?.startsWith("aid1.") && HN_ISSUER_KEY) {
    const v = verifyToken(token, { issuerId: HN_ISSUER_KEY, iss: HN_ISS, aud: HN_AUD, requireScopes: ["worlds:join"] });
    if (v.ok) {
      const p = v.payload;
      // id = mention handle (world addressing is name-based); the home node enforced name uniqueness at enrollment
      auth = {
        id: aid1Slug(p),
        name: p.name,
        // enrollment reserves only the whole name, never a shortened alias
        dropMentionQualifiers: false,
        world: typeof p.claims?.world === "string" ? (p.claims.world as string) : undefined,
        avatar: typeof p.claims?.avatar === "string" ? (p.claims.avatar as string) : undefined,
        worlds: Array.isArray(p.claims?.worlds) && (p.claims.worlds as unknown[]).every((w) => typeof w === "string")
          ? (p.claims.worlds as string[]) : undefined,
        // founding is every member's (a few a day, the sequencer's cap); an explicit `create: false` narrows it away
        create: p.claims?.create === false ? false : undefined,
      };
      console.log(`[${ts()}] aid1 agent: ${p.sub} ("${p.name}") exp ${new Date(p.exp * 1000).toISOString()}`);
    } else {
      console.error(`[${ts()}] aid1 token rejected: ${v.reason}`);
      aidReason = v.reason; // the dialing agent deserves the same specificity as our logs
    }
  }
  if (!auth) {
    refuseWithGuidance(ws, token ? (aidReason ? `token refused (${aidReason})` : "unrecognized token") : "no token provided");
    return;
  }
  // RFC-005 §3.3: ?world= is the initial attachment, under the in-session join policy; a denial refuses.
  // Frames are buffered across the async gates and replayed in admit(), or the host's initialize is lost.
  const held: unknown[] = [];
  const hold = (data: unknown) => held.push(data);
  ws.on("message", hold);
  const reqWorld = new URL(req.url ?? "/", "http://localhost").searchParams.get("world");
  const dialWorld = reqWorld;
  const mintedWorld = auth.world ?? "commons";   // before the dial lane rewrites it
  if (reqWorld && reqWorld !== (auth.world ?? "commons")) {
    if (joinAllowed(auth, reqWorld)) {
      console.log(`[${ts()}] [mcpl] ${auth.id} dial-time world "${reqWorld}" granted (policy)`);
      auth = { ...auth, world: reqWorld };
    } else {
      // RFC-005 §3.3: no silent fallback; refuse and name the denied destination in the close reason
      console.log(`[${ts()}] [audit] dial-time world "${reqWorld}" DENIED for ${auth.id} — refusing connection`);
      refuseWithGuidance(ws, `world "${reqWorld}" is outside the worlds this credential is limited to`);
      return;
    }
  }
  // founding (RFC-005 §3.2.7): the sequencer enforces the cap (server/access.ts); we probe first to refuse
  // with guidance. Only a world the agent chose (dialled, other than the minted one) is gated; the minted
  // world, even dialled explicitly, never is, or a fresh deployment can't found its default world.
  const chosen = dialWorld !== null && dialWorld !== mintedWorld;
  // the world decides every attachment, asked before the body exists. Resume (no world asked): the last
  // world, unless recorded under another home, outside the credential, or no longer admitting/existing/
  // answerable; then home, logged. A resume never founds.
  const memo = !dialWorld ? lastWorld[auth.id] : undefined;
  const resume = memo && memo.home === mintedWorld && memo.world !== mintedWorld
    && WORLD_NAME_RE.test(memo.world) && joinAllowed(auth, memo.world, mintedWorld) ? memo.world : undefined;
  // every skipped resume says why, so a trip home reads as expected rather than as lost memory (#261)
  if (memo && !resume && memo.world !== mintedWorld) {
    const why = memo.home !== mintedWorld ? `its home changed from "${memo.home}" to "${mintedWorld}"`
      : !WORLD_NAME_RE.test(memo.world) ? "the remembered name is not a world name"
        : "its credential no longer allows that world";
    console.log(`[${ts()}] [mcpl] ${auth.id}: not resuming in "${memo.world}" — ${why}; starting at home "${mintedWorld}"`);
  }
  let recordStart = true;   // false: started at home only because the memory could not be verified
  {
    void (async () => {
      if (resume) {
        const r = await accessProbe(resume, token ?? "");
        if (r?.exists && r.you === "enter") {
          console.log(`[${ts()}] [mcpl] ${auth!.id} resumes in world "${resume}" (where it last was)`);
          auth = { ...auth!, world: resume };
          admit(); return;
        }
        if (!r) recordStart = false;   // keep the memory: the next reconnect tries it again
        console.log(`[${ts()}] [mcpl] ${auth!.id}: last world "${resume}" ${!r ? "could not be checked (memory kept)" : !r.exists ? "no longer exists" : "isn't open to it now"} — starting at home "${mintedWorld}"`);
      }
      const wname = auth!.world ?? "commons";
      const a = await accessProbe(wname, token ?? "");
      if (!a) {
        // the sequencer could not be asked: a chosen destination fails closed; the minted world proceeds (the sequencer
        // still decides at the join)
        if (chosen) { refuse(`could not ask the world server about "${wname}" — try again in a moment`); return; }
        admit(); return;
      }
      if (a.exists && a.you !== "enter") {
        console.log(`[${ts()}] [audit] dial-time world "${wname}" not open to ${auth!.id} (${a.you}) — refusing connection`);
        refuse(a.you === "watch" ? `you may watch "${wname}" but not join it in a body` : `"${wname}" isn't open to you`);
        return;
      }
      if (!a.exists && chosen) {
        if (auth!.create === false || !a.found?.ok) {
          const why = auth!.create === false ? "this credential may not found worlds" : (a.found?.why ?? "the world server refused");
          console.log(`[${ts()}] [audit] founding DENIED: ${auth!.id} → "${wname}" (dial-time: ${why})`);
          refuse(`world "${wname}" does not exist, and it can't be founded now: ${why}`);
          return;
        }
        console.log(`[${ts()}] [audit] founding GRANTED: ${auth!.id} → "${wname}" (dial-time)`);
      }
      admit();
    })();
  }

  /** Refuse after the hold-buffer is installed: drop it and replay what was held, so refuseWithGuidance
   *  can answer a client that sent `initialize` on open. */
  function refuse(why: string) {
    ws.off("message", hold);
    refuseWithGuidance(ws, why);
    for (const d of held) ws.emit("message", d);
    held.length = 0;
  }

  function admit() {
    // a socket that closed during the async check must not be admitted: it would kill its replacement's
    // session (#258). 1 = WebSocket.OPEN.
    if (ws.readyState !== 1) {
      console.log(`[${ts()}] [mcpl] ${auth!.id}: connection closed during admission — dropped`);
      return;
    }
    // one body per identity: a half-open predecessor is killed cleanly instead of rubberbanding against its successor
    const prev = sessions.get(auth!.id);
    if (prev) { console.log(`[${ts()}] [mcpl] ${auth!.id} reconnected — taking over previous session`); prev.close(); }
    const session = new Session(auth!, ws, token ?? "", mintedWorld, recordStart);
    wire.rememberAuthor(auth!);
    sessions.set(auth!.id, session);
    startSession(session, ws, auth!);
    ws.off("message", hold);
    for (const d of held) ws.emit("message", d);
  }
});
/** Everything after admission, split out so the async founding gate owns admit/refuse without duplicating the
 *  session lifecycle. */
function startSession(session: Session, ws: WebSocket, auth: Auth) {
  // half-open detection that tolerates a thinking agent (a long generation can't service its socket):
  // MAX_MISSES consecutive missed pongs, about 2 minutes, before reaping; any inbound message is proof of life.
  const PING_MS = Number(process.env.MCPL_PING_SEC ?? 20) * 1000;
  const MAX_MISSES = Number(process.env.MCPL_PING_MISSES ?? 6);
  let misses = 0;
  const seen = () => { misses = 0; };
  ws.on("pong", seen);
  ws.on("message", seen);   // it is talking to us: it is alive
  const pinger = setInterval(() => {
    if (misses >= MAX_MISSES) {
      const quiet = Math.round((MAX_MISSES * PING_MS) / 1000);
      console.log(`[${ts()}] [mcpl] ${auth.id} silent for ~${quiet}s (${misses} missed pongs) — terminating half-open session`);
      clearInterval(pinger);
      ws.terminate();
      return;
    }
    misses++;
    try { ws.ping(); } catch { /* socket already dying; close event will fire */ }
  }, PING_MS);
  session.serve()
    .catch((e) => { console.error(`[${ts()}] [session:${auth.id}]`, e.message); })
    .finally(() => {
      clearInterval(pinger);
      session.close();
      if (sessions.get(auth.id) === session) sessions.delete(auth.id);
      console.log(`[${ts()}] [mcpl] ${auth.id} session ended`);
    });
  console.log(`[${ts()}] [mcpl] ${auth.id} connected`);
}
http.listen(PORT, "0.0.0.0", () => {
  console.log(`eidoverse-worlds network MCPL on ws://0.0.0.0:${PORT} (${Object.keys(readTokens()).length} tokens)`);
});
