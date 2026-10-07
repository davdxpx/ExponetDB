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
the agent version in `X-Exponetdb-Agent-Version` (semantic version). Message schemas are JSON Schema 2020-12 generated from
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

1. Signature valid (§7.2) with a job-signing public key the agent trusts. The
   private key lives only in the **worker**. **[DECIDED]** (owner decision
   OD-23, 2026-10-07, [ADR-0024 §1](../01-architecture/adr/0024-node-trust-model.md#1-job-signing-keys-are-anchored-by-the-token-not-by-the-gateway-od-23-a))
   The agent's first trusted keys are those whose fingerprints the enrollment
   token carries (§7.3), never keys the gateway alone vouches for; later keys
   arrive through `config.update` jobs signed by a key already trusted
   (overlap 7 days, at most three keys).
2. `nodeId` equals its own id.
3. `notBefore ≤ now ≤ expiresAt` using the agent clock, tolerating ≤ 30 s skew;
   `expiresAt − notBefore` ≤ 60 minutes; the host clock is synchronized and not
   earlier than the highest accepted `issuedAt` by more than 30 s (otherwise
   `clock_untrusted`).
4. `jobId` not present in the journal (replay protection), and `nonce` not seen
   within the last 7 days (defence in depth if the journal were lost). A
   journal or nonce cache that fails its integrity check refuses every job
   (`journal_corrupt`).
5. Capability and major supported and enabled in local config.
6. `args` valid against the capability's schema; `argsHash` matches.
7. Capability-specific local preconditions (e.g. the cluster's
   `system_identifier` equals the one in `args`).

Any failure: the agent completes the job with `rejected` and the reason; nothing
is executed.

**[DECIDED]** (Wave 5 Phase 2) The agent applies these checks in this order
and names the first that fails: `signature_invalid` or `unknown_signing_key`
(1); `envelope_invalid`, a signed envelope that does not match the envelope
schema; `node_mismatch` (2); `clock_untrusted`, `not_yet_valid` or `expired`
(3; a window longer than 60 minutes, or `expiresAt` not after `notBefore`,
counts as `expired`); `journal_corrupt`, `job_replayed` or `nonce_replayed`
(4); `capability_unsupported` or `capability_disabled` (5); `args_invalid`
(also a sealed value that does not open under the job's context) or
`args_hash_mismatch` (6); `precondition_failed` (7). Only a job whose
signature verified is written to the journal (as `rejected` or
`accepted`); an envelope without a readable job id cannot be answered and
is dropped and logged.

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
- **[DECIDED]** (owner decision OD-24, 2026-10-07, [ADR-0024 §4](../01-architecture/adr/0024-node-trust-model.md#4-job-identity-one-envelope-one-execution-a-retry-is-a-new-job-od-24))
  The agent journals `accepted` durably before it acknowledges `start`; a
  re-delivery of an accepted envelope is `job_replayed`. A re-dispatch after
  a lost claim repeats the identical envelope (same nonce, same signature).
  A retry is a **new job** (new `jobId`, nonce and signature, `attempt + 1`),
  created only for capabilities whose reconciliation is idempotent and only
  by an explicit decision recorded on the operation; otherwise a new plan is
  required. There is no `(jobId, attempt)` key.
- Cancellation: a capability declares its effect point. A cancel request seen
  before it stops the job and completes `canceled`; after it the job finishes
  and reports its effect. Cancellation never claims a rollback.

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
| Forged result or evidence (gateway compromised) | results signed with the node signing key (`nr1`, §7.5); the worker accepts only signatures by the node's bound key, and still verifies independently |
| Secrets in transit | capability args never contain plaintext passwords; verifiers and (Wave 9) backup credentials are sealed to the node's bound encryption key (`ns1`, §7.6), so the TLS-terminating gateway cannot read them |

## 6. Versioning

The agent sends the protocol majors it speaks; the gateway picks the highest
common one or rejects with an explicit error. Capability majors are negotiated per
capability ([`../01-architecture/versioning.md`](../01-architecture/versioning.md)).

## 7. Constructions (Wave 5)

**[DECIDED]** (owner decisions OD-23 and OD-24, 2026-10-07;
[ADR-0024](../01-architecture/adr/0024-node-trust-model.md)). Normative: the
TypeScript implementation (`@exponetdb/kernel/node`), the Go implementation
(`agent/node/internal/nodecrypto`) and an independent derivation agree byte
for byte on the golden vectors `tooling/golden/node-*.json`.

### 7.1 Notation

- `b64u(x)`: base64url without padding (RFC 4648 §5). Decoders refuse
  padding, other alphabets and non-canonical trailing bits.
- `JCS(v)`: RFC 8785 canonical JSON, UTF-8.
- Public keys (Ed25519, X25519) travel as `b64u` of their raw 32 bytes.
- **Key fingerprint**: `"sha256:" + hex(SHA-256(raw public key))`, lowercase.
- **Root fingerprint**: `"sha256:" + hex(SHA-256(DER of the root certificate))`.
- `HKDF(ikm, info)`: HKDF-SHA-256 (RFC 5869) with an empty salt and output
  length 32.

### 7.2 Job signature (v1)

`signature.value = b64u(Ed25519(sk, JCS(envelope without the signature
member)))`; `signature.alg = "Ed25519"`; `keyId` names the trusted key. The
agent verifies against the trusted key with that `keyId` only.

### 7.3 Enrollment token `exdbt1`

`token = "exdbt1." + b64u(JCS(payload))`. `payload` has exactly these members:

| Member | Value |
|---|---|
| `v` | `"exdbt1"` |
| `tokenId` | `ent_…` |
| `installationId`, `serverId` | `ins_…`, `srv_…` |
| `gateway` | the private gateway listener as `https://host[:port]`: a lowercase DNS name or IPv4 address, port 1 to 65535 and never written as 443, nothing else |
| `gatewayServerName` | the lowercase DNS name the gateway's server certificate carries |
| `rootFingerprint` | §7.1 |
| `jobKeys` | 1 to 3 `{ keyId, fingerprint }` |
| `secret` | `b64u` of 32 CSPRNG bytes |
| `expiresAt` | RFC 3339 UTC (`Z`, optional fraction), a real calendar date and time without leap seconds; 30 minutes after creation |

A decoder refuses a payload whose bytes are not exactly its own JCS form, an
unknown or missing member, and a secret that is not 32 bytes. The token
string is shown once and never stored; the Control Store keeps
`redeemHash = "sha256:" + hex(SHA-256(k_redeem))` for the gateway and
`k_bind` encrypted for the worker (`se1`), where
`k_redeem = HKDF(secret, "exponetdb/enroll/redeem/v1:" + tokenId)` and
`k_bind = HKDF(secret, "exponetdb/enroll/bind/v1:" + tokenId)`.

### 7.4 Enrollment and renewal proofs

- **Redeem:** the enrollment request carries `redeemKey = b64u(k_redeem)`;
  the gateway compares its hash with `redeemHash` in constant time, once.
- **Proof of possession:** `tlsKeyProof = b64u(Ed25519(tlsKey,
  JCS({purpose: "exponetdb/enroll/tls-pop/v1", tokenId, tlsKey})))` and
  `nodeSigningKeyProof` likewise with purpose
  `"exponetdb/enroll/nsk-pop/v1"` and member `nodeSigningKey`.
- **Binding:** `bindProof = b64u(HMAC-SHA-256(k_bind, JCS({purpose:
  "exponetdb/enroll/bind/v1", installationId, serverId, tokenId,
  nodeSigningKey, nodeEncryptionKey})))`, checked by the worker.
- **Renewal:** over the current mTLS session, `tlsKeyProof` with purpose
  `"exponetdb/renew/tls-pop/v1"` and members `nodeId`, `tlsKey`, plus
  `nodeSignature = b64u(Ed25519(nsk, JCS({purpose: "exponetdb/renew/v1",
  nodeId, tlsKey})))`.

### 7.5 Node result signature `nr1`

`nodeSignature.value = b64u(Ed25519(nsk, JCS({purpose:
"exponetdb/node-result/nr1", installationId, nodeId, jobId, argsHash,
complete})))`, where `complete` is the job completion request without its
`nodeSignature` member.

### 7.6 Sealed value `ns1`

HPKE (RFC 9180) base mode, single shot: DHKEM(X25519, HKDF-SHA256) (`0x0020`),
HKDF-SHA256 (`0x0001`), AES-256-GCM (`0x0002`); recipient the node's bound
encryption key; empty `aad`;
`info = JCS({purpose: "exponetdb/sealed/ns1", installationId, nodeId, jobId,
operationId, capability, field})` with `capability = {name, major}` and
`field` the argument the value fills. In `args` a sealed value is
`{ "ns1": { "enc": b64u(enc), "ct": b64u(ciphertext) } }`, so the envelope
signature and `argsHash` cover the ciphertext.
