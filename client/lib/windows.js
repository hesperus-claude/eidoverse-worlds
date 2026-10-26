// frames — movable, resizable, collapsible windows with a remembered layout.
//
// In a 3D client the scene IS the content, so chrome placement is personal and per-task. The model is the MMO one:
// drag a frame by its title, drag its corner to resize, lock the layout, and have it there tomorrow.

import { bus } from './base.js';

// TODO(mobile): one saved layout serves every surface, and it should not. The key carries only the frame id, so a
// desktop arrangement is replayed onto a phone; key the record by surface class (actionbar.js show() has a symptom).
const LS = (id) => `ew-frame-${id}`;

// Layout-version guard: a frame's saved moves win over DEFAULT_LAYOUT, so when the default changes materially, bump
// this; a mismatch discards every ew-frame-* save ONCE so the new default takes.
const LAYOUT_VERSION = '2026-09-12-chrome-clearance';   // bumped: intermediate builds wrote placed:true saves
const LAYOUT_VER_KEY = 'ew-frame-layout-ver';
(() => {
  try {
    if (localStorage.getItem(LAYOUT_VER_KEY) === LAYOUT_VERSION) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ew-frame-') && k !== LAYOUT_VER_KEY) localStorage.removeItem(k);
    }
    localStorage.setItem(LAYOUT_VER_KEY, LAYOUT_VERSION);
  } catch { /* private mode / no storage — frames just use defaults, which is correct */ }
})();

const frames = new Map();

// ---- edge-resize: one document-level hit-tester for all frames -------------
// Grab band: _BAND px inside the border + _REACH px outside; the real element under the pointer wins over geometry.
const _resizables = [];
const _BAND = 4, _REACH = 6;
const _CORNER = 15;            // the corner gets its own square: two edge bands' intersection is too small to hit
/** A frame element's resize floors, {minW, minH}, or null when it is not resizable or the layout is locked — VR's
 *  panel resize (domquad.js) asks here, so a headset resizes exactly the frames the mouse can. */
export function frameResizeInfo(root) {
  if (locked) return null;
  const f = _resizables.find((r) => r.root === root);
  return f ? { minW: f.minW, minH: f.minH } : null;
}
/** Would the edge-resize hit-tester claim this point? (for ui.js's
 *  arrange-exit guard — the grab band extends _REACH px OUTSIDE frames) */
export function resizeZoneAt(x, y) {
  const fake = { clientX: x, clientY: y };
  for (const f of _resizables) {
    if (f.root.style.display === 'none' || !f.active()) continue;
    if (_zoneFor(f, fake)) return true;
  }
  return false;
}
const _CURSORS = { n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize',
  ne: 'nesw-resize', sw: 'nesw-resize', nw: 'nwse-resize', se: 'nwse-resize' };
function _zoneFor(f, e) {
  const r = f.root.getBoundingClientRect();
  const nx = e.clientX - r.left, ny = e.clientY - r.top;
  if (nx < -_REACH || ny < -_REACH || nx > r.width + _REACH || ny > r.height + _REACH) return '';
  // corners FIRST, independently of the edge bands: within 15px of a corner the grab is diagonal; _contentClaims
  // still outranks everything at the call sites
  const nearW = nx <= _CORNER, nearE = nx >= r.width - _CORNER;
  const nearN = ny <= _CORNER, nearS = ny >= r.height - _CORNER;
  if (nearN && nearW) return 'nw';
  if (nearN && nearE) return 'ne';
  if (nearS && nearW) return 'sw';
  if (nearS && nearE) return 'se';
  let z = '';
  if (ny < _BAND) z += 'n'; else if (ny > r.height - _BAND) z += 's';
  if (nx < _BAND) z += 'w'; else if (nx > r.width - _BAND) z += 'e';
  return z;
}
function _contentClaims(e) {
  // whatever really sits under the pointer: interactive content beats the grab, bare chrome doesn't. Walk Element,
  // not HTMLElement: over a glyph button the topmost thing is its SVG <path> (tools/frames-resize-test.ts)
  for (let t = document.elementFromPoint(e.clientX, e.clientY); t instanceof Element; t = t.parentElement) {
    if (['BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'A'].includes(t.tagName)) return true;
    if (!(t instanceof HTMLElement)) continue;   // an SVG part has no scrollbars of its own
    if (t.scrollHeight > t.clientHeight + 1) {
      const sbw = t.offsetWidth - t.clientWidth;
      if (sbw > 0 && e.clientX >= t.getBoundingClientRect().right - sbw - 2) return true;
    }
    if (t.scrollWidth > t.clientWidth + 1) {
      const sbh = t.offsetHeight - t.clientHeight;
      if (sbh > 0 && e.clientY >= t.getBoundingClientRect().bottom - sbh - 2) return true;
    }
    if (t.classList?.contains('frame')) break;
  }
  return false;
}
/** Is this pointer over DRAGGABLE frame chrome: not content (_contentClaims), not a cursor:pointer row, a label, or
 *  selectable text? Empty pane pixels move the pane; everything that does something keeps doing it. */
function _grabbableAt(e) {
  if (_contentClaims(e)) return false;
  for (let t = e.target; t instanceof HTMLElement; t = t.parentElement) {
    if (t.tagName === 'LABEL') return false;
    const cs = getComputedStyle(t);
    if (cs.cursor === 'pointer' || cs.cursor.endsWith('resize')) return false;   // a resize-cursor element is a HANDLE, not a grab surface (chat's pane grip moved the whole frame;)
    if ((cs.userSelect || cs.webkitUserSelect) === 'text') return false;
    if (t.classList?.contains('frame')) return true;   // reached bare chrome
  }
  return false;
}
function _hit(e) {
  const cands = _resizables.filter((f) => f.active());
  cands.sort((a, b) => (+b.root.style.zIndex || 0) - (+a.root.style.zIndex || 0));
  for (const f of cands) {
    const z = _zoneFor(f, e);
    if (z) return { f, z };
  }
  return null;
}
let _resizing = false;
document.addEventListener('pointermove', (e) => {
  if (_resizing) return;
  const h = _hit(e);
  document.body.style.cursor = (h && !_contentClaims(e)) ? _CURSORS[h.z] : '';
}, true);
document.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const h = _hit(e);
  if (!h || _contentClaims(e)) return;
  const { f, z } = h;
  e.preventDefault(); e.stopPropagation();
  f.raise();
  _resizing = true;
  const sx = e.clientX, sy = e.clientY;
  const s0 = { x: f.state.x, y: f.state.y, w: f.state.w, h: f.state.h };
  // state.h is the BODY's height; the frame renders taller by the title bar and padding, so the south clamp budgets
  // in rendered height (finish() never calls fit)
  const s0chrome = Math.max(0, (f.root.offsetHeight || 0) - s0.h);
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    // grows are clamped so no edge ever leaves the viewport
    // (windows stay inside the active area, full stop)
    if (z.includes('e')) f.state.w = clamp(s0.w + dx, f.minW, innerWidth - s0.x - 8);
    if (z.includes('s')) f.state.h = clamp(s0.h + dy, f.minH, innerHeight - s0.y - 4 - s0chrome);   // 4 px above the bottom edge, CHROME-AWARE; a drag clamps at 8 (below) — a resize may end 4 px lower; the old −40 stopped a resize 36 px short of where a drag could go (live 09-07 23:25)
    if (z.includes('w')) {
      const maxW = s0.x + s0.w - 8;                // west edge stops at x=8
      f.state.w = clamp(s0.w - dx, f.minW, maxW);
      f.state.x = s0.x + (s0.w - f.state.w);       // east side stays planted
    }
    if (z.includes('n')) {
      const maxH = s0.y + s0.h - 8;                // north edge stops at y=8
      f.state.h = clamp(s0.h - dy, f.minH, maxH);
      f.state.y = s0.y + (s0.h - f.state.h);       // south side stays planted
    }
    f.paint();
  };
  // ONE idempotent finish for every way a drag can end: a release outside the browser never sends `pointerup`, and
  // the listeners would stay installed until reload
  let captureEl = null;          // whoever ACQUIRED the capture releases it
  let done = false;
  const finish = () => {
    if (done) return;                    // idempotent: several paths may fire
    done = true;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    removeEventListener('blur', finish);
    // release on the element that ACQUIRED it. document.releasePointerCapture
    // was a no-op — Document does not own the capture, documentElement does —
    // so a blur/cancel could leave the capture live. (Review catch.)
    try {
      if (captureEl?.hasPointerCapture?.(e.pointerId)) captureEl.releasePointerCapture(e.pointerId);
    } catch { /* never captured, or gone */ }
    captureEl?.removeEventListener('lostpointercapture', finish);
    document.body.style.cursor = '';
    _resizing = false;
    // only the axes this zone moved, each with its position: the axis's viewport is stamped, so a rest x
    // left from an older viewport beside a new vw would read as docked where it never was
    f.markMoved?.((/[ew]/.test(z) ? 'xw' : '') + (/[ns]/.test(z) ? 'yh' : ''));
    f.save();                              // a resize is deliberate too

  };
  // capture keeps the stream coming outside the window (lostpointercapture is one more road to finish); the element
  // that acquired it releases it
  try {
    document.documentElement.setPointerCapture(e.pointerId);
    captureEl = document.documentElement;
    captureEl.addEventListener('lostpointercapture', finish);
  } catch { /* no capture available — the listeners below still cover it */ }
  document.addEventListener('pointermove', move, true);
  document.addEventListener('pointerup', finish, true);
  document.addEventListener('pointercancel', finish, true);
  addEventListener('blur', finish);
}, true);
// frames live in [Z_LO..Z_HI]; chrome starts at 27 (#dock) and must stay above
const Z_LO = 10, Z_HI = 25;
// builder mode's workspace (editlayout.js): its columns are fixed chrome over the frames' band
const inWorkspace = () => typeof document !== 'undefined' && document.body?.classList.contains('edit-workspace');
let zTop = Z_LO;
let warnedZ = false;
let locked = localStorage.getItem('ew-ui-locked') === '1';

const SNAP = 11;            // px — edge and frame-to-frame snapping distance
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

export function isLocked() { return locked; }
export function setLocked(v) {
  locked = v;
  localStorage.setItem('ew-ui-locked', v ? '1' : '0');
  document.body.classList.toggle('ui-locked', locked);
  bus.emit('ui-locked', locked);
}
document.body.classList.toggle('ui-locked', locked);

/**
 * @param id       stable key for the saved layout
 * @param opts     { title, x, y, w, h, minW, minH, resizable, collapsible,
 *                   closable, hidden, onResize }
 *                 x/y accept negatives to anchor from the right/bottom edge.
 */
// The newcomer's layout: hand-arranged, anchored to edges so it holds on other screens. Chat and the action bar are
// open; everything else closed but pinned to the dock. A frame's own saved state still wins; resetLayout returns HERE.
const DEFAULT_LAYOUT = {
  world:    { x: -8,  y: 8,   w: 407, h: 363, hidden: true },
  chat:     { x: 10,  y: -10, w: 545, h: 307, hidden: false },
  settings: { x: -8,  y: 381, w: 407, h: 443, hidden: true },
  profile:  { x: 48,  y: 46,  w: 505, h: 452, hidden: true },
  debug:    { x: -414, y: 8,  w: 342, h: 453, hidden: true },
  actions:  { x: 'center', y: 10, h: 32, hidden: false },  // one bar across the TOP, OPEN by default — moved from y:-10 on 2026-09-11 because the hint bar and toasts live at the bottom (owner: "all the helper notifications display at the bottom where it currently is"); the bar sizes its WIDTH itself (actionbar.js snapTo) and its ROWS from a dragged height, but ROW_H is fixed — carried here so fitsDefaults stops counting the bar as zero-height (round 4)
};
// Can this viewport hold the hand-arranged default at all? Derived from DEFAULT_LAYOUT, not a breakpoint; this is not
// a mobile special case (a 1280x720 desktop fails on height). CHROME is the title bar a body height excludes.
const ACTION_BAR_W = 352;   // widthFor(9) in actionbar.js — the bar sizes itself, so DEFAULT_LAYOUT carries no w for it
const CHROME = 26;
// The open defaults are edge-anchored on OPPOSITE corners, so they never share a column. What must fit: the widest
// open row across, and the TALLEST open panel plus the bar down (the one thing every panel shares a column with).
function fitsDefaults() {
  const open = Object.values(DEFAULT_LAYOUT).filter((d) => d.hidden === false);
  const box = (d) => (d.h ?? 0) + CHROME;
  const bar = DEFAULT_LAYOUT.actions.hidden === false ? box(DEFAULT_LAYOUT.actions) : 0;
  // WIDTH IS A ROW, NOT A FRAME: chat is anchored left and world right, so they need the SUM of their widths
  const sideBySide = open
    .filter((d) => d !== DEFAULT_LAYOUT.actions && typeof d.x === 'number')
    .reduce((sum, d) => sum + (d.w ?? 0), 0);
  // a centred strip (x:'center') is part of the row too: the bar clears a right-anchored panel only when
  // vw >= barW + 2*(worldW + M), M = 8 (the clamp's margin)

  const centredW = open.filter((d) => d.x === 'center')
    .reduce((m, d) => Math.max(m, d.w ?? ACTION_BAR_W), 0);
  const rightAnchored = Math.max(0, ...open
    .filter((d) => typeof d.x === 'number' && d.x < 0).map((d) => d.w ?? 0));
  const centredRow = centredW && rightAnchored ? centredW + 2 * (rightAnchored + 8) : 0;
  const widest = Math.max(...open.map((d) => d.w ?? 0));
  const tallest = Math.max(...open.filter((d) => d !== DEFAULT_LAYOUT.actions).map(box), 0);
  return innerWidth - 16 >= Math.max(widest, sideBySide, centredRow) && innerHeight - 16 >= tallest + bar;
}

export function makeFrame(id, opts = {}) {
  let docked = null;   // declared FIRST: paint()/fit() read it, and a let in the TDZ throws at construction
  if (frames.has(id)) return frames.get(id);
  opts = { ...opts, ...(DEFAULT_LAYOUT[id] ?? {}) };
  const {
    title = id, w = 300, h = 220, minW = 170, minH = 90,
    resizable = true, collapsible = true, closable = true,
    hidden = false, onResize = null, className = '',
  } = opts;

  const root = document.createElement('div');
  root.className = `frame panel ${className}`;
  root.dataset.frame = id;

  const head = document.createElement('div');
  head.className = 'fr-head';
  const ttl = document.createElement('span');
  ttl.className = 'fr-title';
  ttl.textContent = title;
  const btns = document.createElement('span');
  btns.className = 'fr-btns';
  head.append(ttl, btns);

  const body = document.createElement('div');
  body.className = 'fr-body';

  root.append(head, body);
  document.body.appendChild(root);

  // ---- state
  const saved = readSaved(id);
  // `moved`: don't re-anchor this frame (a rebuilt frame keeps its place). Set at drag end / resize end, never by
  // save(). Declared HERE, above api and fit(): a const in the temporal dead zone throws at construction.
    let moved = !!saved;
    // `placed`: did the OWNER place this frame (the viewport-change rule). Not !!saved: save() runs on show()/hide(),
    // so toggling a panel would exempt it forever. Persisted, written only at the deliberate acts.
    let placed = saved?.placed === true;
    // `axes`: what the deliberate act chose. A drag chooses a position, never the size
    // a squeezed window was imposing at the time (review C4); an edge-resize chooses
    // the axes its zone moved.
    const markMoved = (axes = 'xywh') => { moved = true; placed = true; state.placed = true; commitRest(axes); };
  // x:'center' re-centres only while unmoved; `moved` is live state, not the construction-time `saved`
  const state = {
    x: saved?.x ?? resolveAnchor(opts.x, w, innerWidth),
    y: saved?.y ?? resolveAnchor(opts.y, h, innerHeight),
    w: saved?.w ?? w,
    h: saved?.h ?? h,
    // a saved layout always wins; only a FIRST load on a viewport that can't hold the default opens less (chat alone,
    // it carries the composer). An edit-mode frame opens only with edit mode (its saved 'shown' was taken docked).
    hidden: /\bedit\b/.test(className) ? true : saved?.hidden ?? (hidden || (id !== 'chat' && !fitsDefaults())),
    // read back, not only written: without it an auto-hidden frame is stranded hidden after a reload
    autoHidden: saved?.autoHidden ?? false,
    underDock: saved?.underDock ?? false,   // a deliberate drop under the dock survives a reload (pre-review S1)
    // carry placed too, or the next save() erases it and a hand-sized frame reverts to auto-managed
    placed: saved?.placed === true,
  };

  // THE REST RECT: where this frame belongs and the viewport it was authored in. The displayed `state` is derived from
  // it on every viewport change and may be clamped freely; only deliberate acts (or a self-sizer) write here, else
  // clamping ratchets. save() persists THIS.
  let rest = { x: state.x, y: state.y, w: state.w, h: state.h,
    vw: saved?.vw ?? innerWidth, vh: saved?.vh ?? innerHeight };
  // Each viewport dimension is stamped only with its own axis: project() judges x/w against vw and y/h
  // against vh, so committing a width must not re-date a y the window was squeezing at the time.
  function commitRest(axes = 'xywh') {
    for (const k of axes) rest[k] = state[k];
    if (/[xw]/.test(axes)) rest.vw = innerWidth;
    if (/[yh]/.test(axes)) rest.vh = innerHeight;
  }
  // Rest -> display for the current viewport: a frame that rested against an edge of ITS authoring viewport rides that
  // edge (judged on the rest rect, never the clamped one); clamped inside afterwards by the listener and fit()
  function project() {
    const chrome = Math.max(0, (root.offsetHeight || 0) - state.h);
    let x = rest.x, y = rest.y;
    if (rest.vw - (rest.x + rest.w) <= 8 + STICKY && !(rest.x <= 8 + STICKY)) x += innerWidth - rest.vw;
    if (rest.vh - (rest.y + rest.h + chrome) <= 8 + STICKY && !(rest.y <= 8 + STICKY)) y += innerHeight - rest.vh;
    Object.assign(state, { x, y, w: rest.w, h: rest.h });
  }

  const showHooks = [];
  // Docked: the frame lives INSIDE a layout container (edit mode's columns); its floating geometry is suspended and
  // undock restores it. Not persisted: a workspace decides docking, the frame remembers only how it floats.
  const api = {
    id, el: root, body, head,
    // live refs for self-sizers that own their sizing (the action bar). _fit is here because writing _state and
    // calling _paint alone bypasses the viewport clamp
    _state: state, _paint: () => paint(), _markMoved: markMoved, _project: () => project(),
    // VR's size for this frame (domquad.js): set while staged, null to give the frame back its desktop size
    _setVrSize: (s) => { vrSize = s && Number.isFinite(s.w) && Number.isFinite(s.h) ? { w: s.w, h: s.h } : null; root.style.width = `${vrSize?.w ?? state.w}px`; body.style.height = `${vrSize?.h ?? state.h}px`; },
    get _vrSize() { return vrSize && { ...vrSize }; },
    // a self-sizer writing _state.w/h is setting the frame's size, so that is the rest size
    _fit: () => { rest.w = state.w; rest.h = state.h; fit(); },
      // READER for the same flag (#185 B1): the api carried a SETTER only, so the
      // viewport rule below had no way to ask whether the owner placed this frame.
      // `moved` is !!saved at construction and latches on a real drag or resize.
      get _moved() { return moved; },
      get _placed() { return placed; },   // B1 exemption reads THIS, not _moved
      _save: save,
    get state() { return { ...state }; },
    get docked() { return docked; },
    dock(container) {
      if (docked === container) return api;
      docked = container;
      root.classList.add('docked');
      container.appendChild(root);
      paint();
      return api;
    },
    undock() {
      if (!docked) return api;
      docked = null;
      root.classList.remove('docked');
      document.body.appendChild(root);
      paint();
      if (!state.hidden) raise();
      return api;
    },
    show() {
      state.hidden = false; state.autoHidden = false;
      paint();
      // re-project on EVERY show: a hidden frame measures 0 tall, so edge-docking and fit() missed any resize it sat
      // out. Painted first, so it is measurable now.
      if (!fitted) { fitted = true; fit(); } else { project(); fit(); }
      save(); raise(); clearColumns(); shown();
      return api;
    },
    /** run `fn` whenever the frame comes back on screen — by show(), and by the paths that un-hide it without
     *  show(): the viewport auto-restore and a reset that leaves it open. Wrapping api.show misses those. */
    onShow(fn) { showHooks.push(fn); return api; },
    _shown: () => shown(),
    hide() { state.hidden = true; state.autoHidden = false; paint(); save(); return api; },   // deliberate: never auto-restored
    toggle() { state.hidden ? api.show() : api.hide(); return api; },
    get visible() { return !state.hidden; },
    setTitle(t) { ttl.textContent = t; return api; },
    /** decorate the title bar (unread counts, status pips, …) */
    badge(html) {
      let b = head.querySelector('.fr-badge');
      // the title bar shows only while arranging; at rest the dock button carries the same badge
      const dk = document.querySelector(`#dock button[data-toggles="${id}"]`);
      let db = dk?.querySelector('.dk-badge');
      if (!html) { b?.remove(); db?.remove(); return api; }
      if (!b) { b = document.createElement('span'); b.className = 'fr-badge'; ttl.after(b); }
      b.innerHTML = html;
      if (dk) { if (!db) { db = document.createElement('span'); db.className = 'dk-badge'; dk.append(db); } db.innerHTML = html; }
      return api;
    },
    raise,
    resetLayout() {
      moved = false;                       // back under the anchors, or reset only half-works
      // ...and UNPLACE it: a reset is the deliberate act of un-placing, or the frame stays exempt from viewport management
      placed = false; state.placed = false;
      localStorage.removeItem(LS(id));
      Object.assign(state, {
        x: resolveAnchor(opts.x, w, innerWidth),
        y: resolveAnchor(opts.y, h, innerHeight),
        w, h,
        // the same rule the construction path applies: without it, reset on a phone reopened every default over chat
        hidden: hidden || (id !== 'chat' && !fitsDefaults()),
      });
      commitRest();
      // ...and through fit(), not paint() alone: paint skips every viewport clamp
      fitted = true; fit();
      paint();
      if (!state.hidden) { raise(); shown(); }
      return api;
    },
  };

  function shown() { for (const fn of showHooks) fn(); }
  function raise() {
    if (zTop >= Z_HI) {
      const order = [...frames.values()].filter((f) => f.el !== root)
        .sort((a, b) => (+a.el.style.zIndex || 0) - (+b.el.style.zIndex || 0));
      zTop = Z_LO - 1;
      for (const f of order) f.el.style.zIndex = String(++zTop);
      // more frames than the band holds: the overflow ties at Z_HI rather
      // than climbing under the dock
      if (zTop > Z_HI) {
        if (!warnedZ) { warnedZ = true; console.warn(`frames: ${order.length} frames exceed the z band [${Z_LO}..${Z_HI}]; clamping`); }
        for (const f of order) f.el.style.zIndex = String(Math.min(+f.el.style.zIndex, Z_HI));
        zTop = Z_HI;
      }
    }
    root.style.zIndex = String(Math.min(++zTop, Z_HI));
    // in builder mode the workspace columns are chrome at z 26 (editlayout.js): a floating frame raised there stacks
    // above them, below the status strip (45) and the ∃ menu (50), and drops back into the band when raised outside
    if (!docked && inWorkspace()) root.style.zIndex = String(30 + Math.min(13, zTop - Z_LO));
  }
  function clearColumns() {
    // …and opens clear of the left column (the viewport starts at --edit-left-edge), where its labels would be covered
    if (docked || !inWorkspace() || state.hidden) return;
    const edge = parseFloat(getComputedStyle(document.body).getPropertyValue('--edit-left-edge')) || 0;
    const r = root.getBoundingClientRect();
    if (edge && r.left < edge) root.style.left = `${Math.round(Math.min(edge + 8, Math.max(8, innerWidth - r.width - 8)))}px`;
  }
  // plain persistence: it does NOT latch `moved` (show()/hide() call save() too)
  function save() {
    localStorage.setItem(LS(id), JSON.stringify({ ...state, x: rest.x, y: rest.y, w: rest.w, h: rest.h, vw: rest.vw, vh: rest.vh }));
  }
  // VR's OWN size for this frame (owner, 10-02: VR and desktop layouts are separate). Set by domquad.js while the frame is
  // staged for the headset and cleared when it comes back; paint honours it, so nothing that repaints the frame
  // mid-session puts the desktop size on the VR panel. Never saved here: the desktop layout (state) is untouched.
  let vrSize = null;   // { w, h } (h: the body's height, as state.h) or null
  function paint() {
    root.style.display = state.hidden ? 'none' : 'flex';
    if (docked) {   // the container lays it out; inline geometry would fight it
      root.style.left = root.style.top = root.style.width = '';
      body.style.height = '';
      root.classList.toggle('collapsed', state.collapsed);
      if (!state.collapsed) onResize?.(root.clientWidth, body.clientHeight);
      return;
    }
    root.style.left = `${state.x}px`;
    root.style.top = `${state.y}px`;
    root.style.width = `${vrSize?.w ?? state.w}px`;
    // publish the frame's own floor: index.html's `.frame { min-width: 170px }` otherwise silently overrides a smaller minW
    root.style.minWidth = `${minW}px`;
    body.style.height = `${vrSize?.h ?? state.h}px`;
    // arrange-mode affordances: which viewport edges hold this frame (glow),
    // and whether the floating label must sit below (frame hugs the top)
    const hgt = root.offsetHeight || state.h;
    const st = stickyEdges(state, hgt);
    root.classList.toggle('st-l', st.l); root.classList.toggle('st-r', st.r);
    root.classList.toggle('st-t', st.t); root.classList.toggle('st-b', st.b);
    root.classList.toggle('label-below', state.y < 46);
    onResize?.(state.w, state.h);
  }

  // ---- buttons: name + ✕ only. (Collapse/minimize is GONE — chip, verb, state and the dblclick that
  // still fired it; live: frames 'disappearing forever' were minimized to a title bar.)
  if (closable) {
    const b = document.createElement('button');
    b.className = 'fr-btn';
    b.title = 'close';
    b.textContent = '✕';
    b.onclick = (e) => { e.stopPropagation(); api.hide(); };
    btns.appendChild(b);
  }

  // ---- dragging
  head.addEventListener('pointerdown', (e) => {
    if (locked || docked || e.target.closest('.fr-btn')) return;
    e.preventDefault();
    raise();
    root.classList.add('lifting');   // depth returns only while held
    const ox = e.clientX - state.x, oy = e.clientY - state.y;
    // capture can throw for a pointer id the browser doesn't know (synthetic
    // events, some touch stacks) — losing capture is survivable, aborting the
    // whole drag is not
    try { head.setPointerCapture(e.pointerId); } catch { /* no capture */ }
    const move = (ev) => {
      state.x = ev.clientX - ox;
      state.y = ev.clientY - oy;
      snapPosition(id, state, root.offsetHeight);
      paint();
    };
    const up = () => {
      head.removeEventListener('pointermove', move);
      head.removeEventListener('pointerup', up);
      root.classList.remove('lifting');
      // a drop that ENDS under the dock is the one deliberate way to be there (owner, 09-19: 'unless a user
      // deliberately stuck a window under the dock, there's never a situation we should allow this')
      const d = document.querySelector('#dock')?.getBoundingClientRect(), hh = root.offsetHeight;
      state.underDock = !!(d && d.width && d.left < state.x + state.w && state.x < d.right && d.top < state.y + hh && state.y < d.bottom);
      markMoved('xy'); save();             // a drag IS the deliberate act — of position
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  // Alt+drag anywhere on the frame (rescues a title bar dragged off-screen); without Alt, empty frame pixels drag when
  // unlocked, and content, pointer-cursor rows, labels, selectable text and the resize band still win
  root.addEventListener('pointermove', (e) => {
    if (locked || _resizing) { root.style.cursor = ''; return; }
    root.style.cursor = (!_hit(e) && _grabbableAt(e)) ? 'grab' : '';
  });
  root.addEventListener('pointerdown', (e) => {
    if (locked || docked || !e.isTrusted) return;                // isTrusted: our own
    if (!e.altKey && (_hit(e) || !_grabbableAt(e))) return;
    // re-dispatch below bubbles back through this capture handler — without
    // the guard it recurses to stack overflow (exposed when heads went
    // display:none and alt-drag became the only rest-state move).
    e.preventDefault(); e.stopPropagation();
    head.dispatchEvent(new PointerEvent('pointerdown', e));
  }, true);

  // ---- resizing: one module-level document listener serves every frame (below), the only way to grab OUTSIDE a
  // border without an overlay stealing its content's events
  if (resizable) _resizables.push({ root, state, minW, minH, paint, save, raise, markMoved,
    active: () => !locked && !docked && !state.hidden });

  root.addEventListener('pointerdown', raise);

  frames.set(id, api);
  paint();
  // restored frames enter through raise() too, so boot order becomes z order
  // and the first click on any of them lands above the rest
  if (!state.hidden) raise();
  // The anchor was computed from the BODY height, but a frame is also a title
  // bar and whatever padding its content carries — so a bottom-anchored frame
  // hung its composer off the screen. Measure once it exists and pull it back.
  let fitted = false;
  // a SAVED layout is fitted too (fit() only pulls a frame inside the viewport, so honouring a save doesn't conflict),
  // and seated for THIS viewport first, or a docked frame loads mid-air and jumps on the first resize
  if (saved && !state.hidden) { project(); paint(); }
  if (!state.hidden) { fitted = true; fit(); }
  addEventListener('resize', fit);

  function fit() {
    if (docked) return;                    // a docked frame is laid out by its container, not fitted
    // WIDTH FIRST, before the measurement guard below: width doesn't depend on height, and at construction the element
    // measures 0 tall, so anything behind the guard never runs on the creation path
    const maxW = Math.max(80, innerWidth - 16);
    // Re-derive width before clamping an unplaced frame: the clamp only shrinks, so one viewport's narrow width would
    // stick. Store intent, derive presentation.
    // Width only: the action bar's height is derived from its columns (actionbar.js heightFor), not declared.
    if (!placed && opts.w != null) state.w = opts.w;
    state.w = Math.max(Math.min(state.w, maxW), Math.min(minW, maxW));
    const hh = root.offsetHeight;
    if (!hh) return;                       // the constructor paints right after this call
    // SIZE BEFORE POSITION: clamping only x/y lets a wide layout run off the right edge, unreachable under
    // overflow:hidden. minW/minH are authoring floors and yield inside a viewport narrower than them.
    const chrome = hh - state.h;                       // title bar + padding: state.h is the BODY's height
    const maxH = Math.max(40, innerHeight - 16 - chrome);
    state.h = Math.max(Math.min(state.h, maxH), Math.min(minH, maxH));
    // the ANCHOR is gated on `moved`; the CLAMP below is NOT: a hand-placed frame keeps its y, an untouched one follows
    // its edge (gating the clamp too stranded bottom-anchored frames)
    if (!moved && opts.y != null && opts.y < 0) state.y = Math.max(8, innerHeight + opts.y - hh);
    state.y = clamp(state.y, 8, Math.max(8, innerHeight - hh - 8));
    // a hidden frame's negative-x (right-edge) anchor re-resolves at the CURRENT width when first shown, or it strands
    // at its creation-time x (only with no saved override)
    if (!moved && typeof opts.x === 'number' && opts.x < 0) state.x = Math.max(8, innerWidth + opts.x - state.w);
      if (opts.x === 'center' && !moved) state.x = Math.round((innerWidth - state.w) / 2);
    state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
      // default-placed frames clear the fixed chrome: frames cap at Z_HI below it, so they must sit or size clear.
      // Only once chrome has settled (the dock has buttons), or a frame dodges glyphs about to move.
      const chromeSettled = (document.querySelector('#dock')?.querySelectorAll('button[data-toggles]').length ?? 0) > 0;
      // THE DOCK IS CLEARED EVEN BY A PLACED FRAME — a saved position from an older dock geometry (or a moved
      // dock) is not a decision to sit under it; only a drop that ended there is (state.underDock, set at drag end).
      if (chromeSettled && (!placed || !state.underDock)) {
        // each obstacle is charged to the side it is welded to, via its DECLARED anchor (chromeCost)
        let clearRight = 0, clearFromRight = 0;
        // .capnotice is NOT in this list: the card steps aside for frames (capnotice.js placeTop measures its span and
        // drops below them); a frame yielding to the card as well drove the 1000×700 action bar to 313 px under the dock
        // (round 3 B1 — its declared right anchor charged a centred card as 671 px of right chrome)
        for (const sel of (placed ? ['#dock'] : ['#dock', '#micbtn', '#earbtn', '#hudstatus'])) {   // a placed frame yields to the DOCK only
          const g = document.querySelector(sel)?.getBoundingClientRect();
          if (g && g.width && g.left < state.x + state.w && state.x < g.right
              && g.top < state.y + hh && state.y < g.bottom) {
            const c = chromeCost(sel, g, innerWidth);
            clearRight = Math.max(clearRight, c.left);
            clearFromRight = Math.max(clearFromRight, c.right);
          }
        }
        if (clearRight || clearFromRight) {
          const shifted = Math.round(clearRight + 8);
          if (!clearRight) {
            // right-side chrome only: don't shift left (that slams the frame to x=8); shrink from its own right edge.
            // Not `- state.x` as well: that double-counts the frame's offset
            const avail = innerWidth - 16 - clearFromRight;
            if (avail < state.w) state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = Math.max(8, innerWidth - 8 - clearFromRight - state.w);
          } else if (shifted + state.w <= innerWidth - 8) {
            state.x = shifted;
          } else {
            // left chrome and no room beside it: take what's left of the row, floored at minW
            // (obstacles are costed by their declared side, chromeCost)
            const avail = innerWidth - 8 - shifted - clearFromRight;
            state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = shifted;
          }
          state.x = Math.max(8, Math.min(state.x, innerWidth - state.w - 8));
        }
        // ...and when sideways can't clear it, DOWN: on a phone an unplaced frame whose top meets top-row chrome
        // starts below it and gives up height to stay on screen
        if (!placed) {
          let below = 0;
          for (const sel of ['#hudstatus', '#lantern-pill', '#micbtn', '#earbtn']) {
            const el = document.querySelector(sel); const g = el?.getBoundingClientRect();
            if (!g || !g.width || getComputedStyle(el).visibility === 'hidden' || g.top > innerHeight / 3) continue;
            if (g.left < state.x + state.w && state.x < g.right && g.top < state.y + hh && state.y < g.bottom) below = Math.max(below, g.bottom);
          }
          if (below) {
            state.y = Math.round(below + 8);
            const room = innerHeight - 8 - state.y - chrome;
            if (room < state.h) state.h = Math.max(40, room);
          }
        }
      }
    paint();
  }

  return api;
}

// ── DECLARED ANCHORS ──────────────────────────────────────────────────────────
// The edge each fixed chrome is welded to. Data, not inferred: CSSOM resolves both left and right to used values, so
// the authored side can't be read back. LTR only (rtl would flip them).
const CHROME_ANCHOR = {
  '#dock':      (el) => el?.dataset.edge || 'left',    // dynamic: ui.js applyDockEdge
  '#micbtn':    (el) => el?.dataset.edge || 'left',    // hangs off the rail, follows its edge
  '#earbtn':    (el) => el?.dataset.edge || 'left',
  '.capnotice': (el) => el?.dataset.anchor || 'right', // the lite banner (lite.js)
  '#hudstatus': (el) => (el?.dataset.edge === 'right' ? 'right' : 'left'),   // statuschips.js: beside the ∃, away from its edge
};

// What a piece of chrome costs a frame, per side of the horizontal axis: LEFT-anchored → its right edge; RIGHT-anchored
// → width + its gap (never `extent - g.left`, which cancels the viewport); STRETCH → both. TOP/BOTTOM say nothing about
// the horizontal axis, so they fall through to the positional test rather than costing zero.
export function chromeCost(sel, g, extent) {
  const el = document.querySelector(sel);
  let a = CHROME_ANCHOR[sel]?.(el) ?? 'left';
  if (a === 'top' || a === 'bottom') a = (g.left + g.right) / 2 < extent / 2 ? 'left' : 'right';
  if (a === 'stretch') return { left: g.right, right: g.width + Math.max(0, extent - g.right) };
  if (a === 'right')   return { left: 0,       right: g.width + Math.max(0, extent - g.right) };
  return { left: g.right, right: 0 };
}

function resolveAnchor(v, size, extent) {
  if (v == null) return 40;
  if (v === 'center') return Math.max(8, Math.round((extent - size) / 2));
  return v < 0 ? Math.max(8, extent + v - size) : v;
}

function readSaved(id) {
  let s;
  try { s = JSON.parse(localStorage.getItem(LS(id)) ?? 'null'); } catch { return null; }
  if (!s || typeof s !== 'object') return null;
  // each unusable number falls back on its own: vw:0 read as a zero-wide authoring viewport docks the frame
  // bottom-right, and a string x paints nowhere
  for (const k of ['x', 'y', 'w', 'h', 'vw', 'vh']) {
    if (k in s && !(Number.isFinite(s[k]) && (k === 'x' || k === 'y' || s[k] > 0))) delete s[k];
  }
  return s;
}

/** Edge snapping, plus snapping to the other frames' edges — it's what makes a
 *  hand-arranged layout look deliberate instead of approximate. */
function snapPosition(id, state, height) {
  const edges = [{ x: 8 }, { x: innerWidth - state.w - 8 }, { y: 8 }, { y: innerHeight - height - 8 }];
  for (const o of frames.values()) {
    if (o.id === id || !o.visible) continue;
    const r = o.el.getBoundingClientRect();
    // neighbours snap EDGE TO EDGE — no 6 px gutter between panels (live 09-06 23:42: "directly stick edges together")
    edges.push({ x: r.left }, { x: r.right - state.w }, { x: r.right }, { x: r.left - state.w });
    edges.push({ y: r.top }, { y: r.bottom - height }, { y: r.bottom }, { y: r.top - height });
  }
  for (const e of edges) {
    if (e.x != null && Math.abs(state.x - e.x) < SNAP) state.x = e.x;
    if (e.y != null && Math.abs(state.y - e.y) < SNAP) state.y = e.y;
  }
  // fully inside the viewport, always (no more parking a window half off-screen)
  state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
  state.y = clamp(state.y, 8, Math.max(8, innerHeight - height - 8));
}

// ---- viewport-edge stickiness ----------------------------------------------
// A frame resting against a pane edge belongs to that edge: when the window
// resizes, it rides the edge instead of being stranded mid-air. Sticky edges
// glow in arrangement mode so the behavior is legible before it fires.
const STICKY = 16;
function stickyEdges(state, height) {
  return {
    l: state.x <= 8 + STICKY,
    r: innerWidth - (state.x + state.w) <= 8 + STICKY,
    t: state.y <= 8 + STICKY,
    b: innerHeight - (state.y + height) <= 8 + STICKY,
  };
}
let _lastFits = null;   // B1: the fit verdict at the last viewport change

// Ride the edges: frames sticky to right/bottom keep their edge gap when the
// window resizes; everything is then clamped back inside regardless.
addEventListener('resize', () => {
  for (const f of frames.values()) {
    const st = f._state; if (!st || f.docked) continue;   // a docked frame's box is the column's, not its own
    f._project?.();                        // from the rest rect; edge-riding lives there now
    const hgt = f.el.offsetHeight || st.h;
    st.x = clamp(st.x, 8, Math.max(8, innerWidth - st.w - 8));
    st.y = clamp(st.y, 8, Math.max(8, innerHeight - hgt - 8));
    f._paint?.();
  }
  // re-ask whether the arrangement still fits on every resize (not only at construction/reset); minimize only frames
  // the owner has NOT placed, and crossing back out re-opens them
  const fits = fitsDefaults();
  if (fits !== _lastFits) {
    for (const [id, f] of frames) {
      if (id === 'chat' || !f._state || f._placed) continue;
      // WHO hid it decides whether it comes back: `autoHidden` is set only here, cleared by a deliberate hide(), and
      // is the sole licence to auto-restore (else crossing the fit boundary reopens a panel the owner closed)
      if (!fits && !f._state.hidden) {
        f._state.hidden = true; f._state.autoHidden = true;
        f.el.style.display = 'none'; f._paint?.(); f._save?.();
      } else if (fits && f._state.hidden && f._state.autoHidden) {
        f._state.hidden = false; f._state.autoHidden = false;
        f.el.style.display = ''; f._paint?.(); f._save?.(); f._shown?.();
      }
    }
    _lastFits = fits;
  }
});

export function getFrame(id) { return frames.get(id); }
/** How much label a tab strip (.pf-tabs) can afford, decided by measuring: full labels → the chosen tab
 *  alone keeps its label (data-fit=compact) → icons only (data-fit=icons) → the strip scrolls. */
export function fitTabStrip(strip) {
  if (!strip) return;
  for (const level of ['', 'compact', 'icons']) {
    strip.dataset.fit = level;
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
  }
}
export function allFrames() { return [...frames.values()]; }
// Tab hides the whole set of open frames and brings exactly that set back, only when nothing more specific wants the
// key (an open pop, a focused field, a scrim, edit mode, a locked pointer). Esc NEVER toggles the set: it is the
// browser's way out of full screen, and closes only transient things, each in its own handler.
let panelStash = null;
// anything that owns the keys registers a claim here (build.js registers edit mode) — frames imports nobody for it,
// so the module graph stays a tree (frames → build → controller → ui → frames was a cycle)
const escClaims = [];
export function claimEscape(fn) { escClaims.push(fn); }
// Installed here, with the frames, so the binding and the help text that promises it ship together.
addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (escapeIsClaimed()) return;
  e.preventDefault();   // not the browser's focus walk
  const did = panelsToggle();
  // said, not only done: ui.js flashes "panels hidden · Tab to bring back" on the hint bar (the lantern's resting line
  // steps aside for it) — frames imports no ui, so the gesture goes out on the bus (escapeHid says what went with it)
  bus.emit('esc-quiet', did);
});
// With no panel open Tab still goes quiet (owner, 10-01: "Basically only the dock should be visible"): an empty stash
// is a quiet with nothing to reopen, so 'closed' takes the lantern's resting line away and the next Tab brings it back.
export function panelsToggle() {
  const open = [...frames.values()].filter((f) => f.visible);
  // already quiet (a panel opened since): it joins what the quiet put away, which the next Tab brings back with it
  if (open.length) { panelStash = [...new Set([...(panelStash ?? []), ...open.map((f) => f.id)])]; for (const f of open) f.hide(); return 'closed'; }
  if (panelStash) { for (const id of panelStash) frames.get(id)?.show(); panelStash = null; return 'restored'; }
  panelStash = [];
  return 'closed';
}
/** How many panels the standing Tab-quiet put away (0 = only the resting line; also 0 when not quiet). */
export const escapeHid = () => panelStash?.length ?? 0;
export function escapeIsClaimed() {
  for (const fn of escClaims) { const c = fn(); if (c) return c; }
  const a = document.activeElement;
  if (a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable)) return 'field';
  if (document.querySelector('.pf-pop, .dd-pop, .chat-gearpop:not([hidden]), #emenu:not([hidden]), #stpop:not([hidden])')) return 'pop';   // #stpop: a status chip's popover (statuschips.js)   // the gear pop lives in the DOM hidden; only a SHOWN one claims Esc
  if (document.querySelector('.scrim.open')) return 'overlay';
  if (document.body.classList.contains('arranging')) return 'layout';   // HUD layout mode: Esc ends the mode (ui.js); the panel toggle waits
  if (document.pointerLockElement) return 'pointer-lock';
  return null;
}

export function resetLayout() {
  for (const f of frames.values()) f.resetLayout();
  setLocked(false);
}
