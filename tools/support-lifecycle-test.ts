// Support surfaces through the SHIPPED DOOR (#17): tools/support-test.ts proves the solver rests a body on a box; this
// proves a real WorldAgent turns the log it replays into those boxes, end to end, over a socket:
//   replay a world containing a platform
//     -> GET /geom
//       -> support registration
//         -> place / rescale / remove / motion
//           -> explicit drag release AND the 1.2s dragger-silence timeout
// Every assertion is a HEIGHT: a body released over a platform rests on it (root ≈ deck − hips offset), or lands on the
// terrain below (root ≈ −hips); the two are ~2m apart, so nothing is a near-miss.
//   bun tools/support-lifecycle-test.ts        # spawns its own scratch server
//   URL=ws://host:8940/ws bun tools/...        # or against a running one

import { spawn } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { foundWorlds, freePort } from "./harness.ts";
import { qFromYaw } from "../shared/rot.js";
import { idAliases } from "./protocol/idalias.ts";
const IDS = idAliases();

// Bun's global transpiler cache can keep a stale plugin-resolved path and bypass onResolve: re-exec once with it off
// (read at startup; #13). This file reaches the plugin through WorldAgent -> physics.ts
if (process.env.__EIDO_TEST_CACHE_OFF !== '1') {
  const child = Bun.spawnSync({
    cmd: [process.execPath, import.meta.path, ...process.argv.slice(2)],
    env: {
      ...process.env,
      BUN_RUNTIME_TRANSPILER_CACHE_PATH: '0',
      __EIDO_TEST_CACHE_OFF: '1',
    },
    stdout: 'inherit',
    stderr: 'inherit',
  });
  process.exit(child.exitCode ?? 1);
}

const { WorldAgent } = await import("../mcpl/agent.ts");

const EXTERNAL = process.env.URL;
const PORT = process.env.PORT ? Number(process.env.PORT) : freePort(9480);   // a free port, never a fixed default
const URL_ = EXTERNAL ?? `ws://127.0.0.1:${PORT}/ws`;
const TOKEN = process.env.TOKEN ?? "";
const worldsDir = mkdtempSync(join(tmpdir(), "ew-support-"));

// a crate: small enough to stay a plain box, tall enough that resting on it is unmistakable; deck top at local y 2.003,
// origin on flat terrain at y 0
const LIB = "eidoverse/assets/models/crate_large_red.glb";
const DECK_Y = 2.003;

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- server ----------------------------------------------------------------

let server: ReturnType<typeof spawn> | null = null;
async function startServer() {
  if (EXTERNAL) return;
  // process.execPath, not "bun": on Windows PATH "bun" is a .cmd shim, so kill() would orphan the sequencer and it would
  // answer the NEXT run
  server = spawn(process.execPath, [join(import.meta.dir, "..", "server", "server.ts")], {
    // TRUST_NAMES: a typed name is its own local account, so the stagehand who founds a world joins it as its owner
    env: { ...process.env, PORT: String(PORT), WORLDS_DIR: worldsDir, JOIN_TOKEN: "", TRUST_NAMES: "1", SKIP_OPT_SWEEP: "1",
           MSG_RATE: "5000" },
    stdio: "ignore",
  });
  for (let i = 0; i < 80; i++) {
    try { if ((await fetch(`http://127.0.0.1:${PORT}/avatars`)).ok) return; } catch { /* not up */ }
    await sleep(100);
  }
  throw new Error("server did not start");
}

const HTTP = URL_.replace(/^ws/, "http").replace(/\/ws$/, "");

/** The server's own reading of a model's shape: drop points come from it, since a model need not be centred on its
 *  origin and a hardcoded drop point would test empty air. */
async function geom(model: string) {
  const r = await fetch(`${HTTP}/geom?lib=${encodeURIComponent(model)}`);
  if (!r.ok) throw new Error(`/geom ${model}: ${r.status}`);
  return r.json() as Promise<any>;
}
const bandCentre = (t: any) => [(t.x[0] + t.x[1]) / 2, (t.z[0] + t.z[1]) / 2];
const fillOf = (t: any) => t.area / ((t.x[1] - t.x[0]) * (t.z[1] - t.z[0]));

/** The scene's old authoring words, as door requests. A "moving platform" is any motion component (a path becomes an
 *  oscillation, which moves it all the same). Requests go out in order on one socket and are answered in order. */
const requestsOf = (v: string, a: any): { verb: string; args: any }[] => {
  const tf = (x: any) => ({ ...(x.pos ? { pos: x.pos } : {}), ...(typeof x.yaw === "number" ? { q: qFromYaw(x.yaw) } : {}) });
  switch (v) {
    case "spawn": return [{ verb: "create", args: { id: a.id, model: a.lib, components: { transform: tf(a) } } }];
    case "place": return [{ verb: "set", args: { id: a.id, component: "transform", value: tf(a), merge: true } }];
    case "remove": return [{ verb: "delete", args: { id: a.id } }];
    case "motion": return a.type ? [{ verb: "set", args: { id: a.id, component: "motion", value: { type: "oscillate", axis: [0, 0, 1], amp: 3, period: 4 } } }]
      : [{ verb: "delete", args: { id: a.id, component: "motion" } }];
    case "mount": return [{ verb: "set", args: { id: a.id, component: "parent", value: { to: a.to } } }];
    case "dismount": return [{ verb: "delete", args: { id: a.id, component: "parent" } }, { verb: "set", args: { id: a.id, component: "transform", value: tf(a), merge: true } }];
    default: throw new Error(`no authority request for '${v}'`);
  }
};
/** A bare socket: authors the scene (the world's founder and owner) and plays the dragger's hand. */
function hand(world: string, name: string) {
  if (!EXTERNAL && !existsSync(join(worldsDir, world))) foundWorlds(worldsDir, [world], name);   // joining never founds a world
  return new Promise<any>((res) => {
    const ws = new WebSocket(`${URL_}?name=${name}`);
    let n = 0;
    // the scene's names ride as placeholders and minted ids (tools/protocol/idalias.ts): each request waits for the one
    // before it (its reply carries the ids a later request names); a verb's promise may be ignored, the order holds
    const waiting = new Map<string, (r: any) => void>(); let chain: Promise<any> = Promise.resolve();
    const ask = (r: { verb: string; args: any }) => new Promise<any>((done) => { const id = `${name}-${++n}`; waiting.set(id, done);
      ws.send(JSON.stringify({ type: "request", id, verb: r.verb, args: IDS.out(r.verb, r.args) })); setTimeout(() => { if (waiting.delete(id)) done(null); }, 8000); });
    ws.onopen = () => ws.send(JSON.stringify({ type: "join", world, id: name, token: TOKEN, replica: true }));
    ws.onmessage = (e) => {
      const m = JSON.parse(String(e.data));
      if (m.type === "reply") { IDS.back(m.reply); const d = waiting.get(m.id); if (d) { waiting.delete(m.id); d(m.reply); } }
      if (m.type === "reply" && !m.ok) console.log(`  (door refused ${m.verb}: ${JSON.stringify(m.reply?.refused)})`);
      if (m.type === "snapshot") res({
        verb: (v: string, a: any) => (chain = chain.then(async () => { for (const r of requestsOf(v, a)) await ask(r); })),
        send: (o: any) => ws.send(JSON.stringify(o)),
        close: () => ws.close(),
      });
    };
  });
}

/** Knock a body down, drag it and let go over `overY`, by explicit release or by going silent for the 1.2s timeout.
 *  Returns where the agent's OWN settle sim put its root. */
async function dropOver(h: any, ag: any, name: string, at: number[], overY: number,
                        how: "release" | "silence", triggerAt?: { t: number }) {
  h.send({ type: "puppet", target: name, ragdoll: { lean: [1, 0, 0] } });
  await sleep(2200);
  h.send({ type: "bodydrag", target: name, grab: { joint: "hips" } });
  await sleep(250);
  h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] },
           p: [at[0], overY + 0.4, at[1]], yaw: 0 });
  await sleep(250);
  if (how === "release") {
    h.send({ type: "bodydrag", target: name, end: true, pose: { hips: [0, 0, 0, 1] },
             p: [at[0], overY + 1.2, at[1]], yaw: 0 });
    if (triggerAt) triggerAt.t = Date.now();          // the settle starts here
  } else {
    // the dragger's last word, then nothing: the body reclaims itself at 1.2s
    h.send({ type: "bodydrag", target: name, pose: { hips: [0, 0, 0, 1] },
             p: [at[0], overY + 1.2, at[1]], yaw: 0 });
    if (triggerAt) triggerAt.t = Date.now() + 1200;   // ...and here, one timeout later
  }
  await sleep(how === "release" ? 9000 : 11_000);
  return ag.pos.y as number;
}

// a lying rig's hips offset: a settled body's ROOT sits this far below its surface (rig-dependent, measured live)
let hipsOffset = 0.68;
const restsOn = (rootY: number, surfaceY: number) => Math.abs(rootY - (surfaceY - hipsOffset)) < 0.35;
const onDeck = (rootY: number) => restsOn(rootY, DECK_Y);
const onTerrain = (rootY: number) => restsOn(rootY, 0);

// ---- the run ---------------------------------------------------------------

try {
  await startServer();
  console.log(`\nsupport lifecycle (the shipped door): ${URL_}\n`);

  // ---- 1. REPLAY: the platform is in the log BEFORE the body ever joins ----
  // the agent folds the spawn out of history at join, as a reconnecting or late resident always does
  {
    const W = `sup-replay-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    h.close();

    const ag = new WorldAgent({ url: URL_, name: "rep-bot", world: W });
    await ag.connect();
    await sleep(1200);
    const h2 = await hand(W, "hand2");

    // calibrate the offset on flat ground in THIS world, on THIS rig
    h2.send({ type: "puppet", target: "rep-bot", ragdoll: { lean: [1, 0, 0] } });
    await sleep(3000);
    hipsOffset = -ag.pos.y;
    check("a body knocked down on flat terrain reports a stable hips offset",
      hipsOffset > 0.3 && hipsOffset < 1.2, `offset=${hipsOffset.toFixed(2)}m`);
    await ag.walkTo(3, 0, false, 8000);

    const y = await dropOver(h2, ag, "rep-bot", [3, 0], DECK_Y, "release");
    check("REPLAYED platform holds a body released over it",
      onDeck(y), `root=${y.toFixed(2)} deck=${(DECK_Y - hipsOffset).toFixed(2)} terrain=${(-hipsOffset).toFixed(2)}`);
    h2.close(); ag.close?.();
  }

  // ---- 2. the 1.2s dragger-silence path, not just explicit release --------
  {
    const W = `sup-silence-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "sil-bot", world: W });
    await ag.connect();
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "sil-bot", [3, 0], DECK_Y, "silence");
    check("a SILENT dragger's body settles onto the platform too",
      onDeck(y), `root=${y.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 3. place moves the support with the thing --------------------------
  {
    const W = `sup-place-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "plc-bot", world: W });
    await ag.connect();
    await sleep(1200);
    h.verb("place", { id: "deck", pos: [-4, 0, 0], yaw: 0 });   // moved away
    await sleep(1200);

    await ag.walkTo(3, 0, false, 8000);
    const gone = await dropOver(h, ag, "plc-bot", [3, 0], DECK_Y, "release");
    check("support LEAVES the old spot after a place", onTerrain(gone), `root=${gone.toFixed(2)}`);

    await ag.walkTo(-4, 0, false, 10_000);
    const there = await dropOver(h, ag, "plc-bot", [-4, 0], DECK_Y, "release");
    check("...and ARRIVES at the new one", onDeck(there), `root=${there.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 4. remove takes the floor with it ----------------------------------
  {
    const W = `sup-remove-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "rm-bot", world: W });
    await ag.connect();
    await sleep(1200);
    h.verb("remove", { id: "deck" });
    await sleep(1000);
    await ag.walkTo(3, 0, false, 8000);
    const y = await dropOver(h, ag, "rm-bot", [3, 0], DECK_Y, "release");
    check("a REMOVED platform stops holding bodies up", onTerrain(y), `root=${y.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 5. a MOVING thing is not a floor (ghost-floor fence) ---------------
  // a headless support box at the authored transform wouldn't follow a motion, so the agent abstains rather than invent a
  // floor, and resumes when the motion is taken off
  {
    const W = `sup-motion-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const ag = new WorldAgent({ url: URL_, name: "mot-bot", world: W });
    await ag.connect();
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);

    // a path motion: this crate is now a lift, and it does not stay put
    h.verb("motion", { id: "deck", type: "path", points: [[3, 0, 0], [3, 0, 6]],
                       speed: 1.5, loop: "pingpong" });
    await sleep(1200);
    const moving = await dropOver(h, ag, "mot-bot", [3, 0], DECK_Y, "release");
    check("a MOVING platform is not a ghost floor", onTerrain(moving), `root=${moving.toFixed(2)}`);

    h.verb("motion", { id: "deck" });                  // type omitted = motion removed
    await sleep(1200);
    await ag.walkTo(3, 0, false, 8000);
    const stopped = await dropOver(h, ag, "mot-bot", [3, 0], DECK_Y, "release");
    check("...and supports again once the motion is taken off", onDeck(stopped), `root=${stopped.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 6. (an id is never reused, so an id removed and respawned mid-/geom-fetch has no subject; syncSupport's lib
  // re-check stays as defence, pinned headless by tools/support-swap-test.ts)

  // ---- 7. a departing agent takes its world's floors with it -------------
  // the collider map is PROCESS state (physics.ts's declared seam): a second world in one process must not inherit the
  // first world's platforms
  {
    const W1 = `sup-leak-a-${Date.now().toString(36)}`;
    const h1 = await hand(W1, "stagehand");
    h1.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const a1 = new WorldAgent({ url: URL_, name: "leak-a", world: W1 });
    await a1.connect();
    await sleep(1500);                                  // its support is registered
    h1.close(); a1.close?.();                           // ...and it leaves
    await sleep(500);

    // a different world, no platform anywhere in its log
    const W2 = `sup-leak-b-${Date.now().toString(36)}`;
    const h2 = await hand(W2, "stagehand");
    const a2 = new WorldAgent({ url: URL_, name: "leak-b", world: W2 });
    await a2.connect();
    await sleep(1200);
    await a2.walkTo(3, 0, false, 8000);
    const y = await dropOver(h2, a2, "leak-b", [3, 0], DECK_Y, "release");
    check("a departed agent's platform does not haunt the next world",
      onTerrain(y), `root=${y.toFixed(2)} — a floor from a world this body never joined`);
    h2.close(); a2.close?.();
  }

  // ---- 8. an in-flight support generation, made real ---------------------
  // /geom is slowed from the test process (no production seam) and the release fires while it's on the wire; the second
  // case races the 1.2 s silence path, so it needs a longer delay
  {
    const realFetch = globalThis.fetch;
    let delayMs = 0;
    let geomLandedAt = 0;
    globalThis.fetch = (async (...a: any[]) => {
      const isGeom = String(a[0]).includes("/geom");
      if (delayMs && isGeom) await sleep(delayMs);
      const r = await realFetch(...(a as Parameters<typeof realFetch>));
      if (isGeom) geomLandedAt = Date.now();
      return r;
    }) as typeof fetch;
    try {
      // delays must exceed join-to-settle-trigger (or no race happens) and leave the rest inside supportReady's 3 s bound
      for (const [how, delay] of [["release", 4000], ["silence", 6000]] as const) {
        const W = `sup-barrier-${how}-${Date.now().toString(36)}`;
        const h = await hand(W, "stagehand");
        h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
        await sleep(600);

        delayMs = delay; geomLandedAt = 0;     // geometry now arrives slowly
        const ag = new WorldAgent({ url: URL_, name: `bar-${how}`, world: W });
        await ag.connect();
        await sleep(150);                      // do NOT wait for /geom
        ag.pos.x = 3; ag.pos.z = 0;            // stand on the platform's spot
        const triggerAt = { t: 0 };
        const y = await dropOver(h, ag, `bar-${how}`, [3, 0], DECK_Y, how, triggerAt);
        check(`a ${how} racing an in-flight /geom still lands on the platform`,
          onDeck(y), `root=${y.toFixed(2)} delay=${delay}ms`);
        // the race was real: the floor arrived AFTER the body asked to settle
        check(`...and the geometry genuinely landed late (${how})`,
          geomLandedAt > triggerAt.t,
          geomLandedAt === 0
            ? "/geom was never requested — this build does not consume geometry at all"
            : `/geom landed ${geomLandedAt - triggerAt.t}ms after the settle was triggered`);
        delayMs = 0;
        h.close(); ag.close?.();
      }
    } finally { globalThis.fetch = realFetch; }
  }

  // ---- 9. mounted cargo stops being a floor (B1) --------------------------
  // world.js drops a mounted entity's collider: it follows its parent, and its own transform is a lie once the parent moves
  {
    const W = `sup-mount-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    h.verb("spawn", { id: "cart", lib: LIB, pos: [8, 0, 0], yaw: 0 });
    await sleep(800);
    const ag = new WorldAgent({ url: URL_, name: "mnt-bot", world: W });
    await ag.connect();
    await sleep(1500);
    await ag.walkTo(8, 0, false, 10_000);

    h.verb("mount", { id: "cart", to: "deck" });     // the cart is cargo now
    await sleep(1200);
    const mounted = await dropOver(h, ag, "mnt-bot", [8, 0], DECK_Y, "release");
    check("MOUNTED cargo stops holding bodies at its old coordinate",
      onTerrain(mounted), `root=${mounted.toFixed(2)}`);

    h.verb("dismount", { id: "cart", pos: [8, 0, 0], yaw: 0 });
    await sleep(1500);
    await ag.walkTo(8, 0, false, 10_000);
    const off = await dropOver(h, ag, "mnt-bot", [8, 0], DECK_Y, "release");
    check("...and supports again once it is set down", onDeck(off), `root=${off.toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 10. a co-resident's departure leaves the floor standing (B3) -------
  // support ids are world/entity scoped, so two agents in one world share one registration: the leaver releases only its own claim
  {
    const W = `sup-cores-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    h.verb("spawn", { id: "deck", lib: LIB, pos: [3, 0, 0], yaw: 0 });
    await sleep(600);
    const stays = new WorldAgent({ url: URL_, name: "stays", world: W });
    const leaves = new WorldAgent({ url: URL_, name: "leaves", world: W });
    await stays.connect(); await leaves.connect();
    await sleep(1800);                       // both have registered the deck
    leaves.close?.();                        // ...and one walks out
    await sleep(600);

    await stays.walkTo(3, 0, false, 10_000);
    const y = await dropOver(h, stays, "stays", [3, 0], DECK_Y, "release");
    check("a co-resident leaving does not take the shared platform with them",
      onDeck(y), `root=${y.toFixed(2)}`);
    h.close(); stays.close?.();
  }

  // ---- 11. room-scale: real decks kept, sparse bands abstained (B2) -------
  // the watchtower: its deck (9.53, fill 0.855) and landing (2.76, 0.759) are floors; the railing/strut bands at 7.03 and
  // 7.57 (0.116, 0.058) are mostly air and must not be registered (#66)
  {
    const TOWER = "eidoverse/assets/models/scifi_perimeter_watchtower_standalone_or_with_wall_middle_four_way.glb";
    const g = await geom(TOWER);
    const bands = (g.topSurfaces ?? []).filter((t: any) => t.area >= 1);
    const deck = bands.find((t: any) => fillOf(t) >= 0.45);       // its real floor
    const sparse = bands.find((t: any) => fillOf(t) < 0.2);       // railing/strut tops
    check("the watchtower offers both a solid deck and a sparse band to tell apart",
      !!deck && !!sparse,
      `deck=${deck ? fillOf(deck).toFixed(3) : "none"} sparse=${sparse ? fillOf(sparse).toFixed(3) : "none"}`);

    const W = `sup-tower-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    const at = [3, 0, 0];
    h.verb("spawn", { id: "tower", lib: TOWER, pos: at, yaw: 0 });
    await sleep(900);
    const ag = new WorldAgent({ url: URL_, name: "twr-bot", world: W });
    await ag.connect();
    await sleep(2000);

    // drop points come from the bands themselves, in world coords
    const [dx, dz] = bandCentre(deck), [sx, sz] = bandCentre(sparse);
    const deckAt: number[] = [at[0] + dx, at[2] + dz];
    const sparseAt: number[] = [at[0] + sx, at[2] + sz];

    ag.pos.x = deckAt[0]; ag.pos.z = deckAt[1];
    const top = await dropOver(h, ag, "twr-bot", deckAt, deck.y, "release");
    check(`a REAL room-scale deck still holds a body (fill ${fillOf(deck).toFixed(3)})`,
      restsOn(top, deck.y), `root=${top.toFixed(2)} want≈${(deck.y - hipsOffset).toFixed(2)}`);

    ag.pos.x = sparseAt[0]; ag.pos.z = sparseAt[1];
    const mid = await dropOver(h, ag, "twr-bot", sparseAt, sparse.y, "release");
    check(`...while its sparse band (fill ${fillOf(sparse).toFixed(3)}) is not a floor`,
      !restsOn(mid, sparse.y), `root=${mid.toFixed(2)} would-be band=${(sparse.y - hipsOffset).toFixed(2)}`);
    h.close(); ag.close?.();
  }

  // ---- 12. the palm: canopy is not an invented floor (B2) -----------------
  // the palm's bands fill 0.094–0.143 (fronds round air): the agent fits the palm's own triangles (registerMeshSupport),
  // registering no deck; support comes from the triangles and nothing holds the body above the model
  {
    const PALM = "eidoverse/assets/models/palm_date_tree_tropical_deseert_oasis_plant.glb";
    const g = await geom(PALM);
    const canopy = (g.topSurfaces ?? [])[0];
    check("every palm band reads as mostly air",
      (g.topSurfaces ?? []).every((t: any) => fillOf(t) < 0.45),
      `worst fill=${Math.max(...(g.topSurfaces ?? []).map(fillOf)).toFixed(3)}`);

    const W = `sup-palm-${Date.now().toString(36)}`;
    const h = await hand(W, "stagehand");
    const at = [3, 0, 0];
    h.verb("spawn", { id: "palm", lib: PALM, pos: at, yaw: 0 });
    await sleep(900);
    const ag = new WorldAgent({ url: URL_, name: "palm-bot", world: W });
    await ag.connect();
    await sleep(2000);
    const [cx, cz] = bandCentre(canopy);
    const dropAt = [at[0] + cx, at[2] + cz];
    ag.pos.x = dropAt[0]; ag.pos.z = dropAt[1];
    const y = await dropOver(h, ag, "palm-bot", dropAt, canopy.y, "release");
    const { supportShape } = await import("../mcpl/physics.ts");
    check("the palm's support is fitted from its triangles — an exact collider, no summary decks",
      JSON.stringify((ag as any).supportIds.get(IDS.of("palm"))) === JSON.stringify([`${W}/${IDS.of("palm")}`]) && supportShape(`${W}/${IDS.of("palm")}`) === "exact",
      `${JSON.stringify((ag as any).supportIds.get(IDS.of("palm")))} fitted as ${supportShape(`${W}/${IDS.of("palm")}`)}`);
    check("a body released over a palm rests in its real fronds or below them, never on a floor above the model",
      y + hipsOffset <= g.bbox.max[1] + 0.15,
      `root=${y.toFixed(2)} (surface ${(y + hipsOffset).toFixed(2)}) palm top ${g.bbox.max[1]}`);
    h.close(); ag.close?.();
  }

  console.log(`\n${pass} passed, ${fail} failed`);
} finally {
  server?.kill();
}
process.exit(fail ? 1 : 0);
