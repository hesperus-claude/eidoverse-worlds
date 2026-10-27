// client/lib/realize/models_field.js: the models realizer's pure planner (TEL0S_NOTES §11.4), headless.
//   bun tools/models-field-test.ts
// The plan is a pure diff of folded entities vs the realized view; identity changes (kind flips on the flat id
// namespace, a lib change under a same-id spawn) are rebuilds, not refreshes; mounts are a pending list (mountsTouching
// finds every linkage a completed spawn could unblock); distance bands promote what's in front of you.

import { planReconcile, bandForDistance, mountsTouching, collisionOwnedElsewhere, kindOf, readMesh, meshKeyOf } from "../client/lib/realize/models_field.js";
import { P } from "../client/lib/scheduler.js";

let passed = 0, failed = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};

console.log(`\nmodels_field — the pure planner\n`);

const model = (model: string, extra: object = {}) => ({ model, pos: [0, 0, 0], actor: "t", ts: 1, ...extra });
const light = () => ({ pos: [0, 1, 0], light: { color: 0xffd9a0, intensity: 16, range: 10 }, actor: "t", ts: 1 });

// 1. fresh world: everything creates, nothing retires
{
  const st = { a: model("x.glb"), b: light() };
  const plan = planReconcile(st, new Map());
  check("fresh state creates all", plan.create.length === 2 && plan.retire.length === 0);
}

// 2. steady state: no work
{
  const st = { a: model("x.glb"), b: light() };
  const view = new Map([["a", { kind: "model", model: "x.glb" }], ["b", { kind: "light" }]] as any);
  const plan = planReconcile(st, view);
  check("matching view plans nothing", plan.create.length === 0 && plan.retire.length === 0);
}

// 3. gone from state → retire
{
  const plan = planReconcile({}, new Map([["a", { kind: "model", model: "x.glb" }]] as any));
  check("vanished id retires", plan.retire.join() === "a" && plan.create.length === 0);
}

// 4. kind flip (light verb landed on a model id) → rebuild
{
  const st = { a: light() };
  const plan = planReconcile(st, new Map([["a", { kind: "model", model: "x.glb" }]] as any));
  check("kind flip rebuilds", plan.retire.join() === "a" && plan.create.length === 1 && plan.create[0].id === "a");
}

// 5. lib change under a same-id spawn → rebuild (the fold's overwrite semantics; the planner projects whatever it folded)
{
  const st = { a: model("y.glb") };
  const plan = planReconcile(st, new Map([["a", { kind: "model", model: "x.glb" }]] as any));
  check("lib change rebuilds", plan.retire.join() === "a" && plan.create[0]?.ent.model === "y.glb");
}

// 6. mountsTouching finds both directions of a linkage
{
  const st = {
    truck: model("t.glb"),
    crate: model("c.glb", { parent: { to: "truck" } }),
    lantern: model("l.glb", { parent: { to: "crate" } }),
    bystander: model("b.glb"),
  };
  check("carrier realizing unblocks its cargo", mountsTouching(st, "truck").join() === "crate");
  check("cargo realizing re-checks its own mount", mountsTouching(st, "crate").sort().join() === "crate,lantern");
  check("unrelated spawn touches nothing", mountsTouching(st, "bystander").length === 0);
}

// 7. distance bands
{
  check("close is NEAR", bandForDistance(3) === P.NEAR);
  check("mid is VISIBLE", bandForDistance(25) === P.VISIBLE);
  check("far is FAR", bandForDistance(300) === P.FAR);
  check("unknown distance is VISIBLE", bandForDistance(NaN) === P.VISIBLE);
}

// 8. collision owned elsewhere isn't inferred here: mounted cargo collides as its carrier, and a `structure` entity's is
// declared by the structure realizer (not its placeholder lib)
{
  check("an ordinary model owns its collision",
    !collisionOwnedElsewhere(model("crate.glb"), false));
  check("mounted cargo does not", collisionOwnedElsewhere(model("crate.glb"), true));
  check("a structure anchor does not",
    collisionOwnedElsewhere({ ...model("placeholder.glb"), structure: { levels: [] } }, false));
  check("...even unmounted, which is the whole point",
    collisionOwnedElsewhere({ ...model("x.glb"), structure: {} }, false));
  check("an unrelated comp changes nothing",
    !collisionOwnedElsewhere({ ...model("x.glb"), lock: true }, false));
  check("missing entity is not a crash", !collisionOwnedElsewhere(undefined, false));
  // a collision switched off is honoured: today's physics {kind: 'none'} (the authority's sim skips it,
  // shared/protocol/simlayer.js) and a stored collision {enabled: false} from before the rename
  check("physics kind none gets no box", collisionOwnedElsewhere({ ...model("x.glb"), physics: { kind: "none" } }, false));
  check("a stored collision {enabled: false} gets no box", collisionOwnedElsewhere({ ...model("x.glb"), collision: { enabled: false } }, false));
  check("…a static body still does", !collisionOwnedElsewhere({ ...model("x.glb"), physics: { kind: "static" } }, false));
}

// 9. a mesh thing (componentspec `mesh`): its own kind; a changed shape or size rebuilds, a malformed value is an Empty
{
  const mesh = (m: any) => ({ pos: [0, 0, 0], actor: "t", ts: 1, mesh: m });
  check("kind 'mesh' for a thing with a mesh bag and no lib", kindOf(mesh({ shape: "box", size: [1, 1, 1] })) === "mesh");
  check("a malformed mesh (unknown shape) reads as absent: an Empty, never a throw", kindOf(mesh({ shape: "cone", size: [1, 1, 1] })) === "empty" && readMesh({ shape: "cone" }) === null && readMesh("box") === null);
  check("readMesh clamps a size to 0.05..200 and fills a missing size with 1", JSON.stringify(readMesh({ shape: "sphere", size: [0.001, 999, 2] })?.size) === "[0.05,200,2]" && JSON.stringify(readMesh({ shape: "box" })?.size) === "[1,1,1]");
  const st = { a: mesh({ shape: "box", size: [1, 1, 1] }) };
  const same = planReconcile(st, new Map([["a", { kind: "mesh", mesh: meshKeyOf(st.a) }]] as any));
  check("a mesh whose key matches plans nothing", same.create.length === 0 && same.retire.length === 0);
  const changed = planReconcile({ a: mesh({ shape: "sphere", size: [1, 1, 1] }) }, new Map([["a", { kind: "mesh", mesh: meshKeyOf(st.a) }]] as any));
  check("a shape change under the same id → retire + create (a rebuild)", changed.retire.includes("a") && changed.create.some((c) => c.id === "a"));
  const flip = planReconcile({ a: { model: "x.glb", pos: [0, 0, 0], actor: "t", ts: 1 } }, new Map([["a", { kind: "mesh", mesh: "box|1,1,1" }]] as any));
  check("a mesh id that becomes a model → rebuild", flip.retire.includes("a") && flip.create.length === 1);
  // a capsule is at least its diameter tall (as the authority's meshSize); a carried thing with both a lib and a mesh is
  // its model, as the hierarchy and the Inspector read it
  check("readMesh: a capsule [1, 0.2, 1] is 1 m tall", JSON.stringify(readMesh({ shape: "capsule", size: [1, 0.2, 1] })?.size) === "[1,1,1]");
  check("kind 'model' when a carried thing has both a lib and a mesh", kindOf({ model: "x.glb", pos: [0, 0, 0], actor: "t", ts: 1, mesh: { shape: "box", size: [1, 1, 1] } }) === "model");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
