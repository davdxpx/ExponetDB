# Owner test package (Wave 9 Part A)

| | |
|---|---|
| Status | **[DECIDED]** Wave 9 order §12 (Part A); what the owner runs on a local lab before running the same steps against REOSA staging in a REOSA session |
| Commit | the head of `ccr-3132aada-w0z6wp` named in the [Part A record](../14-roadmap/gates/9-part-a.md) and the pull request |
| Related | [`../12-operations/onboard-external-cluster.md`](../12-operations/onboard-external-cluster.md) (the same onboarding, explained), [`legacy-import.md`](./legacy-import.md), [`../15-cli/owner-test-package.md`](../15-cli/owner-test-package.md) (Wave 6: the CLI and the lab), [`../05-mcp/owner-test-package.md`](../05-mcp/owner-test-package.md) (Wave 7: an MCP client against the lab) |

A synthetic, Supabase-shaped external cluster onboarded end to end on the
local lab: server, cluster, idempotent bootstrap SQL, tier, databases,
staging and scratch targets, a per-environment execution role with a
declared `BYPASSRLS` exception, the scratch preflight, the legacy import of
the real-shape history (analyze, report, resolve, baseline), then a first
bundle applied by an MCP agent on staging. Nothing here touches
`db.exponet.cloud`, `reos-db-01`, a real node or REOSA's data.

**What ran before this package.** The CLI commands of steps 3 to 7 ran as a
process (the installed CLI included) against serve and the real worker in
`apps/server/test/cli-import.int.test.ts`; the bootstrap SQL ran with psql on
PostgreSQL 16, 17 and 18 in `packages/registry/test/bootstrap.int.test.ts`;
bindings, the exception and a replay under it ran in
`packages/migrations-engine/test/execution-roles.int.test.ts` and
`legacy-supabase.int.test.ts`; an agent's nonprod apply over MCP ran in
`apps/server/test/mcp-plans.int.test.ts`. The expected outputs below come
from those runs. **NOT PROVEN:** this walk on the lab as one sequence with
a browser passkey; the owner's run is that evidence.

## 1. What you need, and the CLI

As in [`../15-cli/owner-test-package.md` §1 and §2](../15-cli/owner-test-package.md#1-what-you-need):
Node 24, Bun, Docker, a browser with a passkey, the CLI packed and installed
from the commit (`exponetdb --version` names it).

## 2. The lab and the fixture

```sh
exponetdb dev up --lab parta
exponetdb profile add parta --server http://localhost:8480 --use
exponetdb dev owner --lab parta --email you@example.test --open   # passkey, password, authenticator app
exponetdb login --preset admin                                     # tick production: an undeclared cluster counts as production
bun run --cwd packages/testkit fixture:supabase ~/parta --project acme/platform
cd ~/parta
```

`~/parta` now holds `legacy/` (eight files `0100_accounts.sql` to
`0107_settings.sql`), `roles.sql`, `imported.sql`, `hints.yaml`, an empty
`migrations/` and `exponetdb.project.yaml` (`layout: legacy+bundles`,
`baseline: baseline:acme-supabase-2026`).

The lab's staging cluster plays the existing self-managed cluster. Create
the project's roles and the two databases, and load the history into the
imported one:

```sh
exponetdb dev sql staging --lab parta --file roles.sql      # acme_owner; acme_staging_owner NOLOGIN BYPASSRLS
exponetdb dev sql staging --lab parta <<'SQL'
CREATE DATABASE acme_staging;
CREATE DATABASE acme_scratch;
SQL
exponetdb dev sql staging --lab parta --db acme_staging --file imported.sql
exponetdb dev sql staging --lab parta --db acme_scratch <<'SQL'
GRANT USAGE, CREATE ON SCHEMA public TO acme_staging_owner;
SQL
```

## 3. The registry side

```sh
exponetdb product create acme --name Acme --apply
exponetdb environment create acme staging --name Staging --tier nonprod --apply
exponetdb environment create acme scratch --name Scratch --tier nonprod --apply
exponetdb project create acme platform --name Platform --include-schemas public --apply
exponetdb project update prj_… --execution-role owner=acme_owner --apply
exponetdb project execution-roles set prj_… --environment staging --role owner=acme_staging_owner --apply
exponetdb project execution-roles set prj_… --environment scratch --role owner=acme_staging_owner --apply
exponetdb project role-exception declare prj_… --environment staging --role acme_staging_owner \
  --reason "Definer functions of the adopted schema read FORCE tables." --apply
exponetdb project role-exception declare prj_… --environment scratch --role acme_staging_owner \
  --reason "The replay of the adopted history runs as the staging owner." --apply
exponetdb project execution-roles prj_…
```

Expected: each `--apply` ends `Succeeded (applied and verified)`; the
bindings and the declarations ask for a browser confirmation first. The last
command shows the map `owner → acme_owner`, both environments bound to
`acme_staging_owner`, and two active exceptions that excuse `bypassrls`
only. The scratch environment is bound to the same owner as staging on
purpose: the replay must create the objects as the role that owns them on
the imported target, or every object would differ in its owner.

## 4. The external cluster

`dev status --lab parta` names the staging host
(`staging.parta.exdb-lab.test`) and the CA file. `cluster.yaml`:

```yaml
displayName: acme staging cluster
caBundle: |
  -----BEGIN CERTIFICATE-----
  …
  -----END CERTIFICATE-----
endpoints:
  - kind: private
    host: staging.parta.exdb-lab.test
    port: 5432
    tlsServerName: staging.parta.exdb-lab.test
    label: direct
```

```sh
exponetdb server create acme-db --provider other --apply
exponetdb cluster register --file cluster.yaml --apply          # browser confirmation (step-up)
exponetdb cluster list                                           # cls_…, pending, external
exponetdb cluster declare-tier cls_… --tier nonprod --apply      # production authority; browser confirmation
exponetdb cluster bootstrap-sql cls_… --database acme_staging,acme_scratch --project prj_… \
  --ledger supabase,applied_migrations --file bootstrap.sql --json
exponetdb dev sql staging --lab parta --file bootstrap.sql
exponetdb dev sql staging --lab parta --file bootstrap.sql       # again: the same state
```

Expected from `bootstrap-sql --json`: `pendingDatabases` is
`["acme_scratch", "acme_staging"]`; `executionRoles` lists `acme_owner`
(`bypassRlsExcused: false`) and `acme_staging_owner`
(`bypassRlsExcused: true`); `legacyLedgers` is
`["applied_migrations", "supabase"]`; the script holds no password. Both
psql runs end without `ERROR` and without a `WARNING` (no execution role is
unfit). Counter-check: a run before step 3's bindings would not mention
`acme_staging_owner`, and without the exception it would print
`WARNING: execution role acme_staging_owner is not granted`.

Passwords and confirmation (each password entered once in the Web App; the
CLI waits until the worker verified it over TLS):

```sh
exponetdb cluster credential submit cls_… observer
exponetdb cluster confirm cls_… --apply
for r in reader verifier operator migrator; do exponetdb cluster credential submit cls_… $r; done
exponetdb cluster database register cls_… acme_staging --apply
exponetdb cluster database register cls_… acme_scratch --apply
exponetdb cluster databases cls_…                                # dbs_… for each
exponetdb target register --project prj_… --environment <staging env_…> --database <acme_staging dbs_…> --apply
exponetdb target register --project prj_… --environment <scratch env_…> --database <acme_scratch dbs_…> --apply
exponetdb target list                                            # acme/platform/staging and /scratch, active
```

## 5. The scratch preflight

```sh
exponetdb migration import scratch-check --target acme/platform/staging --scratch acme/platform/scratch
```

Expected: `ready`, six checks `pass`: `scratch_usable`, `identity`, `empty`,
`extensions`, `outside_scope`, `execution_role` (the last one passes as a
declared exception). Counter-check: `exponetdb dev sql staging --lab parta
--db acme_scratch` with `CREATE TABLE public.x (id int);` makes `empty` fail
with `objects:1`; drop the table again.

## 6. The legacy import

```sh
exponetdb migration import analyze --target acme/platform/staging --scratch acme/platform/scratch \
  --hints hints.yaml --json > analysis.json
exponetdb plan apply <planId from analysis.json> --wait
exponetdb migration import report <reportId: .data.change.content.reportId> --target acme/platform/staging
```

Expected: the analysis plan is `migration.import.replay`, decision `allow`,
its `baselineId` `baseline:acme-supabase-2026` (from the project file); the
replay ends `Succeeded`; the report is `open` with:

| Item | State | Strength | Evidence (first) |
|---|---|---|---|
| `0100_accounts` | `recorded_present` | medium | `supabase:statements_normalized` |
| `0101_account_members` | `recorded_present` | medium | `supabase:statements_normalized` |
| `0102_member_count` | `recorded_present` | low | `supabase:statements_bodies` (that entry's stripper removed a comment inside a function body too) |
| `0103_notes`, `0104_notes_index` | `recorded_present` | medium | one ledger entry for both files (the alias in `hints.yaml`) |
| `0105_events` | `ambiguous` | weak | only the name matches: the file was edited after it was applied |
| `0106_tags` | `unrecorded_present` | weak | an entry without statements |
| `0107_settings` | `unrecorded_present` | weak | `applied_migrations:name_hint` (a name alone never records a file) |
| `drift:…public.applied_migrations…` | `ambiguous` | | `only_in_target`: the name-only runner's own table |
| `drift:column:public.acme_events.kind` | `ambiguous` | | `differs`, `attribute:type`: the edit of `0105_events` |

The schema's own ACL may also show as `drift:schema:public` (`attribute:acl`).
Decide each open item with a note, for example:

```sh
exponetdb migration import resolve <report> <item> --target acme/platform/staging \
  --state unrecorded_present --note "the runner's table; it stays outside the bundles"
exponetdb migration import baseline <report> --target acme/platform/staging --apply
```

Expected: `baseline --apply` exits 0 only once the baseline is applied and
verified; `exponetdb migration status --target acme/platform/staging` lists
the `legacy:` rows and `baseline:acme-supabase-2026`. Counter-checks: a
baseline while an item is still open is refused and names the open items;
after the replay the preflight fails `empty` (the replayed objects), and a
second analysis's replay ends with the report `incomplete`
(`scratch_not_empty`). Reset the scratch target in place with `exponetdb
migration import scratch-reset-sql --scratch acme/platform/scratch`, run as
the lab superuser in `acme_scratch` (`exponetdb dev sql staging --lab parta
--db acme_scratch --file reset.sql`, which stops at the first error); the
preflight is ready again. Counter-check: before the reset, a view outside
the scope on a replayed table (`CREATE SCHEMA probe; CREATE VIEW probe.v AS
SELECT * FROM public.acme_notes;` in `acme_scratch`) makes the reset refuse
and name `rule _RETURN on view probe.v`; `DROP SCHEMA probe CASCADE;`, then
reset. On REOSA staging the history also adds a trigger on `auth.users`
that calls a `public` function: drop what the replay created outside the
scope before resetting (legacy-import.md §2.5).

## 7. A first bundle from an MCP agent on staging

Connect an MCP client to the lab as in
[`../05-mcp/owner-test-package.md` §B and §C](../05-mcp/owner-test-package.md#b-the-lab-client-and-the-reference-clients)
and consent to `targets.read`, `migrations.read`, `migrations.plan` and
`migrations.apply:nonprod` for nonprod only. Ask the agent to add a bundle
that depends on `baseline:acme-supabase-2026` (for example a table
`public.acme_notes_archive` with an explicit grant and a `verify.sql`), plan
it on `acme/platform/staging` and apply it.

Expected: `migration_plan` returns a plan whose execution role is
`acme_staging_owner` under the declared exception (the warning
`migration.execution-role-exception` names it); `plan_apply` and
`operation_get` end `succeeded` with verification `passed`; the new table is
owned by `acme_staging_owner`. Counter-check: the same request against a
production target is planned, not applied: it waits for a person.

## 8. Then REOSA staging

The owner runs the same steps against REOSA staging on `reos-db-01` in a
REOSA session ([`../12-operations/onboard-external-cluster.md`](../12-operations/onboard-external-cluster.md)),
with REOSA's names and files, never in this repository: the endpoint
`10.8.1.1:5432` with TLS name `reosdb01.exponet.cloud` and its CA bundle, the
per-environment owner `<env>_owner` with its declared exception, the real
legacy directory, ledgers `supabase` and `applied_migrations`, and a scratch
database prepared with the schema-only copies the preflight names.
Production stays untouched (OD-7b).
