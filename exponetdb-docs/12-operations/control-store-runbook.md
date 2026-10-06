# Control Store and first rollout runbook

| | |
|---|---|
| Status | Wave 2, accepted with G2 on 2026-10-05; first rollout executed 2026-10-06, off-host work open ([record](./deployments/2026-10-06-reos-01.md)) |
| Applies to | Wave 2 onward |
| Read before | [`deployment.md`](./deployment.md), [`bootstrap.md` §2](./bootstrap.md#2-control-store), [`../02-control-plane/control-database.md`](../02-control-plane/control-database.md), [`incident-model.md`](./incident-model.md) |

Step by step, for the owner: the first rollout of ExponetDB on `reos-01`
(Coolify), the Control Store backups, and **RB-10 Control Store down**. Every
step names what to check before it, because `reos-01` also runs REOSA.

## 1. Preconditions and safety checks

**[DECIDED]** Before changing anything on `reos-01`:

1. List the server's resources and domains in Coolify. **[OBSERVED]**
   (2026-10-05, read-only through the Coolify API): Coolify 4.3.23, one
   server `REOS-01`, projects `REOSA` (19 applications) and `REOS-Websites`;
   no ExponetDB resource and no resource on `db.exponet.cloud` exist yet.
2. Create a **separate** Coolify project `ExponetDB`. Never add ExponetDB
   resources to the `REOSA` project; never edit, restart or redeploy a REOSA
   resource; never touch `reos-db-01` or any Supabase project.
3. Ports: nothing of ExponetDB is published on the host. `serve` is reached
   only through Traefik on `db.exponet.cloud` (container port 8080); the
   internal listener (9464) stays on loopback; the Control Store has **no**
   public port (never 5432 on the host); the gateway opens no listener before
   Wave 5.
4. Secrets: generate new ones (§2); never reuse or overwrite an existing
   Coolify secret.
5. DNS: `db.exponet.cloud` must point to `reos-01` before Traefik requests
   the certificate.

## 2. First rollout

1. **Control Store resource.** Coolify PostgreSQL 17 resource
   `exponetdb-control` in the `ExponetDB` project, not published, its own
   Docker network shared only with the ExponetDB resources and the proxy.
   The initial maintenance database is `postgres`; bootstrap creates
   `exponetdb_control` itself with UTF-8 and `C` collation/ctype.
2. **Bootstrap SQL.** On a trusted machine with the image:
   `docker run --rm --user "$(id -u)" -v "$PWD:/work" <image> control-store bootstrap-sql --credentials-file /work/credentials --output /work/bootstrap.sql`.
   The script contains SCRAM verifiers only; the five passwords are in
   `credentials` (mode 0600). Run the script once as the resource's
   superuser (`psql -v ON_ERROR_STOP=1 -d postgres -f bootstrap.sql`) from
   Coolify's terminal of the database resource. The superuser password stays
   in Coolify and is never given to ExponetDB.
3. **Keyring.** `<image> keyring generate --key-id k<year>a --output /work/keyring.json`;
   store it as a Coolify secret of `serve`, `worker` and `gateway`
   (`EXPONETDB_KEYRING`) and put an offline copy with the owner.
4. **Migrate.** A one-shot resource (or a Coolify scheduled task run once)
   with `deploy/env/migrate.env.example` and the command
   `control-store migrate`. It prints the `installationId`; exit code 0
   means every bundle is applied **and** verified. In the first rollout this
   is a separate Compose service with `restart: "no"`; it remains exited 0.
5. **Roles**, in this order, each as its own Coolify application from the
   same image and tag, with the environment of `deploy/env/<role>.env.example`
   and the command `serve`, `worker`, `gateway`: worker first (it creates
   the audit partitions and exports checkpoints), then serve (Traefik:
   `db.exponet.cloud` → 8080), then gateway. Each must become `healthy`
   (the image's health check asks the internal readiness probe).
   On Coolify 4.3.23 Docker Image applications, use the explicit role
   entrypoint in [deployment.md §2](./deployment.md#2-configuration), not
   `start_command`. Verify the proxy is connected to `exponetdb` and set
   trusted proxies from that measured network before any production login.
6. **Checks after rollout.** `https://db.exponet.cloud/healthz/ready` answers
   `{"status":"ready","requestId":…}` (status and request id only; the version
   is on the internal listener); `control-store status` reports `current`;
   `keyring status` reports no missing or mismatched key; `audit verify`
   passes; the first checkpoint object exists in the bucket.

Rollback: stop the three roles (the Control Store keeps its data); a schema
migration is never rolled back automatically (control-database.md §5).

## 3. Control Store backups

**[DECIDED]** The Control Store's backup is an owner action outside
ExponetDB (C-35: backups must be restorable without ExponetDB):

- enable Coolify's scheduled backups of the dedicated `exponetdb-control`
  PostgreSQL resource: a daily complete `pg_dumpall` (Coolify's `dump_all`
  option), with an off-host destination (S3-compatible, object lock where
  available). **[OBSERVED]** (Coolify 4.3.23, first rollout) Its database-only
  backup uses `pg_dump --no-acl --no-owner`; an actual restore loses the
  runtime grants. The complete export preserves roles and privileges and
  was restored successfully with the runtime login ([evidence](./deployments/2026-10-06-reos-01.md#backups-and-restore));
- keep the role passwords (credentials file) and the keyring offline,
  separately from the dump. The complete export contains sensitive SCRAM
  role verifiers, not plaintext passwords, and no keyring material; it is
  useless for decrypting stored secrets without the keyring;
- test a restore into a scratch resource at least once per quarter with the
  steps of §4 and record it.

**[OBSERVED]** (2026-10-06) A daily complete local backup, a protected
workstation copy and a successful restore are proven. Automated off-host
delivery remains open; the local schedule does not substitute for it.

## 4. RB-10 Control Store down

Trigger: Control Plane `down` (every role not ready with
`control_store` or `role_credential` failing), or data loss in
`exponetdb-control`.

1. **Triage.** Is the resource running (Coolify)? Disk full? Network between
   the roles and the resource? Login refused (password rotated without
   updating the roles)? Do not restore before ruling these out.
2. **Restore** (data loss only). Create a new isolated PostgreSQL 17 resource
   with maintenance database `postgres` and a temporary superuser named
   `restore_admin`, different from every role in the saved export. Do not
   run bootstrap SQL first: the complete `pg_dumpall` export creates the
   roles, databases and privileges. Decompress it and feed it to
   `psql -U restore_admin -d postgres -v ON_ERROR_STOP=1` inside the scratch
   resource. Check `control-store status` using a restored runtime login
   (`exdb_serve`, not `exdb_migrate`): the installation ID must match and
   every expected bundle must be applied and verified with matching content.
   Apply any later release's additive bundles through `control-store migrate`
   with `exdb_migrate`, never replay old `up.sql` to repair missing grants.
3. **Integrity.** `control-store status` must be `current`; `audit verify`
   must pass; compare the latest exported checkpoint (bucket) with the
   restored chain: `audit verify --from-checkpoint <seq>` for the newest
   exported checkpoint whose sequence exists in the restore. Events after the
   dump are lost; record the gap (the exported checkpoints show its size) as
   part of the incident. A checkpoint that does not match the restored chain
   is a security incident (RB-12).
4. **Keys.** `keyring status` with the offline keyring: no missing key. If
   the keyring is lost too, follow RB-14.
5. **Roles.** Update `EXPONETDB_CONTROL_STORE_URL` of each resource if the
   passwords changed; start worker, serve, gateway; all must become ready.
6. **Reconcile** ledger mirrors against target ledgers (from Wave 4, F30); in
   Wave 2 there are no managed targets.
