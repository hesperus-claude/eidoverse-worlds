// stt — speech becomes an ordinary `say` prefixed "🎙 ", so agents read it from the log and never learn voice exists.
// PRIVACY: webkitSpeechRecognition is cloud (Google) on every platform; no setting keeps the audio on the device.
// Mobile works about half the time; don't disable it there (docs/research/android-captions.md). /audio stt: speech×N, final×0 = broken.
// Android ignores `continuous`; the onend restart plays the OS earcon (https://issues.chromium.org/issues/40324711).

import { say } from './net.js';
import { report, bus } from './base.js';
import { sttConsented } from './voiceconsent.js';
import { flashHint } from './ui.js';
// failures also go to the persistent chat log; lazy, since chat.js drags core.js into headless tests that mock core
const logChat = (who, text) => import('./chat.js').then((m) => m.logChat(who, text)).catch(() => {});
// capture must never outlive the mic
import { micOn as meshMicOn } from './micstate.js';
function micIsLive() {
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }   // unreadable state = not live = stay silent
}

let rec = null;
let wanted = false;
let uttSeq = 0;
export const sttOn = () => wanted;
// for /audio on a device with no console
try { window.__sttOn = () => wanted; } catch { /* no window */ }

// module scope: a probe absent until used reads as "no events", and the tally spans on/off toggles
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
  if (on && wanted && rec) return;      // never rebuild a running recognizer
  wanted = on;
  if (!on) { try { rec?.stop(); } catch { /* already stopped */ } rec = null; return; }
  const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
  if (!SR) { const m = 'no speech recognition in this browser — voice works, captions don’t'; flashHint(m); logChat('*', m); wanted = false; return; }
  rec = new SR();
  rec.continuous = true;
  rec.interimResults = false;
  // a wrong language returns nomatch, not an error; exposed for /audio
  rec.lang = navigator.language || 'en-US';
  try { window.__sttLang = rec.lang; } catch { /* no window */ }
  // speech-onset presence lives in micstate.js, so declining transcription keeps an audible presence
  rec.onresult = (e) => {
    // count interims: ones that never finalize (common on Android) otherwise look like silence
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
      // spoken:true: the sound already reached the room, so this must never re-perform it
      // gate the emit too: a late result after mic-off would leak a private line; disagreement resolves to silence
      if (!wanted || !micIsLive()) continue;
      if (text) { ++uttSeq; say(`🎙 ${text}`, { spoken: true, utt: uttSeq, live: true }); }
    }
  };
  // SpeechRecognition holds its own mic, so restart only while wanted AND the mic is live; fails closed
  rec.onend = () => {
    // on Android the session dies every 6-8 s, too fast to ever finalize
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
  // a caption engine that never starts must say so; each error is named because each has its own fix
  let sawAudio = false;
  rec.onaudiostart = () => { sawAudio = true; mark('audio reached the recognizer', 'audiostart'); };
  rec.onstart = () => {
    mark('started', 'start');
    // started but no audio is the mic-contention signature, otherwise invisible
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
  // a "captions broken" test must key on speechstart with no result, never on missing results (a cough is sound)
  rec.onsoundstart = () => mark('sound detected (not necessarily speech)', 'sound');
  rec.onspeechstart = () => mark('SPEECH detected', 'speech');
  rec.onspeechend = () => mark('speech ended', 'speechend');
  rec.onnomatch = () => {
    mark('nomatch — heard something, recognised nothing', 'nomatch');
    // so a miss isn't taken for a dropped line: local only, never a `say`, at most one per 30 s
    const now = Date.now();
    if (now - lastMissNotice > 30_000) {
      lastMissNotice = now;
      logChat('*', '(didn\u2019t catch that)');
    }
  };
  rec.onerror = (e) => {
    mark(`error: ${e.error}`, `err:${e.error}`);
    if (e.error === 'no-speech' || e.error === 'aborted') return;
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

// derived state, not a click's side effect: the mic can turn on from the audio panel or a reconnect replay
function syncSTT() {
  const want = sttConsented() && micIsLive() && sttAvailable();
  if (want !== wanted) setSTT(want);
}
bus.on('audio:mic', syncSTT);
bus.on('audio:stt-consent', syncSTT);
