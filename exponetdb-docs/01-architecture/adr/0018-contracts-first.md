# ADR-0018: Contracts first, interfaces generated

| | |
|---|---|
| Status | Accepted (baseline) |
| Date | 2026-10-04 |
| Related | C-9, C-33; [`../package-architecture.md`](../package-architecture.md), [`../versioning.md`](../versioning.md), [`../../13-integrations/sdk.md`](../../13-integrations/sdk.md) |

## Context

The Web App, REST, MCP, CLI, SDK and the Go node agent must agree on shapes,
error codes, permissions and protocol envelopes. Hand-written duplicates drift.

## Decision

`packages/contracts` (Zod) is the single source for: REST resources, the error
catalog, permissions and scopes, the action registry, MCP tool input and output,
node protocol envelopes and the migration manifest schema. From it, CI generates
OpenAPI 3.1, JSON Schema and Go types, and fails if committed artifacts are out
of date. `@exponetdb/sdk` is generated types plus a thin hand-written client.
Cross-language behavior (canonical JSON, checksums, signatures) is pinned by
golden vectors.

## Alternatives considered

- **OpenAPI-first with code generation into TypeScript.** Viable; Zod-first
  chosen because the server validates with the same schemas it publishes.
- **Hand-written clients.** Rejected: drift.

## Consequences

- Wave 1 exists to build the contracts before features.
- Every interface change starts with a contract change and its doc.
