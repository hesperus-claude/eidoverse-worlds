// voicesfubridge — joins voicesfu.js (pure WebRTC, testable without a socket) to the world websocket and the bus.
// window.relayDiag / window.relayMic are the shape every browser smoke asserts against.
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

// a synth track arriving with no lane (mic off, TTS loaded later) must become the lane
setGeneratorRebuildHook(() => {
  // never under a live mic: that would swap a device the user turned on for a synthesizer
  if (sfuMicOn()) return;
  if (!synthProvider()?.available?.()) return;
  void sfuMic(false);   // the swap path now finds the provider
});

export function initVoiceSfu(name) {
  // check now and listen (a fast join can fire first); sends are fire-and-forget, so each reconnect restates all
  let asked = false;
  const askOnce = (n) => {
    if (asked || !n?.joined) return;
    asked = true;
    sendRelayCredRequest();
  };
  bus.on('net', (n) => {
    if (!n?.joined) { asked = false; return; }
    if (!asked) {
      askOnce(n);
      // the server holds consent per-connection: restate it, never assume it survived
      sendVoiceConsent(receivingVoice());
    }
  });
  askOnce(net);

  // a new gen means a replaced voice leg: the server owns every offer, so ask it to renegotiate
  bus.on('surface-transition', ({ actor, surface, gen }) => {
    if (surface !== 'voice' && surface !== 'voice-relay') return;
    if (actor === CONFIG.name) return;
    if (gen == null) {
      // drop playback now, or the <audio> and analyser leak (only the speakers map reaches them)
      sfuDropSpeaker(actor);
      return;
    }
    if (!sfuActive()) return;
    console.info(`[sfu] ${actor} has a new voice leg (gen ${gen}) — asking to re-negotiate`);
    send({ type: 'sfu-want-negotiate' });
  });

  // a leg dead under a healthy socket (network switch, sleep/wake) re-asks as a fresh join; 3 tries, reset on ICE connect
  let recoveryAttempts = 0, recoveryTimer = null;
  bus.on('sfu-media-live', () => { recoveryAttempts = 0; if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; } });
  bus.on('sfu-media-dead', ({ reason }) => {
    if (recoveryTimer) return;
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
      sendRelayCredRequest();
      sendVoiceConsent(receivingVoice());
    }, delay);
  });

  bus.on('relay-cred', async (cred) => {
    await sfuConnect(cred, send);
    // honour a mic pressed before the credential arrived: with no `pc` yet, sfuMic only set wantMic
    if (sfuMicWanted()) { await sfuMic(true); bus.emit('audio:mic', sfuMicOn()); }
    // we never offer: the server drives every negotiation (voicesfu.js header says why)
    send({ type: 'sfu-want-negotiate' });
  });

  // now (a session may join already consenting) and on every change
  sendVoiceConsent(receivingVoice());
  bus.on('audio:receive', (on) => sendVoiceConsent(on));

  bus.on('sfu-offer', (m) => sfuOnOffer(m.sdp, send));
  bus.on('sfu-ice', (m) => sfuOnIce(m.candidate));
  bus.on('sfu-want-negotiate', () => send({ type: 'sfu-want-negotiate' }));

  // distance rolloff + hush, slow target and fast approach: the server's proximity gate only subtracts
  const FULL_M = VOICE_FULL_M, SILENT_M = VOICE_SILENT_M;
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

  // for the server's proximity gate, which fails open on unknown or stale positions
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
  // for the 8Hz HUD poll: sfuDiagClient() allocates every call
  window.__sfuMicOn = sfuMicOn;
  window.__sfuMyLevel = sfuMyLevel;
  window.sfuStats = sfuInboundStats;      // NetEq stats
  // set LAST, so the mic badge never sees it before the bridge can honour it
  // returns the state read AFTER the await, so a failed publish says so
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
