# Verification campaign of 2026-10-28: evidence index

Independent verification of `origin/main` `d51da5d0` (the merge of the fix pull request #46 for the first
campaign), without changes to the repository. The brief is
[`../2026-10-28-post-fix-verification-campaign.md`](../2026-10-28-post-fix-verification-campaign.md); the result and the fix
prompt are [`../2026-10-28-verification-fixes.md`](../2026-10-28-verification-fixes.md) (160 findings: P0 0, P1 17, P2 63, P3 80);
the first campaign is [`../test-campaign-2026-10-27/`](../test-campaign-2026-10-27/README.md).

This pull request holds **documents only**. Start with `F/readiness.md` (Wave 11 scorecard) and the fix prompt.

| Folder | Content |
|---|---|
| `R/` | **fix verdicts**: `baseline.md` (commits, diff, new bundles, frozen files), `verdicts.md` (one row per finding of the first campaign, counts), per-finding notes of the three testers |
| `A/` | **suites**: `README.md` (34 rows: every job of the pinned toolchain run, counts old versus new, shuffled runs, GitHub Actions) |
| `B/` | **bundle system**: `contract.md` (documented versus implemented lifecycle, 29 differences, attack plan per invariant), `invariants-matrix.md`, `conformance/RESULTS.md` (817 cases), `failure/RESULTS.md` (invariants and the failure-injection matrix on a stack), `rehearsal/README.md` (the dress rehearsal on a 4.4 GB Supabase-like schema, timings), `ddl-hazard-matrix.md` (34 patterns) |
| `C/` | **operating it**: `upgrade/`, `control-store-loss/`, `backup-restore.md` and `backup-restore-numbers.md` (7.6 GB, measured RTO and RPO), `stack/` (fail-closed, keys and time, graceful life, observability, portability), the static analyses `observability.md`, `keys-certs-time.md`, `fail-closed.md`, `graceful-life.md`, `ui/` (CLI sweep of 92 cases, Web accessibility pass) |
| `D/` | **security**: `authz/` (generated authorization matrix, agent-safety map), `security/` (canaries, authorization run, dynamic agent safety, containment, network review, promotion leftovers), `sql-execution/results.md`, `new-bundles-security-review.md`, `hetzner-resources.md` |
| `E/` | **structure**: `structure.md` (ranked weaknesses), `proposals.md` (15 proposals, each `[OPEN]`), `state-machines.md`, `vocabulary.md`, `errors.md`, `docs-claims.md` (72 claims), `recoverability.md` |
| `F/` | the fix prompt's sources: `decisions-*.md` (owner questions per tester), `merge-notes.md`, `front.md`, `order.md`, `notrun.md`, `rules.md`, `readiness.md` (Block F), `agent-rules.md` |

## Deliberately not in this pull request

This repository is public and the brief asks for a pull request of documents under about 12,000 lines. Kept on the owner's machine, outside
the repository (`~/exdb-vc-raw/`):

- **Scripts, test sources and findings parts** (about 25,000 lines): `evidence-scripts-and-parts-2026-10-28.tgz`. It restores every path the
  findings cite as their reproduction: `B/conformance/` (the 817 executable cases, `run.sh`), `B/failure/`, `B/rehearsal/scripts/`,
  `B/ddl-hazard/tools` and `pgbench`, `C/stack/scripts`, `C/upgrade/scripts`, `C/backup-restore/`, `D/infra/` (`bootstrap.sh` and the stack kit
  `stack-up.sh`, `stack-env.sh`), `D/authz/` (generator and harness), `D/security/scripts`, `D/sql-execution/` (corpus builder and runner),
  `D/ops/node-cert-watch.sh`, `E/scripts/`, `F/findings-*.md` (the strict-format parts) and `F/build.py` (reassembles the fix prompt:
  `tar xzf evidence-scripts-and-parts-2026-10-28.tgz -C <this folder>` then `python3 F/build.py`). They can be published as a separate
  pull request on request.
- **Regenerable fixtures and result data** (about 10,000 lines): `evidence-excluded-2026-10-28.tgz` (the 79 DDL hazard bundles and their plan and
  lint JSON, the SQL attack corpus and its per-run data, the dress rehearsal's excerpts and authored bundles, the authorization matrix JSON,
  the reviewer's SQL logs, the testers' probe scripts, the suites' summary JSON), and `sql-execution-results-full.md` (the per-statement table
  of 607 statements that `D/sql-execution/results.md` summarises by class here).
- **Raw logs** of all runs (about 56 MB: `~/exdb-vc-raw/vc-1`, `vc-2`, `vc-3`, `d2-out`), and the full branch before it was reduced
  (`evidence-branch-full-2026-10-28.bundle`, a git bundle of the 29 commits).
- **Raw dumps of the live installation**: none were taken; the three live reads are summarised in the fix prompt.
- **Secrets, canaries, IP addresses of real servers, e-mail addresses**: none are in the committed files (`bun run secrets` over all tracked
  files is green; manual scans are clean).
- **Screenshots** of the Web App pass (114, kept in the raw logs).

Paths in the findings under the folders above (for example `C/stack/scripts/...`, `B/conformance/...`) therefore resolve only after the
archive is extracted.
