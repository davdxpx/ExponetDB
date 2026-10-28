
## 6. What could not be run, and why

"NOT RUN" is an answer only with its reason and what it would take. Rows come from the
lead and from every tester's "not checked" list.

| Item | Reason | What it would take |
|---|---|---|
| T-S3-1 to T-S3-8 (object lock on Hetzner Object Storage and Cloudflare R2: delete and overwrite refused, expiry with locks, versioning, restore from each bucket, costs) | needs disposable buckets with Object Lock created in the providers' consoles and writer-shaped credentials; outside the campaign's allowed resources (only Hetzner servers) | the owner creates the buckets (`W9-03` experiment plan) or authorizes bucket creation; about half a day; findings feed OD-4-storage |
| A passing drill through the Control Plane with a measured RTO, and the Control-Plane level `RESTORE_TARGET_MISMATCH`, `scratch_exists`, `PLAN_STALE`, `RESTORE_SOURCE_INVALID` refusals | blocked by the P1 drill defects (`latest`/`older` fail, `amcheck not_run` fails every drill); the backup run was also cut by a session restart | after the drill fixes: rerun the scenarios `zz-backup-e2e*.host.test.ts` in `D/backup-restore-e2e/host-tests/` on a disposable systemd host (about 90 min) |
| Wrong-passphrase test of the pgBackRest runbook, S3 repositories, the owner's real pgBackRest setup (T-ADV-1), T-RET-1 (retirement blocked by a live repository, end to end) | needs the owner's real repository (read-only adoption) or provider buckets; T-RET-1 needs a disposable server plus cluster with a live repository | owner provides read access or accepts a disposable equivalent |
| `mcp:evals` model layers B to D | needs `EXDB_EVAL_ANTHROPIC_API_KEY` of the owner (14 tests report NOT RUN) | the owner's key; about 20 min and token cost |
| Three real MCP clients (G7 criterion 13), OAuth sign-in in a real client | owner steps | owner test package section C |
| `apps/cli test:install`, `test:lab` and `apps/server test:lab`, Go bounded fuzzing, `govulncheck` | the lab and install suites need Node 24 plus Docker lab and an owner browser; govulncheck needs the vulnerability database | one more disposable server run (about 40 min); not done to stay within the box |
| Web App at 1440 and 390 px with screenshots | the owner's Chrome window was maximized, so `resize_window` had no effect; 1440/390 checks were DOM measurements in a script-driven popup | a Playwright run with the owner's passkey session, or a dedicated browser profile |
| Web states: `/approvals#operation=`, register submit paths, OAuth consent and device pages, invite/recover/setup, migrations timeline/promote/import views, the 1,000-row promotion case, "audit first page with cursor and no items", "cut role-binding list" | not reachable read-only or need mutations | seed a lab with those states |
| Cross-browser (Firefox, Safari), Lighthouse, reduced-motion on the live installation | out of the live read-only reach of the tooling used | Playwright matrix in CI |
| Live control-store read (`nodes.nodes.clusters` on the live node) | the read-only SSH `psql` was denied by the session's permission layer; not worked around | an owner-added permission rule, or an owner-run query |
| Live migration lifecycle on `reosa/platform/scratch` (plan, apply, failing verify, revision, drift, lock timeout, nontransactional, rollback) | planning fails on the live project with `MIGRATION_DEPENDENCY_UNKNOWN` (finding), and applying the 12 stored REOSA bundles would consume the owner's rehearsal state | fix the planner finding; then rerun on scratch; the failure cases ran at engine level against disposable PostgreSQL instead |
| Real PITR for E25, real break-glass for E16, HTTP/CLI layers and PostgreSQL 16/17 targets of the migration failure cases | simulated at engine level (the tester said so) | rerun on a lab with a real restore and a configured notification channel |
| Apply-time behavior of live node plans (hba lock-out revert, restart, TLS name check) | applying anything to the live node is forbidden; the disposable-host scenarios cover the apply-time hba refusal | n/a (by rule) |
| Node: pre-F7 agent binary for the downgrade claim, the lab gateway's own 72 h certificate (4d), a skewed gateway clock for `clockSkewMs`, the end of the reboot reconciliation of an in-flight restart | no such binary available; time-travel limits; the tester's time box | one more disposable host session (about 60 min) |
| Approve/reject/open, `cluster credential submit`, every effect `plan`/`mutation`/`session` CLI command on the live installation | forbidden by the campaign rules | n/a |
| Staging-side statistics (`pg_stat_statements` reset deltas) and the live `connections.cancel`/`terminate` | the extension is not installed on the live targets and node plans for it cannot be made from the CLI (findings) | after those fixes |
| CI result at `d0229550` | no network call to GitHub Actions was made | read the run of PR #43 |
