// micstate — the mic's gate/analyser machinery, transport-agnostic: a transport calls gateFor(rawStream) and
// publishes what it gets back.

// flashHint lives in ui.js (not core.js), lazy-imported at its one call site: a static import drags ui.js and THREE
// into headless contexts that touch the mic.
import { bus } from './base.js';
// tone 'attn': a press that did not turn the mic on is "something you asked for didn't happen, and why" (ui.js flashHint)
const flashHint = (msg) => import('./ui.js').then((u) => u.flashHint(msg, 4000, 'attn')).catch(() => {});
import { sendTyping } from './net.js';
import { gateThreshold, pttMode } from './voiceconsent.js';
import { gateStream, attachSource, detachSource, driveGate, driveRawTracks, setMonitor, monitoring,
         gateUnavailable, ungatedConsent, isGated,
         makeOnsetGate, makeLevelMeter } from './micgate.js';
// the analyser hangs off the shared context; without this import micAnalyserLevel() silently returns 0
import { audioContext } from './audioctx.js';

// mute and lane live here, not in a transport: a muted mic is a fact about the microphone, not how its audio leaves
let _lane = null;          // the stream currently on the wire (gated or synth)
let _muted = false;

export const isMuted = () => _muted;
export function toggleMute(on) {
  _muted = on === undefined ? !_muted : !!on;
  gateAudio(Date.now());   // apply immediately — mute is authoritative
  bus.emit('audio:mute', _muted);
  return _muted;
}

// ── push-to-talk: the key IS the gate ───────────────────────────────────────
// In PTT the level machinery still feeds the meter and noise floor, but the gate decision is the held key alone (not
// key AND level); micgate.js's envelope still shapes the open. Mute outranks the key.
let _pttHeld = false;
export const pttHeld = () => _pttHeld;
export function setPttHeld(on) {
  const next = !!on;
  if (next === _pttHeld) return;
  _pttHeld = next;
  const now = Date.now();
  // the press is declared intent: announce 🎙 on the press, through the onset's own 1.5s rate-limit (no double-fire)
  if (next && pttMode() && micOn()) _onset.press(now);
  gateAudio(now);   // apply immediately — a 20ms tick is an audible latency here
}
bus.on('audio:ptt', (on) => {
  const now = Date.now();
  if (on) {
    // Arming closes the gate NOW, not on the next 20ms tick: on an ungated
    // lane that tick is a window of raw transmission the mode just promised
    // away (see the drive closure below).
    gateAudio(now);
    return;
  }
  // Leaving PTT with the key down must not leave a phantom finger on the gate:
  // the next regime starts from closed and earns its own open.
  if (_pttHeld) _pttHeld = false;
  // the drive closure returns an ungated lane to its consent row (raw, open) unless muted or the device is OFF;
  // one writer for the raw tracks
  gateAudio(now);
});

// the onset watcher's state; the machine is micgate.js's makeOnsetGate/makeLevelMeter
const _meter = makeLevelMeter(() => (!_lane || _muted) ? null : (_raw || _lane));
const _onset = makeOnsetGate({
  level: _meter,
  threshold: gateThreshold,
  drive: (open) => {
    // the lane's authority is micOn() (lane + capturing device + not muted), not `_lane && !_muted`: the sender lane
    // survives mic OFF, so that test re-enabled a raw track the transport had disabled
    const want = micOn() ? open : false;
    driveGate(want);
    // no graph to drive (gate unavailable, raw consented): drive the raw tracks (micgate.js driveRawTracks); PTT closes
    // the wire, voice activation stays raw while the mic is on. The transport writes the same answer.
    if (gateUnavailable()) driveRawTracks(pttMode() ? want : micOn());
  },
  announce: () => sendTyping(null, 'mic'),
  // Push-to-talk hands the machine a HELD answer instead of a level to judge;
  // null means "no override, decide by level" — see setPttHeld above.
  held: () => (pttMode() ? _pttHeld : null),
});
const gateAudio = (now) => _onset.apply(now);
const startOnsetWatch = () => _onset.start();
const stopOnsetWatch = () => _onset.stop();

/** What the gate is actually doing right now — for the meter and for
 *  tuning. Post-cutover (anima merge, §24n): the mesh is GONE — this
 *  module's own factory instance is the only gate there is. */
// `speaking` = the machine's decision masked by the lane's authority (no lane, or muted), as in the drive closure, or a
// held key while muted reports speaking:true over a closed gate. The pill and the audio must agree.
export const micGateInfo = () => {
  const info = _onset.info();
  return micOn() ? info : { ...info, speaking: false };
};

/** Live mic level 0..1 for UI — the factory meter over this module's own
 *  _raw/_lane (the mesh delegation retired with voice.js). */
export function micAnalyserLevel() { return _meter(); }

// ── the transport-facing seam ───────────────────────────────────────────────

let _raw = null, _gated = null, _released = false;

/** Gate a raw device stream and return what goes on the wire. A synthetic source bypasses the gate (no room noise,
 *  and the graph can't carry it on a stalled headless clock): the source's nature decides, never the transport. */
export function gateFor(rawStream) {
  if (!rawStream || rawStream.synthetic) { _raw = _gated = _lane = rawStream; return rawStream; }
  _raw = rawStream;
  // Reuse a standing lane: attachSource returns the same gated stream the
  // senders already hold, so returning from a release costs zero renegotiation.
  const reused = _released ? attachSource(rawStream) : null;
  _released = false;
  _gated = reused || gateStream(rawStream, micAnalyserLevel);
  _lane = _gated;
  _deviceLive = true;
  startOnsetWatch();
  // apply the current authority before the lane leaves: the first tick is 20 ms away and an ungated raw track arrives
  // enabled, so armed PTT could leak a frame while the UI promised silence
  gateAudio(Date.now());
  return _gated;
}

/** True when the gate refused to build (no AudioContext, etc). A transport must
 *  decide whether to publish ungated — never do it silently. */
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
  // the server's "no relay" (net.js sets __voiceRelayAbsent at join) outranks the __sfuMic hook, which is installed
  // whatever the server runs; only for turning ON (a live mic still switches off through the hook)
  if (!fn || (typeof window !== 'undefined' && window.__voiceRelayAbsent && !micOn())) {
    // no bridge yet. Two very different reasons look identical from here: the
    // relay is still connecting, or this world has none (staging, 09-04 — the
    // glyph stayed off with no prompt and no word). net.js flags the second.
    flashHint(window.__voiceRelayAbsent
      ? 'this world has no voice relay — the mic can\'t go live here'
      : 'voice is still connecting — try again in a moment');
    return micOn();
  }
  const on = await fn();
  bus.emit('audio:mic', on);
  return on;
}

/** The one answer to "is my mic on": a LANE exists, a DEVICE is capturing, and the user hasn't muted. Transports
 *  report device liveness through setMicLive(); everything else asks here. */
let _deviceLive = false;
export function setMicLive(on) {
  const next = !!on;
  if (next === _deviceLive) return;
  _deviceLive = next;
  // liveness is part of the gate's authority: re-apply now, not on the next 20 ms tick, so on mic ON armed PTT closes
  // the re-enabled raw track before any frame leaves
  gateAudio(Date.now());
}
export const micOn = () => !!_lane && _deviceLive && !_muted;
/** The device leg of micOn() on its own — what the transport last reported.
 *  Readable so a harness can tell "no lane" from "lane, device off"; the UI
 *  keeps asking micOn(). */
export const micDeviceLive = () => _deviceLive;

/** Release the device, keep the lane: stop the raw track (or the OS recording light stays on) but never the gated
 *  track; a MediaStreamDestination track can't restart, so stopping it forces a new graph and renegotiation.
 *  Reacquire reconnects into the same graph. */
export function releaseMicrophone() {
  if (!_lane) return;
  // stop ONLY the raw device (rule 2: a stopped destination lane can't restart). Where the lane IS the device
  // (synthetic / gate-unavailable, raw === lane) it stops anyway: the recording light is a privacy promise (rule 1).
  if (_raw) for (const t of _raw.getTracks()) t.stop();
  _deviceLive = false;
  driveGate(false);
  detachSource();
  _raw = null;
  _released = true;
  stopOnsetWatch();
  bus.emit('audio:mic', false);
}

/** Is there a microphone at all? Transport-agnostic and cheap. */
export async function hasMicDevice() {
  try {
    const devs = await navigator.mediaDevices?.enumerateDevices?.();
    return !!devs?.some((d) => d.kind === 'audioinput');
  } catch { return false; }
}

/** Hear your own lane as the room hears it: tapped AFTER the gate's gain node (micgate.js), so a closed gate is quiet. */
export function selfMonitor(on, level = 0.35) { return setMonitor(on, level); }
export const selfMonitoring = () => monitoring();
