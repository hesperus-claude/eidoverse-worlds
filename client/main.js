// eidoverse-worlds browser client: the boot sequence and the frame system LIST; every system lives in lib/ (§14 6c).
// Two planes: the world log (ordered, replayed on join) and presence (~15 Hz, interpolated); the server sequences and relays.
// the underwater view (#254); water volumes, air boxes and environments (#248) wait for their components (PROTOCOL §4)
import { updateWater, updateWaterView, setWaterObjects, setWaterClock, setSkyHider, environmentSettings, waterDebug, applyEnvLight } from './lib/watervolumes.js';

import { say } from './lib/net.js';
import { chooseClient } from './lib/litechoice.js';
import { THREE, scene, camera, renderer, canvas } from './lib/core.js';
import { releaseBodyGate, armBodyGate } from './lib/bodygate.js';
import { CONFIG, bus, report, tee, colorFor, emptyWorldNotice } from './lib/base.js';
import { versionReady } from './lib/version.js';
import { contributeThumbnail, makeAvatar, makeCapsuleAvatar, ANIM_ORDER } from './lib/avatar.js';
import { updateSky, updateAutoSystems, skyArgs, setCloudQuality, hideSkyForWater } from './lib/sky.js';
import { setSkyArgsSource, entities, buildsPending, anyBuildsPending, avatarMounts, roleOf, worldHasOwner, bagOf, bags, seatSocket, socketsOn, currentTerrainArgs, terrainEditBase, noteTerrainSent, terrainPending } from './lib/world.js';
import { presence } from './lib/presence.js';
import { initWorldQuad } from './lib/worldquad.js';
import { foldParity } from './lib/parity.js';
import { initModelsRealizer, reconcileModels, residencyDebug, setResidencyFocus, drainPromoteTail } from './lib/realize/models.js';
import { initEnvironmentRealizer } from './lib/realize/environment.js';
import { initSocialRealizer } from './lib/realize/social.js';
import { initStructureRealizer } from './lib/realize/structure.js';
import { initStructureUI } from './lib/structure_ui.js';
import { initCauses } from './lib/realize/livechat.js';
// side-effecting: these hosts wire themselves to the comp and entity buses on import
import './lib/emitters.js';
import './lib/pictures.js';
import { tickSounds } from './lib/sounds.js';
import { tickMotion } from './lib/motion.js';
import { tickLookAt } from './lib/lookats.js';   // after motion: it moves, then it turns
import { tickTexts } from './lib/texts.js';
import { tickOpenables } from './lib/openable.js';
import {
  myState, updateMe, updateSpectator, setCamYaw, setPosture, togglePhotoMode,
  setRightsHook, setMeHook, setFolded, photoMode, setBoundsHook, flying as flyingNow, capSpeed,
} from './lib/controller.js';
import { initUsePrompt } from './lib/useprompt.js';
import { initClickUse, clickUseApi } from './lib/clickuse.js';
import { remotes, updateRemotes, updateGaze, serverNow } from './lib/remotes.js';
import { initOccupants } from './lib/occupants.js';
// net.js takes the participant registry by injection (lite.js has no bodies); this is the body-building one
import * as participants from './lib/remotes.js';
import { capture, setSnapReadiness } from './lib/net_capture.js';
import { setWaveClock } from './lib/water.js';
import { myReachBag } from './lib/reachnet.js';
import {
  replica, net, connect, initIdentity, loginUrl, wireNet, sendRequest, sendPose, sendTyping,
  setPoseOverride, sendPuppet, sendAnim, builtIn,
} from './lib/net.js';
import { poseCommands } from './lib/posecommands.js';
import { updateBuild, toggleEditMode, isEditing, editSurface } from './lib/build.js';
// the authority's build switch, else the role (an older server); unknown = no
const mayBuildStrict = () => (Array.isArray(net.myRights?.permissions) ? net.myRights.permissions.includes('build') : isOwner(net.myRights));
import { initPalette } from './lib/catalog.js';
import { initConjure } from './lib/generate.js';
import { state as worldState } from './lib/state.js';
import { micLive, earOn } from './lib/mictoggle.js'; // both off by default
import { initAudioPanel } from './lib/audiopanel.js';
import { initSceneGraph, sceneSelect } from './lib/scenegraph.js';
import { initEditPanels } from './lib/editpanels.js';
import { initEditLayout } from './lib/editlayout.js';
import { initGizmo } from './lib/gizmo.js';
import { initGripEdit } from './lib/gripedit.js';
import { initMaterialOverrides } from './lib/matoverride.js';
import { initWorldEdge } from './lib/edge.js';
import { initXR, updateXR, bindXRSelf, isPresenting } from './lib/xr.js';
import { initPeople, personOf, isPhone, menuAt as personMenuAt, sheetFor as personSheet, stripFor as personStrip, badgeHtml as personBadge } from './lib/people.js';
import { initRolesPanels, openModeration } from './lib/rolespanels.js';
import { tickXRMirror } from './lib/xrmirror.js';
import { ensureXRBodyHook, bindXRBodySelf, xrAvatarYaw, xrLookPitch, xrWire, xrSimActive } from './lib/xrbody.js';
import { tickXRVignette } from './lib/xrvignette.js';
import { initVRPanel } from './lib/vrpanel.js';
import { trySitOn as xrTrySitOn, dismountMe as xrDismountMe } from './lib/localbody.js';
import {
  toast, flashHint, buildHelp, toggleHelp,
  openDoor, togglePeopleHere, initDock, paintPresence, panelFrame, settingsFrame, setLoadingItems, setMenuSources,
} from './lib/ui.js';
import { registerXRPanel } from './lib/xrpanels.js';
import { initDebug, updateDebug, toggleDebug } from './lib/debug.js';

// which server build: one console line at boot
versionReady.then((v) => console.log(v ? `[eidoverse] server build ${v.sha}${v.dirty === true ? ' (DIRTY TREE)' : v.dirty === false ? '' : ' (dirty: unknown)'} (code from ${v.commitTime}), up since ${v.startedAt}` : '[eidoverse] server build unknown (/version unavailable)'));
import { dragSim, updateBodyDrag, dragState } from './lib/bodydrag.js';
import { initChat, logChat, chatXRPanel, mentionPerson } from './lib/chat.js';
import { initPlates, updatePlates } from './lib/platecard.js';
import { bodyEngine, setBodyEngine, listBodyEngines } from './lib/bodysim.js';
import { initThingPhysics, physicsApi, simShown } from './lib/thingphysics.js';
import { initMods, tickMods, modsApi } from './lib/mods.js';
import { initBoot, markPhase, finishBoot, bootDone, setBootAssets } from './lib/boot.js';
import { protoStats, forgetBytes, loadingItems, bootBytes } from './lib/assets.js';
import { grassTiles, heightAt, hasTerrain } from './lib/terrain.js';
import { grassDiag } from './lib/grassdiag.js';
import { warmStats } from './lib/warmqueue.js';
import { budgetStats } from './lib/framebudget.js';
import { pending, P, onIdle, laneStats as schedLaneStats } from './lib/scheduler.js';
import { laneStats as loadLaneStats } from './lib/loadwork.js';
import { colliderCacheStats } from './lib/colliders.js';
import { statusChip } from './lib/statuschips.js';
import { governPerformance, governorDebug, whenCalm, applyPendingPixelRatio } from './lib/governor.js';
import { registerSystem, startFrame, frameDebug } from './lib/frameloop.js';
import { perf } from './lib/perf.js';
import { renderWorld, drawStats, setDrawBatching } from './lib/render.js';
import { paintHud } from './lib/hud.js';
import { updateMaterials, materialsDebug } from './lib/materials.js';
import { updateRig, rigDebug, setLampShadow, lampShadowState } from './lib/lightrig.js';
import { startPrefetch } from './lib/prefetch.js';
import {
  getMe, setMe, getMyAvatarPath, getMyAvatarName, resolveMyAvatarPath,
  rosterLazy, chooseAvatar, announceWorn } from './lib/mybody.js';
import {
  initLocalBody, isDowned, activeRagdoll, goLimp, getUp,
  stepRagdoll, updateMountedMe, updateSeatHint, seatLeaving,
} from './lib/localbody.js';
import { posable, pushable, setPosable, setPushable } from './lib/consent.js';
import { updateVoiceMouths } from './lib/voicemouths.js';
import { initActionBar } from './lib/actionbar.js';
import { initXRKeyboard } from './lib/xrkeyboard.js';
import { initXRAsk } from './lib/xrask.js';
import { initCommands, saveScreenshot } from './lib/commands/handlers.js';
import { register as registerAction } from './lib/actions.js';
import { initLantern } from './lib/commandbar.js';
import { deriveLandmarks, debugMarkers, landmarkWorld } from './lib/landmarks.js';
import { measureChain, solveChain } from './lib/reachbone.js';
import { canonicalPoint } from '../shared/contact.js';
import { initReachNet, setMyReach, clearMyReach } from './lib/reachnet.js';
import { foldedIn } from '../shared/wingpresence.js';
import { readBodyMode } from '../shared/bodymode.js';
import { isOwner } from '../shared/protocol/roles.js';

if (CONFIG.params.has('mintthumbs')) {
  // ?mintthumbs: seed the roster's portraits, then stop (lib/portraits.js). The else below is the entire normal boot.
  await (await import('./lib/portraits.js')).mintThumbnails();
} else {

const isViewer = CONFIG.spectate || CONFIG.renderer;

// ---------------------------------------------------------------- lighting
// the sun shadow is set in the light rig (lightrig.js §12.5) before the first compile: shadowMap is pipeline-shape

setSkyArgsSource(skyArgs);
setResidencyFocus(() => myState?.pos ?? null);   // the body anchors residency too (§13.3)
// a renderer snapshots only once the world is realized around the body it follows (net_capture.js settle).
// Warming shaders don't block: a stall, never a missing object.
setSnapReadiness(async (follow) => {
  const r = residencyDebug(), warm = warmStats();
  const body = !!remotes.get(follow)?.avatar, builds = anyBuildsPending();
  return { ready: body && !builds && !r.loading && !r.standins, body, builds, models: r.real,
    loading: r.loading + r.standins, compiling: warm.pending + (warm.running ? 1 : 0) };
});
// before connect(), so the very first snapshot's hydrated event finds them listening
initModelsRealizer();
initEnvironmentRealizer();
initSocialRealizer();
// structure AFTER models: it hides the object the models realizer made for a building's anchor
initStructureRealizer();
initStructureUI();
initCauses();
// ---------------------------------------------------------------- boot

initBoot({ world: CONFIG.world, name: CONFIG.name });
buildHelp();
const chatApi = initChat({
  send: (text) => say(text),
  typing: (to) => { sendTyping(to); getMe()?.setTyping(); },
  people,
  // the person menu and badges
  person: { menuAt: personMenuAt, sheetFor: personSheet, stripFor: personStrip, badgeHtml: personBadge, muted: (n) => personOf(n).muted, presenting: () => isPresenting() },
});
initPeople({ mentionPerson, presenting: () => isPresenting(), toast, openModLog: (who) => openModeration({ tab: 'log', who }) });
initRolesPanels();
// Ctrl/Cmd+K: actions from lib/actions.js, speech and /commands through chat's own submit
initLantern({ submit: chatApi.submit });
initActionBar();
initXRKeyboard();   // types into the last-focused text input; a quad in VR
initXRAsk();        // the centre card is DOM-only: this puts it on a quad in VR
initWorldQuad();
initVRPanel();
settingsFrame();               // exists (hidden) so the ∃ menu can open it
initDock([
  { id: 'chat', label: '💬' },
  { id: 'world', label: '🧱' },
  { id: 'actions', label: '👋' },
  { id: 'debug', label: '🐞' },
  { id: 'settings', label: '⚙️', icon: 'gear-six' },
  // edit is a MODE, not a window. Its gate reads net.myRights: an operator owns every world but isn't in the fold's roles
  {
    id: 'edit', label: '🔧', icon: 'wrench', last: true,
    action: toggleEditMode,
    active: () => isEditing(),
    // while editing, the wrench is THE way out
    title: (on) => (on ? 'leave builder mode (B)' : null),
    gate: () => editSurface() && mayBuildStrict(),   // no edit mode on a phone
    deadWhy: () => (editSurface() ? null : ' — builder mode is for a desktop or tablet'),
  },
]);
// Save/Load under the wrench's gate
setMenuSources({ buildRights: () => editSurface() && mayBuildStrict(), loginUrl: () => loginUrl() });
paintPresence(presence());            // the dot needs the button: after initDock
bus.on('presence:me', paintPresence);
initDebug({
  // the body in your HAND wins over your own
  ragdoll: () => dragSim() ?? activeRagdoll(),
  downed: () => !!dragSim() || isDowned(),
  dragging: () => !!dragSim(),
  fps: () => perf.fps,
  perf: () => perf,          // fps + frame ms + worst-of-last-second
  bill: frameDebug,          // per-system EWMA ms
  // drop again from where you stand, so a shape reproduces back to back
  reLimp: () => { if (isDowned()) getUp(); goLimp(); },
});
// BEFORE start() opens the socket: sendJoin claims the renderer role only when one is wired, and nothing else enforces it
wireNet({ capture });
// BEFORE anything reads CONFIG.name, or the door and nameplate greet a stale localStorage name
await initIdentity();

// the splash waits for the body to SETTLE (on screen, or failed), never for a body to exist
let bodySettled = false;
if (isViewer) releaseBodyGate('viewer — no body expected'); else armBodyGate();   // the world's parses wait for the body (assets.js)
if (isViewer) {
  panelFrame().hide();
  bodySettled = true;
  markPhase('body', 1);
  start();
} else {
  // ask once for a name and a body, never again; ?door=1 re-opens it
  const firstRun = CONFIG.params.has('door') || (!CONFIG.params.has('name') && localStorage.getItem('ew-name-set') !== '1');
  if (firstRun) {
    // the door is an interactive pause, so its roster fetch is lazy
    rosterLazy().then((roster) => openDoor({
      roster,
      needsKey: CONFIG.params.has('needkey'),
      login: loginUrl(),
      onEnter: ({ avatar, avatarName }) => {
        if (avatar) chooseAvatar(avatar, avatarName, { remember: true });
        start();
      },
    }));
  } else start();
}


// ?sendlayout=1: tee this browser's panel layout and viewport, so a hand-arranged layout can be baked in as the default
if (CONFIG.params.has('sendlayout')) {
  bus.on('booted', () => setTimeout(() => {
    const frames = {};
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k?.startsWith('ew-frame-')) { try { frames[k.slice(9)] = JSON.parse(localStorage.getItem(k)); } catch { /* skip a bad row */ } }
    }
    tee(`[layout] ${JSON.stringify({ vw: innerWidth, vh: innerHeight, dpr: devicePixelRatio, locked: localStorage.getItem('ew-ui-locked') === '1', frames })}`);
    toast?.(`layout sent — ${Object.keys(frames).length} panels`, 'info', 4000);
  }, 1500));
}

// a stalled desktop boot is NOT demoted (index.html decideLite, 'retry'): it says so, lite one press away
if (globalThis.__ewLiteWhy === 'retry') statusChip({
  id: 'lite-retry', level: 'attn', label: 'last load stalled',
  title: "This world didn't finish loading last time",
  body: "We're trying the full 3D world again. If it keeps stalling or crashing here, the lite client has chat, the action bar and who's here, with no 3D.",
  actions: [{ label: 'switch to the lite client', run: () => chooseClient(true) }, { label: 'stay in 3D', clear: true }],
});

// re-open the door with a key field, not retry into a wall forever
bus.on('bad-key', () => {
  toast('that door key was refused', 'err', 20000);
  rosterLazy().then((roster) => openDoor({
    roster, needsKey: true, login: loginUrl(),
    onEnter: ({ avatar, avatarName }) => {
      if (avatar) chooseAvatar(avatar, avatarName);
      connect();
    },
  }));
});

function start() {
  connect();
  initPalette();
  initConjure();   // prompt → your pick of images → mesh → world
  // ONE TRANSPORT, EXACTLY ONE PLAYBACK OWNER (#104 amendment 6): the SFU is the only voice path, not a flag, so a second owner can't initialise.
  // A failed cutover rolls back by release (notes/CUTOVER-ROLLBACK.md), not a branch.
  window.__voiceTransport = 'pending:sfu';
  import('./lib/voicesfubridge.js').then((m) => { m.initVoiceSfu(CONFIG.name); window.__voiceTransport = 'sfu'; })
    .catch((e) => { window.__voiceTransport = 'failed:sfu'; window.__voiceTransportError = String(e); console.error('voice init failed', e); });
  initAudioPanel();
  // own says in your voice: installed for everyone (speakOwnSays gates); the identity is the log's actor id, not the avatar
  import('./lib/tts.js')
    // net.myId is the server's settled name (auth rename, duplicate suffix)
    .then((vs) => vs.speakOwnSays(bus, () => net.myId || CONFIG.name))
    .catch((e) => console.warn('[voice] own-say hook not installed:', e));
  initSceneGraph();
  // desktop frames and VR quads from the same declaration
  const editPanels = initEditPanels();
  bus.on('edit-mode', (on) => editPanels.show(!!on));
  initGizmo();
  initGripEdit();     // a ghost hand and its handles, opened from the grabbable card
  initMaterialOverrides();   // the draft hesperus/material reader (docs/COMPONENT-LADDER.md)
  initWorldEdge();           // @world.bounds drawn as a fence
  initEditLayout();   // AFTER show, so it docks visible frames

  if (!isViewer) {
    // A body is never optional: if the chosen one fails, wear the default and SAY SO, clearing the stale cache.
    const DEFAULT_BODY = 'eidoverse/assets/vrms/claude.vrm';
    // ?capsule=1: refuse every body load, so the REAL fallback chain runs end to end
    const wear = (path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(CONFIG.name, path, { urgent: true });   // your body skips the load queue
    resolveMyAvatarPath()
      .then((path) => wear(path).then((av) => ({ av, path })).catch((e) => {
        report('avatar', e);
        // the capsule is the floor: a body that needs no network, for when chosen and default both fail
        const capsule = () => { toast('no body would load — wearing the capsule until one does. Pick another in Profile.', 'warn', 12000); tee('[body] capsule stand-in (chosen + default failed)'); return { av: makeCapsuleAvatar(CONFIG.name), path: 'capsule' }; };
        if (String(path).startsWith(DEFAULT_BODY)) return capsule();
        try { localStorage.removeItem('ew-avatar-path'); } catch { /* private mode */ }
        toast(`your body (${getMyAvatarName()}) failed to load — wearing the default. Pick another in Profile.`, 'warn', 9000);
        chooseAvatar(DEFAULT_BODY, 'claude');
        return wear(DEFAULT_BODY).then((av) => ({ av, path: DEFAULT_BODY })).catch((e2) => { report('avatar default', e2); return capsule(); });      }))
      .then(({ av, path }) => {
        setMe(av);
        if (!av.isCapsule) announceWorn(path.split('/').pop().replace(/\.vrm.*$/, ''), path);   // not a stale ew-avatar-name
        bodySettled = true;
        markPhase('body', 1);
        // deferred until calm: a portrait costs an offscreen compile burst (§16.1g)
        if (!av.isCapsule) whenCalm().then(() => contributeThumbnail(getMyAvatarName(), av.vrm, CONFIG.token, { path: getMyAvatarPath() }));
      })
      .catch((e) => { bodySettled = true; markPhase('body', 1); report('avatar', e); releaseBodyGate('body failed — the world must not wait'); checkReady(); });
  }
}

// injected so ui.js and chat.js stay shareable with the renderer-less client
setLoadingItems(loadingItems);
setBootAssets({ items: loadingItems, bytes: bootBytes });
registerXRPanel(chatXRPanel);

let restoredPosition = false;
wireNet({
  participants,
  myReachBag,
  toast,
  forgetBytes,    // the asset ledger
  // (capture is wired above, before start(): sendJoin reads it)
  myAvatarPath: () => getMyAvatarPath(),   // a bare name: the server resolves
  myState,
  me: () => getMe(),
  myVoice: () => ({ mic: micLive(), hear: earOn() }),   // rides presence
  onRestore: (r) => {
    // a remembered NaN is stored as null (JSON has no NaN): only finite numbers are a place, else the origin
    const fin = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
    restoredPosition = true;
    myState.q = r.q; myState.locomotion = r.locomotion;
    myState.pos.set(fin(r.p[0]), fin(r.p[1]), fin(r.p[2]));
    myState.yaw = r.yaw ?? 0;
    setCamYaw(myState.yaw + Math.PI); // camera behind you, facing your way
    { const m = readBodyMode(r); if (m === 'sit' || m === 'lie') setPosture(m); }   // an older sample: read off its clip
    // wake holding an enacted pose (authored content); a remembered ragdoll frame is wreckage, so wake standing
    if (r.clip === 'ragdoll') { myState.pos.y = 0; return; }
    if (r.pose) myState.pose = r.pose;
    setFolded(foldedIn(r) === true);   // the named pose wings-folded (or the older wingsFolded)
  },
  onSnapshotDone: () => {},
});

bus.on('sky-degraded', ({ msg }) => toast(msg, 'warn', 12000));

initOccupants();   // seat-profile verdicts (#101)

// ---------------------------------------------------------------- my body
// the avatar swap is mybody.js; a body's physics localbody.js (§14.2)

// wired here because net.js must not import the controller; losing fly grounds a body already in the air
setRightsHook(() => net.myRights);
setMeHook(() => getMe());

setBoundsHook(() => replica.st?.entities?.['@world']?.c?.bounds ?? null);
initThingPhysics({ aim: () => clickUseApi.aimPoint(), myPos: () => myState.pos, me: () => getMe(), camera, editing: () => isEditing(), seated: () => !!myState.seat || !!avatarMounts.get(CONFIG.name)?.to, myState: () => myState, flying: () => flyingNow(), capSpeed: (v, ms) => capSpeed(v, ms), mounts: () => avatarMounts });
initUsePrompt({ myPos: () => myState.pos, camera, editing: () => isEditing(), busy: () => photoMode || isDowned() });   // E
initClickUse({ editing: () => isEditing(), busy: () => photoMode || isDowned(), myPos: () => myState.pos });   // left-click primary use, right-click menu
// reach descriptors resolve against the same bodies everyone renders
initReachNet({
  me: () => getMe(),
  myId: () => CONFIG.name,
  avatarOf: (id) => (id === CONFIG.name ? getMe() : remotes.get(id)?.avatar ?? null),
});
initMods();   // your local trusted mods only: a world's code is its server-side scripts
initLocalBody({ logChat });
initCommands();

// ---------------------------------------------------------------- keys

// dispatched from here and listed by the lantern (lib/actions.js). `id` merges into an existing action or names a new one;
// `guard` gates the KEY only; `plain` answers only with no Ctrl/Alt/Meta (a browser's chord stays the browser's).
const MAIN_KEYS = [
  { code: 'KeyH', key: 'H', id: 'key:help', title: 'help — keys and controls', keywords: ['?', 'keys', 'controls', 'how'], group: 'view',
    guard: () => !isEditing(), run: () => toggleHelp() },
  { code: 'KeyB', key: 'B', id: 'panel:edit', run: () => toggleEditMode() },
  { code: 'KeyP', key: 'P', id: 'key:photo', title: 'photo mode (free camera)', keywords: ['camera', 'picture'], group: 'view', run: () => togglePhotoMode() },
  { code: 'F1', key: 'F1', id: 'key:hidehud', title: 'hide the HUD', keywords: ['interface', 'clean', 'photo'], group: 'view', icon: 'eye-slash',
    prevent: true, run: () => document.body.classList.toggle('photo') },
  { code: 'F2', key: 'F2', id: 'key:screenshot', title: 'save a screenshot', keywords: ['picture', 'capture'], group: 'view', prevent: true, run: () => saveScreenshot() },
  { code: 'F3', key: 'F3', id: 'panel:debug', prevent: true, run: () => toggleDebug() },
  { code: 'KeyU', key: 'U', id: 'key:people', title: 'people here', keywords: ['who', 'present', 'roster', 'us'], group: 'panels', icon: 'users',
    plain: true, guard: () => !isEditing(), run: () => togglePeopleHere() },   // plain: Ctrl+U is the browser's view-source
  { code: 'KeyR', key: 'R', id: 'body:limp', title: 'go limp / get up', keywords: ['ragdoll', 'fall', 'flop'], group: 'body',
    guard: () => !isEditing(), run: () => (isDowned() ? getUp() : goLimp()) },
];
// merge-into rows keep the dock's title/run and only add the key
for (const { code, guard, prevent, plain, ...a } of MAIN_KEYS) registerAction(a.title ? a : { id: a.id, key: a.key });
registerAction({ id: 'panel:chat', key: 'Enter' });
// People Here is U, not Tab: Tab is the panel set's (windows.js), and a key with two meanings runs both

bus.on('key', (e) => {
  if (e.code === 'Slash' && e.shiftKey) { toggleHelp(); return; }
  const k = MAIN_KEYS.find((m) => m.code === e.code && (!m.plain || !(e.ctrlKey || e.altKey || e.metaKey)) && (!m.guard || m.guard()));
  if (k) { if (k.prevent) e.preventDefault(); k.run(); return; }
  if (isDowned() && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) getUp();
  // the number row follows the def-hydrated bar order (§24l): no code change for a new gesture
  const n = /^Digit([1-9])$/.exec(e.code);
  const me = getMe();
  if (n && me) {
    const name = ANIM_ORDER[Number(n[1]) - 1];
    if (!name) return;
    me.playOnce(name);
    myState.anim = name;
    flashHint(name);
  }
});

// ---------------------------------------------------------------- roster

function people() {
  const list = [{ id: CONFIG.name, me: true, dist: null, presence: presence() }];
  for (const r of remotes.values()) {
    list.push({
      id: r.id, me: false, declares: r.declares ?? null, presence: r.presence ?? 'present',
      dist: r.avatar ? r.avatar.root.position.distanceTo(myState.pos) : null,
    });
  }
  return list;
}

// ---------------------------------------------------------------- readiness
// "Ready": your body exists, the log is folded, and no gating build (terrain, the sky's first bake) is running

let hydrated = false, propsWait = false;
bus.on('hydrated', () => {
  updateWater();
  const spawn = environmentSettings()?.spawn;
  if (!restoredPosition && Array.isArray(spawn) && spawn.length === 3 && spawn.every(Number.isFinite)) myState.pos.fromArray(spawn);
  hydrated = true; checkReady();
});
bus.on('world-reset', () => { restoredPosition=false;myState.q=undefined;myState.locomotion=undefined; });

// an empty world is indistinguishable from a broken one, so say so
bus.on('hydrated', () => {
  // net.js builtIn, so the notice and the remembered world agree on "empty"
  if (entities.size > 0 || builtIn(worldState.st)) return;
  logChat('*', emptyWorldNotice(CONFIG));
  logChat('*', 'press B to start building, or ? for the controls.');
  toast(`"${CONFIG.world}" is an empty world — press B to build in it`, 'warn', 14000);
});
bus.on('build-queue', checkReady);

function checkReady() {
  if (bootDone()) return;
  if (!bodySettled || !hydrated || buildsPending() > 0) return;
  // …and every prop INSIDE residency radius has landed (far ones never load); the skip button and 45 s ceiling remain
  if (pending(P.FAR) > 0) { if (!propsWait) { propsWait = true; onIdle(() => { propsWait = false; checkReady(); }, P.FAR); } return; }
  requestAnimationFrame(() => requestAnimationFrame(() => finishBoot('ready')));
}

// backstop: an empty world drains its build queue before anything subscribes, so the edge may never fire
const readyPoll = setInterval(() => {
  if (bootDone()) { clearInterval(readyPoll); return; }
  checkReady();
}, 400);

// ---------------------------------------------------------------- frame loop
// The LIST (loop: lib/frameloop.js): registration order IS execution order (§14.1: motion before remotes,
// sky → materials → rig, send-pose after every myState writer, render last).

registerSystem('autos', (dt, t) => updateAutoSystems(t));       // grass wind, particles
registerSystem('motion', () => tickMotion());
registerSystem('lookat', () => tickLookAt());                   // after motion
registerSystem('texts', () => tickTexts());
registerSystem('openable', () => tickOpenables());
registerSystem('sky', (dt, t, now) => { updateSky(now, t); applyEnvLight(); });   // an authored environment's sun wins, before the rig fits shadows
registerSystem('materials', (dt, t, now) => updateMaterials(now)); // weather → uniforms
registerSystem('rig', (dt, t, now) => updateRig(now));
registerSystem('sounds', () => tickSounds(), { every: 2 });
setWaterObjects(() => entities);
setWaterClock(serverNow);
setSkyHider(hideSkyForWater);
registerSystem('water', updateWater);
registerSystem('me-drive', (dt) => {
  if (CONFIG.renderer) { /* camera is driven per snap request */ }
  else if (CONFIG.spectate) updateSpectator(dt, CONFIG.follow ? remotes.get(CONFIG.follow) : null);
  else if (isDowned()) { myState.q = undefined; myState.locomotion = undefined; const me = getMe(); if (me) me.locomotion = null; stepRagdoll(dt); }     // the controller yields while limp
  else if (avatarMounts.has(CONFIG.name) || seatLeaving()) updateMountedMe(dt);  // seated (or leaving one): derived, not driven
  else updateMe(dt, getMe());
  updateSeatHint(dt);
});
registerSystem('held-pose', () => {
  // apply on change, so I see what everyone sees of me; while downed the ragdoll owns setPose
  const me = getMe();
  if (!isDowned() && me && myState.pose !== me._poseSig) {
    me._poseSig = myState.pose;
    if (myState.pose) me.setPose(myState.pose); else me.clearPose();
  }
});
// BEFORE me-update: humanoid bone writes must precede vrm.update (normalized→raw copy) or never reach the skeleton
registerSystem('xrbody', () => ensureXRBodyHook());   // the chain runs inside Avatar.update(), before vrm.update
registerSystem('me-update', (dt, t, now) => {
  updateVoiceMouths(now);        // BEFORE the avatar update that consumes it
  getMe()?.update(dt, now);
});
registerSystem('bodydrag', (dt, t, now) => updateBodyDrag(dt, now)); // before remotes: the takeover lands in this frame's avatar.update
registerSystem('mods', (dt, t, now) => tickMods(dt, now));
registerSystem('remotes', (dt, t, now) => updateRemotes(dt, now));
registerSystem('gaze', (dt, t, now) => updateGaze(myState.pos, getMe(), CONFIG.name, now));
// the nameplate hover card: after gaze, before render
initPlates({ camera, canvas, scene, remotes, myPos: () => (getMe() ? myState.pos : null), presenting: () => isPresenting(),
  mentionPerson, colorFor, personMenu: (n, x, y) => (isPhone() ? personSheet(n) : personMenuAt(n, x, y)), personStrip });
registerSystem('plates', (dt, t, now) => updatePlates(now));
registerSystem('build', () => updateBuild());
registerSystem('promote-tail', () => drainPromoteTail());        // §16.2.C: ≤~4 ms/frame; before 'debug' so F3 sees same-frame colliders
registerSystem('debug', (dt, t, now) => updateDebug(now));       // F3 wireframes
registerSystem('send-pose', (dt, t, now) => sendPose(now));
// read hands → fill intent (updateMe already moved the body) → rig follows
registerSystem('xr', (dt) => updateXR(dt));
registerSystem('water-view', () => updateWaterView());   // after the camera's last move this frame
registerSystem('xrvignette', (dt) => tickXRVignette(dt));   // comfort tunnel (Settings › VR)
registerSystem('pixel-ratio', () => applyPendingPixelRatio());   // a resize clears the canvas: before the draw, never after
registerSystem('render', renderWorld);
registerSystem('xrmirror', () => tickXRMirror());           // desktop view while presenting
// the radial menu speaks through the same flows the keyboard does
bus.on('xr:sit', () => { if (!xrTrySitOn(null)) setPosture('sit'); });
bus.on('xr:stand', () => xrDismountMe('menu'));
bus.on('xr:mic', async () => { const { xrMicPress } = await import('./lib/vrmic.js'); await xrMicPress(); });   // one bounded permission try, never a hang
bus.on('xr:select', (id) => sceneSelect(id));
globalThis.__waterDebug = waterDebug;
let _pulseAt = 0;
registerSystem('pulse', (dt, t, now) => {
  if (now - _pulseAt < 1000) return;
  _pulseAt = now;
  governPerformance(perf.fps);
  paintHud();
});

startFrame();   // only after identity resolved
initXR();
bindXRSelf(() => getMe());   // first-person split + own-label hide need the body
bindXRBodySelf(() => getMe());
setPoseOverride(() => ((isPresenting() || xrSimActive()) ? { yaw: xrAvatarYaw() ?? undefined, pitch: xrLookPitch(), xr: xrWire() ?? undefined } : null));

// idle bandwidth streams the library into the HTTP cache, yielding to every real load (__ewPrefetch; ?prefetch=0)
startPrefetch().catch((e) => report('prefetch', e));

// ---------------------------------------------------------------- debug

// the human picker's path (loadFromFiles), so an agent never restarts to change voice; ?voice= calls it once at boot
async function setVoice(name) {
  if (!name) {                       // go quiet, keep the lane
    const { setTtsSource, setTtsEnabled } = await import('./lib/tts.js');
    setTtsSource(null); setTtsEnabled(false);
    return { ok: true, voice: null };
  }
  const base = new URL(`voices/${name}`, location.href).href;
  const [onnx, cfg] = await Promise.all([
    fetch(`${base}.onnx`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx: ${r.status}`); return r.blob(); }),
    fetch(`${base}.onnx.json`).then((r) => { if (!r.ok) throw new Error(`${name}.onnx.json: ${r.status}`); return r.blob(); }),
  ]);
  const files = [new File([onnx], `${name}.onnx`), new File([cfg], `${name}.onnx.json`)];
  const { loadFromFiles } = await import('./lib/voiceengines.js');
  await import('./lib/engines.js');
  const { label } = await loadFromFiles(files, (p) =>
    console.log(`[voice] ${p.text || p.phase || 'loading'}`));
  const { setTtsEnabled } = await import('./lib/tts.js');
  setTtsEnabled(true);
  console.log(`[voice] speaking with ${label} — loaded from disk, no server`);
  return { ok: true, voice: label };
}
if (typeof window !== 'undefined') window.setVoice = setVoice;
{
  const want = CONFIG.params.get('voice');
  if (want) setVoice(want).catch((e) => console.warn('[voice] ?voice failed:', e));
}

// opt-in synthesized voice, ?tts[=<port>]: absent, nothing connects and a human client is byte-for-byte unaffected
{
  const q = CONFIG.params;
  if (q.has('tts')) {
    const port = Number(q.get('tts')) || 8927;
    import('./lib/piperbridge.js')
      .then((m) => m.initPiperVoice({ port }))
      .then(async (ok) => {
        console.log(ok ? `[voice] synthesized voice ready on :${port}`
                       : `[voice] no synthesizer on :${port} — falling back to browser speech`);
        if (!ok) {
          // the browser's own voice: worse than Piper, better than silence
          try {
            const { speechSynthesis } = window;
            if (!speechSynthesis) { console.warn('[voice] no speechSynthesis — microphone only'); return; }
            const vs0 = await import('./lib/tts.js');
            // Web Speech renders to the speakers, not a PCM buffer: audible locally, NOT transmitted
            vs0.setTtsSource(async (text) => {
              try { speechSynthesis.speak(new SpeechSynthesisUtterance(text)); } catch {}
              return { pcm: new Int16Array(0), sampleRate: 22050, localOnly: true };
            }, 'browser speech (local only — peers will NOT hear this)');
            vs0.setTtsEnabled(true);
            console.warn('[voice] FALLBACK: browser speech. Audible to YOU, not to peers.'
                       + ` Start a synthesizer on :${port} for transmitted voice.`);
          } catch (e) { console.warn('[voice] browser-speech fallback failed:', e); return; }
        }
        const vs = await import('./lib/tts.js');
        // the own-say hook is installed once at boot; a second would speak each line twice
        // the probe seam goes in BEFORE anything that can hang: toggleMic() awaits a source
        globalThis.__voiceProbe = () => ({ ...vs.mouthInfo(), track: vs.genTrackInfo() });
        globalThis.__voiceSpeak = (t) => vs.speak(t);   // the APP's mouth, for probes
        const { toggleMic, micOn } = await import('./lib/micstate.js');
        // open the mic lane before the first utterance, through the transport that owns it
        if (typeof window.__sfuMic === 'function') {
          if (!window.__sfuMicOn?.()) await window.__sfuMic();
        } else if (!micOn()) {
          await toggleMic(CONFIG.name);
        }
        console.log('[voice] TTS wiring complete');
      })
      // NEVER SWALLOW THIS: a throw after "voice ready" would vanish while the log claims success
      .catch((e) => console.error('[voice] TTS wiring failed:', e?.message || e));
  }
}

globalThis.__ambientDebug = () => ambientDebug();
// console probes: the avatars are otherwise module-private
globalThis.__me = () => getMe();
globalThis.__bodies = () => [
  ...(getMe() ? [['me', getMe()]] : []),
  ...[...remotes.entries()].map(([id, r]) => [id, r.avatar]),
].filter(([, av]) => av).map(([who, av]) => ({
  who,
  limp: !!av._limp,
  clip: av.currentSlot ?? null,
  // exactly one is true of a limp body: the local sim owns hair and wings, or three-vrm does
  simOwnsDressing: !!av.__simHair,
  springbonesRunning: !av.__simHair && !!av.vrm?.springBoneManager,
  avatar: av,
}));
globalThis.__audioState = () => audioState();
// the audio isolation test; it needs a click first, so it reports the context state rather than pretending
globalThis.testAudioLayers = async () => {
  // the SHARED context: a new one could exhaust the budget and report silence it caused
  const { audioContext } = await import('./lib/audioctx.js');
  const ctx = audioContext();
  await ctx.resume().catch(() => {});
  const SRC = '/assets/audio_test_beacon.ogg';
  const r = { ctx: ctx.state };

  const a = new Audio(SRC); a.loop = true;
  try { await a.play(); r.A_plainAudio = 'playing'; }
  catch (e) { r.A_plainAudio = `FAILED ${e.name}`; }

  const b = new Audio(SRC); b.loop = true;
  try {
    const n = ctx.createMediaElementSource(b);
    const g = ctx.createGain(); g.gain.value = 1;
    n.connect(g).connect(ctx.destination);
    await b.play(); r.B_throughWebAudio = 'playing';
  } catch (e) { r.B_throughWebAudio = `FAILED ${e.name}`; }

  try {
    const o = ctx.createOscillator(); const g = ctx.createGain();
    g.gain.value = 0.15; o.frequency.value = 440;
    o.connect(g).connect(ctx.destination); o.start();
    setTimeout(() => { try { o.stop(); } catch {} }, 6000);
    r.C_oscillator = 'started (6s)';
  } catch (e) { r.C_oscillator = `FAILED ${e.message}`; }

  setTimeout(() => {
    console.log('%c[audio] after 3s — A t=' + a.currentTime.toFixed(2) +
      '  B t=' + b.currentTime.toFixed(2) +
      '  Aerr=' + (a.error?.code ?? 'none') + '  Berr=' + (b.error?.code ?? 'none'),
      'font-size:14px;color:#6cf');
    console.log('%cWHICH DID YOU HEAR?  A only → WebAudio output dead · A+C → ' +
      'createMediaElementSource is the break · C only → decode/file · none → ' +
      'below the page · all → page fine, ambient.js miswired', 'color:#fc6');
  }, 3000);
  console.log('%c[audio] ' + JSON.stringify(r, null, 1), 'font-size:14px;color:#6cf');
  return r;
};

globalThis.whyIsItSilent = () => {
  const s = audioState(), a = ambientDebug();
  console.log('%c[audio] ' + JSON.stringify({ ...s, sources: a }, null, 1),
    'font-size:14px;color:#6cf');
  return { ...s, detail: a };
};

// the synced clock: the swell a swimmer rises on is the one everyone sees
setWaveClock(() => participants.serverNow());

const EW = globalThis.EW = {
  me: () => getMe(), remotes, entities, myState, THREE, net, scene, camera, renderer, bus, sendRequest,
  avatarMounts, serverNow, bagOf, bags,
  seatSocket, socketsOn,
  skyArgs, setPosable, get posable() { return posable(); },
  // EW.pose, EW.clearPose, EW.animate: an agent's own verbs (client/lib/posecommands.js)
  ...poseCommands({ state: myState, sendPuppet, play: (a) => { getMe()?.playAnimation(a); sendAnim(a); } }),
  // EW.terrain(patch) (owner) PATCHES the current bag: EW.terrain({ features: [{ type: 'hill', x: 30, z: -20, radius: 18, height: 9 }] })
  // Feature types: shared/terrainshape.js. Heightmaps: the ground panel, or GET /heightmap?world=<name>.
  terrain: (patch = {}) => {
    const cur = terrainEditBase() ?? { seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16 };
    const next = noteTerrainSent({ ...cur, ...patch });   // a second quick edit composes with this one
    sendRequest('set', { id: '@world', component: 'terrain', value: next });
    return next;
  },
  get terrainArgs() { return currentTerrainArgs(); },
  // the ground as walking reads it
  groundAt: (x, z) => heightAt(x, z), get hasTerrain() { return hasTerrain(); },
  get terrainPending() { return terrainPending(); },
  setPushable, get pushable() { return pushable(); }, dragState,
  // target: a contact point name, [who, name], a point, or a function (per frame, local only); the rest ride presence.
  // EW.reach('rightHand', 'head_top') · EW.reach('rightHand', ['mythos', 'shoulder_l'])
  reach: (key, target, opts) => {
    if (typeof target === 'function') return getMe()?.setReach(key, target, opts);
    const err = setMyReach(key, target, opts);
    if (err) { console.warn(`[reach] ${err}`); return false; }
    return true;
  },
  // derived per body from its own mesh; EW.showLandmarks() is the check the derivation cannot do itself: LOOK
  landmarks: (who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    return av.__marks;
  },
  // world space, now; `standoff` (m) lifts it off the skin so a hand rests ON it.
  //   EW.reach('rightHand', () => EW.contactAt('mythos', 'shoulder_l', 0.02))
  contactAt: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? hit.pos.toArray() : null;
  },
  // bump whenever the solver changes, so a diagnostic can prove which code produced its numbers
  reachVersion: 'reach-6 contact-allowance 2026-08-20',
  // vrm.scene.name is often blank
  get avatarPath() { try { return getMyAvatarPath() || '(unknown)'; } catch { return '(unknown)'; } },
  reachAudit: (who, standoff = 0.02) => {
    // landmarks from the body TOUCHED; the reaching chains are always mine
    const av = getMe();
    const subject = who ? remotes.get(who)?.avatar : av;
    if (!av || !subject) return null;
    subject.__marks ??= deriveLandmarks(subject);
    const self = subject === av;
    const rows = [];
    for (const [name, e] of subject.__marks) {
      const hit = landmarkWorld(e, standoff);
      if (!hit) continue;
      const t = hit.pos.toArray();
      const best = { hand: null, gap: Infinity, bound: [] };
      for (const key of ['leftHand', 'rightHand']) {
        const ch = measureChain(av, key);
        if (!ch) continue;
        // a limb can't touch itself: a point ON its own chain scores a meaningless 0 mm
        if (self && (ch.spec.root === e.bone || ch.spec.mid === e.bone || ch.spec.end === e.bone)) continue;
        const out = solveChain(ch, av, t, null);
        if (!out?.ok) continue;
        if (out.res.gap < best.gap) { best.hand = key === 'leftHand' ? 'L' : 'R'; best.gap = out.res.gap; best.bound = out.res.bound; }
      }
      rows.push({ point: name, tier: e.tier, hand: best.hand ?? '-',
                  mm: Number.isFinite(best.gap) ? Math.round(best.gap * 1000) : null,
                  bound: best.bound.join(',') || '-' });
    }
    rows.sort((a, b) => (a.mm ?? 1e9) - (b.mm ?? 1e9));
    return rows;
  },
  // and the surface normal, so a reach can put the PALM on it
  contactFrame: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
  },
  // a green disc on the side the code believes is the PALM
  showPalm: (on = true, key = 'rightHand') => {
    const me = getMe(); if (!me) return null;
    const ch = me._chains?.get(key);
    if (!ch) return 'reach something first, so the chain is measured';
    const node = ch.nodes.end;
    const NAME = '__palmDisc';
    const old = node.getObjectByName(NAME);
    if (old) { node.remove(old); old.geometry.dispose(); old.material.dispose(); }
    if (!on) return 'off';
    const qH0 = new THREE.Quaternion(...ch.restQ.qH);
    const aPalm = new THREE.Vector3(...ch.palmRest).applyQuaternion(qH0.clone().invert());
    const disc = new THREE.Mesh(
      new THREE.CircleGeometry(0.035, 20),
      new THREE.MeshBasicMaterial({ color: 0x33ff66, side: THREE.DoubleSide, depthTest: false }));
    disc.name = NAME;
    disc.renderOrder = 999;
    disc.position.copy(aPalm).multiplyScalar(0.03);
    disc.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), aPalm.clone().normalize());
    node.add(disc);
    return 'green disc marks the palm side';
  },
  showLandmarks: (on = true, who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    debugMarkers(av, av.__marks, scene, on);
    return [...av.__marks].map(([n, e]) => `${n}:${e.how}`).join(' ');
  },
  clearReach: (key) => clearMyReach(key ?? null),
  reachStatus: () => getMe()?.reachStatus(),
  physics: physicsApi, // what runtime mods script against (thingphysics.js)
  mods: modsApi,     // put and run need your click
  bodysim: { engine: bodyEngine, setEngine: setBodyEngine, list: listBodyEngines },
  foldParity,        // shadow-mode drift probe (TEL0S_NOTES §11.6)
  reconcileModels,   // idempotent (§11.4)
  materials: materialsDebug,   // §12.3
  lightrig: rigDebug,          // §12.4
  lampShadow: lampShadowState,
  setLampShadow,                 // ({map, texels, dist}): live, bias re-derived

  governor: governorDebug,     // §12.6
  residency: residencyDebug,   // §13.3
  gpu: () => ({ ...renderer.info.memory, ...protoStats() }),
  draws: drawStats,
  foliage: () => import('./lib/foliage.js').then((m) => m.foliageDebug()),
  overdraw: (opts) => import('./lib/overdraw.js').then((m) => m.overdrawCapture(opts)),   // fragments shaded per pixel, by category
  setDrawBatching,
  frame: frameDebug,           // §14.2 6b
  grass: grassTiles,           // §13.2
  simShown,                    // a copy of this client's sim layer at the server's clock
  grassDiag,                   // §22: the meadow's GPU cost, attributed by difference
  setCloudQuality,             // §22b
  water: waterDebug,
  warm: warmStats,             // §16.2.A
  budget: budgetStats,         // the shared per-frame background budget
  lanes: () => ({ sched: schedLaneStats(), load: loadLaneStats() }),  // queue depths vs caps
  colliderCache: colliderCacheStats,   // §16.2.C
};

} // end of the normal-boot branch
