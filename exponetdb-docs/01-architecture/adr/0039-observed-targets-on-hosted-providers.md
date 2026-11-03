# ADR-0039: Observed targets on hosted providers: no marker, identity by cluster and database oid, reads through a session pooler

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 10 order (2026-11-03, W10-D3, W10-D4) |
| Date | 2026-11-03 |
| Builds on | [`../../02-control-plane/registry.md`](../../02-control-plane/registry.md) §1 and §2.2, [`../../03-database-model/postgres-adapter.md`](../../03-database-model/postgres-adapter.md) §3, [ADR-0034](./0034-execution-roles-for-adopted-schemas.md), OD-7b |
| Related | [G10 record](../../14-roadmap/gates/10.md), [Wave 10 order](../../14-roadmap/orders/wave-10-order.md) W10-1, W10-2 |

## Context

Wave 10 must observe REOSA production while it still runs on a hosted
provider (Supabase), and OD-7b forbids any apply there before Wave 11. Three
facts of the installation, measured on 2026-11-03, rule out the normal
external-cluster path ([`onboard-external-cluster.md`](../../12-operations/onboard-external-cluster.md)):

1. **Registration writes.** `target.register` stamps the identity marker and
   creates the `exponetdb` schema in the same operation (registry.md §2.2);
   a marker would be a write on production and would travel with the dump
   into the Wave 11 cutover.
2. **Only a pooler is reachable.** The provider's direct host has only an
   IPv6 address; the Control Plane's containers have no IPv6 route
   (`ENETUNREACH`). The provider's session pooler (Supavisor, port 5432,
   TLS from the provider's root CA) is reachable. Today a cluster needs a
   direct endpoint (`planClusterRegister`), and only the health probe ever
   connects through a pooler.
3. **The pooler routes by the login name.** It expects
   `<role>.<project-ref>`; the server-side `session_user` is the plain role.
   `ROLE_NAMES` builds the login from the role only.

The provider's `postgres` role is not a superuser but may create roles and
grant `pg_monitor` (`admin_option`), and may execute `pg_control_system()`.

## Decision

### 1. A target has a mode: `managed` (today) or `observed`

`registry.targets.mode` (new, immutable, default `managed`). An `observed`
target is registered by a new path of `target.register`
(`mode: observed`) that:

- needs the **observer credential only** (no migrator, no ledger owner);
- records the target and its placement, takes the registration schema
  snapshot (the drift reference) as the observer, and **writes nothing to
  the database**: no marker, no `exponetdb` schema, no ledger;
- leaves the target in state `registered` for its whole life. An observed
  target is never `active`; the state machine refuses `observed → active`.
  It ends by `decommissioned`. Wave 11 registers the moved database as a new
  `managed` target; the observed one is decommissioned then.

### 2. Identity of an observed target: cluster identifier and database oid

The marker check (`requireIdentity`) is replaced for observed targets by:
the cluster's pinned `system_identifier` (already a session guard) **and**
the database oid recorded at database registration, compared on every
observer session. A mismatch is `TARGET_IDENTITY_MISMATCH` with
`details.reason: database_oid` (the reason VC-071 introduced). The marker
stays mandatory for every write path; nothing about writes changes.

### 3. What an observed target allows

| Path | Observed target |
|---|---|
| Health sampling, probes, named conditions | yes; the identity probe uses §2; an observed target is never suspended by health (it is not active), a mismatch is a critical finding |
| Catalog reads: schema inspect, fingerprint, drift check (on demand and scheduled), table and statement statistics, sessions and locks | yes, as observer |
| Data reads (`data.read`), raw statements | **no** (reader role absent; `TARGET_OBSERVED_ONLY`) |
| Migration status | the legacy ledgers only, when the observer may read them; the ExponetDB ledger is absent (`ledger: none`) |
| Any plan that writes (migrations, diagnostics actions, roles, node) | refused at plan time with `TARGET_OBSERVED_ONLY` (409, not retryable) |

`TARGET_OBSERVED_ONLY` is a new error code (additive contract change).

### 4. Pooler endpoints carry a login suffix; a cluster may be reachable through a session pooler only

- `registry.endpoints.login_suffix` (new, nullable, immutable): allowed only
  for `kind = pooler`, `^[a-z0-9]{1,40}$`. The login of a session through
  such an endpoint is `exponetdb_<role>.<suffix>`; the session still checks
  the server-side identity (superuser refusal, `system_identifier`,
  database name and, for observed targets, oid). Credential verification
  compares the server-side `session_user`, so it is unaffected.
- A cluster may be registered with **session-mode pooler endpoints only**.
  Such a cluster serves observer (and reader) sessions only: every other
  role is refused as today (`INTERNAL` guard in `connect.ts`, now with
  `CLUSTER_POOLER_ONLY` as reason). Connection order: direct endpoints
  first, then session poolers, never a transaction pooler for a session
  ExponetDB opens itself.

### 5. Bootstrap SQL for a non-superuser administrator

`cluster bootstrap-sql --roles observer` emits only the observer's role,
its `pg_monitor` membership, its settings that a non-superuser may set, and
`CONNECT` on the named databases. The statement list is what the owner
approves before it runs on a hosted production database (W10-D4).

## Consequences

- REOSA production can be observed with one role on the provider and no
  other change there; the observed snapshot becomes the comparison source
  for the Wave 11 rehearsal (fingerprint and ACL equality).
- Two additive Control Store columns, one new error code, one new request
  field; frozen bundles and contracts are untouched (the guard functions
  are replaced by a new bundle).
- A pooler hop hides the client side of TLS from `pg_stat_ssl`: the session
  checks TLS of the pooler-to-server hop as today, while the Control Plane
  side is verified by `verify-full` against the endpoint's CA. Recorded as a
  residual, as for the existing health probe through poolers.

## Alternatives considered

- **Stamp the marker on hosted production** (W10-D3 (b)): refused by the
  owner; a write, and the marker would be copied into the cutover dump.
- **Observe without a registry record** (ad-hoc reads): no health history,
  no drift reference, no audit trail; contradicts truthful reads.
- **Enable IPv6 in the Control Plane's network** to reach the direct host:
  an infrastructure change on `reos-01` outside this wave; the pooler path
  is needed anyway for providers without a direct address.
