// voicesource — where your voice comes from.
//
// A participant's voice is a property of that participant, not a second client
// in the room (one body per id). voice.js asks THIS module for a MediaStream
// instead of calling getUserMedia; everything downstream (sender, falloff,
// volumeFor, consent, mute) only sees a MediaStream.
//
//   humans → getUserMedia (the browser/OS default device)
//   agents → a SYNTH PROVIDER, registered by whatever is driving the body
//
// No synthesizer lives here: a provider hands over a finished MediaStreamTrack,
// and how its samples are made is the provider's business.

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

// ── track-change notification ────────────────────────────────────────────────
// A provider that rebuilds its track calls notifySynthTrackChanged(newTrack).
// A Set, not a single slot: with one slot the last module to register silently
// won and the other's hook never fired. Handlers are isolated — one throwing
// must not deny the others.
const rebuildHooks = new Set();
export const setGeneratorRebuildHook = (fn) => { rebuildHooks.add(fn); return () => rebuildHooks.delete(fn); };
export const notifySynthTrackChanged = (track) => {
  for (const fn of rebuildHooks) {
    try { fn(track); } catch (e) { report('synth track-change hook', e); }
  }
};

// ── the source ───────────────────────────────────────────────────────────────
export async function voiceSource({ micWanted = true } = {}) {
  // A body has ONE mic, and a LIVE MIC WINS OUTRIGHT; mic off drops back to the
  // synth provider (its enablement is left standing — a priority, not a toggle).
  // "Mic off" is not "no mic": micWanted:false takes the synth path directly
  // rather than opening a device the caller declined. Default true.
  if (!micWanted) {
    // No provider is not permission: falling through to getUserMedia would open
    // the declined device. Nothing to publish is an answer, not a fallback.
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
  // Mark it SYNTHETIC: the caller must not wrap it in the WebAudio gate (no room
  // noise to gate, and the gate's AudioContext clock is dead in headless bodies).
  ms.synthetic = true;
  return ms;
}
