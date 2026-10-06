# @exponetdb/testkit

Test infrastructure for managed targets. **Tests only**: product code never
imports it (`bun run boundaries` refuses it).

- `testTargets()`, `matrix()`, `serverFor(major)`: the disposable PostgreSQL
  16, 17 and 18 servers that `tooling/dev/targets.sh` starts (TLS only,
  `hostssl` + `scram-sha-256`, a CA generated for the run) and one
  PostgreSQL 17 without TLS. `EXDB_TEST_TARGETS` names the description
  file; without it the suites fail, they are never skipped.
- Fixtures: hostile metadata, a REOSA-shaped synthetic schema (shapes only,
  neutral `acme_*` names, no data), and the 2,000-table plan-guard catalog;
  `databaseFromFixture` copies a cached template database per fixture.
- `FaultProxy`: a TLS-terminating protocol proxy that refuses, black-holes,
  delays, cuts, or lets simple queries through while parameterized
  (extended protocol) queries hang.

See `exponetdb-docs/14-roadmap/test-strategy.md` and
`exponetdb-docs/12-operations/local-development.md`.
