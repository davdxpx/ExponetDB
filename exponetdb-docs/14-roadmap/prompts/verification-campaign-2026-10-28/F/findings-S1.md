### [P1] A clock step leaves the audit chain refusing every event: every audited mutation fails with INTERNAL, readiness stays ready, and there is no repair
- **Area:** Control Store `audit.chain_guard`, `apps/server` (login, plan, apply), readiness
- **Block:** B
- **Reproduction:** on the stack (`D/infra`), `source stack-env.sh; clock_jump 10800` while an apply runs (`B/failure/F-matrix.sh cell tx mid clock_fwd3h`), then `clock_restore`. Then `exdb migration plan --target lab/platform/staging` or the owner login. On a single host (as `reos-01` runs it, Control Store container and roles on one kernel clock) the step moves the database clock too, so the events written during the skew are accepted.
- **Expected:** fail closed with a named cause and a repair path; readiness not ready; a skew guard.
- **Actual:** the audit table received events up to 22:46:19 while the real time was 19:52. The Control Store raises `audit chain: the event time does not continue the chain` (`packages/control-store/migrations/01M46KJ06G9BHM1ZR7CDD2JZ2S_audit-chain/up.sql:76-77`: `NEW.occurred_at < head_at OR NEW.occurred_at > clock_timestamp() + interval '1 minute'`, checked by the lead). Login returns HTTP 500 `audit_append_failed`. The CLI prints only `Error INTERNAL: An unexpected error occurred` plus a request id. Serve and worker readiness are `ready` with `checks: []` (the lead found no audit check in `role.ts`). Reads still work. The block lasts as long as the skew (2 h 54 min here). The only way out on the stack was stack-down and stack-up (a fresh Control Store); no document or tool offers a repair of a live chain. A serve-only clock step forward is refused by the same guard (more than a minute ahead of the database clock) with the same opaque 500.
- **Evidence:** `B/failure/RESULTS.md` (not-run section and matrix); logs `fresh-target.log` and the serve journal on vc-3 (index in `B/failure/README.md`).
- **Root cause:** `audit.chain_guard` enforces monotonic event time against the chain head and the database clock; nothing detects or limits future-dated events when the clock is wrong, and `AuditWriteError` has no catalog code (see `F/findings-C1.md`, the audit-gate finding).
- **Proposed fix:** a readiness check on audit append; a typed error naming the chain (for example `AUDIT_CLOCK_SKEW`); a skew guard (refuse or clamp future events with a skew marker, ideally against a monotonic source); a documented, audited repair operation for a head that is ahead of real time.
- **Acceptance test:** step the clock +3 h, perform an audited action, step back: the next audited action succeeds, or fails with a typed `AUDIT_CLOCK_SKEW` while readiness is degraded and a repair operation exists.

### [P2] An approval 15 minutes after the plan expired was accepted and the production change ran; awaiting_approval never ends (stack reproduction of TC-034 / OD-64 and of the B1 approval-window finding)
- **Area:** `packages/operations` accept and approvals, CLI `approval`
- **Block:** B
- **Reproduction:** `B/failure/I9-approval.sh create`, wait 16 minutes, `I9-approval.sh inspect`.
- **Expected:** a typed refusal and an expired or canceled operation.
- **Actual:** after the plan's expiry the operation was still `awaiting_approval` (nextAction approve). `approval show` printed an Expires time in the past and no warning. `human approve` returned 200, the operation went `queued`, then `succeeded applied/passed` on the production target. The 4 h approval window itself could not be tested (the Control Store refuses to age an operation row).
- **Evidence:** `B/failure/RESULTS.md` section 2. Static side (agent B1, `B/contract.md` §3 DF-01): nothing expires an `awaiting_approval` operation (`worker-tasks.ts:186-314` has `plans.expire` only); after 20 pending operations of one actor and client the next accept is `APPROVALS_PENDING_LIMIT` (`accept.ts:129-148`), so an agent client that left 20 plans unattended is locked out until a human rejects each; the exits are a human reject or the applying actor and client cancelling (`approvals.ts:562`, `application.ts:1960-2000`).
- **Root cause:** documented but unbuilt; OD-64 is open.
- **Proposed fix:** decide OD-64; at minimum refuse an approval after the plan's expiry and cancel the operation.
- **Acceptance test:** `I9-approval.sh inspect` prints PASS.

### [P2] A lost COMMIT reply plus a target restart parks the operation as unknown with the change committed; it is never reconciled, and the only exit mislabels it
- **Area:** `packages/migrations-engine` (`kind.ts` reconcile, `reverify.ts`)
- **Block:** B
- **Reproduction:** `B/failure/I9-exits.sh unknown`, or `F-matrix.sh cell tx incommit pg_immediate`: a missing synchronous standby makes the COMMIT durable but unanswered, then the cluster is restarted.
- **Expected:** `failure-and-recovery.md` E3 and E6: automatic reconciliation (a ledger row present means applied).
- **Actual:** `needs_attention apply=unknown OUTCOME_UNKNOWN` in under 1 s, with ledger 1 and both tables present. It is not reconciled after the target returns and it holds the schema domain, so the next plan queues. `migration verify <id>` closes it as `verification_failed apply=partially_applied` for a fully committed transactional migration. Killing the worker or terminating the session in the same window reconciles correctly.
- **Evidence:** `B/failure/RESULTS.md`, matrix row `tx:incommit:pg_immediate`.
- **Root cause:** a single reconcile attempt against an unreachable target; the supersede close writes a generic outcome.
- **Proposed fix:** retry the reconcile on a timer; close as succeeded once the ledger shows applied and verification passed.
- **Acceptance test:** after the restart the operation reaches `succeeded` without a human.

### [P3] Forbidden-statement refusals have one generic remediation and mislabel RESET ROLE
- **Area:** `packages/migrations/src/lint` (forbidden statements), CLI output
- **Block:** B
- **Reproduction:** `B/failure/I4-atomicity-stack.sh`: plan bundles with `COMMIT`, `SAVEPOINT`, `SET LOCAL` and `RESET ROLE`.
- **Expected:** a remediation that fits the statement.
- **Actual:** one remediation ("cluster-level changes are node operations") for COMMIT, SAVEPOINT and SET LOCAL; `RESET ROLE` is reported as `SET ROLE`. The refusals themselves are correct (38 of 47 cases refused at lint and denied at plan).
- **Evidence:** `B/failure/RESULTS.md` section 1.
- **Root cause:** one rule id with one text.
- **Proposed fix:** per-statement remediation text and the right statement name.
- **Acceptance test:** a lint test per forbidden statement asserting its own remediation.

### [P3] Local `migration lint` and the server plan disagree, and a resume without --cleanup is denied with a generic rule
- **Area:** `apps/cli` (`migration lint`, `migration resume`), policy `migration.lint-errors`
- **Block:** B
- **Reproduction:** local `migration lint` on a bundle with `table_without_grant` (strict profile) exits 1; the server plans and applies it. `migration resume` without `--cleanup` after a stopped `CREATE INDEX CONCURRENTLY` is denied.
- **Expected:** one verdict for one bundle; a denial that names the missing flag.
- **Actual:** the CLI blocks on a `warn` that the server accepts; the resume denial is the generic `migration.lint-errors` with no hint; with `--cleanup` it works.
- **Evidence:** `B/failure/RESULTS.md` section 2.
- **Root cause:** different profiles and no hint in the denial.
- **Proposed fix:** align the CLI default with the server profile or print the profile; add a hint to the resume denial.
- **Acceptance test:** a CLI test that the same bundle gets the same blocking result locally and on the server; the resume denial names `--cleanup`.

### [P3] A verification with zero runtime checks passes, and finished operations keep a stale error code
- **Area:** `packages/migrations-engine` (verification), operations
- **Block:** B
- **Reproduction:** a bundle with `runtimeChecks: none` (I6); a worker kill, terminated session or Control Store restart inside the commit window (`F-matrix.sh`).
- **Expected:** a verification with nothing to verify says so; a finished operation carries no error code.
- **Actual:** `verify=passed` with zero runtime checks (reads as verified); operations that ended `succeeded` or `failed/not_applied` still carry `errorCode: OUTCOME_UNKNOWN`.
- **Evidence:** `B/failure/RESULTS.md` (I6 and the matrix).
- **Root cause:** the pass rule counts failures only; the error code is not cleared on reconcile.
- **Proposed fix:** report `verified (no runtime checks)` distinctly; clear the code on a final state.
- **Acceptance test:** a test that an operation with zero checks reads `unchecked`, and that a reconciled operation has no `errorCode`.

### [P3] A comment-only out-of-band change is not seen by the drift check
- **Area:** `packages/postgres` fingerprint `fp1`, drift
- **Block:** B
- **Reproduction:** `B/failure/I7-no-silent-adoption.sh`: `COMMENT ON TABLE ... IS '...'` on a target between two applies, then read the drift baseline.
- **Expected:** a change to the schema's observable state is either drift or documented as outside the fingerprint.
- **Actual:** not detected (the other nine change classes of I7 are detected and not adopted). Object comments are also the channel through which untrusted text reaches an agent, so an unseen comment change is invisible to the very check that would show it.
- **Evidence:** `B/failure/RESULTS.md` (I7 table).
- **Root cause:** `fp1` (frozen) does not cover comments.
- **Proposed fix:** document it in `drift-detection.md`; a `fp2` through an ADR if comments should count.
- **Acceptance test:** a docs test listing the object classes outside the fingerprint.
