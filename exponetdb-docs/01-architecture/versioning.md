# Versioning and compatibility

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05; MCP rows and §6 updated on 2026-10-13 for Wave 7 (G7 not yet accepted, [G7 record](../14-roadmap/gates/7.md)) |
| Applies to | Wave 1 onward |
| Read before | [`package-architecture.md`](./package-architecture.md) |

Every contract is versioned from day one
([C-33](../00-product/constitution.md#c-33-every-contract-is-versioned)), and every
version field has a rule for what changes it and what readers do with it. A
version field without an upgrade concept is not added.

## 1. Overview

| Contract | Version format | Where | Breaking change means | Compatibility promise |
|---|---|---|---|---|
| REST API | path major: `/api/v1` | URL | `/api/v2` alongside v1 | v1 supported ≥ 12 months after v2 GA; additive changes within v1. **GA of `/api/v1` is not declared** (a readiness report exists, [`../06-rest-api/ga-readiness.md`](../06-rest-api/ga-readiness.md); the owner decides); until then breaking changes are allowed with notice ([`../06-rest-api/architecture.md` §9](../06-rest-api/architecture.md#9-versioning)) |
| SDK `@exponetdb/sdk` | SemVer | npm | major bump | SDK major N targets REST v N; minor = additive. It covers `/api/v1` only, not `/mcp`; `1.0.0-alpha.1` while GA is not declared |
| MCP tool schemas | per tool `toolVersion` (an integer, starting at `1`, raised by any change to the announced definition, pinned per digest; §6) in the tool's `_meta` key `cloud.exponet.db/toolVersion`; catalog version `exponetdb.mcp/v1` in the `_meta` of `tools/list` (`cloud.exponet.db/catalog`, with `cloud.exponet.db/catalogDigest`) | tool metadata | new tool name (`*_v2`) or catalog v2 | removed tools keep answering with a deprecation error for 6 months **[PLANNED]** (no tool has been removed; the answer is not built) |
| MCP protocol | spec revision named per request (modern `_meta` envelope and `MCP-Protocol-Version` header) or by `initialize` (legacy) | protocol | n/a (spec-defined) | `POST /mcp` serves 2026-07-28 (modern) and 2025-11-25 and 2025-06-18 (legacy) concurrently, statelessly; named in the `MCP-Protocol-Version` header, `2025-03-26` and `2024-11-05` are refused with the served versions named. **ExponetDB's own promise (owner decision 3, 2026-10-12), not the specification's:** legacy is removed no earlier than twelve months after ExponetDB announces it and only after the clients in use support the modern revision (checked against [the client matrix](../05-mcp/client-matrix.md)). The specification sets no sunset date for a revision |
| Node protocol | `exponetdb.node/v<major>` + agent SemVer | handshake | new major | control plane supports current and previous major; agent refuses to run against a control plane that does not support its major |
| Capability | `name@major` (e.g. `postgres.config.apply@1`) | capability report | new major of that capability | control plane uses the highest major both sides support; jobs name the major |
| Migration manifest | `exponetdb.migration/v<major>` | `migration.yaml` | new major | engine reads every major it ever supported (history must stay readable) |
| Role manifest | `exponetdb.roles/v<major>` | `exponetdb.roles.yaml` | new major | same |
| Project config | `exponetdb.project/v<major>` | `exponetdb.project.yaml` | new major | current and previous |
| Checksum canonicalization | `c<n>` in the value | stored checksums | new `c<n+1>` | old values never re-hashed; comparisons use the stored canonicalizer |
| Fingerprint canonicalization | `fp<n>` in the value | fingerprints | new `fp<n+1>` | values of different versions are "not comparable" |
| Ledger state hash | `ls<n>` | plans, mirrors | new `ls<n+1>` | same |
| Plan hash | `sha256:<hex>` over RFC 8785 JCS of the binding members ([`../02-control-plane/operations-engine.md` §3.1](../02-control-plane/operations-engine.md#31-content)) | plans, approvals, audit | a new construction needs a new value prefix through an ADR | plans are short-lived; recorded hashes are never recomputed with another construction |
| Audit event | `exponetdb.audit/v<major>` in the `schema` member | every stored event | new major | every major ever written stays readable and verifiable; events are never rewritten |
| Audit chain hash | `ac<n>` in the value (`sha256:ac1:…`), genesis `ac<n>:genesis:<installation id>` | stored events, checkpoints | new `ac<n+1>` through an ADR ([ADR-0023](./adr/0023-audit-chain-hash-ac1.md)) | stored hashes are never recomputed; a chain records where a new construction starts |
| Secret envelope | `exponetdb/secret/v<n>` and `exponetdb/data-key/v<n>` in the associated data (`se1` = v1; constants in `packages/secrets`, not a wire contract; golden vectors `tooling/golden/secret-envelope.json`) | stored ciphertext and wrapped data keys | new AAD version, new vectors | every version ever written stays decryptable; re-encryption only through a new secret version |
| Keyring | `exponetdb.keyring/v<major>` in the `format` member (`packages/secrets`) | `EXPONETDB_KEYRING`, keyring files | new major | the server reads the current and the previous major |
| Policy version | `pv<n>` in the value (`sha256:pv1:…`) ([`../02-control-plane/policy-engine.md` §5.1](../02-control-plane/policy-engine.md#51-policy-version-pv1)) | plans, approvals, audit | new `pv<n+1>` | recorded versions are never recomputed with another construction |
| Canonical JSON | RFC 8785 (JCS), fixed | every hash or signature over JSON | n/a: the RFC is fixed | golden vectors pin it in TypeScript and Go |
| Target ledger schema | `ledger_schema_version` integer | `exponetdb.ledger_meta` | n/a: additive-only upgrades by the engine | engine upgrades ledgers forward automatically under the schema lock |
| Control Store schema | migration ledger head | Control Store | n/a: expand/contract across releases | server binary N runs on schema N; N-1 binary runs on schema N (rollback window of one release) |
| Error codes | stable strings | contracts | never renamed or reused | deprecated codes keep working |
| OAuth scopes | stable strings | contracts | never renamed; new scopes added | deprecated scopes map to replacements for 12 months |
| Plan kinds | `kind` + `kindVersion` | plans | `kindVersion` bump | plans are short-lived; no migration of plan bodies, old versions simply expire |

## 2. Rules for additive changes

Within a major version, allowed without a version bump:

- new optional request fields (with defaults that preserve old behavior);
- new response fields (clients must ignore unknown fields; the SDK does);
- new endpoints, tools, capabilities, error codes, enum values **only** where the
  contract marks the enum as open (`x-extensible-enum`). Closed enums (for example
  `tier`) change only with a major;
- new optional manifest fields that default to the old behavior **and** are
  not part of the apply checksum, or are part of it only when set (absent stays
  absent in the canonical form).

## 3. Agent upgrade compatibility

- The agent announces `agentVersion`, `protocolMajor`, and its capability list
  with majors at every connect.
- The control plane refuses jobs for capabilities the agent lacks
  (`CAPABILITY_UNAVAILABLE`), never downgrades a job's semantics silently.
- Upgrades: [`../07-node-agent/architecture.md` §6](../07-node-agent/architecture.md#6-packaging-installation-and-upgrades).

## 4. What is deliberately not versioned

- Internal package APIs inside the monorepo (they change together).
- The Web App (it ships with the server; it uses the same REST API version).
- Analysis heuristics (lock severity thresholds etc.): they are policy inputs and
  are recorded in each plan's `policyVersion`/engine version, which is enough to
  explain past decisions.

## 5. Version identifiers in the contracts

**[DECIDED]** (Wave 1) The identifiers of §1 are constants in
`packages/contracts/src/versions.ts` (`CONTRACT_VERSIONS`) and are published in
`packages/contracts/generated/catalog.json`:

| Contract | Identifier | Where else it appears |
|---|---|---|
| REST API | `v1` | OpenAPI `info.version`; base path `/api/v1` |
| MCP catalog | `exponetdb.mcp/v1` | `generated/jsonschema/mcp-tools.v1.json`; `tools/list` `_meta` (`cloud.exponet.db/catalog`) |
| Node protocol | `exponetdb.node/v1` | JSON Schema `title`, `X-Exponetdb-Protocol` header, Go `protocol.ProtocolID` |
| Migration manifest | `exponetdb.migration/v1` | `schema` member of `migration.yaml`; JSON Schema `$id` `https://db.exponet.cloud/schemas/migration-manifest/v1` |
| Project config | `exponetdb.project/v1` | JSON Schema `$id` `https://db.exponet.cloud/schemas/project-config/v1` |
| Checksum, ledger state, fingerprint | `c1`, `ls1`, `fp1` | in every stored value (`sha256:c1:…`, `sha256:ls1:…`); `fp1` is reserved, fingerprints are built in Wave 4 |
| Policy version (Wave 2) | `pv1` | every stored policy version (`sha256:pv1:…`); golden vectors `tooling/golden/policy-version.json` |
| Audit event, audit chain hash (Wave 2) | `exponetdb.audit/v1`, `ac1` | `schema` member of every event; every stored hash (`sha256:ac1:…`); golden vectors `tooling/golden/audit-chain.json` |

Schema annotations shared by the generated documents: `x-extensible-enum`
marks an open enum (§2); database-sourced or caller-supplied text is marked
`"untrusted": true` in JSON Schema and MCP schemas and `x-untrusted: true` in
OpenAPI, where unknown keywords must carry the `x-` prefix
([`../05-mcp/architecture.md`](../05-mcp/architecture.md)). Every generated
document carries an `x-generated` (OpenAPI) or `$comment` (JSON Schema) note
naming its generator; none carries a timestamp.

**[DECIDED]** Freeze of the hash contracts. Until the owner accepted G1,
`c1`, `ls1`, the JCS profile and the plan-hash construction could still be
corrected under their current names, because no value had been stored
anywhere; each correction is listed in the
[G1 gate record](../14-roadmap/gates/1.md). **The owner accepted G1 on
2026-10-05** (freeze baseline `b52a6ca`). Since then the output for every
existing input is immutable, locked golden vectors are append-only, a change
of `c1` behavior is `c2`, a change of `ls1` behavior is `ls2`, and a change of
the plan-hash construction needs a new value prefix through an ADR (§1). CI
enforces the append-only rule against the base commit of every change
(`bun run golden:history`, [G1 gate record §8](../14-roadmap/gates/1.md#8-acceptance-and-freeze-2026-10-05)).

**[DECIDED]** The Wave 2 contracts `ac1` (audit chain hash,
[ADR-0023](./adr/0023-audit-chain-hash-ac1.md)), `se1` (secret envelope) and
`pv1` (policy version) are frozen in the same way since **the owner accepted
G2 on 2026-10-05** and confirmed ADR-0023 with it
([G2 gate record §9](../14-roadmap/gates/2.md#9-acceptance-2026-10-05)): the
output for every existing input is immutable, their golden vectors are
append-only, and a change is `ac2`, a new envelope version or `pv2` (§1).
`bun run golden:check` guards the lock now; `bun run golden:history`
protects them against the base commit from the merge of
`davdxpx/ExponetDB#5` on.

## 6. MCP: protocol revisions, catalog and tool versions

**[OBSERVED]** (2026-10-13, Wave 7; `packages/contracts/src/mcp/protocol.ts`,
`tools.ts`, `definitions.ts`; G7 not yet accepted)

- The served protocol revisions are constants of the contracts:
  `MCP_MODERN_VERSIONS` (`2026-07-28`), `MCP_LEGACY_VERSIONS` (`2025-11-25`,
  `2025-06-18`) and `MCP_REFUSED_VERSIONS` (`2025-03-26`, `2024-11-05`).
  They are not in `CONTRACT_VERSIONS` (§5). How a request is assigned to an era is
  [`../05-mcp/protocol-baseline.md` §4](../05-mcp/protocol-baseline.md#4-classification-of-a-request).
- The legacy support window in §1 is ExponetDB's own promise and an owner
  decision; the specification's twelve-month window applies to deprecated
  features, not to revisions.
- The catalog `exponetdb.mcp/v1` holds 30 tools; 26 are `served` (Wave 7)
  and 4 are `planned` (Wave 9) and never listed
  ([`../05-mcp/tool-catalog.md` §0](../05-mcp/tool-catalog.md#0-served-and-planned)).
  Each tool has a `toolVersion`; the digest of a served list
  (`mcpCatalogDigest`, `sha256:` over the JCS of the definitions) is in the
  `_meta` of `tools/list` and in the request log, and the tests pin it per
  grant shape, so a changed list is visible, never silent.
- Adding a tool or an optional field is additive (§2); a breaking change is a
  new tool name or catalog v2 (§1). **[DECIDED]** (owner, 2026-10-13) When a
  served tool's `toolVersion` rises is mechanical: any change to the
  definition a client sees (name, title, description, annotations, input or
  output schema, `_meta` other than `toolVersion` itself) raises it by one.
  `mcpToolDigest` is `sha256:` over the JCS of that definition without the
  `toolVersion` key; `packages/contracts/mcp-tool-versions.json` pins one
  digest per tool and version, append-only. The contract test
  (`packages/contracts/test/mcp-tools.test.ts`) fails when a served tool's
  digest has no pin at its current version, and `bun run golden:history`
  refuses a removed pin or a changed digest against the base commit. The
  state merged in `davdxpx/ExponetDB#16` is version `1` of every served tool;
  a change a client could break on is still a new tool name, not a higher
  `toolVersion`. **[OBSERVED]** (2026-10-13, Phase 11) Before the rule, the
  announced output schemas lost `maxLength` (escaping lengthens a value after
  the server validated it); that change is part of version `1`.
  **[OBSERVED]** (2026-10-13, after the first real-client test) Version `2`
  of `drift_check`, `migration_verify` and `audit_search`: their descriptions
  now say where the findings are recorded, how `verify.sql` is held read-only
  (a `READ ONLY` transaction, always rolled back, allowlisted built-ins only)
  and which calls the audit holds. Every other served tool is still version
  `1` except `migration_lint`.
  **[OBSERVED]** (2026-10-13, Wave 7 follow-up) Version `2` of
  `migration_lint`: the description says that the project must be registered
  and visible to the caller (`NOT_FOUND` otherwise), and the output schema
  gains the optional `code` of a finding for a refused `verify.sql`
  (`MIGRATION_STATEMENT_FORBIDDEN` or `VERIFY_CONSTRUCT_UNSUPPORTED`,
  [`../04-migrations/verification.md` §4.2](../04-migrations/verification.md#42-admission-plan-time));
  the pin `"2"` is added by hand, `"1"` is untouched.
