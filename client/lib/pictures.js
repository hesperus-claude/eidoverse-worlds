// pictures — the browser host for the `picture` component (what a bag means: shared/picture.js).
// 1. NEVER mutate the part's material: glTF materials are shared, so clone, texture the clone, restore on removal.
// 2. NEVER dispose the texture: loadImageTexture's cache owns it; the picture borrows it.

import { THREE } from './core.js';
import { bus } from './base.js';
import { primeFiles } from './assets.js';
import { entities, findPart, bags, bagOf } from './world.js';
import { CONFIG } from './base.js';
import { registerEditor, registerHandler, commitEdit } from './inspect.js';
import { namedParts } from './parts.js';
import { toast, flashHint } from './ui.js';
import { normalizePicture, PICTURE_LIT, PICTURE_ALT_MAX, PICTURE_STORE, ALT_HINT } from '../../shared/picture.js';
import { clientMayFetch } from '../../shared/mediasrc.js';
import { allowUntrusted, RIGHTS_WARNING } from './mediaprefs.js';
import { escapeHtml as esc } from './markup.js';

// No part = a QUAD of its own: `width` m wide, height from the aspect, facing +Z (the back a second plane turned π so
// it isn't mirrored); a 1:1 plate until decode; world extent held to 50 m.
// Bytes per shared/mediasrc.js: untrusted links only with this viewer's opt-in; no credentials or referrer; ≤2048 px.
export const QUAD_MAX_EXTENT = 50;
export const MAX_TEXTURE_PX = 2048;
const blocked = new Map();   // id → why this browser didn't fetch it
export const _blocked = blocked;
// a link is loaded as an image, never fetched: CSP img-src allows any https host, connect-src stays home, so a
// script can't post what it reads (server/csp.ts). crossOrigin 'anonymous': no credentials, and the texture stays clean.
async function linkTexture(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous'; img.referrerPolicy = 'no-referrer'; img.decoding = 'async';
  await new Promise((res, rej) => { img.onload = res; img.onerror = () => rej(new Error('the image did not load')); img.src = url; });
  const bmp = await createImageBitmap(img);
  const k = Math.min(1, MAX_TEXTURE_PX / Math.max(bmp.width, bmp.height));
  const cv = document.createElement('canvas'); cv.width = Math.max(1, Math.round(bmp.width * k)); cv.height = Math.max(1, Math.round(bmp.height * k));
  cv.getContext('2d').drawImage(bmp, 0, 0, cv.width, cv.height); bmp.close?.();
  const tex = new THREE.CanvasTexture(cv); tex.colorSpace = THREE.SRGBColorSpace; return tex;
}
function quadOf(picture, aspect, tex) {
  const w = picture.width ?? 1, hgt = w * aspect;
  const g = new THREE.Group(); g.name = 'picture-quad'; g.userData.pictureQuad = true;
  const M = picture.lit === 'self' ? THREE.MeshBasicMaterial : THREE.MeshStandardMaterial;
  const mat = new M(tex ? { map: tex, alphaTest: 0.5, ...(M === THREE.MeshStandardMaterial ? { roughness: 0.9, metalness: 0 } : {}) } : { color: 0x9aa3ad, transparent: true, opacity: 0.3 });
  const geo = new THREE.PlaneGeometry(w, hgt); geo.translate(0, hgt / 2, 0);
  const front = new THREE.Mesh(geo, mat), back = new THREE.Mesh(geo, mat);
  back.rotation.y = Math.PI; front.position.z = 0.001; back.position.z = -0.001;
  g.add(front, back); g.userData.dispose = () => { geo.dispose(); mat.dispose(); };
  return g;
}
function holdExtent(root, g, picture, aspect) {
  const s = root.getWorldScale(new THREE.Vector3()); const big = Math.max(picture.width ?? 1, (picture.width ?? 1) * aspect) * Math.max(Math.abs(s.x), Math.abs(s.y), Math.abs(s.z));
  if (big > QUAD_MAX_EXTENT) g.scale.setScalar(QUAD_MAX_EXTENT / big);
}

// id → { picture, part, original, material } for every picture currently hung
const hung = new Map();
// id → revision of the CURRENT intent: every change bumps it; an async hang installs only if still current, so a late
// load never overwrites a newer bag or a removal
const revision = new Map();
const bump = (id) => { const r = (revision.get(id) ?? 0) + 1; revision.set(id, r); return r; };
const current = (id, r) => revision.get(id) === r;
// id → picture whose entity (or part) isn't in the scene yet (replay usually delivers the comp before the GLB)
const pending = new Map();

// a quad's PlaneGeometry UVs are WebGL's (v up: flip), a modelled part's glTF's (no flip); `flip` inverts either.
// Decided at decode: a shared ImageBitmap's flipY is a no-op after upload.
async function pictureTexture(picture, quad = false) {
  const flipY = quad ? picture.flip !== true : picture.flip === true;
  if (/^https:/i.test(picture.src)) { const t = await linkTexture(picture.src); t.flipY = flipY; t.needsUpdate = true; return t; }
  await primeFiles([picture.src]);
  const bytes = globalThis.Deno.readFileSync(picture.src);
  return globalThis.loadImageTexture(bytes, { srgb: true, flipY });
}

function takeDown(id) {
  const h = hung.get(id);
  if (!h) return;
  hung.delete(id);
  if (h.quad) { h.quad.parent?.remove(h.quad); h.quad.userData.dispose?.(); return; }
  // only restore if our clone is still what it wears (promote/demote re-realizes parts)
  if (h.part.material === h.material) h.part.material = h.original;
  h.material.dispose();     // ours; the texture is not (see rule 2)
}

async function hang(id, picture, rev) {
  // pending until a hang INSTALLS it, so a demote/promote mid-load still finds it to rehang
  pending.set(id, picture);
  const root = entities.get(id);
  if (!root) return;
  const mayFetch = clientMayFetch(picture.src, 'image', allowUntrusted());
  if (!mayFetch) blocked.set(id, 'untrusted'); else blocked.delete(id);
  if (!picture.part) {
    // the plate first (something to grab), the image if it arrives
    takeDown(id);
    const plate = quadOf(picture, 1, null); root.add(plate); holdExtent(root, plate, picture, 1);
    hung.set(id, { picture, quad: plate, root, aspect: null });
    pending.delete(id);
    if (!mayFetch) return;   // an untrusted link without this viewer's opt-in: never fetched
    let tex;
    try { tex = await pictureTexture(picture, true); }
    catch (e) { console.warn(`[pictures] ${id}: ${picture.src} could not be loaded — the plate stays empty`, e); return; }
    if (!current(id, rev) || entities.get(id) !== root || hung.get(id)?.quad !== plate) return;
    const img = tex.image; const aspect = img?.width > 0 ? img.height / img.width : 1;
    takeDown(id);
    const q = quadOf(picture, aspect, tex); root.add(q); holdExtent(root, q, picture, aspect);
    hung.set(id, { picture, quad: q, root, aspect });
    return;
  }
  if (!mayFetch) { pending.delete(id); return; }
  const part = findPart(root, picture.part);
  if (!part || !part.material) {
    // said once: no such part on this model; `measure {id}` lists them
    console.warn(`[pictures] ${id}: part "${picture.part}" not found on the model — nothing hung`);
    pending.delete(id);
    return;
  }
  let tex;
  try { tex = await pictureTexture(picture); }
  catch (e) { console.warn(`[pictures] ${id}: ${picture.src} could not be loaded — nothing hung`, e); return; }
  // a stale load (revision bumped while we waited) installs nothing
  if (!current(id, rev)) return;
  if (entities.get(id) !== root) return;   // entity re-realized mid-load
  // the old clone goes first, so `original` is always the model's own material, never a previous clone
  takeDown(id);
  const original = part.material;
  const material = original.clone();
  material.map = tex;
  // white base, or an authored colour tints it; a self-lit picture also drives emissive, like a screen
  if (material.color) material.color.set(0xffffff);
  if (picture.lit === 'self' && 'emissive' in material) {
    material.emissive.set(0xffffff);
    material.emissiveMap = tex;
    material.emissiveIntensity = 1;
  }
  material.needsUpdate = true;
  part.material = material;
  hung.set(id, { picture, part, original, material });
  pending.delete(id);
}

function applyFrom(id, data) {
  const rev = bump(id);
  if (data == null) { pending.delete(id); takeDown(id); return; }
  const norm = normalizePicture(data);
  if (!norm.ok) {
    console.warn(`[pictures] ${id}: ${norm.why}`);
    pending.delete(id); takeDown(id);
    return;
  }
  if (norm.notes?.length) console.warn(`[pictures] ${id}: ${norm.notes.join(' · ')}`);
  void hang(id, norm.picture, rev);
}

bus.on('comp', ({ id, type, data }) => {
  if (type !== 'picture') return;
  applyFrom(id, data);
  reconcileNote(id, data);
});

bus.on('entity', ({ id, kind }) => {
  if (kind === 'remove' || kind === 'demote') {
    // bump so an in-flight load doesn't install. DEMOTE keeps the bag pending for the promote; REMOVE clears it
    // (a later spawn of the same id starts from its own comps).
    bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); if (h.quad) h.quad.userData.dispose?.(); else h.material.dispose(); if (kind === 'demote') pending.set(id, h.picture); }
    // the status line is about THIS entity: a later spawn under the same id opens with none
    if (kind === 'remove') { pending.delete(id); notes.delete(id); }
  } else if (kind === 'spawn') {
    // a promote replaces the subtree: the old hang and old loads are stale; re-hang under a fresh revision
    const rev = bump(id);
    const h = hung.get(id);
    if (h) { hung.delete(id); if (h.quad) h.quad.userData.dispose?.(); else h.material.dispose(); pending.set(id, h.picture); }
    if (pending.has(id)) void hang(id, pending.get(id), rev);
  }
});

// status lines live outside the DOM (scenegraph.js rebuilds editors per echo), stamped with their bag: a disagreeing
// echo retires one, so a local status never reads newer than the world. Remove + respawn clears; demote/promote doesn't.
const notes = new Map();   // id → { text, warn, about: pictureKey }

/** One comparable string (`none` for no picture): echo and committed data both pass through here, so a server
 *  default or key order never reads as a change. */
function pictureKey(data) {
  if (data == null) return 'none';
  const n = normalizePicture(data);
  const p = n.ok ? n.picture : data;
  return JSON.stringify([p?.src ?? '', p?.alt ?? '', p?.lit ?? 'scene', p?.width ?? 1]);
}

/** The line stays only if it was about this very bag. */
function reconcileNote(id, data) {
  const n = notes.get(id);
  if (n && n.about !== pictureKey(data)) notes.delete(id);
}

bus.on('world-reset', () => clearPictures());
// the viewer's fetch rule changed: every picture is read again
bus.on('media:trust', () => { for (const [id, c] of bags()) if (c?.picture) applyFrom(id, c.picture); });

export function clearPictures() {
  pending.clear();
  notes.clear();
  for (const id of revision.keys()) bump(id);   // every load in flight is stale
  for (const id of [...hung.keys()]) takeDown(id);
}

/** For probes. */
export const _hung = hung;
export const _revision = revision;
export const pictureCount = () => hung.size;
export { THREE as _THREE };

// ---- the editor block: how a HUMAN hangs a picture -------------------------
// one verb per gesture (`hang` = the whole bag, `take down` = null), normalized first so a refusal is a hint here;
// a guarded thing gets a read-only line saying who may

const PICTURE_ACCEPT = 'image/png,image/jpeg,image/webp';

export { namedParts };   // from parts.js: the inspector reads the same list

/** Resolves to the library-relative path. */
export async function uploadPicture(file) {
  const q = new URLSearchParams({ as: 'image', name: file.name });
  if (CONFIG.token) q.set('token', CONFIG.token);
  const r = await fetch(`/upload?${q}`, { method: 'POST', body: file });
  if (!r.ok) throw new Error(`${r.status} ${await r.text()}`);
  const { path } = await r.json();
  if (typeof path !== 'string' || !path.startsWith(PICTURE_STORE)) throw new Error(`upload answered with an unexpected path: ${path}`);
  return path;
}

registerEditor(({ id, obj, meta, bag, commit }) => {
  if (!obj || meta?.kind === 'light') return null;   // a bulb has no part to texture
  const parts = namedParts(obj);
  if (!parts.length) return null;                     // the generic JSON row still exists
  const cur = bag?.picture && typeof bag.picture === 'object' ? bag.picture : null;
  const lit = cur?.lit === 'self' ? 'self' : 'scene';
  return {
    html: `<div data-pe-root style="display:flex;flex-direction:column;gap:4px;margin:4px 0">
      <div><b>🖼 picture</b> <span style="color:var(--dim);font-size:11px">${cur ? 'hung' : 'none hung'}</span></div>
      <label style="display:flex;gap:6px;align-items:center">image
        <input data-pe="src" type="text" placeholder="eidoverse/assets/… or store/images/…" value="${esc(cur?.src ?? '')}" style="flex:1;font-size:11px">
        <input data-pe="file" type="file" accept="${PICTURE_ACCEPT}" style="display:none">
        <button data-pe="pick" title="upload a PNG, JPEG or WebP into the store and use it">upload…</button></label>
      <label style="display:flex;flex-direction:column;gap:2px" title="${esc(ALT_HINT)}">alt text <span style="color:var(--dim);font-size:11px">(what it shows, in words; ≤${PICTURE_ALT_MAX})</span>
        <textarea data-pe="look" maxlength="${PICTURE_ALT_MAX}" rows="2" style="font-size:11px;font-family:inherit">${esc(cur?.alt ?? '')}</textarea></label>
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap">
        <label style="display:flex;gap:4px;align-items:center">lit
          <select data-pe="lit">${Object.entries(PICTURE_LIT).map(([k, v]) => `<option value="${k}"${k === lit ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select></label>
      </div>
      <div style="display:flex;gap:6px">
        <button data-pe="hang">${cur ? 'update' : 'hang'}</button>
        ${cur ? '<button data-pe="down" title="comp {type: \"picture\", data: null}">take down</button>' : ''}
        <span data-pe="msg" style="color:${notes.get(id)?.warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'};font-size:11px">${esc(notes.get(id)?.text ?? '')}</span>
      </div>
    </div>`,
    wire(root) {
      const q = (k) => root.querySelector(`[data-pe="${k}"]`);
      // `about`: the committed bag, or (omitted) the bag as it stands; survives the repaint, unlike the DOM
      const msg = (t, warn = false, about = bagOf(id)?.picture ?? null) => {
        notes.set(id, { text: t, warn, about: pictureKey(about) });
        const m = q('msg'); if (m) { m.textContent = t; m.style.color = warn ? 'var(--warn, #e8a33d)' : 'var(--dim)'; }
      };
      q('pick')?.addEventListener('click', () => q('file')?.click());
      q('file')?.addEventListener('change', async (ev) => {
        const file = ev.target.files?.[0];
        if (!file) return;
        msg(`uploading ${file.name}…`);
        try {
          const path = await uploadPicture(file);
          q('src').value = path;
          msg(`in the store as ${path.split('/').pop()} — now hang it`);
        } catch (err) { msg(`upload failed: ${err.message}`, true); toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
        ev.target.value = '';
      });
      q('hang')?.addEventListener('click', (ev) => {
        // shared/picture.js keeps src/width/alt/lit: no part or flip here
        const data = { src: q('src').value.trim(), lit: q('lit').value };
        const alt = q('look').value.trim();
        if (alt) data.alt = alt;
        const norm = normalizePicture(data);
        if (!norm.ok) { msg(norm.why, true); return; }   // refused here, before any round-trip
        commit('picture', norm.picture);
        msg(norm.notes.length ? norm.notes.join(' · ') : 'hung', false, norm.picture);
        if (norm.notes.length) flashHint(`🖼 ${norm.notes[0]}`);
        ev.target.blur();
      });
      q('down')?.addEventListener('click', (ev) => {
        commit('picture', null);
        msg('taken down', false, null);
        ev.target.blur();
      });
    },
  };
});

// ---- the edit-mode inspector's gestures (fields: shared/editschema.js). An upload is a GESTURE: pick, store, commit the path.
function pickFile(accept) {
  return new Promise((resolve) => {
    const inp = Object.assign(document.createElement('input'), { type: 'file', accept });
    inp.onchange = () => resolve(inp.files?.[0] ?? null);
    inp.click();
  });
}
async function uploadThenSet(id, key) {
  flashHint(`🖼 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(PICTURE_ACCEPT); if (!file) return;
  flashHint(`uploading ${file.name}…`);
  try {
    const path = await uploadPicture(file);
    const r = commitEdit(id, key, path);
    if (r.errors?.length) flashHint(`🖼 ${r.errors.join(' · ')}`, 6000);
    else flashHint(`🖼 hung ${path.split('/').pop()}`, 3000);
  } catch (err) { toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
}
registerHandler('picture', (id, _obj, k, _v, opts) => {
  if (k !== 'upload' || opts?.live) return false;
  uploadThenSet(id, 'picture.src'); return true;
});
registerHandler('comp', (id, _obj, k, _v, opts) => {
  if (k !== 'add:picture' || opts?.live) return false;
  uploadThenFace(id); return true;
});
// Add Component › Picture on a MODEL hangs on its front face as its own child (facemedia.js): a part-less one would
// draw inside the crate. On an empty it is its own quad.
async function uploadThenFace(id) {
  const fm = await import('./facemedia.js');
  if (!fm.frontOf(id)) return uploadThenSet(id, 'picture.src');
  flashHint(`🖼 ${RIGHTS_WARNING}`, 4000);
  const file = await pickFile(PICTURE_ACCEPT); if (!file) return;
  flashHint(`uploading ${file.name}…`);
  try {
    const path = await uploadPicture(file);
    const r = await fm.addOnFace(id, 'picture', { src: path });
    if (r?.ok) flashHint(`🖼 hung ${path.split('/').pop()} on its front`, 3000);
  } catch (err) { toast(`picture upload failed — ${err.message}`, 'warn', 8000); }
}
