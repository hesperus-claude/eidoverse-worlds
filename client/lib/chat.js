// chat — the room's conversation, which in this world is also its history; mentions, highlights and unread for people.
// The mention rule is simpler than the agent's (mcpl/mention.ts: qualified names, hyphens), so a highlight and a ping can differ.

import { CONFIG, bus, colorFor, assignColors } from './base.js';
// never import xrpanels.js (it reaches the engine; chat.js serves a sceneless client too): main.js registers the spec
import { lastWhy } from './debuglog.js';
import { initAttention, mountAttentionControls } from './attention.js';
import { makeFrame } from './windows.js';
import { fsvg } from './icons.js';
import { requestHistory } from './net.js';
// ONLY the registry, never handlers.js, or the cycle chat→handlers→net→chat closes (§14.2)
import { COMMANDS, resolveCommand } from './commands/registry.js';
import { register as registerAction } from './actions.js';
import { escapeHtml as esc } from './markup.js';

const MAX_LINES = 400;
const HISTORY = 'ew-chat-history';

let frame = null;
let logEl = null;
let jumpEl = null;   // the unread pill (paintUnread)
let inputEl = null;
let onSend = null;
const recent = [];   // the log's tail, for the VR quad
export const recentChat = () => recent.slice();
let onTyping = () => {};
let getPeople = () => [];
// people.js's menu and badges, injected by main.js: a static import would close the chat → people → net → chat cycle
let personUi = null;

// 'all' | 'mentions' | 'system': every tab views the one public room; world chat has no private channel
let filter = 'all';
let unread = 0, unreadMentions = 0;
let lastAuthor = null, lastAt = 0, lastLineEl = null;
const sentHistory = [];             // up-arrow recall
let historyIdx = -1;

// ---------------------------------------------------------------- mentions

/** @name, or the bare name as a whole word. */
export function mentionRx(name) {
  const safe = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(@${safe}\\b|\\b${safe}\\b)`, 'i');
}
export function mentionsMe(text) {
  return mentionRx(CONFIG.name).test(String(text ?? ''));
}

// inline markdown only (**bold**, *italic* / _italic_, `code`), as text nodes: no HTML is ever parsed from a message
const MD_RX = /(\*\*([^*\n]+)\*\*)|(`([^`\n]+)`)|((?<![\w*])\*([^*\n]+)\*(?![\w*]))|((?<!\w)_([^_\n]+)_(?!\w))/g;
function inline(run) {
  if (!chatMd) return document.createTextNode(run);
  const frag = document.createDocumentFragment();
  let i = 0;
  for (const m of run.matchAll(MD_RX)) {
    if (m.index > i) frag.append(document.createTextNode(run.slice(i, m.index)));
    const el = document.createElement(m[1] ? 'b' : m[3] ? 'code' : 'i');
    el.textContent = m[2] ?? m[4] ?? m[6] ?? m[8];
    frag.append(el);
    i = m.index + m[0].length;
  }
  if (i < run.length) frag.append(document.createTextNode(run.slice(i)));
  return frag;
}
/** Never puts untrusted text through innerHTML. */
function renderBody(text, names) {
  const frag = document.createDocumentFragment();
  const pattern = new RegExp(
    `(https?://[^\\s]+)|(@?\\b(?:${names.map(escapeRx).join('|') || '\\u0000'})\\b)`,
    'gi',
  );
  let i = 0;
  for (const m of String(text).matchAll(pattern)) {
    if (m.index > i) frag.append(inline(text.slice(i, m.index)));
    if (m[1]) {
      // trailing punctuation is prose, not address: "(…?world=garden)" must not link to "garden)"
      let url = m[1];
      const trail = /[)\]}>.,;:!?'"»]+$/.exec(url)?.[0] ?? '';
      if (trail) url = url.slice(0, -trail.length);
      const a = document.createElement('a');
      a.href = url; a.target = '_blank'; a.rel = 'noopener noreferrer';
      a.textContent = url;
      a.className = 'lnk';
      frag.append(a);
      if (trail) frag.append(document.createTextNode(trail));
    } else {
      const s = document.createElement('span');
      const bare = m[2].replace(/^@/, '');
      const isMe = bare.toLowerCase() === CONFIG.name.toLowerCase();
      s.className = isMe ? 'mention me' : 'mention';
      // a mention wears the named person's colour; mentions of YOU keep the ping styling (addressed outranks named)
      if (!isMe) s.style.color = colorFor(bare);
      s.textContent = m[2];
      frag.append(s);
    }
    i = m.index + m[0].length;
  }
  if (i < String(text).length) frag.append(inline(String(text).slice(i)));
  return frag;
}
const escapeRx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------------------------------------------------------- scrollback
// a join carries recent chat, not the archive; reaching the top pages in the rest

// the arrival window has gaps (shared/chatwindow.js trimRecentChat), so the cursor comes only from what paging walked
let pageCursor = null;              // next page is everything below this seq; null = from now
let loadingOlder = false;
let noMoreHistory = false;
let endMarker = null;               // the "beginning of this world" row, while the walk is finished
let trimmedThrough = -1;            // highest seq the MAX_LINES trim has removed
// pages of 40, for a scroll past shown lines and for a re-join's catch-up
const MAX_SKIP_PAGES = 25;

/** From no lower than `cursor` (null: the present): restarts only move it up; starting higher costs requests, not lines. */
function restartWalk(cursor) {
  if (pageCursor !== null && (cursor === null || cursor > pageCursor)) pageCursor = cursor;
  noMoreHistory = false;
  endMarker?.remove();
  endMarker = null;
}

/** A trimmed row leaves renderedSeqs so paging brings it back; if the walk had passed it, the walk restarts. */
function trimLog() {
  while (logEl.children.length > MAX_LINES) {
    const row = logEl.firstElementChild;
    if (row === endMarker) restartWalk(pageCursor);
    for (const seq of seqsOf(row)) {
      renderedSeqs.delete(seq);
      if (seq > trimmedThrough) trimmedThrough = seq;
      const passed = pageCursor === null ? noMoreHistory : seq >= pageCursor;
      if (passed) restartWalk(null);
    }
    row.remove();
  }
}

/** Several when logChat merged the rest of a spoken utterance into the row. */
function seqsOf(row) {
  if (row.dataset.seqs) return row.dataset.seqs.split(',').map(Number);
  return row.dataset.seq !== undefined ? [+row.dataset.seq] : [];
}

/** After the last older row, NOT before the first newer one: spoken rows move earlier (t0). */
function insertHistorical(who, text, ts, seq) {
  renderedSeqs.add(seq);
  const line = buildLine(who, text, { ts, historical: true });
  line.dataset.seq = String(seq);
  line.dataset.author = who;
  line.dataset.tsn = String(ts ?? 0);
  let prev = null;
  for (const c of logEl.children) {
    if (c.dataset.seq !== undefined && +c.dataset.seq < seq) prev = c;
  }
  if (prev) prev.after(line); else logEl.prepend(line);
  // a grouped row now under a different speaker reprints its name (sys rows pass through a group)
  let below = line.nextElementSibling;
  while (below && below.dataset.kind === 'system') below = below.nextElementSibling;
  if (below && below.dataset.author !== who) below.classList.remove('cont');
}

/** Pin the first visible row in screen coordinates (offsetTop is relative to .chat-main); returns the restore step. */
function pinView() {
  const top = logEl.getBoundingClientRect().top;
  let anchor = null;
  for (const c of logEl.children) {
    const r = c.getBoundingClientRect();
    if (r.height && r.bottom > top) { anchor = c; break; }
  }
  if (!anchor) return () => {};
  const was = anchor.getBoundingClientRect().top;
  return () => {
    if (anchor.isConnected) logEl.scrollTop += anchor.getBoundingClientRect().top - was;
  };
}

/** Slot one page of history into the log; returns how many rows were new. */
function insertPage(entries) {
  const fresh = (entries ?? []).filter((e) => typeof e.seq === 'number' && !renderedSeqs.has(e.seq));
  if (!fresh.length) return 0;
  // a reader following the end must still be, though a re-join's fill can land below the pinned row
  const following = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  const restore = pinView();
  for (const e of fresh) insertHistorical(e.actor, e.args?.text ?? '', e.ts, e.seq);
  restore();
  if (following) logEl.scrollTop = logEl.scrollHeight;
  return fresh.length;
}

/** On a re-join, what was said after the old socket's last seq, newest first; stopping short restarts the walk there. */
export async function resyncChatAfter(seq) {
  if (!logEl || !renderedSeqs.size || typeof seq !== 'number' || seq < 0) return;
  let before = null;
  for (let page = 0; page < MAX_SKIP_PAGES; page++) {
    let r;
    try {
      r = await requestHistory({
        after: seq, ...(before !== null ? { before } : {}), limit: 40, verbs: ['say'],
      });
    } catch {
      restartWalk(before);           // this page and below are still to fetch
      return;
    }
    if (!r.entries?.length) return;
    insertPage(r.entries);
    if (r.entries.length < 40) return;
    before = typeof r.oldestSeq === 'number' ? r.oldestSeq : r.entries[0].seq;
  }
  restartWalk(before);               // the cap with a full last page: older lines may be left
}

/** Tell an arrival this is a window, not the room's whole memory, and roughly how small. */
export function noteHistoryContext({ total = null, shown = 0, spanMs = null } = {}) {
  if (!logEl) return;
  // one note, ever: every rejoin would prepend another
  logEl.querySelectorAll('.hist-note').forEach((n) => n.remove());
  // `total` is unknown for old folded worlds: never "showing 40 of 0"; "there is more" is true either way
  const known = typeof total === 'number' && total > 0;
  if (known && total <= shown) return;
  const line = document.createElement('div');
  line.className = 'line sys hist-note';
  const span = spanMs != null && spanMs < 120000 && shown > 1
    ? ` — the last ${Math.max(1, Math.round(spanMs / 1000))}s of talking`
    : '';
  line.textContent = known
    ? `showing ${shown} of ${total.toLocaleString()} messages${span}. Scroll up for earlier.`
    : 'scroll up for earlier messages';
  logEl.prepend(line);
}

async function loadOlder() {
  if (loadingOlder || noMoreHistory || !logEl) return;
  loadingOlder = true;
  const marker = document.createElement('div');
  marker.className = 'line sys';
  marker.textContent = '… loading earlier messages';
  logEl.prepend(marker);
  try {
    let added = 0;
    for (let page = 0; !added && !noMoreHistory && page < MAX_SKIP_PAGES; page++) {
      const from = pageCursor;
      const r = await requestHistory({
        ...(from !== null ? { before: from } : {}),
        limit: 40, verbs: ['say'],
      });
      const entries = r.entries ?? [];
      // a restart mid-flight owns the cursor and the end flag; this page's lines still slot in
      if (pageCursor === from) {
        if (entries.length) pageCursor = typeof r.oldestSeq === 'number' ? r.oldestSeq : entries[0].seq;
        if (!entries.length || !r.hasMore) noMoreHistory = true;
      }
      marker.remove();               // before pinView measures, or it could be the anchor
      added = insertPage(entries);
      if (!added && !noMoreHistory) logEl.prepend(marker);
    }
    marker.remove();
    if (noMoreHistory) {
      endMarker = document.createElement('div');
      endMarker.className = 'line sys';
      endMarker.textContent = '— the beginning of this world —';
      logEl.prepend(endMarker);
    }
  } catch {
    // a failed page leaves the cursor as it stands: the next scroll-up asks again from there
    marker.remove();
  } finally { loadingOlder = false; }
}

// ---------------------------------------------------------------- lines

const pad2 = (n) => String(n).padStart(2, '0');

// a reconnect re-renders the same arrival window; synthetic lines carry no seq
const renderedSeqs = new Set();

export function logChat(who, text, kind = '', meta = {}) {
  if (typeof meta.seq === 'number' && meta.seq >= 0) {
    // ...or trimmed: appending a replayed one would put it under hours of newer talk; paging slots it back
    if (renderedSeqs.has(meta.seq) || meta.seq <= trimmedThrough) return;
    renderedSeqs.add(meta.seq);
  }
  // the VR quad's tail: every line, merged continuations included
  recent.push({ who, text: String(text).slice(0, 140), kind });
  if (recent.length > 12) recent.shift();
  bus.emit('xr:repaint');
  // merge ONLY one spoken utterance's continuation (same author + utt, PR#7): an interrupted voice may finish later
  if (meta.spoken && meta.utt != null && lastLineEl?.isConnected &&
      lastLineEl.dataset.author === who && lastLineEl.dataset.utt === String(meta.utt)) {
    const body = lastLineEl.querySelector('.body');
    if (body) {
      // a trim must release this seq with the row's, or paging treats it as still on screen
      if (typeof meta.seq === 'number' && meta.seq >= 0) {
        lastLineEl.dataset.seqs = [...seqsOf(lastLineEl), meta.seq].join(',');
      }
      const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
      body.append(' ', renderBody(text, namesForHighlight()));
      lastAt = Date.now();
      const newlyPinged =
        lastLineEl.dataset.kind !== 'mention' && mentionsMe(text);
      if (newlyPinged) { lastLineEl.classList.add('ping'); lastLineEl.dataset.kind = 'mention'; }
      account(lastLineEl, { who, text, merged: true, newlyPinged, wasAtBottom });
      return;
    }
  }
  const line = buildLine(who, text, { kind, ...meta });
  // where paged-in history slots in around this line
  if (typeof meta.seq === 'number' && meta.seq >= 0) line.dataset.seq = String(meta.seq);
  line.dataset.author = who;
  line.dataset.tsn = String(meta.ts ?? Date.now());
  if (meta.spoken && meta.utt != null) line.dataset.utt = String(meta.utt);
  lastLineEl = line;

  const wasAtBottom = logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48;
  // a spoken say slots before lines that arrived after its speech began (t0); display only, and bounded: a server may not clamp t0 (PR#7)
  const ts = meta.ts ?? Date.now();
  const t0ok = meta.spoken && Number.isFinite(meta.t0) &&
    meta.t0 <= ts && meta.t0 >= ts - 300_000;
  let anchor = null;
  if (t0ok) {
    let c = logEl.lastElementChild;
    while (c && +(c.dataset.tsn ?? 0) > meta.t0) { anchor = c; c = c.previousElementSibling; }
  }
  if (anchor) {
    logEl.insertBefore(line, anchor);
    // a different speaker now between them: the anchor reprints its name
    if (anchor.dataset.author !== who) anchor.classList.remove('cont');
    // ...and regroup from its visual predecessor, or it renders under another speaker's nameplate
    let prev = line.previousElementSibling;
    while (prev && prev.dataset.kind === 'system') prev = prev.previousElementSibling;
    const near = !!prev && prev.dataset.author === who &&
      +(line.dataset.tsn ?? 0) - +(prev.dataset.tsn ?? 0) < 90_000;
    line.classList.toggle('cont', near);
  } else logEl.appendChild(line);
  trimLog();

  account(line, { who, text, merged: false,
    newlyPinged: line.dataset.kind === 'mention', wasAtBottom });
}

// ONE place counts new and merged rows, so nothing counts twice
function account(line, { who, text, merged, newlyPinged, wasAtBottom }) {
  const seen = frame.visible && wasAtBottom;
  if (seen) scrollToEnd();
  else {
    if (!merged && line.dataset.kind !== 'system') unread++;
    if (newlyPinged) unreadMentions++;
    paintUnread();
  }
  if (newlyPinged) bus.emit('pinged', { who, text });
}

function buildLine(who, text, { kind = '', ts = Date.now(), historical = false } = {}) {
  const sys = who === '*';
  const mine = who === CONFIG.name;
  const pinged = !sys && !mine && mentionsMe(text);

  // the word declared at the door (PROTOCOL §6a), shown as said
  const declared = sys || mine ? null : (getPeople().find((p) => p.id === who)?.declares ?? null);

  const line = document.createElement('div');
  line.className = `line ${sys ? 'sys' : ''} ${mine ? 'me' : ''} ${declared ? 'declared' : ''} ${pinged ? 'ping' : ''}`;
  line.dataset.kind = sys ? 'system' : pinged ? 'mention' : 'chat';

  const now = ts;
  // consecutive lines from one author drop the repeated name; historical ones arrive out of order, so never group
  const grouped = !historical && !sys && who === lastAuthor && now - lastAt < 90_000;
  // sys lines pass THROUGH a group; only a change of speaker or the time window ends one.
  if (!historical && !sys) { lastAuthor = who; lastAt = now; }
  if (grouped) line.classList.add('cont');
  if (historical) line.classList.add('old');

  const d = new Date(now);
  const t = document.createElement('span');
  t.className = 't';
  t.textContent = `${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
  t.title = d.toLocaleString();

  const w = document.createElement('span');
  w.className = 'who';
  w.textContent = who;
  if (typeof declared === 'string' && declared) w.dataset.declares = declared;   // drawn after the name (index.html)
  // INCLUDING you: a name looks the same to every reader
  if (!sys) w.style.color = colorFor(who);
  if (!sys && !mine) {
    w.onclick = () => { open(); insertAtCursor(`@${who} `); };
    w.style.cursor = 'pointer';
  }

  const b = document.createElement('span');
  b.className = 'body';
  b.append(renderBody(text, namesForHighlight()));

  line.append(t, w, b);
  applyFilter(line);
  return line;
}

// a join or leave re-negotiates colours; without the repaint a shifted name reads as two people up the log
bus.on('roster', () => {
  const names = getPeople().map((p) => p.id);
  names.push(CONFIG.name);
  assignColors(names);
  repaintNames();
});

function repaintNames() {
  if (!logEl) return;
  for (const w of logEl.querySelectorAll('.line .who')) {
    const line = w.closest('.line');
    if (line.classList.contains('sys')) continue;
    w.style.color = colorFor(w.textContent);
  }
  for (const m of logEl.querySelectorAll('.body .mention:not(.me)')) {
    m.style.color = colorFor(m.textContent.replace(/^@/, ''));
  }
}

function namesForHighlight() {
  const names = new Set([CONFIG.name]);
  for (const p of getPeople()) if (p.id) names.add(p.id);
  return [...names];
}

function applyFilter(line) {
  const k = line.dataset.kind;
  const show = filter === 'all' ? true
    : filter === 'mentions' ? k === 'mention'
      : k === 'system';
  line.classList.toggle('filtered', !show);
}
function repaintFilter() {
  for (const l of logEl.children) applyFilter(l);
  scrollToEnd();
}

function scrollToEnd() {
  logEl.scrollTop = logEl.scrollHeight;
  unread = 0; unreadMentions = 0;
  paintUnread();
}

function paintUnread() {
  const jump = jumpEl;   // initChat's own node: a mod's earlier #chat-jump would win a document lookup
  if (jump) {
    jump.style.display = unread > 0 ? 'block' : 'none';
    jump.textContent = `${unread} new ${unreadMentions ? `· ${unreadMentions} ✱` : ''}↓`;
    jump.classList.toggle('ping', unreadMentions > 0);
  }
  frame?.badge(unread ? `<b class="${unreadMentions ? 'ping' : ''}">${unread}</b>` : '');
}

// ---------------------------------------------------------------- composer

function insertAtCursor(str) {
  const s = inputEl.selectionStart ?? inputEl.value.length;
  setInput(inputEl.value.slice(0, s) + str + inputEl.value.slice(inputEl.selectionEnd ?? s));
  const p = s + str.length;
  inputEl.setSelectionRange(p, p);
  inputEl.focus();
}

// ---- autocomplete -----------------------------------------------------------

let acBox = null, acItems = [], acIndex = 0, acStart = -1, acKind = null;

// the table that autocompletes IS the one handlers registered against

function closeAC() {
  acBox.style.display = 'none';
  acItems = []; acStart = -1; acKind = null;
}

function updateAC() {
  const v = inputEl.value;
  const caret = inputEl.selectionStart ?? v.length;
  const upto = v.slice(0, caret);

  // only at the very start of the line
  const cmd = /^\/(\w*)$/.exec(upto);
  if (cmd) {
    const q = cmd[1].toLowerCase();
    const hits = COMMANDS.filter(({ name, listed }) => listed !== false && name.startsWith(q));
    return showAC(hits.map(({ name, help }) => ({ value: `/${name}`, label: `/${name}`, hint: help })), 0, 'cmd');
  }

  // @mention
  const at = /(?:^|\s)@([\w-]*)$/.exec(upto);
  if (at) {
    const q = at[1].toLowerCase();
    const hits = getPeople()
      .filter((p) => p.id.toLowerCase().includes(q) && p.id !== CONFIG.name)
      .slice(0, 8);
    return showAC(
      hits.map((p) => ({ value: `@${p.id}`, label: p.id, hint: p.declares || 'here' })),
      caret - at[1].length - 1, 'at',
    );
  }
  closeAC();
}

function showAC(items, start, kind) {
  if (!items.length) return closeAC();
  acItems = items; acIndex = 0; acStart = start; acKind = kind;
  acBox.innerHTML = '';
  items.forEach((it, i) => {
    const row = document.createElement('div');
    row.className = `ac-row ${i === 0 ? 'on' : ''}`;
    row.innerHTML = `<span class="ac-l"></span><span class="ac-h"></span>`;
    row.querySelector('.ac-l').textContent = it.label;
    row.querySelector('.ac-h').textContent = it.hint ?? '';
    row.onmousedown = (e) => { e.preventDefault(); acIndex = i; acceptAC(); };
    acBox.appendChild(row);
  });
  acBox.style.display = 'block';
}

function moveAC(d) {
  if (!acItems.length) return;
  acIndex = (acIndex + d + acItems.length) % acItems.length;
  [...acBox.children].forEach((c, i) => c.classList.toggle('on', i === acIndex));
  acBox.children[acIndex]?.scrollIntoView({ block: 'nearest' });
}

function acceptAC() {
  const it = acItems[acIndex];
  if (!it) return;
  const v = inputEl.value;
  const caret = inputEl.selectionStart ?? v.length;
  setInput(v.slice(0, acStart) + it.value + ' ' + v.slice(caret));
  const p = acStart + it.value.length + 1;
  inputEl.setSelectionRange(p, p);
  closeAC();
}

// ---- commands ---------------------------------------------------------------

// the build served, so a stale page is distinguishable from a broken probe
let _build = 'unknown';
fetch('/version').then((r) => r.json())
  .then((v) => { _build = `${String(v.sha ?? '').slice(0, 7) || 'unknown'}${v.dirty === true ? '+dirty' : ''}`; })
  .catch(() => { /* 'unknown' is itself a diagnostic */ });

/** For a person with no console; each probe is guarded, so a missing subsystem can't take the report down. */
function audioReport() {
  const L = [];
  const probe = (label, fn) => {
    try { L.push(`${label}: ${fn()}`); }
    catch (e) { L.push(`${label}: unreadable (${(e?.message ?? e)})`); }
  };

  probe('transport', () => window.__voiceTransport ?? '(none — voice never initialised)');
  probe('mic', () => {
    const on = typeof window.__sfuMicOn === 'function' ? window.__sfuMicOn() : null;
    return on === null ? 'unknown (no sfu bridge)' : (on ? 'ON' : 'off');
  });
  // the peer connection's own view: the only honest answer to "is there a media path"
  probe('ice', () => {
    const d = typeof window.relayDiag === 'function' ? window.relayDiag() : null;
    if (!d) return 'unknown (no diag)';
    return `${d.iceConnectionState ?? '?'} / conn=${d.connectionState ?? '?'}`;
  });
  probe('speakers', () => {
    const d = typeof window.relayDiag === 'function' ? window.relayDiag() : null;
    const s = d?.speakers ?? d?.peers;
    if (!s) return 'unknown';
    // "attached but no stream" is its own bug, so say whether a track landed
    const list = (Array.isArray(s) ? s : Object.entries(s).map(([id, v]) => ({ id, ...v })))
      .map((x) => (typeof x === 'string' ? x : `${x.id}${x.hasStream === false ? '(no stream)' : ''}`));
    return list.length ? `${list.length} — ${list.join(', ')}` : 'none attached';
  });
  // playback can fail silently (Android): packets arrive, <audio> refuses to start
  probe('playback', () => {
    // not querySelectorAll('audio'): voicesfu's Audio elements are never in the DOM
    const entries = typeof window.__voiceSpeakerEls === 'function' ? window.__voiceSpeakerEls() : null;
    if (!entries) return 'unknown (transport exposes no elements)';
    if (!entries.length) return 'no speaker elements yet';
    let playing = 0, paused = 0;
    const stuck = [];
    for (const { id, audio } of entries) {
      if (audio?.paused) { paused++; stuck.push(id); } else playing++;
    }
    return `${entries.length} — ${playing} playing, ${paused} paused`
      + (paused ? `  ← ${stuck.join(', ')} held; tap the page to unlock` : '');
  });
  probe('captions', () => {
    const has = !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);
    if (!has) return 'no SpeechRecognition in this browser';
    // the TALLY is load-bearing: a last-event slot cannot prove something never happened
    return `${window.__sttOn?.() ? 'ON' : 'off'}`
      + (window.__sttTally ? ` [${window.__sttTally()}]` : '')
      + (window.__sttLast ? ` — last: ${window.__sttLast}` : ' — no events yet');
  });
  // each subsystem's last narrated decision (debuglog.js; __why('<topic>') in the console for history)
  probe('panel', () => `${lastWhy('tts-section')} | ${lastWhy('tts-list')}`);
  probe('source', () => lastWhy('publish'));
  probe('secure', () => `${window.isSecureContext} · isolated=${window.crossOriginIsolated}`);

  L.push(`build: ${_build}`);
  return 'audio ▸ ' + L.join('  ·  ');
}

/** Just the captions answer, short enough to copy on a phone. */
function sttReport() {
  const parts = [`build ${_build}`];
  // a wrong recognizer language returns confident nothing (nomatch), not an error
  try { if (window.__sttLang) parts.push(`lang ${window.__sttLang}`); } catch { /* ignore */ }
  try { parts.push(window.__sttOn?.() ? 'stt ON' : 'stt off'); } catch { parts.push('stt ?'); }
  try { parts.push(window.__sttTally ? window.__sttTally() : 'NO TALLY (stale page)'); }
  catch (e) { parts.push(`tally unreadable: ${e?.message ?? e}`); }
  try { if (window.__sttLast) parts.push(`last: ${window.__sttLast}`); } catch { /* ignore */ }
  return 'stt ▸ ' + parts.join(' · ');
}

// commands chat OWNS (they need its state); the rest resolve through the registry and ride the bus (§24l R1)
const CHAT_LOCAL = {
  // speech in a world is public and arrival-only
  w() { logChat('*', 'whisper was removed: everything said in a world is public (everyone here hears it). To address someone, @mention them.'); },
  // nobody is hidden in a world; moderation quiets or removes
  ghost() { logChat('*', 'ghost was removed: nobody in a world is hidden from it. To quiet someone, /mute them; to remove them, /kick or /ban.'); },
  name(rest, arg) {
    if (!arg) { logChat('*', `you are ${CONFIG.name} — /name <new name> to change it`); return; }
    bus.emit('command', { cmd: 'rename', arg });   // the handler owns the (un)support answer
  },
  me(rest, arg) { if (arg) onSend(`* ${CONFIG.name} ${arg}`); },
  who() {
    const list = getPeople().map((p) => p.id).join(', ');
    logChat('*', `here now: ${list || 'just you'}`);
  },
  clear() {
    logEl.innerHTML = '';
    lastAuthor = null;
  },
  audio(rest, arg) {
    // local by default; `say` posts the short form to the room
    const mode = (arg || '').trim().toLowerCase();
    if (mode === 'say') { onSend(sttReport()); return; }
    logChat('*', mode === 'stt' ? sttReport() : audioReport());
  },
};

/** As if typed and Entered; the lantern prompt sends through here too, so there is ONE send path. */
function submitLine(v) {
  sentHistory.push(v);
  while (sentHistory.length > 50) sentHistory.shift();
  try { localStorage.setItem(HISTORY, JSON.stringify(sentHistory.slice(-20))); } catch { /* full */ }
  if (v.startsWith('/')) { runCommand(v); return; }
  onSend(v.slice(0, 4000));
}

function runCommand(raw) {
  const [cmd, ...rest] = raw.slice(1).split(/\s+/);
  const arg = rest.join(' ');
  const typed = cmd.toLowerCase();
  const row = resolveCommand(typed);
  const canon = row?.name ?? typed;
  if (CHAT_LOCAL[canon]) { CHAT_LOCAL[canon](rest, arg); return true; }
  if (row?.retired) { logChat('*', row.retired); return true; }
  if (row) {
    // aliasAsAction (/pull lever1): typing the alias IS the action
    const a = row.aliasAsAction && typed !== row.name ? `${arg} ${typed}`.trim() : arg;
    bus.emit('command', { cmd: row.name, arg: a });
    return true;
  }
  logChat('*', `unknown command /${cmd} — try /help`);
  return true;
}

// ---------------------------------------------------------------- lifecycle

export const chat = {
  open() {
    frame.show();
    inputEl.focus();
    scrollToEnd();
  },
  close() { setInput(''); closeAC(); inputEl.blur(); },
  get isOpen() { return document.activeElement === inputEl; },
  toggle() { frame.toggle(); },
  submit: (text) => { const v = String(text ?? '').trim(); if (v) submitLine(v); },
  frame: () => frame,
  // observable, so tests can pin it
  unreadCounts: () => ({ unread, mentions: unreadMentions }),
  markRead: () => { unread = 0; unreadMentions = 0; paintUnread(); },
};
const open = chat.open;

// ---- who's-here side pane: collapsing must cost one click
const SIDE_LS = 'ew-chat-side';
// captured from initChat's markup: these classes are public (docs/MODDING-UI.md §3), so a lookup could find a mod's node
let sideEls = null;
// a detached capture reads as absent; never re-derive by class
const sideEl = (k) => { const n = sideEls?.[k] ?? null; return n?.isConnected ? n : null; };
let sideSt = { w: 150, open: false, pos: 'left' };
function initSidePane() {
  try { sideSt = { ...sideSt, ...JSON.parse(localStorage.getItem(SIDE_LS) || '{}') } } catch {}
  // guarded: a throw here would kill chat init
  const tog = sideEl('tog');
  if (tog) tog.onclick = toggleSide;
  // the open column's header closes it (the tab-row chip is hidden while it is open)
  const head = sideEl('head');
  if (head) {
    head.setAttribute('role', 'button'); head.tabIndex = 0;
    head.addEventListener('click', () => { if (sideSt.open) toggleSide(); });
    head.addEventListener('keydown', (e) => {
      if ((e.key === 'Enter' || e.key === ' ') && sideSt.open) { e.preventDefault(); e.stopPropagation(); toggleSide(); }
    });
  }

    // delegated: paintSide rebuilds the list on every roster event
    const list = sideEl('list');
    const nameOf = (row) => row?.dataset?.name ?? null;
    list?.addEventListener('dblclick', (e) => {
      const row = e.target?.closest?.('.who-row');
      if (!row || row.classList.contains('self')) return;
      const name = nameOf(row);
      if (name) mentionPerson(name);
    });
    // the person menu (people.js): right-click on desktop, a long-press sheet on phones, a strip in VR
    // a touch contextmenu IS the long-press: the sheet, never the desktop menu
    list?.addEventListener('contextmenu', (e) => {
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self')) return;
      e.preventDefault();
      const touch = e.pointerType === 'touch' || e.pointerType === 'pen' || !!press || touchAt > performance.now() - 1500;
      if (press) { clearTimeout(press.t); press = null; }
      if (touch) personUi.sheetFor(nameOf(row)); else personUi.menuAt(nameOf(row), e.clientX, e.clientY);
    });
    list?.addEventListener('keydown', (e) => {
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self')) return;
      if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); const r = row.getBoundingClientRect(); personUi.menuAt(nameOf(row), r.left + 12, r.bottom); }
    });
    let press = null, touchAt = -1e9;
    list?.addEventListener('pointerdown', (e) => {
      if (e.pointerType !== 'mouse') touchAt = performance.now();
      const row = e.target?.closest?.('.who-row'); if (!row || !personUi || row.classList.contains('self') || e.pointerType === 'mouse') return;
      const name = nameOf(row), x = e.clientX, y = e.clientY;
      press = { x, y, name, t0: e.timeStamp, t: setTimeout(() => { press = null; personUi.sheetFor(name); }, LONG_PRESS_MS) };
    });
    // a pointercancel never abandons the press: Chrome sends one at its own long-press, this very gesture
    const unpress = (e) => { if (!press || e.type === 'pointercancel') return; if (e.type === 'pointermove' && Math.hypot(e.clientX - press.x, e.clientY - press.y) < 10) return;
      // by the events' own clock: a long-press even when a busy page ran the timer late
      const held = e.type === 'pointerup' && e.timeStamp - press.t0 >= LONG_PRESS_MS, name = press.name;
      clearTimeout(press.t); press = null; if (held) personUi.sheetFor(name); };
    for (const ev of ['pointerup', 'pointercancel', 'pointermove']) list?.addEventListener(ev, unpress);
    list?.addEventListener('click', (e) => {
      if (!personUi?.presenting?.()) return;
      if (e.target?.closest?.('.pm-strip')) return;   // a press inside the open strip is the strip's
      const row = e.target?.closest?.('.who-row'); if (!row || row.classList.contains('self')) return;
      const name = nameOf(row);
      stripName = stripName === name ? null : name; paintSide(true);
    });
  const grip = sideEl('grip');
  grip?.addEventListener('pointerdown', (e) => {
    if (!sideSt.open) return;
    e.preventDefault();
    e.stopPropagation();   // the frame's root drags on body pointerdown; the grip owns this one
    const x0 = e.clientX, w0 = sideSt.w;
    const move = (ev) => {
      const d = sideSt.pos === 'left' ? ev.clientX - x0 : x0 - ev.clientX;   // grip side flips with the pane
      sideSt.w = Math.max(72, Math.min(260, w0 + d)); applySide();
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); saveSide(); };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  bus.on('roster', () => { paintSide(); paintWho(); });
  bus.on('presence:me', () => { paintSide(); paintWho(); });                                   // my own mark flips at once
  setInterval(() => { if (frame?.visible && sideSt.open) paintSide(); }, 2000);   // remote presence rides pose packets
  applySide();
}
const saveSide = () => { try { localStorage.setItem(SIDE_LS, JSON.stringify(sideSt)) } catch {} };
function toggleSide() { sideSt.open = !sideSt.open; applySide(); saveSide(); }
// the presence chip toggles the pane; collapsed, the pane leaves no strip, so chat stays centred
let whoChip = null;   // by handle, never by class (MODDING-UI §3)
function paintWho() {
  const chip = whoChip?.isConnected ? whoChip : null;
  if (!chip) return;
  const people = getPeople(), others = people.filter((p) => !p.me).length;
  const dots = [...people.filter((p) => !p.me), ...people.filter((p) => p.me)].slice(0, 3).map((p) =>
    `<span class="who-dot" data-presence="${esc(p.presence ?? 'present')}" style="background:${colorFor(p.id)}"></span>`).join('');
  chip.innerHTML = `<span class="who-dots">${dots}</span><span class="who-n">${others === 0 ? 'just you' : `${people.length} here`}</span>`;
  // on the side the column opens from
  const bar = chip.parentElement, left = sideSt.pos === 'left';
  if (left && bar.firstElementChild !== chip) bar.prepend(chip);
  else if (!left && bar.lastElementChild !== chip) bar.appendChild(chip);
  chip.classList.toggle('at-left', left);
  // open, the chip steps out: the column's header says who's here and is the way back
  chip.hidden = !!sideSt.open;
  chip.setAttribute('aria-expanded', String(!!sideSt.open));
  chip.title = 'people here';
}
function applySide() {
  const side = sideEl('side');
  if (!side) return;
  side.classList.toggle('closed', !sideSt.open);
  // closed, nothing to grab, so the grab edge's line goes too
  sideEl('cols')?.classList.toggle('side-closed', !sideSt.open);
  paintWho();
  side.style.width = sideSt.open ? `${sideSt.w}px` : '';
  // the chevron points the way the pane will move
  const left = sideSt.pos === 'left';
  const chev = (sideSt.open !== left) ? '›' : '‹';
  const t = sideEl('tog'); if (t) t.textContent = chev;
  // the header's chevron is drawn from data-chev by CSS, so its text stays exactly who's here
  const head = sideEl('head');
  if (head) { head.dataset.chev = chev; head.title = 'hide people here'; }
  paintSide();
}
const LONG_PRESS_MS = 500;
let stripName = null;   // the person whose inline action strip is open (VR), or null
function paintSide(force = false) {
  const side = sideEl('side');
  if (!side || !sideSt.open) return;
  // the 2 s repaint mustn't wipe a strip's half-filled form (a roster change still does)
  if (stripName && !force && sideEl('list')?.querySelector('.pm-strip')?.childElementCount) return;
  const people = getPeople();
  const others = people.filter((p) => !p.me).length;
  sideEl('head').textContent =
    others === 0 ? 'just you' : `${others} other${others === 1 ? '' : 's'} here`;
  const html = people.length
      // a BUTTON: windows.js _contentClaims exempts only interactive tags from the frame's drag surface
      ? people.map((p) => `<button type="button" class="who-row ${p.me ? 'self' : ''}" data-name="${esc(p.id)}"${p.me || !personUi ? '' : ' aria-haspopup="menu"'}>
          <span class="who-mark" data-presence="${esc(p.presence ?? 'present')}" title="${esc(p.presence ?? 'present')}"></span>
          <span class="n" style="color:${colorFor(p.id)}">${esc(p.id)}${p.me ? ' (you)' : ''}</span>${personUi ? personUi.badgeHtml(p.id, esc) : ''}${personUi?.muted?.(p.id) ? '<span class="who-muted" title="muted by a moderator" aria-label="muted">⊘</span>' : ''}
          <span class="d">${p.dist == null ? '' : p.dist.toFixed(0) + 'm'}</span></button>${stripName === p.id && personUi ? '<div class="pm-strip" data-for="' + esc(p.id) + '"></div>' : ''}`).join('')
    : '<div class="who-empty">nobody yet</div>';
  // only when changed: a rebuild resets hover and focus, and detaches the row under a pointer mid-press
  const listEl = sideEl('list');
  if (listEl._html === html && !force) return;
  listEl.innerHTML = html; listEl._html = html;
  const strip = stripName && listEl.querySelector('.pm-strip');
  if (strip) personUi.stripFor(stripName, strip);
}

// ---- chat gear: text size, markdown, which side the people pane sits on; persisted
const CFS_LS = 'ew-chat-fs';
function applyChatPrefs() {
  // never a .chat-log lookup a mod's node could win (MODDING-UI §3)
  if (logEl) logEl.style.fontSize = `${chatFs}px`;
  sideEl('cols')?.classList.toggle('side-left', sideSt.pos === 'left');
}
let gearToggle = null, gearAnchor = null, placeGear = () => {};
let chatFs = 14;
const CMD_LS = 'ew-chat-md';
let chatMd = true;   // inline markdown in the log
try { chatMd = localStorage.getItem(CMD_LS) !== '0' } catch {}
export const chatMarkdownOn = () => chatMd;
try { chatFs = Math.min(20, Math.max(11, parseFloat(localStorage.getItem(CFS_LS)) || 14)) } catch {}
function initChatGear() {
  const pop = frame.body.querySelector('.chat-gearpop');
  placeGear = () => {
    if (pop.hidden || !gearAnchor) return;
    const a = gearAnchor.getBoundingClientRect(), f = frame.el.getBoundingClientRect();
    const body = frame.body.getBoundingClientRect();
    const minTop = Math.max(4, body.top - f.top + 4);
    const bottom = Math.min(frame.el.clientHeight, body.bottom - f.top) - 4;
    // below if it fits, else upward; neither: the roomier side, scrolling rather than clipping
    const below = a.bottom - f.top + 6, above = a.top - f.top - 6;
    pop.style.maxHeight = 'none';
    const height = pop.offsetHeight;
    const roomBelow = bottom - below, roomAbove = above - minTop;
    const down = height <= roomBelow || (height > roomAbove && roomBelow >= roomAbove);
    const room = Math.max(1, down ? roomBelow : roomAbove);
    pop.style.maxHeight = `${room}px`;
    pop.style.top = `${down ? below : Math.max(minTop, above - Math.min(height, room))}px`;
    pop.style.right = `${Math.max(4, Math.min(f.right - a.right, frame.el.clientWidth - pop.offsetWidth - 4))}px`;
  };
  const paintPop = () => {
    pop.innerHTML = `
      <div class="gp-row"><span>text size</span>
        <button data-fs="-1">−a</button><b>${chatFs}</b><button data-fs="1">+A</button></div>
      <div class="gp-row"><span>markdown</span>
        <button data-md="1" class="${chatMd ? 'on' : ''}">on</button>
        <button data-md="0" class="${!chatMd ? 'on' : ''}">off</button></div>
      <div class="gp-row"><span>People Here</span>
        <button data-side="left" class="${sideSt.pos === 'left' ? 'on' : ''}">left</button>
        <button data-side="right" class="${sideSt.pos !== 'left' ? 'on' : ''}">right</button></div>`;
    mountAttentionControls(pop);
    placeGear();
  };
  pop.onclick = (e) => {
    const fs = e.target?.dataset?.fs, sd = e.target?.dataset?.side, md = e.target?.dataset?.md;
    if (md != null) {
      chatMd = md === '1';
      try { localStorage.setItem(CMD_LS, md) } catch {}
    } else if (fs) {
      chatFs = Math.min(20, Math.max(11, chatFs + Number(fs)));
      try { localStorage.setItem(CFS_LS, String(chatFs)) } catch {}
    } else if (sd) {
      sideSt.pos = sd; saveSide();
    } else return;
    applyChatPrefs(); applySide(); paintPop();   // applySide repaints the chevron for the new side
  };
  gearToggle = (anchor) => {
    pop.hidden = !pop.hidden;
    anchor.setAttribute('aria-expanded', String(!pop.hidden));
    gearAnchor = anchor;
    if (!pop.hidden) {
      paintPop();
    }
  };
  const gear = frame.body.querySelector('.chat-compose > .chat-gear');
  if (gear) {
    gear.innerHTML = fsvg('gear-six', 14);
    gear.onclick = (e) => { e.stopPropagation(); gearToggle(gear); };
  }
  const closePop = () => { if (!pop.hidden && gearAnchor) gearToggle(gearAnchor); };
  document.addEventListener('pointerdown', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !gearAnchor?.contains(e.target)) closePop();
  }, true);
  addEventListener('keydown', (e) => { if (e.key === 'Escape') closePop(); });
  applyChatPrefs();
}

// the compose box grows to six lines or 40% of the pane, whichever is less, so the log is never pushed out of sight
const INPUT_MAX_LINES = 6, INPUT_MAX_SHARE = 0.4;
function sizeInput() {
  if (!inputEl) return;
  const cs = getComputedStyle(inputEl);
  const line = parseFloat(cs.lineHeight) || parseFloat(cs.fontSize) * 1.35;
  const chrome = (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0) + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0);
  const pane = inputEl.closest('.fr-body')?.clientHeight || innerHeight;
  const max = Math.max(line + chrome, Math.min(line * INPUT_MAX_LINES + chrome, pane * INPUT_MAX_SHARE));
  inputEl.style.height = 'auto';
  // empty: exactly one line, or a long placeholder wraps the box taller
  const want = inputEl.value ? inputEl.scrollHeight + (parseFloat(cs.borderTopWidth) || 0) + (parseFloat(cs.borderBottomWidth) || 0) : line + chrome;
  inputEl.style.height = `${Math.min(want, max)}px`;
  inputEl.style.overflowY = want > max + 1 ? 'auto' : 'hidden';
}
function setInput(v) { if (!inputEl) return; inputEl.value = v; sizeInput(); }

export function initChat({ send, typing, people, person }) {
  personUi = person ?? null;
  initAttention({ bus, me: () => CONFIG.name, scope: () => CONFIG.world, mentions: mentionsMe });
  onSend = send;
  onTyping = typing ?? (() => {});
  getPeople = people ?? (() => []);

  frame = makeFrame('chat', {
    title: 'Chat',
    x: 10, y: -10, w: 390, h: 200, minW: 240, minH: 100,
      className: 'chat-frame',
      // narrowing changes clientWidth with nothing else repainting the tab arrows
      onResize: () => { placeGear(); clearTimeout(_arrowT); _arrowT = setTimeout(() => paintTabs(), 120); },
  });

  frame.body.innerHTML = `
    <div class="chat-cols">
      <div class="chat-main">
        <div class="chat-tabs"></div>
        <div id="chatlog" class="chat-log"></div>
        <button id="chat-jump" class="chat-jump"></button>
        <div class="chat-typing"></div>
        <div class="chat-compose">
          <div id="chat-ac" class="ac panel"></div>
          <textarea id="chatline" rows="1" enterkeyhint="send" placeholder="say something…  @ to mention · / for commands"></textarea>
          <button type="button" class="chat-gear" title="chat options" aria-expanded="false" aria-haspopup="dialog"></button>
        </div>
      </div>
      <button class="chat-side-tog" title="People Here"></button>
      <div class="chat-side closed">
        <div class="chat-side-grip"></div>
        <div class="chat-side-head"></div>
        <div class="chat-side-list"></div>
      </div>
    </div>
    <div class="chat-gearpop panel" hidden></div>`;
  { const cols = frame.body.querySelector(':scope > .chat-cols');
    sideEls = cols ? {
      cols,
      tog: cols.querySelector(':scope > .chat-side-tog'),
      side: cols.querySelector(':scope > .chat-side'),
      grip: cols.querySelector(':scope > .chat-side > .chat-side-grip'),
      head: cols.querySelector(':scope > .chat-side > .chat-side-head'),
      list: cols.querySelector(':scope > .chat-side > .chat-side-list'),
    } : null; }
  // ui.js needs these exact nodes (a class lookup can lose to a mod's); via the frame, so neither imports the other
  frame.sidePane = (k) => sideEl(k);
  // BEFORE initChatGear, or the saved text size is a no-op
  logEl = frame.body.querySelector('#chatlog');
  tabsEl = frame.body.querySelector(':scope > .chat-cols > .chat-main > .chat-tabs');
  initSidePane();
  initChatGear();

  inputEl = frame.body.querySelector('#chatline');
  inputEl.addEventListener('focus', () => requestAnimationFrame(sizeInput));
  if (globalThis.ResizeObserver) new ResizeObserver(() => sizeInput()).observe(frame.body);
  acBox = frame.body.querySelector('#chat-ac');
  closeAC();

  paintTabs();

  jumpEl = frame.body.querySelector('#chat-jump'); jumpEl.onclick = scrollToEnd;
  logEl.addEventListener('scroll', () => {
    // never set scrollTop here (it traps the reader); stick-to-bottom is in account()
    if (logEl.scrollHeight - logEl.scrollTop - logEl.clientHeight < 48 &&
        (unread || unreadMentions)) {
      unread = 0; unreadMentions = 0; paintUnread();
    }
    if (logEl.scrollTop < 60) loadOlder();
  });

  inputEl.addEventListener('input', () => {
    sizeInput();
    updateAC();
    // throttle: presence, not a keystroke log
    const now = performance.now();
    if (inputEl.value.trim() && now - lastTypingSent > 2500) {
      lastTypingSent = now;
      onTyping(null);
    }
  });
  inputEl.addEventListener('blur', () => setTimeout(closeAC, 120));
  inputEl.addEventListener('keydown', (e) => {
    e.stopPropagation();                       // typing is never walking

    if (acItems.length) {
      if (e.key === 'ArrowDown') { e.preventDefault(); return moveAC(1); }
      if (e.key === 'ArrowUp') { e.preventDefault(); return moveAC(-1); }
      if (e.key === 'Tab' || (e.key === 'Enter' && acKind)) { e.preventDefault(); return acceptAC(); }
      if (e.key === 'Escape') { e.preventDefault(); return closeAC(); }
    }

    if (e.key === 'Escape') { chat.close(); return; }

    if (e.key === 'ArrowUp' && !inputEl.value.trim() || (e.key === 'ArrowUp' && historyIdx >= 0 && !inputEl.value.slice(0, inputEl.selectionStart ?? 0).includes('\n'))) {
      if (sentHistory.length) {
        e.preventDefault();
        historyIdx = Math.min(historyIdx + 1, sentHistory.length - 1);
        setInput(sentHistory[sentHistory.length - 1 - historyIdx]);
        inputEl.setSelectionRange(inputEl.value.length, inputEl.value.length);
      }
      return;
    }
    if (e.key === 'ArrowDown' && historyIdx >= 0 && !inputEl.value.slice(inputEl.selectionEnd ?? inputEl.value.length).includes('\n')) {
      e.preventDefault();
      historyIdx--;
      setInput(historyIdx < 0 ? '' : sentHistory[sentHistory.length - 1 - historyIdx]);
      return;
    }

    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();                      // Shift+Enter is a new line
      const v = inputEl.value.trim();
      setInput('');
      historyIdx = -1;
      closeAC();
      if (!v) { inputEl.blur(); return; }
      submitLine(v);
    }
  });

  // one needing an argument or target ("/push [name]") FILLS the prompt: run bare, it would pick whoever is nearest
  for (const row of COMMANDS) {
    if (row.listed === false) continue;
    const needsArg = new RegExp(`^/${row.name} (<|\\[(name|thing|person)\\b)`).test(row.help);
    registerAction({
      id: `cmd:${row.name}`, title: `/${row.name}`, group: 'commands', detail: row.help,
      // the name is not ALSO an exact keyword, or /sit outranks the body's own sit / stand
      keywords: [...(row.aliases ?? []), row.help.replace(/^\/\S+\s*/, '').replace(/[<>[\]—|"]/g, ' ')],
      ...(needsArg ? { fill: `/${row.name} ` } : { run: () => submitLine(`/${row.name}`) }),
    });
  }

  try { sentHistory.push(...(JSON.parse(localStorage.getItem(HISTORY) ?? '[]'))); } catch { /* none */ }

  return chat;
}

// ---------------------------------------------------------------- mention a person
/** A public line that names them, never a private one: world chat has no private channel. */
export function mentionPerson(name) {
  if (!name) return;
  chat.open();
  insertAtCursor(`@${name} `);
  inputEl.focus();
}

function setFilter(f) {
  filter = f;
  paintTabs();
  repaintFilter();
}

let _arrowT = null;
let tabsEl = null;    // captured in initChat, like sideEls

function paintTabs() {
  const bar = tabsEl;
  if (!bar) return;
  bar.innerHTML = '';
  // tabs size to their labels and the row scrolls on a narrow panel, rather than thinning every tab
  const left = document.createElement('button');
  left.className = 'tabarrow'; left.type = 'button'; left.textContent = '\u2039';
  left.title = 'scroll tabs left'; left.setAttribute('aria-label', 'scroll tabs left');
  const scroll = document.createElement('div');
  scroll.className = 'tabscroll';
  const right = document.createElement('button');
  right.className = 'tabarrow'; right.type = 'button'; right.textContent = '\u203a';
  right.title = 'scroll tabs right'; right.setAttribute('aria-label', 'scroll tabs right');
  const STEP = 90;
  left.onclick = (e) => { e.stopPropagation(); scroll.scrollLeft -= STEP; };
  right.onclick = (e) => { e.stopPropagation(); scroll.scrollLeft += STEP; };
  // an arrow with nowhere to go is a lie about the interface
  const paintArrows = () => {
    const over = scroll.scrollWidth > scroll.clientWidth + 1;
    left.hidden = !over || scroll.scrollLeft <= 0;
    right.hidden = !over || scroll.scrollLeft + scroll.clientWidth >= scroll.scrollWidth - 1;
  };
  scroll.addEventListener('scroll', paintArrows);
    // paintTabs and onResize run before layout; a ResizeObserver fires after it
    if (typeof ResizeObserver === 'function') {
      try { new ResizeObserver(() => paintArrows()).observe(scroll); } catch { /* older engine */ }
    }
  bar.append(left, scroll, right);
  const mk = (key, label) => {
    const b = document.createElement('button');
    b.className = filter === key ? 'on' : '';
    const lbl = document.createElement('span');
    lbl.textContent = label;
    b.append(lbl);
    b.onclick = () => setFilter(key);
    scroll.appendChild(b);
  };
  mk('all', 'all');
  mk('mentions', 'mentions');
  mk('system', 'system');
  const who = document.createElement('button');
  who.type = 'button'; who.className = 'chat-who';
  who.onclick = (e) => { e.stopPropagation(); toggleSide(); };
  bar.appendChild(who);
  whoChip = who;
  paintWho();
  paintArrows();
  // keep the active tab fully in view, even if others scroll off
  const active = scroll.querySelector('button.on');
  if (active) {
    // after layout too, or scrollWidth is 0; 'nearest', not 'end': 'end' leaves a clipped tab clipped
      const bring = () => active.scrollIntoView?.({ inline: 'nearest', block: 'nearest' });
    bring();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => { bring(); paintArrows(); });
  }
  // the scroller has no measurable width until layout runs
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(paintArrows);
}

// ---------------------------------------------------------------- typing
// presence only, gone a second later

const typers = new Map();           // id -> expiry
let lastTypingSent = 0;
export function noteTyping(id) {
  typers.set(id, performance.now() + 4000);
  paintTypers();
}
function paintTypers() {
  const el = frame?.body.querySelector('.chat-typing');
  if (!el) return;
  const now = performance.now();
  for (const [id, exp] of typers) if (exp < now) typers.delete(id);
  const names = [...typers.keys()];
  el.textContent = names.length === 0 ? ''
    : names.length === 1 ? `${names[0]} is typing…`
      : names.length === 2 ? `${names[0]} and ${names[1]} are typing…`
        : `${names.length} people are typing…`;
  el.style.display = names.length ? 'block' : 'none';
}
setInterval(paintTypers, 1200);

/** Flash the frame even if you're looking elsewhere. */
bus.on('pinged', () => {
  frame?.el.classList.add('flash');
  setTimeout(() => frame?.el.classList.remove('flash'), 1400);
});

// ---- the chat frame as a VR quad: READ + canned replies --------------------
// no headset keyboard yet: canned replies go through the same onSend
const CANNED = ['hello', 'yes', 'no', 'one moment', 'come here', 'thank you'];
export const chatXRPanel = {
  id: 'chat', title: 'Chat',
  fields: () => [
    ...(recent.length ? recent.slice(-8).map((l, i) => ({ t: 'info', label: l.who === '*' ? '·' : String(l.who).slice(0, 12), value: l.text }))
                      : [{ t: 'info', label: '·', value: 'nothing said yet' }]),
    ...CANNED.map((c) => ({ t: 'btn', k: `say:${c}`, label: c })),
  ],
  dispatch: (k) => { if (k?.startsWith('say:')) onSend?.(k.slice(4)); },
};
