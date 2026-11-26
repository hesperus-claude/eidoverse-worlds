// tonemap: the world's display transform (sky.tonemap), the owner's look and never the viewer's (R 11-02: "the world
// owner should control *what* lighting, and the user should only control perf/quality"). The conforming shape: Godot's
// Environment.tonemap_mode, three's renderer.toneMapping, Filament's ToneMapper on ColorGrading. Absent = aces, the curve
// core.js gives every renderer and every world had before the field. sky.js sets it where it sets the world's exposure,
// so it follows a sky edit, a preview and a world change exactly as exposure does. uTonemap tells the in-world quads'
// inverse (xr/quadcolour.js) which curve to undo, per frame, so panels and images keep their authored colour.
// linear is three's LinearToneMapping (exposure, then a clamp), not NoToneMapping: the output pass stays the same shape
// (a framebuffer target, MSAA inside it; core.js), only its curve changes.
import * as THREE from 'three';
import { uniform } from 'three/tsl';
import { COMPONENTS } from '../../../shared/protocol/componentspec.js';

export const TONEMAPS = COMPONENTS.sky.enums.tonemap;   // aces | agx | neutral | linear: uTonemap's values, in this order
export const TONEMAP_ABSENT = 'aces';
const CURVE = { aces: THREE.ACESFilmicToneMapping, agx: THREE.AgXToneMapping, neutral: THREE.NeutralToneMapping, linear: THREE.LinearToneMapping };
export const uTonemap = uniform(TONEMAPS.indexOf(TONEMAP_ABSENT));

/** Set the renderer's curve from the world's word; absent or unknown draws the absent curve (as an unknown clouds value
 *  draws cumulus: the door refuses one, so only a hand-edited or newer log carries it). Returns the name applied. A change
 *  recompiles three's output pass once (its cache key holds the curve); an unchanged one costs nothing. */
export function setTonemap(renderer, name) {
  const k = TONEMAPS.includes(name) ? name : TONEMAP_ABSENT;
  if (renderer.toneMapping !== CURVE[k]) renderer.toneMapping = CURVE[k];
  uTonemap.value = TONEMAPS.indexOf(k);
  return k;
}
