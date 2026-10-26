// micstate — the mic's gate/analyser machinery, transport-agnostic: a transport publishes what gateFor(rawStream) returns.

// flashHint is lazy-imported: a static import drags ui.js and THREE into headless contexts that touch the mic
import { bus } from './base.js';
// tone 'attn': a press that did not turn the mic on is "you asked, it didn't happen, here's why"
const flashHint = (msg) => import('./ui.js').then((u) => u.flashHint(msg, 4000, 'attn')).catch(() => {});
import { sendTyping } from './net.js';
import { gateThreshold, pttMode } from './voiceconsent.js';
import { gateStream, attachSource, detachSource, driveGate, driveRawTracks, setMonitor, monitoring,
         gateUnavailable, ungatedConsent, isGated,
         makeOnsetGate, makeLevelMeter } from './micgate.js';
// the analyser hangs off the shared context; without this import micAnalyserLevel() silently returns 0
import { audioContext } from './audioctx.js';

// mute and lane live here, not in a transport: a muted mic is a fact about the microphone, not how its audio leaves
let _lane = null;          // on the wire (gated or synth)
let _muted = false;

export const isMuted = () => _muted;
export function toggleMute(on) {
  _muted = on === undefined ? !_muted : !!on;
  gateAudio(Date.now());   // now: mute is authoritative
  bus.emit('audio:mute', _muted);
  return _muted;
}

// ── push-to-talk: the key IS the gate ───────────────────────────────────────
// The level still feeds the meter and noise floor, but the gate is the held key alone (not key AND level). Mute outranks it.
let _pttHeld = false;
export const pttHeld = () => _pttHeld;
export function setPttHeld(on) {
  const next = !!on;
  if (next === _pttHeld) return;
  _pttHeld = next;
  const now = Date.now();
  // the press is intent: announce 🎙 now, through the onset's 1.5s rate-limit (no double-fire)
  if (next && pttMode() && micOn()) _onset.press(now);
  gateAudio(now);   // a 20ms tick is audible latency here
}
bus.on('audio:ptt', (on) => {
  const now = Date.now();
  if (on) {
    // close NOW, not on the next tick: on an ungated lane that tick is raw transmission the mode just promised away
    gateAudio(now);
    return;
  }
  // leaving PTT with the key down must not leave a phantom finger on the gate
  if (_pttHeld) _pttHeld = false;
  // the drive closure returns an ungated lane to its consent row (raw, open) unless muted or the device is OFF
  gateAudio(now);
});

const _meter = makeLevelMeter(() => (!_lane || _muted) ? null : (_raw || _lane));
const _onset = makeOnsetGate({
  level: _meter,
  threshold: gateThreshold,
  drive: (open) => {
    // authority is micOn(), not `_lane && !_muted`: the lane survives mic OFF, so that re-enabled a disabled raw track
    const want = micOn() ? open : false;
    driveGate(want);
    // no graph (gate unavailable, raw consented): PTT closes the raw tracks, voice activation leaves them on with the mic
    if (gateUnavailable()) driveRawTracks(pttMode() ? want : micOn());
  },
  announce: () => sendTyping(null, 'mic'),
  // null: no override, decide by level
  held: () => (pttMode() ? _pttHeld : null),
});
const gateAudio = (now) => _onset.apply(now);
const startOnsetWatch = () => _onset.start();
const stopOnsetWatch = () => _onset.stop();

/** What the gate is doing now; this module's instance is the only gate (§24n). `speaking` is masked by micOn(), or a
 *  key held while muted reports speaking over a closed gate: the pill and the audio must agree. */
export const micGateInfo = () => {
  const info = _onset.info();
  return micOn() ? info : { ...info, speaking: false };
};

/** Live mic level 0..1. */
export function micAnalyserLevel() { return _meter(); }

// ── the transport-facing seam ───────────────────────────────────────────────

let _raw = null, _gated = null, _released = false;

/** Gate a raw device stream and return what goes on the wire. A synthetic source bypasses the gate (no room noise,
 *  and the graph can't carry it on a stalled headless clock): the source's nature decides, never the transport. */
export function gateFor(rawStream) {
  if (!rawStream || rawStream.synthetic) { _raw = _gated = _lane = rawStream; return rawStream; }
  _raw = rawStream;
  // reuse the standing lane: senders already hold it, so a return from release costs no renegotiation
  const reused = _released ? attachSource(rawStream) : null;
  _released = false;
  _gated = reused || gateStream(rawStream, micAnalyserLevel);
  _lane = _gated;
  _deviceLive = true;
  startOnsetWatch();
  // before the lane leaves: an ungated raw track arrives enabled, so armed PTT could leak a frame before the first tick
  gateAudio(Date.now());
  return _gated;
}

/** The gate refused to build (no AudioContext, etc). A transport must never publish ungated silently. */
export const gateIsUnavailable = () => gateUnavailable();
export const ungatedAllowed = () => ungatedConsent();
export const gateActive = () => isGated();
export const rawMicStream = () => _raw;

/** Stop the onset watcher and forget the lane (device release is the caller's). */
export function gateRelease() {
  stopOnsetWatch();
  _released = true;
  _gated = _lane = null;
}

/** Turn the mic on or off: the one entry point every UI uses. */
export async function toggleMic() {
  const fn = typeof window !== 'undefined' ? window.__sfuMic : null;
  // the server's "no relay" (net.js, at join) outranks the hook, which installs regardless; ON only (a live mic can still go off)
  if (!fn || (typeof window !== 'undefined' && window.__voiceRelayAbsent && !micOn())) {
    // still connecting, or this world has no relay (net.js flags it): never a silent no-op
    flashHint(window.__voiceRelayAbsent
      ? 'this world has no voice relay — the mic can\'t go live here'
      : 'voice is still connecting — try again in a moment');
    return micOn();
  }
  const on = await fn();
  bus.emit('audio:mic', on);
  return on;
}

/** The one answer to "is my mic on": lane + capturing device + not muted. Transports report the device via setMicLive(). */
let _deviceLive = false;
export function setMicLive(on) {
  const next = !!on;
  if (next === _deviceLive) return;
  _deviceLive = next;
  // re-apply now: on mic ON, armed PTT must close the re-enabled raw track before a frame leaves
  gateAudio(Date.now());
}
export const micOn = () => !!_lane && _deviceLive && !_muted;
/** The device leg of micOn() alone, for a harness ("no lane" vs "device off"); the UI asks micOn(). */
export const micDeviceLive = () => _deviceLive;

/** Release the device, keep the lane: stop the raw track (the OS recording light), never the gated one (a
 *  MediaStreamDestination track can't restart: a new graph and renegotiation). */
export function releaseMicrophone() {
  if (!_lane) return;
  // where the lane IS the device (synthetic / gate-unavailable) it stops anyway: the recording light is a privacy promise
  if (_raw) for (const t of _raw.getTracks()) t.stop();
  _deviceLive = false;
  driveGate(false);
  detachSource();
  _raw = null;
  _released = true;
  stopOnsetWatch();
  bus.emit('audio:mic', false);
}

/** Is there a microphone at all? */
export async function hasMicDevice() {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    return !!devs?.some((d) => d.kind === 'audioinput');
  } catch { return false; }
}

/** Hear your lane as the room does: tapped after the gate, so a closed gate is quiet. */
export function selfMonitor(on, level = 0.35) { return setMonitor(on, level); }
export const selfMonitoring = () => monitoring();
