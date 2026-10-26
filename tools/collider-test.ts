// colliders: the physical reading of placed geometry, headless (`bun tools/collider-test.ts`).
// Boxes are not infinite columns: resolveColliders reads box.min.y, so a mezzanine slab doesn't shove a walker at
// ground level and a tabletop doesn't eject what lies beneath. The routine is shared by the walking controller (a 1.9m
// capsule) and the ragdoll (a 3cm bead per joint), so the vertical numbers must follow the BODY, not a standing human.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

const { THREE } = await import('./core-stub.mjs');
const { mergeGeometries } = await import(
  '../client/node_modules/three/examples/jsm/utils/BufferGeometryUtils.js');
const C: any = await import('../client/lib/colliders.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const flat = () => 0;
const AVATAR = 1.9;  // a body on its feet: resolveColliders' default
const BEAD = 0.03;       // one ragdoll joint

/** A box prop whose LOCAL box spans y in [y0, y0+h]: geometry starting off its origin, like a mezzanine or shelf. */
function prop(id: string, { w = 1, h = 1, d = 1, y0 = 0, at = [0, 0, 0], collide = 'box' } = {}) {
  const g = new THREE.BoxGeometry(w, h, d);
  g.translate(0, y0 + h / 2, 0);
  const m = new THREE.Mesh(g, undefined);
  // fit "with obj still at identity": it stores LOCAL extents and adds obj.position at query time, so fitting after a
  // move bakes the position in twice and the entity silently stops colliding
  m.updateMatrixWorld(true);
  C.fitCollider(id, m, { collide });
  m.position.set(at[0], at[1], at[2]);
  m.updateMatrixWorld(true);
  C.reindexCollider(id);
  return m;
}

/** A forced-exact (BVH) floor slab with a 0.4m ledge: only exact colliders have a step-up allowance, so this exercises STEP. */
function twoLevel(id: string) {
  const floor = new THREE.BoxGeometry(8, 0.1, 8); floor.translate(0, -0.05, 0);
  const ledge = new THREE.BoxGeometry(3, 0.4, 8); ledge.translate(2.5, 0.2, 0);
  const m = new THREE.Mesh(mergeGeometries([floor, ledge], false), undefined);
  m.updateMatrixWorld(true);
  C.fitCollider(id, m, { collide: 'exact' });
  return m;
}
function at(x: number, y: number, z: number, r = 0.32, tall = AVATAR) {
  const p = new THREE.Vector3(x, y, z);
  const ground = C.resolveColliders(p, flat, r, tall);
  return { push: Math.hypot(p.x - x, p.z - z), ground, blocked: C.lastBlockedTop() };
}

console.log('colliders, headless:\n');

console.log('a crate on the floor (1m cube):');
{
  C.clearColliders(); prop('crate');
  check('walking into its side is pushed out', at(0.4, 0, 0).push > 0.1);
  check('standing on its top gets the top as ground', Math.abs(at(0, 1.0, 0).ground - 1) < 1e-6);
  check('...and the side push offers it as a mantle target',
    Math.abs((at(0.4, 0, 0).blocked ?? -1) - 1) < 1e-6);
  check('well clear of it is untouched', at(3, 0, 0).push === 0);
}

console.log('\nbeing UNDERNEATH things:');
{
  C.clearColliders(); prop('mezzanine', { w: 4, h: 0.3, d: 4, y0: 2.4 });
  check('an avatar walks under a mezzanine slab', at(0, 0, 0).push === 0,
    `pushed ${at(0, 0, 0).push.toFixed(2)}m`);
  check('...and still stands on top of it', Math.abs(at(0, 2.7, 0).ground - 2.7) < 1e-6);
  // the BODY's height decides, not the foot position: a waist-high counter blocks a walker and passes a ragdoll joint
  C.clearColliders(); prop('counter', { w: 3, h: 0.2, d: 3, y0: 1.0 });
  check('...but a waist-high counter still blocks a walking avatar',
    at(0, 0, 0).push > 0.1);
  check('...and the same counter passes a ragdoll joint on the floor',
    at(0, 0.03, 0, BEAD, BEAD).push === 0);

  C.clearColliders(); prop('tabletop', { w: 1.6, h: 0.1, d: 1.6, y0: 0.7 });
  check('a ragdoll joint rests under a tabletop', at(0, 0.03, 0, BEAD, BEAD).push === 0,
    `pushed ${at(0, 0.03, 0, BEAD, BEAD).push.toFixed(2)}m`);
  check('...and a joint ON the tabletop still finds it',
    Math.abs(at(0, 0.83, 0, BEAD, BEAD).ground - 0.8) < 1e-6);
  check('...while a standing avatar still collides with it',
    at(0, 0, 0).push > 0.1);

  C.clearColliders(); prop('shelf', { w: 2, h: 0.3, d: 0.4, y0: 2.2 });
  check('a wall shelf above head height does not block a corridor',
    at(0, 0, 0).push === 0);

  // grazing the underside: the box push exits through the nearest SIDE face, so a centimetre of ceiling overlap threw you clear of the slab
  C.clearColliders(); prop('ceiling', { w: 6, h: 0.2, d: 6, y0: 1.9 });
  check('brushing the underside of a ceiling does not fling you sideways',
    at(0, 0, 0, 0.32, 1.91).push < 0.05,
    `pushed ${at(0, 0, 0, 0.32, 1.91).push.toFixed(2)}m`);
  check('...but at the rim, where sideways IS the short way out, it pushes',
    at(3.25, 1.95, 0, 0.32, 0.1).push > 0.02);
}

console.log('\nthe vertical numbers follow the body:');
{
  // STEP is an exact-collider allowance (boxes rely on the mantle): an avatar steps onto a 0.4m ledge, a ragdoll joint
  // must not (a 55cm step-up teleports a wrist onto the furniture)
  C.clearColliders(); twoLevel('room');
  check('an avatar at the foot of a 0.4m interior ledge steps up',
    at(2.5, 0, 0).ground > 0.3, `ground ${at(2.5, 0, 0).ground.toFixed(2)}`);
  const bead = at(2.5, 0.03, 0, BEAD, BEAD);
  check('a ragdoll joint at the same spot is NOT levitated onto it',
    bead.ground < 0.05, `ground ${bead.ground.toFixed(2)}`);

  C.clearColliders(); prop('crate');
  check('a ragdoll joint never claims a mantle target',
    at(0.4, 0.03, 0, BEAD, BEAD).blocked === null);
  check('...but an avatar still does', at(0.4, 0, 0).blocked !== null);
}

console.log('\nthings too tall to be boxes (the pillar rule):');
{
  // forced to 'box' so it becomes a pillar: a bare room-scale BoxGeometry is HOLLOW, so decide() would call it a walkable
  // interior (a real tree's trunk fails that probe on its own)
  C.clearColliders(); prop('tree', { w: 6, h: 5, d: 6, y0: 0, collide: 'box' });
  check('you walk under a canopy', at(3, 0, 0).push === 0);
  check('you do not walk through the trunk', at(0.1, 0, 0).push > 0);
  check('a trunk is not a mantle target', at(0.1, 0, 0).blocked === null);
}

console.log('\nregression guards — the walking avatar must not have changed:');
{
  // a 1.9m body sees exactly the old constants: step 0.55, probe 0.95, span ~0.5
  C.clearColliders();
  prop('a', { w: 1, h: 1, d: 1, at: [0, 0, 0] });
  prop('b', { w: 1, h: 0.5, d: 1, at: [3, 0, 0] });
  const rows = [at(0.4, 0, 0), at(0, 1, 0), at(3.4, 0, 0), at(3, 0.5, 0), at(8, 0, 0)];
  check('default `tall` reproduces the avatar case exactly', rows.every((r, i) =>
    Math.abs(r.push - [0.42, 0, 0.42, 0, 0][i]) < 0.005), rows.map((r) => r.push.toFixed(2)).join(' '));
  check('a box on the floor still has no gap to slip under',
    at(0.4, 0, 0, 0.32, 0.05).push > 0.1);
}

console.log('\nfloor-shaped things with lying tops (the blanket rule, issue #11):');
{
  // a 3×3m blanket, 4cm thick, three 0.5m cushions, no collide override (the auto rule is under test); tessellated 12×12
  // because the lie probe buckets vertices (the sparse case is pinned below)
  const blanket = (id: string, seg = 12) => {
    const cloth = new THREE.BoxGeometry(3, 0.04, 3, seg, 1, seg); cloth.translate(0, 0.02, 0);
    const parts = [cloth];
    for (const [px, pz] of [[-0.9, -0.9], [0.9, -0.6], [0.2, 1.0]]) {
      const p = new THREE.BoxGeometry(0.7, 0.5, 0.7); p.translate(px, 0.29, pz);
      parts.push(p);
    }
    const m = new THREE.Mesh(mergeGeometries(parts, false), undefined);
    m.updateMatrixWorld(true);
    C.fitCollider(id, m, {});
    return m;
  };
  C.clearColliders(); blanket('blanket');
  check('a blanket with cushions auto-classifies exact', !!C.colliders.get('blanket').exact);
  // issue #11's three acceptance observables, in order
  const rim = at(1.6, 0, 0);
  check('1: no shove at the rim — you step onto the cloth', rim.push < 0.05,
    `pushed ${rim.push.toFixed(2)}m`);
  check('2: no phantom mantle target at cushion height', rim.blocked === null);
  check('3a: ground on bare cloth is the cloth', Math.abs(at(-1.2, 0.04, 0.9).ground - 0.04) < 0.02,
    `ground ${at(-1.2, 0.04, 0.9).ground.toFixed(2)}`);
  check('3b: ground on a cushion is the cushion', Math.abs(at(0.2, 0.54, 1.0).ground - 0.54) < 0.02,
    `ground ${at(0.2, 0.54, 1.0).ground.toFixed(2)}`);
  check('...and a cushion is a step up from the cloth, not a wall',
    Math.abs(at(0.2, 0.04, 1.0).ground - 0.54) < 0.02);

  // the gates hold: each of these is one clause away from being a blanket
  const auto = (id: string, w: number, h: number, d: number, bumpH = 0) => {
    const base = new THREE.BoxGeometry(w, h, d); base.translate(0, h / 2, 0);
    const parts = [base];
    if (bumpH) { const b = new THREE.BoxGeometry(w * 0.5, bumpH, d * 0.5); b.translate(0, h + bumpH / 2, 0); parts.push(b); }
    const m = new THREE.Mesh(mergeGeometries(parts, false), undefined);
    m.updateMatrixWorld(true);
    C.fitCollider(id, m, {});
    return C.colliders.get(id);
  };
  C.clearColliders();
  check('a 1m crate stays a box (footprint gate)', !auto('crate2', 1, 1, 1).exact);
  C.clearColliders();
  check('an honest flat slab stays a box (lie gate)', !auto('slab', 3, 0.3, 3).exact);
  C.clearColliders();
  check('a car-height hump stays a box (height gate)', !auto('car', 3, 0.9, 2.5, 0.36).exact);
  C.clearColliders();
  // the probe's known blind spot, deliberate: a corner-only low-poly mesh keeps its box (wrong in the safe direction)
  blanket('sparse', 1);
  check('a corner-only low-poly blanket keeps the status quo (box)',
    !C.colliders.get('sparse').exact);
  C.clearColliders();
  // the override still outranks the rule, both ways
  const m = blanket('forced');
  C.removeCollider('forced');
  C.fitCollider('forced', m, { collide: 'box' });
  check('collide:"box" still wins over the blanket rule', !C.colliders.get('forced').exact);
}

// ---- a thing a tumbling engine laid down ----
// readers work root-local with a yaw: a slab on its side read through rotation.y alone is a wall with no floor, and a
// box yawed 180° by quaternion reads back from three's Euler as x = z = π, rotation.y 0
console.log('\ntumbled and quaternion-yawed things:');
{
  const lay = (id: string, q: number[], at: number[], tx = 0) => { const g = new THREE.BoxGeometry(1, 2, 0.5); g.translate(tx, 1, 0);
    const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true); C.fitCollider(id, m, { collide: 'box' });
    m.quaternion.set(q[0], q[1], q[2], q[3]); m.position.set(at[0], at[1], at[2]); m.updateMatrixWorld(true); C.reindexCollider(id); return m; };
  const s2 = Math.SQRT1_2;
  lay('side', [0, 0, s2, s2], [20, 0.5, 0]);  // local +y → world -x: x in [18, 20], y in [0, 1], z in [-0.25, 0.25]
  const on = at(19, 1.0, 0);
  check('lying on its side: its true top is floor (y 1)', Math.abs(on.ground - 1) < 1e-6 && on.push < 1e-9, JSON.stringify(on));
  const beside = at(20.6, 0, 0);
  check('…and beside its origin, where it no longer stands, is open floor', beside.push < 1e-9 && beside.ground === 0, JSON.stringify(beside));
  const under = C.surfaceUnder(18.5, 0, flat);
  check('…a thing dropped over it lands on that top', under.onto === 'side' && Math.abs(under.y - 1) < 1e-6, JSON.stringify(under));
  const c = C.entityWorldCenter('side');
  check('…and its world centre is where the slab is', c && Math.abs(c.x - 19) < 1e-6 && Math.abs(c.y - 0.5) < 1e-6, JSON.stringify(c));
  lay('flip', [0, 1, 0, 0], [40, 0, 0], 0.5 + 0.25);   // geometry x in [0.25, 1.25]; yawed 180°: world x in [38.75, 39.75]
  const f1 = at(39.25, 2.0, 0);
  check('yawed 180° by quaternion: its top is floor where it really is', Math.abs(f1.ground - 2) < 1e-6, JSON.stringify(f1));
  const f2 = at(40.75, 0, 0);
  check('…and its mirror image (where rotation.y alone puts it) is open floor', f2.push < 1e-9 && f2.ground === 0, JSON.stringify(f2));
}

// ---- the camera ray, a refit, the index, a fallen post ----
console.log('\nthe camera ray, a refit, the spatial index, a fallen post:');
{
  const s2 = Math.SQRT1_2;
  const box = (id: string, w: number, h: number, d: number, q: number[], at: number[]) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(0, h / 2, 0);
    const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true); C.fitCollider(id, m, { collide: 'box' });
    m.quaternion.set(q[0], q[1], q[2], q[3]); m.position.set(at[0], at[1], at[2]); m.updateMatrixWorld(true); C.reindexCollider(id); return m; };
  // the third-person camera casts this every frame
  box('rayc', 1, 1, 1, [0, 0, 0, 1], [60, 0, 3]);
  let hit: any; try { hit = C.raySegment(new THREE.Vector3(60, 0.5, 0), new THREE.Vector3(0, 0, 1), 10); } catch (e) { hit = String(e); }
  check('the camera ray stops at a crate (2.5 m away), and never throws', typeof hit === 'number' && Math.abs(hit - 2.5) < 1e-6, String(hit));
  box('rayl', 1, 2, 0.5, [0, 0, s2, s2], [70, 0.5, 3]);   // lying: x 68..70, y 0..1 at z 2.75..3.25
  let hl: any; try { hl = C.raySegment(new THREE.Vector3(69, 0.5, 0), new THREE.Vector3(0, 0, 1), 10); } catch (e) { hl = String(e); }
  check('…and at a slab lying on its side, where it lies', typeof hl === 'number' && Math.abs(hl - 2.75) < 1e-6, String(hl));
  // a refit changes exactness in place; a thing yawed past 90° must not keep the old answer
  const parts: any[] = []; const add = (w: number, h: number, d: number, x: number, y: number, z: number) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y, z); parts.push(g); };
  add(0.5, 0.01, 0.5, 0, 0.005, 0); add(0.01, 0.3, 0.5, -0.25, 0.15, 0); add(0.01, 0.3, 0.5, 0.25, 0.15, 0); add(0.5, 0.3, 0.01, 0, 0.15, -0.25);
  const house = new THREE.Mesh(mergeGeometries(parts, false), undefined); house.updateMatrixWorld(true); C.fitCollider('house', house, {});
  house.quaternion.set(0, 1, 0, 0); house.position.set(100, 0, 0); house.updateMatrixWorld(true); C.reindexCollider('house');
  const he = C.colliders.get('house'); const before = !!C.frameOf(he).exact;
  house.scale.setScalar(30); house.updateMatrixWorld(true); C.refitCollider('house'); const he2 = C.colliders.get('house');
  const inside = new THREE.Vector3(100, 0.3, 2); C.resolveColliders(inside, flat);
  check('a refit that makes a 180°-yawed room exact is read as exact (a body inside stays inside)', !before && !!he2.exact && !!C.frameOf(he2).exact && Math.abs(inside.z - 2) < 1e-6,
    JSON.stringify({ before, exact: !!he2.exact, frame: !!C.frameOf(he2).exact, z: inside.z }));
  // filed by its true footprint: a 2.3 m slab lying along +x from its origin is found at its far end
  box('far', 1, 2.3, 0.5, [0, 0, -s2, s2], [126.5, 0.5, 0]);   // local +y → world +x: x 126.5..128.8
  const end = C.surfaceUnder(128.7, 0, flat);
  check('a long thing lying down is found at its far end (filed by where it lies)', end.onto === 'far' && Math.abs(end.y - 1) < 1e-6, JSON.stringify(end));
  // a tall thing is a slim post while it stands; fallen, it's a log (its whole box)
  box('tree', 0.3, 3, 0.3, [0, 0, s2, s2], [150, 0.15, 0]);    // x 147..150, y 0..0.3
  const log = C.surfaceUnder(147.4, 0, flat);
  check('a fallen tall thing is its whole box, not a post at its centre', C.colliders.get('tree').pillar && log.onto === 'tree' && Math.abs(log.y - 0.3) < 1e-6, JSON.stringify(log));
}

// the camera ray reads a fallen tall thing as the walker does (a log, not a post at its middle)
{
  const g = new THREE.BoxGeometry(0.6, 3, 0.6); g.translate(0, 1.5, 0); const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true);
  C.fitCollider('trunk', m, { collide: 'box' }); const s2 = Math.SQRT1_2;
  m.quaternion.set(0, 0, -s2, s2); m.position.set(200, 0.3, 0); m.updateMatrixWorld(true); C.reindexCollider('trunk');   // x 200..203, y 0..0.6
  let t: any; try { t = C.raySegment(new THREE.Vector3(202.8, 0.3, -2), new THREE.Vector3(0, 0, 1), 10); } catch (e) { t = String(e); }
  check('the camera ray meets a fallen trunk near its end (it is a log to the ray too)', C.colliders.get('trunk').pillar && typeof t === 'number' && Math.abs(t - 1.7) < 1e-6, String(t));
}

// the per-lib cache is keyed by entry.lib: removing every collider wearing a lib releases it, and a second clone of a
// floor-shaped lib reuses the first's lie probe
{
  const slab = () => { const g = new THREE.BoxGeometry(4, 0.2, 4); g.translate(0, 0.1, 0); const m = new THREE.Mesh(g, undefined); m.updateMatrixWorld(true); return m; };
  C.fitCollider('lib-a', slab(), { collide: 'box', lib: 'test/slab.glb' });
  const first = C.colliderCacheStats().libs.find((l: any) => l.lib === 'test/slab.glb');
  C.fitCollider('lib-b', slab(), { collide: 'box', lib: 'test/slab.glb' });
  const both = C.colliderCacheStats().libs.find((l: any) => l.lib === 'test/slab.glb');
  check('two clones of a lib hold two refs on one cache entry', first?.refs === 1 && both?.refs === 2, JSON.stringify({ first, both }));
  check('…and the first clone\'s lie probe is shared with the cache', both?.lie != null, JSON.stringify(both));
  C.removeCollider('lib-a'); C.removeCollider('lib-b');
  const gone = C.colliderCacheStats().libs.find((l: any) => l.lib === 'test/slab.glb');
  check('removing both releases the lib', gone === undefined, JSON.stringify(gone));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
