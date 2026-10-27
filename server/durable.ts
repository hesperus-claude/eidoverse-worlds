// The disk practice a sequencer owes its readers:
//  - a line is fsynced BEFORE anyone is told of it, or a crash re-issues a seq with a new head: "proof" of equivocation;
//  - a torn last line is cut off at open, not kept as a permanent malformed entry;
//  - a blob goes to a temp file and is renamed; one whose bytes don't match its name is rewritten, never kept.
import fs from "node:fs";
import path from "node:path";
import { sha256 } from "../shared/protocol/hash.js";

/** Torn tail (no final newline) cut off first. Only the writer cuts: `cut: false` (a reader) just leaves the tail out,
 *  since it may be a line being appended now. */
export function readLogBytes(logPath: string, { cut = true } = {}): Buffer {
  if (!fs.existsSync(logPath)) return Buffer.alloc(0);
  const b = fs.readFileSync(logPath);
  if (b.length === 0 || b[b.length - 1] === 0x0a) return b;
  const keep = b.lastIndexOf(0x0a) + 1;
  if (!cut) return b.subarray(0, keep);
  console.warn(`[log] ${logPath}: cut a torn last line (${b.length - keep} bytes, no newline) left by an interrupted write`);
  fs.truncateSync(logPath, keep);
  return b.subarray(0, keep);
}

/** writeSync may take fewer bytes (full disk, signal, pipe): loops until all are taken; a zero-byte write throws. */
export function writeAll(fd: number, buf: Uint8Array) {
  let off = 0;
  while (off < buf.length) {
    const n = fs.writeSync(fd, buf, off, buf.length - off);
    if (!(n > 0)) throw new Error(`short write: ${off} of ${buf.length} bytes taken, then none (disk full?)`);
    off += n;
  }
}
/** fsyncs before returning: broadcast only after this. A throw leaves the line's disk state unknown: the authority
 *  wedges the file as ambiguous. */
export function appendDurable(logPath: string, line: string) {
  mkdirDurable(path.dirname(logPath));
  const fresh = !fs.existsSync(logPath);
  const fd = fs.openSync(logPath, "a");
  try { writeAll(fd, Buffer.from(line + "\n", "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fresh) syncDir(path.dirname(logPath));   // a file's first line is durable only once its name is
}
/** So a new or renamed entry survives a crash (POSIX names live in the directory). Skipped on Windows (NTFS journals names). */
export function syncDir(dir: string) {
  if (process.platform === "win32") return;
  const fd = fs.openSync(dir, "r");
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

/** Deepest first, `dir` included: a cpSync'd tree (a fork's blobs) isn't durable until every file and entry is synced. */
export function syncTree(dir: string) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) syncTree(p);
    // Windows flushes a file only through a handle opened for writing (FlushFileBuffers); POSIX blobs may be read-only
    else if (ent.isFile()) { const fd = fs.openSync(p, process.platform === "win32" ? "r+" : "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } }
  }
  syncDir(dir);
}

/** Each parent that gained an entry is synced; `dir` itself is the caller's to sync once its file is in it. */
export function mkdirDurable(dir: string) {
  const first = fs.mkdirSync(dir, { recursive: true });
  if (first === undefined) return;
  const top = path.dirname(path.resolve(first));
  for (let d = path.dirname(path.resolve(dir)); ; d = path.dirname(d)) { syncDir(d); if (d === top || d === path.dirname(d)) break; }
}

/** Temp file (`mode` set before the data goes in) synced, renamed over `file`, then its directory synced. */
export function replaceDurable(file: string, data: string, mode = 0o644) {
  mkdirDurable(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w", mode);
  try { fs.fchmodSync(fd, mode); writeAll(fd, Buffer.from(data, "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
/** Atomic; replaces a copy that doesn't verify against `h`. */
export function putBlobFile(file: string, s: string, h: string) {
  if (fs.existsSync(file)) { try { if (`sha256:${sha256(fs.readFileSync(file, "utf8"))}` === h) return; } catch {} }
  mkdirDurable(path.dirname(file));
  const tmp = `${file}.${process.pid}.tmp`;
  const fd = fs.openSync(tmp, "w");
  try { writeAll(fd, Buffer.from(s, "utf8")); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, file);
  syncDir(path.dirname(file));
}
