// stt — your voice, written down. The agent-inclusion half of voice chat.
//
// Speech is transcribed client-side and spoken into the world as ordinary
// `say` verbs prefixed "🎙 ", so transcripts land in the same log agents
// already read and their wake triggers never learn voice exists. The prefix
// survives the server's say-fold and doubles as captions for sound-off humans.
//
// Engine: the browser's SpeechRecognition, which is CLOUD-based on every
// platform (the audio goes to Google). Phones work about half the time, and
// Android's `continuous` is broken (restarted in onend; each restart plays the
// OS earcon). Field notes and how to measure: docs/research/stt-browser-recognition.md.

import { say } from './net.js';
import { report, bus } from './base.js';
import { sttConsented } from './voiceconsent.js';
import { flashHint } from './ui.js';
// flashHint is a 2.6s OVERLAY, not a log: a failure worth telling someone goes to chat too.
// Lazy: a static chat.js import drags core.js into every headless test that mocks core; losing an advisory line on a
// failed import is fine.
const logChat = (who, text) => import('./chat.js').then((m) => m.logChat(who, text)).catch(() => {});
// The mic's real state; this module's capture must never outlive it. Ask whichever
// transport is ACTUALLY running (the mesh's micOn() is null forever on an SFU client).
import { micOn as meshMicOn } from './micstate.js';
function micIsLive() {
  try {
    // SFU first: on relay-spike it is the default, and its bridge publishes
    // __sfuMicOn only when that transport actually initialised.
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }   // unreadable state = not live = stay silent
}

let rec = null;
let wanted = false;
let uttSeq = 0;                 // one id per transcribed utterance (log plane)
// Readable from /audio on a device with no console.
try { window.__sttOn = () => wanted; } catch { /* no window */ }

// Module scope, assigned at load: a diagnostic that only exists once STT has run
// reads exactly like "no events". The tally persists across on/off toggles.
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
  // The language is a prime suspect for nomatch (a wrong-language recognizer
  // returns confident nothing); reported so the phone can tell us.
  rec.lang = navigator.language || 'en-US';
  try { window.__sttLang = rec.lang; } catch { /* no window */ }
  // Speech-onset presence does NOT live here: it rides voice.js's local
  // analyser, so declining vendor transcription keeps an audible presence.
  rec.onresult = (e) => {
    // Count final AND interim results: a stream of interims that never
    // finalizes (Android) looks exactly like silence from outside.
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
      // The LOG plane: the sound already reached the room live, so this record
      // must never re-perform the utterance (spoken: true, like the agent voice).
      // 🔴 GATE THE EMIT TOO: a result can arrive after the mic went off, and one
      // leaked line is a private sentence in a public log. `wanted` is intent,
      // micIsLive() is reality; any disagreement resolves to silence.
      if (!wanted || !micIsLive()) continue;
      if (text) { ++uttSeq; say(`🎙 ${text}`, { spoken: true, utt: uttSeq, live: true }); }
    }
  };
  // Chrome ends recognition on silence — restart while still wanted.
  // 🔴 AND ONLY WHILE THE MIC IS ACTUALLY ON: SpeechRecognition holds its OWN
  // microphone, independent of WebRTC, so the mic toggle must govern EVERY
  // capture. Fails closed: if micOn cannot be read, we stop.
  rec.onend = () => {
    // Count the restarts: on Android the session ends every few seconds, and a
    // session that dies that fast never survives to finalize.
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
  // 🔴 A CAPTION ENGINE THAT NEVER STARTS MUST SAY SO (report() is console-only).
  // The errors worth naming, each with a different fix:
  //   audio-capture — something else holds the mic (SpeechRecognition takes its
  //     OWN capture; Android is strict about two consumers of one device).
  //   not-allowed   — scoped separately from getUserMedia: a working WebRTC mic
  //     does NOT imply STT is permitted.
  //   network       — the recognizer is Google's; it can fail while the page is fine.
  let sawAudio = false;
  // The last event is READABLE from the page (/audio prints it): the phone has no console.
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
  // nomatch: a FINAL result with nothing confidently recognised (distinct from
  // no-speech and from non-final results). soundstart is any audio, speechstart
  // is SPEECH: a "captions are broken" test must key on speech with no result,
  // never on the absence of results (a cough is not speech).
  rec.onsoundstart = () => mark('sound detected (not necessarily speech)', 'sound');
  rec.onspeechstart = () => mark('SPEECH detected', 'speech');
  rec.onspeechend = () => mark('speech ended', 'speechend');
  rec.onnomatch = () => {
    mark('nomatch — heard something, recognised nothing', 'nomatch');
    // Tell them it missed (a silent miss reads as "the world dropped my line"):
    // one quiet local line, never a `say` (a failed transcription is not an
    // utterance), at most one every 30s.
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

// Running STT is DERIVED STATE, not a click's side effect: consent AND a live mic
// AND a recognizer, re-evaluated on both events (a mic turned on by the audio
// panel or a reconnect replay must start captions too). flipMic still ASKS for
// consent the first time.
function syncSTT() {
  const want = sttConsented() && micIsLive() && sttAvailable();
  if (want !== wanted) setSTT(want);
}
bus.on('audio:mic', syncSTT);
bus.on('audio:stt-consent', syncSTT);
