## 7. Rules for this fix session (they override anything you infer)

These come from the campaign brief (§0) and from `CLAUDE.md`; where they differ,
`CLAUDE.md` and the constitution win.

- Work in the repository `/home/david/Development/ExponetDB`. Start from
  `origin/main` (check `git fetch origin`; the campaign tested `d0229550`).
  Create **your own worktree and branch** (`git worktree add ../ExponetDB-testcampaign-fixes -b fix/test-campaign-2026-10-27 origin/main`);
  never work in the main checkout and never reuse another session's worktree.
  One branch, **one pull request**.
- **Commits** are authored as `𝕏0L0™ <davdxpx@gmail.com>`
  (`git -c user.name='𝕏0L0™' -c user.email='davdxpx@gmail.com' commit …`). Claude is
  never the author or co-author: **no** `Co-Authored-By` trailer, **no** session
  link, **no** "Generated with" line. At the end of a commit body or the PR
  description at most `Developed by @davdxpx`. Conventional Commits
  (`fix:`, `feat:`, `docs:`, `test:`), atomic: code, tests and docs of one
  fix in one commit. Commit and push after every finding; no "commit later".
- **Tests first for every fix** (red, then green). Never skip, disable or
  quarantine a test to get green. Tests that need PostgreSQL run against real
  PostgreSQL (`bun run dev:control-store`, `bun run dev:targets`; use your own
  container names and ports, other sessions share the machine).
- **Do not merge and do not redeploy.** The owner does both on request. Do not
  change Coolify settings or environment variables, do not touch the live
  installation `https://db.exponet.cloud` (reads only if a finding's
  acceptance test says so), never apply anything to `reosa/platform/staging`
  or `reosa/platform/scratch`, never touch Supabase (REOSA production
  `zmlegaporyathnfvnbrv` is out of scope), never change the REOSA repository.
- **Frozen things stay frozen**: `c1`, `ls1`, `fp1`, plan-hash construction,
  golden vectors (append-only), and every frozen Control Store bundle. A
  change of stored behavior is a new, additive bundle (and the next free ADR
  number if a decision is needed). `bun run golden:check` and
  `bun run golden:history origin/main` must stay green.
- **Documentation first**: every behavior change updates its document in the
  same commit. **Update the gate and review documents you touch**:
  `exponetdb-docs/14-roadmap/PRE-WAVE-11-REVIEW.md` (add a section
  `## Test campaign fixes – Parallel Session`, never edit another session's
  section), the gate records (`gates/6.md` waiver table for E16/E18, `gates/9.md`,
  `gates/9-part-a.md`), `acceptance-gates.md` where a criterion's evidence
  changed, and `exponetdb-docs/00-product/open-decisions.md` for every open
  owner question (never decide an owner question silently; use the
  existing OD numbers or add the next free one).
- **Secrets**: never print, log, commit or store a secret, token, password,
  verifier or connection string with a password. Fixtures use obviously fake
  values.
- **Scope**: fix what a finding says, in the smallest correct change, and
  nothing else. Findings marked *owner decision* get the decision recorded as
  an open decision with the options and your recommendation, and get no silent
  implementation. If a finding turns out to be wrong, say so with evidence in
  the finding's row of the PR description and the review document; do not
  "fix" it anyway.
- **Verification before the PR**: `bun run verify` (all parts), plus the
  finding-specific acceptance tests below, plus `bun run go:test` and, for the
  node agent, the host scenarios on a disposable systemd host (not on
  `reos-db-01`). Report what you could not run.
- English (US spelling) for code, identifiers, documentation and commit messages.
