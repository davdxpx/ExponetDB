# Rehearsal working notes (tester S5): kit changes and observations as they happened

Server vc-2 only. Stack `s5` (`STACK_NAME=s5 PORT_BASE=58400 PG_PORT_BASE=55400 AGENT=0`), commit `d51da5d0` (fix PR #46), built by
`D/infra/stack-up.sh` (4 min 15 s on vc-2 with a warm Bun cache left by earlier agents: clone, `bun install`, builds, three PostgreSQL clusters, Control Store,
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

## Other observations while building the rehearsal (not findings)

* The stack's `add_target` and `seed.ts` talk to the cluster by the fixed port `PG_PORT_BASE + major` with the `postgres` peer user. After the registry was
  re-pointed at a restored instance on another port, `add_target ... pg17` failed silently (the database was created on the dead instance); the later move test used the PG18 cluster.
* `human call` and `human apply` use the owner's browser session. A plan created with the CLI (a delegated client) is bound to that client: the session answers `PLAN_BINDING_ACTOR`
  (403, "Only the identity and client that created the plan may use it"). Apply CLI plans with the CLI; production plans additionally need a step-up and/or an approval, driven by `scripts/prod_apply.sh`.
* `/etc/exstack.env` (STACK_NAME=s5) was written for the rehearsal and removed at the end; the teardown ran `stack-down.sh`, dropped my extra clusters (`rs1`, `rs2`, `rs3`), the base backup, the
  WAL archive and the lost data directory. Left: `/srv/work/s5/{src,build}` (cache), `/srv/work/s5kit` (the kit with the two edits above), `/srv/work/logs-s5`.
* Operator trap: restoring in place left `restore_command` and `recovery_target_time` in `postgresql.auto.conf`; harmless after `recovery.signal` is gone but an operator trap.
