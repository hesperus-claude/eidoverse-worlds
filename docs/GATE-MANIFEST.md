# The protocol gate

`tools/protocol/run.ts` is the protocol gate. It runs every protocol suite in its own process, in three lanes, and it
passes only when every suite passed and none was skipped. This file describes what the gate needs and how it reports.
The suite table at the bottom is generated from `run.ts` (`--manifest`), and the gate refuses to start when the two
disagree, so the table can't drift.

## Running it

```sh
bun install --frozen-lockfile                 # in the checkout root, in client/, and in mcpl/
bun tools/protocol/run.ts --siblings          # clones/pins agent-framework, mcpl-core-ts and voice-kit in tools/protocol/.siblings/ (gitignored; never a working copy beside the checkout), builds them, and installs mcpl/ and tools/captionbot/, whose file: deps point there (the preflight refuses a copy that isn't the pin's build)
CHROME=/path/to/chrome EIDOVERSE_DIR=/path/to/eidoverse-video bun tools/protocol/run.ts    # or: bun run test:protocol
```

Exit 0 means the gate passed. Exit 1 means a suite failed, a suite or a check was skipped, or the preflight found a
problem (it lists each one). Exit 2 means a bad argument.

Other forms, none of which is the gate:

| command | what it does |
|---|---|
| `bun tools/protocol/run.ts hostile phys` | runs only the named suites; the end says `PARTIAL PASS … this is not the gate` |
| `bun tools/protocol/run.ts --lane core` | runs one lane (`core`, `main` or `browser`), also reported as partial |
| `bun tools/protocol/run.ts --manifest` | prints the suite table below |
| `bun tools/protocol/run.ts --check-manifest` | exits 1 when this file's table isn't what `--manifest` prints |

## Runtimes

Runtime versions are declared in one place, `package.json` `"engines"`. Before any suite runs, the gate prints the
version it found of each runtime next to the declared one.

| runtime | declared | rule | where the gate finds it |
|---|---|---|---|
| bun | 1.3.14 | same major (any 1.x); a different minor or patch is printed as a note | the bun running the gate (`process.execPath`). Every nested `bun` a suite spawns is that same binary: its directory goes first on the children's PATH |
| python3 | 3.12, with `cryptography` | same major; the `cryptography` module must import | `PYTHON`, else `python3` on PATH. Only the `conformance` suite needs it |
| chromium | 151 | this major or newer (playwright 1.62 ships 151; this box tests with Chrome for Testing 153) | `CHROME`, else playwright's own build, else `/usr/bin/google-chrome`, `/usr/bin/chromium`, `/usr/bin/chromium-browser` |
| node | not used | the gate and its suites run on bun | none |

When the browser lane is selected and no Chromium is found, the gate fails before running anything. The message is:

```
chromium  NOT FOUND   declared 151 (…)
protocol gate: FAILED before any suite ran:
  - chromium: not found (the browser lane is REQUIRED: set CHROME=/path/to/chrome (Chromium or Chrome for Testing), or `bunx playwright install chromium`); declared 151 (…)
```

The preflight also fails, naming what to fix, when:

- `CHROME` names a file that doesn't exist;
- any `node_modules` (root, `client/`, `mcpl/`) is missing;
- a suite launches a Chromium but isn't in the browser lane. The gate reads each suite and the local modules it imports
  for `scratchBench(`, `browserBench(`, playwright, puppeteer, `chromium.launch`, `--remote-debugging-port`, or the
  marker comment `gate: launches a browser`;
- this file's table has drifted from `run.ts`.

## Lanes

Every lane is required. They run in this order:

1. **core** covers transactions and security: `kernel`, `gov-reserved`, `nov1`, `vocab`, `authority` (which holds the
   storage and durability rows), `access`, `identity`, `scars`, `reset-race`, `txn` (every request ends committed,
   rolled-back or ambiguous; one request capability rechecked at both await-to-commit seams) and `txn-mutants` (each
   `txn` row turns red under its mutation). It runs first, and the first failure or skip stops the gate.
   Every later suite is then reported as skipped, with "the core lane failed at …" as the reason.
2. **main** is every other suite that needs no browser.
3. **browser** is every suite that drives a headless Chromium. They run one at a time. Inside `client-tools`, the
   test files that launch a browser also run one at a time, so the gate never has two Chromiums open.

## Isolation, timeouts, cleanup

The gate creates a temp dir under the host's `TMPDIR`, and each suite gets a fresh directory inside it. Each suite runs
as its own process group, with this environment:

| variable | value | why |
|---|---|---|
| `HOME` | `<suite dir>/home` (empty) | nothing in `~` is read: no playwright cache, no `~/eido`, no dotfiles |
| `TMPDIR`, `PROTOCOL_SCRATCH` | `<suite dir>` | every `mkdtemp`, scratch world, sandbox FIFO and Chromium profile lands here |
| `EIDOVERSE_DIR` | `<suite dir>/library` (empty) for core and main; **the browser lane requires it** | the asset library is a separate public repo, `SkyeShark/eidoverse-video`, pinned at `9acc1528b2febac11338107645ef500a95985ca5`. Set `EIDOVERSE_DIR` to a checkout of it; without one the gate fails before any suite runs, naming the clone command. Only browser suites and `knockdown` (its ragdoll needs a real rig) see it, read-only |
| `OPT_DIR`, `WORLDS_DIR`, `PATCH_DIR` | `<suite dir>/{opt,worlds,patched}`; `opt` is seeded with the files git tracks under `assets/opt` (today `props/ball.glb`) | nothing writes into the checkout's `assets/opt`, `worlds/` or `patched/`; no host cache is visible, but the repo's own committed fixtures are |
| `PATH` | the gate's bun directory, then the host's PATH | a nested `bun` is the declared bun |
| `BUN_RUNTIME_TRANSPILER_CACHE_PATH` | `0` | a cached transpile once hid a stale module |
| `SKIP_OPT_SWEEP` | `1` | no boot-time re-encoding of the store |
| `PYTHON`, `CHROME` | the binaries the preflight checked | the suites use what the gate verified |

Each suite gets a timeout of 5× its expected runtime (the table below), and never less than 180 s. When a suite times
out, the gate sends SIGTERM to the whole group, waits 5 s, then sends SIGKILL. When a suite exits, the gate SIGKILLs
whatever is left in its group: a server, a sandbox process or a Chromium the suite left running. The count shows on
the suite's line as `killed N leftover process(es)` and again in the tally. The suite's directory is then removed.
Ctrl-C, SIGTERM or SIGHUP to the gate kills the running suite's group and removes the gate's temp dir.
`PROTOCOL_TIMEOUT_SCALE=<factor>` multiplies every timeout, for a very slow host (`2`) or to watch the kill work
(`0.01`).
`PROTOCOL_KEEP=1` keeps the temp dir so you can read it.

Every fixture the gate needs is in the repo:

- `spec/fixtures/*`: old-format logs, with `folded.json` holding the reference fold of each. The sweep reads them,
  and so does the oracle, which uses each `folded.json` as the snapshot.
- `spec/fixtures/01-build/log.jsonl`: the first-protocol world that refusedjoin refuses.
- `spec/fixtures/claude_suit-rig.json`: the skeleton reach-order uses. `tools/rig-fixture.mjs` writes it from the VRM
  and records the VRM's sha256.
- `tools/protocol/fixtures/dims-1024x512.jpg`: the JPEG header for the decompression-bomb row (batch2 P6).
- `tools/protocol/fixtures/v1-commons-shape.jsonl`: the Commons' governance lines, for roles T2.

## How results are reported

What a suite prints, and how the gate counts it:

| suite output | the gate counts it as |
|---|---|
| exit 0 | passed |
| exit 77 | **skipped** (the whole suite); the reason is its last `SKIP` line |
| a line `SKIP <name>: <why>` | **skipped** (one check): the suite counts as skipped even when it exits 0 |
| a line `FAIL …` or `✗ …` | the failed check, echoed under the suite |
| a line `OPTIONAL <name>: <why>` | an optional extension that didn't run. It is counted and listed, never a failure |
| any other exit, or a timeout | failed |

A skip fails the gate, because every lane is required. A check that depends on host data should carry a fixture and
print an `OPTIONAL` line for the host-data version. The optional extensions today:

| name | what is missing | turn it on with |
|---|---|---|
| `control-arm` | the protocol lab's pre-fix door and fold (each attack is shown to be an attack) | `PROTOCOL_LAB=<protocol lab checkout>` |
| `sweep-local-worlds` | the translators against a host's own world logs, on top of `spec/fixtures` | `PROTOCOL_WORLDS=<dir>[:<dir>…]` |
| `oracle-host-worlds` | the snapshot oracle against a host's old worlds (`log.jsonl` + `snapshot.json`) | `ORACLE_WORLDS` or `PROTOCOL_WORLDS` |
| `ep3-real-commons` | directory EP3 (an epoch entered after thousands of instant-fold entries) on the real Commons log instead of its synthetic 3000-entry copy | `PROTOCOL_COMMONS=<commons-0927 log.jsonl>` and `PROTOCOL_COMMONS_LIBRARY=<its library>` |

Other host-only inputs: `V1_COMMONS=<a v1 Commons log>` runs roles T2 against a real Commons log instead of its
fixture, and `V1_LOG=<a v1 log>` does the same for refusedjoin.

The run ends with a tally:

```
== protocol gate: tally (N s)
  core     7 passed, 0 failed, 0 skipped
  main     90 passed, 0 failed, 0 skipped
  browser  10 passed, 0 failed, 0 skipped
  total    107 passed, 0 failed, 0 skipped (every lane is required: a skip fails the gate)
  optional, not run: 3
          control-arm: …
protocol gate: PASS
```

On a host with its own guards (a flock that keeps headless Chromes one at a time, a memory guard), set
`PROTOCOL_HEADLESS_LOCK=<lock file>` and `PROTOCOL_PERF_GUARD=<script>`. Each browser suite then runs as
`flock <lock> bash <script> -t <timeout> -- bun <suite>`. Neither is needed anywhere else.

## Operating systems and receipts

The gate is meant to run the same on **Linux, macOS and Windows**. A suite's leftover processes are found and killed per
OS (`server/procgroup.ts`: `/proc` on Linux, `ps` on macOS, the process tree on Windows), and PATH is searched
with the OS's own separator. The script sandbox tells a starved process from a stuck script with `/proc` CPU time on
Linux and, where there is no `/proc`, by whether the process ever took the job (scripts-check I8 and I8n).

`.github/workflows/protocol-gate.yml` runs the whole gate on all three OSes on every PR and push, and each run
uploads a receipt (`--receipt <file>`): the head (on a pull_request run, GitHub's merge of the PR into its base, with the
PR's own head as `prHead` and the merge's parents as `mergeOf`), whether the tree was dirty, OS, runtimes, the asset library's head,
every suite's result and a hash of its output, and one hash over all of them. That receipt, not a sentence in a PR
comment, is the evidence of a pass.

Known gap, said plainly: the macOS and Windows paths were written and tested on Linux (the macOS process path against
`ps`, the Windows tree walk on fixed tables, the no-`/proc` sandbox path by switching the reading off). Their first real
runs are that workflow's.

## Suites

The expected times come from the reference host (WSL2, 16 threads, 7 GB, 2026-10-18), with one suite running at a
time.

<!-- BEGIN GENERATED: bun tools/protocol/run.ts --manifest -->
| # | suite | lane | file | needs | expected | timeout |
|---|---|---|---|---|---|---|
| 1 | kernel | core | `tools/protocol/kernel-check.ts` | bun | 0.5 s | 180 s |
| 2 | trig | core | `tools/protocol/trig-check.ts` | bun | 0.2 s | 180 s |
| 3 | laws | core | `tools/protocol/laws-check.ts` | bun | 0.3 s | 180 s |
| 4 | engine | core | `tools/protocol/engine-check.ts` | bun | 0.6 s | 180 s |
| 5 | normative | core | `tools/protocol/normative-check.ts` | bun | 0.2 s | 180 s |
| 6 | gov-reserved | core | `tools/protocol/gov-reserved-check.ts` | bun | ? | 300 s |
| 7 | diffcheck | core | `tools/protocol/diffcheck.ts` | bun | ? | 300 s |
| 8 | hygiene | core | `tools/protocol/hygiene-check.ts` | bun | 0.4 s | 180 s |
| 9 | procgroup | core | `tools/protocol/procgroup-check.ts` | bun | ? | 300 s |
| 10 | nov1 | core | `tools/protocol/nov1-check.ts` | bun | 0.7 s | 180 s |
| 11 | vocab | core | `tools/protocol/vocab-check.ts` | bun | 3.5 s | 180 s |
| 12 | authority | core | `tools/protocol/authority-check.ts` | bun | 9 s | 180 s |
| 13 | access | core | `tools/protocol/access-check.ts` | bun | 8.3 s | 180 s |
| 14 | identity | core | `tools/protocol/identity-check.ts` | bun | 42 s | 210 s |
| 15 | scars | core | `tools/protocol/scars-check.ts` | bun | 1 s | 180 s |
| 16 | reset-race | core | `tools/protocol/reset-race-check.ts` | bun | 0.4 s | 180 s |
| 17 | txn | core | `tools/protocol/txn-check.ts` | bun | 0.8 s | 180 s |
| 18 | txn-mutants | core | `tools/protocol/txn-check.ts --mutants` | bun | 11 s | 180 s |
| 19 | simmath | main | `tools/simmath-test.ts` | bun | 1 s | 180 s |
| 20 | freeze | main | `tools/protocol/freeze-check.ts` | python3 | ? | 300 s |
| 21 | body-state-bundle | main | `tools/body-state-bundle-test.ts` | bun | 0.2 s | 180 s |
| 22 | run-client-settle | main | `tools/protocol/run-client-settle-check.ts` | bun | ? | 300 s |
| 23 | shard | main | `tools/protocol/shard-check.ts` | bun | 1 s | 180 s |
| 24 | vocab-fixtures | main | `tools/protocol/vocab-fixtures-check.ts` | bun | ? | 300 s |
| 25 | nonumber | main | `tools/protocol/nonumber-check.ts` | bun | 1.4 s | 180 s |
| 26 | determinism | main | `tools/protocol/determinism-check.ts` | bun | 0.1 s | 180 s |
| 27 | hostile | main | `tools/protocol/hostile-check.ts` | bun | 0.3 s | 180 s |
| 28 | attack | main | `tools/protocol/attack-check.ts` | bun | 1.5 s | 180 s |
| 29 | libfile | main | `tools/protocol/libfile-check.ts` | bun | 0.1 s | 180 s |
| 30 | library-decode | main | `tools/library-decode-test.ts` | bun | 2.6 s | 180 s |
| 31 | idle-stall | main | `tools/idle-stall-test.ts` | bun | 22.8 s | 180 s |
| 32 | fetchbytes | main | `tools/fetchbytes-test.mjs` | bun | 0.5 s | 180 s |
| 33 | variant-status | main | `tools/variant-status-test.ts` | bun | 0.2 s | 180 s |
| 34 | optimize-pump | main | `tools/optimize-pump-test.ts` | bun | 1 s | 180 s |
| 35 | rebuild | main | `tools/rebuild-test.ts` | bun | 1 s | 180 s |
| 36 | ktx2-tf-purge | main | `tools/ktx2-tf-purge-test.ts` | bun | 0.3 s | 180 s |
| 37 | image-lie | main | `tools/image-lie-test.ts` | bun | 0.2 s | 180 s |
| 38 | glbperf-file | main | `tools/glbperf-file-test.ts` | bun | 0.3 s | 180 s |
| 39 | gaps | main | `tools/protocol/gaps-check.ts` | bun | 5.6 s | 180 s |
| 40 | phys | main | `tools/protocol/phys-check.ts` | bun | 3.9 s | 180 s |
| 41 | physlive | main | `tools/protocol/physlive-check.ts` | bun | 1.2 s | 180 s |
| 42 | siminputs | main | `tools/protocol/siminputs-check.ts` | bun | ? | 300 s |
| 43 | phystick | main | `tools/protocol/phystick-check.ts` | bun | 5.7 s | 180 s |
| 44 | sclock | main | `tools/protocol/sclock-check.ts` | bun | 2.8 s | 180 s |
| 45 | server-clock | main | `tools/server-clock-test.ts` | bun | 1.5 s | 180 s |
| 46 | tick | main | `tools/tick-test.ts` | bun | 1 s | 180 s |
| 47 | server-clock-readers | main | `tools/server-clock-readers-test.ts` | bun | 0.2 s | 180 s |
| 48 | physseeds | main | `tools/protocol/physseeds-check.ts` | bun | 2.1 s | 180 s |
| 49 | eidosim | main | `tools/protocol/eidosim-check.ts` | bun | 12 s | 180 s |
| 50 | eidosim-live | main | `tools/protocol/eidosim-live-check.ts` | bun | 1.5 s | 180 s |
| 51 | mover | main | `tools/protocol/mover-check.ts` | bun | 4.5 s | 180 s |
| 52 | zone-water | main | `tools/protocol/zone-water-check.ts` | bun | 0.6 s | 180 s |
| 53 | water-lifecycle | main | `tools/water-lifecycle-test.ts` | bun | 1.8 s | 180 s |
| 54 | waterkind | main | `tools/waterkind-test.ts` | bun | 0.5 s | 180 s |
| 55 | underwater-presence | main | `tools/underwater-presence-test.ts` | bun | 0.2 s | 180 s |
| 56 | buoyancy | main | `tools/buoyancy-test.ts` | bun | 0.2 s | 180 s |
| 57 | climb-env | main | `tools/protocol/climb-env-check.ts` | bun | 0.5 s | 180 s |
| 58 | drive | main | `tools/protocol/drive-check.ts` | bun | 0.6 s | 180 s |
| 59 | physics-area | main | `tools/protocol/physics-area-check.ts` | bun | 0.5 s | 180 s |
| 60 | water-vectors | main | `tools/water-vectors.ts --check` | bun | 0.2 s | 180 s |
| 61 | water-import | main | `tools/water/import-golden-check.ts` | bun | ? | 300 s |
| 62 | water-preview | main | `tools/water/preview-check.ts` | bun | 3 s | 180 s |
| 63 | avatar | main | `tools/avatar-test.ts` | bun | 1 s | 180 s |
| 64 | locomotion-clip | main | `tools/locomotion-clip-test.mjs` | bun | 0.2 s | 180 s |
| 65 | fp-view | main | `tools/fp-view-test.ts` | bun | 0.2 s | 180 s |
| 66 | reachwire | main | `tools/reachwire-test.ts` | bun | 0.2 s | 180 s |
| 67 | reach | main | `tools/reach-test.ts` | bun | 0.2 s | 180 s |
| 68 | posture-tiles | main | `tools/posture-tiles-test.ts` | bun | 0.5 s | 180 s |
| 69 | poseclip-parity | main | `tools/poseclip-parity-test.ts` | bun | 0.2 s | 180 s |
| 70 | pose-handler | main | `tools/pose-handler-test.ts` | bun | 0.2 s | 180 s |
| 71 | plateanchor | main | `tools/plateanchor-test.ts` | bun | 0.3 s | 180 s |
| 72 | flight | main | `tools/flight-test.ts` | bun | 0.5 s | 180 s |
| 73 | firstperson-plate | main | `tools/firstperson-plate-test.ts` | bun | 0.5 s | 180 s |
| 74 | bodyscale | main | `tools/bodyscale-test.ts` | bun | 0.7 s | 180 s |
| 75 | worn-name | main | `tools/worn-name-test.mjs` | bun | 0.1 s | 180 s |
| 76 | avatar-perf | main | `tools/avatar-perf-test.ts` | bun | 0.5 s | 180 s |
| 77 | armsolve | main | `tools/armsolve-test.ts` | bun | 0.2 s | 180 s |
| 78 | ammodoll | main | `tools/ammodoll-test.ts` | bun | 8.4 s | 180 s |
| 79 | bodysim | main | `tools/bodysim-test.ts` | bun | 0.5 s | 180 s |
| 80 | remotes-limp-edge | main | `tools/remotes-limp-edge-test.ts` | bun | 0.5 s | 180 s |
| 81 | remotes-lifecycle | main | `tools/remotes-lifecycle-test.ts` | bun | 1 s | 180 s |
| 82 | colliders | main | `tools/collider-test.ts` | bun | 0.2 s | 180 s |
| 83 | supportclass | main | `tools/supportclass-test.ts` | bun | 0.2 s | 180 s |
| 84 | support | main | `tools/support-test.ts` | bun | 0.3 s | 180 s |
| 85 | structure-field | main | `tools/structure-field-test.ts` | bun | 0.2 s | 180 s |
| 86 | structure-edit | main | `tools/structure-edit-test.ts` | bun | 0.2 s | 180 s |
| 87 | structure-collider | main | `tools/structure-collider-test.ts` | bun | 0.2 s | 180 s |
| 88 | collider-off-bodies | main | `tools/collider-off-bodies-test.ts` | bun | 2 s | 180 s |
| 89 | lying-support | main | `tools/lying-support-test.ts` | bun | 16 s | 180 s |
| 90 | support-swap | main | `tools/support-swap-test.ts` | bun | ? | 300 s |
| 91 | knockdown | main | `tools/knockdown-test.ts` | bun | ? | 300 s |
| 92 | sockets | main | `tools/sockets-test.ts` | bun | ? | 300 s |
| 93 | seats-store | main | `tools/seats-store-test.ts` | bun | 0.9 s | 180 s |
| 94 | seatcore | main | `tools/seatcore-test.ts` | bun | 0.3 s | 180 s |
| 95 | seatlab-measure | main | `tools/seatlab-measure-test.ts` | bun | 1 s | 180 s |
| 96 | msgrate | main | `tools/msgrate-test.ts` | bun | 0.1 s | 180 s |
| 97 | clientlog | main | `tools/clientlog-test.ts` | bun | 3.5 s | 180 s |
| 98 | shape-render | main | `tools/shape-render-test.ts` | bun | ? | 300 s |
| 99 | originof | main | `tools/originof-test.ts` | bun | ? | 300 s |
| 100 | renderer-cred | main | `tools/renderer-cred-test.ts` | bun | ? | 300 s |
| 101 | renderer-join | main | `tools/renderer-join-test.ts` | bun | 0.2 s | 180 s |
| 102 | render-health | main | `tools/render-health-test.ts` | bun | 0.2 s | 180 s |
| 103 | replay | main | `tools/protocol/replay-check.ts` | bun | 0.4 s | 180 s |
| 104 | replica-freeze | main | `tools/replica-freeze-test.ts` | bun | 0.5 s | 180 s |
| 105 | conformance | main | `tools/protocol/compare.ts` | python3 + cryptography | 2.9 s | 180 s |
| 106 | sweep | main | `tools/protocol/sweep.ts` | bun | 0.3 s | 180 s |
| 107 | oracle | main | `tools/protocol/import-v1/snapshot-oracle.ts` | bun | 0.4 s | 180 s |
| 108 | inplace | main | `tools/protocol/inplace-check.ts` | bun | 15 s | 180 s |
| 109 | oneshot | main | `tools/protocol/oneshot-check.ts` | bun | ? | 300 s |
| 110 | version-route | main | `tools/version-route-test.ts` | bun | ? | 300 s |
| 111 | migrate-identities | main | `tools/protocol/migrate-identities-check.ts` | python3 | 1.7 s | 180 s |
| 112 | oldworlds | main | `tools/oldworlds-test.ts` | bun | 1.2 s | 180 s |
| 113 | descriptors | main | `tools/descriptor-defaults-test.ts` | bun | 0.1 s | 180 s |
| 114 | schema-layers | main | `tools/schema-layers-test.ts` | bun | 0.3 s | 180 s |
| 115 | light-readers | main | `tools/light-readers-test.ts` | bun | 0.4 s | 180 s |
| 116 | ghost-mesh-size | main | `tools/ghost-mesh-size-test.ts` | bun | 12 s | 180 s |
| 117 | boot-init | main | `tools/boot-init-test.ts` | bun | 0.5 s | 180 s |
| 118 | splash-lifecycle | main | `tools/splash-lifecycle-test.mjs` | bun | 0.5 s | 180 s |
| 119 | bodygate | main | `tools/bodygate-test.mjs` | bun | 0.5 s | 180 s |
| 120 | scheduler | main | `tools/scheduler-test.ts` | bun | 0.3 s | 180 s |
| 121 | editor-range | main | `tools/editor-range-test.ts` | bun | 0.3 s | 180 s |
| 122 | editschema | main | `tools/editschema-test.ts` | bun | 0.5 s | 180 s |
| 123 | worldentity | main | `tools/worldentity-test.ts` | bun | 1.4 s | 180 s |
| 124 | layers | main | `tools/layers-test.ts` | bun | 0.2 s | 180 s |
| 125 | selection | main | `tools/selection-test.ts` | bun | 0.2 s | 180 s |
| 126 | parts | main | `tools/parts-test.ts` | bun | 0.2 s | 180 s |
| 127 | motioneval | main | `tools/motioneval-test.ts` | bun | 0.2 s | 180 s |
| 128 | drag-q | main | `tools/drag-q-test.ts` | bun | 0.2 s | 180 s |
| 129 | components-corpus | main | `tools/components-corpus-test.ts` | bun | 0.2 s | 180 s |
| 130 | component-needs | main | `tools/component-needs-test.ts` | bun | 0.6 s | 180 s |
| 131 | scriptnew-expect | main | `tools/scriptnew-expect-test.ts` | bun | 0.5 s | 180 s |
| 132 | role-grammar | main | `tools/role-grammar-test.ts` | bun | 0.3 s | 180 s |
| 133 | rot | main | `tools/rot-test.ts` | bun | 0.1 s | 180 s |
| 134 | one-binding | main | `tools/one-binding-test.ts` | bun | 0.3 s | 180 s |
| 135 | reexport-binding | main | `tools/reexport-binding-test.mjs` | bun | 0.3 s | 180 s |
| 136 | wiring | main | `tools/wiring-check.ts` | bun | 0.2 s | 180 s |
| 137 | onepose | main | `tools/protocol/onepose-check.ts` | bun | 0.3 s | 180 s |
| 138 | helm-leave | main | `tools/helm-leave-test.ts` | bun | 0.2 s | 180 s |
| 139 | dismount-height | main | `tools/dismount-height-test.ts` | bun | 0.2 s | 180 s |
| 140 | latestread | main | `tools/latestread-test.ts` | bun | ? | 300 s |
| 141 | csp | main | `tools/csp-test.ts` | bun | ? | 300 s |
| 142 | build-gate | main | `tools/build-gate-test.ts` | bun | 0.3 s | 180 s |
| 143 | capsule-recovery | main | `tools/capsule-recovery-test.mjs` | bun | 10 s | 180 s |
| 144 | debug-tabs | main | `tools/debug-tabs-test.ts` | bun | 0.3 s | 180 s |
| 145 | governor-xr | main | `tools/governor-xr-test.ts` | bun | 0.2 s | 180 s |
| 146 | xr-entry-effects | main | `tools/xr-entry-effects-test.mjs` | bun | 0.2 s | 180 s |
| 147 | xr-session-lifecycle | main | `tools/xr-session-lifecycle-test.mjs` | bun | 0.2 s | 180 s |
| 148 | xrpanels | main | `tools/xrpanels-test.ts` | bun | 0.3 s | 180 s |
| 149 | xrpass | main | `tools/xrpass-test.mjs` | bun | 0.3 s | 180 s |
| 150 | xrpixelratio | main | `tools/xrpixelratio-test.mjs` | bun | 0.2 s | 180 s |
| 151 | xrpointer | main | `tools/xrpointer-test.mjs` | bun | 0.2 s | 180 s |
| 152 | xrshadow | main | `tools/xrshadow-test.mjs` | bun | 0.2 s | 180 s |
| 153 | framebudget | main | `tools/framebudget-test.mjs` | bun | 1 s | 180 s |
| 154 | gputime | main | `tools/gputime-test.ts` | bun | 2.6 s | 180 s |
| 155 | draw-batches | main | `tools/draw-batches-test.ts` | bun | 0.3 s | 180 s |
| 156 | gpulost | main | `tools/gpulost-test.mjs` | bun | 0.3 s | 180 s |
| 157 | render-aside | main | `tools/render-aside-test.mjs` | bun | 0.3 s | 180 s |
| 158 | quadcolour | main | `tools/quadcolour-test.mjs` | bun | 1.1 s | 180 s |
| 159 | headset-seen | main | `tools/headset-seen-test.mjs` | bun | 0.2 s | 180 s |
| 160 | full-detail | main | `tools/full-detail-test.ts` | bun | 0.2 s | 180 s |
| 161 | finger-curl | main | `tools/finger-curl-test.mjs` | bun | 0.2 s | 180 s |
| 162 | backend-choice | main | `tools/backend-choice-test.mjs` | bun | 0.2 s | 180 s |
| 163 | unknown-comp | main | `tools/unknown-comp-test.ts` | bun | 1.1 s | 180 s |
| 164 | reach-order | main | `tools/reach-order-test.ts` | bun | 1.5 s | 180 s |
| 165 | editcommit | main | `tools/editcommit-test.ts` | bun | 0.8 s | 180 s |
| 166 | hierarchy-commit | main | `tools/hierarchy-commit-test.ts` | bun | 0.6 s | 180 s |
| 167 | hierarchy | main | `tools/hierarchy-test.ts` | bun | 17 s | 180 s |
| 168 | verbclasses | main | `tools/protocol/verbclasses-check.ts` | bun | 0 s | 180 s |
| 169 | authority-layers | main | `tools/protocol/authority-layers-check.ts` | bun | 0 s | 180 s |
| 170 | ids | main | `tools/protocol/ids-check.ts` | bun | 1.4 s | 180 s |
| 171 | r8 | main | `tools/protocol/r8-check.ts` | bun | 0.9 s | 180 s |
| 172 | r9 | main | `tools/protocol/r9-check.ts` | bun | 1.5 s | 180 s |
| 173 | r10 | main | `tools/protocol/r10-check.ts` | bun | 1.7 s | 180 s |
| 174 | r11 | main | `tools/protocol/r11-check.ts` | bun | 0.6 s | 180 s |
| 175 | names | main | `tools/protocol/names-check.ts` | bun | 2.1 s | 180 s |
| 176 | parity | main | `tools/protocol/parity-check.ts` | bun | 5.4 s | 180 s |
| 177 | directory | main | `tools/protocol/directory-check.ts` | bun | 13 s | 180 s |
| 178 | keyhints | main | `tools/keyhints-check.ts` | bun | 0 s | 180 s |
| 179 | upgrade | main | `tools/protocol/upgrade-check.ts` | bun | 70 s | 350 s |
| 180 | hello-refused | main | `tools/protocol/hello-refused-check.ts` | bun | ? | 300 s |
| 181 | server | main | `tools/protocol/server-check.ts` | bun | 40 s | 200 s |
| 182 | worlds-route | main | `tools/worlds-route-test.ts` | bun | 2.8 s | 180 s |
| 183 | served-routes | main | `tools/served-routes-test.ts` | bun | 2.5 s | 180 s |
| 184 | native-login | main | `tools/native-login-test.ts` | bun | 0.2 s | 180 s |
| 185 | mkconfig | main | `tools/mkconfig-test.ts` | bun | 0.3 s | 180 s |
| 186 | heightmap-route | main | `tools/heightmap-route-test.ts` | bun | 1.2 s | 180 s |
| 187 | config-env | main | `tools/config-env-test.ts` | bun | 0.2 s | 180 s |
| 188 | fork-reset | main | `tools/protocol/fork-reset-check.ts` | bun | 6 s | 180 s |
| 189 | simckpt | main | `tools/protocol/simckpt-check.ts` | python3 + cryptography | ? | 300 s |
| 190 | statecache | main | `tools/protocol/statecache-check.ts` | bun | ? | 300 s |
| 191 | foldparity | main | `tools/protocol/foldparity-check.ts` | bun | ? | 300 s |
| 192 | blockers-mutants-a | main | `tools/protocol/blockers-mutants.ts --group a` | bun | 110 s | 550 s |
| 193 | blockers-mutants-b | main | `tools/protocol/blockers-mutants.ts --group b` | bun | 110 s | 550 s |
| 194 | blockers-mutants-c | main | `tools/protocol/blockers-mutants.ts --group c` | bun | 110 s | 550 s |
| 195 | blockers-mutants-d | main | `tools/protocol/blockers-mutants.ts --group d` | bun | 110 s | 550 s |
| 196 | scripts | main | `tools/protocol/scripts-check.ts` | bun | 48 s | 240 s |
| 197 | scripting | main | `tools/protocol/scripting-check.ts` | bun | 2 s | 180 s |
| 198 | grab | main | `tools/protocol/grab-check.ts` | bun | 3.8 s | 180 s |
| 199 | shove | main | `tools/protocol/shove-check.ts` | bun | 2 s | 180 s |
| 200 | shove-walker | main | `tools/shove-test.ts` | bun | 0.1 s | 180 s |
| 201 | force | main | `tools/protocol/force-check.ts` | bun | ? | 300 s |
| 202 | physconst | main | `tools/physconst-test.ts` | bun | ? | 300 s |
| 203 | agentshove | main | `tools/protocol/agentshove-check.ts` | bun | 165 s | 825 s |
| 204 | hands | main | `tools/protocol/hands-check.ts` | bun | 1.2 s | 180 s |
| 205 | track-teleport | main | `tools/track-teleport-test.ts` | bun | 0.2 s | 180 s |
| 206 | put-settle | main | `tools/put-settle-test.ts` | bun | 0.2 s | 180 s |
| 207 | reset | main | `tools/protocol/reset-check.ts` | bun | 1.7 s | 180 s |
| 208 | settle | main | `tools/protocol/settle-check.ts` | bun | 5.4 s | 180 s |
| 209 | disabled | main | `tools/protocol/disabled-check.ts` | bun | 1.2 s | 180 s |
| 210 | histdiff | main | `tools/protocol/history-diff-check.ts` | bun | 0.3 s | 180 s |
| 211 | reachgate | main | `tools/protocol/reachgate-check.ts` | bun | 22 s | 180 s |
| 212 | consent | main | `tools/protocol/consent-check.ts` | bun | 0 s | 180 s |
| 213 | gates | main | `tools/protocol/gates-check.ts` | bun | 0.1 s | 180 s |
| 214 | consent-client | main | `tools/consent-client-test.ts` | bun | 0.2 s | 180 s |
| 215 | media-trust-tabs | main | `tools/media-trust-tabs-test.ts` | bun | 0.1 s | 180 s |
| 216 | confirmcenter | main | `tools/confirmcenter-test.ts` | bun | 0.5 s | 180 s |
| 217 | windows-guard | main | `tools/windows-guard-test.ts` | bun | 0.5 s | 180 s |
| 218 | history-rows | main | `tools/protocol/history-rows-check.ts` | bun | 0.6 s | 180 s |
| 219 | scale | main | `tools/protocol/scale-check.ts` | bun | 125 s | 625 s |
| 220 | roles | main | `tools/protocol/roles-check.ts` | bun | 3.1 s | 180 s |
| 221 | batch2 | main | `tools/protocol/batch2-check.ts` | bun | 1.9 s | 180 s |
| 222 | describe-particles | main | `tools/protocol/describe-particles-check.ts` | bun | 1.1 s | 180 s |
| 223 | picture-note | main | `tools/picture-note-test.ts` | bun | 0.3 s | 180 s |
| 224 | build | main | `tools/protocol/build-check.ts` | bun | 1.5 s | 180 s |
| 225 | counter | main | `tools/protocol/counter-check.ts` | bun | 2.2 s | 180 s |
| 226 | blueprint | main | `tools/blueprint-test.ts` | bun | 1.2 s | 180 s |
| 227 | shiplist | main | `tools/protocol/shiplist-check.ts` | bun | 1.7 s | 180 s |
| 228 | agenttools | main | `tools/protocol/agenttools-check.ts` | bun | 20 s | 180 s |
| 229 | look | main | `tools/look-test.ts` | bun | 0.2 s | 180 s |
| 230 | presence | main | `tools/protocol/presence-check.ts` | bun | 10 s | 180 s |
| 231 | modhole | main | `tools/protocol/modhole-check.ts` | bun | 0.1 s | 180 s |
| 232 | pretrans | main | `tools/protocol/pretrans-check.ts` | python3 | 2.8 s | 180 s |
| 233 | soundclock | main | `tools/protocol/soundclock-check.ts` | bun | 0.2 s | 180 s |
| 234 | sound | main | `tools/sound-test.ts` | bun | ? | 300 s |
| 235 | audioctx | main | `tools/audioctx-test.ts` | bun | 0.2 s | 180 s |
| 236 | sound-editor | main | `tools/sound-editor-test.ts` | bun | ? | 300 s |
| 237 | skypanel | main | `tools/skypanel-state-test.ts` | bun | ? | 300 s |
| 238 | sky-bakelock | main | `tools/sky-bakelock-test.mjs` | bun | 0.3 s | 180 s |
| 239 | sky-swapchain | main | `tools/sky-swapchain-test.mjs` | bun | 0.3 s | 180 s |
| 240 | sky-lifecycle | main | `tools/sky-lifecycle-test.mjs` | bun | 5.2 s | 180 s |
| 241 | forecast | main | `tools/forecast-test.ts` | bun | 0.2 s | 180 s |
| 242 | physics-off | main | `tools/physics-off-test.ts` | bun | ? | 300 s |
| 243 | predict-pending | main | `tools/predict-pending-test.ts` | bun | 0.5 s | 180 s |
| 244 | eidomodel | main | `tools/protocol/eidomodel-check.ts` | bun | 0.7 s | 180 s |
| 245 | alias | main | `mcpl/alias-test.ts` | bun | 0.4 s | 180 s |
| 246 | tool-replies | main | `mcpl/tool-replies-test.ts` | bun | ? | 300 s |
| 247 | agent-mesh-collision | main | `tools/agent-mesh-collision-test.ts` | bun | 92 s | 460 s |
| 248 | navgrid | main | `tools/navgrid-test.ts` | bun | 64 s | 320 s |
| 249 | structure-threshold | main | `tools/structure-threshold-test.ts` | bun | 0.3 s | 180 s |
| 250 | structure-route | main | `tools/structure-route-test.ts` | bun | 0.3 s | 180 s |
| 251 | navgrid-rows | main | `tools/navgrid-rows-test.ts` | bun | 6.3 s | 180 s |
| 252 | places | main | `tools/places-test.ts` | bun | 130 s | 650 s |
| 253 | blank-part-uvs | main | `tools/blank-part-uvs-test.ts` | bun | 0.3 s | 180 s |
| 254 | storey-walk | main | `mcpl/storey-walk-test.ts` | bun | 1.5 s | 180 s |
| 255 | walk-support-lifecycle | main | `tools/walk-support-lifecycle-test.ts` | bun | 0.8 s | 180 s |
| 256 | agent-reads | main | `mcpl/agent-reads-test.ts` | bun | ? | 300 s |
| 257 | route-shape | main | `tools/route-shape-test.ts` | bun | 1.2 s | 180 s |
| 258 | door-unit | main | `mcpl/door-unit-test.ts` | bun | ? | 300 s |
| 259 | manifest | main | `mcpl/manifest-test.ts` | bun | 0.2 s | 180 s |
| 260 | token-registry | main | `tools/token-registry-test.ts` | bun | 0.2 s | 180 s |
| 261 | door-media-whitelist | main | `tools/door-media-whitelist-test.mjs` | bun | 0.2 s | 180 s |
| 262 | door-bone-list | main | `tools/door-bone-list-test.ts` | bun | 0.3 s | 180 s |
| 263 | author-wire | main | `tools/author-wire-test.mjs` | bun | 0.2 s | 180 s |
| 264 | selfpose | main | `mcpl/selfpose-test.ts` | bun | 0.2 s | 180 s |
| 265 | effective-mcpl | main | `mcpl/effective-test.ts` | bun | ? | 300 s |
| 266 | headless-core | main | `mcpl/headless-core-test.ts` | bun | ? | 300 s |
| 267 | effective | main | `tools/effective-test.ts` | bun | ? | 300 s |
| 268 | stretched-support | main | `mcpl/stretched-support-test.ts` | bun | ? | 300 s |
| 269 | stretched-places | main | `mcpl/stretched-places-test.ts` | bun | ? | 300 s |
| 270 | door-body | main | `mcpl/door-body-test.ts` | bun | ? | 300 s |
| 271 | body-state | main | `tools/body-state-test.ts` | bun | 8 s | 180 s |
| 272 | body-runtime | main | `tools/body-runtime-test.ts` | bun | 0.5 s | 180 s |
| 273 | glb2vrm | main | `tools/glb2vrm-test.ts` | bun | 1 s | 180 s |
| 274 | vrmheight | main | `tools/vrmheight-test.ts` | bun | 0.6 s | 180 s |
| 275 | shape-attach | main | `tools/shape-attach-test.ts` | bun | 0.7 s | 180 s |
| 276 | shape-physics | main | `tools/shape-physics-test.ts` | bun | 0.7 s | 180 s |
| 277 | shape-import | main | `tools/shape-import-test.ts` | bun | 0.4 s | 180 s |
| 278 | buildcheck | main | `tools/buildcheck-test.ts` | bun | 18 s | 180 s |
| 279 | buildcheck-queue | main | `tools/buildcheck-queue-test.ts` | bun | 7.4 s | 180 s |
| 280 | buildcheck-route | main | `tools/buildcheck-route-test.ts` | bun | 22 s | 180 s |
| 281 | door-is-error | main | `tools/door-is-error-test.ts` | bun | 280 s | 1400 s |
| 282 | door-wording | main | `tools/door-wording-test.ts` | bun | ? | 300 s |
| 283 | stdio-door | main | `tools/stdio-door-test.ts` | bun | 14 s | 180 s |
| 284 | consent-replay | main | `tools/consent-replay-test.ts` | bun | ? | 300 s |
| 285 | history-request | main | `tools/history-request-test.ts` | bun | 0.3 s | 180 s |
| 286 | named-pose | main | `tools/named-pose-test.ts` | bun | 2.6 s | 180 s |
| 287 | presence-session | main | `tools/presence-session-test.ts` | bun | 1.5 s | 180 s |
| 288 | other-body-pose | main | `tools/other-body-pose-test.ts` | bun | 6 s | 180 s |
| 289 | settled-pose | main | `tools/settled-pose-test.ts` | bun | 0.5 s | 180 s |
| 290 | pose-provenance | main | `tools/pose-provenance-test.ts` | bun | 0.5 s | 180 s |
| 291 | skystamp | main | `tools/skystamp-test.ts` | bun | 0.5 s | 180 s |
| 292 | skywatch | main | `tools/skywatch-test.ts` | bun | 1.3 s | 180 s |
| 293 | grant-command | main | `tools/grant-command-test.ts` | bun | 0.3 s | 180 s |
| 294 | environment-realizer | main | `tools/environment-realizer-test.ts` | bun | 0.3 s | 180 s |
| 295 | grass-quality | main | `tools/grass-quality-test.ts` | bun | 0.3 s | 180 s |
| 296 | terrainshape | main | `tools/terrainshape-test.ts` | bun | 0.2 s | 180 s |
| 297 | flora | main | `tools/flora.test.ts` | bun | 0.2 s | 180 s |
| 298 | grant-until | main | `tools/grant-until-test.ts` | bun | 1 s | 180 s |
| 299 | lite-graph | main | `tools/lite-graph-test.ts` | bun | 1 s | 180 s |
| 300 | lite-choice | main | `tools/lite-choice-test.mjs` | bun | 0.2 s | 180 s |
| 301 | net-send-shape | main | `tools/net-send-shape-test.ts` | bun | 1 s | 180 s |
| 302 | first-name-account | main | `tools/first-name-account-test.ts` | bun | 1 s | 180 s |
| 303 | retired-commands | main | `tools/retired-commands-test.ts` | bun | 1 s | 180 s |
| 304 | animnames-retry | main | `tools/animnames-retry-test.ts` | bun | 2.5 s | 180 s |
| 305 | screenshots | main | `tools/bun-test.ts tools/screenshots-test.ts` | bun | 9 s | 180 s |
| 306 | snapframe-render | main | `tools/snapframe-render-test.ts` | bun | 0.1 s | 180 s |
| 307 | snapframe | main | `tools/snapframe-test.ts` | bun | 2 s | 180 s |
| 308 | anim-backpressure | main | `tools/anim-backpressure-test.ts` | bun | 0.3 s | 180 s |
| 309 | anim-wire | main | `tools/anim-wire-test.ts` | bun | 6 s | 180 s |
| 310 | panels | main | `tools/panels-test.ts` | bun | 1 s | 180 s |
| 311 | panels-schema | main | `tools/panels-schema-test.ts` | bun | 0.3 s | 180 s |
| 312 | dock | main | `tools/dock-test.ts` | bun | 2.5 s | 180 s |
| 313 | perfscope | main | `tools/perfscope-test.ts` | bun | 0.5 s | 180 s |
| 314 | clickuse | main | `tools/clickuse-test.ts` | bun | 0.3 s | 180 s |
| 315 | bodies-wear | main | `tools/bodies-wear-test.mjs` | bun | 1 s | 180 s |
| 316 | settings-panels | main | `tools/settings-panels-test.ts` | bun | 0.5 s | 180 s |
| 317 | dropdown | main | `tools/dropdown-test.ts` | bun | 0.3 s | 180 s |
| 318 | namereveal | main | `tools/namereveal-test.mjs` | bun | 0.2 s | 180 s |
| 319 | mention-regex | main | `tools/mention-regex-test.mjs` | bun | 0.2 s | 180 s |
| 320 | icons | main | `tools/icons-test.ts` | bun | 0.2 s | 180 s |
| 321 | dwell | main | `tools/dwell-test.mjs` | bun | 0.2 s | 180 s |
| 322 | bus-events | main | `tools/bus-events-test.ts` | bun | 0.2 s | 180 s |
| 323 | actions | main | `tools/actions-test.mjs` | bun | 0.2 s | 180 s |
| 324 | edittheme | main | `tools/edittheme-test.ts` | bun | 0.3 s | 180 s |
| 325 | components-inspector | main | `tools/components-inspector-test.ts` | bun | 0.8 s | 180 s |
| 326 | chat-resync-wire | main | `tools/chat-resync-wire-test.ts` | bun | 0.2 s | 180 s |
| 327 | chat-log | main | `tools/chat-log-test.ts` | bun | 0.2 s | 180 s |
| 328 | chat-scrollback | main | `tools/chat-scrollback-test.ts` | bun | 10.5 s | 180 s |
| 329 | attention | main | `tools/attention-test.ts` | bun | 0.7 s | 180 s |
| 330 | surface-hold | main | `tools/surface-hold-test.ts` | bun | 19 s | 180 s |
| 331 | sfu-adapter | main | `tools/sfu-adapter-test.ts` | bun | 0.5 s | 180 s |
| 332 | relay-decision | main | `tools/relay-decision-test.ts` | bun | 0.2 s | 180 s |
| 333 | sfu-mic-intent-race | main | `tools/sfu-mic-intent-race-test.mjs` | bun | 0.3 s | 180 s |
| 334 | mic-ptt | main | `tools/mic-ptt-test.mjs` | bun | 7.2 s | 180 s |
| 335 | micstate | main | `tools/micstate-test.mjs` | bun | 0.6 s | 180 s |
| 336 | voice-wire | main | `tools/voice-wire-test.ts` | bun | 2 s | 180 s |
| 337 | voice-wire-mutation | main | `tools/voice-wire-mutation-test.ts` | bun | 10.5 s | 180 s |
| 338 | voicesource-real | main | `tools/voicesource-real-test.mjs` | bun | 0.2 s | 180 s |
| 339 | captions | main | `tools/captions-test.ts` | bun | 0.2 s | 180 s |
| 340 | voicebot | main | `tools/voicebot-test.ts` | bun | 3 s | 180 s |
| 341 | tts-fault | main | `tools/tts-fault-test.ts` | bun | 0.5 s | 180 s |
| 342 | spoken-form | main | `tools/spoken-form-test.mjs` | bun | 0.2 s | 180 s |
| 343 | ttsrow | main | `tools/ttsrow-test.mjs` | bun | 0.5 s | 180 s |
| 344 | particles | main | `tools/particles-test.ts` | bun | 1 s | 180 s |
| 345 | particles-host | main | `tools/particles-host-test.ts` | bun | 0.2 s | 180 s |
| 346 | shadow-fade | main | `tools/shadow-fade-test.mjs` | bun | 1 s | 180 s |
| 347 | lamp-slot-policy | main | `tools/lamp-slot-policy-test.mjs` | bun | 0.5 s | 180 s |
| 348 | lamp-skin | main | `tools/lamp-skin-test.mjs` | bun | 0.3 s | 180 s |
| 349 | transmission | main | `tools/transmission-test.mjs` | bun | 0.5 s | 180 s |
| 350 | body-shadow-gate | main | `tools/body-shadow-gate-test.mjs` | bun | 0.3 s | 180 s |
| 351 | frames-layout | main | `tools/frames-layout-test.ts` | bun | 1 s | 180 s |
| 352 | lantern | main | `tools/lantern-test.ts` | bun | 1 s | 180 s |
| 353 | frames-resize | main | `tools/frames-resize-test.ts` | bun | 0.2 s | 180 s |
| 354 | models-field | main | `tools/models-field-test.ts` | bun | 1 s | 180 s |
| 355 | lod-policy | main | `tools/lod-policy-test.ts` | bun | 0.3 s | 180 s |
| 356 | lod-client | main | `tools/lod-client-test.ts` | bun | 20 s | 180 s |
| 357 | realized-lifecycle | main | `tools/realized-lifecycle-test.ts` | bun | 0.7 s | 180 s |
| 358 | components-wire | main | `tools/components-wire-test.ts` | bun | 1.2 s | 180 s |
| 359 | axes | main | `tools/axes-test.ts` | bun | ? | 300 s |
| 360 | catalogue | main | `tools/protocol/catalogue-check.ts` | bun | ? | 300 s |
| 361 | compose | main | `tools/compose-test.ts` | bun | ? | 300 s |
| 362 | translate | main | `tools/protocol/translate-check.ts` | bun | 6 s | 180 s |
| 363 | owners | main | `tools/protocol/owners-check.ts` | bun | ? | 300 s |
| 364 | setup | main | `tools/protocol/setup-check.ts` | bun | 3 s | 180 s |
| 365 | importer | main | `tools/protocol/importer-check.ts` | bun | 1.2 s | 180 s |
| 366 | eidosim-v1 | main | `tools/protocol/import-v1/eidosim-v1-test.ts` | bun | 0.2 s | 180 s |
| 367 | channelbox | main | `tools/channelbox-test.ts` | bun | ? | 300 s |
| 368 | euler | main | `tools/euler-test.ts` | bun | 0.3 s | 180 s |
| 369 | last-world | main | `tools/last-world-test.ts` | bun | 0.6 s | 180 s |
| 370 | event-wire | main | `tools/event-wire-test.ts` | bun | 0.1 s | 180 s |
| 371 | join-rfc005 | main | `tools/join-rfc005-test.ts` | bun | 20 s | 180 s |
| 372 | denoise | main | `mcpl/denoise-test.ts` | bun | 6 s | 180 s |
| 373 | killz-slumped | main | `tools/killz-slumped-test.ts` | bun | 32 s | 180 s |
| 374 | consent-scripts-list | main | `tools/consent-scripts-list-test.ts` | bun | 2 s | 180 s |
| 375 | custody-save | main | `tools/custody-save-test.ts` | bun | 0.1 s | 180 s |
| 376 | level-dive | browser | `tools/water/level-dive-check.ts` | Chromium | ? | 300 s |
| 377 | toast-group | browser | `tools/protocol/toast-group-check.ts` | Chromium | ? | 300 s |
| 378 | browser | browser | `tools/protocol/browser-check.ts` | Chromium | 1.5 s | 180 s |
| 379 | client | browser | `tools/protocol/client-check.ts` | Chromium | 60 s | 300 s |
| 380 | refusedjoin | browser | `tools/protocol/refusedjoin-check.ts` | Chromium | 150 s | 750 s |
| 381 | harness | browser | `tools/harness-test.ts` | Chromium | ? | 300 s |
| 382 | client-b2 | browser | `tools/protocol/batch2-probe.ts` | Chromium | 19 s | 180 s |
| 383 | access-panel | browser | `tools/protocol/access-panel-probe.ts` | Chromium | ? | 300 s |
| 384 | lock-strength | browser | `tools/lock-strength-test.ts` | Chromium | 10 s | 180 s |
| 385 | swim-lists | browser | `tools/swim-lists-test.ts` | Chromium | 10 s | 180 s |
| 386 | build-client | browser | `tools/protocol/build-probe.ts` | Chromium | 8.1 s | 180 s |
| 387 | comps-parity | browser | `tools/comps-parity-test.ts` | Chromium | ? | 300 s |
| 388 | shiplist-probe | browser | `tools/protocol/shiplist-probe.ts` | Chromium | 197 s | 985 s |
| 389 | xss-probe | browser | `tools/protocol/xss-probe.ts` | Chromium | 15 s | 180 s |
| 390 | party-probe | browser | `tools/protocol/party-probe.ts` | Chromium | 486 s | 2430 s |
| 391 | colour-picker | browser | `tools/colour-picker-bench.ts` | Chromium | 8.1 s | 180 s |
| 392 | xr-lifecycle | browser | `tools/xr-lifecycle-probe.mjs` | Chromium | 60 s | 300 s |
| 393 | xr-res | browser | `tools/xr-res-probe.mjs` | Chromium | 70 s | 350 s |
| 394 | xr-debug-live | browser | `tools/xr-debug-live-probe.mjs` | Chromium | 60 s | 300 s |
| 395 | xr-quad-softswap | browser | `tools/xr-quad-softswap-probe.mjs` | Chromium | 60 s | 300 s |
| 396 | xr-eye-binding | browser | `tools/xr-eye-binding-probe.mjs` | Chromium | 10 s | 180 s |
| 397 | htmlmesh-pick | browser | `tools/htmlmesh-pick-probe.mjs` | Chromium | 6 s | 180 s |
| 398 | vrmic-exec | browser | `tools/vrmic-exec-test.mjs` | Chromium | 0.5 s | 180 s |
| 399 | xr-nullfb | browser | `tools/xr-nullfb-test.mjs` | Chromium | 0.3 s | 180 s |
| 400 | xr-desktop-banner | browser | `tools/xr-desktop-banner-probe.mjs` | Chromium | 80 s | 400 s |
| 401 | sky-bake-time | browser | `tools/sky-bake-time-probe.mjs` | Chromium | 75 s | 375 s |
| 402 | sky-bakegraph | browser | `tools/sky-bakegraph-probe.mjs` | Chromium | 95 s | 475 s |
| 403 | client-tools | browser | `tools/run-client.ts --import-only --skip-suites --strict-env` | Chromium | 202 s | 1010 s |

Lanes: core 18 suites (~79 s), main 357 (~2090 s), browser 28 (~1684 s); 403 suites in all.
<!-- END GENERATED -->
