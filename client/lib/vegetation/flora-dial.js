// flora-dial — the density dial on one grass stroke (flora.js wires it on every field it composes). A leaf module, so
// test/client/grass-quality-test.ts runs it as shipped.
import { densityCount } from './grass_quality.js';
import { mulberry32 } from '../../../shared/rand.js';

// ---- density dial ----------------------------------------------------------
// The perf governor thins the meadow before dropping resolution: the instanced attributes are shuffled once
// (deterministically: a field must stay the same field), so InstancedMesh.count is a uniform-density dial.
export function wireDensityDial(field) {
  const geo = field.mesh.geometry;
  const attrs = ['aPosRot', 'aScaleVar', 'aPhase'].map((n) => geo.getAttribute(n)).filter(Boolean);
  const n = field.count;
  if (!n || !attrs.length) return;
  const order = Array.from({ length: n }, (_, i) => i);
  const rnd = mulberry32(0x6d2b79f5);
  for (let i = n - 1; i > 0; i--) {
    const j = (rnd() * (i + 1)) | 0;
    const t = order[i]; order[i] = order[j]; order[j] = t;
  }
  for (const a of attrs) {
    const sz = a.itemSize, src = a.array.slice();
    for (let i = 0; i < n; i++) {
      const s = order[i] * sz, d = i * sz;
      for (let k = 0; k < sz; k++) a.array[d + k] = src[s + k];
    }
    a.needsUpdate = true;
  }
  // the stem mesh (shrub wood) shares the same attribute OBJECTS, so only the count needs mirroring
  field.setDensity = (f) => {
    // densityCount owns the clamp, including genuine zero for `off`
    const keep = densityCount(n, f);
    field.mesh.count = keep;
    if (field.stemMesh) field.stemMesh.count = keep;
  };
}
