// base — the renderer-free substrate (docs/RENDERER-SEAM.md): bus, config, error routing, participant colours.
// Never touches three.js, the DOM tree or the GPU, and guards browser touches, so headless tests import the REAL thing.
// Imports NOTHING from the rest of the client; core.js imports base.

// ------------------------------------------------------------ event bus
// cross-cutting notifications travel on this instead of through imports

const listeners = new Map();
export const bus = {
  on(evt, fn) {
    if (!listeners.has(evt)) listeners.set(evt, new Set());
    listeners.get(evt).add(fn);
    return () => listeners.get(evt)?.delete(fn);
  },
  emit(evt, payload) {
    for (const fn of listeners.get(evt) ?? []) {
      try { fn(payload); } catch (e) { console.error(`bus:${evt}`, e); }
    }
  },
};

// ------------------------------------------------------------ config
// One place reads the URL and localStorage; both guarded (headless hosts have neither and get defaults).

// which world (#281): ?world=, else this tab's last, else this browser's, else the commons; only a person remembers.
// index.html's early-socket script makes the same choice as __ewWorld (tools/last-world-test.ts holds them equal)
export const LAST_WORLD_KEY = 'ew-world';      // localStorage: the browser's last world
export const TAB_WORLD_KEY = 'ew-world-tab';   // sessionStorage: this tab's
/** A name a world can have: server.ts admitJoin's rule (index.html's early-socket script carries its own copy). */
export const isWorldName = (w) => typeof w === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(w);
export function pickWorld(params, last, tab = null) {
  const asked = params.get('world');
  if (asked) return { world: asked, remembered: false };
  const person = !(params.has('spectate') || params.has('renderer') || params.has('mintthumbs'));
  if (person && isWorldName(tab)) return { world: tab, remembered: true };
  if (person && isWorldName(last)) return { world: last, remembered: true };
  return { world: 'commons', remembered: false };
}
/** The two memories as pickWorld takes them; storage that throws reads as none. */
export function rememberedWorlds() {
  const read = (s, k) => { try { return s?.getItem(k) ?? null; } catch { return null; } };
  return [read(globalThis.localStorage, LAST_WORLD_KEY), read(globalThis.sessionStorage, TAB_WORLD_KEY)];
}
/** What arriving in an empty world says (main.js), by how the page got here: the link, a memory, or the default. */
export function emptyWorldNotice({ world, params, worldRemembered }) {
  if (params.get('world')) return `"${world}" is empty — nothing has ever been built here.`;
  if (worldRemembered && world !== 'commons') {
    return `"${world}", the last world you were in, is empty now. Add ?world=<name> to the link to go somewhere else (?world=commons for the commons).`;
  }
  return `you are in "${world}", which is empty. Add ?world=<name> to the link to go somewhere else.`;
}

/** Forget where this person has been (ui.js logOut): the browser may be the next person's. */
export function forgetRememberedWorlds() {
  try { globalThis.localStorage?.removeItem(LAST_WORLD_KEY); } catch { /* private mode */ }
  try { globalThis.sessionStorage?.removeItem(TAB_WORLD_KEY); } catch { /* private mode */ }
}

const params = new URLSearchParams(globalThis.location?.search ?? '');
const store = globalThis.localStorage ?? null;
const picked = globalThis.__ewWorld ?? pickWorld(params, ...rememberedWorlds());
export const CONFIG = {
  params,
  world: picked.world,
  // a memory chose the world, not the link: a refusal at its door forgets it (net.js forgetRefusedWorld)
  worldRemembered: picked.remembered,
  spectate: params.has('spectate'),
  renderer: params.has('renderer'),
  // a roaming renderer: the server may send it to any world a snapshot is asked of (server/snapshots.ts)
  roam: params.has('renderer') && params.has('roam'),
  follow: params.get('follow'),
  // Door key: ?key=… once, remembered for this origin thereafter.
  token: params.get('key') || store?.getItem('ew-key') || '',
  name: params.get('name') || store?.getItem('ew-name') ||
    `guest-${Math.random().toString(36).slice(2, 6)}`,
  // a dev host (the probes, a local server, ?dev): the guards that throw loudly instead of letting drift pass
  dev: params.has('dev') || /^(localhost|127\.0\.0\.1|\[::1\])$/.test(globalThis.location?.hostname ?? ''),
};
if (params.get('key')) store?.setItem('ew-key', CONFIG.token);
store?.setItem('ew-name', CONFIG.name);
// the ACCOUNT a TRUST_NAMES server knows you by, apart from the shown name (a rename must not make you a stranger).
// Fixed at this browser's first real name; ?account= overrides; a server with sign-in ignores it.
{ let acct = params.get('account') || store?.getItem('ew-account') || '';
  if (!acct && !/^guest-/.test(CONFIG.name)) acct = CONFIG.name;
  CONFIG.account = acct || null; if (acct) store?.setItem('ew-account', acct); }

/** The join ack's name minus sendJoin's transport prefix ("renderer-" / "retina-"); pure, for net.js onSnapshot.
 *  A VERIFIED identity (yourSub) is the server's own name and is kept whole, prefix-like or not. */
export function nameFromJoinAck(you, { renderer = false, spectate = false, verified = false } = {}) {
  if (!you || verified) return you;
  const prefix = renderer ? 'renderer-' : spectate ? 'retina-' : '';
  return prefix && you.startsWith(prefix) ? you.slice(prefix.length) : you;
}

/** The front-door panel calls this before connecting. */
export function setName(name) {
  CONFIG.name = name;
  store?.setItem('ew-name', name);
  // a first visit loads as a guest, so the door's name is the first real one; a later rename never moves the account
  if (!CONFIG.account && name && !/^guest-/.test(name)) { CONFIG.account = name; store?.setItem('ew-account', name); }
}
export function setToken(token) {
  CONFIG.token = token;
  store?.setItem('ew-key', token);
}

// ------------------------------------------------------------ error routing
// modules call report(); ui.js decides how to show it (the console until it registers)
let errorSink = null;
export function setErrorSink(fn) { errorSink = fn; }

// A frame-loop fault reports 60×/s: identical messages are counted and re-reported on a decaying schedule.
const seenErrors = new Map(); // key -> { n, nextAt }
// ---- console tee: report() and window errors post to /clientlog, queued (one flush/s), never throwing.
// The key never goes in the payload or URL, only the Authorization header. `tee(line)` keeps a line ([xr] etc).
let teeQ = [], teeTimer = 0, teeMuted = false;
function teeFlush() {
  teeTimer = 0;
  if (!teeQ.length || teeMuted) return;
  const batch = teeQ.splice(0, 20);
  const url = `/clientlog?world=${encodeURIComponent(CONFIG.world ?? '')}`;
  const headers = { authorization: `Bearer ${CONFIG.token ?? ''}` };   // the door key never rides in a URL
  for (const line of batch) {
    try { fetch(url, { method: 'POST', body: line, headers, keepalive: true }).then((r) => { if (r.status === 401 || r.status === 404) teeMuted = true; }).catch(() => {}); }
    catch { /* the tee must never break the page */ }
  }
  if (teeQ.length) teeTimer = setTimeout(teeFlush, 1000);
}
const teeSeen = new Map();   // repeats cost one line, then one per 20
export function tee(line) {
  try {
    const who = CONFIG.name ?? '?';
    const key = String(line).slice(0, 160);
    if (!key.startsWith('[xr:rec]')) {
      const n = (teeSeen.get(key) ?? 0) + 1; teeSeen.set(key, n);
      if (n > 1 && n % 20 !== 0) return;
      if (n > 1) line = `${line} ×${n}`;
    }
    teeQ.push(`${who} ${String(line).slice(0, 3000)}`);
    if (teeQ.length > 200) teeQ.splice(0, teeQ.length - 200);
    if (!teeTimer) teeTimer = setTimeout(teeFlush, 1000);
  } catch { /* never */ }
}
/** For the line before something that may freeze the page (a GPU-process compile): not lost in the 1 s batch. */
export function teeNow(line) { tee(line); try { clearTimeout(teeTimer); teeFlush(); } catch { /* never */ } }
if (typeof window !== 'undefined') {
  window.addEventListener('error', (e) => tee(`[window.error] ${e.message} @ ${(e.filename ?? '').split('/').pop()}:${e.lineno}`));
  window.addEventListener('unhandledrejection', (e) => tee(`[unhandled] ${e.reason?.message ?? e.reason}`));
  // wake CAUSE, not just the URL: reload vs navigate vs back_forward separates a reload from a reconnect
  let cause = '?'; try { cause = performance.getEntriesByType('navigation')[0]?.type ?? '?'; } catch { /* old UA */ }
  tee(`[boot] cause=${cause} host=${location.host} ${location.pathname}${location.search.replace(/key=[^&]+/, 'key=…')} ua=${navigator.userAgent.slice(0, 120)}`);
}

export function report(context, err) {
  const message = err?.message ?? String(err ?? 'unknown error');
  const key = `${context}:${message}`;
  const now = performance.now();
  const rec = seenErrors.get(key) ?? { n: 0, nextAt: 0 };
  rec.n++;
  const suppressed = now < rec.nextAt;
  if (rec.n === 1 || rec.n % 20 === 0) tee(`[report] ${context}: ${message} ×${rec.n} :: ${String(err?.stack ?? '').split('\n').slice(1, 4).join(' | ').slice(0, 600)}`);
  if (!suppressed) {
    // the next report waits 2 s × the count so far, capped at 60 s: enough to show a fault is ongoing, not enough to drown
    rec.nextAt = now + Math.min(60000, 2000 * rec.n);
    console.error(context, err, rec.n > 1 ? `(×${rec.n})` : '');
    errorSink?.(context, rec.n > 1 ? `${message} (×${rec.n})` : message);
    bus.emit('error', { context, message, count: rec.n });
  }
  seenErrors.set(key, rec);
}
globalThis.addEventListener?.('unhandledrejection', (e) => report('async', e.reason));
globalThis.addEventListener?.('error', (e) => report('uncaught', e.error ?? e.message));

// ------------------------------------------------------------ misc helpers

/** Shortest signed angular difference, a → b. */
export function angleDelta(a, b) {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Bounded-concurrency map — prefetch must not be serial, nor open 50 sockets. */
export async function parallelMap(items, fn, limit = 6) {
  const q = [...items];
  await Promise.all(Array.from({ length: Math.min(limit, q.length) }, async () => {
    while (q.length) await fn(q.shift());
  }));
}

// ---- per-participant colour --------------------------------------------------
// Colour from the name alone, so it matches in every client with no server state. A curated palette (legible,
// distinct) beats hue = hash; amber and mint are absent because the UI uses them for mentions and links.
const NAME_COLORS = [
  '#7cc4ff', '#ff9fc4', '#b8e06a', '#ffab6b',
  '#c4a6ff', '#6ee0d0', '#ff9a8f', '#9fb8ff',
  '#e9a6ff', '#7fe0a0', '#d8c470', '#62d3f0',
];
/** FNV-1a: cheap, and spreads short similar names (bot1/bot2) far apart. */
export function preferredColor(name) {
  let h = 0x811c9dc5;
  const s = String(name ?? '').toLowerCase();
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return NAME_COLORS[h % NAME_COLORS.length];
}

// The hash is only a preference (12 colours, 6 people: ~78% collide): every client sorts the same roster and
// linear-probes, so all agree with nothing on the wire. Assigned colours stick, even after someone leaves.
const claimed = new Map();   // name -> colour, sticky once assigned

export function colorFor(name) {
  const k = String(name ?? '').toLowerCase();
  return claimed.get(k) ?? preferredColor(name);
}

/** Call on roster changes. */
export function assignColors(names) {
  const present = [...new Set(names.map((n) => String(n ?? '').toLowerCase()))].filter(Boolean).sort();
  const used = new Set();
  for (const n of present) {
    const start = NAME_COLORS.indexOf(preferredColor(n));
    let c = NAME_COLORS[start];
    for (let k = 1; used.has(c) && k <= NAME_COLORS.length; k++) {
      c = NAME_COLORS[(start + k) % NAME_COLORS.length];
    }
    used.add(c);
    claimed.set(n, c);
  }
  return claimed;
}

/** The 'avatar-worn' payload's name: mybody.announceWorn emits { name, path }, setMe emits a string. Every listener
 *  that keys anything by body name goes through here (bodies.js, xr.js). */
export const wornNameOf = (v) => (typeof v === 'string' ? v : v?.name) ?? '';
