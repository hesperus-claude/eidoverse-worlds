// voiceconsent — the two things a person must be able to say NO to before any
// audio moves: "don't send my voice anywhere" and "don't play other people's
// voices at me". Both default to OFF. Voice is opt-in in BOTH directions.
//
// Why receive-off is not just muted playback: an inbound peer connection is a
// negotiated stream, not a volume slider. If you have not opted in, we do not
// answer the offer at all — "off" means no audio path exists, not "an audio
// path exists and we discard it". Cheaper, and it is the honest reading of
// the word.
//
// Category doctrine (convention, checked against Discord/VRChat/Rec Room):
// the 🎧 toggle is a VOICE control. World ambience is taste, set once, and
// lives on a settings slider — not on a HUD button you press situationally.
// Agent voice (TTS/captions) counts as a VOICE: a resident is a resident, and
// it would be strange for a synthetic speaker to be unmutable when a human
// one is not.

import { bus } from './base.js';

const KEY = 'eido.audio.prefs';
// sttConsent is TRI-STATE and must stay so: null = never asked, true =
// accepted, false = refused. A boolean cannot tell "not asked" from "said no",
// so a refusal would be re-prompted on the next mic-on.
// volWorld defaults to 1 (as authored, no cut nobody chose). Its one caller is
// the world bus in client/lib/realize/sounds.js (the `sound` component); anything else
// that plays placed or ambient audio should end in that bus, so the slider stays
// one control over one thing.
const DEFAULTS = { recvVoice: false, volVoices: 1, volWorld: 1, volTts: 1, sttConsent: null,
  // Sensitivity, not an absolute level: it scales the margin a sound must clear
  // ABOVE the measured room noise (see onsetTick). 0.06 is the lowest value that
  // took zero false triggers across 200 simulated room/noise combinations while
  // never missing speech, so the slider has honest room in both directions.
  // 60% = -24 dBFS, a default measured against a real mic in a real room (not
  // reasoned from reference levels); a starting place, not a claim about every room.
  micFloor: 0.12,
  // Push-to-talk: the gate opens on a HELD KEY instead of on measured level.
  // Off by default — voice activation is the mode everything above was tuned
  // for, and PTT is the deliberate opt-in of someone who knows their room
  // (an open-plan office, a fan, a housemate) will not survive a level gate.
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

/** Momentary silence WITHOUT revoking consent: the stream keeps arriving and
 *  keeps advancing, so unmuting drops you back into a sentence already in
 *  progress. Distinct from setReceiveVoice(false), the privacy act, which tears
 *  the inbound path down so no media is negotiated at all. */
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
// A MODE, not a momentary state: which regime decides when the gate opens.
// The held-key itself lives in micstate.js next to the gate decision it feeds;
// this file only remembers the choice, like every other preference here.
export const pttMode = () => !!prefs.pttMode;
export function setPttMode(on) {
  const next = !!on;
  if (next === prefs.pttMode) return prefs.pttMode;
  prefs.pttMode = next; save();
  // micstate drops a held key on this event (a mode you leave should not
  // leave a phantom finger on the gate), and the panel dims the sensitivity
  // row: under PTT the floor drives nothing, and must not look like it does.
  bus.emit('audio:ptt', next);
  return next;
}

// mic sensitivity: the floor below which mic activity is treated as room noise, not speech onset
export const micFloor = () => prefs.micFloor;
export function setMicFloor(v) {
  prefs.micFloor = Math.max(0, Math.min(0.2, Number(v) || 0));
  save();
  bus.emit('audio:micfloor', prefs.micFloor);
  return prefs.micFloor;
}

// ---- STT consent -----------------------------------------------------------
// The browser's SpeechRecognition ships audio to a VENDOR endpoint off this
// machine. Someone toggling a microphone in a world does not expect their
// room to be transcribed by a third party. So STT is gated behind an explicit,
// revocable, plainly-worded consent — asked once, remembered, never assumed
// from the mic toggle.
export const sttConsented = () => prefs.sttConsent === true;
/** Has this ever been put to the person? Distinct from what they answered. */
const sttAsked = () => prefs.sttConsent !== null && prefs.sttConsent !== undefined;
export function setSttConsent(on) {
  prefs.sttConsent = !!on; save();      // a deliberate choice is always recordable
  bus.emit('audio:stt-consent', prefs.sttConsent);
  return prefs.sttConsent;
}

/** Ask once, in words that name the actual consequence. Returns a promise of
 *  the answer; a refusal is remembered as a refusal (we do not re-nag). */
export async function ensureSttConsent(ask = defaultAsk) {
  // Only the UNSET state prompts. A remembered answer — yes or no — is
  // returned without asking again: "no" is an answer, not an invitation to
  // ask differently next time. Changing it later is a deliberate act in the
  // audio panel, where the person goes looking rather than being interrupted.
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

// THE THRESHOLD IS A dB POSITION, not a multiplier over the room (Discord's model):
//   • one widget, two jobs — the live level bar and the draggable threshold
//     share one track, on a dB scale (roughly -60..0 dBFS)
//   • the marker DOES NOT MOVE. The level moves past it.
//   • colour by GATE STATE, not by level: below the marker is muted, above is live
// A room-relative threshold moves as the room changes, so marker and colour can't
// agree; and on a linear RMS meter a quiet room and speech both crowd the left
// edge, where in dB they are 25 points apart. Every reader imports these helpers.

/** The gate threshold in dBFS. 0% = -60 dB (everything), 100% = 0 dB (nothing).
 *  Linear in dB, which is already logarithmic in amplitude — the standard shape
 *  for this control, and the reason Discord's slider feels even end to end. */
const gateThresholdDb = () => -60 + Math.min(1, Math.max(0, prefs.micFloor / 0.2)) * 60;

/** Same threshold as a linear amplitude, for comparing against an RMS reading. */
export const gateThreshold = () => Math.pow(10, gateThresholdDb() / 20);
