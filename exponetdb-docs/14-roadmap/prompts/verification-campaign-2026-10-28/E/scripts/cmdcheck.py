#!/usr/bin/env python3
"""Check every `exponetdb <cmd> ... --flag` mention in docs against the generated CLI reference
and the server one-shot commands. Read only. Usage: cmdcheck.py <docs-root> <file-or-dir>..."""
import re, sys, os, json

root = sys.argv[1]
ref = open(os.path.join(root, '15-cli/reference.md'), encoding='utf-8').read().split('\n')

cmds = {}   # tuple(path) -> set(flags)
cur = None
for line in ref:
    m = re.match(r'^### (.+)$', line)
    if m:
        cur = tuple(m.group(1).strip().split())
        cmds[cur] = set()
        continue
    if cur is not None:
        m = re.match(r'^\| `(--[a-z0-9-]+)', line)
        if m:
            cmds[cur].add(m.group(1))
        m = re.match(r'^\| `-([a-z])[`,]', line)
GLOBAL = {'--help', '--version', '--server', '--profile', '--workdir', '--output', '--json', '--color',
          '--no-color', '--no-input', '--yes', '--quiet', '--verbose', '--timeout', '-h', '-o', '-q', '-v'}
# server program (apps/server/src/commands/index.ts): first words
SERVER = {'serve', 'worker', 'gateway', 'control-store', 'keyring', 'audit', 'bootstrap', 'auth', 'node-pki',
          'version', 'healthcheck', 'help'}

out = []
def resolve(words):
    best = None
    for n in range(len(words), 0, -1):
        if tuple(words[:n]) in cmds:
            best = tuple(words[:n]); break
    return best

files = []
for p in sys.argv[2:]:
    p = os.path.join(root, p)
    if os.path.isdir(p):
        for d, _, fs in os.walk(p):
            for f in fs:
                if f.endswith('.md'):
                    files.append(os.path.join(d, f))
    else:
        files.append(p)

rx = re.compile(r'(?<![\w/.-])exponetdb((?: [^\s`|)]+)+)')
for f in sorted(files):
    lines = open(f, encoding='utf-8').read().split('\n')
    # join backslash continuations
    i = 0
    while i < len(lines):
        raw = lines[i]
        ln = i + 1
        text = raw
        while text.rstrip().endswith('\\') and i + 1 < len(lines):
            i += 1
            text = text.rstrip()[:-1] + ' ' + lines[i].strip()
        i += 1
        for m in rx.finditer(text):
            toks = m.group(1).split()
            words = []
            for t in toks:
                if t.startswith('-') or t.startswith('<') or t.startswith('[') or t.startswith('$') or t.startswith('"') or t.startswith("'") or t.startswith('(') or t.startswith('…') or re.match(r'^[A-Z_]+$', t):
                    break
                words.append(re.sub(r'[,.;:]+$', '', t))
            if not words or not re.match(r'^[a-z][a-z-]*$', words[0]):
                continue
            flags = [re.sub(r'[=,.;:)>].*$', '', t) for t in toks if t.startswith('-')]
            flags = [x for x in flags if re.match(r'^--?[a-zA-Z][\w-]*$', x)]
            path = resolve(words)
            rel = os.path.relpath(f, root)
            if path is None:
                if words[0] in SERVER:
                    out.append(('SERVER', rel, ln, ' '.join(words), ' '.join(flags)))
                else:
                    out.append(('UNKNOWN_COMMAND', rel, ln, ' '.join(words), ' '.join(flags)))
                continue
            bad = [x for x in flags if x not in cmds[path] and x not in GLOBAL]
            if bad:
                out.append(('UNKNOWN_FLAG', rel, ln, ' '.join(path), ' '.join(bad)))
            else:
                out.append(('OK', rel, ln, ' '.join(path), ' '.join(flags)))

json.dump(out, sys.stdout, indent=0)
