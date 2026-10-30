// picture-probe-harness: the owned world, join, request and state reader the picture probes share (picture-probe,
// picture-race-probe, picture-editor-probe). One reader of /lib/pictures.js `_hung`, so a renamed field reds all three.
import { launchBrowser, ownedWorld, checker } from './probe-harness.mjs';
import { join } from 'node:path';
import * as OP from '../shared/protocol/requests.js';
import { qFromYaw } from '../shared/rot.js';

export const LIB = 'eidoverse/assets/models/scif_cyberpunk_crt_retro_computer_monitor_screen_keyboard_tower.glb';

/** A founded world owned by the page's typed name (TRUST_NAMES, so its writes are admitted), a browser, a checker. */
export async function pictureWorld(name: string, owner: string, env: Record<string, string> = {}) {
  const world = await ownedWorld({ worlds: [name], owner, env: { TRUST_NAMES: '1', EIDOVERSE_DIR: process.env.EIDOVERSE_DIR ?? join(process.env.HOME!, 'origin/eidoverse-video'), ...env } });
  const { page, close } = await launchBrowser();
  const errs: string[] = [];
  /** A page joined as `as`: ready once the splash is gone and the client has a self. */
  const joinAs = async (as: string, onConsole?: (m: any) => void) => {
    const pg = await page();
    pg.on('pageerror', (e: Error) => errs.push(e.message));
    if (onConsole) pg.on('console', onConsole);
    pg.on('dialog', (d: any) => d.dismiss().catch(() => {}));
    // the sky's "off" tier: on a software renderer the default bake holds the page for minutes and loses its GPU context
    await pg.addInitScript(() => { try { localStorage.setItem('ew-cloud-quality', 'off'); } catch { /* opaque origin */ } });
    await pg.goto(`${world.origin}/?world=${name}&key=${world.key}&name=${as}`, { waitUntil: 'domcontentloaded' });
    await pg.waitForFunction(() => document.getElementById('splash')?.classList.contains('gone') && !!(globalThis as any).EW?.me?.(), null, { timeout: 120000 });
    return pg;
  };
  return { ...checker(), errs, joinAs, close: async () => { await close(); await world.close(); } };
}

/** A write through net.sendRequest; a refusal throws. */
export const req = async (pg: any, op: any) => {
  const r = await pg.evaluate((op: any) => import('/lib/net.js').then((n: any) => n.sendRequest(op.verb, op.args)), op);
  if (!r?.ok) throw new Error(`${op.verb} refused: ${JSON.stringify(r?.refused ?? r)}`);
  return r;
};

/** Places the console; the authority mints its id, read from the reply. */
export const spawnConsole = async (pg: any) => {
  const r = await req(pg, OP.create('$console', { model: LIB, transform: { pos: [1.3, 0.5, -2.2], q: qFromYaw(0.6) } }));
  const id = r.ids?.['$console'];
  if (!id) throw new Error(`create named no id: ${JSON.stringify(r)}`);
  return id as string;
};

export type PicState = {
  entity: boolean; hung: boolean; count: number; quads: number; mapW: number; hasMap: boolean; mapSrc: string | null;
  basic: boolean; white: boolean | null; blocked: string | null; original: boolean; part: boolean; comp: any;
  block: boolean; parts: string[] | null; src: string | null; msg: string | null; down: boolean;
};
/** What is on the thing (the quad, its material, the bag) and the scene panel's picture block, if open. */
export const state = (pg: any, id: string): Promise<PicState> => pg.evaluate(async (id: string) => {
  const { entities, findPart, bagOf } = await import('/lib/world.js');
  const { _hung, _blocked } = await import('/lib/pictures.js');
  const root = entities.get(id); const h = _hung.get(id);
  let mat: any = null; h?.quad?.traverse((o: any) => { if (o.isMesh && !mat) mat = o.material; });
  let quads = 0; root?.traverse((o: any) => { if (o.userData?.pictureQuad) quads++; });
  const block = document.querySelector('[data-pe-root]');
  return {
    entity: !!root, hung: !!h, count: _hung.size, quads, mapW: mat?.map?.image?.width ?? 0, hasMap: !!mat?.map,
    mapSrc: h?.picture?.src ?? null, basic: mat?.type === 'MeshBasicMaterial',
    white: mat?.color ? mat.color.getHex() === 0xffffff : null, blocked: _blocked.get(id) ?? null,
    original: !!root && !h, part: !!(root && findPart(root, 'screenplane')), comp: bagOf(id)?.picture ?? null,
    block: !!block, parts: block ? [...block.querySelectorAll('[data-pe="part"] option')].map((o: any) => o.value) : null,
    src: (block?.querySelector('[data-pe="src"]') as any)?.value ?? null,
    msg: block?.querySelector('[data-pe="msg"]')?.textContent ?? null,
    down: !!block?.querySelector('[data-pe="down"]'),   // rendered only when the bag holds a picture: the repaint's receipt
  };
}, id);

/** Polls state until pred holds or ms run out; returns the last state either way. */
export const until = async (pg: any, id: () => string, pred: (s: PicState) => boolean, ms = 20000) => {
  const t0 = Date.now(); let s!: PicState;
  while (Date.now() - t0 < ms) { s = await state(pg, id()); if (pred(s)) return s; await settle(150); }
  return s;
};
export const settle = (ms = 1500) => new Promise((r) => setTimeout(r, ms));

/** Holds every library fetch for `src` until release() is called. */
export async function hold(pg: any, src: string) {
  const file = src.split('/').pop()!;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  let held = 0;
  await pg.route((u: URL) => u.pathname.includes('/library/') && u.pathname.endsWith(file), async (route: any) => { held++; await gate; await route.continue(); });
  return { release: async () => { release(); await pg.unroute((u: URL) => u.pathname.includes('/library/') && u.pathname.endsWith(file)); }, heldCount: () => held };
}
