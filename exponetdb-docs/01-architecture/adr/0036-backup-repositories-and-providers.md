# ADR-0036: Backup repositories are provider-neutral records with discovered capabilities; existing setups are adopted, observed, then handed over

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 9 Part B order (2026-10-26, §1 item 6, §4; OD-4 engine, OD-52); the storage choice (`OD-4-storage`) stays **open** and blocks the full G9 acceptance |
| Date | 2026-10-26 |
| Amends | [`../../09-backups-and-restore/architecture.md` §2–§3](../../09-backups-and-restore/architecture.md#2-layers) (one repository 1 with object lock, one off-provider copy) and [`backup-engines.md` §3](../../09-backups-and-restore/backup-engines.md#3-engine-contract-inside-exponetdb) ("repository configuration written by the agent from the registry, never edited by hand") for setups ExponetDB did not create |
| Related | [ADR-0024](./0024-node-trust-model.md) (sealed values `ns1`), [ADR-0037](./0037-durable-long-running-node-capabilities.md) (long-running node jobs), [ADR-0038](./0038-restore-plans-drills-and-offline-runbooks.md) (restores and drills); OD-4, OD-20, OD-52; threats T18, T19 |

## Context

The Wave 0 design knew one repository with object lock and one
off-provider copy, both created and configured by ExponetDB. Two facts
overtake it:

1. **[OBSERVED]** (Wave 9 order §6, 2026-10-21) The owner's first real host
   already runs pgBackRest with client-side encryption, scheduled full,
   differential and monthly backups to Cloudflare R2 (EU) and a second
   repository, driven by systemd timers, with passed PITR drills. Re-creating
   that setup under ExponetDB would break a working, drilled chain (OD-52).
2. **[OBSERVED]** (provider documentation, read 2026-10-26) The two storage
   candidates offer **different immutability contracts**:
   - **Cloudflare R2 bucket locks** ([docs](https://developers.cloudflare.com/r2/buckets/bucket-locks/))
     "prevent the deletion and overwriting of objects ... for a specified
     period", are scoped by **prefix**, retain for a duration, until a date or
     indefinitely, take precedence over lifecycle rules, and are changed by
     any API token "with permissions to edit R2 bucket configuration". The
     page documents neither the S3 Object Lock API nor versioning; the
     Wave 9 order recorded on 2026-10-21 that R2 does not implement the S3
     Object Lock API.
   - **Hetzner Object Storage Object Lock** ([docs](https://docs.hetzner.com/storage/object-storage/howto-protect-objects/protect-object-lock-retention))
     must be enabled **when the bucket is created** and cannot be added
     later; retention modes `GOVERNANCE` (shortened with a bypass flag) and
     `COMPLIANCE` ("not possible to end ... in advance"); a default bucket
     retention can be set. The page does not describe versioning, delete
     markers or which permission the governance bypass needs.
   pgBackRest rewrites `archive.info`, `backup.info` (and their `.copy`
   files) and a backup's `backup.manifest` while it runs and expires. A lock
   that blocks overwrite of those keys (R2) stops backups and expiry; a lock
   that only retains old versions (S3 Object Lock on a versioned bucket) lets
   the rewrite succeed and keeps history. A lock label alone therefore says
   nothing about whether backups keep working or whether history survives a
   compromised host.

The owner has **not** chosen the primary provider (OD-4-storage).

## Decision

### 1. A repository is a record with layer, engine, provider, location and discovered capabilities

`backups.repositories` (`bkr_`) holds one row per repository of a cluster.
A cluster may have **several** repositories (pgBackRest supports up to four
`repoN` per stanza; L2 and L3 have their own). Each row states:

| Group | Fields | Notes |
|---|---|---|
| Role | `layer` (`l1_physical`, `l2_logical`, `l3_offprovider`), `engine` (`pgbackrest`, `pg_dump`, `restic`), `priority` (1 = first choice for restores), `purpose` (`primary`, `secondary`, `offsite`) | a restore plan names its repository explicitly; priority only orders the choices offered |
| Provider | `provider` (open enum: `hetzner_object_storage`, `cloudflare_r2`, `s3_compatible`, `posix`), `endpointHost`, `region`, `bucket`, `prefix`, `stanza`, `repoIndex` | location fields are registry text; the endpoint host is checked against the installation's storage host allowlist (no SSRF through a repository record) |
| Ownership | `ownership`: `external` (known, never touched), `adopted_observed` (ExponetDB reads its catalog only), `owned` (ExponetDB writes its configuration and schedules) | §3 |
| Immutability | `lockMode` (`none`, `s3_object_lock`, `r2_bucket_lock`, `unknown`), `lockCapability` (`unknown`, `unsupported`, `unproven`, `proven`), `lockRetentionDays`, `lockProofRef` | §2 |
| Encryption | `cipher` (`aes-256-cbc`, `restic`, `none`), `keyRef` (a secrets-store reference, never the key), `offlineCopyConfirmedAt` | the key itself never enters the Control Store in clear (§4) |
| Credentials | `credentialRef` (writer credential, a secrets-store reference), `adminSeparation` (`separate`, `same`, `unknown`) | a writer that can change lock rules counts as `same` |
| Engine | `engineVersion` (observed), `pinnedVersion` (desired) | §5 |
| State | `desired` (null unless `owned`), `observed` with `observedAt`, `reconciledAt`, `state` (`registered`, `observing`, `active`, `degraded`, `retired`), `revision` | desired, observed and last reconciled are three separate facts |

### 2. Lock capability is discovered and proven, never assumed

- A provider label sets nothing. `lockCapability` starts `unknown`. Capability
  discovery (a node read of the bucket's lock configuration with the
  **writer's** credential, where the provider exposes it) can move it to
  `unsupported` or `unproven`; only a recorded negative experiment moves it
  to `proven`: a delete **and** an overwrite of a protected object attempted
  with the writer-shaped credential, both refused, and a metadata rewrite
  (`backup.info`) accepted. On real buckets that experiment is the owner's
  pre-Wave-11 test (`PRE-WAVE-11-REVIEW.md` W9-02, tests T-S3-1 to T-S3-6);
  this session never runs it.
- The UI, REST and MCP never show a lock as protecting anything unless it is
  `proven`; `unknown` and `unproven` render as "not proven", never green.
- **R2**: lock rules may cover only immutable prefixes (WAL segments under
  `archive/<stanza>/<id>/`, backup sets under `backup/<stanza>/<label>/`
  except the label's `backup.manifest*`), never `archive.info`,
  `backup.info`, their `.copy` files or `backup.history`; expiry retention
  must be at least the lock duration, or expiry fails on locked objects. The
  writer token must not hold bucket-configuration rights
  (`adminSeparation = separate`), or the lock is not a protection against a
  compromised host.
- **Hetzner**: the bucket must be created with Object Lock; default
  retention in `COMPLIANCE` mode is the only mode that a compromised writer
  cannot shorten; `GOVERNANCE` counts as `unproven` until the bypass
  permission is shown to be absent from the writer credential. Whether
  versioning keeps overwritten metadata versions is to be shown by the spike.
- The G9 security item "object lock prevents deletion by the host's
  credentials (tested)" is **not relaxed** by this ADR. If the owner chooses
  R2, its wording becomes "provider lock, overwrite-aware, rule changes
  impossible with the host's credentials" only through a further ADR.

### 3. Adopt, observe, then hand over (OD-52)

```
external ──adopt (plan, human)──▶ adopted_observed ──handover (plan, high, human)──▶ owned
                                        │                              │
                                        └── retire (plan) ◀────────────┘ (rollback until confirmed)
```

- **Adopt** (`backup.repository.adopt`, `standard`, human, re-authentication)
  records a repository that already exists and starts read-only observation:
  `backup.list@1`, `wal.archive_status@1`, `backup.timers@1` (systemd timer
  and service discovery). It writes nothing on the host: no
  `archive_command`, `restore_command`, timer, repository chain or key is
  changed. The plan binds the cluster's `system_identifier`; observation of a
  stanza whose `db-system-id` differs fails closed (`RESTORE_TARGET_MISMATCH`
  family, finding `backup_identity_mismatch`).
- **Observe** records the engine's catalog into the mirror (C-32: the
  engine's catalog is the truth). A mirror entry the engine no longer lists
  is a finding (`backup_catalog_divergence`), never silently trusted or
  silently dropped.
- **Hand-over** (`backup.repository.handover`, `high`, human,
  re-authentication, approval on production) is a separate plan with an
  audited diff of the configuration ExponetDB will write against the
  observed one, revalidated at apply; the old configuration is kept and
  restorable until a person confirms the hand-over
  (`backup.repository.handover_confirm`); until then a rollback plan returns
  the host to the observed state. Old encryption keys are never changed by a
  hand-over (§4).
- **Not built in this wave's code path for execution**: the hand-over's
  node effect needs `postgres.config.apply` of `archive_command` (a denied
  parameter today, `DENIED_PARAMETERS` suffix `_command`) and a repository
  configuration writer. Both stay refused until a dedicated capability with
  fixed templates exists and its host scenario passed; the plan is recorded
  and refused at apply with `CAPABILITY_UNAVAILABLE` (fail closed).

### 4. Keys and credentials

- Repository cipher passphrases and storage credentials live in the secrets
  store (envelope-encrypted, `secrets.md`) and reach a node only sealed to
  its bound encryption key (`ns1`). They are never in command arguments,
  environment listings, logs, exports, results or core dumps: the helper
  writes them to a `0600` file in a private run directory that the engine
  reads (`--config` / `RESTIC_PASSWORD_FILE`), removed when the run ends.
- An **offline copy** of each key is part of C-35; `offlineCopyConfirmedAt`
  records a person's statement that it exists (an attestation, not a proof).
  A repository without it is `at_risk` in the protection state.
- An adopted repository's keys are **not** imported unless a person submits
  them; without them ExponetDB can list and verify metadata where the engine
  allows, and a restore plan fails `engineCanRead = false`.

### 5. Engine version and the 2026-10-04 advisory

- **[OBSERVED]** (pgBackRest releases and news, read 2026-10-26) 2.59.3
  (2026-10-04) fixes "weak encryption subkeys and salts ... if there was an
  error accessing system random data"; 2.60.0 (2026-10-18) makes `restore`
  "error and stop if any restored file contains an invalid page checksum".
  Versions before 2.59.3 are affected only when OpenSSL could not read
  system random data; upgrading does **not** replace a weak subkey, because
  `stanza-create` generates the subkeys in `archive.info` and `backup.info`
  once; a weak WAL subkey exposes all WAL of the repository. The project
  publishes a check (count zero bytes per subkey; six or more means weak)
  that cannot detect weak subkeys of OpenSSL 1.0 builds before 2.53; its
  remediation is a new stanza in a new repository, the old one kept only as
  long as its backups are needed, and a new full backup after the upgrade.
- ExponetDB pins the engine version per installation (never "latest");
  the pin's floor is **2.59.3**; 2.60.0 is the recommended candidate after
  its soak (`node.packages-soak`). A repository observed with an engine below
  the floor, or a stanza created before 2.59.3 whose subkey check has not
  been recorded, raises the finding `backup_engine_advisory` (warning) and
  keeps `lockCapability`/protection at most `at_risk`.
- Upgrading the binary is **not** a remediation of old encrypted material.
  The adoption runbook (`09-backups-and-restore/adoption.md`) carries the
  project's check procedure; a new stanza/repository is a planned operation;
  keys are never changed without a person's plan.

### 6. Several repositories and failure semantics

- A backup run names one repository; pgBackRest's multi-repository archive
  push (`archive-push` to all repositories) is observed per repository: the
  WAL coverage of each repository is its own fact, and the achievable RPO is
  the best **verified, off-host** coverage, never a sum.
- A repository that cannot be read (`BACKUP_REPOSITORY_UNAVAILABLE`) makes
  its facts `unknown`, never "no backups"; the protection state of the
  cluster is computed from the remaining repositories and says which one is
  missing.
- Repositories are isolated: credentials, keys and lock rules per
  repository; an L3 repository on another provider must not share a
  credential or key with L1.

## Consequences

- The model covers the owner's existing R2 setup without touching it, and a
  new Hetzner-based setup, and a split topology, with the same code.
- Nothing is shown as protected until a lock and a restore are proven; the
  first real installation will show `unproven` until the owner's drills ran.
- The hand-over and repository-writing effects stay refused until their
  capability exists and is proven; adoption, observation, catalog, RPO and
  restore planning work without them.

## Alternatives considered

- **One abstract "object lock" flag for every provider**: rejected; it would
  claim protection R2 does not give under the same name, or block backups on
  Hetzner metadata rewrites.
- **Re-create every setup under ExponetDB**: rejected (OD-52).
- **Wait for the storage decision before building**: rejected by the
  owner's order; the architecture does not depend on the choice.

## Implementation in Wave 9 Part B (2026-10-26)

**[DECIDED]** What the code of this wave builds differs from the decision
above in the following points. Each one is stricter than the decision or
leaves a part refused; none relaxes it. The decision text above stays the
target.

| Decision | As built | Why |
|---|---|---|
| §3 three ownership states | four: `external`, `adopted_observed`, **`adopted_runs`**, `owned`. `adopted_runs` lets ExponetDB start **incremental** pgBackRest backups only, always with `--no-expire-auto` (a full or differential backup would shorten the host's retention); the policy rule `backup.repository-runs-allowed` and the node both check it | the owner's existing chain keeps its own schedule and expiry; ExponetDB can prove a run without taking it over |
| §3 hand-over kinds `backup.repository.handover` and `handover_confirm` | one kind, `backup.repository.ownership` (`adopted_observed` ⇄ `adopted_runs`); a change to `owned` is refused with `CAPABILITY_UNAVAILABLE` at planning; no confirm or rollback kind yet **[PLANNED]** | writing a repository configuration needs a capability that does not exist (§3, last item) |
| §3 two parties, the location bound on the host (security review B-1/A-1) | beside the mode file, a root-owned `/etc/exponetdb-node/repositories/<repositoryId>/pgbackrest` with exactly `stanza=<name>` and `repo=<n>`: when the mode allows runs it must exist, and a job naming another stanza or repo index is refused (also for `backup.list` when the file exists); before every run and restore the helper reads the stanza's `db-system-id` and refuses one that is not the job's cluster (B-2); when the host configuration has a `conf.d`, every engine command names it (`--config-include-path`, A-9) | an id alone would let a record point at another repository of the host |
| §3 two parties | the node reads a **host mode file** `/etc/exponetdb-node/repositories/<repositoryId>/mode` (owner `root`, not group- or world-writable) and refuses a run unless it says `adopted_runs` or `owned`; a missing file means `adopted_observed` | a Control Store record alone can never widen what the host allows (a compromised Control Plane cannot start runs on an observed repository) |
| §1 provider fields and the storage host allowlist | the node never takes a location, key or credential from the Control Plane: a pgBackRest repository is the stanza and `repoN` of the host's own configuration, a restic repository is the directory the operator provisioned; the recorded endpoint, bucket and prefix are descriptive (listing, runbook) and only refused against reserved suffixes | the node opens no connection to a recorded endpoint, so a record cannot point it anywhere (no SSRF through a record) |
| §4 sealed key delivery (`keyRef`, `credentialRef`) | not built: `secret_source` is `host_config` only (a CHECK of bundle `backup-catalog`); passphrases and storage keys stay in the host configuration and never pass through the Control Plane | sealed delivery would put repository keys in the Control Store, which this wave does not need |
| §1 `adminSeparation`, `lockProofRef` | not stored; without a proof, `lockCapability` is at most `unproven`, and the bundle refuses `proven` (no operation records the experiment yet) | §2: a lock is never shown as protecting anything until proven |
| §5 subkey check recorded | the check is the owner's, on the host ([`adoption.md` §3](../../09-backups-and-restore/adoption.md#3-encryption-and-the-2026-10-04-advisory)); ExponetDB does not read subkeys and keeps `backup_engine_advisory` open for an encrypted stanza until the check is recorded **[PLANNED]** | the subkeys are key material |

Execution is behind installation settings that default to off:
`EXPONETDB_BACKUP_EXECUTION` (`disabled`, `nonprod`, `all`) and
`EXPONETDB_RESTORE_EXECUTION` (`disabled`, `scratch`, `all`); a refused run
answers `FEATURE_NOT_ACTIVATED` with the setting's name.
