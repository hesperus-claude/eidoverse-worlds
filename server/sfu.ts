/**
 * An in-process SFU (#104 §8.1). Forwards ENCODED Opus, never decoding, so the browser keeps its jitter buffer, PLC,
 * FEC and congestion control; one track per (listener, speaker) pair, no mixing, for client spatialization.
 * AUTHORITY: none (relaydecision.ts's, enforced by the caller). The only enforcement here: a pair with no consent is
 * never fed.
 */
import { RTCPeerConnection, MediaStreamTrack, MediaStream, RTCRtpCodecParameters } from "werift";
import type { RtpPacket } from "werift";
import { transportErrorsSwallowed } from "./sfuguard.ts";

/** The browser's default publish codec, pinned so the answer never negotiates something we'd transcode. */
const AUDIO_CODEC = new RTCRtpCodecParameters({
  mimeType: "audio/opus", clockRate: 48000, channels: 2, payloadType: 111,
});

export interface SfuLeg {
  /** The #103 binding: a leg belongs to ONE generation; a takeover retires it rather than mutating it. */
  id: string;
  gen: number;
  pc: RTCPeerConnection;
  /** inbound mic, once published */
  ingress: MediaStreamTrack | null;
  /** Serializes renegotiation: concurrent offers on one pc are SDP glare, and a lost offer's route is invisible to
   *  the browser. */
  negotiating: Promise<void>;
  /** `negotiated` is separate from existence: until its offer succeeds the browser has no receiver. */
  outbound: Map<string, { track: MediaStreamTrack; negotiated: boolean }>;
  /** diagnostics + the fail-closed proof */
  rxPackets: number;
  closed: boolean;
}

export class Sfu {
  private legs = new Map<string, SfuLeg>();
  /** ABSENT MEANS DENIED at both levels. NESTED, never a joined key: ids may contain NUL (`.{1,64}`), so a joined
   *  key isn't injective and one pair's revoke could revoke or GRANT another's. */
  private consent = new Map<string, Map<string, boolean>>();
  /** enforced at INGRESS: inaudible to everyone at once, never routed around */
  private muted = new Set<string>();
  /** server-deafened: overrides their own consent, which they could turn back on */
  private deafened = new Set<string>();
  private forwarded = 0;

  /** COALESCED: werift adds a transceiver per exchange (more SDP, double delivery). */
  private dirty = new Set<string>();

  // sfuguard.ts is installed by server.ts at boot: a constructor must not change process-wide crash semantics
  constructor(private opts: { onNegotiationNeeded?: (legId: string) => void } = {}) {}

  private pos = new Map<string, { x: number; y: number; z: number; at: number }>();
  /** Diagnostic only. */
  gated = 0;
  /** Diagnostic only. */
  capped = 0;
  private slots = new Map<string, Set<string>>();

  /** Client rolloff is silent beyond 20 m (client/lib/voiceconsent.js). HYSTERESIS keyed on previous state, or someone
   *  at exactly the cutoff toggles audibly on every update. */
  private static readonly ENTER_M = 20;
  private static readonly HYSTERESIS = 1.10; // stop only 10% further out
  private static readonly POS_STALE_MS = 5000;

  /** Per listener, bounding the worst case at N×MAX_AUDIBLE. 0 = no cap (default: dropping a speaker is opt-in). */
  maxAudiblePerListener = 0;
  /** A newcomer must be MEANINGFULLY closer, or two near-equal speakers swap the last slot every tick. */
  private static readonly STICKINESS = 0.8;
  /** hysteresis memory; NESTED for the same reason as consent (a fourth pair key should extract a PairMap<T>: NUL-joined
   *  keys collided here twice) */
  private inRange = new Map<string, Map<string, boolean>>();

  /** OPTIONAL: a world that never calls this never gates. */
  setPosition(legId: string, x: number, y: number, z: number, now = Date.now()) {
    this.pos.set(legId, { x, y, z, at: now });
  }

  /** Unknown or stale → YES. */
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

  /** Lazily on the packet path, never a timer: the set only changes when an outside speaker sends a packet. */
  private withinCap(listenerId: string, speakerId: string): boolean {
    const cap = this.maxAudiblePerListener;
    if (cap <= 0) return true;                                   // disabled → everyone
    let held = this.slots.get(listenerId);
    if (!held) { held = new Set(); this.slots.set(listenerId, held); }
    if (held.has(speakerId)) return true;                        // already audible → keep
    if (held.size < cap) { held.add(speakerId); return true; }    // room to spare

    // full: displace the furthest holder only if closer than its STICKINESS-discounted distance
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
      // its hysteresis memory goes too: no stale "was in" bit
      this.inRange.get(listenerId)?.delete(worstId);
      return true;
    }
    return false;
  }

  /** null if unknown OR STALE: one staleness rule for gate and cap, or the cap drops what the gate promised. */
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

  /** The websocket proved identity, so the leg IS the authorization; revoking is a local pc.close(). */
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

  /** The hot path: checks in the order that fails cheapest first; P2P offload (#104 phase 2) hooks in beside the
   *  proximity gate (both answer "does this packet need the relay?") — see docs/research/sfu-p2p-offload.md. */
  private fanout(from: SfuLeg, rtp: RtpPacket) {
    // the closed check comes FIRST: werift's onReceiveRtp outlives the leg, and counting late packets makes a corpse look live
    if (from.closed || this.muted.has(from.id)) return;   // moderator mute: at the source
    from.rxPackets++;
    for (const [listenerId, listener] of this.legs) {
      if (listenerId === from.id || listener.closed) continue;
      if (!this.allows(listenerId, from.id)) continue;         // absent = denied
      // AFTER consent so it can only SUBTRACT; fail-open: a wrong gate costs silence, forwarding only bandwidth
      if (!this.inEarshot(listenerId, from.id)) { this.gated++; continue; }
      if (!this.withinCap(listenerId, from.id)) { this.capped++; continue; }
      const route = listener.outbound.get(from.id);
      if (!route) continue;                  // no route = not heard
      route.track.writeRtp(rtp);
      this.forwarded++;
    }
  }

  /** Insertion order = transceiver order = the browser's ontrack order (client/lib/voicesfu.js's msid fallback). */
  routesFor(legId: string): string[] {
    return [...(this.legs.get(legId)?.outbound.keys() ?? [])];
  }

  /** Unknown leg or malformed candidate is dropped, not thrown: a late candidate is normal churn. */
  addIceCandidate(legId: string, candidate: unknown) {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed || !candidate) return;
    try { void leg.pc.addIceCandidate(candidate as RTCIceCandidate); } catch {}
  }

  /** Separate from consent: a negotiated track can be starved, so flipping consent is a memory write, not SDP. */
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

  /** One ask per leg per microtask, however many routes were added. */
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
        // the hook is the CALLER's code: a throw from a bare queueMicrotask would kill the world server
        console.error(`[sfu:${legId}] onNegotiationNeeded threw`, e);
      }
    });
  }

  /** SERIALIZED per leg: the caller owns the signaling, we own the ordering; a throwing exchange never wedges the next. */
  negotiate(legId: string, exchange: (pc: RTCPeerConnection) => Promise<void>): Promise<void> {
    const leg = this.legs.get(legId);
    if (!leg || leg.closed) return Promise.reject(new Error(`no leg ${legId}`));
    const run = leg.negotiating.then(async () => {
      if (leg.closed) return;
      // snapshot BEFORE: a route added mid-exchange isn't in that SDP, so it stays pending
      const covered = [...leg.outbound.keys()];
      await exchange(leg.pc);
      let stillPending = false;
      for (const [speakerId, r] of leg.outbound) {
        if (covered.includes(speakerId)) r.negotiated = true;
        else stillPending = true;
      }
      if (stillPending) this.askToNegotiate(legId);
    });
    leg.negotiating = run.catch(() => {});      // a failure must not wedge the queue
    return run;
  }

  /** Listener-consent, server-enforced (#104 A3); never a sender-declared recipient list, the weaker guarantee. */
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

  /** Local and immediate: no TTL, no replay window; the packets stop because the socket is gone. */
  closeLeg(id: string) {
    const leg = this.legs.get(id);
    if (!leg) return;
    leg.closed = true;
    // ROUTES SURVIVE THE SPEAKER (werift keeps transceivers forever): a same-id reconnect is zero-SDP. No leak: the
    // retired id's consent is wiped below and fanout checks consent first.
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

  /** /relay-diag: is anything arriving, is anything leaving. */
  diag() {
    return {
      legs: [...this.legs.values()].map((l) => ({
        id: l.id, gen: l.gen, rxPackets: l.rxPackets,
        hears: [...l.outbound.entries()].filter(([, r]) => r.negotiated).map(([id]) => id),
        // a pending route is NOT "hears": surfaced separately so a stuck one is visible
        pendingRoutes: [...l.outbound.entries()].filter(([, r]) => !r.negotiated).map(([id]) => id),
        publishing: !!l.ingress,
        state: l.pc.connectionState,
      })),
      forwarded: this.forwarded,
      // reported beside forwarded: a load harness (tools/sfu-load.ts) that can't see drops reads a server that drops more as healthier
      suppressed: { gated: this.gated, capped: this.capped },
      muted: [...this.muted],
      deafened: [...this.deafened],
      transportErrorsSwallowed: transportErrorsSwallowed(),
    };
  }

  closeAll() { for (const id of [...this.legs.keys()]) this.closeLeg(id); }
}
