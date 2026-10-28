### [P2] `exponetdb-node enroll` on a fresh host fails with `state directory: lstat /var/lib/exponetdb-node`; the literal runbook has two more blockers (E1, GAP-01 to GAP-03)
- **Area:** node agent packaging and `node-runbook.md` §2/§3
- **Block:** D/E (E1 reproduced on a real systemd host and locally)
- **Reproduction:** release 0.7.0 (`agent/node/packaging/build.sh`), runbook §2 literally (`install`, `systemd-sysusers`, `systemctl daemon-reload`), config at `/etc/exponetdb-node/config.json`, then §3.3 `sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file ...` before any unit started. Also: `--token-file /root/token` gives `open /root/token: permission denied` for the agent user (`/root` is 0700); `--token-file - < /root/token` works. §2 never installs `tmpfiles.d/exponetdb-node-engine.conf` nor creates `/etc/exponetdb-node`.
- **Expected:** the node enrolls (§3 runs before §3.5 "start").
- **Actual:** `state directory: lstat /var/lib/exponetdb-node: no such file or directory`, exit 1 (verbatim in `D/gap-scenarios/01-e1-install.txt`); exit 0 after `install -d -m 0700 -o exponetdb-node -g exponetdb-node /var/lib/exponetdb-node`. Without `tmpfiles` the backup engine directories `/var/lib/exponetdb-node-engine/{runs,scratch,reads}` do not exist after a literal install.
- **Evidence:** `E/e-findings-local.md` E1; `D/gap-scenarios.md` GAP-01 to GAP-03; `D/gap-scenarios/01-e1-install.txt`.
- **Root cause:** `agent/node/internal/state/state.go:103-122` (`Open` runs before the command switch in `cmd/exponetdb-node/main.go:126`; `fsutil.go:153-156` `CheckOwnedPrivate` starts with `Lstat`); `packaging/systemd/exponetdb-node.service:34-35` `StateDirectory=` creates it only at unit start; `packaging/sysusers.d/exponetdb-node.conf:2` names the home only; no tmpfiles line; runbook `node-runbook.md:34-46` (§2) and `:119` (§3.3 token path). The host test swaps `StateDirectory=` for a pre-created `ReadWritePaths` (`agent-capabilities.host.test.ts:352`), so CI never runs the fresh-host order.
- **Proposed fix:** ship `d /var/lib/exponetdb-node 0700 exponetdb-node exponetdb-node -` in a new `agent/node/packaging/tmpfiles.d/exponetdb-node.conf` (installed by `build.sh`); runbook §2 adds `install -m 0644 tmpfiles.d/*.conf /usr/lib/tmpfiles.d/`, `systemd-tmpfiles --create`, `install -d /etc/exponetdb-node`; §3.3 uses `--token-file - < /root/token`; `state.Open` answers an `ENOENT` with "state directory X does not exist: run systemd-tmpfiles --create, see node-runbook.md §2".
- **Acceptance test:** Go test `TestEnrollMissingStateDirectoryExplainsFix` (exit 1, stderr contains `does not exist` and `node-runbook.md`); extend `agent/node/packaging/verify-units.sh` to run `systemd-sysusers --root` plus `systemd-tmpfiles --root --create` and assert `stat -c %a` is `700`; a host scenario that follows the runbook text literally (install, enroll as the agent user before any unit, then start).

### [P2] An older CLI answers `RESPONSE_INVALID` against a newer server; no version negotiation exists (E4)
- **Area:** CLI/SDK/contracts versioning
- **Block:** E (E4 reproduced at unit level)
- **Reproduction:** in-process CLI against a fake server (scripts in the tester's scratch `e4/run.ts`): installation `version: '9.0.0'` with an added field or a new enum value in a list response -> exit 5 `RESPONSE_INVALID` (status and request id only, no remediation); `restApi: 'v2'` also gives `RESPONSE_INVALID` because `restApi: z.literal('v1')` fails first, so `incompatible_server` is dead code; list commands print the wrong text plus an empty-table block. 175 of 176 response enums are closed and 27 response objects are strict.
- **Expected:** "this CLI 0.6.0 is older than the server; update to >= X".
- **Actual:** every command of an older CLI breaks as soon as a newer server adds a value to one closed enum or a field to one strict object, with a contract error.
- **Evidence:** `E/e-findings-local.md` E4.
- **Root cause:** `apps/cli/src/cli/remote.ts:26` (`matchesContract` = strict `safeParse`) wired as `validate` at `:182`; `packages/sdk/src/transport.ts:205-226` returns `RESPONSE_INVALID`; `connect()` (`remote.ts:198-206`) validates the installation body strictly before the version check; no `x-exponetdb-api-version` header, no minimum-CLI field; `apps/cli/src/version.ts:11`; strict contract objects per `exponetdb-docs/06-rest-api/versioning.md` §2.
- **Proposed fix:** additive optional `Installation.minCliVersion`; send `X-Exponetdb-Api-Version`/`X-Exponetdb-Version` on every response; in `connect()` parse the installation tolerantly first (`contracts.restApi`, `version`), raise `incompatible_server` for another REST major and `cli_outdated` when `minCliVersion > CLI_VERSION`; attach "server X is newer than this CLI Y: update the CLI" to `RESPONSE_INVALID` when the server version is newer; make response objects non-strict (27 sites) and growing enums `x-extensible-enum` with a tolerant SDK parse; `listingFailure` must not render an empty table.
- **Acceptance test:** `apps/cli/test/cli.test.ts` with a fake server: `restApi: 'v2'` -> exit 5 `incompatible_server` naming both versions; `minCliVersion: '9.0.0'` -> `cli_outdated`; an extra field on a node list -> exit 0; an unknown `state` on a newer server -> exit 5 with an update hint and no "No nodes" block; a contract test that no response schema of `ROUTE_LIST` is strict and every response enum is extensible or allow-listed with a reason.

### [P2] `migration lint` has no path, bundle or since filter, so a project with one old prod-blocking bundle can never get a green lint (E9)
- **Area:** CLI migration lint
- **Block:** E (E9 reproduced with a scratch project and a copy of the real REOSA bundle)
- **Reproduction:** project with an old applied bundle containing `CREATE FUNCTION ... SECURITY DEFINER` without `search_path` and a clean new bundle depending on it: `exponetdb migration lint` -> exit 1 `MIGRATION_LINT_BLOCKED`; `migration lint <path>`, `--bundle`, `--since`, `--only` are rejected (exit 2); copying the new bundle alone gives `unknown_dependency`. A copy of `01M5X2X3ARA75KSKZPANYYEHHW_event-platform` from the REOSA checkout (copy only) gives 15 findings, 11 blocking, all level `warn` and blocking only in the prod tier: 5 `uncovered_statement`, 3 `create_index_without_concurrently`, 3 `table_without_grant`; `--tier nonprod` exits 0.
- **Expected:** a new clean bundle can get a green lint run; already applied bundles do not block.
- **Actual:** the red is permanent because applied bundles cannot change without a checksum mismatch; the CLI is stricter than the server gate that lints only the pending set (`planner.ts` around `:615`).
- **Evidence:** `E/e-findings-local.md` E9.
- **Root cause:** `apps/cli/src/commands/migration.ts:242-333`: no argument or filter, `readBundles(project)` -> `lintBundles(all)` (`:267`), exit code from all blocking findings (`:277-281`); `lintBundles` has no scope option.
- **Proposed fix:** `migration lint [<bundle dir|id>...]` plus `--since <id>` and `--exclude-applied`; build the graph over all bundles but count findings and the exit code only for the selected ones, listing the others as `skipped` (`scope?: ReadonlySet<string>` in `packages/migrations/src/lint/lint.ts`); alternatively a reviewed per-bundle waiver in `exponetdb.project.yaml` (`lint.accepted: [{migration, rule, reason}]`).
- **Acceptance test:** `apps/cli/test/local.test.ts`: old bundle with `security_definer_without_search_path` plus clean new bundle: `migration lint` -> exit 1 (unchanged); `migration lint <new>` -> exit 0 with the old listed as `skipped` and no `unknown_dependency`; `migration lint <old>` -> exit 1; unknown bundle -> exit 2.

### [P2] An expired node certificate is silent and indistinguishable, and nothing warns before the renewal window closes (GAP-11)
- **Area:** node agent certificate lifecycle, gateway refusal reasons, findings
- **Block:** D (gap scenarios 4a to 4d; live node deadline)
- **Reproduction:** on a real systemd host with the real 72 h certificate: with 24 h 43 min left nothing happens; with 23 h 13 min left the certificate renews in under 1 s (PASS) and the renewed one works on a fresh session; an agent brought back with 9 h left renews within 16 ms. With the host clock moved past `notAfter` the gateway answers a generic `403 NODE_CERTIFICATE_REFUSED` (the same text as revocation and wrong state), the node row stays `active`, no finding or warning is raised and the agent retries forever with 1 to 60 s backoff; `exponetdb-node status` prints only a date. Recovery by RB-13 re-enrollment works end to end.
- **Expected:** a distinct reason `certificate_expired`; `status` says "expires in 5h12m (renewal due)" or "EXPIRED"; a node finding or health condition when `now > certificateExpiresAt - 12 h` without a renewal.
- **Actual:** silence. The live node on `reos-db-01` has a certificate expiring 2026-10-30T05:57:35Z, its renewal window is 2026-10-29T05:57:35Z to 2026-10-30T05:57:35Z (a third of 72 h, `packages/nodes/src/gateway.ts:278-285`); an agent stopped for two days from now recovers without re-enrollment; only an outage spanning the whole window needs RB-13, and nothing warns before it closes.
- **Evidence:** `D/gap-scenarios.md` item 4 and GAP-11; `D/gap-scenarios/10-cert-renew.txt`; `C/live-mcp-reads.md`.
- **Root cause:** `packages/nodes/src/gateway.ts:265,497` throw `NODE_CERTIFICATE_REFUSED` for all causes; no health condition reads `certificate_expires_at`; `agent/node/cmd/exponetdb-node` `status` prints the date only.
- **Proposed fix:** distinct refusal detail `certificate_expired`; `exponetdb-node status` prints remaining time and "renewal due"/"EXPIRED"; a node finding `node_certificate_near_expiry` (warning from 12 h before expiry, critical after) and `node_certificate_expired`; document in runbook §6.
- **Acceptance test:** host scenario that moves the clock past `notAfter` asserts the refusal detail and the finding; unit test of the finding thresholds; `status` text test.

### [P3] Downgrade rule in runbook §8 is imprecise; the real downgrade hazards are undocumented (GAP-04)
- **Area:** node-runbook.md §8/§9
- **Block:** D (upgrade 0.6.0 to 0.7.0 PASS; downgrade PASS)
- **Reproduction:** a node enrolled with a 0.6.0 build (commit `1819998e`), upgraded to 0.7.0 and used (12 journal jobs), downgraded to 0.6.0: the older agent accepts the journal and ledger unchanged (17 jobs, effects ledger prefix byte-identical, an effect succeeded). `git diff 1819998e d0229550 -- agent/node/internal/journal agent/node/internal/state agent/node/internal/clock` is empty. Real hazards: a `config.json` with the 0.7.0 field `pgbackrestConfig` makes the 0.6.0 agent and helper refuse to start (`configuration: json: unknown field "pgbackrestConfig"`, agent crash loop, node offline); 0.7.0-only capabilities (`backup.timers@1`) answer `CAPABILITY_UNAVAILABLE`. Upgrade: journal, nonce and ledger prefixes byte-identical, a job queued during the swap completed 2 s after the agent started.
- **Expected:** the runbook says which release introduced journal format 2 and what a downgrade really needs.
- **Actual:** "from the first job on, an older agent refuses every job with `journal_corrupt`" is true only for releases before the F7 correction (not tested: no pre-F7 binary).
- **Evidence:** `D/gap-scenarios.md` GAP-04; `D/gap-scenarios/03-upgrade-060-070.txt`, `04-downgrade-070-060.txt`.
- **Root cause:** documentation; config loader strictness.
- **Proposed fix:** runbook §8/§9 name the release that introduced format 2, state that 0.6.0 and 0.7.0 share it, and warn about `pgbackrestConfig`; or accept unknown config fields with a warning in the agent.
- **Acceptance test:** docs review; a Go test that a 0.7.0 config is either documented as not loadable by earlier releases or accepted with a warning.

### [P3] A refused clock reads as "job expired" on the control plane; `clockSkewMs` is not a clock-health signal (GAP-05)
- **Area:** node runner error mapping, heartbeat
- **Block:** D (clock scenario: agent PASS, helper PARTIAL)
- **Reproduction:** `timedatectl set-ntp false; date -s "+45 seconds"` (kernel maximum error 16 s), then any inspection: the node answers the signed rejection `clock_untrusted` (journal line `job rejected ... clock_untrusted`, no effect, helper ledger unchanged); recovery is immediate with `timedatectl set-ntp true`.
- **Expected:** the control plane shows the clock as the cause.
- **Actual:** the operation ends `failed / not_applied`, `errorCode JOB_EXPIRED` "The job was not claimed before it expired."; the node stays `active`, `clockSkewMs: 0` (control plane and node share one clock in the test), `lastErrors: []`.
- **Evidence:** `D/gap-scenarios.md` GAP-05; `D/gap-scenarios/05-clock.txt`.
- **Root cause:** `packages/nodes/src/runner.ts:400-416` maps `clock_untrusted` to `JOB_EXPIRED` (documented in `control-plane.md:363` but the message is wrong).
- **Proposed fix:** keep the code, add `detail.reason = clock_untrusted` and a message naming the host clock; put `clockSynchronized` in the heartbeat and show the node `degraded` while false.
- **Acceptance test:** host scenario step "unsynchronized clock": the operation's `detail.reason` is `clock_untrusted` and the node view shows the clock condition.

### [P3] Disk full on the agent state or the helper ledger: silent stall, torn ledger record, undocumented restart (GAP-06, GAP-07)
- **Area:** node agent and helper robustness, RB-13
- **Block:** D (disk full scenario: fail-closed PASS)
- **Reproduction:** 16 MB ext4 loop mounted on `/var/lib/exponetdb-node` and filled: the agent cannot store or sign the statement, the job stays `dispatched`, logs "job delivered again" every minute, every other operation of the node waits behind it and after the window (5 min for reads) fails `NODE_CAPABILITY_FAILED`; the node stays `active`, the only trace is free text in `heartbeat.agent.lastErrors`; recovery without restart once space is freed, journal prefix byte-identical. Helper ledger (3730 bytes, next 373-byte record crosses a 4 KiB block) with the filesystem full: the helper refuses (`the effect ledger is broken`, nothing applied) but `effects.log` grows to 4096 bytes with a torn partial record, and the helper refuses every effect until `systemctl restart exponetdb-node-helper` (which drops the torn tail); the refused operation spent minutes in `needs_reconciliation / OUTCOME_UNKNOWN` before `not_applied`.
- **Expected:** a typed answer, no latch, a documented recovery.
- **Actual:** see Reproduction; runbook §8 covers only a lost ledger.
- **Evidence:** `D/gap-scenarios.md` GAP-06, GAP-07; `D/gap-scenarios/06-diskfull.txt`.
- **Root cause:** `agent/node/internal/agent/statement.go:57-65` (`commit` leaves the job open by design); helper ledger append without truncation back to the last good offset.
- **Proposed fix:** report `agent_state_unwritable` in the heartbeat (node `degraded`) so the control plane fails the operation at once; helper `ftruncate` to the last good offset on a failed append (no latch); runbook RB-13 "disk full" paragraph (free space; restart the helper if it latched).
- **Acceptance test:** host scenario with a 16 MB loop mount: node `degraded` within one heartbeat, the next operation after freeing space succeeds; helper Go test on a size-limited filesystem: after ENOSPC and freeing space the next effect succeeds without restart and the ledger chain verifies.

### [P3] hba refusals carry `OUTCOME_UNKNOWN`; removing the managed block leaves an empty marker pair; job-key activation accepts a stale proof (GAP-08 to GAP-10, GAP-12)
- **Area:** node capabilities hba and job keys, agent hello
- **Block:** D (hba PASS on markers and foreign lines; job keys PASS on the unsafe half)
- **Reproduction:** (GAP-08) plans `local all all reject` (the agent's own access) and a `hostssl ... reject` above a requested `protectedAccess`: plan time 201 with no warning; apply time refused on the host, previous file restored (sha256 unchanged, `psql` still connects), operation `failed / not_applied` but `errorCode OUTCOME_UNKNOWN` (steps `execute failed`, `reconcile succeeded`). (GAP-09) `managedRules: []` leaves `# BEGIN EXPONETDB MANAGED BLOCK` and `# END EXPONETDB MANAGED BLOCK` at the top of `pg_hba.conf`. (GAP-10) K2 added to agent and helper (proof recorded), the helper's `helper-trust.json` replaced by the K1-only copy and the helper restarted, then `job-key activate` exits 0; every effect signed with K2 is then refused by the helper (`job_invalid ... unknown_signing_key`), nothing applied. (GAP-12) after fixing `pg_ident.conf` for an already running agent the node keeps `clusters: []` and every inspection fails `REGISTRY_CONFLICT cluster_unmapped` until `systemctl restart exponetdb-node` (the hello announces clusters once per agent start; the heartbeat sends none).
- **Expected:** refusals name the lockout (`hba_lockout`); an empty rule list removes the markers; activation requires a fresh proof; clusters refresh.
- **Actual:** see Reproduction. Stale and foreign-edit plans give `PLAN_STALE`, a replayed applied plan is idempotent, foreign lines are kept byte for byte (PASS).
- **Evidence:** `D/gap-scenarios.md` GAP-08 to GAP-10, GAP-12; `D/gap-scenarios/07-hba.txt`, `08-jobkeys.txt`.
- **Root cause:** `agent/node/internal/capabilities` hba apply error mapping; hba block writer; `job-key activate` uses a stored proof without an age bound; `agent/node/internal/agent/agent.go:417` (hello) and `:510` (heartbeat `Clusters: []`).
- **Proposed fix:** typed `hba_lockout` error code; drop the markers for an empty list (or document); require a proof younger than a few minutes or take a fresh `agent.diagnostics` inside `activate`; refresh the cluster list on a heartbeat interval (this also fixes the node view finding).
- **Acceptance test:** extend `hba.host.test.ts` (code `hba_lockout`, file equals the original after removal) and `job-keys.host.test.ts` (step "helper copy reverted after proof": activation refused); a host test that a new cluster appears in `GET /nodes/{id}` without an agent restart.

### [P3] Hardening observations of the node units (GAP-13)
- **Area:** systemd unit hardening
- **Block:** D
- **Reproduction:** `systemd-analyze security exponetdb-node.service exponetdb-node-helper.service`: agent 1.7 OK, helper 1.9 OK; capabilities of the running agent all zero, `NoNewPrivs 1`, `Seccomp 2`; the three private seeds do not appear in unit journals, `status`, `ps` or the environment; state files 0600 owner `exponetdb-node`, helper files 0600 root, helper socket 0660 `root:exponetdb-node`.
- **Expected:** n/a (no exposure found).
- **Actual:** remaining optional knobs: helper `UMask=0077`, `ProtectProc=invisible`/`ProcSubset=pid` where the process checks allow, `ProtectClock=yes` on both.
- **Evidence:** `D/gap-scenarios/09-hardening.txt`.
- **Root cause:** n/a.
- **Proposed fix:** add the knobs after a host scenario run proves nothing breaks; optional.
- **Acceptance test:** `verify-units.sh` asserts the added directives; host scenarios stay green.

### [P3] `-- covers:` in `verify.sql` counts statements from 0 and the documentation never says so (E8)
- **Area:** migration lint, verification docs
- **Block:** E (E8)
- **Reproduction:** project `acme/demo`, bundle with three `INSERT` statements (indexes 0, 1, 2); `-- covers: 0,1,2` -> no warning; `-- covers: 1,2,3` -> `uncovered_statement` (level `warn`, blocking at the default prod tier, exit 1) for statement 0; out-of-range indexes are silently accepted.
- **Expected:** the docs say "counted from 0"; the message names the index; out-of-range entries are flagged.
- **Actual:** none of these.
- **Evidence:** `E/e-findings-local.md` E8.
- **Root cause:** `packages/postgres/src/parser/verify-checks.ts:78-95` (entries as strings), `packages/migrations/src/lint/lint.ts:867-872` (`covered.has(String(s.index))`, 0-based, comments not counted); docs `04-migrations/verification.md:159,361` and `migration-bundles.md:440`; `rules.ts:272`.
- **Proposed fix:** docs "statement index = position of the top-level statement in `up.sql`, counted from 0, comments and empty statements not counted" with a self-contained example; put `statement index N (counted from 0)` and the line into the `uncovered_statement` message; add rule `covers_out_of_range` (warn).
- **Acceptance test:** `packages/migrations/test/lint.test.ts`: three-statement bundle: covers `0,1,2` -> no finding; `1,2,3` -> `uncovered_statement` containing `statement 0` and `from 0` plus `covers_out_of_range` for `3`; a docs test asserts `verification.md` contains "counted from 0".

### [P3] CLI presets and declared scopes do not match what the commands need (E11)
- **Area:** CLI presets, scope declarations
- **Block:** E (E11 PARTIAL: `nodes.plan` is in `operator:nonprod` and `operator:prod`)
- **Reproduction:** read `apps/cli/src/presets.ts:20-85`: `nodes.plan` is not in `read`, `developer:*` or `admin` (admin has `registry.manage` but not `nodes.plan`); `--preset` cannot be repeated; `auth presets` truncates the scope column; five `cluster` commands declare `nodes.read`/`nodes.plan` while the server needs `registry.manage` (`apps/cli/src/commands/registry.ts:933,968,1002,1318,1422`). The README preset table matches `presets.ts`.
- **Expected:** a preset exists for node operations and the declared scopes equal the server's.
- **Actual:** an operator who needs node plans and admin must pass an explicit `--scope` list.
- **Evidence:** `E/e-findings-local.md` E11 (matrix).
- **Root cause:** as cited.
- **Proposed fix:** add `nodes.plan` (and `restore.plan`, `backups.run` where admin operates backups) to `admin` or introduce `fleet:nonprod`; allow repeated `--preset` as a union (`auth.ts` `presetFrom`); wrap the SCOPES column; fix the five declared scopes.
- **Acceptance test:** `apps/cli/test/presets.test.ts`: for every remote `CommandSpec` with a fixed server scope `spec.scopes` equals the action's scope; node management (`node enrollment create` plus `node inspect`) is covered by at least one preset; `auth presets` at 120 columns prints `nodes.plan` in the operator row without truncation.
