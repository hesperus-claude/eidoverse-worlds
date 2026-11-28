// interior — the GPU half of the `interior` zone effect (componentspec interior; Godot ReflectionProbe.interior with
// ambient_mode Color): inside a box the sky's ambient is cut and a flat ambient stands in for it, with no bake.
//
// What is cut, per lit fragment, by a weight a(p) in 0..1:
//   · the sky hemisphere (core.js `hemi`, which the sky drives every frame): × (1 − a)
//   · the environment map, diffuse and specular: env × (1 − a) + A / π, A the boxes' colour × energy. A uniform
//     environment of radiance A/π gives a white surface A/π, which is what three's AmbientLight of intensity A gives
//     (so the energy means what sky.ambientLightEnergy means), and a shiny surface reflects a plain room of that
//     brightness instead of the sky
// and nothing else: the sun and the fill (directional lights a roof should shadow), lamps, emissive and fog stay.
//
// Born at boot, never rebuilt: INTERIOR_SLOTS boxes as render-group uniform arrays and an active count, so boxes
// coming and going change values only and no lit material recompiles. A world with no box runs the loop zero times
// and draws the same picture (x × 1 + 0 is x).
//
// A factory over the caller's THREE and TSL (core.js passes its own), so this file imports nothing: core.js can import
// it, and a bun test can hand it three/webgpu.
//
// Why a light class of our own: three r186's NodeLibrary.addLight refuses a redefinition (it warns and returns), and
// the standard library already maps HemisphereLight, so a HemisphereLightNode subclass cannot replace it. Mapping our
// own subclass is also exact: only the sky's hemisphere is cut, never one another scene makes (the avatar thumbnail).

/** The renderer's budget: how many interior boxes a fragment reads (the engine owns it; a world can't raise it). */
export const INTERIOR_SLOTS = 4;

export function makeInterior(THREE, TSL) {
  const { uniform, uniformArray, positionWorld, normalWorld, Fn, Loop, float, int, vec3, vec4, max, clamp, mix, pmremTexture, renderGroup } = TSL;
  const N = INTERIOR_SLOTS;
  // per slot: world → box (its rotation and centre; the size is the extent's), the extent (xyz half size, w blend m),
  // and the ambient (rgb colour × energy, w the zone's weight)
  const toBox = uniformArray(Array.from({ length: N }, () => new THREE.Matrix4())).setGroup(renderGroup);
  const extent = uniformArray(Array.from({ length: N }, () => new THREE.Vector4())).setGroup(renderGroup);
  const ambient = uniformArray(Array.from({ length: N }, () => new THREE.Vector4())).setGroup(renderGroup);
  const count = uniform(0, 'int').setGroup(renderGroup);

  // vec4(A, 1 − a): the ambient that stands in, and what is left of the sky. Front to back in slot order (the caller
  // writes them in blend order: shared/zone.js interiorSlots): each box takes what those before it left. One variable
  // per fragment, read by the hemisphere and the environment both.
  const term = Fn(() => {
    const acc = float(0).toVar(), amb = vec3(0).toVar();
    Loop({ start: int(0), end: count, type: 'int', name: 'interiorBox' }, ({ interiorBox: i }) => {
      const q = toBox.element(i).mul(vec4(positionWorld, 1)).xyz, e = extent.element(i), A = ambient.element(i);
      const d = max(q.abs().sub(e.xyz), vec3(0)).length();                                   // 0 inside
      const w = clamp(float(1).sub(d.div(max(e.w, 0.0001))), 0, 1).mul(A.w).mul(float(1).sub(acc));   // blend 0: a hard edge
      amb.addAssign(A.xyz.mul(w)); acc.addAssign(w);
    });
    return vec4(amb, float(1).sub(acc));
  })().toVar('interiorTerm');
  const skyLeft = term.w, standIn = term.xyz;

  // the sky's hemisphere: three r186 HemisphereLightNode.setup, its irradiance × what is left of the sky
  class InteriorHemisphereLightNode extends THREE.HemisphereLightNode {
    static get type() { return 'InteriorHemisphereLightNode'; }
    setup(builder) {
      const { colorNode, groundColorNode, lightDirectionNode } = this;
      const hemiDiffuseWeight = normalWorld.dot(lightDirectionNode).mul(0.5).add(0.5);
      builder.context.irradiance.addAssign(mix(groundColorNode, colorNode, hemiDiffuseWeight).mul(skyLeft));
    }
  }
  class InteriorHemisphereLight extends THREE.HemisphereLight {}

  /** scene.environmentNode over `texture` (the sky's persistent environment, sky_baked envTexture): set once, at boot */
  const environmentNode = (texture) => pmremTexture(texture).mul(skyLeft).add(standIn.mul(1 / Math.PI));

  const _m = new THREE.Matrix4(), _q = new THREE.Quaternion(), _p = new THREE.Vector3(), ONE = new THREE.Vector3(1, 1, 1);
  const FAR = 1e9;   // a global zone's half size: everywhere is inside
  let written = [];
  /** Write the slots (shared/zone.js interiorSlots: at most INTERIOR_SLOTS, in blend order): values only, never a node. */
  function setSlots(slots) {
    const list = (slots ?? []).slice(0, N);
    list.forEach((b, i) => {
      if (b.global) { toBox.array[i].identity(); extent.array[i].set(FAR, FAR, FAR, 0); }
      else {
        _m.compose(_p.fromArray(b.center), _q.fromArray(b.q ?? [0, 0, 0, 1]).normalize(), ONE).invert(); toBox.array[i].copy(_m);
        extent.array[i].set(b.size[0] / 2, b.size[1] / 2, b.size[2] / 2, b.blend ?? 0);
      }
      const e = b.energy ?? 0;
      ambient.array[i].set(b.color[0] * e, b.color[1] * e, b.color[2] * e, b.weight ?? 1);
    });
    for (let i = list.length; i < N; i++) { toBox.array[i].identity(); extent.array[i].set(0, 0, 0, 0); ambient.array[i].set(0, 0, 0, 0); }
    count.value = list.length;
    written = list.map((b) => b.id);
  }
  const debug = () => ({ slots: N, count: count.value, ids: [...written] });
  return { InteriorHemisphereLight, InteriorHemisphereLightNode, environmentNode, setSlots, debug, term, uniforms: { toBox, extent, ambient, count } };
}
