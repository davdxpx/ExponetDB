# E1: the error catalog, checked against code, docs and the CLI

Block E, item 3 (static, plus two pure-code probes). Sources at `d51da5d0`:
`packages/contracts/src/errors.ts` (129 codes) and its generated twin
`packages/contracts/generated/catalog.json`; the human catalog
`exponetdb-docs/02-control-plane/error-model.md` §3; the CLI exit mapping
`apps/cli/src/cli/exit.ts:1-80`; the human renderer `apps/cli/src/output/render.ts:150-210`.

## 1. Result in numbers

| Question | Answer |
|---|---|
| Catalog codes (`errors.ts`) vs rows of the docs table | 129 / 129, no code missing on either side (checked with a script) |
| Codes with a documented cause | 129 (every row has a "Meaning") |
| Codes with a `remediation` field in the catalog | 38 of 129 |
| Codes with neither a `remediation` field nor a remedy hint in the documented meaning (keyword heuristic, so an upper bound of 69) | 69; the operationally important ones are listed in §3 |
| Codes with a CLI exit mapping of their own | 33 (3: 11 auth, 4: 17 blocked, 5: 3 unavailable, 2: 1 usage, 6: 1) |
| Codes that fall through to exit 1 | 96 (incl. every `409` that means "a person must act" and not named in `BLOCKED`) |
| Codes **named by no server-side source file** (cannot be produced) | 13: `ORDER_DIVERGES_FROM_EVIDENCE`, `OPERATION_CONFLICT`, `MIGRATION_DEPENDENCY_UNVERIFIED`, `MIGRATION_REQUIREMENT_UNMET`, `STAGING_EVIDENCE_MISSING`, `STAGING_VERIFICATION_FAILED`, `STAGING_EVIDENCE_UNREACHABLE`, `EVIDENCE_CHAIN_MISCONFIGURED`, `BACKUP_NOT_VERIFIED`, `TOKEN_EXPIRED`, `BACKUP_FAILED`, `RESTORE_FAILED`, `SAMPLE_STALE` |
| String-literal error codes thrown in code but **not in the catalog** | 135 distinct lower/upper-case literals found by a regex sweep; 5 are relevant to an operator (§4), the rest are internal (`control_store_*`, `secret_*`, `keyring_*`, `migrate_*`, OAuth RFC 6749 codes, CLI-local codes) |
| Human catalog table in sync with `errors.ts` | yes; the docs table also lists the generated codes with identical statuses |

The per-code table is in §6. "Server files naming it" is a count of non-test source
files under `packages/*` (without `contracts`, `ui*`, `sdk`) and `apps/server/src` that contain
the code as a token; 0 means no code path can emit it.

## 2. Codes that are documented and exist but are never produced

These are `[DECIDED]` behaviour in the docs that has no implementation behind it (the
catalog entry is the only trace). A client that waits for them waits for ever, and an
operator who reads the docs is told the wrong thing.

| Code | What the docs promise | What actually happens |
|---|---|---|
| `STAGING_EVIDENCE_MISSING`, `STAGING_VERIFICATION_FAILED`, `STAGING_EVIDENCE_UNREACHABLE`, `EVIDENCE_CHAIN_MISCONFIGURED`, `MIGRATION_DEPENDENCY_UNVERIFIED` | `staging-production-policy.md`, `error-model.md` §3 | evidence and dependency verification are evaluated as **policy rules** (`migration.staging-evidence`, `migration.dependencies-verified`, `packages/policy/src/catalog/migrations.ts`) and surface as `POLICY_DENIED` with `details.rules`; the CLI maps four of the five to exit 4 (`exit.ts:34-52`) and the Web App has message keys for at least two of them (`apps/web/src/lib/i18n/messages/changes.ts:202,223`) for codes the server never sends |
| `MIGRATION_REQUIREMENT_UNMET` | E13/E14 "denied" at plan time | `requirementsUnmet` is a **fact** of the planner (`planner.ts:679-716`) that a rule turns into `POLICY_DENIED`; the code is unused |
| `ORDER_DIVERGES_FROM_EVIDENCE` | `dependency-graph.md:114`: production applies unordered overlapping migrations in staging's order, otherwise this error | the "production follows staging order" mechanism is not implemented (no occurrence outside `contracts`); the doc is `[DECIDED]` |
| `OPERATION_CONFLICT` | inline-plan actions with `wait: false` get it | zero occurrences outside `contracts`; `connections.cancel` etc. do not use the exclusivity wait |
| `BACKUP_NOT_VERIFIED`, `BACKUP_FAILED`, `RESTORE_FAILED` | backup domain codes | unused; failures surface as operation `errorCode`s of other names or as findings |
| `TOKEN_EXPIRED`, `SAMPLE_STALE` | authentication / diagnostics | unused (the OAuth layer answers `invalid_grant` / `invalid_token`) |

Finding **ER-1** (P3): remove or implement; at minimum mark in `error-model.md` which codes
are "reserved". The CLI `BLOCKED` set and the Web App key map reference five of them.

## 3. Codes without a remedy that an operator will meet

Selected from the 69; each is something that can happen during an apply, restore or
recovery, and the message says what is wrong but not what to do next. Where the *docs* give
a remedy elsewhere it is noted.

| Code | Situation | Remedy visible in the error? | Where the remedy is |
|---|---|---|---|
| `MIGRATION_DEPENDENCY_MISSING`, `MIGRATION_DEPENDENCY_UNKNOWN` | a plan names a migration whose dependency is neither applied nor in the plan | no (ids in `details.missing`) | `dependency-graph.md` |
| `LEDGER_NOT_INITIALIZED` | target without `exponetdb` schema | no | `ledger.md` §4 (`target.identity.stamp` / `ledger.initialize`); no CLI command named in the error |
| `TARGET_IDENTITY_MISMATCH`, `CLUSTER_IDENTITY_MISMATCH` | marker or system identifier differs (restore, copy, other installation) | no | `ledger.md` §1/§5 say "re-stamp / reconcile"; no error text points at `migration ledger reconcile` |
| `TARGET_CREDENTIAL_INVALID`, `TARGET_TLS_FAILED`, `TARGET_UNAVAILABLE`, `NODE_OFFLINE`, `NODE_REVOKED`, `JOB_EXPIRED` | connectivity / credential failures during plan or apply | no | `incident-model.md` runbooks, by name |
| `SCHEMA_FINGERPRINT_MISMATCH`, `VERIFICATION_FAILED`, `POLICY_DENIED`, `BACKUP_REQUIRED` | the daily "why did it stop" codes | no; the ids and rules are only in `details` (see §5) | plan view |
| `RESTORE_SOURCE_INVALID`, `RESTORE_TARGET_MISMATCH` | recovery planning | no | `restore.md` |
| `PLAN_ALREADY_USED` | a second caller applies a consumed plan | no, and no operation id | none |
| `INTERNAL` | anything the code maps to "unknown" | no (by design) | request id only |

Finding **ER-2** (P3): fill `remediation` for the ~20 operational codes above, with the exact
CLI command where one exists (`exponetdb migration ledger reconcile`, `operation show`, ...).

## 4. Codes thrown that are not in the catalog

`errorCodeOf()` (`apps/server/src/interfaces/http/request.ts:152-162`) maps every code that is
not a catalog code to `INTERNAL` (HTTP 500, "retryable"). Probe, run (`probe1.ts`, pure code):

```
operation_kind_unknown   isErrorCode: false
operation_state_changed  isErrorCode: false
PLAN_STALE               isErrorCode: true
```

| Literal (source) | Where it escapes | What the caller sees | Should be |
|---|---|---|---|
| `operation_kind_unknown` (`operations/src/accept.ts:192`) | applying a plan whose `kindVersion` differs from the registered kind: exactly the "plan created by the previous version" case of `upgrades.md` §1, `[DECIDED]`: "they expire with `PLAN_STALE` (reason `engine_version`)" | **500 INTERNAL** | `PLAN_STALE` with a binding `kindVersion` (finding **ER-3**, P2) |
| `operation_state_changed` (7 sites, e.g. `plans.ts:361`, `accept.ts:242`, `idempotency.ts:76,92`, `locks.ts:103`, `transitions.ts:133`) | a race that the row locks normally serialise (two applies, two cancels, a plan consumed between read and write); rare, but then the answer is not a catalog code | **500 INTERNAL**, retryable flag true | `PLAN_ALREADY_USED` / `OPERATION_CONFLICT` for the race (ER-3) |
| `idempotency_in_progress` (`idempotency.ts:72`) | a second request with the same `Idempotency-Key` while the first runs | **500 INTERNAL** | 409 with a retry-after; `IDEMPOTENCY_KEY_REUSED` is the only code the docs give (ER-3) |
| `operation_transition_invalid`, `operation_lease_lost` | internal guards | 500 INTERNAL | fine (documented as internal) |
| `WATCH_TIMEOUT`, `CREDENTIAL_FAILED`, `SCRATCH_NOT_READY` (CLI only: `commands/node.ts:728`, `plan.ts:609`, `registry.ts:1382-1394`, `migration.ts:1162`) | printed as `Error WATCH_TIMEOUT: ...` with explicit exit codes | stable and shown, but not in the catalog or in `error-model.md`; `README §5` documents exit 6 only generically | add a "CLI-local codes" table (ER-4, P3) |
| `TARGET_SQL_ERROR` (`diagnostics/src/statements.ts:181` and 15 more sites) | diagnostics error class with catalog-like spelling | not a catalog code; sits next to the catalog entry `TARGET_UNAVAILABLE`, so a search for "TARGET_" finds two vocabularies | rename or document (P3) |

Internal and protocol literals (`control_store_*`, `secret_*`, `keyring_*`, `migrate_*`,
`audit_*`, `bootstrap_*`, `recovery_*`, OAuth `invalid_grant` ...) are one-shot command
codes or RFC codes; they are not part of the REST catalog by design, and the server
one-shot commands print them as `exponetdb: refused (<code>)` (`apps/server/src/commands/index.ts:163-185`),
exit 2 for configuration and 1 for failures. They are not listed in any document either; an
operator reading `migrate_schema_newer` or `keyring_missing` has no catalog to look it up in
(P3, ER-5: a "server command errors" table in `12-operations/deployment.md`).

## 5. Errors that hide the ids or name the wrong object

### 5.1 The CLI does not print most `details` (ER-6, P2, run)

`renderHuman()` (`apps/cli/src/output/render.ts:150-210`) prints `remediation`, up to five
`details.errors[]` lines, and the named keys `migrationId`, `reason`, `extension`, `missing`,
`cycle`. Everything else in `details` is only in `--output json`. Probe `probe2.ts` (pure
code, `renderHuman` with the catalog's real `details` shapes):

```
PLAN_STALE                   => []   (changedBindings: which binding changed, expected, actual, hint)
OPERATION_CONFLICT           => []   (blockingOperationId)
MIGRATION_EXECUTION_FAILED   => []   (sqlstate, statementIndex, position, applyOutcome)
POLICY_DENIED                => []   (the failed rules)
APPROVAL_COOLING_PERIOD      => []   (notBefore)
OPERATION_NOT_RETRYABLE      => []   (state)
VERIFICATION_FAILED          => []   (checks)
LEDGER_DIVERGENCE            => [missing: ...]   (checksumDiffers and unrecorded hidden)
MIGRATION_CHECKSUM_MISMATCH  => [migrationId: ...]   (knownChecksum and where hidden)
```

So the most common 3 a.m. refusal, `PLAN_STALE`, prints "The plan no longer matches the
target. Create a new plan." and nothing about **which** binding changed (the migration that
was applied meanwhile, the fingerprint, the generation); the person must rerun with `--json`.
The same holds for a `POLICY_DENIED` apply (which rule) and a `MIGRATION_EXECUTION_FAILED`
(which statement, which SQLSTATE) when it is raised synchronously. For operations that fail
after acceptance the operation view (`operation show`) has per-migration progress with
`sqlstate` and statement index, so that path is better; the synchronous refusals are the gap.

### 5.2 The error text names no object

The catalog message is fixed text and the ids live in `details`, so any consumer that shows only
the message hides them. Codes where the message says "this", "a" or "the" and `details` carries
no id at all:

| Code | Missing object |
|---|---|
| `PLAN_ALREADY_USED` | which operation consumed the plan (the second caller cannot find it) |
| `STAGING_*`, `MIGRATION_DEPENDENCY_UNVERIFIED` | which migration, which evidence target (unused codes, but the rule results carry them) |
| `MIGRATION_ALREADY_APPLIED`, `MIGRATION_REQUIREMENT_UNMET`, `MIGRATION_LOCK_TIMEOUT` | which migration, which requirement, which lock holder |
| `MIGRATION_EXECUTION_FAILED` | `statementIndex` without `migrationId`, in a plan with several migrations (the per-migration progress has it) |
| `SCHEMA_FINGERPRINT_MISMATCH` | expected and actual fingerprints |
| `LEDGER_NOT_INITIALIZED`, `TARGET_IDENTITY_MISMATCH`, `CLUSTER_IDENTITY_MISMATCH`, `TARGET_SUSPENDED` (reason only) | which target |
| `RESTORE_SOURCE_INVALID`, `RESTORE_TARGET_MISMATCH`, `BACKUP_REPOSITORY_UNAVAILABLE`, `BACKUP_REQUIRED` | which backup, repository or cluster |
| `APPROVAL_NOT_PENDING` | the operation's actual state |

### 5.3 Wrong object / double meaning

* `OPERATION_NOT_FOUND` / `PLAN_NOT_FOUND` also answer "exists but you may not read it"
  (existence hiding, by design, `existence.ts`); with `retry-verification` a caller who may
  not read the operation gets `OPERATION_NOT_FOUND`, which looks like a typo.
* `OPERATION_CANCELLED` is the `errorCode` of both a rejection and a cancel (SM-7).
* `STAGING_VERIFICATION_FAILED` is documented as "applied on the evidence target, but
  verification **failed or is pending**": two situations with opposite remedies (re-verify vs
  wait); unused, but the sentence is the contract.
* `VERIFICATION_ERROR` is "retryable" (`R`), yet the corresponding operation state
  `needs_attention` has no retry for most kinds (SM-1).
* `VERIFICATION_FAILED` is `200 in operation / 409 on sync calls` (catalog `statusNote`), a code
  whose HTTP status depends on the call.

## 6. CLI exit mapping against `15-cli/README.md` §5

Documented: `4` = "policy, approval or evidence blocks; a person must act". `BLOCKED` in `exit.ts:34-52`
lists 17 codes (five of them are never emitted). Codes with the same meaning that fall to **exit 1**:
`HUMAN_APPLY_REQUIRED` (403, "a person applies this plan"), `APPROVALS_PENDING_LIMIT`,
`FEATURE_NOT_ACTIVATED` (an owner must activate), `MIGRATION_INCOMPLETE` (needs `migration resume`),
`LEDGER_DIVERGENCE` (needs `ledger reconcile`), `TARGET_SUSPENDED`, `MIGRATION_ROLLBACK_BLOCKED`,
`LEGACY_IMPORT_TRUNCATED`, `LEGACY_IMPORT_ANALYSIS_OUTDATED`, `RECOVERY_REQUIRED`. And
`TARGET_UNAVAILABLE`, `TARGET_TLS_FAILED`, `NODE_OFFLINE`, `BACKUP_REPOSITORY_UNAVAILABLE` (retryable
503s) exit **1**, while "transport failure, server unavailable" is `5`. A CI script cannot tell "fix it
yourself" (1) from "ask a person" (4) for these. Owner decision requested in
`../F/decisions-E1.md` (D-E1-4); finding **ER-7** (P3).

## 7. The catalog

`R` = retryable. Remedy: `F` = `remediation` field in the catalog, `D` = only a hint inside the
documented meaning (keyword heuristic), `-` = none.

### plans_and_operations

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `PLAN_STALE` | 409 | - | F | changedBindings,planId | 26 | 1 |
| `PLAN_EXPIRED` | 409 | - | F | - | 1 | 1 |
| `ORDER_DIVERGES_FROM_EVIDENCE` | 409 | - | F | - | 0 | 1 |
| `PLAN_ALREADY_USED` | 409 | - | - | - | 2 | 1 |
| `PLAN_NOT_FOUND` | 404 | - | F | - | 3 | 1 |
| `PLAN_BINDING_ACTOR` | 403 | - | - | - | 4 | 1 |
| `PLAN_DENIED` | 403 | - | - | - | 1 | 4 |
| `APPROVAL_REQUIRED` | 409 | - | D | - | 2 | 4 |
| `HUMAN_APPLY_REQUIRED` | 403 | - | F | planId | 1 | 1 |
| `APPROVALS_PENDING_LIMIT` | 409 | - | F | - | 1 | 1 |
| `REAUTH_REQUIRED` | 401 | - | - | - | 7 | 3 |
| `APPROVAL_COOLING_PERIOD` | 409 | R | D | notBefore | 1 | 4 |
| `SELF_APPROVAL_UNACKNOWLEDGED` | 422 | - | - | - | 1 | 4 |
| `APPROVAL_NOT_PENDING` | 409 | - | D | - | 1 | 1 |
| `APPROVAL_DUPLICATE` | 409 | - | D | - | 1 | 1 |
| `BREAK_GLASS_REQUIRED` | 403 | - | - | rules | 2 | 4 |
| `BREAK_GLASS_UNAVAILABLE` | 409 | - | F | reason | 2 | 4 |
| `OPERATION_NOT_FOUND` | 404 | - | F | - | 3 | 1 |
| `OPERATION_CONFLICT` | 409 | R | D | blockingOperationId | 0 | 1 |
| `OPERATION_NOT_CANCELABLE` | 409 | - | D | state | 1 | 1 |
| `OPERATION_NOT_RETRYABLE` | 409 | - | D | state | 1 | 1 |
| `OPERATION_CANCELLED` | 409 | - | - | - | 4 | 1 |
| `OUTCOME_UNKNOWN` | 409 | - | D | - | 3 | 6 |
| `PRECONDITION_FAILED` | 412 | - | D | - | 5 | 1 |
| `IDEMPOTENCY_KEY_REUSED` | 422 | - | - | - | 1 | 1 |

### migrations

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `MIGRATION_CHECKSUM_MISMATCH` | 409 | - | F | knownChecksum,migrationId,where | 3 | 1 |
| `MIGRATION_DEPENDENCY_MISSING` | 409 | - | - | missing | 3 | 1 |
| `MIGRATION_DEPENDENCY_UNVERIFIED` | 409 | - | - | - | 0 | 1 |
| `MIGRATION_DEPENDENCY_CYCLE` | 422 | - | - | cycle | 5 | 1 |
| `MIGRATION_DEPENDENCY_UNKNOWN` | 422 | - | - | migrationId,missing | 5 | 1 |
| `MIGRATION_MANIFEST_INVALID` | 422 | - | - | errors | 3 | 1 |
| `MIGRATION_BUNDLE_INVALID` | 422 | - | - | file,reason | 8 | 1 |
| `MIGRATION_LINT_BLOCKED` | 422 | - | - | findings | 1 | 4 |
| `MIGRATION_ALREADY_APPLIED` | 409 | - | - | - | 3 | 1 |
| `VERIFY_CONSTRUCT_UNSUPPORTED` | 422 | - | F | check,construct | 5 | 1 |
| `MIGRATION_STATEMENT_FORBIDDEN` | 422 | - | F | check,construct | 7 | 1 |
| `MIGRATION_LOCK_TIMEOUT` | 409 | - | F | - | 6 | 1 |
| `MIGRATION_EXECUTION_FAILED` | 422 | - | D | applyOutcome,position,sqlstate,statementIndex | 1 | 1 |
| `MIGRATION_REQUIREMENT_UNMET` | 409 | - | - | - | 0 | 1 |
| `MIGRATION_INCOMPLETE` | 409 | - | F | migrationId | 3 | 1 |
| `MIGRATION_REVERTED` | 409 | - | F | migrationId | 4 | 1 |
| `MIGRATION_ROLLBACK_BLOCKED` | 409 | - | F | migrationId,reason | 1 | 1 |
| `VERIFICATION_FAILED` | 409 | - | - | checks | 6 | 1 |
| `VERIFICATION_ERROR` | 409 | R | D | - | 4 | 1 |
| `SCHEMA_FINGERPRINT_MISMATCH` | 409 | - | - | - | 3 | 1 |
| `LEDGER_DIVERGENCE` | 409 | - | D | checksumDiffers,missing,unrecorded | 3 | 1 |
| `LEDGER_NOT_INITIALIZED` | 409 | - | - | - | 3 | 1 |
| `LEGACY_IMPORT_AMBIGUOUS` | 409 | - | - | items,total | 1 | 4 |
| `LEGACY_IMPORT_TRUNCATED` | 409 | - | F | driftTotal,held | 1 | 1 |
| `LEGACY_IMPORT_ANALYSIS_OUTDATED` | 409 | - | F | items | 1 | 1 |

### evidence_and_policy

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `STAGING_EVIDENCE_MISSING` | 409 | - | - | - | 0 | 4 |
| `STAGING_VERIFICATION_FAILED` | 409 | - | - | - | 0 | 4 |
| `STAGING_EVIDENCE_UNREACHABLE` | 409 | R | - | - | 0 | 4 |
| `EVIDENCE_CHAIN_MISCONFIGURED` | 409 | - | - | - | 0 | 4 |
| `POLICY_DENIED` | 403 | - | - | rules | 2 | 4 |
| `MAINTENANCE_WINDOW_REQUIRED` | 409 | - | - | - | 1 | 4 |
| `BACKUP_REQUIRED` | 409 | - | - | newerThan | 1 | 4 |
| `BACKUP_NOT_VERIFIED` | 409 | - | - | - | 0 | 4 |

### authentication_and_authorization

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `UNAUTHENTICATED` | 401 | - | - | - | 3 | 3 |
| `TOKEN_EXPIRED` | 401 | - | D | - | 0 | 3 |
| `INSUFFICIENT_SCOPE` | 403 | - | F | requiredScope | 6 | 3 |
| `PERMISSION_DENIED` | 403 | - | F | - | 19 | 3 |
| `TARGET_NOT_IN_GRANT` | 403 | - | - | - | 3 | 3 |
| `TIER_NOT_PERMITTED` | 403 | - | - | - | 3 | 3 |
| `GRANT_REVOKED` | 401 | - | - | - | 3 | 3 |
| `CLIENT_NOT_APPROVED` | 403 | - | D | - | 2 | 3 |
| `AUTHORIZATION_REQUEST_INVALID` | 400 | - | F | - | 1 | 1 |
| `USER_CODE_INVALID` | 400 | - | F | - | 1 | 1 |
| `SCOPE_NOT_DELEGABLE` | 403 | - | - | scopes | 3 | 1 |
| `PRODUCTION_CONFIRMATION_REQUIRED` | 400 | - | - | - | 2 | 4 |
| `CLIENT_METADATA_INVALID` | 422 | R | - | reason | 2 | 1 |
| `AUTHENTICATION_FAILED` | 401 | - | - | - | 4 | 3 |
| `SESSION_EXPIRED` | 401 | - | - | - | 5 | 3 |
| `AMBIGUOUS_CREDENTIALS` | 400 | - | - | - | 1 | 1 |
| `CSRF_FAILED` | 403 | - | - | - | 1 | 1 |
| `AUTH_CHALLENGE_EXPIRED` | 401 | - | D | - | 2 | 1 |
| `AUTH_CHALLENGE_INVALID` | 401 | - | - | - | 5 | 1 |
| `LINK_INVALID` | 401 | - | - | - | 1 | 1 |
| `RECOVERY_REQUIRED` | 403 | - | D | - | 1 | 1 |
| `PASSWORD_REJECTED` | 422 | - | - | reason | 2 | 1 |
| `ENROLLMENT_INCOMPLETE` | 409 | - | D | - | 1 | 1 |
| `IDENTITY_EXISTS` | 409 | - | - | - | 1 | 1 |
| `IDENTITY_STATE_INVALID` | 409 | - | D | - | 3 | 1 |
| `BINDING_EXISTS` | 409 | - | - | - | 1 | 1 |
| `LAST_FACTOR` | 409 | - | - | - | 1 | 1 |
| `OWNER_INVARIANT` | 409 | - | D | - | 1 | 1 |

### targets_clusters_nodes

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `TARGET_NOT_FOUND` | 404 | - | F | - | 30 | 1 |
| `TARGET_SUSPENDED` | 409 | - | - | reason | 5 | 1 |
| `TARGET_UNAVAILABLE` | 503 | R | - | - | 27 | 1 |
| `TARGET_CREDENTIAL_INVALID` | 503 | - | - | - | 5 | 1 |
| `TARGET_TLS_FAILED` | 503 | - | - | - | 5 | 1 |
| `TARGET_IDENTITY_MISMATCH` | 409 | - | - | - | 15 | 1 |
| `CLUSTER_IDENTITY_MISMATCH` | 409 | - | - | - | 13 | 1 |
| `TARGET_REGISTRATION_REFUSED` | 409 | - | F | reason | 4 | 1 |
| `REGISTRY_CONFLICT` | 409 | - | D | reason | 15 | 1 |
| `NODE_OFFLINE` | 503 | R | - | - | 1 | 1 |
| `NODE_REVOKED` | 409 | - | - | - | 2 | 1 |
| `CAPABILITY_UNAVAILABLE` | 409 | - | F | extension,reason | 9 | 1 |
| `JOB_EXPIRED` | 409 | - | - | - | 1 | 1 |
| `NODE_PROTOCOL_UNSUPPORTED` | 400 | - | F | - | 2 | 1 |
| `NODE_ENROLLMENT_REFUSED` | 401 | - | F | - | 3 | 1 |
| `NODE_PROOF_INVALID` | 400 | - | - | - | 3 | 1 |
| `NODE_ALREADY_ENROLLED` | 409 | - | F | - | 5 | 1 |
| `NODE_CERTIFICATE_REFUSED` | 403 | - | - | - | 3 | 1 |
| `NODE_CAPABILITY_FAILED` | 422 | - | F | - | 3 | 1 |
| `HBA_WOULD_LOCK_OUT` | 409 | - | F | address,database,method,role,rule | 1 | 1 |
| `NODE_OBSERVATION_STALE` | 409 | - | F | capability | 1 | 1 |

### backup_and_restore

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `BACKUP_FAILED` | 422 | - | - | - | 0 | 1 |
| `BACKUP_REPOSITORY_UNAVAILABLE` | 503 | R | - | - | 1 | 1 |
| `RESTORE_TARGET_MISMATCH` | 409 | - | - | - | 3 | 1 |
| `RESTORE_SOURCE_INVALID` | 409 | - | - | - | 1 | 1 |
| `RESTORE_FAILED` | 422 | - | - | - | 0 | 1 |
| `FEATURE_NOT_ACTIVATED` | 409 | - | F | current,setting | 2 | 1 |

### queries_and_diagnostics

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `QUERY_NOT_READ_ONLY` | 422 | - | F | - | 5 | 1 |
| `QUERY_CONSTRUCT_UNSUPPORTED` | 422 | - | - | construct | 5 | 1 |
| `QUERY_TIMEOUT` | 408 | R | - | - | 4 | 1 |
| `QUERY_FAILED` | 422 | - | F | sqlstate | 1 | 1 |
| `QUERY_CANCELED` | 409 | - | F | - | 3 | 1 |
| `QUERY_RESULT_TOO_LARGE` | 413 | - | - | cap | 2 | 1 |
| `QUERY_PARSE_ERROR` | 422 | - | - | position | 6 | 1 |
| `DATA_READ_NOT_PERMITTED` | 403 | - | F | - | 1 | 1 |
| `STATEMENT_NOT_AVAILABLE` | 404 | - | F | reason | 1 | 1 |
| `SAMPLE_STALE` | 503 | R | - | - | 0 | 1 |

### generic

| Code | HTTP | R | Remedy | Details keys | Server files naming it | CLI exit |
|---|---:|:-:|:-:|---|---:|---:|
| `VALIDATION_FAILED` | 422 | - | F | errors | 42 | 2 |
| `NOT_FOUND` | 404 | - | F | - | 40 | 1 |
| `CONFLICT` | 409 | - | D | - | 36 | 1 |
| `RATE_LIMITED` | 429 | R | D | retryAfterSeconds | 10 | 5 |
| `CONTROL_PLANE_DEGRADED` | 503 | R | - | - | 12 | 5 |
| `INTERNAL` | 500 | R | - | - | 65 | 5 |
