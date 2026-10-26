// voicesource — the MediaStream your voice comes from: mic for humans, a registered synth provider for agents, so
// spatialization, consent and mute apply unchanged to both. No synthesizer here: a provider hands over a track.

import { report } from './base.js';

// ── the synth-provider contract ──────────────────────────────────────────────
// {
//   available(): boolean            — can this provider produce a track NOW
//   start(): MediaStreamTrack       — begin producing; returns the live track
//   stop(): void                    — cease producing (track may end)
//   label?: string                  — shown in the audio panel
// }
// null = this body has no synthetic voice
let provider = null;

export function setSynthProvider(p) {
  provider = p || null;
  return provider;
}
export const synthProvider = () => provider;

// a list, not a slot (a slot lets the last registrant silently win); each hook runs isolated
const rebuildHooks = new Set();
export const setGeneratorRebuildHook = (fn) => { rebuildHooks.add(fn); return () => rebuildHooks.delete(fn); };
export const notifySynthTrackChanged = (track) => {
  for (const fn of rebuildHooks) {
    try { fn(track); } catch (e) { report('synth track-change hook', e); }
  }
};

// ── the source ───────────────────────────────────────────────────────────────
export async function voiceSource({ micWanted = true } = {}) {
  // a mic turned off takes the synth path without opening the device; no provider means publish nothing
  if (!micWanted) {
    if (provider?.available?.()) return synthStream();
    throw new Error('mic declined and no synth provider registered — nothing to publish');
  }
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return mic;
  } catch (e) {
    // no mic or permission refused: a willing synth provider is the whole voice
    if (provider?.available?.()) return synthStream();
    throw e;
  }
}

/** shared by both synth paths (no mic, mic off) so they cannot drift apart */
function synthStream() {
  const track = provider.start();
  const ms = new MediaStream([track]);
  // Synthetic, not a device: callers must not wrap it in the WebAudio gate (no room noise, and the gate's
  // AudioContext clock is dead in headless bodies).
  ms.synthetic = true;
  return ms;
}

/** an ended track transmits silence forever while ICE and direction look healthy */
export function sourceIsDead(stream) {
  const t = stream?.getAudioTracks?.()[0];
  return !!t && t.readyState === 'ended';
}
