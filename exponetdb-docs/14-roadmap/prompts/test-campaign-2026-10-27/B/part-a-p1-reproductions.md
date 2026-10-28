# Part A P1 findings: reproductions at origin/main d0229550

Tester: Claude (Sonnet 5.5). Date: 2026-10-27. Target: worktree
`/home/david/Development/ExponetDB-testcampaign`, detached at `d02295503bcfb7a4a4baea860bd9fceebe80b8b4`
(`git status` clean after the session; nothing was written in the worktree). Scratch scripts and raw logs:
`/tmp/claude-1000/-home-david-Development/57931673-29c9-4061-9f45-326970092611/scratchpad/p1/` (`do-single.mts`,
`do-variants.mts`, `do-classify.mts`, `regex.mts`, `regex-fix.mts`, `regex-pipeline.mts`, `mem.mts`, `ledger.mts`,
`mem-*.log`, `ledger-results.log`).

## 0. What the record claims

`exponetdb-docs/14-roadmap/gates/9-part-a.md:988-993` (end of section 9, "Open after this change"):

> the second verification review of follow-up 2 (reported to the owner on 2026-10-22, not part of this order) found
> three P1 that are on `main` and are not fixed here: a single-quoted `DO` body passes the parser's token bound,
> memory adds up across the files of a large history, and the `search_path` check of the guard strictness is a
> quadratic regular expression. They wait for the owner's go-ahead.

So: all three are recorded as **open and not fixed**. The detailed review report is not in the repository; the record is
three clauses. Two readings matter:

- Finding 1 is about the **token bound** (`MAX_PARSE_TOKENS`, V-P1-1), not about SQL splitting, classification or lint.
  I checked the other readings too: `analyzeMigrationSql` classifies `DO '…'` and `DO $$…$$` identically
  (`DoStmt`, `procedural: true`, `coverage: underived`; `do-classify.mts`), so there is nothing wrong there.
- Finding 2 does not say which memory. I measured both candidates: the files of a history (parse, replay, chain) and the
  legacy ledger read from the imported target.

Environment of all numbers: Node v26.5.0 (production is Node 24; the same `--liftoff-only` flag the image uses was
set), Bun 1.3.14 for cross checks, 8 cores. **The host ran at load average 11 to 12** (the repository's own suites ran
concurrently), so absolute times are inflated; ratios are the evidence. PostgreSQL only for the ledger read
(throwaway database `tc_p1_ledger`, created and dropped by me; dropped).

Summary:

| # | Finding | Verdict | Fixed at d0229550? | Regression test? | Suggested severity |
|---|---|---|---|---|---|
| 1 | single-quoted `DO` body passes the token bound | **REPRODUCED** | no | none | **P1** |
| 2 | memory adds up across the files of a large history | **REPRODUCED** (retained memory and a quadratic chain step; no OOM shown inside the legal limits) | no | none | **P2** (memory), **P2** (CPU of the chain step); P1 only if the worker lease does not survive the blocked loop (not tested) |
| 3 | `search_path` check is a quadratic regex | **REPRODUCED** | no | none | **P1** |

---

## 1. Single-quoted `DO` body passes the token bound

### 1.1 Code (file:line at d0229550)

- `packages/postgres/src/parser/lexer.ts:73-92` `countTokens(text, max, mode, bodies)`: with `bodies = true` only a
  `dollar` token is replaced by the tokens of its inner text (`lexer.ts:83`); a `string` token is always one token.
- `packages/postgres/src/parser/parse.ts:62-75` `parsePlpgsql(text)`: the budget is
  `countTokens(text, MAX_PARSE_TOKENS, 'standard', true)` of the **statement text** (`parse.ts:70`), then the whole
  body goes to the PL/pgSQL parser (`parse.ts:72`).
- `packages/postgres/src/parser/parse.ts:115-125` `exceedsParseWork`: descends only into `dollar` tokens
  (`parse.ts:119`), so the early refusal of a legacy file misses a single-quoted body too.
- Callers that hand a `DO` statement to `parsePlpgsql`: `packages/postgres/src/parser/cluster-global.ts:1018`
  (`clusterGlobalStatements`, in the replay summary at plan time in `serve` via `legacy.ts:721`, `legacy-replay.ts:69`,
  and in the worker via `replaysOf`) and `packages/postgres/src/parser/legacy-references.ts:310` (`doBlock`, the
  scratch preflight `legacyReferences`, lines 271 and 344).
- The API gate that should answer `422 too_large`: `packages/migrations-engine/src/legacy-files.ts:15`
  (`refuseOversizedLegacyFiles`, called at `legacy.ts:509` and `packages/application/src/migrations.ts:281`).

Root cause: the bound counts the tokens of the *statement text*, where a `DO` body is one `string` token when it is
single-quoted (`DO '…'`, `DO LANGUAGE plpgsql '…'`, `DO '…' LANGUAGE plpgsql`, `DO E'…'`), but the PL/pgSQL parser
reads the *decoded body*, whatever the quoting. Dollar quoting was handled in V-P1-1 (`97a84110`); the other quoting
was not.

### 1.2 Reproduction (exact SQL, what the code returns, what it should return)

Body: `BEGIN` + `PERFORM 1;` repeated 70 000 times + `END` (210 000 tokens in the body, bound is 200 000).

```
DO $$BEGIN PERFORM 1; … (x70000) END$$;     -- control
DO 'BEGIN PERFORM 1; … (x70000) END';       -- the finding
```

Command (worktree root):
`node --liftoff-only --conditions=@exponetdb/source $SCRATCH/do-variants.mts`

| SQL | `countTokens(sql, MAX, 'standard', true)` | `exceedsParseWork` | `parsePlpgsql` | should be (record, V-P1-1) |
|---|---|---|---|---|
| `DO $$…$$` | 200001 | true | `undefined` (refused) | same |
| `DO '…'` | **3** | **false** | **tree returned** | >200000 / true / `undefined` |
| `DO LANGUAGE plpgsql '…'` | **5** | **false** | **tree returned** | same |
| `DO '…' LANGUAGE plpgsql` | **5** | **false** | **tree returned** | same |
| `DO E'…'` | **3** | **false** | **tree returned** | same |

`refuseOversizedLegacyFiles([{name:'0001_x.sql', text}])` throws `VALIDATION_FAILED` / `too_large` for the dollar form
and **passes** for the single-quoted form (`do-single.mts … count`, 4 190 016 bytes, below the 4 MiB per-file bound).
(Negative control in the same script: a single-quoted string *inside* a dollar body, `EXECUTE '…'`, is also parsed, but
as one expression, so it costs nothing; it is not a bypass.)

### 1.3 Memory (the consequence), PL/pgSQL parse of one `DO '…'` statement

Command: `/usr/bin/time -f "maxrss_kb=%M wall_s=%e" node --liftoff-only --conditions=@exponetdb/source
$SCRATCH/do-single.mts single <n> parse` (n = number of `PERFORM 1;`; baseline of the process with parsers loaded
about 150 MiB).

| `PERFORM 1;` count | statement bytes | VmHWM (MiB) | `/usr/bin/time` maxrss (KiB) | wall (s) | parser given the body? |
|---|---|---|---|---|---|
| 25 000 | 250 016 | 204 | 208 680 | 0.96 | yes |
| 50 000 | 500 016 | 254 | 259 976 | 1.21 | yes |
| 100 000 | 1 000 016 | 365 | 373 580 | 1.22 | yes |
| 200 000 | 2 000 016 | 588 | 602 288 | 1.87 | yes |
| 419 000 | 4 190 016 | **1 114** | **1 141 316** | 3.04 | yes |
| 419 000, dollar-quoted | 4 190 018 | 160 | 163 472 | 1.02 | no (refused) |

Growth is linear in bytes, about 0.23 MiB per KB of body. Through the real call chains: `clusterGlobalStatements(17,
sql, 'none')` 4.19 MB: peak 1 182 MiB, 5.0 s; `legacyReferences(17, [file], …)`: peak 1 208 MiB, 9.3 s and
`tooComplex: false` (it read the whole body; for the dollar form it says `tooComplex: true`). Bun (JSC) shows the same
(`bun --conditions=@exponetdb/source … single 419000 parse`: VmHWM 1 146 MiB). The deployment record's own number for the
same shape before V-P1-1 was 1 144 MiB (`deployment.md` section 2a), so this is the original defect through another door.

In a 512 MiB cgroup (what `serve` and `worker` get, `deployment.md` section 2a):

```
systemd-run --user --scope -q -p MemoryMax=512M -p MemorySwapMax=0 -- \
  node --liftoff-only --conditions=@exponetdb/source $SCRATCH/do-single.mts <shape> 419000 parse
dollar : parsePlpgsql undefined (refused), VmHWM 132 MiB, exit 0
single : killed, exit 137
```

(I could not use `docker run -m 512m`: the Docker daemon does not see the host mounts here; the cgroup scope is the same
kernel mechanism.)

### 1.4 Fixed? Tested?

Not fixed. No test: `grep -rn "DO '" packages/*/test` finds none; the only token-bound test for this class is
`packages/postgres/test/legacy-references.test.ts:208-232` ("gives the parser no more than its token budget … (P1-1)"),
which uses `DO $$…$$` only. Verdict: **REPRODUCED**.

### 1.5 Severity

**P1** (agrees with the record). One request from a caller who may run `migration import analyze` (a 4 MiB file, within
the 4 MiB/8 MiB/1 000-file contract) makes `serve` or the worker allocate 1.1 GB; at the documented 512 MiB limit the
process is killed (exit 137 reproduced) with no log line. It bypasses the control that V-P1-1 accepted as the fix, the
early `422` as well as the late bound.

### 1.6 Proposed fix

1. In `parsePlpgsql` bound the body the PL/pgSQL parser will read, not the statement text: callers already hold the
   `DoStmt` node (`cluster-global.ts:1018`, `legacy-references.ts:310`); take the `defname = 'as'` `String.sval` from
   `node.args` and run `countTokens(body, MAX_PARSE_TOKENS)` on it (the decoded text, so `''` and `E''` escapes are
   resolved by the server grammar rather than guessed by the lexer).
2. For the early refusal (`exceedsParseWork`, which must not parse), treat as a body the `string` token that follows the
   identifier `do` (optionally `language <ident>`) or precedes `language`, decode `''` (and backslash escapes for `E''`),
   and recurse like for a dollar body. Do **not** count every string literal as tokens: a 1 MB JSON literal in an
   `INSERT` is one token to the SQL parser and must stay legal.

### 1.7 Acceptance test

In `packages/postgres/test/legacy-references.test.ts` next to the P1-1 test, for each of the four single-quoted shapes
with a body of `ceil(MAX_PARSE_TOKENS/3)+1` times `PERFORM 1;`:
`countTokens(sql, MAX_PARSE_TOKENS, 'standard', true) > MAX_PARSE_TOKENS`, `exceedsParseWork(sql) === true`,
`parsePlpgsql(sql) === undefined`, `legacyReferences(...).tooComplex === true`, and
`refuseOversizedLegacyFiles` throws `VALIDATION_FAILED` with path `/files/0/text` and code `too_large`.
Negative cases: a 1 000-statement single-quoted `DO` is still parsed; a large ordinary string literal is not refused.
Memory gate (script, like `measure-analyze-memory.ts`): the 4.19 MB `DO '…'` peaks below 200 MiB (the dollar form: 160).

---

## 2. Memory over large histories

The record does not say which memory. I measured the in-process work of a legacy history with the repository's own
functions, step by step as `packages/migrations-engine/src/legacy.ts` runs them (the small private functions
`replaysOf`, `historyStrictness`, `analyzeChain` are copied line for line in `mem.mts`; `fileReplay`,
`survivingGlobals`, `survivingExpectations`, `guardStrictness`, `normalizeSqlSource` and the fixture generator
`largeLegacyHistory` are imported from the repo):

- plan time in `serve` (`legacy.ts:707` `replaySummary`): parse every file, keep counts only;
- worker (`legacy.ts:1707` `replaysOf` keeps one `FileReplay` per file in a `Map`; `legacy.ts:923` `analyzeChain` copies
  every statement into one chain and calls `survivingExpectations` over the whole chain).

### 2.1 Table: files of a history, shaped like the repo's fixture (`largeLegacyHistory`, about 1.3 KB per file)

Command: `node --liftoff-only --expose-gc --conditions=@exponetdb/source $SCRATCH/mem.mts uniform <files>`
(heap values are `heapUsed` after two `gc()`; "peak" is `VmHWM` of the whole process; baseline 100 MiB with parsers
loaded). Files 5 000 and 20 000 are above the API contract (1 000 files, 8 MiB: `packages/contracts/src/rest/migrations.ts:65,722-733`),
reachable only by calling the engine directly; 100 and 1 000 are inside it.

| Files | SQL (MB) | statements | expectations | plan peak RSS (MiB) | retained heap after `replaysOf` (MiB) | overall peak RSS (MiB) | `/usr/bin/time` maxrss | plan step (ms) | `replaysOf` step (ms) | `survivingExpectations` step (ms) | total wall (s) |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 100 | 0.13 | 703 | 2 578 | 117 | 16 | 120 | 122 MB | 138 | 95 | 50 | 0.61 |
| 1 000 | 1.32 | 7 233 | 26 500 | 120 | 29 | 191 | 196 MB | 942 | 758 | **3 114** | 5.53 |
| 5 000 | 6.69 | 36 253 | 132 820 | 147 | 88 | 310 | 317 MB | 4 142 | 3 979 | **196 440** | 210.8 |
| 20 000 | 26.9 | 145 078 | 531 520 | 222 | 301 | 507 at step 5, 670 MB when killed | 670 MB | 12 149 | 17 118 | **not finished in 300 s** (killed, exit 124) | >300 |

Reading:

- **Memory is linear, not worse**: retained heap is about 14.7 KiB per file (about 11 times the SQL text); overall peak
  RSS 120 / 191 / 310 / 507+ MiB. Plan and `replaysOf` times are linear (about 0.6 to 1.4 ms per file).
- **Time is quadratic in the chain** in `survivingExpectations`: 50 ms, 3.1 s, 196 s for 100, 1 000, 5 000 files (x62 for
  x10, x63 for x5; it scales with expectations x statements, about 4.1e7 pairs per second here). 20 000 files: more than
  270 s; extrapolated about 31 minutes. The step runs synchronously in the worker.
- Inside the API contract (1 000 files) the realistic history is fine: 5.5 s, 191 MiB peak.

### 2.2 Does it add up across files? Dense files near the per-file bound

Each file below `MAX_PARSE_TOKENS` (200 000), several of them. Shape `short`: `CREATE TABLE IF NOT EXISTS public.s<i>_<k>
(id int);` (190 008 tokens, 14 616 statements, 43 848 expectations, 0.76 MB per file). The legal maximum of the
contract is 8 MiB, so 9 files fit (6.87 MB). Command: `SKIP6=1 node --liftoff-only --expose-gc
--conditions=@exponetdb/source $SCRATCH/mem.mts short <files> 190000` (the quadratic step 6 is skipped for these runs).

| Files (190k tokens each) | total SQL (MB) | plan step peak RSS (MiB) | heap after `replaysOf` (MiB) | peak RSS after `replaysOf` (MiB) | `/usr/bin/time` maxrss |
|---|---|---|---|---|---|
| 1 | 0.76 | 230 | 56 | 249 | 255 MB |
| 3 | 2.29 | 302 | 99 | 359 | 368 MB |
| 6 | 4.58 | 408 | 162 | 436 | 447 MB |
| 9 | 6.87 | **411** | **220** | **565** | **579 MB** |

(Other shape, `dense` fixture DDL, 122 480 tokens and 0.61 MB per file: plan peak 178 / 221 / 270 / 263 MiB and peak after
`replaysOf` 219 / 242 / 291 / 333 MiB for 1 / 2 / 4 / 8 files.)

So the token bound limits **one parse**, not the sum:

- The WebAssembly side ratchets: the plan step retains nothing (JS heap flat at 21 to 36 MiB) yet the peak RSS goes from
  230 to 411 MiB as files are added, then flattens (WASM memory never shrinks; 100 dense files, 61 MB, out of contract:
  419 MiB). That is the ceiling the 512 MiB limit has to cover in `serve`.
- The retained side is linear: about 19 to 24 MiB of JS heap per 190k-token file, 25 to 29 times the SQL bytes. At the
  legal maximum (9 files) 220 to 226 MiB of heap are retained after `replaysOf`/`analyzeChain`, with **no cgroup**.
  Inside a 512 MiB cgroup Node sets `heap_size_limit` to **268 MiB** (checked), so that is 82 to 84 percent of the heap
  before the chain's own results (`survivors`, `analyses`) are built.
- Under the cgroup (`systemd-run --user --scope -p MemoryMax=512M -p MemorySwapMax=0`) the 6 and 9 file runs
  **survived steps 3 to 5** (peak 323 and 387 MiB; V8 collects harder under a limit). So I could not show an OOM kill
  at the legal maximum. The next step cannot be observed to completion at that size: `survivingExpectations` for 9 files
  (131 544 statements, 394 632 expectations) extrapolates to about 21 minutes of blocked event loop, and the survivors
  and analyses need more heap on top of 226 MiB.

### 2.3 Ledger side: the legacy ledger is read without any bound

`packages/migrations-engine/src/legacy.ts:777-779` (`SUPABASE`): `SELECT … coalesce(to_jsonb(statements), '[]') FROM
supabase_migrations.schema_migrations ORDER BY version`, no `LIMIT`, no byte bound; `readLegacyLedgers`
(`legacy.ts:794-835`) puts every entry with all its statements in an array, and `relateLedger` (`legacy.ts:1071`)
builds `contentKeys` for each. The 8 MiB request cap does not apply (the data come from the imported target).
Command: `node --conditions=@exponetdb/source $SCRATCH/ledger.mts setup <rows>` then
`node --liftoff-only --expose-gc --conditions=@exponetdb/source $SCRATCH/ledger.mts read <rows>` against
`tc_p1_ledger` (rows shaped like the fixture's table files, one array element per statement):

| Ledger rows | statement text (chars) | peak RSS (MiB) | heap after keys (MiB) | read step (ms) | `contentKeys` step (ms) | maxrss (KB) |
|---|---|---|---|---|---|---|
| 100 | 127 786 | 125 | 28 | 52 | 37 | n/a |
| 1 000 | 1.30 M | 141 | 33 | 62 | 122 | 144 196 |
| 5 000 | 6.54 M | 198 | 55 | 153 | 821 | 202 572 |
| 20 000 | 26.3 M | 289 | 138 | 453 | 2 278 | 296 080 |

(baseline of that process 119 MiB RSS, 27 MiB heap.) Linear: about 4 MiB retained heap and 6.5 MiB peak RSS per MB of
ledger statement text. A real Supabase ledger of 556 migrations holds about 2.7 MB, so this is fine for the known case;
it is unbounded in principle (a ledger of 100 MB reaches the V8 limit of a 512 MiB container).

### 2.4 Fixed? Tested?

Not fixed. Tests: `packages/migrations-engine/test/legacy-large.int.test.ts` runs 600 files / 3 MB end to end but its own
comment says memory is not measured there; `packages/migrations-engine/scripts/measure-analyze-memory.ts` is a manual
script (one shape, 600 files) wired into nothing. There is no test of file count, of the sum of tokens, of the chain
step's complexity or of the ledger read. Verdict: **REPRODUCED** as an additive, linear retained-memory growth with a
per-request ceiling that nothing enforces, plus a quadratic CPU step I was not asked about but which dominates
every large history. No OOM kill inside the legal limits was demonstrated.

### 2.5 Severity

- Memory: **P2**. At the contract maximum the retained heap is about 84 percent of the V8 limit of the 512 MiB
  container and the unconstrained peak (565 MiB) exceeds it; the runs I could complete survived. It becomes P1 if a
  second dense shape or the chain step's output pushes it over 268 MiB (likely, not shown).
- `survivingExpectations` over the whole chain: **P2** (CPU): 196 s for 5 000 ordinary files, about 21 minutes for 9
  dense legal files, blocking the worker's event loop. P1 if the operation lease/heartbeat cannot be renewed while the
  loop is blocked (I did not test that).
- Ledger read: **P3** (unbounded, linear, fine for the known size).

### 2.6 Proposed fix

1. Bound the **sum**: in `refuseOversizedLegacyFiles` add a per-request total token budget (for example 600 000 tokens
   over all files, from `countTokens`, linear); the retained heap is proportional to tokens (about 24 MiB per 190k).
2. Do not keep full `StatementFacts` of every file alive: `analyzeChain` (`legacy.ts:923-967`) needs per-statement
   touched keys and expectations only; keep that compact form per file and drop `segments`/`statements` once replayed.
3. Make `survivingExpectations` (`packages/postgres/src/parser/migration.ts:2333-2350`) O(E+S): a single reverse pass
   building `Map<key, lastStatementIndex>` for the exact keys and for the `rel:` keys, then an expectation survives
   iff no later statement touches its keys; remove `touched.slice(i + 1)` per expectation. Also group `survivors` by file
   once instead of `survivors.filter(...)` per file (`legacy.ts:951`). (Not prototyped here: `touchedKeys` and
   `expectationKeys` are module private; the equivalence is by reading `migration.ts:2300-2350`.)
4. Bound the ledger read: a byte cap on the sum of `statements` (or a cursor), failing to `unreadable` with a clear
   code, as the request cap does for files.

### 2.7 Acceptance test

- Unit: `survivingExpectations` on 30 000 generated statements finishes in under 1 s, and equals the old implementation
  on random small inputs (property test, fast-check is a dev dependency of `@exponetdb/postgres`).
- Contract/engine test: 9 files of 190 000 tokens are refused or analysed within a stated budget; a 10 file request over
  the total token budget is `422 too_large`.
- Measurement gate (extension of `measure-analyze-memory.ts`, shape `short` and 9 files): peak RSS after `replaysOf` and
  `analyzeChain` below 350 MiB in a 512 MiB cgroup, step times below 10 s.

---

## 3. Quadratic regular expression for `search_path`

### 3.1 Code

`packages/postgres/src/parser/cluster-global.ts:464`:

```ts
const CATALOG_LATER = /\bsearch_path\b[^;]*?,\s*["']?\s*pg_catalog\b/i
```

used by `guardStrictness` (`cluster-global.ts:467-475`, test at line 470) on the **raw text** of every file. Callers:
`packages/migrations-engine/src/legacy.ts:969-975` `historyStrictness` (once at plan time in `serve`,
`legacy.ts:719`, and once in the worker, `legacy.ts:979`) and `cluster-global.ts:1007` (once per file that parses). It
runs before and independently of any parse, on every submitted file, inside the request's transaction in `serve`.
It is **not replaced** at d0229550 (introduced in `867f1992`).

Two independent super-linear mechanisms, both cubic-to-quadratic backtracking:

- **A. Repetition**: for each occurrence of `search_path` the lazy `[^;]*?` extends to the next `;` (or the end of the
  text) trying the tail at every comma; with no `;` and no `pg_catalog` each of the k occurrences scans the rest of the
  text: O(k x n).
- **B. Whitespace**: after one comma, `\s*["']?\s*pg_catalog` has two adjacent `\s*` with an optional quote between
  them; on a run of m spaces not followed by `pg_catalog` the engine tries all m^2 splits. A single occurrence and a
  single comma suffice.

### 3.2 Reproduction

Command (worktree root; `timeout 60`, `/usr/bin/time -f "wall_s=%e maxrss_kb=%M"`):
`node --conditions=@exponetdb/source $SCRATCH/regex.mts <family> <chars>` (calls the repository's `guardStrictness`).
Families: `ctl` = `SELECT 1; ` repeated (linear control); `rep_term` = `SET search_path = a, b; ` repeated (each ends with
`;`); `one_commas` = `SET search_path = a` + n commas; `one_ws` = `SET search_path =,` + n spaces (mechanism B);
`rep_noterm` = `SET search_path = a, b ` repeated, no `;` (A); `rep_comma` = `search_path,` repeated (A, comma dense);
`rep_pad` = `search_path` + 40 spaces repeated, no comma (A, few tokens per char).
"gate" = passes `refuseOversizedLegacyFiles` (under 200 000 tokens) and the 4 MiB per-file contract.

Time in ms (raw), `TIMEOUT` = killed by the 60 s limit:

| chars | `ctl` | `rep_term` | `one_commas` | `one_ws` (B) | `rep_noterm` (A) | `rep_comma` (A) | `rep_pad` (A) |
|---|---|---|---|---|---|---|---|
| 1 000 | 0.6 | 0.8 | 0.6 | 4.2 | 0.8 | 4.4 | n/a |
| 10 000 | 0.6 | 0.8 | 4.8 | 225.7 | 8 | 8.9 | n/a |
| 30 000 | n/a | n/a | n/a | 1 169.9 | 47.9 | 72.9 | n/a |
| 60 000 | n/a | n/a | n/a | 4 394 | n/a | n/a | n/a |
| 100 000 | 2.6 | 1.6 | 1.9 | **16 840** | 976.5 | 807.6 | 163.6 |
| 200 000 | n/a | n/a | n/a | **35 233** | n/a | n/a | n/a |
| 300 000 | n/a | n/a | n/a | n/a | 3 979.5 | 6 854.5 | 950 |
| 1 000 000 | 4.1 | 4.6 | 24.1 | TIMEOUT | 28 127 | **58 979** | 8 192 |
| 4 194 304 | n/a | n/a | n/a | **TIMEOUT** | n/a | n/a | **TIMEOUT** |

Gate column for 1 000 000 chars: `ctl`, `rep_noterm` fail the token gate (not reachable through the API at that size;
they are included as a measurement of the regex only); `rep_comma` (166 667 tokens), `one_ws` (4 tokens) and `rep_pad`
(19 608 tokens) pass it. `one_ws` and `rep_pad` at the file limit (4 MiB, 4 and about 82 000 tokens) run more than 60 s.

Growth: `rep_noterm` x122 for x10 (10 k to 100 k) and x83 for x10 (30 k to 300 k); `one_ws` x54 and x75 for x10, x3.8
for x2 (30 k to 60 k); `rep_comma` x91 for x10 (10 k to 100 k) and x73 for x10 (100 k to 1 M). That is quadratic
(slightly above for the whitespace family); the controls (`;` terminated, no comma) are linear (4 ms at 1 MB).
Extrapolation of the 100 k point to the 4 MiB file by n^2: `one_ws` about 8 hours, `rep_comma` about 17 minutes.
Bun (JSC) behaves the same: `one_ws` 10 k = 141 ms, 30 k = 1 280 ms; `rep_noterm` 100 k = 517 ms.

Through the real plan-time prefix (`regex-pipeline.mts`: contract schema accepts the file, `refuseOversizedLegacyFiles`
passes, `legacyDigests` ok, `normalizeSqlSource`, then `historyStrictness`): a 50 000 byte file
`SET search_path = ,` + spaces + `;` blocks for 2 525 ms, and the same inside `guardStrictness` called repeatedly:
2 773 to 3 321 ms every time (no caching between calls). The other two regular expressions in `guardStrictness`
(`SHADOWING`, `EQUALS_OPERATOR`) are linear on whitespace, repetition and long-name inputs of 100 000 chars (1 to 4 ms,
`other-regex.mts`).

Should return: `'none'` immediately (there is no `pg_catalog` in these files); it returns `'none'` after minutes to hours.

### 3.3 Fixed? Tested?

Not fixed. `packages/postgres/test/cluster-global.test.ts:560-598` asserts results only (`'all'`, `'none'`,
`'relations'`), never time or size; no test generates a long input. Verdict: **REPRODUCED**.

### 3.4 Severity

**P1** (agrees). The regex is synchronous and cannot be interrupted: one request carrying a 1 MB to 4 MiB file passes
the contract and the token gate and blocks the Node event loop of `serve` (and of the worker on the replay) for a minute
to hours, with the request's database transaction open; recovery is a process restart. Needs a caller with the import
analyze permission, hence not P0.

### 3.5 Proposed fix (prototype validated in scratch)

Replace the regex by a linear scan per statement: for each `\bsearch_path\b`, take the text up to the next `;`, test that
segment once with `,\s*(?:["']\s*)?pg_catalog\b` (same language as `,\s*["']?\s*pg_catalog` but without two adjacent
`\s*`), and continue **after** the `;` (the first occurrence in a segment covers all later ones):

```ts
const WORD = /\bsearch_path\b/gi
const TAIL = /,\s*(?:["']\s*)?pg_catalog\b/i
function catalogLater(text: string): boolean {
  WORD.lastIndex = 0
  for (let m = WORD.exec(text); m !== null; m = WORD.exec(text)) {
    const end = text.indexOf(';', m.index)
    if (TAIL.test(text.slice(m.index + m[0].length, end < 0 ? undefined : end))) return true
    if (end < 0) return false
    WORD.lastIndex = end
  }
  return false
}
```

Validation (`regex-fix.mts`): differential fuzz against the current regex, 300 000 random strings from 17 atoms
(`search_path` in two cases, `,`, `;`, spaces, newline, quotes, `pg_catalog` variants, `.`, `=`): **0 differences** (1 695
positives). Time at 4 194 304 chars on all four adversarial families: `one_ws` 16.8 ms, `rep_noterm` 3.2 ms, `rep_pad`
3.8 ms, `rep_comma` 5.2 ms (versus timeouts above). A tokenizer based variant using `lex()` would be as good; the scan
above is the smaller diff.

### 3.6 Acceptance test

In `packages/postgres/test/cluster-global.test.ts`: (a) the existing semantic cases stay; (b) a differential/property test
(fast-check) of the new function against the old regex on short generated strings; (c) a scaling test that does not
depend on machine speed: for each family (`one_ws`, `rep_noterm`, `rep_comma`, `rep_pad`) the ratio
time(1 MiB) / time(256 KiB) is below 8 (linear is 4, quadratic is 16) and `guardStrictness([text])` at 1 MiB is below
200 ms; (d) assert that a text with `;` after each `search_path` and one with a real `, pg_catalog` still return `'all'`.

---

## 4. Commands, in one place

```
cd /home/david/Development/ExponetDB-testcampaign
S=/tmp/claude-1000/-home-david-Development/57931673-29c9-4061-9f45-326970092611/scratchpad/p1
# 1
node --liftoff-only --conditions=@exponetdb/source $S/do-variants.mts
node --liftoff-only --conditions=@exponetdb/source $S/do-single.mts single 419000 count     # tokens 3, gate false
/usr/bin/time -f "maxrss_kb=%M wall_s=%e" node --liftoff-only --conditions=@exponetdb/source $S/do-single.mts single 419000 parse
systemd-run --user --scope -q -p MemoryMax=512M -p MemorySwapMax=0 -- node --liftoff-only --conditions=@exponetdb/source $S/do-single.mts single 419000 parse   # exit 137
# 2
node --liftoff-only --expose-gc --conditions=@exponetdb/source $S/mem.mts uniform 1000
SKIP6=1 node --liftoff-only --expose-gc --conditions=@exponetdb/source $S/mem.mts short 9 190000
source $S/../testenv.sh; node --conditions=@exponetdb/source $S/ledger.mts setup 20000; node --liftoff-only --expose-gc --conditions=@exponetdb/source $S/ledger.mts read 20000
# 3
timeout 60 node --conditions=@exponetdb/source $S/regex.mts one_ws 100000
node --conditions=@exponetdb/source $S/regex-fix.mts
```

(`testenv.sh` is the session's `.../scratchpad/testenv.sh`, sourced from the worktree root; it exports the control-store URL.
No secret appears in this report. Only the throwaway database `tc_p1_ledger` was created on the control-store container
and it was dropped. No live system was contacted.)

## 5. Not checked

- The real HTTP routes and a real worker lease (the engine functions were called directly with the same call sequence).
- Node 24 exactly (Node 26.5.0 used) and a Docker 512 MiB container (cgroup v2 scope used instead).
- Whether a blocked worker loop loses its operation lease (decides P1 vs P2 of the chain step).
- The fix for `survivingExpectations` is reasoned from the code, not run.
