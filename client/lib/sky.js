// sky — time of day, weather, and the lighting that follows from them.
//
// Two implementations behind one verb:
//
//   1. Skye's world packages (`makeSky({world})` from sky_worlds.js) — a real
//      raymarched atmosphere, volumetric clouds, weather states with rain and
//      lightning, baked environment reflections, and whole alternate worlds.
//   2. three's SkyMesh — the fallback, so a client still runs when the library
//      moves.
//
// The VERB is stable across both: {hours, rate, weather, clouds, …}. Which
// renderer answers it is an implementation detail the world log never sees.
// Quality tiers and the VR rules: docs/research/sky-quality-and-vr.md.

import { THREE, scene, sun, hemi, renderer, camera } from './core.js';
// ?shadowdebug=1 dims the fill to a fifth so the shadow map's coverage is legible (sun shadows read only ~10% darker)
const SHADOW_DEBUG_FILL = CONFIG.params.has('shadowdebug') ? 0.2 : 1;
import { report, bus, tee, teeNow, CONFIG } from './base.js';
import { serverNow } from './serverclock.js';   // a server stamp is read on the authority's clock
import { loadEidoModule, primeFiles, listLibrary, fetchBytes } from './assets.js';
import { markPhase } from './boot.js';
import { bandCuts, bandedBakeRender, bakeGeneration } from './sky_baked.js';
import { bakedDomeObject } from './sky_baked.js';
import { BAKE_INTERCEPT, attachBakedDome, detachBakedDome, updateBakedDome, bakedActive, requestBake, holdLiveDomes, releaseLiveDomes, liveDomesHeld, takeHeldDomes,
  envTexture, adoptEnvironment, whenBakeReady, bakedRefreshing } from './sky_baked.js';
import { beginWork } from './loadwork.js';
import { makeSwapChain, SHOWN_UNKNOWN } from './sky_swapchain.js';
import { serializeBakes as serializeBakesWith, BAKE_GUARD, BAKE_AFTER, BAKE_HELD } from './sky_bakelock.js';
import { showInterimSky, interimSkyObject, updateInterimSky, hideInterimSky, interimSkyShown } from './sky_interim.js';
import { busy as loadingBusy } from './framebudget.js';
import { bootDone } from './boot.js';
import { setDayness, releaseForeignLights } from './lightrig.js';
import { warm, P_AMBIENT } from './warmqueue.js';
import { WEATHERS, CLOUDS, effectiveSky, hoursAt, skyTicks } from '../../shared/forecast.js';
// Who owns which per-frame hook. The sky claims by diffing a GLOBAL array
// around its own async build; anything another subsystem marks as its own is
// off limits, whenever it appeared.
import { claimUnowned, releaseHook } from './autohooks.js';
import { rainSurfaceAt } from './terrain.js';

// The environment exists from the first frame — BLACK, contributing nothing —
// so every material's lighting graph is born with its env branch in place;
// flipping null→texture later recompiles every PBR material. Bakes change this
// texture's CONTENT; the object never changes.
scene.environment = envTexture();

// ---------------------------------------------------------------- state

let impl = null;           // 'eidoverse' | 'skymesh' | null
let skyApi = null;         // Skye's sky object when impl === 'eidoverse'
let skyInner = null;       // _internals.sky — upstream's declared escape hatch (§18b)
let skyMesh = null;
// The skymesh-path fill light is born EAGERLY: light topology is frozen at
// boot (TEL0S_NOTES §12.1: a light appearing later recompiles every lit
// material). On the eidoverse path it idles at intensity 0.
const fillLight = new THREE.DirectionalLight(0xffffff, 0);
scene.add(fillLight);
let clock = null;          // { args, t0 } — the server-stamped epoch
let currentWorld = null;

export const skyArgs = () => clock?.args ?? {};
export const skyImpl = () => impl;
// the cloud march's tier is THIS viewer's (SWEEP-3 S1): balanced, or high; read at the next build
export const SKY_QUALITY = ['balanced', 'high'];
let chosenQuality = null;   // this session's choice, kept even where storage refuses (bot #228)
export const skyQuality = () => { if (chosenQuality) return chosenQuality; try { return localStorage.getItem('ew-sky-quality') === 'high' ? 'high' : 'balanced'; } catch { return 'balanced'; } };
export function setSkyQuality(q) { chosenQuality = q === 'high' ? 'high' : 'balanced'; try { localStorage.setItem('ew-sky-quality', chosenQuality); } catch { /* this session only */ } }
/** §22m diag: the sky-owned scene roots, for cost-attribution phases that
 *  hide the sky's DRAW without touching its state. Read-only. */
export const skyOwnedObjects = () => skyOwned ?? [];
/** Under the world's water (watervolumes.js): the sky draws unfogged, so it is hidden while the camera is below the
 *  surface and the scene background paints the far water instead. Each object goes back to the visibility it had. */
const hiddenForWater = new Map();
export function hideSkyForWater(hide) {
  // every unfogged sky object: the basic SkyMesh, the eidoverse sky's domes, the baked dome (the default tiers) and the
  // interim gradient shown while a sky builds
  if (hide) { for (const o of [skyMesh, ...(skyOwned ?? []), bakedDomeObject(), interimSkyObject()]) if (o && !hiddenForWater.has(o)) { hiddenForWater.set(o, o.visible); o.visible = false; } }
  else { for (const [o, v] of hiddenForWater) o.visible = v; hiddenForWater.clear(); }
}
/** 0 at night → 1 at noon. Lamps and other night-aware things read this. */
export let dayness = 1;

// ---------------------------------------------------------------- quality
//
// The volumetric cloud march is the most expensive thing this client draws,
// dominated by `cloudPasses`. Every tier below 'high' shows a BAKED sky
// (sky_baked.js): the same march rendered once into the env-bake equirect and
// displayed on a static dome, re-baked when the sky changes, so 'medium' can
// afford the full 8-pass march. The trade is stillness between re-bakes.
// 'high' keeps the live march.
//
// A CLIENT preference, never world state or a verb: one person's GPU must not
// dictate everyone's sky. Stored locally, applied at build.
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];
// low, medium and high construct the SAME sky system, so a switch among them never tears the sky down: they differ
// only in what's shown (a bake at some size, or the live march). 'off' still builds its own.
const QUALITY_OPTS = {
  off: { cloudPasses: 1 },                     // plus setClouds('clear') below
  low: {},
  medium: {},
  high: {},                                    // the live march
};
// A stored 'live' (a retired fifth tier) is today's 'high'.
if (localStorage.getItem('ew-cloud-quality') === 'live') localStorage.setItem('ew-cloud-quality', 'high');
// Baked-tier bake parameters; 'high' is absent (the live march). One resolution/pass choice PER SESSION per tier:
// bakeEnv keys its cached node graph on (W, H, passes), so a changed value rebuilds the whole march pipeline.
// intervalMs is the crossfade cadence (sky_baked re-bakes and dissolves between bakes). The bake is banded
// (~2ms/frame), so a bigger equirect costs bake LATENCY, not frame rate.
const BAKED_TIERS = {
  off: { width: 1024, height: 512, cloudPasses: 1, intervalMs: 12000 },   // clear sky anyway
  low: { width: 2048, height: 1024, cloudPasses: 3, intervalMs: 12000 },
  medium: { width: 4096, height: 2048, cloudPasses: 8, intervalMs: 9000 },
};
const bakeOpts = () => {
  const { width, height, cloudPasses } = BAKED_TIERS[cloudQuality] ?? {};
  // 'off' bakes no cloud branch whatever the weather (setWeather respells the preset to cumulus/stratus under
  // storm/rain/overcast, which would pay a cloud-program compile the tier opted out of)
  return width ? { width, height, cloudPasses, ...(cloudQuality === 'off' ? { includeClouds: false } : {}) } : {};
};
let cloudQuality = localStorage.getItem('ew-cloud-quality') ?? 'medium';
const BAND_BUDGET = 0.4e6;   // texels x passes per boot-bake band — sky_baked's cadence budget (~a few ms a strip)
export const getCloudQuality = () => cloudQuality;

// VR CAP: in a headset on the WEBGL backend, clouds never run 'high' (it falls back to 'medium', the baked panorama):
// the live march per eye is far too slow and each eye marches its own noise (sky double-vision). The saved choice is
// untouched and comes back on exit. ⚑ Revisit with WebGPU-XR.
let xrPresenting = false;
let xrCappedFrom = null;          // the level the cap replaced, restored on exit
const CAP_FROM = 'high', CAP_TO = 'medium';
const vrCapApplies = () => xrPresenting && !!renderer.backend?.isWebGLBackend;
// NO SKY REBUILD WHILE PRESENTING: a rebuild (the cloud graph link, then a boot bake) can hold the GPU long enough to
// trip the driver watchdog and lose the session. It waits for the exit; the world's own sky changes (uniform writes plus
// the paced re-bake) still apply. What waits is only a quality flip or a switch of sky world.
let heldQuality = null;           // a quality chosen in the headset, applied at exit
let heldRebuild = false;          // a sky-world switch that arrived in the headset
/** What the headset is holding back, for the probe and the debug panel: { quality, rebuild } or null. */
export const skyHeld = () => (heldQuality || heldRebuild ? { quality: heldQuality, rebuild: heldRebuild } : null);
// In a headset the live cloud march never shows when a baked dome is on its way: held out until it attaches
// (sky_baked.holdLiveDomesInXR), with the gradient standing in (holding every dome with nothing behind is a black
// sky). A tier with no baked dome (high) keeps its march; so does a build whose baked dome failed to attach (P4: a
// costly sky beats no clouds).
let attachFailedFor = null;       // the sky build whose baked dome could not attach
let bakeRetriedFor = null;        // the sky build whose failed bake already had its one retry
let headsetGradient = false;      // the gradient is up because holdLiveInHeadset put it there
function holdLiveInHeadset() {
  if (!xrPresenting || !BAKED_TIERS[cloudQuality] || cloudQuality === 'off' || bakedActive() || attachFailedFor === skyApi) return;
  if (holdLiveDomes(skyApi, 'in a headset until the baked dome is ready') && !interimSkyShown()) { showInterimSky(skyInner?.uniforms); headsetGradient = true; }
}
// The cap's deferred flip at entry (waiting for the entry curtain), cleared at every entry and exit so a quick exit and
// re-entry can't carry the first session's timer into the next.
let capWait = null;
const clearCapWait = () => { capWait?.off?.(); clearTimeout(capWait?.tm); capWait = null; };
bus.on('xr:state', (on) => {
  xrPresenting = !!on;
  clearCapWait();
  if (on) { headsetGradient = false; holdLiveInHeadset(); }
  else if (!interimFor) {
    releaseLiveDomes();   // the desktop shows the live march until its bake lands (unless the boot hold is still waiting for the real sky)
    // the gradient only the headset needed goes with it; a swap in flight or a rebuild keeps its own
    if (headsetGradient && !swapping && !building) hideInterimSky();
  }
  headsetGradient = headsetGradient && !!on;
  // At exit, what was held applies: a held quality first (a same-system swap, or a rebuild for 'off'), then a held
  // sky-world switch once the sky is up (render() rebuilds on its own when the world differs). With the cap active, a
  // held quality is the cap's stand-in and its restore below replaces it; a held world switch rides after that restore.
  if (!on && (heldQuality || heldRebuild) && !xrCappedFrom) {
    const q = heldQuality, w = heldRebuild; heldQuality = null; heldRebuild = false;
    tee(`[sky] VR exit: applying the sky change held during the session (${[q && `clouds → ${q}`, w && 'sky world'].filter(Boolean).join(', ')})`);
    const done = q ? setCloudQuality(q, { persist: false }).catch((e) => report('sky held change (exit)', e)) : Promise.resolve();
    if (w) applyHeldWorldWhenUp(done);   // both held: the world rides after the quality
    return;
  }
  // a sky-world switch held while CAPPED survives to the cap's restore below. A quality held while capped is the cap's
  // own stand-in, which the restore replaces.
  const heldWorld = !on && heldRebuild && !!xrCappedFrom;
  if (!on) { heldQuality = null; heldRebuild = false; }
  // the tier the sky is running OR about to arrive as: a pending 'high' at entry is capped too.
  if (on && vrCapApplies() && (pendingTier ?? cloudQuality) === CAP_FROM) {
    xrCappedFrom = CAP_FROM;
    if (pendingTier === CAP_FROM) pendingTier = CAP_TO === cloudQuality ? null : CAP_TO;
    tee(`[sky] VR on WebGL: clouds capped ${CAP_FROM} → ${CAP_TO} (baked) for the session (the saved choice stays ${CAP_FROM})`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    // after the entry curtain is on screen (xr.js emits it), so the swap's bake doesn't take the GPU before the
    // headset's first frames; a session that ends first must not drop the desktop to medium. Only this call carries
    // the capFlip pass, so no other pick slips through in the headset.
    const w = capWait = { off: null, tm: 0 };
    const go = () => { if (capWait !== w) return; clearCapWait(); if (!xrPresenting || xrCappedFrom !== CAP_FROM) return;
      setCloudQuality(CAP_TO, { persist: false, capFlip: true }).catch((e) => report('sky VR cap', e));
      holdLiveInHeadset();   // a re-entry during the previous session's cap bake must not leave the march on screen
    };
    w.off = bus.on('xr:curtain-shown', go); w.tm = setTimeout(go, 4000);
  } else if (!on && xrCappedFrom) {
    const back = xrCappedFrom; xrCappedFrom = null;
    tee(`[sky] VR exit: clouds back to ${back}`);
    bus.emit('cloud-cap', null);
    setCloudQuality(back, { persist: false }).catch((e) => report('sky VR cap (exit)', e))
      .then(() => { if (heldWorld) applyHeldWorldWhenUp(Promise.resolve()); });
  }
});

// A held sky-world switch, applied once the preceding change has settled AND the sky is up, and only outside a
// headset (a new session holds it again). No forced currentWorld reset: render() rebuilds when the world differs.
function applyHeldWorldWhenUp(after) {
  after.then(() => whenSkyUp()).then(() => {
    if (xrPresenting) { heldRebuild = true; return; }
    tee('[sky] VR exit: applying the sky world held during the session'); skyBuilds = 0; if (clock) render();
  });
}
/** The VR cap in force, for the sky panel's note: { from, to } or null. */
export const cloudCap = () => (xrCappedFrom ? { from: xrCappedFrom, to: CAP_TO } : null);
/** What the person CHOSE — a settings row shows this, not the level the VR cap is running meanwhile. */
// the cap's memory first: choosing the capped level in a headset HOLDS its stand-in (high → medium held), and the choice
// is still high
export const getCloudChoice = () => xrCappedFrom ?? heldQuality ?? pendingTier ?? cloudQuality;   // a choice made in the headset (or while the sky arrives) shows at once
export const skyInXR = () => xrPresenting;

/** Change the local cloud budget. Rebuilds the sky, since passes are baked in
 *  at construction. */
// Where a sky rebuild's main-thread time goes: one line per rebuild, each phase's wall time + the long tasks (>50 ms,
// Chrome's longtask entries) inside it (the hitch IS the long tasks). Teed, so it reports to the server.
let phaseLog = null;
function phase(name) {
  if (!phaseLog) return;
  const now = performance.now();
  phaseLog.marks.push([name, now]);
}
function beginPhases(why) {
  const obs = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask')
    ? new PerformanceObserver((l) => { for (const e of l.getEntries()) phaseLog?.long.push([e.startTime, e.duration]); }) : null;
  try { obs?.observe({ type: 'longtask', buffered: false }); } catch { /* unsupported */ }
  phaseLog = { why, t0: performance.now(), marks: [], long: [], obs };
}
function endPhases() {
  const L = phaseLog; if (!L) return; phaseLog = null;
  L.obs?.disconnect();
  const pts = [['start', L.t0], ...L.marks, ['end', performance.now()]];
  const parts = [];
  for (let i = 1; i < pts.length; i++) {
    const [name, t] = pts[i], t0 = pts[i - 1][1];
    const lt = L.long.filter(([s0]) => s0 >= t0 && s0 < t);
    const blk = lt.reduce((a, [, d]) => a + d, 0), mx = lt.reduce((a, [, d]) => Math.max(a, d), 0);
    parts.push(`${name} ${(t - t0).toFixed(0)}ms${lt.length ? ` (long ${lt.length}×, ${blk.toFixed(0)}ms, max ${mx.toFixed(0)})` : ''}`);
  }
  const all = L.long.reduce((a, [, d]) => a + d, 0);
  tee(`[sky] rebuild (${L.why}): ${parts.join(' | ')} — main thread blocked ${all.toFixed(0)}ms total${L.obs ? '' : ' (no longtask API)'}`);
}

export async function setCloudQuality(level, { persist = true, capFlip = false } = {}) {
  if (!CLOUD_QUALITY.includes(level)) return;
  // asking for 'high' INSIDE a WebGL headset session: remember it for the exit, run the baked 'medium' now
  if (level === CAP_FROM && vrCapApplies()) {
    xrCappedFrom = CAP_FROM;
    if (persist) localStorage.setItem('ew-cloud-quality', level);
    tee(`[sky] VR on WebGL: ${CAP_FROM} clouds held at ${CAP_TO} (baked) until exit`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    level = CAP_TO;
    persist = false;
  }
  else if (persist && xrPresenting && xrCappedFrom) { xrCappedFrom = null; bus.emit('cloud-cap', null); }   // a deliberate uncapped choice in the headset replaces the cap's memory
  if (persist) localStorage.setItem('ew-cloud-quality', level);   // before the no-op return: choosing the level already running is still a choice
  // choosing the running tier again also cancels a tier queued while the sky was arriving (or the sky would arrive as
  // the tier the person had backed out of)
  if (level === cloudQuality) { heldQuality = null; if (pendingTier) { pendingTier = null; tee(`[sky] queued tier cancelled: staying ${level}`); } return; }
  if (xrPresenting && !capFlip) {   // capFlip: the VR cap's own entry flip, the one change let through
    heldQuality = level;
    tee(`[sky] clouds ${cloudQuality}→${level} held until VR exit (a rebuild in the headset stalls it for seconds)`);
    bus.emit('sky-held', { quality: level });
    return;
  }
  // A new choice gets its own single retry of a failed bake (a same-system switch doesn't rebuild, so a per-build
  // allowance would never retry again; sky-lifecycle-test).
  bakeRetriedFor = null;
  // low, medium and high construct the SAME sky system: a switch swaps what's shown instead of re-linking identical giant
  // programs (three's WebGL backend never frees a GL program, so each rebuild leaked). The VR cap's flip rides this too.
  if (SAME_SYSTEM.has(cloudQuality) && SAME_SYSTEM.has(level) && skyApi && impl === 'eidoverse' && !building) {
    // Still arriving (the gradient's up, finishSky running): wait for it, THEN swap. A rebuild here would throw the
    // arriving sky (and its prebuilt program) away. The latest choice wins if several arrive meanwhile.
    if (interimFor) {
      pendingTier = level;
      tee(`[sky] clouds → ${level} once the sky has arrived (no rebuild)`);
      const api = skyApi;
      whenSkyUp().then(() => {
        if (skyApi !== api || pendingTier !== level) return;
        pendingTier = null;
        if (level === cloudQuality) return;
        const from = cloudQuality; cloudQuality = level;
        swapTier(from, level).catch((e) => report('sky tier swap', e));
      });
      return;
    }
    const from = cloudQuality;
    cloudQuality = level;
    return swapTier(from, level);
  }
  beginPhases(`clouds ${cloudQuality}→${level}`);
  cloudQuality = level;
  currentWorld = null;          // force a rebuild at the new budget
  skyBuilds = 0;
  try { if (clock) await render(); } finally { endPhases(); }
}

// sky_system.js ASSIGNS globalThis.makeSkySystem when sky_worlds evals it and
// sky_worlds calls it in the same breath, so intercepting the assignment is the
// only seam (Skye's files stay untouched).
let _realMakeSkySystem = null;
Object.defineProperty(globalThis, 'makeSkySystem', {
  configurable: true,
  get() {
    if (!_realMakeSkySystem) return undefined;
    return (args = {}) => {
      const sys = _realMakeSkySystem({
        ...args,
        opts: { ...(args.opts ?? {}), ...QUALITY_OPTS[cloudQuality] },
      });
      // AT BIRTH: the system adds its domes to the scene synchronously, and the ~1 MB cloud program would go to the
      // render path on the next frame. Pull them out in the same tick (makeSkySystem resolves in a microtask, before
      // any frame); the interim gradient stands in and finishSky decides when (and whether) they are built.
      const hold = (sy) => {
        if (sy?.domes?.length && holdLiveDomes({ _internals: { sky: sy } }, 'from birth until the real sky is ready')) showInterimSky(sy.uniforms);
        return sy;
      };
      return typeof sys?.then === 'function' ? sys.then(hold) : hold(sys);
    };
  },
  set(fn) { _realMakeSkySystem = fn; },
});

// The canonical weather list lives in forecast.js (shared with the sequencer
// fold and the mcpl agent), re-exported for existing importers.
export { WEATHERS, CLOUDS } from '../../shared/forecast.js';
// Only `earth` is offered: ringworld and shieldworld each drag ~20MB of
// celestial geometry plus a second raymarched layer and take the tab down. A
// log that asks for one is coerced below rather than refused.
export const SKY_WORLDS = ['earth'];
const KNOWN_HEAVY = ['ringworld', 'shieldworld'];

// ---------------------------------------------------------------- entry point

/** Called by the world log's `sky` verb. `ts` is the server stamp — it is what
 *  makes every client's sun agree without the server simulating anything. */
export async function applySky(args = {}, ts) {
  // folded args carry their own ts; the param is for un-folded callers (the tuner's preview)
  clock = { args: { ...args }, t0: args.ts ?? ts ?? serverNow() };
  logged = { args: clock.args, t0: clock.t0 };
  previewing = false;
  await render();
}

/** Local preview (the tuner) — same path, no new epoch. */
export async function previewSky(args) {
  clock = { args: { ...args }, t0: clock?.t0 ?? serverNow() };
  previewing = true;
  await render();
}

// What the LOG says, apart from what this client draws: a preview replaces `clock` but never `logged`.
let logged = null, previewing = false, rendering = 0;
export const loggedSky = () => logged;
export const skyPreviewing = () => previewing;
// 'sky-busy' comes from the sky's own arrival (a stand-in gradient, a tier swap compiling): loading too. Harmless unheard.
let arriving = false;
bus.on('sky-busy', (b) => { arriving = !!b; bus.emit('sky-state'); });
// Terrain rebuilt or reshaped, water level changed: the weather's splash ground is a bake of
// rainSurfaceAt around the camera, so it re-reads it (over a few frames; the old one shows meanwhile).
bus.on('ground-changed', () => { skyApi?.invalidateGround?.(); });
// A render only reads as 'loading…' once it has run past LOAD_SHOW_MS: a rated sky, a real clock or a forecast re-render
// every second and finish in a frame, and flashing the line at 1 Hz re-rasterises the whole World panel in VR.
const LOAD_SHOW_MS = 400;
let renderSince = 0;
export const skyRendering = () => arriving || (rendering > 0 && performance.now() - renderSince >= LOAD_SHOW_MS);
export const skyDegraded = () => degrade >= 2;

function nowHours() {
  // the fold's hours-rebase uses the same formula, which keeps the sun from snapping (#29)
  return clock ? hoursAt({ ...clock.args, ts: clock.t0 }, serverNow()) : 12;
}

// How far the sky has been degraded to keep it working on this GPU.
//   0 = everything on
//   1 = GPU caches off (sky_system's light cache uses T3.textureStore, which
//       some WebGPU uniform layouts refuse; Skye's LCACHE/DCACHE knob)
//   2 = give up, use three's SkyMesh
let degrade = 0;
// Rebuilding the sky is expensive and stacks, and a per-frame fault fires 60
// times a second: without a hard budget "recovery" builds six atmospheres.
let skyBuilds = 0;
const MAX_SKY_BUILDS = 2;

// Every sky verb in a log calls render() and replay doesn't await them, so
// without this chain they'd run CONCURRENTLY, each building its own sky.
let renderChain = Promise.resolve();
function render() {
  bus.emit('sky-state');   // the log/preview state changed (readers write only on change)
  if (rendering++ === 0) {
    renderSince = performance.now();
    const at = renderSince;
    setTimeout(() => { if (rendering > 0 && renderSince === at) bus.emit('sky-state'); }, LOAD_SHOW_MS + 10);
  }
  renderChain = renderChain.then(renderOnce, renderOnce);
  const done = () => { rendering--; bus.emit('sky-state'); };
  renderChain.then(done, done);
  return renderChain;
}

async function renderOnce() {
  const a = clock?.args;
  if (!a) return;
  if (a.system === 'skymesh' || degrade >= 2) {
    if (skyApi || skyOwned.length) { teardownSky(); skyApi = null; currentWorld = null; }
    impl = 'skymesh';
    await renderSkyMesh(a);
    return markPhase('sky', 1);
  }

  // No hold, no settle beat: sky arrival invalidates NOTHING (the factory
  // applies weather wraps at material birth, the env texture is persistent,
  // the light rig swallows the bolt, and the sky's meshes precompile detached
  // inside buildSky; TEL0S_NOTES §12.7).
  {
    while (degrade < 2 && skyBuilds < MAX_SKY_BUILDS) {
    try {
      await renderEidoverse(a);
      return;
    } catch (e) {
      const why = e?.message ?? String(e);
      // An unsupported server is a fact, not a transient fault — stop dead.
      if (e?.skyUnsupported) {
        degrade = 2;
        console.warn('[sky]', why);
        bus.emit('sky-degraded', { msg: why });
        break;
      }
      const storage = /storageTexture|textureStore|storage texture/i.test(why);
      if (degrade === 0 && storage) {
        console.warn('[sky] GPU cache unsupported here — retrying without it:', why);
        bus.emit('sky-degraded', { msg: 'this GPU cannot do the sky\'s cached lighting — running the simpler path' });
      } else {
        report('eidoverse sky (falling back)', e);
      }
      // the build budget counts FAILURES (§18b), so a failed-then-recovered
      // boot doesn't leave later sky verbs stacking a SkyMesh over a working sky
      skyBuilds++;
      degrade++;
      skyApi = null;
      currentWorld = null;
    }
    }
    // Falling to the basic sky without a full teardown: the weather system will
    // not be rebuilt, so its adopted bolt must not outlive it.
    releaseForeignLights();
    impl = 'skymesh';
    // a rebuilding teardown may have put the stand-in gradient up; the basic sky replaces it, so 'sky-busy' can't stick.
    // Anyone waiting on the old build checks skyApi, which is null.
    interimFor = null; hideInterimSky(); markSkyUp();
    await renderSkyMesh(a);
    markPhase('sky', 1);
  }
}

// ============================================================ Skye's sky

// Which extra bytes a world package needs, discovered from the server's
// directory listing and split by world (earth skips the ringworld geometry).
async function primeFor(world, wantAudio) {
  const MODULES = [
    'eidoverse/sky_system.js', 'eidoverse/weather_system.js', 'eidoverse/cloud_spatial.js',
    'eidoverse/ringworld.js', 'eidoverse/redgiant.js', 'eidoverse/asteroid_moon.js',
    'eidoverse/weather_audio.js',
  ];
  const [skyFiles, particles] = await Promise.all([
    listLibrary('eidoverse/assets/sky'),
    // the weather system's rain streaks and splash sprites live here
    listLibrary('eidoverse/assets/particle_textures'),
  ]);
  if (!skyFiles || !particles) {
    // The toolkit sky reads its assets synchronously, so the client must list
    // them first (/library-list); a sequencer without it is older than this client.
    const e = new Error('this world\'s sequencer is older than this client (no /library-list) — detailed sky unavailable');
    e.skyUnsupported = true;
    throw e;
  }
  const wanted = skyFiles.map((f) => f.path).filter((p) => {
    if (p.includes('/audio/')) return wantAudio;
    // ~20MB of ring geometry and asteroid fields, only for worlds that have them
    if (p.includes('/celestial/')) return world !== 'earth';
    return true;
  });
  const missing = await primeFiles([...MODULES, ...wanted, ...particles.map((f) => f.path)]) ?? [];
  // the weather sounds are the asset library's (assets/sky/audio/), not the engine's: a server without them plays none
  return wantAudio && wanted.some((p) => p.includes('/audio/') && !missing.includes(p)) && !missing.includes('eidoverse/weather_audio.js');
}

// Single-flight: log replay doesn't await sky verbs, so several fire at once
// and each would see `skyApi === null` and build its own atmosphere. The guard
// is the in-flight PROMISE, not the finished result.
let building = null;

// The FIRST sky's warm, as a single-shot promise the boot gate can race
// (world.applySkyFolded): resolved when the first eidoverse build's dome warm
// drains, OR when the sky lands on the skymesh fallback. Never re-armed: a
// mid-session sky has no curtain.
let _skyWarmResolve = null;
const _skyWarmDone = new Promise((r) => { _skyWarmResolve = r; });
function resolveSkyWarm() { _skyWarmResolve?.(); _skyWarmResolve = null; }
export const whenSkyWarm = () => _skyWarmDone;

// What the last sky build put into the scene. makeSky's api has no dispose, so
// we diff the scene around the build and own the difference (otherwise every
// rebuild stacks another dome, weather system and particle hook).
let skyOwned = [];
let autoSystemsOwned = [];

function snapshotSceneOwnership() {
  return {
    before: new Set(scene.children),
    autos: new Set(globalThis._autoParticleSystems ?? []),
  };
}
function claimSkyAdditions(snap) {
  skyOwned = scene.children.filter((c) => !snap.before.has(c)
    // never claim anything the world itself owns — entities, bodies, the
    // terrain, the meadow, debug groups: all can be added by other code
    // while an async sky build is in flight. skyExempt is the positive marker
    // world-owned roots wear at their add site (§17c), isDebug debug.js's.
    && !c.userData?.entityId && !c.userData?.isBody
    && !c.userData?.skyExempt && !c.userData?.isDebug);
  // Hooks are claimed the same way: by identity, never something another owner
  // marked as theirs. The build is ASYNC, so a hook that appeared while it was
  // in flight (a `particles` emitter) is new but not ours.
  autoSystemsOwned = claimUnowned(snap.autos);
}
function teardownSky({ rebuilding = false } = {}) {
  // A rebuild keeps a gradient up through the teardown and the new build's loads (no black gap on a quality flip). The
  // palette uniforms are plain objects and outlive the system. A teardown to the basic sky drops it. A pending
  // finishSky sees skyApi change and stops.
  interimFor = null; pendingTier = null; swaps.reset(); markSkyUp();   // anyone waiting for the old build: it's gone (they check skyApi)
  if (rebuilding && skyInner?.uniforms) showInterimSky(skyInner.uniforms); else hideInterimSky();
  // Held domes are taken, not put back: never compiled, they must not reach the scene on the way out.
  const held = takeHeldDomes();
  // The adopted lightning first: the scene diff below cannot see it (the
  // rig kept it OUT of the scene), and a dead mirror would hold a slot forever.
  releaseForeignLights();
  // Put the parked live domes back first: the diff below claimed them at
  // build time, so restoring them lets the disposal pass free them.
  detachBakedDome();
  // §22b: the engine's OWN dispose, the only path to the ~64MB _envTarget, the
  // bake target and the noise/weather textures. AFTER the blit, BEFORE the dome
  // disposal walk (double-dispose is idempotent in three).
  if (skyInner) skyInner.__dead = true;   // queued bakes skip it (serializeBakes)
  try { skyInner?.dispose?.(); } catch (e) { console.warn('[sky] engine dispose', e?.message ?? e); }
  try { skyInner?.__disposeKeptBakes?.(); } catch (e) { console.warn('[sky] kept bake graphs', e?.message ?? e); }
  skyInner = null;
  for (const o of skyOwned) {
    scene.remove(o);
    o.traverse?.((n) => {
      n.geometry?.dispose?.();
      const m = n.material;
      if (Array.isArray(m)) m.forEach((x) => x?.dispose?.());
      else m?.dispose?.();
    });
  }
  for (const d of held) if (!skyOwned.includes(d)) { d.removeFromParent?.(); d.geometry?.dispose?.(); d.material?.dispose?.(); }
  skyOwned = [];
  // the per-frame hooks the sky registered, and only those (claimSkyAdditions)
  for (const h of autoSystemsOwned) releaseHook(h, globalThis._autoParticleSystems);
  autoSystemsOwned = [];
}

async function renderEidoverse(a) {
  if (a.world && KNOWN_HEAVY.includes(a.world)) {
    console.warn(`[sky] "${a.world}" is disabled here (too heavy for a live client) — using earth`);
  }
  const world = SKY_WORLDS.includes(a.world) ? a.world : 'earth';
  const wantAudio = Boolean(a.audio);

  if (building) {
    await building.catch(() => {});   // whoever is already building wins
  }
  if (skyApi && currentWorld !== world && currentWorld !== null && xrPresenting) {
    heldRebuild = true;
    tee(`[sky] sky world ${currentWorld}→${world} held until VR exit`);
    applyLive(a);
    return;
  }
  const fresh = !skyApi || currentWorld !== world;
  if (fresh) {
    const work = beginWork('sky build'); // names the module-eval + system-construction frame gaps
    building = buildSky(a, world, wantAudio).finally(() => work.end());
    try { await building; } finally { building = null; }
  }
  applyLive(a);
  // THE WORLD FIRST, THE SKY LAST. After a fresh build the real sky's domes stay out of the scene and a plain gradient
  // in the hour's own colours stands in; the cloud programs compile only once the world near you has loaded, never in
  // the serial warm conductor. Detached, so later sky verbs apply at once instead of queueing behind the compile.
  if (fresh && (holdLiveDomes(skyApi, 'until the real sky is ready') || liveDomesHeld())) {
    interimFor = skyApi;
    showInterimSky(skyInner?.uniforms);
    // Under the boot splash (only at boot): the VR cap's bake program compiles while the splash is still up, capped at
    // 40 s inside the splash's 45 s ceiling. A later fresh build to high leaves it to finishSky's +15 s prebuild.
    if (!BAKED_TIERS[cloudQuality] && !bootDone()) await Promise.race([prebuildCapBake(skyApi), new Promise((r) => setTimeout(r, 40000))]);
    resolveSkyWarm();
    finishSky(skyApi).catch((e) => report('sky finish', e));
    return;
  }
  if (interimFor) return;                // the real sky is still on its way: finishSky owns the bake
  holdLiveInHeadset();                   // a build in a headset: no live march on screen while its bake is coming
  const bake = beginWork('sky bake');    // names the env-bake + reflections gaps
  phase('apply');
  try { await ensureSkyBake(); } finally { bake.end(); }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // a fresh build whose domes couldn't be held after a rebuilding teardown showed the stand-in: nothing else hides it.
  // Fresh only: a 1 Hz re-apply must not hide a size swap's gradient.
  if (fresh) hideInterimSky();
  resolveSkyWarm();
}

async function finishSky(api) {
  phase('apply');
  await worldSettled();
  if (skyApi !== api) return;            // torn down / rebuilt while we waited: the newer build owns the sky
  // a tier chosen while we waited (the VR cap at an early entry): same system, so just arrive as that tier
  if (pendingTier) { tee(`[sky] arriving as ${pendingTier} (chosen while the sky was loading)`); cloudQuality = pendingTier; pendingTier = null; }
  const bake = beginWork('sky bake');
  if (!BAKED_TIERS[cloudQuality]) {
    // the live tier: its env bake only lights reflections, so the clouds don't wait for it; both compile side by side
    // and the domes show as soon as theirs are linked.
    ensureSkyBake().catch((e) => report('sky env bake', e)).finally(() => bake.end());
  } else {
    try { await ensureSkyBake(); } finally { bake.end(); }
  }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // No baked dome (the high tier, a failed attach): the live domes ARE the sky. Compile them off the render path,
  // then show them. (A baked tier parks them unseen, so their programs are never built at all.)
  if (!bakedActive() && skyApi === api) await compileLiveDomes();
  if (skyApi !== api) return;
  // A baked tier chosen WHILE the live domes compiled (the VR cap): arrive as that tier instead of putting the per-eye
  // live march in the headset first.
  if (!bakedActive() && pendingTier && BAKED_TIERS[pendingTier]) {
    tee(`[sky] arriving as ${pendingTier} (chosen while the live domes compiled): baked, the live march never shown`);
    cloudQuality = pendingTier; pendingTier = null;
    bakePending = true;
    const late = beginWork('sky bake');
    try { await ensureSkyBake(); } catch (e) { report('sky bake', e); } finally { late.end(); }
    if (bakedActive()) await whenBakeReady();
    if (skyApi !== api) return;
  }
  if (!bakedActive()) releaseLiveDomes();   // compiled above: safe to show, headset or not
  interimFor = null;
  hideInterimSky();
  tee(`[sky] the real sky is up (${bakedActive() ? 'baked dome' : 'live domes'}); the interim gradient is gone`);
  markSkyUp();
  if (!BAKED_TIERS[cloudQuality] && capPrebuiltFor !== api) prebuildCapBakeWhenHeadset(api);   // a build that wasn't under the splash
}

// ENTERING VR FROM HIGH: the cap swaps high → medium at entry, and compiling medium's bake program then left the
// headset with no frame to present. With a headset present it is compiled on the desktop instead, once, ~15 s after
// the sky is up: a 64x32 bake of medium's pass count into a TEMPORARY target (a bake's shader doesn't depend on its
// size), kept by retainBakeGraphs so the entry's 4096 bake is a program-cache hit.
let capPrebuiltFor = null;   // the sky build whose cap program is already compiled (or compiling)
const headsetPresent = async () => { try { return !!(await navigator.xr?.isSessionSupported?.('immersive-vr')); } catch { return false; } };
async function prebuildCapBake(api) {
  if (capPrebuiltFor === api || !(await headsetPresent())) return;
  if (skyApi !== api || BAKED_TIERS[cloudQuality] || xrPresenting) return;
  capPrebuiltFor = api;
  // the same guards again INSIDE the bake lock: queued behind a long bake, the prebuild's turn can come after a VR entry
  const wanted = () => skyApi === api && !BAKED_TIERS[cloudQuality] && !xrPresenting;
  if (!(await prebuildBakeProgram(BAKED_TIERS[CAP_TO].cloudPasses, {}, wanted)) && capPrebuiltFor === api) capPrebuiltFor = null;
}
async function prebuildCapBakeWhenHeadset(api) {
  if (!(await headsetPresent())) return;
  await new Promise((r) => setTimeout(r, 15000));
  await prebuildCapBake(api);
}
/** Compile a bake program (the given pass count) without touching the sky's own env target. Exported for probes. */
export async function prebuildBakeProgram(cloudPasses, opts = {}, stillWanted = null) {
  const api = skyApi, sys = skyInner;
  if (!api?.bakeEnv || !sys) return false;
  const t0 = performance.now();
  const lock = sys.__withBakeLock ?? ((fn) => fn());
  // the whole swap under the bake lock: no other bake may see the temporary target (see serializeBakes)
  let ran = false;
  await lock(async () => {
    if (sys.__dead) return;
    if (stillWanted && !stillWanted()) { tee('[sky] the VR cap\'s bake prebuild: no longer wanted when its turn came (skipped)'); return; }
    ran = true;
    const keepT = sys._envTarget, keepFb = sys._envFbNode?.value;
    sys._envTarget = null;
    try {
      // through the api (it adds the world's own bake options); BAKE_HELD tells the lock's wrapper this call already
      // holds the lock
      await api.bakeEnv({ width: 64, height: 32, cloudPasses, ...opts, [BAKE_HELD]: true });
    } catch (e) { ran = false; report('sky prebuild', e); }   // a failed prebuild isn't a prebuilt program
    finally {
      // put the real target and reflection fallback back NOW, not after the link wait below, or reflections sample the
      // undrawn 64x32 meanwhile. The graph keeps the program.
      const tmp = sys._envTarget;
      sys._envTarget = keepT;
      if (sys._envFbNode && keepFb !== undefined) sys._envFbNode.value = keepFb;
      if (tmp && tmp !== keepT) tmp.dispose();
    }
    // still inside the lock: no bake may start until the prebuilt program has linked
    await globalThis.__syncGate?.whenGiantLinked?.();
  });
  if (!ran) return false;
  tee(`[sky] headset present: the VR cap's bake program (${cloudPasses} passes) prebuilt on the desktop in ${(performance.now() - t0).toFixed(0)} ms`);
  return true;
}

let interimFor = null;    // the sky build the interim gradient is standing in for
let pendingTier = null;   // a tier chosen while the sky was still arriving, swapped in once it has
let skyUpResolve = null, skyUpP = null;
/** Resolves once the current sky build has arrived (finishSky done), at once if nothing is arriving. */
function whenSkyUp() {
  if (!interimFor) return Promise.resolve();
  if (!skyUpP) skyUpP = new Promise((r) => { skyUpResolve = r; });
  return skyUpP;
}
function markSkyUp() { const r = skyUpResolve; skyUpResolve = null; skyUpP = null; r?.(); }
/** Nearby world first: boot finished and no loading work queued, for a second in a row (at most 60 s). */
async function worldSettled() {
  const t0 = performance.now(); let calm = 0;
  while (performance.now() - t0 < 60000) {
    if (bootDone() && !loadingBusy()) { if (++calm >= 4) break; } else calm = 0;
    await new Promise((r) => setTimeout(r, 250));
  }
  teeNow(`[sky] world settled after ${((performance.now() - t0) / 1000).toFixed(1)} s: compiling the sky now`);
}
// 'sky-busy' (true/false): the sky is still arriving here (the stand-in gradient is up, or a tier swap is compiling or
// baking). Two listeners: xr.js's entry curtain, which waits on it (capped at 15 s), and the `arriving` flag above,
// which feeds skyRendering() and so the World › sky panel's "you: loading…".
let swapping = 0, busyShown = false;
function announceBusy() {
  const b = interimSkyShown() || swapping > 0 || bakedRefreshing();
  if (b !== busyShown) { busyShown = b; bus.emit('sky-busy', b); }
}
bus.on('sky-interim', announceBusy);
bus.on('sky-refreshing', announceBusy);
export const skyBusy = () => busyShown;
/** Probes only: the api and the engine object. */
export const skyForProbe = () => ({ api: skyApi, sys: skyInner });
// sky_system keeps ONE bake graph (sys._envBake) and disposes it whenever a bake with another key arrives, which
// evicted medium's giant bake program on every switch. three looks programs up by shader SOURCE and frees one only when
// unused, so evicted graphs are kept (dispose deferred, one per key) and a rebuild is a program-cache hit; all go at
// teardown. ONE BAKE AT A TIME: sky_bakelock.js (test/client/sky-bakelock-test.mjs).
const serializeBakes = (sys) => serializeBakesWith(sys, { log: (l) => tee(l), report });
function retainBakeGraphs(sys) {
  if (!sys || Object.getOwnPropertyDescriptor(sys, '_envBake')?.get) return;
  let cur = sys._envBake ?? null;
  const kept = new Map();   // key → a graph whose dispose was deferred
  const keep = (b) => {
    if (!b || b.__realDispose) return b;
    b.__realDispose = b.dispose.bind(b);
    b.dispose = () => {
      const old = kept.get(b.key);
      if (old && old !== b) old.__realDispose();   // the newer graph of that key holds the same programs
      kept.set(b.key, b);
    };
    return b;
  };
  keep(cur);
  Object.defineProperty(sys, '_envBake', { configurable: true, get: () => cur, set: (b) => { cur = keep(b); } });
  sys.__keptBakeKeys = () => [...kept.keys()];
  sys.__disposeKeptBakes = () => { for (const b of new Set([...kept.values(), cur])) b?.__realDispose?.(); kept.clear(); cur = null; };
}
const SAME_SYSTEM = new Set(['low', 'medium', 'high']);
// ONE SWAP AT A TIME, LATEST CHOICE WINS: the chain and its SHOWN bookkeeping live in sky_swapchain.js (pure, tested by
// test/client/sky-swapchain-test.mjs). swapTierInner below does the screen work.
const swaps = makeSwapChain({ inner: (from, to) => swapTierInner(from, to), want: () => cloudQuality, api: () => skyApi, log: (l) => tee(l) });
function swapTier(from) {
  swapping++; announceBusy();
  return swaps.swap(from).finally(() => { swapping--; announceBusy(); });
}
async function swapTierInner(from, to) {
  const t0 = performance.now(), api = skyApi;
  const F = BAKED_TIERS[from], T = BAKED_TIERS[to];
  // from = SHOWN_UNKNOWN (a superseded run left no tier on screen): a baked `to` takes the baked→baked path, which
  // assumes nothing about the screen; `high` takes !T, which compiles and shows the live domes from any state.
  if ((F || from === SHOWN_UNKNOWN) && T) {
    // baked → baked at another size (low ↔ medium): the old dome's texture is the target the new bake re-creates, so
    // the live march is held out and the gradient stands in until the new dome attaches.
    detachBakedDome();
    holdLiveDomes(skyApi, 'while the sky re-bakes at the new size');
    showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: the queued swap owns the sky now, so leave the gradient/hold up for it.
    // 'superseded' makes the chain record NO tier as shown (sky_swapchain.js).
    if (skyApi !== api) return false;
    if (cloudQuality !== to) return 'superseded';
    if (!bakedActive()) releaseLiveDomes();
    hideInterimSky();
  } else if (!T) {
    // the baked dome stays up while the live domes compile off the render path; then they replace it
    await compileLiveDomes();
    if (skyApi !== api || BAKED_TIERS[cloudQuality]) return false;
    detachBakedDome();
    hideInterimSky();                   // a superseded bake swap may have left the gradient up
    scheduleEnvBake({ force: true });   // the live tier's own env-IBL
  } else {
    // live → baked: the live march stays on screen while the bake runs (in a headset it's held out, the gradient
    // stands in: no per-eye march), then the baked dome parks it
    if (xrPresenting && holdLiveDomes(skyApi, 'in a headset until the baked dome is ready')) showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: the queued swap owns the sky now, so leave the gradient/hold up for it.
    // 'superseded' makes the chain record NO tier as shown (sky_swapchain.js).
    if (skyApi !== api) return false;
    if (cloudQuality !== to) return 'superseded';
    if (!bakedActive()) releaseLiveDomes();
    hideInterimSky();
  }
  tee(`[sky] clouds ${from}→${to} without a rebuild (${(performance.now() - t0).toFixed(0)} ms)`);
  return true;
}

async function compileLiveDomes() {
  const domes = skyInner?.domes ?? [];
  const t0 = performance.now();
  // compileAsync skips invisible objects; a hidden cloud dome would otherwise link later, on the render path
  const forced = domes.filter((d) => !d.parent && !d.visible);   // only while OUT of the scene: in it, visible = drawn
  for (const d of forced) d.visible = true;
  try { await Promise.all(domes.map((d) => renderer.compileAsync(d, camera, scene).catch(() => {}))); }
  // put back only what we flipped, and only if nothing else wrote it during the compile
  finally { for (const d of forced) if (d.visible === true && !d.parent) d.visible = false; }
  tee(`[sky] live domes compiled in ${(performance.now() - t0).toFixed(0)} ms (off the render path)`);
}

async function buildSky(a, world, wantAudio) {
  {
    // tear down a previous world's sky before building another
    try { skyApi?.dispose?.(); } catch { /* upstream has none; the diff below is the real teardown */ }
    teardownSky({ rebuilding: true });
    skyApi = null;
    const ownership = snapshotSceneOwnership();
    // Quality tier: Skye's TIER=balanced (3 cloud passes) unless this viewer chose 'high'.
    const envKnobs = (globalThis.__ewEnv ??= {});
    envKnobs.TIER = skyQuality() === 'high' ? undefined : 'balanced';
    // GPU caches: LCACHE OFF by default. sky_system's light cache writes through T3.textureStore, which three's WebGPU
    // backend rejects (`Uniform "storageTexture" not implemented`) as an unhandled rejection per frame that nothing can
    // catch; it doesn't reproduce headless, so it is not feature-detected. Only the LIGHT cache: CACHE=0 kills the
    // density cache too and the sky renders black. Opt IN with quality:'high'.
    envKnobs.CACHE = undefined;
    envKnobs.DCACHE = undefined;
    envKnobs.LCACHE = skyQuality() === 'high' ? undefined : '0';

    // No boot yield here: arrival GATES on this build's warm (world.applySkyFolded,
    // §16.2.D), so a sky waiting for boot would be a splash that never lifts.
    phase('teardown');
    const audio = await primeFor(world, wantAudio);
    phase('prime');
    await loadEidoModule('sky_worlds.js');
    phase('module');
    if (typeof globalThis.makeSky !== 'function') throw new Error('sky_worlds.js exposed no makeSky');
    if (skyMesh) { scene.remove(skyMesh); skyMesh = null; }
    // A fresh build asserts state rather than easing into it: reset the
    // applyLive guards so the first applyLive re-asserts everything.
    forecastCursor = null; appliedWeather = null; appliedClouds = null; appliedColors = null;
    lastLiveHours = null;
    // the DERIVED weather (the authored field may be segments stale); mid-transition, the segment's previous state
    const eff0 = effectiveSky(a, serverNow());
    const w0 = (eff0.source === 'forecast' && eff0.inTransition && eff0.seg.prevState)
      ? eff0.seg.prevState : eff0.weather;
    skyApi = await globalThis.makeSky({
      scene, camera, renderer, world,
      hours: nowHours(),
      clouds: cloudQuality === 'off' ? 'clear' : (CLOUDS.includes(a.clouds) ? a.clouds : 'cumulus'),
      weather: WEATHERS.includes(w0) ? w0 : 'clear',
      sun, hemi,
      audio,
      // the rain's splashes ring out on the ground under them — terrain, water, nothing past the edge —
      // not on the library's default flat y=0 (a library older than this option ignores it)
      groundHeightAt: rainSurfaceAt,
    });
    phase('makeSky');
    claimSkyAdditions(ownership);
    // ---- the clear↔cloudy fence (§18b, pre-paid §19a) ----------------------
    // The baked tier's graph cache keys on preset !== 'clear' (sky_system
    // bakeKey …|c0/c1), and the cloud-carrying graph is a giant compile that
    // stalls the GPU process cold; the only question is WHEN a session pays it.
    // Inside the boot splash: on cloud-capable tiers 'clear' is ALWAYS respelled
    // as an empty cumulus (finalMul 0), so the c1 graph pins at the boot bake and
    // every later sky change is uniform writes. The wrap sits on the INTERNAL
    // setter because the weather system calls setClouds('clear') behind the api.
    // The 'off' tier keeps genuine 'clear' (c0).
    skyInner = skyApi?._internals?.sky ?? null;
    retainBakeGraphs(skyInner);
    serializeBakes(skyInner);
    // held from birth, the domes were never in the scene for the diff above: claim them by identity, so a teardown
    // (which puts held domes back first) still finds and frees them
    for (const d of skyInner?.domes ?? []) if (d && !skyOwned.includes(d)) skyOwned.push(d);
    if (skyInner?.setClouds && cloudQuality !== 'off') {
      const orig = skyInner.setClouds.bind(skyInner);
      skyInner.setClouds = (kind, over) => (kind === 'clear'
        ? orig('cumulus', { ...(over ?? {}), finalMul: 0, wispOn: 0, stormCanopy: 0 })
        : orig(kind, over));
    }
    // Warm the sky's OWN pipelines off the render path through the warm
    // conductor (§16.2.A), one item per addition with a frame between: detach,
    // compile against the live scene, re-add (the grass precompile pattern).
    // THE DOMES DO NOT GO THROUGH THE CONDUCTOR: a cold cloud-dome link takes
    // minutes on WebGL and would starve every model pipeline behind it. They
    // stay out of the scene under the interim sky and compile after the world
    // near you has loaded (renderEidoverse).
    const bigDomes = new Set(skyInner?.domes ?? []);
    const warmed = new Set();
    for (const o of skyOwned) {
      if (bigDomes.has(o)) continue;
      warmed.add(o);
      // P_AMBIENT: dome warmth never queues ahead of the ground/models a
      // person is actually waiting for (warmqueue.js)
      await warm(`sky warm ${(o.name || o.type || 'dome').slice(0, 24)}`, async () => {
        scene.remove(o);
        try { await renderer.compileAsync(o, camera, scene).catch(() => {}); }
        finally { scene.add(o); }
      }, { p: P_AMBIENT });
    }
    tee(`[sky] build owns ${skyOwned.length}: ${skyOwned.map((o) => `${o.geometry?.type ?? o.type}${warmed.has(o) ? '=warmed' : '=later'}`).join(' ')}`);
    // resolveSkyWarm is renderEidoverse's (§19a): the gate waits for the first BAKE too
    phase('dome-warm');
    currentWorld = world;
    impl = 'eidoverse';
    scene.background = null;

    // The first bake + baked-dome attach happen AFTER applyLive (ensureSkyBake):
    // makeSky's weather default 'clear' OVERRIDES the cloud preset, and bakeEnv
    // keys its graph on whether clouds exist at bake time, so baking here
    // would pin a graph with NO cloud branch.
    bakePending = true;
    markPhase('sky', 1);
    bus.emit('sky-ready', { impl, world });
  }

}

// Once per build, after the log's sky verb has been applied: bake the
// environment and (on baked tiers) swap the live domes for the baked one.
let bakePending = false;
async function ensureSkyBake() {
  if (!bakePending || !skyApi) return;
  bakePending = false;
  // the tier this bake is FOR: its size and passes come from it (bakeOpts), and so must the attach below. A choice
  // made while it ran queues its own bake, which owns the attach.
  const tier = cloudQuality;
  // Environment reflections (PBR materials need scene.environment). On baked
  // tiers this same bake IS the visible sky, so it renders at the tier's
  // display resolution and full march quality.
  const gen = bakeGeneration();       // a teardown mid-bake bumps it: the strips stop, nothing attaches to a dead sky
  const api = skyApi;
  // Everything after the bake that reads the engine's target and graph (adopting the env, the attach) runs INSIDE the
  // bake lock (BAKE_AFTER), before a queued bake can swap or resize the target under the attach. Once.
  let posted = false, baked = false;
  const post = ({ ok }) => {
    if (posted) return; posted = true;
    if (ok) {
      lastBakeHours = nowHours();
      lastBakeAt = performance.now();
      if (bakeGeneration() === gen) {
        api.enableReflections?.({});
        // the engine just pointed scene.environment at ITS target — copy the
        // content into the persistent texture and put it back (see module top)
        adoptEnvironment();
      }
    }
    if (bakeGeneration() !== gen || skyApi !== api) return;   // torn down while baking: a newer build owns the sky now
    if (tier !== cloudQuality) { tee(`[sky] bake for ${tier} finished after the choice moved to ${cloudQuality}: not attached (its own bake will)`); return; }
    if (!ok && BAKED_TIERS[tier]) {
      // a failed bake left the target undrawn: attaching would show a black dome. The live march stays (a costly sky
      // beats no clouds)
      attachFailedFor = skyApi;   // or the 1 Hz render's holdLiveInHeadset re-holds them within a second
      // while the sky is still arriving, finishSky releases them once COMPILED, as on success
      if (!interimFor) releaseLiveDomes();
      // ONE retry after a pause; a second failure stays on the live march until the next choice.
      if (bakeRetriedFor !== api) {
        bakeRetriedFor = api;
        tee('[sky] bake failed: no baked dome attached, the live cloud march stays; retrying once in 10 s');
        setTimeout(() => { if (skyApi !== api || tier !== cloudQuality || bakedActive()) return; bakePending = true; ensureSkyBake().catch((e) => report('sky bake retry', e)); }, 10000);
      } else tee('[sky] bake failed again: the live cloud march stays until the next cloud choice');
      return;
    }
    if (BAKED_TIERS[tier]) {
      const { cloudPasses, intervalMs } = BAKED_TIERS[tier];
      if (!attachBakedDome(api, { cloudPasses, intervalMs, noClouds: tier === 'off' })) {
        // engine internals moved (or the bake failed): the live march is still in the scene, so the sky stays
        // correct, just expensive, in a headset too (P4). The headset hold stands down for this sky build from here on.
        attachFailedFor = api;
        if (!interimFor) releaseLiveDomes();   // while the sky is arriving, finishSky releases them once COMPILED
        console.warn('[sky] baked dome could not attach — staying on the live cloud march');
        tee('[sky] baked dome could not attach — the live cloud march stays (in a headset too)');
      } else {
        attachFailedFor = null;
        if (headsetGradient) { headsetGradient = false; hideInterimSky(); }   // the dome it stood in for is up
      }
    } else if (!interimFor) releaseLiveDomes();   // while the sky is arriving, finishSky releases them once COMPILED
  };
  try {
    // The boot bake as BANDS (sky_baked.js bandedBakeRender): bakeEnv's one full-quad renderAsync is intercepted for
    // this call only and re-issued as cost-weighted strips across frames — same material, same texels. ?skyband=0 = off.
    const opts = bakeOpts();
    let outer = renderer.getRenderTarget();
    let origRA = renderer.renderAsync;
    const band = CONFIG.params.get('skyband') !== '0' && opts.width
      && bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length > 3;
    // the decision, teed: say WHICH gate refused banding
    const strips = opts.width ? bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length - 1 : 0;
    tee(`[sky] boot bake: ${band ? 'banding' : CONFIG.params.get('skyband') !== '0' ? 'one-shot, precompiled' : 'ONE-SHOT'} (skyband=${CONFIG.params.get('skyband') ?? 'default'}, ${opts.width}x${opts.height}, passes ${opts.cloudPasses ?? 8}, ${strips} strips, inner ${skyInner ? 'yes' : 'NO'})`);
    let seen = 0;
    // ONE-SHOT bakes (a tier with no baked dome, or a bake too small to band) still compile their pipeline OFF the
    // render path first (compileAsync, as the banded path does): same bytes, same single draw, only the compile moves
    // earlier. ?skyband=0 keeps the old path untouched.
    const precompile = !band && CONFIG.params.get('skyband') !== '0';
    const interceptor = !(band || precompile) ? null : function (sc, cam) {
      if (sc !== skyInner?._envBake?.scene) { if (seen++ < 2) tee(`[sky] boot bake: a renderAsync passed through (not the bake scene: ${sc?.type ?? typeof sc}, envBake ${skyInner?._envBake ? 'set' : 'unset'})`); return origRA.call(this, sc, cam); }
      renderer.renderAsync = origRA;
      if (precompile) {
        // the bake target is bound on entry (bakeEnv) — capture it: during the await, frames run and render.js's
        // self-heal UNBINDS any target left bound at frame start, so the draw must re-bind it or it lands on the canvas
        const target = renderer.getRenderTarget();
        const t0 = performance.now();
        const compiling = renderer.compileAsync(sc, cam);   // the target is read here, at the call…
        renderer.setRenderTarget(outer ?? null);            // …so nothing stays bound while it links (frames run meanwhile)
        return compiling.catch(() => {})
          .then(() => globalThis.__syncGate?.whenGiantLinked?.())   // a deferred giant link must land before the one draw
          .then(() => { tee(`[sky] one-shot bake precompiled in ${(performance.now() - t0).toFixed(0)} ms`); renderer.setRenderTarget(target); return origRA.call(renderer, sc, cam); });
      }
      const target = renderer.getRenderTarget();
      renderer.setRenderTarget(outer ?? null);   // bakeEnv left the bake target bound; the frames between bands are the world's
      const t0 = performance.now();
      // In a headset the live domes are the full per-eye cloud march: out of the scene while the bake bands, back
      // before the baked dome attaches (which parks them). On the desktop they stay.
      const hidden = renderer.xr?.isPresenting ? (skyApi?._internals?.sky?.domes ?? []).filter((d) => d?.parent).map((d) => [d, d.parent]) : [];
      for (const [d, p] of hidden) p.remove(d);
      return bandedBakeRender(renderer, sc, cam, target, { cloudPasses: opts.cloudPasses ?? 8, passTexelBudget: BAND_BUDGET, budget: true, alive: () => bakeGeneration() === gen, sys: skyInner })
        .then((n) => { const l = `[sky] boot bake banded: ${n} bands over ${(performance.now() - t0).toFixed(0)} ms`; console.log(l); tee(l); renderer.setRenderTarget(target); })
        .finally(() => { if (bakeGeneration() === gen) for (const [d, p] of hidden) if (!d.parent) p.add(d); });   // torn down: those domes were disposed
    };
    // installed inside the bake lock, right before THIS bake runs
    const install = interceptor && (() => { origRA = renderer.renderAsync; outer = renderer.getRenderTarget(); renderer.renderAsync = interceptor;
      return () => { if (renderer.renderAsync === interceptor) renderer.renderAsync = origRA; }; });
    await api.bakeEnv?.({ ...opts, ...(install ? { [BAKE_INTERCEPT]: install } : {}), [BAKE_AFTER]: post });
    baked = true;
  } catch (e) { console.warn('sky reflections unavailable', e); tee(`[sky] boot bake failed: ${e?.message ?? e}`); }
  post({ ok: baked, skipped: false });     // no lock wrapper (engine internals moved): the same work, here
}

// Re-baking the environment map: `scene.environment` dominates every PBR
// surface, so without re-bakes the ground stays lit at the hour the sky was
// built (a starfield over noon-bright grass). The bake costs a render, so it
// is debounced and rate-limited rather than run per frame or slider tick.
let lastBakeHours = null;
let lastBakeAt = 0;
let bakeTimer = null;
const BAKE_MIN_GAP_MS = 900;
const BAKE_HOUR_DELTA = 0.25;

function scheduleEnvBake({ force = false } = {}) {
  const h = nowHours();
  if (!force && lastBakeHours !== null && Math.abs(h - lastBakeHours) < BAKE_HOUR_DELTA
      && Math.abs(h - lastBakeHours) < 12) return;    // (wrap-safe enough for a debounce)
  clearTimeout(bakeTimer);
  const wait = Math.max(0, BAKE_MIN_GAP_MS - (performance.now() - lastBakeAt));
  bakeTimer = setTimeout(runEnvBake, wait + 60);
}

async function runEnvBake() {
  if (!skyApi?.bakeEnv) return;
  // On baked tiers the crossfade loop owns the re-bake clock; a stray
  // timer must not blocking-render a full-quad bake on top of it.
  if (bakedActive()) return requestBake();
  // …nor before a baked tier's dome has attached (the interim wait): the boot bake covers env there.
  if (BAKED_TIERS[cloudQuality] || interimFor) return;
  tee(`[sky] env re-bake (${cloudQuality} tier, live env)`);
  lastBakeAt = performance.now();
  lastBakeHours = nowHours();
  const api = skyApi;
  // the same checks again INSIDE the bake lock (BAKE_GUARD): queued behind a long bake, this small bake would resize
  // the target in place right before a baked dome attached to it. The re-adopt runs inside the lock too (BAKE_AFTER).
  const stillLive = () => skyApi === api && !bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor;
  let called = false;
  const adopt = ({ ok }) => {
    if (called) return; called = true;
    if (!ok) return;
    // live tier: the engine rebaked into its own target — re-point (engine
    // reassigns) then re-adopt, so the persistent env picks up the new light
    api.enableReflections?.({});
    adoptEnvironment();
  };
  try {
    // Same opts every time — bakeEnv caches its node graph keyed on them.
    await api.bakeEnv({ ...bakeOpts(), [BAKE_GUARD]: stillLive, [BAKE_AFTER]: adopt });
    adopt({ ok: true });   // no lock wrapper (it calls adopt exactly once, skipped or not): here, as before
  } catch (e) {
    console.warn('[sky] env re-bake failed', e?.message ?? e);
  }
}

/** Settings that apply to an already-built sky — cheap, idempotent, and safe
 *  to run for every sky verb in a log AND once a second under a forecast or a
 *  rated day (see updateSky), which is why everything below is guarded to
 *  fire only on actual change. */
let forecastCursor = null;   // O(1) live ticking — the segment walk never re-runs from epoch
let appliedWeather = null;   // `state|k` last asserted on skyApi; null = fresh build
let appliedClouds = null;
let appliedColors = null;
let lastLiveHours = null;    // detects VERB-driven clock jumps (§18b)
function applyLive(a) {
  if (!skyApi) return;
  const h = nowHours();
  skyApi.setTime?.(h);
  // Baked tiers re-bake on their own cadence (which covers TOD drift too);
  // the debounced TOD bake only serves the live ('high') tier's env-IBL.
  if (!bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor) scheduleEnvBake();   // the live tier only
  let changed = false;
  // A clock JUMP (a dusk/dawn verb) asks for a bake now instead of waiting out
  // the bake cadence (§18b). Circular delta, so the midnight wrap isn't a jump.
  if (lastLiveHours !== null) {
    const d = Math.abs(h - lastLiveHours);
    if (Math.min(d, 24 - d) > 0.75) changed = true;
  }
  lastLiveHours = h;
  // An authored 'clear' flows to the setter like any other kind (the §18b
  // fence renders it as an EMPTY cumulus). Unauthored stays null.
  const clouds = cloudQuality === 'off' ? 'clear'
    : (a.clouds && CLOUDS.includes(a.clouds) ? a.clouds : null);
  if (clouds && clouds !== appliedClouds) {
    skyApi.setClouds?.(clouds);
    appliedClouds = clouds;
    changed = true;
  }
  // derived in shared/forecast.js, as the sequencer and agents do, so all agree without the server simulating
  const eff = effectiveSky(a, serverNow(), forecastCursor);
  forecastCursor = eff.cursor;
  if (eff.weather) {
    const key = `${eff.weather}|${(eff.k ?? 1).toFixed(2)}`;
    if (key !== appliedWeather) {
      const fresh = appliedWeather === null;
      if (fresh && eff.source === 'forecast' && eff.inTransition && eff.seg.prevState) {
        // mid-transition: ease over the REMAINING time, finishing when everyone else's does
        const remain = Math.max(1, (eff.seg.startMs + eff.seconds * 1000 - serverNow()) / 1000);
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, remain);
      } else if (!fresh && eff.seconds) {
        skyApi.transitionTo?.(eff.weather, eff.k ?? 1, eff.seconds);
      } else {
        skyApi.setWeather?.(eff.weather, eff.k ?? 1);
      }
      // provenance stays legible: a derived change names its policy, a manual
      // one its actor — an ambient world, but never an unattributed one
      if (eff.source === 'forecast') {
        console.info(`[weather] ${eff.weather} (forecast — policy sky seq ${eff.seq ?? '?'} by ${eff.by ?? '?'}, seg ${eff.seg.idx})`);
      } else if (eff.source === 'manual') {
        console.info(`[weather] ${eff.weather} (manual override by ${eff.by ?? '?'} — forecast resumes at next boundary)`);
      }
      appliedWeather = key;
      changed = true;
    }
  }
  if (a.colors) {
    const cKey = JSON.stringify(a.colors);
    if (cKey !== appliedColors) {
      skyApi.setColors?.(a.colors);
      appliedColors = cKey;
      changed = true;
    }
  }
  // The baked dome only changes when a bake lands: a change to the sky's look
  // asks for one now (the crossfade eases it in).
  if (bakedActive() && changed) {
    requestBake();
  }

  // Ownership boundary: makeSky drives `sun` and `hemi` itself (colour,
  // intensity, weathered fog/haze); re-deriving them would fight it. Here the
  // tuner only applies what the world owns: exposure and the lamps' day response.
  applyTuning(a, Math.max(0, Math.sin(((nowHours() - 6) / 12) * Math.PI)), undefined, null, true);
}

// ============================================================ SkyMesh fallback

async function renderSkyMesh(a) {
  const hours = nowHours();
  const { SkyMesh } = await import('three/addons/objects/SkyMesh.js');
  if (!skyMesh) {
    skyMesh = new SkyMesh();
    skyMesh.scale.setScalar(280);
    // FogExp2(0.018) over a 280-unit dome = e^-5 — the atmosphere would render
    // as pure fog colour. The sky is not IN the weather; exempt it.
    skyMesh.material.fog = false;
    skyMesh.userData.noCamCollide = true;
    scene.add(skyMesh);
  }
  impl = 'skymesh';

  const day = Math.max(0, Math.sin(((hours - 6) / 12) * Math.PI)); // 0 night → 1 noon
  const elev = -8 + 68 * day;
  const phi = THREE.MathUtils.degToRad(90 - elev);
  const theta = a.azimuth ?? Math.PI;   // radians (default 180°)
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyMesh.sunPosition.value.copy(sunPos);
  // Haze thickens as the sun drops — that's what actually paints a sunset dome;
  // a clear noon atmosphere at 13° elevation just looks grey.
  const warmth = Math.pow(1 - day, 1.5);
  skyMesh.turbidity.value = 6 + 7 * warmth;
  skyMesh.rayleigh.value = 1.6 + 1.6 * warmth;
  skyMesh.mieCoefficient.value = 0.004 + 0.012 * warmth;
  skyMesh.mieDirectionalG.value = 0.8;

  sun.position.copy(sunPos).multiplyScalar(60);
  // Light temperature follows the sun: white and hard at noon, warm and soft
  // near the horizon (a low sun that stays noon-white reads as overcast).
  sun.color.lerpColors(new THREE.Color(0xfff2e0), new THREE.Color(0xffab5e), warmth);
  hemi.color.lerpColors(new THREE.Color(0xbfd4ff), new THREE.Color(0xe0b98f), warmth * 0.85);
  hemi.groundColor.lerpColors(new THREE.Color(0x283024), new THREE.Color(0x5a4630), warmth);
  scene.background = null;

  applyTuning(a, day, warmth, sunPos);
  // every degraded/fallback route ends here — the boot gate must not wait
  // for a dome warm that will never come
  resolveSkyWarm();
}

// ============================================================ shared tuning
// The exposure/fill/fog knobs apply to whichever sky is underneath, so the
// tuner sliders behave identically on both.

function applyTuning(a, day, warmth = Math.pow(1 - day, 1.5), sunPos = null, skyOwnsLights = false) {
  if (!skyOwnsLights) {
    sun.intensity = (0.4 + 2.2 * day) * (a.sun ?? 1);
    // Low sun ≠ dark subjects: golden hour is FULL of scattered warm light.
    hemi.intensity = (0.6 + 0.4 * day) * (a.ambient ?? 1) * SHADOW_DEBUG_FILL;
    if (SHADOW_DEBUG_FILL !== 1 && scene.environment) scene.environmentIntensity = SHADOW_DEBUG_FILL;

    fillLight.color.copy(hemi.color);
    if (sunPos) {
      fillLight.position.set(-sunPos.x, Math.max(0.35, sunPos.y), -sunPos.z).multiplyScalar(60);
    } else {
      fillLight.position.copy(sun.position).multiplyScalar(-1);
      fillLight.position.y = Math.abs(fillLight.position.y);
    }
    fillLight.intensity = 0.95 * warmth * (a.fill ?? 1);

    if (scene.fog) {
      const cool = new THREE.Color().setHSL(0.6, 0.2, 0.05 + 0.5 * day);
      const warm = new THREE.Color().setHSL(0.07, 0.32, 0.04 + 0.45 * day);
      scene.fog.color.lerpColors(cool, warm, warmth);
    }
  } else {
    fillLight.intensity = 0; // the real sky supplies its own bounce
  }

  // Fog DENSITY is the world's on both paths: the real sky drives fog COLOR
  // (applyToLights), never the density.
  if (scene.fog) scene.fog.density = 0.018 * (a.fog ?? 1);

  // Exposure is the world's, not the sky's — it's the tuner's one global knob
  // and it must work identically on both implementations.
  renderer.toneMappingExposure = (skyOwnsLights ? 1 : (1.0 - 0.22 * warmth)) * (a.exposure ?? 1);

  dayness = day;
  // the rig dims lamps and placed lights on this same clock (lamp inference
  // itself lives there too — lightrig.attachLamps, requests not lights)
  setDayness(day);
}

// ---------------------------------------------------------------- per-frame

let lastClockTick = 0;
let updateFailures = 0;
export function updateSky(nowMs, t) {
  // A toolkit sky that throws from its PER-FRAME update is invisible to the
  // try/catch around construction (a black sky, a console filling at 60Hz):
  // count failures and fall back for good.
  if (impl === 'eidoverse' && skyApi?.update) {
    try {
      const r = skyApi.update(t);
      if (r && typeof r.catch === 'function') r.catch(noteSkyFailure);
      else updateFailures = 0;
    } catch (e) { noteSkyFailure(e); }
    // The sun/ambient sliders: the engine's applyToLights rewrites sun/hemi
    // intensity EVERY frame inside update(t), so a multiplier applied after it
    // neither fights nor compounds ("update, then adjust, then render").
    const a = clock?.args;
    if (a) {
      if (a.sun != null && a.sun !== 1) sun.intensity *= a.sun;
      if (a.ambient != null && a.ambient !== 1) hemi.intensity *= a.ambient;
    }
    updateBakedDome(nowMs);   // camera-follow + the band-bake/crossfade cycle
    updateInterimSky();
  }
  // A rated sky advances everyone's sun in lockstep, and a forecast needs the
  // same heartbeat to notice its segment boundaries. ~1Hz is plenty — even at
  // rate 24 the sun moves 0.1°/s, and the forecast's cursor makes each check
  // O(1) (never a re-walk from the policy epoch).
  if (skyTicks(clock?.args) && nowMs - lastClockTick > 1000) {   // a tz alone is the wall clock too
    lastClockTick = nowMs;
    render().catch((e) => report('sky clock', e));
  }
}

function noteSkyFailure(e) {
  if (impl !== 'eidoverse') return;
  if (++updateFailures < 8) return;          // tolerate a transient hiccup
  updateFailures = 0;
  const why = e?.message ?? String(e);
  console.error('[sky] per-frame failure:', why);
  // Deliberately NOT rebuilding: a per-frame fault would rebuild every few
  // frames, each stacking another atmosphere. Report once and leave the sky
  // alone; a wrong sky you can walk under beats six fighting each other.
  if (!skyFaultReported) {
    skyFaultReported = true;
    bus.emit('sky-degraded', { msg: `the sky hit a GPU fault (${why.slice(0, 70)}) — reload to retry it` });
  }
}
let skyFaultReported = false;

/** Skye's modules register per-frame hooks here (grass wind, particles). */
export function updateAutoSystems(t) {
  for (const fn of globalThis._autoParticleSystems ?? []) fn(t);
}
