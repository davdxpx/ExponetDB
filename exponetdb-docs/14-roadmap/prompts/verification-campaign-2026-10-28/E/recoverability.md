# E1: recoverability from the CLI and the runbooks alone

Block E, item 5. For every failure state the engine can reach: the shortest path out for a
person who has the CLI (`exponetdb`, 178 commands), the runbooks and, where the product insists, a
browser for a passkey or TOTP. A **step** is one CLI invocation (`wait` flags make the CLI poll; that
is not a step) or one browser action. "Approvals" are the humans and proofs the path needs. Evidence:
the state machines of `state-machines.md`, the CLI reference, and three pure-code probes (below).
Nothing here was run against a stack; paths marked **(static)** come from code reading and must be
confirmed by block C on a disposable stack (the commands are listed so the runner can do it).

Scopes: the CLI presets (`15-cli/README.md` §3) matter in an incident. `operator:prod` holds
`migrations.apply:prod` but **not** `migrations.import` (needed by `migration ledger reconcile`),
`restore.execute`, `operations.recover` or `breakglass.activate`; only `admin` has `migrations.import`
and no preset has the others. An operator who logged in with the usual preset meets
`INSUFFICIENT_SCOPE` (exit 3) in the middle of the incident and must log in again in the browser
(`exponetdb login --preset admin`, `auth reauth`).

## Probes that back this file (pure code, run)

```
verificationRetryable(kind, state=needs_attention, apply=applied, verification=error):
  true for migration.apply | migration.resume | migration.baseline | migration.verify
  false for migration.rollback, ledger.reconcile, drift.accept, backup.run, restore.drill, node.enroll,
            postgres.roles.apply, registry.cluster.register, credential.rotate
  apply=unknown, verification=pending: false for every kind
```

(`packages/application/src/views.ts:270-297`; script `probe1.ts` in the author's scratchpad, output reproduced here.)
`kind.supersedes()` exists only in `migrations-engine/src/kind.ts:131` (resume) and `reverify.ts:380`
(verify); `operation_locks` rows cannot be deleted while the operation is live
(`packages/operations/src/locks.ts:9-12`, RLS in `operations-engine/up.sql`).

## The table

| # | Failure state | Shortest path with CLI + runbook | Steps | Approvals / proofs | Where a CLI-only person gets stuck |
|---|---|---|---:|---|---|
| R1 | `awaiting_approval` (prod apply, or an agent's plan) | applier: `exponetdb operation cancel <op>`; approver: `approval show <op>`, `approval approve <op>` (opens the bound page; the CLI then waits for the decision) | 1 or 2 CLI + 1 browser | approver: another human (or self-approval if the policy allows), passkey/TOTP re-auth ≤ 5 min; critical self-approval: approve, **wait 10 min**, `plan apply` again with a fresh step-up | the CLI cannot approve (by design, ADR-0026). There is no deadline: an operation of a vanished applier waits for ever (SM-3, OD-64); only the applying actor can cancel it, an approver can only reject it in the browser |
| R2 | `queued` behind a lock (`waitingFor: op_…`) | `operation show <op>` → note `waitingFor`; `operation show <blocking>`; wait or deal with the blocker (R3-R5) | 2 | none | nothing cancels the *blocker*; a queued operation can be canceled (1 step) but the target stays blocked |
| R3 | `needs_attention`, kind `migration.apply\|resume\|baseline\|verify`, change applied, verification errored | `operation show <op>` → remove the cause (target reachable, verifier credential, lock) → `operation retry-verification <op>` | 2-3 | the plan kind's apply permission on the subject (no step-up in the CLI; the Web App asks for the typed target path on production) | a missing verifier credential needs `cluster credential submit` (opens the Web App's write-only form) first: +2 browser steps |
| R4 | `needs_attention`, migration kinds, apply outcome `unknown`, **migration is in the ledger** (the reconcile just could not read it) | `migration verify <id> --target T`: its plan names the stuck operation and closes it as `verification_failed`; then `operation watch` | 2 | plan kind permission; a person | the closed operation reads `verification_failed` with verification outcome `failed` although verification never ran (SM-2); the result must then be read from `migration show <id>` |
| R5 | `needs_attention`, migration kinds, apply outcome `unknown`, migration **not** in the ledger | none: `migration verify` → `NOT_FOUND` (`reverify.ts:131-134`); `retry-verification` → `OPERATION_NOT_RETRYABLE` (apply outcome unknown); `operation cancel` → `OPERATION_NOT_CANCELABLE`; `migration resume` is for non-transactional bundles that have an event log | ∞ | | **dead end (SM-2, P1)**: the operation keeps `target:<id>:schema`; every later schema plan on the target queues behind it for ever. Reachable when the target was unreachable during reconciliation and the apply had in fact rolled back |
| R6 | `needs_attention`, **any other kind** (backup, restore, node, credential, registry, drift.accept, ledger.reconcile, migration.rollback, postgres.*) | none (probe: `verificationRetryable` false; no `supersedes`; `operation.force_release` unbuilt) | ∞ | | **dead end (SM-1, P1)**: any exception in the kind's `verify` (the driver turns it into `error`, `driver.ts:372-406`) parks the operation with its domains (`cluster:<id>:config\|backup`, `target:<id>:schema\|maintenance`, `node:<id>:packages`). The docs promise `operation.force_release` (DC-014); there is neither a CLI command nor a Web page. The database refuses transitions and lock deletes by design, so the repair is a manual database intervention nobody documented |
| R7 | `failed` apply (E1: SQL error, lock timeout, stale under lock) | `operation show <op>` (per-migration progress: `sqlstate`, statement index, error code) → fix the bundle or wait → `migration lint` → `migration apply --target T` | 4 | prod: plan apply with approval + step-up if policy requires | none for nonprod. If the id already ran on staging with this checksum, the bundle cannot change (checksum rule); the fix is a new migration (E19) |
| R8 | `verification_failed` | (a) forward fix: `migration new`, edit, `migration lint`, `migration apply` on staging, wait, then production: 6+; (b) rollback: `migration rollback <id> --target T`, review, `plan apply <pln>` | 3-6+ | prod rollback: approval + re-auth ≤ 300 s; `lossy\|unsafe`: critical class and a verified backup (`migration.destructive-backup`) | (c) the documented "fix `verify.sql` and run `migration verify`" **cannot be finished from the CLI**: the new verify revision has to be ingested, there is no `ingest`/`bundle` command and `migration plan` of an applied migration ends in `MIGRATION_ALREADY_APPLIED` (SM-4, static). A destructive production rollback also needs a verified backup, and backup execution is off unless `EXPONETDB_BACKUP_EXECUTION` is activated (`FEATURE_NOT_ACTIVATED`) |
| R9 | `PLAN_STALE` / `PLAN_EXPIRED` | `migration plan --target T` (or `migration apply`) again, `plan apply <pln>` | 2 | as the original plan | the human output does not say which binding changed (ER-6); `--output json` is needed: +1 |
| R10 | Drift (`finding list`) | (a) unwanted: forward migration (R8a). (b) wanted: `drift.accept` plan from the finding, apply (prod: approval + re-auth) (c) out of scope: `project update` plan (managed scope) | (b) 3 browser | prod: approval + re-auth | (b) is **Web App only**: the CLI has no accept command although `drift-detection.md` §5 says "Web App or the CLI" (SM-5) |
| R11 | Ledger mismatch after a restore of the *same* cluster/database (E24/E25) | `migration ledger reconcile --target T --note "…"` → check the printed `missing`/`checksumDiffers`/`unrecorded` → `plan apply <pln>` → `migration status` → `migration plan` for the lost migrations → apply | 5-7 | scope `migrations.import` (`admin` preset only); prod: approval + re-auth, no break-glass override; human only | `LEDGER_DIVERGENCE` itself carries no remedy text and the human output hides `checksumDiffers`/`unrecorded` (ER-6); the doc `control-store-runbook.md` RB-10 step 6 does not mention it (DC-057) |
| R12 | Target restored **into a new cluster** (RB-08 step 7) | the old target now points at a cluster whose `system_identifier` differs: `CLUSTER_IDENTITY_MISMATCH`; `ledger.reconcile` refuses it by design; the switch is "registration of the new cluster and a placement change through the registry by a person" | ? | critical, human | no placement command exists in the CLI; `restores.promoted` is unreachable by guard (`catalog up.sql:494-497`) and documented as `[PLANNED]`. Whether `cluster register` + `target register` + re-import gives a usable target is not stated (UNCLEAR, needs block C's restore drill) |
| R13 | Orphan lock (worker died mid-apply) | lease expires after 30 s; another worker takes the operation over and **reconciles** (never re-executes); the target session's advisory lock frees by the keepalives within about a minute | 0 | none | if **no** worker runs, nothing moves and the CLI shows nothing but `running`; `operation show` has no worker/lease field in the table output (static). A hung statement is bounded by `statement_timeout` (default 15 min) |
| R14 | Dangling stored bundle (ingested by a denied or abandoned plan) | none needed to operate; none possible to remove: `bundle_revisions` is immutable and has no CLI listing | 0 | | cannot be listed or withdrawn from the CLI (SM-4 note); harmless, but it stays in the project stream for ever |
| R15 | Partially applied non-transactional bundle (`MIGRATION_INCOMPLETE`) | `migration resume <id> --target T [--cleanup]` → review the readback in the plan → `plan apply <pln>` | 3 | class `high`: prod approval + re-auth; `--cleanup` only for an INVALID index | an `ambiguous`/`unreadable` readback is a blocking finding with no command to override (by design); then the leftover must be cleaned by hand on the database |
| R16 | Break-glass needed (production hotfix without staging evidence) | none: activation is refused without a notification channel (OD-21); the CLI has no activation command; the documented alternative is to apply to staging first (the evidence) | ∞ | | by design no emergency exit for a no-evidence hotfix on this installation |
| R17 | Step-up refused (`code_attempts`, `grant_revoked`) or expired | `exponetdb auth reauth` (new step-up), then the command again | 2 + browser | passkey/TOTP | `refused` has no unlock; a new step-up is the only path (fine) |
| R18 | Enrollment token unused/expired | `node enrollment create` again (plan, apply, reveal) | 1 + step-up | step-up for the reveal; OD-67 (two receipts) open | the old token is never marked `expired` in the table (SM-8), only by time |
| R19 | Restore stuck: `needs_attention`, or a scratch left after a drill | `restore list <cluster>` → `restore discard <cluster> <restore>` → `plan apply <pln>` | 3 | standard class | a recovery restore in `ready` can only be discarded, not promoted (R12) |
| R20 | ExponetDB upgrade went wrong after `control-store migrate` | roll **forward**: fix and redeploy release N+1; rollback of the roles to N is refused by N (`schema_newer`) | 2+ | owner | `upgrades.md:15` promises a one-release rollback without a schema rollback (DC-046); the only rollback is restoring the Control Store from the pre-upgrade `pg_dumpall` (RB-10), which loses everything after the dump and leaves every target's ledger mirror unexplained (R21). **The runbook has no pre-upgrade backup step** (`upgrades.md`, `deployment.md` §6) |
| R21 | Control Store restored from backup (RB-10) | `control-store status`, `audit verify --from-checkpoint`, `keyring status` (server, container); then per target `migration ledger reconcile` (R11); re-plan lost operations | 4 + 5 per target | owner; prod: approval + re-auth per target | plans, approvals and operations after the dump are gone; targets' ledgers then hold rows "no operation of this target wrote" (`unrecorded`), so **every** plan is refused until each target is reconciled; `OD-55`-style break-glass is unavailable; the runbook says only "Reconcile ledger mirrors" (DC-057) |

## Summary

Counts: 21 failure states examined. **Recoverable with the CLI alone** (given the right scope): R2 (partly),
R3, R4, R7, R9, R11, R13, R15, R17, R18, R19 = 11. **Need the Web App or REST** (a browser step the product
requires, or a missing CLI command): R1, R8c, R10b, R12 (unknown), R14 (cannot act at all) = 5.
**No exit at all** from any interface: R5, R6, R16 = 3; **rollback not possible**: R20; **blast radius
unaddressed by the runbook**: R21.

The three genuine dead ends are the same defect seen from three sides: the engine parks an operation in
`needs_attention` and keeps its locks, a recovery exists only for four migration kinds, and the tool the
docs name for the rest (`operation.force_release`) was never built. The cheapest fix that closes all three
is a first-class **close/abandon** command for `needs_attention` (human, class `high`, re-auth, audited, never
re-executes), listed in `proposals.md` by the tester who owns that file; the owner's decision OD-58 option
(b) already names it ("also build `operation.force_release`").

## What a person with only the CLI cannot do, in one list

1. Accept drift (`drift.accept`): Web App only.
2. Activate break-glass: Web App only, and refused by the installation (OD-21).
3. Approve or reject: browser only.
4. Store a corrected `verify.sql` revision (the documented repair of E2/E10).
5. List or inspect stored bundle revisions.
6. Close a `needs_attention` operation of any non-migration kind, or one with outcome `unknown` whose migration
   is not applied.
7. Release a lock of a lost worker (`operation.force_release`).
8. Move a target to a recovered cluster (no placement move; RB-08 step 7).
9. Adopt a running cluster into agent mode (`registry.cluster.adopt_agent`: REST only; the CLI keeps
   its token private).
10. Get a token for any REST fallback: `auth` has `status|presets|scopes|reauth`, no `token`.
