# Upgrade rehearsal, rollback and redeploy during an apply (tester S3, Block C)

Old release `d0229550`, release under test `d51da5d0d8832ebc569f23985c7e5176e4d450ad`, on the disposable server `vc-1` (Ubuntu 24.04, UTC,
Node 24.22.1 / Bun 1.4.4 / Go 1.26.10). One stack from `D/infra` (S1's kit, patched, see `NOTES.md`): Control Store PostgreSQL 17.11 in
Docker, `serve`, `worker`, `gateway` as systemd units of the product's own bundle, native PG 16/17/18 target clusters, the node agent 0.7.0
(adopting the PG17 cluster). **The stand-in for the owner's Coolify deploy** is: "image" = the bundle of a commit, "set the tag" = point the
unit at the other bundle, "docker stop --time N" = SIGTERM then SIGKILL after N seconds. What it does not measure: image pull, container
creation, Docker's health-check start period, Traefik. Every downtime below is therefore a **lower bound**; the owner measured 29 s for the
Web App in the 2026-10-21 record, with the same order (migrate, worker, gateway, serve).

Raw logs: `vc-1:/srv/work/s3/logs/` (index: `logs-index.md` there). Scripts: `scripts/` (run order below). Numbers: `timings.tsv`,
`counts-before-after.tsv`.

## 1. Verdict

| Item | Result |
|---|---|
| (a) realistic state on the old release | done: see section 2 (backup catalog entry: NOT RUN) |
| (b) documented backup (`pg_dumpall`) timed | 556 ms, 1.25 MB gzip, 23,684 lines, 6 roles, `gzip -t` ok |
| (c) upgrade as `upgrades.md` / `deployment.md` section 6 / the 2026-10-21 record | works, 3 times (18.3 s, 18.8 s, 19.0 s from `migrate` start to the last role ready); 11 steps the runbook leaves out (section 5) |
| (d) nothing lost | 122 tables counted before, 123 after; 37 append-only tables hashed over their pre-upgrade rows: 37 SAME, 0 DIFFERENT; audit chain verifies (507 events) |
| (e) documented rollback (old image on the migrated store) | **impossible**: all three roles exit 3 `schema_newer` within 0.3 s |
| (e) the only real rollback (restore the dump, start the old image) | works: 7.0 s for this store; loses everything written after the dump; every target the new release touched is then blocked `LEDGER_DIVERGENCE` and needs a reconcile |
| (f) redeploy during a 60 s apply | the apply is lost (`failed` / `not_applied`), nothing half-applied for a transactional bundle; the exit takes 11 s (SIGKILL) or 26 s (exit 1); heartbeat row never marked stopped |
| old plan after the upgrade | **applied normally** (no `PLAN_STALE`, no 500) although the policy version changed |

## 2. State created on the old release (before the dump)

`scripts/10-state.sh` (four attempts were needed, their leftovers are part of the state: three `failed` operations, bundles that were
stored but never applied): project with bundles `accounts`, `invoices` (depends on accounts), `invoices-account-index` applied and verified
on `lab/platform/staging` (PG17) and `lab/platform/dev16` (PG16), plus the stack smoke bundle on three targets; one production change planned
from the stored bundle (evidence from staging) and applied from the CLI, which leaves it `awaiting_approval` (policy `require`, one approval);
one operation in `needs_attention` (a rollback whose verification was cut: `apply=applied verify=error`, lock `target:<id>:schema` held); the
node enrolled and `active`; 10 registered targets, 3 clusters; stored bundles never applied (the `serial` variants and the first
`never-applied` ones); audit rows. After the dump, `25-pending-plan.sh` created a plan that stays unapplied and `30-between.sh` applied one
more bundle on staging and dev16 (15 audit events, 2 operations, 2 ledger rows per target that the Control Store would lose on a restore).

At the moment of the upgrade (`counts-before-after.tsv`): 507 audit events, 65 operations (1 `awaiting_approval`, 1 `needs_attention`, 3
`failed`), 71 plans, 631 operation events, 23 bundle revisions, 25 ledger-mirror rows, 21 secret versions, 42 Control Store bundles.
**Backup catalog entry: NOT RUN** (needs a pgBackRest stanza and an adopted repository on the node; that is S2's chain, `C/backup-restore`).

## 3. The upgrade (`scripts/40-upgrade.sh`, sampler `sampler.mjs`, evaluation `downtime.mjs`)

Order: `control-store migrate` as `exdb_migrate` with the new bundle, then `worker`, `gateway`, `serve` redeployed from the new bundle.

| Step | Run 1 | Run 2 | Run 3 |
|---|---|---|---|
| `control-store migrate` (3 bundles: `operation-supersession`, `ledger-reconcile`, `offline-drill-record`; exit 0, `status current`) | 774 ms | 815 ms | 1,031 ms |
| worker: stop / start to ready | 70 ms / 1,025 ms | 51 ms / 1,160 ms | 64 ms / 1,218 ms |
| gateway: stop / start to ready | **6,315 ms / 5,999 ms** | 6,289 ms / 6,214 ms | 6,301 ms / 6,051 ms |
| serve: stop / start to ready | 54 ms / 1,040 ms | 41 ms / 1,146 ms | 53 ms / 1,163 ms |
| migrate start to last role ready | 18,347 ms | 18,794 ms | 18,972 ms |

Downtime per role, sampled every 50 ms on `/healthz/ready` (non-200 time, `downtime.txt`):

| Role | Run 1 | Run 2 | Run 3 | Shape |
|---|---|---|---|---|
| serve (public listener) | 16.0 s | 17.3 s | 17.5 s | 503 `not_ready` about 1.9 s after the migration commits (readiness is cached), refused for 1.4 to 1.6 s while the unit swaps |
| gateway | 14.6 s | 15.6 s | 15.8 s | 503 from the same moment; its own stop (waits for the agent's long poll, GOAWAY) takes 6.3 s and its start 6 s |
| worker | 2.2 s | 3.1 s | 3.4 s | 503 from the same moment until its redeploy (first in the order) |

So **all three old roles are not ready from the moment `migrate` commits**, not from the moment they are redeployed. The Web App, REST and
MCP are down for about 16 s with the process-level swap; the gateway is the slow role because of its graceful stop. The node agent logged
`session ended ... GOAWAY` and `connection refused` and was `active` again about 6 s later (backoff 1 to 60 s with jitter).

## 4. Verification after the upgrade (`scripts/50-` to `53-verify-*.sh`)

* `control-store status` (login `exdb_serve`): `current`, 45 of 45 (the kit's `cs_status` had to be fixed, see `NOTES.md`).
* `keyring status`: `k1` active, 21 references, no missing or mismatched key. `audit verify`: `ok`, 507 events from seq 1.
* Census (`counts-before-after.tsv`, comparison 1): 123 tables (one new: `migrations.ledger_mirror_history`); changed counts are only
  `control.schema_migrations` +3, `control.migration_verifications` +3 (the three new bundles), `control.process_heartbeats` +3 (new roles),
  `observation.health_samples` +40 (running system). 37 append-only tables hashed over their pre-upgrade rows and columns: 37 SAME. The
  migration wrote **no audit event** (audit count unchanged).
* The plan created by the old release and not applied (`dev18`, 4 bundles): `plan show` active, `plan apply` accepted, **succeeded, applied,
  verified**. A second apply answers `PLAN_ALREADY_USED`. Neither `PLAN_STALE` nor HTTP 500 (findings-E1's P2 needs a changed operation-kind
  version, which these two releases do not have). The policy version **did** change (`migration.apply`: `pv1:3c1c758c...` on `d0229550`,
  `pv1:d907b8ad...` on `d51da5d0`, exact reproduction in `scripts/90-policy-version.sh`), and it did **not** make the plan stale: the apply
  re-evaluates the policy and compares the *decision and requirements* with the stored ones (`accept.ts:198`, `recheckPolicy`), not the version
  hash. The brief's expectation ("policy version changed: plans made before are stale") is therefore **not confirmed**; it matches `upgrades.md`
  section 1 (plans stay valid while their plan schema is supported).
* The `awaiting_approval` production operation and the `needs_attention` operation are unchanged (same state, outcomes, lock). Approving the
  restored one later is covered in `control-store-loss/README.md`.
* A new migration plans, applies and verifies on PG16, PG17 and PG18 with the new CLI.
* Node: `active`, heartbeat 4 s old; a signed `system.health@1` job (`node inspect`) runs to `succeeded` in 2.5 s later on, so job keys, mTLS and
  enrollment survived.

## 5. Rollback

### 5.1 The documented one (`scripts/60-rollback-documented.sh`)

`upgrades.md` section 1: "rolling back the application by one release works without a schema rollback". Stop the new roles, start the old build:

```
{"level":"error","msg":"process.start_refused","role":"worker","reason":"schema_newer"}      (same for gateway and serve, exit status 3)
old build `control-store status`:  {"installationId":"ins_...","status":"newer","expected":42,"applied":45}   exit 1
```

Each role dies 0.3 s after its start; no listener is opened, so the readiness probe is **connection refused** (curl `000`), not a 503, and
the CLI answers `TRANSPORT_FAILED ... could not be reached`. The only output is `reason: schema_newer`: no bundle ids, no remedy, no pointer
to the dump. With Docker's `restart: unless-stopped` this is a restart loop. The same sentence of `upgrades.md` (line 17) contradicts line 14.

### 5.2 The only real rollback (`scripts/65-rollback-restore.sh`, the dump of section 2)

| Step | ms |
|---|---|
| stop roles, remove container and data, start an empty PG17 with a temporary superuser | 1,665 |
| `psql -v ON_ERROR_STOP=1` feeds the dump | 2,065 |
| `control-store status` (old build): `current`, 42 of 42 | 720 |
| `audit verify`: ok, 491 events | 626 |
| `keyring status`: no missing key | 544 |
| start the old roles to serve ready | 1,116 |
| **decision to old release serving** | **7,042** |

7 s is for a 1.25 MB dump; a real store is of the same order (the owner's 2026-10-21 backup was 145 KB). The data lost is everything since the
dump, measured against the store as it was just before the restore (`counts-before-after.tsv`, comparison 2, which includes 35 s of use of the
new release after the upgrade): 48 audit events (540 to 492; the dump ended at seq 491), 6 operations, 6 plans and plan bodies, 66 operation
events, 3 bundle revisions, 9 ledger-mirror rows, 6 baselines, schema documents and snapshots each, and the 3 Control Store bundles of the
new release (by design). The restored store equals the dump (comparison 3: the append-only hashes over the dump-time rows are SAME). Side
effects the runbook does not mention:

* **Every target the new release or the between-state touched is blocked**: staging, dev16 and dev18 answer `LEDGER_DIVERGENCE` (text: only
  "The target ledger and the Control Store mirror disagree; schema changes are blocked.") and `migration status` says `Mirror: out of sync`.
  The old release has no `ledger reconcile` at all, so a rolled-back installation cannot plan on them until it is upgraded again.
* **CLI sign-ins younger than the dump die**: right after the first rollback `whoami` still worked, but after the restore of the same dump
  38 minutes later (`90-policy-version.sh`) every call answered `UNAUTHENTICATED: The sign-in was revoked or expired`: the refresh token had
  been rotated since the dump and the restored store does not know the new one. Everyone signs in again (`cli_login` in the lab).
* The node is `offline` for about 75 s after the old gateway is back (agent backoff, cap 60 s); its enrollment stays valid.
* Operations that ended after the dump are gone while their effects remain on the targets (ledger rows name `operation_id`s that no longer exist).

### 5.3 Reconcile after the re-upgrade (`scripts/70-reconcile.sh`)

Upgrading the restored store again (run 2) and reconciling: per nonprod target 6 steps (status, plan refused, `migration ledger reconcile`,
`plan apply`, status, plan allowed), about 6.2 s each, no approval, no step-up. Three targets, three reconciles, nothing needed but the
scope `migrations.import`. Production costs more, see `control-store-loss/README.md` section 4.

## 6. Redeploy of the worker during a 60 s apply, new release (`scripts/80-sigterm.sh`)

A bundle `SELECT nextval(seq); SELECT pg_sleep(60); CREATE TABLE ...` on a fresh PG16 target; the worker is stopped 10 s into the statement.

| `docker stop --time` | Exit of the worker | Operation | Ledger / table / re-execution |
|---|---|---|---|
| 10 (Docker's default; no deploy file sets another) | SIGKILL at 11.3 s (`process.stopping` is the last log line) | `running` with an expired lease, then `needs_reconciliation` (`lease_expired`, `OUTCOME_UNKNOWN`) 26 s after the restart, reconcile `not_applied`, **`failed`** | 0 ledger rows, no table, the first statement ran once |
| 60 | exit 1 after 26.2 s, `process.stopped{ok:false}` (the 25 s bound inside the process) | same, `failed` 19 s after the restart | the same |

In both cases the target session kept running the `pg_sleep` after the worker was gone (1 session visible right after the exit, 0 after the
statement ended), so the engine's lock is released and the operation declared `failed` while the old transaction is still alive on the target;
it rolled back by itself. The worker's heartbeat row keeps `stopped_at IS NULL` (it counts as live for 45 s). A **non-transactional**
bundle was not run (NOT RUN: the plan was denied by lint, see section 9).

## 6a. An apply that is running when `migrate` commits (`scripts/91-inflight-across-migrate.sh`)

Old release, a 45 s statement running (op1), a second plan queued behind it on the same target (op2); `control-store migrate` of the new build
commits 8 s into op1; the old roles are **not** redeployed for 70 s. The three old roles answer 503 `not_ready` (`schema_newer`), logging
nothing. Yet the old worker finishes op1 (`succeeded / applied / passed`, 35 s after the migration) and then claims op2 and ends it `failed`
(`PLAN_STALE` on `ledger` and `fingerprint`: op1 changed the target, the expected outcome). After the redeploy: op1 `succeeded`, ledger holds the bundle,
the first statement ran once. So an operation in flight when the schema moves **does survive** (`upgrades.md` section 1), but only because the
old worker is **not** stopped by the schema change: a not-ready worker keeps claiming and executing operations with the old kind registry
against the newer schema until it is redeployed (C1's static finding, now observed; harmless in this pair of releases, no guarantee for the
next).

## 7. What the runbook leaves out

1. A **backup before `control-store migrate`** (the 2026-10-21 record took one by hand; `upgrades.md` and `deployment.md` section 6 do not
   mention it), where it goes (off host), and how to prove it restorable first (`gzip -t` and a restore into a scratch resource).
2. That the **schema change is one way**: `upgrades.md` line 14 promises a one-release rollback; the record's "Rollback anchor" says the opposite.
3. That **all three roles go not ready the moment `migrate` commits** and stay so until each is redeployed (16 s for serve even here); no
   expected downtime, no "do it when nothing runs".
4. **No drain**: nothing says to wait until no operation is `running` or `verifying`, nor to give the worker a stop grace period (the default
   10 s kills an apply, section 6).
5. **No preflight** of what will migrate (`control-store status` of the new build against the live store prints expected and applied; the
   migrate output is the only list of bundles). No dry run exists.
6. **How to read the migration result**: the 2026-10-21 record could not read the exit status or log of the one-shot container.
7. A **post-upgrade checklist**: `control-store status` `current`, `keyring status`, `audit verify`, node `active`, one plan and apply.
8. **Agent compatibility**: the agent is not part of the server upgrade (0.7.0 kept working), but no step names how to check its protocol range.
9. A **rollback decision**: when to roll forward, when to restore, who may decide, and the list of consequences in section 5.2.
10. The **restore procedure for a rollback is RB-10** whose step 6 is empty for managed targets; it needs the reconcile of section 5.3.
11. **Sign-in after a restore** and the **75 s node gap**.

## 8. What an operator at 3 a.m. is missing

A one-page upgrade card: "dump, check the dump, migrate, deploy in this order, expect 16 s of no Web App, check these five commands; if it
goes wrong **do not start the old image, restore the dump** (7 s here), then sign in again, then reconcile every target the new release
touched (6 steps each, production 10 with a step-up and an approval)". Plus an error that names the cause: `schema_newer` should print the
expected and applied counts and the words "restore the pre-upgrade dump"; the `LEDGER_DIVERGENCE` text should name the command
`exponetdb migration ledger reconcile --target <path> --note ...`.

## 9. NOT RUN

Backup catalog entry (needs S2's pgBackRest chain); non-transactional bundle in the redeploy test (the plan was denied by lint: a `-- non-transactional` bundle holding CREATE TABLE and `pg_sleep`; a `CREATE INDEX CONCURRENTLY` variant was not built); Docker image build and `docker stop` with
real containers (systemd stand-in used, see top); a node agent update (no self-update in V1).

## 10. Run order

`10-state.sh` (needs `stack-up.sh` of the kit with `COMMIT=d0229550`, and `build-new.sh` for the new build) -> `counts.sh pre` -> `20-dump.sh` ->
`25-pending-plan.sh` -> `30-between.sh` -> `counts.sh preup` -> `40-upgrade.sh up1` -> verification (`counts.sh postup preup`, `diff-census.sh`,
the commands of section 4) -> `60-rollback-documented.sh` -> `65-rollback-restore.sh` -> `40-upgrade.sh up2` -> `70-reconcile.sh <targets>` ->
`80-sigterm.sh` -> `90-policy-version.sh`. All scripts source `lib.sh` and expect the kit copy in `/srv/work/s3-infra` (`kit-s3.patch`).
