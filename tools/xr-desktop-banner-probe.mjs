// xr-desktop-banner-probe — the desktop banner is a function of the session (xrmirror.js): the killswitch's banner
// outranks 'In VR' (desktop view off), which outranks none; it follows the pref mid-session and leaves at exit. Real
// client + IWER: the desktop view's own killswitch (30 frames over 30 ms) trips on headless frames once released.
//   bun tools/xr-desktop-banner-probe.mjs
import { launchBrowser, ownedWorld, checker, iwerInit, visorShown, enterVR } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({});
const { browser, page } = await launchBrowser(); const pg = await page();
await iwerInit(pg, { cloud: 'off' });
const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
const ev = (fn, a) => Promise.race([pg.evaluate(fn, a), new Promise((_, rej) => setTimeout(() => rej(new Error('page main thread pinned for 30 s')), 30000))]);
const IN_VR = /^In VR/, KILLED = /costing the headset frames/;
const text = () => ev(async () => (await import('./lib/xrmirror.js')).mirrorBannerText());
// set the pref, then read: the banner follows xr:prefs synchronously
const pref = (m) => ev(async (v) => { (await import('./lib/xr.js')).setXrPref('mirror', v); return (await import('./lib/xrmirror.js')).mirrorBannerText(); }, m);
const row = (label, got, want) => check(`${label}: ${want ? `says ${want === KILLED ? 'why the mirror stopped' : "'In VR'"}` : 'no banner'}`, want ? want.test(got ?? '') : got === null, String(got));
try {
  await pg.goto(`${world.origin}/?world=staging&name=deskbanner&key=${world.key}&xr=1`, { waitUntil: 'domcontentloaded', timeout: 60000 });
  await visorShown(pg);
  await pg.waitForFunction(() => !!globalThis.__xrMirror, null, { timeout: 30000 });
  check("'mirror my eyes' is the default", (await ev(async () => (await import('./lib/xr.js')).xrPrefs.mirror)) === 'first');
  await ev(() => { globalThis.__xrMirror.holdKill = true; });   // the killswitch waits until the kill rows
  row('before VR', await text(), null);
  await pref('off');
  await enterVR(pg);
  row('entered with the desktop view off', await text(), IN_VR);
  row('pref → first', await pref('first'), null);
  row('pref → off', await pref('off'), IN_VR);
  row('pref → third', await pref('third'), null);
  // the killswitch, released on a mirroring pref: headless frames are slow enough to trip it
  await ev(() => { globalThis.__xrMirror.holdKill = false; });
  const tripped = await pg.waitForFunction(() => !!document.querySelector('.xr-mirror-off'), null, { timeout: 150000, polling: 1000 }).then(() => true, () => false);
  check('(setup) the killswitch tripped', tripped && (await ev(() => globalThis.__xrMirror.killed === true)));
  row('the killswitch trips', await text(), KILLED);
  const box = await ev(() => { const b = document.querySelector('.xr-mirror-off'); if (!b) return null; const r = b.getBoundingClientRect();
    return { cx: Math.round(r.left + r.width / 2 - innerWidth / 2), cy: Math.round(r.top + r.height / 2 - innerHeight / 2), z: getComputedStyle(b).zIndex }; });
  check('…centred on the desktop, over the frames', box && Math.abs(box.cx) <= 2 && Math.abs(box.cy) <= 2 && Number(box.z) > 60, JSON.stringify(box));
  await pg.waitForTimeout(3000);
  row('…3 s later (not a toast)', await text(), KILLED);
  row('killed, pref → off', await pref('off'), KILLED);
  row('killed, pref → first', await pref('first'), KILLED);
  row('killed, pref → third', await pref('third'), KILLED);
  await ev(async () => { await window.__iwerDevice.activeSession?.end(); });
  // the exit rebuild pins the headless main thread past short polls: wait on the observable
  await pg.waitForFunction(() => !globalThis.EW?.renderer?.xr?.isPresenting && !document.querySelector('.xr-mirror-off'), null, { timeout: 90000, polling: 500 }).catch(() => {});
  row('the session ended', await text(), null);
  check('no page errors', errs.length === 0, errs.slice(0, 3).join(' | '));
} catch (e) { check('probe ran', false, e.message); }
finally { try { await browser.close(); } catch {} try { await world.close(); } catch {} }
done();
