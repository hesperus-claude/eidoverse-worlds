// realize/materialise.js: a thing that just arrived grows into its own scale over ~450 ms; the last frame writes the
// target exactly; an edit mid-grow retargets; a removed object is forgotten; a second materialise is a no-op.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/materialise-test.ts
import { Vector3, Object3D, Group } from 'three';
import { materialise, drainMaterialise, isGrowing, retarget } from '../client/lib/realize/materialise.js';
let pass = 0, fail = 0;
const check = (what: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}${ok || !detail ? '' : ` — ${detail}`}`); };
const parent = new Group();
const make = (s: number) => { const o = new Object3D(); o.scale.setScalar(s); parent.add(o); return o; };

console.log('materialise — grows into place');
const a = make(2);
materialise(a, 1000);
check('right after arrival the thing is (almost) nothing', a.scale.x < 0.01 && isGrowing(a), String(a.scale.x));
drainMaterialise(1000 + 225);
const mid = a.scale.x;
check('halfway (225 ms) it is between nothing and its size, past the midpoint (ease-out)', mid > 1 && mid < 2, String(mid));
drainMaterialise(1000 + 300);
check('…and still growing, monotonically', a.scale.x > mid && a.scale.x < 2, String(a.scale.x));
drainMaterialise(1000 + 450);
check('at 450 ms it wears its own scale exactly and is no longer growing', a.scale.x === 2 && a.scale.y === 2 && !isGrowing(a), String(a.scale.x));
drainMaterialise(1000 + 9000);
check('…and a later frame leaves it alone', a.scale.x === 2);

console.log('\nmaterialise — edits, removals, repeats');
const b = make(1);
materialise(b, 2000); drainMaterialise(2000 + 100);
retarget(b, new Vector3(3, 3, 3));
drainMaterialise(2000 + 450);
check('an edit mid-grow sets where the grow ends (3, not 1)', b.scale.x === 3, String(b.scale.x));
const c = make(1);
materialise(c, 3000); drainMaterialise(3000 + 100);
parent.remove(c);
drainMaterialise(3000 + 450);
check('a thing removed mid-grow is forgotten (no write, not growing)', !isGrowing(c) && c.scale.x < 1, String(c.scale.x));
const d = make(1.5);
materialise(d, 4000); drainMaterialise(4000 + 200);
const before = d.scale.x; materialise(d, 4000 + 200);
check('a second materialise on a growing thing is a no-op (no restart)', d.scale.x === before && isGrowing(d), `${before} → ${d.scale.x}`);
drainMaterialise(4000 + 450);
check('…and it still ends at its own scale', d.scale.x === 1.5, String(d.scale.x));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
