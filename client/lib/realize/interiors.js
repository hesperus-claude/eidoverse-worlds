// interiors — the world's `interior` boxes (things with zone + interior, read through shared/zone.js interiorsOf) into the
// renderer's slots (render/interior.js, born with core.js). Every frame: the holders' live poses (a carried box moves
// between records) and the eye rank them (zone.js interiorSlots: the nearest INTERIOR_SLOTS, then blend order); a
// world change that touches them (interiorChangeTouches) re-reads the fold. Values only: a box appearing or leaving
// recompiles nothing. No world names or layouts.
import { THREE, scene, camera, interior } from '../core.js';
import { report } from '../base.js';
import { state, onWorldChange } from '../state.js';
import { envTexture } from '../sky/sky_baked.js';
import { interiorsOf, interiorSlots, interiorChangeTouches, foldOfView } from '../../../shared/zone.js';
import { worldPose } from '../../../shared/protocol/simlayer.js';
import { INTERIOR_SLOTS } from '../render/interior.js';

// The environment's interior cut, set once at import, before any material is drawn (main.js imports this module): a
// node replacing scene.environment's for every lit material, over the same persistent texture sky.js puts on
// scene.environment (sky_baked: bakes change its content, never the object). A node set later would recompile them all.
scene.environmentNode = interior.environmentNode(envTexture());

let objects = () => new Map();
/** the live objects by id (main.js): a holder's pose is its object's when it has one */
export function setInteriorObjects(fn) { objects = fn; }
const _p = new THREE.Vector3(), _q = new THREE.Quaternion(), _s = new THREE.Vector3(), _eye = new THREE.Vector3();
function poseFor(fold, id) {
  const obj = objects().get(id);
  if (!obj) return worldPose(fold, id);
  obj.updateWorldMatrix(true, false); obj.matrixWorld.decompose(_p, _q, _s);
  return { pos: _p.toArray(), q: _q.toArray(), scale: _s.toArray() };
}
let fold = { entities: {} }, dirty = true, warned = false, rebuilds = 0, boxes = [];
const owners = new Set();   // holders at the last read: a removed one still counts
onWorldChange((ev) => { if (interiorChangeTouches(ev, state.st.entities, owners)) dirty = true; });

/** Per frame, after the camera's last move (main.js): the boxes, ranked from the eye, into the slots. */
export function updateInteriors() {
  if (dirty) { dirty = false; rebuilds++; fold = foldOfView(state.st); owners.clear(); for (const b of interiorsOf(fold)) owners.add(b.id); }
  if (!owners.size) { if (boxes.length) { boxes = []; interior.setSlots([]); } return; }
  boxes = interiorsOf(fold, { poseOf: (id) => poseFor(fold, id), ids: owners });   // the holders only: never a walk of every entity a frame
  if (boxes.length > INTERIOR_SLOTS && !warned) { warned = true; report('interior', new Error(`the renderer reads the ${INTERIOR_SLOTS} interior boxes nearest the eye; the rest let the sky in until you come near`)); }
  camera.getWorldPosition(_eye);
  interior.setSlots(interiorSlots(boxes, [_eye.x, _eye.y, _eye.z], INTERIOR_SLOTS));
}
export function interiorDebug() { return { ...interior.debug(), boxes: boxes.length, rebuilds, envNode: scene.environmentNode != null }; }
