# Control Store loss (C-35), tester S3, Block C

"Backups must be restorable without ExponetDB." The Control Store (container **and** data directory) of a stack running `d51da5d0` (the
upgraded stack of `C/upgrade`, with state) was destroyed and recovered with RB-10 as written (`control-store-runbook.md` section 4, with section
3 for the backup), using only what the documents say lives elsewhere. Server `vc-1`, same stand-in for Coolify as in `C/upgrade/README.md`
(three systemd units, Control Store in Docker). Scripts: `scripts/` (here) and `../upgrade/scripts/{lib.sh,counts.sh,diff-census.sh}`. Raw logs:
`vc-1:/srv/work/s3/logs/loss-*.out` (index: `../upgrade/logs-index.md`). On the server the scripts here ran as `/srv/work/s3-infra/s3/00-loss-prepare.sh`, `10-loss-destroy.sh`, `20-loss-rb10.sh`, `30-loss-prod-cycle.sh`, `31-loss-prod-reconcile.sh`, `40-loss-keyring.sh`.

## 1. Verdict

| Case | Result |
|---|---|
| (i) restore from the `pg_dumpall` dump | **works**: the runbook's 6 steps are 11 operator actions, about 8 s of command time, the roles recover without a restart; 6 gaps in the text (section 3) |
| (ii) keyring lost | **not recoverable, and RB-14 cannot be executed**: roles refuse to start or stay not ready for ever; no command resets the secrets |
| (iii) restore into a store older than the targets' ledgers | works only through `migration ledger reconcile`: 6 steps per nonprod target, 10 on production (1 step-up, 1 approval); a never-mirrored production target is not blocked and its unknown row is adopted without a decision |
| (iv) node and gateway after the restore | node `active` again within 2 to 75 s, enrollment, job keys and a signed job survive; roles recover on their own |

## 2. State, backup, loss

State as in `C/upgrade` plus a fresh production change `awaiting_approval` (`00-prepare.sh`). **Backup** = what section 3 prescribes, a complete
`pg_dumpall` (627 ms, 1.30 MB gzip) copied to `/srv/work/s3/offline` together with the items the documents put outside the store (section 3
below). After the dump: the production change was approved and applied (production ledger row), a bundle was applied on staging and dev18
(24 audit events, 2 operations). Then `docker rm -f` of the container and `rm -rf` of its data directory, the three roles left running
(`10-destroy-observe.sh`).

What the operator sees with the store gone (logs `loss-10-destroy.out`):

| After | serve (public) | worker, gateway | CLI | node agent |
|---|---|---|---|---|
| 3 s | `ready` 200 (cached) | 503 `not_ready` | `CONTROL_PLANE_DEGRADED: ExponetDB itself is not ready. This says nothing about the target databases.` | `hello: gateway 500 INTERNAL ... Quote the request id` |
| 23 s, 63 s | 503 `not_ready` | 503 | same | same, backoff |

The processes stay up (no crash loop), log `heartbeat.failed code=control_store_unavailable` every 15 s and `dataread.tick_failed ECONNREFUSED` five
times a second. The readiness bodies say only `not_ready`; the cause is in the journal. The unit stays `active`, so a process supervisor sees
nothing wrong.

## 3. Case (i): RB-10 as written (`20-rb10-restore.sh`, steps in `../upgrade/timings.tsv` as `rb10-as-written`)

| # | Step | Runbook | ms |
|---|---|---|---|
| 1 | triage: resource running? disk? network? login? | named | 59 |
| 2 | new isolated PostgreSQL 17, maintenance db `postgres`, temporary superuser | named | 1,730 |
| 3 | decompress and feed the export: `psql -U restore_admin -d postgres -v ON_ERROR_STOP=1` | named, vague on where psql runs | 2,285 |
| 4 | `control-store status` with `exdb_serve`: `current`, 45 of 45, installation id matches | named | 690 |
| 5 | later bundles through `control-store migrate` | named (not needed, same release) | - |
| 6 | `audit verify`: ok, 571 events | named | 761 |
| 7 | `audit verify --from-checkpoint <newest exported>`: ok from seq 2 | named, vague | 754 |
| 8 | record the gap | **not possible as written** (see below) | - |
| 9 | `keyring status` with the offline keyring: `k1`, 21 references, none missing | named | 608 |
| 10 | update `EXPONETDB_CONTROL_STORE_URL` if passwords changed | named | - |
| 11 | start worker, serve, gateway | named; they were still running and healed alone: serve ready in 2 s, all three in under 10 s | 1,092 |

Sum of command time about 8 s (a second round, `30-prod-cycle.sh destroy`: restore 7.2 s, serve ready after 4 s). The human time is the
point: reading, choosing a name, finding the credentials file.

**What the documents say lives elsewhere, and what I needed** (nothing else of the dead system was used):

| Item | Where the documents put it | Used in |
|---|---|---|
| the dump | off-host destination, S3 with object lock (`control-store-runbook.md` section 3) | step 3 |
| the role passwords (credentials file) | offline, apart from the dump (section 3) | step 4, 6, 9 (login `exdb_serve`, `exdb_worker`) |
| the keyring | Coolify secret of the three roles **and** an offline copy (section 3, `secrets.md` section 5) | step 9, step 11 |
| the audit checkpoint bucket | S3 / the export directory (RB-10 step 3) | step 7 |
| `EXPONETDB_INSTALLATION_ID` and the other role variables | Coolify environment of each role (not named in RB-10) | step 11 |
| the agent root CA private key | offline after bootstrap (`secrets.md` section 1) | **not needed** for a restore |

### Steps the runbook leaves out (each a finding input)

1. **The second recovery by the same text fails.** The temporary superuser `restore_admin` becomes the superuser of the resource that then serves
   as the Control Store; the next `pg_dumpall` contains `CREATE ROLE restore_admin`. The first attempt of this test did exactly that and died at
   step 3 with `ERROR: role "restore_admin" already exists` (`ON_ERROR_STOP`), leaving a half-restored server that has to be thrown away. The
   text says "different from every role in the saved export" but not that the name persists and that the superuser must be dropped or
   renamed afterwards.
2. **Step 3 "the exported checkpoints show its size" is not true here.** Checkpoints are written hourly (`worker-tasks.ts`
   `audit.checkpoint`, 3600 s); the only exported checkpoint on this installation was seq 1, so the newest exported checkpoint says nothing about
   the 24 lost events. The gap can be sized only to the hour, or from the targets' ledgers.
3. **A new Coolify resource has a new host name**: every role's `EXPONETDB_CONTROL_STORE_URL` changes and the three roles are redeployed (the
   lab kept host and port, so the 10 s recovery is optimistic by the length of three Coolify deploys).
4. **Sign-ins**: refresh tokens, grants and web sessions issued or rotated after the dump are unknown to the restored store. The CLI still
   worked after the two restores of a recent dump, and answered `UNAUTHENTICATED: The sign-in was revoked or expired` after the restore of the
   38-minute-old dump (its refresh token had been rotated since); every such user must sign in again. The Web App session was not tested (NOT
   RUN). The runbook does not mention it.
5. **Operations in `awaiting_approval` for work that already happened.** The restored store shows the production change as awaiting approval
   although the production ledger has the row. Approving it (`human approve`) ended `failed ... PLAN_STALE` and re-ran nothing, which is safe, but
   the approver is shown a pending production change that is already live, with no hint.
6. **Step 6 (reconcile)** is empty for managed targets: sections 4 and 5.

## 4. Case (iii): restore into a store older than the ledgers

After the restore every target that was applied after the dump disagrees with the mirror.

| Target | Before reconcile | Reconcile | Steps | Approvals / step-up |
|---|---|---|---|---|
| staging, dev18 (nonprod) | `migration plan` -> `LEDGER_DIVERGENCE` (text: one sentence, no command); `migration status`: `Mirror: out of sync` | `migration ledger reconcile --target T --note "..."` then `plan apply --yes` (`70-reconcile.sh`) | 6 each, 6.2 s | none (class `high`, `approvals required 0`) |
| production (mirror existed in the dump) | the same | the same two commands | **10**, 8.4 s with the scripted person (`31-prod-reconcile-stepup.sh`) | requirements `approval x1` + `reauth within 300 s`: the CLI prints `Open .../step-up#id=... Code: ...` and waits, the person re-authenticates and confirms, the operation is `awaiting_approval`, the person approves, `succeeded` |
| production (never mirrored before the dump) | **not blocked**: the plan is evaluated normally; `migration status` says `out of sync` | `ledger reconcile` answers `VALIDATION_FAILED nothing_to_reconcile` ("The ledger of the target agrees with the mirror") | - | - |

Scope: `migrations.import` (the `admin` preset only; the lab CLI holds every scope, so the minimum was not exercised). The three nonprod
reconciles of the upgrade test and the two of this test all succeeded; mirror rows the target no longer has move to
`migrations.ledger_mirror_history` (empty here: the targets only had more rows, never fewer).

The never-mirrored production target is the trap: nothing blocks, nothing says that a ledger row (`loss-prod-change`, applied by an
operation that no longer exists) is unknown to the store, and the **next production apply mirrored both rows** (mirror 2, live ledger 2,
after one apply): the unknown row was adopted without a reconcile decision, an approval or an audit event naming it.

## 5. Case (ii): the keyring is lost (`40-keyring-lost.sh`)

What the keyring protects (`secrets.secret_versions`, 21 versions in 4 blob tables): 12 PostgreSQL credentials (9 worker, 3 observer), the
owner's TOTP seed, the node PKI (gateway issuing CA key), the job-signing private key, two node bind keys, the PostgreSQL CA key, the audit
pseudonym key, the rate-limit key.

What the documents promise: `secrets.md` section 5 and RB-14: "Losing the keyring means losing all encrypted secrets: the documented recovery is to
rotate every PostgreSQL credential through the node agent (which does not need the old password) and re-enroll nothing".

| Attempt | Roles | Operator sees |
|---|---|---|
| (a) no `EXPONETDB_KEYRING` | all three exit 2 at once | unit `failed`, no listener |
| (b) a new keyring that reuses the id `k1` | all three exit 3: `process.start_refused reason=keyring_mismatch` | unit `failed` |
| (c) a new keyring with id `k2` | run, `not_ready` for ever; `keyring status`: `missing ["k1"]`, `k2` has 0 references | `target list` and `node list` still answer (no secret needed); **a migration plan answers 500 `INTERNAL`**; the owner's password login answers 500 `INTERNAL` (`secret_key_unavailable` in the journal) |

So the recovery of RB-14 cannot start: `cluster credential rotate` is a plan (500), a node job needs the job-signing key (lost), the gateway
cannot sign or renew node certificates (by the purpose list its issuing CA key is among the lost secrets; not exercised; the lab certificate lives 3 days), and the owner's password login answers 500 (the TOTP seed is among the lost secrets; recovery codes were not tried: NOT RUN). There is no command that marks the lost secrets as gone and lets the owner submit new
ones, and the store cannot be edited (append-only triggers). **Keyring loss means a new installation** unless an offline copy exists; the
documents do not say that, and they say the opposite. The offline copy is therefore the whole recovery: its custodian, a second copy and a
yearly test belong in the runbook.

With the original keyring back the stack was ready again within 12 s and the node `active`.

## 6. Case (iv): node and gateway after the restore

Observed in three restores (`C/upgrade` rollback, RB-10 round 1, round 2):

* The enrollment, the node row, its certificate (valid until the lab expiry) and the trusted job keys come with the dump; nothing is
  re-enrolled. During the outage the agent logs `session ended ... gateway 500 INTERNAL` and backs off 1 to 60 s with jitter; after a long outage
  it needs up to **75 s** to say hello again once the gateway is back (the old gateway of the rollback test: `offline` for 74 s).
* A signed job after the restore (`node inspect <node> --capability system.health@1`) succeeded in 2.5 s: job key, mTLS and capability version
  all valid.
* Jobs created after the dump and in flight at the loss are gone from the store (not examined further: NOT RUN).
* The gateway and the other roles need no restart if the Control Store keeps its address; the pools reconnect (transient
  `control_store_permission_denied 42501` warnings appear while the dump is still being applied).

## 7. NOT RUN

Loss of the Coolify project together with the Control Store (all role variables gone); restore from the Coolify-made dump (the lab uses `pg_dumpall`
by hand, as the runbook describes it); restore of a dump from a newer schema into an older image; node certificate expiry during the outage;
the owner's recovery codes after a keyring loss; PITR of the Control Store (the runbook has none: a daily dump is the whole RPO, here 24 events
in 15 minutes).
