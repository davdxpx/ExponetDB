# @exponetdb/application

The use-case layer of ExponetDB: the only layer the interfaces (REST, the
Web App's `/auth` ceremonies, later MCP and the CLI's server-side
counterparts) call (C-9,
[package-architecture.md](../../exponetdb-docs/01-architecture/package-architecture.md)).
Built in Wave 3A ([G3A record](../../exponetdb-docs/14-roadmap/gates/3a.md)).

## Owns

| Module | What |
|---|---|
| `application.ts` | `Application`: every public method is one use case. Each authorizes through the central engine of `@exponetdb/auth` first (`#authorize`, `#ceremony`, `#plan`, `#decide`), then calls the domain service in one Control Store transaction, then dispatches notifications after commit |
| `views.ts` | the plan and operation views of the REST contract (`PlanView`, `OperationView`), read from the Control Store with fixed shapes |

## Rules

- No business logic of its own: ceremonies, identities, access changes and
  approvals live in `@exponetdb/auth`; plans and operations in
  `@exponetdb/operations`; rules in `@exponetdb/policy`.
- Access changes that raise or remove privileges are plans executed by the
  worker (`role_binding.create`, `role_binding.delete`,
  `policy_settings.update`, `identity.enable`, `identity.erase`); the inline
  ones (`invite`, `reissue`, `disable`) run authorization, policy and audit
  in one transaction.
- Plan creation is idempotent per identity (`Idempotency-Key`, principal
  `idn:<identityId>`).
- A refused apply still commits what the refusal caused (an invalidated
  plan), then raises the refusal.

## Tests

`test/coverage.test.ts` checks structurally that every public use case
passes through the authorization engine and names only contract actions.
The behavior is proven end to end over HTTP against PostgreSQL 17 in
`apps/server/test/http-auth.int.test.ts` and, below this layer, in the
integration suites of `@exponetdb/auth`.
