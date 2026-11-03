# Rollout on reos-01: the verification campaign fixes (2026-11-03)

| | |
|---|---|
| Status | **[OBSERVED]** Running on `4c8c0bc` (merge of `davdxpx/ExponetDB#60`, which carries the groups A to I of the [verification campaign fixes](../../14-roadmap/prompts/2026-10-28-verification-fixes.md)); deployed at the owner's request; off-host audit export and automated off-host backups remain **NOT PROVEN** (open since the [first rollout](./2026-10-06-reos-01.md)) |
| Measured | 2026-11-03, 06:09 to 06:13 UTC |
| Source release | `4c8c0bc48adb077b962c2b43b98a3145c5e06492` (`main`, merge of `davdxpx/ExponetDB#60`) |
| Previous release | `d022950` (`d02295503bcfb7a4a4baea860bd9fceebe80b8b4`, Wave 9 Part B), image tag `sha256-c14914ff990e897116b4733869df32ded4eb31feedfa52df13627423bacb83ab` |
| Scope | ExponetDB resources only (project `ExponetDB`); no REOSA, Supabase or managed target changes |
| Gate | This record changes no gate. Deployment evidence for [G2](../../14-roadmap/gates/2.md) is still outstanding |

This record supersedes the "Source release" and image lines of the earlier
records; the resource list, network, backups and open work of those records
stand.

## Release

**[OBSERVED]** `main` at `4c8c0bc` holds the groups A to I of the verification
campaign fixes: the earlier merged pull requests, E (`#57`), F (`#58`), H
(`#59`) and I (`#60`). The pull requests' own notes carry the verification of
each group; this record states what was observed on the installation only.

The release was built on `reos-01` from a clean `git archive` export of
`4c8c0bc` (no working-tree files, no `.git`) with
`docker build --build-arg EXPONETDB_BUILD_COMMIT=4c8c0bc48adb077b962c2b43b98a3145c5e06492`,
tagged with its own image ID and pushed to the loopback registry:

| Check | Result |
|---|---|
| Image ID | `sha256:20b881cba87e407362e6d2470394777f72d45f15299e494be65b2de3ae7910c0`, 361,028,686 bytes |
| Label `org.opencontainers.image.revision` | `4c8c0bc48adb077b962c2b43b98a3145c5e06492` |
| Registry tag | `127.0.0.1:5000/exponetdb:sha256-20b881cba87e407362e6d2470394777f72d45f15299e494be65b2de3ae7910c0` |
| Set on | `exponetdb-worker`, `exponetdb-gateway`, `exponetdb-serve` and the image line of `exponetdb-migrate`, read back through the Coolify API; descriptions name `4c8c0bc` |
| Build commit reported by each role | `4c8c0bc48adb077b962c2b43b98a3145c5e06492`, version `0.2.0` |

The release adds eight Control Store bundles (the ledger goes from 42 to 50),
none of them a frozen one:

`01M61AGQKSBZ9VN71DHYFVCQHT_operation-supersession`,
`01M61C90YHV706H2B8EW39TBAF_ledger-reconcile`,
`01M61FKAJN5VP9H2E73K74NCZ2_offline-drill-record`,
`01M6DV2NQJDYWP4GXT46DTRK2S_operation-force-release`,
`01M6E66KZSPYHEF2Y7D4YJYWDH_audit-clock-clamp`,
`01M6E7DFZVEYRCA07SCYAA2PB6_migration-revision-purge`,
`01M6E85HQ7B2KDHHWMDP3AGA5M_cluster-memory-limit`,
`01M6EJD93DP9GNTHF77YY8VNY6_ledger-mirror-guard`.

## Order and timing (UTC)

| Time | Step | Observed result |
|---|---|---|
| before 06:09 | Preconditions | Coolify deployment queue empty (`GET /api/v1/deployments` returned `[]`); no operation `running` or `verifying` (one `awaiting_approval`, see Side effect) |
| 06:09:24 | Backup before the migration: `pg_dumpall` of `exponetdb-control` | `control-store-20261103T060924Z-pre-4c8c0bc4.sql.gz` in `/home/reos/exponetdb-backups/`, 41,743,577 bytes, 183,062 lines, ends with "cluster dump complete", `gzip -t` ok (local only) |
| before 06:11 | Restore proof | the dump restored once into a throwaway cluster (`postgres:17.11`, no network) with `psql -v ON_ERROR_STOP=1`: exit 0; the operation states and the 42 ledger rows equal the live store's; the cluster was removed |
| 06:11:12 | `exponetdb-migrate` started | exit 0 at about 06:11:19; the log lists the eight bundles, each `passed` with no failed check, `state.status: current`; the latest ledger row is dated 06:11:15.7 |
| about 06:11:36 | `serve` deployed (deployment `zv3evoyz7xnsjlvszsi248yv`) | `process.started`, state `ready` at 06:11:42.5 |
| about 06:11:38 | `gateway` deployed (deployment `u7abmijzkp7tzpofrfidbewt`) | `process.started` at 06:11:53 with state `not_ready` as before; the container is `healthy` afterwards |
| about 06:11:40 | `worker` deployed (deployment `wj0hndh8xjquiljxgvyecu9b`) | `process.started`, state `ready` at 06:11:47.6 |

**Not measured:** the downtime of the Web App. Readiness was not polled during
the rollout. From the log times alone, `serve` was started at 06:11:41.9 and
ready at 06:11:42.5, and the old roles go not ready about 2 s after the
migration commits (06:11:15.7), so about 27 s is the order of magnitude; it is
an inference, not a measurement.

## Result

| Check | Result |
|---|---|
| `https://db.exponet.cloud/healthz/ready`, `/healthz/live` | `200`, `{"status":"ready"}` / `200` |
| Anonymous `GET /api/v1/installation` | `401` |
| Containers | `serve`, `gateway`, `worker` `running` and `healthy`, restart count 0 |
| Control Store ledger | 50 bundles |
| Nodes (MCP `nodes_list`) | one node `active`, agent `0.7.0`, last heartbeat 06:12:40, clock skew -2 ms; it reconnected after the gateway swap |
| Restart policy, volume | `unless-stopped` on the three roles and on `exponetdb-control`; the Control Store data lives on the Docker volume `postgres-data-rsbn9zqgegt2wpebijlnrmm4`; database 326 MB; the host disk has 344 GB of 436 GB free |
| `EXPONETDB_CONTROL_STORE_VOLUME_BYTES` | **not set** on `serve` (optional, OD-70): installation health lists the volume as not observed |

## Side effect

**[OBSERVED]** The operation `op_01M5X74EJ0CD4BYGRZ9DM1KZYA`
(`access.identity.erase`), waiting for an approval since 2026-10-26, went to
`canceled` at 06:11:47 by the new worker (`reason: approval_window`, error code
`APPROVAL_EXPIRED`, window 14,400 s). That is the approval window of the
release working as designed on a request that had been open for eight days; the
person who asked has to ask again if the erase is still wanted. Nothing else
changed state (operations: 80 succeeded, 10 failed, 6 verification failed, 1
canceled).

## Not verified here

- The checks of [`upgrades.md` §1.1](../upgrades.md) step 8 through the operator
  commands: `exponetdb control-store status`, `keyring status`, `audit verify`,
  `GET /api/v1/installation/health` and one nonprod read, plan and apply with a
  signed-in identity. The evidence above is the readiness probes, the container
  health, the ledger count, the node list and the log lines of the roles.
- The preflight of step 2 (`control-store status` from the new image) was not
  run; the migration's own output stands in for it.
- The new readiness details (`audit_partitions`, `clock_skew`) are not visible
  on the anonymous probe, which returns the status only.
- The step 4 drain setting was **not applied** to the live worker:
  `EXPONETDB_SHUTDOWN_TIMEOUT_MS` is not set on it and the container's stop
  grace period is Docker's 30 s, not the 130 s of the card. No operation was
  running, so nothing was cut; the next rollout is exposed until the owner sets
  both on the `exponetdb-worker` resource.
- `main`'s CI result on `4c8c0bc`.
- Node agents (none checked or updated), off-host audit export and off-host
  backups: unchanged, **open**.
- The declared memory limits of the clusters (`POST /clusters/{id}/memory-limit`,
  bundle `cluster-memory-limit`) are the owner's to declare; none was declared
  here.

## Rollback anchor

The schema changed (eight additive bundles), so the previous release does not
run on this ledger: its roles refuse readiness with a newer ledger
(`schema_newer`). A return to `d022950` needs the backup above restored into
`exponetdb-control` first (RB-10; **[OBSERVED]** the dump creates the role
`postgres`, so a scratch cluster for a trial restore must be created with a
different bootstrap superuser, for example `POSTGRES_USER=scratch_admin`), then
the tag `sha256-c14914ff990e897116b4733869df32ded4eb31feedfa52df13627423bacb83ab`
on the three roles and the `exponetdb-migrate` image line
([`upgrades.md` §1](../upgrades.md)). A fix forward is the usual way.

## Access used

**[OBSERVED]** The session built and pushed the image on `reos-01` over SSH as
the operations user, took the dump, started the migration service and deployed
the three roles through the Coolify API (token of the owner's rollout key,
reached through an SSH tunnel), and read the Control Store's operation and
ledger tables once with `psql` inside its container. No token, address of a
person or credential is part of this record.
