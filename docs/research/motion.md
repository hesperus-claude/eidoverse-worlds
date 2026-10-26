# Motion: parameters, never frames

`client/lib/motion.js` (the evaluators are `client/lib/motioneval.js`) animates the world's moving parts.

## The decision

A `motion` component is PARAMETERS, never frames: the log stores "a pendulum with this amp, period and phase since t0", and
every client (live, joining late, replaying a fork) evaluates the same closed form f(params, t) at its own now, composed
onto the entity's logged base pose. Nothing integrates, nothing accumulates error, and everyone agrees with no ongoing
traffic. It is the sequencer-not-simulator rule applied to dynamics.

Rejected: streaming transforms (traffic for as long as a thing moves, and a late joiner or a replay sees whatever the
stream happened to carry), and integrating motion on each client (error accumulates, so clients drift apart).

Adding a type is adding a case to the evaluator. The server folds motions blindly; a client that doesn't know a type leaves
the thing at rest, and newer clients animate it.

## Types

| type | params | for |
|---|---|---|
| `pendulum` | `axis, pivot, amp, period, phase, damp, maxAmp, t0` | swings |
| `spin` | `axis?, pivot?, degPerSec \| period, phase?, t0` | windmills, carousels |
| `orbit` | `center?, radius, degPerSec \| period, phase?, face?, t0` | ferries, birds (`rateOf` is the one reading of the rate) |
| `oscillate` | `axis?, amp, period, phase?, t0` | back and forth along an axis (a sine): hover, buoys, pistons |
| `path` | `points, speed \| duration, loop?: loop \| pingpong \| once, face?, t0` | routes |

A whole thing's pendulum or spin turns about its `pivot` field, else the thing's `pivot` component, else its origin.

## Parts

A component keyed `motion:<slot>` whose value names a `node` (its name as the model file spells it) animates that one node
inside the thing's model instead of the whole thing, so a machine can have many moving parts (segmented exports name their
parts). The slot is `partSlot(node)` (`shared/protocol/names.js`): readers never parse it, they read `node`.

Frames: a part's `pivot` and `axis` are in the node's own frame (default pivot `[0, 0, 0]`, the node origin, where a hinge
usually lives); `oscillate`, `orbit` and `path` positions are in the node's parent frame. `measure` reports each part's
local centre and size in exactly this frame, so a local centre is a pivot candidate as it stands. When a part's motion is
removed, the part returns to its authored rest pose (set back at once, not eased).

Older spellings are still read: a keyed motion with no `node` names the node by its key's tag, and a whole `motion` with a
`part` field is that node's motion (`motionNode`). The maintenance command's shape repair rewrites both into today's
spelling (docs/MAINTENANCE.md).
