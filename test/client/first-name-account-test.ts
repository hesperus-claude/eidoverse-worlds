// first-name-account-test — the name a first-run door gives becomes the account (house I192, #260).
//
//   BUN_RUNTIME_TRANSPILER_CACHE_PATH=0 bun test/client/first-name-account-test.ts
//
// base.js fixes CONFIG.account at load from the first real name this browser used (R 10-11: renaming yourself must not
// make you a stranger with no role in your own world). A first visit loads as guest-xxxx with no account; the door then
// calls setName, which changed only the name, so the account stayed unset until a reload. setName on a browser with no
// account and a real name sets it; a later rename never moves it.
import { GlobalRegistrator } from "@happy-dom/global-registrator";
GlobalRegistrator.register({ url: "http://localhost/?world=t" });
localStorage.clear();

let pass = 0, fail = 0;
const check = (name: string, ok: boolean, detail = "") => {
  if (ok) { pass++; console.log(`  \x1b[32m✓\x1b[0m ${name}`); }
  else { fail++; console.log(`  \x1b[31m✗\x1b[0m ${name}${detail ? ` — ${detail}` : ""}`); }
};
const { CONFIG, setName } = await import("../../client/lib/base.js");
check("a first visit is a guest with no account (the premise)", /^guest-/.test(CONFIG.name) && CONFIG.account == null, JSON.stringify([CONFIG.name, CONFIG.account]));
setName("Rab");
check("the door's name becomes the account", CONFIG.account === "Rab" && localStorage.getItem("ew-account") === "Rab", JSON.stringify([CONFIG.account, localStorage.getItem("ew-account")]));
setName("Rabbit");
check("…and a later rename leaves the account where it is", CONFIG.name === "Rabbit" && CONFIG.account === "Rab" && localStorage.getItem("ew-account") === "Rab", JSON.stringify([CONFIG.name, CONFIG.account]));
// a store whose writes throw (a full or blocked storage): renaming still renames, as load's remember() does (G2-017)
const { setToken } = await import("../../client/lib/base.js");
// happy-dom's Storage is a proxy: assigning .setItem stores a key named "setItem", so define it instead
Object.defineProperty(localStorage, "setItem", { value: () => { throw new Error("QuotaExceededError"); }, configurable: true });
let threw: unknown = null;
try { setName("Hare"); setToken("tok"); } catch (e) { threw = e; }
check("a store that throws on write doesn't make a rename (or a token) throw", threw === null && CONFIG.name === "Hare" && CONFIG.token === "tok", String(threw));
// …and on a browser with no account yet, so the first-name write (ew-account) is tried too: a fresh base.js, same store
{
  localStorage.clear();   // no remembered name or account: this load is a first visit
  const fresh = await import("../../client/lib/base.js?fresh-account");
  let threw2: unknown = null;
  const premise = /^guest-/.test(fresh.CONFIG.name) && fresh.CONFIG.account == null;
  try { fresh.setName("Fox"); } catch (e) { threw2 = e; }
  check("a first name on a store that throws still becomes the account, without throwing", premise && threw2 === null && fresh.CONFIG.account === "Fox", JSON.stringify({ premise, threw: String(threw2), account: fresh.CONFIG.account }));
}
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
