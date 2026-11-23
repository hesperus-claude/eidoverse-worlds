// Filesystem idioms: write-then-rename helpers (the fsynced replace is durable.ts replaceDurable). The fs is injectable so a
// caller's crash atomicity is testable.

import fs, { writeFileSync, renameSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { writeAll, syncDir, syncFile } from "./durable.ts";

export type AtomicFs = {
  writeFileSync: typeof writeFileSync;
  renameSync: typeof renameSync;
};

/** Write-then-rename: readers never see a half-written file; a crash leaves at most an orphan .tmp, overwritten next time.
 *  No fsync unless `durable` (the temp synced before the rename, the directory after: replaceDurable's guarantee, with the
 *  write and rename still going through the injectable fs); otherwise a power loss can still lose or empty the file. */
export function atomicWrite(
  path: string,
  data: string | Uint8Array,
  opts: { mode?: number; fs?: AtomicFs; durable?: boolean } = {},
) {
  const fs: AtomicFs = opts.fs ?? { writeFileSync, renameSync };
  fs.writeFileSync(`${path}.tmp`, data, opts.mode != null ? { mode: opts.mode } : undefined);
  if (opts.durable) syncFile(`${path}.tmp`);
  fs.renameSync(`${path}.tmp`, path);
  if (opts.durable) syncDir(dirname(path));
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
