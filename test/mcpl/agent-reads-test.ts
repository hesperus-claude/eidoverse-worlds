// agent-reads-test: the agent's roster, terrain, heightmap, geometry, body-bone, rig and skeleton reads have a deadline
// (AbortSignal), and a geometry or skeleton read that threw or timed out isn't cached, so the next walk or body asks
// again; an answer is kept, a 4xx one too (a 5xx is the server's trouble: asked again).
//   bun test/mcpl/agent-reads-test.ts
process.env.WORLD_TOKEN = "";
import { suite } from "../gate/suite.ts";
import { tryUntil } from "../gate/wait.ts";
const { WorldAgent } = await import("../../mcpl/agent.ts");

const { check, done } = suite("agent-reads");

type Seen = { url: string; signal: unknown };
const seen: Seen[] = [];
let answer: (url: string) => Promise<Response> = async () => new Response("no", { status: 404 });
const realFetch = globalThis.fetch;
globalThis.fetch = (async (u: any, init?: any) => { seen.push({ url: String(u), signal: init?.signal }); return answer(String(u)); }) as typeof fetch;
const readOf = (part: string) => seen.find((s) => s.url.includes(part));
// a deadline is a timeout signal (AbortSignal.timeout), not just any signal
// of at most a minute: an hour-long one is no deadline for an agent's turn
const timed = new WeakMap<AbortSignal, number>(); const realTimeout = AbortSignal.timeout.bind(AbortSignal);
AbortSignal.timeout = ((ms: number) => { const s = realTimeout(ms); timed.set(s, ms); return s; }) as typeof AbortSignal.timeout;
const bounded = (s: Seen | undefined) => s?.signal instanceof AbortSignal && (timed.get(s.signal) ?? Infinity) <= 60_000;

try {
  const ag: any = new WorldAgent({ name: "reader", world: "reads-bench", url: "ws://127.0.0.1:1/ws" });
  const GRID = "store/heightmaps/0123456789abcdef.json";
  answer = async (url) => url.endsWith("/library/eidoverse/terrain.js") ? new Response("") : new Response("no", { status: 404 });
  await ag.seatCache.init();
  await ag.ground.buildTerrain({ heightmap: { grid: GRID, min: 0, max: 1 } }).catch(() => {});
  await ag.ground.geomFor("store/a.glb");
  await ag.loadBodyBones();
  for (const [what, part] of [["the seat roster", "/avatars"], ["terrain.js", "/library/eidoverse/terrain.js"],
    ["a heightmap's grid", `/library/${GRID}`], ["a model's geometry", "/geom?lib="], ["the body's bones", `/library/${ag.avatar}`]]) {
    const s = readOf(part);
    check(`a read of ${what} has a deadline`, bounded(s), s ? `${s.url}: no signal` : `no read of ${part} was made`);
  }

  // a geometry read that timed out is asked again; one the server answered is kept
  seen.length = 0;
  answer = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
  const first = await ag.ground.geomFor("store/slow.glb");
  answer = async () => new Response("no", { status: 404 });
  const second = await ag.ground.geomFor("store/slow.glb");
  const asked = seen.filter((s) => s.url.includes("slow.glb")).length;
  check("a geometry read that timed out isn't kept: the next walk asks again", first === null && second === null && asked === 2, `${asked} read(s)`);
  await ag.ground.geomFor("store/slow.glb");
  const kept = seen.filter((s) => s.url.includes("slow.glb")).length;
  check("...and the server's answer is kept: it isn't asked a third time", kept === 2, `${kept} read(s)`);
  // a 503 is the server's own trouble, not an answer about the model: asked again once it recovers (bot #333 r2 173)
  seen.length = 0;
  answer = async () => new Response("busy", { status: 503 });
  await ag.ground.geomFor("store/busy.glb");
  answer = async () => new Response(JSON.stringify({ bbox: [[0, 0, 0], [1, 1, 1]] }), { headers: { "content-type": "application/json" } });
  const back = await ag.ground.geomFor("store/busy.glb");
  check("a geometry read the server answered 503 isn't kept: the next one gets the geometry", !!back?.bbox && seen.filter((x) => x.url.includes("busy.glb")).length === 2, JSON.stringify(back));
  ag.close();

  // a terrain.js that came back an error page isn't cached: the next build asks again (bot #333 107)
  const ag2: any = new WorldAgent({ name: "reader2", world: "reads-bench", url: "ws://127.0.0.1:1/ws" });
  seen.length = 0;
  answer = async () => new Response("<html>503</html>", { status: 503 });
  await ag2.ground.buildTerrain({ seed: 1, size: 40 }).catch(() => {});
  answer = async (url) => url.endsWith("/library/eidoverse/terrain.js") ? new Response("") : new Response("no", { status: 404 });
  await ag2.ground.buildTerrain({ seed: 1, size: 40 }).catch(() => {});
  const tries = seen.filter((s) => s.url.endsWith("/library/eidoverse/terrain.js")).length;
  check("a terrain.js that answered 503 isn't kept: the next build fetches it again", tries === 2 && ag2.ground.terrainSrc === "", `${tries} read(s), cached ${JSON.stringify(ag2.ground.terrainSrc)}`);
  ag2.close();
  // a terrain build still loading when its body closes commits nothing: the height and water fields are the process's
  // (a successor's by then), so the departed world's ground must not land on them (bot #333 r2 171)
  { const ag3 = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "closing", world: "w" } as any);
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    answer = async (u) => { if (u.endsWith("/terrain.js")) { await held; return new Response("globalThis.makeTerrain = () => ({ heightAt: () => 7 });"); } return new Response("no", { status: 404 }); };
    (ag3 as any).ground.terrainSrc = null;
    const build = (ag3 as any).ground.buildTerrain({ kind: "noise" });
    ag3.close(); release(); await build.catch(() => {});
    check("a terrain build that finishes after its body closed commits no ground", !(ag3 as any).ground.terrain, String(!!(ag3 as any).ground.terrain)); }

  // G2-054: a terrain.js that failed to load is asked for again by the tick, not only by the world's next terrain change
  { const ag5: any = new WorldAgent({ url: "ws://127.0.0.1:1/ws", name: "regrounded", world: "w" } as any);
    answer = async () => new Response("<html>503</html>", { status: 503 });
    await ag5.ground.buildTerrain({ seed: 1, size: 40 }).catch(() => {});
    answer = async (u) => u.endsWith("/terrain.js") ? new Response("globalThis.makeTerrain = () => ({ heightAt: () => 7 });") : new Response("no", { status: 404 });
    ag5.joined = true;
    await tryUntil("the tick builds the ground again", () => { ag5.tick(); return !!ag5.ground.terrain; }, { ms: 6000, step: 100 });
    ag5.joined = false;
    check("a terrain.js that failed to load is fetched again by the tick, and the ground is built (G2-054)", ag5.ground.heightAt(0, 0) === 7, `ground ${ag5.ground.heightAt(0, 0)}`);
    ag5.close(); }

  // G2-062: the rig and skeleton reads have a deadline too, and a skeleton read that threw or met a 5xx isn't kept as
  // "this body has no skeleton": the next body asks again
  { const { rigBonesFor } = await import("../../mcpl/rigbones.ts");
    const { HeadlessBody } = await import("../../mcpl/physics.ts");
    const { fixture } = await import("../fixtures/body-fixture.ts");
    const vrm = fixture();
    seen.length = 0;
    answer = async () => new Response(vrm);
    await rigBonesFor("http://rig.test", "store/rigged.vrm");
    check("a read of an avatar's rig has a deadline (rigbones.ts)", bounded(readOf("rigged.vrm")), readOf("rigged.vrm") ? "no signal" : "no read");
    seen.length = 0;
    answer = async () => new Response("busy", { status: 503 });
    const busy = await HeadlessBody.create("http://skel.test", "store/skel.vrm");
    check("a read of an avatar's skeleton has a deadline (physics.ts skeletonFor)", bounded(readOf("skel.vrm")), readOf("skel.vrm") ? "no signal" : "no read");
    answer = async () => new Response(vrm);
    const back = await HeadlessBody.create("http://skel.test", "store/skel.vrm");
    check("a skeleton read the server answered 503 isn't kept: the next body gets the skeleton", busy === null && back !== null && seen.filter((x) => x.url.includes("skel.vrm")).length === 2, `${busy} then ${back}`);
    answer = async () => { throw new DOMException("The operation timed out.", "TimeoutError"); };
    const slow = await HeadlessBody.create("http://skel.test", "store/slow.vrm");
    answer = async () => new Response(vrm);
    const after = await HeadlessBody.create("http://skel.test", "store/slow.vrm");
    check("...and nor is one that timed out", slow === null && after !== null, `${slow} then ${after}`);
    // G2-061: the skeleton is the server's file at that version: another server's file of the same path is read from
    // that server, and an avatar-updated event (invalidateBodyAsset) has it read again
    seen.length = 0;
    await HeadlessBody.create("http://other.test", "store/skel.vrm");
    check("a skeleton is read per server: the same path on another server is read from it (G2-061)", seen.some((x) => x.url.startsWith("http://other.test/")), JSON.stringify(seen.map((x) => x.url)));
    const ag4: any = new WorldAgent({ name: "reader4", world: "reads-bench", url: "ws://127.0.0.1:1/ws" });
    seen.length = 0;
    await HeadlessBody.create(ag4.httpBase, "store/skel.vrm");
    await HeadlessBody.create(ag4.httpBase, "store/skel.vrm");
    const once = seen.length;
    ag4.invalidateBodyAsset("skel");
    await HeadlessBody.create(ag4.httpBase, "store/skel.vrm");
    check("...kept for the next body, and read again once its avatar's bytes change (avatar-updated)", once === 1 && seen.length === 2, `${once} read(s), then ${seen.length}`);
    ag4.close();
    // a skeleton whose avatar changed while it downloaded isn't kept: the read in flight is what forgetSkeletons forgets
    const { forgetSkeletons } = await import("../../mcpl/physics.ts");
    seen.length = 0;
    let release!: () => void; const held = new Promise<void>((r) => { release = r; });
    answer = async () => { await held; return new Response(vrm); };
    const during = HeadlessBody.create("http://held.test", "store/held.vrm");
    await tryUntil("the first skeleton read is under way", () => seen.length === 1, { ms: 3000 });
    forgetSkeletons("http://held.test", "held"); release(); await during;
    answer = async () => new Response(vrm);
    await HeadlessBody.create("http://held.test", "store/held.vrm");
    check("a skeleton read in flight when its avatar changed isn't kept: the next body reads the new bytes", seen.length === 2, `${seen.length} read(s)`);
    // a VRM is many megabytes: a slow link that keeps sending is read to the end, not cut at a header read's deadline. Here
    // every timeout runs at 1/20 (main's 10 s whole-read deadline would be 0.5 s) and the file trickles in over 1.2 s; the
    // stream fails if its fetch's signal aborts, as a real download does
    const { SKELETON_READ } = await import("../../mcpl/physics.ts") as any;
    const trickle = (chunks: number, everyMs: number, upTo = chunks) => () => {
      const signal = seen.at(-1)?.signal as AbortSignal | undefined, size = Math.ceil(vrm.length / chunks);
      return Promise.resolve(new Response(new ReadableStream({ start(c) {
        let i = 0;
        const next = () => {
          if (signal?.aborted) { c.error(signal.reason); return; }
          if (i >= upTo) { signal?.addEventListener("abort", () => c.error(signal.reason)); return; }   // stalls here
          c.enqueue(vrm.subarray(i * size, ++i * size)); if (i === chunks) c.close(); else setTimeout(next, everyMs);
        };
        setTimeout(next, everyMs);
      } })));
    };
    AbortSignal.timeout = ((ms: number) => { const sig = realTimeout(ms / 20); timed.set(sig, ms); return sig; }) as typeof AbortSignal.timeout;
    try {
      seen.length = 0;
      answer = trickle(12, 100) as any;
      const [one, two] = await Promise.all([HeadlessBody.create("http://slow.test", "store/trickle.vrm"), HeadlessBody.create("http://slow.test", "store/trickle.vrm")]);
      check("a skeleton downloading slowly but steadily is read to the end, once for two bodies asking together", one !== null && two !== null && seen.length === 1, `${one} ${two}, ${seen.length} read(s)`);
      const stallWas = SKELETON_READ?.stallMs; if (SKELETON_READ) SKELETON_READ.stallMs = 300;
      seen.length = 0;
      answer = trickle(12, 50, 2) as any;
      const t0 = Date.now(), stalled = await HeadlessBody.create("http://slow.test", "store/stall.vrm"), took = Date.now() - t0;
      if (SKELETON_READ) SKELETON_READ.stallMs = stallWas;
      answer = async () => new Response(vrm);
      const again = await HeadlessBody.create("http://slow.test", "store/stall.vrm");
      check("...while one that stops sending fails at its stall deadline, and isn't kept", stalled === null && took < 1500 && again !== null && seen.length === 2, `${stalled} after ${took} ms, then ${again}`);
    } finally { AbortSignal.timeout = ((ms: number) => { const sig = realTimeout(ms); timed.set(sig, ms); return sig; }) as typeof AbortSignal.timeout; } }

  // G6-034: a posture clip roster (/animations) that failed to load isn't kept as empty for the body's life: the next
  // clip asks again, and finds the world's own path for it
  { const { PoseClips } = await import("../../mcpl/pose-clips.ts");
    const clips = new PoseClips("http://clips.test");
    seen.length = 0;
    answer = async (u) => { if (u.endsWith("/animations")) throw new DOMException("The operation timed out.", "TimeoutError"); return new Response("no", { status: 404 }); };
    await clips.load("sit").catch(() => {});
    answer = async (u) => u.endsWith("/animations") ? Response.json([{ name: "sit_laying_on_ground", path: "custom/lie.vrma" }]) : new Response("no", { status: 404 });
    await clips.load("lie").catch(() => {});
    check("a clip roster that failed to load is asked again by the next clip, which reads the world's path for it (G6-034)",
      seen.filter((x) => x.url.endsWith("/animations")).length === 2 && seen.some((x) => x.url.endsWith("/library/custom/lie.vrma")), JSON.stringify(seen.map((x) => x.url)));
    answer = async () => new Response("no", { status: 404 });
    await clips.load("idle").catch(() => {});
    check("...and one it read is kept: a third clip doesn't ask again", seen.filter((x) => x.url.endsWith("/animations")).length === 2, JSON.stringify(seen.map((x) => x.url))); }
} finally {
  globalThis.fetch = realFetch;
}
done();
