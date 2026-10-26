// The authority's governance keys (PROTOCOL §2.4, §3d C1): one sequencer key per keys file, one per founding identity
// (two worlds one person founds share keys; genesis's nonce tells them apart). Keys never enter a log; the file is 0600.
// Same layout as the protocol lab's authority.js custodyOf.
import { appendDurable, readLogBytes, replaceDurable, mkdirDurable } from "./durable.ts";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

type Key = { pub: string; priv: string };
type File = { sequencer?: Key; operator?: Key; holders: Record<string, Key> };

/** How long a mint waits for another process's mint. */
const LOCK_WAIT_MS = 10_000;
/** `<pid> <nonce>`, or null when unreadable. */
function holderOf(f: string): { pid: number; nonce: string } | null {
  let s: string; try { s = fs.readFileSync(f, "utf8"); } catch { return null; }
  const [p, nonce] = s.split(" "); const pid = Number(p);
  return Number.isInteger(pid) && pid > 0 && /^[0-9a-f]{16}$/.test(nonce ?? "") ? { pid, nonce } : null;
}
/** A lock naming our own pid is an earlier process's (only the main thread mints, synchronously; a restart can reuse a
 *  pid). A worker thread that minted would need its thread in the lock's holder. */
function gone(pid: number): boolean {
  if (pid === process.pid) return true;
  try { process.kill(pid, 0); return false; } catch (e) { return (e as NodeJS.ErrnoException).code === "ESRCH"; }
}
/** null when held. Holder written and synced to its own file, only then linked to `name`, so `name` never exists
 *  without its holder, even after a power loss. Returns the nonce. */
function take(name: string): string | null {
  const nonce = crypto.randomBytes(8).toString("hex"), tmp = `${name}.${nonce}.tmp`;
  const fd = fs.openSync(tmp, "wx", 0o600);
  try { fs.writeSync(fd, `${process.pid} ${nonce}`); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  try { fs.linkSync(tmp, name); return nonce; }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "EEXIST") return null; throw e; }
  finally { fs.rmSync(tmp, { force: true }); }
}
/** As one step: a waiter takes `<lock>.<its nonce>` and removes `f` only if it still holds that nonce, so a newer lock
 *  is never removed; a stale right is removed the same way. */
function clearIfGone(lock: string, f: string): boolean {
  const h = holderOf(f); if (!h || !gone(h.pid)) return false;
  const right = `${lock}.${h.nonce}`;
  if (!take(right)) { clearIfGone(lock, right); return false; }
  try { if (holderOf(f)?.nonce !== h.nonce) return false; fs.unlinkSync(f); return true; } finally { fs.rmSync(right, { force: true }); }
}

const mk = (): Key => {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  return { pub: "ed25519:" + (publicKey.export({ format: "jwk" }) as { x: string }).x, priv: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64") };
};

/** One custody per keys file per process (#260): separate handles each wrote their whole cache back over the others' keys. */
const byFile = new Map<string, ReturnType<typeof openCustody>>();
/** `file` is created on first use. */
export function custodyAt(file: string) {
  const k = path.resolve(file); let h = byFile.get(k);
  if (!h) { h = openCustody(k); byFile.set(k, h); }
  return h;
}
function openCustody(file: string) {
  const c: File = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : { holders: {} };
  // re-read before minting: a key minted here must never replace one already on disk
  const sync = () => { if (!fs.existsSync(file)) return; const d = JSON.parse(fs.readFileSync(file, "utf8")) as File;
    c.sequencer ??= d.sequencer; c.operator ??= d.operator; c.holders = { ...(d.holders ?? {}), ...c.holders }; };
  // durably: a key handed out must survive a crash, or the genesis it signed (already synced) names a key no one holds
  const save = () => replaceDurable(file, JSON.stringify(c, null, 1), 0o600);
  // read + mint + write hold `<file>.lock`, or two minting processes' later rename drops the other's key
  const lock = `${file}.lock`;
  const minting = (missing: () => boolean, mint: () => void) => {
    if (!missing()) return;
    mkdirDurable(path.dirname(file));   // its directory's name can be lost in a crash too
    const wait = new Int32Array(new SharedArrayBuffer(4)); const until = Date.now() + LOCK_WAIT_MS;
    while (!take(lock)) {
      if (clearIfGone(lock, lock)) continue;
      if (Date.now() > until) { const h = holderOf(lock);
        throw new Error(`custody: ${lock} has been held${h ? ` by process ${h.pid}` : ""} for ${LOCK_WAIT_MS / 1000} s; if no process is minting a key, remove it`); }
      Atomics.wait(wait, 0, 0, 10);
    }
    // only this process removes its own lock: another removes a lock only once its holder has exited
    try { sync(); if (missing()) { mint(); save(); } } finally { fs.rmSync(lock, { force: true }); }
  };
  return {
    sequencer(): string { minting(() => !c.sequencer, () => { c.sequencer = mk(); }); return c.sequencer!.pub; },
    /** GOVERNANCE key (§2.4 tier 1): never the sequencer's, so a stolen writing key isn't also the only override. */
    operator(): string { minting(() => !c.operator, () => { c.operator = mk(); }); return c.operator!.pub; },
    /** base64url Ed25519 by the operator key, never the sequencer's: the COUNTERSIGNATURE on a translation approval
     *  (tools/protocol/world.ts approvalFor; PROTOCOL §14). */
    signOperator(msg: string): string {
      minting(() => !c.operator, () => { c.operator = mk(); });
      const key = crypto.createPrivateKey({ key: Buffer.from(c.operator!.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
    keyOf(who: string, make = false): string | null { if (make) minting(() => !c.holders[who], () => { c.holders[who] = mk(); }); return c.holders[who]?.pub ?? null; },
    /** §2.4 chain point: base64url Ed25519 over msg ("eidoverse-head:<world id>:<seq>:<head hex>") by the sequencer key. */
    sign(msg: string): string {
      minting(() => !c.sequencer, () => { c.sequencer = mk(); });
      const key = crypto.createPrivateKey({ key: Buffer.from(c.sequencer!.priv, "base64"), format: "der", type: "pkcs8" });
      return crypto.sign(null, Buffer.from(msg, "utf8"), key).toString("base64url");
    },
  };
}

/** §2.1: never in the world log. One record per line. */
export function modLogAt(file: string) {
  // read as a reader; the first append repairs a torn tail first, as the log's writer
  const mod = fs.existsSync(file) ? readLogBytes(file, { cut: false }).toString("utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
  let repaired = false;
  return { mod, appendMod: (r: object) => { if (!repaired) { readLogBytes(file); repaired = true; } appendDurable(file, JSON.stringify(r)); } };
}
