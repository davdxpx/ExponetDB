# Migration lifecycle on the live scratch target: what was attempted and why it stopped

Project dir in scratch (not in the repository): `exponetdb init --project reosa/platform`, one bundle `01M5ZEVKFNT54P2DHKH5XSHNYV_tc-probe-a` (create table, three rows, grant, verify.sql with `-- covers: 0` and `1`).

1. `migration lint`: first run "BLOCKED 1 findings, 1 blocking" with the row printed as `level warn` (`table_without_grant`; JSON `level: warn, blocking: true`, exit 1). After adding a GRANT: "OK 0 findings, 0 blocking".
2. `migration checksum`: `sha256:c1:7e0f73c1b0a825923b83a74b75d7b2183e7189469664b828de50991e388d25f3`.
3. `migration plan --target reosa/platform/scratch` (also with the explicit id): `MIGRATION_DEPENDENCY_UNKNOWN: dependsOn names an id that is not in the project stream.` JSON error has no `details`; the offending id is not named. The bundle's own `dependsOn` is `[]`. The scratch target shows `0 applied, 12 pending`, the stored REOSA bundles of the project stream; staging shows `567 applied, 1 pending`. See the migration-engine tester's MIG-04 and MIG-05 (`B/migration-engine-failure-cases.md`): one stored bundle with an unknown dependency poisons planning for the project, and the planner's refusal drops the ids (`packages/migrations-engine/src/planner.ts:163`).
4. Decision: no apply on the live scratch target. The rest of the lifecycle (failing verify, verification revision, drift, lock timeout, nontransactional, rollback) ran at engine level against disposable PostgreSQL in `B/migration-engine-failure-cases.md`.
5. `migration status` on scratch says "Mirror: out of sync" (`mirror.inSync: false`), on staging "in sync".
