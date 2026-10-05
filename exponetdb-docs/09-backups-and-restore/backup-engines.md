# Backup engines

| | |
|---|---|
| Status | Baseline (Wave 0); engine choice is [OPEN: OD-4](../00-product/open-decisions.md#od-4-backup-engine) |
| Applies to | Wave 9 |
| Read before | [`architecture.md`](./architecture.md) |

Facts verified on 2026-10-04 from primary sources (release pages, project news,
PostgreSQL documentation). Re-verify before Wave 9 starts; the backup tool
landscape moved twice in 2026.

## 1. Options

| Engine | Version (2026-10-04) | Maintenance | Encryption | PITR | Verification | Object storage |
|---|---|---|---|---|---|---|
| **pgBackRest** | 2.59.3 (released 2026-10-04 with a security advisory) | declared unmaintained 2026-04-27; continuation confirmed 2026-05-18 with a sponsor group; repository active | client-side AES-256-CBC | yes | `verify` command; page checksums during backup; block incremental | S3-compatible (endpoint, path/host style) |
| **WAL-G** | 3.0.9 | active | libsodium or OpenPGP (client-side) | yes | `backup-push --verify` (page checksums), `wal-verify`; no full restore-verify command found | S3-compatible |
| **Barman** | 3.20.1 (2026-09-29, security fix) | active (EDB) | GPG | yes | `check-backup`; uses PostgreSQL 17 native incremental since 3.11 | `barman-cloud-*` |
| **Native `pg_basebackup --incremental` + `pg_combinebackup`** (PG 17+) | ships with PostgreSQL | core | none (encrypt the transport/storage separately) | yes with a WAL archive | `pg_verifybackup` | none (files; upload separately) |
| **`pg_dump` / `pg_restore`** | ships with PostgreSQL | core | none (pipe into an encrypting uploader) | no | `pg_restore --list`; a real test needs a restore | none |
| **restic** (as uploader for dumps) | 0.19.1 | active | always (AES-256-CTR + Poly1305) | n/a (file level) | `restic check --read-data` | native S3 |

Notes that matter for the decision:

- **pgBackRest advisory (2026-10-04):** before 2.59.3, if the OS random source
  failed, encryption subkeys and salts could be weak; the subkeys persist for
  the life of a stanza. Any new installation starts on 2.59.3 or later. Any
  existing encrypted stanza must run the published check and may need a new
  stanza.
- **pgBackRest maintenance history:** a three-week "unmaintained" period in
  2026 shows the bus-factor risk of a single project. The design keeps the
  engine behind a capability interface and keeps L2 logical dumps independent of
  it, so a forced engine change does not leave clusters unprotected.
- **Native incremental backups** require `summarize_wal = on`; PostgreSQL does
  not track backup chains ("You must keep track of the relationships between
  your full and incremental backups on your own"). Using them directly means
  ExponetDB would own chain management, retention and upload. That is engine
  work ExponetDB should not take on in V1.
- **Storage:** Hetzner Object Storage supports S3 Object Lock and versioning.
  Cloudflare R2 does not support the S3 Object Lock API; it has its own bucket
  lock rules. No primary-source compatibility statement exists from pgBackRest
  or WAL-G for either provider; third-party deployments of pgBackRest on Hetzner
  exist. **The first Wave 9 task is an end-to-end backup, verify and restore
  test against the chosen storage.**

## 2. Recommendation

**[OPEN: OD-4]** Recommendation for the owner:

| Layer | Recommended | Why |
|---|---|---|
| L1 physical + WAL | **pgBackRest ≥ 2.59.3**, repository on **Hetzner Object Storage** (same region as `reos-db-01`, separate project/credentials) with **object lock** | most complete verification story (`verify`), mature PITR and retention, block incremental, broad operator knowledge; Hetzner supports object lock |
| L2 logical | **`pg_dump -Fc` per database + `pg_dumpall --globals-only`**, encrypted and uploaded with **restic** | engine-independent; restic is already part of the owner's tooling (REOSA host backups) |
| L3 off-provider | restic repository on a **different provider** (Cloudflare R2 with bucket lock, or a Hetzner Storage Box in another location) | survives loss of the primary provider/account |

Alternative if the owner prefers to avoid pgBackRest's recent history: **WAL-G**
for L1 with libsodium encryption. Costs: weaker built-in verification (more
weight on drills), less familiar retention semantics.

Not recommended for V1: Barman (adds a separate backup server role and Python
runtime to the estate), native incremental (chain management would become
ExponetDB code).

## 3. Engine contract inside ExponetDB

**[DECIDED]** Whatever the choice, the engine sits behind the node capabilities
`backup.list/run/verify/expire` and `restore.prepare/execute/verify/discard`
([`../07-node-agent/capabilities.md`](../07-node-agent/capabilities.md)):

- The helper runs the engine with **fixed argv templates** per capability;
  repository configuration is written by the agent from the registry (signed
  `config.update`), never edited by hand on the host.
- Engine output is parsed into the catalog shape in
  [`architecture.md` §3](./architecture.md#3-catalog); unparseable output fails
  the job.
- The engine version is part of the backup record; restore plans check that the
  installed engine can read the backup.
- Changing the engine for a cluster is a planned migration: new repository, a
  full backup with the new engine, a passed drill, then the old repository is
  kept read-only until its retention ends.

## 4. PostgreSQL settings the engine needs

Set through `postgres.config.apply` (planned, audited), not by hand:

| Setting | Value (L1 with pgBackRest) | Notes |
|---|---|---|
| `archive_mode` | `on` | restart required (planned restart) |
| `archive_command` | engine's `archive-push` | |
| `archive_timeout` | `60s` (production) | bounds RPO on quiet databases; costs one WAL segment file per minute in the archive |
| `wal_level` | `replica` | |
| `max_wal_senders` | ≥ 2 | headroom for a later replica |
| `data_checksums` | on (initdb; PostgreSQL 18 defaults to on for new clusters) | lets the engine detect page corruption |
