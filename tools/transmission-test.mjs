// Transmission: a transmissive material must reach the renderer in a class that can DRAW it, value intact: three's
// WebGPU renderer builds transmission only for MeshPhysicalNodeMaterial, so a plain MeshPhysicalMaterial renders as
// nothing, silently. CALLS prepareObject() on a real mesh and asserts on what comes back; no source regex.

// the Avatar constructor makes a nameplate sprite through document/canvas, so the DOM must exist before avatar.js imports
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
// happy-dom has no 2D canvas context and the nameplate draws text: an inert recorder will do (no pixel asserts here)
HTMLCanvasElement.prototype.getContext = function () {
  // SELF-CHAINING stubs: the drawing code calls methods on what the context returns (createRadialGradient -> addColorStop)
  const anything = new Proxy(function () {}, {
    get: (_t, k) => (k === 'width' ? 100 : anything),
    apply: () => anything,
    set: () => true,
  });
  return new Proxy({}, {
    get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : anything),
    set: () => true,
  });
};

import { plugin } from 'bun';
// a plain path, never a `file:` URL string: readFile takes that as a literal name and ENOENTs on a cold module cache
const HERE = import.meta.dir;
const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // lightrig pulls warmqueue -> loadwork, which calls requestAnimationFrame at module scope
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    // avatar.js pulls assets.js, which builds a KTX2Loader against a real renderer: stub it so the outcome doesn't
    // depend on module-cache order
    build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { readFileSync } = await import('node:fs');
const { THREE } = await import('./core-stub.mjs');

// the MeshPhysicalNodeMaterial stand-in lives in core-stub.mjs, which owns the THREE namespace it re-exports (frozen)

const { prepareObject } = await import('../client/lib/materials.js');
// TOP-LEVEL, once: a dynamic import inside a test can resolve `./core.js` without the plugin's substitution on a cold cache
const { Avatar } = await import('../client/lib/avatar.js');
const { requestLight, releaseOwner, updateRequest, rigDebug, updateRig }
  = await import('../client/lib/lightrig.js');

let pass = 0, fail = 0;
const check = (name, ok, note = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); }
};

/** A mesh wearing one material, run through the real factory. */
function prepared(mat) {
  const m = new THREE.Mesh(new THREE.BoxGeometry(1, 1, 1), mat);
  const root = new THREE.Group();
  root.add(m);
  prepareObject(root, { kind: 'model' });
  return Array.isArray(m.material) ? m.material[0] : m.material;
}

console.log('TRANSMISSION -- a correct file the renderer could not honour');
{
  const src = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  src.transmission = 0.95;
  src.ior = 1.52;
  src.thickness = 0.06;
  src.roughness = 0.05;
  src.metalness = 0;
  src.color.setRGB(0.96, 0.98, 1.0);
  src.specularIntensity = 1;
  const out = prepared(src);

  check('a transmissive material is upgraded to a NODE material',
        out?.isNodeMaterial === true, `got ${out?.constructor?.name}`);
  check('...specifically MeshPhysicalNodeMaterial',
        out?.isMeshPhysicalNodeMaterial === true, `got ${out?.constructor?.name}`);

  // `transmission` is a PROTOTYPE ACCESSOR on MeshPhysicalMaterial, so a copy over Object.keys() drops it silently
  // (transmission 0, invisible again); this goes red for that
  check('TRANSMISSION SURVIVES the upgrade (the accessor bug)',
        out?.transmission === 0.95, `got ${out?.transmission}`);
  check('ior survives', out?.ior === 1.52, `got ${out?.ior}`);
  check('thickness survives', out?.thickness === 0.06, `got ${out?.thickness}`);
  check('roughness and metalness survive',
        out?.roughness === 0.05 && out?.metalness === 0);
  check('specularIntensity survives', out?.specularIntensity === 1,
        `got ${out?.specularIntensity}`);
  check('the name survives (lightrig and gltf_materials dispatch on it)',
        out?.name === 'Glass', `got ${out?.name}`);
  check('it is in the transparent pass', out?.transparent === true);

  // Colour/Vector types must be COPIED, not shared, or a later tweak to either silently moves the other
  check('colour came across by VALUE, not by reference',
        out?.color !== src.color
        && Math.abs(out.color.r - 0.96) < 1e-6
        && Math.abs(out.color.b - 1.0) < 1e-6);
}

console.log('\nAND ONLY TRANSMISSIVE MATERIALS -- node materials compile dearer');
{
  const opaque = new THREE.MeshPhysicalMaterial({ name: 'GOLD' });
  opaque.metalness = 1; opaque.roughness = 0.26;
  const out = prepared(opaque);
  check('an opaque MeshPhysicalMaterial is left alone',
        out?.isNodeMaterial !== true, `got ${out?.constructor?.name}`);
  check('...with its values untouched',
        out?.metalness === 1 && out?.roughness === 0.26);

  const std = new THREE.MeshStandardMaterial({ name: 'RAVEN' });
  const outStd = prepared(std);
  check('a MeshStandardMaterial is left alone too',
        outStd?.isNodeMaterial !== true, `got ${outStd?.constructor?.name}`);
}

console.log('\nSHARING -- one source material, one replacement');
{
  // two meshes wearing THE SAME material must come back wearing the same replacement, or editing it moves only one
  const src = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  src.transmission = 0.9; src.ior = 1.5;
  const a = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const b = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const root = new THREE.Group(); root.add(a); root.add(b);
  prepareObject(root, { kind: 'model' });
  check('both meshes were upgraded', a.material.isNodeMaterial && b.material.isNodeMaterial);
  check('...to the SAME replacement, not one each', a.material === b.material,
        a.material === b.material ? '' : 'two node materials for one source');
  check('...carrying the value', a.material.transmission === 0.9);

  // and a mesh added LATER, in a separate pass, still shares
  const c = new THREE.Mesh(new THREE.BoxGeometry(), src);
  const root2 = new THREE.Group(); root2.add(c);
  prepareObject(root2, { kind: 'model' });
  check('a mesh prepared in a later pass shares it too', c.material === a.material);
}

console.log('\nAUTHORED ZERO -- ?? not ||');
{
  // a lamp material authored at emissiveIntensity 0 (starts dark) must not be "restored" to 1 (`|| 1`) and pooled brighter
  const av = readFileSync(`${HERE}/../client/lib/avatar.js`, 'utf8');
  check('the lamp base uses ?? so an authored zero survives',
        /base: m\.emissiveIntensity \?\? 1/.test(av) &&
        !/base: m\.emissiveIntensity \|\| 1/.test(av));
}

console.log('\nIDEMPOTENCE -- prepareObject runs on every load and hot-swap');
{
  const m = new THREE.MeshPhysicalMaterial({ name: 'Glass' });
  m.transmission = 0.5;
  const mesh = new THREE.Mesh(new THREE.BoxGeometry(), m);
  const root = new THREE.Group(); root.add(mesh);
  prepareObject(root, { kind: 'model' });
  const first = mesh.material;
  prepareObject(root, { kind: 'model' });
  check('a second pass does not re-upgrade (or churn the material)',
        mesh.material === first);
  check('...and the value is still there', mesh.material.transmission === 0.5);
}

console.log('\nTHE AVATAR ITSELF -- build-new -> dispose-old, and pool -> rewear');
{
  // these bind the real Avatar class: lifecycle checks that drive lightrig directly can't see a bug in how Avatar MAKES
  // its keys
  /** A body with one emissive mesh -- enough for attachLamps to want a lamp. */
  function glowingVrm() {
    const scene = new THREE.Object3D();
    const mat = new THREE.MeshStandardMaterial({ name: 'lampglass' });
    mat.emissive = new THREE.Color(1, 0.72, 0.25);
    mat.emissiveIntensity = 3;
    const mesh = new THREE.Mesh(new THREE.SphereGeometry(0.02, 8, 8), mat);
    mesh.name = 'lamp';
    scene.add(mesh);
    return {
      scene, mat, mesh,
      humanoid: { getNormalizedBoneNode: () => null },
      springBoneManager: { joints: [], reset() {}, setInitState() {} },
      expressionManager: null,
      update() {},
    };
  }
  const lampsOf = (owner) => rigDebug().requests.filter((r) => r.key.startsWith(`lamp:${owner}`)).length;
  const mine = (id) => rigDebug().requests.filter((r) => r.key.includes(`body:${id}`)).length;

  // B2: THE SWAP: mybody.js builds the NEW body, then disposes the old, so an owner keyed on the identity lets the old
  // body's dispose delete the live lamp
  const v1 = glowingVrm();
  const oldBody = new Avatar('mythos', v1, {});
  check('a glowing body registers a lamp', mine('mythos') === 1, `${mine('mythos')}`);
  const v2 = glowingVrm();
  const newBody = new Avatar('mythos', v2, {});          // build new...
  check('...and the second body of the same identity registers its own',
        mine('mythos') === 2, `${mine('mythos')}`);
  oldBody.dispose();                                      // ...then dispose old
  check('B2: disposing the OLD body leaves the new body lit',
        mine('mythos') === 1, `${mine('mythos')} requests left`);
  check('...and it is the NEW body\'s request that survived',
        lampsOf(newBody._lampOwner) === 1);

  // B3: THE POOL: the breath writes emissiveIntensity and resetVrmInstance touches no materials, so a body pooled
  // mid-breath would come back too dim for attachLamps to give the next wearer a lamp
  newBody.update?.(1 / 60, performance.now());            // let the breath write
  v2.mat.emissiveIntensity = 0.3;                         // ...mid-breath, dim
  newBody.dispose();
  check('B3: dispose RESTORES the authored emissive before pooling',
        v2.mat.emissiveIntensity === 3, `left at ${v2.mat.emissiveIntensity}`);
  const rewear = new Avatar('mythos', v2, {});            // the pooled instance
  check('...so a rewear of the pooled body still gets a lamp',
        rewear._lamps.length === 1, `${rewear._lamps.length} lamps`);
  rewear.dispose();
  check('(cleanup) no lamp requests survive the last dispose', mine('mythos') === 0);
}

console.log('\nLAMP LIFECYCLE -- the rig\'s own contract');
{
  // B2: OWNERSHIP: a swap builds new then disposes old (mybody.js), so an owner keyed to the IDENTITY would let the
  // old body's dispose release the LIVE lamp
  const before = rigDebug().requests.length;
  requestLight('lamp:body:mythos:1:0', { owner: 'body:mythos:1', intensity: 10 });
  requestLight('lamp:body:mythos:2:0', { owner: 'body:mythos:2', intensity: 10 });
  const both = rigDebug().requests.length - before;
  check('two bodies of one identity hold two distinct requests', both === 2, `${both}`);
  releaseOwner('body:mythos:1');                       // the OLD body disposes
  const left = rigDebug().requests.filter((r) => /mythos:2/.test(r.key)).length;
  check('disposing the old body leaves the new body\'s lamp alive', left === 1,
        `${left} left`);
  releaseOwner('body:mythos:2');

  // ...and the collision itself, so the test states what used to happen
  requestLight('lamp:body:janus:0', { owner: 'body:janus', intensity: 10 });
  releaseOwner('body:janus');
  check('(control) a SHARED owner key does take the other body down',
        rigDebug().requests.filter((r) => /janus/.test(r.key)).length === 0);

  // B6: intensity must NOT dirty slot assignment: the rig recomputes at most every 600ms from tier and camera distance,
  // never intensity, and a breathing lamp patches this 60x a second.
  //
  // start from a CLEAN flag (a fresh requestLight leaves assignDirty true): updateRig(), confirm it cleared, then patch
  requestLight('probe:0', { owner: 'probe', intensity: 5 });
  updateRig(performance.now());
  check('(setup) a rig pass clears the assignment flag',
        rigDebug().assignDirty === false, `${rigDebug().assignDirty}`);
  updateRequest('probe:0', { intensity: 7 });
  check('an intensity patch does not force reassignment',
        rigDebug().assignDirty === false, `dirty became ${rigDebug().assignDirty}`);
  updateRequest('probe:0', { keep: true });
  check('...but a TIER patch does', rigDebug().assignDirty === true);
  releaseOwner('probe');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
