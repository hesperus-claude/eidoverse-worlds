// The onset gate, driven one 20ms tick at a time: a key click must not open it, a voice must, and the HUD glyph's
// gold must be the gate's decision rather than a level of its own (R 10-17 gym: gold under the line; typing opened it at 80%).
// Run: bun tools/mic-gate-transient-test.mjs
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=t&name=p" });

let room = 0;   // the RMS the stub "microphone" hears right now
mock.module(new URL('../client/lib/audioctx.js', import.meta.url).pathname, () => ({
  audioContext: () => ({
    currentTime: 0, sampleRate: 48000, state: 'running',
    createAnalyser: () => ({ fftSize: 0, getFloatTimeDomainData(buf) { buf.fill(room); }, connect() {}, disconnect() {} }),
    createMediaStreamSource: () => ({ connect() {}, disconnect() {} }),
    createGain: () => ({ gain: { value: 0, setTargetAtTime(v) { this.value = v; } }, connect() {}, disconnect() {} }),
    createMediaStreamDestination: () => ({ stream: { getTracks: () => [], getAudioTracks: () => [] } }),
    createDelay: () => ({ delayTime: { value: 0, setTargetAtTime() {} }, connect() {}, disconnect() {} }),
  }),
}));
// every net.js export, as a no-op: the glyph's import graph reaches it, and nothing here may touch a socket
const NET = 'wireNet sendVerb sendAnim sendPuppet requestHistory requestDebug sendWorldFork sendWorldReset sendMod sendWhisper sendRelayCredRequest sendVoiceConsent sendTyping sendDrag sendJoin sendBodyDrag sendLease setPoseOverride sendPose sendPoseExact rejoin bounceToLogin initIdentity loginUrl connect teardownParticipant stalePresenceCount _dispatch'.split(' ');
// stt.js reaches ui.js (the whole page); the glyph only asks it two things
mock.module(new URL('../client/lib/stt.js', import.meta.url).pathname, () => ({ setSTT() {}, sttAvailable: () => false, sttOn: () => false }));
mock.module(new URL('../client/lib/net.js', import.meta.url).pathname, () => ({ net: {}, ...Object.fromEntries(NET.filter(n => n !== 'net').map(n => [n, () => {}])) }));

let ok = 0, bad = 0;
const t = (n, cond) => { cond ? ok++ : bad++; console.log(`${cond ? 'ok  ' : 'FAIL'} ${n}`); };

// ── 1. the machine itself, on a clock we hold ────────────────────────────────
const { makeOnsetGate } = await import('../client/lib/micgate.js');
let clock = 1_000_000, tick = null, lv = 0.001;
const realNow = Date.now, realSI = globalThis.setInterval;
Date.now = () => clock;
globalThis.setInterval = (fn) => { tick = fn; return 1; };
const g = makeOnsetGate({ level: () => lv, threshold: () => 0.25, drive() {}, announce() {} });
g.start();
globalThis.setInterval = realSI;
t('setup: start() handed us its tick', typeof tick === 'function');
const step = (level, n = 1) => { for (let i = 0; i < n; i++) { lv = level; clock += 20; tick(); } };
step(0.001, 40);                                   // settle + learn a quiet room (800ms)
t('setup: a quiet room is closed', g.info().speaking === false);

step(0.6, 1); step(0.001, 1);                      // one 20ms click
t('a single-tick transient does not open the gate', g.info().speaking === false);
step(0.001, 40);
step(0.6, 1); step(0.001, 1); step(0.6, 1); step(0.001, 1);   // typing: clicks 40ms apart
t('separate clicks do not add up to an open', g.info().speaking === false);
step(0.001, 40);
step(0.4, 2);                                      // a voice: sustained over the line
t('two consecutive ticks over the line open it', g.info().speaking === true);
step(0.001, 20);                                   // 400ms of quiet: inside the 700ms hang
t('the hang still holds through a pause', g.info().speaking === true);
step(0.001, 30);
t('and it closes after the hang', g.info().speaking === false);
Date.now = realNow;

// ── 2. the HUD glyph: gold under the line was the bug ────────────────────────
document.body.innerHTML = '<div id="hud"></div>';
const vc = await import('../client/lib/voiceconsent.js');
const ms = await import('../client/lib/micstate.js');
vc.setMicFloor(0.16);                              // 80%: the line is -12 dBFS ≈ 0.25 RMS
const track = { kind: 'audio', enabled: true, stop() {} };
ms.gateFor({ getTracks: () => [track], getAudioTracks: () => [track] });
await import('../client/lib/mictoggle.js');
const wait = (ms_) => new Promise(r => setTimeout(r, ms_));
const gold = () => (document.querySelector('#micbtn')?.innerHTML || '').includes('drop-shadow');
room = 0.001; await wait(1200);                    // settle the real gate
t('setup: the glyph exists', !!document.querySelector('#micbtn'));
room = 0.08; await wait(400);                      // well above the old fixed 0.02, well under the 0.25 line
t('glyph is NOT gold for a level under the sensitivity line', gold() === false && ms.micGateInfo().speaking === false);
room = 0.5; await wait(400);
t('glyph IS gold when the gate is open', gold() === true && ms.micGateInfo().speaking === true);

console.log(`${ok} ok, ${bad} failed`);
process.exit(bad ? 1 : 0);
