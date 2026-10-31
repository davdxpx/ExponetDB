# Baseline of the verification campaign

| | |
|---|---|
| Pre-fix commit (first campaign) | `d02295503bcfb7a4a4baea860bd9fceebe80b8b4` (PR #43, Wave 9 Part B) |
| Commit under test | `d51da5d0d8832ebc569f23985c7e5176e4d450ad` = `origin/main` after `git fetch origin --prune` on 2026-10-28 (merge of PR #46, 2026-10-28 19:01 UTC) |
| Evidence PR of the first campaign | #45, merged as `92a416f4` (2026-10-28 12:58 UTC) |
| Fix PR | #46 `fix: test campaign of 2026-10-27 (13 P1 findings fixed, 7 owner decisions recorded)`, 34 commits, merge commit `d51da5d0` |
| Worktrees used | `ExponetDB-verify` (detached at the commit under test, read-only), `ExponetDB-verify-evidence` (branch `feat/verification-campaign-2026-10-28`, evidence only) |
| Date | 2026-10-28 |

The fix PR was merged, so the commit under test is `origin/main` and not the head of a
fix branch. Its description still said "Not merged, not deployed" when it was merged; the
description's own status table is quoted below because it bounds what Block R can expect.

## What the fix claims (PR #46 body, quoted as claims, not as facts)

| Status | Findings |
|---|---|
| Implemented, tested locally (29) | TC-001 to TC-015, TC-018, TC-019, TC-022, TC-029 to TC-033, TC-035, TC-036, TC-039, TC-049 to TC-051 |
| Partly (7) | TC-016, TC-021, TC-026, TC-028, TC-038, TC-042, TC-054 |
| Documented (1) | TC-068 |
| Owner decision, nothing built (8) | TC-017, TC-020, TC-023, TC-024, TC-034, TC-037, TC-053, TC-063 |
| Not started (30) | listed with reasons in `PRE-WAVE-11-REVIEW.md` ("TC-1a") |

Consequence for Block R: 30 findings cannot be FIXED by construction. Their verdict is
NOT FIXED after a re-run of the reproduction, and 8 are CHANGED BY DECISION.

The PR also says what it did **not** run: no real-engine proof of the specific backup and
restore cases (TC-009, TC-011, TC-012), no real-browser check of TC-035/TC-038, and the
default one-shot `bun run verify` aborted on its machine in `postgres#test` on absolute
timing assertions under load (see finding candidates in `R/` and `A/`).

## Size of the change

`git diff --stat d0229550 d51da5d0`: 271 files, +17,353 / -333. Excluding the first
campaign's evidence folder (which arrived through #45, not through the fix): 173 files,
+8,724 / -333. Files changed by area (code and docs, evidence folder excluded):

| Area | Files | Area | Files |
|---|---|---|---|
| `packages/migrations-engine` | 18 | `packages/operations` | 8 |
| `apps/web` | 14 | `packages/policy` | 5 |
| `apps/server` | 13 | `packages/diagnostics` | 5 |
| `agent/node` | 13 | `packages/contracts` | 5 |
| `apps/cli` | 12 | `packages/application` | 5 |
| `packages/postgres` | 10 | `packages/backups` | 4 |
| `packages/control-store` | 10 | `tooling/checks` | 2 |
| `packages/nodes` | 9 | docs (`exponetdb-docs/*`) | about 28 |

## New migration bundles (Control Store), all additive, none in `frozen-bundles.json`

| Bundle | Purpose (TC) | Depends on | Notable |
|---|---|---|---|
| `01M61AGQKSBZ9VN71DHYFVCQHT_operation-supersession` | TC-005 | `01M5X840BP8JXGEQGS0PHPTB58` (operations, frozen) | **replaces** `operations.operation_guard` (a function of a frozen bundle) with a new text and adds `operations.recovery_transition_allowed` |
| `01M61C90YHV706H2B8EW39TBAF_ledger-reconcile` | TC-007 | operation-supersession | new `migrations.ledger_mirror_history`, `SECURITY DEFINER migrations.archive_mirror_rows` callable by the worker for a running `ledger.reconcile` operation |
| `01M61FKAJN5VP9H2E73K74NCZ2_offline-drill-record` | TC-013 | ledger-reconcile | `SECURITY DEFINER backups.record_offline_drill` executable by `exdb_serve` |

Two `SECURITY DEFINER` functions and one replaced guard function are exactly the kind of
change that needs a security read of its own; it is part of Block D (see `D/`).

The three bundles chain through `dependsOn` in a line (each depends on the previous one);
that is a choice of the fix session, not a requirement, and the three are not in
`frozen-bundles.json` yet (the freeze list is per wave; whether a bundle that was merged
to `main` and may be deployed is frozen from the moment of deployment is a policy
question: `F/decisions-*.md`).

## Frozen files (a change would be at least P1 until an ADR says otherwise)

| Frozen thing | Where | Changed between `d0229550` and `d51da5d0`? |
|---|---|---|
| `packages/control-store/frozen-bundles.json` | the freeze list of Control Store bundles | **no** |
| `packages/control-store/test/immutable-bundles.test.ts` | pins the frozen bundles | **no** |
| golden vectors `tooling/golden/*.json` (c1, ls1, fp1, plan-hash, jcs, ids, audit-chain, node-*) and `tooling/golden/LOCK.json` | append-only | **no** |
| c1 / checksum code `packages/migrations/**` | `sha256:c1:` | **no** |
| `packages/kernel/**` (JCS, plan hash) | frozen behaviour | **no** |
| `packages/postgres/src/introspection/canonical.ts` (fp1) | frozen | **no** |
| Go conformance and canon (`agent/node/internal/conformance`, `internal/canon`) | mirrors of the above | **no** |

Method: `git diff --name-status d0229550 d51da5d0 -- <paths>`; the CI check
`bun run golden:check` and `bun run golden:history` is run in Block A (`A/README.md`) on the
pinned toolchain, and its result there overrides this static statement.

Other contract changes that the fix made and that readers of the API see: new error code
`HBA_WOULD_LOCK_OUT`, `CAPABILITY_UNAVAILABLE` gets optional `details`, a new policy rule
`node.lifecycle-reauth` (the policy version changes: plans made before the deployment
carry the old one), the CLI command `access grants` was removed, and a total token budget
of 1,000,000 for a legacy import (TC-021). `packages/contracts/generated/*.json` changed
(generated).

## Toolchain note

CI and the engines field: Node `>=24.22.1 <25`, Bun `>=1.4.4`, Go 1.26.10, Ubuntu 24.04,
UTC. The lead's machine runs Node 26.5.0, Bun 1.3.14 and has no Go; verdicts come from the
disposable servers (`D/infra/bootstrap.sh`), not from the lead's machine.
