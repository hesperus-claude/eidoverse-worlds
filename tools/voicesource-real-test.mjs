// voiceSource(), IMPORTED from client/lib/voicesource.js and exercised: only the BROWSER SURFACE (navigator.mediaDevices,
// the minimum WebAudio the synth path touches) is stubbed, so reverting the micWanted fix goes red. happy-dom gives the
// real DOM core.js's import needs (as tools/tts-fault-test.ts).
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { mock } from "bun:test";
GlobalRegistrator.register({ url: "http://localhost/?world=test&name=probe" });

// voicesource.js needs only `report` from core.js, which builds a WebGPURenderer at import: mock the MODULE, not the logic
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
const { voiceSource, setSynthProvider, setGeneratorRebuildHook, notifySynthTrackChanged } = mod;
if (typeof setSynthProvider !== "function") { console.log("FAIL — setSynthProvider not exported; test would pass vacuously"); process.exit(1); }

let pass = 0, fail = 0;
const check = (name, cond) => { cond ? (pass++, console.log(`ok   ${name}`))
                                     : (fail++, console.log(`FAIL ${name}`)); };

// 1. no provider, mic works → the microphone
gumCalls = 0; gumBehaviour = 'ok';
let s = await voiceSource();
check('mic available and wanted → microphone', s.kind === 'microphone' && gumCalls === 1);

// 2. mic switched off + provider available → synth, WITHOUT opening a device.
// the real provider contract: start() returns a TRACK, which synthStream() wraps in a MediaStream marked .synthetic
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });
gumCalls = 0;
s = await voiceSource({ micWanted: false });
// 🔴 ASSERT THE POSITIVE (.synthetic === true), not "not a microphone": voicesfu.js's re-acquire-after-synth guard
// branches on the flag
check('mic OFF + provider → synthetic source', !!s && s.synthetic === true);
check('mic OFF source is NOT a microphone', s.kind !== 'microphone');
check('mic OFF does not call getUserMedia', gumCalls === 0);

// 3. default stays mic: every existing call site unchanged
gumCalls = 0;
s = await voiceSource();
check('default (micWanted omitted) still takes the mic', s.kind === 'microphone' && gumCalls === 1);

// 3b. the provider contract: start() must yield a usable track; assert the track rather than trusting the wrapper
const tracks = typeof s.getTracks === 'function' ? s.getTracks() : [];
check('synthetic stream carries a real track', tracks.length === 1 && tracks[0] != null);

// a provider whose start() yields nothing must FAIL LOUDLY, not publish silence (the strict stub throws as a browser does)
setSynthProvider({ available: () => true, start: () => null });
let m4threw = false;
try { await voiceSource({ micWanted: false }); } catch { m4threw = true; }
check('provider.start() returning null throws, not silent publish', m4threw);
setSynthProvider({ available: () => true, start: () => ({ kind: 'audio', stop() {} }) });

// 4. original fallback intact: gUM throws + provider → synth
gumBehaviour = 'throw'; gumCalls = 0;
s = await voiceSource();
check('gUM throws + provider → synthetic (original path)', !!s && s.synthetic === true);

// 5. negative control: no provider + gUM throws → must THROW, never silently mute. A provider reporting unavailable is
// the same state as none from the caller's view (setSynthProvider(null) may be guarded)
setSynthProvider({ available: () => false, start: () => { throw new Error('must not be called'); } });
let threw = false;
try { await voiceSource(); } catch { threw = true; }
check('no provider + no mic → throws (does not fake a source)', threw);

// 6. mic OFF + no provider publishes nothing and never opens the device
gumBehaviour = 'ok'; gumCalls = 0;
let offThrew = false;
try { await voiceSource({ micWanted: false }); } catch { offThrew = true; }
check('mic OFF + no provider → throws, getUserMedia untouched', offThrew && gumCalls === 0);

// 7. two transports register the rebuild hook: both fire, a thrower does not silence the rest, and unsubscribe works
const fired = [];
const offs = [() => fired.push('mesh'), () => { throw new Error('sfu blew up'); }, () => fired.push('sfu-later')].map(setGeneratorRebuildHook);
notifySynthTrackChanged({ kind: 'audio' });
check('every rebuild hook fires; a throwing one does not silence the rest', fired.join() === 'mesh,sfu-later');
offs.forEach((off) => off());
notifySynthTrackChanged({ kind: 'audio' });
check('…and an unsubscribed hook no longer fires', fired.length === 2);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
