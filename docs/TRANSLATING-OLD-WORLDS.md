# Translating a first-protocol world — the operator's procedure

Informative (recut C19, 2026-10-21): how an operator translates a world, moved out of spec/PROTOCOL.md §14, which keeps
only what a translated log must be. Where this and §14 disagree, §14 wins.

The first protocol (an untyped verb log) is retired. An old world's log can
be translated once, one way, into a world of this protocol, in two steps.
`bun tools/protocol/world.ts translate <world> --dry-run --no-founder-key`
writes nothing and prints the **dry-run report** — the old log's size and
sha256, the translator and fold build, `founderKey: null`, the counts
(entries, changes, guards that become locks, models without bytes here), the
translator's DROPPED table (what every translation drops or renames by
design), and `deferred`: every use of a feature this protocol does not carry
yet — and the report's sha256. The translation itself takes `--approved <that
hash>`: the report is recomputed from the old log as it stands and must hash
to it (else refused, both hashes named: the log or the tool changed since it
was read).

**A translation names no founder and carries no owner's signature.** First-
protocol logs record accounts, never keys, so nothing can yet bind a key to
the old world's owner; a key handed to the tool would be the operator's
choice, recorded as the owner's approval and installed as tier 0. So
`--founder-key` and `--approve-sig` are refused before anything is written,
the new world's tier 0 is empty (§13), and the approval is the **operator's**
countersignature alone: an ed25519 signature by the host's custody operator
key (never its sequencer key; whoever runs the tool on the host is the
operator, and the tool signs) over `eidoverse-approve-translation:<world>:<hash>`,
given only when the operator says `--operator-only-no-owner`, knowingly. The
writer checks it itself (`approvalProblem`) before the log is written: a
countersignature missing, not verifying, or over another hash or world, an
approval carrying an owner's signature, or a founder key is refused by name.
The approval rides in the new log as the system's `translation-approved` act
right after `repair-shapes` (`body {report, approval: {over, owner: null,
operator: {key, sig}, noOwner}}`, `noOwner` saying in words that no owner was
attested): provenance a reader checks against `log.original.jsonl`. The fold
never reads it (§1).

A world that uses a **deferred feature** — a water volume, an air box, a
climb route, a vehicle, a collision toggle (`water`/`air`/`traversal`/
`vehicle`/`collision` components on an entity, from main's #248/#254 merges;
`water` on `@world` is the world's water level and is carried) — is
**refused**, naming each use (component, entity, actor, seq); an approval
cannot override the refusal. Nothing of a world is ever dropped quietly.

It is translated in place: the world keeps its name, and the old log stays
beside the new one as `log.original.jsonl`, renamed, never written (the swap
refuses unless the old log still holds exactly the bytes that were
translated: nothing an old server wrote meanwhile is dropped); a directory
whose `world.jsonl` is a world of this protocol is served as one whatever
else it holds. (`translate <old> <new>` translates into a new name instead.)
The swap also writes `translation.json`: every file it renamed, every file
it made (`world.jsonl`, `poses.json`, `world.mod.jsonl` for imported bans)
with its sha256, the identities it minted, the report hash and the approval.
`bun tools/protocol/world.ts rollback <world>` undoes the whole swap from
it: the made files removed, the originals renamed back (the same files: bytes,
inode, mtime), the minted identities forgotten (those nobody has bound or
renamed since), the manifest removed — the world directory byte-identical to
before, and the shared directory rewritten without those identities (a
directory file the translation itself created stays, holding none of them). A made file the server has written to
since refuses the rollback unless `--discard-changes`, so no history is lost
unknowingly. Each old entry appears in the new log as an `act` with verb
`imported` (`body {verb, args, from}`) or as a `say`, followed by the change it
produced; fields with no component in this protocol ride along as `imported:<name>`. A
translated world is an ordinary world from then on.

## The tool: `tools/protocol/world.ts`

`world.ts` is the operator's tool for world files (its header lists every command). `found <name> --owner <id>` makes a
new world through the authority's own `create-world` request (`server/worldlog.ts`
`foundWorld`), so the founding act writes `@world` (about, bounds, `roles:<owner>`, `default-role` builder) as a live request would. Genesis
names no owner key (`found` passes none, so tier 0 is empty and the operator's custody key is tier 1). A bare owner
name is the `local:` account of that name (lowercased), resolved through the shared directory. (A person can also found a world over the
wire with the `world-found` request; the server never founds one unasked, and a directory holding only an old log is
refused at open.) `translate` reads `<world>/log.jsonl` and never writes it. In place, it builds the new world in a
temporary sibling (`.translating-<world>-<8 hex>`), verifies it there (the importer's checks, the world opened as the
server opens it, and the snapshot oracle below where a `snapshot.json` is present), then swaps it in under the same
name. If the process dies mid-swap, the next `translate <world>` sees the half-swapped directory and finishes the
swap with renames and moves only, saying so; it refuses when the old log no longer holds the bytes that were
translated, or when more than one temporary directory is left.

## The snapshot oracle

`tools/protocol/import-v1/snapshot-oracle.ts` checks the translator against the old engine itself. The translator's
own checks prove it agrees with itself (its copy of the old fold, its projection, the new fold); the oracle proves it
agrees with the old server. A first-protocol world directory holds, beside `log.jsonl`, the old server's own folded
state as `snapshot.json` (`{v: 1, seq, bytes, ts, state}`). When `snapshot.seq` is the log's last seq and
`snapshot.bytes` is the log's size, the snapshot is the old engine's answer to "what does this whole log mean". A
snapshot that isn't complete is skipped with its reason, never compared.

Per world, the log is translated with the real path (`translateV1World`, as `translate --no-founder-key`) into a
scratch worlds directory with its own custody, directory and model index; the source is only read. Then:

- **A.** The translated `world.jsonl` up to its `lift-sockets` act, read by the strict reader and folded by the real fold, against the snapshot put
  through the translator's own mapping (`project`), with the translated world's identities (read back from its
  directory) and model hashes beside the paths.
- **B.** The server's view: the world opened as the server opens it (`openLive`), its socket children already written by
  the translation's own `lift-sockets` act (`liftWorld` must report nothing left to do), against side A's projection put
  through the same lift (`legacyHosts`, `liftHostOps`: a stored `sockets` map becomes socket child entities, a mounted
  thing's parent names the child, its pose re-expressed in the child's frame; shape-repaired only when the log is
  unmarked, which a translation never is), plus a check that every old seat is a child entity with that name at that pose.
- **C.** Independent of `project` (so a bug that A shares still shows): the fields the snapshot states plainly, each
  thing's id, model and model hash, its pose when unparented and its parent, and the world's terrain and grass.

Entity ids are matched through `enc()` (the translator keeps every id, escaping only what the §2.3 grammar refuses);
people's names (roles, bans, authors) through the translated world's directory. Numbers compare to 1e-9, everything
else exactly. The only thing left out is the translator's `DROPPED` table, which the oracle prints with its reasons.

With no arguments it compares the repo's own reference fixtures (`spec/fixtures/0*`, each `folded.json` standing in
as the snapshot), then any worlds `ORACLE_WORLDS` (else `PROTOCOL_WORLDS`) names, as a `:`-separated list (`;` on
Windows), each distinct complete snapshot once. A world translated in place is read through its kept originals.
`OPT_DIR` points at the serving checkout's `assets/opt` so store models get the model hash they get on that host;
`ORACLE_SCRATCH` (default `PROTOCOL_SCRATCH`, else the OS temp directory) holds the scratch worlds, and
`ORACLE_KEEP=1` keeps them. It exits 0 only when at least one world was compared and every compared world agrees.
`translate` runs it before an in-place swap and runs it with `ORACLE_SUMMARY=1` and reads its one-line `oracle-summary <json>` result.
