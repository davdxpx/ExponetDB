### [P1] `needs_attention` has no exit for any operation kind outside four migration kinds, and it keeps the operation's locks for ever
- **Area:** `packages/operations` (driver, supersede, locks), `packages/application` (`views.ts`), `apps/cli`
- **Block:** E
- **Reproduction:** (probe, run) `probe1.ts` calls `verificationRetryable({kind, state:'needs_attention', applyOutcome:'applied', verificationOutcome:'error'})`: true only for `migration.apply|resume|baseline|verify`; false for `migration.rollback`, `ledger.reconcile`, `drift.accept`, `backup.run`, `restore.drill`, `node.enroll`, `postgres.roles.apply`, `registry.cluster.register`, `credential.rotate`. (static) `driver.ts:372-406` turns any exception of a kind's `verify` into `needs_attention` for every kind; `supersedes()` exists only in `migrations-engine/src/kind.ts:131` and `reverify.ts:380`; `operation cancel` accepts only `awaiting_approval|queued` (`application.ts:1943-2000`); `operation.force_release` is registered (`contracts/src/actions.ts:1052`) with no kind, CLI command or page (`operations/README.md:44`). Stack step for block C: with `postgres.hba.apply` or `backup.run` make the verification step throw (cut the worker's Control Store connection during `verifying`, or make the node observation unreachable); then `exponetdb operation retry-verification <op>` (expect `OPERATION_NOT_RETRYABLE`), `operation cancel <op>` (expect `OPERATION_NOT_CANCELABLE`), and start a second operation in the same domain (`cluster:<id>:config`): it stays `queued` with `waitingFor` for ever.
- **Expected:** every non-terminal state has a documented exit for an authorised person (CLI or Web App), and a parked operation does not hold the domain of every later operation without a way to release it. The docs name the exit: `04-migrations/concurrency.md:131` ("a human with `operations.recover` runs `operation.force_release(op_…)` (Web App or CLI, re-authentication)").
- **Actual:** the exit exists for four migration kinds only. For every other kind the operation holds its exclusivity domains until someone edits the Control Store by hand, and the guards refuse that too (`operations-engine/up.sql:143-205`: no transition out of `needs_attention` except to `verifying` / `verification_failed`; locks of a live operation cannot be deleted).
- **Evidence:** `E/state-machines.md` §1, §8 (SM-1); `E/recoverability.md` R6; `E/docs-claims.md` DC-014.
- **Root cause:** TC-005's fix (`supersede.ts`) covered the migration recovery plans only; `operation.force_release` stayed planned (OD-58 option (b) not taken); `VERIFICATION_RETRY_KINDS` (`views.ts:270-275`) is a closed list.
- **Proposed fix:** a first-class close for `needs_attention`: `exponetdb operation close <op> --reason …` (human only, class `high`, fresh re-authentication, audit event, never re-executes, releases the domains). Or build `operation.force_release` as documented. In addition give the registry, node and backup kinds a verify retry or a `supersedes`.
- **Acceptance test:** an integration test over all registered kinds: put one operation of each kind in `needs_attention` (each outcome pair the kind can reach) and assert that an authorised action leaves the state and frees the domains; fails today for all but four kinds.

### [P1] `needs_attention` with apply outcome `unknown` has no exit when the migration turned out not to be applied
- **Area:** `packages/migrations-engine` (`kind.ts` reconcile, `reverify.ts`, `recovery.ts`), CLI
- **Block:** E
- **Reproduction:** (static; stack step for C) apply a transactional migration; cut the connection to the target during the commit and keep it down for more than 120 s so `reconcile` returns `unknown` (`kind.ts:861-880`: unreachable target or lock not taken) while the transaction rolled back; restore connectivity. The operation is `needs_attention` with apply `unknown`. Try `operation retry-verification` (refused, apply is not `applied|partially_applied`, `views.ts:285-297`), `migration verify <id> --target T` (`reverify.ts:131-134`: no ledger row → `NOT_FOUND`), `operation cancel` (`OPERATION_NOT_CANCELABLE`), `migration apply` (queues behind the parked operation's `target:<id>:schema`).
- **Expected:** a person can close an operation whose outcome the engine could not determine once the ledger shows the truth, without database surgery.
- **Actual:** the target's schema domain stays held; every later schema plan on the target waits behind it.
- **Evidence:** `E/recoverability.md` R5; `E/state-machines.md` §1.
- **Root cause:** the only closing paths (`migration.resume`, `migration.verify`) need a started non-transactional event log or an applied ledger row; a rolled-back transactional apply with an unreadable outcome is neither.
- **Proposed fix:** as the previous finding (a close action); in addition let the reconcile of `unknown` retry on a timer once the target answers instead of parking the operation after one attempt (the evidence needed, ledger row present or absent, is then readable).
- **Acceptance test:** simulate a rolled-back apply with an unreachable target during reconcile; assert that a human reaches `failed` (or an equivalent final state) with the domain released, through the CLI.

### [P1] An ExponetDB upgrade cannot be rolled back, although `upgrades.md` says a one-release rollback works
- **Area:** `12-operations/upgrades.md`, `apps/server/src/composition/role.ts`, `packages/control-store/src/runner.ts`
- **Block:** E
- **Reproduction:** (static; stack step for C) migrate a Control Store with the image of `d51da5d0` (it adds bundles after `d0229550`, e.g. `operation-supersession`, `ledger-reconcile`, `offline-drill-record`), then start `serve` of the `d0229550` image against it. `compareSchema` returns `newer` for ledger ids the older release does not list; `role.ts:229-233` throws `StartupRefused('schema_newer')` and the readiness check fails with `schema_newer` (`role.ts:135`); `02-control-plane/control-database.md:128,256` say the same.
- **Expected:** `upgrades.md:14-16` (`[DECIDED]`): "Control Store migrations follow expand/contract ... Therefore rolling back the application by one release works without a schema rollback."
- **Actual:** the same document (line 17) and the code say an older binary refuses a newer schema, so the promised rollback is impossible whenever the new release added a bundle (every release since Wave 2 did). The only way back is restoring the Control Store from a backup taken before `control-store migrate` (RB-10), which loses everything after the dump, and the upgrade runbook (`upgrades.md`, `deployment.md` §6) has no pre-upgrade backup step.
- **Evidence:** `E/docs-claims.md` DC-046, DC-047, DC-048; `E/recoverability.md` R20, R21.
- **Root cause:** expand/contract assumes an old binary tolerates unknown newer bundles; the startup check is exact-match by design (`control-database.md` §5).
- **Proposed fix:** (a) correct the document: no rollback of the roles after `control-store migrate`, roll forward or restore; (b) add a mandatory "take and verify a Control Store dump" step to the upgrade runbook; (c) optionally let a binary start against a schema that adds only bundles marked additive with a declared minimum release (needs an ADR).
- **Acceptance test:** a runbook-lab test that follows the upgrade and the documented rollback with two real images and asserts the documented outcome; today it fails at the start of the old image.

### [P2] Ledger divergence is not monitored: the documented periodic reconciliation and finding do not exist
- **Area:** `apps/server/src/composition/worker-tasks.ts`, `packages/migrations-engine/src/divergence.ts`, `04-migrations/ledger.md` §5
- **Block:** E
- **Reproduction:** (static) `ledger.md:236` (`[DECIDED]`): "A periodic reconciliation (default every 10 minutes per active target, and on every plan) compares `ledger_state_hash` of target and mirror"; the divergence table says "finding raised". The worker task list (`worker-tasks.ts:186-314`: audit, plans.expire, idempotency, auth, oauth, heartbeats, secrets, registry.credentials, health, drift, statements, nodes) has no ledger task; `divergence.ts` compares only inside `planner.ts`. Stack step: insert a row by hand into `exponetdb.schema_migrations` of a staging target, wait 15 minutes, `exponetdb finding list`, `exponetdb target show`: nothing; only `migration plan` answers `LEDGER_DIVERGENCE`.
- **Expected:** a hand edit or a restore is raised as a finding within the stated interval.
- **Actual:** it is discovered only when someone plans a change, i.e. at the moment of the change.
- **Evidence:** `E/docs-claims.md` DC-037; `E/state-machines.md` §5.
- **Root cause:** the worker task was never added; the docs describe the design.
- **Proposed fix:** add a `ledger.compare` worker task per active target (live read as observer) raising a `ledger_divergence` finding with the class lists; or change the docs to "checked at plan time only".
- **Acceptance test:** an integration test that edits a target ledger and asserts a finding within one task interval.

### [P2] The CLI prints most error `details` only with `--json`: `PLAN_STALE` does not say which binding changed
- **Area:** `apps/cli/src/output/render.ts:150-210`
- **Block:** E
- **Reproduction:** (probe, run) `probe2.ts` calls `renderHuman` with the catalog's real `details` for nine codes; the human lines after the message are empty for `PLAN_STALE`, `OPERATION_CONFLICT`, `MIGRATION_EXECUTION_FAILED`, `POLICY_DENIED`, `APPROVAL_COOLING_PERIOD`, `OPERATION_NOT_RETRYABLE`, `VERIFICATION_FAILED`, and show only `migrationId` / `missing` for `MIGRATION_CHECKSUM_MISMATCH` and `LEDGER_DIVERGENCE` (their `knownChecksum`, `where`, `checksumDiffers`, `unrecorded` are hidden). Stack step: `plan apply` a plan after changing the schema by hand.
- **Expected:** a refused command names what refused it (binding, blocking operation, rule, SQLSTATE and statement, time).
- **Actual:** "The plan no longer matches the target. Create a new plan." and a request id.
- **Evidence:** `E/errors.md` §5.1.
- **Root cause:** `NAMED_DETAILS` lists five keys only (`render.ts:150-157`).
- **Proposed fix:** a per-code detail renderer driven by the catalog's `details` schema (print every scalar and id list, capped), tested against the generated catalog so a new code cannot ship without a rendering.
- **Acceptance test:** for every catalog code with a `details` schema, `renderHuman` of a sample payload contains every id field of the payload (fails for nine or more codes today).

### [P2] The CLI recommends `operation retry-verification` for operations the server refuses
- **Area:** `apps/cli/src/output/views.ts:365-380` (`operationNext`)
- **Block:** E
- **Reproduction:** (probe, run) `probe4.ts`: `operationNext` of an operation in `needs_attention`, apply `applied`, verification `error` returns `exponetdb operation retry-verification <op>` for `backup.run`, `node.enroll` and `ledger.reconcile` although `retryable` is false; the Web App respects the server's flag (`apps/web/src/features/changes/operation-page.tsx:342`).
- **Expected:** the hint appears only when the server says `retryable`; otherwise the CLI says there is no automated recovery.
- **Actual:** the operator is sent to `OPERATION_NOT_RETRYABLE` (409) at the worst moment.
- **Evidence:** `E/vocabulary.md` row "verify"; `E/state-machines.md` §1.
- **Root cause:** the CLI re-implements the rule without the kind list.
- **Proposed fix:** use `OperationRead.retryable`.
- **Acceptance test:** a CLI unit test with `retryable:false` expects no `retry-verification` hint.

### [P2] A superseded `needs_attention` operation is recorded with verification outcome `failed` although verification never ran
- **Area:** `packages/operations/src/supersede.ts:49-66`
- **Block:** E
- **Reproduction:** (static; stack step for C) path R4 of `E/recoverability.md`: after `migration verify <id>` closes the stuck operation, `operation show <stuck>`.
- **Expected:** a final state that tells what happened: change applied or unknown, verification not run, closed by a recovery plan.
- **Actual:** `verification_failed` with `verificationOutcome: failed` (and `unknown` rewritten to `partially_applied`); no verification row exists; the Web App says "Verification failed". C-13 (truthful reads) is the rule.
- **Evidence:** `E/state-machines.md` §1 (row `verification_failed`).
- **Root cause:** the closing edge reuses the only terminal state that admits applied plus unfinished verification.
- **Proposed fix:** show `supersededBy` ("closed by <op>") in CLI and Web, or add a distinct terminal state (additive bundle, needs OD-58).
- **Acceptance test:** closing a stuck operation exposes its closer in `operation show --output json` and the human view does not say "verification failed".

### [P2] The documented repair of a broken `verify.sql` cannot be completed with the CLI
- **Area:** `apps/cli` (no `ingest` command), `04-migrations/verification.md:419-433`, `failure-and-recovery.md` E10
- **Block:** E
- **Reproduction:** (ran: command list) `exponetdb commands` has no command that stores a bundle revision. (static) `migration plan` ingests inside the plan transaction (`planner.ts:595`) and refuses with `MIGRATION_ALREADY_APPLIED` when nothing is pending (`planner.ts:350-352`), which rolls the ingest back. REST `migration.bundle.ingest` exists (`packages/application/src/migrations.ts:93-113`); CLI and MCP do not use it. Stack step: apply a migration, edit `verify.sql`, `migration plan --target T <id>`, then `migration verify <id> --revision 2`.
- **Expected:** "The new bundle revision is ingested" by a CLI step; then `migration verify` runs with the new digest.
- **Actual:** revision 2 never reaches the store through the CLI; `migration verify --revision 2` answers `NOT_FOUND`.
- **Evidence:** `E/recoverability.md` R8; `E/state-machines.md` §4.
- **Root cause:** `migration.bundle.ingest` was built for REST only.
- **Proposed fix:** `exponetdb migration ingest [paths…]` (class low, audited) listing the statuses `stored|unchanged|verify_revision|rewritten_unapplied`.
- **Acceptance test:** E10 end to end through the CLI only, including the ingest step.

### [P2] RB-10 (Control Store down) leaves the ledger-mirror problem unaddressed
- **Area:** `12-operations/control-store-runbook.md:129-130`
- **Block:** E
- **Reproduction:** (static; stack step for C) restore the Control Store from a dump older than the last apply of a staging target; `exponetdb migration status --target T`, then `migration plan`.
- **Expected:** step 6 gives the commands for each managed target.
- **Actual:** "Reconcile ledger mirrors against target ledgers (from Wave 4, F30); in Wave 2 there are no managed targets." After a restore the mirror lacks rows and the operations that explain the target's ledger rows, so `unrecorded` rows (`divergence.ts`) refuse every plan on every target until a `migration ledger reconcile` is applied per target, which needs scope `migrations.import` (the `admin` preset only) and, on production, a human approval and a fresh re-authentication.
- **Evidence:** `E/docs-claims.md` DC-057; `E/recoverability.md` R21.
- **Root cause:** the runbook predates managed targets.
- **Proposed fix:** rewrite step 6 as a per-target loop with commands, scopes and the expected `LEDGER_DIVERGENCE` sequence; reference it from the upgrade-rollback path.
- **Acceptance test:** a runbook-lab test of RB-10 on a stack with one staging target passes with only the documented commands.

### [P2] A plan from before an upgrade, or a lost race, answers HTTP 500 `INTERNAL` instead of a catalog code
- **Area:** `packages/operations/src/errors.ts`, `accept.ts:192`, `apps/server/src/interfaces/http/request.ts:152-162`
- **Block:** E
- **Reproduction:** (probe, run) `probe1.ts`: `isErrorCode('operation_kind_unknown') === false`, `isErrorCode('operation_state_changed') === false`; `errorCodeOf` maps both to `INTERNAL`. (static) `acceptPlan` returns `operation_kind_unknown` when `kind.version !== plan.kindVersion`; a concurrent second request with the same `Idempotency-Key` throws `idempotency_in_progress` (`idempotency.ts:72`). Stack step: create a plan, change a kind's `version` in a build, apply the old plan; send two requests with one key.
- **Expected:** `upgrades.md:29` (`[DECIDED]`): such plans "expire with `PLAN_STALE` (reason `engine_version`)"; a duplicate in-flight request gets a retryable 409.
- **Actual:** 500 with the generic message; only the log has the cause.
- **Evidence:** `E/errors.md` §4; `E/docs-claims.md` DC-049.
- **Root cause:** internal operation codes have no mapping to catalog codes.
- **Proposed fix:** map `operation_kind_unknown` to `PLAN_STALE` with binding `kindVersion`, `operation_state_changed` to `OPERATION_CONFLICT` / `PLAN_ALREADY_USED`, `idempotency_in_progress` to a 409.
- **Acceptance test:** a contract test that every `InternalOperationCode` reachable from a route maps to a catalog code.

### [P3] Thirteen catalog error codes are documented and exposed but never produced
- **Area:** `packages/contracts/src/errors.ts`, `apps/cli/src/cli/exit.ts`, `apps/web/src/lib/i18n/messages/changes.ts`
- **Block:** E
- **Reproduction:** (static) token search of `packages/*/src` (without contracts, ui, sdk) and `apps/server/src`: no file names `ORDER_DIVERGES_FROM_EVIDENCE`, `OPERATION_CONFLICT`, `MIGRATION_DEPENDENCY_UNVERIFIED`, `MIGRATION_REQUIREMENT_UNMET`, `STAGING_EVIDENCE_MISSING`, `STAGING_VERIFICATION_FAILED`, `STAGING_EVIDENCE_UNREACHABLE`, `EVIDENCE_CHAIN_MISCONFIGURED`, `BACKUP_NOT_VERIFIED`, `TOKEN_EXPIRED`, `BACKUP_FAILED`, `RESTORE_FAILED`, `SAMPLE_STALE`.
- **Expected:** every documented code can occur, or is marked reserved.
- **Actual:** evidence and dependency refusals arrive as `POLICY_DENIED`; the CLI maps four of the codes to exit 4 and the Web App has message keys for at least two.
- **Evidence:** `E/errors.md` §2.
- **Root cause:** rules replaced the codes during Waves 6 and 7.
- **Proposed fix:** delete them or mark them reserved in `error-model.md`; point the CLI and Web mappings at `POLICY_DENIED` rule ids.
- **Acceptance test:** a test that fails when a catalog code has no emitter (with an allow-list of reserved codes).

### [P3] 69 catalog codes carry no remedy; the operationally important ones are listed
- **Area:** `packages/contracts/src/errors.ts` (`remediation`)
- **Block:** E
- **Reproduction:** (ran: script over `catalog.json`) 38 of 129 codes have `remediation`; a keyword search of the documented meaning leaves 69 without any remedy hint (an upper bound).
- **Expected:** each code says what to do next, with the CLI command where one exists.
- **Actual:** e.g. `LEDGER_NOT_INITIALIZED`, `TARGET_IDENTITY_MISMATCH`, `CLUSTER_IDENTITY_MISMATCH`, `SCHEMA_FINGERPRINT_MISMATCH`, `VERIFICATION_FAILED`, `POLICY_DENIED`, `RESTORE_SOURCE_INVALID`, `PLAN_ALREADY_USED` name no next step and no id.
- **Evidence:** `E/errors.md` §3, §5.2, §7.
- **Root cause:** remedies were added code by code.
- **Proposed fix:** fill `remediation` for the about 20 operational codes; add the missing ids to their `details` schemas (`PLAN_ALREADY_USED.operationId`, `SCHEMA_FINGERPRINT_MISMATCH.expected/actual`, `TARGET_IDENTITY_MISMATCH.targetId`).
- **Acceptance test:** a contract test listing codes without `remediation` and failing for any not on an allow-list.

### [P3] `drift.accept` is documented for "the Web App or the CLI"; the CLI has no command
- **Area:** `apps/cli`, `03-database-model/drift-detection.md` §5, `02-control-plane/operations-engine.md` §2
- **Block:** E
- **Reproduction:** (ran) `exponetdb commands` lists no `accept`; `drift.accept.plan` exists in the SDK and REST only.
- **Expected:** `exponetdb finding accept <finding> --reason …`.
- **Actual:** accepting drift needs the Web App.
- **Evidence:** `E/state-machines.md` §6 (SM-5).
- **Root cause:** Wave 8 added the plan route and the Web page only.
- **Proposed fix:** the command (plan plus `--apply`), or correct the two sentences.
- **Acceptance test:** the CLI reference lists `finding accept`; an e2e test accepts a drift finding.

### [P3] Break-glass cannot be activated from the CLI or, on this installation, at all; documents say otherwise
- **Area:** `04-migrations/staging-production-policy.md:179`, `02-control-plane/operations-engine.md` §8, `apps/cli`
- **Block:** E
- **Reproduction:** (ran) no command in `exponetdb commands` activates break-glass; `migration plan --break-glass <bgl_>` only consumes a grant. (static) `BREAK_GLASS_UNAVAILABLE` / `notification_channel_not_configured` (OD-21).
- **Expected:** "in the Web App or the CLI", or an honest statement that the production no-evidence hotfix path is closed.
- **Actual:** hotfix findings E16/E18 are waived, and the only escape for a no-evidence production change is unavailable.
- **Evidence:** `E/docs-claims.md` DC-028, DC-044; `E/recoverability.md` R16.
- **Root cause:** OD-21.
- **Proposed fix:** say in the docs that this installation has no break-glass, or build the channel (owner decision OD-21).
- **Acceptance test:** the command-existence check of the next finding.

### [P3] Documents name commands, flags, states and rule ids that do not exist
- **Area:** `04-migrations/concurrency.md:88-89`, `12-operations/bootstrap.md:136-140`, `12-operations/local-development.md:42`, `12-operations/backup-runbooks.md:24`, `04-migrations/verification.md:493`, `04-migrations/authoring-and-ci.md:80`, `02-control-plane/policy-engine.md` (rule table)
- **Block:** E
- **Reproduction:** (ran: `cmdcheck.py` over six document folders, 166 `exponetdb …` mentions) misses: `exponetdb lock-key`, `exponetdb ca init-root`, `exponetdb ca issue-intermediate`, `exponetdb dev seed`; also the protection reason `archive_stale` (not in `protection.ts`), the `migration checksum` output (JSON has `bundleDigest`, no source digest), `retry-verification` "only `migration.apply` and `migration.resume`" (four kinds in code), and four policy rule ids (`migration.checksum-consistent`, `migration.dependencies-satisfied`, `migration.pg-version`, `migration.execution-role`) that the 45-rule registry does not contain. 120 of the other mentions resolve, with every flag.
- **Expected:** every command and flag in a runbook exists with that spelling.
- **Actual:** see above; `bootstrap.md` §4 sends a Wave 5 owner to commands of a design that was never built (`node-pki init` is the real one).
- **Evidence:** `E/docs-claims.md` DC-007, 013, 042, 059, 068, 069.
- **Root cause:** documents written before the commands.
- **Proposed fix:** fix the places; add the check as a CI step.
- **Acceptance test:** a script (E1's `cmdcheck.py` is the prototype) exits 1 on any unresolved command or flag in `exponetdb-docs/12-operations` and `04-migrations`; passes after the fix.

### [P3] One program name for two programs with overlapping words (`exponetdb audit`, `exponetdb auth`, `exponetdb version`)
- **Area:** `apps/cli` (bin `exponetdb`), `apps/server/src/main.ts`, runbooks
- **Block:** E
- **Reproduction:** (ran) the CLI has `audit list|show` and `auth status|presets|scopes|reauth`; the image entrypoint has `audit verify|prune` and `auth recover-owner`; 36 mentions in `12-operations` / `04-migrations` do not say which binary.
- **Expected:** a runbook line tells where it runs.
- **Actual:** it does not.
- **Evidence:** `E/vocabulary.md` row "exponetdb".
- **Root cause:** the server image entrypoint predates the CLI.
- **Proposed fix:** prefix server commands in the docs with `docker exec … exponetdb`, or rename the image entrypoint.
- **Acceptance test:** the same CI check, with a table of which binary owns which word.

### [P3] Enum values that no code writes, and a Web label for an unreachable state
- **Area:** `stepup.step_ups.state` (`expired`), `nodes.enrollment_tokens.state` (`expired`), `backups.restores.state` (`promoted`), `apps/web/src/lib/i18n/messages/wave9.ts:529`
- **Block:** E
- **Reproduction:** (static) no `state = 'expired'` writer in `packages/auth/src/stepup.ts` or `packages/nodes/src/tokens.ts`; the `restore_guard` raises `no operation promotes a restore yet` (`01M5X840BK55NGFGQ5G3Z1C5NH_backup-catalog/up.sql:494-497`).
- **Expected:** the stored state is true, or the derived state is labelled derived.
- **Actual:** a past-deadline step-up or token reads `pending` / `confirmed` / `issued` in the table; `expired` is computed on read (`stepup.ts:92-93`); the Web catalog has "Promoted".
- **Evidence:** `E/state-machines.md` §7.
- **Root cause:** states declared ahead of the code.
- **Proposed fix:** drop unreachable values in an additive bundle, or add the sweeper; remove the label.
- **Acceptance test:** a test that every value of a state `CHECK` is writable or documented as derived.
