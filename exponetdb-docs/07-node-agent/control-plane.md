# Node agent: the Control Plane side

| | |
|---|---|
| Status | **[DECIDED]** Wave 5 Phase 3 design (2026-10-07), capability operations Phase 5 (§9, 2026-10-07), within [ADR-0024](../01-architecture/adr/0024-node-trust-model.md) and the accepted node-agent baseline; implemented in `packages/nodes`, the Control Store bundle `nodes`, the `gateway` and `worker` roles |
| Applies to | Wave 5 |
| Read before | [`architecture.md`](./architecture.md), [`enrollment.md`](./enrollment.md), [`protocol.md`](./protocol.md), [`security.md`](./security.md) |

This document says how the Control Plane holds node state, issues tokens and
certificates, serves the agent API, signs and dispatches jobs and judges
results. The agent side is in [`architecture.md`](./architecture.md).

## 1. Who holds what

| Material | Holder | Never held by |
|---|---|---|
| Agent root CA private key | the owner, offline (written once by `exponetdb node-pki init`, then not kept) | every process |
| Issuing CA and gateway server CA keys | the `gateway` secrets consumer (`se1`) | worker, serve |
| The gateway's TLS key | the running gateway process, in memory only: it mints its own 72-hour certificate from the server CA at start and daily (§3) | every other process; never stored |
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
| `nodes.pki` | one row: root certificate and fingerprint, issuing CA and server CA certificates, the gateway URL and server name, references to the gateway-consumer secrets of the two CA keys | migrate (empty), `node-pki init` (as worker, see §3) |
| `nodes.job_keys` | key id, Ed25519 public key, fingerprint, state (`active`, `retiring`, `retired`), the worker-consumer secret of the private key | worker |
| `nodes.enrollment_tokens` | token id (`ent_`), server, the anchored job keys, state (`created`, `issued`, `used`, `expired`), `redeem_hash`, the worker-consumer secret of `k_bind`, `issued_at`, `expires_at`, the operation that created it and the identity that may reveal it | worker (create), serve (issue), gateway (redeem, through a function) |
| `nodes.nodes` | node id (`nod_`), server, state, the three public keys, the current certificate and its expiry, the certificate the last renewal replaced until the renewed one is first presented ([`enrollment.md` §4](./enrollment.md#4-renewal-and-rotation)), `bind_proof` until checked, `bound_at`, host facts, agent version, capabilities, last hello and heartbeat | gateway (enroll, hello, heartbeat, renewal), worker (binding, revoke, decommission) |
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
`outcome_unknown`, `canceled` (only before it started). A job not started within 60 s of
dispatch returns to `pending` (the identical envelope); a running job without
progress within its lease turns `outcome_unknown`; a pending or dispatched job
past `expiresAt` turns `expired`.

## 3. PKI bootstrap (`exponetdb node-pki init`)

An operator command, run once per installation, with the keyring and the
worker's Control Store login:

1. generates the Ed25519 root key, the issuing CA key and the gateway server
   CA key, and issues their certificates (root 10 years, CAs 5 years; the
   `packages/nodes` profiles);
2. writes the root's private key to the file the owner names (mode `0600`,
   refused if it exists) and keeps no copy;
3. stores the certificates, the gateway URL and the server name in
   `nodes.pki` and the two CA keys as gateway-consumer secrets;
4. generates the first job-signing key as a worker-consumer secret and
   records its public key;
5. prints the root fingerprint, which every enrollment token carries.

**[DECIDED]** (Phase 3) The gateway's TLS identity is not part of the
ceremony: the gateway generates a key in memory at start and issues itself a
72-hour certificate from the server CA for the configured server name, and
mints a new one daily. Nothing about it is stored, so it needs no rotation
ceremony; the server CA key it uses is a gateway-consumer secret anyway.
Rotation of the issuing CA or the server CA uses the offline root again (a
later ceremony; documented with the runbooks).

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
`clientAuth`. **[DECIDED]** (Phase 3) Without the variable nothing listens;
with it the gateway waits for the PKI (readiness `agent_listener` fails
until then) and serves the agent API through `packages/application`
(`apps/server/src/interfaces/gateway`). TLS verifies the client chain
against the root with OpenSSL's client purpose (the issuing CA allows
`clientAuth` only); an unverified or absent certificate is refused on every
endpoint but `enroll`. Per request:

- every request: the protocol and agent-version headers
  (`NODE_PROTOCOL_UNSUPPORTED`), the size limits (enrollment 16 KiB, a
  heartbeat 64 KiB, anything else 1 MiB), a body deadline of 10 s, strict
  JSON without U+0000 (`VALIDATION_FAILED`), the message schema;
- **[DECIDED]** (Phase 3 review) bounds: at most 1024 connections and 64 MiB
  of request bodies in flight across them (a body over the budget or the
  deadline has its stream reset, which the agent retries); a session without
  a verified client certificate gets one stream and is closed after its
  request, and each address gets 20 such requests a minute
  (`RATE_LIMITED`); one long poll per node at a time (`RATE_LIMITED`);
  refusals of enrollment, proofs and certificates are logged at `info` with
  the token or node id;
- `enroll`: no client certificate; proofs of possession, then the token
  (`NODE_ENROLLMENT_REFUSED`, one code for every token failure), then I-6
  (`NODE_ALREADY_ENROLLED`); issues the 72-hour certificate, creates the node
  `pending_binding` with the bind proof, audits `node.enrolled`;
- every other endpoint: the client certificate must be the node's current
  certificate and the node `active` or `degraded` (`NODE_CERTIFICATE_REFUSED`);
  `hello` and `heartbeat` also accept `pending_binding` so that a freshly
  enrolled agent can report while the worker binds it, but such a node
  receives no job and can complete none;
- `renew`: the renewal proof and the node signature over the new key, then a
  new certificate, which replaces the current one (`node.certificate_renewed`);
- `claim`, `start`, `progress`, `complete`: the job state machine of §2 for
  this node only; `claim` hands out the envelope as the worker stored it and
  `complete` stores the completion as the agent sent it (not a schema's
  output), leaving the verdict to the worker.

Heartbeats and hello facts are gateway-sourced observations: shown with their
source, never deciding an operation.

## 6. Worker

- **Binding:** for each `pending_binding` node, the worker opens the token's
  `k_bind`, checks the bind proof over the node's keys (ADR-0024 §2), marks
  the node `active` with `bound_at`, never reads the bind secret again
  (§1), and audits `node.bound` with the token's id; a proof that fails makes
  the node `binding_failed`. A node whose binding cannot be decided (a bind
  key the keyring cannot open, a database error) stays pending, is tried
  again on the next run and never holds up the others.
- **Jobs:** a capability operation builds the envelope (job id, nonce, the
  60-minute ceiling on its window, `argsHash`), seals every sealed field to
  the node's bound encryption key (`ns1`) and signs it with the active job
  key; it then waits for the completion. A completion counts as node
  evidence only if its `nr1` signature verifies against the node's bound
  signing key, and a delivery rejection (`signature_invalid`,
  `unknown_signing_key`, `journal_corrupt`; and `job_replayed`, which the
  agent never sends, protocol.md §4.2, so the worker treats it the same way)
  never counts as evidence that the job did not run ([`protocol.md` §4.2](./protocol.md#42-verification-by-the-agent-before-anything-executes));
  the operation's verification still runs independently.
- **Revocation and decommissioning:** `node.revoke` and `node.decommission`
  (stored plans, re-authentication) set the node's state, written only if it
  is still the state the plan was bound to; the gateway refuses the node at
  its next request (within one heartbeat interval). **[DECIDED]** (Phase 3
  review) Revocation is an immediate cut-off: pending and dispatched jobs are
  canceled; a running job can no longer be reported or asked to stop, so it
  turns `outcome_unknown` when its lease ends and is reconciled from the
  host, never assumed undone; the audit event counts such jobs.
- **Job-key rotation:** `node.config.update` signs a `config.update@1` job
  with a currently trusted key.

## 7. Interfaces

| Route | Action |
|---|---|
| `GET /nodes`, `GET /nodes/{nodeId}` | `node.list`, `node.get` |
| `POST /servers/{serverId}/nodes/enroll` | `node.enroll.plan` (a record); `plan.apply` runs `node.enroll` (high, re-authentication 300 s) |
| `POST /enrollment-tokens/{tokenId}/reveal` | `node.enrollment_token.reveal` (Web App, human, re-authentication 300 s; the token's applying identity only; inline, low class like a credential submission: applied at once and verified in its transaction by reading the issued token back; the binding of the node that redeems it names the token in `node.bound`) |
| `POST /nodes/{nodeId}/revoke`, `/decommission` | `node.revoke.plan`, `node.decommission.plan`; `plan.apply` runs `node.revoke`, `node.decommission` (high, re-authentication 300 s) |
| `POST /nodes/{nodeId}/inspections` | `node.inspect` (low: planned and accepted in one call, run by the worker; §9.2) |
| `GET /nodes/{nodeId}/observations` | `node.get` (the latest node-signed observations, §9.2) |
| `POST /nodes/{nodeId}/plans` | `node.plan` (a record); `plan.apply` runs the `postgres.*` kind (§9.3) |
| `POST /clusters/{clusterId}/credentials/{role}/rotate` | `node.plan` (a record); `plan.apply` runs `credential.rotate` (§9.7) |

**[DECIDED]** (Phase 3) The plan of `node.enroll` fixes the token id
(`content.tokenId`, shown in the plan's change); the worker creates the
record with it, so the person knows which token to reveal without the
secret ever entering a plan or an operation. Reads: the lifecycle state from
the Control Store (`pending_binding` reads `pending_enrollment`); an active
node without a heartbeat for 60 s reads `offline`; what the agent last
reported carries `source` (`agent_reported`, or `inferred` before any
heartbeat) and `observedAt`. Revocation and decommissioning cancel waiting
jobs; running ones are left to their lease and reconciled (§6), never assumed
undone.

## 8. Boundaries

`packages/nodes` may import `contracts`, `control-store`, `audit`, `policy`,
`operations`, `registry` and `secrets`, as `registry` does; the server's
composition and tests may import `nodes`. The agent API handler
(`apps/server/src/interfaces/gateway`) calls `packages/application`, never
`nodes` directly, as every interface does
([`package-architecture.md`](../01-architecture/package-architecture.md)).

## 9. Capability operations

**[DECIDED]** (Phase 5, 2026-10-07) How the Control Plane plans, executes and
verifies the PostgreSQL capabilities of [`capabilities.md`](./capabilities.md)
through a node. It refines [`capabilities.md` §2](./capabilities.md#2-planapply-pattern-for-node-operations):
`serve` cannot sign a job, so it never waits for a host while it makes a plan;
the node's analysis comes from an observation that the worker collected
before, and the node checks it again when the change runs.

### 9.1 The cluster a job acts on

An operation names a registry cluster (`cls_…`). It reaches the cluster
through a node only when all of the following hold, checked when the plan is
made, when it is accepted and again under the operation's locks:

- the cluster is `management_mode = 'agent'` and `active` (its system
  identifier is pinned); an `external` cluster answers `CAPABILITY_UNAVAILABLE`;
- the cluster's server has a node in state `active` or `degraded`
  (`NODE_REVOKED` for a revoked node; a node without a heartbeat for 60 s is
  `NODE_OFFLINE`);
- the node's latest `hello` lists a local instance whose `systemIdentifier`
  equals the cluster's pinned one, otherwise `REGISTRY_CONFLICT` with reason
  `cluster_unmapped`. Its `localName` and `systemIdentifier` go into every job
  as `cluster`, and the agent refuses a job whose instance has another
  identifier (`precondition_failed`, [`protocol.md` §4.2](./protocol.md#42-verification-by-the-agent-before-anything-executes));
- the node accepted every capability the operation needs in its last
  `hello`, otherwise `CAPABILITY_UNAVAILABLE`.

The operation's tier is the cluster's derived tier; a cluster without one
counts as production (fail closed). The plan's subject names the cluster,
its server, the node and the tier.

### 9.2 Observations (`node.inspect`)

`node.inspect` (class `low`, permission and scope `nodes.plan`: it runs a job on
the host, so it needs the right to plan there; no exclusivity) runs one
read or plan capability (never an apply) on one node. One request plans and
accepts it (`POST /nodes/{nodeId}/inspections`); the worker signs the job,
waits for its completion and keeps the result as an **observation**
(`nodes.observations`): node, cluster (or none), capability, the job's
`argsHash`, job and operation ids, the time the worker judged it, and the
result. A result is kept only when its `nr1` signature verifies against the
node's bound key and it matches the capability's result schema; otherwise
the operation fails and nothing is kept. The operation is verified by
reading the observation back.

Observations are the node's word, shown with their source (`agent_reported`,
its `nr1` verified) and time; anyone with `nodes.read` reads them (`GET /nodes/{nodeId}/observations`, the latest per capability,
cluster and arguments). They are the basis of plans (§9.3); they never decide
anything by themselves. Heartbeats stay gateway-sourced observations (§5).

### 9.3 Plans (`node.plan`)

`POST /nodes/{nodeId}/plans` (action `node.plan`) takes `kind`, `clusterId`
and the kind's change; `credential.rotate` has its own route
(`POST /clusters/{clusterId}/credentials/{role}/rotate`). `serve` validates
the change against the kind's schema, resolves §9.1 and requires the **basis
observation**: a node-signed observation of the kind's basis capability for
this cluster (and, for a node plan capability, for exactly these arguments),
at most 10 minutes old, otherwise `NODE_OBSERVATION_STALE`. The plan content
is the exact change and the mapping; the expected state binds the node id
and state, the mapping and the basis observation's digest; the analysis is
taken from the observation, so the person approves what the node reported.

| Kind | Change | Basis observation (its digest) | Analysis, refusals at plan time | Jobs at apply |
|---|---|---|---|---|
| `postgres.reload` | — | `postgres.status` | the instance must be running | `postgres.status` (still running, else `PLAN_STALE`), `postgres.reload` |
| `postgres.restart` | — | `postgres.restart.plan` (a digest of running base backups, running maintenance and active replication slots; connections are shown, not bound) | connections, backups, maintenance, slots and pending-restart parameters as reported | `postgres.restart.plan` (its digest must equal the basis), `postgres.status` (the start time before), `postgres.restart` (`fast`) |
| `postgres.config.apply` | `changes` (name, value or `null` to remove), `reload` | `postgres.config.plan` for exactly these changes (`configVersion`) | per parameter: validity, current value and source, context, effect, conflict; refused when a parameter is invalid, overridden by `postgresql.auto.conf` or a later file, or the managed include is missing | `postgres.config.inspect` (its `configVersion` must equal the basis), then `postgres.config.apply` with the complete fragment: the managed parameters the inspection reports, changed as planned |
| `postgres.hba.apply` | `managedRules` (the complete managed block), `protectedAccess` | `postgres.hba.inspect` (`fileDigest`) | the foreign rules stay as they are and are shown; the managed block before and after; the protected access the plan adds (§9.6) | `postgres.hba.apply` with the basis digest; the agent always protects its own peer access as well (§9.6) |
| `postgres.roles.apply` | typed `steps` (no `set_password`: a verifier is never in a plan) | `postgres.roles.inspect` (`rolesDigest`) | each step with its class, from the step and the observation: `critical` for `createrole`, `replication` or `bypassrls`, and for a membership in a predefined `pg_*` role or in a role that has, or reaches through its own memberships, a privileged attribute or a predefined role; `high` otherwise. The plan's class is `critical` when any step is (the action's class is decided by its plan). Refused (`VALIDATION_FAILED`): a step on one of ExponetDB's own roles, and a grant to a predefined role or to a role one of ExponetDB's roles is a direct or indirect member of (it would widen every holder; the agent refuses both too, transitively, on the live catalog) | `postgres.roles.apply` with the basis digest |
| `postgres.extensions.apply` | `database`, typed `steps` | `postgres.extensions.inspect` of that database (`extensionsDigest`) | each step's version must be available on the host (otherwise refused: a missing package) | `postgres.extensions.apply` with the basis digest |
| `postgres.tls.rotate` | `dnsNames`, `ipAddresses`, `validityDays` (1 to 90) | `postgres.tls.inspect` (the current fingerprint) | the cluster's CA bundle must contain the installation's PostgreSQL CA (§9.5), otherwise `REGISTRY_CONFLICT` `ca_bundle_lacks_postgres_ca`; every name must be one the registry knows for the cluster, otherwise `tls_name_not_registered` | `postgres.tls.plan`, issue, `postgres.tls.rotate` |
| `credential.rotate` | the access role | `postgres.roles.inspect` (the role exists, can log in and is at its documented least privilege: attributes and direct memberships, otherwise `REGISTRY_CONFLICT` `role_privileges`) | the credential it replaces | `postgres.roles.inspect`, `postgres.roles.apply` with one `set_password` step |

Exclusivity: `cluster:<id>:config` for every kind above; `postgres.restart`
also takes `target:<id>:schema` of every target placed on the cluster
(operations-engine.md §7). `node.inspect` takes none.

### 9.4 Execution and outcomes

The worker runs an accepted operation in three steps, each a signed job it
waits for (the operation's lease is renewed meanwhile):

1. **Fresh basis.** It runs the basis capability again; a digest that differs
   from the plan's ends the operation `not_applied` with `PLAN_STALE` before
   anything is sent that could change the host.
2. **Apply.** The apply job carries the digests the plan was bound to, and the
   agent checks them once more on the host (a change in between is
   `precondition_failed` there).
3. **Verification** (§9.6), by a separate read job after the apply job, never
   by the apply job's own report.

What a judged job means for the operation:

| The job ends | Evidence | Outcome |
|---|---|---|
| `succeeded`, `nr1` valid, result in schema | ran | `applied`, then verification |
| `failed`, `nr1` valid, no step named the capability's effect step | stopped before the effect point | `not_applied`: `PLAN_STALE` when the agent reports `precondition_failed`, otherwise `NODE_CAPABILITY_FAILED` with the agent's excerpt (redacted on the host) |
| `failed`, `nr1` valid, the effect step reported | may have changed the host | `unknown`, then reconciliation |
| `rejected` for the job itself, `nr1` valid | did not run | `not_applied`: `CAPABILITY_UNAVAILABLE` (`capability_unsupported`, `capability_disabled`), `JOB_EXPIRED` (`expired`, `not_yet_valid`, `clock_untrusted`, `start_unacknowledged`), otherwise `NODE_CAPABILITY_FAILED` with the reason (`precondition_failed`: the instance is unmapped, unreachable or has another system identifier) |
| `canceled`, `nr1` valid | did not run | `not_applied` |
| expired before it was ever handed out | did not run | `not_applied`, `JOB_EXPIRED` |
| canceled before it was ever handed out (because the node was revoked) | did not run | `not_applied` (`NODE_REVOKED`) |
| expired or canceled after it was handed out, without a node statement | nothing (the gateway alone wrote that state) | `unknown`, then reconciliation |
| a delivery rejection, an invalid `nr1`, a result outside its schema, or `outcome_unknown` | nothing | `unknown`, then reconciliation |

A node statement is judged over the job's state, also when it arrives late
(the gateway keeps late completions): a job the gateway reports expired but
the node states as run is judged by the statement. A job's first hand-out
(`first_dispatched_at`) is recorded once and never cleared, also when the job
goes back to pending after a lost dispatch (**[DECIDED]** Wave 5 Phase 5
review).

The agent reports the effect point as a step: right before it changes the
host it journals a step named after the capability's effect step with state
`running` (`agent.Run.BeginEffect`), so a `failed` statement says whether the
host may have changed.

**Reconciliation** (**[DECIDED]** Wave 5 Phase 5 review) never runs the apply
job again, and never judges the host while the job, or an effect it began,
can still change it:

1. **Only the lease holder creates jobs.** Every job (and the secret version
   of a credential rotation) is created in a transaction that checks that
   this worker still holds the operation's lease (`FOR SHARE`, so a takeover
   waits for it). An operation without an apply job will never have one.
   A failed lease renewal does not give the lease up; it is lost when the
   Control Store says another worker holds it, or when it ran out without a
   renewal.
2. **The job settles first.** A pending apply job is canceled; one handed out
   or running is asked to cancel (the agent honors it before the effect
   point; the gateway never starts a job with a cancel request) and waited
   for. Its end comes within its window, or within its start plus its run
   limit (§9.4.1). A statement that the job did not run, or ran, decides.
3. **Then the settle time.** An end that proves nothing, or a failure after
   the effect point, is waited past by the capability's settle time
   (contracts `settleSeconds`): from the statement for a stated failure,
   otherwise from the later of the end and the latest moment the agent could
   still be running the job (its start, or for a job never started its
   expiry, plus its run limit). A statement that arrives meanwhile is judged
   instead.
4. **Then the host.** The kind reads the host and decides `applied` when it
   shows the planned state, `not_applied` when it still shows the basis
   state, and `unknown` (needs attention) otherwise. A restart is judged on
   the host's own clock: the postmaster start time against the status read
   right before the restart job.

A reconciled operation is verified like any other (§9.6), by reads, without
the apply job's report. A `node.inspect` read changes nothing: its
reconciliation waits for the job's end and records the observation, or ends
`not_applied`. A retry is a new plan and a new job (OD-24).

#### 9.4.1 Run limits

Every capability has a run limit and a settle time in the contracts
(`runSeconds`, `settleSeconds`; 300 s and 95 s, a restart 720 s and 635 s).
The agent stops a capability at its run limit after the start; the gateway
never extends a running job's lease past its start plus its run limit and
one lease (60 s), so a job the node stopped reporting on ends
`outcome_unknown` within that bound. The settle time covers the root
helper's queue wait, its command limit and its kill delay, and the
statement timeout of the agent's own SQL ([`protocol.md` §4.3](./protocol.md#43-lifecycle-and-leases)).
A reconciliation therefore waits at most about 22 minutes after the job was
created (a restart about 38): the 15-minute window, the run limit and the
settle time.

Apply jobs live 15 minutes, read jobs 5 minutes: a node that is offline makes
the operation fail `JOB_EXPIRED` (when the job was never handed out), never
wait without end.

### 9.5 TLS: the PostgreSQL CA (OD-17)

The installation's PostgreSQL CA is a P-256 self-signed root (profile
`postgres_root`, 10 years), its key a worker-consumer secret, its certificate
in `nodes.postgres_ca`. `exponetdb node-pki postgres-ca` (operator, with the
worker's login and the keyring) creates it once and prints its certificate,
which goes into the CA bundle of every cluster whose server certificate
ExponetDB will issue. The registry keeps a cluster's CA bundle unchanged
(frozen Wave 4 bundle), and the Control Plane connects with `verify-full`;
so a rotation is refused unless the bundle already trusts this CA, which
keeps the Control Plane's own access working after the rotation.

`postgres.tls.rotate`: the host generates the key (`postgres.tls.plan`) and
returns its public key with a proof of possession over the job id; the worker
checks the proof, issues a `postgres_server` certificate (P-256, the planned
names, at most 90 days) and sends the chain (server certificate, CA) to
`postgres.tls.rotate` with the basis fingerprint. The private key never
leaves the host. The certificate names only what the registry knows of the
cluster: every DNS name is an active endpoint's TLS server name or host,
every IP address an active endpoint's host (**[DECIDED]** Wave 5 Phase 5
review: the CA is the installation's, so a name of another cluster would be
valid wherever that CA is trusted).

### 9.6 Verification by kind

| Kind | Passed when a fresh read shows |
|---|---|
| `postgres.reload` | the instance running and accepting connections, and the reload reported no file errors |
| `postgres.restart` | running and accepting connections, with a postmaster start time later than the status read right before the restart job (the host's clock against itself); when the job stated its result, its before and after times agree with them |
| `postgres.config.apply` | every planned parameter in the fragment with its value and no error, applied unless it needs a restart (then pending restart); removed ones gone; when the job stated its result, the fragment's digest is the one it wrote |
| `postgres.hba.apply` | the managed block holds exactly the planned rules, field by field and in order (type, databases, users, address and mask, method, map), and no rule has an error; when the job stated its result, the file digest is the one it wrote |
| `postgres.roles.apply` | every step visible in `postgres.roles.inspect` (roles and attributes, memberships, settings) |
| `postgres.extensions.apply` | every step's extension installed at its version |
| `postgres.tls.rotate` | the certificate's fingerprint is the issued one, and the cluster presents it to the Control Plane itself (a TLS session to its first direct endpoint, verified against its CA bundle and registered server name); when the job stated its result, its `fingerprint` and `presentedFingerprint` are the issued one too |
| `credential.rotate` | a login with the new credential over `verify-full` with the pinned identity and the role's documented least privilege; the credential is activated and the one it replaces retired in that transaction |

`postgres.hba.apply` keeps ExponetDB's own access: the plan's
`protectedAccess`, and always the agent's own peer access over the local
socket, which the agent adds itself; a block that would lock either out is
refused before reload and the previous file is put back (G5 item 7). The
plan's `protectedAccess` is the person's list plus, made by `serve`
(**[DECIDED]** Wave 5 Phase 5 review), the Control Plane's own network
access: every access role with an active credential on the cluster
(`exponetdb_<role>`, `scram-sha-256`), to every registered database (or
`postgres`), from every address in `EXPONETDB_EGRESS_ADDRESSES` (the
addresses `serve` and the worker reach managed clusters from,
[`deployment.md`](../12-operations/deployment.md)). A cluster with active
credentials cannot be planned without that setting (`REGISTRY_CONFLICT`
`egress_addresses_unknown`); at most 63 entries (the agent adds its own).

### 9.7 Credential rotation

`credential.rotate` (high, `registry.manage`, human only in V1) replaces the
password of one of ExponetDB's roles on an agent-managed cluster without a
person ever seeing it ([`credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)):

1. The worker generates the password (32 random bytes, base64url) and its
   SCRAM-SHA-256 verifier (4096 iterations, 16-byte salt).
2. Before any job, it stores the password as the next version of the role's
   `pg_credential` secret (the consumer of a submission: `observer` for the
   observer, `worker` otherwise).
3. It sends the verifier sealed to the node (`ns1`, field `verifier`) in one
   `set_password` step of `postgres.roles.apply`, bound to a fresh
   `rolesDigest`.
4. When the job applied (or its outcome is unknown), a `pending` credential
   points at that secret version (the worker may insert credentials, which
   the registry guard still restricts to a pending row of the cluster's own
   secret); verification logs in with it as in §9.6. A job that did not run
   writes no credential, and the unused secret version is never read. A
   worker that lost the operation's lease writes nothing: the lease holder
   reconciles, and logs in only once the job has settled (§9.4), so a
   password the node sets late is never judged too early. The login
   verification also checks every role the credential's role reaches
   through its memberships, so a predefined role widened behind ExponetDB's
   back (`pg_write_all_data` granted to `pg_monitor`) fails it.

The password is never in a plan, a job, an audit event, a log or a response;
the audit names the credential, the role and the secret version.

### 9.8 Boundaries of Phase 5

`postgres.databases.apply` and `packages.apply_update` are not Wave 5
(G5 record §2). `node.config.update` (job-key rotation and the gateway
address, `config.update@1`) is planned like the other kinds but needs a
staged job-key state; it is Phase 6 work and stays open in the G5 record
until it is built. The MCP tools for these operations arrive with Wave 7.
