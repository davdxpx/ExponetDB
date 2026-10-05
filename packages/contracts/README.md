# @exponetdb/contracts

The machine-readable contracts every interface of ExponetDB speaks: Web App,
REST, MCP, SDK, CLI, Control Plane and the Go node agent
([ADR-0018](../../exponetdb-docs/01-architecture/adr/0018-contracts-first.md)).
Zod schemas are the single source; OpenAPI 3.1, JSON Schema and Go types are
generated from them into `generated/` and `agent/node/internal/protocol`.

## Owns

| Module | Contract | Specification |
|---|---|---|
| `errors.ts`, `problem.ts` | stable error catalog (code, HTTP status, retryability, fixed safe message, strict details schema); RFC 9457 problem documents and MCP tool errors | [error-model.md](../../exponetdb-docs/02-control-plane/error-model.md) |
| `permissions.ts` | RBAC permissions (closed, no wildcards) | [authorization.md §2](../../exponetdb-docs/08-auth-and-security/authorization.md#2-permissions) |
| `scopes.ts` | OAuth scopes with permission, tier, MCP eligibility, client kinds, human-only, consent; client kinds | [authorization.md §4](../../exponetdb-docs/08-auth-and-security/authorization.md#4-oauth-scopes) |
| `actions.ts` | action registry: effect, class, mechanism (inline or stored plan), subject, permission and scope rules, client kinds, tier semantics, exclusivity domains, verification | [operations-engine.md §1, §2, §7](../../exponetdb-docs/02-control-plane/operations-engine.md) |
| `manifest/` | `exponetdb.migration/v1`, `exponetdb.project/v1`, inline bundle submission | [migration-bundles.md](../../exponetdb-docs/04-migrations/migration-bundles.md) |
| `rest/` | REST v1 read resources and the read route registry | [REST architecture](../../exponetdb-docs/06-rest-api/architecture.md), [resources](../../exponetdb-docs/06-rest-api/resources.md) |
| `mcp/` | MCP read tools (`exponetdb.mcp/v1`): input and output schemas, annotations, caps, untrusted labels | [tool-catalog.md](../../exponetdb-docs/05-mcp/tool-catalog.md) |
| `node-protocol/` | `exponetdb.node/v1` envelopes (hello, heartbeat, claim, signed job, start, progress, complete, error) | [protocol.md](../../exponetdb-docs/07-node-agent/protocol.md) |
| `common.ts`, `json-schema.ts`, `versions.ts` | ids as kernel brands, timestamps, tiers, freshness, pagination; JSON Schema emission; version identifiers | [versioning.md](../../exponetdb-docs/01-architecture/versioning.md) |

## Does not own

Business logic, authorization decisions, policy evaluation, database access,
network calls, checksums (`@exponetdb/migrations/format`), canonical JSON and
hashing (`@exponetdb/kernel`).

## Allowed dependencies

`@exponetdb/kernel` and `zod`. Never a domain package, never a server, UI or
database library (checked by the boundary checker).

## Rules the tests enforce

- Request, manifest and protocol objects are closed (unknown members refused);
  response objects are open for additive evolution, and Zod strips unknown
  members on output, so nothing unexpected leaks.
- Ids validate with the kernel's own rule and are typed as kernel brands; JSON
  Schema carries the same pattern.
- No wildcard permission; every scope and action references an existing
  permission; `:prod` and `:nonprod` never alias; MCP-ineligible scopes are
  never grantable to `mcp` clients; human-only actions never list `mcp` or
  `ci`; critical actions are human-only.
- Every route and tool names a registered action (`ActionId`), so an
  unregistered mutation cannot be declared; GET routes are pure reads; every
  consequential action is planned and verified (C-6).
- The error catalog, permissions, scopes, operation kinds, routes and tools are
  compared with the documents they come from.
- Database-sourced and caller-supplied text is annotated `untrusted: true`.

## Public exports

Everything from `src/index.ts` (`@exponetdb/contracts`).

## Stability

REST v1 shapes are refined until v1 is declared GA (end of Wave 7); after that
only additive changes. Error codes and scopes are never renamed or reused.
Manifest and protocol versions follow
[versioning.md](../../exponetdb-docs/01-architecture/versioning.md). Generated
files are never edited by hand: change the schema and run `bun run generate`.
