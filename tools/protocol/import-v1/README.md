# import-v1: the one-way importer for old (v1) worlds

Everything here exists to read a world saved on disk in the first protocol's format (a `log.jsonl` of v1 verbs) **once**,
and write it out as a new v4 world. Nothing at runtime uses it: the server, the browser client and the agents speak v4
only, and a directory that holds only an old log is refused at open. It lives under `tools/`, so the server never serves
it and nothing at runtime can load it; `tools/protocol/nov1-check.ts` (in `bun run test:protocol`) fails if anything under
`client/`, `mcpl/`, `server/` or `shared/` imports anything under `tools/`.

| file | what it is |
| --- | --- |
| `fold.js` | the old fold (how a v1 entry changed the world), trimmed to what the translators read |
| `translate-v1.js` | v1/v2 log → v4 log: each old entry becomes an `imported` act (`body {verb, args, from}`: its verb and args, kept as provenance) or a `say`, and one change entry that brings the v4 fold to the same place, checked after every entry. `DEFERRED` + `deferredFeatures(log)`: the features v4 does not carry yet (water volumes, air boxes, climb routes, vehicles, collision toggles) and every use of one in a log; `translateV1World` refuses on any |
| `translate-d3.js` | the name her four dialect-3 goldens are checked under (sweep §3): a thin wrapper over `translate-v1.js`, which runs her sim (the first eidosim, `eidosim-v1.js` here) beside the v1 fold whenever a log enters a physics `epoch`. Since @11 a punt stays its `imported` act and each rest is a plain change by `sim` caused by it: no launch, no digest, nothing that asks a reader to fly her engine. The epoch becomes `@world physics-engine` (today's eidosim from then on), and each collider's stamped box its `physics.shape`, `dynamic` for a thing v1 ever punted and `static` otherwise. A log with no epoch translates as one without her sim would |
| `eidosim-v1.js` | the first eidosim (dialect 3), kept here so the translator, the sweep and the directory check can read what a physics-era v1 log's punts did; nothing at runtime loads it (the server runs `eidosim@1.0.0`) |
| `eidosim-v1-test.ts` | its covenant tests (self-agreement, schedule independence, quantization), run on the copy kept here (suite `eidosim-v1`) |
| `frozen/` | every module the old fold reads (forecast, captions, rot, blueprint, chatwindow, and what they import: components, euler, hierarchy, scale3, simmath), byte for byte as they stood at 6dab22f5 (2026-10-04, the commit where the server stopped reading v1 worlds), so a change to the live `shared/` modules never changes what an old log means. Its import closure stays inside this directory (importer-check IM-I3b) |
| `build.ts` | the old fold's build hash, stamped into a translated world's `translated` act |
| `world.ts` | `reportV1World(src, {name})`: the dry-run report and its hash (nothing written). `translateV1World(src, dest, {name, approval})`: refuses a founder key (a translation names none), reads `src/log.jsonl` (never writes it), refuses a log using a `DEFERRED` feature, translates, re-reads the result with the strict reader (and, for a physics-era log, the live host's sim layer, which must read the whole history without a disagreement and find nothing to fly: each rest is already a plain change), maps every old name to a door identity, then writes `dest/world.jsonl`; a failure after that removes what it made again |
| `snapshot-oracle.ts` | the translator against the OLD ENGINE (suite `oracle`): every old world whose `snapshot.json` is a complete fold of its log (seq and bytes match) is translated for real, and its fold (and the server's lifted load) compared with the snapshot, through the translator's mapping and also field by field off the snapshot. Incomplete snapshots are skipped, never compared. Given a world translated in place, it reads the kept originals (`log.original.jsonl`, `snapshot.original.json`). `OPT_DIR=<serving checkout>/assets/opt` gives store models their real addresses. Method: `docs/TRANSLATING-OLD-WORLDS.md`, "The snapshot oracle" |

The operator runs it, in place, in two steps (review of PR #260, item 6: the approval is bound to the exact dry-run
report before anything moves). **A translation names no founder and carries no owner's signature** (#260 rereview,
blocker 1): v1 logs record accounts, never keys, so nothing can yet bind a key to the old world's owner, and a key handed
to the tool would be the operator's choice, recorded as "the owner approved" and installed as tier 0. `--founder-key` and
`--approve-sig` are refused before anything is written. Until something can attest that a key is the v1 owner's (a
home-node attestation, later), the one path is `--no-founder-key --operator-only-no-owner`: tier 0 stays empty, and the
record says no owner was attested.

1. **The dry run.** `WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <world> --dry-run --no-founder-key`. It writes
   nothing and prints the report (`reportV1World` in `world.ts` here): the old log's size and sha256, the translator and
   fold build, `founderKey: null`, the counts, the `DROPPED` table (what every translation drops or renames by design, from
   `translate-v1.js`), `deferred` (uses of features v4 doesn't carry yet: `DEFERRED` — water volumes, air boxes, climb
   routes, vehicles, collision toggles; any means the translation is refused, naming each use) and `report-hash <sha256>`.
   Nothing in it varies between runs, so the same log and tool always hash the same.
2. **The translation, bound to that hash.** `translate <world> --no-founder-key --approved <hash> --operator-only-no-owner`.
   The report is recomputed from `log.jsonl` as it stands: a different hash (the log grew, the tool changed) is refused with
   both hashes named. Without `--operator-only-no-owner` it is REFUSED: no owner can sign, and the operator says so,
   knowingly. The tool **countersigns** with this host's custody operator key (`.custody.json` `operator`, never the
   sequencer key) over `eidoverse-approve-translation:<world>:<hash>`, and the writer checks it itself before the log is
   written (`approvalProblem`): a countersignature missing, not verifying, or over another hash or world, an approval
   carrying an owner's signature, or a founder key handed to `translateV1World` refuses by name. The approval is in the new
   world's log, the system's `translation-approved` act right after `repair-shapes`:
   `{report, approval: {over, owner: null, operator: {key, sig}, noOwner}}`, `noOwner` saying in words that no owner was
   attested. A refused report can't be approved.

The world keeps its name, so links to it keep working (the Commons is cut over with `translate commons --no-founder-key --approved … --operator-only-no-owner`). It
is translated into a temporary sibling directory (`.translating-<world>-…`, never served) and verified there first: the
importer's own checks (0 divergences, projection equality, strict read-back), the result opened as the server opens it
(same digest), and, when the directory holds the old server's `snapshot.json`, `snapshot-oracle.ts`'s agreement with it
(a snapshot the oracle can't compare, a partial one or a physics-era log's, is reported as not compared). Only then is
it swapped in: `world.jsonl` lands in the world's directory in one rename, and the old files are renamed beside it,
`log.jsonl` → `log.original.jsonl`, `snapshot.json` → `snapshot.original.json`, `poses.json` → `poses.original.json`:
the same files, never rewritten or deleted. The old log must hold exactly the bytes that were translated (their size
and sha256, recorded in the temporary directory as `.source.json`) right before the swap and again after its last
rename: an old server still writing to it refuses the swap (stop it, then translate again), and the recovery of an
interrupted swap checks the same before it moves anything. The identities the translation mints join the shared
directory only once the swap has succeeded (kept until then in the temporary directory as `.identities.json`, which the
recovery of an interrupted swap writes): a failed attempt leaves none behind, so retries don't pile up unused ones. On any failure, before or during the swap, whatever moved is
put back, the temporary directory is removed, and it says why. A directory whose `world.jsonl` is a world is served as one, so the
kept `log.original.jsonl` never makes it look old; translating it again refuses. `translate <old world> <new name>`
still translates into a new name instead, leaving the old directory exactly as it was (the same dry run and approval).

**Rollback.** The swap moves these: `world.jsonl` in; `log.jsonl` → `log.original.jsonl`, `snapshot.json` →
`snapshot.original.json`, `poses.json` → `poses.original.json`; then the new `poses.json` (keyed by identity),
`world.mod.jsonl` (the v1 bans, filed as the moderator's record) and `translation.json` in; and only then the minted
identities into the shared directory (`.directory.json`). `translation.json` is the record of all of it: every rename,
every made file with the sha256 it was made with, the identities, the report hash and the approval.
`WORLDS_DIR=<dir> bun tools/protocol/world.ts rollback <world>` (stop the server first) removes the made files, renames
the originals back (the same files: bytes, inode and mtime unchanged), forgets the minted identities that nobody has bound
or renamed since (`directory.forgetPlanned`), and removes the manifest: the world directory is byte-identical to before
the translation (inplace-check IP24 proves it file by file), and the world translates again. The shared directory is not
restored from a copy: it is rewritten without the forgotten identities, so it holds the entries it held before (the same
bytes when nothing else changed it meanwhile, as IP24 checks), and a directory file the translation itself created stays,
holding none of them. A
made file the server has written to since (the v4 world's acts, places, bans) refuses the rollback unless
`--discard-changes`. The content-address index (`OPT_DIR/eido-index.json`) is a cache of library bytes, not world state,
and is left. A directory translated before 2026-10-18 has no manifest: `rollback` says so and what to rename by hand. At boot the server prints, for
each old world, the exact in-place commands, with `WORLDS_DIR` filled in and a
placeholder for the report hash (`server/oldworlds.ts` `bootNotice`). A visitor is told in plain words that the world
needs a one-time conversion by whoever runs the server and that nothing is lost (`visitorText`; the browser keeps that
sentence on its splash, suite `refusedjoin`). The sweep
(`tools/protocol/sweep.ts`, in `test:protocol`) translates every old world log it can find and requires zero divergences.

**This directory is temporary.** It stays only until the live Commons has been cut over to v4 (decided 2026-10-06); a
follow-up change, about a month after that cutover, deletes this directory, the sweep's v1 half and the v1 fixtures in
`spec/fixtures/`.

## The Commons and governance keys (PROTOCOL §13)

A translated world's genesis names its governance keys, and genesis never changes. **A translated world's tier 0 stays
empty**: nothing can yet bind a key to the v1 owner (above), so the translation names no founder, and the host's operator
key is tier 1. Governance is reserved (§13); the reserved draft must allow ONE attested fill of a translated world's empty
tier 0 later, once something (a home-node attestation) can vouch that a key belongs to the world's v1 owner. The public
Commons was founded by **antra**; its owners (antra, fable, janus, mica, from the v1 log's grants) and builder (Digi_Rat)
come across as `roles:<id>`, because roles are rights inside the world and governance keys are a separate list (§7, "two
owner lists, never confused"). Neither R's key nor Burrow's goes in tier 0.

Before the cut-over, **back up the host's custody** (`WORLDS_DIR/.custody.json`: the file `.custody.json` in the worlds
directory itself; a worlds dir saved before the 2026-10-07 names pass may still hold it as `.v4-custody.json`, renamed
on first use) off this machine: it holds the sequencer and operator keys. Lose it and the Commons can never sign another head; the only way on is a fork.

### A founder's own key, for a world FOUNDED new

Founding a brand-new world is a different path: there is no prior owner to bind, and the founder brings their own key,
which `create-world {ownerKey}` puts in tier 0 (without one, tier 0 is empty). The key is made, and proven, like this:

1. **The founder makes a key on their own machine.** The private half never leaves it. With OpenSSL (any recent
   version):

       openssl genpkey -algorithm ed25519 -out eidoverse-owner.pem
       printf 'ed25519:%s\n' "$(openssl pkey -in eidoverse-owner.pem -pubout -outform DER | tail -c 32 | base64 | tr '+/' '-_' | tr -d '=')"

   Keep `eidoverse-owner.pem` offline and backed up: it is the only thing that can reclaim, rewind or re-key the world
   from the top.
2. **They prove it's theirs, and that the text is spelled right**, by signing the key text with it and sending the
   public key and the signature (both are safe to share):

       KEY=ed25519:…   # the line printed above
       printf 'eidoverse-owner-key:%s' "$KEY" > msg.txt
       openssl pkeyutl -sign -inkey eidoverse-owner.pem -rawin -in msg.txt | base64 | tr -d '\n'; echo

3. **The operator checks it** (nothing is written): `bun tools/protocol/world.ts owner-key <KEY> <signature>`. It says
   `ok` only when the signature verifies over `eidoverse-owner-key:<KEY>`.

## eidosim-v1 versions

`eidosim-v1.js` carries every retired version of the first eidosim (Covenant II: an old log replays under the law it
was written under, bit for bit). `SIM_ID` is what an epoch minted last (`eidosim@0.5.0`); `CARRIED` is what this build
can still replay. An epoch naming any other sim is foreign: it is recorded and never recomputed (`epoch.foreign`, and
`advanceSim` only moves the tick). Each version below is gated by name, so adding one never moved an earlier one's bits.

- **0.1.0, flat floor.** Ground is the body's own starting height. That is right on build pads and wrong on slopes: a
  flight lands on an invisible floor at its launch altitude. Its advance law is untouched, so 0.1.0 epochs replay to
  the same bits they always did.
- **0.2.0, terrain ground.** The sim folds the world's `terrain` entries and grounds every body on
  `shared/terrainmath.js`, the client's height law in exact ops (≥ 99.8 % bit-identical to the mesh the client walks,
  worst divergence about 1e-15). A grounded body is glued to the terrain while it slides, and a flight meeting rising
  ground stops at the contact. A `terrain` entry under a live epoch re-grounds the world: every body is released to
  the instant fold. A world with no terrain keeps the flat floor.
- **0.3.0, things are colliders.** The sim folds the boxes the sequencer stamps into history (Covenant III: an asset's
  geometry is not in the log until the sequencer writes it there): `epoch.boxes` (library path → `[[min], [max]]` for
  every model standing at the barrier) and `spawn.box` for each model spawned later. Every fold entity with a known box
  is a static collider (the world AABB of its yaw-rotated, scaled box); a punted body carries its own. A body in
  flight lands on a static whose top it was above and whose footprint it overlaps (the same contact law as terrain); a
  static met from the side pushes it out along the shallower horizontal axis and reflects that velocity, scaled by
  `RESTITUTION`. A grounded slider that loses its support by more than a step falls rather than gluing. A body that
  comes to rest becomes a static again. Out of scope: flying bodies don't collide with each other, a resting body is
  not woken by a hit, and a thing that mounts, follows a motion or has no box is not a collider.
- **0.4.0, swept.** 0.3 tests collisions at the end of each tick, so a fast body can cross a thin wall between two
  endpoints (#160: a 0.2 m body at power 20 rests 30 m past a 0.1 m wall). 0.4 sweeps the body's AABB along the tick's
  displacement against every static (a slab test, exact ops) and resolves the earliest contact at the contact point: a
  top met from above is a landing, a side a wall bounce, and the rest of the tick's motion is spent there. States that
  already overlap keep 0.3's endpoint resolution. Constants and order are unchanged.
- **0.5.0, contacts consume time.** After a contact the remaining movement is swept again, so a zero-time contact with
  a deck cancels downward gravity without cancelling horizontal sliding. At most eight contacts a tick; when they run
  out, the body stays at the last safe contact.

## Translator versions

`TRANSLATOR` and `TRANSLATOR_SIM` in `translate-v1.js` say which output a translation is: either name is bumped on any
change to the output, and two translators never share a name (`translatorVersion` parses the number; compare numbers,
never a pattern of digits). Both are `eidoverse/translate-v1@20`. What each version changed, in order (a later entry
can replace an earlier rule; the current code is the truth):

- **@3.** Genesis on PROTOCOL §2.4 and §3d. A v1 world has no keys, so the translating door's key is the sequencer and
  the only governance key, in tier 1 (tier 0 empty). The nonce is the first 16 bytes of the sha256 of the source log's
  lines, so translation is a pure function. `translatedFrom` can't sit in genesis, so it is the `translated` act right
  after it. v1's owners become `@world` roles from its grants. (Since then a real authority passes its own operator key
  for tier 1 and a random nonce: `translatedGenesis`.)
- **@4.** A v1 `fly: true` grant becomes `roles:<id>.can.fly`.
- **@5** (two parallel bumps). `story` is a component (`{title, text, marks?}`): a v1 story's `practice` becomes a
  paragraph of its text and `markedEntity` its marks, and both also ride in the carried story beside it. A v1 `door`
  component is `openable`, and a reaction naming `door` names `openable`. A spin's `rpm` is `degPerSec` (rpm × 6). An
  orbit's center/face/period and a path's points/speed/duration/loop stay in the motion.
- **@6.** The two @5 outputs merged.
- **@7, the renamed protocol.** A result entry is kind `change`; the translating door's entries, and a v1 entry whose
  actor was `door`, are actor `system`. Everything carried only from translation is one `imported` family: the act verb
  `imported`, `imported:<k>`, `imported-behavior:<k>`, `imported-bans:<id>`. A v1 `gen` grant is `can.generate`. A
  light's `keep` is `important`; a palette entry is `assets:<k>`; a dialect-3 epoch's engine is `@world
  physics-engine`; a mount's parent names its socket as `socket` (v1's `slot`). Every log's output changed.
- **@8.** A model was written as `eido:sha256/<hex>` in place of its library path (replaced at @12).
- **@9, particles.** A v1 `particles` bag is today's instance: its preset is the effect, its origin `at`, its seed
  stays, and count, size, opacity, speed, lifetime, area, texture and quality are the params every Essential declares
  (`shared/particle_effects.js` `modernize`). A key neither spelling knows rides in `imported:particles`.
- **@10.** A dialect-3 log is translated with the first eidosim run beside the v1 fold, as `translate-d3.js` did alone
  before. Punts were written as launches with stamped state and each rest as a checked result. Superseded by @11. A log
  with no epoch translated byte for byte as @9, so it kept @9's name.
- **@11.** The runtime no longer carries the first eidosim, so nothing in a new log asks a reader to fly it. The sim
  still runs here and says where each punt came to rest, but a punt stays its imported act, each rest is a plain
  change by `sim` caused by that act (no digest), the world's engine is today's eidosim from the epoch on, and a thing
  v1 ever punted is a `dynamic` collider, every other one `static`.
- **@12, the shape audit.** No account subject (`sub`) is written in roles or imported bans (refined at @16 and @20). A
  refused dialect-3 epoch is carried as `imported:epoch`. A stored value's old spelling is written in today's, by the
  same rules the server's load applies (`shapeRepaired`, `shared/protocol/shaperepair.js`), and a parent carries no
  order. Render: a light carries decay 1.7 (the rig's old falloff) and `daytime`; `@world`'s sky, terrain, water and
  grass are in today's spelling. A model stays its library path, with `model-hash sha256:<hex>` beside it when the
  resolver knows the bytes; a particle Essential and a grass preset keep their names. A lock is `{rank: 'builder'}`.
  Sockets stay the v1 map with each seat's body block; the server's load lifts them to socket children.
- **@13.** Every translation writes the system's `repair-shapes` act right after `translated` (the shape repair's
  once-per-world marker). The projection is @12's; the log is one entry longer.
- **@14.** A motion's type is written in today's spelling: v1's back-and-forth along an axis is `oscillate`
  (`motionType`).
- **@15, named emitters.** A v1 `particles:<name>` (name: 1–32 of `A–Z a–z 0–9 _ -`) on X becomes a child thing of X
  (parent `{to: X}`, label `<name>`, at X's origin) whose `particles` is that emitter in today's spelling. Its id is
  `emitterChildId` (the same from every translation) and its seed the one v1 drew it with
  (`hashSeed("<X>:particles:<name>:<preset>")`) unless it wrote one. Putting it out removes the child. A malformed
  `particles:…` key is carried like any unknown component. v1's look and motion knobs ride in `imported:particles`, and
  its `scale` is the instance's scale.
- **@16.** No account subject is written anywhere. A property named `sub` or ending in `Sub` whose string has an
  account's shape is one, at any depth (`withoutAccounts`): in an imported act's args it becomes the person's id when a
  mapper is given and is dropped when none is; in a value it is always dropped. Other strings under such names stay. A
  binding's author is found through its account, as the author's grant is.
- **@17.** The base rung is `inhabitant` (v1's visitor), with nothing below it. A person's v1 spectator or none grant
  is carried as `imported-roles:<id>` with no `roles:<id>`, so they hold the world's newcomer role. The door's own
  words (`*` none/spectator) still become access.
- **@18.** An approved translation's `translation-approved` act is written by translate itself, so every later change's
  cause is the act it answers. v1's captions bag (a window of lines) becomes today's current line (`newCaptions`), the
  old fold reading its own frozen modules (`frozen/`). A caption deed is a place in its screen's captioners. A spin's
  rpm and a seat's yaw are read as the renderer coerced them, and what can't be read is carried. An earlier epoch's
  rest tick never dates a later epoch's rest.
- **@19.** An old name already in the hashed form (`h--` + 61 hex) is escaped like any other name, never kept as that
  id (`encRaw`): old logs never held one, and keeping it let a long name and a raw name equal to its hashed form
  collide. A motion whose amplitude was null is carried as `amp` 0, as the old reader read it, where @18 dropped it.
- **@20.** A name is joined to an account only where v1's server wrote the pair itself: a grant's or ban's `sub`
  beside its id, a spawn's or light's placer `{id, sub}`, a behaviour's `bySub`, the act's own actor. Elsewhere, a name
  beside an account is data: the account becomes its person's id and the name is joined to nothing, so no value in the
  log moves anyone's acts or role to another person. A binding's author is its `bySub`'s person. The translated act's
  copy of the old genesis carries no account either. A component whose name has an account's (`ownerSub`) and whose
  whole value is an account is left out of the state. An account is any shape a join wears (`human:`, `agent:`,
  `aid1:`, `local:`). A role or ban keyed by an account is that account's person; the placer and `bySub` pairs join a
  name to its account before any act is read (`world.ts`), as a grant's do.
