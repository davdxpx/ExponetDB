# R2 notes: the lines that matter (full logs on vc-3, see logs-index.md)

Setup of the runs: `/srv/work/r2/new` at `d51da5d0`, `/srv/work/r2/old` at `d0229550`, `bun install --frozen-lockfile` in both,
Control Store PostgreSQL 17.11 and managed targets 16/17/18 in Docker (`tooling/dev/control-store.sh`, `targets.sh` images),
`TZ=UTC`, `NO_COLOR=1`. The fails-before procedure: `git -C old checkout -- .`, copy only the test files (and the test support they
need) from `new`, run, reset. GitHub CI at `d51da5d0` (run 40750567758) is green in all 18 jobs, including `Host scenario hba`,
`Node agent on PostgreSQL 16, 17, 18`, `Backup and restore lab`; R2 re-ran what its verdicts rely on.

## Acceptance (new tree)

| Suite | Result |
|---|---|
| contracts `test/errors.test.ts` | 15 passed |
| nodes `test/capability.test.ts` | 31 passed |
| policy `test/node-rules.test.ts` | 8 passed |
| postgres `test/migration-analysis.test.ts` + `test/admission.test.ts` | 649 passed |
| migrations-engine `test/legacy-files.test.ts` | 11 passed |
| backups `test/selection.test.ts` | 10 passed |
| cli `test/backups.test.ts` + `test/foundation.test.ts` | 119 passed |
| ui `test/sidebar.test.tsx` | 35 passed |
| web findings (2 files), `infrastructure/nodes.test.tsx`, `plans/plan-page.test.tsx` | 84 passed |
| application `test/views.test.ts` | 14 passed |
| diagnostics `data-read.int.test.ts` (PG 16, 17, 18) | 114 passed |
| diagnostics `performance.int.test.ts` | 21 passed |
| nodes `nodes.int.test.ts` | 11 passed |
| migrations-engine `recovery.int.test.ts` | 6 passed |
| migrations-engine `ledger-guard.int.test.ts` (16, 17, 18) | 30 passed |
| server `http-nodes.int.test.ts` + `node-operations.int.test.ts` | 19 passed |
| host `hba.host.test.ts` on vc-3 (real agent, systemd, PG17) | 3 passed |
| Go `internal/state` + `cmd/exponetdb-node` (TC-039, TC-042 tests) | ok |
| `bun run golden:check` | golden vectors intact (16 files, all locked) |

## Fails-before (the same files on `d0229550`)

| Test | Old result |
|---|---|
| data-read TC-014 (PG 16/17/18) | 3 fail: `expected 'pg_stat_activity' to contain 'schema'` |
| admission TC-014 | 3 fail: `expected 'pg_stat_activity' to be 'pg_stat_activity: write the schema, e.g. ...'` |
| contracts TC-015, TC-018 | fail: `expected false to be true`; `Cannot read properties of undefined (reading 'details')` |
| nodes `hbaLockOut` unit tests (TC-018) | 6 fail on a missing export (INCONCLUSIVE-IMPORT); host test below is the behavior-level proof |
| host `hba.host.test.ts` with the new test | fails: `expected [ 201, undefined ] to deeply equal [ 409, 'HBA_WOULD_LOCK_OUT' ]` |
| policy `node.lifecycle-reauth` (TC-019) | 2 fail (`expected 'allow' to be 'require'`; requirements `[]`) |
| http-nodes lifecycle, node-operations tier (TC-019) | fail: `expected [] to deep equally contain { kind: 'reauth', withinSeconds: 300 }`; `expected { targetId: null, ...} to match object { tier: 'nonprod' }` |
| nodes.int TC-016 | fail: `expected [] to deeply equal [ ObjectContaining{...}, ... ]` |
| performance.int TC-015 | fail: details absent |
| recovery.int TC-008/TC-022 | fail: `MigrationError: dependsOn names an id that is not in the project stream.` |
| migration-analysis growth test (TC-021) | fail: `expected 39.18461889895745 to be less than 8` (equality test: missing export) |
| legacy-files budget tests (TC-021) | fail: `expected undefined to be 'VALIDATION_FAILED'` |
| cli TC-015/022/030 (44 cases)/031/032/033 | fail (assertions on stdout, exit codes, `names no action that the CLI client kind is refused`) |
| ui sidebar TC-035 | fail: `expected [ <div data-side="right" ...> ] to have a length of +0 but got 1` |
| web findings pages x2, node heading (TC-036, TC-038) | fail on assertions |
| Go `TestOpenMissingDirectoryExplainsTheFix`, `TestEnrollMissingStateDirectoryExplainsFix`, `TestStatusSaysHowLongTheCertificateLasts` | fail: `the error lacks "does not exist"`, `status lacks "EXPIRED"` |
| backups `selection.test.ts`, `ledger-guard.int.test.ts` (TC-028) | pass on the old code (coverage additions); mutation checks fail the tests (below) |

## Reproductions on the new tree

- TC-016/E2 (host, real agent): `R2-E2 GET /nodes/{id} status 200 clusters [{"clusterId":"cls_...","localName":"17/exdbnode","running":true,"pendingRestart":false,"serverCertificateExpiresAt":null}]`; stored counts `hello_n 1, beat_n 0`. Old: `clusters []`.
- TC-048/E6 (host): `GET /enrollment-tokens`, `GET /enrollment-tokens/<token>`, `GET /servers/<server>/enrollment-tokens`, `DELETE`, `POST .../revoke`: all `404 NOT_FOUND`, old and new. Token row stays `issued`.
- E10/TC-053 (host, browser session): `reveal without a second step-up -> 200` right after the apply with one `reauth()`.
- TC-039/E1 (clean host, release builds): old `state directory: lstat /var/lib/exponetdb-node: no such file or directory` rc 1; new `state directory after tmpfiles: 700 exponetdb-node:exponetdb-node`, `enroll: the token is not valid (invalid_format)` (past the state directory); `--token-file /root/token` -> `open /root/token: permission denied`.
- TC-021 timing (same machine): new 20 ms / 144 ms / 399 ms / 2,294 ms for 100 / 1,000 / 5,000 / 20,000 files; old 134 ms / 5,928 ms / 290,317 ms (5,000 files).
- TC-023/024 (`tc-4`): E16 `NO-DETECTION` (findings `[]`, drift clean); E18 `NO-DETECTION` (`verifyPlan: NOT_FOUND`).
- TC-025 (`tc-1` (i)): `reverted_at_set_by_hand` apply -> `MIGRATION_DEPENDENCY_MISSING`; `fingerprint_after_tampered` apply -> `PLAN CREATED`; `i.hand_written_nontx_started_event` -> `MIGRATION_INCOMPLETE`, resume `NOT_FOUND`.
- TC-022 (`tc-1` j): `details: {migrationId: ..., missing: [ghost]}`.
- TC-034: `operation state after its plan expired and the worker ran: awaiting_approval nextAction "approve" approvalUrl present true`; `approve after expiry -> 200`; `operation state after the late approval: succeeded`.
- TC-020: `scopes nodes.read+nodes.plan: refused INSUFFICIENT_SCOPE`; with `nodes.operate:nonprod`: `withdrawn`.
- TC-017: `drift check: drifted 480 opened 480 open findings 480 {"object_added/critical":80,"object_added/warning":400}`.
- E4/TC-040: restApi v2 -> `exit 5 Error RESPONSE_INVALID: The server answered something this CLI cannot read as the contract.`; unknown node state -> exit 5; extra field on a node item -> exit 0.
- E9/TC-041: `lint` exit 1; `lint <path>`, `--bundle`, `--since`, `--only`, `--exclude-applied`: exit 2 `Unexpected argument` / `Unknown flag`.
- TC-019 neighbour (F1): `revoke plan with an escaped-NUL body stored: status 500` (new), `201` (old); a consumed NUL body, also among 20,000 analysed ones: `201`.
- TC-018 apply-time net (Go, real PG17): `TestHbaKeepsExponetDBsOwnAccess` PASS; with the agent's rule check disabled it FAILS (`the agent's own access was not protected: the previous pg_hba.conf was restored: the agent's own session is refused after the reload`); R2 test for `samehost reject` against a network access: `ExponetDB's access app_user@app from 10.1.0.5 would be lost: a rule before the match cannot be judged`, file restored.
- Mutation checks: selection `older` -> `verified[0]` fails 1 test; reversed `pitr` comparison fails 2; renaming `unitState` leaves untagged `go vet` at rc 0 and fails `go vet -tags pglab` (rc 1).
- CLI sweep: 136 `ok` (68 commands x 403/404) on the new tree, 94 on the old; violations on the new tree only `whoami` and `doctor` (local facts).

## Static checks for the not-started findings

- TC-027: no test in `apps/server/test/http-backups.int.test.ts`, `packages/backups/test/*` or `agent/node/internal/helper/*_test.go` names a restic/pg_dump verify refusal, the runbook permission denial, a stale WAL end, a moved target, another repository's runbook digest or the `noWorkers` gate (grep).
- TC-044: `git diff --stat d0229550 d51da5d0` is empty for `agent/node/internal/{agent,capabilities,verify,helperclient}`.
- TC-047: `plans.ts:213` still `throw new BackupError('CAPABILITY_UNAVAILABLE')` for `to === 'owned'`.
