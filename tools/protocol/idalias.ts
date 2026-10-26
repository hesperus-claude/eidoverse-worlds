// tools/protocol/idalias.ts: a test client's names for what it makes, since a writer never chooses an id. `create {id: "tbl"}`
// goes out as placeholder '$tbl'; the minted id (reply's ids map) replaces "tbl" in later reference positions, so the
// wire carries only placeholders and minted ids. ids.of(name) reads a name's id for the suite's own checks.
// @ts-nocheck
// self-contained (no outer names): pageIds() ships this very function to a browser page as source
export function idAliases() {
  const REF_KEYS = new Set(["id", "to", "on", "beside", "hang", "against", "near", "from", "target", "copy", "facing", "attach"]);
  const REF_LISTS = new Set(["targets", "marks", "ids", "refs"]);
  const map = new Map();
  const sub = (v, key) => {
    if (typeof v === "string") return REF_KEYS.has(key) && map.has(v) ? map.get(v) : v;
    if (Array.isArray(v)) return v.map((x) => (typeof x === "string" && REF_LISTS.has(key) ? (map.get(x) ?? x) : sub(x, key)));
    if (v && typeof v === "object") { const o = {}; for (const [k, x] of Object.entries(v)) o[k] = sub(x, k); return o; }
    return v; };
  const names = new Set();
  const named = (a) => { if (a && typeof a === "object" && typeof a.id === "string" && !a.id.startsWith("$") && /^[a-z0-9][a-z0-9-]*$/.test(a.id) && !/^u-[a-z2-7]{20}$/.test(a.id)) { names.add(a.id); return { ...a, id: `$${a.id}` }; } return a; };
  return {
    /** the request as the wire gets it: a create's chosen id → '$id', every known name → its minted id */
    out(verb, args = {}) {
      // a create's own id names a NEW thing: it becomes a placeholder before names are replaced, so it never resolves to an
      // older thing of the same name
      const mark = (o) => { const n = named(o); return n === o ? sub(o, null) : { ...sub({ ...o, id: undefined }, null), id: n.id }; };
      if (verb === "create") return mark(args);
      if (verb === "batch" && Array.isArray(args?.ops)) return { ...sub({ ...args, ops: undefined }, null), ops: args.ops.map((o) => (o?.verb === "create" ? { ...o, args: mark(o.args) } : sub(o, null))) };
      return sub(args, null); },
    /** keep what the reply minted */
    back(reply) { for (const [k, v] of Object.entries(reply?.ids ?? {})) if (k.startsWith("$")) map.set(k.slice(1), v); return reply; },
    of: (name) => map.get(name) ?? name,
    map,
  };
}

/** The same names inside a browser page: source to evaluate once (idempotent); then every request on any socket sends
 *  minted ids, reply id maps are kept, and globalThis.__id(name) reads a name's id. */
export function pageIds(): string {
  return `(() => { if (globalThis.__eidoIds) return true;
  const IDS = (${idAliases.toString()})(); globalThis.__eidoIds = IDS; globalThis.__id = (n) => IDS.of(n);
  const back = (ev) => { try { const m = JSON.parse(ev.data); if (m && m.type === 'reply') IDS.back(m.reply); } catch {} };
  const wrap = (fn) => (fn && !fn.__ids ? Object.assign(function (ev) { back(ev); return fn.call(this, ev); }, { __ids: true }) : fn);
  const d = Object.getOwnPropertyDescriptor(WebSocket.prototype, 'onmessage');
  Object.defineProperty(WebSocket.prototype, 'onmessage', { configurable: true, enumerable: d.enumerable, get() { return d.get.call(this); }, set(fn) { d.set.call(this, wrap(fn)); } });
  const send = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    const h = d.get.call(this); if (h && !h.__ids) d.set.call(this, wrap(h));
    if (typeof data === 'string') { try { const m = JSON.parse(data); if (m && m.type === 'request') data = JSON.stringify({ ...m, args: IDS.out(m.verb, m.args ?? {}) }); } catch {} }
    return send.call(this, data); };
  return true; })()`;
}

/** A probe's page code: pageIds first, then `expr` with each quoted name in `names` read as its id (from `node`, an
 *  idAliases map, else __id('<name>') in the page); anything else quoted is left alone. */
export function inPage(expr: string, names: string[], node?: Map<string, string>): string {
  const alt = [...names].sort((a, b) => b.length - a.length).map((n) => n.replace(/[-]/g, "\\-")).join("|");
  const body = alt ? expr.replace(new RegExp(`(['"])(${alt})\\1`, "g"), (m, q, n) => (node?.has(n) ? `${q}${node.get(n)}${q}` : `__id(${q}${n}${q})`)) : expr;
  return `(${pageIds()}, (${body}))`;
}

/** evalJson with page-side names: each expression goes through inPage and each answer brings back the page's name → id
 *  map, merged into `node`, so N(name) works right after the page made it. Returns the wrapped evalJson; `.ids` is `node`. */
export function pagedEval(raw: (expr: string) => Promise<any>, names: string[], node: Map<string, string> = new Map()) {
  const f: any = async (expr: string) => {
    const r = await raw(`Promise.resolve(${inPage(expr, names, node)}).then((v) => ({ v, ids: [...globalThis.__eidoIds.map] }))`);
    for (const [k, x] of r?.ids ?? []) node.set(k, x);
    return r?.v; };
  f.ids = node; return f;
}
