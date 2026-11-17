#!/usr/bin/env python3
"""Emit 01-mapping.tsv + summary json from final2.json/trace.json; applies the commit-table overrides."""
import json, subprocess, sys, collections
repo, base, head, out = sys.argv[1:5]
f = json.load(open("final2.json")); t = json.load(open("trace.json"))
def git(*a): return subprocess.run(["git","-C",repo,*a],capture_output=True,check=True).stdout
def tree(rev):
    d = {}
    for l in git("ls-tree","-r",rev).decode().splitlines():
        meta, p = l.split("\t",1); d[p] = meta.split()[2]
    return d
bt, ht = tree(base), tree(head)
TRIV = {"", "}", "{", "};", ")", "});", "*/", "/**", "*", "]", "],", "},", "})", "```", "---"}
cache = {}
def lines(rev, p):
    k = (rev, p)
    if k not in cache:
        b = git("show", f"{rev}:{p}")
        if b"\0" in b[:8000] or len(b) > 3_000_000: cache[k] = None
        else:
            c = collections.Counter(l.strip() for l in b.decode("utf-8","replace").splitlines())
            for x in TRIV: c.pop(x, None)
            cache[k] = c
    return cache[k]
def sim(o, n):
    a, b = lines(base, o), lines(head, n)
    if a is None or b is None: return ("bin", "bin")
    s = sum((a & b).values())
    return (round(100*s/max(1,sum(a.values()))), round(100*s/max(1,sum(b.values()))))
OVR = {"tools/protocol/suites.ts": "test/gate/suites.ts", "tools/protocol/procgroup.ts": "test/gate/procgroup.ts"}
subj = {}
for k, v in t["hist"].items():
    for e in v: subj[e[-2]] = e[-1]
for v in t["addhist"].values():
    for e in v: subj[e[-2]] = e[-1]
rows = []
moved_new = set()
for r in f["rows"]:
    o, n, ev = r[0], r[1], r[2]
    if o in OVR:
        n = OVR[o]; ev = "commit 7339f6fa8 move table (same commit deletes old, adds new; per-commit -M missed it)"
    if n:
        moved_new.add(n)
        k, nf = sim(o, n)
        st = "rename" if bt[o] == ht[n] else "rename+edit"
        note = ""
        if k != "bin" and min(k, nf) < 20: note = "move then rewrite: <20% of lines in common; read both"
        commits = ev.split(":",1)[1] if ev.startswith("history:") else ""
        if ev.startswith("git-M"): note = "moved in the merge of anima/main (b7d498f4e); paired by end-to-end git -M"
        rows.append([st, o, n, k, nf, ev.split(":")[0] if ev.startswith(("history","git-M")) else "commit-table", commits, note])
    else:
        c = ev.split()[-1]
        rows.append(["deleted", o, "", "", "", "history", c, subj.get(c, "")])
for p in sorted(bt):
    if p in ht and not any(r[1] == p for r in f["rows"]):
        rows.append(["unchanged" if bt[p] == ht[p] else "modified", p, p, "", "", "same path", "", ""])
adds = [p for p in f["adds"] if p not in moved_new]
for p in adds:
    h = t["addhist"][p][0]
    rows.append(["added", "", p, "", "", "history", h[2], subj.get(h[2], h[3])])
# best-content annotations for true adds/dels (informational, never used to pair)
headtext = [p for p in ht]; basetext = [p for p in bt]
def best_dest(o):
    a = lines(base, o)
    if not a: return ""
    best = (0, "")
    for p in headtext:
        b = lines(head, p)
        if not b: continue
        s = sum((a & b).values())
        if s > best[0]: best = (s, p)
    pct = round(100*best[0]/max(1,sum(a.values())))
    return f"{best[1]} ({pct}% of its lines)" if pct >= 30 else ""
def best_src(n):
    b = lines(head, n)
    if not b: return ""
    best = (0, "")
    for p in basetext:
        a = lines(base, p)
        if not a: continue
        s = sum((a & b).values())
        if s > best[0]: best = (s, p)
    pct = round(100*best[0]/max(1,sum(b.values())))
    return f"{best[1]} ({pct}% of its lines)" if pct >= 30 else ""
for r in rows:
    if r[0] == "deleted": r.append(best_dest(r[1]))
    elif r[0] == "added": r.append(best_src(r[2]))
    else: r.append("")
order = {"rename":0,"rename+edit":1,"modified":2,"unchanged":3,"deleted":4,"added":5}
rows.sort(key=lambda r: (order[r[0]], r[1] or r[2]))
with open(out, "w") as fh:
    fh.write("status\told_path\tnew_path\told_lines_kept_pct\tnew_lines_from_old_pct\tevidence\tcommits\tnote\tcontent_lookalike_info_only\n")
    for r in rows: fh.write("\t".join(str(x) for x in r) + "\n")
olds = [r[1] for r in rows if r[1]]; news = [r[2] for r in rows if r[2]]
summary = {"counts": collections.Counter(r[0] for r in rows), "old_unique": len(olds)==len(set(olds)),
  "new_unique": len(news)==len(set(news)), "old_cover": set(olds)==set(bt), "new_cover": set(news)==set(ht),
  "nbase": len(bt), "nhead": len(ht), "rewrite_flags": sum(1 for r in rows if r[7].startswith("move then"))}
json.dump(summary, open("summary.json","w"), default=list); print(summary)
