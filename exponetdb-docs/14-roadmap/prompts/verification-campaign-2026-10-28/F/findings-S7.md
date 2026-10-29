### [P2] Forged evidence is accepted: two hand-written ledger rows and any operation id let production take a bundle staging never ran
- **Area:** `packages/migrations-engine/src/evidence.ts`, `kind.ts` (`#evidenceBindings`), policy `migration.staging-evidence`
- **Block:** D
- **Reproduction:** `D/security/scripts/s7-promo-forged.sh <project dir> s7evi s7prd` (needs the s7 pair on the stack). As PostgreSQL superuser of the evidence database insert into `exponetdb.schema_migrations` a row for a bundle never applied there (the bundle's checksum, `operation_id` of the evidence target's genuine apply, `fingerprint_before` copied from the genuine row) and a passed row into `exponetdb.migration_verifications` (a well-formed `vfy_` id, the bundle's verify digest); then `exponetdb migration plan --target lab/platform/s7prd <id>` and `exponetdb plan apply <plan> --yes`. Variant F3 uses the id of a `registry.environment.create` operation as `operation_id`.
- **Expected:** evidence missing or unverified; `staging-production-policy.md` §1.2 condition 3 and §6 ("a ledger row inserted by hand is not evidence").
- **Actual:** evidence present, lineage match, decision `allow` with no failing rule (with the genuine operation id and with the id of a `registry.environment.create` operation; a NULL `fingerprint_before` gives `require`). The apply on the lab production target succeeded (applied, verified, ledger row on production). After the forgery `migration status` on the evidence target shows "Mirror: out of sync" and the next apply plan on that target is refused with `LEDGER_DIVERGENCE`; the evidence read consults neither. The precondition is write access to the evidence database's ledger (a database owner or superuser), which is outside ExponetDB's trust but inside what a hurried operator or a compromised staging admin can do; the owner may weigh it as P1 because it defeats a mandatory production gate end to end. Static side (agent B1, `B/contract.md` §2.5, §2.6, §3 DF-08, DF-09): "known" is `operations.operations` looked up by id only (`evidence.ts:181-190, 209`, any kind, target or project), verification is read from the target and never from `migrations.verification_mirror`, there is no ledger-versus-mirror comparison on the evidence target (`readEvidenceTarget`, `evidence.ts:98-125`), and the same weak attribution heals a hand-written row into the mirror (`divergence.ts:46-48`, `records.ts:188-191`); acceptance (`kind.ts:225-260`) does not repeat condition 3. The same weakness explains why a restored Control Store leaves a never-mirrored production target unblocked (`F/findings-S3.md`).
- **Evidence:** `D/security/promotion-leftovers.md` section c; `D/security/scripts/s7-promo-forged.sh`; `B/contract.md`.
- **Root cause:** attribution by operation id alone; the mirror, which exists to catch tampering, is not consulted.
- **Proposed fix:** an evidence row counts only if the mirror holds the same (target, generation, migration_id, checksum, operation_id), the operation is a `migration.apply` or `resume` of that target whose plan lists the migration, and the verification id is in `verification_mirror`; run `compareLedger` on the evidence target and treat `LEDGER_DIVERGENCE` as no evidence; make `operationsOfTarget` require the plan to include the migration id.
- **Acceptance test:** a stack test that inserts the rows of variants F2 and F3 and expects evidence unverified or missing and `deny` (fails today); a hand-written ledger row with a real operation id of this target is `LEDGER_DIVERGENCE` and unrecorded.

### [P2] The same migration id with different bytes can be applied on two targets: the immutability check is made at plan time only
- **Area:** `packages/migrations-engine/src/store.ts` (`ingestBundles`, `appliedElsewhere`), `kind.ts` (execute), `records.ts` (`writeMirror`)
- **Block:** D
- **Reproduction:** `D/security/scripts/s7-promo-immutability.sh` (concurrent) and `s7-promo-immutability2.sh` (sequential): the same id and directory name, a different `up.sql`; plan variant A for target t1 and variant B for t2 (both plans active); apply both at the same moment, or one after the other.
- **Expected:** invariant I13: the same id with other bytes is refused everywhere; the second apply ends `MIGRATION_CHECKSUM_MISMATCH`.
- **Actual:** both operations succeeded; the target ledgers hold the same migration id with two checksums (`b1c46e86...` and `5841ee62...`; the sequential run `30ac5dde...` and `98057fb0...`). The next plan of either variant on the other target is refused. Promotion is not affected (production compares the checksum with the evidence row). Ingestion of two variants of a new id at the same moment is clean (revisions 1 and 2, no 5xx); after an apply, REST and CLI refuse other bytes (409, exit 1); the dangling stored bundle of the first campaign (TC-008) no longer poisons planning.
- **Evidence:** `D/security/promotion-leftovers.md` sections d and e.
- **Root cause:** `appliedElsewhere` is read in `ingestBundles` (`store.ts:151-252`) at plan time; accept and execute do not repeat it; no unique claim of (project, migration id) to one checksum in the Control Store.
- **Proposed fix:** a table keyed (project_id, migration_id) holding the first applied checksum, written in the same Control Store transaction as the first mirror row and compared at accept and at execute under the project bundle lock; or repeat `appliedElsewhere` in `#registryBindings`.
- **Acceptance test:** a stack test with the two plans: the second apply ends `failed/not_applied` with `MIGRATION_CHECKSUM_MISMATCH` and the second ledger stays empty (fails today).

### [P3] A plan with a malformed evidence verification id is created as allow and can never be applied; the refusal hides why
- **Area:** `packages/migrations-engine/src/kind.ts` (`#content`), `apps/cli/src/output/render.ts`
- **Block:** D
- **Reproduction:** forge evidence as above with a verification id that is not `vfy_` + ULID (the first try of `s7-promo-forged.sh`); plan for production; `plan apply --yes`.
- **Expected:** plan creation refuses or marks the evidence unverified; the apply refusal says what is wrong.
- **Actual:** plan active and `allow`; apply: `PLAN_STALE` with `changedBindings [{binding: "content", actual: "invalid"}]`; the CLI prints only "Create a new plan."; a new plan has the same defect.
- **Evidence:** `D/security/promotion-leftovers.md` (smaller observations).
- **Root cause:** plan content parsed leniently at plan time, strictly at apply (`kind.ts:109-115`).
- **Proposed fix:** validate the evidence binding with the apply-time schema when building the plan; print `changedBindings` in the human renderer.
- **Acceptance test:** a unit test: evidence with a malformed verification id gives a plan error or unverified, not allow.

### [P3] Refused client-metadata fetches leave no audit event and no log line
- **Area:** `packages/auth/src/oauth/registry.ts` (`discoverCimdClient`, `cimdRefresher`), `authorize.ts`
- **Block:** D
- **Reproduction:** `D/security/scripts/s7-cimd-local.sh` (ten `GET /oauth/authorize` with a client_id URL at loopback, the metadata address, a name resolving to loopback, an unresolvable name); count `oauth.client*` audit rows and serve journal lines.
- **Expected:** `address_refused`, `redirect_refused` and `tls_failed` are the signature of an SSRF probe and should be visible to an administrator.
- **Actual:** all ten answer `client_unknown` (good: no oracle); 0 audit rows, 0 log lines; only the rate counter moved. (The fetcher itself passed the review: it resolves once, checks all answers, pins the connection to the first address, refuses redirects and reads at most 5 KiB, so rebinding is impossible; 241 unit cases with 0 failures.)
- **Evidence:** `D/security/network-review.md` section 3.
- **Root cause:** `discoverCimdClient` catches `CLIENT_METADATA_INVALID` and returns undefined; `MetadataFetchError.reason` is dropped.
- **Proposed fix:** a warn log line `oauth.cimd_refused` with reason and host (host only, bounded) and a counter by reason.
- **Acceptance test:** an integration test: an authorize request with `https://localtest.me/c.json` yields one log record with `reason=address_refused`.

### [P3] A revoked node that keeps calling the gateway is not audited and raises no finding
- **Area:** `apps/server/src/interfaces/gateway/agent-listener.ts`, `packages/nodes`
- **Block:** D
- **Reproduction:** `D/security/scripts/s7-gateway-revoked.sh` (revoke the only node, watch 30 s, count audit rows).
- **Expected:** a revoked identity that still presents its certificate is an incident signal in audit or as a finding.
- **Actual:** every request is refused (403 `NODE_CERTIFICATE_REFUSED`, 4 to 11 ms; `NODE_REVOKED` on node calls), logged as `agent.refused` at info with the node id; audit has the revocation and nothing about the later refusals; the agent retries with growing backoff and does not say to re-enroll.
- **Evidence:** `D/security/network-review.md` section 5.
- **Root cause:** refusals are only logged (`agent-listener.ts`, notable codes at info).
- **Proposed fix:** a worker task turning N refusals of a revoked node in a window into one finding `revoked_node_active` (ids only); name the remedy in the 403 body.
- **Acceptance test:** a stack test: revoke, wait one interval, expect the finding and an audit event.

### [P3] The audit event of an environment update names the changed fields but not old and new values
- **Area:** `packages/registry/src/kinds.ts` (`EnvironmentUpdateKind.run`)
- **Block:** D
- **Reproduction:** re-point production's `evidenceFrom` (`D/security/scripts/s7-promo-alias.sh`, A2); read `audit.audit_events` where `action = 'registry.environment.update'`. One person with `registry.manage` and one passkey step-up can do this, with no second approval or cooling period (decision S7-D1).
- **Expected:** the long-lived audit record shows which environment became production's evidence source.
- **Actual:** `changes ["evidenceFrom"]`, revision, environmentId; before and after only in the plan (`analysis.before`).
- **Evidence:** `D/security/promotion-leftovers.md` (a2).
- **Root cause:** the audit call passes `Object.keys(changes)`.
- **Proposed fix:** include before and after of the security-relevant fields (tier, evidenceFrom).
- **Acceptance test:** an integration test on the audit event of an `evidenceFrom` change.

### [P3] CLI exit codes: a dead target or node ends with exit 1
- **Area:** `apps/cli/src/cli/exit.ts`
- **Block:** C
- **Reproduction:** `C/ui/scripts/s7-cli-sweep.sh` cases `net-target-down`, `net-target-drift`, `ref3-backup-run`, `net-backup-refresh-nodedown`.
- **Expected:** a script tells "target down" from "bad arguments" from "policy refused" without parsing JSON (the brief and E1 expect 5 for unreachable).
- **Actual:** `TARGET_UNAVAILABLE`, `TARGET_TLS_FAILED`, `NODE_OFFLINE`, `NODE_REVOKED` and `FEATURE_NOT_ACTIVATED` exit 1; exit 5 is only for the ExponetDB server (`TRANSPORT_FAILED`). Confirms E1's fall-through prediction on 12 cases.
- **Evidence:** `C/ui/cli-sweep.md` section 1.
- **Root cause:** `exit.ts` maps 33 of 129 codes.
- **Proposed fix:** map target and node connectivity codes to a documented exit (for example 7) and `FEATURE_NOT_ACTIVATED` to 4; document in `15-cli`.
- **Acceptance test:** an `apps/cli` test: each code exits with the documented value.

### [P3] A second refusal of a stale plan loses the cause; `operation cancel` by another client names a plan
- **Area:** `packages/operations` (accept), `packages/application` (operation cancel)
- **Block:** C
- **Reproduction:** sweep cases `ref-plan-stale` (text first, then JSON on the same plan) and `ref2-cancel-awaiting`.
- **Expected:** every stale refusal names the changed binding and a remedy; a cancel by someone else says the operation belongs to another client.
- **Actual:** the first call gives `PLAN_STALE` with remedy and `changedBindings`; the plan is then invalidated and the next call says "The plan is invalidated; it cannot be applied. Plan again." without remedy, binding or id. `operation cancel op_...` of another client answers `PLAN_BINDING_ACTOR` "Only the identity and client that created the plan may use it."
- **Evidence:** `C/ui/cli-sweep.md` section 3, items 1 and 2.
- **Root cause:** invalidation overwrites the reason; cancel reuses the plan-binding error.
- **Proposed fix:** store `invalidated_reason` with the changed bindings and return it; a dedicated `OPERATION_NOT_OWNED` for cancel.
- **Acceptance test:** an integration test: two consecutive applies of a stale plan return the same `changedBindings`.

### [P3] A silent 15-minute wait on a queued node operation; slug versus id on `environment update`
- **Area:** `apps/cli` (`backup refresh`, `node inspect`, `--wait`), environment update
- **Block:** C
- **Reproduction:** stop the agent, run `exponetdb backup refresh <cluster>` within a minute (cases `net-backup-refresh-nodedown`, `net-node-stopped`); `exponetdb environment update lab <env id> --evidence-from <id>`.
- **Expected:** an overdue node heartbeat is reported at once; flags that take a slug say so.
- **Actual:** the operation is queued, the CLI prints "queued · apply not_started · verify pending" and waits the default 15 minutes; a minute later the same command returns `NODE_OFFLINE` immediately. `--evidence-from` needs a slug (the error quotes `^[a-z][a-z0-9-]{0,38}$`) while the positional argument takes an id.
- **Evidence:** `C/ui/cli-sweep.md` section 3, items 3 and 4.
- **Root cause:** node-bound plan steps do not check heartbeat age; contract error text.
- **Proposed fix:** refuse planning when the last heartbeat is older than the offline threshold; say "environment slug" in help and error.
- **Acceptance test:** a CLI test: `backup refresh` with a stopped agent returns `NODE_OFFLINE` within 5 s once the threshold passed.

### [P3] Web App: three moderate axe rules; transitions stay under reduced motion
- **Area:** `apps/web` (shell, node page, target overview, access/people)
- **Block:** C
- **Reproduction:** `C/ui/scripts/s7-web-a11y.mjs` (19 pages, 3 widths, 2 colour schemes = 114 loads).
- **Expected:** no axe violation; `prefers-reduced-motion` removes motion.
- **Actual:** `region` on 12 pages (selector `#_r_h_`), `heading-order` on the target overview and node page, `landmark-unique` on Access/People (one binding-form landmark per person with the same label); 32 to 50 elements keep a transition under `reduce`. 0 serious or critical, 0 contrast, 0 overflow at 390 px; the Apply button is reachable by keyboard (Tab 25) with a visible focus.
- **Evidence:** `C/ui/web-a11y.md`.
- **Root cause:** a node outside `main`; heading levels; a non-unique `aria-label`.
- **Proposed fix:** a landmark or `role=status` for that node; fix the heading levels; the person's name in the label; `transition: none` under `reduce`.
- **Acceptance test:** the Web App's axe test over these routes with zero violations.
