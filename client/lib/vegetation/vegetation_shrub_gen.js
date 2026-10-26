// Vendored from eidoverse-video vegetation_shrub_gen.js @ 62365e9; cherry-pick upstream by hand, never auto-merge.
// shrub_gen — SeedThree's dichotomous plant math (dichotomous.js tubes, leaf-cards.js clusters, rng.js verbatim),
// baked into one geometry per plant for field instancing; card bases keep shrub_anchors.json's alignment.

const T3 = globalThis.THREE;

// ── seeded rng (SeedThree rng.js) ────────────────────────────────────────────
function xmur3(str) {
    let h = 1779033703 ^ str.length;
    for (let i = 0; i < str.length; i++) {
        h = Math.imul(h ^ str.charCodeAt(i), 3432918353);
        h = (h << 13) | (h >>> 19);
    }
    return function () {
        h = Math.imul(h ^ (h >>> 16), 2246822507);
        h = Math.imul(h ^ (h >>> 13), 3266489909);
        h ^= h >>> 16;
        return h >>> 0;
    };
}

export class Rng {
    constructor(seed) {
        const seedStr = typeof seed === 'number' ? `n:${seed}` : String(seed);
        this._state = xmur3(seedStr)() >>> 0;
    }
    next() {
        let z = (this._state = (this._state + 0x9e3779b9) | 0);
        z ^= z >>> 16; z = Math.imul(z, 0x21f0aaad);
        z ^= z >>> 15; z = Math.imul(z, 0x735a2d97);
        z ^= z >>> 15;
        return (z >>> 0) / 4294967296;
    }
    range(min, max) { return min + (max - min) * this.next(); }
    vary(base, spread) { return base + (this.next() * 2 - 1) * spread; }
}

// ── skeleton (SeedThree dichotomous.js, shrub paths) ─────────────────────────
const UP = new T3.Vector3(0, 1, 0);
const Y = new T3.Vector3(0, 1, 0);
const X = new T3.Vector3(1, 0, 0);
const DOWN = new T3.Vector3(0, -1, 0);
const GOLDEN = (137.5 * Math.PI) / 180;

const DEFAULTS = {
    firstForkHeight: 1.6,   // trunk length to the first fork (m)
    armLength: 0.9,         // segment length per generation (m)
    armFalloff: 0.86,       // each generation's segment a bit shorter
    forkGenerations: 6,
    branchiness: 0.62,      // P(a junction forks) — NOT every junction
    forkSpread: 32,         // divergence half-angle at a fork (deg)
    forkTriChance: 0.15,    // chance a fork is a trident instead of a Y
    curlUp: 0.35,           // tropism toward vertical per segment
    armBend: 16,            // programmatic elbow curve along each segment (deg)
    gnarliness: 12,         // random per-segment direction jitter (deg)
    continuationKink: 8,    // how hard a single-bud continuation veers (deg)
    forkRadiusKeep: 0.86,   // arms stay nearly as thick as the trunk per fork
    forkBaseScale: 1.0,     // arm base-ring radius as a fraction of the parent
    trunkRadius: 0.16,
    trunkFlare: 1.7,        // base swell
    trunkSegRes: 9,         // extra rings on the trunk for organic flare
    branchRepel: 0.7,       // arms steer AWAY from existing branches
    tipClearance: 0,        // crown-ball radius for crown-vs-crown repel
    minRadius: 0.02,
    radialSegs: 10,
    segCurveRes: 4,         // rings along one bent segment
    trunks: 1,
    trunkSplayDeg: 14,
    tileWorldSize: 0.8,     // bark UV tile (m)
};

function tropism(dir, amount) {
    if (amount <= 0) return dir;
    const dot = Math.max(-1, Math.min(1, dir.dot(UP)));
    const decl = Math.acos(dot);
    if (decl < 1e-4) return dir;
    const axis = new T3.Vector3().crossVectors(dir, UP);
    if (axis.lengthSq() < 1e-8) return dir;
    axis.normalize();
    return dir.clone().applyAxisAngle(axis, amount * decl).normalize();
}
function tropismInPlace(dir, amount) { dir.copy(tropism(dir, amount)); }

function perp(dir) {
    const a = Math.abs(dir.y) < 0.9 ? UP : X;
    return new T3.Vector3().crossVectors(dir, a).normalize();
}

// armBend elbow + gnarliness jitter + tropism: bends WITHOUT adding L-system forks
function growSegment(origin, dir0, length, radius0, radius1, p, rng, resOverride) {
    const res = Math.max(1, resOverride ?? p.segCurveRes);
    const points = [origin.clone()];
    const radii = [radius0];
    const dir = dir0.clone().normalize();
    const pos = origin.clone();
    const bendPer = ((p.armBend + rng.vary(0, p.gnarliness)) * Math.PI) / 180 / res;
    const bendAxis = perp(dir); // one plane per segment
    for (let i = 1; i <= res; i++) {
        dir.applyAxisAngle(bendAxis, bendPer);
        if (p.gnarliness > 0) {
            dir.applyAxisAngle(perp(dir), (rng.vary(0, p.gnarliness) * Math.PI) / 180 / res);
        }
        tropismInPlace(dir, p.curlUp / res);
        pos.addScaledVector(dir, length / res);
        points.push(pos.clone());
        radii.push(radius0 + (radius1 - radius0) * (i / res));
    }
    return { points, radii, endDir: dir.clone().normalize() };
}

// rotation-minimizing frame → per-point quaternions (local +Y = tangent)
function framesFor(points) {
    const orients = [];
    const tangents = [];
    const n = points.length;
    for (let i = 0; i < n; i++) {
        const t = new T3.Vector3();
        if (i === 0) t.subVectors(points[1], points[0]);
        else if (i === n - 1) t.subVectors(points[n - 1], points[n - 2]);
        else t.subVectors(points[i + 1], points[i - 1]);
        t.normalize();
        tangents.push(t);
        orients.push(new T3.Quaternion().setFromUnitVectors(Y, t));
    }
    return { orients, tangents };
}

function makeStem(seg, level, windBase, flexGain) {
    const { orients } = framesFor(seg.points);
    // clamp to 1: parent tip weight == child base weight, so forks stay welded under wind
    const winds = seg.points.map((_, i) => {
        const f = seg.points.length > 1 ? i / (seg.points.length - 1) : 0;
        return Math.min(1, windBase + flexGain * Math.pow(f, 1.15));
    });
    return {
        points: seg.points, radii: seg.radii, orients, winds,
        level, terminal: false, children: [],
    };
}

export function generateShrubSkeleton(userParams, rng) {
    const p = { ...DEFAULTS, ...userParams };
    const stems = [];
    const terminalStems = [];

    // steer a new arm AWAY from nearby branch points; crown-vs-crown keeps spray balls clear
    const allPts = [];
    const tips = [];
    const _rep = new T3.Vector3(), _probe = new T3.Vector3(), _d = new T3.Vector3();
    function repelDir(pos, dir, len) {
        const strength = p.branchRepel ?? 0;
        if (strength <= 0) return dir;
        const clr = p.tipClearance ?? 0;
        _probe.copy(pos).addScaledVector(dir, len * 0.8);
        const reach = len * 0.6 + clr;
        const R2 = reach ** 2, near2 = (len * 0.5) ** 2;
        _rep.set(0, 0, 0);
        for (const pt of allPts) {
            if (pt.distanceToSquared(pos) < near2) continue; // skip the parent neighborhood
            const dsq = _probe.distanceToSquared(pt);
            if (dsq < R2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, pt).multiplyScalar(1 / dsq));
        }
        const crownGap2 = (clr * 1.7) ** 2;
        for (const t of tips) {
            if (t.distanceToSquared(pos) < near2) continue;
            const dsq = _probe.distanceToSquared(t);
            if (dsq < crownGap2 && dsq > 1e-4) _rep.add(_d.subVectors(_probe, t).multiplyScalar(crownGap2 / dsq));
        }
        if (_rep.lengthSq() < 1e-8) return dir;
        return dir.clone().addScaledVector(_rep.normalize(), strength).normalize();
    }

    function grow(origin, dir, radius, length, depth, level, windBase, flareBase, baseIsFork = false, isGroundBase = false) {
        const flexGain = [0.3, 0.4, 0.5, 0.55][Math.min(level, 3)];
        const r1 = Math.max(p.minRadius, radius * 0.96); // arms barely taper along a segment
        const seg = growSegment(origin, dir, length, radius, r1, p, rng, level === 0 ? (p.trunkSegRes ?? 9) : undefined);
        // blend toward flareBase over the first 40% (a continuation widens to weld; a fork arm can neck IN)
        if (flareBase) {
            for (let i = 0; i < seg.radii.length; i++) {
                const z = i / (seg.radii.length - 1);
                if (z < 0.4) seg.radii[i] = flareBase * (1 - z / 0.4) + seg.radii[i] * (z / 0.4);
            }
        }
        // only the ground-contact segment flares
        if (level === 0 && isGroundBase && (p.trunkFlare ?? 0) > 0) {
            for (let i = 0; i < seg.radii.length; i++) {
                const z = i / (seg.radii.length - 1);
                const flare = z < 0.35 ? 1 + p.trunkFlare * (1 - z / 0.35) : 1;
                const amp = 0.10 + 0.16 * (1 - z);
                const und = 1 + amp * (Math.sin(z * 8.3) * 0.6 + Math.sin(z * 21.7 + 1.9) * 0.4);
                seg.radii[i] *= flare * und;
            }
        }
        const stem = makeStem(seg, level, windBase, flexGain);
        stem.baseIsFork = baseIsFork;
        stems.push(stem);
        for (const pt of seg.points) allPts.push(pt);
        const endPos = seg.points[seg.points.length - 1];
        const endDir = seg.endDir;
        const endRadius = seg.radii[seg.radii.length - 1];
        const windTip = Math.min(1, windBase + flexGain);

        if (depth <= 1) { stem.terminal = true; terminalStems.push(stem); tips.push(endPos.clone()); return stem; }

        const fork = rng.next() < p.branchiness;
        if (fork) {
            const nc = rng.next() < p.forkTriChance ? 3 : 2;
            const planeAz = rng.range(0, Math.PI * 2);
            const axis = perp(endDir);
            const childR = Math.max(p.minRadius, endRadius * p.forkRadiusKeep);
            const childLen = level === 0 ? p.armLength : length * p.armFalloff;
            for (let k = 0; k < nc; k++) {
                const az = planeAz + (k * Math.PI * 2) / nc;
                const spin = new T3.Quaternion().setFromAxisAngle(endDir, az);
                const tiltAxis = axis.clone().applyQuaternion(spin);
                const spread = ((p.forkSpread + rng.vary(0, 6)) * Math.PI) / 180;
                let cdir = endDir.clone().applyAxisAngle(tiltAxis, spread).normalize();
                cdir = repelDir(endPos, cdir, childLen);
                stem.children.push(grow(endPos, cdir, childR, childLen, depth - 1, level + 1, windTip, endRadius * (p.forkBaseScale ?? 1), nc >= 2));
            }
        } else {
            // single continuation: the stem VEERS off (continuationKink), not a smooth curve
            let cdir = endDir.clone();
            cdir.applyAxisAngle(perp(cdir), (rng.vary(0, p.continuationKink ?? 8) * Math.PI) / 180).normalize();
            cdir = repelDir(endPos, tropism(cdir, p.curlUp * 0.4), length);
            stem.children.push(grow(endPos, cdir, endRadius * 0.98, length, depth - 1, level, windTip, endRadius, false));
        }
        return stem;
    }

    const trunkLen = p.firstForkHeight;
    const nTrunks = Math.max(1, p.trunks | 0);
    for (let t = 0; t < nTrunks; t++) {
        const dir = UP.clone();
        if (nTrunks > 1) {
            const az = (Math.PI * 2 * t) / nTrunks;
            dir.applyAxisAngle(X, (p.trunkSplayDeg * Math.PI) / 180).applyAxisAngle(UP, az).normalize();
        }
        grow(new T3.Vector3(0, 0, 0), dir, p.trunkRadius, trunkLen, p.forkGenerations, 0, 0.05, 0, false, true);
    }
    return { stems, terminalStems, params: p };
}

// ── merged tube mesh (SeedThree buildMergedMesh, smooth tubes) ───────────────
// a stem's last ring stitches to each child's first; wind rides aH, keeping inside the 7-vertex-buffer budget

const _rmfAxis = new T3.Vector3();
function ringVertices(center, tangent, refDir, radius, seg, uvY, uScale, out, prevTangent = null) {
    // parallel transport, never a fixed refDir (it collapses on strong bends and shears the UVs)
    const n = new T3.Vector3().copy(refDir);
    if (prevTangent) {
        const dot = Math.max(-1, Math.min(1, prevTangent.dot(tangent)));
        if (dot < 0.999999) {
            _rmfAxis.crossVectors(prevTangent, tangent);
            if (_rmfAxis.lengthSq() > 1e-12) n.applyAxisAngle(_rmfAxis.normalize(), Math.acos(dot));
        }
    }
    n.addScaledVector(tangent, -n.dot(tangent));
    if (n.lengthSq() < 1e-8) n.copy(perp(tangent));
    n.normalize();
    const b = new T3.Vector3().crossVectors(n, tangent).normalize();
    for (let j = 0; j <= seg; j++) {
        const a = (j / seg) * Math.PI * 2;
        const dir = new T3.Vector3().copy(n).multiplyScalar(Math.cos(a)).addScaledVector(b, Math.sin(a));
        out.pos.push(center.x + dir.x * radius, center.y + dir.y * radius, center.z + dir.z * radius);
        out.nrm.push(dir.x, dir.y, dir.z);
        // bark grain must run along the branch (across it, shadow gaps wrap into rings); out.grainU names the grain axis
        if (out.grainU) out.uv.push(uvY, (j / seg) * uScale);
        else out.uv.push((j / seg) * uScale, uvY);
        out.wind.push(0);
    }
    return n;
}

export function buildWoodMesh(stems, params) {
    const p = { ...DEFAULTS, ...params };
    p.radialSegs = Math.max(3, Math.round(Number.isFinite(p.radialSegs) ? p.radialSegs : 3));
    const seg = p.radialSegs;
    const ringLen = seg + 1;
    const out = { pos: [], nrm: [], uv: [], wind: [], idx: [], grainU: p.barkGrainU !== false };
    const P = out.pos;
    const dsq = (i, k) => { const a3 = i * 3, b3 = k * 3; const dx = P[a3] - P[b3], dy = P[a3 + 1] - P[b3 + 1], dz = P[a3 + 2] - P[b3 + 2]; return dx * dx + dy * dy + dz * dz; };
    const stitch = (a, b) => {
        for (let j = 0; j < seg; j++) {
            const a0 = a + j, a1 = a + j + 1, b0 = b + j, b1 = b + j + 1;
            // the SHORTER diagonal: twisted fork quads crease into a bowtie otherwise
            if (dsq(a1, b0) <= dsq(a0, b1)) out.idx.push(a0, b0, a1, a1, b0, b1);
            else out.idx.push(a0, b0, b1, a0, b1, a1);
        }
    };

    function emitStem(stem, refDir0, vY0, tan0 = null) {
        const { tangents } = framesFor(stem.points);
        // a CONTINUATION child's first ring uses the parent's END tangent: bit-identical rings, no shading crease
        if (tan0) tangents[0] = tan0.clone();
        let ref = refDir0.clone();
        let vY = vY0;
        const rings = [];
        // U wrap from a radius ABOVE the flare; square texels, so bark furrows keep constant aspect
        const refIdx = Math.min(stem.radii.length - 1, Math.floor(stem.radii.length * 0.5));
        const circRef = 2 * Math.PI * stem.radii[refIdx];
        const wraps = circRef / p.tileWorldSize;
        const uScale = wraps >= 0.75 ? Math.max(1, Math.round(wraps)) : wraps; // integer on stems, fractional on thin twigs
        const tileV = Math.max(0.02, circRef / Math.max(uScale, 1e-4));
        for (let i = 0; i < stem.points.length; i++) {
            const base = out.pos.length / 3;
            if (i > 0) vY += stem.points[i].distanceTo(stem.points[i - 1]) / tileV;
            ref = ringVertices(stem.points[i], tangents[i], ref, stem.radii[i], seg, vY, uScale, out, i > 0 ? tangents[i - 1] : null);
            for (let j = 0; j < ringLen; j++) out.wind[out.wind.length - ringLen + j] = stem.winds[i];
            rings.push(base);
            if (i > 0) stitch(rings[i - 1], base);
        }
        const lastBase = rings[rings.length - 1];
        const lastTan = tangents[tangents.length - 1];
        for (const child of stem.children) {
            const isContinuation = child.level === stem.level;
            const childFirst = emitStem(child, ref, vY, isContinuation ? lastTan : null);
            stitch(lastBase, childFirst.first);
        }
        // cone cap: one degenerate apex ring (each vertex keeps its own U) — twig tips end inside the card assembly
        if (stem.children.length === 0) {
            const capR = stem.radii[stem.radii.length - 1];
            const capC = stem.points[stem.points.length - 1];
            const capWind = stem.winds[stem.winds.length - 1];
            const aC = capC.clone().addScaledVector(lastTan, capR * 1.2);
            const apexBase = out.pos.length / 3;
            const apexVY = vY + (capR * 1.2) / tileV;
            for (let j = 0; j <= seg; j++) {
                out.pos.push(aC.x, aC.y, aC.z);
                out.nrm.push(lastTan.x, lastTan.y, lastTan.z);
                if (out.grainU) out.uv.push(apexVY, (j / seg) * uScale);
                else out.uv.push((j / seg) * uScale, apexVY);
                out.wind.push(capWind);
            }
            stitch(lastBase, apexBase);
        }
        return { first: rings[0], last: lastBase };
    }

    const childSet = new Set();
    for (const s of stems) for (const c of s.children) childSet.add(c);
    for (const s of stems) {
        if (childSet.has(s)) continue;
        const t0 = new T3.Vector3().subVectors(s.points[1], s.points[0]).normalize();
        emitStem(s, perp(t0), 0);
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.BufferAttribute(new Float32Array(out.pos), 3));
    g.setAttribute('normal', new T3.BufferAttribute(new Float32Array(out.nrm), 3));
    g.setAttribute('uv', new T3.BufferAttribute(new Float32Array(out.uv), 2));
    // wind weight → aH; ×0.3 keeps wood stiffer than foliage; card bases pick it up at their anchors
    const aH = new Float32Array(out.wind.length);
    for (let i = 0; i < out.wind.length; i++) aH[i] = out.wind[i] * 0.3;
    g.setAttribute('aH', new T3.BufferAttribute(aH, 1));
    g.setIndex(out.idx);
    g.computeVertexNormals();
    // weld SHADING normals across coincident positions (fork joints, U-wrap seam)
    {
        const pos = g.attributes.position.array, nrm = g.attributes.normal.array;
        const buckets = new Map();
        const Q = 1e4;
        for (let v = 0; v < pos.length / 3; v++) {
            const k = `${Math.round(pos[v * 3] * Q)},${Math.round(pos[v * 3 + 1] * Q)},${Math.round(pos[v * 3 + 2] * Q)}`;
            let b = buckets.get(k); if (!b) buckets.set(k, b = []); b.push(v);
        }
        for (const b of buckets.values()) {
            if (b.length < 2) continue;
            let nx = 0, ny = 0, nz = 0;
            for (const v of b) { nx += nrm[v * 3]; ny += nrm[v * 3 + 1]; nz += nrm[v * 3 + 2]; }
            const l = Math.hypot(nx, ny, nz) || 1; nx /= l; ny /= l; nz /= l;
            for (const v of b) { nrm[v * 3] = nx; nrm[v * 3 + 1] = ny; nrm[v * 3 + 2] = nz; }
        }
        g.attributes.normal.needsUpdate = true;
    }
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

// ── spray cards on terminal stems (leaf-cards buildFoliage 'clusters') ───────
const CARD_DEFAULTS = {
    sizeVar: 0.3,
    taper: 0.25,           // tip sprays only slightly smaller
    startFrac: 0.35,       // sprays cover the leafy zone, not the bare branch base
    downAngle: 52,         // card pitch off the branch (deg), forward of the tangent
    downAngleV: 18,
    droop: 22,             // gravity sag toward the ground (deg)
    droopV: 12,
    clustersPerBranch: 3,
    clusterSize: 1.3,      // spray card span (m)
    clusterSizeVar: 0.3,
    clusterQuads: 2,       // crossed base-anchored planes per spray
};

// base-anchored quad pair with the art alignment (shrub_anchors.json) BAKED IN; returns flat arrays
function cardTemplate(quads, anchor) {
    const base = [[-0.5, 0], [0.5, 0], [0.5, 1], [-0.5, 1]];
    const uvB = [[0, 0], [1, 0], [1, 1], [0, 1]];
    const roll = anchor ? (anchor.rollDeg * Math.PI) / 180 : 0;
    const du = anchor ? -(anchor.u - 0.5) : 0;
    const cr = Math.cos(roll), sr = Math.sin(roll);
    const pos = [], nrm = [], uv = [], idx = [];
    let b = 0;
    for (let q = 0; q < quads; q++) {
        const a = (q * Math.PI) / quads;
        const ca = Math.cos(a), sa = Math.sin(a);
        for (let i = 0; i < 4; i++) {
            let [x, y] = base[i];
            x += du;                                 // art u-centring
            const xr = x * cr - y * sr, yr = x * sr + y * cr;   // art roll (Z)
            pos.push(xr * ca, yr, xr * sa);          // spin about the length axis
            nrm.push(-sa, 0, ca);
            uv.push(uvB[i][0], uvB[i][1]);
        }
        idx.push(b, b + 1, b + 2, b, b + 2, b + 3);
        b += 4;
    }
    return { pos, nrm, uv, idx };
}

export function bakeSprayCards(terminalStems, parentStems, cfgIn, rng, anchor) {
    const cIn = { ...CARD_DEFAULTS, ...cfgIn };
    // the single-leaf placement grammar, with fewer, bigger cards
    const c = {
        ...cIn,
        perBranch: cIn.clustersPerBranch,
        size: cIn.clusterSize,
        sizeVar: cIn.clusterSizeVar,
        quads: cIn.clusterQuads,
        startFrac: cfgIn.startFrac ?? 0.35,
    };
    if (!terminalStems.length || c.perBranch <= 0) return null;

    const tpl = cardTemplate(c.quads, anchor);
    const vmin = anchor?.vmin ?? 0.05;
    const pos = [], nrm = [], uv = [], aH = [], idx = [];
    let vb = 0;

    const q = new T3.Quaternion(), qFrame = new T3.Quaternion(),
        q1 = new T3.Quaternion(), q2 = new T3.Quaternion(), qb = new T3.Quaternion();
    const pA = new T3.Vector3(), n = new T3.Vector3(), droopAxis = new T3.Vector3(),
        vtx = new T3.Vector3(), nv = new T3.Vector3(), cardY = new T3.Vector3();
    let minY = Infinity, maxY = -Infinity;

    // sub-terminal parents take a fraction of the density, so shrubs are leafy through the middle, not pom-poms
    const jobs = [{ list: terminalStems, per: c.perBranch, sizeMul: 1 }];
    const parentPer = Math.round(c.perBranch * (cIn.parentSprays ?? 0));
    if (parentStems?.length && parentPer > 0) {
        jobs.push({ list: parentStems, per: parentPer, sizeMul: 0.85 });
    }
    for (const job of jobs)
    for (const stem of job.list) {
        const pts = stem.points, oris = stem.orients;
        const segN = pts.length - 1;
        let phyllo = rng.range(0, Math.PI * 2);
        for (let i = 0; i < job.per; i++) {
            const frac = c.startFrac + (1 - c.startFrac) * ((i + rng.next()) / job.per);
            const fseg = Math.min(segN - 1, Math.floor(frac * segN));
            const ft = frac * segN - fseg;
            pA.copy(pts[fseg]).lerp(pts[fseg + 1], ft);
            qFrame.copy(oris[fseg]).slerp(oris[fseg + 1], ft); // branch frame: local +Y = tangent
            const wAnchor = stem.winds
                ? stem.winds[fseg] * (1 - ft) + stem.winds[fseg + 1] * ft
                : 0.9;

            // qCard = frame · phyllo(about tangent Y) · downAngle(about X)
            phyllo += GOLDEN + rng.vary(0, 0.3);
            q2.setFromAxisAngle(Y, phyllo);
            const down = ((c.downAngle + rng.vary(0, c.downAngleV)) * Math.PI) / 180;
            q1.setFromAxisAngle(X, down);
            q.copy(qFrame).multiply(q2).multiply(q1);

            if (c.droop > 0) {
                n.set(0, 1, 0).applyQuaternion(q);
                droopAxis.crossVectors(n, DOWN);
                if (droopAxis.lengthSq() > 1e-6) {
                    droopAxis.normalize();
                    qb.setFromAxisAngle(droopAxis, ((c.droop + rng.vary(0, c.droopV)) * Math.PI) / 180);
                    q.premultiply(qb);
                }
            }

            const s = c.size * job.sizeMul * (1 - c.taper * frac) * (1 + rng.vary(0, c.sizeVar));
            // sink the transparent margin (plus a hair) into the wood, so art never hovers off the branch
            cardY.set(0, 1, 0).applyQuaternion(q);
            const org = pA.clone().addScaledVector(cardY, -(vmin * s + 0.015));

            const s0 = vb;
            for (let v = 0; v < tpl.pos.length / 3; v++) {
                vtx.set(tpl.pos[v * 3] * s, tpl.pos[v * 3 + 1] * s, tpl.pos[v * 3 + 2] * s)
                    .applyQuaternion(q).add(org);
                nv.set(tpl.nrm[v * 3], tpl.nrm[v * 3 + 1], tpl.nrm[v * 3 + 2]).applyQuaternion(q);
                pos.push(vtx.x, vtx.y, vtx.z);
                nrm.push(nv.x, nv.y, nv.z);
                uv.push(tpl.uv[v * 2], tpl.uv[v * 2 + 1]);
                // base = the wood's aH at the anchor; tip flutters more
                const tLocal = Math.max(0, Math.min(1, tpl.pos[v * 3 + 1]));
                aH.push(wAnchor * 0.3 + tLocal * 0.45);
                minY = Math.min(minY, vtx.y); maxY = Math.max(maxY, vtx.y);
                vb++;
            }
            for (const ix of tpl.idx) idx.push(s0 + ix);
        }
    }
    if (!pos.length) return null;

    // card normals point out from the canopy centre, so the crown shades as one volume (no crosshatch)
    const cy = minY + (maxY - minY) * 0.45;
    const bent = new T3.Vector3();
    for (let v = 0; v < pos.length / 3; v++) {
        bent.set(pos[v * 3], pos[v * 3 + 1] - cy, pos[v * 3 + 2]).normalize();
        nrm[v * 3] = bent.x; nrm[v * 3 + 1] = bent.y; nrm[v * 3 + 2] = bent.z;
    }

    const g = new T3.BufferGeometry();
    g.setAttribute('position', new T3.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new T3.Float32BufferAttribute(nrm, 3));
    g.setAttribute('uv', new T3.Float32BufferAttribute(uv, 2));
    g.setAttribute('aH', new T3.Float32BufferAttribute(aH, 1));
    g.setIndex(idx);
    g.computeBoundingSphere();
    g.computeBoundingBox();
    return g;
}

// ── species presets ──────────────────────────────────────────────────────────
export const SHRUB_GEN = {
    // each card is a whole painted branch assembly, so the skeleton grows one generation less
    creosote: {
        // open wiry vase: multi-stem root crown, low V-forks, no leader
        params: {
            trunks: 5, trunkSplayDeg: 38, firstForkHeight: 0.12,
            armLength: 0.55, armFalloff: 0.85, forkGenerations: 4,
            branchiness: 0.78, forkSpread: 30, forkTriChance: 0.1,
            curlUp: 0.15, armBend: 12, gnarliness: 14, continuationKink: 10,
            forkRadiusKeep: 0.78, trunkRadius: 0.022, trunkFlare: 1.2,
            branchRepel: 0.6, minRadius: 0.004, radialSegs: 4,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.5,
            barkGrainU: true,   // twig-pile tile: grain along image X
        },
        foliage: {
            // foliage SLEEVES the outer third of each wand, with sky gaps between branch systems
            clustersPerBranch: 8, clusterSize: 0.58, clusterSizeVar: 0.35,
            clusterQuads: 2, downAngle: 24, downAngleV: 12, droop: 14,
            startFrac: 0.22, parentSprays: 0.5,
        },
    },
    blackbrush: {
        // dense gnarled low dome: many short stems, twiggy thicket habit
        params: {
            trunks: 6, trunkSplayDeg: 42, firstForkHeight: 0.08,
            armLength: 0.32, armFalloff: 0.82, forkGenerations: 4,
            branchiness: 0.85, forkSpread: 34, forkTriChance: 0.12,
            curlUp: 0.1, armBend: 14, gnarliness: 22, continuationKink: 14,
            forkRadiusKeep: 0.76, trunkRadius: 0.015, trunkFlare: 1.15,
            branchRepel: 0.5, minRadius: 0.0035, radialSegs: 4,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.4,
            barkGrainU: false,  // fissure tile: grain along image Y
        },
        foliage: {
            clustersPerBranch: 3, clusterSize: 0.5, clusterSizeVar: 0.3,
            clusterQuads: 2, downAngle: 32, downAngleV: 14, droop: 16,
            startFrac: 0.2, parentSprays: 0.6,    // twiggy cover to the crown
        },
    },
    sagebrush: {
        // upswept silver vase: few stout fibrous stems, foliage starting low
        params: {
            trunks: 3, trunkSplayDeg: 26, firstForkHeight: 0.15,
            armLength: 0.36, armFalloff: 0.86, forkGenerations: 4,
            branchiness: 0.8, forkSpread: 24, forkTriChance: 0.08,
            curlUp: 0.28, armBend: 10, gnarliness: 10, continuationKink: 8,
            forkRadiusKeep: 0.78, trunkRadius: 0.02, trunkFlare: 1.15,
            branchRepel: 0.55, minRadius: 0.004, radialSegs: 5,
            segCurveRes: 2, trunkSegRes: 3, tileWorldSize: 0.45,
            barkGrainU: false,  // borrows blackbrush's fissure tile
        },
        foliage: {
            clustersPerBranch: 3, clusterSize: 0.48, clusterSizeVar: 0.3,
            clusterQuads: 2, downAngle: 30, downAngleV: 12, droop: 10,
            startFrac: 0.15, parentSprays: 0.6,   // leafy through the middle
        },
    },
};

// one plant → { leaf, stem } merged geometries
export function buildShrubGeometry(name, seed, anchor) {
    const preset = SHRUB_GEN[name];
    if (!preset) throw new Error(`[shrub_gen] unknown shrub '${name}' — have: ${Object.keys(SHRUB_GEN).join(', ')}`);
    const rng = new Rng(`${name}:${seed}`);
    const params = {
        ...preset.params,
        // crown-ball radius for crown-vs-crown repel
        tipClearance: (preset.foliage.clusterSize ?? 0.5) * 0.9,
    };
    const { stems, terminalStems } = generateShrubSkeleton(params, rng);
    const stem = buildWoodMesh(stems, params);
    // sub-terminal parents (feed the mid-canopy when foliage.parentSprays > 0)
    const parents = stems.filter((s) => !s.terminal && s.children.some((ch) => ch.terminal));
    const leaf = bakeSprayCards(terminalStems, parents, preset.foliage, rng, anchor);
    return { leaf, stem, stats: { stems: stems.length, terminals: terminalStems.length,
        woodVerts: stem.attributes.position.count, leafVerts: leaf ? leaf.attributes.position.count : 0 } };
}
