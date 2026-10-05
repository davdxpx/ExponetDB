# ADR-0020: No superuser credentials in the Control Plane

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-21, C-23; [`../../03-database-model/credentials-and-roles.md`](../../03-database-model/credentials-and-roles.md) |

## Context

The easiest way to manage PostgreSQL remotely is a superuser login. A Control
Plane holding superuser passwords for every cluster turns any compromise into
total compromise, including file access through `COPY … PROGRAM`.

## Decision

For agent-managed clusters the Control Plane holds only role-specific
credentials over the network:

| Role | Purpose | Key attributes |
|---|---|---|
| `exponetdb_observer` | health, statistics | member of `pg_monitor` |
| `exponetdb_reader` | permitted data reads (`data.read`) | `pg_read_all_data`, `BYPASSRLS` (so reads are never silently empty) |
| `exponetdb_verifier` | running reviewed `verify.sql` checks | `pg_read_all_data`, `BYPASSRLS`, read-only role settings |
| `exponetdb_operator` | cancel and terminate | `pg_signal_backend` |
| `exponetdb_migrator` | migrations | member of the project's execution role with `INHERIT FALSE`, `SET TRUE` |
| `exponetdb_ledger_owner` | owns the `exponetdb` schema | `NOLOGIN` |

Superuser actions (roles, `ALTER SYSTEM`, extensions that need it, restores)
happen **locally** through node capabilities with peer authentication. Passwords
are set as SCRAM verifiers, never as plaintext in SQL.

## Alternatives considered

- **Superuser over TLS with a strong password.** Rejected: blast radius.
- **One ExponetDB role for everything.** Rejected: least privilege per path.

## Consequences

- External clusters (no agent) offer fewer capabilities, reported as
  `CAPABILITY_UNAVAILABLE`.
- Role desired state is managed by the node, because roles are cluster-wide.
