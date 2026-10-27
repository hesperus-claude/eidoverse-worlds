// avatar: the clip/limp lifecycle, run headless (`bun tools/avatar-test.ts`).
// The real seam between the locomotion mixer and the ragdoll (the ragdoll suite mocks setLimp). The Avatar
// constructor needs a canvas, so these drive the real METHODS against a real THREE.AnimationMixer on a real
// skeleton. The contract: actions are play()ed once at load and cross-faded by WEIGHT ever after, so anything
// that deactivates them (mixer.stopAllAction) is unrecoverable.

import { plugin } from 'bun';
import { fileURLToPath } from 'node:url';
const here = (f: string) => fileURLToPath(new URL(f, import.meta.url));
plugin({
  name: 'client-stubs',
  setup(b) {
    b.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: here('./core-stub.mjs') }));
    b.onResolve({ filter: /^\.\/assets\.js$/ }, () => ({ path: here('./assets-stub.mjs') }));
    b.onResolve({ filter: /^\.\/loadwork\.js$/ }, () => ({ path: here('./loadwork-stub.mjs') }));
  },
});

const { THREE } = await import('./core-stub.mjs');
const { Avatar, BLINK } = await import('../client/lib/avatar.js');
const { DRIVEN_BONES } = await import('../client/lib/ragdoll.js');

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = '') => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ''}`); }
};

const BONES = [
  ...DRIVEN_BONES,
  'head', 'leftShoulder', 'rightShoulder', 'upperChest',
  'leftHand', 'rightHand', 'leftFoot', 'rightFoot', 'leftIndexProximal',
];
const UNDRIVEN = BONES.filter((b) => !DRIVEN_BONES.includes(b));

/** A skeleton, a mixer and a clip animating EVERY bone, set up as Avatar's constructor does (play() once, weight 0,
 *  cross-fade after), plus the minimum `this` the lifecycle methods reach for. */
function stand({ constant = false } = {}) {
  const root = new THREE.Object3D();
  const nodes: Record<string, any> = {};
  for (const b of BONES) {
    const n = new THREE.Object3D(); n.name = b;
    root.add(n); nodes[b] = n;
  }
  // a clip that MOVES: three.js only writes a bone when the computed value changes, so a constant track is written once
  const key = (a: number) => {
    const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), a);
    return [q.x, q.y, q.z, q.w];
  };
  // `constant` is the write-ONCE case (a single-key finger, a still idle head): everything after the mixer must behave the same
  const tracks = BONES.map((b) => new THREE.QuaternionKeyframeTrack(
    `${b}.quaternion`, [0, 0.5, 1],
    constant ? [...key(0.3), ...key(0.3), ...key(0.3)]
             : [...key(0.3), ...key(0.9), ...key(0.3)]));
  const clip = new THREE.AnimationClip('idle', 1, tracks);
  const mixer = new THREE.AnimationMixer(root);
  const action = mixer.clipAction(clip);
  action.enabled = true; action.setEffectiveWeight(0); action.play();   // as Avatar does
  action.setEffectiveWeight(1);                                          // ...then selected

  const self: any = {
    _limp: false, _parked: null, _override: null, onceAnim: null, pitch: 0,
    root, mixer, actions: { idle: action }, current: action, currentSlot: 'idle',
    head: nodes.head,
    vrm: {
      humanoid: {
        humanBones: Object.fromEntries(BONES.map((b) => [b, {}])),
        getNormalizedBoneNode: (b: string) => nodes[b] ?? null,
      },
    },
    cancelOnce() { this.onceAnim = null; },
  };
  self._composed = new Map();
  // setLimp reaches into eyes and wings: both find nothing here, but must be real methods or setLimp throws
  for (const m of ['setLimp', '_park', '_resolveBones', '_humanoidBones', 'setPose',
                   'clearPose', '_applyOverride', '_reachOwned', '_composeBegin', '_composeEnd',
                   '_applyPoseSlot', '_applyAnimSlot', '_handBack', '_rawBegin', '_rawEnd', '_rawRelease', 'playAnimation', '_sampleTrack',
                   'setEyes', '_findLids', '_findWings', '_releaseHair', '_combHair']) {
    self[m] = (Avatar.prototype as any)[m];
  }
  // the slice of update() that matters here, in its real order
  self.tick = function (dt = 1 / 60, now = 0) {
    this.mixer.update(dt);
    if (this._limp) this._park();
    if (this.head && !this._limp) {
      const r = this._composeBegin(this.head);
      if (this.pitch) {
        this.head.quaternion.premultiply(new THREE.Quaternion()
          .setFromAxisAngle(new THREE.Vector3(1, 0, 0), THREE.MathUtils.clamp(this.pitch, -0.5, 0.6)));
      }
      this._composeEnd(this.head, r);
    }
    if (this._override || this._anims?.length) this._applyOverride(dt, now);
  };
  return { self, nodes, action };
}
const moved = (n: any) => Math.abs(n.quaternion.y) > 1e-6;

console.log('avatar clip/limp lifecycle, headless:\n');

console.log('going limp:');
{
  const { self, nodes, action } = stand();
  self.tick();
  check('the clip drives every bone before anything happens',
    BONES.every((b) => moved(nodes[b])));

  self.setLimp(true);
  // THE regression: stopping the mixer deactivates actions never play()ed again; restoreOriginalState snaps to bind pose
  check('the mixer is NOT stopped — actions stay active', action.isRunning());
  check('...so no bone was snapped to its bind pose (the T-pose flash)',
    DRIVEN_BONES.every((b: string) => moved(nodes[b])),
    DRIVEN_BONES.filter((b: string) => !moved(nodes[b])).join(' '));
  check('undriven bones are parked at rest', UNDRIVEN.every((b) => !moved(nodes[b])),
    UNDRIVEN.filter((b) => moved(nodes[b])).join(' '));

  self.tick();
  check('...and stay parked after the next mixer write',
    UNDRIVEN.every((b) => !moved(nodes[b])),
    UNDRIVEN.filter((b) => moved(nodes[b])).join(' '));
}

console.log('\nthe tumble owns the driven bones from frame one:');
{
  const { self, nodes } = stand();
  self.setLimp(true);
  const target = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
  self.setPose({ hips: [target.x, target.y, target.z, target.w] });
  check('a pose applied while limp starts at FULL weight, not ramping from the clip',
    self._override.weight === 1, `weight ${self._override.weight}`);
  self.tick();
  check('...so the first rendered frame is the sim, not a blend',
    nodes.hips.quaternion.angleTo(target) < 1e-3,
    `off by ${nodes.hips.quaternion.angleTo(target).toFixed(3)} rad`);

  const held = stand();
  held.self.setPose({ hips: [target.x, target.y, target.z, target.w] });
  check('a held pose arriving over the wire still eases in',
    held.self._override.weight === 0);
}

console.log('\ngetting up:');
{
  const { self, nodes, action } = stand();
  self.setLimp(true);
  self.tick();
  self.setLimp(false);
  self.tick();
  check('the clip animates the body again', BONES.every((b) => moved(nodes[b])),
    BONES.filter((b) => !moved(nodes[b])).join(' '));
  check('...because the action was never deactivated', action.isRunning());

  // head pitch composes with += assuming the mixer rewrote the bone first; a silent mixer integrates it forever
  self.pitch = 0.3;
  const seen = new Set<string>();
  for (let i = 0; i < 240; i++) { self.tick(); seen.add(nodes.head.rotation.x.toFixed(4)); }
  check('head pitch does not accumulate frame over frame', seen.size <= 2,
    `${seen.size} distinct values, last ${nodes.head.rotation.x.toFixed(2)} rad`);
  check('...and stays inside its clamp', Math.abs(nodes.head.rotation.x) < 1.6,
    `${nodes.head.rotation.x.toFixed(2)} rad`);
}

console.log('\ncomposing on a clip that holds still:');
for (const constant of [false, true]) {
  const tag = constant ? 'still track' : 'animated track';

  // on a still track nothing puts back what we composed on top (head pitch reached 54 rad in three seconds)
  {
    const { self, nodes } = stand({ constant });
    self.pitch = 0.3;
    for (let i = 0; i < 180; i++) self.tick();
    const base = stand({ constant });
    for (let i = 0; i < 180; i++) base.self.tick();
    const applied = nodes.head.quaternion.angleTo(base.nodes.head.quaternion);
    check(`${tag}: head pitch holds at its value instead of integrating`,
      Math.abs(applied - 0.3) < 0.02, `${applied.toFixed(2)} rad of pitch after 3s`);
  }

  // clearPose must walk the bone back to the clip, or a body stands up holding the pose it landed in
  {
    const { self, nodes } = stand({ constant });
    for (let i = 0; i < 30; i++) self.tick();
    const clipPose = nodes.hips.quaternion.clone();
    const t = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    self.setPose({ hips: [t.x, t.y, t.z, t.w] });
    for (let i = 0; i < 60; i++) self.tick();
    check(`${tag}: a held pose reaches its target`,
      nodes.hips.quaternion.angleTo(t) < 1e-3);
    self.clearPose();
    for (let i = 0; i < 60; i++) self.tick();
    check(`${tag}: ...and releasing it returns the bone to the clip`,
      nodes.hips.quaternion.angleTo(clipPose) < 1e-3,
      `${nodes.hips.quaternion.angleTo(clipPose).toFixed(3)} rad off`);
  }
}

// ---- eyelids: where "closed" comes from -------------------------------------
// an authored POSE wins, a Limit Rotation constraint is second, the BLINK.closed dial last; the dial must not be
// reached silently by a rig that HAS an answer
{
  const lidNode = (name: string, extras: Record<string, unknown>) => {
    const o = new THREE.Object3D();
    o.name = name;
    o.userData = { gltfExtras: extras };
    return o;
  };
  const lidsOf = (extras: Record<string, unknown>) => {
    const scene = new THREE.Object3D();
    scene.add(lidNode('L_Eyelid_Upper', extras));
    const av = Object.create(Avatar.prototype) as any;
    av.vrm = { scene };
    av._findLids();
    return av._lids?.[0] ?? null;
  };

  // source order: an authored pose verbatim (it outranks constraints beside it), else a Limit Rotation as closed MINUS
  // the range centre (absolute angles), else null (the dial); nonsense is refused rather than driven through the eye
  const LIM = { limit_min_x: 2.618, limit_max_x: 4.189 };
  const LIDS: [string, Record<string, unknown>, number | null][] = [
    ['an authored closed pose is used verbatim (nowhere near the 1.2 rad dial)', { blink_closed_src: 'pose', blink_closed_x: 0.6593 }, 0.6593],
    ['an authored pose outranks the constraints beside it', { blink_closed_src: 'pose', blink_closed_x: 0.6593, ...LIM }, 0.6593],
    ['a Limit Rotation is closed minus the range centre (a lid sweep, not 240°)', { ...LIM, blink_closed_x: 4.189 }, 4.189 - (2.618 + 4.189) / 2],
    ['a rig with no closed angle falls back to the dial', {}, null],
    ['an implausible pose angle is refused', { blink_closed_src: 'pose', blink_closed_x: 2.9 }, null],
    ['an inverted constraint range is refused', { limit_min_x: 4.189, limit_max_x: 2.618, blink_closed_x: 4.189 }, null],
  ];
  for (const [label, extras, want] of LIDS) {
    const got = lidsOf(extras)?.exported;
    check(`eyelids: ${label}`, want === null ? got === null : Math.abs((got ?? 99) - want) < 1e-3, `exported=${got} want ${want}`);
  }
  check('eyelids: the authored pose is not the dial', Math.abs(0.6593 - BLINK.closed) > 0.4);
}

// ---- wings ------------------------------------------------------------------
// wing checks assert where the TIP went, not that a number changed. Rest pose from mythos-wings.blend in glTF Y-up
// (x, z, -y); chains are lists so a depth bug shows.
const WING_REST: Record<string, [number, number, number][]> = {
  // chain: [seg 0, seg 1, seg 2, ..., end of the last segment]
  L_Wing_Upper: [
    [0.0369, 0.7923, -0.067], [0.1696, 0.9047, -0.1645],
    [0.2307, 0.9479, -0.2038], [0.4386, 1.0227, -0.3627],
  ],
  R_Wing_Upper: [
    [-0.0432, 0.7923, -0.067], [-0.1786, 0.9047, -0.1623],
    [-0.2361, 0.9471, -0.2026], [-0.4469, 1.0162, -0.3524],
  ],
  L_Wing_Lower: [
    [0.0409, 0.7771, -0.067], [0.1466, 0.7004, -0.133],
    [0.2224, 0.5254, -0.1626], [0.2554, 0.3382, -0.1864],
  ],
  R_Wing_Lower: [
    [-0.0432, 0.7754, -0.067], [-0.1466, 0.7066, -0.1155],
    [-0.2339, 0.5265, -0.1617], [-0.2599, 0.3393, -0.1884],
  ],
};

function wingStand() {
  const root = new THREE.Object3D();
  const chest = new THREE.Object3D(); chest.name = 'upperChest';
  root.add(chest);
  const nodes: Record<string, any> = { upperChest: chest };
  for (const [chain, pts] of Object.entries(WING_REST)) {
    const V = (i: number) => new THREE.Vector3(...pts[i]);
    let parent = chest;
    for (let i = 0; i < pts.length - 1; i++) {
      const n = new THREE.Object3D();
      n.name = i === 0 ? chain : `${chain}_${i}`;
      n.position.copy(V(i)).sub(i === 0 ? new THREE.Vector3() : V(i - 1));
      parent.add(n);
      nodes[n.name] = n;
      parent = n;
    }
    // a marker at the end of the outermost segment, so a test asks where the WING went, not what a quaternion holds
    const tip = new THREE.Object3D();
    tip.name = `${chain}_tip#marker`;
    tip.position.copy(V(pts.length - 1)).sub(V(pts.length - 2));
    parent.add(tip);
    nodes[`${chain}_tip`] = tip;
  }
  const self: any = {
    _limp: false, root, onceAnim: null, _parked: null,
    vrm: {
      scene: root,
      humanoid: {
        humanBones: {},
        getNormalizedBoneNode: (n: string) => nodes[n] ?? null,
      },
    },
    cancelOnce() { this.onceAnim = null; },
  };
  for (const m of ['_findWings', '_flap', 'setLimp', 'setEyes', '_findLids',
                   '_resolveBones', '_humanoidBones', '_park', '_releaseHair', '_combHair']) {
    self[m] = (Avatar.prototype as any)[m];
  }
  self._findWings();
  self.tick = function (dt = 1 / 60) {
    if (!this._limp) this._flap(dt);
    root.updateMatrixWorld(true);
  };
  const tipY = (n: string) => {
    root.updateMatrixWorld(true);
    return nodes[n].getWorldPosition(new THREE.Vector3()).y;
  };
  const tipPos = (n: string) => {
    root.updateMatrixWorld(true);
    return nodes[n].getWorldPosition(new THREE.Vector3());
  };
  return { self, nodes, tipY, tipPos };
}

console.log('\nan animation over a held pose (wave while crouching):');
{
  // a clip that HOLDS STILL is the case that bit: nothing rewrites a bone the pose tilted
  const { self, nodes } = stand({ constant: true });
  self.tick();
  const clipHips = nodes.hips.quaternion.clone(), clipArm = nodes.leftUpperArm.quaternion.clone();
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.54);
  const wave = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.2);
  const q = (x: any) => [x.x, x.y, x.z, x.w];
  self.setPose({ hips: q(tilt) });
  for (let i = 0; i < 60; i++) self.tick();
  check('the pose holds the hips', nodes.hips.quaternion.angleTo(tilt) < 1e-3);

  self.playAnimation({ dur: 1, tracks: { leftUpperArm: [{ t: 0, q: q(wave) }, { t: 1, q: q(wave) }] } });
  self._anims[0].start = 0;
  let now = 0;
  for (let i = 0; i < 40; i++) self.tick(1 / 60, now += 1000 / 60);   // past the ~120ms ease-in, inside the 1s
  check('while the wave plays, the crouch keeps its hips', nodes.hips.quaternion.angleTo(tilt) < 1e-3,
    `${nodes.hips.quaternion.angleTo(tilt).toFixed(3)} rad off`);
  check('...and the arm is the wave\'s', nodes.leftUpperArm.quaternion.angleTo(wave) < 1e-2,
    `${nodes.leftUpperArm.quaternion.angleTo(wave).toFixed(3)} rad off`);
  check('...in its own slot — the pose was not displaced', self._override?.kind === 'pose' && self._anims?.[0]?.kind === 'anim');

  for (let i = 0; i < 120; i++) self.tick(1 / 60, now += 1000 / 60);
  check('when the wave ends it lets go', self._anims.length === 0);
  check('...the arm goes back to the clip, not the last frame of the wave', nodes.leftUpperArm.quaternion.angleTo(clipArm) < 1e-3,
    `${nodes.leftUpperArm.quaternion.angleTo(clipArm).toFixed(3)} rad off`);
  check('...and the crouch is still held', nodes.hips.quaternion.angleTo(tilt) < 1e-3);

  self.clearPose();
  for (let i = 0; i < 90; i++) self.tick(1 / 60, now += 1000 / 60);
  check('releasing the pose leaves NO tilt on a still clip', nodes.hips.quaternion.angleTo(clipHips) < 1e-3,
    `${nodes.hips.quaternion.angleTo(clipHips).toFixed(3)} rad off`);
}
{
  const { self, nodes } = stand({ constant: true });
  self.tick();
  const clipHips = nodes.hips.quaternion.clone();
  const tilt = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.54);
  self.setPose({ hips: [tilt.x, tilt.y, tilt.z, tilt.w] });
  for (let i = 0; i < 60; i++) self.tick();
  self.setPose({ leftUpperArm: [0, 0, 0.38, 0.92] });
  for (let i = 0; i < 5; i++) self.tick();
  check('a pose REPLACED by one without hips hands the hips back (the tilt that outlived the crouch)',
    nodes.hips.quaternion.angleTo(clipHips) < 1e-3, `${nodes.hips.quaternion.angleTo(clipHips).toFixed(3)} rad off`);
}

console.log('\nanimation layers (merge) and replace:');
{
  const { self, nodes } = stand({ constant: true });
  self.tick();
  const clipHead = nodes.head.quaternion.clone();
  const A = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), -1.0);
  const B = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 0.8);
  const q = (x: any) => [x.x, x.y, x.z, x.w];
  const hold = (x: any, d = 3) => [{ t: 0, q: q(x) }, { t: d, q: q(x) }];
  let now = 0;
  const run = (n: number) => { for (let i = 0; i < n; i++) self.tick(1 / 60, now += 1000 / 60); };
  self.playAnimation({ dur: 3, replace: false, tracks: { leftUpperArm: hold(A), head: hold(B) } });
  self._anims[0].start = now;
  run(30);
  const C = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1.0);
  self.playAnimation({ dur: 3, replace: false, tracks: { leftUpperArm: hold(C) } });
  self._anims.at(-1).start = now;
  run(30);
  check('a second animation takes only its bones: the arm is the new one', nodes.leftUpperArm.quaternion.angleTo(C) < 1e-2,
    `${nodes.leftUpperArm.quaternion.angleTo(C).toFixed(3)} rad off`);
  check('...and the first keeps playing on the rest (head)', nodes.head.quaternion.angleTo(B) < 1e-2,
    `${nodes.head.quaternion.angleTo(B).toFixed(3)} rad off`);
  check('...as two layers', self._anims.length === 2);
  self.playAnimation({ dur: 3, replace: true, tracks: { leftUpperArm: hold(A) } });
  self._anims.at(-1).start = now;
  run(30);
  check('replace ends every other layer', self._anims.length === 1);
  check('...and hands the head back to the clip', nodes.head.quaternion.angleTo(clipHead) < 1e-3,
    `${nodes.head.quaternion.angleTo(clipHead).toFixed(3)} rad off`);
}

console.log('\npose teardown and legacy animation compatibility:');
{
  const { self, nodes } = stand({ constant: true });
  self.tick();
  const idle = nodes.leftUpperArm.quaternion.clone();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1).toArray();
  self.playAnimation({ dur: 1, loop: true, replace: false, tracks: { leftUpperArm: [{ t: 0, q }] } });
  self._anims[0].start = 0;
  for (let i = 0; i < 60; i++) self.tick(1 / 60, i * 1000 / 60);
  // the mesh survives a same-avatar takeover; only unrelated UI seams are stubbed
  for (const name of ['setTyping', 'clearReach', 'setGazeTarget', 'setClip']) self[name] = () => {};
  Avatar.prototype.resetTransients.call(self);
  for (let i = 60; i < 300; i++) self.tick(1 / 60, i * 1000 / 60);
  check('a takeover ends the predecessor’s looping animation', !self._anims?.length);
  check('...and hands its bones back to the idle clip', nodes.leftUpperArm.quaternion.angleTo(idle) < 1e-3);
}
{
  const { self, nodes } = stand({ constant: true });
  self.tick();
  const idle = nodes.leftUpperArm.quaternion.clone();
  const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), 1).toArray();
  const tracks = { leftUpperArm: [{ t: 0, q }] };
  self.playAnimation({ dur: 1, loop: true, tracks }); // legacy wire: no replace flag
  self._anims[0].start = 0;
  for (let i = 0; i < 60; i++) self.tick(1 / 60, i * 1000 / 60);
  self.playAnimation({ dur: 1, tracks: { head: [{ t: 0, q }] } });
  check('an omitted wire replace flag ends older animation layers', self._anims.length === 1);
  check('...including bones absent from the new animation', nodes.leftUpperArm.quaternion.angleTo(idle) < 1e-3);
}
{
  // setPose -> raw writes -> REAL dispose -> another wearer on the same nodes; pool reset only knows humanoid TRS
  const scene = new THREE.Group(), head = new THREE.Bone(), custom = new THREE.Bone();
  head.name = 'Head'; custom.name = 'Custom'; scene.add(head); head.add(custom);
  head.scale.set(1.2, 1.2, 1.2); custom.position.set(0, .2, 0);
  custom.matrixAutoUpdate = false; custom.updateMatrix();
  const rest = {};
  scene.traverse((n: any) => { if (n.isBone) rest[n.name] = { p: n.position.toArray(), q: n.quaternion.toArray(), s: n.scale.toArray() }; });
  const vrm = { scene, userData: { boneRest: rest }, humanoid: {
    getNormalizedBoneNode: (n: string) => n === 'head' ? head : null,
    getRawBoneNode: (n: string) => n === 'head' ? head : null,
  } };
  const wearer = () => Object.assign(Object.create(Avatar.prototype), {
    vrm, root: scene, gaze: new THREE.Object3D(), label: new THREE.Sprite(),
    mixer: new THREE.AnimationMixer(scene), _composed: new Map(),
  });
  const first = wearer();
  first.setPose({ head: { s: 2 }, Custom: { q: [0, 0, Math.sin(.3), Math.cos(.3)], t: [.25, 0, 0] } });
  first._override.weight = 1; first._applyRawPose();
  check('fixture really scales and moves the raw bones', head.scale.x > 2 && custom.position.x > .1);
  first.dispose();
  check('dispose restores the authored scale before pooling', Math.abs(head.scale.x - 1.2) < 1e-9);
  check('dispose restores custom translation and rotation', custom.position.distanceTo(new THREE.Vector3(0, .2, 0)) < 1e-9 && custom.quaternion.angleTo(new THREE.Quaternion()) < 1e-6);
  check('dispose rebuilds manually updated bone matrices', new THREE.Vector3().setFromMatrixPosition(custom.matrix).distanceTo(custom.position) < 1e-9);
  const second = wearer();
  second.setPose({ head: { s: 2 } }); second._override.weight = 1; second._applyRawPose();
  check('the next wearer scales from rest, without compounding the previous pose', Math.abs(head.scale.x - 2.4) < 1e-9);
  first.dispose();
  check('repeated disposal cannot clear the next wearer’s pose', Math.abs(head.scale.x - 2.4) < 1e-9);
  second.dispose();
}

console.log('\nwings:');
{
  const { self, nodes } = wingStand();
  check('every wing bone is found (4 chains x 3)', self._wings?.length === 12,
    `${self._wings?.length ?? 0} found`);
  check('...at the depth its NAME says, not a count of underscores',
    JSON.stringify(self._wings.map((w: any) => w.depth).sort()) === '[0,0,0,0,1,1,1,1,2,2,2,2]',
    self._wings.map((w: any) => `${w.node.name}=${w.depth}`).join(' '));
  check('roots are visited before tips',
    self._wings.every((w: any, i: number) => i === 0
      || w.depth >= self._wings[i - 1].depth));
  check('sides are read off the name',
    self._wings.filter((w: any) => w.side === 1).length === 6
    && self._wings.filter((w: any) => w.side === -1).length === 6);
  // first look must not change a body's rest: wings are springbones posed before the first update(), so capturing
  // the live pose froze a ragdolled pose as rest
  {
    const posed = wingStand();
    const authored = new Map();
    for (const w of posed.self._wings) authored.set(w.node, w.rest.clone());
    // three-vrm has bent every wing, as on a fallen body; the springBoneManager remembers the authored pose
    const bent = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.2);
    const joints = new Set();
    for (const [node, q] of authored) {
      node.quaternion.copy(bent);
      joints.add({ bone: node, _initialLocalRotation: q.clone() });
    }
    posed.self.vrm.springBoneManager = { joints };
    posed.self._wings = undefined;
    posed.self._findWings();
    const worst = Math.max(...posed.self._wings.map((w: any) =>
      w.rest.angleTo(authored.get(w.node))));
    check('rest is the AUTHORED pose even when the bones are already bent',
      worst < 1e-6, `${(worst * 180 / Math.PI).toFixed(1)}° off`);
  }

  check('the authored pose is shared with the ragdoll',
    self.__wingRest instanceof Map && self.__wingRest.size === 12);
  // referenced so the fixture can't be optimised into nothing
  check('the marker hangs off the OUTERMOST segment',
    nodes.L_Wing_Upper_tip.parent === nodes.L_Wing_Upper_2);
}

{
  const { self, tipY, tipPos } = wingStand();
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  const dt = 1 / 120;
  const frames = Math.round(1 / (WING_IDLE.hz * dt));      // one full flap
  const track: Record<string, number[]> = {};
  const p0: Record<string, any> = {};
  for (const n of ['L_Wing_Upper_tip', 'R_Wing_Upper_tip',
                   'L_Wing_Lower_tip', 'R_Wing_Lower_tip']) {
    track[n] = []; p0[n] = tipPos(n).clone();
  }
  for (let i = 0; i <= frames; i++) {
    self.tick(dt);
    for (const n of Object.keys(track)) track[n].push(tipY(n));
  }
  const span = (n: string) => Math.max(...track[n]) - Math.min(...track[n]);
  check('the tips actually move', Object.keys(track).every((n) => span(n) > 0.02),
    Object.keys(track).map((n) => `${n} ${span(n).toFixed(3)}m`).join(' '));

  // THE AXIS test: the flap turns about the body's FORWARD axis, so with the sweep off every tip stays in the frontal plane
  {
    const sweep0 = WING_IDLE.sweep;
    WING_IDLE.sweep = 0;
    const rep = wingStand();
    const fore: Record<string, number[]> = {};
    for (const n of Object.keys(track)) fore[n] = [];
    for (let i = 0; i <= frames; i++) {
      rep.self.tick(dt);
      for (const n of Object.keys(track)) fore[n].push(rep.tipPos(n).z);
    }
    WING_IDLE.sweep = sweep0;
    const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
    const worst = Math.max(...Object.keys(fore).map((n) => rng(fore[n])));
    check('the flap turns about the body FORWARD axis (no fore/aft without sweep)',
      worst < 0.001, `${(worst * 1000).toFixed(2)}mm of fore/aft leaked in`);
  }

  // symmetry: both wings rise together (a sign error, one up one down, is the likeliest mistake and looks deliberate)
  const corr = (a: string, b: string) => {
    const A = track[a], B = track[b];
    const ma = A.reduce((s, v) => s + v, 0) / A.length;
    const mb = B.reduce((s, v) => s + v, 0) / B.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < A.length; i++) {
      num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };
  check('left and right rise TOGETHER (mirrored, not opposed)',
    corr('L_Wing_Upper_tip', 'R_Wing_Upper_tip') > 0.99,
    `r=${corr('L_Wing_Upper_tip', 'R_Wing_Upper_tip').toFixed(3)}`);
  check('the upper and lower pairs are in sync',
    corr('L_Wing_Upper_tip', 'L_Wing_Lower_tip') > 0.9,
    `r=${corr('L_Wing_Upper_tip', 'L_Wing_Lower_tip').toFixed(3)}`);
}

{
  // THE SWEEP: tips also travel forward and back, or the flap reads as a hinge. Three things must hold; a no-op passes none.
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  const { self, tipPos } = wingStand();
  const dt = 1 / 120;
  const frames = Math.round(1 / (WING_IDLE.hz * dt));
  const ys: Record<string, number[]> = {}, zs: Record<string, number[]> = {};
  const names = ['L_Wing_Upper_tip', 'R_Wing_Upper_tip'];
  for (const n of names) { ys[n] = []; zs[n] = []; }
  for (let i = 0; i <= frames; i++) {
    self.tick(dt);
    for (const n of names) { const p = tipPos(n); ys[n].push(p.y); zs[n].push(p.z); }
  }
  const rng = (a: number[]) => Math.max(...a) - Math.min(...a);
  const corr = (A: number[], B: number[]) => {
    const ma = A.reduce((s, v) => s + v, 0) / A.length;
    const mb = B.reduce((s, v) => s + v, 0) / B.length;
    let num = 0, da = 0, db = 0;
    for (let i = 0; i < A.length; i++) {
      num += (A[i] - ma) * (B[i] - mb); da += (A[i] - ma) ** 2; db += (B[i] - mb) ** 2;
    }
    return num / Math.sqrt(da * db);
  };
  const fa = rng(zs.L_Wing_Upper_tip);
  check('the tips also travel FORE AND AFT, not only in the frontal plane',
    fa > 0.02, `${(fa * 100).toFixed(1)}cm fore/aft`);
  check('...both wings sweeping forward together',
    corr(zs.L_Wing_Upper_tip, zs.R_Wing_Upper_tip) > 0.99,
    `r=${corr(zs.L_Wing_Upper_tip, zs.R_Wing_Upper_tip).toFixed(3)}`);
  // quadrature opens the path into an ellipse; in phase (r near ±1) the tip runs a tilted line, still a hinge
  const q = Math.abs(corr(ys.L_Wing_Upper_tip, zs.L_Wing_Upper_tip));
  check('...and the tip path is an ellipse, not a tilted straight line',
    q < 0.4, `|r(up, fore)|=${q.toFixed(3)} — 1.0 would be a line`);
}

{
  // no integration: every frame rebuilds from the captured rest, so whole cycles return the start pose
  const { self, nodes } = wingStand();
  const { WING_IDLE } = await import('../client/lib/avatar.js');
  // dt makes a cycle a WHOLE number of frames; a round dt's per-cycle rounding reads as phase drift
  const perCycle = 600;
  const dt = 1 / (WING_IDLE.hz * perCycle);
  self.tick(dt);
  const q0 = nodes.L_Wing_Upper.quaternion.clone();
  for (let c = 0; c < 300; c++) for (let i = 0; i < perCycle; i++) self.tick(dt);
  const drift = nodes.L_Wing_Upper.quaternion.angleTo(q0);
  check('300 cycles later the wing is where it started (no integration)',
    drift < 1e-3, `${(drift * 180 / Math.PI).toFixed(3)}° of drift`);
}

{
  // while limp the flap must not write (the ragdoll owns these bones); standing up eases out of the fallen pose
  const { self, nodes } = wingStand();
  for (let i = 0; i < 40; i++) self.tick();
  (Avatar.prototype as any).setLimp.call(self, true);
  const fallen = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), 1.1);
  nodes.L_Wing_Upper.quaternion.copy(fallen);
  for (let i = 0; i < 40; i++) self.tick();
  check('while limp the flap writes nothing',
    nodes.L_Wing_Upper.quaternion.angleTo(fallen) < 1e-9);

  // through the real setLimp: assigning _limp first would trip its `on === this._limp` guard, and the method never runs
  (Avatar.prototype as any).setLimp.call(self, false);
  check('standing up captures where the sim left each wing',
    self._wings.every((w: any) => w.from) && self._wingBlend === 0);
  self.tick();
  const moved1 = nodes.L_Wing_Upper.quaternion.angleTo(fallen);
  check('...and the first frame back is a step, not a teleport',
    moved1 > 0 && moved1 < 0.25, `${(moved1 * 180 / Math.PI).toFixed(1)}° in one frame`);
  for (let i = 0; i < 120; i++) self.tick();
  check('...and the blend completes', self._wingBlend === 1);
}

// ---- one author per hair bone ----------------------------------------------
// two simulators (ammodoll's Bullet in 'me-drive', three-vrm's springBoneManager in 'me-update') can write the hair;
// the only observable is WHICH ran last
{
  console.log('\nhair ownership while the sim drives it:');
  const mk = () => {
    const calls: string[] = [];
    const self: any = {
      _limp: false, _wings: null, _lids: null, _eyes: null, __simHair: false,
      vrm: {
        springBoneManager: { update: () => calls.push('spring'), reset: () => calls.push('reset') },
        update: function (d: number) { this.springBoneManager?.update(d); },
      },
    };
    // the slice of Avatar.update that decides it
    self.tick = function (dt = 1 / 60) {
      const sbm = this.__simHair ? this.vrm.springBoneManager : null;
      if (sbm) this.vrm.springBoneManager = null;
      this.vrm.update(dt);
      if (sbm) this.vrm.springBoneManager = sbm;
    };
    return { self, calls };
  };
  const a = mk();
  a.self.tick();
  check('a standing body runs three-vrm springbones (hair moves while walking)',
    a.calls.includes('spring'));

  const b = mk();
  b.self._limp = true; b.self.__simHair = true;
  b.calls.length = 0;
  for (let i = 0; i < 10; i++) b.self.tick();
  check('...but not while a local sim owns those same bones',
    !b.calls.includes('spring'), `${b.calls.length} springbone updates ran`);
  check('...and the manager is restored, not lost',
    b.self.vrm.springBoneManager?.update != null);

  // handing the hair back must not COMB it: joint.reset() restores _initialLocalRotation, snapping the fallen shape
  {
    const q = (x: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x);
    const bone = { quaternion: q(1.1) };                 // where the tumble left it
    const joint = { bone, _initialLocalRotation: q(0) }; // combed
    const self: any = {
      __simHair: true, _limp: true,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: {
          joints: new Set([joint]),
          reset() { bone.quaternion.copy(joint._initialLocalRotation); },
        },
      },
    };
    self._releaseHair = (Avatar.prototype as any)._releaseHair;
    self._combHair = (Avatar.prototype as any)._combHair;
    self._releaseHair();
    check('releasing the hair KEEPS the pose the fall left',
      bone.quaternion.angleTo(q(1.1)) < 1e-6,
      `moved ${(bone.quaternion.angleTo(q(1.1)) * 180 / Math.PI).toFixed(1)}°`);
    check('...and puts the combed rest back, so it still combs out afterwards',
      joint._initialLocalRotation.angleTo(q(0)) < 1e-6);
    check('...and ownership is released', self.__simHair === false);
  }

  // a limp body with no sim hangs its hair on the world: the springs are authored for standing, so a body on its side
  // would pull its hair sideways
  {
    const { LIMP_SPRINGS } = await import('../client/lib/avatar.js');
    const hips = { name: 'Hip' };
    const joint: any = {
      settings: { stiffness: 1.0, gravityPower: 0.02 }, _center: hips,
      bone: { quaternion: new THREE.Quaternion() },
      _initialLocalRotation: new THREE.Quaternion(),
    };
    let resets = 0;
    const self: any = {
      _limp: false, __simHair: false,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: { joints: new Set([joint]), reset() { resets++; } },
      },
    };
    self._springsLimp = (Avatar.prototype as any)._springsLimp;
    self._springsResync = (Avatar.prototype as any)._springsResync;
    self._springsLimp(false);
    check('a standing body keeps the rig\'s own spring settings',
      joint.settings.stiffness === 1.0 && joint.settings.gravityPower === 0.02);
    self._springsLimp(true);
    check('a limp body with no sim lets gravity win',
      joint.settings.gravityPower >= LIMP_SPRINGS.gravity
      && joint.settings.stiffness < 1.0,
      `stiffness ${joint.settings.stiffness}, gravity ${joint.settings.gravityPower}`);
    check('...and gravity is a FLOOR, not a replacement',
      joint.settings.gravityPower === Math.max(0.02, LIMP_SPRINGS.gravity));
    self._springsLimp(false);
    check('...restored exactly on standing, so nothing accumulates',
      joint.settings.stiffness === 1.0 && joint.settings.gravityPower === 0.02);
    // the CENTER makes a carried body's hair rotate rigidly with it: the tail state lives in hip space
    self._springsLimp(true);
    check('a limp body simulates its hair in the WORLD, not in its hips',
      joint._center === null);
    check('...re-deriving the tails, which lived in the frame just changed',
      resets > 0);
    self._springsLimp(false);
    check('...and the hips center comes back on standing',
      joint._center === hips);
    // idempotent: update() calls it every frame
    for (let i = 0; i < 5; i++) self._springsLimp(true);
    check('...and repeated calls do not compound the factor',
      Math.abs(joint.settings.stiffness - 1.0 * LIMP_SPRINGS.stiffness) < 1e-9,
      `stiffness ${joint.settings.stiffness}`);
  }

  // letting go of a DRAGGED body disposes its doll mid-tumble: the hair comes back live, or it freezes mid-air
  {
    const q = (x: number) => new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), x);
    const bone = { quaternion: q(0.9) };
    const joint = { bone, _initialLocalRotation: q(0) };
    const self: any = {
      __simHair: true, _limp: true,
      vrm: {
        scene: { updateMatrixWorld() {} },
        springBoneManager: {
          joints: new Set([joint]),
          reset() { bone.quaternion.copy(joint._initialLocalRotation); },
        },
      },
    };
    self._releaseHair = (Avatar.prototype as any)._releaseHair;
    self._combHair = (Avatar.prototype as any)._combHair;
    self._releaseHair({ adopt: true });
    check('a doll disposing mid-tumble hands the hair back LIVE, not frozen',
      self.__simHair === false);
    check('...keeping the pose it was dropped in',
      bone.quaternion.angleTo(q(0.9)) < 1e-6);
    check('...with the springs now resting THERE, so it falls on with her',
      joint._initialLocalRotation.angleTo(q(0.9)) < 1e-6);
    self._combHair();
    check('...and getting up restores the authored shape (no ratchet)',
      joint._initialLocalRotation.angleTo(q(0)) < 1e-6);
  }

  // a REMOTE body goes limp with no doll of its own: suppressing there would freeze its hair entirely
  const c = mk();
  c.self._limp = true;            // limp, but nothing claimed the hair
  c.calls.length = 0;
  c.self.tick();
  check('a limp REMOTE (no local sim) keeps its springbone hair',
    c.calls.includes('spring'));
}

{
  // a rig with no wings must not cost anything or throw
  const root = new THREE.Object3D();
  const self: any = { _limp: false, root, vrm: { scene: root, humanoid: {} } };
  self._findWings = (Avatar.prototype as any)._findWings;
  self._findWings();
  check('a wingless rig finds nothing and says so', self._wings === null);
}

console.log('\neased crossfade, interrupted (pre-review B2):');
{
  // walk → (eased, 0.5 s) jump → (linear) idle inside the ease: walk must NOT stay parked at a half weight
  const { self } = stand();
  const mk = (name: string) => { const c = new THREE.AnimationClip(name, 1, [new THREE.QuaternionKeyframeTrack('hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]); const a = self.mixer.clipAction(c); a.enabled = true; a.setEffectiveWeight(0); a.play(); return a; };
  self.actions.walk = mk('walk'); self.actions.jump = mk('jump'); self.actions.idle = self.actions.idle;
  for (const m of ['setClip', '_setAction']) self[m] = (Avatar.prototype as any)[m];
  self.update = function (dt: number) {   // the slice of update() that owns _xfade
    if (this._xfade) { const x = this._xfade; x.t += dt; const u = Math.min(1, x.t / x.dur), w = u * u * (3 - 2 * u);
      x.in.setEffectiveWeight(x.in0 + (1 - x.in0) * w); if (x.out && x.out !== x.in) x.out.setEffectiveWeight(x.out0 * (1 - w));
      if (u >= 1) { if (x.out && x.out !== x.in) x.out.setEffectiveWeight(0); this._xfade = null; } }
    this.mixer.update(dt);
  };
  self.setClip('walk'); for (let i = 0; i < 30; i++) self.update(1 / 60);
  self.setClip('jump', 0, { fade: 0.5, ease: true }); for (let i = 0; i < 12; i++) self.update(1 / 60);   // 0.2 s into the ease
  const w = (a: any) => +a.getEffectiveWeight().toFixed(2);
  const before = { walk: w(self.actions.walk), jump: w(self.actions.jump), idle: w(self.actions.idle) };
  self.setClip('walk'); self.update(1 / 60);  // LANDED inside the ease, back into WALK mid-fade-out: one frame later nothing jumps by more than 0.1 and weights sum to ~1
  const after = { walk: w(self.actions.walk), jump: w(self.actions.jump), idle: w(self.actions.idle) };
  const maxMove = Math.max(...(['walk', 'jump', 'idle'] as const).map((k) => Math.abs(after[k] - before[k])));
  const sum = after.walk + after.jump + after.idle;
  check('a landing inside the ease moves no weight by more than 0.1 in one frame', maxMove <= 0.1, `before ${JSON.stringify(before)} after ${JSON.stringify(after)}`);
  check('...and the weights still sum to ~1', sum > 0.95 && sum < 1.05, `sum ${sum.toFixed(2)}`);
  for (let i = 0; i < 59; i++) self.update(1 / 60);                                                    // 1 s later
  self.setClip('idle'); for (let i = 0; i < 60; i++) self.update(1 / 60);   // then stop: 1 s later
  check('walk faded out after the ease was cut short', w(self.actions.walk) < 0.05, `walk ${w(self.actions.walk)} jump ${w(self.actions.jump)} idle ${w(self.actions.idle)}`);
  check('idle owns the body', w(self.actions.idle) > 0.95, `idle ${w(self.actions.idle)}`);
}

console.log('\nthe capsule stand-in can be measured and reached (round 2 N1):');
{
  const { makeCapsuleVrm } = await import('../client/lib/capsulebody.js');
  const v: any = makeCapsuleVrm(); v.scene.updateMatrixWorld(true);
  const self: any = { vrm: v, root: v.scene, _reach: new Map(), _limp: false };
  for (const m of ['setReach', '_measureChain', 'clearReach', 'reachStatus', 'restBonePositions', '_humanoidBones', '_resolveBones']) self[m] = (Avatar.prototype as any)[m];
  let threw: any = null, got: any = null;
  try { got = self.setReach('rightHand', [0.3, 1.2, 0.4]); } catch (e) { threw = e; }
  check('setReach on the capsule does not throw', !threw, threw ? String(threw?.message).slice(0, 80) : 'no throw');
  check('...and the chain measured (setReach returned true)', got === true, `returned ${got}`);
  const chain: any = threw ? null : self._measureChain('rightHand');
  check('upper/lower arm lengths read off the puppet', !!chain && chain.L1 > 0.2 && chain.L2 > 0.2, chain ? `L1 ${chain.L1?.toFixed(2)} L2 ${chain.L2?.toFixed(2)}` : 'no chain');
}

console.log('\nmeasured jump take-off (#196 review B2):');
{
  // the jump starts at takeoff (hips rising back through rest), measured from the hips track through the real setClip;
  // each case needs its own clip (memo on clip.userData.takeoff)
  const hips = (times: number[], ys: number[]) =>
    new THREE.VectorKeyframeTrack('hips.position', times, ys.flatMap((y) => [0, y, 0]));
  const jumpClip = (times: number[], ys: number[], name = 'jump') =>
    new THREE.AnimationClip(name, 1, [hips(times, ys)]);

  const timeFor = (clip: THREE.AnimationClip) => {
    const { self } = stand();
    for (const m of ['setClip', '_setAction']) self[m] = (Avatar.prototype as any)[m];
    const a = self.mixer.clipAction(clip); a.enabled = true; a.setEffectiveWeight(0); a.play();
    self.actions.jump = a;
    self.setClip('jump');
    return a.time;
  };

  // [label, hips times, hips heights, the take-off a.time must read]; rest is the first key (.864, the real jump.vrma's)
  const R = [0, 0.33, 0.50, 0.75], RY = [0.864, 0.494, 0.870, 1.20];
  const SIX = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
  const CASES: [string, number[], number[], number][] = [
    ['the real shape: where the hips rise back through rest, not frame 0 nor the squat\'s bottom', R, RY, 0.50],
    ['a clip that only rises has no take-off to find', [0, 0.2, 0.4], [0.864, 0.9, 1.3], 0],
    // the dip is sought in the FIRST HALF, so the track needs enough keys: with 3, `half` is 1 and the 1 cm guard never runs
    ['a sub-centimetre wobble is not a dip (the 1 cm guard, exercised)', SIX, [0.864, 0.860, 0.858, 0.870, 1.10, 1.30], 0],
    ['…while the same shape with a real dip finds the rise', SIX, [0.864, 0.700, 0.494, 0.870, 1.10, 1.30], 0.3],
    ['a later, deeper landing crouch is not the take-off (the first-half search)', [...R, 0.95, 1.10, 1.30], [...RY, 0.700, 0.400, 0.870], 0.50],
    // the guard is bound from above too: 10 cm would call a small character's jump noise
    ['a shallow (4 cm) real dip is still a take-off', [0, 0.1, 0.2, 0.33, 0.50, 0.75], [0.864, 0.836, 0.820, 0.870, 1.10, 1.30], 0.33],
    ['a key exactly at rest height IS the take-off (`<` vs `<=`)', SIX, [0.864, 0.700, 0.494, 0.864, 1.10, 1.30], 0.3],
  ];
  for (const [label, times, ys, want] of CASES) {
    const got = timeFor(jumpClip(times, ys));
    check(`take-off: ${label}`, Math.abs(got - want) < 1e-6, `a.time = ${got}, want ${want}`);
  }
  const noHips = timeFor(new THREE.AnimationClip('jump', 1, [new THREE.QuaternionKeyframeTrack('hips.quaternion', [0, 1], [0, 0, 0, 1, 0, 0, 0, 1])]));
  check('take-off: a clip with no hips track starts at 0 rather than throwing', noHips === 0, `a.time = ${noHips}`);

  // THE CACHE ships: production reuses one loaded jump.vrma clip, so from the second jump only the memo reaches the mixer
  const shared = jumpClip(R, RY), times = [timeFor(shared), timeFor(shared), timeFor(shared)];
  check('a second and third jump on the same clip start at the same take-off (a poisoned memo can\'t ship)',
    times.every((t) => Math.abs(t - 0.50) < 1e-6), JSON.stringify(times));

  // only the jump slot is re-timed: every other slot starts at 0, even with a findable dip in its hips track
  const { CLIP_SLOTS } = await import('../shared/clipdefs.js');
  for (const slot of CLIP_SLOTS.filter((x: string) => x !== 'jump')) {
    const { self } = stand();
    for (const m of ['setClip', '_setAction']) self[m] = (Avatar.prototype as any)[m];
    const wa = self.mixer.clipAction(jumpClip([0, 0.1, 0.2, 0.33, 0.50, 0.75], [0.864, 0.700, 0.494, 0.500, 0.870, 1.20], slot));
    wa.enabled = true; wa.setEffectiveWeight(0); wa.play();
    self.actions[slot] = wa; self.setClip(slot);
    check(`the ${slot} slot is not re-timed`, wa.time === 0, `${slot} time = ${wa.time}`);
  }
}

// setSeatBlend clears currentSlot, so a seat gate on it never met a seated body; playingSlot is the slot carrying
// the body (currentSlot outside a blend, the heaviest clip's slot inside)
{
  const sitchair = { n: 'sitchair' }, sit = { n: 'sit' }, idle = { n: 'idle' };
  const play = (Avatar.prototype as any).playingSlot;
  const off = { currentSlot: 'walk', _sb: null, actions: { sitchair, sit, idle } };
  check('no seat blend: playingSlot is currentSlot', play.call(off) === 'walk');
  const on = { currentSlot: null, _sb: { w: new Map<any, number>([[idle, 0.2], [sitchair, 0.8]]) }, actions: { sitchair, sit, idle } };
  check('in a seat blend: the heaviest clip\'s slot', play.call(on) === 'sitchair', String(play.call(on)));
  const fell = { currentSlot: null, _sb: { w: new Map<any, number>([[sit, 1]]) }, actions: { sitchair: undefined, sit, idle } };
  check('…a fallback reads as the slot it really is (the gate then says pose fallback)', play.call(fell) === 'sit');
  check('…and a blend with nothing in it yet is no slot', play.call({ currentSlot: null, _sb: { w: new Map() }, actions: {} }) === null);
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
