// voicesfu — the browser half of the in-process SFU, in plain WebRTC.
//
// The ONLY voice transport. The shapes it shares with its deleted predecessors
// (same bus events, same speakers map, same relayDiag() surface) survive because
// the smokes assert against them. The playback half (per-speaker <audio>,
// rolloff, hush, the analyser behind relayPeerLevels) is transport-agnostic.
//
// THE SERVER OFFERS, ALWAYS: every renegotiation is server-initiated; we only
// ever setRemoteDescription(offer) → answer. Rationale for the negotiation,
// transceiver and acquisition rules below: docs/research/sfu-client-negotiation.md.
import { bus } from './base.js';
import { audioContext } from './audioctx.js';
// A dead media path must be visible to the PERSON, not only in the console —
// they are holding a phone and watching a gold mic meter that is telling them
// the truth about capture and nothing about transmission.
import { logChat } from './chat.js';
import { playWhenAllowed } from './audiounlock.js';
import { why } from './debuglog.js';
import { rawMicStream, setMicLive } from './micstate.js';

let pc = null, cred = null, micStream = null, wantMic = false;
// My own outbound analyser (sfuMyLevel). Declared HERE, with the rest of the
// module state, because sfuConnect() clears it on reconnect — a `let` further
// down the file is in the temporal dead zone for any caller that runs during
// module evaluation, and that is a runtime error `node --check` cannot see.
let _myAn = null, _myBuf = null, _myStream = null;
/** Speaker ids announced by the server, consumed in order by ontrack. Module
 *  level and subscribed ONCE (see sfuConnect) — core.js has no `off`. */
const routeQueue = [];
bus.on('sfu-route', (m) => routeQueue.push(m.speaker));
const speakers = new Map();           // id → { audio, stream, wantVolume, an, buf }

export const sfuActive = () => !!pc && pc.connectionState === 'connected';
export const sfuMicOn = () => !!micStream && wantMic;
/** The mic the user ASKED for, which is not the mic they GOT: sfuMicOn() needs
 *  a live micStream, and a press before `pc` exists sets only this. The bridge
 *  replays it once the credential lands. Intent and achievement must be
 *  readable separately or a pre-connection press is silently lost. */
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
  // Autoplay policy: a page that has not been gestured at cannot start audio.
  // The smoke launches Chromium with --autoplay-policy=no-user-gesture-required,
  // but a real user's first join needs the unlock queue — see audiounlock.js for
  // why the old one-shot 'click' listener silently failed on a phone.
  playWhenAllowed(s.audio, id);
}

export async function sfuConnect(credential, send) {
  cred = credential;
  // A MIC TRACK BELONGS TO THE PC THAT PUBLISHED IT: a new pc must not inherit
  // the old one's stream, or the bridge's replay re-enables tracks on a closed pc
  // and never publishes on the live one. Stop the old tracks too (the hardware
  // light).
  if (micStream) {
    for (const t of micStream.getTracks()) { try { t.stop(); } catch { /* already dead */ } }
    micStream = null;      // wantMic is deliberately KEPT: intent survives a
                           // reconnect, the stream does not. The bridge's
                           // replay then takes the real addTrack path.
  }
  // CLOSE THE PREDECESSOR, handlers nulled first: they close over the module-level
  // `pc`, so a ghost reaching 'failed' (or its stall timer) would diagnose the new
  // pc and burn the bridge's recovery budget.
  if (pc) {
    try { pc.onicecandidate = pc.ontrack = pc.oniceconnectionstatechange = null; pc.close(); }
    catch { /* already closed */ }
  }
  pendingIce.length = 0;            // candidates for the dead pc are meaningless
  _myAn = null; _myStream = null;   // the analyser was bound to the dead stream
  // THE SERVER CHOOSES THE ICE CONFIG (the credential's `iceServers?`), so an
  // operator can point at their own STUN/TURN; without STUN a peer on another
  // network stalls in 'checking'. The fallback stays [] (an older server's
  // credential behaves as before, with no public dependency).
  pc = new RTCPeerConnection({ iceServers: credential?.iceServers ?? [] });

  // The server names each route by the speaker it carries via a sideband
  // `sfu-route` message before the offer that adds it; ontrack pairs arriving
  // tracks with speaker ids in arrival order. ONE SUBSCRIPTION FOR THE MODULE'S
  // LIFETIME (core.js has no `off`, so a per-connect listener would leak and
  // desync the queue); the module-level array is rebound here instead.
  routeQueue.length = 0;
  pc.ontrack = (e) => {
    // PREFER THE TRACK'S OWN IDENTITY: the server names each outbound stream
    // after its speaker (sfu.ts ensureRoute), so msid cannot desync. The queue is
    // a fallback for an older server; when both DISAGREE, msid wins, loudly.
    const viaMsid = e.streams?.[0]?.id;
    const viaQueue = routeQueue.shift();
    const id = (viaMsid && viaMsid !== 'default') ? viaMsid : viaQueue;
    if (viaMsid && viaQueue && viaMsid !== 'default' && viaMsid !== viaQueue) {
      console.warn('[sfu] route identity mismatch — msid', viaMsid, 'vs queue', viaQueue, '(trusting msid)');
    }
    if (id) attach(id, e.track);
  };

  // Candidate TYPE is the evidence for the diagnosis below: host-only means no
  // STUN reflexive address was ever obtained, so nothing off this machine can
  // route to us. Recorded here because by the time ICE stalls, the candidates
  // are long gone.
  let _sawNonHostCandidate = false;
  pc.onicecandidate = (e) => {
    if (!e.candidate) return;
    if (e.candidate.type && e.candidate.type !== 'host') _sawNonHostCandidate = true;
    // ICE names its generation, exactly as the answer does: the server refuses
    // a candidate that cannot prove which leg it belongs to, so a stale
    // predecessor tab cannot trickle into its successor's pc.
    send({ type: 'sfu-ice', candidate: e.candidate, gen: cred?.mediaGen });
  };

  // A CONNECTION THAT NEVER CONNECTS MUST SAY SO, to the person: the local mic
  // meter reads a live capture whether or not packets ever leave. Without a
  // viable candidate pair (no STUN/TURN across networks) ICE throws nothing; it
  // just sits in 'checking'. 'disconnected' is deliberately NOT failure (often
  // transient); 'failed' and a stall in 'checking' are the real reports.
  let iceStallTimer = null;
  const clearStall = () => { if (iceStallTimer) { clearTimeout(iceStallTimer); iceStallTimer = null; } };
  // Which pc THIS closure serves. The handlers and the stall timer must judge
  // the connection they were armed for — reading the module-level `pc` let a
  // superseded connection's timer diagnose the successor.
  const myPc = pc;
  pc.oniceconnectionstatechange = () => {
    if (myPc !== pc) return;            // a ghost has no diagnosis to offer
    const st = pc.iceConnectionState;
    if (st === 'checking') {
      clearStall();
      // Host-only candidate pairs settle in well under a second on a LAN; 8s
      // means there is no viable pair and there never will be without STUN/TURN.
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
          // A stall is the same corpse as 'failed' with less ceremony — without
          // STUN it will stall again, which is why the bridge CAPS the retries
          // rather than this path deciding it is hopeless.
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
      // RECOVER, don't just report: a media-only death (world socket fine, ICE
      // gone: network switch, sleep/wake, NAT rebind) emits sfu-media-dead; the
      // bridge owns the retry budget; this only names the corpse.
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
  // The connection this offer was FOR: a reconnect mid-await swaps the
  // module-level pc, and answering on the fresh one (no remote offer) throws
  // InvalidStateError. Same snapshot pattern as the state handler.
  const myPc = pc;
  await myPc.setRemoteDescription({ type: 'offer', sdp });
  if (myPc !== pc) return;              // superseded mid-exchange — the new pc has its own offer coming
  // Candidates that arrived before the offer finished applying were queued —
  // feed them now that addIceCandidate has a description to attach them to.
  while (pendingIce.length) {
    if (myPc !== pc) return;   // queue now belongs to the successor's offer
    const c = pendingIce.shift();
    try { await myPc.addIceCandidate(c); } catch { /* stale */ }
  }
  const answer = await myPc.createAnswer();
  if (myPc !== pc) return;
  await myPc.setLocalDescription(answer);
  if (myPc !== pc) return;
  // RESCUE A STRANDED PUBLISH: a publish that beat the first offer into an
  // occupied room can sit on a transceiver JSEP associated with a recv route.
  // currentDirection is authoritative here (the answer just applied it): a live
  // outbound track with no m-line actually sending moves to the floor and we
  // re-negotiate.
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
  // PRESENT THE CREDENTIAL: send the nonce back so the server's replay check
  // (usedNonces) and its refusals can run. A gate the client never addresses is
  // not a gate.
  // The generation this answer is FOR — the server drops it if the leg has
  // been replaced since the offer (A2 generation binding).
  send({ type: 'sfu-answer', sdp: answer.sdp, gen: cred?.mediaGen ?? cred?.gen, cred: cred && {
    world: cred.world, id: cred.id, primaryGen: cred.primaryGen,
    mediaGen: cred.mediaGen ?? cred.gen, incarnation: cred.incarnation, nonce: cred.nonce } });
}

// EARLY CANDIDATES ARE NOT GARBAGE: while sfuOnOffer is still applying the
// offer, addIceCandidate throws, and the one viable pair can arrive in exactly
// that window. Queue until a remote description exists.
const pendingIce = [];
export async function sfuOnIce(candidate) {
  if (!pc) return;
  if (!pc.remoteDescription) { pendingIce.push(candidate); return; }
  try { await pc.addIceCandidate(candidate); } catch { /* stale/dup candidate */ }
}

/** Publish the mic. Plain getUserMedia — no SDK wrapper. The constraints ask for
 *  the browser's own AGC/NS/AEC, which come free here (docs/research/sfu-client-negotiation.md). */
// ONE ACQUISITION AT A TIME: getUserMedia can sit on a permission prompt for
// seconds, and two callers inside it at once would publish twice and orphan a
// stream whose hardware light never goes off. The guard is the promise, not a
// boolean: late callers await the same acquisition.
let micPending = null;
// Which pc the pending acquisition was FOR: a reconnect mints a new pc while
// getUserMedia is still up, and a publish must not coalesce onto the old one.
// A stale pending is awaited (never raced) and then treated as absent.
let micPendingPc = null;

export async function sfuMic(on = true) {
  wantMic = on;
  if (!pc) return;
  if (!on) {
    // MIC OFF MUST NOT MEAN VOICE OFF when a synth provider speaks for you:
    // swap the SOURCE instead of muting it, so the sender keeps publishing.
    const { synthProvider } = await import('./voicesource.js');
    // say why the swap did or did not happen
    const prov = synthProvider();
    why('publish', `mic off · provider=${prov ? 'registered' : 'NONE'}`
      + (prov ? ` · available=${!!prov.available?.()}` : ''));
    if (prov?.available?.()) {
      // Drop the device stream and re-enter the publish path below, which
      // re-acquires from voiceSource() (the synth, now micWanted is false):
      // ONE place where a track is chosen and attached.
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
  // A SYNTH STREAM IS NOT A MIC TO RE-ENABLE: after a swap, micStream may hold
  // synthetic frames; re-acquire whenever the current stream is not a real device.
  // A real device re-enabled here tells micstate it is back in the same
  // synchronous breath (device liveness gates the lane: micstate.js).
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
    // NOTHING TO APPLY AFTER THIS AWAIT: the publish we wait on re-reads wantMic
    // after its own await and acts on the intent current then; acting here would
    // be a second, staler answer. A waiter only waits.
    await micPending;
    return;
  }
  // A stale pending is sfuPublish's problem: its entry loop re-checks after every await.
  return sfuPublish();
}

/** Acquire a source (mic or synth, decided by voiceSource) and publish it.
 *  Split out of sfuMic so the mic-OFF path can re-enter it to swap sources
 *  rather than carrying a second copy of the transceiver logic below. */
async function sfuPublish() {
  if (!pc) return;
  // RE-CHECK AFTER EVERY STALE AWAIT, or two waiters on the same stale pending
  // both resume and mint two acquisitions: a fresh same-pc pending is joined,
  // a stale one is awaited again.
  while (micPending) {
    if (micPendingPc === pc) return micPending;
    try { await micPending; } catch { /* the old one's problem */ }
  }
  // Snapshot for the same reason as sfuOnOffer: getUserMedia can take seconds
  // (a permission prompt), and a reconnect in that window swaps pc — the
  // acquired track must not be planted on a connection from another session.
  const myPc = pc;
  micPendingPc = myPc;
  micPending = (async () => {
    // ASK THE SEAM, NOT THE DEVICE: voiceSource() returns the microphone when one
    // is available and wanted, and the synth provider otherwise (marking synthetic
    // streams so the gate is skipped). Everything below is source-agnostic.
    const { voiceSource } = await import('./voicesource.js');
    const asked = wantMic;
    const raw = await voiceSource({ micWanted: asked });
    // RE-READ INTENT AFTER THE AWAIT: a mic toggled during the prompt means what
    // arrived answers a question nobody is asking any more. Stop it (a device
    // keeps the hardware light on) and let the outer function ask the current one.
    if (wantMic !== asked) {
      why('publish', `intent changed during acquisition (asked mic=${asked}, now ${wantMic}) — dropping ${raw?.synthetic ? 'synth' : 'device'}`);
      for (const t of raw?.getTracks?.() ?? []) { try { t.enabled = false; t.stop(); } catch { /* gone */ } }
      // A device the person turned OFF is not live — say so before anything
      // reads micOn(); the re-publish below reports its own source's truth.
      if (!raw?.synthetic) { try { (await import('./micstate.js')).setMicLive(false); } catch { /* probe env */ } }
      return 'intent-changed';
    }
    // GATE IT BEFORE THE SENDER SEES IT, or the room tone goes out continuously and
    // the sensitivity slider drives nothing. gateFor() passes a synthetic source
    // through untouched (nothing to gate; the graph can't run on a stalled clock).
    const { gateFor, gateIsUnavailable, ungatedAllowed, setMicLive } = await import('./micstate.js');
    const s = gateFor(raw);
    // Tell micstate whether a DEVICE is capturing — the third state micOn()
    // needs and sfuMicOn() never had (it is two-state and cannot tell a muted
    // mic from a live one).
    setMicLive(!raw?.synthetic && wantMic);
    if (!raw?.synthetic && gateIsUnavailable() && !ungatedAllowed()) {
      // Refuse rather than publish ungated: the panel offers an explicit
      // opt-in row for that, and silently transmitting an ungated mic is the
      // one outcome nobody consented to.
      bus.emit('voice-gate-unavailable', {});
      wantMic = false;
      return;
    }
    // Superseded during acquisition (reconnect swapped the pc): stop what we
    // acquired — an orphan device stream keeps the hardware light on — and let
    // the new session's own replay publish on the live connection.
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
    // addTrack PICKS A TRANSCEIVER FOR YOU, AND WITH 2+ PEOPLE IT PICKS A SPEAKER
    // ROUTE, so the server never subscribes. Put the track on the one the SERVER
    // offered for it, the floor (docs/research/sfu-client-negotiation.md; repro: tools/mini-sfu-repro.mjs).
    const track = s.getTracks()[0];
    // Order: the sender we already own (a SWAP: replaceTrack, no renegotiation)
    // → the inactive floor (first publish) → bare addTrack only when neither
    // exists (solo, pre-offer). "Already own" is judged by currentDirection, what
    // the negotiation agreed; direction (only our ask) counts only while
    // currentDirection is null (never yet negotiated).
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
        // No floor offered yet (we are the only one here, or the mic beat the
        // first offer). addTrack is correct then: there are no routes to mis-pick.
        for (const t of s.getTracks()) pc.addTrack(t, s);
      }
    }
  })();
  // A DENIED permission prompt is a normal answer, not a crash: no caller catches
  // (the bridge's replay runs in a bus handler), so clear the intent here and keep
  // sfuMicOn() (`!!micStream && wantMic`) honest.
  const own = micPending;
  let outcome;
  try {
    outcome = await own;
  } catch (e) {
    // Only OUR intent may be cleared: a superseded invocation's rejection must not
    // undo a fresh sfuMic(true).
    if (myPc === pc) wantMic = false;
    console.warn('[sfu] mic not granted:', e?.name || e);
    return;
  } finally {
    // CAS, not blind null: a successor may have registered its own pending
    // while we settled — clobbering it made a THIRD acquisition possible.
    if (micPending === own) micPending = null;
  }
  if (outcome === 'intent-changed') {
    // The same decision sfuMic(false)/sfuMic(true) would have made had the
    // flip landed on a settled stream: a wanted mic is acquired; an unwanted
    // one is replaced by the synth only when a provider can speak for you —
    // with none, there is nothing to publish (re-entering would acquire the
    // very device we just dropped, forever).
    if (myPc !== pc) return;
    const { synthProvider } = await import('./voicesource.js');
    const prov = synthProvider();
    if (wantMic || !!prov?.available?.()) return sfuPublish();
    return;
  }
  // Adding a track makes US want to renegotiate — but the server offers, so we
  // ASK it to, rather than offering ourselves and causing glare.
  bus.emit('sfu-want-negotiate', {});
}

/** MY OWN level, for my own mouth flap and the 🎙 glyph (voicemouths.js): the
 *  same analyser shape as sfuPeerLevels below, on the outbound side. */
export function sfuMyLevel() {
  if (!micStream || !wantMic) return 0;
  try {
    // MEASURE THE RAW DEVICE, NOT THE LANE: micStream is the GATED stream, and a
    // mouth (or a sensitivity meter) must move below the threshold too, as
    // micstate's does.
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
    // THE RAW ICE/CONNECTION STATES, not just `active`: still 'checking', 'failed'
    // and never-existed are three problems with three fixes.
    iceConnectionState: pc?.iceConnectionState ?? null,
    connectionState: pc?.connectionState ?? null,
    iceGatheringState: pc?.iceGatheringState ?? null,
    speakers: [...speakers.entries()].map(([id, s]) => ({ id, hasStream: !!s.stream })),
  };
}

/** Live speaker records, for the rolloff/hush loops in the bridge. Returns the
 *  actual objects (playback state must be mutated in place, not on a copy) but
 *  as entries rather than the Map itself, so a caller cannot add or delete
 *  speakers behind ontrack's back. */
export function sfuSpeakerEntries() { return [...speakers.entries()]; }

/** Live inbound-audio stats — the browser's NetEq telling us what it is doing:
 *  delivered AND destroyed counted separately. jitterBufferTargetDelay is NetEq's
 *  adaptive depth, inserted/removedSamples its time-stretching, concealedSamples
 *  its PLC: the jitter buffer we don't have to build. */
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

/** Tear down ONE departed speaker's playback. Their <audio> element and
 *  analyser otherwise outlive them for the whole session — audio elements are
 *  never in the DOM here, so nothing else can ever reclaim them, and a busy
 *  world accumulates a dead analyser per visitor per session. */
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
