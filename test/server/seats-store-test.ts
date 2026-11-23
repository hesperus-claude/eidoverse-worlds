/**
 * seats-store fixture — #105 review B2/B3: the rights-bearing store's
 * integrity boundaries, driven with injected faults.
 *
 * B2: dangerous keys never index the maps (schema refusal + null-prototype
 * maps + roster membership), and a refused write mutates NOTHING — no store,
 * no log, no Object.prototype.
 * B3: every write is provenance-first. An append failure changes nothing; a
 * snapshot failure leaves the log AHEAD and a fresh load folds it forward
 * (durable-with-receipt or not at all); a snapshot AHEAD of its log is
 * quarantined and served as missing; a countersign against a moved revision
 * refuses.
 *
 * Run: bun run test/server/seats-store-test.ts   (scratch dirs only)
 */

import fs, { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, appendFileSync as appendFileSyncReal } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { SeatStore } from "../../server/seats.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const LIB = resolve(process.env.EIDOVERSE_DIR ?? join(ROOT, "..", "eidoverse-video"));

let failures = 0;
const check = (label: string, ok: boolean, detail = "") => {
  console.log(ok ? `  \x1b[32m✓\x1b[0m ${label}` : `  \x1b[31m✗ ${label}${detail ? ` — ${detail}` : ""}\x1b[0m`);
  if (!ok) failures++;
};

const OPT = mkdtempSync(join(tmpdir(), "seatstore-"));
mkdirSync(join(OPT, "eidoverse/assets/vrms"), { recursive: true });
writeFileSync(join(OPT, "eidoverse/assets/vrms/seatdummy.vrm"), "not a real vrm — roster presence is what's under test");

const profile = (avatar: string, pose = "sitchair") => ({
  avatar, avatarSha256: "a".repeat(64), pose, clipSha256: "c".repeat(64),
  seatContactY: 0.2055,
  derivation: { toolVersion: "seatlab-4", method: "skinned-pelvis-contact-v1",
    winner: { mesh: "Body", vertexIndex: 42, rootLocal: [0, 0.2055, 0] },
    supportPatch: { count: 31, spreadY: 0.0184, radiusXZ: 0.1 }, runs: 3, deterministic: true },
  review: { status: "proposed" },
});
const seatsDir = join(OPT, "seats");
const snapshotOf = () => existsSync(join(seatsDir, "profiles.json")) ? readFileSync(join(seatsDir, "profiles.json"), "utf8") : null;
const logOf = () => existsSync(join(seatsDir, "profiles.log.jsonl")) ? readFileSync(join(seatsDir, "profiles.log.jsonl"), "utf8") : null;

try {
  console.log("B2 — dangerous keys and unknown subjects bounce whole");
  {
    const store = new SeatStore(OPT, LIB);
    for (const bad of ["__proto__", "constructor", "prototype"]) {
      const r = store.propose(profile(bad), "attacker") as any;
      check(`avatar "${bad}" refused with a 4xx`, !r.ok && r.status >= 400 && r.status < 500, JSON.stringify(r));
    }
    const unknown = store.propose(profile("ghost-rig"), "someone") as any;
    check("unrostered avatar refused (404 — no bytes to judge against)", !unknown.ok && unknown.status === 404, JSON.stringify(unknown));
    const pose = store.propose(profile("seatdummy", "sitground"), "someone") as any;
    check("pose outside the slice refused", !pose.ok && pose.status === 422);
    check("refused writes mutated nothing on disk", snapshotOf() === null && logOf() === null);
    check("refused writes left rev at 0", store.rev === 0);
    check("Object.prototype is unpolluted", ({} as any).polluted === undefined
      && !("sitchair" in {}) && Object.keys({}).length === 0
      && ({} as any).accepted === undefined && ({} as any).proposed === undefined);
  }

  console.log("happy path + countersign CAS (B3)");
  {
    const store = new SeatStore(OPT, LIB);
    const p = store.propose(profile("seatdummy"), "aid1:someone") as any;
    check("rostered proposal lands at rev 1", p.ok && p.rev === 1);
    check("the log line and the snapshot are both at rev 1",
      JSON.parse(logOf()!.trim().split("\n").at(-1)!).rev === 1 && JSON.parse(snapshotOf()!).rev === 1);
    const noRev = store.accept("seatdummy", "sitchair", "receipt", "op", undefined as any) as any;
    check("accept without expectedRev refused", !noRev.ok && /expectedRev required/.test(noRev.why));
    const stale = store.accept("seatdummy", "sitchair", "receipt", "op", 0) as any;
    check("accept against a moved revision refused (review what you sign)", !stale.ok && /re-list/.test(stale.why));
    const good = store.accept("seatdummy", "sitchair", "receipt", "op", 1) as any;
    check("accept at the reviewed revision lands at rev 2", good.ok && good.rev === 2);

    // two writers: B holds a stale view while A advances the disk
    const storeB = new SeatStore(OPT, LIB);
    const p2 = store.propose(profile("seatdummy"), "aid1:someone") as any;   // disk → rev 3
    const clobber = storeB.accept("seatdummy", "sitchair", "receipt", "op", 2) as any;
    check("a second process cannot countersign from a stale snapshot", p2.ok && !clobber.ok && /re-list/.test(clobber.why));
    const honest = storeB.accept("seatdummy", "sitchair", "receipt2", "op", 3) as any;
    check("…and succeeds after re-reviewing the moved store", honest.ok && honest.rev === 4);
  }

  console.log("B3 — a landed write is synced: the receipt before the snapshot (G2-072)");
  {
    const store = new SeatStore(OPT, LIB);
    const real = fs.fsyncSync, order: string[] = [];
    (fs as any).fsyncSync = (fd: number) => {
      let p = ""; try { p = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* no /proc: count only */ }
      order.push(p.endsWith("profiles.log.jsonl") ? "log" : p.endsWith(".tmp") ? "snapshot" : p === seatsDir ? "dir" : p || "?");
      return real(fd);
    };
    let r: any;
    try { r = store.propose(profile("seatdummy"), "aid1:someone"); } finally { (fs as any).fsyncSync = real; }
    check("a landed proposal fsyncs its log line, its snapshot, and the snapshot's new name", r.ok
      && (order.includes("?") ? order.length >= (process.platform === "win32" ? 2 : 3)
        : order.indexOf("log") >= 0 && order.indexOf("log") < order.indexOf("snapshot") && (process.platform === "win32" || order.includes("dir"))),
      JSON.stringify({ r, order }));
  }

  console.log("B3 — the fold-forward syncs the log before the snapshot it rewrites");
  {
    const real = fs.fsyncSync, kind = (fd: number) => { let p = ""; try { p = fs.readlinkSync(`/proc/self/fd/${fd}`); } catch { /* no /proc */ }
      return p.endsWith("profiles.log.jsonl") ? "log" : p.endsWith(".tmp") ? "snapshot" : p === seatsDir ? "dir" : p ? "other" : "?"; };
    const probeFd = fs.openSync(seatsDir, "r"), named = kind(probeFd) !== "?"; fs.closeSync(probeFd);
    if (!named) check("(no /proc to name fds: the fold-forward order row is skipped)", true);
    else {
      const store = new SeatStore(OPT, LIB), snapBefore = snapshotOf();
      (fs as any).fsyncSync = (fd: number) => { if (kind(fd) === "log") { const e: any = new Error("EIO (injected)"); e.code = "EIO"; throw e; } return real(fd); };
      let r: any; try { r = store.propose(profile("seatdummy"), "aid1:eio"); } finally { (fs as any).fsyncSync = real; }
      check("a log fsync that fails refuses the write and leaves the snapshot as it was",
        !r.ok && /not synced/.test(r.why) && snapshotOf() === snapBefore, JSON.stringify(r));
      const order: string[] = [];
      (fs as any).fsyncSync = (fd: number) => { order.push(kind(fd)); return real(fd); };
      let again: SeatStore; try { again = new SeatStore(OPT, LIB); } finally { (fs as any).fsyncSync = real; }
      check("…and the next load folds the receipt forward, syncing the log before the snapshot it rewrites",
        again!.rev === store.rev + 1 && order.includes("log") && order.indexOf("log") < order.indexOf("snapshot"), JSON.stringify({ rev: again!.rev, order }));
    }
  }

  console.log("B3 — injected faults leave no unreceipted state");
  {
    const failAppend = new SeatStore(OPT, LIB, { appendFileSync: () => { throw new Error("disk full"); } });
    const revBefore = failAppend.rev;
    const r = failAppend.propose(profile("seatdummy"), "someone") as any;
    check("append failure: write refused, nothing changed", !r.ok && /provenance append failed/.test(r.why));
    check("append failure: in-memory rev unchanged", failAppend.rev === revBefore);
    check("append failure: disk snapshot unchanged", JSON.parse(snapshotOf()!).rev === revBefore);

    const failRename = new SeatStore(OPT, LIB, { renameSync: () => { throw new Error("rename torn"); } });
    const revBefore2 = failRename.rev;
    const r2 = failRename.propose(profile("seatdummy"), "someone") as any;
    check("snapshot failure: reported as failure, live store unchanged", !r2.ok && failRename.rev === revBefore2, JSON.stringify(r2));
    const logRev = JSON.parse(logOf()!.trim().split("\n").at(-1)!).rev;
    check("snapshot failure: the log holds the receipt (log ahead by one)", logRev === revBefore2 + 1);

    // recovery: a fresh load folds the receipted write forward
    const recovered = new SeatStore(OPT, LIB);
    check("recovery folds the log-ahead write forward", recovered.rev === logRev, `rev=${recovered.rev}`);
    check("…and the recovered record is live", recovered.list().records.some((x) => x.name === "seatdummy" && x.slot === "proposed"));
    check("…and the snapshot was rewritten to match its receipts", JSON.parse(snapshotOf()!).rev === logRev);
  }

  console.log("B3 — a snapshot with no receipt is quarantined");
  {
    const snap = JSON.parse(snapshotOf()!);
    writeFileSync(join(seatsDir, "profiles.json"), JSON.stringify({ ...snap, rev: snap.rev + 50 }));
    const q = new SeatStore(OPT, LIB);
    check("snapshot ahead of its log → quarantined", q.quarantineReason !== null);
    check("quarantined store serves missing, never the unreceipted state",
      q.judge("seatdummy", join(OPT, "eidoverse/assets/vrms/seatdummy.vrm")).status === "missing");
    const w = q.propose(profile("seatdummy"), "someone") as any;
    check("quarantined store refuses writes (503)", !w.ok && w.status === 503);
    // un-quarantine for the sections below: restore the honest snapshot
    writeFileSync(join(seatsDir, "profiles.json"), JSON.stringify(snap));
  }

  console.log("#105 round 2 — two real writers, genuinely overlapped");
  {
    // B is a second store instance (a second process, as far as the lock can
    // tell) with a short bounded wait; its propose() is injected INSIDE A's
    // provenance append — the exact interleaving the reviewer forced on the
    // prior head, where both writers built rev N+1 from rev N and the log
    // took two contradictory records at one revision.
    const B = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 250 });
    let overlapResult: any = null, fired = false;
    const A = new SeatStore(OPT, LIB, {
      appendFileSync: (path: any, data: any) => {
        if (!fired) { fired = true; overlapResult = B.propose(profile("seatdummy", "sitchair"), "writer-B"); }
        return appendFileSyncReal(path, data);
      },
    });
    const revBefore = A.rev, bRevBefore = B.rev;
    const logBefore = logOf(), snapBefore = snapshotOf();
    const a = A.propose(profile("seatdummy"), "writer-A") as any;
    check("A's write completes under its lock", a.ok === true && a.rev === revBefore + 1, JSON.stringify(a));
    check("B, overlapped inside A's transaction, REFUSES instead of forking history",
      overlapResult && overlapResult.ok === false && /lock/.test(overlapResult.why), JSON.stringify(overlapResult));
    check("B's refusal changed nothing (rev held)", B.rev === bRevBefore, `${bRevBefore} -> ${B.rev}`);
    const b = B.propose(profile("seatdummy"), "writer-B") as any;
    check("B retried after the release succeeds at the NEXT revision", b.ok === true && b.rev === a.rev + 1, JSON.stringify(b));
    const revs = logOf()!.trim().split("\n").map((l) => { try { return JSON.parse(l).rev; } catch { return null; } }).filter((r) => r !== null);
    check("vector 1: log revisions are unique and strictly monotonic",
      revs.every((r, i) => i === 0 || r > revs[i - 1]), JSON.stringify(revs));
    check("vector 2: both writes survive, reconstructible (each writer's line is in the provenance log)",
      logOf()!.trim().split("\n").map((l) => { try { return JSON.parse(l).actor; } catch { return null; } }).filter((x) => x === "writer-A" || x === "writer-B").length >= 2
      && new SeatStore(OPT, LIB).list().records.some((x) => x.name === "seatdummy" && x.slot === "proposed"));

    // vector 3: a proposal lands between the operator's review and the
    // countersign — the reviewed revision has moved, the acceptance refuses
    const op = new SeatStore(OPT, LIB);
    const reviewedRev = op.rev;
    const interloper = new SeatStore(OPT, LIB);
    const p = interloper.propose(profile("seatdummy"), "interloper") as any;
    const ac = op.accept("seatdummy", "sitchair", "receipt", "op", reviewedRev) as any;
    check("vector 3: the countersign refuses the record nobody reviewed", p.ok === true && !ac.ok && /re-list/.test(ac.why), JSON.stringify(ac));
    const ac2 = op.accept("seatdummy", "sitchair", "receipt", "op", p.rev) as any;
    check("…and succeeds against the re-reviewed revision", ac2.ok === true);

    // vector 4: lock acquisition failure changes neither log, snapshot, nor memory
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: process.pid, nonce: "someone-else", ts: Date.now() }));
    const blocked = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 200 });
    const logHeld = logOf(), snapHeld = snapshotOf(), revHeld = blocked.rev;
    const timeout = blocked.propose(profile("seatdummy"), "late-writer") as any;
    check("vector 4: a lock timeout refuses with nothing written",
      !timeout.ok && /lock/.test(timeout.why) && logOf() === logHeld && snapshotOf() === snapHeld && blocked.rev === revHeld,
      JSON.stringify(timeout));
    rmSync(join(seatsDir, ".write-lock"), { force: true });

    // #105 round 3 — a LIVE holder is never broken, however old its stamp.
    // The lock names THIS test process's pid (alive by construction) with a
    // stamp from an hour ago: age says stale, liveness says wait. B must
    // time out with nothing written — exclusion outranks patience.
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: process.pid, nonce: "live-but-slow-writer", ts: Date.now() - 3_600_000 }));
    const liveLock = readFileSync(join(seatsDir, ".write-lock"), "utf8");
    const lb = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 250 });
    const logLive = logOf(), snapLive = snapshotOf(), lbRevBefore = lb.rev;
    const liveOld = lb.propose(profile("seatdummy"), "impatient") as any;
    check("live-but-old holder: the lock is NOT stolen — the writer times out",
      !liveOld.ok && /lock/.test(liveOld.why), JSON.stringify(liveOld));
    check("…with log, snapshot, and memory untouched", logOf() === logLive && snapshotOf() === snapLive && lb.rev === lbRevBefore);
    check("…and the live holder's lock survives, byte-identical",
      readFileSync(join(seatsDir, ".write-lock"), "utf8") === liveLock);
    rmSync(join(seatsDir, ".write-lock"), { force: true });

    // …while a DEAD holder's lock is broken by verified pid-death, not age:
    // a fresh stamp on a nonexistent pid breaks immediately
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: 999_999_999, nonce: "corpse", ts: Date.now() }));
    const breaker = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 500 });
    const broke = breaker.propose(profile("seatdummy"), "after-crash") as any;
    check("a dead writer's lock is broken (pid-verified, fresh stamp and all) and the write proceeds", broke.ok === true, JSON.stringify(broke));

    // G2-074: a dead holder whose lock can't be claimed (the rename keeps failing) is waited on only until the deadline,
    // like a live one. The injected rename fails until well past the deadline, then lets the claim through.
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: 999_999_999, nonce: "stuck-corpse", ts: Date.now() }));
    const t0 = Date.now(); let lateTries = 0;
    const stuck = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 200, lockFs: {
      renameSync: (from: any, to: any) => {
        if (String(from).endsWith(".write-lock") && Date.now() - t0 < 1200) throw new Error("EPERM (injected)");
        if (String(from).endsWith(".write-lock")) lateTries++;
        return fs.renameSync(from, to);
      },
    } });
    const st = stuck.propose(profile("seatdummy"), "stuck-breaker") as any;
    check("G2-074: an unclaimable dead lock times out at the deadline (503), not past it",
      !st.ok && st.status === 503 && lateTries === 0 && Date.now() - t0 < 1200, JSON.stringify({ st, lateTries, ms: Date.now() - t0 }));
    rmSync(join(seatsDir, ".write-lock"), { force: true });

    // G3-085: the claim's rename caught a NEWER lock (it replaced the corpse after we read it), and a newcomer took the
    // free name before the put-back. The put-back must not clobber the newcomer's lock.
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: 999_999_999, nonce: "corpse-2", ts: Date.now() }));
    let raced = false;
    const putBack = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 200, lockFs: {
      renameSync: (from: any, to: any) => {
        if (!raced && String(from).endsWith(".write-lock") && String(to).includes(".tomb-")) {
          raced = true;
          writeFileSync(from, JSON.stringify({ pid: process.pid, nonce: "newer", ts: Date.now() }));
          fs.renameSync(from, to);
          writeFileSync(from, JSON.stringify({ pid: process.pid, nonce: "newcomer", ts: Date.now() }));
          return;
        }
        return fs.renameSync(from, to);
      },
    } });
    const pb = putBack.propose(profile("seatdummy"), "put-back") as any;
    const lockNow = JSON.parse(readFileSync(join(seatsDir, ".write-lock"), "utf8")).nonce;
    check("G3-085: the put-back leaves the newcomer's lock in place (it refuses to clobber)",
      raced && !pb.ok && lockNow === "newcomer", JSON.stringify({ raced, pb, lockNow }));
    check("G3-085: …and leaves no tomb behind", !fs.readdirSync(seatsDir).some((f) => f.includes(".tomb-")), fs.readdirSync(seatsDir).join(","));
    rmSync(join(seatsDir, ".write-lock"), { force: true });
    // …and a caught lock that won't parse yet (a newer writer between its openSync("wx") and its writeSync) is put back too,
    // not left in a tomb while its writer thinks it holds the lock
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: 999_999_999, nonce: "corpse-4", ts: Date.now() }));
    let blanked = false;
    const blank = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 200, lockFs: {
      renameSync: (from: any, to: any) => {
        if (!blanked && String(from).endsWith(".write-lock") && String(to).includes(".tomb-")) { blanked = true; writeFileSync(from, ""); }
        return fs.renameSync(from, to);
      },
    } });
    const bl = blank.propose(profile("seatdummy"), "blank") as any;
    check("a caught lock that won't parse is put back: the writer waits on it, and no tomb is left",
      blanked && !bl.ok && existsSync(join(seatsDir, ".write-lock")) && readFileSync(join(seatsDir, ".write-lock"), "utf8") === ""
      && !fs.readdirSync(seatsDir).some((f) => f.includes(".tomb-")), JSON.stringify({ blanked, bl, files: fs.readdirSync(seatsDir) }));
    rmSync(join(seatsDir, ".write-lock"), { force: true });
    for (const f of fs.readdirSync(seatsDir)) if (f.includes(".tomb-")) rmSync(join(seatsDir, f), { force: true });

    // …while with no newcomer, the newer lock the claim caught is put back as it was
    writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: 999_999_999, nonce: "corpse-3", ts: Date.now() }));
    let caught = false;
    const restorer = new SeatStore(OPT, LIB, {}, { lockTimeoutMs: 200, lockFs: {
      renameSync: (from: any, to: any) => {
        if (!caught && String(from).endsWith(".write-lock") && String(to).includes(".tomb-")) {
          caught = true; writeFileSync(from, JSON.stringify({ pid: process.pid, nonce: "newer", ts: Date.now() }));
        }
        return fs.renameSync(from, to);
      },
    } });
    const rs = restorer.propose(profile("seatdummy"), "restorer") as any;
    check("G3-085: with no newcomer, the caught lock is put back (and the writer waits on it)",
      caught && !rs.ok && JSON.parse(readFileSync(join(seatsDir, ".write-lock"), "utf8")).nonce === "newer"
      && !fs.readdirSync(seatsDir).some((f) => f.includes(".tomb-")), JSON.stringify({ caught, rs }));
    rmSync(join(seatsDir, ".write-lock"), { force: true });

    // #105 round 3 — release-safety + commit gate: the lock is swapped to a
    // successor's mid-transaction (inside A's provenance append, after the
    // first gate). A must ABORT at the second gate — snapshot withheld, its
    // own release must NOT touch the successor's lock, and the orphaned log
    // line folds forward as a receipted write on the next load.
    let swapped = false;
    const gated = new SeatStore(OPT, LIB, {
      appendFileSync: (path: any, data: any) => {
        appendFileSyncReal(path, data);
        if (!swapped) { swapped = true; writeFileSync(join(seatsDir, ".write-lock"), JSON.stringify({ pid: process.pid, nonce: "successor", ts: Date.now() })); }
      },
    });
    const revG = gated.rev;
    const g = gated.propose(profile("seatdummy"), "gated-writer") as any;
    check("commit gate: ownership lost after append → transaction aborts, snapshot withheld",
      !g.ok && /ownership lost after provenance append/.test(g.why), JSON.stringify(g));
    check("…the aborted writer's memory and snapshot are unchanged", gated.rev === revG && JSON.parse(snapshotOf()!).rev === revG);
    check("…and its release leaves the successor's lock untouched",
      JSON.parse(readFileSync(join(seatsDir, ".write-lock"), "utf8")).nonce === "successor");
    rmSync(join(seatsDir, ".write-lock"), { force: true });
    const afterGate = new SeatStore(OPT, LIB);
    check("…while the receipted orphan folds forward on the next load", afterGate.rev === revG + 1, `rev=${afterGate.rev}`);

    // vector 5: duplicate-revision provenance is a forked history — quarantined
    const lastLine = logOf()!.trim().split("\n").at(-1)!;
    appendFileSyncReal(join(seatsDir, "profiles.log.jsonl"), lastLine + "\n");
    const forked = new SeatStore(OPT, LIB);
    check("vector 5: startup refuses duplicate-revision provenance",
      forked.quarantineReason !== null && /monotonic|duplicate/.test(forked.quarantineReason ?? ""), forked.quarantineReason ?? "");
  }
} finally {
  rmSync(OPT, { recursive: true, force: true });
}

console.log(failures ? `\n\x1b[31m${failures} failure(s)\x1b[0m` : "\n\x1b[32mall checks passed\x1b[0m");
process.exit(failures ? 1 : 0);
