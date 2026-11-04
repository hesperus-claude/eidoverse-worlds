// audiopanel — the audio section: three category sliders, one consent row. Volume is taste you
// set once, so it lives on a findable settings row (which also works as a VR quad), not a gesture.
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
// ASK THE LIVE TRANSPORT: the mesh's micStream is null forever on an SFU client, so the mesh
// level alone would read 0 there.
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

import { gateUnavailable, ungatedConsent, allowUngated } from './micgate.js';
import { selfMonitor, selfMonitoring } from './micstate.js';
import { why } from './debuglog.js';
/** Is a mic actually publishing, whichever transport is live? GUARDED: voicerelay installs
 *  window.relayDiag before its state exists, so an early call THROWS (`?.` covers absence only).
 *  The one reader every row uses. */
const micLive = () => {
  try { return window.relayDiag?.().micPublished ?? micOn(); } catch { return micOn(); }
};
import { bus } from './base.js';
import { ttsSection } from './ttsrow.js';
import { micOn, toggleMic } from './micstate.js';
// CONFIG: the mic row's toggleMic wants the actor NAME.
import { CONFIG } from './base.js';

// The panel's rows use the house sheet's `.row.wide` (index.html): two columns on a shared centre
// line, labels in --fg, hints and units in --dim, controls in --accent. No private stylesheet.
function ensureCss() { /* house sheet — index.html owns .row and .row.wide */ }

// Labels say what they CONTROL ("voice volume"), not what they are about ("voices").
const ROWS = [
  ['voices', 'voice volume', 'other people speaking, and AI speech'],
  ['world', 'world volume', 'ambience and place-sound — the 🎧 toggle never touches this'],
  // "self-TTS volume": synthesized speech already rides the 'voices' lane (voicesource.js), so
  // this slider scales only the SIDETONE — what you hear of your own synthesized voice — never
  // what goes out: a listener controls what they hear.
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
  // LABEL FIRST in the markup: the grid assigns columns by source order.
  row.innerHTML =
    `<span class="nm" title="${hint}">${label}</span>` +
    `<span class="ctl"><input type="checkbox" ${checked ? 'checked' : ''} title="${hint}"></span>`;
  row.querySelector('input').onchange = (e) => onChange(e.target.checked, e.target);
  return row;
}

// mic sensitivity: a slider over a LIVE level bar, so you can see where your voice lands versus
// your keyboard before choosing the floor. The bar animates only while its row is in the DOM.
// The meter uses the mic BADGE's palette (mictoggle.js) — they read as one control. LIVE is the
// badge's gold; DARK is the same hue at a quarter value, so the bar still MOVES while muted.
const LVL_LIVE = '#ffd66b';   // = INK.hot in mictoggle.js. One instrument, one gold.
// Mic ON but under the threshold: the bar is hearing you and the gate is not
// passing it. Brighter than muted-dark (something IS happening) and plainly not
// the live gold (nothing is leaving your machine).
const LVL_WARM = '#9a8a5e';
const LVL_DARK = '#6b5f42';
// A muted meter must still be READABLE: "not transmitting" is dimmer, not invisible.

function micFloorRow() {
  const row = document.createElement('div');
  row.className = 'sp-row row wide'; // sp-row = the panel's stable markup contract (tools/xr-quad-colour-probe.mjs selects by it)
  const hint = 'mic level below the marker is treated as room noise, not speech — ' +
    'raise it if typing pings nearby AIs; the bar shows your live mic level';
  const FS = 0.2;  // full-scale mic level = right edge of the meter
  row.innerHTML =
    `<span class="nm" title="${hint}">mic sensitivity</span>` +
    `<span class="ctl">` +
    `<span data-meter title="${hint}" style="flex:1;min-width:60px;position:relative;height:14px;` +
    `background:var(--well);border-radius:2px;overflow:hidden;cursor:ew-resize">` +
    `<span data-lvl style="position:absolute;left:0;top:0;height:100%;width:0;background:${LVL_DARK}"></span>` +
    // The marker is a RULER, not a signal: white states a position and never competes with the bar's colour.
    `<span data-thr style="position:absolute;top:0;height:100%;width:2px;background:rgba(255,255,255,.85);opacity:1"></span>` +
    `</span>` +
    `<span data-out style="min-width:34px;text-align:right">${Math.round(micFloor() * 500)}%</span>` +
    `</span>`;
  const meter = row.querySelector('[data-meter]');
  const out = row.querySelector('[data-out]');
  const lvl = row.querySelector('[data-lvl]');
  const thr = row.querySelector('[data-thr]');
  // THREE STATES:
  //   mic off        → dark (still moves, so you can set a floor before unmuting)
  //   on, under floor→ dim  (hearing you, not passing the gate)
  //   on, over floor → GOLD (INK.hot from mictoggle.js: this is what the room actually gets)
  // With hysteresis: release at 85% of the floor, so it latches through the gaps inside a word
  // and drops on a real pause instead of strobing on every syllable.
  const REL = 0.85;
  let hot = false;
  // ask the live transport, not the mesh (see micLive at the top)
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
// THE ROWS ARE BUILT ONCE AND THEN UPDATED IN PLACE: a rebuild would make the panel jump, kill
// the meter's rAF chain (beat() ends on !row.isConnected) and drop a threshold drag mid-gesture.
// The three synced checkboxes keep a reference here; a bus event writes `.checked` and nothing
// else moves. Everything else owns its own state (sliders write through; the meter animates itself).
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
  // 'hear voices' is the same bit the 🎧 glyph toggles, so the two never disagree; ticking it from
  // a fully-revoked state grants consent too, like the glyph.
  // MIC FIRST — the control people reach for, and the one that transmits. Synced to the HUD badge
  // the same way: both read the shared state and call the same toggleMic.
  const micRow = checkRow('microphone',
    'transmit your voice — the mic glyph beside the HUD is this same switch',
    // ask whichever transport is live (window.relayDiag is installed by the SFU bridge)
    micLive(), async () => {
      // pass the actor name (as mictoggle.js does) and use toggleMic's resolved state: reading
      // micOn() after the await races the async publish
      const on = await toggleMic(CONFIG.name);
      bus.emit('audio:mic', on);
    });
  _sync.mic = micRow.querySelector('input');
  body_.append(micRow);
  // PTT sits between the mic switch and the sensitivity floor because it
  // DECIDES which of the two regimes below it is real: checked, the gate is
  // the held key and the floor drives nothing; unchecked, voice activation
  // owns the gate and V goes back to being the mic toggle.
  body_.append(checkRow('push-to-talk',
    'transmit only while V is held down — replaces voice activation, so the ' +
    'sensitivity floor below is not used while this is on. Release V and the ' +
    'room hears nothing.',
    pttMode(), (on) => setPttMode(on)));
  const floorRow = micFloorRow();
  body_.append(floorRow);        // sensitivity belongs UNDER the switch it serves
  // Under PTT the floor drives nothing: dimmed and inert, not hidden, so the row stays findable
  // and the dim says it belongs to the other mode.
  const dimFloor = () => {
    const off = pttMode();
    floorRow.style.opacity = off ? '0.45' : '';
    floorRow.style.pointerEvents = off ? 'none' : '';
  };
  dimFloor();
  bus.on('audio:ptt', dimFloor);

  const hearRow = checkRow('hear voices',
    'peers and AI speech — the 🎧 glyph is this same switch',
    receivingVoice() && !isHushed(), (on) => {
      if (on) { if (!receivingVoice()) setReceiveVoice(true); setHush(false); }
      else setHush(true);
    });
  _sync.hear = hearRow.querySelector('input');
  body_.append(hearRow);
  // TOGGLE, THEN ITS VOLUME: voice volume · world volume · [tts toggle + model list] ·
  // self-TTS volume. The slider that belongs to a switch sits under it.
  const ttsHost = document.createElement('div');
  for (const [cat, label, hint] of ROWS) {
    if (cat === 'tts') body_.append(ttsHost);   // the switch, immediately above its slider
    body_.append(slider(cat, label, hint,
      cat === 'world' ? p.volWorld : cat === 'tts' ? p.volTts : p.volVoices));
  }
  // HEAR YOUR OWN LANE (micgate.js setMonitor): settles "is the gate actually working?". Tapped
  // AFTER the gain node (micgate.js), so when the gate closes the monitor goes quiet too. Default
  // off and low: on speakers it howls, which the hint says.
  {
    const row = checkRow('hear my own mic (monitor)',
      'plays your gated lane back to you — exactly what the room hears, so silence here means the room hears silence. USE HEADPHONES: on speakers this feeds back.',
      selfMonitoring(), (on, input) => {
        // setMonitor() returns false before the gate graph exists (before the first mic
        // acquisition): untick and say why rather than claim a dead monitor
        const took = selfMonitor(on);
        if (on && took === false && input) {
          input.checked = false;
          why('panel', 'monitor refused: no gate graph yet — turn the mic on first');
        }
      });
    body_.append(row);
  }

  // B2: the gate-unavailable escape hatch. Hidden while the gate works; when the graph cannot be
  // built the mic REFUSES to transmit and this row appears — the explicit choice to go raw.
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
  // The structural act, deliberately last: hush is a gain, this is the connection. Unticking
  // negotiates no inbound media at all — the only row here that is a guarantee rather than a
  // preference. The wording leads with what you GET, so it doesn't read as a second mute.
  const connectRow = checkRow('connect to other people’s audio',
    'on: your machine holds a live connection to each speaker nearby. ' +
    'Off: nothing is sent to you at all — saves bandwidth and CPU in busy ' +
    'rooms, and strangers cannot see your IP address. Muting only turns the ' +
    'volume down; this unplugs the wire.',
    receivingVoice(), (on) => { setReceiveVoice(on); if (on) setHush(false); });
  _sync.connect = connectRow.querySelector('input');
  body_.append(connectRow);

  // The TTS voice section (ttsrow.js), beside the tts volume slider. ttsSection OWNS ITS HOST
  // (build() clears it), so it gets its own div; wired here, after every row exists, so it can
  // measure the grid gutter.
  ttsSection(ttsHost, () => {});
}

export function initAudioPanel() {
  ensureCss();
  makeSection('🔊 audio', (body) => paint(body), { id: 'audio', host: 'settings' });
  // Either control moving updates the other's row — one truth, two surfaces.
  // syncRows(), NOT paint(): these fire on every toggle and only three booleans need mirroring.
  bus.on('audio:hush', syncRows);
  bus.on('audio:receive', syncRows);
  bus.on('audio:mic', syncRows);          // the badge and this row are one state
}
