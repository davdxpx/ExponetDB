# ADR-0014: Node agent with outbound mTLS, signed jobs and capabilities, never a shell

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-21, C-22; [`../../07-node-agent/architecture.md`](../../07-node-agent/architecture.md), [`../../07-node-agent/security.md`](../../07-node-agent/security.md) |

## Context

Some database operations need the host: configuration changes that need a
restart, `pg_hba`, TLS certificates, packages, backups, restores into scratch
directories. Giving the Control Plane SSH or superuser access would make it the
most dangerous credential in the estate.

## Decision

- A node agent runs on each database host as an **unprivileged daemon** plus a
  **root helper** reachable only over a local Unix socket with typed operations
  and allowlists.
- The agent connects **outbound** over HTTPS/2 with **mutual TLS** to the
  gateway (private network, V1), long-polls for jobs, and never listens on a
  network port.
- Jobs are **signed** (Ed25519) by the worker's job-signing key, bound to the
  node, time-limited and replay-protected by a local journal.
- The agent exposes **versioned capabilities** (`postgres.config.apply@1`,
  `backup.run@1`, …). There is no capability that executes arbitrary commands,
  shell snippets or SQL text from the Control Plane.
- Enrollment uses a single-use 30-minute token with a pinned root fingerprint;
  client certificates last 72 hours; the root CA key is offline.

## Alternatives considered

- **SSH from the Control Plane.** Rejected: a shell is unlimited capability.
- **Inbound agent API.** Rejected: opens a port on every database host.
- **Superuser over the network.** Rejected (ADR-0020).

## Consequences

- Every host operation must be designed as a capability with plan and verify
  steps, which is slower to add and safer to run.
- A compromised Control Plane can only invoke allowlisted capabilities, within
  their parameters.
