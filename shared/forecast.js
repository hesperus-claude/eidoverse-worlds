// forecast — the deterministic ambient-weather oracle, and the one sky fold every plane shares. PURE: browser, sequencer
// fold and agents must derive time of day and weather identically, so no Date.now() of its own (callers pass `now`). A
// `sky` may carry a `forecast` policy (#29); every weather change is derived from (policy, epoch, now) by each reader:
// no server sim, no per-frame entries, no per-client randomness.

export const WEATHERS = ['clear', 'fair', 'sunshower', 'overcast', 'rain', 'storm', 'cyclone', 'darkstorm'];
// the cloud kinds the sky realizes (client/lib/sky.js re-exports this; the Sky record names the same list)
export const CLOUDS = ['clear', 'cumulus', 'stratus', 'cirrus'];

// ---------------------------------------------------------------- day clock

// wall-clock mode: `sky {clock: "real", tz}` makes the hour the tz's, DST included (Intl). Formatters cached per tz (hoursAt
// runs per frame); an unknown tz caches null and the rated clock takes over.
const _tzFmt = new Map();
function tzFormatter(tz) {
  if (_tzFmt.has(tz)) return _tzFmt.get(tz);
  let f = null;
  try {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, hour12: false, hour: 'numeric', minute: 'numeric', second: 'numeric',
    });
  } catch { /* unknown tz: remembered as null */ }
  _tzFmt.set(tz, f);
  return f;
}

/** THE formula (sky.js's sun and the fold's rebase both call it, so a weather verb never snaps the day). Wall hours derive
 *  from the caller's tMs, never Date.now(). */
// A tz present is the wall clock; hours, rate and ts stay as the rated fallback. An older value said clock: 'real' (tz
// absent = Los Angeles) and parked its rated clock under dormantRated: both still read.
export const isRealClock = (sky) => !!sky && (typeof sky.tz === 'string' || sky.clock === 'real');
/** hours + rate × elapsed since ts (an older value's parked clock when it has one). */
export function ratedHoursAt(sky, tMs) {
  if (!sky) return 12;
  const d = sky.dormantRated;
  if (isRealClock(sky) && d && typeof d === 'object') return ((((d.hours ?? 12) + (d.rate ?? 0) * (tMs - (d.ts ?? sky.ts ?? tMs)) / 3600e3) % 24) + 24) % 24;
  return ((sky.hours ?? 12) + (sky.rate ?? 0) * (tMs - (sky.ts ?? tMs)) / 3600e3 + 24000) % 24;
}
export function hoursAt(sky, tMs) {
  if (!sky) return 12;
  if (isRealClock(sky)) {
    const f = tzFormatter(sky.tz ?? 'America/Los_Angeles');
    if (f) {
      const get = Object.fromEntries(f.formatToParts(new Date(tMs)).map((p) => [p.type, p.value]));
      return (Number(get.hour) % 24) + Number(get.minute) / 60 + Number(get.second) / 3600;
    }
    // tz didn't resolve: the rated clock governs (an older value's parked one, #65)
  }
  return ratedHoursAt(sky, tMs);
}

// ---------------------------------------------------------------- rng
// One draw stream per (seed, segment index). Draw ORDER within a segment (dwell, state, intensity) is wire contract:
// reordering forks every deployed world's forecast.

function hashSeed(seed) {
  const s = String(seed ?? 1);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function segRng(seed, idx) {
  let h = (seed ^ Math.imul(idx + 1, 0x9e3779b9)) >>> 0;
  return () => {
    h = (h + 0x6d2b79f5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------- policy

// the dwell floor bounds how often the sky may lurch (strobing is griefing) and the late-join walk (a year-old policy at
// 60 s is ~525k cheap iterations)
const DWELL_FLOOR_S = 60;
const DWELL_CAP_S = 6 * 3600;
const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, Number.isFinite(x) ? x : lo));

/** Null when the bag doesn't amount to a usable policy (no valid states, not an object): callers treat null as "forecast off". */
export function normalizePolicy(f) {
  if (!f || typeof f !== 'object') return null;
  const states = [];
  for (const s of Array.isArray(f.states) ? f.states : []) {
    const name = typeof s === 'string' ? s : s?.state;
    const weight = (s && typeof s === 'object' && Number.isFinite(s.weight)) ? Math.max(0, s.weight) : 1;
    if (WEATHERS.includes(name) && weight > 0) states.push({ state: name, weight });
  }
  if (!states.length) return null;
  // dwell and transition (no unit in a name); an older policy's dwellSec / transitionSec read too
  const dw = Array.isArray(f.dwell) ? f.dwell : f.dwellSec;
  const d = Array.isArray(dw) ? dw : [600, 1800];
  const dwellMin = clamp(d[0], DWELL_FLOOR_S, DWELL_CAP_S);
  const dwellMax = clamp(d[1] ?? dwellMin, dwellMin, DWELL_CAP_S);
  const k = Array.isArray(f.k) ? f.k : [0.7, 1];
  const kMin = clamp(k[0], 0.1, 1.5);
  const kMax = clamp(k[1] ?? kMin, kMin, 1.5);
  return {
    seed: hashSeed(f.seed),
    states,
    dwellMinMs: dwellMin * 1000,
    dwellMaxMs: dwellMax * 1000,
    kMin, kMax,
    // a transition may never outlive the shortest segment, or a new ease begins before the last finishes, forever
    transitionSec: clamp(f.transition ?? f.transitionSec ?? 30, 1, Math.min(600, dwellMin)),
    epoch: Number.isFinite(f.epoch) ? f.epoch : 0,   // stamped at fold; 0 = never folded
    seq: f.seq, by: f.by,
  };
}

// ---------------------------------------------------------------- segments

function pickState(states, prev, r) {
  // never re-draw the current state when there is anywhere else to go: a forecast whose transitions are invisible isn't one
  const pool = states.filter((s) => s.state !== prev);
  const use = pool.length ? pool : states;
  let x = r() * use.reduce((t, s) => t + s.weight, 0);
  for (const s of use) { x -= s.weight; if (x < 0) return s.state; }
  return use[use.length - 1].state;
}

/** Pure oracle: the same from a cold walk or a resumed cursor (the returned segment IS the cursor: fed back on the next tick
 *  the walk is O(1) from then on; fence #3). */
export function segmentAt(p, nowMs, cursor = null) {
  let idx = 0, start = p.epoch, prev = null;
  if (cursor && cursor.seed === p.seed && cursor.epoch === p.epoch
      && cursor.startMs <= nowMs && Number.isFinite(cursor.startMs)) {
    ({ idx, startMs: start, prevState: prev } = cursor);
  }
  for (;;) {
    const r = segRng(p.seed, idx);
    const dwellMs = p.dwellMinMs + r() * (p.dwellMaxMs - p.dwellMinMs);
    const state = pickState(p.states, prev, r);
    const k = p.kMin + r() * (p.kMax - p.kMin);
    const endMs = start + dwellMs;
    if (nowMs < endMs) {
      return { idx, startMs: start, endMs, state, k, prevState: prev, seed: p.seed, epoch: p.epoch };
    }
    prev = state; start = endMs; idx++;
  }
}

// ---------------------------------------------------------------- the answer

/** What the sky should SHOW at `nowMs`. Sources: 'authored' (no active policy), 'forecast' (the current segment), 'manual'
 *  (a weather verb inside the segment, holding until its boundary). `cursor` in/out keeps ticking O(1); omit it to derive cold. */
export function effectiveSky(sky, nowMs, cursor = null) {
  const authored = {
    source: 'authored',
    weather: WEATHERS.includes(sky?.weather) ? sky.weather : null,
    k: sky?.weatherK ?? 1,
    seconds: sky?.transition ?? sky?.weatherSeconds,
    cursor: null,
  };
  const p = normalizePolicy(sky?.forecast);
  if (!p || !p.epoch) return authored;
  const seg = segmentAt(p, Math.max(nowMs, p.epoch), cursor);
  const o = sky.override;
  // an override governs from the moment it LANDED to its segment's end, never earlier (a skewed clock must not see a "future" one)
  if (o && WEATHERS.includes(o.state) && nowMs >= o.ts && o.ts >= seg.startMs && o.ts < seg.endMs) {
    return {
      source: 'manual', weather: o.state, k: o.k ?? 1,
      seconds: sky.transition ?? sky.weatherSeconds, seg, cursor: seg,
      by: o.by, seq: o.seq, resumesMs: seg.endMs,
    };
  }
  return {
    source: 'forecast', weather: seg.state, k: seg.k,
    seconds: p.transitionSec, seg, cursor: seg,
    by: p.by, seq: p.seq, untilMs: seg.endMs,
    inTransition: nowMs - seg.startMs < p.transitionSec * 1000,
  };
}

// ---------------------------------------------------------------- spelling
// What a sky or weather act may still SAY the old way, stored the one way (clock 'real' → tz, weatherSeconds → transition,
// dwellSec/transitionSec, dormantRated re-anchored at the entry's ts). Today's spelling comes back unchanged.
const FIX = (o) => o && typeof o === 'object' && !Array.isArray(o);
export function skySpelling(args, ts) {
  if (!FIX(args)) return args;
  const out = { ...args };
  if ('clock' in out) { if (out.clock === 'real') out.tz = typeof out.tz === 'string' && out.tz ? out.tz : 'America/Los_Angeles'; else delete out.tz; delete out.clock; }
  if ('weatherSeconds' in out) { if (out.transition === undefined && out.weatherSeconds != null) out.transition = out.weatherSeconds; delete out.weatherSeconds; }
  if (FIX(out.forecast)) { const f = { ...out.forecast };
    if ('dwellSec' in f) { if (f.dwell === undefined) f.dwell = f.dwellSec; delete f.dwellSec; }
    if ('transitionSec' in f) { if (f.transition === undefined) f.transition = f.transitionSec; delete f.transitionSec; }
    out.forecast = f; }
  if ('dormantRated' in out) { const d = out.dormantRated; delete out.dormantRated;
    if (FIX(d) && out.hours == null && (Number.isFinite(d.hours) || Number.isFinite(d.rate))) {
      const rate = Number.isFinite(d.rate) ? d.rate : 0, h0 = Number.isFinite(d.hours) ? d.hours : 12;
      out.hours = Number.isFinite(ts) && Number.isFinite(d.ts) ? ((((h0 + rate * (ts - d.ts) / 3600e3) % 24) + 24) % 24) : h0;
      if (out.rate == null) out.rate = rate; } }
  return out;
}

/** One path, all planes. Stamps come from the ENTRY, never args (no spoofed provenance), except synthetic replay (negative
 *  seq), already stamped. A weather verb under a rated sky rebases hours, or the sun snaps back. */
export function foldSkyEntry(prev, { verb, args = {}, ts, seq, actor }) {
  const synthetic = (seq ?? 0) < 0;
  args = skySpelling(args, ts);
  if (verb === 'sky') {
    const out = { ...args, ts: synthetic ? (args.ts ?? ts) : ts };
    if (!synthetic) {
      delete out.override;
      if (args.forecast && typeof args.forecast === 'object') {
        out.forecast = { ...args.forecast, epoch: ts, seq, by: actor };
      } else {
        delete out.forecast;      // absent or null: forecast off, authored-only
      }
      out.seq = seq; out.by = actor;
    }
    // no parking: under a tz, hours and rate stay as the rated fallback
    return out;
  }
  // weather merges onto the standing sky (a thing that HAPPENS, not a property); `keepSky: false` starts fresh. One helper,
  // so the sequencer's fold and the client can't disagree.
  const base = args.keepSky === false ? {} : (prev ?? {});
  const out = { ...base, ...args, ts };
  delete out.keepSky;   // an instruction to the fold, not a sky property
  // the rated clock re-anchors at ts (its hour then, never the wall clock's: under a tz, hours/rate are the fallback)
  if ((base.rate ?? 0) !== 0 && args.hours == null) out.hours = ratedHoursAt(base, ts);
  if (!synthetic) {
    // a weather verb cannot author or clear policy: that is the sky verb's job
    if (base.forecast) out.forecast = base.forecast; else delete out.forecast;
    if (base.forecast && WEATHERS.includes(args.weather)) {
      out.override = {
        state: args.weather,
        ...(args.weatherK != null ? { k: args.weatherK } : {}),
        ts, seq, by: actor,
      };
    } else if (base.override) out.override = base.override;
    else delete out.override;
    // nor claim authorship of the bag: seq/by stay the sky entry's
    if (base.seq != null) out.seq = base.seq; else delete out.seq;
    if (base.by != null) out.by = base.by; else delete out.by;
  }
  // a weather verb never authors the clock: under a tz, stray hours/rate on it keep the standing fallback's
  if (isRealClock(base)) { if (base.hours !== undefined) out.hours = base.hours; else delete out.hours; if (base.rate !== undefined) out.rate = base.rate; else delete out.rate;
    if ((base.rate ?? 0) !== 0) out.hours = ratedHoursAt(base, ts); }
  return out;
}

/** "What clock governs this sky?" (#65), mirroring hoursAt's ACTUAL behaviour: `mode` is what's effective now.
 *    { mode:'real',  tz, hour, seq?, by? }
 *    { mode:'rated', rate, hour, seq?, by?, requestedTz? }
 *    { mode:'fixed', hour, seq?, by?, requestedTz? }
 *  `requestedTz`: a tz Intl can't resolve (the fallback governs). `seq`/`by`: the authoring entry's provenance. */
export function effectiveClock(sky, nowMs) {
  if (!sky) return { mode: 'fixed', hour: 12 };
  const hour = hoursAt(sky, nowMs);
  const prov = {
    ...(sky.seq != null ? { seq: sky.seq } : {}),
    ...(sky.by != null ? { by: sky.by } : {}),
  };
  if (isRealClock(sky)) {
    const tz = sky.tz ?? 'America/Los_Angeles';
    if (tzFormatter(tz)) return { mode: 'real', tz, hour, ...prov };
    // as hoursAt: the parked clock on a normalized bag, the top-level fields on one that never folded (preview args)
    const rate = (sky.dormantRated && typeof sky.dormantRated === 'object')
      ? (sky.dormantRated.rate ?? 0) : (sky.rate ?? 0);
    return rate !== 0
      ? { mode: 'rated', rate, hour, requestedTz: tz, ...prov }
      : { mode: 'fixed', hour, requestedTz: tz, ...prov };
  }
  const rate = sky.rate ?? 0;
  return rate !== 0 ? { mode: 'rated', rate, hour, ...prov } : { mode: 'fixed', hour, ...prov };
}

/** The granularity ambient perception wants: continuous hour updates would be spam; crossing dawn is an event. */
export function dayPhase(hours) {
  if (hours >= 5 && hours < 8) return 'dawn';
  if (hours >= 8 && hours < 18) return 'day';
  if (hours >= 18 && hours < 21) return 'dusk';
  return 'night';
}

// ---------------------------------------------------------------- narration

/** For text perception and debug output: who set the sky in motion, and what it is doing now. */
export function describeSky(sky, nowMs) {
  if (!sky) return null;
  const bits = [];
  const ck = effectiveClock(sky, nowMs);
  bits.push(`hour ${ck.hour.toFixed(1)}${ck.mode === 'real'
    ? ` (real time, ${ck.tz})`
    : ck.mode === 'rated' ? ` (advancing ×${ck.rate})` : ''}${ck.requestedTz
    ? ` (requested real-time tz "${ck.requestedTz}" is unknown — fallback clock in effect)` : ''}`);
  const eff = effectiveSky(sky, nowMs);
  const mins = (t) => Math.max(0, Math.round((t - nowMs) / 60000));
  if (eff.source === 'forecast') {
    bits.push(`weather ${eff.weather} (forecast — policy sky seq ${eff.seq ?? '?'} by ${eff.by ?? '?'}, `
      + `seed ${sky.forecast?.seed ?? '?'}, seg ${eff.seg.idx}, ~${mins(eff.untilMs)}m to next)`);
  } else if (eff.source === 'manual') {
    bits.push(`weather ${eff.weather} (manual override by ${eff.by ?? '?'} seq ${eff.seq ?? '?'} — `
      + `forecast resumes in ~${mins(eff.resumesMs)}m)`);
  } else if (eff.weather) {
    bits.push(`weather ${eff.weather}`);
  }
  return bits.join(', ');
}
