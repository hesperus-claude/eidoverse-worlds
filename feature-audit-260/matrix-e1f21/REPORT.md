# #260 parity matrix re-grade at head `e1f21cc9a52c5df58d76a9159e96948a6254d777` — report

> **Amended 2026-10-30 at `c04cb7b3a`** (graded at e1f21cc9a; 3a2fdd101 and 8ab3324bf in between change no grades). c04cb7b3a 'water speed is a physics-area again': water.drag is gone (componentspec, mover, zone, client, bodyverbs, render-scene; REGISTRY-CHANGELOG 2026-10-30, re-pinned with an ack) and translate-v1@35 writes main's water.speed as physics-area {kind: speed, factor: speed / 2.4} on the water's zone (translate-v1.js:125, :429, :442-447). Intermediate 8ab3324bf (comment fixes) and 3a2fdd101 (a 415 wording fix) change no grades. No grade moved; counts unchanged; 50(B8)'s decision row is now 27. Known: a translated pond's speed area also slows walking and wading on its floor, where main changed only the swim. Rows amended: 1, 14, 50(B8), 5,C6, 51 (each row's *Changed since* and *Verified* say what moved). RE-RUN at c04cb7b3a (<local worktree>, BUN_RUNTIME_TRANSPILER_CACHE_PATH=0): water-import 15 passed, 0 failed (G1, G4s ok); translate 44 passed, 0 failed (F50, F51, V5 ok); render-scene-import 19 passed; physics-area 5 passed, 0 failed (A3 ok). Mutants not re-run. Pre-amendment SHA-256: MATRIX-260.md 1aa6e2ca679161774cda99117260c60497934c8c17509c0094cc935a55656f99, MATRIX-260.json 7089afa303c5bca158be31a95ca7dd4595ae5c17361e78e38f0e7b257d2add2d, REPORT.md 9322aa35b23ae3b0535ca7d2bce43d30cc26a25e2b49621fe970087369b858e8, BODY-DIFF.md 7668d396da23df9142e681eb8d1ba656c957b96b3f19a9f56886e83cd881255c.

2026-10-30, read-only audit (Fable 5.1 as lead; five read-only sub-auditors for water/native, consent/agents, builders ×2, access/tests; every row re-opened at `<local worktree>` = e1f21cc9a; main = `ccd5c53fa`, unchanged since the previous matrix). Previous matrix: `../matrix-72847/` (head 72847d01d, accepted by Mica). 105 commits between the two heads (`git log --oneline 72847d01d..e1f21cc9a`; 166 files, +3,033 / −1,259). Beside this file: `MATRIX-260.json` (same schema as 10-29 plus `status_72847`, `changed_since_72847`, `commits`, `decision_row`, `verified`), `MATRIX-260.md`, `BODY-DIFF.md`, `suite-runs.log`.

**How suites were run.** `wt-s-int`'s `node_modules` is a dangling symlink (to a removed worktree), and the tree is read-only for this audit, so nothing was installed there. Instead 21 suites ran one at a time through `eido-suites.sh` from `<local worktree>`, a clean sibling checkout of the SAME commit (`git diff --quiet e1f21cc9a` empty, `git status` clean): translate, water-import, drive, physics-area, climb-env, consent-client, physconst, alias, force, sockets, places, owners, upgrade, fork-reset, grant-command, skypanel, scripts, importer, directory, mover, agenttools — each `total 1 passed, 0 failed, 0 skipped` (the gate's lane tally; per-row counts the sub-auditors saw directly: translate-check 44/44, force 15/15, sockets 83/83, owners 45/0, physconst 58/0, grant-command 23/23, skypanel 18/18). Not run: the full gate, any browser/GPU lane, identity, roles, access, authority, shape-render, shape-repair, sound, presence, zone-water, door-wording, access-panel. Row ids were located by opening the suite files; "restored" rests on an opened row id in the tree, with a green lane where the suite was run.

## Counts, old → new

| status | 72847d01d | e1f21cc9a |
|---|---|---|
| restored | 30 | **34** |
| intentional-change | 23 | **28** |
| partial | 12 | **8** |
| absent | 15 | **11** |
| unverified | 4 | **3** |
| total | 84 | 84 |

No new rows: no main feature the old matrix missed was found. Row ids are unchanged.

## Every row whose grade changed (9), plus one overruled, with the commit

| id | was → now | why | commit(s) |
|---|---|---|---|
| 3,50(B7) Environment / motes | partial → restored | motes' count, range, colour carried into the derived dust document (clamped 600 / 32 m, over-limit kept in `imported:environment`); translate DT8, water-import G3e, importer IM-E1. Residual named: main's camera-follow can't be expressed in a document. Decision row 8 (owner column empty). | 6293438e6 (@34); also 3eb5c51c1 stage box for bounds-less old worlds (row 24), d08745574 / e8308f061 KillZ |
| 29 catch_up | absent → restored | description says speech is arrival-only; agenttools AT10. Decision row 11. | fc183b4f3 |
| A6 /upload?as=script | absent → intentional-change | the 415 now names `upload {text}` and the `script:<name>` binding (door-wording row :797-802). Decision row 12. Leftover: `tools/seatlab/README.md:22` still shows the old curl. | 36dc1833e |
| 34(tool) world_access timed grants | partial → restored | `act set roles:<id> {for: "2h"}` → `until` = server now + duration, malformed refused naming the forms; agenttools AT11. Decision row 14. | 52ea73571, a64c286df |
| B6 socket with no pos | absent → restored | `newSockets` defaults pos to main's `[0, 0.5, 0]`; translate DT9 (44/44 seen). Decision row 9. The authority's own fallback for a v4-native pos-less socket is still `[0,0,0]` (`sockets.js:173`): translator-scoped, as the decision row says. | 34c1753c2 (@33) |
| 36(sky) sun/fill sliders | partial → intentional-change | decision row 16 records sun/fill as cut on purpose (owner column empty); `sky.audio` is a real bool field with S3-SA passing, so the old "contradicts the 13:44 ruling" note is superseded by @25 in the code. | ruling only (no code change) |
| 12,C4,C5 `_emotes.json` | absent → intentional-change | decision row 10: the lead ruled 10-30 the engine reads `_actionbar.json` only; still a real difference from main (`defs.ts:76`). | ruling only |
| 22 rights of translated worlds | partial → intentional-change | the 72847 defect (ownerless worlds' builders locked out of `who: builder` gates) is gone: @30 made everyone builder, then @31 deleted the ownerless lift because every translation now ends with an owner (`--claim` or named owner, else refused; `upgrade.ts` always claims). Main's effective rights come back as explicit grants (translate R22a–h, owners CL1–CL11, 45/0 seen) but the ownership model is not main's → decision row 26. | d43fe67f1, d00de504a, 2cf1e6de9, e1f36e745, 3eb5c51c1 |
| 28 phones / VR buttons | unverified → intentional-change | decision row 20: the lead ruled 10-30 "keep as built". Code unchanged (`xr.js:1261-1270`, `build.js:81-85`); still no test, not checked in a headset. | ruling only |
| 15 body consent | restored → restored (sub-auditor proposed intentional-change; overruled by me) | main's shape IS two switches (pushable / posable); the removed `ask` tier was v4's own, so against main this is a restoration. The lists and ask's removal are decision row 4's question. Evidence moved: migration never widens (`ew-posable '1'` → Touch me off + one notice), lists 1024, consent.json 0600 across restart. | a4ed40a35, 1d84b9ab2, e42d3d080, 45b1049cb, e70ae9ed8 |

## Rows whose grade held but whose substance moved

- **50(B8) per-volume swim speed — restored; mechanism AMENDED at c04cb7b3a.** At e1f21cc9a translate-v1@31 (3eb5c51c1) wrote main's `water.speed` as the water's own drag (`render-scene.ts` inverted it, b3984c665; the lead's 10-28 item-50 ruling was superseded with no decision-table row). At c04cb7b3a (translate-v1@35, owner 10-30 "despaghettify") that is undone: `water.drag` is gone from componentspec, mover (swimDrag/swimThick), zone, the client (waterDrag), bodyverbs (thickAt/watersOf) and render-scene (`spec/REGISTRY-CHANGELOG.md` 2026-10-30, re-pinned with an ack; no compatibility shim — only test or scratch worlds carried it), and `waterOfOld` writes `physics-area {kind: speed, factor: speed / 2.4}` on the water's zone (`translate-v1.js:442-447`; within 5 % of 2.4 nothing is written and the report says so; the factor clamps 0.05..10, so a main speed under 0.12 m/s swims at 0.12). `render-scene.ts:94-95` reads the factor back. Decision row 27 records it (our side ruled 10-28, reaffirmed 10-30; owner column empty). Tests: water-import G1, G4s; translate F50, F51, V5 (@35); render-scene-import R1; physics-area A3 — re-run green at c04cb7b3a (15/15, 44/44, 19, 5/5). The `render-scene-import-test.ts:26-28` stale-wording finding is closed (the comment says physics-area, @35). **Known, plainly:** a translated pond's speed area also slows walking and wading on its floor (componentspec `physics-area` docs: walking, running, wading, swimming; the mover's stepWalk takes env.speedAt), where main changed only the swim — the PR body should say so (its L168 caveat is right again). Residual wording: `translate-check.ts:171` F50's title still says "(@31)".
- **1 vehicles / 50(B9):** @32 (24cac47b3) adds Godot-style collider layer/mask; each translated vehicle's walls are banded in their own layer (drive D25–D27); `simlayer.js:91` filters by blocks/layer/mask. c3800f7a7 (a hull's `collider.blocks` says what it stops), 9bfa447cb (unit q, bounded slack, lease yields to edits), 8e4e57d01 (standing up frees the hull).
- **1 climb routes:** evidence correction — main also capped a route at 16 points (`traversal.js:20`); the old note's "unbounded" was wrong.
- **7 use:** decision row 18 (lead 10-30: keep v4; "upgrade declares old events as custom actions"). The second half is **not built**: `translate-v1.js` newReactions rewrites only impulse/door; no `custom` action is written; no test row.
- **14 float depth:** decision row 7, lead ruled 10-30 keep v4's; code unchanged (`mover.js:63,70,72`).
- **51 walking body:** decision row 6 says "back to main's 0.55 m — ruled, held" for a follow-up PR; the tree at e1f21cc9a still has radius 0.2 / step 0.8 (`shared/mover.js:43-45`) and `mover-check.ts:7` pins 0.8. Ruled, not landed.
- **37 caption deed:** decision row 17; main's deed was generation-bound (`server/verbs.ts:134-143`), v4's `captioners` lives on the screen → effectively equal. Correction: the old row's test label "CA1–CA…" was wrong (authority-check CA1–CA5 are `create at` rows); the captioner test leg is unverified.
- **25,26,27 public reads:** `/worlds` carries `agents: [ids]` again (declared `agent`, §6a; `routes.ts:808`; agenttools AT12, names W1/W2; `tools/worlds-route-test.ts` exists but is not in `suites.ts`). Still partial: `/geom` mounts/simAt absent, no access-word alias. Decision row 21.
- **S3-L1 lights:** decision row 23 — the translator writes main's inferred lamps as light children (`translate-v1.js:665-670`); the glowing-model prefab 3cee6acc6 was reverted (f8b07505b); a freshly placed glowing model glows only.
- **S3-N6 /role shows +gen:** a dedicated row now exists (`grant-command-test.ts:102`, 23/23 seen) — the old "no dedicated row" caveat is gone.
- **21 kick:** the stale "kick cooldown" comments at `server/worldlog.ts:417` and `server/peer.ts:4` STILL linger (263eb252b did not reach them).
- **45(A2),11 place {x}:** still refused as a generic unknown-arg with no pointer to `at` (8ce290e07 did not touch `verbspec.js`).
- **40,52 lost cover:** suites.ts 193 → 200; the seven new (collider-off-bodies, helm-leave, lock-strength, swim-lists, killz-slumped, consent-scripts-list, custody-save) are none a twin of a lost v1 test; `comps-parity-test.ts` still unregistered; `security-check.ts` retired (55f929c9b).
- **S2 v1-speaking tools:** 17 → 16 files (09927bdde fixed `bootjank.ts` only).
- **S4 / S3-S4 doc rot:** grep of ten v1 words over the five named docs → one stale line, `docs/UPSTREAM-FLAGS.md:203` names a `whisper-disable` suite that doesn't exist; `SHOW_RUNBOOK.md:81` (token rotation into a file not in the tree) is byte-identical to the old head.

## Still absent or partial (one line each)

**absent (11)**
- 5,C6 Unreal native client: render-scene not served (`server.ts:809`), non-replica join closed 4005 (`:1015-1021`). A client-side bridge exists outside this repo (decision row 22).
- 248-join · 248-replica · 248-snapshot · 248-log · 248-writes · 248-roles · 248-capture · 248-pose: absent in this tree; bridge outside the repo (decision row 22). 248-roles evidence drift: `access-directory` no longer appears in `server/*.ts` (`requestwire.ts:40` is whois).
- 41 wrong commit message 3152ff60b: still an ancestor; a note for the PR text, nothing to restore.
- S2 ~16 `tools/` scripts still speak `{type: "verb"}`: none gated; routed to #13.

**partial (8)**
- 10 world_debug: `script`/`scripts` args + six kinds; main's `behavior` args pass silently; no row.
- A4,A5,A7 punt {dir} / light keep / shove target trim: `dir` refused generically; `keep` → `important` only in create's doc; no rows.
- 8,B5 impulse reaction: translated swings pinned; a NEW `impulse` handler refused as reserved (authority SW1); decision row 19 unruled.
- 48(B2),36 picture on a model part: → `material` (ruled); UV flip carried and listed, not mapped; no material inspector card.
- 25,26,27 public reads: `agents` list back; `/geom` mounts/simAt and access-word alias absent.
- 40,52 lost test cover: as above.
- 42 SHOW_RUNBOOK: rewritten for v4 (+ HN_NATIVE_ORIGIN row, 2dee96dee); a doc, no row.
- S4 doc rot: one stale line left (`UPSTREAM-FLAGS.md:203`).

**unverified (3)**
- G2 world_history `kinds`: code present (`tools.ts:132`), no row — and main filtered by `verbs`, so `kinds` is v4's addition, not a main feature restored.
- G1a body_state `posture` twin (`body-state.ts:265`): no test.
- S3-S4 doc rot (5 lines): the five lines were never enumerated; greps find no stale usage beyond the one above.

## What I could not verify

1. **Owner rulings.** Every decision row cited by an intentional-change grade has an EMPTY "Antra's ruling" column. Each such grade rests on our side's ruling and says so in `lean`.
2. **Suites not run** (above). zone-water ZM's row id was not re-located; water-vectors and mover-check print no per-row ids; the captioner rows (37) were not located.
3. **Main-side lines for the S3-* translator rows** (T2, L2/P1/M1, S1, N4, N5, N6, G1, L1) are still "per SWEEP-3", not opened on main — the same gap the accepted matrix had; flagged per row.
4. **Browser lanes** (access-panel AP7/AP7b/AP8, physics-off, modhole, fog-mask) not run.
5. `0421f53a3` (setup-check dirs) and `a64c286df` were not opened beyond the log.
6. scripts-check run DIRECTLY by a sub-auditor showed S1/S2 red (rows spawning a real server) without the runner's env; under the real runner from wt-s-rows the `scripts` lane is green — environment, not a finding.

## Decision rows whose "Done/Restored" the tree confirms

8 (motes, 6293438e6) · 9 (seat pos, 34c1753c2) · 11 (catch_up, fc183b4f3) · 12 (upload 415, 36dc1833e) · 13 (places 64 KiB proved, 61d536c59; places-test :241-248) · 14 (for: "2h", 52ea73571) · 21 (/worlds agents, e1f21cc9a) · 23 (lamps as light children, 3eb5c51c1; prefab reverted f8b07505b) · 24 (stage box only for bounds-less old worlds, 3eb5c51c1; fence = bounds, dc1b944fc) · 25 (Q throw, C/Ctrl down, 6616997af) · 26 (every translation ends with an owner, 3eb5c51c1). **Not landed though ruled:** 6 (walking body 0.55, held) · 18's second half (custom actions for old `use` events) · 15's proposed "AI" label (no such label in `client/lib`).

— Hesperus
