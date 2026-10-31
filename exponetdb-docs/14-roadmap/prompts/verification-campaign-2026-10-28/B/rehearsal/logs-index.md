# Raw logs of tester S5 (vc-2, `/srv/work/logs-s5`, 14 MB, 265 files)

Not committed (rule 2 of the campaign: logs stay on the server). Every step script writes `<step>.log` (the CLI output as an operator sees it) and appends a row to `timings.tsv`.

| Pattern | Content |
|---|---|
| `stack-up.out`, `timings.tsv` | the stack build (4 min 15 s on a warm Bun cache), one row per timed step (name, start, end, seconds, exit code) |
| `data-load.log`, `summary-facts.txt` | the 4.4 GB load, inventory of the generated schema |
| `import-analyze-*.log/json`, `analysis-*.log`, `mem-*.log`, `report-*.json`, `resolve-*.log`, `baseline-*.log` | the import: plans, analyses (with a per-second RSS sample of serve, worker, gateway), reports with all 163 items, the 16 decisions, the baselines for staging, production, PostgreSQL 16 and 18 |
| `plan-*.log/json`, `plan-risk-first-5.txt`, `apply-*.log`, `pgb-*.out`, `pgb-load1.<pid>` | plans (the JSON holds the whole analysis per statement), applies, pgbench output and per-transaction logs (`-l`) of the loaded apply |
| `drift-*.log/json`, `findings-after-bundles.json`, `drift-rep-N.json` | drift checks and findings (including the 33 checks that opened 16,272 findings on `rhrep`) |
| `restore-pitr.log`, `crash-recover.out`, `marker.log`, `marker2.log`, `pre-disaster-counts`, `post-restore-counts` | the two restores; the client-side marker logs (id and commit time, one per second) that prove the RPO |
| `target-show-*`, `migration-status-*`, `rs1-*`, `rp-*`, `lg-*`, `sub-*`, `swap*`, `rename-*` | what the Control Plane said after each restore, clone, re-point, standby, logical copy and subscriber step |
| `prod*`, `cheat*`, `c1-*`, `d1-*`, `f1-*`, `plan-prod-*` | the promotion attempts and the cheats |
| `plan500-*`, `plan50-*`, `plan200stored-*`, `mem-plan*`, `scale100-targets.tsv`, `scale-lint-more.out`, `page-*.ids` | scale |
| `traps-*.log` | the output of the task B scripts |

The Control Store, the three clusters and the stack state were removed at the end (`stack-down.sh`); `/srv/work/s5/{src,build}` (cached source and build) and `/srv/work/s5kit` (my copy of the kit with its two edits) stay.
