# ADR-0024: Node trust model: anchored job keys, bound node keys, sealed payloads, job identity and time

| | |
|---|---|
| Status | **Proposed, awaiting the owner's decision** (OD-23, OD-24). Nothing in Wave 5 that stores or sends a security-relevant key, payload or protocol message is implemented before the owner decides |
| Date | 2026-10-07 |
| Related | [ADR-0014](./0014-node-agent-outbound-mtls.md); [`../../07-node-agent/enrollment.md`](../../07-node-agent/enrollment.md), [`protocol.md`](../../07-node-agent/protocol.md), [`security.md`](../../07-node-agent/security.md); [`../../08-auth-and-security/secrets.md`](../../08-auth-and-security/secrets.md); OD-17, OD-18, OD-20 (resolved 2026-10-07); [G5 record](../../14-roadmap/gates/5.md) |

## Context

The Wave 0 baseline of the node agent (ADR-0014 and the `07-node-agent`
documents, accepted 2026-10-05) claims that a compromised gateway "cannot
forge or alter jobs" and that secrets travel sealed to the agent's key. The
Wave 5 order asks for a concrete design of six points before anything
security-relevant is stored or sent. Reading the baseline against its own
claims (G5 record §2) shows that the claims do not hold as written:

1. **First trust in job-signing keys.** The agent receives the job-signing
   public key "at enrollment" in the gateway's response
   ([`enrollment.md` §3](../../07-node-agent/enrollment.md#3-enrollment-flow),
   [`protocol.md` §4.2](../../07-node-agent/protocol.md#42-verification-by-the-agent-before-anything-executes)).
   The token pins only the root CA. A compromised gateway therefore chooses
   the key every new agent trusts, and then forges any job for that agent.
2. **Confidentiality against the gateway.** The gateway terminates TLS and
   reads every envelope. SCRAM verifiers (offline-crackable when a person
   chose the password) are planned as plaintext `args`; the "sealed box to
   the agent's key" has no construction, no recipient key (the TLS key
   rotates every 48 h) and no way for the worker to authenticate that key
   (the gateway writes node certificates).
3. **Authenticity of bindings and results.** The token proof does not bind
   the host's keys; results and verification outcomes are unsigned and pass
   through the gateway; the issuing CA (gateway-held) can mint a certificate
   for any node. The baseline's compromise table understates this.
4. **Job identity.** "A `jobId` executes at most once" and "retries are new
   attempts of the same job id" contradict each other; re-dispatch after a
   lost claim, the nonce cache and the journal disagree on what is replay.
5. **Time.** Validity windows use the agent clock, but nothing says when
   that clock is trustworthy; the gateway's `serverTime` is unsigned;
   cancellation has no semantics; `failure-model.md` says in-flight jobs may
   be "resumed", the protocol says never.
6. **Re-authentication.** `enrollment.md` requires re-authentication for
   enrollment; the contract (`actions.ts`) gives `node.enroll`, `node.revoke`
   and `node.decommission` `reauthentication: false`.

Points 1 to 4 change **accepted** baseline decisions; the order forbids
changing them silently. This ADR is the decision document. Points 5 and 6 are
corrections where the baseline is silent or the code disagrees with an
accepted document (the document wins).

## Decision (proposed)

### 1. Job-signing keys are anchored by the token, not by the gateway (OD-23 a)

- The **enrollment token** carries, in addition to the gateway address and
  the root fingerprint, the **job-signing key set**: for each currently valid
  key its `keyId` and the SHA-256 of its raw 32-byte Ed25519 public key. The
  token reaches the host through the person who created it (Web App or CLI,
  re-authenticated) and the operator who pastes it, never through the
  gateway; that out-of-band path is the trust anchor.
- At enrollment the agent accepts the public keys from the gateway's
  response only if they hash to the token's entries; otherwise it aborts.
- **Rotation** keeps the baseline mechanism: `config.update@1`, signed by a
  currently trusted key, adds a new key; the old key stays valid for an
  overlap of 7 days and is then retired by a second signed update. The agent
  holds at most three keys.
- **Recovery** from a stolen signing key is re-enrollment of every node with a
  new token (the thief can also sign rotations). This is stated as the
  residual it is.
- *Alternative:* key statements signed by the offline root (each rotation
  needs the offline root key). Stronger recovery, one more offline ceremony
  per rotation; not proposed for a one-person V1, kept as the upgrade path.

### 2. Node keys are bound through the token; results are signed (OD-23 b)

- At enrollment the host generates three key pairs, none of which leaves it:
  the **TLS key** (Ed25519, renewed every 48 h as decided), a long-term
  **node signing key** NSK (Ed25519) and a long-term **node encryption key**
  NEK (X25519).
- The token secret `s` (256 bits, CSPRNG) is never sent. The agent proves it
  with two HMAC-SHA-256 values under keys derived by HKDF-SHA-256 from `s`:
  - `redeemProof` (key `exponetdb/enroll/redeem/v1`) over the JCS of the
    request without proofs: checked by the **gateway**, which holds only the
    redeem key (encrypted for the gateway consumer) and the hash of the token
    id;
  - `bindProof` (key `exponetdb/enroll/bind/v1`) over
    JCS(`{installationId, serverId, tokenId, tlsKey, nsk, nek}`): checked by
    the **worker**, which alone holds the bind key (encrypted for the worker
    consumer). The gateway cannot compute it.
- The worker marks a node's NSK and NEK **bound** only after `bindProof`
  verifies; no job is signed for, and nothing is sealed to, a node whose keys
  are not bound. A compromised gateway that redeems a stolen token enrolls a
  node the worker never binds.
- The NSK signs every job completion: Ed25519 over JCS of the complete
  request plus `installationId` and `nodeId` (`nr1`). The worker accepts a
  result as **node evidence** only with a valid signature by the bound NSK;
  it remains evidence, never verification: the worker still checks
  independently over SQL (the order's "a compromised node can still lie").
- NEK rotation (when wanted) is a statement signed by the NSK.
- Certificates: the agent PKI uses Ed25519 throughout. The node certificate's
  SAN URI gains the installation: `urn:exponet:exponetdb:node:<installationId>:nod_…`.
  The issuing CA certificate is restricted to EKU `clientAuth`, the gateway
  server CA to `serverAuth`, so a certificate from the gateway-held issuing CA
  never verifies as a gateway server certificate (Go enforces EKU nesting).
  The gateway records each node's current certificate and refuses a
  different valid certificate for the same node.
- Certificates are issued from a public key plus a proof-of-possession
  signature in JSON, not from a PKCS#10 CSR: the host cannot propose any
  name, extension or CA bit, and the Control Plane parses no ASN.1. The
  Control Plane encodes certificates of one fixed profile with a small DER
  encoder in `packages/nodes`, verified in tests by Go `crypto/x509` and
  `openssl`.
- The **PostgreSQL server CA** (OD-17) is a separate key pair held by the
  **worker** consumer only (P-256, for client compatibility); the gateway
  never holds it, so a compromised gateway cannot mint server certificates
  the worker trusts.

### 3. Sealed payloads: `ns1` (OD-23 c)

- `ns1` = HPKE ([RFC 9180](https://www.rfc-editor.org/rfc/rfc9180)) base
  mode, single shot: DHKEM(X25519, HKDF-SHA256), HKDF-SHA256, AES-256-GCM.
  Recipient: the node's bound NEK. `info` = `exponetdb/sealed/ns1` LF
  JCS(`{installationId, nodeId, jobId, operationId, capability, purpose}`).
- A sealed value appears in `args` as `{ "ns1": { "enc": …, "ct": … } }`, so
  the envelope signature and `argsHash` cover the ciphertext.
- Implemented by hand in TypeScript (`node:crypto`) and Go (standard library
  `crypto/ecdh`, `crypto/hkdf`, `crypto/aes`); both pass the RFC 9180 test
  vectors for the shared KEM and key schedule and golden `ns1` vectors that
  are locked like every other vector. No new dependency.
- Sealed: SCRAM verifiers (`postgres.roles.apply`, `credential.rotate`),
  later backup credentials. Never sealed or sent: PostgreSQL TLS private keys
  (they are generated on the host and stay there, OD-17).
- Secrets never appear in plan or operation JSON, job tables, journals,
  result spools, logs, traces or metrics: plans hold secret references bound
  to a concrete version; the worker resolves and seals at dispatch.

### 4. Job identity: one envelope, one execution; a retry is a new job (OD-24)

- A `jobId` names one signed envelope; the agent executes it at most once.
  The agent journals `accepted` durably (fsync) **before** it acknowledges
  `start`; a re-delivery of an accepted envelope is `job_replayed`.
- A re-dispatch after a lost claim delivers the **identical** envelope (same
  nonce, same signature); the agent has not accepted it, so it is not
  replay. The journal state `claimed` is dropped.
- An operation-level retry is always a **new job**: new `jobId`, new nonce,
  new signature, `attempt` + 1 (signed, informational). The worker creates
  one only for capabilities whose reconciliation is `idempotent` and only by
  an explicit decision recorded on the operation. This replaces "new
  attempts of the same job id"; there is no `(jobId, attempt)` key.
- Validity: `expiresAt − notBefore` ≤ 15 minutes by default and never more
  than 60 minutes; the agent refuses longer windows. The nonce cache keeps
  entries 7 days (longer than any window), persistent and bounded; the
  journal keeps 90 days. A journal or nonce cache that fails its checksum
  makes the agent refuse every job (`journal_corrupt`) until a local
  operator repairs it; nothing is executed on a guess.

### 5. Time, leases, cancellation and crashes (corrections)

- The agent trusts its host clock only while the host reports synchronized
  time (systemd's `NTPSynchronized`), and refuses jobs otherwise. It persists
  the highest `issuedAt` it accepted; a host clock earlier than that by more
  than 30 s is a rollback and refuses jobs. The gateway's `serverTime` is
  advisory (skew reporting only).
- Leases stay as documented (start within 60 s, lease 60 s, progress every
  ≤ 20 s). Cancellation: each capability declares its effect point; before it
  the agent stops and completes `canceled`; after it the agent finishes and
  reports the effect. Cancellation never claims a rollback.
- After a crash, `started` without `completed` is reported as
  `outcome_unknown` and never resumed (`failure-model.md` is corrected).
- Gateway acknowledgements, leases and transport state authorize nothing:
  an operation succeeds only through the worker's verification.

### 6. Re-authentication (correction)

`node.enroll` (which creates the token), `node.revoke` and
`node.decommission` require re-authentication within 300 s, as the accepted
documents say; the contract is corrected.

## Consequences

- Token format, enrollment messages, the result signature, `ns1` and the
  retry rule are new wire semantics: versioned (`exdbt1` token, `nr1`,
  `ns1`), with golden vectors in `tooling/golden/` and TypeScript and Go
  implementations that must agree byte for byte.
- A compromised gateway (or its issuing CA) can still: withhold, delay,
  reorder and drop jobs and results; read non-secret job arguments; mint TLS
  certificates (the gateway is the only party that relies on them); forge
  unsigned observations (heartbeats are shown as gateway-sourced and never
  decide an operation). It can no longer forge jobs, read sealed payloads,
  forge node results or bind a rogue node.
- A compromised worker remains bounded by the capability catalog (C-22).
- A compromised node can lie about its own results; independent
  verification over SQL is the control.
- The keyring is shared by the three roles (deployment.md); separation of
  the signing, bind and PostgreSQL CA keys from the gateway rests on Control
  Store grants per consumer, as for Wave 3. Stated as a residual.

## Alternatives considered

- **Trust on first use of the gateway's keys** (the baseline as written):
  rejected; it contradicts the baseline's own claim.
- **Root-signed job-key statements**: see §1; upgrade path.
- **A dependency for HPKE or X.509** (`x/crypto`, `@peculiar/x509`): rejected
  while the standard libraries suffice; the Go module allows no `require`.
- **`(jobId, attempt)` as the replay key**: rejected by the order.
