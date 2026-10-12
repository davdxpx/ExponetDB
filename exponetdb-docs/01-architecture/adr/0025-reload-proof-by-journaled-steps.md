# ADR-0025: A reload is proven by the job's own signed steps, whatever its outcome

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 6 order (Part A, §6); part of the G5 evidence the owner accepts or rejects with G5 |
| Date | 2026-10-12 |
| Related | [ADR-0024](./0024-node-trust-model.md) §4 and §5 (one statement per job, journaled steps); [`../../07-node-agent/control-plane.md` §9.4, §9.5](../../07-node-agent/control-plane.md#94-execution-and-outcomes); [`../../07-node-agent/capabilities.md` §6](../../07-node-agent/capabilities.md#6-confidentiality-of-node-exports-wave-5-correction-f1); [G5 record](../../14-roadmap/gates/5.md) §10.3 rounds 4 to 7; [G6 record](../../14-roadmap/gates/6.md) §2 finding A1 |

## Context

A `postgres.config.apply@2` job with `reload: true` writes the managed
fragment through the root helper and then reloads PostgreSQL. A change that
needs a reload runs only after the reload, and the correction review of
Wave 5 established what proves it (rounds 4 to 7): neither
`pg_file_settings` nor the line `pg_settings` names proves a reload (a
rewrite in place keeps the line number), so only the job's own signed
statement may prove it. The verification therefore accepted the reload
only from a `succeeded` statement.

The owner's host-test logs of 2026-10-10 show the gap:
`agent-capabilities.host.test.ts` kills the agent at the `executed`
boundary (the capability returned, its statement not stored). After the
restart the agent signs the job's one statement from its journal: outcome
`failed`, excerpt `interrupted`, and the steps it journaled
(`check`, `write_fragment` running, `write_fragment` succeeded, `reload`
succeeded). Reconciliation reads the effect from those steps (`applied`),
but the verification saw no `succeeded` statement, could not decide, and
the operation ended `needs_attention / applied / error`, although the
statement it holds says exactly what a succeeded one says about the reload.

The agent journals a step before the next one begins and only after the
step finished (`Run.Step`); `reload` waits until `pg_conf_load_time`
advanced on the agent's own session after `pg_reload_conf()`, which it
issues only after the helper's write returned. The recovered statement is
node-signed (`nr1`) and bound to the job (job id, operation, capability,
arguments hash), like every statement (ADR-0024).

## Decision

1. The capability catalog in `packages/contracts` names, per capability, a
   **reload step** (`reloadStep`, `postgres.config.apply@2`: `reload`): the
   step the agent journals only after PostgreSQL loaded its configuration
   again following the effect. `null` for every other capability. It is
   part of the generated node protocol schema; the Go agent binds its step
   name to it by a test (`TestReloadStepIsTheContracts`) and the step order
   is asserted against PostgreSQL 16, 17 and 18
   (`TestConfigurationThroughTheManagedFragment`).
2. A reload is **proven** for an operation when the latest apply job of the
   operation, of the current major, has a node-signed statement that either
   - succeeded and reports `reloaded: true`, or
   - lists the effect step as `succeeded` and, at a later index, the reload
     step as `succeeded` (any outcome: a statement recovered after a crash
     is `failed`; a job that failed after its reload too).
   Steps are read in their signed index order; a step list that is not
   strictly indexed from 0 proves nothing.
3. Nothing else proves it: no file, no line `pg_settings` names, no load
   time or file time read later, no node `success` without the steps, and
   never a second apply job. Without the proof a change that needs a reload
   stays `error` (`needs_attention`), never `passed`.
4. The steps prove the reload only. The fragment digest a succeeded
   statement reports still decides a withheld value (`held`); a recovered
   statement carries no digest, so a withheld value stays unproven
   (capabilities.md §6).
5. The proof binds the exact job (its signature, its operation, its
   arguments: the plan's changes and cluster), the content (the fresh
   `postgres.config.plan@2` read compares every planned value on the host)
   and the server state (`managed.applied`, `managed.loaded` not `false`,
   no conflict). It adds no host value to any export: steps carry names,
   states and times only.

## Consequences

- A crash after the effect and before the statement was stored ends
  `succeeded / applied / passed` when the host shows the change, without a
  second effect; a crash between the write and the end of the reload stays
  `error` with the change applied, for a person to decide (a `postgres.reload`
  plan).
- No wire message changes; the generated schema gains one metadata field.
  Agents that journal a different step name would no longer prove a
  reload; the Go test pins the name.
- `postgres.reload@2` still verifies from a succeeded statement only (its
  verification needs the reported file errors, which a recovered statement
  does not carry); recorded as a residual in the G6 record.
