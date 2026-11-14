// A structure's anchor model is not support for an agent's body — tested headless.
//
//   bun tools/anchor-support-test.ts
//
// A `structure` entity rides a placeholder model; the browser fits it no collider (realize/models.js: "an invisible
// crate-sized obstacle at the origin of every building"), but the agent's syncSupport registered the crate as a deck,
// so walk_to stood on it inside the building (rainroom 11-14). Drives the agent's own syncSupport, geometry stubbed.

import { WorldAgent } from "../mcpl/agent.ts";
import { supportHolders } from "../mcpl/physics.ts";
const registered = async (bid: string) => { for (let i = 0; i < 300 && !supportHolders()[bid]; i++) await new Promise((r) => setTimeout(r, 50)); return !!supportHolders()[bid]; };

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};

const ag: any = new WorldAgent({ name: "anchor-bot", world: "anchor" });
ag.geomFor = async () => ({ bbox: { min: [-1.25, 0, -0.75], max: [1.25, 2, 0.75], size: [2.5, 2, 1.5] }, topSurfaces: [] });
console.log("an agent's support for a structure's anchor:");

// a plain crate is a 2 m deck (the control: the stub and the registry work)
ag.entities.set("crate", { id: "crate", model: "crate.glb", pos: [10, 0, 0], yaw: 0, actor: "x" });
await ag.syncSupport("crate");
const C: any = await import("../client/lib/colliders.js");   // after the agent has loaded physics (its core shim)
check("(control) a plain crate registers support", await registered("anchor/crate"), JSON.stringify(Object.keys(supportHolders())));

// the same model carrying a structure is only an anchor
ag.entities.set("cabin", { id: "cabin", model: "crate.glb", pos: [30, 0, 0], yaw: 0, actor: "x", structure: { levels: [{ y: 0, tiles: [[0, 0]] }] } });
await ag.syncSupport("cabin");
await new Promise((r) => setTimeout(r, 500));
check("a structure's anchor registers none", !supportHolders()["anchor/cabin"], JSON.stringify(Object.keys(supportHolders())));
const on = C.surfaceUnder(30, 0, () => 0);
check("…so nothing stands 2 m up at the building's origin", on.onto === null && on.y === 0, JSON.stringify(on));

// a crate that gains a structure after it landed drops the support it had
ag.entities.set("late", { id: "late", model: "crate.glb", pos: [50, 0, 0], yaw: 0, actor: "x" });
await ag.syncSupport("late"); await registered("anchor/late");
ag.entities.get("late").structure = { levels: [{ y: 0, tiles: [[0, 0]] }] };
await ag.syncSupport("late");
check("a crate that becomes a structure's anchor drops its support", !supportHolders()["anchor/late"], JSON.stringify(Object.keys(supportHolders())));

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
