#!/usr/bin/env python3
"""old->new manifest base..head: git -M renames + content-similarity 1:1 pairing of leftover D/A."""
import subprocess, sys, json, collections
repo, base, head = sys.argv[1:4]
def git(*a, binary=False):
    r = subprocess.run(["git", "-C", repo, *a], capture_output=True, check=True)
    return r.stdout if binary else r.stdout.decode()
rows = []
for line in git("diff", "--name-status", "-M", base, head).splitlines():
    p = line.split("\t"); rows.append(p)
R = [(p[1], p[2], int(p[0][1:])) for p in rows if p[0].startswith("R")]
M = [p[1] for p in rows if p[0] == "M"]
D = [p[1] for p in rows if p[0] == "D"]
A = [p[1] for p in rows if p[0] == "A"]
TRIV = {"", "}", "{", "};", ")", "});", "*/", "/**", "*", "]", "],", "},", "})", "```", "---", "|---|---|", "<br>"}
def lines(rev, path):
    b = git("show", f"{rev}:{path}", binary=True)
    if b"\0" in b[:8000]: return None, b
    c = collections.Counter(l.strip() for l in b.decode("utf-8", "replace").splitlines())
    for t in TRIV: c.pop(t, None)
    return c, b
old = {p: lines(base, p) for p in D}
new = {p: lines(head, p) for p in A}
def shared(a, b): return sum((a & b).values())
cands = []
for d, (dc, db) in old.items():
    for a, (ac, ab) in new.items():
        if dc is None or ac is None:
            if db == ab: cands.append((1.0, 1.0, 10**9, d, a))
            continue
        s = shared(dc, ac)
        if not s: continue
        ok = s / max(1, sum(dc.values())); nf = s / max(1, sum(ac.values()))
        cands.append((ok, nf, s, d, a))
# greedy 1:1 on dice-like score; tie-break same basename
def key(c):
    ok, nf, s, d, a = c
    return (2*ok*nf/(ok+nf) if ok+nf else 0, d.rsplit("/",1)[-1] == a.rsplit("/",1)[-1], s)
cands.sort(key=key, reverse=True)
usedD, usedA, pairs = set(), set(), []
TH = float(sys.argv[4]) if len(sys.argv) > 4 else 0.3
for c in cands:
    ok, nf, s, d, a = c
    if d in usedD or a in usedA: continue
    if max(ok, nf) < TH: continue
    pairs.append(c); usedD.add(d); usedA.add(a)
json.dump({"R": R, "M": M, "pairs": pairs,
           "D": [d for d in D if d not in usedD], "A": [a for a in A if a not in usedA],
           "all_cands": [c for c in cands if c[3] not in usedD or c[4] not in usedA][:0]}, sys.stdout, indent=0)
