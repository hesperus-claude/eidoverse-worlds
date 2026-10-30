# The protocol gate

`tools/protocol/run.ts` is the protocol gate. It runs every protocol suite in its own process, in three lanes, and it
passes only when every suite passed and none was skipped. This file describes what the gate needs and how it reports.
The suite table at the bottom is generated from `run.ts` (`--manifest`), and the gate refuses to start when the two
disagree, so the table can't drift.

## Running it

```sh
bun install --frozen-lockfile                 # in the checkout root, in client/, and in mcpl/
CHROME=/path/to/chrome EIDOVERSE_DIR=/path/to/eidoverse-video bun tools/protocol/run.ts    # or: bun run test:protocol
```

Exit 0 means the gate passed. Exit 1 means a suite failed, a suite or a check was skipped, or the preflight found a
problem (it lists each one). Exit 2 means a bad argument.

Other forms, none of which is the gate:

| command | what it does |
|---|---|
| `bun tools/protocol/run.ts hostile phys` | runs only the named suites; the end says `PARTIAL PASS … this is not the gate` |
| `bun tools/protocol/run.ts --lane core` | runs one lane (`core`, `main` or `browser`), also reported as partial |
| `bun tools/protocol/run.ts --shard 2/4` | runs shard 2 of 4 (1-based; `tools/protocol/shard.ts` packs the suites by `suite-times.json`) and ends `SHARD 2/4 PASS`; CI's gate is every shard's receipt merged by `tools/protocol/merge-receipts.ts`, which fails on a missing shard, a suite missing or run twice, any failure, or mixed heads |
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
   storage and durability rows), `access`, `identity`, `scars`, `txn` (every request ends committed,
   rolled-back or ambiguous, a reset or a door change while it waits included; one request capability rechecked at both await-to-commit seams) and `txn-mutants` (each
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
| `EIDOVERSE_DIR` | `<suite dir>/library` (empty) for core and main; **the browser lane requires it** | the asset library is a separate public repo, `SkyeShark/eidoverse-video`, pinned at `9acc1528b2febac11338107645ef500a95985ca5`. Set `EIDOVERSE_DIR` to a checkout of it; without one the gate fails before any suite runs, naming the clone command. Only browser suites see it, read-only |
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
OS (`tools/protocol/procgroup.ts`: `/proc` on Linux, `ps` on macOS, the process tree on Windows), and PATH is searched
with the OS's own separator. The script sandbox tells a starved process from a stuck script with `/proc` CPU time on
Linux and, where there is no `/proc`, by whether the process ever took the job (scripts-check I8 and I8n).

`.github/workflows/protocol-gate.yml` runs the whole gate on all three OSes at the exact head of every PR, and each run
uploads a receipt (`--receipt <file>`): the head, whether the tree was dirty, OS, runtimes, the asset library's head,
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
| 16 | txn | core | `tools/protocol/txn-check.ts` | bun | 0.8 s | 180 s |
| 17 | txn-mutants | core | `tools/protocol/txn-check.ts --mutants` | bun | 11 s | 180 s |
| 18 | simmath | main | `tools/simmath-test.ts` | bun | 1 s | 180 s |
| 19 | body-state-bundle | main | `tools/body-state-bundle-test.ts` | bun | 0.2 s | 180 s |
| 20 | shard | main | `tools/protocol/shard-check.ts` | bun | 1 s | 180 s |
| 21 | nonumber | main | `tools/protocol/nonumber-check.ts` | bun | 1.4 s | 180 s |
| 22 | hostile | main | `tools/protocol/hostile-check.ts` | bun | 0.3 s | 180 s |
| 23 | attack | main | `tools/protocol/attack-check.ts` | bun | 1.5 s | 180 s |
| 24 | libfile | main | `tools/protocol/libfile-check.ts` | bun | 0.1 s | 180 s |
| 25 | library-decode | main | `tools/library-decode-test.ts` | bun | 2.6 s | 180 s |
| 26 | idle-stall | main | `tools/idle-stall-test.ts` | bun | 22.8 s | 180 s |
| 27 | fetchbytes | main | `tools/fetchbytes-test.mjs` | bun | 0.5 s | 180 s |
| 28 | variant-status | main | `tools/variant-status-test.ts` | bun | 0.2 s | 180 s |
| 29 | optimize-pump | main | `tools/optimize-pump-test.ts` | bun | 1 s | 180 s |
| 30 | ktx2-tf-purge | main | `tools/ktx2-tf-purge-test.ts` | bun | 0.3 s | 180 s |
| 31 | image-lie | main | `tools/image-lie-test.ts` | bun | 0.2 s | 180 s |
| 32 | glbperf-file | main | `tools/glbperf-file-test.ts` | bun | 0.3 s | 180 s |
| 33 | gaps | main | `tools/protocol/gaps-check.ts` | bun | 5.6 s | 180 s |
| 34 | phys | main | `tools/protocol/phys-check.ts` | bun | 3.9 s | 180 s |
| 35 | physlive | main | `tools/protocol/physlive-check.ts` | bun | 1.2 s | 180 s |
| 36 | phystick | main | `tools/protocol/phystick-check.ts` | bun | 5.7 s | 180 s |
| 37 | sclock | main | `tools/protocol/sclock-check.ts` | bun | 2.8 s | 180 s |
| 38 | server-clock-readers | main | `tools/server-clock-readers-test.ts` | bun | 0.2 s | 180 s |
| 39 | physseeds | main | `tools/protocol/physseeds-check.ts` | bun | 2.1 s | 180 s |
| 40 | eidosim | main | `tools/protocol/eidosim-check.ts` | bun | 12 s | 180 s |
| 41 | eidosim-live | main | `tools/protocol/eidosim-live-check.ts` | bun | 1.5 s | 180 s |
| 42 | mover | main | `tools/protocol/mover-check.ts` | bun | 4.5 s | 180 s |
| 43 | zone-water | main | `tools/protocol/zone-water-check.ts` | bun | 0.6 s | 180 s |
| 44 | underwater-presence | main | `tools/underwater-presence-test.ts` | bun | 0.2 s | 180 s |
| 45 | buoyancy | main | `tools/buoyancy-test.ts` | bun | 0.2 s | 180 s |
| 46 | climb-env | main | `tools/protocol/climb-env-check.ts` | bun | 0.5 s | 180 s |
| 47 | drive | main | `tools/protocol/drive-check.ts` | bun | 0.6 s | 180 s |
| 48 | physics-area | main | `tools/protocol/physics-area-check.ts` | bun | 0.5 s | 180 s |
| 49 | water-vectors | main | `tools/water-vectors.ts --check` | bun | 0.2 s | 180 s |
| 50 | water-import | main | `tools/water/import-golden-check.ts` | bun | ? | 300 s |
| 51 | avatar | main | `tools/avatar-test.ts` | bun | 1 s | 180 s |
| 52 | locomotion-clip | main | `tools/locomotion-clip-test.mjs` | bun | 0.2 s | 180 s |
| 53 | fp-view | main | `tools/fp-view-test.ts` | bun | 0.2 s | 180 s |
| 54 | reachwire | main | `tools/reachwire-test.ts` | bun | 0.2 s | 180 s |
| 55 | reach | main | `tools/reach-test.ts` | bun | 0.2 s | 180 s |
| 56 | ragdoll-floor | main | `tools/ragdoll-floor-test.ts` | bun | 3.9 s | 180 s |
| 57 | posture-tiles | main | `tools/posture-tiles-test.ts` | bun | 0.5 s | 180 s |
| 58 | poseclip-parity | main | `tools/poseclip-parity-test.ts` | bun | 0.2 s | 180 s |
| 59 | pose-handler | main | `tools/pose-handler-test.ts` | bun | 0.2 s | 180 s |
| 60 | plateanchor | main | `tools/plateanchor-test.ts` | bun | 0.3 s | 180 s |
| 61 | flight | main | `tools/flight-test.ts` | bun | 0.5 s | 180 s |
| 62 | firstperson-plate | main | `tools/firstperson-plate-test.ts` | bun | 0.5 s | 180 s |
| 63 | bodyscale | main | `tools/bodyscale-test.ts` | bun | 0.7 s | 180 s |
| 64 | avatar-perf | main | `tools/avatar-perf-test.ts` | bun | 0.5 s | 180 s |
| 65 | armsolve | main | `tools/armsolve-test.ts` | bun | 0.2 s | 180 s |
| 66 | ammodoll | main | `tools/ammodoll-test.ts` | bun | 8.4 s | 180 s |
| 67 | remotes-limp-edge | main | `tools/remotes-limp-edge-test.ts` | bun | 0.5 s | 180 s |
| 68 | remotes-lifecycle | main | `tools/remotes-lifecycle-test.ts` | bun | 1 s | 180 s |
| 69 | colliders | main | `tools/collider-test.ts` | bun | 0.2 s | 180 s |
| 70 | supportclass | main | `tools/supportclass-test.ts` | bun | 0.2 s | 180 s |
| 71 | support | main | `tools/support-test.ts` | bun | 0.3 s | 180 s |
| 72 | structure-field | main | `tools/structure-field-test.ts` | bun | 0.2 s | 180 s |
| 73 | structure-edit | main | `tools/structure-edit-test.ts` | bun | 0.2 s | 180 s |
| 74 | structure-collider | main | `tools/structure-collider-test.ts` | bun | 0.2 s | 180 s |
| 75 | lying-support | main | `tools/lying-support-test.ts` | bun | 1.5 s | 180 s |
| 76 | support-swap | main | `tools/support-swap-test.ts` | bun | ? | 300 s |
| 77 | knockdown | main | `tools/knockdown-test.ts` | bun | ? | 300 s |
| 78 | sockets | main | `tools/sockets-test.ts` | bun | ? | 300 s |
| 79 | seats-store | main | `tools/seats-store-test.ts` | bun | 0.9 s | 180 s |
| 80 | msgrate | main | `tools/msgrate-test.ts` | bun | 0.1 s | 180 s |
| 81 | shape-render | main | `tools/shape-render-test.ts` | bun | ? | 300 s |
| 82 | originof | main | `tools/originof-test.ts` | bun | ? | 300 s |
| 83 | renderer-cred | main | `tools/renderer-cred-test.ts` | bun | ? | 300 s |
| 84 | renderer-join | main | `tools/renderer-join-test.ts` | bun | 0.2 s | 180 s |
| 85 | render-health | main | `tools/render-health-test.ts` | bun | 0.2 s | 180 s |
| 86 | replay | main | `tools/protocol/replay-check.ts` | bun | 0.4 s | 180 s |
| 87 | replica-freeze | main | `tools/replica-freeze-test.ts` | bun | 0.5 s | 180 s |
| 88 | conformance | main | `tools/protocol/compare.ts` | python3 + cryptography | 2.9 s | 180 s |
| 89 | sweep | main | `tools/protocol/sweep.ts` | bun | 0.3 s | 180 s |
| 90 | oracle | main | `tools/protocol/import-v1/snapshot-oracle.ts` | bun | 0.4 s | 180 s |
| 91 | inplace | main | `tools/protocol/inplace-check.ts` | bun | 15 s | 180 s |
| 92 | version-route | main | `tools/version-route-test.ts` | bun | ? | 300 s |
| 93 | migrate-identities | main | `tools/protocol/migrate-identities-check.ts` | bun | 1.7 s | 180 s |
| 94 | oldworlds | main | `tools/oldworlds-test.ts` | bun | 1.2 s | 180 s |
| 95 | descriptors | main | `tools/descriptor-defaults-test.ts` | bun | 0.1 s | 180 s |
| 96 | light-readers | main | `tools/light-readers-test.ts` | bun | 0.4 s | 180 s |
| 97 | kind | main | `tools/kind-test.ts` | bun | 2 s | 180 s |
| 98 | ghost-mesh-size | main | `tools/ghost-mesh-size-test.ts` | bun | 0.5 s | 180 s |
| 99 | boot-init | main | `tools/boot-init-test.ts` | bun | 0.5 s | 180 s |
| 100 | splash-lifecycle | main | `tools/splash-lifecycle-test.mjs` | bun | 0.5 s | 180 s |
| 101 | bodygate | main | `tools/bodygate-test.mjs` | bun | 0.5 s | 180 s |
| 102 | editor-range | main | `tools/editor-range-test.ts` | bun | 0.3 s | 180 s |
| 103 | editschema | main | `tools/editschema-test.ts` | bun | 0.5 s | 180 s |
| 104 | selection | main | `tools/selection-test.ts` | bun | 0.2 s | 180 s |
| 105 | parts | main | `tools/parts-test.ts` | bun | 0.2 s | 180 s |
| 106 | motioneval | main | `tools/motioneval-test.ts` | bun | 0.2 s | 180 s |
| 107 | drag-q | main | `tools/drag-q-test.ts` | bun | 0.2 s | 180 s |
| 108 | components-corpus | main | `tools/components-corpus-test.ts` | bun | 0.2 s | 180 s |
| 109 | component-needs | main | `tools/component-needs-test.ts` | bun | 0.6 s | 180 s |
| 110 | scriptnew-expect | main | `tools/scriptnew-expect-test.ts` | bun | 0.5 s | 180 s |
| 111 | role-grammar | main | `tools/role-grammar-test.ts` | bun | 0.3 s | 180 s |
| 112 | rot | main | `tools/rot-test.ts` | bun | 0.1 s | 180 s |
| 113 | one-binding | main | `tools/one-binding-test.ts` | bun | 0.3 s | 180 s |
| 114 | onepose | main | `tools/protocol/onepose-check.ts` | bun | 0.3 s | 180 s |
| 115 | dismount-height | main | `tools/dismount-height-test.ts` | bun | 0.2 s | 180 s |
| 116 | latestread | main | `tools/latestread-test.ts` | bun | ? | 300 s |
| 117 | csp | main | `tools/csp-test.ts` | bun | ? | 300 s |
| 118 | build-gate | main | `tools/build-gate-test.ts` | bun | 0.3 s | 180 s |
| 119 | capsule-recovery | main | `tools/capsule-recovery-test.mjs` | bun | 10 s | 180 s |
| 120 | debug-tabs | main | `tools/debug-tabs-test.ts` | bun | 0.3 s | 180 s |
| 121 | governor-xr | main | `tools/governor-xr-test.ts` | bun | 0.2 s | 180 s |
| 122 | gpulost | main | `tools/gpulost-test.mjs` | bun | 0.3 s | 180 s |
| 123 | render-aside | main | `tools/render-aside-test.mjs` | bun | 0.3 s | 180 s |
| 124 | quadcolour | main | `tools/quadcolour-test.mjs` | bun | 1.1 s | 180 s |
| 125 | headset-seen | main | `tools/headset-seen-test.mjs` | bun | 0.2 s | 180 s |
| 126 | full-detail | main | `tools/full-detail-test.ts` | bun | 0.2 s | 180 s |
| 127 | finger-curl | main | `tools/finger-curl-test.mjs` | bun | 0.2 s | 180 s |
| 128 | backend-choice | main | `tools/backend-choice-test.mjs` | bun | 0.2 s | 180 s |
| 129 | unknown-comp | main | `tools/unknown-comp-test.ts` | bun | 1.1 s | 180 s |
| 130 | reach-order | main | `tools/reach-order-test.ts` | bun | 1.5 s | 180 s |
| 131 | editcommit | main | `tools/editcommit-test.ts` | bun | 0.8 s | 180 s |
| 132 | hierarchy-commit | main | `tools/hierarchy-commit-test.ts` | bun | 0.6 s | 180 s |
| 133 | verbclasses | main | `tools/protocol/verbclasses-check.ts` | bun | 0 s | 180 s |
| 134 | authority-layers | main | `tools/protocol/authority-layers-check.ts` | bun | 0 s | 180 s |
| 135 | ids | main | `tools/protocol/ids-check.ts` | bun | 1.4 s | 180 s |
| 136 | r8 | main | `tools/protocol/r8-check.ts` | bun | 0.9 s | 180 s |
| 137 | r9 | main | `tools/protocol/r9-check.ts` | bun | 1.5 s | 180 s |
| 138 | r10 | main | `tools/protocol/r10-check.ts` | bun | 1.7 s | 180 s |
| 139 | r11 | main | `tools/protocol/r11-check.ts` | bun | 0.6 s | 180 s |
| 140 | names | main | `tools/protocol/names-check.ts` | bun | 2.1 s | 180 s |
| 141 | parity | main | `tools/protocol/parity-check.ts` | bun | 5.4 s | 180 s |
| 142 | directory | main | `tools/protocol/directory-check.ts` | bun | 13 s | 180 s |
| 143 | keyhints | main | `tools/keyhints-check.ts` | bun | 0 s | 180 s |
| 144 | upgrade | main | `tools/protocol/upgrade-check.ts` | bun | 70 s | 350 s |
| 145 | server | main | `tools/protocol/server-check.ts` | bun | 40 s | 200 s |
| 146 | native-login | main | `tools/native-login-test.ts` | bun | 0.2 s | 180 s |
| 147 | mkconfig | main | `tools/mkconfig-test.ts` | bun | 0.3 s | 180 s |
| 148 | heightmap-route | main | `tools/heightmap-route-test.ts` | bun | 1.2 s | 180 s |
| 149 | config-env | main | `tools/config-env-test.ts` | bun | 0.2 s | 180 s |
| 150 | fork-reset | main | `tools/protocol/fork-reset-check.ts` | bun | 6 s | 180 s |
| 151 | simckpt | main | `tools/protocol/simckpt-check.ts` | bun | ? | 300 s |
| 152 | statecache | main | `tools/protocol/statecache-check.ts` | bun | ? | 300 s |
| 153 | foldparity | main | `tools/protocol/foldparity-check.ts` | bun | ? | 300 s |
| 154 | blockers-mutants-a | main | `tools/protocol/blockers-mutants.ts --group a` | bun | 110 s | 550 s |
| 155 | blockers-mutants-b | main | `tools/protocol/blockers-mutants.ts --group b` | bun | 110 s | 550 s |
| 156 | blockers-mutants-c | main | `tools/protocol/blockers-mutants.ts --group c` | bun | 110 s | 550 s |
| 157 | blockers-mutants-d | main | `tools/protocol/blockers-mutants.ts --group d` | bun | 110 s | 550 s |
| 158 | modserver-mutants-1 | main | `tools/protocol/modserver-mutants.ts --group 1/4` | bun | 360 s | 1800 s |
| 159 | modserver-mutants-2 | main | `tools/protocol/modserver-mutants.ts --group 2/4` | bun | 360 s | 1800 s |
| 160 | modserver-mutants-3 | main | `tools/protocol/modserver-mutants.ts --group 3/4` | bun | 360 s | 1800 s |
| 161 | modserver-mutants-4 | main | `tools/protocol/modserver-mutants.ts --group 4/4` | bun | 360 s | 1800 s |
| 162 | scripts | main | `tools/protocol/scripts-check.ts` | bun | 48 s | 240 s |
| 163 | scripting | main | `tools/protocol/scripting-check.ts` | bun | 2 s | 180 s |
| 164 | grab | main | `tools/protocol/grab-check.ts` | bun | 3.8 s | 180 s |
| 165 | shove | main | `tools/protocol/shove-check.ts` | bun | 2 s | 180 s |
| 166 | shove-walker | main | `tools/shove-test.ts` | bun | 0.1 s | 180 s |
| 167 | force | main | `tools/protocol/force-check.ts` | bun | ? | 300 s |
| 168 | physconst | main | `tools/physconst-test.ts` | bun | ? | 300 s |
| 169 | agentshove | main | `tools/protocol/agentshove-check.ts` | bun | 165 s | 825 s |
| 170 | hands | main | `tools/protocol/hands-check.ts` | bun | 1.2 s | 180 s |
| 171 | track-teleport | main | `tools/track-teleport-test.ts` | bun | 0.2 s | 180 s |
| 172 | put-settle | main | `tools/put-settle-test.ts` | bun | 0.2 s | 180 s |
| 173 | reset | main | `tools/protocol/reset-check.ts` | bun | 1.7 s | 180 s |
| 174 | settle | main | `tools/protocol/settle-check.ts` | bun | 5.4 s | 180 s |
| 175 | disabled | main | `tools/protocol/disabled-check.ts` | bun | 1.2 s | 180 s |
| 176 | histdiff | main | `tools/protocol/history-diff-check.ts` | bun | 0.3 s | 180 s |
| 177 | reachgate | main | `tools/protocol/reachgate-check.ts` | bun | 22 s | 180 s |
| 178 | consent | main | `tools/protocol/consent-check.ts` | bun | 0 s | 180 s |
| 179 | gates | main | `tools/protocol/gates-check.ts` | bun | 0.1 s | 180 s |
| 180 | consent-client | main | `tools/consent-client-test.ts` | bun | 0.2 s | 180 s |
| 181 | history-rows | main | `tools/protocol/history-rows-check.ts` | bun | 0.6 s | 180 s |
| 182 | scale | main | `tools/protocol/scale-check.ts` | bun | 125 s | 625 s |
| 183 | roles | main | `tools/protocol/roles-check.ts` | bun | 3.1 s | 180 s |
| 184 | batch2 | main | `tools/protocol/batch2-check.ts` | bun | 1.9 s | 180 s |
| 185 | describe-particles | main | `tools/protocol/describe-particles-check.ts` | bun | 1.1 s | 180 s |
| 186 | build | main | `tools/protocol/build-check.ts` | bun | 1.5 s | 180 s |
| 187 | counter | main | `tools/protocol/counter-check.ts` | bun | 2.2 s | 180 s |
| 188 | blueprint | main | `tools/blueprint-test.ts` | bun | 1.2 s | 180 s |
| 189 | shiplist | main | `tools/protocol/shiplist-check.ts` | bun | 1.7 s | 180 s |
| 190 | agenttools | main | `tools/protocol/agenttools-check.ts` | bun | 20 s | 180 s |
| 191 | look | main | `tools/look-test.ts` | bun | 0.2 s | 180 s |
| 192 | presence | main | `tools/protocol/presence-check.ts` | bun | 10 s | 180 s |
| 193 | modhole | main | `tools/protocol/modhole-check.ts` | bun | 0.1 s | 180 s |
| 194 | pretrans | main | `tools/protocol/pretrans-check.ts` | bun | 2.8 s | 180 s |
| 195 | soundclock | main | `tools/protocol/soundclock-check.ts` | bun | 0.2 s | 180 s |
| 196 | sound | main | `tools/sound-test.ts` | bun | ? | 300 s |
| 197 | audioctx | main | `tools/audioctx-test.ts` | bun | 0.2 s | 180 s |
| 198 | sound-editor | main | `tools/sound-editor-test.ts` | bun | ? | 300 s |
| 199 | skypanel | main | `tools/skypanel-state-test.ts` | bun | ? | 300 s |
| 200 | sky-bakelock | main | `tools/sky-bakelock-test.mjs` | bun | 0.3 s | 180 s |
| 201 | sky-swapchain | main | `tools/sky-swapchain-test.mjs` | bun | 0.3 s | 180 s |
| 202 | sky-lifecycle | main | `tools/sky-lifecycle-test.mjs` | bun | 5.2 s | 180 s |
| 203 | forecast | main | `tools/forecast-test.ts` | bun | 0.2 s | 180 s |
| 204 | physics-off | main | `tools/physics-off-test.ts` | bun | ? | 300 s |
| 205 | eidomodel | main | `tools/protocol/eidomodel-check.ts` | bun | 0.7 s | 180 s |
| 206 | alias | main | `mcpl/alias-test.ts` | bun | 0.4 s | 180 s |
| 207 | agent-mesh-collision | main | `tools/agent-mesh-collision-test.ts` | bun | 92 s | 460 s |
| 208 | navgrid | main | `tools/navgrid-test.ts` | bun | 64 s | 320 s |
| 209 | structure-threshold | main | `tools/structure-threshold-test.ts` | bun | 0.3 s | 180 s |
| 210 | structure-route | main | `tools/structure-route-test.ts` | bun | 0.3 s | 180 s |
| 211 | navgrid-rows | main | `tools/navgrid-rows-test.ts` | bun | 6.3 s | 180 s |
| 212 | places | main | `tools/places-test.ts` | bun | 130 s | 650 s |
| 213 | blank-part-uvs | main | `tools/blank-part-uvs-test.ts` | bun | 0.3 s | 180 s |
| 214 | storey-walk | main | `mcpl/storey-walk-test.ts` | bun | 1.5 s | 180 s |
| 215 | agent-reads | main | `mcpl/agent-reads-test.ts` | bun | ? | 300 s |
| 216 | door-unit | main | `mcpl/door-unit-test.ts` | bun | ? | 300 s |
| 217 | token-registry | main | `tools/token-registry-test.ts` | bun | 0.2 s | 180 s |
| 218 | door-media-whitelist | main | `tools/door-media-whitelist-test.mjs` | bun | 0.2 s | 180 s |
| 219 | door-bone-list | main | `tools/door-bone-list-test.ts` | bun | 0.3 s | 180 s |
| 220 | author-wire | main | `tools/author-wire-test.mjs` | bun | 0.2 s | 180 s |
| 221 | selfpose | main | `mcpl/selfpose-test.ts` | bun | 0.2 s | 180 s |
| 222 | effective-mcpl | main | `mcpl/effective-test.ts` | bun | ? | 300 s |
| 223 | headless-core | main | `mcpl/headless-core-test.ts` | bun | ? | 300 s |
| 224 | effective | main | `tools/effective-test.ts` | bun | ? | 300 s |
| 225 | stretched-support | main | `mcpl/stretched-support-test.ts` | bun | ? | 300 s |
| 226 | stretched-places | main | `mcpl/stretched-places-test.ts` | bun | ? | 300 s |
| 227 | door-body | main | `mcpl/door-body-test.ts` | bun | ? | 300 s |
| 228 | body-state | main | `tools/body-state-test.ts` | bun | 8 s | 180 s |
| 229 | shape-attach | main | `tools/shape-attach-test.ts` | bun | 0.7 s | 180 s |
| 230 | shape-physics | main | `tools/shape-physics-test.ts` | bun | 0.7 s | 180 s |
| 231 | shape-repair | main | `tools/shape-repair-test.ts` | bun | 0.4 s | 180 s |
| 232 | buildcheck | main | `tools/buildcheck-test.ts` | bun | 18 s | 180 s |
| 233 | buildcheck-queue | main | `tools/buildcheck-queue-test.ts` | bun | 7.4 s | 180 s |
| 234 | buildcheck-route | main | `tools/buildcheck-route-test.ts` | bun | 22 s | 180 s |
| 235 | door-is-error | main | `tools/door-is-error-test.ts` | bun | 11 s | 180 s |
| 236 | door-wording | main | `tools/door-wording-test.ts` | bun | ? | 300 s |
| 237 | consent-replay | main | `tools/consent-replay-test.ts` | bun | ? | 300 s |
| 238 | history-request | main | `tools/history-request-test.ts` | bun | 0.3 s | 180 s |
| 239 | named-pose | main | `tools/named-pose-test.ts` | bun | 2.6 s | 180 s |
| 240 | settled-pose | main | `tools/settled-pose-test.ts` | bun | 0.5 s | 180 s |
| 241 | pose-provenance | main | `tools/pose-provenance-test.ts` | bun | 0.5 s | 180 s |
| 242 | skystamp | main | `tools/skystamp-test.ts` | bun | 0.5 s | 180 s |
| 243 | grant-command | main | `tools/grant-command-test.ts` | bun | 0.3 s | 180 s |
| 244 | environment-realizer | main | `tools/environment-realizer-test.ts` | bun | 0.3 s | 180 s |
| 245 | terrainshape | main | `tools/terrainshape-test.ts` | bun | 0.2 s | 180 s |
| 246 | flora | main | `tools/flora.test.ts` | bun | 0.2 s | 180 s |
| 247 | grant-until | main | `tools/grant-until-test.ts` | bun | 1 s | 180 s |
| 248 | lite-graph | main | `tools/lite-graph-test.ts` | bun | 1 s | 180 s |
| 249 | lite-choice | main | `tools/lite-choice-test.mjs` | bun | 0.2 s | 180 s |
| 250 | net-send-shape | main | `tools/net-send-shape-test.ts` | bun | 1 s | 180 s |
| 251 | first-name-account | main | `tools/first-name-account-test.ts` | bun | 1 s | 180 s |
| 252 | retired-commands | main | `tools/retired-commands-test.ts` | bun | 1 s | 180 s |
| 253 | animnames-retry | main | `tools/animnames-retry-test.ts` | bun | 2.5 s | 180 s |
| 254 | screenshots | main | `tools/bun-test.ts tools/screenshots-test.ts` | bun | 9 s | 180 s |
| 255 | snapframe-render | main | `tools/snapframe-render-test.ts` | bun | 0.1 s | 180 s |
| 256 | snapframe | main | `tools/snapframe-test.ts` | bun | 2 s | 180 s |
| 257 | anim-backpressure | main | `tools/anim-backpressure-test.ts` | bun | 0.3 s | 180 s |
| 258 | anim-wire | main | `tools/anim-wire-test.ts` | bun | 6 s | 180 s |
| 259 | panels | main | `tools/panels-test.ts` | bun | 1 s | 180 s |
| 260 | namereveal | main | `tools/namereveal-test.mjs` | bun | 0.2 s | 180 s |
| 261 | mention-regex | main | `tools/mention-regex-test.mjs` | bun | 0.2 s | 180 s |
| 262 | icons | main | `tools/icons-test.ts` | bun | 0.2 s | 180 s |
| 263 | dwell | main | `tools/dwell-test.mjs` | bun | 0.2 s | 180 s |
| 264 | bus-events | main | `tools/bus-events-test.ts` | bun | 0.2 s | 180 s |
| 265 | actions | main | `tools/actions-test.mjs` | bun | 0.2 s | 180 s |
| 266 | edittheme | main | `tools/edittheme-test.ts` | bun | 0.3 s | 180 s |
| 267 | components-inspector | main | `tools/components-inspector-test.ts` | bun | 0.8 s | 180 s |
| 268 | chat-resync-wire | main | `tools/chat-resync-wire-test.ts` | bun | 0.2 s | 180 s |
| 269 | chat-log | main | `tools/chat-log-test.ts` | bun | 0.2 s | 180 s |
| 270 | attention | main | `tools/attention-test.ts` | bun | 0.7 s | 180 s |
| 271 | surface-hold | main | `tools/surface-hold-test.ts` | bun | 19 s | 180 s |
| 272 | sfu-adapter | main | `tools/sfu-adapter-test.ts` | bun | 0.5 s | 180 s |
| 273 | relay-decision | main | `tools/relay-decision-test.ts` | bun | 0.2 s | 180 s |
| 274 | sfu-mic-intent-race | main | `tools/sfu-mic-intent-race-test.mjs` | bun | 0.3 s | 180 s |
| 275 | mic-ptt | main | `tools/mic-ptt-test.mjs` | bun | 7.2 s | 180 s |
| 276 | voice-wire | main | `tools/voice-wire-test.ts` | bun | 2 s | 180 s |
| 277 | captions | main | `tools/captions-test.ts` | bun | 0.2 s | 180 s |
| 278 | tts-fault | main | `tools/tts-fault-test.ts` | bun | 0.5 s | 180 s |
| 279 | spoken-form | main | `tools/spoken-form-test.mjs` | bun | 0.2 s | 180 s |
| 280 | ttsrow | main | `tools/ttsrow-test.mjs` | bun | 0.5 s | 180 s |
| 281 | particles | main | `tools/particles-test.ts` | bun | 1 s | 180 s |
| 282 | particles-host | main | `tools/particles-host-test.ts` | bun | 0.2 s | 180 s |
| 283 | shadow-fade | main | `tools/shadow-fade-test.mjs` | bun | 1 s | 180 s |
| 284 | lamp-slot-policy | main | `tools/lamp-slot-policy-test.mjs` | bun | 0.5 s | 180 s |
| 285 | lamp-skin | main | `tools/lamp-skin-test.mjs` | bun | 0.3 s | 180 s |
| 286 | transmission | main | `tools/transmission-test.mjs` | bun | 0.5 s | 180 s |
| 287 | body-shadow-gate | main | `tools/body-shadow-gate-test.mjs` | bun | 0.3 s | 180 s |
| 288 | frames-layout | main | `tools/frames-layout-test.ts` | bun | 1 s | 180 s |
| 289 | frames-resize | main | `tools/frames-resize-test.ts` | bun | 0.2 s | 180 s |
| 290 | models-field | main | `tools/models-field-test.ts` | bun | 1 s | 180 s |
| 291 | lod-policy | main | `tools/lod-policy-test.ts` | bun | 0.3 s | 180 s |
| 292 | lod-client | main | `tools/lod-client-test.ts` | bun | 20 s | 180 s |
| 293 | translate | main | `tools/protocol/translate-check.ts` | bun | 6 s | 180 s |
| 294 | owners | main | `tools/protocol/owners-check.ts` | bun | ? | 300 s |
| 295 | setup | main | `tools/protocol/setup-check.ts` | bun | 3 s | 180 s |
| 296 | importer | main | `tools/protocol/importer-check.ts` | bun | 1.2 s | 180 s |
| 297 | eidosim-v1 | main | `tools/protocol/import-v1/eidosim-v1-test.ts` | bun | 0.2 s | 180 s |
| 298 | render-scene-import | main | `tools/render-scene-import-test.ts` | bun | ? | 300 s |
| 299 | channelbox | main | `tools/channelbox-test.ts` | bun | ? | 300 s |
| 300 | last-world | main | `tools/last-world-test.ts` | bun | 0.6 s | 180 s |
| 301 | event-wire | main | `tools/event-wire-test.ts` | bun | 0.1 s | 180 s |
| 302 | level-dive | browser | `tools/water/level-dive-check.ts` | Chromium | ? | 300 s |
| 303 | toast-group | browser | `tools/protocol/toast-group-check.ts` | Chromium | ? | 300 s |
| 304 | browser | browser | `tools/protocol/browser-check.ts` | Chromium | 1.5 s | 180 s |
| 305 | client | browser | `tools/protocol/client-check.ts` | Chromium | 60 s | 300 s |
| 306 | refusedjoin | browser | `tools/protocol/refusedjoin-check.ts` | Chromium | 150 s | 750 s |
| 307 | client-b2 | browser | `tools/protocol/batch2-probe.ts` | Chromium | 19 s | 180 s |
| 308 | access-panel | browser | `tools/protocol/access-panel-probe.ts` | Chromium | ? | 300 s |
| 309 | build-client | browser | `tools/protocol/build-probe.ts` | Chromium | 8.1 s | 180 s |
| 310 | shiplist-probe | browser | `tools/protocol/shiplist-probe.ts` | Chromium | 197 s | 985 s |
| 311 | xss-probe | browser | `tools/protocol/xss-probe.ts` | Chromium | 15 s | 180 s |
| 312 | party-probe | browser | `tools/protocol/party-probe.ts` | Chromium | 486 s | 2430 s |
| 313 | colour-picker | browser | `tools/colour-picker-bench.ts` | Chromium | 8.1 s | 180 s |
| 314 | client-tools | browser | `tools/run-client.ts --import-only --skip-suites` | Chromium | 202 s | 1010 s |

Lanes: core 17 suites (~78 s), main 284 (~3071 s), browser 13 (~1147 s); 314 suites in all.
<!-- END GENERATED -->
