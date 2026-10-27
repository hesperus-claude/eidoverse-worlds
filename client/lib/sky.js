// sky — time of day, weather, and the lighting that follows from them.
//
// Two implementations behind one verb ({hours, rate, weather, clouds, …}); the world log never sees which answers:
//   1. the toolkit's world packages (`makeSky({world})`, sky_worlds.js): raymarched atmosphere, volumetric clouds,
//      weather, baked environment reflections.
//   2. three's SkyMesh: the fallback, so a client still runs when the library moves.

import { THREE, scene, sun, hemi, renderer, camera } from './core.js';
// ?shadowdebug=1 dims the fill to a fifth so the shadow map's coverage is legible (sun shadows read only ~10% darker)
const SHADOW_DEBUG_FILL = new URLSearchParams(globalThis.location?.search ?? '').has('shadowdebug') ? 0.2 : 1;
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
import { WEATHERS, CLOUDS, effectiveSky, hoursAt } from '../../shared/forecast.js';
// the sky claims hooks by diffing a GLOBAL array around its async build; anything another subsystem marks is off limits
import { claimUnowned, releaseHook } from './autohooks.js';
import { rainSurfaceAt } from './terrain.js';

// the environment exists from the first frame (black), so every material's lighting graph is born with its env
// branch; bakes change this texture's CONTENT, never the object, because a null→texture flip recompiles every PBR material
scene.environment = envTexture();

let impl = null;           // 'eidoverse' | 'skymesh' | null
let skyApi = null;         // the toolkit's sky object when impl === 'eidoverse'
let skyInner = null;       // _internals.sky, upstream's declared escape hatch (§18b)
let skyMesh = null;
// born EAGERLY: light topology is frozen at boot (TEL0S_NOTES §12.1), and a late light recompiles every lit material.
// On the eidoverse path it idles at intensity 0.
const fillLight = new THREE.DirectionalLight(0xffffff, 0);
scene.add(fillLight);
let clock = null;          // { args, t0 } — the server-stamped epoch
let currentWorld = null;

export const skyArgs = () => clock?.args ?? {};
export const skyImpl = () => impl;
/** §22m diag: the sky-owned roots, to hide the sky's DRAW without touching its state. Read-only. */
export const skyOwnedObjects = () => skyOwned ?? [];
/** The sky draws unfogged, so it is hidden while the camera is underwater (watervolumes.js); each object gets back
 *  the visibility it had. */
const hiddenForWater = new Map();
export function hideSkyForWater(hide) {
  // every unfogged sky object, the interim gradient included
  if (hide) { for (const o of [skyMesh, ...(skyOwned ?? []), bakedDomeObject(), interimSkyObject()]) if (o && !hiddenForWater.has(o)) { hiddenForWater.set(o, o.visible); o.visible = false; } }
  else { for (const [o, v] of hiddenForWater) o.visible = v; hiddenForWater.clear(); }
}
/** 0 at night → 1 at noon. */
export let dayness = 1;

// ---------------------------------------------------------------- quality
// Tiers below 'high' show a BAKED sky (sky_baked.js), re-baked only on change; 'high' marches live.
// A client preference, never a verb: one GPU must not set everyone's sky.
export const CLOUD_QUALITY = ['off', 'low', 'medium', 'high'];
// low, medium and high construct the SAME sky system, so switching never tears it down; 'off' builds its own
const QUALITY_OPTS = {
  off: { cloudPasses: 1 },                     // plus setClouds('clear') below
  low: {},
  medium: {},
  high: {},                                    // the live march
};
// a stored 'live' (a retired fifth tier) is today's 'high'
if (localStorage.getItem('ew-cloud-quality') === 'live') localStorage.setItem('ew-cloud-quality', 'high');
// One size/pass choice PER SESSION per tier: bakeEnv keys its graph on (W, H, passes), so a change recompiles.
// intervalMs is the crossfade cadence; banded bakes make a bigger equirect cost latency, not frame rate.
const BAKED_TIERS = {
  off: { width: 1024, height: 512, cloudPasses: 1, intervalMs: 12000 },   // clear sky anyway
  low: { width: 2048, height: 1024, cloudPasses: 3, intervalMs: 12000 },
  medium: { width: 4096, height: 2048, cloudPasses: 8, intervalMs: 9000 },
};
const bakeOpts = () => {
  const { width, height, cloudPasses } = BAKED_TIERS[cloudQuality] ?? {};
  // 'off' bakes no cloud branch whatever the weather: setWeather respells the preset to cumulus under storm/rain
  return width ? { width, height, cloudPasses, ...(cloudQuality === 'off' ? { includeClouds: false } : {}) } : {};
};
let cloudQuality = localStorage.getItem('ew-cloud-quality') ?? 'medium';
const BAND_BUDGET = 0.4e6;   // texels x passes per boot-bake band (~a few ms a strip)
export const getCloudQuality = () => cloudQuality;

// VR CAP: in a WebGL headset 'high' falls back to 'medium': the per-eye live march is too slow and each eye marches its
// own noise (double vision); the baked panorama is stereo-correct. The saved choice returns on exit.
let xrPresenting = false;
let xrCappedFrom = null;          // the level the cap replaced, restored on exit
const CAP_FROM = 'high', CAP_TO = 'medium';
const vrCapApplies = () => xrPresenting && !!renderer.backend?.isWebGLBackend;
// no sky REBUILD while presenting (its compile can trip the GPU watchdog and lose the session); uniform writes apply
let heldQuality = null;           // a quality chosen in the headset, applied at exit
let heldRebuild = false;          // a sky-world switch that arrived in the headset
/** { quality, rebuild } or null. */
export const skyHeld = () => (heldQuality || heldRebuild ? { quality: heldQuality, rebuild: heldRebuild } : null);
// in a headset the live march is held out until its baked dome attaches (sky_baked holdLiveDomes); a tier with no baked
// dome, or a failed attach, keeps its march
let attachFailedFor = null;       // the sky build whose baked dome could not attach
let bakeRetriedFor = null;        // the sky build whose failed bake already had its one retry
let headsetGradient = false;      // the gradient is up because holdLiveInHeadset put it there
function holdLiveInHeadset() {
  if (!xrPresenting || !BAKED_TIERS[cloudQuality] || cloudQuality === 'off' || bakedActive() || attachFailedFor === skyApi) return;
  if (holdLiveDomes(skyApi, 'in a headset until the baked dome is ready') && !interimSkyShown()) { showInterimSky(skyInner?.uniforms); headsetGradient = true; }
}
// cleared at every entry and exit, or a quick re-entry inherits the first session's armed timer
let capWait = null;
const clearCapWait = () => { capWait?.off?.(); clearTimeout(capWait?.tm); capWait = null; };
bus.on('xr:state', (on) => {
  xrPresenting = !!on;
  clearCapWait();
  if (on) { headsetGradient = false; holdLiveInHeadset(); }
  else if (!interimFor) {
    releaseLiveDomes();   // the desktop shows the live march until its bake lands
    // the gradient only the headset needed goes with it; a swap in flight or a rebuild keeps its own
    if (headsetGradient && !swapping && !building) hideInterimSky();
  }
  headsetGradient = headsetGradient && !!on;
  // at exit: a held quality first, then a held sky-world switch once the sky is up. Under the cap, a held quality is
  // the cap's stand-in, which its restore replaces; a held world switch rides after that restore.
  if (!on && (heldQuality || heldRebuild) && !xrCappedFrom) {
    const q = heldQuality, w = heldRebuild; heldQuality = null; heldRebuild = false;
    tee(`[sky] VR exit: applying the sky change held during the session (${[q && `clouds → ${q}`, w && 'sky world'].filter(Boolean).join(', ')})`);
    const done = q ? setCloudQuality(q, { persist: false }).catch((e) => report('sky held change (exit)', e)) : Promise.resolve();
    if (w) applyHeldWorldWhenUp(done);   // both held must not drop the world
    return;
  }
  // a sky-world switch held while CAPPED survives to the cap's restore below
  const heldWorld = !on && heldRebuild && !!xrCappedFrom;
  if (!on) { heldQuality = null; heldRebuild = false; }
  // the tier running OR arriving: a desktop 'high' still pending at entry must be capped too
  if (on && vrCapApplies() && (pendingTier ?? cloudQuality) === CAP_FROM) {
    xrCappedFrom = CAP_FROM;
    if (pendingTier === CAP_FROM) pendingTier = CAP_TO === cloudQuality ? null : CAP_TO;
    tee(`[sky] VR on WebGL: clouds capped ${CAP_FROM} → ${CAP_TO} (baked) for the session (the saved choice stays ${CAP_FROM})`);
    bus.emit('cloud-cap', { from: CAP_FROM, to: CAP_TO });
    // after the entry curtain (xr.js), so the bake doesn't take the GPU before the headset's first frames; a session
    // that ended first must not drop the desktop. Only this call passes the gate: a module flag would let any pick rebuild in VR.
    const w = capWait = { off: null, tm: 0 };
    const go = () => { if (capWait !== w) return; clearCapWait(); if (!xrPresenting || xrCappedFrom !== CAP_FROM) return;
      setCloudQuality(CAP_TO, { persist: false, capFlip: true }).catch((e) => report('sky VR cap', e));
      holdLiveInHeadset();   // a re-entry during the previous cap bake must not leave the march on screen
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

// once the preceding change settled AND the sky is up, outside a headset. No forced currentWorld reset: that rebuilds
// twice and can drop the tier chosen while the sky arrived.
function applyHeldWorldWhenUp(after) {
  after.then(() => whenSkyUp()).then(() => {
    if (xrPresenting) { heldRebuild = true; return; }
    tee('[sky] VR exit: applying the sky world held during the session'); skyBuilds = 0; if (clock) render();
  });
}
/** { from, to } or null. */
export const cloudCap = () => (xrCappedFrom ? { from: xrCappedFrom, to: CAP_TO } : null);
/** What the person CHOSE, not the level the VR cap is running. The cap's memory first: choosing high in a headset
 *  holds medium, and the choice is still high. */
export const getCloudChoice = () => xrCappedFrom ?? heldQuality ?? pendingTier ?? cloudQuality;   // a choice made in the headset (or while the sky arrives) shows at once
export const skyInXR = () => xrPresenting;

// a rebuild's main-thread time per phase: wall time plus its long tasks (>50 ms; the hitch IS the long tasks), teed
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
  else if (persist && xrPresenting && xrCappedFrom) { xrCappedFrom = null; bus.emit('cloud-cap', null); }   // an uncapped choice in the headset replaces the cap's memory
  if (persist) localStorage.setItem('ew-cloud-quality', level);   // before the no-op return: re-choosing is still a choice
  // re-choosing the running tier cancels a tier queued while the sky was arriving
  if (level === cloudQuality) { heldQuality = null; if (pendingTier) { pendingTier = null; tee(`[sky] queued tier cancelled: staying ${level}`); } return; }
  if (xrPresenting && !capFlip) {   // capFlip: the VR cap's own entry flip, the one change let through
    heldQuality = level;
    tee(`[sky] clouds ${cloudQuality}→${level} held until VR exit (a rebuild in the headset stalls it for seconds)`);
    bus.emit('sky-held', { quality: level });
    return;
  }
  // a single bake retry per CHOICE, not per build: switching among low/medium/high doesn't rebuild
  bakeRetriedFor = null;
  // same system: swap what's shown, never re-link the giant programs (three's WebGL backend never frees a GL program)
  if (SAME_SYSTEM.has(cloudQuality) && SAME_SYSTEM.has(level) && skyApi && impl === 'eidoverse' && !building) {
    // still arriving: wait, THEN swap (a rebuild would throw away the cap's prebuilt program); the latest choice wins
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

// intercepting sky_system.js's globalThis.makeSkySystem assignment is the only seam that leaves the toolkit untouched
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
      // AT BIRTH, before any frame, or the ~1 MB cloud program compiles on the render path. makeSkySystem has no await
      // before its scene.add calls, so this .then runs before sky_worlds continues.
      const hold = (sy) => {
        if (sy?.domes?.length && holdLiveDomes({ _internals: { sky: sy } }, 'from birth until the real sky is ready')) showInterimSky(sy.uniforms);
        return sy;
      };
      return typeof sys?.then === 'function' ? sys.then(hold) : hold(sys);
    };
  },
  set(fn) { _realMakeSkySystem = fn; },
});

// canonical in forecast.js (shared with the sequencer fold and the mcpl agent)
export { WEATHERS, CLOUDS } from '../../shared/forecast.js';
// only `earth`: the others (~20MB geometry + a second march) can take the tab down; a log asking is coerced, not refused
export const SKY_WORLDS = ['earth'];
const KNOWN_HEAVY = ['ringworld', 'shieldworld'];

// ---------------------------------------------------------------- entry point

/** `ts`, the server stamp, makes every client's sun agree without the server simulating anything. */
export async function applySky(args = {}, ts) {
  // folded args carry their own ts; the param is for un-folded callers (the tuner's preview)
  clock = { args: { ...args }, t0: args.ts ?? ts ?? serverNow() };
  logged = { args: clock.args, t0: clock.t0 };
  previewing = false;
  await render();
}

/** The tuner's preview: same path, no new epoch. */
export async function previewSky(args) {
  clock = { args: { ...args }, t0: clock?.t0 ?? serverNow() };
  previewing = true;
  await render();
}

// What the LOG says, apart from what this client draws: a preview replaces `clock` but never `logged`.
let logged = null, previewing = false, rendering = 0;
export const loggedSky = () => logged;
export const skyPreviewing = () => previewing;
// 'sky-busy' (a stand-in gradient, a tier swap compiling) is loading too
let arriving = false;
bus.on('sky-busy', (b) => { arriving = !!b; bus.emit('sky-state'); });
// the splash ground is a bake of rainSurfaceAt around the camera: terrain or water changes re-read it over a few frames
bus.on('ground-changed', () => { skyApi?.invalidateGround?.(); });
// 'loading…' only past LOAD_SHOW_MS: 1 Hz re-renders finish in a frame, and flashing the line re-rasterises the VR panel
const LOAD_SHOW_MS = 400;
let renderSince = 0;
export const skyRendering = () => arriving || (rendering > 0 && performance.now() - renderSince >= LOAD_SHOW_MS);
export const skyDegraded = () => degrade >= 2;

function nowHours() {
  // the fold's hours-rebase uses the same formula, which keeps the sun from snapping (#29)
  return clock ? hoursAt({ ...clock.args, ts: clock.t0 }, serverNow()) : 12;
}

// how far the sky has been degraded on this GPU:
//   0 = everything on
//   1 = GPU caches off (the toolkit's LCACHE/DCACHE knobs; the light cache's textureStore isn't implemented on some layouts)
//   2 = give up, use three's SkyMesh
let degrade = 0;
// rebuilds are expensive and stack: recovery from a per-frame fault needs a hard budget
let skyBuilds = 0;
const MAX_SKY_BUILDS = 2;

// replay doesn't await render(): without this, sky verbs run CONCURRENTLY, each building its own sky
let renderChain = Promise.resolve();
function render() {
  bus.emit('sky-state');   // readers write only on change
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

  // no settle beat: sky arrival invalidates nothing (TEL0S_NOTES §12.7)
  {
    while (degrade < 2 && skyBuilds < MAX_SKY_BUILDS) {
    try {
      await renderEidoverse(a);
      return;
    } catch (e) {
      const why = e?.message ?? String(e);
      // an unsupported server is a fact, not a transient fault
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
      // the budget counts FAILURES (§18b), or a recovered boot exhausts it and stacks a SkyMesh over the working sky
      skyBuilds++;
      degrade++;
      skyApi = null;
      currentWorld = null;
    }
    }
    // budget spent, no teardown: the adopted bolt must not outlive a weather system that won't be rebuilt
    releaseForeignLights();
    impl = 'skymesh';
    // the basic sky replaces any stand-in gradient, so 'sky-busy' can't stick
    interimFor = null; hideInterimSky(); markSkyUp();
    await renderSkyMesh(a);
    markPhase('sky', 1);
  }
}

// ============================================================ the toolkit sky

// discovered from the server's listing, split by world so `earth` doesn't drag 20MB of ringworld geometry
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
    // the toolkit reads assets synchronously, so /library-list is needed first; a sequencer without it is older, no retry
    const e = new Error('this world\'s sequencer is older than this client (no /library-list) — detailed sky unavailable');
    e.skyUnsupported = true;
    throw e;
  }
  const wanted = skyFiles.map((f) => f.path).filter((p) => {
    if (p.includes('/audio/')) return wantAudio;
    // ~20MB, only for the worlds that have it
    if (p.includes('/celestial/')) return world !== 'earth';
    return true;
  });
  await primeFiles([...MODULES, ...wanted, ...particles.map((f) => f.path)]);
}

// single-flight on the in-flight PROMISE: concurrent replayed verbs would each see skyApi === null
let building = null;

// the FIRST sky's warm, single-shot, raced by the boot gate (world.applySkyFolded); later rebuilds never re-arm it
let _skyWarmResolve = null;
const _skyWarmDone = new Promise((r) => { _skyWarmResolve = r; });
function resolveSkyWarm() { _skyWarmResolve?.(); _skyWarmResolve = null; }
export const whenSkyWarm = () => _skyWarmDone;

// makeSky has no dispose: we diff the scene around the build and own the difference, or every rebuild stacks a dome
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
    // never claim what the world owns (added mid-build); world-owned roots wear skyExempt at their add site (§17c)
    && !c.userData?.entityId && !c.userData?.isBody
    && !c.userData?.skyExempt && !c.userData?.isDebug);
  // by identity, never a length mark: a hook that appeared during the async build is new but not ours
  autoSystemsOwned = claimUnowned(snap.autos);
}
function teardownSky({ rebuilding = false } = {}) {
  // a rebuild keeps a gradient up through teardown and loads, or every flip shows a black gap; a pending finishSky
  // sees skyApi change and stops
  interimFor = null; pendingTier = null; swaps.reset(); markSkyUp();   // anyone waiting for the old build: it's gone (they check skyApi)
  if (rebuilding && skyInner?.uniforms) showInterimSky(skyInner.uniforms); else hideInterimSky();
  // held domes are taken, not put back: never compiled, they must not reach the scene on the way out
  const held = takeHeldDomes();
  // release adopted lightning first: the diff can't see it, and with no replacement it holds a slot forever
  releaseForeignLights();
  // parked live domes go back first, so the disposal pass finds and frees them
  detachBakedDome();
  // §22b: the engine's own dispose is the only path to the ~64MB targets and noise; AFTER the blit, BEFORE the dome walk
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
  // only the sky's own hooks (claimSkyAdditions); everyone else's stay
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
    await building.catch(() => {});   // the current builder wins
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
  // the world first, the sky last: the cloud programs compile once the near world has loaded, a gradient standing in
  if (fresh && (holdLiveDomes(skyApi, 'until the real sky is ready') || liveDomesHeld())) {
    interimFor = skyApi;
    showInterimSky(skyInner?.uniforms);
    // at boot only, the splash waits on the VR cap's bake compile, capped at 40 s inside its 45 s ceiling
    if (!BAKED_TIERS[cloudQuality] && !bootDone()) await Promise.race([prebuildCapBake(skyApi), new Promise((r) => setTimeout(r, 40000))]);
    resolveSkyWarm();
    finishSky(skyApi).catch((e) => report('sky finish', e));
    return;
  }
  if (interimFor) return;                // the real sky is still on its way: finishSky owns the bake
  holdLiveInHeadset();                   // no live march in a headset while its bake is coming
  const bake = beginWork('sky bake');    // names the env-bake + reflections gaps
  phase('apply');
  try { await ensureSkyBake(); } finally { bake.end(); }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // a fresh build whose domes couldn't be held: nothing else hides the stand-in. Fresh only: a 1 Hz re-apply must not
  // hide a size swap's gradient.
  if (fresh) hideInterimSky();
  resolveSkyWarm();
}

async function finishSky(api) {
  phase('apply');
  await worldSettled();
  if (skyApi !== api) return;            // the newer build owns the sky
  // a tier chosen while we waited: same system, so arrive as that tier
  if (pendingTier) { tee(`[sky] arriving as ${pendingTier} (chosen while the sky was loading)`); cloudQuality = pendingTier; pendingTier = null; }
  const bake = beginWork('sky bake');
  if (!BAKED_TIERS[cloudQuality]) {
    // the live tier's env bake only lights reflections: clouds don't wait for its (minutes-long) cold link
    ensureSkyBake().catch((e) => report('sky env bake', e)).finally(() => bake.end());
  } else {
    try { await ensureSkyBake(); } finally { bake.end(); }
  }
  phase('bake');
  if (bakedActive()) await whenBakeReady();
  // no baked dome: the live domes ARE the sky; compile off the render path, then show
  if (!bakedActive() && skyApi === api) await compileLiveDomes();
  if (skyApi !== api) return;
  // a baked tier chosen WHILE they compiled: arrive as it, or the per-eye live march reaches the headset first
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
  if (!BAKED_TIERS[cloudQuality] && capPrebuiltFor !== api) prebuildCapBakeWhenHeadset(api);   // not built under the splash
}

// entering VR from high compiles medium's bake for seconds: with a headset present, prebuild it ~15 s after the sky is
// up as a 64x32 bake into a temporary target (shaders don't depend on size), cached by retainBakeGraphs
let capPrebuiltFor = null;   // the sky build whose cap program is already compiled (or compiling)
const headsetPresent = async () => { try { return !!(await navigator.xr?.isSessionSupported?.('immersive-vr')); } catch { return false; } };
async function prebuildCapBake(api) {
  if (capPrebuiltFor === api || !(await headsetPresent())) return;
  if (skyApi !== api || BAKED_TIERS[cloudQuality] || xrPresenting) return;
  capPrebuiltFor = api;
  // the guards again INSIDE the bake lock: a queued prebuild's turn can come after a VR entry
  const wanted = () => skyApi === api && !BAKED_TIERS[cloudQuality] && !xrPresenting;
  if (!(await prebuildBakeProgram(BAKED_TIERS[CAP_TO].cloudPasses, {}, wanted)) && capPrebuiltFor === api) capPrebuiltFor = null;
}
async function prebuildCapBakeWhenHeadset(api) {
  if (!(await headsetPresent())) return;
  await new Promise((r) => setTimeout(r, 15000));
  await prebuildCapBake(api);
}
/** Without touching the sky's own env target. Exported for probes. */
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
      // BAKE_HELD tells the lock's wrapper this call already holds the lock; never step the wrapper aside
      await api.bakeEnv({ width: 64, height: 32, cloudPasses, ...opts, [BAKE_HELD]: true });
    } catch (e) { ran = false; report('sky prebuild', e); }   // a failed prebuild isn't a prebuilt program
    finally {
      // the real target back NOW, not after the link wait, or reflections sample the undrawn 64x32 for minutes
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
/** Boot finished and no loading work queued, for a second in a row (at most 60 s). */
async function worldSettled() {
  const t0 = performance.now(); let calm = 0;
  while (performance.now() - t0 < 60000) {
    if (bootDone() && !loadingBusy()) { if (++calm >= 4) break; } else calm = 0;
    await new Promise((r) => setTimeout(r, 250));
  }
  teeNow(`[sky] world settled after ${((performance.now() - t0) / 1000).toFixed(1)} s: compiling the sky now`);
}
// 'sky-busy': still arriving. Heard by xr.js's entry curtain (capped at 15 s) and `arriving` (the panel's "loading…").
let swapping = 0, busyShown = false;
function announceBusy() {
  const b = interimSkyShown() || swapping > 0 || bakedRefreshing();
  if (b !== busyShown) { busyShown = b; bus.emit('sky-busy', b); }
}
bus.on('sky-interim', announceBusy);
bus.on('sky-refreshing', announceBusy);
export const skyBusy = () => busyShown;
/** Probes only. */
export const skyForProbe = () => ({ api: skyApi, sys: skyInner });
// sky_system disposes its ONE bake graph on a new key, so switching back recompiled: evicted graphs are kept, one per
// key, until teardown. ONE BAKE AT A TIME: sky_bakelock.js (tools/sky-bakelock-test.mjs).
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
// ONE SWAP AT A TIME, LATEST CHOICE WINS: sky_swapchain.js (tools/sky-swapchain-test.mjs); this does the screen work
const swaps = makeSwapChain({ inner: (from, to) => swapTierInner(from, to), want: () => cloudQuality, api: () => skyApi, log: (l) => tee(l) });
function swapTier(from) {
  swapping++; announceBusy();
  return swaps.swap(from).finally(() => { swapping--; announceBusy(); });
}
async function swapTierInner(from, to) {
  const t0 = performance.now(), api = skyApi;
  const F = BAKED_TIERS[from], T = BAKED_TIERS[to];
  // from = SHOWN_UNKNOWN (a superseded run left no tier on screen): a baked `to` takes the baked→baked path, which assumes
  // nothing about the screen; `high` takes !T, which compiles and shows the live domes from any state
  if ((F || from === SHOWN_UNKNOWN) && T) {
    // baked → baked: the old dome's texture is the target the new bake re-creates, so the gradient stands in until the
    // new dome attaches, the live march held out
    detachBakedDome();
    holdLiveDomes(skyApi, 'while the sky re-bakes at the new size');
    showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: the queued swap owns the sky, so leave the gradient/hold up.
    // 'superseded' records NO tier as shown (SHOWN_UNKNOWN), so the queued run always acts.
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
    // live → baked: the march stays on screen while the bake runs (held out in a headset), then the dome parks it
    if (xrPresenting && holdLiveDomes(skyApi, 'in a headset until the baked dome is ready')) showInterimSky(skyInner?.uniforms);
    bakePending = true;
    try { await ensureSkyBake(); } catch (e) { report('sky tier swap', e); }
    if (bakedActive()) await whenBakeReady();
    // a newer choice arrived while this baked: the queued swap owns the sky, so leave the gradient/hold up.
    // 'superseded' records NO tier as shown (SHOWN_UNKNOWN), so the queued run always acts.
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
  // compileAsync skips invisible objects: a hidden dome would link later, on the render path
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
    // the toolkit's 'balanced' (3 cloud passes) unless a world asks for 'high'
    const envKnobs = (globalThis.__ewEnv ??= {});
    envKnobs.TIER = a.quality === 'high' ? undefined : 'balanced';
    // LCACHE off unless quality:'high': its textureStore throws an uncatchable per-frame rejection on WebGPU. Only
    // LCACHE: without the density cache (CACHE) the sky renders black.
    envKnobs.CACHE = undefined;
    envKnobs.DCACHE = undefined;
    envKnobs.LCACHE = a.quality === 'high' ? undefined : '0';

    // no boot wait: arrival GATES on this build's warm (§16.2.D), so waiting would deadlock the splash
    phase('teardown');
    await primeFor(world, wantAudio);
    phase('prime');
    await loadEidoModule('sky_worlds.js');
    phase('module');
    if (typeof globalThis.makeSky !== 'function') throw new Error('sky_worlds.js exposed no makeSky');
    if (skyMesh) { scene.remove(skyMesh); skyMesh = null; }
    // a fresh build asserts state rather than easing into it
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
      audio: wantAudio,
      // splashes on the real ground, not the library's flat y=0 (an older library ignores it)
      groundHeightAt: rainSurfaceAt,
    });
    phase('makeSky');
    claimSkyAdditions(ownership);
    // ---- the clear↔cloudy fence (§18b, §19a): on cloud tiers 'clear' is an EMPTY cumulus, so the cloud graph compiles
    // once in the splash and later changes are uniform writes. 'off' keeps c0.
    skyInner = skyApi?._internals?.sky ?? null;
    retainBakeGraphs(skyInner);
    serializeBakes(skyInner);
    // held from birth, so never in the diff: claim them by identity, so a teardown still frees them
    for (const d of skyInner?.domes ?? []) if (d && !skyOwned.includes(d)) skyOwned.push(d);
    if (skyInner?.setClouds && cloudQuality !== 'off') {
      const orig = skyInner.setClouds.bind(skyInner);
      skyInner.setClouds = (kind, over) => (kind === 'clear'
        ? orig('cumulus', { ...(over ?? {}), finalMul: 0, wispOn: 0, stormCanopy: 0 })
        : orig(kind, over));
    }
    // non-dome additions warm through the conductor (§16.2.A); domes skip it (a cold link can take minutes)
    const bigDomes = new Set(skyInner?.domes ?? []);
    const warmed = new Set();
    for (const o of skyOwned) {
      if (bigDomes.has(o)) continue;
      warmed.add(o);
      // P_AMBIENT: never ahead of the ground/models a person is waiting for (warmqueue.js)
      await warm(`sky warm ${(o.name || o.type || 'dome').slice(0, 24)}`, async () => {
        scene.remove(o);
        try { await renderer.compileAsync(o, camera, scene).catch(() => {}); }
        finally { scene.add(o); }
      }, { p: P_AMBIENT });
    }
    tee(`[sky] build owns ${skyOwned.length}: ${skyOwned.map((o) => `${o.geometry?.type ?? o.type}${warmed.has(o) ? '=warmed' : '=later'}`).join(' ')}`);
    // resolveSkyWarm is in renderEidoverse (§19a): the gate waits for the first BAKE too
    phase('dome-warm');
    currentWorld = world;
    impl = 'eidoverse';
    scene.background = null;

    // the first bake waits for applyLive (ensureSkyBake): baking here pins a cloudless graph
    bakePending = true;
    markPhase('sky', 1);
    bus.emit('sky-ready', { impl, world });
  }

}

// once per build, after the sky verb applied; on baked tiers the baked dome replaces the live ones
let bakePending = false;
async function ensureSkyBake() {
  if (!bakePending || !skyApi) return;
  bakePending = false;
  // the tier this bake is FOR sets size, passes and the attach; a choice made while it ran queues its own bake
  const tier = cloudQuality;
  // bakeEnv takes ONE options bag; on baked tiers this bake IS the visible sky (display size, full march)
  const gen = bakeGeneration();       // a teardown bumps it: nothing attaches to a dead sky
  const api = skyApi;
  // whatever reads the engine's target after the bake runs INSIDE the lock (BAKE_AFTER): after it, a queued bake can
  // swap or resize that target. Once.
  let posted = false, baked = false;
  const post = ({ ok }) => {
    if (posted) return; posted = true;
    if (ok) {
      lastBakeHours = nowHours();
      lastBakeAt = performance.now();
      if (bakeGeneration() === gen) {
        api.enableReflections?.({});
        // copy the engine's target into the persistent texture and put it back (module top)
        adoptEnvironment();
      }
    }
    if (bakeGeneration() !== gen || skyApi !== api) return;   // a newer build owns the sky
    if (tier !== cloudQuality) { tee(`[sky] bake for ${tier} finished after the choice moved to ${cloudQuality}: not attached (its own bake will)`); return; }
    if (!ok && BAKED_TIERS[tier]) {
      // a failed bake would attach a black dome: the live march stays (a costly sky beats no clouds)
      attachFailedFor = skyApi;   // or the 1 Hz render's holdLiveInHeadset re-holds them within a second
      // while the sky is still arriving, finishSky releases them once COMPILED
      if (!interimFor) releaseLiveDomes();
      // ONE retry after a pause; a second failure stays on the live march until the next choice
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
        // engine internals moved: the live march stays, headset too, and the headset hold stands down for this build
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
    // the boot bake as BANDS (sky_baked.js bandedBakeRender): cost-weighted strips across frames, same texels. ?skyband=0 = off.
    const opts = bakeOpts();
    let outer = renderer.getRenderTarget();
    let origRA = renderer.renderAsync;
    const band = CONFIG.params.get('skyband') !== '0' && opts.width
      && bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length > 3;
    // teed: say WHICH gate refused banding
    const strips = opts.width ? bandCuts(opts.width, opts.height, opts.cloudPasses ?? 8, BAND_BUDGET).length - 1 : 0;
    tee(`[sky] boot bake: ${band ? 'banding' : CONFIG.params.get('skyband') !== '0' ? 'one-shot, precompiled' : 'ONE-SHOT'} (skyband=${CONFIG.params.get('skyband') ?? 'default'}, ${opts.width}x${opts.height}, passes ${opts.cloudPasses ?? 8}, ${strips} strips, inner ${skyInner ? 'yes' : 'NO'})`);
    let seen = 0;
    // one-shot bakes still compile OFF the render path first; ?skyband=0 keeps the old path
    const precompile = !band && CONFIG.params.get('skyband') !== '0';
    const interceptor = !(band || precompile) ? null : function (sc, cam) {
      if (sc !== skyInner?._envBake?.scene) { if (seen++ < 2) tee(`[sky] boot bake: a renderAsync passed through (not the bake scene: ${sc?.type ?? typeof sc}, envBake ${skyInner?._envBake ? 'set' : 'unset'})`); return origRA.call(this, sc, cam); }
      renderer.renderAsync = origRA;
      if (precompile) {
        // capture the bound target: render.js's self-heal UNBINDS it between frames, so the draw must re-bind it
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
      // in a headset the live domes leave the scene while it bands (the per-eye march the VR cap avoids); desktop keeps them
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

// bakeEnv runs once at construction, so without this the IBL keeps the build-time hour; debounced and rate-limited
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
  // on baked tiers the crossfade loop owns the re-bake clock
  if (bakedActive()) return requestBake();
  // …even before its dome attaches: this synchronous bake can freeze the GPU and leave the first target black
  if (BAKED_TIERS[cloudQuality] || interimFor) return;
  tee(`[sky] env re-bake (${cloudQuality} tier, live env)`);
  lastBakeAt = performance.now();
  lastBakeHours = nowHours();
  const api = skyApi;
  // the checks again INSIDE the lock (BAKE_GUARD), or a queued bake resizes a target a dome is about to attach to;
  // the re-adopt runs inside it too (BAKE_AFTER)
  const stillLive = () => skyApi === api && !bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor;
  let called = false;
  const adopt = ({ ok }) => {
    if (called) return; called = true;
    if (!ok) return;
    // live tier: re-point then re-adopt, so the persistent env picks up the new light
    api.enableReflections?.({});
    adoptEnvironment();
  };
  try {
    // same opts every time: bakeEnv keys its graph on them
    await api.bakeEnv({ ...bakeOpts(), [BAKE_GUARD]: stillLive, [BAKE_AFTER]: adopt });
    adopt({ ok: true });   // no lock wrapper (it calls adopt exactly once, skipped or not)
  } catch (e) {
    console.warn('[sky] env re-bake failed', e?.message ?? e);
  }
}

/** Runs per sky verb and once a second (updateSky), so everything below fires only on actual change. */
let forecastCursor = null;   // O(1) live ticking — the segment walk never re-runs from epoch
let appliedWeather = null;   // `state|k` last asserted on skyApi; null = fresh build
let appliedClouds = null;
let appliedColors = null;
let lastLiveHours = null;    // detects VERB-driven clock jumps (§18b)
function applyLive(a) {
  if (!skyApi) return;
  const h = nowHours();
  skyApi.setTime?.(h);
  // baked tiers re-bake on their own cadence
  if (!bakedActive() && !BAKED_TIERS[cloudQuality] && !interimFor) scheduleEnvBake();   // the live tier only
  let changed = false;
  // a clock JUMP asks for a bake now (§18b); circular delta so midnight's wrap isn't a jump, and 1Hz drift stays under it
  if (lastLiveHours !== null) {
    const d = Math.abs(h - lastLiveHours);
    if (Math.min(d, 24 - d) > 0.75) changed = true;
  }
  lastLiveHours = h;
  // an authored 'clear' goes to the setter like any kind (§18b fence); unauthored stays null
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
      // a derived change names its policy, a manual one its actor: never unattributed
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
  // the baked dome changes only when a bake lands: a look change asks for one now
  if (bakedActive() && changed) {
    requestBake();
  }

  // makeSky drives `sun` and `hemi` itself: this applies only what the world owns (exposure, lamps)
  applyTuning(a, Math.max(0, Math.sin(((nowHours() - 6) / 12) * Math.PI)), undefined, null, true);
}

// ============================================================ SkyMesh fallback

async function renderSkyMesh(a) {
  const hours = nowHours();
  const { SkyMesh } = await import('three/addons/objects/SkyMesh.js');
  if (!skyMesh) {
    skyMesh = new SkyMesh();
    skyMesh.scale.setScalar(280);
    // FogExp2(0.018) over a 280-unit dome = e^-5, pure fog colour: exempt the sky
    skyMesh.material.fog = false;
    skyMesh.userData.noCamCollide = true;
    scene.add(skyMesh);
  }
  impl = 'skymesh';

  const day = Math.max(0, Math.sin(((hours - 6) / 12) * Math.PI)); // 0 night → 1 noon
  const elev = -8 + 68 * day;
  const phi = THREE.MathUtils.degToRad(90 - elev);
  const theta = a.azimuth ?? Math.PI;   // radians
  const sunPos = new THREE.Vector3().setFromSphericalCoords(1, phi, theta);
  skyMesh.sunPosition.value.copy(sunPos);
  // haze thickens as the sun drops: a clear noon atmosphere at 13° just looks grey
  const warmth = Math.pow(1 - day, 1.5);
  skyMesh.turbidity.value = 6 + 7 * warmth;
  skyMesh.rayleigh.value = 1.6 + 1.6 * warmth;
  skyMesh.mieCoefficient.value = 0.004 + 0.012 * warmth;
  skyMesh.mieDirectionalG.value = 0.8;

  sun.position.copy(sunPos).multiplyScalar(60);
  // a low sun that stays noon-white reads as overcast
  sun.color.lerpColors(new THREE.Color(0xfff2e0), new THREE.Color(0xffab5e), warmth);
  hemi.color.lerpColors(new THREE.Color(0xbfd4ff), new THREE.Color(0xe0b98f), warmth * 0.85);
  hemi.groundColor.lerpColors(new THREE.Color(0x283024), new THREE.Color(0x5a4630), warmth);
  scene.background = null;

  applyTuning(a, day, warmth, sunPos);
  // every fallback ends here: the boot gate must not wait for a dome warm that never comes
  resolveSkyWarm();
}

// ============================================================ shared tuning
// these knobs apply to whichever sky is underneath, so the tuner behaves identically on both

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
    fillLight.intensity = 0; // the real sky supplies its own
  }

  // fog DENSITY is the world's on both paths; the real sky drives only its COLOR (§12.6)
  if (scene.fog) scene.fog.density = 0.018 * (a.fog ?? 1);

  // exposure is the world's, not the sky's: one global knob on both
  renderer.toneMappingExposure = (skyOwnsLights ? 1 : (1.0 - 0.22 * warmth)) * (a.exposure ?? 1);

  dayness = day;
  // the rig dims lamps on this clock (lightrig.attachLamps)
  setDayness(day);
}

// ---------------------------------------------------------------- per-frame

let lastClockTick = 0;
let updateFailures = 0;
export function updateSky(nowMs, t) {
  // a per-frame throw is invisible to construction's try/catch: count and fall back for good
  if (impl === 'eidoverse' && skyApi?.update) {
    try {
      const r = skyApi.update(t);
      if (r && typeof r.catch === 'function') r.catch(noteSkyFailure);
      else updateFailures = 0;
    } catch (e) { noteSkyFailure(e); }
    // sun/ambient sliders: applyToLights rewrites intensity every frame inside update(t), so a multiplier applied after
    // it neither fights nor compounds
    const a = clock?.args;
    if (a) {
      if (a.sun != null && a.sun !== 1) sun.intensity *= a.sun;
      if (a.ambient != null && a.ambient !== 1) hemi.intensity *= a.ambient;
    }
    updateBakedDome(nowMs);   // camera-follow + the band-bake/crossfade cycle
    updateInterimSky();
  }
  // ~1 Hz is enough (at rate 24 the sun moves 0.1°/s); the cursor keeps each check O(1)
  if (((clock?.args.rate ?? 0) !== 0 || clock?.args.clock === 'real' || clock?.args.forecast) && nowMs - lastClockTick > 1000) {
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
  // deliberately NOT rebuilding: a per-frame fault would rebuild every few frames, stacking atmospheres; report once
  if (!skyFaultReported) {
    skyFaultReported = true;
    bus.emit('sky-degraded', { msg: `the sky hit a GPU fault (${why.slice(0, 70)}) — reload to retry it` });
  }
}
let skyFaultReported = false;

/** The toolkit's modules register per-frame hooks here (grass wind, particles). */
export function updateAutoSystems(t) {
  for (const fn of globalThis._autoParticleSystems ?? []) fn(t);
}
