# Engineering principles

| | |
|---|---|
| Status | Baseline (Wave 0) |
| Relation to the constitution | The [constitution](./constitution.md) says what must always hold. These principles say how we design so that it holds without heroics. A principle can be traded off with a written reason; an article cannot. |

Each principle has an id (`P-<n>`), the rule, the reason, and what it means in
practice. Where a principle comes from a measured incident in REOSA, the
incident is cited, because "we were bitten by this" is a better reason than
"best practice".

---

### P-1. Contracts first, generated everywhere

**Rule.** Every wire contract (REST resources, error codes, scopes, MCP tool
inputs and outputs, node protocol messages, migration manifest schema) is
defined once in `packages/contracts` and generated into OpenAPI 3.1, JSON
Schema, the TypeScript SDK and the Go types of the node agent.

**Why.** Three interfaces (REST, MCP, Web App) plus a second language (the
agent) guarantee divergence if each has its own type definitions. One source,
many generated artifacts, and a CI check that the generated artifacts are
committed and current.

### P-2. Real PostgreSQL in tests, never an emulation

**Rule.** Anything that touches SQL semantics is tested against real PostgreSQL
servers of the supported major versions. In-process emulations (pglite and
similar) are not accepted as evidence for engine behavior.

**Why.** [OBSERVED] REOSA measured on 2026-09-02 that pglite serializes a
JavaScript `Date` inside a raw SQL fragment correctly while the production
driver does not, so a broken query was green in tests and failed in production
(`REOSA/.claude/rules/database.md`). The same happened for `date[]` parameters
on 2026-09-23. A control plane whose purpose is to make database changes safe
cannot accept that class of false confidence.

### P-3. Parse SQL with PostgreSQL's parser, never with regular expressions

**Rule.** Statement splitting, classification (DDL, DML, transaction control,
utility), lock analysis, compatibility analysis, redaction and normalization use
`libpg_query` (PostgreSQL's own parser, packaged for the target major version).
Regular expressions are allowed only as a fallback that fails closed.

**Why.** SQL has dollar quoting, nested comments, `E''` strings, identifiers
that look like keywords, and multi-statement strings. [OBSERVED] REOSA found a
`= ANY(...)` bug written as `any(` in lower case that no text search had caught
(`REOSA/.claude/rules/database.md`). A parser sees structure; a regex sees
characters.

### P-4. Make the safe path the convenient path

**Rule.** The plan/apply flow must be at least as convenient for an AI agent as
"apply this SQL" is today. `migration_plan` returns everything an agent needs to
decide and explain (analysis, lock risk, evidence status, what would block
production) in one structured result. Refusals name the exact missing
precondition and the next step.

**Why.** If the safe path is tedious, people and agents route around it
(scripts with a superuser URL, manual `psql`). ExponetDB wins by being the
easiest way to change a database correctly.

### P-5. Every refusal is explained and machine-readable

**Rule.** Every error has a stable code from the error catalog, a human message,
the failed precondition(s) and, where possible, a remediation hint. No refusal
is a bare 403 or "something went wrong".

**Why.** Agents act on codes; humans act on messages. Both need to know what to
do next. See [`../02-control-plane/error-model.md`](../02-control-plane/error-model.md).

### P-6. Failures must be loud where they matter

**Rule.** A code path that tolerates a missing database object or a failed
read (fail-soft) must emit a measurable signal (metric, health finding, drift
item), not only a log line. ExponetDB's own health model treats "could not
determine" as its own state.

**Why.** [OBSERVED] REOSA measured on 2026-07-30 that two merged migrations were
missing in production for a long time because the calling code caught the
error and returned less data (`0159_auth_mirror` behind a fail-soft identity
mirror, `0140_website_renderer_page_nav_subtitle` behind a column-grant
fallback). Four maintenance jobs failed for days in 2026-08 because `catch`
blocks logged `error.message` and dropped the PostgreSQL `cause` with the
`42501 permission denied` code
(`REOSA/.claude/rules/migrations.md`, `REOSA/.claude/rules/portability.md`).

### P-7. Small trusted computing base per process

**Rule.** Each process role holds only the secrets it needs. The Agent Gateway
holds no target credentials and no job-signing key. The node agent's network
facing process is unprivileged; root-level steps go through a local helper with
a fixed operation list. The Web App holds no secrets at all.

**Why.** The likeliest compromise is the most exposed component. Its blast
radius must be small.

### P-8. Boring infrastructure, PostgreSQL first

**Rule.** V1 uses PostgreSQL (the Control Store) for queues, leases, locks,
plans, samples and audit. No Redis, Kafka, NATS or separate time-series database
until a measured need exists.

**Why.** One stateful dependency is one thing to back up, secure, monitor and
restore. The workload (a handful of targets, sampling every few seconds, dozens
of operations per day) is small.

### P-9. Evidence over assertions

**Rule.** Whenever ExponetDB decides something based on a fact, it records the
fact as an evidence object (what was checked, against what, when, with which
result) and links it from the plan or operation. "Staging verified" is a row
with a checksum, a fingerprint and a timestamp, not a boolean.

**Why.** Audits, incident reviews and AI agents all need to reconstruct *why* a
decision was taken.

### P-10. Determinism in everything that is hashed or compared

**Rule.** Hashed or compared documents use canonical serialization (RFC 8785
JSON Canonicalization Scheme), explicit sort keys, UTF-8, LF line endings and a
version prefix. Any change to a canonicalizer is a new version, never an edit.

**Why.** Checksums and fingerprints are security bindings. A non-deterministic
fingerprint produces false `PLAN_STALE`; a silently changed canonicalizer
invalidates all history.

### P-11. Abstractions come from real boundaries

**Rule.** An interface is introduced when there are two real implementations or
a real boundary (process, trust, engine). No engine-neutral interfaces for
engines that will not be built, no plugin systems without plugins.

**Why.** [C-34](./constitution.md#c-34-postgresql-knowledge-stays-behind-the-adapter).
Over-abstraction makes the PostgreSQL path harder to read without making the
future easier.

### P-12. One setting, one place

**Rule.** Every configuration value has exactly one source (environment
variable for bootstrap secrets, Control Store for everything else) and is
visible in the Web App where it is effective. No duplicated defaults across
packages.

**Why.** [OBSERVED] REOSA's measured `pg_default_acl` difference between two
databases that received "the same migrations" (2026-08-01) is the database
version of this problem: two places that should agree, nothing that checks it.

### P-13. Time is server time

**Rule.** All timestamps are UTC `timestamptz` set by the server. Plan expiry,
lease expiry and token expiry are evaluated by the Control Plane clock, never by
client-supplied times. Node agents report their clock skew in every heartbeat;
skew above a threshold degrades the node.

### P-14. Humans approve, agents propose, the engine decides

**Rule.** For actions above a policy threshold, the normal flow is: an agent
plans, a human with the right permission reviews and approves in the Web App
(with re-authentication), the agent (or the human) applies. The engine checks
everything again at apply time.

**Why.** This is the practical meaning of "humans and AI agents safely change
databases together": neither side is a rubber stamp for the other.

### P-15. Documentation is part of done

**Rule.** A change to a contract, a policy, a capability, an error code or an
invariant updates the corresponding document in `exponetdb-docs/` in the same
pull request. A wave is not done until its documentation requirements in
[`../14-roadmap/implementation-waves.md`](../14-roadmap/implementation-waves.md)
are met.

### P-16. Prefer forward fixes

**Rule.** The default remedy for a bad migration is a new forward migration.
`down.sql` exists for the rare case where reversing is safe and faster, and is
itself planned, approved and verified.

**Why.** Reversing schema changes on a live database with real data is the
riskiest operation in the domain; it must never be the reflex.
