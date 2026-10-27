// framebudget — one per-frame budget for background work, shared by every producer (warmqueue, loadwork, sky bakes).
//
//   - a governor-set share of the frame period, at most MAX_MS; SPLASH_MS under the splash
//   - each grant holds the lane's EWMA until spent() measures it; a frame's first grant may overrun, even under debt,
//     and the overrun carries as debt (capped at one budget)
//   - nothing starves: a waiter denied AGE_FRAMES frames in a row is granted
//   - GPU work counts in UNITS, not ms (GPU timers answer frames late): one gpu unit per frame
//
// A yield is rAF raced with WATCHDOG_MS, so no waiter outlives a stopped clock. busy() is the governor's loading
// signal; steady-state work (sky re-bakes) isn't loading.

import { bus } from './base.js';

const SPLASH_MS = 14;        // under the splash: big bites
const MAX_MS = 6;            // once booted, however long the frame
const AGE_FRAMES = 8;        // a waiter denied this many frames in a row is granted anyway
const WATCHDOG_MS = 250;     // no waiter waits longer than this for a frame

let share = 0.36;            // ≈ 6 ms at 60 Hz
let booted = false;
let periodMs = 1000 / 60;    // EWMA
let frameStart = 0;
let spentThis = 0;           // ms charged in the current frame
let debt = 0;                // overrun carried from the previous frame
let gpuUnits = 0;
let grantsThis = 0;          // the free first grant goes to ONE caller
let frameNo = 0;
let lastTickTs = -1;
let lastRollTs = -1;         // dedupe
let lastTickWall = 0;        // is the loop alive?
const lanes = new Map();     // lane → { spent, grants, denied, pending, ewma }

bus.on('booted', () => { booted = true; });

const laneOf = (name) => {
  let l = lanes.get(name);
  if (!l) lanes.set(name, (l = { spent: 0, grants: 0, denied: 0, pending: 0, ewma: 0 }));
  return l;
};

/** ms this frame, before debt. */
export const budgetMs = () => (booted ? Math.min(MAX_MS, share * periodMs) : SPLASH_MS);
const remaining = () => budgetMs() - debt - spentThis;

// deduped on the timestamp: the loop and every rAF waiter in one frame see the same one
function roll(ts) {
  if (ts === lastRollTs) return;
  lastRollTs = ts;
  frameStart = performance.now();
  debt = Math.min(budgetMs(), Math.max(0, debt + spentThis - budgetMs()));
  spentThis = 0;
  gpuUnits = 0;
  grantsThis = 0;
  frameNo++;
}

/** Once per frame, first thing. */
export function tick(now = performance.now()) {
  lastTickWall = performance.now();
  const dt = now - lastTickTs;
  if (lastTickTs >= 0 && dt > 4 && dt < 100) periodMs += (dt - periodMs) * 0.1;
  lastTickTs = now;
  roll(now);
}

/** rAF (the session's clock in XR), a macrotask in a hidden tab, never later than WATCHDOG_MS. */
export function nextFrame() {
  return new Promise((res) => {
    let done = false, wd = 0;
    const once = (ts) => { if (done) return; done = true; clearTimeout(wd); roll(ts); res(); };
    // hidden but still ticking is a PC headset session: its rAF is the session's clock, so stay on rAF
    const loopLive = performance.now() - lastTickWall < WATCHDOG_MS;
    const hidden = typeof document !== 'undefined' && document.hidden && !loopLive;
    if (!hidden && typeof requestAnimationFrame === 'function') requestAnimationFrame(once);
    else setTimeout(() => once(performance.now()), hidden ? 0 : 16);
    wd = setTimeout(() => once(performance.now()), WATCHDOG_MS);
  });
}

/** May `lane` spend now? Returns a GRANT (pass it to spent()) or false. A frame's first grant passes even under
 *  debt; `waited` ≥ AGE_FRAMES passes; `gpu: true` asks for this frame's one gpu unit. */
export function ask(lane, { gpu = false, waited = 0 } = {}) {
  const l = laneOf(lane);
  const starved = waited >= AGE_FRAMES;
  // the free first grant counts GRANTS, not spend: a grant charges only after its work runs
  const room = starved || grantsThis === 0 || remaining() > 0;
  const ok = gpu ? gpuUnits === 0 && room : room;
  if (!ok) { l.denied++; return false; }
  l.grants++;
  grantsThis++;
  if (gpu) gpuUnits++;
  // hold the lane's typical cost until THIS grant reports, or every ask in between sees an empty frame (per grant:
  // several records share a lane)
  spentThis += l.ewma;
  return { held: l.ewma, frame: frameNo };
}

/** Releases `grant`'s hold if taken this frame. A `since` before this frame resumed from an await: unknowable, so it
 *  charges nothing rather than bill the render loop's own time. */
export function spent(lane, ms, since = null, grant = null) {
  const unknown = since != null && since < frameStart;
  const v = unknown ? 0 : since == null ? Math.max(0, ms) : Math.max(0, Math.min(ms, performance.now() - since));
  const l = laneOf(lane);
  if (grant && grant.frame === frameNo) { spentThis -= grant.held; grant.held = 0; }
  spentThis += v;
  l.spent += v;
  if (!unknown) l.ewma += (v - l.ewma) * 0.2;
}

/** Ask, then wait whole frames until granted, aging per caller. */
export async function turn(lane, opts = {}) {
  let waited = 0, g;
  while (!(g = ask(lane, { ...opts, waited }))) { waited++; await nextFrame(); }
  return g;
}

/** How much LOADING work `lane` holds (queued + running). */
export function reportPending(lane, n) { laneOf(lane).pending = Math.max(0, n | 0); }

/** Is anything loading? */
export function busy() {
  for (const l of lanes.values()) if (l.pending > 0) return true;
  return false;
}

/** The governor's knob, once booted. */
export function setShare(s) { share = Math.min(0.8, Math.max(0.05, +s || 0)); }

/** Debug shape (EW.budget). */
export const budgetStats = () => ({
  frameNo, periodMs: +periodMs.toFixed(2), share, budgetMs: +budgetMs().toFixed(2), debt: +debt.toFixed(2),
  spentThis: +spentThis.toFixed(2), booted,
  lanes: Object.fromEntries([...lanes].map(([k, l]) => [k, {
    spent: Math.round(l.spent), grants: l.grants, denied: l.denied, pending: l.pending, ewma: +l.ewma.toFixed(2) }])),
});

/** Tests only. */
export function __resetForTest() {
  share = 0.36; booted = false; periodMs = 1000 / 60; frameStart = 0; spentThis = 0; debt = 0;
  gpuUnits = 0; grantsThis = 0; frameNo = 0; lanes.clear(); lastTickTs = -1; lastRollTs = -1; lastTickWall = 0;
}
export function __setBootedForTest(b) { booted = !!b; }
