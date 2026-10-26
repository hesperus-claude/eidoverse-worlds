// micgate — the noise gate as a smoothed GAIN, not a switch: `track.enabled` is binary and clicks on the first consonant.
//
//     voiceSource()  →  MediaStreamSource  →  GainNode  →  MediaStreamDestination
//                                               ↑                     ↓
//                                        gate (this file)    the track WebRTC sends
//
// The analyser reads the SOURCE side, never the gated side, or the gate latches shut. A device always passes the gate;
// a synthetic source bypasses it (micstate.js gateFor).

import { audioContext } from './audioctx.js';
import { report } from './base.js';

// seconds; worst-case open = 20 ms tick + 3τ ≈ 44 ms (a plosive is ~20-40 ms); attack faster than release (a late open
// loses a consonant, an early close cuts a word)
// one smoothing stage only (see driveGate)
// release: a ~360 ms tail AFTER the 700 ms hang; never copy BasisVR's 0.10/0.05 (per audio frame, not per tick)
const ATTACK_TAU = 0.008;
const RELEASE_TAU = 0.12;
// delay the AUDIO, not the detector, so an unvoiced onset (/h/) is still in the line when the gate opens; costs 50 ms
const LOOKAHEAD = 0.05;

let _ctx = null, _src = null, _gain = null, _dest = null, _look = null;
let _rawStream = null, _gatedStream = null, _level = () => 0;

// ── a privacy control must not silently go off: with no gate graph the stream is REFUSED (null: never transmit)
// unless the user chose allowUngated(true)
let _gateUnavailable = false;   // the graph could not be built on this device
let _ungatedConsent = false;    // explicit "transmit raw anyway" choice
export const gateUnavailable = () => _gateUnavailable;
export const ungatedConsent = () => _ungatedConsent;
export function allowUngated(on) { _ungatedConsent = !!on; }

/** Wrap a mic stream in the gate graph; returns the stream for WebRTC, or null when the graph can't be built. */
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
    // start CLOSED: opening on the first frame broadcasts the room before the settle window has learned it
    _gain.gain.value = 0;
    // `_wanted` outlives its graph: without this reset micTransmitting() claims "audible" before the first tick
  _wanted = 0;
    _dest = _ctx.createMediaStreamDestination();
    // without createDelay the gate must still be built: only the lookahead is lost
    _look = null;
    if (typeof _ctx.createDelay === "function") {
      try {
        _look = _ctx.createDelay(0.2);
        _look.delayTime.value = LOOKAHEAD;
      } catch { _look = null; /* no lookahead; gate still real */ }
    }
    if (_look) { _src.connect(_look); _look.connect(_gain); }
    else _src.connect(_gain);
    _gain.connect(_dest);
    _gatedStream = _dest.stream;

    // muting acts on the RAW track, so both streams stay live; the gate only scales what reaches the destination
    return _gatedStream;
  } catch (e) {
    report('mic gate graph', e);
    release();
    // FAIL CLOSED: silent-with-a-reason beats secretly-raw; allowUngated(true) is the explicit way back
    _gateUnavailable = true;
    return _ungatedConsent ? stream : null;
  }
}

export function driveGate(open) {
  if (!_gain || !_ctx) return;
  // DO NOT DOUBLE-SMOOTH: setTargetAtTime IS the envelope; target 1 or 0 directly (a lerped step fed to it never closes)
  const target = open ? 1 : 0;
  const tau = open ? ATTACK_TAU : RELEASE_TAU;
  try {
    _gain.gain.setTargetAtTime(target, _ctx.currentTime, tau);
  } catch { _gain.gain.value = target; }
  _wanted = target;
}

// ── the ungated lane has no gain: push-to-talk drives the raw tracks' `enabled` (abrupt but true); the intent feeds
// gateOpenness()
let _rawWanted = 0;
export function driveRawTracks(open) {
  if (!_rawStream) return false;
  for (const t of _rawStream.getAudioTracks?.() ?? []) t.enabled = !!open;
  _rawWanted = open ? 1 : 0;
  return true;
}


// ── MONITOR: tapped AFTER the gain, so you hear what the room hears (a raw-side tap sounds fine while the room hears nothing)
// on speakers it howls: low default, said in the UI
let _mon = null, _delay = null, _wanted = 0;
// seconds: heard as a separate event, not an echo
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
    // past the ~50 ms echo threshold, so the repeat is distinct from bone conduction; no createDelay → no delay, not a throw
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
  // ramped: a step in a monitor path clicks straight into the ears
  try { _mon.gain.setTargetAtTime(level, _ctx.currentTime, 0.02); }
  catch { _mon.gain.value = level; }
  return true;
}
export const monitoring = () => !!_mon;

/** "Am I being broadcast": the gate's INTENT, not the mid-fade .value, so the indicator never flickers through an envelope. */
export const gateOpenness = () => (_gain ? _wanted : (_gateUnavailable && _rawStream ? _rawWanted : 0));
export const gateGainNow = () => (_gain ? _gain.gain.value : 0);
export const isGated = () => !!_gain;

/** Detach the device, keep the lane: sender tracks stay live, so the mic's return needs no renegotiation.
 *  Tear down tracks only on leave or audio opt-out. */
export function detachSource() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  _src = null;
  _rawStream = null;
  if (_gain) _gain.gain.value = 0;        // lane open, silent
}

/** Reconnect a device into the EXISTING lane; returns the gated stream the senders already hold. */
export function attachSource(stream) {
  if (!_ctx || !_gain || !_dest) return null;
  try { _src?.disconnect(); } catch { /* fine */ }
  _src = _ctx.createMediaStreamSource(stream);
  // through the SAME lookahead as gateStream, or a reconnect silently loses the first syllable
  if (_look) _src.connect(_look); else _src.connect(_gain);
  _rawStream = stream;
  return _gatedStream;
}

/** Full teardown, lane included: ONLY for leaving or revoking consent, never for going quiet (undoing it renegotiates). */
export function release() {
  try { _src?.disconnect(); } catch { /* already gone */ }
  try { _look?.disconnect(); } catch { /* already gone */ }
  _look = null;
  try { _gain?.disconnect(); } catch { /* already gone */ }
  // this module built the monitor tap, so this module disconnects it (#90)
  try { _mon?.disconnect(); } catch { /* already gone */ }
  _mon = null;
  // never stop the destination's tracks: WebRTC holds them and stop() is one-way; the caller's sender cleanup owns that
  _src = _gain = _dest = null;
  _gatedStream = null;
  _rawStream = null;
  _rawWanted = 0;
}

/** The RAW stream, for true-input measurement: measuring the gated output makes the gate self-latching. */
export const rawStream = () => _rawStream;

/** Retune the monitor delay live, seconds (0…2). */
export function setMonitorDelay(sec) {
  MONITOR_DELAY = Math.max(0, Math.min(2, Number(sec) || 0));
  if (_delay && _ctx) {
    try { _delay.delayTime.setTargetAtTime(MONITOR_DELAY, _ctx.currentTime, 0.05); }
    catch { _delay.delayTime.value = MONITOR_DELAY; }
  }
  return MONITOR_DELAY;
}
export const monitorDelay = () => MONITOR_DELAY;

// ── the onset machine + level meter, ONE copy (§24l): each transport instantiates it with its own stream/mute closures

/** RMS level meter over getMeasured() (null = muted: 0, learn nothing). One AudioContext, reused: Chrome silently
 *  caps a document at ~6. A replaced analyser pair is disconnected so the graph can't grow. */
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

/** The speech-onset gate: block-minima noise floor, ~3 dB hysteresis, 700 ms hang, one 🎙 per utterance.
 *  `drive(open)` applies the transport's lane/mute authority first; `level()` 0 = muted: close, drop the latch, learn nothing.
 *  - DRIVE THE GATE BEFORE ANY EARLY RETURN
 *  - LEARN BEFORE JUDGING (~1 s settle, or a loud room fires the 🎙 at itself)
 *  - the floor is min-of-block-minima (6 × 0.4 s), so SPEECH CAN NEVER RAISE IT
 *  - THE PILL AND THE AUDIO MUST AGREE: announce after 60 ms open, at most once per 1.5 s
 *  - `speaking` is threshold PLUS hang-time, or the bar goes dark through pauses the room still hears
 *  - 20 ms tick: the interval is the worst-case clip on a word's attack */
export function makeOnsetGate({ level, threshold, drive, announce, held = () => null }) {
  let _timer = null, _above = false, _lastOnset = 0, _openUntil = 0;
  let _openedAt = 0, _announced = false;
  let _noise = 0.01, _settle = 0;
  let _blocks = new Array(6).fill(Infinity), _blockIdx = 0, _blocksFilled = 0,
      _blockMin = Infinity, _blockStart = 0;

  // push-to-talk: `held()` is null when the level decides, else the key's boolean. Under a held answer the level side
  // still meters and learns but drives nothing and never fires the 🎙; press() announces, same rate-limit.
  const decide = (now) => { const h = held(); return h === null ? (_above || now <= _openUntil) : h; };
  const apply = (now) => drive(decide(now));

  function tick() {
    const lv = level();
    if (lv <= 0) {
      // muted: close, don't learn, DROP THE LATCH, or info().speaking stays true while the gate is forced shut
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
    /** Re-measure the room on every start: a quiet session's floor would gate you out of a loud one. */
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
    /** The external gateAudio: mute toggles call it directly. */
    apply,
    /** Unmute hands control back to the gate rather than reopening mid-latch. */
    dropLatch() { _above = false; _openUntil = 0; },
    /** A push-to-talk press: announce the 🎙, same once-per-1.5 s limit; the caller applies the gate. */
    press(now = Date.now()) {
      if (now - _lastOnset > 1500) { _lastOnset = now; announce(); }
    },
    /** `speaking`: the held answer when there is one, else threshold PLUS hang-time. */
    info: () => ({ level: level(), noise: _noise, on: threshold(),
      speaking: decide(Date.now()) }),
  };
}
