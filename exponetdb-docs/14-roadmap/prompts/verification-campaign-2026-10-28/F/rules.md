
## 7. Rules for this fix session (they override anything you infer)

These come from the campaign brief (§1) and from `CLAUDE.md`; where they differ,
`CLAUDE.md` and the constitution win.

- Work in the repository `/home/david/Development/ExponetDB`. Start from the latest
  `origin/main` (`git fetch origin --prune`; the campaign tested `d51da5d0`, and `main` has
  moved on, for example #47). Create **your own worktree and branch**
  (`git worktree add ../ExponetDB-verification-fixes -b fix/verification-campaign-2026-10-28 origin/main`);
  never work in the main checkout and never reuse another session's worktree. Split the
  work into **several pull requests** along the groups of section 5 (the first campaign's
  single pull request of 34 commits was hard to review); each group is one branch.
- **Commits** are authored as `𝕏0L0™ <davdxpx@gmail.com>`
  (`git -c user.name='𝕏0L0™' -c user.email='davdxpx@gmail.com' commit …`). Claude is
  never the author or co-author: **no** `Co-Authored-By` trailer, **no** session
  link, **no** "Generated with" line. At the end of a commit body or the pull request
  description at most `Developed by @davdxpx`. Conventional Commits
  (`fix:`, `feat:`, `docs:`, `test:`), atomic: code, tests and docs of one
  fix in one commit. Commit and push after every finding; no "commit later".
- **Tests first for every fix** (red, then green) and **prove the red**: run the new test
  against the unfixed source and keep the failing assertion in the commit body. A regression
  test that passes on the old code is a finding of this campaign's kind (VACUOUS TEST).
  Never skip, disable, quarantine or weaken a test to get green; never raise a timeout to
  get green. Tests that need PostgreSQL run against real PostgreSQL
  (`bun run dev:control-store`, `bun run dev:targets`; use your own container names and
  ports, other sessions share the machine).
- **Run the verification on the pinned toolchain** (Node 24.22.1, Bun 1.4.4, Go 1.26.10,
  Ubuntu 24.04, UTC, `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04`); `bun run toolchain` must pass.
  A local machine outside `engines` gives wrong verdicts (the first campaign lost time to that).
  `D/infra/bootstrap.sh` in the evidence folder builds a disposable replica (a `cx33` is enough).
- **Do not merge and do not redeploy.** The owner does both on request. Do not
  change Coolify settings or environment variables, do not touch the live
  installation `https://db.exponet.cloud` (reads only, and only if a finding's
  acceptance test says so), never apply anything to `reosa/platform/staging`
  or `reosa/platform/scratch`, never touch Supabase (REOSA production is out of scope),
  never change the REOSA repository, never touch `reos-db-01`. A redeploy is the
  riskiest operation the owner does: nothing in this fix session may be a reason to
  redeploy before the upgrade findings (section 4, the upgrade and recovery group) are closed.
- **Frozen things stay frozen**: `c1`, `ls1`, `fp1`, plan-hash construction,
  golden vectors (append-only), and every frozen Control Store bundle. A
  change of stored behavior is a new, additive bundle (and the next free ADR
  number if a decision is needed). `bun run golden:check` and
  `bun run golden:history origin/main` must stay green. **New Control Store bundles
  are pinned in `frozen-bundles.json` and `immutable-bundles.test.ts` as soon as they are
  merged and deployed** (24 of 45 are not pinned today).
- **Documentation first**: every behavior change updates its document in the
  same commit. **Update the gate and review documents you touch**:
  `exponetdb-docs/14-roadmap/PRE-WAVE-11-REVIEW.md` (add a section
  `## Verification campaign fixes – Parallel Session`, never edit another session's
  section), the gate records, `acceptance-gates.md` where a criterion's evidence
  changed, and `exponetdb-docs/00-product/open-decisions.md` for every open
  owner question (never decide an owner question silently; use the
  existing OD numbers or add the next free one).
- **Secrets**: never print, log, commit or store a secret, token, password,
  verifier or connection string with a password. Fixtures use obviously fake
  values. The repository is public: no raw dumps of the live installation, no IP
  addresses of real servers, no e-mail addresses, no raw logs in a pull request.
- **Scope**: fix what a finding says, in the smallest correct change, and
  nothing else. Findings marked *owner decision* get the decision recorded as
  an open decision with the options and your recommendation, and get no silent
  implementation. If a finding turns out to be wrong, say so with evidence in
  the finding's row of the pull request description and the review document; do not
  "fix" it anyway.
- **Verification before each pull request**: `bun run verify` (all parts), plus the
  finding-specific acceptance tests, plus `bun run go:test`, and for the node agent
  the host scenarios on a disposable systemd host (not on `reos-db-01`). Report
  what you could not run.
- **Do not start another campaign from inside the fix session.** If a finding's
  acceptance test needs a stack, use `D/infra/stack-up.sh` of the evidence folder.
- English (US spelling) for code, identifiers, documentation and commit messages.
