// shared/protocol/kernelspec.js — the KERNEL's shapes, pinned: what every reader of every log agrees on before a single
// component is read (PROTOCOL §1–§3, §13). componentspec.js pins components; this pins below it:
//   envelope   the entry's fields (§1 "The envelope") and its kinds
//   fold       the four operations and their fields; the batch body (§3)
//   identity   the grammar of an identity, an entity id and a component name (§3.1)
//   version    {dialect, v} and the minors this reader knows (§13; genesis's fields)
//   roles      who may do what (§7): the component's shape only; its vocabulary is the registry's (componentspec roles.vocab)
//   access     who may come in (§7, access.js): the component's shape
// Status `trial-kernel`: it may change in the alpha, but never by a plain re-pin. spec/kernel-pin.json holds the pin;
// tools/protocol/kernel-check.ts is red on any drift, and `--pin` re-pins ONLY with three companions in the same change:
//   (a) a translator change (tools/protocol/import-v1/translate-v1.js TRANSLATOR @N → @N+1, or --translator);
//   (b) a REGISTRY-CHANGELOG.md line (--ack "<why>"), prefixed `kernel:`;
//   (c) vectors (--vectors <dir>, spec/kernel-vectors/<dir>/vectors.json) the OLD reader refuses and the NEW folds clean.
// Pure: this module knows no files; the check does the reading and writing.
import { ENVELOPE, KINDS, IDENT, ENTITY, COMP, OP_FIELDS, BATCH_FIELDS, GENESIS_FIELDS, DIALECT, VERSION, MINORS } from "./fold.js";
import { COMPONENTS, pinOf } from "./componentspec.js";

export const TRIAL_KERNEL = "trial-kernel";
/** What every reader rests on (status trial-kernel; #260): the kernel is what the fold reads. */
export const KERNEL_COMPONENTS = Object.freeze(["roles", "access"]);
/** The kernel's shapes that aren't components: the pin's other keys. */
export const KERNEL_SHAPES = Object.freeze(["envelope", "fold", "identity", "version"]);

/** The kernel's checkable shape, as the pin stores it. Deterministic (sorted where the source is a set). */
export function kernelPinOf() {
  const reg = pinOf();
  // a kernel component's FIELD shape only: ranges, enums, defaults, meanings and vocabulary are the registry's, pinned there
  const comp = (name) => { const p = reg[name]; if (!p) return { missing: true }; return { status: COMPONENTS[name]?.status ?? p.status, fields: p.fields }; };
  return {
    envelope: { status: TRIAL_KERNEL, fields: [...ENVELOPE].sort(), kinds: [...KINDS].sort() },
    fold: { status: TRIAL_KERNEL, ops: Object.fromEntries(Object.entries(OP_FIELDS).map(([k, v]) => [k, [...v]])), batch: [...BATCH_FIELDS] },
    identity: { status: TRIAL_KERNEL, identity: IDENT, entity: ENTITY.source, component: COMP.source },
    version: { status: TRIAL_KERNEL, dialect: DIALECT, v: VERSION, minors: [...MINORS].sort((a, b) => a - b), genesis: [...GENESIS_FIELDS].sort() },
    roles: comp("roles"),
    access: comp("access"),
  };
}

const j = (x) => JSON.stringify(x);
/** Every difference as lines; [] = as pinned. An addition counts too (an old reader refuses an unknown envelope field,
 *  a new kind, a new op field). */
export function kernelDiff(pin, now = kernelPinOf()) {
  const out = [];
  const walk = (a, b, at) => {
    if (j(a) === j(b)) return;
    const bag = (x) => x && typeof x === "object" && !Array.isArray(x);
    if (bag(a) && bag(b)) { for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) walk(a[k], b[k], `${at}.${k}`); return; }
    out.push(`${at}: ${j(a) ?? "absent"} → ${j(b) ?? "absent"}`);
  };
  for (const k of new Set([...Object.keys(pin ?? {}), ...Object.keys(now)])) walk(pin?.[k], now[k], k);
  return out;
}

/** eidoverse/translate-v1@14 → 14, or null. */
export const translatorN = (name) => { const m = /@(\d+)$/.exec(String(name ?? "")); return m ? +m[1] : null; };

/** May `now` be pinned over `pin`? {ok, diff, why?, companions?}. No diff: yes (old companions kept). A diff needs all
 *  three: {ack, translator: {from, to}, vectors: {dir, ran: {old: [...], new: [...]}}}, every vector's `old` verdict a
 *  refusal and its `new` "ok". `date` stamps the changelog line. Recorded companions: {changelog, translator, vectors}. */
export function kernelVerdict(pin, now = kernelPinOf(), companions = null, date = new Date().toISOString().slice(0, 10)) {
  if (!pin) return { ok: true, diff: [], companions: null, initial: true };   // the first pin: nothing to carry
  const diff = kernelDiff(pin.kernel ?? pin, now);
  if (!diff.length) return { ok: true, diff, companions: pin.companions ?? null };
  const c = companions ?? {}; const missing = [];
  const ack = typeof c.ack === "string" ? c.ack.trim() : "";
  if (!ack) missing.push(`a changelog line: --ack "<why>" (written to spec/REGISTRY-CHANGELOG.md as "kernel: <why>")`);
  // a SCOPE TRIM: the whole diff is kernel components (or keys) LEAVING the pin, each HELD (companions.trim.held /
  // heldPaths) or DROPPED with a why (companions.trim.dropped). No stored byte changes meaning, so only the ack is needed.
  const base = pin.kernel ?? pin; const pinnedComps = Object.keys(base).filter((k) => !KERNEL_SHAPES.includes(k));
  const units = diff.map((d) => { const m = /^([a-z][a-z0-9-]*)((?:\.[A-Za-z]+)?): [\s\S]* → absent$/.exec(d);
    return m && pinnedComps.includes(m[1]) ? { n: m[1], path: m[1] + m[2], grammar: m[2] === ".grammar" } : null; });
  const t = c.trim;
  if (t && diff.length && units.every(Boolean)) {
    const lines = [], unaccounted = [];
    for (const u of units) {
      if (u.grammar) { for (const k of Object.keys(base[u.n]?.grammar ?? {})) {
        const why = t.dropped?.[`${u.n}.${k}`];
        if (Array.isArray(t.held?.[u.n]) && t.held[u.n].includes(k)) lines.push(`  - ${u.n}.${k}: leaves the kernel; the registry pin holds it (${u.n}.vocab.${k})`);
        else if (typeof why === "string" && why.trim()) lines.push(`  - ${u.n}.${k}: leaves every pin: ${why.trim()}`);
        else unaccounted.push(`${u.n}.${k}`); } continue; }
      const why = t.dropped?.[u.path];
      if (Array.isArray(t.heldPaths) && t.heldPaths.includes(u.path)) lines.push(`  - ${u.path}: leaves the kernel; the registry pin holds it`);
      else if (typeof why === "string" && why.trim()) lines.push(`  - ${u.path}: leaves every pin: ${why.trim()}`);
      else unaccounted.push(u.path);
    }
    const names = [...new Set(units.map((u) => u.path))];
    if (unaccounted.length) return { ok: false, diff, why: `the kernel is shrinking, but these are neither held by the registry pin (same value) nor dropped with a why (--drop "<path>=<why>"):\n  - ${unaccounted.join("\n  - ")}` };
    if (missing.length) return { ok: false, diff, why: `the kernel's scope shrank (${names.join(", ")} leave): no stored byte changes meaning, so no translator or vectors are asked, but the change still needs:\n  - ${missing.join("\n  - ")}` };
    const trim = { held: t.held ?? {}, ...(t.heldPaths?.length ? { heldPaths: t.heldPaths } : {}), dropped: t.dropped ?? {} };
    return { ok: true, diff, trimOnly: true, changelog: `- ${date}: kernel: ${ack}\n${lines.join("\n")}\n`, companions: { changelog: `${date}: kernel: ${ack}`, trim, translator: null, vectors: null } };
  }
  // a SCOPE EXTENSION: the whole diff is kernel components entering with the shape the registry ALREADY pinned
  // (companions.scope). Only a changelog line is needed; K3 keeps the names in the kernel.
  const entering = diff.map((d) => /^([a-z][a-z0-9-]*): absent → /.exec(d)?.[1] ?? null);
  const scope = Array.isArray(c.scope?.names) ? c.scope.names : null;
  if (scope && diff.length && entering.every((n) => n && KERNEL_COMPONENTS.includes(n) && scope.includes(n)) && scope.every((n) => entering.includes(n)) && c.scope.registryPinned === true) {
    if (missing.length) return { ok: false, diff, why: `the kernel's scope grew (${scope.join(", ")} entered it, ${TRIAL_KERNEL}): no stored byte changes meaning, so no translator or vectors are asked, but the change still needs its changelog line:\n  - ${missing.join("\n  - ")}\nchanged:\n  ${diff.join("\n  ")}` };
    const changelog = `- ${date}: kernel: ${ack}\n${diff.map((d) => `  - ${d.replace(/ → .*$/, " → (the registry's pinned shape, now the kernel's)")}`).join("\n")}\n`;
    return { ok: true, diff, changelog, scopeOnly: true, companions: { changelog: `${date}: kernel: ${ack}`, scope: { names: [...scope].sort() }, translator: pin.companions?.translator ?? null, vectors: pin.companions?.vectors ?? null } };
  }
  const tFrom = translatorN(c.translator?.from), tTo = translatorN(c.translator?.to);
  if (!(tFrom !== null && tTo !== null && tTo > tFrom) && !(typeof c.translator?.step === "string" && c.translator.step))
    missing.push(`a translator change: translate-v1's TRANSLATOR moved @N → @N+1 (is ${c.translator?.to ?? "unknown"}, pinned ${c.translator?.from ?? "unknown"}), or --translator <a new translate step under tools/protocol/>`);
  const v = c.vectors;
  const ran = Array.isArray(v?.ran) ? v.ran : null;
  if (!v?.dir || !ran || !ran.length) missing.push(`vectors: --vectors <dir> (spec/kernel-vectors/<dir>/vectors.json with at least one entry the old reader refuses and the new reader folds)`);
  else { const badOld = ran.filter((r) => r.old === "ok"), badNew = ran.filter((r) => r.new !== "ok");
    if (badOld.length) missing.push(`vectors the OLD reader still accepts (they prove nothing): ${badOld.map((r) => r.name).join(", ")}`);
    if (badNew.length) missing.push(`vectors the NEW reader refuses (${badNew.map((r) => `${r.name}: ${r.new}`).join(", ")})`); }
  if (missing.length) return { ok: false, diff, why: `the kernel changed (${TRIAL_KERNEL}): a re-pin needs the same change to carry its companions, and these are missing:\n  - ${missing.join("\n  - ")}\nchanged:\n  ${diff.join("\n  ")}` };
  const changelog = `- ${date}: kernel: ${ack}\n${diff.map((d) => `  - ${d}`).join("\n")}\n`;
  return { ok: true, diff, changelog, companions: { changelog: `${date}: kernel: ${ack}`, translator: c.translator, vectors: { dir: v.dir, names: ran.map((r) => r.name) } } };
}
