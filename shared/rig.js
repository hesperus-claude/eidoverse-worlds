// CPU rig primitives for runtime body perception and physics. GLB bytes or parsed node data in; no I/O, fixtures,
// renderer or test dependencies here.

/** The JSON chunk of a .glb / .vrm. */
export function glbJson(buf) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  if (dv.getUint32(0, true) !== 0x46546c67) throw new Error('not a GLB');
  let off = 12;
  while (off < dv.byteLength) {
    const len = dv.getUint32(off, true), type = dv.getUint32(off + 4, true);
    if (type === 0x4e4f534a) {
      return JSON.parse(new TextDecoder().decode(buf.subarray(off + 8, off + 8 + len)));
    }
    off += 8 + len + ((4 - (len % 4)) % 4);
  }
  throw new Error('no JSON chunk');
}

/** VRM0 normalized bones have a half-turn about Y relative to the root, as the browser's -Z → +Z conversion. */
export function isVrm0(g) {
  return !g.extensions?.VRMC_vrm && !!g.extensions?.VRM;
}

export function humanBones(g) {
  const v1 = g.extensions?.VRMC_vrm?.humanoid?.humanBones;
  if (v1) return Object.fromEntries(Object.entries(v1).map(([b, v]) => [b, v.node]));
  const v0 = g.extensions?.VRM?.humanoid?.humanBones;
  if (v0) {
    // three-vrm's VRM0 → VRM1 vocabulary: the old thumb names would shift every thumb rotation onto the wrong joint
    const rename = { leftThumbProximal: 'leftThumbMetacarpal', leftThumbIntermediate: 'leftThumbProximal',
      rightThumbProximal: 'rightThumbMetacarpal', rightThumbIntermediate: 'rightThumbProximal' };
    return Object.fromEntries(v0.map((h) => [rename[h.bone] ?? h.bone, h.node]));
  }
  return null;
}

// The parent chain the ragdoll's particle model assumes: upperChest/shoulder collapse onto it (goLimp parks them at rest).
export const PARENT = {
  hips: null, spine: 'hips', chest: 'spine', neck: 'chest', head: 'neck',
  leftUpperArm: 'chest', leftLowerArm: 'leftUpperArm', leftHand: 'leftLowerArm',
  rightUpperArm: 'chest', rightLowerArm: 'rightUpperArm', rightHand: 'rightLowerArm',
  leftUpperLeg: 'hips', leftLowerLeg: 'leftUpperLeg', leftFoot: 'leftLowerLeg',
  rightUpperLeg: 'hips', rightLowerLeg: 'rightUpperLeg', rightFoot: 'rightLowerLeg',
};

/** Binds the host's vector/matrix API, so shared parsing makes no package-layout assumptions. */
export function rigMath(THREE) {
  /** World rest position of any node, by walking the TRS tree. */
  function worldPositions(g) {
    const world = worldMatrices(g);
    return (i) => new THREE.Vector3().setFromMatrixPosition(world(i));
  }

  /** The axes a node's own scale acts in, which a skinned rig rarely leaves aligned with the model's. */
  function worldRotations(g) {
    const world = worldMatrices(g);
    return (i) => {
      const q = new THREE.Quaternion();
      world(i).decompose(new THREE.Vector3(), q, new THREE.Vector3());
      return q;
    };
  }

  function worldMatrices(g) {
    const parent = new Map();
    g.nodes.forEach((n, i) => (n.children ?? []).forEach((c) => parent.set(c, i)));
    const memo = new Map();
    // full matrices: ancestor SCALE is load-bearing (glb2vrm bakes one on the Armature); dropping it shrinks the skeleton
    // and floats the streamed root above the floor
    const localMatrix = (n) => (n.matrix
      ? new THREE.Matrix4().fromArray(n.matrix)
      : new THREE.Matrix4().compose(
        new THREE.Vector3(...(n.translation ?? [0, 0, 0])),
        new THREE.Quaternion(...(n.rotation ?? [0, 0, 0, 1])),
        new THREE.Vector3(...(n.scale ?? [1, 1, 1])),
      ));
    const world = (i) => {
      if (memo.has(i)) return memo.get(i);
      const m = localMatrix(g.nodes[i]);
      const p = parent.get(i);
      const out = p === undefined ? m : world(p).clone().multiply(m);
      memo.set(i, out);
      return out;
    };
    return world;
  }

  /** Build private normalized bone nodes from world rest positions. */
  function makeAvatar(P, { realParent = null, vrm0 = false } = {}) {
    const root = new THREE.Object3D();
    // three-vrm's VRM0 half-turn, reproduced as a pivot, so normalized bones read the same 180° as in the browser
    const pivot = new THREE.Object3D();
    if (vrm0) pivot.rotation.y = Math.PI;
    root.add(pivot);
    const nodes = {};
    // `realParent` builds the rig's ACTUAL humanoid hierarchy, so `d.parent` is the node the shipped rig would give
    const par = realParent ?? PARENT;
    const order = Object.keys(realParent ? P : PARENT).filter((j) => P[j]);
    const depth = (j) => { let d = 0, k = j; while (par[k]) { k = par[k]; if (++d > 40) break; } return d; };
    order.sort((a, b) => depth(a) - depth(b));
    for (const j of order) {
      const n = new THREE.Object3D();
      n.name = j;
      const p = par[j];
      const base = p && P[p] ? P[p] : new THREE.Vector3(0, 0, 0);
      n.position.copy(P[j]).sub(base);
      ((p && nodes[p]) ? nodes[p] : pivot).add(n);
      nodes[j] = n;
    }
    root.updateMatrixWorld(true);

    // `pivot` is this stand-in's vrm.scene, where body size lives (client/lib/avatar.js _applyBodyScale). Never aliased
    // as vrm.scene: its readers (landmarks.js) expect a mesh-bearing scene.
    const av = {
      root, pivot, nodes, poses: 0, limp: false,
      vrm: { meta: { metaVersion: vrm0 ? "0" : "1" }, humanoid: {
        normalizedRestPose: Object.fromEntries(Object.entries(nodes).map(([k, n]) => [k, { position: n.position.toArray(), rotation: [0, 0, 0, 1] } ])),
        humanBones: Object.fromEntries(Object.keys(nodes).map((k) => [k, {}])),
        getNormalizedBoneNode: (j) => nodes[j] ?? null,
      } },
      setPose() { this.poses++; },
      clearPose() {},
      setLimp(on) { this.limp = !!on; },
      restBonePositions() {
        const saved = Object.values(nodes).map((n) => [n, n.quaternion.clone()]);
        for (const [n] of saved) n.quaternion.identity();
        root.updateMatrixWorld(true);
        const out = {};
        for (const [k, n] of Object.entries(nodes)) out[k] = n.getWorldPosition(new THREE.Vector3());
        for (const [n, q] of saved) n.quaternion.copy(q);
        root.updateMatrixWorld(true);
        return out;
      },
    };

    return av;
  }

  /** Standing height in metres: the humanoid head joint at rest plus a forehead, as client/lib/avatar.js bodyHeight. Meshes
   *  don't count (hair or a crown can't raise it). Null with no humanoid head, or outside 0.5–4 m (the browser clamps). */
  function stature(g) {
    const hb = humanBones(g);
    if (!hb || !Number.isInteger(hb.head)) return null;
    const y = worldPositions(g)(hb.head).y + 0.13;
    return y > 0.5 && y < 4 ? y : null;
  }
  return { worldPositions, worldRotations, makeAvatar, stature };
}
