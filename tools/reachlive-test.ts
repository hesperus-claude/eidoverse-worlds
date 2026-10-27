/** Live reach: the solver driving REAL bone nodes on the shipped rigs, frame after frame, with the target moving. Unlike
 *  reach-test and reachrig-test it writes the quaternions onto a real three.js hierarchy, updates matrices as a frame
 *  would, and asks the HAND NODE where it ended up.
 *  EIDOVERSE_DIR is not optional in a worktree: without it the library rigs (the default body among them) silently drop out.
 *    EIDOVERSE_DIR=<library checkout> bun tools/reachlive-test.ts */

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const STUB = fileURLToPath(new URL('./core-stub.mjs', import.meta.url));
plugin({ name: 'core-stub', setup(b) { b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: STUB })); } });

const { THREE } = await import('./core-stub.mjs');
const { rigs, libraryRigs, makeAvatar } = await import('./rig-load.mjs');
const { measureChain, solveChain } = await import('../client/lib/reachbone.js');
const { solveTwoBone, penetration } = await import('../shared/reach.js');

let failures = 0;
const check = (label: string, ok: boolean, detail?: string) => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

/** One frame: solve, write the two bones, refresh the graph. */
function step(chain: any, av: any, target: number[], pole: number[] | null) {
  const out: any = solveChain(chain, av, target, pole);
  if (!out.ok) return out;
  chain.nodes.upper.quaternion.set(out.upper[0], out.upper[1], out.upper[2], out.upper[3]);
  chain.nodes.lower.quaternion.set(out.lower[0], out.lower[1], out.lower[2], out.lower[3]);
  av.root.updateMatrixWorld(true);
  return out;
}
const handAt = (chain: any) => chain.nodes.end.getWorldPosition(new THREE.Vector3());
const D = (a: any, b: number[]) => a.distanceTo(new THREE.Vector3(b[0], b[1], b[2]));

const good = [...rigs(), ...libraryRigs()].filter((r: any) => !r.err);
console.log(`\n${good.length} rigs`);

console.log("\na hand goes where it is sent");
{
  let worst = 0, n = 0, unmeasurable: string[] = [];
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) { unmeasurable.push(rig.name); continue; }
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const reach = (chain.L1 + chain.L2) * 0.7;
    for (const dir of [[0, 0, 1], [0.6, 0.3, 0.7], [0.3, -0.7, 0.6]]) {
      const l = Math.hypot(...dir);
      const t = [sh.x + dir[0] / l * reach, sh.y + dir[1] / l * reach, sh.z + dir[2] / l * reach];
      const out: any = step(chain, av, t, null);
      if (!out.ok || out.res.bound.length) continue;
      worst = Math.max(worst, D(handAt(chain), t)); n++;
    }
  }
  check(`every rig's chain is measurable${unmeasurable.length ? ` (${unmeasurable.join(", ")} not)` : ""}`,
    unmeasurable.length === 0);
  check(`the HAND NODE lands on the target (${n} reaches, <0.1mm)`, worst < 1e-4, `worst ${(worst * 1000).toFixed(4)}mm`);
}

console.log("\nand it KEEPS going where it is sent (the moving target)");
{
  // re-solving per frame: a moving target is tracked, not snapped to once
  let worst = 0, frames = 0, worstJump = 0, spike = 0, spikeRig = '';
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const reach = (chain.L1 + chain.L2) * 0.65;
    let pole: number[] | null = null;
    let prevElbow: THREE.Vector3 | null = null;
    const jumps: number[] = [];
    for (let f = 0; f < 240; f++) {
      // a point orbiting in front of the shoulder, one full turn over 4s
      const a = (f / 240) * Math.PI * 2;
      const t = [sh.x + Math.sin(a) * reach * 0.55, sh.y + Math.cos(a) * reach * 0.55, sh.z + reach * 0.75];
      const out: any = step(chain, av, t, pole);
      if (!out.ok) continue;
      pole = out.elbowOffset;
      if (!out.res.bound.length) { worst = Math.max(worst, D(handAt(chain), t)); frames++; }
      const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
      if (prevElbow) jumps.push(elbow.distanceTo(prevElbow));
      prevElbow = elbow;
    }
    // per RIG, not pooled: bodies differ in proportion, so one body's legitimately fast region isn't an outlier against another's
    jumps.sort((a, b) => a - b);
    const p99r = jumps[Math.floor(jumps.length * 0.99)] || 1e-9;
    const mx = jumps[jumps.length - 1];
    worstJump = Math.max(worstJump, mx);
    if (mx / p99r > spike) { spike = mx / p99r; spikeRig = rig.name; }
  }
  check(`the hand stays on a moving target every frame (${frames} frames, <0.1mm)`, worst < 1e-4,
    `worst ${(worst * 1000).toFixed(4)}mm`);
  // continuity = no outlier step: worst frame step vs p99 (elbows legitimately swing fast near full extension). Proves
  // smoothness only: a null pole hint is as smooth; the hint stays for the -forward singularity
  check(`the elbow never SNAPS: worst step is no outlier (max/p99 ${spike.toFixed(2)}x on ${spikeRig})`,
    spike <= 6, `worst frame step overall ${(worstJump * 1000).toFixed(2)}mm`);
}

console.log("\nwith the body moving under it");
{
  // the torso turns (as a locomotion clip turns it) WHILE the target moves: limits read from the rest frame drift
  let worst = 0, frames = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const chest = av.nodes.chest ?? av.nodes.spine;
    if (!chest) continue;
    let pole: number[] | null = null;
    for (let f = 0; f < 120; f++) {
      // drive the parent chain the way a clip would, and swing the whole body
      chest.quaternion.setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.sin(f / 12) * 0.5);
      av.root.rotation.y = f / 40;
      av.root.position.set(Math.sin(f / 30) * 2, 0, Math.cos(f / 30) * 2);
      av.root.updateMatrixWorld(true);

      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      const fwd = new THREE.Vector3(0, 0, 1).applyQuaternion(av.root.getWorldQuaternion(new THREE.Quaternion()));
      const reach = (chain.L1 + chain.L2) * 0.6;
      const t = [sh.x + fwd.x * reach, sh.y + reach * 0.2, sh.z + fwd.z * reach];
      const out: any = step(chain, av, t, pole);
      if (!out.ok) continue;
      pole = out.elbowOffset;
      if (!out.res.bound.length) { worst = Math.max(worst, D(handAt(chain), t)); frames++; }
    }
  }
  check(`the hand tracks while the torso turns and the body walks (${frames} frames, <0.1mm)`,
    worst < 1e-4, `worst ${(worst * 1000).toFixed(4)}mm`);
  check("...and that actually exercised the moving case", frames > 500, `${frames} frames`);
}

console.log("\nthe limits hold on live bones");
{
  let violations = 0, tested = 0, reported = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    let seed = 5;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let i = 0; i < 200; i++) {
      const t = [sh.x + (rnd() - 0.5) * 1.5, sh.y + (rnd() - 0.5) * 1.5, sh.z + (rnd() - 0.5) * 1.5];
      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      tested++;
      if (out.res.bound.length) reported++;
      // the invariant a scene graph can check: the bones never grow
      const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
      const hand = handAt(chain);
      const shoulder = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      if (Math.abs(shoulder.distanceTo(elbow) - chain.L1) > 1e-5) violations++;
      if (Math.abs(elbow.distanceTo(hand) - chain.L2) > 1e-5) violations++;
    }
  }
  check(`no bone ever changes length on a live rig (${tested} solves)`, violations === 0, `${violations}`);
  check(`out-of-range targets are reported, not faked (${reported} bound)`, reported > 0);
}

console.log("\nnot through your own body");
{
  // arms through the torso: the LEFT hand at points on the RIGHT side drags the forearm through the chest; baseline
  // first, guards off, so the improvement is measured against a number
  let before = 0, after = 0, worstAfter = 0, cases = 0, cleared = 0, gapWorst = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "leftHand");
    if (!chain?.guards?.length) continue;
    const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
    const R = (chain.L1 + chain.L2);
    for (let i = 0; i < 60; i++) {
      const a = (i / 60) * Math.PI * 2;
      // a ring across the front of the torso, well inside arm's length, where the elbow wants to be inside the chest
      const t = [sh.x - R * 0.55 + Math.cos(a) * R * 0.3,
                 sh.y + Math.sin(a) * R * 0.35,
                 sh.z + R * 0.22];
      // rebuild the live guard list the way solveChain does
      const guards = (chain.guards ?? []).map((g: any) => ({
        a: g.na.getWorldPosition(new THREE.Vector3()).toArray(),
        b: g.nb.getWorldPosition(new THREE.Vector3()).toArray(), r: g.r,
      }));
      const naive: any = solveTwoBone({
        root: sh.toArray(), target: t, L1: chain.L1, L2: chain.L2,
        pole: chain.dRestU, fwd: chain.fwd, coneAxis: chain.coneAxis,
        limits: { coneHalf: chain.lim.coneHalf, behind: chain.lim.behind, maxFlex: chain.lim.maxFlex },
      });
      if (!naive.ok) continue;
      cases++;
      before += penetration(sh.toArray(), naive.elbow, naive.hand, chain.rUpper, chain.rLower, guards);

      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      const pen = out.penetration ?? 0;
      after += pen; worstAfter = Math.max(worstAfter, pen);
      if (pen <= 0) cleared++;
      if (!out.res.bound.length) gapWorst = Math.max(gapWorst, D(handAt(chain), t));
    }
  }
  const drop = before > 0 ? (1 - after / before) : 0;
  console.log(`  ${cases} across-body targets: penetration ${(before * 100).toFixed(1)}cm -> ${(after * 100).toFixed(1)}cm total`);
  check(`the baseline actually penetrated (else this proves nothing)`, before > 0.05, `${before.toFixed(4)}m`);
  check(`self-intersection drops by >90% (${(drop * 100).toFixed(1)}%)`, drop > 0.9);
  check(`most targets come out completely clear (${cleared}/${cases})`, cleared / Math.max(1, cases) > 0.9);
  check(`worst remaining overlap is small (${(worstAfter * 1000).toFixed(1)}mm)`, worstAfter < 0.02);
  check(`and the hand still lands on target (${(gapWorst * 1000).toFixed(3)}mm)`, gapWorst < 1e-4);
}

console.log("\nself-touch does not hunt");
{
  // a static body reaching a static point must produce the SAME arm every frame: fed its own elbow as the pole hint,
  // the discrete swivel search oscillates, so the solver keeps no state
  let worstFlips = 0, worstRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    // a point just off the LEFT upper arm, a bone that is also one of this arm's own guards: unsatisfiable
    const lu = av.nodes.leftUpperArm.getWorldPosition(new THREE.Vector3());
    const target = [lu.x + 0.03, lu.y + 0.04, lu.z + 0.02];
    const seen: number[] = [];
    // feed the elbow back in: the test must CLOSE the loop that oscillated, or it can't see the bug (null here would pass)
    let pole: number[] | null = null;
    for (let f = 0; f < 60; f++) {
      const out: any = step(chain, av, target, pole);
      if (!out.ok) break;
      pole = out.elbowOffset;
      seen.push(Math.round((out.swivel ?? 0) * 1e6));
    }
    if (seen.length < 30) continue;
    tested++;
    const settled = seen.slice(5);
    const flips = settled.filter((v, i) => i > 0 && v !== settled[i - 1]).length;
    if (flips > worstFlips) { worstFlips = flips; worstRig = rig.name; }
  }
  check(`a static self-touch settles on ONE arm and stays there (${tested} rigs, worst ${worstFlips} flips${worstRig ? ` on ${worstRig}` : ''})`,
    worstFlips === 0);
  check("...and it actually ran on every rig", tested >= 14, `${tested}`);
}

console.log("\nthe elbow does not sweep as the body turns");
{
  // with the target held in BODY space, yawing the body must move the elbow smoothly in body space: a pole near parallel
  // to the reach direction, normalised, swings the elbow round the arm (one step far outside its neighbours)
  let spike = 0, spikeRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    const steps: number[] = [];
    let prev: THREE.Vector3 | null = null;
    for (let yi = 0; yi <= 360; yi += 2) {
      av.root.rotation.y = yi * Math.PI / 180;
      av.root.updateMatrixWorld(true);
      const q = av.root.getWorldQuaternion(new THREE.Quaternion());
      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      // the target sweeps a cone AROUND the arm's rest direction, so the aim passes through the degenerate case (pole parallel to aim)
      const restW = new THREE.Vector3(...chain.dRestU).applyQuaternion(q).normalize();
      const side = new THREE.Vector3(0, 1, 0).cross(restW).normalize();
      const up2 = restW.clone().cross(side).normalize();
      const a2 = yi * Math.PI / 180;
      const dir = restW.clone()
        .addScaledVector(side, Math.cos(a2) * 0.08)
        .addScaledVector(up2, Math.sin(a2) * 0.08)
        .normalize();
      const t = sh.clone().addScaledVector(dir, (chain.L1 + chain.L2) * 0.62).toArray();
      const out: any = step(chain, av, t, null);
      if (!out.ok) continue;
      // elbow in BODY space, so the body's own rotation is factored out
      const eb = chain.nodes.lower.getWorldPosition(new THREE.Vector3())
        .sub(sh).applyQuaternion(q.clone().invert());
      if (prev) steps.push(eb.distanceTo(prev));
      prev = eb;
    }
    if (steps.length < 60) continue;
    tested++;
    steps.sort((a, b) => a - b);
    const p99 = steps[Math.floor(steps.length * 0.99)] || 1e-9;
    const mx = steps[steps.length - 1];
    if (mx / p99 > spike) { spike = mx / p99; spikeRig = rig.name; }
  }
  // ⚠ RATCHET (≤64x): the hard elbow-side constraint snaps once per full turn of this sweep (the feasible arc's nearest
  // edge switches ends); fixing it needs a continuity-aware arc edge, ratcheted so it can't worsen
  check(`elbow sweep does not worsen (${tested} rigs, worst max/p99 ${spike.toFixed(2)}x on ${spikeRig})`,
    spike <= 64);
  check("...and the sweep actually ran", tested >= 14, `${tested}`);
}

console.log("\nelbows bend the way elbows bend (where that is knowable)");
{
  // the chord proxy is valid only for an un-adducted arm (across the chest the elbow legitimately sits in front of the chord)
  let inverted = 0, checked = 0, skipped = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, "rightHand");
    if (!chain) continue;
    for (let yi = 0; yi < 8; yi++) {
      av.root.rotation.y = (yi / 8) * Math.PI * 2;
      av.root.updateMatrixWorld(true);
      const q = av.root.getWorldQuaternion(new THREE.Quaternion());
      const fwd = new THREE.Vector3(...chain.fwd).applyQuaternion(q);
      const inward = new THREE.Vector3(...chain.inward).applyQuaternion(q);
      const sh = chain.nodes.upper.getWorldPosition(new THREE.Vector3());
      const R = chain.L1 + chain.L2;
      for (let i = 0; i < 16; i++) {
        const a = (i / 16) * Math.PI * 2;
        const dir = new THREE.Vector3(Math.cos(a), Math.sin(a) * 0.6, 0.5)
          .applyQuaternion(q).normalize();
        if (dir.dot(inward) >= 0.3) { skipped++; continue; }   // adducted: proxy invalid
        const t = sh.clone().addScaledVector(dir, R * 0.6).toArray();
        const out: any = step(chain, av, t, null);
        if (!out.ok) continue;
        checked++;
        const elbow = chain.nodes.lower.getWorldPosition(new THREE.Vector3());
        const chord = handAt(chain).sub(sh);
        if (chord.lengthSq() < 1e-8) continue;
        chord.normalize();
        const e = elbow.clone().sub(sh);
        const perp = e.clone().addScaledVector(chord, -e.dot(chord));
        if (perp.length() < 1e-4) continue;                    // straight: no bend
        if (perp.dot(fwd) > 1e-4) inverted++;
      }
    }
  }
  // no elbow bends backwards where the rule is measurable (the hard side constraint; its cost is the ratcheted snap above)
  check(`no elbow bends backwards where the rule applies (${inverted}/${checked}, ${skipped} adducted and skipped)`,
    inverted === 0);
  check("...and the sweep actually ran", checked > 500, `${checked}`);
}

console.log("\nthe forearm, crossing the body");
{
  // reaching the opposite hip: the upper bone is pushed clear, but nothing acts on the FOREARM once the elbow is placed,
  // so it crosses the body (VRM0 rigs sit a half-turn from the root, which the harness must honour)
  const segDist = (p1: any, q1: any, p2: any, q2: any) => {
    const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
    const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r); let s: number, t: number;
    if (a <= 1e-12 && e <= 1e-12) return p1.distanceTo(p2);
    if (a <= 1e-12) { s = 0; t = Math.max(0, Math.min(1, f / e)); }
    else { const c = d1.dot(r);
      if (e <= 1e-12) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
      else { const b = d1.dot(d2), den = a * e - b * b;
        s = den > 1e-12 ? Math.max(0, Math.min(1, (b * f - c * e) / den)) : 0;
        t = (b * s + f) / e;
        if (t < 0) { t = 0; s = Math.max(0, Math.min(1, -c / a)); }
        else if (t > 1) { t = 1; s = Math.max(0, Math.min(1, (b - c) / a)); } } }
    return p1.clone().addScaledVector(d1, s).distanceTo(p2.clone().addScaledVector(d2, t));
  };
  let worstDeficitMM = 0, worstRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, 'rightHand');
    if (!chain || !av.nodes.leftUpperLeg || !av.nodes.rightUpperLeg) continue;
    const at = (n: string) => av.nodes[n]?.getWorldPosition(new THREE.Vector3());
    const sh = at('rightUpperArm');
    const lat = at('leftUpperLeg').clone().sub(at('rightUpperLeg')).normalize();
    const target = at('leftUpperLeg').clone().addScaledVector(lat, 0.09);
    const out: any = step(chain, av, target.toArray(), null);
    if (!out.ok) continue;
    tested++;
    const el = at('rightLowerArm'), hd = at('rightHand');
    for (const g of chain.guards ?? []) {
      const A = g.na.getWorldPosition(new THREE.Vector3());
      const B = g.nb.getWorldPosition(new THREE.Vector3());
      const req = g.r + chain.rLower * 0.25;
      const d = segDist(el, hd, A, B);
      // the guard nearest the TARGET is clipped on purpose (the hand has to arrive): count only the torso it isn't reaching for
      if (segDist(target, target, A, B) < req) continue;
      const deficit = (req - d) * 1000;
      if (deficit > worstDeficitMM) { worstDeficitMM = deficit; worstRig = rig.name; }
    }
  }
  console.log(`  ${tested} rigs, worst forearm shortfall ${worstDeficitMM.toFixed(0)}mm on ${worstRig || '-'}`);
  // ⚠ RATCHET at the measured value (the open forearm bug above): lower it when that is fixed
  check(`forearm-through-torso does not worsen (${worstDeficitMM.toFixed(0)}mm)`, worstDeficitMM <= 45);
  check('...and it actually ran', tested >= 14, `${tested}`);
}

console.log("\ntouching with the palm, not the back of the hand");
{
  // position IK says nothing about how a hand is turned; with no mesh the surface normal is synthesised (target back toward
  // the shoulder, head-on), exercising forearm pronation then the clamped wrist
  let worstOff = 0, worstRig = '', tested = 0, sumBefore = 0, sumAfter = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, 'rightHand');
    if (!chain?.restQ?.qH || !chain.palmRest) continue;
    const at = (n: string) => av.nodes[n]?.getWorldPosition(new THREE.Vector3());
    const sh = at('rightUpperArm');
    const R = chain.L1 + chain.L2;
    const qH0 = new THREE.Quaternion(...chain.restQ.qH);
    const aPalm = new THREE.Vector3(...chain.palmRest).applyQuaternion(qH0.clone().invert());
    // world-space palm direction, to compare against a world-space want
    const palmNow = () => aPalm.clone().applyQuaternion(
      chain.nodes.end.getWorldQuaternion(new THREE.Quaternion()));
    for (let i = 0; i < 6; i++) {
      // ⚠ TURN THE BODY: the palm target is a WORLD direction and the rest is in the root's frame, which agree only at yaw 0
      av.root.rotation.y = (i / 6) * Math.PI * 2;
      av.root.updateMatrixWorld(true);
      const q = av.root.getWorldQuaternion(new THREE.Quaternion());
      const sh2 = at('rightUpperArm');
      const a = (i / 6) * Math.PI * 2;
      const dir = new THREE.Vector3(Math.cos(a) * 0.6, Math.sin(a) * 0.5, 0.7).normalize().applyQuaternion(q);
      const target = sh2.clone().addScaledVector(dir, R * 0.6);
      const want = dir.clone().negate();          // meet the surface head-on

      let out: any = solveChain(chain, av, target.toArray(), null);
      if (!out.ok) continue;
      chain.nodes.upper.quaternion.set(...out.upper as any);
      chain.nodes.lower.quaternion.set(...out.lower as any);
      av.root.updateMatrixWorld(true);
      const before = Math.acos(Math.max(-1, Math.min(1, palmNow().dot(want)))) * 180 / Math.PI;

      out = solveChain(chain, av, target.toArray(), null, { palm: { dir: want.toArray() } });
      if (!out.ok || !out.hand) continue;
      chain.nodes.upper.quaternion.set(...out.upper as any);
      chain.nodes.lower.quaternion.set(...out.lower as any);
      chain.nodes.end.quaternion.set(...out.hand as any);
      av.root.updateMatrixWorld(true);
      const after = Math.acos(Math.max(-1, Math.min(1, palmNow().dot(want)))) * 180 / Math.PI;

      tested++; sumBefore += before; sumAfter += after;
      if (after > worstOff) { worstOff = after; worstRig = rig.name; }
    }
  }
  const mb = sumBefore / Math.max(1, tested), ma = sumAfter / Math.max(1, tested);
  console.log(`  ${tested} reaches: palm off-target ${mb.toFixed(0)}° -> ${ma.toFixed(0)}° mean, worst ${worstOff.toFixed(0)}° on ${worstRig}`);
  check(`the palm turns to face what it touches (mean ${mb.toFixed(0)}° -> ${ma.toFixed(0)}°)`, ma < mb / 2);
  check(`no palm is left facing away (worst ${worstOff.toFixed(0)}°)`, worstOff < 90, `on ${worstRig}`);
  check('...and it ran on every rig', tested >= 14, `${tested}`);
}

console.log("\nno flicker between two poses");
{
  // an idle clip breathes, and a pose on a decision boundary flips with it: a sub-millimetre input must not move a centimetre
  let worstMM = 0, worstRig = '', tested = 0;
  for (const rig of good) {
    const av = makeAvatar(rig.P, { realParent: rig.realParent, vrm0: rig.vrm0 });
    const chain: any = measureChain(av, 'rightHand');
    if (!chain || !av.nodes.rightUpperLeg || !av.nodes.leftUpperLeg) continue;
    const at = (n: string) => av.nodes[n]?.getWorldPosition(new THREE.Vector3());
    const lat = at('leftUpperLeg').clone().sub(at('rightUpperLeg')).normalize();
    let prev: THREE.Vector3 | null = null, lp: any = null, ls: any = null;
    tested++;
    for (let f = 0; f < 80; f++) {
      av.root.position.y = Math.sin(f / 9) * 0.004;      // half a millimetre of breath
      av.root.updateMatrixWorld(true);
      const t = at('rightUpperLeg').clone().addScaledVector(lat, -0.09);
      const out: any = solveChain(chain, av, t.toArray(), null, { lastPick: lp, lastSwivel: ls });
      if (!out.ok) continue;
      lp = out.pick ?? null; ls = out.swivelUsed ?? null;
      chain.nodes.upper.quaternion.set(...out.upper as any);
      chain.nodes.lower.quaternion.set(...out.lower as any);
      av.root.updateMatrixWorld(true);
      const el = chain.nodes.lower.getWorldPosition(new THREE.Vector3()).sub(av.root.position);
      if (prev) {
        const jump = el.distanceTo(prev) * 1000;
        if (jump > worstMM) { worstMM = jump; worstRig = rig.name; }
      }
      prev = el;
    }
  }
  check(`a breathing body does not make the elbow jump (worst ${worstMM.toFixed(1)}mm${worstRig ? ` on ${worstRig}` : ''})`,
    worstMM < 5);
  check('...and it ran on every rig', tested >= 14, `${tested}`);
}

console.log(failures ? `\n\x1b[31m${failures} failed\x1b[0m\n` : "\n\x1b[32mall passed\x1b[0m\n");
process.exit(failures ? 1 : 0);
