// Event-stream denoiser for a WorldAgent's ambient narration. Noise depends on context, not event type, so the
// filter is stateful per identity:
//  1. hold-and-cancel: an arrive/leave is held and the opposite event inside the window cancels both
//     (narration only; look() stays truthful about who is present)
//  2. decaying charge + refractory: a decaying per-identity charge limits presence narration; repeated acts are
//     silent within a per-(identity, act) window
// Mentions and says are never gated. (Self-echo is filtered in agent.ts hearSay.)

export type GateEvent = { kind: "arrive" | "leave" | "act"; who: string; text?: string; ts: number };

const env = (k: string, d: number) => {
  const v = Number(process.env[k]);
  return Number.isFinite(v) ? v : d;
};

export const GATE_DEFAULTS = {
  /** a leave inside this window collapses both (brief visit / smoke test) */
  arriveHoldMs: env("EW_ARRIVE_HOLD_SEC", 12) * 1000,
  /** an arrive inside this window collapses both (reconnect flap) */
  leaveHoldMs: env("EW_LEAVE_HOLD_SEC", 45) * 1000,
  presenceTauMs: env("EW_PRESENCE_TAU_SEC", 600) * 1000,
  /** decayed charge at/above this drops further arrive/leave narration from that identity */
  presenceLimit: 1.5,
  actRefractoryMs: env("EW_ACT_REFRACT_SEC", 180) * 1000,
};

/** A non-locomotion stint shorter than this (a jump, a stumble) earns no "gets up": the start told the story.
 *  Read by agent.ts. */
export const SHORT_STINT_MS = env("EW_STINT_MIN_SEC", 5) * 1000;

/** Approach refractory per identity: repeats inside it are background. agent.ts also requires re-arming: the
 *  person must go past REARM_RADIUS before another crossing can count. */
export const APPROACH_REFRACT_MS = env("EW_APPROACH_REFRACT_SEC", 600) * 1000;
export const APPROACH_RADIUS = 2.5;
export const REARM_RADIUS = 6;

/** Dwell: an approach means "walked up AND stopped within arm's reach". The crossing opens a pending approach,
 *  delivered after this long inside the radius, cancelled if they leave first. */
export const APPROACH_DWELL_MS = env("EW_APPROACH_DWELL_SEC", 2.5) * 1000;
/** Below this observed ground speed (m/s) a body is still: measured from watched positions, never the pose's own
 *  `speed`, which a sender can fill. Walking is ~1.4 m/s. */
export const APPROACH_STILL_MPS = (() => {
  const v = env("EW_APPROACH_STILL_MPS", 0.35);
  if (v > 0) return v;
  // ≤ 0: stillness never accumulates and every approach ships via the max-wait hatch
  console.warn(`[denoise] EW_APPROACH_STILL_MPS=${v} rejected (must be > 0); using 0.35`);
  return 0.35;
})();
/** APPROACH_MAX_WAIT_MS's floor: 2·APPROACH_RADIUS / APPROACH_STILL_MPS. */
export const APPROACH_SAFE_WAIT_MS = Math.ceil(((2 * APPROACH_RADIUS) / APPROACH_STILL_MPS) * 1000);
/** Deliver anyway after this long in the radius (a pacer has still approached). Clamped to APPROACH_SAFE_WAIT_MS so a
 *  straight pass-through can never reach it, whatever the env says. */
export const APPROACH_MAX_WAIT_MS = (() => {
  const v = env("EW_APPROACH_MAX_WAIT_SEC", 20) * 1000;
  if (v >= APPROACH_SAFE_WAIT_MS) return v;
  console.warn(`[denoise] EW_APPROACH_MAX_WAIT_SEC=${v / 1000}s would let a straight pass-through be announced as an approach; clamped to ${APPROACH_SAFE_WAIT_MS / 1000}s (2·APPROACH_RADIUS / APPROACH_STILL_MPS)`);
  return APPROACH_SAFE_WAIT_MS;
})();

/** Activity pulse defaults: a digest within ACTIVITY_RADIUS_M, at most once per window and only when something
 *  happened, for hosts that wake on eidoverse:activity-digest. Per-agent: WorldAgent.setActivity. */
export const ACTIVITY_RADIUS_M = env("EW_ACTIVITY_RADIUS_M", 30);
export const ACTIVITY_PULSE_MS = env("EW_ACTIVITY_PULSE_SEC", 30) * 1000;
/** An unchanged ambient digest repeats no more often than this; discrete events (speech, arrivals, builds) always
 *  pulse. */
export const ACTIVITY_REFRESH_MS = env("EW_ACTIVITY_REFRESH_SEC", 600) * 1000;
/** Metres travelled inside a window to count as "moving about": displacement, not a speed flag, so idle jitter and
 *  a body parked mid-walk-cycle never qualify. */
export const MOVER_MIN_M = env("EW_MOVER_MIN_M", 1.0);

type IdState = {
  pending: { kind: "arrive" | "leave"; ts: number; timer: ReturnType<typeof setTimeout> } | null;
  charge: number;
  chargedAt: number;
  lastAct: Map<string, number>;
};

export class NoiseGate {
  private ids = new Map<string, IdState>();
  private opts: typeof GATE_DEFAULTS;
  /** silence should be auditable */
  stats = { flapsCollapsed: 0, presenceDropped: 0, actsDropped: 0 };

  constructor(
    private emit: (ev: GateEvent) => void,
    opts: Partial<typeof GATE_DEFAULTS> = {},
  ) {
    this.opts = { ...GATE_DEFAULTS, ...opts };
  }

  private state(id: string): IdState {
    let s = this.ids.get(id);
    if (!s) { s = { pending: null, charge: 0, chargedAt: 0, lastAct: new Map() }; this.ids.set(id, s); }
    return s;
  }

  /** Touches the bookkeeping. */
  private decayed(s: IdState, now: number): number {
    if (s.charge > 0 && s.chargedAt > 0) {
      s.charge *= Math.exp(-(now - s.chargedAt) / this.opts.presenceTauMs);
    }
    s.chargedAt = now;
    return s.charge;
  }

  /** Held; the opposite event inside the hold window annihilates the pair. */
  presence(id: string, kind: "arrive" | "leave", ts = Date.now()) {
    const s = this.state(id);
    if (s.pending) {
      if (s.pending.kind !== kind) {
        // flap: leave->arrive (reconnect) or arrive->leave (brief visit)
        clearTimeout(s.pending.timer);
        s.pending = null;
        this.stats.flapsCollapsed++;
        // chronic flappers keep themselves warm even while fully collapsed
        this.decayed(s, ts);
        s.charge += 0.1;
        return;
      }
      // duplicate same-direction event (shouldn't happen): keep the first
      return;
    }
    const hold = kind === "arrive" ? this.opts.arriveHoldMs : this.opts.leaveHoldMs;
    const timer = setTimeout(() => {
      s.pending = null;
      const charge = this.decayed(s, Date.now());
      if (charge >= this.opts.presenceLimit) {
        this.stats.presenceDropped++;
        s.charge += 0.4; // being noisy while silenced extends the silence
        return;
      }
      s.charge += 1;
      this.emit({ kind, who: id, ts });
    }, hold);
    s.pending = { kind, ts, timer };
  }

  /** An embodied act (gesture, posture start, pose strike). The same `key` from the same identity repeats silently
   *  within the window. */
  act(id: string, key: string, text: string, ts = Date.now()) {
    const s = this.state(id);
    const last = s.lastAct.get(key) ?? 0;
    if (ts - last < this.opts.actRefractoryMs) {
      this.stats.actsDropped++;
      // NOT refreshed on drop: a continuous burst still speaks once per window, not silenced by its own persistence
      return;
    }
    s.lastAct.set(key, ts);
    this.emit({ kind: "act", who: id, text, ts });
  }

  /** Session ending. */
  dispose() {
    for (const s of this.ids.values()) {
      if (s.pending) { clearTimeout(s.pending.timer); s.pending = null; }
    }
  }
}
