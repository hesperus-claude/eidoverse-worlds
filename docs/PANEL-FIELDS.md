# Panel field specs

`client/lib/panels.js` builds the client's schema-driven edit surfaces. A panel is a frame on desktop and a
laser-clickable quad in VR, and that stays true because a panel never owns bespoke DOM: it declares **fields**, a
serializable schema (plain JSON, no closures; actions are string keys), and a renderer builds them. Two renderers share
the schema and one dispatcher: `renderDOM(body, fields, edit)` for a desktop frame, and `renderCanvas(canvas, fields)`
for the VR quad, whose hit regions resolve a laser UV hit and dispatch the same `edit`. The per-type painters live in
`client/lib/widgets.js` (`WIDGETS`). (A mod's own panel, `eido.ui.registerPanel`, mounts its own DOM instead:
`docs/MODDING-UI.md`.)

**Every field must work without a keyboard:** numbers are steppers, actions are buttons, lists are rows. Free text is
desktop-only and is display-only on the quad, rather than summoning a floating keyboard.

## The dispatcher

`edit(k, value, field?, opts?)`. `field` is an axis index for `vec3`, so a multi-selection can set one component
without clobbering the others. `opts.live` is true while a drag is under way: preview locally, no log traffic. A call
without it ends the gesture and commits one verb.

## Field types

| `t` | fields | dispatches |
|---|---|---|
| `info` | `label, value` | nothing |
| `num` | `k, label, value, step = 0.1, dp = 2, min?, max?, softMin?, softMax?, unit?, deg?, compact?, drag?` | `edit(k, value)` |
| `vec3` | `k, label, value: [x, y, z], step = 0.1, dp = 2, link?` | `edit(k, [x, y, z], axis \| null)` |
| `text` | `k, label, value, placeholder?` (desktop only) | `edit(k, string)` |
| `ref` | `k, label, value: id \| null, arming?, filter?` | `edit(k)` arms the pick; the next thing clicked (a tree row or the thing in the world) commits `edit(k, id)`; a ✕ on a filled ref sends `edit(k, null)` |
| `btn` | `k, label, danger?, icon?` (an `icons.js` glyph before the label) | `edit(k)` |
| `pop` | `label, items: [{k, label, category?, hint?, disabled?}], icon?`: a button opening a searchable list (typing filters names and hints; recent picks first). Desktop only | `edit(item.k)` |
| `tiles` | `k, value, options: [{v, label, icon?, img?, hint?}], empty?`: a grid of tiles; the one whose `v` is `value` reads as armed (the owner decides whether clicking it again disarms) | `edit(k, v)` |
| `json` | `k, label, value: string, collapsed?` (desktop; the quad shows a one-line summary) | `edit(k, jsonText)` |
| `log` | `lines: [string], empty?`: a scrolling console tail; the quad shows the newest line | nothing |
| `range` | `k, label, value, min = 0, max = 1, step = 0.01, dp = 2, unit?`: a slider on both renderers | `edit(k, number)` |
| `list` | `k?, label, empty?, rows: [{id, label, sub?, active?, actions: [{k, label, danger?}]}]` | `edit(action.k, rowId)`, or `edit(k ?? 'row', rowId)` for the row |
| `check` | `k, label, value, hint?` | `edit(k, bool)` |
| `enum` | `k, label, value, options: [{v, label}]` | `edit(k, v)` |
| `color` | `k, label, value: 0xRRGGBB` | `edit(k, int)` |
| `group` | `k, label, open?`: a marker; rows up to the next marker belong to it, and a collapsed group skips them (a field with `unfold` shows anyway) | `edit('fold', k)` |
| `tree` | `k, rows: [{id, label, sub?, depth, active?, multi?, badges?, locked?, menu?, kids?, open?, dim?, rename?}], rootDrop?, menu?` | below |

**`tree`.** A click sends `edit(k, id)`; Shift/Ctrl-click sends `edit(k, id, f, {extend: true})`. Dragging a row onto
another sends `edit('drop', {id, onto})`, onto empty tree space `{onto: null}`; `rootDrop` labels a strip at the tree's
foot, shown while a row is dragged, that drops `{onto: null}`. Right-click opens the row's `menu` (else the field's),
whose items send `edit(item.k, id)`. `kids > 0` draws a disclosure (`edit('open', id)`); the lock sends
`edit('lock', id)`. Double-click or the menu's `rename` edits the label inline and sends
`edit('rename', id, f, {value})`.

## Flags every field takes

- `disabled`: drawn read-only (a locked thing's pose).
- `driven`: names what owns the value (a motion composes onto this rest pose). It marks the **field**, not the label,
  so an axis label keeps its x/y/z colour and provenance and axis are readable at once: in the edit chrome, an amber
  edge and a `~` inside the field.
- `hint`: a tooltip, where the widget shows one.
- `vrOnly`: painted on the quad only, skipped on desktop (a button standing in for a key a headset lacks).
- `def`: the value ↺ reverts to; drawn for `num`, `enum`, `color` and `range`, never on a pose key (`pos.`/`rot.`).
- `dim`: a secondary row (an id beside its name).

## Number entry (desktop)

Drag the number to scrub. The value is always start + `scrubTravel(distance)` × (`drag` ?? step × 0.2), never accumulated, so a drag that wanders
comes back to exactly where it began (the shape of Godot's `EditorSpinSlider`; Blender's #37453 drift is the failure
this avoids). Shift scrubs at 0.1×, Ctrl snaps to whole units, Esc mid-drag restores the start value; the arrow keys
step by `step` (× 10 with Shift). A click without travel focuses the box to type, and typed entry takes relative math
as Maya does (`shared/editschema.js` `parseEntry`): `+=2`, `-=.5`, `*=-1`, `/=2`, `+=10%`. Soft limits
(`softMin`/`softMax`) bound the drag; hard limits (`min`/`max`) bound the drag, the arrow keys and the ± buttons. A
typed value is sent as typed; the edit schema refuses one outside the component's range.
