# #260 feature-parity matrix — main `ccd5c53fa` vs v4 head `e1f21cc9a` (re-grade of the 72847d01d matrix)

> **Amended 2026-10-30 at `c04cb7b3a`** (graded at e1f21cc9a; 3a2fdd101 and 8ab3324bf in between change no grades). c04cb7b3a 'water speed is a physics-area again': water.drag is gone (componentspec, mover, zone, client, bodyverbs, render-scene; REGISTRY-CHANGELOG 2026-10-30, re-pinned with an ack) and translate-v1@35 writes main's water.speed as physics-area {kind: speed, factor: speed / 2.4} on the water's zone (translate-v1.js:125, :429, :442-447). Intermediate 8ab3324bf (comment fixes) and 3a2fdd101 (a 415 wording fix) change no grades. No grade moved; counts unchanged; 50(B8)'s decision row is now 27. Known: a translated pond's speed area also slows walking and wading on its floor, where main changed only the swim. Rows amended: 1, 14, 50(B8), 5,C6, 51 (each row's *Changed since* and *Verified* say what moved). RE-RUN at c04cb7b3a (<local worktree>, BUN_RUNTIME_TRANSPILER_CACHE_PATH=0): water-import 15 passed, 0 failed (G1, G4s ok); translate 44 passed, 0 failed (F50, F51, V5 ok); render-scene-import 19 passed; physics-area 5 passed, 0 failed (A3 ok). Mutants not re-run. Pre-amendment SHA-256: MATRIX-260.md 1aa6e2ca679161774cda99117260c60497934c8c17509c0094cc935a55656f99, MATRIX-260.json 7089afa303c5bca158be31a95ca7dd4595ae5c17361e78e38f0e7b257d2add2d, REPORT.md 9322aa35b23ae3b0535ca7d2bce43d30cc26a25e2b49621fe970087369b858e8, BODY-DIFF.md 7668d396da23df9142e681eb8d1ba656c957b96b3f19a9f56886e83cd881255c.

Generated 2026-10-30. Previous head `72847d01d`. Re-grade of every 72847d01d row at e1f21cc9a (105 commits later; main ccd5c53fa unchanged). Status rules unchanged: restored = file:line opened on both sides this run AND a named test row id in the v4 tree; suites that were run are listed per row (21 suites, each gate lane green, from a clean sibling checkout of the same commit; wt-s-int itself is read-only and its node_modules symlink is dangling). intentional-change rows point at their row in the owner decision table (DECISIONS-260.md) where one exists; a decision row whose owner column is empty is a proposal, said so in `lean`. Native Unreal rows are graded as of this tree; a client-side bridge exists outside this repo (decision row 22). Private production fixtures are 'world A' / 'world B' only. browser/agent/vocabulary/specimen columns are carried from the previous matrix unless a row's `verified` says they were re-checked.

| status | 72847d01d | e1f21cc9a |
|---|---|---|
| restored | 30 | 34 |
| intentional-change | 23 | 28 |
| partial | 12 | 8 |
| absent | 15 | 11 |
| unverified | 4 | 3 |
| total | 84 | 84 |

Columns per row: status (72847 → now) · decision row · system · implementation · migration · evidence (main / v4) · tests · changed since 72847d01d · commits · lean · note · verified.


## Water & movement (owner's named blocker) (10 rows)

### [1] Water volumes (entity `water`: swim inside an authored body)

**restored**

- **Lean / ruling:** none (restored)
- **Implementation (v4):** shared/protocol/componentspec.js:555-570 (water: level/color/…/attenuationColor/attenuationDistance/scatterColor/density; no drag since c04cb7b3a; help :570 'How fast a body moves in it is a sibling physics-area {kind: speed, factor}') + :572-588 (zone) + :589-594 (physics-area); shared/zone.js:71 waterVolumes, :96 mediumOf; client/lib/watervolumes.js (reads zones)
- **Migration:** VOLUMES.water translate-v1.js:428-429 ('main's speed → physics-area {kind: speed, factor: speed / 2.4} on that zone … scales every body's speed inside it (walking and wading too, where main changed only the swim)'); waterOfOld :438-448 (center/size → zone {box,size}; absorption → attenuationColor/Distance :444; scatter → scatterColor :445; speed → f = speed/2.4 clamped .05-10 :442, area {kind: speed, factor: f} :443 unless within 5% of 2.4 (SPEED_NEAR :450), then dropped and said :447); volumePartsOf :453-460 (the area rides beside zone+water :457; on the thing when it has no model/light and centre 0 :458, else a `water` child at the centre :459); @world water is ON_WORLD :426 (still refused)
- **Browser:** watervolumes.js reads zones; rebuild-on-every-change bug fixed
- **Agent:** same as main: the walker reads the world water level (agent.ts:2773 waterStance); zones are a follow-up (main had none)
- **Vocabulary:** zone {shape,size,priority,…}; water on thing or @world (water.drag GONE at c04cb7b3a: spec/REGISTRY-CHANGELOG.md 2026-10-30 'type number → gone', re-pinned); how fast a body moves in it is a sibling physics-area {kind: speed, factor}
- **Specimen:** world A: translated (divergences 0), served, joined in a browser, water level applied, a body floats in its deepest column. world B: translated + served clean; its water sits on a heightmap whose grid blob isn't in the fixture copy, so the browser walk waits on that blob (ACCEPTANCE-1028.md)
- **Evidence — main:** client/lib/watervolumes.js:250-262 (waterParams per entity, axis-aligned box, fog slot); shared/water.js:7-16 (waterParams: center/size/absorption/scatter/speed :12/waves)
- **Evidence — v4:** shared/protocol/componentspec.js:555-570 (water; no drag field; help :570 names the sibling physics-area) + :572-588 (zone) + :589-594 (physics-area); shared/zone.js:71-81 (waterVolumes: each body through waterParams with no speed → 2.4, no drag :74), :41-52 (physicsAreasOf), :56-58 (speedFactorAt), :96 (mediumOf); tools/protocol/import-v1/translate-v1.js:125 (TRANSLATOR @35), :438-448 (waterOfOld)
- **Tests:** zone-water Z1 (zone-water-check.ts:104), Z3 (:136), Z5 (:183), Z6 (:197), Z7 (:208), Z8 (:218), Z12/Z13 (mutant list :36-37); water-import G1 (import-golden-check.ts:30-32: 'main's swim speed 2.4 is the stroke here, so no physics-area is written'; asserts b['physics-area'] === undefined), G5 (:161), G6 (:173), G7 (:180) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: water-import · RE-RUN at c04cb7b3a (<local worktree>, BUN_RUNTIME_TRANSPILER_CACHE_PATH=0): water-import 15 passed, 0 failed (G1, G4s ok); translate 44 passed, 0 failed (F50, F51, V5 ok); render-scene-import 19 passed; physics-area 5 passed, 0 failed (A3 ok). Mutants not re-run.
- **Changed since 72847d01d:** Grade unchanged. Evidence changed: at e1f21cc9a water.speed mapped to water.drag (translate-v1@31, 3eb5c51c1), the authority's track widened for thin water (f63c65646), render-scene inverted drag → speed (b3984c665); translator @34. AMENDED at c04cb7b3a: water.drag is gone and water.speed → physics-area {kind: speed, factor} on the water's zone (translate-v1@35, translate-v1.js:125, :429, :442-447); render-scene reads the factor (render-scene.ts:94-95); G1's title now says 'no physics-area is written'.
- **Commits:** 3eb5c51c1, f63c65646, b3984c665, 6293438e6, 24cac47b3, c04cb7b3a
- **Note:** What v4 does with an old world: each `water` thing becomes a zone+water (thing or child); `speed` → physics-area {kind: speed, factor: speed/2.4} on that zone again (row 50/B8; translate-v1@35, c04cb7b3a; @31-@34's water.drag is gone, no shim — only test or scratch worlds carried it, nothing merged). PR §Restorations may say physics-area again; it should also say, plainly, that the area slows walking and wading on the pond's floor, where main changed only the swim.
- **Verified this run:** Opened this run: main watervolumes.js:86-119,250-272,326-336; main shared/water.js:7-16,72-88; v4 componentspec.js:555-595; v4 zone.js:39-62,96-103; v4 translate-v1.js:126-137,312-317,332-375,379-422,425-490; zone-water-check.ts row lines (grep); import-golden-check.ts:23-180 (grep). Suites NOT run: eido-suites.sh fails before any suite ('./node_modules is missing: run bun install' in wt-s-int); installing would write into the read-only tree, so I did not. Specimen names replaced by world A / world B; browser/agent/vocabulary carried forward (agent.ts:2773 waterStance re-opened). AMENDMENT (c04cb7b3a, wt-s-waterspeed): opened componentspec.js:555-594; zone.js:39-58,69-81,96; translate-v1.js:120-140,425-460; import-golden-check.ts:30-32,136-147; REGISTRY-CHANGELOG tail; `git show c04cb7b3a --stat`. water-import re-run 15/15.

### [1] Air boxes (entity `air {boxes}`: dry interiors that ride a moving hull)

**restored**

- **Lean / ruling:** none (restored)
- **Implementation (v4):** shared/protocol/componentspec.js:585-588 (water-exclusion {bodies?}) + :573-583 (zone, priority); shared/zone.js:96-102 mediumOf (exclusion beats bodies at/below priority; a pocket beats @world's level :100-101)
- **Migration:** VOLUMES.air translate-v1.js:429, AIR_PRIORITY :431, volumePartsOf :459-463: one child per box {transform: center+q, zone {box,size,priority:1}, water-exclusion {}}
- **Browser:** watervolumes.js reads zones; rebuild-on-every-change bug fixed
- **Agent:** same as main: the walker reads the world water level (agent.ts:2773); zones are a follow-up (main had none)
- **Vocabulary:** zone {shape,size,priority,…}; water on thing or @world; registry re-pinned
- **Specimen:** world A: translated (divergences 0), served, joined in a browser, water level applied, a body floats in its deepest column. world B: translated + served clean; its water sits on a heightmap whose grid blob isn't in the fixture copy, so the browser walk waits on that blob (ACCEPTANCE-1028.md)
- **Evidence — main:** client/lib/watervolumes.js:264-272 (air.boxes: size, q, inverse matrix per box, MAX_AIR :7,27-28); server/render-scene.ts:98-99 (air boxes projected, MAX_AIR)
- **Evidence — v4:** shared/protocol/componentspec.js:585-588 (water-exclusion {bodies?}) + :573-583 (zone, priority); shared/zone.js:96-102 (mediumOf: exclusion beats bodies at/below priority); translate-v1.js:459-463
- **Tests:** zone-water Z2 (zone-water-check.ts:112), Z4 (:171), Z4w (:153), Z5 (:183), Z10 (:226), Z11 (:241), ZM (not re-located this run); water-import G2 (import-golden-check.ts:35: 15 pockets), G5 (:161), G6 (:173: seeded points = main mediumAt) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: water-import
- **Changed since 72847d01d:** none (line numbers re-pinned: water-exclusion moved to :585, zone to :573, volumePartsOf air to :459-463)
- **Commits:** none
- **Note:** fog-mask-check (GPU) not in the gate: the shader-side mask is proven only by Z10's uniforms.
- **Verified this run:** Opened: main watervolumes.js:264-272 and :7,27-28; main render-scene.ts:69-100; v4 componentspec.js:573-588; zone.js:96-103; translate-v1.js:425-464; zone-water-check.ts and import-golden-check.ts row lines by grep. Suites NOT run (node_modules missing in wt-s-int). ZM row id not found by my grep pattern; left as carried.

### [1] Climb routes (entity `traversal {routes}`: ladders, moonpool, hatch)

**restored**

- **Lean / ruling:** none (restored)
- **Implementation (v4):** shared/protocol/componentspec.js:515-522 (climb {points 2-16, reach .3-3, speed .3-4, face, ends}); shared/climb.js; client/lib/climb.js (both exist at head: ls)
- **Migration:** CARRIED.traversal translate-v1.js:313; climbPartsOf :359-370: one climb child per route (path → points, radius → reach clamp .3-3, speed clamp .3-4, name → label :366-367); a route with <2 or >16 points → left, carried as imported:traversal on the host (:363, :530)
- **Browser:** watervolumes.js reads zones; rebuild-on-every-change bug fixed
- **Agent:** same as main: the walker reads the world water level (agent.ts:2773); zones are a follow-up (main had none)
- **Vocabulary:** zone {shape,size,priority,…}; water on thing or @world; registry re-pinned
- **Specimen:** world A: translated (divergences 0), served, joined in a browser, water level applied, a body floats in its deepest column. world B: translated + served clean; its water sits on a heightmap whose grid blob isn't in the fixture copy, so the browser walk waits on that blob (ACCEPTANCE-1028.md)
- **Evidence — main:** client/lib/traversal.js:16-20 (routes ≤32 at :19; a route's path must be 2..16 valid points at :20), speed clamp .3-4 at :42
- **Evidence — v4:** shared/protocol/componentspec.js:515-522 (climb); translate-v1.js:359-370 (climbPartsOf); shared/climb.js, client/lib/climb.js exist
- **Tests:** climb-env K4 (climb-env-check.ts:135), K5 (:141), K6 (:155), K7 (:163), K11 (:287); water-import G3c (import-golden-check.ts:44: three routes → climb children) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: climb-env, water-import
- **Changed since 72847d01d:** Grade unchanged; evidence corrected (main's 16-point cap at traversal.js:20; v4 line numbers re-pinned: climb :515, climbPartsOf :359-370).
- **Commits:** none
- **Note:** Correction to the old note: main ALSO skipped routes whose path had >16 points (traversal.js:20), so v4's 16-point cap matches main; the only cap difference is 32 routes per thing in main vs one climb per child thing in v4 (every route gets a child, so none is lost).
- **Verified this run:** Opened: main traversal.js:14-20,40-44; v4 componentspec.js:515-522; translate-v1.js:312-317,359-370,528-531; climb-env-check.ts row lines (grep :135-287); import-golden-check.ts:44. shared/climb.js and client/lib/climb.js exist (ls). Suites NOT run.

### [1] Vehicles driven from a helm (entity `vehicle {helm, exit, speed, turnRate, minY, maxY, probes}` on the lease channel)

**restored**

- **Lean / ruling:** ruled by the lead 10-28 11:33 item 50 (probes retired: the authority's hull sweep does it; minY/maxY → collision layers + walls; explain IN THE PR). Since @32 (24cac47b3) the walls sit in the vehicle's own collision layer (Godot layer/mask) so another hull passes them (D25).
- **Implementation (v4):** shared/protocol/componentspec.js:524-531 (drive {maxSpeed .1-50, turnRate .1-4, climbRate, response, throttle}); :61-70 (collider {shape, enabled, blocks, layer, mask}); shared/drive.js; shared/protocol/authority/drive.js (:32 hullHit sweep, :41-42 hull-only walls by layer/mask); client/lib/vehicles.js:11 (SEND_MS 66 ≈ 15 Hz), :23-31 (W/S, A/D, Space/C at the helm)
- **Migration:** CARRIED.vehicle translate-v1.js:315; vehiclePartsOf :332-346: drive {maxSpeed: speed clamp .1-15, turnRate clamp .1-2, climbRate: speed} :340 + helm child (socket+station drive, leaveBy menu) :341-342; minY/maxY → two hidden locked 200 km hull-only walls (collider {blocks:['hulls'], layer:[bandLayerOf(host)]}) offset by the hull's measured box :337-339, the host's collider mask [1, band] :345; bandLayerOf :348; probes → imported:vehicle, listed (FATES :531)
- **Browser:** client/lib/vehicles.js: W/S thrust (or throttle), A/D steer, Space/C rise/sink at the helm, ~15 Hz stream (:11, :23-31); getting up frees the hull (8e4e57d01)
- **Agent:** — main's agents had none either (no mediumAt/climb/drive in main's mcpl/, checked 10-28): not a parity gap; agent-side water is a follow-up
- **Vocabulary:** drive {maxSpeed, turnRate, climbRate?, response?, throttle?}; station.input {move:'drive'}; collider {blocks, layer, mask}
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending
- **Evidence — main:** client/lib/vehicles.js:1-2 (lease channel), :34-40 (lease granted/denied/lost/released), :55-70 (turnRate clamp .1-2 :55, speed clamp .1-15 :56, minY/maxY clamp :60-62, five hull probes :63-70); server/server.ts:861 (settleLease on close)
- **Evidence — v4:** shared/protocol/componentspec.js:524-531 (drive), :61-70 (collider layer/mask); shared/protocol/authority/drive.js:32 (hullHit), :41-42 (hull-only walls, solidOff by mask); client/lib/vehicles.js:11,23-31,41; translate-v1.js:332-348
- **Tests:** drive D1 (drive-check.ts:129), D2 (:141), D13 (:233), D14 (:271), D15 (:280), D16 (:288), D17 (:294), D18 (:308), D19 (:315), D20-D24 (:240-264), D25 (:324 translator's band: a second hull climbs past it), D26 (:332 Godot's rule), D27 (:341 layer/mask door), D28 (:303 own blocks); water-import G4v (:78), G4w (:106), G4o (:129); translate F50 (translate-check.ts:163), F50b (:172), F50c (:177), V7 (:234) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: drive, translate, water-import
- **Changed since 72847d01d:** Grade unchanged. Evidence changed: collider layer/mask and per-vehicle banding (24cac47b3, translate-v1@32; rows D25-D27), drive review fixes (c3800f7a7 D28; 9bfa447cb D20-D24), helm stand-up frees the hull (8e4e57d01).
- **Commits:** 24cac47b3, c3800f7a7, 9bfa447cb, 8e4e57d01, 3eb5c51c1
- **Note:** The lease is now the authority's drive lease (D5/D8), not main's client-volunteer lease: an intentional shape change already explained in the PR ('vehicles rode the lease channel'). New since 72847: each vehicle's band walls live in their own collision layer (24cac47b3, D25/D26/D27), a hull's blocks says what it stops, not what stops it (c3800f7a7, D28), unit q + bounded slack + lease yields to edits (9bfa447cb, D20-D24), getting up frees the hull (8e4e57d01).
- **Verified this run:** Opened: main vehicles.js:1-2,34-40,55-70; main server.ts:861 (grep); v4 componentspec.js:61-70,524-531; authority/drive.js:11,32,41-42; v4 vehicles.js:11,15,23-31,40-41; translate-v1.js:332-357; drive-check.ts:19-55 (mutant list) and row lines :129-341; translate-check.ts:7-15,162-244. Suites NOT run (node_modules missing). Lean rewritten to 'the lead' per privacy rule.

### [1] Collision on/off (entity `collision {enabled:false}`: walk-through geometry)

**restored**

- **Lean / ruling:** none (restored)
- **Implementation (v4):** shared/protocol/componentspec.js:61-70 (collider {shape, enabled, blocks, layer, mask}); shared/protocol/simlayer.js:91 (solidOff: enabled false, or blocks/layer-mask filtered per mover kind)
- **Migration:** CARRIED.collision translate-v1.js:314 → collider {enabled}; carriedMappings :504 (collision goes out as the host's collider when enabled === false); S3-T1 (translate-check): spawn `collide: exact\|box` → collider {shape: mesh\|box} (not re-opened this run)
- **Browser:** watervolumes.js reads zones; rebuild-on-every-change bug fixed; collision-off things get no collider on any realizing path (b8b818bed)
- **Agent:** same as main: the walker reads the world water level (agent.ts:2773); zones are a follow-up (main had none)
- **Vocabulary:** collider {shape, enabled, blocks, layer, mask}
- **Specimen:** world A: translated (divergences 0), served, joined in a browser, water level applied, a body floats in its deepest column. world B: translated + served clean; its water sits on a heightmap whose grid blob isn't in the fixture copy, so the browser walk waits on that blob (ACCEPTANCE-1028.md)
- **Evidence — main:** client/lib/realize/models_field.js:108 (comp.collision.enabled === false → collision owned elsewhere / not solid); server/render-scene.ts:71 (PASS_THROUGH includes collision)
- **Evidence — v4:** shared/protocol/componentspec.js:61-70 (collider); shared/protocol/simlayer.js:91 (solidOff); translate-v1.js:314, :504
- **Tests:** climb-env K1 (climb-env-check.ts:107), K1s (:114), K2 (:119), K3 (:130); water-import G3 (import-golden-check.ts:39: no `collision` component goes out) and G3c (:44: the scenery's collision toggle is collider {enabled: false}) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: climb-env, water-import
- **Changed since 72847d01d:** Grade unchanged. Evidence changed: collider layer/mask (24cac47b3) widened solidOff (simlayer.js:91); client-side collision-off fix (b8b818bed).
- **Commits:** 24cac47b3, b8b818bed
- **Note:** enabled:false + physics dynamic is refused (K2): main had no such rule (it had no engine). Since 72847: collider gained layer/mask (24cac47b3) and the client stopped building a collider for a collision-off body on every realizing path (b8b818bed).
- **Verified this run:** Opened: main models_field.js:106-110; main render-scene.ts:71; v4 componentspec.js:58-70; simlayer.js:91 (grep); translate-v1.js:312-317,499-508; climb-env-check.ts:19-22 mutants and rows :107-130; import-golden-check.ts:39,44. S3-T1 not re-opened. Suites NOT run.

### [2] tools/water authoring pipeline (prepare / preview / import)

**restored**

- **Lean / ruling:** none
- **Implementation (v4):** tools/water/requests.js:1-5 (main's water-world records → one batch through translate-v1's project/volumeMappings/carriedMappings); tools/water/import.ts, prepare.ts, preview.ts, README.md (all exist at head: ls)
- **Migration:** requests.js imports project/deferredFeatures/volumeMappings/carriedMappings/unmappedOf/namespaceOf from translate-v1.js (:5): the same mapping as the log translator; since @34 the import uploads the derived dust effects before its batch (6293438e6)
- **Browser:** preview.ts: unverified
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending
- **Evidence — main:** tools/water/preview.ts, prepare.ts, import.ts (main: old-format logs + posted verbs; files listed this run)
- **Evidence — v4:** tools/water/requests.js:1-5; tools/water/import.ts, prepare.ts, preview.ts, README.md exist
- **Tests:** water-import G0 (import-golden-check.ts:23: import --dry), G3 (:39: nothing deferred), G4 (:74: a real authority takes the whole batch) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: water-import
- **Changed since 72847d01d:** Grade unchanged; the import now uploads derived effect documents (motes' dust) before its batch (6293438e6).
- **Commits:** 6293438e6
- **Note:** level-dive (browser lane) was not run here.
- **Verified this run:** Opened: v4 tools/water/requests.js:1-6; ls of tools/water on both sides; import-golden-check.ts:23,39,74. Suites NOT run.

### [3,50(B7)] Environment (floor, spawn, 3D bounds, sky gradient, ambient motes)

**restored** (was **partial**) · decision row 8

- **Lean / ruling:** decision row 8 (motes): our side 'Restored' (6293438e6, @34), Antra's ruling column empty → still a proposal. Residual named: main's camera-follow can't be expressed in a document (the field anchors to the environment's thing). Decision row 24 (stage island; ruled yes 10-29): the translator writes a stage box for an old world with neither bounds nor terrain. KillZ 50 m under bounds.min.y (d08745574/e8308f061), not in the decision table.
- **Implementation (v4):** @world.spawn componentspec.js:505; @world.bounds :501-502 ('absent: anywhere is in the world'); @world.terrain {kind: flat, height} :536-551; @world.sky.gradient (K10); particles child naming a derived dust document (translate-v1.js:398-407); KILL_MARGIN 50 m physconst.js:6, spawn.js:49
- **Migration:** CARRIED.environment translate-v1.js:317; environmentPartsOf :379-410 (bounds → @world.bounds :383-384; spawn → @world.spawn or a spawn-point thing :385-387; floor → @world.terrain flat unless a terrain exists :389-390; sky → gradient + sun light :391-397; particles → derived dust doc with main's count/size/range/colour clamped to EFFECT_LIMITS 600 / 32 m, defaults 16 m and #aec8b4, over-limit values kept in imported:environment :398-407); environmentPlan :412-422 (only the first environment by id order is mapped; bounds.min.y lowered 2 m under a flat floor below it :418-421); stageBoundsOf :470-486 (STAGE half 78, floor −2, ceiling 60, margin 2: written only when neither bounds nor terrain, grown past things/volumes/vehicle bands) applied at :900
- **Browser:** flat ground (terrain.js setFlatGround); KillZ respawn; motes anchored to the environment's thing, not camera-following; the 78 m stage island is gone from the client (6616997af)
- **Agent:** agent KillZ respawn (agent.ts; line not re-pinned this run); flat floor in walker
- **Vocabulary:** terrain {kind:'flat',height}; spawn-point; sky.gradient; light.kind directional; particles {effect: <derived dust>, seed}
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending
- **Evidence — main:** client/lib/watervolumes.js:86-119 (sky dome :89-113, sun/ambient envLight :107-112, environmentSettings = first entity's env :116-118, movementBounds :119), :326-336 (motes: count ≤3000, range ≤60 :328, own colour :332, camera-follow positionNode :333-334)
- **Evidence — v4:** componentspec.js:501-502 (bounds), :505 (spawn), :536-551 (terrain flat); translate-v1.js:379-422 (environmentPartsOf/Plan), :470-486 (stageBoundsOf), :900; physconst.js:6 (KILL_MARGIN); spawn.js:49 (belowWorld)
- **Tests:** climb-env K8 (climb-env-check.ts:170 arrivals), K9 (:183 KillZ), K9b/K9c/K9d (:236-261), K9h/K9p (:202,:218), K10 (:274 sky gradient), K12 (:292 flat terrain), K13 (:305 KillZ is the authority's); water-import G3e (import-golden-check.ts:49 environment), G4f (:84 floor is the ground); translate DT8 (translate-check.ts:250: motes count/range/colour in a derived dust document; past the limits clamped and carried); importer IM-E1 (importer-check.ts:307) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: climb-env, importer, translate, water-import
- **Changed since 72847d01d:** partial → restored: motes carry main's count/range/colour again (6293438e6, translate DT8, water-import G3e/G4, importer IM-E1; decision row 8, our side only). Stage box for bounds-less old worlds (3eb5c51c1; decision row 24 ruled yes). KillZ margin 50 m (d08745574, e8308f061; climb-env K9*/K13). Camera-follow still absent and named.
- **Commits:** 6293438e6, 3eb5c51c1, 6616997af, dc1b944fc, d08745574, e8308f061
- **Note:** Floor/spawn/bounds/sky: restored. Motes: count, range and colour now ride in a derived dust document (6293438e6, decision row 8; clamped 600 / 32 m, over-limit carried + listed); camera-follow remains the one named residual (the field anchors to the thing). Stage island: v4 worlds have no edge without bounds; an old world with neither bounds nor terrain gets @world.bounds x/z ±78 m, y −2..60 m (3eb5c51c1; decision row 24, ruled yes). KillZ moved to 50 m under bounds.min.y (d08745574, e8308f061).
- **Verified this run:** Opened: main watervolumes.js:86-119,276,326-336; v4 componentspec.js:501-505,536-551; translate-v1.js:126-133,317,379-422,466-486,893-900; physconst.js:6 and spawn.js:2-8,49 (grep); climb-env-check.ts rows :170-305; import-golden-check.ts:49,84; translate-check.ts:11,250-256; importer-check.ts:20,307,325. dc1b944fc not opened beyond the commit list. Agent KillZ line not re-pinned. Suites NOT run (node_modules missing).

### [14] Swim float depth and dive threshold

**intentional-change** · decision row 7

- **Lean / ruling:** decision row 7: the lead ruled 10-30 'keep v4's single float depth (fixes main's 17.5 cm jump)'; Antra's ruling column empty → still a proposal. Antra's gate names 'swimming/buoyancy/body-state behavior' explicitly.
- **Implementation (v4):** shared/mover.js:63 (at: 0.75 of body height = 1.275 m at 1.7), :70 (latch .12), :72 (deep 1.3 × at ≈ 1.66 m before a dive), :183 floatDepth = at × height (one number for waterStance, stepSwim's latch and the dive handover)
- **Migration:** n/a (no stored field)
- **Browser:** controller uses floatDepth; yawed non-square body now turns with host
- **Agent:** agent walker uses the same mover law (agent.ts:2773 waterStance)
- **Vocabulary:** —
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending (feel)
- **Evidence — main:** shared/water.js:84 (root floats 1.1 m × stature under the surface), :86 (latch .12); mcpl/agent.ts:11 (SWIM_SPEED via terrainshape)
- **Evidence — v4:** shared/mover.js:63 (at 0.75), :70 (latch .12), :72 (deep 1.3), :181-183 (floatDepth; comment: upstream floated its root 1.1 m under for a 100% body); mcpl/agent.ts:2773
- **Tests:** mover-check (rows not printed individually); water-vectors --check (re-baselined to v4's numbers, so they prove consistency, not parity with main). NOT RUN this run
- **Changed since 72847d01d:** Grade unchanged; the ruling is now recorded in the decision table (row 7, our side 10-30; Antra empty). mover.js commits since 72847 (3eb5c51c1/f63c65646 added the water's drag; c04cb7b3a removed it) don't touch these lines.
- **Commits:** f63c65646, 3eb5c51c1, c04cb7b3a
- **Note:** Water 1.3–1.66 m deep floats you but won't let you dive (INDEX #14) still true at the head. mover.js was touched since 72847 (3eb5c51c1, f63c65646 added swimDrag/swimThick for the water's drag; c04cb7b3a removed them — stepSwim :192-208 now takes water.factor, a physics-area's ×) but the float/latch/deep numbers (:63, :70, :72) are unchanged.
- **Verified this run:** Opened: main water.js:72-88; main agent.ts:11 (grep); v4 mover.js:58-72,171-198 (grep -n); v4 agent.ts:41,2771-2775. DECISIONS-260.md row 7 read. Suites NOT run. AMENDMENT (c04cb7b3a): mover.js:58-72,171-209 re-opened; at/latch/deep unchanged.

### [50(B8)] Per-volume swim speed (`water.speed`)

**restored** · decision row 27

- **Lean / ruling:** decision row 27 (our side: ruled 10-28 'de-spaghettify', reaffirmed 10-30; Antra's ruling column empty → still a proposal): there is one way an area changes how fast a body moves, physics-area {kind: speed, factor} on a zone (Unreal's per-volume MaxWalkSpeed, Roblox's per-zone WalkSpeed); a pond is zone + water + physics-area, water stays about water. translate-v1@35 (c04cb7b3a) writes main's water.speed as that factor; the @31-@34 interim water.drag (3eb5c51c1, f63c65646, b3984c665) is undone with no compatibility shim (only test or scratch worlds carried it; nothing was merged). The e1f21 lean's 'superseded ruling, no decision-table row' no longer applies.
- **Implementation (v4):** shared/protocol/componentspec.js:589-594 (physics-area {kind: speed, factor}: range 0.05..10 :590, absent 1 :591, docs :593 '× a body's own speed inside (walking, running, wading, swimming): < 1 slows, > 1 boosts; the authority's track widens inside a boost, never narrows'), :570 (water help: 'How fast a body moves in it is a sibling physics-area {kind: speed, factor}'); shared/mover.js:192-208 stepSwim (:195 speed = water.speed × areaFactor(water.factor) × (fast ? 1.65 : 1); :200 eases at MOVER.swim.ease 5 /s :71), :186 areaFactor, :151 the track widens inside a boost and never narrows; shared/zone.js:41-52 physicsAreasOf, :56-58 speedFactorAt; client/lib/controller.js:28 (imports speedAt), :693 (the 3D stroke's input carries factor: speedAt(myState.pos)); shared/protocol/authority/bodyverbs.js:103-104 (the track × speedFactorAt where the step starts or ends); server/render-scene.ts:94-95 (k = the zone's physics-area factor → speed = waterParams({}).speed × k). GONE at c04cb7b3a: mover swimDrag/swimThick and stepSwim's drag, client water.js waterDrag, bodyverbs thickAt/watersOf, componentspec water.drag.
- **Migration:** waterOfOld translate-v1.js:442-443: f = waterParams({speed}).speed / waterParams({}).speed (= speed/2.4, clamped .05-10); area = {kind: 'speed', factor: f} unless \|f − 1\| ≤ SPEED_NEAR 0.05 (:450), then dropped and said in the report (:447, 'within 5%'); volumePartsOf :457-459 puts the area beside zone+water on the thing or on the water child. 1.2 → 0.5, 6 → 2.5, 0.5 → 0.2083; a main speed under 0.12 m/s swims at 0.12 (the factor's 0.05 floor). The report's speed entry is {physics-area} or {dropped} (:447).
- **Browser:** unverified in a browser (not run); the client path is read: controller.js:693 passes factor: speedAt(myState.pos) into mover stepSwim; the level stroke and wading take env.speedAt (stepWalk)
- **Agent:** mcpl/agent.ts speedAt (:1706: physicsAreasOf + speedFactorAt) feeds its walk (:2716) — the same areas water.speed now writes, so an agent wading a translated pond is slowed too. Not a parity gap against main's agent, which read only the world level (agent.ts:11). No drag reader (there is no drag to read).
- **Vocabulary:** physics-area {kind: speed, factor ×} (Unreal per-volume MaxWalkSpeed, Roblox per-zone WalkSpeed); water.drag GONE (spec/REGISTRY-CHANGELOG.md 2026-10-30); no swimSpeed field
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending
- **Evidence — main:** shared/water.js:12 (speed clamp .1-20, default 2.4), :74 (stroke speed × 1.65 when fast)
- **Evidence — v4:** translate-v1.js:125 (TRANSLATOR @35), :126-127 (@35 note), :429 (VOLUMES.water), :438-450 (waterOfOld, SPEED_NEAR), :453-460 (volumePartsOf); componentspec.js:570, :589-594; mover.js:71, :151, :186, :192-208; zone.js:41-58; bodyverbs.js:103-104; render-scene.ts:94-95; client/lib/controller.js:28, :693; docs/TRANSLATING-OLD-WORLDS.md, spec/PROTOCOL.md §14 (@35, 'scales walking and wading there too'), tools/water/README.md, spec/kernel-pin.json (@35), spec/REGISTRY-CHANGELOG.md (2026-10-30: water.drag gone)
- **Tests:** water-import G4s (import-golden-check.ts:136-147: a translated pond (volumePartsOf) swum as the client does — zone.js waterVolumes, speedFactorAt at the swimmer, stepSwim — reaches main's swimStep speed to 1e-9 m/s at 1.2, 6 and 0.5, Shift too; 2.4 and 2.45 write no area and swim within 5%; no drag field :144), G1 (:30-32: 2.4 → no physics-area written); translate F51 (translate-check.ts:184-189: speed 1.2 → physics-area {kind: speed, factor: 0.5} on the zone and in the report; 2.45 dropped and said; no 'drag' in the output), F50 (:164-171: the report text names the factor :169; its title :171 still says '(@31)' — wording only), V5 (:216-224: translator @35; a report reviewed under @34 refused); render-scene-import R1 (render-scene-import-test.ts:26-28: speed 1.2 round-trips through the zone's factor; the comment now says 'translate-v1@35' — the e1f21 stale-wording finding is closed); physics-area A3 (physics-area-check.ts:112-121: :117 stepSwim eases toward factor × 2.4; mutant :20 'the 3D stroke ignores the area' → A3 red). Mutants the commit reports (each file restored after): stepSwim ignores the area → G4s, A3; translator writes no area → G4s, F51, R1; writes a drag beside it → G4s, F51; ignores the 5% band → G4s, G1, F50, F51; render-scene k = 1 → R1 (2.4 vs 1.2) · RUN 10-30 (lead) at e1f21cc9a: physics-area, translate, water-import lanes green (suite-runs.log) · RE-RUN at c04cb7b3a (<local worktree>, BUN_RUNTIME_TRANSPILER_CACHE_PATH=0): water-import 15 passed, 0 failed (G1, G4s ok); translate 44 passed, 0 failed (F50, F51, V5 ok); render-scene-import 19 passed; physics-area 5 passed, 0 failed (A3 ok). Mutants not re-run.
- **Changed since 72847d01d:** Grade unchanged (restored). At e1f21cc9a the mechanism was water.drag (3eb5c51c1 translate-v1@31; f63c65646 thin-water track widening; b3984c665 render-scene inverting drag), superseding the item-50 ruling with no decision-table row. AMENDED at c04cb7b3a (translate-v1@35): back to physics-area {kind: speed, factor: speed/2.4} on the water's zone, as the lead's 10-28 item 50 said and decision row 27 now records; water.drag removed everywhere, no shim; G4s/G1/F50/F51/R1 titles follow. Known: the area also slows walking and wading on that floor, where main changed only the swim (as at @29).
- **Commits:** 3eb5c51c1, f63c65646, b3984c665, c04cb7b3a
- **Note:** Mechanism at c04cb7b3a: speed → physics-area {kind: speed, factor: speed/2.4} (translate-v1@35); the @31-@34 drag is undone. Plainly: a translated pond's speed area also slows walking and wading on its floor (componentspec :593 'walking, running, wading, swimming'; mover stepWalk takes env.speedAt), where main changed only the swim — the e1f21 note's 'closer to main' point for drag is reversed on purpose: the lead chose one mechanism over the closer match (decision row 27). The e1f21 finding on render-scene-import-test.ts:26-28's stale wording is closed (the comment says physics-area, @35). Residual wording: translate-check.ts:171 F50's title still says '(@31)'. PR body L93 / L125 / L168 / line 219 may say physics-area again (BODY-DIFF item 1).
- **Verified this run:** At e1f21cc9a: main water.js:7-16,72-88; v4 translate-v1.js:126-137,425-449; componentspec.js:555-595; mover.js:183-198 (grep); bodyverbs.js:4,34 (grep); zone.js:39-62,71-76; render-scene.ts:72-105; import-golden-check.ts:30,142; translate-check.ts:7,163-170; render-scene-import-test.ts:3,21-36; physics-area-check.ts:19-25,90-113; suites.ts:37; agent.ts:117,1706 and grep for drag (none). AMENDMENT at c04cb7b3a (<local worktree>; `git show c04cb7b3a` read in full): translate-v1.js:120-140,425-460; mover.js:58-72,106-120,151,171-209 (grep + sed); componentspec.js:555-594; zone.js:39-58,69-81,96; bodyverbs.js:100-110; render-scene.ts:88-100; controller.js:28,693 (grep) and the client water.js / controller.js diff; agent.ts:1706,2716 (grep); import-golden-check.ts:30-32,136-147; translate-check.ts:7-14,163-189,215-224; render-scene-import-test.ts:1-36; physics-area-check.ts:19-24,112-121; REGISTRY-CHANGELOG tail; PROTOCOL / TRANSLATING-OLD-WORLDS / tools/water/README / kernel-pin diffs; main water.js:7-16,74 at ccd5c53fa. DECISIONS-260.md row 27 read. Four suites re-run (tests).

### [50(B9)] Vehicle minY/maxY clamps and hull probes

**intentional-change**

- **Lean / ruling:** ruled by the lead 10-28 11:33 item 50 (probes retired, minY/maxY → collision layers + walls, explain in the PR); no decision-table row. Since @32 (24cac47b3) the two walls are in the vehicle's own Godot collision layer and only that hull's mask scans it (D25): another vehicle passes the band.
- **Implementation (v4):** translate-v1.js:332-346 vehiclePartsOf (walls :337-339: hidden, clickthrough, locked, collider {shape box, blocks ['hulls'], layer [bandLayerOf(host)]}; host mask [1, band] :345), bandLayerOf :348, hullExtentOf :350-354, WALL_SPAN 200 km / WALL_T 10 m :357; componentspec.js:61-70 collider.blocks/layer/mask; shared/protocol/authority/drive.js:32 hullHit (the hull sweep replaces probes), :41-42 (hull-only walls met through solidOff by mask)
- **Migration:** minY/maxY → walls at [0, y, 0] spanning 200 km, locked, offset by the hull's measured box (an unmeasurable hull: walls at minY/maxY themselves), each in the vehicle's own band layer; probes → imported:vehicle, listed with its fate (:531 fatesOf)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** not in drive (marked non-OMI); collider {blocks, layer, mask} (Godot's collision_layer/mask)
- **Specimen:** world-data/water (#248, public) + fixtures/water-old-v1; world A / world B private, pending
- **Evidence — main:** client/lib/vehicles.js:60-62 (y clamped to minY/maxY), :63-70 (five hull probes, raySegment)
- **Evidence — v4:** translate-v1.js:332-357 (vehiclePartsOf, bandLayerOf, hullExtentOf, WALL_SPAN); componentspec.js:61-70; shared/protocol/authority/drive.js:32,41-42
- **Tests:** drive D15 (drive-check.ts:280), D16 (:288), D17 (:294), D25 (:324: the translator's band; a second hull climbs past it), D26 (:332), D27 (:341); water-import G4w (import-golden-check.ts:106), G4o (:129); translate F50 (translate-check.ts:163: walls 'in the vehicle's own layer, which its mask scans (@32)'), F50b (:172), F50c (:177), V7 (:234) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: drive, translate, water-import
- **Changed since 72847d01d:** Grade unchanged; evidence changed: walls banded per vehicle through collider.layer/mask (24cac47b3, translate-v1@32; drive D25-D27; F50 title updated).
- **Commits:** 24cac47b3, c3800f7a7, 3eb5c51c1
- **Note:** PR line 219 states it. Not stated in the PR: probes are retired (only the translator report says so). New since 72847: per-vehicle band layers (24cac47b3) — the old 'hull-only wall' stopped every hull; now only its own.
- **Verified this run:** Opened: main vehicles.js:55-70; v4 translate-v1.js:332-357; componentspec.js:58-70; authority/drive.js:11,32,41-42; drive-check.ts:40-48 mutants and rows :280-341; import-golden-check.ts:106,129; translate-check.ts:7-9,15,162-244. Suites NOT run. Lean rewritten to 'the lead'.


## Unreal / native client (#248) (9 rows)

### [5,C6] Unreal native client: render-scene projection served + native join

**absent** · decision row 22

- **Lean / ruling:** decision row 22: our side leans restore (10-29) through a client-side bridge offered as a PR on the Unreal repo; Antra to choose wait-or-merge; ruling column empty
- **Implementation (v4):** server/server.ts:809-810 ('no renderSceneVersion: upstream #248's render-scene projection isn't served here'), :1015-1017 (join without replica:true on the world surface → noFoldRefusal, close 4005), :1021 (c.replica); server/render-scene.ts:72-105 exists and projects v4 zone+water (:91-96; speed from the zone's physics-area factor :94-95, c04cb7b3a) / water-exclusion (:97-98) / drive (:99-100) / climb / collider back to main's shapes, PASS_THROUGH only environment (:73), but nothing serves it (suites.ts:203 'nothing serves it')
- **Migration:** n/a
- **Browser:** —
- **Agent:** old/non-replica agents refused at join; a native session's refusal text says so (noFoldRefusal, server.ts:1016 isNativeSession)
- **Vocabulary:** renderSceneVersion absent
- **Specimen:** none named yet (#248's native half)
- **Evidence — main:** server/server.ts:762 (renderSceneVersion: 1 in the snapshot), server/render-scene.ts:71 (PASS_THROUGH environment/vehicle/traversal/collision), :96-99 (water, air)
- **Evidence — v4:** server/server.ts:805-816 (buildSnapshot, :809 comment), :1015-1021; server/render-scene.ts:72-105; tools/protocol/suites.ts:203
- **Tests:** render-scene-import (suites.ts:203; render-scene-import-test.ts R1 :3-36, links + projection; water.speed from the zone's physics-area factor again since c04cb7b3a (:26-28), from drag between b3984c665 and 8ab3324bf) in the gate — NOT RUN at e1f21cc9a · RE-RUN at c04cb7b3a (<local worktree>): render-scene-import 19 passed
- **Changed since 72847d01d:** Grade unchanged; evidence: render-scene.ts derived speed from drag (b3984c665) and derives it from the zone's physics-area factor again at c04cb7b3a (:94-95); line numbers re-pinned (snapshot :805-816, refusal :1015-1021; render-scene water :91-96).
- **Commits:** b3984c665, c04cb7b3a
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22). PR line 27 is still accurate. Since 72847: render-scene.ts read native water speed from the water's drag (b3984c665), and from the zone's physics-area factor again at c04cb7b3a (:94-95); nothing else moved.
- **Verified this run:** Opened: v4 server.ts:805-816,1013-1021 (sed/grep); v4 render-scene.ts:52,72-105 (grep + sed 88-99); suites.ts:203; render-scene-import-test.ts:3,21-36; main server.ts:760-763; main render-scene.ts:69-100. Suite not run. Bridge repo not opened. AMENDMENT (c04cb7b3a): render-scene.ts:88-100 and render-scene-import-test.ts:1-36 re-opened; render-scene-import re-run, 19 passed. server.ts not re-opened (the commit does not touch it).

### [248-join] #248 native: join (main's wire, no `replica`)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge in a separate repo; Antra's ruling empty)
- **Implementation (v4):** server/server.ts:1015-1017 refuses a join without replica:true on the world surface with noFoldRefusal, close 4005 'this client doesn't fold the log'; :1021 c.replica
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** server/server.ts (main join: no replica flag required; 'replica' not found in main's server.ts by grep this run)
- **Evidence — v4:** server/server.ts:1015-1021
- **Tests:** refusedjoin (suites.ts:101, browser lane) NOT RUN here
- **Changed since 72847d01d:** none (line numbers re-checked: :1015-1021 unchanged)
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 server.ts:1013-1021; main server.ts grep for 'replica' (no hit); suites.ts:101. Not run.

### [248-replica] #248 native: replica / fold on the client

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** shared/protocol/replica.js is JS (exists: ls); no Plugins/ directory in the tree (ls: no such file)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** n/a (main's native client read render-scene, not a log)
- **Evidence — v4:** shared/protocol/replica.js exists; no Plugins/Eidoverse (ls)
- **Tests:** n/a
- **Changed since 72847d01d:** none
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** ls of shared/protocol/replica.js and Plugins/ in wt-s-int this run.

### [248-snapshot] #248 native: snapshot (`cut`, `declares` vs `agent` flag)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** server/server.ts:805-816 buildSnapshot (the authority's cut + who's present; :809-810 no renderSceneVersion)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** server/server.ts:757 buildSnapshot, :762 renderSceneVersion: 1
- **Evidence — v4:** server/server.ts:805-816
- **Tests:** n/a
- **Changed since 72847d01d:** none (line numbers re-pinned: buildSnapshot :805, comment :809-810)
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 server.ts:805-816; main server.ts:757-763 (grep + sed).

### [248-log] #248 native: log stream (typed, batched entries)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** v4 streams log entries to replicas only (server.ts:1015-1021: a non-replica join is refused)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** main's native client took render-scene deltas (server.ts:762 renderSceneVersion)
- **Evidence — v4:** server/server.ts:1015-1021
- **Tests:** n/a
- **Changed since 72847d01d:** none
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 server.ts:1013-1021; main server.ts:762.

### [248-writes] #248 native: writes ({type: request, id, verb, args} with a reply)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** server/requestwire.ts:1-4 (request {type, id, verb, args} → reply {type, id, verb, ok, reply})
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** main: {type:'verb'} messages (server.ts:135 'grant' verb handling seen)
- **Evidence — v4:** server/requestwire.ts:1-4
- **Tests:** n/a
- **Changed since 72847d01d:** none
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 requestwire.ts:1-4,38-42; main server.ts:135 (grep).

### [248-roles] #248 native: roles (`roles:<id>` components, `@world.access`)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** shared/protocol/roles.js exists (ls); the old cite 'requestwire.ts:40 access-directory routed' has drifted: :40 is now whois's doc comment, and 'access-directory' appears nowhere in server/*.ts (grep this run)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** main: grant verb (server.ts:135) + access-state/access-directory messages (not re-located this run)
- **Evidence — v4:** shared/protocol/roles.js exists; server/requestwire.ts:38-42 is whois; no 'access-directory' string in server/*.ts
- **Tests:** n/a
- **Changed since 72847d01d:** Grade unchanged; evidence drifted: requestwire.ts:40 no longer routes access-directory (string absent from server/*.ts).
- **Commits:** none
- **Note:** ABSENT in the PR tree. a client-side bridge exists outside this repo (decision row 22). Evidence correction: the access-directory route cited at 72847 is not in server/*.ts at this head.
- **Verified this run:** Opened: v4 requestwire.ts:38-42; grep access-directory/access-state over server/*.ts (no hit); ls roles.js. Did not trace where the access directory moved.

### [248-capture] #248 native: capture / capture-result (was `snap`)

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** server/screenshots.ts:1 (ephemeral screenshot broker), :312 sends {type: 'capture', id, follow, view, 960×540} to a renderer; server/messages.ts:422 capture-capabilities → screenshots.configure (kept as main had it, PR line 27)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** main: snap (not re-located this run)
- **Evidence — v4:** server/screenshots.ts:1,79,312; server/messages.ts:422
- **Tests:** n/a
- **Changed since 72847d01d:** none (line numbers pinned: screenshots.ts:312, messages.ts:422)
- **Commits:** none
- **Note:** ABSENT in the PR tree for a native client. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 screenshots.ts:1-3 and grep :79,:312; messages.ts:422 (grep).

### [248-pose] #248 native: pose (`pose.anim`, was `emote`); presence q/locomotion kept

**absent** · decision row 22

- **Lean / ruling:** decision row 22 (bridge; Antra's ruling empty)
- **Implementation (v4):** PR line 27: pose.anim; presence q/locomotion kept. In the tree: station.anim (componentspec.js:174-176, sit/ride/drive → sitchair); the literal 'pose.anim' was not found in componentspec.js by grep this run
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** main: emote in pose (server.ts:163 comment on emote replay)
- **Evidence — v4:** componentspec.js:174-176 (station anim); 'pose.anim' not grepped in componentspec.js
- **Tests:** n/a
- **Changed since 72847d01d:** none
- **Commits:** none
- **Note:** ABSENT in the PR tree for a native client. a client-side bridge exists outside this repo (decision row 22).
- **Verified this run:** Opened: v4 componentspec.js:173-176 (grep); main server.ts:163 (grep). The wire-side pose.anim field was not traced.


## Consent & bodies (6 rows)

### [15] Body consent: Move me / Touch me + allow/block, ask removed, main opt-out migration

**restored** · decision row 4

- **Lean / ruling:** ruled: decision row 4 (two switches + lists, ask removed) — our side yes 10-28, Antra's ruling column EMPTY (still a proposal). Migration-never-widens ruled a4ed40a35.
- **Implementation (v4):** shared/protocol/consent.js:15 GATES move/touch, :17 DEFAULT_GATES {move:true, touch:false}, :67-72 worldGates (refuse/ask → both off, accept → move on), :76-85 decide (block > allow > gate > world body-default > DEFAULT_GATES), :96 RETIRED_CONSENT, :98 LIST_MAX 1024 (:111 bounds refusal names unlist), :134 migratePresence; client/lib/consent.js:39-55 readStored (:49-53 ew-body-switch / ew-pushable / ew-posable: posable '1' → touch false + notice), :67 takeNotice, :72-76 gate in force; shared/protocol/authority/storage.js:56 migratePresence at load; server/livehost.ts:257 CONSENT_FILE consent.json, :276 writePrivate 0600
- **Migration:** n/a: opt-outs are browser localStorage; server tables migrate at load (storage.js:56), not translate-v1. Browser migration never widens: ew-posable '1' now leaves Touch me OFF and says so once (client/lib/consent.js:52-53)
- **Browser:** stored ew-pushable/ew-posable not read; /pushable help says off
- **Agent:** act shove obeys target's switch
- **Vocabulary:** consent switch accept\|ask\|refuse
- **Specimen:** none named yet
- **Evidence — main:** client/lib/consent.js:24-26 (ew-pushable localStorage, pushable()/setPushable)
- **Evidence — v4:** shared/protocol/consent.js:15,17,67-72,76-85,96,98,111,134; client/lib/consent.js:39-55,67,72-76; shared/protocol/authority/storage.js:56; server/livehost.ts:257,276
- **Tests:** consent-client (tools/consent-client-test.ts:62-77 migration table: :72 'main posable on → Touch off (never wider)', :78 never-present key = never chosen, :83-84 notice only where posable on was not carried, :226-233 '1.3 … the gate in force'); consent (tools/protocol/consent-check.ts:37 C9c ew-pushable kept, :53-69 C11 block survives restart, consent.json 0600 POSIX-only); gates (tools/protocol/gates-check.ts:16-34 G1-G6, L1-L6, W1-W2); installing would write into the READ-ONLY tree) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: consent-client, force
- **Changed since 72847d01d:** grade kept restored (the sub-auditor proposed intentional-change; the lead overruled: main's shape IS two switches, pushable/posable, and the removed `ask` tier was v4's own addition, not a main feature — so against main this row is a restoration; the per-person lists and the removal of ask are the part decision row 4 puts to the owner). Evidence: migration now never widens — ew-posable '1' leaves Touch me off and tells the person once (a4ed40a35), retiring the old note that it widened; Settings switches show the gate in force (1d84b9ab2); lists hold 1024 (e42d3d080); the live host keeps gates/lists across a restart in consent.json 0600 (45b1049cb, C11; e70ae9ed8 POSIX-only); a consent list naming a script reaches the authority (9c30e6416). Lines re-opened: decide :76-85, readStored :39-55.
- **Commits:** a4ed40a35, 1d84b9ab2, e42d3d080, 45b1049cb, e70ae9ed8, 9c30e6416, 263eb252b, 4a97e42bf
- **Note:** Old note's 'ew-posable 1 migrates to Touch ON (widens)' is FIXED at head (a4ed40a35): touch false + one-time notice (consent-client-test.ts:72,78,83). Decision row 4 (lists + ask removed) still lacks the owner's ruling; the two-switch shape itself is main's.
- **Verified this run:** Opened: v4 shared/protocol/consent.js:15-17,42,60-92,96-111,134; client/lib/consent.js:14-27,39-55,67-76; storage.js:12,55-56; livehost.ts:19,257,271-276; tools/consent-client-test.ts:60-84,151-155,226-233; tools/protocol/consent-check.ts:37,53,69; gates-check.ts:16-34; main client/lib/consent.js:22-26. 9c5ae2726 checked: photo-mode-at-helm, unrelated to consent. No suite run (see tests). browser/agent/vocabulary carried forward unchecked.

### [N1] refused shove/pose tells the target

**restored**

- **Lean / ruling:** ruled: the lead 13:03 no notice on migration (N1 routed to consent build)
- **Implementation (v4):** shared/protocol/authority/bodyconsent.js:36-41 body-refused {from, class, gate} pushed to the target's inbox, once per (asker, target) per C.TRIED_NOTE_MS; shared/protocol/consent.js:42 TRIED_NOTE_MS = 60000; client/lib/bodyact.js refusedNotice words it (asserted at consent-client-test.ts:151-155)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main 'X tried to knock you over', SWEEP-3 N1; bodyconsent.js:36 comment names the parity)
- **Evidence — v4:** shared/protocol/authority/bodyconsent.js:36-41; shared/protocol/consent.js:42
- **Tests:** consent-client (tools/consent-client-test.ts:152-155 'a refused act is said to me in plain words: who, and which of my switches turned it away'); force F10 (tools/protocol/force-check.ts:160 'a refused body hears body-refused … once per asker per TRIED_NOTE_MS'; mutant :30) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: consent-client, force
- **Changed since 72847d01d:** none (grade and code unchanged; wording row moved consent-client-test.ts:133-135 → :151-155)
- **Commits:** none
- **Note:** Old note 'PR line 159 … isn't shown why in the browser yet may be stale' — code at head does show why (refusedNotice, consent-client-test.ts:152); PR text not re-read here.
- **Verified this run:** Opened: bodyconsent.js:36-41, consent.js:42, consent-client-test.ts:151-155, force-check.ts:30,160. git log on bodyconsent.js since 72847d01d: empty.

### [N2] body ranges (pose 10 m, shove/drag 3 m) lifted

**restored**

- **Lean / ruling:** ruled: the lead 13:44 'N2 body ranges → LIFTED'; open to R: BODY_REACH 2 m kept as the authority body verbs' physical reach
- **Implementation (v4):** shared/protocol/physconst.js:22 BODY_RANGE = null, :24 bodyRangeOf(@world.body-default.range), :26 bodyRangeWords; :20 BODY_REACH = REACH + 0.5 kept at bodyconsent.js:136,149 for authority body {kind: shove\|drag\|carry}
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main: unlimited, SWEEP-3 N2)
- **Evidence — v4:** shared/protocol/physconst.js:20,22,24,26; shared/protocol/authority/bodyconsent.js:136,149
- **Tests:** physconst (tools/physconst-test.ts:113 BODY_REACH/SHOVE_REACH/BODY_RANGE null/bodyRangeOf); reachgate RR1 (tools/protocol/reachgate-check.ts:252 'no range by default … from 30 m', :246 30 m apart) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: physconst
- **Changed since 72847d01d:** none in grade; line drift only (BODY_RANGE :21→:22, bodyRangeOf :23→:24) from e8308f061 (KILL_MARGIN added to physconst)
- **Commits:** e8308f061
- **Note:** authority body {kind: shove\|drag\|carry} still refuses beyond BODY_REACH (bodyconsent.js:136,149) — a reach, not a range; unchanged.
- **Verified this run:** Opened: physconst.js:1-30, bodyconsent.js:6,136,149, physconst-test.ts:113, reachgate-check.ts:246-255.

### [N3] punt reach 2.5 m, one place

**restored**

- **Lean / ruling:** ruled: the lead 13:44 'N3 punt reach → 2.5 m, every help/check reads ONE place'
- **Implementation (v4):** shared/protocol/physconst.js:8 KICK = {reach: 2.5, below: -0.5, above: 2.0, lift: 0.9} ('the lead 10-28: 2.5 m, main's; the one copy')
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main 2.5 m, SWEEP-3 N3)
- **Evidence — v4:** shared/protocol/physconst.js:8
- **Tests:** physconst (tools/physconst-test.ts:115 'B KICK'; :120-124 'B a punt's reach is KICK.reach only: no other file states a punt distance') · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: physconst
- **Changed since 72847d01d:** none in grade; KICK moved :7→:8 (e8308f061)
- **Commits:** e8308f061
- **Verified this run:** Opened: physconst.js:8, physconst-test.ts:115,120-124.

### [16] Punt any thing

**intentional-change**

- **Lean / ruling:** ruled: R 2026-10-08 'punted → dynamic' (tools/protocol/import-v1/translate-v1.js:932,944)
- **Implementation (v4):** shared/protocol/verbspec.js:74 punt: only physics {kind:'dynamic'}, needs the world to run an engine; args id, power, v, contact
- **Migration:** tools/protocol/import-v1/translate-v1.js:944-949 puntedLives: things a v1 log ever punts come across dynamic, every other collider static (:230 comment)
- **Browser:** /punt thing refused otherwise
- **Agent:** punt refused no-physics
- **Vocabulary:** physics {kind:'dynamic'}
- **Specimen:** none named yet
- **Evidence — main:** server/verbs.ts:365-367 vPunt (any {id, dir?, power?})
- **Evidence — v4:** shared/protocol/verbspec.js:74; tools/protocol/import-v1/translate-v1.js:932,944-949
- **Tests:** directory (tools/protocol/directory-check.ts:404-410 out.kinds: punted → dynamic, others static, per fixture) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: directory
- **Changed since 72847d01d:** grade unchanged; evidence: translate-v1.js moved to tools/protocol/import-v1/ (puntedLives :944, comment :932; old row's :872/:884 are gone), and the translation half now has a named check (directory-check.ts:404-410 out.kinds), so the old 'unverified for the translation half' note is retired
- **Commits:** none
- **Note:** directory-check's kinds assertion runs over the private fixtures (world A / world B) — suite not run here.
- **Verified this run:** Opened: v4 verbspec.js:74; translate-v1.js:223-230,932,944-952; directory-check.ts:402-412; main server/verbs.ts:363-367. git log on verbspec.js since 72847d01d: empty (translate-v1.js path moved before 72847d01d; not in the window).

### [21] Kick default

**restored** · decision row 5

- **Lean / ruling:** ruled: decision row 5 (our side yes 10-28: kick = out now, may rejoin at once; Antra's ruling EMPTY)
- **Implementation (v4):** shared/protocol/verbspec.js:82 kick {who, minutes (doc: refused), reason}; shared/protocol/authority/moderation.js:71-73 (a.minutes → refuse shape, points at ban {who, days, reason}); shared/protocol/authority/rights.js:51 'A kick is never in force'
- **Migration:** n/a
- **Browser:** /kick
- **Agent:** act kick minutes default 10 (main); v4 mcpl/tools.ts:544 still forwards a.minutes, which the authority refuses
- **Vocabulary:** kick {who, minutes?}
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:130 (kick tool: 'They may rejoin — a kick interrupts, a ban excludes')
- **Evidence — v4:** shared/protocol/verbspec.js:82; shared/protocol/authority/moderation.js:71-73; shared/protocol/authority/rights.js:51; mcpl/tools.ts:544
- **Tests:** identity RS3 (tools/protocol/identity-check.ts:302-308 'a kick: removed now (4006, no until) and back at once; a kick with minutes is refused, pointing at ban'); roles mutant M5 (tools/protocol/roles-check.ts:82 'a kick takes no length'). NOT RUN this pass (runner refuses: dangling node_modules symlink)
- **Changed since 72847d01d:** none (no commits on verbspec/moderation/rights/worldlog/peer since 72847d01d). The cooldown comments the old row flagged still linger: server/worldlog.ts:417 '/** A kick whose cooldown still runs … */' and server/peer.ts:4 'kick cooldown' — 263eb252b did not touch them
- **Commits:** none
- **Note:** leftovers unchanged: mcpl/tools.ts:544 forwards a.minutes (authority refuses it, fine); server/worldlog.ts:417 and server/peer.ts:4 still speak of a kick cooldown (stale comments; the kick-cooldown record reader at worldlog.ts:417 may be dead code — not traced here).
- **Verified this run:** Opened: v4 verbspec.js:82, moderation.js:68-76, rights.js:49-53, mcpl/tools.ts:529-532,544, worldlog.ts:417, peer.ts:4, identity-check.ts:302-308, roles-check.ts:80-84; main mcpl/tools.ts:130. Old row's main pointer 'tools.ts:117' is not the kick tool on main (:117 is a comment); main's kick tool is :130.


## Agents (MCPL) (11 rows)

### [44,A3] world_verb + main's old verb names

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'world_verb removed, old verbs refused naming the replacement (44)' (the lead 10-27); no decision-table row
- **Implementation (v4):** mcpl/tools.ts:1646-1650 TOOL_REMOVED {world_verb, whisper}, :1675 refusal 'was removed: … — nothing ran'; shared/protocol/verbspec.js:146- REMOVED_VERBS (whisper + old verbs, each with fix); shared/protocol/authority.js:131 refuse 'removed' before did-you-mean (:133); mcpl/tools.ts:1626-1629 TOOL_RENAMED_UNTIL 2026-12-01
- **Migration:** n/a (no stored data)
- **Browser:** —
- **Agent:** world_verb → 'removed' with act {verb, args}; act {verb: <old>} → 'removed' naming the exact call; help {verb} says the same
- **Vocabulary:** REMOVED_VERBS: whisper + the 14 old verbs
- **Specimen:** none needed (no stored data)
- **Evidence — main:** mcpl/tools.ts:126 (world_verb: 'Raw world-log verb. The verb set is CLOSED by design — say, use, punt, force, mount, dismount, spawn, place, remove, light, comp, motion, behavior, asset, terrain, grass, sky, weat…')
- **Evidence — v4:** mcpl/tools.ts:1626-1629,1646-1650,1675; shared/protocol/verbspec.js:146-147; shared/protocol/authority.js:131-133
- **Tests:** alias (mcpl/alias-test.ts:24-27 'world_verb is refused as removed, naming act'; :29-31 every MAIN_TOOL served/taught/folded/removed); agenttools AT9 (tools/protocol/agenttools-check.ts:370 'world_verb is refused as removed, naming act') · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools, alias
- **Changed since 72847d01d:** none in grade or behaviour; line drift in mcpl/tools.ts (TOOL_REMOVED 1645→1646, TOOL_RENAMED 1623→1626) from fc183b4f3/52ea73571/e1f21cc9a, none of which touch these tables. e1f21cc9a (worlds tool) does not change MAIN_TOOLS or the alias rows.
- **Commits:** fc183b4f3, 52ea73571, e1f21cc9a
- **Note:** PR-body staleness noted in the old row not re-read here. 'taught until 2026-12-01' covers TOOL_RENAMED only; TOOL_REMOVED has no end date (unchanged).
- **Verified this run:** Opened: v4 mcpl/tools.ts:1626-1650,1673-1678; verbspec.js:146-147; authority.js:129-133; alias-test.ts:4,16,20-31; agenttools-check.ts:19,370; main mcpl/tools.ts:126.

### [G6] hidden tool aliases (walk_to, spawn, snapshot, check_model, pose, animate, emote, posture)

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS the lead 13:44 'G6 aliases → drop now, refuse-and-name-the-new-tool for one release, then delete the education'; no decision-table row
- **Implementation (v4):** mcpl/tools.ts:1626-1629 TOOL_RENAMED (walk_to→move, snapshot→screenshot, spawn→create, check_model→measure, pose/animate/emote/posture→anim; until 2026-12-01); :1676-1677 refusal 'X is now called Y: call Y (… ) — nothing ran'
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** mcpl/tools.ts:126 (main served these names; alias-test MAIN_TOOLS :29)
- **Evidence — v4:** mcpl/tools.ts:1626-1629,1676-1677
- **Tests:** alias (mcpl/alias-test.ts:16 'no old name is taught past its date'; :20-23 '<old> runs nothing and teaches <to>'); agenttools AT9 (tools/protocol/agenttools-check.ts:339 walk_to, :368 spawn 'runs nothing and teaches') · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools, alias
- **Changed since 72847d01d:** none in grade; line drift only (1623-1626 → 1626-1629; 1660-1662 → 1676-1677)
- **Commits:** fc183b4f3, 52ea73571, e1f21cc9a
- **Note:** PR-body claims about aliases still running (old note) not re-read here; code at head still refuses and runs nothing.
- **Verified this run:** Opened: mcpl/tools.ts:1626-1629,1673-1678; alias-test.ts:16,20-23,29; agenttools-check.ts:339,368.

### [45(A2),11] spawn axes, place {x,z,y,yaw}, spawn {query}

**intentional-change**

- **Lean / ruling:** ruled: G6 (drop aliases, refuse-and-name). place old shape: none explicit
- **Implementation (v4):** mcpl/tools.ts:1628 (spawn → 'is now called create'); mcpl/tools.ts:1163-1171 place passes args to the authority as they are; shared/protocol/verbspec.js:15-22 place oneOf PLACE_MODES (id, on, beside, hang, at…); verbspec.js:187 unknown-arg refusal: "place has no argument 'x'", fix "place takes: <every arg incl. at>"
- **Migration:** n/a
- **Browser:** —
- **Agent:** silent arg drops; two calls for query spawn
- **Vocabulary:** place on/beside/at[x,z] + facing
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:822-826 (spawn {lib\|query, x, z} → defaults 2 m ahead)
- **Evidence — v4:** mcpl/tools.ts:1628,1163-1171; shared/protocol/verbspec.js:15-22,187
- **Tests:** agenttools AT9 (tools/protocol/agenttools-check.ts:350-368: spawn {lib,x,z[,yaw]} shapes land via create {model, at}, spawn refused naming create); no row for place {x,z} refusal found · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools
- **Changed since 72847d01d:** none in grade; 8ce290e07 (help/refusal words follow the code) did NOT touch verbspec.js's unknown-arg text: place {x} is still the generic "place has no argument 'x'" + "place takes: id, on, beside, hang, at, …" — `at` appears only in the full arg list, no dedicated pointer. Line drift: spawn rename 1625→1628, place handler 1162→1163.
- **Commits:** fc183b4f3, 52ea73571, e1f21cc9a
- **Note:** place {x,z} refusal is generic unknown-arg; the fix string lists `at` among all args but never says 'x,z → at'. AT9 :350/:356/:359 assertions describe spawn {lib,x,z} 'creates the thing' — read the row body: at head spawn is refused (:368), so :350-366 must be driving create directly with the old shape (not re-traced here; suite not run).
- **Verified this run:** Opened: v4 mcpl/tools.ts:1163-1171,1626-1629; verbspec.js:15-22,185-188; 8ce290e07 --stat (verbspec.js absent); agenttools-check.ts:334-370; main mcpl/tools.ts:822-826.

### [29] catch_up promise vs arrival-only speech

**restored** (was **absent**) · decision row 11

- **Lean / ruling:** decision row 11 (Done fc183b4f3; Antra's ruling EMPTY, 'no' in our-side column = not a parity change needing her yes)
- **Implementation (v4):** mcpl/tools.ts:107 description: 'What was said here while you were not thinking. Speech is arrival-only: it returns chat said since you arrived (a `since` earlier than your arrival gives nothing older; only the owner, operators and readChat holders read further back)…'; handler mcpl/tools.ts:1088-1092; server/messages.ts:82-83 arrival-only pages (readChat wording d04f1a13e)
- **Migration:** n/a
- **Browser:** —
- **Agent:** description now matches arrival-only delivery
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:98 (catch_up: 'What happened in the world while you were not thinking. Returns chat since a point in the world's history…')
- **Evidence — v4:** mcpl/tools.ts:107,1088-1092; server/messages.ts:82-83
- **Tests:** agenttools AT10 (tools/protocol/agenttools-check.ts:71-72 "AT10 catch_up's description says speech is arrival-only: chat since you arrived, no backlog": /arrival-only/, /since you arrived/, !/since a point in the world's history/); mention-delivery-test.ts:136-138 still marker-only · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools
- **Changed since 72847d01d:** grade: absent → restored. fc183b4f3 rewrote the description to say arrival-only and added agenttools AT10; d04f1a13e aligned the readChat wording in messages.ts.
- **Commits:** fc183b4f3, d04f1a13e
- **Note:** The ruling 'arrival-only' is unchanged; what changed is the description no longer promises more than it returns.
- **Verified this run:** Opened: v4 mcpl/tools.ts:107,1088-1092; server/messages.ts:82-83; agenttools-check.ts:21,71-72; main mcpl/tools.ts:98. 'restored' here means main's PROMISE now matches v4's DELIVERY (the tool itself does not restore main's full backlog — speech is arrival-only by ruling the lead 10-18).

### [10] world_debug recorder

**partial**

- **Lean / ruling:** none
- **Implementation (v4):** mcpl/tools.ts:133 (args limit, kinds, script, scripts), handler :1442-1450; server/messages.ts:95-120 (script → kind 'script-log' ring, scripts → kind 'script' roster, else debugLog filtered by kinds); kinds written at head: refused (server/requestwire.ts:146,175), ambiguous (server/worldlog.ts:221), repair-needed / custody (server/worldlog.ts:160 at attach), script, script-log (messages.ts:108,114)
- **Migration:** n/a
- **Browser:** —
- **Agent:** behavior/behaviors args not aliased
- **Vocabulary:** script/scripts
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:129 (args limit, kinds, behavior, behaviors; kinds named: denied verbs, rejected shapes, rate limits, reaction/reaction-skip/reaction-error, script-error/script-pause, spawn-lint, motion-lint)
- **Evidence — v4:** mcpl/tools.ts:133,1442-1450; server/messages.ts:95-120; server/requestwire.ts:146,175; server/worldlog.ts:160,221
- **Tests:** none exists for world_debug kinds/args NOT RUN
- **Changed since 72847d01d:** none in grade; kinds set identical at 72847d01d and head (git grep '\.debug("' both heads: ambiguous ×1, refused ×2; plus repair-needed/custody at worldlog.ts:160 and script/script-log in messages.ts, all present at both heads). Line drift only (handler 1439→1442; messages 96-119→95-120).
- **Commits:** d04f1a13e
- **Note:** main's behavior/behaviors args still not aliased: unknown props ignored silently, the refusal ring returned instead. Old row under-counted the kinds: repair-needed and custody (worldlog.ts:160) were already there at 72847d01d.
- **Verified this run:** Opened: v4 mcpl/tools.ts:133 (schema),1442-1450; server/messages.ts:94-120; git grep debug( at e1f21cc9a and 72847d01d over server/; main mcpl/tools.ts:129.

### [A4,A5,A7] punt {dir}, light keep, shove target trim

**partial**

- **Lean / ruling:** none
- **Implementation (v4):** A4 punt: shared/protocol/verbspec.js:74 args {id, power, v, contact} — `dir` → unknown-arg (:187 generic 'punt has no argument dir', fix lists v); A5: mcpl/tools.ts:1641 TOOL_FOLDS.light → 'create {components: {light: {…}}, at?} (edit {id, set: {"light.intensity": …}} updates one)', keep→important only in create's doc mcpl/tools.ts:115; A7: mcpl/tools.ts:511 String(a.target) untrimmed; server/messages.ts:159 "isn't here to pose" for a shove
- **Migration:** n/a
- **Browser:** —
- **Agent:** three silent or misleading refusals
- **Vocabulary:** keep → important
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:115 (light tool, keep arg); mcpl/tools.ts:340-342 absent() trims the target ('the target is only spaces')
- **Evidence — v4:** shared/protocol/verbspec.js:74,187; mcpl/tools.ts:115,511,1641; server/messages.ts:159
- **Tests:** none exists NOT RUN
- **Changed since 72847d01d:** none in grade or behaviour; 8ce290e07 touched none of these sites (verbspec.js, tools.ts, messages.ts not in its stat). Line drift: TOOL_FOLDS.light 1635→1641, shove target 510→511.
- **Commits:** fc183b4f3, 52ea73571, e1f21cc9a
- **Note:** A4: dir refused generically (fix 'punt takes: id, power, v, contact' — v is named but no 'dir → v' sentence); A5: fold text omits keep→important; A7: untrimmed target, and the wire error still says 'to pose' for a shove.
- **Verified this run:** Opened: v4 verbspec.js:74,185-188; mcpl/tools.ts:115 (create doc, 'important: true means it ALWAYS casts'),506-514,1632-1645; server/messages.ts:159; 8ce290e07 --stat; main mcpl/tools.ts:115,338-342.

### [A6] /upload?as=script

**intentional-change** (was **absent**) · decision row 12

- **Lean / ruling:** decision row 12 (Done 36dc1833e; Antra's ruling EMPTY, our-side 'no' = not a parity change needing her yes)
- **Implementation (v4):** server/upload.ts:482-483 SCRIPT_MOVED ('not stored: /upload?as=script went with protocol v1. Send the source as the world's upload {text} request (an agent: act {verb: "upload", args: {text}}); its reply's src goes in set {id, component: "script:<name>", …} (docs/SCRIPTS.md)'); :512 as=script → 415 SCRIPT_MOVED, checked before image/heightmap/audio/avatar and before the GLB sniff (:592); shared/protocol/verbspec.js:124 upload {text\|effect}
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** upload {text} verb
- **Specimen:** none named yet
- **Evidence — main:** server/upload.ts:478-480 (as=script → runtime-script ingestion, content-addressed)
- **Evidence — v4:** server/upload.ts:482-483,512,592; shared/protocol/verbspec.js:124
- **Tests:** door-wording (tools/door-wording-test.ts:797-802 '/upload?as=script is refused 415, naming the upload {text} request that stores a script now': 415, /upload \{text\}/, /act \{verb: "upload"/, !/GLB/). NOT RUN this pass (runner refuses: dangling node_modules symlink)
- **Changed since 72847d01d:** grade: absent → intentional-change. 36dc1833e: the 415 now names upload {text} and the script:<name> binding, and a door-wording row drives it. The endpoint itself is still gone (on purpose: scripts are the authority's upload {text}).
- **Commits:** 36dc1833e
- **Note:** tools/seatlab/README.md:22 still shows the old curl to /upload?as=script (doc leftover, not code).
- **Verified this run:** Opened: v4 server/upload.ts:444,482-483,512-513,524,551,556,563,571,592-593; verbspec.js:124; door-wording-test.ts:797-802; suites.ts:178; main server/upload.ts:476-480.

### [A8] name_place 8 KB guard

**intentional-change** · decision row 13

- **Lean / ruling:** decision row 13 (Accepted, proved 61d536c59; Antra's ruling EMPTY, our-side 'no' = not a parity change needing her yes)
- **Implementation (v4):** shared/protocol/authority/gate.js:115 (value > 65536 bytes → refuse too-big '… keeps values under 64 KiB'); shared/protocol/componentspec.js:195-197 places keyPattern ≤48 chars, label ≤80
- **Migration:** n/a
- **Browser:** —
- **Agent:** name_place forwards the authority's refusal ('not named — the world refused: … keeps values under 64 KiB')
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** tools/door-is-error-test.ts:1192-1196 ('A name that would take the component past the world's 8KB is refused before anything is sent')
- **Evidence — v4:** shared/protocol/authority/gate.js:115; shared/protocol/componentspec.js:195-197
- **Tests:** places (tools/places-test.ts:241-248 'a name that takes the places bag past 64 KiB is refused by the general value cap, and nothing is named') · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: places
- **Changed since 72847d01d:** grade unchanged (intentional-change), but now PROVED: 61d536c59 added the places row; the old 'unverified by a test on name_place' note is retired. componentspec places moved :192→:195 (8ce290e07 et al.).
- **Commits:** 61d536c59, 8ce290e07, e66a21a79, 24cac47b3, 631a9b484, 3eb5c51c1, da3042473
- **Note:** The 48-char name cap means the places bag, not the name, is what main's 8 KB guarded; 64 KiB general cap is the replacement.
- **Verified this run:** Opened: v4 gate.js:115; componentspec.js:193-197; places-test.ts:241-248; suites.ts:162; main door-is-error-test.ts:1192-1196. gate.js commits since 72847d01d (8ce290e07, 3eb5c51c1, 2cf1e6de9) checked: 8ce290e07's gate.js diff is lock wording only; :115 unchanged.

### [34(tool)] world_access tool, timed grant for:'2h'

**restored** (was **partial**) · decision row 14

- **Lean / ruling:** decision row 14 (Restored 52ea73571 + a64c286df; Antra's ruling EMPTY, our-side 'no' = not a parity change needing her yes)
- **Implementation (v4):** mcpl/tools.ts:1642 TOOL_FOLDS.world_access pointer (act set @world access \| roles:<id>; 'a timed grant: value {role, for: "2h"}'); :1174 act → grantsFor; :1651-1663 grantsFor: roles:<id> value with `for` → until = serverNow + durationMs (shared/protocol/access.js durationMs, import :192); both for+until refused; malformed for refused naming "30m", "2h", "1d" or "1w"; shared/protocol/componentspec.js:486 roles.until int; server/access.ts:193-209 warns before until
- **Migration:** n/a
- **Browser:** —
- **Agent:** act set roles:<id> {role, for: '2h'} (or until in epoch ms)
- **Vocabulary:** roles:<id> {until} \| for
- **Specimen:** none named yet
- **Evidence — main:** mcpl/tools.ts:134 (world_access: 'WHO MAY COME INTO this world, and until when…')
- **Evidence — v4:** mcpl/tools.ts:192,1174,1642,1651-1663; shared/protocol/componentspec.js:486; server/access.ts:193-209
- **Tests:** agenttools AT11 (tools/protocol/agenttools-check.ts:314-320 'act set roles:<id> {role, for: "2h"} stores until = now + 2 h (epoch ms)'; 'a malformed for is refused before anything is sent, with the durations'); alias (mcpl/alias-test.ts:29-31 — note MAIN_TOOLS at :29 does NOT list world_access; it is covered only by TOOL_FOLDS, not by that row) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools, alias
- **Changed since 72847d01d:** grade: partial → restored. 52ea73571/a64c286df: `for: "2h"` accepted again on act set roles:<id> (until computed from the server's clock), malformed durations refused with the forms, the fold pointer now mentions the timed form; agenttools AT11 added. Line drift: fold 1638→1642; componentspec roles 483→486.
- **Commits:** 52ea73571, a64c286df, e1f21cc9a
- **Note:** Old row's 'alias SEEN PASS (world_access is taught, not lost)' was imprecise: world_access is not in alias-test's MAIN_TOOLS list; it is taught via TOOL_FOLDS (tools.ts:1642). The tool itself (world_access as an MCP tool) is still a fold, not a tool — restored via act set.
- **Verified this run:** Opened: v4 mcpl/tools.ts:192,1172-1174,1642,1651-1663; componentspec.js:486; server/access.ts:7,193-209; shared/protocol/access.js:14,34-36; agenttools-check.ts:23,314-320; alias-test.ts:29-31; main mcpl/tools.ts:134. a64c286df not individually inspected (named by decision row 14; not in the per-file git log of tools.ts — may touch shared/protocol/access.js durationMs).

### [G2] world_history entry kinds + default page

**unverified**

- **Lean / ruling:** none (SWEEP-3 routed to features)
- **Implementation (v4):** mcpl/tools.ts:132 (schema: verbs, kinds, before, after, limit; doc 'kinds picks the entry kinds shown (default ['act', 'say']; 'change' … 'sim' …)'); handler :1423-1441 (kinds default act+say, before AND after window, 50 a page, 200 max)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** mcpl/tools.ts:128 (world_history: filter by `verbs`, page with before/after/limit — main had no `kinds` arg; SWEEP-3 G2)
- **Evidence — v4:** mcpl/tools.ts:132,1423-1441
- **Tests:** no named row: grep 'kinds' over tools/protocol/agenttools-check.ts, tools/history-request-test.ts, tools/readhistory-test.ts finds none driving world_history's kinds; NOT RUN
- **Changed since 72847d01d:** none (grade stays unverified; no new test rows). Line drift: handler 1420-1437 → 1423-1441.
- **Commits:** fc183b4f3, 52ea73571, e1f21cc9a
- **Note:** Correction to the old row's main pointer: main's world_history filters by `verbs`, not `kinds` — the `kinds` arg is v4's addition (entry kinds act/say/change/sim), not a main feature restored. Code present; no suite row drives it.
- **Verified this run:** Opened: v4 mcpl/tools.ts:132 (schema + kinds doc),1423-1441; grep kinds in agenttools-check/history tests (empty); main mcpl/tools.ts:128.

### [G1a] body_state posture key (deprecated twin of clip)

**unverified**

- **Lean / ruling:** none
- **Implementation (v4):** mcpl/body-state.ts:265 `clip: p?.clip ?? null, posture: p?.clip ?? null, // posture: main's name for clip, a deprecated twin (SWEEP-3 G1a)`
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** mcpl/body-state.ts:263 (`posture: p?.clip ?? null`)
- **Evidence — v4:** mcpl/body-state.ts:265
- **Tests:** none exists (grep '\bposture\b' over tools/ and mcpl/*test* hits only wing/locomotion/posture-tiles suites, none asserting body_state's posture key); NOT RUN
- **Changed since 72847d01d:** none (no commits on mcpl/body-state.ts since 72847d01d; no new test)
- **Commits:** none
- **Note:** no test asserts the twin.
- **Verified this run:** Opened: v4 mcpl/body-state.ts:124,265; main mcpl/body-state.ts:122,263; grep posture across tools/, mcpl/.


## Builders & components (31 rows)

### [4] force verb + /boom radial blast

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:00: go with your lean. I am fond of fun toys' — force {at, radius, power}, same bounds, builder rank, bodies via shove consent, things via punt
- **Implementation (v4):** shared/protocol/verbspec.js:76 (force {at, radius 0.5–30, power 0.2–12}); shared/protocol/authority/bodyverbs.js:375 (force()), :337 (punt(w, actor, a, blast) takes the blast), :356 (no kick reach when blast); shared/blast.js:9 (blastArgs), :13-18 (falloff, mag = power × (1 − d/radius)); shared/protocol/physconst.js:29 (BLAST bounds); client/lib/commands/handlers.js:308-311 (/boom), registry.js:34 (alias /blast); defs/ui/_help.json:110
- **Migration:** n/a (a cause, folds to nothing in both protocols)
- **Browser:** /boom, /blast absent
- **Agent:** world_verb force → unknown-verb
- **Vocabulary:** no force in VERBSPEC
- **Specimen:** none named yet
- **Evidence — main:** server/verbs.ts:350 (vForce), :655 (force: {validate: vForce}); shared/force.js:12-13 (FORCE_RADIUS 4, FORCE_POWER 3), :29-31 (linear falloff, FORCE_CAP)
- **Evidence — v4:** shared/protocol/verbspec.js:76; shared/protocol/authority/bodyverbs.js:375 (force()), :337, :356; shared/blast.js:9, :13-18; shared/protocol/physconst.js:29; client/lib/commands/handlers.js:308-311; client/lib/commands/registry.js:34; defs/ui/_help.json:110
- **Tests:** force-check F1–F15 (tools/protocol/force-check.ts:115-186; 13 mutants :23-35 + control); RUN THIS PASS: '[force-check] 15 passed, 0 failed'
- **Changed since 72847d01d:** none in substance; line drift only (bodyverbs force() 362 → 375, physconst BLAST 28 → 29; blast.js falloff is :13-18 not :14). Commits to bodyverbs.js since the old head are water/fall/KillZ, not force.
- **Commits:** none
- **Note:** shared/force.js is NOT back: the arithmetic lives in shared/blast.js (a pure module). PR line 'force / /boom (objects too, through the body gate)' holds. Consent wording uses the Move-me switch (verbspec.js:91).
- **Verified this run:** opened verbspec.js:76,91; bodyverbs.js:337,356,375; blast.js:1-18; physconst.js:29; handlers.js:306-311; registry.js:34; _help.json:110; main verbs.ts:350,655 and force.js:12-31; force-check.ts:23-35,115-186. Ran force-check directly (bun, under the shared lock): 15 passed, 0 failed. eido-suites.sh itself refuses at this tree ('node_modules is missing' preflight) — see summary.

### [7] use as free-form event lane

**intentional-change** · decision row 18

- **Lean / ruling:** decision row 18: our side ruled 10-30 'keep v4 (declared actions, Godot/Unity convention); upgrade declares old events as custom actions'. Antra's ruling column EMPTY (still a proposal). The second half (upgrade declares custom actions) is NOT built at this head.
- **Implementation (v4):** shared/protocol/authority/use.js:56-64 (buildUse: actionsOf; 'no-action' unless the thing offers actions; the action must be offered, :64); tools/protocol/import-v1/translate-v1.js:113-124 (newReactions: only impulse → {kind:'impulse', angular} and door → openable; writes NO custom action for an old free-form use event; grep 'custom' in translate-v1.js: no hit)
- **Migration:** n/a today (old use acts stay as acts; no field). The ruled 'declare old events as custom actions' translator step does not exist yet.
- **Browser:** —
- **Agent:** use {action} refused unless offered
- **Vocabulary:** use {actions:[…]} (proposed)
- **Specimen:** none named yet
- **Evidence — main:** server/verbs.ts:651 (use: {after: reactToUse} — any use is a cause), :22 (import reactToUse)
- **Evidence — v4:** shared/protocol/authority/use.js:56-64; tools/protocol/import-v1/translate-v1.js:113-124 (newReactions), :810 (applied)
- **Tests:** scripts-check W1 (tools/protocol/scripts-check.ts:934: world.use through the gate's own reaction) — no row for a free-form use; no row for a translated custom action (none exists)
- **Changed since 72847d01d:** grade unchanged; the ruling moved from 'never put to R' to decision row 18 (our side ruled 10-30, Antra empty). 8ce290e07 reworded use.js refusals only. The translator half of the ruling is still to-do.
- **Commits:** 8ce290e07
- **Note:** Half-ruled, half-built: the refusal is kept per the lean, but the 'upgrade declares old events as custom actions' part has no code and no test row. Antra's column is empty.
- **Verified this run:** opened use.js:46-70,117-134,274,285; translate-v1.js:108-125,810; grep custom/actions in translate-v1.js; main verbs.ts:22,651; scripts-check.ts:934.

### [8,B5] Script-free swing (impulse reaction, default pivot)

**partial** · decision row 19

- **Lean / ruling:** decision row 19 (a new impulse reaction refused as reserved): lean 'keep reserved until the reaction kinds are settled'; our side ruled 'no', Antra empty → UNRULED. Translated swings pinned (the lead 10-27, item 47).
- **Implementation (v4):** shared/protocol/authority/checks.js:138-139 (a NEW reactions handler of a reserved kind refused 'reserved' unless carry); componentspec.js:218 (reservedKinds.impulse), :203 (help: 'impulse is reserved'); use.js:117-134 (a carried impulse still swings a pendulum; :120 no pivot → 'no-pivot'); shared/protocol/shaperepair.js:48 (OLD_READINGS wholePendulumPivot [0,2,0]), :91 (pivot written for a pendulum with none)
- **Migration:** translate-v1.js:113-124 (newReactions: v1 {impulse: n} → {kind:'impulse', angular: n} carried exactly); :153 (@21 maxAmp 1.1); pivot via shaperepair.js:91
- **Browser:** —
- **Agent:** unverified
- **Vocabulary:** reactions {kind:'impulse'} reserved
- **Specimen:** none named yet
- **Evidence — main:** server/reactions.ts:57 (pendulumImpulse call), :79 (export function pendulumImpulse); client/lib/motioneval.js:100 (period ?? 3.5)
- **Evidence — v4:** shared/protocol/authority/checks.js:138-139; shared/protocol/componentspec.js:203,218; shared/protocol/authority/use.js:117-134; shared/protocol/shaperepair.js:48,91
- **Tests:** authority-check SW1 (tools/protocol/authority-check.ts:873 'an impulse handler is refused as a reserved kind, even on a swing'); shape-repair-test RP19 (tools/shape-repair-test.ts:155,160: translated swing carries 3.5 / 0 / 1.1). Neither suite run this pass.
- **Changed since 72847d01d:** none in substance; line drift (componentspec reservedKinds 197 → 218; main reactions.ts pendulumImpulse is :57/:79 not :50). Decision row 19 now records the item as unruled.
- **Commits:** 24cac47b3
- **Note:** B5 (default pivot for translated swings) restored via shaperepair.js:91; item 8 (a builder writing a new impulse reaction) remains refused and unruled (row 19, Antra empty). 24cac47b3 touched checks.js for collider layers, not this gate.
- **Verified this run:** opened checks.js:138-139,150-154; componentspec.js:200-203,218; use.js:117-134; shaperepair.js:48,60-62,91; translate-v1.js:113-124,153; main reactions.ts:57,79 and motioneval.js:100-101; authority-check.ts:870-873; shape-repair-test.ts:155-160.

### [9] Behaviour SDK and script capabilities

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:26 I agree with all of the above'; 'world.nearby (positions stay out of it)'
- **Implementation (v4):** scripting/world.d.ts:46 (nearby(r): {id, d}[] — no positions); scripting/run.ts; scripting/examples/{greeter,bellkeeper,lighthouse}.js; shared/protocol/authority/scriptrun.js:111-114 (scope cap, say/bodies declared); shared/protocol/authority/use.js (a script on @world hears every use: scripts-check mutant :128 → WL1)
- **Migration:** translate-v1.js:240 (imported-behavior:<k> naming), :889 (v1 bindings carried as @world imported-behavior:<name>, author stamped; never run)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** world.near/count, no positions; no private kv
- **Specimen:** none named yet
- **Evidence — main:** sdk/behavior.d.ts:55 (emit(verb, args) — main's types)
- **Evidence — v4:** scripting/world.d.ts:46; shared/protocol/authority/scriptrun.js:111-114; tools/protocol/scripts-check.ts:74-76 (N1 mutants), :121-122 (W1 mutants), :128 (WL1 mutant), :934 (W1), :1039 (N1)
- **Tests:** scripts-check W1 (:934), N1 (:1039), WL1 (mutant :128); --mutants 89 run / 0 wrong per 0dfd90d12. RUN THIS PASS (direct bun invocation, not the gate runner): '[scripts-check] 105 passed, 2 failed' — W1, WL1, N1 all ok; the two FAILs are S1 and S2, the rows that spawn a real server over a WebSocket, run here without the runner's EIDOVERSE_DIR env. Not re-run (suite budget); treat S1/S2 as unverified-in-this-environment, not as a finding.
- **Changed since 72847d01d:** evidence only: release/hold events to scripts (e827dc856, e513a0a58), the too-many refusal wording (4a1a5eb22), scriptaudit's per-part judgment of world.use (21c0bda6b, f94c24f3b), --mutants pass 89/0 (0dfd90d12). Grade unchanged.
- **Commits:** 4a97e42bf, e513a0a58, e827dc856, 4a1a5eb22, 21c0bda6b, f94c24f3b, 0dfd90d12, febf88ca2
- **Note:** PR line 'World-level scripts (@world), world.use, world.nearby (positions stay out of it), and the scripting/ kit' holds. Offline harness = scripting/run.ts; the old radio example is not back (greeter/bellkeeper/lighthouse instead). importedBehaviours as a named helper no longer exists (old row cited translate-v1.js:562-565); the carry is at :889.
- **Verified this run:** opened world.d.ts:46; scriptrun.js:111-114,316-320; translate-v1.js:240,889; scripts-check.ts:74-76,121-128,138-153,934,1039; ls scripting/, scripting/examples/; main sdk/behavior.d.ts:50-58. scripts-check run direct under the shared lock: 105 passed, 2 failed (S1, S2 server-spawning rows; W1/WL1/N1 ok). My grep filter dropped the FAIL detail lines, so the cause is not confirmed; likely the missing EIDOVERSE_DIR / runner env since the gate runner refused to start here.

### [43(B1)] Alt text (picture/sound look → alt)

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'Already settled: description not alt (43)'
- **Implementation (v4):** shared/protocol/componentspec.js:343 (picture fields {src, width, description, lit}; no alt → refused as not a field), :353 (material description); shared/protocol/shaperepair.js:202-203 (alt/look → description rename table), :211-212 (stored alt/look renamed once); shared/sound.js:41 (SOUND_DESCRIPTION_MAX 200), :117; scriptrun.js:318-319 (a stored picture/sound alt or look BLOCKS writes until the maintenance rename, febf88ca2)
- **Migration:** translate-v1.js:148-149 (@22 sound.look → description), :145-146 (@23 picture look → material.description), :296 (FATES sound.look)
- **Browser:** picture and sound editors write description (carried from the old row, not re-checked)
- **Agent:** look() reads description via describePicture / describeSound / describeMaterial (sound.js:138 opened)
- **Vocabulary:** description (alt and look retired by the ruling)
- **Specimen:** synthetic fixtures; no production specimen named
- **Evidence — main:** shared/picture.js:37 (KNOWN_KEYS src/part/look/lit/flip), :79-80
- **Evidence — v4:** shared/protocol/componentspec.js:343,353; shared/protocol/shaperepair.js:202-203,211-212; shared/sound.js:41,117,138; shared/protocol/authority/scriptrun.js:318-319
- **Tests:** shape-render-test DS4 (tools/shape-render-test.ts:235 'the door takes description and refuses alt'), PI1 (:215), MA1 (:248); shape-repair-test RP15 (tools/shape-repair-test.ts:294-300: a stored alt/look blocks writes until the rename; new since the old head). Not run this pass.
- **Changed since 72847d01d:** evidence grew: febf88ca2 makes a stored alt/look block writes until repair (scriptrun.js:318-319, RP15). Line drift: componentspec 340/350 → 343/353.
- **Commits:** febf88ca2, 8ce290e07, e66a21a79
- **Note:** PR line '`description` is the stored field and `look` reads it; `alt` is refused' holds (DS4).
- **Verified this run:** opened componentspec.js:343,353; shaperepair.js:202-212; sound.js:41,117,138; scriptrun.js:316-320; translate-v1.js:145-149,296; main picture.js:37,79-80; shape-render-test.ts:215,235,248; shape-repair-test.ts:294-300; febf88ca2 --stat.

### [47(B3,B4)] Pendulum defaults

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'Already settled: pendulum pinned for translated worlds (47)'
- **Implementation (v4):** shared/protocol/componentspec.js:133 (new pendulum period 2.4 / damp 0.08 / maxAmp 0.9), :149 (absentMeans: 'pendulum: 3.5 s (an old value's reading; a swing written today carries the default, 2.4 s)'); shared/protocol/shaperepair.js:48 (OLD_READINGS 3.5 / 0 / 1.1 / pivot [0,2,0]), :60-62 (written where absent)
- **Migration:** translate-v1.js:153 (@21: a pendulum with no maxAmp written 1.1); shaperepair writes period/damp (:60-62)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** pendulum {period, damp, maxAmp}
- **Specimen:** synthetic (shape-repair RP19); no production specimen named
- **Evidence — main:** client/lib/motioneval.js:100-101 (period ?? 3.5, damp ?? 0)
- **Evidence — v4:** shared/protocol/componentspec.js:133,149; shared/protocol/shaperepair.js:48,60-62
- **Tests:** shape-repair-test RP19 (tools/shape-repair-test.ts:155 tryRow('RP19'), :160 '…carries the old reader's 3.5 s, 0 and 1.1'); not run this pass
- **Changed since 72847d01d:** none in substance; componentspec pendulum default moved :130 → :133. 4ef4a28eb (pointed at for this row) touches materialcomp.js only, not the pendulum.
- **Commits:** none
- **Note:** RP19 now located by name (the old row said 'not seen by name'). Status intentional-change kept; no decision-table row covers it (ruled in MORNING-ASKS).
- **Verified this run:** opened componentspec.js:133,142,149,152; shaperepair.js:48,60-62; translate-v1.js:153; main motioneval.js:100-101; shape-repair-test.ts:155-160.

### [48(B2),36] Picture on a named model part (+ UV flip)

**partial**

- **Lean / ruling:** ruled: MORNING-ASKS 'Already settled: picture = sprite, picture-on-part → material (48)'
- **Implementation (v4):** shared/protocol/componentspec.js:343 (picture {src, width, description, lit}: part/flip gone), :353 (material {node, texture, description, lit}); client/lib/materialcomp.js:18 (worn map), :35 (restore original on removal, dispose the clone), :48-52 (takeOff then clone per mesh, map = tex, colour white); tools/protocol/import-v1/translate-v1.js:316 (fate text), :324-325 (materialOf: {node: part, texture: src, description: look}; flip true → left {flip}; no part → imported:picture)
- **Migration:** translate-v1.js:145-147 (@23), :297 ('picture.flip false': nothing written), :316
- **Browser:** materialcomp.js wears a cloned material per mesh of the node, restores it on removal; no material inspector card (carried from the old row, not re-grepped this pass)
- **Agent:** look() reads 'an image on its <node>' (describeMaterial) — carried
- **Vocabulary:** material {node, texture, description, lit}
- **Specimen:** synthetic; no production specimen named
- **Evidence — main:** client/lib/pictures.js:81 (findPart(root, picture.part)); shared/picture.js:37 (KNOWN_KEYS incl. part, flip)
- **Evidence — v4:** shared/protocol/componentspec.js:343,353; client/lib/materialcomp.js:18,35,48-52; tools/protocol/import-v1/translate-v1.js:316,324-325
- **Tests:** shape-render-test MA1 (tools/shape-render-test.ts:248), PI1 (:215); not run this pass
- **Changed since 72847d01d:** evidence only: 4ef4a28eb (a material worn while trusted comes off when the viewer revokes untrusted links) and 5deab3306 (a picture update keeps its width; pictures.js, editpanels.js). Line drift: componentspec 339-342/350 → 343/353; materialOf 312-316 → 316-325. Grade unchanged.
- **Commits:** 4ef4a28eb, 5deab3306
- **Note:** Still partial: UV flip unmapped (listed as imported:material); no material inspector card. Matches the ruling; PR does not claim more.
- **Verified this run:** opened componentspec.js:343,353; materialcomp.js:5-6,18,35,48-52; translate-v1.js:145-147,297,316-325; main pictures.js:79-81, picture.js:37; shape-render-test.ts:215,248; 4ef4a28eb and 5deab3306 --stat.

### [B6] Socket with no pos

**restored** (was **absent**) · decision row 9

- **Lean / ruling:** decision row 9: 'Restored (34c1753c2, translator @33): pos defaults to [0, 0.5, 0], as main's client did. Row DT9.' Our side ruled 'no' (no change needed beyond the restore); Antra empty.
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:61 (comment: '@33: no pos is main's [0, 0.5, 0], client/lib/world.js'), :72 (newSockets: pos: pos ?? [0, 0.5, 0]), :128 (@33 changelog). The authority's own fallback is unchanged: shared/protocol/authority/sockets.js:173 (hv.pos ?? [0, 0, 0]) — a v4-authored socket with no pos still sits at y 0; only translated ones get main's 0.5.
- **Migration:** translate-v1.js:62-72: absent or null pos → [0, 0.5, 0] written; a written pos kept
- **Browser:** unverified
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** client/lib/world.js:419 (sock.pos ?? [0, 0.5, 0])
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:61,72,128; shared/protocol/authority/sockets.js:173
- **Tests:** translate-check DT9 (tools/protocol/translate-check.ts:12 header, :258 row('DT9'), :261 'a seat with no pos (or a null one) sits at main's [0, 0.5, 0]; a written pos is kept'). RUN THIS PASS: '[translate-check] 44 passed, 0 failed', DT9 ok. sockets-test RUN: '83 passed, 0 failed' (no pos-less row there; unchanged).
- **Changed since 72847d01d:** absent → restored: 34c1753c2 (translate-v1@33) writes main's [0, 0.5, 0] for a translated socket with no pos; DT9 added.
- **Commits:** 34c1753c2
- **Note:** Restored at the translator, not at the authority (sockets.js:173 still [0,0,0] for a v4-native pos-less socket — consistent with the decision row, which scopes the fix to translated seats).
- **Verified this run:** opened translate-v1.js:61-72,126-128; sockets.js:173; main world.js:419; translate-check.ts:12,258-262. Ran translate-check (44/44, DT9 ok) and sockets-test (83/83) directly under the shared lock.

### [17] Particles: preset knobs, several emitters

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:52: keep v4 effect documents, translator derives an effect document from preset + knobs'
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:674 (KNOBS bounded as main's), :675 (KNOB_NAMES + gravity/color/blending), :681 (particlesOf), :688 (unknown preset → carried with why), :706 (derivedEffect(preset, over) memoised; effectAddress), :809 (applied per thing; effects map), :839 (per named emitter child), :1048,:1105 (effects collected, listed in stats), :295 (FATES text)
- **Migration:** translate-v1.js:144 (@24): derives an effect document from preset + knobs; :294 (@15: particles:<name> → child thing); 6293438e6 adds @34: ambient motes → derived dust document (:127, :401, :898) — decision row 8, a sibling of this row
- **Browser:** knobs not drawn
- **Agent:** —
- **Vocabulary:** particles {effect, params}
- **Specimen:** none named yet
- **Evidence — main:** shared/particles.js:118 (NUMERIC_BOUNDS, the knob table), :142
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:674-675,681,688,706,809,839,1048,1105; :294-295
- **Tests:** translate-check P17a–P17h (tools/protocol/translate-check.ts:78,84,88,91,93,97,100,112). RUN THIS PASS: '[translate-check] 44 passed, 0 failed', P17a ok. describe-particles / particles-test not re-run.
- **Changed since 72847d01d:** evidence only: line drift (KNOBS 620 → 674, particlesOf 627-655 → 681-720); 6293438e6 (@34) added the motes' derived dust beside it. Grade unchanged.
- **Commits:** 6293438e6, 34c1753c2, 24cac47b3, 3eb5c51c1, d00de504a, d43fe67f1
- **Note:** PR line 'particle knobs as a derived effect' holds. Several emitters per thing still become child things (@15). Decision row 8 (motes) is a separate item, restored by 6293438e6; noted here because it lands in the same particlesOf/effects path.
- **Verified this run:** opened translate-v1.js:22,126-128,144,189,294-295,380-408,674-706,809,839,898,1048,1105; main particles.js:118,142; translate-check.ts:78-112. Ran translate-check: 44 passed, 0 failed.

### [18,B10,B11] Sound radius, rolloff, voice cap

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:53 Yes to both' (200 m, 8 → 32 voices)
- **Implementation (v4):** shared/sound.js:44 (SOUND_MAX_RADIUS = 200, 'the lead 10-28: 100 → 200'), :99,:106,:132; client/lib/sounds.js:44 (§7 note: VOICES 32, was 8), :71 (export const VOICES = 32), :211-213
- **Migration:** translate-check S3-X1 (sound radius 250 → 200 via toSpec, translate-v1.js:745); no translator field change
- **Browser:** 8-voice cap
- **Agent:** —
- **Vocabulary:** sound {radius ≤100}
- **Specimen:** none named yet
- **Evidence — main:** shared/sound.js:83 (radius: num(data.radius, 1, 200, …))
- **Evidence — v4:** shared/sound.js:44,99,106,132; client/lib/sounds.js:44,71,211-213
- **Tests:** sound-test (tools/sound-test.ts:56-62: 'SOUND_MAX_RADIUS is 200 m…' :59, '…registry's ranges say the same' :61, '…still silent at radius at 200 m' :62); not run this pass. translate-check S3-X1 (:266) RUN: ok, 44/44.
- **Changed since 72847d01d:** none (no commits to sound.js or sounds.js since 72847d01d; sound-test row lines unchanged 59-62)
- **Commits:** none
- **Note:** PR line 'sound radius 200 m / 32 voices' holds. The 10-07 'silent at radius' taper kept (not main's rolloff): per the 11:54 correction that was never a cut.
- **Verified this run:** opened sound.js:41,44,99,106,117,132,138; sounds.js:44,71,211-213; main sound.js:83; tools/sound-test.ts:56-62; translate-check.ts:266 + run (44/44).

### [B12] Motion path points

**intentional-change**

- **Lean / ruling:** none — delta accepted by the 10-27 matrix ('translator splits or refuses with a count'); the translator resamples to 64 with a count instead. Not in the decision table.
- **Implementation (v4):** shared/protocol/authority/checks.js:123-124 (points must be 2 to 64); componentspec.js:146 (docs 'the path's control points, 2–64')
- **Migration:** translate-v1.js:744 (toSpec doc: 'a path resampled to 64'), :758 (every ~((n−1)/63)th point, both ends kept; listed in adjusted)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** motion path.points ≤64
- **Specimen:** none named yet
- **Evidence — main:** client/lib/motioneval.js:122-123 (path needs ≥ 2 points, no upper bound)
- **Evidence — v4:** shared/protocol/authority/checks.js:123-124; shared/protocol/componentspec.js:146; tools/protocol/import-v1/translate-v1.js:744,758
- **Tests:** translate-check S3-X1 (tools/protocol/translate-check.ts:266: 70-point path → 64, listed). RUN THIS PASS: ok, 44/44.
- **Changed since 72847d01d:** none in substance; line drift (checks.js 124 → 123-124; componentspec 143 → 146; toSpec 689-700 → 745-758). The old row's self-correction stands: it IS resampled (:758), not truncated.
- **Commits:** 24cac47b3, 3eb5c51c1
- **Note:** Old row's migration text fixed: resampled, both ends kept.
- **Verified this run:** opened checks.js:123-124; componentspec.js:139,146,152; translate-v1.js:744-758; main motioneval.js:117-123; translate-check.ts:266 + run.

### [19] Fork

**intentional-change** · decision row 5

- **Lean / ruling:** decision row 5 (rate limits are server policy; founding no quota; fork limits config with 0 = none): our side ruled yes 10-28, Antra empty. MORNING-ASKS 'the lead 12:00: keep v4 (state + link back, no chat, no positions)'; full copy with history OPEN, not built.
- **Implementation (v4):** server/worldlog.ts:533-535 (forkWorld: state copy, in place only once equal, 'Chat history isn't copied'); server/config.ts:155 (FORK_GAP_SEC 60, ≥0), :157 (FORK_PER_HOUR 5, ≥0); server/requestwire.ts:251-254 (enforced; 0 = none)
- **Migration:** n/a
- **Browser:** /fork help says as it stands
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** server/world.ts:547-549 (fork is a byte-copy of the log plus snapshot and poses)
- **Evidence — v4:** server/worldlog.ts:533-535; server/config.ts:155,157; server/requestwire.ts:20,251-254
- **Tests:** fork-reset-check FL1 (tools/protocol/fork-reset-check.ts:179: GAP 0 / PER_HOUR 0 → six copies back to back), FL3 (:191: 'one copy every 1 s'), FL4 (:193: PER_HOUR 2 → third refused, nothing written); not run this pass
- **Changed since 72847d01d:** none in substance; requestwire.ts lines moved 248-249 → 251-254 (9c30e6416 added consent-list plumbing above). Decision row 5 now records the ruling.
- **Commits:** 9c30e6416
- **Note:** PR 'founding and fork quotas are removed or are config with 0 meaning none' holds. Full copy with history remains open.
- **Verified this run:** opened worldlog.ts:533-535; config.ts:155,157; requestwire.ts:20,251-254; main world.ts:545-549; fork-reset-check.ts:179,188-194.

### [20] Locked delete; guard

**intentional-change**

- **Lean / ruling:** none — not in MORNING-ASKS or the decision table; the 10-27 matrix accepted the rank-lock delta
- **Implementation (v4):** shared/protocol/authority/gate.js:185-199 (lockCheck at :190: delete of a locked thing refused 'locked' unless throughLock by someone who may unlock; :197 throughLock covers only your own edits, not a handler/script; :199 fix text), :206 (lockLevelCheck); client/lib/build.js:611 (Edits.del → the authority asks 'This is locked. Delete anyway?'); client/lib/confirmcenter.js:141 (re-send on confirm); client/lib/editpanels.js:474-477 (the padlock follows the lock the thing holds now, 5deab3306)
- **Migration:** n/a (guard dropped by design; lock carried)
- **Browser:** build.js confirm dialog; padlock in the edit panel follows the current lock (5deab3306)
- **Agent:** covered by authority-check P8
- **Vocabulary:** lock (no guard, no placer)
- **Specimen:** none named yet
- **Evidence — main:** client/lib/build.js:379 (lockedHint), :424 (removeSelected: lockedHint refuses — 'an accidental Del is the worst accident')
- **Evidence — v4:** shared/protocol/authority/gate.js:185-199,206; client/lib/build.js:611; client/lib/confirmcenter.js:141; client/lib/editpanels.js:474-477
- **Tests:** authority-check P8 (tools/protocol/authority-check.ts:107: bob's delete and place of the locked cup both 'locked'), PL1 (:239); lock-strength-test (tools/lock-strength-test.ts, new in 5deab3306); not run this pass
- **Changed since 72847d01d:** evidence only: 8ce290e07 reworded gate.js refusals (lockCheck 190-201 → 185-199); 5deab3306 made the client padlock follow the current lock (+ lock-strength-test); 4e5c545f2 (undo of a no-op act) is in authority-check but not about locks. Grade unchanged. Main build.js:421 → :424.
- **Commits:** 8ce290e07, 3eb5c51c1, 2cf1e6de9, 5deab3306, 4e5c545f2
- **Note:** Locked delete IS refused at the authority (not just a client prompt); 'delete anyway' is a throughLock re-send recorded in history.
- **Verified this run:** opened gate.js:40,185-199,206; build.js:611; confirmcenter.js:141; editpanels.js:474-477; main build.js:379,391,419-424; authority-check.ts:107,239; 5deab3306 and 4e5c545f2 --stat.

### [33] World-offered client mods, EW.lease

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:26: KEEP world-offered mods removed (safety); restore the per-client object physics off switch; EW.lease stays replaced by EW.physics'
- **Implementation (v4):** client/lib/mods.js:9-10 ('A world doesn't offer client mods'), :14 (EW.physics), :28 (imports physicsEnabled/setPhysicsEnabled), :189-190 (object-physics row + button), :219-221 (toggle, 'the lead 10-28 (item 33)'); client/lib/thingphysics.js:532-533 (physicsEnabled/setPhysicsEnabled), :910 (EW.physics surface); grep 'lease' in mods.js/base.js: none
- **Migration:** translate-v1.js:889: behavior runtime:client → imported-behavior (not carried as a mod)
- **Browser:** no promote/run once/trust UI
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** client/lib/mods.js:141 (offers(): behaviors with runtime 'client')
- **Evidence — v4:** client/lib/mods.js:9-10,14,28,189-190,219-221; client/lib/thingphysics.js:532-533,910
- **Tests:** physics-off-test (tools/physics-off-test.ts, suite 'physics-off' at suites.ts:153) and modhole-check (suites.ts:146) — carried from the old row (7/7, 13/13); not run this pass
- **Changed since 72847d01d:** none in substance; thingphysics.js changed for keys (6616997af: Q throw, C/Ctrl down) and a level-dive log (26d7ddb5c), EW.physics surface moved :909 → :910
- **Commits:** 6616997af, 26d7ddb5c
- **Note:** PR line 'the physics-off switch' holds.
- **Verified this run:** opened mods.js:9-14,28,132,189-190,219-221; thingphysics.js:532-533,910; grep lease in mods.js/base.js; main mods.js:139-143; suites.ts:146,153.

### [35] Sitting across rejoin, ◈ agent marker, keyboard nudges

**intentional-change** · decision row 15

- **Lean / ruling:** decision row 15: lean 'keep retired'; our side 10-30 'on the fence about the marker; proposal: nudge keys stay retired, marker returns as a plain AI label on nameplate + People Here'; Antra empty. The AI label is NOT built at this head (grep client/lib for an 'AI' label / nameplate agent badge: none; e1f21cc9a touched only server/routes.ts, mcpl/tools.ts, tests — the /worlds agents list, decision row 21).
- **Implementation (v4):** shared/protocol/authority/occupants.js:1,25 (sitting is presence, never logged); client/lib/build.js:799-800 ('old per-key nudges Q/E turn, ,/. size, R/F raise are retired; the tools do those with a drag'), :802 (Q/G/E/R/P are tool keys); build.js:392 (Q/E still turn the PLACEMENT ghost's yaw — placement-time, not a nudge of a placed thing); grep '◈' in client/ shared/ server/: no hit
- **Migration:** translate-v1.js:282 ('mounts: bodies sitting: presence in v4, never history (00:50 ruling 1); their old entries survive as acts')
- **Browser:** Q/E, ,/., R/F now tool keys; 6616997af (decision row 25): throw/punt moved to Q, C/Ctrl only down — Q is now doubly spoken for outside edit mode (throw) and inside (select tool), neither a nudge
- **Agent:** agent without 'agent' declaration unlabeled; no AI label on nameplates yet
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** shared/fold.js:482 (case 'mount': folded into state)
- **Evidence — v4:** shared/protocol/authority/occupants.js:1,25; client/lib/build.js:392,799-802; tools/protocol/import-v1/translate-v1.js:282
- **Tests:** none exists for the three as restorations; AT12 (agenttools-check, e1f21cc9a) covers the /worlds agents list, not a nameplate marker
- **Changed since 72847d01d:** grade unchanged; the marker now has a proposal on record (decision row 15, Antra empty) but no code: still retired. Nudge keys stay retired per the same proposal. 6616997af re-bound Q/C (row 25), adjacent but not a nudge restore. Line drift: translate-v1 mounts fate 273 → 282.
- **Commits:** 6616997af, e1f21cc9a
- **Note:** Three deltas: sitting-as-presence ruled (00:50 ruling 1); nudges retired per the row-15 proposal; the ◈ marker's replacement ('AI' label) is proposed, unruled by Antra, and not built. SWEEP-3's 'agent.ts:1167' citation remains stale (server/agent.ts does not exist).
- **Verified this run:** opened occupants.js:1,25; build.js:392,799-802; translate-v1.js:282; main fold.js:480-484; grep ◈ (none), grep AI/declares/label in client/lib (no nameplate label); e1f21cc9a --stat; 6616997af --stat; grep agent.ts (absent).

### [36(sky)] Sky sun/fill sliders, world select

**intentional-change** (was **partial**) · decision row 16

- **Lean / ruling:** decision row 16 (sun/fill stay cut; lean: they duplicated exposure/ambient) — Antra's ruling EMPTY, still a proposal. World select's removal ruled (skypanel-state). sky.audio: the lead's 10-28 '@25' ruling (translate-v1.js:143) has the sky take it again as @world.sky.audio; the old row's note about a 13:44 'no sky.audio field' ruling is superseded by @25 in the code comment.
- **Implementation (v4):** shared/protocol/componentspec.js:410 (sky fields incl. system, colors, audio: bool; no sun/fill/world), :412 (system enum), :424 (audio doc: asset library's weather sounds, silent otherwise); client/lib/skypanel.js:30 (ambient slider only; 'sun and fill were cut'), :114 (delete a.world/sun/fill), :158 (no world select); translate-v1.js:851 (sky.audio = Boolean, @25)
- **Migration:** translate-v1.js:143 (@25 comment), :851: main's sky.audio → @world.sky.audio bool; sun/fill: dropped at repair (unchanged)
- **Browser:** sliders gone; select gone
- **Agent:** —
- **Vocabulary:** sky has no sun/fill/world; sky.audio bool
- **Specimen:** none named yet
- **Evidence — main:** client/lib/skypanel.js:30-38 (SLIDERS incl. 'sun' :34 and 'fill' :36)
- **Evidence — v4:** shared/protocol/componentspec.js:410,412,424; client/lib/skypanel.js:30,114,158; tools/protocol/import-v1/translate-v1.js:143,851
- **Tests:** translate S3-SA (translate-check.ts:290-292: sky.audio true/1 → @world.sky.audio === true, nothing carried, fields.audio === 'bool') — translate-check 44 passed, 0 failed (run this session); skypanel-state-test.ts:92 ('the world select is gone') — skypanel 18 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: skypanel, translate
- **Changed since 72847d01d:** grade partial → intentional-change (decision row 16 now exists, unruled by Antra); no code change to sky fields/panel/translator audio since 72847d01d; translate-check grew 36 → 44 rows (DT8/DT9/V7 etc.), componentspec sky lines drifted 407→410, 420-421→412/424, translate :794→:851.
- **Commits:** 3eb5c51c1, 24cac47b3, 34c1753c2, 6293438e6, 8ce290e07
- **Note:** Re-graded partial → intentional-change: the cut of sun/fill is now in the decision table (row 16) as a proposal; Antra's ruling column is empty. sky.audio is a real field with a passing row (S3-SA), so the contradiction the old note raised is settled in the code by @25 (the lead 10-28). translate-check.ts:8 header still says 'sky audio is no longer carried' (F50) — a stale comment, the S3-SA row is the behaviour.
- **Verified this run:** opened main skypanel.js:25-40; v4 componentspec.js sky block :408-425, skypanel.js :30/:114/:158 (grep), translate-v1.js :143/:851, translate-check.ts :290-292, skypanel-state-test.ts :92; ran translate (44/44) and skypanel (18/18) on <local worktree> — same commit e1f21cc9a, clean, `git diff --quiet e1f21cc9a -- tools shared client server` empty; wt-s-int itself has no node_modules and the brief forbids installing there.

### [37] Caption deed; bare component names

**intentional-change** · decision row 17

- **Lean / ruling:** decision row 17 — lead ruled 10-30: no expiry; main's deed died with the screen's generation; v4's captioners lives on the screen so a replaced screen drops it the same way; 'restored nothing; corrected our audit row'. Antra's ruling EMPTY.
- **Implementation (v4):** shared/protocol/componentspec.js:401 (captioners {ids} on thing; anyone who may edit the screen may caption too), :390 comment; shared/protocol/verbspec.js:121-123 (caption verb; gen stamped from the connection); shared/protocol/authority/checks.js:321-333 (bare unregistered names refused with teaching, didYouMean)
- **Migration:** unknown custom names → <ns>/name (translate-v1.js NAMESPACE/namespaceOf, not re-opened this run)
- **Browser:** —
- **Agent:** caption verb kept
- **Vocabulary:** captioners; namespaced custom names
- **Specimen:** none named yet
- **Evidence — main:** server/verbs.ts:134-143 (grant {caption: <entityId>} resolved to the entity's creation generation 'so the deed dies with the object'; caption: null revokes)
- **Evidence — v4:** shared/protocol/componentspec.js:390,401; shared/protocol/verbspec.js:121-123; shared/protocol/authority/checks.js:321-333
- **Tests:** authority-check (CA* ids at authority-check.ts:482-490 are 'create at' rows, NOT captioner rows — the old row's 'CA1–CA…' label was wrong); a captioners row id was not located this run → test leg unverified. Not run.
- **Changed since 72847d01d:** grade unchanged; ruling added (decision row 17); evidence lines drifted (componentspec :398→:401; checks.js :294-300→:321-333); test citation corrected (CA* are not caption rows).
- **Commits:** none
- **Note:** Grade stays intentional-change, now with a ruling (decision row 17). Parity is effectively equal: main's deed was generation-bound (verbs.ts:134-143), v4's component dies with the screen's generation too. Difference remaining: main's deed was a grant-time arg; v4 is a component on the screen. The old row's test citation 'CA1–CA…' does not point at caption rows; re-find the captioners rows before calling the test leg covered.
- **Verified this run:** opened main server/verbs.ts:125-150; v4 componentspec.js:390,401, verbspec.js:121-123, checks.js:310-335 (grep lines), authority-check.ts CA1–CA5 at :482-490. No commits touched verbspec/checks.js since 72847d01d per git log.

### [12,C4,C5] Emote data: _emotes.json, VR panel spot, /defs key

**intentional-change** (was **absent**) · decision row 10

- **Lean / ruling:** decision row 10 — lead ruled 10-30: engine reads _actionbar.json only; libraries get the layout from our own assets repo, not by patching the upstream library. Antra's ruling EMPTY.
- **Implementation (v4):** server/defs.ts:76 (actionbar: loadSidecar('animations/_actionbar.json')); no '_emotes' anywhere at e1f21cc9a (git grep = no hit); client/lib/domquad.js:24 (PLACE_LS = 'ew-xr-quads')
- **Migration:** n/a (server sidecar, not world data)
- **Browser:** VR panel spot resets once
- **Agent:** —
- **Vocabulary:** emotes → actionbar
- **Specimen:** none named yet
- **Evidence — main:** server/defs.ts:76 (emotes: loadSidecar('animations/_emotes.json', validateEmotes))
- **Evidence — v4:** server/defs.ts:76 (actionbar: loadSidecar('animations/_actionbar.json', validateActionBar)); git grep '_emotes' e1f21cc9a = none; client/lib/domquad.js:24
- **Tests:** none exists
- **Changed since 72847d01d:** grade absent → intentional-change (decision row 10, lead 10-30). No code change: defs.ts:76 and domquad.js:24 unchanged; the only commit touching these files since 72847d01d (24cac47b3) did not change the sidecar or the key.
- **Commits:** 24cac47b3
- **Note:** Still a difference from main (a library carrying only _emotes.json serves no emotes; /defs key is 'actionbar'; VR panel localStorage key differs). Now ruled on our side as intentional (decision row 10): the layout ships from our assets repo. Antra has not ruled.
- **Verified this run:** opened main defs.ts:70-80; v4 defs.ts:72-81 (grep), domquad.js:24,436,541; git grep '_emotes' at head; git log on defs.ts/domquad.js.

### [13,46,C3] Access words and help: members/visitors, visitor role, +gen/+fly

**restored**

- **Lean / ruling:** ruled: member everywhere; inhabitant killed, no alias; /access teaches the real words (unchanged rulings; no decision-table row)
- **Implementation (v4):** shared/protocol/roles.js:8-11 (base rung member, why visitor was renamed), :45 (RENAMED_ROLES visitor→member), :47 (renamedRole refusal text); client/lib/commands/handlers.js:180-191 (/access invite-only\|invite\|private\|closed\|listed\|watch\|spectators\|public\|open\|builders; unknown → notADoor), :121-167 (/grant incl. * ±gen ±fly → default-role merge :144-149), :91-93,:112 (/role and person lines show +gen/+fly); grep 'inhabitant' at head: 19 hits, all spec/REGISTRY-CHANGELOG.md
- **Migration:** translate-v1.js @24/@26 mainRights: main's '*' visitor → member (translate-check.ts:52-53 R22c)
- **Browser:** help teaches member; names +gen, +fly, /epoch; /access members\|visitors → teaching error (not a door)
- **Agent:** role refusals name member for a live 'visitor' (roles.js:47)
- **Vocabulary:** member (was visitor; inhabitant gone)
- **Specimen:** none named yet
- **Evidence — main:** client/lib/commands/handlers.js:106-112 (/access [members\|watch\|visitors\|open]; rung map members/private/closed → none, watch/spectators → spectator)
- **Evidence — v4:** shared/protocol/roles.js:8-11,45,47; client/lib/commands/handlers.js:91-93,112,121-167,180-191
- **Tests:** grant-command-test.ts:73-74 (help teaches no visitor role; names +gen/+fly//epoch), :82 (/access <bad word> sends nothing, teaches the four doors), :97 (/grant * +gen merges into default-role.can), :102 (/role shows +gen and +fly) — grant-command 23 passed, 0 failed (run this session; was 21); translate R22c (translate-check.ts:52-53) — translate 44/44 (run this session); roles-check.ts:97 (guest role, not 'visitor'); access-check / retired-commands not run this session · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: grant-command, translate
- **Changed since 72847d01d:** grade unchanged; handlers.js line numbers drifted (/access :182-191 → :180-191 holds; /grant :122-149 → :121-167; /role :104-112 → :112); grant-command suite 21 → 23 rows after 67c3586dd; 8ce290e07 reworded help/refusals.
- **Commits:** 8ce290e07, 67c3586dd, 3eb5c51c1, 2cf1e6de9, d00de504a, d43fe67f1
- **Note:** 67c3586dd re-opened: it touched handlers.js (1 line) plus accesspanel.js/rolespanels.js so the access panels and /grant keep an end, a guests default and a spawn's facing; grant-command-test gained 2 checks (21 → 23). Behaviour of the access words themselves unchanged. /access members\|visitors still errors, by ruling, with teaching (handlers.js:187 notADoor).
- **Verified this run:** opened main handlers.js:105-112; v4 roles.js:1-12 and :45,47; handlers.js :91-93,:112,:121-167 (grep),:180-192 (sed); grant-command-test.ts :73-74,:82,:84,:97,:99-102; translate-check.ts:52-53; roles-check.ts:57,97; git grep -c inhabitant; git show 67c3586dd --stat; ran grant-command (23/23) and translate (44/44) on wt-s-rows (same commit, clean).

### [51] Walking body (step / radius)

**intentional-change** · decision row 6

- **Lean / ruling:** decision row 6 — lead ruled 10-30: back to main's 0.55 m step ('Ruled, held': building it exposed an authority/stair-collider gap; an engine fix in a follow-up PR). Antra's ruling EMPTY. The tree at e1f21cc9a has NOT landed it.
- **Implementation (v4):** shared/mover.js:43 (radius: 0.2), :44 (height: 1.7), :45 (step: 0.8) — the tree still HAS 0.8 / 0.2; :82 (TRACK = MOVER.body)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** client/lib/colliders.js:30 (STEP = 0.55), :32 (TALL = 1.9), :703 (resolveColliders r = 0.32)
- **Evidence — v4:** shared/mover.js:43-45 (radius 0.2, height 1.7, step 0.8)
- **Tests:** mover-check.ts:7 (floor rule 'onto 0.7, onto 0.8, not 0.9' — pins the CURRENT 0.8), :62 (M0 TRACK is MOVER); not run this session. No row pins 0.55.
- **Changed since 72847d01d:** grade unchanged; a ruling now exists (decision row 6, 10-30) that the tree does not yet implement. mover.js touched by f63c65646/3eb5c51c1 (water drag, track widening) and by c04cb7b3a (the drag removed again) but body constants unchanged.
- **Commits:** f63c65646, 3eb5c51c1, c04cb7b3a
- **Note:** Ruled (row 6: back to main's 0.55 m) but NOT landed at this head: mover.js:45 still says step 0.8 and mover-check.ts:7 still pins the 0.7/0.8/0.9 floor rule, so the follow-up PR will have to move that test row too. Radius 0.2 vs main 0.32 not addressed by the ruling. Graded intentional-change (ruled, held for a follow-up), as the lead said.
- **Verified this run:** opened main colliders.js:28-32,700-706; v4 shared/mover.js:40-46 (sed) and :82 (grep); mover-check.ts :5-7,:50-62 (grep); git log on shared/mover.js.

### [S3-T1] Thing-level collide exact\|box → collider shape

**restored**

- **Lean / ruling:** ruled: SWEEP-3 routed T1 → translate agent (no objection recorded)
- **Implementation (v4):** shared/protocol/shaperepair.js:16 (comment: collider exact → mesh), :92 (shape 'exact' rewritten to 'mesh'); shared/protocol/componentspec.js collider shape vocabulary :52-56 (comments; 'mesh' is shapes.js's/KHR's word)
- **Migration:** via shaperepair.js:92 applied to every translated thing (translate-v1.js:834 shapeRepaired)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** shared/fold.js:205-207 (`collide` exact\|box is the spawner's override of the size-derived collider choice)
- **Evidence — v4:** shared/protocol/shaperepair.js:16,92; tools/protocol/import-v1/translate-v1.js:834
- **Tests:** translate S3-T1 (translate-check.ts:247-248: exact → mesh, box → box, 'boxy' → no collider + imported:collide) — translate-check 44 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** none in grade; translate-check row count 36 → 44; componentspec collider enum line :60 not re-found as a single enum line (the shape vocabulary is at :52-56 comments) — cited the shaperepair lines instead.
- **Commits:** 3eb5c51c1, 24cac47b3, 34c1753c2, 6293438e6
- **Verified this run:** opened main fold.js:203-207; v4 shaperepair.js:16,92 (grep), componentspec.js :52-56 (grep 'shape'), translate-v1.js:834, translate-check.ts:247-248; ran translate (44/44) on wt-s-rows (same commit).

### [S3-T2] Socket seatAnchor surface → body.anchor

**restored** · decision row 9

- **Lean / ruling:** ruled: routed to translate agent (SWEEP-3)
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:61 (comment, @33 pos default), :72 (seatAnchor === 'surface' → body.anchor 'surface'; pos ?? [0, 0.5, 0]); other seatAnchor values ride imported:sockets
- **Migration:** translate-v1.js:72 (@24; pos default @33)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main seatcore socketAnchor; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:61,72
- **Tests:** translate S3-T2 (translate-check.ts:262-265: 'surface' → body.anchor; 'hips' carried in imported:sockets) and DT9 (:258-261, no-pos seat at [0,0.5,0]) — translate-check 44 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: sockets, translate
- **Changed since 72847d01d:** line drift :68,73 → :61,72 (34c1753c2 added the @33 pos default on the same line); grade unchanged.
- **Commits:** 34c1753c2, 3eb5c51c1
- **Note:** main side cited from the sweep only (no main file:line opened) — strictly that makes the main leg of 'restored' weaker than the brief's bar; v4 code + row are confirmed.
- **Verified this run:** opened translate-v1.js:61,72 (grep); translate-check.ts:258-265; ran translate (44/44).

### [S3-X1] Translator clamps out-of-range values to spec

**restored**

- **Lean / ruling:** ruled: routed to translate agent
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:744-756 (toSpec: numbers clamped to the registry's ranges, a gt-bound field left to its default, text/lists cut, a path resampled to 64; each listed via adjust), :908 (unscalePivot + toSpec applied to every thing)
- **Migration:** translate-v1.js:745
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** n/a (main had no registry ranges)
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:744-756,908
- **Tests:** translate S3-X1 (translate-check.ts:266-272: sound radius 250 → 200, 70 points → 64, scale 5000 → 1000, light range 0 → default; each listed) — translate-check 44 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** line drift :689-700/:848 → :744-756/:908 (file grew @29 → @34); grade unchanged.
- **Commits:** 3eb5c51c1, 24cac47b3, 34c1753c2, 6293438e6, d43fe67f1
- **Verified this run:** opened translate-v1.js:744-756 (grep toSpec), :908; translate-check.ts:266-272; ran translate (44/44).

### [S3-L2/P1/M1] Light CSS colour names; particles.scale clamp; motion pivot on scaled things

**restored**

- **Lean / ruling:** ruled: routed to translate agent
- **Implementation (v4):** translate-v1.js:23 (import CSS_NAMES from ./cssnames.js), :43 (a CSS name read as three.js did); :683-684 (scale clamped 0.01..20, listed 'main drew a scale within 0.01..20'); :738 (unscalePivot), applied at :908
- **Migration:** as above
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (three.js read CSS names; main particles scale 0.01..20; main motioneval rotateAtPivot unscaled — per SWEEP-3, not opened on main this run)
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:23,43,683-684,738,908
- **Tests:** translate S3-L2 (translate-check.ts:273-274 'Red'/'rebeccapurple'), P17f (:97-98 scale 50 → 20, listed), S3-M1 (:275-276 pivot /scale, listed) — translate-check 44 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** line drift (:628-630 → :683-684; :683-687 → :738/:908); grade unchanged.
- **Commits:** 3eb5c51c1, 24cac47b3, 34c1753c2, 6293438e6, d43fe67f1
- **Verified this run:** opened translate-v1.js:23,43,683-684,738,908 (grep); translate-check.ts:97-98,273-276; ran translate (44/44).

### [S3-S1] Sky system skymesh + colors

**restored**

- **Lean / ruling:** ruled: routed to features agent (S1 restore system + colors)
- **Implementation (v4):** shared/protocol/componentspec.js:410 (sky fields system, colors), :412 (system enum eidoverse\|skymesh), :423 (colors doc: star/cloud/sky/fog/shield tints, 'SWEEP-3 S1, main's'); client/lib/sky.js:473-475 (a.system === 'skymesh' → impl skymesh), :1360-1363 (a.colors → skyApi.setColors)
- **Migration:** carried as spec fields (no rename)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main sky.system 'skymesh' and colors; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** shared/protocol/componentspec.js:410,412,423; client/lib/sky.js:473-475,1360-1363
- **Tests:** skystamp-test.ts:28-30 (sky {system:'skymesh', colors} stored) — not run this session; skypanel-state-test.ts:47-53 (system skymesh lines) — skypanel 18 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: skypanel
- **Changed since 72847d01d:** componentspec line drift (:407,420 → :410,412,423); sky.js lines held; grade unchanged.
- **Commits:** 8ce290e07, 3eb5c51c1
- **Verified this run:** opened componentspec.js:410-425; sky.js :473,:475,:1360-1363 (grep); skystamp-test.ts:28-30; skypanel-state-test.ts:47-53; ran skypanel (18/18) on wt-s-rows.

### [S3-N4] Light live-preview sliders

**restored**

- **Lean / ruling:** ruled: routed to features agent
- **Implementation (v4):** client/lib/inspect.js:28 (import previewLight from realize/models.js), :60-62 (registerHandler('light'): a finite number → previewLight(id, {[k]: n})), :159,:169 (opts.live path returns {ok, live} without sending)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main's light sliders previewed live; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** client/lib/inspect.js:28,60-62,159,169
- **Tests:** editcommit-test.ts:31 (light handler records live previews), :50-59 (two live commitEdits preview; the final sends ONE set light with the pre-drag expect) — not run this session (old matrix: 31/31 SEEN PASS)
- **Changed since 72847d01d:** inspect.js line drift (:59-63 → :60-62); editcommit-test rows located at :31,:50-59 rather than ':186+'; grade unchanged; not re-run.
- **Commits:** none
- **Verified this run:** opened inspect.js :28,:60-62,:159,:169 (grep); editcommit-test.ts :31,:42-59 (grep). git log on inspect.js not run (no behaviour claim changed).

### [S3-N5] /grant * +gen

**restored**

- **Lean / ruling:** ruled: routed to features agent
- **Implementation (v4):** client/lib/commands/handlers.js:121-125 (/grant doc), :144-149 (/grant * [role] ±gen ±fly → set @world default-role {role?, can} merge: true); shared/protocol/componentspec.js:493 (default-role fields role, can, guests)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main /grant * +gen; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** client/lib/commands/handlers.js:121-125,144-149; shared/protocol/componentspec.js:493
- **Tests:** grant-command-test.ts:94-99 ('/grant * +gen merges generate into default-role.can, keeping fly and the role' :97; '/grant * <role> -fly sets both' :99) — grant-command 23 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: grant-command
- **Changed since 72847d01d:** line drift (handlers :122-149 → :121-149 holds; componentspec :490 → :493); grant-command 21 → 23 after 67c3586dd; grade unchanged.
- **Commits:** 67c3586dd, 8ce290e07
- **Verified this run:** opened handlers.js :121-125,:139-149 (grep); componentspec.js:493; grant-command-test.ts :94-99; ran grant-command (23/23).

### [S3-N6] /role shows +gen

**restored**

- **Lean / ruling:** ruled: routed to features agent
- **Implementation (v4):** client/lib/commands/handlers.js:91-92 (extras: ' +gen' / ' +fly' from the permissions held), :93 (person lines), :112 (/role: 'you: <role> +gen +fly')
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main /role listed +gen; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** client/lib/commands/handlers.js:91-93,112
- **Tests:** grant-command-test.ts:100-102 ('/role shows +gen and +fly': myRights builder with generate+fly → /^you: builder \+gen \+fly/) — grant-command 23 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: grant-command
- **Changed since 72847d01d:** test leg upgraded from 'unverified' to a named row (grant-command-test.ts:102) seen passing; handlers lines :104-112 → :112; grade unchanged.
- **Commits:** 67c3586dd, 8ce290e07
- **Note:** The old note said no dedicated row was found; one exists at grant-command-test.ts:102 — the test leg is now verified.
- **Verified this run:** opened handlers.js :91-93,:112 (grep); grant-command-test.ts :99-102 (sed); ran grant-command (23/23).

### [S3-G1] Grass extras (maxSlope, windDir, variant, footprint…)

**restored**

- **Lean / ruling:** ruled: routed to translate agent
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:724 (grassExtras), :845 (a field with extras → @world.grass {fields…, strokes: [g]}), :500 (report lists them into @world.grass.strokes[0])
- **Migration:** translate-v1.js:845
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main createFlora read every key; per SWEEP-3 — not opened on main this run)
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:500,724,845
- **Tests:** translate S3-G1 (translate-check.ts:277-280: maxSlope/windDir/variant/footprint on the stroke, nothing in imported:grass, mapping listed) — translate-check 44 passed, 0 failed (run this session) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** line drift (:664-668 → :724/:845/:500); grade unchanged.
- **Commits:** 3eb5c51c1, 24cac47b3, 34c1753c2, 6293438e6, d43fe67f1
- **Verified this run:** opened translate-v1.js :500,:724,:845 (grep); translate-check.ts:277-280; ran translate (44/44).

### [S3-L1] Light decay / translated lights scaled for parity

**restored** · decision row 23

- **Lean / ruling:** ruled: keep physical decay 2; translator scales translated lights once for parity; docs fixed. Plus decision row 23 (lead yes 10-29): emissive = glow only; translator writes main's inferred lamps as light children; no engine-side inference for placed models.
- **Implementation (v4):** shared/protocol/componentspec.js:100 (comment: 25.93 = main's 16 cd at decay 1.7 matched at 5 m), :102 (defaults intensity 25.93, range 10, decay 2), :107-108 (absentMeans decay 1.7 / intensity 16 for pre-10-16 lights, repaired by the maintenance command); translate-v1.js:730 (parityIntensity = intensity × (range/2)^0.3), :731-733 (lightParity, listed), :834 (applied unless the light wrote its own decay); lamps: :513-518 (lampMappings report), :665-670 (lampPartsOf: up to two light children per glowing model, range 12, decay 2, parity brightness), :836 (written for a model with no light of its own). Client: lightrig.js:427 attachLamps (emissive → inferred lamp) is called ONLY from avatar.js:610 (bodies); realize/models.js does not call it (grep), so a placed glowing model glows only.
- **Migration:** translate-v1.js:730-733 (parity), :665-670/:836 (lamps as light children, @31)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** (main rig decay 1.7, 16 cd default; main inferred up to two lamps per glowing model — per SWEEP-3/decision row 23; not opened on main this run)
- **Evidence — v4:** shared/protocol/componentspec.js:100,102,107-108; tools/protocol/import-v1/translate-v1.js:513-518,665-670,730-733,834,836; client/lib/lightrig.js:427 (callers: avatar.js:610 only)
- **Tests:** translate S3-LP (translate-check.ts:286-288), S3-LD (:293-295 a light with no intensity = main's 16 brightened once, landing on the registry default), S3-RP (:281-285 report carries adjustments) and F51-53 (header :10: inferred lamps as light children) — translate-check 44 passed, 0 failed (run this session); light-readers not run · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** evidence added: lamps-as-light-children (3eb5c51c1, decision row 23) and the prefab revert (3cee6acc6 → f8b07505b); line drift (componentspec :97-99 → :100-108; translate :674-681 → :730-733); grade unchanged.
- **Commits:** 3eb5c51c1, 3cee6acc6, f8b07505b, 24cac47b3, 34c1753c2, 6293438e6
- **Note:** Glowing-model prefab (3cee6acc6: a glowing library model placed as a prefab with light children) was REVERTED by f8b07505b; the tree at head has no prefab. What the tree does: translator writes main's lamps as light children (3eb5c51c1, @31; decision row 23); a freshly placed glowing model glows only (attachLamps only on avatars). 'docs fixed' leg still not verified (no doc line opened for L1).
- **Verified this run:** opened componentspec.js:96-112; translate-v1.js :513-518,:665-670,:730-733,:834,:836 (grep); lightrig.js:425-485 (sed) and git grep attachLamps callers; git show --stat 3cee6acc6 and f8b07505b; translate-check.ts :281-295; ran translate (44/44).

### [S3-S4] Doc rot (5 lines)

**unverified**

- **Lean / ruling:** ruled: routed to features agent (docs)
- **Implementation (v4):** The five lines are still not enumerated anywhere I can read (SWEEP-3.md:21 lists 'S4 \| doc rot (5 lines) \| docs'; :28 says 'SHOW_RUNBOOK partly fixed (still stale :81)'). What I checked at head: grep for the suspected stale words `log.jsonl`, `WORLD_ADMIN`, `snap-result`, `join founds` across deploy/SHOW_RUNBOOK.md, docs/REMOTE-SCREENSHOTS.md, docs/UPSTREAM-FLAGS.md, docs/NATIVE-WORLD-RENDERING.md, docs/draw-calls.md → only SHOW_RUNBOOK.md:22, which correctly says SERVER_OPERATORS 'Replaces WORLD_ADMIN, still read for one release'. Wider docs/: `log.jsonl` only as fixture/oracle filenames (GATE-MANIFEST.md:98,124-125; spec/fixtures/01-build/log.jsonl exists); WORLD_ADMIN in INCIDENTS.md:2029-2044 (historical) and TRANSLATING-OLD-WORLDS.md:226-244 (the upgrade guide, intentional). `snap-result` / `join founds`: no hits. REMOTE-SCREENSHOTS.md:3 names `screenshot` with `snapshot` refused until 2026-12-01.
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** n/a
- **Evidence — v4:** deploy/SHOW_RUNBOOK.md:22,79-83; docs/REMOTE-SCREENSHOTS.md:3,6,44; docs/GATE-MANIFEST.md:98,124-125; docs/TRANSLATING-OLD-WORLDS.md:226-244; docs/INCIDENTS.md:2029-2044
- **Tests:** none exists
- **Changed since 72847d01d:** grade unchanged; evidence added (greps across the named docs; SHOW_RUNBOOK :81 compared old head vs head: unchanged).
- **Commits:** ce6950a28, 5d9d50707, d04f1a13e, 36ef9ac13, e66a21a79, 4a97e42bf
- **Note:** Kept unverified: the sweep's five lines are not enumerated, so 'each fixed' cannot be asserted. Findings: none of the four suspected stale words survives as a stale usage in the five named docs. SHOW_RUNBOOK's 'still stale :81' — line 81 at 72847d01d was '7. Rotate/remove any pre-show MCPL dev tokens (mcpl/tokens.json … rotate the fable token at deploy)'; it is unchanged at head (now :81 too; mcpl/tokens.json is referenced by mcpl/mention.ts but no such file is in the tree, which may be the 'stale'). ce6950a28/5d9d50707/d04f1a13e are text-follows-code fixes (login origin, read-back by role, help wording), not obviously the S4 lines. 5deab3306 is not in the 72847d01d..e1f21cc9a range of these files (it is wt-pr15's head).
- **Verified this run:** grepped the five named docs + docs/, deploy/, AGENTS.md, README.md for the four words; opened SHOW_RUNBOOK.md:75-90 at head and :79-83 at 72847d01d via git show; opened REMOTE-SCREENSHOTS.md:1-6,39-44 (grep); git log on the five docs; SWEEP-3.md:21,28.


## Access, moderation, operators (12 rows)

### [6] Add someone not present (directory, add all)

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'Already settled': 'access panel: seen-people + exact id (6)'
- **Implementation (v4):** client/lib/accesspanel.js:5-6 (names looked up only among people this world has seen; exact u-… id otherwise; no server-wide search), :14 (ID regex), :28 (whois by id), :56 (whois by name), :61 (nobody-called hint → paste u-…), :80 ('ends ▸' select), :88 (Add someone input); server/requestwire.ts:34-42 (whois scoped to THIS world), :149 (whois dispatched on the server's directory)
- **Migration:** n/a
- **Browser:** accesspanel.js: Add someone (name seen here or u-… id), role select, 'ends ▸' end select, ✕ revoke; no add all
- **Agent:** grant only to known identities (whois scoped to this world)
- **Vocabulary:** roles:<id> {role, until?}
- **Specimen:** none named yet
- **Evidence — main:** client/lib/accesspanel.js:199-200 (add someone), :212 (access-directory lookup), :260 (add all N); :57 access-directory bus
- **Evidence — v4:** client/lib/accesspanel.js:5-6, :14, :28, :56, :61, :80, :88; server/requestwire.ts:34-42, :149
- **Tests:** access-panel AP0-AP4b, AP7/AP7b (ends ▸ merges only the end; access-panel-probe.ts:63-115, AP7 at :103, AP7b :105), AP8 (:112) — browser lane (suites.ts:136, BROWSER list :221); NOT RUN (browser suite)
- **Changed since 72847d01d:** grade unchanged; evidence: accesspanel.js gained the 'ends ▸' end select (:80) and rows AP7/AP7b/AP8; requestwire whois moved to :34-42/:149
- **Commits:** 62b250e47, 67c3586dd
- **Note:** No global directory, no 'add all' by design (ruled). Since 72847d01d: 62b250e47 (a row's 'ends' select merges only the end; owner filter once) and 67c3586dd (an end, a guests default, a spawn's facing the panels kept or lost by mistake) — bug fixes, not a shape change; AP7/AP7b/AP8 are the new rows.
- **Verified this run:** opened v4 client/lib/accesspanel.js:5-6,14,28,56,61,80,88; server/requestwire.ts:34-42,149; tools/protocol/access-panel-probe.ts:63-115; suites.ts:136,221; main accesspanel.js:57,199-200,212,260. Browser suite not run.

### [22] Default rights of translated worlds

**intentional-change** (was **partial**) · decision row 26

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:47: RESTORE old effective rights as explicit grants… the translator must give an ownerless v1 world explicit builder for everyone'; then decision row 26 'Every translation ends with an owner' (our side yes 10-29; Antra's ruling column EMPTY — still a proposal upstream)
- **Implementation (v4):** tools/protocol/import-v1/translate-v1.js:133-135 (@30/@31 history: imported:ownerless lift written at @30, deleted at @31), :762 (ownedIn), :766-786 (mainRights: owned → '*' as default-role / access; OWNERLESS → default-role {role: builder, guests: builder} + role-defs.builder.can.generate, note 'Every translation ends with an owner (the upgrader's claim)'), :863-866 (written into @world; a grant below builder in an ownerless world is builder); shared/protocol/roles.js:153-162 (roleIdOf: a world with no owner caps everyone at member — no imported:ownerless escape any more); tools/protocol/world.ts:4-6, :77-79 (--claim needs EIDO_UPGRADER_ACCOUNT), :152 (claimed line); tools/protocol/import-v1/world.ts:233 (ownerlessRefusal: a translation without an owner is refused)
- **Migration:** translate-v1@31 mainRights(): owned + no '*' → default-role {role: builder, guests: builder}; '*' gen → default-role.can.generate (+note guests can't); '*' visitor → member; '*' none/spectator → access {join: listed(, watch: anyone)}; OWNERLESS → default-role builder for everyone incl. guests, builder role-defs gain generate (never fly), '*' unread (as main), every grant below builder lifted to builder; the translation MUST end with an owner (CLI --claim or a recognised owner; server/upgrade.ts passes --claim), so these are ordinary grants under that owner; no imported:ownerless written
- **Browser:** —
- **Agent:** —
- **Vocabulary:** default-role, role-defs.builder.can.generate; imported:ownerless GONE (@31)
- **Specimen:** none named yet
- **Evidence — main:** shared/rightsfold.js:49-50 (rightsIn: no owner → {role: builder, gen: true, fly: false}, grants and '*' unread)
- **Evidence — v4:** tools/protocol/import-v1/translate-v1.js:133-135, :762, :766-786, :863-866; shared/protocol/roles.js:153-162; tools/protocol/world.ts:4-6, :77-79, :152; tools/protocol/import-v1/world.ts:233
- **Tests:** translate R22a-R22h (translate-check.ts:46-74; R22e :56-61 'an ownerless world, once its upgrader claims it: everyone else, guests too, is builder … no imported:ownerless'; R22g :62-65; R22h :66-71 roles.js cap) + S3-RP (:281-285); owners CL1-CL11 (owners-check.ts:207-264: CL2 :212 everyone keeps main's ownerless rights; CL5 :234 locks lifted by a regular; CL8 :241 who: builder gate admits a regular; CL9 :244; CL10 :246 moderation stays refused; CL11 :264 no imported:ownerless, member cap returns once the owner leaves). owners suite RUN this run: see verified · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: owners, translate
- **Changed since 72847d01d:** partial → intentional-change: the rank-word deviation is fixed (everyone is rank builder, d43fe67f1) and the ownerless lift is deleted — every translation now ends with an owner (3eb5c51c1, decision row 26); new rows R22g/R22h, owners CL5/CL8-CL11
- **Commits:** d43fe67f1, d00de504a, 2cf1e6de9, 3eb5c51c1, e1f36e745
- **Note:** The 72847 DEVIATION (rank stayed member; `who: builder` gates refused everyone) is GONE: d43fe67f1 (@30) made an ownerless translated world builder for everyone rank and all, via an @world imported:ownerless lift of roles.js's cap; d00de504a scoped that lift; 2cf1e6de9 ended it at the first owner; 3eb5c51c1 (@31) deleted the lift entirely: every translation ends with an owner (CLI refuses without --claim / a recognised owner; the server's upgrade always claims), and the old 'ownerless' rights are plain grants under that owner. Main's effective rights (everyone builder+gen, guests too) are restored as explicit grants; what differs from main is the OWNER (main had none) — decision row 26, our side yes 10-29, Antra's column empty. Also still differs: default-role.can.generate doesn't reach guests in an OWNED '*'-gen world (translate-v1.js:777 note; R22b). Graded intentional-change rather than restored because the rights are the same but the ownership model is not main's.
- **Verified this run:** opened v4 translate-v1.js:133-135,760-786,860-866; roles.js:150-175; tools/protocol/world.ts:1-20,77-79,152; translate-check.ts:2,45-74,281-285; owners-check.ts:33-41,207-264; main rightsfold.js:45-53. `git grep imported:ownerless e1f21cc9a -- shared server tools` → only comments/tests asserting its absence. owners suite RUN: eido-suites.sh wrapper printed NO TALLY on its first (backgrounded) attempt; a direct `bun tools/protocol/run.ts owners` under the same lock/env printed `[owners-check] 45 passed, 0 failed` and `total 1 passed, 0 failed, 0 skipped`

### [23] WORLD_ADMIN entries and operator powers

**intentional-change** · decision row 1

- **Lean / ruling:** ruled: MORNING-ASKS 'SERVER_OPERATORS, fail-closed (23)' settled; 'S2 keep + explain' (the lead 12:30) → owners build; decision rows 1 (who may upgrade), 2 (first-run setup link), 3 (cookies cross-site) — our side yes 10-28 on all three; Antra's ruling column EMPTY on all three (proposals upstream)
- **Implementation (v4):** server/operators.ts:1 (by ACCOUNT only), :4 (bare entry refused loudly, never silently), :7 (WORLD_ADMIN legacy, read + merged one release, warned), :9 (setup claimant stored in OPERATORS_FILE), :17 (.operators.json), :19 (SERVER_OPERATORS + legacy WORLD_ADMIN), :28-32 (refusal names the variables and the exact form; boot continues), :35 (deprecation warn), :52-53 (claimSetup: timing-safe token, account must contain ':'); server/setup.ts:1-2, :11, :15 (setupLine), :41-46 (POST /setup: an explicit Bearer is the claimant over the ambient cookie — 766bd4684); server/server.ts:1351 (token printed once), :757-766 (rightsFor: operator → gen+fly only, role from the authority); server/routes.ts:589-591 (/setup only while no operator); server/requestwire.ts:217-239 (operator-repair needs an operator's account, re-checked at the queue, recorded operator: true); server/messages.ts:447 (global moderation operator-only), :480/:489 (an operator can't be globally banned); server/auth.ts:71-86 (Sec-Fetch-Site rule; HN_NATIVE_ORIGIN exact origin — 2dee96dee); server/custody.ts:1-4 (governance keys outside every log, 0600; db5d5c58e: a key handed out only once the keys file holds it); docs/TRANSLATING-OLD-WORLDS.md:3
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** server operator (hygiene role-words refuses WORLD_ADMIN / world admin / world operator outside the legacy reader and migration notes)
- **Specimen:** none named yet
- **Evidence — main:** server/rights.ts:30-32 (ADMIN_IDS from WORLD_ADMIN: 'owner+gen EVERYWHERE')
- **Evidence — v4:** server/operators.ts:1,:4,:7,:9,:17,:19,:28-32,:35,:52-53; server/setup.ts:1-2,:11,:15,:41-46; server/server.ts:1351,:757-766; server/routes.ts:589-591; server/requestwire.ts:217-239; server/messages.ts:447,:480,:489; server/auth.ts:71-86; server/custody.ts:1-4; docs/TRANSLATING-OLD-WORLDS.md:3
- **Tests:** identity C3 + C3b + C3m (identity-check.ts:6-7 header, :92-97, :115-123); setup SU* (not re-opened); access A11 (access-check.ts:233-236: narrow recorded operator-repair; a non-operator's refused); owners CL6 (owners-check.ts:250: operator-repair set keeps builder's generate) and the operator-repair bind rows (280998fc0/6e6184c60, owners suite). NOT RUN except owners (see verified) · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: owners
- **Changed since 72847d01d:** grade unchanged; evidence hardened: setup Bearer precedence (766bd4684), bounded setup reads (e849013e4), operator-repair bind scope (280998fc0, 6e6184c60), exact-origin socket rule (2dee96dee), custody key hand-out (db5d5c58e); server.ts rightsFor now :757-766 (was :758-766); messages.ts global-ban refusal :447 (was :446); requestwire operator-repair :223/:229 (was :224)
- **Commits:** 766bd4684, e849013e4, 0421f53a3, 280998fc0, 6e6184c60, 2dee96dee, db5d5c58e, 219fb213b, 8ce290e07
- **Note:** Grade unchanged. Since 72847d01d: 766bd4684 (setup: an explicit Bearer is the claimant over the cookie; an invalid one refuses, never the cookie's account), e849013e4 (setup reads bound by actual request bytes), 0421f53a3, 280998fc0/6e6184c60 (operator-repair bind: an imported identity is bindable only by its own record in the world, never by a third party's mention), 2dee96dee (auth: a signed-in socket without Sec-Fetch-Site opens only from one exact origin — decision row 3), db5d5c58e (custody: a governance key handed out only once the keys file holds it), 219fb213b (custody lock wait). Decision rows 1-3 are our side's yes; Antra's column is empty on each.
- **Verified this run:** opened v4 operators.ts:1-35,52-53; setup.ts:1-46; server.ts:22-23,757-768,1351; routes.ts:89-90,589-591; requestwire.ts:217-239; messages.ts:447,480,489; auth.ts:71-86; custody.ts:1-12; identity-check.ts:6-7,92-123; access-check.ts:233-236; docs/TRANSLATING-OLD-WORLDS.md:3; main rights.ts:28-34. 0421f53a3 not opened (named by the lead's pointer only). Suites identity/setup/access NOT run.

### [24] Global bans stored by name

**restored**

- **Lean / ruling:** ruled: MORNING-ASKS 'the lead 11:35 yes: the Minecraft migration: at boot resolve each name to the account that used it (world logs + directory) → account ban; ambiguous/unresolved KEPT and listed… never silently dropped'
- **Implementation (v4):** server/moderation.ts:25 (refusedBans: never enforced, written back as they were), :30 (PENDING_WORDS), :42-57 (restoreBans: bind when main recorded exactly ONE account, else pending with a why; WARN 'check it' :56; pending listed :57, kept on disk), :65-67 (boot: mainKnowledge read only when a name-only record exists), :74-77 (globalBansText lists bound-by-name and pending), :81 (takePending); server/mainknew.ts:1-4 (.principals.json + world logs: which account main recorded for a NAME); server/messages.ts:451 (list shown incl. pending), :468 (unban lifts pending), :497 (takePending binds a pending name on the next ban)
- **Migration:** n/a for .bans.json (server-side at boot, not the translator); the world log's own bans:<id> → imported-bans:<id> (translate-v1.js:240 rename note, :882 written), account subs scrubbed (:205, :626)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** server/messages.ts:727 (globalBans[id.toLowerCase()] = {by, ts, reason?, sub?}: name-keyed, sub only if the target was connected)
- **Evidence — v4:** server/moderation.ts:25,:30,:42-57,:65-67,:74-77,:81; server/mainknew.ts:1-4; server/messages.ts:451,:468,:497; translate-v1.js:240,:882
- **Tests:** translate B24a (translate-check.ts:126), B24b (:131), B24c (:135), B24e (:146-152 malformed record kept, never dropped), B24f (:153), B24d (:159-160 the old 'dropped' log line is gone from the source); · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** none (line numbers re-checked: moderation.ts :26-30 → :25-30, :42-62 → :42-57, :65-68 → :65-67, :73-78 → :74-77; messages.ts :451/:497 unchanged)
- **Commits:** none
- **Note:** Matches the ruling. One edge: a one-account match binds on a self-chosen name (WARN 'check it', moderation.ts:56, B24f) — by design. No commit touched server/moderation.ts, server/mainknew.ts or the B24 rows since 72847d01d (`git log 72847d01d..e1f21cc9a -- server/moderation.ts server/mainknew.ts` → empty).
- **Verified this run:** opened v4 moderation.ts:13,20-30,42-57,65-67,74-81,98; mainknew.ts:1-4; messages.ts:31,451,468,497; translate-v1.js:205,240,626,882; translate-check.ts:126-160; main messages.ts:725-729. Suite not run.

### [25,26,27] Public reads, API shapes, limits

**partial** · decision row 21

- **Lean / ruling:** ruled: MORNING-ASKS 'RATE becomes server policy… delete VERB_RATE… FOLD_EVERY deleted' (the lead 12:14) = decision row 5 (our side yes 10-28); S1 cookie rule = decision row 3; /worlds agents list = decision row 21 (the lead 10-30: restore the agents list for now, '3 humans, 1 agent', never 'people' for humans only; Antra's column empty)
- **Implementation (v4):** server/config.ts:135 (STATE_CACHE_EVERY replaces FOLD_EVERY), :143-153 (ACT_RATE, SAY_RATE, RATE_WINDOW_SEC, RATE_KIB, ANON_RATE_KIB → RATE_POLICY), :155-157 (FORK_GAP_SEC/FORK_PER_HOUR, 0 = none); shared/protocol/authority/gate.js:60 (RATE_DEFAULT), :71 (w.rate injected); server/worldlog.ts:15, :121 (rate: RATE_POLICY into openLive); server/routes.ts:778-811 (/worlds: name, loaded, access, you, people[{id, declares?}] = everyone, agents: [ids] = those who declared agent, §6a — RESTORED e1f21cc9a); server/auth.ts:71-86 (Sec-Fetch-Site cookie rule). ABSENT: `git grep -n 'VERB_RATE\\|FOLD_EVERY' e1f21cc9a -- server shared client mcpl tools` → 0 hits
- **Migration:** n/a
- **Browser:** —
- **Agent:** /geom lost mounts/simAt; /worlds agents list BACK (the worlds tool says 'N humans, M agents')
- **Vocabulary:** access words renamed; /worlds `agents` restored (by declaration, never inferred)
- **Specimen:** none named yet
- **Evidence — main:** server/verbs.ts:16 (VERB_RATE import), :757 (verbCount > VERB_RATE); server/routes.ts:755-762 (/worlds {people: non-agents, agents: agents})
- **Evidence — v4:** server/config.ts:135,:143-157; shared/protocol/authority/gate.js:60,:71; server/worldlog.ts:15,:121; server/routes.ts:778-811 (agents at :808); server/auth.ts:71-86
- **Tests:** fork-reset FL1-FL4 (fork-reset-check.ts:179-193: FORK_*=0 none; ACT_RATE reaches the authority); agenttools AT12 (agenttools-check.ts:237-240: /worlds' agents lists the declared agent; people is everyone; tool says '1 human, 1 agent'); names W1/W2 (names-check.ts:343-347, mutants :68-69); tools/worlds-route-test.ts:104,:116 (agents beside people) — NOT in suites.ts (`grep worlds-route tools/protocol/suites.ts` → 0; it is a hand-run script, header :4); authority RP2 (2332a79e3: say bytes counted in UTF-8; authority-check.ts:1385-1387). fork-reset suite RUN this run: see verified · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools, fork-reset
- **Changed since 72847d01d:** stays partial but the /worlds agents list is RESTORED (e1f21cc9a, decision row 21; rows AT12, W1, W2); config.ts RATE lines :141-153 → :143-153; routes /worlds :778-808 → :778-811; say bytes counted in UTF-8 (2332a79e3)
- **Commits:** e1f21cc9a, 2332a79e3, 8ce290e07
- **Note:** Part RESTORED at the head: e1f21cc9a brings back /worlds `agents: [ids]` (decision row 21). Difference from main that remains: main's `people` EXCLUDED agents (routes.ts:760 main `!c.agent`); v4's `people` is everyone with a `declares` tag and `agents` is a subset — the ruling says 'people stays everyone' so this is the ruled shape, not a slip. Still partial because: /geom's mounts/simAt stay absent; the rename of access words has no alias; and the worlds-route test that pins the field is not in a gated suite (only AT12/W1/W2 are). 2332a79e3 tightened the byte-rate window to UTF-8 bytes (shared/protocol/authority/verbs.js). 'agents' is by declaration (§6a) — an undeclared agent counts as human, which main's `c.agent` flag did not do.
- **Verified this run:** opened v4 config.ts:135-158; gate.js:60,71; worldlog.ts:15,121; routes.ts:70,744,775-815; auth.ts:71-86; agenttools-check.ts:22,237-240; names-check.ts:68-69,343-347; tools/worlds-route-test.ts:1-4,71,104,116; authority-check.ts:1385-1387; fork-reset-check.ts:179-193; main routes.ts:755-765, verbs.ts:16,757. fork-reset suite RUN via eido-suites.sh: `total 1 passed, 0 failed, 0 skipped`

### [28] Builder mode on phones; VR buttons

**intentional-change** (was **unverified**) · decision row 20

- **Lean / ruling:** decision row 20 (the lead 10-30: keep as built — our VR code); in-code owner refs: build.js:81 'the lead, 10-06 23:39', xr.js:1261 'owner, 10-02'. Antra's column empty.
- **Implementation (v4):** client/lib/xr.js:1261-1262 (jump = RIGHT A only; LEFT A/X was jump, VRChat makes it the mic), :1264 (same when no left stick), :1270 (LEFT buttons[4] = mic); client/lib/build.js:81-85 (editSurface: no edit mode on a coarse pointer < 600 px)
- **Migration:** n/a
- **Browser:** VR: right A = jump; left X/A = mic; no edit mode on a phone
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** client/lib/xr.js:1113-1115 (jump = A or X, either hand; 'no invented bindings on the sticks', owner 09-06)
- **Evidence — v4:** client/lib/xr.js:1261-1262, :1264, :1270; client/lib/build.js:81-85
- **Tests:** none exists; NOT RUN
- **Changed since 72847d01d:** unverified → intentional-change: decision row 20 (the lead 10-30) rules the phone/VR bindings stay as built; code unchanged (xr.js :1260-1268 → :1261-1270; build.js :81-85 same)
- **Commits:** 3cee6acc6, f8b07505b
- **Note:** Now ruled: decision row 20, the lead 10-30 'keep as built'. The only xr.js commits since 72847d01d are 3cee6acc6 and its revert f8b07505b (glowing prefab), which net to nothing in this block. The old row's 'VR B/Y = panels hide' claim is dropped from `browser`: not read in this block on either side; unverified in a headset.
- **Verified this run:** opened v4 xr.js:1261-1270 (grep), build.js:81-85; main xr.js:1111-1116. No headset check.

### [30] Old worlds reachable (operator upgrade)

**restored** · decision row 1

- **Lean / ruling:** ruled: 'old-world upgrade button (30)' settled (MORNING-ASKS); who may upgrade = decision row 1 (operator or bound owner; an ownerless world goes to whoever upgrades it — our side yes 10-28, Antra's column empty) + decision row 26 (every translation ends with an owner, yes 10-29)
- **Implementation (v4):** server/server.ts:387-390 (mid-swap never served, 4005), :392-406 (old-format refusal names who may upgrade; ownerOf for a signed-in non-operator); server/upgrade.ts:7 (an ownerless world's upgrader becomes its owner, --claim), :31 (upgrade: 'operator-or-owner'), :53 (ownerOf), :95-121 (claimEnv; the CLI run with --claim; 'You're now this world's owner.'); client/lib/upgradeview.js:2, :28 (claimWords), :48, :73 (Back up and upgrade); docs/TRANSLATING-OLD-WORLDS.md:58, :142-147
- **Migration:** the upgrade runs tools/protocol/world.ts translate in place with --claim (translate-v1@34); approval hash covers the output
- **Browser:** upgradeview.js splash: Review upgrade → claim words → Back up and upgrade
- **Agent:** MCPL join error names who may upgrade (operator or owner) + doc
- **Vocabulary:** refused {code: old-format, doc, upgrade: operator-or-owner \| operator-cli, operator, may, owner?}
- **Specimen:** fixtures/water-old-v1; world A / world B (private, pending); any old-format world
- **Evidence — main:** server/routes.ts:61 (a world = worlds/<name>/log.jsonl, served as-is)
- **Evidence — v4:** server/server.ts:387-390, :392-406; server/upgrade.ts:7, :31, :53, :95-121; client/lib/upgradeview.js:2, :28, :48, :73; docs/TRANSLATING-OLD-WORLDS.md:58, :142-147
- **Tests:** upgrade US1-US15 (upgrade-check.ts header :12-27: US9 ownerless → upgrader is owner; US10 bound owner; US11 owner by name; US12 another account refused; US15 rate before owner check), UB1-UB11, UD (:28-29); owners CL1-CL7 (owners-check.ts:207-223: --claim, rollback forgets the claimant, splash words). upgrade suite RUN this run: see verified · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: owners, upgrade
- **Changed since 72847d01d:** grade unchanged; the ownerless half is now mandatory (3eb5c51c1, decision row 26); server.ts refusal :392-405 → :392-406; upgrade.ts claim lines :95-121 added; doc lines moved (:131 → :142-147)
- **Commits:** 3eb5c51c1, d43fe67f1, d00de504a, ce6950a28, e66a21a79, 6e6184c60, 766bd4684, 24cac47b3
- **Note:** Grade unchanged. 3eb5c51c1 makes the claim mandatory (a translation names an owner or is refused: import-v1/world.ts:233 ownerlessRefusal), so 'ownerless claimed' is now the only path — matches decision row 1's text. ce6950a28/e66a21a79 re-aligned the doc text. Still open upstream: Antra's yes on rows 1 and 26.
- **Verified this run:** opened v4 server.ts:385-406; upgrade.ts:7,31,53,87-121 (grep); upgradeview.js:2,28,48,73; docs/TRANSLATING-OLD-WORLDS.md:58,142-158; upgrade-check.ts:10-30; owners-check.ts:207-223; tools/protocol/import-v1/world.ts:233 (grep); main routes.ts:59-63. upgrade suite RUN via eido-suites.sh: `total 1 passed, 0 failed, 0 skipped`

### [31] Founding a world

**intentional-change** · decision row 5

- **Lean / ruling:** ruled: MORNING-ASKS '31 → server policy, NO limits until studied (the lead 12:04)' = decision row 5 (our side yes 10-28; Antra's column empty)
- **Implementation (v4):** server/config.ts:158 ('Founding a world: no limits (the lead 10-28…)'); server/worldlog.ts:465 (sets no quotas: the runner's policy), :473 (foundRefusal: name grammar + exists only), :481; server/requestwire.ts:263-264 (world-found); server/server.ts:410 (joining never founds); shared/protocol/authority/verbs.js:43 (founding writes bounds min y −50 — d08745574, KillZ). ABSENT: `git grep -n -i 'per account\\|quota\\|3 worlds' e1f21cc9a -- server/worldlog.ts server/server.ts` → 2 hits, both comments saying there is none (worldlog.ts:465) / unrelated (server.ts:567 one identity per account)
- **Migration:** n/a
- **Browser:** —
- **Agent:** travel to new name refused
- **Vocabulary:** world-found
- **Specimen:** none named yet
- **Evidence — main:** server/server.ts:742-745 (a brand-new world belongs to whoever first walks in embodied: join founds)
- **Evidence — v4:** server/config.ts:158; server/worldlog.ts:465, :473, :481; server/requestwire.ts:263-264; server/server.ts:410; shared/protocol/authority/verbs.js:43
- **Tests:** fork-reset FD3 (fork-reset-check.ts:159: no quota, one account founds five); fork-reset suite RUN this run: see verified · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: fork-reset
- **Changed since 72847d01d:** grade unchanged; founding now writes bounds down to y −50 (d08745574); config.ts comment :159 → :158; worldlog foundRefusal :473-477 → :473/:481 (same); requestwire world-found :258 → :263; server.ts 'joining never founds' :384-386 → :410
- **Commits:** d08745574, 9c30e6416
- **Note:** Join-founding stays retired (security review 10-06 H3) — intentional. NEW since 72847d01d: d08745574 — founding writes a build box down to y −50 (bounds min [-20, -50, -20]) so a new world's kill line is −100 (the lead 10-29; Nissa's #15 review); a shape change to what founding writes, not to who may found. Decision row 5 is our side's yes; Antra's column empty.
- **Verified this run:** opened v4 config.ts:158; worldlog.ts:465,473,481 (grep); requestwire.ts:10,263-264; server.ts:410; shared/protocol/authority/verbs.js:43 (grep); fork-reset-check.ts:159; main server.ts:740-746. fork-reset suite RUN via eido-suites.sh: `total 1 passed, 0 failed, 0 skipped`

### [32] Speech arrival-only

**intentional-change** · decision row 11

- **Lean / ruling:** ruled: the lead 10-18 (cited in code); MORNING-ASKS 'Antra confirmed say stays in the log; chat filtered per visitor by arrival time'; decision row 11 (catch_up's description: done fc183b4f3, AT10)
- **Implementation (v4):** server/server.ts:830-832 (recentChat: [] always; chatTotal 0 unless isAdmin); server/world.ts:147 (isAdmin = operator or a readChat holder), :152, :157; d04f1a13e (docs/comments: owner, operators AND readChat holders read back — AGENTS.md, WIRE.md, messages.ts:83, world.ts, net-server.ts, smoke.ts)
- **Migration:** n/a (say entries are translated and stay in the log; served per arrival)
- **Browser:** no backscroll for joiners
- **Agent:** catch_up arrival-only (row 29; decision row 11 done)
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** shared/fold.js:346-350 (say → st.recentChat.push, chatTotal++, trimRecentChat: a window folded for joiners)
- **Evidence — v4:** server/server.ts:830-832; server/world.ts:147, :152, :157; server/messages.ts:83
- **Tests:** identity RS10 (identity-check.ts:29 header, :356-358: no say before arrival reaches a non-admin by history, authority history or join window; an owner reads the master log); NOT RUN this run (SEEN PASS 100/100 at 72847d01d)
- **Changed since 72847d01d:** grade unchanged; text aligned with the code (d04f1a13e: readChat holders named in docs/comments); server.ts recentChat :829-832 → :830-832
- **Commits:** d04f1a13e
- **Note:** Intentional change, owner-dated. d04f1a13e (text only, Stella #260 q4) fixed four comments and two docs that said 'owner/operator only' where the code says readChat holders too. D6 (SWEEP-2): tools/chat-scrollback-test.ts still exists at the head and tests a join window no joiner receives (partly vacuous) — unchanged.
- **Verified this run:** opened v4 server.ts:830-832; world.ts:147,152,157 (grep); messages.ts:83; identity-check.ts:29,309,356-358; `ls tools/chat-scrollback-test.ts` exists; main fold.js:345-350. Suite not run.

### [34] Per-person invisible spectator

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'spectator intentional (34)' settled; the lead 10-27 'anti-spying; invisible watching is for probes only'
- **Implementation (v4):** shared/protocol/roles.js:8-9, :15 ('There is no rung below member'), :34 (RANK), :45 (RENAMED_ROLES visitor→member); translate-v1.js:182-183, :285-286 (FATES text), :771 (DOOR_OF), :859-860, :875 (a person's spectator/none carried as imported-roles:<id>, not granted)
- **Migration:** translate-v1@34: a per-person spectator/none grant → @world imported-roles:<id> (carried, not enforced; :875); '*' none/spectator → access {join: listed(, watch: anyone)} (:771, :775)
- **Browser:** —
- **Agent:** —
- **Vocabulary:** no spectator role
- **Specimen:** —
- **Evidence — main:** server/verbs.ts:167-168 (grant role: owner\|builder\|visitor\|spectator\|none)
- **Evidence — v4:** shared/protocol/roles.js:8-9, :15, :34, :45; translate-v1.js:182-183, :285-286, :771, :859-860, :875
- **Tests:** translate R22c/R22d/R22e (translate-check.ts:52-61: door words from '*' visitor/none) — see row 22; no per-person spectator test (none should exist). NOT RUN · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: translate
- **Changed since 72847d01d:** none (translate-v1.js lines drifted with @30-@34; roles.js :44 → :45)
- **Commits:** 3eb5c51c1, d43fe67f1, 6293438e6, 34c1753c2
- **Note:** PR line 150/§6a covers it. World-level `watch: anyone` remains (shared/protocol/access.js:8-11). translate-v1.js lines moved (:173-174/:276/:817 → :182-183/:285-286/:875) with the @30-@34 revisions; no semantic change to this row.
- **Verified this run:** opened v4 roles.js:8-9,15,34,45 (grep); translate-v1.js:182-183,285-286,771,859-860,875; access.js:8-11; translate-check.ts:52-61; main verbs.ts:166-170. Suite not run.

### [38] v1 sim + debug {sim}; world-bans mods-only; hashed IPs; one people list

**intentional-change** · decision row 21

- **Lean / ruling:** none quoted for sim/bans/hashing; the people-list half is decision row 21 (the lead 10-30: agents list restored beside people)
- **Implementation (v4):** server/messages.ts:424-432 (world-bans: owner or a moderation power only), :475-476, :490, :498 (a guest banned by hashed address, expires ADDR_BAN_MS); server/moderation.ts:20-21 (addr hashed, never raw; expires), :98; server/routes.ts:807-808 (people = everyone with declares; agents = declared agents — restored). ABSENT: `git grep -n 'msg.sim' e1f21cc9a -- server/messages.ts` → 1 hit (a comment: v1 sim debug gone; eidosim replaces it)
- **Migration:** n/a
- **Browser:** —
- **Agent:** people list + agents list (decision row 21)
- **Vocabulary:** —
- **Specimen:** none named yet
- **Evidence — main:** server/messages.ts:139-143 (debug {sim}: the sim fold's cut); server/routes.ts:760-761 (/worlds people+agents)
- **Evidence — v4:** server/messages.ts:424-432, :475-476, :490, :498; server/moderation.ts:20-21, :98; server/routes.ts:807-808
- **Tests:** agenttools AT12 (agenttools-check.ts:237-240) for the people/agents half; identity-check covers guest bans by address (header :29); NOT RUN · RUN 10-30 (lead): gate lane green from a clean sibling checkout of e1f21cc9a (wt-s-rows; wt-s-int's node_modules symlink is dangling and the tree is read-only) — suite-runs.log beside this file: agenttools
- **Changed since 72847d01d:** grade unchanged; the people-list part now has `agents` back (e1f21cc9a, decision row 21); messages.ts :475 → :475-476/:490/:498 (same code); routes.ts :804 → :807-808
- **Commits:** e1f21cc9a, d04f1a13e
- **Note:** The 'one people list' quarter of this row is PARTLY undone on purpose: e1f21cc9a restores main's `agents` list beside `people` (decision row 21) — people is still one list of everyone (with a declares tag), so the §6a 'never a second list sorted by kind' comment at routes.ts:775-777 now sits above a second list; the lead ruled it. debug {sim}, mods-only world-bans and hashed addresses unchanged.
- **Verified this run:** opened v4 messages.ts:424-432,475-476,490,498 (grep); moderation.ts:20-21,98; routes.ts:775-811; main messages.ts:139-143, routes.ts:755-762. `git grep msg.sim` → 1 (comment). Suite not run.

### [39] Whisper + DM tabs + attention sounds

**intentional-change**

- **Lean / ruling:** ruled: MORNING-ASKS 'whisper retired (39)' settled; ASK-AUDIT S4 'whisper stays disabled' → removed end to end on the lead's 'Yep'
- **Implementation (v4):** shared/protocol/verbspec.js:144-147 (REMOVED_VERBS.whisper, why + fix); server/messages.ts:122-127 (whisper → error + refused {code: 'removed'}); mcpl/tools.ts:261, :1644-1649 (TOOL_REMOVED.whisper), :1675 (refused with a pointer, nothing ran)
- **Migration:** n/a
- **Browser:** DM tabs gone
- **Agent:** whisper tool removed
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** server/messages.ts:169-171 (whisper handler, WHISPERS_ENABLED)
- **Evidence — v4:** shared/protocol/verbspec.js:144-147; server/messages.ts:122-127; mcpl/tools.ts:261, :1644-1649, :1675
- **Tests:** presence 'a whisper reaches nobody (removed)' (presence-check.ts:13 header, :82-83; suites.ts:145); tools/door-wording-test.ts:311-313 ('a whisper says why there is none, what speaks instead, and that nothing ran'). NOT RUN (SEEN PASS 28/28 at 72847d01d)
- **Changed since 72847d01d:** none (mcpl/tools.ts :260/:1641-1646 → :261/:1644-1649/:1675)
- **Commits:** none
- **Note:** docs/UPSTREAM-FLAGS.md:203 still names a 'whisper-disable' suite that is not in suites.ts (0 hits) and no tools/*whisper* file exists — a stale doc word (row S4). PR line 15 still lists main's tool overlap; retirement is stated in the removals section.
- **Verified this run:** opened v4 verbspec.js:144-147; messages.ts:122-127; mcpl/tools.ts:261,1644-1649,1675 (grep); presence-check.ts:13,82-83; suites.ts:145; door-wording-test.ts:311-313; main messages.ts:167-171. Suite not run.


## Tests & docs (5 rows)

### [40,52] Lost test cover

**partial**

- **Lean / ruling:** none quoted for 40/52 in the lead's rulings; lean was 'restore a row per restored feature (red first)'
- **Implementation (v4):** ABSENT at e1f21cc9a: tools/comptest.ts, tools/render-scene-test.ts, tools/sim-ground-smoke.ts, tools/verb-order-test.ts (deleted 3152ff60b), tools/caption-verb-test.ts (`ls` → No such file). Present: tools/comps-parity-test.ts (STILL NOT in suites.ts: `grep comps-parity tools/protocol/suites.ts` → 0), tools/render-scene-wire-test.ts + tools/render-scene-import-test.ts (suites.ts:203), tools/captions-test.ts, originof-test (suites.ts:52), shape-render-test.ts (suites.ts:51). suites.ts at the head: 200 entries vs 193 at 72847d01d; the 7 new: collider-off-bodies, helm-leave, lock-strength, swim-lists, killz-slumped, consent-scripts-list, custody-save — none is a twin of a lost v1 test. 55f929c9b retired tools/protocol/security-check.ts (279 lines; 'every check is in a gated suite, equal or stronger', review 1.12; +7 lines identity-check, permtest)
- **Migration:** n/a
- **Browser:** fog-mask/gpu/level-underwater checks not gated
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** tools/comptest.ts, tools/render-scene-test.ts, tools/sim-ground-smoke.ts, tools/verb-order-test.ts, tools/caption-verb-test.ts all exist at 34fd77ea2 (carried from the old row; not re-opened on main this run)
- **Evidence — v4:** suites.ts:51 (shape-render), :52 (originof), :203 (render-scene-import); comps-parity-test.ts unregistered; 55f929c9b security-check retired; 7 new suite names (diff of suites.ts 72847d01d..head)
- **Tests:** per lost test, cover at the head: comptest swing → none (comps-parity-test still unregistered); render-scene 26 cases → partial (wire + import tests); sim-ground-smoke → none; verb-order → none by design (3152ff60b); XSS seat/orrery → orrery via originof (registered); caption-verb → captions-test pure fns only. The D1-D10 sub-items of the old row were not re-opened this run (unchanged files by `git log`: none of the cited test files appear in 72847d01d..e1f21cc9a except through the suites.ts diff). NOT RUN.
- **Changed since 72847d01d:** grade unchanged; +7 suites registered (none a lost-test twin); security-check.ts retired (55f929c9b); suites.ts lines :50/:51/:199 → :51/:52/:203
- **Commits:** 55f929c9b
- **Note:** Grade unchanged: the seven new suites are v4-feature suites (colliders, helm, locks, swim, killz, consent, custody), not restorations of lost v1 cover; comps-parity-test.ts is still a hand-run script. One loss on the other side: 55f929c9b deleted security-check.ts claiming every check lives in a gated suite — not audited row-by-row here. suites.ts line numbers drifted (:50/:51/:199 → :51/:52/:203).
- **Verified this run:** ran the suites.ts name diff (7 additions, 200 at head); grep comps-parity → 0; `ls` of the 8 tool files; suites.ts:51-52,203; `git show --stat 55f929c9b`. Main-side files not re-opened. No suite run.

### [41] Wrong commit messages (3152ff60b)

**absent**

- **Lean / ruling:** none (lean: note in PR text)
- **Implementation (v4):** git 3152ff60b 'tools: delete the tests and scripts that exercised only v1 machinery' is an ancestor of e1f21cc9a (`git merge-base --is-ancestor 3152ff60b e1f21cc9a` → true); its body names v4 twins per deleted test
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** —
- **Evidence — v4:** git 3152ff60b ancestor of e1f21cc9a (checked this run)
- **Tests:** none exists
- **Changed since 72847d01d:** none
- **Commits:** none
- **Note:** History unchanged. Whether the PR body now mentions 3152ff60b was not checked this run (the PR text is not in the tree).
- **Verified this run:** `git merge-base --is-ancestor 3152ff60b e1f21cc9a` → ancestor. PR body not re-read.

### [42] deploy/SHOW_RUNBOOK.md

**partial** · decision row 3

- **Lean / ruling:** none quoted (lean: rewrite steps for v4)
- **Implementation (v4):** deploy/SHOW_RUNBOOK.md:17 (HN_NATIVE_ORIGIN: the public origin exactly — 2dee96dee), :21 (CSP_CONNECT_EXTRA), :22 (SERVER_OPERATORS by account, bare name refused loudly), :73 (found once with /newworld = world-found; joining never founds), :78 (warm the cache: one spectator client cold, X-Cache MISS→HIT), :85 (archive = world.jsonl + world.mod.jsonl + …)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** deploy/SHOW_RUNBOOK.md:79 (archive = worlds/<world>/log.jsonl + frames-<ts>.jsonl + assets/opt/store/)
- **Evidence — v4:** deploy/SHOW_RUNBOOK.md:17, :21, :22, :73, :78, :85
- **Tests:** none exists (a doc). NOT RUN.
- **Changed since 72847d01d:** grade unchanged; HN_NATIVE_ORIGIN row added (2dee96dee); lines :21/:72-73/:84-85 → :22/:73/:85
- **Commits:** 2dee96dee
- **Note:** No v1 word by grep at the head (WORLD_ADMIN / log.jsonl / snapshot.json / inhabitant → 0 hits). 2dee96dee added the HN_NATIVE_ORIGIN row (:17). Stays partial, as before, because the runbook's show numbers (24 performers + 176 spectators, local baseline :45-47) have not been re-measured against v4 — a doc with unverified figures, not a code gap.
- **Verified this run:** opened v4 deploy/SHOW_RUNBOOK.md:3,17,21,22,36,41-47,73,78,85 (grep); grep for v1 words → 0; main SHOW_RUNBOOK.md:79.

### [S2] tools/ scripts still speaking v1 (SWEEP-3 S2)

**absent**

- **Lean / ruling:** none; MORNING-ASKS routes S2 '(≈20 v1-speaking tools) → #13 cleanup (fix the class)'
- **Implementation (v4):** `git grep -l -E 'type: *['"]verb['"]' e1f21cc9a -- tools/` → 16 files (was 17 at 72847d01d): non-test 2 (tools/lightbench.ts, tools/render-scene-control.ts; tools/bootjank.ts left the list via 09927bdde 'probes: drive what v4 serves, review 1.13') + 14 probes/tests/fixtures (attention-probe, forecast-probe.mjs, fp-snap-probe, lite-banner-probe.mjs, native-environment-control, native-interactions-fixture, particles-probe, protocol/server-check, render-scene-wire-test, roaming-renderer-check, sky-refresh-probe.mjs, snap-at-probe.mjs, tilt-probe.mjs, uneven-support-test)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** —
- **Evidence — v4:** strict grep → 16 files at e1f21cc9a (17 at 72847d01d); 09927bdde touched bootjank.ts, picture-editor-probe.ts, picture-note-test.ts, picture-race-probe.ts, water/preview.ts
- **Tests:** none exists (nov1 suite guards runtime, not tools/)
- **Changed since 72847d01d:** count 17 → 16 (09927bdde moved bootjank.ts to v4 shapes); grade unchanged
- **Commits:** 09927bdde
- **Note:** Still 'absent' as a sweep: one file fixed (bootjank) out of 17; the class is not fixed. The looser `verb: "…"` key grep from the old row was not re-run.
- **Verified this run:** re-ran the strict grep at both revisions (17 → 16) and `git show --stat 09927bdde`.

### [S4] Doc rot (SWEEP-3 S4, 5 lines)

**partial**

- **Lean / ruling:** none; routed to the features agent (MORNING-ASKS 13:36)
- **Implementation (v4):** 483782d54 (ancestor) rewrote the five docs; since 72847d01d only ce6950a28 ('docs: the text follows the code', review items 1.6/1.11/2.1-2.9) touched docs/REMOTE-SCREENSHOTS.md, docs/UPSTREAM-FLAGS.md, docs/NATIVE-WORLD-RENDERING.md or docs/draw-calls.md. Grep for stale v1 words (WORLD_ADMIN, log.jsonl, snapshot.json, inhabitant, VERB_RATE, FOLD_EVERY, whisper, /upload?as=, spectator role, join founds) across the four docs → ONE hit: docs/UPSTREAM-FLAGS.md:203 names a 'whisper-disable' suite that no longer exists (suites.ts → 0 hits; no tools/*whisper*). deploy/SHOW_RUNBOOK.md → 0 hits (row 42)
- **Migration:** n/a
- **Browser:** —
- **Agent:** —
- **Vocabulary:** —
- **Specimen:** —
- **Evidence — main:** —
- **Evidence — v4:** docs/UPSTREAM-FLAGS.md:200-205 (one stale suite name: whisper-disable); the other three docs and SHOW_RUNBOOK clean by the grep above
- **Tests:** none exists (docs); NOT RUN
- **Changed since 72847d01d:** grade unchanged; evidence improved from 'the commit exists' to a grep of the five docs (one stale line found: UPSTREAM-FLAGS.md:203); ce6950a28 touched the docs
- **Commits:** ce6950a28
- **Note:** Re-read by grep this run (the 72847 row had not): one residual stale line (UPSTREAM-FLAGS.md:203 'whisper-disable' suite). Stays partial: four of five docs clean by grep, one stale name; a word-list grep is not a line-by-line read.
- **Verified this run:** grep of the 10 v1 words over the four docs + SHOW_RUNBOOK; opened docs/UPSTREAM-FLAGS.md:200-205; `ls docs \| grep -i draw` → draw-calls.md; suites.ts grep whisper-disable → 0.


— Hesperus
