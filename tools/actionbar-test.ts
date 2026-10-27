// action bar (client/lib/actionbar.js): nine tiles, whole-tile snapping, postures that act on the desktop body AND
// announce themselves to the VR entry, and a fired tile that stays lit after net.js clears myState.anim. Drives the
// REAL module against tools/actionbar-stub.mjs recorders. `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/actionbar-test.ts`
// The product lines that would silence each block:
//   posture('sit') no longer calling sitHere          → "sit tile runs the controller seat search" goes red
//   lit tile following only myState.anim (old code)  → "fired tile stays lit after net.js clears" goes red
import { fileURLToPath } from "node:url";
import { plugin } from 'bun';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: 'actionbar-stubs',
  setup(b) {
    for (const m of ['windows', 'avatar', 'animnames', 'controller', 'mybody', 'xrpanels', 'base']) {
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: here('./actionbar-stub.mjs') }));
    }
  },
});
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();

// emojiRenders paints on a scratch canvas: coloured pixels = a real glyph
HTMLCanvasElement.prototype.getContext = function () {
  return { fillText() {}, getImageData: () => ({ data: new Uint8ClampedArray(24 * 24 * 4).fill(200) }) } as any;
};
// the bar repaints on a 500 ms interval: capture the painter so the test drives it
const intervals: Function[] = [];
const _setInterval = globalThis.setInterval;
(globalThis as any).setInterval = (fn: Function, ms: number, ...a: any[]) => { intervals.push(fn); return _setInterval(() => {}, 1e9, ...a); };
// a controllable clock for the 1.5 s lit window
let nowMs = 10_000;
performance.now = () => nowMs;

const stub = await import('./actionbar-stub.mjs');
const { initActionBar, ringActionEntries } = await import('../client/lib/actionbar.js');
const { ANIM_ORDER, myState, postureCalls, busLog, played, xrPanels, bus } = stub;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const sleep = (ms: number) => new Promise((r) => _setInterval(r, ms));  // one-shot: never cleared, harmless
// the bar's own column math, mirrored so the expectations are numbers, not calls
const TILE = 32, GAP = 6, PAD = 7, ROW_H = 32;
const widthFor = (c: number) => c * TILE + (c - 1) * GAP + PAD * 2 + 2;
const heightFor = (c: number, n = 9) => Math.ceil(n / c) * ROW_H + (Math.ceil(n / c) - 1) * GAP;

const f = initActionBar();
const paint = intervals.find((fn) => typeof fn === 'function')!;
const tile = (sel: string) => f.body.querySelector(sel) as HTMLButtonElement;
const tiles = () => [...f.body.querySelectorAll('.tile')] as HTMLButtonElement[];

console.log('ACTIONBAR — nine tiles, one row');
check('3 posture tiles + 6 action tiles = 9', tiles().length === 9, `${tiles().length}`);
check('postures lead, in sit/stand/lie order', tiles().slice(0, 3).map((t) => t.dataset.posture).join() === 'sit,stand,lie');
check('gestures follow in ANIM_ORDER with their number key', tiles().slice(3).every((t, i) => t.dataset.anim === ANIM_ORDER[i] && t.title === `${ANIM_ORDER[i]} — key ${i + 1}`));
// minW is widthFor(1), not widthFor(3): a resize clamps at f.minW, so a 3-column floor made one column undraggable;
// the 3-column floor still applies on snapTo's width-only path
check('default frame is 9×1: w=widthFor(9)=352, h=ROW_H, minW=widthFor(1) so 1 column is draggable', f.opts.w === 352 && f.opts.w === widthFor(9) && f.opts.h === ROW_H && f.opts.minW === widthFor(1), JSON.stringify(f.opts));
check('an XR panel registers with 3 postures + 6 gestures', xrPanels.length === 1 && xrPanels[0].fields().map((x: any) => x.k).join() === 'sit,stand,lie,' + ANIM_ORDER.join());

console.log('ACTIONBAR — B2: a clamp that cannot help stands down (antra-tess #185)');
{
  // the discriminator is the row count, not width (snapTo floors columns); drives roomFor() via f.show(). #dock/#micbtn/
  // #earbtn rects are measured (Chromium 1280x720); `.capnotice [930..1270] top 8` and the 1141px dock are synthetic
  const mk = (sel: string, l: number, r: number, t: number, b: number, ds?: Record<string, string>) => {
    const el = document.createElement('div');
    if (sel.startsWith('#')) el.id = sel.slice(1); else el.className = sel.slice(1);
    // chromeCost() reads the DECLARED anchor (default 'right'): a card standing in for its STRETCHED state says so, via the
    // attribute capnotice.js sets from the CSS breakpoint
    if (ds) Object.assign(el.dataset, ds);
    (el as any).getBoundingClientRect = () => ({ left: l, right: r, top: t, bottom: b, width: r - l, height: b - t, x: l, y: t });
    document.body.append(el); return el;
  };
  const vw0 = innerWidth;
  (window as any).innerWidth = 1280;
  const made = [mk('#dock', 0, 42, 10, 304), mk('#micbtn', 44, 70, 18, 44), mk('#earbtn', 76, 102, 18, 44)];

  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('left-anchored chrome alone leaves the bar 9-across in ONE row',
    f._state.w === 352 && f._state.h === ROW_H, `w=${f._state.w} h=${f._state.h}`);

  // force the defect: a right-anchored element in the bar's y-band; raw room = -6, floored to widthFor(1) = ONE column,
  // h=336, which IS the flip
  made.push(mk('.capnotice', 930, 1270, 8, 43));
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  // unbound on purpose (removing each leaves the suite green): roomFor's widthFor(1) floor and isFinite guard, the
  // obstacle loop's `g.width` guard, clearRight over-clamping. Don't infer coverage from this block.

  // room 123: too small for the 352px default, big enough for a bar; unclamped it paints under #micbtn/#earbtn, whose
  // z-index beats any frame
  document.body.innerHTML = '';
  const narrow = mk('#dock', 0, 1141, 10, 304);
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a narrow-but-usable room clamps the bar INTO it, never leaves it under chrome',
    f._state.w <= 123, `w=${f._state.w} vs room=123 — a wider bar paints under the chrome`);
  narrow.remove();
  for (const el of made) document.body.append(el);

  // band filter: only chrome sharing the bar's row (`g.top < 60 && g.bottom > 8`) constrains it; #dock is left-anchored,
  // so at vw 640 a [0..304] rail binds (at 1280 none can)
  document.body.innerHTML = '';
  (window as any).innerWidth = 640;
  const rail = mk('#dock', 0, 304, 389, 424, { edge: 'left' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('chrome BELOW the bar row is ignored — a rail at top:389 takes no width',
    f._state.w === 352, `w=${f._state.w} — a band filter that does not filter would clamp to 320`);
  (rail as any).getBoundingClientRect = () => ({ left: 0, right: 304, top: 10, bottom: 42, width: 304, height: 32, x: 0, y: 10 });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  // a contract, not a pixel: room 320, but snapTo quantises to whole tiles (widthFor(8)=314)
  check('...and the same rail INSIDE the row does consume it',
    f._state.w < 352 && f._state.w >= 48, `w=${f._state.w} — expected a snapped width under 352 (room here is 320)`);
  rail.remove();

  // the bar sizes first; .capnotice places itself from the bar and is NOT in roomFor()'s obstacles (mutual measurement
  // has no fixed point)
  document.body.innerHTML = '';
  (window as any).innerWidth = 390;
  const card = mk('.capnotice', 50, 382, 10, 45, { anchor: 'stretch' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a stretched .capnotice in the bar row leaves the bar alone — the card yields, not the bar',
    f._state.w === 352, `w=${f._state.w} — the card is back in roomFor()'s obstacle list; the cycle is back with it`);
  card.remove();

  // binds chromeCost(): dataset.edge can make any rail right-anchored at runtime. At 1280, rail [1238..1280]: anchor-aware
  // → room 1222 (keeps 352); bare g.right → -16 (floors to 48)
  document.body.innerHTML = '';
  (window as any).innerWidth = 1280;
  const rightRail = mk('#dock', 1238, 1280, 10, 42, { edge: 'right' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a RIGHT-docked rail does not eat the bar from the left',
    f._state.w === 352, `w=${f._state.w} — charging its g.right to the left gives room -16 and floors the bar to one column`);
  rightRail.remove();
  (window as any).innerWidth = 1280;

  // binds anchor-awareness: bare g.right gives clearRight=1270, room=-6 (floors to 48); anchor-aware costR=330, room=934 (keeps 352)
  document.body.innerHTML = '';
  const rightCard = mk('.capnotice', 950, 1270, 10, 45, { anchor: 'right' });
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = false; f.show();
  check('a RIGHT-anchored card in the row does not eat the bar from the left',
    f._state.w === 352, `w=${f._state.w} — charging its g.right to the left gives room -6 and floors the bar to 48`);
  rightCard.remove();
  // remove only what this block added; the suite relies on the stub holding f.body by reference
  for (const el of [...document.body.children]) if (!made.includes(el as any) && el !== f.el) el.remove();
  for (const el of made) if (!el.isConnected) document.body.append(el);

  // never-widen applies only to a PLACED bar (_placed: drag or resize); an unplaced bar's derived width must recover
  document.body.innerHTML = '';
  mk('#dock', 0, 42, 10, 304);
  f._state.w = widthFor(2); f._state.h = heightFor(2); (f as any)._placed = true; f.show();
  check('a bar the owner PLACED is never widened to fill the room available',
    f._state.w === widthFor(2), `w=${f._state.w} — a deliberate 2-across was inflated`);
  f._state.w = widthFor(2); f._state.h = heightFor(2); (f as any)._placed = false; f.show();
  check('...but an UNPLACED bar re-derives, so a width a bug wrote can recover',
    f._state.w === widthFor(9), `w=${f._state.w} — min(saved, room) ratchets: the phone opened 9 tiles in a 48px column`);
  for (const el of [...document.body.children]) if (el !== f.el) el.remove();
  for (const el of made) if (!el.isConnected) document.body.append(el);

  // a hand-placed bar is never measured against chrome at all
  f._state.w = 352; f._state.h = ROW_H; (f as any)._placed = true; f.show();
  check('a hand-placed bar is exempt from the clamp with the obstacle present',
    f._state.w === 352 && f._state.h === ROW_H, `w=${f._state.w} h=${f._state.h}`);

  for (const el of made) el.remove();
  (window as any).innerWidth = vw0;
}

console.log('ACTIONBAR — snapTo / widthFor / heightFor');
f.opts.onResize(200); await sleep(230);
check('a 200px drag snaps to 5 columns: w=200, h=2 rows', f._state.w === widthFor(5) && f._state.h === heightFor(5) && f.paints > 0, `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(10); await sleep(230);
check('a 10px drag floors at ONE column, wrapping to 9 rows', f._state.w === widthFor(1) && f._state.h === heightFor(1), `w=${f._state.w} h=${f._state.h}`);
// vertical by wrapping: columns from the dragged width, rows follow; height is never an input (windows.js always passes one)
f.opts.onResize(48); await sleep(230);
check('a 1-column drag wraps to 9 rows (R: "1 wide 9 tall")',
  f._state.w === widthFor(1) && f._state.h === heightFor(1), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(86); await sleep(230);
check('2 columns wrap to 5 rows', f._state.w === widthFor(2) && f._state.h === heightFor(2), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(162); await sleep(230);
check('4 columns wrap to 3 rows — a narrow drag is never floored at nine',
  f._state.w === widthFor(4) && f._state.h === heightFor(4), `w=${f._state.w} h=${f._state.h}`);
f.opts.onResize(2000); await sleep(230);
check('never more columns than tiles: back to 9×1', f._state.w === 352 && f._state.h === 32, `w=${f._state.w} h=${f._state.h}`);
f.show();
check('show() refits the saved size (still 9×1)', f.visible && f._state.w === 352 && f._state.h === 32);
{ // the vocabulary arrives async: an empty list must not shrink a saved 9×1 bar to 3×3
  const saved = ANIM_ORDER.splice(0);
  bus.emit('animnames-updated');
  check('empty ANIM_ORDER rebuilds to the 3 posture tiles only', tiles().length === 3, `${tiles().length}`);
  check('…and does NOT snap the frame down (352×32 stays)', f._state.w === 352 && f._state.h === 32, `w=${f._state.w} h=${f._state.h}`);
  ANIM_ORDER.push(...saved); bus.emit('animnames-updated');
  check('the hydrated list rebuilds nine tiles', tiles().length === 9); }

console.log('ACTIONBAR — posture tiles act on the body AND announce to VR');
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=sit]').onclick!(new Event('click'));
check('sit tile runs the controller seat search: sitHere()', postureCalls.length === 1 && postureCalls[0] === 'sitHere', JSON.stringify(postureCalls));
check('sit tile emits xr:sit', busLog.includes('xr:sit'), JSON.stringify(busLog));
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=stand]').onclick!(new Event('click'));
check('stand tile leaves seat and posture: standUp()', postureCalls.length === 1 && postureCalls[0] === 'standUp', JSON.stringify(postureCalls));
check('stand tile emits xr:stand', busLog.includes('xr:stand'), JSON.stringify(busLog));
postureCalls.length = 0; busLog.length = 0;
tile('[data-posture=lie]').onclick!(new Event('click'));
check('lie tile: setPosture("lie"), no xr event', postureCalls[0] === 'lie' && !busLog.some((t: string) => t.startsWith('xr:')), JSON.stringify({ postureCalls, busLog }));
postureCalls.length = 0;
xrPanels[0].dispatch('sit');
check('the XR quad\'s sit button takes the same path', postureCalls[0] === 'sitHere');
postureCalls.length = 0;
ringActionEntries().find((e: any) => e.label === 'stand')!.act();
check('the ring\'s stand entry takes the same path', postureCalls[0] === 'standUp');
myState.clip = 'sit'; paint();
check('the sit tile is lit while the body\'s clip is sit', tile('[data-posture=sit]').classList.contains('on') && !tile('[data-posture=stand]').classList.contains('on'));
myState.clip = null; paint();

console.log('ACTIONBAR — the fired tile stays lit ~1.5 s');
played.length = 0;
tile('[data-anim=wave]').onclick!(new Event('click'));
check('the tile plays the gesture on my body and sets myState.anim', played[0] === 'wave' && myState.anim === 'wave');
check('the fired tile is lit', tile('[data-anim=wave]').classList.contains('on'));
myState.anim = null;  // net.js clears it on the first pose send
paint();
check('fired tile stays lit after net.js clears myState.anim (t+0)', tile('[data-anim=wave]').classList.contains('on'));
nowMs += 1400; paint();
check('still lit at t+1.4 s', tile('[data-anim=wave]').classList.contains('on'));
nowMs += 200; paint();
check('dark at t+1.6 s', !tile('[data-anim=wave]').classList.contains('on'));
check('no other tile was ever lit by it', tiles().every((t) => !t.classList.contains('on')));
myState.anim = 'clap'; paint();  // a number key set it elsewhere
check('a number-key gesture (myState.anim) lights its tile', tile('[data-anim=clap]').classList.contains('on') && !tile('[data-anim=wave]').classList.contains('on'));
myState.anim = null; paint();

console.log('ACTIONBAR — a defs push rebuilds the lantern\'s gesture actions, not just the tiles');
{
  // register() MERGES and skips undefined fields, so re-registering on top of old entries kept stale numbers and rows
  const A = await import('../client/lib/actions.js');
  const saved = ANIM_ORDER.splice(0);
  ANIM_ORDER.push('clap', 'cheer', 'dance', 'point', 'salute', 'bow', 'shrug', 'nod', 'spin', 'wave');
  bus.emit('animnames-updated');
  check('a moved gesture takes its new number key (clap → 1)', A.get('bar:clap')?.key === '1', `key=${A.get('bar:clap')?.key}`);
  check('a gesture moved past nine loses its key (wave, 1st → 10th)', !!A.get('bar:wave') && A.get('bar:wave').key === undefined, `key=${A.get('bar:wave')?.key}`);
  ANIM_ORDER.splice(0, ANIM_ORDER.length, 'wave', 'cheer');
  bus.emit('animnames-updated');
  check('a removed gesture leaves the lantern (clap gone)', A.get('bar:clap') === null);
  check('the kept ones are still there with their keys', A.get('bar:wave')?.key === '1' && A.get('bar:cheer')?.key === '2');
  check('posture:stand survives the rebuild', !!A.get('posture:stand'));
  ANIM_ORDER.splice(0, ANIM_ORDER.length, ...saved); bus.emit('animnames-updated');
}

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
