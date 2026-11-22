// gizmo drag end (client/lib/edit/gizmo.js): a gizmo drag streams sendDrag samples, and others draw an amber claim
// while they arrive. The release must send one last sample with { end: true }, as build.js's free drag does, so others
// drop the claim at once instead of holding it for CLAIM_MS. Headless, through the REAL gizmo.js: every module it imports
// is a stand-in served from this file (a bun plugin namespace, as dismount-height-test does); TransformControls is a
// recorder whose events the test fires.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/gizmo-drag-end-test.ts
// Mutation (must go red): delete the end sample in endDrag (rows E1, E2); drop the revert on a refused edit (row E3);
// make sized() return {} (rows S1).
import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
import { suite } from '../gate/suite.ts';
const THREE_PATH = fileURLToPath(new URL('../../client/node_modules/three/build/three.module.js', import.meta.url));
const T = JSON.stringify(THREE_PATH);
const STUBS: Record<string, string> = {
  core: `import * as THREE from ${T}; export { THREE }; export const scene = new THREE.Scene(); export const camera = new THREE.PerspectiveCamera(); export const canvas = {}; globalThis.__gz.THREE = THREE;`,
  base: `const ls = {}; export const bus = { on(t, f) { (ls[t] ??= []).push(f); }, emit(t, v) { for (const f of ls[t] ?? []) f(v); } }; globalThis.__gz.bus = bus;`,
  world: `export const entities = new Map(); export const bagOf = () => null; globalThis.__gz.entities = entities;`,
  net: `export const drags = []; export const sendDrag = (...a) => drags.push(a); globalThis.__gz.drags = drags;`,
  'render/frameloop': `export const registerSystem = () => {};`,
  scenegraph: `export const sceneSelected = () => globalThis.__gz.selected;`,
  'edit/build': `export const getTool = () => globalThis.__gz.tool; export const getSpace = () => 'world'; export const isBuilding = () => true; export const refreshOutline = () => {}; export const setPointerVeto = () => {}; export let esc = null; export const setEscapeHook = (f) => { globalThis.__gz.esc = f; };`,
  'edit/writes': `export const sent = []; export const sendOps = (ops, o) => sent.push(ops); export const compsOf = () => null; export const revertPose = () => { const g = globalThis.__gz; const o = g.entities.get(g.selected); o.position.copy(g.dragStart); g.drags.push([g.selected, o.position.toArray(), 0, o.quaternion.toArray(), { end: true }]); };   // as writes.js: back, and one ending sample globalThis.__gz.sent = sent;`,
  colliders: `export const reindexCollider = () => {};`,
  'edit/keyhints': `export const engage = () => {}; export const release = () => {};`,
  'realize/models': `export const boxOf = () => null;`,
  'edit/inspect': `export const foldRecord = (id) => ({ id, pos: [0, 0, 0] });`,
  'edit/gripedit': `export const gripEditing = () => false;`,
  'ui/ui': `export const flashHint = () => {}; export const html = (s) => s.join('');`,
  editschema: `export const inspectSchema = () => ({}); export const fieldAt = () => ({ disabled: false }); export const poseEdits = () => ({ 'pos.x': 1 }); export const editOps = () => (globalThis.__gz.editErrors ? { ops: [], errors: ['pos.x: no such field on crate'] } : { ops: [{ op: 'set' }], errors: [] });`,
  requests: `export const set = () => ({}); export const unset = () => ({});`,
  TransformControls: `import * as THREE from ${T};
    export class TransformControls { constructor() { this.ls = {}; this.mode = 'translate'; globalThis.__gz.controls = this; }
      getHelper() { return new THREE.Object3D(); } addEventListener(t, f) { (this.ls[t] ??= []).push(f); }
      fire(t, e = {}) { for (const f of this.ls[t] ?? []) f(e); }
      attach(o) { this.object = o; } detach() { this.object = null; } setMode(m) { this.mode = m; } setSpace(s) { this.space = s; }
      setTranslationSnap() {} setRotationSnap() {} setScaleSnap() {} }`,
};
const KEY = (p: string) => {
  const m = p.match(/(?:^|\/)((?:render|edit|realize|ui)\/)?([A-Za-z]+)\.js$/); if (!m) return null;
  const k = (m[1] ?? '') + m[2]; return STUBS[k] ? k : STUBS[m[2]] ? m[2] : null;
};
plugin({
  name: 'gizmo-stubs',
  setup(b) {
    b.onResolve({ filter: /\.js$/ }, (a) => {
      if (!a.importer.endsWith('gizmo.js')) return undefined;
      let k = KEY(a.path);
      if (a.path.startsWith('./')) k = STUBS['edit/' + a.path.slice(2, -3)] ? 'edit/' + a.path.slice(2, -3) : k;   // siblings in edit/
      return k ? { path: k, namespace: 'gz-stub' } : undefined;
    });
    b.onLoad({ filter: /.*/, namespace: 'gz-stub' }, (a) => ({ contents: STUBS[a.path], loader: 'js' }));
  },
});
const G = globalThis as any; G.__gz = { selected: 'crate', tool: 'move' };
G.addEventListener ??= () => {};
let now = 0; performance.now = () => now;
const gz: any = await import('../../client/lib/edit/gizmo.js');
const { THREE, entities, bus, drags } = G.__gz;
const S = suite('gizmo-drag-end');

const crate = new THREE.Object3D(); entities.set('crate', crate); G.__gz.THREE.Object3D.prototype.updateWorldMatrix ??= () => {};
gz.initGizmo(); bus.emit('selection');
const c = G.__gz.controls;
S.check('the gizmo attached to the selected thing', c?.object === crate, String(c?.object));

const drag = (moves: number, { cancel = false, nudge = false } = {}) => {
  drags.length = 0; G.__gz.dragStart = crate.position.clone();
  c.dragging = true; c.fire('dragging-changed', { value: true });
  for (let i = 0; i < moves; i++) { now += 100; crate.position.x += 0.5; c.fire('objectChange'); }
  if (nudge) { now += 10; crate.position.x += 0.25; c.fire('objectChange'); }   // inside the 66 ms throttle: never streamed
  if (cancel) G.__gz.esc();
  c.dragging = false; c.fire('dragging-changed', { value: false });
};
drag(3, { nudge: true });
const last = drags[drags.length - 1];
S.check('the drag streamed samples', drags.length >= 3, drags.length);
S.check('E1 the release sends one last sample marked end', last?.[4]?.end === true, JSON.stringify(last));
S.check('...at where the thing ended, past the throttle\'s last sample', last?.[1]?.[0] === crate.position.x && drags[drags.length - 2]?.[1]?.[0] !== crate.position.x, JSON.stringify(drags.map((d: any[]) => d[1][0])));
S.check('...and only one end sample', drags.filter((d: any[]) => d[4]?.end).length === 1);

const before = crate.position.x;
drag(2, { cancel: true });
const endC = drags[drags.length - 1];
S.check('E2 a cancelled drag (Esc) also releases the claim', endC?.[4]?.end === true, JSON.stringify(endC));
S.check('...at the pose it went back to', endC?.[1]?.[0] === before && crate.position.x === before, JSON.stringify({ end: endC?.[1], at: crate.position.x, before }));

const home = crate.position.x; G.__gz.editErrors = true;
drag(2);
G.__gz.editErrors = false;
S.check('E3 an edit this client refuses (editOps errors) puts the thing back where the log has it', crate.position.x === home, JSON.stringify({ at: crate.position.x, home }));
S.check('...and the last sample ends the claim at that pose', drags[drags.length - 1]?.[4]?.end === true && drags[drags.length - 1]?.[1]?.[0] === home, JSON.stringify(drags[drags.length - 1]));

G.__gz.tool = 'scale'; bus.emit('tool');
drags.length = 0; G.__gz.dragStart = crate.position.clone();
c.dragging = true; c.fire('dragging-changed', { value: true });
for (let i = 0; i < 2; i++) { now += 100; crate.scale.multiplyScalar(1.5); c.fire('objectChange'); }
c.dragging = false; c.fire('dragging-changed', { value: false });
S.check('S1 a resize streams its scale, so watchers see the size change live', drags.length >= 3 && drags.slice(0, -1).map((d: any[]) => d[4]?.scale?.[0]).join() === '1.5,2.25', JSON.stringify(drags.map((d: any[]) => d[4])));
S.check('...and the end sample carries the final scale', drags[drags.length - 1]?.[4]?.end === true && drags[drags.length - 1]?.[4]?.scale?.[0] === crate.scale.x, JSON.stringify(drags[drags.length - 1]?.[4]));
crate.scale.set(1, 1, 1);
G.__gz.tool = 'move'; bus.emit('tool');
drag(1);
S.check('a move sends no scale (payload unchanged outside the scale tool)', drags.every((d: any[]) => !d[4]?.scale), JSON.stringify(drags.map((d: any[]) => d[4])));

G.__gz.tool = 'pivot'; bus.emit('tool');
drag(2);
S.check('the pivot tool moves only the pivot: no samples, no end sample', !drags.some((d: any[]) => d[4]?.end), JSON.stringify(drags));
G.__gz.tool = 'move'; bus.emit('tool');

drag(0);
S.check('a click on a handle that never moved sends nothing', drags.length === 0, drags.length);

S.done();
