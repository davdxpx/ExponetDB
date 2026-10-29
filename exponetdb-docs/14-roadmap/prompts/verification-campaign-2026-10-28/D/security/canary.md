# Canary secrets (Block D, tester S4)

Tree under test `d51da5d0` on the disposable stack of vc-3 (rebuilt by S1, 2026-10-29). **Result: no canary was found in
any sink that should not hold it. No P0.** Values are never printed or committed: the canary store is `$S4/planted.json`
and `$S4/patterns.tsv` (0600, on the server); everything below is ids and counts.

## What was planted and which flows ran

| Id | Canary | Planted through |
|---|---|---|
| C1 | a consumer role's password, its SCRAM verifier and the three parts of the verifier (StoredKey, ServerKey, salt) | `POST /clusters/{pg17}/role-verifiers` (write-only), plan, apply through the node (approved, succeeded; `pg_authid` holds the verifier, the role can log in) |
| C2 | the `migrator` password (with `@ : / % + & =` so that URL, JSON and base64 forms differ), the `reader` password, and a deliberately wrong password | `POST /clusters/{pg16}/credentials/{role}` (write-only submission), worker verified both (`active`); the wrong one went to the `verifier` role of pg18 (stays `pending`) and, at query time, as a stale stored credential |
| C3 | five node host secrets: `ssl_passphrase_command`, `archive_command` and `primary_conninfo` (password) in a `conf.d` file, `ldapbindpasswd` in `pg_hba.conf`, pgBackRest `repo1-cipher-pass` in `/etc/pgbackrest.conf` (plus a restic password file) | the host, then `node inspect` of config, hba, roles, status, tls, diagnostics; backup repository adoption (`pgbackrest` stanza `s4main`, encrypted), refresh, list, runs |
| C4 | the API key secret (live) and a second one that was revoked and then used | `POST /service-accounts/{id}/api-keys`, `POST /api-keys/{id}/revoke` |
| C5 | OAuth: access and refresh tokens of seven CLI sessions (owner, admin, developer x2, viewer, narrow grant, device flow), the MCP client's token, the Web App session cookie and CSRF token | loopback sign-in, device flow (RFC 8628), DCR + authorization code with PKCE, passkey sign-in |
| C6, C7 | a literal inside a migration's SQL, and a value in a row of a target table | `migration plan/apply/verify`, REST/MCP `sql_query` |
| N | the stack's own 119 secrets (owner password, TOTP secret, recovery codes, passkey key, role passwords of the targets, Control Store logins, keyring, node agent seeds, TLS/CA private keys; tokens accumulate across refreshes) | already there |

Flows that touched them: register/rotate (`credential.rotate` through the node on three roles of pg17), migration plan,
apply and re-verify on dev16, drift check, schema/health/session/query-stats/table-stats/advisors reads, `sql_query` and
`sql_explain` over REST and MCP, `plan show/export`, `audit list/export/chain`, `node show/observations/inspect`, every
read route of the REST API (D1's sample set, 108 requests per credential) as owner bearer, service-account API key,
viewer bearer and the owner's Web App cookie session, 23 MCP tools, `/metrics`, `/healthz/*` on the three internal
listeners, the SPA assets, and the failure paths: wrong password at query time (`TARGET_CREDENTIAL_INVALID`), target
unreachable (`TARGET_UNAVAILABLE`, port rejected), TLS failure (`TARGET_TLS_FAILED`, server stops offering TLS), a wrong
key, a malformed bearer and a revoked key (all `401 UNAUTHENTICATED`).

## Search

Forms searched for every value (753 patterns): raw, base64 at three alignments, base64url, hex, URL-encoded, JSON-escaped,
first 8 and last 8 characters (not for the verifier: its first 8 characters are the scheme name). Sinks (15): all journals
(json, every unit), `/var/log`, `/tmp`, `/root`, `/home`, `/run`, `/var/crash`, the stack's kit logs, `ps`, `/proc/*/cmdline`
and `/proc/*/environ` as an unprivileged user (and as root for information), `docker inspect`/`logs`, a complete
`pg_dumpall` of the Control Store (every schema: audit, plans, operations, events, findings, backup catalog,
idempotency keys, step-up rows, secrets) **and** the raw data directory of the Control Store (heap and WAL), the audit
export directory, the node agent's state directory, journal, buffer and the helper ledger, the PostgreSQL logs and
`pg_stat_activity` of the three targets (`pg_stat_statements` is not installed there), `/etc`, the project bundles and
the build, and every captured API, CLI, MCP and SPA response. Positive controls through the same pipeline: a canary in
text (raw, base64, hex, URL, last 8 detected), in a command line (`ps` and the unprivileged `/proc` scan detect it), in
an environment (only root sees it), in the journal. Scans: r1 and r2 (false positives removed, see below), r3 final.

## Result (round r3; `scripts/pivot.py`, counts of hits)

Zero in every cell except the ones below. Cells for unlisted canaries and sinks are 0.

| Canary | Sink | Hits | Verdict |
|---|---|---:|---|
| C6 (SQL literal) | Control Store dump / raw data / bundles | 1 / 2 / 1 | by design: a bundle's text is stored and planned |
| C7 (row value) | API/MCP responses | 6 | by design: the responses of the query itself (REST and MCP `sql_query`), and nowhere else (not in audit, plans, journals, dump) |
| C3 archive_command, primary_conninfo, ssl_passphrase_command | target PG log, syslog copy | 1 each | PostgreSQL itself logs `parameter "..." changed to "..."` when it reloads the file the operator wrote; ExponetDB does not write them. `ldapbindpasswd`, the pgBackRest cipher pass and the restic password: 0 hits anywhere |
| C2 wrong password | journal, syslog | 1, 2 | my own positive control (`logger`); 0 before and after |
| Control Store logins | `/proc/*/environ` (root only), container config of the Control Store (kit) | 3, 2 | `EXPONETDB_CONTROL_STORE_URL` and `EXPONETDB_KEYRING` are in the environment of the three services (systemd EnvironmentFile); unreadable by other users (verified); the kit's `docker run -e POSTGRES_PASSWORD` is the lab's, not the product's |
| keyring | `/proc/*/environ` (root only) | 3 | same |

C1 (password, verifier, parts), C2 (migrator, reader), C3 (hba, pgBackRest, restic), C4 (both API keys), C5 (all tokens,
cookie, CSRF), the owner's password/TOTP/recovery codes, the role passwords of the targets, the node seeds and every TLS/CA
private key: **0 hits in all 15 sinks**, in all forms. The host's `ldapbindpasswd` and the three secret parameters are
reported by the node as `{"withheld":"secret"}` (config: 9 values, hba: 1 secret and 1 unclassified), not as text.

False positives that were found and fixed in the scanner (kept so that nobody trusts a number without them): the first 8
characters of "SCRAM-SHA-256$..." (the scheme name), 8-character slices of the public RSA modulus taken from the private
key's first lines, a `sha256:` checksum prefix, and a key file matching itself.

## Not covered (NOT RUN, with the reason)

- A crash that writes a core or a heap snapshot: all product units run with core files disabled (`LimitCORE=0` for the
  node agent; the services use the default) and no dump exists; `/var/crash` (PostgreSQL 17 crash report of an earlier
  test) was scanned and clean. Provoking a crash of the three services was left to task 4's resource runs.
- A real browser's network panel: the Web App's calls were replayed with the same cookie session (all read routes of
  the sample set), not captured from a browser.
- `pg_stat_statements` on the targets (not installed): the statement text of the role-verifier `ALTER ROLE` therefore
  could not be looked for there; `pg_stat_activity` and the PostgreSQL logs (statement logging is off) were clean.
- Secrets that the product generates and never shows (the new password of `credential.rotate`) cannot be searched for
  by value; the sinks were checked for the old role passwords and for any `SCRAM-SHA-256$` string instead (none outside
  the target's catalog).

## Reproduce

`scripts/gen-canaries.py` (store and patterns), `scripts/plant1.sh`..`plant4.sh`, `p`-steps in the README, `scripts/scan-all.sh <round>`,
`scripts/attr.py`, `scripts/pivot.py`. Everything runs on the stack of vc-3 under `/srv/work/s4`; raw logs under
`/srv/work/logs-s4` (not committed).
