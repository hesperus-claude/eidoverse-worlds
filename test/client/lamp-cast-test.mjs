// WHICH LAMPS CAST, AND HOW MANY AT ONCE (client/lib/render/lightrig.js: the casting slots, assign, casterTuning).
//
// The world owns the look: a light casts only when its author asked (light.shadows, absent = no; Godot's
// Light3D.shadow_enabled, Filament's castShadows). The viewer owns the cost: `ew-lamp-shadows` (1 / 2 / 4 / 8, read at
// boot) is how many point slots are BORN casting (castShadow is pipeline shape: never toggled). When more lights ask
// than there are casting slots, the best-ranked askers win, by the pool's own ranking (rankOf), swapping with whoever
// holds a casting slot without asking; the rest light without casting. A casting slot draws only for a holder that
// asked. Its depth tuning follows its holder: the avatar's chest lamp keeps its dial (map 256, normalBias 8 texels at
// 12 m, bias -0.0005: a bulb inside a ribcage), a world lamp casts with bias -0.00002 and normalBias 1.5 texels at
// min(3 m, its range) (LAB.md 11-04: the chest lamp's -0.0005 at near 0.03 floated every contact shadow ~12 cm off
// the floor, a chair leg visibly hovering).
//
// lightrig reads the preference at module scope, so each N runs as a child (`--case <name>`, shadow-fade-test's house
// pattern); the child prints its rows and the parent counts them.
import { GlobalRegistrator } from '@happy-dom/global-registrator';
import { plugin } from 'bun';
import { stubResolve } from '../harness/stub.ts';
import { suite } from '../gate/suite.ts';
GlobalRegistrator.register();
HTMLCanvasElement.prototype.getContext = function () { const a = new Proxy(function () {}, { get: (_t, k) => (k === 'width' ? 100 : a), apply: () => a, set: () => true }); return new Proxy({}, { get: (_t, k) => (k === 'measureText' ? () => ({ width: 100 }) : a), set: () => true }); };
const HERE = import.meta.dir; const here = (p) => `${HERE}/${p.replace(/^\.\//, '')}`;
const ARGV = process.argv.slice(2);
const argOf = (f) => { const i = ARGV.indexOf(f); return i < 0 ? null : ARGV[i + 1]; };
const CASE = argOf('--case');

// the cases: the stored preference each boots with, and the N it must give
const CASES = {
  default: { stored: null, n: 1 },   // absent: today's one casting slot (LAMP_SHADOWS_DEFAULT)
  bad: { stored: '3', n: 1 },        // not a choice: the default
  n1: { stored: '1', n: 1 },
  n2: { stored: '2', n: 2 },
  n4: { stored: '4', n: 4 },
  n8: { stored: '8', n: 8 },         // every one of the 8 default slots
};
// the full scenario runs at these; the others only check the boot shape
const FULL = ['n1', 'n2', 'n4'];

// ---- the child: one boot, measured ----
if (CASE) {
  plugin({ name: 'core-stub', setup(build) {
    stubResolve(build, /^(\.\.?\/)+core\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+base\.js$/, () => ({ path: here('../stubs/core-stub.mjs') }));
    stubResolve(build, /^(\.\.?\/)+(render\/)?warmqueue\.js$/, () => ({ path: here('../stubs/lod-client-stub.mjs') }));   // warmDepth resolves at once
  } });
  const C = CASES[CASE];
  localStorage.removeItem('ew-shadows');   // the viewer's switch: absent = on
  if (C.stored == null) localStorage.removeItem('ew-lamp-shadows'); else localStorage.setItem('ew-lamp-shadows', C.stored);
  const { THREE, camera } = await import('../stubs/core-stub.mjs');
  const rig = await import('../../client/lib/render/lightrig.js');
  const rows = [];
  const check = (name, ok, note = '') => rows.push([name, Boolean(ok), typeof note === 'string' ? note : JSON.stringify(note)]);
  const out = () => console.log(`__RESULT__${JSON.stringify(rows)}`);
  const N = C.n;

  camera.position.set(0, 1.6, 0); camera.updateMatrixWorld(true);   // looking down -Z
  let t = 1000;
  // 700 ms a frame: past the 600 ms re-rank and the 150 ms hand-over in one step, so two frames settle a swap
  const tick = (n = 2) => { for (let i = 0; i < n; i++) rig.updateRig(t += 700); };
  const d = () => rig.rigDebug();
  const bornShape = d()._slots.map((pl) => pl.castShadow).join(',');
  const shape = () => d()._slots.map((pl) => pl.castShadow).join(',');
  const slotOf = (k) => (d().requests.find((r) => r.key === k) || {}).slot ?? -1;
  const lit = (k) => slotOf(k) >= 0 && (d().slotState[slotOf(k)] || {}).intensity > 0;
  const casts = (k) => Boolean((d().shadows.wantsShadows.find((w) => w.key === k) || {}).casting);
  const castRows = () => d().shadows.slots ?? [];   // one row per casting slot
  const rowOf = (k) => castRows().find((s) => s.holder === k) || null;
  const drawingHolders = () => castRows().filter((s) => s.drawing).map((s) => s.holder);

  // the tunings, as numbers (the derivations in the header)
  const MAP = 256;
  const WORLD = { bias: -0.00002, normalBias: (range) => 1.5 * (2 * Math.min(3, range)) / MAP };
  const BODY = { bias: -0.0005, normalBias: 8 * (2 * 12) / MAP };
  const near = (a, b) => Number.isFinite(a) && Math.abs(a - b) < 1e-5;   // rigDebug rounds normalBias to 5 decimals

  console.log(`BOOT — ew-lamp-shadows ${C.stored ?? '(absent)'}: ${N} casting slot(s)`);
  const born = d()._slots.map((pl) => pl.castShadow);
  check(`born: slots 0..${N - 1} cast and the rest do not (pipeline shape)`, born.every((c, i) => c === (i < N)), born.join(','));
  // born drawn (casting-slot-test has the why): a casting slot draws only for a holder that asked, so a slot first drawn
  // when its first asker arrives after the world's models breaks every later frame on a real GPU (three r186 recreates
  // the depth texture at a map's first render). More casting slots than askers is the common case here: EVERY one of
  // them asks three for its one draw at birth, not only slot 0.
  const bornAsk = d()._slots.slice(0, N).map((pl) => pl.shadow.needsUpdate === true);
  check(`born drawn: each of the ${N} casting slot(s) asks three for one draw at birth, before any light`, bornAsk.length === N && bornAsk.every(Boolean), bornAsk.join(','));
  check(`rigDebug().shadows.castingSlots is ${N}`, d().shadows.castingSlots === N, d().shadows.castingSlots);
  check(`one row per casting slot in rigDebug().shadows.slots`, castRows().length === N, castRows().length);
  check('lampShadowCount() reads the stored choice back', rig.lampShadowCount?.() === N, rig.lampShadowCount?.());
  check('LAMP_SHADOW_CHOICES are 1, 2, 4, 8', JSON.stringify(rig.LAMP_SHADOW_CHOICES) === '[1,2,4,8]', rig.LAMP_SHADOW_CHOICES);
  check('an idle casting slot draws nothing (no holder asked)', castRows().length === N && castRows().every((s) => !s.drawing), castRows());
  { // a resize while no slot draws (nobody asked yet) asks EVERY casting slot for its draw in that frame, not only slot 0:
    // three refreshes a classic material's bind group only in the frame mapSize changes (shadow-fade's resize case)
    const slotsN = d()._slots.slice(0, N), held = slotsN.map((pl) => pl.shadow.needsUpdate);
    slotsN.forEach((pl) => { pl.shadow.needsUpdate = false; });
    rig.setShadowRes(4096);
    const asked = slotsN.map((pl) => pl.shadow.needsUpdate === true);
    rig.setShadowRes(2048);
    slotsN.forEach((pl, i) => { pl.shadow.needsUpdate = held[i]; });
    check(`a resolution change with no light asking asks each of the ${N} casting slot(s) to redraw in that frame`, asked.every(Boolean), asked.join(','));
  }

  if (!FULL.includes(CASE)) { check('castShadow never flipped on any slot', shape() === bornShape); out(); process.exit(0); }

  console.log('THE ROOM — three lamps that did not ask arrive first and take the low slots');
  const plain = ['complight:sconce0', 'complight:sconce1', 'complight:sconce2'];
  plain.forEach((k, i) => rig.requestLight(k, { authored: true, intensity: 10, range: 6, pos: [i - 1, 2, -1.2] }));
  tick();
  check('the non-askers hold slots 0..2 (the setup)', plain.map(slotOf).sort().join(',') === '0,1,2', plain.map(slotOf));
  check('...and no casting slot draws for them', drawingHolders().length === 0, castRows());

  console.log(`${N + 1} WORLD LAMPS ASK (light.shadows), ranked A0 best`);
  const ask = Array.from({ length: N + 1 }, (_, i) => `complight:asker${i}`);
  // the same brightness, farther each: A0 ranks first
  ask.forEach((k, i) => rig.requestLight(k, { authored: true, intensity: 20, range: 9, shadows: true, pos: [0.3 * i, 1.5, -3 - 0.5 * i] }));
  tick();
  check(`the ${N} best-ranked askers each hold a casting slot`, ask.slice(0, N).every((k) => slotOf(k) >= 0 && slotOf(k) < N), ask.map(slotOf));
  check('...and each casts', ask.slice(0, N).every(casts), ask.map(casts));
  check(`the asker past ${N} lights without casting`, lit(ask[N]) && !casts(ask[N]) && slotOf(ask[N]) >= N, { slot: slotOf(ask[N]), casts: casts(ask[N]) });
  check('every casting slot that draws is held by an asker', drawingHolders().length === N && drawingHolders().every((k) => ask.includes(k)), drawingHolders());
  check('the non-askers they swapped with are still lit, and do not cast', plain.every(lit) && plain.every((k) => !rowOf(k)?.drawing), plain.map((k) => [slotOf(k), lit(k)]));

  console.log('THE WORLD TUNING — a world lamp casts with its own bias, not the chest lamp\'s');
  const w0 = rowOf(ask[0]);
  check('a casting world lamp has depth bias -0.00002', !!w0 && near(w0.bias, WORLD.bias), w0);
  check('...and normalBias 1.5 texels at min(3 m, its range)', !!w0 && near(w0.normalBias, WORLD.normalBias(9)), { got: w0?.normalBias, want: WORLD.normalBias(9) });
  rig.updateRequest(ask[0], { range: 2 });   // models.js re-syncs a changed light in place: the same request
  tick();
  check('...a range re-synced in place below 3 m re-derives it (the same holder, a new basis)', near(rowOf(ask[0])?.normalBias, WORLD.normalBias(2)), { got: rowOf(ask[0])?.normalBias, want: WORLD.normalBias(2) });
  rig.updateRequest(ask[0], { range: 9 });
  tick();

  console.log('AN ASKER THAT OUTRANKS A CASTING INCUMBENT TAKES ITS SLOT');
  const lastCaster = ask[N - 1];
  const lastSlot = slotOf(lastCaster);
  rig.requestLight('complight:bright', { authored: true, intensity: 80, range: 9, shadows: true, pos: [0, 1.5, -2] });
  tick();
  check('the newcomer casts', casts('complight:bright') && slotOf('complight:bright') < N, slotOf('complight:bright'));
  check(`the worst-ranked of the ${N} (A${N - 1}) gave up its casting slot`, !casts(lastCaster), { slot: slotOf(lastCaster), was: lastSlot });
  check('...and still lights', lit(lastCaster), slotOf(lastCaster));
  check('the askers ranked above it keep casting', ask.slice(0, N - 1).every(casts), ask.map(casts));
  rig.releaseLight('complight:bright');
  tick();
  check('the newcomer gone, A' + (N - 1) + ' casts again', casts(lastCaster), slotOf(lastCaster));
  // an asker already lit in a non-casting slot climbs past the last casting one: they TRADE slots, so neither goes dark
  // even in a full pool (at 4 casting slots every slot is taken)
  const climber = ask[N], climbFrom = slotOf(climber), passed = slotOf(lastCaster);
  rig.updateRequest(climber, { intensity: 200, pos: [0.3 * N, 1.5, -3 - 0.5 * N] });   // a re-placed light re-ranks
  tick(1);   // ONE frame: a swap that dropped the incumbent would leave it dark here, re-seated only by the next re-rank
  check(`an asker lit elsewhere that climbs past A${N - 1} takes its casting slot, and A${N - 1} takes the climber's in the same frame`, slotOf(climber) === passed && slotOf(lastCaster) === climbFrom && casts(climber) && !casts(lastCaster) && lit(lastCaster),
    { climber: [climbFrom, slotOf(climber)], passed: [passed, slotOf(lastCaster)], full: d().requests.filter((r) => r.slot >= 0).length });
  rig.releaseLight(climber);
  tick();
  rig.requestLight(climber, { authored: true, intensity: 20, range: 9, shadows: true, pos: [0.3 * N, 1.5, -3 - 0.5 * N] });
  tick();

  console.log('THE VIEWER\'S SWITCH COMPOSES WITH IT');
  rig.setShadows(false);
  check('setShadows(false): no casting slot draws', drawingHolders().length === 0, castRows());
  rig.reassertShadowPref();
  check('reassertShadowPref keeps them off', drawingHolders().length === 0);
  rig.setShadows(true);
  check(`setShadows(true): the ${N} askers draw again`, drawingHolders().length === N && ask.slice(0, N).every(casts), drawingHolders());
  check('...and only askers', drawingHolders().every((k) => ask.includes(k)));

  console.log('THE SHADOW RESOLUTION DIAL — every casting slot follows it');
  rig.setShadowRes(1024);
  const maps = () => d()._slots.slice(0, N).map((pl) => pl.shadow.mapSize.x);
  check('setShadowRes(1024): every casting slot\'s map is 128', maps().every((m) => m === 128), maps());
  tick();
  const w1024 = rowOf(ask[0]);
  check('...and a world lamp\'s normalBias follows the map (1.5 texels)', !!w1024 && near(w1024.normalBias, 1.5 * 6 / 128), w1024);
  rig.setShadowRes(2048);
  check('setShadowRes(2048): back to 256', maps().every((m) => m === MAP), maps());
  tick();

  console.log('THE CHEST LAMP — its own tuning in whichever casting slot it holds, and the tuning follows the holder');
  for (const k of ask.slice(1)) rig.releaseLight(k);
  // a glowing body 1.2 m ahead: avatar.js's call shape
  const g = new THREE.Group();
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 0.02, 0, 0, 0, 0.02, 0], 3));
  const m = new THREE.MeshBasicMaterial(); m.emissive = new THREE.Color(1, 0.85, 0.6); m.emissiveIntensity = 3;
  g.add(new THREE.Mesh(geo, m)); g.position.set(0, 1.4, -1.2); g.updateMatrixWorld(true);
  const body = rig.attachLamps(g, 'body:mythos:1', { shadows: true })[0].key;
  tick();
  // an authored world lamp ranks before an inferred one (the pool's tiers), so with one casting slot A0 keeps it
  if (N === 1) {
    check('one casting slot: the world asker (authored tier) keeps it; the chest lamp lights without casting', casts(ask[0]) && !casts(body) && lit(body), { a0: slotOf(ask[0]), body: slotOf(body) });
  } else {
    check(`${N} casting slots: the world asker and the chest lamp both cast`, casts(ask[0]) && casts(body), { a0: slotOf(ask[0]), body: slotOf(body) });
    const b = rowOf(body);
    check('...the chest lamp with its own dial (bias -0.0005, normalBias 8 texels at 12 m)', !!b && near(b.bias, BODY.bias) && near(b.normalBias, BODY.normalBias), b);
    check('...the world lamp beside it with the world tuning', near(rowOf(ask[0])?.bias, WORLD.bias) && near(rowOf(ask[0])?.normalBias, WORLD.normalBias(9)), rowOf(ask[0]));
  }
  const a0slot = slotOf(ask[0]);
  rig.releaseLight(ask[0]);
  tick();
  const bAlone = rowOf(body);
  check('the world lamp gone, the chest lamp casts', casts(body), slotOf(body));
  check('...with its own dial', !!bAlone && near(bAlone.bias, BODY.bias) && near(bAlone.normalBias, BODY.normalBias), bAlone);
  if (N === 1) check('...in the slot the world lamp held, re-tuned for it (the tuning followed the holder)', slotOf(body) === a0slot, { body: slotOf(body), was: a0slot });
  check('lampShadowState() reports the chest dial', near(rig.lampShadowState().bias, BODY.bias) && near(rig.lampShadowState().normalBias, BODY.normalBias), rig.lampShadowState());
  // a world asker comes back, ranked above the chest lamp (authored)
  rig.requestLight('complight:stove', { authored: true, intensity: 30, range: 14, shadows: true, pos: [0.5, 0.6, -2.5] });
  tick();
  const stove = rowOf('complight:stove');
  check('a world asker returns and casts with the world tuning (range 14: the 3 m basis)', casts('complight:stove') && !!stove && near(stove.bias, WORLD.bias) && near(stove.normalBias, WORLD.normalBias(14)), stove);
  if (N === 1) {
    check('...in the chest lamp\'s old slot (a swap), and the chest lamp no longer casts', slotOf('complight:stove') === a0slot && !casts(body) && lit(body), { stove: slotOf('complight:stove'), body: slotOf(body) });
    check('lampShadowState() still reports the chest dial while a world lamp holds the slot', near(rig.lampShadowState().bias, BODY.bias) && near(rig.lampShadowState().normalBias, BODY.normalBias), rig.lampShadowState());
  } else {
    check('...and the chest lamp keeps casting with its dial', casts(body) && near(rowOf(body)?.normalBias, BODY.normalBias) && near(rowOf(body)?.bias, BODY.bias), rowOf(body));
  }
  // the chest dial is live (setLampShadow): it reaches the chest lamp wherever it is, never a world lamp
  rig.setLampShadow({ texels: 4 });
  tick();
  const half = 4 * 24 / MAP;
  if (N > 1) check('setLampShadow({texels: 4}) re-tunes the chest lamp\'s slot', near(rowOf(body)?.normalBias, half), rowOf(body));
  check('...and not the world lamp\'s', near(rowOf('complight:stove')?.normalBias, WORLD.normalBias(14)), rowOf('complight:stove'));
  rig.setLampShadow({ texels: 8 });
  for (const k of [...plain, 'complight:stove']) rig.releaseLight(k);
  rig.releaseOwner('body:mythos:1');
  tick();

  console.log('THE CASTER BUDGET — a thing a casting lamp reaches is in shadow reach, whichever casting slot that lamp holds');
  // 150 m out: outside the sun's shadow box (±46 m across the sun, which the stub puts straight overhead)
  rig.requestLight('complight:far-a', { authored: true, intensity: 40, range: 5, shadows: true, pos: [150, 1, 0] });
  rig.requestLight('complight:far-b', { authored: true, intensity: 20, range: 5, shadows: true, pos: [-150, 1, 0] });
  tick();
  const thing = (id, pos, r) => { const o = new THREE.Group(); o.position.set(...pos); o.add(new THREE.Mesh(new THREE.SphereGeometry(r), new THREE.MeshStandardMaterial())); o.updateMatrixWorld(true); rig.registerCaster(id, o); };
  thing('far-big', [0, 1, 150], 2);         // reached by nothing: registered first, so it wins a tie
  thing('by-b', [-150.5, 1, 0], 0.3);       // within lamp B's range
  rig.setCasterBudget(1);
  const settle = async () => { for (let i = 0; i < 4; i++) await Promise.resolve(); };
  for (let i = 0; i < 12; i++) { rig.updateRig(t += 301); await settle(); }
  const on = rig.rigDebug().casterList.filter((c) => c.casting).map((c) => c.id);
  check(`lamp B ranks second: ${N > 1 ? 'it casts' : 'it lights without casting'} (the setup)`, casts('complight:far-b') === (N > 1), { a: casts('complight:far-a'), b: casts('complight:far-b') });
  if (N > 1) check('a thing by the second casting lamp is in shadow reach and takes the one caster place', on.includes('by-b') && !on.includes('far-big'), on);
  else check('with one casting slot it is in no shadow map\'s reach and ranks with the unreached', !on.includes('by-b'), on);

  check('castShadow never flipped on any slot', shape() === bornShape, `${bornShape} -> ${shape()}`);
  out();
  process.exit(0);
}

// ---- the parent: every case, as a child process ----
const S = suite('lamp-cast');
for (const name of Object.keys(CASES)) {
  const p = Bun.spawnSync([process.execPath, import.meta.path, '--case', name], { stdout: 'pipe', stderr: 'pipe' });
  const text = p.stdout.toString();
  const line = text.split('\n').find((l) => l.startsWith('__RESULT__'));
  if (!line || p.exitCode !== 0) { S.check(`case ${name} ran`, false, `exit ${p.exitCode}: ${(text + p.stderr.toString()).slice(-1500)}`); continue; }
  for (const [what, ok, note] of JSON.parse(line.slice('__RESULT__'.length))) S.check(`[${name}] ${what}`, ok, note);
}
S.done();
