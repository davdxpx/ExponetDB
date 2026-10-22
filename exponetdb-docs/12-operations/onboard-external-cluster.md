# Onboard an existing self-managed cluster

| Field | Value |
|---|---|
| Status | **[DECIDED]** Wave 9 Part A (order A8), 2026-10-22 |
| For | an operator who brings an existing PostgreSQL 16, 17 or 18 cluster under ExponetDB without the node agent |
| Rules | [credentials-and-roles.md §8](../03-database-model/credentials-and-roles.md#8-external-clusters-no-node-agent), [registry.md §2.2](../02-control-plane/registry.md#22-external-cluster-no-agent) |

The cluster stays the operator's: ExponetDB manages no role desired state,
`pg_hba`, TLS or configuration on it, and it never holds a superuser
credential. What ExponetDB needs is five login roles it can verify over TLS,
the right to `SET ROLE` into the project's execution roles, and the
registry records that tie a database to a project environment.

**[OBSERVED]** `cluster register` always creates an **external** cluster,
and the record keeps its management mode for good; node capabilities
(backups through the agent, role and `pg_hba` desired state) stay
unavailable for it until [OD-54](../00-product/open-decisions.md#od-54-how-an-external-cluster-gains-the-node-agent)
is decided.

## 0. Before you start

- The CLI is signed in with `registry.manage` (`exponetdb login --preset
  admin`) by a person whose grants include `registry.manage` at the
  production tier: an undeclared cluster counts as production, and
  declaring a cluster's tier needs production authority whichever value.
- The cluster serves TLS with a certificate for the name you will register
  (a DNS name, or an IP with a TLS server name), issued by a CA whose bundle
  you have as a PEM file.
- A person with superuser rights on the cluster runs psql there.
- The Control Plane's egress address (`EXPONETDB_EGRESS_ADDRESSES`) can
  reach the PostgreSQL port.

Ids below (`srv_…`, `cls_…`, `prd_…`, `env_…`, `prj_…`, `dbs_…`, `tgt_…`)
are printed by the commands; each `--apply` command waits until the
operation is applied **and verified** and prints:

```text
Succeeded (applied and verified)
Apply         applied
Verification  passed
```

Any other status is not success: the CLI exits nonzero and names the
error code and the next step. Some applies need a fresh confirmation in
the browser (cluster registration and confirmation, target registration,
the tier declaration): the CLI prints the address and a code and waits;
confirm only commands you started. A change the CLI sees as production (on
an undeclared cluster, everything is) also asks for a confirmation on the
terminal, which `--yes` gives; `--yes` never replaces the browser
confirmation.

## 1. The server and the cluster

```sh
exponetdb server create db-01 --provider hetzner_cloud --location fsn1 --apply
exponetdb server list            # note srv_…
```

`cluster.yaml` (checked against the contract; no password in it):

```yaml
displayName: db-01 main
serverId: srv_…
caBundle: |
  -----BEGIN CERTIFICATE-----
  …
  -----END CERTIFICATE-----
endpoints:
  - kind: private
    host: 10.0.0.3
    port: 5432
    tlsServerName: db-01.internal.example
    label: private
```

```sh
exponetdb cluster register --file cluster.yaml --apply
exponetdb cluster list           # note cls_…; state pending, mode external
exponetdb cluster declare-tier cls_… --tier nonprod --apply
```

The declaration asks for a fresh confirmation in the browser. Declare `prod` for a
cluster meant for production; `nonprod` lets each environment's tier decide
who may place a target there.

## 2. The registry side of the project

```sh
exponetdb product create acme --name Acme --apply
exponetdb environment create acme staging --name Staging --tier nonprod --apply
exponetdb project create acme platform --name Platform --exclude-schemas auth,storage --apply
exponetdb project update prj_… --execution-role owner=app_owner --apply
```

`app_owner` is the existing role that owns the application's objects
(`NOLOGIN`, no privileged attribute; [credentials-and-roles.md §3](../03-database-model/credentials-and-roles.md#3-execution-roles)).
If it must keep `BYPASSRLS` (adopted definer functions), declare that for
the environment first, with a reason:

```sh
exponetdb project role-exception declare prj_… --environment staging \
  --role app_owner --reason "Definer functions of the adopted schema read FORCE tables." --apply
```

## 3. The bootstrap SQL

Generate it for the databases you will register (before they are
registered), the project's execution roles and the legacy ledgers you will
import from:

```sh
exponetdb cluster bootstrap-sql cls_… --database app_staging --project prj_… \
  --ledger supabase --file bootstrap.sql
```

```text
Bootstrap SQL written to /…/bootstrap.sql. Review it; the CLI never runs it.
```

Review it, then the database administrator runs it on the cluster:

```sh
psql -X -v ON_ERROR_STOP=1 -f bootstrap.sql "host=10.0.0.3 dbname=postgres user=postgres sslmode=verify-full sslrootcert=ca.pem"
```

Expected: no `ERROR`. A `NOTICE` names an execution role or a database
that does not exist yet (create it and run the script again); a `WARNING`
names an execution role that is not fit (it can log in, holds a privileged
attribute or reaches a protected role) and was **not** granted: fix the
role or the project's map, then run the script again. The script is
idempotent: run it again whenever a database, an execution role or a
legacy ledger is added.

Set the five passwords on the cluster with psql (each is sent as a SCRAM
verifier):

```text
\password exponetdb_observer
\password exponetdb_reader
\password exponetdb_verifier
\password exponetdb_operator
\password exponetdb_migrator
```

`pg_hba.conf` and the firewall: `hostssl` and `scram-sha-256` only, from
the Control Plane's egress address only, for `postgres` and the managed
databases ([credentials-and-roles.md §8.2](../03-database-model/credentials-and-roles.md#82-pg_hba-and-network-for-an-external-cluster)).

## 4. Credentials and confirmation

Enter each password once in the Web App's write-only form (the CLI opens it
and waits until the worker verified the password over TLS):

```sh
exponetdb cluster credential submit cls_… observer
exponetdb cluster confirm cls_… --apply          # pins system_identifier; cluster active
for r in reader verifier operator migrator; do exponetdb cluster credential submit cls_… $r; done
exponetdb cluster credentials cls_…              # all five: active, with a verified time
```

Only the observer is verified before confirmation; the others wait for the
pinned identity. `cluster confirm --system-identifier <digits>` refuses any
other cluster (read it on the host with `pg_controldata`).

## 5. Database and target

```sh
exponetdb cluster database register cls_… app_staging --apply
exponetdb cluster databases cls_…                # note dbs_…
exponetdb target register --project prj_… --environment env_… --database dbs_… --apply
exponetdb target show acme/platform/staging      # state active; health, ledger empty
```

Registration stamps the identity marker and creates the `exponetdb` schema
owned by the ledger owner. The target is now managed: the scratch target
for a legacy import is registered the same way in its own environment
([legacy-import.md §2.5](../04-migrations/legacy-import.md#25-scratch-targets)),
then `migration import scratch-check` and `migration import analyze`
follow. Run `scratch-check` in the project directory: it then sends the
legacy files and also checks what they reference outside the managed scope
(`legacy_references`); `migration import scratch-copy-commands` prints the
schema-only copies the scratch target still needs (`auth`, for example).

## 6. When something is wrong

| Symptom | Meaning | Next step |
|---|---|---|
| `TARGET_CREDENTIAL_INVALID` (`authentication_method`) | the server asked for the password in cleartext or MD5 | `hostssl … scram-sha-256` for ExponetDB's roles; set the password again with `\password` |
| `TARGET_UNAVAILABLE` | no connection (network, firewall, `pg_hba`) | the firewall and `pg_hba` lines for the Control Plane's egress address, the endpoint's host and port |
| `TARGET_TLS_FAILED` | the certificate does not verify | the endpoint's TLS name, the CA bundle given at `cluster register` |
| a credential stays `pending` (`cluster_not_confirmed`) | only the observer is verified before confirmation | `cluster confirm`, then the credential is checked again |
| `REGISTRY_CONFLICT` `database_taken` | the database is already a placement | `target show`; a wrong registration is corrected with `target decommission` and `cluster database retire` |
| a migration plan's lint names `execution_role` (`Execution role alias owner: …`) | the role is missing, unfit or not granted `SET` (the reason follows the colon) | run the bootstrap SQL again and read its `WARNING` and `NOTICE` lines |
| `scratch-check` or a plan names `reaches_protected_role` with the role | the execution role is, through some membership, a member of a role with `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS` (Supabase's `service_role`, for example), of a predefined `pg_*` role or of an ExponetDB role; owning the database (`pg_database_owner`) is not one ([ADR-0034 §3.1](../01-architecture/adr/0034-execution-roles-for-adopted-schemas.md#31-pg_database_owner-is-not-a-protected-reach-2026-10-22); an older release refused it) | as a superuser in the target's database: `SELECT x.rolname FROM pg_roles r, pg_roles x WHERE r.rolname = '<role>' AND x.oid <> r.oid AND pg_has_role(r.oid, x.oid, 'MEMBER')`; revoke the membership that leads there (a declared exception never excuses a reach) |
| `scratch-check` passed, but the analysis ends `incomplete` with `replay_failed:<file>:…:3F000` (or `42883`, `42P01`, `42704`) | a legacy file names a schema, function, table or type outside the managed scope that the scratch target lacks (a policy calling `auth.uid()`); the imported target's current schema no longer depends on it, so `outside_scope` could not see it | run `scratch-check` in the project directory (it sends the legacy files: `legacy_references` names each object), then `migration import scratch-copy-commands --target … --scratch …`, run the printed commands with `IMPORTED_URL` and `SCRATCH_URL` set, reset the scratch target and analyze again |
| `scratch-reset-sql`'s script refuses: `objects outside the managed scope depend on it and would be dropped` | an object outside the scope depends on one inside it; a release before follow-up 2 also counted the casts and access methods of an extension in the scope (`vector` in `public`) | upgrade; otherwise drop or move the named objects (each is listed) and run the script again |
| `migration import analyze` answers `RESPONSE_INVALID`, then `TRANSPORT_FAILED`, and `serve` has restarted | the process was killed for memory while it parsed the history: a role started without `--liftoff-only`, or a limit below the measured need ([deployment.md §2a](./deployment.md#2a-memory)) | the entrypoint with `--liftoff-only` (Coolify: Custom Docker Options), memory and swap limits of at least 512 MiB set together; the startup log names a missing flag (`process.wasm_tier_up_enabled`) |
