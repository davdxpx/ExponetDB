# D: node-agent gap scenarios on a real systemd host (tc-node-3)

| | |
|---|---|
| Date | 2026-10-27, about 80 minutes of wall time |
| Host | tc-node-3, Hetzner cx33, Ubuntu 24.04, systemd 255, PostgreSQL 17 disposable cluster `exdbnode` (port 55417) |
| Code under test | ExponetDB `origin/main` `d0229550`; release binaries 0.7.0 (`d0229550`) and 0.6.0 (`1819998e`) from `agent/node/packaging/build.sh`; units from the release (`/etc/systemd/system`), user `exponetdb-node` from `sysusers.d` |
| Control plane | the harness' real serve/gateway/worker (`HostWorld`) run as a long-lived "lab daemon" (`/root/exdb/apps/server/test/host/lab-daemon.host.test.ts`, command files over `/root/lab/cmd`), plus a resume variant (`lab-resume.host.test.ts`: gateway and worker on the persisted Control Store database, used after the reboot). Control Store: docker `postgres:17.11` on 127.0.0.1:55432. Both files exist only on tc-node-3 (throwaway). |
| Method | The shipped release binaries and units, not the harness' e2e build (the e2e build assumes a synchronized clock, so it cannot test items 3 and 4). Install by shell per runbook §2/§3. |
| Evidence | `gap-scenarios/` next to this file (copied from `/root/evid` on tc-node-3; no tokens, seeds, keyring or passwords; raw journals and ledgers were not copied) |

Lab artifacts that are not product findings: every control-plane (lab) restart recreates the disposable
PostgreSQL cluster, so `pg_ident.conf` lost the `exponetdb exponetdb-node exponetdb_node` line and the node
reported `clusters: []` until the line was back and the agent restarted; the clock jumps expired the lab
owner's passkey session (REST calls returned `SESSION_EXPIRED`), so one decommission was done with SQL; the
gateway mints its own 72 h server certificate at start and the clock jumps outlived it.

## Results

| # | Item | Verdict | Duration | Evidence |
|---|---|---|---|---|
| 1 | E1: `enroll` before the first unit start | **FAIL** (defect E1 reproduced; the minimal fix works and breaks nothing). A second blocker of the same literal procedure found (GAP-02) | 12 min | `01-e1-install.txt` |
| 2 | Upgrade 0.6.0 to 0.7.0, downgrade 0.7.0 to 0.6.0 | **PASS** for the upgrade; downgrade **PASS with a doc defect** (the runbook's `journal_corrupt` claim does not apply to 0.6.0; two real downgrade hazards found) | 10 min | `02-install-060.txt`, `03-upgrade-060-070.txt`, `04-downgrade-070-060.txt` |
| 3 | Clock skew | **PASS** for the agent (typed refusal, recovery at once); **PARTIAL** for the helper (not reachable independently) and for `clockSkewMs` (control plane and node share one clock, reads 0) | 6 min | `05-clock.txt` |
| 4a | Real certificate renewal by a real clock jump | **PASS** | 8 min | `10-cert-renew.txt` |
| 4b | Expired certificate: behavior and RB-13 recovery | **PASS** for the documented recovery (re-enrollment works, helper trust included); **FAIL** for diagnosability (GAP-11) | 10 min | `10-cert-renew.txt` |
| 4c | Node back inside the window (9 h of validity left) | **PASS**: recovers by itself, no re-enrollment | 2 min | `10-cert-renew.txt` |
| 4d | Return 20 s before `notAfter` | **NOT RUN** (isolated badly: the lab gateway's own 72 h server certificate had expired in the jump; no conclusion) | n/a | `10-cert-renew.txt` |
| 5 | Disk full, agent state and helper ledger | **PASS** (fail closed, no corruption, recovery) with three P3 findings | 25 min | `06-diskfull.txt` |
| 6 | `systemctl reboot` | **PARTIAL**: units, backoff and job accounting verified; the control-plane reconciliation of the in-flight restart had not finished when the session ended | 20 min | `06-reboot.txt` |
| 7 | `pg_hba` managed block | **PASS** for markers, foreign lines and apply-time refusals; **FAIL** against the brief's "refused at plan time" (it is not; by design it is refused on the host at apply) | 8 min | `07-hba.txt` |
| 8 | Job-key rotation and the helper's trust copy | **PASS** (a helper without the key refuses every effect, nothing applied) with one P3 | 6 min | `08-jobkeys.txt` |
| 9 | Unit hardening, secrets in status and logs | **PASS** (agent 1.7 OK, helper 1.9 OK; no secret found) | 3 min | `09-hardening.txt` |

## The question about reos-db-01 (item 4)

reos-db-01's certificate expires 2026-10-30T05:57:35Z. The gateway sets the renewal instruction, and the agent
computes it itself, once at most one third of the lifetime remains: `notAfter - 24 h`, that is
**2026-10-29T05:57:35Z** (tested: with 24 h 43 min left nothing happened; with 23 h 13 min left the agent
renewed in under one second, `certificate_renewed_at` set, audit `node.certificate_renewed`). The window in
which renewal works is therefore `[2026-10-29T05:57:35Z, 2026-10-30T05:57:35Z]`.

- Agent stopped for two days from now (back around 2026-10-29 evening): the certificate is still valid
  (about 9 h left). On start the agent said hello and renewed within 16 ms (tested with exactly 9 h left).
  **It recovers without re-enrollment.**
- The node recovers by itself whenever the agent is running again before `notAfter`. A shorter outage can
  still be fatal in one case only: the outage straddles the whole window, that is the agent is down from before
  2026-10-29T05:57:35Z until after 2026-10-30T05:57:35Z (more than 24 h in the worst case, 72 h at most).
- After `notAfter`: the gateway answers every request `403 NODE_CERTIFICATE_REFUSED` ("The client certificate
  is not the node's current certificate, or the node's state does not allow the request."); the agent logs
  `session ended` and retries forever with backoff of 1 s to 60 s; the node row keeps `state = active` and the
  views derive `offline` after 60 s; there is no finding and no state reason; `exponetdb-node status` prints
  only the expiry time. Recovery is RB-13 (decommission, move `/var/lib/exponetdb-node` aside, new token,
  enroll, `exponetdb-node-helper trust`, start): **documented, and it works** (tested end to end; the helper
  kept its ledger; the new node was `active` 2 s after the start).
- Nothing in the control plane warns before the window closes (no finding, no alert on `certificateExpiresAt`).
  For reos-db-01: watch `exponetdb-node status` ("certificate expires") on 2026-10-29 for a renewed date.

## Defects

Severity: P0 data loss, security or production outage; P1 wrong result or blocked core flow; P2 degraded with
workaround; P3 polish. No P0 or P1 found.

### GAP-01 (P2) Enrollment on a fresh host fails: the state directory does not exist (finding E1)

- Reproduction (verbatim in `01-e1-install.txt`): release 0.7.0, runbook §2 (`install`, `systemd-sysusers`,
  `systemctl daemon-reload`), config at `/etc/exponetdb-node/config.json`, then §3.3
  `sudo -u exponetdb-node exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file ...`
  before any unit has ever started.
- Expected: the node enrolls (§3 runs before §3.5 "start").
- Actual: `state directory: lstat /var/lib/exponetdb-node: no such file or directory`, exit 1. Exit 0 after
  `install -d -m 0700 -o exponetdb-node -g exponetdb-node /var/lib/exponetdb-node`.
- Root cause: the directory exists only after the agent unit's `StateDirectory=exponetdb-node` ran;
  `sysusers.d` `u` with a home path does not create it (`agent/node/packaging/sysusers.d/exponetdb-node.conf`),
  and the unprivileged agent cannot create it under `/var/lib`
  (`agent/node/internal/state/state.go:121` `Open` calls `fsutil.CheckOwnedPrivate`, which fails on `lstat`).
- Minimal fix verified: a directory 0700 owned by the agent user. Checked that nothing else breaks: with the
  directory pre-created, the shipped unit started (`StateDirectory=` kept owner and mode), the node bound,
  `postgres.status@1` and config changes through the helper succeeded. The alternative `tmpfiles.d` line was
  checked with `systemd-tmpfiles --create` (mode and owner come out right).
- Proposed fix: ship `d /var/lib/exponetdb-node 0700 exponetdb-node exponetdb-node -` in
  `agent/node/packaging/tmpfiles.d/` (a file named `exponetdb-node.conf`, next to the engine lines), and in
  runbook §2 add `install -m 0644 tmpfiles.d/exponetdb-node.conf /usr/lib/tmpfiles.d/` and
  `systemd-tmpfiles --create`; also let `state.Open` say "run systemd-tmpfiles --create" on `ENOENT`.
- Acceptance test: a systemd host scenario (or `packaging/verify-units.sh` plus a Go test of the error text) that
  installs the release files per runbook §2 and runs `enroll` as the agent user before any unit started; and a
  `verify-units.sh` check that the state directory is declared by `StateDirectory=` and the tmpfiles line.

### GAP-02 (P3) Runbook token path is unreadable for the agent user

- Reproduction: after GAP-01 is worked around, `sudo -u exponetdb-node exponetdb-node enroll ... --token-file /root/token`
  (`/root/token` mode 0600 root, `/root` mode 0700).
- Expected: enrollment reads the token. Actual: `open /root/token: permission denied`, exit 1.
- Root cause: runbook §3.3 (`exponetdb-docs/12-operations/node-runbook.md`, line 119) names `/root/token`; the file
  is root-owned and the agent user cannot traverse `/root`.
- Proposed fix: use `--token-file - < /root/token` (works, verified; the shell opens the file as root) and shred
  as before.
- Acceptance: the host scenario that follows the runbook literally uses the runbook's command text.

### GAP-03 (P3) Runbook §2 leaves out `tmpfiles.d` and `/etc/exponetdb-node`

- The release carries `tmpfiles.d/exponetdb-node-engine.conf` (backup engine directories, root 0711) but §2 never
  installs it, so `/var/lib/exponetdb-node-engine` does not exist after a literal install; `/etc/exponetdb-node`
  is not created before §2 step 3 writes the config. (Backup runs were not exercised here; the helper unit's
  `ReadWritePaths=-/var/lib/exponetdb-node-engine` tolerates the missing directory.)
- Fix: same runbook edit as GAP-01. Acceptance: same scenario, then `ls -ld /var/lib/exponetdb-node-engine`.

### GAP-04 (P3) The downgrade rule in runbook §8 is imprecise; the real downgrade hazards are undocumented

- Reproduction (`04-downgrade-070-060.txt`): node enrolled with 0.6.0, upgraded to 0.7.0 and used (12 journal
  jobs), downgraded to 0.6.0.
- Doc says: "From the first job on, the journal is in format 2: an older agent refuses every job with
  `journal_corrupt`, so a downgrade means enrolling the host again."
- Actual: 0.6.0 accepted the 0.7.0-written journal and ledger unchanged (17 jobs, effects ledger prefix
  byte-identical, an effect succeeded). `git diff 1819998e d0229550 -- agent/node/internal/journal agent/node/internal/state agent/node/internal/clock`
  is empty: the statement is true only for releases before the F7 correction, which the text does not say.
  (A pre-F7 binary was not available; not tested.)
- Real hazards found: (a) a `config.json` with the 0.7.0 field `pgbackrestConfig` makes 0.6.0 agent and helper
  refuse to start (`configuration: json: unknown field "pgbackrestConfig"`, agent crash loop, node offline);
  (b) the control plane answers 0.7.0-only capabilities (`backup.timers@1`) `CAPABILITY_UNAVAILABLE` for the
  downgraded node (typed, fine).
- Fix: runbook §8/§9 say which release introduced format 2, say that 0.6.0 and 0.7.0 share it, and name (a).
  Acceptance: doc review plus a Go test that the 0.7.0 config with `pgbackrestConfig` is documented as not
  loadable by earlier releases (or accepted with a warning).

### GAP-05 (P3) A refused clock reads as "job expired" and nothing else shows it

- Reproduction (`05-clock.txt`): `timedatectl set-ntp false; date -s "+45 seconds"` (the kernel's maximum error
  becomes 16 s, so the clock is "unsynchronized"); run any inspection.
- Expected: the documented refusal `clock_untrusted` (runbook §1, RB-13 step 3). Got it on the node side: signed
  rejection `clock_untrusted`, journal line `job rejected ... clock_untrusted`, no effect (helper ledger unchanged).
- Actual on the control plane: the operation ends `failed / not_applied`, `errorCode: JOB_EXPIRED`, message
  "The job was not claimed before it expired."; the node stays `active`, `clockSkewMs: 0`, `lastErrors: []`.
  An operator cannot tell a clock problem from a slow node.
- Root cause: `packages/nodes/src/runner.ts:400-416` maps `clock_untrusted` to `JOB_EXPIRED` (documented in
  `control-plane.md:363`, but the message is wrong for it).
- Proposed fix: keep the code, add `detail.reason = clock_untrusted` and a message that names the host clock;
  put `clockSynchronized` in the heartbeat and make the node view `degraded` while it is false.
- Acceptance: host scenario step "unsynchronized clock": the operation's `detail.reason` is `clock_untrusted` and
  the node view shows the clock condition.
- Recovery verified: `timedatectl set-ntp true` and the next job succeeded at once (rejected jobs do not advance
  `highestIssuedAt`, so the 45 s step back did not trip the rollback rule).

### GAP-06 (P3) Agent state filesystem full: silent for the length of the job window

- Reproduction (`06-diskfull.txt`): 16 MB ext4 loop mounted on `/var/lib/exponetdb-node`, filled to 0 bytes; read job
  and a config change.
- Expected: fail closed with a typed error; no corruption; recovery when space returns.
- Actual: fail closed and recovered (journal prefix byte-identical, `exponetdb-node status` consistent, next job
  succeeded without a restart, the config change never reached the helper: `work_mem` unchanged, ledger
  unchanged). But the agent cannot store or sign the statement ("job statement not stored; the job stays open ...
  no space left on device"), so there is no typed answer: the job sits `dispatched`, the agent logs "job
  delivered again" every minute, every other operation of the node waits behind it, and after the window (5 min
  for reads) the operation fails `NODE_CAPABILITY_FAILED` (write) or times out. The node stays `active`; the only
  trace is free text in `heartbeat.agent.lastErrors`.
- Root cause: `agent/node/internal/agent/statement.go:57-65` (`commit` leaves the job open by design).
- Proposed fix: report an `agent_state_unwritable` condition in the heartbeat (node `degraded`) so the control
  plane fails the operation at once; runbook line: "free space; no restart needed".
- Acceptance: host scenario with a 16 MB loop mount; assert node `degraded` within one heartbeat and the next
  operation after freeing space succeeds.

### GAP-07 (P3) Helper ledger filesystem full: torn record, latch until restart, undocumented

- Reproduction (`06-diskfull.txt`): ledger at 3730 bytes (the next 373-byte record crosses a 4 KiB block), helper
  filesystem filled, a config change applied. (The first attempt, with the ledger inside its last block, did not
  fail: appends that fit the allocated block still succeed on a full filesystem.)
- Expected: refuse, nothing applied, ledger intact, recover.
- Actual: refused (`helper refused (failed): the effect ledger is broken`), `work_mem` unchanged (fail closed,
  good), but `effects.log` grew to 4096 bytes: a torn partial record at the end (ends mid-JSON, no newline). The
  running helper then refused every effect until restarted; after `systemctl restart exponetdb-node-helper` it
  dropped the torn tail (4096 to 4104 bytes after the next record) and the next effect succeeded. The refused
  operation spent minutes in `needs_reconciliation / OUTCOME_UNKNOWN` before it settled `not_applied`.
- Gap: runbook §8 treats only a lost ledger; "free space, then restart the helper" is nowhere.
- Proposed fix: on a failed append, `ftruncate` back to the last good offset (no latch needed), or document the
  restart; add a "disk full" paragraph to RB-13.
- Acceptance: helper Go test with a size-limited filesystem (or the loop mount host scenario): after ENOSPC and
  freeing space, the next effect succeeds without a restart, and the ledger chain verifies.

### GAP-08 (P3) hba apply refusals carry `OUTCOME_UNKNOWN`; lockout is accepted at plan time

- Reproduction (`07-hba.txt`): plans `local all all reject` (agent's own access) and a `hostssl ... reject` above a
  requested `protectedAccess` (single address `10.1.0.5`).
- Plan time: `201`; the plan analysis shows no warning (the control plane merges `protectedAccess` and does not
  evaluate it). Apply time: refused on the host, the previous file restored, `sha256` of `pg_hba.conf` unchanged,
  `psql` still connects, operation `failed / not_applied`, but with `errorCode: OUTCOME_UNKNOWN` (steps
  `execute failed`, `reconcile succeeded`).
- A stale plan replayed after the file moved: `PLAN_STALE`, file unchanged. An already applied plan replayed:
  returns the same operation (idempotent), nothing runs twice. A foreign edit between plan and apply: `PLAN_STALE`,
  the foreign edit kept.
- Note: this contradicts the brief's expectation "refused at plan time AND at apply time"; the documentation
  (`control-plane.md:§9.6`, `capabilities.md:338`) promises only the apply-time refusal, which holds.
- Proposed fix: error code and detail that name the lockout (`hba_lockout`), and an optional plan-time warning
  from the basis observation's parsed rules. Acceptance: the existing hba host scenario asserts the code and the
  plan analysis warning.

### GAP-09 (P3) Removing the managed block leaves an empty marker pair

- `managedRules: []` leaves `# BEGIN EXPONETDB MANAGED BLOCK: ...` and `# END EXPONETDB MANAGED BLOCK` at the top of
  `pg_hba.conf`; the file is not byte-identical to the pre-ExponetDB file (`07-hba.txt`, last diff). Foreign lines
  were kept byte-for-byte (tabs, trailing spaces, UTF-8, inline comments) while the block existed. The block sits
  at the top, above the agent's own `local all exponetdb_node peer map=exponetdb` line.
- Fix: drop the markers when the rule list is empty, or document it. Acceptance: the hba scenario compares the
  file with the original after removal.

### GAP-10 (P3) Job-key activation accepts a stale proof

- Reproduction (`08-jobkeys.txt`): K2 added to agent and helper (proof recorded), then the helper's
  `helper-trust.json` replaced by the K1-only copy and the helper restarted, then `job-key activate`: exit 0.
  Every effect and every helper-backed read signed with K2 is then refused by the helper
  (`helper refused (job_invalid): the job signature does not verify: unknown_signing_key`), nothing applied,
  `work_mem` and ledger unchanged; a fresh `agent.diagnostics@2` shows `helperJobKeys: null`.
- The safe half passed: a trust update the helper cannot write (`chattr +i`) leaves the agent's keys unchanged
  and `activate` stays `job_key_trust_unproven`.
- Fix: require the proof statement to be younger than a bound (minutes) at activation, or take a fresh
  diagnostics inside `activate`. Acceptance: job-keys scenario step "helper copy reverted after proof".

### GAP-11 (P3) Expired node certificate: indistinguishable, silent, no early warning

- Evidence in `10-cert-renew.txt` and the section above: generic `NODE_CERTIFICATE_REFUSED` text for expiry,
  revocation and state alike; node row `active` with stale heartbeat; no finding; `exponetdb-node status` prints
  only a date; nothing in the control plane warns when `certificateExpiresAt` is near and the node did not renew.
- Proposed fix: distinct refusal reason `certificate_expired` in the gateway's detail; `status` prints
  "expires in 5h12m (renewal due)" or "EXPIRED"; a node finding or health condition when
  `now > certificateExpiresAt - 12 h` without renewal. Acceptance: host scenario that moves the clock past
  `notAfter` and asserts the detail and the finding.

### GAP-12 (observation, P3) Hello announces the clusters once per agent start

- After fixing `pg_ident.conf` for an already running agent the node kept `clusters: []` and every inspection
  failed `REGISTRY_CONFLICT cluster_unmapped` until `systemctl restart exponetdb-node`
  (`agent/node/internal/agent/agent.go` heartbeat sends `Clusters: []`). Runbook order (§2 PostgreSQL before §3)
  avoids it; mention it in §4 "Verify".

### GAP-13 (P3) Hardening suggestions (no exposure found)

- `systemd-analyze security`: agent 1.7 OK, helper 1.9 OK (`09-hardening.txt`). Remaining knobs: helper
  `UMask=0077`, `ProtectProc=invisible` and `ProcSubset=pid` if its process checks allow, `ProtectClock=yes` on
  both (CAP_SYS_TIME is already missing; `adjtimex` read access is kept by the filter), agent `ProcSubset=pid`
  only if the host-metrics reads (`/proc/meminfo`, loadavg) are moved. Capabilities in the running agent:
  all zero, `NoNewPrivs 1`, `Seccomp 2`.
- Secrets: the three private seeds of the node do not appear in the unit journals, `status`, `ps` or the process
  environment; state files are 0600 owner `exponetdb-node`, the helper's files 0600 root, the helper socket 0660
  `root:exponetdb-node`; `/etc/exponetdb-node/helper-trust.json` (0644) holds public keys only.

## Item notes

### 1 and 2 (install, upgrade, downgrade)

- Literal runbook §2 then §3 fails twice (GAP-01, GAP-02), then works with the fix. After the fix the units
  started, the node was `active` 12 s later, `postgres.status@1` and a helper-backed config change passed.
  RB-13 re-enrollment after `node.decommission` through REST also worked (0.7.0 node replaced by a 0.6.0 node,
  helper trust rewritten, no ledger in the way).
- Upgrade 0.6.0 to 0.7.0 (runbook §9 order: stop agent, install binaries and units, `daemon-reload`, restart the
  helper socket, start the agent; one read was queued during the swap): the queued job completed 2 s after the
  agent started; `journal.log`, `nonces.log` and `effects.log` prefixes byte-identical (`cmp`); `helper-ledger.json`
  unchanged; the first 0.7.0 effect appended to the same ledger; heartbeats resumed immediately; the 0.7.0
  `tmpfiles` creates the engine directories (root, 0711). No "parked statements" line (nothing was undelivered).

### 3 (clock)

- Kernel after `date -s`: `System clock synchronized: no`, maximum error at the 16 s limit. Agent: every job
  rejected `clock_untrusted` (read and the change plan applied afterwards), signed rejection visible in
  `nodes.jobs.completion.rejectionReason`; no effect reached the helper. `clockSkewMs` on the control plane read
  `0` because the gateway and the agent share a clock on this host; a real skew report was not produced (it would
  need the gateway on another clock, for example libfaketime on the lab daemon; not done).
- The helper's own check (`agent/node/internal/helper/guard.go:46`) shares the kernel state and sits behind the
  agent's check, so a separate refusal by the helper was not provoked.

### 4 (certificate), details

- Renewal: `notBefore = issue - 5 min`, `notAfter = notBefore + 72 h` (a node certificate has 71 h 55 min of
  validity after issue); agent rule `enroll.DueForRenewal` (two thirds elapsed) and gateway rule
  `gateway.ts #renewDue` (one third left) agree. The renewed certificate was accepted on a fresh TLS session
  (agent restarted, hello `active`).
- Expired: the first attempt failed on the lab gateway's own expired server certificate (agent-side
  `x509: certificate has expired`); after re-minting that certificate the node certificate itself was refused
  with 403 as described.

### 6 (reboot)

- Units: `exponetdb-node.service` (enabled) and `exponetdb-node-helper.socket` came back with the host without
  intervention (boot at 21:13:58, agent started 21:14:13); PostgreSQL cluster and docker came back; with the
  gateway still down the agent retried with backoff (1 s growing to about 20 s), no crash.
- In-flight job (`postgres.restart` signed and running, `exponetdb-node status` showed `1 in flight` when
  `systemctl reboot` was issued): after the boot the journal showed `0 in flight`, the job reported to the control
  plane as `completed / failed` ("helper refused (failed): systemctl restart postgresql@17-exdbnode.service
  failed", systemd was shutting down), PostgreSQL's postmaster start time is the boot's, and **no second restart
  ran** (helper journal has no restart after boot). The operation sat in `needs_reconciliation / unknown /
  pending` at least 4 minutes after the node returned (`updated_at` moving about once a minute); the runbook
  says the settle time can be about 11 minutes. I did not wait for it to settle. Open question for the owner of
  the reconcile code: the restart's verification compares the postmaster start time with the status read before
  the job; after a reboot the start time is later although this job never restarted PostgreSQL, so the
  reconciliation could read `applied`. Not verified.

### 7 (hba), what was checked

Markers are exactly `# BEGIN EXPONETDB MANAGED BLOCK: written by exponetdb-node-helper, do not edit` and
`# END EXPONETDB MANAGED BLOCK`; rules are written quoted (`hostssl "app" "app_user" 10.1.0.0/16 scram-sha-256`);
removing the block region from the new file yields the previous file byte-for-byte (`cmp`); mode and owner stay
`640 postgres:postgres`. Lockout refusals and stale plans as in GAP-08.

## Not done

- Pre-F7 agent for the `journal_corrupt` downgrade claim (no such binary in the lab).
- Item 4d and a skewed gateway clock for `clockSkewMs`.
- The end of the reboot reconciliation; backup runs through the engine directory.
- All CP-side steps after a clock jump used SQL for one decommission (REST session expired); the REST
  decommission was proven at normal time.

Evidence files: `gap-scenarios/01-e1-install.txt` to `gap-scenarios/10-cert-renew.txt` plus `hba.*`,
`helper-trust.*.json`, the plan JSONs. Lab daemons: `/root/exdb/apps/server/test/host/lab-daemon.host.test.ts`,
`lab-resume.host.test.ts` on tc-node-3.
