// mictoggle — the mic badge: voice controls out of the dock, one clean SVG
// toggle riding beside the ∃, muted by default.
//
// Ours, whole: self-injecting like the workshop button, deletable with this
// file. States, porch doctrine:
//   grey + slash  = mic off (the default — a body should wake up silent)
//   warm ring     = mic live, world can hear you
// A small headphone glyph beside it mutes INCOMING voice separately.
// V toggles the mic from the keyboard, exactly like the porch.

import { micOn, toggleMic, setPttHeld, pttHeld } from './micstate.js';
import { setSTT, sttAvailable } from './stt.js';
import { CONFIG } from './base.js';
import { receivingVoice, setReceiveVoice, ensureSttConsent, sttConsented,
  isHushed, setHush, pttMode } from './voiceconsent.js';
import { bus } from './base.js';
import { register as registerAction } from './actions.js';
import { pathData } from './icons.js';

// states: off = grey + slash · live = bright white · hot (voice picked up for STT) = warm yellow glow. No rings.
// One palette for both glyphs (read as a pair); the headphone's thinner stroke matches ink coverage, not hex.
// Inks are read fresh off the button's tokens each paint, so edit mode's re-pointed OFF inks (--dim, --edge-hi) apply.
const tok = (n, fb) => (getComputedStyle((micBtn?.isConnected && micBtn) || document.documentElement).getPropertyValue(n) || fb).trim();
const INK = {
  get off()   { return tok('--dim', '#7d8f8a'); },
  get absent() { return tok('--edge-hi', 'rgb(255 255 255 / 0.32)'); },   // lighter than off: 'here, but nothing to talk to'
  get on()    { return tok('--brand', '#8fe8c8'); },   // live = brand, like the ∃
  get hot()   { return tok('--attn', '#ffd66b'); },
  // the slash is the OFF state's own ink, not an alarm: a silent body is the
  // rest state here ("a body should wake up silent"), and --err read as the one
  // thing on screen outside the scheme (live, 09-03)
  get slash() { return tok('--dim', '#7d8f8a'); },
};

const MIC_SVG = (on, hot) => {
  const c = hot ? INK.hot : on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 32 32" width="26" height="26" style="${hot ? `filter:drop-shadow(0 0 5px ${INK.hot})` : ''}">
  <g fill="none" stroke="${c}" stroke-width="2" stroke-linecap="round">
    <rect x="12" y="5" width="8" height="14" rx="4" fill="${hot ? c : 'none'}"${hot ? ' fill-opacity=".35"' : ''}/>
    <path d="M8 15 a8 8 0 0 0 16 0"/>
    <line x1="16" y1="23" x2="16" y2="27"/>
    <line x1="11" y1="27" x2="21" y2="27"/>
    ${on ? '' : `<line x1="7" y1="4" x2="25" y2="28" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

// The headphone: consent to HEAR voices (peers and agent TTS), off by default like the mic; ambience has its own
// slider. Glyph: icons.js 'headphonesOff', drawn on its 24 grid at 1.35 wide.
const EAR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  const [band, cupL, cupR, slash] = pathData('headphonesOff');
  return `
<svg viewBox="0 0 24 24" width="26" height="26">
  <g fill="none" stroke="${c}" stroke-width="1.35" stroke-linecap="round">
    <path d="${band}"/>
    <path d="${cupL}"/>
    <path d="${cupR}"/>
    ${on ? '' : `<path d="${slash}" stroke="${INK.slash}"/>`}
  </g>
</svg>`;
};

// Phosphor 'visor' (MIT): regular weight in every state, like its line-drawn neighbours; ink --dim off, --brand live.
const VISOR = { regular: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.85.74,32-5.9,49.38-20.3a15.88,15.88,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56Zm40.81,111.34A55.63,55.63,0,0,1,184,184c-13.88,0-27-9.51-35.65-16.67a31.91,31.91,0,0,0-40.65,0C93.52,179,80.94,184.49,69.28,183.94a56.36,56.36,0,0,1-53.22-53.28A56,56,0,0,1,72,72H183.05c31,0,56.55,24.79,56.95,55.25A55.66,55.66,0,0,1,223.86,167.34ZM184,96a8,8,0,0,1-8,8H80a8,8,0,0,1,0-16h96A8,8,0,0,1,184,96Z', fill: 'M183.05,56H72A72,72,0,0,0,.08,131.4c1.69,36.69,31.76,66.79,68.45,68.52,15.84.72,32-5.9,49.38-20.3a15.87,15.87,0,0,1,20.24,0C148.72,188.39,165,200,184,200a72,72,0,0,0,72-72.95C255.49,87.87,222.76,56,183.05,56ZM176,104H80a8,8,0,0,1,0-16h96a8,8,0,0,1,0,16Z' };
const XR_SVG = (on) => {
  const c = on ? INK.on : INK.off;
  return `
<svg viewBox="0 0 256 256" width="26" height="26" fill="${c}"><path d="${VISOR.regular}"/>${on ? '' : `<line x1="56" y1="32" x2="200" y2="224" stroke="${INK.slash}" stroke-width="14" stroke-linecap="round"/>`}</svg>`;
};

let micBtn = null, earBtn = null, xrBtn = null;
// the third glyph is OPTIONAL: xr.js registers it only where the browser
// answers isSessionSupported('immersive-vr'); until then it does not exist
let xrHook = null;   // { onclick, live: () => bool }
// live: a headset switched off after the page loaded still showed a live-looking visor (isSessionSupported is
// answered once at boot) and the click failed silently. When a session request is refused for want of a device, the
// visor goes lighter grey, blinks twice, and carries an attention-coloured tooltip until the next successful entry.
let xrAbsent = false;
export function markXrAbsent(on = true) { xrAbsent = !!on; paint(); if (on && xrBtn) { xrBtn.classList.remove('hud-blink'); void xrBtn.offsetWidth; xrBtn.classList.add('hud-blink'); } }
export function registerXrGlyph(hook) {
  xrHook = hook;
  ensure();
  applyPairVisibility(); paint(); placeMic();
  bus.emit('xr-glyph');   // the ∃ menu adds its row
}
export const xrGlyphAvailable = () => !!xrHook;
export const xrLive = () => { try { return !!xrHook?.live?.(); } catch { return false; } };
export function flipXr() { xrHook?.onclick?.(); }

let micHot = false;
// the glyph reads the LIVE transport: a control that says private while the room hears you is the one failure this UI
// must never have (micgate fails closed for the same reason)
const micIsOn = () => {
  // never throw out of the indicator: a throw aborts the tick before paint() and freezes the glyph (in flipMic, after
  // toggleMic succeeded). Prefer the cheap getter: relayDiag() allocates, and this runs 8×/second.
  try {
    if (typeof window.__sfuMicOn === 'function') return !!window.__sfuMicOn();
    return window.relayDiag?.().micPublished ?? micOn();
  } catch { return micOn(); }
};
// Mic and hearing state ride the pose packet to everyone in this world, agents included (the owner's decision,
// 2026-10-02, docs/pose-wire.md "Voice state — who sees it"); the tooltip says so rather than leaving it to the docs.
const SHARED = '\nmic and hearing on/off are visible to everyone in this world';
function paint() {
  if (!micBtn) return;
  const on = micIsOn();
  const deaf = on && !receivingVoice();
  micBtn.innerHTML = MIC_SVG(on, on && micHot);
  micBtn.style.opacity = deaf ? '0.55' : '1';
  // under PTT an armed mic isn't heard until the key is down: never say live while private, or private while live
  micBtn.title = !on ? (pttMode() ? 'mic off (click to arm push-to-talk)' : 'mic off (V to talk)')
    : pttMode() ? (pttHeld() ? 'transmitting — release V to stop'
                             : 'push-to-talk armed — hold V to speak')
    : deaf ? 'mic LIVE — but you are not hearing the room (Shift+V to listen)'
    : 'mic LIVE — the world hears you (V)';
  micBtn.title += SHARED;
  if (xrBtn) {
    const live = xrLive();
    xrBtn.innerHTML = xrAbsent && !live ? XR_SVG(false).replace(new RegExp(INK.off.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'), INK.absent) : XR_SVG(live);
    xrBtn.title = live ? 'in VR — click to leave' : xrAbsent ? 'no headset detected — put it on (or wake it) and click again' : 'enter VR';
    xrBtn.classList.toggle('hud-absent', xrAbsent && !live);
  }
  if (earBtn) {
    const consented = receivingVoice();
    const on = consented && !isHushed();
    earBtn.innerHTML = EAR_SVG(on);
    // hushed reads as OFF like any other off-state, at full opacity; hushed vs revoked lives in the tooltip and panel
    earBtn.style.opacity = '1';
    earBtn.title = !consented
      ? 'not receiving voices at all — click to allow (world sound unaffected)'
      : isHushed()
        ? 'hushed — voices still arriving, click to listen again mid-sentence'
        : 'hearing voices — click to hush (Audio panel revokes entirely)';
    earBtn.title += SHARED;
  }
}
// hot = your voice is actually registering: a tiny analyser on the mic track,
// polled at 8Hz, drives the yellow glow in step with STT pickup
import { micAnalyserLevel as meshMicLevel } from './micstate.js';
// ask the live transport's level first (the SFU's), or the glyph can never go hot
function micLevelNow() {
  try {
    if (typeof window.__sfuMyLevel === 'function') return window.__sfuMyLevel();
    return meshMicLevel?.() ?? 0;
  } catch { return 0; }
}

setInterval(() => {
  if (!micIsOn()) { if (micHot) { micHot = false; paint(); } return; }
  const lvl = micLevelNow();
  // the analyser reads the gate's RAW side, so under PTT gate the glow on the key: gold means "the room is getting this"
  const hot = lvl > 0.02 && (!pttMode() || pttHeld());
  if (hot !== micHot) { micHot = hot; paint(); }
}, 125);

// ---- pair API for the ∃ menu: rows toggle these; the pin
// controls whether the pair hangs off the ∃ at all
// per-glyph pins (forcing the pair to pin together was wrong)
const PIN_LS = { mic: 'ew-mic-pinned', ear: 'ew-ear-pinned', xr: 'ew-xr-pinned' };
const _pinned = { mic: true, ear: true, xr: true };
try { for (const k of ['mic', 'ear', 'xr']) _pinned[k] = localStorage.getItem(PIN_LS[k]) !== '0'; } catch {}
export const glyphPinned = (k) => !!_pinned[k];
export function setGlyphPinned(k, v) {
  _pinned[k] = !!v;
  try { localStorage.setItem(PIN_LS[k], v ? '1' : '0'); } catch {}
  applyPairVisibility(); placeMic();
}
function applyPairVisibility() {
  if (micBtn) micBtn.style.display = _pinned.mic ? 'inline-block' : 'none';
  if (earBtn) earBtn.style.display = _pinned.ear ? 'inline-block' : 'none';
  if (xrBtn) xrBtn.style.display = (_pinned.xr && xrHook) ? 'inline-block' : 'none';
}
export const micLive = () => { try { return micIsOn(); } catch { return false; } };
export const earOn = () => { try { return receivingVoice() && !isHushed(); } catch { return false; } };
export { flipMic, flipEar };
// the glyphs' two acts, findable by name (the key is V's voice-activation meaning; in PTT mode V holds to talk)
registerAction({ id: 'voice:mic', title: 'microphone on / off', group: 'voice', key: 'V', icon: 'mic',
  keywords: ['mic', 'mute', 'unmute', 'talk', 'speak', 'voice'], run: () => flipMic() });
registerAction({ id: 'voice:ear', title: 'hear voices on / off', group: 'voice', icon: 'headphones',
  keywords: ['ear', 'hush', 'deafen', 'headphones', 'listen', 'voice'], run: () => flipEar() });
/** the menu wears the SAME glyphs as the floating pair */
export const xrGlyph = (size = 16) => XR_SVG(xrLive()).replace('width="26" height="26"', `width="${size}" height="${size}"`);
/** The in-VR mic indicator's state and glyph (xrmicicon.js): the HUD glyph itself — off / on / hot (transmitting:
 *  level up, and under push-to-talk only while the key or the left A/X is held), same inks. */
export const micIndicatorState = () => (!micIsOn() ? 'off' : micHot ? 'hot' : 'on');
export const micIndicatorSvg = (size = 64) => MIC_SVG(micIsOn(), micHot).replace('width="26" height="26"', `width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg"`);
export const micGlyph = (size = 16) => MIC_SVG(micIsOn(), false).replace('width="26" height="26"', `width="${size}" height="${size}"`);
/** The glyphs for a given state, in the inks they would paint now (harness: client-check MIC reads them in and out of edit mode). */
export const micGlyphFor = (on, hot) => MIC_SVG(!!on, !!hot);
export const earGlyphFor = (on) => EAR_SVG(!!on);
export const earGlyph = (size = 16) => { let on = false; try { on = receivingVoice() && !isHushed(); } catch {} return EAR_SVG(on).replace('width="26" height="26"', `width="${size}" height="${size}"`); };

async function flipMic() {
  const on = await toggleMic(CONFIG.name);
  // speech-to-text is a separate consent (audio goes to the browser vendor's cloud): ask once, remember either answer
  if (on && sttAvailable()) {
    if (await ensureSttConsent()) setSTT(true);
  } else setSTT(false);
  paint();
}

// Two acts, kept apart: CLICK = hush (a gain change; the stream keeps advancing, so unhushing rejoins mid-line);
// SHIFT+V = consent (tears the inbound path down, no media negotiated). Clicking while unconsented grants consent first.
function flipEar() {
  if (!receivingVoice()) { setReceiveVoice(true); setHush(false); }
  else setHush(!isHushed());
  paint();
}

function ensure() {
  const hud = document.querySelector('#hud');
  if (!hud || (document.contains(micBtn) && document.contains(earBtn) && document.contains(xrBtn))) return;
  // inline at the end of the hud's row: setHud(innerHTML) would erase a child, so this sits AFTER the hud as a sibling
  micBtn = document.createElement('span');
  micBtn.id = 'micbtn'; micBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  micBtn.onclick = flipMic;
  document.body.appendChild(micBtn);
  earBtn = document.createElement('span');
  earBtn.id = 'earbtn'; earBtn.style.cssText = 'cursor:pointer;display:inline-block;line-height:0;position:fixed;z-index:45;';
  earBtn.onclick = flipEar;
  document.body.appendChild(earBtn);
  xrBtn = document.createElement('span');
  xrBtn.id = 'xrbtn'; xrBtn.style.cssText = 'cursor:pointer;display:none;line-height:0;position:fixed;z-index:45;';
  xrBtn.onclick = flipXr;
  document.body.appendChild(xrBtn);
  paint();
  applyPairVisibility();
  placeMic();          // position + bind the observer the moment we exist
}
// anchored to the hud panel's live box by ResizeObserver (moves in the same frame); the slow interval is only a
// safety net for what no observer sees (font swaps, zoom)
let _hudRO = null, _hudSeen = null;
function placeMic() {
  const hud = document.querySelector('#hud');
  if (!hud || !micBtn) return;
  const r = hud.getBoundingClientRect();
  // hang off the ∃ ALONG its own edge (the rail's line continues through
  // them); fold perpendicular only when a corner leaves no room
  const edge = document.getElementById('dock')?.dataset.edge || 'left';
  // publish the edge: windows.js CHROME_ANCHOR reads `dataset.edge` to charge these to the right side (else
  // `|| 'left'` wins); true in both placements below, stacked on the rail or folded round its corner
  for (const b of [micBtn, earBtn, xrBtn]) if (b) b.dataset.edge = edge;
  const cx = Math.round(r.left + (r.width - 26) / 2);
  const cy = Math.round(r.top + (r.height - 26) / 2);
  const pos = (b, x, y) => { b.style.left = x + 'px'; b.style.top = y + 'px'; b.style.right = b.style.bottom = ''; };
  const vert = edge === 'left' || edge === 'right';
  const room = vert ? r.top : r.left;              // space before the ∃ along the rail
  // mic is ALWAYS the top/left of whatever is visible, and a lone
  // pinned glyph packs into the slot nearest the ∃ (pins are per-glyph)
  const vis = [ _pinned.mic && micBtn, _pinned.ear && earBtn, _pinned.xr && xrHook && xrBtn ].filter(Boolean);
  const n = vis.length;
  if (n) {
    if (room >= 42 + 32 * (n - 1)) {
      // along the edge, stacked before the ∃ (slot 0 = adjacent)
      vis.forEach((b, i) => {
        const off = 34 + 32 * (n - 1 - i);
        if (vert) pos(b, cx, Math.round(r.top) - off);
        else pos(b, Math.round(r.left) - off, cy);
      });
    } else {
      // corner: fold around it, perpendicular into the canvas
      vis.forEach((b, i) => {
        if (edge === 'left')       pos(b, Math.round(r.right) + 6 + 32 * i, cy);
        else if (edge === 'right') pos(b, Math.round(r.left) - 32 - 32 * (n - 1 - i), cy);
        else if (edge === 'top')   pos(b, cx, Math.round(r.bottom) + 6 + 32 * i);
        else                       pos(b, cx, Math.round(r.top) - 32 - 32 * (n - 1 - i));
      });
    }
  }
  applyPairVisibility();
  // (re)bind the observer if the hud element itself was replaced
  if (hud !== _hudSeen) {
    _hudSeen = hud;
    _hudRO?.disconnect();
    _hudRO = new ResizeObserver(placeMic);
    _hudRO.observe(hud);
  }
}
addEventListener('resize', placeMic);
addEventListener('dockmoved', placeMic);   // live re-anchor while the rail is dragged
setInterval(placeMic, 2000);          // safety net only; the observer does the work
// the glyph REFLECTS state, it does not own it: any surface that changes
// hush/consent repaints it, so a panel tick and a HUD click can never
// disagree about what you are hearing
bus.on('audio:hush', paint);
bus.on('audio:receive', paint);
// 🔴 'audio:mic' was EMITTED from three sites (voice.js:510, and twice in
// voicesfubridge.js) and subscribed by nobody. The glyph repainted only from
// its own 125ms poll, which read mesh state — so under SFU it never moved.
bus.on('audio:mic', paint);
bus.on('style', paint);
bus.on('xr:state', paint);
// edit mode moves the ∃ into the workspace's corner and re-inks the glyphs: re-seat and repaint once its CSS is on
bus.on('edit-mode', () => requestAnimationFrame(() => { paint(); placeMic(); }));   // session start/end (live 09-05 22:04)       // the badge is baked from tokens (INK) — a Style change repaints it (live, 09-05)
setInterval(ensure, 1000);
ensure();

// "typing" means a text field, not any input: focus stays on a checkbox after a click (e.g. enabling PTT), and V must
// still work there; only where V would insert a character is it ignored
const TEXT_INPUT = /^(text|search|url|email|password|number|tel|)$/i;   // '' = default type
const typingTarget = () => {
  const el = document.activeElement;
  if (!el) return false;
  if (el.isContentEditable) return true;
  if (el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TEXT_INPUT.test(el.type ?? '');
};
window.addEventListener('keydown', (e) => {
  if (e.repeat || typingTarget()) return;
  if (e.code !== 'KeyV' || e.shiftKey) return;
  // V speaks; hush is a click on 🎧 and revoking consent lives only in the Audio panel (two near-identical gestures
  // with different guarantees mislead). In PTT mode V is hold-to-speak; on/off moves to the glyph and the panel.
  if (pttMode()) {
    if (micIsOn()) { setPttHeld(true); paint(); }
    return;
  }
  flipMic();
});
window.addEventListener('keyup', (e) => {
  if (e.code !== 'KeyV') return;
  setPttHeld(false);   // harmless in voice-activation mode; vital in PTT
  if (pttMode()) paint();
});
// 🔴 THE STUCK-KEY CLASS. keyup never arrives if focus left with the key down
// (alt-tab mid-sentence, a click into another window) — every PTT
// implementation that skips this ships an open mic that says it is closed.
window.addEventListener('blur', () => { setPttHeld(false); if (pttMode()) paint(); });
