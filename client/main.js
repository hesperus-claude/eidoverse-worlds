// the water level seen from under it (#254): fog, the background, Snell's window (watervolumes.js); authored water volumes,
// air boxes and environments (#248) wait for their components to be registered (PROTOCOL §4)
import { updateWater, updateWaterView, setWaterObjects, setWaterClock, setSkyHider, environmentSettings, waterDebug, applyEnvLight } from './lib/watervolumes.js';
// eidoverse-worlds browser client.
//
// Two planes: the world log (verbs, ordered, replayed on join) and presence
// (intent state at ~15Hz, interpolated). The client owns its own avatar; the
// server sequences and relays. This file is the boot sequence and the frame
// system LIST — every system lives in lib/ (§14 6c): identity and the `me`
// handle in mybody.js, my body's physics in localbody.js, consent in
// consent.js, voice mouths in voicemouths.js, /commands in lib/commands/.

import { say } from './lib/net.js';
import { chooseClient } from './lib/litechoice.js';
import { THREE, scene, camera, renderer, canvas } from './lib/core.js';
import { releaseBodyGate, armBodyGate } from './lib/bodygate.js';
import { CONFIG, bus, report, tee, colorFor } from './lib/base.js';
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
// side-effecting: the `particles` component's host wires itself to the comp
// and entity buses on import (it has no boot step of its own)
import './lib/emitters.js';
import './lib/pictures.js';
import { tickSounds } from './lib/sounds.js';   // the sound comp: positional audio from an entity
import { tickMotion } from './lib/motion.js';
import { tickLookAt } from './lib/lookats.js';   // batch 2: look-at, after motion (a bob moves it, then it turns)
import { tickTexts } from './lib/texts.js';      // batch 2: signs (the text component)
import { tickOpenables } from './lib/openable.js';
import {
  myState, updateMe, updateSpectator, setCamYaw, setPosture, togglePhotoMode,
  setRightsHook, setMeHook, setFolded, photoMode, setBoundsHook, flying as flyingNow, capSpeed,
} from './lib/controller.js';
import { initUsePrompt } from './lib/useprompt.js';
import { initClickUse, clickUseApi } from './lib/clickuse.js';
import { remotes, updateRemotes, updateGaze, serverNow } from './lib/remotes.js';
import { initOccupants } from './lib/occupants.js';
// The whole module as one object: net.js takes the participant registry by injection
// now (it must carry the protocol for lite.js, which has no bodies to register), and
// this is the real, body-building implementation of that interface.
import * as participants from './lib/remotes.js';
import { capture, setSnapReadiness } from './lib/net_capture.js';
import { setWaveClock } from './lib/water.js';
import { myReachBag } from './lib/reachnet.js';
import {
  replica, net, connect, initIdentity, loginUrl, wireNet, sendRequest, sendPose, sendTyping,
  setPoseOverride, sendPuppet, sendAnim,
} from './lib/net.js';
import { poseCommands } from './lib/posecommands.js';
import { updateBuild, toggleEditMode, isEditing, editSurface } from './lib/build.js';
// may I build here: the build switch (the authority's), else the role (an older server); unknown = no (strict)
const mayBuildStrict = () => (Array.isArray(net.myRights?.permissions) ? net.myRights.permissions.includes('build') : isOwner(net.myRights));
import { initPalette } from './lib/catalog.js';
import { initConjure } from './lib/generate.js';
import { micLive, earOn } from './lib/mictoggle.js'; // mic + headphone toggles beside the HUD, both off by default
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

// which build is this world running: one console line at boot (server route: GET /version, same answer)
fetch('/version').then((r) => r.json())
  .then(({ sha, commitTime, dirty, startedAt }) => console.log(`[eidoverse] server build ${sha}${dirty === true ? ' (DIRTY TREE)' : dirty === false ? '' : ' (dirty: unknown)'} (code from ${commitTime}), up since ${startedAt}`))
  .catch(() => console.log('[eidoverse] server build unknown (/version unavailable)'));
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

// (Crash breadcrumbs live in lib/breadcrumbs.js now; the frame loop stamps each
// system's name as it runs. avatar.js still reads globalThis.__ewBC.)

if (CONFIG.params.has('mintthumbs')) {
  // ?mintthumbs — seed the roster's portraits, then stop (lib/portraits.js owns
  // the why and the how). The else below is the entire normal boot.
  await (await import('./lib/portraits.js')).mintThumbnails();
} else {

const isViewer = CONFIG.spectate || CONFIG.renderer;

// ---------------------------------------------------------------- lighting
// the sun shadow lives in the light rig (lightrig.js §12.5), set before the first compile: shadowMap is pipeline-shape

setSkyArgsSource(skyArgs);
setResidencyFocus(() => myState?.pos ?? null);   // the body anchors residency too (§13.3)
// a renderer takes a snapshot only once the world is realized around the body it follows (net_capture.js settle): the
// body in the scene, the world's builds done, no model loading or standing in. (Shaders still warming do not block:
// the renderer compiles any it meets — a stall, never a missing object.)
setSnapReadiness(async (follow) => {
  const r = residencyDebug(), warm = warmStats();
  const body = !!remotes.get(follow)?.avatar, builds = anyBuildsPending();
  return { ready: body && !builds && !r.loading && !r.standins, body, builds, models: r.real,
    loading: r.loading + r.standins, compiling: warm.pending + (warm.running ? 1 : 0) };
});
// The realizers project folded state into the scene. Wired before connect()
// so the hydrated event of the very first snapshot finds them listening;
// livechat.js takes the fold-inert live verbs off the 'live-entry' bus.
initModelsRealizer();
initEnvironmentRealizer();
initSocialRealizer();
// structure AFTER models: a building's anchor entity is an ordinary spawn until
// the `kind` amendment lands, and the structure realizer hides whatever object
// the models realizer made for it.
initStructureRealizer();
initStructureUI();
initCauses();
// the deterministic sim's applier (PROTOCOL_v2 dialect 3): advances the
// shadow sim fold to now and moves sim-owned bodies — inert pre-epoch

// ---------------------------------------------------------------- boot

initBoot({ world: CONFIG.world, name: CONFIG.name });
buildHelp();
const chatApi = initChat({
  send: (text) => say(text),
  typing: (to) => { sendTyping(to); getMe()?.setTyping(); },
  people,
  // the person menu and badges (research roles S6; client/lib/people.js)
  person: { menuAt: personMenuAt, sheetFor: personSheet, stripFor: personStrip, badgeHtml: personBadge, muted: (n) => personOf(n).muted, presenting: () => isPresenting() },
});
initPeople({ mentionPerson, presenting: () => isPresenting(), toast, openModLog: (who) => openModeration({ tab: 'log', who }) });
initRolesPanels();
// the lantern prompt (Ctrl/Cmd+K): actions from lib/actions.js, speech and /commands through chat's own submit
initLantern({ submit: chatApi.submit });
initActionBar();
initXRKeyboard();   // C16: types into the last-focused text input; a quad in VR
initXRAsk();        // the lock question and refusals, on a quad in VR (the centre card is DOM-only)
initWorldQuad();
initVRPanel();
settingsFrame();               // exists (hidden) so the ∃ menu can open it
initDock([
  { id: 'chat', label: '💬' },
  { id: 'world', label: '🧱' },
  { id: 'actions', label: '👋' },
  { id: 'debug', label: '🐞' },
  // edit is a MODE, not a window: last:true keeps it apart at the rail's end. The gate reads the server's rights
  // (net.myRights): an operator owns every world but isn't in the fold's roles map.
  { id: 'settings', label: '⚙️', icon: 'gear-six' },
  {
    id: 'edit', label: '🔧', icon: 'wrench', last: true,
    action: toggleEditMode,
    active: () => isEditing(),
    // while editing, the wrench is THE way out — amber on purpose, so its tooltip says so
    title: (on) => (on ? 'leave builder mode (B)' : null),
    gate: () => editSurface() && mayBuildStrict(),   // no edit mode on a phone (build.js editSurface)
    deadWhy: () => (editSurface() ? null : ' — builder mode is for a desktop or tablet'),
  },
]);
// the ∃ menu's Save/Load are offered to builders (the wrench's own gate), and its Log in follows the deployment's login
setMenuSources({ buildRights: () => editSurface() && mayBuildStrict(), loginUrl: () => loginUrl() });
paintPresence(presence());            // the dot needs the button: after initDock
bus.on('presence:me', paintPresence);
initDebug({
  // the body in your HAND wins over your own — that is the one being worked on
  ragdoll: () => dragSim() ?? activeRagdoll(),
  downed: () => !!dragSim() || isDowned(),
  dragging: () => !!dragSim(),
  fps: () => perf.fps,
  perf: () => perf,          // fps + frame ms + worst-of-last-second
  bill: frameDebug,          // per-system EWMA ms — where the frame goes
  // drop again from where you stand, so a shape can be reproduced back to back
  reLimp: () => { if (isDowned()) getUp(); goLimp(); },
});
// the capture renderer is wired BEFORE start() opens the socket: sendJoin claims the renderer role only when one is
// wired (net.js), and nothing else enforces that order
wireNet({ capture });   // net_capture.js — the one part of the protocol that needs a renderer
// Verified identity resolves BEFORE anything reads CONFIG.name — otherwise the
// door panel and the local nameplate greet a stale localStorage name while the
// server (correctly) calls this person by their Discord name.
await initIdentity();

// the splash waits for the body to SETTLE (on screen, or failed), never for a body to exist
let bodySettled = false;
if (isViewer) releaseBodyGate('viewer — no body expected'); else armBodyGate();   // a body is coming: the world's parses wait for it (assets.js)
if (isViewer) {
  panelFrame().hide();
  bodySettled = true;
  markPhase('body', 1);
  start();
} else {
  // the front door: ask once for a name and a body, remember, never ask again; ?door=1 re-opens it
  const firstRun = CONFIG.params.has('door') || (!CONFIG.params.has('name') && localStorage.getItem('ew-name-set') !== '1');
  if (firstRun) {
    // the door is already an interactive pause — its roster fetch is lazy,
    // and the choice is cached so the NEXT boot needs no fetch at all
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


// ?sendlayout=1 — post this browser's saved panel layout (every ew-frame-* key + the viewport it
// was arranged in) to the host tee, so a hand-arranged layout can be read off the log and baked in
// as the default.
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

// A desktop whose last full boot never came back is NOT demoted to lite (index.html
// decideLite, 'retry'): it boots full again and says so, as a pill on the status strip
// with the light version one press away. Never "type ?lite=1".
if (globalThis.__ewLiteWhy === 'retry') statusChip({
  id: 'lite-retry', level: 'attn', label: 'last load stalled',
  title: "This world didn't finish loading last time",
  body: "We're trying the full 3D world again. If it keeps stalling or crashing here, the lite client has chat, the action bar and who's here, with no 3D.",
  actions: [{ label: 'switch to the lite client', run: () => chooseClient(true) }, { label: 'stay in 3D', clear: true }],
});

// A rejected door key re-opens the door with a key field instead of retrying
// into a wall forever.
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
  initConjure();   // the orrery panel — prompt → your pick of images → mesh → world
  // ONE TRANSPORT, EXACTLY ONE PLAYBACK OWNER (#104 amendment 6): the SFU is the only voice path, not a flag, so a
  // second owner can't initialise. A failed cutover rolls back by release (notes/CUTOVER-ROLLBACK.md), not a branch.
  window.__voiceTransport = 'pending:sfu';
  import('./lib/voicesfubridge.js').then((m) => { m.initVoiceSfu(CONFIG.name); window.__voiceTransport = 'sfu'; })
    .catch((e) => { window.__voiceTransport = 'failed:sfu'; window.__voiceTransportError = String(e); console.error('voice init failed', e); });
  initAudioPanel();   // 🔊 categories: voices / world / TTS + consent rows
  // Hear your own says in your chosen voice: installed at boot for everyone (speakOwnSays gates on a voice and the
  // checkbox). The identity is the log's actor ID string, not the avatar object.
  import('./lib/tts.js')
    // net.myId is the server's settled name (auth rename, duplicate suffix); CONFIG.name before the join completes
    .then((vs) => vs.speakOwnSays(bus, () => net.myId || CONFIG.name))
    .catch((e) => console.warn('[voice] own-say hook not installed:', e));
  initSceneGraph();   // 🌳 the world as a tree + 📜 the scripts that animate it
  // hierarchy + inspector as fields: desktop frames now, VR quads through the same declaration
  const editPanels = initEditPanels();
  bus.on('edit-mode', (on) => editPanels.show(!!on));
  initGizmo();        // TransformControls on the selection while a transform tool is up
  initGripEdit();     // the grip editor: a ghost hand and its handles, opened from the grabbable card
  initMaterialOverrides();   // the draft hesperus/material reader (docs/COMPONENT-LADDER.md)
  initWorldEdge();           // @world.bounds drawn as a fence
  initEditLayout();   // the workspace: docks the frames while the mode is on (registered AFTER show, so it docks visible frames)
  // the boot hint ('WASD move · Enter chat · B build · ? help') merged into the lantern's resting line
  // (lib/commandbar.js), which owns bottom-centre; the hint bar now only borrows that spot for offers and flashes

  if (!isViewer) {
    // A body is never optional: if the chosen one fails, wear the default and SAY SO, clearing the stale cache so the
    // next boot re-resolves. Only a failing default leaves nothing to wear, and that is reported.
    const DEFAULT_BODY = 'eidoverse/assets/vrms/claude.vrm';
    // ?capsule=1: refuse every body load so the REAL fallback chain runs end to end
    const wear = (path) => CONFIG.params.has('capsule') ? Promise.reject(new Error('?capsule=1: body loads refused')) : makeAvatar(CONFIG.name, path, { urgent: true });   // your body skips the load queue
    resolveMyAvatarPath()
      .then((path) => wear(path).then((av) => ({ av, path })).catch((e) => {
        report('avatar', e);
        // the capsule is the floor: a body that needs no network (09-19: a flapping tunnel took BOTH the
        // chosen body and the default, and the owner arrived as nothing)
        const capsule = () => { toast('no body would load — wearing the capsule until one does. Pick another in Profile.', 'warn', 12000); tee('[body] capsule stand-in (chosen + default failed)'); return { av: makeCapsuleAvatar(CONFIG.name), path: 'capsule' }; };
        if (String(path).startsWith(DEFAULT_BODY)) return capsule();
        try { localStorage.removeItem('ew-avatar-path'); } catch { /* private mode */ }
        toast(`your body (${getMyAvatarName()}) failed to load — wearing the default. Pick another in Profile.`, 'warn', 9000);
        chooseAvatar(DEFAULT_BODY, 'claude');
        return wear(DEFAULT_BODY).then((av) => ({ av, path: DEFAULT_BODY })).catch((e2) => { report('avatar default', e2); return capsule(); });      }))
      .then(({ av, path }) => {
        setMe(av);
        if (!av.isCapsule) announceWorn(path.split('/').pop().replace(/\.vrm.*$/, ''), path);   // the roster's name for this file, not a stale ew-avatar-name
        bodySettled = true;
        markPhase('body', 1);
        // contribute a portrait for the body picker, deferred until calm: it costs an offscreen compile burst (§16.1g)
        if (!av.isCapsule) whenCalm().then(() => contributeThumbnail(getMyAvatarName(), av.vrm, CONFIG.token, { path: getMyAvatarPath() }));
      })
      .catch((e) => { bodySettled = true; markPhase('body', 1); report('avatar', e); releaseBodyGate('body failed — the world must not wait'); checkReady(); });
  }
}

// The two things ui.js and chat.js stopped importing so they could be shared with a
// renderer-less client: this is the client that HAS a renderer, so it supplies them.
setLoadingItems(loadingItems);
setBootAssets({ items: loadingItems, bytes: bootBytes });
registerXRPanel(chatXRPanel);

let restoredPosition = false;
wireNet({
  participants,
  myReachBag,
  toast,   // remotes.js — real bodies, real poses
  forgetBytes,    // the asset ledger, which only a client that loads assets has
  // (capture is wired above, before start(): sendJoin reads it)
  myAvatarPath: () => getMyAvatarPath(),   // a bare name: the server resolves
  myState,
  me: () => getMe(),
  myVoice: () => ({ mic: micLive(), hear: earOn() }),   // rides presence: others' hover card + agents' look
  onRestore: (r) => {
    // a remembered pose can carry null (JSON has no NaN — tonight's NaN body
    // was stored as [null,0,null] and every rejoin put the owner back on it): only
    // finite numbers are a place; anything else is the origin
    const fin = (v, fb = 0) => (Number.isFinite(v) ? v : fb);
    restoredPosition = true;
    myState.q = r.q; myState.locomotion = r.locomotion;
    myState.pos.set(fin(r.p[0]), fin(r.p[1]), fin(r.p[2]));
    myState.yaw = r.yaw ?? 0;
    setCamYaw(myState.yaw + Math.PI); // camera behind you, facing your way
    { const m = readBodyMode(r); if (m === 'sit' || m === 'lie') setPosture(m); }   // the body-mode survives a rejoin (an older sample: read off its clip)
    // an enacted pose is authored content: wake holding it (it rides the next presence packet); a remembered
    // ragdoll frame is wreckage, so wake standing
    if (r.clip === 'ragdoll') { myState.pos.y = 0; return; }
    if (r.pose) myState.pose = r.pose;
    setFolded(foldedIn(r) === true);   // the named pose wings-folded (or, remembered before 10-17, wingsFolded)
  },
  onSnapshotDone: () => {},
});

bus.on('sky-degraded', ({ msg }) => toast(msg, 'warn', 12000));

initOccupants();   // seat-profile verdicts (#101): fetch on boot, refresh on the two update events

// ---------------------------------------------------------------- my body
// the avatar swap rides mybody.js; the physics of being a body is localbody.js, handed logChat (§14.2)

// Flight reads the world's grant, live: wired here because net.js must not import the controller. A role change
// takes effect on the next resolve, and losing fly grounds a body already in the air.
setRightsHook(() => net.myRights);
setMeHook(() => getMe());        // the fold pose is written onto the avatar

// physics in a world: carrying, throwing and punting as door requests, flights drawn from this client's own fold
setBoundsHook(() => replica.st?.entities?.['@world']?.c?.bounds ?? null);
initThingPhysics({ aim: () => clickUseApi.aimPoint(), myPos: () => myState.pos, me: () => getMe(), camera, editing: () => isEditing(), seated: () => !!myState.seat || !!avatarMounts.get(CONFIG.name)?.to, myState: () => myState, flying: () => flyingNow(), capSpeed: (v, ms) => capSpeed(v, ms), mounts: () => avatarMounts });
initUsePrompt({ myPos: () => myState.pos, camera, editing: () => isEditing(), busy: () => photoMode || isDowned() });   // E: use what's in front of you
initClickUse({ editing: () => isEditing(), busy: () => photoMode || isDowned(), myPos: () => myState.pos });   // the mouse: left-click a thing's primary use, right-click its menu
// reach descriptors resolve against the same bodies everyone renders; my own
// id is how "a landmark on me" and "a point in my frame" find this body
initReachNet({
  me: () => getMe(),
  myId: () => CONFIG.name,
  avatarOf: (id) => (id === CONFIG.name ? getMe() : remotes.get(id)?.avatar ?? null),
});
initMods();   // 🧩 runtime client scripts: your local trusted mods (a world offers none: its code is its server-side scripts)
initLocalBody({ logChat });
initCommands();   // the /command surface (lib/commands/) + its bus subscriptions

// ---------------------------------------------------------------- keys

// The main keys, as data: the handler dispatches from this table and the lantern prompt lists it (lib/actions.js).
// `id` merges into an existing action or names a new one; `guard` gates the KEY only; `plain` keys answer only
// with no Ctrl/Alt/Meta held (a browser's own chord stays the browser's).
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
// merge-into rows keep the dock's title/run (the same act) and only add the key; new rows register whole
for (const { code, guard, prevent, plain, ...a } of MAIN_KEYS) registerAction(a.title ? a : { id: a.id, key: a.key });
registerAction({ id: 'panel:chat', key: 'Enter' });
// People Here is U (above), not Tab — Tab is the panel set's (windows.js), and a key with two meanings
// ran both (Tab hid the set, then this re-showed chat beside it)


bus.on('key', (e) => {
  if (e.code === 'Slash' && e.shiftKey) { toggleHelp(); return; }
  const k = MAIN_KEYS.find((m) => m.code === e.code && (!m.plain || !(e.ctrlKey || e.altKey || e.metaKey)) && (!m.guard || m.guard()));
  if (k) { if (k.prevent) e.preventDefault(); k.run(); return; }
  // any movement stands you back up
  if (isDowned() && ['KeyW','KeyA','KeyS','KeyD','ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) getUp();
  // gestures on the number row, following the def-hydrated bar order (§24l): a ninth gesture in _actionbar.json
  // gets a key with no code change
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
// "Ready" is something to stand in: your body exists, the log is folded, and no heavy build (terrain, grass, the
// sky's first bake) is still running

let hydrated = false, propsWait = false;
bus.on('hydrated', () => {
  updateWater();
  const spawn = environmentSettings()?.spawn;
  if (!restoredPosition && Array.isArray(spawn) && spawn.length === 3 && spawn.every(Number.isFinite)) myState.pos.fromArray(spawn);
  hydrated = true; checkReady();
});
bus.on('world-reset', () => { restoredPosition=false;myState.q=undefined;myState.locomotion=undefined; });

// an empty world is indistinguishable from a broken one, so say so (a mistyped world name lands here)
bus.on('hydrated', () => {
  if (entities.size > 0) return;
  const named = CONFIG.params.has('world');
  logChat('*', named
    ? `"${CONFIG.world}" is empty — nothing has ever been built here.`
    : `you are in "${CONFIG.world}", which is empty. Add ?world=<name> to the link to go somewhere else.`);
  logChat('*', 'press B to start building, or ? for the controls.');
  toast(`"${CONFIG.world}" is an empty world — press B to build in it`, 'warn', 14000);
});
bus.on('build-queue', checkReady);

function checkReady() {
  if (bootDone()) return;
  if (!bodySettled || !hydrated || buildsPending() > 0) return;
  // …and every prop INSIDE residency radius has landed (far entities never schedule a load, realize/models.js, so they
  // can't hold the door); the skip button (4 s) and the 45 s ceiling remain
  if (pending(P.FAR) > 0) { if (!propsWait) { propsWait = true; onIdle(() => { propsWait = false; checkReady(); }, P.FAR); } return; }
  // one frame with everything in place before the curtain lifts
  requestAnimationFrame(() => requestAnimationFrame(() => finishBoot('ready')));
}

// A world with no entities drains its build queue before anything subscribes,
// so poll as a backstop rather than relying on an edge that may never fire.
const readyPoll = setInterval(() => {
  if (bootDone()) { clearInterval(readyPoll); return; }
  checkReady();
}, 400);

// ---------------------------------------------------------------- frame loop
// The loop lives in lib/frameloop.js; this is the LIST, and registration order IS execution order (constraints in
// §14.1: motion before remotes, sky → materials → rig, send-pose after every myState writer, render last).
// EW.frame() prints the per-system bill; the governor + HUD ride the 1Hz pulse, registered last.

registerSystem('autos', (dt, t) => updateAutoSystems(t));       // grass wind, particles
registerSystem('motion', () => tickMotion());                   // the world's moving parts
registerSystem('lookat', () => tickLookAt());                   // look-at: things turn to face something (after motion)
registerSystem('texts', () => tickTexts());                     // signs that turn to face you
registerSystem('openable', () => tickOpenables());           // doors, gates and lids tween to their state
registerSystem('sky', (dt, t, now) => { updateSky(now, t); applyEnvLight(); });   // an authored environment's sun wins, before the rig fits shadows
registerSystem('materials', (dt, t, now) => updateMaterials(now)); // weather → uniforms
registerSystem('rig', (dt, t, now) => updateRig(now));          // light slots follow requests
registerSystem('sounds', () => tickSounds(), { every: 2 });      // panners follow entities, the listener the camera
setWaterObjects(() => entities);
setWaterClock(serverNow);
setSkyHider(hideSkyForWater);
registerSystem('water', updateWater);
registerSystem('me-drive', (dt) => {
  if (CONFIG.renderer) { /* camera is driven per snap request */ }
  else if (CONFIG.spectate) updateSpectator(dt, CONFIG.follow ? remotes.get(CONFIG.follow) : null);
  else if (isDowned()) { myState.q = undefined; myState.locomotion = undefined; const me = getMe(); if (me) me.locomotion = null; stepRagdoll(dt); }     // the controller yields while limp
  else if (avatarMounts.has(CONFIG.name) || seatLeaving()) updateMountedMe(dt);  // seated (or being carried off a seat): derived, not driven
  else updateMe(dt, getMe());
  updateSeatHint(dt);            // "X — sit" while a declared seat is in reach
});
registerSystem('held-pose', () => {
  // my own held pose: apply on change so I see what everyone else sees of
  // me. While downed the ragdoll owns setPose directly, so skip this path.
  const me = getMe();
  if (!isDowned() && me && myState.pose !== me._poseSig) {
    me._poseSig = myState.pose;
    if (myState.pose) me.setPose(myState.pose); else me.clearPose();
  }
});
// XR body BEFORE me-update: humanoid bone writes must precede vrm.update (normalized→raw copy) or they never reach the skeleton — avatar.js's own 'ordering trap' note
registerSystem('xrbody', () => ensureXRBodyHook());   // the chain itself runs inside Avatar.update(), before vrm.update
registerSystem('me-update', (dt, t, now) => {
  updateVoiceMouths(now);        // BEFORE the avatar update that consumes it
  getMe()?.update(dt, now);
});
registerSystem('bodydrag', (dt, t, now) => updateBodyDrag(dt, now)); // before remotes:
                                 // the takeover pose lands in this frame's avatar.update
registerSystem('mods', (dt, t, now) => tickMods(dt, now));       // 🧩 runtime scripts
registerSystem('remotes', (dt, t, now) => updateRemotes(dt, now));
registerSystem('gaze', (dt, t, now) => updateGaze(myState.pos, getMe(), CONFIG.name, now));
// the hover card beside a nameplate (desktop pointer, touch tap, VR laser) — after gaze, before render
initPlates({ camera, canvas, scene, remotes, myPos: () => (getMe() ? myState.pos : null), presenting: () => isPresenting(),
  mentionPerson, colorFor, personMenu: (n, x, y) => (isPhone() ? personSheet(n) : personMenuAt(n, x, y)), personStrip });
registerSystem('plates', (dt, t, now) => updatePlates(now));
registerSystem('build', () => updateBuild());
registerSystem('promote-tail', () => drainPromoteTail());        // §16.2.C: promote
                                 // boulders (colliders/lamps/casters/mount
                                 // re-checks) land ≤~4ms/frame, not six in one;
                                 // before 'debug' so F3 sees same-frame colliders
registerSystem('debug', (dt, t, now) => updateDebug(now));       // F3 wireframes
registerSystem('send-pose', (dt, t, now) => sendPose(now));
// XR: read hands → fill intent (updateMe already moved the body) → rig follows
registerSystem('xr', (dt) => updateXR(dt));
registerSystem('water-view', () => updateWaterView());   // after the camera's last move this frame (movement, XR): the level's fog and background
registerSystem('xrvignette', (dt) => tickXRVignette(dt));   // comfort tunnel, on the XR camera (Settings › VR)
registerSystem('pixel-ratio', () => applyPendingPixelRatio());   // a resize clears the canvas: before the draw, never after
registerSystem('render', renderWorld);
registerSystem('xrmirror', () => tickXRMirror());           // desktop view while presenting (Settings › VR)
// radial-menu actions: the ring speaks through the same flows the keyboard does
bus.on('xr:sit', () => { if (!xrTrySitOn(null)) setPosture('sit'); });
bus.on('xr:stand', () => xrDismountMe('menu'));
bus.on('xr:mic', async () => { const { xrMicPress } = await import('./lib/vrmic.js'); await xrMicPress(); });   // in VR an open mic permission gets one bounded try, never a hang (vrmic.js); otherwise exactly toggleMic
bus.on('xr:select', (id) => sceneSelect(id));
globalThis.__waterDebug = waterDebug;
let _pulseAt = 0;
registerSystem('pulse', (dt, t, now) => {
  if (now - _pulseAt < 1000) return;
  _pulseAt = now;
  governPerformance(perf.fps);
  paintHud();
});

startFrame();   // explicit — the loop starts only after identity resolved
initXR();               // the VR chip appears only where immersive-vr is supported
bindXRSelf(() => getMe());   // first-person split + own-label hide need the body
bindXRBodySelf(() => getMe());
setPoseOverride(() => ((isPresenting() || xrSimActive()) ? { yaw: xrAvatarYaw() ?? undefined, pitch: xrLookPitch(), xr: xrWire() ?? undefined } : null));

// Idle bandwidth streams the rest of the library into the HTTP cache — fire
// and forget; it waits out the boot and yields to every real load on its own
// (stats live at __ewPrefetch, opt out with ?prefetch=0).
startPrefetch().catch((e) => report('prefetch', e));

// ---------------------------------------------------------------- debug

// setVoice(name): point at a model on disk at any time, the same path a human's picker uses (loadFromFiles), so an
// agent never restarts to change voice; ?voice= just calls it once at boot.
async function setVoice(name) {
  if (!name) {                       // setVoice(null) — go quiet, keep the lane
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
// Callable from a console, from a harness, or by an agent mid-session.
if (typeof window !== 'undefined') window.setVoice = setVoice;
{
  const want = new URLSearchParams(location.search).get('voice');
  if (want) setVoice(want).catch((e) => console.warn('[voice] ?voice failed:', e));
}

// Opt-in synthesized voice: ?tts or ?tts=<port>. Absent — the overwhelmingly
// common case — nothing connects and the microphone stays the only source, so
// a human client is byte-for-byte unaffected.
{
  const q = new URLSearchParams(location.search);
  if (q.has('tts')) {
    const port = Number(q.get('tts')) || 8927;
    import('./lib/piperbridge.js')
      .then((m) => m.initPiperVoice({ port }))
      .then(async (ok) => {
        console.log(ok ? `[voice] synthesized voice ready on :${port}`
                       : `[voice] no synthesizer on :${port} — falling back to browser speech`);
        if (!ok) {
          // an unreachable TTS endpoint falls back to the browser's own voice (browservoice.js): worse than Piper,
          // better than silence
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
        // (the own-say hook is installed once at boot; a second would speak each line twice)
        // A body that registered a voice opens the mic lane so the sender exists before the first utterance.
        // Install the probe seam BEFORE anything that can hang: toggleMic() awaits a source.
        globalThis.__voiceProbe = () => ({ ...vs.mouthInfo(), track: vs.genTrackInfo() });
        globalThis.__voiceSpeak = (t) => vs.speak(t);   // the APP's mouth, for probes
        const { toggleMic, micOn } = await import('./lib/micstate.js');
        // Open the lane the transport owns: the SFU bridge first, else micstate's toggleMic. The actor is CONFIG.name
        // (`me` isn't in scope here).
        if (typeof window.__sfuMic === 'function') {
          if (!window.__sfuMicOn?.()) await window.__sfuMic();
        } else if (!micOn()) {
          await toggleMic(CONFIG.name);
        }
        console.log('[voice] TTS wiring complete');
      })
      // 🔴 NEVER SWALLOW THIS. It was `.catch(() => {})`, so anything after the
      // "voice ready" line could throw and vanish while the log still claimed
      // success — the exact shape of a check that did not run.
      .catch((e) => console.error('[voice] TTS wiring failed:', e?.message || e));
  }
}

globalThis.__ambientDebug = () => ambientDebug();
// my own body, for console probes
globalThis.__me = () => getMe();
// every body in the scene, mine and the remotes, for console probes (the avatars are otherwise module-private)
globalThis.__bodies = () => [
  ...(getMe() ? [['me', getMe()]] : []),
  ...[...remotes.entries()].map(([id, r]) => [id, r.avatar]),
].filter(([, av]) => av).map(([who, av]) => ({
  who,
  limp: !!av._limp,
  clip: av.currentSlot ?? null,
  // exactly one of these should be true of a limp body: the local sim owns the
  // hair and wings, or three-vrm does
  simOwnsDressing: !!av.__simHair,
  springbonesRunning: !av.__simHair && !!av.vrm?.springBoneManager,
  avatar: av,
}));
// One command anyone can paste to answer "why is it silent?" from their console:
// context state, how many sources exist, whether the gesture hook is waiting.
globalThis.__audioState = () => audioState();
// the audio isolation test, inside the world page; call it from the console. It needs a click first for the
// context, so it reports the context state rather than pretending.
globalThis.testAudioLayers = async () => {
  // Use the SHARED context. This used to make its own, which on a page already
  // holding five was the sixth — i.e. the diagnostic itself could exhaust the
  // budget and then report silence it had caused.
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

// the water's waves run on the world's synced clock, so the swell a swimmer rises on is the one everyone sees
setWaveClock(() => participants.serverNow());

const EW = globalThis.EW = {
  me: () => getMe(), remotes, entities, myState, THREE, net, scene, camera, renderer, bus, sendRequest,
  avatarMounts, serverNow, bagOf, bags,   // who sits where (presence), the sequencer's clock the seats' signals read, a thing's fold record / every thing's
  seatSocket, socketsOn,   // a seat ({to: <socket id>}) as {id, host, name, sock}; a thing's sockets (its socket children)
  skyArgs, setPosable, get posable() { return posable(); },
  // POSING from the console — the same verbs an agent's tools have:
  // EW.pose, EW.clearPose and EW.animate (client/lib/posecommands.js says how).
  ...poseCommands({ state: myState, sendPuppet, play: (a) => { getMe()?.playAnimation(a); sendAnim(a); } }),
  // TERRAIN (owner): EW.terrain(patch) edits the world's CURRENT terrain bag rather than replacing it, so
  //   EW.terrain({ features: [{ type: 'hill', x: 30, z: -20, radius: 18, height: 9 }] })
  // keeps the seed, size and tint. Feature types (shared/terrainshape.js): hill {x,z,radius,height} (negative
  // = pit), ridge {x1,z1,x2,z2,radius,height} (negative = valley), flatten {x,z,radius,height,edge?}.
  // Heightmaps: the 🌿 ground panel's ⬇ export / ⬆ import, or GET /heightmap?world=<name>.
  terrain: (patch = {}) => {
    const cur = terrainEditBase() ?? { seed: 7, size: 160, segments: 200, amplitude: 2.6, flatRadius: 16 };
    const next = noteTerrainSent({ ...cur, ...patch });   // a second quick edit composes with this one
    sendRequest('set', { id: '@world', component: 'terrain', value: next });   // the ground is @world's terrain component
    return next;
  },
  get terrainArgs() { return currentTerrainArgs(); },
  // the ground as walking reads it, and whether a heightmap terrain is still waiting on its image
  groundAt: (x, z) => heightAt(x, z), get hasTerrain() { return hasTerrain(); },
  get terrainPending() { return terrainPending(); },
  setPushable, get pushable() { return pushable(); }, dragState,
  // reach: aim a hand at a named contact point (the palm meets the surface), [who, name], a point, or a function
  // (re-solved per frame, local only). Serializable targets ride the presence stream (reachnet) so others see the
  // arm. EW.reach('rightHand', 'head_top') · EW.reach('rightHand', ['mythos', 'shoulder_l'])
  reach: (key, target, opts) => {
    if (typeof target === 'function') return getMe()?.setReach(key, target, opts);
    const err = setMyReach(key, target, opts);
    if (err) { console.warn(`[reach] ${err}`); return false; }
    return true;
  },
  // landmarks: named contact points, derived per body from its own mesh.
  // EW.landmarks() derives + caches; EW.showLandmarks() draws them to be
  // LOOKED at, which is the only check the derivation cannot do itself.
  landmarks: (who) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    return av.__marks;
  },
  // Where a named contact point on a body IS, right now, in world space.
  // `standoff` lifts it off the skin so a hand rests ON it, not inside it.
  // This is the piece a touch is made of:
  //   EW.reach('rightHand', () => EW.contactAt('mythos', 'shoulder_l', 0.02))
  contactAt: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? hit.pos.toArray() : null;
  },
  // which contact points can a hand actually reach on this body (one pure solve per point and hand); reachVersion
  // is bumped whenever the solver changes, so a diagnostic can prove which code produced its numbers
  reachVersion: 'reach-6 contact-allowance 2026-08-20',
  // Which body is being worn — vrm.scene.name is often blank, and "which rig"
  // is the first question when one person's arm does something another's does
  // not.
  get avatarPath() { try { return getMyAvatarPath() || '(unknown)'; } catch { return '(unknown)'; } },
  reachAudit: (who, standoff = 0.02) => {
    // landmarks come from the body being TOUCHED; the reaching chains are always mine
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
        // A limb cannot meaningfully touch itself: scoring the left hand
        // against a point ON the left arm returns a triumphant 0mm that means
        // nothing. Skip the chain that owns the landmark.
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
  // Position AND the surface normal, so a reach can put the PALM on it.
  // EW.reach('rightHand', () => EW.contactFrame('mythos', 'shoulder_l'))
  contactFrame: (who, name, standoff = 0.02) => {
    const av = who ? remotes.get(who)?.avatar : getMe();
    if (!av) return null;
    av.__marks ??= deriveLandmarks(av);
    const e = av.__marks.get(canonicalPoint(name) ?? name);
    const hit = e && landmarkWorld(e, standoff);
    return hit ? { pos: hit.pos.toArray(), normal: hit.normal.toArray() } : null;
  },
  // paint the side of the hand the code believes is the PALM: a green disc just off the skin, following the bone
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
  physics: physicsApi, // grab/put/throw/drop/punt as door requests (thingphysics.js): what runtime mods script against
  mods: modsApi,     // list/put/run/stop your local runtime client scripts (🧩); put and run need your click
  bodysim: { engine: bodyEngine, setEngine: setBodyEngine, list: listBodyEngines },  // swappable body physics
  foldParity,        // shadow-mode drift probe (TEL0S_NOTES §11.6)
  reconcileModels,   // force a full realizer pass (idempotent — §11.4)
  materials: materialsDebug,   // factory counters + live weather uniforms (§12.3)
  lightrig: rigDebug,          // slot pool + request table (§12.4)
  lampShadow: lampShadowState,   // the chest lamp's shadow map + derived bias
  setLampShadow,                 // ({map, texels, dist}) — live, bias re-derived

  governor: governorDebug,     // the two-way lever ladder (§12.6)
  residency: residencyDebug,   // real/stand-in/loading counts + sweep stats (§13.3)
  gpu: () => ({ ...renderer.info.memory, ...protoStats() }),   // bytes + proto/byte tiers
  draws: drawStats,
  foliage: () => import('./lib/foliage.js').then((m) => m.foliageDebug()),
  overdraw: (opts) => import('./lib/overdraw.js').then((m) => m.overdrawCapture(opts)),   // fragments shaded per pixel, by category
  setDrawBatching,
  frame: frameDebug,           // per-system rolling ms + strides (§14.2 6b)
  grass: grassTiles,           // tile-level draw truth (§13.2, landed 8e)
  simShown,                    // the sim as drawn: a copy of this client's sim layer at the server's clock
  grassDiag,                   // §22: `await EW.grassDiag()` — the meadow's GPU cost, attributed by difference
  setCloudQuality,             // §22b: the sky pane's tier knob, console-reachable for diagnosis
  water: waterDebug,
  warm: warmStats,             // the conductor's queue (§16.2.A)
  budget: budgetStats,         // the shared per-frame background budget: share, debt, per-lane spend/grants/denials
  lanes: () => ({ sched: schedLaneStats(), load: loadLaneStats() }),  // queue depths vs caps
  colliderCache: colliderCacheStats,   // per-lib shared BVH/lie bytes (§16.2.C)
};

} // end of the normal-boot branch (?mintthumbs takes the path above)
