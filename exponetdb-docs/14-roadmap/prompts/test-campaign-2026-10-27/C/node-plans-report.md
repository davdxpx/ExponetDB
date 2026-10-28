# Node plan test report (plans only, nothing applied)

Tester: node-plan subagent, 2026-10-27, 20:02 to 20:12 UTC.
Node `nod_01M5XZ84V768SYCHZKRNGJFQP2` (agent 0.7.0, active), cluster `cls_01M5J4RDBP52B715X5HDFKDN5F` (REOSA staging, tier nonprod, endpoint 10.8.1.1:5432).
CLI: wrapper `xdb` (origin/main d0229550 source, owner's stored login). Raw outputs: `C/node-plans/raw-<kind>.txt`.

## Safety record

- No `--apply`, no `plan apply`. Every plan command used `--no-wait`. Code check: `node postgres *` (apps/cli/src/commands/node.ts:135) and `planCommand` (apps/cli/src/cli/planning.ts, the `input.flags['apply'] !== true` branch) return after planning unless `--apply` is given, so `--wait` and `--no-wait` have no effect on a plan without `--apply` (see D8).
- The only applies were the read-only `node inspect` plans (basis observations), which is how observations are made.
- No SSH, SQL, Coolify, Supabase or Hetzner. No secrets created. Roles used only the fake name `tc_campaign_probe`; the one verifier-shaped probe was a fake object that the CLI contract check refused before sending.
- Withdrawal was NOT possible (see D5): `plan withdraw` of a nodes plan fails with INSUFFICIENT_SCOPE, and of a revoke plan with REAUTH_REQUIRED. I did not try to get the scope or log in. These plans stay `active` until expiry and are listed below.

Unwithdrawn plans of this test (all unapplied, expire by themselves):

| Plan | Kind | Expires (UTC) |
|---|---|---|
| pln_01M5ZF9ZR9ZBHSCQ6RTT8MB6EV | postgres.reload | 20:32:27 |
| pln_01M5ZFAWSG3BDTTN3HCQ8XD7KN | postgres.reload | 20:32:57 |
| pln_01M5ZFC0X4E6104JH6HZ6GW0QY | postgres.restart | 20:33:34 |
| pln_01M5ZFGQ3JPJTHVACYW7RKVW7R | postgres.hba.apply (harmless) | 20:21:08 |
| pln_01M5ZFGZCMPKGV5997CFVQW2WP | postgres.hba.apply (reject all) | 20:21:16 |
| pln_01M5ZFJ14SWPENN3GHKGQZBQN2 | postgres.extensions.apply (no-op update) | 20:21:51 |
| pln_01M5ZFNCZK5RK5A1GM8ZEX36WM | node.revoke | 20:23:41 |
| pln_01M5ZFPJP6SVNA3ZV2DEGHKKM8 | node.decommission | 20:24:20 |

(`plan list --mine` also shows a postgres.reload and a postgres.restart plan from about 20:00 that are not mine; same identity.)

## Results per kind

Common to every created plan: `decision: allow`, `requirements: []`, `approvals 0/0`, subject = cluster + node, tier nonprod (except node.revoke/decommission: tier null). Class and expiry: standard = 30 min, high = 15 min.

| Kind | Outcome | Plan | Class | Expiry | Notes |
|---|---|---|---|---|---|
| postgres.reload | plan created | pln_01M5ZF9ZR9ZBHSCQ6RTT8MB6EV | standard | 30 min | basis `postgres.status@1` made with `node inspect --capability postgres.status@1 --cluster C` |
| postgres.restart | plan created | pln_01M5ZFC0X4E6104JH6HZ6GW0QY | standard | 30 min | basis `postgres.restart.plan@2`. The observation shows 9 live connections of the staging app role, 0 backups, 0 maintenance, 0 slots; a restart would sever them. That is not visible in the plan (D1). |
| postgres.config.apply | BLOCKED from CLI | none | n/a | n/a | NODE_OBSERVATION_STALE for `postgres.config.plan@2`; the basis cannot be created from the CLI (D2). |
| postgres.hba.apply, harmless | plan created | pln_01M5ZFGQ3JPJTHVACYW7RKVW7R | high | 15 min | one `hostssl` scram rule for `tc_campaign_probe` from 192.0.2.1/32, `protectedAccess: []`. Basis `postgres.hba.inspect@2`. |
| postgres.hba.apply, lockout | plan created, NOT refused | pln_01M5ZFGZCMPKGV5997CFVQW2WP | high | 15 min | managed block = `reject` for all users, all databases, address all and local (D3). |
| postgres.roles.apply | BLOCKED from CLI | none | n/a | n/a | NODE_OBSERVATION_STALE for `postgres.roles.inspect@2`; basis needs `expectSettings: []` (D2). `set_password` step refused by the CLI contract check. |
| postgres.extensions.apply | plan created (no-op) | pln_01M5ZFJ14SWPENN3GHKGQZBQN2 | high | 15 min | `update pg_trgm` to 1.6 on `reosa_staging_scratch` (already at 1.6, so a no-op if ever applied). Basis `postgres.extensions.inspect@1 --arg database=reosa_staging_scratch`. A `create pg_trgm` step was refused with CONFLICT (D7). |
| postgres.tls.rotate | refused | none | n/a | n/a | REGISTRY_CONFLICT `ca_bundle_lacks_postgres_ca`: the cluster's registered CA bundle lacks the ExponetDB PostgreSQL CA. Correct fail-closed behavior; the message is generic (D7). The name check (`tls_name_not_registered`) could not be reached because the CA check runs first. |
| node.config.update (job-keys) | no flags: usage error; fake `--add`: refused | none | n/a | n/a | exit 2 `a job-key change adds or removes at least one key`; fake key id gives REGISTRY_CONFLICT `job_key_not_addable`. No way to learn real key ids (D9). |
| node.revoke | plan created | pln_01M5ZFNCZK5RK5A1GM8ZEX36WM | high | 15 min | content `{nodeId}`, analysis null (D4). |
| node.decommission | plan created | pln_01M5ZFPJP6SVNA3ZV2DEGHKKM8 | high | 15 min | same shape as revoke (D4). Same `contentChecksum` as revoke; the plan hash differs. |

## `plan show` content judgement

| Question | reload | restart | hba | extensions | revoke / decommission |
|---|---|---|---|---|---|
| Content shown at all | no | no | no | no | JSON only (`change.content` = nodeId); table form shows nothing |
| Understandable | n/a | n/a | n/a | n/a | no, only an id |
| Secrets absent | yes (nothing shown) | yes | yes | yes | yes |
| Destructive effect stated | no | no | no | no | no |
| Restart disruption shown | n/a | no | n/a | n/a | n/a |
| hba managed-block diff and protectedAccess check | n/a | n/a | no | n/a | n/a |

The table form of `plan show` (planBlocks, apps/cli/src/output/views.ts:111-162) never renders `change` for any non-migration kind. The JSON form returns `change` only for some kinds (D1).

## Defects

### D1 (P1) `plan show` returns no `change` (content and analysis) for the seven `postgres.*` node plan kinds

- Repro: `xdb node postgres reload nod_… --cluster cls_… --no-wait --output json`, then `xdb plan show <pln> --output json`. Same for restart, hba (both variants) and extensions.
- Expected: PlanView.change present (packages/contracts/src/rest/resources.ts: "access, registry, target and node kinds"); docs control-plane.md §9.3 (table row `postgres.hba.apply`) says the plan shows foreign rules, the managed block before and after, and the protected access the plan adds. A restart plan should show what it disrupts.
- Actual: no `change` key. A `node.inspect` plan and a `node.revoke` plan do return it, so it is the kind filter.
- Suspected: packages/application/src/views.ts:160-176. The allowlist is `access.`, `registry.`, `target.`, `node.`, `migration.`, `drift.`, `backup.`, `restore.` and `postgres.roles.verifier.set`; plain `postgres.*` is missing. Possibly deliberate for config values and role settings (withheld classes), but reload, restart, hba, extensions and tls carry no secrets. Needs an owner decision; at least the non-secret kinds should be shown.
- Effect: a person or approver cannot see the hba diff or protectedAccess (D3), what a restart severs (9 live connections here), or the extension steps before applying.

### D2 (P1) `node postgres config` and `node postgres roles` cannot be planned from the CLI

- Repro (proof): `xdb node inspect nod_… --capability postgres.config.plan@2 --cluster cls_…` gives VALIDATION_FAILED; with `--arg 'changes=[]'` or `--arg changes=x` the value reaches the server as the string and gives VALIDATION_FAILED (path `""`, "The request is not valid."); with `--arg 'changes=[{"name":"a","value":"1"}]'` the CLI itself fails with `--arg takes name=value.` because list flags split on commas. Same for `postgres.roles.inspect@2` with `--arg expectSettings=[]`. Then `xdb node postgres config … --set tc_campaign.probe=1 --no-wait` and `xdb node postgres roles … --file roles.json --no-wait` fail with NODE_OBSERVATION_STALE (`capability: postgres.config.plan@2`, `postgres.roles.inspect@2`) and the remediation "Inspect the cluster through the node, then plan again." which cannot be followed.
- Expected: the CLI offers a way to create the basis observation, or the plan command makes it.
- Actual: dead end. REST would accept it (args are `JsonValue`, packages/contracts/src/rest/nodes.ts:63); only the CLI is limited. I did not call REST (needs a token).
- Suspected: apps/cli/src/commands/node.ts:342-347 (`--arg` "string values") and :360 (`Object.fromEntries(pairs(...))`); apps/cli/src/cli/planning.ts:198-205 (`pairs`); apps/cli/src/cli/args.ts:143-147 (comma split); required array args in packages/nodes/src/capability-plans.ts:114-121 (`basisArgs` for config: `changes`; roles: `expectSettings: []`) and the basis table :71-82. Note `planNodeInspection` also refuses non-empty `expectSettings` (:343-345) by design.
- Blocked consequence: credential rotation and role-verifier flows share `expectSettings: []`, so they would hit the same wall from the CLI.

### D3 (P2) A pg_hba block that rejects everything is planned and allowed; no plan-time protectedAccess check

- Repro: `xdb node postgres hba nod_… --cluster cls_… --file hba-cut.json --no-wait` with managedRules = hostssl all/all/all `reject` plus local all/all `reject`, `protectedAccess: []`.
- Expected (from the task brief): refused at plan time by protectedAccess.
- Actual: plan `pln_01M5ZFGZCMPKGV5997CFVQW2WP`, class high, decision allow, no requirements, "Next: plan apply … --wait". Per docs control-plane.md §9.6 the lockout protection is at apply: the agent refuses a block that locks out protected access and puts the previous file back. That was not tested (not applied).
- Suspected: packages/nodes/src/capability-plans.ts:723-733 (merges requested and derived protectedAccess, never simulates the rules against it) and :520-528 (analysis records counts only). The derived access (ownNetworkAccess, :618-655) could be matched against `managedRules` at plan time; the observation already lists all foreign rules and their line order. With D1 the human cannot see the reject-all rules either. Note the host's current file has no managed block and 16 foreign rules; ExponetDB's own access is a foreign rule, so where the agent places the managed block decides whether the rules would shadow it (unknown, not applied).

### D4 (P2) node.revoke / node.decommission plans do not state the effect or the impact

- Repro: `xdb node revoke nod_… --no-wait --output json`.
- Expected: content or analysis states that the gateway refuses the node at its next request, waiting jobs are canceled, the server loses management, and what depends on it (clusters served, open operations, other active plans); a tier.
- Actual: `change.content = {nodeId}`, `change.analysis = null`, `subject.tier = null` (`plan show` prints "Tier: unknown"; `plan list` prints `-`), decision allow, requirements `[]`. This node is the only agent of a real staging host. The re-authentication the action needs (actions.ts:1234-1243, `REAUTH`) is not listed in `requirements`.
- Suspected: packages/nodes/src/plans.ts:28-58 (`store` passes `subject: {}` to the policy and no `analysis` to `createPlan`) and :133-150 (`planStateChange`).

### D5 (P2) A `nodes.plan` user cannot withdraw their own node plans (E11 adjacent)

- Repro: `xdb plan withdraw pln_01M5ZF9ZR9ZBHSCQ6RTT8MB6EV` gives INSUFFICIENT_SCOPE (needs `nodes.operate:nonprod`; the CLI prints a `login --scope …` line). `xdb plan withdraw pln_01M5ZFNCZK5RK5A1GM8ZEX36WM` (revoke) gives REAUTH_REQUIRED "A fresh passkey or TOTP proof is needed" (exit 3).
- Expected: the person who made a plan can cancel it with the scope that made it; withdrawing is the safe direction.
- Actual: plans stay active until expiry (15 or 30 min) and cannot be cleaned up; a destructive revoke plan needs a stronger proof to withdraw than to create.
- Suspected: scope of the `plan.withdraw` action vs `node.plan` (packages/contracts/src/actions.ts, node plan kinds are `nodes.operate`, tieredScope at :1088-1170).

### D6 (P3) E7: the human error text drops the capability and the reason

- Repro: `xdb node postgres roles nod_… --cluster cls_… --file roles.json --no-wait`. The text output says only "No node-signed observation of this cluster is recent enough to plan against (at most 10 minutes). Inspect the cluster through the node, then plan again." `--output json` has `details.capability: "postgres.roles.inspect@2"`.
- Expected: the text names the capability (and the args that must match, e.g. `--arg database=…` for extensions, which changes the args hash).
- Suspected: apps/cli/src/output/render.ts:151-166 (`detailLines` prints only `details.errors`); packages/contracts/src/errors.ts:1179-1190 holds the generic message. Same loss for REGISTRY_CONFLICT `details.reason` (`ca_bundle_lacks_postgres_ca`, `job_key_not_addable`, `tls_name_not_registered`).
- Answer to E7: JSON mode says which capability; text mode does not.

### D7 (P3) Generic or misleading plan-time errors

- `create pg_trgm` where it is installed: `CONFLICT "The resource changed (If-Match did not match)."` (no If-Match is involved). Source: capability-plans.ts:575-580 throws `NodeError('CONFLICT')`; message at packages/contracts/src/errors.ts:1361.
- Inspect with invalid args: `VALIDATION_FAILED` with `path ""`, "The request is not valid."; no field named (capability-plans.ts:336-337 throws without details).
- TLS refusal: generic REGISTRY_CONFLICT text ("the name, path or address is taken…") for a missing CA in the bundle; reason only in JSON, no remediation.

### D8 (P3) Wait flags on plan commands are misleading

`--wait` is documented "Wait until applied and verified (the default)" on commands that only plan (apps/cli/src/cli/watch.ts:16-17). Without `--apply` nothing is applied or waited for. The tester brief treated it as a risk; it is not one, but the help reads as if planning applies. `node inspect` has no `--wait`/`--no-wait` and always waits (it applies its own read plan, as designed).

### D9 (P3) E5: no read form for job keys

- Repro: `xdb node job-keys nod_…` gives `Error: The request does not match the contract: (body): a job-key change adds or removes at least one key` (exit 2). `--add key_tc_campaign_probe` gives REGISTRY_CONFLICT `job_key_not_addable`.
- There is no command or REST route that lists job keys or the set a node trusts (`node show` does not show it; no `jobKey` read route in packages/contracts/src/rest/routes.ts), so key ids to add cannot be discovered and no positive plan was possible. `trustedJobKeys` exists server-side (capability-plans.ts:967-976).

### D10 (P3) `node show` reports no clusters

`xdb node show nod_… ` prints "No clusters reported." and JSON `clusters: []`, although the node serves `cls_01M5J4RDBP52B715X5HDFKDN5F` (all cluster inspections and plans mapped to it). `RESTART PENDING` and `TLS UNTIL` columns are therefore never visible.

## Other findings

- E11: `nodes.plan` was sufficient for inspect and all `node postgres *` plans. `node job-keys`, `node revoke`, `node decommission` need `registry.manage` (node.ts:29, :455, :471); the stored login had it. No scope error was met while planning; D5 is the scope error met while withdrawing.
- Secrets: none seen in any plan JSON, in the inspect operations or in the observations I read (hba foreign rule options were empty; role names and addresses are shown).
- Good: client-side contract check refused a `set_password` step with a fake verifier object before sending; plans for a node without the `postgres.*` capabilities are refused locally by `requireCapability`; the TLS plan failed closed on the CA bundle.
- Standard class and `allow` for a nonprod restart of a live staging database, with no approval, is by design (actions.ts:1112-1124 `byTier('standard','high')`), but D1 hides the 9 live connections it would sever.
- The `--file` path is resolved against the wrapper's cwd (the worktree), so relative file paths fail with "cannot be read" when run through the `xdb` wrapper; absolute paths work. Wrapper artifact, not a CLI defect.
