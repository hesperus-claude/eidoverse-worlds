// anisotropy: texture filtering at grazing angles, a viewer's quality dial (never the look). A floor ahead of you or a
// long wall seen edge-on stays sharp instead of blurring through its mips. Godot's default_filters/anisotropic_filtering_level
// (default 4x) and Unity's Anisotropic Textures quality setting. Applied to a model's textures before their upload
// (assets.js primeTextures): both of three's backends build the sampler from texture.anisotropy then, so a change
// applies to models as they load, and to what is already here on reload.
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
/** The level a texture uploads at: the viewer's, never above what this renderer reports (three's getMaxAnisotropy:
 *  16 on WebGPU, EXT_texture_filter_anisotropic's maximum on WebGL 2, 0 without the extension, where nothing is raised). */
export const textureAnisotropy = (renderer) => Math.min(anisotropy(), renderer.getMaxAnisotropy?.() ?? 16);
