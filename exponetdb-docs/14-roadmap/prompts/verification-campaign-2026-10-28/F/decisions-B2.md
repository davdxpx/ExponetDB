# Open decisions raised by the executable conformance tests (agent B2)

Anything the owner must decide, not a finding. Source: `B/conformance/` (tests, `RESULTS.md`). Tree `d51da5d0`.

- **B2-D1 What does invariant I1 promise?** The brief says "same bundles and same target state give the same plan
  hash". The plan hash binds a random plan id, `createdAt`, `expiresAt` and the actor (`operations/src/plans.ts:168-190`),
  so two plans of identical input never share a hash (proven in `I3-order.int.test.ts`). What is deterministic is the
  plan CONTENT (`contentChecksum`, equal across two plans in the test) and every pure digest (equal on Node 24.22.1,
  Bun 1.4.4, Node 26.5.0, Bun 1.3.14, three time zones, two locales, three input orders: 28 runs, one hash).
  Decide the wording: determinism of `contentChecksum` and the digests (what is tested now). Same question as B1-D2;
  note that `content.migrations[].revision` is installation-local, so `contentChecksum` is equal only inside one
  installation's store history.
- **B2-D2 May bytes under a never-applied id still be rewritten?** `migration-bundles.md` section 3 allows it
  (`rewritten_unapplied`, the earlier revision stays); the brief's I13 says the same id with other bytes is "refused
  everywhere". Today: allowed until the id is applied on any target of the project, and the store then trusts the
  Control Store mirror only (finding "mirror window"). Options: (a) keep, and read the target ledgers too; (b) freeze an
  id the first time a plan, an approval or staging evidence references it; (c) refuse always and require a new id.
- **B2-D3 ULIDs of independent migrations.** The brief and CLAUDE.md say "ULIDs never order"; `dependency-graph.md`
  section 4 says the smallest ready ULID is the tie-break, and the tests confirm it (two independent migrations apply in
  ULID order whatever the upload order). Confirm the documented tie-break, or require an explicit edge whenever two
  migrations touch one object (today `parallel_object_overlap` warns and blocks only on the prod tier).
- **B2-D4 c1 is exact, and says so only in section 3.** Edits an author thinks harmless change the checksum: keyword
  case, `$$` versus `$f$`, a second `;`, spacing around punctuation (`f (x)` versus `f(x)`), a reordered but equal
  `requires.postgres` range (91 cases in `I2-content-identity.pure.test.ts`, 11 marked `char`). Accept and document in
  section 7 and in the lint message, or plan a `c2` through an ADR (same question as B1-D9).
- **B2-D5 CPU/time budget of lint and plan.** Lint and plan run synchronously in the `serve` process (`lintProject`,
  `planMigrationApply` inside a Control Store transaction). Which wall-time bound per request is acceptable (the tests
  assume 10 s per bundle), and is a worker thread with a deadline the accepted architecture? Two shapes exceed any bound
  today (nested block comments, long dependency chains): see the findings.
- **B2-D6 One published limits table.** Values that exist in code but not in `04-migrations/` (dependsOn 1,000,
  extensions 64, searchPath 32, authors 32 x 320, ticket 200, 50 bundles and 200 ids per request, 32 MiB body, CLI 5,000
  bundles, the 200,000-token parse bound that makes 100,000 tiny statements impossible although section 1 promises 4 MiB).
  Decide where they are published and whether the token bound gets its own reason (`BUNDLE_INVALID_REASONS` has
  `file_too_large`, nothing for the token bound; it appears as `parse_error` text).
- **B2-D7 Symbolic links and non-regular entries in a bundle directory.** Today the CLI loads a link or directory named
  `up.sql`/`verify.sql`/`down.sql` as an EMPTY file; refuse with a named reason (`not_a_regular_file`) or skip?
- **B2-D8 String continuation across a line comment.** PostgreSQL accepts `'a'` newline `-- c` newline `'b'`; the
  libpg_query builds the engine uses do not (and `lexer.ts` `continuation()` ignores the comment too). Patch/rebuild the
  parser, or declare it unsupported in section 3 N4 and make the lint message say so?
- **B2-D9 Which functions may `up.sql` call?** `pg_advisory_unlock_all()` releases the engine's own target lock while the
  migration runs; `set_config` of seven more pinned names goes unseen. Decide between an allowlist of function names for
  top-level statements (function bodies stay text), a denylist (`pg_advisory_*`, `pg_terminate_backend`, ...), and making
  the engine re-assert its lock and settings after each statement.
- **B2-D10 Depth limit of `migration.yaml`.** A nesting of about 1,000 flow collections is refused with the YAML library's
  own text ("Maximum call stack size exceeded"). Name a limit (for example depth 32) in section 2.
