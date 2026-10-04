# Drift detection

| | |
|---|---|
| Status | Baseline (Wave 0), awaiting owner approval |
| Applies to | Wave 4 (fingerprints), Wave 6 (ledger drift), Wave 8 (UI), Wave 10 (REOSA) |
| Read before | [`schema-fingerprints.md`](./schema-fingerprints.md), [`../04-migrations/ledger.md`](../04-migrations/ledger.md) |

Drift is any difference between two things that should agree. ExponetDB detects
it; it never "fixes" drift automatically. Each drift item becomes a **finding**
with a suggested resolution that is itself a planned operation.

**[DECIDED]** Drift detection is framework-agnostic: it works on PostgreSQL
catalogs, ledgers and bundles. It does not assume Drizzle or any ORM; an ORM
schema is an optional additional reference
([`../04-migrations/authoring-and-ci.md` §7](../04-migrations/authoring-and-ci.md#7-framework-adapters-orm-neutrality)).

## 1. References and the drift kinds between them

```
   source (bundles in the repository)
            │  (A) source ↔ ledger
            ▼
   ledger (what was applied, per target)  ◀── (B) ledger ↔ mirror ──▶  Control Store mirror
            │  (C) expected ↔ actual
            ▼
   actual schema (fingerprint of the target)
            │  (D) environment ↔ environment
            ▼
   actual schema of the evidence environment
            (E) desired cluster state ↔ actual cluster state (roles, settings, extensions)
            (F) ORM schema ↔ expected schema (optional adapter)
```

| Kind | Compares | Finding examples | Severity |
|---|---|---|---|
| **A** source ↔ ledger | bundles in the submitted source vs the target ledger | `pending_in_source` (normal), `applied_not_in_source` (bundle deleted or on an abandoned branch), `checksum_differs_from_source` | info / warn / critical |
| **B** ledger ↔ mirror | target ledger vs Control Store mirror | rows written outside ExponetDB, rows missing after restore, checksum change | critical (blocks schema changes) |
| **C** expected ↔ actual | the target's current fingerprint vs the `fingerprint_after` of its last applied migration (or the baseline) | out-of-band DDL: object added, dropped, altered (incl. ACLs, policies, function bodies) | warn; critical for security-relevant classes (ACL, RLS, policy, security definer, `search_path`) |
| **D** environment ↔ environment | target vs its evidence target (both fingerprints) | staging has an index production lacks; production policy differs (REOSA: `tenant_members_select_own`) | info / warn |
| **E** cluster desired ↔ actual | declared roles, role settings, memberships, extensions, `pg_hba`, configuration vs node/cluster observation | role missing, role attribute changed (`BYPASSRLS`), role setting lost after a move | warn / critical |
| **F** ORM ↔ expected | ORM shape vs fingerprint document of baseline+bundles | column in ORM not in DB (future `42703`) | warn (CI) |

## 2. How C works without a "desired schema file"

ExponetDB does not need a declarative target schema to detect structural drift:
every applied migration records `fingerprint_after`, and the canonical document
for it is stored. **The last recorded document is the expected state.** If the
current fingerprint differs and no ExponetDB operation explains it, something
changed out of band. The diff of the two documents names the objects and
attributes.

## 3. Schedule and triggers

- On every plan (implicit: plans bind to the current fingerprint and ledger).
- After every operation (verification L3).
- Periodically per target (default every 15 minutes for prod tier, 60 minutes for
  nonprod; computing a fingerprint is cheap, see fingerprint doc §7).
- On demand (`drift_check` tool, REST, Web App).
- After restores and placement changes.

## 4. Triage (adopted from the Supabase reference's config-drift UX)

**[DECIDED]** Each compared item lands in exactly one bucket:

| Bucket | Meaning |
|---|---|
| `drifted` | the references disagree |
| `matched` | they agree |
| `unmanaged` | outside managed scope, or present but intentionally not tracked (e.g. `unmanaged_but_present` objects accepted during legacy import) |

The Web App shows drifted items first, with "expected" and "actual" side by side,
the time window in which the change happened (between two fingerprints), and
whether an operation explains it. **[OBSERVED]** The Supabase reference's
`ConfigDrift` surface uses the same three-way triage for configuration and
distinguishes "declared in the file" from "equal to a default"; ExponetDB applies
the idea to schema, ACLs and cluster state.

## 5. Resolutions

| Resolution | Operation | Effect |
|---|---|---|
| Adopt actual as expected | `drift.accept` (planned; records the new document as expected with a reason) | finding closed; no DDL |
| Restore expected | authored forward migration (bundle) | normal migration path |
| Explain | link to an operation or external change record | finding annotated |
| Ignore class | project configuration (e.g. exclude a schema) | scope change, audited |

`drift.accept` on prod tier requires approval, because it turns an unreviewed
change into the baseline future plans bind to.

## 6. Security-relevant drift

**[DECIDED]** Drift in these classes is `critical` and pages the owner (when
alerting exists, Wave 9): ACL changes on tables, columns, functions, schemas;
default privileges; RLS disabled or no longer forced; policy added, removed or
changed; function `SECURITY DEFINER` or `proconfig` changes; role attribute
changes (`SUPERUSER`, `BYPASSRLS`, `CREATEROLE`); new login roles; `pg_hba`
changes.

**[OBSERVED]** REOSA's August 2026 incident (same migrations, different effective
privileges on staging and production due to `pg_default_acl`) and the missing
`0014` policy fix on production are exactly class C/D security drift that went
unnoticed for weeks.
