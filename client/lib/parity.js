// parity — does what this page DRAWS agree with its own fold (state.js)? EW.foldParity() in any live world.
// Compares the fold's OWN outputs (ids, what each is, parents), deliberately not realization: transforms and loaded
// meshes diverge by design while an object is in flight or in motion.
// compDiffs is retired (C7c: readers hold the fold's own record, world.js bagOf); the key stays, always empty, for the benches.

import { state } from './state.js';
import { entities, childrenOf, ancestorsOf } from './world.js';
import { realizedAs } from './realize/models.js';
import { kindOf } from '../../shared/protocol/kind.js';
import { childrenOf as scanChildren, ancestors as scanAncestors } from '../../shared/hierarchy.js';


export function foldParity() {
  const shadow = state.st;
  const out = { hydrated: state.hydrated, lastSeq: state.lastSeq,
    checked: 0, onlyShadow: [], onlyLegacy: [], compDiffs: [], mountDiffs: [],
    identityDiffs: [], parentDiffs: [], mountPoseDiffs: [], edgeDiffs: [] };

  const legacyIds = new Set(entities.keys());
  const shadowIds = new Set(Object.keys(shadow.entities));
  for (const id of shadowIds) if (!legacyIds.has(id)) out.onlyShadow.push(id);
  for (const id of legacyIds) if (!shadowIds.has(id)) out.onlyLegacy.push(id);

  for (const id of shadowIds) {
    if (!legacyIds.has(id)) continue;
    out.checked++;
    // identity: where same-id-spawn overwrite would drift first (a still-loading reservation is nothing yet: skip)
    const meta = realizedAs(id);
    if (meta) {
      const ent = shadow.entities[id];
      const sceneKind = meta.kind;
      const foldKind = kindOf(ent);
      if (sceneKind !== foldKind || (foldKind === 'model' && meta.model !== ent.model)) {
        out.identityDiffs.push({ id, legacy: { kind: sceneKind, model: meta.model },
          shadow: { kind: foldKind, model: ent.model } });
      }
    }
  }

  // mounts: linkage AND the child's local transform vs the offset (the link can be right while the pose is wrong).
  // Part-socket mounts skip the pose check: attach bakes the part's phase in.
  for (const id of shadowIds) {
    if (!legacyIds.has(id)) continue;
    const rel = shadow.entities[id].parent ?? null;
    const obj = entities.get(id);
    if (!obj) continue;                      // still loading — linkage realizes with it
    const got = obj.userData?.mountedTo ?? null;
    const want = rel?.to ?? null;
    if (want !== got) { out.parentDiffs.push({ id, legacy: got, shadow: want }); continue; }
    if (rel && got) {
      // a socket that rides a part stands in the part's node (at rest), not at its offset from the host
      if (typeof shadow.entities[id]?.socket?.part !== 'string') {
        const off = rel.offset ?? [0, 0, 0];
        const d = Math.hypot(obj.position.x - off[0], obj.position.y - off[1], obj.position.z - off[2]);
        if (d > 0.05) out.mountPoseDiffs.push({ id, expected: off, actual: obj.position.toArray(), d: +d.toFixed(3) });
      }
    }
  }

  // replica.js's edge index (kept op by op) vs viewState (rebuilt whole): a missed ingest path shows as a lone child
  for (const id of shadowIds) {
    const kids = childrenOf(id), want = scanChildren(shadow.entities, id);
    if (kids.join('\n') !== want.join('\n')) out.edgeDiffs.push({ id, index: kids, view: want });
    const up = ancestorsOf(id), wantUp = scanAncestors(shadow.entities, id);
    if (up.join('\n') !== wantUp.join('\n')) out.edgeDiffs.push({ id, indexUp: up, viewUp: wantUp });
  }

  // bodies on seats are presence (world.js avatarMounts), never the fold: nothing to compare

  out.ok = !out.onlyShadow.length && !out.onlyLegacy.length
    && !out.compDiffs.length && !out.mountDiffs.length && !out.identityDiffs.length
    && !out.parentDiffs.length && !out.mountPoseDiffs.length && !out.edgeDiffs.length;
  console.log(`[parity] ${out.ok ? '✓ fold and scene agree' : '✗ DRIFT'} — ` +
    `${out.checked} entities checked, +${out.onlyShadow.length} shadow-only, ` +
    `+${out.onlyLegacy.length} legacy-only, ${out.compDiffs.length} comp diffs, ` +
    `${out.mountDiffs.length} mount diffs, ${out.identityDiffs.length} identity diffs, ` +
    `${out.parentDiffs.length} parent diffs, ${out.mountPoseDiffs.length} mount-pose diffs, ${out.edgeDiffs.length} edge diffs ` +
    `(seq ${out.lastSeq})`);
  return out;
}
