// vegetation — asset-driven ground flora (tuft cards, shrub clusters, rosettes), instanced with wind and pushers;
// maps: assets/grass/<species>_{albedo,normal,roughness,translucency}.png (albedo alpha is the cutout).
// Wind and pushers derived from CK42BB/procedural-grass-threejs (MIT): keep this credit.
// Copyright (c) 2026 Kingsley, MIT licence; full notice in THIRD-PARTY.md.

const T3 = globalThis.THREE;
const {
    positionLocal, attribute, uniform, uniformArray, texture: texNode,
    float, vec2, vec3, vec4, sin, cos, dot, normalize, smoothstep, max: tmax,
    pow, saturate, step, fract, positionWorld, cameraPosition, Fn, tanh, luminance, min: tmin,
    If, vertexIndex,
    normalLocal, transformNormalToView, uv: uvNode, mix,
} = T3;

const ASSET_DIR = 'eidoverse/assets/grass/';

// luminance-preserving multipliers (a hue swap, not a darkening); hydrated from defs/flora/_colors.json and _presets.json
export const GRASS_COLORS = {};
export const FLORA_PRESETS = {};

import { buildShrubGeometry } from './vegetation_shrub_gen.js';
import { buildCornGeometry } from './vegetation_corn_gen.js';
import { buildSunflowerGeometry } from './vegetation_sunflower_gen.js';

// ── species registry ─────────────────────────────────────────────────────────
// card:    { w, h, curve, cup, segH } — one curved strip, full sheet per card
// tuft:    N cards crossed around a shared root (grass archetype)
// shrub:   N cards fanned outward on a shell around the cluster centre
// rosette: crossed vertical fans + a low horizontal card (radial sheet)
export const FLORA_SPECIES = {};

// species are data (defs/flora/<name>.json, shared/floradefs.js), hydrated once before the first build
// object identity is load-bearing: hydration mutates this export, never replaces it (the loader shim publishes it)
let defsLoading = null;

/** Takes {flora, floraColors} or a bare species map; colours land first, so `leafRecolor` can name a palette entry. */
export function hydrateFloraDefs(reg) {
    const flora = reg?.flora ?? reg;
    for (const [name, c] of Object.entries(reg?.floraColors ?? {})) GRASS_COLORS[name] = c;
    for (const [name, p] of Object.entries(reg?.floraPresets ?? {})) FLORA_PRESETS[name] = p;
    for (const [name, def] of Object.entries(flora ?? {})) {
        const d = { ...def };
        if (typeof d.leafRecolor === 'string') {
            const e = GRASS_COLORS[d.leafRecolor];
            if (!e) {
                console.warn(`[grass2] def '${name}' names unknown color '${d.leafRecolor}' — leafRecolor dropped`);
                delete d.leafRecolor;
            } else d.leafRecolor = e.recolor ?? e;
        }
        FLORA_SPECIES[name] = d;
    }
    return FLORA_SPECIES;
}

/** GET /defs, once and race-safe; a FAILED fetch clears the memo so the next build retries.
*  A hand-hydrated registry is left untouched. */
export async function ensureFloraDefs() {
    if (Object.keys(FLORA_SPECIES).length) return FLORA_SPECIES;
    if (!defsLoading) {
        defsLoading = (async () => {
            const r = await fetch('/defs');
            if (!r.ok) throw new Error(`[grass2] GET /defs -> ${r.status} — species defs unavailable (serve defs/, or hydrateFloraDefs() by hand)`);
            const reg = await r.json();
            hydrateFloraDefs(reg);
            console.log(`[grass2] flora defs hydrated: ${Object.keys(FLORA_SPECIES).length} species`);
            return FLORA_SPECIES;
        })().catch((err) => { defsLoading = null; throw err; });
    }
    return defsLoading;
}

/** In place (identities kept); the caller decides what to regrow. */
export async function refreshFloraDefs() {
    const r = await fetch('/defs');
    if (!r.ok) throw new Error(`[grass2] GET /defs -> ${r.status} — refresh refused`);
    const reg = await r.json();
    for (const k of Object.keys(FLORA_SPECIES)) if (!(k in (reg.flora ?? {}))) delete FLORA_SPECIES[k];
    for (const k of Object.keys(GRASS_COLORS)) if (!(k in (reg.floraColors ?? {}))) delete GRASS_COLORS[k];
    for (const k of Object.keys(FLORA_PRESETS)) if (!(k in (reg.floraPresets ?? {}))) delete FLORA_PRESETS[k];
    hydrateFloraDefs(reg);
    console.log(`[grass2] flora defs refreshed: ${Object.keys(FLORA_SPECIES).length} species`);
    return FLORA_SPECIES;
}

// ── map loading ──────────────────────────────────────────────────────────────
async function loadMap(name, { srgb = false } = {}) {
    try {
        const bytes = await Deno.readFile(ASSET_DIR + name);
        const t = await globalThis.loadImageTexture(bytes, srgb ? { srgb: true } : {});
        t.wrapS = t.wrapT = T3.ClampToEdgeWrapping;
        t.anisotropy = 4;
        return t;
    } catch { return null; }
}

// ── opaque-blade palette (§22m) ───────────────────────────────────────────────
// atlas columns sampled at build into root→tip vertex-colour ladders: no alpha test, so the opaque pass depth-rejects
async function sampleBladePalette(name, cols, loops) {
    try {
        let bytes = await Deno.readFile(ASSET_DIR + name);
        if (!(bytes[0] === 0x89 && bytes[1] === 0x50) && typeof fetch === 'function') {
            // a host may prime KTX2 bytes under the PNG name (§20d); the palette needs the raw PNG
            bytes = new Uint8Array(await (await fetch('/library/' + ASSET_DIR + name)).arrayBuffer());
        }
        if (!(bytes[0] === 0x89 && bytes[1] === 0x50)) return null;   // PNG bytes only
        const bmp = await createImageBitmap(new Blob([bytes]));
        const cv = new OffscreenCanvas(bmp.width, bmp.height);
        const cx = cv.getContext('2d', { willReadFrequently: true });
        cx.drawImage(bmp, 0, 0);
        const { data } = cx.getImageData(0, 0, bmp.width, bmp.height);
        const colW = bmp.width / cols;
        const lin = (v) => ((v /= 255), v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
        const pal = [];
        for (let c = 0; c < cols; c++) {
            const ladder = [];
            for (let lp = 0; lp <= loops; lp++) {
                const t = lp / loops;
                // t=0 is the ROOT and three flips PNGs, so the root rung reads the bottom rows
                const rowC = Math.round((1 - t) * (bmp.height - 1));
                let r = 0, g = 0, b = 0, w = 0;
                for (let dy = -6; dy <= 6; dy++) {
                    const y = Math.min(bmp.height - 1, Math.max(0, rowC + dy));
                    for (let x = Math.floor(c * colW); x < Math.floor((c + 1) * colW); x++) {
                        const i = (y * bmp.width + x) * 4, a = data[i + 3] / 255;
                        if (a < 0.5) continue;
                        r += lin(data[i]) * a; g += lin(data[i + 1]) * a; b += lin(data[i + 2]) * a; w += a;
                    }
                }
                // an empty band (past the tip) inherits the rung below
                // the gains are calibrated against the card render: flat vertex colour loses the atlas's dark detail
                ladder.push(w ? [(r / w) * 0.91, (g / w) * 0.86, (b / w) * 1.28]
                    : (ladder[lp - 1] ?? [0.05, 0.12, 0.03]));
            }
            pal.push(ladder);
        }
        return pal;
    } catch { return null; }   // no palette → caller keeps the atlas-card path
}

async function loadSpeciesMaps(base) {
    const [albedo, normal, rough, transl] = await Promise.all([
        loadMap(`${base}_albedo.png`, { srgb: true }),
        loadMap(`${base}_normal.png`),
        loadMap(`${base}_roughness.png`),
        loadMap(`${base}_translucency.png`, { srgb: true }),
    ]);
    if (!albedo) throw new Error(`[grass2] missing ${base}_albedo.png in ${ASSET_DIR}`);
    return { albedo, normal, rough, transl };
}

// shrub bark: the tube UVs wrap, so these tile
async function loadStemMaps(base) {
    const [albedo, rough] = await Promise.all([
        loadMap(`${base}_albedo.png`, { srgb: true }),
        loadMap(`${base}_roughness.png`),
    ]);
    for (const t of [albedo, rough]) if (t) t.wrapS = t.wrapT = T3.RepeatWrapping;
    return albedo ? { albedo, rough } : null;
}

// ── card geometry — a curved, cupped strip; aH = 0 root → 1 tip ─────────────
function cardGeometry({ w, h, curve = 0.2, cup = 0.08, segH = 3, segW = 2 }) {
    const g = new T3.PlaneGeometry(w, h, segW, segH);
    g.translate(0, h / 2, 0);                       // root at y=0
    const pos = g.attributes.position, uv = g.attributes.uv;
    const aH = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
        const t = pos.getY(i) / h;                  // 0 root → 1 tip
        const s = pos.getX(i) / (w / 2);            // -1 … 1 across
        // quadratic-bezier lean (p1 = curve at mid-height)
        pos.setZ(i, pos.getZ(i) + 2 * (1 - t) * t * curve * h + cup * s * s * w);
        aH[i] = t;
        uv.setY(i, t);                              // v runs root→tip
    }
    g.setAttribute('aH', new T3.BufferAttribute(aH, 1));
    g.computeVertexNormals();
    return g;
}

function mergeInto(acc, geo, mat4) {
    const g = geo.clone().applyMatrix4(mat4);
    acc.push(g);
    return g;
}

function mergeAll(list) {
    const { mergeGeometries } = T3.BufferGeometryUtils || globalThis.BufferGeometryUtils || {};
    if (mergeGeometries) return mergeGeometries(list, false);
    // fallback merge (position/normal/uv/aH, indexed)
    let vtx = 0, idx = 0;
    for (const g of list) { vtx += g.attributes.position.count; idx += g.index.count; }
    const pos = new Float32Array(vtx * 3), nor = new Float32Array(vtx * 3),
        uv = new Float32Array(vtx * 2), aH = new Float32Array(vtx),
        index = new Uint32Array(idx);
    let vo = 0, io = 0;
    for (const g of list) {
        pos.set(g.attributes.position.array, vo * 3);
        nor.set(g.attributes.normal.array, vo * 3);
        uv.set(g.attributes.uv.array, vo * 2);
        aH.set(g.attributes.aH.array, vo);
        const gi = g.index.array;
        for (let i = 0; i < gi.length; i++) index[io + i] = gi[i] + vo;
        vo += g.attributes.position.count; io += gi.length;
    }
    const out = new T3.BufferGeometry();
    out.setAttribute('position', new T3.BufferAttribute(pos, 3));
    out.setAttribute('normal', new T3.BufferAttribute(nor, 3));
    out.setAttribute('uv', new T3.BufferAttribute(uv, 2));
    out.setAttribute('aH', new T3.BufferAttribute(aH, 1));
    out.setIndex(new T3.BufferAttribute(index, 1));
    return out;
}

const _m4 = new T3.Matrix4(), _q = new T3.Quaternion(), _v = new T3.Vector3(), _e = new T3.Euler();

// normals lean world-up: per-card normals leave half the yawed instances facing away, near-black mid-distance
function blendNormalsUp(g, k = 0.65) {
    const nor = g.attributes.normal;
    for (let i = 0; i < nor.count; i++) {
        const nx = nor.getX(i) * (1 - k), ny = nor.getY(i) * (1 - k) + k, nz = nor.getZ(i) * (1 - k);
        const l = Math.hypot(nx, ny, nz) || 1;
        nor.setXYZ(i, nx / l, ny / l, nz / l);
    }
    return g;
}

// yaw-fanned with slight tilt scatter
function tuftGeometry(spec, rng) {
    const parts = [];
    const card = cardGeometry(spec.card);
    for (let i = 0; i < spec.cards; i++) {
        const yaw = (i / spec.cards) * Math.PI + (rng() - 0.5) * 0.5;
        const tilt = (rng() - 0.5) * 0.22;
        _e.set(tilt, yaw, (rng() - 0.5) * 0.12);
        _m4.makeRotationFromEuler(_e);
        mergeInto(parts, card, _m4);
    }
    return blendNormalsUp(mergeAll(parts), 1.0);   // normals straight up: light like the ground plane
}

// shrub bodies grow in vegetation_shrub_gen.js

// loops are fitted to each atlas column's measured alpha envelope, so the empty margin (and its overdraw) mostly goes
function bunchGeometry(spec, rng, fit, palette) {
    const { perBunch, bunchR, h, w, lean } = spec.blades;
    const COLS = 8;
    const cardW = w * 2;                  // the atlas column's full width
    const pos = [], aH = [], uv = [], idx = [], col = [];
    let vb = 0;
    const LOOPS = 4;                      // segments carrying the bend; instanced, so the cost is per blade geometry only
    for (let b = 0; b < perBunch; b++) {
        const ang = rng() * Math.PI * 2, rad = Math.sqrt(rng()) * bunchR;
        const bx = Math.cos(ang) * rad, bz = Math.sin(ang) * rad;
        const bh = h * (0.6 + rng() * 0.8), bw = cardW * (0.85 + rng() * 0.4);
        const roll = rng() * Math.PI * 2;
        const leanAmt = (0.25 + rng() * 0.75) * lean * bh;
        const cr = Math.cos(roll), sr = Math.sin(roll);
        const c = Math.floor(rng() * COLS);
        const bands = fit ? fit[c] : null;
        // §22m: jitter per channel, so tufts drift in hue like the atlas's blades, not just brightness
        const lad = palette ? palette[c] : null;
        const jr = 0.9 + rng() * 0.2, jg = 0.9 + rng() * 0.2, jb = 0.9 + rng() * 0.2;
        const s0 = vb;
        for (let lp = 0; lp <= LOOPS; lp++) {
            const t = lp / LOOPS;
            const [fcx, fhw] = bands ? bands[lp] : [0, 0.5];
            const bend = leanAmt * t * t;                 // pose lean (quadratic)
            const artC = fcx * bw;
            const px = bx + cr * (bend + artC), pz = bz + sr * (bend + artC);
            const py = t * bh;
            // opaque: the strip IS the silhouette; a tiny floor at the top loop guards a zero-area sliver
            const hwW = (palette ? Math.max(fhw, lp === LOOPS ? 0.012 : fhw) : fhw) * bw;
            pos.push(px - sr * hwW, py, pz + cr * hwW);
            pos.push(px + sr * hwW, py, pz - cr * hwW);
            uv.push((c + 0.5 + fcx - fhw) / COLS, t, (c + 0.5 + fcx + fhw) / COLS, t);
            aH.push(t, t);
            if (lad) {
                const [lr, lg, lb] = lad[lp];
                col.push(lr * jr, lg * jg, lb * jb, lr * jr, lg * jg, lb * jb);
            }
            vb += 2;
        }
        for (let lp = 0; lp < LOOPS; lp++) {
            const a = s0 + lp * 2;
            idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2);
        }
    }
    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    if (col.length) g.setAttribute('color', new T3.Float32BufferAttribute(col, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    // fully up: partial normals turned the meadow charcoal (side-facing normals see neither sun nor sky)
    return blendNormalsUp(g, 1.0);
}

// Mojave yucca: a golden-spiral crown of bayonets on a small dome, over a thatched trunk with a dry-leaf skirt
function yuccaGeometry(spec, rng) {
    const { r, spikes } = spec.rosette;
    const pos = [], uv = [], aH = [], idx = [];
    let vb = 0;
    const S = new T3.Vector3(), A = new T3.Vector3(), UPL = new T3.Vector3(), RAD = new T3.Vector3();
    const YUP = new T3.Vector3(0, 1, 0);
    const GA = 2.399963;   // golden angle
    // atlas thirds: live fronds | dry fronds | trunk thatch; the art's alpha carves the silhouettes
    const LIVE = [0.012, 0.32], DRY = [0.345, 0.655], BARK = [0.67, 0.996];
    const liveCol = () => LIVE;
    const dryCol = () => DRY;
    // a real column, not a ground collar; heroes scale this up per instance
    const trunkH = 0.22 + rng() * 0.28;
    const trunkR = 0.06 + rng() * 0.02;
    // the column is an arc and the crown rides its END tangent, so the head tips off-vertical
    const bendA = rng() * Math.PI * 2;
    const bendAmt = (0.1 + rng() * 0.55) * trunkH;
    const bcx = Math.cos(bendA) * bendAmt, bcz = Math.sin(bendA) * bendAmt;
    const trunkPoint = (t) => [bcx * t * t, t * trunkH, bcz * t * t];
    const qAt = (t) => {                    // frame of the arc at height fraction t
        A.set(2 * bcx * t, trunkH, 2 * bcz * t).normalize();
        return new T3.Quaternion().setFromUnitVectors(YUP, A);
    };

    // a V-folded bayonet; qRot tips its whole frame with the column so leaves follow the lean
    function spike(yaw, pitch, len, u0, u1, bx, by, bz, droopK, qRot) {
        const w0 = len * 0.145 * (0.9 + rng() * 0.3);
        A.set(Math.cos(yaw) * Math.cos(pitch), Math.sin(pitch), Math.sin(yaw) * Math.cos(pitch));
        S.set(-Math.sin(yaw), 0, Math.cos(yaw));
        UPL.set(0, 1, 0);
        if (qRot) { A.applyQuaternion(qRot); S.applyQuaternion(qRot); UPL.applyQuaternion(qRot); }
        const segs = 3, s0 = vb;
        for (let sg = 0; sg <= segs; sg++) {
            const t = sg / segs;
            const wHere = w0 * (1 - t * 0.94);
            const droop = droopK * len * t * t;   // gravity sag stays world-down
            const cxp = bx + A.x * len * t, cyp = by + A.y * len * t + droop, czp = bz + A.z * len * t;
            const foldUp = wHere * 0.55;
            pos.push(cxp - S.x * wHere, cyp - S.y * wHere, czp - S.z * wHere); uv.push(u0, t); aH.push(t * 0.3);
            pos.push(cxp + UPL.x * foldUp, cyp + UPL.y * foldUp, czp + UPL.z * foldUp); uv.push((u0 + u1) / 2, t); aH.push(t * 0.3);
            pos.push(cxp + S.x * wHere, cyp + S.y * wHere, czp + S.z * wHere); uv.push(u1, t); aH.push(t * 0.3);
            vb += 3;
        }
        for (let sg = 0; sg < segs; sg++) {
            const a = s0 + sg * 3, b = a + 3;
            idx.push(a, a + 1, b, a + 1, b + 1, b, a + 1, a + 2, b + 1, a + 2, b + 2, b + 1);
        }
    }

    // trunk: rings along the arc, base sunk below grade
    {
        const n = 10, rings = 4, s0 = vb;
        for (let g = 0; g <= rings; g++) {
            const t = g / rings;
            const [cx, cy, cz] = trunkPoint(t);
            const rad = trunkR * (1.12 - 0.27 * t);
            const y = g === 0 ? -0.05 : cy;
            for (let i = 0; i <= n; i++) {
                const a = (i / n) * Math.PI * 2;
                const u = BARK[0] + (BARK[1] - BARK[0]) * (i / n);
                pos.push(cx + Math.cos(a) * rad, y, cz + Math.sin(a) * rad);
                uv.push(u, 0.02 + t * trunkH * 0.9); aH.push(0);
                vb += 1;
            }
        }
        for (let g = 0; g < rings; g++) for (let i = 0; i < n; i++) {
            const a = s0 + g * (n + 1) + i, b = a + n + 1;
            idx.push(a, b, a + 1, a + 1, b, b + 1);
        }
        const [tx, ty, tz] = trunkPoint(1);
        const cTop = vb;
        pos.push(tx, ty + 0.01, tz); uv.push((BARK[0] + BARK[1]) / 2, 0.6); aH.push(0); vb += 1;
        const lastRing = s0 + rings * (n + 1);
        for (let i = 0; i < n; i++) idx.push(lastRing + i, cTop, lastRing + i + 1);
    }

    // dried skirt: a tight downswept band under the crown, in the arc's local frame
    const nSkirt = Math.round(spikes * 0.8);
    for (let i = 0; i < nSkirt; i++) {
        const tS = i / nSkirt;
        const yaw = i * GA + rng() * 0.3;
        const hFrac = Math.min(1, 0.72 + 0.26 * tS + rng() * 0.04);
        const [cx, cy, cz] = trunkPoint(hFrac);
        const qR = qAt(hFrac);
        const pitch = -(0.35 + rng() * 0.8);
        const len = r * (0.3 + 0.2 * tS + rng() * 0.14);          // oldest (lowest) slightly shorter
        const col = tS < 0.35 ? BARK : dryCol();                  // oldest thatch weathers to trunk colour
        RAD.set(Math.cos(yaw) * trunkR * 0.9, 0, Math.sin(yaw) * trunkR * 0.9).applyQuaternion(qR);
        spike(yaw, pitch, len, col[0], col[1], cx + RAD.x, cy + RAD.y, cz + RAD.z, -0.28, qR);
    }

    // live crown: t=0 centre → near-vertical, t=1 rim plunging into the skirt
    const qTop = qAt(1);
    const [tpx, tpy, tpz] = trunkPoint(1);
    for (let i = 0; i < spikes; i++) {
        const t = (i + 0.5) / spikes;
        const yaw = i * GA + rng() * 0.25;
        const pitch = 1.45 - t * 2.1 + rng() * 0.12;              // ~83° → ~-37°
        const baseR = trunkR * (0.15 + 0.8 * Math.sqrt(t));
        const hDome = 0.02 + 0.055 * (1 - t * t);                 // dome: centre sits higher
        const len = r * (0.6 + 0.42 * Math.sin(Math.min(Math.PI, (0.25 + t * 0.75) * Math.PI)) + rng() * 0.12);
        RAD.set(Math.cos(yaw) * baseR, hDome, Math.sin(yaw) * baseR).applyQuaternion(qTop);
        const lc = liveCol();
        spike(yaw, pitch, len, lc[0], lc[1], tpx + RAD.x, tpy + RAD.y, tpz + RAD.z, -0.04, qTop);
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setIndex(idx);
    g.computeVertexNormals();
    return blendNormalsUp(g, 0.35);
}

function rosetteGeometry(spec, rng) {
    const { r, cards, topCard } = spec.rosette;
    const parts = [];
    const fan = cardGeometry({ w: r * 2, h: r * 1.5, curve: 0.05, cup: 0.02, segH: 2 });
    for (let i = 0; i < cards; i++) {
        _e.set(0, (i / cards) * Math.PI + (rng() - 0.5) * 0.2, 0);
        _m4.makeRotationFromEuler(_e);
        mergeInto(parts, fan, _m4);
    }
    if (topCard) {
        const flat = cardGeometry({ w: r * 2, h: r * 2, curve: 0, cup: 0, segH: 1 });
        _e.set(-Math.PI / 2, rng() * Math.PI, 0);
        _m4.makeRotationFromEuler(_e).setPosition(0, r * 0.55, 0);
        mergeInto(parts, flat, _m4);
    }
    return blendNormalsUp(mergeAll(parts), 0.5);
}

// ── cross-field occupancy — content-aware overlap ───────────────────────────
import { resetFloraOccupancy, valueNoise2D, placeInstances, placeRows, placeExplicit } from '../../../shared/flora-placement.js';
export { resetFloraOccupancy } from '../../../shared/flora-placement.js';

// `surface`: any mesh(es) become a height field by raycasting straight down; null where the ray misses
function surfaceSampler(surface) {
    const meshes = Array.isArray(surface) ? surface : [surface];
    for (const m of meshes) m.updateWorldMatrix(true, false);
    const ray = new T3.Raycaster();
    const down = new T3.Vector3(0, -1, 0);
    const from = new T3.Vector3();
    return (x, z) => {
        from.set(x, 10000, z);
        ray.set(from, down);
        const hits = ray.intersectObjects(meshes, true);
        if (!hits.length) return null;
        const h = hits[0];
        const n = h.normal ?? new T3.Vector3(0, 1, 0);
        if (n.y < 0) n.negate();
        return { y: h.point.y, slope: Math.acos(Math.min(1, Math.abs(n.y))), nx: n.x, ny: n.y, nz: n.z };
    };
}


// ── the shared gust-envelope noise texture ───────────────────────────────────
let _gustTex = null;
function gustTex() {
    if (_gustTex) return _gustTex;
    const n = 256, d = new Uint8Array(n * n * 4);
    const nz = valueNoise2D(3);
    for (let i = 0; i < n * n; i++) {
        const x = i % n, y = (i / n) | 0;
        let v = 0, amp = 0.55, f = 0.035;
        for (let o = 0; o < 4; o++) { v += nz(x * f, y * f) * amp; amp *= 0.5; f *= 2; }
        const c = Math.max(0, Math.min(255, v * 255)) | 0;
        d[i * 4] = c; d[i * 4 + 1] = c; d[i * 4 + 2] = c; d[i * 4 + 3] = 255;
    }
    _gustTex = new T3.DataTexture(d, n, n, T3.RGBAFormat);
    _gustTex.wrapS = _gustTex.wrapT = T3.RepeatWrapping;
    _gustTex.magFilter = _gustTex.minFilter = T3.LinearFilter;
    _gustTex.needsUpdate = true;
    return _gustTex;
}

// ── main ─────────────────────────────────────────────────────────────────────
export async function createFlora(opts = {}) {
    await ensureFloraDefs();   // §24: species are data
    let spec = FLORA_SPECIES[opts.species === 'meadow_blades' ? 'grass' : opts.species];
    if (!spec) throw new Error(`[grass2] unknown species '${opts.species}' — have: ${Object.keys(FLORA_SPECIES).join(', ')}`);
    const o = {
        width: 24, depth: 24, center: [0, 0], y: 0, seed: 7,
        maxSlope: 0.9, sunDir: [-0.5, 0.8, 0.3], windDir: [1, 0.3],
        ...opts,
    };
    // `size` = stand diameter; width/depth make an elliptical stand
    if (opts.size) {
        if (!opts.width) o.width = opts.size;
        if (!opts.depth) o.depth = opts.size;
    }
    // `surface` = mesh(es) to grow on by raycast; heightFn wins if both are given; `placements` keep their own y
    if (opts.surface && !opts.heightFn) o._surfaceAt = surfaceSampler(opts.surface);
    // `align` = tilt with the surface normal (0 world-up … 1 full normal)
    o._align = opts.align ?? (spec.blades ? 0.75 : 0.15);
    // `height` (m) overrides blade length and scales wind: windK ~ (h/authored)^1.4, clamped 0.25..2.2
    // `height` and `color` (GRASS_COLORS name or [r,g,b]) apply to blade grasses only
    if (opts.color) {
        if (!spec.blades) throw new Error(`[grass2] 'color' applies to blade grasses only — '${opts.species}' keeps its authored sheet colours`);
        const entry = Array.isArray(opts.color) ? opts.color : GRASS_COLORS[opts.color];
        if (!entry) throw new Error(`[grass2] unknown color '${opts.color}' — have: ${Object.keys(GRASS_COLORS).join(', ')} (or a custom [r,g,b])`);
        if (Array.isArray(entry)) spec = { ...spec, leafTint: entry };
        else spec = { ...spec, leafRecolor: entry.recolor };
    }
    if (opts.height && spec.blades) {
        const hK = Math.min(2.2, Math.max(0.25, (opts.height / spec.blades.h) ** 1.4));
        spec = {
            ...spec,
            blades: { ...spec.blades, h: opts.height },
            wind: {
                ...spec.wind,
                base: spec.wind.base * hK,
                gust: spec.wind.gust * hK,
                flutter: spec.wind.flutter * Math.sqrt(hK),
            },
        };
    }
    // §22m: with maps null the no-maps branches are the opaque material; a failed sample falls back to atlas cards
    // COLS/LOOPS must match bunchGeometry's
    const wantOpaque = !!o.opaqueBlades && spec.archetype === 'blades' && !!spec.maps;
    const palette = wantOpaque ? await sampleBladePalette(spec.maps + '_albedo.png', 8, 4) : null;
    if (wantOpaque && !palette) console.warn('[grass2] opaque-blade palette sample failed — atlas cards fallback');
    const maps = (spec.maps && !palette) ? await loadSpeciesMaps(spec.maps) : null;
    let bladeFit = null;
    if (spec.archetype === 'blades' && spec.maps) {
        try { bladeFit = JSON.parse(await Deno.readTextFile(ASSET_DIR + spec.maps + '_fit.json')); }
        catch { /* no fit data — unfitted rectangles still render */ }
    }

    // seeded, so fields differ by seed
    const gRng = (() => { let s = (o.seed + 13) * 48271 % 2147483647;
        return () => { s = (s * 48271) % 2147483647; return s / 2147483647; }; })();
    let shrubAnchor = null;
    if (spec.archetype === 'shrub') {
        try { shrubAnchor = JSON.parse(await Deno.readTextFile(ASSET_DIR + 'shrub_anchors.json'))[spec.maps] ?? null; }
        catch { /* unmeasured sheets still place by card base */ }
    }
    let shrubGeos = null;
    if (spec.archetype === 'shrub') {
        shrubGeos = buildShrubGeometry(spec.gen, `${spec.gen}:${o.seed}:${o.variant ?? 0}`, shrubAnchor);
        console.log(`[grass2] ${spec.gen} skeleton: ${shrubGeos.stats.stems} stems, ${shrubGeos.stats.terminals} terminals, ${shrubGeos.stats.woodVerts}+${shrubGeos.stats.leafVerts} verts`);
    }
    let cornBuild = null;
    if (spec.archetype === 'corn') {
        cornBuild = buildCornGeometry('corn', `corn:${o.seed}:${o.variant ?? 0}`,
            { ...spec.corn, ...(opts.corn ?? {}) });
        blendNormalsUp(cornBuild.geo, 0.3);
        console.log(`[grass2] corn plant: ${cornBuild.stats.verts} verts, ${cornBuild.stats.tris} tris`);
    }
    if (spec.archetype === 'sunflower') {
        // fitted envelopes measured from the art; the gen has a fallback if the json is absent
        let sunFit = null;
        try { sunFit = JSON.parse(await Deno.readTextFile(ASSET_DIR + 'sunflower_fit.json')); }
        catch { /* fallback envelopes in the gen */ }
        cornBuild = buildSunflowerGeometry('sunflower', `sunflower:${o.seed}:${o.variant ?? 0}`,
            { fit: sunFit, ...spec.sunflower, ...(opts.sunflower ?? {}) });
        // the gen owns its normals: never re-blend here
        console.log(`[grass2] sunflower plant: ${cornBuild.stats.verts} verts, ${cornBuild.stats.tris} tris`);
    }
    const baseGeo = shrubGeos ? shrubGeos.leaf
        : cornBuild ? cornBuild.geo
        : spec.archetype === 'rosette' ? rosetteGeometry(spec, gRng)
        : spec.archetype === 'yucca' ? yuccaGeometry(spec, gRng)
        : spec.archetype === 'blades' ? bunchGeometry(spec, gRng, bladeFit, palette)
        : tuftGeometry(spec, gRng);

    const inst = o.placements
        ? placeExplicit(o, spec)
        : o.rows ? placeRows(o, spec)
        : placeInstances(o, spec);
    if (!inst.length) { console.warn('[grass2] zero instances placed'); }
    const count = inst.length;
    const posRot = new Float32Array(count * 4), scaleVar = new Float32Array(count * 4),
        phase = new Float32Array(count * 3);
    for (let i = 0; i < count; i++) {
        const p = inst[i];
        posRot.set([p.x, p.y, p.z, p.yaw], i * 4);
        scaleVar.set([p.scale, p.scale * (0.85 + p.colorVar * 0.3), p.tilt, p.colorVar], i * 4);
        phase.set([p.phase, p.tx ?? 0, p.tz ?? 0], i * 3);
    }
    const geo = baseGeo;
    geo.setAttribute('aPosRot', new T3.InstancedBufferAttribute(posRot, 4));
    geo.setAttribute('aScaleVar', new T3.InstancedBufferAttribute(scaleVar, 4));
    geo.setAttribute('aPhase', new T3.InstancedBufferAttribute(phase, 3));

    // ── material ────────────────────────────────────────────────────────────
    const isBlades = spec.archetype === 'blades';
    // opts.fastShade (§22l): one albedo sample (a 4 cm blade can't show relief, roughness or SSS); off by default
    const fast = !!o.fastShade;
    // fastShade drops albedo anisotropy 4 → 1 (the sampler is shared, but the atlas is per species)
    if (fast && maps && maps.albedo) maps.albedo.anisotropy = 1;
    const hasTransl = !!(maps && maps.transl) && !fast;
    const MatClass = hasTransl ? T3.MeshSSSNodeMaterial : T3.MeshStandardNodeMaterial;
    const mat = new MatClass({
        side: T3.DoubleSide, metalness: 0, roughness: spec.rough,
        alphaTest: maps ? 0.35 : 0, transparent: false,
    });
    // §22m: palette blades mute the specular veil (high roughness, reduced intensity)
    if (palette) { mat.roughness = Math.min(1, (spec.rough ?? 0.7) * 1.35); mat.specularIntensity = 0.35; }
    // never set vertexColors: colorNode reads them, so it would square the colour toward black

    const uT = uniform(0);
    const uWindDir = uniform(new T3.Vector2(o.windDir[0], o.windDir[1]).normalize());
    const uBase = uniform(spec.wind.base * (o.wind ?? 1));
    const uGust = uniform(spec.wind.gust * (o.wind ?? 1));
    const uGustFreq = uniform(spec.wind.gustFreq);
    const uSunDir = uniform(new T3.Vector3(...o.sunDir).normalize());
    const pushArr = uniformArray([new T3.Vector4(0, 0, 0, 0), new T3.Vector4(0, 0, 0, 0),
        new T3.Vector4(0, 0, 0, 0), new T3.Vector4(0, 0, 0, 0)]);

    const aPR = attribute('aPosRot'), aSV = attribute('aScaleVar'),
        aPh = attribute('aPhase'), aHgt = attribute('aH');

    // instance transform in the vertex stage: scale → tilt(X) → yaw(Y) → translate → wind → push
    mat.positionNode = Fn(() => {
        // density LOD (opts.lodGrow, §22e/f): distant survivors grow up to `cap` (area ∝ scale²)
        // with `exp`, keep iff phase rank < ((far−d)/(far−near))^exp: no tile seams; the killed collapse to zero scale
        const lg = o.lodGrow;
        let grow = float(1);
        let growW = null;       // §22q: width only, never height (a taller meadow near the camera would READ)
        let aliveCond = null;   // §22h: gates the dynamics; a zero-scaled instance still pays the vertex program
        if (lg) {
            const dCam = aPR.xz.sub(cameraPosition.xz).length();
            const t01 = smoothstep(float(lg.near ?? 15), float(lg.far ?? 90), dCam);
            grow = mix(float(1), float(lg.cap ?? 1.7), t01);
            // §22q: baseKeep < 1 thins everywhere and widens survivors by 1/√baseKeep, except a guard ring at the feet
            // requires lg.exp
            const bk = lg.exp != null && lg.baseKeep < 1 ? lg.baseKeep : null;
            let baseT = null;
            if (bk != null) {
                baseT = smoothstep(float(lg.guardNear ?? 2), float(lg.guardFar ?? 8), dCam);
                growW = mix(float(1), float(1 / Math.sqrt(bk)), baseT);
            }
            if (lg.exp != null) {
                let keep = pow(saturate(
                    float(lg.far ?? 90).sub(dCam)
                        .div(float((lg.far ?? 90) - (lg.near ?? 15)))), float(lg.exp));
                if (baseT != null) keep = keep.mul(mix(float(1), float(bk), baseT));
                const rank = fract(aPh.x.mul(0.15915494309189535));   // 1/2π: phase → [0,1) rank
                aliveCond = rank.lessThanEqual(keep);
                grow = grow.mul(step(rank, keep));
                if (lg.vertsPerBlade) {
                    // §22h: per-blade dither, hashed per instance, so tufts lose different blades with no pop
                    const bladeId = float(vertexIndex).div(float(lg.vertsPerBlade)).floor();
                    const bKeep = mix(float(1), float(lg.bladeKeepFar ?? 0.4), t01);
                    const bRank = fract(bladeId.mul(0.6180339887).add(rank.mul(7.13)));
                    aliveCond = aliveCond.and(bRank.lessThanEqual(bKeep));
                    grow = grow.mul(step(bRank, bKeep));
                }
            }
        }
        // §22q: width multiplies x/z only; grow carries the step, so a killed instance collapses on every axis
        let p = growW == null
            ? positionLocal.mul(vec3(aSV.x, aSV.y, aSV.x).mul(grow)).toVar()
            : positionLocal.mul(vec3(aSV.x.mul(growW), aSV.y, aSV.x.mul(growW)).mul(grow)).toVar();
        const cR = cos(aPR.w), sR = sin(aPR.w);
        p = vec3(p.x.mul(cR).sub(p.z.mul(sR)), p.y, p.x.mul(sR).add(p.z.mul(cR))).toVar();
        // world tilt (aPhase.yz): random lean + surface-normal share, post-yaw about world X then Z
        const cX = cos(aPh.y), sX = sin(aPh.y);
        p = vec3(p.x, p.y.mul(cX).sub(p.z.mul(sX)), p.y.mul(sX).add(p.z.mul(cX))).toVar();
        const cZ = cos(aPh.z), sZ = sin(aPh.z);
        p = vec3(p.x.mul(cZ).sub(p.y.mul(sZ)), p.x.mul(sZ).add(p.y.mul(cZ)), p.z).toVar();
        const world = p.add(aPR.xyz).toVar();

        const hF = aHgt, h2 = hF.mul(hF);
        // §22h: a dither-killed vertex must not pay the wind/pusher tail
        const disp = vec2(0, 0).toVar();
        const buildDynamics = () => {
        // layer 1 — global sway
        const gPhase = dot(world.xz, uWindDir).mul(0.5).add(uT.mul(1.2));
        const gSway = uWindDir.mul(sin(gPhase)).mul(uBase).toVar();
        // layer 2 — gust fronts rolled by a noise envelope
        const gustPhase = dot(world.xz, uWindDir).mul(uGustFreq).add(uT.mul(2.5));
        const env = smoothstep(0.3, 0.7,
            texNode(gustTex(), world.xz.mul(0.02).add(vec2(uT.mul(0.3 / 8))) ).r);
        const gustSway = uWindDir.mul(sin(gustPhase)).mul(uGust).mul(env).toVar();
        // layer 3 — per-instance flutter
        const tPhase = uT.mul(3.0).add(aPh.x);
        const turb = vec2(sin(tPhase), cos(tPhase.mul(0.7))).mul(0.1 * spec.wind.flutter).toVar();

        const windXZ = gSway.add(gustSway).add(turb).mul(h2).toVar();

        // pushers: quadratic falloff ×h², from the root so the plant leans as one; species stiffness, soft ceiling
        const pushK = spec.pushScale ?? 1.0;
        const push = vec2(0, 0).toVar();
        for (let i = 0; i < 4; i++) {
            const P = pushArr.element(i);
            const delta = aPR.xz.sub(P.xz);                 // root → pusher, stable per plant
            const dTrue = delta.length();
            // direction floor 0.3: fades to zero at the pusher centre instead of whipping 180° over a root
            const d = tmax(dTrue, 0.3);
            const live = step(0.001, P.w);                  // 0 when this pusher slot is off
            // strength from the closer of root and vertex (a long leaf feels a walker); direction root-based (per-vertex pinwheels)
            const vDist = world.xz.sub(P.xz).length();
            const s = float(1).sub(smoothstep(0.0, tmax(P.w, 0.001), tmin(dTrue, vDist))).toVar();
            push.addAssign(delta.div(d).mul(s.mul(s)).mul(1.35 * pushK).mul(live));
        }
        // tanh, never a hard min(): a cap snaps close plants between capped and easing as a walker passes
        const pLen = tmax(push.length(), 1e-4);
        const pushCapped = push.mul(float(0.6).mul(tanh(pLen.div(0.6))).div(pLen));
        // push yields the WHOLE plant (roots 30%, tips 100%): pure h² pins low branches through legs
        const pushH = hF.mul(0.7).add(0.3);
        disp.assign(windXZ.add(pushCapped.mul(pushH)));
        };   // end buildDynamics (§22h)
        if (aliveCond) If(aliveCond, buildDynamics); else buildDynamics();
        return world.add(vec3(disp.x, float(0), disp.y));
    })();

    // normals must turn with positionNode's yaw, or every plant is lit (and its SSS lobe aimed) wrong
    const rotNormal = Fn(() => {
        const cR = cos(aPR.w), sR = sin(aPR.w);
        return transformNormalToView(vec3(
            normalLocal.x.mul(cR).sub(normalLocal.z.mul(sR)),
            normalLocal.y,
            normalLocal.x.mul(sR).add(normalLocal.z.mul(cR))));
    })();
    // base (a light-gather direction) + the tangent map's deviation in the true geometric frame: volume AND relief
    if (maps && maps.normal && !fast) {
        const relief = T3.normalMap(texNode(maps.normal)).sub(T3.normalView);
        mat.normalNode = normalize(rotNormal.add(relief.mul(0.85)));
    } else {
        // fastShade: the gather normal alone (relief this thin is invisible)
        mat.normalNode = rotNormal;
    }

    // sheet albedo (or baked vertex colour) × per-instance shade
    const shade = float(1.0).add(aSV.w.sub(0.5).mul(0.15));
    // fastShade shares ONE albedo node between colour and opacity: two texNode() calls may not CSE
    const albSample = (fast && maps) ? texNode(maps.albedo) : null;
    let albRGB = albSample ? albSample.rgb
        : maps ? texNode(maps.albedo).rgb : attribute('color');
    if (spec.leafTint) albRGB = albRGB.mul(vec3(...spec.leafTint));
    // recolor: hue from the target, detail from atlas luminance (multiply can't unmake green)
    if (spec.leafRecolor) albRGB = luminance(albRGB).mul(vec3(...spec.leafRecolor));
    // regionTint: a hue shift in one UV window (corn's plume toward tan), with no part-id vertex buffer
    if (spec.regionTint) {
        const rt = spec.regionTint;
        const u = uvNode();
        const inR = step(float(rt.u0), u.x).mul(step(u.x, float(rt.u1)))
            .mul(step(float(rt.v0), u.y)).mul(step(u.y, float(rt.v1)));
        albRGB = albRGB.mul(mix(vec3(1, 1, 1), vec3(...rt.mul), inR));
    }
    mat.colorNode = albRGB.mul(shade);
    if (maps) {
        mat.opacityNode = albSample ? albSample.a : texNode(maps.albedo).a;
        if (maps.rough && !fast) mat.roughnessNode = texNode(maps.rough).r.mul(spec.rough);
        // fastShade: constant spec.rough, set above
    }

    // backlit translucency
    const sssAmt = (o.sss ?? 1) * spec.sss;
    if (hasTransl) {
        // per-light translucency (MeshSSSNodeMaterial), SeedThree's foliage values
        mat.thicknessColorNode = texNode(maps.transl).r.mul(float(sssAmt * 2.2));
        mat.thicknessDistortionNode = float(0.3);
        mat.thicknessAmbientNode = float(0.0);
        mat.thicknessAttenuationNode = float(1.0);
        mat.thicknessPowerNode = float(6.0);
        mat.thicknessScaleNode = float(3.0);
        mat.emissiveNode = albRGB.mul(0.08);     // faint fill so backfaces never go dead
    } else {
        // no translucency map: the cheap backlit approximation
        const V = normalize(cameraPosition.sub(positionWorld));
        const backlit = pow(saturate(dot(V.negate(), uSunDir)), 3.0);
        const sssTerm = albRGB.mul(0.5).mul(backlit).mul(sssAmt).mul(aHgt.mul(0.5).add(0.5));
        // §22m: palette blades take 0.08, not 0.2: the bigger lift washes the greens milky
        mat.emissiveNode = albRGB.mul(palette ? 0.08 : isBlades ? 0.2 : 0.1).add(sssTerm);
    }

    // shrub wood: a second instanced mesh, bark on the tubes' wrapped UVs; stemColor is only the no-asset fallback
    let stemMesh = null, stemMapsRef = null;
    if (shrubGeos && shrubGeos.stem) {
        {
            const stemGeo = shrubGeos.stem;
            stemGeo.setAttribute('aPosRot', new T3.InstancedBufferAttribute(posRot, 4));
            stemGeo.setAttribute('aScaleVar', new T3.InstancedBufferAttribute(scaleVar, 4));
            stemGeo.setAttribute('aPhase', new T3.InstancedBufferAttribute(phase, 3));
            stemMapsRef = spec.stem ? await loadStemMaps(spec.stem) : null;
            const stemMaps = stemMapsRef;
            const smat = new T3.MeshStandardNodeMaterial({
                metalness: 0, roughness: 0.9,
                color: spec.stemColor ?? 0x7a6a55,
            });
            if (stemMaps) {
                const tint = spec.stemTint ?? [1, 1, 1];
                smat.colorNode = texNode(stemMaps.albedo).rgb.mul(vec3(...tint)).mul(shade);
                if (stemMaps.rough) smat.roughnessNode = texNode(stemMaps.rough).r.mul(0.95);
            }
            smat.positionNode = mat.positionNode;           // same instance transform + wind
            smat.normalNode = mat.normalNode;               // same rotated lighting
            stemMesh = new T3.InstancedMesh(stemGeo, smat, count);
            for (let i = 0; i < count; i++) stemMesh.setMatrixAt(i, _m4.identity());
            stemMesh.instanceMatrix.needsUpdate = true;
            stemMesh.frustumCulled = false;
            stemMesh.userData.noSupportCheck = stemMesh.userData.noClippingCheck = true;
            stemMesh.userData.noCameraCollide = stemMesh.userData.noMotionCheck = true;
            stemMesh.userData.noWalkable = true;
            stemMesh.castShadow = true;             // solid wood casts honestly
        }
    }

    const mesh = new T3.InstancedMesh(geo, mat, count);
    for (let i = 0; i < count; i++) mesh.setMatrixAt(i, _m4.identity());
    mesh.instanceMatrix.needsUpdate = true;
    mesh.frustumCulled = false;
    mesh.userData.noSupportCheck = mesh.userData.noClippingCheck = true;
    mesh.userData.noCameraCollide = true; mesh.userData.noMotionCheck = true;
    mesh.userData.noWalkable = true;   // never a collider, even if passed to a controller
    mesh.receiveShadow = true;
    mesh.castShadow = false;                 // alpha cards stamp rectangles in the shadow pass

    const update = (t) => { uT.value = t || 0; };
    (globalThis._autoParticleSystems || (globalThis._autoParticleSystems = [])).push(update);

    const dispose = () => {
        const i = (globalThis._autoParticleSystems ?? []).indexOf(update);
        if (i >= 0) globalThis._autoParticleSystems.splice(i, 1);
        geo.dispose();
        mat.dispose();
        for (const t of maps ? [maps.albedo, maps.normal, maps.rough, maps.transl] : []) t?.dispose?.();
        if (stemMesh) { stemMesh.geometry.dispose(); stemMesh.material.dispose(); }
        for (const t of stemMapsRef ? [stemMapsRef.albedo, stemMapsRef.rough] : []) t?.dispose?.();
    };

    const setPushers = (list = []) => {
        for (let i = 0; i < 4; i++) {
            const p = list[i];
            pushArr.array[i].set(p ? p.x : 0, p ? (p.y ?? 0) : 0, p ? p.z : 0, p ? (p.r ?? 1.2) : 0);
        }
    };

    if (stemMesh) mesh.add(stemMesh);
    console.log(`[grass2] ${opts.species}: ${count} instances × ${geo.attributes.position.count} verts (${spec.archetype}${stemMesh ? '+stems' : ''})`);
    return { mesh, stemMesh, material: mat, update, setPushers, dispose,
        uniforms: { time: uT, windDir: uWindDir, base: uBase, gust: uGust, sunDir: uSunDir },
        count };
}

// helper-injection registration: HELPER_MODULES imports this module; scenes call the globals
globalThis.createFlora = createFlora;
globalThis.FLORA_SPECIES = FLORA_SPECIES;
globalThis.GRASS_COLORS = GRASS_COLORS;
globalThis.resetFloraOccupancy = resetFloraOccupancy;
