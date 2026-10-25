# Translating a first-protocol world — the operator's procedure

## Quick start: do this, in order

For an operator (person or agent) on the host, one world at a time. Run from the engine checkout; `<dir>` is the server's
`WORLDS_DIR`, `<world>` the world's folder name.

1. **Back up** `<dir>/<world>/` somewhere off the host. (The tool keeps the old log, but a copy you hold is the real undo.)
2. **Dry run** (writes nothing):
   `WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <world> --dry-run --no-founder-key`
   Read the report. If `deferred` lists anything, stop: that world uses a feature this protocol doesn't carry yet, so
   ask the maintainers before translating. Its last lines are `report-hash <hash>` and the exact command for step 3.
   (Use the `report-hash`, not the `sha256` inside the report: that one is the old log's.)
3. **Translate in place:**
   `WORLDS_DIR=<dir> bun tools/protocol/world.ts translate <world> --no-founder-key --approved <report-hash> --operator-only-no-owner`
   It builds and verifies the new world beside the old one and swaps it in under the same name only if every check
   passes; the old log stays as `log.original.jsonl`. On any failure the original is untouched and it says why.
4. **Check it:** `WORLDS_DIR=<dir> bun tools/protocol/world.ts info <world>`, then boot the server, join, and look around.
5. **If anything is wrong:** `WORLDS_DIR=<dir> bun tools/protocol/world.ts rollback <world>` puts the old files back.

**Deploy and translate in the same sitting.** A server on this protocol refuses to load an untranslated world (visitors
are told nothing is lost), so a world is closed from the moment the new server runs until it is translated.

The rest of this page explains what each step checks and why.

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
