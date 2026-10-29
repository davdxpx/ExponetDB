#!/usr/bin/env python3
"""S4 canary store (runs on the disposable stack, never prints a value).

Planted canaries (random, created once, kept in $S4/planted.json, 0600) and "natural" canaries (the secrets the stack
itself holds: owner password / TOTP / recovery codes, CLI and API tokens, role passwords, Control Store logins, keyring,
private keys). For every value it writes the search forms (raw, base64 x3 alignments, base64url, hex, URL-encoded,
JSON-escaped, first 8 and last 8 characters) to $S4/patterns.tsv (id, form, pattern) and $S4/patterns.txt (patterns only),
both 0600, and the id list (kind, source, length; no value) to $S4/canary-ids.json.
Usage: gen-canaries.py            (re-run after new tokens were created; planted values are kept)
"""
import base64, glob, hashlib, hmac, json, os, re, secrets, string, sys, urllib.parse

S4 = os.environ.get("S4", "/srv/work/s4")
ST = os.environ.get("EXSTACK_STATE", "/srv/work/s1/state")
ALNUM = string.ascii_letters + string.digits


def rnd(n):
    return "".join(secrets.choice(ALNUM) for _ in range(n))


def write(path, text):
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as f:
        f.write(text)


# ---- planted --------------------------------------------------------------------------------------------------
pf = f"{S4}/planted.json"
if os.path.exists(pf):
    planted = json.load(open(pf))
    if "C7-row-value" not in planted:
        planted["C7-row-value"] = "Rw" + rnd(26)  # a value in a table row of a target: data, must stay out of audit/plans/logs
        write(pf, json.dumps(planted))
else:
    planted = {
        "C1-role-password": "Rp" + rnd(26),
        "C2-migrator-password": "Mg" + rnd(12) + "@:/%+&=" + rnd(6),  # URL-significant characters on purpose
        "C2-reader-password": "Rd" + rnd(26),
        "C2-wrong-password": "Wr" + rnd(26),
        "C2-tls-cluster-password": "Tl" + rnd(26),
        "C3-ssl-passphrase-command": "Sp" + rnd(26),
        "C3-archive-command": "Ac" + rnd(26),
        "C3-primary-conninfo": "Pc" + rnd(26),
        "C3-hba-ldapbindpasswd": "Ld" + rnd(26),
        "C3-pgbackrest-cipher-pass": "Pb" + rnd(26),
        "C3-restic-password": "Rs" + rnd(26),
        "C6-sql-literal": "Sq" + rnd(26),  # a literal in the SQL text of a bundle: expected in bundle/plan content only
        "C7-row-value": "Rw" + rnd(26),  # a value in a table row of a target: data, must stay out of audit/plans/logs
    }
    # the SCRAM verifier of the role password (the "verifier" canary: parts are searched, too)
    pw = planted["C1-role-password"].encode()
    salt = os.urandom(16)
    it = 4096
    salted = hashlib.pbkdf2_hmac("sha256", pw, salt, it)
    ck = hmac.new(salted, b"Client Key", "sha256").digest()
    stored = hashlib.sha256(ck).digest()
    server = hmac.new(salted, b"Server Key", "sha256").digest()
    b = lambda x: base64.b64encode(x).decode()
    planted["C1-verifier"] = f"SCRAM-SHA-256${it}:{b(salt)}${b(stored)}:{b(server)}"
    planted["C1-verifier-storedkey"] = b(stored)
    planted["C1-verifier-serverkey"] = b(server)
    planted["C1-verifier-salt"] = b(salt)
    write(pf, json.dumps(planted))

canaries = {}  # id -> (kind, source, value)
for k, v in planted.items():
    canaries[k] = ("planted", "planted.json", v)


# natural values are accumulated across runs (tokens rotate: an old refresh token that shows up later is still a leak)
seen_file = f"{S4}/natural-seen.json"
seen = json.load(open(seen_file)) if os.path.exists(seen_file) else {}


def add(cid, kind, source, value):
    if value and len(value) >= 12:
        cid = f"{cid}@{hashlib.sha1(value.encode()).hexdigest()[:4]}" if kind == "natural" else cid
        if cid not in canaries:
            canaries[cid] = (kind, source, value)
            if kind == "natural":
                seen[cid] = [source, value]


def pem_slice(text):
    lines = [l.strip() for l in text.splitlines() if l.strip() and not l.startswith("-----")]
    return lines[(len(lines) * 3) // 4] if len(lines) > 3 else (lines[-1] if lines else "")


def jwalk(prefix, node, out):
    if isinstance(node, dict):
        for k, v in node.items():
            jwalk(f"{prefix}.{k}", v, out)
    elif isinstance(node, list):
        for i, v in enumerate(node):
            jwalk(f"{prefix}[{i}]", v, out)
    elif isinstance(node, str):
        out.append((prefix, node))


# ---- natural -----------------------------------------------------------------------------------------------------
def load_json(p):
    try:
        return json.load(open(p))
    except Exception:
        return None


for p in [f"{ST}/owner.json"] + glob.glob(f"{S4}/humans/*.json"):
    j = load_json(p)
    if not j:
        continue
    tag = os.path.basename(p)[:-5]
    for key in ("password", "totpSecret", "privateKeyPkcs8"):
        add(f"N-human-{tag}-{key}", "natural", p, j.get(key, ""))
    for i, c in enumerate(j.get("recoveryCodes", [])[:4]):
        add(f"N-human-{tag}-recovery{i}", "natural", p, c)

for p in [f"{ST}/cli/credentials.json"] + glob.glob(f"{S4}/cli/*/credentials.json"):
    j = load_json(p)
    if not j:
        continue
    tag = "owner" if p.startswith(ST) else os.path.basename(os.path.dirname(p))
    for _, c in j.get("credentials", {}).items():
        add(f"N-cli-{tag}-access", "natural", p, c.get("accessToken", ""))
        add(f"N-cli-{tag}-refresh", "natural", p, c.get("refreshToken", ""))

for p in glob.glob(f"{S4}/creds/*.token"):
    add(f"N-token-{os.path.basename(p)[:-6]}", "natural", p, open(p).read().strip())

for p in glob.glob(f"{ST}/pgroles/*"):
    add(f"N-pgrole-{os.path.basename(p)}", "natural", p, open(p).read().strip())

try:
    for line in open(f"{ST}/control.cred"):
        m = re.match(r"^(exdb_\w+)=(.+)$", line.strip())
        if m:
            add(f"N-controlstore-{m.group(1)}", "natural", f"{ST}/control.cred", m.group(2))
except OSError:
    pass
add("N-controlstore-superuser", "natural", f"{ST}/control.superuser", open(f"{ST}/control.superuser").read().strip() if os.path.exists(f"{ST}/control.superuser") else "")

for p in glob.glob(f"{ST}/env/*.env"):
    for line in open(p):
        k, _, v = line.strip().partition("=")
        if k == "EXPONETDB_KEYRING":
            add(f"N-env-keyring-{os.path.basename(p)}", "natural", p, v)
        if k == "EXPONETDB_CONTROL_STORE_URL":
            m = re.match(r"^[a-z]+://[^:]+:([^@]+)@", v)
            if m:
                add(f"N-env-storeurl-pw-{os.path.basename(p)}", "natural", p, urllib.parse.unquote(m.group(1)))

kr = load_json(f"{ST}/keyring.json")
if kr:
    out = []
    jwalk("kr", kr, out)
    for i, (path, v) in enumerate(out):
        if len(v) >= 24 and not re.match(r"^(ins_|[a-z]+-v\d)", v):
            add(f"N-keyring-{i}", "natural", f"{ST}/keyring.json", v)

for p in glob.glob(f"{ST}/tls/*.key") + [f"{ST}/pki-root-key.pem"] + glob.glob("/etc/postgresql/*/exdbnode/server.key"):
    if os.path.exists(p):
        add(f"N-key-{p.replace('/', '_')}", "natural", p, pem_slice(open(p).read()))

nk = load_json("/var/lib/exponetdb-node/identity/keys.json")
if nk:
    out = []
    jwalk("nk", nk, out)
    for i, (path, v) in enumerate(out):
        if re.search(r"(Seed|Secret)$", path) and len(v) >= 40:
            add(f"N-nodekey-{i}", "natural", "/var/lib/exponetdb-node/identity/keys.json", pem_slice(v) if "BEGIN" in v else v)

for p in ("sessions.json",):
    j = load_json(f"{S4}/{p}")
    if j:
        for k, v in j.items():
            add(f"N-web-{k}", "natural", p, v)

for cid, (source, value) in seen.items():
    canaries.setdefault(cid, ("natural", source, value))
write(seen_file, json.dumps(seen))

# ---- forms -----------------------------------------------------------------------------------------------------------
def b64_forms(raw, url=False):
    out = set()
    enc = base64.urlsafe_b64encode if url else base64.b64encode
    for k, drop in ((0, 0), (1, 2), (2, 3)):
        e = enc(b"x" * k + raw).decode().rstrip("=")
        e = e[drop:-2] if len(e) - drop > 4 else ""
        if len(e) >= 10:
            out.add(e)
    return out


def forms(value):
    raw = value.encode()
    f = {"raw": {value}}
    f["b64"] = b64_forms(raw)
    f["b64url"] = b64_forms(raw, True) - f["b64"]
    f["hex"] = {raw.hex()}
    u = urllib.parse.quote(value, safe="")
    if u != value:
        f["urlenc"] = {u}
    j = json.dumps(value)[1:-1]
    if j != value:
        f["jsonesc"] = {j}
    body = re.sub(r"^[a-z]{2,6}_", "", value)
    if len(body) >= 16 and not value.startswith("SCRAM-SHA-256$"):
        f["first8"] = {body[:8]}
        f["last8"] = {body[-8:]}
    return f


rows, seen = [], set()
ids = {}
for cid, (kind, source, value) in sorted(canaries.items()):
    ids[cid] = {"kind": kind, "source": source.replace(S4, "$S4").replace(ST, "$STATE"), "length": len(value)}
    for form, pats in forms(value).items():
        for p in pats:
            if len(p) >= 8 and p not in seen and "\n" not in p:
                seen.add(p)
                rows.append((cid, form, p))
write(f"{S4}/patterns.tsv", "".join(f"{a}\t{b}\t{c}\n" for a, b, c in rows))
write(f"{S4}/patterns.txt", "".join(f"{c}\n" for _, _, c in rows))
write(f"{S4}/canary-ids.json", json.dumps(ids, indent=1))
print(json.dumps({"canaries": len(ids), "planted": sum(1 for v in ids.values() if v["kind"] == "planted"),
                  "natural": sum(1 for v in ids.values() if v["kind"] == "natural"), "patterns": len(rows)}))
