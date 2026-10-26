// ---- live voice as presence --------------------------------------
// The sound is already live, so the visible half is too: mouth driven by real amplitude, 🎙 while speaking.
// STT stays on the log plane, landing afterward as an ordinary say.

import { CONFIG, bus } from './base.js';
import { micOn as meshMicOn, isMuted, micAnalyserLevel as meshMicLevel } from './micstate.js';

import { remotes, noteSpeaking } from './remotes.js';
import { sendTyping } from './net.js';
import { getMe } from './mybody.js';

// Read whichever transport is live: the SFU bridge's globals first, micstate.js for your own mic; peer levels
// come only from the SFU (an empty Map before it installs).
const micIsOn = () => {
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return !!meshMicOn();
  } catch { return false; }
};
const myLevel = () => {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel();
  } catch { return 0; }
};
const allPeerLevels = () => {
  try {
    if (typeof window.relayPeerLevels === 'function') return window.relayPeerLevels();
    return new Map();
  } catch { return new Map(); }
};

const VOICE_GATE = 0.045;        // below this is room tone, not speech
let _micGlyphOn = false, _micGlyphAt = 0, _micTail = 0;

export function updateVoiceMouths(now) {
  // mine: local analyser, no round trip
  const me = getMe();
  if (me) {
    const live = micIsOn() && !isMuted();
    me.voiceLevel = live ? myLevel() : null;
    // 🎙 means sound is coming out of me, not "mic on": it tracks actual speech, with a tail so pauses don't strobe.
    const speaking = live && me.voiceLevel > VOICE_GATE;
    if (speaking) _micTail = now + 900;
    const show = now < _micTail;
    if (show !== _micGlyphOn || (show && now - _micGlyphAt > 1500)) {
      _micGlyphOn = show; _micGlyphAt = now;
      sendTyping(null, show ? 'mic' : null);
      me.setTyping(show ? 'mic' : null);
    }
    if (speaking) me.speakUntil = now + 400;   // keeps head/gaze life going
  }
  // theirs: one analyser per inbound stream
  const levels = allPeerLevels();
  for (const [id, r] of remotes) {
    const lv = levels.get(id);
    if (r.avatar) r.avatar.voiceLevel = lv == null ? null : lv;
    if (lv != null && lv > VOICE_GATE) noteSpeaking(id, 600);
  }
}

// Two-plane speech, timer-free: captions are the live performance; the logged say carries spoken:true and
// world.js never re-performs it. caption and speech share this one routine.
function performSpeech({ actor, text }) {
  const av = actor === CONFIG.name ? getMe() : remotes.get(actor)?.avatar;
  av?.say(text);
  if (actor !== CONFIG.name) noteSpeaking(actor, Math.min(12000, 3000 + text.length * 30));
}
// side-effecting on import (the emitters.js pattern): these are pure
// subscriptions, and nothing can emit either event before connect()
bus.on('caption', performSpeech);
bus.on('speech', performSpeech);
