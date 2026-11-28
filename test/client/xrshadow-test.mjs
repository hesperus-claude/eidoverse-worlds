// The ShadowNode XR-off patch (client/lib/xr/xrshadow.js, applied by core.js): while presenting, the shadow pass
// runs with xr.enabled=false and it is restored on every exit; not presenting, the original runs untouched.
// Third independent review 2026-09-10: removing the patch in core.js was green everywhere — nothing imported it.
import * as XS from '../../client/lib/xr/xrshadow.js';
const { patchShadowNodeForXR } = XS;
import { suite } from "../gate/suite.ts";
const S = suite("xrshadow");
const check = (name, ok, note) => S.check(name, ok, note);
const seen = []; let throwNext = false;
class FakeShadowNode { updateShadow(frame) { seen.push('xr=' + frame.renderer.xr.enabled); if (throwNext) { throwNext = false; throw new Error('pass lost'); } return 'shadowed'; } }
const xr = { enabled: true, isPresenting: false };
const frame = { renderer: { xr } };
console.log('XR SHADOW PATCH');
check('patches once, reports it', patchShadowNodeForXR(FakeShadowNode.prototype) === true && patchShadowNodeForXR(FakeShadowNode.prototype) === false);
check('a prototype without updateShadow is left alone', patchShadowNodeForXR({}) === false && patchShadowNodeForXR(null) === false);
const node = new FakeShadowNode();
{ seen.length = 0; const r = node.updateShadow(frame); check('not presenting: original runs with xr untouched', r === 'shadowed' && seen[0] === 'xr=true' && xr.enabled === true, seen.join()); }
{ xr.isPresenting = true; seen.length = 0; const r = node.updateShadow(frame); check('presenting: the shadow pass runs with xr OFF', r === 'shadowed' && seen[0] === 'xr=false', seen.join()); check('…and xr.enabled is restored after', xr.enabled === true); }
{ seen.length = 0; throwNext = true; let err = null; try { node.updateShadow(frame); } catch (e) { err = e; } check('a throwing pass still restores xr.enabled and propagates', err?.message === 'pass lost' && xr.enabled === true && seen[0] === 'xr=false'); }
{ xr.enabled = false; seen.length = 0; node.updateShadow(frame); check('an already-disabled xr stays disabled after', xr.enabled === false); }

// A shadow map is drawn the first time a pass meets its light in a frame, with whatever renderer.transparent and .opaque
// that pass set: the AO pre-pass draws opaque only (transparent = false), so a see-through caster lost its shadow for the
// whole frame (cold read 11-27, E3). The patch draws every shadow map with both on, and puts them back.
console.log('SHADOW MAPS DRAW EVERY CASTER');
{
  const patchAll = XS.patchShadowNodeDrawsAll;
  const seen2 = []; let throw2 = false;
  class Fake2 { updateShadow(frame) { seen2.push([frame.renderer.transparent, frame.renderer.opaque]); if (throw2) { throw2 = false; throw new Error('pass lost'); } return 'shadowed'; } }
  check('SD1 patches once, reports it; a prototype without updateShadow is left alone', typeof patchAll === 'function' && patchAll(Fake2.prototype) === true && patchAll(Fake2.prototype) === false && patchAll({}) === false && patchAll(null) === false);
  const r2 = { transparent: false, opaque: true, xr: { enabled: false, isPresenting: false } }, n2 = new Fake2();
  let out = null; try { out = n2.updateShadow({ renderer: r2 }); } catch (e) { out = e?.message; }
  check('SD2 inside a pass that skips transparents, the shadow map is drawn with transparent and opaque on', out === 'shadowed' && seen2[0]?.[0] === true && seen2[0]?.[1] === true, JSON.stringify(seen2));
  check('SD2 …and the pass gets its own flags back after', r2.transparent === false && r2.opaque === true, JSON.stringify([r2.transparent, r2.opaque]));
  r2.opaque = false; throw2 = true; let err = null; try { n2.updateShadow({ renderer: r2 }); } catch (e) { err = e; }
  check('SD3 a throwing shadow pass still puts the flags back and propagates', err?.message === 'pass lost' && r2.transparent === false && r2.opaque === false && seen2[1]?.[0] === true && seen2[1]?.[1] === true, JSON.stringify(seen2));
  // both patches on one prototype (core.js applies both): XR off and every caster drawn, in either order
  class Fake3 { updateShadow(frame) { return [frame.renderer.xr.enabled, frame.renderer.transparent]; } }
  patchShadowNodeForXR(Fake3.prototype); patchAll?.(Fake3.prototype);
  const r3 = { transparent: false, opaque: true, xr: { enabled: true, isPresenting: true } };
  let both = null; try { both = new Fake3().updateShadow({ renderer: r3 }); } catch (e) { both = String(e); }
  check('SD4 with the XR patch too: presenting, the shadow pass runs with xr off and transparents on; both put back', JSON.stringify(both) === '[false,true]' && r3.xr.enabled === true && r3.transparent === false, JSON.stringify([both, r3.xr.enabled, r3.transparent]));
}
S.done();
