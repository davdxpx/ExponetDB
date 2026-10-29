#!/usr/bin/env python3
"""S4: pivot $L4/hits.tsv (+ canary-ids.json) into the canary x sink table (ids and counts only)."""
import collections, json, os, re, sys
L4 = os.environ.get("L4", "/srv/work/logs-s4"); S4 = os.environ.get("S4", "/srv/work/s4")
round_ = sys.argv[1] if len(sys.argv) > 1 else "r3"
ids = json.load(open(f"{S4}/canary-ids.json"))
SINKS = [
 ("journal (all units, json)", r"journal-"), ("/var/log /tmp /home /run /var/crash", r"var-log"), ("kit logs (S1)", r"kit-logs"),
 ("ps, /proc cmdline+environ (non-root)", r"(ps-args|proc-cmdline-nobody|proc-environ-nobody)"), ("/proc environ (root, info)", r"proc-environ-root"),
 ("docker inspect+logs", r"docker-"), ("Control Store pg_dumpall", r"control-store-pg_dumpall"), ("Control Store raw data dir", r"control-store-raw"),
 ("audit export dir", r"audit-export"), ("node state + helper ledger", r"node-agent-state"), ("target PG logs", r"target-pg-logs"),
 ("target pg_stat_*", r"target-pg\d+-"), ("/etc (not planted files)", r"etc\("), ("bundles + build", r"project-bundles"),
 ("API/CLI/MCP/SPA responses", r"api-cli-responses"),
]
def group(cid):
    c = re.sub(r"@[0-9a-f]{4}$", "", cid)
    for pat, name in [
        (r"^C1-role-password$", "C1 role password (verifier set)"), (r"^C1-verifier$", "C1 SCRAM verifier (full)"), (r"^C1-verifier-", "C1 verifier parts (StoredKey, ServerKey, salt)"),
        (r"^C2-migrator", "C2 target credential, migrator (URL-special chars)"), (r"^C2-reader", "C2 target credential, reader"), (r"^C2-wrong", "C2 wrong password (positive control logged by me)"),
        (r"^C2-tls", "C2 TLS-cluster password (not used)"), (r"^C3-ssl", "C3 host: ssl_passphrase_command"), (r"^C3-archive", "C3 host: archive_command"),
        (r"^C3-primary", "C3 host: primary_conninfo password"), (r"^C3-hba", "C3 host: pg_hba ldapbindpasswd"), (r"^C3-pgbackrest", "C3 host: pgBackRest cipher pass"),
        (r"^C3-restic", "C3 host: restic password file"), (r"^C6", "C6 SQL literal in a bundle (expected in bundle/plan content)"), (r"^C7", "C7 row value in a target table"),
        (r"^N-token-service-account|^N-token-revoked", "C4 API key secret (live and revoked)"), (r"^N-cli-|^N-token-", "C5 OAuth access+refresh tokens (CLI sessions, bearer files)"),
        (r"^N-web-", "C5 Web session cookie + CSRF token"), (r"^N-human-", "owner/person password, TOTP secret, passkey key, recovery codes"),
        (r"^N-controlstore-|^N-env-", "Control Store logins (roles + superuser)"), (r"^N-keyring", "keyring master key material"), (r"^N-nodekey", "node agent seeds (signing, encryption, TLS)"),
        (r"^N-key-", "TLS/CA private keys"), (r"^N-pgrole-", "ExponetDB role passwords on the targets (state/pgroles)")]:
        if re.search(pat, c): return name
    return c
rows = collections.defaultdict(lambda: collections.Counter()); n_ids = collections.Counter()
for cid in ids: n_ids[group(cid)] += 1
for line in open(f"{L4}/hits.tsv"):
    sink, f, cid, form, n = line.rstrip("\n").split("\t")
    if not sink.startswith(round_ + ":"): continue
    s = sink.split(":", 1)[1]
    for name, pat in SINKS:
        if re.search(pat, s): rows[group(cid)][name] += int(n); break
print("| canary (ids in group) | " + " | ".join(n for n, _ in SINKS) + " |")
print("|---|" + "---:|" * len(SINKS))
for g in sorted(n_ids):
    print(f"| {g} ({n_ids[g]}) | " + " | ".join(str(rows[g].get(n, 0)) for n, _ in SINKS) + " |")
