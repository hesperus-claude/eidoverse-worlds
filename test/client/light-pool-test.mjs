// THE POINT POOL LIGHTS WHAT IS ON SCREEN (client/lib/render/lightrig.js assign).
//
// Measured 11-23 on e0a3991c3 in the lab world "starloft" (27 placed point lights, ?slots=4, the camera at
// (0, 1.5, 3) looking toward (0, 2.02, -6)): the three slots that burned held lights BEHIND the camera, ranked in by
// plain camera distance, while the lamps in frame got nothing; and the fourth slot was held all the time by the
// weather's lightning light, adopted through the scene seam at intensity 0 in clear weather. This suite builds that
// shape headless and pins: ranking follows the view (world transforms, so XR's parented camera too), settles after a
// turn, a dark mirror holds no slot, and a strike still gets one on the frame it fires, as uniform writes only.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register({ url: 'http://localhost/?slots=4' });   // the measured tier: lightrig reads ?slots at import
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { suite } from "../gate/suite.ts";
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({ name: 'core-stub', setup(build) {
  stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
  stubResolve(build, /^(\.\.?\/)+(render\/)?loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
} });
const { THREE, camera } = await import('../stubs/core-stub.mjs');
const rig = await import('../../client/lib/render/lightrig.js');

const S = suite("light-pool");
const check = (name, ok, note) => S.check(name, ok, note);

// the lab camera: vfov 52, a 16:9 frame
camera.fov = 52; camera.aspect = 16 / 9; camera.near = 0.1; camera.far = 500; camera.updateProjectionMatrix();
const aim = (pos, target) => { camera.position.set(...pos); camera.lookAt(...target); camera.updateMatrixWorld(true); };
aim([0, 1.5, 3], [0, 2.02, -6]);

const slotOf = (k) => (rig.rigDebug().requests.find((r) => r.key === k) || {}).slot ?? -1;
const burning = () => { const d = rig.rigDebug(); return d.requests.filter((r) => r.slot >= 0 && (d.slotState[r.slot] || {}).intensity > 0).map((r) => r.key); };
const place = (key, pos, range) => rig.requestLight(key, { authored: true, intensity: 12, range, pos });
let t = 1000;
const tick = (ms = 700) => { t += ms; rig.updateRig(t); };

// The weather factory, through the real seam: it scene.add()s its own lightning PointLight at construction and
// drives that light's intensity per frame (0 in clear weather). Light adds must never reach the scene.
const sceneAdds = [];
const realScene = { add: (...o) => { sceneAdds.push(...o); }, remove() {} };
globalThis.makeWeatherSystem = ({ scene }) => {
  const bolt = new THREE.PointLight(0xffffff, 0, 60, 2);
  bolt.position.set(0, 40, -10);
  scene.add(bolt);
  return { bolt };
};
const { bolt } = globalThis.makeWeatherSystem({ scene: realScene });
const boltKey = `foreign:${bolt.uuid}`;
const topology = () => { const d = rig.rigDebug(); return d._slots.map((pl) => `${pl.uuid}:${pl.castShadow}:${pl.parent?.children.length}`).join('|'); };
const bornShape = topology();

console.log('STARLOFT SHAPE — three lamps behind the eye, five in frame, ?slots=4, clear weather');
const BEHIND = { 'behind:a': [2.6, 3.2, 4], 'behind:b': [1.6, 3.2, 4], 'behind:c': [0.4, 2.4, 4.85] };
place('behind:a', BEHIND['behind:a'], 5); place('behind:b', BEHIND['behind:b'], 5); place('behind:c', BEHIND['behind:c'], 4);
const INFRAME = ['window:l', 'window:r', 'sconce:l', 'sconce:r', 'candle'];
place('window:l', [-1.2, 2.3, -5], 6); place('window:r', [1.2, 2.3, -5], 6);
place('sconce:l', [-2.4, 2.4, -1.5], 4); place('sconce:r', [2.4, 2.4, -1.5], 4);
place('candle', [0.3, 0.95, -2.6], 3);
for (let i = 0; i < 4; i++) tick();
{
  const d = rig.rigDebug();
  check('the measured tier: 4 slots, cap 4', d.slots === 4 && d.cap === 4, `slots ${d.slots}, cap ${d.cap}`);
  const held = Object.keys(BEHIND).filter((k) => slotOf(k) >= 0);
  check('no lamp behind the camera holds a slot while five in frame want one', held.length === 0,
    `behind the eye and burning: ${JSON.stringify(held)}`);
  check('every burning slot holds a lamp in frame', burning().every((k) => INFRAME.includes(k)), JSON.stringify(burning()));
  check('the dark lightning holds no slot', slotOf(boltKey) < 0, `bolt on slot ${slotOf(boltKey)} at intensity ${bolt.intensity}`);
  check('all 4 slots asked for burn (not one fewer)', burning().length === 4, `${burning().length} burn: ${JSON.stringify(burning())}`);
  check('the adopted lightning never reached the scene', sceneAdds.length === 0, `${sceneAdds.length} scene.add`);
}

console.log('A TURN — the view decides, and it settles');
{
  aim([0, 1.5, 3], [0, 2.02, 12]);   // the same spot, facing the other way: no move trigger, only the 600 ms tick
  tick();
  const after = Object.keys(BEHIND).filter((k) => slotOf(k) >= 0);
  check('within one 600 ms tick of a turn, the lamps now in front hold slots', after.length === 3, `in front and burning: ${JSON.stringify(after)}`);
  const snap = () => rig.rigDebug().requests.map((r) => `${r.key}=${r.slot}`).join(',');
  const settled = snap();
  tick(); tick(); tick(16); tick();
  check('...and the assignment then stays put (no churn while the camera is still)', snap() === settled, `${settled} -> ${snap()}`);
  aim([0, 1.5, 3], [0, 2.02, -6]);
  tick();
}

console.log('XR — the camera is a child of the rig; the WORLD view decides');
{
  // the rig turned half round: the camera's local pose faces -z, its world view faces +z (toward the "behind" lamps)
  const xrRig = new THREE.Group();
  xrRig.rotation.y = Math.PI;
  xrRig.add(camera);
  camera.position.set(0, 1.5, -3); camera.quaternion.identity();
  xrRig.updateMatrixWorld(true);
  tick();
  const held = Object.keys(BEHIND).filter((k) => slotOf(k) >= 0);
  check('ranking reads the world view, not the local head pose', held.length === 3, `world-in-front and burning: ${JSON.stringify(held)}`);
  xrRig.remove(camera);
  aim([0, 1.5, 3], [0, 2.02, -6]);
  tick();
}

console.log('PAIRS — one slot, two claims (a level camera at the origin looking down -z)');
{
  for (const k of [...Object.keys(BEHIND), ...INFRAME]) rig.releaseLight(k);
  aim([0, 1.5, 0], [0, 1.5, -1]);
  rig.setSlotCap(1);
  const duel = (a, b, why) => {
    place(a[0], a[1], a[2]); place(b[0], b[1], b[2]);
    tick(); tick();
    check(why, slotOf(a[0]) >= 0 && slotOf(b[0]) < 0, `${a[0]} slot ${slotOf(a[0])}, ${b[0]} slot ${slotOf(b[0])}`);
    rig.releaseLight(a[0]); rig.releaseLight(b[0]); tick();
  };
  duel(['ahead-4m', [0, 1.5, -4], 6], ['behind-2m', [0, 1.5, 2], 6], 'an in-frame lamp 4 m away outranks an equal lamp 2 m behind the viewer');
  // the left edge at 2 m deep is x = -2·tan(26°)·16/9 ≈ -1.73: this lamp sits ~0.28 m outside it
  duel(['just-off-2m', [-2.1, 1.5, -2], 4], ['ahead-9m', [0, 1.5, -9], 6], 'a lamp just off the frame edge still beats a far in-frame one');
  // 3 m behind with a 2 m range: its light reaches nothing in front of the eye
  duel(['ahead-30m', [0, 1.5, -30], 10], ['behind-3m-r2', [0, 1.5, 3], 2], 'a lamp whose range never reaches the view loses even to a distant in-frame one');
  // Measured 11-23 in the lab's furnished room (starloft-props): a 2 cd string glow (range 2.5 m) held its slot from
  // the spawn camera, 4.97 m away, and a 40 cd desk lamp 4.36 m away stayed dark: 4.97 × 0.85 = 4.22 < 4.36, the
  // incumbent bonus alone. What a light can deliver has to count, not only where it is.
  aim([0.13, 0.9, -0.39], [0.13, 0.9, -5]);
  rig.requestLight('glow:2cd', { authored: true, intensity: 2, range: 2.5, pos: [2.54, 3, -4.2] });
  tick(); tick();
  const glowFirst = slotOf('glow:2cd');
  rig.requestLight('desk:40cd', { authored: true, intensity: 40, range: 6, pos: [-3, 1.25, -3.4] });
  tick(); tick();
  check('a 40 cd lamp at 4.36 m takes the slot from a 2 cd incumbent at 4.97 m', glowFirst >= 0 && slotOf('desk:40cd') >= 0 && slotOf('glow:2cd') < 0,
    `glow first on ${glowFirst}; now glow ${slotOf('glow:2cd')}, desk ${slotOf('desk:40cd')}`);
  rig.releaseLight('glow:2cd'); rig.releaseLight('desk:40cd'); tick();
  aim([0, 1.5, 0], [0, 1.5, -1]);
  rig.setSlotCap(4);
}

console.log('A BRIGHT LAMP JUST OUT OF FRAME — measured against a path tracer, it is a quarter of the picture');
{
  // The lab's furnished room (starloft-props, its 14 point lights as authored), the eye at (0.13, 1.5, -2) looking
  // down -z, vfov 65.7. Path-traced per light (render-lab/rank-truth.py, 11-23): the 40 cd desk lamp, 3.44 m away and
  // 1.0 m outside the left edge of the frame, supplies 28% of the frame's lamp light, second only to the stove (40%).
  // The best four are stove, desk lamp and the two shelf lamps (84% of the light). A rule that charges a lamp six
  // metres for every metre outside the frame drops the desk lamp for a 10 cd one (57% kept, 2.1 stops lost against
  // 0.8). Over 32 path-traced cameras in two rooms a charge of 3 loses 0.56 / 0.12 stops at 4 / 8 slots, worst 0.27
  // at 8; a charge of 6 loses 0.58 / 0.16, worst 1.04; nearest-the-eye (anima/main) 1.85 / 0.55.
  const ROOM = [   // [x, y, z], candela, range
    [[-2.43, 0.35, -5.3], 50, 14], [[-4.4, 4.4, -1.8], 40, 14], [[-4.6, 4.4, 2.6], 40, 14], [[-0.45, 0.66, -3.8], 1, 2.5],
    [[3.2, 3, -5.8], 40, 14], [[2.74, 2.85, -3.5], 6, 4], [[2.74, 1.43, -2.7], 7.5, 6.85], [[-3, 1.25, -3.4], 40, 14],
    [[2, 0.85, -4.6], 10, 7.9], [[1.9, 2.2, -4.6], 7.5, 6.85], [[-2.7, 1.1, -2.5], 12, 3], [[2.54, 3, -5.2], 2, 2.5],
    [[2.54, 3, -4.2], 2, 2.5], [[2.54, 3, -3.2], 2, 2.5],
  ];
  const keys = ROOM.map((_, i) => `room:${String(i).padStart(2, '0')}`);
  const fov0 = camera.fov;
  camera.fov = 65.7; camera.updateProjectionMatrix();
  aim([0.13, 1.5, -2], [0.13, 1.5, -6]);
  ROOM.forEach(([pos, cd, range], i) => rig.requestLight(keys[i], { authored: true, keep: i === 0, intensity: cd, range, pos }));   // the stove is the world's `important` light
  for (let i = 0; i < 4; i++) tick();
  const held = keys.filter((k) => slotOf(k) >= 0);
  check('the stove (40% of the light) holds a slot', held.includes('room:00'), JSON.stringify(held));
  check('the 40 cd desk lamp 1 m out of frame (28% of the light) holds a slot', held.includes('room:07'), JSON.stringify(held));
  check('no 2 cd string glow holds a slot while 40 cd lamps want one', !held.some((k) => ['room:11', 'room:12', 'room:13'].includes(k)), JSON.stringify(held));
  for (const k of keys) rig.releaseLight(k);
  camera.fov = fov0; camera.updateProjectionMatrix();
  aim([0, 1.5, 0], [0, 1.5, -1]);
  tick();
}

console.log('SPOTS — the spot pool ranks the same way (?spots default 2)');
{
  const spot = (key, pos) => rig.requestLight(key, { authored: true, intensity: 12, range: 8, pos, spot: { angle: 0.5, inner: 0.3 } });
  spot('spot:behind', [0, 2.5, 1.5]); spot('spot:ahead-a', [-1, 2.5, -7]); spot('spot:ahead-b', [1, 2.5, -7]);
  tick(); tick();
  const sp = rig.rigDebug().spots.filter((s) => s.intensity > 0).map((s) => s.pos[2]);
  check('the two spot slots light the spots in frame', sp.length === 2 && sp.every((z) => z < 0), `burning spots at z ${JSON.stringify(sp)}`);
  for (const k of ['spot:behind', 'spot:ahead-a', 'spot:ahead-b']) rig.releaseLight(k);
  tick();
}

console.log('THE STRIKE — a dark mirror takes its slot on the frame it fires, as uniform writes');
{
  for (let i = 0; i < 5; i++) place(`lamp:${i}`, [i - 2, 2, -4], 6);   // five in frame, four slots: all full
  tick(); tick();
  check('clear weather: four ordinary lamps burn, the bolt holds nothing', burning().length === 4 && slotOf(boltKey) < 0,
    `${JSON.stringify(burning())}, bolt slot ${slotOf(boltKey)}`);
  const lastAssigned = rig.rigDebug().assignDirty === false;
  // what wx.update does in the sky system, which main.js runs before the rig's: write the bolt's intensity
  bolt.intensity = 30;
  tick(16);   // ONE frame: no 600 ms tick, no camera move, no request change
  const d = rig.rigDebug();
  const s = slotOf(boltKey);
  check('the strike holds a slot on the frame it fires', lastAssigned && s >= 0, `bolt slot ${s}`);
  check('...and that slot burns at the strike\'s intensity in the same frame', s >= 0 && d.slotState[s].intensity === 30,
    s >= 0 ? `slot ${s} intensity ${d.slotState[s].intensity}` : 'no slot');
  check('the other three slots keep burning', burning().filter((k) => k !== boltKey).length === 3, JSON.stringify(burning()));
  check('the slot topology never changed (same lights, same castShadow, same children: no recompile)', topology() === bornShape);
  // a return stroke: dark for 150 ms, then lit again; the slot must not churn between strokes
  bolt.intensity = 0; tick(150);
  const between = slotOf(boltKey);
  bolt.intensity = 18; tick(16);
  check('a return stroke 150 ms later finds the bolt still on its slot', between === s && slotOf(boltKey) === s, `${s} -> ${between} -> ${slotOf(boltKey)}`);
  bolt.intensity = 0;
  for (let i = 0; i < 4; i++) tick();
  check('once the strike is over the bolt lets its slot go and four lamps burn again', slotOf(boltKey) < 0 && burning().length === 4,
    `bolt slot ${slotOf(boltKey)}, ${JSON.stringify(burning())}`);
  // the governor's cap sheds lamps, never a strike
  rig.setSlotCap(0); tick();
  check('at cap 0 nothing ordinary burns', burning().length === 0, JSON.stringify(burning()));
  bolt.intensity = 30; tick(16);
  check('...and a strike still gets a slot that same frame', slotOf(boltKey) >= 0 && burning().includes(boltKey), JSON.stringify(burning()));
  check('the topology is still the born one', topology() === bornShape);
  bolt.intensity = 0; rig.setSlotCap(4);
}

S.done();
