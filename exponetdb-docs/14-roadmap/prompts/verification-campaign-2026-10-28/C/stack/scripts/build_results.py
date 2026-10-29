#!/usr/bin/env python3
"""Copy C1's four static files to C/stack/<name>-results.md and insert a 'Stack result' bullet under each numbered STACK STEP.
Usage: python3 build_results.py   (run from anywhere; paths are absolute below)."""
import re, sys, os
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from results_data import R

C = '/home/david/Development/ExponetDB-verify-evidence/exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/C'
OUT = C + '/stack'
NAMES = {'fail-closed': 'fail-closed', 'keys-certs-time': 'keys-certs-time', 'graceful-life': 'graceful-life', 'observability': 'observability'}
HEAD = ('> **Stack results (tester S6).** Each numbered STACK STEP below carries a "Stack result" bullet with the value observed on the disposable stack '
        '`vc-1` (commit under test `d51da5d0`), in the words CONFIRMED / REFUTED / PARTIAL / NOT RUN. C1\'s text is unchanged. Raw logs are on the server under '
        '`/srv/work/logs-s6` (index: `README.md` of this folder); scripts are in `scripts/`. Findings drawn from these results (S6-1 to S6-8) are in the final message of tester S6.\n\n')

summary = []
for name in NAMES:
    src = open(f'{C}/{name}.md', encoding='utf-8').read().split('\n')
    out = [src[0], '', HEAD.rstrip('\n'), ''] + src[1:] if src and src[0].startswith('#') else [HEAD] + src
    # locate the STACK STEPS section
    start = next((i for i, l in enumerate(out) if re.match(r'^##\s+\d+\.\s+STACK STEPS', l)), None)
    assert start is not None, name
    res = list(out[:start])
    i = start
    steps_seen = []
    while i < len(out):
        m = re.match(r'^(\d+)\.\s', out[i]) if i > start else None
        res.append(out[i])
        if m:
            n = int(m.group(1)); steps_seen.append(n)
            extra = []
            for key in (n, f'{n}b', f'{n}a'):
                if key in R[name]:
                    extra.append(R[name][key])
            if not extra:
                extra.append('**NOT RUN.** (no result recorded)')
            for e in extra:
                res.append('   - **Stack result:** ' + e)
                v = re.match(r'\*\*(CONFIRMED|REFUTED|PARTIAL|NOT RUN)', e)
                plain = e.replace('**', '').replace('`', '')
                first = plain.split('. ')[0]
                if len(first) < 40: first = plain[:150]
                summary.append((name, n, (v.group(1) if v else '?'), first[:170].replace('|', '/')))
        i += 1
    open(f'{OUT}/{name}-results.md', 'w', encoding='utf-8').write('\n'.join(res) + '\n')
    print(name, 'steps', steps_seen)
import json
json.dump(summary, open(f'{OUT}/.summary.json', 'w'))
