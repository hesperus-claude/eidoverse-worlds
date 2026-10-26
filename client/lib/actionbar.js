// The action menu. Gestures were number keys and a slash command — invisible
// unless you read the help. On a performance platform the gestures should be
// somewhere you can see them: six tiles, the gesture as content, its name, and
// the key that fires it. The tile this bar fired stays lit ~1.5 s (long enough to read). House .tile/.tiles rules
// only — no private layout here (live, 09-04: this file had been hand-rolled).

import { makeFrame, chromeCost } from './windows.js';
import { bus } from './base.js';
import { ANIM_ORDER, ANIM_ICONS } from './animnames.js';
import { escapeHtml } from './markup.js';   // names + glyphs, no engine
import { getMe } from './mybody.js';
import { registerXRPanel } from './xrpanels.js';
import { register as registerAction } from './actions.js';
import { myState, setPosture, sitHere, standUp, getPosture } from './controller.js';
const POSTURES = ['sit', 'stand', 'lie'];
// through the same flows the ring used: a nearby seat wins for sit, stand dismounts
function posture(k) {
  // the desktop body: sit runs the controller's seat search (a nearby seat wins, else sit where you stand),
  // stand leaves seat and posture. The xr:* events are for the VR entry (part 4) — no listener at this rung.
  if (k === 'sit') { sitHere(); bus.emit('xr:sit'); }
  else if (k === 'stand') { standUp(); bus.emit('xr:stand'); }
  else setPosture('lie');
}
let litAnim = null, litUntil = 0;   // net.js clears myState.anim on the first pose send, so the bar remembers its own

// emoji here are CONTENT (the gesture itself), not chrome — the fill-icon set
// has no gesture glyphs beyond a wave; the def-hydrated ANIM_ICONS table wins,
// this map is the fallback for a vocabulary that ships no icon.
const GLYPH = { wave: '👋', cheer: '🙌', dance: '💃', point: '👉', salute: '🫡', clap: '👏' };

export function initActionBar() {
  // geometry the CSS owns too: .tiles.fixed → 68px tiles, 6px gap, 8px body pad
  const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;   // 09-05 22:00: slim buttons, real gutters — must match .tiles.fixed in index.html   // glyph-only tiles; name + key are the tooltip (live, 09-04)
  const widthFor = (cols) => cols * TILE + (cols - 1) * GAP + PAD * 2 + 2;   // +2: frame edges
  const POSTURE_TILES = 3;   // sit / stand / lie lead the grid (live, 09-05) — they count toward the rows
  const rowsFor = (cols) => Math.ceil((POSTURE_TILES + ANIM_ORDER.length) / cols);
  // state.h is the body's CONTENT height (windows.js paints body.style.height; the body
  // pads 7px top+bottom on top of it) — so rows + gaps only, no pad term
  const heightFor = (cols) => rowsFor(cols) * ROW_H + (rowsFor(cols) - 1) * GAP;
  let snapT = null;
  const ALL = 9;   // 3 postures + 6 gestures: ONE bar (live 09-06 23:34: '9×1')
  const f = makeFrame('actions', {
    title: 'action bar', x: 'center', y: -10, w: widthFor(ALL), h: ROW_H,   // one row of nine across the bottom by default
      // windows.js's resize clamps at f.minW, so minW must be widthFor(1) or one column is unreachable by drag
      minW: widthFor(1), minH: ROW_H, hidden: true,   // 1..9 across — a single column is a legal shape
    // Snap to whole tiles once a drag settles; the frame owns its size, so write its state and repaint via its refs.
    onResize: (w) => { clearTimeout(snapT); snapT = setTimeout(() => snapTo(w), 180); },
  });

  const snapTo = (w) => {
    // the gesture list arrives async; snapping against an empty list clamped cols to the 3 postures and
    // SHRANK a saved 9×1 bar to 3×3 on every reload (two exported layouts: 352×32 → 124×108)
    if (!ANIM_ORDER.length) return;
    // Columns come from width; rows follow by wrapping, so height is an output, never an input
    // (windows.js onResize always passes h).
    const cols = Math.max(1, Math.min(POSTURE_TILES + ANIM_ORDER.length, Math.floor((w - PAD * 2 - 2 + GAP) / (TILE + GAP))));
    f._state.w = widthFor(cols); f._state.h = heightFor(cols);
    // through _fit, not _paint: a reflow to more rows can push the bar past the
    // bottom edge, and _paint alone skips every viewport clamp (#185 review).
    if (f._fit) f._fit(); else f._paint();
  };
  // a saved size from an older layout (or any drift) refits the moment the menu is on screen — onShow, not a
  // wrapped show(): the viewport auto-restore brings the bar back without show()
  // Only at default (!_placed): open at a width that fits the viewport; a hand-sized bar keeps its size.
  // Obstacles declare their anchor side (windows.js CHROME_ANCHOR): computed style resolves both left and right.
  const roomFor = () => {
    // the chrome sharing the bar's y-band; chromeCost() (windows.js) charges each by its declared side
    let costL = 0, costR = 0;
    // `.capnotice` is deliberately NOT here: the bar places against the dock and glyphs, then the card yields to it.
    // #hudstatus: the status chips on the ∃'s row (statuschips.js) — placed from the ∃ and its glyphs alone, so no cycle
    for (const sel of ['#dock', '#micbtn', '#earbtn', '#hudstatus']) {
      const g = document.querySelector(sel)?.getBoundingClientRect();
      if (g && g.width && g.top < 60 && g.bottom > 8) {
        const c = chromeCost(sel, g, innerWidth);
        costL = Math.max(costL, c.left); costR = Math.max(costR, c.right);
      }
    }
    const clearRight = costL;
    // Floor at one column, not a stand-down: a bar left under higher-z chrome is unpressable.
    // Not a reachability guarantee below ~48px of room.
    const room = innerWidth - 8 - Math.max(clearRight + 8, 8) - costR;   // right-anchored chrome eats from the RIGHT
    if (!Number.isFinite(room)) return null;   // keep the width rather than paint NaN
    return Math.max(widthFor(1), room);
  };
  // A hand-placed bar keeps its SIZE, but must not open under #micbtn/#earbtn/#dock: frames cap at Z_HI=25 and
  // that chrome sits higher, so a bar left there can't win by stacking.
  f.onShow(() => {
    // Re-derive, never min(state.w, room): a stored width would ratchet. Unplaced: width is the room now; placed: null.
    const room = f._placed ? null : roomFor();
    snapTo(room == null ? f._state.w : room);
    // TODO(mobile): a placed bar skips roomFor() and can reopen under the rail on a smaller viewport; local fixes
    // (narrow, slide, drop) are all worse. The fix is a layout saved per surface (windows.js LS).
  });
  const grid = document.createElement('div');
  grid.className = 'tiles fixed';
  const tiles = new Map();
  // a rebuild re-registers from scratch: register() merges and skips undefined fields,
  // so writing over the old entries would keep a moved gesture's old key and a removed one's row
  let unregs = [];
  // built from the def-hydrated vocabulary (§24l) and rebuilt when a defs
  // push re-hydrates it — icons ride the same table as the names now
  const fill = () => {
    grid.innerHTML = ''; tiles.clear();
    for (const off of unregs) off();
    unregs = [];
    // postures lead the row as tiles like the rest — EMOJI, same as the gestures
    // (live, 09-05 16:41: "STILL have phosphor icons instead of emojis"); the same
    // measured fallback: a platform without the glyph gets the word
    for (const [k, em] of [['sit', '🪑'], ['stand', '🧍'], ['lie', '🛏️']]) {
      const b = document.createElement('button');
      b.className = 'tile posture';
      b.dataset.posture = k;
      b.title = k;
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${em}</span>` : `<span class="tile-word">${k}</span>`;
      b.onclick = () => { posture(k); paint(); };
      // the stand tile held is the seat escape, as X held is (claims r10 R6: touch and phone parity; localbody.js 'escape-hold')
      if (k === 'stand') { b.onpointerdown = () => bus.emit('escape-hold', true); b.onpointerup = b.onpointerleave = b.onpointercancel = () => bus.emit('escape-hold', false); }
      grid.appendChild(b);
      tiles.set(`posture:${k}`, b);
    }
    ANIM_ORDER.forEach((name, i) => {
      const b = document.createElement('button');
      b.className = 'tile';
      b.dataset.anim = name;
      b.title = `${name} — key ${i + 1}`;
      // emoji are content here (the gesture itself) — but a platform missing the
      // glyph paints a tofu box or nothing, so the tile falls back to the word
      // when the emoji measurably does not render (live, 09-05)
      const em = ANIM_ICONS[name] ?? GLYPH[name] ?? '✨';
      b.innerHTML = emojiRenders(em) ? `<span class="tile-glyph">${escapeHtml(em)}</span>` : `<span class="tile-word">${escapeHtml(name)}</span>`;   // names and glyphs come from the world's defs: text
      b.onclick = () => { getMe()?.playOnce(name); myState.anim = name; litAnim = name; litUntil = performance.now() + 1500; paint(); };
      grid.appendChild(b);
      tiles.set(name, b);
      // the tile's own act, findable by name; number keys 1–9 follow ANIM_ORDER (main.js)
      unregs.push(registerAction({ id: `bar:${name}`, title: name, group: 'action bar', keywords: ['action', 'gesture'],
        icon: emojiRenders(em) ? em : undefined, key: i < 9 ? String(i + 1) : undefined, run: b.onclick }));
    });
    // sit and lie are keys (X, Z — controller.js registers those); standing up has no key, only this tile
    unregs.push(registerAction({ id: 'posture:stand', title: 'stand up', group: 'body', keywords: ['posture', 'get up'], icon: 'personStanding',
      run: () => { posture('stand'); paint(); } }));
    if (f._state) snapTo(f._state.w);
  };
  const paint = () => { const lit = myState.anim ?? (performance.now() < litUntil ? litAnim : null); for (const [n, b] of tiles) b.classList.toggle('on', n.startsWith('posture:') ? (myState.clip === n.slice(8) || (n === 'posture:sit' && myState.clip === 'sitchair')) : lit === n); };
  fill();
  bus.on('animnames-updated', fill);
  // (postures are tiles in the grid above — one row, one grammar)
  setInterval(paint, 500);   // number keys set myState.anim elsewhere; the lit tile follows
  f.body.appendChild(grid);
  // the same six gestures as a VR quad — one button per gesture, the same call
  registerXRPanel({
    id: 'actions', title: 'action bar',
    // postures lead (live, 09-04 22:02: sit/lie belong to the action menu, not the
    // ring); then the gestures — names, not emoji: a canvas fillText of a
    // missing glyph paints nothing
    fields: () => [...POSTURES.map((k) => ({ t: 'btn', k, label: k })), ...ANIM_ORDER.map((name) => ({ t: 'btn', k: name, label: name }))],
    dispatch: (k) => { if (POSTURES.includes(k)) posture(k); else if (ANIM_ORDER.includes(k)) { getMe()?.playOnce(k); myState.anim = k; } },
  });
  return f;
}

// Does this emoji draw? Paint it and look for chroma (tofu is gray or nothing); cached; false falls back to a word.
const emojiCache = new Map();
function emojiRenders(s) {
  if (emojiCache.has(s)) return emojiCache.get(s);
  let ok = true;
  try {
    const cv = document.createElement('canvas'); cv.width = cv.height = 24;
    const g = cv.getContext('2d');
    g.textBaseline = 'top'; g.font = '20px system-ui, "Apple Color Emoji", "Segoe UI Emoji", "Noto Color Emoji", sans-serif';
    g.fillStyle = '#000'; g.fillText(s, 0, 0);
    const d = g.getImageData(0, 0, 24, 24).data;
    let chroma = 0, ink = 0;
    for (let i = 0; i < d.length; i += 4) {
      if (d[i + 3] < 40) continue; ink++;
      const mx = Math.max(d[i], d[i + 1], d[i + 2]), mn = Math.min(d[i], d[i + 1], d[i + 2]);
      if (mx - mn > 24) chroma++;
    }
    ok = ink > 0 && chroma > 4;   // some coloured pixels = a real emoji; monochrome = tofu or a text glyph
  } catch { ok = true; }
  emojiCache.set(s, ok);
  return ok;
}

// ---- the ring's action sub-wheel ----
// Names as SVG text, not emoji (the ring paints drawn glyphs only); postures, then gestures in bar order; each closes the ring.
const nameSvg = (t) => `<svg xmlns="http://www.w3.org/2000/svg" width="52" height="52" viewBox="0 0 26 26"><text x="13" y="16" font-family="system-ui, sans-serif" font-size="${t.length > 6 ? 5.5 : 7}" font-weight="600" text-anchor="middle" fill="#f2f7f5">${t}</text></svg>`;
export function ringActionEntries() {
  return [
    ...POSTURES.map((k) => ({ svg: nameSvg(k), label: k, on: () => (k === 'lie' ? getPosture() === 'lie' : k === 'sit' ? getPosture() === 'sit' : false), close: true, act: () => posture(k) })),
    ...ANIM_ORDER.map((name) => ({ svg: nameSvg(name), label: name, close: true, act: () => { getMe()?.playOnce(name); myState.anim = name; } })),
  ];
}
