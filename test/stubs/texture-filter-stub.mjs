// test/stubs/texture-filter-stub.mjs — what test/client/texture-filter-test.ts injects BELOW the real client/lib/assets.js:
// lod-loader-stub's renderer that never draws and frame conductors that run at once, with two changes to the renderer:
// it reports a maximum anisotropy the suite sets (three's Renderer.getMaxAnisotropy: WebGPU says 16, the WebGL 2 fallback
// says what EXT_texture_filter_anisotropic says, 0 without it), and initTexture records each texture's anisotropy AT THE
// UPLOAD, the moment the sampler is built from it.
import { renderer as base } from './lod-loader-stub.mjs';
export * from './lod-loader-stub.mjs';

export const uploads = [];   // [{ name, anisotropy }] per initTexture call, in order
export const gpu = { maxAnisotropy: 16 };
export const renderer = {
  ...base,
  getMaxAnisotropy: () => gpu.maxAnisotropy,
  initTexture(t) { uploads.push({ name: t.name, anisotropy: t.anisotropy }); },
};
