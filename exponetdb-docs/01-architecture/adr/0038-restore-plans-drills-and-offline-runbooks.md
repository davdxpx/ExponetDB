# ADR-0038: Restore plans bind source, destination and identity; drills run on scratch only; the offline runbook is generated without secrets

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 9 Part B order (2026-10-26, §6); execution stays disabled until the evidence listed in [`PRE-WAVE-11-REVIEW.md` W9-02](../../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-02-manual-test-matrix) exists |
| Date | 2026-10-26 |
| Builds on | [`../../09-backups-and-restore/restore.md`](../../09-backups-and-restore/restore.md) (Wave 0, accepted), C-35, threat T19 |
| Related | [ADR-0036](./0036-backup-repositories-and-providers.md), [ADR-0037](./0037-durable-long-running-node-capabilities.md), [ADR-0011](./0011-plan-apply-operations-engine.md) |

## Context

`restore.md` decided the shape (purposes drill, clone, recovery; no
in-place restore; destination chosen and shown; human-only execution). It
left open how a plan binds what it restores and where, how a drill is
selected and measured, and how the C-35 runbook is produced. Restores are
the most dangerous operation ExponetDB will have: the wrong source, the
wrong destination or a stale catalog destroys data or proves nothing.

## Decision

### 1. A restore plan is a stored, bound plan; every binding is checked again at apply

`restore.plan` (record action, `restore.plan` permission, agents allowed)
creates an operation plan of kind `restore.execute` whose content holds:

| Binding | Checked at plan | Checked again at apply (under the cluster's restore lock) |
|---|---|---|
| Source repository id, revision, ownership, reconciliation time | reconciled within 10 minutes | same revision; reconciled within 10 minutes |
| Base backup id, engine label, **verification digest**, `system_identifier`, timeline, PostgreSQL major, engine version | backup `verification = passed` | same digest; the engine catalog still lists the label (fresh `backup.list@1`) |
| Requested point in time or LSN, resolved WAL range `[walFrom, walTo]` and timeline | WAL coverage continuous over the range, on that timeline | the same coverage (no gap appeared, timeline unchanged) |
| Destination: kind (`scratch` for drills; `new_cluster` for recovery), node id, the node's cluster report digest, an **agent-chosen** path under the node's scratch root and a localhost port | `restore.prepare@1` returns the path, free space, engine readability and that the path is not a registered cluster's data directory | `restore.prepare@1` again: same node, same path still free, same space class; the destination is not the data directory of any running or registered cluster (realpath, no symlinks, under the allowlisted root) |
| Destination identity for recovery: the target the recovery is for, its generation and marker | the target exists and is the source cluster's | same generation (any change → `PLAN_STALE`) |
| Engine can read the backup; encryption key reference available on the node | `engineCanRead` | again |
| Purpose and tier | drill: always scratch; recovery: `critical`; clone: **out of scope** (refused, `restore.clone-masking` not built) | same |

A failed check at plan time stores the plan as `deny` with the reason; it
cannot be applied. Any change at apply → `PLAN_STALE`; nothing has run.

### 2. Who may execute

- `restore.execute` is **human only** in V1 (`restore.human-only`, the
  `restore.execute` scope is human-session-only in the frozen scope
  catalog). An agent's restore plan is stored and shown with decision
  `deny` and the full analysis; a person re-plans it as themselves.
- Recovery is `critical`: fresh re-authentication, an approval (OD-9
  self-approval rules for `critical`), and a typed confirmation of the
  destination and the affected target's path (T19).
- No MCP tool applies a restore; `restore_plan` over MCP plans only.
- **Activation gate:** execution additionally requires the installation
  setting `EXPONETDB_RESTORE_EXECUTION` (`disabled` by default; `scratch`
  allows drills on scratch; `all` adds recovery). Until the owner's
  pre-Wave-11 drills passed, the setting stays `disabled` on every real
  installation; the gate is a server-side refusal (`FEATURE_NOT_ACTIVATED`),
  not a UI hint.

### 3. No in-place restore; recovery builds a new copy; promotion is separate

`restore.execute@1` on the node refuses a destination that is, contains, or
is contained in the data directory, tablespace or WAL directory of any
PostgreSQL instance on the host, and any path outside its scratch root. A
recovery restores into a new directory and a temporary cluster on a
localhost port; the switch of the target is a **separate** human `critical`
plan (placement move, a new target generation, the marker re-stamped),
made only after `restore.verify@1` passed. The old cluster is kept until a
person discards it in a later operation.

### 4. Drills

- Destination: scratch only, localhost-only, non-default port, discarded by
  `restore.discard@1`; a drill is `passed` only after verification **and**
  discard; a scratch cluster older than 24 hours is a finding.
- Selection rotates: `latest` (newest verified full), `older` (a verified
  backup older than the newest, inside retention), `pitr_random` (a random
  instant inside the verified continuous WAL window, at least 5 minutes
  before its end), and across repositories (each repository at least once
  per cadence). The random instant is drawn by the worker and bound in the
  plan, so the drill is reproducible.
- Verification (`restore.verify@1`): recovery target reached (replay LSN and
  time on the planned timeline); simple and extended-protocol probes;
  `amcheck` (`bt_index_check`) where the extension is available, otherwise
  recorded `not_run`, never `passed`; schema fingerprint equal to the source
  target's fingerprint at that time (or recorded as the new baseline
  evidence when the history has none); ledger head equal to the Control
  Store mirror for that time; row counts of configured tables within bounds.
  Each check's result is `passed`, `failed`, `not_run` or `error`; the drill
  is `passed` only if every configured check passed.
- **Measured RTO** is taken only from passed drills (restore + recovery +
  verification), with its date; failed or aborted drills never feed it.

### 5. RPO

The achievable RPO is `now − latest archived WAL time` of the best
repository whose archive status is healthy and whose WAL coverage was
reconciled within 10 minutes; otherwise `now − finishedAt` of the newest
**verified, off-host** backup; otherwise `unknown`. Clock uncertainty is
the larger of the node's reported skew and the reconciliation age, and is
returned with the value; a value with an uncertainty above the objective is
`unknown`, never green.

### 6. The C-35 offline runbook

`GET /clusters/{id}/restore-runbook?repository=bkr_…` renders a plain POSIX
shell script and a short README from the **current** repository record
(engine, pinned version, provider endpoint, bucket, prefix, stanza, repo
index, cipher) with **placeholders** for every secret (`${PGBR_CIPHER_PASS}`
read from a file the operator supplies from the offline material, the
storage key pair likewise). It:

- contains no secret, no token and no ExponetDB address; it needs no
  ExponetDB process;
- restores into a fresh directory chosen by the operator, refuses an
  existing non-empty directory, starts PostgreSQL on a localhost port, and
  prints the checks to run (recovery target, `amcheck`, row counts);
- is generated deterministically (same record → same bytes, with the record
  revision and a digest in its header), so the owner can file it with the
  offline keys and see when it is outdated;
- is audited when downloaded (who, which repository revision, digest).

The C-35 drill itself (Control Plane stopped, offline keys, a disposable
host) is the owner's test T-C35-1; until it ran, C-35 is `NOT PROVEN`.

## Implementation and review (Wave 9 Part B, 2026-10-27)

**[DECIDED]** (as built after the security reviews C-1 to C-11 and B-4)

- **A restored server runs no restored code.** The node and the C-35
  runbook start a restored cluster with command-line settings, the only
  place that wins over the restored `postgresql.auto.conf`. They allow no
  preloaded library, no logical replication or other background worker, no
  WAL sender, no archiving, no TCP listener beyond localhost (the node: a
  socket only), and no hot standby (PostgreSQL then does not compare these
  settings with the source's). A restored subscription therefore never
  reaches its publisher. This was reproduced in review: before the fix, a
  drill advanced a real publisher's slot.
- **Limit:** the scratch postmaster keeps network access, because its
  `restore_command` fetches WAL in the same process tree.
- **The runbook waits for the end of recovery.** It keeps its
  configuration beside the cluster (`TARGET_DIR.exponetdb`), because the
  restored server names it in `restore_command` until recovery has ended.
  It then prints the replayed position. Reproduced in review: a temporary
  configuration removed on exit cut recovery short and lost data with exit
  code 0.
- **The replay must reach the WAL the plan counted on.** A restore to the
  end of the archive whose replay stops before the plan's bound WAL end
  fails `recovery_target_reached`.
- **Apply re-checks the WAL range.** The bound WAL end must still be
  listed, and a point in time must still lie in the window.
- **A recovery is bound to the target.** The plan binds the target's
  placement and generation. A recovery also holds the target's
  `maintenance` domain beside `cluster:<id>:backup`.
- **A lost worker never leaves a run open.** Reconciliation binds the run
  row to its start job, ends a run that never started, and asks the node
  for a start whose statement was lost.
- **Discarding a recovered cluster** is `high` and needs a person's
  approval (`restore.recovery-discard-approval`).
- **An offline attestation** must name the digest of the repository's
  current runbook. The runbook itself needs the location permission
  (`registry.manage`), like the repository list.

## Consequences

- A restore cannot silently use another backup, timeline, node or path than
  the person approved; a stale catalog fails the apply.
- Restores stay off on real installations until the owner turns the setting
  on after the drills; planning, drills on a lab and the runbook work now.

## Alternatives considered

- In-place restore for speed: rejected (C-35, T19; `restore.md` §1).
- Agent-applied drills: rejected for V1 (scope `restore.execute` is
  human-only and frozen); the scheduler may propose drills as plans.
