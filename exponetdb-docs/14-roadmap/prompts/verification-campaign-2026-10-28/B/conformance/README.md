# B2: executable bundle conformance tests (verification campaign 2026-10-28)

These tests turn invariants I1 to I5, I13, I14 and I15 of the brief (block B) into vitest files. They live
OUTSIDE the product tree. `run.sh` copies them into a throwaway checkout as `packages/b2-conformance` (a
workspace package), so CI can run them later without touching product code.

Tree under test: `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of fix PR #46).

## What is here

| File | Invariant | Needs |
|---|---|---|
| `I1-determinism.pure.test.ts` | I1 same bytes on 4 runtimes x TZ x LANG x input order | Node + Bun on PATH; optional `B2_NODE_ALT`, `B2_BUN_ALT` |
| `I2-content-identity.pure.test.ts` | I2 edit classes of the c1 checksum, compared with `migration-bundles.md` | nothing |
| `I3-order-is-the-dag.pure.test.ts` | I3 graph: diamond, 1,000 chain, 5,000 fan-out, cycle, self, unknown, cross-project, shuffles | nothing |
| `I3-order.int.test.ts` | I3 plan order / apply order / plan content on real PostgreSQL 17 | targets + Control Store |
| `I4-atomicity.pure.test.ts` | I4 lint / classifier matrix (about 250 statements) | nothing |
| `I4-classifier-vs-server.int.test.ts` | I4 40 statements, the server (BEGIN ... ROLLBACK) as oracle for "cannot run in a transaction block" | targets |
| `I4-atomicity.int.test.ts` | I4 apply on PostgreSQL 16, 17, 18 through the engine (34 hazards in function bodies, 16 host-reaching statements, 15 lint hazards, engine guards, locks) | targets + Control Store |
| `I5-parser-equals-server.int.test.ts` | I5 seeded scripts: model = server = repo ranges = c1 executable text, PostgreSQL 16/17/18 | targets |
| `I5-edges.int.test.ts` | I5 edge inputs (comment continuation, VT, depth, 3 MB, 100,000 statements, scs off) | targets |
| `I5-mutation.int.test.ts` | I5 single-edit mutants of generated scripts: server, libpg_query and c1 compared | targets |
| `I13-immutability.int.test.ts` | I13 bundle store: same id other bytes, races, mirror window, dangling bundle | targets + Control Store |
| `I14-containment.pure.test.ts` | I14 hostile content in CHILD processes (`node --liftoff-only`): time, CPU, RSS; loader on hostile directories | nothing |
| `I15-limits.pure.test.ts` | I15 every limit at the boundary (accepted at the limit, refused one past it) | nothing |
| `I15-time.int.test.ts` | I15 statement / lock timeouts | targets + Control Store |
| `lib/`, `tools/` | generator with a model (`lib/gen.ts`), pg helpers, `tools/probe.ts` (one hostile input per child process), `tools/densescale.ts`, `tools/lintscale.ts`, `tools/dump.ts` (I1 matrix), `tools/turkish.mjs` | |
| `fixtures/` | minimal reproducers of the findings | |
| `RESULTS.md` | counts and verdicts per invariant | |

A test that FAILS is a finding (the title says what is expected); the failing ones are listed in
`RESULTS.md` and in `EV/F/findings-B2.md`. Tests were never weakened to get green.

## Run

```bash
# 1. toolchain (CI has it): Node 24.22.1, Bun 1.4.4, UTC
source /home/david/exdb-vc-tools/env-pinned.sh        # or your own pinned setup

# 2. a throwaway checkout of the commit under test, installed
git -C <repo> worktree add --detach ../ExponetDB-verify-b2 d51da5d0d8832ebc569f23985c7e5176e4d450ad
(cd ../ExponetDB-verify-b2 && bun install --frozen-lockfile)

# 3. servers for the .int tests, with the product's own scripts (names/ports are free to choose)
export EXDB_DEV_TARGET_PREFIX=b2 EXDB_DEV_TARGET_BASE_PORT=566
eval "$(bash tooling/dev/targets.sh /tmp/b2-targets)"                        # PostgreSQL 16, 17, 18 (TLS) -> EXDB_TEST_TARGETS
EXDB_DEV_PG_CONTAINER=b2-control EXDB_DEV_PG_PORT=56632 EXDB_DEV_S3_CONTAINER=b2-s3 EXDB_DEV_S3_PORT=56670 \
  eval "$(bash tooling/dev/control-store.sh)"                                # Control Store -> EXDB_TEST_PG_URL

# 4. run
./run.sh ../ExponetDB-verify-b2 pure                     # no database needed (I1, I2, I3, I4, I14, I15)
./run.sh ../ExponetDB-verify-b2 int                      # needs EXDB_TEST_TARGETS and EXDB_TEST_PG_URL
./run.sh ../ExponetDB-verify-b2 all
./run.sh ../ExponetDB-verify-b2 pure I1                  # a file filter is passed to vitest
B2_NODE_ALT=$HOME/.nvm/versions/node/v26.5.0/bin/node B2_BUN_ALT=$HOME/exdb-vc-tools/bun-1.3.14/bun ./run.sh ../ExponetDB-verify-b2 pure I1
```

The first run adds `packages/b2-conformance` to the checkout's workspace and runs a plain `bun install`
(the lockfile of the THROWAWAY checkout gains the new workspace entry; the packages and versions are the
ones already in the lockfile). Nothing is written to `/home/david/Development/ExponetDB-verify`.

Environment knobs: `B2_I5_SEEDS` (default 120 scripts per major), `B2_I5_MUTANTS` (default 150 per major), `B2_MEASURE_FILE` (JSON lines with time/CPU/RSS
of the scale tests, default `/tmp/b2-run/measure.jsonl`), `B2_FIXTURE_OUT` (minimal reproducers written by I5),
`B2_NODE` / `B2_BUN` (runtime used by the child-process tests, default `node` / `bun` on PATH).

Memory and CPU figures come from child processes started as the image starts every role
(`node --liftoff-only`, deployment.md section 2a). Run them on an otherwise idle machine: the budgets are 10 s
and 512 MiB per bundle.

CI wiring (later): `bun run --cwd packages/b2-conformance test:pure` is a plain vitest run (about 6 minutes, most
of it the three nested-comment cases, which currently FAIL by design); `test:int` needs the two server scripts above.

## Safety

The tests create databases named `exdb_t_*` on the disposable servers only and drop them. They never connect to
anything else. No secrets are read except the throwaway superuser password files that `targets.sh` generates.
