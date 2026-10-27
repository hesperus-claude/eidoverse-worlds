// track-teleport-test.ts: a forced track (every act re-tracks my body first) re-arrives by teleport at most once in 3 s,
// as an unforced one does; each teleport is an act on the record. Headless through the real thingphysics.js, on
// put-settle's stubs (tools/put-settle-stub.mjs).
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/track-teleport-test.ts
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
const STUB = here('./put-settle-stub.mjs');
plugin({
  name: 'track-teleport-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    for (const m of ['world', 'remotes', 'colliders', 'autohooks', 'bodyscale', 'net', 'ui', 'chat', 'actions', 'emitters', 'serverclock', 'plainwords', 'markup', 'xrask'])
      b.onResolve({ filter: new RegExp(`^\\./${m}\\.js$`) }, () => ({ path: STUB }));
  },
});

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};
const S: any = await import('./put-settle-stub.mjs');
const { THREE } = await import('./core-stub.mjs');
let T = 0;
(globalThis.performance as any).now = () => T;
const tp: any = await import('../client/lib/thingphysics.js');
const me = { root: new THREE.Object3D(), vrm: null };
tp.initThingPhysics({ myPos: () => me.root.position, me: () => me, camera: null, editing: () => false, myState: () => ({ yaw: 0 }) });

// the authority: arriving and teleports are taken, every step is too fast (it lost my body)
let arrivedYet = false;
S.setReply((verb: string, a: any) => (verb !== 'move' || a.teleport || !arrivedYet ? { ok: true } : { ok: false, refused: { code: 'too-fast' } }));
const teleports = () => S.sent.filter(([v, a]: any) => v === 'move' && a.teleport).length;
T = 10_000; arrivedYet = false;
check('the first track arrives (one move, no teleport)', (await tp.physicsApi.track()) === true && tp.physicsApi.body().arrived && teleports() === 0, JSON.stringify(tp.physicsApi.body()));
arrivedYet = true;
me.root.position.set(1, 0, 0);
T = 10_100; await tp.physicsApi.track();
check('a forced track whose step is refused too-fast re-arrives by teleport', tp.physicsApi.body().lastMove?.teleport === true && teleports() === 1, JSON.stringify(tp.physicsApi.body().lastMove));
me.root.position.set(2, 0, 0);
T = 10_600; const n0 = S.sent.length; await tp.physicsApi.track();
const steps = S.sent.slice(n0);
check('0.5 s later a forced track sends its step, which the authority refuses too-fast (the setup)', steps[0]?.[0] === 'move' && !steps[0][1].teleport && arrivedYet, JSON.stringify(steps));
check('…and does NOT teleport again inside 3 s', teleports() === 1, `${teleports()} teleports`);
me.root.position.set(3, 0, 0);
T = 13_200; await tp.physicsApi.track();
check('past 3 s since the last, a forced track teleports again', teleports() === 2, `${teleports()} teleports`);

console.log(`\ntrack-teleport: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
