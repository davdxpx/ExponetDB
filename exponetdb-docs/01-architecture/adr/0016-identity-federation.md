# ADR-0016: External identity authenticates, ExponetDB authorizes

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | [`../../08-auth-and-security/federation.md`](../../08-auth-and-security/federation.md), OD-10 |

## Context

An Exponet identity service (`auth.exponet.cloud`) is planned but does not
exist. ExponetDB must start with local accounts without blocking a later
single sign-on.

## Decision

- V1 uses **local identities** (passkeys + TOTP, no self-signup).
- Later, ExponetDB federates **login** via OpenID Connect. The mapping is explicit
  `(issuer, sub) → identity`, linked by an admin or by the person with
  re-authentication; **no just-in-time provisioning**; e-mail is not an
  identifier.
- Upstream claims (groups, roles) **never** grant ExponetDB permissions; roles,
  bindings, scopes and grants stay in ExponetDB.
- At least one owner keeps a local credential so an identity-service outage
  cannot lock everyone out.
- The data model ships in V1 (`identity_providers`, `external_subjects`).

## Alternatives considered

- **Group-claim-driven authorization.** Rejected: authorization would move to a
  system that does not understand database risk.
- **Wait for the identity service.** Rejected: blocks the product.

## Consequences

- Federation is configuration plus one integration, not a schema change.
- Disabling a person upstream ends their sessions; disabling them in ExponetDB is
  independent and immediate.
