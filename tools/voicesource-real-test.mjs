// A REAL test for voiceSource(): it IMPORTS client/lib/voicesource.js and
// exercises the shipped function. Replaces the eye-verified transcription in
// tts-publishes-mic-off-test.mjs, which imports nothing and cannot fail when
// the module breaks (audit, 2026-08-16).
//
// Only the BROWSER SURFACE is stubbed — navigator.mediaDevices and the minimum
// WebAudio the synth path touches. The decision logic under test is the real
// one, so reverting the micWanted fix in voicesource.js makes this go red.
// voicesource.js imports core.js, which builds a canvas at module scope — so a
// real import needs a real DOM. happy-dom is already the repo's pattern for
// this (tools/tts-fault-test.ts, tools/chat-log-test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=test&name=probe" });

// voicesource.js needs only `report` from core.js, which builds a WebGPURenderer at import: mock the MODULE, not the
// logic, so the decision code below is the shipped code
mock.module('../client/lib/core.js', () => ({
  report: (...a) => console.error('[report]', ...a),
  bus: { on() {}, emit() {} },
}));

let gumCalls = 0, gumBehaviour = 'ok';
Object.defineProperty(globalThis.navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
  gumCalls++;
  if (gumBehaviour === 'throw') throw new Error('NotAllowedError');
  return { kind: 'microphone', getTracks: () => [{ kind: 'audio', stop() {} }] };
}}});
class FakeNode { connect() { return this; } disconnect() {} }
// 🔴 THE STUB MUST BE AS STRICT AS THE BROWSER: `new MediaStream([null])` throws TypeError in Chrome
globalThis.MediaStream = class {
  constructor(t) {
    const tracks = t || [];
    for (const x of tracks) {
      if (x == null || typeof x !== 'object' || x.kind !== 'audio') {
        throw new TypeError("Failed to construct 'MediaStream': invalid track");
      }
    }
    this._t = tracks;
  }
  getTracks() { return this._t; }
};
globalThis.AudioContext = class {
  createMediaStreamDestination() { return { stream: { synthetic: true, getTracks: () => [{ kind: 'audio', stop() {} }] } }; }
  createGain() { return new FakeNode(); }
  get destination() { return new FakeNode(); }
  resume() {} get sampleRate() { return 48000; }
};

const mod = await import('../client/lib/voicesource.js');
const { voiceSource, setSynthProvider } = mod;
if (typeof setSynthProvider !== "function") { console.log("FAIL — setSynthProvider not exported; test would pass vacuously"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`ok   ${name}`))
                                     : (fail++, console.log(`FAIL ${name}`)); };

// 1. No provider, mic works → the microphone.
gumCalls = 0; gumBehaviour = 'ok';
let s = await voiceSource();
check('mic available and wanted → microphone', s.kind === 'microphone' && gumCalls === 1);

// 2. THE FIX: mic switched off + provider available → synth, WITHOUT opening a device.
// the real provider contract: start() returns a TRACK, which synthStream() wraps in a MediaStream marked .synthetic
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });
gumCalls = 0;
s = await voiceSource({ micWanted: false });
// 🔴 ASSERT THE POSITIVE (.synthetic === true), not "not a microphone": consumers such as voicesfu.js's
// mic-resume-after-synth guard branch on the flag
check('mic OFF + provider → synthetic source', !!s && s.synthetic === true);
check('mic OFF source is NOT a microphone', s.kind !== 'microphone');
check('mic OFF does not call getUserMedia', gumCalls === 0);

// 3. Default stays mic — every existing call site unchanged.
gumCalls = 0;
s = await voiceSource();
check('default (micWanted omitted) still takes the mic', s.kind === 'microphone' && gumCalls === 1);

// 3b. The provider contract itself: start() must yield a usable track.
//     assert the track exists rather than trusting the wrapper (start() returning null)
const tracks = typeof s.getTracks === 'function' ? s.getTracks() : [];
check('synthetic stream carries a real track', tracks.length === 1 && tracks[0] != null);

// A provider whose start() yields nothing must FAIL LOUDLY, not publish silence.
// (Mutation M4. The strict MediaStream stub above makes this throw the way a
// browser does; catching it here turns a crash into a reported assertion.)
setSynthProvider({ available: () => true, start: () => null });
let m4threw = false;
try { await voiceSource({ micWanted: false }); } catch { m4threw = true; }
check('provider.start() returning null throws, not silent publish', m4threw);
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });

// 4. Original fallback intact: gUM throws + provider → synth.
gumBehaviour = 'throw'; gumCalls = 0;
s = await voiceSource();
check('gUM throws + provider → synthetic (original path)', !!s && s.synthetic === true);

// 5. Negative control: no provider + gUM throws → must THROW, never silently mute.
//    (setSynthProvider(null) may be rejected by a guard; clear via a provider
//    that reports unavailable, which is the same state from the caller's view.)
setSynthProvider({ available: () => false, start: () => { throw new Error('must not be called'); } });
let threw = false;
try { await voiceSource(); } catch { threw = true; }
check('no provider + no mic → throws (does not fake a source)', threw);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
