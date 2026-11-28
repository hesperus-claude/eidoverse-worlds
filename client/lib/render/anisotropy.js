// anisotropy: texture filtering at grazing angles, a viewer's quality dial (never the look). A floor ahead of you or a
// long wall seen edge-on stays sharp instead of blurring through its mips. Godot's default_filters/anisotropic_filtering_level
// (default 4x) and Unity's Anisotropic Textures quality setting.
//
// Set before the upload, because that is when WebGL 2 (every headset's backend) sets a sampler's parameters; WebGPU
// builds its sampler later, at first bind (again when the texture's version changes), so a write made after the load is
// lost on one backend and wins on the other. A change of the dial applies to what loads later, and to what is already
// here on reload (a cached image keeps the level it was born at).
//   Reached: a model's textures (assets.js primeTextures); an image through the image door (globalThis.loadImageTexture
//   -> queueTexturePrime): a material component's library texture, a hung library picture, and every toolkit module
//   that loads an image there. A caller that knows better states its own level to the door ({ anisotropy }), which
//   stands in place of the dial and is clamped the same way: vegetation's atlases 4, and 1 for the fast-shade albedo;
//   particle sprites 1.
//   Not reached: models that toolkit modules load through their own loader (globalThis.GLTFLoader); a picture or a
//   material component's texture from an https link (pictures.js linkTexture, a CanvasTexture); canvases with a fixed
//   level (XR panels, texts: 4); the terrain's layer textures (assets.js noiseTexture canvases: three's 1).
const KEY = 'ew-anisotropy';
export const ANISO_LEVELS = [1, 2, 4, 8, 16];
export const ANISO_DEFAULT = 4;
export function anisotropy() {
  let v = NaN;
  try { v = +localStorage.getItem(KEY); } catch { /* site data blocked */ }   // absent and '' read as 0: not a level
  return ANISO_LEVELS.includes(v) ? v : ANISO_DEFAULT;
}
export function setAnisotropy(n) {
  if (!ANISO_LEVELS.includes(+n)) return;
  try { localStorage.setItem(KEY, String(+n)); } catch { /* private window */ }
}
/** A caller's own level, when it stated one: a finite number of at least 1. Anything else (absent, 0, NaN, a string)
 *  is not a statement, and the viewer's dial applies. */
export const statedAnisotropy = (level) => (Number.isFinite(level) && level >= 1 ? level : null);
/** The level a texture uploads at: the caller's when it stated one (a sprite or a data mask states 1), else the viewer's;
 *  never above what this renderer reports (three's getMaxAnisotropy: 16 on WebGPU, EXT_texture_filter_anisotropic's
 *  maximum on WebGL 2, 0 without the extension), and never below three's 1. */
export const textureAnisotropy = (renderer, level) =>
  Math.max(1, Math.min(statedAnisotropy(level) ?? anisotropy(), renderer.getMaxAnisotropy?.() ?? 16));
