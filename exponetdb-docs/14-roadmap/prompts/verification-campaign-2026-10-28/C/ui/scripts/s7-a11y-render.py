#!/usr/bin/env python3
"""Renders $OUT/results.json of s7-web-a11y.mjs as Markdown tables (run on the server): python3 s7-a11y-render.py /srv/work/logs-s7/a11y/results.json"""
import json, sys, collections
d = json.load(open(sys.argv[1]))
R = d['results']
pages = list(dict.fromkeys(r['page'] for r in R))
print('### Load status and axe violations per page (union over 3 widths x 2 schemes; node counts are the maximum over the 6 combinations)\n')
print('| Page | final URL | h1 | 1440 L | 1440 D | 768 L | 768 D | 390 L | 390 D | rules (impact, max nodes) | overflow-x at 390 (px) | console errors |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for p in pages:
    rows = [r for r in R if r['page'] == p]
    cell = {}
    rules = collections.OrderedDict()
    for r in rows:
        key = (r['width'], r['scheme'])
        if 'error' in r: cell[key] = 'ERR'; continue
        v = r.get('axe', [])
        cell[key] = str(sum(x['nodes'] for x in v)) if v else '0'
        for x in v:
            cur = rules.get(x['id'], [x['impact'], 0]); cur[1] = max(cur[1], x['nodes']); rules[x['id']] = cur
    first = rows[0]
    ov = max([r.get('overflowX', 0) for r in rows if r['width'] == 390] or [0])
    ce = sum(len(r.get('consoleErrors', [])) for r in rows)
    def c(w, s): return cell.get((w, s), '-')
    print(f"| {p} | `{first.get('url','?')[:40]}` | {(first.get('h1') or '-')[:28]} | {c(1440,'light')} | {c(1440,'dark')} | {c(768,'light')} | {c(768,'dark')} | {c(390,'light')} | {c(390,'dark')} | {', '.join(f'{k} ({v[0]}, {v[1]})' for k, v in rules.items()) or '-'} | {ov} | {ce} |")
allrules = collections.Counter(); pagesby = collections.defaultdict(set)
for r in R:
    for x in r.get('axe', []):
        allrules[(x['id'], x['impact'], x['help'])] += 0; pagesby[x['id']].add(r['page'])
print('\n### Rules over all pages\n')
print('| Rule | Impact | What | Pages |')
print('|---|---|---|---|')
seen = {}
for r in R:
    for x in r.get('axe', []): seen[x['id']] = (x['impact'], x['help'], x.get('sample'))
for k, (imp, h, smp) in seen.items(): print(f"| {k} | {imp} | {h} | {len(pagesby[k])} of {len(pages)}: {', '.join(sorted(pagesby[k]))[:150]} |")
print('\nsample selectors: ' + '; '.join(f"{k}: `{v[2]}`" for k, v in seen.items()))
print('\n### Keyboard walk at 1440 light\n')
print('| Page | visible controls | Tab stops walked | focus indicator missing on | primary action | reached at Tab # | first stops |')
print('|---|---|---|---|---|---|---|')
for k in d['keyboard']:
    if 'error' in k: print(f"| {k['page']} | ERR {k['error'][:60]} | | | | | |"); continue
    first = ', '.join(f"{s.get('tag','')}:{(s.get('name') or '')[:14]}" for s in k['stops'][:6])
    print(f"| {k['page']} | {k.get('visibleControls')} | {k.get('tabStops')} | {k['focusInvisible']} | {k.get('primaryName','not reached')} | {k.get('primaryReachedAt')} | {first} |")
print('\n### Reduced motion\n')
print('| Preference | Page | animated elements | elements with a transition | longest animation (s) | `prefers-reduced-motion` rules in the style sheets |')
print('|---|---|---|---|---|---|')
for r in d['reduced']: print(f"| {r['mode']} | {r['page']} | {r['animated']} | {r['transitions']} | {r['longest']} | {r['reduceRules']} |")
print('\n### Pages with a different final URL than requested (redirects, 404 pages)\n')
for r in R:
    if r['width'] == 1440 and r['scheme'] == 'light' and (r.get('status') != 200 or r.get('url', '') != r['path']): print(f"- {r['page']}: requested `{r['path']}` -> `{r.get('url')}` status {r.get('status')} title {r.get('title')!r}")
