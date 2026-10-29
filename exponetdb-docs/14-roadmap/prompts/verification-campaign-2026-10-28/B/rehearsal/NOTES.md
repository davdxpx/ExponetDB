# Rehearsal working notes (tester S5): kit changes and observations as they happened

Server vc-2 only. Stack `s5` (`STACK_NAME=s5 PORT_BASE=58400 PG_PORT_BASE=55400 AGENT=0`), commit `d51da5d0` (fix PR #46), built by
`D/infra/stack-up.sh` (about 10 minutes from a cold start on vc-2: clone, `bun install`, builds, three PostgreSQL clusters, Control Store,
owner, CLI, registry, smoke migration on three targets). `AGENT=0`: no node agent, the clusters are registered as external. Raw logs:
`/srv/work/logs-s5` on vc-2, index `B/rehearsal/logs-index.md`.

## Changes to my copy of the S1 kit (the kit itself is untouched)

| File | Change | Why |
|---|---|---|
| `kit/seed.ts` `addTarget` | the evidence environment of a `prod` target is `process.env.EXSTACK_EVIDENCE_FROM ?? 'staging'` | the rehearsal needs production to take its evidence from the rehearsal staging environment (`rhstg`), not from the stack's `staging` |
| `kit/human.ts` `stepup` | body `{ userCode: code }` instead of `{ code }` | `StepUpConfirmRequest` (`packages/contracts/src/rest/migrations.ts:986`) is `{ userCode }`; the kit's call was answered 422 `VALIDATION_FAILED` |
| `/etc/exstack.env` on vc-2 | `STACK_NAME=s5`, ports, `AGENT=0` | `stack-env.sh` derives the cluster name (`exs5`) and root from `STACK_NAME`; sourced without it, `pg_restart` addressed `exdbnode` |

Everything else (`stack-up.sh`, `stack-down.sh`, `stack-env.sh`) ran unchanged.

## Setup facts

* Registry: product `lab`, project `platform`; for the rehearsal three more targets on the PG17 cluster: `lab/platform/rhstg` (nonprod, the
  staging-like database that carries the 4.4 GB), `rhscr` (nonprod, scratch of the replay), `rhprod` (prod tier, evidence from `rhstg`, schema only).
* Project change `registry.project.update`: managed scope `public, auth, storage, app_private`, trusted extensions `pgcrypto, uuid-ossp, pg_trgm, pg_stat_statements`.
* Cluster 17: `wal_level=logical`, `archive_mode=on` (archive command copies to `/srv/work/s5/walarchive`), `shared_preload_libraries=pg_stat_statements`,
  `shared_buffers=1GB`, `max_wal_size=8GB`.
