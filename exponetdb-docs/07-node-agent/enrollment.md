# Node enrollment, identity and certificates

| | |
|---|---|
| Status | Baseline (Wave 0), accepted 2026-10-05 |
| Applies to | Wave 5 |
| Read before | [`architecture.md`](./architecture.md), [`security.md`](./security.md) |

## 1. Identity

**[DECIDED]**

- A node's identity is its **node id** (`nod_…`) bound to a **key pair generated
  on the host** during enrollment. The private key never leaves the host.
- The control plane issues **short-lived X.509 client certificates** for that key
  from an ExponetDB-internal CA:
  - subject: `CN=nod_…`;
  - SAN URI: `urn:exponet:exponetdb:node:nod_…` (installation-scoped; a SPIFFE-style
    `spiffe://exponet.cloud/exponetdb/node/nod_…` is equally acceptable and can be
    adopted when an Exponet-wide workload identity system exists);
  - lifetime **72 hours**, renewed at two thirds of the lifetime;
  - key type ECDSA P-256 (or Ed25519 where both sides support it in TLS).
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
   └── Gateway server certificate CA (same root; issues the gateway's TLS server certificate, 90 days)
```

- The agent trusts **only** the ExponetDB root (pinned at enrollment via the
  token, §3) for the gateway's server certificate; not the public Web PKI.
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
  │  operator installs package, runs: exponetdb-node enroll --token <string> │
  │                                   │◀──── TLS to gateway (verifies server cert against pinned root fingerprint)
  │                                   │◀──── CSR (key generated locally) + token secret proof + host facts
  │                                   │ verify token (unused, unexpired, server matches), create nod_…,
  │                                   │ issue 72 h certificate, mark token used, audit node.enrolled
  │                                   │────▶ certificate chain + node id + config
  │                                   │◀──── hello over mTLS (first heartbeat)
  │ node shows "active"; clusters discovered → admin confirms each cluster   │
```

**[DECIDED]** Token properties:

- single use, 30-minute lifetime, bound to one server record;
- carries the gateway address and the **SHA-256 fingerprint of the ExponetDB
  root CA**, so the agent can verify the gateway on first contact without
  trust-on-first-use;
- the token string is shown once to the human who created it and stored only as
  a hash; it is never sent through MCP.
- **[OPEN: OD-23]** As written, the agent learns the job-signing keys from
  the gateway's enrollment response, so the gateway is trusted at first
  contact. [ADR-0024](../01-architecture/adr/0024-node-trust-model.md)
  proposes that the token also carries the job-key fingerprints and binds
  long-term node keys through the token secret; decided by the owner.
- Enrollment requires `registry.manage` and re-authentication; for prod-tier
  servers (servers that will host prod targets) an approval is not required
  because enrollment alone grants nothing: clusters must still be confirmed, and
  every capability job is planned and authorized separately.

## 4. Renewal and rotation

- At two thirds of the certificate lifetime, the agent sends `renew` over its
  current mTLS session with a new CSR (new key pair each time: key rotation comes
  for free).
- The gateway issues the new certificate if the node is `active` or `degraded`.
- If renewal fails repeatedly, the node becomes `degraded` with
  `certificate_expiring` and a finding; at expiry it is `offline`.

## 5. Revocation and decommissioning

- `node.revoke` (plan, `high`): node state `revoked`; the gateway closes its
  sessions and rejects it; outstanding jobs are canceled; audit.
- `node.decommission`: same plus the server record's node slot is freed; the host
  should then uninstall the package (runbook).
- Re-installing a host creates a **new** node id; the old node remains in history.

## 6. Edge cases

| Case | Handling |
|---|---|
| Token stolen before use | It works only from a host that can reach the private gateway, only for that server record, only within 30 min; the admin sees the enrollment and the reported host facts (hostname, machine-id hash, OS) and must confirm clusters before anything happens. A suspicious enrollment is revoked. |
| Two enrollments for the same server | The second is refused while a non-terminal node exists (I-6). |
| Host cloned from an image with an enrolled agent | Both copies present the same certificate; the gateway sees two concurrent sessions for one node id → both rejected, node `degraded` with `duplicate_identity`; re-enroll the intended host. |
| Clock wrong on host | TLS fails or jobs are refused (skew); the agent reports skew in `hello`. |
| Gateway address changes (move to `exponet-01`) | A signed `config.update` job delivers the new address and the root fingerprint (unchanged) before the old gateway stops. |
