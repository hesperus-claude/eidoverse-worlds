// bun tools/sky-state-probe.mjs — World › sky over the REAL sky and log: a log reaches "world: …", a preview adds "you:",
// unrelated log entries and a rated sky write nothing. Every you: cause and control row is tools/skypanel-state-test.ts.
// Cloud quality is set to off BEFORE load: a software-rendered cloud bake can exhaust a machine.
import { launchBrowser, ownedWorld, checker, skyBoot } from './probe-harness.mjs';
const { check, done } = checker();
const world = await ownedWorld({ owner: 'skystate', env: { TRUST_NAMES: '1' } });   // the page owns staging, so its @world writes are admitted
const { browser, page } = await launchBrowser();
try {
  const pg = await page();
  const errs = []; pg.on('pageerror', (e) => errs.push(String(e)));
  await skyBoot(pg, world, 'skystate', { query: '', ready: () => globalThis.__ewEngineUp && document.querySelector('#sec-sky-tab') });
  await pg.evaluate(() => document.querySelector('#sec-sky-tab').click());
  await pg.waitForFunction(() => document.querySelector('#sec-sky .sky-state'), null, { timeout: 20000 });
  const read = () => pg.evaluate(() => {
    const w = document.querySelector('#sec-sky .state-world')?.textContent ?? null;
    const y = document.querySelector('#sec-sky .state-you'); return { w, y: y && !y.hidden ? y.textContent : null };
  });
  const settle = async () => {
    const t0 = Date.now();
    // polled inside one evaluate: waitForFunction(async fn) resolves at once on the returned Promise (review 3, M2)
    try { await pg.evaluate(async () => { const s = await import('./lib/sky.js'); const t0 = performance.now();
      while (s.skyRendering() && performance.now() - t0 < 120000) await new Promise((r) => setTimeout(r, 200)); }); }
    catch (e) { console.log('    unsettled after 120 s:', JSON.stringify(await read())); throw e; }
    console.log(`    settled in ${Date.now() - t0} ms`);
  };
  const log = async (a) => { await pg.evaluate(async (x) => { const { sendRequest } = await import('./lib/net.js'); const r = await sendRequest('set', { id: '@world', component: 'sky', value: x, merge: true }); if (!r.ok) throw new Error(`sky refused: ${JSON.stringify(r.refused)}`); }, a); await pg.waitForTimeout(1500); await settle(); return read(); };
  const dusk = await log({ hours: 18.5, rate: 0, clouds: 'cumulus', weather: 'clear' });
  check('a logged sky reads as world: 18:30 · clear · clouds cumulus', /^world: 18:30 · clear · clouds cumulus$/.test(dusk.w ?? ''), dusk.w);
  check('clouds⚙ off against a cloudy log: "you:" says so', /no clouds \(your clouds⚙ is off\)/.test(dusk.y ?? ''), dusk.y);
  // a preview: the view changes, the log doesn't
  await pg.evaluate(async () => { const s = await import('./lib/sky.js'); await s.previewSky({ ...s.loggedSky().args, hours: 7 }); });
  await settle();
  const prev = await read();
  check('a preview leaves world: alone', prev.w === dusk.w, prev.w);
  check('…and adds "you: previewing (not logged)"', /previewing \(not logged\)/.test(prev.y ?? ''), prev.y);
  // someone logs a sky while you preview: the view follows the log, and "previewing" is gone
  const noon = await log({ hours: 12, rate: 0, clouds: 'clear', weather: 'clear' });   // not rain: its weather system in software crosses the memory floor
  check('world: follows a new log', /^world: 12:00 · clear · clouds clear$/.test(noon.w ?? ''), noon.w);
  check('the new log ends the preview, and clear clouds need no clouds⚙ note', noon.y === null, noon.y);
  // unrelated log entries don't touch the readout (in VR any write re-rasterises the panel)
  const quiet = await pg.evaluate(async () => {
    const el = document.querySelector('#sec-sky .sky-state'); let n = 0;
    const mo = new MutationObserver((l) => { n += l.length; }); mo.observe(el, { childList: true, characterData: true, subtree: true, attributes: true });
    const { sendRequest } = await import('./lib/net.js');
    const made = await sendRequest('create', { id: '$ssq1', components: { transform: { pos: [3, 1, 3], q: [0, 0, 0, 1], scale: [1, 1, 1] }, light: { color: 0xffd9a0, intensity: 4, range: 5 } } });
    if (!made.ok) throw new Error(`light refused: ${JSON.stringify(made.refused)}`);
    await new Promise((r) => setTimeout(r, 1200));
    await sendRequest('delete', { id: made.ids['$ssq1'] });
    await new Promise((r) => setTimeout(r, 1200));
    // and refreshes that change nothing (the 30 s sun tick, a degrade notice) must not write either
    const { bus } = await import('./lib/base.js');
    for (let i = 0; i < 3; i++) bus.emit('sky-degraded', { msg: 'probe: no-op refresh' });
    await new Promise((r) => setTimeout(r, 300));
    mo.disconnect(); return n;
  });
  check('unrelated log entries leave the readout untouched (0 mutations)', quiet === 0, quiet);
  // M3: a rated sky re-renders every second; the you: line must not flash 'loading…' at 1 Hz (a VR panel re-raster each)
  await log({ hours: 12, rate: 60, clouds: 'clear', weather: 'clear' });
  await pg.waitForTimeout(1500);
  const flashes = await pg.evaluate(async () => {
    const you = document.querySelector('#sec-sky .state-you'); let n = 0;
    const mo = new MutationObserver(() => { n++; }); mo.observe(you, { childList: true, characterData: true, subtree: true, attributes: true });
    await new Promise((r) => setTimeout(r, 5000)); mo.disconnect(); return n; });
  console.log('    rated-sky you: mutations in 5 s:', flashes);
  check('a rated sky does not flash loading… every second (0 you: writes in 5 s)', flashes === 0, flashes);
  check('no page errors', errs.length === 0, errs.slice(0, 2).join(' | ') || 'none');
} catch (e) { check('probe ran', false, String(e).slice(0, 300)); }
finally { await browser.close(); await world.close(); }
done();
