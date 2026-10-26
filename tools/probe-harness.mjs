// probe-harness: the owned foundations every browser probe shares (#131).
// 1. Browser: `SFU_TEST_CHROME` override (as the sfu mini-smoke) ▸ else Playwright's MANAGED browser for the pinned
//    version (`bunx playwright install chromium` fetches it per platform). Never a hardcoded Linux path.
// 2. `ownedWorld()` spawns a child bound to a per-run nonce in scratch state and REFUSES to proceed unless the responder
//    proves it is ours (as boot-check), never an ambient fixed port. A LIVE deployment is explicit: pass its origin,
//    identity checks skipped.
import { chromium } from 'playwright';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';

// vrMicChoice: the pre-VR mic step (client/lib/vrmic.js) would stop every visor-clicking probe, so contexts start as a
// browser that answered "not now"; tools/vrmic-probe.mjs passes null to drive it
/** SFU_TEST_CHROME override ▸ managed browser. `mic: true` adds the fake-media flags (and mic permission). */
export async function launchBrowser({ mic = false, vrMicChoice = 'later' } = {}) {
  const exe = process.env.SFU_TEST_CHROME;
  const args = mic ? ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required'] : [];
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
