# Owner test package (Wave 6)

| | |
|---|---|
| Status | **[DECIDED]** Wave 6 (owner order §72); what the owner runs to check the CLI and the migration engine on a disposable installation |
| Commit | the head of `xolo/magical-volta-l6ushu` named in the [G6 record](../14-roadmap/gates/6.md) (§4.6) and the pull request |
| Related | [`install.md`](./install.md), [`lab.md`](./lab.md), [`quickstart.md`](./quickstart.md), [`README.md`](./README.md) (output and exit codes), [`reference.md`](./reference.md) (every command) |

Everything here runs on the owner's own machine against a local lab. Nothing
touches `db.exponet.cloud`, a real node, Coolify or Hetzner. The owner never
needs to query a Control Store table to see whether a step worked: the CLI
and the Web App show it.

## 1. What you need

| | |
|---|---|
| Node.js | 24 (`node --version`); npm |
| Bun | 1.3.14, only to pack the CLI and build the lab image from a checkout |
| Docker | the local daemon (`unix:///var/run/docker.sock`); the lab never uses a remote daemon |
| Browser | one that can create a passkey that verifies you (Windows Hello, a phone, a security key or a password manager). The first owner needs a passkey, a password and an authenticator app: all three. On WSL, open the links in the desktop browser, not in a Linux browser inside WSL |
| Disk, ports | about 3 GB for images and volumes; `127.0.0.1:8480` free (or `--port`) |

Not evidenced in this wave: macOS and Windows hosts (the lab and the CLI ran
on Linux only), a WSL wrapper (the owner's private files were not available).

## 2. Build and install the CLI from the commit

```sh
git clone https://github.com/davdxpx/ExponetDB && cd ExponetDB
git checkout <commit>
bun install --frozen-lockfile
bun run --cwd apps/cli pack                       # dist/artifacts/exponetdb-cli-0.6.0.tgz and .sha256
cd apps/cli/dist/artifacts && sha256sum -c exponetdb-cli-0.6.0.tgz.sha256 && cd -
npm install --global --offline apps/cli/dist/artifacts/exponetdb-cli-0.6.0.tgz
exponetdb --version                               # version, commit, build time; no network
```

The tarball carries its parser assets and no workspace paths
([`install.md`](./install.md)). `exponetdb doctor` checks Node, the parsers
for PostgreSQL 16, 17 and 18, the token store and, with a profile, the server.

## 3. Start a lab and walk the quickstart

```sh
exponetdb dev up --lab demo          # builds the image at this commit, starts control, staging, production, serve, worker, gateway
exponetdb dev test smoke --lab demo  # every role, TLS on both targets, probes, no secrets in logs
```

Then follow [`quickstart.md`](./quickstart.md) from step 3: the first owner,
the CLI sign-in, a product with staging and production, two clusters with
ExponetDB's roles and their passwords (entered in the Web App, never on the
command line), two targets, a migration authored locally, applied and
verified on staging, then promoted to production after a step-up and your
own approval.

The same walk runs as an automated acceptance test with the installed CLI and
a real Chromium with a virtual passkey:

```sh
EXDB_CLI_BIN="$(command -v exponetdb)" EXDB_LAB_IMAGE=<image> \
  EXDB_QUICKSTART_TRANSCRIPT=/tmp/quickstart.json EXDB_QUICKSTART_EXPORTS=/tmp/quickstart-exports \
  bun run --cwd apps/server test:lab
```

`<image>` is the lab image `dev up` built (`docker images exponetdb-lab`).
The transcript holds every command with its exit code and output; the export
holds every role's log.

## 4. What you should see

| Step | Expected result |
|---|---|
| `dev up`, `dev status` | every role `running`/`ready`; exit 0 only when ready |
| `login --scope …` | the consent page lists each scope; production scopes need the production box ticked |
| `product list`, `target list` on an empty installation | an empty table and exit 0: an empty list is a valid answer |
| `cluster register … --apply` | a step-up link and code on the terminal; after your passkey the CLI continues by itself |
| `cluster credential submit <cluster> <role>` | opens the Web App's password form; the CLI waits until the worker signed in with it (`active`) |
| `target register … production … --apply --yes` | waits for your approval in the Web App (a self-approval is shown as such) |
| `migration lint`, `checksum`, `graph` | the server's analysis and checksum byte for byte, offline |
| `plan apply <plan> --wait` | exit 0 only when applied **and** verified; the ledger row is in `migration status` |
| production `plan apply … --wait --yes` | step-up in the browser; the evidence bound is the staging run that passed |
| `audit list --action migration.apply` | one event per applied migration, with its checksum |

## 5. Refusals that are intended

| You do | You get | Why |
|---|---|---|
| a bundle declared additive that drops a table | `migration lint` exit 1, `MIGRATION_LINT_BLOCKED` (`compatibility_understated`) | the declared compatibility must not understate the change |
| plan production before staging verified it | plan `deny`: evidence required | production needs the same checksum applied and verified on its evidence environment (C-15); there is no override setting |
| `--yes` on a production apply | still the step-up, and the approval where policy wants it | `--yes` is a local confirmation only |
| break-glass activation | `BREAK_GLASS_UNAVAILABLE` without a notification channel | OD-21 is open; the installation default has no channel |
| a password on the command line | there is no such flag | role passwords go to the Web App form; `secrets scram-verifier` reads a hidden prompt or stdin |
| remote `sql`, `exec`, `ssh` | no such command | no generic shell or SQL path (`dev sql` is the local lab only) |
| change the target ledger by hand | the next plan: `LEDGER_DIVERGENCE` naming the rows | the ledger is compared with the mirror on every plan |
| an operation's planner loses their role meanwhile | `GRANT_REVOKED`; what ran stays applied and verified | authority is re-checked before each migration (E27) |
| a verification that could not run | `needs_attention`; `operation retry-verification` later | the change never runs again; only its verification |

## 6. Open findings you should know about

- **G5 is not accepted.** Its systemd items need the owner's VM or the CI job
  `node-pg`; nothing in Wave 6 replaces that evidence.
- **CI runners did not start** for this branch (nor on `main`) during the
  session; every suite named in the G6 record ran here, in containers.
- **E16 and E18** (a production hotfix without staging evidence; a migration
  removed from source after it was applied) have no detection yet.
- **E25** (restore to an earlier point) has no restore operation before the
  backup waves; a restored ledger reads as `LEDGER_DIVERGENCE`.
- **`ledger.reconcile`** and **`operation.force_release`** are planned, not
  implemented: a divergence is resolved by undoing the hand change; an
  operation whose outcome stayed unknown keeps its domain.
- The Web App shows `needs_attention` but has no "verify again" button; the
  CLI and the REST API do.
- No node runs in the lab (the agent needs root and systemd); node scenarios
  run with `dev test host:<scenario>` on a disposable systemd host.

## 7. Where the evidence is

| What | Where |
|---|---|
| a role's log | `exponetdb dev logs <role> --lab demo` |
| a test run of the lab | `exponetdb dev runs --lab demo`, `exponetdb dev logs --run <run>` |
| everything of a lab, kept after `destroy` | `exponetdb dev export --lab demo` (`<config dir>/lab-exports/`) |
| an operation, its steps and per-migration outcome | `exponetdb operation show <operation>` |
| what happened, by whom | `exponetdb audit list` (`--action`, `--target`) |
| the G6 evidence matrix | [`../14-roadmap/gates/6.md`](../14-roadmap/gates/6.md) |
