# Node enrollment, identity and certificates

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 5 |
| Read before | [`architecture.md`](./architecture.md), [`security.md`](./security.md) |

## 1. Identity

**[DECIDED]**

- A node's identity is its **node id** (`nod_…`) bound to **key pairs generated
  on the host** during enrollment. No private key ever leaves the host.
  **[DECIDED]** (OD-23, 2026-10-07, [ADR-0024 §2](../01-architecture/adr/0024-node-trust-model.md#2-node-keys-are-bound-through-the-token-results-are-signed-od-23-b))
  Besides the TLS key (renewed every 48 h) the host holds two long-term keys:
  the **node signing key** (Ed25519; signs results and renewals) and the
  **node encryption key** (X25519; recipient of sealed values). Both are
  bound to the node through the token (§3) and verified by the worker.
- The control plane issues **short-lived X.509 client certificates** for that key
  from an ExponetDB-internal CA:
  - subject: `CN=nod_…`;
  - SAN URI: `urn:exponet:exponetdb:node:<installationId>:nod_…`
    (installation-scoped since OD-23; a SPIFFE-style
    `spiffe://exponet.cloud/exponetdb/node/nod_…` can be adopted when an
    Exponet-wide workload identity system exists);
  - lifetime **72 hours**, renewed at two thirds of the lifetime;
  - key type **Ed25519** (OD-23: Go and Node.js both support it in TLS 1.3);
  - issued from a public key plus a proof-of-possession signature (§3), never
    from a PKCS#10 CSR: the host proposes no name, extension or CA bit.
- The gateway authorizes by **certificate identity plus the node record**, not by
  IP address. A valid certificate of a node in state `revoked` or
  `decommissioned` is rejected (no reliance on CRL/OCSP: the node table is the
  revocation list, checked on every connection and every request).

Why short-lived (72 h) instead of a year: revocation without CRL infrastructure
and a small damage window for a stolen key. Why not 24 h (smallstep's default):
a database host that loses connectivity for a long weekend should still be able
to reconnect; 72 h with renewal at 48 h covers that. A node whose certificate
expired re-enrolls with a new token (human action), deliberately.

## 2. CA structure

**[DECIDED]**

```
ExponetDB Agent Root CA (offline: created at bootstrap, key exported to the owner's offline storage, then deleted from the server)
   └── Agent Issuing CA (online: key encrypted in the Control Store secret store, loaded by the gateway for issuance)
          └── node client certificates (72 h)
   └── Gateway server certificate CA (same root; the gateway mints its own TLS server certificate from it in memory, 72 h, again daily)
```

- The agent trusts **only** the ExponetDB root (pinned at enrollment via the
  token, §3) for the gateway's server certificate; not the public Web PKI.
- **[DECIDED]** (OD-23) All agent PKI keys are Ed25519. The issuing CA's
  certificate allows only `clientAuth`, the gateway server CA's only
  `serverAuth`; a certificate from the gateway-held issuing CA therefore never
  verifies as a gateway server certificate. The gateway records each node's
  current certificate and refuses a different one for the same node, except
  the one the last renewal replaced, until the renewed one is first
  presented (§4).
- The PostgreSQL server CA (OD-17) is a separate key pair held by the worker,
  never by the gateway.
- The issuing CA can be rotated by issuing a new intermediate from the offline
  root (operator ceremony, documented in [`../12-operations/bootstrap.md`](../12-operations/bootstrap.md));
  agents receive the new chain through renewal responses.
- Root compromise recovery: new root, re-enroll all nodes (documented runbook).
  With one node in V1 this is acceptable.

## 3. Enrollment flow

```
admin (Web App/CLI)                  control plane                         host (operator shell)
  │ create server srv_… ─────────────▶│                                      │
  │ create enrollment token ─────────▶│ token = {id, secret, server, gateway,│
  │◀── token string (shown once) ─────│   root CA fingerprint, expires 30 min}│
  │                                   │                                      │
  │  operator installs package, runs: exponetdb-node enroll --token-file -   │
  │                                   │◀──── TLS to gateway (verifies server cert against pinned root fingerprint)
  │                                   │◀──── public keys (TLS, node signing, node encryption) + proofs + host facts
  │                                   │ gateway: redeem key matches (once), proofs of possession valid, create nod_…,
  │                                   │ issue 72 h certificate, mark token used, audit node.enrolled
  │                                   │────▶ certificate chain + node id + job-signing public keys
  │                                   │      (agent: keys must hash to the token's fingerprints, else abort)
  │                                   │ worker: bind proof valid → node keys "bound"; only then jobs and sealed values
  │                                   │◀──── hello over mTLS (first heartbeat)
  │ node shows "active"; clusters discovered → admin confirms each cluster   │
```

**[DECIDED]** (Wave 5 Phase 2) The agent reads the token from a file or from
standard input (`exponetdb-node enroll --token-file PATH|-`), never from its
command line, where other local users could read it while it is valid. A
host that is already enrolled refuses to enroll again: a re-installed host
is a new node, and its old state is removed first.

**[DECIDED]** (Wave 5 Phase 2, `agent/node/internal/enroll`, `internal/transport`)
On the enrollment connection the gateway presents its certificate chain up
to and including the root; the agent picks the root out of it by the
token's fingerprint and verifies the server certificate against that root
for the token's server name and `serverAuth`. Every connection is TLS 1.3
with ALPN `h2`; a gateway that does not agree to HTTP/2 is refused inside
the handshake, before any request is sent. The agent keeps the root it
pinned and verifies every later connection against it alone. It accepts
the issued certificate only if it carries the agent's own TLS key, has
`CN` and SAN URI of this node and installation, and verifies against the
pinned root with `clientAuth` through every intermediate.

**[DECIDED]** Token properties:

- single use, 30-minute lifetime, bound to one server record;
- carries the gateway address and the **SHA-256 fingerprint of the ExponetDB
  root CA**, so the agent can verify the gateway on first contact without
  trust-on-first-use, and **[DECIDED]** (OD-23) the fingerprints of the
  current job-signing keys, so the agent never trusts a job key the gateway
  alone vouches for; format and proofs in [`protocol.md` §7.3, §7.4](./protocol.md#73-enrollment-token-exdbt1);
- the token string is shown once to the human who created it and stored only as
  a hash; it is never sent through MCP.
- Enrollment requires `registry.manage` and re-authentication; for prod-tier
  servers (servers that will host prod targets) an approval is not required
  because enrollment alone grants nothing: clusters must still be confirmed, and
  every capability job is planned and authorized separately.

## 4. Renewal and rotation

- At two thirds of the certificate lifetime, the agent sends `renew` over its
  current mTLS session with a new TLS public key, its proof of possession and
  a signature by the node signing key ([`protocol.md` §7.4](./protocol.md#74-enrollment-and-renewal-proofs));
  a new key pair each time, swapped atomically with the certificate.
- The gateway issues the new certificate if the node is `active` or `degraded`.
- **[DECIDED]** (Wave 5 review) A crash between the renewal and the agent
  storing its new certificate must not lock the node out. The gateway keeps
  the replaced certificate as `previous_certificate` and accepts it until the
  renewed one is first presented, which retires it; a renewal from that
  previous certificate (the agent lost the one it was issued) replaces the
  lost one, which is never accepted again. The agent stores the new
  certificate before it uses it and then sends every request over a new
  connection, so the renewed certificate is presented at once (an HTTP/2
  connection with a request in flight never becomes idle).
- If renewal fails repeatedly, the node becomes `degraded` with
  `certificate_expiring` and a finding; at expiry it is `offline`.

## 5. Revocation and decommissioning

- `node.revoke` (plan, `high`, re-authentication): node state `revoked`; the
  gateway refuses each of its requests from then on (an open session ends
  at its next request, within one heartbeat interval); waiting jobs are
  canceled; a running job can no longer be reported and turns
  `outcome_unknown` at the end of its lease; effects that already happened
  are reconciled, never assumed undone; audit. A revoked node no longer
  holds the server's node slot (I-6 counts only non-terminal nodes), so the
  server can enroll a new node.
- `node.decommission`: the same for a node that is retired on purpose; the
  host should then uninstall the package (runbook).
- Re-installing a host creates a **new** node id; the old node remains in history.

## 6. Edge cases

| Case | Handling |
|---|---|
| Token stolen before use | It works only from a host that can reach the private gateway, only for that server record, only within 30 min; the admin sees the enrollment and the reported host facts (hostname, machine-id hash, OS) and must confirm clusters before anything happens. A suspicious enrollment is revoked. |
| Two enrollments for the same server | The second is refused while a non-terminal node exists (I-6). |
| Host cloned from an image with an enrolled agent | **[PLANNED: Phase 6]** Both copies present the same certificate; the gateway sees two concurrent sessions for one node id → both rejected, node `degraded` with `duplicate_identity`; re-enroll the intended host. Today the copies share one node: one long poll per node at a time, and the first renewal leaves the other copy's certificate unusable. |
| Clock wrong on host | TLS fails or jobs are refused (skew); the agent reports skew in `hello`. |
| Gateway address changes (move to `exponet-01`) | A signed `config.update` job delivers the new address and the root fingerprint (unchanged) before the old gateway stops. The agent supports it; the Control Plane does not send it in Wave 5, since the gateway's certificate must name the old and the new name while nodes move. **[OPEN: OD-27]** |
