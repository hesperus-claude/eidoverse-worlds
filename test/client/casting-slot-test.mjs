// THE CASTING SLOT DRAWS SHADOWS ONLY FOR A HOLDER THAT ASKED (client/lib/render/lightrig.js, SHADOW_SLOT).
//
// Slot 0 is born casting (castShadow is pipeline shape) and the general pass hands free slots out from 0, so on
// e0a3991c3 any request could land there and cast, though requestLight's default is `shadows: false`. Measured 11-23:
// `complight:lf74…` (an ordinary placed lamp) held slot 0 casting; on the lab's "lamp" world (a street lamp whose point
// light sits inside its lantern glass) the lantern shadowed its own light, frame luma 0.10 with the slot's shadow on vs
// 0.24 with it zeroed, and the tuning was the chest lamp's (256 map, 0.75 m normalBias). The switch is uniform-level,
// like the viewer's preference (shadow.intensity 0, depth pass stopped); castShadow never flips.
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
  stubResolve(build, /^(\.\.?\/)+(render\/)?loadwork\.js$/, () => ({ path: here('../stubs/loadwork-stub.mjs') }));
} });
localStorage.removeItem('ew-shadows');   // the viewer's preference: absent = on
const { camera } = await import('../stubs/core-stub.mjs');
const rig = await import('../../client/lib/render/lightrig.js');

const S = suite("casting-slot");
const check = (name, ok, note) => S.check(name, ok, note);

camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true);
let t = 1000;
const tick = (ms = 700) => { t += ms; rig.updateRig(t); };
const d = () => rig.rigDebug();
const CAST = d().shadows.castingSlot;
const lamp = () => d()._slots[CAST];
const slotOf = (k) => (d().requests.find((r) => r.key === k) || {}).slot ?? -1;
const lit = (k) => slotOf(k) >= 0 && (d().slotState[slotOf(k)] || {}).intensity > 0;
const drawing = () => d().shadows.slotIsCaster;   // the slot's EFFECTIVE casting: shape + map + the uniform half
const bornShape = d()._slots.map((pl) => pl.castShadow).join(',');
const shape = () => d()._slots.map((pl) => pl.castShadow).join(',');
// what the casting slot asks of three at birth, read before any frame and any light (the BORN DRAWN rows below)
const born = { needsUpdate: lamp().shadow.needsUpdate, intensity: lamp().shadow.intensity, autoUpdate: lamp().shadow.autoUpdate, holder: d().requests.find((r) => r.slot === CAST)?.key ?? null };

console.log('BORN DRAWN — the casting slot\'s map is drawn once at birth, whoever holds it');
// Why: three r186 destroys and recreates a shadow map's depth texture at the map's FIRST render
// (Textures.updateRenderTarget), and the bind groups built before that (every classic-material model's) keep the
// destroyed one. Since the slot draws only for a holder that asked, its first draw would come with its first asker;
// when that is after the world's models have drawn, every later frame breaks on a real GPU: black on WebGPU
// ("Destroyed texture [ShadowDepthTexture] used in a submit"), refused draws and missing models on WebGL2 (render lab
// 2026-11-27). On e0a3991c3 the slot drew from frame 1 whoever held it, so this never showed. The mock cannot show the
// GPU half; these rows pin the ask, and that it is one draw and not a standing one.
check('born drawn: the casting slot asks three for one draw at birth, with nobody holding it', born.needsUpdate === true && born.holder === null, born);
check('born drawn: ...and it is not casting: shown at intensity 0, no standing depth pass', born.intensity === 0 && born.autoUpdate === false, born);

console.log('A PLACED LAMP ALONE — the lab "lamp" world: one point light inside its lantern glass');
rig.requestLight('complight:streetlamp', { authored: true, intensity: 20, range: 9, pos: [0, 3, -4] });
tick(); tick();
check('the lamp is lit', lit('complight:streetlamp'), `slot ${slotOf('complight:streetlamp')}`);
check('...and no slot draws a shadow for it (it never asked)', !drawing() && !(slotOf('complight:streetlamp') === CAST && lamp().shadow.intensity > 0),
  `lamp on slot ${slotOf('complight:streetlamp')}; casting slot intensity ${lamp().shadow.intensity}, autoUpdate ${lamp().shadow.autoUpdate}`);
check('...its depth pass is stopped, not only hidden', lamp().shadow.autoUpdate === false, `autoUpdate ${lamp().shadow.autoUpdate}`);

console.log('A FULL POOL — non-wanters on every slot, so one holds the casting slot');
for (let i = 0; i < 8; i++) rig.requestLight(`complight:room${i}`, { authored: true, intensity: 10, range: 6, pos: [i - 4, 2, -2 - i * 0.1] });
tick(); tick();
const holder0 = d().requests.find((r) => r.slot === CAST)?.key;
check('a non-wanter holds the casting slot (the setup)', !!holder0 && !d().shadows.wantsShadows.length, `holder ${holder0}`);
check('...it is lit', (d().slotState[CAST] || {}).intensity > 0);
check('...and it does not cast', !drawing(), `intensity ${lamp().shadow.intensity}, autoUpdate ${lamp().shadow.autoUpdate}`);
rig.reassertShadowPref();   // a probe restoring the preference's uniform half (gputime, overdraw)
check('reassertShadowPref does not turn it back on for a non-wanter', !drawing());
rig.setShadows(true);
check('nor does setShadows(true)', !drawing());

console.log('THE BODY LAMP ARRIVES — attachLamps(…, {shadows: true}) from avatar.js');
rig.requestLight('lamp:body:mythos:0', { keep: true, intensity: 8, range: 10, shadows: true, pos: [0, 1.5, -1] });
lamp().shadow.needsUpdate = false;
tick();
check('the wanter takes the casting slot', slotOf('lamp:body:mythos:0') === CAST, `slot ${slotOf('lamp:body:mythos:0')}`);
check('...and it casts', drawing() && d().shadows.anyCasting === true);
check('...with the stale map redrawn once', lamp().shadow.needsUpdate === true);
check('every slot is still lit (nine asked for eight: the swap costs no light)', d().slotState.every((s) => s.intensity > 0), JSON.stringify(d().slotState.map((s) => s.intensity)));

console.log('THE VIEWER\'S SWITCH — composes with the holder\'s ask');
rig.setShadows(false);
check('setShadows(false) stops the wanter casting', !drawing());
rig.reassertShadowPref();
check('reassertShadowPref keeps it off', !drawing());
rig.setShadows(true);
check('setShadows(true) brings it back for the wanter', drawing());

console.log('THE WANTER LEAVES');
rig.releaseLight('lamp:body:mythos:0');
tick();
check('the casting slot stops drawing', !drawing(), `holder ${d().requests.find((r) => r.slot === CAST)?.key ?? 'none'}, intensity ${lamp().shadow.intensity}`);
for (let i = 0; i < 8; i++) rig.releaseLight(`complight:room${i}`);
rig.releaseLight('complight:streetlamp');
tick();
check('an empty casting slot draws nothing', !drawing() && lamp().shadow.autoUpdate === false);
rig.requestLight('lamp:body:mythos:0', { keep: true, intensity: 8, range: 10, shadows: true, pos: [0, 1.5, -1] });
tick();
check('a wanter on an empty pool casts at once', slotOf('lamp:body:mythos:0') === CAST && drawing());
rig.updateRequest('lamp:body:mythos:0', { shadows: false });
tick(16);
check('a holder that stops asking stops casting on the next frame', !drawing());

console.log('PIPELINE SHAPE');
check('castShadow never flipped on any slot', shape() === bornShape, `${bornShape} -> ${shape()}`);

S.done();
