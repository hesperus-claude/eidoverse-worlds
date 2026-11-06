// voicesfubridge — joins voicesfu.js (pure WebRTC) to the world websocket: the
// part that knows about `net`, the bus and the verb names, so voicesfu.js stays
// transport-only and testable without a socket.
//
// 🔴 It exposes window.relayDiag / window.relayMic — the shape every browser
// smoke asserts against (the names are historical; the instruments use them).
import { bus, CONFIG } from './base.js';
import { net, sendRelayCredRequest, sendVoiceConsent, sendJoined } from './net.js';
import { sfuConnect, sfuOnOffer, sfuOnIce, sfuMic, sfuPeerLevels, sfuMyLevel,
  sfuDiagClient, sfuClose, sfuActive, sfuSpeakerEntries, sfuInboundStats, sfuMicOn,
  sfuMicWanted, sfuDropSpeaker } from './voicesfu.js';
import { remotes } from './remotes.js';
import { myState } from './controller.js';
import { isHushed, volumeFor, receivingVoice, VOICE_FULL_M, VOICE_SILENT_M } from './voiceconsent.js';
import { setGeneratorRebuildHook, synthProvider } from './voicesource.js';

const send = (o) => { sendJoined(o); };

// A synth track arriving while no mic is published must BECOME the lane, as on
// the mesh (voice.js): rebindSenders only repairs senders that exist, so with
// the mic off a TTS track had nothing to attach to. sfuPublish() already handles
// a synthetic stream; this only triggers it.
setGeneratorRebuildHook(() => {
  // Only when the user is not already publishing a microphone: a live mic wins
  // outright (voicesource.js's own doctrine), and re-publishing under one would
  // swap a device the user deliberately turned on for a synthesizer.
  if (sfuMicOn()) return;
  if (!synthProvider()?.available?.()) return;
  void sfuMic(false);   // re-enters the swap path, which now finds the provider
});

export function initVoiceSfu(name) {
  // Ask for the media credential once joined. Check the live state NOW and also
  // listen, because a fast join can fire before we subscribed. Re-arm on every
  // disconnect: sends here are fire-and-forget (no queue), so after a reconnect
  // the credential, consent and position must all be re-established.
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

  // A speaker's voice leg can be replaced while we listen (e.g. an agent's voice
  // sidecar restarts and mints a new gen). The server broadcasts
  // `surface-transition`; without this we stay on the dead gen and go silently
  // deaf to that speaker. We don't offer (the server owns every offer — see
  // voicesfu.js's header); we ASK for a renegotiation. Skip our own leg.
  bus.on('surface-transition', ({ actor, surface, gen }) => {
    if (surface !== 'voice' && surface !== 'voice-relay') return;
    if (actor === CONFIG.name) return;                    // our own leg
    if (gen == null) {
      // The leg DIED (disconnect, revoke): drop its playback now, or the
      // <audio> + analyser leak and a returning visitor gets a second element.
      sfuDropSpeaker(actor);
      return;
    }
    if (!sfuActive()) return;                             // nothing to renegotiate yet
    console.info(`[sfu] ${actor} has a new voice leg (gen ${gen}) — asking to re-negotiate`);
    send({ type: 'sfu-want-negotiate' });
  });

  // Media-path recovery: a media leg that dies while the world socket is healthy
  // (network switch, sleep/wake, NAT rebind) re-joins voice with the same ask a
  // fresh join makes (sendRelayCredRequest → the server's takeover path). Capped
  // at 3 attempts with growing delay, reset when ICE connects, so a permanent
  // stall ends in one honest message instead of an infinite loop.
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
    // Honour a mic pressed before the credential arrived: that press hit
    // sfuMic's `if (!pc) return` and only set wantMic, so re-read it now.
    if (sfuMicWanted()) { await sfuMic(true); bus.emit('audio:mic', sfuMicOn()); }
    // We do NOT offer. Tell the server we are ready and let it drive every
    // negotiation — see the header of voicesfu.js for why an answer cannot add
    // a receive direction the offer never proposed.
    send({ type: 'sfu-want-negotiate' });
  });

  // Consent: send the current state NOW (a session that joined already
  // consenting must not wait for a toggle), and every change after.
  sendVoiceConsent(receivingVoice());
  bus.on('audio:receive', (on) => sendVoiceConsent(on));

  bus.on('sfu-offer', (m) => sfuOnOffer(m.sdp, send));
  bus.on('sfu-ice', (m) => sfuOnIce(m.candidate));
  bus.on('sfu-want-negotiate', () => send({ type: 'sfu-want-negotiate' }));

  // Distance rolloff + hush: slow target, fast approach (same shape as the mesh
  // and relay). This is the client half of the server's proximity gate; the
  // server gate only ever subtracts, this is what makes distance audible.
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
  // The <audio> elements for /audio's playback probe. They are never appended
  // to the DOM, so querySelectorAll cannot find them.
  window.__voiceSpeakerEls = () =>
    sfuSpeakerEntries().map(([id, s]) => ({ id, audio: s.audio }));
  window.relayMic = () => sfuMic(true);
  window.relayPeerLevels = sfuPeerLevels;
  // Cheap mic-state read for the 8Hz HUD poll (sfuDiagClient() allocates).
  window.__sfuMicOn = sfuMicOn;
  // My own mic level, for my own mouth flap + the 🎙 glyph (voicemouths.js).
  window.__sfuMyLevel = sfuMyLevel;
  window.sfuStats = sfuInboundStats;      // NetEq evidence for the spike report
  // The mic badge (mictoggle.js → micstate.js toggleMic) hands over to this
  // when the SFU owns playback. Set LAST, so it is never visible before the
  // bridge can honour it. Returns the state read AFTER the await, so a failed
  // publish reports honestly.
  window.__sfuMic = async () => {
    await sfuMic(!sfuMicOn());
    const on = sfuMicOn();
    bus.emit('audio:mic', on);
    return on;
  };
  addEventListener('beforeunload', sfuClose);
}

// voicesfu owns the map; sfuSpeakerEntries() hands back the live records so the
// rolloff loops can mutate volume in place without exposing the Map itself.
const sfuSpeakers = sfuSpeakerEntries;
