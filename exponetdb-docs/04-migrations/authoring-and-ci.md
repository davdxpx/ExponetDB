# Authoring, source references, CI and tooling

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; MCP rows of §3, §6 and §9 updated on 2026-10-13 for Wave 7 (G7 not yet accepted, [G7 record](../14-roadmap/gates/7.md)) |
| Applies to | Wave 6 (CLI, submission), Wave 10 (REOSA adoption), later waves (Git integration, CI) |
| Read before | [`migration-bundles.md`](./migration-bundles.md) |

## 1. Source reference model

**[DECIDED]** A bundle can carry a source reference. It is provider-neutral:

```yaml
source:
  repository: github.com/davdxpx/REOSA      # opaque repository identifier: host/path, no scheme, no credentials
  provider: github | gitlab | gitea | generic-git | none
  commit: 3f9c2b7…                           # full object id (40 hex for SHA-1, 64 hex for SHA-256 repositories)
  path: packages/db/exponetdb/migrations/01JB…_add-lead-index
  branch: feature/lead-inbox                 # optional, informative only (branches move; commits do not)
  provenance: claimed | verified
  providerMetadata: { pullRequest: 123 }     # optional, informative
```

- `commit` must be a full object id. Short ids, branch names or tags are
  rejected (`VALIDATION_FAILED`), because only an object id is immutable.
- `provenance: claimed` is the default: the client asserts where the bundle
  came from; ExponetDB records the claim and shows it as a claim.
  **The security binding is the checksum computed by ExponetDB over the bytes it
  received**, not the source reference.
- `provenance: verified` is set only by ExponetDB itself when a configured
  repository integration fetched the bundle at that commit and the bytes matched
  ([§3](#3-how-bundles-reach-exponetdb), [OD-6](../00-product/open-decisions.md#od-6-verified-provenance-for-production-migrations)).
- Source references never contain credentials, tokens or URLs with user info.

## 2. Bundle sources inside a consumer repository

**[DECIDED]** A project's stream may have several bundle **roots** (for example
REOSA's module-owned migrations under `apps/app/src/modules/*/db/…`), declared in
`exponetdb.project.yaml`. The CLI reads bundles in place from all roots; there is
no copy step and no derived journal file. Ids are globally unique ULIDs, so roots
cannot collide.

**[OBSERVED]** REOSA today copies 94 module migrations byte-for-byte into the
global directory and hand-maintains journal `idx`/`when` values; the journal has a
duplicated `idx` and two `when` mismatches (audit 2026-10-04). Reading roots in
place removes that class of error.

## 3. How bundles reach ExponetDB

| Path | Who | V1 | Notes |
|---|---|---|---|
| MCP `migration_plan` with inline bundles, or with `migrationIds` of bundles ingested earlier | AI agents | **yes** | The agent sends manifest, `up.sql`, `verify.sql`, optional `down.sql`, plus a claimed source reference. Size limits apply: 256 KiB per request in general, 16 MiB for the bundle-carrying tools (`migration_plan`, `migration_lint`). Optional `idempotencyKey`; no break-glass reference and no lint or invariant override. **[OBSERVED]** 2026-10-13, `packages/contracts/src/mcp/tools.ts`, `apps/server/test/mcp-plans.int.test.ts` |
| REST `POST /targets/{id}/migrations/plans` with inline bundles | CLI, CI, SDK | **yes** | Same payload. |
| CLI `exponetdb migration plan --target …` | humans, CI | **yes** | Reads bundles from the working tree, computes digests locally (the same code as the server), submits, prints the plan. |
| By reference to the bundle store | any | **yes** | A bundle already ingested (for example planned for staging) can be referenced by `(projectId, migrationId, checksum)`; this is the normal way to plan production after staging. |
| Repository integration (ExponetDB fetches from Git at a commit) | ExponetDB | **no (later)** | Gives `provenance: verified`; enables a policy "production migrations must exist on the protected branch at the given commit" ([OD-6](../00-product/open-decisions.md#od-6-verified-provenance-for-production-migrations)). |
| CI pushes signed artifacts | CI | **no (later)** | Sigstore/cosign-style signed bundle archives; another way to make provenance verifiable without giving ExponetDB repository credentials. |

**[DECIDED]** ([OD-6](../00-product/open-decisions.md#od-6-verified-provenance-for-production-migrations) (a), 2026-10-12) V1: client-submitted bundles plus the bundle store, provenance `claimed` only.
It is simple, works identically for agents, CLI and CI, and the safety properties
(checksum binding, staging evidence, approvals) do not depend on provenance.
Verified provenance is an additional control for production, added once the
basics run.

## 4. CLI

**[PLANNED]** `exponetdb` (package `apps/cli`, distributed as a single binary via
Bun compile or as an npm package; Wave 6):

| Command | Purpose | Talks to server? |
|---|---|---|
| `exponetdb migration new <name>` | Create `<ULID>_<name>/` with manifest skeleton, `dependsOn` = current heads | no |
| `exponetdb migration lint [paths…]` | All local lint rules (parse with libpg_query, DAG, manifest schema) | no |
| `exponetdb migration checksum [paths…]` | Print apply checksum, verify digest, rollback digest, source digest | no |
| `exponetdb migration graph` | Print the DAG, heads, pending sets (needs ledger state for pending) | optional |
| `exponetdb migration plan --target <path> [ids…]` | Submit and plan; print the plan; exit code reflects decision | yes |
| `exponetdb migration apply <planId>` | Apply; follow the operation; exit code reflects outcome | yes |
| `exponetdb migration status --target <path>` | Ledger, verification states, drift summary | yes |
| `exponetdb migration verify --target <path> <id>` | Re-run verification | yes |
| `exponetdb lock-key <target>` | Print the advisory-lock key pair ([`concurrency.md`](./concurrency.md)) | yes |
| `exponetdb secrets scram-verifier` | Read a password from stdin, print a SCRAM-SHA-256 verifier (for consumer login roles; the password never reaches ExponetDB, see [`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)) | no |

The checksum, DAG and lint code is the same package the server uses
(`packages/migrations`, subpaths `format/`, `graph/` and `lint/`, no I/O), so
local and server results cannot differ. The checksum code exists from Wave 1
([`../01-architecture/package-architecture.md` §1.1](../01-architecture/package-architecture.md#11-packagesmigrations-by-subpath-and-wave)).

## 5. CI integration

**[PLANNED]** (after V1 core; the CLI makes it possible from Wave 6):

```
pull request
  ├─ exponetdb migration lint            (no server)          → blocks on errors
  ├─ fresh replay on a disposable PostgreSQL (baseline + bundles) → blocks on failure
  ├─ double-apply guard: second run of the pending set must be refused by the ledger (never re-executed)
  ├─ ORM parity (optional adapter, §7)    → blocks on mismatch
  └─ exponetdb migration plan --target <project>/staging   (service account, migrations.plan) → posts plan summary
merge to default branch
  └─ exponetdb migration plan + apply --target <project>/staging   (service account with migrations.apply:nonprod)
       → verification result posted back
release / manual
  └─ production plan by a human or agent; approval in the Web App; apply
```

CI uses a **service account** with OAuth `client_credentials` (`private_key_jwt`)
or an API key, restricted to the project's non-production targets. CI never
holds `migrations.apply:prod` by default.

**[OBSERVED]** REOSA documents two CI gates for migrations that are not wired
(`db:restore-test`, `sync:module-migrations --check`), and its CI runner has been
offline since 2026-09-07 (`self-hosting-00-stand.md` §7). ExponetDB's own gates
therefore never assume the consumer's CI ran; the server re-runs every check at
plan time.

## 6. Authoring guidance (shipped as a design-system-like guide for agents)

**[OBSERVED]** (2026-10-13, Wave 7) The guide is served to every authenticated
MCP client as the resource `exponetdb://guides/migration-authoring`, next to
the manifest schema (`exponetdb://schemas/migration-manifest/v1`); its text
is `MIGRATION_AUTHORING_GUIDE` in `packages/contracts/src/mcp/resources.ts`
and is generated into [`../05-mcp/resources/migration-authoring.md`](../05-mcp/resources/migration-authoring.md).

- **Expand / contract.** Breaking changes are split: (1) expand (add new column,
  new table, dual-write in code), (2) migrate data in batches, (3) switch reads,
  (4) contract (drop old) in a later migration after the application no longer
  uses it. Each step is its own migration with its own compatibility class.
- **Indexes on non-trivial tables**: `CREATE INDEX CONCURRENTLY IF NOT EXISTS` in
  its own non-transactional bundle.
- **NOT NULL on non-trivial tables**: add `CHECK (col IS NOT NULL) NOT VALID`,
  `VALIDATE CONSTRAINT`, then `SET NOT NULL` (on PostgreSQL 18, `NOT NULL … NOT
  VALID` directly), then drop the check.
- **Foreign keys on non-trivial tables**: `ADD CONSTRAINT … NOT VALID`, then
  `VALIDATE CONSTRAINT` in a separate migration.
- **Grants and RLS in the same migration as the table** (REOSA's rule since
  `0172`, kept as a lint).
- **No conditional DDL** (`DO` blocks that branch on catalog state) unless
  unavoidable; it makes environments diverge and weakens staging evidence.
- **Always write `verify.sql`** that asserts the intent, including data
  post-conditions for backfills.

## 7. Framework adapters (ORM neutrality)

**[DECIDED]** The core engine knows SQL, bundles and PostgreSQL catalogs. It does
not know Drizzle, Prisma, Rails or Django ([C-34](../00-product/constitution.md#c-34-postgresql-knowledge-stays-behind-the-adapter) spirit, P-11).

**[PLANNED]** Optional adapters, outside the engine:

- **Bundle generation**: e.g. "turn the SQL that `drizzle-kit generate`
  produced into a bundle". Convenience only.
- **ORM parity check** (more valuable): compare the ORM-declared shape (tables,
  columns, types, nullability) with the fingerprint document of a database built
  from baseline + bundles. **[OBSERVED]** REOSA's Drizzle schema declares exactly
  the 408 tables the SQL creates, but column parity is checked by nothing, and
  lag shows up as production `42703` errors (audit 2026-10-04). The ORM schema is
  used as a verification target, not as the source of DDL.

## 8. Runtime schema contract

**[PLANNED]** (Wave 10) Missing migrations should be loud, not absorbed by
fail-soft code.

- An application build embeds the list of migration ids it requires (generated
  at build time from the bundle roots).
- The target exposes `exponetdb.missing_migrations(required text[]) RETURNS
  text[]`: a `SECURITY DEFINER` function owned by the ledger owner, `EXECUTE`
  granted to the consumer's application roles, reading only the ledger.
- The application's health/readiness check calls it **directly against the
  database** (no dependency on ExponetDB being up, C-29) and reports "schema
  behind" as unhealthy.

**[OBSERVED]** REOSA's fail-soft paths (`mirrorIdentities`, `getPublishedNav`,
status-console `guarded()` reads, column-subset selects in status probes) hid
missing migrations for weeks; REOSA's own rule says "fail-soft needs a counter-check".
The contract is that counter-check, generalized.

## 9. The agent workflow, end to end

1. Agent edits code and creates a bundle with `exponetdb migration new` (or writes
   the files following the manifest schema, which an MCP client reads as a
   resource).
2. Agent calls `migration_plan` for `reosa/platform/staging` with the bundle.
   Receives analysis, lint, decision `allow`.
3. Agent calls `plan_apply(planId)`. Receives the operation; observes
   `operation_get` until `succeeded` (applied + verified); with `waitSeconds`
   (at most 20) a call waits for the next change of state instead of polling
   blind.
4. Agent calls `migration_plan` for `reosa/platform/production` referencing the
   same migration id. Receives evidence (staging verified with the same checksum
   and verify digest), lineage, analysis, decision `require` (approval, because the
   client is an agent).
5. Agent calls `plan_apply(planId)`. Receives `awaiting_approval` with the
   `approvalUrl` (`<public origin>/approvals#operation=op_…`) in the result,
   and, when a modern-era client declared URL elicitation, also an
   elicitation to the approval page; the agent gives the link to its person.
   A `critical` plan (for example a `lossy` rollback on production) is not
   applied by an agent at all: `HUMAN_APPLY_REQUIRED`
   ([`../02-control-plane/operations-engine.md` §12](../02-control-plane/operations-engine.md#12-plans-and-operations-from-mcp-wave-7)).
6. The human opens the approval page in the Web App, reads plan and evidence,
   re-authenticates, approves (with compatibility attestation when required).
7. The operation runs; the agent observes `succeeded`.
