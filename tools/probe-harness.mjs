// probe-harness: the owned foundations every browser probe shares (#131).
// 1. Browser: `SFU_TEST_CHROME` override (as the sfu mini-smoke) ▸ else Playwright's MANAGED browser for the pinned
//    version (`bunx playwright install chromium` fetches it per platform). Never a hardcoded Linux path.
// 2. `ownedWorld()` spawns a child bound to a per-run nonce in scratch state and REFUSES to proceed unless the responder
//    proves it is ours (as boot-check), never an ambient fixed port. A LIVE deployment is explicit: pass its origin,
//    identity checks skipped.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

// vrMicChoice: the pre-VR mic step (client/lib/vrmic.js) would stop every visor-clicking probe, so contexts start as a
// browser that answered "not now"; tools/vrmic-probe.mjs passes null to drive it
/** SFU_TEST_CHROME override ▸ managed browser. `mic: true` adds the fake-media flags (and mic permission). */
export async function launchBrowser({ mic = false, vrMicChoice = 'later', args: extra = [] } = {}) {
  const exe = process.env.SFU_TEST_CHROME;
  const args = [...(mic ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required'] : []), ...extra];
  const b = await chromium.launch({ ...(exe ? { executablePath: exe } : {}), args });
  // BOOT_CHECK_VIEWPORT=390x844 drives a probe at any viewport; without it Playwright's default hides layouts that only
  // fit the authoring viewport
  const vp = (process.env.BOOT_CHECK_VIEWPORT || '').match(/^(\d+)x(\d+)$/);
  const viewport = vp ? { width: +vp[1], height: +vp[2] } : null;
  const page = async () => {
    // touch is a precondition: the dock leaves the left edge only when body has class 'touch', so without it the landscape
    // dock/action-bar overlap is invisible. BOOT_CHECK_TOUCH=1 turns it on.
    const touch = process.env.BOOT_CHECK_TOUCH === '1';
    const ctx = await b.newContext({
      ...(mic ? { permissions: ['microphone'] } : {}),
      ...(viewport ? { viewport } : {}),
      ...(touch ? { hasTouch: true, isMobile: true } : {}),
    });
    if (vrMicChoice) await ctx.addInitScript((v) => { try { if (!localStorage.getItem('ew-vr-mic-choice')) localStorage.setItem('ew-vr-mic-choice', v); } catch { /* opaque origin */ } }, vrMicChoice);
    return ctx.newPage();
  };
  return { browser: b, page, close: () => b.close() };
}

/** Spawn a world server this run OWNS, prove it's ours, return origin + teardown. `live: "http://host:port"` probes a
 *  deployment instead (identity unchecked). */
const LIVE_CHILDREN = new Set(), scratchOf = new Map();
let signalsArmed = false;
function armSignals() {
  if (signalsArmed) return; signalsArmed = true;
  const onSignal = (sig) => {
    for (const c of LIVE_CHILDREN) { try { c.kill('SIGKILL'); } catch { /* gone */ } try { rmSync(scratchOf.get(c), { recursive: true, force: true }); } catch {} }
    process.exit(sig === 'SIGINT' ? 130 : 143);
  };
  process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal);
  // an UNCAUGHT throw skips the signal handlers: the same sweep here, so every probe is covered with or without try/finally
  const onThrow = (err) => {
    for (const c of LIVE_CHILDREN) { try { c.kill('SIGKILL'); } catch { /* gone */ } try { rmSync(scratchOf.get(c), { recursive: true, force: true }); } catch {} }
    console.error(err?.stack ?? String(err));
    process.exit(1);
  };
  process.once('uncaughtException', onThrow); process.once('unhandledRejection', onThrow);
}

// `worlds`: founded in the scratch WORLDS_DIR before boot. The server never founds on join (a name with no world is
// refused), so a page reaching ?world=<name> needs it founded; staging and commons always are. `owner` founds them.
export async function ownedWorld({ live = null, key = process.env.JOIN_KEY || 'dev', env: extraEnv = {}, worlds = [], owner = 'owner' } = {}) {
  if (live) return { origin: live, key, owned: false, close: async () => {} };
  // a wide range makes collisions rare; the nonce echo is what rejects another run's server
  const PORT = 8981 + Math.floor(Math.random() * 800);
  const scratch = mkdtempSync(join(tmpdir(), 'probe-'));
  const NONCE = randomUUID();
  // process.execPath only works under bun (node can't run TS): an absolute bun serves both; BUN_PATH overrides
  const BUN = process.execPath.includes('bun') ? process.execPath
    : (process.env.BUN_PATH || 'bun');
  for (const name of new Set(['staging', 'commons', ...worlds])) {
    const r = spawnSync(BUN, ['tools/protocol/world.ts', 'found', name, '--owner', owner], { env: { ...process.env, WORLDS_DIR: scratch, BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0' }, encoding: 'utf8' });
    if (r.status !== 0) { try { rmSync(scratch, { recursive: true, force: true }); } catch {} throw new Error(`ownedWorld: founding "${name}" failed: ${r.stdout}${r.stderr}`); }
  }
  const srv = spawn(BUN, ['server/server.ts'], {
    // SKIP_OPT_SWEEP by default: a probe server shares the checkout's OPT_DIR (assets/opt), and its boot sweeps would
    // build variants INTO the directory a live world serves from. A probe that wants the sweep passes it in env.
    env: { ...process.env, SKIP_OPT_SWEEP: '1', PORT: String(PORT), JOIN_TOKEN: key, WORLDS_DIR: scratch,
           EIDO_BOOT_NONCE: NONCE, ...extraEnv },
    stdio: ['ignore', 'ignore', 'ignore'],
  });
  const origin = `http://127.0.0.1:${PORT}`;
  // identity is the nonce echo ONLY (/version echoes EIDO_BOOT_NONCE): a responder without it fails at once. Every live
  // child dies with us on any signal, even mid-poll (one handler over a module-level set).
  LIVE_CHILDREN.add(srv); scratchOf.set(srv, scratch); armSignals();
  const verdict = await proveOwned(origin, NONCE, { alive: () => (srv.exitCode === null ? true : `exited ${srv.exitCode}`) });
  const ours = verdict.ours, reason = verdict.reason;
  const close = async () => {
    LIVE_CHILDREN.delete(srv); scratchOf.delete(srv);
    try { srv.kill('SIGTERM'); } catch { /* gone */ }
    await new Promise((r) => { const t = setTimeout(() => { try { srv.kill('SIGKILL'); } catch {} r(); }, 3000);
      srv.once('exit', () => { clearTimeout(t); r(); }); });
    try { rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  if (!ours) { await close(); throw new Error(`owned world never came up as OURS (${reason})`); }
  return { origin, key, owned: true, close };
}

/** The identity check alone, so a test can show the NEGATIVE (a responder without our nonce is refused). Polls
 *  `origin`/version up to `attempts` times, 250ms apart; `alive()` is true while the awaited thing could still come
 *  up, else a reason string. Resolves { ours, reason }. */
export async function proveOwned(origin, nonce, { attempts = 60, alive = () => true } = {}) {
  let ours = false, reason = 'never answered';
  for (let i = 0; i < attempts && !ours; i++) {
    const a = alive();
    if (a !== true) { reason = String(a); break; }
    try {
      const v = await (await fetch(`${origin}/version`, { signal: AbortSignal.timeout(1000) })).json();
      if (v.nonce === undefined) { reason = 'responder has no nonce field (stale pre-nonce listener)'; break; }
      ours = v.nonce === nonce;
      if (!ours) { reason = 'wrong nonce (not our child)'; break; }
    } catch { /* not up yet */ }
    if (!ours) await new Promise((r) => setTimeout(r, 250));
  }
  return { ours, reason };
}

/** Uniform pass/fail counting with a nonzero exit: a probe that can't fail is a console.log, not a receipt. */
export function checker() {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = '') => {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}${ok ? '' : '  ' + extra}`);
    ok ? pass++ : fail++;
  };
  const done = () => {
    console.log(`\n${fail === 0 ? '\x1b[32m' : '\x1b[31m'}${pass} passed, ${fail} failed\x1b[0m`);
    process.exit(fail ? 1 : 0);
  };
  return { check, done };
}

// IWER under the real client: its device loop pinned to a native rAF, refused unless the pattern matched exactly once
// (memory: reference_iwer_headless_probe.md §2; an IWER bump that moves the line must turn every IWER probe red)
export const IWER_LOOP = 'globalThis.requestAnimationFrame(this[P_SESSION].onDeviceFrame)';
export function iwerSource(raw = readFileSync(new URL('../node_modules/iwer/build/iwer.js', import.meta.url), 'utf8')) {
  const n = raw.split(IWER_LOOP).length - 1;
  if (n !== 1) throw new Error(`iwer build changed: expected exactly one '${IWER_LOOP}', found ${n} (the native-rAF pin would silently not apply)`);
  return 'globalThis.__iwerNativeRAF = globalThis.requestAnimationFrame.bind(globalThis);\n' +
    raw.replace(IWER_LOOP, 'globalThis.__iwerNativeRAF(this[P_SESSION].onDeviceFrame)');
}

/** Before any client code: an emulated Quest 3 installed with forceInstall (headless Chromium ships a navigator.xr stub
 *  IWER otherwise won't replace), kept as window.__iwerDevice and hidden from the product (no window.IWER: a real
 *  headset's branch). `cloud`: the ew-cloud-quality the page boots with (null leaves it alone). */
export async function iwerInit(pg, { cloud = null } = {}) {
  if (cloud != null) await pg.addInitScript((q) => { try { localStorage.setItem('ew-cloud-quality', q); } catch {} }, cloud);
  await pg.addInitScript(iwerSource());
  await pg.addInitScript(() => {
    const { XRDevice, metaQuest3 } = window.IWER ?? {};
    if (!XRDevice) return;   // window.__iwerDevice stays unset: probes gate on it
    const d = new XRDevice(metaQuest3); d.installRuntime({ forceInstall: true });
    window.__iwerDevice = d;
    try { delete window.IWER; } catch { window.IWER = undefined; }
  });
}

/** The visor the product shows (#xrbtn displayed). `me`: also wait for a joined avatar. */
export async function visorShown(pg, { timeout = 90000, me = false } = {}) {
  await pg.waitForFunction((m) => { const b = document.querySelector('#xrbtn'); return !!b && getComputedStyle(b).display !== 'none' && (!m || !!globalThis.EW?.me?.()); }, me, { timeout });
}

/** Click the real visor and wait until three presents. */
export async function enterVR(pg, { timeout = 30000 } = {}) {
  await pg.evaluate(() => document.querySelector('#xrbtn').click());
  await pg.waitForFunction(() => globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout, polling: 250 });
}

/** End the emulated session; resolves whether or not three stopped presenting within `timeout`. */
export async function exitVR(pg, { timeout = 60000 } = {}) {
  await pg.evaluate(async () => { await window.__iwerDevice.activeSession?.end(); });
  return pg.waitForFunction(() => !globalThis.EW?.renderer?.xr?.isPresenting, null, { timeout, polling: 500 }).then(() => true, () => false);
}

/** Off-tier sky boot: clouds off before load, the real client on staging, the engine up, then `sky` set on @world (the
 *  world needs `owner: name` + TRUST_NAMES so the write is admitted) and, with `baked`, the baked tier waited for. */
export async function skyBoot(pg, world, name, { sky = null, baked = false, query = '&lite=0', ready = () => globalThis.__ewEngineUp } = {}) {
  await pg.goto(`${world.origin}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.evaluate(() => localStorage.setItem('ew-cloud-quality', 'off'));
  await pg.goto(`${world.origin}/?world=staging&name=${name}&key=${world.key}${query}`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await pg.waitForFunction(ready, null, { timeout: 120000 });
  if (sky) await pg.evaluate(async (v) => { const { sendRequest } = await import('./lib/net.js'); const r = await sendRequest('set', { id: '@world', component: 'sky', value: v, merge: true }); if (!r.ok) throw new Error(`sky refused: ${JSON.stringify(r.refused)}`); }, sky);
  if (baked) for (let i = 0; i < 90 && !(await pg.evaluate(async () => (await import('./lib/sky_baked.js')).bakedActive())); i++) await pg.waitForTimeout(1000);
}

// RAW3: a page of real three + client/lib modules, served from client/ by route (no world server), on SwiftShader
const CLIENT = fileURLToPath(new URL('../client/', import.meta.url));
const TYPES = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.html': 'text/html', '.json': 'application/json', '.wasm': 'application/wasm' };
export const RAW3_IMPORTMAP = '<script type="importmap">{"imports":{"three":"./node_modules/three/build/three.webgpu.js","three/webgpu":"./node_modules/three/build/three.webgpu.js","three/tsl":"./node_modules/three/build/three.tsl.js"}}</script>';
/** `html` at http://probe.local/; `errors` collects page errors and console errors; `result(ms, q)` loads `/?q` and
 *  awaits window.__probe, or `{ error }` after `ms`. */
export async function raw3Page(html) {
  const { browser, page } = await launchBrowser({ vrMicChoice: null, args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
  const pg = await page(); const errors = [];
  pg.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
  pg.on('pageerror', (e) => errors.push(String(e)));
  await pg.route('http://probe.local/**', (route) => {
    const path = decodeURIComponent(new URL(route.request().url()).pathname);
    if (path === '/') return route.fulfill({ body: html, contentType: 'text/html' });
    const f = join(CLIENT, path);
    if (!f.startsWith(CLIENT) || !existsSync(f)) return route.fulfill({ status: 404, body: 'nope' });
    return route.fulfill({ body: readFileSync(f), contentType: TYPES[extname(f)] ?? 'application/octet-stream' });
  });
  const result = async (ms, q = '') => {
    if (q) await pg.goto('about:blank');
    await pg.goto(`http://probe.local/${q ? `?${q}` : ''}`);
    return Promise.race([pg.evaluate(() => window.__probe), new Promise((r) => setTimeout(() => r({ error: `probe timed out (${ms / 1000} s)` }), ms))]);
  };
  return { browser, page: pg, errors, result, close: () => browser.close() };
}
