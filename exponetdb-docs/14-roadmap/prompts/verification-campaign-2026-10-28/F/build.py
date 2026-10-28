#!/usr/bin/env python3
"""Assembles the fix prompt from the findings parts (verification campaign 2026-10-28).

### [P1] Title' plus nine bullet fields),
numbers them TC-001.. in severity order (P0, P1, P2, P3; inside a severity by part
order), and writes ../2026-10-28-verification-fixes.md around the hand-written
front (F/front.md), not-run (F/notrun.md) and rules (F/rules.md) blocks.
"""
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
OUT = HERE.parent.parent / '2026-10-28-verification-fixes.md'
FIELDS = ['Area', 'Block', 'Reproduction', 'Expected', 'Actual', 'Evidence', 'Root cause', 'Proposed fix', 'Acceptance test']
SEV = ['P0', 'P1', 'P2', 'P3']
SEV_TEXT = {
    'P0': 'data loss, security, production outage',
    'P1': 'wrong result or blocked core flow',
    'P2': 'degraded, workaround exists',
    'P3': 'polish',
}


def parse(path: Path):
    text = path.read_text()
    entries = []
    for chunk in re.split(r'(?m)^### ', text):
        chunk = chunk.strip('\n')
        if not chunk:
            continue
        head, _, body = chunk.partition('\n')
        m = re.match(r'\[(P[0-3])\]\s+(.*)', head)
        if not m:
            print(f'WARN {path.name}: bad heading {head[:60]!r}', file=sys.stderr)
            continue
        fields = {}
        current = None
        for line in body.split('\n'):
            fm = re.match(r'- \*\*([A-Za-z ]+):\*\*\s?(.*)', line)
            if fm and fm.group(1) in FIELDS:
                current = fm.group(1)
                fields[current] = fm.group(2)
            elif current is not None:
                fields[current] += '\n' + line
        missing = [f for f in FIELDS if f not in fields]
        if missing:
            print(f'WARN {path.name}: {m.group(2)[:50]!r} lacks {missing}', file=sys.stderr)
        entries.append({'sev': m.group(1), 'title': m.group(2).strip(), 'fields': fields, 'file': path.name})
    return entries


def main():
    entries = []
    for p in sorted(HERE.glob('findings-*.md')):
        entries += parse(p)
    entries.sort(key=lambda e: SEV.index(e['sev']))  # stable: keeps part order inside a severity
    counts = {s: sum(1 for e in entries if e['sev'] == s) for s in SEV}
    for i, e in enumerate(entries, 1):
        e['id'] = f'VC-{i:03d}'
    front = (HERE / 'front.md').read_text()
    notrun = (HERE / 'notrun.md').read_text()
    rules = (HERE / 'rules.md').read_text()
    order = (HERE / 'order.md').read_text() if (HERE / 'order.md').exists() else ''
    blocks = {}
    for e in entries:
        b = (e['fields'].get('Block', '?').strip()[:1] or '?').upper()
        blocks.setdefault(b, {s: 0 for s in SEV})[e['sev']] += 1
    btable = ['| Block | P0 | P1 | P2 | P3 | Total |', '|---|---|---|---|---|---|']
    for b in sorted(blocks):
        row = blocks[b]
        btable.append(f"| {b} | {row['P0']} | {row['P1']} | {row['P2']} | {row['P3']} | {sum(row.values())} |")
    btable.append(f"| all | {counts['P0']} | {counts['P1']} | {counts['P2']} | {counts['P3']} | {len(entries)} |")
    out = [front.replace('{{COUNTS}}', ', '.join(f'{s} {counts[s]}' for s in SEV)).replace('{{TOTAL}}', str(len(entries))).replace('{{BLOCKTABLE}}', chr(10).join(btable))]
    out.append('\n## 3. Index of findings\n')
    out.append('| Id | Sev | Title | Block |')
    out.append('|---|---|---|---|')
    for e in entries:
        block = e['fields'].get('Block', '').split('\n')[0]
        out.append(f"| {e['id']} | {e['sev']} | {e['title']} | {block[:40]} |")
    out.append('\n## 4. Findings\n')
    out.append('Severity: ' + '; '.join(f'**{s}** {SEV_TEXT[s]}' for s in SEV) + '. P0 first. Evidence paths are relative to `exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/`.\n')
    for sev in SEV:
        group = [e for e in entries if e['sev'] == sev]
        out.append(f'### {sev} ({len(group)})\n')
        if not group:
            out.append('None found.\n')
        for e in group:
            out.append(f"#### {e['id']} [{sev}] {e['title']}\n")
            for f in FIELDS:
                v = e['fields'].get(f, '(missing)').strip('\n')
                out.append(f'- **{f}:** {v}')
            out.append('')
    out.append(order)
    out.append(notrun)
    out.append(rules)
    OUT.write_text('\n'.join(out))
    print(f'wrote {OUT} ({len(entries)} entries: {counts})')


main()
