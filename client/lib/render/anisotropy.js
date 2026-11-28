// anisotropy: texture filtering at grazing angles, a viewer's quality dial (never the look). A floor ahead of you or a
// long wall seen edge-on stays sharp instead of blurring through its mips. Godot's default_filters/anisotropic_filtering_level
// (default 4x) and Unity's Anisotropic Textures quality setting. Applied before the upload to a model's textures
// (assets.js primeTextures) and to an image loaded by itself, a material component's texture or a library picture
// (queueTexturePrime): both of three's backends build the sampler from texture.anisotropy then, so a change applies to
// what loads later, and to what is already here on reload. Not reached: a picture from an https link (pictures.js
// linkTexture, a CanvasTexture uploaded at its first draw), the terrain's and the vegetation's own textures.
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
