# CLI sweep, text and JSON (Block C, tester S7)

Tree `d51da5d0`, disposable stack on `vc-3`. The CLI of the commit under test, run as the first owner (all scopes), as the read-only
`viewer` and as people without a usable grant, against real targets. Scripts: `scripts/s7-cli-sweep.sh`, `s7-cli-sweep2.sh`, `s7-cli-sweep3.sh`
(driver), `s7-sweep-render.py` (table). Raw outputs stay on the server. Each case ran once in text mode and once with `--json` (a state-changing
call ran in one mode only, the other mode read the same thing).

## Numbers

| Question | Answer |
|---|---|
| Cases (command x situation) | **92**: 33 successful calls (some are refusals that are the right answer, e.g. `ref-watch-final`), 18 missing or invalid arguments, 23 refusals with a reason, 10 unauthorized or signed-out, 8 unreachable (server, target, node) |
| Calls with a non-zero exit in some mode | 51 (JSON mode: 48 failing calls) |
| Exit code differs between text and JSON of the same call | 1 (`backup refresh` with the node just stopped: I killed the text run after minutes, the JSON run a minute later got `NODE_OFFLINE`; a timing effect, see finding 4 in 3.x) |
| Failing calls whose JSON error has a `message` | 48 of 48 |
| ... whose JSON error has a `remediation` | 20 of 48 |
| ... whose JSON error carries an object id (in `message` or `details`) | 5 of 48 (`MIGRATION_CHECKSUM_MISMATCH`, `MIGRATION_ROLLBACK_BLOCKED`, `MIGRATION_DEPENDENCY_UNKNOWN`, the `finding` not-found, the production-confirmation usage error). `PLAN_NOT_FOUND`, `OPERATION_NOT_FOUND`, `TARGET_UNAVAILABLE`, `NODE_OFFLINE`, `PLAN_ALREADY_USED`, `PLAN_DENIED`, `OPERATION_NOT_RETRYABLE` carry no id; the request id is in the text output only |
| ... whose JSON has a `next` array | 16 of 48 (almost only `usage` errors) |
| Failing calls whose **text** names a next step | 29 of 50 (a `Did you mean`, a remedy line, `Run: exponetdb login`, or the plan view with its rules) |
| Successful calls with a `next` array in JSON | 13 of 41 |

## 1. Exit codes: what the table says (documented: 0 ok, 1 failure, 2 usage, 3 sign-in or scope, 4 blocked by policy or approval, 5 server unavailable, 6 outcome unresolved or timeout)

Several of my own expectations in the table were wrong or came from a fixture; they are listed as such, so that nobody reads a bold exit code as a defect.

| Case | Exit | Verdict |
|---|---|---|
| `ref-dependency` | 0 | my fixture: the first bundle of a project has `dependsOn: []`, my edit did not apply; redone as `ref2-dependency-unknown`: exit 1 `MIGRATION_DEPENDENCY_UNKNOWN`, names the missing id |
| `ref-lint-plan`, `ref-prod-confirm`, `ref2-prod-no-confirm` | 4 | correct: the plan was denied by policy (lint block; no evidence) before any apply; `PLAN_DENIED` exit 4 |
| `ref3-prod-no-confirm` | 2 | correct and **good**: `plan apply` of a production plan without `--yes` in no-input mode: `usage`, remedy "Did you mean: exponetdb plan apply <plan> --yes", plan id, `next` |
| `auth-viewer-drift`, `auth-viewer-approve` | 0 | the viewer's scopes (`schema.read`, `diagnostics.read`, `migrations.read`) cover a drift check and the approval list; nothing wrong. (A drift check is labelled `Effect: plan` in `--help` and it stores a result, but it needs only `schema.read`.) |
| `auth-signed-out` | 2 | an empty config directory has no profile: `usage` "Name the server with --server ..."; with the server named (`auth2-no-credentials`): exit **3** `UNAUTHENTICATED` "Not signed in ... Run: exponetdb login" |
| `ok2-drill-plan`, `ref3-backup-verify` | 2 | my wrong flags (`--kind`, `--repository`): `Unknown flag`, exit 2, as designed |
| `ref2-approve-no-browser` | 0 | `approval approve` prints the page URL and the code and exits 0 (it waits for the decision only when it can) |
| `ref2-retry-verify-attention` | 6 | correct: `operation retry-verification` on an operation whose verification errors again: `VERIFICATION_ERROR` exit 6 |
| `ref-reconcile-ok` | 2 | `migration ledger reconcile` on a consistent target: `VALIDATION_FAILED` (server 422) exit 2 with a remedy; a clearer code would be "nothing to reconcile" |
| **`net-target-down`, `net-target-drift`** | **1** | **`TARGET_UNAVAILABLE` (target port rejected) is exit 1, not 5.** Exit 5 means the ExponetDB server is unavailable. A script cannot tell a dead target from any other failure without parsing the JSON `code` |
| **`ref3-backup-run`** | **1** | `FEATURE_NOT_ACTIVATED` ("This installation has not activated the action for this tier") is exit 1; it is a refusal by installation policy and sits next to `PLAN_DENIED` (4) |
| `net-node-stopped` | 6 | `node inspect` with the agent stopped: the operation stays `queued`, the CLI ends after `--timeout-wait` with `WATCH_TIMEOUT` (a CLI-local code) exit 6, "outcome unresolved": right |

## 2. Errors with no remedy (JSON `remediation` absent), real ones

`PLAN_DENIED` (rules are in the plan, not in the error), `PLAN_ALREADY_USED`, `PLAN_STALE` on the second refusal (see 3.1), `OPERATION_NOT_RETRYABLE`,
`OPERATION_NOT_CANCELABLE`, `MIGRATION_LINT_BLOCKED`, `MIGRATION_ALREADY_APPLIED`, `TARGET_UNAVAILABLE`, `TARGET_TLS_FAILED` (network-review §4), `NODE_OFFLINE`,
`NODE_REVOKED` (network-review §5), `NOT_FOUND` of a finding, `TRANSPORT_FAILED`, `WATCH_TIMEOUT`, `VERIFICATION_ERROR`. With a remedy: `MIGRATION_CHECKSUM_MISMATCH`
("Restore the original bundle and add a new migration for the change."), `MIGRATION_ROLLBACK_BLOCKED`, `VALIDATION_FAILED`, `PERMISSION_DENIED` ("Ask an administrator for
a role with this permission at this scope."), `*_NOT_FOUND`, `FEATURE_NOT_ACTIVATED`, `UNAUTHENTICATED`.

## 3. What E1 predicted and what the sweep shows (`E/errors.md`)

| E1 prediction | Concrete cases | Result |
|---|---|---|
| ER-6: the human renderer prints only `remediation` and a few named `details` keys; the rest is JSON only | `ref-plan-stale` text: "The plan no longer matches the target. Create a new plan." (the JSON of the first refusal carries `changedBindings`); `ref-checksum` text prints the migration id and the remedy, the known checksum and the target that holds it are JSON only; `ref-retry-verify` prints no state although `details.state` is `succeeded`; `net-target-drift` prints no cause | **CONFIRMED** (4 cases) |
| ER-6, second half: a synchronous `POLICY_DENIED` hides the rules | `ref-policy-prod`, `ref-lint-plan`: the **plan view** is printed with decision and failed rules, exit 4 | **REFUTED for the plan step** (the rules are visible); the JSON error `PLAN_DENIED` itself has no rules and no remedy |
| ER-2: no remedy for operational codes | `TARGET_UNAVAILABLE` x2, `NODE_OFFLINE`, `NODE_REVOKED`, `PLAN_ALREADY_USED`, `OPERATION_NOT_RETRYABLE`, `OPERATION_NOT_CANCELABLE`, `MIGRATION_ALREADY_APPLIED` | **CONFIRMED** (9 cases) |
| 96 of 129 codes fall through to exit 1 | `TARGET_UNAVAILABLE`, `NODE_OFFLINE`, `FEATURE_NOT_ACTIVATED`, every `MIGRATION_*`, `PLAN_ALREADY_USED`, `PLAN_STALE`, `OPERATION_*`, `*_NOT_FOUND` end with 1; mapped: `PLAN_DENIED` 4, `PERMISSION_DENIED`/`UNAUTHENTICATED` 3, `usage`/`VALIDATION_FAILED` 2, `TRANSPORT_FAILED` 5, `WATCH_TIMEOUT`/`VERIFICATION_ERROR` 6 | **CONFIRMED** (12 cases); the operational consequence is the first row of table 1 |
| ER-4: CLI-local codes outside the catalog | `WATCH_TIMEOUT` (`net-node-stopped`), `TRANSPORT_FAILED` (`net-server-down`), lower-case `usage` (14 cases) | **CONFIRMED**, and two more than E1 named (`TRANSPORT_FAILED`, `usage`) |
| ER-1: codes that are never produced | not exercised (needs the specific conditions) | NOT RUN |
| ER-3: `operation_state_changed`/`operation_kind_unknown` escape as 500 `INTERNAL` | not exercised (a race, and a plan of another engine version) | NOT RUN |

## 3.x Findings the sweep adds (all P3; item 6 is lab tooling, not the product; the exit-code finding is the first row of table 1)

1. **A second refusal of a stale plan loses the cause.** `plan apply` of a stale plan: the first call says `PLAN_STALE` "The plan no longer matches the target. Create a new plan." with
   `changedBindings` (JSON); the plan is then invalidated, and the next call (text or JSON, CLI or Web App) says `PLAN_STALE` "The plan is invalidated; it cannot be applied. Plan again.",
   no remedy, no binding, no plan id. (`ref-plan-stale` text vs JSON.)
2. **`operation cancel` by a person who did not start the operation names the wrong object.** `PLAN_BINDING_ACTOR` "Only the identity and client that created the plan may use it." for
   `operation cancel op_...` (case `ref2-cancel-awaiting`, the operation belongs to another client). The error is about a plan; the caller asked about an operation.
3. **`--evidence-from` takes the environment slug while the positional argument of the same command takes an id.** `environment update <product> <env-id> --evidence-from <slug>`; the
   contract error cites a regular expression (`must match pattern /^[a-z][a-z0-9-]{0,38}$/`) instead of saying "slug".
4. **A queued node operation waits silently.** `backup refresh` a few seconds after the agent stopped: operation `queued`, the CLI prints `queued · apply not_started · verify pending`
   and waits for the default 15 minutes (`--timeout-wait`); a minute later the same command returns `NODE_OFFLINE` at once. The first call should have told that the node's
   heartbeat is overdue.
5. **`environment update --apply` on a `high` class waits for a browser confirmation without saying how to give it in the CLI** (it does print the step-up URL and code; with `--no-input`
   nobody can confirm, so the call blocks until the timeout). The same applies to every registry action of class `high`.
6. **Lab tooling bug (not the product):** `human.ts stepup <id> <code>` posts `{code}` and the contract needs `{userCode}`; `D/infra/README.md` documents the former. Use `human call POST /api/v1/step-ups/<id>/confirm '{"userCode":"..."}'`.

## 4. Verdict

PASS with findings: every command group answered with a documented exit code in the cases that are the product's responsibility; the findings are about information that is lost between the
server and the operator (causes, ids, remedies), not about wrong outcomes. 92 cases, no P0, P1 or P2; 5 P3 findings (the exit code of a dead target, the stale-plan cause, the wrong object of `operation cancel`, the silent 15-minute wait, the slug-versus-id flag) and 1 lab-tooling note.

## 5. The table

Columns: expected exit = my expectation from `--help` (see table 1 for the wrong ones); "Text names a next step" = a remedy, `Did you mean`, `Run: ...`, or a plan view
after the first line; `ids` = an object id in the JSON error (`message`, `details`); `next` = the JSON `next` array.

| Case | Command | Who | Expected exit | Text exit | JSON exit | Text names a next step | JSON code | message | remedy | ids | `next` |
|---|---|---|---|---|---|---|---|---|---|---|---|
| ok-status | `migration status --target lab/platform/s7sweep` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-lint | `migration lint` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-checksum | `migration checksum` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-graph | `migration graph` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-plan | `migration plan --target lab/platform/s7sweep <id>` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-apply-text | `migration apply --target lab/platform/s7sweep <id>` | owner | 0 | 0 | - | n/a | ? | - | n/a | n/a | - |
| ok-apply-json | `migration apply --target lab/platform/s7sweep <id>` | owner | 0 | - | 0 | - | ok | - | n/a | n/a | - |
| ok-plan-list | `plan list --limit 3` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-plan-show | `plan show pln_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-op-list | `operation list --limit 3` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-op-show | `operation show op_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-approval-list | `approval list` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-drift-check | `drift check lab/platform/s7sweep` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-finding-list | `finding list` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-finding-sum | `finding summary` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-health | `health lab/platform/s7sweep` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-backup-over | `backup overview` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-backup-list | `backup list cls_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-backup-repos | `backup repositories cls_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-backup-runs | `backup runs cls_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-backup-policy | `backup policy show cls_…` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ok-restore-list | `restore list cls_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-drill-list | `drill list cls_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-node-list | `node list` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-node-show | `node show nod_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-node-status | `node status nod_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-node-caps | `node capabilities nod_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ok-node-inspect | `node inspect nod_… --capability cpu.stats@1 --timeout-wait 60s` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| arg-plan-no-target | `migration plan` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| arg-plan-bad-target | `migration plan --target lab/platform/nope <id>` | owner | 1 | 1 | 1 | yes | TARGET_NOT_FOUND | y | y | - | - |
| arg-plan-bad-id | `migration plan --target lab/platform/s7sweep not-an-id` | owner | 2 | 2 | 2 | no | usage | y | - | - | y |
| arg-apply-no-plan | `plan apply` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| arg-apply-bad-plan | `plan apply pln_… --yes` | owner | 1 | 1 | 1 | yes | PLAN_NOT_FOUND | y | y | - | - |
| arg-show-no-id | `plan show` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| arg-show-bogus | `plan show pln_…` | owner | 1 | 1 | 1 | yes | PLAN_NOT_FOUND | y | y | - | - |
| arg-op-bogus | `operation show op_…` | owner | 1 | 1 | 1 | yes | OPERATION_NOT_FOUND | y | y | - | - |
| arg-approval-bogus | `approval show op_…` | owner | 1 | 1 | 1 | yes | OPERATION_NOT_FOUND | y | y | - | - |
| arg-node-no-id | `node show` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| arg-node-bogus | `node show nod_…` | owner | 1 | 1 | 1 | yes | NOT_FOUND | y | y | - | - |
| arg-backup-no-cluster | `backup list` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| arg-backup-bogus | `backup list cls_…` | owner | 1 | 1 | 1 | yes | NOT_FOUND | y | y | - | - |
| arg-finding-bogus | `finding show fnd_… --target lab/platform/s7sweep` | owner | 1 | 1 | 1 | no | NOT_FOUND | y | - | y | - |
| arg-drift-bad-target | `drift check lab/platform/nope` | owner | 1 | 1 | 1 | yes | TARGET_NOT_FOUND | y | y | - | - |
| arg-bad-output | `migration status --target lab/platform/s7sweep --output xml` | owner | 2 | 2 | - | yes | ? | - | - | - | - |
| arg-unknown-cmd | `migration frobnicate` | owner | 2 | 2 | - | yes | ? | - | - | - | - |
| arg-unknown-flag | `migration status --target lab/platform/s7sweep --frobnicate` | owner | 2 | 2 | 2 | yes | usage | y | - | - | y |
| ref-checksum | `migration plan --target lab/platform/s7sweep <id>` | owner | 1 | 1 | 1 | no | MIGRATION_CHECKSUM_MISMATCH | y | y | y | - |
| ref-dependency | `migration plan --target lab/platform/s7sweep` | owner | 1 | **0** | **0** | yes | ok | - | n/a | n/a | y |
| ref-lint-block | `migration lint` | owner | 1 | 1 | 1 | no | MIGRATION_LINT_BLOCKED | y | - | - | - |
| ref-lint-plan | `migration plan --target lab/platform/s7sweep` | owner | 1 | **4** | **4** | no | PLAN_DENIED | y | - | - | - |
| ref-policy-prod | `migration plan --target lab/platform/s7prd <id>` | owner | 4 | 4 | 4 | no | PLAN_DENIED | y | - | - | - |
| ref-plan-used | `plan apply pln_… --yes` | owner | 1 | 1 | 1 | yes | PLAN_ALREADY_USED | y | - | - | y |
| ref-plan-stale | `plan apply pln_… --yes` | owner | 1 | 1 | 1 | yes | PLAN_STALE | y | - | - | - |
| ref-prod-confirm | `plan apply pln_…` | owner | 2 | **4** | **4** | no | PLAN_DENIED | y | - | - | - |
| ref-retry-verify | `operation retry-verification op_…` | owner | 1 | 1 | 1 | no | OPERATION_NOT_RETRYABLE | y | - | - | - |
| ref-cancel-final | `operation cancel op_…` | owner | 1 | 1 | 1 | no | OPERATION_NOT_CANCELABLE | y | - | - | - |
| ref-watch-final | `operation watch op_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ref-rollback-nodown | `migration rollback <id> --target lab/platform/s7sweep` | owner | 1 | 1 | 1 | no | MIGRATION_ROLLBACK_BLOCKED | y | y | y | - |
| ref-resume-notstopped | `migration resume <id> --target lab/platform/s7sweep` | owner | 1 | 1 | 1 | no | MIGRATION_ALREADY_APPLIED | y | - | - | - |
| ref-reconcile-ok | `migration ledger reconcile --target lab/platform/s7sweep --note sweep:` | owner | 0 | **2** | **2** | no | VALIDATION_FAILED | y | y | - | - |
| auth-viewer-apply | `migration apply --target lab/platform/s7sweep <id>` | viewer | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| auth-viewer-drift | `drift check lab/platform/s7sweep` | viewer | 3 | **0** | **0** | n/a | ok | - | n/a | n/a | - |
| auth-viewer-backup-run | `backup run cls_… --repository bkr_… --kind full` | viewer | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| auth-viewer-node-revoke | `node revoke nod_…` | viewer | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| auth-viewer-prod-plan | `migration plan --target lab/platform/s7prd <id>` | viewer | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| auth-viewer-approve | `approval list` | viewer | 3 | **0** | **0** | n/a | ok | - | n/a | n/a | - |
| auth-viewer-audit | `audit list --limit 2` | viewer | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| auth-signed-out | `migration status --target lab/platform/s7sweep` | signed-out | 3 | **2** | **2** | yes | usage | y | y | - | y |
| auth-dev-revoked | `migration status --target lab/platform/s7sweep` | developer-nonprod | 3 | 3 | 3 | yes | PERMISSION_DENIED | y | y | - | - |
| net-server-down | `migration status --target lab/platform/s7sweep --server http://127.0.0` | owner | 5 | 5 | 5 | yes | TRANSPORT_FAILED | y | - | - | y |
| net-target-down | `migration status --target lab/platform/s7sweep` | owner | 5 | **1** | **1** | yes | TARGET_UNAVAILABLE | y | - | - | - |
| net-target-drift | `drift check lab/platform/s7sweep` | owner | 5 | **1** | **1** | no | TARGET_UNAVAILABLE | y | - | - | - |
| net-target-health | `health lab/platform/s7sweep` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| net-node-stopped | `node inspect nod_… --capability cpu.stats@1 --timeout-wait 20s` | owner | 5 | **6** | **6** | yes | WATCH_TIMEOUT | y | - | - | y |
| net-backup-refresh-nodedown | `backup refresh cls_…` | owner | 1 | **143** | 1 | no | NODE_OFFLINE | y | - | - | - |
| net-node-status-down | `node status nod_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| net-node-restored | `node status nod_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ref2-dependency-unknown | `migration plan --target lab/platform/s7sweep` | owner | 1 | 1 | 1 | no | MIGRATION_DEPENDENCY_UNKNOWN | y | - | y | - |
| ref2-prod-no-confirm | `plan apply pln_…` | owner | 2 | **4** | **4** | no | PLAN_DENIED | y | - | - | - |
| auth2-no-credentials | `migration status --target lab/platform/s7sweep --server http://localho` | no-credentials | 3 | 3 | 3 | yes | UNAUTHENTICATED | y | - | - | y |
| ok2-approval-show | `approval show op_…` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ref2-approve-no-browser | `approval approve op_…` | owner | 4 | **0** | **0** | yes | - | - | n/a | n/a | y |
| ref2-cancel-awaiting | `operation cancel op_…` | owner | 0 | **1** | - | no | ? | - | - | - | - |
| ok2-op-attention | `operation show op_…` | owner | 0 | 0 | 0 | yes | ok | - | n/a | n/a | y |
| ref2-retry-verify-attention | `operation retry-verification op_…` | owner | 0 | - | **6** | - | VERIFICATION_ERROR | y | - | - | y |
| ok2-node-revoke-plan | `node revoke nod_… --no-wait` | owner | 0 | 0 | 0 | yes | - | - | n/a | n/a | y |
| ok2-drill-plan | `drill plan cls_… --kind latest` | owner | 1 | **2** | **2** | yes | usage | y | - | - | y |
| ok2-finding-show | `finding show fnd_… --target tgt_…` | owner | 0 | 0 | 0 | n/a | ok | - | n/a | n/a | - |
| ref3-backup-run | `backup run cls_… --repository bkr_… --kind full --no-wait` | owner | 4 | **1** | **1** | no | FEATURE_NOT_ACTIVATED | y | y | - | - |
| ref3-backup-verify | `backup verify cls_… --repository bkr_… --backup 20200101-000000F --no-` | owner | 1 | **2** | **2** | yes | usage | y | - | - | y |
| ref3-backup-refresh | `backup refresh cls_… --no-wait` | owner | 0 | 0 | 0 | yes | - | - | n/a | n/a | y |
| ref3-prod-no-confirm | `plan apply pln_…` | owner | 2 | 2 | 2 | yes | usage | y | y | y | y |
