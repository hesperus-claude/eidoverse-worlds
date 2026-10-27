// Headless ragdoll: the browser's solver on a stand-in skeleton parsed from the VRM (shared/rig.js), so a pushed agent
// tumbles on its own side. Client libs load through a Bun plugin, hence lazy async exports; sim unavailable = the slump.
// Runs in world coords against setHeightField and registered supports; terrain is module state (re-asserted before each
// begin()), colliders are scoped per world (inWorld) — see docs/research/ragdoll-sync.md.

import { plugin } from "bun";
import { fileURLToPath } from "node:url";
import { poseChannels } from "../shared/humanoid.js";
import { clampBodyScale } from "../shared/presencewire.js";
import { isFiniteVec3 } from "./shape.ts";
// pure shared geometry, no client import cone: safe to load eagerly
import { CONTACT_POINTS, contactSeed } from "../shared/contact.js";
// forces, not a scripted path
import { leafForceFor, DEFAULT_LEAF_FORCE } from "../shared/leafforce.js";
import { bodyFrame, fromBody } from "../shared/joints.js";
// the browser controller's own numbers; a pure module
import { colliderFor } from "../client/lib/bodyscale.js";
import { NAV_NUDGE, type NavProbe } from "./navgrid.ts";

const HEADLESS_CORE = fileURLToPath(new URL("./headless-core.mjs", import.meta.url));

let simMods: {
  Ragdoll: any;
  Body: any;                 // AmmoRagdoll or Ragdoll
  engine: string;
  rig: { glbJson: any; humanBones: any; worldPositions: any; worldRotations: any; makeAvatar: any };
  THREE: any;
  terrain: any;
  colliders: any;
  reachbone: { measureChain: any; solveChain: any };
} | null = null;
let simFailed = false;
// shared: a join's burst of spawns reaches loadSim() many times before it resolves
let simLoading: Promise<typeof simMods> | null = null;

function loadSim(): Promise<typeof simMods> {
  if (simMods) return Promise.resolve(simMods);
  if (simFailed) return Promise.resolve(null);
  simLoading ??= (async () => {
    try {
      plugin({
        name: "headless-body-core",
        setup(build) {
          build.onResolve({ filter: /^\.\/core\.js$/ }, () => ({ path: HEADLESS_CORE }));
        },
      });
      const core = await import("./headless-core.mjs");
      const rag = await import("../client/lib/ragdoll.js");
      const rig = await import("./rig.ts");
      const terrain = await import("../client/lib/terrain.js");
      const colliders = await import("../client/lib/colliders.js");
      // the reach solver's frame algebra; its import cone is core.js + pure shared modules (tools/reachlive-test.ts
      // proves it runs headless)
      const reachbone = await import("../client/lib/reachbone.js");
      // Bullet, as the browser runs (client/lib/bodysim.js): a different solver swaps models mid-fall on every drag release
      let Body: any = rag.Ragdoll;
      let engine = "verlet";
      const want = process.env.AGENT_BODY_ENGINE ?? "ammo";
      if (want === "ammo") {
        try {
          const ammo = await import("../client/lib/ammodoll.js");
          if (await ammo.ensureAmmo()) { Body = ammo.AmmoRagdoll; engine = "ammo"; }
          else console.warn("[physics] ammo wasm did not open — falling back to verlet");
        } catch (e) {
          console.warn("[physics] ammodoll unavailable — falling back to verlet:", e);
        }
      }
      // say which engine answered: a silent fallback is indistinguishable from a toggle that does not work
      console.log(`[physics] headless body engine: ${engine}`);
      simMods = { Ragdoll: rag.Ragdoll, Body, engine, rig, THREE: core.THREE, terrain, colliders, reachbone };
      return simMods;
    } catch (e) {
      simFailed = true;
      console.error("[physics] headless ragdoll unavailable — agents will slump instead:", e);
      return null;
    }
  })();
  return simLoading;
}

/** The same heightAt the walking clamp uses. Null restores the bare stage (flat zero). Soft no-op when the sim is
 *  unavailable: a slumping agent has no clamp to feed. */
export async function setHeightField(fn: ((x: number, z: number) => number) | null) {
  const m = await loadSim();
  if (!m) return;
  m.terrain.setTerrain(fn ? { mesh: null, heightAt: fn } : null);
}

/** So a body that falls in floats (client/lib/ammodoll.js, via terrain.js's seam): {level, sample(x, z), time()},
 *  the agent's own water analysis and wave clock, or null. */
export async function setWaterField(f: { level: number; sample: (x: number, z: number) => unknown; time: () => number } | null) {
  const m = await loadSim();
  if (!m) return;
  m.terrain.setWaterField(f);
}

// ids are shared per world, so a box lives until its last holder lets go (a Set: a re-registering holder counts once)
const holders = new Map<string, Set<string>>();

/** A stretched thing's per-axis scale (shared/scale3.js); absent is uniform. */
const finite3 = (v: unknown) => v == null || (Array.isArray(v) && v.length === 3 && v.every(Number.isFinite));
/** null when uniform; colliders.js reads one scale, so a stretched support is fitted at scale 1 with the stretch
 *  baked into its box, grid and triangles. */
const stretchOf = (x: { scale3?: number[] }): [number, number, number] | null => {
  if (!Array.isArray(x.scale3)) return null;
  const [a, b, c] = x.scale3.map(Math.abs);
  return a === b && b === c ? null : [a, b, c];
};
/** A stretched support is fitted at scale 1 (its stretch is in its geometry), any other at |scale|, since physics
 *  reads a mirrored axis as its size (a uniform mirror is no stretch, and a negative one-number scale is refused by
 *  the grid fitter and turns a box inside out). */
const fitXform = <T extends { scale?: number; scale3?: number[] }>(x: T, k: number[] | null): T =>
  ({ ...x, scale: k ? 1 : Math.abs(x.scale ?? 1), scale3: undefined });

/** A local-frame box + world transform, so settling bodies rest on it. `holder` is the claiming agent; the box
 *  survives until every holder has removed it. */
export async function registerSupport(
  holder: string, id: string, min: number[], max: number[],
  xform: { position: number[]; yaw?: number; scale?: number; scale3?: number[] },
) {
  // runs detached (`void registerSupport`), so a throw would take the whole door down (#88): non-finite geometry abstains
  if (![min, max, xform?.position].every(isFiniteVec3)
      || !Number.isFinite(xform.yaw ?? 0) || !Number.isFinite(xform.scale ?? 1) || !finite3(xform.scale3)) {
    console.error(`[physics] support ${id} abstained — non-finite geometry/transform`);
    return;
  }
  const m = await loadSim();
  if (!m) return;
  (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(holder);
  // re-fit unconditionally: a place moves the box, and the newest claimant's transform is the freshest reading
  const k = stretchOf(xform);
  if (k) m.colliders.fitSupportBox(id, min.map((v, i) => v * k[i]), max.map((v, i) => v * k[i]), fitXform(xform, k));
  else m.colliders.fitSupportBox(id, min, max, fitXform(xform, null));
  generation++;
  scopeEntry(m, id);
}

/** test/debug probe: a ghost floor is answered by looking, not by re-deriving process state. Copies, not live
 *  references. */
export const supportHolders = (): Record<string, string[]> =>
  Object.fromEntries([...holders].map(([id, hs]) => [id, [...hs]]));

/** Heightfield support from a served topGrid (#84), for floors whose box top lies. False when refused (validTopGrid,
 *  non-finite transform): the caller must then abstain, never fall back to the box top. */
export async function registerSupportGrid(
  holder: string, id: string, topGrid: unknown,
  xform: { position: number[]; yaw?: number; scale?: number; scale3?: number[] },
): Promise<boolean> {
  if (!isFiniteVec3(xform?.position)
      || !Number.isFinite(xform.yaw ?? 0) || !Number.isFinite(xform.scale ?? 1) || !finite3(xform.scale3)) {
    console.error(`[physics] grid support ${id} abstained — non-finite transform`);
    return false;
  }
  const m = await loadSim();
  if (!m) return false;
  const k = stretchOf(xform);
  const grid: any = topGrid;
  // a stretched grid's cells in world sizes, to the millimetre the server rounds them to
  const mm = (v: number) => Math.round(v * 1000) / 1000;
  const fitted = k && grid && typeof grid === "object" && Array.isArray(grid.minXZ) && Array.isArray(grid.sizeXZ) && Array.isArray(grid.cells)
    ? { ...grid, minXZ: [mm(grid.minXZ[0] * k[0]), mm(grid.minXZ[1] * k[2])], sizeXZ: [mm(grid.sizeXZ[0] * k[0]), mm(grid.sizeXZ[1] * k[2])],
        cells: grid.cells.map((c: unknown) => (typeof c === "number" ? mm(c * k[1]) : c)) }
    : topGrid;
  if (!m.colliders.fitSupportGrid(id, fitted, fitXform(xform, k))) return false;
  generation++;
  scopeEntry(m, id);
  (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(holder);
  return true;
}

// one geometry per collision mesh, shared by every entity fitted from it (colliders.js works root-local, so clones
// at any place/yaw/scale read the same arrays)
const meshGeometries = new WeakMap<object, any>();

/** Fitted from its triangles (server/geometry.ts collisionTriangles) as the browser does
 *  (client/lib/realize/models.js), except stretched and mirrored things, fitted as drawn; decide() picks box, pillar
 *  or trimesh. Same holders and lifetime as registerSupport. */
export async function registerMeshSupport(
  holder: string, id: string, mesh: { positions: Float32Array; indices: Uint32Array },
  xform: { position: number[]; yaw?: number; scale?: number; scale3?: number[]; collide?: string; model?: string },
): Promise<boolean> {
  if (!isFiniteVec3(xform?.position)
      || !Number.isFinite(xform.yaw ?? 0) || !Number.isFinite(xform.scale ?? 1) || !finite3(xform.scale3)) {
    console.error(`[physics] mesh support ${id} abstained — non-finite transform`);
    return false;
  }
  const m = await loadSim();
  if (!m) return false;
  const { THREE } = m;
  let geom = meshGeometries.get(mesh);
  if (!geom) {
    geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(mesh.positions, 3));
    geom.setIndex(new THREE.BufferAttribute(mesh.indices, 1));
    meshGeometries.set(mesh, geom);
  }
  // a stretched thing's triangles carry its stretch, in its own copy: the shared geometry and fit are for one scale
  const k = stretchOf(xform);
  if (k) geom = geom.clone().scale(k[0], k[1], k[2]);
  const s = fitXform(xform, k).scale!;
  const root = new THREE.Group();
  root.add(new THREE.Mesh(geom));
  root.position.set(xform.position[0], xform.position[1], xform.position[2]);
  root.rotation.y = xform.yaw ?? 0;
  root.scale.setScalar(s);
  root.updateMatrixWorld(true);
  // never throws (#88): a model the fit chokes on (degenerate triangles, a BVH build failure) abstains; the caller falls
  // back to its summary
  try {
    const lib = k ? null : xform.model ?? null;   // colliders.js shares a fit between spawns of one model by this name
    m.colliders.fitCollider(id, root, { collide: xform.collide, scale: s, lib, localFrame: true });
    scopeEntry(m, id);
  } catch (err) {
    console.error(`[physics] mesh support ${id} abstained — fit failed:`, String(err).split("\n")[0]);
    return false;
  }
  generation++;
  (holders.get(id) ?? holders.set(id, new Set()).get(id)!).add(holder);
  return true;
}

const WALKING = colliderFor(1);
/** The authority's square body box, corners included, plus navgrid's nudge (navProbe). */
const PLAN_R = WALKING.r * Math.SQRT2 + NAV_NUDGE;

/** Bumped whenever the collider map changes (a fit, a refit, a removal): a route plan is good until it moves. */
let generation = 0;
export const collidersGeneration = () => generation;
/** Support ids are `<world>/<entity>…` (agent.ts): queries made inside another world (inWorld) don't see them. */
function scopeEntry(m: NonNullable<typeof simMods>, id: string) {
  const e = m.colliders.colliders?.get(id), slash = id.indexOf("/");
  if (e && slash > 0) e.scope = id.slice(0, slash);
}

/** test/debug probe, what a support id was fitted as: the exact triangles, a box (or pillar), a heightfield grid, or a data box. */
export function supportShape(id: string): "exact" | "box" | "pillar" | "grid" | "data-box" | null {
  const e = simMods?.colliders.colliders?.get(id);
  if (!e) return null;
  return e.exact ? "exact" : e.grid ? "grid" : e.support ? "data-box" : e.pillar ? "pillar" : "box";
}

/** A process can hold several worlds' colliders; a body in one must not stand on, or be stopped by, a floor or a
 *  wall in another at the same coordinates. */
export function inWorld<T>(world: string | null | undefined, fn: () => T): T {
  const C = simMods?.colliders;
  if (!C?.setColliderScope || !world) return fn();
  const prev = C.colliderScope();
  C.setColliderScope(world);
  try { return fn(); } finally { C.setColliderScope(prev); }
}

/** Asking starts the load: a body's feet use the terrain clamp until the answer is yes. */
export function collidersReady(): boolean {
  if (!simMods) void loadSim();
  return simMods != null;
}
let standProbe: any = null;

/** By client/lib/controller.js's rule (resolveColliders; also pushes pos.x/z out of solids). Null while the sim isn't
 *  loaded (keep the terrain clamp). Synchronous: called every walk substep. */
export function standOn(pos: { x: number; y: number; z: number }, heightAt: (x: number, z: number) => number): number | null {
  if (!simMods) { void loadSim(); return null; }
  standProbe ??= new simMods.THREE.Vector3();
  standProbe.set(pos.x, pos.y, pos.z);
  const ground = simMods.colliders.resolveColliders(standProbe, heightAt, WALKING.r, WALKING.tall, true);
  pos.x = standProbe.x; pos.z = standProbe.z;
  return ground;
}

/** Run `fn` with the colliders `ids` out of every query (colliders.suspendCollider: out of the grid, the entry kept),
 *  put back after; those already out (a thing in a hand) stay so. A loose thing this body would shove is walked INTO,
 *  not round (agent.ts walkNow). Synchronous, so no other query sees the gap. */
export function withoutColliders<T>(ids: Iterable<string>, fn: () => T): T {
  const C = simMods?.colliders;
  if (!C?.suspendCollider) return fn();
  const out: string[] = [];
  for (const id of ids) if (C.colliders?.has(id) && !C.isSuspended(id)) { C.suspendCollider(id, true); out.push(id); }
  try { return fn(); } finally { for (const id of out) C.suspendCollider(id, false); }
}

/** For mcpl/navgrid.ts: the same surfaceUnder and resolveColliders, with the same walking capsule, that the feet
 *  will be moved by. null while the sim is not loaded. */
export function navProbe(heightAt: (x: number, z: number) => number): NavProbe | null {
  if (!simMods) { void loadSim(); return null; }
  const C = simMods.colliders, v = new simMods.THREE.Vector3();
  return {
    surfaceUnder: (x, z, maxY) => C.surfaceUnder(x, z, heightAt, maxY).y,
    stand: (x, y, z) => {
      v.set(x, y, z);
      // plan wider than the feet: the authority walks a square box (shared/mover.js bodyBox) whose corners reach r·√2,
      // and navgrid takes a push under NAV_NUDGE as standing room; PLAN_R clears that box everywhere
      const ground = C.resolveColliders(v, heightAt, PLAN_R, WALKING.tall, true);
      const push = Math.hypot(v.x - x, v.z - z);
      // ...and the authority's box reaches the full height (bodyBox: a step above the feet to the head) while the feet's
      // wall probe stops at the hips: the same probe raised half a body is the head's band, so a stair under the
      // edge of an upper floor is climbed where the head clears it
      v.set(x, y + WALKING.tall / 2, z);
      C.resolveColliders(v, heightAt, PLAN_R, WALKING.tall, false);
      return { ground, push: Math.max(push, Math.hypot(v.x - x, v.z - z)) };
    },
  };
}

/** A ray against the fitted colliders (colliders.raySegment: the ones the feet use, exact triangles where fitted
 *  exact) and the terrain, sampled every half metre. null while the collision modules are not loaded: the caller
 *  decides by distance alone then, and says so. */
export function lineOfSight(from: number[], to: number[], heightAt: (x: number, z: number) => number): boolean | null {
  if (!simMods) { void loadSim(); return null; }
  const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2], far = Math.hypot(dx, dy, dz);
  if (far < 1e-6) return true;
  const T = simMods.THREE;
  const hit = simMods.colliders.raySegment(new T.Vector3(from[0], from[1], from[2]), new T.Vector3(dx / far, dy / far, dz / far), Math.max(0, far - 0.05));
  if (hit != null) return false;
  const n = Math.ceil(far / 0.5);
  for (let k = 1; k < n; k++) { const t = k / n; if (heightAt(from[0] + dx * t, from[2] + dz * t) > from[1] + dy * t + 0.05) return false; }
  return true;
}

export async function removeSupport(holder: string, id: string) {
  const m = await loadSim();
  if (!m) return;
  const hs = holders.get(id);
  if (!hs) return;
  hs.delete(holder);
  if (hs.size) return;              // someone else is still standing on it
  holders.delete(id);
  m.colliders.removeCollider(id);
  generation++;
}

// skeletons are per-VRM and immutable: parse each avatar file once
const skeletons = new Map<string, Record<string, any> | null>();

async function skeletonFor(httpBase: string, avatarPath: string) {
  const key = avatarPath.split("?")[0];
  if (skeletons.has(key)) return skeletons.get(key);
  const m = await loadSim();
  if (!m) return null;
  try {
    const res = await fetch(`${httpBase}/library/${key}`);
    if (!res.ok) throw new Error(`fetch ${key}: ${res.status}`);
    const buf = new Uint8Array(await res.arrayBuffer());
    const g = m.rig.glbJson(buf);
    const bones = m.rig.humanBones(g);
    if (!bones) throw new Error("no humanoid extension");
    const wp = m.rig.worldPositions(g), wr = m.rig.worldRotations(g);
    const P: Record<string, any> = {}, restAxes: Record<string, number[]> = {};
    for (const [b, n] of Object.entries(bones)) if (g.nodes[n as number]) { P[b] = wp(n); restAxes[b] = wr(n).toArray(); }
    if (!P.hips) throw new Error("no hips bone");
    // hair chains with their real parenting: ammodoll's hair block looks for Hair_<chain>_<idx>, not humanoid bones
    const byName = new Map<string, number>();
    g.nodes.forEach((n: any, i: number) => { if (n.name) byName.set(n.name, i); });
    const parentOf = new Map<number, number>();
    g.nodes.forEach((n: any, i: number) =>
      (n.children ?? []).forEach((c: number) => parentOf.set(c, i)));
    const hairParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^Hair_\d+_\d+$/.test(name)) continue;
      P[name] = wp(i);
      const pi = parentOf.get(i);
      const pn = pi != null ? g.nodes[pi]?.name : null;
      // a lock either continues another lock, or hangs off the head
      hairParent[name] = (pn && /^Hair_\d+_\d+$/.test(pn)) ? pn : "head";
    }

    // wing bones aren't humanoid, so graft [LR]_Wing_* onto the stand-in (most of the doll's drag area); a root wing
    // bone reparents to chest, since the clavicle has no body
    const wingParent: Record<string, string> = {};
    for (const [name, i] of byName) {
      if (!/^[LR]_Wing_(Upper|Lower)(_\d+)?$/.test(name)) continue;
      P[name] = wp(i);
      const pi = parentOf.get(i);
      const pn = pi != null ? g.nodes[pi]?.name : null;
      wingParent[name] = (pn && /^[LR]_Wing_/.test(pn)) ? pn : "chest";
    }

    const extraParent = { ...hairParent, ...wingParent };
    if (Object.keys(extraParent).length) {
      // still named __hairParent (ammodoll and HeadlessBody read it); it means "bones the humanoid table doesn't know"
      Object.defineProperty(P, "__hairParent", { value: extraParent, enumerable: false });
      Object.defineProperty(P, "__wingBones", { value: Object.keys(wingParent), enumerable: false });
    }
    // VRM 0.x bodies face -Z and the reach frame algebra needs to know; a non-enumerable extra, so the ragdoll's P
    // contract is unchanged
    Object.defineProperty(P, "__vrm0", { value: !!g.extensions?.VRM, enumerable: false });
    Object.defineProperty(P, "__restAxes", { value: restAxes, enumerable: false });
    skeletons.set(key, P);
    return P;
  } catch (e) {
    console.error(`[physics] cannot read a skeleton out of ${key} — this body will slump:`, e);
    skeletons.set(key, null);
    return null;
  }
}

/** One headless body's physics: a stand-in skeleton plus whichever Ragdoll runs on it. The caller owns cadence
 *  (call step from its own ticker) and streaming (read pose/root after each step). */
export class HeadlessBody {
  private m: NonNullable<typeof simMods>;
  private av: any;
  private vrm0: boolean;
  rd: any = null;

  private constructor(m: NonNullable<typeof simMods>, P: Record<string, any>) {
    this.m = m;
    this.vrm0 = !!(P as any).__vrm0;
    // realParent carries the non-humanoid chains (hair, wings), which makeAvatar would otherwise drop;
    // vrm0: three-vrm's half-turn as the pivot, so a VRM0 body falls in the browser's frame
    const hp = (P as any).__hairParent;
    this.av = hp ? m.rig.makeAvatar(P, { vrm0: this.vrm0, realParent: { ...(m.rig as any).PARENT, ...hp } })
      : m.rig.makeAvatar(P, { vrm0: this.vrm0 });
  }

  /** Read on every step it floats (ammodoll.js _water): set by its agent, so a body floats on its own world's water
   *  whatever another agent in the process last handed setWaterField. */
  waterSource: (() => { level: number; sample: (x: number, z: number) => unknown; time: () => number } | null) | null = null;

  /** null when physics is unavailable for this process or this VRM. */
  static async create(httpBase: string, avatarPath: string): Promise<HeadlessBody | null> {
    const m = await loadSim();
    if (!m) return null;
    const P = await skeletonFor(httpBase, avatarPath);
    if (!P) return null;
    return new HeadlessBody(m, P);
  }

  /** Reset the stand-in to a sparse bone map (null = standing) on the live ground. Rotations only, as a limp browser
   *  body draws (avatar.js _applyRawPose doesn't run while limp); begin() moves a hips drop to the root. */
  private pose(x: number, z: number, yaw: number, pose: Record<string, unknown> | null) {
    this.av.root.position.set(x, this.m.terrain.heightAt(x, z), z);
    this.av.root.rotation.y = yaw;
    for (const n of Object.values(this.av.nodes) as any[]) n.quaternion.identity();
    if (pose) {
      for (const [j, v] of Object.entries(pose)) {
        // a published name is the sender's; one an object inherits (`constructor`) is no bone
        const n = Object.hasOwn(this.av.nodes, j) ? this.av.nodes[j] : null, q = poseChannels(v)?.q;
        if (n && q) n.quaternion.set(q[0], q[1], q[2], q[3]).normalize();
      }
    }
    this.av.root.updateMatrixWorld(true);
  }

  /** Its ragdoll sees that world's colliders only. */
  scope: string | null = null;
  /** From standing or a given pose, leaning or free. Everything is world y (rootY, pins, seed); a held hips drop lowers
   *  the root before the sim starts. */
  begin(opts: Parameters<HeadlessBody["beginIn"]>[0]) { return inWorld(this.scope, () => this.beginIn(opts)); }
  step(dt: number) { return inWorld(this.scope, () => this.stepIn(dt)); }
  private beginIn(opts: {
    x: number; z: number; yaw: number;
    lean?: number[] | null;
    pose?: Record<string, unknown> | null;
    rootY?: number;                          // world y of the root before any held hips drop (a lifted drop)
    pins?: Array<{ j: string; at: number[] }>;
    sim?: { j: string[]; p: number[]; v: number[] } | null;   // a handover
  }) {
    this.pose(opts.x, opts.z, opts.yaw, opts.pose ?? null);
    if (opts.rootY != null) {
      this.av.root.position.y = opts.rootY;
      this.av.root.updateMatrixWorld(true);
    }
    // a held hip drop (kneeling) moves to the root, as avatar.js bakeHipsIntoRoot does, in the pivot's frame
    const hipsT = poseChannels(opts.pose?.hips)?.t;
    if (hipsT) {
      const drop = new this.m.THREE.Vector3(hipsT[0], hipsT[1], hipsT[2]);
      this.av.root.position.add(drop.applyMatrix3(new this.m.THREE.Matrix3().setFromMatrix4(this.av.pivot.matrixWorld)));
      this.av.root.updateMatrixWorld(true);
    }
    const lean = Array.isArray(opts.lean) && opts.lean.length === 3
      ? new this.m.THREE.Vector3(opts.lean[0], opts.lean[1], opts.lean[2]) : null;
    // the rest snapshot is world positions, so take it with the root where it is now (a mid-air rootY otherwise
    // offsets the pelvis); a handover seed continues the other machine's sim, in world y like this one
    const seed = opts.sim && Array.isArray(opts.sim.j) ? { ...opts.sim } : null;
    // free the previous body first: a Bullet body owns wasm, leaked per drag release (OOM); dispose() is idempotent
    this.rd?.dispose?.();
    this.rd = new this.m.Body(this.av, lean, this.av.restBonePositions(), seed);
    if (this.rd) this.rd.waterSource = this.waterSource;   // its own world's water, read live each step
    for (const p of opts.pins ?? []) this.setPin(p.j, p.at);
    // hipsOffset is a property of the rig: if a handover moves it, others see this body float or sink by the difference
    if (process.env.BODY_DEBUG && this.rd) {
      console.log(`[physics] ${opts.sim ? "handover" : "fresh"} build: `
        + `hipsOffset=${this.rd.hipsOffset?.toFixed(4)} `
        + `rootY=${this.av.root.position.y.toFixed(3)} `
        + `hips=${this.rd.p?.hips?.y?.toFixed(3)}`);
    }
  }

  /** In WORLD coordinates. */
  setPin(joint: string | null, at?: number[] | null, firm = true) {
    if (!this.rd) return;
    if (!joint) { this.rd.setPin(null); return; }
    if (!Array.isArray(at)) { this.rd.setPin(joint, null); return; }
    // pins here are NAILS (begin's opts.pins, the bodydrag relay's pin map): a hand is simulated by its holder, not replicated
    this.rd.setPin(joint, new this.m.THREE.Vector3(at[0], at[1], at[2]), firm);
  }

  /** Leaf forces (shared/leafforce.js): normal drag plus a forward centre of pressure gives emergent flutter; real
   *  forces, not a scripted path, so it still collides. No-op on the Verlet fallback. */
  applyLeaf(cfg: any, t: number) {
    const rd: any = this.rd;
    const bodies = rd?._bodies;
    if (!Array.isArray(bodies) || !bodies.length) return 0;
    const A = this.m.THREE ? null : null;
    let pushed = 0;
    for (const rb of bodies) {
      try {
        if (!rb || typeof rb.getLinearVelocity !== "function") continue;
        if (typeof rb.getMotionState !== "function") continue;
        const v = rb.getLinearVelocity();
        const vel = { x: v.x(), y: v.y(), z: v.z() };
        const sp = Math.hypot(vel.x, vel.y, vel.z);
        if (sp < 0.05) continue;
        const shape = rb.getCollisionShape?.();
        const he = shape?.getHalfExtentsWithMargin?.();
        const half = he ? [he.x(), he.y(), he.z()] : [0.05, 0.12, 0.05];
        const mass = 1 / Math.max(1e-6, rb.getInvMass?.() ?? 1);
        // the plate's world normal: the thinnest local axis, rotated by the body (a box's smallest face IS its plate)
        const thin = half.indexOf(Math.min(...half));
        const basis = rb.getWorldTransform().getBasis();
        const col = (i: number) => {
          const c = basis.getColumn(i);
          return { x: c.x(), y: c.y(), z: c.z() };
        };
        const normal = col(thin);
        const right = col((thin + 1) % 3);
        const { force, torque } = leafForceFor(cfg, { mass, halfExtents: half, vel, normal, right }, t);
        const F = new this.m.THREE.Vector3(force.x, force.y, force.z);
        const T = new this.m.THREE.Vector3(torque.x, torque.y, torque.z);
        rb.applyCentralForce?.(this.btVec(F));
        rb.applyTorque?.(this.btVec(T));
        rb.activate?.();
        pushed++;
      } catch { /* one awkward body must not stop the fall */ }
    }
    return pushed;
  }

  private _bv: any = null;
  private btVec(v: any) {
    const AMMO = (this.m as any).AMMO ?? (globalThis as any).Ammo;
    if (!AMMO) return v;
    this._bv ??= new AMMO.btVector3(0, 0, 0);
    this._bv.setValue(v.x, v.y, v.z);
    return this._bv;
  }

  /** Returns what to stream, or null once the sim has captured. */
  private stepIn(dt: number): { pose: Record<string, number[]>; p: number[]; done: boolean } | null {
    if (!this.rd) return null;
    this.rd.step(dt);
    const pose = this.rd.done ? this.rd.finalPose : this.rd.pose;
    if (!pose) return null;
    const r = this.av.root.position;
    const out = { pose, p: [r.x, r.y, r.z], done: !!this.rd.done };
    if (this.rd.done && process.env.BODY_DEBUG) {
      // where the body came to rest: its lowest joint against groundY, the floor the solver believes in
      let lo = Infinity, who = "";
      for (const [j, v] of Object.entries(this.rd.p ?? {})) {
        const y = (v as any)?.y;
        if (Number.isFinite(y) && y < lo) { lo = y; who = j; }
      }
      console.log(`[physics] SETTLED: groundY=${this.rd.groundY?.toFixed(3)} `
        + `lowestJoint=${lo.toFixed(3)} (${who}) hips=${this.rd.p?.hips?.y?.toFixed(3)} `
        + `rootY=${r.y.toFixed(3)}  [lowest joint should sit just above groundY]`);
    }
    if (this.rd.done) { this.rd.dispose?.(); this.rd = null; }
    return out;
  }

  get active() { return this.rd != null; }
  /** dispose() before the reference goes: under ammo the reference is the only handle on a wasm world. */
  stop() { this.rd?.dispose?.(); this.rd = null; }
}

// ---------------------------------------------------------------- reaching
// ReachBody: the stand-in driven by the reach solver. No mesh, so contact() uses client/lib/landmarks.js's
// fallback rule (proportional off the bone); within a few cm of the browser's

/** Per VRM: a body the reach solver can pose and interrogate. */
export class ReachBody {
  private m: NonNullable<typeof simMods>;
  av: any;
  private chains = new Map<string, any>();
  private restPositions = new Map<string, any>();
  private restAxes: Record<string, number[]>;
  private landmarks = new Map<string, { node: any; offset: any; normal: any }>();
  /** Whether the held pose's raw layer (holdPose) is in the nodes' matrices: on for what is drawn (joints, contacts),
   *  off while the solver runs. */
  private drawn = true;

  private constructor(m: NonNullable<typeof simMods>, P: Record<string, any>, realParent: Record<string, string | null> | null = null) {
    this.m = m;
    // reaches use the collapsed body; readback can keep the full humanoid ancestry. Chain measurement still refuses a
    // lower limb that is not its upper limb's direct child.
    this.av = m.rig.makeAvatar(P, { vrm0: !!(P as any).__vrm0, realParent });
    this.restAxes = (P as any).__restAxes ?? {};
    // the held pose's raw layer goes in the local matrix: its scale is in the bone's rest axes, which Object3D.scale
    // (normalized axes) can't carry; applied after the rotation, as a raw bone's is
    const body = this, at = new m.THREE.Vector3();
    const updateMatrix = function (this: any) {
      const raw = body.drawn ? this.userData : null;
      this.matrix.compose(raw?.heldT ? at.copy(this.position).add(raw.heldT) : this.position, this.quaternion, this.scale);
      if (raw?.heldScale) this.matrix.multiply(raw.heldScale);
      this.matrixWorldNeedsUpdate = true;
    };
    for (const [name, n] of Object.entries(this.av.nodes) as [string, any][]) {
      this.restPositions.set(name, n.position.clone());
      n.updateMatrix = updateMatrix;
    }
    for (const point of Object.keys(CONTACT_POINTS)) {
      const frame = this.estimateContact(point);
      const node = this.av.nodes[(CONTACT_POINTS as any)[point].bone];
      if (!frame || !node) continue;
      const inv = node.matrixWorld.clone().invert();
      this.landmarks.set(point, { node,
        offset: new m.THREE.Vector3(...frame.pos).applyMatrix4(inv),
        normal: new m.THREE.Vector3(...frame.normal).transformDirection(inv) });
    }
  }

  static async create(httpBase: string, avatarPath: string): Promise<ReachBody | null> {
    const m = await loadSim();
    if (!m) return null;
    const P = await skeletonFor(httpBase, avatarPath);
    if (!P) return null;
    return new ReachBody(m, P);
  }

  /** Readback supplies real humanoid ancestry; reach tests can keep the collapsed-chain default. Every call creates
   *  private nodes, even when the parsed rig is cached. */
  static async fromSkeleton(P: Record<string, any>, realParent: Record<string, string | null> | null = null): Promise<ReachBody | null> {
    const m = await loadSim();
    return m ? new ReachBody(m, P, realParent) : null;
  }

  /** Where the streamed presence says. `scale` (wire pose.scale, absent = 1) goes on the pivot, never the root, as
   *  avatar.js _applyBodyScale does, so root-frame points stay in unscaled metres. */
  poseAt(p: number[], yaw: number, pose: Record<string, unknown> | null, scale: unknown = 1, raw = true) {
    const u = clampBodyScale(scale);
    if (this.av.pivot.scale.x !== u) {
      this.av.pivot.scale.setScalar(u);
      // limb lengths are measured in the root's unscaled frame, so a size change re-measures them (a stale arm misjudges reach)
      this.chains.clear();
    }
    this.av.root.position.set(p[0], p[1] ?? 0, p[2]);
    this.av.root.rotation.y = yaw ?? 0;
    for (const [name, n] of Object.entries(this.av.nodes) as [string, any][]) {
      n.quaternion.identity(); n.position.copy(this.restPositions.get(name));
      n.userData.heldT = null; n.userData.heldScale = null;
    }
    if (pose) this.holdPose(pose, { raw });
    this.av.root.updateMatrixWorld(true);
  }

  /** Lay a held pose once, as avatar.js does: the normalized layer (`q`, hips `t`) before IK, the raw layer (`t`, `s`)
   *  after; channels via shared/humanoid.js poseChannels. `raw: false` for limp bodies. Unknown bones, inherited names
   *  and unusable values are skipped (reported as unmappedBones / unreadableBones). */
  holdPose(pose: Record<string, unknown>, { raw = true } = {}) {
    const T = this.m.THREE;
    for (const [j, v] of Object.entries(pose)) {
      const n = Object.hasOwn(this.av.nodes, j) ? this.av.nodes[j] : null, c = poseChannels(v);
      if (!n || !c) continue;
      if (c.q) n.quaternion.set(c.q[0], c.q[1], c.q[2], c.q[3]).normalize();
      if (c.t && j === "hips") n.position.add(new T.Vector3(c.t[0], c.t[1], c.t[2]));
      if (!raw) continue;
      if (c.t && j !== "hips") n.userData.heldT = new T.Vector3(c.t[0], c.t[1], c.t[2]);
      if (c.s) {
        const axes = new T.Matrix4().makeRotationFromQuaternion(new T.Quaternion().fromArray(this.restAxes[j] ?? [0, 0, 0, 1]));
        n.userData.heldScale = axes.clone().multiply(new T.Matrix4().makeScale(c.s[0], c.s[1], c.s[2])).multiply(axes.invert());
      }
    }
  }

  /** As the browser's IK runs before the raw layer (avatar.js update). */
  private solverView<R>(fn: () => R): R {
    if (!this.drawn) return fn();
    this.drawn = false;
    this.av.root.updateMatrixWorld(true);
    try { return fn(); }
    finally { this.drawn = true; this.av.root.updateMatrixWorld(true); }
  }

  private chain(limb: string) {
    if (!this.chains.has(limb)) this.chains.set(limb, this.solverView(() => this.m.reachbone.measureChain(this.av, limb)));
    return this.chains.get(limb);
  }

  /** For "get closer" advice. */
  armLength(limb: string): number | null {
    const ch = this.chain(limb);
    return ch ? ch.L1 + ch.L2 : null;
  }

  /** At the CURRENT pose. Returns the same verdict fields the browser's reachStatus reports. */
  solve(limb: string, target: number[] | { pos: number[]; normal?: number[] }, opts: { palm?: boolean; apply?: boolean; history?: any; dt?: number } = {}) {
    return this.solverView(() => this.solveNormalized(limb, target, opts));
  }

  private solveNormalized(limb: string, target: number[] | { pos: number[]; normal?: number[] }, opts: { palm?: boolean; apply?: boolean; history?: any; dt?: number }) {
    const ch = this.chain(limb);
    if (!ch) return { ok: false as const, why: `this body's rig has no measurable ${limb} chain (an upper bone, a lower bone hanging from it, and its end), so the solver can't move this limb; another limb may have one` };
    const tw = Array.isArray(target) ? target : target.pos;
    const n = !Array.isArray(target) && opts.palm !== false ? target.normal : null;
    const palm = Array.isArray(n) && n.length === 3 ? { dir: [-n[0], -n[1], -n[2]] } : null;
    const out = this.m.reachbone.solveChain(ch, this.av, tw, opts.history?.elbowOffset ?? null,
      { palm, ...opts.history, dt: opts.dt });
    if (!out.ok) return { ok: false as const, why: String(out.why) };
    // opt-in only for a perception query's private scratch nodes; the live reach attester's solve stays mutation-free
    if (opts.apply) {
      ch.nodes.upper.quaternion.fromArray(out.upper);
      ch.nodes.lower.quaternion.fromArray(out.lower);
      if (out.hand) ch.nodes.end.quaternion.fromArray(out.hand);
      this.av.root.updateMatrixWorld(true);
    }
    return {
      ok: true as const,
      gap: Number(out.res.gap ?? NaN),
      bound: (out.res.bound ?? []) as string[],
      penetration: Number(out.penetration ?? 0),
      palmResidual: out.palmResidual == null ? null : Number(out.palmResidual),
      shoulder: ch.nodes.upper.getWorldPosition(new this.m.THREE.Vector3()).toArray() as number[],
      history: { elbowOffset: out.elbowOffset, lastGap: Number(out.res.gap), lastPick: out.pick ?? null,
        lastSwivel: out.swivelUsed ?? null, lastTwist: out.palmTwist ?? null, lastWrist: out.hand ?? null },
    };
  }

  /** At its current pose, by the fallback derivation (landmarks.js), sans mesh: proportionally off the bone along
   *  the body-frame approach direction, normal facing out the same way. */
  contact(point: string, standoff = 0.02): { pos: number[]; normal: number[] } | null {
    const mark = this.landmarks.get(point);
    if (!mark) return null;
    const p = mark.node.localToWorld(mark.offset.clone());
    // normals go through the inverse transpose; a zero scale collapses it, and then the mark faces as if unscaled,
    // as the reach solver sees the bone
    const T = this.m.THREE;
    const facing = () => mark.normal.clone().applyMatrix3(new T.Matrix3().getNormalMatrix(mark.node.matrixWorld));
    const m = new T.Matrix3().setFromMatrix4(mark.node.matrixWorld), e = m.elements;
    const widest = Math.max(Math.hypot(e[0], e[1], e[2]), Math.hypot(e[3], e[4], e[5]), Math.hypot(e[6], e[7], e[8]));
    const collapsed = Math.abs(m.determinant()) <= 1e-9 * widest ** 3;
    const n = (collapsed ? this.solverView(facing) : facing()).normalize();
    return { pos: p.addScaledVector(n, standoff).toArray(), normal: n.toArray() };
  }

  private estimateContact(point: string): { pos: number[]; normal: number[] } | null {
    const spec = (CONTACT_POINTS as any)[point];
    if (!spec) return null;
    const node = this.av.nodes[spec.bone];
    if (!node) return null;
    const P: Record<string, number[]> = {};
    for (const [k, n] of Object.entries(this.av.nodes) as [string, any][]) {
      P[k] = n.getWorldPosition(new this.m.THREE.Vector3()).toArray();
    }
    const F = bodyFrame(P);
    if (!F) return null;
    const d = fromBody(spec.from, F);
    const l = Math.hypot(d[0], d[1], d[2]);
    if (!(l > 1e-9)) return null;
    const dir = [d[0] / l, d[1] / l, d[2] / l];
    const hips = P.hips, head = P.head;
    const scale = hips && head
      ? Math.max(0.2, Math.hypot(head[0] - hips[0], head[1] - hips[1], head[2] - hips[2]))
      : 0.6;
    const seed = contactSeed(P, spec, F, scale);
    if (!seed) return null;
    const at = seed.at;
    const r = Math.min(scale * 0.18, scale * (spec.radius ?? 0.45) * 0.5);
    return {
      pos: [at[0] + dir[0] * r, at[1] + dir[1] * r, at[2] + dir[2] * r],
      normal: dir,
    };
  }
}
