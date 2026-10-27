import { recordComponents } from './protocol/view.js';
import { isVrmModel } from './eido.js';
// Selection layers: what a click in the edit viewport can land on. A thing's layer is world data (DRAFT hesperus/layer,
// docs/COMPONENT-LADDER.md rung 1), else a default by kind; which layers a person can click is theirs (client/lib/selectmask.js).
// The Hierarchy always selects anything, so nothing is stranded.
export const LAYER_KEY = 'hesperus/layer';
export const LAYERS = ['environment', 'structure', 'props', 'lights', 'signs', 'people', 'other'];
export const LAYER_HINT = {
  environment: 'floors, terrain meshes, backdrops: off for clicks by default',
  structure: 'built walls, floors and roofs', props: 'models: crates, furniture, things to move',
  lights: 'lights on their own', signs: 'text and pictures', people: 'avatar models and what rides them', other: 'everything else',
};
const vrm = (e) => typeof e?.model === 'string' && isVrmModel(e.model);   // by the file it names
/** The layer a thing defaults to, from its own components. */
export function defaultLayer(e) {
  const c = recordComponents(e);
  if (vrm(e)) return 'people';
  if (c.structure) return 'structure';
  if (c.text || c.picture) return 'signs';
  if (e?.model == null && !(c.mesh && typeof c.mesh === 'object')) return c.light && typeof c.light === 'object' ? 'lights' : 'other';   // a mesh thing falls through to the size test, as a model does
  const sh = c.physics?.shape, t = c.transform; const s = Array.isArray(t?.scale) ? t.scale : [t?.scale ?? 1, t?.scale ?? 1, t?.scale ?? 1];
  if (Array.isArray(sh) && Array.isArray(sh[0]) && Array.isArray(sh[1]) && Math.max(Math.abs((sh[1][0] - sh[0][0]) * s[0]), Math.abs((sh[1][2] - sh[0][2]) * s[2])) >= 30) return 'environment';
  return 'props';
}
/** Its own hesperus/layer, else 'people' under an avatar, else its default. world: the fold's entities. */
export function layerOf(world, id) {
  const e = world?.[id]; if (!e) return 'other';
  const own = e?.[LAYER_KEY]; if (typeof own === 'string' && LAYERS.includes(own)) return own;
  for (let p = e.parent?.to, n = 0; p && n < 32; p = world[p]?.parent?.to, n++) { const pe = world[p]; const pl = pe?.[LAYER_KEY];
    if (pl === 'people' || (pl == null && vrm(pe))) return 'people'; }
  return defaultLayer(e);
}
