// water — a world's one water level as a flat sheet (shared/terrainshape.js waterParams).
// Per-vertex depth (baked at build) drives shallows, colour and foam; each body's kind (shared/waterkind.js) sets its motion.
// Nothing here moves bodies: wading is the controller's rule, from the same level.
import { THREE, scene } from './core.js';
import { attribute, mix, smoothstep, vec3, float, positionGeometry, uniform, sin, cos, max, normalize, color, transformNormalToView, faceDirection, positionWorld, cameraPosition } from 'three/tsl';
import { OCEAN, RIVER, STILL, waveClock, cyc, surfaceOffset } from '../../shared/waves.js';
import { setWaterField } from './terrain.js';
import { onWorldChange } from './state.js';
import { dryAt } from './watervolumes.js';   // a cycle, used only at build time
import { waterParams } from '../../shared/terrainshape.js';
import { analyzeWater, waterGridSeg } from '../../shared/waterkind.js';

let current = null;   // { mesh, level }
const _eye = new THREE.Vector3();

// synced time wrapped to WAVE_PERIOD (shared/waves.js), so everyone sees the same swell; local time until main.js sets it
const waveT = uniform(0);
let clock = () => Date.now();
/** synced milliseconds (remotes.js serverNow). */
export function setWaveClock(fn) { clock = fn; }
/** seconds into the period; the shader and floating bodies both read it. */
export const waveTime = () => waveClock(clock());

export const waterLevel = () => current?.level ?? null;
/** for the underwater optics (watervolumes.js), or null. */
export const levelWaterInfo = () => current ? { level: current.level, color: current.color, size: current.size } : null;
/** the level plus the wave floating bodies ride (shared/waves.js), or null where there is no water. */
export function surfaceHeightAt(x, z) {
  const w = current?.analysis?.sample(x, z);
  return w ? current.level + surfaceOffset(w, x, z, waveTime()) : null;
}

/** Build (or replace, or remove) the water for terrain-verb args over the ground `heightAt`. */
export function applyWater(args, heightAt) {
  if (current) {
    if (current.mesh) {
      scene.remove(current.mesh);
      current.mesh.geometry.dispose();
      current.mesh.material.dispose();
    }
    current = null;
  }
  setWaterField(null);
  const W = waterParams(args);
  if (!W) return;
  const size = typeof args?.size === 'number' ? args.size : 80;
  // ~1 m a vertex (2 m on the biggest worlds), so a small pond is not stepped over
  const seg = waterGridSeg(size);
  // the analysis grid IS the mesh's vertex grid: rotated PlaneGeometry lists (i, j) row by row, as waterkind indexes
  const A = analyzeWater(heightAt, size, { level: W.level, kind: args.water?.kind, flow: args.water?.flow }, seg);
  // the level stands whether or not the sheet shows: wading, depth and floating read it, not the mesh
  current = { mesh: null, level: W.level, analysis: A, color: W.color, size };
  // floaters (ammodoll.js) read it through terrain.js
  setWaterField({ level: W.level, sample: (x, z) => A.sample(x, z), time: waveTime });
  const geo = new THREE.PlaneGeometry(size, size, seg, seg);
  geo.rotateX(-Math.PI / 2);
  const n = A.n, N = n * n, depth = A.depth;
  // dry vertices near water take their NEAREST water's kind/flow/shore (a BFS a few metres), so waves run up the beach
  const src = new Int32Array(N).fill(-1), q = [];
  for (let k = 0; k < N; k++) if (depth[k] > 0) { src[k] = k; q.push(k); }
  const REACH = Math.ceil(8 / A.cell);
  const hops = new Uint16Array(N);
  for (let h = 0; h < q.length; h++) {
    const k = q[h]; if (hops[k] >= REACH) continue;
    const i = k % n, j = (k - i) / n;
    for (const [di, dj] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      const ii = i + di, jj = j + dj;
      if (ii < 0 || jj < 0 || ii >= n || jj >= n) continue;
      const m = jj * n + ii;
      if (src[m] >= 0) continue;
      src[m] = src[k]; hops[m] = hops[k] + 1; q.push(m);
    }
  }
  // how far UP the shore each kind reaches (m): the sea's swash climbs; still water and rivers barely
  const RUNUP = [0.08, 0.1, 1.1];
  const runupAt = (k) => (src[k] >= 0 ? RUNUP[A.kind[src[k]]] : 0);
  const idx = geo.index.array, keep = [];
  for (let t = 0; t < idx.length; t += 3) {
    const a = idx[t], b = idx[t + 1], c = idx[t + 2];
    if (depth[a] > -runupAt(a) || depth[b] > -runupAt(b) || depth[c] > -runupAt(c)) keep.push(a, b, c);
  }
  if (!keep.length) return;   // nothing to draw; the level still stands
  geo.setIndex(keep);
  const kindw = new Float32Array(N * 3), flow = new Float32Array(N * 3), shore = new Float32Array(N * 3);
  for (let k = 0; k < N; k++) {
    const m = src[k] >= 0 ? src[k] : k;
    kindw[3 * k + A.kind[m]] = 1;
    // one ripple speed per river (waveSpeed, rounded to wrap with the clock: waterkind.js)
    flow[3 * k] = A.flow[2 * m]; flow[3 * k + 1] = A.flow[2 * m + 1]; flow[3 * k + 2] = A.comp[m] >= 0 ? A.bodies[A.comp[m]].waveSpeed ?? 0 : 0;
    shore[3 * k] = A.toShore[2 * m]; shore[3 * k + 1] = A.toShore[2 * m + 1];
    // ground slope (rise per metre): a wave lifting the water by h moves the waterline h/slope, which foam follows
    const i = k % n, j = (k - i) / n;
    const dx = (depth[j * n + Math.min(n - 1, i + 1)] - depth[j * n + Math.max(0, i - 1)]) / (2 * A.cell);
    const dz = (depth[Math.min(n - 1, j + 1) * n + i] - depth[Math.max(0, j - 1) * n + i]) / (2 * A.cell);
    shore[3 * k + 2] = Math.hypot(dx, dz);
  }
  geo.setAttribute('depth', new THREE.BufferAttribute(depth, 1));
  geo.setAttribute('wkind', new THREE.BufferAttribute(kindw, 3));
  geo.setAttribute('wflow', new THREE.BufferAttribute(flow, 3));
  geo.setAttribute('wshore', new THREE.BufferAttribute(shore, 3));

  // a swimmer looks UP at the same sheet: two-sided while a camera is near or under it (onBeforeRender, below)
  const mat = new THREE.MeshStandardNodeMaterial({ transparent: true, depthWrite: false, roughness: 0.08, metalness: 0, side: THREE.FrontSide });
  const d = attribute('depth'), K = attribute('wkind'), F = attribute('wflow'), S = attribute('wshore');
  const still = K.x, river = K.y, ocean = K.z;
  // RAW position, so both stages compute the same wave; the mesh sits at (0, level, 0) unrotated, so x/z ARE world x/z
  const px = positionGeometry.x, pz = positionGeometry.z, t = waveT;

  // ---- the surface's height above the level, and how fast it is rising, for each kind --------------
  // STILL — a breath of wind, millimetres
  const sPh = px.mul(STILL.kx).add(pz.mul(STILL.kz)).sub(t.mul(STILL.w));
  const sAmp = float(STILL.amp);
  // RIVER — standing chop carried down the channel: `a` runs along the flow, `c` across it
  const a = px.mul(F.x).add(pz.mul(F.y)), c = pz.mul(F.x).sub(px.mul(F.y));
  // cross train at 0.6× wavenumber, angled by `c`; both run whole cycles a period for a rounded F.z (waves.js RIVER_SPEED_STEP)
  const ph1 = a.sub(t.mul(F.z)).mul(RIVER.k), ph2 = ph1.mul(0.6).add(c.mul(1.7));
  const rAmp = float(RIVER.amp);
  // OCEAN — two swells along `o` (to shore), ω = √(g·k): 31 m at 7 m/s, 19 m at 5.5 m/s
  // a third of the height survives up the beach: that swash moves the waterline
  const o = px.mul(S.x).add(pz.mul(S.y)), oc = pz.mul(S.x).sub(px.mul(S.y));
  const { k1, w1, k2, w2 } = OCEAN;
  const ow1 = o.mul(k1).sub(t.mul(w1)).add(sin(oc.mul(OCEAN.crestK)).mul(OCEAN.crestBend));
  const ow2 = o.mul(k2).add(oc.mul(OCEAN.across2)).sub(t.mul(w2));
  // 0.2 m at the shore → 0.6 m offshore (the same law as shared/waves.js surfaceOffset)
  const oAmp = smoothstep(OCEAN.ampFrom, OCEAN.ampTo, d).mul(OCEAN.ampDeep - OCEAN.ampShore).add(OCEAN.ampShore).mul(ocean);
  // a touch of second harmonic peaks the crest
  const crest = (ph) => sin(ph).add(sin(ph.mul(2)).mul(OCEAN.harmonic));
  const dCrest = (ph) => cos(ph).add(cos(ph.mul(2)).mul(2 * OCEAN.harmonic));
  const disp = oAmp.mul(crest(ow1)).add(oAmp.mul(OCEAN.share2).mul(crest(ow2)))
    .add(river.mul(rAmp).mul(sin(ph1)))
    .add(still.mul(sAmp).mul(sin(sPh)));
  // ∂h/∂t: how fast the waterline is driven up or down the beach
  const rise = oAmp.mul(dCrest(ow1)).mul(-w1).add(oAmp.mul(OCEAN.share2).mul(dCrest(ow2)).mul(-w2))
    .add(river.mul(rAmp).mul(cos(ph1)).mul(F.z.mul(-RIVER.k)))
    .add(still.mul(sAmp).mul(cos(sPh)).mul(-STILL.w));
  mat.positionNode = positionGeometry.add(vec3(0, disp, 0));

  // ---- normals: the swell's slope, plus each kind's small ripples ---------------------------------
  const oSlope = oAmp.mul(dCrest(ow1)).mul(k1).add(oAmp.mul(OCEAN.share2).mul(dCrest(ow2)).mul(k2));
  // every time-driven term runs whole cycles per period (cyc), so nothing jumps at the wrap
  const sX = sin(px.mul(1.3).add(t.mul(cyc(0.5)))).mul(0.018).add(sin(pz.mul(2.1).sub(t.mul(cyc(0.4)))).mul(0.01));
  const sZ = cos(pz.mul(1.1).add(t.mul(cyc(0.45)))).mul(0.018).add(cos(px.mul(1.9).add(t.mul(cyc(0.35)))).mul(0.01));
  const along = cos(ph1).mul(0.085).add(cos(ph2).mul(0.04)), across = cos(ph2).mul(0.05);
  const rX = F.x.mul(along).sub(F.y.mul(across)), rZ = F.y.mul(along).add(F.x.mul(across));
  const nx = still.mul(sX).add(river.mul(rX.add(sX.mul(0.5)))).add(ocean.mul(S.x.mul(oSlope).negate().add(sX)));
  const nz = still.mul(sZ).add(river.mul(rZ.add(sZ.mul(0.5)))).add(ocean.mul(S.y.mul(oSlope).negate().add(sZ)));
  mat.normalNode = transformNormalToView(normalize(vec3(nx, float(1), nz)));

  // ---- foam: the uprush, ∂h/∂t over ground slope (m/s) × wave size, at the moving edge -------------------
  const wet = d.add(disp);
  const band = float(1).sub(smoothstep(0.0, 0.3, wet));
  const lineSpeed = max(rise, float(0)).div(max(S.z, float(0.04)));
  const waveSize = smoothstep(0.02, 0.25, oAmp.add(river.mul(rAmp)).add(still.mul(sAmp)));
  const uprush = smoothstep(0.15, 2.0, lineSpeed).mul(waveSize);
  const streak = smoothstep(0.86, 1.0, sin(c.mul(2.2).add(sin(a.mul(0.35)).mul(1.6))).mul(0.5).add(0.5))
    .mul(smoothstep(0.55, 1.0, sin(ph1.mul(0.4)).mul(0.5).add(0.5)));   // 0.4: whole cycles a period (waves.js)
  const foam = band.mul(float(0.08).add(uprush.mul(0.9)))
    .add(streak.mul(river).mul(0.22).mul(float(1).sub(smoothstep(0.5, 2.5, d).mul(0.6))))
    .clamp(0, 1);

  // greener in a river; deeper blue at sea with turquoise shallows
  const deep = smoothstep(0.0, 2.5, d);                    // 0 at the shore → 1 past 2.5 m
  const base = color(W.color);
  const deepCol = base.mul(still).add(mix(base, vec3(0.2, 0.3, 0.22), 0.25).mul(river)).add(mix(base, vec3(0.04, 0.2, 0.36), 0.55).mul(ocean));
  const shallowCol = base.mul(0.55).add(vec3(0.18, 0.24, 0.2)).mul(still.add(river)).add(vec3(0.22, 0.56, 0.56).mul(ocean));
  const aboveCol = mix(mix(shallowCol, deepCol, deep), vec3(0.9, 0.95, 0.94), foam);
  // fades where the wave drew back, so the last centimetres don't shimmer against the sand
  const aboveOpacity = mix(float(0.38), float(W.opacity), deep).add(foam.mul(0.3)).mul(smoothstep(-0.02, 0.04, wet)).clamp(0, 1);
  // ---- from below: Snell's window ----------------------------------------------------------------------
  // sky only within ~48.6° of straight up (critical angle, cos ≈ 0.66); past it, total internal reflection
  const up = normalize(positionWorld.sub(cameraPosition)).y;
  const snell = smoothstep(0.6, 0.72, up);
  const belowCol = mix(deepCol.mul(0.35), base.mul(1.15).add(vec3(0.08, 0.1, 0.1)), snell);
  const belowOpacity = mix(float(0.92), float(0.5), snell).mul(smoothstep(-0.02, 0.04, wet));   // the window still tints the sky
  // never select() here: it mistyped the colour as vec4 and the weather wrap emitted invalid WGSL; keep it a vec3
  const front = faceDirection.mul(0.5).add(0.5);
  mat.colorNode = mix(belowCol, aboveCol, front);
  // no water across the mouth of a dry shaft or room that reaches up through the surface
  mat.opacityNode = mix(belowOpacity, aboveOpacity, front).mul(float(1).sub(dryAt(positionWorld)));

  const mesh = new THREE.Mesh(geo, mat);
  mesh.name = 'water';
  mesh.position.y = W.level;
  mesh.renderOrder = 2;   // after the ground and the opaque world: it is seen THROUGH
  // two-sided only near or under the surface (the swell reaches ~0.6 m): a two-sided transparent sheet draws twice
  mesh.onBeforeRender = (_r, _s, cam) => {
    waveT.value = waveTime();
    const side = cam.getWorldPosition(_eye).y < W.level + 1 ? THREE.DoubleSide : THREE.FrontSide;
    if (mat.side !== side) { mat.side = side; mat.needsUpdate = true; }
  };
  mesh.userData.bodies = A.bodies.map((b) => ({ kind: b.kind, area: Math.round(b.area), width: +b.width.toFixed(1), length: +b.length.toFixed(1) }));
  scene.add(mesh);
  current.mesh = mesh;
}

// a destination without terrain never rebuilds the water, so clear it on reset or the old level (and its fog) follows
onWorldChange((ev) => { if (ev.type === 'reset') applyWater(null); });

/** for the HUD and probes (shared/waterkind.js sample). */
export const waterAt = (x, z) => current?.analysis?.sample(x, z) ?? null;
