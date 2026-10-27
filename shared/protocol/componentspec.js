// shared/protocol/componentspec.js — the component types a builder can discover: fields, defaults, ranges and help (the
// lab's hand-written models are shared/protocol/labmodels.js). Every parameter is written down (PROTOCOL §4): the authority
// materializes `defaults` and each `when` rule into the stored value, so a renderer never supplies a number the log lacks
// and a changed default never changes an old world; a changed default, type or enum is a changed meaning (spec/registry-pin.json,
// D8). A field's type, default, range, unit and doc are written HERE only; descriptors.js, components.js, editschema.js,
// worldentity.js and the `schema` request derive from it (tools/schema-layers-test.ts). units and docs aren't pinned.

// how two touching surfaces' coefficients combine: the modes PhysX, Unity and Rapier name (Jolt and Box2D take a callback),
// so every engine can carry them; when two differ, the later in this list wins (PhysX's and Unity's priority)
import { RANK, BUILTIN_IDS, PERMISSION_NAMES, CUSTOM_ID, RESERVED_IDS } from "./roles.js";
export const COMBINE = ["average", "min", "multiply", "max"];
export const COMPONENTS = {
  // glTF's node TRS (physics-motion §1): local = T · R · S, world = parent's world × local (PROTOCOL §9.3). The door's limits,
  // pinned: pos within ±1e5 m, each scale within ±1e3 and at least 1e-4 from zero (a negative one mirrors; physics reads
  // |scale|, KHR_physics_rigid_bodies' rule)
  transform: { status: "trial", on: "thing", fields: { pos: "vec3", q: "array", scale: "vec3" }, defaults: { pos: [0, 0, 0], q: [0, 0, 0, 1], scale: [1, 1, 1] }, units: { pos: "m", scale: "×" },
    ranges: { pos: { min: -1e5, max: 1e5 }, scale: { min: -1e3, max: 1e3 } },
    docs: { pos: "where it stands, [x, y, z] in metres, in its parent's frame (the world's when it has no parent)", q: "its orientation, a unit quaternion [x, y, z, w] (glTF order), in its parent's frame; normalized on write", scale: "its size per axis, [x, y, z] (1 = as made), each within ±1000 and never within 1e-4 of zero; a negative one mirrors (physics reads its size, |scale|)" },
    help: "where it is, glTF's node TRS: pos (m), q (unit quaternion [x, y, z, w]), scale [x, y, z], all in its parent's frame. Composed as glTF composes a node: local = T · R · S, world = parent's world × local (PROTOCOL §9.3)" },
  // a model is its LIBRARY PATH, stored as written (portable wherever the library exists); model-hash goes beside it, never
  // instead. An older content address (eido:sha256/<hex>) still loads where the index knows it; the repair writes its path back.
  model:     { status: "trial", on: "thing", type: "string", help: "which model it shows: its library path (eidoverse/assets/models/…glb, store/<hash>.glb; a name from find {kind: 'model'} gives one), stored as written. The server stamps model-hash beside it when it knows the file's bytes. An older eido:sha256/<64 hex> address still loads where this host can find its bytes" },
  // the bytes a model's path named when written (like an npm lock's integrity): optional, never the reference. Stamped by the
  // authority from its catalogue (server/modelcatalogue.ts), dropped when the model changes to one it can't hash.
  "model-hash": { on: "thing", type: "sha256", writtenBy: "server",
               help: "set by the server beside model (never by hand below owner): sha256:<64 hex> of the original bytes its library path named when it was written (the file in the library, never an optimized copy). An integrity and version fact only: readers load the path; absent, nothing is lost" },
  label:     { on: "thing", type: "string", maxLen: 80, help: "its display name, a short string (its name to every reader: the accessible name; description says what it is)" },
  // the accessibility model's name / description / role+state: label the name, description the alt text; what it can do and
  // its state are GENERATED (shared/a11y.js), so a description never restates them; long-form is story's
  description: { on: "thing", type: "string", maxLen: 500, cleanAs: "lines",
               help: "how it is described to anyone who reads rather than sees it (alt text), a sentence or two of plain text (≤ 500): what it is and what it looks like. Its name is label. What it can do and its state (it opens, it's locked, it can be picked up or sat on, it's playing…) are read out from its components, so don't restate them here; why it is here, as a titled placard, is story. A visible nameplate isn't a component: it's a child thing (parent {to: this}) with text {text, billboard: 'yaw'}" },
  // the collision shape every client and the authority's solids honour (shared/editschema.js Collider), and the caption bot's
  // speaker mark. `mesh` is shapes.js's word (`exact` is taken at write, stored as mesh); the physics stamp (authority
  // shapeFor) and the walker (client/lib/colliders.js) read its absence differently
  collider:  { on: "thing", fields: { shape: "string" }, enums: { shape: ["mesh", "box", "sphere"] },
    docs: { shape: "mesh = its triangles (to walk on; physics collides a mesh as its box, PhysX's rule for a dynamic body, and eidosim carries boxes), box = its bounding box, sphere = a ball (rolls, under an engine that carries spheres); remove the component to let its size decide" },
    absentMeans: { shape: "its size decides, for each reader: physics collides it as its measured box; walking uses its triangles (mesh) when it is room-scale (footprint ≥ 16 m² and ≥ 2.2 m tall) or floor-shaped and uneven (footprint ≥ 2 m², ≤ 1.0 m tall, its box top > 0.10 m above its surface), else its box (shared/supportclass.js)" },
    help: "how it collides: {shape: mesh (its triangles: walked on as they are; physics collides it as its box) | box (its bounding box) | sphere (a ball: under an engine that carries spheres it rolls; the authority fits one to its box)}; absent, its size decides (a room-scale or uneven floor-shaped thing walks as its mesh, else its box; physics uses its box). exact, the old word for mesh, is taken and stored as mesh" },
  stage:     { on: "thing", fields: { speaker: "string" }, ranges: { speaker: { maxLen: 80 } }, docs: { speaker: "who is speaking here, a name (≤ 80; the caption bot's mark, WebVTT's <v Name>)" },
    absentMeans: { speaker: "no stage cue: the caption bot uses its own speaker" }, help: "the caption bot's stage mark: {speaker?: who is speaking here, a name ≤ 80}" },
  // a lock is just true. Its strength is its setter's rank NOW (read from the log), so anyone at that rank or above may lift
  // it or act through it (throughLock), the padlock asking first. A stored {rank} still reads as locked.
  lock:      { on: "thing", type: "bool", help: "true: an edit lock (PROTOCOL §7, Locks). Nobody, its locker and owners included, may move, replace or delete it, or anything attached to it, without throughLock: true; edits that don't relocate it (label, light, motion, reactions…) stay open. Anyone at the rank its setter holds now, or above, may lift it or act through it. Delete it to unlock" },
  hidden:    { on: "thing", type: "bool", help: "true: not drawn by any client (it's still there: it collides, look and inspect list it). Delete it to show the thing again; false reads the same as absent" },
  clickthrough: { on: "thing", type: "bool", help: "true: a pointer click passes through it to whatever is behind (it is still drawn, collides, and can be grabbed by a hand or a tool; the editor still selects it). Delete it to make it a click target again; false reads the same as absent" },
  disabled:  { on: "thing", type: "bool", help: "true: switched off. It stays in the record and the Hierarchy, but no client loads or draws it, it has no collider and no physics, and nothing may grab, punt, use or sit on it; what hangs under it is switched off with it. Delete it to switch the thing back on; false reads the same as absent" },
  // the one hinge (physics-motion §3): a whole thing's motion, openable and the gizmo all turn about it; a part's motion
  // carries its own (motion:<part>.pivot, in the part's frame), since a part can't carry components
  pivot:     { on: "thing", fields: { pos: "vec3" }, required: ["pos"], units: { pos: "m" }, ranges: { pos: { min: -1e4, max: 1e4 } },
    docs: { pos: "the point it turns and scales about, [x, y, z] metres in its own frame before scale" },
    absentMeans: { pos: "it turns and scales about its origin, [0, 0, 0]" },
    help: "{pos: [x,y,z]}: where it turns and scales from, in its own frame before scale ([0,0,0] = its origin). Never moves it or changes how it draws. A whole thing's motion and openable turn about it; absent, about its origin" },
  // attaching to a NAMED point on the parent (Unreal SocketName, Roblox Attachment): socket names one of its sockets.
  // `order` is dropped at write: nothing sorted by it; a sibling order returns as an addition when a reader needs one.
  parent:    { status: "trial", on: "thing", fields: { to: "ref", socket: "string" }, required: ["to"], legacy: ["socket"], dropped: { order: "sibling order: read by nothing (every stored value was \"a0\")" },
    docs: { to: "the thing it rides: its transform becomes local to this parent", socket: "the old spelling of a socket attachment: parent to the socket child instead" }, help: "{to: id}; its transform becomes local to the parent. To attach at a socket, parent to the socket (a child entity of its host). socket: the old spelling, read in old logs and lifted at the door" },
  // the punctual light every engine shares (KHR_lights_punctual): a spot's cone is HALF-angles in radians, along local -Z.
  // decay is part of the value (2 = inverse square, intensity in candela); an older light fell off at three.js 1.7 and the
  // repair writes 1.7 to keep its look. day is daytime: dim | full.
  light:     { on: "thing", fields: { kind: "string", color: "int", intensity: "number", range: "number", angle: "number", inner: "number", decay: "number", important: "bool", daytime: "string" },
    defaults: { kind: "point", color: 0xffd9a0, intensity: 16, range: 10, decay: 2, important: false, daytime: "dim" }, enums: { kind: ["point", "spot"], daytime: ["dim", "full"] },
    dropped: { shadows: "read by nothing (it returns when the light rig reads it; absent = no shadows)", day: "renamed daytime: 'dim' (true) | 'full' (false); a write of day is taken and stored as daytime" },
    when: [{ if: { kind: "spot" }, set: { angle: Math.PI / 4, inner: 0 } }],
    ranges: { color: { min: 0, max: 0xffffff }, intensity: { min: 0 }, range: { gt: 0 }, angle: { gt: 0, max: Math.PI / 2 }, inner: { min: 0, max: Math.PI / 2 }, decay: { min: 0, max: 4 } },
    units: { range: "m", angle: "rad", inner: "rad" },
    absentMeans: { decay: "1.7: the falloff exponent the light rig used before it was written (three.js decay); a value stored before 10-16 is repaired to 1.7 at its first load",
      daytime: "dim: it follows the day cycle (an older value's day: false meant full)" },
    docs: { kind: "point (shines every way) or spot (a cone along its -Z)", color: "its colour, 0xRRGGBB, sRGB", intensity: "how bright it is: candela at decay 2 (KHR_lights_punctual); three.js units under this light's decay otherwise", range: "a hard cutoff, metres: nothing beyond it is lit", angle: "a spot's cone half-angle, radians",
      inner: "where a spot's edge starts to soften, radians", decay: "how it falls off with distance, an exponent: 2 = inverse square (physical, glTF), 0 = not at all", important: "always casts: first claim on a light slot, never governor-shed", daytime: "dim (it dims by day, follows the day cycle) | full (it burns at noon too)" },
    help: "a light on this thing: {kind: point|spot, color (0xRRGGBB, sRGB), intensity (candela at decay 2), range (m, a hard cutoff), decay (falloff exponent, default 2 = inverse square), important, daytime: dim|full}; a spot shines along the thing's -Z with angle (its cone's half-angle, rad, default π/4) and inner (where the edge starts to soften, rad, default 0). day (true/false) is taken and stored as daytime" },
  // a parametric body on a model-less thing, base-centred like a measured model (y runs 0..size[1]). Registered bare: the
  // authority needs its size to place, stack and stamp physics. Coloured through its 'surface' slot (hesperus/material).
  mesh:      { on: "thing", fields: { shape: "string", size: "vec3" }, defaults: { shape: "box", size: [1, 1, 1] }, enums: { shape: ["box", "sphere", "cylinder", "plane", "capsule"] },
    ranges: { size: { min: 0.05, max: 200 } },   // a vec3's range holds for each element (valueCheck)
    // pinned facts: where it stands on its origin, and what a primitive does with the axes it ignores
    absentMeans: { origin: "the centre of its base: it stands on its own origin (every referent centres primitives; ours stands, as a model does)", ignored: "a sphere ignores size[1] and size[2], a cylinder and a capsule size[2], a plane size[1]" },
    units: { size: "m" }, docs: { shape: "box, sphere, cylinder, plane (flat on the ground, drawn on both sides) or capsule; it stands on its own origin", size: "its size [x, y, z] in metres; a sphere reads x as its diameter, a cylinder or capsule x as diameter and y as height, a plane x × z" },
    help: "a parametric body drawn without a model: {shape: box|sphere|cylinder|plane|capsule, size: [x, y, z] (m, each 0.05..200)}. Its origin is the centre of its base (it stands on its own pos, as a model does). A sphere reads size[0] as its diameter; a cylinder and a capsule read size[0] as diameter and size[1] as height (a capsule is at least its diameter tall); a plane is size[0] × size[2] on the ground plane, 0.05 thick (it collides as a thin slab; things rest on it at 0.05), drawn on both sides. Never on a thing with a model or a light (one place per thing: give it a child). Its one material slot is 'surface' (hesperus/material:surface)" },
  // the closed forms every client and the agent evaluate (client/lib/motioneval.js): rates in °/s or a period in s; a path
  // is control points with a speed or duration and a loop mode. Defaults are motioneval.js's readings, written down. A
  // node's motion is motion:<slot> {node} (the name is DATA, never part of a key); axes stored as vectors.
  motion:    { on: "thing", keyed: "optional", when: [
                 { if: { type: "pendulum" }, set: { axis: [1, 0, 0], period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 } }, { if: { type: "pendulum" }, absent: ["amp"], set: { amp: 0 } },
                 { if: { type: "spin" }, set: { axis: [0, 1, 0], phase: 0 } }, { if: { type: "spin" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 36 } },
                 { if: { type: "orbit" }, set: { radius: 3, phase: 0, face: true } }, { if: { type: "orbit" }, absent: ["degPerSec", "period", "rpm"], set: { degPerSec: 12 } },
                 { if: { type: "oscillate" }, set: { axis: [0, 1, 0], period: 4, phase: 0 } }, { if: { type: "oscillate" }, absent: ["amp"], set: { amp: 0.3 } },
                 { if: { type: "path" }, set: { loop: "loop", face: true } }, { if: { type: "path" }, absent: ["speed", "duration"], set: { speed: 1 } }],
               fields: { type: "string", axis: "axis", amp: "number", period: "number", damp: "number", maxAmp: "number", phase: "number", t0: "number", radius: "number", degPerSec: "number", pivot: "vec3",
                 center: "vec3", face: "bool", points: "array", speed: "number", duration: "number", loop: "string", node: "string" }, required: ["type"], enums: { type: ["pendulum", "spin", "orbit", "oscillate", "path"], loop: ["loop", "pingpong", "once"] },
               dropped: { amplitude: "the first protocol's spelling of amp (repaired to amp)", part: "a node's motion is motion:<slot> {node: <its name>} (repaired to that: the slot is shared/protocol/names.js partSlot of the name)" },
               ranges: { node: { maxLen: 256 }, period: { gt: 0, max: 3600 }, degPerSec: { min: -36000, max: 36000 }, radius: { min: 0, max: 10000 }, speed: { min: 0, max: 1000 }, duration: { gt: 0, max: 36000 } },
               units: { amp: { pendulum: "rad", oscillate: "m" }, period: "s", degPerSec: "°/s", radius: "m", speed: "m/s", duration: "s", pivot: "m", center: "m", phase: "rad", maxAmp: "rad", damp: "1/s", t0: "ms" },
               docs: { type: "pendulum | spin | orbit | oscillate | path (oscillate: back and forth along its axis, a sine)", axis: "the axis it moves about or along, a direction [x, y, z] in its own frame (x, y, z, -x, -y or -z is taken and stored as one)", amp: "how far it swings (a pendulum: radians) or travels each way from where it stands (an oscillate: metres)", period: "seconds for one swing, one turn or one lap",
                 damp: "how fast a swing dies down, 1/s; 0 swings forever", maxAmp: "the most a push may swing it, radians", phase: "where in its cycle it starts, radians", t0: "when it started, epoch ms on the authority's clock (the authority stamps it)",
                 radius: "the circle's radius, metres", degPerSec: "degrees a second (a lap of 30 s is 12°/s)", pivot: "a part's motion only: the point the part turns about, metres in the part's own frame (a whole thing turns about its pivot component)", center: "what it circles, in its parent's frame (absent: where it stands)",
                 node: "a keyed motion only (motion:<slot>): the node of its model it moves, its name exactly as the model file spells it (any characters: data, never part of the key; the key's <slot> is a short tag of your choosing, the editors' is partSlot of the name)", face: "turns to face along the way it moves", points: "the path's control points, 2–64, in its parent's frame", speed: "metres a second along the path", duration: "seconds for the whole path (instead of speed)", loop: "loop | pingpong | once" },
               // what an older value WITHOUT a field reads as (each is materialized on write now; an older or translated value
               // can lack them): motioneval.js's readings, written down
               absentMeans: { period: "pendulum: 3.5 s; spin and orbit: their degPerSec; oscillate: 4 s", damp: "0: it swings forever", amp: "pendulum 0 (still); oscillate 0.3 m", axis: "pendulum [1, 0, 0]; spin and oscillate [0, 1, 0]",
                 pivot: "a part turns about its own origin; a whole thing (which never holds one) about its pivot component, else its origin [0, 0, 0]", phase: "0", maxAmp: "0.9 rad", degPerSec: "spin 36°/s, orbit 12°/s (when no period either)", radius: "3 m",
                 center: "where it stands", face: "true", speed: "1 m/s (when no duration either)", duration: "speed decides", loop: "loop", t0: "the reader's own first look (a value from before t0 was stamped)", node: "a keyed motion: the node its key's tag names (the reading before 10-16, when the key was the node's name); the door writes that down. A whole motion never has one", points: "fewer than 2 points: it stands still" },
               help: "{type, …} (the authority stamps t0, epoch ms): pendulum {axis [x,y,z] (own frame), amp (rad), period (s), damp (1/s), maxAmp, phase} swings about its pivot component (absent: its origin); spin {axis, degPerSec (degrees a second) or period (s a turn), phase} turns steadily about its pivot; orbit {radius (m), center? [x,y,z] (in its parent's frame; default where it stands), period (s a lap) or degPerSec, face? (false: keeps its own heading), phase} circles in its parent's XZ plane about +Y; oscillate {axis, amp (m), period (s), phase} moves back and forth along its axis (a sine: amp each way, one period a cycle; the default axis is up, a float); path {points [[x,y,z], …] (2–64, in its parent's frame), speed (m/s) or duration (s), loop?: loop|pingpong|once, face?} follows its points. A node of its model moves instead as motion:<slot> {node: <the node's name, as the file spells it>, …}, whose pivot? [x,y,z] (the part's own frame) is its hinge; <slot> is any short tag [a-z0-9-] (the editors write the name itself when it is one, else a sanitized form with a hash: tripo_part_3 → tripo-part-3-c9dc783a)" },
  // the first spelling of attachment points: a map on the host. Reserved and lift-only: nothing stores it; the door lifts a
  // write of it into socket children (each body block a station on its child), and the maintenance command lifts a stored
  // world's. The name is held so it can't come back meaning something else.
  sockets:   { status: "reserved", on: "thing", map: "object", lifted: "socket children + their stations (lifted at the door)", instead: "socket children: create {components: {parent: {to: <host>}, transform, socket: {name, accepts?, radius?, part?}, station?: {action, anim, anchor, exit?, leaveBy?, who?}}}", help: "reserved, lift-only: the old spelling of sockets (socket children now: the door lifts a write of it into socket children, each body block a station on its child, and the maintenance command lifts a world stored with it): {<name>: {pos: [x,y,z] (its own frame), q? [x,y,z,w] (its rotation: a rocket seat lies on its back), part? (a model node it rides), accepts? [keywords] + radius? (m, default 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in (a key on its hook, a sword in its rack), body?: what a person's body does there: {action ('sit'; what 'use' calls it), anchor (root, the default | hips | feet | head: the body point on the socket), pose (a clip; {clip, time: 'phase'}; or a blend {by: 'speed'|'steer'|…|'param.<name>', clips: [[0,'idle'],[2,'walk']]}), poses {<name>: pose} + sync, approach [x,y,z,yaw], enter/leave (clips), exit [x,y,z], reach {leftHand: {at, q?, part?, hint?, vr: snap|track|near}}, hold {<bone>: q}, look {yaw: [min,max]°, pitch, up: world|socket}, input {move: none|drive|walk, look: free|aim|locked} (one drive per thing), leaveBy (jump|menu|script), fromSeat, who (builder|owner)}}}" },
  // an attachment point as an entity of its own (Godot Marker3D, Unity child Transform), a child of its thing, scale 1.
  // ONLY the attach point: what a body does there is the sibling `station`. Seat if station, snap point if accepts.
  socket:    { on: "thing", fields: { name: "string", part: "string", accepts: "array", radius: "number" }, required: ["name"],
               ranges: { accepts: { maxItems: 8 }, radius: { min: 0.02, max: 1 } }, units: { radius: "m" },
               absentMeans: { part: "it rides its host's root, not a moving node of the host's model", accepts: "nothing snaps in by fits", radius: "0.15 m (read only with accepts)" },
               docs: { name: "letters, digits, - and _ (≤ 32), unique among its host's sockets: what use {args: {socket}} names", part: "a node of its host's model it rides", accepts: "keywords (≤ 8): a released thing whose grabbable.fits shares one snaps in",
                 radius: "how near a released thing must be to snap in, metres", occupancy: "it holds one thing or one body at a time", attach: "who may attach: a thing, whoever may edit that thing's parent, or whoever releases a fitting grabbable within radius; a person, by using its station (station.who)" },
               help: "an attachment point on its parent (its host): {name (letters, digits, - and _, unique among the host's sockets; what use {args: {socket}} names), part? (a node of the host's model it rides), accepts? [keywords, ≤ 8] + radius? (m; absent, 0.15): a thing released within radius whose grabbable.fits shares a keyword snaps in}. Its pose is its transform (local to the host; scale 1). It holds one thing or one body at a time. A person attaches by using it when the same entity has a station. It carries nothing else but station, label, description, disabled, lock and motion. Things attach with parent {to: <its id>}" },
  // what a person's body does at a socket (VRChat Station, Resonite AvatarAnchor, Roblox Seat), beside `socket`. The rest
  // of the shape is reserved (STATION_RESERVED; docs/COMPONENT-LADDER.md). anim is an OPEN name of a pose or clip; one
  // the body doesn't know is its default, never a refusal. Materialized on write, so editing the table never re-poses a seat.
  station:   { on: "thing", fields: { action: "string", anim: "any", anchor: "string", exit: "array", leaveBy: "string", who: "any" },
               defaults: { action: "sit", anchor: "root" },
               when: [{ if: { action: "sit" }, set: { anim: "sitchair" } }, { if: { action: "ride" }, set: { anim: "sitchair" } }, { if: { action: "drive" }, set: { anim: "sitchair" } },
                 { if: { action: "lie" }, set: { anim: "lie" } }, { if: { action: "kneel" }, set: { anim: "sit" } }, { if: { action: "stand" }, set: { anim: "idle" } }, { absent: ["anim"], set: { anim: "sitchair" } }],
               enums: { anchor: ["hips", "feet", "head", "root", "surface"], leaveBy: ["jump", "menu", "script"] }, units: { exit: "m" },
               absentMeans: { exit: "set down where they got on", leaveBy: "moving, jumping or getting up all leave", who: "anyone who may use the host", anim: "the action's default, materialized at write (sit/ride/drive sitchair, lie lie, kneel sit, stand idle); a value stored before 10-17 says pose, renamed anim at load" },
               dropped: { pose: "renamed anim (R 10-17): a write of pose is taken and stored as anim; a stored one is renamed by the world's maintenance command" },
               docs: { action: "the verb use calls it (sit, lie, ride, stand…): a label; at write it picks the default anim", anim: "what the body holds: a pose or clip by name (an open name: one the body doesn't know is its default); {clip, time?: loop|phase, offset?}; or a blend {by: <signal>, clips: [[key, clip], …], time?, offset?}",
                 anchor: "the body point that lands on the socket: root (where every seat put a body), hips, feet, head, or surface (the body's measured seat contact)", exit: "where they're set down, [x, y, z] or [x, y, z, yaw] in its host's frame", leaveBy: "jump | menu | script: how the occupant may leave (script: only when the world lets go; the occupant's escape, a held get-up or a second one, always works)", who: "who may take it: a role id (this rank or above)" },
               reservedFields: ["poses", "sync", "approach", "enter", "leave", "reach", "look", "input", "fromSeat"],
               help: "what a person's body does at this socket (only on a socket entity): {action (default sit: what use calls it), anim (a pose or clip by name, open: one the body doesn't know is its default; {clip, time?, offset?}; or a blend {by, clips}; absent, picked from the action at write: sit/ride/drive sitchair, lie lie, kneel sit, stand idle, else sitchair), anchor (root, the default | hips | feet | head | surface), exit? [x, y, z(, yaw)] (its host's frame), leaveBy? (jump | menu | script; absent, any way; script makes leaving deliberate, never impossible: holding X ~1.5 s, a second get-up, or an agent's detach {escape: true} always gets the occupant up), who? (a role id: this rank or above)}. Reserved for later (refused now): poses, sync, approach, enter, leave, reach, look, input, fromSeat" },
  // where a thing goes back to, in its home parent's frame: the ONE home (a reset and a grabbable's return read it)
  home:      { on: "thing", refPaths: { "parent.to": "ref" }, fields: { pos: "vec3", q: "array", scale: "vec3", parent: "object" }, required: ["pos"],
               absentMeans: { scale: "its size in the world is kept as it is when it goes home", q: "no turn: [0, 0, 0, 1]", parent: "goes home under no parent (the world root)" }, units: { pos: "m" },
               docs: { pos: "where it goes back to, [x, y, z] in its home parent's frame", q: "which way it faces at home, [x, y, z, w]", scale: "its size at home, [x, y, z] (1 is the model as made); a number is taken and stored as one", parent: "what it hangs under at home: {to}" }, help: "where it goes back to when a reset sends it home, or a grabbable returns: {pos: [x,y,z], q?: [x,y,z,w], scale? [x,y,z] (else its size in the world is kept), parent?: {to}} (its home parent's frame). Stamped where it stands when a reset handler naming it, or a returning grabbable, is written without one" },
  // named places to walk to: a closed entry, checked at the door (a seat is a station, a door a reading of the model).
  // Frame: the thing's full transform (pos, q, scale); on @world, world coordinates.
  places:    { map: "any", keyPattern: "^[A-Za-z0-9_][A-Za-z0-9_ .:'-]{0,47}$", units: { at: "m", min: "m", max: "m" },
               docs: { at: "a spot to stand, [x, y, z] in the thing's own frame (its y the floor there)", min: "a room's low corner (its y the floor)", max: "a room's high corner", label: "how it reads, ≤ 80 characters" },
               help: "{<name>: {at: [x, y, z]} | {min: [x, y, z], max: [x, y, z]} | null}, each with label? (how it reads, ≤ 80); nothing else: named places to walk to (move {to: '<thing>/<name>'}, or the name alone), in the thing's own frame so they move with it (on @world: world coordinates, places that belong to no thing). at is a spot to stand (its y the floor there); min/max a room (its min y its floor; look says which room you're in); null hides a place the model's own file declares (its glTF extras `building`). name_place {name} names the spot where you stand" },
  // the ONE signal store a thing exposes to bodies on it (no param.* keys in other components): a seat pose blends by
  // param.<name>; scripts write world.param
  params:    { on: "thing", map: "number", keyPattern: "^[a-z][a-zA-Z0-9_-]{0,31}$", maxKeys: 64, help: "{<name>: number}: up to 64 named numbers this thing exposes (a name: a lowercase letter, then letters, digits, _ or -, up to 32). A socket's pose blends by one as the signal param.<name>; a script writes one with world.param(id, name, number)" },
  // handler kinds are FROZEN and pinned with their args (an action set that grows without end ends in a break); anything
  // new is a script. `impulse` is reserved. One action namespace per thing: a reaction key never equals a station action.
  reactions: { refPaths: { "*.targets": "refs" }, help: "{<action>: handler}: what happens when someone uses it. Each handler may add who: a role id (who may use it: that rank or above) and fix: text (shown on refusal). The kinds are fixed: toggle, set, script, play, reset (anything else is a script); impulse is reserved. An action never shares its name with a station action of the thing's own sockets.",
    handlers: {
      toggle: { args: { component: "the component to flip (default 'openable')", field: "the true/false field inside it to flip (default 'open' for openable; leave both out for an openable). A named component with no field flips its whole value. The component must be on the thing when the handler is written", unless: "a field of the same component that, when true, bars it (e.g. 'locked')" }, example: { open: { kind: "toggle", component: "openable", field: "open", unless: "locked" } } },
      set: { args: { component: "which component", field: "optional: the field inside it to set (the component must then be on the thing)", value: "the value it gets (checked when the handler is written, as the authority would check that write)" }, example: { bolt: { kind: "set", component: "openable", field: "locked", value: true, who: "builder" } } },
      // research 41 §3.1: the join between the two tiers. The action list, its `who` gate and its `fix` stay data; only the
      // effect is computed, by the script:<name> on the same thing, with its sponsor's rights narrowed to its scope
      script: { args: { script: "the name of a script on this same thing (its component is script:<name>)" }, example: { ring: { kind: "script", script: "bell" } } },
      // a doorbell plays its sound again from the top, playing or not (set can't restart it, toggle would stop it): the
      // authority writes sound {…, playing: true, t0: now}
      play: { args: {}, example: { ring: { kind: "play" } } },
      // a reset button: each thing remembers a home, a button lists what it sends home. Each target goes back to its home
      // component, out of any hand; a target with no home, gone or locked is skipped and named in the reply.
      reset: { args: { targets: "the ids it sends home: 1 to 64 things. Each needs a home (stamped where it stands when the handler is written, if it has none)" }, example: { reset: { kind: "reset", targets: ["ball-0", "ball-1"] } } },
    },
    // held names: a handler of one of these kinds is refused (reserved), never read
    reservedKinds: { impulse: "a push (strength m/s at its centre, or angular rad/s): reserved until this world's engine carries impulses; it had a pendulum-only meaning, and returns with its general one" },
    common: { kind: "the handler kind", who: "who may use it: a role id (builtin or this world's own), that rank or above; absent, anyone who may use the thing", fix: "text shown on refusal" } },
  // the behaviour is `openable` (a door, a gate, a lid, a hatch, a cabinet), not the asset: a turn about a hinge (angle about
  // axis, through the thing's pivot) or a slide, tweened over a time (Roblox TweenInfo's default 1 s). `open` is the state;
  // every client animates to it
  openable:  { on: "thing", fields: { open: "bool", locked: "bool", angle: "number", axis: "axis", slide: "vec3", time: "number", part: "string" },
               defaults: { open: false, locked: false, time: 1 }, when: [{ absent: ["slide"], set: { angle: Math.PI / 2, axis: [0, 1, 0] } }],
               ranges: { angle: { min: -Math.PI, max: Math.PI }, time: { min: 0, max: 10 }, slide: { min: -10, max: 10 } },
               units: { angle: "rad", slide: "m", time: "s" },
               docs: { open: "its state now; anyone using it flips this (its reactions); false reads the same as absent", locked: "bars opening while on (an open handler with unless: 'locked'): the door's own lock for the people using it; pinning it in place is the Lock component's; false reads the same as absent",
                 angle: "how far it turns when open, radians; negative turns the other way", axis: "the hinge axis in its own frame: y an upright hinge (a door), x a lid or a hatch", slide: "how far it moves when open, [x, y, z] metres in its own frame (instead of turning)",
                 time: "seconds to open or close", part: "a node of its model that moves instead of the whole thing" },
               help: "it opens and closes when someone uses it: a door, a gate, a lid, a hatch. {open: true/false (its state), locked? (true bars an open handler with unless: 'locked'; the edit lock is the separate `lock`), angle? (rad it turns when open, default π/2; negative turns the other way), axis? (its own frame, default [0,1,0]: an upright hinge), slide? [x,y,z] (m it moves in its own frame when open, instead of turning), time? (s to open or close, 0–10, default 1), part? (a node of its model that moves instead of the whole thing)}. It turns about its pivot (pivot {pos}: put it on the hinge edge). Usable with reactions {open: {kind: 'toggle', unless: 'locked'}} (toggle's default flips openable.open)" },
  // spec/PHYSICS.md §3.1–§3.2: shape has a grammar (shared/protocol/shapes.js). kind is REQUIRED (a bare {} is ambiguous
  // with absence, PROTOCOL §9.2); unread physical properties are RESERVED until an engine reads them (mass and density are
  // open: the shove reads them). `surface` names a surface:<name>. Angular velocity is w: [x, y, z] rad/s, world frame.
  physics:   { on: "thing", fields: { kind: "string", who: "any", shape: "any", mass: "number", density: "number" }, required: ["kind"],
    grammar: { shape: "shape" },   // `any` is the pinned type of every value ever stored; the grammar narrows what may be written
    enums: { kind: ["dynamic", "static", "none", "kinematic"] },
    when: [{ if: { kind: "dynamic" }, set: { who: "inhabitant" } }],   // shared/grab.js DEFAULT_WHO, written down
    // mass and density stay OPEN: the body shove reads them (shared/shove.js massOf: the authority's shove gate, the walker,
    // the agent). The other eight have no reader
    reservedFields: ["surface", "friction", "restitution", "frictionCombine", "restitutionCombine", "linearDamping", "angularDamping", "centerOfMass"],
    dropped: { layers: "32-bit collision layers: cut (filters return as named groups)", mask: "the layers it collides with: cut", ccd: "swept collision: cut (eidosim sweeps every body)", material: "renamed surface (it names a surface:<name>)" },
    ranges: { mass: { gt: 0, max: 1e6 }, density: { gt: 0, max: 1e5 } }, units: { mass: "kg", density: "kg/m³" },
    docs: { kind: "dynamic (falls, tumbles, can be pushed) | static (solid, never moves) | kinematic (moves only by its motion, an edit or a script, pushes others; what the authority stamps on a thing with motion or openable) | none (no collisions)", who: "who may punt it (and pick it up when it has no grabbable): a role id, this rank or above",
      shape: "its collision shape, measured from its model by the authority (you never send it)",
      mass: "how heavy it is, kg (a body's shove reads it; eidosim's flight doesn't yet); blank: its density × its size", density: "kg/m³; blank: water's (1000)" },
    absentMeans: {
      shape: "no measured shape: the thing is no body to the engine (it neither flies nor collides)",
      mass: "kg; absent, density × the volume of its stamped shape at its scale (shapes.js shapeVolume; shared/shove.js massOf). Today that shape is its measured bounding box, so a chair weighs as a solid box of its density; eidosim's flight computes the same (shared/sim.js: 1000 kg/m³ × its box) and reads no mass yet. Never a constant",
      density: "kg/m³; absent, its surface's density, else 1000 kg/m³ (water: eidosim's, shared/sim.js DENSITY)",
      // reserved fields (refused today): their absence is today's behaviour, and stays their meaning of absence
      surface: "a surface:<name> on @world; absent (or naming no surface there now), friction and restitution are its own fields', else the engine's own law",
      friction: "≥ 0, one coefficient (static = dynamic); absent, its surface's, else the engine's own law (eidosim: its fixed constants)",
      restitution: "0..1; absent, its surface's, else the engine's own law (eidosim: its fixed bounce)",
      frictionCombine: "average|min|multiply|max, how its friction meets another's (the later in that list wins, PhysX's priority); absent, its surface's, else average",
      restitutionCombine: "average|min|multiply|max, as frictionCombine; absent, its surface's, else max",
      linearDamping: "1/s; absent, the engine's own law (eidosim: none)",
      angularDamping: "1/s; absent, the engine's own law (eidosim: none; it doesn't spin)",
      centerOfMass: "[x, y, z] m in its own frame before scale; absent, the centroid of its stamped shape" },
    help: "how it takes part in physics: {kind (required): dynamic (it flies when thrown, dropped or punted; with no grabbable it can also be picked up) | static (a collider; what anything with a model becomes when the world runs physics) | kinematic (a collider moved only by edits and motion, never by the engine; it is never launched; what a thing with motion or openable is stamped) | none (nothing collides with it), who: who may punt it (and pick it up, when it has no grabbable; default inhabitant), shape: stamped by the authority (its measured box; you never send it)}. mass (kg; absent: density × its box's volume) and density (kg/m³; absent 1000), which a body's shove reads. Reserved until an engine reads them (refused now): surface (a surface:<name> on @world), friction, restitution (0..1), frictionCombine, restitutionCombine (average|min|multiply|max), linearDamping, angularDamping (1/s), centerOfMass [x,y,z]. Grabbable makes a thing carryable; physics makes it fall. With eidosim (gravity [0, −9.81, 0] m/s²): a thrown thing flies, tumbles, rolls if it's a sphere, and comes to rest; it knocks over dynamic things it hits unless a lock holds them (their own, or one on what they're under or what they hold)" },
  // what a hand may do with it: its own component, apart from dynamics (a key can be carried with no physics).
  // Defaults are shared/grab.js's, written down; those absent by meaning stay absent (grab-check pins them equal).
  grabbable: { on: "thing", fields: { enabled: "bool", who: "any", steal: "bool", range: "number", priority: "int", hold: "string", anim: "string", grips: "object", twoHanded: "bool", carries: "bool",
                 throw: "number", release: "string", returnAfter: "number", fits: "array", use: "any", prompt: "string" },
    // the shape lives here (grab.js derives its enums from these). Gone: home (the home component is the one home), a grip's
    // bone overrides (hold). Reserved: fx (refused; presence-only particles while use is held)
    enums: { hold: ["auto", "press", "toggle"], release: ["drop", "stay", "return"] },
    // anim: an OPEN name of a pose or a clip. Built in today: hand, carry, torch, pistol, shoulder (grab.js HOLD_POSES); one the
    // body doesn't know is the body's default hold (by size), never a refusal. two-hand is gone: twoHanded says it.
    dropped: { pose: "renamed anim (R 10-17): a write of pose is taken and stored as anim (two-hand as twoHanded: true); a stored one is renamed by the world's maintenance command" },
    reservedFields: ["fx"],
    // the defaulted fields are materialized on every write; an older value without one reads as its default (grab.js fill),
    // written down so the pin holds that reading too
    absentMeans: { enabled: "true: it can be picked up", who: "inhabitant", steal: "true", range: "1.5 m", priority: "0", hold: "auto", twoHanded: "false", throw: "1 (×)", release: "drop", returnAfter: "0 s: never",
      anim: "by size: one hand under 0.5 m, both arms at or above; both hands if twoHanded", grips: "held where it was grabbed", carries: "false: what rests on it falls off when it is picked up",
      fits: "it snaps into no socket", use: "the use button does nothing while it is held", prompt: "Pick up <its label>" },
    defaults: { enabled: true, who: "inhabitant", steal: true, range: 1.5, priority: 0, hold: "auto", twoHanded: false, throw: 1, release: "drop", returnAfter: 0 },
    // the hand's own rules (shared/grab.js checkGrabbable) refuse outside these; written here so the inspector reads one source
    ranges: { range: { min: 0.1, max: 10 }, priority: { min: -10, max: 10 }, throw: { min: 0, max: 3 }, returnAfter: { min: 0, max: 3600 }, fits: { maxItems: 8 }, prompt: { maxLen: 40 } }, units: { range: "m", throw: "×", returnAfter: "s" },
    docs: { anim: "how a body without tracked hands holds it: a pose or clip by name (hand, carry, torch, pistol, shoulder built in); one the body doesn't know is held by size", grips: "named places the palm goes, in its own frame: {pos, q?, hand?, role?, grasp?, part?}", carries: "true: what rests on it rides with it when it is picked up", fits: "keywords: it snaps into a socket whose accepts shares one", use: "what the use button fires while it is held: a reactions action, or {down, up}", prompt: "the hover text (≤ 40)", enabled: "off: nobody can pick it up for now (a loose ball can still be punted)", who: "who may pick it up: a role id (this rank or above): inhabitant (anyone), builder, owner or this world's own", steal: "on: someone else can take it out of a hand; off: it stays with its holder (owners may still take it)",
      range: "how far from the hand it can be picked up, metres; past arm's reach (1.5) it flies to the hand", priority: "when several things are in reach the highest wins: the key, not the table it sits on", hold: "auto (grip in VR, sticky on desktop) | press (only while gripping) | toggle (sticky everywhere: a tool)",
      twoHanded: "on: both hands may hold it at once (a rifle, a broom): the first carries, the second aims", throw: "how hard it flies when thrown: 1 is normal, 2 twice as fast, 0 can only be dropped", release: "drop (it falls or is set down) | stay (where you let go) | return (it goes home)",
      returnAfter: "left unheld this many seconds it goes home; 0 never" },
    help: "it can be picked up and carried (grab, put, drop, throw; a VR hand's grip; desktop T): {who?: a role id (default inhabitant), enabled? (false: not now), steal? (false: nobody takes it from a hand; owners may), range? (m from the hand, 0.1..10, default 1.5; past 1.5 it flies to you), priority? (-10..10: wins when several are in reach), hold?: auto|press|toggle, anim? (how a body without tracked hands holds it: a pose or clip by name; built in: hand, carry, torch, pistol, shoulder; one the body doesn't know, or none, is held by size), grips? {<name>: {pos, q?, hand?: left|right|either, role?: primary|secondary, grasp?: fist|pinch|point|flat|open|trigger, part?}} (where the palm goes, in its own frame; none: held where grabbed), twoHanded?, throw? (0..3, ×the release velocity; 0: drop only), release?: drop|stay|return, returnAfter? (s unheld, then it goes home), fits? [keywords] (snaps into a socket whose accepts shares one), use? (a reactions action, or {down, up}: what the use button fires while held), prompt? (hover text, ≤ 40)}; where it goes home to is its home component (stamped when a returning grabbable has none); fx is reserved. Grabbable makes it carryable; physics {kind: 'dynamic'} makes it fall. A dynamic thing with no grabbable is carryable by physics.who (the rule: absent grabbable, a dynamic thing reads as {who: physics.who})" },
  // two world settings the authority reads at decision time:
  "body-default": { on: "world", type: "string", choices: ["accept", "ask", "refuse"], help: "the consent switch an untouched body has in this world: accept (the default when absent), ask or refuse. A person's own switch and their answers for someone always win (PROTOCOL §5, Body consent)" },
  "keep-owner": { on: "world", type: "bool", help: "absent or true: the authority refuses a change that would leave this world with no owner ('last-owner'). false: an owner may leave it ownerless on purpose (the host operator can still mend it). Starter config, switched on" },
  // tickMs's range is the engine's (eidosim TICK_MS; tools/shape-physics-test holds them equal); build is the authority's
  // stamp. Gravity is the engine's own, not in the log.
  "physics-engine": { on: "world", fields: { engine: "string", tickMs: "int" }, required: ["engine"], defaults: { tickMs: 33 },
    ranges: { tickMs: { min: 16, max: 1000 } }, units: { tickMs: "ms" },
    docs: { engine: "the engine and its version, name@semver (eidosim@1.0.0); a request may name the engine alone (eidosim), and the authority stamps the version it carries. A version is what its conformance digests say it computes (spec/conformance/physics/)", tickMs: "milliseconds a step (33 = 30 steps a second)" },
    absentMeans: { gravity: "not a field: the engine's own (eidosim: [0, −9.81, 0] m/s², world frame)" },
    help: "on @world only (owner): the physics engine this world runs: {engine: 'eidosim' or 'eidosim@1.0.0', tickMs? (ms a step, default 33)}. Name no version and the authority stamps the one it carries. Gravity is the engine's own (eidosim: [0, −9.81, 0] m/s²). Delete it to turn physics off (refused while things are in flight)" },
  // spec/PHYSICS.md §3.2: a world's named surface materials (one name bundles a surface's physical numbers). Reserved
  // until an engine reads them. Combine modes are PhysX's/Unity's/Rapier's order; KHR resolves a mismatch the other way,
  // so an importer resolves per pair, never per mode.
  surface:   { status: "reserved", instead: "nothing yet: no engine here reads surfaces (eidosim's friction and bounce are its own constants)", on: "world", keyed: true, key: "instance",
               help: "reserved (refused until an engine reads surfaces): on @world, keyed by name, a surface material things name with physics.surface; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  // spec/PHYSICS.md §3.3: the constraint between two bodies is `physics-joint`; `joint` is the skeleton node, below. Both
  // reserved (one anchor can't carry the two frames engines use). parent is rigid; openable is kinematic animation.
  "physics-joint": { status: "reserved", instead: "parent {to} attaches rigidly; openable animates a door, lid or gate; motion swings a pendulum (PHYSICS §3.3)", on: "thing", keyed: true, key: "instance",
               help: "reserved (refused until this world's engine carries joints): keyed by name, a physical constraint between this thing and another (OMI_physics_joint: two frames, one on each body, with limits and drives; PHYSICS §3.3 sketches the shape)" },
  joint:     { status: "reserved", instead: "nothing yet: a skeleton's nodes come with avatar entity trees", on: "thing",
               help: "reserved: a skeleton node (Maya's joint, glTF's skin joint, a VRM humanoid bone): an entity that is one bone of an articulated body, for avatar entity trees. Not the physics constraint (that is physics-joint)" },
  // server-written: a hand set below owner is refused (a forged copy-of mis-routes a rebase)
  "copy-of": { on: "thing", fields: { from: "string", key: "string" }, required: ["from", "key"], grammar: { from: "sha256" }, writtenBy: "server",
               docs: { from: "the blueprint record it was copied from, sha256:<64 hex>", key: "which part of that record it is" }, help: "set by the server on copies (never by hand below owner): {from: the record's hash sha256:<64 hex>, key: its part key in that record}" },
  // a sound a thing plays (shared/sound.js): silent AT radius (a true taper, not Web Audio's clamp), cap 100 m, near ≤
  // radius, t0 stamped by the authority. src: the store, an allowlisted https host, or another https link heard only by
  // viewers who allow untrusted links (shared/mediasrc.js).
  sound:      { on: "thing", fields: { src: "string", playing: "bool", loop: "bool", volume: "number", pitch: "number", near: "number", radius: "number", spatial: "bool", t0: "number", alt: "string" },
                defaults: { playing: true, loop: true, volume: 0.8, pitch: 1, near: 1.5, radius: 12, spatial: true }, required: ["src"],
                ranges: { volume: { min: 0, max: 1 }, pitch: { min: 0.5, max: 2 }, near: { gt: 0, max: 100 }, radius: { min: 1, max: 100 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                units: { near: "m", radius: "m", t0: "ms" },
                // pinned (render-media-env §6): the distance law every client hears (shared/sound.js gainAt); a future curve
                // choice is an addition (rolloff, absent = this law)
                absentMeans: { law: "gain = min(1, near / distance) (inverse distance, full volume inside near), then a (1−t)² taper over the last 5% of radius to exactly 0 at radius: shared/sound.js gainAt" },
                docs: { src: "the sound file: store/audio/…, eidoverse/assets/…, or an https link", playing: "it plays now (false: paused)", loop: "plays again when it ends", volume: "linear amplitude gain (not dB): 0 silent to 1 full", pitch: "playback rate: 2 = an octave up and twice as fast",
                  near: "full volume within this many metres", radius: "silent at and beyond this many metres: nobody further hears it at all", spatial: "positional; off: heard evenly everywhere inside its radius (room tone, music in a hall)", t0: "when it started, epoch ms (the authority stamps it)",
                  alt: "what is playing, in words: for people who can't hear it and for agents" },
                help: "a sound this thing plays: {src (store/audio/…, eidoverse/assets/…, or an https link: an allowlisted host's plays for everyone, any other only for viewers who allow untrusted links), playing? (default true), loop?, volume? 0..1, pitch? 0.5..2 (playback rate), near? m (full volume inside it), radius? m (≤ 100: silent at and beyond it; inverse distance from near, a (1−t)² taper over the last 5% to 0 at radius), spatial? (false: heard evenly inside radius, no panning), t0? (stamped by the authority when it starts), alt? (what is playing, in words: what agents and people who can't hear it read)}. A reaction {kind: 'play'} plays it again from the top" },
  // an image on a thing (shared/picture.js): a framed quad of its own (width m, height from the image's aspect, facing +Z on
  // its origin). src as sound's, for images. Texturing one node of a model (part, flip) is a material override, the
  // reserved `material`'s, not a picture (render-media-env §5): both are cut
  picture:    { on: "thing", fields: { src: "string", width: "number", alt: "string", lit: "string" },
                defaults: { lit: "scene", width: 1 }, required: ["src"], enums: { lit: ["scene", "self"] },
                dropped: { part: "texturing a node of a model is a material override: the reserved material component's (a picture is a quad of its own)", flip: "a part's upside-down UVs are the reserved material's, with part" },
                ranges: { width: { gt: 0, max: 20 }, src: { maxLen: 2048 }, alt: { maxLen: 200 } }, clean: { alt: "line" },
                units: { width: "m" },
                docs: { src: "the image: store/images/…, eidoverse/assets/…, or an https link", width: "the quad's width, metres; its height follows the image", alt: "what it shows, in words: for people who can't see it and for agents",
                  lit: "scene (takes the scene's light) | self (a screen, unlit)" },
                help: "an image on this thing: {src (store/images/…, eidoverse/assets/…, or an https link: see sound), width? m (the quad's, facing +Z on its origin; its height follows the image), alt? (alternative text: what it shows, for people who can't see it and for agents), lit?: scene|self (self = a screen, unlit)}. To texture a node of its model: the material component (reserved)" },
  // why a thing is here ({title, text, marks?}): a museum label's title and text. Who wrote it is a view over the log
  // (History), never stored. The world's own blurb is @world.about
  story:      { on: "thing", fields: { title: "string", text: "string", marks: "refs" }, required: ["title", "text"],
                ranges: { title: { maxLen: 80 }, text: { maxLen: 1000 }, marks: { maxItems: 8 } }, clean: { title: "line", text: "lines" },
                docs: { title: "its headline, ≤ 80 characters", text: "why it is here, ≤ 1000 characters of plain text, a blank line between paragraphs", marks: "what it marks or commemorates: up to 8 things' ids" },
                help: "why this thing is here, a museum label: {title (≤ 80), text (≤ 1000; plain text, a blank line between paragraphs), marks? [ids] (≤ 8: what it marks or commemorates)}. Shown on Inspect and in look" },
  // words in the world: signage, on the canvas text path (a browser font stack: CJK, RTL and emoji). Long-form text (a book,
  // a library) will be its own component; this one stays a sign
  text:       { on: "thing", fields: { text: "string", size: "number", width: "number", align: "string", color: "int", outline: "bool", outlineColor: "int", background: "int", billboard: "string", lit: "string" },
                absentMeans: { outlineColor: "the edge takes the colour that contrasts with the text colour: black behind light text, white behind dark",
                  anchor: "the block is centred on its origin in its local X–Y plane, facing +Z (horizontally by align's box of width, vertically on the middle of its lines): pinned (shape audit 10-16)" },
                defaults: { size: 0.15, width: 2, align: "center", color: 0xffffff, outline: true, billboard: "off", lit: "self" }, required: ["text"],
                enums: { align: ["left", "center", "right"], billboard: ["off", "yaw", "full"], lit: ["self", "scene"] },
                ranges: { text: { maxLen: 400 }, size: { min: 0.02, max: 2 }, width: { min: 0.1, max: 10 }, color: { min: 0, max: 0xffffff }, background: { min: 0, max: 0xffffff }, outlineColor: { min: 0, max: 0xffffff } }, clean: { text: "lines" },
                units: { size: "m", width: "m" },
                docs: { text: "what it says, ≤ 400 characters and ≤ 16 lines", size: "the height of a line, metres", width: "where lines wrap, metres", align: "left | center | right", color: "the letters' colour, 0xRRGGBB", outline: "an edge around the letters, so they read on any background",
                  outlineColor: "the edge's colour, 0xRRGGBB; left alone, the one that contrasts with the text colour", background: "a plate behind the words, 0xRRGGBB; absent: none", billboard: "off (flat, readable from both sides) | yaw (turns to face each viewer) | full (always faces each viewer)", lit: "self (glows, unlit) | scene (takes the scene's light)" },
                help: "a sign: {text (≤ 400 characters, ≤ 16 lines), size? (line height, m; 0.02..2), width? (wrap width, m; 0.1..10), align?: left|center|right, color? 0xRRGGBB, outline? (a contrasting edge), background? 0xRRGGBB (a plate behind it; absent = none), billboard?: off (flat, facing +Z, readable from both sides) | yaw (turns about up toward each viewer) | full (faces each viewer, kept upright), lit?: self|scene}" },
  // a thing (or a part, look-at:<part>) turns to face something (Unity AimConstraint). State is logged; the turn is a
  // view each client computes, like motion. Radians (PROTOCOL §9.2), axes stored as vectors.
  "look-at":  { on: "thing", keyed: "optional", fields: { target: "target", mode: "string", forward: "axis", up: "axis", yaw: "array", pitch: "array", speed: "number", range: "number" },
                defaults: { mode: "yaw", forward: [0, 0, 1], up: [0, 1, 0], speed: 240 * Math.PI / 180, range: 12 }, required: ["target"], enums: { mode: ["yaw", "aim"] },
                ranges: { speed: { min: 0, max: 20 * Math.PI }, range: { gt: 0, max: 100 }, yaw: { min: -Math.PI, max: Math.PI }, pitch: { min: -Math.PI / 2, max: Math.PI / 2 } },
                units: { speed: "rad/s", range: "m", yaw: "rad", pitch: "rad" },
                docs: { target: "what it turns to face: a thing's id, @viewer (each viewer's own eyes), @nearest (whoever is nearest within range), or a person's identity", mode: "yaw (turns about its up only, stays upright) | aim (tilts too)", forward: "which of its own axes points at the target, [x, y, z] (a letter x, y or z is taken and stored as its vector); [0, 0, 1] is its front",
                  up: "its up axis, [x, y, z]", yaw: "[min, max] radians it may turn from rest, within ±π", pitch: "[min, max] radians it may tilt from rest, within ±π/2", speed: "radians a second; 0 = turns at once", range: "a person further than this many metres: it turns back to rest" },
                help: "it turns to face something: {target (a thing's id, @viewer: each viewer's own eyes, @nearest: whoever is nearest within range, or a person's identity u-…), mode?: yaw (turns about up only, stays upright) | aim (tilts too), forward? ([x, y, z] in its own frame, default [0, 0, 1], its front; a letter x|y|z|-x|-y|-z is taken and stored as its vector), up? (default [0, 1, 0]), yaw? [min, max] and pitch? [min, max] (radians from rest), speed? rad/s (default 240°/s; 0 = at once), range? m (a person beyond it: back to rest)}. look-at:<part> turns one model part" },
  // captions: written only by the caption request, ONE line per write (shared/captions.js); who may caption is the
  // screen's captioners list. The log is the transcript. An older value keeps its lines in `window`, still read
  // (normalizeCaptions); `line`'s pinned absentMeans is that window.
  captions:   { on: "thing", fields: { session: "string", n: "int", gen: "number", title: "string", line: "object" }, required: ["session", "n", "line"],
                ranges: { title: { maxLen: 120 } }, units: { gen: "the leg's generation" },
               absentMeans: { line: "an older value's window [{t0, t1, text, speaker?}]: its last entry is the line on screen" },
                docs: { session: "the captioning session's id", n: "the line's number in its session", gen: "the generation of the feed", title: "what is playing", line: "the line on screen now: {t0, t1 (seconds of media time), text (≤ 240), speaker? (≤ 48)}" },
                help: "a screen's captions, written by the caption request only: {session, n, gen, title?, line: {t0, t1, text, speaker?}} (the current line; earlier ones are the earlier captions changes)" },
  captioners: { on: "thing", fields: { ids: "people" }, docs: { ids: "the identities who may caption this screen, beside anyone who may edit it" }, help: "who may caption this screen with the caption request: {ids: [<identity u-…>]}; anyone who may edit the screen may caption it too" },
  // names the engine reads, carried by imported worlds, registered with their old meaning (L5); a name not here is a world's
  // own, admitted unless a near-miss of one of these. A tz present means the wall clock governs; ts, override and a
  // forecast's epoch are stamped by the authority. forecast@1 is shared/forecast.js's draw order; a changed law is a new name.
  sky:       { on: "world", fields: { hours: "number", rate: "number", ts: "number", tz: "string", clouds: "string", weather: "string", weatherK: "number", transition: "number", azimuth: "number", fog: "number", exposure: "number", ambient: "number", forecast: "object", override: "object" },
               defaults: { hours: 12, rate: 0, clouds: "cumulus", azimuth: Math.PI, fog: 1, exposure: 1, ambient: 1 },
               enums: { clouds: ["clear", "cumulus", "stratus", "cirrus"], weather: ["clear", "fair", "sunshower", "overcast", "rain", "storm", "cyclone", "darkstorm"] },
               stamped: ["ts", "override", "forecast.epoch"],
               dropped: { clock: "a tz present means the wall clock governs: {tz: 'Europe/Paris'}", dormantRated: "fold bookkeeping: hours and rate stay put as the fallback clock", sun: "a knob on the renderer's own light rig (never stored)", fill: "a knob on the renderer's own light rig (never stored)", world: "a one-member enum (earth), never stored", weatherSeconds: "renamed transition (seconds)" },
               ranges: { hours: { min: 0, max: 24 }, rate: { min: -1000, max: 1000 }, azimuth: { min: -2 * Math.PI, max: 2 * Math.PI }, fog: { min: 0 }, exposure: { min: 0 }, ambient: { min: 0 }, transition: { gt: 0, max: 600 }, weatherK: { min: 0, max: 2 }, tz: { maxLen: 64 } },
               units: { hours: "h", rate: "world hours per real hour", ts: "ms", azimuth: "rad", transition: "s" },
               absentMeans: { tz: "no wall clock: hours, rate and ts govern the day", weather: "no authored weather (a forecast may still say one)", weatherK: "1: full intensity", transition: "the renderer's own ease (30 s in a forecast)",
                 forecast: "no forecast: the authored weather holds", override: "no manual weather inside the current forecast segment", law: "forecast@1: per (seed, segment), drawn in the order dwell, then state, then intensity; spec/conformance/laws.json pins its segments" },
               docs: { hours: "the hour of day at ts, 0 ≤ h ≤ 24", rate: "world hours a real hour (0: the sun stands still)", ts: "the instant hours held, epoch ms (stamped by the authority)", tz: "an IANA time zone: present, the world's hour is that zone's wall clock", clouds: "clear | cumulus | stratus | cirrus", weather: "clear | fair | sunshower | overcast | rain | storm | cyclone | darkstorm",
                 weatherK: "the weather's intensity, 0..2", transition: "how long a change of weather eases in, seconds", azimuth: "where the sun stands round the horizon, radians (π: the default)", fog: "× this renderer's own fog curve", exposure: "× this renderer's tone mapping", ambient: "× this renderer's ambient curve",
                 forecast: "a weather policy {seed, states: [name | {state, weight}], dwell: [min, max] s, k: [min, max], transition: s, epoch (stamped)}", override: "a weather act inside a forecast segment {state, k?, ts} (stamped)" },
               help: "on @world: the sky and its clock {hours, rate, tz? (present: the wall clock of that zone governs), clouds, weather, weatherK, transition (s), azimuth (rad), fog, exposure, ambient (× this renderer's own curves), forecast?}. ts, override and forecast.epoch are stamped by the sky and weather acts; the sky act also takes clock: 'real' (stored as tz) and weatherSeconds (stored as transition)" },
  // ONE spelling, the flora one: makeGrass's knobs are taken at write via flora_args mapGrassArgs; a preset is stored by
  // NAME (expansion is cheap later, un-expansion impossible), checked against shared/flora_presets.js. colour is a palette
  // name or [r, g, b] multiplier (defs/flora/_colors.json), not an sRGB int.
  grass:     { on: "world", fields: { species: "string", width: "number", depth: "number", size: "number", center: "array", height: "number", density: "number", wind: "number", color: "any", seed: "int", preset: "string", rows: "object", corn: "object", heading: "number", strokes: "array" },
               dropped: { bladeHeight: "the flora spelling is height (a write of the old knobs is taken and mapped)", spacing: "the flora spelling is density", perCell: "the flora spelling is density", colorTip: "the flora spelling is color (a multiplier)" },
               ranges: { width: { gt: 0, max: 1000 }, depth: { gt: 0, max: 1000 }, size: { gt: 0, max: 1000 }, height: { gt: 0, max: 10 }, density: { min: 0, max: 4 }, wind: { min: 0, max: 10 }, strokes: { maxItems: 16 } },
               units: { width: "m", depth: "m", size: "m", height: "m", heading: "rad" },
               absentMeans: { size: "80 m wide and 70 m deep when width and depth aren't given either (a stroke's own: 30 m)", species: "grass", width: "size, else 80 m (a stroke's own: 30 m)", depth: "size, else 70 m (a stroke's own: 30 m)", center: "[0, 0]", height: "the species' own", density: "1", wind: "1", color: "the species' own", seed: "7",
                 strokes: "one stroke: the value itself (a species' own composition, corn's and sunflower's rows, still applies)", preset: "no preset: the value's own strokes, else one stroke", heading: "-0.6 rad for sunflowers (they face one way together)" },
               docs: { species: "what grows (a flora def: grass, corn, sunflower, galleta_dry…)", width: "the field's width, metres", depth: "the field's depth, metres", size: "width and depth when they aren't given, metres", center: "[x, z] of the field's middle, metres", height: "plant height, metres", density: "how thickly it grows (0..4)", wind: "how much it sways (×)", color: "a palette name (defs/flora/_colors.json) or a multiplier [r, g, b]", seed: "the planting's random seed",
                 rows: "a crop's rows {spacing, plant, stride?, phase?}", corn: "corn's own knobs {peel?, peelChance?}", heading: "the way sunflowers face, radians", preset: "a named planting (defs/flora/_presets.json: mojave, …), stored by its name and composed into strokes by the reader; an unknown name is refused", strokes: "the plantings this field is made of: [{species, width, depth, center, seed, density, variant?, footprint?}] (they win over a preset)" },
               help: "a grass or crop field {species, width, depth (or size), center, height, density, wind, color, seed} or {width, depth, seed, strokes: […]}; a preset ({preset: 'mojave'}) is stored by its name and composed by the reader, and the first protocol's knobs (bladeHeight, spacing, perCell, colorTip) are taken and stored in this spelling" },
  // carried from the first protocol, with real readers (shared/structure.js; physics-motion §9): its grid numbers and nested
  // grammar, "a CONTRACT", are pinned here; tools/shape-physics-test holds them equal to structure.js. A level entry a reader
  // can't parse reads as absent (normalize skips it)
  structure: { on: "thing", fields: { tile: "number", wallH: "number", wallT: "number", slabT: "number", labels: "object", levels: "array" },
    defaults: { tile: 1, wallH: 2.8, wallT: 0.15 }, units: { tile: "m", wallH: "m", wallT: "m", slabT: "m" },
    ranges: { tile: { gt: 0, max: 100 }, wallH: { gt: 0, max: 100 }, wallT: { gt: 0, max: 10 }, slabT: { gt: 0, max: 10 } },
    absentMeans: { slabT: "0.10 m (structure.js GRID_DEFAULTS; never written by the editor)" },
    nested: { levels: "[{y (m), tiles: [[x int, z int, mat?, half?: A|B]], walls: [[axis 0..3, x int, z int, mat?]], apertures: [[axis 0..3, x int, z int, kind]]}]", labels: "{<cellKey>: string}" },
    nestedEnums: { "levels[].apertures[][3]": ["door", "window", "arch"], "levels[].walls[][0]": [0, 1, 2, 3], "levels[].apertures[][0]": [0, 1, 2, 3], "levels[].tiles[][3]": ["A", "B"] },
    docs: { tile: "metres a cell", wallH: "wall height, floor to floor, metres", wallT: "wall thickness, metres", slabT: "floor slab thickness, metres (its top at the level's y)", labels: "room names by cell", levels: "the storeys: tiles, walls on cell edges, apertures (door, window, arch) in walls" },
    help: "a built structure's plan (The Sims' grid: walls on cell edges) {tile (m, default 1), wallH (m, default 2.8), wallT (m, default 0.15), slabT? (m; absent 0.10), levels: [{y, tiles: [[x, z, mat?, half?]], walls: [[axis 0..3, x, z, mat?]], apertures: [[axis, x, z, door|window|arch]]}], labels: {<cell>: name}}" },
  // the instance is tiny and names an effect document (shared/particle_effects.js): an Essential's NAME, as written, or a
  // stored document's address, with its params. A first-protocol bag is read (instanceOf) only by the translator; an
  // Essential's pinned address (ESSENTIAL_ADDRESSES) still reads as that Essential.
  particles: { on: "thing", fields: { effect: "string", part: "string", at: "vec3", seed: "number", playing: "bool", scale: "number", params: "object" },
               defaults: { playing: true, scale: 1 }, required: ["effect"],
               // held for a synced start instant (as sound.t0), so every viewer fires a one-shot or a burst together
               reservedFields: ["t0"],
               reservedWhy: { t0: "a synced start instant (epoch ms, as sound.t0) so every viewer fires a one-shot or a burst together" },
               ranges: { scale: { min: 0.01, max: 100 }, part: { maxLen: 64 }, effect: { maxLen: 80 }, at: { min: -8, max: 8 } },
               units: { at: "m", scale: "×" },
               docs: { effect: "an Essentials name (fire, sparks, embers, smoke, dust, snow, magic, stars, muzzle), stored as written, or the content address sha256:<64 hex> of a document uploaded here (an Essential's eido:sha256/… address stored before 10-17 still reads as that Essential)", part: "a node of its model it emits from", at: "where it emits, [x, y, z] metres in its own frame, each within ±8", seed: "the random seed; absent: derived from its id",
                 playing: "off: no new particles; the living finish", scale: "every length in the effect (positions, sizes, speeds, accelerations) × this, on top of the thing's own transform scale; 0.01..100", params: "the effect's own knobs {<name>: value}" },
               absentMeans: {
                 part: "it emits from the thing itself, not one node of its model",
                 at: "[0, 0, 0] in its own frame",
                 seed: "derived from its id and its effect's name (hashSeed(`${id}:${name}`))",
                 playing: "playing: it emits (the component's presence was its state)",
                 scale: "1: the effect at its own size",
                 params: "none: the effect's own defaults" },
               help: "it emits particles: {effect (an Essentials name, fire, sparks, embers, smoke, dust, snow, magic, stars, muzzle, or a document of your own by its address: upload {effect: {…}} stores one, sha256:<64 hex>), part? (a node of its model it emits from), at? [x, y, z] (m in its own frame, ±8), seed? (absent: derived from its id), playing? (false: no new particles; the living finish), scale? (0.01..100: every length in the effect × this, on top of the thing's own scale), params? {<name>: value} (the effect's own knobs, schema {component: 'particles'} and the inspector list them; every Essential takes count, size, opacity, speed, lifetime, area, texture, quality)}. An effect document is emitters of modules: spawn, shape, velocity, forces, rotation, size, color, render (spec in shared/particle_effects.js: angles in radians, gravity world-down, every other vector in the emitter's frame; a trial format, expected to grow)" },
  "imported-behavior": { on: "world", keyed: true, key: "instance", fields: { src: "string", attach: "ref", caps: "object", knobs: "object", author: "string", ts: "number", state: "object" }, docs: { src: "the old script's source, as the translation carried it", attach: "the thing it was bound to", caps: "the capabilities it was granted", knobs: "its settings", author: "who wrote it, as the old world recorded", ts: "when it was bound (epoch ms)", state: "its saved state" }, help: "keyed by name: an imported world's old runtime-script binding, carried from translation (scripts are script:<name>)" },
  assets:    { on: "world", keyed: true, key: "instance", fields: { name: "string", path: "string" }, docs: { name: "the asset's display name", path: "its library path" }, help: "on @world, keyed: one of the world's assets (a model added here)" },
  imported:  { keyed: true, key: "instance", help: "keyed: a field an imported world's translation had no mapping for, carried as it was" },
  "imported-roles": { on: "world", keyed: true, key: "instance", help: "on @world, keyed by identity: an imported grant this protocol has no rung for (spectator or none: R 10-21, nothing below inhabitant), carried as it was; the person holds the world's newcomer role" },
  "imported-bans": { on: "world", keyed: true, key: "instance", help: "on @world, keyed by identity: a ban an imported world carried, as it was (live bans are the moderator log's)" },
  // ranked membership (shared/protocol/roles.js: inhabitant 0, builder 100, moderator 200, owner 255, custom roles between)
  // and a closed list of permissions. Banned is a state in the moderator log, never a role. No `sub`: an account subject is
  // person data, never a value (PROTOCOL §9.2); the translator strips it
  roles:     { status: "trial-kernel", on: "world", keyed: true, key: "instance", fields: { role: "string", can: "object", note: "string", until: "int" },
    // the ladder's vocabulary (out of the kernel pin, which holds what the fold reads): a grant names one of these ids, a
    // role-def keys on these permissions, so any change is a break needing --ack (pinBreakList `vocab`), an addition too
    vocab: { rank: { ...RANK }, builtin: [...BUILTIN_IDS], permissions: [...PERMISSION_NAMES], customId: CUSTOM_ID.source, reserved: [...RESERVED_IDS].sort() },
    absentMeans: { until: "the grant has no end: it stands until someone with the right changes or removes it (every role written before 10-17)" }, docs: { role: "the role this person holds: a built-in (inhabitant, builder, moderator, owner) or one the world defines", can: "{<permission>: true|false}: exceptions on top of the role, for this person", note: "a note on the grant (≤ 80)", until: "when the grant ends, epoch ms; never on owner" }, help: "on @world, keyed by identity: {role: inhabitant|builder|moderator|owner|<a custom role>, can?: {<permission>: true|false} (exceptions on top of the role), note? (≤ 80), until? (epoch ms: when the grant ends; the authority ends it then, warning the holder 5 min before; never on owner)}. A grantRoles holder may give roles ranked below their own, with only permissions they hold" },
  // guests isn't written down: absent means inhabitant whatever the newcomer role (roles.js guestRoleOf: guests start as
  // inhabitants even where newcomers build). Pinned as a known gap (pretrans D7)
  "default-role": { on: "world", fields: { role: "string", can: "object", guests: "string" }, docs: { role: "the newcomer role: what anyone without their own grant holds; never owner", can: "{<permission>: true|false} on top of that role, for everyone holding it this way (not guests)", guests: "the role people without an account start as; never above role" }, help: "on @world (owner): the NEWCOMER role: what anyone without roles:<id> holds (absent = inhabitant; a world founded since R 10-21 starts with builder): any role but owner; can? {<permission>: true|false} on top of that role for everyone who holds it this way (not guests); guests (people without an account) get guests (default inhabitant), never above role" },
  "role-defs": { on: "world", help: "on @world (owner): {<role id>: {name, rank (custom: 1–254, unique), can: {<permission>: true|false}, note?}}. Built-ins visitor, builder, moderator may be renamed and their permissions edited (rank fixed); owner holds every permission and isn't listed. Permissions: build, editOthers, editWorld, generate, fly, scripts, pauseScripts, mute, kick, ban, grantRoles" },
  access:    { status: "trial-kernel", on: "world", fields: { join: "string", watch: "string", max: "int", soft: "int", minAccountDays: "int" }, enums: { join: ["anyone", "signed-in", "listed"], watch: ["anyone"] },
    absentMeans: { watch: "watching follows join: whoever join turns away can't watch either, and a world that admits only people listed is invisible to everyone else (what every access before 10-17 meant)" }, ranges: { max: { min: 1, max: 200 }, soft: { min: 1, max: 200 }, minAccountDays: { min: 0, max: 365 } }, docs: { join: "who may come in: anyone, signed-in, or listed (people the world has granted a role, unexpired)", watch: "anyone: whoever join turns away may still watch, with no body", max: "most bodies at once (1–200)", soft: "the recommended capacity (≤ max)", minAccountDays: "an account must be at least this many days old to come in (0–365; 0 is off)" }, help: "on @world (owner): who may come in {join: anyone|signed-in|listed (only people the world has granted a role, unexpired; a listed-only world is invisible to everyone else), watch? (anyone: whoever join turns away may still watch, with no body), max? (1–200 at once), soft? (≤ max: the recommended capacity), minAccountDays? (0–365: a person's account must be at least this many days old; a guest is then refused, an enrolled agent is exempt; 0 or absent = off)}; moderators and owners always get in" },
  about:     { on: "world", fields: { name: "string", text: "string" }, ranges: { name: { maxLen: 80 }, text: { maxLen: 2000 } }, docs: { name: "the world's name, ≤ 80 characters", text: "its blurb, ≤ 2000 characters" }, help: "on @world: the world's name (≤ 80) and blurb (≤ 2000)" },
  // the component ladder's second rung (docs/COMPONENT-LADDER.md): the drafts this world's owner trusts here. A fact about the
  // world, not the engine: the authority still doesn't read a trusted draft. Owner-gated like the rest of @world.
  "trusted-components": { on: "world", fields: { components: "array" }, ranges: { components: { maxItems: 64 } }, docs: { components: "the namespaced draft component names trusted in this world (≤ 64, each once)" }, help: "on @world (owner): {components: [<namespaced draft names>]} — the draft COMPONENTS used and trusted in this world (never a list of people; was `trusted`, renamed by the world's maintenance command) (a blue chip in the Inspector, offered in the main Add Component list); never a bare name (that is the engine's or nothing); ≤ 64, each once. Trust ≠ engine understanding: the authority doesn't read them" },
  bounds:    { on: "world", fields: { min: "vec3", max: "vec3" }, required: ["min", "max"], units: { min: "m", max: "m" }, docs: { min: "the box's low corner [x, y, z], world metres", max: "its high corner [x, y, z], world metres" },
               help: "on @world: the box the world lives in, {min: [x, y, z], max: [x, y, z]} in world metres, min < max on every axis. Absent (no bounds component), anywhere is in the world" },
  // units, a range, and the absent radius written down (shared/mover.js TRACK.spawnR; tools/shape-attach-test pins they agree)
  spawn:     { on: "world", fields: { pos: "vec3", radius: "number" }, required: ["pos"], units: { pos: "m", radius: "m" }, ranges: { radius: { min: 0, max: 100 } },
               absentMeans: { radius: "2 m" }, docs: { pos: "where visitors arrive, [x, y, z] world metres", radius: "a visitor's arrival must lie within this many metres of pos (the client chooses where inside)" },
               help: "on @world: where visitors arrive {pos: [x, y, z], radius? (m, 0..100; absent, 2 m): a visitor's arrival must lie within radius of pos}" },
  // the noise ground: its defaults ARE the sim's law (shared/terrainmath.js terrainParams, held by eidosim's digests),
  // written into every stored value. raster is reserved. Colours are sRGB ints. terrain.water is refused (its own component).
  terrain:   { on: "world", fields: { kind: "string", seed: "int", size: "number", amplitude: "number", octaves: "int", frequency: "number", flatRadius: "number", flatHeight: "number",
                         segments: "int", layers: "array", features: "array", heightmap: "object" },   // upstream #237/#242: shared/terrainshape.js reads and bounds them
               defaults: { kind: "noise", seed: 1, size: 80, amplitude: 3, octaves: 4, frequency: 2.5, flatRadius: 0, flatHeight: 0 },
               enums: { kind: ["noise"] },
               reservedKinds: { raster: "an imported height raster {blob, w, h, spacing, origin, format: 'i32-mm-le'}: no reader draws or walks it yet" },
               dropped: { water: "water is its own component on @world: set {id: '@world', component: 'water', value: {level, color?, opacity?, kind?, flow?}}" },
               // what every visitor's client can build: past these a single write freezes or breaks everyone
               ranges: { size: { gt: 0, max: 4096 }, segments: { min: 2, max: 512 }, octaves: { min: 1, max: 8 }, frequency: { gt: 0, max: 64 },
                         amplitude: { min: -500, max: 500 }, flatRadius: { min: 0, max: 4096 }, features: { maxItems: 64 }, layers: { maxItems: 8 } },
               nullable: ["features", "heightmap"],   // null = removed (a merge patch can take one away)
               absentMeans: { features: "no placed shapes: the base alone is the ground", heightmap: "no image: the noise is the base", segments: "the renderer's own mesh resolution (a drawing choice, not part of the height law)", layers: "one plain layer, 0x4a5d33 repeated 16 times across its size",
                 law: "the ground's height over these numbers, then features and heightmap; spec/conformance/laws.json pins heights bit for bit" },
               units: { size: "m", amplitude: "m", flatRadius: "m", flatHeight: "m" },
               docs: { kind: "the base's kind: noise (a raster kind is reserved)", seed: "the noise seed", size: "the ground's size, metres", amplitude: "its relief: how high the ground rises, metres", segments: "samples per side (the drawn mesh's resolution)", flatRadius: "flat within this many metres of the centre", flatHeight: "the height of that flat centre, metres", octaves: "noise octaves (1–8)", frequency: "noise frequency", layers: "its colour layers, at most 8: [{color: 0xRRGGBB (sRGB), repeat: tiles across its size}]", features: "placed shapes over the base, in order (at most 64): {type: hill|ridge|flatten, …} (shared/terrainshape.js)", heightmap: "an uploaded grayscale grid as the base: {grid: 'store/heightmaps/<hash>.json', min, max} (m)" },
               help: "the ground's base: {kind: 'noise', seed, size, amplitude, octaves, frequency, flatRadius, flatHeight, segments, layers? [{color: 0xRRGGBB, repeat}], features?, heightmap?} (absent numbers are the sim's: seed 1, size 80 m, amplitude 3 m, octaves 4, frequency 2.5, flat radius 0); a raster kind is reserved; water is its own component" },
  // split out of terrain (render-media-env §15): one water level for the world, SL's per-region water. A keyed water:<name>
  // with bounds is a later addition. shared/terrainshape.js waterParams reads it (an older terrain.water too, until the
  // maintenance command moves it)
  water:     { on: "world", fields: { level: "number", color: "int", opacity: "number", kind: "string", flow: "array" }, required: ["level"],
               enums: { kind: ["still", "river", "ocean"] },
               ranges: { level: { min: -500, max: 500 }, color: { min: 0, max: 0xffffff }, opacity: { min: 0.1, max: 1 } },
               units: { level: "m", flow: "m/s" },
               absentMeans: { color: "0x1d5a6e", opacity: "0.82", kind: "decided from the ground it fills (shared/waterkind.js)", flow: "still: no current" },
               docs: { level: "the water's surface height, metres (world y)", color: "its colour, 0xRRGGBB (sRGB)", opacity: "0.1..1", kind: "still | river | ocean", flow: "a current [x, z], metres a second" },
               help: "on @world: the world's water {level (m), color? 0xRRGGBB, opacity? 0.1..1, kind?: still|river|ocean, flow? [x, z] m/s}; delete it to drain" },
  "terrain-grid": { status: "reserved", on: "world", help: "reserved: the sculpt grid; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  "terrain-tile": { status: "reserved", on: "world", keyed: true, key: "partition", help: "reserved: a sculpted tile, keyed <i>-<j>; no shape is pinned until a world needs one (a sketch: docs/RESERVED-SHAPES.md)" },
  // a behaviour, keyed, so §5's creator rule decides who may change it and who its SPONSOR is. The install check's lists
  // (itemEnums, scopeFields) live here so the pin sees them.
  script:    { keyed: true, key: "instance", fields: { src: "string", scope: "object", on: "array", every: "number", always: "bool", knobs: "object", paused: "bool" },
               required: ["src", "scope"], grammar: { src: "sha256" }, units: { every: "s" }, ranges: { every: { min: 5 } },
               itemEnums: { on: ["use", "say", "enter", "leave", "grab", "release", "changed:*"], "scope.bodies": ["shove", "pose"] },
               scopeFields: { ids: "scope", comps: "array", create: "bool", say: "bool", bodies: "array" },
               docs: { src: "the source blob's name", scope: "what it may touch: {ids, comps, create?, say?, bodies?}", on: "the events that wake it (use, say, enter, leave, grab, release, changed:<comp>)", every: "seconds between ticks (≥ 5)", always: "true: it runs with nobody present (owner)", knobs: "its settings (≤ 4 KiB)", paused: "true: it doesn't run" }, help: "keyed <name>: a script (JavaScript; docs/SCRIPTS.md). {src: the source blob's name (upload {text} gives it), scope: {ids: 'self'|'subtree'|[ids], comps: [names, 'name:*'], create?, say?, bodies?: ['shove'|'pose']}, on: ['use', 'say', 'enter', 'leave', 'grab', 'release', 'changed:<comp>'], every?: s (>= 5; it gets tick, and wake after sleeping), always?: bool (run with nobody present; owner), knobs?: {…} (<= 4 KiB), paused?}. It acts with its sponsor's rights now, never beyond its scope; a `use` reaches it through a reactions handler {kind: 'script', script: <name>}" },
  // §5: keyed names say which kind of key they are. instance: the creator rule; partition: one shared surface. reserved: no
  // format for a "written definition" exists yet and nothing writes one, so the name is held until one does (it may then
  // be a set-once string sha256:<64 hex>)
  schemas:   { status: "reserved", instead: "nothing yet: the pinned registry (spec/registry-pin.json) carries a name's meaning; schemas:<name> waits for a definition document format", on: "world", keyed: true, key: "instance", help: "reserved: on @world, keyed by component name, for the content hash of that name's written definition once a format for one exists. Not written yet (PROTOCOL §4)" },
  blueprints: { on: "world", keyed: true, key: "instance", help: "on @world, keyed by a blueprint's hash: {name, …} (publish writes it)" },
  "terrain-paint": { status: "reserved", on: "world", keyed: true, key: "partition", help: "keyed <i>-<j>: paint channels for one tile (research 40 §3; not built in the lab)" },
  // capacity: gates against a world nobody can load, not targets; ONE entity budget (a socket counts). A POLICY number
  // (PROTOCOL §9.2): absent is this server's current default (authority CAPACITY), the ceiling is CAPACITY_CEILING; a
  // written field is stored as written.
  capacity:  { on: "world",
               fields: { entities: "int", guestEntities: "int", avatar: "int" },
               ranges: { entities: { min: 1 }, guestEntities: { min: 0 }, avatar: { min: 1 } },
               units: { entities: "entities", guestEntities: "entities", avatar: "entities" },
               absentMeans: { entities: "this server's current default (schema reports it); it may change",
                              guestEntities: "this server's current default (schema reports it); it may change",
                              avatar: "this server's current default (schema reports it); it may change. Not enforced yet" },
               docs: { entities: "the whole world's entities: every one but @world, sockets included (absent: this server's default; at most the server's ceiling)",
                       guestEntities: "all account-less people's entities together: what people without an account made that still stands here, sockets included (absent: this server's default)",
                       avatar: "one worn avatar's entity tree, at most: the largest one avatar may be, checked when it's worn and not counted in entities (absent: this server's default); not enforced yet: no avatar trees exist" },
               help: "on @world (owner): how much this world holds: {entities (the whole world's entities, every one but @world, sockets included), guestEntities (all account-less people's entities together), avatar (one worn avatar's entity tree at most, checked when worn, not counted in entities; not enforced yet)}. Each is optional: absent, it is this server's current default, and no field may go above the server's ceiling (schema reports both). One thing holds at most 64 sockets. A gate against a world nobody can load, not a target: a create past entities or guestEntities is refused (full)" },
  // script-settings: the owner's two decisions (on/off, how many) and two budgets an owner may only TIGHTEN; absent is
  // the server's default (scriptDefaults()), never above scriptCeiling(). Who may install is the role's `scripts` permission.
  // A stored value of the old fields (rate, depth, fails, runs: the server's own) is read as absent.
  "script-settings": { on: "world", fields: { run: "bool", max: "int", budget: "int", cpu: "int" },
               ranges: { max: { min: 0 }, budget: { min: 0 }, cpu: { min: 0 } },
               units: { budget: "script entries per hour", cpu: "ms of authority time per sponsor per minute" },
               absentMeans: { run: "true: scripts run", max: "this server's current default (schema reports it)",
                              budget: "this server's current default (schema reports it)", cpu: "this server's current default (schema reports it)" },
               docs: { run: "false stops every script here", max: "how many scripts this world may hold", budget: "script entries per hour, each sponsor a fair share", cpu: "ms of the authority's time each sponsor's scripts may use a minute (the world 3×)" },
               help: "on @world (owner): {run? (false stops every script), max? (how many scripts), budget? (script entries per hour; each sponsor gets a fair share), cpu? (ms of the authority's time per sponsor per minute; the world 3×)}. Each absent field is this server's current default, and none may go above the server's ceiling (schema reports both). Who may install a script is the role's scripts permission (role-defs)" },
};

// ---- status (PROTOCOL §4 Status, docs/COMPONENT-LADDER.md) ----
// trial: admitted, shape may change in the alpha (we translate or repair). reserved: the name is held, every write refused
// (`instead` says what to use). stable: additions only. Pinned in spec/registry-pin.json; a trial/reserved change needs
// pretrans --pin --ack, a stable one never. Held names below are reserved so no write squats a name the alpha will settle.
for (const [name, what] of Object.entries({
  material: "appearance: a surface's look (glTF material, KHR extensions). The physical surface a thing names is physics.surface",
  "anim-pose": "a pose: one frame, only the bones it names (R 10-17 15:09; a station's or a grabbable's anim may name one)",
  "anim-clip": "an animation clip (more than one key) and its playhead; when it has a shape, its own mode (once | loop | hold) and the bodyMode it asks for are fields of it (R 10-17: the agent's anim reads both)",
  "anim-states": "an animation state machine (states, transitions, params driving clips)",
  camera: "a camera a world places (a view, a screen's source)",
  zone: "a named world area; effects attach to it as siblings",
  video: "a video a thing plays",
  "spring-joint": "a spring between two bodies",
  link: "a link a thing opens (a portal, a page)",
  tags: "labels a thing carries for search and rules",
})) COMPONENTS[name] = { status: "reserved", instead: "nothing yet: the name is held for a shape that isn't settled. A namespaced name of your own (such as example.org/<name>) is kept and shown, though nothing here acts on it", help: `reserved: ${what}. Not written yet` };
// the avatar guard rails (PROTOCOL §7a, normative before avatar entity trees ship): the names are held now so nobody squats
// them under the must-ignore escape hatch before the shapes land. A body's owner is a PERMISSION RULE stamped by the
// authority at wear, never a component anyone writes.
COMPONENTS["body-owner"] = { status: "reserved", on: "thing", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: on a body root, the identity that owns the body (its wearer, or the world for a lent body), stamped by the authority at wear and never set by a request; every entity under the root is that person's (PROTOCOL §7a)" };
COMPONENTS["edit-grant"] = { status: "reserved", on: "thing", keyed: true, key: "instance", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: keyed by an identity, on a body root, in the WEARER's log: {until?, scope?: 'subtree' | [ids]} lets that person edit the body without build; revoking (deleting it) stops future edits, never past ones; a co-editor gets attribution, not rights (PROTOCOL §7a)" };
COMPONENTS["avatar-deny"] = { status: "reserved", on: "world", instead: "nothing yet: avatar entity trees aren't built",
  help: "reserved: on @world, {ids?, hashes?}: avatars this world refuses at arrive (the world may refuse a body, never edit one; PROTOCOL §7a)" };

export const STATUSES = {
  trial: "admitted, but its shape may still change during the alpha (about a year); stored values are translated or repaired where they can be",
  "trial-kernel": "the kernel (the log envelope and kinds, the fold's operations, the identity grammar, the version, and the two components every reader rests on: roles and access, each as its field shape only): it may still change during the alpha, but never by a re-pin with an acknowledgement alone: the same change must carry a translator, a changelog line and vectors an old reader refuses and a new one folds (shared/protocol/kernelspec.js; tools/protocol/kernel-check.ts)",
  reserved: "the name is held for a shape that isn't settled: every write of it is refused",
  stable: "promised: its meaning never changes; it only grows by additions",
};
for (const d of Object.values(COMPONENTS)) d.status ??= "trial";
/** A name's status (trial | reserved | stable), or null for a name the registry doesn't know. */
export const statusOf = (comp) => { const d = defOf(comp); return d ? d.status ?? "trial" : null; };

// ---- names (PROTOCOL §4) ----
// [<namespace>/]<name>[@<n>][:<key>]: a BARE name is the registry's (or refused); anyone else's carries a namespace
// (`example.org/heart`). Promotion registers it bare with an alias; a changed meaning is a NEW name `<name>@<n>` with
// `supersedes`.
export const baseOf = (comp) => { const i = String(comp).indexOf(":"); return i < 0 ? String(comp) : String(comp).slice(0, i); };
export const isNamespaced = (comp) => baseOf(comp).includes("/");
/** The registered name a base answers to (itself, or the name that lists it as an alias), or null. */
export function registered(base) {
  if (Object.hasOwn(COMPONENTS, base)) return base;
  if (!base.includes("/")) return null;   // an alias is always a namespaced spelling
  for (const [k, d] of Object.entries(COMPONENTS)) if (d.aliases?.includes(base)) return k;
  return null;
}
/** The definition a component name is checked against (an alias reaches its registered name's), or undefined. */
export const defOf = (comp) => { const r = registered(baseOf(comp)); return r ? COMPONENTS[r] : undefined; };
/** One spelling per meaning: an alias read as its registered name (its key kept). Renderers that read by name use this. */
export const canonicalName = (comp) => { const b = baseOf(comp), r = registered(b); return r && r !== b ? r + String(comp).slice(b.length) : String(comp); };
/** What a versioned name replaces (light@2 → light), from its definition; null if it says nothing. */
export const supersedes = (comp) => defOf(comp)?.supersedes ?? null;
/** The ONE reader of a versioned name (§4). For a base name on a record's components `c`: the newest registered `<name>@<n>`
 *  WRITTEN on c wins; else a written `<name>` keeps its own meaning; else the newest registered definition's defaults.
 *  → {name, value, def}: `value` what's written (or null), `def` the definition filling the gaps. Readers never hand-code
 *  `c["x@2"] ?? c.x`: a second @n would copy the chain. */
export function resolveVersioned(c, base) {
  const versions = Object.keys(COMPONENTS).filter((k) => k === base || k.startsWith(base + "@"))
    .sort((a, b) => (Number(a.split("@")[1] ?? 0)) - (Number(b.split("@")[1] ?? 0)));   // base, @2, @3 …
  for (let i = versions.length - 1; i >= 0; i--) { const k = versions[i]; if (c && c[k] != null) return { name: k, value: c[k], def: COMPONENTS[k] }; }
  const newest = versions[versions.length - 1]; return { name: newest, value: null, def: COMPONENTS[newest] };
}

// ---- references (PROTOCOL §4, "References are typed") ----
// A field naming a thing or person says so in its type (ref, refs, person, people, target, scope), nested ones in
// refPaths, so copy, publish and merge find every reference. People are never copied: only thing refs are rebound.
export const REF_TYPES = new Set(["ref", "refs", "person", "people", "target", "scope"]);
const PERSON_SHAPE = /^u-[a-z2-7]{20}$/;   // shared/protocol/ids.js PERSON_ID: an entity may never wear it
/** [{path: ["field", …], type}] for every reference-bearing field of a name (its scope's ids included). */
export function refFields(comp) {
  const d = defOf(comp); if (!d) return [];
  const out = Object.entries(d.fields ?? {}).filter(([, t]) => REF_TYPES.has(t)).map(([f, t]) => ({ path: [f], type: t }));
  for (const [f, t] of Object.entries(d.scopeFields ?? {})) if (REF_TYPES.has(t)) out.push({ path: ["scope", f], type: t });
  for (const [p, t] of Object.entries(d.refPaths ?? {})) out.push({ path: p.split("."), type: t });
  return out;
}
const isThingRef = (x) => typeof x === "string" && x !== "" && !x.startsWith("@") && !PERSON_SHAPE.test(x);
const getAt = (v, path) => path.reduce((o, k) => (o && typeof o === "object" && !Array.isArray(o) ? o[k] : undefined), v);
// a refPaths entry may hold a '*' segment (reactions "*.targets": every action's targets), expanded once, at its own
// position, left to right: a key that is itself "*" stands for that key, never another wildcard (else it recurses forever)
function expandPath(v, path, from = 0) {
  const i = path.indexOf("*", from); if (i < 0) return [path];
  const o = getAt(v, path.slice(0, i)); if (!o || typeof o !== "object" || Array.isArray(o)) return [];
  return Object.keys(o).flatMap((k) => expandPath(v, [...path.slice(0, i), k, ...path.slice(i + 1)], i + 1));
}
const concrete = (comp, v) => refFields(comp).flatMap(({ path, type }) => expandPath(v, path).map((p) => ({ path: p, type })));
/** Every THING an entity's component value refers to: [{path: "story.marks[1]", id}]. People and @words aren't things. */
export function refsOf(comp, v) {
  const out = []; const name = baseOf(comp);
  for (const { path, type } of concrete(comp, v)) { const x = getAt(v, path); const at = `${name}.${path.join(".")}`;
    if (type === "ref" || type === "target") { if (isThingRef(x)) out.push({ path: at, id: x }); }
    else if ((type === "refs" || type === "scope") && Array.isArray(x)) x.forEach((y, i) => { if (isThingRef(y)) out.push({ path: `${at}[${i}]`, id: y }); }); }
  return out;
}
/** Each thing reference x replaced by f(x, path); f returning null drops it (a list entry is removed; a single reference's
 *  field is removed, and if that field is required the whole value is: undefined). → {value, dropped: [paths]}. Never
 *  touches people or @words. */
export function mapRefs(comp, v, f) {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { value: v, dropped: [] };
  const out = copy(v), dropped = []; const d = defOf(comp); const name = baseOf(comp); let gone = false;
  for (const { path, type } of concrete(comp, v)) {
    const parent = getAt(out, path.slice(0, -1)); const k = path.at(-1); if (!parent || typeof parent !== "object" || Array.isArray(parent)) continue;
    const x = parent[k]; const at = `${name}.${path.join(".")}`;
    if (type === "ref" || type === "target") { if (!isThingRef(x)) continue; const y = f(x, at);
      if (y === null) { delete parent[k]; dropped.push(at); if (path.length === 1 && (d?.required ?? []).includes(k)) gone = true; if (comp === "parent" || baseOf(comp) === "parent") gone = true; }
      else parent[k] = y; }
    else if ((type === "refs" || type === "scope") && Array.isArray(x)) {
      const kept = []; x.forEach((y, i) => { if (!isThingRef(y)) { kept.push(y); return; } const z = f(y, `${at}[${i}]`); if (z === null) dropped.push(`${at}[${i}]`); else kept.push(z); });
      parent[k] = kept; }
  }
  return { value: gone ? undefined : out, dropped };
}

// ---- every parameter written down (PROTOCOL §4) ----
const copy = (x) => (x && typeof x === "object" ? JSON.parse(JSON.stringify(x)) : x);
// a transform's q is stored unit-length whoever writes it: the maths reads q as a rotation, and a scaled one skews every
// inverse. A zero or malformed q is left for the gate to refuse.
export function unitTransform(v) {
  const q = v && typeof v === "object" && !Array.isArray(v) ? v.q : undefined;
  if (!Array.isArray(q) || q.length !== 4 || !q.every(Number.isFinite)) return v;
  const n = Math.hypot(...q); return n >= 1e-6 && Math.abs(n - 1) > 1e-9 ? { ...v, q: q.map((x) => x / n) } : v;
}
/** `defaults`, then each `when` rule that holds, never over a field that's there. {value, filled: [fields written]}. A
 *  non-object value, or a name with no definition, comes back as it is. */
export function materialize(comp, v) {
  const def = defOf(comp);
  if (!def || !v || typeof v !== "object" || Array.isArray(v)) return { value: v, filled: [] };
  if (comp === "transform") v = unitTransform(v);
  const out = { ...v }, filled = [];
  const put = (set) => { for (const [k, x] of Object.entries(set)) if (!(k in out)) { out[k] = copy(x); filled.push(k); } };
  if (def.defaults) put(def.defaults);
  for (const r of def.when ?? []) {
    if (r.if && !Object.entries(r.if).every(([k, x]) => out[k] === x)) continue;
    if (r.absent && r.absent.some((k) => k in out)) continue;
    put(r.set);
  }
  return { value: out, filled };
}
/** Every default a name can write (its `defaults` and every `when` rule's), for tools that ask "is this one written?" */
export const defaultsOf = (name) => { const d = COMPONENTS[name]; return Object.assign({}, d?.defaults ?? {}, ...(d?.when ?? []).map((r) => r.set)); };

// ---- what a name means, pinned (PROTOCOL §4; a TRIPWIRE during the alpha) ----
// spec/registry-pin.json holds status, types, defaults, enums, ranges, required and absentMeans; pretrans-check D8 fails
// on a removal or narrowing (additions are fine; a late field needs absentMeans, D11). Re-pinning a break needs
// `bun tools/protocol/pretrans-check.ts --pin --ack "<why>"` (a line in spec/REGISTRY-CHANGELOG.md); stable never.
export function pinOf() {
  const out = {};
  for (const [name, d] of Object.entries(COMPONENTS)) {
    const p = { status: d.status ?? "trial" };
    if (d.type) p.type = d.type;
    if (d.fields) p.fields = { ...d.fields };
    if (d.defaults) p.defaults = copy(d.defaults);
    if (d.when) p.when = copy(d.when);
    if (d.enums) p.enums = copy(d.enums);
    if (d.ranges) p.ranges = copy(d.ranges);
    if (d.maxLen !== undefined) p.maxLen = d.maxLen;
    if (d.required) p.required = [...d.required];
    if (d.keyPattern) p.keyPattern = d.keyPattern;
    if (d.itemEnums) p.itemEnums = copy(d.itemEnums);
    if (d.scopeFields) p.scopeFields = { ...d.scopeFields };
    if (d.writtenBy) p.writtenBy = d.writtenBy;
    if (d.maxKeys !== undefined) p.maxKeys = d.maxKeys;
    if (d.absentMeans) p.absentMeans = { ...d.absentMeans };
    // what each field means, and its unit: the normative home of a component's meaning (#260)
    if (d.docs) p.docs = Object.fromEntries(Object.entries(d.docs).filter(([f]) => Object.hasOwn(d.fields ?? {}, f)));
    if (d.units) p.units = copy(d.units);
    if (d.grammar) p.grammar = { ...d.grammar };
    if (d.vocab) p.vocab = copy(d.vocab);
    if (d.keyed !== undefined) p.keyed = d.keyed;
    if (d.on) p.on = d.on;
    // reactions' handler kinds and their args are part of its meaning (the kinds are frozen)
    if (d.handlers) p.handlers = Object.fromEntries(Object.entries(d.handlers).map(([k, h]) => [k, Object.keys(h.args ?? {})]));
    if (d.reservedKinds) p.reservedKinds = Object.keys(d.reservedKinds);
    if (d.reservedFields) p.reservedFields = [...d.reservedFields];
    // what a reserved field will mean when it opens (physics: units, limits, enums), held as the absentMeans are
    // a nested grammar's closed vocabularies (structure's aperture kinds and wall axes)
    if (d.nestedEnums) p.nestedEnums = copy(d.nestedEnums);
    out[name] = p;
  }
  return out;
}
// is range b narrower than range a anywhere (a bound added, a lower bound raised, an upper bound lowered)?
const LOWER = (r) => (r.gt !== undefined ? [r.gt, 1] : r.min !== undefined ? [r.min, 0] : null);
function narrows(a = {}, b = {}) {
  const la = LOWER(a), lb = LOWER(b);
  if (lb && (!la || lb[0] > la[0] || (lb[0] === la[0] && lb[1] > la[1]))) return "its lower bound rose";
  for (const k of ["max", "maxLen", "maxItems"]) if (b[k] !== undefined && (a[k] === undefined || b[k] < a[k])) return `its ${k} fell`;
  return null;
}
/** Every break between a pin and now, as [{name, status, text}]: removals, changes and narrowings (additions aren't).
 *  status is the PIN's (what was promised): trial or reserved breaks may be re-pinned with an acknowledgement, stable never. */
export function pinBreakList(pin, now = pinOf()) {
  const out = [], j = (x) => JSON.stringify(x);
  for (const [name, p] of Object.entries(pin)) {
    const status = p.status ?? "trial"; const push = (text) => out.push({ name, status, text });
    const n = now[name]; if (!n) { push(`${name}: the name is gone (stored values need a repair or a translation; a stable name never goes)`); continue; }
    if (p.status !== undefined && p.status !== n.status) push(`${name}: status ${p.status} → ${n.status}`);
    for (const k of ["type", "keyed", "on"]) if (p[k] !== undefined && j(p[k]) !== j(n[k])) push(`${name}: ${k} ${j(p[k])} → ${j(n[k])}`);
    for (const [f, t] of Object.entries(p.fields ?? {})) if (n.fields?.[f] !== t) push(`${name}.${f}: type ${t} → ${n.fields?.[f] ?? "gone"}`);
    for (const [f, v] of Object.entries(p.defaults ?? {})) if (j(n.defaults?.[f]) !== j(v)) push(`${name}.${f}: default ${j(v)} → ${j(n.defaults?.[f]) ?? "gone"}`);
    for (const r of p.when ?? []) if (!(n.when ?? []).some((q) => j(q.if) === j(r.if) && j(q.absent) === j(r.absent) && Object.entries(r.set).every(([f, v]) => j(q.set?.[f]) === j(v)))) push(`${name}: a conditional default changed: ${j(r)}`);
    for (const [f, vals] of Object.entries(p.enums ?? {})) for (const x of vals) if (!(n.enums?.[f] ?? []).includes(x)) push(`${name}.${f}: ${j(x)} is no longer allowed`);
    // ranges, maxLen and required entered the pin with status: a pin from before holds none of them, so none is judged
    if (p.status !== undefined) for (const f of new Set([...Object.keys(p.ranges ?? {}), ...Object.keys(n.ranges ?? {})])) { const why = narrows(p.ranges?.[f], n.ranges?.[f]);
      if (why && Object.hasOwn(p.fields ?? {}, f)) push(`${name}.${f}: its range narrowed (${why}): ${j(p.ranges?.[f] ?? {})} → ${j(n.ranges?.[f])}`); }
    if (p.status !== undefined && n.maxLen !== undefined && (p.maxLen === undefined || n.maxLen < p.maxLen)) push(`${name}: maxLen ${p.maxLen ?? "none"} → ${n.maxLen}`);
    for (const [f, vals] of Object.entries(p.itemEnums ?? {})) for (const x of vals) if (!(n.itemEnums?.[f] ?? []).includes(x)) push(`${name}.${f}[]: ${j(x)} is no longer allowed`);
    // a reserved field that opens (moves into fields) is an addition; one that leaves both lists frees a held name
    for (const f of p.reservedFields ?? []) if (!(n.reservedFields ?? []).includes(f) && !Object.hasOwn(n.fields ?? {}, f)) push(`${name}.${f}: a reserved field is gone (its name is no longer held)`);
    for (const [f, vals] of Object.entries(p.nestedEnums ?? {})) for (const x of vals) if (!(n.nestedEnums?.[f] ?? []).includes(x)) push(`${name}.${f}: ${j(x)} is no longer allowed`);
    for (const [f, t] of Object.entries(p.scopeFields ?? {})) if (n.scopeFields?.[f] !== t) push(`${name}.scope.${f}: type ${t} → ${n.scopeFields?.[f] ?? "gone"}`);
    if (p.status !== undefined && n.writtenBy !== undefined && n.writtenBy !== p.writtenBy) push(`${name}: now written by ${n.writtenBy} only`);
    if (p.status !== undefined && n.keyPattern !== undefined && n.keyPattern !== p.keyPattern) push(`${name}: keys ${p.keyPattern ?? "any"} → ${n.keyPattern}`);
    if (p.status !== undefined && n.maxKeys !== undefined && (p.maxKeys === undefined || n.maxKeys < p.maxKeys)) push(`${name}: maxKeys ${p.maxKeys ?? "none"} → ${n.maxKeys}`);
    if (p.status !== undefined) for (const f of n.required ?? []) if (!(p.required ?? []).includes(f) && Object.hasOwn(p.fields ?? {}, f)) push(`${name}.${f}: now required`);
    for (const [f, m] of Object.entries(p.absentMeans ?? {})) if (n.absentMeans?.[f] !== m) push(`${name}.${f}: its meaning of absence ${j(m)} → ${j(n.absentMeans?.[f]) ?? "gone"}`);
    for (const [f, m] of Object.entries(p.docs ?? {})) if (Object.hasOwn(n.fields ?? {}, f) && n.docs?.[f] !== m) push(`${name}.${f}: its meaning ${j(m)} → ${j(n.docs?.[f]) ?? "gone"}`);
    for (const [f, u] of Object.entries(p.units ?? {})) if (Object.hasOwn(n.fields ?? {}, f) && j(n.units?.[f]) !== j(u)) push(`${name}.${f}: its unit ${j(u)} → ${j(n.units?.[f]) ?? "gone"}`);
    for (const [f, g] of Object.entries(p.grammar ?? {})) if (n.grammar?.[f] !== g) push(`${name}.${f}: grammar ${g} → ${n.grammar?.[f] ?? "gone"}`);
    // a closed vocabulary (roles.vocab: ranks, built-in ids, permissions, the custom-id pattern, reserved ids): ANY difference
    // changes what a stored grant or role-def means (a freed id, a new reserved one), so additions break too: never silently
    for (const [f, v] of Object.entries(p.vocab ?? {})) if (j(n.vocab?.[f]) !== j(v)) push(`${name}.${f}: vocabulary ${j(v)} → ${j(n.vocab?.[f]) ?? "gone"}`);
    for (const [k, args] of Object.entries(p.handlers ?? {})) { if (!n.handlers?.[k]) { push(`${name}: handler kind ${k} is gone`); continue; }
      for (const a of args) if (!n.handlers[k].includes(a)) push(`${name}.${k}: handler arg ${a} is gone`); }
    // PROTOCOL §4: a field added after the name's first registration says what an older value WITHOUT it means (a value
    // stored before never holds it, and materialize never rewrites the past), and that meaning is pinned
    for (const f of Object.keys(n.fields ?? {})) if (!Object.hasOwn(p.fields ?? {}, f) && !(typeof n.absentMeans?.[f] === "string" && n.absentMeans[f].trim()))
      push(`${name}.${f}: added after ${name} was first registered, with no meaning of absence (absentMeans.${f}: what an older value without it means)`);
  }
  return out;
}
/** What changed meaning between a pin and now, as lines. [] = nothing. */
export const pinBreaks = (pin, now = pinOf()) => pinBreakList(pin, now).map((b) => b.text);
/** {ok, why?, changelog?}: with no breaks, yes; with breaks only on trial or reserved names, only with an acknowledgement
 *  (`ack`, the why), the changelog line saying what and why; a stable name's break, never. `date` stamps the changelog line. */
export function pinVerdict(pin, now = pinOf(), ack = null, date = new Date().toISOString().slice(0, 10)) {
  const breaks = pinBreakList(pin, now);
  const stable = breaks.filter((b) => b.status === "stable");
  if (stable.length) return { ok: false, breaks, why: `these change a STABLE name's meaning (a changed meaning is a new versioned name; no acknowledgement re-pins it):\n  ${stable.map((b) => b.text).join("\n  ")}` };
  const why = typeof ack === "string" ? ack.trim() : "";
  if (breaks.length && !why) return { ok: false, breaks, why: `these change a trial or reserved name (allowed during the alpha, but never silently): re-pin with --ack "<why>", which writes spec/REGISTRY-CHANGELOG.md:\n  ${breaks.map((b) => b.text).join("\n  ")}` };
  return { ok: true, breaks, ...(why ? { changelog: `- ${date}: ${why}${breaks.length ? `\n${breaks.map((b) => `  - ${b.text}`).join("\n")}` : ""}\n` } : {}) };
}

/** {min?, gt?, max?} as the door judges a number against it, and the words it refuses with. `fmt` writes each bound (the
 *  editor's degrees); without it the bounds read as the door has always written them. */
export const outOfRange = (r, n) => (r.min !== undefined && n < r.min) || (r.gt !== undefined && n <= r.gt) || (r.max !== undefined && n > r.max);
export const rangeWords = (r, fmt) => [r.gt !== undefined ? `> ${fmt ? fmt(r.gt) : r.gt}` : r.min !== undefined ? `≥ ${fmt ? fmt(r.min) : r.min}` : "", r.max !== undefined ? `≤ ${fmt ? fmt(r.max) : +r.max.toFixed(4)}` : ""].filter(Boolean).join(" and ");

export const PENDULUM = { type: "pendulum", axis: [1, 0, 0], amp: 0, period: 2.4, damp: 0.08, maxAmp: 0.9, phase: 0 };
