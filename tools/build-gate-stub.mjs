// build-gate-test substitutes this for everything build.js imports. build.js works AT IMPORT (`new THREE.Raycaster()`,
// `new THREE.Plane(...)`, claimEscape(), addEventListeners, bus.on), so all of it must be constructible here.
class V3 { constructor(x = 0, y = 0, z = 0) { this.x = x; this.y = y; this.z = z; } set() { return this; } setFromMatrixPosition() { return this; } copy() { return this; } add() { return this; } sub() { return this; } addScaledVector() { return this; } applyQuaternion() { return this; } normalize() { return this; } length() { return 0; } distanceTo() { return 0; } clone() { return new V3(this.x, this.y, this.z); } }
class Obj3 {
  constructor() { this.position = new V3(); this.rotation = { y: 0, x: 0, z: 0 }; this.scale = new V3(1, 1, 1); this.quaternion = {}; this.userData = {}; this.children = []; this.visible = true; this.matrixWorld = { decompose() {}, elements: [] }; }
  add(c) { this.children.push(c); } remove() {} traverse(f) { if (f) f(this); }
  updateMatrixWorld() {} getWorldPosition() { return new V3(); } lookAt() {} removeFromParent() {}
}
// every class build.js and socketedit.js construct (much of it at import), or nothing loads
export const THREE = {
  Vector3: V3,
  Group: Obj3,
  Mesh: class extends Obj3 { constructor() { super(); this.geometry = { dispose() {} }; this.material = { dispose() {} }; } },
  Object3D: Obj3,
  Box3: class { constructor() { this.min = new V3(); this.max = new V3(); } setFromObject() { return this; } getSize() { return new V3(); } getCenter() { return new V3(); } isEmpty() { return false; } },
  // outline.box.setFromObject(obj) + .visible + .userData
  Box3Helper: class extends Obj3 { constructor(box) { super(); this.box = box ?? { setFromObject() {} }; this.geometry = { dispose() {} }; this.material = { dispose() {} }; } },
  Plane: class { constructor() {} setFromNormalAndCoplanarPoint() { return this; } },
  Raycaster: class { constructor() { this.ray = { intersectPlane: () => null }; } setFromCamera() {} intersectObjects() { return []; } intersectObject() { return []; } },
  Quaternion: class { constructor() {} setFromRotationMatrix() { return this; } setFromAxisAngle() { return this; } copy() { return this; } },
  Matrix4: class { constructor() {} copy() { return this; } invert() { return this; } multiply() { return this; } multiplyMatrices() { return this; } makeRotationY() { return this; } decompose() {} extractRotation() { return this; } },
  ConeGeometry: class { constructor() {} dispose() {} },
  OctahedronGeometry: class { constructor() {} dispose() {} },
  MeshBasicMaterial: class { constructor() {} dispose() {} },
  MathUtils: { degToRad: (d) => d * Math.PI / 180, radToDeg: (r) => r * 180 / Math.PI, clamp: (v, a, b) => Math.min(b, Math.max(a, v)) },
};
export const scene = { add() {}, remove() {} };
export const camera = { position: new V3(), quaternion: {} };
export const canvas = { addEventListener() {}, removeEventListener() {}, style: {}, getBoundingClientRect: () => ({ left: 0, top: 0, width: 800, height: 600 }) };

const handlers = new Map();
export const CONFIG = {};  // base.js's CONFIG: chat/catalog/audiopanel read it
export const bus = {
  on(t, f) { (handlers.get(t) ?? handlers.set(t, []).get(t)).push(f); },
  emit(t, p) { for (const f of handlers.get(t) ?? []) f(p); },
};
export const report = () => {};

export const loadGLB = async () => new THREE.Object3D();
export const libLabels = new Map();
export const modelName = (m) => String(m ?? "").split("/").pop().replace(/\.[a-z0-9]+$/i, "") || "thing";  // assets.js modelName
export const makeLightGizmo = () => new THREE.Object3D();

// findPart: socketedit.js (imported by build.js) needs it, and socketedit must be remapped too or the real one loads
export const findPart = () => null;
export const entities = new Map();
export const entityMeta = new Map();
export const comps = new Map();   // the suite's driver: what bagOf answers
export const bagOf = (id) => comps.get(id) ?? null;
export function* bags() { yield* comps; }
export const metaOf = (id) => entityMeta.get(id) ?? null;
export const editHolds = new Map();
export const reindexCollider = () => {};
export const heightAt = () => 0;

// THE ONE THAT MATTERS: the gate reads net.myRights, left undeclared as the real net.js leaves it before a snapshot
export const net = {};
export const sendDrag = () => {};

export const myState = { pos: [0, 0, 0], yaw: 0 };
export const mouse = { x: 0, y: 0 };
export const setPointerClaim = () => {};
export const setEditingProbe = () => {};

export const hints = [];
export const flashHint = (t) => { hints.push(String(t)); };
export const collapseAll = () => {};
export const panelFrame = () => ({ show() {}, hide() {}, visible: false });
export const sceneSelect = () => {};
export const sceneSelected = () => null;   // build.js: Del/X/F act on the inspector's selection
export const sceneDeselect = () => {};   // build.js: Esc / Edit ▸ deselect clear it
export const claimEscape = () => {};

// socketedit.js: the symbols build.js imports from it
export const refreshSocketGizmos = () => {};
export const resetSockets = () => {};
export const armSocketPlacement = () => {};
export const socketArmed = () => null;
export const socketSelected = () => null;
export const cancelSocketArm = () => {};
export const deselectSocket = () => {};
export const socketMouseDown = () => false;
export const socketKeyDown = () => false;
export const updateSocketDrag = () => {};

// ---- xrask.js (editwrites): a headset is never presenting
export const xrActive = () => false;
export const chooseXR = async () => null;
// ---- realize/structure.js (structure_ui): the cutaway switch, inert
export const setCutaway = () => {};
// ---- net.js / ui.js (editwrites): no replica, no request answered, hints as text
export const replica = { st: null };
export const replicaActive = () => false;
export const sendRequest = async () => ({ ok: false, refused: { code: 'not-joined', reason: 'not in a world' } });
export const toast = (t) => { hints.push(String(t)); };
// ui.js's one status bar (claimStatus/releaseStatus): build.js claims the selection line, editwrites 'warn' for a
// refusal; a text claim is a hint the suite reads (as flashHint's), a node claim (the selection) is not
export const claimStatus = (id, { content = null } = {}) => { if (content != null) hints.push(String(content)); };
export const releaseStatus = () => {};
export { html } from '../client/lib/markup.js';
