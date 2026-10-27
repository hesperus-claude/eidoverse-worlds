// eidoverse-worlds sequencer — the heartbeat (overhaul charter §4, phase 1 slice 3): one scheduler for the server's
// cadenced systems (TEL0S_NOTES §3). A cadence is a REGISTERED SYSTEM: named, error-isolated (one system's throw costs
// that system one beat, never its neighbors, never the process), and measured (runs, worst ms, last error) at GET /tick.
// The base interval keeps setInterval's wall-clock drift; cadences are "at least everyMs apart", no fixed timestep.

export type TickSystem = {
  name: string;
  everyMs: number;
  fn: (now: number) => void;
};

type Stat = { runs: number; lastMs: number; worstMs: number; errors: number; lastError: string | null };
const systems: (TickSystem & { lastRun: number; stat: Stat })[] = [];
let timer: ReturnType<typeof setInterval> | null = null;
let baseMs = 0;

/** Register a cadenced system. Order of registration is order of execution
 *  within a beat — keep fast fanouts (frames) first. */
export function registerSystem(sys: TickSystem) {
  systems.push({ ...sys, lastRun: 0,
    stat: { runs: 0, lastMs: 0, worstMs: 0, errors: 0, lastError: null } });
}

/** Start the heartbeat. `base` is the finest cadence any system needs (the
 *  stage-frame FRAME_MS today); coarser systems ride accumulators on it. */
export function startTick(base: number) {
  if (timer) throw new Error("tick already started");
  baseMs = base;
  timer = setInterval(() => {
    const now = Date.now();
    for (const s of systems) {
      if (now - s.lastRun < s.everyMs) continue;
      s.lastRun = now;
      const t0 = performance.now();
      try {
        s.fn(now);
        s.stat.lastError = null;
      } catch (err) {
        // a system's throw is ITS failure: recorded, logged, contained
        s.stat.errors++;
        s.stat.lastError = String(err);
        console.error(`[tick:${s.name}]`, err);
      }
      const ms = performance.now() - t0;
      s.stat.runs++;
      s.stat.lastMs = ms;
      if (ms > s.stat.worstMs) s.stat.worstMs = ms;
      // an overrun eats the NEXT beat's budget — say so once in a while
      // (every 50th) rather than silently or noisily
      if (ms > s.everyMs && s.stat.runs % 50 === 1) {
        console.warn(`[tick:${s.name}] ran ${ms.toFixed(1)}ms against a ${s.everyMs}ms cadence`);
      }
    }
  }, base);
}

/** The observability surface behind GET /tick. */
export function tickStats() {
  return {
    baseMs,
    systems: systems.map((s) => ({ name: s.name, everyMs: s.everyMs, ...s.stat,
      lastMs: Number(s.stat.lastMs.toFixed(2)), worstMs: Number(s.stat.worstMs.toFixed(2)) })),
  };
}
