# Notes of tester S3: changes to the kit, traps, things that cost time

S1 owns `D/infra`; nothing there was edited. My copy lives on `vc-1` in `/srv/work/s3-infra` (`kit-s3.patch` is the diff against `D/infra`,
`s3.env` and `lib.sh` are the glue). Stack name `s3` (units `exs3-*`, cluster name `exs3`, ports 59400 and 56400, root `/srv/work/s3`), the
build of the commit under test is a second tree `s3new` (`build-new.sh`: `stack-up.sh --only preflight|src|build`, no services).

## Changes to my copy of the kit

| File | Change | Why |
|---|---|---|
| `stack-env.sh` | `EXSTACK_SRC`, `EXSTACK_BUILD`, `EXSTACK_BUNDLE`, `EXSTACK_CLI_BIN`, `EXSTACK_KIT` accept an environment override (`${X:-default}`) | one shell must drive the old and the new build (`s3_release old|new` in `lib.sh`) |
| `stack-up.sh` | `phase_agent` creates `/var/lib/exponetdb-node` (0700, agent user) before `exponetdb-node enroll` | the agent package of `d0229550` has no tmpfiles entry for it; `enroll` died with `state directory: lstat ...: no such file or directory`. The package of `d51da5d0` has the entry (comment in its `exponetdb-node.conf`: test campaign TC-039). Not a product finding for the new release; it is why `--from agent` had to be re-run |
| `lib.sh` (mine) | `ro()` and `cs_status()` run `control-store status` / `audit verify` with only `EXPONETDB_CONTROL_STORE_URL` of `exdb_serve` | the kit's `cs_status` uses `env/operator-serve.env`, which carries `EXPONETDB_PUBLIC_URL`; the new release refuses it for the read-only commands (`Configuration refused: EXPONETDB_PUBLIC_URL (not_used_by_readonly_store)`), and `audit verify` refuses `EXPONETDB_KEYRING` the same way. S1's `cs_status` fails on `d51da5d0` |
| `human.ts` | **not changed**; call the confirm route yourself: `human call POST /api/v1/step-ups/<id>/confirm '{"userCode":"<code>"}'` | the kit's `human stepup <id> <code>` sends `{"code":...}`; the new release wants `userCode` (HTTP 422 `/userCode invalid_type`). It worked on the old release |

## Traps found while building the state

* `inject_on_state OP verifying cut_target` (the I9 recipe) does **not** park an *apply* in `needs_attention`: the verification of a plain
  apply is milliseconds wide, even with 2,142 tables (`bloat` aborts at about 2,100 tables in one call: `out of shared memory`,
  `max_locks_per_transaction`). The recipe works for a **rollback** operation (`DOWN_SQL`), whose verification reads the fingerprint of a
  bloated catalog: `10-state.sh` uses that (`apply=applied verify=error kind=migration.rollback`).
* A `verify.sql` with `pg_sleep(20)` is refused by the plan (`PLAN_DENIED`, lint); a table held `ACCESS EXCLUSIVE` by a side session blocks
  even the plan (`QUERY_TIMEOUT`: the product's catalog read waits on it).
* A production plan of three bundles with a foreign key is `deny` (lint errors on prod, lock severity high, no staging fingerprint
  lineage); one plain bundle planned `--stored` after a staging apply is `require` (one approval): that is the `awaiting_approval` recipe.
* `plan apply --yes --json` on a plan that needs a **step-up** waits **silently** (no address, no code, nothing on stderr); the first attempt
  hung 7 minutes. The text mode prints `Open http://.../step-up#id=... Code: ...`. See the finding.
* `add_target SLUG` after a Control Store restore: the cluster still has the database `lab_<slug>` from before the restore, so a slug used
  before the restore fails; use a new slug.
* After any restore the CLI says `UNAUTHENTICATED ... revoked or expired`; `cli_login` (kit) signs in again.
* The Control Store container started by the kit's `cs_wipe` uses `restore_admin`; once that container is the production store, the next
  `pg_dumpall` contains the role `restore_admin`, and `cs_wipe` plus `cs_restore` fail with `role "restore_admin" already exists`. Pass another
  superuser name to `control_container_start` (the runbook text says "different from every role in the saved export"; see the finding).
* `CREATE TABLE ... (id serial PRIMARY KEY ...)` cannot be applied (finding); the state uses `int` keys.

## Not mine

The older exdbnode clusters (55416 to 55418) and the containers `exdb-target-*`, `exdb-s3`, `exdb-pg17` that agent A left on `vc-1` were
removed (`docker rm -f`, `docker volume prune`) or stopped and disabled (`postgresql@NN-exdbnode`, not dropped).
