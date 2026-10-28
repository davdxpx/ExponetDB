# Results of the executable bundle conformance tests (agent B2)

Tree under test `d51da5d0` (merge of fix PR #46), Node 24.22.1, Bun 1.4.4, UTC, throwaway checkout
`/home/david/Development/ExponetDB-verify-b2` (no change to the tree under test). Servers: the product's own
`tooling/dev/targets.sh` containers `b2-pg16`, `b2-pg17`, `b2-pg18` (ports 56616 to 56618, TLS) and a Control Store
`b2-control` (port 56632), all removed at the end. The machine was shared (load average 9 to 35 on 8 cores), so wall
times are upper bounds.

817 test cases ran: **769 passed, 48 failed**. A failing case is the acceptance test of a finding
(`F/findings-B2.md`); nothing was skipped or weakened. "Cases" are vitest test cases (a case may loop over a table or
a seeded generator: 120 generated scripts per major in I5, 150 mutants per major, 91 edit classes in I2).

| Invariant | Test file | Cases | Pass | Fail | Notes | Verdict |
|---|---|---|---|---|---|---|
| I1 | `I1-determinism.pure.test.ts` | 36 | 35 | 1 | 4 runtimes x 7 environments = 28 child runs, one hash; lint report depends on submission order (1 fail = finding) | PARTIAL |
| I2 | `I2-content-identity.pure.test.ts` | 91 | 91 | 0 | 91 edit classes against migration-bundles.md section 2, 3, 7 (11 pin behaviour the document leaves open), 3 properties x 300 to 400 runs | PASS |
| I3 | `I3-order-is-the-dag.pure.test.ts` | 24 | 23 | 1 | graph: diamond, 1,000 chain, 5,000 fan-out, 5,000 cycle, self, unknown, cross-project, shuffles, reference model; lint over a chain is cubic (1 fail) | PARTIAL |
| I3 | `I3-order.int.test.ts` | 8 | 7 | 1 | plan order = apply order = ledger order, content checksum equal, plan hash differs by design; 1,000-chain plan 53 s / Control Store timeout (1 fail) | PARTIAL |
| I4 | `I4-atomicity.pure.test.ts` | 255 | 253 | 2 | 253 statements/spellings through the classifier; `DETACH PARTITION CONCURRENTLY` not recognised (2 fails) | PARTIAL |
| I4 | `I4-classifier-vs-server.int.test.ts` | 3 | 0 | 3 | 40 statements swept with the server as oracle on 16/17/18; one miss (3 fails, one per major) | FAIL |
| I4 | `I4-atomicity.int.test.ts` | 213 | 187 | 26 | 34 function-body hazards + 16 host-reaching statements + 15 lint hazards on 16/17/18: atomic in all; 26 fails = 7 unguarded settings (20), `pg_advisory_unlock_all` (3), DETACH (3) | PARTIAL |
| I5 | `I5-parser-equals-server.int.test.ts` | 54 | 54 | 0 | 120 seeded scripts per major (model = server = repo ranges = c1 executable text) + 17 hand-picked hazards x 3 majors | PASS |
| I5 | `I5-edges.int.test.ts` | 30 | 27 | 3 | comment continuation (3 fails), VT, depth parity, 2 MB literals, 100,000 statements, multibyte ranges, scs off | PARTIAL |
| I5 | `I5-mutation.int.test.ts` | 3 | 3 | 0 | 150 single-edit mutants per major: server, libpg_query and c1 agree on what is lexically valid (0 disagreements) | PASS |
| I13 | `I13-immutability.int.test.ts` | 14 | 10 | 4 | store refusals, races, trigger immutability, dangling bundle PASS; comment/metadata edits dropped, mirror window (4 fails) | PARTIAL |
| I14 | `I14-containment.pure.test.ts` | 61 | 54 | 7 | 24 hostile SQL shapes in child processes, hostile YAML, loader on hostile directories, schema refusals; nested comments, 6 dense bundles, symlink x2, oversized read, YAML text (7 fails) | FAIL |
| I15 | `I15-limits.pure.test.ts` | 22 | 22 | 0 | every size/count/duration/request/parse/CLI limit at the boundary (limit accepted, limit+1 refused) | PASS (value) / documentation gaps |
| I15 | `I15-time.int.test.ts` | 3 | 3 | 0 | statement timeout and lock timeout enforced, named, nothing applied | PASS |

## Verdicts

| Invariant | Verdict | One line |
|---|---|---|
| I1 Determinism | **PARTIAL** | Digests, executable text, statement analysis, graph order and a plan-hash over fixed content are byte-identical on Node 24.22.1, Bun 1.4.4, Node 26.5.0, Bun 1.3.14 x TZ UTC / Pacific/Kiritimati / America/St_Johns / Pacific/Pago_Pago x LANG C / C.UTF-8 / tr_TR.UTF-8 x three input orders (28 runs, one hash). The real plan hash binds a random id and timestamps (not deterministic by design: decision B2-D1); the lint report depends on submission order (finding). The engine plan was not rebuilt on the alternative runtimes (NOT RUN). |
| I2 Content identity | **PASS** (with 11 documented-silence cases) | 91 cases: every edit class behaves as `migration-bundles.md` section 3 and 7 say; 11 `char` cases pin behaviour the document leaves open (decision B2-D4). |
| I3 Order is the DAG | **PARTIAL** | Order, ties, diamond, cycle, self-dependency, unknown and shuffles all PASS (library and engine, apply order = plan order = ledger order). FAIL: lint/plan time over a dependency chain is cubic (finding). Cross-project dependency is proven at graph level only (engine level NOT RUN). |
| I4 Atomicity | **PARTIAL** | PASS: 253 lint cases and, on PostgreSQL 16, 17 and 18, every hazard that reaches the server is atomic (`COMMIT`/`ROLLBACK`/`SAVEPOINT` in `DO` and procedures, role switches, ledger forgeries, pinned settings, self-kill, `PREPARE TRANSACTION`: ledger row and effects appear together or not at all). FAIL: `DETACH PARTITION CONCURRENTLY` is not classified; `pg_advisory_unlock_all()` releases the engine's lock; seven pinned settings are not guarded (findings). |
| I5 Parser equals server | **PARTIAL** | 360 generated scripts (120 per major, a 150-per-major run earlier was equal), 51 hand-picked cases (17 per major) and 450 single-edit mutants (150 per major): model = server = repo statement ranges = c1 executable text, and server, libpg_query and c1 agree on what is lexically valid. FAIL: string continuation across a line comment (server accepts, libpg_query refuses). Depth: repo and server refuse together above 8,000 nested parentheses. |
| I13 Immutability | **PARTIAL** | PASS: refusal after apply on any target, concurrent uploads, DB-level immutability (triggers hold for serve, worker, even the superuser), plan binds its revision, dangling bundle does not poison planning. FAIL: comment/metadata edits are dropped as `unchanged`; the mirror-only check lets other bytes in during the commit-to-mirror window. |
| I14 Containment | **FAIL** | PASS: 20 hostile shapes within 10 s and 512 MiB (`--liftoff-only`), YAML bombs, traversal in names, schema-level refusals. FAIL: nested block comments freeze the process (P1), symlink loaded as empty file, oversized file read whole, YAML depth text. |
| I15 Limits | **PARTIAL** | Every limit found in code (file sizes, name, description, durations, counts, request sizes, token bound, CLI bundle count, project file) is exact at the boundary. Gaps: several are undocumented in `04-migrations/`, the token bound and the statement timeout have no code of their own (finding, decision B2-D6). |

## What the failing tests are

Every failing test is the acceptance test of a finding in `EV/F/findings-B2.md`; none was weakened to get green.
A failing test has a title that states what is expected ("... must ...", "FINDING:").

## Ambiguities and contradictions found while comparing I2 with the documentation

1. `requires.postgres` is hashed "as written": `>=16 <19` and `<19 >=16` are two identities (case `m-requires-postgres-spelling`).
2. Keyword and identifier case, a renamed dollar tag, an extra `;`, a missing final `;` and spacing around punctuation
   (`f (x)` against `f(x)`) change the checksum; section 7 lists none of them (N5 says "no case folding" and whitespace is
   collapsed, never removed).
3. N2 normalises CR LF and CR to LF everywhere, also inside string literals, and the executor runs the normalised text
   (`executor.ts statementsOf`): a literal that contains a CR LF in the author's file contains an LF on the server.
   Documented in N2, but a data-affecting change of the author's bytes; worth a sentence in section 7.
4. The summary sentence of section 3 item 1 ("collapse every run of whitespace ... to one space") matches N5; the sentences of
   `CLAUDE.md` and `04-migrations/README.md` ("comment-only edits are not drift") are looser than c1 (also B1 FB1-10).
5. Section 3 table: the bundle digest is "content id for storage and evidence matching", but it is derived from three
   digests, never from bytes: two bundles that differ only in comments or in `description` share a bundle digest, so the
   store keeps the first bytes (I13).
6. The project defaults are part of the checksum (materialised at ingest) and are supplied by the client (B1 FB1-3).
7. N3 documents that U+000B is whitespace on PostgreSQL 17/18 only; the checksum is the same on 16, where the text cannot be
   applied (tested: parser and server agree on every major).

## Not run

| Item | Why |
|---|---|
| Engine plan rebuilt under Bun and Node 26 (I1) | the engine harness needs the Control Store and vitest on Node; the library level (digests, lint, analysis, graph, plan-hash function) is compared on four runtimes |
| Dependency across projects through the engine (I3) | needs a second project with a registered target; the store keeps one stream per project (graph level and `storedStream` tested) |
| Serve-level freeze demonstration for nested comments (I14) | the in-process calls that `serve` makes are measured; no live server was started |
| REST / MCP / CLI paths of I13 | all three call `ingestBundles`; only the library entry point is exercised |
| `tr_TR.UTF-8` as an OS locale (I1) | not installed on this machine; the Turkish rules are forced by patching `toLowerCase`/`toUpperCase`, and the libraries use no `toLocale*`, `localeCompare` or `Intl` |
| PostgreSQL images `postgres:16/17.11/18` | the product's own pgvector images (same majors) from `tooling/dev/targets.sh` were used, which is what CI uses |

## Measurements (child processes, `node --liftoff-only`, one bundle through c1 + analysis + lint; shared machine)

| Input (one `up.sql`) | Bytes | Wall ms | CPU ms | Peak RSS MiB |
|---|---|---|---|---|
| nested block comments, depth 5,000 | 20,009 | 482 | 539 | 140 |
| nested block comments, depth 20,000 | 80,009 | 6,978 | 6,424 | 142 |
| nested block comments, depth 40,000 (test) | 160,009 | 36,000 to 38,000 | 36,000 | 150 |
| 4,000 nested parentheses | 8,009 | 136 | 198 | 141 |
| `SELECT 1;` x 66,000 (198,000 tokens) | 660,000 | 2,931 | 3,540 | 429 |
| `COMMENT ...;` x 28,000 | 884,889 | 1,035 | 1,291 | 357 |
| `DO $tN$ ... $tN$;` x 28,000 distinct tags | 1,041,779 | 813 | 1,063 | 342 |
| a 4 MB string literal | 4,000,010 | 326 | 399 | 252 |
| a 4 MB identifier of astral characters | 4,000,024 | 387 | 464 | 271 |
| a DO body with 60,000 `PERFORM` | 660,020 | 136 | 179 | 154 |
| 5,000 columns | 48,907 | 381 | 457 | 185 |
| 4 MB of whitespace | 4,000,008 | 789 | 670 | 208 |
| YAML: 30,000 nested `[` | 60,238 | 433 | 617 | 200 |
| YAML: alias bomb, nine levels | 626 | 13 | 15 | 125 |

Several dense bundles in one lint call (`tools/densescale.ts`, 66,000 statements each, default heap): peak RSS 397 /
542 / 790 / 1,134 MiB for 1 / 2 / 4 / 8 bundles. With the documented heap of a 512 MiB container
(`--max-old-space-size=259`): 3 bundles 495 MiB, 4 bundles 546 MiB, 6 bundles V8 fatal out of memory (exit 134).

Graph library (pure, in process): 1,000-chain order 2 ms; 5,000 fan-out 46 ms (+12.8 MiB); 5,000-node cycle found in
28 to 85 ms; 20,000 independent nodes 160 to 330 ms; `selectionOrder` of 200 ids over a 5,000 chain 320 ms.
Linter over a chain of n bundles (`tools/lintscale.ts`): 50 / 100 / 200 / 400 / 800 bundles = 0.23 / 0.27 / 1.1 / 7.1 / 61 s
(cubic); over independent bundles 0.11 / 0.13 / 0.28 / 0.36 / 0.51 s (linear).

## Findings produced (see `F/findings-B2.md`)

| Finding | Severity | Failing tests |
|---|---|---|
| Nested block comments freeze the serving process | P1 | I14 "nested-comments 40000", "quadratic scaling" |
| Memory bounded per parse, not per request | P1 | I14 "6 dense bundles" |
| Lint and plan over a dependency chain are cubic | P2 | I3 pure "lint time over a chain", I3 int "1,000-deep chain" |
| `up.sql` releases the engine's target lock | P2 | I4 int "up.sql cannot release the engine's own target lock" x3 |
| `DETACH PARTITION ... CONCURRENTLY` not classified | P2 | I4 pure x2, I4 classifier x3, I4 int x3 |
| Bundle store trusts the mirror only | P2 | I13 "mirror has not caught up", "no plan ... may carry other bytes" |
| Seven pinned settings not guarded | P3 | I4 int x20 |
| Comment continuation refused by libpg_query | P3 | I5 edges x3 |
| Lint report depends on submission order | P3 | I1 "FINDING: the lint report ..." |
| CLI loader: symlink as empty file, oversized read | P3 | I14 x3 |
| YAML depth refused with the stack-overflow text | P3 | I14 x1 |
| Comment/metadata edits dropped by the store (B1: FB1-9) | P3 | I13 x2 |
| Limits not announced in one place | P3 | I15 pass at the boundary; documentation test is a proposal |
