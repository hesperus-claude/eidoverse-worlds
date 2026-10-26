// lite.js — entry for a device that can't hold the world: chat, the action row, who's here; no canvas, the real net.js.
// A separate entry, not a flag: main.js's static imports would still fetch ~2MB (index.html chooses).
import { say } from './lib/net.js';
import { chooseClient } from './lib/litechoice.js';
import { CONFIG, bus, report, setToken } from './lib/base.js';
// not ui.js: the desktop shell reaches the engine (videopanel.js, profile.js); lite builds from renderer-free primitives
import { makeFrame } from './lib/windows.js';
import { initChat, logChat } from './lib/chat.js';
import {
  net, connect, initIdentity, wireNet, sendTyping, sendPoseExact,
  loginUrl,
} from './lib/net.js';
import { initBoot, markPhase, finishBoot } from './lib/boot.js';
import * as participants from './lib/participants_lite.js';
import { initLiteActions } from './lib/actionbar_lite.js';
// without the narrator a sent say never shows
import { initCauses } from './lib/realize/livechat.js';
import { initRecentChat } from './lib/realize/recentchat.js';

// no renderer will ever set it, so claim the boot watchdog's flag here; if this module never runs, nothing does
globalThis.__ewEngineUp = true;

// decided in index.html; a demotion must SAY why, above all after a crash
const WHY = globalThis.__ewLiteWhy ?? 'url';
const WHY_TEXT = {
  // only for a reason with no card (liteBanner)
  default: 'lite client \u2014 chat, the action bar, and who\u2019s here',
};

/** The person's choice, saved, the address left clean (litechoice.js). */
export function tryFullWorld() { chooseClient(false); }

// Re-send the server's settled pose verbatim plus the one-shot: re-composing a pose undoes sits and wings (#188 B2).
// A gesture isn't a verb (the set is closed); it rides the presence pose.
let restored = null;

/** Before any restore (a first visit) the origin: sanePose() requires a finite `p`. */
const rememberedBody = () => restored ?? { p: [0, 0, 0], yaw: 0 };

/** The remembered body, unchanged, carrying pose.anim. */
function playOnce(name) {
  if (!sendPoseExact({ ...rememberedBody(), anim: name })) {
    toast('not connected - action not sent', 'warn');
  }
}

/** The roster in chat.js's shape; `dist` is null: no world is drawn. */
function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null }];
  for (const r of participants.remotes.values()) {
    list.push({ id: r.id, me: false, declares: r.declares ?? null, dist: null });
  }
  return list;
}

/** Deliberately not shared with ui.js: past a screenful it should become a module. */
function toast(message, kind = 'info', ttl = 5000) {
  const host = document.getElementById('toasts') ?? document.body;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), ttl);
}


// a card, not a chat line: the join replay buries chat
const TAP = globalThis.matchMedia?.('(pointer: coarse)').matches ? 'Tap' : 'Click';
const BANNER_TEXT = {
  // WHY, plainly, then the one way in
  phone: `You're on a phone, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  crash: `This world didn't finish loading on this device last time, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
    'no-gpu': "This browser has no 3D support, so you're in the lite client: chat, the action bar and who's here.",
  saved: `You chose the lite client on this device: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  url: `This link opens the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
};
const NO_WAY_IN = new Set(['no-gpu']);
// capnotice.js's card markup, rebuilt here since capnotice.js pulls core.js.
// One column: top bar, the card if up, then chat (via --lite-top, read by index.html).
export function liteLayout() {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('lite-action-host');
  const card = document.getElementById('lite-banner');
  const below = card ? card.getBoundingClientRect().bottom + 8 : (bar?.getBoundingClientRect().bottom ?? 0);
  document.documentElement.style.setProperty('--lite-top', `${Math.round(below)}px`);
}

export function liteBanner(why) {
  const text = BANNER_TEXT[why];
  if (!text || document.getElementById('lite-banner')) return null;
  const card = document.createElement('div');
  card.id = 'lite-banner';
  card.className = 'panel capnotice';
  card.setAttribute('role', 'status');
  const item = document.createElement('div');
  item.className = 'cn-item';
  // the way in is the logo, which the text names
  item.innerHTML = '<b></b><p></p><div class="cn-btns"><button type="button" class="cn-ok">got it</button></div>';
  item.querySelector('b').textContent = 'Lite client';
  item.querySelector('p').textContent = text;
  let ro = null;
  item.querySelector('.cn-ok').addEventListener('click', () => { ro?.disconnect(); card.remove(); liteLayout(); });
  card.appendChild(item);
  document.body.appendChild(card);
  // follow the action row: its height depends on how many gestures wrap
  const host = document.getElementById('lite-action-host');
  const place = () => { card.style.top = `${Math.round((host?.getBoundingClientRect().bottom ?? 0) + 8)}px`; liteLayout(); };
  place();
  if (host && globalThis.ResizeObserver) (ro = new ResizeObserver(place)).observe(host);
  return card;
}

/** Renderer-free door for a 4003 refusal (net.js `bad-key`). Idempotent: a refused key refills the same door. */
function keyDoor() {
  let host = document.getElementById('lite-door');
  if (host) { host.querySelector('.lite-door-msg').textContent = 'that key was refused'; return; }

  host = document.createElement('div');
  host.id = 'lite-door';
  host.innerHTML = `
    <div class="lite-door-card">
      <div class="lite-door-title">this world needs a key</div>
      <div class="lite-door-msg">enter the door key to come in</div>
      <input class="lite-door-key" type="password" autocomplete="off" spellcheck="false"
             placeholder="door key" aria-label="door key">
      <button class="lite-door-go" type="button">enter</button>
    </div>`;
  document.body.appendChild(host);

  const input = host.querySelector('.lite-door-key');
  const msg = host.querySelector('.lite-door-msg');
  const submit = () => {
    const key = input.value.trim();
    if (!key) { msg.textContent = 'a key is needed to come in'; return; }
    setToken(key);          // CONFIG.token + the 'ew-key' the early socket reads next time
    msg.textContent = 'trying that key\u2026';
    host.remove();
    connect();
  };
  host.querySelector('.lite-door-go').addEventListener('click', submit);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  // a key box is no use to someone with an account
  const url = loginUrl?.();
  if (url) {
    const a = document.createElement('a');
    a.className = 'lite-door-login';
    a.href = url;
    a.textContent = 'or sign in';
    host.querySelector('.lite-door-card').appendChild(a);
  }
  input.focus();
}

async function main() {
  document.documentElement.classList.add('lite');
  // before connect(): the refusal arrives during it
  bus.on('bad-key', keyDoor);

  initBoot({ world: CONFIG.world, name: CONFIG.name });
  markPhase('engine', 1);
  markPhase('body', 1);

  wireNet({
    participants,
    toast,                       // net.js takes a notifier rather than importing ui.js
    // must match the early socket's join byte for byte, or the server sees arrive → leave → arrive (#188 B1)
    myAvatarPath: () => globalThis.__ewWantAvatar ?? 'claude',
    // null on purpose: sendPose() samples a live body; this client's one pose goes through sendPoseExact
    me: () => null,
    myState: null,
    onRestore: (r) => { restored = r; },   // held whole; see rememberedBody()
  });

  await initIdentity();

  // every socket consumer before connect(), no await between: connect() drains the early socket, and a missing consumer loses it for good (#188)
  initChat({
    send: (text) => say(text),
    typing: (to) => sendTyping(to),   // no local avatar to show typing on
    people,
  });
  initCauses();        // live entries -> chat lines (says, builds, grants)
  initRecentChat();    // the join snapshot's chat window (empty since speech became arrival-only)

  const actionHost = document.createElement('div');
  actionHost.id = 'lite-action-host';
  document.body.appendChild(actionHost);
  initLiteActions(actionHost, playOnce);
  // THE LOGO IS THE WAY IN to the full world (no menu here); without 3D support it is just the mark
  const mark = document.getElementById('hud');
  if (mark) {
    actionHost.prepend(mark);
    if (NO_WAY_IN.has(WHY)) { mark.disabled = true; mark.title = 'eidoverse'; }
    else { mark.title = 'load the full 3D world'; mark.setAttribute('aria-label', 'load the full 3D world'); mark.addEventListener('click', tryFullWorld); }
  }
  liteLayout();
  if (globalThis.ResizeObserver) new ResizeObserver(liteLayout).observe(actionHost);
  addEventListener('resize', liteLayout);
  globalThis.__ewTryFullWorld = tryFullWorld;   // also reachable from the console

  if (!liteBanner(WHY)) logChat('', WHY_TEXT[WHY] ?? WHY_TEXT.default, 'sys');

  // no door screen: a lite arrival steps straight in; keyDoor() answers `bad-key`
  markPhase('connect', 1);
  await connect();
  markPhase('world', 1);
  finishBoot('lite');
  bus.emit('roster');
}

main().catch((e) => {
  report?.('lite boot', e);
  toast(`lite boot failed: ${e.message}`, 'err');
});
