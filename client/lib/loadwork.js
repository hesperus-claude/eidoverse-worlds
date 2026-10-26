// loadwork — labels heavy materializations (long tasks are attributed to them) and spreads/serializes their
// main-thread work on a per-frame budget.
//
// ⚠️ INVARIANT: serialize() is for LEAF operations only (one parse, one
// compile). Never call serialize() from inside a serialized function and never
// wrap a caller that itself awaits a serialized callee — that is a deadlock,
// the chain waits on itself.

import { bus } from './base.js';
import { nextFrame as budgetFrame, ask, spent, reportPending } from './framebudget.js';

// ---- yields -----------------------------------------------------------------

/** Wait for the next frame (framebudget: window rAF, which xr_frame_clock routes to the session clock in XR; a
 *  macrotask when the tab is hidden, where an avatar load must still finish; never longer than its watchdog). */
export const nextFrame = budgetFrame;

/** Wait for browser idle time (bounded — loading must finish even on a busy
 *  frame loop), for background work like clip hydration. */
export const idleYield = () => new Promise((res) => {
  if (typeof requestIdleCallback === 'function' && !document.hidden) {
    requestIdleCallback(() => res(), { timeout: 400 });
  } else setTimeout(res, 32);
});

// The slice size is framebudget's: one budget per frame shared with the warm conductor and the sky (bigger bites
// under the splash, a governor-set share of the frame once someone is walking around).

// ---- work records -----------------------------------------------------------

const active = new Set(); // in-flight records, for long-task attribution
const LOG_THRESHOLD_MS = 120;
// Mirrors of the console lines, reachable from automation (Safari's console
// can't be read over WebDriver) and from a quick `__loadJank` in any console.
const loadLog = (globalThis.__loadLog = []);
const jankLog = (globalThis.__loadJank = []);

/** Start a labelled piece of load work: phase(name), tick() (yields only when over budget), yield(), end() (logs
 *  heavy work). Wall time includes awaited downloads: give them their own phases so the summary tells the truth. */
export function beginWork(label) {
  const t0 = performance.now();
  const phases = [];
  let phaseName = null;
  let phaseStart = t0;
  let sliceStart = t0;
  let frames = 0;
  let ended = false;
  let grant = null;   // this record's current framebudget grant (its hold is released when the slice reports)

  const closePhase = () => {
    if (phaseName !== null) phases.push([phaseName, performance.now() - phaseStart]);
  };

  const rec = {
    label,
    get phaseName() { return phaseName; },
    phase(name) {
      closePhase();
      phaseName = name;
      phaseStart = performance.now();
    },
    async tick() {
      const now = performance.now();
      spent('load', now - sliceStart, sliceStart, grant);
      sliceStart = now;
      if ((grant = ask('load'))) return;
      let waited = 0;   // aging is per record: one busy record cannot hold the others back
      do { frames++; waited++; await nextFrame(); } while (!(grant = ask('load', { waited })));
      sliceStart = performance.now();
    },
    async yield() {
      // a whole frame, then the same grant as tick(): the work after a yield is budgeted like any other slice
      spent('load', performance.now() - sliceStart, sliceStart, grant);
      grant = null;
      let waited = 0;
      do { frames++; waited++; await nextFrame(); } while (!(grant = ask('load', { waited })));
      sliceStart = performance.now();
    },
    end() {
      if (ended) return;
      ended = true;
      spent('load', performance.now() - sliceStart, sliceStart, grant);   // the last slice, and its hold released
      grant = null;
      closePhase();
      active.delete(rec);
      const total = performance.now() - t0;
      if (total < LOG_THRESHOLD_MS) return;
      const parts = phases
        .filter(([, ms]) => ms >= 1)
        .map(([n, ms]) => `${n} ${Math.round(ms)}ms`)
        .join(' · ');
      const line = `${label}: ${parts} — ${Math.round(total)}ms over ${frames + 1} frame(s)`;
      console.log(`[load] ${line}`);
      if (loadLog.length < 300) loadLog.push(line); // reachable without a console (webdriver, evals)
    },
  };
  active.add(rec);
  return rec;
}

/** Record a one-line load fact outside any work record: beginWork logs only >120 ms, which hides the wins (a ~0 ms
 *  VRM pool hit, §19b). Same console tag, mirror and cap. */
export function loadNote(line) {
  console.log(`[load] ${line}`);
  if (loadLog.length < 300) loadLog.push(line);
}

// ---- serialization ----------------------------------------------------------

/** Queue heavy LEAF work (see the invariant up top); errors reach the caller, the lanes never break. Lanes: cpu
 *  (parses) and gpu (pipeline compiles), two in flight each because their wall time is mostly awaits. Priority
 *  2 own body > 1 bodies > 0 objects; reorders waiting work only. */
// cpu at 2: a parse's wall time is mostly awaits (draco workers, image decode), so two in flight overlap them
const lanes = {
  cpu: { jobs: [], running: 0, max: 2 },
  gpu: { jobs: [], running: 0, max: 2 },
};
export function enqueue(fn, { lane = 'cpu', priority = 0 } = {}) {
  return new Promise((resolve, reject) => {
    const l = lanes[lane] ?? lanes.cpu;
    const job = { fn, priority, resolve, reject };
    const i = l.jobs.findIndex((j) => j.priority < priority);
    if (i === -1) l.jobs.push(job); else l.jobs.splice(i, 0, job);
    pumpLane(l);
    reportLanes();
  });
}
function pumpLane(l) {
  while (l.running < l.max && l.jobs.length) {
    const job = l.jobs.shift();
    if (!job) break;
    l.running++;
    (async () => {
      try { job.resolve(await job.fn()); } catch (e) { job.reject(e); }
      finally { l.running--; pumpLane(l); reportLanes(); checkIdle(); }
    })();
  }
}
/** Whether any lane holds running or queued work (checkIdle()'s truth), for the governor's loading grace (§16.2.D). */
export const laneBusy = () => Boolean(
  lanes.cpu.running || lanes.gpu.running
  || lanes.cpu.jobs.length || lanes.gpu.jobs.length);
const reportLanes = () => reportPending('lanes',
  lanes.cpu.running + lanes.gpu.running + lanes.cpu.jobs.length + lanes.gpu.jobs.length);
/** Queue depths per lane — the 8e debug shape (EW.lanes). */
export const laneStats = () => ({
  cpu: { running: lanes.cpu.running, queued: lanes.cpu.jobs.length, max: lanes.cpu.max },
  gpu: { running: lanes.gpu.running, queued: lanes.gpu.jobs.length, max: lanes.gpu.max },
});
// 'lanes-idle' fires when every queued load has finished. (Its one historic
// consumer — the deferred shadow drain — is gone; the event stays as the
// generic "all loadwork settled" signal.)
function checkIdle() {
  if (!lanes.cpu.jobs.length && !lanes.gpu.jobs.length
    && !lanes.cpu.running && !lanes.gpu.running) {
    bus.emit('lanes-idle');
  }
}
/** Back-compat shape used by early call sites. */
export function serialize(fn, { urgent = false, lane = 'cpu', priority } = {}) {
  return enqueue(fn, { lane, priority: priority ?? (urgent ? 2 : 0) });
}

// ---- long-task attribution --------------------------------------------------
// the browser measures every main-thread stall over 50ms; this names whose it was (unattributed ones log as such)

const activeLabels = () => [...active]
  .map((w) => w.phaseName ? `${w.label}[${w.phaseName}]` : w.label)
  .join(' + ');

try {
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) {
      if (e.duration < 90) continue;
      console.warn(`[longtask] ${Math.round(e.duration)}ms during: ${activeLabels() || '(unattributed)'}`);
    }
  }).observe({ type: 'longtask', buffered: true });
} catch { /* not supported — the frame-gap watchdog below still measures */ }

// Frame-gap watchdog: Safari has no longtask observer, so any frame held >150ms logs with the same attribution.
// ---- perf beacon: a POST to the sequencer's /perflog at 40s (load window) and 120s (Safari compile tail), with a
// recent fps median from the watchdog's rAF ticks (a steady low fps never shows as >150ms gaps)
const fpsWindow = [];
let fpsTick = 0;
setInterval(() => {
  fpsWindow.push(fpsTick); fpsTick = 0;
  if (fpsWindow.length > 30) fpsWindow.shift();
}, 1000);
const fpsMedian = () => {
  const s = [...fpsWindow].sort((a, b) => a - b);
  return s.length ? s[(s.length / 2) | 0] : null;
};

function postPerf(mark) {
  try {
    fetch('/perflog', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        mark,
        ua: navigator.userAgent.slice(0, 160),
        boot: globalThis.__bootMarks ?? null,
        fps: fpsMedian(),
        jank: jankLog.slice(0, 100),
        load: loadLog.slice(0, 200),
      }),
    }).catch(() => {});
  } catch { /* never let telemetry hurt the world */ }
}
bus.on('booted', (m) => { globalThis.__bootMarks = m; });
setTimeout(() => postPerf('40s'), 40_000);
setTimeout(() => postPerf('120s'), 120_000);

let lastFrameAt = 0;
requestAnimationFrame(function gapWatch(t) {
  fpsTick++;
  if (lastFrameAt && t - lastFrameAt > 150 && !document.hidden) {
    const line = `${Math.round(t - lastFrameAt)}ms frame gap during: ${activeLabels() || '(unattributed)'}`;
    console.warn(`[jank] ${line}`);
    if (jankLog.length < 200) jankLog.push(line);
  }
  lastFrameAt = t;
  requestAnimationFrame(gapWatch);
});
