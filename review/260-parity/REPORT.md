# #260 parity matrix refresh at head `72847d01d9819ea8b2ecb48455b43a496b7ceeb9` — report

2026-10-29, read-only audit (Fable 5.1 as lead, three read-only sub-auditors for agents/consent, builders, access/tests; every row re-checked at `git show 72847d01d:<path>`; main = anima/main `34fd77ea2`, whose cited files are byte-identical to `ccd5c53fa` — `git diff --stat ccd5c53fa 34fd77ea2` on them is empty; #283 touched only ragdoll). Beside this file: `MATRIX-260.json` (10-27 schema + `head`, `summary`, per-row `changed_since_1027`, `note`, `status_1027`), `MATRIX-260.md`, `rows-*.json`, every suite log (`*.log`).

Suites ran from `wt-s-int` (HEAD 4856cc7e9 = 72847d01d + one statecache test commit) under `flock ~/eido/.testlock` with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`. Nothing edited. "SEEN PASS" = the count printed in the log beside this file.

## Counts

84 rows (57 from 10-27 re-audited; 19 added from SWEEP-3/SWEEP-2; 8 for #248 native).

| status | n | 10-27 (57 rows) |
|---|---|---|
| restored | 30 | 9 |
| intentional-change | 23 | (was intentional 4 + delta 13) |
| partial | 12 | 10 |
| absent | 15 | (was open 25) |
| unverified | 4 | — |

Of the 25 "open" on 10-27: 12 restored (4 force, 9 SDK, 17 particles, 18 sound, 21 kick, 24 name bans, 50/B8 water speed, 46/13 access words, 15 consent, 30 upgrade, 22 rights (partial), 50/B9 walls), 7 owner-ruled intentional (33 mods, 44 world_verb, 45 spawn/place, G6 aliases, 31 founding, 7 use, A8), 6 still absent with no ruling (29 catch_up, A6 upload?as=script, B6 socket pos, 12 emotes, 41 commit messages, S2 v1-speaking tools).

**Water (Antra's named absence):** all five #248 systems restored with a watched test and a translator path — water bodies (zone-water 18/18, water-import 15/15), air boxes (Z4/Z10/Z11, G2/G6: 8000 seeded points agree with main's `mediumAt`), climb (climb-env 14/14, G3c), vehicles (drive 19/19, G4v/G4w/G4o; `minY/maxY` → two locked hull-only walls, `probes` retired per R 10-28 item 50), collision off (K1–K3). `water.speed` → `physics-area {kind: speed}` (physics-area 5/5, G4s). Still open here: **14 float depth** (1.1 → 1.275 m, dive needs 1.66 m; lean only, no ruling) and **3/B7 motes** (floor/spawn/bounds/sky restored; motes reduced to a dust effect ≤600 over ≤8 m, unruled).

**#248 native Unreal (8 rows):** ABSENT in the PR tree — join, replica, snapshot, log stream, writes, roles, capture, pose. `server/server.ts:1015` closes a non-replica join 4005; `:809` says render-scene isn't served; `server/render-scene.ts` now inverts the translator's mapping (316ccc91e) but nothing serves it (`suites.ts:199`). A bridge-based restoration is being built in a separate repo (`eido-bridge`: joins as a replica, folds with the engine's own `replica.js` as a pinned submodule, local `bridge/*` protocol; slices B/C/D merged at abe398c; 29/0 in its own suites, outside this PR's gate).

## What changed since the 10-27 matrix (3c5c4d2d1 → 72847d01d, 154 commits)

- translate-v1 @21 → **@29**: @22/@23 look → description, @24 the 10-28 rulings + SWEEP-3 items + light parity, @25 sky.audio, @28 first environment only, @29 vehicle walls + physics-area.
- New: `physics-area` (c64e37732), `collider.blocks` (742ace624), `force` + `/boom` (55435d86d; force-check 15/15; arithmetic in `shared/blast.js`, not `shared/force.js`).
- Consent rebuilt (41e357a4c, 027e1a6d4): Move me / Touch me + allow/block lists, ask removed; ranges lifted (N2); refused target told (N1).
- Access/ops: kick conventional (7080f15ae); RATE server policy, VERB_RATE + FOLD_EVERY deleted; founding/fork quotas gone; name bans bound at boot (c3b41162c, df85aed96, 283744650); upgrade by operator or bound owner, ownerless claimed; setup link; `inhabitant` → `member`; picture broker → screenshot.
- Scripts: `@world` scripts, `world.use`, `world.nearby`, `scripting/` kit.
- Boot: state cache, sim checkpoints, fold-cache parity.
- Features: sound 200 m / 32 voices, object-physics switch, sky world select gone, old tool names taught not run (483782d54, 55435d86d); sky takes audio again (ea69d44fd).
- Tests: level-dive, toast-group, physics-off, avatar/remotes-limp-edge gated; 8 slow-runner CI fixes.

## Rows NOT verified, and why

1. **14 float depth** — mover-check prints only a tally (188/0); water-vectors were re-baselined to v4's numbers, so they can't show parity with main. Values read from `shared/mover.js:63,72` only.
2. **G2 world_history kinds** — code reads `kinds`; no suite row drives it (downgraded from "restored").
3. **G1a posture twin** — `mcpl/body-state.ts:265`; no test asserts it.
4. **28 phones/VR** — no test anywhere; owner dates only in code comments; no 10-28 ruling.
5. **S4 doc rot** — SWEEP-3 never listed the five lines; 483782d54 touched the five docs; can't re-check line by line.
6. **5/C6** — render-scene-import and refusedjoin not run here (absence established by inspection).
7. **fog-mask-check (GPU), level-dive (browser)** — not run; air-box fog masking proven only via Z10's uniforms.
8. **22 rights** — R22a–f seen pass, but the ownerless case deviates from the ruling's letter (rank stays `member` with builder's permissions widened in, not "explicit builder for everyone"): `who: builder` gates refuse everyone until an owner exists; `default-role.can` generate doesn't reach guests. Partial.
9. **Carried columns** browser/agent/vocabulary/specimen are from 10-27 (not re-verified), "—" on new rows. world B's browser walk still waits on the heightmap grid blob (ACCEPTANCE-1028.md).
10. **PR-body counts** measured by regex: 29 `TOOL_ROWS`, 120 refusal codes, 85 pinned names (64 trial, 19 reserved, 2 trial-kernel), 26 authority leaves, ~50 verbs. Exact figures approximate; that the PR's numbers are stale is not.

## Every place the current PR description is now wrong (quoted)

1. L22: "this PR ships one (`translate-v1@13`)" — head is `translate-v1@29` (translate-v1.js:126; V5).
2. L28: "**Water entity volumes, air boxes, climb routes, vehicles and `collision` on/off from #248 aren't registered here yet** (an entity `water` would collide with `@world.water`, and vehicles rode the lease channel). Deferred, not dropped." — all five registered, translated, tested (rows 1a–1e); contradicts L218. Mica's named defect.
3. L32: "Renamed tools still run as aliases: `walk_to` … `spawn {lib, x, z}` → `create {model, at}` … `snapshot` → `screenshot`; `check_model` → `measure {check: true}` … of the nine aliases, `agenttools` AT9 drives four on a live agent" — old names are refused naming the new tool until 2026-12-01 (mcpl/tools.ts:1623-1662; R 13:44 G6); they don't run.
4. L32: "`world_verb {verb, args}` runs `act` unchanged: main's world_verb words … are refused with a did-you-mean, not translated." — world_verb is TOOL_REMOVED; REMOVED_VERBS names each replacement (verbspec.js:146-165); contradicts L226.
5. L32: "`spawn {query}` has no one-step form, so it refuses and names the two calls that do it" — every spawn call answers "is now called create" (tools.ts:1625).
6. L36 "118 codes" / L46 "(still 118 …)" — 120 at the head.
7. L41: "**The translator is `translate-v1@14`.**" and L42 "translate-v1@12 and later (today @14)" — @29.
8. L45: "A yes to an ask is one touch." — ask removed (L214).
9. L46: "Consent: tiers `strangers` → `everyone` / `friends`, cells `everyone | ask | nobody` → `allow | ask | deny`, class `move` → `displace`, and a `delegates` list apart from `friends`." — retired (consent.js RETIRED_CONSENT); two gates + lists now.
10. L4: "of its 77 names, 56 are `trial` … and 21 `reserved`" — 85 names (64/19/2) at the head.
11. L15: "**Ours:** 30 tools" — 29 TOOL_ROWS (world_verb removed).
12. L56: "25 leaves under `shared/protocol/authority/`" — 26 files.
13. L59: "**106 suites**, all green on the posted head" — suites.ts registers 195; L234 says 193/193.
14. L96: "the `walk_to` alias carries both shapes; `check_model` became `measure {check: true}`, keeping its alias" — refused-and-taught, see 3.
15. L159: "grab / put / throw / punt check rank only, not the body gate" and "A person refused a touch isn't shown why in the browser yet" — a refused person now sees a notice (consent-client-test.ts:133-135, N1); force/boom pass the body gate (F7/F10). grab/put/throw clause unverified.
16. L177: "34 of the 51 verbs refuse it" (`dry`) — verb set changed (force added, world_verb/whisper removed); not re-counted; stale.
17. L179: "`world_verb` passes main's verb words through untranslated" — removed, see 4.
18. L184: "`tools/shape-render-test.ts` … exists but no runner reaches it; it isn't in `run.ts`." — registered as `shape-render` (112/112 seen).
19. L187: "The fixes are in progress on `wt/r11`, which is planned to add `consent {unfriend, undelegate}`." — r11 landed (r11-check in the gate); unfriend/undelegate now retired with the friends list.
20. L214: "Migration only ever narrows: any old deny becomes a block, and ask becomes both off." — stored `ew-posable` '1' migrates to Touch **on**, wider than the new default off (consent-client-test.ts:72). Keeps the user's choice, but the sentence is false.
21. L218/L219 restorations list omits **22 translated-world rights** (R22a–f), **24 name bans** (B24a–f), **21 kick**, and that vehicle **probes are retired** (R 11:33: "explain IN THE PR").
22. L220: "`sky.audio` as a bool" — the code does it (@25, S3-SA) but MORNING-ASKS records R 13:44 "Sky audio → a `sound` on @world, spatial:false, no sky.audio field"; commit ea69d44fd (15:36, after) cites "(R 10-28)". Two records disagree; R to confirm; the PR should say which.
23. L226: "Old MCP tool names are taught until 2026-12-01." — TOOL_RENAMED only; world_verb and whisper have no end date.
24. L212 "Operators narrowed" under "Needs an owner's yes" — R 12:30 "S2 keep" already answered; and a bad operator entry is refused loudly, the server boots (78458474c).
25. L235: "A sweep for those patterns across `tools/` goes in #13, not here." — covers slow-runner CI patterns only; the ~17 tools/ files still speaking v1 (`type:"verb"`, S2) appear nowhere in the PR.

Stale by omission: L27 (#248) should name the bridge repo as the path; the PR is silent on eight unruled deltas (51 walking body, 14 float depth, B6 socket pos, 12 `_emotes.json`, 29 catch_up, A6 upload?as=script, 35 ◈/nudges, 37 caption deed) — Antra's gate wants each either restored or retired by an owner, and these have neither.

## Owner decisions still needed

14 float depth · 3/B7 motes · 51 walking body · B6 socket pos (0.5 m) · 12 `_emotes.json` · 29 catch_up wording · A6 upload?as=script pointer · A8 8 KB places guard · 34 timed world_access · 35 sitting/◈/nudges · 36 sky sun/fill sliders · 37 caption deed · 7 use free-form · 8/B5 new impulse reactions · 28 phones/VR · 25-27 `/worlds` `agents` alias (none exists) · sky.audio (item 22).

— Hesperus
