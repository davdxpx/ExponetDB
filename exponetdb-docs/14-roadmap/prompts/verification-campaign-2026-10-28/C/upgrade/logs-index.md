# Index of raw logs (server `vc-1`, `/srv/work/s3/logs/`, not committed)

Scripts: `/srv/work/s3-infra/s3/` (copies in `C/upgrade/scripts` and `C/control-store-loss/scripts`). No secret was printed into any of these
files; the role-credentials file, the keyring, the owner file and the dumps were removed from the server at the end of the session.

| What | File |
|---|---|
| stack build and bring-up of the old release | `stack-up-old.out`, `stack-up-old2.out` (agent phase re-run), `stack-up.log`, `build-*.log`, `build-new.out` (the build of `d51da5d0`) |
| state creation (last of four attempts) | `10-state.out`, `state/` (ids of the awaiting-approval and needs-attention operations, `prod-plan.json`) |
| timings of every timed step | `timings.tsv`, `dump-times.log`, `between.tsv` |
| census (counts, columns, hashes of the append-only tables) | `census/*.counts.tsv`, `*.cols.tsv`, `*.hashes.tsv`, `preup-vs-postup.tsv` |
| upgrade runs 1, 2, 3 | `sampler-up1.log`..`up3.log` (50 ms readiness transitions), `migrate-up*.out`, `40-upgrade-up2.out`, `downtime.txt` |
| verification after the upgrade | `v3-verify.out` (old plan, awaiting, needs_attention), `v5-verify.out` (new migration, node, gateway/agent journal) |
| documented rollback | `60-rollback-documented.out`, `rollback-documented/*.journal` |
| rollback by restore | `65-rollback-restore.out`, `rollback-restore/sampler.log`, `v6-after-restore.out`, `v7.out`, `v8.out` (node reconnect), `v9-divergence-old.out` |
| reconcile flows | `70-reconcile-staging.out`, `70-reconcile-others.out`, `loss-70-reconcile-nonprod.out`, `loss-31-prod-reconcile.out`, `loss-v12-prod-reconcile.out` |
| redeploy during an apply | `80-sigterm.out`, `sigterm/summary.tsv`, `80-sigterm-nontx.out` (plan denied) |
| in-flight apply across `migrate` | `91-inflight.out`, `inflight/sampler.log` |
| policy version across the upgrade | `90-policy-version.out`, `policyver/plan.id` |
| `serial` column | `95-serial-column.out` |
| Control Store loss | `loss-00-prepare.out`, `loss-10-destroy.out`, `loss-20-rb10-a-failed-first-attempt.out` (the `restore_admin` collision), `loss-20-rb10-b.out` (as written), `loss-v10.out`, `loss-v15-prod-approve.out`, `loss-v16-prod-plan.out`, `loss-30-prep.out`, `loss-30-destroy.out`, `loss-30-reconcile.out` (hung CLI), `loss-40-keyring.out`, `loss/rb10-steps.tsv` |
