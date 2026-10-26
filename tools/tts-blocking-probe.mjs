// tts-blocking-probe: does a long utterance freeze the page? Reports the worst rAF frame gap (~16 ms healthy) with a
// stub synthesizer that spins on purpose, so it measures our scheduling, not piper.
//   node tools/tts-blocking-probe.mjs [origin]
import { launchBrowser, ownedWorld } from './probe-harness.mjs';

const world = await ownedWorld({ live: process.argv[2] || null });
const ORIGIN = world.origin;
const { page, close } = await launchBrowser({ mic: true });
const shut = async () => { await close(); await world.close(); };
const pg = await page();
await pg.goto(`${ORIGIN}/?world=staging&name=blockprobe`, { waitUntil: 'domcontentloaded' });
await new Promise((r) => setTimeout(r, 3000));

const LONG = "Right, here's a good long one for you to push the sliders around on. "
  + "I'm going to keep talking for a while so you have something continuous to work with, "
  + "rather than a short clip that ends before you've found the control you wanted. "
  + "This sentence exists purely to make the whole thing long enough to matter, "
  + "because a short utterance cannot demonstrate the problem at all.";

const r = await pg.evaluate(async (text) => {
  const tts = await import('./lib/tts.js');

  // stands in for ort.run(): each call blocks 300 ms, so an UNCHUNKED run is unmistakably worse
  let calls = 0;
  tts.setTtsSource(async (t) => {
    calls++;
    const spin = 300 * Math.max(1, Math.round(t.length / 60));   // cost scales with length, like RTF
    const end = performance.now() + spin;
    while (performance.now() < end) { /* block, as inference does */ }
    return { pcm: new Int16Array(1024), sampleRate: 22050 };
  }, 'blocking stub');
  tts.setTtsEnabled(true);

  let worst = 0, frames = 0, last = performance.now();
  let running = true;
  const tick = () => {
    if (!running) return;
    const now = performance.now();
    worst = Math.max(worst, now - last);
    last = now; frames++;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  const t0 = performance.now();
  await tts.speak(text, 'probe');
  const total = performance.now() - t0;
  running = false;
  return { worst: Math.round(worst), frames, calls, total: Math.round(total) };
}, LONG);

console.log(`  synth calls      ${r.calls}   (1 = never chunked)`);
console.log(`  total time       ${r.total}ms`);
console.log(`  frames observed  ${r.frames}`);
console.log(`  WORST frame gap  ${r.worst}ms`);
// one blocking slice per chunk is unavoidable; a single gap spanning the whole utterance must not happen
const chunked = r.calls > 1;
const ok = chunked && r.worst < r.total * 0.6;
console.log(ok ? '✅ CHUNKED — the page gets the thread back between pieces'
               : '❌ the page is blocked for essentially the whole utterance');
await shut();
process.exit(ok ? 0 : 1);
