# #333: the `xr-quad-softswap` red (the first gate's 416/417)

Written 2026-11-17 from the preserved shard logs, the load samples, the lone rerun, the Windows CI note, the review
tracker, and git. Every
claim is tagged **[checked]** (read from a preserved file or from git/GitHub today) or **[inference]** (a reading of
the evidence that nothing preserved proves). No test was run to write this.

## What was preserved

Two 16-shard local gates, each with the failing shard's log and a load sample taken every ~2 s (columns: epoch,
used RAM MB, 1-min load average, headless Chromes):

| run | commit | wall | result | peak load | peak Chromes | failing shard log kept |
|---|---|---|---|---|---|---|
| run-16-193436 (2026-11-15 03:34 UTC) | `1f8947510` | 565 s | 412 pass / 5 fail of 417 | 85.77 | 84 | shard 13 only |
| run-16-195645 (2026-11-15 03:56 UTC) | `ded52c8fb` | 664 s | **416 pass / 1 fail of 417**, 0 skipped | 69.47 | 64 | shard 14 |

- [checked] The ded52c8fb gate's one red is `xr-quad-softswap [browser] (client/xr-quad-softswap-probe.mjs) FAIL
  (exit 1) 60.0 s`. Seven rows pass (boot, the XR context, entry staging, "LAZY: no quad is built at entry", "the
  ring's 'panels' slot SHOWS the quads"), then `Error: page main thread pinned for 20 s` from the probe's line 31.
- [checked] The same shard's `client-check` line in that run says `load 59.8→67.3 (30 cores) · 7 foreign headless
  chromes · UNDER LOAD: a red here may be timing`.
- [checked] In the 1f8947510 gate, shard 13 fails the same row with the same error after 99.3 s. Only shard 13's log
  was kept, so the other four of that run's five reds can't be read from this bundle.
- [checked] The lone rerun (`rerun-13-final2.out`): `xr-quad-softswap rc=0 19s :: [probe] 19 passed, 0 failed`, with
  the full row list, including the soft-swap rows that the gated run never reached. The rerun output doesn't record
  which commit it ran on.
- [checked] An earlier attempt at that rerun (`rerun-13-final.out`) failed in 1 s on `ownedWorld: founding "staging"
  failed: Module not found "tools/world.ts"`. That is the old pre-move path, a launch error, and it says nothing
  about the probe. It is kept because it was run.
- [checked] Both gates' `xr-quad-softswap` copies use a 20 s page-step allowance:
  `ded52c8fb:test/client/xr-quad-softswap-probe.mjs:31` has
  `setTimeout(() => rej(new Error('page main thread pinned for 20 s')), 20000)`. The 60.0 s is the suite's wall time,
  not the step allowance.

## The outcome, claim by claim

The handoff summary said "a fixed 20 s page-step allowance, now 60 s (`PINNED_S = 60`), landed on anima PR #331 as
`a7435e185`, with an A/B showing main failing the same way under load." Checked against git and GitHub:

1. **The 20 s fixed allowance: correct.** [checked] Shown above.
2. **`a7435e185` raises it to 60 s with `PINNED_S = 60`: correct.** [checked] Commit `a7435e185` ("xr-quad-softswap:
   allow 60 s for a page step, not 20", 2026-11-14) adds `const PINNED_S = 60;` and uses it in the race. It edits
   main's path, `tools/xr-quad-softswap-probe.mjs`. Its parent is `57a94b4e1`, which sits on `f91058158`, the
   current `anima/main` and the merge base of #333.
3. **"Landed": not correct.** [checked 2026-11-17 via `gh pr view 331`] anima-research/eidoverse-worlds PR #331 is
   **OPEN, not merged** (head `0d735545d`, 3 commits: `57a94b4e1`, `a7435e185`, `0d735545d`; its 3 checks are
   green). `a7435e185` is **not** an ancestor of `anima/main` and **not** in #333's frozen head `81a246419`. At the
   frozen head, `test/client/xr-quad-softswap-probe.mjs:31` still says 20 s.
   - #331's description covers only the body-state commit. It doesn't mention the softswap allowance or the third
     commit (LD5).
4. **"A/B showing main failing the same way under load": stated, not preserved.** The only record is
   `a7435e185`'s commit message: "Red 3/3 on main at 20 s under 64 busy loops; green 2/2 (19/0) at 60 s". The same
   claim appears in the Windows CI note (local notes, not in this bundle) ("main's copy of the probe fails identically under load"). No raw
   log of that A/B is in the evidence folder or anywhere else I searched. So it is the author's testimony, not
   evidence a reviewer can re-read. [checked: absence of logs] [inference: the A/B happened as described]
5. **Classification: a timing-class red, not a #333 regression.** [inference, from the following]
   - The row fails only under heavy load (load 60–86 on 30 cores, 64–84 headless Chromes), and always at the same
     step: the first show of the quads, which draws every panel on the main thread.
   - It passes alone with 19/0.
   - The commit message reports an A/B against main.

   Nothing preserved measures how long that step takes under load. "It outlasts 20 s" is inferred from the error
   firing, not timed.

## Where the row stands at the frozen head

- [checked] At `81a246419`, `xr-quad-softswap` **is not in the gate**. `test/gate/ungated.json:72` lists it: "red on
  windows-latest in #333's CI; green on Linux and macOS. Gate it again once a Windows lane is green." Commit
  `47fc4e1d1` ("gate: the seven browser rows red on windows-latest go back to ungated.json") moved it there. At
  `ded52c8fb` it was gated (`test/gate/suites.ts:283`, in `BROWSER` at `:438`). On main it was never gated: #333's
  `1302e43dd` gated it.
- [checked] This connects to a separate problem, the Windows CI reds (run 43676044644 on `ded52c8fb`). There, every
  gated probe launched through `launchBrowser()` failed on windows-latest. The two that printed a page error show a
  null WebGL context at boot. That is a different failure from this load timeout. Those reds are classified in the
  Windows CI note and in the CI-reds note for run 43754957507 (both local notes, not in this bundle; either can be added): nine Windows reds; seven ungated by `47fc4e1d1`;
  `htmlmesh-pick` and `xr-debug-live` ungated later (at the frozen head, `ungated.json:76-77`).
- [checked] The review tracker (11-15) records "Windows never-green probe rows + launcher swap: pulling out of #333".
  At the frozen head the rows are out (ungated). The launcher swap is still in: `test/harness/probe-harness.mjs:7`
  imports `launchCdp` from `./cdp-pw.mjs`, which `1302e43dd` added. Nothing in these files says whether that was
  decided later.
- **Open items** (by inference; these are the steps that close it):
  1. Merge #331, or carry `a7435e185` across the move to `test/client/xr-quad-softswap-probe.mjs`. If #331 merges
     first, the next main→#333 merge must re-apply it at the new path: git will see a modify on a renamed file.
  2. Re-gate the row once a Windows lane is green.
  3. If a reviewer wants the A/B as evidence, rerun it and keep the logs.
