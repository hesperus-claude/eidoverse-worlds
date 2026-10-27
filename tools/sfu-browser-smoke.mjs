// sfu-browser-smoke: TWO real Chromium bodies through the IN-PROCESS SFU: real getUserMedia, Opus and Chrome SDP, which
// loopback werift peers can never prove.
//   BASE=http://127.0.0.1:8946 bun tools/sfu-browser-smoke.mjs
//   (server must be running with VOICE_TRANSPORT=sfu)
import { chromium } from 'playwright';

// 🔴 ONLY MEANINGFUL OVER A REAL NETWORK: localhost is a free secure context and ICE picks loopback, skipping the real
// exchange; a localhost BASE runs, flagged as no evidence.
// No BASE ⇒ own a scratch child (VOICE_TRANSPORT=sfu, nonce identity), never an ambient port
import { ownedWorld } from './probe-harness.mjs';
const world = process.env.BASE ? null
  : await ownedWorld({ env: { VOICE_TRANSPORT: 'sfu' } });
const BASE = process.env.BASE ?? world.origin;
const LOCAL = /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])/.test(BASE);
if (LOCAL) {
  console.log('  \x1b[33m⚠ LOCALHOST RUN — inner-loop only, NOT evidence the SFU works.\x1b[0m');
  console.log('    Real check: BASE=$(tools/tunnel-up.sh) node tools/sfu-browser-smoke.mjs');
} else {
  console.log(`  \x1b[36mreal-network run via ${BASE}\x1b[0m`);
}
const KEY = process.env.KEY ?? (world ? world.key : 'dev');
const browser = await chromium.launch({
  executablePath: process.env.SFU_TEST_CHROME ?? process.env.CHROME ?? undefined,
  args: [
    // --use-fake-device gives a deterministic tone, so the envelope check is a THRESHOLD; a real mic in a quiet room would fail
    '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream',
    '--autoplay-policy=no-user-gesture-required',
    // 🔴 WSL has no sound card: give Chromium a null audio sink, or WebAudio dies and the analyser reads 0.000, which
    // looks like silence. What's measured is unchanged
    '--disable-features=AudioServiceOutOfProcess',
    '--alsa-output-device=null',
  ],
});

let failed = false;
const ok = (m) => console.log(`  \x1b[32m✅\x1b[0m ${m}`);
const bad = (m) => { console.log(`  \x1b[31m❌\x1b[0m ${m}`); failed = true; };

const mk = async (name) => {
  const pg = await (await browser.newContext({ permissions: ['microphone'] })).newPage();
  pg.on('console', (m) => { if (/sfu|error/i.test(m.text())) console.log(`  [${name}] ${m.text().slice(0, 140)}`); });
  pg.on('pageerror', (e) => console.log(`  [${name}] PAGEERROR ${String(e).slice(0, 140)}`));
  await pg.goto(`${BASE}/?world=staging&key=${KEY}&name=${name}`);
  // 🔴 THERE IS A FRONT DOOR: main.js calls start() only from openDoor's onEnter (#d-go), so click through like a visitor
  await pg.waitForSelector('#d-go', { timeout: 20000 }).catch(() => {});
  const nameField = await pg.$('#d-name');
  if (nameField) await nameField.fill(name).catch(() => {});
  await pg.click('#d-go').catch(() => {});
  // page boot is ~13s under load, so 90s is the floor, not slack (a live observation, no preserved artifact)
  await pg.waitForFunction(() => window.relayDiag?.().active === true, null, { timeout: 90000 });
  return pg;
};

try {
  console.log('launching A (speaker) and B (listener) against the in-process SFU…');
  const A = await mk('smoke-a');
  const B = await mk('smoke-b');
  ok(`both connected: ${await A.evaluate(() => relayDiag().identity)} + ${await B.evaluate(() => relayDiag().identity)}`);

  // the transport must be OURS, not a LiveKit leg that happened to be up: a pass against the wrong server is worthless
  const t = await A.evaluate(() => relayDiag().transport);
  t === 'sfu' ? ok('transport is the in-process SFU (no LiveKit)') : bad(`transport reported "${t}", expected "sfu"`);

  await A.evaluate(() => window.relayMic());
  await A.waitForFunction(() => relayDiag().micPublished === true, null, { timeout: 30000 });
  ok('A publishing a real getUserMedia track');

  await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(true));
  await B.waitForFunction(() => relayDiag().speakers.some((s) => s.hasStream), null, { timeout: 30000 });
  ok('B subscribed to A — server-enforced, POST-consent');

  // THE ONE SPEECH CHECK: packet counters can be right while the audio is silence; amplitude at the listener's element is the proof
  const level = await B.evaluate(async () => {
    let peak = 0;
    for (let i = 0; i < 40; i++) {
      for (const v of window.relayPeerLevels().values()) peak = Math.max(peak, v);
      await new Promise((r) => setTimeout(r, 100));
    }
    return peak;
  });
  console.log(`  envelope peak at B for A: ${level.toFixed(3)}`);
  level > 0.02 ? ok('AUDIO IS FLOWING browser → our SFU → browser')
               : bad('no audible envelope at B');

  // revocation must be a memory write, not an SDP round trip: measure it.
  // 🔴 only meaningful if audio was flowing: with a dead analyser "audio stopped" is vacuous, so it fails BOTH rows
  if (!(level > 0.02)) bad('revocation unmeasurable — envelope instrument was dead before revoke');
  const t0 = Date.now();
  await B.evaluate(async () => (await import('./lib/voiceconsent.js')).setReceiveVoice(false));
  const quiet = await B.evaluate(async () => {
    for (let i = 0; i < 30; i++) {
      let peak = 0;
      for (const v of window.relayPeerLevels().values()) peak = Math.max(peak, v);
      if (peak < 0.005) return true;
      await new Promise((r) => setTimeout(r, 50));
    }
    return false;
  });
  quiet ? ok(`consent revoked → audio stopped in ~${Date.now() - t0}ms`)
        : bad('audio survived revocation');

  // server-side truth, not just what the client believes
  const diag = await (await fetch(`${BASE}/relay-diag?world=staging`)).json();
  console.log(`  server diag: forwarded=${diag.forwarded} suppressed=${JSON.stringify(diag.suppressed)}`);
  diag.forwarded > 0 ? ok('server confirms it forwarded packets')
                     : bad('server forwarded nothing — client may be hearing itself');
} catch (e) {
  bad(`threw: ${String(e).slice(0, 300)}`);
} finally {
  await browser.close();
  if (world) await world.close();
}

console.log(failed ? '\n\x1b[31m❌ sfu-browser-smoke: FAIL\x1b[0m' : '\n\x1b[32m✅ sfu-browser-smoke: PASS\x1b[0m');
process.exit(failed ? 1 : 0);
