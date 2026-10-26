// Filesystem idioms: the one tmp-write + rename helper every atomic write in the server goes through (explicit mode,
// injectable fs for fault injection; a crash between write and rename leaves <path>.tmp, which the next write overwrites).

import { writeFileSync, renameSync } from "node:fs";

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
