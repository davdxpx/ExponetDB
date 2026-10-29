#!/usr/bin/env python3
"""Renders the CLI sweep (cases.tsv + raw outputs) as Markdown tables. Run on the server: python3 s7-sweep-render.py /srv/work/logs-s7/sweep"""
import json, os, re, sys
O = sys.argv[1]
ID = re.compile(r'\b(pln|op|tgt|nod|cls|bkr|fnd|req|idn|cli|stu)_[0-9A-Z]{26}\b|\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b')
HINT = re.compile(r'^\s*(Next:|Did you mean|Ask an administrator|Run |Try |Sign in|Create a new plan|See |Use |Check )|exponetdb [a-z]', re.I | re.M)
rows = []
for line in open(f'{O}/cases.tsv'):
    cid, want, rct, rcj, who, args = line.rstrip('\n').split('\t', 5)
    txt = open(f'{O}/{cid}.txt', errors='replace').read() if os.path.exists(f'{O}/{cid}.txt') else None
    js = None
    jf = f'{O}/{cid}.json'
    if os.path.exists(jf):
        try: js = json.loads(open(jf).read())
        except Exception: js = {'_unparsable': open(jf, errors='replace').read()[:80]}
    err = (js or {}).get('error') or {}
    code = err.get('code') or ('ok' if js and js.get('status') == 'ok' else ('?' if js is None else '-'))
    ids_in_details = bool(ID.search(json.dumps(err.get('details', {}) or {}))) or any(k in err for k in ('requestId',)) or bool(ID.search(json.dumps(err)))
    t_first = (txt or '').strip().splitlines()[0][:90] if txt and txt.strip() else ''
    t_hint = None if txt is None else bool(HINT.search('\n'.join((txt or '').splitlines()[1:])) or HINT.search(txt or '') and 'Error' in (txt or '')[:12] and len((txt or '').strip().splitlines()) > 1)
    is_err = (rct not in ('0', '-')) or (rcj not in ('0', '-'))
    rows.append(dict(id=cid, want=want, rct=rct, rcj=rcj, who=who, args=args, code=code, msg=bool(err.get('message')), rem=bool(err.get('remediation')), ids=ids_in_details,
                     nxt=bool(js and js.get('next')), t_hint=t_hint, t_first=t_first, is_err=is_err, errmsg=(err.get('message') or '')[:70], remtxt=(err.get('remediation') or '')[:70]))
def short(a):
    a = re.sub(r'(pln|op|tgt|nod|cls|bkr|fnd)_[0-9A-Z]{26}', r'\1_…', a); a = re.sub(r'\b[0-7][0-9A-HJKMNP-TV-Z]{25}\b', '<id>', a)
    return a[:70]
def rcfmt(r, want):
    if r == '-': return '-'
    return r if r == want else f'**{r}**'
print('| Case | Command | Who | Expected exit | Text exit | JSON exit | Text names a next step | JSON code | message | remedy | ids | `next` |')
print('|---|---|---|---|---|---|---|---|---|---|---|---|')
for r in rows:
    nx = '-' if r['t_hint'] is None else ('yes' if r['t_hint'] else ('no' if r['is_err'] else 'n/a'))
    print(f"| {r['id']} | `{short(r['args'])}` | {r['who']} | {r['want']} | {rcfmt(r['rct'], r['want'])} | {rcfmt(r['rcj'], r['want'])} | {nx} | {r['code']} | {'y' if r['msg'] else '-'} | {'y' if r['rem'] else ('-' if r['is_err'] else 'n/a')} | {'y' if r['ids'] else ('-' if r['is_err'] else 'n/a')} | {'y' if r['nxt'] else '-'} |")
errs = [r for r in rows if r['is_err']]
print()
print(f"cases: {len(rows)}; failing calls (non-zero exit in some mode): {len(errs)}")
print('wrong exit code (expected vs text/json):', [(r['id'], r['want'], r['rct'], r['rcj']) for r in rows if (r['rct'] not in ('-', r['want'])) or (r['rcj'] not in ('-', r['want']))])
print('text and JSON exit differ:', [(r['id'], r['rct'], r['rcj']) for r in rows if r['rct'] != '-' and r['rcj'] != '-' and r['rct'] != r['rcj']])
print('errors without remedy in JSON:', [(r['id'], r['code']) for r in errs if not r['rem'] and r['rcj'] not in ('-',)])
print('errors whose text names no next step:', [(r['id'], r['code']) for r in errs if r['t_hint'] is False])
print('errors whose JSON carries no id:', [(r['id'], r['code']) for r in errs if not r['ids'] and r['rcj'] not in ('-',)])
print('first lines of the text output of the failing calls:')
for r in errs: print(f"- {r['id']}: {r['t_first']}")
