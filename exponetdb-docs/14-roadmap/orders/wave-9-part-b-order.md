# ExponetDB — Wave 9 Part B: backup, restore, performance, security hardening (implementation order)

| | |
|---|---|
| What this is | The owner's implementation order of **2026-10-26** for Wave 9 Part B, given in German as the first message of an implementation session and recorded here in English (US) by that session. Where this rendering and the owner's text differ, the owner's text wins and this file is corrected |
| Base | `main` at `cad5ac1` (merge of `davdxpx/ExponetDB#42`, the parallel UI/UX session, finished before this session's first commit); the order itself was written on `a4f16e3f` (`#40`) |
| Parent order | [`wave-9-order.md`](./wave-9-order.md) (2026-10-21); Part A of it is done ([Part A record](../gates/9-part-a.md)) and is not this order's work |
| Not in scope of this file | It accepts no gate. The decisions in §2 are recorded in [`open-decisions.md`](../../00-product/open-decisions.md#owner-decisions-of-the-wave-9-part-b-order-2026-10-26) |

## 1. Mission and limits

Build the open parts of Wave 9 Part B on top of Part A, regression-safe:
backup repositories and policies, catalog reconciliation, WAL coverage,
RPO/RTO, scheduled and manual backups, restore plans and drills, runbooks,
node capabilities for long-running jobs, L1 pgBackRest, L2 `pg_dump`, L3
restic; `pg_stat_statements` sampling, table and index statistics,
regression detection, connection cancel/terminate as plans, advisors and
findings; REST, SDK, CLI, the four planned MCP reads and plan-only restore
interfaces; the isolated Web pages under `apps/web/src/features/wave9/**`;
hardening of earlier waves where backup, migration or restore depend on it;
and **one** prioritized review document,
[`../PRE-WAVE-11-REVIEW.md`](../PRE-WAVE-11-REVIEW.md).

Hard limits:

- No real database, bucket, host (`reos-01`, `reos-db-01`) or production
  data is touched; no deployment, enrollment, credential rotation, backup
  takeover, restore or change in `davdxpx/REOSA`. Real installations are
  reference shapes, never test targets.
- REOSA production stays protected until Wave 11: no production apply,
  restore switch, cutover, copy snapshot or hidden production connection.
  OD-7a authorizes staging for the owner, not for an implementing session.
- Frozen contracts, vectors and bundles (`c1`, `ls1`, `ac1`, `se1`, `pv1`,
  `fp1`, `frozen-bundles.json`) never change; additions are additive
  bundles, new contract versions and ADRs. No direct SQL write path outside
  operations and migrations; no shell or exec endpoint.
- The parallel UI/UX session owns the shell, navigation, fleet, targets,
  target overview, connect, project routes, design primitives and the
  entity lifecycle actions (`registry.server.retire`,
  `registry.cluster.retire` and their contracts). Wave 9 owns the backend
  and `apps/web/src/features/wave9/**` only.

## 2. Owner decisions (2026-10-26)

1. **OD-8**: option (a) as the technical default (permanent, pseudonymous,
   append-only audit; clear personal data outside the chain; HMAC'ed IP
   addresses; no raw user agents). The legal review is not a fact: it is an
   EXTERNAL LEGAL REVIEW, `NOT PROVEN`, before productive use. A technical
   default is never legal advice.
2. **OD-53**: (a), fail closed; option (b) only later with an ADR and tests.
3. **OD-54**: (a), a controlled `registry.cluster.adopt_agent` operation.
4. **OD-55**: (c) + (d). Human approval on every tier for agent plans with
   procedural constructs; transactional before/after protection of the
   `exponetdb` ledger and marker tables. Only a mechanism shown sound under
   races, locks and TOCTOU is acceptable; otherwise fail closed and mark a
   gate blocker. Cross-project role reach stays a residual risk.
5. **OD-56**: (a), HMAC under a server-side key; changed values fail
   closed; key errors and rotation handled; no values in UI, API, audit or
   logs.
6. **OD-4 storage is not decided.** Engine side decided (pgBackRest L1;
   `pg_dump` L2 and restic L3 are built). Provider-neutral architecture,
   several repositories per cluster, existing R2 repositories adopted
   observe-only first, no irreversible provider choice and no hidden bucket
   migration. Provisional recommendation (not a decision): Hetzner Object
   Storage with S3 Object Lock as L1 candidate, Cloudflare R2 as independent
   L3 candidate; existing installations keep R2 read-only. `OD-4-storage`
   stays `OPEN — BLOCKS G9 FULL ACCEPTANCE`.
7. Not closed silently: OD-10, OD-12, OD-21, OD-27, OD-29, OD-41 to OD-50.

## 3. Lifecycle dependencies for the UI/UX session

The UI/UX session owns server and cluster retirement. Wave 9 delivers a
server-side, reliably queryable answer of active backup, restore,
repository, drill and WAL obligations for a server or cluster (a typed
lifecycle dependency provider port and a read contract). While the port is
not integrated, the read is not reliable or a chain is still required, the
answer is `unknown` or `blocking`, never "no dependents" and never an
automatic delete. Protected names and keys are redacted; backup and audit
history survive registry retirement; removing a registry record never
deletes a bucket, a PostgreSQL cluster or a host. The integration needs a
negative proof (an existing backup reference blocks; missing or partial
backup data blocks; after an explicit safe release no backup byte is
deleted); until then the live integration is `NOT PROVEN`.

## 4. Work items (summary of order §§2 to 9)

- **Architecture and contracts first**: a gap matrix on current `main`;
  contracts in `packages/contracts`; additive Control Store bundles
  (`backup_repositories`, `backup_policies`, `backups`, `wal_coverage`,
  `restores`, `drills`, `advisor_runs`, `findings` at cluster or target
  level, `statement_samples`, `statement_aggregates`, `stats_reset_events`,
  durable jobs with identity, generation, owner and lease); keys only as
  references or sealed envelopes; stable error codes without secrets.
- **Repositories and policies**: desired configuration, observed engine
  catalog and last reconciliation kept apart; `adopt → observe → planned
  handover` with no automatic rewrite of `archive_command`,
  `restore_command`, timers, repository chains or old keys; retention never
  deletes the last provably restorable base and its WAL. Hetzner S3 Object
  Lock and R2 bucket locks are different contracts; lock capability is
  discovered and kept `unknown`/`unsupported`/`unproven`; host credentials
  can neither change lock configuration nor delete protected objects.
  pgBackRest version pinned; the October 2026 subkey/salt advisory handled.
- **Node agent**: an ADR for durable long-running capabilities, no longer
  timeout and no shell; signed typed payloads re-validated on the agent,
  fixed argv, async start → progress → recovery → result proof, safe
  cancellation, crash/lease/fencing, bounded processes, per-cluster locks,
  sealed host keys; `backup.list@1`, `backup.verify@1` first, then run,
  expire and the restore capabilities; `registry.cluster.adopt_agent`
  before agent-managed backups of a formerly external cluster. No agent is
  enrolled on `reos-db-01` before the G5 waiver evidence exists.
- **Restore**: a concrete plan resource with every binding re-checked at
  apply; no in-place restore; drills on isolated localhost-only scratch;
  recovery builds a new cluster or target generation, the placement switch
  is a separate human critical plan; people execute restores, agents only
  propose; production → nonprod clones out of scope by default. C-35:
  an offline plain-shell runbook generated from the current repository
  configuration without embedded secrets. RB-06, RB-07, RB-08 actionable.
  Failure-injection scenarios implemented as tests or listed pending.
- **Diagnostics**: `pg_stat_statements` top 200 every 5 minutes with
  deltas, resets and gaps; 24 h vs 7 d regressions without causal claims;
  table and index statistics live and cheap; a clean-room advisor engine
  (security, performance, operations, change safety) with findings;
  cancel/terminate as bound plans that never touch replication, backup or
  ExponetDB sessions; paginated findings reads.
- **Interfaces**: REST, SDK, CLI, MCP (`query_stats`, `table_stats`,
  `advisors_run`, `backups_list`; restore plan-only) and the isolated Web
  pages; no force flags, no secrets in arguments.
- **Security hardening**: independent adversarial reviews of six areas;
  Critical/High/Medium fixed or the affected action kept disabled; the
  expiring G6 waivers (E25 and the partial E4 to E28) addressed; OD-21 not
  bypassed; G2, G5, G7, G8 never declared accepted.

## 5. Deferred tests and the review file

The owner runs manual acceptance, live integrations, productive
verification runs and the large drill suites before Wave 11. This session
implements the test cases and reproducible lab or CI plans, does not run the
deferred drills, never disables CI, and records results truthfully.
Security gates are never `WAIVED`: a function without its proof can be
implemented but not activated as safe. The minimum pre-Wave-11 test list
(order §10, items 1 to 12) and the review file's structure (order §11,
sections 00 to 09) are reproduced in
[`../PRE-WAVE-11-REVIEW.md`](../PRE-WAVE-11-REVIEW.md#wave-9-part-b--parallel-session).

## 6. Definition of done

Wave 9 Part B functional on the server with contracts → application →
node → REST/SDK/CLI/MCP and the isolated Web pages; the repository model,
adopt-then-own, L1/L2/L3, policies, schedules, restore plans and runbooks
built or blocked with a stated technical reason; security, identity,
human-only restore, audit, permissions, no shell, secrets and no in-place
restore protected in design and code; OD-53 to OD-56 and the technical OD-8
recorded; OD-4 storage left to the owner after measurement; the central
review file complete. **No gate is accepted by this session; no REOSA
production apply; no real cluster or host is touched.**
