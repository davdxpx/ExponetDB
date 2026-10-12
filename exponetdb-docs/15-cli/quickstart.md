# CLI quickstart: from installation to a verified production migration

| | |
|---|---|
| Status | **[DECIDED]** Wave 6 (owner order §62); every command below ran with the installed artifact against a local lab in `apps/server/test/quickstart.lab.test.ts` (12 of 12 steps, [G6 record §6.1](../14-roadmap/gates/6.md#61-quickstart-acceptance-run)) |
| Needs | Node.js 24, npm, Docker on this machine, a browser with a passkey (or a password and an authenticator app) |
| Related | [`install.md`](./install.md), [`lab.md`](./lab.md), [`README.md`](./README.md) (output and exit codes), [`reference.md`](./reference.md) |

This is the path an owner walks on a disposable installation: the local
lab. On a real installation the same commands apply from step 3 on, with
the real server's origin and real database servers. Values in angle
brackets come from the output of an earlier command; nothing here is an
id to copy.

## 1. Install the CLI

```sh
sha256sum -c exponetdb-cli-0.6.0.tgz.sha256
npm install --global --offline exponetdb-cli-0.6.0.tgz
exponetdb --version
exponetdb --help
```

## 2. Start a lab

Inside an ExponetDB checkout `dev up` builds the image at the current
commit; elsewhere name an image:

```sh
exponetdb dev up --lab demo                      # or: --image <exponetdb image>
exponetdb dev test smoke --lab demo
exponetdb profile add demo --server http://localhost:8480 --use
```

`dev status --lab demo` shows every role, the targets' DNS names on the lab
network and their CA files.

## 3. The first owner and the CLI's sign-in

```sh
exponetdb dev owner --lab demo --email you@example.test --open
```

The browser opens the single-use setup link: register a passkey, set a
password, confirm an authenticator app, store the recovery codes. Then sign
the CLI in; the consent page lists each scope, and administrative and
production scopes are opt-in (tick them, tick production, confirm):

```sh
exponetdb login --scope "targets.read registry.manage nodes.read migrations.read migrations.plan migrations.apply:nonprod migrations.apply:prod schema.read diagnostics.read audit.read"
exponetdb whoami
exponetdb doctor
exponetdb product list
exponetdb target list
exponetdb node list
```

Empty lists are valid answers; a failed read is never an empty list.

## 4. Products, environments, a project

```sh
exponetdb product create shop --name Shop --apply
exponetdb environment create shop staging --name Staging --tier nonprod --apply
exponetdb environment create shop production --name Production --tier prod --evidence-from staging --apply --yes
exponetdb project create shop platform --name Platform --apply
exponetdb project list
```

Each is a plan the server decides, applied and verified (`--apply` waits).
A production change asks for a local confirmation; `--yes` gives it and
never replaces a re-authentication, an approval or evidence.

## 5. A database server (once per cluster)

The lab's targets are external clusters: ExponetDB never holds their
superuser. Prepare the application database and its roles as the lab's
local superuser:

```sh
exponetdb dev sql staging --lab demo <<'SQL'
CREATE ROLE app_migrator NOLOGIN;
CREATE ROLE app_user NOLOGIN;
CREATE DATABASE app;
SQL
exponetdb dev sql staging --lab demo --db app <<'SQL'
GRANT CREATE, USAGE ON SCHEMA public TO app_migrator;
SQL
```

Register the cluster with its TLS endpoint (`cluster-staging.yaml`; the CA
is the file `dev status` names):

```yaml
displayName: lab staging
caBundle: |
  -----BEGIN CERTIFICATE-----
  …
  -----END CERTIFICATE-----
endpoints:
  - kind: private
    host: staging.demo.exdb-lab.test
    port: 5432
    tlsServerName: staging.demo.exdb-lab.test
    label: direct
```

```sh
exponetdb cluster register --file cluster-staging.yaml --apply
exponetdb cluster list
```

Registering a cluster needs a fresh proof of presence: the CLI prints a
step-up link and a code; open the link, compare the code, confirm with
your passkey. The CLI continues by itself.

Create ExponetDB's roles from the server's script, choose each role's
password, and set it on the cluster as a SCRAM verifier (the password never
reaches the database or a log):

```sh
exponetdb cluster bootstrap-sql <cluster> --file bootstrap-staging.sql
exponetdb dev sql staging --lab demo --file bootstrap-staging.sql
exponetdb secrets scram-verifier --stdin --stdout <<< "<observer password>"
# repeat for migrator, reader and verifier, then run as the lab superuser:
#   ALTER ROLE exponetdb_<role> PASSWORD '<verifier>';
#   GRANT app_migrator TO exponetdb_migrator WITH INHERIT FALSE, SET TRUE;
exponetdb dev sql staging --lab demo --file passwords-staging.sql
```

Hand each password to ExponetDB once, write-only, in the Web App: the CLI
opens the form and waits until the worker signed in with it over verified
TLS:

```sh
exponetdb cluster credential submit <cluster> observer
exponetdb cluster confirm <cluster> --apply
exponetdb cluster credential submit <cluster> migrator
exponetdb cluster credential submit <cluster> reader
exponetdb cluster credential submit <cluster> verifier
exponetdb cluster credentials <cluster>
exponetdb cluster database register <cluster> app --apply
exponetdb cluster databases <cluster>
```

Grant the registered database to ExponetDB's roles with the `-- database
app` part of the server's script:

```sh
exponetdb cluster bootstrap-sql <cluster>        # copy the "-- database app" lines
exponetdb dev sql staging --lab demo             # and run them
```

Repeat this section for `production` (its own cluster, host
`production.demo.exdb-lab.test`).

## 6. Targets

```sh
exponetdb project update <project> --execution-role migrator=app_migrator --apply
exponetdb target register --project <project> --environment <staging env> --database <staging database> --apply
exponetdb target register --project <project> --environment <production env> --database <production database> --apply --yes
exponetdb target list
```

The production registration waits for an approval: the CLI prints the
approval page; approve your own plan there (the self-approval is recorded
prominently) with a fresh passkey. The CLI continues by itself.

## 7. A migration, locally

```sh
mkdir shop && cd shop
exponetdb init --project shop/platform
exponetdb migration new add-notes
```

Write `migrations/<id>_add-notes/up.sql` and `verify.sql`:

```sql
CREATE TABLE public.notes (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  body text NOT NULL
);
GRANT SELECT, INSERT ON public.notes TO app_user;
```

```sql
-- check: the notes table is readable
SELECT count(*) >= 0 AS ok FROM public.notes;
```

```sh
exponetdb migration lint
exponetdb migration checksum
exponetdb migration graph
```

The local lint, checksum and graph are the server's, byte for byte.

## 8. Staging, then production

```sh
exponetdb migration plan --target shop/platform/staging
exponetdb plan show <plan>
exponetdb plan apply <plan> --wait
exponetdb migration status --target shop/platform/staging
```

`plan apply --wait` exits 0 only when the migration is applied **and**
verified. Production plans the same stored bundle, bound to the staging
evidence (the staging run that passed, with the same checksum):

```sh
exponetdb migration evidence <migration> --target shop/platform/staging
exponetdb migration plan <migration> --target shop/platform/production --stored
exponetdb plan show <plan>
exponetdb plan apply <plan> --wait --yes
exponetdb operation show <operation>
exponetdb migration status --target shop/platform/production
exponetdb audit list --action migration.apply
```

A production apply from a person's CLI asks for the step-up (and, where
policy wants it, the approval) in the browser, exactly as above.

## 9. When something is wrong

| You see | It means | What to do |
|---|---|---|
| `migration lint` exits 1 with a blocking finding (e.g. dropping a table) | the bundle breaks a rule of the lint profile | change the bundle; nothing reached a server |
| `drift check <target>` lists an object | the database changed outside a migration | write a migration for it, or undo it; plans bound to the old fingerprint are stale |
| exit 4, `awaiting_approval` | a person must approve | `exponetdb approval open <operation>` |
| exit 6 | the wait ended, or the outcome needs reconciliation | `exponetdb operation watch <operation>`; the server keeps working |
| exit 3 | sign-in, scope or re-authentication | `exponetdb whoami`, then `login --scope …` |

## 10. Tidy up

```sh
exponetdb logout
exponetdb dev destroy --lab demo --yes
```
