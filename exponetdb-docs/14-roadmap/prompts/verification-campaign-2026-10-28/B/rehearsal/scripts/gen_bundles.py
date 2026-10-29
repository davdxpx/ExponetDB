#!/usr/bin/env python3
"""Generates N independent-looking bundles in a project directory with a chosen DAG shape.
usage: gen_bundles.py PROJECT_DIR KIND N     KIND = chain | fanout | diamond
chain: each depends on the previous; fanout: all depend on one root; diamond: root -> 4 branches -> join -> 4 branches ... (5 nodes per diamond).
Every bundle creates one small table, so the whole set is plannable and appliable on an empty database."""
import os, random, shutil, sys
d, kind, n = sys.argv[1], sys.argv[2], int(sys.argv[3])
rnd = random.Random(7)
ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'
def ulid(i):
    # 48-bit time part counts up (identity never encodes order, but the ids must be unique and well formed); 80 random bits
    t = 0x01A000000000 + i
    chars = ''
    for _ in range(10):
        chars = ALPHA[t % 32] + chars; t //= 32
    return '0' + chars[1:] + ''.join(rnd.choice(ALPHA) for _ in range(16))
ids = [ulid(i) for i in range(n)]
deps = {}
for i in range(n):
    if kind == 'chain': deps[i] = [i - 1] if i else []
    elif kind == 'fanout': deps[i] = [0] if i else []
    elif kind == 'diamond':
        pos = i % 5; base = i - pos
        if i == 0: deps[i] = []
        elif pos == 0: deps[i] = [base - 4, base - 3, base - 2, base - 1]   # join of the previous diamond's branches
        else: deps[i] = [base]                                              # branch of this diamond's join
    else: raise SystemExit('kind')
m = os.path.join(d, 'migrations')
shutil.rmtree(m, ignore_errors=True); os.makedirs(m)
for i in range(n):
    name = f'scale-{kind}-{i:04d}'
    bd = os.path.join(m, f'{ids[i]}_{name}'); os.makedirs(bd)
    dep = ''.join(f'  - {ids[j]}\n' for j in deps[i]) if deps[i] else ''
    open(os.path.join(bd, 'migration.yaml'), 'w').write(
        f"schema: exponetdb.migration/v1\nid: {ids[i]}\nname: {name}\ndescription: |\n  scale test bundle {i}\n"
        + (f"dependsOn:\n{dep}" if dep else "dependsOn: []\n")
        + "execution:\n  transactional: true\ncompatibility:\n  declared: additive\nverification:\n  expectations: auto\n  runtimeChecks: verify.sql\n")
    open(os.path.join(bd, 'up.sql'), 'w').write(f'CREATE TABLE public.sc_{kind}_{i:04d} (id integer PRIMARY KEY, note text);\n')
    open(os.path.join(bd, 'verify.sql'), 'w').write(f"-- check: the table exists\nSELECT to_regclass('public.sc_{kind}_{i:04d}') IS NOT NULL AS ok;\n")
print(f'{n} bundles ({kind}) in {m}')
