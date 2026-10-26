# Architecture decision records

Fundamental decisions that are expensive to reverse. Each record states the
context, the decision, the alternatives that were considered and the
consequences. Smaller decisions live in the topic documents with a
**[DECIDED]** marker.

| Status values | Meaning |
|---|---|
| Accepted (baseline) | part of the Wave 0 baseline; confirmed or changed at the Wave 0 gate |
| Accepted | confirmed by the owner |
| Proposed | written during a wave; in force for that wave's work, confirmed or changed by the owner at the wave's gate |
| Superseded by ADR-n | replaced; kept for history |

A new ADR gets the next number and is never renumbered. An ADR that changes a
constitution article follows the amendment rule in
[`../../00-product/constitution.md`](../../00-product/constitution.md#amendments).

| ADR | Title | Main documents |
|---|---|---|
| [0001](./0001-own-repository.md) | ExponetDB lives in its own repository | [repositories-and-boundaries](../repositories-and-boundaries.md) |
| [0002](./0002-control-plane-data-plane.md) | Control Plane and Data Plane are separate | [control-plane-and-data-plane](../control-plane-and-data-plane.md) |
| [0003](./0003-postgresql-only-v1.md) | PostgreSQL only in V1 | [vision-and-scope](../../00-product/vision-and-scope.md) |
| [0004](./0004-logical-targets.md) | Logical targets as stable identities | [domain-model](../domain-model.md) |
| [0005](./0005-own-control-store.md) | ExponetDB has its own Control Store | [control-database](../../02-control-plane/control-database.md) |
| [0006](./0006-ulid-migration-ids.md) | Migration ids are ULIDs | [migration-bundles](../../04-migrations/migration-bundles.md) |
| [0007](./0007-migration-bundles.md) | Migrations are bundles with manifest, up, verify, down | [migration-bundles](../../04-migrations/migration-bundles.md) |
| [0008](./0008-migration-dag.md) | Order comes from a dependency graph | [dependency-graph](../../04-migrations/dependency-graph.md) |
| [0009](./0009-checksum-semantics.md) | Checksums bind executable content, versioned | [migration-bundles §3](../../04-migrations/migration-bundles.md#3-checksum-semantics) |
| [0010](./0010-schema-fingerprint.md) | Schema fingerprints over a canonical document | [schema-fingerprints](../../03-database-model/schema-fingerprints.md) |
| [0011](./0011-plan-apply-operations-engine.md) | One Operations Engine with immutable bound plans | [operations-engine](../../02-control-plane/operations-engine.md) |
| [0012](./0012-staging-before-production.md) | Staging evidence before production | [staging-production-policy](../../04-migrations/staging-production-policy.md) |
| [0013](./0013-in-target-ledger.md) | The ledger lives in the target database | [ledger](../../04-migrations/ledger.md) |
| [0014](./0014-node-agent-outbound-mtls.md) | Node agent: outbound mTLS, signed jobs, capabilities, no shell | [07-node-agent](../../07-node-agent/architecture.md) |
| [0015](./0015-oauth-protected-mcp.md) | MCP protected by ExponetDB's own OAuth authorization server | [05-mcp/oauth](../../05-mcp/oauth.md) |
| [0016](./0016-identity-federation.md) | External identity authenticates, ExponetDB authorizes | [federation](../../08-auth-and-security/federation.md) |
| [0017](./0017-supabase-reuse-strategy.md) | Supabase is a reference, not a dependency | [supabase-reference-audit](../../11-ui/supabase-reference-audit.md) |
| [0018](./0018-contracts-first.md) | Contracts first, interfaces generated | [package-architecture](../package-architecture.md) |
| [0019](./0019-process-roles-and-web-app.md) | One image, three process roles, SPA Web App | [overview](../overview.md), [deployment](../../12-operations/deployment.md) |
| [0020](./0020-no-superuser-in-control-plane.md) | No superuser credentials in the Control Plane | [credentials-and-roles](../../03-database-model/credentials-and-roles.md) |
| [0021](./0021-libpg-query-parser.md) | Server-side SQL classification with libpg_query | [analysis](../../04-migrations/analysis.md), [sql-execution-security](../../03-database-model/sql-execution-security.md) |
| [0022](./0022-opaque-tokens.md) | Opaque access tokens, rotating refresh tokens | [05-mcp/oauth](../../05-mcp/oauth.md) |
| [0023](./0023-audit-chain-hash-ac1.md) | Audit chain hash `ac1`, enforced by the database | [audit §4](../../02-control-plane/audit.md#4-immutability-and-integrity) |
| [0024](./0024-node-trust-model.md) | Node trust model: anchored job keys, bound node keys, sealed payloads, job identity and time | [07-node-agent](../../07-node-agent/security.md), [G5 record](../../14-roadmap/gates/5.md) |
| [0025](./0025-reload-proof-by-journaled-steps.md) | A reload is proven by the job's own signed steps, whatever its outcome | [07-node-agent/control-plane](../../07-node-agent/control-plane.md), [G6 record](../../14-roadmap/gates/6.md) |
| [0026](./0026-cli-step-up-browser-handoff.md) | A person's CLI steps up through a bound, single-use browser receipt | [08-auth-and-security/authorization](../../08-auth-and-security/authorization.md), [G6 record](../../14-roadmap/gates/6.md) |
| [0027](./0027-mcp-protocol-layer.md) | The MCP protocol layer: the official TypeScript SDK inside ExponetDB-owned edges | [05-mcp/protocol-baseline](../../05-mcp/protocol-baseline.md), [G7 record](../../14-roadmap/gates/7.md) |
| [0028](./0028-data-read-lane.md) | Data reads run in the worker through a sealed lane; `dataRead` is a policy rule per target | [sql-execution-security](../../03-database-model/sql-execution-security.md), [G7 record](../../14-roadmap/gates/7.md) |
| [0029](./0029-approval-link-from-mcp.md) | The approval link from an MCP conversation is the existing approvals page, hardened | [05-mcp/architecture](../../05-mcp/architecture.md), [G7 record](../../14-roadmap/gates/7.md) |
| [0030](./0030-supabase-ui-source-adoption.md) | Adoption of Supabase UI source for the Web App (amends C-2 and ADR-0017) | [third-party-register](../../11-ui/third-party-register.md), [design-system](../../11-ui/design-system.md) |
| [0031](./0031-web-app-serving.md) | Serving the Web App: SPA fallback, hashed immutable assets, precompression | [threat-model](../../08-auth-and-security/threat-model.md), [deployment](../../12-operations/deployment.md) |
| [0032](./0032-web-app-browser-transport.md) | The Web App's browser transport: a cookie client over the SDK's operations table | [sdk](../../13-integrations/sdk.md), [threat-model](../../08-auth-and-security/threat-model.md) |
| [0033](./0033-provider-glyphs-from-simple-icons.md) | Provider brand glyphs copied from Simple Icons (CC0-1.0, pinned version, register) | [third-party-register](../../11-ui/third-party-register.md#other-sources), [design-system](../../11-ui/design-system.md) |
| [0034](./0034-execution-roles-for-adopted-schemas.md) | Execution roles for adopted schemas: a declared `BYPASSRLS` exception and per-environment bindings (amends credentials-and-roles §3) | [credentials-and-roles](../../03-database-model/credentials-and-roles.md), [Wave 9 Part A record](../../14-roadmap/gates/9-part-a.md) |
| [0035](./0035-studio-information-architecture.md) | A project level (`/projects`, `/p/<product>/<project>`), a contextual Connect sheet (`?connect=`) and paged migration views (`?view=`) in the Web App (proposed) | [information-architecture](../../11-ui/information-architecture.md), [PRE-WAVE-11-REVIEW](../../14-roadmap/PRE-WAVE-11-REVIEW.md) |
