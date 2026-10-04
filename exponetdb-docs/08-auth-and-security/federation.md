# Federation (future Exponet identity)

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval; implementation after the Exponet identity service exists (not part of ExponetDB) |
| Applies to | Wave 3 (data model ready), later wave (integration) |
| Read before | [`identity.md`](./identity.md), [`authorization.md`](./authorization.md) |
| Decision | [ADR-0016](../01-architecture/adr/0016-identity-federation.md) |

## 1. Target picture

```
auth.exponet.cloud  (Exponet Identity, separate repository and product)
        │  OpenID Connect (authorization code + PKCE), ID token, optional back-channel logout
        ▼
ExponetDB  ("Sign in with Exponet")
   identity mapping:  (issuer, sub) ──▶ idn_…
   authorization:     ExponetDB roles, bindings, scopes, grants, policies (unchanged)
```

> Exponet Identity authenticates the person. ExponetDB authorizes the person.

**[DECIDED]**

- External identity providers **authenticate** only. Group claims, role claims or
  any other claim never grant ExponetDB roles, permissions or scopes. Role
  bindings stay in ExponetDB, managed by ExponetDB admins.
- Mapping is explicit: an `external_subject (provider, issuer, sub)` is linked to
  an existing ExponetDB identity by an admin, or by the identity itself while
  logged in locally (account linking with re-auth). **No just-in-time
  provisioning**: an unknown `sub` cannot log in.
- E-mail addresses are not identifiers (they change, they can be reassigned);
  `(issuer, sub)` is.
- ExponetDB remains the **OAuth authorization server for ExponetDB resources**
  (MCP and REST tokens). The upstream IdP is used when ExponetDB's AS needs to
  authenticate the user; the consent, grants and scopes stay in ExponetDB.
  Alternative considered: the central identity service as the AS for all Exponet
  resources. Rejected for now, because it would move consent and scope semantics
  out of the product that understands them; revisit when several Exponet
  products need a common consent model ([OD-10](../00-product/open-decisions.md#od-10-future-identity-architecture)).

## 2. Assurance

- ExponetDB requires an authentication context from the IdP that proves
  multi-factor authentication (`acr`/`amr` values agreed with the Exponet identity
  service) for login, and a fresh authentication (`max_age`, `prompt=login` or
  equivalent) for step-up actions (re-auth windows in [`identity.md` §4](./identity.md#4-re-authentication-step-up)).
- If the IdP cannot provide the required assurance, ExponetDB falls back to its
  own second factor for step-up (passkey/TOTP registered locally).

## 3. Lifecycle

- **Disable upstream**: back-channel logout (if offered) or session expiry ends
  ExponetDB sessions; ExponetDB also re-checks the upstream session at most every
  12 hours. Disabling a person in ExponetDB is independent and immediate.
- **Local accounts remain**: at least one owner keeps a local credential
  (passkeys) so that an outage of the identity service does not lock everyone out
  of the control plane (C-5 spirit: the control plane must not depend on what it
  might need to repair).

## 4. Data model readiness (V1)

V1 ships the tables (`identity_providers`, `external_subjects`) and the login
flow abstraction (local or OIDC) with only `local` enabled, so that adding the
provider later is configuration plus one integration, not a schema change.

## 5. Out of scope

- ExponetDB does not become an identity provider for other products.
- PostgreSQL 18's OAuth authentication for database logins (`pg_hba` method
  `oauth` with validator modules) is noted as a possible future way for people to
  log in to databases with Exponet identities; it is not part of V1 and would be
  a node capability plus registry configuration, never a replacement for
  ExponetDB's own access control.
