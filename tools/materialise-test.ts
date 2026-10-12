// realize/materialise.js: a thing that just arrived is DRAWN growing (eased scale on before the draw, off after); its true
// scale and matrixWorld are untouched between draws; the grow ends after ~450 ms; a removed object is forgotten.
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun tools/materialise-test.ts
import { Object3D, Group, Vector3 } from 'three';
import { materialise, beginDraw, endDraw, isGrowing } from '../client/lib/realize/materialise.js';
let pass = 0, fail = 0;
const check = (what: string, ok: boolean, detail = '') => { ok ? pass++ : fail++; console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${what}${ok || !detail ? '' : ` — ${detail}`}`); };
const root = new Group();
const make = (s: number) => { const o = new Object3D(); o.scale.setScalar(s); const child = new Object3D(); child.position.set(1, 0, 0); o.add(child); root.add(o); root.updateMatrixWorld(true); return o; };
const worldX = (o: Object3D) => new Vector3().setFromMatrixPosition(o.children[0].matrixWorld).x;
const draw = (now: number) => { beginDraw(now); root.updateMatrixWorld(true); /* what renderer.render does */ return; };

console.log('materialise — the grow exists only during the draw');
const a = make(2);
materialise(a, 1000);
check('after materialise the TRUE scale is untouched (2)', a.scale.x === 2 && isGrowing(a), String(a.scale.x));
draw(1000 + 225);
const drawn = a.scale.x, childDrawn = worldX(a);
check('during the draw at 225 ms the scale is eased: between nothing and 2, past the midpoint', drawn > 1 && drawn < 2, String(drawn));
check('…and the child\'s matrixWorld follows the eased parent (it is drawn small too)', childDrawn > 1 && childDrawn < 2, String(childDrawn));
endDraw();
check('after the draw the true scale is back (2) and the child\'s matrixWorld is the true one (x=2)', a.scale.x === 2 && worldX(a) === 2, `${a.scale.x} ${worldX(a)}`);
draw(1000 + 450); endDraw();
check('at 450 ms the grow is over: not growing, scale 2', !isGrowing(a) && a.scale.x === 2, String(a.scale.x));
draw(1000 + 9000); endDraw();
check('…and a later draw leaves it alone', a.scale.x === 2);

console.log('\nmaterialise — edits, removals, repeats');
const b = make(1);
materialise(b, 2000); draw(2000 + 100); endDraw();
b.scale.setScalar(3);   // an edit mid-grow writes the true scale as it always did
draw(2000 + 300); const mid = b.scale.x; endDraw();
check('an edit mid-grow is honoured: the next draw eases toward 3 and restores 3', mid > 1.5 && mid < 3 && b.scale.x === 3, `${mid} → ${b.scale.x}`);
const c = make(1);
materialise(c, 3000); draw(3000 + 100); endDraw();
root.remove(c);
draw(3000 + 200); endDraw();
check('a thing removed mid-grow is forgotten, its scale untouched', !isGrowing(c) && c.scale.x === 1, String(c.scale.x));
const d = make(1.5);
materialise(d, 4000); draw(4000 + 200); const first = d.scale.x; endDraw();
materialise(d, 4000 + 200); draw(4000 + 200); const again = d.scale.x; endDraw();
check('a second materialise on a growing thing is a no-op (same eased value at the same instant)', again === first && isGrowing(d), `${first} vs ${again}`);
check('endDraw without a beginDraw is harmless', (endDraw(), d.scale.x === 1.5));

console.log(`\n${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
