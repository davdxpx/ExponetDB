# ADR-0037: Long-running node capabilities run as supervised engine runs, started, observed and stopped by short signed jobs

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 9 Part B order (2026-10-26, §5); the host evidence (real systemd, crash and restart scenarios) is the owner's pre-Wave-11 test T-NODE-2 and is `NOT PROVEN` until it ran |
| Date | 2026-10-26 |
| Builds on | [`../../07-node-agent/protocol.md`](../../07-node-agent/protocol.md) §4 (one envelope, one execution; one statement per job; journal), [ADR-0024](./0024-node-trust-model.md) (job keys, `nr1`, `ns1`, job identity), [ADR-0025](./0025-reload-proof-by-journaled-steps.md) |
| Related | [ADR-0036](./0036-backup-repositories-and-providers.md), [ADR-0038](./0038-restore-plans-drills-and-offline-runbooks.md); OD-24, OD-29 |

## Context

Backups and restores run for hours. The node protocol bounds a job: its
validity window is at most 60 minutes, its run limit (`runSeconds`) is
fixed per capability, the root helper's commands are capped at 15 minutes,
and a job that stops reporting ends `outcome_unknown` within one lease. A
job executes at most once and gets exactly one signed statement. Extending
these limits for backups would weaken every capability (a lost job would
stay "running" for hours, a crash in the middle could not be told apart
from progress) and a generic "run this for a long time" job would be a
shell by another name.

## Decision

### 1. A long-running effect is an engine run, not a long job

An **engine run** (`run_…`, 26-character ULID body, chosen by the worker and
bound in the start job's arguments) is the execution of one allowlisted
engine command with fixed arguments on the node. It is created, observed
and stopped by three kinds of **short** jobs:

| Capability | Kind | Path | What it does | Effect step | Reconcile |
|---|---|---|---|---|---|
| `backup.run@1`, `backup.verify@1`, `backup.expire@1`, `restore.execute@1`, `restore.discard@1` (start capabilities) | apply | helper | validates the typed arguments **again on the host**, writes the run record, starts the run, returns `{runId, startedAt, unit}` | `start_run` | `observable` (the run record and the unit say whether it started) |
| `run.status@1` | read | helper | returns the run's state (`starting`, `running`, `succeeded`, `failed`, `canceled`, `lost`), progress, exit code, parsed result, a redacted excerpt, and the start job's id and `argsHash` | — | — |
| `run.cancel@1` | apply | helper | stops the run (SIGTERM, then SIGKILL after the engine's grace time) and records the cancel; never claims a rollback | `stop_run` | `observable` |

The start job finishes in seconds and gets its one statement as today. The
run's terminal outcome is stated in the **status job** that observes it:
that statement is node-signed (`nr1`), names the run id, the start job id
and the start job's `argsHash`, so the worker binds the outcome to exactly
the job, plan, operation, node and cluster that started it. A status read
before the end returns `running` and changes nothing.

### 2. The run is supervised by systemd, not by the helper process

- The helper starts the engine as a **transient systemd service** with a
  fixed unit name `exponetdb-run-<runId>.service`, through `systemd-run`
  (added to the helper's binary allowlist with a fixed argument template),
  never through a shell. The unit's properties are fixed in code:
  `User=postgres` (or the engine's documented user), `NoNewPrivileges=yes`,
  `PrivateTmp=yes`, `ProtectSystem=strict` with `ReadWritePaths=` only the
  run directory and (for restores) the agent-chosen scratch directory,
  `ProtectHome=yes`, `MemoryMax=`, `CPUWeight=`, `IOWeight=`,
  `RuntimeMaxSec=` per capability (backup 12 h, verify 12 h, expire 1 h,
  restore 24 h, discard 1 h), `LimitCORE=0` (no core dumps with key
  material), `KillMode=control-group`, `TimeoutStopSec=` the engine's grace
  time, `Restart=no`.
- **[OBSERVED]** (`agent/node/packaging/systemd/exponetdb-node-helper.service`,
  2026-10-26) The helper itself runs with `PrivateNetwork=yes`,
  `ProtectSystem=strict`, one request at a time (`QueueWait` 30 s) and a
  15-minute command cap: it can neither reach object storage nor hold a
  run for hours without blocking every other host operation. A transient
  unit gets its own fixed properties (network for the engine only) and
  frees the helper's queue at once. Pinning its egress to the repository
  endpoints (`IPAddressAllow=`) needs addresses, not names; it is
  **[PLANNED]**, and until then the engine's egress is not restricted
  beyond the host's firewall (recorded as residual R-NODE-3 in
  `PRE-WAVE-11-REVIEW.md` W9-04).
- The run therefore survives a restart of the helper or the agent; it does
  not survive a reboot (systemd stops transient units), which a status read
  then reports as `lost` (the unit is gone without a recorded result).
- **Run record**: `/var/lib/exponetdb-node/runs/<runId>/record.json`
  (root-owned, `0600`, written with `fsafe` before the unit starts; never a
  path from the Control Plane), holding the start job id, `argsHash`,
  operation id, capability, cluster `system_identifier`, repository id,
  start time and the unit name; `result.json` is written by the helper when
  it collects the unit's exit status and the engine's output. Secrets the
  run needs (cipher passphrase, storage credential) arrive sealed (`ns1`),
  are opened by the helper and written to `secrets/` in the run directory
  (`0600`, owned by the engine user), and are removed when the run ends;
  they are never in argv, the environment of `systemd-run`, the unit's
  properties, the journal or any result.
- **Argument templates** are per capability and engine version and contain
  only values validated by the contract (enums, ULIDs, LSNs, timestamps,
  stanza and repo index, the agent-chosen path). No argument, path or
  option comes as free text from the Control Plane; the helper rebuilds the
  argv from the typed arguments after it verified the job's signature
  itself.

### 3. Exclusivity, fencing and duplicates

- The helper holds a per-cluster run lock (one active run per
  `(system_identifier, domain)` where domain is `backup` or `restore`): a
  start while a run of the same domain is `starting` or `running` is
  refused (`precondition_failed`, "run active"), so a duplicated delivery,
  a retried operation or a second worker never starts a second backup or
  overlapping expiry, and never a second restore into one destination.
- The Control Plane holds the operation's exclusivity domain
  (`cluster:<id>:backup`, `cluster:<id>:restore`) for the whole run, and
  records the run in `backups.runs` with a partial unique index (one open
  run per cluster and domain), the operation id and the lease owner.
- A start job is still executed at most once (journal); a re-dispatch
  repeats the identical envelope and gets the stored statement; the run id
  in its arguments makes a second start of the same run id refused by the
  helper even if the journal were lost (the run record exists).
- A worker that lost its lease neither starts runs nor accepts their
  outcome; the next lease holder reconciles by `run.status@1`.

### 4. Crash, partition and unknown outcomes

| Situation | Node state | Control Plane |
|---|---|---|
| Start job stated `succeeded` | run record + unit | poll `run.status@1` every 30 s (backoff to 5 min) until terminal |
| Start job outcome unknown (lost statement, agent crash) | maybe a run record | `run.status@1` with the run id: `not_found` → `not_applied`; any record → follow it |
| Agent or helper restarted during the run | unit keeps running | next status read continues |
| Host rebooted | unit gone, no result | `lost` → operation `needs_attention`; **no automatic retry** for restore, expire or verify; for backup the engine's own resume rules apply only through a new plan |
| Network partition | run continues | status reads resume; the run's `RuntimeMaxSec` bounds it |
| Cancel requested | `run.cancel@1` | the run's terminal state says `canceled` only if the engine stopped before its effect, otherwise `failed` with the effect recorded |

Nothing irreversible is retried blindly: a restore, expire or discard whose
outcome is unknown goes to `needs_attention` (reconciliation by a person
with the run's evidence), never to a second execution.

### 5. Results are proofs only as far as the engine's own catalog says so

A run that exited 0 is not a backup: the backup run's outcome is
`succeeded` only when a subsequent `backup.list@1` (a separate read job)
lists the expected label with the expected size floor and WAL coverage
(`architecture.md` §6). A restore run that exited 0 is not a restore: only
`restore.verify@1` decides.

### 6. What this ADR does not allow

- No capability takes a command, script, file path, option string or
  environment from the Control Plane.
- No run outlives its `RuntimeMaxSec`; no run restarts itself.
- No new privilege for the agent: only the helper starts runs; the agent
  forwards verified jobs as today.
- No run may write outside its run directory and, for restores, the
  agent-chosen scratch directory.

## Consequences

- The 60-minute job window, the 15-minute helper cap and every existing
  capability stay unchanged.
- A real host scenario (systemd, a fake engine that runs for minutes, kill
  the helper, the agent and reboot the container) is needed before any
  backup or restore run is used on a real host; until then the
  capabilities are implemented and tested with fakes only.

## Alternatives considered

- **Extend `runSeconds` and the helper cap for backup capabilities**:
  rejected (a lost run would hold the lease for hours; crash semantics
  unclear; affects the shared helper queue).
- **A generic "long run" capability that takes an engine name and
  arguments**: rejected; it is a command runner.
- **Let the engine's own systemd timers run everything (no ExponetDB
  runs)**: kept as the adopted mode (ADR-0036 §3), but manual backups,
  drills and restores need ExponetDB-started runs.
