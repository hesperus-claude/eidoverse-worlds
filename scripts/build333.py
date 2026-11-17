#!/usr/bin/env python3
"""Combine per-commit history (trace.json), end-to-end git -M and content pairs (map.json) into one manifest."""
import json, subprocess, sys, collections
repo, base, head = sys.argv[1:4]
t = json.load(open("trace.json")); m = json.load(open("map.json"))
def git(*a): return subprocess.run(["git","-C",repo,*a],capture_output=True,check=True).stdout
def tree(rev):
    out = {}
    for l in git("ls-tree","-r",rev).decode().splitlines():
        meta, p = l.split("\t",1); out[p] = meta.split()[2]
    return out
bt, ht = tree(base), tree(head)
gitR = {o:(n,s) for o,n,s in m["R"]}
simP = {c[3]:(c[4],c[0],c[1]) for c in m["pairs"]}
rows = []   # (status, old, new, evidence, note)
for o in sorted(set(bt) - set(ht) | {p for p in bt if p in gitR}):
    pass
olds = sorted(p for p in bt if p not in ht or p in gitR)
for o in olds:
    hcur = t["cur"].get(o); hev = t["hist"].get(o, [])
    nonmerge_final = hev[-1] if hev else None
    if hev and hcur is not None and hcur in ht:
        new, ev = hcur, "history:" + ",".join(e[4] if e[0]=="R" else e[2] for e in hev)
    elif hev and hcur is None:
        d = [e for e in hev if e[0]=="D"][-1]
        new, ev = None, f"history:deleted in {d[2]}"
    elif o in gitR:
        new, ev = gitR[o][0], f"git-M:R{gitR[o][1]:03d} (moved in merge resolution or end-to-end only)"
    elif o in simP:
        new, ev = simP[o][0], "content:%.2f/%.2f"%simP[o][1:]
    else:
        new, ev = None, "no rename event; absent at head"
    rows.append([o, new, ev])
claimed = collections.Counter(r[1] for r in rows if r[1])
dups = [k for k,v in claimed.items() if v>1]
# M paths: same path both sides; verify history didn't move them away
odd = [p for p in bt if p in ht and p not in gitR and t["cur"].get(p) not in (p,)]
moved = [r for r in rows if r[1]]
pure = [r for r in moved if bt[r[0]] == ht[r[1]]]
edited = [r for r in moved if bt[r[0]] != ht[r[1]]]
dels = [r for r in rows if not r[1]]
inplace = [p for p in bt if p in ht and p not in gitR]
mod_inplace = [p for p in inplace if bt[p] != ht[p]]
adds = sorted(p for p in ht if p not in bt and p not in claimed)
# a gitR destination may also exist at base as a path (e.g. replaced): treat as claimed; additions = head paths with no old
adds = sorted(p for p in ht if p not in claimed and p not in bt)
json.dump({"rows":rows,"dups":dups,"odd":odd,"pure":len(pure),"edited":len(edited),"dels":dels,
           "adds":adds,"mod_inplace":len(mod_inplace),"unchanged":len(inplace)-len(mod_inplace),
           "nbase":len(bt),"nhead":len(ht)}, sys.stdout, indent=0)
