# Node agent protocol (`exponetdb.node/v1`)

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 1 (schemas in contracts), Wave 5 (implementation) |
| Read before | [`architecture.md`](./architecture.md), [`enrollment.md`](./enrollment.md) |

## 1. Transport

**[DECIDED]** HTTPS over HTTP/2 with mutual TLS (TLS 1.3 only), agent → gateway.
JSON bodies, UTF-8, canonical JSON (RFC 8785) wherever a signature or hash covers
a payload. Every request carries `X-Exponetdb-Protocol: exponetdb.node/v1` and
the agent version. Message schemas are JSON Schema 2020-12 generated from
`packages/contracts/node-protocol`; the Go types are generated from them.

| Endpoint | Purpose |
|---|---|
| `POST /agent/v1/enroll` | enrollment (token-authenticated, server-authenticated TLS only) |
| `POST /agent/v1/hello` | session start: identity, versions, capabilities, clusters, host facts |
| `POST /agent/v1/heartbeat` | every 15 s |
| `POST /agent/v1/jobs/claim` | long-poll for jobs (≤ 25 s) |
| `POST /agent/v1/jobs/{jobId}/start` | acknowledge start (lease begins) |
| `POST /agent/v1/jobs/{jobId}/progress` | progress events, lease renewal |
| `POST /agent/v1/jobs/{jobId}/complete` | final result |
| `POST /agent/v1/renew` | certificate renewal |

## 2. Hello

```json
{
  "nodeId": "nod_…",
  "agentVersion": "1.2.0",
  "protocolMajors": [1],
  "capabilities": [ { "name": "postgres.config.apply", "major": 1 }, … ],
  "clusters": [ { "localName": "17/main", "port": 5432, "version": "17.11", "systemIdentifier": "7291…", "dataDirectory": "/var/lib/postgresql/17/main", "running": true } ],
  "host": { "hostname": "reos-db-01", "os": "ubuntu 24.04", "kernel": "…", "cpus": 8, "memoryBytes": …, "machineIdHash": "sha256:…" },
  "clock": { "agentTime": "…" },
  "journal": { "inFlight": [ { "jobId": "job_…", "state": "started", "lastStep": 2 } ] }
}
```

The response confirms the session, returns the server time (skew computation),
the accepted capability majors, and instructions (e.g. `renewCertificate: true`).

## 3. Heartbeat

Every 15 s: host metrics (CPU, memory, load, disk per mount, inode use), PostgreSQL
service state per cluster, `pending_restart`, WAL directory size, archiver status
summary, certificate expiries (node and PostgreSQL server), clock skew, in-flight
jobs, agent self-health (queue sizes, buffer sizes, last errors). Heartbeats are
idempotent snapshots; a missed heartbeat loses nothing important.

## 4. Jobs

### 4.1 Envelope

**[DECIDED]**

```json
{
  "jobId": "job_01JB…",
  "operationId": "op_01JB…",
  "nodeId": "nod_…",
  "capability": { "name": "postgres.config.apply", "major": 1 },
  "args": { … },                       // capability-specific, schema-validated by both sides
  "argsHash": "sha256:…",              // over JCS(args)
  "notBefore": "2026-10-04T12:00:00Z",
  "expiresAt": "2026-10-04T12:15:00Z",
  "nonce": "…128-bit random…",
  "issuedAt": "…",
  "attempt": 1,
  "signature": {
    "alg": "Ed25519",
    "keyId": "jobkey_2026_10",
    "value": "base64url(sign(JCS(envelope without signature)))"
  }
}
```

### 4.2 Verification by the agent (before anything executes)

1. Signature valid with a job-signing public key the agent trusts (delivered at
   enrollment and rotated via signed `config.update` jobs; the private key lives
   only in the **worker**, not in the gateway). **[OPEN: OD-23]** How the agent
   first trusts these keys without trusting the gateway:
   [ADR-0024 §1](../01-architecture/adr/0024-node-trust-model.md#1-job-signing-keys-are-anchored-by-the-token-not-by-the-gateway-od-23-a).
2. `nodeId` equals its own id.
3. `notBefore ≤ now ≤ expiresAt` using the agent clock, tolerating ≤ 30 s skew.
4. `jobId` not present in the journal (replay protection), and `nonce` not seen
   within the last 7 days (defence in depth if the journal were lost).
5. Capability and major supported and enabled in local config.
6. `args` valid against the capability's schema; `argsHash` matches.
7. Capability-specific local preconditions (e.g. the cluster's
   `system_identifier` equals the one in `args`).

Any failure: the agent completes the job with `rejected` and the reason; nothing
is executed.

### 4.3 Lifecycle and leases

```
pending ──claim──▶ dispatched ──start──▶ running ──complete──▶ succeeded | failed | rejected
   │                    │                    │
   └─expiresAt──▶ expired   └─no start in 60 s─▶ pending (re-dispatchable, same jobId)
                                             └─no progress within lease (60 s)──▶ outcome_unknown
```

- `claim` returns at most one job at a time per cluster domain (jobs that touch
  the same cluster are serialized by the control plane's exclusivity domains).
- `start` writes `started` into the journal **before** responding, then executes.
- `progress` renews the lease every ≤ 20 s and carries step events.
- `complete` carries the result (capability-specific schema), the steps
  performed, and redacted output excerpts.
- If the gateway is unreachable at completion, the result is buffered and
  delivered later; the control plane accepts late results for jobs in
  `outcome_unknown` and reconciles.

### 4.4 Idempotency and restarts

**[DECIDED]**

- A `jobId` executes at most once per node: the journal is checked before start
  and written before execution begins.
- After an agent restart, `hello.journal.inFlight` reports jobs that were
  `started` without `completed`. The agent does **not** resume them on its own.
  The control plane calls the capability's reconciliation:
  - capabilities declare `reconcile` semantics: *idempotent* (safe to re-run with
    the same args, e.g. `postgres.reload`, file installs with content hash),
    *observable* (outcome decidable from state, e.g. `postgres.restart`: compare
    postmaster start time with the job's start), or *manual* (e.g. a partially
    applied package upgrade) → operation `needs_attention`.
- Retries are new **attempts** of the same job id only for idempotent
  capabilities and only by explicit control-plane decision; otherwise a new
  plan is required. **[OPEN: OD-24]** This contradicts "a `jobId` executes at
  most once"; [ADR-0024 §4](../01-architecture/adr/0024-node-trust-model.md#4-job-identity-one-envelope-one-execution-a-retry-is-a-new-job-od-24)
  proposes that a retry is a new job with `attempt + 1`.

## 5. Security properties

| Threat | Protection |
|---|---|
| Forged job (gateway or network compromised) | Ed25519 signature by the worker's key; agent verifies |
| Replayed job | `jobId` journal + nonce cache + `expiresAt` |
| Job for another node | `nodeId` binding |
| Downgrade to weaker capability semantics | capability `major` in the signed envelope |
| Impersonated agent | mTLS client certificate + node state check |
| Impersonated gateway | agent pins the ExponetDB root CA |
| Oversized messages | limits: request 1 MiB (job results), heartbeat 64 KiB, log excerpts 32 KiB per job |
| Secrets in transit | capability args never contain plaintext passwords (verifiers only); backup repository credentials are delivered as encrypted blobs to the agent's public key (sealed box) and stored by the agent in its config with `0600` |

## 6. Versioning

The agent sends the protocol majors it speaks; the gateway picks the highest
common one or rejects with an explicit error. Capability majors are negotiated per
capability ([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).
