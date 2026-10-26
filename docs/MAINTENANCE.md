# The maintenance command — the operator's procedure

Informative (recut C19, 2026-10-21). spec/PROTOCOL.md §4 keeps the rule: a load never writes; stored values are rewritten
only by one explicit maintenance command, as the system's own recorded acts (`lift-sockets`, `rename-components`,
`repair-shapes`, each carrying `command: "repair"` and `by`). This is how an operator runs it.

- From a shell on the host: `bun tools/protocol/world.ts repair <name>`.
- From inside the world, as a server operator: `operator-repair {verb: "repair"}` (the acts carry `operator: true`).

A world that needs a step whose old shape no reader serves refuses every write (not `leave`) with `repair-needed`, whose
text names the command. Each step is backed up first and can be rolled back.

## `repair-shapes`: what the shape repair rewrites

`shared/protocol/shaperepair.js` turns a value stored before the shape audit into today's spelling, with the meaning its
readers gave it. It is pure: a thing's components in, the repaired components out. Three callers share one rule set: the
repair command (`maintain`'s `repair-shapes` step, never a load: one system `repair-shapes` act, ONCE per world), the old-world
translator's projection (translate-v1@12 and later, so a translated world needs no repair and is marked), and the snapshot
oracle's `liftPlain`, which repairs its projection only when the translated log is unmarked.

The rules that read an absent field may only ever see values stored before the audit. That is the marker's job, not the
rules': `shapesMarked` is true once the log holds the system's `repair-shapes` act, a founding `create-world` stamped with
`shapes`, or a translation by translate-v1@12 or later; a purged marker reads as marked, since re-running a one-way rewrite
is the unsafe side. A thing whose repair would write a purged value is left alone.

On a thing:

- **motion.** A bare `motion` naming a `part` becomes that node's motion, `motion:<partSlot(part)> {node: part}` (a motion
  already on that node wins). A keyed `motion:<tag>` with no `node` gets its key's tag as its node (the node's name, before
  the node was data). `amplitude` → `amp` (`amp` wins). A letter axis (`x`, `y`, `z`, `-x`, `-y`, `-z`) → its vector. A
  pendulum with no `period` read 3.5 s and with no `damp` 0: both are written down. A whole motion's `pivot` field → the
  thing's `pivot` component (when it has none). A whole pendulum with no pivot component swung about `[0, 2, 0]`: that point
  is written as its pivot component, because a whole thing now turns about its origin when it has none.
- **collider.** `shape: exact` → `mesh`.
- **physics.** No `kind` read as the old materialized default, `dynamic`: written. `material` → `surface`. `layers`,
  `mask` and `ccd` (never read) are dropped.
- **light.** No `decay` fell off as three.js decay 1.7: written (a new light's default is 2). `day` → `daytime` (true →
  `dim`, false → `full`); no `daytime` → `dim`. `shadows` (read by nothing) is dropped.
- **model.** A content address `eido:sha256/<hex>` → the library path this host's index names for it, with the hash beside
  it as `model-hash: sha256:<hex>`. Only with a resolver (the command passes the catalogue's `pathOf`); an address no file
  here names is kept, and still loads.

On `@world` (`repairWorld`):

- **sky.** `clock: 'real'` (+ `dormantRated {hours, rate, ts}`) → a `tz` (`America/Los_Angeles` when it had none), with
  `hours`/`rate`/`ts` the parked clock it falls back to; another clock → no `tz`. `azimuth` degrees → radians (a turn past a
  full one wraps). `weatherSeconds` → `transition` (dropped when it is 0 or over 600 s); a forecast's `dwellSec` /
  `transitionSec` → `dwell` / `transition`. `sun`, `fill` and `world` are dropped. The registry's sky defaults are written
  where absent (they were the old readers' readings of absence). Not idempotent on a sky (azimuth converts every time):
  that is why the marker exists.
- **terrain.** Layer colours `"#rrggbb"` → ints; a noise terrain gets the sim's defaults where absent; `terrain.water` →
  the `water` component (its colour an int).
- **grass.** The first protocol's grass knobs → the flora spelling (the door's own mapping); a preset is kept by its name.

A particle Essential's name and a grass preset's name are stored as written: nothing rewrites them to an address.

Separate from the marker-gated repair, and idempotent: `rename-components` renames `@world.trusted` to
`trusted-components`, a grabbable's and a station's `pose` to `anim` (a grabbable's `two-hand` to `twoHanded: true`), a
grip's `fingers` to `grasp`, and a motion's old type word to `oscillate` (`RENAMED_COMPONENTS`, `RENAMED_FIELDS`).

## `migrate-identities`: name identities to directory ids

`tools/protocol/migrate-identities.ts` moves a world founded or translated before b1ec40b1 from name identities to
directory ids, and seals it. A fresh translation does this itself. Run it with the world's server STOPPED (the server holds
the old log in memory); without `--apply` it is a dry run.

```
bun tools/protocol/migrate-identities.ts [--apply] [--trust-names] <world dir>…
```

The mapping: ONE map from each legacy identity to one id, applied everywhere a person is named: every actor, every
`roles:` / `imported-bans:` key, a say's `to`, an act's `capability.author` and `sponsor`, and the moderator log's
(`world.mod.jsonl`) `who` and `actor`. An escaped name (`x--…`) is read back first. Each identity's account is, in order:

1. the account a `roles:<name>` value's `sub` names (so the person's acts land on the id they sign in as);
2. for a reserved agent name, `agent:token:<name>`;
3. with `--trust-names` (a private server that runs `TRUST_NAMES=1`), `local:<name>`, the account a join there gets;
4. otherwise none: an imported identity an operator binds later.

An account the directory already knows keeps its id; otherwise a new id is minted. The `sub` moves out of the role value
into the directory. Left as they are: the authority's own actors (`system`, `world`, `sim`), `script:<entity>` actors, ids
already minted and a guest's address (`addr:…`). Act requests (as sent) are left as written. Then the whole log is sealed
with this server's keys: a salt on every set and act/say/sim body, `{head, sig}` on every entry after genesis. Genesis and
the world id don't change.

Safety: it writes only if a gate that reads the two logs side by side (never the map that wrote them) agrees: every legacy
identity became exactly one id, everyone left alone stayed themselves, nobody is still named by a legacy name, each role's
account is held by the id its role went to, and the old fold with the role and ban keys renamed as the logs show IS the new
fold (digest). The reference reader must say ok with no malformed entries, and `chain.py` must verify every head with no
unsigned tail. The old logs are kept as `world.jsonl.before-identities` (and `world.mod.jsonl.before-identities`); the
directory learns the new ids before the logs name them.

It skips a world that already has that backup (a second run would overwrite the only way back), one that names nobody by
a legacy name, one that doesn't fold, and one whose worlds dir's custody doesn't hold its sequencer key. A world with purges
never passes the gate (a JSON copy loses the fold's purged marker), so it is never written.
