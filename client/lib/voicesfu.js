// voicesfu — the browser half of the in-process SFU, in plain WebRTC, and the only voice transport.
// Its bus events, speakers map and relayDiag()-shaped surface are what the smokes assert against.
//
// THE SERVER OFFERS, ALWAYS: an answer can't add a receive direction the offer never proposed, so every
// renegotiation is server-initiated; we only ever setRemoteDescription(offer) → answer.
import { bus } from './base.js';
import { audioContext } from './audioctx.js';
// a dead media path must be visible to the person, not only the console: the mic meter shows capture, not transmission
import { logChat } from './chat.js';
import { playWhenAllowed } from './audiounlock.js';
import { why } from './debuglog.js';
import { rawMicStream, setMicLive } from './micstate.js';

let pc = null, cred = null, micStream = null, wantMic = false;
// my own outbound analyser (sfuMyLevel); declared here because sfuConnect() clears it, and a later `let` would be
// in the temporal dead zone for callers during module evaluation
let _myAn = null, _myBuf = null, _myStream = null;
/** Speaker ids announced by the server, consumed in order by ontrack. Module
 *  level and subscribed ONCE (see sfuConnect) — core.js has no `off`. */
const routeQueue = [];
bus.on('sfu-route', (m) => routeQueue.push(m.speaker));
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;
/** The mic the user ASKED for, not the one they got: a press before `pc` exists sets only this, and the bridge
 *  replays it once the credential lands. */
export const sfuMicWanted = () => wantMic;

/** Attach a remote track to a per-speaker <audio>. The playback half is
 *  transport-agnostic; every transport this codebase has carried shared it
 *  verbatim, which is why the rolloff/hush/analyser code below never forks. */
function attach(id, track) {
  let s = speakers.get(id);
  if (!s) { s = { audio: new Audio(), wantVolume: 0 }; speakers.set(id, s); }
  s.audio.autoplay = true;
  s.audio.playsInline = true;
  const stream = new MediaStream([track]);
  s.audio.srcObject = stream;
  s.stream = stream;
  // autoplay policy: a real user's first join needs the unlock queue (audiounlock.js)
  playWhenAllowed(s.audio, id);
}

export async function sfuConnect(credential, send) {
  cred = credential;
  // A mic track belongs to the pc that published it: on reconnect, stop the old stream's tracks (or the hardware
  // light stays on) and drop it, so the bridge's replay takes the real addTrack path.
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* already dead */ } }
    micStream = null;      // wantMic is KEPT: intent survives a reconnect, the stream does not
  }
  // Close the predecessor, handlers nulled first: its handlers close over the module-level `pc`, so a ghost's
  // 'failed' or stall timer would diagnose the new leg and emit sfu-media-dead.
  if (pc) {
    try { pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null; pc.close(); }
    catch { /* already closed */ }
  }
  pendingIce.length = 0;            // candidates for the dead pc are meaningless
  _myAn = null; _myStream = null;   // the analyser was bound to the dead stream
  // The ICE config comes from the credential (notes/SFU-SPEC.md `iceServers?`): without STUN a peer on another
  // network has no viable pair and ICE stalls in 'checking'. The [] fallback keeps an older server's behaviour.
  pc = new RTCPeerConnection({ iceServers: credential?.iceServers ?? [] });

  // The server names each route by a sideband `sfu-route` message before the offer that adds it (mid isn't
  // portable); ontrack pairs tracks with ids in arrival order. routeQueue is subscribed once (core.js has no `off`).
  routeQueue.length = 0;
  pc.ontrack = (e) => {
    // Prefer the track's own identity: the server names each stream after its speaker (sfu.ts ensureRoute), so
    // msid can't desync. The queue is a fallback for older servers; on disagreement msid wins, loudly.
    const viaMsid = e.streams?.[0]?.id;
    const viaQueue = routeQueue.shift();
    const id = (viaMsid && viaMsid !== 'default') ? viaMsid : viaQueue;
    if (viaMsid && viaQueue && viaMsid !== 'default' && viaMsid !== viaQueue) {
      console.warn('[sfu] route identity mismatch — msid', viaMsid, 'vs queue', viaQueue, '(trusting msid)');
    }
    if (id) attach(id, e.track);
  };

  // candidate TYPE is the evidence for the stall diagnosis: host-only means no STUN reflexive address
  let _sawNonHostCandidate = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (e.candidate.type && e.candidate.type !== 'host') _sawNonHostCandidate = true;
    // ICE names its generation (#130 item 4): the server refuses a candidate that can't prove its leg
    send({ type: 'sfu-ice', candidate: e.candidate, gen: cred?.mediaGen });
  };

  // Make a dead media path visible: 'failed' or a stall in 'checking' (e.g. no STUN/TURN across networks) is
  // reported; 'disconnected' is often transient and isn't.
  let iceStallTimer = null;
  const clearStall = () => { if (iceStallTimer) { clearTimeout(iceStallTimer); iceStallTimer = null; } };
  // which pc THIS closure serves: a superseded connection's timer must not diagnose the successor
  const myPc = pc;
  pc.oniceconnectionstatechange = () => {
    if (myPc !== pc) return;            // a ghost has no diagnosis to offer
    const st = pc.iceConnectionState;
    if (st === 'checking') {
      clearStall();
      // host-only pairs settle in well under a second on a LAN; 8s means no viable pair without STUN/TURN
      iceStallTimer = setTimeout(() => {
        if (myPc !== pc) return;        // superseded while armed — not our patient
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
          // a stall is a 'failed' with less ceremony; the bridge caps the retries
          bus.emit('sfu-media-dead', { reason: 'ice-stalled' });
        }
      }, 8000);
    } else if (st === 'connected' || st === 'completed') {
      clearStall();
      console.info(`[voice] ICE ${st} — media path is live`);
      bus.emit('sfu-media-live', {});     // the bridge resets its recovery budget
    } else if (st === 'failed') {
      clearStall();
      console.error('[voice] 🔴 ICE FAILED — no media path to the server. '
        + 'Mic capture is unaffected and still looks healthy; nothing is reaching anyone.');
      logChat('*', 'voice: connection failed — reconnecting voice…');
      // recover, don't just report: the bridge owns the retry budget; this only names the corpse
      bus.emit('sfu-media-dead', { reason: 'ice-failed' });
    } else if (st === 'closed') {
      clearStall();
    }
  };
  return pc;
}

/** Server-initiated renegotiation. The ONLY negotiation path — see the header. */
export async function sfuOnOffer(sdp, send) {
  if (!pc) return;
  // the connection this offer was FOR: a reconnect mid-await swaps `pc`, and answering on the fresh one throws
  const myPc = pc;
  await myPc.setRemoteDescription({ type: 'offer', sdp });
  if (myPc !== pc) return;              // superseded mid-exchange — the new pc has its own offer coming
  // candidates queued before the offer applied can attach now
  while (pendingIce.length) {
    if (myPc !== pc) return;   // queue now belongs to the successor's offer
    const c = pendingIce.shift();
    try { await myPc.addIceCandidate(c); } catch { /* stale */ }
  }
  const answer = await myPc.createAnswer();
  if (myPc !== pc) return;
  await myPc.setLocalDescription(answer);
  if (myPc !== pc) return;
  // Rescue a stranded publish: a publish that beat the first offer can sit on a transceiver JSEP bound to a recv
  // route. If we hold a live track and no m-line is actually sending (currentDirection), move it to the floor.
  const outTrack = micStream?.getTracks?.()[0];
  if (outTrack && outTrack.readyState === 'live'
      && !myPc.getTransceivers().some((t) => t.currentDirection === 'sendonly')) {
    const floor = myPc.getTransceivers().find(
      (t) => t.currentDirection === 'inactive' || t.direction === 'inactive');
    if (floor) {
      why('publish', 'post-offer rescue: outbound track was stranded — moving to the floor');
      await floor.sender.replaceTrack(outTrack);
      if (myPc !== pc) return;          // superseded mid-rescue — not our negotiation to ask for
      floor.direction = 'sendonly';
      bus.emit('sfu-want-negotiate', {});
    }
  }
  // Present the credential (nonce included) so the server's replay check runs, and the generation this answer
  // is for, so a replaced leg's answer is dropped.
  send({ type: 'sfu-answer', sdp: answer.sdp, gen: cred?.mediaGen ?? cred?.gen, cred: cred && {
    world: cred.world, id: cred.id, primaryGen: cred.primaryGen,
    mediaGen: cred.mediaGen ?? cred.gen, incarnation: cred.incarnation, nonce: cred.nonce } });
}

// Early candidates are queued, not dropped: addIceCandidate throws until a remote description exists, and host
// candidates arrive in exactly that window.
const pendingIce = [];
export async function sfuOnIce(candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) { pendingIce.push(candidate); return; }
  try { await pc.addIceCandidate(candidate); } catch { /* stale/dup candidate */ }
}

/** Publish the mic via plain getUserMedia; the browser supplies AGC/NS/AEC and NetEq, so no SDK DSP or jitter
 *  buffer is needed. */
// One acquisition at a time: late callers await the same promise, or two senders publish and the orphaned stream
// keeps the mic light on.
let micPending = null;
// which pc the pending acquisition was FOR: a stale pending (pc replaced) is awaited, then treated as absent
let micPendingPc = null;

export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) {
    // mic off must not mean voice off when a synth provider speaks for you: swap the source, don't mute it
    const { synthProvider } = await import('./voicesource.js');
    // say why the swap did or didn't happen: this path can decline silently
    const prov = synthProvider();
    why('publish', `mic off · provider=${prov ? 'registered' : 'NONE'}`
      + (prov ? ` · available=${!!prov.available?.()}` : ''));
    if (prov?.available?.()) {
      // drop the device stream and re-enter the publish path (voiceSource() returns the synth when micWanted is
      // false): one place chooses and attaches a track
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
  // Re-enable only a real device stream; a synthetic one (mic-off swaps to the synth) must re-acquire. Report
  // setMicLive(true) synchronously with the enable: device liveness gates the lane (micstate.js).
  if (micStream && !micStream.synthetic) {
    micStream.getTracks().forEach((t) => (t.enabled = true));
    setMicLive(true);
    return;
  }
  if (micStream?.synthetic) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* gone */ } }
    micStream = null;                      // force a real getUserMedia below
  }
  if (micPending && micPendingPc === pc) {
    // nothing to apply after this await: sfuPublish re-reads wantMic after its own await, so a waiter only waits
    await micPending;
    return;
  }
  // a stale pending is sfuPublish's problem: its entry loop re-checks after every await
  return sfuPublish();
}

/** Acquire a source (mic or synth, decided by voiceSource) and publish it.
 *  Split out of sfuMic so the mic-OFF path can re-enter it to swap sources
 *  rather than carrying a second copy of the transceiver logic below. */
async function sfuPublish() {
  if (!pc) return;
  // re-check after every stale await, or two waiters on one stale pending mint two acquisitions
  while (micPending) {
    if (micPendingPc === pc) return micPending;
    try { await micPending; } catch { /* the old one's problem */ }
  }
  // snapshot: getUserMedia can take seconds, and the track must not land on a successor pc
  const myPc = pc;
  micPendingPc = myPc;
  micPending = (async () => {
    // Ask the seam, not the device: voiceSource() returns the mic when available and wanted, else the synth
    // provider (marked synthetic), so TTS has a route to the sender. Everything below is source-agnostic.
    const { voiceSource } = await import('./voicesource.js');
    const asked = wantMic;
    const raw = await voiceSource({ micWanted: asked });
    // Re-read intent after the await: a mic toggle during a permission prompt makes this acquisition stale.
    // Stop it (a device keeps the light on) and let the caller ask the current question.
    if (wantMic !== asked) {
      why('publish', `intent changed during acquisition (asked mic=${asked}, now ${wantMic}) — dropping ${raw?.synthetic ? 'synth' : 'device'}`);
      for (const t of raw?.getTracks?.() ?? []) { try { t.enabled = false; t.stop(); } catch { /* gone */ } }
      // a device turned OFF is not live: say so before anything reads micOn()
      if (!raw?.synthetic) { try { (await import('./micstate.js')).setMicLive(false); } catch { /* probe env */ } }
      return 'intent-changed';
    }
    // Gate before the sender sees it, or the SFU sends raw room tone; gateFor() passes a synthetic source through
    // untouched (nothing to gate, and the gate's graph can't run on a headless stalled clock).
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
      // setMicLive(true) ran above for a device we just stopped — undo the claim.
      try { setMicLive(false); } catch { /* probe env */ }
      return;
    }
    why('publish', `published ${s?.synthetic ? 'SYNTH' : 'mic'}`
      + ` · tracks=${s?.getTracks?.().length ?? 0}` + ` · wantMic=${wantMic}`);
    micStream = s;
    // addTrack reuses the first compatible transceiver, a speaker route once 2+ people are in, so the server never
    // subscribes: put the track on the floor transceiver the server offered for it (repro: tools/mini-sfu-test.mjs).
    const track = s.getTracks()[0];
    // Sender order: our live sender (currentDirection 'sendonly', or direction sendonly/sendrecv while never
    // negotiated) → replaceTrack, no renegotiation; else the inactive floor; else bare addTrack.
    // currentDirection is the authority: a recvonly route can never transmit (tools/mini-sfu-test.mjs stage 3).
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
    // CAS, not blind null: a successor may have registered its own pending
    if (micPending === own) micPending = null;
  }
  if (outcome === 'intent-changed') {
    // a wanted mic is acquired; an unwanted one is replaced by the synth only if a provider can speak (else
    // re-entering would re-acquire the device we just dropped, forever)
    if (myPc !== pc) return;
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    if (wantMic || !!prov?.available?.()) return sfuPublish();
    return;
  }
  // the server offers, so we ASK it to renegotiate rather than offering ourselves (glare)
  bus.emit('sfu-want-negotiate', {});
}

/** My own level, for my mouth flap and the 🎙 glyph. Reads the RAW mic on purpose: a mouth answers "are you
 *  making sound", not "is the gate forwarding it". */
export function sfuMyLevel() {
  if (!micStream || !wantMic) return 0;
  try {
    // measure the raw device, not the gated lane: a sensitivity meter that reads zero below threshold can't help
    // you set the threshold
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

/** Same shape relayPeerLevels() returns, so mouth-flap code is shared. */
export function sfuPeerLevels() {
  const out = new Map();
  for (const [id, s] of speakers) {
    if (!s.stream) continue;
    if (!s.an) {
      try {
        const ctx = audioContext();      // the shared context, not a new one per speaker
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

/** The diag surface the browser smoke asserts against — same keys as
 *  relayDiag() so one smoke test can drive either transport. */
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

/** Live speaker records for the bridge's rolloff/hush loops: the real objects (mutated in place), as entries so a
 *  caller can't add or delete speakers behind ontrack's back. */
export function sfuSpeakerEntries() { return [...speakers.entries()]; }

/** Live inbound-audio stats: NetEq's adaptive depth, time-stretching (inserted/removedSamples) and PLC
 *  (concealedSamples), counted apart so delivered and lost audio can be measured separately. */
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

/** Tear down one departed speaker's playback: off-DOM <audio> elements and analysers are never reclaimed otherwise. */
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
