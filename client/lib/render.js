// The live world's render path, shared by animation and frame capture.
import { THREE, renderer, scene, camera } from './core.js';
import { CONFIG, bus, tee } from './base.js';
import { DrawBatches } from './draw_batches.js';
import { warm, warmDepth, P_AMBIENT } from './warmqueue.js';
import { gpuBegin, gpuEnd } from './gputime.js';
import { quadMaterial } from './quadcolour.js';

const batches = new DrawBatches({ warm: async (mesh, live) => {
  let error;
  await warm('instance pipelines', async () => {
    if (!live()) return;
    const culled = mesh.frustumCulled;
    mesh.frustumCulled = false;
    try { await renderer.compileAsync(mesh, camera, scene); }
    catch (e) { error = e; }
    finally { mesh.frustumCulled = culled; }
  }, { p: P_AMBIENT });
  if (error) throw error;
  if (mesh.castShadow && live()) await warmDepth('instance shadows', () => live() ? [mesh] : []);
} });
batches.enabled = CONFIG.params.get('batching') !== '0';
let lastRender = {};

/** Any pass but the eye pass (bake, thumbnail, mirror): while presenting, every render() rewrites the stereo camera
 *  from `cam.parent`, so a parentless camera pops the eyes to the playspace origin; XR is off around it. */
export function renderAside(sc, cam, target = null) {
  const xr = renderer.xr;
  if (!xr?.isPresenting) { const rt = renderer.getRenderTarget(); renderer.setRenderTarget(target); try { return renderer.render(sc, cam); } finally { renderer.setRenderTarget(rt); } }
  const was = xr.enabled, rt = renderer.getRenderTarget();
  xr.enabled = false;
  try { renderer.setRenderTarget(target); return renderer.render(sc, cam); }
  finally { renderer.setRenderTarget(rt); xr.enabled = was; if (xr.isPresenting) xr.updateCamera(camera); }   // rebuild the eyes from the RIG before anything else renders
}

// RENDER CENSUS: a second render into the eye framebuffer with a non-XR camera stamps a wide frame across both eyes
export const renderCensus = { perFrame: 0, maxPerFrame: 0, foreign: null, frames: 0 };
let mainPassCam = null;
if (typeof renderer.render === 'function') { const orig = renderer.render.bind(renderer);   // node suites mock a renderer without one
  renderer.render = (sc, cam) => {
    // a lost GPU draws nothing, by ANY pass: each render into a dead device throws before three's callDepth--, leaving
    // a new render context and a retained shader build behind
    if (globalThis.__gpuLost?.fired) return;
    renderCensus.perFrame++;
    if (renderer.xr?.isPresenting && cam !== mainPassCam) {
      const rt = renderer.getRenderTarget();
      renderCensus.foreign = { cam: cam?.type, name: cam?.name || null, fov: cam?.fov ?? null, parent: !!cam?.parent, target: rt ? (rt.isXRRenderTarget ? 'xr' : 'rt') : 'canvas', xrEnabled: renderer.xr.enabled, t: +performance.now().toFixed(0) };
    }
    return orig(sc, cam);
  }; }
// …and compiles nothing (every pipeline warm goes through here): a page stopped after a second loss stays connected
if (typeof renderer.compileAsync === 'function') { const origCompile = renderer.compileAsync.bind(renderer);
  renderer.compileAsync = (...args) => (globalThis.__gpuLost?.fired ? Promise.resolve() : origCompile(...args)); }
export function renderCensusTick() { renderCensus.frames++; if (renderCensus.perFrame > renderCensus.maxPerFrame) renderCensus.maxPerFrame = renderCensus.perFrame; renderCensus.perFrame = 0; }
export const renderCensusPeek = () => renderCensus.foreign;
export function renderCensusTake() { const o = { max: renderCensus.maxPerFrame, foreign: renderCensus.foreign }; renderCensus.maxPerFrame = 0; renderCensus.foreign = null; return o; }

// ENTRY CURTAIN: a closed dark sphere round the head instead of the world, so the headset gets frames (no runtime
// construct) while the scene compiles behind it
let curtain = null, curtainOn = false; const _yAxis = new THREE.Vector3(0, 1, 0);
export function setXRCurtain(on) {
  curtainOn = !!on;
  if (curtainOn && !curtain) {
    curtain = new THREE.Scene();
    const shell = new THREE.Mesh(new THREE.SphereGeometry(4, 24, 16), new THREE.MeshBasicNodeMaterial({ color: 0x0b0f12, side: THREE.BackSide, depthTest: false, depthWrite: false }));
    shell.frustumCulled = false; shell.renderOrder = 0; curtain.add(shell); curtain.userData.shell = shell;
    // THE SPLASH, head-locked 1.6 m out: the mark (read from #splash: one drawing of it), repainted 3×/s
    const c = document.createElement('canvas'); c.width = 1024; c.height = 1024; const g = c.getContext('2d');
    const tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace;
    const logo = document.querySelector('#splash .sp-logo');
    const paths = [...(logo?.querySelectorAll('path') ?? [])].map((el) => new Path2D(el.getAttribute('d')));   // at rest (boot is over)
    const [vbx, vby, vbw] = (logo?.getAttribute('viewBox') ?? '0 0 100 100').split(/[\s,]+/).map(Number);
    const font = getComputedStyle(document.documentElement).getPropertyValue('--font').trim() || 'system-ui, sans-serif';
    const paint = (dots) => {
      g.clearRect(0, 0, 1024, 1024); g.fillStyle = '#8fe8c8';
      { const k = 274.4 / vbw; g.save(); g.translate(512 - k * (vbx + vbw / 2), 142 - k * vby); g.scale(k, k); for (const pth of paths) g.fill(pth); g.restore(); }   // a 274 px square, centred, top at 142
      g.textAlign = 'center'; g.textBaseline = 'middle';
      g.font = `500 64px ${font}`; g.letterSpacing = '0.34em'; g.fillText('eidoverse', 512 + 11, 520);
      g.globalAlpha = 0.45; g.font = `400 30px ${font}`; g.letterSpacing = '0.58em'; g.fillText('worlds', 512 + 9, 575); g.globalAlpha = 1;
      g.letterSpacing = '0.08em'; g.font = `400 40px ${font}`; g.textAlign = 'left';
      const w = g.measureText('entering VR').width; g.fillText('entering VR' + '.'.repeat(dots), 512 - w / 2, 690);
      tex.needsUpdate = true;
    };
    paint(0); curtain.userData.paint = paint; curtain.userData.lastDots = -1;
    const text = new THREE.Mesh(new THREE.PlaneGeometry(1.2, 1.2), new THREE.MeshBasicNodeMaterial({ map: tex, transparent: true, depthTest: false }));
    quadMaterial(text, renderer);   // as authored, not ACES-washed
    text.frustumCulled = false; text.renderOrder = 1; curtain.add(text); curtain.userData.text = text;
  }
}
export const xrCurtainOn = () => curtainOn;
/** The world from another camera, as the main pass does (batches included): the desktop mirror. */
export const renderWorldFrom = (cam) => batches.render(renderer, scene, cam);
let healed = 0;
// EW.overdraw holds the live frame while it swaps in counting clones
let worldHold = false;
export function setWorldHold(on) { worldHold = !!on; }
export function renderWorld() {
  if (worldHold) return;
  if (globalThis.__gpuLost?.fired) return;
  mainPassCam = camera;
  // SELF-HEAL: an aborted frame leaves its target bound, and every later frame misses the canvas; off-XR, a bound
  // target here can only be that
  if (!renderer.xr?.isPresenting && renderer.getRenderTarget() !== null) {
    const rt = renderer.getRenderTarget(); renderer.setRenderTarget(null);
    if (healed++ < 3) tee(`[render] unbound a stale target at frame start (${rt.constructor.name} ${rt.width}x${rt.height}) — an earlier frame aborted mid-render`);
  }
  if (curtainOn && renderer.xr?.isPresenting) {
    renderer.xr.updateCamera(camera);
    const xc = renderer.xr.getCamera(); const e = xc.matrixWorld.elements; curtain.userData.shell.position.set(e[12], e[13], e[14]);
    { const t = curtain.userData.text; if (t) { const yaw = Math.atan2(e[8], e[10]); t.quaternion.setFromAxisAngle(_yAxis, yaw); t.position.set(e[12] - Math.sin(yaw) * 1.6, e[13], e[14] - Math.cos(yaw) * 1.6); } }   // LEVEL: yaw follows the head, pitch/roll do not
    { const d = Math.floor(performance.now() / 300) % 4; if (d !== curtain.userData.lastDots) { curtain.userData.lastDots = d; curtain.userData.paint?.(d); const t = curtain.userData.text; if (t?.material?.map) t.material.map.needsUpdate = true; } }
    renderer.render(curtain, camera);
    return;
  }
  const before = { ...renderer.info.render };
  if (renderer.xr?.isPresenting) renderer.xr.updateCamera(camera);   // WE build the eyes (cameraAutoUpdate is off): the eye pass starts from the rig
  gpuBegin();                     // no-op while the timer is off
  try { batches.render(renderer, scene, camera); } finally { gpuEnd(); }
  const after = renderer.info.render;
  // this render's passes only; never reset the renderer's shared counters (other diagnostics own their intervals)
  lastRender = {
    drawCalls: after.drawCalls - before.drawCalls,
    triangles: after.triangles - before.triangles,
    points: after.points - before.points,
    lines: after.lines - before.lines,
    passes: after.calls - before.calls,
  };
}

/** On-demand, before batching. Material groups are not GPU draws (shadows, transparency, output add passes). */
function sourceSurvey() {
  const frustum = new THREE.Frustum().setFromProjectionMatrix(
    new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse),
    camera.coordinateSystem, camera.reversedDepth);
  const types = new Map(), libraries = new Map();
  const visit = (o, lib = null) => {
    if (!o.visible) return;
    lib = o.userData.lib ?? lib;
    if ((o.isMesh || o.isSprite || o.isLine || o.isPoints) && o.layers.test(camera.layers)
      && (!o.isInstancedMesh || o.count > 0)
      && (!o.frustumCulled || (o.isSprite ? frustum.intersectsSprite(o,camera) : frustum.intersectsObject(o)))) {
      const groups = Array.isArray(o.material)
        ? o.geometry.groups.filter((g) => o.material[g.materialIndex]?.visible).length
        : o.material?.visible ? 1 : 0;
      if (groups) {
        const type = o.userData.drawBatchSource ? 'library' : o.isSkinnedMesh ? 'skinned'
          : o.isInstancedMesh ? 'instanced' : o.isSprite ? 'sprites' : o.isLine ? 'lines' : 'other';
        let row = types.get(type);
        if (!row) types.set(type, row = { type, visibleObjects: 0, materialGroups: 0 });
        row.visibleObjects++; row.materialGroups += groups;
        if (lib) libraries.set(lib, (libraries.get(lib) ?? 0) + groups);
      }
    }
    for (const child of o.children) visit(child,lib);
  };
  visit(scene);
  return { types: [...types.values()], libraries: [...libraries].map(([lib,materialGroups]) => ({lib,materialGroups}))
    .sort((a,b) => b.materialGroups-a.materialGroups).slice(0,20) };
}

export const drawStats = ({ sources = false } = {}) => ({ render: lastRender, batching: batches.debug(),
  ...(sources ? { sources: sourceSurvey() } : {}) });
export function setDrawBatching(on) {
  batches.enabled = !!on;
  if (!on) batches.dispose();
  return drawStats();
}
bus.on('world-reset', () => batches.dispose());
