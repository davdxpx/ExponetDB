# `@exponetdb/sdk`

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 1 (contracts), Wave 4 onward (generated with each REST addition), Wave 10 (first consumer: REOSA Admin) |
| Read before | [`../06-rest-api/architecture.md`](../06-rest-api/architecture.md), [`../06-rest-api/resources.md`](../06-rest-api/resources.md), [ADR-0018](../01-architecture/adr/0018-contracts-first.md) |

The SDK is a typed client for `/api/v1`. It contains **no business logic**: no
policy evaluation, no plan computation, no retries of non-idempotent calls
without an idempotency key. It is generated from the same contracts the server
uses, so it cannot drift from the API.

## 1. Generation

```
packages/contracts (Zod)
   ├──▶ OpenAPI 3.1 document (committed, CI checks it is current)
   │       └──▶ @exponetdb/sdk types (generated)
   └──▶ JSON Schema (MCP tool I/O), Go types (node protocol)

@exponetdb/sdk = generated types + small hand-written client
```

The hand-written part: authentication, request signing for `private_key_jwt`,
retries with backoff for idempotent `GET`s, automatic `Idempotency-Key`
generation for mutations, cursor pagination iterators, operation waiting, error
mapping.

## 2. Surface

Namespaces follow REST resources (illustrative, final names from the contracts):

| Namespace | Examples |
|---|---|
| `targets` | `list`, `get`, `resolve("reosa/platform/production")` |
| `health` | `get(targetId)`, `history(targetId, window)` |
| `schema` | `get(targetId)`, `fingerprint(targetId)`, `diff(a, b)` |
| `migrations` | `status(targetId)`, `ledger(targetId)`, `plan(targetId, bundles)`, `lint(bundles)` |
| `plans` | `get`, `apply(planId)`, `withdraw` |
| `operations` | `get`, `wait(operationId, { timeoutMs })`, `cancel` |
| `connections` | `list(targetId)`, `summary(targetId)`, `planCancel`, `planTerminate` |
| `locks` | `tree(targetId)` |
| `performance` | `summary(targetId)`, `statements(targetId, window)` |
| `backups` | `status(clusterId)`, `list`, `run`, `planRestore`, `drills` |
| `findings` | `list(targetId, { kind, severity })` |
| `nodes`, `clusters` | `list`, `get`, `planConfig` |
| `audit` | `search` |

Approvals, break-glass and `critical` applies are **not** in the SDK's
programmatic surface for service accounts (the server refuses them anyway); the
SDK exposes them only to first-party human sessions (CLI).

## 3. Example (documentation only)

```ts
import { ExponetDB } from "@exponetdb/sdk";

const exponetdb = new ExponetDB({
  baseUrl: "https://db.exponet.cloud",
  auth: { kind: "serviceAccount", clientId: process.env.EXPONETDB_CLIENT_ID, privateKey: loadKey() },
});

const target = await exponetdb.targets.resolve("reosa/platform/production");
const health = await exponetdb.health.get(target.id);

if (health.ok) {
  // health.value.state: "healthy" | "degraded" | "unhealthy" | "unreachable" | "unknown" | "suspended"
  // health.value.source and health.value.observedAt are always present
} else {
  // health.error.code is a stable error code, e.g. "CONTROL_PLANE_DEGRADED"
}
```

Results are `Readable<T>`-shaped (`{ ok: true, value } | { ok: false, error }`),
mirroring the server's truthfulness rules: a failed call never looks like an
empty list.

## 4. Authentication modes

| Mode | For | Notes |
|---|---|---|
| Service account with `private_key_jwt` | server-side integrations (REOSA Admin), CI | short-lived access tokens obtained automatically; keys rotated by the consumer |
| API key (`exak_…`) | simple scripts, read-only dashboards | scoped and target-restricted; prefer service accounts for anything long-lived |
| User token (OAuth authorization code + PKCE) | first-party CLI | device or loopback flow |

The SDK never accepts or stores database credentials.

## 5. Compatibility

- The SDK's major version follows the API version (`/api/v1` → SDK 1.x).
- Each SDK release states the minimum server version; the server reports its
  contract version in `GET /installation`; the SDK warns on mismatch.
- Runtimes: Node.js 22+ and Bun on servers. Browser use is unsupported by
  design (tokens must not reach browsers).
