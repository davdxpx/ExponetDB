#!/usr/bin/env python3
"""Write C/stack/README.md: the summary table (step | result) from .summary.json plus the static text below."""
import json, os, collections
OUT = '/home/david/Development/ExponetDB-verify-evidence/exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/C/stack'
summary = json.load(open(OUT + '/.summary.json'))
counts = collections.Counter(v for (_, _, v, _) in summary)
rows = []
for (name, n, verdict, first) in summary:
    rows.append(f'| {name} {n} | {verdict} | {first} |')
static = open(OUT + '/scripts/readme_static.md', encoding='utf-8').read()
tot = ', '.join(f'{k} {v}' for k, v in sorted(counts.items()))
body = static.replace('@@COUNTS@@', tot).replace('@@TABLE@@', '| step | result | in one line |\n|---|---|---|\n' + '\n'.join(rows))
open(OUT + '/README.md', 'w', encoding='utf-8').write(body)
print(tot)
