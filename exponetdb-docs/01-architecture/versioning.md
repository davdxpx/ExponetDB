# Versioning and compatibility

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 1 onward |
| Read before | [`package-architecture.md`](./package-architecture.md) |

Every contract is versioned from day one
([C-33](../00-product/constitution.md#c-33-every-contract-is-versioned)), and every
version field has a rule for what changes it and what readers do with it. A
version field without an upgrade concept is not added.

## 1. Overview

| Contract | Version format | Where | Breaking change means | Compatibility promise |
|---|---|---|---|---|
| REST API | path major: `/api/v1` | URL | `/api/v2` alongside v1 | v1 supported ≥ 12 months after v2 GA; additive changes within v1 |
| SDK `@exponetdb/sdk` | SemVer | npm | major bump | SDK major N targets REST v N; minor = additive |
| MCP tool schemas | per tool `toolVersion` in `_meta`, catalog version `exponetdb.mcp/v1` | tool metadata | new tool name (`*_v2`) or catalog v2 | removed tools keep answering with a deprecation error for 6 months |
| MCP protocol | spec revision negotiated per request | protocol | n/a (spec-defined) | serve 2025-11-25 (legacy) and 2026-07-28 (modern) concurrently; drop legacy no earlier than the spec's 12-month deprecation window and only after client support is confirmed |
| Node protocol | `exponetdb.node/v<major>` + agent SemVer | handshake | new major | control plane supports current and previous major; agent refuses to run against a control plane that does not support its major |
| Capability | `name@major` (e.g. `postgres.config.apply@1`) | capability report | new major of that capability | control plane uses the highest major both sides support; jobs name the major |
| Migration manifest | `exponetdb.migration/v<major>` | `migration.yaml` | new major | engine reads every major it ever supported (history must stay readable) |
| Role manifest | `exponetdb.roles/v<major>` | `exponetdb.roles.yaml` | new major | same |
| Project config | `exponetdb.project/v<major>` | `exponetdb.project.yaml` | new major | current and previous |
| Checksum canonicalization | `c<n>` in the value | stored checksums | new `c<n+1>` | old values never re-hashed; comparisons use the stored canonicalizer |
| Fingerprint canonicalization | `fp<n>` in the value | fingerprints | new `fp<n+1>` | values of different versions are "not comparable" |
| Ledger state hash | `ls<n>` | plans, mirrors | new `ls<n+1>` | same |
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
