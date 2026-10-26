// landmarks — where a named contact point (shared/contact.js) actually IS on a particular body: the first surface hit
// casting in toward the bone, never a vertex statistic (a stray vertex is confidently wrong). REST pose; bone-local.

import { THREE } from './core.js';
import { CONTACT_POINTS, contactSeed } from '../../shared/contact.js';
import { bodyFrame, fromBody } from '../../shared/joints.js';

const _v = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _m = new THREE.Matrix3();
const _ray = new THREE.Raycaster();

function meshesOf(scene) {
  const out = [];
  scene.traverse((o) => { if ((o.isMesh || o.isSkinnedMesh) && o.geometry) out.push(o); });
  return out;
}

// bounds are pose-dependent: the skeleton alone leaves last frame's cached bounds, which reject valid rest-pose hits
function refreshBounds(scene, saved) {
  for (const mesh of meshesOf(scene)) {
    if (!mesh.isSkinnedMesh) continue;
    saved.push([mesh, mesh.boundingSphere, mesh.boundingBox]);
    mesh.skeleton.update();
    mesh.boundingSphere = null;
    mesh.boundingBox = null;
    mesh.computeBoundingSphere();
  }
}
function restoreBounds(saved) {
  for (const [mesh, sphere, box] of saved) {
    mesh.boundingSphere = sphere;
    mesh.boundingBox = box;
  }
}

/** A short fan of rays, central first: never accept the body's far side when a ray misses a thin hand or forearm;
 *  nearby rays rescue gaps without averaging points into air. */
function localSurface(meshes, at, dir, radius) {
  const tangent = new THREE.Vector3(0, 1, 0);
  if (Math.abs(tangent.dot(dir)) > 0.9) tangent.set(1, 0, 0);
  tangent.cross(dir).normalize();
  const bitangent = dir.clone().cross(tangent);
  for (const [u, v] of [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]]) {
    const aim = at.clone().addScaledVector(tangent, u * radius * 0.12)
      .addScaledVector(bitangent, v * radius * 0.12);
    _ray.set(aim.addScaledVector(dir, radius), dir.clone().negate());
    _ray.near = 0;
    _ray.far = radius * 1.15;
    _ray.firstHitOnly = false;
    // already flattened: recursion would visit children twice
    const hit = _ray.intersectObjects(meshes, false).find((h) =>
      h.distance > 1e-4 && h.point.distanceTo(at) <= radius);
    if (hit) return hit;
  }
  return null;
}

/** The palm surface, not the wrist pivot; null when the rig supplies no surface. */
export function derivePalmAnchor(avatar, side) {
  const marks = deriveLandmarks(avatar, { palm: {
    bone: side + 'Hand', toward: side + 'MiddleProximal', along: 0.55,
    extendFrom: side + 'LowerArm',
    from: [0, -1, 0], radius: 0.22, tier: 'social',
  } });
  const mark = marks.get('palm');
  return mark?.how === 'surface' ? mark : null;
}

/**
 * Call once per body.
 * @returns {Map<string, {bone: string, node: object, offset: THREE.Vector3,
 *          normal: THREE.Vector3, tier: string, how: 'surface'|'fallback'}>}
 */
export function deriveLandmarks(avatar, specs = CONTACT_POINTS) {
  const h = avatar?.vrm?.humanoid;
  const scene = avatar?.vrm?.scene;
  if (!h || !scene) return new Map();

  // ---- rest pose, restored whatever happens. humanoid.update() is required: the mesh is skinned to the RAW rig,
  // written from the normalized bones only there, or rays hit a skeleton the mesh isn't wearing
  const saved = [];
  for (const name of Object.keys(h.humanBones ?? {})) {
    const n = h.getNormalizedBoneNode(name);
    if (n) { saved.push([n, n.quaternion.clone()]); n.quaternion.identity(); }
  }
  const bounds = [];
  const out = new Map();
  try {
    h.update();
    avatar.root.updateMatrixWorld(true);
    refreshBounds(scene, bounds);
    // ⚠ recompute skinning too: three refreshes boneMatrices only at draw time, so a rest-posed rig is still skinned
    // to the last rendered pose
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
    const P = {};
    for (const name of Object.keys(h.humanBones ?? {})) {
      const n = h.getNormalizedBoneNode(name);
      if (n) P[name] = n.getWorldPosition(new THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    if (!F) return out;

    const meshes = meshesOf(scene);
    if (!meshes.length) return out;

    // the body's own size sets the stand-back and the fallback offset: never hardcoded metres
    const hips = P.hips ? new THREE.Vector3(...P.hips) : null;
    const head = P.head ? new THREE.Vector3(...P.head) : null;
    const scale = (hips && head) ? Math.max(0.2, head.distanceTo(hips)) : 0.6;

    for (const [name, spec] of Object.entries(specs)) {
      const node = h.getNormalizedBoneNode(spec.bone);
      if (!node) continue;
      const seed = contactSeed(P, spec, F, scale);
      if (!seed) continue;
      const at = new THREE.Vector3(...seed.at);
      const radius = scale * (spec.radius ?? 0.45);
      const dirArr = fromBody(spec.from, F);
      const dir = new THREE.Vector3(dirArr[0], dirArr[1], dirArr[2]);
      if (dir.lengthSq() < 1e-9) continue;
      dir.normalize();

      const hit = localSurface(meshes, at, dir, radius);

      let point, normal, how;
      if (hit) {
        point = hit.point.clone();
        normal = hit.face
          ? hit.face.normal.clone().applyMatrix3(_m.getNormalMatrix(hit.object.matrixWorld)).normalize()
          : dir.clone();
        // ⚠ SIGN: the ray travels -dir, so outward normals are +dir; a -dir one began inside the mesh (an accessory)
        if (normal.dot(dir) < 0) normal.negate();
        how = seed.estimated ? 'fallback' : 'surface';
      } else {
        // no surface on that line: sit proportionally off the bone and SAY it's a fallback, never a measurement
        point = at.clone().addScaledVector(dir, Math.min(scale * 0.18, radius * 0.5));
        normal = dir.clone();
        how = 'fallback';
      }

      out.set(name, {
        bone: spec.bone, node, tier: spec.tier, how,
        offset: node.worldToLocal(point.clone()),
        normal: normal.clone().applyQuaternion(_q.copy(node.getWorldQuaternion(_q)).invert()),
      });
    }
  } finally {
    restoreBounds(bounds);
    for (const [n, q] of saved) n.quaternion.copy(q);
    h.update();
    avatar.root.updateMatrixWorld(true);
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
  }
  return out;
}

/** A landmark now, world space, with its normal. `standoff` (m) lifts it off the skin (a fingertip and a palm differ). */
export function landmarkWorld(entry, standoff = 0, outPos = new THREE.Vector3(), outNormal = new THREE.Vector3()) {
  if (!entry?.node) return null;
  outPos.copy(entry.offset);
  entry.node.localToWorld(outPos);
  outNormal.copy(entry.normal).applyQuaternion(entry.node.getWorldQuaternion(_q)).normalize();
  if (standoff) outPos.addScaledVector(outNormal, standoff);
  return { pos: outPos, normal: outNormal };
}

/** Pips with normal whiskers: the derivation can't check itself, so a person must look. A fallback is white. */
export function debugMarkers(avatar, marks, scene, on = true) {
  const key = '__landmarkDebug';
  let group = avatar.root.getObjectByName(key);
  if (group) { group.parent.remove(group); group.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); }); }
  if (!on) return null;

  group = new THREE.Group();
  group.name = key;
  const TIER = { social: 0x44dd66, familiar: 0xffaa22, intimate: 0xff3344 };
  for (const [name, e] of marks) {
    const hit = landmarkWorld(e, 0);
    if (!hit) continue;
    const colour = e.how === 'fallback' ? 0xffffff : (TIER[e.tier] ?? 0x8888ff);
    const pip = new THREE.Mesh(
      new THREE.SphereGeometry(0.012, 10, 8),
      new THREE.MeshBasicMaterial({ color: colour, depthTest: false }));
    pip.position.copy(hit.pos);
    pip.renderOrder = 999;
    pip.name = `lm:${name}`;
    group.add(pip);

    const end = hit.pos.clone().addScaledVector(hit.normal, 0.045);
    const line = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints([hit.pos.clone(), end]),
      new THREE.LineBasicMaterial({ color: colour, depthTest: false }));
    line.renderOrder = 999;
    group.add(line);
  }
  scene.add(group);
  return group;
}

/** Torso half-depth (m, front-to-back at chest height), or null: torsoRadius is a half-WIDTH, so a forearm across
 *  the belly would read as inside the body. */
export function torsoHalfDepth(avatar) {
  const h = avatar?.vrm?.humanoid;
  const scene = avatar?.vrm?.scene;
  if (!h || !scene) return null;
  const saved = [];
  for (const name of Object.keys(h.humanBones ?? {})) {
    const n = h.getNormalizedBoneNode(name);
    if (n) { saved.push([n, n.quaternion.clone()]); n.quaternion.identity(); }
  }
  const bounds = [];
  try {
    h.update();
    avatar.root.updateMatrixWorld(true);
    refreshBounds(scene, bounds);
    const meshes = meshesOf(scene);
    if (!meshes.length) return null;
    for (const o of meshes) o.skeleton?.update?.();
    const P = {};
    for (const name of Object.keys(h.humanBones ?? {})) {
      const n = h.getNormalizedBoneNode(name);
      if (n) P[name] = n.getWorldPosition(new THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    const chest = P.chest ?? P.spine;
    if (!F || !chest) return null;
    const at = new THREE.Vector3(...chest);
    const fwd = new THREE.Vector3(...fromBody([0, 0, 1], F)).normalize();
    const reach = 3 * Math.max(0.2, Math.hypot(
      (P.head?.[0] ?? 0) - chest[0], (P.head?.[1] ?? 0) - chest[1], (P.head?.[2] ?? 0) - chest[2]));
    const hitAt = (dir) => {
      _ray.near = 0; _ray.far = reach * 1.15;
      _ray.set(_v.copy(at).addScaledVector(dir, reach), dir.clone().negate());
      const hits = _ray.intersectObjects(meshes, true);
      const hit = hits.find((x) => x.point && x.distance > 1e-4);
      return hit ? hit.point.distanceTo(at) : null;
    };
    const front = hitAt(fwd), back = hitAt(fwd.clone().negate());
    if (front == null && back == null) return null;
    // the spine isn't centred front-to-back: the mean of the two surfaces
    const d = (front != null && back != null) ? (front + back) / 2 : (front ?? back);
    return d > 1e-3 ? d : null;
  } finally {
    restoreBounds(bounds);
    for (const [n, q] of saved) n.quaternion.copy(q);
    h.update();
    avatar.root.updateMatrixWorld(true);
    for (const o of meshesOf(scene)) o.skeleton?.update?.();
  }
}
