# ADR-0011: One Operations Engine with immutable, bound plans

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-6, C-7, C-9, C-11, C-12; [`../../02-control-plane/operations-engine.md`](../../02-control-plane/operations-engine.md) |

## Context

Humans in the Web App, programs through REST and AI agents through MCP must
change databases under the same rules. Separate implementations per interface
drift apart; "confirm" dialogs on clients are not controls.

## Decision

Every consequential mutation is an **operation** executed by one engine:
Inspect → Plan → Validate → Authorize → Apply → Verify → Audit. Plans are
immutable, short-lived, single-use and **bound** (target identity and
generation, fingerprint, ledger state hash, policy version, bundle checksums,
actor). Apply re-checks every binding and fails with `PLAN_STALE` on any
change. Action classes (`read`, `low`, `standard`, `high`, `critical`) select
the ceremony: inline plans with precondition tokens for `low`, stored plans and
approvals above. Operations have a state machine with `applyOutcome` and
`verificationOutcome` as separate fields, leases, exclusivity domains and
idempotency keys. Interfaces call the application layer only.

## Alternatives considered

- **Direct execution with confirmation flags.** Rejected: unverifiable, not
  replay-safe.
- **Terraform-style desired state for everything.** Rejected as the general
  model: schema changes with data need ordered, reviewed steps; desired state is
  used where it fits (roles, configuration).

## Consequences

- Agents and humans get the same refusals with the same codes.
- Even small actions carry a plan or precondition token, which costs one extra
  round trip and buys replay safety.
