#!/usr/bin/env python3
"""D0 exploratory harness (NOT the product runner).

Applies the Control Store bundles of tree T (read only) to a database of the throwaway container d0-pg in
dependsOn order, each up.sql in ONE transaction as exdb_migrate with search_path = pg_catalog (the projection
the product runner uses), then runs every `-- check:` statement of a bundle's verify.sql the way verify.ts does
(READ ONLY transaction, search_path pg_catalog, always rolled back; a check passes when it returns >= 1 row,
has a boolean column `ok` and every ok is true).

usage: apply_bundles.py DB up   [--until ID] [--from-after ID]   apply pending bundles
       apply_bundles.py DB verify [IDS...]                       verify the named (or all) bundles
"""
import os, re, subprocess, sys

T = "/home/david/Development/ExponetDB-verify/packages/control-store/migrations"
CONT = "d0-pg"


def bundles():
    out = {}
    for d in sorted(os.listdir(T)):
        p = os.path.join(T, d)
        if not os.path.isdir(p):
            continue
        y = open(os.path.join(p, "migration.yaml")).read()
        bid = re.search(r"^id:\s*(\S+)", y, re.M).group(1)
        deps = []
        m = re.search(r"^dependsOn:\n((?:\s+- \S+\n)+)", y, re.M)
        if m:
            deps = re.findall(r"- (\S+)", m.group(1))
        out[bid] = {"dir": p, "name": d.split("_", 1)[1], "deps": deps}
    return out


def topo(b):
    done, order = set(), []
    def visit(i):
        if i in done:
            return
        for d in b[i]["deps"]:
            visit(d)
        done.add(i)
        order.append(i)
    for i in sorted(b):
        visit(i)
    return order


def psql(db, role, sql, tuples=False):
    args = ["docker", "exec", "-i", CONT, "psql", "-U", role, "-d", db, "-v", "ON_ERROR_STOP=1", "-q"]
    args += ["-tA", "-F", "|"] if tuples else []
    r = subprocess.run(args, input=sql, capture_output=True, text=True)
    return r.returncode, r.stdout, r.stderr


def apply(db, ids, b):
    for i in ids:
        up = open(os.path.join(b[i]["dir"], "up.sql")).read()
        sql = "BEGIN;\nSET LOCAL search_path = pg_catalog;\n" + up + "\nCOMMIT;\n"
        rc, out, err = psql(db, "exdb_migrate", sql)
        print(f"apply {i} {b[i]['name']}: {'OK' if rc == 0 else 'FAILED'}")
        if rc != 0:
            print(err.strip()[:600])
            sys.exit(1)


def verify(db, ids, b):
    bad = 0
    for i in ids:
        v = open(os.path.join(b[i]["dir"], "verify.sql")).read()
        parts = re.split(r"^[ \t]*--[ \t]*check:[ \t]*(.+?)[ \t]*$", v, flags=re.M)
        # parts = [pre, name1, body1, name2, body2, ...]
        for k in range(1, len(parts), 2):
            name, body = parts[k], parts[k + 1].strip()
            sql = "BEGIN READ ONLY;\nSET LOCAL search_path = pg_catalog;\n" + body + "\nROLLBACK;\n"
            rc, out, err = psql(db, "exdb_migrate", sql, tuples=True)
            rows = [l for l in out.splitlines() if l not in ("", "BEGIN", "SET", "ROLLBACK")]
            ok = rc == 0 and len(rows) >= 1 and all(r.split("|")[0] == "t" for r in rows)
            if not ok:
                bad += 1
                print(f"  CHECK FAIL {i} {b[i]['name']}: {name} rc={rc} rows={rows} {err.strip()[:300]}")
    print(f"verify: {len(ids)} bundles, failing checks: {bad}")
    return bad


if __name__ == "__main__":
    db, cmd = sys.argv[1], sys.argv[2]
    b = bundles()
    order = topo(b)
    args = sys.argv[3:]
    if cmd == "up":
        until = args[args.index("--until") + 1] if "--until" in args else None
        after = args[args.index("--from-after") + 1] if "--from-after" in args else None
        ids = order
        if after:
            ids = order[order.index(after) + 1:]
        if until:
            ids = [i for i in ids if order.index(i) <= order.index(until)]
        apply(db, ids, b)
    elif cmd == "verify":
        ids = [a for a in args] or order
        sys.exit(1 if verify(db, ids, b) else 0)
    elif cmd == "order":
        for i in order:
            print(i, b[i]["name"])
