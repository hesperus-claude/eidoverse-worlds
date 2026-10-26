// voicesource — where your voice comes from.
//
// A voice is a property of the participant, not a second client: voice code (voicesfu.js) asks here for a
// MediaStream, so spatialization, consent and mute apply unchanged to humans (getUserMedia) and agents (a
// registered synth provider). Deliberately no synthesizer here: a provider hands over a finished track.

import { report } from './base.js';

// ── the synth-provider contract ──────────────────────────────────────────────
// {
//   available(): boolean            — can this provider produce a track NOW
//   start(): MediaStreamTrack       — begin producing; returns the live track
//   stop(): void                    — cease producing (track may end)
//   label?: string                  — shown in the audio panel
// }
// One provider, replaceable. null = this body has no synthetic voice.
let provider = null;

export function setSynthProvider(p) {
  provider = p || null;
  return provider;
}
export const synthProvider = () => provider;

// ── track-change notification ──: a provider that rebuilds its track calls notifySynthTrackChanged(track).
// Hooks are a list, not a slot (a slot lets the last registrant silently win); each runs isolated.
const rebuildHooks = new Set();
export const setGeneratorRebuildHook = (fn) => { rebuildHooks.add(fn); return () => rebuildHooks.delete(fn); };
export const notifySynthTrackChanged = (track) => {
  for (const fn of rebuildHooks) {
    try { fn(track); } catch (e) { report('synth track-change hook', e); }
  }
};

// ── the source ───────────────────────────────────────────────────────────────
export async function voiceSource({ micWanted = true } = {}) {
  // A live mic wins outright. A mic the user turned off (micWanted:false), not only a missing one, takes the
  // synth path without opening the device; the provider's enablement stays standing.
  if (!micWanted) {
    // No provider is not permission: a declined mic with nothing to replace it publishes nothing.
    if (provider?.available?.()) return synthStream();
    throw new Error('mic declined and no synth provider registered — nothing to publish');
  }
  try {
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true },
    });
    return mic;
  } catch (e) {
    // No microphone, or permission refused. If a synth provider is registered
    // and willing, that is the whole voice — the agent path, and the path a
    // human with no mic takes to still be heard.
    if (provider?.available?.()) return synthStream();
    throw e;
  }
}

/** The synth provider's track as a stream, marked so callers can tell it from a
 *  device. Extracted so the two paths that reach it — no mic, and mic
 *  deliberately off — cannot drift apart. */
function synthStream() {
  const track = provider.start();
  const ms = new MediaStream([track]);
  // Synthetic, not a device: callers must not wrap it in the WebAudio gate (no room noise, and the gate's
  // AudioContext clock is dead in headless bodies).
  ms.synthetic = true;
  return ms;
}

/** True when the current source's track has died and needs re-making. The
 *  liveness check nothing was doing — an `audio:ended` sender transmits
 *  silence forever while ICE and direction both look perfectly healthy. */
export function sourceIsDead(stream) {
  const t = stream?.getAudioTracks?.()[0];
  return !!t && t.readyState === 'ended';
}
