# Verification campaign of 2026-10-28: evidence index

Independent verification of `origin/main` `d51da5d0` (the merge of the fix pull request #46 for the first
campaign), without changes to the repository. The brief is
[`../2026-10-28-post-fix-verification-campaign.md`](../2026-10-28-post-fix-verification-campaign.md) (if it is
not on `main` yet, it is the file of the same name in the lead's checkout); the result and the fix prompt are
[`../2026-10-28-verification-fixes.md`](../2026-10-28-verification-fixes.md); the first campaign is
[`../test-campaign-2026-10-27/`](../test-campaign-2026-10-27/README.md).

| Folder | Content |
|---|---|
| `R/` | **fix verdicts**: `baseline.md` (commits, diff, new bundles, frozen files), `verdicts.md` (one row per finding of the first campaign, counts), the three testers' tables and per-finding notes |
| `A/` | **suites**: `README.md` (34 rows: every job of the pinned toolchain run, counts old versus new, shuffled runs, GitHub Actions), scripts, `logs-index.md` |
| `B/` | **bundle system**: `contract.md` (documented versus implemented lifecycle, 29 differences, attack plan per invariant), `invariants-matrix.md`, `conformance/` (817 executable cases for I1 to I5 and I13 to I15, `RESULTS.md`, `run.sh`), `failure/` (invariants and the failure-injection matrix on a stack, `RESULTS.md`), `rehearsal/` (the dress rehearsal on a 4.4 GB Supabase-like schema, timings), `ddl-hazard-matrix.md` and `ddl-hazard/` (34 patterns, lint and plan versus PostgreSQL, the `pgbench` scripts) |
| `C/` | **operating it**: `upgrade/` (rehearsal, rollback, timings), `control-store-loss/` (RB-10, RB-14), `backup-restore.md` and `backup-restore-numbers.md` (7.6 GB, measured RTO and RPO), `backup-restore/` (scripts), `stack/` (stack results for fail-closed, keys and time, graceful life, observability, portability), `observability.md`, `keys-certs-time.md`, `fail-closed.md`, `graceful-life.md` (the static analyses the stack runs confirm or refute), `ui/` (CLI sweep and Web App accessibility pass, if it landed) |
| `D/` | **security**: `authz/` (generated authorization matrix, harness, agent-safety map), `security/` (canaries, authorization run, dynamic agent safety, containment, network review, promotion leftovers), `sql-execution/` (the attack corpus builder, runner and results), `new-bundles-security-review.md` and `d0/` (the three new Control Store bundles), `infra/` (`bootstrap.sh`, and the **stack kit** `stack-up.sh` / `stack-env.sh`), `ops/node-cert-watch.sh`, `hetzner-resources.md` |
| `E/` | **structure**: `structure.md` (ranked weaknesses), `proposals.md` (15 proposals, each `[OPEN]`), `state-machines.md`, `vocabulary.md`, `errors.md`, `docs-claims.md` (72 claims), `recoverability.md` |
| `F/` | sources of the fix prompt: `findings-*.md` (one file per tester, strict format), `decisions-*.md` (owner questions), `merge-notes.md`, `rank.txt`, `front.md`, `order.md`, `notrun.md`, `rules.md`, `build.py` (assembles `../2026-10-28-verification-fixes.md`), `readiness.md` (Block F), `agent-rules.md` (the rules every tester agent got) |

## Deliberately not committed

This repository is public. Kept on the lead's machine, outside the repository:

- **Raw logs** of all runs (about 28 MB: `~/exdb-vc-raw/vc-1`, `vc-2`; the third server's logs are added at the end), and everything the
  testers' index files call "raw logs on the server". Findings quote the lines that matter.
- **Regenerable fixtures and result data** (about 10,000 lines): the 79 DDL hazard bundles and their plan and lint JSON
  (`B/ddl-hazard/fixtures`, `results`, `evidence`; rebuild with `B/ddl-hazard/tools/`), the SQL attack corpus and its per-run data
  (`D/sql-execution/corpus.jsonl`, `data/`; rebuild with `build-corpus.mjs`), the dress rehearsal's excerpts and authored bundles
  (`B/rehearsal/results`, `project`; rebuild with `B/rehearsal/scripts/`), the authorization matrix JSON (`D/authz/*.json`; rebuild with
  `gen-matrix.ts`), the reviewer's SQL logs (`D/d0/logs`), the testers' small probe scripts (`R/R*-notes/probes`), the suites' summary JSON
  (`A/*.summary.json`) and exploratory outputs. They are packed in `~/exdb-vc-raw/evidence-excluded-2026-10-28.tgz` (154 KB); findings
  that cite a path under one of these folders cite the archived file.
- **Raw dumps of the live installation**: none were taken; the three live reads are summarized in the fix prompt.
- **Secrets, canaries, IP addresses of real servers, e-mail addresses**: none are in the committed files (checked with `bun run secrets` and
  a scan; see the pull request description).
- **Screenshots** of the Web App pass, if taken (kept on the lead's machine).

## Size of this pull request

About 36,000 lines in about 590 files, **above the brief's aim of 12,000**. It contains no logs and no dumps; roughly 10,000 lines are reports
and findings, the rest are test sources and scripts that the findings cite as their exact reproduction (the executable conformance cases, the
stack kit, the failure-injection and backup scripts, the authorization and SQL-guard harnesses). If the owner prefers, the scripts can move
to a second pull request without losing any report.

## How to resume or reproduce

`D/infra/bootstrap.sh` builds a disposable replica of the CI toolchain on an Ubuntu 24.04 `cx33`; `D/infra/stack-up.sh` builds a complete
ExponetDB stack from any commit (`COMMIT=<sha> STACK_NAME=<name> PORT_BASE=<n> ./stack-up.sh`); `B/conformance/run.sh <checkout> pure|int|all`
runs the executable invariants; `F/build.py` reassembles the fix prompt from the findings parts. The agents' rules are in `F/agent-rules.md`.
