### [P1] The documented rollback of an upgrade dies at once; the real way back (restore the dump) leaves every touched target blocked and every younger sign-in dead
- **Area:** `12-operations/upgrades.md` §1, `deployment.md` §6, `apps/server/src/composition/role.ts`, RB-10
- **Block:** C
- **Reproduction:** stack at `COMMIT=d0229550`; `C/upgrade/scripts/10-state.sh`, `20-dump.sh`, `40-upgrade.sh`, `60-rollback-documented.sh` (old build on the migrated store), `65-rollback-restore.sh` (RB-10 with the pre-upgrade dump), `68-divergence-old-release.sh`.
- **Expected:** `upgrades.md:14-16`: a one-release rollback works without a schema rollback.
- **Actual:** all three old roles exit 3 `process.start_refused reason=schema_newer` within 0.3 s; no listener (readiness is connection refused, the CLI answers `TRANSPORT_FAILED`); the old `control-store status` says `newer, expected 42, applied 45`; no remedy or dump hint. No pre-upgrade backup step exists in the runbook. Restoring the dump takes 7.0 s, then: (a) everything after the dump is gone (48 audit events, 6 operations, 6 plans, 66 operation events, 3 bundle revisions, 9 mirror rows); (b) staging, dev16 and dev18 answer `LEDGER_DIVERGENCE` (one sentence, no command) and the old release has no `ledger reconcile`; (c) a CLI sign-in rotated after the dump answers `UNAUTHENTICATED`; (d) the node is offline 74 s (agent backoff cap 60 s); (e) operations after the dump vanish while their ledger rows remain. This is the stack evidence for `F/findings-E1.md` third P1.
- **Evidence:** `C/upgrade/README.md` §5, §7, §8; `C/upgrade/timings.tsv`; `C/upgrade/counts-before-after.tsv`; logs `60-rollback-documented`, `65-rollback-restore`, `v6-after-restore`, `v9-divergence-old`, `90-policy-version` on vc-1 (index in `C/upgrade/logs-index.md`).
- **Root cause:** the exact-match startup check `role.ts:229-233` versus a document that assumes expand/contract.
- **Proposed fix:** rewrite `upgrades.md` §1 ("roll forward, or restore the pre-upgrade dump"); make dump, `gzip -t` and a scratch restore a numbered step before `migrate`; make `schema_newer` print expected, applied and "restore the pre-upgrade dump (RB-10)"; list sign-in, node gap and per-target reconcile in RB-10; optionally an ADR for additive-compatible starts.
- **Acceptance test:** a runbook-lab test that follows the written upgrade and rollback with two real builds, then plans on every touched target after the documented reconcile.

### [P1] RB-10 step 6 is empty for managed targets: after a restore into an older Control Store each touched target needs an undocumented reconcile (6 steps; production 10, with a step-up and an approval)
- **Area:** `control-store-runbook.md:129-130`, `04-migrations/ledger.md` §5, `15-cli/reference.md`
- **Block:** C
- **Reproduction:** `C/control-store-loss/scripts/00-prepare.sh`, `10-destroy-observe.sh`, `20-rb10-restore.sh` (`SUPER=restore_admin2`), then `C/upgrade/scripts/70-reconcile.sh lab/platform/staging lab/platform/dev18`, then `30-prod-cycle.sh prep|destroy` and `31-prod-reconcile-stepup.sh`.
- **Expected:** step 6 lists per-target commands, scope and approvals.
- **Actual:** the text says "in Wave 2 there are no managed targets". After steps 1 to 5 every target applied after the dump answers `Error LEDGER_DIVERGENCE: ... schema changes are blocked.` with no command named. The working path is `migration ledger reconcile --target T --note ...` then `plan apply --yes`: 6 steps, 6.2 s per nonprod target (scope `migrations.import`). Production requires `approval x1` plus `reauth within 300 s`: the CLI prints a step-up address and code and waits; a person confirms, the operation is `awaiting_approval`, a person approves: 10 steps. (Control Store restore as written otherwise works: RB-10's 6 steps are 11 operator actions, about 8 s of command time.)
- **Evidence:** `C/control-store-loss/README.md` §3, §4; `C/upgrade/README.md` §5.3; logs `70-reconcile-staging`, `loss-31-prod-reconcile` on vc-1.
- **Root cause:** the runbook predates managed targets; the divergence error carries no remedy.
- **Proposed fix:** rewrite step 6 as a per-target loop with commands, scope, production step-up and approval; add the command name to the `LEDGER_DIVERGENCE` remedy.
- **Acceptance test:** a runbook-lab RB-10 test with one nonprod and one production target using only documented commands.

### [P1] RB-14 (keyring lost) cannot be executed: roles refuse to start or stay not ready, and nothing resets the secrets
- **Area:** `incident-model.md:63`, `secrets.md` §5, `role.ts:68-72,142-149,238`
- **Block:** C
- **Reproduction:** `C/control-store-loss/scripts/40-keyring-lost.sh`: (a) no keyring, (b) `keyring generate --key-id k1`, (c) `--key-id k2`; start the roles; try `target list`, a plan, the owner's login, `keyring status`.
- **Expected:** `secrets.md:158-161`: rotate every PostgreSQL credential through the node agent, re-enroll nothing.
- **Actual:** (a) all roles exit 2; (b) exit 3 `keyring_mismatch`; (c) roles run `not_ready`, `keyring status` says `missing ["k1"]`, reads that need no secret work, a migration plan answers 500 `INTERNAL`, the owner's password login answers 500 (`secret_key_unavailable`). `cluster credential rotate` is a plan (500) and a node job needs the lost job-signing key. The 21 secret versions include 12 PostgreSQL credentials, the TOTP seed, the job key and the node CA key. The store is append-only and no command marks secrets lost.
- **Evidence:** `C/control-store-loss/README.md` §5; log `loss-40-keyring` on vc-1.
- **Root cause:** RB-14 describes an intent; there is no reset path and a missing key is fatal at start.
- **Proposed fix:** state that keyring loss without an offline copy means a new installation, and require custody, a second copy and a yearly restore test; or build an audited offline `keyring reset-secrets`.
- **Acceptance test:** destroy the keyring on a stack with a node and a target and follow RB-14 as written to a ready system with a working credential rotation.

### [P1] CREATE TABLE ... (id serial PRIMARY KEY ...) can never be applied: the engine's own structural verification fails and rolls back
- **Area:** `packages/postgres/src/parser/migration.ts` (column expectations), `packages/migrations-engine`
- **Block:** C (found while building state; the bundle system is Block B's)
- **Reproduction:** `C/upgrade/scripts/95-serial-column.sh`: bundle `CREATE TABLE public.va (id serial PRIMARY KEY, name text NOT NULL);` on a fresh PostgreSQL 17 target, plan (allowed), `plan apply`; the same with `bigserial`. `GENERATED ALWAYS AS IDENTITY` and `int` succeed.
- **Expected:** a verified apply.
- **Actual:** `failed / not_applied / VERIFICATION_FAILED` after 0.1 s on both `d0229550` and `d51da5d0`; gate detail `{"first":"column \"public\".\"va\".\"id\"","layer":"L0","checks":4,"failed":1}`; nothing is created; the CLI says only `VERIFICATION_FAILED`. Supabase-origin schemas are full of `serial`/`bigserial`, so a replay of such a history onto an empty database (invariant I10) hits this. (`main` has since gained L0 fixes for named `ADD CONSTRAINT`, #47; the lead did not re-test `serial` on `main`.)
- **Evidence:** `C/upgrade/NOTES.md`; log `95-serial-column.out` on vc-1.
- **Root cause:** the column expectation takes the raw parse type name `serial` (`migration.ts:399-420`, used at `:1324-1352`, no `serial` handling anywhere in the file, checked by the lead) while the catalog holds `integer` with a `nextval` default; `hasDefault` is set only for DEFAULT, IDENTITY and GENERATED.
- **Proposed fix:** map `smallserial|serial|bigserial` (qualified and case variants) to `int2|int4|int8`, not null, has default; or mark such columns underived. Related: `F/findings-B3.md` first P1 (the same blind spot for ADD COLUMN).
- **Acceptance test:** a test on PostgreSQL 16, 17 and 18: `CREATE TABLE t (id serial PRIMARY KEY)` and `bigserial` bundles reach `succeeded / applied / passed`.

### [P2] After a restore, a production target the store never mirrored is not blocked, `ledger reconcile` says "nothing to reconcile" while status says "out of sync", and the next apply adopts the unknown row
- **Area:** `packages/migrations-engine/src/divergence.ts:44-47`, `reconcile.ts:176-178`
- **Block:** C
- **Reproduction:** `00-prepare.sh` (a production change applied after the dump), `10-destroy-observe.sh`, `20-rb10-restore.sh`, then `migration status`, `migration plan` and `migration ledger reconcile --target lab/platform/production --note x`; then `30-prod-cycle.sh prep` and count the production mirror rows.
- **Expected:** a ledger row written by an operation the store never ran blocks planning until a reconcile decision; status and reconcile agree.
- **Actual:** the restored store still holds the operation (as `awaiting_approval`), so `known.has(operationId)` makes the row "known": no divergence; `ledger reconcile` fails `VALIDATION_FAILED nothing_to_reconcile`; `migration status` shows `Mirror: out of sync`. The next production apply mirrored two rows (live 2, mirror 2) after one bundle: the unknown row was adopted without a decision. Same root as `F/findings-B1.md` (evidence by operation id alone).
- **Evidence:** `C/control-store-loss/README.md` §4; logs `loss-v12-prod-reconcile`, `loss-30-prep` on vc-1.
- **Root cause:** `unrecorded = !mirrored.has(id) && !known.has(operationId)`, and "known" means any operation id in the store.
- **Proposed fix:** count a row as recorded only when `operation_migrations` says that operation applied it; one divergence function for status, plan and reconcile.
- **Acceptance test:** restore a store older than a production apply whose operation row is `awaiting_approval`: `plan` answers `LEDGER_DIVERGENCE` and `ledger reconcile` produces a plan.

### [P2] An old role keeps claiming and finishing operations after the schema moved ahead (503 not_ready, no log line)
- **Area:** `role.ts` (`compareSchema` at start and every 5 s), `operations-loop.ts`
- **Block:** C
- **Reproduction:** `C/upgrade/scripts/91-inflight-across-migrate.sh`: old release, a 45 s apply running, a second plan queued; `control-store migrate` of the new build at +8 s; old roles not redeployed for 70 s.
- **Expected:** a role whose schema is not its own stops claiming (or `upgrades.md` says it does not).
- **Actual:** all old roles answer 503, log nothing, and the old worker finishes the running apply (`succeeded/applied/passed`) and then claims the queued one (it ended `PLAN_STALE`, as expected). No harm in this release pair.
- **Evidence:** `C/upgrade/README.md` §6a; log `91-inflight.out` on vc-1.
- **Root cause:** readiness is evaluated, but the claim loop does not consult it.
- **Proposed fix:** stop claiming when the schema state is not `current`, and log it once; or document that additive releases rely on the old worker finishing.
- **Acceptance test:** after `migrate`, an old-build worker claims no new operation and logs `schema_not_current`.

### [P2] The upgrade runbook omits eleven steps: no pre-upgrade backup, outage window, drain, preflight or post-checks
- **Area:** `upgrades.md`, `deployment.md` §6, `deployments/2026-10-21-reos-01-studio-frame.md`
- **Block:** C
- **Reproduction:** `C/upgrade/scripts/40-upgrade.sh up1|up2|up3` with `sampler.mjs`, `downtime.mjs`.
- **Expected:** a runbook an operator can follow cold.
- **Actual:** `migrate` takes 0.8 to 1.0 s and leaves no audit event. Old roles go 503 about 1.9 s after the commit. Serve is down 16.0 / 17.3 / 17.5 s, gateway 14.6 / 15.6 / 15.8 s, worker 2.2 / 3.1 / 3.4 s (process-level lower bounds, no image pull). The eleven omissions are in `C/upgrade/README.md` §7. The pending plan from before the upgrade applied normally (no `PLAN_STALE`, no 500), and the policy version hash did change (apply re-checks decision and requirements, `accept.ts:198`): the fix PR's claim that older plans become stale is not confirmed.
- **Evidence:** `C/upgrade/README.md` §3, §7, §8; `C/upgrade/downtime.txt`; `C/upgrade/timings.tsv`.
- **Root cause:** the documents give the order, not the operation.
- **Proposed fix:** the one-page upgrade card from `README.md` §8 in `upgrades.md`; a `control-store status --against <build>` preflight; audit the migration.
- **Acceptance test:** the runbook-lab test of the first P1 follows the card end to end.

### [P3] A second recovery by the same RB-10 text fails: the temporary superuser restore_admin persists in the restored store
- **Area:** `control-store-runbook.md:106-110`
- **Block:** C
- **Reproduction:** restore once with `restore_admin`, `pg_dumpall` the restored store, lose it, restore again with `restore_admin` (`20-rb10-restore.sh` without `SUPER`).
- **Expected:** the text works every time.
- **Actual:** `ERROR: role "restore_admin" already exists` at step 3 (`ON_ERROR_STOP`), leaving a half-restored server to discard.
- **Evidence:** `C/control-store-loss/README.md` §3; log `loss-20-rb10-a-failed-first-attempt.out`.
- **Root cause:** the scratch resource becomes production and keeps its superuser.
- **Proposed fix:** a fresh name per recovery plus a step to drop or rename it.
- **Acceptance test:** two consecutive RB-10 restores in the lab succeed with the text as written.

### [P3] `plan apply --yes --json` waits silently for a step-up (no address, no code)
- **Area:** `apps/cli` `plan apply`
- **Block:** C
- **Reproduction:** `exdb_json plan apply <production ledger.reconcile plan> --no-wait --yes` (the first attempt of `30-prod-cycle.sh reconcile` hung 7 minutes).
- **Expected:** an error with the step-up id, or the address on stderr, as the text mode prints.
- **Actual:** no output until the step-up expires.
- **Evidence:** log `loss-30-reconcile.out`.
- **Root cause:** not examined.
- **Proposed fix:** as Expected, plus a `--timeout-wait` covering the step-up wait.
- **Acceptance test:** `plan apply --json` on a plan with a `reauth` requirement exits non-zero within 5 s with the step-up id.

### [P3] RB-10 step 3 says the exported checkpoints show the size of the lost gap; hourly checkpoints cannot
- **Area:** `control-store-runbook.md:114-120`, `worker-tasks.ts:194-199`
- **Block:** C
- **Reproduction:** `20-rb10-restore.sh` steps 7 and 8.
- **Expected:** the gap is sized from the checkpoints.
- **Actual:** `audit.checkpoint` runs every 3,600 s; the only exported checkpoint was seq 1 while the store held 571 events. `audit verify --from-checkpoint 1` passed.
- **Evidence:** `C/control-store-loss/README.md` §3.
- **Root cause:** cadence versus wording.
- **Proposed fix:** state the cadence in RB-10, or export a checkpoint per N events.
- **Acceptance test:** a doc check that RB-10 names the checkpoint interval and the resulting gap granularity.

### [P3] A restored awaiting_approval operation for a change that is already live is offered for approval
- **Area:** approvals list and page, `operations-engine.md`
- **Block:** C
- **Reproduction:** `00-prepare.sh`, RB-10, then `exdb approval list` and `human approve <op>`.
- **Expected:** it is recognised as applied or withdrawn.
- **Actual:** listed with an "Approve at" link although the production ledger holds the row; approving ends `failed / PLAN_STALE` (safe, nothing re-applied), with no explanation.
- **Evidence:** log `loss-v15-prod-approve.out`.
- **Root cause:** the store cannot know what happened after the dump.
- **Proposed fix:** an RB-10 step to cancel `awaiting_approval` operations older than the dump after the reconcile; show the binding state on the approval page.
- **Acceptance test:** after the documented step the approvals list is empty.
