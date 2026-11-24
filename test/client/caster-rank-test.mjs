// WHAT THE CASTER BUDGET SPENDS ITSELF ON (client/lib/render/lightrig.js casterPass).
//
// The budget lets K things cast. It ranked by distance from the camera alone, so in the lab's furnished night room
// (2026-11-23, budget 48, ~110 things) fifteen 3 cm fairy-light beads, a candle flame and a dozen glowing lamp bodies
// cast while the 3.4 m sofa, its pillows and the wood stove did not; in the path-traced reference the sofa's and
// stove's shadows are among the largest features of the frame.
//
// The contract:
//   - things rank by APPARENT size (bounding radius / distance, roughly the angle they subtend), not distance alone;
//   - a thing whose every mesh is an emitter (attachLamps' test: a flat emissive colour above 0.5, or a map driven above
//     strength 1) is not offered WHILE A LIGHT SITS INSIDE IT: a lamp's glass must not shadow its own bulb. With no light
//     in it, it is a thing like any other (a glowing crystal under the sun casts). A thing only partly emissive is offered;
//   - a thing out of every shadow map's reach (outside the sun's shadow box, and no casting lamp reaches it) ranks after
//     everything a shadow can be drawn for;
//   - the radius is measured once, at registration, in the thing's own frame, so scaling it afterwards still counts;
//   - the hysteresis is a ratio on that score (a caster keeps casting within 1.25x of the edge).
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { suite } from "../gate/suite.ts";
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+(render\/)?warmqueue\.js$/, () => ({ path: here('../stubs/lod-client-stub.mjs') }));   // warmDepth resolves at once
} });
const { THREE, camera } = await import('../stubs/core-stub.mjs');
const rig = await import('../../client/lib/render/lightrig.js');
const { updateRig, registerCaster, releaseCaster, setCasterBudget, rigDebug } = rig;

const S = suite("caster-rank");
const check = (name, ok, note) => S.check(name, ok, note);

camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true);
const plain = () => new THREE.MeshStandardMaterial({ color: 0x806040 });
const glowing = () => new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xffd080, emissiveIntensity: 3 });
// a thing: a group at `pos` holding one mesh per [geometry, material]
const thing = (id, pos, parts) => {
  const g = new THREE.Group(); g.position.set(...pos);
  for (const [geo, mat] of parts) g.add(new THREE.Mesh(geo, mat));
  g.updateMatrixWorld(true);
  registerCaster(id, g);
  return g;
};
const ids = [];
const room = () => {
  // eight fairy-light beads, 3 cm, all emitter, 1.5 m away; two pebbles, 3 cm, NOT emitters, 1.2 m away
  for (let i = 0; i < 8; i++) { const id = `bead${i}`; ids.push(id); thing(id, [1.5 * Math.cos(i), 1.6, 1.5 * Math.sin(i)], [[new THREE.SphereGeometry(0.03), glowing()]]); }
  for (let i = 0; i < 2; i++) { const id = `pebble${i}`; ids.push(id); thing(id, [0, 1.6, i ? 1.2 : -1.2], [[new THREE.SphereGeometry(0.03), plain()]]); }
  ids.push('sofa', 'stove');
  thing('sofa', [4, 0.45, 0], [[new THREE.BoxGeometry(3.4, 0.9, 1), plain()]]);
  thing('stove', [-3.5, 0.6, 0], [[new THREE.BoxGeometry(0.8, 1.2, 0.8), plain()]]);
};
const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
let t = 1000;
// enough caster passes (≥300 ms apart) for every winner to warm and flip at ≤2 per pass
const passes = async (n = 12) => { for (let i = 0; i < n; i++) { updateRig(t += 301); await settle(); } };
const list = () => Object.fromEntries(rigDebug().casterList.map((c) => [c.id, c]));
const casting = () => rigDebug().casterList.filter((c) => c.casting).map((c) => c.id).sort();
const clear = () => { for (const id of ids.splice(0)) releaseCaster(id); };

console.log('THE NIGHT ROOM — budget 2: the sofa and the stove cast, not the beads and pebbles nearer the eye');
room();
setCasterBudget(2);
await passes();
{ const on = casting();
  check('the sofa casts', on.includes('sofa'), JSON.stringify(on));
  check('the stove casts', on.includes('stove'), JSON.stringify(on));
  check('no 3 cm bead takes a slot from them', !on.some((id) => id.startsWith('bead')), JSON.stringify(on));
  check('no 3 cm pebble takes a slot from them (size ranks, not only the emitter rule)', !on.some((id) => id.startsWith('pebble')), JSON.stringify(on)); }

console.log('GLOW BODIES — an all-emitter thing with a light inside it is not offered; one with none is a thing like any other');
setCasterBudget(24);
ids.push('lantern', 'monolith');
// a lantern glass with its point light at its centre (the lab's street lamp): the glass would shadow its own light
thing('lantern', [2, 3, -4], [[new THREE.SphereGeometry(0.25), glowing()]]);
rig.requestLight('complight:lantern', { authored: true, intensity: 20, range: 9, pos: [2, 3, -4] });
// a 2 m glowing crystal with no light in it: under the sun it is a solid thing and its missing shadow reads as floating
thing('monolith', [-2, 1, -5], [[new THREE.BoxGeometry(1, 2, 1), glowing()]]);
await passes();
{ const l = list();
  check('the lantern glass around its own light never casts, with budget to spare', l.lantern?.casting !== true, JSON.stringify(l.lantern));
  check('a glowing thing with no light inside it casts like any other thing', l.monolith?.casting === true, JSON.stringify(l.monolith));
  check('a bead with no light in it casts once the budget has room (size ranks it, glow does not bar it)', l.bead0?.casting === true, JSON.stringify(l.bead0));
  check('the pebbles do cast once the budget has room', l.pebble0?.casting === true && l.pebble1?.casting === true, JSON.stringify(casting()));
  // the light moves out of the glass (or the lamp is switched off: models.js releases the request): the glass is a thing again
  rig.releaseLight('complight:lantern');
  await passes();
  check('once no light sits in it the lantern glass casts', list().lantern?.casting === true, JSON.stringify(list().lantern));
  rig.requestLight('complight:lantern', { authored: true, intensity: 20, range: 9, pos: [2, 3, -4] });
  await passes(); await passes();
  check('…and stops again when a light is put back inside', list().lantern?.casting === false, JSON.stringify(list().lantern));
  rig.releaseLight('complight:lantern'); }
clear();

console.log('OUT OF REACH — a thing no shadow map can hold takes no slot from one that casts a visible shadow');
{ setCasterBudget(1);
  ids.push('tower', 'crate');
  // The sun's shadow map is a box around the camera (46 m to each side, lightrig.js SHADOW_HALF): a tower 200 m off
  // draws into no map, whatever the budget says. It subtends more than the crate (40/200 = 0.2 against 0.4/6 = 0.067).
  thing('tower', [0, 0, -200], [[new THREE.SphereGeometry(40), plain()]]);
  thing('crate', [0, 0.4, -6], [[new THREE.SphereGeometry(0.4), plain()]]);
  await passes();
  check('the crate inside the sun\'s shadow box takes the one slot', casting().includes('crate'), JSON.stringify(casting()));
  check('the tower 200 m away does not hold it', !casting().includes('tower'), JSON.stringify(casting()));
  setCasterBudget(2);
  await passes();
  check('with budget to spare the far tower may cast too (it costs no draw: the shadow camera culls it)', casting().join() === 'crate,tower', JSON.stringify(casting()));
  // a casting lamp reaches its own surroundings wherever the sun's box is: a statue beside a lamped body 150 m off
  releaseCaster('crate'); setCasterBudget(1);
  ids.push('statue');
  thing('statue', [2, 1, -150], [[new THREE.SphereGeometry(1), plain()]]);
  rig.requestLight('lamp:body:far:0', { keep: true, intensity: 8, range: 10, shadows: true, pos: [0, 1.5, -150] });
  await passes();
  check('a thing within the casting lamp\'s range is in reach, far outside the sun\'s box', casting().join() === 'statue', JSON.stringify(casting()));
  rig.releaseLight('lamp:body:far:0');
  clear(); }

console.log('PARTLY EMISSIVE — a lamp with a glowing bulb and a plain shade is offered, whole');
{ ids.push('lamp');
  const lamp = thing('lamp', [0, 0, -3], [[new THREE.CylinderGeometry(0.2, 0.3, 0.4), plain()], [new THREE.SphereGeometry(0.05), glowing()]]);
  await passes();
  const c = list().lamp;
  check('the lamp is in the caster list with both meshes', c?.meshes === 2, JSON.stringify(c));
  check('…and casts', c?.casting === true && lamp.children.every((m) => m.castShadow === true), JSON.stringify(c));
  clear(); }

console.log('SCALE AFTER REGISTRATION — a thing grown afterwards ranks by its grown size');
{ setCasterBudget(1);
  ids.push('grown', 'steady');
  const grown = thing('grown', [0, 1.6, -5], [[new THREE.SphereGeometry(0.5), plain()]]);   // r 0.5 at 5 m: 0.1
  thing('steady', [0, 1.6, 4], [[new THREE.SphereGeometry(1), plain()]]);                 // r 1 at 4 m: 0.25
  await passes();
  check('(the setup) the larger, nearer one casts first', casting().join() === 'steady', JSON.stringify(casting()));
  grown.scale.setScalar(4); grown.updateMatrixWorld(true);                                  // r 2 at 5 m: 0.4
  await passes();
  check('after scaling ×4 the grown one takes the slot', casting().join() === 'grown', JSON.stringify(casting()));
  clear(); }

console.log('HYSTERESIS — a ratio on the score: inside 1.25× of the edge a caster holds, beyond it lets go');
{ setCasterBudget(1);
  ids.push('held', 'rival');
  const held = thing('held', [0, 1.6, -5], [[new THREE.SphereGeometry(1), plain()]]);     // 0.2
  thing('rival', [0, 1.6, 12], [[new THREE.SphereGeometry(2), plain()]]);                 // 0.1667
  await passes();
  check('(the setup) the held one casts', casting().join() === 'held', JSON.stringify(casting()));
  held.position.z = -6.5; held.updateMatrixWorld(true);                                     // 0.154: second, but within 1.25× of 0.1667
  await passes();
  check('just past the edge it keeps casting beside the new winner', casting().join() === 'held,rival', JSON.stringify(casting()));
  held.position.z = -8; held.updateMatrixWorld(true);                                       // 0.125: beyond 0.1667 / 1.25 = 0.133
  await passes();
  check('beyond 1.25× it lets go', casting().join() === 'rival', JSON.stringify(casting()));
  clear(); }

S.done();
