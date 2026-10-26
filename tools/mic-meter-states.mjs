// mic-meter-states: the sensitivity bar shows THREE states (off, under, live gold) and the gold LATCHES until it goes off.
// Hysteresis is what a screenshot can't show (a bar photographed mid-syllable looks right whether or not it strobes), so
// this drives the level and samples the colour at each step, including BELOW-after-ABOVE inside the release band (must
// stay gold) and below it (must drop).
//   node tools/mic-meter-states.mjs [origin]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const world = await ownedWorld({ live: process.argv[2] || null });
const ORIGIN = world.origin;
const { page, close } = await launchBrowser({ mic: true });
const shut = async () => { await close(); await world.close(); };
const pg = await page();
await pg.goto(`${ORIGIN}/?world=staging&name=metercheck`, { waitUntil: 'domcontentloaded' });
await pg.waitForSelector('#sec-audio-tab', { timeout: 20000 }).catch(() => {});
await new Promise((r) => setTimeout(r, 2000));
await pg.evaluate(() => {
  [...document.querySelectorAll('.sec-tabs .pf-tab')].find((h) => /audio/i.test(h.textContent || ''))?.click();
});
await pg.waitForFunction(() => !!document.querySelector('#sec-audio [data-lvl]'), null, { timeout: 20000 })
  .catch(() => {});

const r = await pg.evaluate(async () => {
  const lvl = document.querySelector('#sec-audio [data-lvl]');
  const thr = document.querySelector('#sec-audio [data-thr]');
  if (!lvl) return { error: 'no meter' };

  // take over the level source and mic state: __sfuMyLevel is what micLevelNow() prefers, the supported seam
  let fake = 0;
  window.__sfuMyLevel = () => fake;
  window.relayDiag = () => ({ micPublished: true, active: true });

  const settle = () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
  const colour = () => getComputedStyle(lvl).backgroundColor;
  const at = async (v) => { fake = v; await settle(); await settle(); return colour(); };

  // ask the module, don't parse the CSS: the marker's left is `calc(N% - 1px)`, which parseFloat misreads (floor=0
  // would make the OVER case unreachable)
  const vc = await import('./lib/voiceconsent.js');
  let floor = vc.micFloor();
  if (!(floor > 0)) { vc.setMicFloor(0.02); floor = vc.micFloor(); }

  const out = {};
  out.floor = floor;
  out.muted = await (async () => { window.relayDiag = () => ({ micPublished: false }); fake = 0;
    document.querySelector('#sec-audio [data-lvl]'); await settle();
    // force a repaint through the bus as the app would
    const m = await import('./lib/core.js'); m.bus.emit('audio:mic', false); await settle();
    const c = colour(); window.relayDiag = () => ({ micPublished: true, active: true });
    m.bus.emit('audio:mic', true); await settle(); return c; })();
  out.under = await at(floor * 0.3);          // on, well under → warm/dim
  out.over = await at(floor * 3);             // on, over → GOLD
  out.latched = await at(floor * 0.9);        // dipped INSIDE the release band → still gold
  out.released = await at(floor * 0.2);       // properly quiet → drops
  out.marker = getComputedStyle(thr).backgroundColor;
  return out;
});

if (r.error) { console.log('FAIL:', r.error); await shut(); process.exit(1); }

const GOLD = 'rgb(255, 214, 107)';
const rows = [
  ['mic muted     ', r.muted, (c) => c !== GOLD],
  ['on, under floor', r.under, (c) => c !== GOLD],
  ['on, OVER floor ', r.over, (c) => c === GOLD],
  ['dipped in band ', r.latched, (c) => c === GOLD],   // the hysteresis half
  ['quiet again    ', r.released, (c) => c !== GOLD],
];
let ok = true;
console.log(`floor = ${r.floor.toFixed(4)}`);
for (const [label, c, want] of rows) {
  const good = want(c);
  ok = ok && good;
  console.log(`  ${label}  ${c.padEnd(20)} ${good ? '✅' : '❌'}`);
}
const markerWhite = /255, 255, 255/.test(r.marker);
console.log(`  threshold marker  ${r.marker} ${markerWhite ? '✅ white' : '❌ not white'}`);
ok = ok && markerWhite;
console.log(ok ? '✅ THREE STATES + LATCH' : '❌ meter states wrong');
await shut();
process.exit(ok ? 0 : 1);
