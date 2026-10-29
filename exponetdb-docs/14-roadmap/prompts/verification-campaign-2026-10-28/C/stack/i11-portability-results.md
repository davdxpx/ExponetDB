# I11 portability, run on the stack (tester S6)

Invariant I11: "Bundles are plain files; they validate, plan and apply from a Git checkout with the CLI, offline; the ledger in the target is
readable without ExponetDB (C-35)." Run with the Control Store container **and** serve, worker and gateway stopped (`scripts/i11-portability.sh`,
raw `i11.out` on the server). The project was copied as plain files into a new directory (no sign-in, an empty `EXPONETDB_CONFIG_DIR`).

## 1. What the CLI does with no server and no sign-in

| Command | Result | Remark |
|---|---|---|
| `exponetdb --version`, `commands`, `help`, `completion`, `init`, `agent-help`, `doctor` | works (rc 0) | `doctor` reports "0 sign-ins" and checks the parser |
| `project validate` | works (rc 0), 0.4 s | project file, bundle roots, 2 bundles |
| `migration lint` | works (rc 1 on a blocking finding), 0.4 s | "PostgreSQL 17 grammar, prod rules, **offline facts**"; text and `--json` |
| `migration checksum` | works (rc 0) | the `sha256:c1:...` apply checksum of each bundle; it equals the server's by design (`owner-test-package.md:80`) |
| `migration graph` | works (rc 0) | order from `dependsOn` |
| `migration plan --target ...` | **fails, rc 2** without a profile ("Name the server with --server, EXPONETDB_URL or a profile"); **rc 5 `TRANSPORT_FAILED`** "The server at ... could not be reached" with a profile and the server down | no `--offline` flag exists (`Unknown flag: --offline`) |
| `migration apply`, `migration status`, `target list`, `whoami`, `migration verify` | fail (rc 2 usage without a server; rc 5 transport failure with the server down) | |

So the part of I11 "validate ... offline" holds: validate, lint, checksum and graph work from a checkout with no network, in 0.4 s each, with
deterministic checksums. **Plan and apply are server operations by design** (policy, evidence, approvals, the target's identity marker and the plan
store live in the Control Store); the documents promise offline only for lint, checksum and graph (`owner-test-package.md:80`, `reference.md:101`),
so the invariant text in the brief ("validate, plan and apply ... offline") is stronger than the product's contract. There is no emergency path
that applies a bundle to a target without the Control Store, and that is intended ("no direct DDL outside the migration engine").

## 2. The ledger with `psql` only (C-35)

With every ExponetDB process stopped, as the database superuser on the target (`lab_staging`): schema `exponetdb`, owner
`exponetdb_ledger_owner`, readable by `exponetdb_reader`, `exponetdb_observer`, `exponetdb_verifier`, `exponetdb_operator`:

| Table | Content (columns) |
|---|---|
| `schema_migrations` | `migration_id`, `origin` (exponetdb / legacy_import / baseline), `name`, `checksum` + `checksum_provenance`, `source_digest`, `verify_digest`, `rollback_digest`, `manifest` (jsonb: dependsOn, execution, compatibility, requires), `dependencies`, `transactional`, `source`, `applied_seq`, `applied_at`, `apply_duration_ms`, `plan_id`, `operation_id`, `actor_ref`, `client_ref`, `engine_version`, `pg_version_num`, `fingerprint_before`, `fingerprint_after`, `reverted_at`, `reverted_by_op` |
| `migration_verifications` | `verification_id`, `migration_id`, `operation_id`, `verify_digest`, `started_at`, `finished_at`, `status`, `structural`, `runtime`, `engine`, `fingerprint` |
| `migration_events` | `event_seq`, `at`, `migration_id`, `operation_id`, `event`, `detail` |
| `target_identity` | `installation_id`, `target_id`, `target_path`, `tier`, `generation`, `stamped_at`, `stamped_by_op`, `cluster_system_id` |
| `ledger_meta` | `ledger_schema_version`, `project_id`, `baseline_id`, `created_at` |

Append-only is enforced for everyone: `DELETE` and key updates raise `exponetdb ledger rows are append-only` even for the superuser (observed twice).
What an operator can answer from `psql` alone: what was applied, in which order, when, how long it took, with which engine and PostgreSQL version, which
checksum (and how it was computed), whether verification passed and which structural/runtime result, the schema fingerprints before and after, and the
identity of the target. What is **not** readable without ExponetDB (C-35 gaps, none of them blocking a restore):
1. *Who*: `actor_ref` and `client_ref` are internal ids (`idn_...`, `cli_...`); the person behind them lives only in the Control Store.
2. *What was executed*: the ledger keeps digests (`source_digest`, `checksum`), not the SQL text (`source` is NULL for ExponetDB-applied rows); the text is in the
   Git checkout, and `exponetdb migration checksum` (offline) recomputes the `c1` checksum to match it. Without the repository the statements cannot be recovered
   from the ledger.
3. *Why*: no plan hash, approval or break-glass reference beyond `plan_id` and `operation_id` (ids into the Control Store).
4. The schema is undocumented in the database: `obj_description` of the ledger tables and columns is empty; the meaning of `origin`, `checksum_provenance` and
   the fingerprint format (`fp1:17:...`) is in the repository documents only.
5. The ledger is per database; an inventory over several targets (which targets exist, which environment, which product) is the Control Store's (registry).

A restore of the target brings the ledger with it (it is in the dumped database), which is what C-35 needs. Verdict I11: **PASS for the ledger, PASS for
offline validation (lint, checksum, graph, validate), by design NOT offline for plan and apply.**
