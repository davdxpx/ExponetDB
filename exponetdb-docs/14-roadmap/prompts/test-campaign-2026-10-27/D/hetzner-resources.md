# Hetzner resources created by the campaign (label purpose=exponetdb-test-campaign)

| time (UTC) | kind | id | name | state |
|---|---|---|---|---|
| 2026-10-27 19:55 | ssh_key | 131861135 | tc-campaign-20261027 | created |
| 2026-10-27 19:55 | server cx33 nbg1 | 172883093 | tc-node-1 | created |

Pre-existing, untouched: server 169416658 reos-db-01.
| 2026-10-27 20:10 | server cx33 nbg1 | 172885262 | tc-node-2 | created |
| 2026-10-27 20:15 | server cx33 nbg1 | 172885648 | tc-node-3 | created |
| 2026-10-27 21:25 | server tc-node-3 | 172885648 | deleted after the gap-scenarios agent finished (evidence copied to D/gap-scenarios/) |
| 2026-10-27 21:34 | server tc-node-1 | 172883093 | deleted (host scenarios and CI replica finished, logs in D/host-scenarios and D/ci-replica) |
| 2026-10-28 06:09 | ssh_key | 131878058 | tc-campaign2-20261028 | created to regain access to tc-node-2 after the session restart (scratchpad with the first key was wiped) |
| 2026-10-28 06:18 | server tc-node-2 | 172885262 | deleted (backup/restore agent finished; evidence in D/backup-restore-e2e) |
| 2026-10-28 06:18 | ssh_keys | 131861135, 131878058 | both deleted |
