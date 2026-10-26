// stt — your voice, written down: the agent-inclusion half of voice chat.
//
// Speech becomes an ordinary `say` prefixed "🎙 ", so it lands in the log agents already read and their wake
// triggers never learn voice exists; the prefix survives the say-fold and doubles as captions.
//
// PRIVACY: webkitSpeechRecognition is cloud (Google) on every platform; no setting keeps the audio on the device.
// Mobile STT works about half the time; don't disable it there. /stt (and /stt say) reports the live tallies:
// speech×N with result:final×0 is the broken case. Android ignores `continuous`, so we restart in onend, which
// plays the OS earcon each time (https://issues.chromium.org/issues/40324711).

import { say } from './net.js';
import { report, bus } from './base.js';
import { sttConsented } from './voiceconsent.js';
import { flashHint } from './ui.js';
// flashHint is a 2.6s overlay, so failures also go to the chat log, which persists.
// Lazy import: a static chat.js import drags core.js into headless tests that mock core.
const logChat = (who, text) => import('./chat.js').then((m) => m.logChat(who, text)).catch(() => {});
// The mic's real state; this module's capture must never outlive it. Ask whichever transport is running.
import { micOn as meshMicOn } from './micstate.js';
function micIsLive() {
  try {
    // SFU first: its bridge publishes __sfuMicOn only once that transport initialised
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }   // unreadable state = not live = stay silent
}

let rec = null;
let wanted = false;
let uttSeq = 0;                 // one id per transcribed utterance (log plane)
export const sttOn = () => wanted;
// Readable from /audio on a device with no console.
try { window.__sttOn = () => wanted; } catch { /* no window */ }

// Module scope, assigned at load: a probe that's absent until used reads as "no events", and the tally must
// accumulate across on/off toggles.
const tally = Object.create(null);
let lastMissNotice = 0;
let restarts = 0;
const firstStart = performance.now();
function mark(what, kind) {
  try {
    if (kind) tally[kind] = (tally[kind] ?? 0) + 1;
    window.__sttLast = what;
  } catch { /* no window */ }
}
try {
  window.__sttTally = () =>
    Object.entries(tally).map(([k, n]) => `${k}×${n}`).join(' ') || 'no events yet';
} catch { /* no window */ }
export const sttAvailable = () => !!(window.SpeechRecognition ?? window.webkitSpeechRecognition);

export function setSTT(on) {
  if (on && wanted && rec) return;      // already running — never rebuild the recognizer
  wanted = on;
  if (!on) { try { rec?.stop(); } catch { /* already stopped */ } rec = null; return; }
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR) { const m = 'no speech recognition in this browser — voice works, captions don’t'; flashHint(m); logChat('*', m); wanted = false; return; }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  // A recognizer asked for the wrong language returns nomatch, not an error; expose the lang for /audio.
  rec.lang = navigator.language || 'en-US';
  try { window.__sttLang = rec.lang; } catch { /* no window */ }
  // Speech-onset presence lives in micstate.js, not here, so declining transcription keeps an audible presence.
  rec.onresult = (e) => {
    // Count interim results too: interims that never finalize (common on Android) look like silence otherwise.
    let fin = 0, interim = 0;
    for (let i = e.resultIndex; i < e.results.length; i++) {
      (e.results[i].isFinal ? fin++ : interim++);
    }
    try {
      mark(`results: ${fin} final, ${interim} interim`
        + (fin === 0 && interim > 0 ? '  ← hearing you, never finalizing' : ''),
        fin ? 'result:final' : 'result:interim');
    } catch { /* no window */ }
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (!e.results[i].isFinal) continue;
      const text = e.results[i][0].transcript.trim();
      // The log plane: the sound already reached the room live, so this must never re-perform it (spoken:true).
      // Gate the emit as well as the restart: a late result after mic-off would leak a private line; `wanted` is
      // intent, micIsLive() is reality, and any disagreement resolves to silence.
      if (!wanted || !micIsLive()) continue;
      if (text) { ++uttSeq; say(`🎙 ${text}`, { spoken: true, utt: uttSeq, live: true }); }
    }
  };
  // Chrome ends recognition on silence: restart only while wanted AND the mic is live. SpeechRecognition holds
  // its own mic, so the mic toggle must govern it too; fails closed if the mic state can't be read.
  rec.onend = () => {
    // Count restarts: on Android the session dies every 6-8 s, too fast to ever finalize.
    restarts++;
    const secs = ((performance.now() - firstStart) / 1000).toFixed(0);
    if (wanted && micIsLive()) {
      try {
        rec.start();
        mark(`ended+restarted ${restarts}× in ${secs}s${restarts >= 3 ? '  ← the session keeps dying; captions cannot finalize' : ''}`, 'end');
      } catch (err) { mark(`restart failed: ${err?.message ?? err}`); report('stt restart', err); }
    }
    else if (wanted) { wanted = false; rec = null; mark('stopped: mic is off'); report('stt', 'stopped: mic is off'); }
  };
  // A caption engine that never starts must say so. Errors are named because each has its own fix:
  // audio-capture (another consumer holds the mic), not-allowed (scoped apart from getUserMedia),
  // network (the recognizer is Google's).
  let sawAudio = false;
  // The phone has no console, so the last event must be readable from the page (/audio prints it).
  rec.onaudiostart = () => { sawAudio = true; mark('audio reached the recognizer', 'audiostart'); };
  rec.onstart = () => {
    mark('started', 'start');
    // Give it a beat: if recognition starts but never receives audio, that is
    // the contention signature and it is otherwise invisible.
    setTimeout(() => {
      if (wanted && !sawAudio) {
        mark('started but NO audio after 4s (mic contention?)');
        const m = 'captions: recognition started but no audio reached it — '
          + 'another app or tab may hold the microphone';
        flashHint(m); logChat('*', m);
        report('stt', 'started but onaudiostart never fired (mic contention?)');
      }
    }, 4000);
  };
  // nomatch = a final result with nothing recognised (not no-speech). Sound isn't speech: a "captions broken"
  // test must key on speechstart with no result, never on missing results (a cough raises soundstart alone).
  rec.onsoundstart = () => mark('sound detected (not necessarily speech)', 'sound');
  rec.onspeechstart = () => mark('SPEECH detected', 'speech');
  rec.onspeechend = () => mark('speech ended', 'speechend');
  rec.onnomatch = () => {
    mark('nomatch — heard something, recognised nothing', 'nomatch');
    // Say it missed, so a miss isn't mistaken for a dropped line: a local chat line, never a `say`, at most
    // one per 30 s.
    const now = Date.now();
    if (now - lastMissNotice > 30_000) {
      lastMissNotice = now;
      logChat('*', '(didn\u2019t catch that)');
    }
  };
  rec.onerror = (e) => {
    mark(`error: ${e.error}`, `err:${e.error}`);
    if (e.error === 'no-speech' || e.error === 'aborted') return;   // ordinary silence
    report('stt', e.error);
    const said = {
      'audio-capture': 'captions: something else is holding the microphone',
      'not-allowed': 'captions: speech recognition was denied — it needs its own permission, separate from the mic',
      'service-not-allowed': 'captions: speech recognition was denied by the browser or OS',
      'network': 'captions: the speech recognizer is unreachable (it runs on Google servers, not locally)',
      'language-not-supported': `captions: no recognizer for ${rec.lang}`,
    }[e.error];
    const m = said ?? `captions stopped: ${e.error}`;
    flashHint(m); logChat('*', m);
  };
  try { rec.start(); } catch (e) { report('stt', e); wanted = false; }
}

// Running STT is derived state (consent AND a live mic AND a recognizer), not a click's side effect: the
// mic can turn on from the audio panel or a reconnect replay. flipMic still asks for consent the first time.
function syncSTT() {
  const want = sttConsented() && micIsLive() && sttAvailable();
  if (want !== wanted) setSTT(want);
}
bus.on('audio:mic', syncSTT);
bus.on('audio:stt-consent', syncSTT);
