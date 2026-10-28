# Open decisions

| | |
|---|---|
| Status | OD-2, OD-3, OD-9 and OD-19 resolved on 2026-10-05; OD-5 resolved on 2026-10-06; OD-17, OD-18 and OD-20 resolved on 2026-10-07 (Wave 5 entry conditions); OD-23, OD-24 and OD-25 resolved on 2026-10-07 (Wave 5 design); OD-20 and OD-21 added on 2026-10-05; OD-22 added on 2026-10-07 (G4 acceptance); OD-23 to OD-25 added on 2026-10-07 (Wave 5 design); OD-26 added on 2026-10-07 and OD-27 on 2026-10-08 (Wave 5 Phases 5 and 6); OD-28 added on 2026-10-08 (Wave 5 correction F1); OD-6, OD-14, OD-15, OD-16, OD-22 and OD-26 resolved on 2026-10-12 by the owner's Wave 6 order (OD-22's declared-tier field on clusters was an open limit of the G6 acceptance until Wave 8 part 2 implemented it on 2026-10-13); OD-28 resolved on 2026-10-12 at the G5 acceptance (nothing to do on the owner's installation); OD-13 resolved and OD-29 (F9) added and resolved on 2026-10-12 by the owner's Wave 7 order, which also decided the points listed in ["Decisions of the Wave 7 order"](#decisions-of-the-wave-7-order-2026-10-12); OD-30 to OD-37 added on 2026-10-13 (Wave 7 follow-up, after an external test of the live endpoint; OD-30 and OD-31 are already built and wait for the owner's confirmation, the others are not implemented); OD-8: Wave 2 design settled on 2026-10-05, legal setting open; OD-1 and OD-11 resolved and OD-38 and OD-39 added on 2026-10-13 by the owner's Wave 8 order (which named them OD-30 and OD-31; renumbered because the Wave 7 follow-up took OD-30 to OD-37 the same day), which also decided the points listed in ["Decisions of the Wave 8 order"](#decisions-of-the-wave-8-order-2026-10-13); OD-40 added on 2026-10-13 from the Wave 8 CSP spike and resolved the same day by the owner, who also extended OD-22 and decided the points listed in ["Owner decisions in the Wave 8 session"](#owner-decisions-in-the-wave-8-session-2026-10-13); OD-41 to OD-48 added on 2026-10-20 by the Wave 8 completion's Studio parity audit ([`../11-ui/studio-parity.md`](../11-ui/studio-parity.md)); OD-49 added on 2026-10-21 with the owner's decision on the provider list (S11 in ["Owner decisions after the Wave 8 session"](#owner-decisions-after-the-wave-8-session)); OD-50 added on 2026-10-21 with the CLI's scope presets; on 2026-10-21 the owner's Wave 9 order ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md)) split OD-7 into OD-7a (staging: yes) and OD-7b (production: no applies before Wave 11), decided the engine part of OD-4 (pgBackRest; the storage stays open until the measured spike B0), and added OD-51 (a declared `BYPASSRLS` execution-role exception) and OD-52 (adopting a running pgBackRest setup), both decided by the order's defaults; OD-53 (fingerprint lineage across per-environment owner roles) added on 2026-10-21 by Part A (A5); OD-54 (how an external cluster gains the node agent) added on 2026-10-22 by Part A (A8); OD-55 (procedural code in a migration session can act as any role the migrator holds) added on 2026-10-22 by Part A's review round 3; OD-56 (an excused value outside the fingerprint that changes after the review) added on 2026-10-24 by the review of Part A follow-up 3; on 2026-10-26 the owner's Wave 9 Part B order decided OD-8 (technical default option (a); the legal review stays open as EXTERNAL LEGAL REVIEW), OD-53 (a), OD-54 (a), OD-55 (c) with (d) and OD-56 (a), and kept the storage part of OD-4 open (it blocks the full G9 acceptance; see ["Owner decisions of the Wave 9 Part B order"](#owner-decisions-of-the-wave-9-part-b-order-2026-10-26)); OD-57 (an advisor run's scope) added on 2026-10-27 by the Part B review F-4; OD-58 to OD-67 added on 2026-10-28 by the test campaign fixes; all other entries wait for the owner |
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
| OD-1 | Web App language | **resolved 2026-10-13** | option (c): English UI strings behind typed message keys from day one; German later by adding a catalog | (was Wave 8) | decided |
| OD-2 | Node agent implementation language | **resolved 2026-10-05** | Go | (was Wave 5 and the Go golden vectors of Wave 1) | decided |
| OD-3 | Toolchain and runtime | **resolved 2026-10-05** | Bun workspaces + Turborepo + Vitest + Biome + TypeScript; Node.js 24 LTS for production server processes | (was Waves 1, 2) | decided |
| OD-4 | Backup engine | **engine decided 2026-10-21**; **storage open** (`OD-4-storage`, reaffirmed open by the owner on 2026-10-26: **blocks the full G9 acceptance**) | pgBackRest for L1, `pg_dump` for L2, restic for L3; the architecture is provider-neutral with several repositories per cluster ([ADR-0036](../01-architecture/adr/0036-backup-repositories-and-providers.md)); the provisional recommendation (Hetzner Object Storage with S3 Object Lock as the L1 candidate, Cloudflare R2 as the independent L3 candidate, existing R2 repositories adopted read-only) is **not** an owner decision; the comparison and the spike are in [`PRE-WAVE-11-REVIEW.md` W9-03](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-03-storage-choice-spike) | the full G9 acceptance and any productive activation of a repository | yes (after the spike) |
| OD-5 | MCP client registration policy | **resolved 2026-10-06, revised 2026-10-13** | revised 2026-10-13 by the owner: new CIMD and DCR clients are approved automatically by default (`EXPONETDB_OAUTH_CLIENT_REGISTRATION=open`), a person still consents, an administrator can still disable a client; `review` keeps the 2026-10-06 rule. Option (a) of 2026-10-06: pre-registered first-party clients; third-party CIMD clients only after an admin approves the exact `client_id` URL, bound to a fingerprint of its security metadata; DCR as deprecated compatibility that creates a pending public client (`none`) until approved; service-account clients pre-registered with `private_key_jwt`; no client secrets; no third-party client trusted at bootstrap | (was Wave 3B) | decided |
| OD-6 | Verified provenance for production migrations | **resolved 2026-10-12** | not in V1; add repository integration or signed artifacts after Wave 10 | Wave 6 (production policy), later | yes |
| OD-7 | Manage REOSA's current databases before the move | **resolved 2026-10-21** (split by the owner's Wave 9 order) | OD-7a (staging, already self-managed on `reos-db-01`): **yes**, registered, imported and migrated through ExponetDB after Part A of Wave 9; OD-7b (production, still on the hosted provider until Wave 11): **no applies before Wave 11**, at most read-only observation | (was Wave 10) | decided |
| OD-8 | Audit retention and personal data | **technical default decided 2026-10-26** (option (a)); **legal review open** (EXTERNAL LEGAL REVIEW, NOT PROVEN) | option (a) as the technical default: append-only, hash-chained audit kept permanently and pseudonymously; personal data in clear text outside the chain, resolved only with permission; IP addresses as installation-keyed HMAC, no raw user agents; a configured finite period never below 400 days. This is a technical default, **not legal advice**: the data-protection and erasure review is open and must pass before productive use | productive use of the audit with personal data (not Wave 9 development) | yes (legal) |
| OD-9 | Approval model for a one-person organization | **resolved 2026-10-05** | option (a): agent proposes, a human approves in the Web App; human-initiated plans may be self-approved with fresh re-authentication; `critical` self-approvals add an explicit acknowledgement, a 10-minute cooling period and a fresh re-authentication at apply | (was Waves 3A, 6) | decided |
| OD-10 | Future identity architecture | open | ExponetDB stays authorization server for its resources; federates login to the Exponet identity service later | later wave | yes |
| OD-11 | Exponet brand input for the Web App | **resolved 2026-10-13** (placeholder) | option (b) until the owner supplies a brand: neutral placeholder tokens (an indigo-blue hue near 255, clearly not Supabase green), the wordmark is the text "ExponetDB" in the UI font, Inter and Source Code Pro (OFL, self-hosted); replaceable through the token inputs only | (was Wave 8); a real brand replaces the placeholder later | yes (brand values, when they exist) |
| OD-12 | High availability and failover for managed clusters | open | no automated failover in V1; observe replication; revisit with a customer commitment | Wave 11 (stance), later | yes |
| OD-13 | Data reads by AI agents on production | **resolved 2026-10-12** | option (a): `dataRead: humans_only` by default per production target, `enabled` by default for nonprod, changed per target by an administrator; masking wherever reads are allowed; an agent is every non-human caller | (was Wave 7) | decided |
| OD-14 | Strictness of fingerprint lineage for production | **resolved 2026-10-12** | warn for imported legacy projects, require approval after reconciliation | Wave 6 | yes |
| OD-15 | Policy probes in verification | **resolved 2026-10-12** | not in V1; keep RLS behavior tests in consumer test suites | Wave 6 (scope), later | yes |
| OD-16 | Shadow apply before production | **resolved 2026-10-12** | not in V1; staging is the shadow | Wave 6 (scope), later | yes |
| OD-17 | CA strategy for PostgreSQL server certificates | **resolved 2026-10-07** | option (a): an ExponetDB-managed PostgreSQL server CA per installation; the server's TLS key is generated on the host and never leaves it | (was Wave 5) | decided |
| OD-18 | Agent gateway exposure | **resolved 2026-10-07** | option (a): the node gateway listens on the private network only in V1 | (was Wave 5) | decided |
| OD-19 | ExponetDB license | **resolved 2026-10-05, amended 2026-10-23** | source-available: ExponetDB Source-Available License 1.0 (was: proprietary, all rights reserved) | (was Wave 1) | decided |
| OD-20 | PostgreSQL configuration ownership strategy | **resolved 2026-10-07** | option (b): a dedicated ExponetDB-managed include for its own parameters; no `ALTER SYSTEM` as the normal writer; foreign `postgresql.auto.conf` values never removed automatically; a missing include is reported as a bootstrap need and added by the local administrator in Wave 5 | (was Wave 5) | decided |
| OD-21 | Delivery channel for invitations and security notifications | open | an EU-hosted transactional e-mail provider over SMTP submission with TLS, configured per installation; links never in logs | production use of notifications (lockout, recovery); not Wave 4 | yes |
| OD-22 | Authority needed to register a database whose intended tier is unknown | **resolved 2026-10-12, extended 2026-10-13, implemented 2026-10-13** (Wave 6 workflows; on 2026-10-13 the owner decided that both the declared-tier field on clusters and a tier-aware `registry.manage` are built in Wave 8; implemented in Wave 8 part 2, which closes [G6 record §10](../14-roadmap/gates/6.md#10-acceptance-2026-10-12) O7; the OAuth scope stays one `registry.manage` because the frozen scope catalog pins its tiered scopes, see the entry) | a declared intended tier per cluster (optionally per database), set with `registry.manage` of that tier; registering any database of a cluster declared `prod` needs `registry.manage:prod` whatever environment it is placed in | first production registrations by people with nonprod authority only; Wave 5 or 6 | yes |
| OD-23 | Node trust model (Wave 5) | **resolved 2026-10-07** | option (a), ADR-0024 §1 to §3: job-signing keys anchored by the enrollment token; long-term node keys bound through the token secret and verified by the worker; node-signed results; secrets sealed with `ns1` (HPKE); Ed25519 agent PKI with EKU separation; PostgreSQL server CA held by the worker | (was Wave 5 phases 1 to 5) | decided |
| OD-24 | Job identity and retries (Wave 5) | **resolved 2026-10-07** | option (a), ADR-0024 §4: one signed envelope executes at most once; a re-dispatch repeats the identical envelope; an operation retry is a new job with `attempt + 1` | (was Wave 5 phases 1, 2, 5) | decided |
| OD-25 | Evidence environment for systemd (Wave 5) | **resolved 2026-10-07** | option (c): a privileged disposable Ubuntu 24.04 systemd container during development; a VM or self-hosted runner the owner provides for the G5 record (until then the systemd items may stay `NOT PROVEN`) | G5 items 2 to 4 (runner from the owner) | decided |
| OD-26 | Who may read a plan or an operation (`read_of_kind`) | **resolved 2026-10-12** | (c) within the subject limits: the kind's domain read permission at a scope covering the subject, or `plans.approve` at a scope covering it; an id grants nothing | (was `GET /plans/{id}`, `GET /operations/{id}`; Wave 8 screens) | decided |
| OD-27 | Moving the agent gateway to a new address | open | a gateway certificate naming the old and the new server name during the move, a `node-pki gateway` command that records the new address next to the old one, and `node.config.update` sending it to each node; the old name dropped once no live node uses it | the move to `exponet-01`; not Wave 5 | yes |
| OD-28 | Node exports stored before the confidentiality correction (F1) | **resolved 2026-10-12** (G5 acceptance: nothing to do on this installation) | keep them quarantined (no reader serves them), rotate every credential a retired major may have exported, and scrub the stored bodies only by the owner-run procedure with provenance | nothing in Wave 5 (fail closed meanwhile); an owner action on installations that ran Wave 5 before the correction | yes |
| OD-29 | Node changes by machine callers through MCP (G5 follow-up F9) | **resolved 2026-10-12** | option (c) for Wave 7: no MCP tool plans or applies a node change (`node_plan` is not listed); `nodes_list` and `node_status` read; REST and CLI unchanged | (was Wave 7 entry condition) | decided |
| OD-30 | Request id in every tool result | open (**built** by `4755298`, confirmation wanted) | keep: `_meta["cloud.exponet.db/requestId"]` and a last server line on every result | nothing | yes |
| OD-31 | Duration of a tool call in its result | open (**built** by `4755298`, wider than recommended) | durations on successful reads only, never on a refusal | nothing | yes |
| OD-32 | Concealment of servers and clusters | open | conceal them like targets and the registry levels above them | nothing built; a security decision | yes |
| OD-33 | Session ids in the audit view | open | decide that `ses_` is a public identifier or a secret; store and show only a keyed hash of it in new events and mask the historic raw ones in the read view | nothing | yes |
| OD-34 | Classification and audit of `drift_check` | open | a control-record write with its own scope, and an audit event for record writes | nothing | yes |
| OD-35 | A grant describing itself over MCP | open | a read-only resource `exponetdb://me/grant` | nothing | yes |
| OD-36 | The `toolCallMs` limit | open | enforce it (or remove the declaration and the document line) | nothing | yes |
| OD-37 | The lab client under open registration | open | the G7 record's sentence is corrected; the lab keeps `review` where an explicit approval is wanted | G7 wording | yes |
| OD-38 | License basis of copied Supabase UI files (Apache-2.0 repository vs MIT package declarations) | open | comply with the superset: Apache-2.0 text, retained copyright line, prominent change notice in every header, and the MIT notice text ([ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md) §4) | release of the Wave 8 Web App (not its development) | yes |
| OD-39 | Hosting of the design-system app | open | (a) not deployed: built and checked locally and in CI only, until a reader outside the repository needs it | publishing `apps/design-system`; not G8 | yes |
| OD-40 | The SQL editor component under the Web App's CSP | **resolved 2026-10-13** | option (a): CodeMirror 6 mounted in a shadow root behind the editor interface, built to work and look like Supabase's SQL editor (tabs, completion, formatting, results grid, shortcuts); the CSP stays strict; Monaco is not used | (was the SQL section and the diff viewers) | decided |
| OD-41 | Connection details for people without `registry.manage` | open | (a) keep endpoint addresses to registry administrators; the Connect panel (secret-free) is built for them; revisit with option (c) (non-production only) when a consumer team asks | a Connect panel for other readers | yes |
| OD-42 | How the read-only table browser reads rows | open | (a) one data-read path: the Web App sends a `SELECT` built from catalog identifiers (always quoted) and bind parameters through the existing query endpoint, which admits, masks, caps and audits it | nothing (built on (a)) | yes |
| OD-43 | A read of a cluster's PostgreSQL roles and its permission | open | (b) `nodes.read`, the permission that already shows the cluster's desired roles; attributes, connection limits and memberships, never verifiers | the Roles page of the schema browser | yes |
| OD-44 | Server-side DDL generated for display | open | (a) not in V1: definitions are shown as the catalog stores them; no generated `CREATE` text and no migration drafted from a schema diff | table definitions, ERD "copy as SQL", "draft from this diff" | yes |
| OD-45 | A person's own activity without `audit.read` | open | (b) every person reads their own events (`actor=self`) with a reduced field set | the activity page for viewers and developers | yes |
| OD-46 | Host metrics history and a PostgreSQL log tail | open | (a) neither in V1: host values stay latest-only; a log tail waits for a redaction and retention decision | Studio-like report charts and a log page | yes |
| OD-47 | Changing a person's sign-in address | open | (a) as today: erase and invite again; an address change needs a verified delivery channel (OD-21) | an address change on the account page | yes |
| OD-48 | A SQL formatter in the Web App, given its license closure | open | (c) no formatter until one without a Python-2.0 dependency exists or the owner allows it; (a) would allow `Python-2.0` for the formatter's `argparse` (used only by its command line) | "Format SQL" in the SQL editor | yes |
| OD-49 | The server provider enum and `/api/v1` GA | open | (a) mark `ServerProvider` open (`x-extensible-enum`) before GA, so a provider added later is additive | the GA decision of `/api/v1` | yes |
| OD-50 | What the CLI may learn about the scopes an account could hold | open | (b) a CLI read action returning the scopes the person could be granted, computed like the consent page | "could get" in `whoami` and `doctor` | yes |
| OD-51 | An execution role with `BYPASSRLS` for adopted schemas | **resolved 2026-10-21** (Wave 9 order default D-A1; stands unless the owner overrules it) | a declared, audited, revocable exception per (project, environment, PostgreSQL role) that excuses exactly `BYPASSRLS` and nothing else; declared and revoked by people only (never MCP), production with an approval and a re-authentication; a warn rule in every plan that uses it; on production at least `high` and agent applies still need a human approval ([ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md)) | Wave 9 Part A (A4) | decided |
| OD-52 | Adopting a running, hand-made pgBackRest setup | **resolved 2026-10-21** (Wave 9 order default D-B2; stands unless the owner overruled it) | adopt, then own: first observe the existing stanza, repositories and schedules without changing them, then take ownership of configuration and scheduling through a planned, verified hand-over that stays reversible until confirmed; an ADR in Wave 9 B0 | Wave 9 Part B (B0, B2) | decided |
| OD-53 | Fingerprint lineage when environments use different owner roles | **resolved 2026-10-26** | option (a): fail closed; a lineage mismatch caused by owner names needs an approval (the legacy-project warning stays); fp1 unchanged; option (b) later only with an ADR and tests | nothing | decided |
| OD-54 | How an external cluster gains the node agent | **resolved 2026-10-26** | option (a): a controlled, one-way operation `registry.cluster.adopt_agent` (human only, production authority also while the tier is unknown, fresh re-authentication, audited, idempotent; the `system_identifier` pinned at registration must be reported exactly once by an enrolled node of the same server, checked at plan and again at apply); an additive bundle allows exactly external → agent and nothing else; targets keep placement, generation and marker | node capabilities on a cluster first registered external | decided |
| OD-55 | Procedural code in a migration session can act as any role the migrator holds | **resolved 2026-10-26** | options (c) and (d): a person approves every agent-initiated plan with procedural statements (`DO`, created and called routines, dynamic SQL where detectable) on **every** tier; the executor compares the `exponetdb` schema's ledger and marker state before and after each authored statement inside the transaction and refuses a change it did not make; fail closed where the check cannot run; cross-project role reach on one cluster stays a recorded residual risk | agent applies of procedural bundles without a person | decided |
| OD-56 | An excused value outside the fingerprint that changes after the review | **resolved 2026-10-26** | option (a): a keyed digest (HMAC-SHA-256 under a server-side installation key, never a plain hash) of the observed value of open-domain kinds is recorded with the excused failure and compared at every later verification; a changed value fails closed even with the same aspect; a missing or rotated key fails closed; values never appear in UI, API, audit or logs | nothing | decided |
| OD-57 | `advisors_run` records a run, but its scope `diagnostics.read` is a read scope | **open** | (a) a new additive oauth bundle makes `diagnostics.read` a write scope (consent shows it; clients that auto-approve read tools stop doing so); (b) a separate record scope for advisor runs (`diagnostics.record`), `diagnostics.read` stays read-only; (c) an advisor run over MCP records nothing (findings only from Web App, CLI and the worker) | nothing in Part B; the MCP annotation stays `readOnlyHint` until decided | open |
| OD-58 | How an operation in `needs_attention` is closed | **open** (built with option (a) by the test campaign fixes) | (a) the recovery plan that names it closes it as `verification_failed`, `unknown` becomes `partially_applied`; (b) (a) plus the planned `operation.force_release` for operations no recovery plan covers; (c) (a) with `verification_failed` admitting an `unknown` apply outcome | option (a) is in the code on the branch; the owner confirms or changes it | open |
| OD-59 | Flagging ledger rows as untrusted (`ledger.reconcile` with `flag_untrusted`) | **open** | (a) leave it unbuilt: `adopt_target` is the only decision, `flag_untrusted` is refused as `not_built`; (b) record the decision and a finding while the divergence keeps refusing plans; (c) remove it from the contract | (a) is in the code on the branch; the owner decides | open |
| OD-60 | How strict a restore drill is about `amcheck` | **open** (built with option (a) by the test campaign fixes) | (a) a check the node could not run everywhere (`not_run`) does not fail a drill and stays recorded; `failed` and `error` do; (b) strict: a drill is refused at planning unless the extension is known to exist in every database of the restored cluster; (c) the node creates `amcheck` in the disposable scratch cluster with the host's contrib package, so the check runs everywhere | (a) is in the code on the branch; the owner confirms or changes it | open |
| OD-61 | What an empty or missing drift baseline means, how large a read-lane result may be, and what counts toward the findings headline | **open** (nothing built; test campaign TC-017, TC-037) | (a) a target without a usable baseline reports one `no_baseline` finding and no `object_added` flood; roll-ups leave the severity counters; MCP results are capped (64 KB with a cursor) and repeated codes grouped; (b) keep the counts and only present them better (group by target and code, "rehearsal drift" separate); (c) leave as is | (a) together with OD-57 (b), as one change to the recording path |
| OD-62 | Node certificate expiry: a distinct refusal reason, findings and thresholds | **open** (the agent's `status` text is built; test campaign TC-042) | (a) reason `certificate_expired`, findings `node_certificate_near_expiry` (warning from 12 h before the end without a renewal, critical after) and `node_certificate_expired`; (b) findings only; (c) documentation only (built) | (a) with a 12 h warning |
| OD-63 | Who may withdraw a node plan, and whether withdrawing a revoke plan needs a fresh passkey | **open** (test campaign TC-020) | (a) the plan's creator withdraws it with the scope that created it, without a fresh passkey (withdrawing is the safe direction); (b) as (a), but a `node.revoke` or `node.decommission` plan still needs re-authentication to withdraw; (c) keep `nodes.operate` | (a) |
| OD-64 | How long an operation may wait for approval | **open** (test campaign TC-034; the owner is asked to look at `op_01M5X74EJ0CD4BYGRZ9DM1KZYA`) | (a) an `awaiting_approval` operation whose plan expired is canceled (`plan_expired`, audited) and the approval page says so; (b) a separate deadline for approvals (for example 24 h); (c) no deadline (today) | (b), with (a) as the floor |
| OD-65 | E16 and E18 waivers: detection before more imports | **open** (test campaign TC-023, TC-024) | (a) the OD-7a staging import counts as real REOSA data: build `hotfix_without_evidence` and `applied_not_in_source` before the next import; (b) it does not: keep the waivers until Wave 10 | (a) for E16 (a break-glass hotfix is reachable once a channel is set), (b) for E18 |
| OD-66 | G10.3 wording against OD-7b | **open** (test campaign TC-063) | (a) "at least five REOSA migrations applied staging-first; production evidence checked by a plan only until Wave 11"; (b) keep the wording and treat it as a Wave 11 gate | (a) |
| OD-67 | Step-up for enrolling a node | **open** (test campaign TC-053) | (a) one combined step-up whose receipt covers the plan apply and the token reveal of that plan only; (b) a longer receipt (5 min) for those two actions; (c) keep two receipts | (a) |

---

## OD-1. Web App language

- **Status.** RESOLVED
- **Decision date.** 2026-10-13
- **Decision.** Option (c): every user-facing string of the Web App is English
  (US spelling) behind a typed message key (`t('plan.apply.button')`); error
  text shows the catalog message plus the stable error code; a German catalog
  can be added later without touching components.
- **Source.** the owner's Wave 8 order (2026-10-13, D4, a default the owner
  issued unchanged; [`../14-roadmap/orders/wave-8-order.md`](../14-roadmap/orders/wave-8-order.md) §3,
  [G8 record §3](../14-roadmap/gates/8.md#3-owner-decisions-of-the-wave-8-order)).

History:

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

- **Status.** ENGINE DECIDED, STORAGE OPEN
- **Decision date.** 2026-10-21 (engine)
- **Decision.** The L1 engine (physical backups and WAL archive) is
  **pgBackRest** (the Wave 9 order's default D-B1, which stands unless the
  owner overrules it). Reasons: the owner already runs pgBackRest 2.59.3 on
  `reos-db-01` with client-side encryption, scheduled full, differential and
  monthly backups to S3-compatible storage and passed PITR drills (also on a
  freshly built host); this document recommended pgBackRest as well. The
  version is pinned per [`backup-engines.md` §3](../09-backups-and-restore/backup-engines.md),
  after the 2026-10-04 advisory is checked against the project's release
  notes in Wave 9 B0. The **storage** choice is not decided: it stays open
  until the measured storage spike of Wave 9 B0 (disposable buckets only)
  and is then put to the owner with the measurements (Cloudflare R2 with
  bucket lock rules, Hetzner Object Storage with S3 Object Lock, or both in
  different layers). The logical layer (`pg_dump` + restic to a second
  provider) is part of Wave 9 (D-B4). An existing hand-made setup is adopted,
  not replaced ([OD-52](#od-52-adopting-a-running-hand-made-pgbackrest-setup)).
- **Source.** the owner's Wave 9 order, §3.2 D-B1, D-B4
  ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md)).
- **Status (2026-10-26, the owner's Wave 9 Part B order).** The storage
  part (`OD-4-storage`) is **not decided** and stays `OPEN — BLOCKS G9 FULL
  ACCEPTANCE`. The owner wants to understand what each choice means in
  operation before choosing between Hetzner Object Storage and Cloudflare R2
  as the primary target. Part B therefore builds a provider-neutral
  architecture with several repositories per cluster
  ([ADR-0036](../01-architecture/adr/0036-backup-repositories-and-providers.md)):
  existing repositories (the owner's R2 repository on `reos-db-01`) are
  first adopted read-only, nothing is migrated between buckets, and no lock
  capability is assumed from a provider label. **Provisional recommendation
  of the implementing session, not an owner decision:** for new managed
  installations Hetzner Object Storage with S3 Object Lock as the L1
  candidate and Cloudflare R2 as the independent L3 candidate; for the
  existing installation R2 adopted read-only with its PITR chain untouched.
  Both are unproven until the restore and lock experiments of
  [`PRE-WAVE-11-REVIEW.md` W9-03](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-03-storage-choice-spike)
  ran on disposable buckets. Nothing in the repository says the owner
  decided Hetzner (or R2).

History:

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

- **Status.** RESOLVED (accepted), **revised 2026-10-13**
- **Revision (owner decision 2026-10-13).** "No one asks to approve each
  client URL first; not Supabase, not MongoDB." The default becomes open
  registration, close to option (b) below but with the consent and the
  kill switch kept:
  - `EXPONETDB_OAUTH_CLIENT_REGISTRATION=open` (the default): an unknown
    CIMD `client_id` at the authorization endpoint is fetched (the hardened
    fetcher, the same validation, 10 new clients per address and hour and
    100 per hour in total, shared with DCR) and recorded as **approved
    automatically** (no approver; the approval binds the fingerprint of the
    fetched metadata). A DCR registration is active at once. A pending
    client is approved automatically at its next authorization request. A
    changed CIMD document is approved again with its new fingerprint and
    keeps its grants. An unused automatically approved DCR registration is
    pruned after a week.
  - Unchanged: every person signs in with a passkey and consents to the
    client, the scopes and the tiers (production is its own opt-in); the
    client's name stays "not verified" with the lookalike warning; an
    administrator can **disable** a client (every grant ends at once) or
    reject a pending one, and a rejected or disabled client is never
    approved automatically; agents still need a human approval for
    production applies and read no production rows by default (OD-13 (a)).
  - `review`: the decision of 2026-10-06 below, unchanged.
  Implemented in `packages/auth/src/oauth/registry.ts`
  (`discoverCimdClient`, `approveAutomatically`) and the Control Store
  bundle `oauth-open-registration`; tested in
  `packages/auth/test/oauth-clients.int.test.ts` ("open registration").
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

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (a): no provenance requirement in V1. A bundle's source reference is recorded as `claimed` and shown as a claim; ExponetDB holds no Git credentials, fetches no repository and verifies no artifact signature in Wave 6. The security binding is the checksum ExponetDB computes over the bytes it received, staging evidence and approvals. Branch, tag and short commit ids are never called immutable provenance.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).

History:

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

- **Status.** RESOLVED (split into OD-7a and OD-7b)
- **Decision date.** 2026-10-21
- **Decision.** The question is overtaken by events: REOSA staging no
  longer runs on the hosted provider. It is split:
  - **OD-7a (staging): yes.** REOSA staging already runs on `reos-db-01`
    (self-managed, an external cluster without a node agent). After Part A
    of Wave 9 the owner registers it, imports its history and lets sessions
    apply staging migrations through ExponetDB. This is the owner's explicit
    authorization for exactly one real nonprod target set: REOSA staging and
    its scratch database on `reos-db-01`. It does not close the G2 off-host
    evidence and authorizes no production target.
  - **OD-7b (production): no applies before Wave 11.** REOSA production
    still runs on the hosted provider and moves only in Wave 11; until then
    ExponetDB at most observes it read-only.
  The REOSA-side deliverables of Wave 10 (bundle roots in REOSA's
  repository, REOSA Admin `/database`, the runtime schema contract) stay in
  Wave 10; the product capabilities Wave 10 needs (import of a real
  Supabase-origin history, per-environment execution roles, external-cluster
  onboarding) are brought forward into Part A of Wave 9.
- **Source.** the owner's Wave 9 order, §3.1 items 2 and 4
  ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md)).

History:

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
- **Status (2026-10-21, at the start of Wave 9).** Still **open**. The owner's
  Wave 9 order recommends option (a) (D-B3) and makes the decision a
  stop-and-ask point: Part B of Wave 9 (backups, restores, retention of the
  new records) does not start before the owner decides it. Part A (the
  migration engine for imported schemas) does not depend on it.
- **Status (2026-10-26, the owner's Wave 9 Part B order).** **Technical
  default decided: option (a).** The append-only, hash-chained audit is
  kept long-term (default `permanent`) and pseudonymously; personal data in
  clear text lives outside the hash chain and is resolved only for a reader
  with the permission; IP addresses are stored as installation-keyed HMAC
  values, raw user agents are not stored; a configured finite period is
  never below 400 days. This settles the setting Wave 9 builds against
  (retention of the new backup, restore and statistics records follows
  [`../02-control-plane/data-retention.md`](../02-control-plane/data-retention.md)).
  **It is not a legal decision and not legal advice.** Whether permanent
  pseudonymous retention is lawful for the owner's processing, and how
  erasure requests are answered, is an **EXTERNAL LEGAL REVIEW** that is
  `NOT PROVEN` and must pass before productive use with personal data
  ([`PRE-WAVE-11-REVIEW.md` W9-00](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-00-decision-registry)).
  Nothing in ExponetDB claims that permanent retention is always lawful.

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

- **Status.** RESOLVED (placeholder until the owner supplies brand values)
- **Decision date.** 2026-10-13
- **Decision.** Option (b) for now: no Exponet brand input exists (REOSA has
  none for ExponetDB, and `exponet.cloud` names the plant, not a brand).
  The Web App uses neutral placeholder tokens: a hue clearly different from
  Supabase green (indigo-blue around hue 255), the wordmark is the text
  "ExponetDB" set in the UI font (no logo mark), fonts Inter (UI) and Source
  Code Pro (mono), both SIL OFL 1.1, self-hosted from pinned packages with
  their license files. Everything is swappable through the token inputs
  only ([`../11-ui/design-system.md` §2](../11-ui/design-system.md#2-tokens)).
  Real brand values replace the placeholder when the owner supplies them.
- **Source.** the owner's Wave 8 order (2026-10-13, D5, a default the owner
  issued unchanged; [`../14-roadmap/orders/wave-8-order.md`](../14-roadmap/orders/wave-8-order.md) §3).

History:

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

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (a). Each target has the setting `dataRead: enabled | humans_only | disabled`, held as the per-target setting of the new policy rule `data.read` in `policy.rule_settings` (no change to a frozen registry bundle); the default is `humans_only` for production targets and `enabled` for nonprod targets, and an administrator changes it per target through a policy settings plan. An **agent** is every caller that is not a person acting through the Web App or the first-party CLI: an MCP client (client kind `mcp`), a service account, an API key, CI. A **human** is a Web App session or the CLI under a person's identity. On a target with `humans_only` an agent reads no rows, whatever scopes its grant holds (`data.read:prod` included); the REST route refuses the same way. For agents `EXPLAIN` runs without `ANALYZE` only. Caps: 500 rows, 5 MiB and a 60 s statement timeout for agents (5 000 rows for humans). Masking follows the project configuration and applies wherever reads are allowed.
- **Source.** the owner's Wave 7 order ("ExponetDB — Wave 7: MCP-Server", 2026-10-12, issued as this session's implementation prompt), confirmed by the owner in the session on 2026-10-12 as an entry condition of Wave 7 ([G7 record §3](../14-roadmap/gates/7.md#3-owner-decisions-of-the-wave-7-order)).

History:

- **Question.** May AI agents read production rows?
- **Why it matters.** Production contains personal data; agents can be steered by
  injected text and their outputs leave ExponetDB's control.
- **Options.** (a) `humans_only` default per production target, enabled per
  target by an admin; (b) allowed with masking; (c) never.
- **Recommendation.** (a), with masking applied wherever reads are allowed
  ([`../03-database-model/sql-execution-security.md`](../03-database-model/sql-execution-security.md)).
- **Blocks.** Wave 7.

## OD-14. Strictness of fingerprint lineage for production

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (a): a lineage mismatch (or unknown lineage) on a project with imported legacy history is a visible warning; after a documented reconciliation of the project's environments it requires an explicit approval. Missing or wrong staging evidence never becomes valid through this rule.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).

History:

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

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (a): RLS behavior tests with role or tenant switches stay in the consumer's own test suite. `verify.sql` gets no `SET ROLE`, no settings probe and no sandbox mode.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).

History:

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

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (a): staging is the V1 evidence environment. No automatic copy of production and no shadow or restore platform before Wave 9.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).

History:

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
- **Amendment (2026-10-23).** The repository is public. The owner replaced the
  proprietary notice with a custom source-available license, the ExponetDB
  Source-Available License 1.0 (`LICENSE`): reading and public forks are
  allowed; production use, commercial use, hosting and private copies need
  the owner's written permission or a commercial license; contributions
  come with a license-back so a commercial license stays possible. It is not
  an open-source license, and no text may call it one. Third-party files keep
  their own licenses (OD-38 still governs the Supabase-derived UI files). The
  owner should have the license checked by a lawyer before relying on it
  commercially. The text below is the original decision.
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

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** For the registry workflows of Wave 6 and the CLI: the intended tier of a cluster (and of a target) is declared explicitly and checked against `registry.manage` of that tier; a production registration is never allowed with nonprod authority alone. Option (a) of the recommendation, applied to the new workflows; existing Wave 4 rows keep their recorded tier.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).
- **Extended.** 2026-10-13 by the owner in the Wave 8 session: build both
  the declared intended tier on clusters (an additive nullable field in a new
  Control Store bundle) and a tier-aware `registry.manage`
  (`registry.manage:prod` and `registry.manage:nonprod`, like the other tiered
  permissions), so that setting the tier and registering a database of a
  cluster declared `prod` both need production authority. A change to a
  frozen artifact goes through a new version and an ADR, as always.
- **Implemented.** 2026-10-13, Wave 8 part 2 **[DECIDED]**: the bundle
  `01M4V2CT4N8PJ6GZ3YQ1RWK7HD_cluster-declared-tier` adds
  `registry.clusters.declared_tier` (`prod`, `nonprod`, NULL while
  undeclared); `POST /clusters/{id}/declared-tier` plans
  `registry.cluster.declare_tier` (production authority whichever value);
  the cluster view shows `declaredTier`. Every `registry.manage` action
  has a registry tier ([authorization.md §5.1](../08-auth-and-security/authorization.md#51-the-registry-tier-of-registrymanage-od-22)):
  registering a database of a cluster declared `prod` needs production
  authority whatever environment; on a cluster declared `nonprod` the
  environment decides; an **undeclared cluster counts as `prod`** (this
  decision's rule for an unknown tier, fail closed). Production authority
  is a role binding that spans or holds the production tier (`global`,
  `product`, `project`, or an environment or target binding of a
  production environment) and, for the CLI, a grant whose tiers include
  `prod`. Existing bindings are unchanged and keep their access.
  **Deviation from the wording "`registry.manage:prod` and
  `registry.manage:nonprod`" (owner to confirm):** no new OAuth scope
  strings were added, because the frozen bundle `oauth-delegation`
  verifies the stored scope catalog exactly (four `:prod` and four
  `:nonprod` scopes, fifteen with explicit consent) and a new row would
  fail that frozen verification on every new installation; the grant's
  tier restriction carries the delegated tier. Adding the tiered scope
  strings needs an owner decision on a new verification version (an ADR).

History:

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
- **Decision.** 2026-10-07, by the owner in the Wave 5 session: **option
  (a)**, ADR-0024 §1 to §3 as proposed. ADR-0024 is accepted.

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
- **Decision.** 2026-10-07, by the owner in the Wave 5 session: **option
  (a)**, ADR-0024 §4.

## OD-25. Evidence environment for systemd (Wave 5)

- **Added.** 2026-10-07 (Wave 5 Phase 0; [G5 record §5](../14-roadmap/gates/5.md#5-evidence-environment-od-25)).
- **Question.** Where does G5 get real systemd evidence on Ubuntu 24.04?
- **Options.** (a) a privileged, disposable Ubuntu 24.04 container running
  systemd as PID 1 in the session or in CI; (b) a VM or self-hosted runner
  the owner provides (no production data, reachable only by CI); (c) both:
  (a) during development, (b) for the G5 record.
- **Recommendation.** (c); without (b) the systemd items may end `NOT PROVEN`
  if (a) is not accepted as real systemd evidence.
- **Decision.** 2026-10-07, by the owner in the Wave 5 session: **option
  (c)**. The container serves development; the G5 record needs the owner's
  VM or runner, and the systemd items stay `NOT PROVEN` until it exists.

## OD-26. Who may read a plan or an operation (`read_of_kind`)

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (c) within the existing subject limits: `plan.get`, `operation.get` and `operation.list` need the read permission of the kind's domain (`targets.read` for target and registry kinds, `migrations.read` for migration kinds, `nodes.read` for node and cluster kinds, `access.read` for access kinds, `backups.read` for backup and restore kinds) at a scope that covers the plan's or operation's subject, with the delegated scope of that permission and the grant's restrictions; holders of `plans.approve` at a scope covering the subject may read the plans and operations they could approve. The creator reads through the same rule with their current identity, scope and delegation; holding a plan or operation id grants nothing. `plans.approve` on one project opens nothing of another. Lists filter by these rules before pagination.
- **Source.** the owner's Wave 6 order ("Wave 6: Migration Engine und vollständiger CLI", 2026-10-12, issued as this session's implementation prompt; [G6 record §3](../14-roadmap/gates/6.md#3-owner-decisions-of-the-wave-6-order)).

History:

- **Added.** 2026-10-07 (Wave 5 Phase 5; [G5 record](../14-roadmap/gates/5.md), [`control-plane.md` §9](../07-node-agent/control-plane.md#9-capability-operations)).
- **Question.** Which read permission and scope govern `GET /plans/{planId}`,
  `GET /operations/{operationId}` and `GET /operations` for each operation
  kind? The action catalog says `read_of_kind` (the read scope of the plan's
  or operation's kind) without naming the read permission of a kind, so the
  three routes have had no handler since Wave 2.
- **Why it matters.** Capability operations through a node (Wave 5) end
  asynchronously: a person sees the acceptance in the `plan.apply` response
  and the node's observations, but not the operation's final apply and
  verification outcome over REST. The Web App (Wave 8) needs these reads.
- **Options.** (a) The kind's own domain read permission: `targets.read` for
  target and registry kinds, `migrations.read` for migration kinds,
  `nodes.read` for node and cluster kinds, `access.read` for `access.*`,
  `backups.read` for backup and restore kinds; the creator of a plan may
  also read it. (b) The permission that planned the
  kind (`nodes.plan`, `registry.manage`, …), so only who may plan it may read
  it. (c) As (a), and `plans.approve` holders may read every plan.
- **Recommendation.** (c): reads follow the domain, and approvers must see
  what they approve.
- **State before the decision.** Open until 2026-10-12; until then the
  operation outcome was visible in the Control Store and the audit chain only.

## OD-27. Moving the agent gateway to a new address

- **Added.** 2026-10-08 (Wave 5 Phase 6; [G5 record](../14-roadmap/gates/5.md), [`control-plane.md` §9.8](../07-node-agent/control-plane.md#98-job-key-rotation-nodeconfigupdate)).
- **Question.** How does an installation move its private agent gateway to a
  new address and server name (the move to `exponet-01`,
  [`deployment.md` §7](../12-operations/deployment.md#7-later)) without
  losing a node?
- **Why it matters.** The agent supports a new gateway address in
  `config.update@1` and connects to it at its next reconnect, pinning the
  same root. But `node-pki init` records one address and server name, the
  gateway mints its TLS certificate for that one name, and a node told the
  new address before the gateway answers to it, or one that misses the
  update, is cut off until a local operator re-enrolls it. Wave 5 therefore
  changes job keys only and always sends `gateway: null`.
- **Options.** (a) A `node-pki gateway --add <url> --server-name <name>`
  command records a second address; the gateway certificate names both
  server names during the move; `node.config.update` sends the new address
  to each node and verifies it by the node's next hello on the new
  listener; the old name is dropped once no live node uses it. (b) Re-enroll
  every node against the new gateway (no new mechanism; every node needs a
  local operator and a new token). (c) Keep the gateway's address stable
  (a DNS name that moves with it) and never change the server name.
- **Recommendation.** (c) for the planned move, since it needs nothing new
  when the server name stays; (a) when a name must change.
- **Decision.** Open; for the owner. Not a Wave 5 blocker.

## OD-28. Node exports stored before the confidentiality correction

- **Added.** 2026-10-08 (Wave 5 correction F1; [`capabilities.md` §6](../07-node-agent/capabilities.md#6-confidentiality-of-node-exports-wave-5-correction-f1), [G5 record](../14-roadmap/gates/5.md)).
- **Question.** What happens to the node statements (`nodes.jobs.completion`
  and the signed arguments in `nodes.jobs.envelope`), observations
  (`nodes.observations.result`) and plan bodies (`operations.plan_bodies`)
  that a retired capability major stored before the correction? They can
  hold host values the node did not classify: configuration and role
  settings (a token in a custom parameter, a password in
  `primary_conninfo`), `pg_hba` options (`ldapbindpasswd`,
  `radiussecrets`), PostgreSQL error text and log lines.
- **Why it matters.** The corrected code serves none of them (quarantine,
  fail closed), but they stay in the Control Store and in every backup of
  it. The tables are append-only, a statement is node-signed (`nr1`) and a
  plan body is bound to its plan hash, so scrubbing them is an irreversible
  change of evidence that only the owner may authorize; the audit chain is
  never rewritten. A value already exported cannot be un-exported: only
  rotating the credential it held removes the exposure.
- **Options.** (a) Keep the rows quarantined and unchanged; rotate every
  credential a retired major may have exported. (b) As (a), and scrub the
  stored bodies once with the owner-run procedure, which records for each
  scrubbed row the SHA-256 of the original body and the procedure's version
  (provenance), keeps the row and its identifiers, and leaves the audit
  chain untouched. (c) Delete the affected rows (breaks the evidence links
  of operations and the append-only guarantees; not recommended).
- **Recommendation.** (b) on an installation that ran Wave 5 before the
  correction; nothing to do on one that did not (no retired major ever ran).
- **Procedure.** Ready, not run anywhere: a read-only census and the scrub
  of option (b) (`packages/nodes/maintenance/od28/`, [`node-runbook.md` §10](../12-operations/node-runbook.md#10-od-28-node-exports-stored-before-the-correction-owner-only)),
  proven on a fixture store with canary values
  (`apps/server/test/od28-remediation.int.test.ts`: no table holds the
  canary afterwards, current rows and the audit chain are unchanged, every
  bundle's verification passes, a second run changes nothing). Since the
  correction no new such row is stored: the agent parks statements an
  earlier release held, and the gateway refuses a retired major's
  completion ([`capabilities.md` §6](../07-node-agent/capabilities.md#6-confidentiality-of-node-exports-wave-5-correction-f1)).
- **Decision.** Resolved 2026-10-12 at the G5 acceptance: the owner adopted the recommendation. Nothing to do on the owner's installation, which ran Wave 5 only after the corrections ([deployment record](../12-operations/deployments/2026-10-12-reos-01-wave6.md)); where such rows exist the procedure above applies and they stay quarantined until then.

## OD-29. Node changes by machine callers through MCP (G5 follow-up F9)

- **Status.** RESOLVED
- **Decision date.** 2026-10-12
- **Decision.** Option (c) for Wave 7: no MCP tool plans or applies a node change. `node_plan` is not listed in `exponetdb.mcp/v1`; `nodes_list` and `node_status` (reads) are. REST and the CLI keep their Wave 5 behavior (service accounts with `nodes.plan` and `nodes.operate:nonprod` may plan and apply nonprod node changes there). A later wave that wants node planning over MCP brings this question back with option (a) or (b) and a policy rule.
- **Source.** the owner's Wave 7 order (2026-10-12), confirmed by the owner in the session on 2026-10-12 as an entry condition of Wave 7 ([G7 record §3](../14-roadmap/gates/7.md#3-owner-decisions-of-the-wave-7-order)).

History:

- **Added.** 2026-10-12, from [G5 record §11.2](../14-roadmap/gates/5.md#11-acceptance-2026-10-12) item 16 (finding F9 of the Wave 5 correction order), an entry condition of Wave 7.
- **Question.** May service accounts and MCP clients holding `nodes.plan` and
  `nodes.operate:nonprod` plan and apply nonprod node changes (including
  `pg_hba` and critical roles) without an approval?
- **Options.** (a) yes, as implemented in Wave 5; (b) an approval for
  critical classes on nonprod (a new policy rule); (c) never through MCP.
- **Recommendation.** (c) for Wave 7.

## Decisions of the Wave 7 order (2026-10-12)

The owner's Wave 7 order listed fourteen proposed decisions that bind when the
order is issued unchanged; the owner issued it unchanged and confirmed OD-13
and F9 in the session. **[DECIDED]** 2026-10-12, source: the Wave 7 order
([G7 record §3](../14-roadmap/gates/7.md#3-owner-decisions-of-the-wave-7-order)).
OD-13 (decision 1) and OD-29 (decision 6, the F9 entry condition of Wave 7: no node planning through MCP) are above; the others:

| # | Topic | Decision |
|---|---|---|
| 2 | Tool scope of Wave 7 | the tools of the Wave 7 part of `exponetdb.mcp/v1` ([`tool-catalog.md`](../05-mcp/tool-catalog.md)); the Wave 9 tools stay unlisted; `node_plan` follows OD-29 |
| 3 | Protocol versions and the legacy promise | modern `2026-07-28`; legacy `2025-11-25` and `2025-06-18`; `2025-03-26` and `2024-11-05` are refused with the supported versions named. The specification sets no sunset date for a revision; ExponetDB's own promise (legacy removed no earlier than twelve months after an announcement and only after checking the client matrix) is the owner's and is stated so in [`versioning.md`](../01-architecture/versioning.md) |
| 4 | Legacy session model | stateless: no `Mcp-Session-Id` is issued or returned; the approval link is always in the result for legacy clients; no legacy URL elicitation |
| 5 | Approval link and the G7 wording | `approvalUrl` is `<public origin>/approvals#operation=op_…` (the existing page, ADR-0026); the gate wording "land on the plan review page" can only be met literally with Wave 8: the G7 record lists it as partial by design and the owner decides at G7 |
| 7 | Redirect URIs with a custom scheme | no loosening of the Wave 3B rule (`https` or loopback `http`, exact match); a narrow mechanism is proposed to the owner and not built without a decision |
| 8 | Tasks extension | not in Wave 7; the operation is the durable handle with polling |
| 9 | Rate limits and bounds | token bucket per grant (per identity twice the rate), in process: reads 20/s (burst 100), plan creation 2/s (burst 5), apply 1/s (burst 2), data reads 5/s (burst 10); concurrent data reads at most 2 per grant, 3 per target, 8 overall (agents at most 2 per target and 6 overall, so agents alone never hold every slot; owner, 2026-10-13); concurrent streams at most 4 per grant; header and body read 10 s and 30 s, a whole request 90 s; numbers in one configuration table, tested and documented |
| 10 | Standing-access findings | producer in Wave 9, "last used" display in Wave 8; Wave 7 records the last use per grant only |
| 11 | The target flag `protected` | removed from [`staging-production-policy.md`](../04-migrations/staging-production-policy.md); nonprod applies by agents need no approval (as implemented since Wave 6) |
| 12 | Evals with a model | optional: the harness and tasks are delivered; the owner runs them with their own key; without model access the run is `NOT RUN` |
| 13 | The acceptance branch | Wave 7 is based on `fix/g5-g6-acceptance-record` (`c701e2e`), which the owner pushed on 2026-10-12; its commits are not changed |
| 14 | GA of `/api/v1` | not declared in Wave 7; a readiness report is delivered and the owner decides at G7 |

## Open decisions of the Wave 7 follow-up (2026-10-13)

An external agent tested the live endpoint on 2026-10-13 against an empty
registry; the findings were checked against the repository. The items that
needed no decision are in the follow-up change of the same date (branch
`feat/mcp-refusal-contract`); the eight below need the owner. G7 itself is
not touched by it.
Nothing here is decided and, except where an entry says it is already built,
nothing is implemented. Line references are to commit `1966cf4`.

## OD-30. Request id in every tool result

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** Does every `tools/call` result, success or refusal, carry the
  request id of the server log?
- **Why it matters.** [`error-model.md`](../02-control-plane/error-model.md)
  §1 gives the request id to refusals. A successful read left no id the
  caller could quote, so an operator could not find that call in the log.
- **Status of the code.** Already built by `4755298` (merged before this
  follow-up): every result carries `_meta["cloud.exponet.db/requestId"]` and
  ends with the server line `Request req_…, N ms.`
  (`apps/server/src/interfaces/mcp/server.ts`, `timed`). `_meta` on a result
  is the specification's own extension point in both served revisions (M-5 of
  the [protocol baseline](../05-mcp/protocol-baseline.md) already puts
  `io.modelcontextprotocol/serverInfo` there); the output schemas are
  unchanged, so no tool version moved.
- **Options.** (a) keep both: `_meta` for programs, the last line for models
  that read only the text; (b) `_meta` only; (c) refusals only, as before.
- **Recommendation.** (a). The line costs one text line and is the only form
  a model that ignores `_meta` can quote to its person.
- **Blocks.** Nothing. **Owner decision needed.** Yes, to confirm what is built.

## OD-31. Duration of a tool call in its result

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** May a result carry how long the call took, and which results?
- **Why it matters.** A duration helps a model and a person see a slow read.
  It is also a clock: the existence floor
  (`apps/server/src/interfaces/existence.ts`, one time class for "not
  there") exists so the timing of a refusal says nothing about what exists.
- **Status of the code.** Built by `4755298`, wider than the recommendation
  below: `_meta["cloud.exponet.db/durationMs"]` and the number in the last line
  are on **every** result except a "not there" answer (`*_NOT_FOUND`), which
  carries the request id only. A refusal such as `PERMISSION_DENIED` or
  `VALIDATION_FAILED` therefore carries an exact duration. The spec of the
  result envelope allowed none. `durationMs` also exists on `sql_explain`
  results (`packages/contracts/src/rest/resources.ts`).
- **Options.** (a) as built; (b) durations on successful reads only, never on a
  refusal; (c) none.
- **Recommendation.** (b). A refusal that is not a "not there" answer still
  runs the authorization path, and its exact duration is a measurement of that
  path that a caller can repeat; a successful read's duration is the caller's
  own business.
- **Blocks.** Nothing. **Owner decision needed.** Yes. A change touches
  `timed` in `server.ts`, its tests and the replay transcripts, not the tool
  digests.

## OD-32. Concealment of servers and clusters

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** Does a caller who may not see a server or a cluster get the
  same answer as for an unknown one?
- **Why it matters.** [`error-model.md` §4](../02-control-plane/error-model.md)
  conceals a hidden object like an unknown one. The engine does it for targets
  and for the registry levels above them (`CONCEALED_LEVELS`: product, project,
  environment, `packages/auth/src/authorization/engine.ts:110`); servers and
  clusters are not in the set. An unknown server id answers `NOT_FOUND`
  (`subject_unresolved`, `engine.ts:679`); an existing one the caller cannot
  read answers `PERMISSION_DENIED` (`engine.ts:749`). The difference tells a
  caller that an id exists.
- **Options.** (a) add `server` and `cluster` to the concealed levels; (b)
  leave: the ids are random (80 bits), so an id is learned only from a
  response the caller was entitled to; (c) conceal only for MCP and agent
  callers.
- **Recommendation.** (a). The cost is one set entry and its tests, the rule
  stays uniform, and (b) is the position the R2 decision (2026-10-07) moved
  away from for targets. This is a security decision; no code is changed
  before the owner answers.
- **Blocks.** Nothing. **Owner decision needed.** Yes.

## OD-33. Session ids in the audit view

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** Is a `ses_` id a public identifier or a secret, and does the
  audit store and show it raw?
- **Why it matters.** The documents disagree. [`audit.md`](../02-control-plane/audit.md)
  shows `client.sessionId` (`ses_…`) in the envelope but says "session ids in
  raw form never appear"; [`secrets.md`](../08-auth-and-security/secrets.md)
  says session ids are stored as "hashes only", while
  [`resources.md`](../06-rest-api/resources.md) lists "public `ses_` ids" in
  `GET /me/sessions`. The code writes the raw `ses_` id of a Web App caller
  into the audit event (`packages/application/src/application.ts`,
  `denialParties` and `readParties`), the schema accepts it
  (`packages/contracts/src/audit.ts`, `sessionId: entityId('ses')`) and the
  read view projects it. The session **token** (the cookie secret) is stored
  only as a hash (`packages/auth/src/sessions.ts`, `token_hash`); a `ses_` id
  alone grants nothing. Audit rows are immutable, so historic raw values stay.
- **Options.** (a) `ses_` is a public identifier, not a credential: keep the
  raw id, and correct the two statements that say "session id" where they mean
  the session token; (b) new events record only a keyed hash of the id (a new
  audit member, so a new schema version through an ADR, because events are
  hashed as they are shaped), and the read view masks the historic raw values
  and shows the hash for listed sessions; (c) drop `sessionId` from the audit.
- **Recommendation.** (b), after the owner states that a `ses_` id is not
  public (then (a) is wrong); if the owner calls it public, (a) is enough and
  costs documents only. Either way the three statements are fixed with the
  decision; they are left alone until then.
- **Blocks.** Nothing. **Owner decision needed.** Yes.

## OD-34. Classification and audit of `drift_check`

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** Is a drift check a read or a write of ExponetDB's own records,
  and is it audited?
- **Why it matters.** `drift_check` writes `observation.drift_checks`,
  `observation.schema_snapshots` and `observation.findings` in one
  transaction (`packages/diagnostics/src/drift.ts`, `snapshots.ts`,
  `findings.ts`) and changes no database. Its action `drift.check` has
  class `read` and effect `control_record` (`packages/contracts/src/actions.ts`,
  `record(...)`), its scope is `schema.read`, which the schema tools share, and
  `isWriteScope` (any effect other than `read`) makes the consent flow treat
  `schema.read` as a write scope: re-authentication when production is chosen
  (`packages/auth/src/oauth/consent.ts`). The write leaves no audit event, and
  [`audit.md`](../02-control-plane/audit.md) is silent on record writes. The
  consent page and the tool descriptions now say what it does
  ([`tool-catalog.md` §2](../05-mcp/tool-catalog.md)).
- **Options.** (a) keep: it is a read of the target with a cache in the
  Control Store; document that explicitly; (b) a scope of its own for the
  record-writing action (and an audit event for record writes), so a grant
  that only reads schemas never writes; (c) do not persist the result of an
  agent's check.
- **Recommendation.** (b), or (a) with the semantics written down. Under (b)
  `drift_check` leaves `schema.read` (a grant that holds it loses the tool
  until it is consented again), the tool definition changes (a new
  `toolVersion` and pin) and `audit.md` gains the event.
- **Blocks.** Nothing. **Owner decision needed.** Yes.

## OD-35. A grant describing itself over MCP

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** May an MCP client learn which scopes, tiers, expiry and grant
  it holds?
- **Why it matters.** No MCP tool or resource says it
  ([`tool-catalog.md` §11, §12](../05-mcp/tool-catalog.md)); the REST route
  `GET /me/grants` (`resources.md`) and the CLI `whoami` exist outside MCP. An
  agent that is refused for a scope can only guess what it holds. Since
  `4755298` an empty `targets_list` names the grant's scopes (the one place).
- **Options.** (a) a read-only resource `exponetdb://me/grant` with the scopes,
  the grant id, the expiry and the client kind of the calling grant, and no
  list of other grants and no project names of a restricted grant; (b) a tool
  (a new tool, so a pin and a rate class); (c) nothing.
- **Recommendation.** (a): a resource needs no tool pin, shows only what the
  caller already holds, and is cacheable `private`.
- **Blocks.** Nothing. **Owner decision needed.** Yes.

## OD-36. The `toolCallMs` limit

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** Is a tool call bounded at 50 s, or only the request at 90 s?
- **Why it matters.** `MCP_REQUEST_LIMITS.toolCallMs` (50 s,
  `packages/contracts/src/mcp/protocol.ts`) is declared but not enforced
  ([`client-matrix.md`](../05-mcp/client-matrix.md) item 8); the edge's
  deadline is `requestTimeoutMs` (90 s). A declared number nothing uses is a
  promise a reader may rely on.
- **Options.** (a) enforce it: a tool call ends at 50 s with the same answer
  as the 90 s deadline (a read ends; an accepted operation continues); (b)
  remove the declaration and the document line; (c) keep it as documentation.
- **Recommendation.** (b) unless a client is known to time out between 50 s
  and 90 s: every slow path has its own bound (`operation_get` waits at most
  20 s, a data read its 60 s statement timeout).
- **Blocks.** Nothing. **Owner decision needed.** Yes.

## OD-37. The lab client under open registration

- **Added.** 2026-10-13 (Wave 7 follow-up).
- **Question.** What does "the lab client is approved once by its owner" mean
  now that the default is open registration?
- **Why it matters.** The [G7 record](../14-roadmap/gates/7.md) (decisions of
  2026-10-13) keeps the lab client "as built": it "registers like any client
  and is approved once by its owner with a passkey (OD-5 (a), no silent
  pre-trust)". Since the same day the default is
  `EXPONETDB_OAUTH_CLIENT_REGISTRATION=open` (`apps/server/src/config/env.ts`,
  [OD-5](#od-5-mcp-client-registration-policy)): a new client is approved
  **automatically**, and the person still signs in and consents. The sentence
  describes `review` and is wrong under the default.
- **Options.** (a) correct the sentence: under `open` the lab client is
  approved automatically and its owner consents with a passkey; (b) run the
  lab with `review` so that an administrator still approves its client
  explicitly; (c) a lab-only approval path (the owner rejected it on
  2026-10-13).
- **Recommendation.** (a) for the record, and (b) for a lab that wants to
  exercise the explicit approval, which the owner test package then says.
- **Blocks.** The wording of the G7 record only. **Owner decision needed.**
  Yes.

## OD-38. License basis of copied Supabase UI files

- **Number.** Named OD-30 in the Wave 8 order and in `davdxpx/ExponetDB#24` until the merge with `main`, where the Wave 7 follow-up had taken OD-30 to OD-37 the same day.

- **Added.** 2026-10-13 (Wave 8 Phase 0, [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md)).
- **Question.** Which license governs a file copied from Supabase's
  `packages/ui`, `packages/ui-patterns` or `packages/config`: the
  repository's Apache-2.0, or the MIT that each package declares in
  `package.json` without a license file?
- **Why it matters.** The obligations differ in form (Apache-2.0 §4: the
  license text, retained notices, prominent change notices; MIT: the
  copyright and permission notice). The source does not settle it: there is
  no `NOTICE` and no package license file, and shadcn/ui-derived files carry
  no notice of their own.
- **Options.** (a) comply with the superset: ship the Apache-2.0 text, keep
  "Copyright 2024 Supabase", mark every file as modified in its header, and
  also ship the MIT notice text; (b) treat the MIT declaration as governing
  and ship only the MIT notice; (c) ask Supabase for a statement.
- **Recommendation.** (a): it satisfies either reading and costs one header
  line per file plus three license texts.
- **Blocks.** Release of the Wave 8 Web App (the copy work proceeds under
  (a) meanwhile; if the owner does not accept it, the abort criterion of
  Wave 8 applies).
- **Owner decision needed.** Yes.
- **Files flagged by the file-specific reviews** (Wave 8 Phases 2 to 4;
  each register row names the point):
  - `packages/tokens/src/utilities.css`: its source comment says the
    shimmer utility inlines shadcn/ui's; MIT (shadcn/ui) is applied.
  - `packages/ui-patterns/src/date-picker/date-picker.tsx`: the composition
    follows shadcn/ui's documented date-picker example; MIT (shadcn/ui) is
    listed as a precaution.
  - `packages/ui-patterns/src/multi-select/multi-select.tsx` and its test:
    names and Backspace behavior look like the community "shadcn-extension"
    multi-select (MIT); the source carries no notice and the shallow source
    history cannot confirm it. State, markup, keyboard handling and ARIA
    were rewritten. Question for the owner: add a notice for that project
    to `THIRD_PARTY_NOTICES.md`, or rewrite the component from scratch.
  - Handled without a question: `packages/ui/src/lib/clipboard.ts` (its
    source credited a blog post of unknown license: rewritten natively, not
    a copy) and `packages/ui-patterns/src/info-tooltip.tsx` (an inline icon
    path that looked like Heroicons was replaced).

## OD-39. Hosting of the design-system app

- **Number.** Named OD-31 in the Wave 8 order until the merge with `main` (see OD-38).

- **Added.** 2026-10-13 (Wave 8 Phase 0).
- **Question.** Where, if anywhere, is `apps/design-system` (a static site
  with guidance, demos and an agent-readable index) published?
- **Why it matters.** The documents name the app but no host. Publishing it
  adds a deployable resource; not publishing it keeps it a repository tool.
- **Options.** (a) not deployed: built and checked locally (and in CI once
  a runner starts); agents read its Markdown index from the repository;
  (b) a separate static resource on `reos-01` behind the same sign-in;
  (c) served by `serve` under a path of the Web App.
- **Recommendation.** (a) until somebody outside the repository needs it;
  (c) would put demo code in the product's origin.
- **Blocks.** Publishing the app; not G8.
- **Owner decision needed.** Yes.

## OD-40. The SQL editor component under the Web App's CSP

- **Number.** Named OD-32 in the Wave 8 work until the merge with `main` (see OD-38).

- **Added.** 2026-10-13 (Wave 8 Phase 1, the CSP and library spike; [G8 record §5.1](../14-roadmap/gates/8.md#51-phase-1-tooling-server-seam-spike)).
- **Question.** Which editor powers the SQL section (query and draft modes)
  and the text diff viewers, given that the Web App's CSP stays
  `script-src 'self'; style-src 'self'` (order D9)?
- **Why it matters.** The order planned Monaco and said: if it cannot work
  without relaxing `style-src`, or a different editor strategy is forced,
  ask the owner. The spike measured, in Chromium 141 under the exact policy:
  Monaco 0.57.0 creates `<style>` elements in `createStyleSheet()` (no
  option for constructable stylesheets) and writes `style="…"` through
  thirteen `innerHTML`/`insertAdjacentHTML`/`setAttribute('style')` sinks;
  unpatched it is degraded (no syntax colors, no glyph font, selections and
  the diff layout broken, 160 and 106 violations); with three build-time
  patches to its own modules it reaches zero violations, but the patches
  fork Monaco internals and its bundle carries a 6.9 MB TypeScript worker.
  CodeMirror 6 mounted inside a shadow root uses constructable stylesheets
  and reaches zero violations with no patch (editor, completion, search,
  merge view).
- **Options.** (a) CodeMirror 6 in a shadow root; (b) Monaco with the
  build-time patches, re-verified on every Monaco upgrade; (c) Monaco
  unpatched with a relaxed `style-src` (`'unsafe-inline'` for styles):
  rejected by the order's default D9 and the threat model.
- **Recommendation.** (a): it keeps the policy, needs no fork, is smaller,
  and the editor sits behind an interface in `packages/ui-data`, so (b)
  stays possible later.
- **Blocks.** Nothing until the SQL section (Phase 11); the session builds
  on (a) behind the interface meanwhile and changes course if the owner
  chooses (b).
- **Owner decision needed.** Yes.
- **Status.** RESOLVED
- **Decision date.** 2026-10-13
- **Decision.** Option (a). The owner asked for the SQL editor to be built on
  the same infrastructure and in the same way as Supabase's; asked whether
  that meant Monaco with a relaxed CSP, a patched Monaco or CodeMirror built
  like Supabase's editor, the owner chose CodeMirror built like Supabase's
  editor: the same workflow and look (query tabs, completion, formatting,
  run and results grid, shortcuts), CodeMirror 6 in a shadow root behind the
  editor interface of `packages/ui-data`, and the CSP of D9 unchanged.
- **Source.** the owner, in the Wave 8 session on 2026-10-13
  ([G8 record §3](../14-roadmap/gates/8.md#3-owner-decisions-of-the-wave-8-order)).

## OD-41. Connection details for people without `registry.manage`

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit;
  [`../11-ui/studio-parity.md`](../11-ui/studio-parity.md)).
- **Question.** May people who read a target (`targets.read`) but do not
  administer the registry see how to reach its database: endpoint host,
  port, database name and TLS server name (never a credential), as Studio's
  Connect sheet shows them?
- **Why it matters.** Applications connect to databases directly, never
  through ExponetDB, so the people who configure them need the address; but
  [`resources.md`](../06-rest-api/resources.md) shows endpoint addresses
  only to `registry.manage`, and an address list of production databases
  helps an attacker map the fleet. The Wave 8 completion builds a secret-free
  Connect panel for registry administrators only (URI and `psql` line with a
  password placeholder, `sslmode=verify-full`).
- **Options.** (a) keep: registry administrators only; (b) a new read
  `GET /targets/{id}/connection` for `targets.read` on every tier; (c) (b)
  for non-production tiers only. Each option leaves the CA certificate that
  `verify-full` needs ([OD-17](#od-17-ca-strategy-for-postgresql-server-certificates))
  to the operator's channel.
- **Recommendation.** (a) until a consumer team asks, then (c).
- **Blocks.** A Connect panel for readers who are not registry administrators.
- **Owner decision needed.** Yes.

## OD-42. How the read-only table browser reads rows

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** Studio's most used page is the table editor. ExponetDB has
  no row editing, but a read-only browser of a table's rows is in reach: does
  the Web App build the `SELECT` and send it through the existing data-read
  query endpoint, or does a typed rows endpoint build it on the server?
- **Why it matters.** Through the query endpoint there is one data-read
  path: the server parses and admits the statement, masks sensitive
  columns, caps rows and bytes and audits each read; the browser only quotes
  catalog identifiers and passes filter values as bind parameters. A typed
  endpoint would add a distinct audit action and server-side paging, at the
  cost of a second data-read path to review and keep equal.
- **Options.** (a) the query endpoint (as built); (b) a typed
  `GET /targets/{id}/tables/{name}/rows`.
- **Recommendation.** (a).
- **Blocks.** Nothing; the browser is built on (a) and changes course if the
  owner chooses (b).
- **Owner decision needed.** Yes.

## OD-43. A read of a cluster's PostgreSQL roles and its permission

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** Studio lists a database's roles with their attributes and
  connection limits. ExponetDB reads them only into the cluster fingerprint
  and shows the desired roles of a cluster; should a read of the actual
  roles (attributes, connection limit, memberships; never verifiers) exist,
  and which permission covers it?
- **Options.** (a) none (the schema browser's Roles page stays "not
  supported"); (b) `nodes.read`, which already shows a cluster's desired
  roles; (c) `schema.read` per target.
- **Recommendation.** (b): roles are cluster-wide, like the desired state.
- **Blocks.** The Roles page of the schema browser.
- **Owner decision needed.** Yes.

## OD-44. Server-side DDL generated for display

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** Studio shows a table's `CREATE` statement, copies an ERD as
  SQL and turns a branch diff into a migration. Should ExponetDB generate
  DDL text on the server (a clean-room deparse; DDL generation is a
  clean-room area under C-2) for display, and later as a migration draft?
- **Options.** (a) not in V1; (b) display only (definition tab, "copy as
  SQL"); (c) (b) plus "draft a migration from this diff", always a draft
  that goes through lint, plan, approval and the evidence rule.
- **Recommendation.** (a): drafts written by people stay the only source of
  migrations until the migration engine has run in production.
- **Blocks.** A definition tab for tables, ERD "copy as SQL", drafting from
  the environment comparison.
- **Owner decision needed.** Yes.

## OD-45. A person's own activity without `audit.read`

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** The account page's activity (`actor=self`) needs
  `audit.read`, so viewers and developers see "not permitted" for their own
  actions. Should every person read their own events?
- **Options.** (a) keep `audit.read`; (b) `actor=self` for every person,
  with the pseudonymized field set `audit.read` already gives.
- **Recommendation.** (b).
- **Blocks.** The activity page for people without `audit.read`.
- **Owner decision needed.** Yes.

## OD-46. Host metrics history and a PostgreSQL log tail

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** Studio's reports chart CPU, memory, disk and connections over
  time and show PostgreSQL logs. ExponetDB keeps the latest host values from
  the node agent and health samples with their conditions; should it store
  host metrics over time, and read redacted PostgreSQL log lines through the
  node's log inspection?
- **Options.** (a) neither in V1; (b) connection counts in the health
  history only (no new store; the samples already measure them); (c) (b) plus
  a metrics store and a redacted log tail.
- **Recommendation.** (a) for host metrics and logs; (b) can follow without
  a new store.
- **Blocks.** Report charts beyond health states, a log page.
- **Owner decision needed.** Yes.

## OD-47. Changing a person's sign-in address

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity audit).
- **Question.** Studio lets a person change their email address. In
  ExponetDB the address anchors the invitation and sign-in; should a person
  (or an administrator) be able to change it?
- **Options.** (a) as today: erase the identity and invite again;
  (b) an address change by plan, confirmed through the new address, which
  needs a delivery channel ([OD-21](#od-21-delivery-channel-for-invitations-and-security-notifications)).
- **Recommendation.** (a) until OD-21 is decided.
- **Blocks.** An address change on the account page.
- **Owner decision needed.** Yes.

## OD-48. A SQL formatter in the Web App, given its license closure

- **Added.** 2026-10-20 (Wave 8 completion, Studio parity; the SQL editor's
  "Format SQL").
- **Question.** Studio formats SQL with `sql-formatter` (MIT). Every release
  of it since 3.1.0 depends on `argparse` 2.0.1, which is licensed
  Python-2.0; the dependency license scan (`bun run licenses`, ADR-0030 §5)
  allows Python-2.0 only for development tools, so the formatter cannot
  ship in the browser bundle. May the Web App format SQL, and how?
- **Options.** (a) allow `Python-2.0` in the shipped closure for this one
  package (it is used only by the formatter's command line, never in the
  browser); (b) another formatter (`@sqltools/formatter` is MIT without
  dependencies but unmaintained since 2022 and has no PostgreSQL dialect);
  (c) no formatter; (d) a native formatter written for ExponetDB.
- **Recommendation.** (c) for now; (a) is defensible but changes the license
  policy for a convenience.
- **Blocks.** "Format SQL" in the SQL editor.
- **Owner decision needed.** Yes.

## OD-49. The server provider enum and `/api/v1` GA

- **Added.** 2026-10-21 (the owner's long provider list, S11 below).
- **Question.** `provider` of a server is the closed enum `ServerProvider`.
  Before GA a new value is a change with notice
  ([`../06-rest-api/ga-readiness.md` §7](../06-rest-api/ga-readiness.md#7-update-2026-10-21-the-server-provider-list));
  after GA a new value of a closed enum needs `/api/v2`
  ([`../01-architecture/versioning.md` §2](../01-architecture/versioning.md#2-rules-for-additive-changes)).
  The list is expected to grow. Should it become an open enum before GA?
- **Options.** (a) mark it open (`x-extensible-enum`): known values are
  listed, clients accept others, the SDK type becomes `string` and the Web
  App and the CLI show an unknown value by its id; (b) keep it closed and
  add providers only with a new major version; (c) keep it closed and
  replace it later by an additive open member.
- **Recommendation.** (a), decided together with GA.
- **Blocks.** The GA decision of `/api/v1` (G7).
- **Owner decision needed.** Yes.

## OD-50. What the CLI may learn about the scopes an account could hold

- **Added.** 2026-10-21 (CLI scope presets,
  [`../15-cli/README.md` §3](../15-cli/README.md#sign-in-scopes-and-presets)).
- **Question.** `exponetdb whoami` and `doctor` show the granted scopes and
  what each preset lacks, but not what the account could be granted: the
  effective permissions are in `GET /me`, whose action `me.get` is a Web App
  action (scope `api`, client kind `web`). Should the CLI read them?
- **Options.** (a) as today: the consent page shows it, the CLI shows the
  requested scopes that were not granted; (b) a new read action for the
  `cli` client kind under `targets.read` (or no scope) that returns the
  scopes the person could be granted now, as the consent page computes them;
  (c) open `me.get` to the CLI (it returns bindings and the session too,
  more than the question needs).
- **Recommendation.** (b): additive, one read, the same computation as the
  consent page, so the CLI never guesses from role names.
- **Blocks.** "Could get" in `whoami` and `doctor`.
- **Owner decision needed.** Yes.

## OD-51. An execution role with `BYPASSRLS` for adopted schemas

- **Status.** RESOLVED
- **Decision date.** 2026-10-21
- **Decision.** The Wave 9 order's default D-A1, which stands unless the
  owner overrules it: a declared, audited, revocable **execution-role
  exception** per (project, environment, PostgreSQL role) that excuses
  exactly the `BYPASSRLS` attribute of an execution role and nothing else.
  `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`, `LOGIN` and any reach
  into `pg_*` or `exponetdb_*` roles are never excusable. People declare and
  revoke it (`registry.manage` at the environment's tier, never through MCP);
  production needs an approval and a re-authentication. Every plan that uses
  it shows the warn rule `migration.execution-role-exception`; on production
  the plan is at least `high` and an agent's apply still needs a human
  approval (OD-13 unchanged). A plan binds the exception and its revision; a
  revoked or changed exception makes the plan `PLAN_STALE`. Design, threat
  analysis and the recommended target state for adopters (a dedicated
  definer role, so the owner can drop `BYPASSRLS` later):
  [ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md).
- **Source.** the owner's Wave 9 order, §3.2 D-A1 and §7 A4
  ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md)).

History:

- **Question.** May an execution role carry `BYPASSRLS`?
- **Why it matters.** Wave 6 refuses it (`privileged_attribute`). Supabase's
  `postgres` role has `BYPASSRLS`, and Supabase-origin schemas use
  `SECURITY DEFINER` functions owned by it on `FORCE ROW LEVEL SECURITY`
  tables; removing the attribute silently turns their reads into empty
  results and their writes into policy errors (measured on the first real
  adopter on 2026-10-21: 159 `FORCE` tables, 48 definer functions, 41 of
  them on `FORCE` tables). A product that can only manage greenfield
  schemas cannot adopt real ones.
- **Options.** (a) keep refusing it; adopters rewrite their role model
  first; (b) a declared, audited, revocable exception for `BYPASSRLS` only;
  (c) accept any attribute the project declares.
- **Recommendation.** (b).
- **Blocks.** Part A of Wave 9 (A4) and every Supabase-origin adopter.

## OD-52. Adopting a running, hand-made pgBackRest setup

- **Status.** RESOLVED
- **Decision date.** 2026-10-21
- **Decision.** The Wave 9 order's default D-B2, which stands unless the
  owner overrules it: **adopt, then own.** ExponetDB first observes an
  existing pgBackRest stanza (catalog, archive status, verify, drills)
  without changing its configuration or schedules, then takes ownership of
  configuration and scheduling through a planned, verified hand-over that
  stays reversible until confirmed. The rule "repository configuration
  written by the agent, never edited by hand"
  ([`backup-engines.md`](../09-backups-and-restore/backup-engines.md)) applies
  from the hand-over on. Foreign values are shown, never overwritten (OD-20).
  The ADR is written in Wave 9 B0.
- **Source.** the owner's Wave 9 order, §3.2 D-B2
  ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md)).

History:

- **Question.** How does ExponetDB take over a backup chain it did not
  create?
- **Why it matters.** The documents only knew an ExponetDB-owned setup,
  which would force a destructive re-setup of a working, drilled chain.
- **Options.** (a) re-create the setup under ExponetDB; (b) observe only,
  never own; (c) adopt, then own through a planned hand-over.
- **Recommendation.** (c).
- **Blocks.** Wave 9 B0 and B2.

## OD-53. Fingerprint lineage when environments use different owner roles

- **Status.** RESOLVED (found in Wave 9 Part A, A5, 2026-10-21)
- **Decision date.** 2026-10-26
- **Decision.** Option (a): the lineage check stays fail closed; a
  production plan whose fingerprint differs from its evidence environment
  only by owner or grantee names still needs an approval; the imported
  legacy project's warning rule is unchanged; fp1 stays frozen. Option (b)
  may come later, only with an ADR and tests. Consequence: production plans
  of a non-legacy project with per-environment owner roles need an approval
  each.
- **Source.** the owner's Wave 9 Part B order (2026-10-26), §1 item 2.
- **Question.** Should a production plan count as following its evidence
  environment when the only difference between the two schemas is which
  execution role owns the objects?
- **Why it matters.** Per-environment execution roles (ADR-0034 §5) let
  staging and production of one project own their objects with different
  roles on one cluster. fp1 includes object owners (and grantees), so the
  two fingerprints are never equal, and `migration.fingerprint-lineage`
  fails for every production plan of such a project: each needs an
  approval. An imported legacy project only sees the lineage warning
  (`migration.fingerprint-lineage-legacy`), so REOSA's import is not
  blocked by this. fp1 is frozen and does not change in any option.
  **[OBSERVED]** `packages/migrations-engine/test/execution-roles.int.test.ts`
  (the production plan of the definer migration).
- **Options.** (a) keep it fail closed: an approval per production plan,
  as today; (b) a second lineage comparison over the two stored documents
  with the execution roles mapped by alias (fp1 unchanged; needs both
  documents stored and a reviewed mapping rule); (c) treat a mismatch only
  in owners and grantees that are execution roles as a warning.
- **Recommendation.** (a) until a project needs it, then (b); (c) hides a
  real difference behind a role name.
- **Blocks.** Nothing in Part A; production plans of a non-legacy project
  with per-environment owner roles need an approval until it is decided.

## OD-54. How an external cluster gains the node agent

- **Status.** RESOLVED (found in Wave 9 Part A, A8, 2026-10-22)
- **Decision date.** 2026-10-26
- **Decision.** Option (a): a new, controlled operation
  `registry.cluster.adopt_agent`. Human only, with production authority
  (also while the cluster's tier is undeclared or unknown), a fresh
  re-authentication, audited and idempotent. The plan binds the cluster's
  pinned `system_identifier`, its server, the node and the node's latest
  report; the apply checks all of them again under the row lock. The node
  must be enrolled, served and on the cluster's server (or the cluster has
  no server yet and the node's server becomes it), and its report must name
  the pinned `system_identifier` exactly once; anything else fails closed.
  An additive Control Store bundle allows exactly the transition
  `external → agent` by this operation and nothing else; targets keep their
  placement, generation and identity marker, and the cluster keeps its id
  and history. Never an uncontrolled change from `external` to `agent`.
- **Source.** the owner's Wave 9 Part B order (2026-10-26), §1 item 3.
- **Question.** When a cluster that was registered as external (no agent)
  later runs on a host with an enrolled node agent, how does its registry
  record become agent-managed?
- **Why it matters.** **[OBSERVED]** `cluster register` always creates an
  external cluster (`packages/registry/src/kinds.ts`), and a cluster
  record keeps its id, server, management mode and CA bundle for good
  (Control Store guard `EXG07`, Wave 4 registry bundle, frozen). Every node
  capability on an external cluster is `CAPABILITY_UNAVAILABLE`
  (`packages/nodes/src/mapping.ts`), and no operation creates an
  agent-managed cluster record (the agent-managed flow of registry.md §2.1
  ends at the node's cluster report). REOSA staging on `reos-db-01` is to
  be registered as an external cluster after Part A (OD-7a); Part B's node
  capabilities (backups through pgBackRest, role and `pg_hba` desired
  state) need that cluster to be agent-managed.
- **Options.** (a) an additive, one-way operation
  `registry.cluster.adopt_agent` (human only, production authority,
  re-authentication, audited): the cluster's server record has an
  enrolled, served node whose last report carries the cluster's pinned
  `system_identifier` exactly once; the record gains that server and
  `management_mode = agent`; targets keep their placement, generation and
  marker; a new, additive Control Store bundle allows exactly this
  transition (external with no server or the same server → agent) and
  nothing else; (b) register a second cluster record in agent mode and
  move every target to it (registry.md §3: a new generation, the marker
  re-stamped, active plans stale), then retire the external record; (c)
  external stays external in V1: an agent-managed cluster is only one
  registered through the agent flow (which then has to be built).
- **Recommendation.** (a): the cluster is the same physical cluster
  (`system_identifier` pinned), so its identity, targets and history stay;
  (b) costs a generation change and a marker re-stamp of every target for
  no change in what is managed.
- **Blocks.** Node capabilities on a cluster first registered external
  (Part B's B2 on `reos-db-01` if staging is registered external first).
  Nothing in Part A.

## OD-55. Procedural code in a migration session can act as any role the migrator holds

- **Status.** RESOLVED (found in Wave 9 Part A, review round 3, 2026-10-22;
  the engine has worked this way since Wave 6)
- **Decision date.** 2026-10-26
- **Decision.** Options (c) and (d) together. (c) A person approves every
  agent-initiated migration plan whose bundle contains procedural
  constructs (`DO` blocks, routines the bundle creates and calls, dynamic
  SQL where it can be detected) on **every** tier, nonprod included; a
  plan whose procedural content cannot be classified counts as procedural.
  (d) The executor protects the `exponetdb` ledger and identity-marker
  tables by a transactional before/after comparison around each authored
  statement, instead of trusting the session's current role, and refuses
  and rolls back a change it did not make itself. Only a mechanism whose
  behavior under concurrency, locks and TOCTOU is demonstrated is
  acceptable; where the check cannot run, the apply fails closed and the
  gap is a gate blocker. Existing non-procedural behavior is not forbidden.
  Cross-project role reach inside one cluster (option (a)'s concern) stays
  a **recorded residual risk**; nothing claims full containment.
- **Source.** the owner's Wave 9 Part B order (2026-10-26), §1 item 4.
- **Implementation.** **[DECIDED]** (Wave 9 Part B) (c): the plan fact
  `facts.procedural` with `facts.proceduralReasons` and the rule
  `migration.agent-procedural` ([`../04-migrations/planning-and-apply.md` §2](../04-migrations/planning-and-apply.md#2-plan-content),
  [`../02-control-plane/policy-engine.md` §4](../02-control-plane/policy-engine.md#4-rule-catalog-v1));
  (d): the executor's ledger guard and, where it cannot roll back, the deny
  rule `migration.procedural-nontransactional`
  ([`../04-migrations/planning-and-apply.md` §4.3, §4.4](../04-migrations/planning-and-apply.md#43-transactional-migration));
  the residual is threat T38.
- **Question.** How is code a migration runs kept to the project's
  execution role when that code is procedural?
- **Why it matters.** **[OBSERVED]** (PostgreSQL 17, 2026-10-22) An
  authored statement runs in the migrator's session under `SET LOCAL ROLE
  <execution role>`. The parser refuses `SET ROLE`, `RESET ROLE` and
  `set_config('role', …)` at the top level, and the executor compares
  `current_user` before and after each statement. Procedural code is
  opaque to both: a `DO` block, or a routine the migration creates and
  calls, can run `EXECUTE 'SET ROLE exponetdb_ledger_owner'`, `RESET ROLE`
  (the migrator itself) or `SET ROLE` to another project's execution role
  on the same cluster, act, and switch back before it returns. Proven: a
  block went from `app_owner` to the ledger owner, to the migrator, to
  another project's owner, and back, unseen by the guard. As the ledger
  owner it can write the target's ledger and identity marker inside the
  migration's transaction; as another project's owner it can change that
  project's objects in the same database. The ledger is written in the
  same transaction as the change (C-19, `ledger.md`), so the migrator's
  session must be able to become the ledger owner, and execution roles
  are `NOLOGIN` by rule. That is why no session-level containment exists
  in the current design. An agent can plan and apply such a bundle on
  nonprod without a person; production needs a person's approval and the
  evidence of another environment, which Control Store records hold (a
  forged target ledger does not create verification runs, and a ledger
  that diverges from the Control Store mirror is reported as drift and
  blocks schema changes, C-19). Part A's legacy
  replay runs adopted files the same way, on the scratch target only.
  Part A closed the one path from there to superuser code: the reset
  script now reads the scratch marker only once the catalog shows it as
  ExponetDB made it (Part A record §6.4, threat T37).
- **Options.** (a) per-project migrator logins that hold `SET` on one
  project's execution roles only (more credentials per cluster; the ledger
  owner is still reachable, so this addresses cross-project use, not the
  ledger); (b) parse the PL/pgSQL bodies of `DO` blocks and of routines a
  migration creates (the PL/pgSQL parser of `libpg_query` 18, as in A6) and
  refuse role switches and dynamic `EXECUTE` (Supabase-origin histories use
  `EXECUTE format(…)` widely, and SQL-language bodies need their own
  check); (c) a person approves every agent-initiated plan whose
  statements are procedural, on every tier (a new, stricter policy rule);
  (d) the executor compares the `exponetdb` schema's tables (rows and
  relation shapes) before and after each authored statement in the
  transaction, and refuses and rolls back a change it did not make itself
  (closes ledger and marker forging without changing the model).
- **Recommendation.** (d) together with (c): both fail closed, need no new
  role or credential and relax nothing; (a) and (b) stay for a later wave.
  Cross-project use inside one shared database remains a residual risk
  until (a); projects normally have their own database.
- **Blocks.** Nothing in Part A. It should be decided before agents apply
  bundles with procedural statements without a person on targets whose
  ledger is trusted.

## OD-56. An excused value outside the fingerprint that changes after the review

- **Status.** RESOLVED (found in Wave 9 Part A, the independent review of
  follow-up 3, 2026-10-24, finding P3-1)
- **Decision date.** 2026-10-26
- **Decision.** Option (a): for open-domain kinds the checks return a keyed
  digest of the observed value (HMAC-SHA-256 under a server-side
  installation key, never a plain hash), recorded with the excused failure
  at the analysis and compared at every later verification. A changed value
  fails closed even when the aspect is the same; a missing, unreadable or
  rotated key fails closed (a person reviews again). Neither values nor
  digests appear in UI, API, MCP output, audit or logs beyond the stored
  comparison record.
- **Source.** the owner's Wave 9 Part B order (2026-10-26), §1 item 5.
- **Implementation.** **[DECIDED]** (Wave 9 Part B) the installation's
  excused-value key (a worker secret), the digests recorded at the analysis
  and compared at every verification, `value_changed` and
  `value_unverifiable` ([`../04-migrations/legacy-import.md` Step 7](../04-migrations/legacy-import.md#step-7-verify));
  bundle `01M5X840BP8JXGEQGS0PHPTB58_excused-value-digests`.
- **Question.** Must an excused failure of a baseline's verification also
  prove that the failing value is still the one the person accepted?
- **Why it matters.** **[OBSERVED]** (PostgreSQL 17, 2026-10-24) A review
  decision excuses a failing expectation while it fails the same way (the
  same file, statement, kind, object and aspects; [`legacy-import.md` Step
  7](../04-migrations/legacy-import.md#step-7-verify)). Inside the managed
  scope any later change also changes the fingerprint and fails the run.
  Outside it (roles, objects in other schemas) the aspect alone is
  compared: a history's `ALTER ROLE r CONNECTION LIMIT 5` that found 3 at
  the analysis, accepted, still passed with 100 later (`value` in both). The
  checks return no observed value, and a role setting can hold a secret, so
  the value itself is never recorded.
- **Options.** (a) the checks return a keyed digest (HMAC under an
  installation key the worker holds) of the observed value for open-domain
  kinds (role settings, connection limits, comments, function bodies and
  definitions outside the scope), recorded with the failure at the analysis
  and compared at the verification; (b) the drift check covers cluster-global
  state and reports such a change after the baseline; (c) keep the rule, the
  residual documented.
- **Recommendation.** (a): it fails closed and records nothing a reader
  could reverse; (b) is useful on its own and later.
- **Blocks.** Nothing in Part A; the reviewed baseline on `reos-db-01` is
  not affected beyond this residual.

## OD-57. `advisors_run` records a run, but its scope is a read scope

- **Status.** OPEN (found on 2026-10-27 by the Wave 9 Part B review F-4)
- **Question.** How is an advisor run over MCP classified, given that it
  writes Control Store records?
- **Why it matters.** **[OBSERVED]** (Wave 9 Part B) `advisors_run`
  inserts an `observation.advisor_runs` row, opens, counts and resolves
  subject findings and appends an `advisor.run` audit event; since the
  review fix these commit in one transaction. The tool is annotated
  `readOnlyHint` and `advisor.run` has the effect `read`, so an MCP client
  that auto-approves read-only tools can loop it under the read rate
  limit, growing runs and audit and churning finding states. `drift.check`,
  which records the same way, is a `record` action with the `RECORDS`
  annotation. Making `advisor.run` a `record` action turns
  `diagnostics.read` into a write scope; the frozen G3B bundle
  `01M47XQ56MW0JQX3J715X2GDB8_oauth-delegation` stores that scope with
  `write=false`, and `checkScopeCatalog` compares the row with the release.
- **Options.** (a) a new additive oauth bundle makes `diagnostics.read` a
  write scope (a consent screen change for every grant holding it); (b) a
  separate scope for recording advisor runs, `diagnostics.read` stays
  read-only and `advisors_run` needs the new scope; (c) an advisor run
  through MCP evaluates without recording (findings come from the Web App,
  the CLI and the worker only).
- **Recommendation.** (b): the read scope keeps its meaning and an agent's
  grant shows the record right separately.
- **Blocks.** Nothing in Part B; the residual is listed in
  [`../14-roadmap/PRE-WAVE-11-REVIEW.md`](../14-roadmap/PRE-WAVE-11-REVIEW.md) W9-04.

## OD-58. How an operation in `needs_attention` is closed

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-005 / MIG-01;
  built with option (a) by the fixes of 2026-10-28, for the owner to confirm)
- **Question.** An operation in `needs_attention` keeps its exclusivity
  domains and is never claimed, so the documented recovery of a verify.sql
  that errors (a verify revision, then `migration.verify`) and of a killed
  non-transactional bundle (`migration.resume`) waited for ever behind the
  operation it was meant to recover. How does such an operation leave?
- **Why it matters.** **[OBSERVED]** The target was blocked for every schema
  change, production hotfixes included, until someone edited the Control Store
  by hand. The existing suites missed it because their partial failure ends in
  `verification_failed`, which holds no domain.
- **Options.** (a) **built**: the recovery plan names the operation; when it
  starts, the worker closes the named operation (still in `needs_attention`
  and holding one of its domains) as `verification_failed` in the same
  transaction, with `supersededBy` in the event; an apply outcome of `unknown`
  is recorded as `partially_applied`, the verification outcome as `failed`.
  (b) (a), and also build `operation.force_release` (its own kind, the
  `operations.recover` permission, human only, tier of the operation that owns
  the lock, [operations-engine.md §2](../02-control-plane/operations-engine.md#2-operation-kinds))
  for an operation no recovery plan covers (a node or registry operation that
  reaches `needs_attention`). (c) (a), but `verification_failed` admits an
  `unknown` apply outcome, so the closed record keeps the truth that nobody
  knows; every reader of the state (views, CLI, Web) must then handle it.
- **Recommendation.** (a) now, as built; (b) before Wave 11 if a kind other
  than the migration kinds can end in `needs_attention` on a real target;
  (c) only with a review of the readers.
- **Blocks.** Nothing.

## OD-59. Flagging ledger rows as untrusted

- **Status.** OPEN (found on 2026-10-28 while building `ledger.reconcile`,
  TC-007; built with option (a), for the owner to confirm)
- **Question.** The contract of `ledger.reconcile.plan` takes a decision of
  `adopt_target` or `flag_untrusted`
  ([`../04-migrations/ledger.md` §5](../04-migrations/ledger.md#5-mirror-and-reconciliation)
  says the operator "records the decision (adopt target as truth, or flag
  rows as untrusted)"). Only the first is built. What should the second do?
- **Why it matters.** `adopt_target` is the recovery of a restore (E25). A
  decision that the target's rows are untrusted keeps the divergence in
  place by definition (plans stay refused), so on its own it only leaves a
  record; whether that record is worth a plan, an audit event and a finding
  depends on how the owner wants a tampered ledger handled.
- **Options.** (a) built: `flag_untrusted` is refused at planning as
  `VALIDATION_FAILED` (`/decision`, `not_built`), the contract keeps the
  value. (b) build it: the plan records the decision and the note, raises a
  critical finding for the listed ids, changes no mirror row, and the
  divergence keeps refusing schema plans until it is undone or adopted.
  (c) remove the value from the contract (a contract change, generated
  files).
- **Recommendation.** (a) until a real tampered ledger needs it; then (b).
- **Blocks.** Nothing.

## OD-60. How strict a drill is about `amcheck`

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-010 / D-02; built
  with option (a) by the fixes of 2026-10-28, for the owner to confirm)
- **Question.** The node's `amcheck` check reports `not_run` when a database of the
  restored cluster lacks the extension (a template, an application database, any
  backup older than the extension). The Control Plane required every configured
  check to be `passed`, so such a drill ended `verification_failed` although the
  recovery target was reached and the probes passed. Is "the integrity check could
  not run everywhere" a failed drill?
- **Why it matters.** **[OBSERVED]** On a real host no drill could pass unless the
  extension existed in every database of every backup. RB-08 and ADR-0038 say
  "`amcheck` where installed, otherwise recorded `not_run`, never `passed`": the
  node already followed that; the drill verification did not.
- **Options.** (a) **built**: `not_run` of `amcheck` does not fail the drill; the check
  keeps its outcome and detail in the drill record and the restore list, and
  `failed` or `error` still fail it. (b) strict: refuse the drill plan up front when
  the extension is not known to exist in every database (the Control Plane has no
  such fact today; a node observation would have to carry it). (c) the node creates
  the extension in the disposable scratch cluster (the host's contrib package is
  needed; the restored data is not changed beyond the extension).
- **Recommendation.** (a) now; (c) when a real cluster's drills keep reporting
  `not_run` and the host has the package. (b) only if the owner wants a drill to be
  a proof of index integrity.
- **Blocks.** Nothing.

## OD-61. Empty drift baselines, the size of a read result and the findings headline

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-017 and TC-037; nothing
  built, so that the numbers keep meaning what the CLI and the Web App say today)
- **Question.** (1) A rehearsal copy has no ledger and an empty baseline: is a drift check
  against an empty baseline `no_baseline`, or 13,741 `object_added` findings? (2) How large
  may a read-lane result be (131,395 and 229,168 characters were answered)? (3) Do roll-ups
  such as the advisor `drift_open` and `drift_overflow` count in the severity counters, and
  do findings of a target without a baseline belong in the headline "Critical findings"?
- **Why it matters.** **[OBSERVED]** The Overview showed "520 critical of 14,184 open": 518
  expected drift rows of a scratch copy, one roll-up counting them again and one real finding.
  An empty baseline is also a legitimate state (an empty database that someone then fills out
  of band is drift), so reading it as `no_baseline` has a cost.
- **Options.** (a) a baseline without objects, on a target that has objects, is reported once as
  `no_baseline` with what to do (accept the schema as the baseline), roll-ups leave the counters,
  MCP results are capped at 64 KB with a cursor and repeated finding codes grouped; (b) keep the
  recording and the counts, and present them better (group by target and code, show findings of
  targets without a baseline apart); (c) leave as is.
- **Recommendation.** (a), built together with [OD-57](#od-57-advisors_run-records-a-run-but-its-scope-is-a-read-scope)
  (b), because both change what the recording path writes. (b) alone is the smaller step if (a)'s
  trade-off is unwanted.
- **Blocks.** Nothing.

## OD-62. Node certificate expiry: the signal and its thresholds

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-042 / GAP-11; the agent's
  `status` text is built)
- **Question.** The gateway answers an expired node certificate like any refused one (`403
  NODE_CERTIFICATE_REFUSED`), the node row stays `active` and nothing warns before the renewal
  window closes (the last third of the 72 hours). Should the Control Plane raise a signal, and
  from when?
- **Why it matters.** An agent down for the whole window needs RB-13; nothing warns before it
  closes. The live node's certificate ends 2026-10-30T05:57:35Z.
- **Options.** (a) a distinct refusal reason `certificate_expired` and node findings
  `node_certificate_near_expiry` (warning from 12 hours before the end without a renewal, critical
  after) and `node_certificate_expired`; (b) the findings only; (c) documentation and the agent's
  `status` only (built).
- **Recommendation.** (a), with the 12-hour warning proposed by the campaign.
- **Blocks.** Nothing.

## OD-63. Withdrawing a node plan

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-020)
- **Question.** A user with `nodes.plan` cannot withdraw their own node plans
  (`INSUFFICIENT_SCOPE`, needs `nodes.operate`), and withdrawing a `node.revoke` plan asks for a
  fresh passkey (`REAUTH_REQUIRED`) although creating it did not. May the creator withdraw, and
  with what proof?
- **Why it matters.** Ten plans made by the campaign could not be cleaned up and waited for their
  expiry (15 or 30 minutes); withdrawing is the safe direction.
- **Options.** (a) the plan's creator withdraws it with the scope that created it and without a
  fresh passkey; (b) as (a) but a revoke or decommission plan still needs re-authentication to
  withdraw; (c) keep `nodes.operate`.
- **Recommendation.** (a).
- **Blocks.** Nothing.

## OD-64. How long an operation may wait for approval

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-034)
- **Question.** An `access.identity.erase` operation (`op_01M5X74EJ0CD4BYGRZ9DM1KZYA`, created
  2026-10-26T23:01Z) is `awaiting_approval` with a live approval URL although its plan was
  consumed, approved 1 of 1 and expired about 20 hours before the campaign. Is that the designed
  cooling flow, and may an operation wait for ever?
- **Why it matters.** An erasure left dangling is dangerous if it can still be approved later,
  and each waiting operation uses one of the 20 approval places of its actor.
  **The owner is asked to look at that operation and decide whether to cancel it.**
- **Options.** (a) an `awaiting_approval` operation whose plan expired is canceled (`plan_expired`,
  audited), and the approval page and the CLI say when a cooling self-approval can run; (b) a
  separate deadline for approvals (for example 24 hours); (c) no deadline (today).
- **Recommendation.** (b), with (a) as the floor.
- **Blocks.** Nothing.

## OD-65. E16 and E18: detection before the next import

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-023 and TC-024)
- **Question.** The G6 waivers of E16 (`hotfix_without_evidence`) and E18
  (`applied_not_in_source`) expire "before the first import of real REOSA data (Wave 10)"; the
  live staging target already carries 555 `legacy_import` ledger rows from the OD-7a import. Is
  that import "real data", and must detection exist before more imports?
- **Why it matters.** A break-glass grant on `migration.staging-evidence` can be activated once a
  notification channel is set, and nothing marks the production ledger row afterwards; a plan
  whose source omits an applied migration is `allow` with no finding.
- **Options.** (a) the import counts as real data: build both detections first (E16 at the
  ledger mirror write, E18 as a lint or stream finding); (b) it does not: the waivers run to
  Wave 10.
- **Recommendation.** (a) for E16, (b) for E18.
- **Blocks.** Nothing built here.

## OD-66. G10.3 against OD-7b

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-063)
- **Question.** `acceptance-gates.md` G10 row 3 requires "at least five REOSA migrations applied
  staging-first, production with evidence", while OD-7b forbids production applies before Wave 11.
- **Options.** (a) reword: staging-first, with the production evidence checked by a plan only until
  Wave 11; (b) keep the wording as a Wave 11 gate.
- **Recommendation.** (a).
- **Blocks.** Nothing.

## OD-67. Step-up receipts for enrolling a node

- **Status.** OPEN (found on 2026-10-27 by the test campaign, TC-053 / E10)
- **Question.** Applying the `node.enroll` plan and revealing the token each need their own
  step-up receipt (120 seconds): two passkey prompts within about two minutes.
- **Options.** (a) one combined step-up whose receipt covers both actions for that plan only; (b)
  a longer receipt (5 minutes) for those two actions; (c) keep two receipts.
- **Recommendation.** (a).
- **Blocks.** Nothing.

## Owner decisions of the Wave 9 Part B order (2026-10-26)

The owner's Wave 9 Part B implementation order of 2026-10-26 (backup,
restore, performance, security hardening; run in parallel to the UI/UX
session of `davdxpx/ExponetDB#42`) takes these decisions after an explicit
discussion with the owner. **[DECIDED]** 2026-10-26, source: that order §1.
They change no other DECIDED rule.

| # | Topic | Decision | Consequence |
|---|---|---|---|
| P1 | OD-8 | technical default option (a); the legal review is open (EXTERNAL LEGAL REVIEW, `NOT PROVEN`) | Wave 9 records follow the retention rules; productive use with personal data waits for the legal review |
| P2 | OD-53 | option (a), fail closed | an approval per production plan with an owner-name lineage mismatch |
| P3 | OD-54 | option (a), `registry.cluster.adopt_agent` | the only path from `external` to `agent` |
| P4 | OD-55 | options (c) and (d) | procedural agent plans need a person on every tier; ledger and marker protected transactionally; cross-project reach a residual |
| P5 | OD-56 | option (a), HMAC under a server-side key | changed excused values fail closed |
| P6 | OD-4 storage | **not decided**: `OPEN — BLOCKS G9 FULL ACCEPTANCE`; provider-neutral, several repositories per cluster, adopt read-only first | the provisional recommendation is not a decision |
| P7 | Not closed silently | OD-10, OD-12, OD-21, OD-27, OD-29, OD-41 to OD-50 stay as they are | features that depend on them fail closed |

## Decisions of the Wave 9 order (2026-10-21)

The owner's Wave 9 order ([`../14-roadmap/orders/wave-9-order.md`](../14-roadmap/orders/wave-9-order.md))
lists four **[OWNER]** instructions and seven **[DEFAULT]** proposals that
stand unless the owner overrules them. **[DECIDED]** 2026-10-21, source: the
Wave 9 order ([Part A record §2](../14-roadmap/gates/9-part-a.md#2-decisions-of-the-wave-9-order)).
OD-4 (D-B1), OD-7 (owner item 4), OD-51 (D-A1) and OD-52 (D-B2) are above.

| # | Topic | Decision | Kind |
|---|---|---|---|
| O1 | Order of work | Part A (the migration engine for real, imported schemas) first, as its own pull request and record, then Part B (Wave 9 proper); Part A may be merged before Part B is finished | OWNER |
| O2 | Scope pull-forward | Part A brings forward the product capabilities of Wave 10 (import of a real Supabase-origin history, per-environment execution roles, external-cluster onboarding), not its REOSA-side deliverables | OWNER |
| O3 | Quality over speed | the professional design even when it costs more code: contracts first, additive bundles, ADRs where a DECIDED rule changes, real-PostgreSQL tests, independent review rounds, truthful records | OWNER |
| O4 | OD-7 | split into OD-7a (yes) and OD-7b (no applies before Wave 11), see OD-7 | OWNER |
| D-A2 | Execution roles per environment | the alias → role map is resolved per (project, environment), the project map as default; one resolver, no direct reader of the project map ([ADR-0034](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md)) | DEFAULT |
| D-B3 | OD-8 | option (a) recommended; **not decided**: a stop-and-ask point before Part B | DEFAULT (recommendation only) |
| D-B4 | L2 and L3 in Wave 9 | `pg_dump` (L2) and restic to a second provider (L3), engine-independent, are part of Wave 9; restic needs an allowlist addition | DEFAULT |
| D-B5 | The G5 waiver | node capabilities are developed and proven only on disposable hosts; closing the waiver needs `node-pg` and `node-host-scenarios` on a disposable Ubuntu 24.04 VM; without one the items stay `NOT PROVEN` and the session asks the owner | DEFAULT |

## Decisions of the Wave 8 order (2026-10-13)

The owner's Wave 8 order ([`../14-roadmap/orders/wave-8-order.md`](../14-roadmap/orders/wave-8-order.md))
lists thirteen decisions. Those marked **[OWNER]** are the owner's briefing;
those marked **[DEFAULT]** are proposals that stand unless the owner overrules
them. **[DECIDED]** 2026-10-13, source: the Wave 8 order
([G8 record §3](../14-roadmap/gates/8.md#3-owner-decisions-of-the-wave-8-order)).
OD-1 (D4) and OD-11 (D5) are above.

| # | Topic | Decision | Kind |
|---|---|---|---|
| D1 | Start | Wave 8 starts on 2026-10-13; the pending G7 acceptance is not a dependency | OWNER |
| D2 | Supabase UI source | adopted by copy under [ADR-0030](../01-architecture/adr/0030-supabase-ui-source-adoption.md), which amends C-2 and ADR-0017 for the Web App UI | OWNER |
| D3 | Never copied | fonts, logos and wordmarks, the brand green scale, third-party and MCP-client logos, `packages/icons` and `build-icons`, `packages/common`, anything importing `@supabase/*`, `next`, `next-themes`, `openai`, `mermaid`, `sql-to-rest`; Studio's data layer; the clean-room areas | OWNER (rule), DEFAULT (list) |
| D6 | The vanilla Web App | deleted once the new app passes the parity oracle; no dual UI; every external URL keeps working | OWNER (discard), DEFAULT (mechanism) |
| D7 | Wave 9 and OD-21 screens | built as pages with a named "not available yet" state and the right navigation entry; never mock data | DEFAULT |
| D8 | Server work | only the additive endpoints of the order §9, contracts first, with tests; anything else is asked first | DEFAULT |
| D9 | CSP | stays `default-src 'none'; script-src 'self'; style-src 'self'` plus `font-src 'self'` and `worker-src 'self'`; no `unsafe-inline`, nonce or `unsafe-eval`; a relaxation is asked first | DEFAULT |
| D10 | Browser transport | an app-local typed client over a browser-safe SDK subpath `@exponetdb/sdk/operations` (the operations table and types only); the SDK's token transport stays Node-only | DEFAULT |
| D11 | Design-system app | a static Vite site; built, not deployed (OD-39) | DEFAULT |
| D12 | Subagent models | Sonnet or Haiku for about 99% of the work, Opus only for an allowlist of security-bearing and decisive tasks, each logged in the G8 record | OWNER |
| D13 | Deployment and acceptance | no deployment, no `reos-01` change and no gate acceptance by the session; only the owner accepts G8 | DEFAULT |

## Owner decisions in the Wave 8 session (2026-10-13)

Questions raised by the Wave 8 work (order §13) and answered by the owner in
the session. **[DECIDED]** 2026-10-13, source: the owner
([G8 record §3](../14-roadmap/gates/8.md#3-owner-decisions-of-the-wave-8-order)).

| # | Topic | Decision |
|---|---|---|
| S1 | SQL editor ([OD-40](#od-40-the-sql-editor-component-under-the-web-apps-csp)) | CodeMirror 6 built to work and look like Supabase's SQL editor; the CSP stays strict |
| S2 | Raw statement view (`GET /statements/{digest}/raw`) | the owner left the choice to the session, which takes the **live lookup**: the text is read from the target at request time (the statistics view that still holds the statement) through the read-only adapter path and checked against the digest; no new store of statement text in the Control Store; secrets in statements (passwords, connection strings) are still removed; a statement the target no longer holds, or a target that cannot be reached, is a named "not available" error, never stale or invented text; human only, re-authentication within 15 minutes, per statement, audited (order §9) |
| S3 | Role verifiers (`POST /clusters/{id}/role-verifiers`) | build it: write-only storage for SCRAM verifiers in a new additive Control Store bundle (sealed, never readable back through any interface) and a new operation kind that sets a role's verifier through plan, apply and verify; the password never appears in any log, response or audit record (C-20) |
| S4 | Declared tier on clusters ([OD-22](#od-22-authority-needed-to-register-a-database-whose-intended-tier-is-unknown)) | build both: the declared-tier field and a tier-aware `registry.manage` |
| S5 | Look of the Web App | the adopted Supabase UI is given a light ExponetDB character everywhere, so the product does not look like a one-to-one copy: through the token inputs and small, consistent choices of shape, spacing, density and emphasis, within the neutral placeholder brand of OD-11 (no new brand, no new fonts, no logo) |
| S6 | Delivery | Wave 8 is delivered in two pull requests: `davdxpx/ExponetDB#24` (part 1: foundation, design system, the new Web App beside the old one, first server batch) is merged by the owner before G8; a new session continues with a new pull request; G8 is judged on the complete wave and stays the owner's |
| S7 | Audit export (`GET /audit-events/export`) | asked by the part 2 session: `ac1` hashes the whole stored event, while `audit.read` shows a minimized view, so an export that verifies offline needs the full event. Decided: **full events behind a new gate**: each line carries the sequence, the previous hash, the hash and the stored event verbatim; a new human-only action `audit.export` for owners and admins with fresh re-authentication, separate from `audit.read`; the export is itself audited |
| S8 | Scope strings of a tiered `registry.manage` | asked by the part 2 session: the tier of `registry.manage` is enforced through role-binding coverage and grant tiers, but the frozen `oauth-delegation` bundle's `verify.sql` pins the stored OAuth scope catalog exactly, so the literal scopes `registry.manage:prod` and `registry.manage:nonprod` cannot be added without a new verification version. Decided: **keep as is**: one untiered `registry.manage` scope (human sessions only), the tier carried by bindings and grant tiers; recorded as a limit of G8 |
| S9 | Accent color | after seeing screenshots of the Web App the owner chose a **turquoise accent** (the family of `#13A28E`) instead of the placeholder indigo, and no purple: the reserved `production` token moves off purple to a distinct non-error hue. The owner chose the color only because they like it; it is no reference to another product: no name, string, logo or font of any other product is used. This replaces the hue of the OD-11 placeholder and overrides, for this color only, the Wave 8 order's list of colors not to use; fonts, wordmark and the rest of OD-11 stay |
| S10 | Account system | the owner asked for a fully built account area like Supabase's: an account menu in the header with an avatar (initials or an uploaded profile picture), name and email, a direct theme switch, and links to the account pages (profile with display name and profile picture, preferences, security: passkeys, authenticator, recovery codes and sessions, connected applications, the person's own activity), replacing the plain "Account" text button. This includes the server side the profile picture needs (stored same-origin, never a remote image), additive and contracts first |

## Owner decisions after the Wave 8 session

**[DECIDED]** with the date of each row, source: the owner.

| # | Date | Topic | Decision |
|---|---|---|---|
| S11 | 2026-10-21 | Server providers with logos | "Real icons give an application a lot of quality; they are no dependency once copied into the project." The `provider` of a server becomes a long list of well-known providers, each shown with its logo to the left of its name. The selection of the providers and the source of the logos are the implementing session's choice: the list in [`../01-architecture/domain-model.md` §3.2](../01-architecture/domain-model.md#32-physical-layer) (additive; the four Wave 4 values keep their meaning; [OD-49](#od-49-the-server-provider-enum-and-apiv1-ga) for GA) |
