// ui — everything that isn't the 3D scene or the chat window: toasts, loading tray, HUD, hint bar, panel frames,
// the dock, the ∃ menu and the two overlays (help, front door)

import { chooseClient } from './litechoice.js';
import { confirmCenter } from './confirmcenter.js';
import { bus, CONFIG, setName, setToken, setErrorSink, report, forgetRememberedWorlds } from './base.js';
import { resizeZoneAt, fitTabStrip } from './windows.js';
import { flipMic, flipEar, micLive, earOn, glyphPinned, setGlyphPinned, micGlyph, earGlyph, xrGlyph, xrGlyphAvailable, xrLive, flipXr } from './mictoggle.js';
import { svg, fsvg, hasFill, rsvg, hasLine } from './icons.js';
import { html, paint, lineKey } from './markup.js';
export { html, markup } from './markup.js';

// section-head emoji → Phosphor fill glyph: menu chrome never rides emoji (platform glyph gaps are silent)
// the entry id wins over the emoji: '🧱' is a hammer in catalog.js's BUILD section
const ID_ICON = { world: 'planet' };
const EMOJI_ICON = {
  '💬': 'chat-circle',
  '👋': 'hand-waving',
  '🐞': 'bug',
  '🧱': 'hammer', '🧍': 'person-arms-spread', '🌿': 'plant', '☀': 'sun', '🔒': 'lock',
  '✨': 'sparkle', '🌳': 'tree', '📜': 'scroll', '🧩': 'puzzle-piece', '🔊': 'speaker-high', '🎨': 'palette', '🖥': 'monitor', '🥽': 'virtual-reality', '🛡': 'shield',
};
// injected, not imported: assets.js reaches the engine, and ui.js is shared with a renderer-free client; main.js wires it
let loadingItems = () => [];
export function setLoadingItems(fn) { loadingItems = fn; }
import { makeFrame, getFrame, isLocked, setLocked, resetLayout, escapeHid } from './windows.js';
import { defsRegistry } from './defs.js';
import { register as registerAction, get as getAction } from './actions.js';
import { openLantern, closeLantern, isLanternOpen, CHORD, pillPinned, setPillPinned, setPillQuiet, resetPillPlace } from './commandbar.js';
import { escapeHtml } from './markup.js';

const $ = (id) => document.getElementById(id);
export const el = {
  hud: $('hud'), loading: $('loading'), toasts: $('toasts'), hint: $('hintbar'),
  door: $('door'), help: $('help'), dock: $('dock'), touch: $('touch'),
};

// ============================================================ toasts

const liveToasts = new Map();

export function toast(message, kind = 'info', ttl = kind === 'err' ? 9000 : 5000) {
  const key = `${kind}:${message}`;
  const existing = liveToasts.get(key);
  if (existing) { // same thing again: bump a counter, never stack dupes
    existing.n++;
    existing.count.textContent = ` ×${existing.n}`;
    clearTimeout(existing.timer);
    existing.timer = setTimeout(() => dismiss(key), ttl);
    return;
  }
  const node = document.createElement('div');
  node.className = `toast panel ${kind}`;
  const body = document.createElement('span');
  body.textContent = message;
  const count = document.createElement('span');
  count.className = 'ctx';
  node.append(body, count);
  node.onclick = () => dismiss(key);
  el.toasts.appendChild(node);
  liveToasts.set(key, { node, count, n: 1, timer: setTimeout(() => dismiss(key), ttl) });
  while (el.toasts.children.length > 5) el.toasts.removeChild(el.toasts.firstChild);
}
function dismiss(key) {
  const t = liveToasts.get(key);
  if (!t) return;
  liveToasts.delete(key);
  clearTimeout(t.timer);
  t.node.classList.add('out');
  setTimeout(() => t.node.remove(), 320);
}
setErrorSink((context, message) => toast(`${context}: ${message}`, 'err'));

// ============================================================ loading tray

bus.on('loading', () => {
  const items = loadingItems();
  // the raw load list is debug's, not the HUD's: shown only while debug is open
  el.loading.classList.toggle('on', items.length > 0 && !!getFrame('debug')?.visible);
  el.loading.textContent = items.map((l) =>
    l.total ? `⏳ ${l.label} ${Math.min(99, Math.round((l.done / l.total) * 100))}%` : `⏳ ${l.label}…`,
  ).join('\n');
});

// ============================================================ HUD + hints

export function setHud(parts) { el.hud.innerHTML = parts; }

// text is shown as characters, never parsed, unless built with the html tag (markup.js): a name must not run script
// ============================================================ ONE status bar
// #hintbar is the one bar at the lantern's spot, and everything CLAIMS it with a priority:
//   1 attn      a refusal (attention colour, copy pill, holds while pointed at)
//   2 keys      the engaged gesture's keys (keyhints `during`)
//   2.5 flash   a moment's notice ("panels hidden · Tab", "locked", the authority's warnings on my own edit)
//   3 hint      setHint's standing line (30 s unless sticky)
//   4 selection edit mode's selection line (name · keys · lock)
//   5 ambient   the standing offer from the world ("X — sit")
// the lowest live claim shows (no stacking); the lantern pill shows when none does. Content: text, html``, or a node
const claims = new Map();   // id → { id, priority, content, node, tone, hold, ttl, timer }
let hovering = false;
const winner = () => { let w = null; for (const c of claims.values()) if (!w || c.priority < w.priority) w = c; return w; };
export function claimStatus(id, { priority = 3, content = null, node = null, tone = null, ttl = null, hold = false } = {}) {
  const old = claims.get(id); if (old?.timer) clearTimeout(old.timer);
  const c = { id, priority, content, node, tone, hold, ttl, timer: null };
  const arm = (ms) => { c.timer = setTimeout(() => { if (claims.get(id) !== c) return;
    if (c.hold && hovering && winner() === c) { arm(1500); return; }   // pointed at: it stays until the pointer leaves
    claims.delete(id); showStatus(); }, ms); };
  if (ttl) arm(ttl);
  claims.set(id, c); showStatus();
}
export function releaseStatus(id) { const c = claims.get(id); if (!c) return; if (c.timer) clearTimeout(c.timer); claims.delete(id); showStatus(); }
export const statusShown = () => winner()?.id ?? null;
const pillYield = (on) => document.getElementById('lantern-pill')?.classList.toggle('yield', on);
function addCopy(h) {
  // a refusal can be copied: selectable text, a copy button at its end, held on screen while pointed at
  const b = document.createElement('button'); b.type = 'button'; b.className = 'hint-copy'; b.title = 'copy this message'; b.textContent = '⧉';
  b.onclick = (e) => { e.stopPropagation(); const t = [...h.childNodes].filter((n) => n !== b).map((n) => n.textContent).join('').trim();
    navigator.clipboard?.writeText(t).then(() => { b.textContent = '✓'; }, () => { b.textContent = 'select it to copy'; }); };
  h.append(b);   // an attn bar wraps, so a long reason never cuts the button off
}
function showStatus() {
  const c = winner(), h = el.hint;
  h.classList.toggle('attn', c?.tone === 'attn');
  h.classList.toggle('has-node', !!c?.node);
  if (!c) { h.classList.add('gone'); h._t = null; delete h.dataset.keyhint; pillYield(false); return; }
  if (c.node) h.replaceChildren(c.node); else { paint(h, c.content); if (c.tone === 'attn') addCopy(h); }
  if (c.id === 'keys') h.dataset.keyhint = '1'; else delete h.dataset.keyhint;
  h._t = c.id === 'flash' || c.id === 'hint' ? (c.timer ?? -1) : null;   // "a flash owns the bar": readers of _t keep working
  h.classList.remove('gone'); pillYield(true);
}

export function setHint(line, { sticky = false } = {}) { claimStatus('hint', { priority: 3, content: line, ttl: sticky ? null : 30000 }); }

// the ambient hint is set and cleared by proximity
let ambientHint = null;
export function setAmbientHint(line) {
  if (lineKey(line) === lineKey(ambientHint)) return;
  ambientHint = line;
  if (ambientHint) claimStatus('ambient', { priority: 5, content: ambientHint }); else releaseStatus('ambient');
}
// Tab put every panel away (windows.js): say how to get them back; the lantern's resting line follows them (commandbar.js setPillQuiet)
bus.on('esc-quiet', (did) => {
  setPillQuiet(did === 'closed');
  if (did === 'closed') flashHint(html`<span>${escapeHid() ? 'panels hidden' : 'hidden'} · <kbd>Tab</kbd> to bring back</span>`, 4000);   // one span: the bar is a flex row, which would eat the space
  else if (did === 'restored' && statusShown() === 'flash' && /hidden · Tab to bring back/.test(el.hint.textContent)) endFlash();
});
/** `line` is text unless built with html`` (markup.js). tone 'attn': what you asked for didn't happen, and why;
 *  it outranks everything and holds while pointed at. */
export function flashHint(line, ms = 2600, tone = null) {
  // attn 1 · keys 2 (a hand is on something NOW) · flash 2.5 · warn/hint 3: what I did outranks the authority's caveat
  // on the same reply (it shows once the flash ends), never the engaged gesture's keys
  claimStatus('flash', { priority: tone === 'attn' ? 1 : 2.5, content: line, tone, ttl: ms, hold: tone === 'attn' });
}
function endFlash() { releaseStatus('flash'); }
el.hint.onpointerenter = () => { hovering = true; };
el.hint.onpointerleave = () => { hovering = false; };
// the engaged gesture's keys (keyhints.js engage/release): what the keys do RIGHT NOW, while the hand is on something
bus.on('keyhint', (h) => {
  if (h) claimStatus('keys', { priority: 2, content: html`<span>${h}</span>` }); else releaseStatus('keys');
});

// ============================================================ cursors
// --fg is baked into --cur-loupe: CSS url() cursors can't read custom properties (index.html holds the rule)

let _cursorBrand = null;
function buildCursors() {
  const brand = (getComputedStyle(document.documentElement).getPropertyValue('--fg') || '#ebebe9').trim();
  if (brand === _cursorBrand) return;
  _cursorBrand = brand;
  const ink = '#101b1a';
  const enc = (s) => `url("data:image/svg+xml,${encodeURIComponent(s)}")`;
  const loupe =
    `<svg xmlns='http://www.w3.org/2000/svg' width='24' height='24' viewBox='0 0 24 24'>` +
    `<circle cx='10' cy='10' r='6.5' fill='rgba(16,27,26,0.25)' stroke='${brand}' stroke-width='2'/>` +
    `<line x1='15' y1='15' x2='21' y2='21' stroke='${brand}' stroke-width='2.6' stroke-linecap='round'/>` +
    `<line x1='15' y1='15' x2='21' y2='21' stroke='${ink}' stroke-width='1' stroke-linecap='round'/></svg>`;
  document.documentElement.style.setProperty('--cur-loupe', `${enc(loupe)} 10 10, crosshair`);
}
buildCursors();
// buildCursors is a no-op unless --fg changed, so our own --cur-loupe write can't feed the observer back into itself
new MutationObserver(buildCursors)
  .observe(document.documentElement, { attributes: true, attributeFilter: ['style'] });

// ============================================================ slider fill
// WebKit tracks have no progress fill: each .row range carries a --p the gradient reads (index.html)
// swept every 200 ms, since code also sets .value without events

function paintRange(i) {
  const min = +i.min || 0, max = +i.max || 100;
  i.style.setProperty('--p', `${(((+i.value || 0) - min) / (max - min || 1)) * 100}%`);
}
document.addEventListener('input', (e) => {
  if (e.target.matches?.('input[type=range]')) paintRange(e.target);
}, true);
/** Call after setting .value from code (the sweep lags). */
export function paintRangesIn(root = document) {
  for (const i of root.querySelectorAll('input[type=range]')) paintRange(i);
}
setInterval(() => paintRangesIn(document), 200);   // module-scope timer: a node-side importer of ui.js needs an explicit process.exit

// ============================================================ tooltips
// native title= tooltips paint in OS chrome no token reaches: one chip borrows the title on hover, hands it back on leave
// new code keeps writing title=

const tip = document.createElement('div');
tip.id = 'tipchip';
document.body.appendChild(tip);
let tipTimer = null, tipHost = null;
// ancestors' titles are borrowed too while a DESCENDANT holds the tip, or the browser paints the ancestor's NATIVE one
let tipAnc = [];

function tipHide() {
  clearTimeout(tipTimer); tipTimer = null;
  if (tipHost) { if (tipHost._tip) tipHost.setAttribute('title', tipHost._tip); tipHost._tip = null; tipHost = null; }
  for (const [el, t] of tipAnc) el.setAttribute('title', t);
  tipAnc = [];
  tip.classList.remove('show');
}
document.addEventListener('mouseover', (e) => {
  const host = e.target.closest?.('[title]');
  if (!host || host === tipHost) return;
  tipHide();
  const text = host.getAttribute('title');
  if (!text) return;
  tipHost = host; host._tip = text; host.removeAttribute('title');
  for (let a = host.parentElement?.closest('[title]'); a; a = a.parentElement?.closest('[title]')) {
    tipAnc.push([a, a.getAttribute('title')]); a.removeAttribute('title');
  }
  tipTimer = setTimeout(() => {
    if (tipHost !== host || !document.body.contains(host)) return;
    tip.textContent = host._tip;   // reread: paintHud may have refreshed it
    const r = host.getBoundingClientRect();
    tip.style.left = '0px'; tip.style.top = '0px';   // reset before measuring
    tip.classList.add('show');
    const tw = tip.offsetWidth, th = tip.offsetHeight;
    let x = Math.round(r.left + r.width / 2 - tw / 2);
    let y = Math.round(r.bottom + 7);
    if (y + th > innerHeight - 4) y = Math.round(r.top - th - 7);   // flip above
    // a VERTICAL rail's tip goes beside the rail: under the button it covers the next one
    const edge = host.closest?.('#dock')?.dataset.edge;
    if (edge === 'left' || edge === 'right') {
      y = Math.round(r.top + r.height / 2 - th / 2);
      x = Math.round(edge === 'left' ? r.right + 10 : r.left - tw - 10);
    }
    // a WATERFALL row's tip goes past the rightmost open menu, level with the row: under it covers the rows you move to
    if (host.closest?.('#emenu, #emenu-sub')) {
      const menus = ['#emenu', '#emenu-sub'].map((q) => document.querySelector(q)).filter((m) => m && !m.hidden && getComputedStyle(m).display !== 'none')   /* not offsetParent: it is null for any fixed element */.map((m) => m.getBoundingClientRect());
      const right = Math.max(...menus.map((m) => m.right)), left = Math.min(...menus.map((m) => m.left));
      y = Math.round(Math.max(4, Math.min(r.top + r.height / 2 - th / 2, innerHeight - th - 4)));
      x = right + 10 + tw <= innerWidth - 4 ? Math.round(right + 10) : Math.round(left - tw - 10);
    }
    x = Math.max(4, Math.min(x, innerWidth - tw - 4));
    tip.style.left = `${x}px`; tip.style.top = `${y}px`;
  }, 450);
}, true);
document.addEventListener('mouseout', (e) => {
  if (tipHost && !tipHost.contains(e.relatedTarget)) tipHide();
}, true);
document.addEventListener('mousedown', tipHide, true);

// paintHud rewrites #hud.title at 1Hz: while borrowed, route it into the stash, never re-arm the native tip mid-hover
new MutationObserver(() => {
  if (tipHost && !document.body.contains(tipHost)) return tipHide();   // host repainted away mid-hover
  if (tipHost?.hasAttribute('title')) {
    tipHost._tip = tipHost.getAttribute('title');
    tipHost.removeAttribute('title');
    if (tip.classList.contains('show')) tip.textContent = tipHost._tip;
  }
}).observe(document.body, { attributes: true, attributeFilter: ['title'], childList: true, subtree: true });

// ============================================================ panel frames

// World and Settings hold their sections as TABS: one .pf-tabs strip (the client's one tab mechanism), one pane
function tabbedFrame(id, opts) {
  const f = makeFrame(id, opts);
  f.body.classList.add('tabbed');
  const strip = document.createElement('div');
  strip.className = 'pf-tabs sec-tabs'; strip.setAttribute('role', 'tablist');
  const stack = document.createElement('div');
  stack.className = 'stack';
  f.body.append(strip, stack);
  f.stack = stack; f.strip = strip; f.sections = [];
  // how much label the strip can afford, re-decided whenever it or its tabs change size
  const fitStrip = () => fitTabStrip(strip);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(fitStrip).observe(strip);
  f.fitStrip = fitStrip;
  // never an empty pane: the last-chosen tab, else the first
  const LS = `ew-tab-${id}`;
  f.ensureTab = () => {
    if (!f.visible || f.sections.some((x) => x.isOpen) || !f.sections.length) return;
    let want = null; try { want = localStorage.getItem(LS); } catch {}
    const pick = f.sections.find((x) => x.key === want) ?? f.sections[0];
    pick.toggle(true).catch((e) => report(pick.key, e));
  };
  f.rememberTab = (key) => { try { localStorage.setItem(LS, key); } catch {} };
  f.onShow(() => { f.ensureTab(); fitStrip(); });   // every way back on screen, the viewport restore included
  return f;
}

let worldFrame = null;
export function panelFrame() {
  if (!worldFrame) {
    worldFrame = tabbedFrame('world', {
      title: 'world', x: -10, y: 52, w: 280, h: 320, minW: 200,   // 280: eight tabs with the chosen one's name
    });
  }
  return worldFrame;
}

// engine settings: the machine-noun home (video, sound, controls)
let settingsFrameApi = null;
export function settingsFrame() {
  if (!settingsFrameApi) {
    settingsFrameApi = tabbedFrame('settings', {
      title: 'settings', x: -10, y: 384, w: 280, h: 280, minW: 210, hidden: true,   // right column, UNDER world (52+320+12)
    });
    // its own dock entry (nothing else can open it); a caller that listed 'settings' wins
    if (!dockEntries.some((e) => e.id === 'settings')) { const entry = { id: 'settings', icon: 'gear-six' }; dockEntries.push(entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
  }
  return settingsFrameApi;
}

/** A TAB and its pane. onOpen is awaited on every choose, so rosters and catalogs re-fetch, never go stale.
 *  The api is the accordion's: `box` (#sec-<id>, .open while chosen) holds `body`; `head` is #sec-<id>-tab. */
// Moderation's dock entry exists only while you hold a moderation power (setDockEntry)
// World Settings is everyone's (owners edit, everyone reads); each thing lives in exactly one place
let moderationFrameApi = null, worldSettingsFrameApi = null;
export function moderationFrame() {
  if (!moderationFrameApi) moderationFrameApi = tabbedFrame('moderation', { title: 'moderation', x: 70, y: 60, w: 360, h: 360, minW: 240, hidden: true });
  return moderationFrameApi;
}
export function worldSettingsFrame() {
  if (!worldSettingsFrameApi) worldSettingsFrameApi = tabbedFrame('world-settings', { title: 'world settings', x: 90, y: 80, w: Math.min(600, innerWidth - 24), h: 440, minW: 260, hidden: true });   // the four built-in roles' columns
  return worldSettingsFrameApi;
}
/** After boot: the Moderation entry follows your rights. */
export function setDockEntry(entry, on) {
  const has = dockEntries.some((e) => e.id === entry.id);
  // pinOnce: pinned the first time this person sees it, then their unpin is theirs
  if (on && entry.pinOnce) { try { const k = `ew-dock-${entry.id}-seen`; if (!localStorage.getItem(k)) { localStorage.setItem(k, '1'); pins.add(entry.id); savePins(); } } catch {} }
  if (on && !has) { const at = dockEntries.findIndex((e) => e.last); dockEntries.splice(at < 0 ? dockEntries.length : at, 0, entry); if (el?.dock) { addDockButton(entry); paintDock(); } }
  else if (!on && has) { dockEntries = dockEntries.filter((e) => e.id !== entry.id); el?.dock?.querySelector(`button[data-toggles="${entry.id}"]`)?.remove(); getFrame(entry.id)?.hide?.(); paintDock(); }
}
const HOSTS = { settings: () => settingsFrame(), moderation: () => moderationFrame(), 'world-settings': () => worldSettingsFrame() };
export function makeSection(title, onOpen, { id = '', host: hostName = 'world' } = {}) {
  const hostFrame = (HOSTS[hostName] ?? panelFrame)();
  const box = document.createElement('div');
  box.className = 'sec';
  box.setAttribute('role', 'tabpanel');
  if (id) box.id = `sec-${id}`;
  const head = document.createElement('button');
  head.className = 'pf-tab head';
  head.setAttribute('role', 'tab');
  if (id) head.id = `sec-${id}-tab`;
  const m = title.match(/^(\S+)\s+(.*)$/);
  const glyph = m && EMOJI_ICON[m[1].replace(/️/g, '')];
  if (glyph && hasFill(glyph)) head.innerHTML = `${fsvg(glyph, 15)}<span>${m[2]}</span>`;
  else head.textContent = title;
  const label = /^[\p{L}\p{N}]/u.test(title) ? title : title.replace(/^\S+\s+/, '');   // "☀ sky" → "sky"
  head.title = label;
  head.setAttribute('aria-selected', 'false');
  head.setAttribute('aria-expanded', 'false');   // the accordion's attribute, still read
  const body = document.createElement('div');
  body.className = 'body';

  const select = (on) => {
    box.classList.toggle('open', on); head.classList.toggle('on', on);
    head.setAttribute('aria-selected', String(on)); head.setAttribute('aria-expanded', String(on));
  };
  const api = {
    box, head, body, key: id || label,
    get isOpen() { return box.classList.contains('open'); },
    async toggle(force) {
      const open = force ?? !api.isOpen;   // a tab click passes true: it CHOOSES, never folds
      if (open) {
        for (const o of hostFrame.sections) if (o !== api && o.isOpen) o.toggle(false);
        select(true);
        hostFrame.rememberTab(api.key);
        hostFrame.show();   // its ensureTab finds this tab open and leaves it be
        hostFrame.stack.scrollTop = 0;
        hostFrame.fitStrip();
        { const st = hostFrame.strip, l = head.offsetLeft - st.offsetLeft, r = l + head.offsetWidth;   // scroll the chosen tab into view
          if (l < st.scrollLeft) st.scrollLeft = l; else if (r > st.scrollLeft + st.clientWidth) st.scrollLeft = r - st.clientWidth; }
        await onOpen?.(body);
      } else select(false);
    },
    /** a mod switched off */
    remove() {
      const i = hostFrame.sections.indexOf(api); if (i >= 0) hostFrame.sections.splice(i, 1);
      head.remove(); box.remove(); unregisterSelf();
      if (api.isOpen) { select(false); hostFrame.ensureTab(); }
      hostFrame.fitStrip();
    },
  };
  head.onclick = () => api.toggle(true).catch((e) => report(title, e));
  box.append(body);
  hostFrame.strip.appendChild(head);
  hostFrame.stack.appendChild(box);
  hostFrame.sections.push(api);
  hostFrame.fitStrip();
  // a frame restored open gets its tab once this tick's registrations are in
  if (!hostFrame._tabQueued) { hostFrame._tabQueued = true; setTimeout(() => { hostFrame._tabQueued = false; hostFrame.ensureTab(); }, 0); }
  // a lantern row per section opens the panel AND the tab; its own id, so a mod sharing a built-in's label can't merge
  // into (or, on remove, delete) the built-in's row
  let actionId = `section:${hostName}:${label}`;
  for (let n = 2; getAction(actionId); n++) actionId = `section:${hostName}:${label}#${n}`;
  const unregisterSelf = registerAction({
    id: actionId, title: label, group: hostName, keywords: [hostName],
    icon: glyph ?? undefined, detail: `open the ${label} tab`,
    run: () => api.toggle(true).catch((e) => report(title, e)),
  });
  return api;
}

/** Placing a ghost wants the view: the strips stay, no tab chosen. */
export function collapseAll() {
  for (const f of [worldFrame, settingsFrameApi]) for (const x of f?.sections ?? []) if (x.isOpen) x.toggle(false);
}

// ============================================================ who's here

// 'present' lives in Chat's side pane
export { escapeHtml };   // markup.js's, the one escaper (it escapes ' too)

// ============================================================ dock
// a closed frame must be findable again

// an icon rides the rail while its window is OPEN or PINNED; pins and the layout lock live in the ∃ menu
const PINS_LS = 'ew-dock-pins';
// the auto-pin fires on the EDGE, not the level, so a manual unpin survives the next repaint
const gateWas = new Map();
let pins = new Set();
// every panel starts pinned: unpinning is the personal choice
const DEFAULT_PINS = ['search', 'profile', 'world', 'chat', 'actions', 'debug', 'settings', 'edit'];   // 'edit' too: its ownership gate still decides visibility
// the action bar's old id keys saved pins and frame state: carried once, before anything reads either; 'actions' wins
// the old id is spelled on this line only
export const ACTIONBAR_OLD_ID = 'emotes';
export function carryRenamedPanel(from, to, ls = localStorage) {
  try {
    const oldFrame = ls.getItem(`ew-frame-${from}`);
    if (oldFrame != null) { if (ls.getItem(`ew-frame-${to}`) == null) ls.setItem(`ew-frame-${to}`, oldFrame); ls.removeItem(`ew-frame-${from}`); }
    const saved = JSON.parse(ls.getItem(PINS_LS) ?? 'null');
    if (Array.isArray(saved) && saved.includes(from)) ls.setItem(PINS_LS, JSON.stringify([...new Set(saved.map((p) => (p === from ? to : p)))]));
  } catch { /* storage off: nothing saved to carry */ }
}
carryRenamedPanel(ACTIONBAR_OLD_ID, 'actions');
try { pins = new Set(JSON.parse(localStorage.getItem(PINS_LS) ?? JSON.stringify(DEFAULT_PINS))) } catch { pins = new Set(DEFAULT_PINS); }
// pin search ONCE over saved pins, then their unpin is theirs
try { if (!localStorage.getItem('ew-dock-search-seen')) { localStorage.setItem('ew-dock-search-seen', '1'); pins.add('search'); } } catch {}
const savePins = () => { try { localStorage.setItem(PINS_LS, JSON.stringify([...pins])) } catch {} };
let dockEntries = [];

const DOCKPOS_LS = 'ew-dock-pos';
// ---- mod seam: core panels are the HUD registry's built-in entries; registerPanel() gets the same door (docs/MODDING-UI.md §2)
export function registerPanel({ id, icon = 'puzzle-piece', title = id, mount,
                                w = 260, h = 200, x = 60, y = 60 }) {
  if (!id || dockEntries.some((e) => e.id === id)) return null;
  const f = makeFrame(id, { title, x, y, w, h, hidden: true });
  try { mount?.(f.body, f); } catch (err) { console.error(`[mod:${id}] mount failed`, err); }
  const entry = { id, icon };
  dockEntries.push(entry);
  addDockButton(entry);
  paintDock();
  return f;
}
if (typeof window !== 'undefined') {
  window.eido = Object.assign(window.eido ?? {}, { ui: { registerPanel } });
}

/** The rail as DATA for the VR ring: open ∪ pinned, in dock order; action entries (the wrench) stay out. */
/** The profile button wears a presence dot in its bottom-right corner. */
bus.on('presence:me', (v) => paintPresence(v));
export function paintPresence(state) {
  const b = el.dock.querySelector('button[data-toggles="profile"]');
  if (!b) return;
  b.dataset.presence = state;
  b.title = `Profile · ${state}`;
}

// one resolver for the rail AND the VR ring, or frames with id/emoji fallback glyphs draw blank discs in VR
const iconOf = (e) => e.icon ?? ID_ICON[e.id] ?? EMOJI_ICON[(e.label ?? '').replace(/\uFE0F/g, '')];
export function dockPins() {
  return dockEntries
    .filter((e) => !e.action && (pins.has(e.id) || !!getFrame(e.id)?.visible))
    .map((e) => ({ id: e.id, icon: iconOf(e), open: !!getFrame(e.id)?.visible }));
}

// how a rail entry reads as a lantern row (the rail itself shows only a glyph)
const PANEL_TITLE = { actions: 'action bar', edit: 'builder mode', debug: 'debug panel' };
const PANEL_WORDS = { world: ['catalog', 'build'], profile: ['avatar', 'presence', 'friends', 'satchel'],
  chat: ['messages', 'log', 'people'], edit: ['build', 'builder', 'edit', 'place'], settings: ['preferences', 'options'] };
function addDockButton(entry) {
  const { id, label, action } = entry;
  const icon = iconOf(entry);   // main.js labels the rail with emoji; chrome never rides emoji
  const b = document.createElement('button');
  // CSS shows the LINE glyph at rest, FILL while open (.on): a glyph swap, not a colour, reads as inactive
  if (icon && hasFill(icon)) b.innerHTML = (hasLine(icon) ? rsvg(icon, 21) : '') + fsvg(icon, 21);   // +25% glyph, same 34px button
  else b.textContent = label ?? id;
  b.title = dockTitle(entry);
  b.onclick = () => {
    if (action) { action(); paintDock(); return; }
    const f = getFrame(id);
    if (!f) return;
    f.toggle();
    paintDock();
  };
  b.dataset.toggles = id;   // NOT data-frame: that's the window's
  if (id === SEARCH_ENTRY.id) b.dataset.lanternToggle = '';   // its click closes an open lantern; the line's blur must not (commandbar.js)
  // the same act, findable by name in the lantern; a key table may merge its key in (main.js)
  if (!entry.noAction) registerAction({
    id: `panel:${id}`, title: PANEL_TITLE[id] ?? id, group: 'panels', icon, detail: 'open / close the panel',
    keywords: [id, 'panel', ...(PANEL_WORDS[id] ?? [])],
    when: action && entry.gate ? entry.gate : undefined,
    run: () => b.onclick(),
  });
  if (entry.last) b.dataset.last = '1';
  // the wrench keeps the end, the grip stays after it
  el.dock.insertBefore(b, (!entry.last && el.dock.querySelector('button[data-last]')) || el.dock.querySelector('.dock-grip'));
  return b;
}

/** Called from initDock, so the UI's own panels exist wherever the dock does. Returns the entries that lead the rail. */
function initPanels() {
  // dynamic import: a static edge closes a loop through controller.js (`pointerClaimed` read before init)
  // the dock entry is pushed now; the frames land a tick later and the dock repaints
  Promise.all([import('./profile.js'), import('./stylepanel.js'), import('./videopanel.js'), import('./capnotice.js'), import('./dropdown.js')])
    .then(([p, st, v, c, d]) => { p.initProfile(); st.initStylePanel(); v.initVideoPanel(); c.initCapNotice(); d.initDropdowns(); paintDock(); })
    .catch((e) => report('ui panels', e));
  return [{ id: 'profile', icon: 'user-circle' }];
}
// the lantern prompt (Ctrl/Cmd+K): an action entry, lit while open; no lantern row (it would open the prompt you're in)
const SEARCH_ENTRY = { id: 'search', icon: 'magnifying-glass', label: 'Search & commands', noAction: true,
  action: () => (isLanternOpen() ? closeLantern() : openLantern()), active: () => isLanternOpen() };
bus.on('lantern', () => paintDock());
// "Chat · Enter": the key is read from actions.js at paint time, so a key table merged in later shows up
const DOCK_NAME = { search: 'Search & commands', edit: 'Builder mode', moderation: 'Moderation', 'world-settings': 'World settings' };
function dockTitle(entry, suffix = '') {
  const name = DOCK_NAME[entry.id] ?? (entry.id.charAt(0).toUpperCase() + entry.id.slice(1));
  const key = entry.id === 'search' ? CHORD : getAction(`panel:${entry.id}`)?.key;
  return `${name}${key ? ` · ${key}` : ''}${suffix}`;
}
export function initDock(entries) {
  const lead = initPanels();
  // built-ins lead; a mod registered before boot keeps its entry, once
  const seen = new Set();
  dockEntries = [...lead, ...entries, ...dockEntries].filter((e) => !seen.has(e.id) && seen.add(e.id));
  // search goes in before debug, else after gestures, else ahead of the `last` entries (the sort below keeps those last)
  if (!seen.has(SEARCH_ENTRY.id)) {
    const at = dockEntries.findIndex((e) => e.id === 'debug'), after = dockEntries.findIndex((e) => e.id === 'actions');
    dockEntries.splice(at >= 0 ? at : after >= 0 ? after + 1 : dockEntries.length, 0, SEARCH_ENTRY);
  }
  // `last: true` entries (the wrench) ALWAYS close the list: edit is a MODE, read as one only apart at the end
  dockEntries.sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  el.dock.innerHTML = '';
  // ∃ leads the rail; mic/ear are separate fixed elements anchored to its live box
  el.dock.appendChild(el.hud);
  for (const entry of dockEntries) addDockButton(entry);
  // the grip exists only while arranging (CSS-gated)
  const grip = document.createElement('button');
  grip.className = 'dock-grip';
  grip.title = 'move the hotbar';
  grip.innerHTML = '<svg viewBox="0 0 24 24" width="14" height="6" fill="currentColor" aria-hidden="true"><circle cx="6" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="18" cy="12" r="1.6"/></svg>';
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const move = (ev) => {
      // LIVE snap: the rail rides its nearest edge THROUGHOUT the drag
      applyDockEdge(edgeFromPointer(ev));
      bus.emit('dock-moved');
    };
    const up = (ev) => {
      removeEventListener('pointermove', move); removeEventListener('pointerup', up);
      snapDock(ev);             // persists the final {edge, along}
    };
    addEventListener('pointermove', move); addEventListener('pointerup', up);
  });
  el.dock.appendChild(grip);
  applyDockEdge(loadDockEdge());
  addEventListener('resize', () => applyDockEdge(loadDockEdge()));
  paintDock();
  bus.on('frames', () => paintDock());
  bus.on('edit-mode', () => paintDock());   // at once, not on the 2 s poll
  // auto-pin only on the closed→open transition, so a manual unpin wins
  // the first report is a level, not an edge: rights ride the snapshot, after initDock (tools/dock-boot-test.ts)
  bus.on('your-rights', () => {
    for (const e of dockEntries) {
      if (!e.action || !e.gate) continue;
      const now = !!e.gate(), was = gateWas.get(e.id);
      gateWas.set(e.id, now);
      if (was === undefined) continue;                 // the arrival: a level
      // pins are one global key (ew-dock-pins), not per-world
      if (was === now) continue;                       // level, not edge
      // save on the edge, not only when the set changes: 'edit' is in DEFAULT_PINS, so a first grant would write nothing
      if (now) pins.add(e.id); else pins.delete(e.id);
      savePins();
    }
    paintDock();
  });
  setInterval(paintDock, 2000);   // role grants land async (module-scope timer, as above)
  initEMenu();

}

// ---- the rail lives flat on an edge. {edge, along} persisted;
// left/right = vertical (∃ on top), top/bottom = horizontal (∃ leftmost).

// touch controls own the bottom corners: a left rail taller than the column above #stick spans it despite the clamp
const STICK_RESERVE = 134 + 8;          // #stick (bottom:18 + 116) + breathing room
const DOCK_SLOT = 34 + 2;               // button + gap (index.html #dock)
function railHeight() {
  const slots = 1 + [...new Set([...pins, ...dockEntries.map((e) => e.id)])].length;   // ∃ + every rail icon
  return slots * DOCK_SLOT + 8;         // + the rail's own padding
}
/** Else the top edge is the only one clear of both thumbs. */
export function dockEdgeFitsLeft() {
  if (!document.body.classList.contains('touch')) return true;   // no thumbs, no conflict
  return railHeight() <= innerHeight - STICK_RESERVE;
}
function loadDockEdge() {
  // a deliberate drag always wins: the layout purge never clears ew-dock-pos
  try { const p = JSON.parse(localStorage.getItem(DOCKPOS_LS) || 'null'); if (p?.edge) return p; } catch {}
  return dockEdgeFitsLeft() ? { edge: 'left', along: 10 } : { edge: 'top', along: 10 };
}
function applyDockEdge({ edge, along }) {
  el.dock.dataset.edge = edge;   // CSS welds the rail to this side; mic/ear read it too
  const d = el.dock;
  const horiz = edge === 'top' || edge === 'bottom';
  d.classList.toggle('horizontal', horiz);
  // 'auto', not '': '' revives the sheet's top/left, which pair with the new side into a full-length stretch
  d.style.left = d.style.right = d.style.top = d.style.bottom = 'auto';
  const r = d.getBoundingClientRect();
  const max = horiz ? innerWidth - r.width - 4 : innerHeight - r.height - 4;
  // whole pixels: on a blur layer a fractional offset rasterizes every glyph soft
  const a = Math.round(Math.max(4, Math.min(max, along)));
  if (edge === 'left') { d.style.left = '0'; d.style.top = `${a}px`; }
  if (edge === 'right') { d.style.right = '0'; d.style.top = `${a}px`; }
  if (edge === 'top') { d.style.top = '0'; d.style.left = `${a}px`; }
  if (edge === 'bottom') { d.style.bottom = '0'; d.style.left = `${a}px`; }
  // NO resize dispatch: the resize listener calls this, so it would recurse; mic/ear re-anchor on their own
}
function edgeFromPointer(ev) {
  const d = [
    { edge: 'left', dist: ev.clientX },
    { edge: 'right', dist: innerWidth - ev.clientX },
    { edge: 'top', dist: ev.clientY },
    { edge: 'bottom', dist: innerHeight - ev.clientY },
  ].sort((a, b) => a.dist - b.dist)[0].edge;
  const vert = d === 'left' || d === 'right';
  return { edge: d, along: Math.round((vert ? ev.clientY : ev.clientX) - 21) };
}
function snapDock(ev) {
  const r = el.dock.getBoundingClientRect();
  // the POINTER picks the edge: dock-center is ambiguous near corners
  const cx = ev?.clientX ?? r.left + r.width / 2;
  const cy = ev?.clientY ?? r.top + r.height / 2;
  const d = [
    { edge: 'left', dist: cx, along: r.top },
    { edge: 'right', dist: innerWidth - cx, along: r.top },
    { edge: 'top', dist: cy, along: r.left },
    { edge: 'bottom', dist: innerHeight - cy, along: r.left },
  ].sort((a, b) => a.dist - b.dist)[0];
  const pos = { edge: d.edge, along: Math.round(d.along) };
  try { localStorage.setItem(DOCKPOS_LS, JSON.stringify(pos)) } catch {}
  applyDockEdge(pos);
}
// write a title only on change: a rewrite every 2 s would re-arm the native tooltip over the borrowed one
function setTitle(b, t) { if ((b._tip ?? b.getAttribute('title')) !== t) b.setAttribute('title', t); }
function paintDock() {
  // the rail never hides: it carries the ∃
  for (const b of el.dock.querySelectorAll('button[data-toggles]')) {
    const id = b.dataset.toggles;
    const entry = dockEntries.find((x) => x.id === id);
    if (entry?.action) {                          // the edit wrench
      // grey, not gone: hiding a gated action teaches nobody the affordance exists
      const open = entry.gate ? !!entry.gate() : true;
      b.classList.toggle('dead', !open);
      b.disabled = !open;
      // an entry may title itself by state (the wrench: "leave edit mode (B)"), else the dock's name · key
      setTitle(b, open ? (entry.title?.(!!entry.active?.()) ?? dockTitle(entry))
        : dockTitle(entry, entry.deadWhy?.() ?? ' — needs build rights in this world'));
      b.hidden = !entry.active?.() && !pins.has(id);
      // never `on` AND `dead`: .on wins at equal specificity and the pair reads as "active but broken"
      b.classList.toggle('on', open && !!entry.active?.());
      continue;
    }
    const open = !!getFrame(id)?.visible;
    if (entry && id !== 'profile') setTitle(b, dockTitle(entry));   // profile's carries its presence (paintPresence)
    b.classList.toggle('on', open);
    b.hidden = !open && !pins.has(id) && !entry?.always;
  }
  paintEMenu();
}

// ---- the ∃ menu: a File-style waterfall beside the dock; an item dismisses it only if it leaves the window
// Alt = "grab anywhere": show the hand so the convention teaches itself
addEventListener('keydown', (e) => { if (e.key === 'Alt') document.body.classList.add('altgrab'); });
addEventListener('keyup', (e) => { if (e.key === 'Alt') document.body.classList.remove('altgrab'); });
addEventListener('blur', () => document.body.classList.remove('altgrab'));

// INJECTED by main.js (net.js is above this rung); defaults are the truth with no server: no build rights, no sign-in
let menuSrc = { buildRights: () => false, loginUrl: () => null };
export function setMenuSources(src) { menuSrc = { ...menuSrc, ...src }; if (!emenuEl()?.hidden) paintEMenu(); }

// save and load are honest stubs: a world IS its append-only log, so every change is already kept (/fork copies one)
const NEEDS_RIGHTS = 'needs build rights in this world';
const SAVE_WHY = 'not yet — this world already keeps every change as it happens (its log); save points need server support. /fork <name> copies the whole world today (owner)';
const LOAD_WHY = 'not yet — restoring a saved world needs server support; a copy made with /fork is its own world (?world=<name>)';
const NO_LOGIN = 'this server has no sign-in — it admits by door key';
const AWAY_MS = 450;   // mouse-away grace: crossing to a flyout or a wobble off the edge

const emenuEl = () => document.getElementById('emenu');
const subEl = () => document.getElementById('emenu-sub');
let subFor = null;     // the open flyout's row ('panels' | 'about'), or null
let subCloseT = null;
let layoutBar = null;

// ---- HUD layout mode (index.html body.arranging): ends on Esc, a press out in the world, or its switch, never with the menu
export const isLayoutMode = () => document.body.classList.contains('arranging');
export function setLayoutMode(on) {
  document.body.classList.toggle('arranging', !!on);
  paintLayoutBar();
  paintEMenu();
}
function paintLayoutBar() {
  if (!layoutBar) return;
  layoutBar.hidden = !isLayoutMode();
  if (!layoutBar.hidden) anchorBeside(layoutBar);
}

function initEMenu() {
  el.hud.onclick = () => toggleEMenu();
  const m = emenuEl();
  let s = subEl();
  if (!s) { s = document.createElement('div'); s.id = 'emenu-sub'; s.className = 'panel'; s.hidden = true; m.after(s); }
  s.addEventListener('pointerenter', () => clearTimeout(subCloseT));
  for (const box of [m, s]) {
    box.setAttribute('role', 'menu');
    // a pin never takes focus, so an open lantern stays open
    box.addEventListener('mousedown', (e) => { if (e.target.closest?.('.mpin')) e.preventDefault(); });
  }
  layoutBar = document.createElement('div');
  layoutBar.id = 'layoutbar'; layoutBar.className = 'panel'; layoutBar.hidden = true;
  layoutBar.innerHTML = `${fsvg('arrows-out-cardinal', 14)}<span>HUD layout — drag panels, the rail's grip, the resting line</span><kbd>Esc</kbd><button class="lb-done">done</button>`;
  layoutBar.querySelector('.lb-done').onclick = () => setLayoutMode(false);
  document.body.appendChild(layoutBar);
  addEventListener('resize', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });
  bus.on('dock-moved', () => { paintLayoutBar(); if (!m.hidden) { anchorBeside(m); placeSub(); } });

  // Esc: the deepest level first (flyout, menu, layout mode); windows.js's escapeIsClaimed yields to all three
  addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (!m.hidden) { if (subFor) closeSub(); else toggleEMenu(false); }
    else if (isLayoutMode()) setLayoutMode(false);
  });
  addEventListener('pointerdown', (e) => {
    const t = e.target instanceof Element ? e.target : null;
    // a press outside the menu and the ∃ dismisses it
    if (!m.hidden && !t?.closest('#emenu, #emenu-sub, #hud')) toggleEMenu(false);
    // layout mode survives presses on ANY chrome; it ends out in the world (canvas/body)
    if (isLayoutMode() && !el.hud.contains(t)) {
      const inChrome = (t && t.closest('#emenu, #emenu-sub, #layoutbar, .frame, #dock, .panel, .hud-pop, #micbtn, #earbtn, #xrbtn, #hudstatus'))
        || resizeZoneAt(e.clientX, e.clientY);   // the grab band hangs 6px outside frames
      if (!inChrome) setLayoutMode(false);
    }
  }, true);
  // mouse-away: desktop only (a pen or finger has no hover)
  let away = null;
  const arm = () => { if (!away) away = setTimeout(() => { away = null; toggleEMenu(false); }, AWAY_MS); };
  const disarm = () => { clearTimeout(away); away = null; };
  document.addEventListener('pointermove', (e) => {
    if (m.hidden || e.pointerType !== 'mouse') return;
    if (e.target instanceof Element && e.target.closest('#emenu, #emenu-sub, #hud')) disarm(); else arm();
  }, true);
  document.addEventListener('pointerout', (e) => { if (!m.hidden && e.pointerType === 'mouse' && !e.relatedTarget) arm(); }, true);   // left the window
  m.addEventListener('pointerenter', disarm);

  // the same acts, findable by name in the lantern
  registerAction({ id: 'menu:save', title: 'save world', group: 'world', icon: 'floppy-disk', keywords: ['save', 'snapshot', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? SAVE_WHY : `save world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:load', title: 'load world', group: 'world', icon: 'folder-open', keywords: ['load', 'open', 'restore', 'world', 'file'],
    detail: 'not yet — it tells you why', run: () => toast(menuSrc.buildRights() ? LOAD_WHY : `load world — ${NEEDS_RIGHTS}`, 'info', 9000) });
  registerAction({ id: 'menu:layout', title: 'HUD layout mode', group: 'panels', icon: 'arrows-out-cardinal',
    keywords: ['layout', 'arrange', 'move', 'hud', 'panels', 'drag'], detail: 'move panels, the rail and the resting line',
    run: () => setLayoutMode(!isLayoutMode()) });
  registerAction({ id: 'menu:reset-layout', title: 'reset layout', group: 'panels', icon: 'sparkle', keywords: ['layout', 'reset', 'default', 'panels'],
    detail: 'every window back where it started', run: () => { resetHudLayout(); paintDock(); } });
  registerAction({ id: 'menu:lock', title: 'lock / unlock the layout', group: 'panels', icon: 'lock', keywords: ['layout', 'lock', 'unlock', 'panels'],
    run: () => { setLocked(!isLocked()); paintEMenu(); } });
  registerAction({ id: 'menu:keys', title: 'keys', group: 'view', icon: 'keyboard', keywords: ['keys', 'controls', 'shortcuts', 'bindings'],
    detail: 'the key table', run: () => openKeys() });
  registerAction({ id: 'menu:about', title: 'about this build', group: 'view', icon: 'info', keywords: ['about', 'version', 'build', 'sha'],
    run: () => buildInfo().then((v) => toast(`eidoverse-worlds · ${v.lines.join(' · ')}`, 'info', 9000)) });
  registerAction({ id: 'menu:login', title: 'log in / log out', group: 'view', keywords: ['login', 'logout', 'sign in', 'sign out', 'account', 'discord'],
    run: () => { const it = loginItem(); if (it.dead) toast(it.dead, 'info'); else it.run(); } });
}

export function toggleEMenu(force) {
  const m = emenuEl();
  const open = force ?? m.hidden;
  if (!open) { closeSub(); m.hidden = true; return; }
  m.hidden = false;
  paintEMenu();
  anchorBeside(m);
}
// beside the ∃, away from the rail's edge, clamped; never remembered: a dropdown hangs from what opened it
function anchorBeside(node) {
  // flush with the RAIL's box, not the glyph inside it
  const h = el.dock.getBoundingClientRect();
  const edge = el.dock.dataset.edge || 'left';
  node.style.left = node.style.top = '0px'; node.style.right = node.style.bottom = 'auto';
  const r = node.getBoundingClientRect();
  let x = h.right, y = h.top;
  if (edge === 'right') x = h.left - r.width;
  else if (edge === 'top') { x = h.left; y = h.bottom; }
  else if (edge === 'bottom') { x = h.left; y = h.top - r.height; }
  node.style.left = `${Math.round(Math.max(4, Math.min(innerWidth - r.width - 4, x)))}px`;
  node.style.top = `${Math.round(Math.max(4, Math.min(innerHeight - r.height - 4, y)))}px`;
}

// ---- the flyout: one at a time, beside its row
function openSub(id) {
  clearTimeout(subCloseT);
  const s = subEl();
  if (subFor !== id) {
    subFor = id;
    delete s.dataset.key;
    s.innerHTML = '';
    if (id === 'about') buildAbout(s); else buildPanels(s);
  }
  s.hidden = false;
  paintEMenu();
  placeSub();
}
function closeSub() {
  clearTimeout(subCloseT);
  const s = subEl();
  if (!s) return;
  subFor = null; s.hidden = true; s.innerHTML = ''; delete s.dataset.key;
  for (const r of emenuEl().querySelectorAll('.mrow.subopen')) r.classList.remove('subopen');
}
function placeSub() {
  const s = subEl(), m = emenuEl();
  if (!s || s.hidden || !subFor) return;
  const row = m.querySelector(`.mrow[data-item="${subFor}"]`);
  if (!row) return;
  const mr = m.getBoundingClientRect(), rr = row.getBoundingClientRect();
  s.style.left = s.style.top = '0px'; s.style.maxHeight = '';
  const r = s.getBoundingClientRect();
  // away from the rail; the other side when that one has no room
  const right = mr.right + 2, left = mr.left - 2 - r.width;
  const fitsR = right + r.width <= innerWidth - 4, fitsL = left >= 4;
  let x, y;
  if (fitsR || fitsL) {
    x = (el.dock.dataset.edge === 'right' ? fitsL || !fitsR : !fitsR) ? left : right;
    y = Math.max(4, Math.min(innerHeight - r.height - 4, rr.top - 6));   // its first row level with its parent row
  } else {
    // no room on either side (a phone): hang indented off its row, on the roomier side, scrolling within what's left
    // never a floor taller than the room: it pushes the last rows off-screen
    x = Math.max(4, Math.min(innerWidth - r.width - 4, mr.left + 16));
    const below = innerHeight - rr.bottom - 6, above = rr.top - 6;
    const h = Math.min(r.height, Math.max(below, above));
    y = below >= Math.min(r.height, 120) || below >= above ? rr.bottom + 2 : rr.top - 2 - h;
    s.style.maxHeight = `${Math.max(0, Math.round(h))}px`;
  }
  s.style.left = `${Math.round(x)}px`; s.style.top = `${Math.round(y)}px`;
}

// ---- rows
const fsvgOr = (name, size, fallback = 'puzzle-piece') => fsvg(name, size) || fsvg(fallback, size);
/** a top-level item: { id, icon, label, key?, detail?, sub?, dead?, away?, run? } */
function topRow(it) {
  const row = document.createElement('button');
  row.className = `mrow${it.dead ? ' dead soft' : ''}${it.sub ? ' hassub' : ''}`;
  row.dataset.item = it.id;
  row.setAttribute('role', 'menuitem');
  const tail = it.sub ? `<span class="mcaret">${fsvg('caret-right', 10)}</span>`
    : it.key ? `<kbd class="mkey">${escapeHtml(it.key)}</kbd>` : it.tag ? `<span class="mtag">${escapeHtml(it.tag)}</span>` : '';
  row.innerHTML = `${fsvgOr(it.icon, 15)}<span class="mname">${escapeHtml(it.label)}${it.detail ? ` <em class="mdetail">${escapeHtml(it.detail)}</em>` : ''}</span>${tail}`;
  if (it.dead) {
    // listed, not offered: it SAYS why on a press too (a finger or laser has no hover)
    row.setAttribute('aria-disabled', 'true');
    row.title = `${it.label} — ${it.dead}`;
    row.onclick = () => { closeSub(); toast(`${it.label} — ${it.dead}`, 'info', 9000); };
  } else if (it.sub) {
    row.setAttribute('aria-haspopup', 'menu');
    row.onclick = () => openSub(it.id);   // opens, never toggles: a hover may have just opened it
    let t = null;
    row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') { clearTimeout(t); t = setTimeout(() => openSub(it.id), 110); } });
    row.addEventListener('pointerleave', () => clearTimeout(t));
  } else {
    if (it.title) row.title = it.title;
    row.onclick = () => { closeSub(); it.run(); if (it.away) toggleEMenu(false); else paintEMenu(); };
  }
  // a plain row shuts another's flyout after a beat, cancelled on reaching it (the way there can graze the row below)
  if (!it.sub) row.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse' && subFor) { clearTimeout(subCloseT); subCloseT = setTimeout(closeSub, 250); } });
  return row;
}
function loginItem() {
  if (CONFIG.authed) return { id: 'login', icon: 'sign-out', label: 'Log out', detail: CONFIG.name, away: true, run: logOut };
  const url = menuSrc.loginUrl?.();
  if (url) return { id: 'login', icon: 'sign-in', label: 'Log in', detail: 'with Discord', away: true, run: () => { location.href = url; } };
  return { id: 'login', icon: 'sign-in', label: 'Log in', dead: NO_LOGIN };
}
async function logOut() {
  if (!confirm(`Log out of ${location.host}? You will leave "${CONFIG.world}".`)) return;
  try { await fetch('/logout', { credentials: 'same-origin' }); } catch { /* the reload below still drops the session's page */ }
  // forget ew-authed, or net.js silently logs a once-signed-in browser straight back in
  try { localStorage.removeItem('ew-authed'); } catch { /* private mode */ }
  // and where they have been; the bare path, since a reload keeps ?world= and remembers it again (#281)
  forgetRememberedWorlds();
  location.replace(location.pathname);
}
function topItems() {
  const rights = !!menuSrc.buildRights?.();
  return [
    { id: 'save', icon: 'floppy-disk', label: 'Save world', dead: rights ? SAVE_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    { id: 'load', icon: 'folder-open', label: 'Load world', dead: rights ? LOAD_WHY : NEEDS_RIGHTS, tag: rights ? 'not yet' : 'builders' },
    'sep',
    { id: 'panels', icon: 'layout', label: 'Panels', sub: true },
    // the way down to the light version, asked first; back up is the ∃ there
    { id: 'lite', icon: 'chat-circle', label: 'Lite client', title: "the lite client: chat, the action bar and who's here, with no 3D world", run: () => confirmCenter({
      title: 'Switch to the lite client?',
      body: "Chat, the action bar and who's here, with no 3D world. Useful on a slow or struggling machine. Click the \u2203 logo there to come back.",
      ok: 'Switch', cancel: 'Stay in 3D',
    }).then((yes) => { if (yes) chooseClient(true); }) },
    'sep',
    loginItem(),
    { id: 'help', icon: 'question', label: 'Help', key: 'H', away: true, run: () => toggleHelp() },
    { id: 'keys', icon: 'keyboard', label: 'Keys', away: true, run: () => openKeys() },
    { id: 'about', icon: 'info', label: 'About', sub: true },
  ];
}
const sep = () => { const s = document.createElement('div'); s.className = 'msep'; s.setAttribute('role', 'separator'); return s; };
function buildTop(m) {
  m.innerHTML = '';
  for (const it of topItems()) m.appendChild(it === 'sep' ? sep() : topRow(it));
}
const topKey = () => `${!!menuSrc.buildRights?.()}|${CONFIG.authed ? 'out' : menuSrc.loginUrl?.() ? 'in' : 'none'}`;

// Keys: the help sheet's key table (defs/ui/_help.json), opened at that table
function openKeys() {
  openOverlay(el.help);
  const h = [...el.help.querySelectorAll('h2')].find((x) => /^keys$/i.test(x.textContent.trim()));
  h?.scrollIntoView({ block: 'start' });
}
// About: what /version says this build is
let versionAsk = null;
function buildInfo() {
  versionAsk ??= fetch('/version', { cache: 'no-store' }).then((r) => r.json()).then((v) => {
    const sha = `${String(v.sha ?? '').slice(0, 7) || 'unknown'}${v.dirty === true ? ' +dirty' : ''}`;
    const when = (t) => (t && t !== 'unknown' ? new Date(t).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'unknown');
    return { sha, lines: [`build ${sha}`, `code from ${when(v.commitTime)}`, `server up since ${when(v.startedAt)}`] };
  }).catch(() => { versionAsk = null; return { sha: 'unknown', lines: ['build unknown — /version did not answer'] }; });
  return versionAsk;
}
// the projects this client is built on, their licences and sources (client/credits.html)
const CREDITS_ROW = `<div class="minfo"><a href="/credits.html" target="_blank" rel="noopener">Credits &amp; licences ↗</a></div>`;
function buildAbout(s) {
  s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div><div class="minfo dim">asking the server…</div>${CREDITS_ROW}`;
  buildInfo().then((v) => {
    if (subFor !== 'about') return;
    s.innerHTML = `<div class="minfo"><b>eidoverse-worlds</b></div>${v.lines.map((l) => `<div class="minfo">${escapeHtml(l)}</div>`).join('')}${CREDITS_ROW}`;
    placeSub();
  });
}

const emenuKey = () => dockEntries.filter((e) => !e.action || !e.gate || e.gate()).map((e) => e.id).join('|');
function paintEMenu() {
  const m = emenuEl();
  if (!m || m.hidden) return;
  if (m.dataset.key !== topKey()) { const keep = subFor; buildTop(m); m.dataset.key = topKey(); if (keep) m.querySelector(`.mrow[data-item="${keep}"]`)?.classList.add('subopen'); }
  for (const r of m.querySelectorAll('.mrow[data-item]')) r.classList.toggle('subopen', r.dataset.item === subFor);
  const s = subEl();
  if (!s || s.hidden || subFor !== 'panels') return;
  // rows are built once per entry-set; the 2s sweep only moves their state
  const key = emenuKey();
  if (s.dataset.key !== key) { buildPanels(s); s.dataset.key = key; placeSub(); }
  s.querySelector('.mrow[data-layout]')?.classList.toggle('open', isLayoutMode());
  s.querySelector('.mrow[data-layout]')?.setAttribute('aria-checked', String(isLayoutMode()));
  for (const row of s.querySelectorAll('.mrow[data-row]')) {
    const id = row.dataset.row;
    const entry = dockEntries.find((x) => x.id === id);
    const on = id === 'glyph:mic' ? micLive() : id === 'glyph:ear' ? earOn() : id === 'lantern' ? isLanternOpen()
      : entry?.action ? !!entry.active?.() : !!getFrame(id)?.visible;
    row.classList.toggle('open', on);
    // the glyph bakes its ink at build; re-stamp it when the state flips
    const glyph = id === 'glyph:mic' ? micGlyph : id === 'glyph:ear' ? earGlyph : id === 'glyph:xr' ? xrGlyph : null;
    if (glyph && row.dataset.on !== String(on)) {
      row.dataset.on = String(on);
      const g = row.querySelector('svg');
      if (g) g.outerHTML = glyph(16);
    }
  }
  for (const pin of s.querySelectorAll('.mpin[data-pin]')) {
    const id = pin.dataset.pin;
    const on = id.startsWith('glyph:') ? glyphPinned(id.slice(6)) : id === 'lantern' ? pillPinned() : pins.has(id);
    pin.classList.toggle('on', on);
    pin.setAttribute('aria-pressed', String(on));
    if (pin.disabled) continue;
    pin.title = id === 'lantern'
      ? (on ? `hide the resting line — ${CHORD} and the rail's search still open the lantern` : 'rest the line bottom-centre again')
      : id.startsWith('glyph:')
      ? (on ? `detach ${pin.dataset.nm} from the rail` : `attach ${pin.dataset.nm} to the rail`)
      : (on ? 'unpin from rail' : 'pin to rail');
  }
  const lock = s.querySelector('.mrow[data-lock]');
  const lockHtml = `${fsvg(isLocked() ? 'lock' : 'lock-open', 15)}<span class="mname">${isLocked() ? 'layout locked' : 'layout unlocked'}</span>`;
  if (lock && lock.dataset.lock !== String(isLocked())) { lock.dataset.lock = String(isLocked()); lock.innerHTML = lockHtml; }
  lock?.classList.toggle('open', isLocked());
}
/** The lantern's resting line too (it moves in layout mode); the rail's edge is NOT reset (loadDockEdge). */
export function resetHudLayout() { resetLayout(); resetPillPlace(); }
// the lantern's resting line: its row opens the lantern, its pin keeps the pill bottom-centre (commandbar.js setPillPinned)
const LANTERN_GLYPH = 'lantern';   // its own glyph, so it reads apart from the search glass
function pinButton(id, onclick) {
  const pin = document.createElement('button');
  pin.className = 'mpin'; pin.dataset.pin = id;
  pin.innerHTML = fsvg('push-pin', 13);
  if (onclick) pin.onclick = (e) => { e.stopPropagation(); onclick(); paintDock(); paintEMenu(); };
  return pin;
}
function lanternRow() {
  const row = document.createElement('button');
  row.className = 'mrow'; row.dataset.row = 'lantern'; row.dataset.lanternToggle = '';
  row.innerHTML = `${fsvg(LANTERN_GLYPH, 15)}<span class="mname">lantern</span>`;
  row.title = `the lantern — type or say anything (${CHORD}). Its pin keeps the resting line bottom-centre; unpinned, ${CHORD} and the rail's search still open it`;
  row.onclick = () => { isLanternOpen() ? closeLantern() : openLantern(); paintEMenu(); };
  row.appendChild(pinButton('lantern', () => setPillPinned(!pillPinned())));
  return row;
}
// Panels ▸: a row toggles its thing and the menu stays; its pin is whether that thing rides the rail
function buildPanels(s) {
  s.innerHTML = '';
  const lay = document.createElement('button');
  lay.className = 'mrow'; lay.dataset.layout = ''; lay.setAttribute('role', 'menuitemcheckbox');
  lay.innerHTML = `${fsvg('arrows-out-cardinal', 15)}<span class="mname">HUD layout mode</span>`;
  lay.title = 'move panels, the rail (its grip) and the lantern\'s resting line — Esc or a click out in the world ends it';
  lay.onclick = () => setLayoutMode(!isLayoutMode());
  s.appendChild(lay);
  s.appendChild(sep());
  // voice first, in the SAME glyphs as the floating pair
  const voiceRows = [['mic', 'mic', micGlyph, flipMic], ['headphones', 'ear', earGlyph, flipEar], ['VR', 'xr', xrGlyph, flipXr]];
  for (const [nm, key, glyph, flip] of voiceRows) {
    // VR: always LISTED; with no headset, greyed with an explainer and a dead pin, so an absent glyph can't be pinned
    const dead = key === 'xr' && !xrGlyphAvailable();
    const row = document.createElement('button');
    row.className = `mrow${dead ? ' dead' : ''}`; row.dataset.row = `glyph:${key}`;
    row.innerHTML = `${glyph(16)}<span class="mname">${nm}</span>`;
    if (dead) { row.disabled = true; row.title = 'no headset sensed — Chrome finds the OpenXR runtime only at browser start (chrome://restart after SteamVR is up)'; }
    else row.onclick = async () => { if (key === 'xr') toggleEMenu(false); await flip(); paintEMenu(); };   // entering VR leaves the window
    const pin = pinButton(`glyph:${key}`, dead ? null : () => setGlyphPinned(key, !glyphPinned(key)));
    pin.dataset.nm = nm;
    if (dead) { pin.disabled = true; pin.title = 'nothing to pin until a headset is sensed'; }
    row.appendChild(pin);
    s.appendChild(row);
  }
  s.appendChild(sep());
  s.appendChild(lanternRow());
  s.appendChild(sep());
  // order at paint time: registerPanel pushes later mods after initDock's sort, so `last` entries are sorted here
  const ordered = [...dockEntries].sort((a, b) => (a.last ? 1 : 0) - (b.last ? 1 : 0));
  const flipPin = (id) => () => { pins.has(id) ? pins.delete(id) : pins.add(id); savePins(); };
  for (const entry of ordered) {
    const { id, action, gate } = entry;
    const icon = iconOf(entry);
    if (action) {
      // ALWAYS a row, gated or not: a dead row is the menu's "listed, not offered"
      const open = gate ? !!gate() : true;
      const row = document.createElement('button');
      row.className = `mrow${open ? '' : ' dead'}`; row.dataset.row = id;
      if (id === SEARCH_ENTRY.id) row.dataset.lanternToggle = '';
      row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
      if (!open) { row.disabled = true; row.title = `${id} — needs build rights in this world`; }
      else row.onclick = () => { action(); paintDock(); paintEMenu(); };
      // dead row, dead pin in the handler too: CSS `pointer-events: none` stops only a hover, not assistive activation
      const pin = pinButton(id, open ? flipPin(id) : null);
      if (!open) { pin.disabled = true; pin.title = 'nothing to pin until you have build rights'; }
      row.appendChild(pin);
      s.appendChild(row);
      continue;
    }
    if (!getFrame(id)) continue;   // a caller's stale id gets no row
    const row = document.createElement('button');
    row.className = 'mrow'; row.dataset.row = id;
    row.innerHTML = `${fsvgOr(icon, 15)}<span class="mname">${escapeHtml(id)}</span>`;
    // the row's brightness IS the open state
    row.onclick = () => { const f = getFrame(id); if (!f) return; f.toggle(); paintDock(); paintEMenu(); };
    row.appendChild(pinButton(id, flipPin(id)));
    s.appendChild(row);
  }
  s.appendChild(sep());
  const lock = document.createElement('button');
  lock.className = 'mrow'; lock.dataset.lock = '';
  lock.onclick = () => { setLocked(!isLocked()); paintEMenu(); };
  s.appendChild(lock);
  const reset = document.createElement('button');
  reset.className = 'mrow'; reset.dataset.reset = '';
  reset.innerHTML = `${fsvg('sparkle', 15)}<span class="mname">reset layout</span>`;
  reset.title = 'put every window back where it started, and the lantern\'s resting line';
  reset.onclick = () => { resetHudLayout(); paintDock(); paintEMenu(); };
  s.appendChild(reset);
}

// ============================================================ overlays

const sheet = (node) => node.querySelector('.sheet');
export function openOverlay(node) { node.classList.add('open'); }
export function closeOverlay(node) { node.classList.remove('open'); }
export const isOverlayOpen = () => document.querySelector('.scrim.open') !== null;

addEventListener('keydown', (e) => {
  if (e.key !== 'Escape') return;
  const open = document.querySelector('.scrim.open');
  if (open && open.id !== 'door') closeOverlay(open); // the door must be answered
});
for (const s of [el.door, el.help]) {
  s.addEventListener('click', (e) => { if (e.target === s && s.id !== 'door') closeOverlay(s); });
}

// ---- help ------------------------------------------------------------------
// content is a def (defs/ui/_help.json), trusted markup, so a world can reword it; no baked-in fallback

export function buildHelp() {
  const paint = () => defsRegistry().then((reg) => {
    const h = reg.uiHelp;
    const s = sheet(el.help);
    s.innerHTML = `
      <button class="close-x" aria-label="close">✕</button>
      ${!h?.keys ? '<p class="sub">this world serves no help def (defs/ui/_help.json)</p>' : `
      <h1>${h.title}</h1>
      <p class="sub">${h.sub}</p>
      <h2>Keys</h2>
      <dl class="keys">${h.keys.map(([label, k]) => `<dt>${label}</dt><dd>${k}</dd>`).join('')}</dl>
      ${(h.sections ?? []).map((x) => `<h2>${x.h}</h2><p class="sub">${x.html}</p>`).join('')}`}
      <h2>Your layout</h2>
      <p class="sub">Every panel moves and resizes, and where you put it is
        remembered. <kbd>Alt</kbd>+drag moves a panel from anywhere on it. The
        🔓 in the corner locks the layout once you like it.
        <button id="help-reset" style="margin-left:6px">reset layout</button></p>`;
    s.querySelector('.close-x').onclick = () => closeOverlay(el.help);
    s.querySelector('#help-reset').onclick = () => { resetHudLayout(); closeOverlay(el.help); };
  }).catch((e) => report('help def', e));
  paint();
  bus.on('defs-updated', paint);   // edited prose reaches an open client too
}
export function toggleHelp() {
  el.help.classList.contains('open') ? closeOverlay(el.help) : openOverlay(el.help);
}

// ---- the front door --------------------------------------------------------

export function openDoor({ roster = [], needsKey = false, login = null, onEnter }) {
  const s = sheet(el.door);
  s.innerHTML = `
    <div class="fr-head"><span class="fr-title">step in — <b>${escapeHtml(CONFIG.world)}</b></span></div>
    <div class="door-body">
    ${CONFIG.authed
      ? `<p class="sub">arriving as <b>${escapeHtml(CONFIG.name)}</b> — verified via Discord</p>`
      : `<h2>name</h2><label>
      <input id="d-name" type="text" maxlength="48" spellcheck="false" value="${escapeHtml(CONFIG.name)}" placeholder="how the world will know you"></label>`}
    ${needsKey ? `<h2>door key</h2><label>
      <input id="d-key" type="password" autocomplete="off" spellcheck="false" value="${escapeHtml(CONFIG.token)}"
        placeholder="the key from your invite"></label>` : ''}
    ${needsKey && login && !CONFIG.authed ? `<p class="sub" style="margin:4px 0 0">
      no key? <a href="${escapeHtml(login)}">sign in with Discord</a> instead —
      it comes back here with the door open</p>` : ''}
    <h2>avatar</h2>
    <div class="grid dense" id="d-roster"></div>
    <button class="go" id="d-go">enter the world</button>
    <p class="sub" style="margin:12px 0 0; text-align:center">
      press <kbd>?</kbd> any time for the controls</p>
    </div>`;

  let chosen = localStorage.getItem('ew-avatar-name') || 'claude';
  const grid = s.querySelector('#d-roster');
  // the button says what you are about to do: enter as WHO, wearing WHAT
  const goBtn = s.querySelector('#d-go');
  const sayGo = () => {
    const nm = CONFIG.authed ? CONFIG.name : (s.querySelector('#d-name')?.value.trim() || '…');
    goBtn.innerHTML = `enter as <b>${escapeHtml(nm)}</b> · ${escapeHtml(chosen)}`;
  };
  s.querySelector('#d-name')?.addEventListener('input', sayGo);
  const paint = () => {
    sayGo();
    grid.innerHTML = '';
    for (const a of roster) {
      const c = document.createElement('button');
      c.className = `card panel ${a.name === chosen ? 'on' : ''}`;
      // no portrait yet: a placeholder, not a box that reads as broken
      c.innerHTML = `<img alt="" loading="lazy" src="/thumb/${encodeURIComponent(a.name)}.png">
         <div class="ph">🧍</div><span>${escapeHtml(a.name)}</span>`;
      // a JS listener, never an inline onerror= (inline handlers don't run here)
      const img = c.querySelector('img');
      img.addEventListener('error', () => { img.style.display = 'none'; c.querySelector('.ph').style.display = 'grid'; });
      c.onclick = () => { chosen = a.name; paint(); };
      grid.appendChild(c);
    }
  };
  paint();

  const go = () => {
    // a verified identity owns the name: the server would ignore an edit
    let name = CONFIG.name;
    if (!CONFIG.authed) {
      name = s.querySelector('#d-name').value.trim().slice(0, 48);
      if (!name) { s.querySelector('#d-name').focus(); return; }
      setName(name);
    }
    localStorage.setItem('ew-name-set', '1');
    if (needsKey) setToken(s.querySelector('#d-key').value.trim());
    const pick = roster.find((a) => a.name === chosen);
    if (pick) localStorage.setItem('ew-avatar-name', pick.name);
    closeOverlay(el.door);
    onEnter({ name, avatar: pick?.path, avatarName: pick?.name });
  };
  s.querySelector('#d-go').onclick = go;
  // no #d-name for a verified arrival
  s.querySelector('#d-name')?.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') go();
  });
  s.querySelector('#d-key')?.addEventListener('keydown', (e) => e.stopPropagation());

  openOverlay(el.door);
  setTimeout(() => (s.querySelector('#d-name') ?? s.querySelector('#d-go'))?.focus(), 30);
}

// Tab: the people pane (chat's side pane)
export function togglePeopleHere() {
  const f = getFrame('chat'); const wasVisible = !!f?.visible; if (f && !wasVisible) f.show();
  // ask the frame for the nodes chat.js built; never look them up by class: a trusted mod may mount markup carrying
  // the public classes (docs/MODDING-UI.md §4) into this body, and a prepended .chat-cols would win
  const cols = f?.sidePane?.('cols');
  const closed = cols?.classList.contains('side-closed');
  // Tab OPENS (defs/ui/_help.json): toggle only a closed pane, or the click closes what Tab asked to open
  if (closed) f.sidePane('tog')?.click();
}
