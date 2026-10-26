// voiceconsent — voice is opt-in both ways, default OFF: "don't send my voice" and "don't play voices at me".
// Receive-off means the offer is never answered: no audio path exists. Agent voice (TTS/captions) is voice and
// mutable like a human's; world ambience is a settings slider, not the 🎧 toggle.

import { bus } from './base.js';

const KEY = 'eido.audio.prefs';
// sttConsent is tri-state on purpose: null never asked, true, false refused (a boolean would re-prompt a refusal).
// volWorld defaults to 1 (hear it as authored); its one consumer is the world bus in sounds.js, and anything
// playing placed or ambient audio should end there.
const DEFAULTS = { recvVoice: false, volVoices: 1, volWorld: 1, volTts: 1, sttConsent: null,
  // gate sensitivity: 0..0.2 maps to 0..100% of the -60..0 dBFS track (gateThresholdDb); 0.12 = 60% = -24 dBFS,
  // found by testing in a real room
  micFloor: 0.12,
  // push-to-talk: the gate opens on a held key instead of level; opt-in for rooms a level gate can't survive
  pttMode: false };

let prefs = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) prefs = { ...DEFAULTS, ...JSON.parse(raw) };
} catch { /* corrupt prefs must never keep anyone out of the world */ }

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

// How far a voice carries: full within VOICE_FULL_M, silent past VOICE_SILENT_M (voicesfubridge.js's rolloff, the
// client half of the server's proximity gate). "Near" for anything about being heard is inside
// VOICE_SILENT_M — past it nobody hears you whatever their settings say.
export const VOICE_FULL_M = 3, VOICE_SILENT_M = 20;

export const audioPrefs = () => ({ ...prefs });
export const receivingVoice = () => prefs.recvVoice;
export const volumeFor = (cat) => (
  cat === 'world' ? prefs.volWorld : cat === 'tts' ? prefs.volTts : prefs.volVoices);

export function setReceiveVoice(on) {
  const next = !!on;
  if (next === prefs.recvVoice) return prefs.recvVoice;
  prefs.recvVoice = next; save();
  // voice.js tears inbound peers down / permits them on this event; nothing
  // else may open an inbound stream without consulting receivingVoice().
  bus.emit('audio:receive', next);
  return next;
}

/** Momentary silence without revoking consent: the stream keeps advancing, so unmuting rejoins mid-sentence.
 *  setReceiveVoice(false) is the privacy act (no inbound path at all). */
let hushed = false;
export const isHushed = () => hushed;
export function setHush(on) {
  const next = !!on;
  if (next === hushed) return hushed;
  hushed = next;
  bus.emit('audio:hush', hushed);   // voice.js ramps element volume; no teardown
  return hushed;
}

export function setVolume(cat, v) {
  const n = Math.max(0, Math.min(1, Number(v) || 0));
  if (cat === 'world') prefs.volWorld = n;
  else if (cat === 'tts') prefs.volTts = n;
  else prefs.volVoices = n;
  save();
  bus.emit('audio:volume', { cat, value: n });
  return n;
}

// ---- push-to-talk ----------------------------------------------------------
// a mode, not a momentary state; the held key itself lives in micstate.js next to the gate
export const pttMode = () => !!prefs.pttMode;
export function setPttMode(on) {
  const next = !!on;
  if (next === prefs.pttMode) return prefs.pttMode;
  prefs.pttMode = next; save();
  // micstate drops a held key on this event, and the panel dims the sensitivity row (under PTT the floor drives nothing)
  bus.emit('audio:ptt', next);
  return next;
}

// mic sensitivity (R, 17:19: typing sounds pinged the ear) — the floor below
// which mic activity is treated as room noise, not speech onset
export const micFloor = () => prefs.micFloor;
export function setMicFloor(v) {
  prefs.micFloor = Math.max(0, Math.min(0.2, Number(v) || 0));
  save();
  bus.emit('audio:micfloor', prefs.micFloor);
  return prefs.micFloor;
}

// ---- STT consent -----------------------------------------------------------
// SpeechRecognition ships audio to a vendor endpoint off this machine, so STT needs explicit, revocable consent:
// asked once, remembered, never assumed from the mic toggle
export const sttConsented = () => prefs.sttConsent === true;
/** Has this ever been put to the person? Distinct from what they answered. */
export const sttAsked = () => prefs.sttConsent !== null && prefs.sttConsent !== undefined;
export function setSttConsent(on) {
  prefs.sttConsent = !!on; save();      // a deliberate choice is always recordable
  bus.emit('audio:stt-consent', prefs.sttConsent);
  return prefs.sttConsent;
}

/** Ask once, in words that name the actual consequence. Returns a promise of
 *  the answer; a refusal is remembered as a refusal (we do not re-nag). */
export async function ensureSttConsent(ask = defaultAsk) {
  // only the unset state prompts: a remembered no is an answer; changing it is a deliberate act in the audio panel
  if (sttAsked()) return prefs.sttConsent === true;
  const yes = await ask();
  setSttConsent(yes);
  return prefs.sttConsent === true;
}

function defaultAsk() {
  return Promise.resolve(confirm(
    'Turn on speech-to-text?\n\n' +
    'Your microphone audio will be sent to your browser vendor\'s speech ' +
    'service (a third party outside this world) to be transcribed. The text ' +
    'is then posted as your chat message and stored in the world log.\n\n' +
    'Voice chat itself does NOT require this — you can talk without it.',
  ));
}

/** The gate threshold: THE ONE DEFINITION, so import it, don't recompute (copies drifted). */
// the threshold is a dB position, not a multiplier over the room: the marker stays put and the level moves past it
// (a room-relative threshold can't be drawn as one mark); dB also uncrushes the scale (room and speech ~25 dB apart)

/** The gate threshold in dBFS. 0% = -60 dB (everything), 100% = 0 dB (nothing).
 *  Linear in dB, which is already logarithmic in amplitude — the standard shape
 *  for this control, and the reason Discord's slider feels even end to end. */
export const gateThresholdDb = () => -60 + Math.min(1, Math.max(0, prefs.micFloor / 0.2)) * 60;

/** Same threshold as a linear amplitude, for comparing against an RMS reading. */
export const gateThreshold = () => Math.pow(10, gateThresholdDb() / 20);

/** dBFS of a linear amplitude, floored so silence does not become -Infinity. */
export const toDb = (amp) => 20 * Math.log10(Math.max(amp, 1e-6));

/** Where a level sits on the meter, 0..1 across the same -60..0 dB span the
 *  threshold uses. ONE function for both, so the bar and the marker cannot
 *  land in different places — that mismatch is this control's whole history. */
export const meterPos = (amp) => Math.max(0, Math.min(1, (toDb(amp) + 60) / 60));
