# ADR-0034: Execution roles for adopted schemas: a declared `BYPASSRLS` exception and per-environment bindings

| | |
|---|---|
| Status | **Accepted for development** under the owner's Wave 9 order (§3.2 D-A1 and D-A2, §7 A4 and A5; OD-51); part of the evidence the owner accepts or rejects with G9 |
| Date | 2026-10-21 |
| Amends | the **[DECIDED]** rule of [`../../03-database-model/credentials-and-roles.md` §3](../../03-database-model/credentials-and-roles.md#3-execution-roles-who-owns-application-objects) (Wave 6) that no execution role may carry `BYPASSRLS`, and the per-project alias map of the same section |
| Related | [ADR-0020](./0020-no-superuser-in-control-plane.md) (no superuser in the Control Plane), [ADR-0011](./0011-plan-apply-operations-engine.md) (bound plans), [ADR-0012](./0012-staging-before-production.md) (staging evidence); [`../../02-control-plane/policy-engine.md`](../../02-control-plane/policy-engine.md); [`../../04-migrations/legacy-import.md`](../../04-migrations/legacy-import.md); [`../../08-auth-and-security/threat-model.md`](../../08-auth-and-security/threat-model.md); OD-13, OD-22, OD-51 |

## Context

Wave 6 made the execution role (the `NOLOGIN` owner of a project's objects,
into which the migrator switches with `SET LOCAL ROLE`) as weak as possible:
`executionRoleProblem` (`packages/postgres/src/migration-facts.ts`) refuses
a role with `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` **or
`BYPASSRLS`**, a `LOGIN` role, a predefined (`pg_…`) or ExponetDB role, a
role that reaches any of them through memberships, and a role of which the
migrator is not a direct `SET TRUE`, `INHERIT FALSE` member. The rule
`migration.execution-role` has no override of any kind.

On 2026-10-21 the owner tried to put the first real database under
ExponetDB: a Supabase-origin schema on a self-managed PostgreSQL 17 cluster.
Two properties of every Supabase-origin schema collide with Wave 6:

1. **Supabase's `postgres` role has `BYPASSRLS`, and the schema depends on
   it.** Supabase-origin schemas use `SECURITY DEFINER` functions owned by
   that role on tables with `FORCE ROW LEVEL SECURITY`. A definer function
   runs with its owner's rights; with `FORCE`, row security applies to the
   owner too, unless the owner has `BYPASSRLS`. Measured on the first
   adopter: 159 `FORCE` tables, 48 definer functions, 41 of them touching
   `FORCE` tables. An owner that mirrors `postgres` must keep `BYPASSRLS`, or
   those functions silently return empty results and fail policy checks on
   writes. The adopter's owner is `NOLOGIN` and has no other privileged
   attribute; Wave 6 refuses it for `BYPASSRLS` alone.
2. **Staging and production of one project share a cluster with different
   roles.** The adopter's model is one role set per environment
   (`<env>_owner`, `<env>_migrator`, …) on one cluster. Wave 6 maps an
   execution role alias to one role per **project**
   (`registry.projects.execution_roles`), although
   `credentials-and-roles.md` §3 already said "per target".

A product that can manage only greenfield schemas cannot adopt real ones,
and every Supabase-origin project hits both.

## Decision

### 1. The exception record

A new registry record, **`registry.execution_role_exceptions`** (an additive
Control Store bundle; id prefix `rxe_`), declares that one PostgreSQL role
may serve as an execution role of one project **in one environment**
although it has `BYPASSRLS`:

| Field | Meaning |
|---|---|
| `exception_id`, `revision` | identity; the revision grows with every change |
| `project_id`, `environment_id` | the scope: plans of targets of this project in this environment only; the environment belongs to the project's product |
| `role_name` | the PostgreSQL role (never `pg_…`, never `exponetdb_…`) |
| `attributes` | the excused attributes; a `CHECK` constraint allows exactly `{bypassrls}`, so nothing else can ever be stored |
| `reason` | 20 to 1000 characters, untrusted text, shown with every plan that uses it |
| `review_by` | optional date by which a person reviews it; after it passes, the exception no longer excuses anything (fail closed) |
| `state` | `active` or `revoked`; a revoked exception is never re-activated (a new declaration is a new record) |
| declared and revoked by | the identity, the time and the operation of each, from the database clock |

At most one active exception exists per (project, environment, role).

### 2. Who declares and revokes it

Two registry operation kinds, `registry.execution_role_exception.declare`
and `registry.execution_role_exception.revoke`, planned and applied like
every registry change (C-6):

- permission `registry.manage`, **at the environment's tier** (a production
  environment needs production authority; the OAuth scope stays the single
  `registry.manage`, as for every registry action since OD-22);
- **human only** through the Web App or the first-party CLI; never MCP,
  never a service account or an API key (like `evidenceOverride: none`);
- on a production environment: one approval and a re-authentication within
  five minutes (policy rule `registry.execution-role-exception-production`);
  re-authentication is required on every tier for a declaration;
- both write an audit event (`registry.execution_role_exception.declared`,
  `…revoked`) with the scope, the role, the revision and the reason digest.

### 3. How the engine uses it

- `executionRoleProblem(facts, excused)` stays pure. It returns
  `declared_exception` (instead of `privileged_attribute`) **only** when
  `BYPASSRLS` is the sole problem of the role and `excused` contains
  `bypassrls`. `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION`,
  `LOGIN`, a predefined or ExponetDB role, any reach into one, a missing
  membership and every membership defect are never excusable and are
  reported before it.
- The planner reads the active, unexpired exceptions of the target's
  (project, environment), excuses `BYPASSRLS` for exactly the roles they
  name, and **binds** `{exceptionId, revision}` per excused role in the
  plan's expected state. The plan content grows; the plan-hash construction
  is unchanged.
- A new warn rule, `migration.execution-role-exception`, is visible in every
  plan that uses an exception (role, exception id and revision, declaring
  person, review date; the reason, a person's untrusted text, stays in the
  registry view and out of plans agents read).
  On production the plan's action class is at least `high`, and an agent's
  apply still needs a human approval (`migration.agent-production`, OD-13
  unchanged). Agents may apply nonprod migrations under a declared
  exception.
- `checkBindings` and the executor's re-check on the migrator session under
  the target lock refuse a revoked, changed or expired exception, and a role
  whose `BYPASSRLS` the plan did not excuse, with `PLAN_STALE`
  (`execution_role_exception`); a plan of several migrations checks again
  before each further one, so a revocation stops what has not started. The
  executor never widens what the plan bound: only the bound exceptions
  excuse anything at apply.
- A role that **reaches** (through any membership) a role with
  `SUPERUSER`, `CREATEROLE`, `CREATEDB`, `REPLICATION` or `BYPASSRLS`, or a
  predefined or ExponetDB role, is never usable, declared or not: a
  migration could otherwise hand an object to that role (`ALTER … OWNER
  TO`) and use its powers without any declaration. (Found by the
  independent review of Part A; the Wave 6 check counted superusers and
  protected roles only.)
- The legacy replay (`migration.import.replay`) checks the execution role
  exactly like an apply, at plan time and under the lock, with the
  exceptions of the **scratch** target's environment.

#### 3.1 `pg_database_owner` is not a protected reach (2026-10-22)

**[DECIDED]** 2026-10-22, at the owner's request after the first real
onboarding (`reos-db-01`, PostgreSQL 17.11, release `41ebcbb`). There the
scratch preflight refused `reosa_stg_owner` with `reaches_protected_role`,
and so would every plan and replay. The role is `NOLOGIN`, a member of no
role, and owns both of its databases, as Supabase-origin and most
self-managed installations do.

- **[OBSERVED]** (PostgreSQL 16, 17 and 18, 2026-10-22):
  - inside a database, `pg_has_role(owner, 'pg_database_owner', 'MEMBER')`
    is true for that database's owner, and false in every other database;
  - `pg_database_owner` (fixed oid 6171) refuses explicit members and
    refuses to be a member of any role, so reaching it reaches nothing
    further;
  - it owns the `public` schema of databases created from the default
    template.

  The Wave 6 predicate counted it as protected through
  `rolname LIKE 'pg\_%'`. The bootstrap SQL, which evaluates in `postgres`,
  granted the role while the planner, which evaluates in the target's
  database, refused it.
- **Decision.** Reaching `pg_database_owner` is the database owner's own
  identity, not a privilege. The protected-reach predicate excludes it by
  its oid (`'pg_database_owner'::pg_catalog.regrole`), never by a name
  pattern. Every other predefined role stays protected: `pg_read_all_data`,
  `pg_write_all_data`, `pg_signal_backend`, `pg_monitor`,
  `pg_execute_server_program` and the rest.
- **One definition.** The predicate is one SQL fragment,
  `REACHES_PROTECTED_ROLE` (`packages/postgres/src/migration-facts.ts`).
  The role facts use it, and so does everything built on them: the planner,
  the executor, the replay, the scratch preflight and the health finding.
  The bootstrap SQL's grant check embeds the same text.
- **No per-database bootstrap check.** `pg_database_owner` is the only role
  whose membership depends on the current database; every other membership
  is cluster-wide. With it excluded, the predicate gives the same answer in
  every database, so the check in `postgres` and the planner's check in the
  target's database cannot disagree. A test asserts this on 16, 17 and 18,
  and asserts that the bootstrap embeds the planner's text.
- **What database ownership still allows, and what refuses it.**
  - `ALTER DATABASE`, its `SET` form, `DROP DATABASE` and `CREATE DATABASE`
    are refused by bundle admission (`database`).
  - Procedural code that issues them belongs to OD-55. As database owner,
    such code could also change the database's settings, connection limit
    or `ALLOW_CONNECTIONS`.
  - Ownership itself is what adopted schemas have always had.

### 4. Drift and parity

- A finding (`execution_role_exception_drift`) is raised when the live
  role no longer matches the declaration: it lost `BYPASSRLS` or no longer
  exists (the exception is stale and should be revoked), or gained any other
  privileged attribute (critical; every plan is refused anyway). A
  declaration past its review date raises it too (it excuses nothing until
  a person declares it again or revokes it). The health sampler raises it
  (kind `health`, one finding per declaration,
  [`health.md` §3](../../10-observability/health.md)), because a schema
  drift acceptance must never cover a role's attributes.
- Evidence for production compares the evidence environment's execution
  roles with production's: equal attributes and equal exception status, or a
  warning (`migration.execution-role-parity`): a staging run under a role
  without `BYPASSRLS` does not prove the behavior of production's role that
  has it, and the other way round.

### 5. Execution roles per environment (D-A2)

- A new registry record, **`registry.execution_role_bindings`**
  (`project_id`, `environment_id`, `alias`, `role`, set and ended by an
  operation), overrides the project's alias map for one environment.
  Resolution per alias: the environment's current binding if one exists,
  else the project map. The project map stays the default, so every Wave 6
  project works unchanged. Nothing is deleted (no runtime role deletes in
  the registry, a frozen Wave 2 verification): a change ends the current
  row of an alias and inserts its successor in the same operation, so the
  table keeps the history.
- **One resolver**, `executionRolesFor(target)`, replaces every direct
  reader of the project map in the engine (planner, apply kind, resume,
  rollback, re-verification, reads, the legacy replay); a test fails when
  code outside the resolver reads `execution_roles` again.
- Changing a binding is a registry operation
  (`registry.execution_role_binding.set`), `registry.manage` at the
  environment's tier with a re-authentication, human only; a binding change
  between plan and apply makes the plan `PLAN_STALE` (the plan binds the
  resolved names, as since Wave 6). An environment subject passes only an
  unrestricted grant ([`authorization.md` §5](../../08-auth-and-security/authorization.md)):
  a tier-restricted CLI grant changes no environment's roles, and a person
  whose bindings do not cover the environment does not see it (`NOT_FOUND`).
- Nothing frozen changes: `c1` hashes only the alias
  ([`migration-bundles.md` §3](../../04-migrations/migration-bundles.md#3-checksum-semantics)),
  the plan binds resolved names per target, and evidence binds the
  checksum. A production plan consumes staging evidence of the same checksum
  although staging ran as another role. A golden plan-hash vector over a
  plan with per-environment roles is appended (`plan-006`).
- An environment binds only aliases of the project map: a binding of an
  alias the map no longer has binds nothing. An environment keeps its tier
  while it binds execution roles or holds an active exception (the planner
  refuses `tier_in_use`, and a Control Store trigger refuses the change):
  both were set under that tier's authority.
- **Consequence, open (OD-53).** fp1 includes object owners, so two
  environments whose objects are owned by different roles never share a
  fingerprint: `migration.fingerprint-lineage` then fails for every
  production plan of a project that is not an imported legacy project, and
  each needs an approval (fail closed). An imported project sees only the
  legacy lineage warning. fp1 does not change.

### 6. Threat analysis

**What `BYPASSRLS` adds to an execution role.** The role already owns the
project's objects: it can disable or alter row security on its own tables,
so on owned tables `BYPASSRLS` adds nothing an authored migration could not
do anyway. It adds two things: (1) row security of `FORCE` tables no longer
applies to the role inside its own definer functions (the reason it is
needed), and (2) row security of tables **owned by other roles** on which
the role has privileges no longer applies to it (for example an identity
service's tables, if the owner was granted `SELECT` on them). An authored
migration (and a `verify.sql` does not run as this role) could therefore
read such rows into an owned table.

**Why it is accepted.** It is the declared behavior of every Supabase-origin
schema, and the alternative (rewriting the adopter's role model before
adoption) blocks adoption entirely. It is never implicit: it needs a
person's declaration with a reason, scoped to one environment, shown in
every plan, revocable at once, reviewed by date.

**Compensating controls.** Lint and analysis of every bundle (grants,
security definer without `search_path`); staging-first with identical
checksums (C-15); human approval of every agent apply on production
(OD-13, `migration.agent-production`); human approval and re-authentication
of the exception itself on production; audit of the declaration, every plan
and every apply; the drift finding; and the parity warning. The residual
risk is recorded as threat **T35** in the threat model.

### 7. The target state for adopters

The exception is a supported bridge, not a hidden permanent hole. The
recommended target state: move the `SECURITY DEFINER` functions to a
dedicated definer role that carries `BYPASSRLS` (owning nothing else), so
the execution role can drop `BYPASSRLS` and the exception can be revoked.
`legacy-import.md` and `credentials-and-roles.md` describe the steps; the
`review_by` date keeps the question on the table.

## Consequences

- Supabase-origin schemas can be adopted without rewriting their role model
  first; the owner sees the exception wherever it matters.
- Two additive Control Store bundles, four new actions, two new policy
  rules (one warn, one require), one finding kind, and optional fields in
  `MigrationPlanContent`; no frozen contract, bundle or vector changes.
- The constitution is not amended: C-23 keeps holding ("schema changes run
  only through the migration engine, under the project's designated
  execution role"; the designation is now per environment), and least
  privilege per path is met by excusing exactly one attribute, only where a
  person declared it.

## Alternatives considered

- **Keep refusing `BYPASSRLS`.** Every Supabase-origin adopter must first
  rewrite its definer functions and `FORCE` tables: rejected, adoption
  would never start.
- **Accept any attribute a project declares.** `SUPERUSER`, `CREATEROLE`,
  `CREATEDB`, `REPLICATION` give powers far beyond the project's own
  objects (cluster-wide roles, databases, replication): rejected; the
  `CHECK` constraint makes it impossible by construction.
- **A break-glass grant per plan.** Break-glass is time-boxed, refused while
  OD-21 is open, and meant for incidents, not for a permanent property of a
  schema: rejected.
- **An attribute on the project instead of a record.** No scope per
  environment, no reason, no revision to bind, no audit trail of its own:
  rejected.
