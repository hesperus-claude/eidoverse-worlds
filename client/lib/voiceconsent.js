// voiceconsent — voice is opt-in both ways, default OFF; receive-off means no inbound audio path exists at all.
// Agent voice (TTS/captions) is voice, mutable like a human's; world ambience is a slider, not the 🎧 toggle.

import { bus } from './base.js';

const KEY = 'eido.audio.prefs';
// sttConsent is tri-state: null = never asked (a boolean would re-prompt a refusal)
// volWorld's one consumer is the world bus in sounds.js; all placed or ambient audio should end there
const DEFAULTS = { recvVoice: false, volVoices: 1, volWorld: 1, volTts: 1, sttConsent: null,
  // 0..0.2 → the -60..0 dBFS track (gateThresholdDb); 0.12 = -24 dBFS, tuned in a real room
  micFloor: 0.12,
  pttMode: false };

let prefs = { ...DEFAULTS };
try {
  const raw = localStorage.getItem(KEY);
  if (raw) prefs = { ...DEFAULTS, ...JSON.parse(raw) };
} catch { /* corrupt prefs must never keep anyone out of the world */ }

const save = () => { try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* private mode */ } };

// metres, voicesfubridge.js's rolloff; "near" for being heard means inside VOICE_SILENT_M, whatever settings say
export const VOICE_FULL_M = 3, VOICE_SILENT_M = 20;

export const audioPrefs = () => ({ ...prefs });
export const receivingVoice = () => prefs.recvVoice;
export const volumeFor = (cat) => (
  cat === 'world' ? prefs.volWorld : cat === 'tts' ? prefs.volTts : prefs.volVoices);

export function setReceiveVoice(on) {
  const next = !!on;
  if (next === prefs.recvVoice) return prefs.recvVoice;
  prefs.recvVoice = next; save();
  // nothing may open an inbound stream without consulting receivingVoice()
  bus.emit('audio:receive', next);
  return next;
}

/** silence without revoking consent; setReceiveVoice(false) is the privacy act (no inbound path at all) */
let hushed = false;
export const isHushed = () => hushed;
export function setHush(on) {
  const next = !!on;
  if (next === hushed) return hushed;
  hushed = next;
  bus.emit('audio:hush', hushed);   // a volume ramp, no teardown
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
// a mode; the held key itself lives in micstate.js next to the gate
export const pttMode = () => !!prefs.pttMode;
export function setPttMode(on) {
  const next = !!on;
  if (next === prefs.pttMode) return prefs.pttMode;
  prefs.pttMode = next; save();
  bus.emit('audio:ptt', next);
  return next;
}

// below this, mic activity is room noise, not speech onset
export const micFloor = () => prefs.micFloor;
export function setMicFloor(v) {
  prefs.micFloor = Math.max(0, Math.min(0.2, Number(v) || 0));
  save();
  bus.emit('audio:micfloor', prefs.micFloor);
  return prefs.micFloor;
}

// ---- STT consent -----------------------------------------------------------
// STT ships audio to a vendor endpoint: explicit, revocable consent, asked once, never assumed from the mic toggle
export const sttConsented = () => prefs.sttConsent === true;
/** distinct from what they answered */
export const sttAsked = () => prefs.sttConsent !== null && prefs.sttConsent !== undefined;
export function setSttConsent(on) {
  prefs.sttConsent = !!on; save();
  bus.emit('audio:stt-consent', prefs.sttConsent);
  return prefs.sttConsent;
}

/** Ask once, naming the actual consequence; a refusal is remembered (never re-nag). */
export async function ensureSttConsent(ask = defaultAsk) {
  // a remembered no is an answer; changing it is a deliberate act in the audio panel
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

/** THE ONE gate-threshold definition: import it, never recompute. dBFS, 0% = -60 (everything), 100% = 0 (nothing).
 *  A dB position, not room-relative, so the marker stays put and can be drawn as one mark. */
export const gateThresholdDb = () => -60 + Math.min(1, Math.max(0, prefs.micFloor / 0.2)) * 60;

/** linear amplitude, for comparing against an RMS reading */
export const gateThreshold = () => Math.pow(10, gateThresholdDb() / 20);

/** floored so silence is not -Infinity */
export const toDb = (amp) => 20 * Math.log10(Math.max(amp, 1e-6));

/** 0..1 over the threshold's -60..0 dB span: one function, so bar and marker cannot land in different places */
export const meterPos = (amp) => Math.max(0, Math.min(1, (toDb(amp) + 60) / 60));
