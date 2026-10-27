// frame — the loop as an explicit system list (TEL0S_NOTES §6, §14.2 6b): each system timed (EW.frame()), stride-able
// by the governor, fenced so one throw can't stop rAF. Registration order is execution order (§14.1).
// startFrame() is explicit: a module that self-started on import would silently change boot order.

import { report, bus } from './base.js';
import { renderer, XR_BOOT } from './core.js';
import { BC } from './breadcrumbs.js';
import { perf } from './perf.js';
import { tick as budgetTick } from './framebudget.js';
globalThis.__perf = perf;   // harness: xr-lifecycle-probe reads frameNo to prove the desktop loop ticks after a session ends

const systems = [];
let frameNo = 0;
let last = 0;
let frames = 0;
let fpsAt = 0;

/** Register a system. Order of registration = order of execution. */
export function registerSystem(name, tick, { every = 1 } = {}) {
  const s = { name, tick, every, enabled: true, ms: 0 };
  systems.push(s);
  return s;
}

export function setSystemEvery(name, every) {
  const s = systems.find((x) => x.name === name);
  if (s) s.every = Math.max(1, every | 0);
}
export function getSystemEvery(name) {
  return systems.find((x) => x.name === name)?.every ?? 1;
}
export function setSystemEnabled(name, on) {
  const s = systems.find((x) => x.name === name);
  if (s) s.enabled = !!on;
}

/** The bill: per-system rolling ms, stride, enablement. */
export const frameDebug = () => systems.map((s) => ({
  name: s.name, ms: +s.ms.toFixed(3), every: s.every, enabled: s.enabled,
}));

let windowWorst = 0;
let windowDoubled = 0;
let windowSpikes = 0;
function frame(now) {
  // a non-finite `now` (first tick after XR exit) is a resume: a NaN dt would leave the follow camera NaN forever
  if (!Number.isFinite(now)) now = performance.now();
  budgetTick(now);   // background work's frame opens here — this loop is the one that keeps ticking in XR
  let dtMs = now - last;
  if (!Number.isFinite(dtMs)) dtMs = 0;
  // a resume is not a frame: the first tick back from a blurred XR session can carry a huge negative dt
  if (dtMs < 0 || dtMs > 2000) dtMs = 0;
  const dt = Math.min(0.1, dtMs / 1000);
  last = now;
  // a hidden-tab resume gap is a suspension, not a jank spike: only real frames feed the EWMA and the worst
  if (dtMs < 2000) {
    perf.ms += (dtMs - perf.ms) * 0.1;
    if (dtMs > windowWorst) windowWorst = dtMs;
    // §22p: on a 60Hz panel sub-60 fps is ~33ms vsync-doubled frames, pacing not stutter; only >40ms spikes are events
    if (dtMs > 40) windowSpikes++;
    else if (dtMs > 25) windowDoubled++;
  }
  const t = now / 1000;
  globalThis._sceneTime = t;

  for (const s of systems) {
    if (!s.enabled || (s.every > 1 && frameNo % s.every)) continue;
    BC(s.name);
    const t0 = performance.now();
    try { s.tick(dt, t, now); } catch (e) { report(`frame ${s.name}`, e); }
    s.ms += (performance.now() - t0 - s.ms) * 0.05;
  }
  frameNo++;
  perf.frameNo = frameNo;   // lifetime tick count; the after-exit probe reads it

  frames++;
  if (now - fpsAt > 1000) {
    perf.fps = frames;
    perf.worst = windowWorst;
    perf.doubled = windowDoubled;
    perf.spikes = windowSpikes;
    windowWorst = 0;
    windowDoubled = 0;
    windowSpikes = 0;
    frames = 0;
    fpsAt = now;
  }
  if (!onXRLoop) requestAnimationFrame(frame);
}

// hand frame to three's Animation BEFORE setSession (xr:loop fires just ahead): setSession wraps the saved loop in
// _onAnimationFrame, the only place the eye framebuffer is bound. Never re-arm window.rAF on exit: frame would run twice.
let onXRLoop = XR_BOOT;
bus.on('xr:loop', () => { if (onXRLoop) return; onXRLoop = true; renderer.setAnimationLoop(frame); });
bus.on('xr:rearm', () => renderer.setAnimationLoop(frame));   // after-exit recovery: the loop three restarted never ticked

/** Start the loop. Called once from boot, AFTER identity resolves. */
export function startFrame() {
  last = performance.now();
  fpsAt = last;
  // in XR only session.requestAnimationFrame ticks, and setAnimationLoop routes to it; desktop keeps the plain rAF loop
  if (XR_BOOT) renderer.setAnimationLoop(frame);
  else requestAnimationFrame(frame);
}
