// loadwork — labels heavy materializations (long tasks are attributed to them) and spreads/serializes their
// main-thread work on a per-frame budget.
//
// ⚠️ INVARIANT: serialize() is for LEAF operations only (one parse, one compile). Never call it from inside a
// serialized function or around a caller that awaits a serialized callee: the chain deadlocks on itself.

import { bus } from './base.js';
import { nextFrame as budgetFrame, ask, spent, reportPending } from './framebudget.js';

// ---- yields -----------------------------------------------------------------

/** The next frame: rAF (the session's clock in XR), a macrotask in a hidden tab (a load must still finish), never
 *  past its watchdog. */
export const nextFrame = budgetFrame;

/** Browser idle time, bounded: loading must finish even on a busy frame loop. */
export const idleYield = () => new Promise((res) => {
  if (typeof requestIdleCallback === 'function' && !document.hidden) {
    requestIdleCallback(() => res(), { timeout: 400 });
  } else setTimeout(res, 32);
});


// ---- work records -----------------------------------------------------------

const active = new Set(); // in-flight records, for long-task attribution
const LOG_THRESHOLD_MS = 120;
// console mirrors for automation (Safari's console can't be read over WebDriver)
const loadLog = (globalThis.__loadLog = []);
const jankLog = (globalThis.__loadJank = []);

/** phase(name), tick() (yields only when over budget), yield(), end(). Wall time includes awaited downloads: give
 *  them their own phases so the summary tells the truth. */
export function beginWork(label) {
  const t0 = performance.now();
  const phases = [];
  let phaseName = null;
  let phaseStart = t0;
  let sliceStart = t0;
  let frames = 0;
  let ended = false;
  let grant = null;   // its hold is released when the slice reports

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
      // a whole frame, then a grant: the work after a yield is budgeted like any other slice
      spent('load', performance.now() - sliceStart, sliceStart, grant);
      grant = null;
      let waited = 0;
      do { frames++; waited++; await nextFrame(); } while (!(grant = ask('load', { waited })));
      sliceStart = performance.now();
    },
    end() {
      if (ended) return;
      ended = true;
      spent('load', performance.now() - sliceStart, sliceStart, grant);
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
      if (loadLog.length < 300) loadLog.push(line);
    },
  };
  active.add(rec);
  return rec;
}

/** A load fact outside any record: beginWork logs only >120 ms, which hides the wins (a ~0 ms pool hit, §19b). */
export function loadNote(line) {
  console.log(`[load] ${line}`);
  if (loadLog.length < 300) loadLog.push(line);
}

// ---- serialization ----------------------------------------------------------

/** Queue heavy LEAF work (the invariant up top); errors reach the caller, the lanes never break. Two in flight per
 *  lane: wall time is mostly awaits (draco workers, image decode). Priority 2 own body > 1 bodies > 0 objects;
 *  reorders waiting work only. */
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
/** Any lane running or queued, for the governor's loading grace (§16.2.D). */
export const laneBusy = () => Boolean(
  lanes.cpu.running || lanes.gpu.running
  || lanes.cpu.jobs.length || lanes.gpu.jobs.length);
const reportLanes = () => reportPending('lanes',
  lanes.cpu.running + lanes.gpu.running + lanes.cpu.jobs.length + lanes.gpu.jobs.length);
/** Queue depths per lane (EW.lanes). */
export const laneStats = () => ({
  cpu: { running: lanes.cpu.running, queued: lanes.cpu.jobs.length, max: lanes.cpu.max },
  gpu: { running: lanes.gpu.running, queued: lanes.gpu.jobs.length, max: lanes.gpu.max },
});
// 'lanes-idle': all loadwork settled
function checkIdle() {
  if (!lanes.cpu.jobs.length && !lanes.gpu.jobs.length
    && !lanes.cpu.running && !lanes.gpu.running) {
    bus.emit('lanes-idle');
  }
}
/** Back-compat shape. */
export function serialize(fn, { urgent = false, lane = 'cpu', priority } = {}) {
  return enqueue(fn, { lane, priority: priority ?? (urgent ? 2 : 0) });
}

// ---- long-task attribution --------------------------------------------------
// names whose each main-thread stall was

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

// Frame-gap watchdog (Safari has no longtask observer): any frame held >150ms logs with the same attribution.
// ---- perf beacon: /perflog at 40s (load window) and 120s (Safari compile tail), with an fps median (a steady low
// fps never shows as gaps)
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
