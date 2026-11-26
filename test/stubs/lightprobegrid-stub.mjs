// Test stand-ins for three r186's LightProbeGrid and its light node (test/client/gi-test.mjs): a grid that records each
// bake call (and its intensity at the call), and a node whose five uniforms start in three's per-OBJECT group, as
// LightProbeGridNode's do (uniform() with no group named). `made` counts the grids built; `imported` says this module
// (three's grid code) was loaded at all.
import { THREE } from './core-stub.mjs';
export const bakes = [];
export const made = [];
export const imported = true;
export const failNext = { n: 0, message: 'stub bake failure' };   // a test asks the next n bake calls to throw
export class LightProbeGrid extends THREE.Object3D {
  constructor(w, h, d, nx, ny, nz) {
    super(); this.isLightProbeGrid = true; this.size = [w, h, d]; this.resolution = new THREE.Vector3(nx, ny, nz); this.falloff = 0; this.intensity = 1; this.disposed = false;
    made.push(this);
  }
  bake(renderer, baked, opts) {
    if (failNext.n > 0) { failNext.n--; throw new Error(failNext.message); }
    bakes.push({ grid: this, scene: baked, children: [...baked.children], intensity: this.intensity, ...opts });   // children: what the proxy held at this step
  }
  dispose() { this.disposed = true; }
}
export const GRID_UNIFORMS = ['_min', '_max', '_resolution', '_intensity', '_falloff'];
const uniform = () => ({ group: 'object', setGroup(g) { this.group = g; return this; } });
export class LightProbeGridNode { constructor(light) { this.light = light; for (const k of GRID_UNIFORMS) this[k] = uniform(); } }
