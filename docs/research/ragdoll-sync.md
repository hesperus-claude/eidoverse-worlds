# Ragdoll sync: one owner, a takeover for drags, the same solver headless

Covers `client/lib/ragdoll.js` (the Verlet engine), `client/lib/bodydrag.js` and `mcpl/physics.ts`. The engine
itself is a choice (`bodysim.js`: Bullet by default, Verlet as the fallback); the sync model below is the same for both.

## Single authority, not determinism

Making physics deterministic across machines is unwinnable, so it isn't attempted. Instead:

- only the body's **owner** simulates (you own your avatar); nobody else runs physics for it;
- the owner streams sparse bone rotations on the presence `pose` field, the channel a held pose already uses, so
  remotes render a tumble with no new receiver code: it is a pose that changes every frame;
- when it settles, the owner captures the bones as a held pose, so a late joiner or a reconnect gets the result,
  never a replay; a permanent result commits as a `pose` verb. An unpinned tumble always ends as a held pose (a capture is
  forced after a deadline; a shove restarts it, a held body never deadlines), so presence never streams forever.

Physics lives on the presence plane (lossy, ephemeral, one authority) and only its outcome becomes state. The server
never simulates and never sees a bone.

## Why Verlet carries mass, volume, handedness and a fixed step

The Verlet skeleton is small and stable, not a jointed rigid-body solver, but four things were needed for it to read:

- **mass**: every constraint splits by inverse mass, so a hand can't throw the pelvis around;
- **volume**: bones are capsules, not beads; colliding only the joints left every shaft hollow, and limbs passed
  through the torso on every shipped rig;
- **handedness**: knees and elbows bend one way, from a body frame the particles themselves supply (`_frame`);
- **a fixed step** (`FIXED_DT`): Verlet's inertia term is a position delta, so raw frame time made the result a
  function of the framerate (several times the bone stretch at 30 fps as at 60, landing the body metres apart).

Everything anatomical is measured from the rig at construction: shipped avatars disagree on height (by more than 2×),
rest pose (T to A) and whether an upperChest + shoulder pair sits between chest and arm, so absolute numbers tuned
on one body are wrong on the next.

## Dragging is a takeover

The precedent is the seat: while seated, something else owns your body's place, and movement input means "I want
out". A drag is that with a sim attached:

- the **dragger** sims its own copy of the target's rig (the sim doesn't care whose body it is), the grabbed joint
  pinned to the cursor ray: zero latency where the hand is;
- it streams pose and root to the **owner** (a targeted `bodydrag` relay, presence semantics, never logged), who
  applies them and rebroadcasts through its normal presence: one source of truth, nothing new for anyone else;
- consent is the owner's: the grab is a request (the server refuses it unless displace consent allows; the owner refuses unless its body is
  downed and not already dragged), a movement key revokes mid-drag, and 1.2 s of
  dragger silence (`SILENCE_MS`) auto-resumes, so a crashed dragger never leaves a body possessed;
- on release the owner settles from where it was left, so the body lands under the authority that owns it. The
  takeover is only ever the moving part.

An agent body only has to accept and rebroadcast, which it already does for puppet poses, so agents can be dragged
too.

## Headless bodies run the real solver

A headless agent has no renderer, but the tumble never needed one: the solver drives bone nodes and emits the same
sparse pose a browser streams. So a pushed agent tumbles on its own side instead of being told it fell.

- **The skeleton only.** Joint rest positions are parsed from the VRM's GLB JSON (`shared/rig.js`: no meshes, no
  textures), wrapped in a stand-in avatar whose bone nodes are what the solver drives. The engine is Bullet, as in
  the browser (`AGENT_BODY_ENGINE`, default `ammo`, with Verlet as the fallback): a different solver would swap
  models mid-fall on every drag release.
- **Loading.** `client/lib/ragdoll.js` imports `./core.js`, which builds a WebGPU renderer at import, so headless
  loads go through a Bun plugin that swaps in a CPU core; hence lazy, async exports. If the sim can't load the agent
  falls back to the slump.
- **World coordinates.** The sim once ran on flat ground offset by one terrain sample at the fall site, blind to
  slopes and placed structures, so a body released over a raised floor settled through it (#17). It now runs in
  world coordinates: the caller hands over the terrain height function (`setHeightField`) and registers supports,
  fitted from the model's own triangles where it decodes (`registerMeshSupport`, which the walking feet use too:
  `standOn`), else from the server's `/geom` floors (`registerSupport`, `registerSupportGrid`). Where it differs from
  the browser: per-axis and negative scales are fitted as drawn, while the browser's colliders read one scale.
- **Module state.** Terrain is module state in the client libs, so the caller re-asserts its height field before
  each `begin()`. Colliders are scoped per world (`inWorld`), so a body in one world doesn't stand on another
  world's floor at the same coordinates.
