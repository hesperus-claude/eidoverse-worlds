// Filesystem idioms: the one write-then-rename helper, with an explicit mode, an injectable fs (so a caller's failure
// atomicity is testable) and stale-tmp tolerance (a crash between write and rename leaves <path>.tmp; the next write
// overwrites it).

import fs, { writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { writeAll, syncDir } from "./durable.ts";

export type AtomicFs = {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
};

/** Write-then-rename. The rename is the commit: readers never observe a
 *  half-written file, and a crash costs at most an orphan .tmp beside it. */
export function atomicWrite(
  path: string,
  data: string | Uint8Array,
  opts: { mode?: number; fs?: AtomicFs } = {},
) {
  const fs: AtomicFs = opts.fs ?? { writeFileSync, renameSync };
  fs.writeFileSync(`${path}.tmp`, data, opts.mode != null ? { mode: opts.mode } : undefined);
  fs.renameSync(`${path}.tmp`, path);
}

/** A private file (0600), written atomically: a fresh random temp made with "wx" (a planted temp or symlink is never followed),
 *  and a symlink at the target refused rather than replaced. */
export function writePrivate(path: string, data: string) {
  let link = false; try { link = fs.lstatSync(path).isSymbolicLink(); } catch { /* absent: fine */ }
  if (link) throw new Error(`${path} is a symlink: refused (remove it, then try again)`);
  const tmp = `${path}.${randomBytes(8).toString("hex")}.tmp`, fd = fs.openSync(tmp, "wx", 0o600);
  try { writeAll(fd, Buffer.from(data, "utf8")); fs.fsyncSync(fd); fs.closeSync(fd); fs.renameSync(tmp, path); }
  catch (e) { try { fs.closeSync(fd); } catch { /* closed */ } try { fs.unlinkSync(tmp); } catch { /* gone */ } throw e; }
  syncDir(dirname(path));
}
