// audiopanel — the audio section: three category sliders, one consent row.
//
// This is where the categories live, and why they are HERE rather than behind
// a press-and-hold on the HUD toggle: volume is taste you set once, so it
// belongs on a settings row you can find, not a hidden gesture you cannot.
// (A hold-menu also does not survive VR, where the panel is a quad you point
// a laser at — a list of rows works there, a long-press does not.)
//
// Categories:
//   voices — other people's speech, and agent TTS. A resident is a resident.
//   world  — place sound. Not touched by the 🎧 toggle, on purpose.
//   TTS    — synthetic speech specifically, for anyone who wants people but
//            not narration (or the reverse).

import { makeSection } from './ui.js';
import { audioPrefs, setVolume, receivingVoice, setReceiveVoice,
  sttConsented, setSttConsent, isHushed, setHush,
  micFloor, setMicFloor, pttMode, setPttMode } from './voiceconsent.js';
import { micAnalyserLevel as meshMicLevel } from './micstate.js';
// Ask the LIVE transport: the mesh's micStream is null forever on an SFU client, so its level alone reads 0.
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

import { gateUnavailable, ungatedConsent, allowUngated } from './micgate.js';
import { selfMonitor, selfMonitoring } from './micstate.js';
import { why } from './debuglog.js';
/** Is a mic publishing, on whichever transport is live? The one guarded reader: window.relayDiag exists before its
 *  state does, so an early call throws (`?.` covers only absence). */
const micLive = () => {
  try { return window.relayDiag?.().micPublished ?? micOn(); } catch { return micOn(); }
};
import { bus } from './base.js';
import { ttsSection } from './ttsrow.js';
import { micOn, toggleMic } from './micstate.js';
// the mic row's toggleMic needs CONFIG.name; a throwing handler leaves the checkbox checked over nothing
import { CONFIG } from './base.js';

// Rows use the house sheet's .row / .row.wide and its tokens (index.html); no private CSS here, so panels can't drift.
function ensureCss() { /* house sheet — index.html owns .row and .row.wide */ }

// Labels say what they CONTROL ("voice volume"), not what they're about.
const ROWS = [
  ['voices', 'voice volume', 'other people speaking, and agent speech'],
  ['world', 'world volume', 'ambience and place-sound — the 🎧 toggle never touches this'],
  // The SIDETONE only ('voices' already governs all TTS you hear): never a sender-side gain, which would override
  // each listener's own volume and consent.
  ['tts', 'self-TTS volume', 'how loud you hear your own synthesized voice'],
];

function slider(cat, label, hint, value) {
  const row = document.createElement('div');
  row.className = 'sp-row row wide'; // sp-row = the panel's stable markup contract (tools/xr-quad-colour-probe.mjs selects by it)
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl">` +
      `<input type="range" min="0" max="1" step="0.05" value="${value}" data-cat="${cat}" style="flex:1">` +
      `<span class="v" data-out="${cat}" style="min-width:34px;text-align:right">${Math.round(value * 100)}%</span>` +
    `</span>`;
  const input = row.querySelector('input');
  const out = row.querySelector('[data-out]');
  input.oninput = () => {
    const v = setVolume(cat, input.value);
    out.textContent = `${Math.round(v * 100)}%`;
  };
  return row;
}

function checkRow(label, hint, checked, onChange) {
  const row = document.createElement('div');
  row.className = 'sp-row row wide'; // sp-row = the panel's stable markup contract (tools/xr-quad-colour-probe.mjs selects by it)
  // Label first: the grid assigns columns by source order.
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl"><input type="checkbox" ${checked ? 'checked' : ''} title="${hint}"></span>`;
  row.querySelector('input').onchange = (e) => onChange(e.target.checked, e.target);
  return row;
}

// Mic sensitivity: a slider over a LIVE level bar (animates only while its row is in the DOM), in the mic badge's
// palette (mictoggle.js); muted it still moves, dimmer, so a floor can be set before unmuting.
const LVL_LIVE = '#ffd66b';   // = INK.hot in mictoggle.js. One instrument, one gold.
// Mic ON but under the threshold: the bar is hearing you and the gate is not
// passing it. Brighter than muted-dark (something IS happening) and plainly not
// the live gold (nothing is leaving your machine).
const LVL_WARM = '#9a8a5e';
const LVL_DARK = '#6b5f42';   // must stay readable on the black track: muted is dimmer, never invisible

function micFloorRow() {
  const row = document.createElement('div');
  row.className = 'sp-row row wide'; // sp-row = the panel's stable markup contract (tools/xr-quad-colour-probe.mjs selects by it)
  const hint = 'mic level below the marker is treated as room noise, not speech — ' +
    'raise it if typing pings nearby agents; the bar shows your live mic level';
  const FS = 0.2;  // full-scale mic level = right edge of the meter
  row.innerHTML =
    `<span class="nm" title="${hint}">mic sensitivity</span>` +
    `<span class="ctl">` +
    `<span data-meter title="${hint}" style="flex:1;min-width:60px;position:relative;height:14px;` +
    `background:var(--well);border-radius:2px;overflow:hidden;cursor:ew-resize">` +
    `<span data-lvl style="position:absolute;left:0;top:0;height:100%;width:0;background:${LVL_DARK}"></span>` +
    // the marker is a ruler, not a signal: white, so it never competes with the bar's colour
    `<span data-thr style="position:absolute;top:0;height:100%;width:2px;background:rgba(255,255,255,.85);opacity:1"></span>` +
    `</span>` +
    `<span data-out style="min-width:34px;text-align:right">${Math.round(micFloor() * 500)}%</span>` +
    `</span>`;
  const meter = row.querySelector('[data-meter]');
  const out = row.querySelector('[data-out]');
  const lvl = row.querySelector('[data-lvl]');
  const thr = row.querySelector('[data-thr]');
  // Three states: off → dark, on under floor → dim, on over floor → GOLD (INK.hot). Hysteresis: release at 85%
  // of the floor, or the bar strobes on every syllable.
  const REL = 0.85;
  let hot = false;
  // micOn() alone is the mesh's answer (false on SFU); use the shared guarded reader (tools/mic-meter-states.mjs)
  const micIsLive = micLive;   // the shared guarded reader — see module top
  const paintLive = () => {
    if (!micIsLive()) { hot = false; lvl.style.background = LVL_DARK; return; }
    lvl.style.background = hot ? LVL_LIVE : LVL_WARM;
  };
  paintLive();
  bus.on('audio:mic', paintLive);
  // Dragging the threshold must re-evaluate immediately: the bar is the thing
  // you are aiming, so it cannot wait for the next level sample to agree.
  bus.on('audio:micfloor', () => paintLive());
  const paintThr = () => {
    thr.style.left = `calc(${Math.min(100, (micFloor() / FS) * 100)}% - 1px)`;
    out.textContent = `${Math.round(micFloor() * 500)}%`;
  };
  paintThr();
  const setFromX = (ev) => {
    const r = meter.getBoundingClientRect();
    setMicFloor(((ev.clientX - r.left) / r.width) * FS);
    paintThr();
  };
  meter.onpointerdown = (ev) => { meter.setPointerCapture(ev.pointerId); setFromX(ev); };
  meter.onpointermove = (ev) => { if (meter.hasPointerCapture?.(ev.pointerId)) setFromX(ev); };
  const beat = () => {
    if (!row.isConnected) return;
    const level = micLevelNow();
    lvl.style.width = `${Math.min(100, (level / FS) * 100)}%`;
    // Latch above the floor, release at REL× it. Repaint only on a state
    // CHANGE — this runs at frame rate, and assigning a style every frame is
    // how you get a repaint storm behind a bar that already looks fine.
    const floor = micFloor();
    const next = hot ? level > floor * REL : level > floor;
    if (next !== hot) { hot = next; paintLive(); }
    requestAnimationFrame(beat);
  };
  requestAnimationFrame(beat);
  return row;
}

let _body = null;
// Rows are built once; bus events only write .checked via _sync. A rebuild kills the meter's rAF loop and drops
// in-flight drags.
const _sync = { mic: null, hear: null, connect: null };

/** Reflect state onto the existing controls. No DOM construction, no reflow —
 *  this is what the bus handlers call instead of paint(). */
function syncRows() {
  if (!_body) return;
  const p = audioPrefs();   // unused today; kept so slider sync has an obvious home
  void p;
  if (_sync.mic) _sync.mic.checked = micLive();
  if (_sync.hear) _sync.hear.checked = receivingVoice() && !isHushed();
  if (_sync.connect) _sync.connect.checked = receivingVoice();
}

function paint(body) {
  // makeSection calls onOpen(body) on EVERY open, so this must be idempotent:
  // if the rows are already built and still attached, just re-sync them.
  if (body && _body === body && _body.firstChild) { syncRows(); return; }
  _body = body ?? _body;
  if (!_body) return;
  const body_ = _body;
  body_.innerHTML = '';
  const p = audioPrefs();
  // 'hear voices' is the 🎧 glyph's bit (ticking it from fully revoked grants consent too); the mic row is the HUD
  // badge's state. One state, two surfaces: both read and call the same functions.
  const micRow = checkRow('microphone',
    'transmit your voice — the mic glyph beside the HUD is this same switch',
    // 🔴 micOn() reads the MESH's state — on the SFU path it is always false,
    // so the box would render unticked no matter what. Ask whichever transport
    // is live. (window.relayDiag is installed by the SFU bridge.)
    micLive(), async () => {
      // As the badge does: pass CONFIG.name (the mesh path needs it) and use the resolved state, not micOn() after.
      const on = await toggleMic(CONFIG.name);
      bus.emit('audio:mic', on);
    });
  _sync.mic = micRow.querySelector('input');
  body_.append(micRow);
  // PTT decides the regime: checked, the held key is the gate; unchecked, the floor is and V toggles the mic.
  body_.append(checkRow('push-to-talk',
    'transmit only while V is held down — replaces voice activation, so the ' +
    'sensitivity floor below is not used while this is on. Release V and the ' +
    'room hears nothing.',
    pttMode(), (on) => setPttMode(on)));
  const floorRow = micFloorRow();
  body_.append(floorRow);        // sensitivity belongs UNDER the switch it serves
  // Under PTT the floor does nothing: dimmed and inert, not hidden, so it doesn't look functional or go missing.
  const dimFloor = () => {
    const off = pttMode();
    floorRow.style.opacity = off ? '0.45' : '';
    floorRow.style.pointerEvents = off ? 'none' : '';
  };
  dimFloor();
  bus.on('audio:ptt', dimFloor);

  const hearRow = checkRow('hear voices',
    'peers and agent speech — the 🎧 glyph is this same switch',
    receivingVoice() && !isHushed(), (on) => {
      if (on) { if (!receivingVoice()) setReceiveVoice(true); setHush(false); }
      else setHush(true);
    });
  _sync.hear = hearRow.querySelector('input');
  body_.append(hearRow);
  // Toggle, then its volume: the TTS section sits just above its volume slider.
  const ttsHost = document.createElement('div');
  for (const [cat, label, hint] of ROWS) {
    if (cat === 'tts') body_.append(ttsHost);   // the switch, immediately above its slider
    body_.append(slider(cat, label, hint,
      cat === 'world' ? p.volWorld : cat === 'tts' ? p.volTts : p.volVoices));
  }
  // Self-monitor, tapped AFTER the gate's gain node so it plays exactly what the room hears. Off by default:
  // on speakers it feeds back.
  {
    const row = checkRow('hear my own mic (monitor)',
      'plays your gated lane back to you — exactly what the room hears, so silence here means the room hears silence. USE HEADPHONES: on speakers this feeds back.',
      selfMonitoring(), (on, input) => {
        // false before the first mic acquisition (no gate graph yet): untick and say why, never claim a dead monitor
        const took = selfMonitor(on);
        if (on && took === false && input) {
          input.checked = false;
          why('panel', 'monitor refused: no gate graph yet — turn the mic on first');
        }
      });
    body_.append(row);
  }

  // B2 (#90): the gate-unavailable escape hatch. Hidden while the gate works;
  // when the graph cannot be built the mic REFUSES to transmit and this row
  // appears — the explicit, user-visible choice to go raw. Never silent.
  {
    const row = checkRow('transmit UNGATED (voice gate unavailable)',
      'the noise gate could not be built on this device — checking this transmits your raw microphone, room noise and all',
      ungatedConsent(), (on) => allowUngated(on));
    row.style.display = gateUnavailable() ? '' : 'none';
    row.style.color = '#fa5';
    bus.on('voice-gate-unavailable', () => { row.style.display = ''; });
    body_.append(row);
  }
  body_.append(checkRow('speech-to-text',
    'sends your mic audio to your browser vendor’s cloud to transcribe',
    sttConsented(), (on) => setSttConsent(on)));
  // Deliberately last: hush is a gain, this is the connection. Unticked, no inbound media is negotiated at all;
  // the label says what you get, so it doesn't read as a second mute.
  const connectRow = checkRow('connect to other people’s audio',
    'on: your machine holds a live connection to each speaker nearby. ' +
    'Off: nothing is sent to you at all — saves bandwidth and CPU in busy ' +
    'rooms, and strangers cannot see your IP address. Muting only turns the ' +
    'volume down; this unplugs the wire.',
    receivingVoice(), (on) => { setReceiveVoice(on); if (on) setHush(false); });
  _sync.connect = connectRow.querySelector('input');
  body_.append(connectRow);

  // ttsSection owns its host (build() clears it), so it gets its own div; wired last so it can measure the grid gutter.
  ttsSection(ttsHost, () => {});
}

export function initAudioPanel() {
  ensureCss();
  makeSection('🔊 audio', (body) => paint(body), { id: 'audio', host: 'settings' });
  // syncRows(), not paint(): a repaint rebuilds every row (see _sync)
  bus.on('audio:hush', syncRows);
  bus.on('audio:receive', syncRows);
  bus.on('audio:mic', syncRows);          // the badge and this row are one state
}
