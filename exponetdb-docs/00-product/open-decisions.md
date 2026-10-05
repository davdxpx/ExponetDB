# Open decisions

| | |
|---|---|
| Status | OD-2, OD-3 and OD-19 resolved on 2026-10-05; all other entries wait for the owner |
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
| OD-5 | MCP client registration policy | open | CIMD allowlist + approval-gated DCR + pre-registered first-party clients | Wave 3 | yes |
| OD-6 | Verified provenance for production migrations | open | not in V1; add repository integration or signed artifacts after Wave 10 | Wave 6 (production policy), later | yes |
| OD-7 | Manage REOSA's current hosted databases before the move | open | yes: read-only first, then import and staging migrations | Wave 10 | yes |
| OD-8 | Audit retention and personal data | open | permanent audit with pseudonymous labels; erasure pseudonymizes identities | Wave 9 (final setting), Wave 2 (design) | yes (legal) |
| OD-9 | Approval model for a one-person organization | open | creator ≠ approver for agent-initiated production plans; human-initiated plans self-approved with re-auth and cooling period | Waves 3, 6 | yes |
| OD-10 | Future identity architecture | open | ExponetDB stays authorization server for its resources; federates login to the Exponet identity service later | later wave | yes |
| OD-11 | Exponet brand input for the Web App | open | wait for Exponet brand basics; neutral placeholder tokens until then | Wave 8 | yes |
| OD-12 | High availability and failover for managed clusters | open | no automated failover in V1; observe replication; revisit with a customer commitment | Wave 11 (stance), later | yes |
| OD-13 | Data reads by AI agents on production | open | `humans_only` by default per production target | Wave 7 | yes |
| OD-14 | Strictness of fingerprint lineage for production | open | warn for imported legacy projects, require approval after reconciliation | Wave 6 | yes |
| OD-15 | Policy probes in verification | open | not in V1; keep RLS behavior tests in consumer test suites | Wave 6 (scope), later | yes |
| OD-16 | Shadow apply before production | open | not in V1; staging is the shadow | Wave 6 (scope), later | yes |
| OD-17 | CA strategy for PostgreSQL server certificates | open | ExponetDB-managed CA per installation, issued and rotated through the node agent | Wave 5 | yes |
| OD-18 | Agent gateway exposure | open | private network only in V1 | Wave 5 | yes |
| OD-19 | ExponetDB license | **resolved 2026-10-05** | proprietary, internal, all rights reserved | (was Wave 1) | decided |

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
- **Blocks.** Wave 3.
- **Owner decision needed.** Yes.

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

## OD-9. Approval model for a one-person organization

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
- **Blocks.** Waves 3 and 6.
- **Owner decision needed.** Yes.

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
