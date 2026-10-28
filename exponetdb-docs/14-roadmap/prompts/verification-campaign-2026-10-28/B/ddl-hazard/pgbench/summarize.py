#!/usr/bin/env python3
"""Window statistics from pgbench per-transaction logs (-l), appended to a CSV.

usage: summarize.py <log-dir> <t_base_start> <t_apply_start> <t_apply_end> <t_end> <app_timeout_ms>
                    [--meta key=value ...] [--csv results.csv]
All times are Unix epoch seconds. Prints one JSON object.

Log line: client_id transaction_no latency_us script_no epoch_s epoch_us_offset.
The end of a transaction is epoch_s + offset/1e6, its start is end - latency.
- baseline : transactions ending in [t_base_start, t_apply_start)
- during   : transactions that STARTED in [t_apply_start, t_apply_end] (stalled ones are
             included even when they finish after t_apply_end); tps_during counts the
             completions inside that window
- after    : transactions that started in (t_apply_end, t_end)
- failed_queries : transactions of the apply window slower than the application timeout
             (the bench sessions have no timeout of their own, so a stalled query is
             counted as one an application with that timeout would have failed) plus
             transactions pgbench itself marks as failed
- max_gap_s : longest time without any completed transaction inside the apply window
A line that cannot be parsed (the last, truncated one after SIGINT) is ignored.
"""
import csv, glob, json, math, os, sys

COLUMNS = [
    "pg_version", "rows", "clients", "scenario", "form", "steps", "apply_ok", "apply_error",
    "apply_seconds", "tps_baseline", "tps_during", "tps_after", "p50_base_ms", "p99_base_ms",
    "p50_during_ms", "p99_during_ms", "p99_after_ms", "max_during_ms", "over_1s", "failed_queries",
    "max_gap_s", "tx_during", "engine_lock_timeout_ms", "engine_statement_timeout_ms",
    "app_timeout_ms", "engine_expressible", "notes",
]

def pct(sorted_vals, q):
    if not sorted_vals:
        return None
    k = max(0, min(len(sorted_vals) - 1, math.ceil(q * len(sorted_vals)) - 1))
    return sorted_vals[k]

def ms(us):
    return None if us is None else round(us / 1000.0, 3)

def main():
    args = sys.argv[1:]
    meta, csv_path = {}, None
    if "--meta" in args:
        i = args.index("--meta")
        j = next((k for k in range(i + 1, len(args)) if args[k].startswith("--")), len(args))
        for kv in args[i + 1:j]:
            key, _, value = kv.partition("=")
            meta[key] = value
        del args[i:j]
    if "--csv" in args:
        i = args.index("--csv")
        csv_path = args[i + 1]
        del args[i:i + 2]
    log_dir = args[0]
    t0, ta, tb, t_end, timeout_ms = map(float, args[1:6])
    rows, failed = [], 0
    for path in glob.glob(f"{log_dir}/pgb.*"):
        with open(path, errors="replace") as fh:
            for line in fh:
                p = line.split()
                if len(p) < 6:
                    continue
                try:
                    lat = int(p[2])
                    end = float(p[4]) + int(p[5]) / 1e6
                except ValueError:
                    if len(p) > 2 and p[2] == "failed":
                        failed += 1
                    continue
                rows.append((end - lat / 1e6, end, lat))
    base = sorted(lat for s, e, lat in rows if t0 <= e < ta)
    during = sorted(lat for s, e, lat in rows if ta <= s <= tb)
    after = sorted(lat for s, e, lat in rows if tb < s < t_end)
    done_during = sorted(e for s, e, lat in rows if ta <= e <= tb)
    done_after = sum(1 for s, e, lat in rows if tb < e < t_end)
    gaps, prev = [], ta
    for e in done_during:
        gaps.append(e - prev)
        prev = e
    gaps.append(tb - prev)
    out = {
        "tps_baseline": round(len(base) / max(ta - t0, 1e-6), 1),
        "tps_during": round(len(done_during) / max(tb - ta, 1e-6), 1),
        "tps_after": round(done_after / max(t_end - tb, 1e-6), 1),
        "p50_base_ms": ms(pct(base, 0.50)), "p99_base_ms": ms(pct(base, 0.99)),
        "p50_during_ms": ms(pct(during, 0.50)), "p99_during_ms": ms(pct(during, 0.99)),
        "p99_after_ms": ms(pct(after, 0.99)),
        "max_during_ms": ms(during[-1] if during else None),
        "tx_during": len(during),
        "over_1s": sum(1 for v in during if v > 1_000_000),
        "failed_queries": sum(1 for v in during if v > timeout_ms * 1000) + failed,
        "max_gap_s": round(max(gaps), 3) if gaps else None,
    }
    print(json.dumps(out))
    if csv_path is not None:
        exists = os.path.exists(csv_path)
        with open(csv_path, "a", newline="") as fh:
            w = csv.DictWriter(fh, fieldnames=COLUMNS, extrasaction="ignore")
            if not exists:
                w.writeheader()
            w.writerow({**meta, **out})

main()
