# D/security: dynamic security tests on the disposable stack (tester S4)

Tree under test `d51da5d0`. Server: `vc-3`, the stack S1 left there (real `serve`, `worker`, `gateway`, a Control Store, PG16, 17
and 18 targets, a node agent). Everything ran on `127.0.0.1`; nothing touched the live installation or another server. **No P0.**

| Task | File | Verdict |
|---|---|---|
| 1 Canary secrets | [`canary.md`](./canary.md) | 0 unexpected hits for about 136 canaries (17 planted, 119 of the stack's own) in 15 sinks and all search forms |
| 2 Authorization matrix, existence, step-up, approvals, replay | [`authz-run.md`](./authz-run.md) | 3,377 requests, no bypass; existence oracle wider than D1 found; step-up and approval attempts all refused; CLI unusable for environment-scoped people |
| 3 Agent safety | [`agent-safety-dynamic.md`](./agent-safety-dynamic.md) | catalog/row text is marked `untrusted` everywhere except the `-- check:` names of a plan; agent production apply waits for a person |
| 4 I14 containment | [`containment.md`](./containment.md) | 18 host-reaching bundles: nothing reached the host or another target; two inputs of under 1 MB cost 31 s of CPU and 620 MiB |
| 5 Network | [`network.md`](./network.md) | NOT RUN (see the file); target unreachable, TLS and credential failures observed |
| 6 I12/I13 promotion | [`promotion.md`](./promotion.md) | evidence rule and immutability hold on the cases run; forged evidence, alias swap NOT RUN |

Findings: `F/findings-S4.md` and `F/decisions-S4.md` (the harness refused a write there; the lead has the text from the final
message of this tester). Numbers: 4 P2 (one confirms D1's first P2 over HTTP) and 3 P3.

## Method in two lines

Canaries are random values kept in a 0600 file on the server and never printed; a scan reads every sink through
`grep -F -f patterns` and a mapper that prints ids and counts. Credentials are real: invited people with passkeys, CLI sign-ins,
an API key, a DCR/PKCE MCP client; D1's `run-matrix.ts` and `authz-matrix.json` supplied the expectations.

## State left on the stack (it is disposable)

Target pairs `s4evi`/`s4prd` and `s4cont`; people `admin`, `developer-nonprod`, `developer-prod`, `viewer`, a service account with
two API keys (one revoked), an MCP client; a backup repository adopted on pg17 (`s4main`, encrypted); host settings carrying
canaries in `/etc/postgresql/17/exdbnode/conf.d/50-s4-host-secrets.conf`, an extra `pg_hba.conf` line, `/etc/pgbackrest.conf`,
`/etc/restic-password`. Secrets, canary store and raw logs: `/srv/work/s4` and `/srv/work/logs-s4` (0700). A CLI session per person is
under `/srv/work/s4/cli/`. Services are up and ready; loopback rules and the clock are as found.

## Scripts (`scripts/`, run on the server, `s4env.sh` first)

| Purpose | Files |
|---|---|
| People and credentials | `ident.ts`, `consent.ts`, `scopes-for.ts`, `invite-people.sh`, `enroll-people.sh`, `cli-logins.sh`, `narrow-and-service-account.sh`, `mcp.ts`, `mcp-login.sh`, `apikey-revoke-device-flow.sh`, `s4env.sh` |
| Canary | `gen-canaries.py`, `scram.py`, `plant1.sh`..`plant4.sh`, `req.ts`, `sweep.ts`, `mcpsweep.sh`, `session-canary.ts`, `backup-adopt.sh`, `metrics-spa.sh`, `scan-all.sh`, `attr.py`, `pivot.py` |
| Authorization | `mkfixtures.sh`, `bodies.py`, `run-matrix-s4.ts` (D1's harness with one fix), `authz-run-reads.sh`, `authz-run-per-class.sh`, `authz-fixtures-mut.sh`, `authz-existence.sh`, `refine.py`, `probe.py`, `bigbody.py`, `bigbody-parallel.sh` |
| Step-up, approvals, promotion | `make-target-pair.sh`, `promo-pair-plans.sh`, `stepup-setup-plans.sh`, `stepup.sh`, `approvals4.sh`, `promotion.sh` |
| Agent safety | `inject-setup.sh`, `inject-mcp.sh`, `untrusted-check.py`, `agent-prod.sh` |
| Containment | `containment.sh`, `containment2.sh` |

No secret, canary value, token or e-mail address is in any file here; the people are invited with an address built from parts at
run time.

## Notes for the next tester

- Access tokens of the CLI and the MCP client live 10 minutes; refresh before each long run (`refresh_creds`).
- `pkill -f <script name>` over ssh kills your own ssh command (the name is in its command line).
- Most "allowed" results of D1's harness are 404/422 from fabricated ids or invalid samples; use `scripts/refine.py` before reading
  the table.
- The lab has no `exponetdb_operator` credential, so `connections.cancel/terminate` stop at `TARGET_CREDENTIAL_INVALID`.
- This tester's last turn was stopped by a safety classifier after the hostile-input cases of task 4; tasks 5 and the harder cases
  of task 6 were not started afterwards.
