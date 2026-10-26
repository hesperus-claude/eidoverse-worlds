/**
 * An in-process SFU — voice as an organ of the world server, not a service beside it (#104 §8.1; why the other
 * candidates lost is in the PR that introduced this file).
 *
 * It forwards ENCODED Opus and never decodes it, so the browser keeps its own jitter buffer, PLC, FEC and congestion
 * control. Every (listener, speaker) pair gets its own track: no SSRC rewriting, no mixing, one stream per speaker for
 * client spatialization.
 *
 * AUTHORITY: none. Who may speak or hear, and which generation owns a leg, is relaydecision.ts's, enforced by the
 * caller. The only enforcement here: a pair with no consent is never fed.
 */
import { RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters } from "werift";
import type { RtpPacket } from "werift";
import { transportErrorsSwallowed } from "./sfuguard.ts";

/** Opus, 48k stereo — the browser's default publish codec. Pinned so the
 *  answer never negotiates something we'd have to transcode. */
const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111,
});

export interface SfuLeg {
  /** (id, surface, gen) — the #103 binding. A leg belongs to ONE generation;
   *  a takeover retires it rather than mutating it. */
  id: string;
  gen: number;
  pc: RTCPeerConnection;
  /** this leg's inbound mic, once the browser publishes it */
  ingress: MediaStreamTrack | null;
  /** Serializes renegotiation: concurrent createOffer/setLocalDescription on one pc is SDP glare, and a lost offer's
   *  route would be live in our map and invisible to the browser. */
  negotiating: Promise<void>;
  /** speakerId → the route THIS leg hears that speaker on. `negotiated` is separate from existence: until its offer
   *  succeeds the browser has no receiver, and conflating the two made a silent route `diag` called healthy. */
  outbound: Map<string, { track: MediaStreamTrack; negotiated: boolean }>;
  /** packets received from this leg's mic (diagnostics + the fail-closed proof) */
  rxPackets: number;
  closed: boolean;
}

export class Sfu {
  private legs = new Map<string, SfuLeg>();
  /** listener → speaker → allowed. ABSENT MEANS DENIED at both levels (an allowlist). NESTED, not a joined key: ids may
   *  contain NUL (`parseRelayIdentity` accepts `.{1,64}`), so `listener + NUL + speaker` isn't injective and one pair's
   *  revoke could revoke or GRANT another's. */
  private consent = new Map<string, Map<string, boolean>>();
  /** speakers a moderator has silenced: enforced at INGRESS, so a muted
   *  speaker is inaudible to everyone at once and cannot be routed around. */
  private muted = new Set<string>();
  /** listeners the server has made deaf: overrides their own consent, which they could turn back on */
  private deafened = new Set<string>();
  private forwarded = 0;

  /** Legs with tracks added but not yet offered, COALESCED: three routes need ONE exchange, since werift adds a
   *  transceiver per exchange (more SDP, double delivery). */
  private dirty = new Set<string>();

  // the werift UDP-error guard (sfuguard.ts) is installed once by server.ts at boot: a constructor must not change
  // process-wide crash semantics
  constructor(private opts: { onNegotiationNeeded?: (legId: string) => void } = {}) {}

  /** Last known world position per leg, and when we heard it. */
  private pos = new Map<string, { x: number; y: number; z: number; at: number }>();
  /** Packets suppressed because nobody could have heard them. Diagnostic only. */
  gated = 0;
  /** Packets suppressed by the per-listener speaker cap. Diagnostic only. */
  capped = 0;
  /** listener → speakerIds currently holding an audible slot. */
  private slots = new Map<string, Set<string>>();

  /** Client rolloff is VOICE_FULL_M=3 → VOICE_SILENT_M=20 (client/lib/voiceconsent.js): beyond 20 m the listener
   *  multiplies by zero. HYSTERESIS, not a margin (an exit 10% past the enter, keyed on previous state, as Basis's
   *  BasisDistanceJob): someone at exactly the cutoff would otherwise toggle, audibly, on every update. */
  private static readonly ENTER_M = 20;      // start forwarding within this
  private static readonly HYSTERESIS = 1.10; // …stop only beyond 10% further (Basis's value)
  private static readonly POS_STALE_MS = 5000;

  /** Hard cap on simultaneous speakers per listener (as Basis's BasisAudioCapJob): forty people in one plaza all pass
   *  the distance gate, so the cap bounds the worst case at N×MAX_AUDIBLE. 0 = no cap (the default: dropping a
   *  speaker is a policy an operator opts into). */
  maxAudiblePerListener = 0;
  /** An audible speaker's squared distance is multiplied by this when competing for a slot, so a newcomer must be
   *  MEANINGFULLY closer; otherwise two near-equal speakers swap the last slot every tick (Basis: StickinessBonus). */
  private static readonly STICKINESS = 0.8;
  /** Was this pair audible last time? The memory hysteresis needs; NESTED for the same reason as consent. */
  private inRange = new Map<string, Map<string, boolean>>();

  /** Tell the SFU where a participant is. Positions are OPTIONAL — a world that
   *  never calls this simply never gates, which is why this cannot break an
   *  existing deployment. */
  setPosition(legId: string, x: number, y: number, z: number, now = Date.now()) {
    this.pos.set(legId, { x, y, z, at: now });
  }

  /** Could `listener` possibly hear `speaker`? Unknown or stale → YES.
   *  Hysteresis: a pair already in range stays in range until 10% further out. */
  private inEarshot(listenerId: string, speakerId: string, now = Date.now()): boolean {
    const a = this.pos.get(listenerId), b = this.pos.get(speakerId);
    if (!a || !b) return true;                                   // unknown → forward
    if (now - a.at > Sfu.POS_STALE_MS || now - b.at > Sfu.POS_STALE_MS) return true;  // stale → forward
    const dx = a.x - b.x, dy = a.y - b.y, dz = a.z - b.z;
    const d2 = dx * dx + dy * dy + dz * dz;    // squared: no sqrt on the packet path
    const enter = Sfu.ENTER_M * Sfu.ENTER_M;
    const exit = enter * Sfu.HYSTERESIS * Sfu.HYSTERESIS;
    let row = this.inRange.get(listenerId);
    const was = row?.get(speakerId) === true;
    const nowIn = was ? d2 < exit : d2 < enter;
    if (nowIn !== was) {
      if (!row) { row = new Map(); this.inRange.set(listenerId, row); }
      row.set(speakerId, nowIn);
    }
    return nowIn;
  }

  /** Does `speaker` hold one of `listener`'s audible slots? Recomputed lazily on the packet path, not a timer: the set
   *  only changes when an outside speaker wants in, and that speaker is producing a packet we'd forward anyway. */
  private withinCap(listenerId: string, speakerId: string): boolean {
    const cap = this.maxAudiblePerListener;
    if (cap <= 0) return true;                                   // disabled → everyone
    let held = this.slots.get(listenerId);
    if (!held) { held = new Set(); this.slots.set(listenerId, held); }
    if (held.has(speakerId)) return true;                        // already audible → keep
    if (held.size < cap) { held.add(speakerId); return true; }    // room to spare

    // Full. Displace the furthest holder, but only if this speaker is closer
    // than that holder's STICKINESS-discounted distance.
    const me = this.d2(listenerId, speakerId);
    if (me === null) return true;                                // no positions → cannot rank, admit
    let worstId: string | null = null, worstD2 = -1;
    for (const h of held) {
      const d = this.d2(listenerId, h);
      if (d === null) continue;
      const effective = d * Sfu.STICKINESS;                      // incumbents are sticky
      if (effective > worstD2) { worstD2 = effective; worstId = h; }
    }
    if (worstId !== null && me < worstD2) {
      held.delete(worstId); held.add(speakerId);
      // The displaced speaker also loses its hysteresis memory, so it must
      // re-enter range cleanly rather than inheriting a stale "was in" bit.
      this.inRange.get(listenerId)?.delete(worstId);
      return true;
    }
    return false;
  }

  /** Squared distance between two legs, or null if either position is unknown OR STALE. One staleness rule for the gate
   *  and the cap: a position we would not gate on we may not rank on, or the cap drops what the gate promised. */
  private d2(a: string, b: string, now = Date.now()): number | null {
    const p = this.pos.get(a), q = this.pos.get(b);
    if (!p || !q) return null;
    if (now - p.at > Sfu.POS_STALE_MS || now - q.at > Sfu.POS_STALE_MS) return null;
    const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z;
    return dx * dx + dy * dy + dz * dz;
  }

  private allows(listener: string, speaker: string): boolean {
    if (this.deafened.has(listener)) return false;
    return this.consent.get(listener)?.get(speaker) === true;   // absent = denied, both levels
  }

  /** Create a leg for an already-authenticated participant: the websocket proved identity, so the leg IS the
   *  authorization, and revoking is a local pc.close(). */
  createLeg(id: string, gen: number): SfuLeg {
    this.closeLeg(id);                       // one body per identity (#57 takeover)
    // max-bundle and no IPv6: with 12 m-lines the default offer took ~2 s (96 candidates), these ~61 ms
    const pc = new RTCPeerConnection({
      codecs: { audio: [AUDIO_CODEC] },
      bundlePolicy: "max-bundle",
      iceUseIpv6: false,
    });
    const leg: SfuLeg = { id, gen, pc, ingress: null, negotiating: Promise.resolve(),
                          outbound: new Map(), rxPackets: 0, closed: false };


    pc.ontrack = (e) => {
      // SUBSCRIBE ONCE: ontrack fires per transceiver and again after each renegotiation, so re-subscribing would
      // forward every packet N times
      if (leg.ingress) return;
      leg.ingress = e.track;
      e.track.onReceiveRtp.subscribe((rtp) => this.fanout(leg, rtp));
    };
    this.legs.set(id, leg);
    return leg;
  }

  /** The hot path. One packet in, zero-or-more out — with the policy checks
   *  in the order that fails cheapest first. */
  // Future P2P offload (#104 phase 2) hooks in beside the proximity gate: both answer "does this packet need the relay?".
  // A fourth pair key (after consent, inRange, offload) should extract a PairMap<T>: NUL-joined keys collided here twice.
  private fanout(from: SfuLeg, rtp: RtpPacket) {
    // the closed check comes FIRST: werift's onReceiveRtp outlives the leg, and counting late packets makes a corpse look live
    if (from.closed || this.muted.has(from.id)) return;   // moderator mute: at the source
    from.rxPackets++;
    for (const [listenerId, listener] of this.legs) {
      if (listenerId === from.id || listener.closed) continue;
      if (!this.allows(listenerId, from.id)) continue;         // absent = denied
      // proximity gate, AFTER consent so it can only SUBTRACT; unknown or stale positions forward (fail-open: a wrong gate
      // costs silence, forwarding costs bandwidth the client discards)
      if (!this.inEarshot(listenerId, from.id)) { this.gated++; continue; }
      if (!this.withinCap(listenerId, from.id)) { this.capped++; continue; }
      const route = listener.outbound.get(from.id);
      if (!route) continue;                  // no route = not heard
      route.track.writeRtp(rtp);             // encoded Opus, straight through
      this.forwarded++;
    }
  }

  /** Speaker ids this leg has routes for, in insertion order = werift's transceiver order = the browser's ontrack
   *  order; client/lib/voicesfu.js pairs by msid and falls back to that order. */
  routesFor(legId: string): string[] {
    return [...(this.legs.get(legId)?.outbound.keys() ?? [])];
  }

  /** Trickle ICE from the browser. Unknown leg or malformed candidate is
   *  dropped rather than thrown — a late candidate for a closed leg is normal
   *  churn, not an error worth crashing a voice session over. */
  addIceCandidate(legId: string, candidate: unknown) {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed || !candidate) return;
    try { void leg.pc.addIceCandidate(candidate as RTCIceCandidate); } catch {}
  }

  /** Give `listener` a track to hear `speaker` on. Separate from consent on purpose: a negotiated track can be starved,
   *  so flipping consent is a memory write, not an SDP round trip. */
  ensureRoute(listenerId: string, speakerId: string): boolean {
    const listener = this.legs.get(listenerId);
    if (!listener || listener.closed || listenerId === speakerId) return false;
    const existing = listener.outbound.get(speakerId);
    if (existing) {
      // a route that exists but never NEGOTIATED is re-asked, or one failed exchange silences that pair forever
      if (!existing.negotiated) this.askToNegotiate(listenerId);
      return false;
    }
    const track = new MediaStreamTrack({ kind: "audio" });
    // IDENTITY RIDES WITH THE TRACK, never arrival order: msid surfaces as e.streams[0].id in the browser, and werift
    // derives it from the sender's `streams` here, not from MediaStreamTrack fields (those produce no msid at all)
    const stream = new MediaStream({ id: speakerId, tracks: [track] });
    listener.outbound.set(speakerId, { track, negotiated: false });
    listener.pc.addTransceiver(track, { direction: "sendonly", streams: [stream] } as any);
    // THE SERVER MUST OFFER, NOT ANSWER: a browser's mic offer is `sendonly`, and an answer can't add a receive
    // direction, so this hook means "SFU: create an offer for this leg", never "ask the browser to re-offer"
    this.askToNegotiate(listenerId);
    return true;
  }

  /** Coalesced "this leg needs an offer". One ask per leg per microtask however
   *  many routes were added — werift adds a transceiver per exchange, so N asks
   *  inflate the SDP and double-deliver. */
  private askToNegotiate(legId: string) {
    if (this.dirty.has(legId)) return;
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return;
    this.dirty.add(legId);
    queueMicrotask(() => {
      if (!this.dirty.delete(legId)) return;
      // check leg IDENTITY, not just the id: a takeover in between replaces the leg, and its successor must not get the ask
      if (this.legs.get(legId) !== leg || leg.closed) return;
      try {
        this.opts.onNegotiationNeeded?.(legId);
      } catch (e) {
        // 🔴 B4: the hook is the CALLER's code. A throw here used to escape a
        // bare queueMicrotask, become an uncaughtException, and kill the world
        // server. A caller bug must not be fatal to everyone else's audio.
        console.error(`[sfu:${legId}] onNegotiationNeeded threw`, e);
      }
    });
  }

  /** Run an SDP exchange for this leg, SERIALIZED against every other one for it. The caller owns the signaling; we own
   *  the ordering. Chaining onto the previous promise means a throwing exchange never wedges the next. */
  negotiate(legId: string, exchange: (pc: RTCPeerConnection) => Promise<void>): Promise<void> {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return Promise.reject(new Error(`no leg ${legId}`));
    const run = leg.negotiating.then(async () => {
      if (leg.closed) return;
      // snapshot the routes BEFORE, mark only those: a route added mid-exchange isn't in that SDP, so it stays pending
      // and gets its own ask
      const covered = [...leg.outbound.keys()];
      await exchange(leg.pc);
      let stillPending = false;
      for (const [speakerId, r] of leg.outbound) {
        if (covered.includes(speakerId)) r.negotiated = true;
        else stillPending = true;
      }
      if (stillPending) this.askToNegotiate(legId);   // the latecomer gets its own round
    });
    leg.negotiating = run.catch(() => {});      // a failure must not wedge the queue
    return run;
  }

  /** Listener-consent, server-enforced (#104 A3). Deliberately NOT Basis's
   *  sender-declared recipient list: there the speaker picks who hears them,
   *  which is the weaker guarantee. */
  setConsent(listenerId: string, speakerId: string, allowed: boolean) {
    let row = this.consent.get(listenerId);
    if (!row) { row = new Map(); this.consent.set(listenerId, row); }
    row.set(speakerId, allowed);
    if (allowed) this.ensureRoute(listenerId, speakerId);
  }

  setMuted(speakerId: string, muted: boolean) {
    if (muted) this.muted.add(speakerId); else this.muted.delete(speakerId);
  }

  setDeafened(listenerId: string, deaf: boolean) {
    if (deaf) this.deafened.add(listenerId); else this.deafened.delete(listenerId);
  }

  /** Revocation. Local and immediate — no webhook, no credential TTL, no
   *  replay window: the packets stop because the socket is gone. */
  closeLeg(id: string) {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.closed = true;
    // ROUTES SURVIVE THE SPEAKER: werift keeps every transceiver forever, so retaining a speaker's routes (keyed and
    // msid'd by id) makes a same-id reconnect zero-SDP and bounds transceivers by distinct speakers. No leak: the retired
    // id's consent is wiped below and fanout checks consent first; the corpse's own fanout stops at `from.closed`.
    try { leg.pc.close(); } catch { /* already dead */ }
    this.legs.delete(id);
    this.pos.delete(id);
    this.slots.delete(id);
    for (const held of this.slots.values()) held.delete(id);
    this.inRange.delete(id);
    for (const row of this.inRange.values()) row.delete(id);
    this.consent.delete(id);                       // everything this leg consented to
    for (const row of this.consent.values()) row.delete(id);   // everyone's consent TO it
  }

  getLeg(id: string) { return this.legs.get(id); }

  /** /relay-diag keeps working, and the numbers are the ones that matter for
   *  the acceptance table: is anything arriving, is anything leaving. */
  diag() {
    return {
      legs: [...this.legs.values()].map((l) => ({
        id: l.id, gen: l.gen, rxPackets: l.rxPackets,
        hears: [...l.outbound.entries()].filter(([, r]) => r.negotiated).map(([id]) => id),
        // A pending route is NOT "hears" — reporting it as such is what made
        // the B2 bug invisible. Surfaced separately so a stuck one is visible.
        pendingRoutes: [...l.outbound.entries()].filter(([, r]) => !r.negotiated).map(([id]) => id),
        publishing: !!l.ingress,
        state: l.pc.connectionState,
      })),
      forwarded: this.forwarded,
      // suppression in the same report as delivery: a load harness (tools/sfu-load.ts) that can't see drops would call
      // a cheaper server that drops more healthier
      suppressed: { gated: this.gated, capped: this.capped },
      muted: [...this.muted],
      deafened: [...this.deafened],
      transportErrorsSwallowed: transportErrorsSwallowed(),
    };
  }

  closeAll() { for (const id of [...this.legs.keys()]) this.closeLeg(id); }
}
