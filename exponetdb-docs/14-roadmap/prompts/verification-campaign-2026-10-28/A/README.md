# Block A: the automated suites again (INTERIM, being filled while the runs finish)

Commit under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad`, pre-fix `d0229550`. Server `vc-1` only
(Ubuntu 24.04, 4 vCPU, 8 GB, UTC). Fresh clones of the public repository at `/srv/work/new` and
`/srv/work/old`. Raw logs stay on the server, see `logs-index.md`.

## Toolchain (printed on the server, `/srv/work/toolchain.txt`)

| Tool | Version |
|---|---|
| Node | v24.22.1 |
| Bun | 1.4.4 |
| Go | go1.26.10 linux/amd64 |
| PostgreSQL (PGDG packages, for the host jobs) | 16.15, 17.11, 18.6 |
| pgBackRest / restic | 2.60.0 / 0.16.4 |
| Docker | 29.1.3 (Ubuntu package; `docker-buildx` 0.30.1 added by me, see "Bootstrap changes") |
| Time zone | UTC |

Verdicts so far are in the table below; rows marked RUNNING are filled in by the final version.

| Job / check | Verdict | One line |
|---|---|---|
| biome ci | PASS | 2411 files, no fixes |
| typecheck | PASS | 29/29 tasks, 129 s |
| unit tests (run 1, normal order) | PASS | 512 files, 10,383 tests, 0 failed, 0 skipped, 855 s |
| build | PASS | 23/23 tasks, 43 s |
| MCP conformance + Inspector | PASS | 2 files, 5 tests |
| verify:generated, golden:check, golden:history (x2), boundaries, secrets, bun audit, third-party, licenses, ui-safety, toolchain, verify:host --list | PASS | all exit 0; working tree clean afterwards |
| integration (PG 17 Control Store, targets 16/17/18, S3) run 1 | PASS | 105 files, 1,716 tests, 0 failed, 541 s |
| packed CLI install, CLI process suite on installed artifact | PASS | 5 + 16 tests |
| browser e2e, `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04` | PASS | 10 files, 52 tests, 301 s |
| go (gofmt, vet x4 tags, e2e tag test, race, fuzz, govulncheck) as root | PASS | |
| go release build + `verify-units.sh` as root | FAIL (test-script bug, see findings-A) | passes as non-root, as CI runs it |
| image (build, non-root user, roles smoke, CLI lab, quickstart) | PASS | after adding BuildKit to the VM |
