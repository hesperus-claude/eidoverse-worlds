// lightrig — one owner for every runtime light. three r184 keys its pipeline cache by (light id, castShadow) in
// scene order (docs/history/TEL0S_NOTES.md §12.1), so the light TOPOLOGY is born here and never changes: N point
// slots and a small spot pool under one group, never added/removed/toggled; an idle slot is intensity 0. Everything
// that wants a light (placed lights, emissive lamps, the weather's lightning) makes a REQUEST; slot churn is uniform
// writes.
//
// Assignment is deterministic in (requests, camera): keep/adopted → authored → inferred lamps, then whether a light
// can reach the view at all, then what it can deliver there (intensity over the square of its distance, a light outside
// the frustum paying for how far outside, in distance and through its own range), with an incumbent bonus, then key. `keep` is top priority and escapes the
// governor's cap, not the pool: more keeps than slots and the lowest-ranked glow without casting.
//
// The weather factory scene.add()s its own lightning PointLight, and a foreign light in the scene is a recompile
// storm, so makeWeatherSystem is handed a Proxy of the scene whose add/remove ADOPT lights into requests (bottom of
// file; the seam goes when upstream grows a strikeLight injection, docs/history/UPSTREAM-WRAP-ONCE.md).
//
// Shadows: the world says which lights cast (a request's `shadows`, light.shadows), the viewer how many at once
// (ew-lamp-shadows: slots 0..N_CAST-1 are born casting). The best-ranked askers take the casting slots (assign), a casting
// slot draws only for a holder that asked, and its depth tuning follows its holder (tuneSlot). Spots cast too, from their
// own casting spot slots, counted by the same dial (castingChoice: tier first, then a spot before a point). A casting slot's map is
// redrawn only when something it shows has changed, a few slots a frame at most (the shadow cache, shadowCacheCheck).
//
// Measurements and the chest lamp's shadow tuning: docs/research/light-rig.md.

import { THREE, scene, camera, renderer, sun } from '../core.js';
import { CSMShadowNode } from 'three/addons/csm/CSMShadowNode.js';
import { CONFIG, tee, bus } from '../base.js';
import { warmDepth } from './warmqueue.js';

// ---- the fixed inventory ----------------------------------------------------

// ?slots=N (0..16); a non-numeric value falls back to 8 rather than making zero slots
const _slotsParam = Number(CONFIG.params.get('slots') ?? 8);
const N_SLOTS = Number.isFinite(_slotsParam) ? Math.max(0, Math.min(16, Math.round(_slotsParam))) : 8;

const rigGroup = new THREE.Group();
rigGroup.name = 'lightrig';
const slots = [];
// The casting slots are 0..N_CAST-1 (N_CAST below), born casting (flipping castShadow on a live slot is a recompile).
// Requests that want shadows are assigned there (see assign), and a slot draws shadows only for a holder that asked
// (applyShadowPref). SHADOW_SLOT is the first of them.
const SHADOW_SLOT = 0;
// The lamp's shadow map, bias and bulb position, tuned by eye against a moving body: docs/research/light-rig.md.
const SHADOW_MAP = 256;
const SHADOW_WORK_DIST = 12;
const SHADOW_BIAS_TEXELS = 8;
// where the bulb sits in the lamp bone's frame (metres): 2cm back toward the wings, 15cm up, near the collarbone
const SHADOW_FORWARD = -0.02;
const SHADOW_UP = 0.15;
const SHADOW_SIDE = 0;
const shadowTexel = (n = SHADOW_MAP) => (2 * SHADOW_WORK_DIST) / n;
const BODY_DEPTH_BIAS = -0.0005;
// A world lamp in a casting slot is tuned for a room, not a ribcage (render-tiers LAB.md 11-04). With near 0.03 the
// perspective depth is so non-linear that the chest lamp's bias -0.0005 is ~12 cm at 2.7 m, which floated every contact
// shadow off the floor (a chair leg visibly hovering), so its depth bias is -0.00002; its normal offset is 1.5 cube
// texels at 3 m (a face spans 90 degrees, so a texel at distance d is about 2d/n), or at its range if that is shorter,
// where the chest dial's 8 texels at 12 m (0.75 m at 256) pushed room shadows off by most of a metre. near stays 0.03
// for both: a larger one clips a lamp's own shade.
const WORLD_DEPTH_BIAS = -0.00002;
const WORLD_BIAS_TEXELS = 1.5;
const WORLD_BIAS_DIST = 3;
// live-tunable copies (setLampShadow); the consts above are the defaults
let _biasTexels = SHADOW_BIAS_TEXELS;
let _workDist = SHADOW_WORK_DIST;
// The bulb nudge in the bone's own frame, so it rides the chest however the body turns. forward = out of the chest
// (-Z in the bone frame), up = toward the head, side = toward the body's left.
const _nudge = new THREE.Vector3(SHADOW_SIDE, SHADOW_UP, -SHADOW_FORWARD);
// The resident's shadow preference (the video settings row); read here because the slot loop needs it.
const SH_KEY = 'ew-shadows';
const stored = (k) => { try { return localStorage.getItem(k); } catch { return null; } };   // storage can throw (site data blocked)
// How many point slots are born casting: the viewer's cost dial (the video settings row 'shadowed lamps'), read once at
// boot because castShadow is pipeline shape, so a change applies on reload. Which lights WANT to cast is the world's
// (light.shadows; Godot's shadow_enabled, Filament's castShadows). Each casting slot is a cube shadow map: six depth
// passes over what its light reaches.
const LAMP_SHADOWS_KEY = 'ew-lamp-shadows';
export const LAMP_SHADOW_CHOICES = [1, 2, 4, 8];
export const LAMP_SHADOWS_DEFAULT = 1;   // today's one casting slot; a larger default changes how worlds look (the owner's call)
export const lampShadowCount = () => { const v = +stored(LAMP_SHADOWS_KEY); return LAMP_SHADOW_CHOICES.includes(v) ? v : LAMP_SHADOWS_DEFAULT; };
export function setLampShadowCount(n) {
  if (!LAMP_SHADOW_CHOICES.includes(+n)) return;
  try { localStorage.setItem(LAMP_SHADOWS_KEY, String(+n)); } catch { /* private window */ }
}
const N_SHADOWED = lampShadowCount();   // how many lamps may cast at once, of either kind (castingChoice)
const N_CAST = Math.min(N_SLOTS, N_SHADOWED);
let _prefShadows = stored(SH_KEY) !== 'off';   // `let`: setShadows() flips it, and shadowsOn() must follow
for (let i = 0; i < N_SLOTS; i++) {
  const pl = new THREE.PointLight(0xffffff, 0, 10, 1.7);
  pl.name = `slot${i}`;
  pl.castShadow = i < N_CAST;   // pipeline shape, fixed at birth; the preference is uniform-level (applyShadowPref)
  if (i < N_CAST) {
    pl.shadow.mapSize.set(SHADOW_MAP, SHADOW_MAP);
    // depth precision is the near/far RATIO: near 0.03 (the bulb is inside the body), far = the light's own falloff
    // (trackShadowFar keeps it there)
    pl.shadow.camera.near = 0.03;
    pl.shadow.camera.far = Math.max(2, pl.distance || 10);
    pl.shadow.camera.updateProjectionMatrix();
    // born with the chest lamp's tuning (tuneSlot re-tunes it for whoever holds it): bias stays small and negative,
    // normalBias (derived from the texel size) does the heavy lifting
    pl.shadow.bias = BODY_DEPTH_BIAS;
    pl.shadow.normalBias = SHADOW_BIAS_TEXELS * shadowTexel();
    bornDrawn(pl);
  }
  slots.push(pl);
  rigGroup.add(pl);
}
// The spot pool: its own light type, so its own fixed pool (?spots=N, default 2), born after the point slots (scene order
// is pipeline shape). Same ranking as the point pool (rankOf, against the frustum assign() just built). Up to N_SCAST
// spots may cast: one dial (ew-lamp-shadows, "shadowed lamps") counts lamps of both kinds, and a spot is one map against
// a cube's six (Godot shares one atlas between omni and spot). They are born casting-shaped only above the default dial
// (SPOT_SHADOWS_BORN_ABOVE); at the default the first world spot that asks converts one slot, once (convertSpots).
// ?spotshadows=0 (boot): no spot ever casts; ?spotshadows=1: born casting-shaped at any dial.
const _spotRaw = CONFIG.params.get('spots');   // null when absent: Number(null) is 0
const _spotParam = _spotRaw == null || _spotRaw === '' ? NaN : Number(_spotRaw);
const N_SPOT = Number.isFinite(_spotParam) && _spotParam >= 0 ? Math.min(8, Math.round(_spotParam)) : 2;
const _spotShadowsParam = CONFIG.params.get('spotshadows');
const N_SCAST = _spotShadowsParam === '0' ? 0 : Math.min(N_SPOT, N_SHADOWED);   // how many spots may cast at once
// Off by default: a casting-shaped spot slot puts a shadow lookup in every lit material even while no spot casts.
// Not yet measured on a loaded page: the 11-26 iGPU figure (~3 ms of a ~29 ms frame) was taken on pages still loading
// and is void (render lab, 2026-11-27).
// So spots are born casting-shaped only when the viewer's dial asks for more shadowed lamps than this.
export const SPOT_SHADOWS_BORN_ABOVE = LAMP_SHADOWS_DEFAULT;
const N_SCAST_BORN = _spotShadowsParam === '1' || (_spotShadowsParam !== '0' && N_SHADOWED > SPOT_SHADOWS_BORN_ABOVE) ? N_SCAST : 0;
// a spot map is one 2D map: twice a cube face's side (a 90-degree cone then gets twice the face's texel density, for
// two thirds of one cube's pixels)
const SPOT_MAP = 2 * SHADOW_MAP;
const spotSlots = [];
for (let i = 0; i < N_SPOT; i++) {
  const sl = new THREE.SpotLight(0xffffff, 0, 10, Math.PI / 4, 0, 1.7);
  sl.name = `spot${i}`;
  sl.castShadow = false;
  if (i < N_SCAST) sl.shadow.mapSize.set(SPOT_MAP, SPOT_MAP);
  if (i < N_SCAST_BORN) shapeSpotCaster(sl);   // pipeline shape, fixed at birth, as the point slots
  rigGroup.add(sl); rigGroup.add(sl.target);
  spotSlots.push(sl);
}
let _spotShape = N_SCAST_BORN;   // spot slots 0.._spotShape-1 are casting-shaped (castShadow)
function shapeSpotCaster(sl) {
  sl.castShadow = true;
  sl.shadow.camera.near = 0.03;   // as the world lamps: a lamp's own shade sits close (three's default is 0.5)
  sl.shadow.camera.updateProjectionMatrix();
  sl.shadow.bias = WORLD_DEPTH_BIAS;
  bornDrawn(sl);
}
// When each conversion happened (rigDebug().shadows.spotConversions): a probe can see the one recompile and when.
const _spotConversions = [];
/** Make spot slots 0..need-1 casting-shaped, once each, never back. castShadow is in three's lights cache key
 *  (LightsNode.customCacheKey: light id + castShadow), so on the next render every lit render object's dynamic cache
 *  key changes and it is rebuilt: one recompile of the lit materials, synchronous at that render. Not pre-warmed: a
 *  compileAsync of the new shape leaves pipelines pending that the same render would then skip drawing. */
function convertSpots(need) {
  while (_spotShape < Math.min(need, N_SCAST)) {
    const i = _spotShape++;
    shapeSpotCaster(spotSlots[i]);
    _spotConversions.push({ slot: i, at: _rigNow });
    tee(`[lightrig] spot slot ${i} is now casting-shaped (a world spot asked for shadows): lit materials recompile once`);
  }
}
scene.add(rigGroup);
/** A casting-shaped slot's map is drawn at birth (a point slot at boot, a spot slot when it is shaped: born
 *  casting-shaped or converted), whoever holds it and whatever the gate says: it asks three for one draw (three draws
 *  a map whose needsUpdate is set, at any shadow.intensity, and clears the flag only if that draw left the depth
 *  texture's version alone, so a first draw, which recreates the texture, is drawn again the next frame). Why: three
 *  r186 destroys and recreates a shadow map's depth texture at the map's FIRST render (Textures.updateRenderTarget),
 *  and the bind groups built before that, every classic-material model's, keep the destroyed texture. A slot first drawn when its first asker arrived, after
 *  the world's models, broke every later frame: black on WebGPU ("Destroyed texture [ShadowDepthTexture] used in a
 *  submit"), refused draws on WebGL 2. Drawn at birth, before anything samples it, the texture is already the render
 *  target's own. Before the slot drew only for a holder that asked, it drew from the first frame, so this never showed. */
function bornDrawn(l) { l.shadow.needsUpdate = true; }
/** Resize a light's shadow map; a casting-shaped light's map is redrawn in the frame its size changes, whoever holds it
 *  and whatever the gate or the shadows switch says. Why: the same destroyed texture as bornDrawn, by another
 *  door. three r186 refreshes a classic material's bind group only when its observer sees a change, and for a shadow map
 *  it watches light.shadow.mapSize alone (NodeMaterialObserver.getLightsData): the refresh comes in the frame the SIZE
 *  changes, the new texture in the frame the map is next DRAWN (ShadowNode.renderShadow, setSize). A map that is not
 *  drawing (a slot nobody asked, any map while shadows are off) kept the two apart: resized now, drawn when a light asked
 *  later, and every classic-material model kept the destroyed texture (render lab 2026-11-27: 33 errors a second on
 *  WebGPU, refused draws on WebGL 2). Returns whether the size changed. three r187 fixes the first draw (its #35093,
 *  and Textures.updateTexture creates a target's textures with the target); its observer still watches only mapSize.
 *  What this door cannot close: the observer records the size per render object only when that object draws, so a
 *  size that goes there and back while a model is not drawn (hidden, out of view) leaves that model on the destroyed
 *  texture all the same (cold read, 2026-11-28, headless WebGL 2). The governor no longer makes that pattern; a viewer
 *  changing the resolution setting there and back still can. The rig's own resizes go through here (the resolution
 *  setting, the lamp dial); nothing else in the client resizes a shadow map. */
function sizeShadowMap(l, n) {
  if (l.shadow.mapSize.x === n && l.shadow.mapSize.y === n) return false;
  l.shadow.mapSize.set(n, n);
  // a cube map: three r186's RenderTarget.setSize writes the size onto the cube texture's image array but not onto its
  // six faces, which are recreated at their birth size, so the faces are given the new size here too
  if (l.isPointLight && l.shadow.map) for (const t of [l.shadow.map.texture, l.shadow.map.depthTexture]) { const f = Array.isArray(t?.image) ? t.image[0] : null; if (f) { f.width = n; f.height = n; } }
  if (l.castShadow) bornDrawn(l);
  return true;
}

export const shadowsOn = () => _prefShadows;
// The lamp's shadow dials, live (mapSize is a realloc and normalBias a uniform; neither is in a pipeline cache key).
// Any subset of {map, texels, dist, forward, up, side}; the bias is re-derived from the resulting map size so a size
// change keeps the look. forward/up/side move the bulb (metres, bone frame; see _nudge).
// The map size is every casting slot's (the chest lamp tuning holds in whichever slot it lands); the bias dials are the
// chest lamp's, so they reach a slot the chest lamp holds (or no one does) and leave a world lamp's tuning alone.
export function setLampShadow({ map, texels, dist, forward, up, side } = {}) {
  if (!slots[SHADOW_SLOT] || N_CAST === 0) return null;
  if (Number.isFinite(map)) {
    const n = Math.max(16, Math.min(2048, Math.round(map)));
    // no dispose: three resizes a target at its next draw (RenderTarget.setSize disposes on a size change; a cube's faces
    // need sizeShadowMap's help), and a dispose with no size change for its observer to see was the same break
    for (let k = 0; k < N_CAST; k++) sizeShadowMap(slots[k], n);
  }
  if (Number.isFinite(texels)) _biasTexels = Math.max(0, texels);
  if (Number.isFinite(dist)) _workDist = Math.max(0.01, dist);
  // ±0.5m: a bulb inside a ribcage; a metre of nudge has left the body
  const clamp = (v) => Math.max(-0.5, Math.min(0.5, v));
  if (Number.isFinite(forward)) _nudge.z = -clamp(forward);   // forward is -z (see _nudge)
  if (Number.isFinite(up)) _nudge.y = clamp(up);
  if (Number.isFinite(side)) _nudge.x = clamp(side);
  for (let k = 0; k < N_CAST; k++) tuneSlot(k, _tunedFor[k]);
  return lampShadowState();
}
// The request each casting slot is tuned for (the one it draws: tuneSlot from updateRig), null before any holder.
const _tunedFor = new Array(N_CAST).fill(null);
const bodyNormalBias = (n) => _biasTexels * ((2 * _workDist) / n);
/** Tune casting slot k for its holder r: the chest lamp's dial for a body lamp (or no holder: the slot is born with
 *  it), the world tuning for anything else. Uniform writes (bias and normalBias are in no pipeline key). */
function tuneSlot(k, r) {
  const pl = slots[k];
  if (!pl?.castShadow) return;
  _tunedFor[k] = r ?? null;
  const n = pl.shadow.mapSize.x || SHADOW_MAP;
  if (!r || r.body) {
    pl.shadow.bias = BODY_DEPTH_BIAS;
    pl.shadow.normalBias = bodyNormalBias(n);
  } else {
    pl.shadow.bias = WORLD_DEPTH_BIAS;
    pl.shadow.normalBias = WORLD_BIAS_TEXELS * ((2 * Math.min(WORLD_BIAS_DIST, pl.distance || 10)) / n);
  }
}
// the casting slot that carries the chest dial: one tuned for a body lamp, else the first not tuned for a world lamp
function chestSlot() {
  let idle = -1;
  for (let k = 0; k < N_CAST; k++) { const r = _tunedFor[k]; if (r?.body) return k; if (!r && idle < 0) idle = k; }
  return idle;
}
/** The chest lamp's shadow tuning, read off the slot that carries it (computed from the dial while every casting slot
 *  holds a world lamp). */
export const lampShadowState = () => {
  if (!slots[SHADOW_SLOT] || N_CAST === 0) return null;
  const k = chestSlot();
  const pl = slots[k >= 0 ? k : SHADOW_SLOT];
  const n = pl.shadow.mapSize.x || SHADOW_MAP;
  return {
    map: n, texels: _biasTexels, workDist: _workDist,
    texelMM: +((2 * _workDist / n) * 1000).toFixed(2),
    // where the bulb sits relative to its bone (metres, bone frame)
    forward: +(-_nudge.z).toFixed(4), up: +_nudge.y.toFixed(4), side: +_nudge.x.toFixed(4),
    normalBias: +(k >= 0 ? pl.shadow.normalBias : bodyNormalBias(n)).toFixed(5),
    bias: k >= 0 ? pl.shadow.bias : BODY_DEPTH_BIAS,
    near: pl.shadow.camera.near, far: pl.shadow.camera.far,
  };
};

// ---- the shadow cache: a casting slot's cube map is redrawn only when something it shows has changed ----------------
// Godot's rule for positional shadows (servers/rendering/renderer_scene_cull.cpp at 8f2e46bca3: a caster pairing with a
// light marks it dirty :230-232, a caster's update dirties every light it is paired with :1738-1746, a light whose
// shadow drew an animated material stays dirty :2619-2620 + :3663-3664, a dirty light whose volume misses the view waits
// :3635-3657). three has the switch (shadow.autoUpdate false; needsUpdate draws once, and ShadowNode clears it after the
// draw). Where we depart: Godot is TOLD when an instance changes; here many writers move things (protocol edits,
// motion, physics, grab/carry, skinning, the caster budget's fades), so the rule COMPARES what each slot would draw
// against what it drew (shadowCacheCheck), which cannot miss an event nobody emitted. It runs at scene.onBeforeRender,
// the seam draw_batches.js also uses: world matrices are current there, and no shadow pass has drawn yet this frame.
// A per-frame budget bounds how many dirty slots redraw at once (PlayCanvas's light.shadowUpdateMode is the precedent):
// the rest wait, oldest-stale first, so a moving caster's shadow is at most ceil(dirty slots / budget) frames old.
// ?shadowcache=0 restores the every-frame redraw (the lab's A/B); ?shadowbudget=K sets the budget at boot.
const SHADOW_CACHE = CONFIG.params.get('shadowcache') !== '0';
export const shadowCacheOn = () => SHADOW_CACHE;
// 2: today's default dial (one casting slot) is never delayed, and a body lamp plus one dirty room lamp are not either
export const SHADOW_UPDATE_BUDGET = 2;
const _budgetParam = Number(CONFIG.params.get('shadowbudget') ?? NaN);
let _shadowBudget = Number.isFinite(_budgetParam) && _budgetParam >= 1 ? Math.round(_budgetParam) : SHADOW_UPDATE_BUDGET;
/** How many casting slots may redraw in one frame (>= 1). A lever for the governor; nothing drives it yet. */
export function setShadowUpdateBudget(k) { if (Number.isFinite(+k)) _shadowBudget = Math.max(1, Math.round(+k)); }
export const shadowUpdateBudget = () => _shadowBudget;
// per casting slot: `drawn` is what it drew last (null: never), `cur` this frame's reading, `marks` where each part of
// the reading starts (for the reason), `force` a reason to redraw that no reading shows (first, release)
// the cached lights: the casting point slots, then the casting spot slots (index N_CAST + s)
const _cl = [...slots.slice(0, N_CAST), ...spotSlots.slice(0, N_SCAST)];
const _sc = Array.from({ length: _cl.length }, () => ({
  drawn: null, drawnMarks: [], cur: [], marks: [], force: 'first', staleSince: -1, reason: null, deforming: false,
  pending: false, handoffs: 0, draws: 0, deferred: 0, outOfView: 0, times: [], deferTimes: [],
}));
const _cachedLights = new Set(SHADOW_CACHE ? _cl : []);
let _cacheHold = 0, _cacheArmed = false, _cacheFrame = 0, _rigNow = 0;
/** Debug tools that hold the shadow maps across frames (gputime's A/B, overdraw) hold the cache too: no slot is handed a
 *  redraw while held, and every slot redraws once on release (anything may have changed meanwhile). */
export function holdShadowCache(on) {
  if (on) { _cacheHold++; return; }
  if (_cacheHold === 0) return;
  if (--_cacheHold === 0) for (const c of _sc) c.force ??= 'release';
}

// The shadow switch is uniform-level: shadowMap.enabled and castShadow are in every lit material's pipeline key, so
// they are fixed on at boot and 'off' is shadow.intensity 0 with the depth pass stopped. The sun's depth pass is
// autoUpdate; a cached casting slot's autoUpdate is always false, so for it "casting" is the uniform half alone.
/** Does this light actually draw shadows right now? Shape (castShadow + the map) AND the preference's uniform half. */
const castsNow = (l) => Boolean(l?.castShadow && renderer.shadowMap.enabled && l.shadow && l.shadow.intensity > 0 && (_cachedLights.has(l) || l.shadow.autoUpdate !== false));
function gateShadow(l, on) {
  if (!l?.shadow) return;
  l.shadow.intensity = on ? 1 : 0;
  const cached = _cachedLights.has(l);
  l.shadow.autoUpdate = cached ? false : on;
  if (on) l.shadow.needsUpdate = true;   // the held map is stale: redraw it once now (the cache counts it: shadowCacheCheck)
}
// Does casting slot k's holder want shadows (r.shadows)? Anything else that lands there (a placed lamp inside its own
// shade that never asked, the lightning) has not asked to cast; empty, it has nothing to cast for. assign() keeps this
// current; the slot casts when this AND the preference say so.
const _holderWants = new Array(N_CAST).fill(false);
const _spotWants = new Array(N_SCAST).fill(false);   // the same, per casting spot slot
function applyShadowPref(on) {
  gateShadow(sun, on);
  for (let k = 0; k < N_CAST; k++) gateShadow(slots[k], on && _holderWants[k]);
  for (let s = 0; s < N_SCAST; s++) gateShadow(spotSlots[s], on && _spotWants[s]);
}
/** Put the shadow preference's uniform half back (after a probe held shadow maps across frames). */
export const reassertShadowPref = () => applyShadowPref(_prefShadows);
export function setShadows(on) {
  localStorage.setItem(SH_KEY, on ? 'on' : 'off');
  _prefShadows = on;
  applyShadowPref(on);
}
// pipeline shape, set once before the first compile (see applyShadowPref)
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = ({ basic: THREE.BasicShadowMap, pcf: THREE.PCFShadowMap, soft: THREE.PCFSoftShadowMap })[CONFIG.params.get('shadowtype')] ?? THREE.PCFSoftShadowMap;   // ?shadowtype=basic|pcf|soft, a diagnostic
sun.castShadow = true;
bornDrawn(sun);   // as the casting slots: drawn at birth whatever the switch says (the pre-warm initialising it is incidental)
applyShadowPref(shadowsOn());
// shadow map resolution (persisted; the video settings row). A live change is a realloc, no recompile.
const RES_KEY = 'ew-shadow-res';
export const SHADOW_RES = [1024, 2048, 4096];
export const shadowRes = () => { const v = +stored(RES_KEY); return SHADOW_RES.includes(v) ? v : 2048; };
// one dial for every caster: the sun takes n, the casting lamp slots scale SHADOW_MAP by n/2048 (setLampShadow sizes them all)
const lampMapFor = (n) => Math.round(SHADOW_MAP * (n / 2048));
const sizeSpotMaps = (n) => { const m = 2 * lampMapFor(n); for (let i = 0; i < N_SCAST; i++) spotSlots[i].shadow.mapSize.set(m, m); };
export function setShadowRes(n) {
  localStorage.setItem(RES_KEY, String(n));
  sizeShadowMap(sun, n);
  sizeSpotMaps(n);
  if (slots[SHADOW_SLOT] && slots[SHADOW_SLOT].shadow.mapSize.x !== lampMapFor(n)) setLampShadow({ map: lampMapFor(n) });
}
sun.shadow.mapSize.set(shadowRes(), shadowRes());
if (lampMapFor(shadowRes()) !== SHADOW_MAP) setLampShadow({ map: lampMapFor(shadowRes()) });
sizeSpotMaps(shadowRes());
// ?csm=2|3|4 — cascaded shadow maps (bench probe): three's CSMShadowNode fits one ortho camera per cascade around the
// view frustum each frame, replacing the follow box in updateShadow. N cascades = N depth passes.
const CSM_N = Math.min(4, Math.max(0, +CONFIG.params.get('csm') || 0));
let csm = null;
const CSM_FAR = +CONFIG.params.get('csmfar') || 150;   // how far from the eye the cascades reach
const CSM_MARGIN = 100;                                 // how far up-sun of them a caster is still drawn
if (CSM_N >= 2) {
  csm = new CSMShadowNode(sun, { cascades: CSM_N, maxFar: CSM_FAR, mode: CONFIG.params.get('csmmode') || 'practical', lightMargin: CSM_MARGIN });
  sun.shadow.shadowNode = csm;
  addEventListener('resize', () => { if (csm.camera) csm.updateFrustums(); });   // no camera until the first compiled frame (CSMShadowNode._init): a resize before that would throw
}
if (CONFIG.params.has('shadowfloat')) sun.shadow.mapType = THREE.FloatType;   // ?shadowfloat=1 (boot): 32-bit float depth map, a D3D11/ANGLE comparison-sampling variant
sun.shadow.bias = -0.0006;
sun.shadow.normalBias = 0.02;
// Boot line for the shadow state (?shadowdebug): the persisted switch, the map, and where the sun is.
if (CONFIG.params.has('shadowdebug')) setTimeout(() => { try { const d = sun.position.clone().normalize(); tee(`[shadows] csm=${csm ? csm.cascades : 0} pref=${shadowsOn() ? 'on' : 'off'} map=${renderer.shadowMap.enabled} type=${renderer.shadowMap.type} size=${sun.shadow.mapSize.x} sun=(${d.x.toFixed(2)},${d.y.toFixed(2)},${d.z.toFixed(2)}) intensity=${sun.intensity.toFixed(2)} casters=${casters.size} casting=${[...casters.values()].filter((c) => c.casting).length}`);
  // real-hardware facts: the map's depth texture, GL error state, the extensions that shape the shadow path
  const m = sun.shadow.map; const dt = m?.depthTexture; const gl = renderer.backend?.gl; const ext = (n) => gl ? (gl.getExtension(n) ? 1 : 0) : '?';
  tee(`[shadows] map=${m ? `${m.width}x${m.height}` : 'none'} depthTex=${dt ? `type:${dt.type} fmt:${dt.format} cmp:${dt.compareFunction} ver:${dt.version}` : 'none'} glError=${gl ? gl.getError() : '?'} parallelCompile=${ext('KHR_parallel_shader_compile')} clipControl=${ext('EXT_clip_control')} depthClamp=${ext('EXT_depth_clamp')} renderer=${(() => { try { const d = gl.getExtension('WEBGL_debug_renderer_info'); return d ? gl.getParameter(d.UNMASKED_RENDERER_WEBGL).slice(0, 60) : gl.getParameter(gl.RENDERER).slice(0, 60); } catch { return '?'; } })()}`);
  } catch (e) { tee(`[shadows] probe threw: ${e?.message ?? e}`); } }, 20000);

// ---- requests ---------------------------------------------------------------

/** key -> request. A request is a light that WANTS to cast:
 *    obj        Object3D whose world position the slot follows (or null)
 *    offset     local-frame offset within obj (lamp = emissive mesh centre)
 *    pos        fallback world position when there is no obj
 *    mirror     a foreign THREE light whose live color/intensity/distance/
 *               decay/position the slot copies verbatim (the lightning)
 *    color/intensity/range/decay  the authored params (ignored when mirror)
 *    keep       top priority — never outbid by distance
 *    authored   placed by a verb (beats inferred lamps)
 *    dayAware   dimmed by the sky's dayness like a lamp
 *    owner      release scope (entity:<id>) */
const requests = new Map();
let assignDirty = true;

export function requestLight(key, spec) {
  requests.set(key, {
    obj: null, offset: null, pos: null, mirror: null,
    color: 0xffd9a0, intensity: 16, range: 10, decay: 1.7,
    keep: false, authored: false, dayAware: false, owner: null,
    shadows: false,   // wants a casting slot (see N_CAST, assign)
    body: false,      // a body's lamp (attachLamps for avatar.js): the chest-lamp tuning in a casting slot (tuneSlot)
    spot: null,       // {angle, inner} (glTF half-angles, rad): a spot, lit from the SPOT pool, shining along obj's -Z
    ...spec, key, slot: -1, sslot: -1,
  });
  const r = requests.get(key);
  r.rankIntensity = r.intensity;   // see rankOf
  assignDirty = true;
}
/** Patch a live request. Only keys that can change the ordering dirty assignment: a breathing lamp patches
 *  intensity 60 times a second. */
const ORDERING_KEYS = ['keep', 'authored', 'obj', 'offset', 'pos', 'mirror', 'owner', 'spot', 'shadows'];
export function updateRequest(key, patch) {
  const r = requests.get(key);
  if (!r) return;
  Object.assign(r, patch);
  if ('obj' in patch || 'offset' in patch) delete r._joint;   // skinnedPosOf re-derives the dominant joint
  // a re-placed request (models.js re-syncs the whole spec) ranks by its new intensity; a breath alone does not re-rank
  if (ORDERING_KEYS.some((k) => k in patch)) { r.rankIntensity = r.intensity; assignDirty = true; }
}
export function releaseLight(key) {
  if (requests.delete(key)) assignDirty = true;
}
export function releaseOwner(owner) {
  for (const [k, r] of requests) if (r.owner === owner) requests.delete(k);
  assignDirty = true;
}
export const isCasting = (key) => (requests.get(key)?.slot ?? -1) >= 0;

// ---- lamps ------------------------------------------------------------------
// A body that glows sheds light: each emissive mesh (≤2) gets a lamp request at its centre. A placed model infers
// none (its lights are light components). A request costs nothing until it wins a slot.

/** How strongly a material glows as an emitter, or 0 when it doesn't. An emitter, not MToon's unlit trick (emissive ≈
 *  white + a map at strength 1): a flat emissive colour with no map above 0.5, or a map driven above strength 1. The
 *  lamps and the caster budget (a thing that is all emitter casts no shadow) share this one test. */
function emitterGlow(m) {
  const glow = (m?.emissiveIntensity ?? 1) * Math.max(m?.emissive?.r ?? 0, m?.emissive?.g ?? 0, m?.emissive?.b ?? 0);
  if ((!m?.emissiveMap && glow > 0.5) || (m?.emissiveMap && (m?.emissiveIntensity ?? 1) > 1)) return Math.max(glow, m?.emissiveIntensity ?? 1);
  return 0;
}

/** Request a light at each emissive mesh's centre (<=2 per object). `opts.shadows` asks for a casting slot and
 *  defaults to FALSE: only avatar.js passes true, and its lamps are body lamps (the chest dial's tuning, tuneSlot).
 *  @returns {{key:string, intensity:number}[]} the requests made (a caller animating a lamp needs both). */
export function attachLamps(root, owner, { shadows = false } = {}) {
  const made = [];
  const emissive = [];
  root.traverse((o) => {
    if (!o.isMesh) return;
    const glow = emitterGlow(o.material);
    if (glow > 0) emissive.push({ mesh: o, glow });
  });
  emissive.slice(0, 2).forEach(({ mesh, glow }, i) => {
    mesh.geometry.computeBoundingSphere();
    // saturated emissive keeps its colour; whitish reads as a warm bulb
    const ec = mesh.material.emissive;
    const sat = Math.max(ec.r, ec.g, ec.b) - Math.min(ec.r, ec.g, ec.b);
    const intensity = Math.min(40, 6 + 2.6 * glow);
    const key = `lamp:${owner}:${i}`;
    requestLight(key, {
      obj: mesh,
      offset: mesh.geometry.boundingSphere.center.clone(),
      color: sat > 0.25 ? ec.clone() : 0xffd9a0,
      intensity,
      range: 12,                 // tight radius: grass fragments cost
      shadows,                   // the caller's call: a nearer glowing prop must not take the casting slot off a body
      body: shadows,             // only avatar.js asks: a body lamp keeps the chest-lamp tuning in a casting slot
      dayAware: true, owner,
    });
    made.push({ key, intensity });
  });
  return made;
}

// ---- time of day ------------------------------------------------------------
// The sky tells the rig how day it is (sky.js applyTuning); lamps and placed lights answer with one glow curve.

// null = unknown, and unknown lights the lamp (1 would zero every day-aware light until a sky loads)
let dayness = null;
export function setDayness(d) { dayness = d; }
const dayGlow = () => (dayness == null ? 1 : Math.pow(1 - dayness, 2));
/** The same curve for emissive surfaces, so a surface and its light dim together. */
export const glowScale = () => dayGlow();

// ---- assignment -------------------------------------------------------------
// Deterministic in (requests, camera): tier (keep/adopted → authored →
// inferred), then reach (a light whose range cannot touch the view frustum
// lights nothing on screen), then score with an incumbent bonus (hysteresis),
// then key (stable tiebreak). Recomputed when the request set changes, the
// camera moves, a dark mirror lights, or 600ms passes (which is what picks up
// a turn in place) — slot WRITES happen every frame regardless, and a slot
// whose request changed crosses through dark (handOver).

let slotCap = N_SLOTS;
export function setSlotCap(n) {
  slotCap = Math.max(0, Math.min(N_SLOTS, n));
  assignDirty = true;
}
export const getSlotCap = () => slotCap;
export const maxSlots = () => N_SLOTS;

const _wp = new THREE.Vector3();
const _lastCam = new THREE.Vector3(Infinity, Infinity, Infinity);
let lastAssign = 0;

// A SkinnedMesh's bounding-sphere centre (the offset attachLamps stores) is in bind-pose coordinates, so rotating it
// by the node's quaternion swings the light in an arc; a skinned lamp is located through its dominant bone instead.
function worldPosOf(r, out) {
  if (r.mirror) return out.copy(r.mirror.position);
  if (r.obj) {
    if (r.offset && r.obj.isSkinnedMesh) return skinnedPosOf(r, out);
    r.obj.getWorldPosition(out);
    if (r.offset) out.add(_wp.copy(r.offset).applyQuaternion(r.obj.getWorldQuaternion(_q)).multiplyScalar(r.obj.getWorldScale(_s).x || 1));
    return out;
  }
  return out.set(...(r.pos ?? [0, 1, 0]));
}

// The dominant joint for a skinned lamp: the largest weight on the vertex nearest the bind-space centre. One bone,
// not a blend: a lamp is a rigid fixture on one bone.
const _bindM = new THREE.Matrix4();
function lampJointOf(mesh, centre) {
  const geo = mesh.geometry, skel = mesh.skeleton;
  const pos = geo.getAttribute('position'), sk = geo.getAttribute('skinIndex'), sw = geo.getAttribute('skinWeight');
  if (!pos || !sk || !sw || !skel) return -1;
  let best = -1, bestD = Infinity;
  for (let i = 0; i < pos.count; i++) {
    const d = (pos.getX(i) - centre.x) ** 2 + (pos.getY(i) - centre.y) ** 2 + (pos.getZ(i) - centre.z) ** 2;
    if (d < bestD) { bestD = d; best = i; }
  }
  if (best < 0) return -1;
  let j = sk.getX(best), w = sw.getX(best);
  for (const [gi, gw] of [[sk.getY(best), sw.getY(best)], [sk.getZ(best), sw.getZ(best)], [sk.getW(best), sw.getW(best)]]) {
    if (gw > w) { w = gw; j = gi; }
  }
  return w > 0 ? j : -1;
}

function skinnedPosOf(r, out) {
  const mesh = r.obj;
  if (r._joint === undefined) r._joint = lampJointOf(mesh, r.offset);
  const skel = mesh.skeleton, j = r._joint;
  // no usable skin: the node's matrix on the bind position (exact for an unposed body)
  if (j < 0 || !skel?.bones?.[j]) {
    return out.copy(r.offset).applyMatrix4(mesh.matrixWorld);
  }
  // bone * inverse-bind is the skinning transform for one fully-weighted bone
  _bindM.multiplyMatrices(skel.bones[j].matrixWorld, skel.boneInverses[j]);
  out.copy(r.offset).applyMatrix4(_bindM);
  // the nudge rides the bone (lamps only: a mirror has no bind offset)
  if (r.shadows && (_nudge.x || _nudge.y || _nudge.z)) {
    out.add(_wp.copy(_nudge).applyQuaternion(skel.bones[j].getWorldQuaternion(_q)));
  }
  return out;
}
const _q = new THREE.Quaternion();
const _s = new THREE.Vector3();
const _p = new THREE.Vector3();

// the camera's WORLD position: in XR the camera is a child of the rig and camera.position is only the head's offset
const _eye = new THREE.Vector3();
// The view frustum three culls with, from the camera's world matrix (matrixWorldInverse is only refreshed by a render;
// in XR the renderer writes both eyes' combined projection into camera.projectionMatrix).
const _frustum = new THREE.Frustum();
const _vp = new THREE.Matrix4();
function viewFrustum() {
  _vp.copy(camera.matrixWorld).invert().premultiply(camera.projectionMatrix);
  _frustum.setFromProjectionMatrix(_vp, camera.coordinateSystem, camera.reversedDepth);
}
/** Metres p lies outside the view frustum: 0 inside, else its deepest single-plane overshoot (exact past one plane,
 *  an underestimate past a corner). */
function outsideView(p) {
  let out = 0;
  for (const pl of _frustum.planes) out = Math.max(out, -pl.distanceToPoint(p));
  return out;
}
// Metres of distance a metre outside the frame costs: a lamp 1.5 m behind the eye (1.6 m past the near plane) ranks as
// if 6.3 m away, a lamp 0.3 m past an edge pays under 1 m. Fitted, not derived: over 32 path-traced cameras in two
// rooms (render-lab/rank-truth.py, 11-23) anything from 1.5 to 4 loses about the same light on average (0.55 stops
// at 4 slots, 0.12 at 8), 3 has the best worst case, and 6 drops a bright lamp the moment it leaves the frame while
// it still lights a quarter of the picture. (What the frame sees of a lamp lies deeper in the frustum than its
// nearest plane, which is why the charge is more than 1.)
const OFFSCREEN_WEIGHT = 3;
// ...and for the same reason a lamp outside the frame is dimmed, for ranking, by three's own range window taken at
// this many times its distance outside: a short-range lamp behind the viewer has little left where the frame begins
// (the greybox Starloft's 4 m sconces 2 m behind the eye give 0.0% of the path-traced frame), a long-range one keeps
// nearly all of it.
const REACH_DEPTH = 2;
// three's punctual falloff window (getDistanceAttenuation): (1 - (d / range)^4)^2, 1 with no cutoff
const rangeWindow = (d, range) => (range === Infinity ? 1 : Math.max(0, 1 - (d / range) ** 4) ** 2);
// below this, nearness stops adding (a lamp at the face would otherwise outrank everything by any margin)
const RANK_NEAR = 0.5;
// the incumbent bonus as a ratio on the score: 1/0.85², so equal-intensity lights keep the old 15%-of-distance edge
const INCUMBENT = 1 / (0.85 * 0.85);
/** What a request can deliver to the view, for ranking: its intensity over the square of its distance from the eye,
 *  that distance grown by how far outside the frustum it sits, and the intensity cut by what its range leaves of it
 *  there. The intensity is the one last requested with its
 *  placement (rankIntensity), not a per-frame animation of it: avatar.js breathes the chest lamp's intensity
 *  between 3% and 100%, and a rank that read the breath would trade slots with it. A light whose range sphere lies
 *  wholly outside one plane lights nothing on screen (`miss`). */
function rankOf(r, incumbent) {
  const p = worldPosOf(r, _p);
  const out = outsideView(p);
  const range = (r.mirror ? r.mirror.distance : r.range) || Infinity;   // 0 = no cutoff in three
  const lum = r.mirror ? r.mirror.intensity : (r.rankIntensity ?? r.intensity) * (r.dayAware ? dayGlow() : 1);
  const d = p.distanceTo(_eye) + OFFSCREEN_WEIGHT * out;
  return {
    r,
    tier: r.keep ? 0 : r.authored ? 1 : 2,
    miss: out > range ? 1 : 0,
    score: (lum * rangeWindow(REACH_DEPTH * out, range) / Math.max(RANK_NEAR, d) ** 2) * (incumbent ? INCUMBENT : 1),   // incumbents hold their ground
    d,
  };
}
const byRank = (a, b) => a.tier - b.tier || a.miss - b.miss || b.score - a.score || a.d - b.d || (a.r.key < b.r.key ? -1 : 1);
// A mirror (the adopted lightning) takes a slot only while its light is lit, and for MIRROR_HOLD_MS after it goes dark,
// so a strike's return strokes find it still seated rather than trading a lamp's slot back and forth.
const MIRROR_HOLD_MS = 1000;
const mirrorLit = (r, now) => r.mirror.intensity > 0 || now - (r._litAt ?? -Infinity) < MIRROR_HOLD_MS;

function assign(now) {
  lastAssign = now;
  camera.getWorldPosition(_eye);   // also brings camera.matrixWorld up to date for the frustum
  _lastCam.copy(_eye);
  viewFrustum();
  assignDirty = false;
  const spotWin = assignSpots();
  const ranked = [...requests.values()].filter((r) => !r.spot && (!r.mirror || mirrorLit(r, now)))
    .map((r) => rankOf(r, r.slot >= 0)).sort(byRank);
  // a lit mirror holds a reserved slot: neither ranking nor the governor's cap sheds a strike
  const mirrors = ranked.filter((x) => x.r.mirror).slice(0, N_SLOTS).map((x) => x.r);
  const nonMirror = ranked.filter((x) => !x.r.mirror);
  // `keep` is exempt from governor shedding: the cap applies to the tail only. More keeps than slots and the best
  // ranked win; the rest glow without casting.
  const keeps = nonMirror.filter((x) => x.r.keep)
    .slice(0, Math.max(0, N_SLOTS - mirrors.length))
    .map((x) => x.r);
  const rest = nonMirror.filter((x) => !x.r.keep)
    .slice(0, Math.max(0, Math.min(slotCap, N_SLOTS - mirrors.length - keeps.length)))
    .map((x) => x.r);
  const winners = [...mirrors, ...keeps, ...rest];
  const winnerSet = new Set(winners);
  // evicted requests free their slots first; a request that stays assigned keeps its slot
  for (const r of requests.values()) {
    if (r.slot >= 0 && !winnerSet.has(r)) r.slot = -1;
  }
  const used = new Set(winners.map((r) => r.slot).filter((i) => i >= 0));
  // the chosen askers (castingChoice, one dial over both kinds) take the casting slots before the general pass; the rest
  // light without casting (another caster would be a recompile). Winners are in rank order, so these are the best askers.
  const { points: wanting, spots: spotCasting } = castingChoice(winners, spotWin);
  convertSpots(spotCasting.length);
  seatSpots(spotCasting, spotWin);
  const castHeld = new Set(wanting.filter((r) => r.slot >= 0 && r.slot < N_CAST).map((r) => r.slot));
  for (const wants of wanting) {
    if (wants.slot >= 0 && wants.slot < N_CAST) continue;   // already casting where it is
    let k = 0;
    while (castHeld.has(k)) k++;                             // a casting slot no better asker holds
    castHeld.add(k);
    // SWAP with the incumbent (usually the world, realized before your avatar, or an asker ranked below N_CAST) rather
    // than wait for a free slot: the two trade places and both stay lit
    const incumbent = winners.find((r) => r !== wants && r.slot === k);
    const vacated = wants.slot;          // -1 if it was never assigned
    wants.slot = k;
    used.add(k);
    if (incumbent) incumbent.slot = vacated;
    else if (vacated >= 0) used.delete(vacated);
  }
  let free = 0;
  for (const r of winners) {
    if (r.slot >= 0) continue;
    while (used.has(free)) free++;
    if (free >= N_SLOTS) break;
    r.slot = free;
    used.add(free);
  }
  const wantsNow = new Array(N_CAST).fill(false);
  for (const r of wanting) if (r.slot >= 0 && r.slot < N_CAST) wantsNow[r.slot] = true;
  for (let k = 0; k < N_CAST; k++) {
    if (wantsNow[k] === _holderWants[k]) continue;
    _holderWants[k] = wantsNow[k];
    gateShadow(slots[k], _prefShadows && wantsNow[k]);
  }
  for (let sl = 0; sl < N_SCAST; sl++) {
    const w = spotCasting.some((r) => r.sslot === sl);
    if (w === _spotWants[sl]) continue;
    _spotWants[sl] = w;
    gateShadow(spotSlots[sl], _prefShadows && w);
  }
}
// One dial ("shadowed lamps", ew-lamp-shadows) counts lamps of both kinds. The askers that cast are the best by tier
// (keep, authored, inferred: so an authored world light outranks the avatar's inferred chest lamp, whatever its kind),
// and within a tier a spot before a point (one map against a cube's six), each kind in its own rank order; at most
// N_CAST points and N_SCAST spots.
const tierOf = (r) => (r.keep ? 0 : r.authored ? 1 : 2);
function castingChoice(pointWinners, spotWinners) {
  // spots first in the list and a stable sort by tier: within a tier the spots stay ahead, each kind in rank order
  const askers = [...spotWinners.filter((r) => r.shadows && r.sslot >= 0), ...pointWinners.filter((r) => r.shadows)]
    .sort((a, b) => tierOf(a) - tierOf(b));
  const points = [], spots = [];
  for (const r of askers) {
    if (points.length + spots.length >= N_SHADOWED) break;
    if (r.spot) { if (spots.length < N_SCAST) spots.push(r); } else if (points.length < N_CAST) points.push(r);
  }
  return { points, spots };
}
/** A chosen spot sits in a casting-shaped spot slot (0.._spotShape-1), swapping with whoever holds one no chosen spot
 *  holds. */
function seatSpots(chosen, spotWinners) {
  const held = new Set(chosen.filter((r) => r.sslot >= 0 && r.sslot < _spotShape).map((r) => r.sslot));
  for (const w of chosen) {
    if (w.sslot >= 0 && w.sslot < _spotShape) continue;
    let s = 0;
    while (held.has(s)) s++;
    held.add(s);
    const incumbent = spotWinners.find((r) => r !== w && r.sslot === s);
    const vacated = w.sslot;
    w.sslot = s;
    if (incumbent) incumbent.sslot = vacated;
  }
}

// ---- the sun shadow ---------------------------------------------------------
// The frustum follows the camera by sliding the ortho extents in the light's view frame (moving sun.position would
// fight the sky), snapped to shadow-map texels or every step shimmers.

const SHADOW_HALF = 46;    // the measured box (docs/research/light-rig.md)
const SHADOW_DEPTH = 90;   // covers relief + trees around the focus plane
const _sm = new THREE.Matrix4();
const _sx = new THREE.Vector3(), _sy = new THREE.Vector3(), _sz = new THREE.Vector3();
const _rel = new THREE.Vector3(), _cw = new THREE.Vector3();
const _ZERO = new THREE.Vector3();

function updateShadow() {
  if (csm) return;   // the cascades fit themselves around the view (updateBefore)
  const cam = sun.shadow.camera;
  _rel.copy(camera.getWorldPosition(_cw)).sub(sun.position);   // world: in XR the camera is a child of the rig
  _sm.lookAt(sun.position, _ZERO, THREE.Object3D.DEFAULT_UP);
  _sm.extractBasis(_sx, _sy, _sz);
  const texel = (2 * SHADOW_HALF) / (sun.shadow.mapSize.x || 2048);
  const fx = Math.round(_rel.dot(_sx) / texel) * texel;
  const fy = Math.round(_rel.dot(_sy) / texel) * texel;
  cam.left = fx - SHADOW_HALF;
  cam.right = fx + SHADOW_HALF;
  cam.top = fy + SHADOW_HALF;
  cam.bottom = fy - SHADOW_HALF;
  // dist goes negative when the camera stands up-sun of the light: never clamp it (an ortho camera takes a negative near)
  const dist = -_rel.dot(_sz);
  cam.near = dist - SHADOW_DEPTH;
  cam.far = dist + SHADOW_DEPTH;
  cam.updateProjectionMatrix();
}

// ---- the caster budget ------------------------------------------------------
// object.castShadow is in no pipeline cache key, so the caster set is a live budget: the K that look largest from the
// camera cast (bounding radius / distance, roughly the angle subtended, plus up to 4 already casting inside the
// hysteresis edge, casterPass), the rest keep receiving. Two things come before size. A thing no shadow map can hold
// (outside the sun's shadow box, and out of the casting lamp's range: inShadowReach) ranks after everything a shadow
// can be drawn for, as a shadow distance does in Godot (directional_shadow_max_distance) and Unity (Shadow Distance).
// And a glow body, a thing whose every mesh is an emitter (emitterGlow, read each pass), does not cast while a light
// sits inside it: a lamp's glass must not shadow its own bulb. With no light in it, it is a thing like any other.
// A see-through surface casts nothing, per mesh and read each pass (surfaceCasts): a lantern's frame casts and its glass
// does not, and a thing with no mesh that casts holds no place in the budget. Depth
// pipelines are pre-warmed (warmqueue.warmDepth) before castShadow flips, ≤2 flips per pass; a disable fades out and
// castShadow clears when the fade ends (endFade). docs/research/shadow-depth-prewarm.md.

const casters = new Map();   // id -> { obj, meshes, casting, warm, released, centre, radius }
// how many things may cast at most: a Video setting; the governor sheds below it under load and climbs back to it
export const CASTER_CHOICES = [6, 12, 24, 48, 96];
let casterCeiling = (() => { try { const v = +localStorage.getItem('ew-shadow-casters'); return CASTER_CHOICES.includes(v) ? v : 24; } catch { return 24; } })();
let casterBudget = casterCeiling;
export const getCasterCeiling = () => casterCeiling;
export function setCasterCeiling(k) { if (!CASTER_CHOICES.includes(+k)) return; casterCeiling = +k; casterBudget = casterCeiling; try { localStorage.setItem('ew-shadow-casters', String(k)); } catch { /* private window */ } }
let lastCasterPass = 0;

// A thing with no measurable bounds (no position data yet) ranks as one this size: by distance among its kind.
const SIZELESS_RADIUS = 0.05;
const _bRel = new THREE.Matrix4(), _bS = new THREE.Sphere();
/** The bounding sphere of `meshes` in obj's OWN frame (obj's transform excluded, so a later move or scale of obj is
 *  read per pass from its matrixWorld). Measured once, at registration: meshes added later are not this record's
 *  meshes either (a realizer re-registers when a thing's drawn geometry changes, models.js partsChanged). */
function localBounds(obj, meshes) {
  obj.updateWorldMatrix(false, true);   // the descendants' local matrices
  const all = new THREE.Sphere();       // empty (radius -1) until a mesh with data joins
  for (const m of meshes) {
    let s;
    if (m.isInstancedMesh) { if (!m.boundingSphere) m.computeBoundingSphere(); s = m.boundingSphere; }   // all its instances
    else if (m.geometry) { if (!m.geometry.boundingSphere) m.geometry.computeBoundingSphere(); s = m.geometry.boundingSphere; }
    if (!s || s.isEmpty() || !Number.isFinite(s.radius)) continue;
    if (m === obj) _bRel.identity();    // obj is itself a mesh: its own transform is read per pass
    else { _bRel.copy(m.matrix); for (let p = m.parent; p && p !== obj; p = p.parent) _bRel.premultiply(p.matrix); }
    all.union(_bS.copy(s).applyMatrix4(_bRel));
  }
  return all.isEmpty() ? { centre: null, radius: SIZELESS_RADIUS } : { centre: all.center.clone(), radius: all.radius };
}

/** The models realizer registers every realized model here; retire releases. */
export function registerCaster(id, obj) {
  const meshes = [];
  // start not casting (a realizer may hand meshes in casting): the pass flips only where want !== casting
  obj.traverse((o) => { if (o.isMesh) { o.castShadow = false; meshes.push(o); } });
  casters.set(id, { id, obj, meshes, casting: false, warm: 'none', released: false, fade: 0, ...localBounds(obj, meshes) });
}
export function releaseCaster(id) {
  const c = casters.get(id);
  if (c) { c.released = true; fading.delete(c); }   // a queued warm re-reads this and skips the work
  casters.delete(id);
}
// realize/lifecycle.js: a realized object is going; its caster record and lamps go with it
bus.on('realized', ({ id, owner }) => { releaseCaster(id); releaseOwner(owner); });
export const casterCount = () => casters.size;
export function setCasterBudget(k) { casterBudget = Math.max(0, Math.min(casterCeiling, k)); }
export const getCasterBudget = () => casterBudget;

// ---- the fade: a caster dithers in and out over FADE_MS (materials.js FADE_MASK reads mesh.userData.shadowFade in
// the depth pass). castShadow goes true at the start of a fade-in and false at the end of a fade-out; a caster that
// comes back mid-fade reverses. A mesh whose material was never marked hard-flips.
export const FADE_MS = 300;
const fading = new Set();
let lastFadeTick = 0;
const canFade = (m) => {
  const ms = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
  return ms.length > 0 && ms.every((x) => x?.userData?.shadowFade === true);
};
function writeFade(c) {
  for (const m of c.meshes) if (canFade(m)) m.userData.shadowFade = c.fade;
}
function beginFade(c) {
  if (fading.has(c)) return;
  fading.add(c);
  // a batched InstancedMesh carries its own userData (amount 1): the source draws itself while it fades
  for (const m of c.meshes) if (!m.userData.noDrawBatch) { m.userData.noDrawBatch = true; (c.unbatched ??= []).push(m); }
}
function endFade(c) {
  fading.delete(c);
  for (const m of c.unbatched ?? []) delete m.userData.noDrawBatch;
  c.unbatched = null;
  if (c.fade === 0) for (const m of c.meshes) m.castShadow = false;
}
function stepFades(now) {
  const dt = lastFadeTick ? Math.min(100, Math.max(0, now - lastFadeTick)) : 0;
  lastFadeTick = now;
  if (!fading.size) return;
  for (const c of fading) {
    const target = c.casting ? 1 : 0;
    c.fade = target > c.fade ? Math.min(1, c.fade + dt / FADE_MS) : Math.max(0, c.fade - dt / FADE_MS);
    writeFade(c);
    if (c.fade === target) endFade(c);
  }
}
export const fadingCount = () => fading.size;

// a caster's bounds now: the world centre into _at, the world radius returned
const _at = new THREE.Vector3();
function placeOf(c) {
  c.obj.updateWorldMatrix(true, false);
  const mw = c.obj.matrixWorld;
  if (c.centre) _at.copy(c.centre).applyMatrix4(mw); else _at.setFromMatrixPosition(mw);
  return c.radius * mw.getMaxScaleOnAxis();
}
/** Can any shadow map hold a sphere here? The sun's map is a box around the camera in the light's frame (updateShadow
 *  wrote its axes this frame; with cascades, their far distance plus the margin up-sun), and each casting slot's cube
 *  reaches as far as its light does, while it draws. */
function inShadowReach(at, r, eye) {
  _rel.copy(at).sub(eye);
  if (csm) { if (_rel.length() - r <= CSM_FAR + CSM_MARGIN) return true; }
  else if (Math.abs(_rel.dot(_sx)) - r <= SHADOW_HALF && Math.abs(_rel.dot(_sy)) - r <= SHADOW_HALF && Math.abs(_rel.dot(_sz)) - r <= SHADOW_DEPTH) return true;
  for (let k = 0; k < N_CAST; k++) {
    const pl = slots[k];
    if (pl.intensity > 0 && castsNow(pl) && at.distanceTo(pl.position) - r <= (pl.distance || Infinity)) return true;
  }
  for (let k = 0; k < N_SCAST; k++) {   // a casting spot: its range sphere (conservative: the cone is inside it)
    const sl = spotSlots[k];
    if (sl.intensity > 0 && castsNow(sl) && at.distanceTo(sl.position) - r <= (sl.distance || Infinity)) return true;
  }
  return false;
}
// how far outside a glow body's bounding sphere a light still counts as inside it (a bulb at the glass)
const GLOW_BODY_MARGIN = 0.03;
// Godot's rule (BaseMaterial3D docs; SceneShaderForwardClustered::ShaderData::casts_shadows): a material that blends or
// reads the screen does not cast, a cut-out (alpha scissor, alpha hash) does. three draws a caster's depth with no
// opacity (only map.a against alphaTest), so a blended pane stamps a solid shadow. Departure: Godot's glTF importer
// makes BLEND a depth-prepass material, which casts where alpha >= 0.1; ours casts when its see-through is in its
// TEXTURE (opacity >= 0.99: the library's palm leaves, a mesh door, a screen), as main does and as foliage.js tells
// foliage from glass, and not when it is uniformly see-through (glass, wrap, tint: every such library surface is
// 0.12-0.45). Transmission is three's screen-read refraction: never casts.
const OPAQUE_UNIFORM = 0.99;
const materialCasts = (m) => !m || (!(m.transmission > 0) && !m.transmissionNode?.isNode
  && !(m.transparent && !(m.alphaTest > 0) && !m.alphaHash && (m.opacity ?? 1) < OPAQUE_UNIFORM));
/** A mesh casts if any of its material slots does (castShadow is per object: a frame slot keeps its shadow). Read each
 *  pass: a material component lands after the mesh, and materials.js replaces a transmissive material object. */
const surfaceCasts = (m) => (Array.isArray(m.material) ? m.material.some(materialCasts) : materialCasts(m.material));
/** All emitter (partly emitter: every mesh casts). Read each pass, not at registration: a thing's surface can arrive
 *  after its mesh (the material component lands on a later pass), and a lamp can be painted glowing in edit mode. */
const isGlowBody = (c) => c.meshes.length > 0 && c.meshes.every((m) => emitterGlow(m.material) > 0);
const _lightAt = [];
function casterPass() {
  const eye = camera.getWorldPosition(_cw);
  // where every requested light is, for the glow bodies
  let nLights = 0;
  for (const q of requests.values()) worldPosOf(q, _lightAt[nLights++] ??= new THREE.Vector3());
  const holdsALight = (at, r) => { for (let i = 0; i < nLights; i++) if (_lightAt[i].distanceTo(at) <= r + GLOW_BODY_MARGIN) return true; return false; };
  // the score: -1 barred (a glow body round its light), 0 out of every shadow map's reach, else the apparent size
  // squared, (world radius / distance from the eye to the bounds' centre)²; 1 cm floor: the eye inside a thing ranks
  // it first, finitely
  const ranked = [...casters.values()]
    .map((c) => {
      const r = placeOf(c);
      if (nLights && holdsALight(_at, r) && isGlowBody(c)) return { c, s: -1 };
      if (!c.meshes.some(surfaceCasts)) return { c, s: -1 };   // nothing in it would cast: no budget place
      return { c, s: inShadowReach(_at, r, eye) ? (r * r) / Math.max(1e-4, _at.distanceToSquared(eye)) : 0 };
    })
    .sort((a, b) => b.s - a.s);
  let enables = 0;
  // hysteresis: a caster keeps casting until its size score falls 1.25× below the last winner's (squared: 1.5625), so
  // a row of crates doesn't blink at the boundary. A budget of 0 keeps nothing.
  const edge = casterBudget === 0 ? Infinity : ranked.length >= casterBudget ? ranked[casterBudget - 1].s / 1.5625 : 0;
  for (let i = 0; i < ranked.length; i++) {
    const { c, s } = ranked[i];
    const want = s >= 0 && (i < casterBudget || (c.casting && s >= edge && i < casterBudget + 4));
    // a caster that stays on follows its meshes' surfaces (one fading out is cleared whole at the fade's end)
    if (want && c.casting) { for (const m of c.meshes) { const k = surfaceCasts(m); if (m.castShadow !== k) m.castShadow = k; } continue; }
    if (want === c.casting) continue;
    if (!want) {                          // the draw is shed when the fade-out ends
      c.casting = false;
      beginFade(c);
      continue;
    }
    // an unwarmed caster never flips: warm once, flip on a later pass once its depth pipelines exist
    if (c.warm === 'none') {
      c.warm = 'pending';
      warmDepth(`depth ${String(c.id).slice(0, 24)}`, () => (c.released ? [] : c.meshes))
        .then(() => { c.warm = 'done'; });
      continue;
    }
    if (c.warm !== 'done') continue;      // still warming
    if (c.fade > 0) { c.casting = true; beginFade(c); continue; }   // still fading out: reverse, no flip
    if (enables >= 2) continue;           // ≤2 flips per pass
    enables++;
    c.casting = true;
    writeFade(c);                         // amount 0 before the first depth draw
    for (const m of c.meshes) m.castShadow = surfaceCasts(m);
    beginFade(c);
  }
}

// ---- the per-frame drive ----------------------------------------------------

// a casting slot's shadow far plane follows its light's range (rewritten every frame by whichever request holds it).
// It is the far three's PointShadowNode draws with (light.distance || camera.far, renderShadow) and the one its
// sampling reads live (shadowCameraFar), so a map held across frames is compared with the far it was drawn with.
const _SHADOW_FAR_EPS = 1e-4;
function trackShadowFar(pl) {
  if (!pl.castShadow) return;
  const want = pl.distance || pl.shadow.camera.far;
  if (Math.abs(pl.shadow.camera.far - want) < _SHADOW_FAR_EPS) return;
  pl.shadow.camera.far = want;
  pl.shadow.camera.updateProjectionMatrix();
}

// ---- the shadow cache's rule ------------------------------------------------
// What a casting slot's map shows, i.e. what makes it dirty (each line names the shadow-cache suite row that fails
// without it):
//   the holder: which request the slot draws (hand-over, swap)                                 row 4 "holder"
//   the light's world position                                                                 row 4 "moves"
//   a spot's cone: where it points (its target) and its angle (three's fov = 2 angle * focus)  rows SC3, SC4
//   its range = the far plane three draws and samples with (and the near)                      row 4 "range", row 11
//   the map: its size (a resize applies only when it draws) and the target itself              row 8 "resolution"
//   the gate turning on (first holder that asked, the preference back on), a hold released    rows 8, 9, 13
//   the layers the frame camera sees (three's shadow camera borrows its mask)                  row 12 "layers"
//   per mesh with castShadow, visible down its whole chain, on a seen layer, whose bounds reach the light's range:
//     which meshes those are (one appearing, leaving, flipping castShadow, moving in or out)  rows 2, 3, 5
//     its world matrix                                                                         row 2
//     its geometry (a swap, a load finishing, positions edited in place, the draw range)      row 7 "geometry"
//     its material(s) (a swap, needsUpdate, side, alphaTest, visible)                          row 7 "material"
//     its dither fade (userData.shadowFade, the caster budget's 300 ms fade)                   row 5 "fade"
//     an InstancedMesh's instance matrices and count                                           row 7 "instances"
//     its morph influences                                                                     row 6 "morph"
//   a mesh that deforms without its matrix changing keeps the slot dirty while in range:
//     a SkinnedMesh, or a material with a vertex-stage position node (wind, water)             row 6
// Not dependencies: bias and normalBias (three samples them live, the map does not hold them); a light's intensity or
// colour; draw_batches' instancing (the same transforms, drawn while the sources' layers are off).
// A dirty slot whose whole light sphere is outside the view waits (it stays dirty): nothing on screen samples it. The
// pool keeps a light that misses the view in a slot when it has room, and re-ranks only every 600 ms, so it can.  row 10
const _ckP = new THREE.Vector3(), _ckS = new THREE.Sphere(), _ckV = new THREE.Frustum(), _ckM = new THREE.Matrix4();
const _lightP = Array.from({ length: _cl.length }, () => new THREE.Vector3());
const _lightR = new Array(_cl.length).fill(Infinity);
const _ckT = new THREE.Vector3();
const _onK = [];
function mark(c, tag) { c.marks.push(c.cur.length, tag); }
function pushMaterial(c, m) {
  if (!m) { c.cur.push(null); return; }
  c.cur.push(m, m.version, m.side, m.shadowSide, m.visible, m.alphaTest);
  if (m.positionNode || m.castShadowPositionNode) c.deforming = true;   // wind, waves: moves every frame in the vertex stage
}
/** One caster's part of slot c's reading. */
function pushCaster(c, o) {
  mark(c, 'casters'); c.cur.push(o);
  const g = o.geometry, pos = g.attributes?.position;
  mark(c, 'geometry'); c.cur.push(g, pos ? pos.version : -1, g.index ? g.index.version : -1, g.drawRange.start, g.drawRange.count);
  mark(c, 'matrix'); const e = o.matrixWorld.elements; for (let i = 0; i < 16; i++) c.cur.push(e[i]);
  mark(c, 'material');
  if (Array.isArray(o.material)) { c.cur.push(o.material.length); for (const m of o.material) pushMaterial(c, m); } else pushMaterial(c, o.material);
  mark(c, 'fade'); c.cur.push(o.userData.shadowFade);
  if (o.isInstancedMesh) { mark(c, 'instances'); c.cur.push(o.count, o.instanceMatrix.version); }
  if (o.morphTargetInfluences) { mark(c, 'morph'); for (const v of o.morphTargetInfluences) c.cur.push(v); }
  if (o.isSkinnedMesh) c.deforming = true;
}
// a caster's world bounds into _ckS (three's own: an object's boundingSphere where it has one, else its geometry's);
// a skinned mesh's is its bind pose, so it is doubled; no bounds yet = reaches everywhere
function boundsOf(o) {
  let s = o.boundingSphere;
  if (s === null && o.computeBoundingSphere) { o.computeBoundingSphere(); s = o.boundingSphere; }
  if (!s) { if (!o.geometry.boundingSphere) o.geometry.computeBoundingSphere(); s = o.geometry.boundingSphere; }
  if (!s || s.isEmpty() || !Number.isFinite(s.radius)) { _ckS.radius = Infinity; return; }
  _ckS.copy(s).applyMatrix4(o.matrixWorld);
  if (o.isSkinnedMesh) _ckS.radius *= 2;
}
let _seenMask = 1, _nOn = 0;
// three's _projectObject: an invisible object hides its subtree; layers are per object, tested against the frame camera
function visitCasters(o) {
  if (!o.visible || o === rigGroup) return;
  if (o.castShadow && o.geometry && (o.isMesh || o.isLine || o.isPoints) && (o.layers.mask & _seenMask) !== 0) {
    boundsOf(o);
    for (let i = 0; i < _nOn; i++) {
      const k = _onK[i];
      if (_ckS.center.distanceTo(_lightP[k]) - _ckS.radius > _lightR[k]) continue;   // outside the cube's far: cannot show
      pushCaster(_sc[k], o);
    }
  }
  const ch = o.children;
  for (let i = 0; i < ch.length; i++) visitCasters(ch[i]);
}
/** The first difference between what slot c drew and what it would draw now: a reason, or null. */
function diffReason(c) {
  const a = c.drawn, b = c.cur;
  if (!a) return 'first';
  const n = Math.min(a.length, b.length);
  let i = 0;
  while (i < n && a[i] === b[i]) i++;
  if (i === n && a.length === b.length) return null;
  let tag = 'casters';
  for (let j = 0; j < c.marks.length && c.marks[j] <= i; j += 2) tag = c.marks[j + 1];
  return tag;
}
function handOff(c, pl) {
  pl.shadow.needsUpdate = true;
  c.handoffs++; c.times.push(_rigNow); c.pending = true;
  const d = c.drawn ?? [], dm = c.drawnMarks;
  c.drawn = c.cur; c.drawnMarks = c.marks; c.cur = d; c.marks = dm;
  c.force = null; c.staleSince = -1;
}
const _dirtyK = [];
/** Once per frame, at the first render of the scene through a view camera: which casting slots redraw. */
function shadowCacheCheck(cam) {
  _cacheFrame++;
  _nOn = 0;
  for (let k = 0; k < _cl.length; k++) {
    const pl = _cl[k], c = _sc[k];
    if (c.pending && !pl.shadow.needsUpdate) c.draws++;   // three cleared it: the map was drawn
    c.pending = false;
    while (c.times.length && _rigNow - c.times[0] > 1000) c.times.shift();
    while (c.deferTimes.length && _rigNow - c.deferTimes[0] > 1000) c.deferTimes.shift();
    if (!castsNow(pl)) continue;
    _onK[_nOn++] = k;
  }
  if (!_nOn || _cacheHold > 0) return;
  _seenMask = cam?.layers?.mask ?? 1;
  for (let i = 0; i < _nOn; i++) {
    const k = _onK[i], pl = _cl[k], c = _sc[k];
    c.cur.length = 0; c.marks.length = 0; c.deforming = false;
    _lightP[k].setFromMatrixPosition(pl.matrixWorld);
    _lightR[k] = pl.distance || pl.shadow.camera.far;
    mark(c, 'holder'); c.cur.push((k < N_CAST ? shown[k] : _spotShown[k - N_CAST])?.key ?? null);
    if (pl.isSpotLight) {   // a spot's map is its cone: where it points, how wide (three's fov = 2 angle * focus)
      mark(c, 'cone'); _ckT.setFromMatrixPosition(pl.target.matrixWorld); c.cur.push(_ckT.x, _ckT.y, _ckT.z, pl.angle, pl.shadow.focus);
    }
    mark(c, 'light'); c.cur.push(_lightP[k].x, _lightP[k].y, _lightP[k].z);
    mark(c, 'range'); c.cur.push(pl.distance, pl.shadow.camera.near, pl.shadow.camera.far);
    mark(c, 'map'); c.cur.push(pl.shadow.mapSize.x, pl.shadow.mapSize.y, pl.shadow.map, renderer.shadowMap.type);
    mark(c, 'layers'); c.cur.push(_seenMask, pl.shadow.camera.layers.mask);
  }
  if (scene.children) visitCasters(scene);
  const view = cam?.projectionMatrix && cam.matrixWorldInverse;
  if (view) _ckV.setFromProjectionMatrix(_ckM.multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse), cam.coordinateSystem, cam.reversedDepth);
  let used = 0, nDirty = 0;
  for (let i = 0; i < _nOn; i++) {
    const k = _onK[i], pl = _cl[k], c = _sc[k];
    const reason = c.force ?? (c.deforming ? 'deforming' : diffReason(c));
    if (pl.shadow.needsUpdate) { c.reason = reason ?? 'gate'; handOff(c, pl); used++; continue; }   // already asked for (gateShadow): it draws
    if (!reason) { c.staleSince = -1; continue; }        // clean, or clean again while it waited
    c.reason = reason;
    if (c.staleSince < 0) c.staleSince = _cacheFrame;
    if (view && !_ckV.intersectsSphere(_ckS.set(_lightP[k], _lightR[k]))) { c.outOfView++; continue; }   // waits, dirty
    _dirtyK[nDirty++] = k;
  }
  // the budget: oldest-stale first (then slot order), so a slot that waited is never passed over again
  const order = _dirtyK.slice(0, nDirty).sort((a, b) => _sc[a].staleSince - _sc[b].staleSince || a - b);
  for (const k of order) {
    const c = _sc[k];
    if (used < _shadowBudget) { handOff(c, _cl[k]); used++; } else { c.deferred++; c.deferTimes.push(_rigNow); }
  }
}
if (SHADOW_CACHE && _cl.length > 0) {
  const before = scene.onBeforeRender;
  scene.onBeforeRender = function (r, sc, cam, ...rest) {
    if (typeof before === 'function') before.call(this, r, sc, cam, ...rest);
    // once per frame (updateRig arms it): an XR mirror or any later pass in the frame finds the maps already decided,
    // and a shadow pass (it renders this scene with an override material) is never the deciding one
    if (!_cacheArmed || sc !== scene || scene.overrideMaterial) return;
    _cacheArmed = false;
    shadowCacheCheck(cam);
  };
}

// ---- the spot pool (born at boot with the point slots, after them: see spotSlots) ----------------------------------
function assignSpots() {
  const ranked = [...requests.values()].filter((r) => r.spot).map((r) => rankOf(r, r.sslot >= 0)).sort(byRank);
  const winners = ranked.slice(0, N_SPOT).map((x) => x.r);
  const win = new Set(winners);
  for (const r of requests.values()) if (r.sslot >= 0 && (!win.has(r) || !r.spot)) r.sslot = -1;
  const used = new Set([...win].map((r) => r.sslot).filter((i) => i >= 0));
  let free = 0;
  for (const r of win) { if (r.sslot >= 0) continue; while (used.has(free)) free++; if (free >= N_SPOT) break; r.sslot = free; used.add(free); }
  for (const r of win) if (r.slot >= 0) r.slot = -1;   // a light that became a spot leaves the point pool
  return winners;
}
const _sq = new THREE.Quaternion(), _sfwd = new THREE.Vector3();
const _spotShown = new Array(N_SPOT).fill(null);   // the request each spot slot draws (the cache's holder)
function writeSpots() {
  const lit = new Array(N_SPOT).fill(null);
  for (const r of requests.values()) if (r.spot && r.sslot >= 0) lit[r.sslot] = r;
  for (let i = 0; i < N_SPOT; i++) {
    const sl = spotSlots[i], r = lit[i];
    _spotShown[i] = r;
    if (!r) { sl.intensity = 0; continue; }
    worldPosOf(r, sl.position);
    if (r.obj) r.obj.getWorldQuaternion(_sq); else if (r.q) _sq.set(r.q[0], r.q[1], r.q[2], r.q[3]); else _sq.identity();   // r.q: an unrealized host's world q (realize/models.js lightSpec)
    _sfwd.set(0, 0, -1).applyQuaternion(_sq);   // glTF/Godot: a spot shines down its local -Z
    sl.target.position.copy(sl.position).add(_sfwd);
    sl.target.updateMatrixWorld();
    sl.color.set(r.color);
    sl.intensity = r.intensity * (r.dayAware ? dayGlow() : 1);
    sl.distance = r.range; sl.decay = r.decay;
    sl.angle = r.spot.angle;
    sl.penumbra = r.spot.angle > 0 ? Math.min(1, Math.max(0, (r.spot.angle - (r.spot.inner ?? 0)) / r.spot.angle)) : 0;   // as three's GLTFLoader maps it
    if (i < N_SCAST) tuneSpot(sl);
  }
}
/** A casting spot's normal offset: 1.5 texels at min(3 m, its range), the world lamps' unit (Godot's
 *  shadow_normal_bias is in texels for omni and spot, both defaulting to 1.0: OmniLight3D.xml:29, SpotLight3D.xml:20).
 *  A texel at distance d spans about 2 d tan(angle) / n (the map covers the cone, three's fov = 2 angle). */
function tuneSpot(sl) {
  const n = sl.shadow.mapSize.x || SPOT_MAP;
  sl.shadow.bias = WORLD_DEPTH_BIAS;
  sl.shadow.normalBias = WORLD_BIAS_TEXELS * (2 * Math.min(WORLD_BIAS_DIST, sl.distance || 10) * Math.tan(Math.min(sl.angle, 1.5))) / n;
}

// ---- the hand-over: a slot that changes lamps crosses through dark. The ranking follows the view, so a turn of the head
// changes who burns; a slot that swapped lamps in one frame would pop one pool of light off and another on. Each slot
// draws `shown` at `gain`: when the request assigned to it changes, the old lamp dims out over HANDOVER_MS, then the
// new one comes up over the same. (Godot fades a light out toward its own distance limit, Light3D.distance_fade_*;
// here the limit is the pool, so the fade is at the slot.) Uniform writes only.
export const HANDOVER_MS = 150;
const shown = new Array(N_SLOTS).fill(null);
const gain = new Array(N_SLOTS).fill(0);
let lastWrite = 0;
/** The request slot i draws this frame, its gain stepped by dt. A strike takes and leaves its slot at once (it cannot
 *  wait, and dark it has nothing to fade); so does a lamp that is gone (released: its host may be gone with it). */
function handOver(i, want, dt) {
  let r = shown[i];
  if (r !== want) {
    if (!r || r.mirror || want?.mirror || requests.get(r.key) !== r) { r = shown[i] = want; gain[i] = 0; }
    else if ((gain[i] -= dt / HANDOVER_MS) <= 0) { r = shown[i] = want; gain[i] = 0; }
    else return r;   // still dimming the old lamp
  }
  if (r) gain[i] = Math.min(1, gain[i] + dt / HANDOVER_MS);   // (a mirror's slot is written verbatim: its gain is never read)
  return r;
}

/** Call once per frame. Reassigns when needed; writes every slot's uniforms. */
export function updateRig(now) {
  _rigNow = now;
  _cacheArmed = true;   // the shadow cache decides at this frame's first view render (scene.onBeforeRender)
  updateShadow();
  stepFades(now);   // before the pass: a fade begun this frame is drawn at its start amount first
  if (now - lastCasterPass > 300) { lastCasterPass = now; casterPass(); }
  // the sky system (wx.update) runs before the rig each frame: a strike that just lit takes its slot this frame
  for (const r of requests.values()) {
    if (!r.mirror || !(r.mirror.intensity > 0)) continue;
    r._litAt = now;
    if (r.slot < 0 && N_SLOTS > 0) assignDirty = true;
  }
  if (assignDirty || now - lastAssign > 600 || _lastCam.distanceToSquared(camera.getWorldPosition(_eye)) > 2.25) {
    assign(now);
  }
  writeSpots();
  const lit = new Array(N_SLOTS).fill(null);
  for (const r of requests.values()) if (r.slot >= 0 && !r.spot) lit[r.slot] = r;
  const dt = lastWrite ? Math.max(0, now - lastWrite) : 0;
  lastWrite = now;
  for (let i = 0; i < N_SLOTS; i++) {
    const pl = slots[i], r = handOver(i, lit[i], dt);
    if (!r) { pl.intensity = 0; continue; }
    if (r.mirror) {
      // an adopted foreign light: upstream drives its object, the slot copies it verbatim
      pl.position.copy(r.mirror.position);
      pl.color.copy(r.mirror.color);
      pl.intensity = r.mirror.intensity;
      pl.distance = r.mirror.distance;
      pl.decay = r.mirror.decay;
      trackShadowFar(pl);
      continue;
    }
    worldPosOf(r, pl.position);
    pl.color.set(r.color);   // Color.set takes a Color, a hex, or a string
    pl.intensity = r.intensity * (r.dayAware ? dayGlow() : 1) * gain[i];
    pl.distance = r.range;
    pl.decay = r.decay;
    trackShadowFar(pl);
    if (i < N_CAST) tuneSlot(i, r);   // the tuning follows the lamp the slot draws (and its range: a world lamp's basis)
  }
}

// ---- governor compatibility: the lights lever maps onto the slot cap -----------

export const litCount = () => {
  let n = 0;
  for (const r of requests.values()) if (r.slot >= 0) n++;
  return n;
};
export function shedALight() {
  if (slotCap === 0 || litCount() === 0) return false;
  setSlotCap(slotCap - 1);
  return true;
}

// the cache: redraws handed to three (all time / the last second), draws three confirmed, frames deferred by the budget
// (all time / the last second) or waiting outside the view, and why it last went dirty
const cacheRow = (j) => { const c = _sc[j]; return { handoffs: c.handoffs, redraws1s: c.times.length, draws: c.draws, deferred: c.deferred,
  deferred1s: c.deferTimes.length, outOfView: c.outOfView, reason: c.reason, stale: c.staleSince >= 0, deforming: c.deforming }; };
export const rigDebug = () => ({
  spots: spotSlots.map((sl) => ({ intensity: +sl.intensity.toFixed(3), angle: +sl.angle.toFixed(4), penumbra: +sl.penumbra.toFixed(4),
    pos: sl.position.toArray().map((x) => +x.toFixed(3)), dir: sl.target.position.clone().sub(sl.position).toArray().map((x) => +x.toFixed(3)) })),
  slots: N_SLOTS, cap: slotCap, dayness: dayness == null ? null : +dayness.toFixed(3),
  assignDirty,
  // the shadow gates; `wantsShadows` follows the REQUEST, not a slot, so a probe answers for the lamp
  shadows: (() => {
    const want = [...requests.values()].filter((r) => r.shadows);
    const held = want.filter((r) => r.slot >= 0);
    const holder = new Array(N_CAST).fill(null);
    for (const r of requests.values()) if (r.slot >= 0 && r.slot < N_CAST && !r.spot) holder[r.slot] = r;
    return {
      pref: shadowsOn(), map: renderer.shadowMap.enabled, sun: sun.castShadow, sunCasting: castsNow(sun),
      castingSlot: SHADOW_SLOT,      // the first casting slot
      castingSlots: N_CAST,          // slots 0..castingSlots-1 are born casting (ew-lamp-shadows)
      slotIsCaster: slots.slice(0, N_CAST).some(castsNow),   // does any casting slot draw (with one: that slot)
      // one row per casting slot: who holds it, whether it asked, whether it draws, and the tuning it draws with
      slots: holder.map((r, k) => ({
        slot: k, holder: r?.key ?? null, asked: _holderWants[k], body: Boolean(r?.body), drawing: castsNow(slots[k]),
        map: slots[k].shadow.mapSize.x, bias: slots[k].shadow.bias, normalBias: +slots[k].shadow.normalBias.toFixed(5),
        tunedFor: _tunedFor[k]?.key ?? null,
        cache: cacheRow(k),
      })),
      castingSpots: _spotShape,      // spot slots 0..castingSpots-1 are casting-shaped (born so above the default dial, or converted)
      spotCapacity: N_SCAST,         // how many spots may cast (the same dial)
      spotConversions: _spotConversions.map((x) => ({ ...x })),
      // one row per casting spot slot, as the point rows
      spotSlots: spotSlots.slice(0, _spotShape).map((sl, s) => ({
        slot: s, holder: _spotShown[s]?.key ?? null, asked: _spotWants[s], drawing: castsNow(sl), map: sl.shadow.mapSize.x,
        bias: sl.shadow.bias, normalBias: +sl.shadow.normalBias.toFixed(5), near: sl.shadow.camera.near, cache: cacheRow(N_CAST + s),
      })),
      cache: { on: SHADOW_CACHE, budget: _shadowBudget, held: _cacheHold },
      wantsShadows: want.map((r) => ({
        key: r.key, slot: r.slot,
        casting: r.spot ? r.sslot >= 0 && castsNow(spotSlots[r.sslot]) : r.slot >= 0 && castsNow(slots[r.slot]),
        intensity: r.slot >= 0 ? +(slots[r.slot]?.intensity ?? 0).toFixed(3) : 0,
      })),
      anyCasting: held.some((r) => castsNow(slots[r.slot])) || want.some((r) => r.spot && r.sslot >= 0 && castsNow(spotSlots[r.sslot])),
      lamp: lampShadowState(),
    };
  })(),
  slotState: slots.map((pl, i) => ({
    i, casting: pl.castShadow, intensity: +pl.intensity.toFixed(3),
    shown: shown[i]?.key ?? null,   // the request the slot is drawing: during a hand-over, still the old one
  })),
  _spotSlots: spotSlots,   // the live spot lights (test/client/shadow-cache-test.mjs plays three's shadow node over them)
  _slots: slots,   // the live lights, for probes and test/client/shadow-fade-test.mjs; the fields above are the stable surface
  casters: casters.size, casterBudget,
  casting: [...casters.values()].filter((c) => c.casting).length,
  casterList: [...casters.values()].map((c) => ({ id: String(c.id).slice(0, 24), casting: c.casting, warm: c.warm, fade: +c.fade.toFixed(3), meshes: c.meshes.length })),
  requests: [...requests.values()].map((r) => ({
    key: r.key, slot: r.slot, keep: r.keep, authored: r.authored,
    mirror: Boolean(r.mirror), dayAware: r.dayAware,
  })),
});

// ---- the makeWeatherSystem seam --------------------------------------------

const sceneProxies = new WeakMap();
function proxyFor(realScene) {
  let p = sceneProxies.get(realScene);
  if (p) return p;
  p = new Proxy(realScene, {
    get(t, prop) {
      if (prop === 'add') {
        return (...objs) => {
          for (const o of objs) {
            if (o?.isLight) adoptForeign(o);
            else t.add(o);
          }
          return p;
        };
      }
      if (prop === 'remove') {
        return (...objs) => {
          for (const o of objs) {
            if (o?.isLight) unadoptForeign(o);
            else t.remove(o);
          }
          return p;
        };
      }
      const v = t[prop];
      return typeof v === 'function' ? v.bind(t) : v;
    },
    set(t, prop, val) { t[prop] = val; return true; },   // writes land on the real scene
  });
  sceneProxies.set(realScene, p);
  return p;
}

function adoptForeign(light) {
  requestLight(`foreign:${light.uuid}`, { mirror: light, keep: true, authored: true });
}
function unadoptForeign(light) {
  releaseLight(`foreign:${light.uuid}`);
}

/** Release every adopted foreign light. The sky's teardown calls this: its scene-diff cannot see the bolt (the seam
 *  kept it out of the scene), and a dead mirror would hold a reserved slot forever. */
export function releaseForeignLights() {
  for (const k of [...requests.keys()]) {
    if (k.startsWith('foreign:')) releaseLight(k);
  }
}

let _realMakeWeatherSystem = null;
Object.defineProperty(globalThis, 'makeWeatherSystem', {
  configurable: true,
  get() {
    if (!_realMakeWeatherSystem) return undefined;
    return (args = {}) => _realMakeWeatherSystem(
      args?.scene ? { ...args, scene: proxyFor(args.scene) } : args,
    );
  },
  set(fn) { _realMakeWeatherSystem = fn; },
});
