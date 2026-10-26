// panel-teardown-probe: the audio panel must UPDATE, not rebuild, or rows visibly jump on the tick after a click.
// The claim is NODE IDENTITY (screenshots and syntax checks can't see it): this tags every row, clicks, and looks for its
// own tags afterwards; a rebuilt panel loses them. It also watches the meter's rAF chain: micFloorRow's beat() ends on
// !row.isConnected, so a teardown silently restarts the animation.
//   node tools/panel-teardown-probe.mjs [origin]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const world = await ownedWorld({ live: process.argv[2] || null });
const ORIGIN = world.origin;
const { page, close } = await launchBrowser({ mic: true });
const shut = async () => { await close(); await world.close(); };
const pg = await page();
pg.on('pageerror', (e) => console.log('  [pageerror]', String(e).slice(0, 140)));
await pg.goto(`${ORIGIN}/?world=staging&key=${world.key}&name=panelprobe`, { waitUntil: 'domcontentloaded' });
// the panel frame is built during boot; clicking a head before it exists is a no-op that looks like a broken selector
await pg.waitForSelector('#sec-audio-tab', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));

// open the 🔊 audio section; click and CHECK are separate calls: makeSection's toggle awaits onOpen(body), so a sleep in
// the same evaluate() races the build it waits for
await pg.evaluate(() => {
  const head = [...document.querySelectorAll('.sec-tabs .pf-tab')].find((h) => /audio/i.test(h.textContent || ''));
  head?.click();
});
// the audiopanel's settings rows are .sp-row.row with .nm labels; gate on checkbox rows existing (the panel's own
// controls, so a lone-resident owned world renders them all)
const opened = await pg.waitForFunction(
  () => [...(document.querySelector('#sec-audio .body')?.querySelectorAll('.row') ?? [])]
    .filter((r) => r.querySelector('input[type=checkbox]')).length >= 2,
  null, { timeout: 20000 },
).then(() => true).catch(() => false);
if (!opened) { console.log('FAIL: could not open the audio section'); await shut(); process.exit(1); }

const r = await pg.evaluate(async () => {
  const body = document.querySelector('#sec-audio .body');
  const rows = () => [...body.querySelectorAll('.row')];

  // tag every row object: only surviving NODES keep an expando
  rows().forEach((el, i) => { el.__probeTag = `row${i}`; });
  const before = rows().length;

  // the meter's width-setting node, plus a live sample of whether the rAF loop still ticks after the click
  const meterEl = body.querySelector('[data-lvl]');
  if (meterEl) meterEl.__probeTag = 'meter';

  // click EVERY checkbox (a probe proves only the path it walks; the TTS tick has its own build()), identified by LABEL,
  // not index, which drifts when a row is skipped
  const labels = [...body.querySelectorAll('.row')]
    .filter((r) => r.querySelector('input[type=checkbox]') && r.style.display !== 'none')
    .map((r) => r.querySelector('.nm')?.textContent?.trim())
    .filter(Boolean);
  const perBox = [];
  for (const label of labels) {
    const rowOf = () => [...body.querySelectorAll('.row')]
      .find((r) => r.querySelector('.nm')?.textContent?.trim() === label);
    const live = rowOf()?.querySelector('input[type=checkbox]');
    if (!live) continue;
    // let the previous restore click settle before tagging, or its repaint contaminates this iteration
    await new Promise((r) => setTimeout(r, 250));
    rows().forEach((el, n) => { el.__probeTag = `row${n}`; });
    const n0 = rows().length;
    live.click();
    await new Promise((r) => setTimeout(r, 500));
    const survived = rows().filter((el) => typeof el.__probeTag === 'string').length;
    perBox.push({ label, before: n0, survived, after: rows().length });
    live.click();  // put it back
    await new Promise((r) => setTimeout(r, 400));
  }

  const after = rows();
  const kept = after.filter((el) => typeof el.__probeTag === 'string').length;
  const meterKept = body.querySelector('[data-lvl]')?.__probeTag === 'meter';

  return { before, after: after.length, kept, meterKept, perBox };
});

let ok = r.meterKept;
for (const b of r.perBox) {
  const good = b.survived === b.before;
  ok = ok && good;
  console.log(`  ${String(b.label).padEnd(24)} ${b.survived}/${b.before} rows survived  ${good ? '✅' : '❌ TEARDOWN'}`);
}
console.log(`  meter node kept: ${r.meterKept ? '✅' : '❌'}`);
console.log(ok ? '✅ PER-ELEMENT UPDATE — every checkbox leaves the panel standing'
               : '❌ FULL TEARDOWN on at least one control (R\'s jumping)');
await shut();
process.exit(ok ? 0 : 1);
