# E1: documentation claims to check by running (`[DECIDED]` / `[OBSERVED]`)

Block E, item 4. 72 distinct claims: 45 from `exponetdb-docs/04-migrations/` (DC-001 to DC-045) and 27 from
`exponetdb-docs/12-operations/` (DC-046 to DC-072), a few of which rest on `02-control-plane/` and `15-cli/`. Chosen for what hurts at 3 a.m.:
recovery steps, upgrade and rollback of ExponetDB itself, command names and flags in runbooks, and the
promises of the migration engine. Tree `d51da5d0`; paths relative to `exponetdb-docs/` unless they start
with `apps/` or `packages/`.

**S** (stack needed to run the check): `none` = local files or a pure-code run; `PG` = a local PostgreSQL;
`stack` = a disposable full stack (Control Store, serve, worker, gateway, targets); `host` = a real systemd
host with a node agent; `live` = a read of the live installation (no side effect).

**Verdict now** (what E1 could settle without the stack): `HOLDS`, `VIOLATED`, `UNCLEAR`, each with the
kind of evidence: **ran** (I executed it), **static** (read from code with file:line, not executed). A
`static` verdict is a lead, not a reproduction; the "How to check" column is what must be run to close it.
Column `result` is left empty for the runners.

Runs behind the `ran` verdicts: the CLI and the `@exponetdb/migrations` format functions executed from a
copy of the tree with `bun install --ignore-scripts` (Bun 1.3.14, **not** the pinned 1.4.4; the functions
involved are pure and toolchain-free), `HOME` redirected into the scratchpad, no server, no network
beyond the package install. Commands: `exponetdb init|migration new|migration lint|migration checksum|migration graph`
in a throwaway project; two probe scripts (`verificationRetryable`, `isErrorCode`, `renderHuman`,
`ledgerStateHash`).

Scripts (re-runnable, read only): `E/scripts/cmdcheck.py <docs-root> <dirs…>` (command and flag existence), `E/scripts/catalog-audit.py <tree>` (error catalog statistics), `E/scripts/probe1.ts`…`probe4.ts` (replace `<TREE>` with a copy of the tree whose dependencies are installed; run with `bun --conditions=@exponetdb/source`).

The CLI-and-flag check of the runbooks (every `exponetdb ...` mention in `04-migrations`, `12-operations`,
`09-backups-and-restore`, `02-control-plane`, `08-auth-and-security`, `07-node-agent`) was automated:
**166 mentions: 120 resolve to a command of `15-cli/reference.md` with all flags present, 36 are server
one-shot commands (`control-store`, `keyring`, `audit`, `bootstrap`, `auth recover-owner`, `node-pki`) whose
subcommands and flags exist in `apps/server/src/commands/index.ts`, 10 do not exist or are wrapped lines**;
the real misses are DC-014, DC-068 and DC-069. 37 `EXPONETDB_*`/`EXDB_*` variables named in the same
documents: all found in code or `deploy/`, except `$EXPONETDB_TOKEN` (a shell variable in
`onboard-external-cluster.md:232`, DC-072).

## Migrations (`04-migrations/`)

| ID | file:line | Claim | How to check by running | S | Verdict now | result |
|---|---|---|---|---|---|---|
| DC-001 | 04-migrations/migration-bundles.md:75 | Unknown manifest keys are an error ("a typo such as `transactinal: false` cannot silently fall back") | `migration.yaml` with `transactinal: false`; `exponetdb migration lint` | none | **HOLDS (ran)**: `MIGRATION_MANIFEST_INVALID: /execution Unrecognized key: "transactinal"`, exit 1 | |
| DC-002 | 04-migrations/migration-bundles.md:67 | The ULID timestamp does not define order; `dependsOn` does | two bundles whose ULID order is the reverse of their `dependsOn`; `exponetdb migration graph` | none | UNCLEAR (static: `buildGraph` orders by edges, ids only break ties; not run) | |
| DC-003 | CLAUDE.md "Migration rules" / 04-migrations/migration-bundles.md (checksum) | Comment-only edits of `up.sql` are not drift (same apply checksum) | edit a comment and a trailing `-- x`; `exponetdb migration checksum` before and after | none | **HOLDS (ran)**: identical `sha256:c1:91e7f35d…` | |
| DC-004 | same | Any executable change after apply changes the checksum | add a column to `up.sql`; checksum | none | **HOLDS (ran)**: `sha256:c1:46b7d4f6…` differs | |
| DC-005 | 04-migrations/migration-bundles.md (id must match directory) | A bundle whose directory id differs from `migration.yaml` is refused | rename the directory to another ULID; `migration checksum --output json` | none | **HOLDS (ran)**: `MIGRATION_BUNDLE_INVALID: directory_mismatch (migration.yaml)` | |
| DC-006 | 04-migrations/authoring-and-ci.md:78 | `migration new` creates a manifest with `dependsOn` = the current heads | `migration new a`, `migration new b`; read `b/migration.yaml` | none | **HOLDS (ran)**: `dependsOn: [<id of a>]` | |
| DC-007 | 04-migrations/authoring-and-ci.md:80 | `migration checksum` prints apply checksum, verify digest, rollback digest, source digest | `migration checksum` and `--output json` | none | **VIOLATED (ran)**: the table prints the apply checksum only; JSON prints checksum, `verifyDigest`, `rollbackDigest`, `bundleDigest`, **no** source digest; `rollbackDigest` is non-null for a bundle without `down.sql` | |
| DC-008 | 04-migrations/authoring-and-ci.md (lint exit) + 15-cli/README.md:241 | `migration lint` exits 1 on a blocking finding | `migration lint; echo $?` with a failing bundle | none | **HOLDS (ran)**: exit 1, `MIGRATION_LINT_BLOCKED` | |
| DC-009 | 04-migrations/ledger.md:198 | An empty ledger without baseline hashes the single line `baseline -` LF | `ledgerStateHash([], null)` against `sha256("baseline -\n")` | none | **HOLDS (ran)**: `sha256:ls1:7e4afa32…06a2` equal | |
| DC-010 | 04-migrations/ledger.md:175 | `ls1` = SHA-256 of `id SP checksum SP A/R LF` lines sorted by id, then `baseline SP <id or ->` | two rows (one reverted) + baseline, recompute by hand | none | **HOLDS (ran)** | |
| DC-011 | 04-migrations/concurrency.md:55 | Advisory-lock key1 is 1163412546 (ASCII `EXDB`) | `SELECT classid FROM pg_locks WHERE locktype='advisory'` during an apply; `0x45584442` | PG | HOLDS (static: `packages/postgres/src/ledger.ts:19`, `control-store/src/locks.ts:12`; 0x45584442 = 1163412546) | |
| DC-012 | 04-migrations/concurrency.md:57 | key2 = int4(first 4 bytes big-endian of SHA-256("exponetdb/lock/v1/<class>/<targetId>")) | compare with `pg_locks.objid` while a migration runs | PG | HOLDS (static: `packages/postgres/src/ledger.ts:21-25`) | |
| DC-013 | 04-migrations/concurrency.md:88-89 | `[DECIDED]` the key derivation is published, including the CLI command `exponetdb lock-key <target>` | `exponetdb lock-key demo/platform/staging` | none | **VIOLATED (ran)**: not a command (178 in the registry); `authoring-and-ci.md:73` says "`lock-key` is not built" | |
| DC-014 | 04-migrations/concurrency.md:131 | A stuck lock is released with `operation.force_release(op_…)` by a human with `operations.recover` (Web App or CLI) | search the CLI, the Web App and the kind registry for the action | none | **VIOLATED (ran/static)**: registered in `contracts/src/actions.ts:1052`, no kind, no CLI command (`exponetdb commands`), no Web page; `operations/README.md:44`, `locks.ts:14` say there is none | |
| DC-015 | 04-migrations/concurrency.md:126 | Migrator sessions set keepalives 30/10/3 s so a dead worker's lock frees within about a minute | open a migrator session, `SHOW tcp_keepalives_idle`; kill the worker with `kill -9` during a statement; time until `pg_locks` is clear | PG | HOLDS (static: `packages/postgres/src/session.ts:245`) | |
| DC-016 | 04-migrations/concurrency.md:134 | The migrator never uses a pooler endpoint | register a cluster with only a pooler endpoint; plan a migration | stack | UNCLEAR (static: `registry/src/connect.ts:164` comment "never a session that writes") | |
| DC-017 | 04-migrations/planning-and-apply.md:20 | The plan is the only input to apply (`plan_apply` takes a plan id) | read the REST/MCP schema of `plan_apply`; try to pass SQL | none | HOLDS (static: MCP `plan_apply` input is `{ planId }` only, `packages/contracts/src/mcp/tools.ts:589`) | |
| DC-018 | 04-migrations/planning-and-apply.md:210 | A stale plan is invalidated at acceptance and refused with `PLAN_STALE` before any queueing | plan; change the schema by hand; apply | stack | HOLDS (static: `operations/src/accept.ts:111-135,171-174`) | |
| DC-019 | 04-migrations/planning-and-apply.md:200 | Planning never takes a lock on the target and never writes to it | `pg_stat_activity`/`pg_locks` and `pg_stat_database.xact_commit` deltas around `migration plan` | PG | UNCLEAR (static: observer session is `readOnly`) | |
| DC-020 | 04-migrations/planning-and-apply.md:438 | The migrator session sets `idle_in_transaction_session_timeout` = 120 s | in a migrator session `SHOW idle_in_transaction_session_timeout` | PG | **VIOLATED (static)**: `DEFAULT_LIMITS.idleInTransactionMs = 30_000` (`packages/postgres/src/session.ts:96-101`), no migrator override (`grep` over `migrations-engine`) | |
| DC-021 | 04-migrations/planning-and-apply.md:439 | `application_name` = `exponetdb/op_<id>` | `SELECT application_name FROM pg_stat_activity` during an apply | PG | HOLDS (static: `migrations-engine/src/kind.ts:308` passes the operation id as purpose; reconcile and plan sessions use `reconcile/op_…`, `plan/tgt_…`) | |
| DC-022 | 04-migrations/planning-and-apply.md:446 | `lock_timeout` default 5 s, above 60 s only with a lint acknowledgement | lint a bundle with `lockTimeout: 90s`; read the applied session's setting | none/PG | HOLDS (static: `migrations/src/format/projection.ts:24`, `lint/lint.ts:762`) | |
| DC-023 | 04-migrations/planning-and-apply.md:448 | The engine never retries a lock timeout automatically | cause `MIGRATION_LOCK_TIMEOUT` (hold a lock); count attempts in `pg_stat_activity`/events | PG | UNCLEAR (static: no retry loop found) | |
| DC-024 | 04-migrations/planning-and-apply.md:460-464 | `up.sql` is split by the parser, each statement is its own protocol message | log statements with `log_statement=all`; apply a 3-statement bundle | PG | HOLDS (static: `executor.ts:288,477,707` `executeReviewed` per statement) | |
| DC-025 | 04-migrations/planning-and-apply.md:417 | Without the cluster's verifier credential L2 is an `error` and the operation goes to `needs_attention` (never a pass) | apply on a target whose verifier credential is missing | stack | UNCLEAR (static: matches `driver.ts:400-406`); important because it makes `needs_attention` a routine state (see SM-1) | |
| DC-026 | 04-migrations/failure-and-recovery.md:21 (E4) | A retried plan returns the existing operation (`alreadyAccepted`) | `plan apply` twice with the same actor and client | stack | HOLDS (static: `accept.ts:157-164`) | |
| DC-027 | 04-migrations/failure-and-recovery.md:27 (E10) | A timed-out `verify.sql` leaves the operation `needs_attention` with the schema domain held; `operation retry-verification` re-runs only verification | block `verify.sql` with a lock; apply; wait; `operation retry-verification <op>` | stack | HOLDS for migration kinds (static: `views.ts:270-297`, `leases.ts:57`); fails for every other kind (SM-1, ran) | |
| DC-028 | 04-migrations/failure-and-recovery.md:33 (E16) | `[DECIDED]` a production hotfix leaves finding `hotfix_without_evidence` until staging catches up | break-glass hotfix on a production target; `finding list` | stack | **VIOLATED (static)**: 0 occurrences in code; waived at G6 (OD-65); and break-glass cannot be activated (OD-21) | |
| DC-029 | 04-migrations/failure-and-recovery.md:35 (E18) | Migration removed from source after apply → finding `applied_not_in_source` | apply, delete the bundle from the repository, `drift check` | stack | **VIOLATED (static)**: 0 occurrences; waived at G6 | |
| DC-030 | 04-migrations/failure-and-recovery.md:41 (E24) | A hand-edited target ledger blocks schema plans (`LEDGER_DIVERGENCE`) until `ledger.reconcile adopt_target` | `INSERT` a row into `exponetdb.schema_migrations`; `migration plan`; `migration ledger reconcile --note x` | stack | HOLDS (static: `divergence.ts`, `reconcile.ts`) | |
| DC-031 | 04-migrations/failure-and-recovery.md:42 (E25) | After a restore to an earlier point the operator plans `ledger.reconcile`; lost migrations show as pending with the same checksums | pg_dump/restore of a target to an earlier state; reconcile; re-plan | stack | UNCLEAR (needs the restore; `reconcile.int.test.ts` covers a simulated restore) | |
| DC-032 | 04-migrations/failure-and-recovery.md:44 (E27) | Grant revoked mid-operation: remaining migrations are not started (`GRANT_REVOKED` in their progress) | revoke the CLI grant during a 3-migration apply | stack | UNCLEAR | |
| DC-033 | 04-migrations/failure-and-recovery.md:62 | A partly applied non-transactional migration raises a blocking **finding** `nontransactional_migration_incomplete` | fail a `CREATE INDEX CONCURRENTLY`; `finding list` | stack | **VIOLATED in wording (static)**: no such finding; the effect is the planner refusal `MIGRATION_INCOMPLETE` (`planner.ts:610-614`) | |
| DC-034 | 04-migrations/failure-and-recovery.md:108 | A missing row of a started, unclosed non-transactional migration is never read as `not_applied`; operation → `needs_attention`; the resume plan closes it | kill the worker between two statements; observe | stack | HOLDS (static: `kind.ts:905-913`; closing via `supersedes`, `kind.ts:131`) | |
| DC-035 | 04-migrations/failure-and-recovery.md:141 | A rolled-back id can never be applied again on that target (`MIGRATION_REVERTED`) | roll back, then `migration apply` the same bundle | stack | HOLDS (static: `planner.ts:342`) | |
| DC-036 | 04-migrations/failure-and-recovery.md:161-162 | Rollback is refused with `dependents_applied`, `not_latest`, `no_down_sql` | three plans against a target in each state | stack | HOLDS (static: `rollback.ts:145,154,164`) | |
| DC-037 | 04-migrations/ledger.md:236 | A periodic reconciliation of target ledger vs mirror runs every 10 minutes per active target | watch the worker tasks; edit the ledger by hand and wait 10 minutes; look for a finding | stack | **VIOLATED (static)**: `apps/server/src/composition/worker-tasks.ts` has no ledger task (audit, plans, idempotency, auth, oauth, heartbeats, secrets, registry credentials, health, drift, statements, nodes); divergence is seen only when a plan is made. No finding is raised on divergence either (`ledger.md:~246`) | |
| DC-038 | 04-migrations/ledger.md:242 | `ledger.mirror_healed` audit event is "still not built" | grep audit actions | none | HOLDS (0 occurrences; the doc says so) | |
| DC-039 | 04-migrations/ledger.md:251 | `ledger.reconcile` `flag_untrusted` is refused as `not_built` (OD-59) | plan with `flag_untrusted` | stack | HOLDS (static) | |
| DC-040 | 04-migrations/ledger.md:146 | A trigger rejects any `UPDATE` of `schema_migrations` other than `reverted_at/reverted_by_op`, and re-setting them | as the migrator role `UPDATE exponetdb.schema_migrations SET name='x'` | PG | UNCLEAR (target bootstrap SQL not read) | |
| DC-041 | 04-migrations/verification.md:43 | A verification that is not `passed` never causes `up.sql` to run again | fail a verification, retry, count executions of `up.sql` | stack | HOLDS (static: `driver.ts` never calls `execute` twice) | |
| DC-042 | 04-migrations/verification.md:493 | `retry-verification`: "Only `migration.apply` and `migration.resume` operations whose change was applied qualify" | `operation retry-verification` on a `migration.baseline`/`migration.verify` operation | stack | **VIOLATED (docs vs docs, static)**: lines 498-500 and `operations-engine.md` §4.1 extend it to four kinds; code has four (`views.ts:270-275`) | |
| DC-043 | 04-migrations/staging-production-policy.md:30 | There is no evidence bypass: a production plan without evidence is denied; only break-glass lets it proceed | plan on production with no evidence environment | stack | HOLDS (static: rule `migration.staging-evidence`, `packages/policy/src/catalog/migrations.ts`) | |
| DC-044 | 04-migrations/staging-production-policy.md:179 | Break-glass for migrations is activated and used "in the Web App or the CLI" | `exponetdb --help` for an activate command; activate in the Web App | stack | **VIOLATED (ran)**: the CLI has no activation command (only `migration plan --break-glass <bgl_>` consumes a grant); activation is refused without a notification channel (OD-21, `BREAK_GLASS_UNAVAILABLE`) | |
| DC-045 | 04-migrations/dependency-graph.md:114 | Production applies unordered overlapping migrations in staging's order, else `ORDER_DIVERGES_FROM_EVIDENCE` | two unordered migrations touching one object, staging order B,A; production state forces A,B | stack | **VIOLATED (static)**: code never emits the error (0 occurrences outside `contracts`); no staging-order logic | |

## Operations (`12-operations/`) and the CLI/engine claims they rely on

| ID | file:line | Claim | How to check by running | S | Verdict now | result |
|---|---|---|---|---|---|---|
| DC-046 | 12-operations/upgrades.md:15 | `[DECIDED]` Control Store migrations are expand/contract, so rolling back the application by one release works without a schema rollback | migrate the store with release N+1 (adds a bundle); start release N | stack | **VIOLATED (static)**: release N does not know the new bundle → `compareSchema` = `newer` → `StartupRefused('schema_newer')` (`apps/server/src/composition/role.ts:229-233`; readiness fails with `schema_newer` at `:135`). Docs `control-database.md:128,256` say the same. The two sentences of `upgrades.md` (15-18) contradict each other | |
| DC-047 | 12-operations/upgrades.md:17 | A server binary refuses to start against a Control Store schema newer than it knows | run an old image against a migrated store | PG | HOLDS (static, as DC-046) | |
| DC-048 | 12-operations/upgrades.md:19 | Order: `control-store migrate` once with `exdb_migrate`, then worker, serve, gateway; a role whose schema is pending stays not ready | run in that order; start serve before migrate; check `/healthz/ready` | PG | HOLDS (static: `role.ts:129-131` `schema_pending`) | |
| DC-049 | 12-operations/upgrades.md:29 | Plans created by the previous version expire with `PLAN_STALE` (reason `engine_version`) | create a plan, bump the kind version, apply | stack | **VIOLATED (static + ran)**: `accept.ts:192` returns `operation_kind_unknown`, which `errorCodeOf` turns into HTTP 500 `INTERNAL` (`isErrorCode('operation_kind_unknown') === false`, probe1) | |
| DC-050 | 12-operations/upgrades.md:34 | An agent outside the server's supported version range makes the node `degraded` and only read capabilities are dispatched | enroll an agent with a version outside the range | host | UNCLEAR (static: no range constant found in `packages/nodes`/`apps/server`) | |
| DC-051 | 12-operations/control-store-runbook.md:42 | `control-store bootstrap-sql --credentials-file F --output O` exist and write SCRAM verifiers only | run it with `docker run` | none/PG | HOLDS (static: flags `--credentials-file`, `--database`, `--output`, `apps/server/src/commands/index.ts:265-290`) | |
| DC-052 | 12-operations/control-store-runbook.md:48 | `keyring generate --key-id k<year>a --output F` | run it | none | HOLDS (static: flags `--key-id`, `--output`, `index.ts:289-305`) | |
| DC-053 | 12-operations/control-store-runbook.md:53 | `control-store migrate` prints `installationId`; exit 0 means every bundle is applied **and** verified | run against an empty PostgreSQL 17 with the `exdb_migrate` login | PG | UNCLEAR | |
| DC-054 | 12-operations/control-store-runbook.md:66 | `/healthz/ready` answers `{"status":"ready","requestId":…}` and nothing else | `curl` on a running serve | stack | UNCLEAR (static: `apps/server/src/interfaces/http/app.ts:124` returns status and request id only) | |
| DC-055 | 12-operations/control-store-runbook.md:113 | `control-store status` can be run with the restored runtime login (`exdb_serve`, not `exdb_migrate`) | `control-store status` with each login | PG | HOLDS (static: `storeCommandConfig(io.env, 'readonly_store')`, `index.ts:258-263`) | |
| DC-056 | 12-operations/control-store-runbook.md:120 | `audit verify --from-checkpoint <seq>` compares the restored chain with the newest exported checkpoint | export a checkpoint, restore an older dump, run it | stack | UNCLEAR (flag exists, `index.ts:417-427`) | |
| DC-057 | 12-operations/control-store-runbook.md:129 | RB-10 step 6: "Reconcile ledger mirrors against target ledgers (from Wave 4, F30); in Wave 2 there are no managed targets" | restore the Control Store from a dump older than the last apply; `migration status`, `ledger reconcile` | stack | **VIOLATED (stale text)**: names no command; with targets in service the loss of the mirror and of the operations that explain it makes every row `unrecorded` (`divergence.ts`), so every plan is refused until a `ledger.reconcile` per target; the runbook never says so | |
| DC-058 | 12-operations/control-store-runbook.md:77-96 | Coolify's `dump_all` backup restores with the runtime login and keeps grants; database-only backup loses grants | restore both into scratch | host | UNCLEAR (`[OBSERVED]` 2026-10-06, record `deployments/2026-10-06-reos-01.md`) | |
| DC-059 | 12-operations/backup-runbooks.md:24 | Protection reasons include `wal_archive_failing` and `archive_stale` | `exponetdb backup list <cluster>` with a failing archive | host | **VIOLATED (static)**: `archive_stale` appears nowhere in code; real reasons are in `packages/backups/src/protection.ts:143-271` | |
| DC-060 | 12-operations/backup-runbooks.md:135 | `exponetdb restore plan <target> --file recovery.json` plans a recovery; the CLI never applies it | run it; try `--apply` | stack | HOLDS (static: reference lists `--file`, no `--apply` on `restore plan`) | |
| DC-061 | 12-operations/backup-runbooks.md:160 | `exponetdb restore runbook <cluster> --repository <id> --out recover.sh` writes a POSIX script, mode 0700, never over an existing file, sha256 printed, no secret | run it twice; `ls -l`; grep for secrets | stack | UNCLEAR (flags exist, reference `restore runbook`) | |
| DC-062 | 12-operations/backup-runbooks.md:122 | `EXPONETDB_RESTORE_EXECUTION` = `all`, `scratch` or `disabled`; `disabled`/`scratch` refuse a recovery with `FEATURE_NOT_ACTIVATED` | start serve with each value; plan a recovery | stack | HOLDS (static: 5 files; code `FEATURE_NOT_ACTIVATED` in catalog with `current`/`setting` details) | |
| DC-063 | 12-operations/backup-runbooks.md:134 | A point in time outside the window is refused as `point_in_time_outside_window` | `restore plan` with a PITR before the oldest backup | stack | HOLDS (static: 3 files) | |
| DC-064 | 12-operations/backup-runbooks.md:116 | Recovery is human-only (`restore.human-only`), needs approval and fresh re-auth on every tier (`restore.recovery-approval`), starts only from a verified backup with continuous WAL (`restore.source-verified`) | plan a recovery as an agent client; as a person without approval | stack | HOLDS (static: the three rule ids exist in `packages/policy/src/catalog`) | |
| DC-065 | 12-operations/backup-runbooks.md:174 | `exponetdb drill record-offline` records a quarterly offline drill as an attestation | run it | stack | HOLDS (static: command exists; `backups.drills` CHECK only admits `attested` for `offline_runbook`) | |
| DC-066 | 12-operations/backup-runbooks.md:148-153 | RB-08 step 7: the switch to the recovered cluster is "the registration of the new cluster and a placement change through the registry by a person" | after step 5, try to move the target's placement | stack | UNCLEAR (`restores.promoted` is unreachable by guard, `catalog up.sql:494-497`; no CLI command for a placement change; `registry` commands only register/retire) | |
| DC-067 | 12-operations/node-runbook.md:181-209 | `exponetdb node-pki job-key` with `stage`, `activate`, `retire <key>`, `list` | run each on the Control Store host | PG | HOLDS (static: `apps/server/src/commands/index.ts:192-210`) | |
| DC-068 | 12-operations/bootstrap.md:138-140 | The agent root CA ceremony uses `exponetdb ca init-root` and `exponetdb ca issue-intermediate` | run them | none | **VIOLATED (ran/static)**: not in the CLI registry nor in the server's command list (`node-pki init\|job-key\|postgres-ca`) | |
| DC-069 | 12-operations/local-development.md:42 | `exponetdb dev seed` creates the lab identities | `exponetdb dev seed` | none | **VIOLATED (ran)**, but disclosed at `:48` ("`dev seed` does not exist"); the section header still promises it | |
| DC-070 | 12-operations/local-development.md:194 | `cd apps/server && sudo -E env "PATH=$PATH" EXDB_NODE_E2E_AGENT_USER=exdbagent bun run test:host` | run on a systemd host | host | HOLDS (static: `apps/server/package.json:16` `test:host`) | |
| DC-071 | 12-operations/deployment.md:340 | The image tag is the version, never `latest` | grep `deploy/` for `latest`; read the compose files | none | HOLDS (static: no `latest` in `deploy/`) | |
| DC-072 | 12-operations/onboard-external-cluster.md:230-236 | Agent adoption is "[PLANNED] No CLI command yet; plan it over REST with `$EXPONETDB_TOKEN`" | try to obtain a token with the CLI | none | UNCLEAR → **a CLI-only operator cannot do it**: the CLI keeps tokens private (`credentials.json`, 0600) and has no `auth token` command (`auth status\|presets\|scopes\|reauth` only) | |

## Counts

| Verdict now | Count |
|---|---:|
| HOLDS (ran) | 8 |
| HOLDS (static) | 31 |
| VIOLATED (ran or static) | 17 |
| UNCLEAR (needs the stack) | 16 |
| total | 72 |

`VIOLATED`: DC-007, 013, 014, 020, 028, 029, 033, 037, 042, 044, 045, 046, 049, 057, 059, 068, 069. The ones
that bite in an incident are **DC-046** (no rollback of an ExponetDB upgrade), **DC-014** (the documented
way out of a stuck lock does not exist), **DC-037** (ledger divergence is not watched), **DC-057** (RB-10
leaves the ledger mirror unaddressed), **DC-049** (a plan across an upgrade returns a 500) and **DC-044**
(break-glass cannot be used). They are written up in `../F/findings-E1.md`.
