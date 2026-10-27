// picture-race-probe: async intent under HELD image loads (#186). The fold's bag is the authority; a load requests to
// realize it and routinely outlives it. Each leg holds the picture's library fetch, changes intent mid-load, releases,
// and checks what is on the thing.
//   bun tools/picture-race-probe.ts     (EIDOVERSE_DIR must point at the library)
//   A. remove under a held load: nothing installs after data:null;
//   B. replace under a held load: older A finishing after newer B leaves B;
//   C. entity removed under a held load: nothing installs, no clone kept;
//   D. entity re-realized (remove + spawn) under a held load: the stale load doesn't land on the new subtree;
//   E. world reset under a held load: nothing installs;
//   F. the unheld happy path still hangs (the gate refuses only STALE loads);
//   G. LOD demote + promote under a held load with the entity PRESENT: the stale load is refused and the still-authored
//      picture rehangs from pending.
// Writes go through net.sendRequest (shared/protocol/requests.js); the authority mints ids, read from each create's
// reply. A picture is the thing's own quad (shared/picture.js), judged by its texture; a held load shows the empty
// plate (hung, no map) until it lands.
import { pictureWorld, req, spawnConsole, state as stateOf, until as untilOf, settle, hold } from './picture-probe-harness.ts';
import * as OP from '../shared/protocol/requests.js';

// ONE UNPRIMED IMAGE PER HELD LEG: the host caches library bytes per session (assets.js primeFiles), so a reload never
// fetches and a hold on it holds nothing; each held leg takes a fresh preview and asserts the hold engaged
const M = 'eidoverse/assets/models/';
const POOL = [
  'scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_concrete_rebar_chunk_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_pile_building_collapse_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_pile_ruins_preview.jpg',
  'apocalyptic_destroyed_rubble_debris_streetlight_lamp_light_street_preview.jpg',
  'apocalyptic_scifi_cyberpunk_destroyed_rubble_debris_pile_preview.jpg',
  'bagger_288_bucketwheel_excavator_mining_extraction_preview.jpg',
  'cactus_wren_bird_animated_desert_songbird_calling_hopping_walking_preview.jpg',
  'computer_servers_rack_with_fans_on_back_row_of_four_4_columns_preview.jpg',
].map((f) => M + f);
let poolIdx = 0;
const fresh = () => { if (poolIdx >= POOL.length) throw new Error('image pool exhausted'); return POOL[poolIdx++]; };
const { check, done, errs, joinAs, close } = await pictureWorld('raceprobe', 'raceprobe');
let ID = '';  // the console's id, minted by the authority on each spawn
const spawn = async (pg: any) => { ID = await spawnConsole(pg); };
const remove = (pg: any) => req(pg, OP.remove(ID));
const comp = (pg: any, src: string | null) => req(pg, src ? OP.set(ID, 'picture', { src, alt: 'race', lit: 'self' }) : OP.unset(ID, 'picture'));
const state = (pg: any) => stateOf(pg, ID);
const until = (pg: any, pred: (s: any) => boolean, ms = 20000) => untilOf(pg, () => ID, pred, ms);

try {
  const pg = await joinAs('raceprobe');
  await spawn(pg);
  let s = await until(pg, (x) => x.entity);
  check('the console spawned', s.entity, JSON.stringify(s));

  // A. hold the fetch, author, remove, release
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('A. the hold engaged (a real fetch is in flight)', h.heldCount() > 0);
    await comp(pg, null);
    await settle(300);
    await h.release();
    await settle();
    s = await state(pg);
    check('A. a load released after data:null installs NOTHING', !s.hung && s.count === 0 && !s.hasMap && s.original, JSON.stringify(s));
  }
  // B. older A held, newer B lands first, A released after: B stays
  {
    const imgA = fresh(), imgB = fresh();
    const h = await hold(pg, imgA);
    await comp(pg, imgA);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('B. the hold engaged', h.heldCount() > 0);
    await comp(pg, imgB);
    s = await until(pg, (x) => x.hung && x.hasMap && x.mapSrc === imgB);
    check('B. the newer bag hangs while the older load is still held', s.hung && s.hasMap && s.mapSrc === imgB, JSON.stringify(s));
    await h.release();
    await settle();
    s = await state(pg);
    check('B. the older load, released late, does not overwrite the newer picture', s.hung && s.hasMap && s.mapSrc === imgB && s.count === 1, JSON.stringify(s));
    await comp(pg, null);
    await until(pg, (x) => !x.hung);
  }
  // C. entity removed under a held load
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('C. the hold engaged', h.heldCount() > 0);
    await remove(pg);
    await until(pg, (x) => !x.entity);
    await h.release();
    await settle();
    s = await state(pg);
    check('C. a load released after the entity left installs nothing and keeps no clone', !s.hung && s.count === 0 && !s.entity, JSON.stringify(s));
  }
  // D. remove + respawn (a new subtree) under a held load
  {
    await spawn(pg);
    await until(pg, (x) => x.entity);
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('D. the hold engaged', h.heldCount() > 0);
    await remove(pg);
    await until(pg, (x) => !x.entity);
    await spawn(pg);
    await until(pg, (x) => x.entity);
    await h.release();
    await settle();
    s = await state(pg);
    check('D. the stale load does not land on the re-realized subtree', !s.hung && s.count === 0 && s.original, JSON.stringify(s));
  }
  // E. world reset under a held load
  {
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('E. the hold engaged', h.heldCount() > 0);
    await pg.evaluate(() => import('/lib/base.js').then((b: any) => b.bus.emit('world-reset', {})));
    await settle(300);
    await h.release();
    await settle();
    s = await state(pg);
    check('E. a load released after a world reset installs nothing', !s.hung && s.count === 0, JSON.stringify(s));
  }
  // F. the gate refuses only STALE loads
  {
    await spawn(pg);
    await until(pg, (x) => x.entity);
    const img = fresh();
    await comp(pg, img);
    s = await until(pg, (x) => x.hung && x.hasMap);
    check('F. an unheld load still hangs (the happy path is untouched)', s.hung && s.hasMap && s.mapSrc === img, JSON.stringify(s));
  }
  // G. the entity is present when the load starts; a demote/promote cycle happens while the fetch is held
  {
    await comp(pg, null);
    await until(pg, (x) => !x.hung);
    const img = fresh();
    const h = await hold(pg, img);
    await comp(pg, img);
    await until(pg, () => h.heldCount() > 0, 10000);
    check('G. the hold engaged', h.heldCount() > 0);
    await pg.evaluate((id: string) => import('/lib/base.js').then((b: any) => { b.bus.emit('entity', { id, kind: 'demote' }); b.bus.emit('entity', { id, kind: 'spawn' }); }), ID);
    await settle(300);
    await h.release();
    s = await until(pg, (x) => x.hung && x.hasMap);
    check('G. demote+promote during a held load: the still-authored picture rehangs', s.hung && s.hasMap && s.mapSrc === img && s.count === 1, JSON.stringify(s));
  }
  check('no page errors across the cycle', errs.length === 0, errs.join(' | '));
} finally {
  await close();
}
done();
