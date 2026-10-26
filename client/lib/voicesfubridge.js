// voicesfubridge — joins voicesfu.js (pure WebRTC) to the world websocket: this half knows `net`, the bus and the verb
// names, so voicesfu.js stays transport-only and testable without a socket.
// It exposes window.relayDiag / window.relayMic: the shape every browser smoke asserts against.
import { bus, CONFIG } from './base.js';
import { net, sendRelayCredRequest, sendVoiceConsent } from './net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels, sfuMyLevel,
  sfuDiagClient, sfuClose, sfuActive, sfuSpeakerEntries, sfuInboundStats, sfuMicOn,
  sfuMicWanted, sfuDropSpeaker } from './voicesfu.js';
import { remotes } from './remotes.js';
import { myState } from './controller.js';
import { isHushed, volumeFor, receivingVoice, VOICE_FULL_M, VOICE_SILENT_M } from './voiceconsent.js';
import { setGeneratorRebuildHook, synthProvider } from './voicesource.js';

const send = (o) => { if (net.ws?.readyState === 1) net.ws.send(JSON.stringify(o)); };

// A synth track arriving with no lane (mic off, TTS loaded later) must become the lane; sfuPublish() already asks
// voiceSource() and handles a synthetic stream, so this only triggers it.
setGeneratorRebuildHook(() => {
  // Only when the user is not already publishing a microphone: a live mic wins
  // outright (voicesource.js's own doctrine), and re-publishing under one would
  // swap a device the user deliberately turned on for a synthesizer.
  if (sfuMicOn()) return;
  if (!synthProvider()?.available?.()) return;
  void sfuMic(false);   // re-enters the swap path, which now finds the provider
});

export function initVoiceSfu(name) {
  // Ask for the media credential once joined (check now and listen: a fast join can fire first). Re-arm on every
  // reconnect: sends here are fire-and-forget, so a new connection restates credential, consent and position.
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    sendRelayCredRequest();          // the same ask the relay path uses
  };
  bus.on('net', (n) => {
    // joined→false means the socket died: disarm so the NEXT join re-asks.
    if (!n?.joined) { asked = false; return; }
    if (!asked) {
      askOnce(n);
      // consent is listener-authored state the server holds per-connection; a
      // new connection has none, so restate it rather than assume it survived
      sendVoiceConsent(receivingVoice());
    }
  });
  askOnce(net);

  // A speaker's voice leg can be replaced mid-listen (a sidecar restart mints a new gen): on surface-transition, ask the
  // server (it owns every offer) to renegotiate so its next offer routes the new leg. Skip our own.
  bus.on('surface-transition', ({ actor, surface, gen }) => {
    if (surface !== 'voice' && surface !== 'voice-relay') return;
    if (actor === CONFIG.name) return;                    // our own leg
    if (gen == null) {
      // the leg died: drop its playback now, or the <audio> and analyser leak (only the speakers map reaches them)
      sfuDropSpeaker(actor);
      return;
    }
    if (!sfuActive()) return;                             // nothing to renegotiate yet
    console.info(`[sfu] ${actor} has a new voice leg (gen ${gen}) — asking to re-negotiate`);
    send({ type: 'sfu-want-negotiate' });
  });

  // Media-path recovery: a leg that dies while the socket is healthy (network switch, sleep/wake) re-asks exactly as a
  // fresh join does (sendRelayCredRequest). Budget: 3 tries with growing delay, reset on ICE connect, then a final message.
  let recoveryAttempts = 0, recoveryTimer = null;
  bus.on('sfu-media-live', () => { recoveryAttempts = 0; if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; } });
  bus.on('sfu-media-dead', ({ reason }) => {
    if (recoveryTimer) return;                 // one pending recovery at a time
    if (!net.joined) return;                   // the world socket owns THAT reconnect
    if (recoveryAttempts >= 3) {
      console.error(`[sfu] media path dead (${reason}) — giving up after 3 recovery attempts; reload to retry`);
      return;
    }
    const delay = [2000, 8000, 20000][recoveryAttempts++];
    console.warn(`[sfu] media path dead (${reason}) — re-joining voice in ${delay / 1000}s (attempt ${recoveryAttempts}/3)`);
    recoveryTimer = setTimeout(() => {
      recoveryTimer = null;
      if (!net.joined) return;
      sendRelayCredRequest();                  // fresh credential → fresh leg → fresh ICE
      sendVoiceConsent(receivingVoice());      // fire-and-forget lane: restate consent too
    }, delay);
  });

  bus.on('relay-cred', async (cred) => {
    await sfuConnect(cred, send);
    // honour a mic pressed before the credential arrived: with no `pc` yet, sfuMic only set wantMic
    if (sfuMicWanted()) { await sfuMic(true); bus.emit('audio:mic', sfuMicOn()); }
    // We do NOT offer. Tell the server we are ready and let it drive every
    // negotiation — see the header of voicesfu.js for why an answer cannot add
    // a receive direction the offer never proposed.
    send({ type: 'sfu-want-negotiate' });
  });

  // consent must be wired: send the current state now (a session may join already consenting) and every change after
  sendVoiceConsent(receivingVoice());
  bus.on('audio:receive', (on) => sendVoiceConsent(on));

  bus.on('sfu-offer', (m) => sfuOnOffer(m.sdp, send));
  bus.on('sfu-ice', (m) => sfuOnIce(m.candidate));
  bus.on('sfu-want-negotiate', () => send({ type: 'sfu-want-negotiate' }));

  // Distance rolloff + hush, two clocks (slow target, fast approach). The client half of the server's proximity gate:
  // that gate only subtracts; this is what makes distance audible.
  const FULL_M = VOICE_FULL_M, SILENT_M = VOICE_SILENT_M;   // one number (voiceconsent.js)
  setInterval(() => {
    for (const [id, s] of sfuSpeakers()) {
      const r = remotes.get(id);
      if (!r?.avatar?.root || !s.audio?.srcObject) continue;
      const d = r.avatar.root.position.distanceTo(myState.pos);
      const roll = Math.min(1, Math.max(0, 1 - (d - FULL_M) / (SILENT_M - FULL_M)));
      s.wantVolume = isHushed() ? 0 : roll * volumeFor('voices');
    }
  }, 300);
  const STEP = 60 / 700;
  setInterval(() => {
    for (const [, s] of sfuSpeakers()) {
      if (!s.audio?.srcObject || s.wantVolume == null) continue;
      const d = s.wantVolume - s.audio.volume;
      s.audio.volume = Math.abs(d) <= STEP ? s.wantVolume : s.audio.volume + Math.sign(d) * STEP;
    }
  }, 60);

  // Position feed for the SERVER's proximity gate. Cheap (a few floats every
  // 500ms) and OPTIONAL by design — the gate fails open on unknown or stale
  // positions, so a client that never sends these is simply never gated.
  setInterval(() => {
    if (!sfuActive()) return;
    const p = myState.pos;
    send({ type: 'sfu-pos', x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) });
  }, 500);

  window.relayDiag = sfuDiagClient;
  // the <audio> elements for /audio's probe: `new Audio()`, never in the DOM, so querySelectorAll can't find them
  window.__voiceSpeakerEls = () =>
    sfuSpeakerEntries().map(([id, s]) => ({ id, audio: s.audio }));
  window.relayMic = () => sfuMic(true);
  window.relayPeerLevels = sfuPeerLevels;
  // Cheap mic-state read for the 8Hz HUD poll — sfuDiagClient() allocates an
  // object and spreads the speaker map every call (review F4).
  window.__sfuMicOn = sfuMicOn;
  // My own mic level, for my own mouth flap + the 🎙 glyph (voicemouths.js).
  window.__sfuMyLevel = sfuMyLevel;
  window.sfuStats = sfuInboundStats;      // NetEq evidence for the spike report
  // The mic badge (mictoggle.js → micstate.js toggleMic) hands over to this when the SFU owns playback; set LAST so it's
  // never visible before the bridge can honour it. Returns the state read AFTER the await, so a failed publish says so.
  window.__sfuMic = async () => {
    await sfuMic(!sfuMicOn());
    const on = sfuMicOn();
    bus.emit('audio:mic', on);
    return on;
  };
  addEventListener('beforeunload', sfuClose);
}

// voicesfu owns the map; sfuSpeakerEntries() hands back live records so the rolloff can set volume in place
const sfuSpeakers = sfuSpeakerEntries;
