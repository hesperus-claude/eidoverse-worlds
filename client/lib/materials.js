// materials — the factory. Every world material is wrapped at CREATION, before its first compile, with its final
// shader-graph shape (wetness, cloud shade, shadow-receive policy), so weather and sky only ever write uniforms: a
// graph-shape change recompiles the pipeline (TEL0S_NOTES §12). Driven by folded state (effectiveSky), not upstream.
//   wetness     — a shape-identical port of upstream's weather wrapMaterial, driven by our uniforms
//   cloud shade — our own field (two taps of a seeded tileable noise, wind-scrolled, sun-projected); upstream's needs
//                 textures that don't exist before the sky modules do
// Prepared meshes are marked userData.noWet + noCloudShadow so upstream sweeps skip them; unprepared ones (mods)
// still get swept. Why: docs/research/material-factory.md.

import { THREE, TSL, sun, ground, renderer } from './core.js';
import { report, CONFIG, bus } from './base.js';
import { serverNow } from './serverclock.js';   // a server stamp is read on the authority's clock
import { registerFoliage } from './foliage.js';
import { state } from './state.js';
import { effectiveSky } from '../../shared/forecast.js';

const {
  Fn, If, uniform, texture, float, vec2, vec3, vec4, mix, clamp, smoothstep,
  fract, floor, dot, length, positionWorld, positionView, normalWorld,
  materialColor, materialRoughness, materialMetalness, screenCoordinate, bool,
} = TSL;

// ---- the caster fade (~300 ms dither): materials are shared across clones, so the amount is read per OBJECT from one
// module-level node (one WGSL shape for every depth pass); a non-node material hard-flips.
const uShadowFade = uniform(1).onObjectUpdate(({ object }) => object?.userData?.shadowFade ?? 1);
const FADE_MASK = fract(float(52.9829189).mul(fract(dot(screenCoordinate.xy, vec2(0.06711056, 0.00583715))))).lessThan(uShadowFade);

// ---- the shared uniform state -----------------------------------------------
// one set for the whole scene, like upstream's: writing them costs nothing per material

const U = {
  // wetness: wetTint is never written, but it is part of the wrapped graph's shape
  wet: uniform(0),
  wetTint: uniform(new THREE.Color(1, 1, 1)),
  puddleK: uniform(1),
  // cloud shade
  cloudStrength: uniform(0),                    // 0 ≡ gain exactly 1.0 (off)
  cloudLo: uniform(0.7),
  cloudHi: uniform(1.0),
  cloudOff: uniform(new THREE.Vector2(0, 0)),   // sun-projection offset (m)
  scroll1: uniform(new THREE.Vector2(0, 0)),    // wind accumulators (m)
  scroll2: uniform(new THREE.Vector2(0, 0)),
};

// ---- the cloud noise texture: the graphs bind the texture OBJECT, so its identity never changes. Seeded
// (mulberry32): same field on every client.

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCloudNoise(size = 256) {
  const rand = mulberry32(0x9e3779b9);
  const OCT = [{ cells: 4, amp: 0.5 }, { cells: 8, amp: 0.3 }, { cells: 16, amp: 0.2 }];
  const lattices = OCT.map((o) => {
    const arr = new Float32Array(o.cells * o.cells);
    for (let i = 0; i < arr.length; i++) arr[i] = rand();
    return arr;
  });
  const smooth = (t) => t * t * (3 - 2 * t);
  const data = new Uint8Array(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let v = 0;
      for (let o = 0; o < OCT.length; o++) {
        const { cells, amp } = OCT[o];
        const lat = lattices[o];
        const fx = (x / size) * cells, fy = (y / size) * cells;
        const ix = Math.floor(fx), iy = Math.floor(fy);
        const tx = smooth(fx - ix), ty = smooth(fy - iy);
        const w = (cx, cy) => lat[(cy % cells) * cells + (cx % cells)];
        v += amp * ((w(ix, iy) * (1 - tx) + w(ix + 1, iy) * tx) * (1 - ty)
          + (w(ix, iy + 1) * (1 - tx) + w(ix + 1, iy + 1) * tx) * ty);
      }
      const b = Math.max(0, Math.min(255, Math.round(v * 255)));
      const k = (y * size + x) * 4;
      data[k] = data[k + 1] = data[k + 2] = b;
      data[k + 3] = 255;
    }
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = true;
  tex.needsUpdate = true;
  return tex;
}

const noiseTex = makeCloudNoise();
// primed here (§16.1c): it rides inside every colorNode, where collectTextures can't see it; the device exists already
try { renderer.initTexture(noiseTex); } catch { /* first bind will get it */ }
// world-metres per tile; two octaves at different scales/speeds so the field boils instead of sliding as one sheet
const CLOUD_SCALE1 = 1 / 420;
const CLOUD_SCALE2 = 1 / 97;
const CLOUD_H = 300;   // nominal cloud-base height the sun projection assumes

// ---- the wetness wrap (ported shape-identical from weather_system.js) -------
// kept 1:1 with upstream's wrapMaterial (hash2/vnoise2 included), so the look matches; only the uniforms are ours

// Fn() layouts, not plain closures: a layout-less TSL function is inlined at every call site (~20× per material,
// seconds of NodeBuilder source-gen). Types: vec2→float.
const hash2 = Fn(([p]) => {
  const a = fract(vec3(p.x, p.y, p.x).mul(0.1031));
  const d = dot(a, vec3(a.y, a.z, a.x).add(33.33));
  const b = a.add(d);
  return fract(b.x.add(b.y).mul(b.z));
}, { name: 'ewHash2', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });
const vnoise2 = Fn(([p]) => {
  const i = floor(p), f = fract(p);
  const sm = f.mul(f).mul(f).mul(f.mul(f.mul(6).sub(15)).add(10)); // quintic: C2, no lattice creases
  const a = hash2(i), b = hash2(i.add(vec2(1, 0)));
  const c = hash2(i.add(vec2(0, 1))), d = hash2(i.add(vec2(1, 1)));
  return mix(mix(a, b, sm.x), mix(c, d, sm.x), sm.y);
}, { name: 'ewVnoise2', type: 'float', inputs: [{ name: 'p', type: 'vec2' }] });

/** 1.0 under open sky, dipping toward (1 - strength) under a cloud. Fresh subtree per material, shared uniforms. */
function cloudShade() {
  const p = positionWorld.xz.add(U.cloudOff);
  const n1 = texture(noiseTex, p.add(U.scroll1).mul(CLOUD_SCALE1)).r;
  const n2 = texture(noiseTex, p.add(U.scroll2).mul(CLOUD_SCALE2)).r;
  const n = n1.mul(0.72).add(n2.mul(0.28));
  return float(1).sub(smoothstep(U.cloudLo, U.cloudHi, n).mul(U.cloudStrength));
}

// the ungated puddle noise — only for the ?pudgate=0 A/B
function pnUngated() {
  const warp = vec2(
    vnoise2(positionWorld.xz.mul(0.045)),
    vnoise2(positionWorld.xz.mul(0.045).add(vec2(37.7, 11.3))),
  ).sub(0.5).mul(2.2);
  return vnoise2(positionWorld.xz.mul(0.35).add(warp))
    .add(vnoise2(positionWorld.xz.mul(0.09)).mul(0.6));
}

function wrapMaterial(mat, receiver, pbr) {
  const upMask = clamp(normalWorld.y, 0, 1).pow(2).mul(U.wet);
  // crossed-card foliage carries upward normals for clump lighting, so it can opt out of puddles
  const puddleGate = (mat.userData?.noPuddles || receiver?.userData?.noPuddles)
    ? float(0) : float(1);
  const flat = smoothstep(0.985, 0.998, normalWorld.y);
  // value-exact cost gates: a no-puddles material never builds the 16-hash noise (GLSL can't fold x*0), and the taps
  // run only above wet 0.35 (below it the factor is 0), in a uniform branch
  const gates = CONFIG.params.get('pudgate') !== '0';   // ?pudgate=0: the pre-gate graph (tools/puddle-gate-probe.mjs)
  const noPud = gates && (!pbr || !!(mat.userData?.noPuddles || receiver?.userData?.noPuddles));
  const pnNode = noPud ? null : !gates ? pnUngated() : Fn(() => {
    const pnv = float(0).toVar();
    If(U.wet.greaterThan(0.35), () => {
      const warp = vec2(
        vnoise2(positionWorld.xz.mul(0.045)),
        vnoise2(positionWorld.xz.mul(0.045).add(vec2(37.7, 11.3))),
      ).sub(0.5).mul(2.2);
      const pn = vnoise2(positionWorld.xz.mul(0.35).add(warp))
        .add(vnoise2(positionWorld.xz.mul(0.09)).mul(0.6));
      pnv.assign(pn);
    });
    return pnv;
  })();
  // distance-faded (procedural noise has no mips). Eye distance is view-space length, never positionWorld −
  // cameraPosition: under stereo rendering cameraPosition has no camera and the object draws nothing in VR.
  const pDist = pbr ? length(positionView) : null;
  // shape × gate, always: sharpening after the wetness multiply would zero all puddles below full wet
  const pShape = (pbr && !noPud)
    ? smoothstep(0.97, 1.13, pnNode).mul(flat).mul(U.puddleK).mul(puddleGate).mul(float(1).sub(smoothstep(160, 450, pDist)))
    : float(0);
  const puddle = pbr ? smoothstep(0.25, 0.6, pShape).mul(smoothstep(0.35, 0.9, U.wet)) : float(0);
  // RGBA once: alpha must survive for cutout silhouettes (foliage cards)
  const baseColor4 = vec4(mat.colorNode ?? materialColor);
  const baseRgb = baseColor4.rgb;
  // wetness reads through gloss, not blackness — mild darkening only
  const darkened = baseRgb.mul(mix(float(1), float(0.68), upMask.mul(0.85)));
  const wetCol = darkened.mul(mix(vec3(1, 1, 1), U.wetTint, upMask.mul(0.6)));
  // pseudo-depth from the shape mask: shallow rims, centres deepen and cool
  const pDepth = smoothstep(0.3, 1.0, pShape);
  const waterFloor = wetCol.mul(mix(float(0.96), float(0.62), pDepth))
    .mul(mix(vec3(1, 1, 1), vec3(0.84, 0.91, 1.0), pDepth.mul(0.7)));
  const finalWetRgb = mix(wetCol, waterFloor, puddle);
  // cloud shade: PBR surfaces only, matching upstream's cloud sweep
  const rgb = pbr ? finalWetRgb.mul(cloudShade()) : finalWetRgb;
  mat.colorNode = vec4(rgb, baseColor4.a);
  if (pbr) {
    const baseRough = mat.roughnessNode ?? materialRoughness;
    mat.roughnessNode = mix(mix(baseRough, float(0.10), upMask.mul(0.8)), float(0.045), puddle);
    // water stays dielectric: low roughness supplies its Fresnel, not metal
    const baseMetal = mat.metalnessNode ?? materialMetalness;
    mat.metalnessNode = mix(baseMetal, float(0), puddle);
  }
  mat.needsUpdate = true;
}

// ---- the seam ---------------------------------------------------------------

const preparedMats = new WeakSet();
const stats = { meshes: 0, wrapped: 0, unlit: 0 };

/** Upgrade a transmissive material to MeshPhysicalNodeMaterial, or WebGPU draws it as nothing. Copies by property
 *  name; textures shared; non-transmissive materials left alone (costlier compile). */
// source → replacement, memoised (WeakMap, weak both sides) so meshes sharing a material share one replacement
const TRANSMISSIVE_REPLACEMENT = new WeakMap();
const TRANSMISSIVE_UPGRADED = new WeakSet();
function upgradeTransmissive(mesh, m) {
  if (!m || m.isNodeMaterial || TRANSMISSIVE_UPGRADED.has(m)) return m;
  const shared = TRANSMISSIVE_REPLACEMENT.get(m);
  if (shared) return shared;
  if (!(m.transmission > 0)) return m;
  const Node = THREE.MeshPhysicalNodeMaterial;
  if (!Node) return m;                       // non-WebGPU build: nothing to do
  let nm;
  try {
    nm = new Node();
    const SKIP = new Set(['uuid', 'id', 'type', 'version', 'isMeshPhysicalMaterial',
                          'isMeshStandardMaterial', 'isMaterial', '_listeners']);
    // prototype accessors too: `transmission` is a prototype getter/setter, invisible to Object.keys()
    const keys = new Set(Object.keys(m));
    for (let proto = Object.getPrototypeOf(m); proto && proto !== Object.prototype;
         proto = Object.getPrototypeOf(proto)) {
      for (const [k, d] of Object.entries(Object.getOwnPropertyDescriptors(proto))) {
        if (typeof d.get === 'function' && typeof d.set === 'function') keys.add(k);
      }
    }
    for (const k of keys) {
      if (SKIP.has(k) || k.startsWith('is') || k.startsWith('_')) continue;
      const v = m[k];
      if (v === undefined) continue;
      // copy Color/Vector into the target's instance: assigning shares it, so a tweak to one moves the other
      if (nm[k]?.isColor && v?.isColor) nm[k].copy(v);
      else if (nm[k]?.isVector2 && v?.isVector2) nm[k].copy(v);
      else if (nm[k]?.isVector3 && v?.isVector3) nm[k].copy(v);
      else nm[k] = v;
    }
    nm.name = m.name;
    // transmission composites against the backdrop: transparent pass, as warmqueue.js already pre-warms it
    nm.transparent = true;
    nm.needsUpdate = true;
  } catch (e) {
    report?.('transmission upgrade', e);
    return m;
  }
  TRANSMISSIVE_UPGRADED.add(nm);
  TRANSMISSIVE_REPLACEMENT.set(m, nm);   // the next mesh sharing `m` reuses it
  stats.transmissive = (stats.transmissive ?? 0) + 1;
  return nm;
}

/** Wrap one material, once; Basic (unlit) materials are skipped. Returns whether it was wrapped. */
export function prepareMaterial(mat, receiver = null) {
  if (!mat?.isNodeMaterial || preparedMats.has(mat)) return false;
  preparedMats.add(mat);
  if (mat.isMeshBasicNodeMaterial) { stats.unlit++; return false; }
  // upstream's PBR duck test: PBR gets cloud shade + roughness/metalness; other lit (MToon) gets the wet colour only
  const pbr = mat.isMeshStandardNodeMaterial || mat.isMeshPhysicalNodeMaterial
    || (mat.roughness !== undefined && mat.metalness !== undefined);
  // a clone of a prepared material (matoverride) copies the wrapped colour/roughness nodes and userData: wrapping it again
  // would compose wetness and cloud shade twice
  if (!mat.userData.envWrapped) { wrapMaterial(mat, receiver, pbr); mat.userData.envWrapped = true; }
  // a clone of a prepared material (matoverride) carries the node AND the flag: never compose the fade with itself
  if (!mat.userData.shadowFade) {
    const mask = mat.maskShadowNode ?? mat.maskNode;   // maskShadowNode wins over maskNode in three's depth pass
    mat.maskShadowNode = mask ? FADE_MASK.and(bool(mask)) : FADE_MASK;
    mat.userData.shadowFade = true;
  }
  stats.wrapped++;
  return true;
}

// no-cast body meshes: kintsugi seams (they self-shadow into scratches) and wings (castShadow is per object: the only
// way to drop wing-on-wing shadow, at the cost of wings shadowing body and ground)
export const BODY_NO_CAST = /^(GOLD|wings)/;

// only for a body with a lamp (found after prepareObject, hence a separate pass). receiveShadow IS in the pipeline
// key: flipping it compiles lit + depth pipelines per material unless warmed (warmqueue warmLit/warmDepth).
export function setBodyShadows(root, on = true) {
  if (!root?.traverse) return 0;
  let n = 0;
  root.traverse((o) => {
    if (!o.isMesh) return;
    o.receiveShadow = on;
    o.castShadow = on && !BODY_NO_CAST.test(o.name || '');
    n++;
  });
  return n;
}

// own avatar only (a Video setting): remotes never pass through here, a remote's pref is not this browser's
export const PREF_MY_SHADOW = 'ew-my-shadow';
export function myShadowPref() { try { return localStorage.getItem(PREF_MY_SHADOW) === '1'; } catch { return false; } }
export function setMyShadowPref(on) {
  try { localStorage.setItem(PREF_MY_SHADOW, on ? '1' : '0'); } catch { /* private window */ }
  bus.emit('my-shadow', !!on);
}
/** Own body shadows = the pref OR its lamp. Before a flip ON, `lit` and `warm` compile the lit and depth pipelines off
 *  the frame; `pref` (maybe a getter) is re-read AFTER the warms, so a mid-warm toggle wins. `still()`: body still worn? */
export async function applyOwnBodyShadow(av, { pref = myShadowPref, warm = null, lit = null, still = () => true } = {}) {
  const root = av?.vrm?.scene;
  if (!root?.traverse) return false;
  const read = () => (typeof pref === 'function' ? !!pref() : !!pref) || !!av._lamps?.length;
  if (read() && !av._bodyWarm && (warm || lit)) {
    const meshes = [];
    root.traverse((o) => { if (o.isMesh && !BODY_NO_CAST.test(o.name || '')) meshes.push(o); });
    let ran = false;
    const get = () => { if (!still()) return []; ran = true; return meshes; };
    if (lit) await lit('lit me', get);
    if (warm) await warm('depth me', get);
    if (ran) av._bodyWarm = true;
    if (!still()) return false;
  }
  const want = read();
  setBodyShadows(root, want);
  return want;
}

/** Marks every mesh so upstream's sweeps skip it, applies its kind's shadow-receive policy, wraps every material.
 *  Idempotent; call before the first compile. */
export function prepareObject(root, { kind = 'model', foliage = true } = {}) {
  // a missing root is a no-op: module init passes `ground` (null before terrain), and a throw at import kills the client
  if (!root?.traverse) return;
  const receive = kind === 'model' || kind === 'terrain';
  // bodies aren't shadowed here (unwarmed depth pipelines): see setBodyShadows(); the blob stays as the contact cue
  const grass = kind === 'grass';
  root.traverse((o) => {
    if (!o.isMesh) return;
    stats.meshes++;
    o.userData.noWet = true;           // upstream sweeps' skip markers
    o.userData.noCloudShadow = true;
    // explicit both ways: upstream vegetation ships receiveShadow=true (§13.1: intent is not behavior)
    o.receiveShadow = receive;
    // grass never casts: shrub wood ships castShadow TRUE upstream, five depth pipelines nothing pre-warms (§16.2.B)
    if (grass) o.castShadow = false;
    // transmission first: it replaces the material object, and the wrap below skips non-node materials
    if (Array.isArray(o.material)) {
      for (let i = 0; i < o.material.length; i++) {
        const up = upgradeTransmissive(o, o.material[i]);
        if (up !== o.material[i]) o.material[i] = up;
      }
    } else if (o.material) {
      const up = upgradeTransmissive(o, o.material);
      if (up !== o.material) o.material = up;
    }
    const mats = Array.isArray(o.material) ? o.material : o.material ? [o.material] : [];
    for (const m of mats) {
      // grass never puddles: blade normals are forced up and would pass the flatness gate (compile-time, §12.2)
      if (grass) m.userData.noPuddles = true;
      prepareMaterial(m, o);
    }
  });
  // blended textured leaves get the two-pass twin in 'fast' foliage mode (foliage.js)
  // a loaded PROTOTYPE passes foliage:false: each placed clone registers itself (assets.js)
  if (kind === 'model' && foliage) registerFoliage(root);
  return root;
}

// ---- the driver: folded state in, uniform writes out. Targets derive at ~1 Hz (sky.js clock); easing runs per frame.

const WET = { clear: 0, fair: 0, sunshower: 0.55, overcast: 0.15, rain: 0.85, storm: 1, cyclone: 1, darkstorm: 1 };
const WX_COVER = { clear: 0, fair: 0.18, sunshower: 0.35, overcast: 0.85, rain: 0.9, storm: 0.92, cyclone: 0.96, darkstorm: 1 };
const CLOUD_COVER = { clear: 0, cumulus: 0.38, stratus: 0.6, cirrus: 0.15 };
// unit-ish wind directions, different headings so the field evolves instead of translating
const WIND1 = { x: 1.9, y: 0.55 };
const WIND2 = { x: -0.7, y: 1.3 };

let cursor = null;        // effectiveSky's O(1) segment cursor
let lastDerive = 0;
let lastTick = 0;
let smoothTargetCover = 0;
const target = { wet: 0, cover: 0 };
const _dir = new THREE.Vector3();

function deriveTargets() {
  const a = state.st?.sky;
  if (!a) { target.wet = 0; target.cover = 0; return; }
  const eff = effectiveSky(a, serverNow(), cursor);
  cursor = eff.cursor;
  const w = eff.weather && WET[eff.weather] !== undefined ? eff.weather : 'clear';
  const k = eff.k ?? 1;
  target.wet = (WET[w] ?? 0) * k;
  target.cover = Math.max(CLOUD_COVER[a.clouds] ?? 0, (WX_COVER[w] ?? 0) * k);
}

const approach = (cur, goal, dt, tau) => cur + (goal - cur) * Math.min(1, dt / tau);

/** Per-frame: ease the weather uniforms toward folded state and keep the cloud field moving. */
export function updateMaterials(nowMs) {
  const dt = lastTick ? Math.min(0.25, (nowMs - lastTick) / 1000) : 0.016;
  lastTick = nowMs;
  if (nowMs - lastDerive > 1000) { lastDerive = nowMs; deriveTargets(); }

  // ground wets in ~10s, dries in ~40s
  U.wet.value = approach(U.wet.value, target.wet, dt, target.wet > U.wet.value ? 10 : 40);

  // wind scroll: speed scales gently with coverage (storms move faster)
  const windK = 1 + target.cover * 2.5;
  U.scroll1.value.x += WIND1.x * windK * dt;
  U.scroll1.value.y += WIND1.y * windK * dt;
  U.scroll2.value.x += WIND2.x * windK * dt;
  U.scroll2.value.y += WIND2.y * windK * dt;

  // a cloud shadows the point the sun-ray through it hits; sun.position is the live sky's (moonlight at night)
  _dir.copy(sun.position).normalize();
  const off = CLOUD_H / Math.max(0.25, _dir.y);
  U.cloudOff.value.set(_dir.x * off, _dir.z * off);

  // coverage moves the threshold window; full overcast flattens patchiness (a grey sky only dims, which sunDim does)
  const cover = approach(smoothTargetCover, target.cover, dt, 15);
  smoothTargetCover = cover;
  const lo = 1.02 - 0.72 * cover;
  U.cloudLo.value = lo;
  U.cloudHi.value = lo + 0.22;
  const sunUp = Math.max(0, Math.min(1, _dir.y * 4));
  const patchy = 1 - Math.max(0, Math.min(1, (cover - 0.8) / 0.17));
  U.cloudStrength.value = 0.5 * sunUp * patchy * Math.min(1, cover * 3);
}

/** Test seam: the shared material uniforms (probes pin wet/cloud for a deterministic render). */
export const materialUniforms = () => U;

/** Debug surface (EW.materials). */
export const materialsDebug = () => ({
  ...stats,
  wet: +U.wet.value.toFixed(3),
  cover: +smoothTargetCover.toFixed(3),
  strength: +U.cloudStrength.value.toFixed(3),
  target: { ...target },
});

// the stage floor compiles on the first frame, so it goes through the factory here (core.js imports nothing)
prepareObject(ground, { kind: 'terrain' });
