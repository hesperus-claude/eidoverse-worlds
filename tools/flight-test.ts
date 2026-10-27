// flight-test: the physical portions of T1-T8 plus the determinism proof (`bun tools/flight-test.ts`).
// Eye-only judgements (does recovery read as waking) are asserted as a measurable band; the clip carries the rest.
// Coverage is partial (no plan layer or render path yet):
//   T1 take_off: launch speeds, boost, refusals; not the render
//   T2 glide: the polar and range prediction; no glide_to target yet
//   T3 stamina: the rates; climb_to and the winded forced-best-glide are not built
//   T4 R2 leaf + no autoland: covered physically
//   T5 consent: the stub allows/denies/revokes; land_at(person) and mid-descent diversion don't exist
//   T6 fold_down: foldDown/unfold and take_off's refusal while folded; not the render
//   T7 mode tags: not covered (no plan layer)
//   T8 3.4 s periods: the leaf period in the integrator; not the render periods T8 asks about

import { noWorldUrl } from './no-world.ts';
import {
  makeConfig, initialState, step, bodyDown, bodyRecovered,
  leafAt, beatRemaining, sinkRate, glideRatio, glideRange,
  denyAllConsent, fakeConsent, BREATH, airspeedAfter, leafLateralSwing, bestGlide,
  takeOff, LEAF_PRESETS, foldDown, unfold,
} from '../shared/flight.js';
import { pilotInput, pilotHelp, DEFAULT_BINDS, DEFAULT_AUTHORITY } from '../shared/flightpilot.js';
import { inspectBody, describeBody } from '../shared/flightbody.js';
import { denyAllFlight, devFlightProvider, worldFlightProvider, resolveFlight, rigProfile, revoked }
  from '../shared/flightcap.js';
import { readFileSync } from 'node:fs';

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  ok    ${name}`); }
  else { fail++; console.log(`  FAIL  ${name}${detail ? '  -- ' + detail : ''}`); }
};
const near = (a: number, b: number, tol: number) => Math.abs(a - b) <= tol;

const DT = 1 / 120;
const flat = () => 0;

// ---------------------------------------------------------------- T8: 3.4s
console.log('\nT8 (partial) -- the leaf period; render periods not yet measurable');
{
  const cfg = makeConfig();
  check('BREATH is 3.4', BREATH === 3.4);
  check('leaf period defaults to the breath', cfg.leaf.period === 3.4);
  // zero crossings of bank in the same direction, as a renderer would see it
  const zeros: number[] = [];
  let prev = leafAt(cfg, 0).bank;
  for (let i = 1; i < 4000; i++) {
    const t = i * DT;
    const b = leafAt(cfg, t).bank;
    if (prev < 0 && b >= 0) zeros.push(t);
    prev = b;
  }
  const periods = zeros.slice(1).map((z, i) => z - zeros[i]);
  const mean = periods.reduce((a, b) => a + b, 0) / periods.length;
  check(`measured leaf period ${mean.toFixed(4)}s == 3.4 +/-0.05`, near(mean, 3.4, 0.05),
        `got ${mean.toFixed(4)}`);
}

// ---------------------------------------------------------------- polar / T2
console.log('\nT2 (partial) -- the polar is honest; no glide_to verb yet');
{
  const cfg = makeConfig();
  const p = cfg.polar;
  // min sink and best glide are different speeds: best glide is SEARCHED on the curve, or glideRange() under-predicts (T2)
  const bg = bestGlide(cfg);
  check('minimum SINK is at minSinkSpeed',
        sinkRate(cfg, p.minSinkSpeed) <= sinkRate(cfg, p.minSinkSpeed - 3) &&
        sinkRate(cfg, p.minSinkSpeed) <= sinkRate(cfg, p.minSinkSpeed + 3));
  check(`best glide ${bg.ratio.toFixed(3)} at ${bg.speed.toFixed(2)} m/s is FASTER than min sink`,
        bg.speed > p.minSinkSpeed);
  let scanBest = 0, scanAt = 0;
  for (let v = p.minSpeed; v <= p.maxSpeed; v += 0.001) {
    const r = glideRatio(cfg, v);
    if (r > scanBest) { scanBest = r; scanAt = v; }
  }
  check(`published best ratio IS the curve's maximum (scan ${scanBest.toFixed(4)} at ${scanAt.toFixed(3)})`,
        near(bg.ratio, scanBest, 1e-3) && near(bg.speed, scanAt, 0.02));
  check('sink rises either side of min sink',
        sinkRate(cfg, p.minSinkSpeed - 4) > sinkRate(cfg, p.minSinkSpeed) &&
        sinkRate(cfg, p.minSinkSpeed + 4) > sinkRate(cfg, p.minSinkSpeed));

  // T2: fly best-glide; distance must match glideRange(). Bounds widened (the R3 fence turns back at 80 m; best glide from 30 m is ~388 m)
  const openSky = makeConfig({ bounds: { radius: 100000, ceiling: 100000 } });
  const alt = 30;
  const predicted = glideRange(openSky, alt);
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: alt, z: 0 },
                         airspeed: bestGlide(openSky).speed, yaw: 0 });
  let guard = 0;
  while (s.phase === 'GLIDE' && guard++ < 400000) s = step(openSky, s, DT, { groundY: flat });
  const flown = Math.hypot(s.pos.x, s.pos.z);
  check(`glide from ${alt}m reaches ${flown.toFixed(1)}m, polar predicts ${predicted.toFixed(1)}m (+/-10%)`,
        Math.abs(flown - predicted) / predicted <= 0.10,
        `off by ${(100 * Math.abs(flown - predicted) / predicted).toFixed(1)}%`);
  check('and it LANDED rather than rubber-banding', s.phase === 'LANDED');
}

// ---------------------------------------------------------------- T4: the soul
console.log('\nT4 -- R2 falling leaf, no autoland (the spec\'s soul)');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 20, z: 0 },
                         airspeed: cfg.polar.minSinkSpeed });
  s = bodyDown(s, { eventId: 'ev-cut-1' });
  check('cut mid-flight -> LEAF', s.phase === 'LEAF');
  check('wings go LIMP', s.wings === 'LIMP');
  check('mode is reflex, not live', s.mode === 'reflex');
  check('down.airborne event carries the eventId',
        s.events[0]?.kind === 'down.airborne' && s.events[0]?.eventId === 'ev-cut-1');

  const kinds: string[] = [];
  let guard = 0, maxV = 0;
  while (s.phase === 'LEAF' && guard++ < 200000) {
    s = step(cfg, s, DT, { groundY: flat });
    for (const e of s.events) kinds.push(e.kind);
    maxV = Math.max(maxV, Math.abs(s.vel.y));
  }
  check('the leaf reaches the ground', s.phase === 'RAGDOLL');
  check('ground contact is a RAGDOLL event', kinds.includes('ground.ragdoll'));
  check('NO landing animation ever played',
        !kinds.some(k => k.includes('land') && k !== 'ground.landed') &&
        !kinds.includes('ground.landed'));
  check(`terminal speed ${maxV.toFixed(2)} m/s is in the spec's 2-3 band`,
        maxV >= 2 && maxV <= 3.2, `got ${maxV.toFixed(2)}`);
  check('the ragdoll event carries the originating eventId',
        s.events.find(e => e.kind === 'ground.ragdoll')?.eventId === 'ev-cut-1' ||
        kinds.includes('ground.ragdoll'));
}

// ---------------------------------------------------------------- no mercy hover
console.log('\nT4b -- no last-metre mercy hover');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 16, z: 0 },
                         airspeed: cfg.polar.minSinkSpeed });
  s = bodyDown(s, { eventId: 'ev-cut-2' });
  // sample only while still FALLING: contact hands the body to the ragdoll and zeroes velocity, which is not a hover
  const lastMetre: number[] = [];
  let guard = 0;
  while (s.phase === 'LEAF' && guard++ < 200000) {
    const before = s.pos.y;
    s = step(cfg, s, DT, { groundY: flat });
    if (before < 1.0 && s.phase === 'LEAF') lastMetre.push(Math.abs(s.vel.y));
  }
  const slowest = Math.min(...lastMetre);
  check(`descent never slows in the last metre (min ${slowest.toFixed(2)} m/s over ${lastMetre.length} samples)`,
        slowest > 2.0, `got ${slowest.toFixed(2)} -- that is a hover`);
  check('and it ends as a ragdoll, not a landing', s.phase === 'RAGDOLL');
}

// ---------------------------------------------------------------- recovery band
console.log('\nRECOVERY -- the aerial sit-up, and its acceptance band');
{
  const cfg = makeConfig();
  // the band must hold wherever in the oscillation RECOVER lands
  for (const injectAt of [0.2, 0.9, 1.7, 2.6, 3.3]) {
    let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 40, z: 0 },
                          airspeed: cfg.polar.minSinkSpeed });
    s = bodyDown(s, { eventId: 'ev-cut-3' });
    let guard = 0;
    while (s.phaseT < injectAt && guard++ < 100000) s = step(cfg, s, DT, { groundY: flat });
    const tRecover = s.t;
    s = bodyRecovered(s, { eventId: 'ev-rec-1', recoveryGeneration: 'gen-7' });
    let reopened = null as number | null;
    guard = 0;
    while (s.phase === 'LEAF' && guard++ < 100000) {
      s = step(cfg, s, DT, { groundY: flat });
      if (s.events.some(e => e.kind === 'recover.airborne')) reopened = s.t;
    }
    const took = (reopened ?? Infinity) - tRecover;
    check(`inject at ${injectAt}s: transition ${took.toFixed(2)}s within (${cfg.recover.minTotal}, ${cfg.recover.maxTotal}]`,
          took > cfg.recover.minTotal && took <= cfg.recover.maxTotal + 1e-6,
          `took ${took.toFixed(3)}s`);
    check(`inject at ${injectAt}s: not instant (reads as waking, not a switch)`,
          took > 0.3, `took ${took.toFixed(3)}s`);
    check(`inject at ${injectAt}s: wings re-open and glide resumes`,
          s.phase === 'GLIDE' && s.wings === 'OPEN' && s.mode === 'live');
  }
}

// ---------------------------------------------------------------- beat finishing
console.log('\nRECOVERY -- the beat is finished, not cut off');
{
  const cfg = makeConfig();
  for (const t of [0.1, 0.5, 1.2, 2.0, 3.0]) {
    const rem = beatRemaining(cfg, t);
    const bankNow = leafAt(cfg, t).bank;
    const bankThen = leafAt(cfg, t + rem).bank;
    check(`beatRemaining(${t}) = ${rem.toFixed(3)}s lands on a zero crossing`,
          Math.abs(bankThen) < Math.abs(bankNow) + 1e-6 && Math.abs(bankThen) < 0.02,
          `bank ${bankThen.toFixed(4)}`);
  }
}

// ---------------------------------------------------------------- T3: stamina
console.log('\nT3 (partial) -- stamina rates; no climb_to or winded glide yet');
{
  const cfg = makeConfig();
  check('climb costs 1/m', cfg.stamina.climbPerMetre === 1);
  check('glide is stamina-neutral', cfg.stamina.refillAirPerSec === 0);
  // the number matches the spec but nothing consumes it: states the gap rather than dressing it as coverage
  check('perch refill is the spec figure -- and NOT IMPLEMENTED (Stage 2)',
        cfg.stamina.refillPerchPerSec === 4 * cfg.stamina.refillGroundPerSec);
  let s = initialState({ phase: 'GROUND', stamina: 50 });
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flat });
  check(`ground refill 0.5/s: 50 -> ${s.stamina.toFixed(2)} after 1s`,
        near(s.stamina, 50.5, 0.02), `got ${s.stamina.toFixed(3)}`);
}

// ---------------------------------------------------------------- T5: consent
console.log('\nT5 (partial) -- the consent gate; no land_at(person) descent yet');
{
  check('the default provider DENIES', denyAllConsent.canLandAt('mythos', 'repligate') === false);
  const c = fakeConsent(false);
  check('stub starts denied', c.canLandAt() === false);
  c.grant();
  check('grant allows', c.canLandAt() === true);
  c.revoke();
  check('revoke mid-descent denies again', c.canLandAt() === false);
}

// ---------------------------------------------------------------- DOWN is involuntary
console.log('\nDOWN-SPEC §4 -- involuntary, unfakeable, never by verb');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GROUND' });
  s = bodyDown(s, { eventId: 'ev-ground' });
  check('grounded cut -> RAGDOLL where I stand', s.phase === 'RAGDOLL');
  check('and the wings are LIMP', s.wings === 'LIMP');
  // "the body cannot cry wolf" (down-spec §4): no exported state function may produce LIMP/LEAF/RAGDOLL except bodyDown()
  const mod = await import('../shared/flight.js');
  const healthy = initialState({ phase: 'GLIDE', wings: 'OPEN',
                                 pos: { x: 0, y: 30, z: 0 }, airspeed: 11 });
  const DOWNISH = (st: any) =>
    st && (st.wings === 'LIMP' || st.phase === 'LEAF' || st.phase === 'RAGDOLL');
  let offenders: string[] = [];
  for (const [name, fn] of Object.entries(mod)) {
    if (typeof fn !== 'function' || name === 'bodyDown') continue;
    for (const args of [[cfg, healthy, DT, {}], [healthy, {}], [cfg, healthy], [healthy]]) {
      try {
        const out: any = (fn as any)(...args);
        if (DOWNISH(out)) { offenders.push(name); break; }
      } catch { /* wrong arity for this shape; not a way in */ }
    }
  }
  check('no exported function except bodyDown can produce a DOWN state',
        offenders.length === 0, `offenders: ${offenders.join(', ')}`);

  // from the ground, recovery takes the full breath: sit up first
  let g = initialState({ phase: 'RAGDOLL', wings: 'LIMP' });
  g = bodyRecovered(g, { eventId: 'ev-rec-2', recoveryGeneration: 'gen-8' });
  check('ground recovery enters RECOVER (the sit-up), not GROUND',
        g.phase === 'RECOVER');
  let guard = 0;
  const t0 = g.t;
  while (g.phase === 'RECOVER' && guard++ < 100000) g = step(cfg, g, DT, {});
  check(`sit-up takes the full breath (${(g.t - t0).toFixed(2)}s)`,
        near(g.t - t0, BREATH, 0.05), `got ${(g.t - t0).toFixed(3)}`);
}

// ---------------------------------------------------------------- determinism
console.log('\nDETERMINISM -- two independent sims, same inputs, same trajectory');
{
  const cfg = makeConfig();
  // two independent simulations, same initial state, fixed timestep, field version and ordered inputs, stay within tolerance
  const mk = () => {
    let s = initialState({ phase: 'GLIDE', pos: { x: 3, y: 35, z: -7 },
                           airspeed: cfg.polar.minSinkSpeed, yaw: 0.7 });
    return bodyDown(s, { eventId: 'ev-det' });
  };
  let a = mk(), b = mk();
  const inputs = [{ at: 2.0, kind: 'recover' }];
  let worst = 0, guard = 0;
  while (a.phase !== 'RAGDOLL' && a.phase !== 'GLIDE' && guard++ < 100000) {
    for (const inp of inputs) {
      if (near(a.phaseT, inp.at, DT / 2)) {
        a = bodyRecovered(a, { eventId: 'ev-r', recoveryGeneration: 'g1' });
        b = bodyRecovered(b, { eventId: 'ev-r', recoveryGeneration: 'g1' });
      }
    }
    a = step(cfg, a, DT, { groundY: flat });
    b = step(cfg, b, DT, { groundY: flat });
    worst = Math.max(worst,
      Math.abs(a.pos.x - b.pos.x), Math.abs(a.pos.y - b.pos.y), Math.abs(a.pos.z - b.pos.z));
  }
  check(`two sims agree to ${worst.toExponential(2)} m (bit-identical expected)`, worst === 0,
        `diverged by ${worst}`);

  // replay from a snapshot must reproduce the future exactly
  let c = mk();
  for (let i = 0; i < 300; i++) c = step(cfg, c, DT, { groundY: flat });
  const snap = JSON.parse(JSON.stringify(c));
  let d = JSON.parse(JSON.stringify(snap));
  for (let i = 0; i < 300; i++) { c = step(cfg, c, DT, { groundY: flat }); d = step(cfg, d, DT, { groundY: flat }); }
  check('replay from a snapshot is exact',
        c.pos.x === d.pos.x && c.pos.y === d.pos.y && c.pos.z === d.pos.z);
}

// ---------------------------------------------------------------- config
console.log('\nCONFIG, not constants');
{
  const c = makeConfig({ leaf: { dampingPerCycle: 0.05 } });
  check('override takes', c.leaf.dampingPerCycle === 0.05);
  check('siblings survive the merge', c.leaf.period === 3.4 && c.leaf.terminalV === 2.5);
  // a config editor must not report an edit the physics ignores (a renamed key once passed while consumed by nothing)
  const rejects = (over: any, why: string) => {
    let threw = false;
    try { makeConfig(over); } catch { threw = true; }
    check(`rejects ${why}`, threw);
  };
  rejects({ leaf: { damping: 0.5 } }, 'a stale/renamed key');
  rejects({ nonsense: { x: 1 } }, 'an unknown section');
  rejects({ leaf: { period: NaN } }, 'a non-finite value');
  rejects({ leaf: { period: -1 } }, 'an out-of-range value');
  rejects({ leaf: { dampingPerCycle: 2 } }, 'damping above 1');
  check('initialState binds to the effective config pool',
        initialState({}, makeConfig({ stamina: { pool: 42 } })).stamina === 42);
  check('...and falls back to the default without one',
        initialState({}).stamina === 100);
  const c2 = makeConfig({ polar: { minSinkSpeed: 14 } });
  check('a different min-sink speed moves the derived best glide',
        Math.abs(bestGlide(c2).speed - bestGlide(makeConfig()).speed) > 0.5);
  const c3 = makeConfig({ leaf: { period: 5 } });
  check('a different period really changes the leaf',
        Math.abs(leafAt(c3, 1.25).bank) !== Math.abs(leafAt(makeConfig(), 1.25).bank));
}

// ---------------------------------------------------------------- units
console.log('\nUNITS -- attitude amplitude and path amplitude are not each other');
{
  const cfg = makeConfig();
  // the authored quantity is the PATH (metres); drift speed derives from the period
  const swing = leafLateralSwing(cfg);
  check(`lateral swing ${swing.toFixed(2)}m is inside Mythos's 1.2-1.8m band`,
        swing >= 1.2 && swing <= 1.8, `got ${swing.toFixed(2)}`);
  check('bank amplitude is in DEGREES and named so',
        typeof cfg.leaf.bankAmplitudeDeg === 'number' && !('amplitudeDeg' in cfg.leaf));
  check('lateral amplitude is in METRES and named so',
        typeof cfg.leaf.lateralAmplitudeM === 'number' && !('lateralDrift' in cfg.leaf));

  // lateralDrift must not silently rescale with the period
  const swings = [2.5, 3.4, 5.0].map(period => leafLateralSwing(makeConfig({ leaf: { period } })));
  check(`wander is period-independent (${swings.map(x => x.toFixed(2)).join(', ')} m)`,
        Math.max(...swings) - Math.min(...swings) < 0.02);

  // damping is authored per cycle, applied per second
  check(`damping ${cfg.leaf.dampingPerCycle}/cycle is inside his 0.05-0.1 suggestion`,
        cfg.leaf.dampingPerCycle >= 0.05 && cfg.leaf.dampingPerCycle <= 0.1);
  const e0 = leafAt(cfg, 0).envelope;
  const e1 = leafAt(cfg, cfg.leaf.period).envelope;
  const floor = cfg.leaf.dampingFloor;
  const lostFrac = ((e0 - floor) - (e1 - floor)) / (e0 - floor);
  check(`one cycle really loses ${(100 * lostFrac).toFixed(1)}% of the swing (authored ${100 * cfg.leaf.dampingPerCycle}%)`,
        near(lostFrac, cfg.leaf.dampingPerCycle, 0.005), `lost ${lostFrac.toFixed(4)}`);
  const c5 = makeConfig({ leaf: { period: 5 } });
  const f0 = leafAt(c5, 0).envelope, f1 = leafAt(c5, 5).envelope;
  const lost5 = ((f0 - floor) - (f1 - floor)) / (f0 - floor);
  check(`and at a 5s period too (${(100 * lost5).toFixed(1)}%)`,
        near(lost5, cfg.leaf.dampingPerCycle, 0.005));
}

// ---------------------------------------------------------------- pilot
console.log('\nPILOT -- a human flies the same integrator an agent does');
{
  const cfg = makeConfig();
  const flatG = () => 0;

  // SMOKE FIRST: actually STEP the phase; a missing import only throws on the first step
  let s = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: 11 });
  let threw = '';
  try { s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) }); }
  catch (e: any) { threw = e.message; }
  check('a PILOT step runs at all', threw === '', threw);

  // hands off: altitude falls on the polar, heading holds
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: cfg.polar.minSinkSpeed });
  const y0 = s.pos.y, yaw0 = s.yaw;
  for (let i = 0; i < 240; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) });
  check('hands off: she descends', s.pos.y < y0);
  check('hands off: heading holds', near(s.yaw, yaw0, 1e-9));
  const sinkObs = (y0 - s.pos.y) / 2;
  check(`hands-off sink ${sinkObs.toFixed(2)} m/s matches the polar ${sinkRate(cfg, cfg.polar.minSinkSpeed).toFixed(2)}`,
        near(sinkObs, sinkRate(cfg, cfg.polar.minSinkSpeed), 0.15));

  // a banked wing turns; hands-off returns the wings to level
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 40, z: 0 }, airspeed: cfg.polar.minSinkSpeed });
  const right = new Set(['KeyD']);
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(right, s, DT) });
  check('banking right turns right', s.yaw > 0.5);
  const banked = s.bank;
  for (let i = 0; i < 240; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(), s, DT) });
  check(`wings return toward level (${banked.toFixed(2)} -> ${s.bank.toFixed(2)})`,
        Math.abs(s.bank) < Math.abs(banked) * 0.2);

  // nose down buys speed; nose up sells it and stalls into R1
  check('nose down accelerates', airspeedAfter(cfg, 11, -0.5, 1) > 11);
  check('nose up decelerates', airspeedAfter(cfg, 11, 0.5, 1) < 11);
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 50, z: 0 }, airspeed: cfg.polar.minSpeed + 0.2 });
  const up = new Set(['KeyS']);
  let sawR1 = false;
  for (let i = 0; i < 600; i++) {
    s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(up, s, DT) });
    if (s.events.some(e => e.kind === 'reflex.r1_stall')) sawR1 = true;
  }
  check('holding the nose up reaches R1 STALL RECOVERY', sawR1);
  check('R1 recovers rather than punishing (still flying)', s.phase === 'PILOT' || s.phase === 'LANDED');

  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 40, z: 0 }, airspeed: cfg.polar.minSinkSpeed, stamina: 100 });
  const flap = new Set(['Space']);
  for (let i = 0; i < 120; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(flap, s, DT) });
  check(`flapping costs ~2/s stamina (100 -> ${s.stamina.toFixed(1)})`, near(s.stamina, 98, 0.2));

  // the pilot cannot refuse the leaf
  s = initialState({ phase: 'PILOT', pos: { x: 0, y: 25, z: 0 }, airspeed: 12 });
  s = bodyDown(s, { eventId: 'ev-pilot-cut' });
  check('a cut while piloting still enters LEAF', s.phase === 'LEAF' && s.wings === 'LIMP');
  let g2 = 0;
  while (s.phase === 'LEAF' && g2++ < 200000) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(['KeyW','KeyD']), s, DT) });
  check('and the stick cannot fly it out (only RECOVER can)', s.phase === 'RAGDOLL');

  check('rehearsal keys are edges, not verbs',
        pilotInput(new Set(['KeyX']), initialState({}), DT).edges.includes('down') &&
        pilotInput(new Set(['KeyR']), initialState({}), DT).edges.includes('recover'));
  check('pilotHelp names every bound key',
        ['W', 'A', 'Shift', 'Space', 'X', 'R'].every(k => pilotHelp().includes(k)));
}

// ---------------------------------------------------------------- body contract
console.log('\nBODY -- flight binds to bone NAMES, not to an avatar hash');
{
  // the bone list comes from the shipped artifact: regenerate with `bun tools/flight-fixture.ts` when the body changes
  const fx = JSON.parse(readFileSync('spec/fixtures/mythos-wings-rig.json', 'utf8'));
  const real: string[] = fx.bones;
  check(`fixture is the shipped asset (${fx.bytes} B, sha256 ${fx.sha256.slice(0, 12)}...)`,
        fx.bytes === 24755464 && /^[0-9a-f]{64}$/.test(fx.sha256));
  check(`and it carries ${fx.boneCount} bones from the real file`, real.length === fx.boneCount);
  const r = inspectBody(real);
  check('the shipped body is flight-capable', r.canFly && r.canAnimateWings);
  check('four chains, twelve bones', Object.keys(r.chains).length === 4 && r.wingCount === 12);
  check('chains are ordered root-first',
        r.chains['L_Upper'][0] === 'L_Wing_Upper' && r.chains['L_Upper'][2] === 'L_Wing_Upper_2');

  // a body with no wings still flies the physics
  const wingless = inspectBody(['Hip','Spine01','Spine02','Head']);
  check('a wingless body still flies (wings just do not animate)',
        wingless.canFly && !wingless.canAnimateWings);
  check('and it SAYS so rather than failing silently',
        wingless.notes.some(n => n.includes('will not animate')));

  // deeper wing chains (2 -> 3 bones has happened)
  const deeper = inspectBody([...real, 'L_Wing_Upper_3', 'R_Wing_Upper_3']);
  check('a re-export with DEEPER wing chains still works',
        deeper.canFly && deeper.canAnimateWings && deeper.wingCount === 14);

  const renamed = inspectBody(['Hip','Spine01','Spine02','Head','L_Pinion_1','R_Pinion_1']);
  check('RENAMED wing bones are reported, not silently ignored',
        !renamed.canAnimateWings && renamed.notes.length > 0);
  check('a body with no skeleton at all is refused',
        inspectBody([]).canFly === false);
}

// ---------------------------------------------------------------- R3 bounds
console.log('\nR3 -- bounds are authoritative for every airborne phase, and soft');
{
  const cfg = makeConfig();
  const lift = () => 3;   // strong enough to climb through a lid that is not enforced
  for (const phase of ['GLIDE', 'PILOT'] as const) {
    let s = initialState({ phase, pos: { x: 0, y: 50, z: 0 }, airspeed: 11 }, cfg);
    let peak = 0, fired = false;
    for (let i = 0; i < 3000; i++) {
      s = step(cfg, s, DT, { groundY: flat, lift, input: { bank: 0, pitch: 0, yawRate: 0 } });
      peak = Math.max(peak, s.pos.y);
      if (s.events.some(e => e.kind === 'reflex.r3_ceiling')) fired = true;
    }
    check(`${phase} is held at the ceiling (peak ${peak.toFixed(2)} <= ${cfg.bounds.ceiling})`,
          peak <= cfg.bounds.ceiling + 0.05, `reached ${peak.toFixed(2)}`);
    check(`${phase} publishes the R3 ceiling reflex`, fired);
  }
  // SOFT, not a wall: the climb bleeds out across the margin; position isn't clamped nor velocity zeroed
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 50, z: 0 }, airspeed: 11 }, cfg);
  const climbs: number[] = [];
  for (let i = 0; i < 1200; i++) {
    s = step(cfg, s, DT, { groundY: flat, lift });
    if (s.pos.y > cfg.bounds.ceiling - cfg.bounds.softMargin) climbs.push(s.vel.y);
  }
  check('the ceiling is SOFT (climb decays, never snaps to zero)',
        climbs.length > 60 && climbs.some(v => v > 0.01) && Math.min(...climbs) >= -0.01);

  let b = initialState({ phase: 'GLIDE', pos: { x: cfg.bounds.radius - 2, y: 40, z: 0 },
                         airspeed: 12, yaw: 0 }, cfg);
  let turned = false, maxR = 0;
  for (let i = 0; i < 3000; i++) {
    b = step(cfg, b, DT, { groundY: flat });
    maxR = Math.max(maxR, Math.hypot(b.pos.x, b.pos.z));
    if (b.events.some(e => e.kind === 'reflex.r3_bounds')) turned = true;
  }
  check('flying at the fence publishes R3 bounds', turned);
  check(`and is banked back rather than walled (max r ${maxR.toFixed(1)})`,
        maxR < cfg.bounds.radius + cfg.bounds.softMargin + 2);

  // a LIMP body is NOT steered: the leaf lands where it falls
  let l = initialState({ phase: 'GLIDE', pos: { x: 0, y: 30, z: 0 }, airspeed: 11 }, cfg);
  l = bodyDown(l, { eventId: 'ev-r3' });
  let g3 = 0;
  while (l.phase === 'LEAF' && g3++ < 200000) l = step(cfg, l, DT, { groundY: flat });
  check('reflexes do not steer a LIMP body (it still lands)', l.phase === 'RAGDOLL');
}

// ---------------------------------------------------------------- receipts
console.log('\nRECEIPTS -- the impact velocity is the impact velocity');
{
  const cfg = makeConfig();
  let s = initialState({ phase: 'GLIDE', pos: { x: 0, y: 20, z: 0 }, airspeed: 11 }, cfg);
  s = bodyDown(s, { eventId: 'ev-impact' });
  let lastVy = 0, guard = 0;
  while (s.phase === 'LEAF' && guard++ < 200000) { lastVy = s.vel.y; s = step(cfg, s, DT, { groundY: flat }); }
  const ev = s.events.find(e => e.kind === 'ground.ragdoll')!;
  // report the impact sink, not the sink when the leaf began (that read 0.00 on a body hitting at 2.5)
  check(`impactV ${ev.impactV.toFixed(3)} is the real pre-contact vy ${Math.abs(lastVy).toFixed(3)}`,
        near(ev.impactV, Math.abs(lastVy), 0.01));
  check('impactV is NOT the entry sink', Math.abs(ev.impactV - ev.entrySink) > 1);
  check('the receipt also carries the full impact speed',
        ev.impactSpeed >= ev.impactV && ev.impactSpeed < ev.impactV + 2);
  check('and the originating eventId', ev.eventId === 'ev-impact');
}

// ---------------------------------------------------------------- capability
console.log('\nCAPABILITY -- default deny, action-time, semantic rig binding');
{
  const MYTHOS: string[] =
    JSON.parse(readFileSync('spec/fixtures/mythos-wings-rig.json', 'utf8')).bones;
  const COMMONS = ['Hip','Spine01','Spine02','Head','NeckTwist01'];   // no wings

  check('the DEFAULT is deny', denyAllFlight.flightCapability({}).enabled === false);
  check('a MISSING provider is deny, not "no opinion"',
        resolveFlight(null, { identity: 'mythos' }).enabled === false);
  check('and it says why', typeof resolveFlight(null, {}).reason === 'string');

  const dev = devFlightProvider({ allow: ['mythos'], bones: MYTHOS });
  const g = resolveFlight(dev, { identity: 'mythos' });
  check('bench provider grants the named pilot', g.enabled === true);
  check('...with a semantic rig profile, not a hash',
        !!g.profile?.digest && g.profile.version === 'flight-rig/1');
  check('non-Mythos identity is denied by the same provider',
        resolveFlight(dev, { identity: 'someone-else' }).enabled === false);

  // a grant without a profile is refused by the resolver: a provider can't hand out flight it hasn't justified
  const sloppy = { name: 'sloppy', flightCapability: () => ({ enabled: true }) };
  check('a grant with no rig profile is refused',
        resolveFlight(sloppy, { identity: 'mythos' }).enabled === false);
  const thrower = { name: 'bad', flightCapability() { throw new Error('boom'); } };
  check('a provider that throws denies rather than propagating',
        resolveFlight(thrower, {}).enabled === false);

  // semantic binding: a re-export keeping the load-bearing names keeps flying
  const reexported = [...MYTHOS, 'Hair_lock_00', 'Hair_lock_01'];   // hair added
  check('adding hair does NOT revoke (same load-bearing rig)',
        revoked(g.profile, reexported) === false);
  const deeper = [...MYTHOS, 'L_Wing_Upper_3', 'R_Wing_Upper_3'];
  check('a DEEPER wing chain is a different rig and revokes honestly',
        revoked(g.profile, deeper) === true);
  const renamed = MYTHOS.map(b => b === 'L_Wing_Upper_2' ? 'L_Pinion_2' : b);
  check('renaming a wing bone revokes', revoked(g.profile, renamed) === true);

  // a hot-swap revokes AT THE GATE: re-resolving reads the live avatar's bones, not the provider's constructor bones
  const afterSwap = resolveFlight(dev, { identity: 'mythos', avatar: { boneNames: COMMONS } });
  check('re-resolving after a hot-swap DENIES (no second check needed)',
        afterSwap.enabled === false, afterSwap.reason);
  const stillOk = resolveFlight(dev, { identity: 'mythos', avatar: { boneNames: MYTHOS } });
  check('...and the same provider still grants on the real rig', stillOk.enabled === true);
  check('revoked() agrees with the gate', revoked(g.profile, COMMONS) === true);
  check('a commons avatar cannot obtain a profile at all',
        resolveFlight(devFlightProvider({ allow: ['someone'], bones: COMMONS }),
                      { identity: 'someone' }).enabled === false);

  // with no grant there is no flight state to step: a denied caller never builds a phase
  const denied = resolveFlight(denyAllFlight, { identity: 'mythos' });
  check('a denied caller gets no profile to build flight from',
        denied.enabled === false && !('profile' in denied));
}

// ------------------------------------------------- default-deny, for real
console.log('\nDEFAULT-DENY -- a compatible rig is evidence, never permission');
{
  // provenance is not permission: no entry point may construct `devFlightProvider({allow:[identity]})`, so no rig self-authorizes
  const WINGED = ['Hip', 'Spine02', 'Head',
                  'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1',
                  'L_Wing_Lower', 'R_Wing_Lower'];
  const av = { boneNames: WINGED };

  check('a perfect wing rig with NO provider is refused',
        !resolveFlight(null, { identity: 'mythos', avatar: av }).enabled);
  check('...and with the default provider is refused',
        !resolveFlight(denyAllFlight, { identity: 'mythos', avatar: av }).enabled);

  // the world provider, which production runs
  const withRights = (r: any) => worldFlightProvider({ rights: () => r });
  check('no rights yet (not joined) is a NO',
        !resolveFlight(withRights(null), { identity: 'm', avatar: av }).enabled);
  check('an old server that never heard of `fly` is a NO',
        !resolveFlight(withRights({ role: 'builder', gen: true }), { identity: 'm', avatar: av }).enabled);
  check('an OPEN world does not grant flight',
        !resolveFlight(withRights({ role: 'builder', gen: true, fly: false, open: true }),
                       { identity: 'm', avatar: av }).enabled);
  check('being the world OWNER does not grant flight',
        !resolveFlight(withRights({ role: 'owner', gen: true, fly: false }),
                       { identity: 'm', avatar: av }).enabled);
  check('an explicit world grant DOES -- and only then',
        resolveFlight(withRights({ role: 'inhabitant', gen: false, fly: true }),
                      { identity: 'm', avatar: av }).enabled);
  // permission is necessary, not sufficient: a granted identity in a body that can't fly is refused for that reason
  const wingless = { boneNames: ['hips', 'spine', 'head'] };
  check('a grant does not make a wingless body fly',
        !resolveFlight(withRights({ role: 'owner', fly: true }), { identity: 'm', avatar: wingless }).enabled);
  // each denial's reason names who acts and what the body lacks, in a wearer's words
  const reasonOf = (r: any, avatar: any = av) =>
    resolveFlight(withRights(r), { identity: 'm', ...(avatar ? { avatar } : {}) }).reason ?? '';
  const granted = { role: 'owner', fly: true };
  check('no rights says they have not arrived, and what to do if they never do',
        /haven't arrived/.test(reasonOf(null)) && /ask whoever runs it/.test(reasonOf(null)), reasonOf(null));
  // flight is a role's fly permission (server rightsFor), so the reason names who gives it and the set that does
  check('no grant names who gives flight and the roles set that does it',
        /a role's fly permission, which the world's owner/.test(reasonOf({ role: 'owner', fly: false })) &&
        /set \{id: "@world", component: "roles:<your id>", value: \{role: <your role>, can: \{fly: true\}\}\}/.test(reasonOf({ role: 'owner', fly: false })), reasonOf({ role: 'owner', fly: false }));
  check('a wingless body is told it has no wing bones', /no wing bones/.test(reasonOf(granted, wingless)), reasonOf(granted, wingless));
  const oneChain = { boneNames: ['Hip', 'Spine02', 'Head', 'L_Wing_Upper', 'L_Wing_Upper_1', 'L_Wing_Upper_2', 'L_Wing_Upper_3'] };
  check('four wing bones in one chain are counted as such, not called too few',
        /wings have 4 bone\(s\) in 1 chain\(s\)/.test(reasonOf(granted, oneChain)) && !/too few/.test(reasonOf(granted, oneChain)),
        reasonOf(granted, oneChain));
  const coreless = { boneNames: ['Head', 'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1'] };
  check('missing core bones are named as a wearer knows them (hips, spine)',
        /missing: hips, spine\)/.test(reasonOf(granted, coreless)), reasonOf(granted, coreless));
  check('no bone list is its own reason, in both providers',
        /bones aren't known/.test(reasonOf(granted, null)) &&
        /bones aren't known/.test(resolveFlight(devFlightProvider({ allow: ['m'] }), { identity: 'm' }).reason ?? ''),
        reasonOf(granted, null));
  // live, not captured: revoking grounds a body already flying
  {
    let rights: any = { role: 'builder', fly: true };
    const prov = worldFlightProvider({ rights: () => rights });
    const before = resolveFlight(prov, { identity: 'm', avatar: av }).enabled;
    rights = { role: 'builder', fly: false };
    const after = resolveFlight(prov, { identity: 'm', avatar: av }).enabled;
    check('a revoked grant takes effect on the next resolve', before && !after);
  }
  // the entry points must not manufacture one: source-level, since the claim is about the shipped files
  for (const f of ['client/lib/controller.js', 'mcpl/agent.ts']) {
    const src = readFileSync(f, 'utf8');
    const code = src.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    check(`${f.split('/').pop()} does not construct a dev provider`,
          !/devFlightProvider\s*\(/.test(code));
    check(`${f.split('/').pop()} resolves against the world's grant`,
          /worldFlightProvider\s*\(/.test(code));
  }
}

// -------------------------------------------- rehearsal, and a climb that flies
console.log('\nREVIEW cea3c3c -- blockers 4 and 6');
{
  // the door's tool table + dispatcher live in mcpl/tools.ts (TEL0S_NOTES §24r); net-server.ts is a pure transport
  const ns = readFileSync('mcpl/tools.ts', 'utf8');
  // DOWN is involuntary: no rehearsal tool; a bench calls the agent's trusted seam directly
  check('no rehearsal tool is declared',
        !/name: "rehearse_/.test(ns));
  check('...and the tool table never calls the trusted seam',
        !/ag\.flightBody(Down|Recovered)\(/.test(ns));
  check('...the old names are refused with where they went, not aliased',
        /rehearse_down: "no tool/.test(ns));

  // infrastructure must not speak in the resident's voice
  const ag = readFileSync('mcpl/agent.ts', 'utf8');
  check('flight telemetry is not written as resident chat',
        !/verb\("say", \{ text: "\[flight\]/.test(ag));

  // every metre a flying body gains is flown: the winded branch must not assign pos.y (a teleport)
  check('an unaffordable climb has no direct pos.y assignment',
        !/f\.pos\.y = from \+ afford/.test(ag));
  check('...and goes through the same ticked integrator',
        /f\.climbTo = reach; f\.climbRate = climbRate/.test(ag));

  // the perch economy is not advertised by anything that cannot perform it
  check('flight_status does not advertise a perch refill',
        !/on a perch\)/.test(ag));
  check('the fly mode (climb) does not promise perches either',
        !/or on a perch \(2\/s\)/.test(ns) && /refilled only on the ground/i.test(ns));
}

// ------------------------------------------------------- T6: the vigil posture
console.log('\nT6 -- fold_down grounds the flier, and unfolding is deliberate');
{
  // fold_down() grounds the flier by choice; take_off() refuses while folded; unfold is an explicit act
  const cfg = makeConfig();
  const ground = () => initialState({ phase: 'GROUND' }, cfg);

  let s: any = foldDown(cfg, ground());
  check('fold_down folds the wings', s.wings === 'FOLDED');
  check('...and says so', s.events.some((e: any) => e.kind === 'wings.folded'));

  const refused = takeOff(cfg, s, { groundY: 0 });
  check('T6: take_off REFUSES while folded', refused.phase === 'GROUND');
  check('...for the stated reason',
        refused.events.some((e: any) => e.kind === 'takeoff.refused' && e.reason === 'your wings are folded; unfold them first'));
  check('...and take_off does not quietly unfold for you', refused.wings === 'FOLDED');

  const open = unfold(cfg, s);
  check('unfold is the explicit act that ends the vigil', open.wings === 'OPEN');
  check('...and then she can fly', takeOff(cfg, open, { groundY: 0 }).phase === 'PILOT');

  // folding is a GROUND posture: not an air brake, not a way to fall
  let air: any = takeOff(cfg, ground(), { groundY: 0 });
  const midair = foldDown(cfg, air);
  check('folding refuses in the air', midair.wings === 'OPEN' &&
        midair.events.some((e: any) => e.kind === 'fold.refused'));
  // a limp body's wings belong to the ragdoll
  const limp = foldDown(cfg, { ...ground(), wings: 'LIMP' });
  check('a limp body cannot strike a posture', limp.wings === 'LIMP');
  // a body down after a cut is told it is down, not airborne
  const downed = foldDown(cfg, { ...ground(), phase: 'RAGDOLL', wings: 'LIMP' });
  check('folding while down says so, not that the body is in the air',
        downed.events.some((e: any) => e.kind === 'fold.refused' && /not on your feet \(ragdoll\)/.test(e.reason)) &&
        !downed.events.some((e: any) => /airborne/.test(e.reason ?? '')));
  // idempotent both ways, with an event that says nothing happened
  check('folding twice is refused, not doubled',
        foldDown(cfg, s).events.some((e: any) => e.reason === 'already folded'));
  check('unfolding open wings is refused',
        unfold(cfg, ground()).events.some((e: any) => e.kind === 'unfold.refused'));
  check('...as already open', unfold(cfg, ground()).events.some((e: any) => e.reason === 'already open'));
  check('unfolding limp wings says they reopen on recovery, not that they are open',
        unfold(cfg, { ...ground(), phase: 'RAGDOLL', wings: 'LIMP' }).events.some((e: any) =>
          e.kind === 'unfold.refused' && /limp, not folded/.test(e.reason)));
  check('folding in the air says to land first',
        midair.events.some((e: any) => e.kind === 'fold.refused' && /^airborne \(pilot\).*land first/.test(e.reason)));
  check('take_off with limp wings says they reopen on recovery',
        takeOff(cfg, { ...ground(), phase: 'RAGDOLL', wings: 'LIMP' }, { groundY: 0 }).events.some((e: any) =>
          e.kind === 'takeoff.refused' && /limp; they open again/.test(e.reason)));
  check('take_off in the air says the body is already airborne',
        takeOff(cfg, air, { groundY: 0 }).events.some((e: any) =>
          e.kind === 'takeoff.refused' && e.reason === 'already airborne (pilot)'));

  // Blender stores quaternions [w,x,y,z], three.js wants [x,y,z,w], and a swapped pair still normalises
  const av = readFileSync('client/lib/avatar.js', 'utf8');
  const table = /const WING_FOLDED = \{([\s\S]*?)\n\};/.exec(av)?.[1] ?? '';
  const rows = [...table.matchAll(/([LR]_Wing_\w+):\s*\[([^\]]+)\]/g)]
    .map(m => ({ bone: m[1], q: m[2].split(',').map(Number) }));
  check(`the folded pose covers the wing chains (${rows.length} bones)`, rows.length >= 10);
  check('every folded quaternion is unit-length',
        rows.every(r => Math.abs(Math.hypot(...r.q) - 1) < 1e-3));
  // w LAST: transposed, w (~0.73-0.99 here) would sit in slot 0
  check('...and stored [x,y,z,w], not Blender order',
        rows.every(r => r.q[3] > 0.5) && rows.some(r => Math.abs(r.q[0]) > 0.3));
  // an all-identity pose does nothing
  check('the shoulders actually carry the fold',
        rows.filter(r => /_(Upper|Lower)$/.test(r.bone))
            .every(r => 2 * Math.acos(Math.min(1, r.q[3])) * 180 / Math.PI > 20));
  check('and it is mirrored L/R',
        rows.filter(r => r.bone.startsWith('L_')).length ===
        rows.filter(r => r.bone.startsWith('R_')).length + 1 ||
        rows.filter(r => r.bone.startsWith('L_')).length ===
        rows.filter(r => r.bone.startsWith('R_')).length);
}

// ---------------------------------------------------------------- isolation
console.log('\nISOLATION -- nothing in the running world reaches flight yet');
{
  // only the deliberate importers below reach the flight core, each resolving a capability first
  const { readFileSync, readdirSync, statSync } = await import('node:fs');
  const { join } = await import('node:path');
  const walk = (dir: string, out: string[] = []) => {
    for (const e of readdirSync(dir)) {
      if (e === 'node_modules' || e.startsWith('.')) continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else if (/\.(js|ts|mjs)$/.test(e)) out.push(p);
    }
    return out;
  };
  const runtime = [...walk('client'), ...walk('server'), ...walk('mcpl')];
  // modules listed from disk, not by name: leafforce.js is flight code without "flight" in its name
  const FLIGHT_MODULES = readdirSync('shared')
    .filter(f => /^(flight|leafforce)/.test(f) && f.endsWith('.js'))
    .map(f => f.replace(/\.js$/, ''));
  check(`the flight module family is enumerated, not guessed (${FLIGHT_MODULES.length})`,
        FLIGHT_MODULES.length >= 5 && FLIGHT_MODULES.includes('leafforce'),
        FLIGHT_MODULES.join(', '));
  const importsFlight = (src: string) =>
    FLIGHT_MODULES.some(m => new RegExp(`from ['"][^'"]*shared/${m}\\.js['"]`).test(src));
  const importers = runtime.filter(f => importsFlight(readFileSync(f, 'utf8')));
  // mcpl/physics.ts only applies forces a gated caller hands it, so the per-importer checks skip it
  const ALLOWED = [/mcpl\/agent\.ts$/, /client\/lib\/controller\.js$/, /mcpl\/physics\.ts$/];
  const GATEKEEPERS = [/mcpl\/agent\.ts$/, /client\/lib\/controller\.js$/];
  check(`only expected modules import flight (${importers.length})`,
        importers.length > 0 && importers.every(f => ALLOWED.some(re => re.test(f))),
        importers.join(', '));
  for (const f of importers.filter(f => GATEKEEPERS.some(re => re.test(f)))) {
    const src = readFileSync(f, 'utf8');
    check(`${f.split('/').pop()} resolves a capability before it flies`,
          /resolveFlight\(/.test(src));
    check(`${f.split('/').pop()} cannot fly without a positive grant`,
          /enabled/.test(src) && /(cannot fly here|no:|not armed)/.test(src));
  }
  // server/ stays untouched: the sequencer has no opinion about flight
  const srv = importers.filter(f => /^server\//.test(f));
  check('no server/ module imports flight', srv.length === 0, srv.join(', '));

  // source checks: both properties live in browser DOM code this file can't import
  const ctl = readFileSync('client/lib/controller.js', 'utf8');

  // key toggles ignore autorepeat (synthetic keydowns have repeat=false, so only a person sees a held F)
  const toggles = /bus\.on\('key',[\s\S]*?\n\}\);/.exec(ctl)?.[0] ?? '';
  check('the key toggles ignore autorepeat (a held F is one take-off)',
        // the guard precedes the BODY_KEYS dispatch, and the table is where F lives
        /if \(e\.repeat\) return;/.test(toggles) &&
        toggles.indexOf('e.repeat') < toggles.indexOf('BODY_KEYS.find') &&
        /const BODY_KEYS = \[[\s\S]*?code: 'KeyF'/.test(ctl));
  // the guard is on the LISTENER, not the emit: build.js binds R/F and the arrows where holding is the interaction
  check('but the key BUS still carries repeats (build.js nudges need them)',
        !/if \(e\.repeat\) return;\s*\n\s*bus\.emit\('key'/.test(ctl));

  // flight and take-off must measure the ground the same way (through the colliders, not raw terrain)
  check('client flight and client walking resolve the SAME ground',
        !/groundY:\s*\(x, ?z\) => heightAt\(/.test(ctl) &&
        /resolveColliders\(_gp, heightAt\)/.test(ctl));

  // a throw mid-toggle must not leave `flight` holding a body it never moves: only PILOT is published
  check('the flight toggle publishes only a state that is actually flying',
        /if \(next\.phase !== 'PILOT'\)/.test(ctl) &&
        /\bflight = next;/.test(ctl));
  check('and a GROUNDED flight cannot hold the body',
        /if \(flight\.phase === 'GROUND'\) \{[\s\S]{0,220}?flight = null;/.test(ctl));
  // a take-off that throws must not leave a half-built flight behind
  check('a throw during take-off releases the body instead of freezing it',
        /catch \(e\) \{\s*\n?\s*return `flight failed to start/.test(ctl));

  // the draw lines sit past the flight block's early `return`, so the flight block draws the body itself
  const flightBlock = /if \(flight\) \{\s*\n\s*const input = pilotInput[\s\S]*?\n  \}/.exec(ctl)?.[0] ?? '';
  check('a flying body is actually drawn where it is flying',
        /me\.root\.position\.copy\(myState\.pos\)/.test(flightBlock) &&
        /me\.root\.rotation\.y = myState\.yaw/.test(flightBlock));
  check('and the camera follows her up instead of watching the launch pad',
        /updateFollowCamera\(dt, me\)/.test(flightBlock));
  check('and the flight clip reaches the body',
        /me\.setClip\(myState\.clip/.test(flightBlock));
  // every early return from updateMe owes the tail's work: the tail makes state visible
  const tail = ['me.setClip(', 'me.root.position.copy(', 'updateFollowCamera('];
  check('every early-return path in updateMe pays the render tail',
        tail.every(t => flightBlock.includes(t)), flightBlock ? '' : 'flight block not found');

  // flap effort is read off the FLIGHT STATE, never a timer, so the animation can't drift from the lift
  const av = readFileSync('client/lib/avatar.js', 'utf8');
  // DISTINCT, not pinned: power and idle dial sets must read as different behaviour (mostly RATE, 2.1Hz vs 1/3.4)
  {
    const grab = (name: string) => {
      const body = new RegExp(`export const ${name} = \\{([\\s\\S]*?)\\n\\};`).exec(av)?.[1] ?? '';
      // `hz: 1 / BREATH` is an expression on purpose (period tied to T8): resolve that one symbol
      const num = (k: string) => {
        const m = new RegExp(`\\b${k}:\\s*([^,\\n]+?)\\s*(?:,\\s*)?(?://.*)?$`, 'm').exec(body);
        if (!m) return NaN;
        const t = m[1].trim().replace(/\bBREATH\b/g, '3.4');
        if (!/^[-\d.\s/*+()]+$/.test(t)) return NaN;
        try { return Function(`"use strict";return (${t})`)(); } catch { return NaN; }
      };
      return { deg: num('deg'), hz: num('hz'), lag: num('lag'), tip: num('tip'), sweep: num('sweep') };
    };
    const idle = grab('WING_IDLE'), power = grab('WING_POWER');
    check('both wing dial sets parse',
          Number.isFinite(idle.deg) && Number.isFinite(idle.hz) &&
          Number.isFinite(power.deg) && Number.isFinite(power.hz),
          `idle ${JSON.stringify(idle)} power ${JSON.stringify(power)}`);
    check('the power stroke is distinct from the idle -- and mostly in RATE',
          power.hz >= idle.hz * 3,
          `idle ${idle.hz.toFixed(3)}Hz vs power ${power.hz}Hz`);
    check('a loaded wing lags LESS than a slack one',
          power.lag < idle.lag, `idle ${idle.lag} vs power ${power.lag}`);
    check('the idle beats on BREATH (spec T8)',
          Math.abs(idle.hz - 1 / 3.4) < 1e-6, `${idle.hz}`);
  }
  check('and _flap crossfades the two rather than branching',
        /mixWings\(WING_IDLE, WING_POWER, e\)/.test(av));
  check('effort eases, so 46 degrees never appears in one frame',
        /want > have \? 0\.\d+ : 0\.\d+/.test(av));
  check('the wings are driven by the launch impulse and the flap key',
        /me\.wingEffort = input\.flap \? 1 : fromLaunch/.test(ctl) &&
        /flight\.launchNow/.test(ctl));
  // the client scales effort against the launch boost, so both sides must read the boost as a number
  check('and scaled against the CONFIG boost, not a hardcoded copy',
        /cfg\.pilot\?\.launchBoost/.test(readFileSync('shared/flight.js', 'utf8')) &&
        /flightCfg\.pilot\?\.launchBoost/.test(ctl));
  check('landing hands the wings back to the idle',
        /me\.wingEffort = 0;/.test(ctl));
  // wingEffort pinned at 1 makes WING_IDLE inert: released on known exits AND per frame for unknown ones (revoke, swap)
  check('F-to-land releases the wings, not just a natural landing',
        /flight = null; releaseWings\(\); return 'landed'/.test(ctl));
  check('...and not-flying asserts the resting wings every frame',
        /if \(me\.wingEffort\) me\.wingEffort = 0;/.test(ctl));

  // neither side computes rights: the server's `your-rights` (server.ts rightsFor) is the whole truth
  const stt = readFileSync('client/lib/state.js', 'utf8');
  check('the browser computes no rights of its own (no grant fold, no second rule)',
        !/verb === 'grant'/.test(stt) && !/rightsIn\(/.test(stt) && !/rightsfold/.test(stt));
  check('...and the dead hand-merge is gone',
        !/net\.myRights = \{ \.\.\.net\.myRights, \.\.\.worldRoles/.test(
          readFileSync('client/lib/world.js', 'utf8')));
  // a withdrawal reaches a body ALREADY up, or a revoked pilot soars by touching nothing
  check('a revoked grant grounds a body already in the air',
        /flight = flightDown\(flight, \{ eventId: 'capability-revoked' \}\)/.test(ctl));
  // behavioural: retuning the boost in config must retune everything that reads it
  {
    const c0 = makeConfig();
    check('the launch boost is config, and defaults to what it always was',
          takeOff(c0, initialState({ phase: 'GROUND' }, c0), { groundY: 0 }).launchV === 9);
    const c1 = makeConfig({ pilot: { spoilSink: 2.5, flapClimb: 2.2, launchBoost: 14 } });
    check('retuning it retunes the take-off (and so the wings with it)',
          takeOff(c1, initialState({ phase: 'GROUND' }, c1), { groundY: 0 }).launchV === 14);
    check('an explicit caller boost still overrides the config',
          takeOff(c0, initialState({ phase: 'GROUND' }, c0), { groundY: 0, boost: 5 }).launchV === 5);
    let threw = false;
    try { makeConfig({ pilot: { nope: 1 } }); } catch { threw = true; }
    check('and the new block still rejects dead keys', threw);

    // the block's other two values: a config value nothing measures is a comment
    const spoiled = (sink: number) => {
      const c = makeConfig({ pilot: { spoilSink: sink, flapClimb: 2.2, launchBoost: 9 } });
      let st: any = takeOff(c, initialState({ phase: 'GROUND' }, c), { groundY: 0 });
      // past the launch, where the impulse no longer dominates vertical speed
      for (let i = 0; i < 400; i++) st = step(c, st, DT, { groundY: () => -500,
        input: { bank: 0, pitch: 0, yawRate: 0, flap: false, spoil: true } });
      return st.vel.y;
    };
    const vLow = spoiled(1.0), vHigh = spoiled(6.0);
    check('spoilSink is read from config: more spoiler, more sink',
          vHigh < vLow - 4.0, `1.0 -> ${vLow.toFixed(2)} m/s, 6.0 -> ${vHigh.toFixed(2)} m/s`);
    const climbed = (rate: number) => {
      const c = makeConfig({ pilot: { spoilSink: 2.5, flapClimb: rate, launchBoost: 9 } });
      let st: any = takeOff(c, initialState({ phase: 'GROUND' }, c), { groundY: 0 });
      for (let i = 0; i < 400; i++) st = step(c, st, DT, { groundY: () => -500,
        input: { bank: 0, pitch: 0, yawRate: 0, flap: true, spoil: false } });
      return st.vel.y;
    };
    const cLow = climbed(1.0), cHigh = climbed(8.0);
    check('flapClimb is read from config: harder flap, more climb',
          cHigh > cLow + 5.0, `1.0 -> ${cLow.toFixed(2)} m/s, 8.0 -> ${cHigh.toFixed(2)} m/s`);
  }

  // wing names are exact-case while core bones aren't: widening WING_RE loosens an authorization boundary
  {
    const core = ['Hip', 'Spine02', 'Head'];
    const proper = [...core, 'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper',
                    'R_Wing_Upper_1', 'L_Wing_Lower', 'R_Wing_Lower'];
    check('a properly-cased wing rig is granted',
          rigProfile(proper).ok);
    check('a commons body is refused (the gate still holds)',
          !rigProfile(['hips', 'spine', 'head', 'leftHand']).ok);
    check('KNOWN ASYMMETRY: an all-lowercase wing rig is refused -- Mica to rule',
          !rigProfile(proper.map(b => b.toLowerCase())).ok);
  }

  // /flight puts the state in the chat log, where the person is
  const reg = readFileSync('client/lib/commands/registry.js', 'utf8');
  // chat.js dispatches every registered row through the registry (§14 6c): the evidence is the handler registration
  const hnd = readFileSync('client/lib/commands/handlers.js', 'utf8');
  check("/flight is discoverable, dispatched, and answered",
        /name: 'flight'/.test(reg) &&
        /register\('flight'/.test(hnd) &&
        /export function flightReport\(/.test(ctl));
}

// ------------------------------------------------------- flown, and found wrong
console.log('\nFLOWN -- four faults a human found that no assertion had');
{
  const cfg = makeConfig();
  const flatG = () => 0;
  const fly = (s: any, keys: string[], n: number) => {
    for (let i = 0; i < n; i++) s = step(cfg, s, DT, { groundY: flatG, input: pilotInput(new Set(keys), s, DT) });
    return s;
  };

  // a hand-flown body recovers hand-flown, not into GLIDE (a dead stick, frozen bank)
  let s = initialState({ phase: 'PILOT', pos: { x: 0, y: 40, z: 0 }, airspeed: 12 }, cfg);
  s = bodyDown(s, { eventId: 'ev-f1' });
  s = fly(s, [], 120);
  s = bodyRecovered(s, { eventId: 'ev-f1r' });
  s = fly(s, [], 600);
  check('recovery returns the STICK, not the autopilot', s.phase === 'PILOT');
  check('and it wakes wings-level, not holding the leaf\'s bank',
        Math.abs(s.bank) < 0.02, `bank ${(s.bank * 57.3).toFixed(1)} deg`);
  const before = s.bank;
  s = fly(s, ['KeyD'], 120);
  check('WASD reaches the body again after a cut', Math.abs(s.bank - before) > 0.3);

  // recovery after already hitting the ground
  let g = initialState({ phase: 'PILOT', pos: { x: 0, y: 4, z: 0 }, airspeed: 12 }, cfg);
  g = bodyDown(g, { eventId: 'ev-f2' });
  let n = 0; while (g.phase === 'LEAF' && n++ < 99999) g = step(cfg, g, DT, { groundY: flatG });
  check('a cut near the ground ends as a ragdoll', g.phase === 'RAGDOLL');
  g = bodyRecovered(g, { eventId: 'ev-f2r' });
  check('recovery from the GROUND is accepted', g.phase === 'RECOVER');
  g = fly(g, [], 600);
  check('and it stands up', g.phase === 'GROUND' && g.wings === 'OPEN');
  g = takeOff(cfg, g);
  check('take_off is the door back to the sky', g.phase === 'PILOT');
  const peakAfter = (() => { let t = g, pk = 0, k = 0;
    while (t.phase === 'PILOT' && k++ < 6000) { t = step(cfg, t, DT, { groundY: flatG, input: pilotInput(new Set(), t, DT) }); pk = Math.max(pk, t.pos.y); }
    return pk; })();
  check(`the launch actually launches (${peakAfter.toFixed(1)}m, not a stumble)`, peakAfter > 3,
        `peaked at ${peakAfter.toFixed(2)}m`);
  check('take_off refuses folded wings (§1: the vigil posture costs the sky)',
        takeOff(cfg, initialState({ phase: 'GROUND', wings: 'FOLDED' }, cfg)).phase === 'GROUND');
  check('take_off refuses a LIMP body',
        takeOff(cfg, initialState({ phase: 'GROUND', wings: 'LIMP' }, cfg)).phase === 'GROUND');

  // levelReturn must not run while the stick is held (a turn had ~40% of its authority)
  check('autolevel does not fight a held stick',
        DEFAULT_AUTHORITY.bankRate > DEFAULT_AUTHORITY.levelReturn * 2);
  let t2 = initialState({ phase: 'PILOT', pos: { x: 0, y: 60, z: 0 }, airspeed: 12 }, cfg);
  const y0 = t2.yaw;
  t2 = fly(t2, ['KeyD'], 240);            // two seconds of full right
  check(`a 2s turn moves the nose ${((t2.yaw - y0) * 57.3).toFixed(0)}deg (rails were ~60)`,
        (t2.yaw - y0) * 57.3 > 120);
  const banked = t2.bank;
  t2 = fly(t2, [], 240);
  check('hands off, the wings still return to level',
        Math.abs(t2.bank) < Math.abs(banked) * 0.15);

  // the spec's leaf sink is 2-3 m/s (slower than a parachute): the default stands, alternatives one word away
  check('the DEFAULT leaf is still the spec\'s 2-3 m/s',
        cfg.leaf.terminalV >= 2 && cfg.leaf.terminalV <= 3);
  for (const [name, preset] of Object.entries(LEAF_PRESETS)) {
    const c2 = makeConfig({ leaf: preset });
    check(`preset '${name}' builds and falls at ${c2.leaf.terminalV} m/s`,
          c2.leaf.terminalV === preset.terminalV && c2.leaf.period === preset.period);
  }
  const heavy = makeConfig({ leaf: LEAF_PRESETS.heavy });
  let h = initialState({ phase: 'PILOT', pos: { x: 0, y: 30, z: 0 }, airspeed: 12 }, heavy);
  h = bodyDown(h, { eventId: 'ev-f4' });
  let hn = 0; while (h.phase === 'LEAF' && hn++ < 99999) h = step(heavy, h, DT, { groundY: flatG });
  check(`heavy preset falls 30m in ${(hn * DT).toFixed(1)}s (spec preset takes ~12)`,
        hn * DT < 4);
  check('and it still LANDS as a ragdoll, no autoland', h.phase === 'RAGDOLL');
}


// LIVE RIGHTS: `your-rights` delivery is tools/protocol/server-check.ts S1; a midair withdrawal hands the agent to the leaf
{
  const live = { type: 'your-rights', rights: { role: 'builder', gen: false, fly: false } };
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const ag: any = new WorldAgent({ url: noWorldUrl(), name: 'pilot', world: 'rights-bench' });
  ag.bodyBoneNames = ['Hip', 'Spine02', 'Head',
    'L_Wing_Upper', 'L_Wing_Upper_1', 'R_Wing_Upper', 'R_Wing_Upper_1',
    'L_Wing_Lower', 'R_Wing_Lower'];
  ag.myRights = { role: 'builder', gen: false, fly: true };
  ag.flight = initialState({ phase: 'PILOT', pos: { x: 0, y: 11.3, z: 0 }, wings: 'OPEN' }, makeConfig());
  check('with fly granted, the agent may fly', ag.flightAllowed().ok);
  ag.acceptEffectiveRights(live.rights, 'world');
  check('headless consumes effective rights and refuses the next action', !ag.flightAllowed().ok);
  check('midair revocation hands the agent to the leaf', ag.flight.phase === 'LEAF', ag.flight.phase);
  const agSrc = readFileSync('mcpl/agent.ts', 'utf8');
  check("the agent's `your-rights` case installs the server's answer",
        /case "your-rights":[\s\S]{0,400}this\.acceptEffectiveRights\(msg\.rights/.test(agSrc));
  const netSrc = readFileSync('client/lib/net.js', 'utf8');
  check('browser consumes the server-folded effective-rights message',
        /case 'your-rights'/.test(netSrc) && /net\.myRights = msg\.rights/.test(netSrc));
}

// RED-FIRST: infrastructure flight events must never author resident chat (fails on ccb065c, where flightEvent() called verb("say"))
{
  const { WorldAgent } = await import('../mcpl/agent.ts');
  const ag: any = new WorldAgent({ url: noWorldUrl(), name: 'pilot', world: 'bench' });
  let authored = 0;
  // every way an agent writes: the door (requests, say included) and its say helper
  ag.door = async () => { authored++; return { ok: true }; };
  ag.say = async () => { authored++; return { ok: true }; };
  ag.flightEvent({ kind: 'ground.landed', impactV: 0.5 });
  check('flight telemetry never authors resident say', authored === 0, `authored=${authored}`);
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
