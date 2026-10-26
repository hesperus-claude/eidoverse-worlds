// Chat bridge: mirrors a world's spoken chat into one Discord text channel, and that channel's messages back in as speech.
//   world WS (embodied "discord") ── `say` entries of the log stream ──▶ Discord channel
//   Discord channel ── messages ──▶ a door `say` request {text: "author: …"}
// The join says `replica: true` (others are refused); actors are opaque ids named by the stream's `names` and the
// snapshot's cut.names; a say is {type: "request", id, verb: "say", args: {text}} answered by `reply` (a refusal is
// logged, not retried).
// Joins EMBODIED: authoring (even `say`, rank 0) needs a body, and the world honestly shows a presence named "discord".
// Relayed text is attributed inside the say ("author: …"), so provenance survives in the log.
// Loop safety, both by identity: world → Discord skips entries by the bridge's own identity (cut.you); Discord →
// world skips bots/webhooks (humans only by default).
// Env:
//   WORLD_URL      ws(s)://host/ws            (default ws://127.0.0.1:8940/ws)
//   WORLD_TOKEN    door key                    (JOIN_TOKEN accepted too, issue #41)
//   WORLD_NAME     world to mirror             (default commons)
//   BRIDGE_ID      in-world identity           (default "discord")
//   DISCORD_TOKEN  bot token                   (omit with DRY_RUN=1)
//   CHANNEL_ID     the mirrored text channel
//   ALLOW_BOTS=1   relay other bots' Discord messages too (default: humans only)
//   DRY_RUN=1      no Discord: world lines print to stdout, stdin "Name: text" lines play Discord messages
// The Discord application needs the MESSAGE CONTENT privileged intent (dev portal → Bot), or every message arrives empty.
// Queues, both directions: bounded, oldest dropped with a log line (a mirror minutes behind is worse than an admitted hole).

const WORLD_URL = process.env.WORLD_URL ?? "ws://127.0.0.1:8940/ws";
const WORLD_TOKEN = process.env.WORLD_TOKEN ?? process.env.JOIN_TOKEN ?? "";
const WORLD_NAME = process.env.WORLD_NAME ?? "commons";
const BRIDGE_ID = process.env.BRIDGE_ID ?? "discord";
const CHANNEL_ID = process.env.CHANNEL_ID ?? "";
const ALLOW_BOTS = process.env.ALLOW_BOTS === "1";
const DRY_RUN = process.env.DRY_RUN === "1";

const MAX_BACKLOG = 50;        // per direction; beyond this the oldest drop
const MAX_LINE_CHARS = 1500;   // Discord → world cap (with honest ellipsis)
const DISCORD_CHUNK = 1900;    // world → Discord split point (limit is 2000)
const SEND_GAP_MS = 550;  // under the door's 20 says per 10 s per actor (authority/gate.js RATE), with room
const RATE_BACKOFF_MS = 2000;  // a say refused `rate` anyway goes back to the front of the queue and waits this long

const log = (m: string) => console.log(`[chatbridge ${new Date().toISOString().slice(11, 19)}] ${m}`);

// ---------------------------------------------------------------- world → discord

type Out = { actor: string; text: string; at: number };
const toDiscord: Out[] = [];
let postChannel: { send: (o: unknown) => Promise<unknown> } | null = null;
let postHook: { send: (o: unknown) => Promise<unknown> } | null = null;
let posting = false;

// webhook usernames may not contain "discord" or "clyde" (API rule) and cap at 80 chars
const hookName = (actor: string) =>
  (actor.replace(/discord/gi, "disc0rd").replace(/clyde/gi, "clyd3").trim() || "someone").slice(0, 80);

// Discord rejects content that RENDERS empty (API 50006) even when trim() keeps it: filter invisible code points first,
// or the webhook-error path sticks the mirror in plain-post mode
const INVISIBLE =
  /[\s\u00ad\u034f\u061c\u115f\u1160\u17b4\u17b5\u180b-\u180e\u200b-\u200f\u202a-\u202e\u2060-\u206f\u3164\ufe00-\ufe0f\ufeff\uffa0]/gu;
const sendable = (s: string) => s.replace(INVISIBLE, "").length > 0;

async function postOnce(actor: string, chunk: string) {
  // never ping: @everyone in a world line stays ink, not a bell
  const quiet = { allowedMentions: { parse: [] } };
  if (postHook) {
    try {
      // a per-speaker webhook username, so the channel reads as a conversation
      await postHook.send({ content: chunk, username: hookName(actor), ...quiet });
      return;
    } catch (e) {
      // only a GONE webhook (10015 / 10003) justifies the sticky fallback; any other error gets pumpDiscord's retry
      const code = (e as any)?.code;
      if (code !== 10015 && code !== 10003) throw e;
      log(`webhook gone (${(e as Error).message}) — falling back to plain posts`);
      postHook = null;
      chunk = `**${actor}** — ${chunk}`;
    }
  }
  await postChannel?.send({ content: chunk, ...quiet });
}

async function pumpDiscord() {
  if (posting) return;
  posting = true;
  while (toDiscord.length) {
    while (toDiscord.length > MAX_BACKLOG) {
      const d = toDiscord.shift()!;
      log(`⏭ discord backlog — dropped "${d.actor}: ${d.text.slice(0, 40)}…"`);
    }
    const line = toDiscord.shift()!;
    const body = postHook || DRY_RUN ? line.text : `**${line.actor}** — ${line.text}`;
    for (let i = 0; i < body.length; i += DISCORD_CHUNK) {
      const chunk = body.slice(i, i + DISCORD_CHUNK);
      if (!sendable(chunk)) {
        log(`⏭ unsendable chunk from ${line.actor} (renders empty on Discord) — skipped`);
        continue;
      }
      if (DRY_RUN) { log(`→ discord [${line.actor}]: ${chunk}`); continue; }
      try {
        await postOnce(line.actor, chunk);
      } catch (e) {
        log(`discord send failed: ${(e as Error).message} — retrying once in 3s`);
        await new Promise((r) => setTimeout(r, 3000));
        await postOnce(line.actor, chunk).catch((e2) =>
          log(`dropped after retry: ${(e2 as Error).message}`));
      }
    }
  }
  posting = false;
}

// ---------------------------------------------------------------- discord → world

type In = { author: string; text: string; at: number };
const toWorld: In[] = [];
let worldWs: WebSocket | null = null;
let joined = false;
let speaking = false;
let reqN = 0;
const inFlight = new Map<string, In>();   // request id → the line it carries, until the world replies
let holdUntil = 0;                        // a rate refusal's backoff
let requeued = 0;  // put back during this backoff (replies come in send order, so they go back in order)

async function pumpWorld() {
  if (speaking) return;
  speaking = true;
  while (toWorld.length) {
    if (!joined || worldWs?.readyState !== WebSocket.OPEN) break; // flushed on rejoin
    while (toWorld.length > MAX_BACKLOG) {
      const d = toWorld.shift()!;
      log(`⏭ world backlog — dropped "${d.author}: ${d.text.slice(0, 40)}…"`);
    }
    if (Date.now() < holdUntil) { await new Promise((r) => setTimeout(r, holdUntil - Date.now())); continue; }
    const m = toWorld.shift()!;
    let text = `${m.author}: ${m.text}`;
    if (text.length > MAX_LINE_CHARS) text = `${text.slice(0, MAX_LINE_CHARS)}…`;
    const id = `chatbridge-${++reqN}`;
    inFlight.set(id, m);
    worldWs.send(JSON.stringify({ type: "request", id, verb: "say", args: { text } }));
    await new Promise((r) => setTimeout(r, SEND_GAP_MS));
  }
  speaking = false;
}

// ---------------------------------------------------------------- world socket

let lastSeq = -Infinity;  // dedupe across reconnects (a log re-delivery overlaps live)
let myId: string | null = null; // the bridge's own identity (opaque), from the snapshot
const names: Record<string, string> = {};  // identity → display name, as the world sends it

function connectWorld() {
  const ws = new WebSocket(WORLD_URL);
  worldWs = ws;
  ws.onopen = () =>
    ws.send(JSON.stringify({ type: "join", world: WORLD_NAME, id: BRIDGE_ID, token: WORLD_TOKEN, replica: true }));
  ws.onclose = () => {
    joined = false;
    log("world socket closed — reconnecting in 1.5s");
    setTimeout(connectWorld, 1500);
  };
  ws.onmessage = (ev) => {
    let msg: any;
    try { msg = JSON.parse(String(ev.data)); } catch { return; }
    if (msg.type === "error") { log(`world says: ${msg.error}`); return; }
    if (msg.type === "reply") {
      const line = inFlight.get(msg.id); inFlight.delete(msg.id);
      const refused = msg.reply?.refused;
      if (line && refused?.code === "rate") {  // too fast after all: resend it in its place after a pause
        if (Date.now() >= holdUntil) requeued = 0;
        toWorld.splice(requeued++, 0, line); holdUntil = Date.now() + RATE_BACKOFF_MS;
        log(`world asked to slow down — "${line.author}: ${line.text.slice(0, 40)}" waits ${RATE_BACKOFF_MS / 1000} s`);
        void pumpWorld();
      } else if (msg.reply?.ok === false || msg.ok === false) log(`world refused a say: ${refused?.reason ?? JSON.stringify(refused ?? msg.reply)}`);
      return;
    }
    if (msg.type === "snapshot") {
      joined = true;
      myId = msg.cut?.you ?? null;
      Object.assign(names, msg.cut?.names ?? {});
      // live lines only: at or before the snapshot's head is history (the head, not a remembered mark, so a reset world isn't muted)
      lastSeq = Number.isInteger(msg.cut?.head) ? msg.cut.head : lastSeq;
      log(`joined "${msg.world}" as ${msg.you} (${msg.state?.recentChat?.length ?? 0} recent lines skipped — live lines only)`);
      pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
      return;
    }
    if (msg.type !== "log") return;
    Object.assign(names, msg.names ?? {});
    (msg.entries ?? []).forEach((e: any, i: number) => {
      if (e?.kind !== "say") return;
      const seq = msg.from + i;
      if (seq <= lastSeq) return;
      lastSeq = seq;
      if (myId && e.actor === myId) return; // our own speech echoing back
      const text = String(e.body?.text ?? "").trim();
      if (!text) return;
      const actor = names[e.actor] ?? String(e.actor);
      toDiscord.push({ actor, text, at: Date.now() });
      pumpDiscord().catch((err) => log(`discord pump error: ${err.message}`));
    });
  };
}

// ---------------------------------------------------------------- discord

async function connectDiscord() {
  if (DRY_RUN) {
    log("DRY_RUN — stdin plays Discord: type lines like  Name: hello world");
    (async () => {
      for await (const chunk of process.stdin) {
        for (const raw of String(chunk).split("\n")) {
          const m = raw.match(/^([^:]{1,64}):\s*(.+)$/);
          if (!m) continue;
          toWorld.push({ author: m[1].trim(), text: m[2], at: Date.now() });
          pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
        }
      }
    })();
    return;
  }
  const TOKEN = process.env.DISCORD_TOKEN ?? "";
  if (!TOKEN || !CHANNEL_ID) throw new Error("DISCORD_TOKEN and CHANNEL_ID required (or DRY_RUN=1)");
  const { Client, GatewayIntentBits, Events } = await import("discord.js");
  const client = new Client({
    intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent],
  });
  await client.login(TOKEN);
  // Events.ClientReady tracks the v14→v15 "ready"→"clientReady" rename
  await new Promise<void>((res) => client.once((Events?.ClientReady ?? "ready") as any, () => res()));
  const ch = await client.channels.fetch(CHANNEL_ID);
  if (!ch || !("send" in ch)) throw new Error(`channel ${CHANNEL_ID} is not a sendable text channel`);
  postChannel = ch as unknown as { send: (o: unknown) => Promise<unknown> };
  log(`discord: mirroring #${(ch as any).name ?? CHANNEL_ID} as ${client.user?.tag}`);
  // per-speaker names ride a webhook: reuse one a restart left, else create; without Manage Webhooks, names go inline
  try {
    const hooks = await (ch as any).fetchWebhooks();
    postHook = hooks.find((h: any) => h.token && h.owner?.id === client.user?.id)
      ?? await (ch as any).createWebhook({ name: "eidoverse" });
    log("webhook: per-speaker names on");
  } catch (e) {
    log(`no webhook (${(e as Error).message}) — posting as the bot with inline names`);
  }

  client.on("messageCreate", (m: any) => {
    if (m.channelId !== CHANNEL_ID) return;
    if (m.webhookId && m.webhookId === (postHook as any)?.id) return; // our own mirror, always
    if ((m.author?.bot || m.webhookId) && !ALLOW_BOTS) return; // loop gate + bot hygiene
    let text = String(m.content ?? "").replace(/[\u0000-\u0009\u000b-\u001f\u007f]/g, "").trim();
    const files = [...(m.attachments?.values?.() ?? [])].map((a: any) => a.url).filter(Boolean);
    if (files.length) text = [text, ...files].filter(Boolean).join(" ");
    if (!text) return;
    const author = String(m.member?.displayName ?? m.author?.username ?? "someone").slice(0, 64);
    toWorld.push({ author, text, at: Date.now() });
    pumpWorld().catch((e) => log(`world pump error: ${e.message}`));
  });
}

await connectDiscord();
connectWorld();
log(`bridging world "${WORLD_NAME}" (${WORLD_URL}) as "${BRIDGE_ID}" — ${DRY_RUN ? "DRY RUN" : `channel ${CHANNEL_ID}`}`);
