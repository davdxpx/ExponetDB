# The disposable ExponetDB stack (verification campaign 2026-10-28)

A complete ExponetDB built from one commit on one Ubuntu 24.04 machine, for the engine, failure and
recovery tests. **Never the live installation.** Everything listens on `127.0.0.1`.

| Part | What it is | Kill it with |
|---|---|---|
| Control Store | PostgreSQL 17.11 in Docker (`exstack-control`, port 58432) | `kill_role control` |
| `serve` | the product's own bundle (`node --liftoff-only`) as systemd unit `exstack-serve` (REST, Web App, 58480) | `kill_role serve` |
| `worker` | unit `exstack-worker` (operations loop, tasks) | `kill_role worker` |
| `gateway` | unit `exstack-gateway` (agent listener, mTLS, 58443) | `kill_role gateway` |
| targets | native PGDG clusters 16, 17, 18, named `exdbnode` (55416, 55417, 55418), TLS from a lab CA | `pg_restart pg17 immediate` |
| node agent | the release build, `exponetdb-node` + root helper under systemd, adopted the PG17 cluster | `kill_role agent`, `kill_role helper` |
| owner | the first owner (software passkey, password, TOTP) in `state/owner.json` (0600) | |
| CLI | built from the same commit, signed in as that owner with every scope the CLI may hold | `exdb ...` |

Registry: product `lab`, project `platform`, targets `lab/platform/staging` (PG17, nonprod),
`lab/platform/production` (PG17, **prod**, evidence from staging), `lab/platform/dev16` (PG16),
`lab/platform/dev18` (PG18). The execution role alias `owner` is the NOLOGIN role `lab_owner`.
Services have `Restart=no`: a killed role stays down until the test starts it.

## Use

```bash
# on the server, as root
git clone ... / copy this folder to /srv/work/infra
/srv/work/infra/stack-up.sh              # first time: source + build ~6 min, then ~3 min; later runs ~3 min
source /srv/work/infra/stack-env.sh      # helpers
stack_status
exdb auth status ; exdb target list ; exdb node list
psql_target pg17 -c 'select version()'   # PGDATABASE=lab_staging psql_target pg17 -c '\dt'
/srv/work/infra/stack-down.sh            # back to nothing but the cached source and build
```

Parameters (environment, or `/etc/exstack.env` for a machine): `STACK_NAME` (default `stack`: root dir
`/srv/work/<name>`, unit prefix `ex<name>`), `COMMIT` (full or abbreviated sha; default the commit under test),
`PORT_BASE` (58400), `PG_PORT_BASE` (55400), `AGENT=0` (no node agent: the agent is one per host),
`REPO_SEED` (a local git dir to clone from). A second stack of the **pre-fix** release on another server:

```bash
COMMIT=d0229550 STACK_NAME=old ./stack-up.sh      # on another server; the phases are the same
```

`stack-up.sh --from <phase>` / `--only <phase>` re-runs phases (`preflight src build control pki services targets
owner cli registry agent smoke`). It prints ids and counts, never a secret; the log is `logs/stack-up.log`.
The older commit may lack an endpoint the seed uses (the seed is written against the tree under test): the failing
phase says which; `registry` is the one to adapt.

## Helpers (stack-env.sh)

`exdb` (CLI as the owner), `exdb_json`, `cli_login` (sign the CLI in again with every scope), `human` (act as the
person: `call`, `apply <plan> [--approve]`, `approve <operation>`, `retry-apply <plan> same|new` (Idempotency-Key retry),
`stepup <id> <code>`, `consent <url> <scopes>`), `psql_target pgNN`, `psql_control`, `ctl_sql "SELECT ..."`,
`op_state <operation id>`, `target_id lab/platform/staging`, `stack_id <key>`, `kill_role
serve|worker|gateway|agent|helper|control [SIGNAL]`, `start_role`, `stop_role`, `restart_role`, `restart_cp`,
`pg_restart pgNN immediate|fast|smart`, `stack_status`, `stack_ready`, `journal <role>`.

Test authoring: `new_project NAME`, `mkb DIR SLUG [--nontransactional] < up.sql` (`VERIFY_SQL`, `DOWN_SQL` optional),
`mplan DIR TARGET` (sets `PLAN_ID`, `PLAN_STATE`), `mapply [PLAN] [--no-wait]` (sets `OP_ID`), `ledger pgNN db`,
`add_target SLUG pgNN [prod]` (a fresh environment, database and target in about 8 s: tests that leave a target
blocked take a new one; the list endpoints page at 50, the seed follows the cursor).

Failure injection: `net_block PORT [drop|reject]` / `net_unblock`, `net_delay MS [LOSS%]` / `net_clear` (netem on the
loopback), `clock_jump +-SECONDS` / `clock_restore`, `bloat pgNN db [n]` (n tables, so a verification takes seconds),
`inject_on_state OP STATE "cmd"` (runs `cmd` the moment the operation row shows STATE).

Control Store loss and restore (`control-store-runbook.md` section 3 and RB-10), reusable by other tests:

| Function | Does |
|---|---|
| `cs_dump [file]` | a complete `pg_dumpall` of the Control Store, gzip, mode 0600 (prints path, size, hash) |
| `cs_wipe` | stops the three roles, removes the container **and its data**, starts an empty PostgreSQL 17 with the temporary superuser `restore_admin` (a name none of the exported roles has) |
| `cs_restore file` | feeds the export to the empty server with `psql -U restore_admin -d postgres -v ON_ERROR_STOP=1` |
| `cs_status` | `control-store status` with the runtime login `exdb_serve` (the runbook's check) |

After `cs_restore`: `cs_status`, `audit verify`, then `restart_cp` (runbook steps 3 to 5). The credentials file and
the keyring stay in `state/` (the runbook says to keep both offline, separately from the dump).

## Where things live

`EXSTACK_ROOT` (`/srv/work/stack` by default): `src/` (checkout, with `packages/stack-kit` as a throwaway workspace
package), `build/` (bundle, CLI, agent release), `state/` (0700: credentials, keyring, owner passkey, role
passwords, CLI sign-in, lab CA, `ids.json` with ids only), `control-data/`, `logs/`.

## What the stack is not

- The Control Store speaks plain TCP on the loopback (as the product's own lab does on a private network).
- The PG16 and PG18 clusters are registered as **external** clusters, PG17 is adopted by the node agent
  (`registry.cluster.adopt_agent`, one way). The agent's configuration lists all three instances.
- The targets accept plaintext on loopback in `pg_hba` (the product itself always connects with `verify-full`).
- The owner's passkey is the product's test authenticator; the scripted "human" signs in, re-authenticates and
  approves with it. A real browser flow is not exercised by the stack.
