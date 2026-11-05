# Rollout on reos-01 and reos-db-01: `cce2ee05` (P6) and node agent 0.7.1 (2026-11-04/05)

| | |
|---|---|
| Status | **[OBSERVED]** Running on `cce2ee05` (merge of `davdxpx/ExponetDB#71`); node agent 0.7.1 on `reos-db-01`; both at the owner's request in the REOSA production session; off-host audit export remains **NOT PROVEN** (open since the [first rollout](./2026-10-06-reos-01.md)) |
| Measured | 2026-11-04 from 23:04 UTC (Control Store backup) to 2026-11-05 07:48 UTC (the production baseline) |
| Source release | `cce2ee05` (`main`, merge of `davdxpx/ExponetDB#71`), image tag `sha256-ef1b2d1d32b2d4ddf9cf8ad843f7d75a06d0e12d90ac065045005bf6f9b2433b` |
| Previous release | `e14685ec` (merge of `davdxpx/ExponetDB#69`, ADR-0040; record in `#70`) |
| Scope | ExponetDB resources (project `ExponetDB`) and the node agent binaries on `reos-db-01`; the managed-target changes of the same session are listed below as context, they are operations, not part of the rollout |
| Gate | This record changes no gate. It is evidence for [G10](../../14-roadmap/gates/10.md) §1a (REOSA production on `reos-db-01`) |

This record supersedes the "Source release" and image lines of the earlier
records; the resource list, network and open work of those records stand.

## Release

**[OBSERVED]** `cce2ee05` adds P6: plan acceptance meets a `backup`
requirement through the backup catalog (`RegistryAcceptContext.backupMet`,
`backupRequirementMet`, `verifiedBackupWithin`: a catalog reconciled within
10 minutes, an off-host, verified backup within the required age). No Control
Store bundle; the migration step reported no pending bundle.

Steps, as for the earlier records ([`upgrades.md` §1](../upgrades.md)):

1. Control Store backup `control-20261104T230439Z-pre-cce2ee05.sql.gz` under
   `/home/reos/exponetdb-backups/` on `reos-01`.
2. Image built on `reos-01` and pushed to the local registry as the tag above.
3. The service compose and the three roles (`serve`, `gateway`, `worker`) set to
   the tag through the Coolify API; migration step started, then the three roles
   deployed one after another; `/healthz/ready` 200, the three containers
   healthy with `buildCommit` `cce2ee05`.

Settings stored in Coolify before the deploy and in force since:
`EXPONETDB_BACKUP_EXECUTION=nonprod` and `EXPONETDB_RESTORE_EXECUTION=scratch`
(names only; values are settings, not secrets).

## Node agent 0.7.1 on `reos-db-01`

**[OBSERVED]** The first restore drill of the adopted REOSA repositories failed
on node agent 0.7.0: pgBackRest error 031 for `--target-timeline` (TC-009, fixed
on `main`). The agent was replaced by 0.7.1 built from `cce2ee05`:

- build placed under `/root/exdb-node-0.7.1`, checked with `SHA256SUMS-0.7.1`;
- old binaries kept under `/root/exdb-node-0.7.0-installed` (rollback: copy them
  back and restart the same two units);
- `/usr/bin/exponetdb-node` and `/usr/sbin/exponetdb-node-helper` replaced, the
  units `exponetdb-node-helper.service` and `exponetdb-node.service` restarted;
  both and the helper socket active, `exponetdb-node version` 0.7.1. The systemd
  units are unchanged; PostgreSQL was not restarted.

The second drill passed (`op_01M6MGZKF38HFW15G7XJHAM9ZH`).

## Operations of the same session (context)

| Step | Id | Outcome |
|---|---|---|
| R2 repositories adopted (`adopted_observed`, stanza `main`) | repo1 `bkr_01M6MCQQJ4MJEVQNYP1P8GWYDA`, repo2 `bkr_01M6MCQQJ3E9JBZ7SRQZPPD0B9` | bound on the host |
| Backup verify | `op_01M6MDQM1P5EJ855PEAMYKTAGP` | succeeded |
| Restore drill | `op_01M6MGZKF38HFW15G7XJHAM9ZH` | succeeded (after 0.7.1) |
| Production target registered (managed, P1) | `tgt_01M6MFNCN9A24W3FAM4034KCVZ` (`reosa/platform/production`) | active, healthy; the cluster is prod tier since |
| Production scratch | `tgt_01M6ME7EKY6DW8SJ4FJGDZWQGM` (`reosa/platform/production-scratch`) | active |
| Legacy import | report `imr_01M6N8G91BHPX2Q7NBZTYTWJWN` | 272 drift items, not truncated; 407 decisions, 0 unresolved |
| Baseline with `covers` (ADR-0040), 41 bundles | plan `pln_01M6NAS74GPNTG5F6540JX5V73`, operation `op_01M6NATCNFEKSHFKQWST7PD111`, verification `vfy_01M6NAW11YZRBD1S0Q577VENZE` | applied and verified: 0 of 14140 structural expectations failed, 128 excused by review decisions; ledger 1 baseline row and 634 `legacy_import` rows |

The order of steps and the REOSA side are in REOSA
`reosa-docs/09-operations/reos-db-01/migration-2026-10/exponetdb-production-plan.md`.

## Not verified here

- The checks of [`upgrades.md` §1.1](../upgrades.md) step 8 through the operator
  commands, as in the earlier records.
- Backup runs and verifies on the cluster after it became prod tier: with
  `EXPONETDB_BACKUP_EXECUTION=nonprod` they are now refused for this cluster;
  they need `all`, an owner decision. The host timer still takes the backups.
- Off-host audit export: unchanged, **open**.

## Rollback anchor

No Control Store bundle changed, so `e14685ec` runs on this ledger: set its tag
on the three roles and the `exponetdb-migrate` image line
([`upgrades.md` §1](../upgrades.md)). Node agent: the 0.7.0 binaries above. A
fix forward is the usual way.

## Access used

**[OBSERVED]** The session built the image on `reos-01` over SSH as the
operations user, took the dump, set the tags and deployed through the Coolify
API (the owner's rollout key, through an SSH tunnel), and replaced the agent
binaries on `reos-db-01` over SSH as root with the session's key. No token,
address of a person or credential is part of this record.
