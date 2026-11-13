// tools/protocol/pending.ts — rows that pin a known bug: each asserts the RIGHT behaviour, so it is red until the fix lands.
// A row whose id is on its suite's PENDING list and which shows exactly the documented wrong behaviour prints
// `PENDING <id> …` and doesn't fail the gate. Everything else is strict:
//   - a listed row that is red some OTHER way (not the documented coercion) is a FAIL: a broken probe can't hide here;
//   - a row not on the list that is red is a FAIL;
//   - a listed id whose rows are all green is a FAIL ("take it off PENDING"), and so is a listed id with no row: the list
//     only shrinks, and only when the fix is shown.
// PROTOCOL_STRICT_PENDING=1 prints every pending row as FAIL: the fix's red → green, run on its base and its head.
export function pendingRows(suite: string, PENDING: Record<string, string>) {
  const strict = process.env.PROTOCOL_STRICT_PENDING === "1";
  let pass = 0, fail = 0, held = 0; const heldIds = new Set<string>();
  const ran = new Map<string, { red: number; green: number }>();
  const j = (d: any) => { try { return JSON.stringify(d)?.slice(0, 500); } catch { return String(d); } };
  const failed = (what: string, d?: any) => { fail++; console.log(`  FAIL ${what}${d !== undefined ? ` — ${j(d)}` : ""}`); };
  /** a setup or control check (not a pinned bug): plain pass/fail. */
  const ok = (cond: any, what: string, d?: any) => { if (cond) pass++; else failed(what, d); };
  /** a pinned row: `right` is the behaviour asked for; `wrong` is the coercion the audit documents (seen today). */
  const row = (id: string, what: string, o: { right: boolean; wrong: boolean; saw?: any }) => {
    const r = ran.get(id) ?? { red: 0, green: 0 }; ran.set(id, r);
    if (o.right) { r.green++; pass++; return; }
    r.red++;
    if (!Object.hasOwn(PENDING, id)) return failed(`${id} ${what}`, o.saw);
    if (!o.wrong) return failed(`${id} ${what} (red, but not the documented coercion: check the probe)`, o.saw);
    if (strict) return failed(`${id} ${what} [pending]`, o.saw);
    held++; heldIds.add(id); console.log(`  PENDING ${id} ${what}${o.saw !== undefined ? ` — ${j(o.saw)}` : ""}`);
  };
  const finish = () => {
    for (const id of Object.keys(PENDING)) {
      const r = ran.get(id);
      if (!r) failed(`${id} is on PENDING but no row ran for it`);
      else if (!r.red) failed(`${id} is green now (${r.green} row(s)): take it off PENDING in ${suite}`);
    }
    console.log(`${suite}: ${pass} passed, ${fail} failed, ${held} pending (red today, each the documented coercion: ${[...heldIds].join(" ") || "none"})${strict ? " [PROTOCOL_STRICT_PENDING]" : ""}`);
    process.exit(fail ? 1 : 0);
  };
  return { ok, row, finish };
}
