# Node agent: the Control Plane side

| | |
|---|---|
| Status | **[DECIDED]** Wave 5 Phase 3 design (2026-10-07), within [ADR-0024](../01-architecture/adr/0024-node-trust-model.md) and the accepted node-agent baseline; implemented in `packages/nodes`, the Control Store bundle `nodes`, the `gateway` and `worker` roles |
| Applies to | Wave 5 |
| Read before | [`architecture.md`](./architecture.md), [`enrollment.md`](./enrollment.md), [`protocol.md`](./protocol.md), [`security.md`](./security.md) |

This document says how the Control Plane holds node state, issues tokens and
certificates, serves the agent API, signs and dispatches jobs and judges
results. The agent side is in [`architecture.md`](./architecture.md).

## 1. Who holds what

| Material | Holder | Never held by |
|---|---|---|
| Agent root CA private key | the owner, offline (written once by `exponetdb-server node-pki init`, then not kept) | every process |
| Issuing CA and gateway server CA keys, the gateway's TLS key | the `gateway` secrets consumer (`se1`) | worker, serve |
| Job-signing private keys | the `worker` secrets consumer | gateway, serve |
| A token's bind key `k_bind` | the `worker` secrets consumer; the secrets store is append-only (G2), so it is not deleted: once its token is used and the node bound, or the token expired, the worker never reads it again *(refinement of ADR-0024 §2, which said deleted; its exposure could only re-prove a binding for that token, whose redeem is spent)* | gateway |
| A token's redeem key | nobody: the gateway keeps `sha256(k_redeem)` | — |
| A token's secret | nobody: generated at reveal, returned once, never stored | — |
| PostgreSQL server CA key (P-256, OD-17) | the `worker` secrets consumer | gateway |

The gateway can therefore enroll a node and issue its TLS certificate, but it
cannot sign a job, verify a binding, read a sealed value or mint a PostgreSQL
server certificate (ADR-0024, consequences).

## 2. Data model (Control Store bundle `nodes`)

A new, additive bundle creates schema `nodes` (the frozen `operations-engine`
and `registry` bundles assert that the gateway has no access to their
schemas, so gateway-readable state cannot live there).

| Table | Content | Writers |
|---|---|---|
| `nodes.pki` | one row: root certificate and fingerprint, issuing CA and server CA certificates, the gateway certificate, the server name, references to the gateway-consumer secrets of the CA keys | migrate (empty), `node-pki init` (as worker, see §3) |
| `nodes.job_keys` | key id, Ed25519 public key, fingerprint, state (`active`, `retiring`, `retired`), the worker-consumer secret of the private key | worker |
| `nodes.enrollment_tokens` | token id (`ent_`), server, the anchored job keys, state (`created`, `issued`, `used`, `expired`), `redeem_hash`, the worker-consumer secret of `k_bind`, `issued_at`, `expires_at`, the operation that created it and the identity that may reveal it | worker (create), serve (issue), gateway (redeem, through a function) |
| `nodes.nodes` | node id (`nod_`), server, state, the three public keys, the current certificate and its expiry, `bind_proof` until checked, `bound_at`, host facts, agent version, capabilities, last hello and heartbeat | gateway (enroll, hello, heartbeat, renewal), worker (binding, revoke, decommission) |
| `nodes.jobs` | job id, node, operation, capability, the signed envelope, `args_hash`, nonce, state, times, lease, cancel flag, the completion and the worker's verdict on it | worker (create, verdict, cancel), gateway (dispatch, start, progress, completion, through functions) |

One non-terminal node per server (I-6) is a partial unique index. Every
table has `_guard`, `_no_delete` and `_no_truncate` triggers in the registry
pattern; gateway writes go through `SECURITY DEFINER` functions that check
the node, the state and the transition, so a compromised gateway can only
make the transitions the protocol allows.

Node states: `pending_binding` (enrolled, keys not yet bound by the worker),
`active`, `degraded`, `revoked`, `decommissioned`, `binding_failed`. Only
`active` and `degraded` nodes are served; no job is signed for, and nothing is
sealed to, a node that is not bound.

Job states: `pending`, `dispatched`, `running`, `completed`, `expired`,
`outcome_unknown`, `canceled_before_start`. A job not started within 60 s of
dispatch returns to `pending` (the identical envelope); a running job without
progress within its lease turns `outcome_unknown`; a pending or dispatched job
past `expiresAt` turns `expired`.

## 3. PKI bootstrap (`exponetdb-server node-pki init`)

An operator command, run once per installation, with the keyring:

1. generates the Ed25519 root key, the issuing CA, the gateway server CA and
   the gateway's TLS key; issues their certificates (§`packages/nodes`
   profiles) and the gateway certificate for the configured server name;
2. writes the root's private key to the file the owner names (mode `0600`,
   refused if it exists) and keeps no copy;
3. stores the certificates in `nodes.pki` and the CA and gateway keys as
   gateway-consumer secrets;
4. generates the first job-signing key as a worker-consumer secret and
   records its public key;
5. prints the root fingerprint, which every enrollment token carries.

Rotation of the issuing CA, the server CA or the gateway certificate uses the
offline root again (a later ceremony; documented with the runbooks).

## 4. Enrollment tokens

**[DECIDED]** (Phase 3) An enrollment token is created in two steps, so that
`node.enroll` stays a planned, high-class operation with re-authentication
(operations-engine.md §2) and the token secret is still never stored
(ADR-0024 §2):

1. **`node.enroll`** (stored plan, `registry.manage`, re-authentication 300 s):
   the worker creates the token record for the server: id, the current job
   keys' fingerprints as anchors, state `created`, no secret. It refuses a
   server that has a non-terminal node.
2. **Reveal** (`POST /enrollment-tokens/{tokenId}/reveal`, action
   `node.enroll`, only the identity that applied the plan, with a fresh
   re-authentication, within 30 minutes of the operation's success): `serve`
   generates the 32-byte secret, stores `redeem_hash` and the worker-consumer
   secret of `k_bind`, sets `issued`, `expires_at = now + 30 min`, and returns
   the token string in that response only. A second reveal is refused.

The gateway redeems a token once (`nodes.redeem_token`), comparing the hash
of the presented redeem key, before it issues a certificate; the proofs of
possession are checked first, and a request whose proofs fail does not
consume the token.

## 5. Gateway

The `gateway` role opens the agent listener (`EXPONETDB_GATEWAY_LISTEN`):
HTTP/2 over TLS 1.3 only (ALPN `h2`), its certificate chain up to and
including the root (enrollment pins the root by fingerprint), client
certificates requested and verified against the issuing CA with
`clientAuth`. Per request:

- every request: the protocol headers (`NODE_PROTOCOL_UNSUPPORTED`), the size
  limits, the message schema;
- `enroll`: no client certificate; proofs of possession, then the token
  (`NODE_ENROLLMENT_REFUSED`, one code for every token failure), then I-6
  (`NODE_ALREADY_ENROLLED`); issues the 72-hour certificate, creates the node
  `pending_binding` with the bind proof, audits `node.enrolled`;
- every other endpoint: the client certificate must be the node's current
  certificate and the node `active` or `degraded` (`NODE_CERTIFICATE_REFUSED`);
  `hello` also accepts `pending_binding` so that a freshly enrolled agent can
  report while the worker binds it, but such a node receives no job;
- `renew`: the renewal proof and the node signature over the new key, then a
  new certificate, which replaces the current one (`node.certificate_renewed`);
- `claim`, `start`, `progress`, `complete`: the job state machine of §2 for
  this node only; `complete` stores the completion as received and leaves
  the verdict to the worker.

Heartbeats and hello facts are gateway-sourced observations: shown with their
source, never deciding an operation.

## 6. Worker

- **Binding:** for each `pending_binding` node, the worker opens the token's
  `k_bind`, checks the bind proof over the node's keys (ADR-0024 §2), marks
  the node `active` with `bound_at`, deletes the bind secret, and audits; a
  proof that fails makes the node `binding_failed`.
- **Jobs:** a capability operation builds the envelope (job id, nonce, the
  60-minute ceiling on its window, `argsHash`), seals every sealed field to
  the node's bound encryption key (`ns1`) and signs it with the active job
  key; it then waits for the completion. A completion counts as node
  evidence only if its `nr1` signature verifies against the node's bound
  signing key; the operation's verification still runs independently.
- **Revocation and decommissioning:** `node.revoke` and `node.decommission`
  (stored plans, re-authentication) set the node's state; the gateway refuses
  the node at its next request (within one heartbeat interval), pending jobs
  are canceled, running ones are reconciled, never assumed undone.
- **Job-key rotation:** `node.config.update` signs a `config.update@1` job
  with a currently trusted key.

## 7. Interfaces

| Route | Action |
|---|---|
| `GET /nodes`, `GET /nodes/{nodeId}` | `node.list`, `node.get` |
| `POST /servers/{serverId}/nodes/enroll` (plan) | `node.enroll` |
| `POST /enrollment-tokens/{tokenId}/reveal` | `node.enroll` (the token's applying identity, re-authentication) |
| `POST /nodes/{nodeId}/revoke`, `/decommission` (plans) | `node.revoke`, `node.decommission` |

## 8. Boundaries

`packages/nodes` may import `contracts`, `control-store`, `audit`, `policy`,
`operations`, `registry` and `secrets`, as `registry` does; the server's
composition, interfaces (the agent API handler) and tests may import
`nodes`. ([`package-architecture.md`](../01-architecture/package-architecture.md))
