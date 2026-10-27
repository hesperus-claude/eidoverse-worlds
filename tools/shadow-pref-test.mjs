// The shadow switch and the chest lamp's casting slot must agree (client/lib/lightrig.js), at BOOT (slot 0 is born
// casting) and on every FLIP of setShadows(), in both directions. lightrig reads the preference AT IMPORT, so each boot
// case runs in its own subprocess (`--case <name>`); `--mutate <n>` reverts one half in the child; `--mutants` proves
// every control still kills the test.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };

const ARGV = process.argv.slice(2);
const argOf = (f) => { const i = ARGV.indexOf(f); return i < 0 ? null : ARGV[i + 1]; };
const CASE = argOf('--case');
const MUTATE = argOf('--mutate');

// ---- the child: one boot state, measured -----------------------------------

if (CASE) {
  const { plugin } = await import('bun');
  const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
  plugin({ name: 'core-stub', setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/base\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    build.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    build.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  } });

  // the preference, set BEFORE the import that reads it
  if (CASE === 'boot-off') localStorage.setItem('ew-shadows', 'off');
  else localStorage.removeItem('ew-shadows');   // absent = on (the default)

  const { renderer, sun } = await import('./core-stub.mjs');
  const rig = await import('../client/lib/lightrig.js');

  // mutation controls reproduce what a reverted line leaves: #1 is written onto the live slot (already born), #2 wraps a
  // local alias (a module namespace is read-only)
  const lamp = () => rig.rigDebug()._slots[0];
  let setShadows = rig.setShadows;
  let updateRig = rig.updateRig;
  let setLampShadow = rig.setLampShadow;
  if (MUTATE === '1') lamp().castShadow = true;               // born casting regardless of the preference
  if (MUTATE === '2') setShadows = (on) => {                  // setShadows forgets the lamp slot
    const before = lamp().castShadow; rig.setShadows(on); lamp().castShadow = before;
  };
  if (MUTATE === '5') {                                      // bias pinned to a constant, as before
    const real = rig.setLampShadow;
    setLampShadow = (o) => { const r = real(o); lamp().shadow.normalBias = 0.02; return r; };
  }
  if (MUTATE === '4') {                                      // the old claim: FREE slot + unassigned request only
    // "the casting slot is not the lamp's": move the caster flag to a slot the lamp doesn't hold (no test-only export in production)
    const realUpdate = rig.updateRig;
    updateRig = (t) => {
      realUpdate(t);
      const sl = rig.rigDebug()._slots;
      const lampSlot = (rig.rigDebug().requests.find((r) => r.key === 'lamp:body:janus:1') || {}).slot;
      if (lampSlot >= 0) for (let i = 0; i < sl.length; i++) sl[i].castShadow = i !== lampSlot && i === 1;
    };
  }
  if (MUTATE === '3') {                                      // far left at three's default
    lamp().shadow.camera.far = 500;
    const cam = lamp().shadow.camera;
    Object.defineProperty(cam, 'far', { get: () => 500, set: () => {}, configurable: true });
  }

  const out = (o) => console.log(`__RESULT__${JSON.stringify(o)}`);
  // `slotIsCaster`: boot/flip make no lamp request, so the casting SLOT's wiring is under test (contend, below, asks
  // whether the lamp HOLDS it)
  const snap = () => { const d = rig.rigDebug(); return { pref: d.shadows.pref, map: renderer.shadowMap.enabled, sun: d.shadows.sunCasting, lamp: d.shadows.slotIsCaster, shapeOn: renderer.shadowMap.enabled && sun.castShadow }; };   // sun/lamp = EFFECTIVE casting: the switch is uniform-level

  if (CASE === 'boot-on' || CASE === 'boot-off') { out({ boot: snap() }); }
  if (CASE === 'bias') {
    // normalBias is read in TEXELS by the shader, so a fixed metre bias changes the look with map size: derive it from the map
    const born = rig.lampShadowState();
    const shipped = { map: born.map, texels: born.texels, workDist: born.workDist,
                      forward: born.forward, up: born.up, side: born.side };
    const at = {};
    for (const n of [256, 280, 512, 1024]) {
      setLampShadow({ map: n });
      const st = rig.lampShadowState();
      at[n] = { map: st.map, normalBias: st.normalBias, texelMM: st.texelMM };
    }
    setLampShadow({ map: 280 });
    const retuned = setLampShadow({ texels: 3 });
    out({ born, at, retuned, shipped });
  }
  if (CASE === 'contend') {
    // THE WORLD LOADS BEFORE YOUR BODY: an orb takes slot 0 first; the lamp must END UP on the casting slot, the incumbent
    // keep its light
    rig.requestLight('orb:world:1', { authored: true, intensity: 10, range: 8, pos: [0, 1, 0] });
    updateRig(1000);
    const before = rig.rigDebug();
    rig.requestLight('lamp:body:janus:1', { keep: true, intensity: 8, range: 10, shadows: true, pos: [0, 1, 0] });
    // several passes: the bug is invisible on the FIRST assign and permanent from the second
    for (const t of [2000, 3000, 4000, 9000, 20000]) updateRig(t);
    const d = rig.rigDebug();
    const slotOf = (k) => (d.requests.find((r) => r.key === k) || {}).slot;
    out({
      orbFirstSlot: (before.requests.find((r) => r.key === 'orb:world:1') || {}).slot,
      lampSlot: slotOf('lamp:body:janus:1'),
      orbSlot: slotOf('orb:world:1'),
      castingSlot: d.shadows.castingSlot,
      anyCasting: d.shadows.anyCasting,
      lampRow: d.shadows.wantsShadows.find((w) => w.key === 'lamp:body:janus:1') || null,
      slotState: d.slotState,
      distinct: new Set(d.requests.filter((r) => r.slot >= 0).map((r) => r.slot)).size,
      assignedCount: d.requests.filter((r) => r.slot >= 0).length,
    });
  }
  if (CASE === 'far') {
    // the lamp's shadow camera is BOUNDED at body scale: a small near alone worsens the near/far ratio and quantises shadows away
    const born = { near: lamp().shadow.camera.near, far: lamp().shadow.camera.far };
    // a tight-range lamp request must pull `far` down to match (pl.distance is rewritten from the winning request every frame)
    rig.requestLight('lamp:test', { keep: true, intensity: 8, range: 3, shadows: true });
    rig.updateRig(1000);
    const tight = { far: lamp().shadow.camera.far, distance: lamp().distance };
    // ...and a wide one must push it back up
    rig.requestLight('lamp:test', { keep: true, intensity: 8, range: 9, shadows: true });
    rig.updateRig(2000);
    const wide = { far: lamp().shadow.camera.far, distance: lamp().distance };
    out({ born, tight, wide });
  }
  if (CASE === 'flip') {
    const boot = snap();
    setShadows(false); const off = snap();
    setShadows(true); const on = snap();
    out({ boot, off, on });
  }
  process.exit(0);
}

// ---- the parent: run the cases, check the invariants -----------------------

let pass = 0, fail = 0;
const check = (name, ok, note = '') => { if (ok) { pass++; console.log(`  ok    ${name}`); } else { fail++; console.log(`  FAIL  ${name}${note ? `  -- ${note}` : ''}`); } };

async function runCase(name, mutate = null) {
  const args = [process.execPath, import.meta.path, '--case', name];
  if (mutate) args.push('--mutate', String(mutate));
  const p = Bun.spawnSync(args, { stdout: 'pipe', stderr: 'pipe' });
  const text = p.stdout.toString();
  const line = text.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line) throw new Error(`case ${name} produced no result:\n${text}\n${p.stderr.toString()}`);
  return JSON.parse(line.slice('__RESULT__'.length));
}

// one case's assertions as a function, so the mutation controls reuse the exact checks, not a paraphrase
const bootOnChecks = (r, c = check) => {
  c('preference default is ON', r.boot.pref === true);
  c('shadow map enabled at boot', r.boot.map === true);
  c('the lamp slot casts at boot', r.boot.lamp === true);
};
const bootOffChecks = (r, c = check) => {
  c('preference OFF is read at boot', r.boot.pref === false);
  c('pref off at boot: the sun draws no shadow (uniform-level; the map stays in the pipeline shape)', r.boot.sun === false && r.boot.shapeOn === true);
  // a casting lamp with the map off is a lamp pretending: agreement is the invariant, not "off"
  c('the lamp slot does NOT cast when the preference is off', r.boot.lamp === false,
    'slot 0 born casting with shadowMap.enabled=false — boot disagrees with the switch');
};
const flipChecks = (r, c = check) => {
  c('setShadows(false) keeps the pipeline shape (no scene recompile)', r.off.shapeOn === true);
  c('setShadows(false) stops the sun casting', r.off.sun === false);
  c('setShadows(false) stops the LAMP casting', r.off.lamp === false,
    'the lamp kept casting into a disabled shadow map');
  c('setShadows(false) is reported by shadowsOn()', r.off.pref === false);
  c('setShadows(true) re-enables the map', r.on.map === true);
  c('setShadows(true) restores the sun', r.on.sun === true);
  c('setShadows(true) RESTORES the lamp', r.on.lamp === true,
    'the lamp never came back — the slot is built once at boot and was never revisited');
  c('setShadows(true) is reported by shadowsOn()', r.on.pref === true);
};

const farChecks = (r, c = check) => {
  c('the lamp is born with a bounded near', r.born.near > 0 && r.born.near <= 0.05,
    `near=${r.born.near}`);
  // far=500 with near=0.03: the invariant is the RATIO, which sets a perspective shadow map's depth precision
  c('the lamp is born with a bounded far (NOT three\'s 500)', r.born.far <= 10,
    `far=${r.born.far} — a 512 cube map spread over ${r.born.far} m has no precision at 0.6 m`);
  c('born near/far ratio is usable at body scale', r.born.far / r.born.near <= 1000,
    `ratio=${Math.round(r.born.far / r.born.near)}:1`);
  c('far follows a TIGHT lamp range', r.tight.far <= 3 + 1e-6,
    `range 3 -> far ${r.tight.far} (distance ${r.tight.distance})`);
  c('far follows a WIDE lamp range', Math.abs(r.wide.far - 9) < 1e-6,
    `range 9 -> far ${r.wide.far} (distance ${r.wide.distance})`);
};

const contendChecks = (r, c = check) => {
  c('the world light takes the casting slot first (the setup)', r.orbFirstSlot === r.castingSlot,
    `orb landed on slot ${r.orbFirstSlot}, casting slot is ${r.castingSlot}`);
  // the general pass assigns the lamp first, so a `r.slot < 0` guard would never let it claim the casting slot
  c('the lamp ends up on the CASTING slot', r.lampSlot === r.castingSlot,
    `lamp on slot ${r.lampSlot}, casting slot is ${r.castingSlot}`);
  c('...and is actually casting', r.lampRow?.casting === true,
    `wantsShadows row: ${JSON.stringify(r.lampRow)}`);
  c('anyCasting agrees', r.anyCasting === true);
  // the swap must not cost the incumbent its light, or "shadows work" is paid for with a world light going dark
  c('the evicted world light keeps a slot', r.orbSlot >= 0, `orb slot ${r.orbSlot}`);
  c('the evicted world light is still lit', (r.slotState[r.orbSlot] || {}).intensity > 0,
    `slot ${r.orbSlot} intensity ${(r.slotState[r.orbSlot] || {}).intensity}`);
  // and no two requests may share one slot (the first cut of the swap did)
  c('no two requests share a slot', r.distinct === r.assignedCount,
    `${r.assignedCount} assigned across ${r.distinct} distinct slots`);
};

const biasChecks = (r, c = check) => {
  // the shipped defaults are a measured set, pinned together: they only mean anything together, so retune them here
  c('the shipped defaults are the measured set',
    r.shipped.map === 256 && r.shipped.texels === 8 && r.shipped.workDist === 12
    && Math.abs(r.shipped.forward - -0.02) < 1e-6 && Math.abs(r.shipped.up - 0.15) < 1e-6
    && r.shipped.side === 0,
    JSON.stringify(r.shipped));
  // the born values are asserted against the arithmetic, not as remembered numbers, so a deliberate retune stays green
  c('the lamp is born at a small map size', r.born.map >= 128 && r.born.map <= 512,
    `map=${r.born.map}`);
  // THE INVARIANT: whatever the dials say, the bias IS texels x texel size (the specific look is a design choice)
  c('born normalBias equals texels x texel size', 
    Math.abs(r.born.normalBias - r.born.texels * (r.born.texelMM / 1000)) < 1e-4,
    `normalBias=${r.born.normalBias} texels=${r.born.texels} texelMM=${r.born.texelMM}`);
  c('born bias is not the old hand-picked 0.02 constant', Math.abs(r.born.normalBias - 0.02) > 1e-6,
    `normalBias=${r.born.normalBias}`);
  // THE INVARIANT: bias scales with the map so the LOOK is size-independent
  c('normalBias HALVES when the map doubles (256->512)',
    Math.abs(r.at[256].normalBias / r.at[512].normalBias - 2) < 0.02,
    `256:${r.at[256].normalBias} 512:${r.at[512].normalBias}`);
  c('...and again (512->1024)',
    Math.abs(r.at[512].normalBias / r.at[1024].normalBias - 2) < 0.02,
    `512:${r.at[512].normalBias} 1024:${r.at[1024].normalBias}`);
  // tolerance, not equality: texelMM is rounded to 2 decimals, so dividing reconstructs texels to ~1 part in 500; the claim
  // is "constant across sizes", not "bit-identical"
  {
    const counts = [256, 280, 512, 1024].map((n) => r.at[n].normalBias / (r.at[n].texelMM / 1000));
    const spread = Math.max(...counts) - Math.min(...counts);
    c('bias stays a constant number of TEXELS across sizes', spread < 0.01,
      `texel counts ${counts.map((x) => x.toFixed(3)).join(' / ')} (spread ${spread.toFixed(4)})`);
  }
  c('the texel dial retunes without touching the map', r.retuned.map === 280 && r.retuned.texels === 3,
    JSON.stringify(r.retuned));
};

if (ARGV.includes('--mutants')) {
  // each control reverts one half of the fix and its case must go red; a control that stays green means the test isn't
  // measuring what its name claims
  console.log('MUTATION CONTROLS — each must KILL its case');
  for (const [n, name, checks, label] of [
    [1, 'boot-off', bootOffChecks, 'slot born casting regardless of preference'],
    [2, 'flip', flipChecks, 'setShadows forgets the lamp slot'],
    [3, 'far', farChecks, "shadow far left at three's default 500"],
    [4, 'contend', contendChecks, 'lamp parked on a non-casting slot'],
    [5, 'bias', biasChecks, 'normalBias pinned to the old 0.02 constant'],
  ]) {
    const r = await runCase(name, n);
    let died = 0;
    checks(r, (_nm, ok) => { if (!ok) died++; });
    check(`control ${n} (${label}) is caught`, died > 0, 'the mutant survived — this test proves nothing');
  }
} else {
  console.log('SHADOW PREFERENCE — boot, default ON');
  bootOnChecks(await runCase('boot-on'));
  console.log('SHADOW PREFERENCE — boot, preference OFF');
  bootOffChecks(await runCase('boot-off'));
  console.log('SHADOW PREFERENCE — the switch flips both casters');
  flipChecks(await runCase('flip'));
  console.log('LAMP SHADOW CAMERA — near and far are bounded together');
  farChecks(await runCase('far'));
  console.log('CONTENDED CASTING SLOT — the world light loaded first');
  contendChecks(await runCase('contend'));
  console.log('LAMP SHADOW BIAS — derived from the map, not guessed');
  biasChecks(await runCase('bias'));
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
