// voicesfu — the browser half of the in-process SFU in plain WebRTC; the only voice transport.
// THE SERVER OFFERS, ALWAYS: an answer can't add a receive direction the offer never proposed, so we only answer.
// The browser supplies AGC/NS/AEC and NetEq: no SDK DSP or jitter buffer.
import { bus } from './base.js';
import { audioContext } from './audioctx.js';
// a dead media path must reach the person, not only the console: the mic meter shows capture, not transmission
import { logChat } from './chat.js';
import { playWhenAllowed } from './audiounlock.js';
import { why } from './debuglog.js';
import { rawMicStream, setMicLive } from './micstate.js';

let pc = null, cred = null, micStream = null, wantMic = false;
// declared up here: sfuConnect() clears these, and a later `let` would be in the TDZ during module evaluation
let _myAn = null, _myBuf = null, _myStream = null;
/** subscribed ONCE at module level (base.js bus; nothing here unsubscribes) */
const routeQueue = [];
bus.on('sfu-route', (m) => routeQueue.push(m.speaker));
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;
/** what the user ASKED for: a press before `pc` exists sets only this; the bridge replays it on credential */
export const sfuMicWanted = () => wantMic;

/** transport-agnostic playback, so the rolloff/hush/analyser code never forks */
function attach(id, track) {
  let s = speakers.get(id);
  if (!s) { s = { audio: new Audio(), wantVolume: 0 }; speakers.set(id, s); }
  s.audio.autoplay = true;
  s.audio.playsInline = true;
  const stream = new MediaStream([track]);
  s.audio.srcObject = stream;
  s.stream = stream;
  // autoplay policy: a real user's first join needs the unlock queue
  playWhenAllowed(s.audio, id);
}

export async function sfuConnect(credential, send) {
  cred = credential;
  // a mic track belongs to its pc: stop it (or the hardware light stays on) so the replay takes the addTrack path
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* already dead */ } }
    micStream = null;      // wantMic is KEPT: intent survives a reconnect
  }
  // null handlers first: they read module-level `pc`, so a ghost's 'failed' would diagnose the new leg
  if (pc) {
    try { pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null; pc.close(); }
    catch { /* already closed */ }
  }
  pendingIce.length = 0;
  _myAn = null; _myStream = null;
  // notes/SFU-SPEC.md `iceServers?`: without STUN a peer on another network stalls in 'checking'; [] = older server
  pc = new RTCPeerConnection({ iceServers: credential?.iceServers ?? [] });

  // `sfu-route` names each route before its offer (mid isn't portable); ontrack pairs them in arrival order
  routeQueue.length = 0;
  pc.ontrack = (e) => {
    // msid can't desync (server/sfu.ts ensureRoute names streams by speaker); queue is the older-server fallback
    const viaMsid = e.streams?.[0]?.id;
    const viaQueue = routeQueue.shift();
    const id = (viaMsid && viaMsid !== 'default') ? viaMsid : viaQueue;
    if (viaMsid && viaQueue && viaMsid !== 'default' && viaMsid !== viaQueue) {
      console.warn('[sfu] route identity mismatch — msid', viaMsid, 'vs queue', viaQueue, '(trusting msid)');
    }
    if (id) attach(id, e.track);
  };

  // host-only candidates mean no STUN reflexive address: the stall diagnosis
  let _sawNonHostCandidate = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (e.candidate.type && e.candidate.type !== 'host') _sawNonHostCandidate = true;
    // ICE names its generation (#130): the server refuses a candidate that can't prove its leg
    send({ type: 'sfu-ice', candidate: e.candidate, gen: cred?.mediaGen });
  };

  // 'failed' and a stall in 'checking' are reported; 'disconnected' is often transient and isn't
  let iceStallTimer = null;
  const clearStall = () => { if (iceStallTimer) { clearTimeout(iceStallTimer); iceStallTimer = null; } };
  const myPc = pc;
  pc.oniceconnectionstatechange = () => {
    if (myPc !== pc) return;            // a superseded pc must not diagnose its successor
    const st = pc.iceConnectionState;
    if (st === 'checking') {
      clearStall();
      // host-only pairs settle in well under a second on a LAN; 8s means no viable pair without STUN/TURN
      iceStallTimer = setTimeout(() => {
        if (myPc !== pc) return;
        if (pc.iceConnectionState === 'checking' || pc.iceConnectionState === 'new') {
          const hostOnly = !_sawNonHostCandidate;
          console.error('[voice] 🔴 ICE STALLED — no media path. '
            + `iceConnectionState=${pc.iceConnectionState} after 8s.`
            + (hostOnly ? '  Only HOST candidates were gathered: this peer can only reach '
                + 'the server on the same machine/LAN. A phone or remote listener needs a '
                + 'STUN/TURN server, which this build does not configure (iceServers: []).'
                : '')
            + '  Your mic is capturing (the meter is local) but NOTHING is being transmitted.');
          logChat('*', 'voice: no media path to the server — mic is on but nobody can hear you');
          bus.emit('sfu-media-dead', { reason: 'ice-stalled' });
        }
      }, 8000);
    } else if (st === 'connected' || st === 'completed') {
      clearStall();
      console.info(`[voice] ICE ${st} — media path is live`);
      bus.emit('sfu-media-live', {});
    } else if (st === 'failed') {
      clearStall();
      console.error('[voice] 🔴 ICE FAILED — no media path to the server. '
        + 'Mic capture is unaffected and still looks healthy; nothing is reaching anyone.');
      logChat('*', 'voice: connection failed — reconnecting voice…');
      bus.emit('sfu-media-dead', { reason: 'ice-failed' });
    } else if (st === 'closed') {
      clearStall();
    }
  };
  return pc;
}

/** the ONLY negotiation path */
export async function sfuOnOffer(sdp, send) {
  if (!pc) return;
  // a reconnect mid-await swaps `pc`, and answering on the fresh one throws
  const myPc = pc;
  await myPc.setRemoteDescription({ type: 'offer', sdp });
  if (myPc !== pc) return;
  while (pendingIce.length) {
    if (myPc !== pc) return;
    const c = pendingIce.shift();
    try { await myPc.addIceCandidate(c); } catch { /* stale */ }
  }
  const answer = await myPc.createAnswer();
  if (myPc !== pc) return;
  await myPc.setLocalDescription(answer);
  if (myPc !== pc) return;
  // a publish that beat the first offer can sit on a transceiver JSEP bound to a recv route: move it to the floor
  const outTrack = micStream?.getTracks?.()[0];
  if (outTrack && outTrack.readyState === 'live'
      && !myPc.getTransceivers().some((t) => t.currentDirection === 'sendonly')) {
    const floor = myPc.getTransceivers().find(
      (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) {
      why('publish', 'post-offer rescue: outbound track was stranded — moving to the floor');
      await floor.sender.replaceTrack(outTrack);
      if (myPc !== pc) return;
      floor.direction = 'sendonly';
      bus.emit('sfu-want-negotiate', {});
    }
  }
  // the nonce feeds the server's replay check; the gen lets it drop a replaced leg's answer
  send({ type: 'sfu-answer', sdp: answer.sdp, gen: cred?.mediaGen ?? cred?.gen, cred: cred && {
    world: cred.world, id: cred.id, primaryGen: cred.primaryGen,
    mediaGen: cred.mediaGen ?? cred.gen, incarnation: cred.incarnation, nonce: cred.nonce } });
}

// queued, not dropped: addIceCandidate throws before a remote description, exactly when host candidates arrive
const pendingIce = [];
export async function sfuOnIce(candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) { pendingIce.push(candidate); return; }
  try { await pc.addIceCandidate(candidate); } catch { /* stale/dup candidate */ }
}

// one acquisition at a time, or two senders publish and the orphan keeps the mic light on
let micPending = null;
// a stale pending (pc replaced) is awaited, then treated as absent
let micPendingPc = null;

export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) {
    // mic off must not mean voice off when a synth provider speaks for you: swap the source, don't mute it
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    why('publish', `mic off · provider=${prov ? 'registered' : 'NONE'}`
      + (prov ? ` · available=${!!prov.available?.()}` : ''));
    if (prov?.available?.()) {
      // re-enter the publish path: one place chooses and attaches a track
      if (micStream) {
        for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
        micStream = null;
      }
      why('publish', 'swapping to synth');
      return void sfuPublish();
    }
    micStream?.getTracks().forEach((t) => (t.enabled = false));
    try { (await import('./micstate.js')).setMicLive(false); } catch { /* module may be absent in probes */ }
    return;
  }
  // a synthetic stream must re-acquire; no await between the enable and setMicLive(true): liveness gates the lane
  if (micStream && !micStream.synthetic) {
    micStream.getTracks().forEach((t) => (t.enabled = true));
    setMicLive(true);
    return;
  }
  if (micStream?.synthetic) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
    micStream = null;
  }
  if (micPending && micPendingPc === pc) {
    // sfuPublish re-reads wantMic after its own await, so a waiter only waits
    await micPending;
    return;
  }
  return sfuPublish();
}

/** the mic-OFF path re-enters this to swap sources, so the transceiver logic has one copy */
async function sfuPublish() {
  if (!pc) return;
  // re-check after every stale await, or two waiters on one stale pending mint two acquisitions
  while (micPending) {
    if (micPendingPc === pc) return micPending;
    try { await micPending; } catch { /* the old one's problem */ }
  }
  // getUserMedia can take seconds, and the track must not land on a successor pc
  const myPc = pc;
  micPendingPc = myPc;
  micPending = (async () => {
    // ask the seam, not the device, so TTS has a route to the sender; everything below is source-agnostic (docs/research/voice-sources.md)
    const { voiceSource } = await import('./voicesource.js');
    const asked = wantMic;
    const raw = await voiceSource({ micWanted: asked });
    // a toggle during a permission prompt makes this stale: stop it (a device keeps the light on)
    if (wantMic !== asked) {
      why('publish', `intent changed during acquisition (asked mic=${asked}, now ${wantMic}) — dropping ${raw?.synthetic ? 'synth' : 'device'}`);
      for (const t of raw?.getTracks?.() ?? []) { try { t.enabled = false; t.stop(); } catch { /* gone */ } }
      // a device turned OFF is not live: say so before anything reads micOn()
      if (!raw?.synthetic) { try { (await import('./micstate.js')).setMicLive(false); } catch { /* probe env */ } }
      return 'intent-changed';
    }
    // gate before the sender, or the SFU sends room tone; a synthetic source bypasses it (micstate.js gateFor)
    const { gateFor, gateIsUnavailable, ungatedAllowed, setMicLive } = await import('./micstate.js');
    const s = gateFor(raw);
    // tell micstate whether a DEVICE is capturing: sfuMicOn() can't tell a muted mic from a live one
    setMicLive(!raw?.synthetic && wantMic);
    if (!raw?.synthetic && gateIsUnavailable() && !ungatedAllowed()) {
      // refuse rather than publish ungated; the panel offers an explicit opt-in row
      bus.emit('voice-gate-unavailable', {});
      wantMic = false;
      return;
    }
    // superseded during acquisition: stop what we acquired; the new session's replay publishes
    if (myPc !== pc) {
      why('publish', 'pc superseded during acquisition — dropping this publish');
      for (const t of raw?.getTracks?.() ?? []) { try { t.stop(); } catch { /* gone */ } }
      try { setMicLive(false); } catch { /* probe env */ }
      return;
    }
    why('publish', `published ${s?.synthetic ? 'SYNTH' : 'mic'}`
      + ` · tracks=${s?.getTracks?.().length ?? 0}` + ` · wantMic=${wantMic}`);
    micStream = s;
    // bare addTrack reuses a speaker route once 2+ are in, which the server never subscribes (tools/mini-sfu-test.mjs)
    const track = s.getTracks()[0];
    // our live sender, else the inactive floor, else addTrack; currentDirection is the authority (recvonly can't send)
    const mine = pc.getTransceivers().find((t) =>
      t.currentDirection === 'sendonly'
      || (t.currentDirection == null && (t.direction === 'sendonly' || t.direction === 'sendrecv')));
    if (mine) {
      await mine.sender.replaceTrack(track);
    } else {
      const floor = pc.getTransceivers().find(
        (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
      if (floor) {
        await floor.sender.replaceTrack(track);
        floor.direction = 'sendonly';
      } else {
        // no floor offered yet (alone, or the mic beat the first offer): no routes to mis-pick
        for (const t of s.getTracks()) pc.addTrack(t, s);
      }
    }
  })();
  // a denied permission prompt is a normal answer: clear the intent, since sfuMicOn() is `!!micStream && wantMic`
  const own = micPending;
  let outcome;
  try {
    outcome = await own;
  } catch (e) {
    // only OUR intent may be cleared: a superseded rejection must not undo a fresh sfuMic(true)
    if (myPc === pc) wantMic = false;
    console.warn('[sfu] mic not granted:', e?.name || e);
    return;
  } finally {
    // a successor may have registered its own pending
    if (micPending === own) micPending = null;
  }
  if (outcome === 'intent-changed') {
    // only with a provider that can speak, else re-entering re-acquires the dropped device forever
    if (myPc !== pc) return;
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    if (wantMic || !!prov?.available?.()) return sfuPublish();
    return;
  }
  // ask, never offer (glare)
  bus.emit('sfu-want-negotiate', {});
}

/** RAW mic on purpose: a mouth and a sensitivity meter answer "are you making sound", not "is the gate open" */
export function sfuMyLevel() {
  if (!micStream || !wantMic) return 0;
  try {
    const src = rawMicStream() ?? micStream;
    if (!_myAn || _myStream !== src) {
      const ctx = audioContext();
      _myAn = ctx.createAnalyser(); _myAn.fftSize = 512;
      ctx.createMediaStreamSource(src).connect(_myAn);
      _myBuf = new Float32Array(_myAn.fftSize);
      _myStream = src;
    }
    _myAn.getFloatTimeDomainData(_myBuf);
    let peak = 0;
    for (const v of _myBuf) peak = Math.max(peak, Math.abs(v));
    return peak;
  } catch { return 0; }
}

export function sfuPeerLevels() {
  const out = new Map();
  for (const [id, s] of speakers) {
    if (!s.stream) continue;
    if (!s.an) {
      try {
        const ctx = audioContext();      // shared, never one per speaker
        s.an = ctx.createAnalyser(); s.an.fftSize = 512;
        ctx.createMediaStreamSource(s.stream).connect(s.an);
        s.buf = new Float32Array(s.an.fftSize);
      } catch { continue; }
    }
    s.an.getFloatTimeDomainData(s.buf);
    let peak = 0;
    for (const v of s.buf) peak = Math.max(peak, Math.abs(v));
    out.set(id, peak);
  }
  return out;
}

/** the browser smoke asserts against these keys */
export function sfuDiagClient() {
  return {
    transport: 'sfu',
    active: sfuActive(),
    identity: cred?.identity ?? null,
    micPublished: sfuMicOn(),
    // the raw ICE/connection states: `active` collapses 'checking', 'failed' and absent into one bit
    iceConnectionState: pc?.iceConnectionState ?? null,
    connectionState: pc?.connectionState ?? null,
    iceGatheringState: pc?.iceGatheringState ?? null,
    speakers: [...speakers.entries()].map(([id, s]) => ({ id, hasStream: !!s.stream })),
  };
}

/** live records, mutated in place; entries so a caller can't add or delete speakers behind ontrack's back */
export function sfuSpeakerEntries() { return [...speakers.entries()]; }

/** NetEq's own counters, time-stretch (inserted/removed) apart from PLC (concealed), so delivered and lost audio
 *  measure separately */
export async function sfuInboundStats() {
  if (!pc) return [];
  const out = [];
  (await pc.getStats()).forEach((r) => {
    if (r.type === 'inbound-rtp' && r.kind === 'audio') out.push({
      packetsReceived: r.packetsReceived, packetsLost: r.packetsLost, jitter: r.jitter,
      jitterBufferDelay: r.jitterBufferDelay, jitterBufferTargetDelay: r.jitterBufferTargetDelay,
      jitterBufferEmittedCount: r.jitterBufferEmittedCount,
      concealedSamples: r.concealedSamples, concealmentEvents: r.concealmentEvents,
      insertedSamplesForDeceleration: r.insertedSamplesForDeceleration,
      removedSamplesForAcceleration: r.removedSamplesForAcceleration,
      fecPacketsReceived: r.fecPacketsReceived, fecPacketsDiscarded: r.fecPacketsDiscarded,
    });
  });
  return out;
}

/** off-DOM <audio> elements and analysers are never reclaimed otherwise */
export function sfuDropSpeaker(id) {
  const s = speakers.get(id);
  if (!s) return;
  try { s.audio.pause(); } catch { /* already dead */ }
  s.audio.srcObject = null;
  try { s.an?.disconnect(); } catch { /* never built */ }
  speakers.delete(id);
}

export function sfuClose() {
  try { pc?.close(); } catch {}
  pc = null;
  for (const s of speakers.values()) { s.audio.srcObject = null; try { s.an?.disconnect(); } catch {} }
  speakers.clear();
}
