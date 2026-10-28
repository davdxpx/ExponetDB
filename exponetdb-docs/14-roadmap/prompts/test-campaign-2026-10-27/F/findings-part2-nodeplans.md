### [P1] `plan show` returns no change content for the seven `postgres.*` node plan kinds
- **Area:** application plan view (`packages/application/src/views.ts`), CLI `plan show`, REST `GET /plans/{id}`, Web plan page
- **Block:** C (node-plans D1)
- **Reproduction:** `exponetdb node postgres reload nod_01M5XZ84V768SYCHZKRNGJFQP2 --cluster cls_01M5J4RDBP52B715X5HDFKDN5F --no-wait --output json`, then `exponetdb plan show <pln> --output json`. Same for `restart`, `hba` (harmless and reject-all variants) and `extensions`. A `node.inspect` plan and a `node.revoke` plan do return `change`.
- **Expected:** `PlanView.change` (content and analysis) for every kind a person must judge before applying (`control-plane.md` §9.3: the hba plan shows foreign rules, the managed block before and after and the protected access; the restart plan shows what it would sever).
- **Actual:** no `change` key for `postgres.reload`, `postgres.restart`, `postgres.config.apply`, `postgres.hba.apply`, `postgres.roles.apply`, `postgres.extensions.apply`, `postgres.tls.rotate`. The approver cannot see the hba diff or `protectedAccess`, the extension steps, or that a restart would sever 9 live connections of the staging app role (visible only in the basis observation). The CLI table form never renders `change` for any non-migration kind.
- **Evidence:** `C/node-plans-report.md` (D1), `C/node-plans/raw-*.txt`.
- **Root cause:** `packages/application/src/views.ts:160-176`: the allowlist has `access.`, `registry.`, `target.`, `node.`, `migration.`, `drift.`, `backup.`, `restore.` and `postgres.roles.verifier.set`, not plain `postgres.*`; the CLI table is `apps/cli/src/output/views.ts:111-162` (`planBlocks`).
- **Proposed fix:** add `postgres.` to the allowlist with a per-kind redaction (host values stay out; names, rule lines, extension steps, disruption digests in). Render `change` in the CLI table form and the Web plan page.
- **Acceptance test:** `apps/server` integration test: for each of the seven kinds the plan view has `change.content` and, for hba, the managed block diff and `protectedAccess`; a contract test pins that no secret field (verifier, key) is present; a CLI view test renders the hba diff and the restart disruption.

### [P1] `node postgres config` and `node postgres roles` cannot be planned from the CLI
- **Area:** CLI `node inspect`/`node postgres *`, node plan basis observations
- **Block:** C (node-plans D2), E3/E7-related
- **Reproduction:** `exponetdb node postgres config nod_… --cluster cls_… --set work_mem=8MB --no-wait` -> `NODE_OBSERVATION_STALE`. The basis is `postgres.config.plan@2` with args `{cluster, changes: [...]}` (`packages/nodes/src/capability-plans.ts:71-125`, `basisArgs`), and `postgres.roles.inspect@2` with `{cluster, expectSettings: []}`. `exponetdb node inspect <node> --capability postgres.config.plan@2 --cluster <cls>` -> `VALIDATION_FAILED`; `--arg 'changes=[]'` arrives as the string `"[]"` and fails the contract; `--arg 'expectSettings=[]'` likewise. Credential rotation and role-verifier flows share the roles basis.
- **Expected:** the CLI offers a way to create the basis observation, or the plan command creates it itself (inspect, then plan).
- **Actual:** dead end for roles and config plans from the CLI (the REST contract accepts arrays, `packages/contracts/src/rest/nodes.ts:63`); the remediation text ("Inspect the cluster through the node, then plan again") sends the user into it. Together with the missing `pg_stat_statements` this means the performance feature cannot be enabled from the CLI.
- **Evidence:** `C/node-plans-report.md` (D2), `C/node-inspect/_summary.txt` (`postgres.roles.inspect@2` and `postgres.config.plan@2` end `VALIDATION_FAILED`).
- **Root cause:** `apps/cli/src/commands/node.ts:342-360` (`--arg` takes string values, `Object.fromEntries(pairs(...))`), `apps/cli/src/cli/planning.ts:198-205` (`pairs`), `apps/cli/src/cli/args.ts:143-147` (comma split).
- **Proposed fix:** make `node postgres config|roles|extensions|hba|reload|restart|tls` run the matching basis inspection first when none younger than 5 minutes exists (typed args built from the command's own flags/file), and add `--arg-json k=<json>` to `node inspect` for array and object values.
- **Acceptance test:** CLI process test against the fake server and a host scenario: `node postgres config --set work_mem=8MB --no-wait` against a node without a fresh observation succeeds and the plan binds a basis observation made by the command; `node inspect --capability postgres.roles.inspect@2 --arg-json 'expectSettings=[]'` returns `succeeded`.

### [P2] A pg_hba block that rejects everything is planned and allowed; there is no plan-time protectedAccess check
- **Area:** node plan `postgres.hba.apply`
- **Block:** C (node-plans D3)
- **Reproduction:** `exponetdb node postgres hba nod_… --cluster cls_… --file hba-cut.json --no-wait` with `managedRules` = `hostssl all all <all> reject` plus `local all all reject` and `protectedAccess: []` -> plan `class high, decision allow, requirements [], approvals 0/0`, "Next: plan apply … --wait".
- **Expected:** (brief and `acceptance-gates`) a plan that would cut ExponetDB off (the agent's `exponetdb_node` socket role and the control plane's own login) is refused at plan time.
- **Actual:** the lock-out protection exists at apply time inside the agent (`control-plane.md` §9.6; host scenario `hba.host.test.ts` "refuses a block that would lock the agent out, and puts the file back" passes); at plan time nothing simulates the rules against the derived access, and `protectedAccess: []` is accepted.
- **Evidence:** `C/node-plans-report.md` (D3); `D/ci-replica` host scenario `host-hba rc=0`.
- **Root cause:** `packages/nodes/src/capability-plans.ts:723-733` merges requested and derived protected access but never matches rules against it; the analysis (`:520-528`) records counts only.
- **Proposed fix:** evaluate the managed rules first-match against the derived access (`ownNetworkAccess`, `:618-655`) and refuse with a typed `HBA_WOULD_LOCK_OUT` naming the access; keep the agent-side check as the second line.
- **Acceptance test:** unit test of the planner: a reject-all block is refused with the named protected access; a block that keeps the access passes; a replayed stale plan still fails at apply (host scenario).

### [P2] `node revoke` and `node decommission` plans state no effect, no tier and no requirements
- **Area:** node lifecycle plans
- **Block:** C (node-plans D4)
- **Reproduction:** `exponetdb node revoke nod_… --no-wait --output json` (same for decommission).
- **Expected:** content/analysis state that the gateway refuses the node at its next request, waiting jobs are canceled, the server loses management, what depends on it (clusters served, open operations, other active plans); the tier of the node's server; a re-authentication requirement listed in `requirements`.
- **Actual:** `change.content = {nodeId}`, `change.analysis = null`, `subject.tier = null` ("Tier: unknown"), `decision allow`, `requirements []`; revoke and decommission share the same `contentChecksum`. The node is the only agent of a real staging host. The re-authentication they need (withdrawal gives `REAUTH_REQUIRED`) is not announced.
- **Evidence:** `C/node-plans-report.md` (D4).
- **Root cause:** `packages/nodes/src/plans.ts:28-58` (`store` passes `subject: {}` to the policy and no `analysis` to `createPlan`) and `:133-150` (`planStateChange`).
- **Proposed fix:** pass the server's tier into the subject, add an impact analysis (clusters, open jobs, open operations, active plans), list `reauthentication` in `requirements`, give revoke and decommission different content checksums.
- **Acceptance test:** integration test: the revoke plan has `subject.tier`, `analysis.impact` with counts, and `requirements` containing the re-auth requirement; the two kinds differ in `contentChecksum`.

### [P2] A user with `nodes.plan` cannot withdraw their own node plans
- **Area:** auth scopes, `plan withdraw`
- **Block:** C (node-plans D5), E11-adjacent
- **Reproduction:** `exponetdb plan withdraw pln_01M5ZF4EQW8F0GGEAV93NKAA98` (a node reload plan made by the same identity) -> `INSUFFICIENT_SCOPE` (needs `nodes.operate:nonprod`; the CLI prints a `login --scope` line); withdrawing a `node.revoke` plan -> `REAUTH_REQUIRED` ("A fresh passkey...").
- **Expected:** the person who made a plan can withdraw it with the scope that made it; withdrawing is the safe direction.
- **Actual:** plans stay active until expiry (15 or 30 minutes) and cannot be cleaned up; a destructive revoke plan needs a stronger proof to withdraw than to create.
- **Evidence:** `C/node-plans-report.md` (D5); lead check on two plans.
- **Root cause:** the scope of the `plan.withdraw` action versus `node.plan` (`packages/contracts/src/actions.ts`, node plan kinds use `nodes.operate`, `tieredScope` around `:1088-1170`).
- **Proposed fix:** let the plan's own creator withdraw under the scope that created it and without a fresh passkey (owner decision if policy wants otherwise).
- **Acceptance test:** auth integration test: an identity holding only `nodes.plan` withdraws its own `postgres.reload` and `node.revoke` plans (204) and cannot withdraw another identity's plan (403).

### [P3] Node plan CLI errors drop the capability and the reason in text mode (E7)
- **Area:** CLI error rendering, node plans
- **Block:** C (node-plans D6, D7), E7
- **Reproduction:** `exponetdb node postgres roles nod_… --cluster cls_… --file roles.json --no-wait` prints only "No node-signed observation of this cluster is recent enough to plan against (at most 10 minutes). Inspect the cluster through the node, then plan again." `--output json` carries `details.capability`. Also: `create pg_trgm` where it is installed gives `CONFLICT "The resource changed (If-Match did not match)."`; invalid inspect args give `VALIDATION_FAILED` with `path ""`, "The request is not valid."; the TLS refusal `REGISTRY_CONFLICT ca_bundle_lacks_postgres_ca` is generic in text.
- **Expected:** the text names the capability (and the args that must match, e.g. `--arg database=...`), the field of a validation failure, and the reason of a conflict, with a remediation.
- **Actual:** only `--output json` has the detail; `CONFLICT` talks about an If-Match no one sent.
- **Evidence:** `C/node-plans-report.md` (D6, D7).
- **Root cause:** `apps/cli/src/output/render.ts:151-166` (`detailLines` prints only `details.errors`); generic messages at `packages/contracts/src/errors.ts:1179-1190` and `:1361`; `capability-plans.ts:575-580` and `:336-337` throw without details.
- **Proposed fix:** print `details.capability`, `details.reason` and the validation `path`; give `NODE_OBSERVATION_STALE` a remediation that names the exact `node inspect` command; use a dedicated conflict reason instead of the generic `CONFLICT`.
- **Acceptance test:** CLI unit tests for `NODE_OBSERVATION_STALE`, `REGISTRY_CONFLICT` and `VALIDATION_FAILED` text output; contract test that a conflict raised by a node planner carries a `reason`.

### [P3] Plan commands document `--wait` as "wait until applied and verified (the default)" although they only plan
- **Area:** CLI help
- **Block:** C (node-plans D8)
- **Reproduction:** `exponetdb help node postgres reload`.
- **Expected:** help says the command waits for the plan, not for an apply, unless `--apply` is given.
- **Actual:** the text invites the reading that the default applies; the tester treated it as a risk. Without `--apply` nothing is applied (`apps/cli/src/cli/planning.ts`, the `input.flags['apply'] !== true` branch).
- **Evidence:** `C/node-plans-report.md` (D8).
- **Root cause:** `apps/cli/src/cli/watch.ts:16-17` shared flag text.
- **Proposed fix:** plan-specific flag text ("--apply applies the plan now and waits until applied and verified").
- **Acceptance test:** help snapshot test for a plan command.

### [P3] No read form for job keys; `node job-keys` without changes is a usage error (E5)
- **Area:** CLI/REST node job keys
- **Block:** C (node-plans D9), E5
- **Reproduction:** `exponetdb node job-keys nod_…` -> `Error ... a job-key change adds or removes at least one key` (exit 2, client side); `--add key_tc_campaign_probe` -> `REGISTRY_CONFLICT job_key_not_addable`.
- **Expected:** a read shows the keys a node trusts and the keys it could add.
- **Actual:** no command or route lists job keys; `node show` does not show them; no positive plan can be built without out-of-band knowledge of key ids. The only read is `node inspect --capability agent.diagnostics@2` then `node observations --output json` (needs `nodes.plan`; the table hides the keys).
- **Evidence:** `C/node-plans-report.md` (D9), `E/e-findings-local.md` (E5).
- **Root cause:** missing read (`packages/contracts/src/rest/routes.ts` has no job-key route); `apps/cli/src/commands/node.ts:455` usage check.
- **Proposed fix:** `GET /nodes/{id}/job-keys` (key ids, state, trusted-by-node) with `node job-keys <node> --show`; show the keys in `node show`.
- **Acceptance test:** integration test for the route; CLI test for `--show`; a plan with a listed key id succeeds.

### [P3] Node plan polish
- **Area:** CLI/UX
- **Block:** C (node-plans)
- **Reproduction:** (1) `--file` paths are resolved against the process cwd; relative paths fail when run through a wrapper that changes cwd (wrapper artifact, no defect); (2) the restart plan shows no disruption summary although the basis observation holds it (see the `plan show` P1); (3) revoke/decommission plans list tier as `-`.
- **Expected:** n/a (covered by the entries above).
- **Actual:** n/a.
- **Evidence:** `C/node-plans-report.md`.
- **Root cause:** see the entries above.
- **Proposed fix:** none beyond the entries above; drop this entry if they land.
- **Acceptance test:** none separate.
