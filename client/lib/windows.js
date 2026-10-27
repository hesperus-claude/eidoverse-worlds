// frames — movable, resizable windows with a remembered layout (the MMO model: drag, resize, lock, there tomorrow).

import { bus } from './base.js';

// TODO(mobile): the key is only the frame id, so a desktop layout replays onto a phone; key it by surface class
const LS = (id) => `ew-frame-${id}`;

// saves win over DEFAULT_LAYOUT: bump this when the default changes materially; a mismatch discards every save ONCE
const LAYOUT_VERSION = '2026-09-12-chrome-clearance';
const LAYOUT_VER_KEY = 'ew-frame-layout-ver';
(() => {
  try {
    if (localStorage.getItem(LAYOUT_VER_KEY) === LAYOUT_VERSION) return;
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.startsWith('ew-frame-') && k !== LAYOUT_VER_KEY) localStorage.removeItem(k);
    }
    localStorage.setItem(LAYOUT_VER_KEY, LAYOUT_VERSION);
  } catch { /* no storage: frames use defaults */ }
})();

const frames = new Map();

// ---- edge-resize: one document-level hit-tester for all frames -------------
// grab band: _BAND px inside the border + _REACH px outside; the real element under the pointer wins over geometry
const _resizables = [];
const _BAND = 4, _REACH = 6;
const _CORNER = 15;            // two edge bands' intersection is too small to hit
/** {minW, minH}, or null when not resizable or locked: VR's resize (domquad.js) asks here, so a headset resizes what the mouse can. */
export function frameResizeInfo(root) {
  if (locked) return null;
  const f = _resizables.find((r) => r.root === root);
  return f ? { minW: f.minW, minH: f.minH } : null;
}
/** For ui.js's arrange-exit guard: the grab band extends _REACH px OUTSIDE frames. */
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
  // corners FIRST, independent of the edge bands; _contentClaims still outranks everything at the call sites
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
  // interactive content beats the grab, bare chrome doesn't
  // walk Element, not HTMLElement: over a glyph button the topmost thing is its SVG <path> (tools/frames-resize-test.ts)
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
/** Empty pane pixels move the pane; content, cursor:pointer rows, labels and selectable text keep doing their job. */
function _grabbableAt(e) {
  if (_contentClaims(e)) return false;
  for (let t = e.target; t instanceof HTMLElement; t = t.parentElement) {
    if (t.tagName === 'LABEL') return false;
    const cs = getComputedStyle(t);
    if (cs.cursor === 'pointer' || cs.cursor.endsWith('resize')) return false;   // a resize-cursor element is a HANDLE, not a grab surface
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
  // state.h is the BODY's height: the south clamp budgets the title bar and padding too (finish() never calls fit)
  const s0chrome = Math.max(0, (f.root.offsetHeight || 0) - s0.h);
  const move = (ev) => {
    const dx = ev.clientX - sx, dy = ev.clientY - sy;
    // grows are clamped so no edge ever leaves the viewport
    if (z.includes('e')) f.state.w = clamp(s0.w + dx, f.minW, innerWidth - s0.x - 8);
    if (z.includes('s')) f.state.h = clamp(s0.h + dy, f.minH, innerHeight - s0.y - 4 - s0chrome);   // 4 px above the bottom, chrome-aware (a drag clamps at 8)
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
  // ONE idempotent finish for every ending: a release outside the browser never sends `pointerup`
  let captureEl = null;
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    document.removeEventListener('pointermove', move, true);
    document.removeEventListener('pointerup', finish, true);
    document.removeEventListener('pointercancel', finish, true);
    removeEventListener('blur', finish);
    // release on the element that ACQUIRED it: document.releasePointerCapture is a no-op (documentElement owns it)
    try {
      if (captureEl?.hasPointerCapture?.(e.pointerId)) captureEl.releasePointerCapture(e.pointerId);
    } catch { /* never captured, or gone */ }
    captureEl?.removeEventListener('lostpointercapture', finish);
    document.body.style.cursor = '';
    _resizing = false;
    // only the axes this zone moved: a stale rest x beside a new vw would read as docked where it never was
    f.markMoved?.((/[ew]/.test(z) ? 'xw' : '') + (/[ns]/.test(z) ? 'yh' : ''));
    f.save();                              // a resize is deliberate too
  };
  // capture keeps the stream coming outside the window
  try {
    document.documentElement.setPointerCapture(e.pointerId);
    captureEl = document.documentElement;
    captureEl.addEventListener('lostpointercapture', finish);
  } catch { /* no capture: the listeners below still cover it */ }
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
// the newcomer's layout, edge-anchored so it holds on other screens; a frame's save still wins, resetLayout returns HERE
const DEFAULT_LAYOUT = {
  world:    { x: -8,  y: 8,   w: 407, h: 363, hidden: true },
  chat:     { x: 10,  y: -10, w: 545, h: 307, hidden: false },
  settings: { x: -8,  y: 381, w: 407, h: 443, hidden: true },
  profile:  { x: 48,  y: 46,  w: 505, h: 452, hidden: true },
  debug:    { x: -414, y: 8,  w: 342, h: 453, hidden: true },
  actions:  { x: 'center', y: 10, h: 32, hidden: false },  // TOP: the hint bar and toasts own the bottom; width is the bar's own (actionbar.js snapTo), h is for fitsDefaults
};
// derived from DEFAULT_LAYOUT, not a breakpoint (a 1280x720 desktop fails on height); CHROME = the title bar a body h excludes
const ACTION_BAR_W = 352;   // widthFor(9) in actionbar.js
const CHROME = 26;
// open defaults sit on OPPOSITE corners: what must fit is the widest row across and the TALLEST panel plus the bar down
function fitsDefaults() {
  const open = Object.values(DEFAULT_LAYOUT).filter((d) => d.hidden === false);
  const box = (d) => (d.h ?? 0) + CHROME;
  const bar = DEFAULT_LAYOUT.actions.hidden === false ? box(DEFAULT_LAYOUT.actions) : 0;
  // WIDTH IS A ROW: left- and right-anchored panels need the SUM of their widths
  const sideBySide = open
    .filter((d) => d !== DEFAULT_LAYOUT.actions && typeof d.x === 'number')
    .reduce((sum, d) => sum + (d.w ?? 0), 0);
  // a centred strip clears a right-anchored panel only when vw >= barW + 2*(rightW + 8)
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
  let docked = null;   // declared FIRST: paint()/fit() read it (TDZ)
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
  // `moved`: don't re-anchor (a rebuilt frame keeps its place); set at drag/resize end, never by save()
  // declared HERE, above api and fit(): the TDZ throws at construction
    let moved = !!saved;
    // `placed`: the OWNER placed it (exempts it from the viewport rule); not !!saved, since show()/hide() save too
    let placed = saved?.placed === true;
    // `axes`: a drag chooses position, never the size a squeezed window imposed; a resize chooses its zone's axes
    const markMoved = (axes = 'xywh') => { moved = true; placed = true; state.placed = true; commitRest(axes); };
  // x:'center' re-centres only while unmoved; `moved` is live state, not the construction-time `saved`
  const state = {
    x: saved?.x ?? resolveAnchor(opts.x, w, innerWidth),
    y: saved?.y ?? resolveAnchor(opts.y, h, innerHeight),
    w: saved?.w ?? w,
    h: saved?.h ?? h,
    // only a FIRST load on a viewport that can't hold the default opens less (chat alone: it carries the composer)
    // an edit-mode frame opens only with edit mode (its saved 'shown' was taken docked)
    hidden: /\bedit\b/.test(className) ? true : saved?.hidden ?? (hidden || (id !== 'chat' && !fitsDefaults())),
    // read back, not only written: without it an auto-hidden frame is stranded hidden after a reload
    autoHidden: saved?.autoHidden ?? false,
    underDock: saved?.underDock ?? false,   // a deliberate drop under the dock survives a reload
    // carry placed too, or the next save() erases it and a hand-sized frame reverts to auto-managed
    placed: saved?.placed === true,
  };

  // THE REST RECT: where this frame belongs, and the viewport it was authored in; save() persists THIS
  // only deliberate acts (or a self-sizer) write it, else clamping the displayed `state` ratchets
  let rest = { x: state.x, y: state.y, w: state.w, h: state.h,
    vw: saved?.vw ?? innerWidth, vh: saved?.vh ?? innerHeight };
  // each viewport dimension stamps only its own axis: committing a width must not re-date a squeezed y
  function commitRest(axes = 'xywh') {
    for (const k of axes) rest[k] = state[k];
    if (/[xw]/.test(axes)) rest.vw = innerWidth;
    if (/[yh]/.test(axes)) rest.vh = innerHeight;
  }
  // a frame resting on an edge of ITS authoring viewport rides that edge (judged on rest, never the clamped rect)
  function project() {
    const chrome = Math.max(0, (root.offsetHeight || 0) - state.h);
    let x = rest.x, y = rest.y;
    if (rest.vw - (rest.x + rest.w) <= 8 + STICKY && !(rest.x <= 8 + STICKY)) x += innerWidth - rest.vw;
    if (rest.vh - (rest.y + rest.h + chrome) <= 8 + STICKY && !(rest.y <= 8 + STICKY)) y += innerHeight - rest.vh;
    Object.assign(state, { x, y, w: rest.w, h: rest.h });
  }

  const showHooks = [];
  // docking is not persisted: the workspace decides it, the frame remembers only how it floats
  const api = {
    id, el: root, body, head,
    // live refs for self-sizers (the action bar); use _fit, since _state + _paint alone bypass the viewport clamp
    _state: state, _paint: () => paint(), _markMoved: markMoved, _project: () => project(),
    // VR's size (domquad.js): set while staged, null gives back the desktop size
    _setVrSize: (s) => { vrSize = s && Number.isFinite(s.w) && Number.isFinite(s.h) ? { w: s.w, h: s.h } : null; root.style.width = `${vrSize?.w ?? state.w}px`; body.style.height = `${vrSize?.h ?? state.h}px`; },
    get _vrSize() { return vrSize && { ...vrSize }; },
    // a self-sizer writing _state.w/h is setting the frame's size, so that is the rest size
    _fit: () => { rest.w = state.w; rest.h = state.h; fit(); },
      get _moved() { return moved; },
      get _placed() { return placed; },   // the viewport rule's exemption reads THIS, not _moved
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
      // re-project on EVERY show: a hidden frame measures 0 tall, so it missed any resize it sat out
      if (!fitted) { fitted = true; fit(); } else { project(); fit(); }
      save(); raise(); clearColumns(); shown();
      return api;
    },
    /** Also fires on un-hides that bypass show() (viewport auto-restore, reset): wrapping api.show misses those. */
    onShow(fn) { showHooks.push(fn); return api; },
    _shown: () => shown(),
    hide() { state.hidden = true; state.autoHidden = false; paint(); save(); return api; },   // deliberate: never auto-restored
    toggle() { state.hidden ? api.show() : api.hide(); return api; },
    get visible() { return !state.hidden; },
    setTitle(t) { ttl.textContent = t; return api; },
    badge(html) {
      let b = head.querySelector('.fr-badge');
      // the title bar shows only while arranging, so the dock button carries the badge too
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
      moved = false;                       // back under the anchors
      // and UNPLACE it, or it stays exempt from viewport management
      placed = false; state.placed = false;
      localStorage.removeItem(LS(id));
      Object.assign(state, {
        x: resolveAnchor(opts.x, w, innerWidth),
        y: resolveAnchor(opts.y, h, innerHeight),
        w, h,
        // the construction rule: else reset on a phone reopens every default over chat
        hidden: hidden || (id !== 'chat' && !fitsDefaults()),
      });
      commitRest();
      // through fit(): paint skips every viewport clamp
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
      // overflow ties at Z_HI rather than climbing under the dock
      if (zTop > Z_HI) {
        if (!warnedZ) { warnedZ = true; console.warn(`frames: ${order.length} frames exceed the z band [${Z_LO}..${Z_HI}]; clamping`); }
        for (const f of order) f.el.style.zIndex = String(Math.min(+f.el.style.zIndex, Z_HI));
        zTop = Z_HI;
      }
    }
    root.style.zIndex = String(Math.min(++zTop, Z_HI));
    // builder mode: above the workspace columns (z 26, index.html .edit-col), below the status strip (45) and ∃ menu (50)
    if (!docked && inWorkspace()) root.style.zIndex = String(30 + Math.min(13, zTop - Z_LO));
  }
  function clearColumns() {
    // open clear of the left column (the viewport starts at --edit-left-edge)
    if (docked || !inWorkspace() || state.hidden) return;
    const edge = parseFloat(getComputedStyle(document.body).getPropertyValue('--edit-left-edge')) || 0;
    const r = root.getBoundingClientRect();
    if (edge && r.left < edge) root.style.left = `${Math.round(Math.min(edge + 8, Math.max(8, innerWidth - r.width - 8)))}px`;
  }
  // plain persistence: it does NOT latch `moved` (show()/hide() call save() too)
  function save() {
    localStorage.setItem(LS(id), JSON.stringify({ ...state, x: rest.x, y: rest.y, w: rest.w, h: rest.h, vw: rest.vw, vh: rest.vh }));
  }
  // VR and desktop layouts are separate: paint honours vrSize so no repaint puts the desktop size on the VR panel
  // never saved: the desktop layout (state) is untouched
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
    // else index.html's `.frame { min-width: 170px }` silently overrides a smaller minW
    root.style.minWidth = `${minW}px`;
    body.style.height = `${vrSize?.h ?? state.h}px`;
    // arrange-mode: edge glow, and the floating label below when the frame hugs the top
    const hgt = root.offsetHeight || state.h;
    const st = stickyEdges(state, hgt);
    root.classList.toggle('st-l', st.l); root.classList.toggle('st-r', st.r);
    root.classList.toggle('st-t', st.t); root.classList.toggle('st-b', st.b);
    root.classList.toggle('label-below', state.y < 46);
    onResize?.(state.w, state.h);
  }

  // ---- buttons: ✕ only (no minimize: minimized frames read as lost)
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
    // capture throws on unknown pointer ids (synthetic events, some touch stacks): lose it, never the drag
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
      // a drop that ENDS under the dock is the only way a frame may sit there
      const d = document.querySelector('#dock')?.getBoundingClientRect(), hh = root.offsetHeight;
      state.underDock = !!(d && d.width && d.left < state.x + state.w && state.x < d.right && d.top < state.y + hh && state.y < d.bottom);
      markMoved('xy'); save();             // a drag IS the deliberate act — of position
    };
    head.addEventListener('pointermove', move);
    head.addEventListener('pointerup', up);
  });
  // Alt+drag anywhere rescues a title bar dragged off-screen; without Alt only _grabbableAt pixels drag
  root.addEventListener('pointermove', (e) => {
    if (locked || _resizing) { root.style.cursor = ''; return; }
    root.style.cursor = (!_hit(e) && _grabbableAt(e)) ? 'grab' : '';
  });
  root.addEventListener('pointerdown', (e) => {
    if (locked || docked || !e.isTrusted) return;                // isTrusted: skip our own re-dispatch
    if (!e.altKey && (_hit(e) || !_grabbableAt(e))) return;
    // the re-dispatch bubbles back through this handler: without the isTrusted guard it recurses to stack overflow
    e.preventDefault(); e.stopPropagation();
    head.dispatchEvent(new PointerEvent('pointerdown', e));
  }, true);

  // ---- resizing: one document listener for every frame, the only way to grab OUTSIDE a border without an overlay
  if (resizable) _resizables.push({ root, state, minW, minH, paint, save, raise, markMoved,
    active: () => !locked && !docked && !state.hidden });

  root.addEventListener('pointerdown', raise);

  frames.set(id, api);
  paint();
  // boot order becomes z order
  if (!state.hidden) raise();
  // anchors use the BODY height: measure the real frame once it exists, or a bottom-anchored one hangs off-screen
  let fitted = false;
  // a save is seated for THIS viewport first, or an edge-riding frame loads mid-air and jumps on the first resize
  if (saved && !state.hidden) { project(); paint(); }
  if (!state.hidden) { fitted = true; fit(); }
  addEventListener('resize', fit);

  function fit() {
    if (docked) return;
    // WIDTH FIRST, before the guard below: at construction the element measures 0 tall
    const maxW = Math.max(80, innerWidth - 16);
    // re-derive an unplaced frame's width: the clamp only shrinks, so one narrow viewport would stick
    // width only: the action bar's height comes from its columns (actionbar.js heightFor)
    if (!placed && opts.w != null) state.w = opts.w;
    state.w = Math.max(Math.min(state.w, maxW), Math.min(minW, maxW));
    const hh = root.offsetHeight;
    if (!hh) return;                       // the constructor paints right after
    // SIZE BEFORE POSITION: else a wide layout runs off the right edge, unreachable under overflow:hidden
    // minW/minH are authoring floors and yield inside a smaller viewport
    const chrome = hh - state.h;                       // title bar + padding
    const maxH = Math.max(40, innerHeight - 16 - chrome);
    state.h = Math.max(Math.min(state.h, maxH), Math.min(minH, maxH));
    // the ANCHOR is gated on `moved`, the CLAMP is NOT (gating it stranded bottom-anchored frames)
    if (!moved && opts.y != null && opts.y < 0) state.y = Math.max(8, innerHeight + opts.y - hh);
    state.y = clamp(state.y, 8, Math.max(8, innerHeight - hh - 8));
    // a right-edge anchor re-resolves at the CURRENT width, or a frame first shown late strands at its creation x
    if (!moved && typeof opts.x === 'number' && opts.x < 0) state.x = Math.max(8, innerWidth + opts.x - state.w);
      if (opts.x === 'center' && !moved) state.x = Math.round((innerWidth - state.w) / 2);
    state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
      // frames cap at Z_HI below the fixed chrome, so they must sit clear of it
      // only once the dock has buttons, or a frame dodges glyphs about to move
      const chromeSettled = (document.querySelector('#dock')?.querySelectorAll('button[data-toggles]').length ?? 0) > 0;
      // EVEN A PLACED FRAME clears the dock: only a drop that ended there (state.underDock) is a decision to sit under it
      if (chromeSettled && (!placed || !state.underDock)) {
        // each obstacle is charged to its DECLARED side (chromeCost)
        let clearRight = 0, clearFromRight = 0;
        // never .capnotice: the card steps aside for frames (capnotice.js placeTop); both yielding crushes the bar
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
            // right chrome only: shrink from the right edge, never shift to x=8; no `- state.x` (double-counts)
            const avail = innerWidth - 16 - clearFromRight;
            if (avail < state.w) state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = Math.max(8, innerWidth - 8 - clearFromRight - state.w);
          } else if (shifted + state.w <= innerWidth - 8) {
            state.x = shifted;
          } else {
            // left chrome and no room beside it: take what's left of the row, floored at minW
            const avail = innerWidth - 8 - shifted - clearFromRight;
            state.w = Math.max(Math.min(avail, maxW), Math.min(minW, maxW));
            state.x = shifted;
          }
          state.x = Math.max(8, Math.min(state.x, innerWidth - state.w - 8));
        }
        // sideways can't clear it: go DOWN below top-row chrome, giving up height to stay on screen
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
// declared, not inferred: CSSOM resolves left and right to used values, so the authored side can't be read back
// LTR only (rtl would flip them)
const CHROME_ANCHOR = {
  '#dock':      (el) => el?.dataset.edge || 'left',    // dynamic: ui.js applyDockEdge
  '#micbtn':    (el) => el?.dataset.edge || 'left',    // follows the rail's edge
  '#earbtn':    (el) => el?.dataset.edge || 'left',
  '.capnotice': (el) => el?.dataset.anchor || 'right', // the lite banner (lite.js)
  '#hudstatus': (el) => (el?.dataset.edge === 'right' ? 'right' : 'left'),   // statuschips.js: beside the ∃
};

// RIGHT costs width + gap, never `extent - g.left` (it cancels the viewport)
// TOP/BOTTOM say nothing horizontal: they fall through to the positional test, never cost zero
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
  // each unusable number drops on its own: vw:0 docks the frame bottom-right, a string x paints nowhere
  for (const k of ['x', 'y', 'w', 'h', 'vw', 'vh']) {
    if (k in s && !(Number.isFinite(s[k]) && (k === 'x' || k === 'y' || s[k] > 0))) delete s[k];
  }
  return s;
}

/** Snap to viewport edges and to other frames' edges. */
function snapPosition(id, state, height) {
  const edges = [{ x: 8 }, { x: innerWidth - state.w - 8 }, { y: 8 }, { y: innerHeight - height - 8 }];
  for (const o of frames.values()) {
    if (o.id === id || !o.visible) continue;
    const r = o.el.getBoundingClientRect();
    // EDGE TO EDGE: no gutter between panels
    edges.push({ x: r.left }, { x: r.right - state.w }, { x: r.right }, { x: r.left - state.w });
    edges.push({ y: r.top }, { y: r.bottom - height }, { y: r.bottom }, { y: r.top - height });
  }
  for (const e of edges) {
    if (e.x != null && Math.abs(state.x - e.x) < SNAP) state.x = e.x;
    if (e.y != null && Math.abs(state.y - e.y) < SNAP) state.y = e.y;
  }
  // fully inside the viewport, always
  state.x = clamp(state.x, 8, Math.max(8, innerWidth - state.w - 8));
  state.y = clamp(state.y, 8, Math.max(8, innerHeight - height - 8));
}

// ---- viewport-edge stickiness ----------------------------------------------
// a frame resting on an edge rides it on resize; sticky edges glow in arrange mode so it's legible before it fires
const STICKY = 16;
function stickyEdges(state, height) {
  return {
    l: state.x <= 8 + STICKY,
    r: innerWidth - (state.x + state.w) <= 8 + STICKY,
    t: state.y <= 8 + STICKY,
    b: innerHeight - (state.y + height) <= 8 + STICKY,
  };
}
let _lastFits = null;   // the fit verdict at the last viewport change

addEventListener('resize', () => {
  for (const f of frames.values()) {
    const st = f._state; if (!st || f.docked) continue;   // a docked frame's box is the column's
    f._project?.();                        // edge-riding, from the rest rect
    const hgt = f.el.offsetHeight || st.h;
    st.x = clamp(st.x, 8, Math.max(8, innerWidth - st.w - 8));
    st.y = clamp(st.y, 8, Math.max(8, innerHeight - hgt - 8));
    f._paint?.();
  }
  // auto-hide only frames the owner has NOT placed; crossing back re-opens them
  const fits = fitsDefaults();
  if (fits !== _lastFits) {
    for (const [id, f] of frames) {
      if (id === 'chat' || !f._state || f._placed) continue;
      // `autoHidden` (set only here, cleared by hide()) is the sole licence to auto-restore a panel
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
/** Measured: full labels → the chosen tab's only (compact) → icons only → the strip scrolls. */
export function fitTabStrip(strip) {
  if (!strip) return;
  for (const level of ['', 'compact', 'icons']) {
    strip.dataset.fit = level;
    if (strip.scrollWidth <= strip.clientWidth + 1) return;
  }
}
export function allFrames() { return [...frames.values()]; }
// Tab hides the open frames and brings exactly that set back, unless something more specific claims the key
// Esc NEVER toggles the set: it is the browser's way out of full screen
let panelStash = null;
// key owners register a claim here (build.js: edit mode), so frames imports nobody and the graph stays a tree
const escClaims = [];
export function claimEscape(fn) { escClaims.push(fn); }
addEventListener('keydown', (e) => {
  if (e.key !== 'Tab' || e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
  if (escapeIsClaimed()) return;
  e.preventDefault();   // not the browser's focus walk
  const did = panelsToggle();
  // frames imports no ui: the bus carries it to ui.js's hint (escapeHid says what went)
  bus.emit('esc-quiet', did);
});
// with no panel open Tab still goes quiet: an empty stash hides the lantern's resting line until the next Tab
export function panelsToggle() {
  const open = [...frames.values()].filter((f) => f.visible);
  // already quiet (a panel opened since): it joins the stash
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
  if (document.querySelector('.pf-pop, .dd-pop, .chat-gearpop:not([hidden]), #emenu:not([hidden]), #stpop:not([hidden])')) return 'pop';   // only a SHOWN gear pop claims Esc; #stpop: statuschips.js
  if (document.querySelector('.scrim.open')) return 'overlay';
  if (document.body.classList.contains('arranging')) return 'layout';   // Esc ends HUD layout mode (ui.js) first
  if (document.pointerLockElement) return 'pointer-lock';
  return null;
}

export function resetLayout() {
  for (const f of frames.values()) f.resetLayout();
  setLocked(false);
}
