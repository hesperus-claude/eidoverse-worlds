// micgate — the noise gate as a smoothed GAIN, not a switch: `track.enabled` is binary and clicks on the first
// consonant.
//
//     voiceSource()  →  MediaStreamSource  →  GainNode  →  MediaStreamDestination
//                                               ↑                     ↓
//                                        gate (this file)    the track WebRTC sends
//
// The analyser reads the SOURCE side, never the gated side, or the gate latches shut. Humans and agents both come
// through voiceSource() (voicesource.js), so both are gated by the one path.

import { audioContext } from './audioctx.js';
import { report } from './base.js';

// Attack: tau 0.008 s on a 20 ms tick, ~44 ms worst case to open (a plosive is ~20-40 ms). Release is slow on purpose
// (tau 0.12 s, after the 700 ms hang): attack always faster than release. One smoothing stage only (see driveGate).
const ATTACK_TAU = 0.008;
const RELEASE_TAU = 0.12;
// LOOKAHEAD: an unvoiced /h/ never crosses the threshold, so delay the AUDIO, not the detector: the analyser reads
// pre-delay, and the onset is still in the delay line when the gate opens. Cost: 50 ms outbound latency.
const LOOKAHEAD = 0.05;

let _ctx = null, _src = null, _gain = null, _dest = null, _look = null;
let _rawStream = null, _gatedStream = null, _level = () => 0;

/** Wrap a mic stream in the gate graph. Returns the stream to hand to WebRTC —
 *  or the original stream unchanged if the graph cannot be built, because a
 *  voice that works ungated beats no voice at all. */
// ── declared vs effective: if the gate graph can't be built, the stream is REFUSED (null; caller must not transmit)
// unless the user chose ungated transmission via allowUngated(true). A privacy control must not silently go "off".
let _gateUnavailable = false;   // the graph could not be built on this device
let _ungatedConsent = false;    // explicit "transmit raw anyway" choice
export const gateUnavailable = () => _gateUnavailable;
export const ungatedConsent = () => _ungatedConsent;
export function allowUngated(on) { _ungatedConsent = !!on; }

export function gateStream(stream, levelFn) {
  release();
  _rawStream = stream;
  _level = levelFn || (() => 0);
  try {
    _ctx = audioContext();
    if (!_ctx || typeof _ctx.createMediaStreamDestination !== 'function') {
      _gateUnavailable = true;
      _rawWanted = _ungatedConsent ? 1 : 0;      // a consented raw lane is open until PTT says otherwise
      return _ungatedConsent ? stream : null;   // fail CLOSED, not raw
    }
    _gateUnavailable = false;
    _src = _ctx.createMediaStreamSource(stream);
    _gain = _ctx.createGain();
    // Start CLOSED. Opening on the first frame would broadcast whatever the room
    // is doing at the instant the mic opens — the exact leak the settle window
    // exists to prevent, and the one R heard as "picking up background noise".
    _gain.gain.value = 0;
  // a fresh lane IS closed: `_wanted` outlives its graph, so without this reset micTransmitting() claims "audible"
  // before the first driveGate tick
  _wanted = 0;
    _dest = _ctx.createMediaStreamDestination();
    // src → lookahead delay → gate gain → destination. The lookahead is polish, the gate is the product: a context
    // without createDelay must still get a gate (an enhancement's absence costs only the enhancement).
    _look = null;
    if (typeof _ctx.createDelay === "function") {
      try {
        _look = _ctx.createDelay(0.2);
        _look.delayTime.value = LOOKAHEAD;
      } catch { _look = null; /* no lookahead on this device — gate still real */ }
    }
    if (_look) { _src.connect(_look); _look.connect(_gain); }
    else _src.connect(_gain);
    _gain.connect(_dest);
    _gatedStream = _dest.stream;

    // Carry the original track's identity forward where it matters: muting still
    // operates on the RAW track (see voice.js), so both streams stay live and the
    // gate only decides how much of the raw signal reaches the destination.
    return _gatedStream;
  } catch (e) {
    report('mic gate graph', e);
    release();
    // FAIL CLOSED (B2): "ungated beats silent" was the old rule, and it made
    // the sensitivity UI a lie whenever WebAudio broke. Silent-with-a-reason
    // beats secretly-raw; allowUngated(true) is the explicit way back.
    _gateUnavailable = true;
    return _ungatedConsent ? stream : null;
  }
}

/** Drive the gain from the gate decision. `open` is the gate's boolean; the
 *  smoothing lives here so the decision logic stays readable. */
export function driveGate(open) {
  if (!_gain || !_ctx) return;
  // DO NOT DOUBLE-SMOOTH: setTargetAtTime already is the envelope. Target the true endpoint (1 or 0); a lerped step
  // fed into it never reaches the target and the gate never fully closes.
  const target = open ? 1 : 0;
  const tau = open ? ATTACK_TAU : RELEASE_TAU;
  try {
    _gain.gain.setTargetAtTime(target, _ctx.currentTime, tau);
  } catch { _gain.gain.value = target; }
  _wanted = target;
}

// ── the ungated lane's only gate: with allowUngated the wire carries the raw device stream and there is no gain to
// drive, so push-to-talk drives the raw tracks' `enabled` instead (abrupt but true, as mute does). Intent is recorded
// so gateOpenness() tells the badge what the wire is doing.
let _rawWanted = 0;
export function driveRawTracks(open) {
  if (!_rawStream) return false;
  for (const t of _rawStream.getAudioTracks?.() ?? []) t.enabled = !!open;
  _rawWanted = open ? 1 : 0;
  return true;
}


// ── MONITOR: hear your own lane as the room does. Tapped AFTER the gain, so it carries the gate (a raw-side monitor
// would sound fine while the room heard nothing). On speakers it will howl: low default, said in the UI.
let _mon = null, _delay = null, _wanted = 0;
// Long enough to be heard as a separate event rather than as an echo of your
// own voice. Tunable live via setMonitorDelay() while testing.
let MONITOR_DELAY = 0.4;
export function setMonitor(on, level = 0.35) {
  if (!_ctx || !_gain) return false;
  if (!on) {
    if (_mon) {
      try { _mon.disconnect(); } catch { /* gone */ }
      try { _delay?.disconnect(); } catch { /* gone */ }
      _mon = null; _delay = null;
    }
    return false;
  }
  if (!_mon) {
    _mon = _ctx.createGain();
    // A deliberate delay (MONITOR_DELAY, past the ~50 ms echo threshold) so the repeat is distinguishable from bone
    // conduction. Same guard as the lookahead: no createDelay → zero-latency monitoring, not a throw.
    _delay = null;
    if (typeof _ctx.createDelay === "function") {
      try {
        _delay = _ctx.createDelay(2.0);
        _delay.delayTime.value = MONITOR_DELAY;
      } catch { _delay = null; }
    }
    if (_delay) { _gain.connect(_delay); _delay.connect(_mon); }
    else _gain.connect(_mon);
    _mon.connect(_ctx.destination);
  }
  // setTargetAtTime, not a bare assignment: a step change in a monitor path is
  // an audible click straight into your ears.
  try { _mon.gain.setTargetAtTime(level, _ctx.currentTime, 0.02); }
  catch { _mon.gain.value = level; }
  return true;
}
export const monitoring = () => !!_mon;

/** Is any signal actually reaching the wire right now? The honest answer to
 *  "am I being broadcast", read from the gain itself rather than inferred. */
// Reports the gate's INTENT, not the instantaneous .value: during a fade the
// real gain is mid-slope, and an indicator that flickers through every envelope
// would misreport 'am I being heard' at exactly the moments that matter.
export const gateOpenness = () => (_gain ? _wanted : (_gateUnavailable && _rawStream ? _rawWanted : 0));
export const gateGainNow = () => (_gain ? _gain.gain.value : 0);
export const isGated = () => !!_gain;

// ── MIX A SYNTHESIZED VOICE INTO THE SAME LANE: a synth mixes in after the gate, alongside the mic and never instead
// of it; room noise must clear the threshold, but synthesized speech is already signal.

/** Detach the device, keep the lane: the GainNode and MediaStreamDestination stay, so every peer's sender track stays
 *  live and the mic's return needs no renegotiation. Tear down tracks only on leave or audio opt-out. */
export function detachSource() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  _src = null;
  _rawStream = null;
  if (_gain) _gain.gain.value = 0;        // lane open, silent
}

/** Reconnect a new device stream into the EXISTING lane. Returns the same gated
 *  stream the senders already hold, so nothing downstream changes. */
export function attachSource(stream) {
  if (!_ctx || !_gain || !_dest) return null;
  try { _src?.disconnect(); } catch { /* fine */ }
  _src = _ctx.createMediaStreamSource(stream);
  // Through the SAME lookahead as gateStream — reattaching without it would
  // silently lose the first syllable again, on exactly the reconnect path
  // nobody re-tests by ear.
  if (_look) _src.connect(_look); else _src.connect(_gain);
  _rawStream = stream;
  return _gatedStream;
}

/** Full teardown — the lane included. ONLY for leaving the world or revoking
 *  consent, never for going quiet: this is the path that costs a renegotiation
 *  to undo. */
export function release() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  try { _look?.disconnect(); } catch { /* already gone */ }
  _look = null;
  try { _gain?.disconnect(); } catch { /* already gone */ }
  // Disposal OWNERSHIP (#90): this module built the monitor tap and the
  // synth mix-in, so this module disconnects them — a release that leaves its
  // own nodes wired into a dead graph is the asymmetric repair again.
  try { _mon?.disconnect(); } catch { /* already gone */ }
  _mon = null;
  // Deliberately does NOT stop the destination's tracks: they belong to the
  // stream WebRTC holds, and stop() is a one-way door. The caller's own sender
  // cleanup owns that.
  _src = _gain = _dest = null;
  _gatedStream = null;
  _rawStream = null;
  _rawWanted = 0;
}

/** The RAW stream, for anything that must measure the true input — the analyser
 *  especially. Measuring the gated output would make the gate self-latching. */
export const rawStream = () => _rawStream;

/** Retune the monitor delay live, in seconds (0…2). For finding the spacing that
 *  makes a clipped consonant obvious rather than ambiguous. */
export function setMonitorDelay(sec) {
  MONITOR_DELAY = Math.max(0, Math.min(2, Number(sec) || 0));
  if (_delay && _ctx) {
    try { _delay.delayTime.setTargetAtTime(MONITOR_DELAY, _ctx.currentTime, 0.05); }
    catch { _delay.delayTime.value = MONITOR_DELAY; }
  }
  return MONITOR_DELAY;
}
export const monitorDelay = () => MONITOR_DELAY;

// ── the onset machine + level meter, ONE copy (§24l R1): each transport instantiates it with its own stream/mute
// closures

/** RMS level meter over the stream `getMeasured` names (null = muted: report 0, learn nothing). One AudioContext,
 *  reused (Chrome caps a document at ~6, silently); a replaced analyser pair is disconnected so the graph can't grow. */
export function makeLevelMeter(getMeasured) {
  let _an = null, _anStream = null, _anBuf = null, _anSrc = null;
  return function level() {
    const measured = getMeasured();
    if (!measured) return 0;
    if (!_an || _anStream !== measured) {
      try {
        const ctx = audioContext();
        try { _anSrc?.disconnect(); _an?.disconnect(); } catch { /* gone */ }
        const src = ctx.createMediaStreamSource(measured);
        _an = ctx.createAnalyser(); _an.fftSize = 512;
        src.connect(_an);
        _anSrc = src;
        _anStream = measured;
        _anBuf = new Float32Array(_an.fftSize);
      } catch { return 0; }
    }
    _an.getFloatTimeDomainData(_anBuf);
    let s = 0;
    for (let i = 0; i < _anBuf.length; i++) s += _anBuf[i] * _anBuf[i];
    return Math.sqrt(s / _anBuf.length);
  };
}

/** The speech-onset gate: BasisVR's block-minima noise floor, a fixed
 *  threshold with ~3dB hysteresis and 700ms hang-time, and the once-per-
 *  utterance 🎙 announcement. `drive(open)` is the transport's gain hand
 *  (it applies its own lane/mute authority first); `level()` returning 0
 *  means muted — close, drop the speaking latch, learn nothing.
 *  Laws:
 *  - DRIVE THE GATE BEFORE ANY EARLY RETURN;
 *  - LEARN BEFORE JUDGING (~1s settle window, or a loud room fires the 🎙
 *    at itself);
 *  - the floor is min-of-block-minima (6 × 0.4s), so SPEECH CAN NEVER
 *    RAISE IT — structurally, not by tuning;
 *  - THE PILL AND THE AUDIO MUST AGREE: announce only after the gate has
 *    been open one envelope's worth (60ms), max once per 1.5s;
 *  - `speaking` reports threshold PLUS hang-time, or the bar flickers dark
 *    through every pause while the room still hears you;
 *  - 20ms tick: the interval is the worst-case clip on a word's attack. */
export function makeOnsetGate({ level, threshold, drive, announce, held = () => null }) {
  let _timer = null, _above = false, _lastOnset = 0, _openUntil = 0;
  let _openedAt = 0, _announced = false;
  let _noise = 0.01, _settle = 0;
  let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
      _blockMin = Infinity, _blockStart = 0;

  // Push-to-talk is a mode of this machine: `held()` is null when the level decides, else the key's boolean. The level
  // side keeps running (meter, noise floor), but under a held answer its verdict drives nothing and its 🎙 must not fire;
  // press() announces instead, through the same rate-limit, so the pill and audio agree.
  const decide = (now) => { const h = held(); return h === null ? (_above || now <= _openUntil) : h; };
  const apply = (now) => drive(decide(now));

  function tick() {
    const lv = level();
    if (lv <= 0) {
      // muted: close, do not learn — and DROP THE SPEAKING LATCH, or
      // info().speaking reports true forever while the gate is forced shut
      _above = false; _openUntil = 0;
      apply(Date.now()); return;
    }
    if (_settle < 8) {
      _settle++;
      const a0 = lv < _noise ? 0.3 : 0.5;
      _noise += (lv - _noise) * a0;
      apply(Date.now());               // measuring, but still CLOSED — not frozen
      return;
    }
    const nowT = Date.now();
    if (lv < _blockMin) _blockMin = lv;
    if (nowT - _blockStart >= 400) {
      _blockStart = nowT;
      _blocks[_blockIdx] = _blockMin;
      _blockIdx = (_blockIdx + 1) % 6;
      if (_blocksFilled < 6) _blocksFilled++;
      _blockMin = Infinity;
    }
    _noise = Math.max(1e-5, Math.min(_blockMin, ...(_blocks.slice(0, _blocksFilled))));
    const on = threshold();
    const off = on * 0.7;                    // ~3 dB of hysteresis
    const now = Date.now();
    if (lv >= on) {
      _openUntil = now + 700;                // hang-time
      if (!_above) { _above = true; _openedAt = now; _announced = false; }
      if (held() === null && !_announced && now - _openedAt >= 60 && now - _lastOnset > 1500) {
        _announced = true; _lastOnset = now; announce();
      }
    } else if (_above && lv < off && now > _openUntil) _above = false;
    apply(now);
  }

  return {
    /** Re-measure the room on every start: a floor learned in a quiet
     *  session would gate you out of a loud one. */
    start() {
      if (_timer) return;
      _above = false;
      _noise = 0.01; _settle = 0;
      _blocks = new Array(6).fill(Infinity); _blockIdx = 0; _blocksFilled = 0;
      _blockMin = Infinity; _blockStart = Date.now();
      _timer = setInterval(tick, 20);
    },
    stop() {
      if (_timer) { clearInterval(_timer); _timer = null; }
      _above = false;
    },
    /** Apply the current latch through the transport's authority — the
     *  external gateAudio (mute toggles call it directly). */
    apply,
    /** Drop the speaking latch without stopping the watch — unmute hands
     *  control back to the gate rather than reopening mid-latch. */
    dropLatch() { _above = false; _openUntil = 0; },
    /** A push-to-talk press: announce the 🎙 as a declared gesture, under the
     *  same once-per-1.5s limit as a level onset. The caller applies the gate. */
    press(now = Date.now()) {
      if (now - _lastOnset > 1500) { _lastOnset = now; announce(); }
    },
    /** `speaking` is what the room is getting: the held answer when there is
     *  one, else threshold PLUS hang-time. */
    info: () => ({ level: level(), noise: _noise, on: threshold(),
      speaking: decide(Date.now()) }),
  };
}
