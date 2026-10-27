# Wave 9 Part B: gap matrix on `main` at `cad5ac1`

| | |
|---|---|
| What this is | The inventory the owner's Wave 9 Part B order (2026-10-26, §3) asks for before any change: what exists on current `main` for each Part B area, classified `FOUND` (exists and is served or used), `INCOMPLETE` (a contract or a placeholder without a working path), `MISSING` (nothing), `NOT PROVEN` (exists, no evidence for the claim) |
| Base | `main` `cad5ac1529b8` (2026-10-26, merge of `#42`); this session's branch `ccr-4bf70a3d-5p1q3c` started there |
| Status at the end of the session | see the right-hand column "After Part B" and [`9.md`](./9.md); this table's left side is the state **before** Part B and is not edited afterwards |

## 1. Facts that differ from older records

| Older statement | Fact on `cad5ac1` | Source |
|---|---|---|
| "CI has never run" (Wave 9 order §2, 2026-10-21) | **outdated**: GitHub Actions runs on every push and pull request; run 408 (`02ed23c`, `#41`) passed every job, including the systemd host scenarios and "Node agent on PostgreSQL 16, 17, 18 (systemd)"; run 410 (`#42` head `3dbbcca`) failed the browser end-to-end job; run 411 (`main` `cad5ac1`) was in progress when this matrix was written | GitHub Actions run list, read 2026-10-26 |
| `main` at `a4f16e3f` (order text) | `main` at `cad5ac1`: `#41` (helper socket) and `#42` (UI/UX overhaul, server and cluster retirement) merged after it | `git log` |
| Five contract routes without a handler (`#42` U5) | still true: `getQueryStats`, `getTableStats`, `runAdvisors`, `listClusterBackups`, `planLedgerReconcile` are not in `HANDLERS` (`apps/server/src/interfaces/http/api.ts`) and are served as 404 | `servedRoutes()` |
| pgBackRest 2.59.3 "affected" by the 2026-10-04 advisory (order §4) | 2.59.3 **is the fix release**; stanzas created with an earlier version keep their subkeys (ADR-0036 §5) | pgbackrest.org news, releases |

## 2. Matrix

| Area | Contracts | Control Store | Application / domain | REST handler | SDK | CLI | MCP | Node | Web | Docs | Tests | Before |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| Backup catalog read | `listClusterBackups`, `BackupCatalog`, `Backup`, `BackupHealthState`, action `backup.list` | none (no `backups` schema) | none | none (404) | generated op only | none (`diagnose` names a row) | `backups_list` `planned` | none | `/backups`, `/t/…/backups` placeholders | `architecture.md` §3 (design) | none | **INCOMPLETE** |
| Backup repositories, policies | none | none | none | none | none | none | none | none | none | design only | none | **MISSING** |
| Backup run, verify, expire | actions `backup.run`, `backup.verify` (operation shape) | exclusivity `cluster:…:backup` (frozen) | none | none | none | none | no contract (correct, OD-29) | none (`capability_unsupported`) | none | design | none | **MISSING** |
| WAL coverage, RPO/RTO | `achievableRpoSeconds`, `walWindow` in `BackupCatalog` | none | none (health `backups` always `null`) | none | — | none | — | `wal.archive_status@1` only | none | `architecture.md` §4 | none | **INCOMPLETE** |
| Adopt-then-own | none | none | none | none | none | none | none | none | none | OD-52 decided | none | **MISSING** |
| Restore plans, execution | action `restore.plan` (record), `restore.execute` (human, re-auth); scopes frozen | none | none | no route | none | none | `restore_execute` listed as never-exposed; no `restore_plan` contract | none | none | `restore.md` (design) | none | **MISSING** |
| Drills, measured RTO | none | none | none | none | none | none | none | none | none | `restore.md` §6 | none | **MISSING** |
| C-35 offline runbook | none | none | none | none | none | none | none | none | none | C-35, `architecture.md` §7 | none | **MISSING** |
| RB-06, RB-07, RB-08 | — | — | — | — | — | — | — | — | — | one table row each (`incident-model.md`) | — | **INCOMPLETE** |
| Long-running node jobs | none (60-minute window, `runSeconds`) | `nodes.jobs` (frozen) | — | — | — | — | — | helper cap 15 min, no long-run path | — | none | none | **MISSING** |
| L2 `pg_dump`, L3 restic | none | none | none | none | none | none | none | binaries not allowlisted | none | `backup-engines.md` | none | **MISSING** |
| Backup bindings for retirement (`#42`) | `RetirementPreflight.providers[backups]` (state only) | none | `BackupBindingsPort`, `noBackupEngine` returns `not_installed` | served | — | — | — | — | preflight shows the state | `registry.md` §4.4 | blocking/unknown refuse (unit) | **INCOMPLETE** (no provider) |
| Statement statistics | `getQueryStats`, `QueryStats`, action `query_stats.list` | none (no samples, no aggregates) | live raw-statement lookup only (`raw-statement.ts`) | none | generated op only | none | `query_stats` `planned` | — | `/t/…/performance` placeholder | `performance.md` §2 | none | **INCOMPLETE** |
| Table and index statistics | `getTableStats`, `TableStats`, action `table_stats.list` | — | none | none | generated op only | none | `table_stats` `planned` | — | placeholder | `performance.md` §1 | none | **INCOMPLETE** |
| Advisors and findings | `runAdvisors`, `AdvisorRun`, action `advisor.run`; `Finding.kind` open enum with `advisor`, `backup` | `observation.findings` allows only `drift`, `health`, `target_id NOT NULL` (frozen) | none | none | generated op only | none | `advisors_run` `planned` | — | `/t/…/advisors` placeholder | `performance.md` §4 | none | **INCOMPLETE** |
| Connection cancel/terminate | actions `connections.cancel` (`low`), `connections.terminate` (`standard`/`high`), `connections.terminate.plan`; no route | none | `stalled` predicate in health | none | — | none | none | — | connections page names it as coming | `health.md`, `performance.md` §5 | none | **INCOMPLETE** |
| OD-54 `registry.cluster.adopt_agent` | none | `EXG07` forbids it (frozen) | none | none | none | none | none | node cluster report exists | none | OD-54 (open) | none | **MISSING** |
| OD-55 ledger/marker protection | — | — | `current_user` check per statement only | — | — | — | — | — | — | OD-55 (open) | proof of the gap (Part A) | **MISSING** |
| OD-56 keyed digest of excused values | — | `failing` column (names only) | aspects compared only | — | — | — | — | — | — | OD-56 (open) | proof of the gap | **MISSING** |
| `migration.destructive-backup` fact | rule exists, always fails on production | — | no backups fact | — | — | — | — | — | — | `policy-engine.md` | rule unit tests | **INCOMPLETE** (fail closed) |
| G6 expiring waivers (E25; partial E4, E5, E7, E8, E9, E11, E13, E14, E15, E26, E28) | — | — | — | — | — | — | — | — | — | `gates/6.md` | partial | **NOT PROVEN** |
| G5 items 2 and 4 (real systemd) | — | — | — | — | — | — | — | — | — | waived until a real host | CI host scenarios green in run 408 | **NOT PROVEN** for a real host (CI evidence exists for the systemd container) |

## 3. Ownership boundary used for this matrix

- Backend, contracts, Control Store, node agent, CLI, MCP and
  `apps/web/src/features/wave9/**`: this session.
- `apps/web/src/shell/**`, `features/fleet/**`, `features/target-overview/**`,
  `features/connect/**`, the project routes, design primitives and the
  retirement actions: the UI/UX session (`#42`, merged before this session
  began). The two integration points it left for Wave 9 (U9: the fleet
  protection slot and the target hero fact; the `BackupBindingsPort`) are
  the only places this session touches outside its own directory, and only
  as U9 describes.
