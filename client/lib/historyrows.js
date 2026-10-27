// Rows for the editor's History and Credits: pure, testable without a browser.
// A refused write is an act whose body carries refused {code} (authority.js logRefusal, R7): an attempt, never a deed.
import { phraseOf } from '../../shared/credits.js';
export function worldHistoryRows(entries, nameOf) {
  return entries.filter((e) => e.kind === 'act').reverse().map((e) => {
    const refused = e.body?.refused?.code ?? null, who = nameOf(e.actor);
    const verb = e.verb === 'imported' && typeof e.body?.verb === 'string' ? e.body.verb : e.verb;   // an imported act, as what it was
    const changed = [e.body?.request?.component].filter(Boolean), target = e.body?.request?.id ?? null;
    const what = `${verb}${target ? ` ${target}` : ''}${changed.length ? ` · ${changed.join(', ')}` : ''}`;
    return { seq: e.seq, by: e.actor, who, verb, changed, target, ts: e.ts ?? null, refused,
      text: refused ? `${who} tried ${what} — refused (${refused}); nothing changed` : `${who} · ${what}` };
  });
}

// Credits are History's filter modes over the same rows.
// top = people ranked by deeds (acts that changed something); kind = grouped by component, or the verb if it names none
export const HISTORY_MODES = [['time', 'by time'], ['person', 'by person'], ['top', 'biggest contributors'], ['kind', 'by what changed']];
const asRows = (list, nameOf) => (list.length && list[0]?.kind !== undefined ? worldHistoryRows(list, nameOf) : list);
export function historyView(list, nameOf, { mode = 'time', who = null } = {}) {
  const rows = asRows(list ?? [], nameOf);
  if (mode === 'person') return { mode, rows: rows.filter((r) => r.by === who) };
  if (mode === 'top' || mode === 'person-list') {
    const people = new Map();
    for (const r of rows) { const p = people.get(r.by) ?? { by: r.by, who: r.who ?? nameOf(r.by), deeds: 0, tried: 0, last: r.ts ?? null, did: [] };
      if (r.refused) p.tried++; else { p.deeds++;   // what they did, in the Credits words (shared/credits.js)
        for (const c of r.changed?.length ? r.changed : [null]) { const what = c === '(created)' ? 'made it' : c === '(deleted)' ? 'took it away' : c ? phraseOf({ verb: 'set', comp: c }) : r.verb;
          if (!p.did.includes(what)) p.did.push(what); } }
      people.set(r.by, p); }
    return { mode, rows, people: [...people.values()].sort((a, b) => b.deeds - a.deeds || String(a.who).localeCompare(String(b.who))) };
  }
  if (mode === 'kind') {
    const groups = new Map();
    for (const r of rows) { const k = r.changed?.length ? r.changed.join(', ') : r.verb; const g = groups.get(k) ?? { kind: k, rows: [] }; g.rows.push(r); groups.set(k, g); }
    return { mode, rows, groups: [...groups.values()].sort((a, b) => b.rows.length - a.rows.length) };
  }
  return { mode: 'time', rows };
}

/** Merge a `history {id, limit, before?}` reply (next = last row's seq or null); client-check HT4-HT6. An Older… read
 *  (`more`) appends and marks `paged`; a refresh of a paged list keeps the read pages where they meet it, else starts over.
 *  Returns {entries, next, paged}. */
export function mergeHistory({ entries, next, paged = false }, rows, rNext, more) {
  const sorted = (xs) => { const m = new Map(); for (const e of xs) m.set(e.seq, e); return [...m.values()].sort((a, b) => b.seq - a.seq); };
  if (more) return { entries: sorted([...entries, ...rows]), next: rNext, paged: true };
  if (!paged) return { entries: sorted(rows), next: rNext, paged: false };
  const oldestNew = rows.length ? Math.min(...rows.map((e) => e.seq)) : Infinity;
  const meets = rNext == null || entries.some((e) => e.seq >= oldestNew);
  if (!meets) return { entries: sorted(rows), next: rNext, paged: false };
  const deeper = entries.some((e) => e.seq < oldestNew);
  return { entries: sorted([...entries, ...rows]), next: deeper ? next : rNext, paged: true };
}
