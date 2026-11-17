# #333 frozen-head review bundle (2026-11-17)

| | |
|---|---|
| PR | anima-research/eidoverse-worlds #333 (folder reorg + cleanup), branch `cleanup/split7` on hesperus-claude/eidoverse-worlds |
| Frozen head | `81a246419869dffba630a22ca46e3d3d9b2897f6` |
| Base (`git merge-base 81a246419 anima/main`) | `f91058158e9d89f9ab2ac3a88420ea803a220fc3` |
| `anima/main` when fetched (2026-11-17) | `f91058158…`, the same commit: the head already contains all of current main |
| Commits base..head | 1027 (1010 non-merge, 17 merges) |
| Assembled | 2026-11-17, read-only on the repo; no test suite was run for this bundle |

## Files

| file | what it is |
|---|---|
| `00-README.md` | this file: the mapping's method, counts and injectivity; one line per true addition and deletion; hashes |
| `01-mapping.tsv` | the old→new path manifest, base → frozen head. Every base path and every head path appears exactly once |
| `02-dispositions-round1.md` | auto-review round 1 (review of `ded52c8fb`): the four quarter dispositions, concatenated |
| `02-dispositions-round2.md` | auto-review round 2 (review of `a1697c962`): lanes a–d results plus the earmarked round-1 decisions |
| `03-post-pr.md` | everything not fixed in #333, with where to start |
| `04-xr-quad-softswap.md` | the classification of the first gate's one red (416/417), claim by claim: evidence vs inference |
| `scripts/*.py` | the scripts that built `01-mapping.tsv` (order: map → trace → build → sim → emit; run from one folder; each reads the previous step's JSON) |

In 02 and 03, local machine paths and private-notes references were replaced by "(local notes)" or "a local
worktree". Everything else is verbatim.

## 01-mapping.tsv

Columns: `status`, `old_path`, `new_path`, `old_lines_kept_pct` and `new_lines_from_old_pct` (multiset of trimmed
non-trivial lines, moves only), `evidence`, `commits`, `note`, `content_lookalike_info_only`.

**How it was paired.**
1. Every base path is traced through the per-commit rename and delete events of the 1010 non-merge commits
   (`git log --reverse --topo-order --no-merges -M --name-status`). Each commit's own `-M` is the evidence. Most
   moves happened in pure-move commits, so this is much sharper than an end-to-end diff (`evidence = history`,
   927 rows).
2. Three files that main added after the branch point were moved inside the merge of `anima/main` (`b7d498f4e`).
   For those, the end-to-end `git diff -M` pairing is used (`evidence = git-M`, 3 rows: `own-names-test`,
   `rand-test`, `physics-volume-check`).
3. Commit `7339f6fa8` deletes `tools/protocol/{suites,procgroup}.ts` and adds `test/gate/{suites,procgroup}.ts`.
   Per-commit `-M` missed both: `suites.ts` is a path list whose every path changed, and `procgroup.ts` is 3 lines.
   The commit message's move table names both (`evidence = commit-table`, 2 rows).
4. Pairing by content similarity was used only as a cross-check, never to pair. This is how the old `world.ts`
   swap was avoided: `tools/captionbot/world.ts → services/captionbot/world.ts` and
   `tools/protocol/world.ts → tools/world.ts`, both from history.

**Injective and complete: yes.** No old path maps to two new paths, and no new path has two sources. The union of
`old_path` equals the base tree (1581 files), and the union of `new_path` equals the head tree (1541 files).

| status | count |
|---|---|
| `rename`, pure (same blob) | 65 |
| `rename+edit` | 867 |
| `modified` in place (same path) | 326 |
| `unchanged` | 168 |
| `deleted`, true | 155 |
| `added`, true | 115 |

Check: 65 + 867 + 326 + 168 + 155 = 1581 base files; 65 + 867 + 326 + 168 + 115 = 1541 head files.

**Against plain `git diff -M base head`.** 837 of the 932 moves are the same pairing. 95 are moves that git shows as
delete + add. Two git "renames" are not moves:
- `tools/posecheck-test.ts → test/server/pose-handler-test.ts`: posecheck was deleted and merged into the gated
  suite (`b97b65260`), and `tools/pose-handler-test.ts` itself moved there (`04d041c07`).
- `tools/replica-hierarchy-test.ts → test/shared/replica-hierarchy-test.ts`: deleted as an audit DELETE
  (`8234f7766`), then main's suite was ported back and gated after review (`2cf188f21`, "#333 q2 411"). The two
  files share 87% of their lines, so it could equally be read as a move with edits. The manifest records the history
  (deleted, then added).

**Read these by hand.** Ten moves are flagged `move then rewrite: <20% of lines in common`. Each is a clean rename in
its move commit (per-commit score 50–100), then rewritten by later commits:
`spec/fixtures/README.md → test/fixtures/v1-worlds/README.md`, `tools/join-probe.mjs →
tools/operator/join-canary.mjs`, `tools/config-env-test.ts`, `tools/native-login-test.ts`, `client/lib/perf.js`,
`tools/protocol/hygiene-baseline.json`, `tools/body-state-mutation-test.ts`, `docs/GATE-MANIFEST.md`,
`tools/shadow-fade-test.mjs`, `tools/bodygate-test.mjs` (several of these absorbed merged tests). The last column
(`content_lookalike_info_only`) names, for a true deletion, the head file holding the most of its lines, and for a
true addition, the base file it most draws from; it is shown only at ≥30%. It is a hint for "where did this go",
not a pairing.

## Unexplained additions and deletions

**None.** [checked] Every one of the 155 deletions and 115 additions has a commit in base..head that makes it, and
each such commit's message says why: a named file, or a group ("16 duplicate tests merged into their survivors",
"retire flightbench", "essays cut to one line + pointer" → `docs/research/*`). Where a group message points to the
gate-or-delete audit of 2026-10-29 (not in the repo), the audit's own row for that file is quoted below: its
verdict, its reason and its survivor. One audit/commit mismatch:
`tools/wing-owner-wire-test.ts` was audited GATE, but `60ea1def7` deleted it because `named-pose-test` "replaces the
two wing-only presence tests".

Caveats [inference]: "explained" means a commit message or the audit states a reason. It does not mean the reason
was re-verified file by file for this bundle. The coverage claims ("its rows live in X") were checked by the review
rounds (02), not here.

## One line per true addition and deletion

Grouped by the commit that made the change; the commit's subject line is the reason. For deletions that the audit covers, its verdict and reason follow the path (paths there are at their audit-time location).

### 155 true deletions, by the commit that made them

- `ff2b1d49d` tests (round 3, lane A): 16 duplicate tests merged into their survivors, waits on conditions (sfu, keepalive, tts, spoken-say, chatbridge), micstate one suite; every touched test run alone green, references repointed, ungated 109→96
  - `tools/actionbar-restore-test.ts` — audit MERGE: 4 checks (:49-57) of one rule (viewport auto-restore lays the bar out as show() does) against the real windows.js; everything else is actionbar-test's stub set (header :5-6) (survivor: tools/actionbar-test.ts — move the restore section (needs the real windows.js resolved instead of the stub for that block))
  - `tools/chat-markdown-test.ts` — audit MERGE: same module and the identical stub set (:17-20 ≡ chat-log-test.ts:20-25, header "same stubs as chat-log-test"); inline markdown never parses HTML (:64-80), the 12-line recent tail (:97-101), unreadCo… (survivor: tools/chat-log-test.ts — append as its markdown/recent sections)
  - `tools/dock-boot-test.ts` — audit MERGE: 4 checks (:51-67) of the wrench auto-pin across a reload (ui.js reloaded with ?boot= :37) on dock-test's stubs (header :1 "dock-test's stubs") (survivor: tools/dock-test.ts — append as a "boot edge" section (fresh ui.js instance per boot as it already does at :37))
  - `tools/gpulost-gate-test.mjs` — audit MERGE: the render.js/capture.js lost-GPU gates (flag down/up/down) against a counting renderer; same module family as gpulost-test.mjs, both pure. ran 10-29: exit 0, 12 passed. (survivor: tools/gpulost-test.mjs (then its GATE row))
  - `tools/mic-ptt-ungated-test.mjs` — audit MERGE: ran 10-29: exit 0; same GlobalRegistrator + bun:test mock stub as mic-ptt-test.mjs (lines 10-29 = mic-ptt-test.mjs:13-54); driveRawTracks still exists (client/lib/micgate.js:185) (survivor: tools/mic-ptt-test.mjs (→ micstate-test.mjs))
  - `tools/micstate-exec-test.mjs` — audit MERGE: ran 10-29: exit 0; calls every micstate export under the same happy-dom stub (lines 16-23) as mic-ptt-test.mjs (survivor: tools/mic-ptt-test.mjs (→ micstate-test.mjs))
  - `tools/micstate-release-test.mjs` — audit MERGE: ran 10-29: exit 0, 14 passed; releaseMicrophone's lane-preservation (lines 57-72) is tested nowhere else; same stub family (survivor: tools/mic-ptt-test.mjs (→ micstate-test.mjs))
  - `tools/micstate-single-transport-test.mjs` — audit MERGE: ran 10-29: exit 1, 14 passed 1 failed: "…emits audio:mic with that state" (line 61) — micstate.js:239 does emit audio:mic, so the stub's bus capture is stale (fix when merging); drop the source-grep… (survivor: tools/mic-ptt-test.mjs (→ micstate-test.mjs))
  - `tools/native-login-wire-test.ts` — audit MERGE: duplicates the pure test's start→poll 202→approve 200→poll 200→poll 410 flow (native-login-wire-test.ts:52-60 vs native-login-test.ts:20-29) through a real server; 10-27 pass 3.8s; what moves to the… (survivor: tools/native-login-test.ts)
  - `tools/platesize-test.ts` — audit MERGE: pass 0.0s; platesize.js (plateSize, revealRamp, ownClearance) absent from the gate (grep platesize\ (survivor: plateSize: no hit); same subject (the nameplate) as plateanchor-test.ts — move its 30 checks there as a "size and fade" block so one nameplate test rides the avatar row | tools/plateanchor-test.ts)
  - `tools/route-preparation-test.ts` — audit MERGE: same scaffold as structure-threshold-test (planStructure + WorldAgent + prepareRouteLocal, agent-scratch); ROUTE_MAX_CELLS cap + authored-cache cases move; passes 0.8s (survivor: tools/structure-threshold-test.ts)
  - `tools/shadow-follow-test.mjs` — audit MERGE: follow box ranks from the camera's WORLD position (VR regression 09-10): same core-stub + lightrig harness as shadow-fade-test.mjs:21 (updateRig/registerCaster/setCasterBudget); ran 10-29: exit 0, 10… (survivor: tools/shadow-fade-test.mjs (gated))
  - `tools/shadow-pref-test.mjs` — audit MERGE: setShadows() + the lamp slot agree at boot and on flip: setShadows absent from gate; same happy-dom lightrig harness; ran 10-29: exit 0, 34 passed (survivor: tools/shadow-fade-test.mjs (gated))
  - `tools/structure-route-support-test.ts` — audit MERGE: support mode, terrain crossing height, world/local transforms on the same planStructure + WorldAgent-tick scaffold; passes 0.2s (survivor: tools/structure-threshold-test.ts)
  - `tools/vrmic-policy-test.mjs` — audit MERGE: ran 10-29: exit 0, 23 passed; the pure table of client/lib/vrmic_policy.js, which vrmic-exec-test already imports and executes through vrmic.js (survivor: tools/vrmic-exec-test.mjs (the 24-case table + the 'mutations that must go red' list move))
  - `tools/xr-entry-policy-test.mjs` — audit MERGE: ran 10-29: exit 0; the pure policy table + regex wiring checks that xr-entry-effects-test's header (:4-8) shows stayed green under the shipping mutation; effects already imports decideEntryFailure (survivor: tools/xr-entry-effects-test.mjs (the policy table rows move; the regex wiring checks are dropped))
- `8234f7766` tests: delete 15 ungated probes the gate-or-delete audit marked DELETE that nothing references (duplicates of gated rows or dead one-offs; GATE-OR-DELETE-2026-10-29 §1)
  - `tools/attention-probe.ts` — audit DELETE: browser (playwright :8) duplicate of tools/attention-test.ts: the gate rows (:14-36), the session/utt dedup across listener reconnect, sender rejoin and sessionless arrival (probe :157-195) are atten… (survivor: covered by tools/attention-test.ts (:14-57, :117-121))
  - `tools/framebudget-probe.mjs` — audit DELETE: real-client twin of framebudget-test.mjs; the headset share cap it checks is gated at governor-xr-test.ts:90-96 (FB.budgetStats().share under isPresenting) and the rules at framebudget-test.mjs; need… (survivor: tools/framebudget-test.mjs + governor-xr)
  - `tools/inspect-handler-test.ts` — audit DELETE: tests removed behaviour: it calls MESSAGES["inspect"] (inspect-handler-test.ts:19) and server/messages.ts has no such handler (ran 10-29: exit 1, "MESSAGES.inspect is not a function"); inspect is now… (survivor: agenttools (tools/protocol/agenttools-check.ts))
  - `tools/pose-release-probe.ts` — audit DELETE: a two-browser probe whose waits "come to about twenty minutes at most" (header lines 5-8), Chromium + fixture body; the relay it drives is gated: presence row (presence-check: puppet reaches the iden… (survivor: presence-check / gates-check / client-check)
  - `tools/posture-browser-parity-test.ts` — audit DELETE: ran 10-29: exit 1, "SyntaxError: JSON Parse error: Unexpected identifier 'not'" at GLTFLoader.parse — /library/.../claude.vrm answered "not found" through the scratch server; hard-codes avatars claud… (survivor: tools/poseclip-parity-test.ts)
  - `tools/replica-hierarchy-test.ts` — audit DELETE: covered by client-check.ts:846 B4b: foldParity's edgeDiffs compare the replica's childrenOf/ancestors index (replica.js:71-74) with the view after every mount, unparent and delete the run made; also… (survivor: client-check.ts (B4b))
  - `tools/rowcontrols-probe.ts` — audit DELETE: covered by client-check.ts: I1 ENABLED box leads the Inspector :449-451, H0-H3 lock column on Hierarchy rows :293-301, E2 the eye hides and writes NOTHING :645-650 (survivor: tools/protocol/client-check.ts)
  - `tools/served-path-test.ts` — audit DELETE: covered by libfile-check.ts: :17 sets the PATCH_DIR ladder, :30 'L1 a patched model wins over everything (as /library serves it)', :49 L9 shadowing (survivor: tools/protocol/libfile-check.ts)
  - `tools/shadow-fade-probe.mjs` — audit DELETE: browser receipt for the fade mask; shadow-fade-test.mjs (gated) pins FADE_MASK/shadowFade :2,:33,:44 and stepFades amounts; a WGSL/pipeline error on the real depth pass is a pageerror, which client-c… (survivor: tools/shadow-fade-test.mjs)
  - `tools/sky-bakelock-probe.mjs` — audit DELETE: the lock's interceptor-inside-the-lock and the torn-down-sky skip are the BAKE_AFTER/BAKE_GUARD/BAKE_HELD cases of sky-bakelock-test.mjs (→ sky-lifecycle-test), which drive serializeBakes headless; t… (survivor: tools/sky-lifecycle-test.mjs)
  - `tools/sky-xr-hold-probe.mjs` — audit DELETE: sky-lifecycle-test.mjs: 'held quality: nothing changes in the session, the latest choice is held' + '…and applies ONCE at exit (one rebuild, to off)' + 'capped + a sky-world switch in the headset: he… (survivor: tools/sky-lifecycle-test.mjs)
  - `tools/support-heightfield-probe.ts` — audit DELETE: a receipt over the asset corpus (line 12: 'recorded as the receipt'): summarizeGlb vs a BVH ground truth per model, needs assets + three-mesh-bvh; the classifier it certifies is supportclass-test's (… (survivor: tools/supportclass-test.ts)
  - `tools/tilt-probe.mjs` — audit DELETE: needs a hand-started server on fixed port 8998 (lines 7-8) + playwright-core; the orientation agreement it eyeballs is onepose-check (one worldPose, hierarchy = simlayer) + rot-test (gated) (survivor: tools/protocol/onepose-check.ts)
  - `tools/tts-blocking-probe.mjs` — audit DELETE: one-off diagnostic of R's 2026-08-16 hang: a rAF-gap meter against a STUB synth in Chromium (its header: 'the measurement is of OUR scheduling'); the pacer/handoff it probes is pinned deterministical…
  - `tools/typing-dots-probe.ts` — audit DELETE: duplication: its wire half (first frame <1 s, a frame every 4 s, speech ends the relay, another channel sends nothing, the walk) is tools/typing-mcpl.test.ts:120-235 without Chromium; the rest is a 2…
- `a08c5cead` test cut step 1: delete 16 dead probes and benches (1,529 lines)
  - `tools/audiopanel-css-probe.html`
  - `tools/blanket-probe.ts` — audit DELETE: an experiment, not a test: ":11-14 asks one question before any collision work is designed: does collide:'exact' already fix it?"; 0 check()/assert lines, prints only; the answer decided a design in…
  - `tools/chat-catchup-probe.ts` — audit DELETE: browser (probe-harness) for rows chat-scrollback-test.ts pins headless: the re-join window with a hole and its resync (:205-216), the 1,000-line cap (:22, :233-250 a 1200-line log), scroll-up brings… (survivor: covered by tools/chat-scrollback-test.ts (:119-125, :205-268))
  - `tools/forecast-probe.mjs` — audit DELETE: header says "Scratch use only (not part of the suite)" and needs a hand-started server (forecast-probe.mjs:4-7); forecast-test.ts:1-12 covers the same contract serverless (late joiner replay, overrid… (survivor: tools/forecast-test.ts)
  - `tools/frames-relayout-probe.mjs` — audit DELETE: its own header: "frames-layout-test binds the same contract under happy-dom" (frames-relayout-probe.mjs:8-9); frames-layout is gated (suites.ts frames-layout row). Chromium-only, no assertion exit (d… (survivor: frames-layout (tools/frames-layout-test.ts))
  - `tools/garden-look-probe.mjs` — audit DELETE: one-off: opens R's garden on a hand-run server (GARDEN_ORIGIN, garden-look-probe.mjs:3-4) and screenshots; 2 checks, slice-3c smoke. Not reproducible in a gate.
  - `tools/hollow-probe.ts`
  - `tools/lod-look-probe.mjs`
  - `tools/route-preparation-bench.ts`
  - `tools/shadow-toggle-probe.mjs` — audit MERGE: shadows off/on triggers no render-path builds; its witness IS syncgate's build counter on the same owned page; 32 lines (survivor: tools/syncgate-probe.mjs)
  - `tools/sky-flip-probe.mjs` — audit DELETE: line 10: exits 0 unless SKY_FLIP_GPU=1 (GPU only since 40ab88c); prints phase timings, 4 checks on shape; a bench nobody runs headless
  - `tools/structure-look-probe.ts` — audit DELETE: no assertion (check=0; prints the percept) against an external WORLD_URL world 'structdemo'; describeHere pinned by storey-walk-test.ts:1194 (survivor: mcpl/storey-walk-test.ts)
  - `tools/structure-route-probe.ts` — audit DELETE: external WORLD_URL/WORLD_TOKEN + a prepared 'structdemo' world (lines 3-4); the doorway crossing it samples is structure-threshold-test's wall-crossing oracle (lines 2-3), gated by this triage (survivor: tools/structure-threshold-test.ts)
  - `tools/tts-threading-bench.mjs`
  - `tools/vr-cloud-cap-probe.mjs` — audit GATE: headless Chromium (probe-harness, no IWER: drives the xr:state bus) over sky.js:151 VR CAP (clouds never 'high' in a WebGL headset) — in no gated file (grep clouds\ (survivor: VR CAP\|xr:state: only sky fixtures); browser marker, not run 10-29 | new row "xr-client" (one Chrome, serial, the client-check pattern) with the IWER probes)
- `e12a7874e` audio tests: transcriptions of product code become executed rows against the shipped modules
  - `tools/audio-report-test.mjs` — audit DELETE: tests a COPY: mkReport is re-implemented inline at :2-14 ("audio-report-test.mjs re-implements the report", audio-cmd-probe.mjs:3), never imports client code; 0 check() lines; a change to the shipped…
  - `tools/mic-resume-after-synth-test.mjs` — audit DELETE: imports nothing — its own header (lines 1-12): "THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST", an inline transcription; ran 10-29 exit 0 vacuously
  - `tools/self-tts-gain-test.mjs` — audit DELETE: line 1: 'THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST' — a transcription with asserts
  - `tools/synth-hook-broadcast-test.mjs` — audit DELETE: line 1: 'THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST'
  - `tools/tts-import-order-test.mjs` — audit DELETE: imports nothing: an inline re-typing of the file-then-folder ask (the shipped logic is client/lib/ttsrow.js); cannot go red when the module breaks; pairing refusal is executed in tools/tts-fault-test…
  - `tools/tts-mic-precedence-test.mjs` — audit DELETE: imports nothing: the headNote string is re-typed inline ('not available while your mic is on' lives at client/lib/ttsrow.js:579); mic-beats-TTS is executed in tools/tts-test.ts:203-213
  - `tools/tts-publishes-mic-off-test.mjs` — audit DELETE: its own header: 'THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST'; replaced by tools/voicesource-real-test.mjs (header line 2-4), which imports client/lib/voicesource.js and ran green 10-29
  - `tools/ttsrow-select-test.mjs` — audit DELETE: its own header: 'THIS FILE IMPORTS NOTHING. IT IS NOT A REGRESSION TEST' (inline copy of the radio select); no real module loaded
  - `tools/voicelist-empty-test.mjs` — audit DELETE: imports nothing: an inline copy of the list sync (the shipped one is client/lib/ttslist.js, grep vl-row); same class as ttsrow-select-test; cannot fail when the module breaks
  - `tools/voicelist-inplace-test.mjs` — audit DELETE: imports nothing: fake rows/marks over an inline sync (shipped: client/lib/ttslist.js); same class as ttsrow-select-test
- `0025c8705` tests: delete 10 one-off probes the audit marked DELETE; drop the comments that cited them as evidence (the claim stays, the dead pointer goes)
  - `tools/bodyscale-probe.mjs` — audit DELETE: two headless Chromiums (:3,:7 "run it under a lock and a memory guard") for rows bodyscale-test already pins headless: the wire (bodyscale-test.ts:46-68), receipt clamps and absence=default (:52-59),… (survivor: covered by tools/bodyscale-test.ts + tools/bodies-wear-test.mjs)
  - `tools/dome-order-probe.mjs` — audit DELETE: a one-off render-diff probe for the renderOrder −100 → 0.5 change: it builds its OWN stand-in scene of boxes/lines (:5-9, :25) in SwiftShader and diffs old vs new order; the shipped rule is one line…
  - `tools/gpulost-probe.mjs` — audit DELETE: Chromium twin: kills WebGL via WEBGL_lose_context; gpulost-gate-test.mjs header (#228 review round 2) says "a browser control that relies on a lost WebGL backend is not portable" and covers each gate… (survivor: tools/gpulost-test.mjs (+ merged gate-test))
  - `tools/lantern-probe.mjs` — audit DELETE: lantern-test.ts:2 names it as "the browser walk" of the same keys' contract and lantern-test.ts:139-157 covers the quiet/pinned pill too; Chromium (and a cloudy sky has frozen the host, lantern-probe… (survivor: tools/lantern-test.ts)
  - `tools/lod-gate-test.ts` — audit DELETE: runs the real optimize CLI + KTX2 encoder on a named STORE hash that "moves with the recipe" (lod-gate-test.ts:5-6: 1550fd3f… no longer qualifies, 0a80e1dc… does) — a host-fixture test that re-breaks… (survivor: tools/lod-budget-test.ts)
  - `tools/meadow-grank-probe.mjs` — audit DELETE: one-off A/B of ?grassgrank=0 vs default, byte-diffing CPU renders in headless Chromium ("has frozen the host", line 9); pins the Commons count 1729 (line 79: overly specific); the only other referenc…
  - `tools/plateanchor-shot-probe.mjs` — audit DELETE: a by-eye shots probe (--shots <dir>, header lines 1-18) in Chromium on named real avatars (--avatars claude,tigerbee: avatar corpus); its measured numbers are already pinned headless in plateanchor-t… (survivor: plateanchor-test.ts / firstperson-plate-test.ts)
  - `tools/puddle-gate-probe.mjs` — audit DELETE: a one-off refactor receipt (header: old graph vs gated graph byte-identical for the 09-24 materials change), Chromium CPU render; the ?pudgate=0 A/B branch exists only for it (client/lib/materials.js… (survivor: none (remove materials.js pudgate branch with it))
  - `tools/sky-cap-ui-probe.mjs` — audit DELETE: headset cap: sky-lifecycle-test.mjs checks 'the cap takes the PENDING choice: capped high → medium, the choice still reads high' and 'exit restores the choice: high'; the greyed select is a skypanel… (survivor: tools/sky-lifecycle-test.mjs)
  - `tools/sky-refresh-probe.mjs` — audit DELETE: line 9: exits 0 unless SKY_REFRESH_GPU=1; line 6: 'It has NOT yet completed a run'; the headset hold-until-exit it wanted is sky-lifecycle-test's 'held quality… applies ONCE at exit' (survivor: tools/sky-lifecycle-test.mjs)
- `4e3b6e3e6` tests: delete 8 more audit-DELETE files whose coverage lives in a gated row (skypanel-state, sky-lifecycle, xrpixelratio, batch2 P1-P3, micstate-single-transport) or that were one-off receipts; repoint the comments that cited them
  - `tools/audio-cmd-probe.mjs` — audit DELETE: a one-off probe against a RUNNING world on :8960 (:11 ORIGIN default, JOIN_KEY env), no owned server, prints the /audio line, no check() at all (0 assertions; "fail" hit is only the word in a comment…
  - `tools/fp-snap-probe.ts` — audit DELETE: a one-off A/B receipt for #75 (header: "Run it on this branch and on a throwaway main worktree"), spawns a sequencer and diffs pixels with sharp; fp-view-test.ts pins the contract (fp-snap-probe.ts:1… (survivor: tools/fp-view-test.ts)
  - `tools/library-status-probe.mjs` — audit DELETE: asserts only the SHAPE of /library-models opt.{min,ktx2,lod} on whatever the host's store holds ("real counts … are printed, not asserted", library-status-probe.mjs:3); the route is already read by a… (survivor: tools/library-badge-probe.mjs)
  - `tools/micstate-mesh-fallback-test.mjs` — audit DELETE: tombstone (header lines 5-8: the mesh/voice.js is deleted); its five surviving checks (lines 48-64: no transport → honest hint; __sfuMic called/returned/toggled) are the same checks as micstate-singl…
  - `tools/picture-test.ts` — audit DELETE: declaration leg covered by batch2-check.ts:250-269 P1 (quad mode, defaults, part ignored), P2 (src refusals: http, dot segment, IP, localhost), P3 (description bounds), P4, and P5 (:269 "the authorit… (survivor: batch2 (batch2-check.ts P1-P5))
  - `tools/sky-state-probe.mjs` — audit DELETE: skypanel-state-test.ts:5 (gated): 'What tools/sky-state-probe.mjs checks in a browser, minus the browser' (survivor: tools/skypanel-state-test.ts)
  - `tools/sky-xr-livehold-probe.mjs` — audit DELETE: sky-lifecycle-test.mjs: '…and the live march is never on screen in the headset (no frame: presenting + live dome + no baked dome)' and the failed-bake 'puts the live clouds back' cases; the probe use… (survivor: tools/sky-lifecycle-test.mjs)
  - `tools/xr-eye-viewport-probe.mjs` — audit DELETE: covered: the guard it ends on is tools/xrpixelratio-test.mjs:29-42 (deferred while presenting) and the gated governor-xr row (suites.ts:79, 'in a headset the frame governor never moves the pixel rati…
- `2c69ca486` tests: delete #132's one-off cutover receipt script and the six it ran (tautological models, source-greps, a re-typed copy, stale regexes: GATE-OR-DELETE §1), and lite-weight-test (lite-graph-test gates the claim statically)
  - `tools/audio-unlock-test.mjs` — audit DELETE: tests a COPY: ":13 // inline the module's logic (it imports chat.js, which needs a DOM)" — the pending/armed listener logic is re-typed in the test, no import of client/lib/audiounlock.js; a change t…
  - `tools/cutover-receipts.sh`
  - `tools/lite-weight-test.mjs` — audit DELETE: its one claim ("a lite boot never REQUESTS the engine") is gated statically by lite-graph-test.ts:5-7 ("lite.js … never downloads the renderer"; walks the import graph from client/lite.js to core.js)… (survivor: lite-graph (tools/lite-graph-test.ts))
  - `tools/mic-gate-wired-test.mjs` — audit DELETE: source grep only: regexes over readFileSync of voicesfu.js/micstate.js (lines 13-45), nothing executed; the same claim (the SFU gates through gateFor/gateStream) is EXECUTED by mic-ptt-test.mjs and m…
  - `tools/sfu-loss-test.mjs` — audit DELETE: line 13-15: 'does NOT route packets through the SFU. It models a lossy link arithmetically' — tautological by its own header
  - `tools/sfu-no-duplicate-playback-test.mjs` — audit DELETE: line 13-14: 'models that logic against the real shape rather than importing the module' — a source-regex of voicesfu.js attach(), not an execution
  - `tools/sfu-ops-test.mjs` — audit DELETE: source regexes over server.ts/sfuadapter.ts; ran 10-29: exit 1, 4 stale regexes (ROLE_RANK[rights.role] < 2, rung: 'authorized-claim', incarnation); the executed versions live in sfu-adapter-test (se… (survivor: tools/sfu-adapter-test.ts)
  - `tools/transport-check.mjs` — audit DELETE: browser probe (probe-harness ownedWorld); its two claims: legacy ?mesh=1/?relay=1/?sfu=1 are inert = obsolete v1-era wire (post-cutover ONE transport, its own header), and 'a voice-off world boots' i…
- `d23238ed0` bench: retire flightbench and flight-capture
  - `tools/flight-capture.mjs`
  - `tools/flightbench/.gitignore`
  - `tools/flightbench/bench.html`
  - `tools/flightbench/fly.html`
  - `tools/flightbench/out/telemetry-A.json`
  - `tools/flightbench/out/telemetry-B.json`
  - `tools/flightbench/scripts/flightplan.js`
  - `tools/flightbench/serve.mjs`
- `04c8f3a6a` tests: delete 8 ungated files whose behaviour a gated row owns (GATE-OR-DELETE §1)
  - `tools/live-contact-test.ts` — audit DELETE: tests a removed reading shape: ran 10-29, exit 1, "a.reachReading.reachEvaluation.leftHand.target" undefined (live-contact-test.ts:52) — body-state.ts:383 now puts reachEvaluation at the top of the r… (survivor: door-body (mcpl/door-body-test.ts))
  - `tools/native-interactions-fixture.ts`
  - `tools/ragdoll-shots-agent.ts`
  - `tools/ragdoll-shots-probe.mjs` — audit DELETE: browser e2e probe (node+Playwright, 3 pages, --shots screenshots), run by nothing (grep package.json docs/*.md tools/protocol/*.ts: no hit); the #282/#283 invariant it looks at is pinned headless by… (survivor: avatar-test.ts + remotes-limp-edge-test.ts)
  - `tools/render-scene-wire-test.ts` — audit DELETE: tests the render-scene socket message and snapshot.renderSceneVersion (test :26,:36-44); gone: server/server.ts:809 "no renderSceneVersion: upstream #248's render-scene projection isn't served here",… (survivor: renderSceneVersion over server/ shared/ client/ hits only that comment; the linkable module is gated by render-scene-import-test (suites.ts render-scene-import row); 10-27 fail 6.3s | render-scene-import-test.ts)
  - `tools/walk-precision-test.ts` — audit DELETE: covered: arrival tolerance and its bounds are mover-check.ts:96-101 (M4 toleranceOf 0.01/0.4/0.41->null/-1), and tolerance through the real tool is agenttools-check.ts:322 (walk_to tolerance 0.2); no…
  - `tools/water/controller-check.ts` — audit DELETE: fail(1) 0.4s = the same ambient 127.0.0.1:19347 'water-preview' server; its vehicle claim/state/release :51-53 is the gated drive row (drive-check, suites.ts:36) and swimming is zone-water-check.ts:2…
  - `tools/water/regression-check.ts` — audit DELETE: fail(1) 0.3s = ambient 127.0.0.1:19347 'water-fixes' server + 'needs the scene imported (import.ts --apply, refused while the vehicle is deferred)' (:2-3); the #248 import is the gated water-import r…
- `5a8e14f47` test trim: delete dead tests, rows that can't fail, and an API with no caller (#333 trim H2 H4 H8-H15)
  - `shared/blueprint.js`
  - `tools/channel-cap-gate-test.mjs` — audit MERGE: ran 10-29: exit 0; capabilityMatches matrix (:51-72, pure, mcpl/declaration.ts) + advertisement rows (:129-132) + source-slice rows (:100-156, "consults toolsAllowed()") — grep capabilityMatches\ (survivor: channelsPublish\|toolsAllowed\|FEATURE_SETS in gate: 0 hits; door-cap-gate-live-test.mjs:3-5 exists because "source slices pin spelling, not behavior" | survivor tools/door-cap-gate-live-test.mjs — move the pure matrix + advertisement rows; drop the source-slice rows it supersedes)
  - `tools/screenshots-wire-test.ts` — audit MERGE: real HTTP+WS capture/capture-result but on FIXED ports 18998/18994 (the hygiene class); ran 10-29: exit 0; its unique checks (busy renderer waited for, Retry-After, ?budget=, opt-out, legacy browser,… (survivor: tools/snapframe-test.ts)
  - `tools/voice-wiring-test.ts` — audit MERGE: pass 0.0s; a source-level 'every emit has a listener / entry imports what it calls' over main.js, voicemouths.js, micstate.js, voiceconsent.js, mictoggle.js (:24-40: 12 assertions already removed at… (survivor: tools/boot-init-test.ts (the emit/listener and bound-before-called pairs move))
- `7a51f36ae` tests: denoise waits on its conditions and runs in the gate; the four approach tests merge into it and door-unit
  - `tools/approach-dwell-test.ts` — audit MERGE: approach = stopped within reach, depart = the bracket closing (mcpl/denoise.ts:74 APPROACH_DWELL_MS) on a bare WorldAgent, same harness as denoise-test (:22-23 imports); pass 0.4s (survivor: mcpl/denoise-test.ts — move the 25 checks as its approach section)
  - `tools/approach-env-clamp-test.ts` — audit MERGE: the env knobs cannot reintroduce the pass-through defect (APPROACH_SAFE_WAIT_MS mcpl/denoise.ts:107), spawned-child env matrix :28-41; pass 1.0s; same module as denoise-test (survivor: mcpl/denoise-test.ts — move the clamp rows (keep the spawned-child discriminator))
  - `tools/approach-seed-test.ts` — audit MERGE: first observation is a baseline, not a transition (#39) on a bare WorldAgent (:13-14 same imports as denoise-test); pass 0.3s (survivor: mcpl/denoise-test.ts — move the 10 seed rows)
  - `tools/approach-wire-test.ts` — audit MERGE: pingLine/pingDelivery tags for approach/depart (:37-82) + disconnect = one presence exit (:101-106); mcpl/door-unit-test.ts:129-139 already pins the declares/from-agent/addressed tags on pingDelivery… (survivor: mcpl/denoise-test.ts (disconnect rule) and mcpl/door-unit-test.ts:129 (the remaining pingDelivery/pingLine rows))
- `1eb545377` body-state-test: one field table (bones, yaw, clip, scale, named pose) x both senders absorbs body-state-scale-test
  - `tools/body-state-mutation-preload.ts`
  - `tools/body-state-scale-mutation-test.ts` — audit MERGE: ran 10-29: exit 1 "baseline body-state-scale-test.ts is not green" (:49) — a mutation runner over body-state-scale-test + effective-test (:7-13) (survivor: tools/body-state-test.ts `--mutants` (its cases join body-state-mutation's list))
  - `tools/body-state-scale-test.ts` — audit MERGE: new → ran 10-29: exit 1, 5 ✗ all the "2 cm (absolute) standoff" rows (:109,:133-135): shared/reachwire.js:46 TOUCH_GAP = 0.05 (commit c39b2f5f9) — a stale expectation, needs the fix; the scale→geomet… (survivor: tools/body-state-test.ts (same scratchSequencer + WorldAgent + handleTool harness :21-25) after fixing the standoff rows to TOUCH_GAP)
- `befa6ecbc` test trim: merge twin suites, keeping every row that was the only cover (#333 trim H5 H6 M2 M5)
  - `tools/flight-headless-test.ts` — audit MERGE: the mcpl stand-in's wing/hair graft (mcpl/physics.ts:470-493) read from the real mythos-wings.vrm; fail(1) = ENOENT assets/opt/eidoverse/assets/vrms/mythos-wings.vrm (ran 10-29, flight-headless-test.… (survivor: tools/flight-test.ts (move the graft legs in under a corpus-present guard; then flight-test's new row))
  - `tools/lying-support-test.ts`
  - `tools/xr-frame-clock-test.mjs` — audit MERGE: ran 10-29: exit 0, 30/30; xr-session-lifecycle-test's header (:3-6) records that this file passed 29/29 under if (false && shouldShim(...)) because it drives the pure pieces then source-checks wiring… (survivor: tools/xr-session-lifecycle-test.mjs (the shim unit rows move; the regex rows drop))
- `b97b65260` tests: merge three small duplicates into the gated suite that owns their behaviour
  - `tools/posecheck-test.ts` — audit MERGE: same fence (server/posecheck.ts sanePose) as pose-handler-test.ts, driven on the function instead of the handler; move its input table (lines 4-24: xr quats, short grip, deep pose/pins/reach NaN, nul… (survivor: tools/pose-handler-test.ts)
  - `tools/sky-bands-test.mjs` — audit MERGE: sky_bands.js bandCuts (texel rows, cover [0,1], equal cost): pure 21-line table; ran 10-29: exit 0, 28 passed (survivor: tools/sky-lifecycle-test.mjs)
  - `tools/terrain-layers-test.mjs` — audit MERGE: materialLayerSpecs legacy-shape table (6 asserts, 16 lines): absent from gate; ran 10-29: exit 0 (survivor: tools/terrainshape-test.ts)
- `fe14b4576` DL-16: delete client/ and mcpl/ package-lock.json; bun.lock is the one lock
  - `client/package-lock.json`
  - `mcpl/package-lock.json`
- `e6f797ba4` served-routes-test: one table of served routes, each isolated, absorbs isolation-headers-test and deps-route-test
  - `tools/deps-route-test.ts` — audit GATE: new → ran 10-29: exit 0 (2 s); the TTS runtime's served routes actually fetched from a spawned server proven by nonce, the pinned piper chunk, an honest 404 (:69-123) — modhole-check.ts:40-41 reads e… (survivor: deps-route\|/vendor/ in gate: no fetch; owns its server | fold into tools/version-route-test.ts (row version-route: a real server, scratch port, nonces))
  - `tools/isolation-headers-test.mjs` — audit GATE: COOP/COEP credentialless on every response + ws upgrade (server/routes.ts:1435): no gate hit (grep "embedder-policy\ (survivor: opener-policy\|crossOriginIsolated" over gated suites = none). ran 10-29: exit 0, 11 passed. Spawns its own server child (nonce-proved). | fold into csp (tools/csp-test.ts: the page's security headers))
- `663999bf0` host-class-test, ice-stall-report-test: deleted; neither imports product code, and neither exits non-zero on FAIL
  - `tools/host-class-test.mjs` — audit DELETE: exercises a toy mkEl() model it defines itself (host-class-test.mjs:3-9), imports no product code; prints PASS, never exits 1. A note, not a test.
  - `tools/ice-stall-report-test.mjs` — audit DELETE: simulates a pc object it defines itself (ice-stall-report-test.mjs:3-8), imports no product code (the real reporter is client/lib/voicesfu.js:194-201); prints PASS, never exits 1.
- `5692685e2` tools: the last senders of the old verb message speak requests (harness requester: {type: request, id, verb, args} with idalias placeholders) — lite-banner, snap-at, uneven-support, roaming-renderer; delete the render-scene wire fixtures (nothing serves render-scene here); NATIVE-WORLD-RENDERING says so and drops the lease/epoch contract; captions/pose-provenance drop their v1 changelog comments (SWEEP-13 C5 C6 C7 C8 C10 C12 C13 C15 C19 G1 G5)
  - `tools/native-environment-control.ts`
  - `tools/render-scene-control.ts`
- `a15ffd54e` navgrid-rows-test: built-box routes and scaled places as two tables, absorbing navgrid-edge and places-scale
  - `tools/navgrid-edge-test.ts`
  - `tools/places-scale-test.ts`
- `59d8ae44a` net-send-shape-test: one table over every net.js sender that names a person, and say's offline/spoken rows
  - `tools/presence-actor-test.ts`
  - `tools/say-live-test.ts`
- `76d196f6b` tests: delete water/math-test (its expectations live in gated zone-water-check ZM) and water/browser-check (only its README ran it); drop a hygiene-check.ts.tmp committed by an assembly merge
  - `tools/water/browser-check.ts` — audit DELETE: an ambient server at 127.0.0.1:19347 with a 'water-preview' world not in the repo (WATER_PREVIEW_URL default :8), chromium channel chrome with --use-angle=metal (macOS); 'new' and never owned; the ow…
  - `tools/water/math-test.ts` — audit DELETE: covered: zone-water-check.ts:251 re-runs 'tools/water/math-test.ts's expectations, on bodies and pockets built through zone.js' (mediumAt/waterPath/swimStep, :234-276) and the water-vectors row (suit…
- `60ea1def7` named-pose-test: one test over every registered pose name replaces the two wing-only presence tests
  - `tools/wing-fold-presence-test.ts`
  - `tools/wing-owner-wire-test.ts` — audit GATE: ran 10-29: exit 0, 6 passed (happy-dom; the owner's G key into the real net.sendPose packet: poses:['wings-folded'], explicit unfold, wingless release); the gated wing-fold-presence row (suites.ts:17… (survivor: fold into tools/wing-fold-presence-test.ts (wing-fold-presence row; package.json already pairs them))
- `db893179b` xr-desktop-banner-probe: the desktop banner as one transition table (killed > 'In VR' > none, across pref changes and exit); absorbs xr-invr-label and xr-mirror-banner
  - `tools/xr-invr-label-probe.mjs` — audit GATE: 'In VR' desktop label when the mirror is off (owner 09-27), follows the pref, gone at exit; real client + IWER; grep xrmirror\ (survivor: IWER in SUITES files: 0; browser marker, not run; needs Chromium + IWER | row "xr-client")
  - `tools/xr-mirror-banner-probe.mjs` — audit MERGE: same module (client/lib/xrmirror.js) and the same killswitch trip as xr-mirror-probe.mjs:105 ('30 slow frames switch the mirror off'); only the banner text/position/exit rows :38-41 are its own (survivor: tools/xr-mirror-probe.mjs (the banner rows move))
- `72e4bbdde` NC-22: delete the client/lib/flora_args.js shim; its three importers take shared/flora_args.js
  - `client/lib/flora_args.js`
- `9a52bc032` NC-28: fold hud.js into statuschips.js: paintHud(status) paints the ∃ mark beside the status strip
  - `client/lib/hud.js`
- `b76c6a3d9` voices: the engine ships no voice; client/voices/ is a drop folder, ignored whole
  - `client/voices/hesperus-clockwork.onnx.json`
- `0bcfdfdf0` DL-11: delete mcpl/playtest.ts, an unrunnable lab in a production dir
  - `mcpl/playtest.ts`
- `c0557aebd` SS-6, SS-39 (shape.ts): one finite-vec3 guard, isFiniteVec3 in shared/protocol/is.js
  - `mcpl/shape.ts`
- `963e6510e` wiring-check: the source-grep wiring rows as one table, each row with its controls; absorbs conjure-coop-contract-test
  - `tools/conjure-coop-contract-test.mjs` — audit GATE: ran 10-29: exit 0; source-slice rows with corrupting controls on client/lib/generate.js (:24-49): every conjure <img> carries crossorigin="use-credentials" (generate.js:242), the login poll's one tea… (survivor: use-credentials in gate: 0 hits | fold into tools/originof-test.ts (row originof: generate.js's guards))
- `04a8d7b60` bench: drop flightbench's committed receipt; ignore bench outputs
  - `tools/flightbench/out/receipt.json`
- `acddb74b3` SWB-8: delete bench/lightbench.ts, which can't run on this protocol
  - `tools/lightbench.ts`
- `d1f33d4ab` tests: gate bodygate; loadgate-boundary folded into it (the test was stale, not assets.js)
  - `tools/loadgate-boundary-test.mjs` — audit MERGE: the body-first gate at loadGLB's boundary (client/lib/assets.js:587-589 still has the phase); header says bodygate-test.mjs covers the contract in isolation and this drives the boundary. ran 10-29: e… (survivor: tools/bodygate-test.mjs (other chunk; one bodygate file, then gate it))
- `1381ca92e` descriptor-defaults-test: every option the Inspector offers goes through its planner and the door; absorbs lookat-forward-check
  - `tools/lookat-forward-check.ts`
- `6fb9c11ad` tests: delete panel-identity-test.mjs, a model of sync-in-place checked against itself (imports no product code)
  - `tools/panel-identity-test.mjs` — audit DELETE: tautology: no imports at all (grep ^import: none); it defines its own mkHost/syncInPlace (:4-25) and checks that code, never client/lib/audiopanel.js; the real claim (the audio panel updates in place…
- `1f41c6cae` test trim: gate what is green with no blocker left; name and fold the three invisible files (#333 trim H3 H18)
  - `tools/permtest.ts`
- `5f88b96e5` drop the rapier devDependency with its only user, test/labs/rapier-spike.ts
  - `tools/rapier-spike.ts`
- `0579d4bfe` tests: delete readhistory-test: its file-leg/memory-leg contract is gone; paging is server-check SH1
  - `tools/readhistory-test.ts` — audit GATE: readHistory's after fast path (memory holds the tail so the file is not read; the backward scan stops at after) — foldparity-check.ts:85 pages only by before; authority-check.ts:1017 and server-check… (survivor: fold into foldparity-check.ts)
- `538faed2d` test trim: pure rows out of browser runs (#333 trim H17)
  - `tools/shadow-res-probe.mjs` — audit MERGE: ew-shadow-res governs every caster (sun n, lamp 2048→256) + the stored-4096 module-init path: absent from gate; a 29-line browser probe whose claim is a localStorage read in lightrig.js — set it unde… (survivor: tools/shadow-pref-test.mjs → tools/shadow-fade-test.mjs)
- `cf40f6141` sidetone-gain-live-test: deleted, it imports no product code (it tests an inline copy of the arithmetic)
  - `tools/sidetone-gain-live-test.mjs` — audit DELETE: imports nothing: a 19-line inline model of a gain node (no module loaded)
- `14a38e288` sky-bakelock-test: hook × situation table (queued, its bake throws, its sky torn down, its guard says no): INTERCEPT, GUARD and AFTER run at their own turn, once; INTERCEPT's restore once whenever it ran
  - `tools/sky-busy-probe.mjs` — audit DELETE: the panel's 'you: loading…' line: skypanel-state-test.ts:5 'What tools/sky-state-probe.mjs checks in a browser, minus the browser' covers the state lines; the busy signal itself is sky-lifecycle-test… (survivor: tools/skypanel-state-test.ts)
- `be40e148c` snapshots-wire-test: every snap outcome's status and [snap] line, absorbing snap-timeout-test
  - `tools/snap-timeout-test.ts` — audit MERGE: SNAP_TIMEOUT_SEC + [snap] drop logs (#222): SNAP_TIMEOUT_SEC absent from gate; same scratch sequencer + fake renderer leg scaffold as snapframe-test; ran 10-29: exit 0, 23 passed (survivor: tools/snapframe-test.ts)
- `9d7dbd83e` sound-editor-test: sound-clock and sound-guard share one fixture over the real sounds.js
  - `tools/sound-guard-test.ts`
- `abeb200ad` structure-field §22: one diagonal loop over axis × opening × tile × cell absorbs structure-diagonal-parity.test.ts
  - `tools/structure-diagonal-parity.test.ts` — audit MERGE: diagonal walls (axes 2/3) share authored cell, geometry and collider: segmentEnds absent from gate; pure planner; ran 10-29: exit 0, 8 tests; a bun:test file (needs the .test. name or bun test ./path… (survivor: tools/structure-field-test.ts)
- `76585d668` tools: delete voice-matrix.mjs, a harness for the deleted /lib/voice.js mesh that cannot run against this tree
  - `tools/voice-matrix.mjs`
- `fc5627be8` entry points: bun run setup / start / test; drop gate-duplicate scripts, npm boilerplate and the ungated flight typecheck; gate shadow-fade's --mutants arm (only test:shadows ever ran it)
  - `tsconfig.flight.json`

### 115 true additions, by the commit that made them

- `0884de34b` comments (client c: edittabs..materials): essays cut to one line + pointer
  - `docs/research/light-rig.md`
  - `docs/research/material-factory.md`
  - `docs/research/meadow-grass-rendering.md`
  - `docs/research/piper-voice-engine.md`
- `15d120ed0` gate: run.ts --shard I/N (1-based) and merge-receipts.ts, for CI's sharded gate
  - `test/gate/merge-receipts.ts`
  - `test/gate/shard.ts`
  - `test/gate/suite-times.json`
  - `test/protocol/shard-check.ts`
- `f14be971d` READMEs for client/, test/, mcpl/: entry, what to read first, the one trap
  - `client/README.md`
  - `mcpl/README.md`
  - `test/README.md`
- `37c6053a5` G19 ammodoll: the tuning tables, the wasm loader and the interior triangles leave for three files (pure moves)
  - `client/lib/ragdoll/ammo-load.js`
  - `client/lib/ragdoll/ammodoll-interior.js`
  - `client/lib/ragdoll/ammodoll-tuning.js`
- `d4739c141` G22 ui.js: the rail, the ∃ menu and the front door lift into ui-dock.js, ui-menu.js and ui-door.js
  - `client/lib/ui/ui-dock.js`
  - `client/lib/ui/ui-door.js`
  - `client/lib/ui/ui-menu.js`
- `c9a7b752d` deploy: unit templates for eidoverse and eidoverse-mcpl; how to run the door
  - `deploy/eidoverse-mcpl.service.template`
  - `deploy/eidoverse.service.template`
  - `docs/operator/RUNNING-A-SERVER.md`
- `2935d0324` comments (client a: accesspanel..base, avatar): essays cut to one line + pointer
  - `docs/research/actionbar-placement.md`
  - `docs/research/ammodoll-tuning.md`
  - `docs/research/avatar-design-notes.md`
- `22d9f1765` comments (server b: screenshots..worldlog): essays cut to one line + pointer
  - `docs/research/seat-store-integrity.md`
  - `docs/research/sfu-p2p-offload.md`
  - `docs/research/store-variants-design.md`
- `a3e3dc025` docs: a map (docs/README.md), CONTRIBUTING.md, and the dead doc pointers fixed (org C0)
  - `CONTRIBUTING.md`
  - `docs/README.md`
- `064d426ba` G24b xr: the finger curl and the device scale lift into xr/xr-fingercurl.js and xr/xr-scale.js
  - `client/lib/xr/xr-fingercurl.js`
  - `client/lib/xr/xr-scale.js`
- `47a3e84bd` comments (shared a: a11y..particle_effects): essays cut to one line + pointer
  - `docs/research/clock-offset.md`
  - `docs/research/ktx2-key-generations.md`
- `ea2302d73` comments (mcpl: agent, body-state, declaration, denoise): essays cut to one line + pointer
  - `docs/research/deck-fill-threshold.md`
  - `docs/research/headless-storeys.md`
- `bba05c084` comments (shared c: protocol/newscript..zone): essays cut to one line + pointer
  - `docs/research/griddled-structures.md`
  - `docs/research/two-bone-reach.md`
- `127858fd4` comments (server, scripting): essays cut to one line + pointer
  - `docs/research/library-serving.md`
  - `docs/research/optimize-design-notes.md`
- `77a193d67` comments (client f: stylepanel..voicesfu): essays cut to one line + pointer
  - `docs/research/sfu-client-negotiation.md`
  - `docs/research/tts-mouth.md`
- `10ece29f9` comments (client e: reachbone..stt, realize/): essays cut to one line + pointer
  - `docs/research/sky-quality-and-vr.md`
  - `docs/research/stt-browser-recognition.md`
- `9280f90dd` mutant arms: one runMutants helper, 26 dead anchors retargeted, a static anchor check (#333 H1)
  - `test/gate/mutant-anchors-check.ts`
  - `test/gate/mutants.ts`
- `ed9f5df61` structure routing: one route table over the planner, one oracle and one tick driver for the agent suites
  - `test/shared/structure-oracle.ts`
  - `test/shared/structure-route-test.ts`
- `538faed2d` test trim: pure rows out of browser runs (#333 trim H17)
  - `test/water/wp5-verdict-test.ts`
  - `test/water/wp5-verdict.ts`
- `d874a280f` G14 avatar/avatar-thumbnail.js: the roster portrait and perf stamp leave avatar.js (pure move)
  - `client/lib/avatar/avatar-thumbnail.js`
- `d14920ff9` G18b lift avatar/face.js: gaze, blink, eyeballs, lids and mouth leave avatar.js as a piece the avatar owns
  - `client/lib/avatar/face.js`
- `0ea75e779` G16 lift avatar/nameplate.js: the name pill, speech bubble and typing pill leave avatar.js as a piece the avatar owns
  - `client/lib/avatar/nameplate.js`
- `e0286f058` G18a lift avatar/wings.js: the flap and the fold leave avatar.js as a piece the avatar owns
  - `client/lib/avatar/wings.js`
- `edd388769` G20 ammodoll: the hair and wing chains lift into ragdoll/ammodoll-dressing.js, called at the same two points
  - `client/lib/ragdoll/ammodoll-dressing.js`
- `b12c3f6b2` /version asked once per page (version.js): assets, chat and main read the one no-store answer
  - `client/lib/version.js`
- `1b4b6a4e6` G24a xr/xr-prefs.js: the headset preferences leave xr.js (pure move)
  - `client/lib/xr/xr-prefs.js`
- `219e4b908` DL-4, DL-5b, DL-6: ammo.js's upstream commit and zlib LICENSE, SeedThree's MIT licence; ragdoll-physics' licence not yet recorded
  - `client/vendor/ammo/LICENSE-ammo-zlib.txt`
- `d47ffd3cb` docs: DESIGN holds only what's built; the unbuilt ideas move to docs/design/ROADMAP.md, each with its state
  - `docs/design/ROADMAP.md`
- `6409d607b` docs: DESIGN's "Why eidoverse" and "First prototype scope (2026-07)" move verbatim to docs/history/ORIGIN.md
  - `docs/history/ORIGIN.md`
- `4a64c304a` docs: AGENTS's walker contract moves verbatim to docs/reference/WALKER.md
  - `docs/reference/WALKER.md`
- `6d9657984` comments (client b: bodies..editpanels): essays cut to one line + pointer
  - `docs/research/collider-heuristics.md`
- `c0da8f9f6` bake-seat-clip: OUT is patched/, where the clip is committed; --check had always read an absent upstream-patched/ file
  - `docs/research/seat-clip-delta.md`
- `93682ac83` comments (client g: voicesfubridge..main): essays cut to one line + pointer
  - `docs/research/shadow-depth-prewarm.md`
- `4ea962d6c` comments (client d: matoverride..ragdoll): essays cut to one line + pointer
  - `docs/research/verlet-ragdoll.md`
- `09ca9959e` G9 lift: mcpl/agent-flight.ts, flight (the integrator flown at the tick, its courses and waits, every way down)
  - `mcpl/agent-flight.ts`
- `e763df8bf` G5 lift: mcpl/agent-ground.ts, the ground (terrain, floors, placed things' supports, the mesh cache)
  - `mcpl/agent-ground.ts`
- `78dd1ce0a` G3 lift: mcpl/agent-places.ts, named places (the places piece of WorldAgent)
  - `mcpl/agent-places.ts`
- `19e06a0b9` G7 lift: mcpl/agent-reach.ts, reaching (hands and feet reaching, and its consent)
  - `mcpl/agent-reach.ts`
- `5928b5a36` G1 move: mcpl/agent-result.ts, the small vocabulary every piece of the agent shares
  - `mcpl/agent-result.ts`
- `a74f95383` G11 lift: mcpl/agent-senses.ts, the senses (what the body notices, and look's account of the world)
  - `mcpl/agent-senses.ts`
- `86b62bcee` SS-11: HN_ISSUER_KEY/HN_ISS/HN_AUD read once, in server/aid1-issuer.ts
  - `server/aid1-issuer.ts`
- `19da765cf` production imports nothing from test/: server/three.mjs (the client's three, by path, no renderer) answers geometry's BVH and the build check's core.js; filehost.ts and clock.ts, the suites' host, move to test/harness/ (hostclock.ts); hygiene rule prod-imports-test, zero, red-first on geometry/buildcheck-run/filehost (review 11-08)
  - `server/three.mjs`
- `470fcfe93` SS-34: the read verbs move out of authority/blueprints.js into authority/reads.js
  - `shared/protocol/authority/reads.js`
- `913ae3883` duplication: isE and opsQuiet live once in fold.js beside Malformed and opsOf (storage, statecache, foldviews, lazylog, livehost, credits read them); idOut once in view.js (replica, worldlog, editwrites); isNum/isStr/isObj once in shared/protocol/is.js for twenty shared files (bag and num were the same tests under other names); scriptaudit's different predicate is isKinded, sockets' PURGED-aware one liveObj (SWEEP-13 E1 E2 E3 E5 D1)
  - `shared/protocol/is.js`
- `6b21bfb54` dock-moved, lantern and keyhint ride the bus instead of window CustomEvents
  - `test/client/bus-events-test.ts`
- `fa49ef4a6` fix(333-cm): a9 the edit quad's padlock respects r.lockable
  - `test/client/editquad-test.ts`
- `8bb6a3a83` fix(333-cm): a6 grow never sends a delete; a7 the palette guard covers the grass dials
  - `test/client/groundpanel-test.ts`
- `43936433d` sensitivity meter: bar and latch on the gate's own dB threshold (bot #333 130)
  - `test/client/mic-meter-gate-test.mjs`
- `ff2b1d49d` tests (round 3, lane A): 16 duplicate tests merged into their survivors, waits on conditions (sfu, keepalive, tts, spoken-say, chatbridge), micstate one suite; every touched test run alone green, references repointed, ungated 109→96
  - `test/client/micstate-test.mjs`
- `60ea1def7` named-pose-test: one test over every registered pose name replaces the two wing-only presence tests
  - `test/client/named-pose-test.ts`
- `a15ffd54e` navgrid-rows-test: built-box routes and scaled places as two tables, absorbing navgrid-edge and places-scale
  - `test/client/navgrid-rows-test.ts`
- `59d8ae44a` net-send-shape-test: one table over every net.js sender that names a person, and say's offline/spoken rows
  - `test/client/net-send-shape-test.ts`
- `ba1c268d6` one-binding-test: one table over every "no copy outside its owner" source grep, as a gate suite
  - `test/client/one-binding-test.ts`
- `0bac54dfa` fix(333-cm): a1 door batch spelt {requests}; a2 newcomer warning reads dr.can.generate
  - `test/client/rolespanels-access-test.ts`
- `a3838b297` sky, roles, world panel: a server stamp is read on serverNow(), not this machine's Date.now()
  - `test/client/server-clock-readers-test.ts`
- `5e7151afa` fix(333-cm): b2 sky degrade level 1 turns the light cache off
  - `test/client/sky-degrade-test.mjs`
- `f5e5de9f7` captions obey push-to-talk: STT posts and listens only while V is held (bot #333 131)
  - `test/client/stt-ptt-test.mjs`
- `23c0599e4` thingphysics: a forced track re-arrives by teleport at most once in 3 s too (each is an act on the record)
  - `test/client/track-teleport-test.ts`
- `e12a7874e` audio tests: transcriptions of product code become executed rows against the shipped modules
  - `test/client/ttsrow-test.mjs`
- `963e6510e` wiring-check: the source-grep wiring rows as one table, each row with its controls; absorbs conjure-coop-contract-test
  - `test/client/wiring-check.ts`
- `b6df4c294` fix(333-cm): a5 Create ▸ Environment and env rows open the world's card and scroll to it
  - `test/client/world-card-probe.ts`
- `db893179b` xr-desktop-banner-probe: the desktop banner as one transition table (killed > 'In VR' > none, across pref changes and exit); absorbs xr-invr-label and xr-mirror-banner
  - `test/client/xr-desktop-banner-probe.mjs`
- `61839f1d5` spec/: only what an outside implementer needs; the v1 worlds and the rig/asset fixtures move to test/fixtures/ (org C7)
  - `test/fixtures/README.md`
- `9258bb57f` gate: a suite that every cited repo path resolves (paths)
  - `test/gate/paths-check.ts`
- `7e3583cb8` suite.ts: one scaffold for the protocol suites (ok/check, --only, the summary, the exit); 8 suites moved onto it
  - `test/gate/suite.ts`
- `7abfcdfa4` hygiene: new file names are lowercase-hyphen; today's 37 underscore names are listed exceptions that only shrink
  - `test/gate/underscore-names.json`
- `708929e6c` hygiene: refuse an ungated test (R 10-29: every test in the gate or gone); the 161 still out are listed with one line why
  - `test/gate/ungated.json`
- `0aef22999` gate: snapshots-test and snapframe-render-test were never run (a bun:test file needs bun test: tools/bun-test.ts)
  - `test/harness/bun-test.ts`
- `1302e43dd` tests: the browser probes run without playwright: probe-harness drives Chromium over raw CDP (cdp-pw.mjs); 7 XR/VR probes gated
  - `test/harness/cdp-pw.mjs`
- `b6477cf79` labworld.ts: the in-process authority fixture (scratch root, lab clock, call that steps then requests, ENG); disabled, hands, settle, reset, histdiff use it
  - `test/harness/labworld.ts`
- `d58846037` tools tests: every WorldAgent gets the test's own server (tools/no-world.ts, port 0); seven tests read /geom and /library from 127.0.0.1:8940
  - `test/harness/no-world.ts`
- `c23ffa20f` stub.ts: a stub that applied to a relative import naming no file fails its suite (the class behind "(xr/)?xrpanels")
  - `test/harness/stub-test.ts`
- `817c90d32` test/harness/stub.ts: a resolver stub that never applied fails its suite at exit
  - `test/harness/stub.ts`
- `9190f1d4a` agent: every world-server read has a deadline; a geometry read that failed isn't cached
  - `test/mcpl/agent-reads-test.ts`
- `d2cd4005f` headless-core: backendName is a function, as core.js's is; headless-core suite pins every shared export's kind
  - `test/mcpl/headless-core-test.ts`
- `a554f54bc` gate: determinism row — no host sin/cos/tan/atan2/exp/log/pow/random, Date.now or performance.now in fold.js, eidosim or the sim modules they reach
  - `test/protocol/determinism-check.ts`
- `6f4149a02` agentTokens: a malformed or unreadable reload fails closed (bot #333 5)
  - `test/server/agent-tokens-reload-test.ts`
- `8f6fcdec9` anim: a socket holding a backlog skips the 64 KB packet (stop still always goes; security review M5)
  - `test/server/anim-backpressure-test.ts`
- `e6f797ba4` served-routes-test: one table of served routes, each isolated, absorbs isolation-headers-test and deps-route-test
  - `test/server/served-routes-test.ts`
- `b29544bc5` MS-S2: upload-cap-test holds /upload's whole-body cap; image-upload-test's oversize row pins IMAGE_CAP's words
  - `test/server/upload-cap-test.ts`
- `ea2c5afbd` fix(333-cm): C-5 C-6 C-7 C-8 help and refusal words say what the code holds
  - `test/shared/help-words-test.ts`
- `1428464d4` picture-look: the agent's look() line for a picture, main's picture-test perception leg, gated (bot #333 408)
  - `test/shared/picture-look-test.ts`
- `2cf188f21` replica-hierarchy: main's index-vs-scan suite, ported and gated (#333 q2 411)
  - `test/shared/replica-hierarchy-test.ts`
- `0acf1a545` fix(333-r2): look-at's 90 m gate reads a parented thing's world position, as motion's does (#687)
  - `test/stubs/lookat-stub.mjs`
- `6cc1afd12` tools/dev/mv-module.ts: the folder commits' one mover; resolves every path it rewrites, never a blind substitution
  - `tools/mv-module.ts`
- `5a8e14f47` test trim: delete dead tests, rows that can't fail, and an API with no caller (#333 trim H2 H4 H8-H15)
  - `tools/operator/snap-native.ts`

## sha256 of every other file in this bundle

```
8155f9e29b2e72b01649da01d647c407dc079df203d98aef1eba8bc3a3c027c8  01-mapping.tsv
14112f7fdca8f40c5f0b94fc5e98f0010c98e2832e2173393133cdaaf0945e7d  02-dispositions-round1.md
2b64271044964c1ca9978a4c406c1c9e60f72df9bf213837f3b88bb880b5acb8  02-dispositions-round2.md
5d81504d7fd95f3a053f1f659aaf7ce9e8e42af7a141afccc1c54553324aaba5  03-post-pr.md
4d92b464bb2c8954c36b5d7cb51cf804ecc63203603bb173eea02bb4f6243ae0  04-xr-quad-softswap.md
8700958a49386ec99b7bc40681a03c9c862007678c2a837156fa313e966256d0  scripts/build333.py
6f388b85aa253072c52bc93e1382bba06ab9069a1ce3e6d1ed8950adfc1d264f  scripts/emit333.py
24cd61ac30eb31fbaefb02636228dd2996c46501344dc6c18be547b0fe48aaa9  scripts/map333.py
6336cd9d3d85efca362b7ae2e0fc78113485bb962166aaf24b30f15049a9c8d7  scripts/sim333.py
09c928e7b5e9485234109f58a5e16f62412ef7f2d337b9a0f5c65a31586e8509  scripts/trace333.py
```

Check with `sha256sum -c` on the lines above (run from the bundle folder).
