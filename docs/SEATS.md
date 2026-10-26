# Seats in the reference client

Not protocol. PROTOCOL §5 keeps the rule: a seat may make leaving deliberate, never impossible, and the escape always
stands the occupant up. How the reference client and agent door offer that escape (moved from PROTOCOL §5, the house's
view #260 10-20: reach distances, hold timings and key bindings belong to a client):

- Holding the get-up (X, or the stand tile pressed and held) for about 1.5 s stands the occupant up.
- Pressing it again (X, the tile, the menu) within 2 s of its refusal stands them up.
- An agent's `detach {escape: true}` always stands the occupant up.

Prior art: VRChat keeps respawn and the menu; Second Life's stand always works.

## The seat-profile store: write authority and integrity

`server/seats.ts` (#101) owns the seat-profile store: `assets/opt/seats/profiles.json` plus an append-only provenance
log. It judges each profile against the avatar's CURRENT bytes (`client/lib/seatcore.js`, the file every consumer
evaluates) and ships the verdict pre-judged on the avatar roster, so no consumer rehashes a VRM or reads a stale value as
fresh. A change is pushed to clients as `avatar-profile-updated {name, pose, rev}`.

Who may write:
- `POST /seat-profile` takes PROPOSALS only, from a NAMED actor: a `tokens.json` bearer or a home-vouched aid1 identity.
  The door (join) token may not write here: a profile moves every wearer of an avatar, and `?by=` is self-asserted. A
  proposal is at most 4096 bytes of JSON, and one that claims any review status other than `proposed` is refused (403). Bearer tokens are never logged or echoed.
- The countersign that makes a profile load-bearing has no HTTP path. The operator runs `tools/seat-accept.ts` on the
  box; it edits the store through the store's own functions, and the running server polls the store (every 5 s), reloads,
  diffs and pushes the update. The countersign names the revision the operator reviewed (`--expect-rev`): if the store has
  moved since, it refuses.
- The operator's import lane (`importProposal`) may carry an avatar that isn't on the roster; the record says so
  (`review.unrostered`). Every other proposal must name a roster avatar, since there are no bytes to judge it against
  otherwise (404).

Integrity rules:
- **Null-prototype maps.** The parsed store is copied into `Object.create(null)` maps, and the validator refuses
  `__proto__`, `constructor` and `prototype` as avatar names, so a key can't reach an inherited slot.
- **Provenance first.** The log line is appended before the snapshot is renamed into place, and the in-memory store swaps
  only after both; no caller reports success or broadcasts before the swap. So the log is always at or ahead of the
  snapshot, and the snapshot at or ahead of memory. On load, a log AHEAD of its snapshot is folded forward. A snapshot
  ahead of its log (a state with no receipt), or a log with duplicate or non-monotonic revisions (a forked history), is
  quarantined: the store serves every profile as missing, refuses writes (503) and says why, until the operator reconciles.
- **One cross-process writer.** The live server and the offline operator tool both write, so every mutation runs whole
  under one on-disk lock per store directory (`.write-lock`, exclusive create): acquire, forced reload (mtime is only a
  hint), re-check the preconditions, append the provenance line, rename the snapshot, swap, release. Ownership is a nonce,
  re-checked before each irreversible step; losing it before the append writes nothing, and losing it after the append
  withholds the snapshot (recovery reconciles the receipt). A lock is dead only if its holder's pid is gone (`kill(pid, 0)`
  says ESRCH), never because of its age; a dead lock is broken by rename with a nonce re-check, and a newer lock caught by
  the rename is put back. Acquisition is bounded (3 s by default); a timeout writes nothing and says so (503).

## The station component: its shape

A seat is a socket entity with a `station` component (`shared/sockbody.js`; the registry entry is
`shared/protocol/componentspec.js` `station`). The older spelling, a `body` block on `socket` / `sockets.<name>`, is
still read; the door lifts a write of it into socket children with stations.

Registered today (the station's core):

| field | absent means | what it is |
|---|---|---|
| `action` | `sit` | the verb `use` calls it, and the default posture: sit, lie, stand, ride, drive, kneel, … |
| `anim` | picked from `action` at write: sit, ride and drive `sitchair`; lie `lie`; kneel `sit`; stand `idle`; else `sitchair` | what the body holds: a pose or clip by name (an open name: one the body doesn't know is its default); `{clip, time?, offset?}`; or a blend `{by, clips, time?, offset?}`. A write of the old name `pose` is stored as `anim`. |
| `anchor` | `root` (where every seat put a body before anchors, so no existing seat moves) | the body point that lands on the socket: `root`, `hips`, `feet`, `head`, or `surface` (the socket is the seat's support plane; the body's measured seat contact lands on it) |
| `exit` | set down where they got on | `[x, y, z]` or `[x, y, z, yaw]` in the host's frame |
| `leaveBy` | moving, jumping or getting up all leave | `jump`, `menu` or `script`. `script` leaves only when the world lets go, but the occupant's escape always works (see above) |
| `who` | anyone who may use the host | a role id (that rank or above), `{permission}` or `{roles: [...]}` |

Reserved (`STATION_RESERVED`): the door refuses them, their names are held, and `bodyOf` still reads them generously so
each can return as an addition rather than a rewrite.

| field | shape | what it would do |
|---|---|---|
| `poses` | `{<name>: pose}` | a menu of named poses (`anim` is the default); the occupant picks one |
| `sync` | a group name | sockets sharing a group switch same-named poses together |
| `approach` | `[x, y, z, yaw]`, socket frame | where you are brought first, before `enter` carries you on |
| `enter`, `leave` | clip names | one-shot clips while carried on and off |
| `reach` | `{<chain>: {at, q?, part?, hint?, vr?}}` | IK targets in the thing's frame (or a part's, so they move with it); `vr` is `snap`, `track` or `near` |
| `look` | `{yaw: [min, max], pitch: [min, max], up}` | head limits in degrees, socket frame; `up` is `world` or `socket` |
| `input` | `{move: none\|drive\|walk, look: free\|aim\|locked}` | input published for the vehicle to consume; at most one `drive` per thing |
| `fromSeat` | `true` | you may move here from another seat without standing up |

`hold` (sparse bone overrides over the pose) is cut: `bodyOf` returns it empty.

Precedents the shape follows: one occupant per socket (VRChat Station, Roblox Seat); which body point lands on the socket
(Resonite AvatarAnchor); a pose that is a clip, a blend by state, or time locked to the thing's motion (Unreal and Godot
animation graphs, without the state machine: data says what the body does in a world state, scripts change the state);
IK targets parented to moving parts (Unity Two Bone IK, Unreal Control Rig); a per-limb VR policy (Resonite, VRChat
per-part tracking); exit locks (VRChat Disable Station Exit); input published as signals for the vehicle (Roblox
VehicleSeat's throttle and steer, without its physics-on-the-seat weakness); sync groups (AVsitter).
