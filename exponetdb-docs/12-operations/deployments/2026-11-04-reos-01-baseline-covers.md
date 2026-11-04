# Rollout on reos-01: a baseline that covers bundles (2026-11-04)

| | |
|---|---|
| Status | **[OBSERVED]** Running on `e14685e` (merge of `davdxpx/ExponetDB#69`, after `#68`); deployed at the owner's request ("Gemergt, deploye"); off-host audit export and automated off-host backups remain **NOT PROVEN** (open since the first records) |
| Measured | 2026-11-04, 21:36 to 21:40 UTC |
| Source release | `e14685ec066979d26bbedc839a39fe701f3cd13b` (`main`, merge of `davdxpx/ExponetDB#69`) |
| Previous release | `3dc33f9` (`3dc33f9ec89b40ba4f3fd33510015508d178166b`, Wave 10 W10-1 to W10-4), image tag `sha256-541e1a886b14b822d816975b0542fb3fb4858fd4ef5cf309a9609070e8972273` |
| Scope | ExponetDB resources only (project `ExponetDB`); no REOSA, Supabase or managed target changes; no target registered or changed |
| Gate | This record changes no gate. It is deployment evidence for [ADR-0040](../../01-architecture/adr/0040-baselines-that-cover-bundles.md) (OD-72 (a)); [G10](../../14-roadmap/gates/10.md) stays open |

This record supersedes the "Source release" and image lines of the earlier
records; the resource list, network, backups and open work of those records
stand.

## Release

`main` at `e14685e` adds, over `3dc33f9`:

- `davdxpx/ExponetDB#68` (docs): the owner's decisions P1 to P7 of the REOSA
  production session and OD-72;
- `davdxpx/ExponetDB#69`: a legacy-import baseline that covers stream bundles
  applied outside ExponetDB (`BaselinePlanRequest.covers`, CLI
  `migration import baseline --covers`), ADR-0040.

The release adds **no** Control Store bundle (the ledger stays at 51 rows).

The release was built on `reos-01` from a clean `git archive` export of
`e14685e` with
`docker build --build-arg EXPONETDB_BUILD_COMMIT=e14685ec066979d26bbedc839a39fe701f3cd13b`,
tagged with its own image ID and pushed to the loopback registry:

| Check | Result |
|---|---|
| Image ID | `sha256:8bd5ff9a863ddb0a2ea8f071cc3a014100ad80dbd74a3892742614db1b501f81`, 361,113,120 bytes |
| Label `org.opencontainers.image.revision` | `e14685ec066979d26bbedc839a39fe701f3cd13b` |
| Registry tag | `127.0.0.1:5000/exponetdb:sha256-8bd5ff9a863ddb0a2ea8f071cc3a014100ad80dbd74a3892742614db1b501f81` |
| Set on | `exponetdb-worker`, `exponetdb-gateway`, `exponetdb-serve` and the image line of `exponetdb-migrate`, read back through the Coolify API; descriptions name `e14685ec` |
| Build commit reported by each role | `e14685ec066979d26bbedc839a39fe701f3cd13b` |

## Order and timing (UTC)

| Time | Step | Observed result |
|---|---|---|
| before 21:36 | Preconditions | Coolify deployment queue empty; no operation `running`, `verifying` or `awaiting_approval` (84 succeeded, 10 failed, 6 verification failed, 2 canceled) |
| 21:37:08 | Backup: `pg_dumpall` of `exponetdb-control` | `control-20261104T213708Z-pre-e14685ec.sql.gz` in `/home/reos/exponetdb-backups/`, 46,738,201 bytes, ends with "cluster dump complete", `gzip -t` ok (local only). No trial restore: the release changes no Control Store schema |
| 21:38:09 | `exponetdb-migrate` started | exit 0; `state.status: current`, no bundle to run |
| 21:38:52 | `serve`, `gateway`, `worker` deployed | queue empty again at 21:39:04 |

## Result

| Check | Result |
|---|---|
| `https://db.exponet.cloud/healthz/ready`, `/healthz/live` | `200` / `200` |
| Anonymous `GET /api/v1/installation` | `401` |
| Containers | `serve`, `gateway`, `worker` `running` and `healthy`, restart count 0 |
| Control Store ledger | 51 bundles (unchanged) |
| Targets (MCP `targets_list`) | `reosa/platform/staging` and `reosa/platform/scratch` `active`, `healthy`, sampled 21:39:02 |
| Nodes (MCP `nodes_list`) | one node `active`, agent `0.7.0`, last heartbeat 21:39:04, clock skew -10 ms |
| Host disk | 277 GB of 436 GB free |
| Operator CLI | repacked from `e14685e` (artifact sha256 `bf686dbd…`), `migration import baseline --covers` present |

No operation changed state during the rollout.

## Not verified here

- The checks of [`upgrades.md` §1.1](../upgrades.md) step 8 through the operator
  commands, as in the earlier records.
- The new code path on the live installation: no baseline with `covers` was
  planned; its evidence is the integration suite of `#69` (PostgreSQL 16, 17
  and 18, 261 tests). The first live use is the REOSA production import.
- `main`'s CI on `e14685e` (the red jobs of `main` since `e6f4c77c` were not
  re-checked).
- The worker's drain setting, node agents, off-host audit export and off-host
  backups: unchanged, **open**.

## Rollback anchor

The schema did not change, so the previous release runs on this ledger: set the
tag `sha256-541e1a886b14b822d816975b0542fb3fb4858fd4ef5cf309a9609070e8972273` on
the three roles and the `exponetdb-migrate` image line and redeploy
([`upgrades.md` §1](../upgrades.md)). A baseline written with `covers` before a
rollback stays valid data, but the previous release would not count its covered
rows as applied (it would list those bundles as pending again).

## Access used

**[OBSERVED]** The session built and pushed the image on `reos-01` over SSH as
the operations user, took the dump, set the image tags, started the migration
and the three roles through the Coolify API (token of the owner's rollout key,
through an SSH tunnel), and read the Control Store's operation and ledger tables
with `psql` inside its container. No token, address of a person or credential
is part of this record.
