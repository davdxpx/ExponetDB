# Test campaign of 2026-10-27: evidence index

Test of `origin/main` at `d0229550` (Wave 9 Part B, PR #43) without changes to the
repository. The result and the fix work are in
[`../2026-10-27-test-campaign-fixes.md`](../2026-10-27-test-campaign-fixes.md); the brief
is [`../2026-10-27-full-test-campaign.md`](../2026-10-27-full-test-campaign.md).

| Folder | Content |
|---|---|
| `A/` | automated suites: logs and the verdict table |
| `B/` | review and gate open items: static audit, gate evidence map, Part A P1 reproductions, migration engine failure cases |
| `C/` | live installation (read and scratch only): CLI sweep, MCP reads, Web audit, node plan report, migration attempt |
| `D/` | disposable servers: host scenarios, CI replica, gap scenarios, backup/restore end to end |
| `E/` | the eleven findings of brief section 1.E |
| `F/` | sources of the fix prompt (`build.py` assembles it) |

## Not committed

This repository is public. The raw outputs of the live installation and of the live
node are therefore kept on the test lead's machine and are not part of this change:

- `C/raw/` (CLI outputs: identities, bindings, OAuth clients, audit, schema, backups)
- `C/node-inspect/` (node capability outputs: hba, roles, configuration, logs)
- `C/node-plans/` (node plan bodies)

The raw run outputs (`*.log` and `*.txt` in `A/` to `E/`: full suite logs, CI replica
logs, per-test outputs) are not committed either; they are about 32,700 lines and stay
on the test lead's machine. The reports, scripts, test sources and JSON remain, and the
verdict of each run is in the reports and in `A/README.md`.

Findings that cite these paths summarize them in the reports `C/cli-read-sweep.md`,
`C/node-plans-report.md` and `C/live-mcp-reads.md`. The public IP address of
`reos-db-01` in the brief is replaced by a placeholder.
