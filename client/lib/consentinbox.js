// consentinbox.js — the asks waiting for ME, and what the authority told me about my body (PROTOCOL L6).
// Asks arrive as {type: "body-inbox"} (shared/protocol/authority.js bodyGate, server/worldlog.ts forwardInbox); answer: consent {answer, yes}.
// An unanswered ask lapses WITHOUT sending: the authority already took silence as no (expireAsks).
// A leaf: nothing from lib comes in, so tools/consent-switch-test.ts can drive it with its own clock.
import { CLASSES, KIND_CLASS, ASK_MS } from '../../shared/protocol/consent.js';

const RING = 50;
export function makeConsentInbox({ now = () => Date.now(), onChange = () => {} } = {}) {
  const pending = new Map();   // ask id → {id, from, kind, cls, summary, why, expires, until}
  const ring = [];
  const changed = (ev) => { try { onChange(ev); } catch { /* a listener's trouble is its own */ } };
  function take(messages) {
    if (!Array.isArray(messages)) return;
    const added = [];
    for (const m of messages) {
      if (!m || typeof m !== 'object') continue;
      if (m.type === 'body-ask') {
        const a = m.ask; if (!a || typeof a.id !== 'string' || typeof a.from !== 'string') continue;
        if (pending.has(a.id)) continue;
        // the authority's class wins (a reach to an intimate point is `intimate` though its kind is touch); kind's class is the fallback
        const cls = CLASSES.includes(a.cls) ? a.cls : KIND_CLASS[a.kind] ?? (typeof a.kind === 'string' ? a.kind : null); if (!cls) continue;
        // `expires` is on the authority's clock; locally ASK_MS from arrival: overshooting is safe (a stale answer gets not-found)
        const k = { id: a.id, from: a.from, kind: a.kind, cls, summary: typeof a.summary === 'string' ? a.summary : `${a.from} asks to ${a.kind}`, why: typeof a.why === 'string' ? a.why : null, expires: a.expires, until: now() + ASK_MS };
        pending.set(a.id, k); added.push(k);
      } else if (m.type === 'body-reply' || m.type === 'body' || m.type === 'body-revoked') {
        ring.push({ ...m, ts: now() }); if (ring.length > RING) ring.shift();
      }
    }
    if (added.length) changed({ added });
  }
  /** Returns the ids that went. */
  function sweep() {
    const t = now(), removed = [];
    for (const [id, k] of pending) if (k.until <= t) { pending.delete(id); removed.push(id); }
    if (removed.length) changed({ removed });
    return removed;
  }
  const asks = () => { sweep(); return [...pending.values()]; };
  const askFrom = (actorId) => asks().find((k) => k.from === actorId) ?? null;
  /** Null when there is no such ask here. */
  async function answer(id, yes, send) {
    const k = pending.get(id); if (!k) return null;
    pending.delete(id); changed({ removed: [id], answered: { ...k, yes: !!yes } });
    return send('consent', { answer: id, yes: !!yes });
  }
  return { take, sweep, asks, askFrom, answer, ring: () => ring.slice() };
}

/** While my switch is `ask` the relay refuses puppets (server/messages.ts bodyRefusal): a yes lands only through this.
 *  drag, occupy and carry are streamed live, not carried here. */
export function bodyActAsPuppet(m) {
  if (!m || m.type !== 'body') return null;
  const spec = m.spec && typeof m.spec === 'object' && !Array.isArray(m.spec) ? m.spec : null;
  const obj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
  if (m.kind === 'pose') {
    if (!spec) return null;
    return obj(spec.pose) ? { pose: spec.pose, merge: spec.merge === true } : { pose: spec, merge: false };
  }
  if (m.kind === 'anim') return spec && obj(spec.tracks) ? { anim: spec } : null;
  if (m.kind === 'shove') {
    const l = spec?.lean;
    return { ragdoll: Array.isArray(l) && l.length === 3 && l.every(Number.isFinite) ? { lean: l.slice() } : true };
  }
  return null;
}
