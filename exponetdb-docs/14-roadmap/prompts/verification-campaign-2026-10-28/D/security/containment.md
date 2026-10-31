# I14 host containment (Block D, tester S4)

Tree `d51da5d0`, a fresh nonprod target (`lab/platform/s4cont`, PG17, adopted by the node agent) planned and applied through the
CLI as the owner; a second target (`s4evi`) on the same cluster stood by as the "other target". `scripts/containment.sh` lists the
statements; the host and the other target were checked after every case (a marker file under `/tmp`, a table in the other
database, a table owned by the superuser, the migrator's and the role catalog's flags).

**Result: nothing reached the host or the other target. No P0.** One run of the first campaign's finding class (statements that the
lint does not forbid) is a P3 below. The statements are not repeated here beyond their case names.

## Cases (18)

| Case | Plan | Apply | Host / other target |
|---|---|---|---|
| 01 COPY to a program | denied, `forbidden_statement` | not run | none |
| 02 COPY from a program | denied, `forbidden_statement` | not run | none |
| 03 read a server file with `pg_read_file` | **allowed** (warning only) | failed at the database, `MIGRATION_EXECUTION_FAILED`, `not_applied` | none |
| 04 `lo_import` of a server file | **allowed** | failed at the database, `not_applied` | none |
| 05, 06 `CREATE EXTENSION` of an untrusted-language extension | denied, `forbidden_statement` | not run | none (the extensions are not installed either) |
| 07 `ALTER SYSTEM` | denied | not run | none |
| 08 `dblink` to the other target | denied | not run | none |
| 09 `postgres_fdw` to the other target | denied | not run | none |
| 10 psql `\connect` meta text | denied, `parse_error` | not run | none |
| 11 `SET ROLE` to the superuser | denied | not run | none |
| 12 `SET SESSION AUTHORIZATION` | denied | not run | none |
| 13 drop the `exponetdb` schema | denied | not run | none |
| 14 write a ledger row directly | denied | not run | none |
| 15 truncate the ledger | denied | not run | none |
| 16 give the migrator superuser or a program-execution role | denied | not run | none |
| 17 create a superuser role | denied | not run | none |
| 18 a function in an untrusted language | **allowed** (warning `function_search_path_mutable`) | failed at the database, `not_applied` | none |

"Denied" is a stored plan with decision `deny`, state `denied`, failing rule `migration.lint-errors`
(`forbidden_statement`, `parse_error`). The refusal is audited: the denied plan has `plan.created phase=denied actor=human`; the
three allowed cases have `plan.created`, `operation.accepted`, `operation.state_changed`, `migration.failed` (actor `system:worker`
for the last two). The CLI says `PLAN_DENIED` / `MIGRATION_EXECUTION_FAILED`; the lint table names the rule per statement. The
database-side message of the three failed applies is not in the operation view (only the code), so an operator has to read the
target's log to learn why.

The only reason 03, 04 and 18 are contained is that the execution role lacks `pg_read_server_files`, superuser and the language.
On a target whose migrator is more privileged (the Supabase-origin schemas the product is aimed at) the same plans would be
allowed and would run: finding 7.

## Giant and hostile input, with CPU and memory (serve + worker, `ps` samples at 50 ms)

| Input (up.sql) | Size | Result | CPU serve+worker | serve RSS |
|---|---:|---|---:|---|
| 60,000 one-line statements | 829 KB | plan **fails `INTERNAL`** after 4.7 s | 5 s | 256 -> **878 MiB**; 880-887 MiB for the next three cases, 660-705 MiB afterwards |
| 20,000 nested parentheses | 40 KB | plan denied in 0.6 s | under 1 s | 878 -> 880 MiB |
| 50,000 nested block comments, closed | 200 KB | plan **30.5 s, then `TRANSPORT_FAILED`** (no answer) | **31 s** | 880 -> 884 MiB |
| a 950 KB string literal | 950 KB | plan allowed in 6.2 s | 6 s | 884 -> 887 MiB |
| a 30,000-term expression | 120 KB | denied in 0.8 s | under 1 s | 662 -> 677 MiB |
| a 40,000-statement `DO` block | 440 KB | denied in 0.8 s | under 1 s | +28 MiB |
| a symlinked `up.sql` | n/a | `MIGRATION_BUNDLE_INVALID` (links are not followed) | n/a | n/a |
| a symlinked bundle directory | n/a | `VALIDATION_FAILED ... is not a directory (links are not followed)` | n/a | n/a |
| a bundle directory that is a link out of the tree | n/a | refused by the CLI (links are not followed); names on the wire are constrained by `BundleSubmissionSchema` (`<ULID>_<slug>`); no traversal name was sent | n/a | n/a |

The two expensive cases are reachable by anyone who may plan (a developer, an agent over MCP with `migrations.plan`): 200 KB of
nested comments holds the server at full CPU for half a minute and the caller gets no answer; 829 KB of statements raises the
server's resident memory by 620 MiB and ends in an `INTERNAL` answer. The limits are not named (I15): the answer
should be a limit code such as the documented size and statement-count errors. Finding 4.

Idle baseline for comparison: a plan of a normal 2-line bundle costs 0.1 to 0.9 s CPU and does not move the resident size
(256 MiB serve, 213 MiB worker); a 28 MiB body costs 130 to 210 MiB for 0.3 s (authz-run.md).

## Not run

- Cross-target reach through a role the migrator could be tricked into (it needs a privileged migrator; the lab's migrator is not).
- Crash of serve or worker under the two expensive inputs (the processes survived both; neither was killed by the kernel).
