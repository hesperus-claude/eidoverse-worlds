// governor — one quality controller, session-scoped, two-way (TEL0S_NOTES §12.6): every lever moves both ways,
// nothing persists (machine pressure is not a preference), and the cloud tier is never touched (it's the resident's ⚙).
//
// The ladder, in shed order (recovery unwinds back-to-front, so pixels return first and content last):
//   casters   distant objects stop casting shadows (castShadow is in no pipeline key, §12.1)
//   slots     the light-slot cap drops (idle slots are uniform zeros)
//   emitters  per-emitter instance counts thin (auto → med → low)
//   grass     the meadow thins (instanced count, no rebuild)
//   lod       far placed objects fetch their reduced tier sooner (#156; swaps ride the residency sweep)
//   pixels    render scale, −0.25 steps to 0.7
//   detail    LOD bias 2 (far bodies at half rate) + shadow map 1024
//
// Pacing: a shed needs 3 consecutive slow seconds (<26 fps), one lever per window; a restore needs 5 smooth (>52).
// The dead band counts toward neither, except the cruise lever below (§22j).
// Loading grace (§16.2.D): while loading work is in flight both directions freeze and streaks reset (each move is a
// realloc, §16.1g). whenCalm() = 5 smooth seconds with no loading work, read off the restore ladder's own 1 Hz fps.

import { renderer, sun, BASE_PIXEL_RATIO } from './core.js';
import { CONFIG, bus } from './base.js';
import { busy as budgetBusy, setShare, budgetStats } from './framebudget.js';
import { promoteTailPending, modelQuality } from './realize/models.js';
import { setSlotCap, getSlotCap, maxSlots, litCount,
  setCasterBudget, getCasterBudget, getCasterCeiling, casterCount, shadowsOn, shadowRes } from './lightrig.js';
import { setEmitterQuality, emitterQuality, emitterCount } from './emitters.js';
import { setGrassDensity, getGrassDensity, hasGrass } from './terrain.js';
import { setLodBias } from './remotes.js';
import { setSystemEvery, getSystemEvery } from './frameloop.js';
import { toast } from './ui.js';
import { statusChip, clearStatusChip } from './statuschips.js';

// the governor's model-detail shed, as a status chip (statuschips.js) for exactly as long as it holds
export const REDUCED_CHIP = {
  id: 'quality-reduced', level: 'attn', label: 'reduced detail', title: 'Distant objects reduced',
  body: 'The frame rate dipped, so objects at middle distance load a lighter version to keep it. ' +
        'Full detail comes back on its own once the frame rate recovers — this chip goes with it.',
  actions: [{ label: 'got it' }, { label: 'hide for this visit', clear: true, run: () => { reducedChipHidden = true; } }],
};

let reducedChipHidden = false;   // the viewer put the chip away (for this visit)
// builder mode: the governor's frame-rate toasts landed on the selection bar; the work still happens
const building = () => typeof document !== 'undefined' && document.body?.classList.contains('edit-mode');

// ---- the resident's render-scale dial (§22k): a persisted preference. 'auto' lets the cruise drive; a pinned factor
// sets the base and turns the cruise off. The emergency <26 fps pixels lever still sheds below a pinned base, and
// restores back to it: a crisis outranks a preference only while it lasts.
const RS_KEY = 'ew-render-scale';
export const RENDER_SCALES = ['auto', '1', '0.85', '0.7'];
let renderScale = RENDER_SCALES.includes(localStorage.getItem(RS_KEY))
  ? localStorage.getItem(RS_KEY) : 'auto';
const residentBase = () =>
  renderScale === 'auto' ? BASE_PIXEL_RATIO : BASE_PIXEL_RATIO * Number(renderScale);

let pixelRatio = BASE_PIXEL_RATIO;
// A pixel-ratio change resizes the canvas, which clears its drawing buffer; the 1 Hz pulse runs after 'render', so
// applying here would blank the frame just drawn. It waits for the next frame's start (applyPendingPixelRatio).
let pendingPR = null;
const setPR = (v) => { pixelRatio = v; pendingPR = v; };
// VR exit resizes the canvas outside the governor (xr.js); its stored ratio is still the truth (a pinned render scale,
// a cruise step), so it's re-asserted at the next frame start
bus.on('xr:exit-resized', () => { pendingPR = pixelRatio; });
/** Apply a pixel-ratio change the governor made, BEFORE this frame renders. */
export function applyPendingPixelRatio() {
  if (pendingPR == null) return;
  if (renderer.xr?.isPresenting) return;   // never mid-session (#32: the ratio scales each eye's viewport); lands after exit
  const v = pendingPR; pendingPR = null;
  renderer.setPixelRatio(v);
}

export const getRenderScale = () => renderScale;
export function setRenderScale(v) {
  if (!RENDER_SCALES.includes(v)) return renderScale;
  renderScale = v;
  localStorage.setItem(RS_KEY, v);
  // an explicit move re-anchors outright — session sheds don't survive the
  // resident taking the wheel
  setPR(residentBase());
  return renderScale;
}
if (renderScale !== 'auto') setPR(residentBase());

// ---- the resident's particle and avatar-detail dials (§22k siblings): same contract as render scale; back to 'auto'
// re-anchors outright. Applied at module init so a pin survives a reload (emitters inherit the tier; remotes read
// lodBias live).
const EP_KEY = 'ew-particles';
export const PARTICLE_TIERS = ['auto', 'med', 'low'];
let particleTier = PARTICLE_TIERS.includes(localStorage.getItem(EP_KEY)) ? localStorage.getItem(EP_KEY) : 'auto';
export const getParticleTier = () => particleTier;
export function setParticleTier(v) {
  if (!PARTICLE_TIERS.includes(v)) return particleTier;
  particleTier = v;
  localStorage.setItem(EP_KEY, v);
  setEmitterQuality(v);
  return particleTier;
}
if (particleTier !== 'auto') setEmitterQuality(particleTier);

const AD_KEY = 'ew-avatar-detail';
// how often far bodies update: the lodBias multiplier remotes.js applies to its
// distance bands (1 = every frame near, 2 = half rate, 4 = quarter)
export const AVATAR_DETAILS = { auto: null, full: 1, half: 2, low: 4 };
let avatarDetail = Object.hasOwn(AVATAR_DETAILS, localStorage.getItem(AD_KEY)) ? localStorage.getItem(AD_KEY) : 'auto';
export const getAvatarDetail = () => avatarDetail;
export function setAvatarDetail(v) {
  if (!Object.hasOwn(AVATAR_DETAILS, v)) return avatarDetail;
  avatarDetail = v;
  localStorage.setItem(AD_KEY, v);
  setLodBias(v === 'auto' ? (shedDetail ? 2 : 1) : AVATAR_DETAILS[v]);
  return avatarDetail;
}
if (avatarDetail !== 'auto') setLodBias(AVATAR_DETAILS[avatarDetail]);

// ---- the resident's master switch, 'keep full detail': the governor never sheds and the cruise never steps pixels;
// turning it on hands back everything shed. Overrides all eight levers, including the <26 fps emergency rung (an open
// question: should it outrank the crisis rule?). Loading grace and the calm signal still run.
const FD_KEY = 'ew-full-detail';
let fullDetail = (() => { try { return localStorage.getItem(FD_KEY) === '1'; } catch { return false; } })();
export const getFullDetail = () => fullDetail;
export function setFullDetail(on) {
  fullDetail = !!on;
  try { localStorage.setItem(FD_KEY, fullDetail ? '1' : '0'); } catch { /* private mode */ }
  if (fullDetail) {
    for (let i = LEVERS.length - 1; i >= 0; i--) {
      for (let n = 0; n < 16 && LEVERS[i].restore(); n++) { /* unwind this lever fully */ }
    }
    // two dials the levers' restore() guards can leave shed: pixels in a headset (restore declines while presenting;
    // queued here, applyPendingPixelRatio lands it after exit and xr:exit-resized re-asserts this value), and a
    // grass budget shed before the meadow was cleared (restore needs a live field; setGrass re-applies the budget)
    if (pixelRatio < residentBase()) setPR(residentBase());
    if (grassDial < 1) { grassDial = 1; setGrassDensity(1); }
    slowFor = 0; goodFor = 0; midFor = 0;
    if (history.length < 60) history.push(`✋ full detail @${Math.round(performance.now() / 1000)}s`);
  }
  return fullDetail;
}

const EMITTER_TIERS = ['auto', 'med', 'low'];
const GRASS_STEPS = [1, 0.6, 0.35];

// Each lever: shed() / restore() return whether they moved a notch. The
// toast rides the shed (people deserve to know why the world changed);
// restores are silent — detail quietly coming back needs no announcement.
const LEVERS = [
  {
    name: 'casters',
    // step to the largest ladder value strictly below/above the current
    // budget — robust to an off-ladder value if anything else ever calls
    // setCasterBudget (indexOf-based stepping could RAISE it)
    shed() {
      if (casterCount() === 0) return false;   // nothing casting → no relief,
                                               // don't burn the shed window
      const cur = getCasterBudget(); if (cur <= 2) return false;   // halve toward 2 (the ceiling is the person's Video setting)
      setCasterBudget(Math.max(2, Math.floor(cur / 2)));
      return true;
    },
    restore() {
      const cur = getCasterBudget(), top = getCasterCeiling(); if (cur >= top) return false;
      setCasterBudget(Math.min(top, cur * 2));
      return true;
    },
  },
  {
    name: 'lights',
    shed() {
      // a cap cut only relieves GPU if something is actually casting — an
      // empty world must not eat shed windows and toast lies
      if (getSlotCap() === 0 || litCount() === 0) return false;
      setSlotCap(getSlotCap() - 1);
      if (!building()) toast('turned a light down to keep the frame rate — it still glows', 'warn', 6000);
      return true;
    },
    restore() {
      if (getSlotCap() >= maxSlots()) return false;
      setSlotCap(getSlotCap() + 1);
      return true;
    },
  },
  {
    name: 'emitters',
    shed() {
      if (particleTier !== 'auto') return false;   // the resident's word
      if (!emitterCount()) return false;
      const i = EMITTER_TIERS.indexOf(emitterQuality());
      if (i < 0 || i >= EMITTER_TIERS.length - 1) return false;
      if (!setEmitterQuality(EMITTER_TIERS[i + 1])) return false;
      if (!building()) toast('particle effects thinned to keep the frame rate', 'warn', 8000);
      return true;
    },
    restore() {
      if (particleTier !== 'auto') return false;
      const i = EMITTER_TIERS.indexOf(emitterQuality());
      if (i <= 0) return false;
      return Boolean(setEmitterQuality(EMITTER_TIERS[i - 1]));
    },
  },
  {
    // the first system-stride lever (§14.2 6b): the cosmetic per-frame
    // hooks — cloud drift, grass wind, emitter billboards — at half rate.
    // 30Hz wind is a degrade nobody reports; a lost frame is.
    name: 'cosmetics',
    shed() {
      if (getSystemEvery('autos') >= 2) return false;
      setSystemEvery('autos', 2);
      return true;
    },
    restore() {
      if (getSystemEvery('autos') <= 1) return false;
      setSystemEvery('autos', 1);
      return true;
    },
  },
  {
    name: 'grass',
    // The governor tracks its OWN dial (effective density = min(resident cap, dial)): shed steps from effective, but restore
    // answers for the dial alone, or a capped resident's min() wedges the unwind forever (§12.6's ratchet).
    shed() {
      const eff = getGrassDensity();
      if (!hasGrass() || eff <= GRASS_STEPS[GRASS_STEPS.length - 1]) return false;
      grassDial = eff > 0.65 ? 0.6 : 0.35;
      setGrassDensity(grassDial);
      if (!building()) toast('grass thinned to keep the frame rate', 'warn', 8000);
      return true;
    },
    restore() {
      if (!hasGrass() || grassDial >= 1) return false;
      grassDial = grassDial < 0.5 ? 0.6 : 1;
      setGrassDensity(grassDial);
      return true;
    },
  },
  {
    name: 'lod',
    // The tier policy's session dial (lod_policy.js shed): under load the reduce-at edge halves; restore widens it. Nothing
    // rebuilds: the swap rides the residency sweep's retier path.
    shed() {
      if (modelQuality.shed || modelQuality.quality !== 'auto') return false;
      modelQuality.setShed(true);
      // a STATE, not an event: the chip stays while the reduction holds and goes on restore(); putting it away hides it
      // for this visit only (Settings still says so)
      if (!reducedChipHidden) statusChip(REDUCED_CHIP);
      return true;
    },
    restore() {
      if (!modelQuality.shed) return false;
      modelQuality.setShed(false);
      clearStatusChip(REDUCED_CHIP.id);
      return true;
    },
  },
  {
    name: 'pixels',
    // #32: in a headset the ratio scales each EYE'S VIEWPORT, not the resolution (xrpixelratio.js). Not a lever there:
    // return false so the ladder moves on to one that helps, instead of spending a rung on a deferred no-op.
    shed() {
      if (renderer.xr?.isPresenting) return false;
      if (pixelRatio <= 0.7) return false;
      setPR(Math.max(0.7, pixelRatio - 0.25));
      return true;
    },
    restore() {
      if (renderer.xr?.isPresenting) return false;
      if (pixelRatio >= residentBase()) return false;
      setPR(Math.min(residentBase(), pixelRatio + 0.125));
      return true;
    },
  },
  {
    name: 'detail',
    shed() {
      if (shedDetail) return false;
      shedDetail = true;
      if (avatarDetail === 'auto') setLodBias(2);   // far bodies animate at half rate
      if (shadowsOn() && sun.shadow.mapSize.width > 1024) {
        // mapSize is uniform + texture realloc, not pipeline shape (§12.1)
        // — which is exactly what makes this lever two-way at last
        sun.shadow.mapSize.set(1024, 1024);
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      return true;
    },
    restore() {
      if (!shedDetail) return false;
      shedDetail = false;
      if (avatarDetail === 'auto') setLodBias(1);
      if (shadowsOn() && sun.shadow.mapSize.width < shadowRes()) {
        sun.shadow.mapSize.set(shadowRes(), shadowRes());
        sun.shadow.map?.dispose();
        sun.shadow.map = null;
      }
      return true;
    },
  },
];
let shedDetail = false;
let grassDial = 1;

// ---- the cruise lever (§22j): pixel-bound machines live inside the 26–52 dead band, where the ladder never engages,
// so a SUSTAINED cruise there steps pixels alone down. Gentler than the ladder: an 8 s streak, floor 70% of BASE;
// restore is the shared +0.125 above 52 fps. ?cruise=off disables it (the §17d A/B lever).
const CRUISE = (CONFIG.params.get('cruise') ?? 'on') !== 'off';
const cruiseFloor = () => Math.max(0.7, residentBase() * 0.7);
const cruiseActive = () => CRUISE && renderScale === 'auto' && !fullDetail;   // a pinned scale is the resident's word
let midFor = 0;

let slowFor = 0;
let goodFor = 0;
const history = [];   // recent lever moves, for the debug surface

// ---- loading grace + the calm signal (§16.2.D) ------------------------------

/** The busy predicate: is the engine loading RIGHT NOW? framebudget's busy() carries what its producers report —
 *  the warm conductor (queued or mid-item) and loadwork's cpu/gpu lanes — and the promote tail's pending boulders
 *  are read directly. (syncgate's deferred links are not loading in this sense: they link off-thread and cost no
 *  frames.) */
function loadingBusy() {
  return budgetBusy() || promoteTailPending() > 0;
}

// The share of each frame background work may use (framebudget), from the regime this pulse measured: smooth gets
// the old 6 ms at 60 Hz; a slow machine gives loading less of a frame it is already missing; a headset's frames are
// shorter and a missed one is felt, so it is capped lower.
const XR_SHARE_CAP = 0.25;
function backgroundShare(fps) {
  const s = fps > 52 ? 0.36 : fps >= 26 ? 0.3 : 0.2;
  return renderer.xr?.isPresenting ? Math.min(s, XR_SHARE_CAP) : s;
}

let grace = false;        // the last pulse was held by loading grace
let graceDipped = false;  // this grace spell already told its story in history
let calmFor = 0;          // consecutive smooth AND non-busy seconds (never
                          // consumed by restores — goodFor is, per lever)
let calmReached = false;  // sticky: arrival proved smooth once this session
const calmWaiters = [];

/** Resolves once smoothness (the restore ladder's >52fps read, fed at 1Hz)
 *  has held 5 consecutive seconds with the busy predicate false throughout.
 *  Sticky: this is a storm-edge signal for boot-deferred extras, and once
 *  the arrival has proven itself the answer stays yes. */
export function whenCalm() {
  if (calmReached) return Promise.resolve();
  return new Promise((res) => calmWaiters.push(res));
}

/** Feed once per second with the measured fps. */
export function governPerformance(fps) {
  // the share follows the machine, not the storm: a second that loading itself slowed must not shrink loading's slice
  if (!loadingBusy()) setShare(backgroundShare(fps));
  // …but the headset's cap holds while loading too (entering VR mid-load is the usual cold entry). Only ever lowers it.
  else if (renderer.xr?.isPresenting) setShare(Math.min(budgetStats().share, XR_SHARE_CAP));
  if (loadingBusy()) {
    // freeze BOTH directions and reset every streak: a storm-dip shed and a
    // splash-smooth restore are both answers to loading, not to the machine
    if (!grace) { grace = true; graceDipped = false; }
    if (fps > 0 && fps < 26 && !graceDipped) {
      // one history line per grace spell, only when grace actually swallowed
      // a would-be slow second — the story without the 1Hz flap spam
      graceDipped = true;
      if (history.length < 60) history.push(`⏸ grace held ${Math.round(fps)}fps @${Math.round(performance.now() / 1000)}s`);
    }
    slowFor = 0;
    goodFor = 0;
    calmFor = 0;
    midFor = 0;
    return;
  }
  grace = false;
  if (fps > 0 && fps < 26) {
    goodFor = 0;
    calmFor = 0;
    midFor = 0;
    slowFor++;
    if (slowFor > 2 && !fullDetail) {
      for (const lever of LEVERS) {
        if (lever.shed()) {
          slowFor = 0;   // one lever per slow window — a hitch cannot cascade
          if (history.length < 60) history.push(`− ${lever.name} @${Math.round(performance.now() / 1000)}s`);
          break;
        }
      }
    }
  } else if (fps > 52) {
    slowFor = 0;
    midFor = 0;
    calmFor++;
    if (!calmReached && calmFor > 4) {
      calmReached = true;
      if (history.length < 60) history.push(`✓ calm @${Math.round(performance.now() / 1000)}s`);
      while (calmWaiters.length) calmWaiters.shift()();
    }
    goodFor++;
    if (goodFor > 4) {
      // unwind back-to-front: pixels return before the meadow regrows
      for (let i = LEVERS.length - 1; i >= 0; i--) {
        if (LEVERS[i].restore()) {
          goodFor = 0;
          if (history.length < 60) history.push(`+ ${LEVERS[i].name} @${Math.round(performance.now() / 1000)}s`);
          break;
        }
      }
    }
  } else {
    // the dead band: ladder counters re-earn their streaks, but a SUSTAINED cruise here is the pixel-bound regime
    // (§22j): pixels alone may step down, to the cruise floor
    slowFor = 0;
    goodFor = 0;
    calmFor = 0;
    midFor++;
    if (cruiseActive() && midFor > 7 && pixelRatio > cruiseFloor() && !renderer.xr?.isPresenting) {
      setPR(Math.max(cruiseFloor(), pixelRatio - 0.25));
      midFor = 0;
      if (history.length < 60) history.push(`− pixels (cruise) @${Math.round(performance.now() / 1000)}s`);
    }
  }
}

export const governorDebug = () => ({
  pixelRatio, slowFor, goodFor, midFor, renderScale, fullDetail,
  grace, calmFor, calm: calmReached,
  casterBudget: getCasterBudget(), slotCap: getSlotCap(),
  emitters: emitterQuality(), grass: getGrassDensity(),
  detailShed: shedDetail, history: [...history],
});
