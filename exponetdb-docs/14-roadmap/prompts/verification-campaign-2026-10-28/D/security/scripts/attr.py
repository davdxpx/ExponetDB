#!/usr/bin/env python3
"""S4: attribute `grep -aoF -f patterns.txt` output to canary ids. Prints only counts, ids and forms (never a value).
  <sink producer> | grep -aoF -f $S4/patterns.txt | attr.py SINK            (stream mode)
  grep -raoF --null -f $S4/patterns.txt DIR | attr.py SINK --files           (file mode: 'file\\0match' per line)
Appends 'sink<TAB>file<TAB>id<TAB>form<TAB>count' to $L4/hits.tsv and prints a one-line summary."""
import collections, os, sys

S4 = os.environ.get("S4", "/srv/work/s4")
L4 = os.environ.get("L4", "/srv/work/logs-s4")
sink = sys.argv[1]
files = "--files" in sys.argv
pats = {}
for line in open(f"{S4}/patterns.tsv", encoding="utf-8"):
    cid, form, p = line.rstrip("\n").split("\t", 2)
    pats[p.encode()] = (cid, form)
counts = collections.Counter()
for raw in sys.stdin.buffer:
    raw = raw.rstrip(b"\n")
    if files:
        f, _, m = raw.partition(b"\0")
        f = f.decode("utf-8", "replace")
    else:
        f, m = "-", raw
    hit = pats.get(m)
    if hit is None:  # grep -o prints the matched pattern itself; an overlap that is not a pattern is skipped
        continue
    counts[(f, hit[0], hit[1])] += 1
with open(f"{L4}/hits.tsv", "a") as out:
    for (f, cid, form), n in sorted(counts.items()):
        out.write(f"{sink}\t{f}\t{cid}\t{form}\t{n}\n")
ids = sorted({k[1] for k in counts})
print(f"SINK {sink}: hits={sum(counts.values())} canaries={len(ids)} {ids[:12]}")
