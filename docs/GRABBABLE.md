# The grabbable component

What a hand may do with a thing. The registry entry is `shared/protocol/componentspec.js` `grabbable` (fields, defaults,
ranges); `shared/grab.js` reads it: the authority validates with `checkGrabbable`, and the browser, the door and the agent
read with `grabOf`. Defaulted fields are written on every write; an older value without one reads as its default.

| field | absent means | what it is |
|---|---|---|
| `enabled` | `true` | can it be picked up now (false: a dynamic ball you can only kick) |
| `who` | `inhabitant` | who may pick it up: a role id (that rank or above), `{permission}` or `{roles: [...]}` |
| `steal` | `true` | may someone take it from a holder's hand; an owner always may |
| `range` | 1.5 m | how far from the hand, 0.1..10 m. Past the hand's reach (1.5 m, `physconst.js` `REACH`) the grab is granted as a pull: the thing flies to the hand |
| `priority` | 0 | -10..10: wins over lower when several things are in reach |
| `hold` | `auto` | `auto` (press-to-hold in VR, sticky on desktop and phone), `press` or `toggle` |
| `anim` | by size: one hand under 0.5 m, both arms at or above; both hands if `twoHanded` | how a body without tracked hands holds it: a pose or clip by name, open. Built in: `hand`, `carry`, `torch`, `pistol`, `shoulder` (`HOLD_POSES`); a name the body doesn't know is its default hold by size, never a refusal. A write of the old name `pose` is stored as `anim` (`two-hand` as `twoHanded: true`) |
| `grips` | held where it was grabbed | `{<name>: {pos, q?, hand?, role?, grasp?, part?}}`: where the PALM goes, in the thing's own frame (+Z out of the palm, +Y along the fingers' base). `hand` is `left`, `right` or `either`; `role` is `primary` or `secondary`; `grasp` is `fist`, `pinch`, `point`, `flat`, `open` or `trigger` (the old `fingers` is read as `grasp`) |
| `twoHanded` | `false` | a second hand on a secondary grip steers it (false: a second hand takes it over) |
| `carries` | `false` | a tray: what rests on it comes along when it is picked up (false: it falls off) |
| `throw` | 1 | 0..3: scales the release velocity (0: it can only be dropped) |
| `release` | `drop` | `drop`, `stay` (hangs where you let go) or `return` (goes home) |
| `returnAfter` | 0 s (never) | 0..3600 s: goes home after this long unheld |
| `fits` | it snaps into no socket | up to 8 keywords: released within a socket's radius (0.15 m unless the socket says), it snaps into a socket whose `accepts` shares one |
| `use` | the use button does nothing | a `reactions` action, or `{down, up}`: what the use button fires while it is held |
| `prompt` | "Pick up <its label>" | hover text, at most 40 characters |

Where a thing goes home to is its own `home` component (one home); the authority stamps one when a returning grabbable
(`release: return`, or a `returnAfter` above 0) is written without it. `fx` (presence-only particles while use is held) is
reserved: refused, its name held. A grip's bone overrides (`hold` on a grip) are cut.

## Precedents

Grabbing is its own component, apart from dynamics (Meta's physics-less hand grab, Resonite Grabbable, Horizon's
interaction vs motion split). A grip is a named point in the thing's frame (VRChat ExactGrip, Unity Attach Transform, Godot
GrabPoint); no grip means it is held where it was grabbed (Unreal's free grab). Use-while-held is its own button with a down
and an up (VRChat OnPickupUseDown/Up, Unity Activated). Theft, who may and reach are per thing (VRChat Disallow Theft,
Horizon Who Can Grab, VRChat Proximity). A release can snap into a socket that accepts it (Resonite Snapper, XRI Socket,
Godot SnapZone) or go home.
