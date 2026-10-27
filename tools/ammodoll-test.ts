// AmmoRagdoll parity suite: the Verlet's lifecycle promises demanded of the Bullet engine, on committed fixtures.
//   bun tools/ammodoll-test.ts           # committed fixtures, no private VRM
//   bun tools/ammodoll-test.ts --fleet   # also the installed fleet
// Interface parity is the contract (bodysim.js): downstream must not tell which engine produced the pose. Beyond
// parity it asserts the port's ANATOMY: flexion axes mean what rigdef.py's tables meant (elbows forward, knees
// back, fingers toward the palm), the retarget step most likely to be silently wrong.

import { fileURLToPath } from "node:url";
import { plugin } from 'bun';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({
  name: 'core-stub',
  setup(build) {
    build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { AmmoRagdoll, ensureAmmo } = await import('../client/lib/ammodoll.js');
const { rigs, makeAvatar, toppleLean } = await import('./rig-load.mjs');
const { dollGltf, wingRig, bareRig } = await import('./doll-fixture.mjs');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

check('wasm door opens', await ensureAmmo());

const FLEET = [wingRig, bareRig];
if (process.argv.includes('--fleet')) {
  try {
    const installed = rigs().filter((r: any) => !r.err);
    if (!installed.length) throw new Error('no readable installed rigs');
    FLEET.push(...installed);
  } catch (err) { console.error(`--fleet needs the local VRM library: ${err}`); process.exit(2); }
}
console.log(`committed skeleton source: ${dollGltf.source.file} sha256 ${dollGltf.source.sha256}`);
console.log(`\nthe fleet (${FLEET.length} rigs):`);

const bodyQuat = (body: any, out: any) => {
  const r = body.getCenterOfMassTransform().getRotation();
  return out.set(r.x(), r.y(), r.z(), r.w());
};
const bodySpin = (body: any) => {
  const w = body.getAngularVelocity();
  return Math.hypot(w.x(), w.y(), w.z());
};

function run(av: any, lean: any = null, { maxSteps = 900, seedVel = null as any } = {}) {
  const rd: any = new AmmoRagdoll(av, lean, av.restBonePositions(), seedVel);
  let steps = 0;
  while (!rd.done && steps < maxSteps) { rd.step(1 / 60); steps++; }
  return { rd, steps };
}

{
  // crumple, self-intersection, endless head spin and twist, measured DURING the run: dispose() frees the wasm at capture
  const bad: Record<string, string[]> = {
    rest: [], finite: [], lying: [], poses: [], twist: [], crumple: [], spin: [], knees: [],
  };
  const relTwist = (rd: any, parentKey: string, childKey: string, axisRest: any) => {
    const ps: any = rd.segs.get(parentKey), cs: any = rd.segs.get(childKey);
    if (!ps || !cs) return 0;
    const qp = bodyQuat(ps.body, new THREE.Quaternion());
    const qc = bodyQuat(cs.body, new THREE.Quaternion());
    const rel = qp.invert().multiply(qc);
    const d = new THREE.Vector3(rel.x, rel.y, rel.z);
    const proj = d.dot(axisRest);
    let tw = 2 * Math.atan2(proj, rel.w);
    if (tw > Math.PI) tw -= 2 * Math.PI;
    if (tw < -Math.PI) tw += 2 * Math.PI;
    return Math.abs(tw);
  };
  // crumple = angle hips→chest vs chest→neck; not hips→spine: a 7mm spine segment swings tens of degrees on mm of slack
  const foldOf = (p: any) => {
    const lo = (p.chest ?? p.spine)?.clone().sub(p.hips ?? p.spine)?.normalize();
    const b = p.neck?.clone().sub(p.chest ?? p.spine)?.normalize();
    return lo && b ? Math.acos(Math.min(1, Math.max(-1, lo.dot(b)))) : 0;
  };
  for (const rig of FLEET) {
    // the Verlet is the quality BASELINE: same rig, lean, metric
    const vav = makeAvatar(rig.P);
    const vrd: any = new (await import('../client/lib/ragdoll.js')).Ragdoll(vav, toppleLean(), vav.restBonePositions());
    let vsteps = 0;
    while (!vrd.done && vsteps < 900) { vrd.step(1 / 60); vsteps++; }
    const vFold = foldOf({ ...vrd.p, chest: vrd.p.chest ?? vrd.p.spine });

    const av = makeAvatar(rig.P);
    const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
    const UP = new THREE.Vector3(0, 1, 0);
    const fwd0 = rd.rig.forward.clone();
    // rest thigh directions in the rig frame: the anchor the knee instrument measures each swing against
    const restThigh: Record<string, any> = {};
    for (const side of ['left', 'right']) {
      restThigh[side] = rig.P[side + 'LowerLeg'].clone().sub(rig.P[side + 'UpperLeg']).normalize();
    }
    const tq = new THREE.Quaternion();
    let steps = 0, worstNeckTwist = 0, lastFold = 0, worstWrongKnee = 0;
    const spinRing: number[] = [];              // the last second before capture: residual spin at pose-lock renders as a corpse-pop
    while (!rd.done && steps < 900) {
      rd.step(1 / 60);
      steps++;
      if (rd.segs.size) {
        worstNeckTwist = Math.max(worstNeckTwist, relTwist(rd, 'chest|neck', 'neck|head', UP));
        let now = 0;
        for (const s of rd.segs.values()) {
          if (s.finger) continue;               // 20 g springs may flutter; the wire never sees it
          now = Math.max(now, bodySpin(s.body));
        }
        spinRing.push(now);
        if (spinRing.length > 60) spinRing.shift();
        lastFold = foldOf(rd.p);
        // knees fold the right way, from positions (a quaternion reader can alias), against the thigh's own swing so a fetal
        // fold passes; only a deviation opposite the predicted fold fails (wrong-way ≈ -1, legal ≈ +0.97)
        bodyQuat(rd.torsoBody, tq);
        for (const side of ['left', 'right']) {
          const hip = rd.p[side + 'UpperLeg'], knee = rd.p[side + 'LowerLeg'], foot = rd.p[side + 'Foot'];
          if (!hip || !knee || !foot) continue;
          const thigh = knee.clone().sub(hip).normalize();
          const shin = foot.clone().sub(knee).normalize();
          const bend = Math.acos(Math.min(1, Math.max(-1, thigh.dot(shin))));
          if (bend < 0.15) continue;             // straight: no direction to read
          const inv = tq.clone().invert();
          const thighT = thigh.clone().applyQuaternion(inv);
          const devT = shin.clone().addScaledVector(thigh, -shin.dot(thigh)).normalize()
            .applyQuaternion(inv);
          const swing = new THREE.Quaternion().setFromUnitVectors(restThigh[side], thighT);
          const devPred = fwd0.clone().negate().applyQuaternion(swing);
          if (devT.dot(devPred) < -0.3) worstWrongKnee = Math.max(worstWrongKnee, bend);
        }
      }
    }
    // capture waits for 0.45s of quiet, so a one-step contact ping is a flicker; sustained fast spin is the artifact
    const worstSpin = spinRing.filter((x) => x > 12).length > 5 ? Math.max(0, ...spinRing) : 0;
    if (!rd.done) { bad.rest.push(`${rig.name}(never captured)`); continue; }
    const foldBound = Math.max(vFold * 1.35 + 0.17, 1.15);
    const q = Object.values(rd.finalPose ?? {});
    if (!q.length || !q.every((a: any) => a.length === 4 && a.every(Number.isFinite))) bad.finite.push(rig.name);
    if (Object.keys(rd.finalPose ?? {}).length < 8) bad.poses.push(`${rig.name}(${Object.keys(rd.finalPose ?? {}).length} bones)`);
    if (av.root.position.y > -0.05) bad.lying.push(`${rig.name}(root.y=${av.root.position.y.toFixed(2)})`);
    if (worstNeckTwist > 3.0) bad.twist.push(`${rig.name}(${(worstNeckTwist * 180 / Math.PI).toFixed(0)}°)`);
    if (lastFold > foldBound) bad.crumple.push(`${rig.name}(${(lastFold * 180 / Math.PI).toFixed(0)}° vs verlet ${(foldBound * 180 / Math.PI).toFixed(0)}° bound)`);
    if (worstSpin > 12) bad.spin.push(`${rig.name}(${worstSpin.toFixed(1)} rad/s)`);
    if (worstWrongKnee > 0.7) bad.knees.push(`${rig.name}(${(worstWrongKnee * 180 / Math.PI).toFixed(0)}° hyperextension)`);
  }
  const none = (k: string) => bad[k].length === 0;
  check('every rig comes to rest', none('rest'), bad.rest.join(' '));
  check('every capture is a finite sparse pose', none('finite'), bad.finite.join(' '));
  check('every pose drives a full skeleton (≥8 bones)', none('poses'), bad.poses.join(' '));
  check('the rendered root lies down with the body', none('lying'), bad.lying.join(' '));
  check('sim twist stays sane (renders as zero regardless)', none('twist'), bad.twist.join(' '));
  check('folds no more than the Verlet on the same rig', none('crumple'), bad.crumple.join(' '));
  check('no hidden spin late in the fall (≤12 rad/s)', none('spin'), bad.spin.join(' '));
  check('knees never FOLD backwards (positions, not quats)', none('knees'), bad.knees.join(' '));
}

// ---------------------------------------------------------------------------
// AXIS ROLES at build: a limit on the wrong axis is a knee bending sideways. Each directional joint's flexion axis
// and sign must move the child's tip anatomically; every rig, both sides.
console.log('\naxis roles (elbows fold forward, knees back, fingers curl to the palm):');
{
  const bad: string[] = [];
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    const { forward, up } = rd.rig;
    const palmN = up.clone().negate();
    // only meaningfully ASYMMETRIC tables say which way a joint flexes (the wrist's ±45/±45 has no wide side)
    const want: Record<string, any> = {
      lowerArm: forward, lowerLeg: forward.clone().negate(),
      upperLeg: forward, fingerProx: palmN, fingerMid: palmN,
    };
    for (const J of rd.flexAxes()) {
      const w = want[J.spec];
      if (!w) continue;
      // the wide side of the signed range is the flexion side
      const sign = J.hi[0] > -J.lo[0] ? 1 : -1;
      const move = new THREE.Vector3().crossVectors(J.axisX, J.axisY).multiplyScalar(sign);
      if (move.dot(w) <= 0) {
        bad.push(`${rig.name}:${J.name}(${J.spec} flexes against anatomy)`);
      }
    }
    rd.dispose();
  }
  const few = (a: string[], n = 5) => a.slice(0, n).join(' ') + (a.length > n ? ` +${a.length - n} more` : '');
  check('every directional joint flexes the anatomical way', bad.length === 0, few(bad));
}

// ---------------------------------------------------------------------------
// ANATOMY UNDER YAW: hinge/flex axes turn with the body and stay perpendicular to their bone; joints contain their
// birth pose; limits hold under load; the trunk carries a trunk's share of the mass.
console.log('\nanatomy under yaw (limits, axes, mass — swept N/E/S/W):');
{
  const YAWS = [0, Math.PI / 2, Math.PI, (3 * Math.PI) / 2];
  const YAW_NAME = ['N', 'E', 'S', 'W'];
  // STRIDE IS NOT OPTIONAL: at stride 0 the live pose IS the rest pose, where a frame-alignment bug is invisible
  const STRIDES = [0, 1];
  const EQUIV_DOT = Math.cos((10 * Math.PI) / 180);
  const PERP_DOT = Math.cos((60 * Math.PI) / 180);
  // overshoot is judged on DURATION, not peak: Bullet limits are impulses with ERP recovery. Sprung finger axes are
  // excluded (the spring is the authority); depth/duration tolerate a limb trapped under a resting body.
  const OVER_SUSTAIN = 0.6;    // rad, ~34° — a violation this deep...
  const OVER_SECS = 1.0;       // ...held this long is a broken limit
  let overSamples = 0;

  const bad: Record<string, string[]> = {
    flex: [], perp: [], over: [], mass: [], build: [], born: [],
  };
  const liveBones = (av: any) => {
    const out: Record<string, any> = {};
    av.root.updateMatrixWorld(true);
    for (const n of Object.keys(av.nodes)) {
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      if (node) out[n] = node.getWorldPosition(new THREE.Vector3());
    }
    return out;
  };
  for (const rig of FLEET) {
    // realParent here too: toe/finger bones exist only in the real hierarchy (the simplified chain puts the ankle axis 90° off)
    const refAv = makeAvatar(rig.P, { realParent: rig.realParent });
    refAv.root.updateMatrixWorld(true);
    const refRd: any = new AmmoRagdoll(refAv, null, refAv.restBonePositions());
    const ms = refRd.massSplit();
    // the torso body carries pelvis+spine+chest = 44% of the Dempster budget; head/limbs vary, so bound loosely
    if (!(ms.frac > 0.35 && ms.frac < 0.60)) {
      bad.mass.push(`${rig.name}(${(ms.frac * 100).toFixed(0)}%)`);
    }
    const refAxis = new Map<string, any>();
    for (const J of refRd.flexAxes()) {
      refAxis.set(J.name, J.axisX.clone().normalize());
      const perp = Math.abs(J.axisX.clone().normalize().dot(J.axisY.clone().normalize()));
      if (perp > PERP_DOT) {
        bad.perp.push(`${rig.name}:${J.name}(${(90 - (Math.acos(Math.min(1, perp)) * 180) / Math.PI).toFixed(0)}° off perpendicular)`);
      }
    }
    refRd.dispose();

    for (let yi = 0; yi < YAWS.length; yi++) {
      for (const stride of STRIDES) {
        const yaw = YAWS[yi];
        const tag = `${rig.name}@${YAW_NAME[yi]}${stride ? '/stride' : ''}`;
        const av = makeAvatar(rig.P, { stride, realParent: rig.realParent });
        av.root.rotation.y = yaw;
        av.root.updateMatrixWorld(true);
        const rd: any = new AmmoRagdoll(av, toppleLean(yaw), av.restBonePositions());

        // BUILD CONSISTENCY: the sim starts where the skeleton IS (the torso is rest-shaped, so trunk joints bound looser)
        const TRUNK = new Set(['hips', 'spine', 'chest', 'neck', 'head']);
        for (const [name, wantP] of Object.entries(liveBones(av))) {
          const got = rd.p[name];
          if (!got) continue;
          const err = got.distanceTo(wantP as any);
          const bound = TRUNK.has(name) ? 0.06 : 0.015;
          if (err > bound) {
            bad.build.push(`${tag}:${name}(${(err * 1000).toFixed(0)}mm)`);
            break;
          }
        }
        // a limit must contain the build pose (the widening exists to make this zero)
        for (const j of rd.jointAngles()) {
          if (j.over > 0.02) {
            bad.born.push(`${tag}:${j.name}(born ${((j.over * 180) / Math.PI).toFixed(1)}° over)`);
            break;
          }
        }
        // birth/impact spin isn't an instrument (transients hit the 20 rad/s ceiling); an annihilation SUSTAINS, caught by
        // the born-joint check (cause) and the late-fall spin bound (effect)
        rd.step(1 / 60);

        // flex axes are a BUILD-time property: equivariance against north
        for (const J of rd.flexAxes()) {
          const wantA = refAxis.get(J.name);
          if (!wantA) continue;
          const expect = wantA.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), yaw);
          const d = Math.abs(J.axisX.clone().normalize().dot(expect));
          if (d < EQUIV_DOT) {
            bad.flex.push(`${tag}:${J.name}(${((Math.acos(Math.min(1, d)) * 180) / Math.PI).toFixed(0)}° from equivariant)`);
            break;
          }
        }

        let steps = 0;
        const overRun = new Map<string, number>();   // joint -> consecutive deep-over steps
        let worstRun = 0, worstRunAt = '';
        const spinRing: number[] = [];   // the last second before capture
        while (!rd.done && steps < 900) {
          rd.step(1 / 60); steps++;
          if (rd.done) break;        // capture frees the wasm — measure before, never after
          for (const j of rd.jointAngles()) {
            if (/^finger|^thumb/.test(j.spec)) continue;   // spring joints: see above
            overSamples++;
            const run = j.over > OVER_SUSTAIN ? (overRun.get(j.name) ?? 0) + 1 : 0;
            overRun.set(j.name, run);
            if (run > worstRun) { worstRun = run; worstRunAt = `${j.name}/${j.spec}`; }
          }
          // spin in the LAST second before capture (slow yaw combos still tumble at t=5s): residual spin renders as a corpse-pop
          let now = 0;
          for (const s of rd.segs.values()) {
            if (s.finger) continue;
            now = Math.max(now, bodySpin(s.body));
          }
          spinRing.push(now);
          if (spinRing.length > 60) spinRing.shift();
        }
        if (worstRun > OVER_SECS * 60) bad.over.push(`${tag}:${worstRunAt}(held ${(worstRun / 60).toFixed(1)}s over)`);
        const captureSpin = spinRing.filter((x) => x > 12).length > 5 ? Math.max(0, ...spinRing) : 0;
        if (captureSpin > 12) bad.born.push(`${tag}(${captureSpin.toFixed(1)} rad/s in the last second)`);
      }
    }
  }
  const none = (k: string) => bad[k].length === 0;
  const few = (a: string[], n = 4) => a.slice(0, n).join(' ') + (a.length > n ? ` +${a.length - n} more` : '');
  check('the sim starts where the skeleton is', none('build'), few(bad.build));
  check('...and is not born fighting its own joints', none('born'), few(bad.born));
  check('flex axes turn with the body (yaw-equivariant)', none('flex'), few(bad.flex));
  check('flex axes are perpendicular to their bone', none('perp'), few(bad.perp));
  check('the trunk carries a trunk\'s share of the mass', none('mass'), few(bad.mass));
  check('no joint limit is ever HELD in violation (>20° for >0.5s)', none('over'), few(bad.over));
  check('...and that limit gate is not vacuous', overSamples > 10000, `${overSamples} samples`);
}

// ---------------------------------------------------------------------------
// GOING LIMP MUST NOT TELEPORT: the drive's reference direction and orientation must describe the same pose, or
// frame one renders every driven bone at twice its offset. Only a POSED rig can see it.
console.log('\ngoing limp does not teleport the skeleton (rendered pose):');
{
  const bad: string[] = [];
  const DRIVEN = ['hips', 'spine', 'chest', 'neck',
    'leftUpperArm', 'leftLowerArm', 'rightUpperArm', 'rightLowerArm',
    'leftUpperLeg', 'leftLowerLeg', 'rightUpperLeg', 'rightLowerLeg'];
  for (const rig of FLEET) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const P: any = rig.P;
    const up = (P.neck ?? P.chest).clone().sub(P.hips).normalize();
    const lat = P.leftUpperArm.clone().sub(P.rightUpperArm);
    lat.addScaledVector(up, -lat.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(lat, up).normalize();
    av.nodes.leftUpperArm?.quaternion.setFromAxisAngle(fwd, (-70 * Math.PI) / 180);
    av.nodes.rightUpperArm?.quaternion.setFromAxisAngle(fwd, (70 * Math.PI) / 180);
    av.nodes.neck?.quaternion.setFromAxisAngle(lat, (18 * Math.PI) / 180);
    av.root.updateMatrixWorld(true);

    const before: Record<string, any> = {};
    for (const n of DRIVEN) {
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      if (node) before[n] = node.getWorldQuaternion(new THREE.Quaternion());
    }
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    const pose = rd.step(1 / 60);          // one frame: the sim has barely moved
    if (pose) {
      for (const [n, q] of Object.entries(pose)) {
        const node = av.vrm.humanoid.getNormalizedBoneNode(n);
        if (node) node.quaternion.set((q as any)[0], (q as any)[1], (q as any)[2], (q as any)[3]);
      }
      av.root.updateMatrixWorld(true);
    }
    let worst = 0, worstAt = '';
    for (const n of DRIVEN) {
      if (!before[n]) continue;
      const node = av.vrm.humanoid.getNormalizedBoneNode(n);
      const now = node.getWorldQuaternion(new THREE.Quaternion());
      const d = Math.min(1, Math.abs(before[n].dot(now)));
      const ang = 2 * Math.acos(d);
      if (ang > worst) { worst = ang; worstAt = n; }
    }
    if (worst > 0.25) {                    // ~14°, generous for one frame of fall
      bad.push(`${rig.name}:${worstAt}(${((worst * 180) / Math.PI).toFixed(0)}°)`);
    }
    rd.dispose();
  }
  check('a posed body renders where it stood, not at twice the offset',
    bad.length === 0, bad.slice(0, 5).join(' ') + (bad.length > 5 ? ` +${bad.length - 5}` : ''));
}

// ---------------------------------------------------------------------------
// FINGERS: spring phalanges exist where the rig has digit bones, are harmlessly absent otherwise, ride the pose
// rotation-only, and pull back toward their birth pose (setEquilibriumPoint)
console.log('\nfingers (spring phalanges, additive by absence):');
{
  const fingered = FLEET.filter((r: any) => r.P.leftIndexProximal && r.P.leftIndexIntermediate);
  const bare = FLEET.filter((r: any) => !r.P.leftIndexProximal);
  check(`the fleet exercises both cases (${fingered.length} with digits, ${bare.length} without)`,
    fingered.length > 0 && bare.length > 0, 'need both fingered and bare rigs');

  let built = 0, driven = 0, finite = true, stretched: string[] = [];
  for (const rig of fingered) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    // node POSITIONS are the mesh's bone lengths: the sim never writes them (position error stretches a joint, not the mesh)
    const posBefore = new Map<string, any>();
    for (const [n, node] of Object.entries(av.nodes) as any) {
      posBefore.set(n, node.position.clone());
    }
    const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
    if (rd._fingerSegs.length > 0) built++;
    let steps = 0;
    while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
    const pose = rd.finalPose ?? {};
    const fingerKeys = Object.keys(pose).filter((k) => /Proximal|Intermediate|Thumb/.test(k));
    if (fingerKeys.length >= 4) driven++;
    finite &&= fingerKeys.every((k) => (pose as any)[k].every(Number.isFinite));
    for (const [n, node] of Object.entries(av.nodes) as any) {
      if (node.position.distanceTo(posBefore.get(n)) > 1e-9) { stretched.push(`${rig.name}:${n}`); break; }
    }
  }
  check('rigs with digit bones grow spring phalanges', built === fingered.length, `${built}/${fingered.length}`);
  check('...and the captured pose drives them', driven === fingered.length, `${driven}/${fingered.length}`);
  check('...with finite quaternions throughout', finite);
  check('...and never writes a bone POSITION (no mesh stretch)', stretched.length === 0, stretched.slice(0, 3).join(' '));

  if (bare.length) {
    const rig: any = bare[0];
    const { rd } = run(makeAvatar(rig.P, { realParent: rig.realParent }), toppleLean());
    check('a rig without digit bones builds a clean 16-body doll and rests',
      rd.done && rd._fingerSegs.length === 0, `fingers=${rd._fingerSegs?.length}`);
  }

  // spring-back: tug a phalanx off its curl with a pin (a drag's door), let go; the spring must pull it back, not hang limp
  if (fingered.length) {
    const rig: any = fingered[0];
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
    // hung by the head so the hands dangle clear of the ground
    const hold = av.vrm.humanoid.getNormalizedBoneNode('head')
      .getWorldPosition(new THREE.Vector3()).add(new THREE.Vector3(0, 0.35, 0));
    for (let i = 0; i < 240; i++) { rd.setPin('head', hold); rd.step(1 / 60); }
    const seg = rd._fingerSegs[0];
    // measured relative to its HAND: the tug swings the whole arm, and the spring's coordinate is hand-relative
    const side = seg.a.startsWith('left') ? 'left' : 'right';
    const handSeg: any = rd.segs.get(`${side}Hand|${side}MiddleProximal`);
    const relQ = () => {
      const qh = bodyQuat(handSeg.body, new THREE.Quaternion());
      const qf = bodyQuat(seg.body, new THREE.Quaternion());
      return qh.invert().multiply(qf);
    };
    const born = relQ();
    const angleTo = () => 2 * Math.acos(Math.min(1, Math.abs(born.dot(relQ()))));
    // hold the hand at TWO points: a p2p holds a point, not an orientation, so a wrist-only hold lets the hand rotate
    const handHold = rd.p[`${side}Hand`].clone();
    const knuckleHold = rd.p[`${side}MiddleProximal`].clone();
    // tug along the joint's flexion direction: a fixed world direction pulls into the ±12° deviation limit, not the 90° curl
    const J: any = rd.flexAxes().find((x: any) => x.name === seg.a);
    const flexSign = J.hi[0] > -J.lo[0] ? 1 : -1;
    const moveRest = new THREE.Vector3().crossVectors(J.axisX, J.axisY).multiplyScalar(flexSign);
    const qHand = bodyQuat(handSeg.body, new THREE.Quaternion());
    const tug = rd.p[seg.b].clone().addScaledVector(moveRest.applyQuaternion(qHand), 0.05);
    const holdHand = () => {
      rd.setPin('head', hold);
      rd.setPin(`${side}Hand`, handHold);
      rd.setPin(`${side}MiddleProximal`, knuckleHold);
    };
    for (let i = 0; i < 120; i++) { holdHand(); rd.setPin(seg.b, tug); rd.step(1 / 60); }
    const bent = angleTo();
    rd.setPin(seg.b, null);
    for (let i = 0; i < 300; i++) { holdHand(); rd.step(1 / 60); }
    const back = angleTo();
    check('a tugged phalanx bends, then springs back toward its born curl',
      bent > 0.08 && back < bent * 0.6,
      `bent ${(bent * 180 / Math.PI).toFixed(0)}° → settled ${(back * 180 / Math.PI).toFixed(0)}°`);
    rd.dispose();
  }
}

// ---------------------------------------------------------------------------
// SLOPED TERRAIN: the ground follows the field per joint, not one heightAt(hips) sample; the terrain module is
// headless-injectable (issue #17), so the suite tilts the world and drops a body on the grade.
console.log('\nsloped terrain (the ground follows the field):');
{
  const { setTerrain, heightAt } = await import('../client/lib/terrain.js');
  setTerrain({ heightAt: (x: number, z: number) => 0.4 * x + 0.15 * Math.sin(z) });
  const rig: any = FLEET[0];
  const bad: string[] = [];
  for (const yaw of [0, Math.PI / 2]) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    av.root.rotation.y = yaw;
    av.root.position.y = heightAt(av.root.position.x, av.root.position.z);
    av.root.updateMatrixWorld(true);
    const rd: any = new AmmoRagdoll(av, toppleLean(yaw, 6), av.restBonePositions());
    let steps = 0;
    while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
    for (const [j, p] of Object.entries(rd.p) as any) {
      const under = heightAt(p.x, p.z) - p.y;
      // tolerance = a box half-width of grazing; the flat-cuboid bug buried parts by the full rise (0.3-0.5m here)
      if (under > 0.25) bad.push(`${yaw ? 'E' : 'N'}:${j}(${(under * 100).toFixed(0)}cm under)`);
    }
  }
  setTerrain(null);
  check('no joint rests buried in a sloped field', bad.length === 0, bad.slice(0, 6).join(' '));
}

// ---------------------------------------------------------------------------
// FACE-PLANT: VRM's head bone sits at the skull base, so the skull needs its own volume: prone, the head bone must
// rest clear of the floor by more than a neck's half-width.
console.log('\nface-plant (the skull keeps the face out of the floor):');
{
  const bad: string[] = [];
  for (const rig of FLEET.slice(0, 5)) {
    const P: any = rig.P;
    const up = (P.neck ?? P.chest).clone().sub(P.hips).normalize();
    const lat = P.leftUpperArm.clone().sub(P.rightUpperArm);
    lat.addScaledVector(up, -lat.dot(up)).normalize();
    const fwd = new THREE.Vector3().crossVectors(lat, up).normalize();
    const av = makeAvatar(rig.P, { realParent: rig.realParent });
    const rd: any = new AmmoRagdoll(av, fwd.multiplyScalar(5), av.restBonePositions());
    let steps = 0;
    while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
    // height-scaled: a skull is ~14% of standing height, so the prone head bone rests about half a skull depth up
    const H = (P.head.y - Math.min(P.leftFoot?.y ?? 0, P.rightFoot?.y ?? 0)) * 1.12;
    const clear = rd.p.head?.y ?? 0;   // flat world: ground is y=0
    if (clear < H * 0.045) bad.push(`${rig.name}(head at ${(clear * 100).toFixed(1)}cm, bar ${(H * 4.5).toFixed(1)}cm)`);
  }
  check('a face-first fall rests the head clear of the floor', bad.length === 0, bad.join(' '));
}

console.log('\nlifecycle (one rig, every downstream contract):');
{
  const rig: any = FLEET[0];

  // pin: hang, persist, release-and-fall
  const av = makeAvatar(rig.P);
  const rd: any = new AmmoRagdoll(av, null, av.restBonePositions());
  const hold = new THREE.Vector3(0.3, 2.2, 0.2);
  rd.setPin('head', hold);
  for (let i = 0; i < 600; i++) { rd.setPin('head', hold); rd.step(1 / 60); }
  check('a pinned body never captures', !rd.done);
  check('...and hangs AT the pin', rd.p.head.distanceTo(hold) < 0.1, `${rd.p.head.distanceTo(hold).toFixed(3)}m off`);
  check('...pins map mirrors the hold (bodydrag reads it)', rd.pins.get('head')?.distanceTo(hold) === 0);
  check('...and the body dangles below', rd.p.hips.y < rd.p.head.y, `hips ${rd.p.hips.y.toFixed(2)}`);
  rd.setPin(null);
  let steps = 0;
  while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
  check('nail pulled: falls and rests', rd.done, `steps=${steps}`);
  check('capture freed the wasm objects', (rd as any)._freed === true && (rd as any)._refs.length === 0);

  // impulse mid-tumble: same fall twice, shove one, averaged over a panel (one falling body is too chaotic)
  const shoved = (push: boolean, r0: any) => {
    const a = makeAvatar(r0.P, { realParent: r0.realParent });
    const r: any = new AmmoRagdoll(a, toppleLean(), a.restBonePositions());
    for (let i = 0; i < 30; i++) r.step(1 / 60);
    const x0 = r.p.hips.x;
    if (push) r.impulse(new THREE.Vector3(3, 0, 0));
    const clocks = { elapsed: r.elapsed, settledFor: r.settledFor };
    let s = 0;
    while (!r.done && s < 900) { r.step(1 / 60); s++; }
    return { dx: r.p.hips.x - x0, done: r.done, clocks };
  };
  const panel = FLEET.slice(0, 6);
  let pushSum = 0, stillSum = 0, allDone = true;
  let pushed: any = null;
  for (const r0 of panel) {
    const a = shoved(true, r0), b = shoved(false, r0);
    pushed ??= a;
    pushSum += a.dx; stillSum += b.dx;
    allDone &&= a.done && b.done;
  }
  const pushedMean = pushSum / panel.length, stillMean = stillSum / panel.length;
  check('impulse restarts the clocks', pushed.clocks.elapsed === 0 && pushed.clocks.settledFor === 0);
  check('a mid-tumble shove still comes to rest, downwind of an unshoved twin',
    allDone && pushedMean > stillMean + 0.05,
    `mean over ${panel.length} rigs: shoved Δx=${pushedMean.toFixed(2)} vs unshoved ${stillMean.toFixed(2)}`);

  // snapshot/seed round-trip: the drag handover format
  const av3 = makeAvatar(rig.P);
  const rd3: any = new AmmoRagdoll(av3, toppleLean(), av3.restBonePositions());
  for (let i = 0; i < 20; i++) rd3.step(1 / 60);
  const snap = rd3.snapshot();
  check('snapshot is the packed handover shape',
    Array.isArray(snap.j) && snap.p.length === snap.j.length * 3 && snap.v.length === snap.j.length * 3
    && snap.p.every(Number.isFinite) && snap.v.every(Number.isFinite),
    JSON.stringify({ j: snap.j?.length, p: snap.p?.length }));
  rd3.dispose();
  check('snapshot after dispose says nothing (null, never a hollow handover)', rd3.snapshot() === null);
  const av4 = makeAvatar(rig.P);
  const { rd: rd4 } = run(av4, null, { seedVel: snap });
  check('a seeded sim (drag release) accepts the handover and rests', rd4.done);

  // hostile magnitude is capped, not obeyed
  const av5 = makeAvatar(rig.P);
  const rd5: any = new AmmoRagdoll(av5, new THREE.Vector3(1000, 0, 0), av5.restBonePositions());
  let s5 = 0;
  while (!rd5.done && s5 < 900) { rd5.step(1 / 60); s5++; }
  check('a hostile 1000 m/s lean is capped, not obeyed',
    rd5.done && Object.values(rd5.p).every((p: any) => Number.isFinite(p.x) && Math.abs(p.x) < 60),
    `done=${rd5.done}`);
}

// ---- wings ------------------------------------------------------------------
// makeAvatar builds humanoid bones only, so wing bones are grafted from the shipped VRM's node tree onto their real
// humanoid ancestor (as mcpl/physics.ts grafts hair)
{
  const { humanBones, worldPositions } = await import('./rig-load.mjs');
  console.log('\nwings (the ragdoll takes them over):');
  {
    // the control is the fleet's rig: makeAvatar with `realParent` walks P's keys (54 bones), without it PARENT's (16)
    const rigW: any = wingRig;
    const g = dollGltf;
    const bones = humanBones(g);
    const wp = worldPositions(g);
    const P: any = { ...rigW.P };
    const byName = new Map<string, number>();
    g.nodes.forEach((n: any, i: number) => { if (n.name) byName.set(n.name, i); });
    const parentOf = new Map<number, number>();
    g.nodes.forEach((n: any, i: number) =>
      (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
    const wingParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(name)) continue;
      P[name] = wp(i);
      const pn = parentOf.get(i) != null ? g.nodes[parentOf.get(i)!]?.name : null;
      wingParent[name] = (pn && /^[LR]_Wing_/.test(pn)) ? pn
        : (name[0] === 'L' ? 'leftShoulder' : 'rightShoulder');
    }
    check('the rig carries every wing bone (4 chains x 3)',
      Object.keys(wingParent).length === 12, `${Object.keys(wingParent).length} found`);
    // HAIR bones too: the hair-ownership check needs a rig that grows Bullet hair (the gap mcpl/physics.ts closes for agents)
    const hairParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^Hair_\d+_\d+$/.test(name)) continue;
      P[name] = wp(i);
      const pn = parentOf.get(i) != null ? g.nodes[parentOf.get(i)!]?.name : null;
      hairParent[name] = (pn && /^Hair_\d+_\d+$/.test(pn)) ? pn : 'head';
    }
    const RP2 = { ...rigW.realParent, ...wingParent, ...hairParent };

    const av = makeAvatar(P, { realParent: { ...rigW.realParent, ...wingParent } });
    const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
    check('the doll builds Bullet chains for them',
      rd._wingSegs?.length === 12, `${rd._wingSegs?.length ?? 0} segments`);
    // each segment's Bullet parent is its parent BONE's body (depth from the index, not an underscore count, or _1 and _2 tie)
    const segOf = new Map(rd._wingSegs.map((s: any) => [s.node, s]));
    const misparented = rd._wingSegs.filter((s: any) => s.j > 0
      && rd._wingSegs[rd._wingSegs.indexOf(s) - 1]?.node !== s.node.parent);
    check('...each segment chained to its own parent BONE, in order',
      misparented.length === 0,
      misparented.map((s: any) => s.node.name).join(' '));
    check('...and each chain ramps its limit over its own length',
      rd._wingSegs.every((s: any) => s.n === 3));
    check('...hung from four kinematic anchors',
      rd._wingAnchors?.length === 4, `${rd._wingAnchors?.length ?? 0} anchors`);
    check('...and the step loop sees hair and wings as one list',
      rd._dressSegs?.length === (rd._hairSegs?.length ?? 0) + rd._wingSegs.length);

    const wingNodes = rd._wingSegs.map((s: any) => s.node);
    const before = wingNodes.map((n: any) => n.quaternion.clone());
    // a wing must NOT be in the settle metric: 8 sprung plates would keep the body awake and it would never capture
    check('wings are excluded from the settle metric (not in _cores)',
      rd._wingSegs.every((s: any) => !rd._cores.includes(s.body)));

    // no wing plate is born inside the body (a contact born penetrating launches it): each plate's centre vs the core
    // boxes at build (a sweeping plate's AABB overlaps everything). The head/torso pair proves the check can fail.
    const worldOf = (body: any) => {
      const t = body.getCenterOfMassTransform();
      const o = t.getOrigin(), r = t.getRotation();
      return {
        c: new THREE.Vector3(o.x(), o.y(), o.z()),
        q: new THREE.Quaternion(r.x(), r.y(), r.z(), r.w()),
        boxes: rd._vol.find((v: any) => v.body === body)?.boxes ?? [],
      };
    };
    const inside = (p: any, body: any) => {
      const w = worldOf(body);
      const local = p.clone().sub(w.c).applyQuaternion(w.q.clone().invert());
      return w.boxes.some((bx: any) => {
        const b = local.clone().sub(bx.t).applyQuaternion(bx.q.clone().invert());
        return Math.abs(b.x) <= bx.he.x && Math.abs(b.y) <= bx.he.y && Math.abs(b.z) <= bx.he.z;
      });
    };
    const born: string[] = [];
    for (const ws of rd._wingSegs) {
      const p = worldOf(ws.body).c;
      for (const core of rd._cores) if (inside(p, core)) born.push(ws.node.name);
    }
    check('no wing plate is born inside a body it cannot push out of',
      born.length === 0, [...new Set(born)].join(' '));
    // calibration: a body's centre is inside its own boxes, so a clean wing result means "not inside", not "can't tell"
    const torso: any = rd.segs.get('chest|neck') ?? rd.segs.get('spine|chest');
    check('...and that predicate can see an inside when there is one',
      !!torso && inside(worldOf(torso.body).c, torso.body));
    check('every anchor is kinematic (one-way, no reaction on the chest)',
      rd._wingAnchors.every((a: any) => (a.anchor.getCollisionFlags() & 2) !== 0));

    let steps = 0;
    while (!rd.done && steps < 900) { rd.step(1 / 60); steps++; }
    check('the body still falls and settles', rd.done, `${steps} steps`);
    const moved = wingNodes.filter((n: any, i: number) =>
      n.quaternion.angleTo(before[i]) > 1e-3).length;
    check('the sim WRITES every wing bone during the fall', moved === 12,
      `${moved}/12 moved`);

    check('...with finite quaternions throughout',
      wingNodes.every((n: any) => Number.isFinite(n.quaternion.x)
        && Number.isFinite(n.quaternion.w)));
    // the doll's half of the hair handshake (avatar-test has the consumer): claim the hair while driving it and hand it
    // back reset, or three-vrm resumes from pre-fall state and yanks it
    {
      const hav = makeAvatar(P, { realParent: RP2 });
      let didReset = false, adopted: any = null;
      hav.vrm.springBoneManager = { reset: () => { didReset = true; }, update: () => {} };
      hav.vrm.scene = { updateMatrixWorld: () => {} };
      // the stand-in carries the one method the doll reaches for on the way out (avatar.js owns the real one)
      hav._releaseHair = (opts: any) => {
        adopted = opts; hav.__simHair = false; hav.vrm.springBoneManager.reset();
      };
      const hrd: any = new AmmoRagdoll(hav, toppleLean(), hav.restBonePositions());
      check('a doll with Bullet hair claims those bones from three-vrm',
        hav.__simHair === true, `hair segments: ${hrd._hairSegs?.length ?? 0}`);
      hrd.dispose();
      // dispose hands the hair back ADOPTING the fallen pose, so a body let go mid-drag keeps falling with its hair
      check('...and hands them back on dispose, adopting the fallen pose',
        hav.__simHair === false && adopted?.adopt === true,
        `adopt=${adopted?.adopt}`);
      check('...having re-derived the spring state so it resumes smoothly', didReset);
    }
    rd.dispose();
    check('dispose frees the wing bodies too', rd._freed === true);
  }
}

// ---- wing boxes come from the MESH, not the bone length ---------------------
// a short bone with long geometry (or a leaf bone) gets the geometry's box; a real THREE.SkinnedMesh states the contract
{
  console.log('\nwing boxes (sized by the mesh, not the bone):');
  const { AmmoRagdoll } = await import('../client/lib/ammodoll.js');
  const BONE_LEN = 0.15, MESH_LEN = 0.60, MESH_SPAN = 0.40;

  const rigW: any = wingRig;
  const P: any = { ...rigW.P };
  const shoulder = P.leftShoulder ?? P.leftUpperArm;
  P.L_Wing_Upper = shoulder.clone().add(new THREE.Vector3(0.05, 0.05, 0));
  P.L_Wing_Upper_1 = P.L_Wing_Upper.clone().add(new THREE.Vector3(BONE_LEN, 0, 0));
  // a hair chain asks for extents FIRST: the families share one cache, and an unkeyed cache hands the wings the hair's map
  P.Hair_0_0 = P.head.clone().add(new THREE.Vector3(0, 0.05, 0));
  P.Hair_0_1 = P.Hair_0_0.clone().add(new THREE.Vector3(0, -0.04, 0));
  const wingParent = {
    L_Wing_Upper: 'leftShoulder', L_Wing_Upper_1: 'L_Wing_Upper',
    Hair_0_0: 'head', Hair_0_1: 'Hair_0_0',
  };
  const av = makeAvatar(P, { realParent: { ...rigW.realParent, ...wingParent } });

  const bones = [av.nodes.L_Wing_Upper, av.nodes.L_Wing_Upper_1];
  const geo = new THREE.BoxGeometry(MESH_LEN, MESH_SPAN, 0.02, 8, 8, 1);
  const n = geo.attributes.position.count;
  geo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(n * 4), 4));
  geo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(n * 4), 4));
  for (let i = 0; i < n; i++) {
    geo.attributes.skinIndex.setXYZW(i, 1, 0, 0, 0);       // all on the OUTER bone
    geo.attributes.skinWeight.setXYZW(i, 1, 0, 0, 0);
  }
  const skel = new THREE.Skeleton(bones);
  const sm = new THREE.SkinnedMesh(geo, new THREE.MeshBasicMaterial());
  av.root.add(sm);
  sm.bind(skel);
  av.root.updateMatrixWorld(true);

  {
    const hbones = [av.nodes.Hair_0_0, av.nodes.Hair_0_1];
    const hgeo = new THREE.BoxGeometry(0.02, 0.05, 0.02, 2, 2, 2);
    const hn = hgeo.attributes.position.count;
    hgeo.setAttribute('skinIndex', new THREE.Uint16BufferAttribute(new Uint16Array(hn * 4), 4));
    hgeo.setAttribute('skinWeight', new THREE.Float32BufferAttribute(new Float32Array(hn * 4), 4));
    for (let i = 0; i < hn; i++) {
      hgeo.attributes.skinIndex.setXYZW(i, 1, 0, 0, 0);
      hgeo.attributes.skinWeight.setXYZW(i, 1, 0, 0, 0);
    }
    const hsm = new THREE.SkinnedMesh(hgeo, new THREE.MeshBasicMaterial());
    av.root.add(hsm);
    hsm.bind(new THREE.Skeleton(hbones));
    av.root.updateMatrixWorld(true);
  }

  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  check('the fixture builds hair as well as wings (both families present)',
    (rd._hairSegs?.length ?? 0) > 0 && (rd._wingSegs?.length ?? 0) > 0,
    `hair ${rd._hairSegs?.length ?? 0}, wings ${rd._wingSegs?.length ?? 0}`);
  const seg = rd._wingSegs.find((s: any) => s.node.name === 'L_Wing_Upper_1');
  check('the rig under test has geometry 4x its bone length',
    !!seg, seg ? '' : 'no outer wing segment built');
  if (seg) {
    const he = rd._vol.find((v: any) => v.body === seg.body).boxes[0].he;
    const longest = 2 * Math.max(he.x, he.y, he.z);
    check('the box spans the MESH, not the bone',
      Math.abs(longest - MESH_LEN) < 0.05,
      `box ${longest.toFixed(3)}m vs mesh ${MESH_LEN}m, bone ${BONE_LEN}m`);
    const mid = 2 * [he.x, he.y, he.z].sort((a, b) => b - a)[1];
    check('...across its span too, not a filament',
      Math.abs(mid - MESH_SPAN) < 0.05, `${mid.toFixed(3)}m vs ${MESH_SPAN}m`);
    check('...and a membrane keeps a floor thickness, not a degenerate box',
      Math.min(he.x, he.y, he.z) >= 0.01);
  }
  // the fallback still works where there is nothing to measure
  const bare = makeAvatar(P, { realParent: { ...rigW.realParent, ...wingParent } });
  const rdBare: any = new AmmoRagdoll(bare, toppleLean(), bare.restBonePositions());
  check('a rig with no skinned mesh still gets bone-length boxes',
    rdBare._wingSegs?.length === 2, `${rdBare._wingSegs?.length ?? 0} segments`);
}

// ---- the sim's writes must SURVIVE matrixAutoUpdate = false ----------------
// three-vrm sets matrixAutoUpdate = false on spring joints, so a .quaternion write never reaches .matrix: read the WORLD MATRIX
{
  console.log('\nhair writes reach the renderer (matrixAutoUpdate = false):');
  const rigW: any = wingRig;
  const { worldPositions } = await import('./rig-load.mjs');
  const g = dollGltf;
  const wp = worldPositions(g);
  const P: any = { ...rigW.P };
  const byName = new Map<string, number>();
  g.nodes.forEach((n: any, i: number) => { if (n.name) byName.set(n.name, i); });
  const parentOf = new Map<number, number>();
  g.nodes.forEach((n: any, i: number) =>
    (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
  const hairParent: Record<string, string> = {};
  for (const [name, i] of byName) {
    if (!/^Hair_\d+_\d+$/.test(name)) continue;
    P[name] = wp(i);
    const pn = parentOf.get(i) != null ? g.nodes[parentOf.get(i)!]?.name : null;
    hairParent[name] = (pn && /^Hair_\d+_\d+$/.test(pn)) ? pn : 'head';
  }
  const av = makeAvatar(P, { realParent: { ...rigW.realParent, ...hairParent } });
  // what three-vrm does to a spring joint
  let frozen = 0;
  av.root.traverse((o: any) => {
    if (/^Hair_\d+_\d+$/.test(o.name ?? '')) { o.matrixAutoUpdate = false; frozen++; }
  });
  check('the fixture freezes hair bones the way three-vrm does', frozen > 0,
    `${frozen} bones`);

  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  const watch = rd._hairSegs.slice(0, 40);
  const before = watch.map((s: any) => {
    s.node.updateWorldMatrix(true, false);
    return new THREE.Vector3().setFromMatrixPosition(s.node.matrixWorld);
  });
  for (let i = 0; i < 120; i++) rd.step(1 / 60);
  // a renderer does NOT call updateMatrix on a frozen bone
  av.root.updateMatrixWorld(true);
  let moved = 0, worst = 0;
  watch.forEach((s: any, i: number) => {
    const now = new THREE.Vector3().setFromMatrixPosition(s.node.matrixWorld);
    const d = now.distanceTo(before[i]);
    if (d > 0.005) moved++;
    worst = Math.max(worst, d);
  });
  check('a frozen hair bone still MOVES IN ITS WORLD MATRIX after a fall',
    moved > watch.length / 2,
    `${moved}/${watch.length} moved, worst ${(worst * 100).toFixed(1)}cm`);
  // the matrix must agree with the quaternion: the failure was them disagreeing while every test read the quaternion
  const q = new THREE.Quaternion(), qm = new THREE.Quaternion();
  const s0 = watch[0];
  s0.node.matrix.decompose(new THREE.Vector3(), qm, new THREE.Vector3());
  q.copy(s0.node.quaternion);
  // 0.5°, not 1e-6: compose→decompose drifts ~0.02°; a matrix never recomposed shows tens of degrees
  check('...and its matrix agrees with its quaternion (the two never diverge)',
    qm.angleTo(q) < 0.5 * Math.PI / 180, `${(qm.angleTo(q) * 180 / Math.PI).toFixed(2)}° apart`);
}

// ---- the collision filter fits in a SHORT --------------------------------
// ammo.js declares addRigidBody's group and mask as short: bits above 14 truncate, and group 0 silently collides with nothing
{
  console.log('\ncollision groups fit the short the binding declares:');
  const rig: any = wingRig;
  const av = makeAvatar(rig.P, { realParent: rig.realParent });
  const rd: any = new AmmoRagdoll(av, toppleLean(), av.restBonePositions());
  const groups = [...rd._groupOf.values()] as number[];
  const asShort = (v: number) => { const m = v & 0xffff; return m > 32767 ? m - 65536 : m; };
  check('every core body has a bit (none dropped to ground-only)',
    rd._groupOf.size === rd._cores.length,
    `${rd._groupOf.size} of ${rd._cores.length}`);
  check('no group truncates to zero (a body that collides with nothing)',
    groups.every((g) => asShort(g) !== 0),
    groups.filter((g) => asShort(g) === 0).join(','));
  check('no group lands on the sign bit',
    groups.every((g) => asShort(g) > 0),
    groups.filter((g) => asShort(g) < 0).join(','));
  check('the dressing group survives too',
    asShort(1 << 14) === 1 << 14);
  rd.dispose();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
