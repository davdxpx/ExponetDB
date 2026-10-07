# Open decisions

| | |
|---|---|
| Status | OD-2, OD-3, OD-9 and OD-19 resolved on 2026-10-05; OD-5 resolved on 2026-10-06; OD-17, OD-18 and OD-20 resolved on 2026-10-07 (Wave 5 entry conditions); OD-20 and OD-21 added on 2026-10-05; OD-22 added on 2026-10-07 (G4 acceptance); OD-23 to OD-25 added on 2026-10-07 (Wave 5 design); OD-8: Wave 2 design settled on 2026-10-05, legal setting open; all other entries wait for the owner |
| Read before | [`../14-roadmap/implementation-waves.md`](../14-roadmap/implementation-waves.md) |

Only real decisions are listed: questions where the answer changes the design,
the security posture or the order of work, and that the documents cannot settle
on their own. Each entry has a recommendation; the documents describe the
recommended option as the working assumption and mark the affected text
`[OPEN: OD-n]`. Implementation of an affected part waits for the decision.

When the owner decides, the entry keeps its number, question, options and
reasoning as history and gains a status block (`Status: RESOLVED`, decision
date, decision). Text elsewhere that depended on it changes from `[OPEN: OD-n]`
to **[DECIDED]** with a link to the resolved entry.

## Summary

| # | Decision | Status | Recommendation or decision | Blocks | Owner needed |
|---|---|---|---|---|---|
| OD-1 | Web App language | open | English UI strings, German later via i18n keys | Wave 8 | yes |
| OD-2 | Node agent implementation language | **resolved 2026-10-05** | Go | (was Wave 5 and the Go golden vectors of Wave 1) | decided |
| OD-3 | Toolchain and runtime | **resolved 2026-10-05** | Bun workspaces + Turborepo + Vitest + Biome + TypeScript; Node.js 24 LTS for production server processes | (was Waves 1, 2) | decided |
| OD-4 | Backup engine | open | pgBackRest (version chosen and pinned at deployment) on Hetzner Object Storage with object lock, plus `pg_dump` + restic off-provider | Wave 9 | yes |
| OD-5 | MCP client registration policy | **resolved 2026-10-06** | option (a): pre-registered first-party clients; third-party CIMD clients only after an admin approves the exact `client_id` URL, bound to a fingerprint of its security metadata; DCR as deprecated compatibility that creates a pending public client (`none`) until approved; service-account clients pre-registered with `private_key_jwt`; no client secrets; no third-party client trusted at bootstrap | (was Wave 3B) | decided |
| OD-6 | Verified provenance for production migrations | open | not in V1; add repository integration or signed artifacts after Wave 10 | Wave 6 (production policy), later | yes |
| OD-7 | Manage REOSA's current hosted databases before the move | open | yes: read-only first, then import and staging migrations | Wave 10 | yes |
| OD-8 | Audit retention and personal data | **open (legal)**; Wave 2 design settled 2026-10-05 | permanent audit with pseudonymous labels; erasure pseudonymizes identities; default `permanent`, never below 400 days | Wave 9 (final setting); no longer Wave 2 | yes (legal) |
| OD-9 | Approval model for a one-person organization | **resolved 2026-10-05** | option (a): agent proposes, a human approves in the Web App; human-initiated plans may be self-approved with fresh re-authentication; `critical` self-approvals add an explicit acknowledgement, a 10-minute cooling period and a fresh re-authentication at apply | (was Waves 3A, 6) | decided |
| OD-10 | Future identity architecture | open | ExponetDB stays authorization server for its resources; federates login to the Exponet identity service later | later wave | yes |
| OD-11 | Exponet brand input for the Web App | open | wait for Exponet brand basics; neutral placeholder tokens until then | Wave 8 | yes |
| OD-12 | High availability and failover for managed clusters | open | no automated failover in V1; observe replication; revisit with a customer commitment | Wave 11 (stance), later | yes |
| OD-13 | Data reads by AI agents on production | open | `humans_only` by default per production target | Wave 7 | yes |
| OD-14 | Strictness of fingerprint lineage for production | open | warn for imported legacy projects, require approval after reconciliation | Wave 6 | yes |
| OD-15 | Policy probes in verification | open | not in V1; keep RLS behavior tests in consumer test suites | Wave 6 (scope), later | yes |
| OD-16 | Shadow apply before production | open | not in V1; staging is the shadow | Wave 6 (scope), later | yes |
| OD-17 | CA strategy for PostgreSQL server certificates | **resolved 2026-10-07** | option (a): an ExponetDB-managed PostgreSQL server CA per installation; the server's TLS key is generated on the host and never leaves it | (was Wave 5) | decided |
| OD-18 | Agent gateway exposure | **resolved 2026-10-07** | option (a): the node gateway listens on the private network only in V1 | (was Wave 5) | decided |
| OD-19 | ExponetDB license | **resolved 2026-10-05** | proprietary, internal, all rights reserved | (was Wave 1) | decided |
| OD-20 | PostgreSQL configuration ownership strategy | **resolved 2026-10-07** | option (b): a dedicated ExponetDB-managed include for its own parameters; no `ALTER SYSTEM` as the normal writer; foreign `postgresql.auto.conf` values never removed automatically; a missing include is reported as a bootstrap need and added by the local administrator in Wave 5 | (was Wave 5) | decided |
| OD-21 | Delivery channel for invitations and security notifications | open | an EU-hosted transactional e-mail provider over SMTP submission with TLS, configured per installation; links never in logs | production use of notifications (lockout, recovery); not Wave 4 | yes |
| OD-22 | Authority needed to register a database whose intended tier is unknown | open | a declared intended tier per cluster (optionally per database), set with `registry.manage` of that tier; registering any database of a cluster declared `prod` needs `registry.manage:prod` whatever environment it is placed in | first production registrations by people with nonprod authority only; Wave 5 or 6 | yes |
| OD-23 | Node trust model (Wave 5) | open | ADR-0024 §1 to §3: job-signing keys anchored by the enrollment token; long-term node keys bound through the token secret and verified by the worker; node-signed results; secrets sealed with `ns1` (HPKE); Ed25519 agent PKI with EKU separation; PostgreSQL server CA held by the worker | Wave 5 phases 1 to 5 | yes |
| OD-24 | Job identity and retries (Wave 5) | open | ADR-0024 §4: one signed envelope executes at most once; a re-dispatch repeats the identical envelope; an operation retry is a new job with `attempt + 1` | Wave 5 phases 1, 2, 5 | yes |
| OD-25 | Evidence environment for systemd (Wave 5) | open | a privileged disposable Ubuntu 24.04 systemd container first; otherwise a VM or runner the owner provides | G5 items 2 to 4 | yes |

---

## OD-1. Web App language

- **Question.** Are the Web App's user-facing strings English or German?
- **Why it matters.** Copy is written once per surface; switching later costs a
  pass over every screen. The owner's other product (REOSA) is German-only for
  end users; ExponetDB's users are internal engineers and AI agents.
- **Options.** (a) English; (b) German; (c) English with i18n keys from day one,
  German translation later.
- **Recommendation.** (c): English strings behind message keys. PostgreSQL,
  OAuth and MCP vocabulary is English, error codes are English, and agents read
  the same texts.
- **Blocks.** Wave 8.
- **Owner decision needed.** Yes.

## OD-2. Node agent implementation language

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-05
- **Decision.** Go. `exponetdb-node` (the unprivileged daemon) and
  `exponetdb-node-helper` (the local privileged helper) are written in Go.
  Reasons as recommended below: small static binary, no JavaScript runtime on
  database hosts, mature TLS/mTLS and system-level ecosystem, a clean fit for
  systemd and Unix sockets, and a clear separation from the TypeScript Control
  Plane. Cross-language contracts are secured through generated types and
  golden vectors.

History:

- **Question.** Is the node agent (daemon and root helper) written in Go or in
  TypeScript (compiled to a single binary)?
- **Why it matters.** The agent runs on every database host, partly as root. Its
  size, dependencies and memory safety define the host attack surface.
- **Options.** (a) Go; (b) TypeScript with a single-binary compiler (Bun or
  Node SEA); (c) Rust.
- **Recommendation.** (a) Go: static binary, no runtime on hosts, mature TLS and
  systemd tooling, small footprint. The cost is a second language; contracts are
  shared through generated types and golden vectors
  ([`../07-node-agent/architecture.md` §5](../07-node-agent/architecture.md#5-implementation-language)).
- **Blocks.** Wave 5 (and Wave 1 golden vectors in Go).
- **Owner decision needed.** Yes (given on 2026-10-05).

## OD-3. Toolchain and runtime

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-05
- **Decision.** Bun workspaces, Turborepo, Vitest, Biome and TypeScript. Bun is
  the package manager, workspace tool and development tooling. Node.js 24 LTS is
  the production runtime target for the TypeScript server processes. No
  production design may depend on Bun-only runtime features.

History:

- **Question.** Which workspace tooling and server runtime?
- **Why it matters.** Every package, CI job and developer workflow depends on it.
- **Options.** (a) Bun workspaces + Turborepo + Vitest + Biome, servers on
  Node.js 24 LTS; (b) the same with Bun as server runtime; (c) pnpm + Turborepo +
  Vitest + ESLint/Prettier.
- **Recommendation.** (a). It matches the owner's existing tooling knowledge
  (REOSA) while running production processes on the LTS runtime with the widest
  library support (PostgreSQL drivers, OpenTelemetry, WebAuthn libraries).
  Confirmed in a Wave 2 spike.
- **Blocks.** Waves 1 and 2.
- **Owner decision needed.** Yes (given on 2026-10-05).

## OD-4. Backup engine

- **Question.** Which engine takes physical backups and archives WAL, and where
  do repositories live?
- **Why it matters.** It determines RPO, verification strength, recovery
  procedures and the dependency on one open-source project's maintenance.
- **Options.** (a) pgBackRest; (b) WAL-G; (c) Barman; (d) native
  PostgreSQL incremental backups with ExponetDB managing chains. Storage: Hetzner
  Object Storage (S3 object lock), Cloudflare R2 (bucket locks), Hetzner Storage
  Box.
- **Recommendation.** (a) to Hetzner Object Storage with object lock, plus daily
  `pg_dump` + restic to a different provider. Note pgBackRest's 2026 maintenance
  interruption and the 2026-10-04 security advisory; the logical layer keeps
  recovery independent of the engine. Whichever engine is chosen, the deployed
  version is selected at deployment against the then-current stable release and
  advisories, pinned reproducibly, and never "always latest"
  ([`../09-backups-and-restore/backup-engines.md`](../09-backups-and-restore/backup-engines.md)).
- **Blocks.** Wave 9.
- **Owner decision needed.** Yes.

## OD-5. MCP client registration policy

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-06
- **Decision.** Option (a), with this semantics:
  - **First-party clients** are pre-registered: the ExponetDB Web App and
    the ExponetDB CLI. The CLI is a public native client (loopback
    authorization code with PKCE and the device authorization grant); both
    CLI flows use the same registered client. Clients of service accounts
    (CI, backends) are created administratively for a service identity,
    never through DCR; there is no built-in CI superclient.
  - **Third-party clients through CIMD** (preferred for modern external
    clients): the `client_id` is an HTTPS URL of a Client ID Metadata
    Document. **Discovery is not trust**: an unknown CIMD client cannot
    obtain consent until an administrator approves the **exact `client_id`
    URL** (no domain wildcard, no product name, no guessed vendor identity:
    nothing like "`*.example.com` approved"). The approval binds a
    fingerprint of the client's security-relevant metadata
    (`redirect_uris`, `token_endpoint_auth_method`, `application_type`,
    grant and response types, key material); when any of it changes, the
    client returns to review and needs a new approval. A change of display
    data alone (name, logo, links) is untrusted presentation data and never
    changes authority.
  - **No silent pre-trust.** Third-party clients are not trusted at
    installation bootstrap. Known clients may later appear as suggestions
    once their current official client ids are verified; even then the
    installation needs one deliberate admin approval (known client: one
    approval; unknown client: no consent until approved).
  - **DCR** (RFC 7591) is a deprecated compatibility path only. A
    registration creates a **pending** client, never a trusted one; while
    pending there is no consent, no authorization code and no token. An
    admin approves the exact registration (with re-authentication).
  - **No shared client secrets in V1.** Public clients (MCP, desktop, CLI,
    every DCR registration) use `token_endpoint_auth_method = none`;
    confidential clients (service accounts) are pre-registered and use
    `private_key_jwt`. `client_secret_basic` and `client_secret_post` are
    not supported; DCR never mints a `client_secret`.
  Implemented in Wave 3B ([`../05-mcp/oauth.md` §3](../05-mcp/oauth.md#3-client-registration)).
  This replaces the earlier working assumption that the known MCP clients'
  CIMD URLs would be pre-approved at bootstrap.

History:

- **Question.** How do MCP clients become known to ExponetDB's authorization
  server?
- **Why it matters.** Open registration lets any software ask a person for
  database scopes; closed registration excludes useful clients.
- **Options.** (a) CIMD allowlist + approval-gated DCR + pre-registered
  first-party clients; (b) open CIMD (any HTTPS client id) + open DCR;
  (c) pre-registration only.
- **Recommendation.** (a). The known clients work after one admin click; unknown
  clients cannot obtain consent until approved
  ([`../05-mcp/oauth.md`](../05-mcp/oauth.md)).
- **Blocks.** Wave 3B.
- **Owner decision needed.** Yes (given on 2026-10-06).

## OD-6. Verified provenance for production migrations

- **Question.** Must production migrations be proven to come from the protected
  branch of the consumer's repository?
- **Why it matters.** Without it, a bundle's source reference is a claim. With it,
  ExponetDB needs repository access or a signing pipeline.
- **Options.** (a) no provenance requirement (claims recorded); (b) ExponetDB
  fetches from Git at the commit (repository integration); (c) CI signs bundle
  artifacts that ExponetDB verifies.
- **Recommendation.** (a) in V1; staging evidence, checksum binding and human
  approval already bind what runs. Add (c) after Wave 10, because it needs no
  repository credentials in ExponetDB
  ([`../04-migrations/authoring-and-ci.md`](../04-migrations/authoring-and-ci.md)).
- **Blocks.** Production policy settings in Wave 6; feature in a later wave.
- **Owner decision needed.** Yes.

## OD-7. Manage REOSA's current hosted databases before the move

- **Question.** Does ExponetDB register and manage REOSA's Supabase-hosted
  databases (as external clusters) before REOSA moves to `reos-db-01`, or only
  after?
- **Why it matters.** The legacy import, evidence chain and drift detection are
  most valuable on the real history; but hosted providers limit roles and grants,
  and the effort could be spent twice.
- **Options.** (a) yes, read-only first, then import and staging migrations;
  (b) read-only only; (c) wait for the move.
- **Recommendation.** (a), with an explicit check in step 10.1 that the migrator
  design works on the hosted service; fall back to (b) otherwise. It also settles
  the open `0014` effect with evidence before the move
  ([`../13-integrations/reosa-integration.md` §3](../13-integrations/reosa-integration.md#3-wave-10-integration-on-the-current-databases)).
- **Blocks.** Wave 10.
- **Owner decision needed.** Yes.

## OD-8. Audit retention and personal data

- **Question.** How long are audit events kept, and how are data-protection
  requests handled for people named in them?
- **Why it matters.** Audit must be immutable and complete to be useful; personal
  data must be erasable or minimized under data-protection law.
- **Options.** (a) permanent audit, pseudonymous labels in events, identities
  pseudonymized on erasure; (b) fixed retention (for example 10 years) then
  deletion of partitions after checkpoint export; (c) shorter retention.
- **Recommendation.** (a), with IP addresses hashed and names resolved at read
  time, so erasure does not touch the audit chain
  ([`../02-control-plane/audit.md`](../02-control-plane/audit.md)). Needs a legal
  check of the owner's obligations.
- **Blocks.** Final setting before Wave 9; design already in Wave 2.
- **Owner decision needed.** Yes (legal).
- **Status (2026-10-05, with the authorization of Wave 2).** Wave 2 design
  resolved; the legal and final retention setting remains **open** and must
  be decided before Wave 9 starts. This is not a resolution of OD-8: no legal
  question is answered here. What is settled is only the technical design that
  Wave 2 builds, which keeps every legal option open:
  - audit events carry identity ids and pseudonymous stable labels, never names
    or e-mail addresses; names are resolved at read time from mutable identity
    data, so erasing or pseudonymizing an identity never touches the chain;
  - no raw IP addresses and no raw user agents; where stored at all, they are
    keyed hashes (HMAC-SHA-256 with an installation-specific key that lives
    outside the audit rows, envelope-encrypted under the keyring, never in
    plaintext in the Control Store); plain SHA-256 over a small input domain
    such as IP addresses is not used;
  - free-text reasons are length-capped, stored as untrusted data, never
    interpreted and never copied into logs;
  - audit is partitioned, so a later finite period can be applied by dropping
    whole partitions; a partition is dropped only after a covering checkpoint
    was exported off-host, and the drop is itself an audit event;
  - the retention default is `permanent`; a configured finite period is never
    below the documented minimum of 400 days; with the default nothing is ever
    removed.
  Text elsewhere that depends on the legal choice stays marked
  `[OPEN: OD-8]`.

## OD-9. Approval model for a one-person organization

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-05
- **Decision.** Option (a), with this semantics:
  - **Agent-initiated plans.** An AI agent proposes; a human reviews the plan
    and approves it in the Web App, with a Web App session, the permission
    `plans.approve` at the plan's scope and a fresh re-authentication. The
    human may be the same person on whose behalf the agent works: the
    distinction is the client, not the person (agent client ≠ human approval
    ceremony). An agent can never approve anything, including its own plan.
  - **Human-initiated plans.** A human may approve their own plan
    (self-approval) when the policy allows it, always with a fresh
    re-authentication. Self-approval is an explicit, recorded case
    (`selfApproval: true`, an acknowledgement in the request, audit), never
    a silent "approver equals creator".
  - **`critical` self-approval** additionally requires the explicit
    acknowledgement, a **cooling period** (V1 default **10 minutes**) and
    prominent audit evidence. The cooling period starts at the self-approval
    of the unchanged plan hash; another plan hash is a new plan with a new
    approval and a new cooling period. Applying a `critical` plan keeps its
    5-minute re-authentication window at the moment of apply, so the
    sequence is approve, wait 10 minutes, re-authenticate, apply. That is
    intended.
  - When several trusted approvers exist, policy may require a distinct
    human; the switch is a policy setting, never derived from the number of
    accounts.
  Implemented in Wave 3A as explicit policy rules
  ([`../02-control-plane/operations-engine.md` §6](../02-control-plane/operations-engine.md#6-approvals-and-re-authentication),
  [`../08-auth-and-security/authorization.md`](../08-auth-and-security/authorization.md)).

History:

- **Question.** How do approvals work when the owner is the only human?
- **Why it matters.** "A second person approves" is a strong control, but with
  one person it either blocks everything or becomes a formality.
- **Options.** (a) agent-initiated production plans need the human's approval
  (creator ≠ approver holds, because the agent created the plan);
  human-initiated plans may be self-approved with fresh re-authentication and a
  cooling period for `critical` actions; (b) always require a second human;
  (c) no approvals, re-authentication only.
- **Recommendation.** (a) now; switch `critical` actions to (b) as soon as a
  second trusted person exists. Self-approvals are marked in the audit
  ([`../02-control-plane/operations-engine.md`](../02-control-plane/operations-engine.md)).
- **Blocks.** Waves 3A and 6.
- **Owner decision needed.** Yes (given on 2026-10-05).

## OD-10. Future identity architecture

- **Question.** When an Exponet identity service exists, who issues tokens for
  ExponetDB's resources?
- **Why it matters.** It decides where consent, scopes and grants live, and how
  much ExponetDB depends on another Exponet service. Related: a central secrets
  service or KMS.
- **Options.** (a) ExponetDB stays the authorization server for its resources and
  federates login (OIDC); (b) the central service becomes the authorization
  server for all Exponet resources.
- **Recommendation.** (a) until several Exponet products need a shared consent
  model; the data model is prepared either way
  ([`../08-auth-and-security/federation.md`](../08-auth-and-security/federation.md)).
- **Blocks.** A later wave; not V1.
- **Owner decision needed.** Yes.

## OD-11. Exponet brand input for the Web App

- **Question.** What are the Exponet brand basics (primary hue, fonts, logo,
  naming of the product in the UI)?
- **Why it matters.** The token model derives the whole palette from a few
  inputs; fonts must be licensed for self-hosting.
- **Options.** (a) the owner provides brand basics; (b) ExponetDB defines a
  neutral technical identity that Exponet adopts later.
- **Recommendation.** (a) if brand work exists; otherwise (b) with OFL fonts and
  a neutral hue, replaceable through token inputs only
  ([`../11-ui/design-system.md`](../11-ui/design-system.md)).
- **Blocks.** Wave 8.
- **Owner decision needed.** Yes.

## OD-12. High availability and failover for managed clusters

- **Question.** Does ExponetDB provide replicas and automated failover for
  managed clusters?
- **Why it matters.** Failover tooling (Patroni-class) is a large, risky
  component; a single cluster per environment is a single point of failure.
- **Options.** (a) no automated failover in V1; backups, PITR and drills cover
  recovery; replication observed if present; (b) streaming replica without
  automatic failover; (c) full HA.
- **Recommendation.** (a) for the REOSA move, matching REOSA's own stage plan
  ("with a reason", for example a customer commitment); (b) as the next step.
- **Blocks.** Stance for Wave 11; feature later.
- **Owner decision needed.** Yes.

## OD-13. Data reads by AI agents on production

- **Question.** May AI agents read production rows?
- **Why it matters.** Production contains personal data; agents can be steered by
  injected text and their outputs leave ExponetDB's control.
- **Options.** (a) `humans_only` default per production target, enabled per
  target by an admin; (b) allowed with masking; (c) never.
- **Recommendation.** (a), with masking applied wherever reads are allowed
  ([`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md)).
- **Blocks.** Wave 7.
- **Owner decision needed.** Yes.

## OD-14. Strictness of fingerprint lineage for production

- **Question.** Must production's schema equal staging's pre-migration schema
  before a production apply?
- **Why it matters.** Lineage proves that staging evidence is about the same
  starting point. REOSA's environments are known to differ today.
- **Options.** (a) warn on mismatch for imported projects, require approval
  after reconciliation; (b) always require approval on mismatch; (c) deny on
  mismatch.
- **Recommendation.** (a)
  ([`../04-migrations/staging-production-policy.md`](../04-migrations/staging-production-policy.md)).
- **Blocks.** Wave 6.
- **Owner decision needed.** Yes.

## OD-15. Policy probes in verification

- **Question.** Should verification be able to test RLS behavior by switching
  to application roles with tenant settings?
- **Why it matters.** RLS mistakes are silent (empty reads); verification that
  only checks structure misses them. Role switching inside verification widens
  what verification may execute and how much rests on review.
- **Options.** (a) not in V1; behavior tests in the consumer's test suite;
  (b) an engine-controlled probe capability with declared roles and settings,
  read-only, rolled back.
- **Recommendation.** (a) in V1, (b) designed after Wave 10 with REOSA's
  isolation probe as the first case
  ([`../04-migrations/verification.md`](../04-migrations/verification.md)).
- **Blocks.** Scope of Wave 6; feature later.
- **Owner decision needed.** Yes.

## OD-16. Shadow apply before production

- **Question.** Should ExponetDB apply production plans to a scratch copy of
  production first?
- **Why it matters.** It catches data-dependent failures (constraint violations
  on real data, long rewrites) that staging misses; it costs time, disk and a
  copy of production data.
- **Options.** (a) not in V1, staging is the shadow; (b) optional per plan using
  a restored scratch copy; (c) mandatory for destructive classes.
- **Recommendation.** (a) in V1; (b) after Wave 9, since restores to scratch
  exist then ([`../04-migrations/analysis.md`](../04-migrations/analysis.md)).
- **Blocks.** Scope of Wave 6; feature later.
- **Owner decision needed.** Yes.

## OD-17. CA strategy for PostgreSQL server certificates

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-07
- **Decision.** Option (a): an ExponetDB-managed PostgreSQL **server** CA per
  installation. The server certificate's key pair is generated on the
  database host by the node agent and never leaves the host (not even
  encrypted); the Control Plane signs a CSR. The PostgreSQL server PKI is
  separate from the agent PKI of [`../07-node-agent/enrollment.md`](../07-node-agent/enrollment.md)
  (the details, lifetimes and the binding to cluster names are designed in
  Wave 5). Given by the owner with the Wave 5 implementation order.

History:

- **Question.** Who issues the TLS server certificates of managed PostgreSQL
  clusters?
- **Why it matters.** An expired certificate takes the platform down; clients
  must trust the issuing CA; rotation must be routine.
- **Options.** (a) ExponetDB-managed CA per installation, issued and rotated by
  the node agent; (b) a separate private CA operated by hand (REOSA's plan:
  825-day certificates and a calendar reminder); (c) public certificates.
- **Recommendation.** (a), with 90-day certificates, automatic rotation planning
  and expiry findings
  ([`../03-database-model/credentials-and-roles.md`](../03-database-model/credentials-and-roles.md)).
- **Blocks.** Wave 5.
- **Owner decision needed.** Yes.

## OD-18. Agent gateway exposure

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-07
- **Decision.** Option (a): in V1 the node gateway listens on the private
  network only; it is not published through Traefik or any public address.
  A host outside the private network needs a new decision (options (b) or
  (c) below). Given by the owner with the Wave 5 implementation order.

History:

- **Question.** Is the node agent gateway reachable only over the private
  network, or also publicly?
- **Why it matters.** Database hosts outside the Exponet private network need a
  path; a public listener increases exposure.
- **Options.** (a) private network only; (b) public endpoint with mTLS and TLS
  passthrough; (c) WireGuard per remote host.
- **Recommendation.** (a) in V1; decide (b) or (c) when the first host outside
  the private network appears
  ([`../01-architecture/control-plane-and-data-plane.md`](../01-architecture/control-plane-and-data-plane.md)).
- **Blocks.** Wave 5.
- **Owner decision needed.** Yes.

## OD-19. ExponetDB license

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-05
- **Decision.** ExponetDB stays proprietary, internal, all rights reserved for
  now. No public open-source release in V1. The decision must not make a later
  opening architecturally impossible: no secrets in the repository, and direct
  reuse of third-party source follows the file-specific license rule in
  [`../01-architecture/repositories-and-boundaries.md`](../01-architecture/repositories-and-boundaries.md).

History:

- **Question.** Under which license is ExponetDB's own code?
- **Why it matters.** It determines file headers, third-party notice handling and
  whether code can ever be shared.
- **Options.** (a) proprietary, all rights reserved; (b) source-available;
  (c) open source (for example Apache-2.0).
- **Recommendation.** (a) for now; it keeps every later option open
  ([`../01-architecture/repositories-and-boundaries.md`](../01-architecture/repositories-and-boundaries.md)).
- **Blocks.** Wave 1 (headers, notices).
- **Owner decision needed.** Yes (given on 2026-10-05).

## OD-20. PostgreSQL configuration ownership strategy

- **Status.** RESOLVED (accepted)
- **Decision date.** 2026-10-07
- **Decision.** Option (b): a dedicated ExponetDB-managed include for
  ExponetDB's own parameters (GUCs), replaced atomically by the local
  helper. `ALTER SYSTEM` is not ExponetDB's normal writer. Values found in
  `postgresql.auto.conf` (and in files read later) are detected and shown
  as overrides; foreign entries are never removed automatically. A host
  whose configuration does not include the managed fragment is reported as
  a bootstrap need and the apply is refused; in Wave 5 the local
  administrator adds the include by hand. ExponetDB owns the content of its
  fragment, not the server's whole configuration, and never edits the main
  `postgresql.conf`. Adopting the include remotely later needs a separate,
  explicit decision. Given by the owner with the Wave 5 implementation
  order.

History:

- **Added.** 2026-10-05 (Wave 0 hardening review).
- **Question.** How does ExponetDB own the PostgreSQL configuration it manages on
  agent-managed clusters?
- **Why it matters.** Configuration changes need clear ownership, a readable
  diff, a reliable revert and no silent mixing with changes made by hand. The
  choice decides how `postgres.config.plan/apply` work and how existing hosts
  are adopted.
- **Options.**
  (a) `ALTER SYSTEM` / `postgresql.auto.conf`;
  (b) an ExponetDB-managed include fragment, for example
  `conf.d/99-exponetdb.conf`, explicitly included and replaced atomically by
  the local helper;
  (c) a hybrid or adoption model (for example the fragment for ExponetDB's own
  parameters and a planned adoption step for values found elsewhere).
- **Recommendation.** (b) for ExponetDB's own parameters: clear ownership, a
  clean diff per plan, plan/apply that is easy to follow, an atomic
  file-replacement strategy, simpler revert, no invisible mixing with manual
  `ALTER SYSTEM` changes; the existing `postgresql.conf` stays bootstrap or
  foreign configuration; `pg_file_settings` still validates. Before the decision
  is applied, Wave 5 checks real Debian/Ubuntu/PGDG configuration and the
  PostgreSQL semantics on the hosts. Existing values in `postgresql.auto.conf`
  must be detected and must not be silently overwritten (they are read last and
  would override the fragment)
  ([`../07-node-agent/capabilities.md`](../07-node-agent/capabilities.md)).
- **Blocks.** Wave 5 (configuration capabilities). Not Wave 1.
- **Owner decision needed.** Yes.

## OD-21. Delivery channel for invitations and security notifications

- **Added.** 2026-10-05 (Wave 3A).
- **Question.** Which channel delivers invitations and security
  notifications (lockout, recovery code used, out-of-band recovery, factors
  changed, identity disabled)?
- **Why it matters.** identity.md decides that e-mail is used for
  invitations and security notifications, and that a lockout notifies the
  owners. Wave 3A records every notification truthfully but ships no
  channel: notifications are `unavailable`, invitations report
  `not_configured` and the inviting person passes the link on. Until a
  channel exists, nobody is told about a lockout or a recovery as it
  happens; the audit is the only trace.
- **Options.** (a) an EU-hosted transactional e-mail provider over SMTP
  submission (TLS, credentials as a Coolify secret, the provider sees
  recipient addresses and link-free texts); (b) a provider HTTP API (same
  data, one more client library); (c) no e-mail: notifications stay in the
  Web App only (a person locked out never sees them).
- **Recommendation.** (a): one small, provider-neutral SMTP channel behind
  the existing `NotificationChannel` port; invitation links travel by e-mail
  only when the inviting person chooses it; delivery outcomes stay truthful
  (`sent`, `failed`), never assumed.
- **Blocks.** Production reliance on notifications (before real production
  logins on `db.exponet.cloud` are opened to more than the owner). Not
  Wave 4.
- **Owner decision needed.** Yes (provider and sender domain).

## OD-22. Authority needed to register a database whose intended tier is unknown

- **Added.** 2026-10-07 (G4 review finding F5, recorded with the G4
  acceptance; [G4 gate record §9.2](../14-roadmap/gates/4.md#92-findings-and-their-disposition)).
- **Question.** Should registering a database (`target.register`) require
  the authority of a tier declared for its cluster or for the database
  itself, rather than only the tier of the environment it is placed in?
- **Why it matters.** `target.register` is authorized by the tier of the
  path it creates. A person who holds `registry.manage:nonprod` only can
  place an unplaced database of a registered cluster (one named
  `app_production`, say) under a nonprod environment; nonprod rules
  (policy, approvals, agent writes) then govern it. The registry cannot
  know a database's intended tier before registration. The G4 checklist
  items hold (markers, Control Store and foreign-installation refusal);
  this is an authorization gap around them, not one of them, and it is
  recorded here instead of being waived.
- **Options.** (a) a declared intended tier per cluster (optionally per
  database), set with `registry.manage` of that tier; registering any
  database of a cluster declared `prod` needs `registry.manage:prod`
  whatever environment it is placed in; (b) every registration of a
  database on a cluster that already hosts a production target needs
  `registry.manage:prod`; (c) keep the current rule and rely on review of
  the registration audit.
- **Recommendation.** (a): the tier becomes a registry fact with its own
  authority, consistent with "production is its own tier" (principle 6);
  (b) is a stopgap that misses a cluster's first production database.
- **Blocks.** Registrations by people who hold nonprod authority only on
  clusters that host production data; Wave 5 or 6 (a contract and Control
  Store change: a new, additive bundle). Not G4.
- **Owner decision needed.** Yes.

## OD-23. Node trust model (Wave 5)

- **Added.** 2026-10-07 (Wave 5 Phase 0; [ADR-0024](../01-architecture/adr/0024-node-trust-model.md), [G5 record](../14-roadmap/gates/5.md)).
- **Question.** Accept the trust model of ADR-0024 §1 to §3, which changes
  accepted baseline decisions of `07-node-agent`?
- **Why it matters.** As accepted, an agent learns its job-signing keys from
  the gateway at enrollment, so a compromised gateway chooses the keys a new
  agent trusts and can then forge any job for it; secrets would cross the
  TLS-terminating gateway in plaintext; results are unsigned; the
  gateway-held issuing CA can mint any node. The baseline's own claim
  ("the gateway cannot forge or alter jobs") does not hold.
- **Options.** (a) ADR-0024 as proposed: the token carries the job-key
  fingerprints (out-of-band anchor); the host generates long-term signing
  and encryption keys bound through a token-derived key only the worker
  holds; node results are signed (`nr1`); secrets are sealed to the node with
  HPKE (`ns1`); the agent PKI is Ed25519 with EKU separation; the PostgreSQL
  server CA is worker-held. (b) As (a), but job-key statements signed by the
  offline root (one offline ceremony per key rotation). (c) Keep the
  baseline and record the gateway as trusted for first contact (weaker than
  the baseline claims).
- **Recommendation.** (a); (b) stays the upgrade path.
- **Blocks.** Every Wave 5 phase that stores or sends keys, tokens, sealed
  payloads or protocol messages (G5 record §3, phases 1 to 5).
- **Owner decision needed.** Yes.

## OD-24. Job identity and retries (Wave 5)

- **Added.** 2026-10-07 (Wave 5 Phase 0; [ADR-0024 §4](../01-architecture/adr/0024-node-trust-model.md)).
- **Question.** How are re-dispatch and retries identified?
- **Why it matters.** The accepted protocol says both "a `jobId` executes at
  most once" and "retries are new attempts of the same job id"; with a
  journal that records `claimed`, a re-dispatch after a lost claim is either
  refused or executed twice depending on the reading.
- **Options.** (a) One envelope per `jobId`, executed at most once; a
  re-dispatch repeats the identical envelope; an operation retry is a new job
  (`attempt + 1`, signed, informational), only for idempotent capabilities
  by an explicit decision. (b) `(jobId, attempt)` as the execution key
  (rejected by the Wave 5 order).
- **Recommendation.** (a).
- **Blocks.** Wave 5 phases 1, 2 and 5.
- **Owner decision needed.** Yes.

## OD-25. Evidence environment for systemd (Wave 5)

- **Added.** 2026-10-07 (Wave 5 Phase 0; [G5 record §5](../14-roadmap/gates/5.md#5-evidence-environment-od-25)).
- **Question.** Where does G5 get real systemd evidence on Ubuntu 24.04?
- **Options.** (a) a privileged, disposable Ubuntu 24.04 container running
  systemd as PID 1 in the session or in CI; (b) a VM or self-hosted runner
  the owner provides (no production data, reachable only by CI); (c) both:
  (a) during development, (b) for the G5 record.
- **Recommendation.** (c); without (b) the systemd items may end `NOT PROVEN`
  if (a) is not accepted as real systemd evidence.
- **Blocks.** G5 items 2 to 4.
- **Owner decision needed.** Yes.
