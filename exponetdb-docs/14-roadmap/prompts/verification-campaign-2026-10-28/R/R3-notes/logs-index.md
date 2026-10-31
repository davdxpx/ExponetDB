# R3 raw logs (kept on the server, not in this folder)

Server `vc-2`, work tree `/srv/work/r3/` (`new` = `d51da5d0`, `old` = `d0229550`, `v060` = `1819998e`,
the 0.6.0 node build used for the TC-068 probe). Toolchain: Node 24.22.1, Bun 1.4.4, Go 1.26.10,
Ubuntu 24.04, UTC. Logs are in `/srv/work/r3/logs/` and are NOT committed. Probe sources that I wrote
are in `probes/` (committed, small).

| Log | What |
|---|---|
| `tc049-{old,new}-<zone>.log`, `tc049.summary` | `packages/ui-patterns` `bun run test` under Europe/Berlin, America/Los_Angeles, Asia/Kolkata, Pacific/Kiritimati, old and new |
| `tc049n-*.log`, `tc049n.summary` | TC-049 neighbours: other packages under `TZ=Pacific/Kiritimati` on the new tree |
| `tc050-{old,new}.log`, `tc050-new-dummykey.log` | `bun run mcp:evals` without a key (old, new) and with a dummy key and no database (new) |
| `tc051.log` | `toolchain.ts` on the pinned PATH and with a PATH shim reporting Node 26.5.0 and Bun 1.3.14; `bun install` and `bun run verify` under the shim, new and old; the new unit test on the old tree |
| `tc054-*.log`, `tc054.summary` | the visual-regression e2e file with the default set and with `ci-ubuntu-24.04`, old and new, and before the design-system build |
| `testlist-{old,new}.txt`, `list.summary` | `vitest list --filesOnly` of every package with a `vitest.config.ts`: the default `bun run test` file set, old against new |
| `cli-probes-{old,new}.log` | `probes/r3-cli-probes.test.ts` (TC-052, 056, 057, 058, 064, 065, 073, 074, E9/TC-041) |
| `static-greps.txt` | the code-level checks (TC-053, 062, 063, 066, 067, 069, 072, 075) on both trees |
| `mig-tc3-tc7.log`, `mig-evid-*/*.jsonl` | the first campaign's engine tests `tc-3` and `tc-7` on the new tree (TC-060, TC-061) |
| (inline) | `go test` probes `r3_ledger_diskfull_test.go` (TC-070), `r3_hba_empty_test.go` (TC-071), `config` Parse probe (TC-068) |
