import json, subprocess, sys, collections
repo, base, head = sys.argv[1:4]
f = json.load(open("final.json")); t = json.load(open("trace.json"))
TRIV = {"", "}", "{", "};", ")", "});", "*/", "/**", "*", "]", "],", "},", "})", "```", "---"}
def lines(rev, p):
    b = subprocess.run(["git","-C",repo,"show",f"{rev}:{p}"],capture_output=True).stdout
    if b"\0" in b[:8000]: return None
    c = collections.Counter(l.strip() for l in b.decode("utf-8","replace").splitlines())
    for x in TRIV: c.pop(x, None)
    return c
for r in f["rows"]:
    if not r[1]: r += ["", ""]; continue
    a, b = lines(base, r[0]), lines(head, r[1])
    if a is None or b is None: r += ["bin", "bin"]; continue
    s = sum((a & b).values())
    r += [round(100*s/max(1,sum(a.values()))), round(100*s/max(1,sum(b.values())))]
    # min per-commit score along the chain
    sc = [int(e[3][1:]) for e in t["hist"].get(r[0], []) if e[0]=="R"]
    r.append(min(sc) if sc else None)
json.dump(f, open("final2.json","w"))
low = sorted([r for r in f["rows"] if r[1] and r[3] != "bin"], key=lambda r: min(r[3], r[4]))
for r in low[:45]: print(r)
