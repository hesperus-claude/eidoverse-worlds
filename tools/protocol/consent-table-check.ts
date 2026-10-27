// consent-table-check: decide() and setConsent() over every class in CLASSES; one order (a personal never > my switch >
// the world's body-default > accept), and nothing from the wire reaches a prototype. Rows: PROTOCOL L6, consent.js.
import * as C from "../../shared/protocol/consent.js";
import { suite } from "./suite.ts";
const { ok, done } = suite("consent-table-check", { cap: Infinity });
const ME = "u-aaaaaaaaaaaaaaaaaaaa", PAL = "u-bbbbbbbbbbbbbbbbbbbb", now = 1e12;
const MODE: Record<string, string> = { accept: "allow", ask: "ask", refuse: "deny" };
const PROTO = ["__proto__", "constructor", "prototype"];
const fresh = (): any => ({ consent: Object.create(null) });
const set = (p: any, a: any, actor = ME) => C.setConsent(p, actor, a, now);
const d = (p: any, cls: string, wd?: string) => C.decide(p, PAL, ME, cls, now, wd).mode;
ok(C.CLASSES.length === 8 && C.SWITCHES.join() === "accept,ask,refuse", "T0 the table runs over the module's 8 classes and 3 switches", { CLASSES: C.CLASSES, SWITCHES: C.SWITCHES });

// the order, every class × every state: nothing set, a world default, my switch over every world default, a never over my switch
const WORLD = [undefined, ...C.SWITCHES, "nonsense"];
for (const cls of C.CLASSES) {
  { const p = fresh(); ok(d(p, cls) === "allow", `T1 ${cls}: nothing set, no world default: accept`, d(p, cls)); }
  for (const wd of C.SWITCHES) { const p = fresh();
    ok(d(p, cls, wd) === MODE[wd], `T2 ${cls}: world body-default ${wd} answers ${MODE[wd]}`, d(p, cls, wd));
    p.bodyDefault = wd; ok(C.decide(p, PAL, ME, cls, now).mode === MODE[wd], `T2b ${cls}: the synced world default ${wd} applies when the caller passes none`, p); }
  { const p = fresh(); ok(d(p, cls, "nonsense") === "allow", `T2c ${cls}: a world default outside SWITCHES is accept`, d(p, cls, "nonsense")); }
  for (const mine of C.SWITCHES) for (const wd of WORLD) { const p = fresh(); const r = set(p, { switch: mine });
    ok(r.ok && d(p, cls, wd) === MODE[mine], `T3 ${cls}: my switch ${mine} beats a world default of ${wd}`, { r, got: d(p, cls, wd) }); }
  for (const mine of [undefined, ...C.SWITCHES]) { const p = fresh(); if (mine) set(p, { switch: mine });
    set(p, { deny: PAL, class: cls });
    ok(d(p, cls, "accept") === "deny", `T4 ${cls}: a never for one person beats my switch ${mine ?? "(unset)"}`, d(p, cls, "accept"));
    ok(C.decide(p, "u-cccccccccccccccccccc", ME, cls, now, "accept").mode === (mine ? MODE[mine] : "allow"), `T4b ${cls}: …and is for that person only`); }
  { const p = fresh(); set(p, { switch: "refuse" }); set(p, { allow: PAL, class: cls });
    ok(d(p, cls) === "allow", `T4c ${cls}: an allow for one person beats my refuse`, d(p, cls)); }
  for (const bad of ["maybe", "", 1, null, "Accept"]) { const p = fresh(); const r: any = set(p, { switch: bad });
    ok(!r.ok && r.code === "shape" && d(p, cls) === "allow" && !p.consent[ME], `T5 ${cls}: a switch ${JSON.stringify(bad)} outside SWITCHES is refused and changes nothing`, { r, t: p.consent[ME] }); }
  { const p = fresh(); const r = set(p, { of: ME, switch: "refuse" }, PAL);
    ok(!r.ok && d(p, cls) === "allow", `T6 ${cls}: only the body's owner sets its switch`, r); }
  // names and classes from the wire never reach a prototype
  for (const who of PROTO) { const p = fresh();
    for (const k of ["deny", "allow"]) { const r = set(p, { [k]: who, class: cls }); ok(r.ok === false && !p.consent[ME], `T7 ${cls}: ${k} '${who}' is refused (not a person)`, r); } }
}
for (const who of PROTO) { const r = set(fresh(), { deny: who, class: "toString" }); ok(r.ok === false, `T7b deny '${who}' with a non-class is refused`, r); }
for (const cls of [...PROTO, "toString", "hasOwnProperty", "nonsense"]) { const p = fresh(); const r = set(p, { allow: PAL, class: cls });
  ok(r.ok === false && !p.consent[ME], `T8 class '${cls}' is refused and writes nothing`, r); }
ok(typeof Object.prototype.toString === "function" && !C.CLASSES.some((k) => Object.hasOwn(Object.prototype, k)) && ({} as any).mode === undefined, "T9 Object.prototype is untouched after every attempt");
{ const p = fresh(); const r = set(p, { deny: PAL });
  ok(r.ok && Object.getPrototypeOf(p.consent) === null && Object.getPrototypeOf(p.consent[ME]) === null && Object.getPrototypeOf(p.consent[ME].over) === null && Object.getPrototypeOf(p.consent[ME].over[PAL]) === null, "T10 every table level is prototype-less", r);
  ok(C.CLASSES.every((c) => d(p, c) === "deny"), "T10b a deny with no class is a never for every class", C.CLASSES.map((c) => d(p, c))); }
ok(d((() => { const p = fresh(); set(p, { deny: PAL, class: "move" }); return p; })(), "displace") === "deny", "T11 the old class word move is read as displace");

// retired table arguments, an allow's for, and a refused change changing nothing
for (const [k, v] of [["preset", "open"], ["set", { class: "touch", tier: "everyone", mode: "allow" }], ["pause", true], ["friend", PAL], ["unfriend", PAL], ["delegate", PAL], ["undelegate", PAL], ["of", ME]] as const) {
  const p = fresh(); const r: any = set(p, { [k]: v });
  ok(r.ok === false && r.code === "shape" && /switch/.test(r.fix ?? "") && !p.consent[ME], `R1 ${k} is retired: refused, pointing at switch, nothing written`, r); }
ok(C.RETIRED_CONSENT.length === 8, "R1b every retired argument is a row above", C.RETIRED_CONSENT);
for (const cls of C.CLASSES) for (const f of ["soon", -5, 0, "60000", NaN]) { const p = fresh(); const r = set(p, { allow: PAL, class: cls, for: f });
  ok(r.ok === false && !p.consent[ME]?.over?.[PAL], `R2 ${cls}: allow for ${JSON.stringify(f)} is refused`, { r, over: p.consent[ME]?.over }); }
for (const bad of [{ switch: "refuse", allow: PAL, class: "nonsense" }, { switch: "maybe", deny: PAL }, { switch: "ask", allow: "__proto__" }, { switch: "ask", allow: PAL, for: -1 }]) {
  const p = fresh(); set(p, { switch: "accept" }); const before = JSON.stringify(p.consent[ME]); const r = set(p, bad);
  ok(r.ok === false && JSON.stringify(p.consent[ME]) === before, `R3 a refused change leaves the table as it was: ${JSON.stringify(bad)}`, { r, table: p.consent[ME] }); }
for (const cls of C.CLASSES) { const p = fresh(), year = 365 * 24 * 3600000;
  set(p, { allow: PAL, class: cls }); const o = p.consent[ME].over[PAL][cls];
  ok(o?.mode === "allow" && o.until === undefined, `R4 ${cls}: an allow with no for has no end (until you revoke it)`, o);
  set(p, { allow: PAL, class: cls, for: year });
  ok(p.consent[ME].over[PAL][cls].until === now + year && C.decide(p, PAL, ME, cls, now + year - 1, "refuse").mode === "allow" && C.decide(p, PAL, ME, cls, now + year, "refuse").mode === "deny", `R4b ${cls}: an allow for a year lasts a year, then the switch answers`, p.consent[ME].over[PAL][cls]);
  set(p, { deny: PAL, class: cls }); const dn = p.consent[ME].over[PAL][cls];
  ok(dn?.mode === "deny" && dn.until === undefined, `R4c ${cls}: revoking (deny) replaces the standing allow at once`, dn); }
done();
