#!/usr/bin/env python3
"""Trace every base path through per-commit -M events (no-merges, reverse topo) to its fate at head."""
import subprocess, sys, json
repo, base, head = sys.argv[1:4]
out = subprocess.run(["git","-C",repo,"log","--reverse","--topo-order","--no-merges","-M","--name-status",
                      "--format=@@%h\t%s", f"{base}..{head}"], capture_output=True, check=True).stdout.decode()
basefiles = set(subprocess.run(["git","-C",repo,"ls-tree","-r","--name-only",base],capture_output=True).stdout.decode().split("\n"))-{""}
cur = {p: p for p in basefiles}       # orig -> current path (None if deleted)
hist = {p: [] for p in basefiles}     # orig -> events
addhist = {}                          # path added on branch -> (commit, subject)
commit = None
for line in out.splitlines():
    if line.startswith("@@"):
        h, s = line[2:].split("\t", 1); commit = (h, s); continue
    if not line.strip(): continue
    p = line.split("\t")
    st = p[0][0]
    if st == "R":
        o, n = p[1], p[2]
        hit = False
        for k, v in cur.items():
            if v == o: cur[k] = n; hist[k].append(("R", o, n, p[0], *commit)); hit = True
        if not hit:  # branch-added file being moved: carry its add history
            if o in addhist: addhist[n] = addhist[o] + [("R", o, n, *commit)]
    elif st == "D":
        o = p[1]; hit = False
        for k, v in cur.items():
            if v == o: cur[k] = None; hist[k].append(("D", o, *commit)); hit = True
        addhist.pop(o, None)
    elif st == "A":
        addhist[p[1]] = [("A", p[1], *commit)]
json.dump({"cur": cur, "hist": hist, "addhist": addhist}, sys.stdout)
