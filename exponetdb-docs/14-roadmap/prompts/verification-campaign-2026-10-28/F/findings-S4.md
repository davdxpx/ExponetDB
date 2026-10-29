### [P2] An unmet backup requirement on a production apply answers 500 INTERNAL, and nothing is logged
- **Area:** `packages/operations` (apply gate), `packages/contracts` (errors), `apps/server` (problem mapping)
- **Block:** D
- **Reproduction:** on the stack, the owner plans a rollback of a production migration that has a `down.sql` (`POST /targets/{prod}/migrations/{id}/rollback-plans`; decision `require`, requirements approval + backup + reauth), then `POST /plans/{id}/apply` (CLI bearer, `exponetdb plan apply --yes`, or a fresh-proof web session). Same result each time.
- **Expected:** 409 `BACKUP_REQUIRED` naming `newerThan`; any 500 logged with its request id.
- **Actual:** 500 INTERNAL; the request id appears in no journal (serve and worker at info); the CLI prints "Error INTERNAL". The backup gate also hides the reauth requirement behind it.
- **Evidence:** `D/security/authz-run.md` (step-up section); `D/security/scripts/stepup-setup-plans.sh`, `stepup.sh`. **Same on a rehearsal stack (S5):** a destructive production plan (`DROP TABLE`) whose requirement is a verified backup newer than PT24H, applied twice, ended `Error INTERNAL` both times with no operation row and no line in the serve journal for the request id (`B/rehearsal/results/promote-destructive-plan.txt`).
- **Root cause:** suspected, read not instrumented: `packages/operations/src/accept.ts:209-210` throws `new OperationError('BACKUP_REQUIRED')` without details while `packages/contracts/src/errors.ts:701-710` requires `details.newerThan`; `apps/server/src/interfaces/http/request.ts:196-211` retries `buildProblem` without details, fails again and replaces the code with INTERNAL without logging.
- **Proposed fix:** pass `newerThan` into the error; log (warn) whenever `problemResponse` downgrades a catalog code to INTERNAL.
- **Acceptance test:** an operations test: an unmet backup requirement gives `BACKUP_REQUIRED` with `details.newerThan`; a server test: details that do not match the catalog are logged and not turned into INTERNAL.

### [P2] The first-party CLI fails with PERMISSION_DENIED for everyone whose role binding is on an environment
- **Area:** `apps/cli` (`src/cli/remote.ts`), `installation.get` authorization
- **Block:** D
- **Reproduction:** invite a person, bind `developer` to one environment, sign the CLI in (consent 200), run `whoami`, `target list`, `target show`, `schema overview`, `migration status`, `plan list`, `health`, `operation list` (table and `--json`); `curl` with the same bearer returns the target.
- **Expected:** a developer scoped to one environment can use the CLI there.
- **Actual:** every command (also `plan show`, `plan apply`, `migration plan`) exits `Error PERMISSION_DENIED`. A global viewer and the owner work.
- **Evidence:** `D/security/authz-run.md` (last section).
- **Root cause:** `apps/cli/src/cli/remote.ts:198` calls `sdk.installation.get()` before every remote command; `installation.get` needs a global binding (D1's matrix marks it D for an environment binding).
- **Proposed fix:** make the pre-flight optional or use a read the person always holds; or let any bound person read the installation.
- **Acceptance test:** a CLI test with a server whose `GET /installation` is 403 and target routes 200: `target list` exits 0.

### [P2] A sub-megabyte bundle can hold the server's CPU for 30 s or raise its memory by 620 MiB; the limits are not named
- **Area:** planning path (`packages/migrations-engine` analysis, `packages/postgres` parser), plan route
- **Block:** D
- **Reproduction:** `exponetdb migration plan --target <nonprod>` with `up.sql` of (a) 60,000 lines `SELECT n;` (829 KB) or (b) 50,000 `/*` then 50,000 `*/` then `SELECT 1;` (200 KB); sample serve and worker with `ps` at 50 ms (`D/security/scripts/containment2.sh`).
- **Expected:** a named limit error within about a second (I15), bounded CPU and memory.
- **Actual:** (a) INTERNAL after 4.7 s, 5 s CPU, serve RSS 256 to 878 MiB (still 660 to 705 MiB later); (b) 30.5 s CPU, then TRANSPORT_FAILED, no answer. Reachable by a developer, a service account or an MCP client with `migrations.plan`. Case (b) is `F/findings-B2.md` first P1 on a stack; case (a) is a second shape of its second P1 (the many-statements input).
- **Evidence:** `D/security/containment.md`.
- **Root cause:** unknown from outside; candidates are the statement splitter and analysis in `packages/migrations-engine/src/analysis.ts` and the parser wrapper in `packages/postgres/src/parser/`.
- **Proposed fix:** cap statements, comment depth and tokens before analysis with named `MIGRATION_LIMIT_*` errors; time-box the analysis; document the values.
- **Acceptance test:** one unit test per input class: a named limit error, under 2 s and 100 MiB.

### [P3] Session cancel and terminate without an operator credential answer "credential needs rotation or repair"
- **Area:** `packages/diagnostics/src/connections.ts` (lines 225-228, 493-496)
- **Block:** D
- **Reproduction:** the stack has no `exponetdb_operator` credential; the owner POSTs `/targets/{id}/sessions/{pid}/cancel` or `/terminate` with a valid body.
- **Expected:** a code that says no operator credential is registered.
- **Actual:** 503 `TARGET_CREDENTIAL_INVALID` "needs rotation or repair"; this also hides the authorization decision of the allowed classes on the lab.
- **Evidence:** `D/security/authz-run.md` (residue list).
- **Root cause:** a missing credential is mapped to `TARGET_CREDENTIAL_INVALID` in both places.
- **Proposed fix:** a distinct code and message; register an operator credential in the lab bootstrap.
- **Acceptance test:** cancel on a cluster without the credential returns the new code.

### [P3] Lint allows server-file functions and untrusted-language functions; only database privileges stop them
- **Area:** `packages/migrations-engine` lint (`forbidden_statement`)
- **Block:** D
- **Reproduction:** `D/security/scripts/containment.sh` cases 03, 04 and 18: the plan decision is `allow` (warnings only); the apply ends `MIGRATION_EXECUTION_FAILED`, `not_applied` (the migrator lacks `pg_read_server_files`, superuser and the language). The other 15 host-reaching cases are `forbidden_statement` at plan time and audited.
- **Expected:** refused at plan time with a clear, audited reason; the failed operation shows the database reason class.
- **Actual:** contained only by the role's privileges; the operation view carries the code only. For a Supabase-origin schema whose migrator role is more privileged, the same bundle would run.
- **Evidence:** `D/security/containment.md`.
- **Root cause:** the forbidden list is by statement kind, not by called function or language.
- **Proposed fix:** forbid `pg_read_file`, `pg_read_binary_file`, `pg_ls_dir`, `pg_stat_file`, `lo_import`, `lo_export` and untrusted languages in lint.
- **Acceptance test:** a lint test per name.
