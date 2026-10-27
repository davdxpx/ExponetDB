# Adopting an existing backup repository

| | |
|---|---|
| Status | Wave 9 Part B (2026-10-26); **not exercised on a real repository** ([`PRE-WAVE-11-REVIEW.md` W9-02](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-02-manual-test-matrix)) |
| Decisions | [ADR-0036](../01-architecture/adr/0036-backup-repositories-and-providers.md) (repositories, adopt → observe → hand-over), OD-52 (existing setups are adopted, not re-created), [OD-4](../00-product/open-decisions.md) (storage provider: **open**, blocks the full G9 acceptance) |
| Read with | [`architecture.md`](./architecture.md), [`backup-engines.md`](./backup-engines.md), [`../12-operations/backup-runbooks.md`](../12-operations/backup-runbooks.md) |

**[DECIDED]** ExponetDB adopts a repository that already exists and starts
by **reading** it. Adoption changes nothing on the host: no
`archive_command`, `restore_command`, timer, stanza, repository chain, key
or credential. This guide is provider-neutral; it names Cloudflare R2 and
Hetzner Object Storage only where their immutability contracts differ.
**No provider is chosen here** (OD-4).

## 1. Ownership modes

| Mode | What ExponetDB does | What it never does |
|---|---|---|
| `external` | knows the repository exists (a record) | read it |
| `adopted_observed` (after adoption) | `backup.list@1` (catalog), `wal.archive_status@1`, `backup.timers@1` (systemd timers of the host's own schedule), `backup.verify@1` where activated | start a backup, expire, change configuration |
| `adopted_runs` | also **incremental** pgBackRest backups, always with `--no-expire-auto` | a full or differential backup, expiry, configuration |
| `owned` | **refused** in V1 (`CAPABILITY_UNAVAILABLE`): writing a repository configuration needs a capability that does not exist | |

A mode is a **two-party** fact: the Control Store record and the host's
mode file must both allow it.

- The record changes by a plan: `exponetdb backup ownership <repository>
  --to adopted_runs --host-configuration-unchanged` (`backup.repository.ownership`;
  human approval and re-authentication on production, rule
  `backup.change-prod-approval`).
- The host side is the file `/etc/exponetdb-node/repositories/<repositoryId>/mode`,
  owned by `root`, not writable by group or others, containing one word:
  `adopted_observed`, `adopted_runs` or `owned`. A missing file means
  `adopted_observed`. A file with an unsafe owner or mode, or an unknown
  word, refuses every job on that repository (`PRECONDITION_FAILED`).

A compromised Control Plane therefore cannot start runs on a repository
whose host says `adopted_observed`, and a host file alone does not make
ExponetDB start runs either.

## 2. Adoption steps

1. **Prerequisites.** The cluster is registered, confirmed and
   agent-managed; its node is enrolled and reports the backup capabilities
   (`backup.list@1` at least). The pgBackRest configuration on the host is
   readable by the helper (`/etc/pgbackrest/pgbackrest.conf` or
   `/etc/pgbackrest.conf`, owner `root` or `postgres`, not world-writable).
   For a restic repository (L2 logical dumps, L3 copies) the operator
   provisions `/etc/exponetdb-node/repositories/<repositoryId>/` with
   `repository` (the restic repository), `password` (mode 0600) and an
   optional `env` file (allowlisted `KEY=VALUE` lines: storage credentials
   and restic options only).
2. **Plan the adoption** with a request file:
   `exponetdb backup adopt <cluster> --file adopt.json`. The file names the
   layer, engine, provider, the location as recorded (endpoint host,
   region, bucket, prefix; stanza and repo index for pgBackRest), the
   priority, purpose and lock mode as the operator knows it. It carries no
   secret: the request schema has no field for one (`secretSource` is
   always `host_config`). The plan binds the cluster's `system_identifier`.
3. **Apply** (`exponetdb plan apply <plan>`). The record starts as
   `adopted_observed`, state `observing`, revision 1.
4. **Observe.** A catalog refresh runs on request:
   `exponetdb backup refresh <cluster>` (or the Web App's refresh, or
   `POST /clusters/{id}/backups/refresh`). **[PLANNED]** A scheduled refresh
   needs operations the worker starts on its own (a node job always
   belongs to an operation), which this wave does not build; until then a
   mirror older than 30 minutes keeps the protection state at most
   `at_risk` (reason `catalog_stale`), never `protected`. Each refresh reconciles the
   engine's listing into the mirror ([`architecture.md` §3](./architecture.md#3-catalog)):
   - a stanza whose `db-system-id` differs from the registered cluster's
     fails closed: nothing is mirrored, the critical finding
     `backup_identity_mismatch` opens and the repository is `degraded`;
   - an unreadable stanza is `BACKUP_REPOSITORY_UNAVAILABLE`, never an
     empty catalog; what was mirrored stays;
   - a backup the engine no longer lists is marked `missing_in_engine`,
     never removed, and does not count as protection
     (`backup_catalog_divergence`).
5. **Check what the record says**: `exponetdb backup list <cluster>` shows
   the protection state with its reasons. A newly adopted repository is
   at best `unproven` until a backup was verified and a drill passed.
6. **Verify and drill** (when activated, §5): `exponetdb backup verify
   <cluster> <backup>`, then `exponetdb drill plan <cluster> --repository
   <id> --selection latest`. Only a passed drill gives a measured RTO.

## 3. Encryption and the 2026-10-04 advisory

**[OBSERVED]** (pgBackRest release notes, read 2026-10-26) pgBackRest
2.59.3 (2026-10-04) fixes weak encryption subkeys and salts that could be
generated when OpenSSL could not read system random data. `stanza-create`
generates the subkeys of `archive.info` and `backup.info` once, so an
upgrade does **not** replace a weak subkey. The project publishes a check
for existing stanzas (it counts zero bytes per subkey; six or more mean a
weak subkey) and notes that it cannot detect weak subkeys of OpenSSL 1.0
builds before 2.53.

**[DECIDED]** ExponetDB does not read subkeys: they are key material, and
the helper never reads `cipher-pass`. For every encrypted pgBackRest
repository the operator runs the project's published check **on the
host**, following the release notes of 2.59.3 exactly, and records the
result:

| Result | What to do |
|---|---|
| no weak subkey | record the check date and engine version in the incident or operations log; **[PLANNED]** a record field closes `backup_engine_advisory` |
| weak subkey | a new stanza in a new repository (a new repository record, adopted or created), a new full backup into it after the upgrade; the old repository stays adopted and read-only only as long as its backups are needed for the retention, then is retired; never re-key in place |
| check not possible (OpenSSL 1.0 before 2.53) | treat as weak |

Until then the finding `backup_engine_advisory` (warning) stays open for
the repository and its protection is at most `at_risk`. An engine observed
below **2.59.3** is the same finding with advisory `below_floor`. 2.60.0
(2026-10-18) additionally stops a restore on an invalid page checksum; it
is the recommended candidate after its soak.

## 4. Locks and immutability

**[DECIDED]** ExponetDB never shows a lock as protecting anything until it
is **proven** by a recorded experiment; the Control Store refuses the value
`proven` until that operation exists. The record's `lockMode` is what the
operator states (`none`, `s3_object_lock`, `r2_bucket_lock`, `unknown`);
`lockCapability` starts `unknown`.

| Provider contract | What pgBackRest needs | What to check before relying on it |
|---|---|---|
| **R2 bucket lock** (prefix-scoped; blocks delete **and overwrite**; changeable by a token with bucket-configuration rights) | `archive.info`, `backup.info`, their `.copy` files, `backup.history` and each label's `backup.manifest*` are rewritten while backups and expiry run | the lock covers only immutable prefixes (WAL segments, backup set files), never the metadata above; expiry retention ≥ lock duration; the host's token has **no** bucket-configuration right |
| **Hetzner Object Lock** (enabled at bucket creation only; `GOVERNANCE` or `COMPLIANCE`) | the same rewrites succeed as new versions when the bucket is versioned | the bucket was created with Object Lock; default retention in `COMPLIANCE` mode, or `GOVERNANCE` with the bypass permission shown to be absent from the host's credential; whether overwritten metadata versions are kept is the open spike T-S3-5 |

The experiment that proves a lock (a delete and an overwrite of a protected
object refused with the host's credential, a metadata rewrite accepted) is
the owner's pre-Wave-11 test on a real bucket
([`PRE-WAVE-11-REVIEW.md` W9-02](../14-roadmap/PRE-WAVE-11-REVIEW.md#w9-02-manual-test-matrix),
T-S3-1 to T-S3-6). It is not run from this repository.

## 5. Activation

**[DECIDED]** Every run that executes the engine is off by default and
turned on per installation:

| Setting | Values | Default |
|---|---|---|
| `EXPONETDB_BACKUP_EXECUTION` | `disabled`, `nonprod` (runs and verification on nonprod clusters only), `all` | `disabled` |
| `EXPONETDB_RESTORE_EXECUTION` | `disabled`, `scratch` (drills into scratch only), `all` (also recovery into a new cluster) | `disabled` |

A refused plan or run answers `FEATURE_NOT_ACTIVATED` with the setting's
name. Catalog refreshes (`backup.list@1`) are reads and need no activation.

## 6. Retiring a repository record

`exponetdb backup retire-repository <repository> --storage-kept
--no-longer-protected` retires the **record** only: nothing in storage or
on the host is deleted. Its catalog, runs, restores and drills stay as
history. A cluster or server is not retired while one of its repositories
is live, an engine run is not over or a restore is not discarded (the
dependency port of [registry retirement](../02-control-plane/registry.md),
and the Control Store guard `EXB07`).
