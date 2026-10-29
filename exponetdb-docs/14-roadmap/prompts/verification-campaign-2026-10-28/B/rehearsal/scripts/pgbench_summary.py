#!/usr/bin/env python3
"""p50/p99/max of pgbench -l logs, overall and per window. usage: pgbench_summary.py LOGPREFIX [START_EPOCH END_EPOCH]
Log columns: client tx latency_us script epoch_s epoch_us [schedule_lag_us]. Latency = tx latency + schedule lag when present."""
import glob, sys
rows = []
for f in glob.glob(sys.argv[1] + '*'):
    for line in open(f):
        p = line.split()
        if len(p) < 6: continue
        lat = int(p[2]) + (int(p[6]) if len(p) > 6 else 0)
        rows.append((int(p[4]) + int(p[5]) / 1e6, lat / 1000.0, p[2] == 'skipped'))
rows.sort()
def pct(v, q):
    v = sorted(v); return v[min(len(v) - 1, int(len(v) * q))] if v else float('nan')
def show(name, sel):
    v = [r[1] for r in sel]
    print(f"{name}: n={len(v)} p50={pct(v,.5):.1f}ms p95={pct(v,.95):.1f}ms p99={pct(v,.99):.1f}ms max={max(v) if v else float('nan'):.1f}ms")
show('all', rows)
if len(sys.argv) > 3:
    a, b = float(sys.argv[2]), float(sys.argv[3])
    show('before', [r for r in rows if r[0] < a]); show('during', [r for r in rows if a <= r[0] <= b]); show('after', [r for r in rows if r[0] > b])
    # worst second inside and 5 s around the window
    sec = {}
    for t, l, _ in rows:
        if a - 5 <= t <= b + 5: sec[int(t)] = max(sec.get(int(t), 0), l)
    print('max latency per second (window +-5 s, ms):', ' '.join(f"{k - int(a)}:{v:.0f}" for k, v in sorted(sec.items())))
