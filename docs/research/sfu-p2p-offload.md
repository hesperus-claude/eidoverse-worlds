# SFU: where P2P offload would plug in, and voice-last ordering

Code: `server/sfu.ts` (`fanout`, `ensureRoute`, the `consent` and `inRange` maps), `server/relaydecision.ts`.
Operator and spec notes: `notes/SFU-SPEC.md`, `notes/SFU-OPERATOR.md`.

The settled architecture (#104) is relay-floor with P2P as a deferred phase 2: the SFU always works, and a pair
that manages a direct connection stops paying for the relay hop. Basis ships this; the points below are what to
take from it when phase 2 is built. Nothing here is built yet.

## The hook is the fanout loop

Basis checks `IsP2POffloaded(sender, client)` in its fanout and skips the send. Ours is one more `continue` beside
the proximity gate in `fanout()`: both answer "does this packet need to traverse the relay?", so they belong
adjacent, after consent (so they can only subtract).

## Fast-path the common case

Basis guards with `HasOffloadedPairs`, a single int compare before any map lookup, because zero offloaded pairs is
overwhelmingly common. At a dozen people it hardly matters; at a thousand it removes a million hash lookups a tick.
Our proximity gate should learn the same trick if no positions are set.

## Pairs are unordered

Basis packs `(lo, hi)` into one key so a pair has one identity regardless of direction; ours must too. This would
be the third pair-keyed map in `sfu.ts`, after `consent` and `inRange`, which are nested maps on purpose: ids may
contain NUL, so a NUL-joined string key is not injective, and that collision was found here twice. If a fourth
pair map appears, extract a `PairMap<T>` rather than joining strings.

## The hard part is the watchdog

A direct link that dies silently is worse than none: both ends think they're connected and neither hears
anything. Basis put that decision logic in its own headless-testable unit (`BasisP2PLinkHealth.cs`), the same move
as our `relaydecision.ts`. Its verdicts:

- `DemoteStale`: no inbound past `staleMs`, so the path is dead or one-way;
- `DemoteUnconfirmed`: reached Connected but the server never confirmed it;
- `ClearFlapCounter`: healthy long enough to forget past flapping;

with a post-connect grace window in which demotion is never allowed, and staleness checked before unconfirmed so
the reported reason is the specific one. Copy that structure into `relaydecision.ts` (transport-agnostic, already
the regression anchor) rather than inventing thresholds.

## Demotion must be invisible

Falling back to the relay is the recovery path, so the relay route must still exist while a pair is offloaded:
keep the transceiver negotiated and starve it, as consent already does (`ensureRoute`). That is why consent and
routes are separate concepts in `sfu.ts`, and it makes demotion a memory write instead of an SDP round trip.

## Voice moves last and comes back first

Animation offload is the same broker with different traffic and a much lower stake: a dropped pose interpolates,
a dropped voice packet is an audible hole. If both are built, voice is the **last** traffic moved to a new direct
link and the **first** moved back: earn trust with pose traffic, spend it on audio. Basis routes both over one
link; the asymmetry in failure cost argues we shouldn't.
