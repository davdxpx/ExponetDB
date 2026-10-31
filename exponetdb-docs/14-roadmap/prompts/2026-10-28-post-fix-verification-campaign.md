# ExponetDB verification and hardening campaign (after the fixes of the 2026-10-27 test campaign)

Run this session at effort extra high. Work in `/home/david/Development/ExponetDB`
(`cd` there first; this session may start in its parent folder). Read this brief
completely, then execute it in order.

## 0. Why this session exists

The test campaign of 2026-10-27 found 75 problems in `origin/main` at `d0229550`
([fix prompt](./2026-10-27-test-campaign-fixes.md), pull request
`davdxpx/ExponetDB#45`). A fix session has since claimed to fix them. You are the
**independent second pair of eyes**:

1. **Do not trust the fix.** Prove, finding by finding, that it is fixed, that its test
   would have failed before the fix, and that it broke nothing else.
2. **Keep hunting.** Find the edge cases, failure modes and operator traps that would
   disturb a production operation, which no test has looked at yet.
3. **Judge the bundle system.** Migrations are now clean packages (bundles) that can be
   planned, applied, verified and replayed. That is the best idea in this product, and
   production will lean on it. Test it harder than anything else, and say plainly where
   the structure is unclear, implicit or missing.

The question this campaign answers: **can REOSA's production database be managed by
this system (Wave 11) without surprises, and what stops that today?** You do not
authorize Wave 11; you give the owner evidence.

## 1. Ground rules (they override anything you infer)

**Do not change the repository.** No commits to `main`, no branch except your evidence
pull request (section 6), no edits to code, bundles, `frozen-bundles.json`, golden
vectors or generated files. Tests you write live in the evidence folder or in a
throwaway worktree, never in the product tree.

**What may be touched**

| Where | Allowed |
|---|---|
| Local machine, local Docker | anything you create and remove yourself |
| Hetzner Cloud | at most 3 servers at a time, type `cx33`, `nbg1` or `fsn1`, label `purpose=exponetdb-test-campaign`, one throwaway SSH key per server; token from `~/.config/reos-secrets/hcloud-auth-header` (never print it). **Write every server id and key id into `D/hetzner-resources.md` the moment it is created**, and delete all of them at the end (list the ids as deleted). Put the throwaway keys in a `0700` folder outside the scratchpad (a session restart wipes the scratchpad). Never touch `reos-db-01` or any pre-existing server. |
| Live installation `https://db.exponet.cloud` | **reads that have no side effect, only.** Tokens in `~/.config/exponetdb/credentials.json`. No `advisors_run` (it records findings), no plans of any kind (they stay as rows), no node plans, no apply, no approval, no Web App session in the owner's browser. If a read is denied by the permission layer, record NOT RUN; do not work around it. |
| `reosa/platform/staging`, `reosa/platform/scratch` | **no apply, no plan, no write.** Applies and engine failure tests run on your own disposable stack (section 3, "Disposable stack"). |
| Supabase (REOSA production project), Coolify settings and env vars, redeploys | out of scope. Do not touch. |
| `reos-db-01` | read only, and only if a check cannot be done elsewhere. |

**Secrets.** Never print, log, commit or paste a token, password, verifier, key or a
connection string with a password. Pass secrets by file or stdin; show counts, hashes
and ids. Plant **canary secrets** (section 4, block D) to prove none leaks.

**Public repository.** `davdxpx/ExponetDB` is public. Commit only reports, scripts,
test sources and small JSON. **No raw logs** (the first campaign's pull request had
42,000 lines, three quarters of it logs; keep logs on disk, quote the lines that
matter), **no raw dumps of the live installation** (identities, clients, audit, hba,
roles), no IP addresses of real servers, no e-mail addresses. Aim for a pull request
under 12,000 lines.

**Git identity.** Commits as `𝕏0L0™ <davdxpx@gmail.com>`; never "Claude" as author or
co-author, no `Co-Authored-By`, no session links, no "Generated with" line; at the end
at most "Developed by `@davdxpx`". Same for the pull request title, body and comments.

**Method.** A claim needs a reproduction you ran. "The code looks right" is not a
verdict. Every finding has the exact commands, the expected and the actual result, and
a place where the evidence lives. A check you could not run is `NOT RUN` with the
reason, never a quiet pass. If you find a **P0** (data loss, secret exposure, a way to
change production without the gates), stop other work, tell the owner in your next
message, and continue only after that.

**Severity.** P0 data loss, security, production outage. P1 wrong result, blocked core
flow, or anything that makes a production apply, restore or upgrade unsafe or
unrecoverable. P2 degraded, a workaround exists. P3 polish.

**Sub-agents** may run independent tests in parallel (give each a narrow scope, the
rules above, and a report file to write). Check their evidence before you accept a
claim, and write the findings yourself.

## 2. Step 0: establish the baseline

1. `git fetch origin --prune`. Never touch the branch checked out in
   `/home/david/Development/ExponetDB` (another session may use it). Create your own
   worktree from the commit under test: `git worktree add --detach ../ExponetDB-verify <sha>`.
2. Find the commit under test: the latest `origin/main` after the fix pull request(s)
   merged (`gh pr list --repo davdxpx/ExponetDB --state all --search "test campaign"`).
   If they have not merged, test the head of the fix branch and say so in every verdict.
3. Read, completely: the fix prompt `exponetdb-docs/14-roadmap/prompts/2026-10-27-test-campaign-fixes.md`,
   the evidence index `test-campaign-2026-10-27/README.md` (both are on `main` once pull
   request #45 has merged; until then read them on branch `feat/test-campaign-2026-10-27`
   with `git show`), the fix pull request(s) (description, commits, diff), and
   `exponetdb-docs/14-roadmap/PRE-WAVE-11-REVIEW.md`.
4. Record in `R/baseline.md`: pre-fix commit `d0229550`, the commit under test, `git diff
   --stat` between them, every **new migration bundle** and every touched frozen file
   (`packages/control-store/frozen-bundles.json`, golden vectors, `c1`/`ls1`/`fp1`/plan
   hash code). A frozen file that changed is at least a P1 until an ADR says otherwise.
5. Read the product's own statement of how migrations work before you test it:
   `exponetdb-docs/04-migrations/` (`migration-bundles.md`, `planning-and-apply.md`,
   `ledger.md`, `concurrency.md`, `failure-and-recovery.md`, `verification.md`,
   `staging-production-policy.md`, `legacy-import.md`, `authoring-and-ci.md`,
   `dependency-graph.md`), `exponetdb-docs/12-operations/` (`upgrades.md`,
   `control-store-runbook.md`, `backup-runbooks.md`, `node-runbook.md`,
   `deployment.md`) and `exponetdb-docs/09-backups-and-restore/`.

## 3. Lessons of the first campaign (they save you hours)

- **Pinned toolchain.** The lead's machine ran Node 26.5 and Bun 1.3.14 (outside
  `engines`) and failed a time-zone test and the machine-specific visual baselines. CI
  runs Node 24.22.1, Bun 1.4.4, Go 1.26.10 on Ubuntu 24.04 in UTC with
  `EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04`. Run the suites on a disposable cx33 with
  exactly that, and use the local machine only for quick checks. How the first campaign
  built the replica: `test-campaign-2026-10-27/D/` (`ci-replica/`, `hetzner-resources.md`).
- **cx33 has 8 GB.** Run turbo with `--concurrency=2`; install `bunx` (symlink to bun);
  the audit-export integration test needs an S3 container (versitygw); install
  PostgreSQL 16/17/18 from PGDG, pgBackRest 2.60.0 and restic 0.16.4.
- **zsh.** Quote globs, use arrays for word splitting, do not paste `=====` lines as
  commands. Prefer small wrapper scripts over long one-liners.
- **Reusable tests.** `test-campaign-2026-10-27/B/migration-engine/tests/tc-*.int.test.ts`
  (migration engine failure cases), `D/backup-restore-e2e/{scripts,host-tests}` (backup,
  restore, PITR, drills on a real systemd host), `D/gap-scenarios/`, `F/build.py`
  (assembles a fix prompt from findings parts). Reuse and extend them.
- **Host world.** `apps/server/test/support/host-world.ts` and
  `apps/server/test/host/*.host.test.ts` run a real agent on a real systemd host; Go
  suites use build tags `pgit`, `pglab`, `e2e`. CI never ran `pglab` or
  `runbook.lab.test.ts`; check whether it does now.
- **Disposable stack.** Build a complete ExponetDB (Control Store on PostgreSQL, serve,
  worker, gateway, a node agent on a systemd host, 3 targets on PostgreSQL 16, 17 and 18)
  from the commit under test, either in local Docker (`bun run smoke:image` shows how
  the image is built) or on a cx33. Every engine, failure and recovery test below runs
  there. **Never on the live installation.**

## 4. The blocks

Every block ends with a verdict (PASS, FAIL, PARTIAL, NOT RUN) and a one-line reason.
Evidence goes to the folder of the block (section 5).

### Block R: verify the fixes

For **every** finding `TC-001` to `TC-075` and the eleven findings `E1` to `E11` of the
first campaign:

1. Re-run the finding's reproduction on the commit under test. Verdict per finding:
   `FIXED`, `PARTIAL` (say what remains), `NOT FIXED`, `REGRESSED` (it worked at
   `d0229550` and does not now), `CHANGED BY DECISION` (the fix prompt said "owner
   decision" and the fix recorded an open decision instead).
2. Run the finding's acceptance test. Then the **fails-before check**: take the
   regression test(s) the fix added, run them against the **old source** (a worktree at
   `d0229550` with only the test files copied in). A test that passes on the old code
   proves nothing: mark the finding `VACUOUS TEST`.
3. Read the diff of each fix for: scope creep, a weakened assertion, a skipped or
   quarantined test (forbidden), a changed expected value in a golden or fixture, a new
   dependency, a swallowed error, and a fix of the symptom instead of the root cause.
4. Probe each fix's **neighbours**: the same bug class elsewhere (all callers of the
   changed function, the sibling code path in the Web App, the REST route, the MCP tool,
   the CLI command, the SDK).

Output `R/verdicts.md`: one table, one row per finding, plus counts. A finding fixed
but with a vacuous test, or a regression, is a new finding.

### Block A: the automated suites again

Run on the pinned toolchain (section 3): typecheck, unit, build, integration (PostgreSQL
16/17/18 targets), browser end-to-end with the CI baselines, MCP conformance, `go vet`,
`go test -race`, `pgit`, `pglab`, the agent-capabilities host test, all host scenarios,
and the check scripts in `package.json` (`secrets`, `boundaries`, `golden:check`,
`golden:history`, `third-party`, `licenses`, `ui-safety`, `bun audit`, `biome ci`,
`smoke:image`). Also:

- Compare the test count and the coverage with `d0229550`; a drop needs an explanation.
- Run the unit and integration suites **twice**, once with a shuffled file order, and
  list every test that differs (order dependence, flakiness).
- Check the GitHub Actions run of the commit under test: which jobs ran, which are
  required, which never ran.

### Block B: the bundle system (the focus)

Treat bundles as a product with a contract. First write `B/contract.md`: the lifecycle
as **documented** (authoring, lint, store, plan, approve, apply, verify, ledger and
mirror, drift, promote, rollback, replay) as a state diagram, then the lifecycle as
**implemented** (read the code and observe it), and mark every difference.

Then test these **invariants**. Each becomes an executable test in
`B/conformance/` (property-based where a generator helps), runnable by CI later:

| # | Invariant | How to attack it |
|---|---|---|
| I1 | **Determinism.** Same bundles and same target state give the same plan hash on any machine, Node and Bun version, locale and time zone. | Build the plan on three runtimes; shuffle file order; change `TZ`, `LANG`; compare bytes. |
| I2 | **Content identity.** The checksum changes if and only if executable text or an execution field changes (`c1`). | Edit classes: comment only, whitespace, CRLF vs LF, BOM, trailing newline, a string literal, keyword case, statement order, Unicode normalization, manifest fields (execution vs metadata). Compare with `migration-bundles.md` §3 and report every ambiguity. |
| I3 | **Order is the DAG.** Only `dependsOn` orders execution; file names and ULIDs never do. | Diamonds, a 1,000-deep chain, a 5,000-wide fan-out, a cycle, a self-dependency, a dependency on an unknown id, a dependency across projects; equal DAGs in different file orders. |
| I4 | **Atomicity.** A transactional bundle is applied fully with its ledger row or not at all; `up.sql` cannot end the transaction early. | `COMMIT`, `ROLLBACK`, `SAVEPOINT`/`RELEASE`, `BEGIN` nesting, `SET SESSION AUTHORIZATION`, `RESET ROLE`, `SET search_path`, a `DO` block or `PROCEDURE` that commits, `\` meta text, statements that cannot run in a transaction (`CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CREATE DATABASE`, `ALTER TYPE ... ADD VALUE`). The result must be a clear refusal at lint or plan time, or a correct non-transactional run alone in its plan. |
| I5 | **Parser equals server.** What the lexer treats as one statement is what PostgreSQL executes. | Dollar quoting with tags, `E''` and `U&''` strings, `standard_conforming_strings` off, nested block comments, quoted identifiers with `;` and `--`, single-quoted `DO` bodies (the first campaign's P1), `\` in strings, multi-megabyte inputs, 100,000 tiny statements, deeply nested parentheses. Fuzz the parser against the server. |
| I6 | **Truth.** `applyOutcome` is never reported as success before `verificationOutcome`; unknown state fails closed. | Kill things at every step (list below); `verify.sql` that fails, hangs, writes, or is missing. |
| I7 | **No silent adoption.** Nothing found out of band is ever recorded as expected without an attributed human action. | Add a `GRANT ... TO PUBLIC`, a trigger, a policy, a changed default privilege, an extension upgrade between two applies; plan and apply the next bundle; read the baseline. |
| I8 | **Single writer.** One schema change per target at a time, across servers, workers and restarts. | Two applies at once (same target; same cluster, different targets), apply during a failover or `pg_ctl restart`, a held advisory lock `EXDB`, a crashed session. |
| I9 | **Every state has an exit.** Every non-terminal operation state (`needs_attention`, `awaiting_approval`, `verifying`, partially applied, stale) has a documented way out for an authorised human, from the CLI and the Web App. | Build the state graph from code and docs; drive each state; try the exit; audit it. Dead ends are P1. |
| I10 | **Replay equivalence.** Applying the whole bundle history to an empty database gives a schema whose `fp1` fingerprint equals the live target's, or the diff is explained. | See the dress rehearsal below. |
| I11 | **Portability.** Bundles are plain files; they validate, plan and apply from a Git checkout with the CLI, offline; the ledger in the target is readable without ExponetDB (C-35). | Run the whole flow with the Control Store stopped, where the docs promise it; read the ledger with `psql` only. |
| I12 | **Promotion.** Production accepts only a checksum applied **and verified** on the evidence environment, or break-glass. | Try: an environment alias or label swap, a bundle re-uploaded under the same id with other bytes, a verified-then-restored evidence target, an evidence run that was `applied` but not `verified`, a self-approval, an agent (MCP, OAuth client, service account) path, a REST path, the CLI, an old plan after a policy change. |
| I13 | **Immutability.** Applied content cannot change; the same id with other bytes is refused everywhere. | CLI, REST, MCP, import, the stored-bundle store, concurrent uploads. Also the first campaign's dangling stored bundle (it poisoned planning for a whole project). |
| I14 | **Containment.** Hostile bundle content cannot exhaust the server or reach the host or another target. | Giant or deeply nested files, a symlink in a bundle directory, path traversal in names, `COPY ... PROGRAM`, `pg_read_server_files`, `CREATE EXTENSION plpython3u`, `ALTER SYSTEM`, `dblink`/`postgres_fdw` to another target, `\connect`. The apply role must be unable, and the refusal must be clear and audited. Measure memory and CPU of the server during each. |
| I15 | **Limits are announced.** Every limit (size, count, depth, time) has a named error and a documented value. | Hit each one; compare with the docs. |

Also produce **`B/ddl-hazard-matrix.md`**: a table of the DDL patterns that hurt a busy
production database (non-concurrent `CREATE INDEX`, `ADD COLUMN` with a volatile default,
`ALTER COLUMN TYPE` rewrites, `SET NOT NULL` full scans, `ADD FOREIGN KEY` without
`NOT VALID`, `ALTER TYPE`, `DROP COLUMN` still read by apps, renames, long `ACCESS
EXCLUSIVE` locks, unbounded `UPDATE` backfills, `CREATE TRIGGER`/`POLICY` on hot tables,
extension upgrades, enum changes, partition attach). For each: does lint, plan or an
advisor warn **before** apply, what does the apply do to a table under load
(`lock_timeout`, `statement_timeout`, queueing behind long transactions), and what is
the safe form. Measure with `pgbench` running during the apply on a table of realistic
size (millions of rows); report p99 latency and failed queries.

**Failure injection around apply** (on the disposable stack, each at each phase: before
plan, between plan and apply, after the lock, mid-statement, after commit before ledger
mirror, during verify): `kill -9` of serve, worker and node agent; restart of the
Control Store; `pg_ctl restart -m immediate` of the target; `pg_terminate_backend` of the
apply session; dropped packets between server and target (`iptables`/`tc`); disk full on
the target and on the Control Store; a clock jump of the server and of the node; a
client that times out and retries (duplicate apply?). After each: is the operation state
true, is the ledger consistent with the schema, is there a single documented way
forward, and is nothing re-executed automatically?

**Restore and clone traps.** Restore a target from backup (and PITR to a time before the
last bundle): the ledger is now older than the Control Store's mirror; what does the
system do (the waived failure case E25, "no recovery", is this the moment it must be
fixed)? Promote a replica. Clone a database (`CREATE DATABASE ... TEMPLATE`, `pg_dump |
pg_restore`): the clone carries the identity marker `(installation_id, target_id,
generation)`; an apply against the clone must be refused, not executed. Rename a
database. Restore into a different cluster. Logical replication target.

**Dress rehearsal (flagship scenario).** On the disposable stack, build a Supabase-like
schema: 300+ tables, 50+ functions, RLS policies, triggers, extensions (`pgcrypto`,
`uuid-ossp`, `pg_stat_statements`, `pg_trgm`), roles, publications, 1 to 5 GB of data.
Then run the whole Wave 11 flow as an operator would: **import** a realistic legacy
history (timestamped `supabase/migrations`-style files, including hostile ones: `DO`
blocks, `CREATE EXTENSION ... SCHEMA`, policies, grants, `ALTER DEFAULT PRIVILEGES`) into
bundles, **baseline**, **plan**, **apply under `pgbench` load**, introduce **drift**,
**back up**, **restore** (PITR), **reconcile**, **promote** staging to production with
the evidence rule, and finish with the I10 replay check. Do it on PostgreSQL 16, 17 and
18. Time every step; measure the recovery time and recovery point you actually got.

**Scale.** 500 and 5,000 bundles in one project; 100 targets; plan time and memory;
pagination correctness; a Web App list with 10,000 rows.

### Block C: operating it every day (what an operator meets at 3 a.m.)

- **Upgrade rehearsal.** Install the old version (`d0229550`) on the disposable stack,
  create realistic state (targets, plans, operations including `awaiting_approval` and
  `needs_attention`, audit, a node, backups, drills, bundles in the store), take a
  `pg_dumpall` backup, upgrade to the commit under test exactly as
  `exponetdb-docs/12-operations/upgrades.md` and the deployment records describe, and
  verify everything still works and nothing was lost. Then **roll back** by the documented
  procedure and prove it works. A redeploy is the riskiest operation the owner does;
  find what the runbook leaves out.
- **Backup, restore, PITR, drills with real numbers.** Repeat the first campaign's
  backup/restore end to end (`D/backup-restore-e2e/`) on a dataset of at least 5 GB:
  full, incremental, WAL archiving, restore to a point, restore on another host, the
  restic logical path to a local repository **and** to S3, every drill kind (`latest`,
  `older`, `offline`), a corrupt backup, a corrupt WAL segment, a wrong key, a full
  repository, a deleted repository, retention. Report the measured recovery time and
  recovery point. **The first campaign could not produce a passing drill with a measured
  RTO; this one must, or say exactly why not.**
- **Control Store loss.** Destroy the Control Store on the disposable stack and recover
  with the **offline runbook as written** (C-35), using nothing from the dead system.
  Every missing step is a P1.
- **Certificates, keys, time.** Node certificate renewal across the renewal window and
  past expiry (a missed window: what then, and does anything warn?); rotation of API
  keys, OAuth signing keys and the Control Store encryption keys; a clock jump forward and
  back; expiry of plans, approvals, step-up receipts, enrollment tokens (an expired thing
  must say `expired`, and be listable and revocable).
- **Fail closed, but loudly.** Audit export (S3) down, audit sink full, Control Store
  read-only, node unreachable, DNS failure, TLS failure: which mutations stop, which
  reads still tell the truth, what the operator sees, and how recovery looks.
- **Graceful life.** Rolling restart under load; `SIGTERM` during an apply; startup
  order; health and readiness endpoints that tell the truth; resource limits; connection
  pool exhaustion; 1,000 concurrent MCP sessions; a slow client; a 100 MB request body;
  rate limits; retention and expiry sweeps; growth of the audit table and the operation
  table over a simulated year.
- **Observability.** For ten realistic failures, say what signal exists (metric, log
  line, audit event, UI badge), whether it carries the object ids an operator needs, and
  whether any alert could be built from it.
- **Web App and CLI on the disposable stack** (never the owner's browser): the flows an
  operator uses (register, import, plan, approve, apply, verify, drift, restore) at
  1440, 768 and 390 px, light and dark, keyboard only, with a screen reader pass; the
  CLI text and JSON output of every migration and backup command, error text with a
  remedy for every error code, exit codes.

### Block D: security and abuse for production

- **Authorization matrix.** Every REST route, MCP tool, CLI command and Web App action
  against every role, scope and tier (`:prod` and `:nonprod`), as a generated table:
  expected and actual. Deny by default. Include cross-project and cross-target access
  by id (IDOR), service accounts, delegated OAuth clients, step-up bypass, approval
  spoofing and self-approval, plan or token replay.
- **Agent safety.** An MCP client reads a table comment, a column name, a row or a log
  line containing instructions: nothing in it may change a policy decision or be
  returned unmarked as trusted. Agent-initiated production changes need a human
  approval on every path.
- **SQL execution.** `sql_query` and `sql_explain` cannot write or escape the read-only
  frame: `SET transaction_read_only`, `COPY ... PROGRAM`, `pg_read_file`, functions with
  side effects (`nextval`, advisory locks, `pg_sleep`, `dblink`), huge results, long
  queries, cancel behavior.
- **Canary secrets.** Plant a unique canary password in a role verifier, a connection
  secret, a node host secret and an API key on the disposable stack; run every flow
  above; then search every sink for the canary: server and worker logs, `journalctl`,
  `ps` output, audit rows, plan bodies, API and MCP responses, error messages, traces,
  the backup catalog, crash dumps, exports, the Web App's network responses. One hit is
  a P0.
- **Network.** SSRF through CIMD or webhook URLs, redirects, DNS rebinding, TLS
  downgrade, an agent talking to a wrong server, a gateway with a revoked node.

### Block E: structure and systems review

The owner wants clear structures and systems. Write `E/structure.md` as an honest
assessment, with findings only for what is **wrong**, and `E/proposals.md` for what is
**missing** (each proposal marked `[OPEN]`, with why, cost and risk; do not implement):

1. **State machines.** One diagram each for operations, plans, approvals, bundles, the
   ledger and drift baselines, extracted from code and compared with the docs. Unreachable
   states, dead ends, states with two meanings, states a UI cannot show.
2. **Vocabulary.** The same word for the same thing across CLI, REST, MCP, Web App and docs
   (bundle, migration, plan, operation, run, apply, verify, baseline, adopt, accept,
   reconcile). Every inconsistency that could make an operator do the wrong thing.
3. **Errors.** The error catalog: every code documented, with a cause, a remedy and an exit.
   Errors that name the wrong object or hide the ids.
4. **Docs against behavior.** Spot-check at least 60 `[DECIDED]` and `[OBSERVED]`
   statements in `exponetdb-docs/04-migrations/` and `12-operations/` by running them.
5. **Recoverability from the CLI alone.** For each failure state you met in block B and
   C: can a person who has only the CLI and the runbook get out? Count the steps.
6. **Proposals** (candidates, judge each on evidence): a **rehearsal apply** on a
   throwaway clone before production; a **preflight** that estimates lock risk from
   `pg_stat` and table sizes; bundle **signing and provenance**; **release sets** or
   channels that group bundles for one deploy; a compatibility matrix between bundle,
   engine and PostgreSQL versions; a bundle store **doctor** that finds dangling,
   orphaned and unreferenced bundles; a first-class **recovery command** for
   `needs_attention`; a machine-readable **plan risk report**; and whatever you found
   missing yourself.

### Block F: readiness scorecard

Last, `F/readiness.md`: one table, one row per Wave 11 precondition (a migration
applied to production is safe; verified; recoverable; auditable; reversible by
roll-forward; observable; a restore is proven with a measured number; an upgrade of
ExponetDB itself is proven; a hostile bundle is contained; secrets stay secret), with
PASS, FAIL or UNPROVEN, the evidence, and the finding ids that block it. Then a short
list: **what must be true before the owner points this at production.**

## 5. Where evidence goes

`exponetdb-docs/14-roadmap/prompts/verification-campaign-<YYYY-MM-DD>/` with folders
`R/` (fix verdicts), `A/` (suites), `B/` (bundles: `contract.md`, `conformance/`,
`ddl-hazard-matrix.md`, scenario reports and scripts), `C/` (operations), `D/`
(security, plus `hetzner-resources.md`), `E/` (structure, proposals), `F/` (readiness,
findings parts, `build.py`, order, not-run table) and a `README.md` index that says what
is deliberately not committed. Write progressively; do not keep results in your head. If
the session restarts, the folder is how you resume.

**Findings** use exactly the format of the first campaign so `F/build.py` assembles them:

```
### [P1] Short title
- **Area:** package or surface
- **Block:** R, A, B, C, D or E (the block that found it)
- **Reproduction:** exact steps and commands
- **Expected:** ...
- **Actual:** ...
- **Evidence:** relative paths
- **Root cause:** suspected, with file:line at the tested commit
- **Proposed fix:** ...
- **Acceptance test:** a test that fails before and passes after
```

Number them `VC-001` onward in severity order. Anything the owner must decide is an open
decision, not a finding.

## 6. Finish

1. Run the `secrets` check over the files you will commit, and scan them for e-mail
   addresses, real IP addresses and raw dumps.
2. Write `exponetdb-docs/14-roadmap/prompts/<date>-verification-fixes.md` (the fix
   prompt, built like `2026-10-27-test-campaign-fixes.md`: summary, per-block verdicts,
   index, findings, order of work, owner decisions, not-run table, rules for the fix
   session, which includes the git identity above).
3. Delete **every** server and key you created (verify with the Hetzner API that
   nothing labelled `purpose=exponetdb-test-campaign` remains), remove local containers
   and images, and list the ids as deleted.
4. Open one pull request with only the documents (a branch `feat/verification-campaign-<date>`
   from the latest `origin/main`, identity as above). Do not merge it.
5. Close with a short message to the owner: verdict per block, the P0 and P1 findings in
   one line each, the readiness scorecard in one paragraph, the cost (servers created and
   deleted), the pull request link, and a ready-to-paste mini prompt for the fix session
   (fetch the latest `origin/main`, own worktree, read the fix prompt, tests first, no
   merge, no redeploy). **Do not start the fix session yourself.**
