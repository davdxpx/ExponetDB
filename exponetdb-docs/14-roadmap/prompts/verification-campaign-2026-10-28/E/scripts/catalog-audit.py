#!/usr/bin/env python3
"""E1: audit of the error catalog against the docs table, the CLI exit mapping and the server sources.
Read only.  Usage: catalog-audit.py <tree>   (the tree under test, e.g. the checkout of d51da5d0)"""
import json, os, re, sys
T = sys.argv[1]
cat = json.load(open(os.path.join(T, 'packages/contracts/generated/catalog.json')))['errors']
codes = [x['code'] for x in cat]
doc = open(os.path.join(T, 'exponetdb-docs/02-control-plane/error-model.md'), encoding='utf-8').read()
doc_codes = set(re.findall(r'^\| `([A-Z][A-Z0-9_]+)` \|', doc, re.M))
print('catalog', len(codes), 'doc table', len(doc_codes), 'only-in-catalog', sorted(set(codes) - doc_codes), 'only-in-doc', sorted(doc_codes - set(codes)))
print('with remediation field', sum(1 for x in cat if x.get('remediation')))
exit_src = open(os.path.join(T, 'apps/cli/src/cli/exit.ts'), encoding='utf-8').read()
def setof(name):
    m = re.search(r'const ' + name + r' = new Set\(\[(.*?)\]\)', exit_src, re.S)
    return set(re.findall(r"'([A-Za-z_]+)'", m.group(1)))
AUTH, BLOCKED, UNAV, USAGE = (setof(n) for n in ('AUTH', 'BLOCKED', 'UNAVAILABLE', 'USAGE'))
mapped = [c for c in codes if c in AUTH | BLOCKED | UNAV | USAGE or c == 'OUTCOME_UNKNOWN']
print('codes with an exit mapping of their own', len(mapped), 'fall through to exit 1:', len(codes) - len(mapped))
files = []
for base in ['packages', 'apps/server/src']:
    for d, _, fs in os.walk(os.path.join(T, base)):
        if any(x in d for x in ('node_modules', '/dist', '/generated', '/test', 'packages/contracts', 'packages/ui', 'packages/sdk', 'packages/tokens', 'packages/icons', 'packages/testkit')):
            continue
        files += [os.path.join(d, f) for f in fs if f.endswith('.ts') and '.test.' not in f and not f.endswith('.d.ts')]
tok = re.compile(r'\b[A-Z][A-Z0-9_]{3,}\b')
seen = {c: 0 for c in codes}
for p in files:
    for m in set(tok.findall(open(p, encoding='utf-8').read())):
        if m in seen:
            seen[m] += 1
print('never named by a server-side source file:', sorted(c for c, n in seen.items() if n == 0))
meaning = {m.group(1): m.group(4) for m in re.finditer(r'^\| `([A-Z][A-Z0-9_]+)` \| ([^|]*) \| ([^|]*) \| (.*) \|\s*$', doc, re.M)}
remw = re.compile(r"(re-?plan|plan again|create a new|ask |run |use |add |fix |apply |wait|retry|re-?authenticat|resolve|restore|rotate|register|enable|change|decide|cancel|open |set |supply|check |tell |retire|unlock)", re.I)
norem = [x['code'] for x in cat if not x.get('remediation') and not remw.search(meaning.get(x['code'], ''))]
print('no remediation field and no remedy keyword in the documented meaning (heuristic, upper bound):', len(norem))
