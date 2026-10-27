// avatar — a body in the world: VRM, clips, nameplate, speech bubble, and the autonomic behaviours
// (gaze, blink, head pitch, mouth while speaking) that make a puppet read as present.

import { renderAside } from './render.js';
import { THREE, scene, camera, renderer, backendName } from './core.js';
import { makeCapsuleVrm } from './capsulebody.js';
import { FADE_PRESS } from './locomotion_clip.js';   // one owner for the jump-press fade (see _setAction)
import { report, angleDelta, bus, tee } from './base.js';
import { swimPose } from '../../shared/swimpose.js';
import { defsRegistry } from './defs.js';
import { measureChain, solveChain } from './reachbone.js';
import { REACH_CHAINS } from '../../shared/joints.js';
// a glowing body also CASTS: requests, never lights (a runtime PointLight recompiles every material)
import { attachLamps, releaseOwner, updateRequest, glowScale } from './lightrig.js';
import { setBodyShadows } from './materials.js';
// one BREATH period (spec T8), so wings and breath can't drift
import { BREATH } from '../../shared/breath.js';
import {
  loadVRM, clipFor, vrmaBytes, loadTrack, loadDone,
  CLIP_SLOTS, CLIP_SPEED, releaseVRM, vrmWarmed, markVrmWarmed,
} from './assets.js';
import { beginWork, enqueue, idleYield, nextFrame, loadNote } from './loadwork.js';
import { warm, P_GATE } from './warmqueue.js';
import { heightAt } from './terrain.js';
import { surfaceUnder } from './colliders.js';
import { DRIVEN_BONES } from './ragdoll.js';
import { stroke as strokeIcon } from './icons.js';
import { plateSize, plateClear, ownClearance, reachAbove, plateBox, CLEAR_MIN, PLATE_W } from './platesize.js';
import { revealLevel } from './namereveal.js';
import { crownEstimate, plateGap, plateAnchor, plateOffset, plateViewLift, STAND_SLOTS, DEAD as PLATE_DEAD } from './plateanchor.js';
import { clampBodyScale, clampPlateY, plateLift, clipRate } from './bodyscale.js';
import { Fn, userData, positionView, cameraNear, cameraFar, min, viewZToPerspectiveDepth, viewZToReversedPerspectiveDepth,
  viewZToOrthographicDepth } from 'three/tsl';
import { SEAT_CLIP_FILE } from './seatcore.js';
import { planReaches } from '../../shared/reachorder.js';
import { poseChannels } from '../../shared/humanoid.js';
import { swimTargets, SWIM_CLIPS } from '../../shared/swimpose.js';

// How far an upper lid swings to shut, radians about its own X, when the rig exports no limit.
// Signed: which way is "closed" depends on how the lid bone was rolled.
export const BLINK = {
  closed: 1.2,   // radians (69 deg)
  hz: 1,         // blink-rate multiplier
  // the lid's swing axis (0=x 1=y 2=z): Blender's bone axes are not glTF's; the wrong one sweeps sideways
  axis: 0,
  lower: -0.35,  // the LOWER lid's share, signed, usually opposite: an upper lid alone leaves the iris showing
  eyeMax: 0.42,  // radians off the head's forward (~24 deg): less than human, so the head does the work, not a stare
  dur: 0.28,     // seconds for close AND reopen (a real blink closes in 100-150ms); 0.13 was imperceptible
};

// Wings: [LR]_Wing_(Upper|Lower)[_<n>], any chain length. Procedural (VRMA can't address non-humanoid
// bones; limp must hand over at once); flap about the BODY's forward axis, since bone roll is arbitrary.
export const WING_IDLE = {
  deg: 10,       // degrees, half-amplitude at the shoulder: an IDLE, not flight (28 read as taking off)
  hz: 1 / BREATH, // one beat per BREATH, 3.4 s (spec T8)
  bias: 0,       // degrees of permanent lift, both sides: rest the wings off the rig's rest pose
  tip: 0.9,      // the outer segment's share of the amplitude: below 1 curves the wing (equal is a door)
  lag: 0.25,     // cycles the tip trails the shoulder: this lag is what reads as membrane, not board
  sync: true,    // upper and lower pairs share a phase; false offsets them a half-cycle (an insect, not a bird)
  recover: 0.5,  // seconds to slerp back into the flap after a ragdoll
  // ---- the SWEEP: a second rotation about the body's UP, mirrored, so the tips trace an ellipse, not an arc
  sweep: 18,       // degrees fore/aft at the shoulder
  sweepPhase: 0.25, // cycles the sweep leads the flap: a quarter turn opens the ellipse (0 is a tilted hinge)
};

// The power stroke: WING_IDLE's dials; wingEffort [0,1] crossfades them term by term, following flight state (controller.js).
export const WING_POWER = {
  deg: 8,        // small and FAST (big and slow at this rate thrashes); tip carry still compounds it at the tip
  hz: 2.1,       // fast enough to read as effort; past ~3Hz the lag no longer separates tip from shoulder
  bias: -8,      // the stroke sits LOW: a power flap drives down from above
  tip: 0.78,     // less tip carry than idle: a loaded wing straightens along its span
  lag: 0.09,     // less lag than idle: a loaded wing drives as one surface, not a slack membrane
  sync: true,
  recover: 0.55, // the ragdoll handover, not the flap
  sweep: 17,     // the ellipse is what makes a flap move air rather than wave
  sweepPhase: 0.25,
};

// The vigil posture (flight-spec-v0 §1-2, T6): quaternions from wings-folded_1.asset.blend, local to rest,
// three.js [x,y,z,w] (Blender stores [w,x,y,z]). Only the angle is eased (lowers -10°, uppers -3°); the axis is as authored.
const WING_FOLDED = {
  L_Wing_Lower: [-0.19528, +0.01928, +0.08113, +0.97720],
  L_Wing_Lower_1: [+0.00000, +0.00000, -0.14119, +0.98998],
  L_Wing_Lower_2: [+0.00000, -0.00000, -0.07015, +0.99754],
  L_Wing_Upper: [-0.61553, +0.10840, -0.23210, +0.74532],
  L_Wing_Upper_1: [+0.02722, +0.15488, -0.05078, +0.98625],
  L_Wing_Upper_2: [+0.07325, +0.01376, -0.08462, +0.99362],
  R_Wing_Lower: [-0.18819, -0.03912, -0.05598, +0.97976],
  R_Wing_Lower_1: [-0.00000, +0.00000, +0.15163, +0.98844],
  R_Wing_Lower_2: [-0.00000, +0.00000, +0.09890, +0.99510],
  R_Wing_Upper: [-0.57842, -0.13811, +0.24053, +0.76714],
  R_Wing_Upper_1: [+0.00000, -0.00000, +0.17326, +0.98488],
};

/** Numbers interpolate; the rest (`sync`, `recover`) take the idle's. Scratch reused: per frame, per body. */
const _wmix = {};
function mixWings(a, b, t) {
  for (const k of Object.keys(a)) {
    const av = a[k], bv = b[k];
    _wmix[k] = (typeof av === 'number' && typeof bv === 'number') ? av + (bv - av) * t : av;
  }
  return _wmix;
}

/** A limp body's springbones when no sim of its own runs; live (debug panel), applied at the next limp.
 *  stiffness is a FACTOR on the rig's; gravity is a floor (a chain that falls harder keeps its own). */
export const LIMP_SPRINGS = {
  stiffness: 0.2,   // the rest shape was authored standing: give way
  gravity: 0.45,
};

const CORE_CLIPS = ['idle', 'walk'];
const LATER_CLIPS = CLIP_SLOTS.filter((s) => !CORE_CLIPS.includes(s));
// until a clip arrives the nearest arrived one stands in: playing nothing reads as a bug
const CLIP_FALLBACK = {
  run: 'walk', jump: 'idle', climb: 'walk',
  sit: 'idle', lie: 'idle', sitchair: 'sit',
  // a body with no flight clips glides in its idle pose, never a stride
  fly: 'soar', soar: 'idle',
  // swimming is procedural (Avatar._swimLayer) over the idle clip — no rig ships a swim clip
  swim: 'idle', tread: 'idle',
};

// gesture slots load lazily (~1.9 MB each): a body is born able to stand and walk
// IMPORT then re-export, never `export ... from`: that makes no local binding and playOnce's ANIM_CLIPS throws
import { ANIM_CLIPS, ANIM_ORDER, ANIM_ICONS, hydrateAnimNames } from './animnames.js';
export { ANIM_CLIPS, ANIM_ORDER, ANIM_ICONS, hydrateAnimNames };
// by what you sit ON: the ground clip on a chair is cross-legged in mid-air
export const SEAT_CLIPS = { ground: 'sitting_on_ground', chair: SEAT_CLIP_FILE };

// ---------------------------------------------------------------- sprites

// Body-attached sprites (plate, typing pill) depth-test but write depth `userData.plateClear` m nearer the eye
// (platesize.js), so scenery and other bodies hide them, their own never. A fragment-depth override keeps stereo right.
const PLATE_DEPTH = Fn((builder) => {
  const z = min(positionView.z.add(userData('plateClear', 'float')), cameraNear.negate().mul(1.0001));   // never past the near plane
  if (!builder.camera?.isPerspectiveCamera) return viewZToOrthographicDepth(z, cameraNear, cameraFar);
  return builder.renderer?.reversedDepthBuffer ? viewZToReversedPerspectiveDepth(z, cameraNear, cameraFar)
    : viewZToPerspectiveDepth(z, cameraNear, cameraFar);
})();
/** A body-attached sprite material (see PLATE_DEPTH). */
function clearedSpriteMaterial(map) {
  const mat = new THREE.SpriteNodeMaterial({ map, transparent: true, depthTest: true, depthWrite: false });
  mat.depthNode = PLATE_DEPTH;
  return mat;
}

// clear: true = a body-attached sprite (depth-tested, own body cleared); false = drawn over everything (speech bubbles)
function textSprite(draw, w, h, scaleW, clear = false) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  draw(c.getContext('2d'));
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const mat = clear ? clearedSpriteMaterial(tex) : new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false });
  const s = new THREE.Sprite(mat);
  if (clear) s.userData.plateClear = CLEAR_MIN;
  s.scale.set(scaleW, scaleW * h / w, 1);
  s.renderOrder = 99;
  return s;
}
export const disposeSprite = (s) => { s.material.map?.dispose(); s.material.dispose(); };
// a token read at paint time — canvas sprites cannot use var(); a 'style' event repaints them
const tokv = (n, fb) => (getComputedStyle(document.documentElement).getPropertyValue(n) || fb).trim();
// every live Avatar, so a 'style' event repaints the sprites baked from tokens
const liveAvatars = new Set();
bus.on('style', () => { for (const a of liveAvatars) a.repaintLabel?.(); });

// the name's font, and the glyphs that set every plate's height (platesize.js plateBox says why)
const LABEL_FONT = '600 40px system-ui, "Segoe UI", sans-serif', LABEL_REF = 'Hdlgjpqy';
const labelFont = (ctx) => { ctx.font = LABEL_FONT; try { ctx.letterSpacing = '1.5px'; } catch {} };
let _labelCtx = null;
const makeLabel = (name) => {
  const text = name.slice(0, 24);
  const m = (_labelCtx ??= document.createElement('canvas').getContext('2d'));
  labelFont(m);
  const ink = m.measureText(text), ref = m.measureText(LABEL_REF);
  const box = plateBox({ asc: ink.actualBoundingBoxAscent, desc: ink.actualBoundingBoxDescent, width: ink.width },
    { asc: ref.actualBoundingBoxAscent, desc: ref.actualBoundingBoxDescent });
  const s = textSprite((ctx) => {
  // system-ui (Segoe on Windows): warm, and no webfont race on a canvas drawn the moment someone arrives
  labelFont(ctx);
  ctx.textAlign = 'center';
  ctx.fillStyle = tokv('--pill-bg', 'rgba(6,16,22,0.62)');
  ctx.beginPath(); ctx.roundRect((box.w - box.pillW) / 2, box.top, box.pillW, box.pillH, box.pillH / 2); ctx.fill();
  ctx.fillStyle = tokv('--pill-name', '#8fe8c8');
  ctx.fillText(text, box.w / 2, box.baseline);
  }, box.w, box.h, PLATE_W, true);
  s.userData.aspect = box.h / box.w;   // height per metre of width: sized by width each frame
  s.userData.pillH = box.pillH / box.w;   // the pill's height, as a share of the sprite's width (the hover card's box)
  s.userData.pill = box.pillW / box.w;   // the pill's share of the sprite's width: the hover card sits beside IT
  // hover-card visibility (platecard.js): an occlusion query on the plate's own draw, so walls hide it from
  // pointer and eye alike; a frame or two old
  s.occlusionTest = true;
  s.onBeforeRender = noteOccluded;
  return s;
};
function noteOccluded(r) { this.userData.occluded = r.isOccluded(this); }

// lifts over the plate, body frame: they ride wherever the plate hangs (plateanchor.js), sitting and lying too
const BUBBLE_LIFT = 0.35, TYPING_LIFT = 0.17, TYPING_OVER_BUBBLE = 0.77;
const _pHips = new THREE.Vector3(), _pHead = new THREE.Vector3(), _pFoot = new THREE.Vector3(), _pScale = new THREE.Vector3();
const _ownM = new THREE.Matrix4();
const _pArgs = { hips: [0, 0, 0], head: [0, 0, 0], feetY: 0, rest: null, s: 1, gap: 0, lift: 0 }, _pOut = { p: [0, 0, 0], lie: 0 };
const FEET = ['leftFoot', 'rightFoot'];
const _pSmooth = { dead: PLATE_DEAD };
const _pRest = new THREE.Vector3(), _pTarget = { standing: false, standY: 0, liveY: 0 };
const plateBone = (h, n) => h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n) ?? null;
const _pRoot = new THREE.Vector3();
const _lvP = new THREE.Vector3(), _lvE = new THREE.Vector3(), _lvU = new THREE.Vector3(), _lvF = new THREE.Vector3(), _lvQ = new THREE.Quaternion();
const _lvArgs = { eye: [0, 0, 0], up: [0, 0, 0], fwd: [0, 0, 0], plate: [0, 0, 0], drop: 0, headR: 0, halfH: 0 };

function wrap(text, n) {
  const words = String(text).split(/\s+/);
  const lines = ['']; let cur = 0;
  for (const w of words) {
    if ((lines[cur] + ' ' + w).trim().length > n) { lines.push(w); cur++; }
    else lines[cur] = (lines[cur] + ' ' + w).trim();
  }
  return lines;
}
// the bubble shows the first BUBBLE_LINES wrapped lines and says the rest is in chat
const BUBBLE_LINES = 8;
function makeBubble(text) {
  const all = wrap(text, 38);
  const clipped = all.length > BUBBLE_LINES;
  const lines = clipped ? all.slice(0, BUBBLE_LINES) : all;
  if (clipped) lines.push('▾ more in chat');
  const h = 30 + lines.length * 34;
  return textSprite((ctx) => {
    ctx.font = '27px system-ui, "Segoe UI", sans-serif';
    // hug the widest wrapped line; 700 is the ceiling
    const wMax = Math.max(...lines.map((l) => ctx.measureText(l).width));
    const w = Math.min(700, Math.ceil(wMax) + 44);
    ctx.fillStyle = tokv('--pill-bg', 'rgba(8,20,28,0.86)');
    ctx.strokeStyle = tokv('--pill-edge', 'rgba(143,232,200,0.25)');
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect((704 - w) / 2, 2, w, h - 4, 16); ctx.fill(); ctx.stroke();
    ctx.textAlign = 'center';
    lines.forEach((l, i) => {
      ctx.fillStyle = clipped && i === lines.length - 1 ? tokv('--pill-dim', '#8ba39c') : tokv('--pill-fg', '#e8f4ef');
      ctx.fillText(l, 352, 38 + i * 34);
    });
  }, 704, Math.max(64, h), 2.4);
}

// ---- typing indicator ------------------------------------------------------
// Own canvas so it can animate; redrawn only while typing, throttled. Gives way to the speech bubble.
function makeTypingSprite() {
  const c = document.createElement('canvas');
  c.width = 128; c.height = 56;
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  const s = new THREE.Sprite(clearedSpriteMaterial(tex));   // body-attached: hidden by walls, never by its own head
  s.userData.plateClear = CLEAR_MIN;
  s.scale.set(0.5, 0.5 * 56 / 128, 1);
  s.renderOrder = 99;
  s.userData.ctx = c.getContext('2d');
  return s;
}
// Attention glyphs: ear = speech will reach it; think = composing; tool = mid-task; mic = its voice is live.
// Icons come from icons.js, never emoji: canvas fillText paints nothing for a missing glyph.
const ICON_FOR = { ear: 'ear', think: 'think', tool: 'wrench', mic: 'mic' };

function drawTypingDots(sprite, t, state) {
  const ctx = sprite.userData.ctx;
  ctx.clearRect(0, 0, 128, 56);
  ctx.fillStyle = 'rgba(8,20,28,0.82)';
  ctx.strokeStyle = 'rgba(143,232,200,0.28)';
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.roundRect(28, 12, 72, 32, 16); ctx.fill(); ctx.stroke();
  if (ICON_FOR[state]) {
    const b = 0.75 + 0.25 * Math.sin(t * 3);      // gentle breathing, not a strobe
    ctx.save();
    ctx.translate(64, 28);
    ctx.globalAlpha = b;
    ctx.strokeStyle = 'rgba(180,240,216,1)';
    strokeIcon(ctx, ICON_FOR[state], 26);
    // mic gets sound arcs on top: the icon says "a voice", the arcs say "NOW"
    if (state === 'mic') {
      for (let i = 0; i < 2; i++) {
        const amp = 0.3 + 0.7 * Math.max(0, Math.sin(t * 5 - i * 0.7));
        ctx.globalAlpha = b * amp;
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.arc(2, 0, 15 + i * 5, -0.7, 0.7); ctx.stroke();
      }
    }
    ctx.restore();
    ctx.globalAlpha = 1;
  } else {
    for (let i = 0; i < 3; i++) {
      const b = 0.32 + 0.68 * Math.max(0, Math.sin(t * 5 - i * 0.85));
      ctx.globalAlpha = b; ctx.fillStyle = tokv('--pill-dot', 'rgb(180,240,216)');
      ctx.beginPath(); ctx.arc(48 + i * 16, 28, 5, 0, Math.PI * 2); ctx.fill(); ctx.globalAlpha = 1;
    }
  }
  sprite.material.map.needsUpdate = true;
}

// ---------------------------------------------------------------- Avatar

const _v = new THREE.Vector3();
const _plateEye = new THREE.Vector3();   // nameplate fade: the camera's world position
const _pq = new THREE.Quaternion();
const _rq = new THREE.Quaternion();
const _rq2 = new THREE.Quaternion();
const _rq3 = new THREE.Quaternion();
const _rv = new THREE.Vector3();
const _rv2 = new THREE.Vector3();
const _rv3 = new THREE.Vector3();
const _rv4 = new THREE.Vector3();
const _Y2 = new THREE.Vector3(0, 1, 0);
const _Z2 = new THREE.Vector3(0, 0, 1);
const _gq = new THREE.Quaternion();        // gaze scratch — hot path, no allocs
const _gd = new THREE.Quaternion();
const _gi = new THREE.Quaternion();
const _gpq = new THREE.Quaternion();
const _gf = new THREE.Vector3();
const _gw = new THREE.Vector3();
const _gp = new THREE.Vector3();
const _X = new THREE.Vector3(1, 0, 0);      // scratch — hot paths must not allocate
const _v2 = new THREE.Vector3();
const _wq = new THREE.Quaternion();        // wing scratch
const _wpq = new THREE.Quaternion();
const _wacc = new THREE.Quaternion();
const _wfold = new THREE.Quaternion();
const _wtgt = new THREE.Quaternion();
const _wr = new THREE.Quaternion();
const _wax = new THREE.Vector3();
const _wup = new THREE.Vector3();
const _wsw = new THREE.Quaternion();
const _swE = new THREE.Euler(), _swQ = new THREE.Quaternion();   // swim-layer scratch
const _hq = new THREE.Quaternion();        // raw-pose scratch (_applyRawPose) — per bone, per frame
const _hv = new THREE.Vector3();
const _hs = new THREE.Vector3();
const _ONE = new THREE.Vector3(1, 1, 1);
const _sa1 = new THREE.Vector3(), _sa2 = new THREE.Vector3();          // seat anchor scratch (_measureAnchor)
const _sl1 = new THREE.Quaternion(), _sl2 = new THREE.Quaternion(), _sl3 = new THREE.Quaternion();   // seat look scratch
// a clip named the way the animation library names its files: what a socket's pose, enter and leave may name
const CLIP_NAME_RE = /^[A-Za-z][A-Za-z0-9_-]{0,47}$/;
// the clips hydrateClips owns (slot names that are not file names): a socket naming one waits for hydration
const HYDRATED = new Set([...CORE_CLIPS, ...LATER_CLIPS, 'sitchair']);
const DEG = Math.PI / 180;

// The lamp's breath: FLOOR an ember, never off; PEAK below 1 reads as breath, not pulse;
// SHAPE >1 dwells near the floor (1.0 a plain sine).
const LAMP_FLOOR = 0.03;
const LAMP_PEAK = 0.62;    // set for shadows on: shadowed neighbours make the same light read dimmer
const LAMP_SHAPE = 1.6;
// the surface dims toward noon on lightrig's (1-dayness)^2; this keeps it lit in full sun
const LAMP_DAY_FLOOR = 0.18;


/** A jump clip's take-off: the hips dip (anticipation), then come back up through their rest height — that is the
 *  frame the feet leave the floor. A clip with no hips track, or one that starts by rising, gives 0. */
function clipTakeoff(clip) {
  if (clip.userData.takeoff != null) return clip.userData.takeoff;
  const tr = clip.tracks.find((t) => /hips\.position$/i.test(t.name) || /Hips\.position$/.test(t.name));
  let out = 0;
  if (tr && tr.values.length >= 6) {
    const n = tr.times.length, half = Math.max(1, Math.floor(n / 2));
    let minI = 0, minY = Infinity;
    for (let i = 0; i < half; i++) { const y = tr.values[i * 3 + 1]; if (y < minY) { minY = y; minI = i; } }
    if (minI > 0 && tr.values[1] - minY > 0.01) {   // a real dip (>1 cm), not noise
      // leave the ground where the hips rise back through rest height, not at the squat's bottom,
      // or an airborne body is still pushing off
      let i = minI; while (i < n - 1 && tr.values[i * 3 + 1] < tr.values[1]) i++;
      out = tr.times[i];
    }
  }
  clip.userData.takeoff = out;
  return out;
}
export class Avatar {
  /** Monotonic, so one identity's successive bodies never share a lamp owner. */
  static _seq = 0;

  constructor(id, vrm, clips) {
    this.id = id;
    this.vrm = vrm;
    this.root = new THREE.Group();
    this.root.userData.isBody = true;   // so the sky's scene-diff never claims a person
    this.root.userData.who = id;        // perf attribution: this subtree is a PERSON (perfscope)
    this.root.add(vrm.scene);
    // This body's size and plate lift (bodyscale.js) live on vrm.scene, never the root (it carries the plate,
    // pill and bubble). A pooled VRM may keep its last owner's size, so reset before anything measures.
    this.userScale = 1; this.plateY = 0; this._puppet = 1;
    vrm.scene.scale.setScalar(1);
    // a point light per emissive mesh (as realize/models.js does), owned per body INSTANCE, not identity:
    // a swap builds new then disposes old (mybody.js), which would release the new body's lamp
    this._lampOwner = `body:${id}:${++Avatar._seq}`;
    this._lamps = [];
    // `shadows: true` claims the one casting slot; false at the seam, so a glowing prop can't take it (attachLamps)
    try { this._lamps = attachLamps(vrm.scene, this._lampOwner, { shadows: true }) ?? []; }
    catch { /* a body with no glow simply has none */ }
    // Only a lamped body casts and receives; others keep the blob. Body depth pipelines compile in-frame
    // and bypass the caster budget, so shadowing every avatar is unmeasured cost.
    if (this._lamps.length) {
      try { setBodyShadows(vrm.scene, true); }
      catch { /* shadows are a nicety; a body that cannot take them still works */ }
    }

    this.mixer = new THREE.AnimationMixer(vrm.scene);
    this.actions = {};
    this.extraClips = new Map(); // lazily-loaded gesture actions
    for (const [slot, clip] of Object.entries(clips)) {
      const a = this.mixer.clipAction(clip);
      a.enabled = true; a.setEffectiveWeight(0); a.play();
      this.actions[slot] = a;
    }
    this.current = null;
    this.currentSlot = null;
    this.onceAnim = null;             // { action, until }
    // ankle height above the root at rest (no clip yet): a FEET-anchored socket takes the soles, not the ankles
    try { const h = vrm.humanoid; const f = h?.getRawBoneNode?.('leftFoot') ?? h?.getNormalizedBoneNode?.('leftFoot');
      if (f) { this.root.updateMatrixWorld(true); this._footRestY = Math.max(0, this.root.worldToLocal(f.getWorldPosition(new THREE.Vector3())).y); } } catch { this._footRestY = 0; }
    this.setClip('idle');

    this.bubble = null;
    this.bubbleUntil = 0;
    this.speakUntil = 0;           // drives the fake viseme envelope
    this.voiceLevel = null;        // 0..1 real amplitude when a waveform exists
    this._mouth = 0;               // smoothed jaw, so the mouth has inertia
    this.typing = null;            // lazily-built dots sprite
    this._typingUntil = 0;         // typing signals repeat ~2.5s and expire ~4s
    this._typingDrawAt = 0;
    this.label = makeLabel(id);
    this.label.position.y = 1.95;   // until the first frame hangs it from the body (_placePlate)
    this.root.add(this.label);
    this._plateRest = this._measurePlateRest();   // the crown, once, while the body is still at rest
    this._plateOff = null;                        // smoothed plate height above the root (world m) — see _placePlate
    liveAvatars.add(this);

    // ---- gaze: a target per avatar for the VRM lookAt rig, moved each frame toward whatever deserves attention
    this.gaze = new THREE.Object3D();
    this.gaze.userData.isBody = true;
    scene.add(this.gaze);
    this.gazeGoal = new THREE.Vector3();
    if (vrm.lookAt) vrm.lookAt.target = this.gaze;

    this.blinkAt = performance.now() + 1200 + Math.random() * 3600;
    this.blinkT = -1;
    this.head = vrm.humanoid?.getNormalizedBoneNode?.('head') ?? null;
    this.pitch = 0;                // radians, applied post-update
    this._limp = false;            // see setLimp: the mixer yields to the sim
    this._composed = new Map();    // node -> clip base + what we last wrote
    this.shadow = makeBlobShadow();
    this.root.add(this.shadow);

    scene.add(this.root);
  }

  /** Find hand-rigged eyeball bones (L_Eye / R_Eye) once, for rigs three-vrm's lookAt doesn't drive. Same gaze target. */
  _findEyes() {
    this._eyes = null;
    if (!this.vrm?.scene) return;
    // defer to three-vrm when the rig maps leftEye/rightEye: never two writers on one bone
    if (this.vrm.lookAt && this.vrm.humanoid?.getNormalizedBoneNode?.('leftEye')) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      if (/^[LR]_Eye$/.test(o.name ?? '')) found.push({ node: o, rest: o.quaternion.clone() });
    });
    if (found.length) this._eyes = found;
  }

  /** Give the hair back to three-vrm from the CURRENT pose: a bare reset() snaps to the combed rest, so the rest
   *  points at the current pose for the call, then is restored so the springs still pull toward the authored shape. */
  _releaseHair({ adopt = false } = {}) {
    if (!this.__simHair) return;
    this.__simHair = false;
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints) return;
    this.vrm.scene?.updateMatrixWorld?.(true);
    // the authored spring rest, remembered ONCE, so adopting a fallen shape is reversible and never ratchets
    if (!this.__springRest) {
      this.__springRest = new Map();
      for (const j of sbm.joints) {
        if (j?._initialLocalRotation) this.__springRest.set(j, j._initialLocalRotation.clone());
      }
    }
    for (const j of sbm.joints) {
      if (j?._initialLocalRotation && j.bone) j._initialLocalRotation.copy(j.bone.quaternion);
    }
    sbm.reset();                 // re-derives tails; the rotation restore is a no-op
    if (!adopt) this._combHair();
  }

  /** Limp with no local sim (remotes, after the doll disposes): stiffness yields, gravity takes over, since the upright
   *  rest pulls lying hair sideways. Restored on standing. Occasional sideways hair remains unexplained. */
  _springsLimp(on) {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints || this.__springsLimp === on) return;
    this.__springsLimp = on;
    if (!this.__springSettings) {
      this.__springSettings = new Map();
      for (const j of sbm.joints) {
        if (j?.settings) {
          this.__springSettings.set(j, {
            s: j.settings.stiffness, g: j.settings.gravityPower, center: j._center ?? null,
          });
        }
      }
    }
    for (const j of sbm.joints) {
      const o = this.__springSettings.get(j);
      if (!o) continue;
      j.settings.stiffness = on ? o.s * LIMP_SPRINGS.stiffness : o.s;
      j.settings.gravityPower = on ? Math.max(o.g, LIMP_SPRINGS.gravity) : o.g;
      // limp hair lives in the world: `center` (hip space) would rotate a carried body's hair rigidly with it
      if (on) j._center = null;
      else if (o.center !== undefined) j._center = o.center;
    }
    // re-derive the tails in the new frame, or the next frame reads center-space numbers as world and flings the hair
    this._springsResync();
  }

  /** Re-derive spring tail state from the CURRENT pose, keeping that pose (rest pointed at it for the call,
   *  then restored). Needed anywhere the frame those tails live in changes. */
  _springsResync() {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints) return;
    this.vrm.scene?.updateMatrixWorld?.(true);
    const saved = [];
    for (const j of sbm.joints) {
      if (!j?._initialLocalRotation || !j.bone) continue;
      saved.push([j, j._initialLocalRotation.clone()]);
      j._initialLocalRotation.copy(j.bone.quaternion);
    }
    sbm.reset();
    for (const [j, q] of saved) j._initialLocalRotation.copy(q);
  }

  /** Put the AUTHORED spring rest back, so the hair combs itself out again. Split from the release: a doll
   *  disposed mid-tumble hands the hair back ADOPTING the fallen shape; standing up is when the comb returns. */
  _combHair() {
    const sbm = this.vrm?.springBoneManager;
    if (!sbm?.joints || !this.__springRest) return;
    for (const j of sbm.joints) {
      const q = this.__springRest.get(j);
      if (q && j._initialLocalRotation) j._initialLocalRotation.copy(q);
    }
  }

  /** Find the wing bones once. Depth is the _<n> INDEX, not an underscore count. Every frame rebuilds from the
   *  AUTHORED rest: composing onto last frame winds the wings, and the ragdoll reads that as equilibrium. */
  _findWings() {
    this._wings = null;
    if (!this.vrm?.scene) return;
    // The AUTHORED rest, not the live pose: wings may be springbones, already posed (or ragdolled) when a
    // client first sees the body. Prefer three-vrm's _initialLocalRotation; live pose only for unclaimed bones.
    const springRest = new Map();
    for (const j of this.vrm.springBoneManager?.joints ?? []) {
      if (j?.bone && j._initialLocalRotation) springRest.set(j.bone, j._initialLocalRotation);
    }
    const found = [];
    this.vrm.scene.traverse((o) => {
      const m = /^([LR])_Wing_(Upper|Lower)(?:_(\d+))?$/.exec(o.name ?? '');
      if (!m) return;
      found.push({
        node: o,
        rest: (springRest.get(o) ?? o.quaternion).clone(),
        // +1 left, -1 right: one rotation about body forward lifts +X and drops -X, so the mirror is a sign
        side: m[1] === 'L' ? 1 : -1,
        lower: m[2] === 'Lower',
        depth: m[3] ? Number(m[3]) : 0,
      });
    });
    if (!found.length) return;
    // roots before tips (load-bearing): a tip reads its root's world frame AFTER this frame's write
    found.sort((a, b) => a.depth - b.depth);
    this._wings = found;
    // the ragdoll hangs its chains off this; on the avatar because the doll is rebuilt every grab
    this.__wingRest = new Map(found.map((w) => [w.node, w.rest]));
  }

  /** One frame of the idle flap, rebuilt from the captured rest so it cannot integrate. Rotates about a WORLD
   *  axis carried into the parent frame (local = parentWorld⁻¹ · R · parentWorld · rest), as the eyeballs do. */
  _flap(dt) {
    // effort is set outside (controller.js), eased here: fast on, slow off, so a tapped flap doesn't twitch
    const want = THREE.MathUtils.clamp(this.wingEffort ?? 0, 0, 1);
    const have = this._wingEffort ?? 0;
    const tau = want > have ? 0.18 : 0.55;
    this._wingEffort = have + (want - have) * (1 - Math.exp(-dt / tau));
    const e = this._wingEffort;

    // Folding, eased over ~0.5 s from `wingsFolded` (fold_down), so it survives a ragdoll interrupting it.
    const fWant = this.wingsFolded ? 1 : 0;
    const fHave = this._wingFold ?? 0;
    this._wingFold = fHave + (fWant - fHave) * (1 - Math.exp(-dt / 0.45));
    const fold = this._wingFold;
    // A folded wing does not beat: the flap runs underneath and the fold blends over it.
    const folding = fold > 0.001;
    const W = e < 0.001 ? WING_IDLE : mixWings(WING_IDLE, WING_POWER, e);
    this._wingBlend = Math.min(1, (this._wingBlend ?? 1) + dt / Math.max(0.01, W.recover));
    this._wingT = (this._wingT ?? 0) + dt * Math.max(0, W.hz);
    this._wingT -= Math.floor(this._wingT);
    // The body's forward from the NORMALIZED rig (three-vrm rests it facing +Z); raw bones carry Blender's
    // roll. Falls back to the avatar group (upright, faces travel).
    const h = this.vrm.humanoid;
    const ref = this._wingRef ?? (this._wingRef =
      h?.getNormalizedBoneNode?.('upperChest') ?? h?.getNormalizedBoneNode?.('chest')
      ?? h?.getNormalizedBoneNode?.('spine') ?? this.root);
    ref.getWorldQuaternion(_wq);
    _wax.set(0, 0, 1).applyQuaternion(_wq).normalize();   // forward: the flap
    _wup.set(0, 1, 0).applyQuaternion(_wq).normalize();   // up: the sweep
    for (const w of this._wings) {
      // outer segments trail their root; an unsynced lower pair trails by half a beat
      const ph = this._wingT - W.lag * w.depth - (W.sync || !w.lower ? 0 : 0.5);
      // each segment out carries `tip` of the one before as its OWN rotation, so the tip inherits the root's too
      const amp = W.deg * Math.pow(W.tip, w.depth);
      const ang = (amp * Math.sin(ph * Math.PI * 2) + W.bias) * DEG * w.side;
      _wr.setFromAxisAngle(_wax, ang);
      // the fore/aft sweep about UP, mirrored; composed on the left so it acts in the body's frame
      const sw = W.sweep * Math.pow(W.tip, w.depth)
        * Math.sin((ph + W.sweepPhase) * Math.PI * 2) * DEG * -w.side;
      if (sw) _wr.premultiply(_wsw.setFromAxisAngle(_wup, sw));
      // Roots are visited before tips (_findWings), so a tip composes on its root's NEW orientation.
      // _wacc, not _wpq: quaternion ops mutate the receiver, so reusing _wpq squares the rotation.
      w.node.parent.getWorldQuaternion(_wpq);
      _wacc.copy(_wpq).invert().multiply(_wr).multiply(_wpq).multiply(w.rest);
      // ...and toward the vigil: the authored pose is local to rest, the frame w.rest is in, so target = rest * folded.
      if (folding) {
        const q = WING_FOLDED[w.node.name];
        if (q) {
          _wfold.set(q[0], q[1], q[2], q[3]);
          _wtgt.copy(w.rest).multiply(_wfold);
          _wacc.slerp(_wtgt, fold);
        }
      }
      if (this._wingBlend < 1 && w.from) {
        // Standing up, slerp out of the pose the ragdoll left rather than cut to mid-flap. (Hair stays dishevelled.)
        w.node.quaternion.copy(w.from).slerp(_wacc, this._wingBlend);
      } else {
        w.node.quaternion.copy(_wacc);
      }
      // Explicit: a bone declared as a VRM springbone has matrixAutoUpdate false, so .quaternion alone never renders.
      w.node.updateMatrix();
    }
  }

  /** Hold the eyes shut (1) or open (0), eased in update(). False with no lid bones, so a caller can say so. */
  setEyes(shut) {
    if (this._lids === undefined) this._findLids();
    if (!this._lids) return false;
    this._eyesGoal = shut ? 1 : 0;
    return true;
  }

  /** Find the eyelid bones once, and remember where OPEN is. Upper and lower lids by name
   *  (L_/R_Eyelid_Upper/_Lower); the closing angle is the rig's saved closed pose, else its Limit Rotation
   *  (eido_export.py extras), else BLINK.closed / BLINK.lower. */
  _findLids() {
    this._lids = null;
    if (!this.vrm?.scene) return;
    const found = [];
    this.vrm.scene.traverse((o) => {
      const m = /^[LR]_Eyelid_(Upper|Lower)$/.exec(o.name ?? '');
      if (!m) return;
      const ex = o.userData?.gltfExtras ?? o.userData ?? {};
      let lim = NaN;
      const cl = Number(ex.blink_closed_x);
      if (ex.blink_closed_src === 'pose') {
        // Authored: read from a saved eyes-closed pose, already the rotation FROM REST, so no centring.
        // Preferred over the constraint: a rig without Limit Rotation would otherwise fall to BLINK.closed.
        if (Number.isFinite(cl) && Math.abs(cl) > 1e-3 && Math.abs(cl) < 1.6) lim = cl;
      } else {
        // Limit Rotation numbers are ABSOLUTE angles in the bone's frame, not offsets from rest. Rest sits mid-range,
        // so closing delta = closed - centre; anything implausible falls back to the dial.
        const mn = Number(ex.limit_min_x), mx = Number(ex.limit_max_x);
        if ([mn, mx, cl].every(Number.isFinite) && mx > mn) {
          const d = cl - (mn + mx) / 2;
          if (Math.abs(d) > 1e-3 && Math.abs(d) < 1.6) lim = d;
        }
      }
      found.push({
        node: o,
        rest: o.quaternion.clone(),
        lower: m[1] === 'Lower',
        exported: Number.isFinite(lim) && Math.abs(lim) > 1e-4 ? lim : null,
      });
    });
    // NOT report(): that is the error channel, and report(msg, null) shows a clean load as "unknown error"
    if (found.length) this._lids = found;
  }

  // ---- first-person anchors (fp_view.js consumes these) -------------------

  /** Live world position of the RAW head bone (the skeleton the mesh follows), or null. */
  headWorldPosition(out) {
    const node = this.vrm.humanoid?.getRawBoneNode?.('head') ?? this.head;
    if (!node) return null;
    return node.getWorldPosition(out);
  }

  /** World bounds of vrm.scene, NOT this.root, so the plate and bubble don't inflate it. Fallback anchor without a head bone. */
  visualBounds(box) {
    box.setFromObject(this.vrm.scene);
    return box.isEmpty() ? null : box;
  }

  // ---- locomotion / clips
  setClip(slot, speed = 0, { fade, ease = false } = {}) {
    this.postureSlot = slot;   // what was ASKED (the wire's clip), before any fallback: the plate reads posture from it
    // moving cancels a gesture: frozen mid-cheer while walking away is worse than a cut cheer
    if (this.onceAnim && speed > 0.05) this.cancelOnce();
    if (this.onceAnim) return;        // otherwise it owns the body until it finishes
    if (this._sb) return;          // a socket's pose (setSeatBlend) owns the base clips while it holds
    // any library clip by name (a socket's enter/leave): loaded on first ask, the nearest posture meanwhile
    if (!this.actions[slot] && !CLIP_FALLBACK[slot] && !HYDRATED.has(slot)) this.ensureClip(slot);
    let use = slot;
    while (!this.actions[use] && CLIP_FALLBACK[use]) use = CLIP_FALLBACK[use];
    if (!this.actions[use]) use = this.actions.idle ? 'idle' : use;   // a named clip still loading: stand meanwhile
    this._setAction(this.actions[use], use, fade, ease);
    const a = this.actions[use];
    if (!a) return;
    // a bigger stride is a slower cadence at the same speed; the swim layer keeps its own cadence over idle
    a.timeScale = slot === 'swim' || slot === 'tread' ? 1 : clipRate(speed, CLIP_SPEED[slot], this.userScale);
  }

  /** Standing height in metres, from the skeleton at rest (the head joint plus a forehead — the stature
   *  rule the portrait framing uses), at this body's current size. What water depth is measured against. */
  bodyHeight() {
    const key = this.userScale ?? 1;
    if (this._bodyH && this._bodyHKey === key) return this._bodyH;
    let h = 1.7 * key;
    try {
      const r = this.restBonePositions(['head']);
      if (r?.head) h = Math.min(4, Math.max(0.5, r.head.y - this.root.position.y + 0.13));
    } catch { /* a body with no humanoid: the default */ }
    this._bodyH = h; this._bodyHKey = key;
    return h;
  }

  /** Procedural swimming over idle (no rig ships a swim clip), on the normalized bones (rest = identity: +x left, +z forward).
   *  `swim` a heads-up breaststroke, `tread` upright sculling; weights ease and cross-fade so nothing snaps.
   *  Runs BEFORE the held pose and animations (they win any bone they name); never the head (the camera pitch's).
   *  Drawn from the clip name alone: nothing new on the wire. */
  _swimLayer(dt, now) {
    const slot = this.postureSlot;
    const want = !this._limp && SWIM_CLIPS.includes(slot) ? 1 : 0;
    this._swimW = (this._swimW ?? 0) + (want - (this._swimW ?? 0)) * Math.min(1, 4 * dt);
    if (this._swimW < 0.005) { this._swimW = 0; return; }
    this._swimMove = (this._swimMove ?? 0) + ((slot === 'swim' ? 1 : 0) - (this._swimMove ?? 0)) * Math.min(1, 3 * dt);
    const h = this.vrm.humanoid, taken = this._reachOwned();
    const tg = swimTargets(this._swimMove, now / 1000), w = this._swimW;
    for (const [name, x, y, z] of tg) {
      const node = h?.getNormalizedBoneNode?.(name);
      if (!node || taken?.has(node)) continue;
      _swE.set(x, y, z, 'YZX');
      _swQ.setFromEuler(_swE);
      const r = this._composeBegin(node);
      node.quaternion.slerp(_swQ, w);
      this._composeEnd(node, r);
    }
  }
  _setAction(a, slot, fadeIn, ease = false) {
    if (!a || this.current === a) return;
    let linear = false;
    // the caller says how fast into a jump; the fallback is FADE_PRESS, shared so locomotion_clip.js can't diverge
    const fade = fadeIn ?? (slot === 'jump' ? FADE_PRESS : 0.22);
    // a cut inside an ease: fade the stranded outgoing action, and continue from the current weights with a
    // linear profile (a reset()+fadeIn would drop the weight sum for a frame)
    if (this._xfade) { const x = this._xfade; if (x.out && x.out !== a && x.out !== this.current) x.out.fadeOut(fade); this._xfade = null; ease = true; linear = true; }
    if (ease) {
      // three's fades are linear; this one is smoothstep on both sides so the weights always sum to 1
      const prev = this.current; const out0 = prev ? prev.getEffectiveWeight() : 0; if (prev) prev.stopFading();
      const in0 = a.getEffectiveWeight();   // from where the last fade left them, not 0/1, or a land-then-walk-off pops
      a.enabled = true; a.reset(); a.stopFading(); a.setEffectiveWeight(in0); a.play();
      this._xfade = { out: prev, in: a, dur: fade, t: 0, in0, out0, linear };
    } else {
      if (this.current) this.current.fadeOut(fade);
      a.enabled = true;
      a.setEffectiveWeight(1);       // base weight — fadeIn ramps a MULTIPLIER on this
      a.reset().fadeIn(fade);
    }
    // the jump leaves the ground at once but the clip opens crouched: start at take-off, measured from the clip,
    // or the body squats in mid-air
    if (slot === 'jump') a.time = clipTakeoff(a.getClip());
    this.current = a;
    this.currentSlot = slot;
  }

  /** Fill in the clips that weren't needed to stand up. Safe to call twice. One at a time, in idle moments,
   *  so it adds no second stall right after landing (parses are cached globally). */
  async hydrateClips() {
    if (this._hydrating) return this._hydrating;
    this._hydrating = (async () => {
      for (const [slot, name] of [...LATER_CLIPS.map((s) => [s, s]), ['sitchair', SEAT_CLIPS.chair]]) {
        await idleYield();
        try {
          const clip = await clipFor(this.vrm, name);
          const a = this.mixer.clipAction(clip);
          a.enabled = true; a.setEffectiveWeight(0); a.play();
          this.actions[slot] = a;
        } catch (e) {
          if (slot !== 'sitchair') console.warn(`clip ${slot} unavailable`, e);
        }
      }
    })();
    return this._hydrating;
  }

  /** Play a gesture over locomotion. Returns when it's queued, not done. */
  async playOnce(name) {
    const file = ANIM_CLIPS[name];
    if (!file) return;
    try {
      let action = this.extraClips.get(file);
      if (!action) {
        const clip = await clipFor(this.vrm, file);
        action = this.mixer.clipAction(clip);
        action.setLoop(THREE.LoopOnce, 1);
        action.clampWhenFinished = true;
        this.extraClips.set(file, action);
      }
      const dur = action.getClip().duration;
      // play() puts an action in the mixer's evaluation set; without it the skeleton sits at rest (T-pose).
      action.reset().play();
      this.onceAnim = null;           // let _setAction run
      this._setAction(action, `once:${name}`);
      this.onceAnim = { action, until: performance.now() + dur * 1000 };
    } catch (e) { report(`gesture ${name}`, e); }
  }
  cancelOnce() {
    if (!this.onceAnim) return;
    const action = this.onceAnim.action;
    this.onceAnim = null;
    // Must fade out: a LoopOnce + clampWhenFinished action holds its last frame at full weight forever.
    action.fadeOut(0.25);
    if (this.current === action) this.current = null; // next setClip fades in fresh
  }

  // ---- custom poses & one-off animations ---------------------------------
  // Humanoid-bone rotations, held (pose) or sampled (animation), slerped over the clip by a ramping
  // weight so they compose with a walk and ease back on release. A few hundred bytes; no mixer or asset.

  _resolveBones(names) {
    const out = [];
    for (const n of names) {
      const node = this.vrm.humanoid?.getNormalizedBoneNode?.(n);
      if (node) out.push([n, node]);
    }
    return out;
  }

  /** Any rig bone by exported name (hair, wings, lids, twist, raw humanoid halves), or null. Built once: remotes
   *  call setPose every frame while a pose blends. */
  _rawBone(name) {
    if (!this._rawBones) {
      this._rawBones = new Map();
      this.vrm.scene.traverse((o) => { if (o.isBone && o.name && !this._rawBones.has(o.name)) this._rawBones.set(o.name, o); });
    }
    return this._rawBones.get(name) ?? null;
  }

  /** A raw bone's rest from the load-time TRS (assets.js boneRest), never the live node (clip, springs, wings write it).
   *  `pq` the PARENT's model-frame rest rotation, `pinv` its inverse linear part, `rq` this bone's local rest:
   *  raw = P⁻¹·q·P·rest, three-vrm's humanoid composition for every bone. Null with no recorded rest (the capsule). */
  _rawRest(node) {
    this._rawRests ??= new Map();
    if (this._rawRests.has(node)) return this._rawRests.get(node);
    const table = this.vrm.userData?.boneRest;
    const local = (o) => {
      const r = table[o.name];
      return new THREE.Matrix4().compose(new THREE.Vector3().fromArray(r.p), new THREE.Quaternion().fromArray(r.q), new THREE.Vector3().fromArray(r.s));
    };
    let rest = null;
    if (table?.[node.name]) {
      // up through bones at rest; the first non-bone (the armature) doesn't animate, so now IS its rest
      const P = new THREE.Matrix4();
      let o = node.parent;
      while (o && o.isBone && table[o.name]) { P.premultiply(local(o)); o = o.parent; }
      if (o && o !== this.vrm.scene) {
        this.vrm.scene.updateMatrixWorld(true);
        P.premultiply(this.vrm.scene.matrixWorld.clone().invert().multiply(o.matrixWorld));
      }
      const pq = new THREE.Quaternion();
      P.decompose(new THREE.Vector3(), pq, new THREE.Vector3());
      rest = { pq, pqInv: pq.clone().invert(), rq: new THREE.Quaternion().fromArray(table[node.name].q),
        pinv: new THREE.Matrix3().setFromMatrix4(P).invert() };
    }
    this._rawRests.set(node, rest);
    return rest;
  }

  /** Hold a pose: sparse name -> [x,y,z,w] or {q?, t?, s?} (shared/humanoid.js poseChannels). A VRM humanoid name
   *  rotates the normalized bone over the clip; any other rig bone poses its raw node.
   *  t and s ride the raw node, except hips t: the normalized hips, so springs see the body where it is. */
  setPose(bones) {
    if (!bones || typeof bones !== 'object') return this.clearPose();
    const targets = new Map(), raw = [];
    let hipsT = null;
    const h = this.vrm.humanoid;
    for (const [n, v] of Object.entries(bones)) {
      const c = poseChannels(v);
      if (!c) continue;
      const norm = h?.getNormalizedBoneNode?.(n);
      if (norm) {
        if (c.q) targets.set(n, new THREE.Quaternion(c.q[0], c.q[1], c.q[2], c.q[3]).normalize());
        if (n === 'hips' && c.t) hipsT = new THREE.Vector3(c.t[0], c.t[1], c.t[2]);
        const t = n === 'hips' ? null : c.t;
        if (t || c.s) { const node = h.getRawBoneNode?.(n); if (node) raw.push({ node, q: null, t, s: c.s }); }
        continue;
      }
      const node = this._rawBone(n);
      if (node) raw.push({ node, q: c.q && new THREE.Quaternion(c.q[0], c.q[1], c.q[2], c.q[3]).normalize(), t: c.t, s: c.s });
    }
    if (!targets.size && !raw.length && !hipsT) return;
    const nodes = this._resolveBones([...targets.keys()]);
    // A pose replacing a pose must hand back bones only the old one covered, or a still clip track keeps them.
    if (this._override) this._handBack(this._override, nodes, raw, hipsT);
    this._override = {
      kind: 'pose', nodes,
      raw, hipsT, hipsNode: hipsT ? h.getNormalizedBoneNode('hips') : null,
      // A tumble starts at FULL weight: the ragdoll's first frame is the pose the body is already in.
      targets, weight: this._override?.weight ?? (this._limp ? 1 : 0), wantWeight: 1,
    };
  }

  /** Play a one-off animation. data = { dur, loop?, replace?, tracks: {bone:[{t,q:[x,y,z,w]}]} }.
   *  LAYERS over the held pose: a new one takes only ITS bones from playing layers; `replace` ends the others.
   *  Ending the held pose is the author's half of a replace, in presence; this body only renders it. */
  playAnimation(data) {
    // {stop: true}: every layer fades and hands its bones back to what is beneath, never the bind pose
    if (data?.stop === true) { for (const l of this._anims ?? []) l.wantWeight = 0; return; }
    if (!data?.tracks) return;
    const tracks = new Map();
    for (const [n, keys] of Object.entries(data.tracks)) {
      if (!Array.isArray(keys) || !keys.length) continue;
      tracks.set(n, keys.map((k) => ({
        t: Number(k.t) || 0,
        q: new THREE.Quaternion(...(k.q ?? [0, 0, 0, 1])).normalize(),
      })).sort((a, b) => a.t - b.t));
    }
    if (!tracks.size) return;
    const dur = Math.max(0.1, Math.min(30, Number(data.dur) || 2));
    const nodes = this._resolveBones([...tracks.keys()]);
    const mine = new Set(nodes.map(([, n]) => n));
    // omitted on legacy packets (which always replaced); a merge sends false explicitly
    const replace = data.replace !== false;
    let from = 0;   // a bone taken over mid-play continues from where it was
    this._anims ??= [];
    for (const l of this._anims) {
      const lose = l.nodes.filter(([, n]) => mine.has(n));
      if (lose.length) from = Math.max(from, l.weight);
      if (replace) this._handBack(l, nodes);
      else l.nodes = l.nodes.filter(([, n]) => !mine.has(n));
    }
    this._anims = replace ? [] : this._anims.filter((l) => l.nodes.length);
    this._anims.push({
      kind: 'anim', nodes,
      tracks, dur, loop: !!data.loop, start: performance.now(),
      weight: from, wantWeight: 1, _scratch: new THREE.Quaternion(),
    });
  }

  /** Return an outgoing override's bones to their owners (the clip, or the pose beneath), except those the incoming
   *  `nodes`/`raw`/`hipsT` go on writing. Only bones still holding exactly what we left are touched. */
  _handBack(o, nodes = [], raw = [], hipsT = null) {
    const keep = new Set(nodes.map(([, n]) => n));
    // an outgoing ANIMATION's bones under the held pose stay the pose's
    if (o !== this._override) for (const [, n] of this._override?.nodes ?? []) keep.add(n);
    for (const [, node] of o.nodes ?? []) {
      if (keep.has(node)) continue;
      const r = this._composed.get(node);
      if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
    }
    const keepRaw = new Set(raw.map((e) => e.node));
    for (const e of o.raw ?? []) if (!keepRaw.has(e.node)) this._rawRelease(e.node);
    if (o.hipsNode && !hipsT) this._rawRelease(o.hipsNode);
  }

  // ---- reaching: the target is a function, re-solved every frame. Own override slot so a held pose and
  // a reach coexist; where both write a bone the reach wins (one author per bone, see _composeBegin).

  /** One limb chain's fixed facts, once, in the ROOT's frame (rest = identity), where shared/reach.js works. */
  _measureChain(key) {
    this._chains ??= new Map();
    if (!this._chains.has(key)) this._chains.set(key, measureChain(this, key));
    return this._chains.get(key);
  }

  /** Reach `key` ('leftHand' | ...) toward [x,y,z] WORLD, or a function returning one (when the target moves). */
  setReach(key, target, opts = {}) {
    if (!REACH_CHAINS[key]) return false;
    if (!this._measureChain(key)) return false;
    this._reach ??= new Map();
    const prev = this._reach.get(key);
    this._reach.set(key, {
      key, target, weight: prev?.weight ?? 0, wantWeight: opts.weight ?? 1,
      pole: opts.pole ?? null, lastElbow: prev?.lastElbow ?? null, bound: [],
      lastPick: prev?.lastPick ?? null, lastSwivel: prev?.lastSwivel ?? null, lastTwist: prev?.lastTwist ?? null,
      lastGap: prev?.gap ?? prev?.lastGap ?? null,
      lastWrist: prev?.lastWrist ?? null,
      relation: opts.relation ?? null,
      palm: opts.palm !== false,
      owner: opts.owner ?? null,            // 'seat': a socket's reach (occupybody.js) — a person's own reach outranks it
      hint: opts.hint ?? null,              // () => [x,y,z] world: where the elbow/knee points (a socket's reach.hint)
      // a retarget must still restore the previous writes when the new relation can't solve (a cycle included)
      _nu: prev?._nu, _nl: prev?._nl, _nh: prev?._nh,
    });
    return true;
  }

  /** Let an arm go, easing back to whatever the clip was doing. */
  clearReach(key) {
    if (key == null) { for (const r of this._reach?.values() ?? []) r.wantWeight = 0; return; }
    const r = this._reach?.get(key);
    if (r) r.wantWeight = 0;
  }

  /** Each live reach's last frame, for callers that need to know a hand did NOT get there. */
  reachStatus() {
    const out = {};
    for (const [k, r] of this._reach ?? []) out[k] = { weight: r.weight, gap: r.gap ?? null, bound: r.bound, penetration: r.penetration ?? null, palmResidual: r.palmResidual ?? null };
    return out;
  }

  _applyReach(dt, now) {
    if (!this._reach?.size) return;
    // Establish this frame's clip base before any relation reads a target.
    for (const r of this._reach.values()) for (const node of [r._nu, r._nl, r._nh]) {
      const c = node && this._composed.get(node);
      if (c?.live && node.quaternion.equals(c.out)) { node.quaternion.copy(c.base); c.live = false; }
    }
    // retire fading reaches BEFORE planning (even unsolvable ones), so dependants resume against the clip this frame
    for (const [key, r] of this._reach) {
      if (r.wantWeight !== 0) continue;
      r.weight += (r.wantWeight - r.weight) * Math.min(1, 12 * dt);
      if (r.wantWeight === 0 && r.weight < 0.02) {
        this._reach.delete(key);
      }
    }
    const owner = this._reachOwner ?? 'self';
    const plan = planReaches([...this._reach].map(([limb, r]) => ({ owner, limb, target: r.relation, reach: r })));
    for (const e of plan.blocked) { e.reach.bound = ['cyclic-reach']; e.reach.gap = null; }
    for (const { limb: key, reach: r } of plan.order) {
      // Only solvable reaches fade IN; all releases already faded above.
      if (r.wantWeight !== 0) r.weight += (r.wantWeight - r.weight) * Math.min(1, 12 * dt);
      const ch = this._measureChain(key);
      if (!ch) { this._reach.delete(key); continue; }

      // a bare point or {pos, normal}: the normal lets the palm face the surface, not arrive back-first
      const raw = typeof r.target === 'function' ? r.target() : r.target;
      const tw = Array.isArray(raw) ? raw : raw?.pos;
      const normal = Array.isArray(raw) ? null : raw?.normal;
      if (!tw || tw.length !== 3 || !tw.every(Number.isFinite)) { r.bound = ['no-target']; continue; }

      // the palm faces INTO the surface: opposite the outward normal
      const palm = (r.palm !== false && normal && normal.length === 3 && normal.every(Number.isFinite))
        ? { dir: [-normal[0], -normal[1], -normal[2]] } : null;
      const hint = typeof r.hint === 'function' ? r.hint() : r.hint;
      const out = solveChain(ch, this, tw, r.lastElbow, { palm, lastPick: r.lastPick, lastSwivel: r.lastSwivel, lastTwist: r.lastTwist, lastWrist: r.lastWrist, lastGap: r.lastGap, dt,
        ...(Array.isArray(hint) && hint.length === 3 && hint.every(Number.isFinite) ? { hintWorld: hint } : {}) });
      if (!out.ok) { r.bound = [out.why]; continue; }
      r.bound = out.res.bound; r.gap = out.res.gap; r.lastPick = out.pick ?? null; r.lastSwivel = out.swivelUsed ?? null; r.penetration = out.penetration ?? 0; r.lastElbow = out.elbowOffset;
      // what the solver BELIEVES it placed (world), for probes to compare against the bones
      r.solved = { elbow: this.root.localToWorld(_rv3.set(...out.res.elbow)).toArray(),
                   hand: this.root.localToWorld(_rv4.set(...out.res.hand)).toArray() };
      const q = { upper: out.upper, lower: out.lower };
      r._nu = ch.nodes.upper; r._nl = ch.nodes.lower;
      this._writeBone(ch.nodes.upper, q.upper, r.weight);
      this._writeBone(ch.nodes.lower, q.lower, r.weight);
      if (out.hand) { r._nh = ch.nodes.end; this._writeBone(ch.nodes.end, out.hand, r.weight); }
      r.palmResidual = out.palmResidual ?? null;
      r.lastTwist = out.palmTwist ?? null;
      r.lastGap = out.res.gap;
      r.lastWrist = out.hand ?? null;
    }
  }

  /** Slerp a bone from the clip's value toward `q`, composed so a fade-out returns to the clip exactly. */
  _writeBone(node, q, weight) {
    const c = this._composeBegin(node);
    _rq3.set(q[0], q[1], q[2], q[3]);
    node.quaternion.slerp(_rq3, weight);
    this._composeEnd(node, c);
  }

  /** Bones a live reach owns this frame: a held pose writing them too composes two authors and both drift. */
  _reachOwned() {
    if (!this._reach?.size) return null;
    const s = new Set();
    for (const r of this._reach.values()) {
      const ch = this._chains?.get(r.key);
      if (ch && r.weight > 0.02) { s.add(ch.nodes.upper); s.add(ch.nodes.lower); }
    }
    return s.size ? s : null;
  }

  clearPose() { if (this._override) this._override.wantWeight = 0; }

  // ---- the body at a socket (shared/sockbody.js) ------------------------------
  // Its own layer over the mixer: several actions at once, weights per frame, time optionally driven.
  // While it holds, setClip yields (the seat owns the base clip); gestures still play over it.

  /** The action for a clip name, loading it from the animation library on first ask (null until it lands). Slot
   *  names (idle, walk, sit, sitchair, lie…) come from hydrateClips; every other name is a library file. */
  ensureClip(name) {
    if (this.actions[name]) return this.actions[name];
    if (HYDRATED.has(name) || !CLIP_NAME_RE.test(String(name))) return null;
    this._clipLoads ??= new Map();
    if (!this._clipLoads.has(name)) {
      this._clipLoads.set(name, clipFor(this.vrm, name).then((clip) => {
        if (this._disposed) return;
        const a = this.mixer.clipAction(clip);
        a.enabled = true; a.setEffectiveWeight(0); a.play();
        this.actions[name] = a;
      }).catch((e) => { console.warn(`[clips] '${name}' unavailable — the nearest posture stands in`, e?.message ?? e); }));
    }
    return null;
  }

  /** Hold a socket's pose, every frame while seated: `clips` [[name, weight]] summing to 1; `phase` null (own rate) or
   *  0..1 (each clip's time that fraction of its length). Null lets go. A loading clip's nearest loaded posture stands
   *  in, so the weights never fall short of a whole body. */
  setSeatBlend(clips, phase = null) {
    if (!clips) {
      if (!this._sb) return;
      for (const [a] of this._sb.w) a.fadeOut(0.25);
      this._sb = null; this.current = null;
      this.setClip('idle');   // the body's own clip comes back (the caller sets the real one on its next frame)
      return;
    }
    if (!this._sb) {
      // the clip playing now fades out under three's own fade; the blend's actions ease in under ours
      if (this.current && this.current !== this.onceAnim?.action) this.current.fadeOut(0.25);
      this.current = null; this.currentSlot = null; this._xfade = null;
      this._sb = { w: new Map(), want: [], phase: null };
    }
    this._sb.want = clips; this._sb.phase = Number.isFinite(phase) ? phase : null;
  }
  /** The slot carrying the body: currentSlot, or under a socket's pose the blend's heaviest clip, named as the slot it
   *  really is (a fallback reads as itself). The seat-profile gate reads this (occupants.js). */
  playingSlot() {
    if (!this._sb) return this.currentSlot;
    let best = null, bw = 0;
    for (const [a, w] of this._sb.w) if (w > bw) { best = a; bw = w; }
    if (!best) return null;
    for (const [n, act] of Object.entries(this.actions)) if (act === best) return n;
    return null;
  }
  /** What the seat blend is doing (probes and the agent's eye): [[clip, weight, time]] as the mixer has it. */
  seatBlendState() {
    if (!this._sb) return null;
    return { phase: this._sb.phase, clips: [...this._sb.w].map(([a, w]) => [a._seatName, +w.toFixed(4), +a.time.toFixed(4)]).filter((x) => x[1] > 1e-3) };
  }
  _applySeatBlend(dt) {
    const sb = this._sb;
    const target = new Map();
    for (const [name, w] of sb.want) {
      let use = name, a = this.ensureClip(name) ?? this.actions[name];
      while (!a && CLIP_FALLBACK[use]) { use = CLIP_FALLBACK[use]; a = this.actions[use]; }
      a ??= this.actions.idle;
      if (!a) continue;
      a._seatName ??= name;
      target.set(a, (target.get(a) ?? 0) + w);
    }
    for (const a of target.keys()) if (!sb.w.has(a)) { a.stopFading(); sb.w.set(a, a === this.current ? a.getEffectiveWeight() : 0); a.enabled = true; if (sb.phase == null) a.reset(); a.play(); }
    // a gesture plays over the seat; the seat yields exactly the weight it takes
    const over = this.onceAnim ? 1 - Math.min(1, this.onceAnim.action.getEffectiveWeight()) : 1;
    const k = Math.min(1, 10 * dt);
    for (const [a, cur] of sb.w) {
      const want = target.get(a) ?? 0;
      const w = cur + (want - cur) * k;
      if (want === 0 && w < 1e-3) { a.setEffectiveWeight(0); sb.w.delete(a); continue; }
      sb.w.set(a, w);
      a.setEffectiveWeight(w * over);
      if (sb.phase != null) { a.timeScale = 0; a.paused = false; a.time = sb.phase * a.getClip().duration; }
      else a.timeScale = 1;
    }
  }

  /** Sparse bone overrides a socket holds over its pose ({spine: [x,y,z,w]}: normalized humanoid bones, parent-local).
   *  A bone the person's own held pose or a reach names stays theirs. Null lets go. */
  setSeatHold(bones) {
    if (!bones || !Object.keys(bones).length) { if (this._seatHold) this._seatHold.want = 0; return; }
    const nodes = this._resolveBones(Object.keys(bones)).map(([n, node]) => [node, new THREE.Quaternion(...bones[n]).normalize()]);
    this._seatHold = { nodes, w: this._seatHold?.w ?? 0, want: 1 };
  }
  _applySeatHold(dt) {
    const h = this._seatHold;
    h.w += (h.want - h.w) * Math.min(1, 8 * dt);
    if (h.want === 0 && h.w < 0.01) { for (const [node] of h.nodes) { const r = this._composed.get(node); if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; } } this._seatHold = null; return; }
    const mine = new Set((this._override?.weight > 0.02 ? this._override.nodes : []).map(([, n]) => n));
    const reach = this._reachOwned();
    for (const [node, q] of h.nodes) if (!mine.has(node) && !reach?.has(node)) this._writeBone(node, [q.x, q.y, q.z, q.w], h.w);
  }

  /** What holding a thing does to this body (thingphysics.js): sparse normalized-bone rotations, each holding hand's
   *  fingers and, without tracked hands, the arms. Every client derives it from the door's hold record: never streamed.
   *  After a seat's hold (a held thing wins its hand); yields to the person's own pose and reach. Null lets go. */
  setHoldPose(bones) {
    const key = bones ? JSON.stringify(bones) : null;
    if (!key || key === '{}') { if (this._holdPose) this._holdPose.want = 0; return; }
    if (this._holdPose?.key === key) { this._holdPose.want = 1; return; }
    const nodes = this._resolveBones(Object.keys(bones)).map(([n, node]) => [node, new THREE.Quaternion(...bones[n]).normalize()]);
    this._holdPose = { key, nodes, w: this._holdPose?.w ?? 0, want: 1 };
  }
  _applyHoldPose(dt) {
    const h = this._holdPose;
    h.w += (h.want - h.w) * Math.min(1, 10 * dt);
    if (h.want === 0 && h.w < 0.01) { for (const [node] of h.nodes) { const r = this._composed.get(node); if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; } } this._holdPose = null; return; }
    const mine = new Set((this._override?.weight > 0.02 ? this._override.nodes : []).map(([, n]) => n));
    const reach = this._reachOwned();
    for (const [node, q] of h.nodes) if (!mine.has(node) && !reach?.has(node)) this._writeBone(node, [q.x, q.y, q.z, q.w], h.w);
  }

  /** Turn the head toward a look direction, in the BODY's frame (yaw about its up, pitch about its right, radians,
   *  + = left / up), clamped to the socket's limits and shared between neck (40%) and head (60%) — the turn a seated
   *  person makes to look round. Null lets the head go back to the clip. */
  setSeatLook(look) {
    if (!look) { if (this._seatLook) this._seatLook.want = 0; return; }
    this._seatLook = { yaw: look.yaw, pitch: look.pitch, w: this._seatLook?.w ?? 0, want: 1 };
  }
  _applySeatLook(dt) {
    const L = this._seatLook, h = this.vrm.humanoid;
    L.w += (L.want - L.w) * Math.min(1, 8 * dt);
    if (L.want === 0 && L.w < 0.01) { this._seatLook = null; return; }
    const parts = [['neck', 0.4], ['head', 0.6]].map(([n, f]) => [h?.getNormalizedBoneNode?.(n), f]).filter(([n]) => n);
    if (!parts.length) return;
    if (parts.length === 1) parts[0][1] = 1;
    this.root.getWorldQuaternion(_sl3).invert();   // world → body frame
    for (const [node, f] of parts) {
      const r = this._composeBegin(node);
      // the turn in the body frame, carried into the bone's parent frame: local = P⁻¹·T·P·local, P = body⁻¹·parentWorld
      _sl1.setFromAxisAngle(_Y2, L.yaw * f * L.w).multiply(_sl2.setFromAxisAngle(_X, -L.pitch * f * L.w));
      node.parent.getWorldQuaternion(_sl2).premultiply(_sl3);
      node.quaternion.premultiply(_sl2).premultiply(_sl1).premultiply(_sl2.invert());
      this._composeEnd(node, r);
    }
  }

  /** Which body point a socket seats (hips | feet | head), in the ROOT's frame, measured from the posed skeleton each
   *  frame (not declared), so any body in any clip lands on the socket. Null = not measured yet. */
  setAnchorWant(kind) { this._anchorWant = kind && kind !== 'root' ? kind : null; if (!this._anchorWant) this._anchorOff = null; }
  anchorOffset() { return this._anchorOff ?? null; }
  _measureAnchor() {
    const h = this.vrm.humanoid; const k = this._anchorWant;
    const bone = (n) => h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n) ?? null;
    let p = null;
    if (k === 'hips' || k === 'head') { const n = bone(k); if (n) p = n.getWorldPosition(_sa1); }
    else if (k === 'feet') { const l = bone('leftFoot'), r = bone('rightFoot'); if (l && r) p = l.getWorldPosition(_sa1).add(r.getWorldPosition(_sa2)).multiplyScalar(0.5); }
    if (!p) { this._anchorOff = null; return; }
    this.root.worldToLocal(p);
    // feet: the soles, not the ankles — the ankle's height above the root at rest, at this body's size
    if (k === 'feet') p.y -= (this._footRestY ?? 0) * this.vrm.scene.scale.y;
    this._anchorOff = p.toArray();
  }

  /** Move a held pose's hips translation onto the ROOT, joints unmoved, as a sim takes the body: its rotations-only pose
   *  would snap lowered hips back up. Remotes see the root carry the drop. True when something moved. */
  bakeHipsIntoRoot() {
    const o = this._override;
    if (o?.kind !== 'pose' || !o.hipsT || !o.hipsNode) return false;
    o.hipsNode.parent.updateWorldMatrix(true, false);
    _hv.copy(o.hipsT).multiplyScalar(o.weight)
      .applyMatrix3(new THREE.Matrix3().setFromMatrix4(o.hipsNode.parent.matrixWorld));
    this._rawRelease(o.hipsNode);
    o.hipsT = null; o.hipsNode = null;
    this.root.position.add(_hv);
    this.root.updateMatrixWorld(true);
    return true;
  }

  /** Go limp, or stand. Each frame after the mixer, bones the sim doesn't drive park at rest (chest->upperArm stays rigid).
   *  Do NOT stopAllAction(): actions play once and fade by weight, so stopping kills animation after standing, lets
   *  the head pitch integrate, and flashes a bind pose the Ragdoll then measures. */
  setLimp(on) {
    on = !!on;
    if (on === this._limp) return;
    this._limp = on;
    // Eyes close on going limp (eyelid-bone rigs only; remotes too, via setLimp). _limpEyes: getting up
    // reopens only eyes the fall shut, not ones closed by /eyes.
    if (on) { this._limpEyes = this.setEyes(true); }
    else if (this._limpEyes) { this._limpEyes = false; this.setEyes(false); }
    // Wings: capture where the sim left them so the flap slerps out (remotes stay frozen where the flap stopped).
    // Hair goes back to three-vrm on getting up, not when the doll disposes.
    if (!on) { this._releaseHair(); this._combHair(); }
    if (!on) {
      if (this._wings === undefined) this._findWings();
      if (this._wings) {
        for (const w of this._wings) w.from = w.node.quaternion.clone();
        this._wingBlend = 0;
      }
    }
    if (!on) {
      // Hand the bones back as found: a still clip track never overwrites the parked rest rotation.
      for (const [node, q] of this._parked ?? []) node.quaternion.copy(q);
      this._parked = null;
      return;
    }
    if (this.onceAnim) this.cancelOnce();
    for (const l of this._anims ?? []) this._handBack(l);   // a falling body stops waving
    this._anims = null;
    const driven = new Set(DRIVEN_BONES);
    this._parked = this._resolveBones(
      this._humanoidBones().filter((n) => !driven.has(n)))
      .map(([, node]) => [node, node.quaternion.clone()]);
    // now as well as per frame, so the Ragdoll about to be built reads a skeleton that agrees with what it drives
    this._park();
    this.root.updateMatrixWorld(true);
  }

  _park() { for (const [node] of this._parked ?? []) node.quaternion.identity(); }

  // ---- composing on top of the clip: three.js rewrites a bone only when its track value changes, so a
  // still track never undoes our edits. Remember the clip value and what we left; if the bone still holds
  // ours, restore the clip value first. Exact float compare is deliberate.
  _composeBegin(node) {
    let r = this._composed.get(node);
    if (!r) {
      r = { base: new THREE.Quaternion(), out: new THREE.Quaternion(), live: false };
      this._composed.set(node, r);
    }
    if (r.live && node.quaternion.equals(r.out)) node.quaternion.copy(r.base);
    r.base.copy(node.quaternion);
    return r;
  }
  _composeEnd(node, r) { r.out.copy(node.quaternion); r.live = true; }

  // The same guard per channel (rotation, position, scale), because owners differ: vrm.update rewrites a
  // humanoid bone's rotation every frame and never its scale.
  _rawBegin(node) {
    this._rawComposed ??= new Map();
    let r = this._rawComposed.get(node);
    if (!r) {
      r = { bq: new THREE.Quaternion(), bp: new THREE.Vector3(), bs: new THREE.Vector3(),
        oq: new THREE.Quaternion(), op: new THREE.Vector3(), os: new THREE.Vector3(), live: false };
      this._rawComposed.set(node, r);
    }
    if (r.live) {
      if (node.quaternion.equals(r.oq)) node.quaternion.copy(r.bq);
      if (node.position.equals(r.op)) node.position.copy(r.bp);
      if (node.scale.equals(r.os)) node.scale.copy(r.bs);
    }
    r.bq.copy(node.quaternion); r.bp.copy(node.position); r.bs.copy(node.scale);
    return r;
  }
  _rawEnd(node, r) { r.oq.copy(node.quaternion); r.op.copy(node.position); r.os.copy(node.scale); r.live = true; }
  /** Hand a raw-posed bone back: every channel we still own returns to its base. */
  _rawRelease(node) {
    const r = this._rawComposed?.get(node);
    if (!r?.live) return;
    if (node.quaternion.equals(r.oq)) node.quaternion.copy(r.bq);
    if (node.position.equals(r.op)) node.position.copy(r.bp);
    if (node.scale.equals(r.os)) node.scale.copy(r.bs);
    if (!node.matrixAutoUpdate) node.updateMatrix();
    r.live = false;
  }

  /** The raw half of a held pose: non-humanoid rotations, any bone's t/s. AFTER vrm.update and the wings (this bone's
   *  other authors), so a bone the pose names is the pose's. Not while limp: the sim owns the hair and wings. */
  _applyRawPose() {
    const o = this._override;
    if (o?.kind !== 'pose' || !o.raw?.length || this._limp) return;
    const w = o.weight;
    for (const e of o.raw) {
      const rest = this._rawRest(e.node);
      if (!rest) continue;
      const r = this._rawBegin(e.node);
      if (e.q) {   // local = P⁻¹ · q · P · rest
        _hq.copy(rest.pqInv).multiply(e.q).multiply(rest.pq).multiply(rest.rq);
        e.node.quaternion.slerp(_hq, w);
      }
      if (e.t) e.node.position.addScaledVector(_hv.set(e.t[0], e.t[1], e.t[2]).applyMatrix3(rest.pinv), w);
      if (e.s) e.node.scale.multiply(_hs.set(e.s[0], e.s[1], e.s[2]).lerp(_ONE, 1 - w));
      // spring joints run with matrixAutoUpdate off: a TRS write alone never reaches the skin
      if (!e.node.matrixAutoUpdate) e.node.updateMatrix();
      this._rawEnd(e.node, r);
    }
  }

  _humanoidBones() { return Object.keys(this.vrm.humanoid?.humanBones ?? {}); }

  /** World positions of the humanoid bones in the NEUTRAL rest pose (every humanoid rotation identity),
   *  without disturbing the pose on screen. The ragdoll measures limits, braces and hips offset against this,
   *  never the live skeleton, or a fall mid-stride takes the stride as rest. */
  restBonePositions(names = null) {
    const h = this.vrm.humanoid;
    if (!h) return null;
    const saved = [];
    for (const name of this._humanoidBones()) {
      const node = h.getNormalizedBoneNode(name);
      if (node) { saved.push([node, node.quaternion.clone()]); node.quaternion.identity(); }
    }
    this.root.updateMatrixWorld(true);
    const out = {};
    for (const name of names ?? this._humanoidBones()) {
      const node = h.getNormalizedBoneNode(name);
      if (node) out[name] = node.getWorldPosition(new THREE.Vector3());
    }
    for (const [node, q] of saved) node.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    return out;
  }

  /** One bone's rotation at time t (seconds): slerped between keys, clamped to the ends. */
  _sampleTrack(keys, t, out) {
    if (t <= keys[0].t) return out.copy(keys[0].q);
    const last = keys[keys.length - 1];
    if (t >= last.t) return out.copy(last.q);
    for (let i = 1; i < keys.length; i++) {
      if (t <= keys[i].t) {
        const a = keys[i - 1], b = keys[i];
        const f = (t - a.t) / Math.max(1e-4, b.t - a.t);
        return out.copy(a.q).slerp(b.q, f);
      }
    }
    return out.copy(last.q);
  }

  _applyOverride(dt, now) {
    // A live reach owns its two bones this frame: two authors would each read the other's output as the clip's.
    const taken = this._reachOwned();
    const posed = this._override ? this._applyPoseSlot(dt, taken) : null;
    if (this._anims?.length) {
      for (const l of this._anims) this._applyAnimSlot(l, dt, now, taken, posed);
      this._anims = this._anims.filter((l) => !l.done);
    }
  }

  /** The held pose. Returns the set of bones it wrote this frame. */
  _applyPoseSlot(dt, taken) {
    const o = this._override;
    const posed = new Set();
    // ease ~120ms
    o.weight += (o.wantWeight - o.weight) * Math.min(1, 12 * dt);
    if (o.wantWeight === 0 && o.weight < 0.02) {
      // hand the bones back: on a still track nothing clears the ramp's last 2%, and the body stands fractionally wrong forever
      for (const [, node] of o.nodes) {
        const r = this._composed.get(node);
        if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
      }
      if (o.hipsNode) this._rawRelease(o.hipsNode);
      for (const e of o.raw ?? []) this._rawRelease(e.node);
      this._override = null;
      return posed;
    }

    // Hips translation on the NORMALIZED hips (vrm.update carries it to raw), composed like rotation so a
    // clip with no hips track doesn't sink the body a little more each frame.
    if (o.kind === 'pose' && o.hipsNode && o.hipsT) {
      const r = this._rawBegin(o.hipsNode);
      o.hipsNode.position.addScaledVector(o.hipsT, o.weight);
      this._rawEnd(o.hipsNode, r);
    }

    if (o.kind === 'pose') {
      for (const [name, node] of o.nodes) {
        const target = o.targets.get(name);
        if (!target || taken?.has(node)) continue;
        // Composed, so the fade-OUT returns to the clip; a plain slerp never walks back.
        const r = this._composeBegin(node);
        node.quaternion.slerp(target, o.weight);
        this._composeEnd(node, r);
        posed.add(node);
      }
    }
    return posed;
  }

  /** The one-off animation, over whatever the clip and the pose left. A bone the pose wrote THIS frame is
   *  composed onto the pose's output (beginning afresh would read the pose's value as the clip's); ending
   *  records the combined value, so the pose's next begin still restores the clip underneath. */
  _applyAnimSlot(o, dt, now, taken, posed) {
    o.weight += (o.wantWeight - o.weight) * Math.min(1, 12 * dt);
    if (o.wantWeight === 0 && o.weight < 0.02) {
      for (const [, node] of o.nodes) {
        if (posed?.has(node)) continue;          // the pose goes on owning it
        const r = this._composed.get(node);
        if (r?.live && node.quaternion.equals(r.out)) { node.quaternion.copy(r.base); r.live = false; }
      }
      o.done = true;
      return;
    }
    let tt = (now - o.start) / 1000;
    if (tt >= o.dur) {
      if (o.loop) tt %= o.dur; else { o.wantWeight = 0; tt = o.dur; }
    }
    for (const [name, node] of o.nodes) {
      if (taken?.has(node)) continue;
      const r = posed?.has(node) ? this._composed.get(node) : this._composeBegin(node);
      this._sampleTrack(o.tracks.get(name), tt, o._scratch);
      node.quaternion.slerp(o._scratch, o.weight);
      this._composeEnd(node, r);
    }
  }

  /** Redraw the baked nameplate only: rebuilding the avatar for a label drops you through the floor mid-step. */
  setName(name) {
    this.id = name;
    this._labelName = name;
    this.repaintLabel();
  }
  /** This body's chosen size (bodyscale.js: 0.5–2, see its header). True when it changed. */
  setUserScale(u) {
    const v = clampBodyScale(u);
    if (v === (this.userScale ?? 1)) return false;
    this.userScale = v; this._applyBodyScale();
    return true;
  }
  /** The VR device fit (xr.js puppetScale, 1/k), composed under the chosen size. xrbody.js is its one writer. */
  setPuppetScale(p) {
    const v = p > 0 && Number.isFinite(p) ? p : 1;
    if (v === (this._puppet ?? 1)) return false;
    this._puppet = v; this._applyBodyScale();
    return true;
  }
  /** The body's model→root multiplier: chosen size × VR fit. The seat seam (occupants.js occupantScalar) reads this. */
  bodyScale() { return (this.userScale ?? 1) * (this._puppet ?? 1); }
  _applyBodyScale() {
    const sc = this.vrm?.scene;
    if (!sc) return;
    sc.scale.setScalar(this.bodyScale());
    sc.updateMatrixWorld(true);
    this._ownClear = null;   // the clearance over the plate is in world units: re-measure at the new size
    // reach limb lengths live in the root frame and see this size: re-measure eagerly, or a live resize bends the old arm
    if (this._chains) for (const key of [...this._chains.keys()]) this._chains.set(key, measureChain(this, key));
  }
  /** Metres the nameplate hangs over the measured crown, at the authored size (bodyscale.js plateLift). 0 = auto. */
  setPlateY(m) {
    const v = clampPlateY(m);
    if (v === (this.plateY ?? 0)) return false;
    this.plateY = v; this._ownClear = null;
    return true;
  }

  /** The crown, measured ONCE at rest (constructor, no clip yet): plateanchor.js crownEstimate over the raw head/hips/eye
   *  bones and the SKINNED mesh top (≤4000 vertices a mesh). In model units, so a live resize multiplies in per frame
   *  instead of going stale. null = nothing to measure. */
  _measurePlateRest() {
    try {
      const sc = this.vrm?.scene, h = this.vrm?.humanoid;
      if (!sc) return null;
      this.root.updateMatrixWorld(true);
      const inv = new THREE.Matrix4().copy(sc.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
      const yOf = (n) => { const b = h?.getRawBoneNode?.(n) ?? h?.getNormalizedBoneNode?.(n);
        return b ? b.getWorldPosition(v).applyMatrix4(inv).y : null; };
      const hips = yOf('hips'), head = yOf('head'), le = yOf('leftEye'), re = yOf('rightEye');
      const eye = le != null && re != null ? (le + re) / 2 : (le ?? re);
      const lf = yOf('leftFoot'), rf = yOf('rightFoot');
      const feet = lf != null || rf != null ? Math.min(lf ?? Infinity, rf ?? Infinity) : 0;
      let top = -Infinity;
      sc.traverse((o) => {
        const pos = o.isMesh && o.visible !== false ? o.geometry?.attributes?.position : null;
        if (!pos) return;
        m.multiplyMatrices(inv, o.matrixWorld);
        const step = Math.max(1, Math.ceil(pos.count / 4000));
        for (let i = 0; i < pos.count; i += step) {
          o.getVertexPosition(i, v);   // skinned + morphed, in the mesh's own space
          v.applyMatrix4(m);
          if (v.y > top) top = v.y;
        }
      });
      const boundsTop = Number.isFinite(top) ? top : null;
      const c = crownEstimate({ hips, head, eye, boundsTop });
      const crown = c?.crown ?? boundsTop;
      return { ...(c ?? {}), boundsTop, eye, feet, restHeadAboveFeet: head != null ? head - feet : null,
        height: crown != null ? crown - feet : null };
    } catch { return null; }
  }

  /** Hang the plate from the body this frame (plateanchor.js says why): X/Z over the live hips (the head, lying), Y from
   *  the rest crown, chased on height ABOVE THE ROOT so moving the whole body never makes it trail; only posture eases.
   *  Standing, Y is the rest crown, so a jump clip's hips don't move it. Worked in WORLD, written in the root's frame.
   *  No hips/head: over the rest mesh top; nothing at all: 1.95. */
  _placePlate(dt) {
    const r = this._plateRest, sc = this.vrm?.scene, h = this.vrm?.humanoid;
    if (!sc || !r || (r.hipsToCrown == null && r.boundsTop == null)) { this.label.position.set(0, 1.95, 0); this._plateDrop = null; return; }
    this.root.updateWorldMatrix(true, false);
    const s = sc.getWorldScale(_pScale).y || 1;   // model units → world (root scale × puppet scale)
    const gap = plateGap((r.height ?? 1.7) * s);
    const lift = plateLift(this.plateY, s);   // the wearer's own lift over the crown (Profile › Avatar), grows with the body
    this._plateDrop = gap + lift;   // plate → crown, and the head under it as a ball (_liftPlateForView)
    this._plateHeadR = r.headSpan != null ? r.headSpan * s / 2 : 0.1;
    const rootY = this.root.getWorldPosition(_pRoot).y;
    const hipsN = r.hipsToCrown != null ? plateBone(h, 'hips') : null, headN = hipsN ? plateBone(h, 'head') : null;
    let x, y, z;
    if (hipsN && headN) {
      // per body, per frame: the arguments and the answer are module scratch
      const a = _pArgs;
      hipsN.getWorldPosition(_pHips).toArray(a.hips); headN.getWorldPosition(_pHead).toArray(a.head);
      let feetY = Infinity;
      for (let i = 0; i < 2; i++) { const f = plateBone(h, FEET[i]); if (f) feetY = Math.min(feetY, f.getWorldPosition(_pFoot).y); }
      a.feetY = Number.isFinite(feetY) ? feetY : rootY; a.rest = r; a.s = s; a.gap = gap; a.lift = lift;
      const { p, lie } = plateAnchor(a, _pOut);
      x = p[0]; y = p[1]; z = p[2];
      this._plateLie = lie;
    } else {
      _pHips.set(0, r.boundsTop, 0); sc.localToWorld(_pHips);
      x = _pHips.x; y = _pHips.y + gap + lift; z = _pHips.z;
      this._plateLie = 0;
    }
    const standing = hipsN && headN && r.crown != null && this._plateStanding();
    let standY = 0;
    if (standing) {
      x = _pArgs.hips[0]; z = _pArgs.hips[2]; this._plateLie = 0;
      _pRest.set(0, r.crown, 0); sc.localToWorld(_pRest);
      standY = _pRest.y + gap + lift - rootY;
    }
    _pTarget.standing = !!standing; _pTarget.standY = standY; _pTarget.liveY = y - rootY;
    this._plateOff = plateOffset(this._plateOff, _pTarget, dt, _pSmooth);
    this.label.position.copy(this.root.worldToLocal(_pHips.set(x, rootY + this._plateOff, z)));
  }

  /** Upright in ordinary motion (plateanchor.js STAND_SLOTS), with nothing else owning the body: a gesture, a held
   *  pose and a ragdoll fall can crouch, bow or tumble it, so they keep the live anchor. */
  _plateStanding() { return STAND_SLOTS.has(this.postureSlot) && !this.onceAnim && !this._override && !this._limp; }

  /** Slide the plate off the head for THIS viewer's camera (plateanchor.js plateViewLift), along its up: nothing on the
   *  wire. After _placePlate, the clearance and this frame's size; the pill and bubble copy the plate after it. */
  _liftPlateForView(camera) {
    if (this._plateDrop == null) return;
    const lab = this.label, a = _lvArgs;
    this.root.updateWorldMatrix(true, false);
    this.root.localToWorld(_lvP.copy(lab.position));
    camera.getWorldPosition(_lvE); camera.getWorldQuaternion(_lvQ);
    _lvU.set(0, 1, 0).applyQuaternion(_lvQ); _lvF.set(0, 0, -1).applyQuaternion(_lvQ);
    _lvE.toArray(a.eye); _lvU.toArray(a.up); _lvF.toArray(a.fwd); _lvP.toArray(a.plate);
    a.drop = this._plateDrop; a.headR = this._plateHeadR ?? 0.1;
    a.halfH = lab.scale.x * this.root.getWorldScale(_pScale).y * (lab.userData.pillH ?? 52 / 512) / 2;   // the pill as drawn, world m
    const d = plateViewLift(a);
    if (d > 0) lab.position.copy(this.root.worldToLocal(_lvP.addScaledVector(_lvU, d)));
  }

  /** Your own plate is for OTHER eyes: hidden while presenting (hideLabel, xr.js selfFirstPerson) and in desktop first
   *  person (firstPersonView, controller.js updateFollowCamera) — with the typing pill and the bubble over it. */
  get ownPlateHidden() { return !!(this.hideLabel || this.firstPersonView); }

  /** The clearance this body's sprites write (platesize.js ownClearance/reachAbove), from where the plate hangs THIS
   *  frame (_placePlate first). Sampled ONCE (skinned, ≤4000 vertices a mesh) in the VRM scene's frame; size, lift and
   *  VR fit only re-project it (exact: none moves a vertex in the scene). Nothing measurable: CLEAR_MIN. */
  _measureOwnClear() {
    try {
      const sceneRoot = this.vrm?.scene;
      if (!sceneRoot) return ownClearance(0);
      this.root.updateMatrixWorld(true);
      const pts = this._ownPts ??= this._sampleOwnBody(sceneRoot);
      const out = this._ownXyz ??= new Float32Array(pts.length);
      const e = _ownM.copy(this.root.matrixWorld).invert().multiply(sceneRoot.matrixWorld).elements;
      const ax = this.label.position.x, az = this.label.position.z;
      for (let i = 0; i < pts.length; i += 3) {
        const x = pts[i], y = pts[i + 1], z = pts[i + 2];
        out[i] = e[0] * x + e[4] * y + e[8] * z + e[12] - ax;   // relative to the plate's own column (it hangs over the hips, not the root)
        out[i + 1] = e[1] * x + e[5] * y + e[9] * z + e[13];
        out[i + 2] = e[2] * x + e[6] * y + e[10] * z + e[14] - az;
      }
      return ownClearance(reachAbove(out, this.label.position.y));
    } catch { return ownClearance(0); }
  }
  _sampleOwnBody(sceneRoot) {
    const inv = new THREE.Matrix4().copy(sceneRoot.matrixWorld).invert(), m = new THREE.Matrix4(), v = new THREE.Vector3();
    const meshes = [];
    let n = 0;
    sceneRoot.traverse((o) => {
      const pos = o.isMesh && o.visible !== false ? o.geometry?.attributes?.position : null;
      if (!pos) return;
      const step = Math.max(1, Math.ceil(pos.count / 4000));
      meshes.push([o, pos.count, step]); n += Math.ceil(pos.count / step);
    });
    const pts = new Float32Array(n * 3);
    let k = 0;
    for (const [o, count, step] of meshes) {
      m.multiplyMatrices(inv, o.matrixWorld);
      for (let i = 0; i < count; i += step) {
        o.getVertexPosition(i, v);   // skinned + morphed, in the mesh's own space
        v.applyMatrix4(m);
        pts[k++] = v.x; pts[k++] = v.y; pts[k++] = v.z;
      }
    }
    return pts;
  }

  /** rebuild the nameplate sprite from the current tokens (rename, or a Style change) */
  repaintLabel() {
    const name = this._labelName ?? this.id ?? '';
    const at = this.label.position.clone();   // where the body hangs it (_placePlate); the new sprite takes the same spot
    this.root.remove(this.label);
    disposeSprite(this.label);
    this.label = makeLabel(this._seatApprox ? `${name} ≈` : name);
    this.label.position.copy(at);
    this.root.add(this.label);
  }

  /** (#101) A seated body whose profile gate is closed (legacy socket, no profile, clip not loaded…) wears a ≈ on its plate:
   *  no silent root-at-socket. Redrawn only on a transition. */
  setSeatApprox(on) {
    if (this._seatApprox === !!on) return;
    this._seatApprox = !!on;
    this.setName(this.id);
  }

  // ---- speech
  /** Generation-end (#95): the TRANSIENTS (pill, bubble, held pose, limpness, gaze) belong to the generation, not the mesh a
   *  takeover transplants. Each resets through its own teardown, never a second way to die. */
  resetTransients() {
    this.setTyping(null);
    this.bubbleUntil = 0;
    this.speakUntil = 0;
    this.voiceLevel = null;
    this.clearPose();
    for (const l of this._anims ?? []) this._handBack(l);
    this._anims = null;
    this.clearReach();      // a transplanted body must not keep reaching at the predecessor's target
    this.setLimp(false);
    this.setGazeTarget(null);
    this.setClip('idle');
  }

  /** Repeated calls extend it; it expires on its own, so a dropped stop never leaves the dots up. */
  setTyping(state) {
    // null means STOP: clear the pill, never schedule 4s of an empty one
    if (state === null) { this._typingUntil = 0; this._typingState = null; return; }
    this._typingUntil = performance.now() + 4000;
    this._typingState = state || null;
  }

  say(text) {
    // speaking ends COMPOSING, not a live mic: the voice is still coming out of this body
    if (this._typingState !== 'mic') this._typingUntil = 0;
    if (this.bubble) { this.root.remove(this.bubble); disposeSprite(this.bubble); }
    this.bubble = makeBubble(text);
    this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // it rides the plate (update keeps it there)
    this.root.add(this.bubble);
    // roughly reading speed, clamped
    const ms = THREE.MathUtils.clamp(2500 + text.length * 45, 5000, 22000);
    this.bubbleUntil = performance.now() + ms;
    this.speakUntil = performance.now() + Math.min(ms, 1000 + text.length * 38);
  }

  /** Where this body should be looking. Null = relax to neutral. */
  setGazeTarget(v3) {
    if (v3) { this.gazeGoal.copy(v3); this._hasGaze = true; }
    else this._hasGaze = false;
  }

  update(dt, now = performance.now()) {
    if (this._xfade) {   // the eased crossfade (see _setAction): smoothstep in, its complement out
      const x = this._xfade; x.t += dt; const u = Math.min(1, x.t / x.dur), w = x.linear ? u : u * u * (3 - 2 * u);
      x.in.setEffectiveWeight(x.in0 + (1 - x.in0) * w); if (x.out && x.out !== x.in) x.out.setEffectiveWeight(x.out0 * (1 - w));
      if (u >= 1) { if (x.out && x.out !== x.in) x.out.setEffectiveWeight(0); this._xfade = null; }
    }
    const BC = globalThis.__ewBC ?? (() => {});
    if (this.onceAnim && now > this.onceAnim.until) this.cancelOnce();

    if (this._sb) this._applySeatBlend(dt);   // a socket's pose: its weights (and locked times) before the mixer samples
    BC('av:mixer');
    this.mixer.update(dt);
    // generic swim overlay: restore the clip every frame so leaving water releases the limbs
    for (const node of this._swimNodes ?? []) {
      const r=this._composed.get(node);
      if(r?.live && node.quaternion.equals(r.out))node.quaternion.copy(r.base);
    }
    this._swimNodes=[];
    if(this.locomotion?.medium==='water' && this.locomotion?.body!=='submarine' && !SWIM_CLIPS.includes(this.postureSlot) && !this._limp && !this._override && !this.onceAnim){
      for(const [name,rotation] of Object.entries(swimPose(now/1000,this.locomotion.mode==='surface'))){
        const node=this.vrm.humanoid?.getNormalizedBoneNode(name);if(!node)continue;
        const r=this._composeBegin(node);
        node.quaternion.setFromEuler(new THREE.Euler(...rotation));
        this._composeEnd(node,r);this._swimNodes.push(node);
      }
    }

    // While limp the clip keeps running (see setLimp), so bones the sim doesn't drive are re-parked after every mixer write.
    BC('av:park');
    if (this._limp) this._park();

    // ---- bone edits go between mixer.update and vrm.update (after it, the mixer overwrites them unseen).
    // Not while limp. Via _composeBegin so it can't integrate.
    BC('av:head');
    if (this.head && !this._limp) {
      const r = this._composeBegin(this.head);
      if (this.pitch) {
        this.head.quaternion.premultiply(
          _pq.setFromAxisAngle(_X, THREE.MathUtils.clamp(this.pitch, -0.5, 0.6)));
      }
      this._composeEnd(this.head, r);
    }
    if (this._seatLook && !this._limp) this._applySeatLook(dt);   // a seated head turns toward the look, within the socket's limits
    BC('av:swim');
    if (this._swimW || this.postureSlot === 'swim' || this.postureSlot === 'tread') this._swimLayer(dt, now);
    BC('av:override');
    if (this._override || this._anims?.length) this._applyOverride(dt, now);
    if (this._seatHold && !this._limp) this._applySeatHold(dt);
    if (this._holdPose && !this._limp) this._applyHoldPose(dt);   // after the seat's hold: a held thing wins its hand

    // ---- reach: after the held pose (which yields reach-owned bones), before vrm.update. Not while limp.
    BC('av:reach');
    if (this._reach?.size && !this._limp) this._applyReach(dt, now);
    else if (this._limp && this._reach?.size) this._reach.clear();

    // ---- gaze: ease the target so eyes track instead of snapping
    if (this._hasGaze) this.gaze.position.lerp(this.gazeGoal, 1 - Math.exp(-6 * dt));
    else {
      _v.set(0, 1.5, 3).applyAxisAngle(new THREE.Vector3(0, 1, 0), this.root.rotation.y)
        .add(this.root.position);
      this.gaze.position.lerp(_v, 1 - Math.exp(-3 * dt));
    }

    // ---- blink: irregular, in pairs sometimes, never metronomic. The clock runs even without
    // expressions: bone-eyelid rigs have none.
    let blinkV = 0;
    if (this.blinkT >= 0) {
      this.blinkT += dt;
      const k = this.blinkT / Math.max(0.05, BLINK.dur);
      blinkV = k < 1 ? Math.sin(k * Math.PI) : 0;
      if (k >= 1) {
        this.blinkT = -1;
        // Schedule from the END of the blink: from the start, the pair gap is shorter than a blink.
        const rate = Math.max(0.15, BLINK.hz);
        this.blinkAt = now + (Math.random() < 0.22 ? 220
          : (2200 + Math.random() * 4200) / rate);
      }
    } else if (now > this.blinkAt) {
      this.blinkT = 0;
    }
    // ---- eyeballs: point them at the target the gaze already eases to
    if (this._eyes === undefined) this._findEyes();
    if (this._eyes && this.head) {
      this.head.getWorldQuaternion(_gq);
      _gf.set(0, 0, 1).applyQuaternion(_gq);          // where the head faces NOW
      for (const e of this._eyes) {
        e.node.getWorldPosition(_gp);
        _gw.copy(this.gaze.position).sub(_gp);
        if (_gw.lengthSq() < 1e-10) continue;
        _gw.normalize();
        _gd.setFromUnitVectors(_gf, _gw);             // the world-space turn
        const ang = 2 * Math.acos(Math.min(1, Math.abs(_gd.w)));
        if (ang > BLINK.eyeMax) {                     // clamp into a cone
          _gi.identity().slerp(_gd, BLINK.eyeMax / ang);
          _gd.copy(_gi);
        }
        // local = parentWorld⁻¹ · turn · parentWorld · rest
        e.node.parent.getWorldQuaternion(_gpq);
        _gi.copy(_gpq).invert().multiply(_gd).multiply(_gpq).multiply(e.rest);
        e.node.quaternion.copy(_gi);
      }
    }

    if (this._lids === undefined) this._findLids();
    // ease toward the held state — a lid that snaps shut reads as a flinch
    this._eyesShut = this._eyesShut ?? 0;
    const goal = this._eyesGoal ?? 0;
    if (this._eyesShut !== goal) {
      this._eyesShut += (goal - this._eyesShut) * (1 - Math.exp(-12 * dt));
      if (Math.abs(goal - this._eyesShut) < 0.002) this._eyesShut = goal;
    }
    // lids as BONES, from a rest captured once, so a blink can't integrate
    if (this._lids) {
      // a held close (/eyes) and a blink share the lids: the further shut wins
      const amt = Math.max(blinkV, this._eyesShut ?? 0);
      for (const l of this._lids) {
        l.node.quaternion.copy(l.rest);
        // the rig's own exported limit wins; BLINK.closed is the dial otherwise
        const shut = l.exported ?? (l.lower ? BLINK.lower : BLINK.closed);
        if (amt > 0) {
          const ax = BLINK.axis === 1 ? _Y2 : BLINK.axis === 2 ? _Z2 : _X;
          l.node.quaternion.multiply(_pq.setFromAxisAngle(ax, shut * amt));
        }
      }
    }

    const em = this.vrm.expressionManager;
    if (em) {
      em.setValue('blink', blinkV);
      // ---- mouth: a real amplitude (live mic) wins; else a syllable-rate envelope for the utterance.
      // Asymmetric smoothing: jaws open fast and close slower.
      if (this.voiceLevel != null) {
        const target = Math.min(1, this.voiceLevel * 3.2);
        const k = target > this._mouth ? 0.55 : 0.18;
        this._mouth += (target - this._mouth) * k;
        em.setValue('aa', this._mouth * 0.8);
      } else if (now < this.speakUntil) {
        const t = now / 1000;
        const env = 0.5 + 0.5 * Math.sin(t * 17) * Math.sin(t * 7.3);
        em.setValue('aa', Math.max(0, env) * 0.65);
        this._mouth = 0;
      } else { em.setValue('aa', 0); this._mouth = 0; }
    }

    BC('av:gaze-expr');
    // One author per bone: while a local sim owns the hair (__simHair, set by ammodoll), null the
    // springBoneManager so Bullet wins. It suppresses the WHOLE manager: non-hair springs freeze too.
    // Self-heals here if a tumble ends without setLimp.
    if (this.__simHair && !this._limp) { this._releaseHair(); this._combHair(); }
    // limp with no own sim: the hair hangs on the world (see _springsLimp)
    this._springsLimp(this._limp && !this.__simHair);
    const sbm = this.__simHair ? this.vrm.springBoneManager : null;
    if (sbm) this.vrm.springBoneManager = null;
    // The seam for tracked-body writes (xrbody): after the mixer, before vrm.update copies normalized → raw.
    this.onBeforeVrmUpdate?.(dt);
    this.vrm.update(dt);
    if (sbm) this.vrm.springBoneManager = sbm;
    if (this._anchorWant) this._measureAnchor();   // the posed anchor (hips/feet/head) where the seat put the root

    // ---- wings: AFTER vrm.update. Raw non-humanoid bones nothing overwrites, but their humanoid clavicle
    // gets this frame's pose only in vrm.update. While limp the sim owns them.
    if (this._wings === undefined) this._findWings();
    if (this._wings && !this._limp) this._flap(dt);
    // the held pose's raw bones — last, so it wins every bone it names
    if (this._override) this._applyRawPose();

    // The lamp pulses on BREATH (shared/breath.js) with the wings; dials are LAMP_* above. Surface and
    // cast light move together. Half angular rate, so the period is BREATH.
    if (this._lampMats === undefined) {
      this._lampMats = [];
      this.vrm.scene.traverse((o) => {
        if (!o.isMesh) return;
        for (const m of (Array.isArray(o.material) ? o.material : [o.material])) {
          if (m?.emissiveIntensity !== undefined && /lampglass/i.test(m.name || '')) {
            // ?? not ||: an authored emissiveIntensity of zero is deliberate.
            this._lampMats.push({ m, base: m.emissiveIntensity ?? 1 });
          }
        }
      });
    }
    if (this._lampMats.length) {
      const phase = (now / 1000) * (Math.PI / BREATH);   // half-rate: |sin| doubles it
      const breath = Math.abs(Math.sin(phase)) ** LAMP_SHAPE;
      // the sky sets the ceiling: the cast light's (1-dayness)^2, floored so it never reads off at noon
      const day = LAMP_DAY_FLOOR + (1 - LAMP_DAY_FLOOR) * glowScale();
      const k = (LAMP_FLOOR + (LAMP_PEAK - LAMP_FLOOR) * breath) * day;
      for (const { m, base } of this._lampMats) m.emissiveIntensity = base * k;
      // the cast gets the BREATH only: the rig applies dayGlow to a dayAware request, so `day` here would square it
      for (const { key, intensity } of this._lamps) {
        updateRequest(key, { intensity: intensity * (LAMP_FLOOR
          + (LAMP_PEAK - LAMP_FLOOR) * breath) });
      }
    }

    // ---- contact shadow: on the GROUND under the body (surfaceUnder, so a platform counts), shrinking
    // and fading with the gap so height reads.
    if (this.shadow) {
      const rp = this.root.position;
      const gy = surfaceUnder(rp.x, rp.z, heightAt, rp.y + 0.05).y;
      const gap = Math.max(0, rp.y - gy);
      this.shadow.position.y = (gy - rp.y) + 0.02;
      // 3 m up the blob is gone; directly underfoot it is full size.
      const k = THREE.MathUtils.clamp(1 - gap / 3, 0, 1);
      this.shadow.scale.setScalar((0.55 + 0.45 * k) * (this.userScale ?? 1));   // a bigger body throws a bigger blob
      this.shadow.material.opacity = k * k;
      this.shadow.visible = k > 0.02;
    }

    BC('av:plates');

    // ---- nameplate: world-sized up close, readable at range, gone past 20–30 m (platesize.js says why); depth-tested
    // but cleared of its OWN body; while names are held (namereveal.js) it comes through everything
    const d = this.root.position.distanceTo(camera.getWorldPosition(_plateEye));   // WORLD: in XR camera.position is rig-local
    const rk = revealLevel();
    const { lw, vis } = plateSize(d, rk);
    this._placePlate(dt);   // hang it from the body first: the clearance below is measured from where it hangs
    if (this._ownClear == null) this._ownClear = this._measureOwnClear();
    this.label.userData.plateClear = plateClear(this._ownClear, d, rk);
    this.label.material.opacity = vis;
    const ownHidden = this.ownPlateHidden;
    this.label.visible = vis > 0.02 && !ownHidden;
    this.label.scale.set(lw, lw * (this.label.userData.aspect ?? 64 / 512), 1);   // scale carries the aspect: the text keeps its size whatever the canvas height
    this._liftPlateForView(camera);   // after the size (the lift clears the pill as drawn), before what hangs off the plate

    if (this.bubble) {
      if (now > this.bubbleUntil) {
        this.root.remove(this.bubble); disposeSprite(this.bubble); this.bubble = null;
      } else {
        this.bubble.position.copy(this.label.position).y += BUBBLE_LIFT;   // follows the plate down when they sit or lie
        this.bubble.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
        this.bubble.visible = !ownHidden;
      }
    }

    // ---- typing dots: hidden behind a bubble, except a live mic, which stacks above it
    const micLive = this._typingState === 'mic';
    const typingNow = now < this._typingUntil && (micLive || !this.bubble);
    if (typingNow && !this.typing) { this.typing = makeTypingSprite(); this.root.add(this.typing); }
    if (this.typing) this.typing.position.copy(this.label.position).y += (micLive && this.bubble) ? TYPING_OVER_BUBBLE : TYPING_LIFT;
    // the pill sits above the plate's anchor: its own reach is the plate's plus the lift (triangle inequality); not revealed
    if (this.typing) this.typing.userData.plateClear = this._ownClear + Math.abs(this.typing.position.y - this.label.position.y);
    if (this.typing) {
      this.typing.visible = typingNow && !ownHidden;
      if (typingNow) {
        if (now - this._typingDrawAt > 110) {
          this._typingDrawAt = now;
          drawTypingDots(this.typing, now / 1000, this._typingState);
          if (globalThis.__pillDebug) globalThis.__pillLast = { id: this.id, state: this._typingState, t: now };
        }
        this.typing.material.opacity = THREE.MathUtils.clamp(1 - (d - 26) / 12, 0, 1);
      }
    }
  }

  // Split teardown (§19b): per-body state dies here; the VRM itself is NOT disposed. The pool owns
  // disposal (assets.js releaseVRM); deep-disposing a pooled body is the black-avatar landmine (§13.3).
  dispose() {
    liveAvatars.delete(this);
    // idempotent, load-bearing: a second dispose after the VRM is re-worn would pool a body someone wears
    if (this._disposed) return;
    this._disposed = true;
    // keyed to this instance, so an old body can't delete its replacement's lamp
    releaseOwner(this._lampOwner);
    // ...and restore the emissive: the breath writes it and the pool doesn't reset materials, so the
    // next wearer could fall under attachLamps' threshold.
    for (const { m, base } of this._lampMats ?? []) m.emissiveIntensity = base;
    scene.remove(this.root);
    scene.remove(this.gaze);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
    disposeSprite(this.label);
    // the pool resets humanoid rotation/position only: return every raw channel we own before the next wearer
    for (const node of this._rawComposed?.keys() ?? []) this._rawRelease(node);
    this._rawComposed?.clear();
    this.mixer.stopAllAction();
    this._composed.clear();
    releaseVRM(this.vrm);
  }
}

// ---------------------------------------------------------------- shadows
// A cheap contact shadow: a blob under the feet shows where a body is relative to the ground.
let blobTex = null;
function makeBlobShadow() {
  if (!blobTex) {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const ctx = c.getContext('2d');
    const g = ctx.createRadialGradient(64, 64, 4, 64, 64, 62);
    g.addColorStop(0, 'rgba(0,0,0,0.5)');
    g.addColorStop(0.6, 'rgba(0,0,0,0.22)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g; ctx.fillRect(0, 0, 128, 128);
    blobTex = new THREE.CanvasTexture(c);
  }
  const m = new THREE.Mesh(
    new THREE.PlaneGeometry(1.15, 1.15).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false }),
  );
  m.position.y = 0.02;
  m.renderOrder = 1;
  return m;
}

// ---------------------------------------------------------------- factory

/** The body of last resort (capsulebody.js): a real Avatar over a capsule puppet — labels, gestures, the XR arm
 *  solver and the wire all work on it. Never throws; never touches the network. */
export function makeCapsuleAvatar(id) {
  const av = new Avatar(id, makeCapsuleVrm(), {});
  av.isCapsule = true;
  // the standard clips, best-effort: the capsule exists because the network may be gone; a still puppet is the floor
  (async () => {
    for (const slot of CORE_CLIPS) {
      try { const clip = await clipFor(av.vrm, slot); if (av._disposed) return;   // a remote disposed on takeover: stop feeding a dead body
        const a = av.mixer.clipAction(clip); a.enabled = true; a.setEffectiveWeight(0); a.play(); av.actions[slot] = a; }
      // one unavailable clip is not a verdict on the rest: skip the miss, never return
      catch (e) { console.warn(`capsule clip ${slot} unavailable`, e); }
    }
    if (av._disposed) return;
    av.setClip(av.currentSlot ?? 'idle');
    av.hydrateClips().catch(() => {});
  })();
  return av;
}
export async function makeAvatar(id, libPath, { full = false, urgent = false } = {}) {
  loadTrack(`avatar:${id}`, `${id} materializing`);
  const work = beginWork(`avatar ${id}`);
  // YOUR body outranks everything; any body outranks objects, or it queues behind their compiles
  const priority = urgent ? 2 : 1;
  try {
    const slots = full ? CLIP_SLOTS : CORE_CLIPS;
    work.phase('body');
    // VRM + the clip bytes we actually need download in PARALLEL.
    const [vrm] = await Promise.all([loadVRM(libPath, { priority }), ...slots.map(vrmaBytes)]);
    work.phase('clips');
    const clips = {};
    for (const slot of slots) { // sequential: each may be a VRMA parse (once ever, cached)
      try { clips[slot] = await clipFor(vrm, slot, { priority }); } catch (e) { report(`clip ${slot}`, e); }
    }
    work.phase('compile');
    if (vrmWarmed(vrm)) {
      // §19b: a pooled body's pipelines are cached from its first wear; a re-warm would occupy the conductor for nothing
      loadNote(`avatar ${id}: compile skipped — pooled body, pipelines already warm`);
    } else {
      // Through the warm conductor (§16.2.A), mesh by mesh with a real frame between: one gulp of the
      // MToon set stalls frames. frustumCulled defeats culling of the detached body. Your body is P_GATE,
      // ahead of every world model's compile.
      await warm(`avatar ${id}`, async () => {
        const meshes = [];
        vrm.scene.traverse((o) => { if (o.isMesh) meshes.push(o); });
        for (const mesh of meshes) {
          const culled = mesh.frustumCulled;
          mesh.frustumCulled = false;
          try { await renderer.compileAsync(mesh, camera, scene).catch(() => {}); }
          finally { mesh.frustumCulled = culled; }
          await nextFrame();
        }
      }, { p: urgent ? P_GATE : undefined });
      markVrmWarmed(vrm);
    }
    const av = new Avatar(id, vrm, clips);
    // remotes hydrate too: someone breaking into a run must not walk on your screen
    if (!full) av.hydrateClips();
    return av;
  } finally { loadDone(`avatar:${id}`); work.end(); }
}

// ---------------------------------------------------------------- thumbnails
// Contributed roster art: the wearer renders one portrait off the in-memory VRM, once per body.

// The loupe rank rides the same door (POST /thumb, metadata only): stats of the body as LOADED
// (perfscope.statsOf), once per body version per browser; the server recomputes it (routes.ts avatarRoster).
// the door key rides a header, never the URL (routes.ts /thumb refuses ?token=)
const thumbAuth = (token) => (token ? { authorization: `Bearer ${token}` } : {});

async function stampAvatarPerf(name, vrm, token, path) {
  const v = /[?&]v=(\d+)/.exec(path ?? '')?.[1];
  if (!v || !vrm?.scene) return;
  const key = `ew-perf1-${name}-${v}`;
  if (localStorage.getItem(key)) return;
  const { statsOf } = await import('./perfscope.js');
  const s = statsOf(vrm.scene, name);
  const q = new URLSearchParams({ name, v, perf: JSON.stringify({ tris: s.tris, draws: s.draws, mats: s.mats, alpha: s.alpha, bones: s.bones, texMB: s.texMB }) });
  const r = await fetch(`/thumb?${q}`, { method: 'POST', headers: thumbAuth(token) });
  // only a server that SAYS it stored the stamp burns the once-per-version flag: an older server answers 200
  // {existed} for a body with a portrait and drops `perf` on the floor — the next wear must try again
  const j = r.ok ? await r.json().catch(() => null) : null;
  if (j?.perf === true) { localStorage.setItem(key, '1'); bus.emit('avatar-perf', { name }); }   // the avatar cards repaint
}

export async function contributeThumbnail(name, vrm, token = '', { force = false, path = null } = {}) {
  try {
    if (!name) return;
    try { await stampAvatarPerf(name, vrm, token, path); } catch (e) { console.warn('avatar perf stamp skipped', e); }
    if (!force && localStorage.getItem(`ew-thumb2-${name}`)) return;   // we already tried
    if (!force) {
      const head = await fetch(`/thumb/${encodeURIComponent(name)}.png`, { method: 'HEAD' });
      if (head.ok) { localStorage.setItem(`ew-thumb2-${name}`, '1'); return; }
    }

    const size = 256;
    const rt = new THREE.RenderTarget(size, size);
    const cam = new THREE.PerspectiveCamera(28, 1, 0.05, 12);
    const sub = new THREE.Scene();
    // a render target gets no tone mapping, so world-tuned lights burn portraits white: linear-safe levels
    sub.add(new THREE.HemisphereLight(0xffffff, 0x445566, 0.9));
    const key = new THREE.DirectionalLight(0xffffff, 1.1);
    key.position.set(1.4, 2.2, 2.4);
    sub.add(key);

    // Pose it before the precompile: posed in the compile's frame, skinning draws the compile-time pose.
    // One idle frame, since a VRM at rest is a T-pose.
    let poseMixer = null;
    try {
      const clip = await clipFor(vrm, 'idle');
      poseMixer = new THREE.AnimationMixer(vrm.scene);
      const act = poseMixer.clipAction(clip);
      act.play();
      poseMixer.update(0.6);        // a little way in, past the settling frames
      vrm.update(0.6);
      // say what the pose did: T-posed portraits have come out of a block that 'succeeded'
      const arm = vrm.humanoid.getRawBoneNode('leftUpperArm');
      const deg = arm ? Math.round(arm.quaternion.angleTo(new THREE.Quaternion()) * 180 / Math.PI) : -1;
      tee(`[thumb] ${name}: posed (${clip.tracks.length} tracks, raw arm ${deg}°, autoUpdate ${vrm.humanoid.autoUpdateHumanBones})`);
    } catch (e) { tee(`[thumb] ${name}: pose failed — ${e?.message ?? e}`); /* T-pose is survivable; a missing portrait is worse */ }

    // Precompile the portrait's pipelines first (a new pipeline context), or render() compiles every
    // MToon variant synchronously. compileAsync captures its context before yielding, so restore at once.
    {
      const work = beginWork(`thumb ${name}`);
      try {
        work.phase('queued');
        await enqueue(() => {
          work.phase('compile');
          const prev = renderer.getRenderTarget();
          renderer.setRenderTarget(rt);
          const compiled = renderer.compileAsync(vrm.scene, cam, sub);
          renderer.setRenderTarget(prev);
          return compiled.catch(() => {});
        }, { lane: 'gpu', priority: 0 }); // a portrait never outranks a person
      } finally { work.end(); }
    }

    // Deep-cloning a VRM is unsafe (MToon and proxy references), so the real body is BORROWED for one frame.
    const home = vrm.scene.parent;
    const homeIndex = home ? home.children.indexOf(vrm.scene) : -1;
    const keptPos = vrm.scene.position.clone();
    const keptRot = vrm.scene.rotation.clone();

    // Frame the whole figure, identically for every body: head-relative crops vary with the silhouette.
    const bbox = new THREE.Box3().setFromObject(vrm.scene);
    const dims = new THREE.Vector3();     // NOT `size` — that is the pixel size
    bbox.getSize(dims);
    // Stature from the SKELETON (hair and capes inflate bounds); reported with the portrait for common scale.
    let height = dims.y;
    try {
      const rootY = vrm.scene.getWorldPosition(new THREE.Vector3()).y;
      const headY = vrm.humanoid.getNormalizedBoneNode('head').getWorldPosition(new THREE.Vector3()).y;
      const stature = headY - rootY + 0.13; // crown ≈ head joint + a forehead
      // ...unless the mesh really goes higher (a tall crown over a low head joint): up to 160 % of stature, never a particle shell
      if (stature > 0.2) height = Math.min(Math.max(stature, dims.y), stature * 1.6);
    } catch { /* bbox fallback */ }
    const fov = 30;
    // fit the taller of (height, width) into a square frame, with headroom
    const extent = Math.max(height, dims.x, 0.4) * 0.55;
    const dist = (extent / Math.tan((fov * Math.PI / 180) / 2)) * 1.0;
    cam.fov = fov;
    cam.updateProjectionMatrix();
    cam.position.set(dist * 0.16, height * 0.56, dist);
    cam.lookAt(0, height * 0.5, 0);

    const prevTarget = renderer.getRenderTarget();
    try {
      sub.add(vrm.scene);
      vrm.scene.position.set(0, 0, 0);
      // Keep the loader's VRM0 normalization (rotateVRM0 sets rotation.y=π on
      // the scene root) — zeroing it photographed every VRM0 body from behind.
      vrm.scene.rotation.set(0, vrm.meta?.metaVersion === '0' ? Math.PI : 0, 0);
      renderAside(sub, cam, rt);   // never through renderer.render while presenting: a parentless camera rewrites the stereo eyes (render.js)
    } finally {
      renderer.setRenderTarget(prevTarget);
      poseMixer?.stopAllAction();
      vrm.scene.position.copy(keptPos);
      vrm.scene.rotation.copy(keptRot);
      if (home) {
        home.add(vrm.scene);
        // restore draw order so the body isn't shuffled behind its own label
        if (homeIndex >= 0 && homeIndex < home.children.length - 1) {
          home.children.splice(home.children.indexOf(vrm.scene), 1);
          home.children.splice(homeIndex, 0, vrm.scene);
        }
      }
    }

    // readRenderTargetPixelsAsync RETURNS the pixels; its 6th parameter is a
    // texture index, not an output buffer.
    const buf = await renderer.readRenderTargetPixelsAsync(rt, 0, 0, size, size);
    // A blank readback must never overwrite a portrait: below 2 % opaque, skip the POST and say so on the tee.
    { let opaque = 0; for (let i = 3; i < size * size * 4; i += 16) if (buf[i] > 10) opaque++;
      const frac = opaque / (size * size / 4);
      if (frac < 0.02) { tee(`[thumb] blank readback (${backendName()}) for ${name} — not posted`); rt.dispose(); return; } }
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const ctx = c.getContext('2d');
    const img = ctx.createImageData(size, size);
    // Row order depends on the backend: WebGPU top-down, WebGL bottom-up. Flip iff WebGL.
    if (backendName() === 'webgl') {
      const row = size * 4;
      for (let y = 0; y < size; y++) img.data.set(buf.subarray((size - 1 - y) * row, (size - y) * row), y * row);
    } else {
      img.data.set(buf.subarray(0, size * size * 4));
    }
    // the target holds LINEAR light and a PNG shows as sRGB: encode, or portraits read dark. Alpha untouched.
    { const d = img.data; const lut = new Uint8Array(256);
      for (let i = 0; i < 256; i++) { const l = i / 255; lut[i] = Math.round(255 * (l <= 0.0031308 ? 12.92 * l : 1.055 * Math.pow(l, 1 / 2.4) - 0.055)); }
      for (let i = 0; i < d.length; i += 4) { d[i] = lut[d[i]]; d[i + 1] = lut[d[i + 1]]; d[i + 2] = lut[d[i + 2]]; } }
    ctx.putImageData(img, 0, 0);
    rt.dispose();

    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    if (!blob) return;
    const q = new URLSearchParams({ name, height: height.toFixed(2) });
    if (force) q.set('force', '1'); // a re-mint pass really does replace
    await fetch(`/thumb?${q}`, { method: 'POST', body: blob, headers: thumbAuth(token) });
    localStorage.setItem(`ew-thumb2-${name}`, '1');
  } catch (e) {
    console.warn('thumbnail contribution skipped', e);
  }
}

export { angleDelta };
