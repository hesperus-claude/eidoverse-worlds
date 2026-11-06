// lite.js — the entry point for a device that cannot hold the world.
//
// Why a separate entry point and not a flag: main.js statically imports
// { THREE, scene, camera, renderer }, and index.html modulepreloads
// three.webgpu and three-vrm besides. Static imports and preloads are fetched and
// parsed before any of our code gets a say, so a runtime `if (lite)` would render
// nothing and still pay the whole ~2.1MB on a phone. The choice is made in the HTML,
// ahead of the module graph; see the decision script there.
//
// What this is: chat, the action row, and who's here. No scene, no camera, no renderer,
// no bodies. You can talk to people in the eidoverse from a phone that cannot draw it.
//
// What it is NOT: a viewer. There is deliberately no canvas.
//
// It runs the REAL net.js. The wire protocol is not forked — net.js takes its
// participant registry, asset ledger and snapshot renderer by injection now, so this
// file supplies renderer-free ones and the protocol has exactly one implementation.
import { say } from './lib/net.js';
import { chooseClient } from './lib/litechoice.js';
import { CONFIG, bus, report, setToken } from './lib/base.js';
// NOT ui.js: that module is the DESKTOP shell and reaches the engine (core.js, mybody.js, colliders.js) through
// videopanel.js and profile.js. Lite builds its surface from the primitives that are actually renderer-free.
import { makeFrame } from './lib/windows.js';
import { initChat, logChat } from './lib/chat.js';
import {
  net, connect, initIdentity, wireNet, sendTyping, sendPoseExact,
  loginUrl,
} from './lib/net.js';
import { initBoot, markPhase, finishBoot } from './lib/boot.js';
import * as participants from './lib/participants_lite.js';
import { initLiteActions } from './lib/actionbar_lite.js';
// Turns live world entries into chat lines — including your own 'say' coming back from the server, which a lite
// client would otherwise never see. The same narrator the full client uses (it also reports builds and grants).
import { initCauses } from './lib/realize/livechat.js';
import { initRecentChat } from './lib/realize/recentchat.js';

// The boot watchdog in index.html fails the splash after 20s unless __ewEngineUp is
// set, and core.js only sets it after renderer.init(). There is no renderer here and
// never will be, so we claim the flag ourselves. What the watchdog actually guards
// against still works: if this module never runs, nothing sets it.
globalThis.__ewEngineUp = true;

// Why this session is lite, decided in index.html. 'crash' is the one that has to SAY
// so: being silently demoted after your browser died, with no explanation and no way
// back, is worse than the crash was.
const WHY = globalThis.__ewLiteWhy ?? 'url';
const WHY_TEXT = {
  // the card (liteBanner) says why for every reason now; this line is only for a reason with no card
  default: 'lite client \u2014 chat, the action bar, and who\u2019s here',
};

/** The way into the 3D world: the person's choice, saved, the address left clean (litechoice.js says why). */
export function tryFullWorld() { chooseClient(false); }

// A lite client still ARRIVES: the server announces it and everyone else builds a body for it, so it appears as
// the resident the world remembers.
//
// THE RESTORE IS HELD VERBATIM AND SENT BACK VERBATIM: it is the server's own settled pose for this body (position,
// facing, clip, pitch, wings, held bones, pins, and anything added later) — the resident's WHOLE public body, not a
// delta, so re-composing one from what this client knows would drop parts of it. We add the one-shot anim and
// change nothing else. A gesture is not a verb (the verb set is closed); it rides the presence pose.
let restored = null;

/** The body the world remembers. Before any restore lands - a first-ever visit - the
 *  origin is all we can honestly claim, and sanePose() requires a finite `p`. */
const rememberedBody = () => restored ?? { p: [0, 0, 0], yaw: 0 };

/** One anim, played once: the remembered body, unchanged, carrying pose.anim. */
function playOnce(name) {
  if (!sendPoseExact({ ...rememberedBody(), anim: name })) {
    toast('not connected - action not sent', 'warn');
  }
}

/** The roster in the shape chat.js wants for @-completion and its people pane.
 *  `dist` is always null: distance is a property of a world we are not drawing. */
function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null }];
  for (const r of participants.remotes.values()) {
    list.push({ id: r.id, me: false, declares: r.declares ?? null, dist: null });
  }
  return list;
}

/** The few lines of ui.js that lite actually needed. Deliberately not a shared module:
 *  if this grows past a screenful it wants to BE one, and the growth is the signal. */
function toast(message, kind = 'info', ttl = 5000) {
  const host = document.getElementById('toasts') ?? document.body;
  const t = document.createElement('div');
  t.className = `toast ${kind}`;
  t.textContent = message;
  host.appendChild(t);
  setTimeout(() => t.remove(), ttl);
}


// A DEMOTION says so where it can't scroll away: a chat line is logged before the join snapshot replays the room's
// history, so on a busy world it is gone before anyone reads it. Shown for every reason, including a link or a saved
// choice: a choice outlives the memory of making it.
// a phone taps, a mouse clicks
const TAP = globalThis.matchMedia?.('(pointer: coarse)').matches ? 'Tap' : 'Click';
const BANNER_TEXT = {
  // WHY, plainly, then the one way in.
  phone: `You're on a phone, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  crash: `This world didn't finish loading on this device last time, so you're in the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
    'no-gpu': "This browser has no 3D support, so you're in the lite client: chat, the action bar and who's here.",
  saved: `You chose the lite client on this device: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
  url: `This link opens the lite client: chat, the action bar and who's here. ${TAP} the \u2203 Eidoverse logo (top left) to load the full 3D world.`,
};
const NO_WAY_IN = new Set(['no-gpu']);
// The same card as the full client's capability notice (capnotice.js: .panel.capnotice >
// .cn-item > b, p, .cn-btns) so the two reduced paths read as one family. Built here, not
// imported: capnotice.js pulls core.js, and core.js is the engine lite exists to avoid.
// THE PHONE LAYOUT, one column: the top bar
// (gestures, scrolling sideways, and the way into the 3D world at its end), then the card if it's up, then the
// chat filling everything below it. The chat frame keeps its own machinery (tabs, people, compose); only its
// box is set here, through --lite-top, which index.html's html.lite rules read.
export function liteLayout() {
  if (typeof document === 'undefined') return;
  const bar = document.getElementById('lite-action-host');
  const card = document.getElementById('lite-banner');
  // flush under the bar; a breath under the card while it's up
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
  // one button: dismiss, and the chat takes the room. The way in is the logo, which the text names.
  item.innerHTML = '<b></b><p></p><div class="cn-btns"><button type="button" class="cn-ok">got it</button></div>';
  item.querySelector('b').textContent = 'Lite client';
  item.querySelector('p').textContent = text;
  let ro = null;
  item.querySelector('.cn-ok').addEventListener('click', () => { ro?.disconnect(); card.remove(); liteLayout(); });
  card.appendChild(item);
  document.body.appendChild(card);
  // Under the action row, never over it: that row is fixed to the top and its height
  // depends on how many gestures wrap, so follow it instead of guessing a number.
  const host = document.getElementById('lite-action-host');
  const place = () => { card.style.top = `${Math.round((host?.getBoundingClientRect().bottom ?? 0) + 8)}px`; liteLayout(); };
  place();
  if (host && globalThis.ResizeObserver) (ro = new ResizeObserver(place)).observe(host);
  return card;
}

/** The key door, renderer-free.
 *
 *  A key-gated world refuses an unknown visitor with close code 4003, and net.js turns
 *  that into `bad-key`. The full client answers it by reopening openDoor - which lives in
 *  ui.js, needs a roster of avatars to show, and arrives with the engine attached. None
 *  of that is available here, and "try the full world" is not a door for someone whose
 *  phone the full world kills. So: an input, on the page that is already up.
 *
 *  Idempotent - a refused key re-emits `bad-key`, and that should refill the same door
 *  rather than stack another. */
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

  // A deployment that wants a login rather than a key already redirects through authcfg;
  // where one is offered, show it too, because a key box is no use to someone who has an
  // account instead.
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
  // The splash is static markup that only boot.js takes down, so lite runs boot too; the engine and body phases are
  // marked done because in this client there is none to wait on.
  // Wired before connect(), because the refusal it answers arrives during connect().
  bus.on('bad-key', keyDoor);

  initBoot({ world: CONFIG.world, name: CONFIG.name });
  markPhase('engine', 1);
  markPhase('body', 1);

  // The renderer-free half of the client, handed to the real protocol.
  wireNet({
    participants,
    toast,                       // net.js takes a notifier rather than importing ui.js
    // The SAME avatar the inline early socket joined with, published by index.html before any of its guards: net.js
    // adopts that socket only when the join it would send matches byte for byte, else it opens a second one (arrive
    // -> leave -> arrive) and traffic delivered to the first can be lost. Everyone else draws our body; it should be
    // the right one.
    myAvatarPath: () => globalThis.__ewWantAvatar ?? 'claude',
    // null, both of them, and deliberately: sendPose() SAMPLES a live body and returns
    // immediately without these. There is no body here to sample. The one pose this
    // client ever emits goes through sendPoseExact, which re-asserts what the server
    // already remembers instead of composing something new.
    me: () => null,
    myState: null,
    onRestore: (r) => { restored = r; },   // held whole; see rememberedBody()
  });

  await initIdentity();

  // EVERY CONSUMER OF SOCKET TRAFFIC IS BUILT BEFORE connect(). The early socket is adopted inside connect(), which
  // then drains what raced ahead (the join snapshot, the first live entries); a consumer that doesn't exist yet loses
  // them for good. Anything that can receive buffered arrival traffic is installed here, with no await between.
  initChat({
    send: (text) => say(text),
    typing: (to) => sendTyping(to),   // no local avatar to show typing on
    people,
  });
  initCauses();        // live entries -> chat lines (says, builds, grants)
  initRecentChat();    // the join snapshot's chat window (empty since speech became arrival-only)

  // Chrome. None of it consumes socket traffic, but it costs nothing to have it
  // standing before the first message lands either.
  const actionHost = document.createElement('div');
  actionHost.id = 'lite-action-host';
  document.body.appendChild(actionHost);
  initLiteActions(actionHost, playOnce);
  // THE LOGO IS THE WAY IN: the ∃ leads the top bar and loads the full 3D world. In the full
  // client it opens the menu; lite has no menu, so here it does the one thing lite can't. Not where the
  // browser has no 3D at all: there it is just the mark.
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

  // the card says why now, for every reason; the chat line only where there is no card (it repeated it)
  if (!liteBanner(WHY)) logChat('', WHY_TEXT[WHY] ?? WHY_TEXT.default, 'sys');

  // No door screen: openDoor lives in ui.js, and the door's job (pick a body, see who is
  // here before you commit) is mostly about a world this client does not render, so a
  // lite arrival steps straight in. A world that wants a KEY is handled - keyDoor() above
  // answers `bad-key` - and a deployment that wants a login redirects through authcfg.
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
