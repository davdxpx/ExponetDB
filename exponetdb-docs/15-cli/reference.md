# `exponetdb` command reference

<!-- Generated from the command registry (apps/cli/src/commands). Do not edit by hand:
     run `bun run --cwd apps/cli reference` and commit the result. -->

Every command, generated from the registry: what it does, whether it runs
locally or against the server, what it changes, the action and scopes it
needs, its arguments and flags. Global flags, the output contract and the
exit codes are in [`README.md`](./README.md).

| Command | Runs | Effect | Summary |
|---|---|---|---|
| [`help`](#help) | local | local | Show help for a command or group. |
| [`version`](#version) | local | local | Show the CLI version and build (no network). |
| [`commands`](#commands) | local | local | List every command with its group, locality and effect. |
| [`completion`](#completion) | local | local | Print a shell completion script (bash, zsh or fish). |
| [`doctor`](#doctor) | remote | read | Check the CLI, its private files, the server, the sign-in, the project and the parser (no changes). |
| [`agent-help`](#agent-help) | local | local | How an automated agent uses the CLI safely, with the full command reference (Markdown). |
| [`login`](#login) | remote | session | Sign in through the browser (or the device flow) and store the tokens privately. |
| [`logout`](#logout) | remote | session | Revoke the grant on the server, then delete the local tokens. |
| [`whoami`](#whoami) | remote | read | Show the server, its version and the sign-in in use (one authenticated request). |
| [`auth status`](#auth-status) | local | local | List the servers this CLI holds a sign-in for (local; no network, no token shown). |
| [`auth presets`](#auth-presets) | local | local | List the named scope presets of exponetdb login --preset (local). |
| [`auth scopes`](#auth-scopes) | local | local | List the OAuth scopes the CLI can ask for, and which need the browser. |
| [`auth reauth`](#auth-reauth) | remote | session | Confirm a step-up in the browser now, for a plan to apply or an enrollment token to reveal. |
| [`profile list`](#profile-list) | local | local | List profiles (local). |
| [`profile show`](#profile-show) | local | local | Show a profile (default: the current one). |
| [`profile add`](#profile-add) | local | local | Add or replace a profile (local; no token is stored in it). |
| [`profile use`](#profile-use) | local | local | Make a profile the current one. |
| [`profile remove`](#profile-remove) | local | local | Remove a profile (its sign-in stays until exponetdb logout). |
| [`config path`](#config-path) | local | local | Show where the CLI keeps its private files. |
| [`config show`](#config-show) | local | local | The current profile’s defaults and the CLI’s private paths (local). |
| [`config set`](#config-set) | local | local | Set a default of the current profile (output or target). |
| [`config unset`](#config-unset) | local | local | Remove a default of the current profile. |
| [`init`](#init) | local | local | Create exponetdb.project.yaml and a migrations directory in the working directory (nothing is overwritten). |
| [`project validate`](#project-validate) | local | local | Validate the project file and read every bundle root (local). |
| [`project link`](#project-link) | remote | local | Link the project to the current server and profile, after checking the project exists there. |
| [`project unlink`](#project-unlink) | local | local | Remove the project’s link to a server (local). |
| [`project context`](#project-context) | local | local | Where every setting of this invocation comes from: server, profile, project, output (local). |
| [`product list`](#product-list) | remote | read | List products. |
| [`product show`](#product-show) | remote | read | Show a product. |
| [`product create`](#product-create) | remote | plan | Plan a new product. |
| [`environment list`](#environment-list) | remote | read | List the environments of a product, in rank order. |
| [`environment show`](#environment-show) | remote | read | Show one environment of a product. |
| [`environment create`](#environment-create) | remote | plan | Plan a new environment of a product. |
| [`environment update`](#environment-update) | remote | plan | Plan a change of an environment (name, tier, rank, evidence source). |
| [`project list`](#project-list) | remote | read | List projects. |
| [`project show`](#project-show) | remote | read | Show a project and its managed scope. |
| [`project create`](#project-create) | remote | plan | Plan a new project of a product. |
| [`project update`](#project-update) | remote | plan | Plan a project change (name, managed scope, execution roles, trusted extensions). |
| [`project execution-roles`](#project-execution-roles) | remote | read | Show a project's execution roles: the default map, each environment's bindings and the declared exceptions. |
| [`project execution-roles set`](#project-execution-roles-set) | remote | plan | Plan one environment's execution roles (aliases of the project map bound to other roles); the set replaces the environment's bindings. |
| [`project role-exception declare`](#project-role-exception-declare) | remote | plan | Plan a declared exception: one role may carry BYPASSRLS as an execution role of the project in one environment (nothing else is ever excused). |
| [`project role-exception revoke`](#project-role-exception-revoke) | remote | plan | Plan the revocation of a declared exception; every plan that relied on it becomes stale. |
| [`target list`](#target-list) | remote | read | List targets with tier, state and health. |
| [`target show`](#target-show) | remote | read | Show a target: placement, ledger, health, findings. |
| [`target register`](#target-register) | remote | plan | Plan registering a database of a cluster as a target of a project environment. |
| [`target suspend`](#target-suspend) | remote | plan | Plan to suspend a target (with a reason). |
| [`target resume`](#target-resume) | remote | plan | Plan to resume a target (with a reason). |
| [`target decommission`](#target-decommission) | remote | plan | Plan to decommission a target (with a reason). |
| [`server list`](#server-list) | remote | read | List servers. |
| [`server show`](#server-show) | remote | read | Show a server and the facts its node reported. |
| [`server retire`](#server-retire) | remote | plan | Plan retiring a server record (registry.md §4.4): only when every cluster on it is retired, every node decommissioned and no job or token is open; the machine is not touched. |
| [`server create`](#server-create) | remote | plan | Plan a server record. |
| [`cluster list`](#cluster-list) | remote | read | List clusters. |
| [`cluster show`](#cluster-show) | remote | read | Show a cluster. |
| [`cluster endpoints`](#cluster-endpoints) | remote | read | List the endpoints of a cluster. |
| [`cluster databases`](#cluster-databases) | remote | read | List the registered databases of a cluster. |
| [`cluster credentials`](#cluster-credentials) | remote | read | List credential metadata of a cluster (never a secret). |
| [`cluster bootstrap-sql`](#cluster-bootstrap-sql) | remote | read | Write the cluster’s bootstrap SQL (roles, grants) to stdout or a new file, for a DBA to review and run. |
| [`cluster register`](#cluster-register) | remote | plan | Plan registering a PostgreSQL cluster (endpoints and CA bundle from --file). |
| [`cluster confirm`](#cluster-confirm) | remote | plan | Plan confirming a cluster’s identity (its system identifier). |
| [`cluster endpoint add`](#cluster-endpoint-add) | remote | plan | Plan a new endpoint of a cluster. |
| [`cluster endpoint retire`](#cluster-endpoint-retire) | remote | plan | Plan retiring an endpoint. |
| [`cluster database retire`](#cluster-database-retire) | remote | plan | Plan retiring a registered database record that is no current placement (decommission its target first); the database itself is not touched. |
| [`cluster retire`](#cluster-retire) | remote | plan | Plan retiring a cluster record with its endpoint and credential records (registry.md §4.4): only when no database is registered on it; nothing changes on the PostgreSQL cluster. |
| [`cluster declare-tier`](#cluster-declare-tier) | remote | plan | Plan declaring the tier a cluster is meant for (OD-22): prod makes every database registered on it need production authority; nonprod leaves it to the environment. |
| [`cluster database register`](#cluster-database-register) | remote | plan | Plan registering a database of a cluster. |
| [`cluster credential submit`](#cluster-credential-submit) | remote | read | Open the Web App’s write-only form for a role’s password, then wait until the worker verified it. |
| [`cluster credential rotate`](#cluster-credential-rotate) | remote | plan | Plan rotating a cluster credential through the node (a new SCRAM verifier, set locally). |
| [`node list`](#node-list) | remote | read | List nodes with state, heartbeat and agent version. |
| [`node show`](#node-show) | remote | read | Show a node: state, heartbeat, certificate, clusters and capabilities. |
| [`node status`](#node-status) | remote | read | The node’s state with its source and time (pending_binding, active, offline, revoked …). |
| [`node capabilities`](#node-capabilities) | remote | read | The capabilities a node offers, and whether this CLI supports each version. |
| [`node observations`](#node-observations) | remote | read | The latest node-signed observations of a node. |
| [`node inspect`](#node-inspect) | remote | plan | Run one read or plan capability on a node and wait for its signed result. |
| [`node postgres reload`](#node-postgres-reload) | remote | plan | Plan a PostgreSQL reload on a node. |
| [`node postgres restart`](#node-postgres-restart) | remote | plan | Plan a PostgreSQL restart on a node (through its helper). |
| [`node postgres config`](#node-postgres-config) | remote | plan | Plan PostgreSQL parameter changes (managed parameters only; secrets stay references). |
| [`node postgres hba`](#node-postgres-hba) | remote | plan | Plan the managed pg_hba rules (from --file). |
| [`node postgres roles`](#node-postgres-roles) | remote | plan | Plan role steps (from --file; passwords only as SCRAM verifiers). |
| [`node postgres extensions`](#node-postgres-extensions) | remote | plan | Plan extension steps (from --file). |
| [`node postgres tls`](#node-postgres-tls) | remote | plan | Plan rotating the server TLS certificate (from --file: names and validity). |
| [`node job-keys`](#node-job-keys) | remote | plan | Plan adding or retiring job-signing keys a node trusts. |
| [`node revoke`](#node-revoke) | remote | plan | Plan revoking a node (the gateway refuses it at its next request). |
| [`node decommission`](#node-decommission) | remote | plan | Plan decommissioning a node. |
| [`node enrollment create`](#node-enrollment-create) | remote | mutation | Enroll a node for a server: plan, apply, reveal the token once into a new private file. |
| [`node enrollment status`](#node-enrollment-status) | remote | read | The nodes of a server and their enrollment state (until active). |
| [`node enrollment instructions`](#node-enrollment-instructions) | local | local | How to enroll the host with a token file (and the token’s public trust metadata). |
| [`migration new`](#migration-new) | local | local | Create a new bundle directory (<ULID>_<name>) with migration.yaml, up.sql and verify.sql. |
| [`migration lint`](#migration-lint) | local | local | Lint the local bundles with the PostgreSQL parser (offline facts; exit 1 on a blocking finding). |
| [`migration checksum`](#migration-checksum) | local | local | The apply checksum and digests of each local bundle (sha256:c1:…), as the server computes them. |
| [`migration graph`](#migration-graph) | local | local | The dependency graph of the local stream: order, heads and errors (no server). |
| [`migration status`](#migration-status) | remote | read | The target’s ledger, read live: applied (with verification) and pending migrations. |
| [`migration show`](#migration-show) | remote | read | One migration on a target: state, events, verification runs. |
| [`migration evidence`](#migration-evidence) | remote | read | The verification evidence of a migration on a target (what production promotion binds). |
| [`migration plan`](#migration-plan) | remote | plan | Plan migrations for a target from the local bundles (or stored ones): analysis, policy, evidence. |
| [`migration apply`](#migration-apply) | remote | mutation | Plan and apply migrations, then wait until applied and verified (exit 0 only then). |
| [`migration verify`](#migration-verify) | remote | mutation | Run a migration’s verification again on a target and wait for its result. |
| [`migration resume`](#migration-resume) | remote | plan | Plan resuming a non-transactional migration that stopped part-way (an explicit new plan). |
| [`migration rollback`](#migration-rollback) | remote | plan | Plan rolling back the latest migration with its down.sql (an explicit new plan; never automatic). |
| [`migration import analyze`](#migration-import-analyze) | remote | plan | Plan a legacy import analysis: replay the legacy files on a scratch target and classify them. |
| [`migration import scratch-reset-sql`](#migration-import-scratch-reset-sql) | remote | read | Print the SQL that resets a used scratch target in place (run it with psql -v ON_ERROR_STOP=1 as a superuser on that database): it keeps the database and its identity marker and recreates the managed schemas with their grants and extensions. |
| [`migration import scratch-check`](#migration-import-scratch-check) | remote | read | Check, read only, whether a scratch target can take this target’s legacy replay: usable, its identity, empty, the same extensions, the objects outside the managed scope, the execution role; in a project with a legacy directory also what its files reference outside the scope. |
| [`migration import scratch-copy-commands`](#migration-import-scratch-copy-commands) | remote | read | Print the shell commands that copy, schema-only and without triggers, the schemas outside the managed scope the scratch target lacks objects of from the imported target (pg_dump and pg_restore; set IMPORTED_URL and SCRATCH_URL). |
| [`migration import report`](#migration-import-report) | remote | read | An import report: every legacy file’s classification and the decisions so far. |
| [`migration import resolve`](#migration-import-resolve) | remote | mutation | Record your decision for one item of an import report (with a note). |
| [`migration import baseline`](#migration-import-baseline) | remote | plan | Plan the baseline of a resolved import report (records the legacy ledger; changes no schema). |
| [`migration ledger reconcile`](#migration-ledger-reconcile) | remote | plan | Plan adopting the target’s ledger as the truth after a restore or a hand change; the mirror rows that differ move to a history, no row is deleted. |
| [`plan show`](#plan-show) | remote | read | Show a plan: subject, decision, requirements, content and analysis. |
| [`plan list`](#plan-list) | remote | read | List plans you may read, newest first (filter by target, kind, state). |
| [`plan export`](#plan-export) | remote | read | Write a plan as JSON (to stdout, or to a new private file with --file). |
| [`plan apply`](#plan-apply) | remote | mutation | Apply a stored plan and wait until it is applied and verified. |
| [`plan withdraw`](#plan-withdraw) | remote | mutation | Withdraw your own active plan (it can no longer be applied). |
| [`operation list`](#operation-list) | remote | read | List operations you may read, newest first. |
| [`operation show`](#operation-show) | remote | read | Show an operation: state, apply and verification outcomes, steps and migrations. |
| [`operation watch`](#operation-watch) | remote | read | Watch an operation until it is final (exit 0 only when applied and verified). |
| [`operation cancel`](#operation-cancel) | remote | mutation | Cancel an operation that has not started (awaiting approval or queued). |
| [`operation retry-verification`](#operation-retry-verification) | remote | mutation | Verify again an operation that needs attention after an applied change. |
| [`approval list`](#approval-list) | remote | read | List operations awaiting approval that you may read. |
| [`approval show`](#approval-show) | remote | read | Show what an approval decides: the operation, its plan and the plan hash. |
| [`approval open`](#approval-open) | remote | read | Open the bound approval page in the browser. |
| [`approval approve`](#approval-approve) | remote | read | Open the approval page to approve (re-authentication there), then wait for the decision. |
| [`approval reject`](#approval-reject) | remote | read | Open the approval page to reject (re-authentication there), then wait for the decision. |
| [`health`](#health) | remote | read | A target’s health: probes, conditions, node and backups, with source and time. |
| [`finding list`](#finding-list) | remote | read | Findings across the targets you may read (drift, health, advisors, statements), open by default. |
| [`finding summary`](#finding-summary) | remote | read | Counts of the open findings you may read, by severity, kind and code. |
| [`cluster findings`](#cluster-findings) | remote | read | Findings of a cluster (backups and other cluster-level findings), open by default. |
| [`finding show`](#finding-show) | remote | read | One finding of a target. |
| [`schema overview`](#schema-overview) | remote | read | The schemas of a target with object counts, its fingerprint and what is visible. |
| [`schema search`](#schema-search) | remote | read | Search a target’s catalog by name. |
| [`schema show`](#schema-show) | remote | read | One catalog object: columns, constraints, indexes, grants, policies (definitions are untrusted text). |
| [`schema fingerprint`](#schema-fingerprint) | remote | read | A target’s schema fingerprint (what plans and evidence bind). |
| [`schema diff`](#schema-diff) | remote | read | Compare two targets (or a target and a fingerprint) object by object. |
| [`drift check`](#drift-check) | remote | plan | Run a drift check of a target now (expected vs. live schema). |
| [`diagnose query-stats`](#diagnose-query-stats) | remote | read | Normalized statements of a target with calls, time, rows and I/O over a window (pg_stat_statements). |
| [`diagnose table-stats`](#diagnose-table-stats) | remote | read | Table and index sizes, scans, vacuum state, estimated bloat and transaction id age of a target. |
| [`diagnose advisors`](#diagnose-advisors) | remote | read | Run the live advisors of a target (read-only): security, performance, operations, change safety. |
| [`session list`](#session-list) | remote | read | Sessions of a target with redacted statements (the pid and start times the session actions take). |
| [`session cancel`](#session-cancel) | remote | mutation | Cancel a session’s running query (inline, low): only while the same backend runs the same query. |
| [`session terminate`](#session-terminate) | remote | plan | Plan terminating a session, bound to its pid and backend start; the condition is re-checked when it is terminated. |
| [`backup overview`](#backup-overview) | remote | read | Backup protection of every cluster you may read: state, measured RPO, last verified backup and drills. |
| [`backup list`](#backup-list) | remote | read | A cluster’s backups from the catalog mirror, with its protection, repositories and WAL coverage. |
| [`backup repositories`](#backup-repositories) | remote | read | The backup repositories of a cluster: ownership, lock capability, engine advisory and reconciliation. |
| [`backup policy show`](#backup-policy-show) | remote | read | The active backup policy of a cluster: schedules, retention, objectives, drill cadence. |
| [`backup runs`](#backup-runs) | remote | read | Engine runs of a cluster: backups, verifies, expiry, restores and discards. |
| [`backup adopt`](#backup-adopt) | remote | plan | Plan adopting an existing backup repository for read-only observation (nothing changes on the host or in the bucket). |
| [`backup ownership`](#backup-ownership) | remote | plan | Plan what ExponetDB may do with an adopted repository (adopted_runs: start runs with the host configuration). |
| [`backup retire-repository`](#backup-retire-repository) | remote | plan | Plan retiring a backup repository record: it is no longer observed or used; nothing in storage is deleted. |
| [`backup policy set`](#backup-policy-set) | remote | plan | Plan a new revision of a cluster’s backup policy (high: a person applies it with a fresh re-authentication). |
| [`backup refresh`](#backup-refresh) | remote | mutation | Read the engine catalog of every observed repository of a cluster through its node into the mirror. |
| [`backup run`](#backup-run) | remote | plan | Plan a backup run into one repository (refused unless backup execution is activated and the repository allows runs). |
| [`backup verify`](#backup-verify) | remote | mutation | Verify one backup with the engine’s verify command; it counts as verified only after the run passed. |
| [`restore plan`](#restore-plan) | remote | plan | Plan a recovery of a target into a new cluster directory on a node (never in place); a person applies it with `plan apply`. |
| [`restore list`](#restore-list) | remote | read | Restores of a cluster (drills and recoveries) with their phases and checks. |
| [`restore discard`](#restore-discard) | remote | plan | Plan discarding a scratch restore: stop its temporary cluster and remove its directory on the node. |
| [`restore runbook`](#restore-runbook) | remote | read | Write the offline restore runbook of a repository (plain POSIX shell, placeholders for every secret) to a new file. |
| [`drill plan`](#drill-plan) | remote | plan | Plan a restore drill into scratch on a node: the latest backup, an older one, a random point in time, or a named backup or time. |
| [`drill list`](#drill-list) | remote | read | Drills of a cluster with their outcome and measured duration. |
| [`drill record-offline`](#drill-record-offline) | remote | mutation | Record a drill you ran from the offline runbook with the Control Plane stopped: an attestation, shown as such. |
| [`audit list`](#audit-list) | remote | read | Audit events, newest first (actors pseudonymous). |
| [`audit show`](#audit-show) | remote | read | One audit event by id (searched newest first within the filters). |
| [`access identities`](#access-identities) | remote | read | Identities (people and service accounts). |
| [`access roles`](#access-roles) | remote | read | The built-in roles and their permissions. |
| [`access bindings`](#access-bindings) | remote | read | Role bindings (who holds which role where). |
| [`access grants`](#access-grants) | remote | read | Your own OAuth grants (applications you connected). |
| [`access clients`](#access-clients) | remote | read | Registered OAuth clients (names are untrusted text). |
| [`dev up`](#dev-up) | local | local | Create or start a local lab: Control Store, staging and production targets, serve, worker and gateway. |
| [`dev status`](#dev-status) | local | read | The lab’s roles and readiness, its image against the source, the active and the last run (exit 0 only when ready). |
| [`dev owner`](#dev-owner) | local | local | Issue the first-owner setup link of the lab into a new private file (or open it in the browser). |
| [`dev mcp-client`](#dev-mcp-client) | local | local | Register the lab’s local MCP client (usable at once; a person consents at sign-in). |
| [`dev logs`](#dev-logs) | local | read | A role’s container log, or a test run’s own log. |
| [`dev shell`](#dev-shell) | local | local | A shell in one of the lab’s containers (a terminal is needed). |
| [`dev sql`](#dev-sql) | local | local | psql in one of the lab’s own databases (control, staging, production), as its local superuser. |
| [`dev test`](#dev-test) | local | local | Run a suite with its own run record and log: smoke (the lab), unit, integration, install, host:<scenario>. |
| [`dev runs`](#dev-runs) | local | read | The lab’s test runs, newest first, each with its own outcome. |
| [`dev export`](#dev-export) | local | local | Write the lab’s logs, container facts (no environment) and run records into a new directory. |
| [`dev stop`](#dev-stop) | local | local | Stop the lab’s containers; volumes, secrets and runs stay (dev up starts it again). |
| [`dev reset`](#dev-reset) | local | local | Export, then replace the lab’s databases and containers with new ones (same lab ID, image and port). |
| [`dev destroy`](#dev-destroy) | local | local | Export, then remove every container, volume and the network of the lab, and its state. |
| [`secrets scram-verifier`](#secrets-scram-verifier) | local | local | Turn a password into a PostgreSQL SCRAM-SHA-256 verifier, locally (the password never leaves this machine). |

## General

### help

Show help for a command or group.

```text
exponetdb help [command…]
```

Runs: locally; effect: local; output: `Help`.

| Argument or flag | Meaning |
|---|---|
| `command` | A command or group, e.g. migration plan. |

```sh
exponetdb help
exponetdb help migration plan
```

### version

Show the CLI version and build (no network).

```text
exponetdb version
```

Runs: locally; effect: local; output: `Version`.

### commands

List every command with its group, locality and effect.

```text
exponetdb commands
```

Runs: locally; effect: local; output: `CommandList`.

### completion

Print a shell completion script (bash, zsh or fish).

The script completes command names and flags from this CLI version only: no network, no token refresh on Tab.

```text
exponetdb completion <shell>
```

Runs: locally; effect: local; output: `Completion`.

| Argument or flag | Meaning |
|---|---|
| `shell` (required) | bash, zsh or fish. |

```sh
exponetdb completion bash > ~/.local/share/bash-completion/completions/exponetdb
exponetdb completion fish > ~/.config/fish/completions/exponetdb.fish
```

### doctor

Check the CLI, its private files, the server, the sign-in, the project and the parser (no changes).

```text
exponetdb doctor [flags]
```

Runs: against the server; effect: read; output: `DoctorReport`.

| Argument or flag | Meaning |
|---|---|
| `--skip-parser` | Do not load the PostgreSQL parser. |

### agent-help

How an automated agent uses the CLI safely, with the full command reference (Markdown).

```text
exponetdb agent-help
```

Runs: locally; effect: local; output: `AgentHelp`.

## Sign-in

### login

Sign in through the browser (or the device flow) and store the tokens privately.

Opens the authorization page of the server (loopback redirect, PKCE S256). Without --scope or --preset it asks for the scopes granted at the last sign-in (remembered per profile), else targets.read. With --device the CLI shows a code to enter on another device; the device flow never carries a production or administrative scope. Production and administrative scopes need explicit consent in the browser.

```text
exponetdb login [flags]
```

Runs: against the server; effect: session; output: `SignIn`.

Aliases: `auth login`.

| Argument or flag | Meaning |
|---|---|
| `--scope <scopes>` | Scopes to ask for, space or comma separated (default: the last grant of the profile, else targets.read). |
| `--preset <read\|developer:nonprod\|developer:prod\|operator:nonprod\|operator:prod\|admin>` | A named scope list (exponetdb auth presets); combines with --scope. |
| `--device` | Use the device flow (a code to type elsewhere). |
| `--no-browser` | Print the sign-in URL without opening a browser. |

```sh
exponetdb login --server https://db.example.com
exponetdb login --preset developer:nonprod
exponetdb login --preset admin --scope migrations.apply:prod
exponetdb login --scope "targets.read migrations.plan migrations.apply:nonprod"
exponetdb login --device --preset developer:nonprod
```

### logout

Revoke the grant on the server, then delete the local tokens.

```text
exponetdb logout
```

Runs: against the server; effect: session; output: `SignOut`.

Aliases: `auth logout`.

```sh
exponetdb logout
```

### whoami

Show the server, its version and the sign-in in use (one authenticated request).

```text
exponetdb whoami
```

Runs: against the server; effect: read; action: `installation.get`; scopes: `targets.read`; output: `WhoAmI`.

Aliases: `auth whoami`.

```sh
exponetdb whoami
exponetdb whoami --json
```

### auth status

List the servers this CLI holds a sign-in for (local; no network, no token shown).

```text
exponetdb auth status
```

Runs: locally; effect: local; output: `AuthStatus`.

### auth presets

List the named scope presets of exponetdb login --preset (local).

From this CLI version. A preset is shorthand for a scope list: the consent page still offers only what the account holds; only a preset named …:prod holds a production scope.

```text
exponetdb auth presets
```

Runs: locally; effect: local; output: `ScopePresetList`.

### auth scopes

List the OAuth scopes the CLI can ask for, and which need the browser.

From the contracts of this CLI version. A scope is an upper bound: the server still checks the person's permissions, the target's tier and policy on every request.

```text
exponetdb auth scopes
```

Runs: locally; effect: local; output: `ScopeList`.

### auth reauth

Confirm a step-up in the browser now, for a plan to apply or an enrollment token to reveal.

Prints the receipt id to pass as --step-up within 120 seconds. Usually not needed: plan apply and node enrollment create ask for the confirmation themselves.

```text
exponetdb auth reauth [flags]
```

Runs: against the server; effect: session; action: `step_up.request`; output: `StepUp`.

| Argument or flag | Meaning |
|---|---|
| `--plan <pln_…>` | The plan to apply. |
| `--token <ent_…>` | The enrollment token to reveal. |

## Profiles and configuration

### profile list

List profiles (local).

```text
exponetdb profile list
```

Runs: locally; effect: local; output: `ProfileList`.

### profile show

Show a profile (default: the current one).

```text
exponetdb profile show [name]
```

Runs: locally; effect: local; output: `Profile`.

| Argument or flag | Meaning |
|---|---|
| `name` | The profile. |

### profile add

Add or replace a profile (local; no token is stored in it).

A profile binds a server origin, the installation seen there, how to authenticate and non-secret defaults. A service account or API key stays in its own private file (0600) that the profile names; the key is read when a command runs. --force replaces an existing profile and forgets the installation it recorded.

```text
exponetdb profile add <name> [flags]
```

Runs: locally; effect: local; output: `Profile`.

| Argument or flag | Meaning |
|---|---|
| `name` (required) | Lowercase letters, digits and dashes. |
| `--server <url>` | The server origin. (required) |
| `--auth <oauth\|api-key\|service-account>` | How this profile authenticates. (default oauth) |
| `--key-file <path>` | Private key or API key file (api-key, service-account). |
| `--client-id <id>` | Service account client id. |
| `--key-id <kid>` | Service account key id. |
| `--scopes <a,b>` | Service account scopes; for oauth, what the first `exponetdb login` asks for (later the last grant). |
| `--default-output <table\|json\|ndjson>` | Default output format. |
| `--default-target <tgt_…>` | Default target. |
| `--use` | Make it the current profile. |
| `--force` | Replace an existing profile of this name. |

```sh
exponetdb profile add local --server https://db.example.com --use
exponetdb profile add ci --server https://db.example.com --auth service-account --client-id exsc_… --key-id k1 --key-file ./ci.pem --scopes migrations.read,migrations.plan
```

### profile use

Make a profile the current one.

```text
exponetdb profile use <name>
```

Runs: locally; effect: local; output: `Profile`.

| Argument or flag | Meaning |
|---|---|
| `name` (required) | The profile. |

### profile remove

Remove a profile (its sign-in stays until exponetdb logout).

```text
exponetdb profile remove <name>
```

Runs: locally; effect: local; output: `Profile`.

| Argument or flag | Meaning |
|---|---|
| `name` (required) | The profile. |

### config path

Show where the CLI keeps its private files.

```text
exponetdb config path
```

Runs: locally; effect: local; output: `ConfigPaths`.

### config show

The current profile’s defaults and the CLI’s private paths (local).

```text
exponetdb config show
```

Runs: locally; effect: local; output: `Config`.

### config set

Set a default of the current profile (output or target).

```text
exponetdb config set <key> <value>
```

Runs: locally; effect: local; output: `Config`.

| Argument or flag | Meaning |
|---|---|
| `key` (required) | output or target. |
| `value` (required) | The value. |

### config unset

Remove a default of the current profile.

```text
exponetdb config unset <key>
```

Runs: locally; effect: local; output: `Config`.

| Argument or flag | Meaning |
|---|---|
| `key` (required) | output or target. |

## Project (local)

### init

Create exponetdb.project.yaml and a migrations directory in the working directory (nothing is overwritten).

```text
exponetdb init [flags]
```

Runs: locally; effect: local; output: `ProjectInit`.

| Argument or flag | Meaning |
|---|---|
| `--project <product/project>` | The registry path of the project. (required) |

```sh
exponetdb init --project demo/platform
```

### project validate

Validate the project file and read every bundle root (local).

```text
exponetdb project validate
```

Runs: locally; effect: local; output: `ProjectValidation`.

### project link

Link the project to the current server and profile, after checking the project exists there.

```text
exponetdb project link
```

Runs: against the server; effect: local; action: `project.list`; scopes: `targets.read`; output: `ProjectLink`.

### project unlink

Remove the project’s link to a server (local).

```text
exponetdb project unlink
```

Runs: locally; effect: local; output: `ProjectLink`.

### project context

Where every setting of this invocation comes from: server, profile, project, output (local).

```text
exponetdb project context
```

Runs: locally; effect: local; output: `Context`.

Aliases: `context`.

## Registry

### product list

List products.

```text
exponetdb product list [flags]
```

Runs: against the server; effect: read; action: `product.list`; scopes: `targets.read`; output: `ProductList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### product show

Show a product.

```text
exponetdb product show <product>
```

Runs: against the server; effect: read; action: `product.get`; scopes: `targets.read`; output: `Product`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id (prd_…) or slug. |

### product create

Plan a new product.

```text
exponetdb product create [slug] [flags]
```

Runs: against the server; effect: plan; action: `registry.product.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `slug` | Lowercase slug (the first segment of target paths). Required unless --file is given. |
| `--name <text>` | Display name. Required unless --file is given. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### environment list

List the environments of a product, in rank order.

```text
exponetdb environment list <product> [flags]
```

Runs: against the server; effect: read; action: `environment.list`; scopes: `targets.read`; output: `EnvironmentList`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### environment show

Show one environment of a product.

```text
exponetdb environment show <product> <environment>
```

Runs: against the server; effect: read; action: `environment.list`; scopes: `targets.read`; output: `Environment`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `environment` (required) | An environment id (env_…) or slug. |

### environment create

Plan a new environment of a product.

```text
exponetdb environment create <product> [slug] [flags]
```

Runs: against the server; effect: plan; action: `registry.environment.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `slug` | Lowercase slug. Required unless --file is given. |
| `--name <text>` | Display name. Required unless --file is given. |
| `--tier <prod\|nonprod>` | The tier. Required unless --file is given. |
| `--rank <number>` | Promotion order (lower first). |
| `--evidence-from <env>` | The environment whose verified result production needs. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### environment update

Plan a change of an environment (name, tier, rank, evidence source).

```text
exponetdb environment update <product> <environment> [flags]
```

Runs: against the server; effect: plan; action: `registry.environment.update.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `environment` (required) | An environment id. |
| `--name <text>` | Display name. |
| `--tier <prod\|nonprod>` | The tier. |
| `--rank <number>` | Promotion order. |
| `--evidence-from <env>` | Evidence source environment. |
| `--no-evidence-from` | Remove the evidence source. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### project list

List projects.

```text
exponetdb project list [flags]
```

Runs: against the server; effect: read; action: `project.list`; scopes: `targets.read`; output: `ProjectList`.

| Argument or flag | Meaning |
|---|---|
| `--product <slug>` | Only this product. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### project show

Show a project and its managed scope.

```text
exponetdb project show <project>
```

Runs: against the server; effect: read; action: `project.get`; scopes: `targets.read`; output: `Project`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id (prj_…). |

### project create

Plan a new project of a product.

```text
exponetdb project create [product] [slug] [flags]
```

Runs: against the server; effect: plan; action: `registry.project.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `product` | A product id or slug. Required unless --file is given. |
| `slug` | Lowercase slug. Required unless --file is given. |
| `--name <text>` | Display name. Required unless --file is given. |
| `--include-schemas <a,b>` | Schemas the project manages. |
| `--exclude-schemas <a,b>` | Schemas it never manages. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### project update

Plan a project change (name, managed scope, execution roles, trusted extensions).

```text
exponetdb project update <project> [flags]
```

Runs: against the server; effect: plan; action: `registry.project.update.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id. |
| `--name <text>` | Display name. |
| `--execution-role <name=role>` | Execution roles (name=PostgreSQL role). |
| `--trusted-extensions <a,b>` | Extensions a bundle may require. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### project execution-roles

Show a project's execution roles: the default map, each environment's bindings and the declared exceptions.

```text
exponetdb project execution-roles <project>
```

Runs: against the server; effect: read; action: `project.execution_roles.get`; scopes: `migrations.read`; output: `ProjectExecutionRoles`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id (prj_…). |

### project execution-roles set

Plan one environment's execution roles (aliases of the project map bound to other roles); the set replaces the environment's bindings.

```text
exponetdb project execution-roles set <project> [flags]
```

Runs: against the server; effect: plan; action: `registry.execution_role_binding.set.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id. |
| `--environment <env>` | An environment of the project's product (id or slug). Required unless --file is given. |
| `--role <alias=role>` | A binding (alias=PostgreSQL role); repeat for each alias. |
| `--clear` | Remove every binding: the project map applies again. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### project role-exception declare

Plan a declared exception: one role may carry BYPASSRLS as an execution role of the project in one environment (nothing else is ever excused).

```text
exponetdb project role-exception declare <project> [flags]
```

Runs: against the server; effect: plan; action: `registry.execution_role_exception.declare.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id. |
| `--environment <env>` | An environment of the project's product (id or slug). Required unless --file is given. |
| `--role <role>` | The PostgreSQL role. Required unless --file is given. |
| `--reason <text>` | Why the role needs BYPASSRLS (20 to 1000 characters). Required unless --file is given. |
| `--review-by <YYYY-MM-DD>` | After this date the exception excuses nothing. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### project role-exception revoke

Plan the revocation of a declared exception; every plan that relied on it becomes stale.

```text
exponetdb project role-exception revoke <project> <exception> [flags]
```

Runs: against the server; effect: plan; action: `registry.execution_role_exception.revoke.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `project` (required) | A project id. |
| `exception` (required) | The exception (rxe_…). |
| `--reason <text>` | Why it is revoked (up to 1000 characters). Required unless --file is given. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### target list

List targets with tier, state and health.

```text
exponetdb target list [flags]
```

Runs: against the server; effect: read; action: `target.list`; scopes: `targets.read`; output: `TargetList`.

| Argument or flag | Meaning |
|---|---|
| `--product <slug>` | Only this product. |
| `--project <slug>` | Only this project. |
| `--environment <slug>` | Only this environment. |
| `--tier <prod\|nonprod>` | Only this tier. |
| `--state <state>` | Only this lifecycle state. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### target show

Show a target: placement, ledger, health, findings.

```text
exponetdb target show <target>
```

Runs: against the server; effect: read; action: `target.get`; scopes: `targets.read`; output: `Target`.

Aliases: `target resolve`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path (product/project/environment). |

### target register

Plan registering a database of a cluster as a target of a project environment.

```text
exponetdb target register [flags]
```

Runs: against the server; effect: plan; action: `target.register.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `--project <prj_…>` | The project. Required unless --file is given. |
| `--environment <env_…>` | The environment. Required unless --file is given. |
| `--database <dbs_…>` | The registered database. Required unless --file is given. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### target suspend

Plan to suspend a target (with a reason).

```text
exponetdb target suspend <target> [flags]
```

Runs: against the server; effect: plan; action: `target.suspend.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--reason <text>` | Why (recorded with the plan). (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### target resume

Plan to resume a target (with a reason).

```text
exponetdb target resume <target> [flags]
```

Runs: against the server; effect: plan; action: `target.resume.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--reason <text>` | Why (recorded with the plan). (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### target decommission

Plan to decommission a target (with a reason).

```text
exponetdb target decommission <target> [flags]
```

Runs: against the server; effect: plan; action: `target.decommission.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--reason <text>` | Why (recorded with the plan). (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### server list

List servers.

```text
exponetdb server list [flags]
```

Runs: against the server; effect: read; action: `server.list`; scopes: `nodes.read`; output: `ServerList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### server show

Show a server and the facts its node reported.

```text
exponetdb server show <server>
```

Runs: against the server; effect: read; action: `server.get`; scopes: `nodes.read`; output: `Server`.

| Argument or flag | Meaning |
|---|---|
| `server` (required) | A server id (srv_…). |

### server retire

Plan retiring a server record (registry.md §4.4): only when every cluster on it is retired, every node decommissioned and no job or token is open; the machine is not touched.

```text
exponetdb server retire <server> [flags]
```

Runs: against the server; effect: plan; action: `registry.server.retire.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `server` (required) | A server id (srv_…). |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### server create

Plan a server record.

```text
exponetdb server create [name] [flags]
```

Runs: against the server; effect: plan; action: `registry.server.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `name` | Display name. Required unless --file is given. |
| `--provider <hetzner_cloud\|hetzner_robot\|other\|unknown\|aws\|google_cloud\|azure\|oracle_cloud\|ibm_cloud\|alibaba_cloud\|digitalocean\|akamai_linode\|vultr\|upcloud\|scaleway\|exoscale\|stackit\|ovhcloud\|ionos\|netcup\|contabo\|on_premises>` | Where the server runs (a hosting provider, on_premises, other or unknown). (default other) |
| `--location <text>` | Location (e.g. fsn1). |
| `--provider-ref <id>` | The provider’s reference. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster list

List clusters.

```text
exponetdb cluster list [flags]
```

Runs: against the server; effect: read; action: `cluster.list`; scopes: `nodes.read`; output: `ClusterList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### cluster show

Show a cluster.

```text
exponetdb cluster show <cluster>
```

Runs: against the server; effect: read; action: `cluster.get`; scopes: `nodes.read`; output: `Cluster`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |

### cluster endpoints

List the endpoints of a cluster.

```text
exponetdb cluster endpoints <cluster>
```

Runs: against the server; effect: read; action: `endpoint.list`; scopes: `nodes.read`; output: `EndpointList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |

### cluster databases

List the registered databases of a cluster.

```text
exponetdb cluster databases <cluster>
```

Runs: against the server; effect: read; action: `database.list`; scopes: `nodes.read`; output: `DatabaseList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |

### cluster credentials

List credential metadata of a cluster (never a secret).

```text
exponetdb cluster credentials <cluster>
```

Runs: against the server; effect: read; action: `credential.list`; scopes: `nodes.read`; output: `CredentialList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |

### cluster bootstrap-sql

Write the cluster’s bootstrap SQL (roles, grants) to stdout or a new file, for a DBA to review and run.

The SQL is the server’s, generated for this cluster; the CLI never runs it. Review it before a database administrator runs it with psql. It is idempotent: run it again after a database is added or an execution role is created. It covers the registered databases and those named with --database (before registration), grants the migrator SET ROLE into the execution roles of the projects placed on the cluster or named with --project, where they exist and are fit, and lets the observer read the legacy ledgers named with --ledger.

```text
exponetdb cluster bootstrap-sql <cluster> [flags]
```

Runs: against the server; effect: read; action: `cluster.bootstrap_sql.get`; scopes: `registry.manage`; output: `ClusterBootstrapSql`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--file <path>` | A new file to write (0600). |
| `--database <names>` | Databases of the cluster not registered yet. |
| `--project <prj_…>` | A project whose targets will be placed here: its execution roles too (needs migrations.read on it). |
| `--environment <env_…>` | Only this environment of --project. |
| `--ledger <supabase,drizzle,applied_migrations>` | Legacy ledgers the observer may read during an import. |

### cluster register

Plan registering a PostgreSQL cluster (endpoints and CA bundle from --file).

The request (display name, CA bundle, endpoints, optional server) comes from a JSON or YAML file checked against the contract; no password is part of it.

```text
exponetdb cluster register [flags]
```

Runs: against the server; effect: plan; action: `registry.cluster.register.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster confirm

Plan confirming a cluster’s identity (its system identifier).

```text
exponetdb cluster confirm <cluster> [flags]
```

Runs: against the server; effect: plan; action: `registry.cluster.confirm.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--system-identifier <digits>` | The expected system identifier. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster endpoint add

Plan a new endpoint of a cluster.

```text
exponetdb cluster endpoint add <cluster> [flags]
```

Runs: against the server; effect: plan; action: `registry.endpoint.add.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--label <text>` | Label. Required unless --file is given. |
| `--kind <private\|public\|local_socket\|pooler>` | Kind. Required unless --file is given. |
| `--host <host>` | Host name or address. Required unless --file is given. |
| `--port <number>` | Port. (default 5432) |
| `--tls-server-name <name>` | TLS server name to verify. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster endpoint retire

Plan retiring an endpoint.

```text
exponetdb cluster endpoint retire <cluster> <endpoint> [flags]
```

Runs: against the server; effect: plan; action: `registry.endpoint.retire.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `endpoint` (required) | An endpoint id. |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster database retire

Plan retiring a registered database record that is no current placement (decommission its target first); the database itself is not touched.

```text
exponetdb cluster database retire <cluster> <database> [flags]
```

Runs: against the server; effect: plan; action: `registry.database.retire.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `database` (required) | A database id (dbs_…). |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster retire

Plan retiring a cluster record with its endpoint and credential records (registry.md §4.4): only when no database is registered on it; nothing changes on the PostgreSQL cluster.

```text
exponetdb cluster retire <cluster> [flags]
```

Runs: against the server; effect: plan; action: `registry.cluster.retire.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster declare-tier

Plan declaring the tier a cluster is meant for (OD-22): prod makes every database registered on it need production authority; nonprod leaves it to the environment.

The same rules as the Web App: a person with registry.manage:prod plans it, whichever value; applying it (--apply or plan apply) needs a fresh re-authentication (exponetdb auth reauth --plan).

```text
exponetdb cluster declare-tier <cluster> [flags]
```

Runs: against the server; effect: plan; action: `registry.cluster.declare_tier.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--tier <prod\|nonprod>` | The declared tier. (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster database register

Plan registering a database of a cluster.

```text
exponetdb cluster database register <cluster> <name> [flags]
```

Runs: against the server; effect: plan; action: `registry.database.register.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `name` (required) | The database name. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### cluster credential submit

Open the Web App’s write-only form for a role’s password, then wait until the worker verified it.

The password a person set on an external cluster (psql \password, or a verifier from exponetdb secrets scram-verifier) is entered once in the Web App with a fresh re-authentication; the CLI never reads or sends it (credentials-and-roles.md §5). The CLI opens the page for the cluster and role and, unless --no-wait, watches the credential until it is active or failed.

```text
exponetdb cluster credential submit <cluster> <role> [flags]
```

Runs: against the server; effect: read; action: `credential.list`; scopes: `nodes.read`; output: `CredentialView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `role` (required) | observer, reader, verifier, operator or migrator. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

```sh
exponetdb cluster credential submit cls_01J… observer
```

### cluster credential rotate

Plan rotating a cluster credential through the node (a new SCRAM verifier, set locally).

```text
exponetdb cluster credential rotate <cluster> <role> [flags]
```

Runs: against the server; effect: plan; action: `credential.rotate.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `role` (required) | The access role (e.g. observer, migrator). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

## Nodes

### node list

List nodes with state, heartbeat and agent version.

```text
exponetdb node list [flags]
```

Runs: against the server; effect: read; action: `node.list`; scopes: `nodes.read`; output: `NodeList`.

| Argument or flag | Meaning |
|---|---|
| `--server <srv_…>` | Only the nodes of this server. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### node show

Show a node: state, heartbeat, certificate, clusters and capabilities.

```text
exponetdb node show <node>
```

Runs: against the server; effect: read; action: `node.get`; scopes: `nodes.read`; output: `NodeStatus`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |

### node status

The node’s state with its source and time (pending_binding, active, offline, revoked …).

```text
exponetdb node status <node>
```

Runs: against the server; effect: read; action: `node.get`; scopes: `nodes.read`; output: `NodeStatus`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |

### node capabilities

The capabilities a node offers, and whether this CLI supports each version.

```text
exponetdb node capabilities <node>
```

Runs: against the server; effect: read; action: `node.get`; scopes: `nodes.read`; output: `NodeStatus`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |

### node observations

The latest node-signed observations of a node.

```text
exponetdb node observations <node> [flags]
```

Runs: against the server; effect: read; action: `node.get`; scopes: `nodes.read`; output: `NodeObservationList`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |
| `--capability <name@major>` | Only this capability. |
| `--cluster <cls_…>` | Only this cluster. |

### node inspect

Run one read or plan capability on a node and wait for its signed result.

```text
exponetdb node inspect <node> [flags]
```

Runs: against the server; effect: plan; action: `node.inspect`; scopes: `nodes.plan`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |
| `--capability <name@major>` | An inspectable capability. (required) |
| `--cluster <cls_…>` | The cluster (for postgres capabilities). |
| `--arg <k=v>` | Capability arguments (string values). |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres reload

Plan a PostgreSQL reload on a node.

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres reload <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres restart

Plan a PostgreSQL restart on a node (through its helper).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres restart <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres config

Plan PostgreSQL parameter changes (managed parameters only; secrets stay references).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres config <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--set <name=value>` | Parameters to set. |
| `--reset <name>` | Parameters to reset. |
| `--no-reload` | Do not reload after applying. |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres hba

Plan the managed pg_hba rules (from --file).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres hba <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--file <path>` | The change as JSON or YAML (checked against the contract). (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres roles

Plan role steps (from --file; passwords only as SCRAM verifiers).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres roles <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--file <path>` | The change as JSON or YAML (checked against the contract). (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres extensions

Plan extension steps (from --file).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres extensions <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--file <path>` | The change as JSON or YAML (checked against the contract). (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node postgres tls

Plan rotating the server TLS certificate (from --file: names and validity).

Plans the change through the node (node.plan): the server binds it to an observation at most 10 minutes old and to the node’s capability; nothing runs before plan apply. Production needs approval.

```text
exponetdb node postgres tls <node> [flags]
```

Runs: against the server; effect: plan; action: `node.plan`; scopes: `nodes.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id (nod_…). |
| `--cluster <cls_…>` | The cluster on the node. (required) |
| `--file <path>` | The change as JSON or YAML (checked against the contract). (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node job-keys

Plan adding or retiring job-signing keys a node trusts.

```text
exponetdb node job-keys <node> [flags]
```

Runs: against the server; effect: plan; action: `node.config.update.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |
| `--add <key>` | Job key ids to add. |
| `--retire <key>` | Job key ids to retire. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node revoke

Plan revoking a node (the gateway refuses it at its next request).

```text
exponetdb node revoke <node> [flags]
```

Runs: against the server; effect: plan; action: `node.revoke.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node decommission

Plan decommissioning a node.

```text
exponetdb node decommission <node> [flags]
```

Runs: against the server; effect: plan; action: `node.decommission.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `node` (required) | The node id. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node enrollment create

Enroll a node for a server: plan, apply, reveal the token once into a new private file.

Plans node.enroll for the server, applies it (a fresh confirmation in the browser through a step-up), waits until the token exists, reveals it once and writes it to --token-file (a new 0600 file; nothing is overwritten). The token is never printed. Then follow the instructions on the host.

```text
exponetdb node enrollment create <server> [flags]
```

Runs: against the server; effect: mutation; action: `node.enroll`; scopes: `registry.manage`; output: `Enrollment`.

| Argument or flag | Meaning |
|---|---|
| `server` (required) | The server id (srv_…). |
| `--token-file <path>` | A new file for the token (0600). (required) |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node enrollment status

The nodes of a server and their enrollment state (until active).

```text
exponetdb node enrollment status <server> [flags]
```

Runs: against the server; effect: read; action: `node.list`; scopes: `nodes.read`; output: `NodeList`.

| Argument or flag | Meaning |
|---|---|
| `server` (required) | The server id. |
| `--wait` | Wait until a node of the server is active. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### node enrollment instructions

How to enroll the host with a token file (and the token’s public trust metadata).

```text
exponetdb node enrollment instructions <token-file>
```

Runs: locally; effect: local; output: `EnrollmentInstructions`.

| Argument or flag | Meaning |
|---|---|
| `token-file` (required) | The token file written by node enrollment create. |

## Migrations

### migration new

Create a new bundle directory (<ULID>_<name>) with migration.yaml, up.sql and verify.sql.

Depends on the current heads of the stream unless --depends-on names others. Nothing existing is changed; the ULID is the identity, never the order.

```text
exponetdb migration new <name> [flags]
```

Runs: locally; effect: local; output: `NewBundle`.

| Argument or flag | Meaning |
|---|---|
| `name` (required) | Lowercase words joined by dashes, e.g. add-leads-index. |
| `--depends-on <ids>` | Migration ids (or baseline refs) it depends on. |
| `--nontransactional` | For statements that cannot run in a transaction (CREATE INDEX CONCURRENTLY). |
| `--root <dir>` | Which bundle root (default the first). |

```sh
exponetdb migration new add-leads-index
exponetdb migration new leads-idx --nontransactional
```

### migration lint

Lint the local bundles with the PostgreSQL parser (offline facts; exit 1 on a blocking finding).

```text
exponetdb migration lint [flags]
```

Runs: locally; effect: local; output: `LintReport`.

| Argument or flag | Meaning |
|---|---|
| `--postgres <16\|17\|18>` | The grammar (default 17). (default 17) |
| `--tier <prod\|nonprod>` | Lint as for this tier (default prod, the strictest). (default prod) |

### migration checksum

The apply checksum and digests of each local bundle (sha256:c1:…), as the server computes them.

```text
exponetdb migration checksum
```

Runs: locally; effect: local; output: `ChecksumList`.

### migration graph

The dependency graph of the local stream: order, heads and errors (no server).

```text
exponetdb migration graph
```

Runs: locally; effect: local; output: `MigrationGraph`.

### migration status

The target’s ledger, read live: applied (with verification) and pending migrations.

```text
exponetdb migration status [flags]
```

Runs: against the server; effect: read; action: `migration.status.get`; scopes: `migrations.read`; output: `MigrationStatus`.

Aliases: `migration list`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |

### migration show

One migration on a target: state, events, verification runs.

```text
exponetdb migration show <migration> [flags]
```

Runs: against the server; effect: read; action: `migration.get`; scopes: `migrations.read`; output: `MigrationDetail`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id (ULID), or a legacy import baseline (baseline:<slug>). |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |

### migration evidence

The verification evidence of a migration on a target (what production promotion binds).

```text
exponetdb migration evidence <migration> [flags]
```

Runs: against the server; effect: read; action: `migration.get`; scopes: `migrations.read`; output: `MigrationDetail`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |

### migration plan

Plan migrations for a target from the local bundles (or stored ones): analysis, policy, evidence.

Submits the exact bytes of the local bundles; the server ingests them, analyzes them against the live target and decides. Nothing runs until plan apply.

```text
exponetdb migration plan [migration…] [flags]
```

Runs: against the server; effect: plan; action: `migration.plan`; scopes: `migrations.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `migration` | Migration ids to plan (default: what is pending). |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--stored` | Plan bundles already ingested on the server (by id) instead of the local ones. |
| `--break-glass <bgl_…>` | Plan under an active break-glass grant of yours. |

```sh
exponetdb migration plan --target demo/platform/staging
exponetdb migration plan 01HV… --target demo/platform/production
```

### migration apply

Plan and apply migrations, then wait until applied and verified (exit 0 only then).

```text
exponetdb migration apply [migration…] [flags]
```

Runs: against the server; effect: mutation; action: `migration.apply`; scopes: `migrations.plan`, `migrations.apply:nonprod`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `migration` | Migration ids (default: what is pending). |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--stored` | Plan bundles already ingested on the server (by id) instead of the local ones. |
| `--break-glass <bgl_…>` | Plan under an active break-glass grant of yours. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |
| `--step-up <stu_…>` | A step-up confirmed for the plan. |

```sh
exponetdb migration apply --target demo/platform/staging
```

### migration verify

Run a migration’s verification again on a target and wait for its result.

With a baseline (baseline:<slug>), the verification of the legacy import it recorded runs again, with the review decisions that excused failing expectations; when it passes, its schema becomes the drift reference. The baseline operation keeps its outcome; the new run is in the target’s history (migration show baseline:<slug>).

```text
exponetdb migration verify <migration> [flags]
```

Runs: against the server; effect: mutation; action: `migration.verify`; scopes: `migrations.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id, or a legacy import baseline (baseline:<slug>). |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--revision <number>` | The bundle revision whose verify.sql runs. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### migration resume

Plan resuming a non-transactional migration that stopped part-way (an explicit new plan).

```text
exponetdb migration resume <migration> [flags]
```

Runs: against the server; effect: plan; action: `migration.resume.plan`; scopes: `migrations.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--cleanup` | Drop the INVALID index the stopped statement left (by its OID). |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### migration rollback

Plan rolling back the latest migration with its down.sql (an explicit new plan; never automatic).

```text
exponetdb migration rollback <migration> [flags]
```

Runs: against the server; effect: plan; action: `migration.rollback.plan`; scopes: `migrations.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--apply` | Apply the plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### migration import analyze

Plan a legacy import analysis: replay the legacy files on a scratch target and classify them.

```text
exponetdb migration import analyze [flags]
```

Runs: against the server; effect: plan; action: `migration.import.analyze`; scopes: `migrations.import`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--scratch <target>` | An empty disposable target to replay on. (required) |
| `--baseline <slug>` | The baseline, as baseline:<slug> or <slug> (default the project’s). |
| `--hints <path>` | Import hints as a JSON or YAML file: aliases, notApplicable, role, searchPath, ledgers (checked against the contract). |
| `--ledger <supabase,drizzle,applied_migrations>` | Legacy ledgers to read. |
| `--not-applicable <files>` | Legacy files that never apply to this target. |
| `--apply` | Apply the analysis plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### migration import scratch-reset-sql

Print the SQL that resets a used scratch target in place (run it with psql -v ON_ERROR_STOP=1 as a superuser on that database): it keeps the database and its identity marker and recreates the managed schemas with their grants and extensions.

```text
exponetdb migration import scratch-reset-sql [flags]
```

Runs: against the server; effect: read; action: `target.get`; scopes: `targets.read`; output: `ScratchResetSql`.

| Argument or flag | Meaning |
|---|---|
| `--scratch <target>` | The scratch target (path or tgt_ id); nonprod only. (required) |

### migration import scratch-check

Check, read only, whether a scratch target can take this target’s legacy replay: usable, its identity, empty, the same extensions, the objects outside the managed scope, the execution role; in a project with a legacy directory also what its files reference outside the scope.

```text
exponetdb migration import scratch-check [flags]
```

Runs: against the server; effect: read; action: `migration.import.scratch_check`; scopes: `migrations.import`; output: `ScratchCheck`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--scratch <target>` | The scratch target (path or tgt_ id). (required) |
| `--role <alias>` | The execution role alias the replay runs as (the hints role; default owner). |
| `--hints <path>` | The analysis hints file: its role and notApplicable apply here too (the replay skips those files). |
| `--not-applicable <files>` | Legacy files the replay skips, so the check does not read them either. |

### migration import scratch-copy-commands

Print the shell commands that copy, schema-only and without triggers, the schemas outside the managed scope the scratch target lacks objects of from the imported target (pg_dump and pg_restore; set IMPORTED_URL and SCRATCH_URL).

```text
exponetdb migration import scratch-copy-commands [flags]
```

Runs: against the server; effect: read; action: `migration.import.scratch_check`; scopes: `migrations.import`; output: `ScratchCopyCommands`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--scratch <target>` | The scratch target (path or tgt_ id). (required) |
| `--role <alias>` | The execution role alias the replay runs as (the hints role; default owner). |
| `--hints <path>` | The analysis hints file: its role and notApplicable apply here too (the replay skips those files). |
| `--not-applicable <files>` | Legacy files the replay skips, so the check does not read them either. |

### migration import report

An import report: every legacy file’s classification and the decisions so far.

```text
exponetdb migration import report <report> [flags]
```

Runs: against the server; effect: read; action: `migration.import.report.get`; scopes: `migrations.import`; output: `ImportReport`.

| Argument or flag | Meaning |
|---|---|
| `report` (required) | The import report id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |

### migration import resolve

Record your decision for one item of an import report (with a note).

```text
exponetdb migration import resolve <report> <item> [flags]
```

Runs: against the server; effect: mutation; action: `migration.import.decide`; scopes: `migrations.import`; output: `ImportReport`.

| Argument or flag | Meaning |
|---|---|
| `report` (required) | The import report id. |
| `item` (required) | The item id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--state <recorded_present\|unrecorded_present\|recorded_missing\|unrecorded_missing\|superseded\|not_applicable>` | What the item is. (required) |
| `--note <text>` | Why (kept with the decision). (required) |

### migration import baseline

Plan the baseline of a resolved import report (records the legacy ledger; changes no schema).

```text
exponetdb migration import baseline <report> [flags]
```

Runs: against the server; effect: plan; action: `migration.baseline.plan`; scopes: `migrations.import`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `report` (required) | The import report id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--apply` | Apply at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### migration ledger reconcile

Plan adopting the target’s ledger as the truth after a restore or a hand change; the mirror rows that differ move to a history, no row is deleted.

```text
exponetdb migration ledger reconcile [flags]
```

Runs: against the server; effect: plan; action: `ledger.reconcile.plan`; scopes: `migrations.import`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--note <text>` | Why: what happened to the target (kept with the plan, 1 to 1000 characters). (required) |
| `--apply` | Apply at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

## Plans

### plan show

Show a plan: subject, decision, requirements, content and analysis.

```text
exponetdb plan show <plan>
```

Runs: against the server; effect: read; action: `plan.get`; scopes: `targets.read`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `plan` (required) | The plan id (pln_…). |

```sh
exponetdb plan show pln_01…
```

### plan list

List plans you may read, newest first (filter by target, kind, state).

```text
exponetdb plan list [flags]
```

Runs: against the server; effect: read; action: `plan.list`; scopes: `targets.read`; output: `PlanList`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id or path. |
| `--kind <kind>` | A plan kind, e.g. migration.apply. |
| `--state <active\|consumed\|expired\|invalidated\|denied\|withdrawn>` | Only plans in this state. |
| `--mine` | Only plans you created. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### plan export

Write a plan as JSON (to stdout, or to a new private file with --file).

The plan view as the server stores and shows it: subject, bindings, content and analysis by digest. A plan carries no SQL text and no secret. --file never overwrites an existing file.

```text
exponetdb plan export <plan> [flags]
```

Runs: against the server; effect: read; action: `plan.get`; scopes: `targets.read`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `plan` (required) | The plan id (pln_…). |
| `--file <path>` | A new file to write (0600). |

### plan apply

Apply a stored plan and wait until it is applied and verified.

Applies exactly the stored plan (its target, tier, content and bindings); the server re-checks every binding and refuses a stale plan. Waits by default; exit 0 only when the change is applied and verified. A production plan asks for confirmation on a terminal (or --yes, which never replaces an approval or a re-authentication).

```text
exponetdb plan apply <plan> [flags]
```

Runs: against the server; effect: mutation; action: `plan.apply`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `plan` (required) | The plan id (pln_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |
| `--step-up <stu_…>` | A step-up already confirmed for this plan (exponetdb auth reauth --plan). |

```sh
exponetdb plan apply pln_01… --wait
exponetdb plan apply pln_01… --no-wait --json
```

### plan withdraw

Withdraw your own active plan (it can no longer be applied).

```text
exponetdb plan withdraw <plan>
```

Runs: against the server; effect: mutation; action: `plan.withdraw`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `plan` (required) | The plan id (pln_…). |

## Operations

### operation list

List operations you may read, newest first.

```text
exponetdb operation list [flags]
```

Runs: against the server; effect: read; action: `operation.list`; scopes: `targets.read`; output: `OperationList`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id or path. |
| `--kind <kind>` | An operation kind, e.g. migration.apply. |
| `--state <awaiting_approval\|queued\|running\|verifying\|needs_reconciliation\|needs_attention\|succeeded\|failed\|verification_failed\|canceled>` | Only operations in this state. |
| `--mine` | Only operations you started. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### operation show

Show an operation: state, apply and verification outcomes, steps and migrations.

```text
exponetdb operation show <operation>
```

Runs: against the server; effect: read; action: `operation.get`; scopes: `targets.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |

### operation watch

Watch an operation until it is final (exit 0 only when applied and verified).

Polls the operation with bounded backoff and reports each change on stderr (NDJSON: progress records). Ctrl-C stops watching; the operation continues on the server.

```text
exponetdb operation watch <operation> [flags]
```

Runs: against the server; effect: read; action: `operation.get`; scopes: `targets.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### operation cancel

Cancel an operation that has not started (awaiting approval or queued).

A separate, authorized request: only the person or client that applied the plan may cancel, and only before the operation runs. A running operation is never interrupted from the CLI.

```text
exponetdb operation cancel <operation>
```

Runs: against the server; effect: mutation; action: `operation.cancel`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |

### operation retry-verification

Verify again an operation that needs attention after an applied change.

For an operation in needs_attention whose change was applied but whose verification errored or never finished (a timeout, the target unreachable). The change is never run again: the worker re-runs the read-only verification. Waits by default; exit 0 only when the verification passed.

```text
exponetdb operation retry-verification <operation> [flags]
```

Runs: against the server; effect: mutation; action: `operation.retry_verification`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

```sh
exponetdb operation retry-verification op_01… --wait
```

## Approvals

### approval list

List operations awaiting approval that you may read.

Approvals are decided in the Web App (re-authentication, the exact plan hash). This lists what waits; `approval open` takes you to the bound approval page.

```text
exponetdb approval list [flags]
```

Runs: against the server; effect: read; action: `operation.list`; scopes: `targets.read`; output: `OperationList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### approval show

Show what an approval decides: the operation, its plan and the plan hash.

```text
exponetdb approval show <operation>
```

Runs: against the server; effect: read; action: `plan.get`; scopes: `targets.read`; output: `ApprovalView`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |

### approval open

Open the bound approval page in the browser.

There is no CLI approval endpoint (ADR-0026 §6): the decision is taken in the Web App with a fresh re-authentication and the exact plan hash. The CLI opens that page and, unless --no-wait, watches the operation until the decision is recorded.

```text
exponetdb approval open <operation>
```

Runs: against the server; effect: read; action: `operation.get`; scopes: `targets.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |

### approval approve

Open the approval page to approve (re-authentication there), then wait for the decision.

There is no CLI approval endpoint (ADR-0026 §6): the decision is taken in the Web App with a fresh re-authentication and the exact plan hash. The CLI opens that page and, unless --no-wait, watches the operation until the decision is recorded.

```text
exponetdb approval approve <operation> [flags]
```

Runs: against the server; effect: read; action: `operation.get`; scopes: `targets.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### approval reject

Open the approval page to reject (re-authentication there), then wait for the decision.

There is no CLI approval endpoint (ADR-0026 §6): the decision is taken in the Web App with a fresh re-authentication and the exact plan hash. The CLI opens that page and, unless --no-wait, watches the operation until the decision is recorded.

```text
exponetdb approval reject <operation> [flags]
```

Runs: against the server; effect: read; action: `operation.get`; scopes: `targets.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `operation` (required) | The operation id (op_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

## Diagnostics

### health

A target’s health: probes, conditions, node and backups, with source and time.

```text
exponetdb health <target>
```

Runs: against the server; effect: read; action: `target.health.get`; scopes: `diagnostics.read`; output: `TargetHealth`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |

### finding list

Findings across the targets you may read (drift, health, advisors, statements), open by default.

Without --target, the findings of every target you may read with diagnostics.read, newest first; --kind and --code narrow to one rule or condition.

```text
exponetdb finding list [flags]
```

Runs: against the server; effect: read; action: `finding.list`; scopes: `diagnostics.read`; output: `FleetFindingList`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). |
| `--include-resolved` | Also resolved findings. |
| `--severity <info\|warning\|critical>` | Only this severity. |
| `--kind <drift\|health\|advisor\|statements>` | Only this kind. |
| `--code <code>` | Only this rule or condition code. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### finding summary

Counts of the open findings you may read, by severity, kind and code.

```text
exponetdb finding summary
```

Runs: against the server; effect: read; action: `finding.summary`; scopes: `diagnostics.read`; output: `FindingSummary`.

### cluster findings

Findings of a cluster (backups and other cluster-level findings), open by default.

```text
exponetdb cluster findings <cluster> [flags]
```

Runs: against the server; effect: read; action: `cluster.finding.list`; scopes: `backups.read`; output: `FindingList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--state <open\|resolved\|all>` | Which findings (default open). |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### finding show

One finding of a target.

```text
exponetdb finding show <finding> [flags]
```

Runs: against the server; effect: read; action: `target.finding.list`; scopes: `diagnostics.read`; output: `Finding`.

| Argument or flag | Meaning |
|---|---|
| `finding` (required) | The finding id. |
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |

### schema overview

The schemas of a target with object counts, its fingerprint and what is visible.

```text
exponetdb schema overview <target>
```

Runs: against the server; effect: read; action: `schema.overview.get`; scopes: `schema.read`; output: `SchemaOverview`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |

### schema search

Search a target’s catalog by name.

```text
exponetdb schema search <target> <query> [flags]
```

Runs: against the server; effect: read; action: `schema.search`; scopes: `schema.read`; output: `SchemaObjectList`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `query` (required) | Part of a name. |
| `--kinds <table,view>` | Only these object kinds. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### schema show

One catalog object: columns, constraints, indexes, grants, policies (definitions are untrusted text).

```text
exponetdb schema show <target> <kind> <name>
```

Runs: against the server; effect: read; action: `schema.object.get`; scopes: `schema.read`; output: `SchemaObject`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `kind` (required) | Object kind, e.g. table. |
| `name` (required) | Qualified name, e.g. public.leads. |

### schema fingerprint

A target’s schema fingerprint (what plans and evidence bind).

```text
exponetdb schema fingerprint <target>
```

Runs: against the server; effect: read; action: `schema.fingerprint.get`; scopes: `schema.read`; output: `SchemaFingerprint`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |

### schema diff

Compare two targets (or a target and a fingerprint) object by object.

```text
exponetdb schema diff <left> <right>
```

Runs: against the server; effect: read; action: `schema.diff`; scopes: `schema.read`; output: `SchemaDiff`.

| Argument or flag | Meaning |
|---|---|
| `left` (required) | A target, or fingerprint:sha256:… |
| `right` (required) | A target, or fingerprint:sha256:… |

### drift check

Run a drift check of a target now (expected vs. live schema).

```text
exponetdb drift check <target>
```

Runs: against the server; effect: plan; action: `drift.check`; scopes: `schema.read`; output: `DriftCheck`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |

### diagnose query-stats

Normalized statements of a target with calls, time, rows and I/O over a window (pg_stat_statements).

CAPABILITY_UNAVAILABLE when pg_stat_statements is not installed or not preloaded. Statement text has its constants removed and is replaced when it could carry a secret; it is printed as data. A regression compares the last 24 hours with the last 7 days; migrations in between are a time coincidence, never a proven cause.

```text
exponetdb diagnose query-stats <target> [flags]
```

Runs: against the server; effect: read; action: `query_stats.list`; scopes: `diagnostics.read`; output: `QueryStats`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--from <time>` | Window start (RFC 3339). |
| `--to <time>` | Window end (RFC 3339). |
| `--order <total_time\|mean_time\|calls\|io>` | Order of the statements. |
| `--limit <number>` | Statements to show (1 to 500). |

### diagnose table-stats

Table and index sizes, scans, vacuum state, estimated bloat and transaction id age of a target.

Bloat is an estimate (a heuristic page estimate, never measured). "Unused" means unused since the statistics were reset or the server started (shown as Since).

```text
exponetdb diagnose table-stats <target> [flags]
```

Runs: against the server; effect: read; action: `table_stats.list`; scopes: `diagnostics.read`; output: `TableStats`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--schema <name>` | Only this schema. |
| `--limit <number>` | Tables to show (1 to 1000). |

### diagnose advisors

Run the live advisors of a target (read-only): security, performance, operations, change safety.

The server records each result as a finding (deduplicated). A rule that did not run is listed with its reason and is never a pass. A fix that can be drafted is a migration draft for review, never run here.

```text
exponetdb diagnose advisors <target> [flags]
```

Runs: against the server; effect: read; action: `advisor.run`; scopes: `diagnostics.read`; output: `AdvisorRun`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--category <security,performance,operations,change_safety>` | Categories to run (default security,performance). |

### session list

Sessions of a target with redacted statements (the pid and start times the session actions take).

```text
exponetdb session list <target> [flags]
```

Runs: against the server; effect: read; action: `session.list`; scopes: `diagnostics.read`; output: `SessionList`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--state <state>` | Only this state (e.g. active). |
| `--min-age <seconds>` | Only sessions at least this old. |
| `--application <name>` | Only this application_name. |
| `--limit <number>` | Sessions to show (1 to 1000). |

### session cancel

Cancel a session’s running query (inline, low): only while the same backend runs the same query.

Bound to the pid, the backend start and the query start you saw (`session list`), re-checked in the cancelling statement; never a replication, backup or ExponetDB session. Production needs connections.operate:prod. Waits by default.

```text
exponetdb session cancel <target> <pid> [flags]
```

Runs: against the server; effect: mutation; action: `connections.cancel`; scopes: `connections.operate:nonprod`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `pid` (required) | The backend process id. |
| `--backend-start <time>` | The session’s backend start (RFC 3339, as `session list` shows it). (required) |
| `--query-start <time>` | The query start (RFC 3339, as `session list` shows it). (required) |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### session terminate

Plan terminating a session, bound to its pid and backend start; the condition is re-checked when it is terminated.

stalled: active, waiting on the client, query 60 s or older; idle_in_transaction: idle in a transaction for 60 s or more; long_running: active, query 300 s or older; any. Production needs connections.operate:prod, and an agent’s production plan a human approval.

```text
exponetdb session terminate <target> <pid> [flags]
```

Runs: against the server; effect: plan; action: `connections.terminate.plan`; scopes: `connections.operate:nonprod`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `pid` (required) | The backend process id. |
| `--backend-start <time>` | The session’s backend start (RFC 3339, as `session list` shows it). (required) |
| `--condition <stalled\|idle_in_transaction\|long_running\|any>` | What must still hold when the session is terminated. (required) |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

## Backups and restores

### backup overview

Backup protection of every cluster you may read: state, measured RPO, last verified backup and drills.

Computed by the server from the catalog mirror. The counts cover every cluster you may read; the table is a page (--limit, --all, --cursor).

```text
exponetdb backup overview [flags]
```

Runs: against the server; effect: read; action: `backup.overview`; scopes: `backups.read`; output: `BackupOverview`.

| Argument or flag | Meaning |
|---|---|
| `--state <protected\|at_risk\|unprotected\|unproven\|unknown>` | Only clusters with this protection state. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### backup list

A cluster’s backups from the catalog mirror, with its protection, repositories and WAL coverage.

A backup the latest engine catalog no longer lists is marked "missing in engine" and never counts as protection. The backups are paged (--limit, --all, --cursor); refresh the mirror with `backup refresh`.

```text
exponetdb backup list <cluster> [flags]
```

Runs: against the server; effect: read; action: `backup.list`; scopes: `backups.read`; output: `BackupCatalog`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### backup repositories

The backup repositories of a cluster: ownership, lock capability, engine advisory and reconciliation.

The location (endpoint, bucket, prefix, stanza) is shown only to callers with registry.manage; a key or credential is never shown.

```text
exponetdb backup repositories <cluster>
```

Runs: against the server; effect: read; action: `backup.repository.list`; scopes: `backups.read`; output: `BackupRepositoryList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |

### backup policy show

The active backup policy of a cluster: schedules, retention, objectives, drill cadence.

```text
exponetdb backup policy show <cluster>
```

Runs: against the server; effect: read; action: `backup.policy.get`; scopes: `backups.read`; output: `BackupPolicyView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |

### backup runs

Engine runs of a cluster: backups, verifies, expiry, restores and discards.

A run that is lost (it disappeared, e.g. a host reboot) or unknown (the node could not be asked) is never retried automatically for restores, expiry or verification.

```text
exponetdb backup runs <cluster> [flags]
```

Runs: against the server; effect: read; action: `backup.run.list`; scopes: `backups.read`; output: `EngineRunList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### backup adopt

Plan adopting an existing backup repository for read-only observation (nothing changes on the host or in the bucket).

The file names layer, engine, provider and location (endpoint host, region, bucket, prefix, and for pgBackRest the stanza and repository index), and optionally priority, purpose, the declared lock mode, cipher and pinned engine version. It never holds a key or a credential: the engine reads them on the host (secret source host_config). The repository starts as adopted_observed.

```text
exponetdb backup adopt <cluster> [flags]
```

Runs: against the server; effect: plan; action: `backup.repository.adopt.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

```sh
exponetdb backup adopt cls_01J… --file repository.yaml
```

### backup ownership

Plan what ExponetDB may do with an adopted repository (adopted_runs: start runs with the host configuration).

adopted_runs lets ExponetDB start incremental backups and verifies with the configuration the host already has, never changing configuration, schedules, keys or retention; --host-configuration-unchanged states that and is required. owned is refused by the server until its capability exists.

```text
exponetdb backup ownership <repository> [flags]
```

Runs: against the server; effect: plan; action: `backup.repository.ownership.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `repository` (required) | A backup repository id (bkr_…). |
| `--to <adopted_runs\|owned>` | The ownership to plan. (required) |
| `--host-configuration-unchanged` | Acknowledge that the host configuration, schedules, keys and retention stay as they are. (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### backup retire-repository

Plan retiring a backup repository record: it is no longer observed or used; nothing in storage is deleted.

```text
exponetdb backup retire-repository <repository> [flags]
```

Runs: against the server; effect: plan; action: `backup.repository.retire.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `repository` (required) | A backup repository id (bkr_…). |
| `--storage-kept` | Acknowledge that nothing in the bucket or on the host is deleted; only the record leaves ExponetDB. (required) |
| `--no-longer-protected` | Acknowledge that the cluster is no longer protected by this repository through ExponetDB. (required) |
| `--reason <text>` | Why. |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### backup policy set

Plan a new revision of a cluster’s backup policy (high: a person applies it with a fresh re-authentication).

The file holds schedules (kind, repository, five-field UTC cron, enabled), retention, the archive timeout, the RPO and RTO objectives, the drill cadence and the size floor.

```text
exponetdb backup policy set <cluster> [flags]
```

Runs: against the server; effect: plan; action: `backup.policy.set.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

```sh
exponetdb backup policy set cls_01J… --file policy.yaml
```

### backup refresh

Read the engine catalog of every observed repository of a cluster through its node into the mirror.

An inline operation (low): the node runs backup.list@1 and the mirror is reconciled. Waits by default; exit 0 only when it succeeded.

```text
exponetdb backup refresh <cluster> [flags]
```

Runs: against the server; effect: mutation; action: `backup.catalog.refresh`; scopes: `backups.run`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### backup run

Plan a backup run into one repository (refused unless backup execution is activated and the repository allows runs).

```text
exponetdb backup run <cluster> [flags]
```

Runs: against the server; effect: plan; action: `backup.run.plan`; scopes: `backups.run`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--repository <bkr_…>` | A backup repository id (bkr_…). (required) |
| `--kind <full\|differential\|incremental\|logical>` | The backup kind. (required) |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### backup verify

Verify one backup with the engine’s verify command; it counts as verified only after the run passed.

An inline operation (low). Waits by default; exit 0 only when the verify passed.

```text
exponetdb backup verify <cluster> <backup> [flags]
```

Runs: against the server; effect: mutation; action: `backup.verify`; scopes: `backups.run`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `backup` (required) | A backup id (bkp_…). |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### restore plan

Plan a recovery of a target into a new cluster directory on a node (never in place); a person applies it with `plan apply`.

The file names purpose recovery, the repository, the source (backupId, pointInTime or latest: true), the destination (kind new_cluster, nodeId) and the reason (an incident reference). The plan is shown, never run here: a person reviews it and applies it with `exponetdb plan apply <plan>`, which asks for a fresh re-authentication in the browser (restore.execute, human only). Switching the target to the restored cluster is a separate placement plan.

```text
exponetdb restore plan <target> [flags]
```

Runs: against the server; effect: plan; action: `restore.plan`; scopes: `restore.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `target` (required) | A target id or path. |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |

```sh
exponetdb restore plan demo/platform/staging --file recovery.yaml
exponetdb plan apply pln_01J…
```

### restore list

Restores of a cluster (drills and recoveries) with their phases and checks.

```text
exponetdb restore list <cluster> [flags]
```

Runs: against the server; effect: read; action: `restore.list`; scopes: `backups.read`; output: `RestoreList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### restore discard

Plan discarding a scratch restore: stop its temporary cluster and remove its directory on the node.

Human only (restore.execute); applying it asks for a fresh re-authentication in the browser.

```text
exponetdb restore discard <cluster> <restore> [flags]
```

Runs: against the server; effect: plan; action: `restore.discard.plan`; scopes: `restore.execute`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `restore` (required) | A restore id (rst_…). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

### restore runbook

Write the offline restore runbook of a repository (plain POSIX shell, placeholders for every secret) to a new file.

The runbook restores without ExponetDB (C-35). It is written to a new file with mode 0700 and never over an existing one; `--out -` prints it to stdout (the digest and placeholders go to stderr). The script is checked against its digest before it is written; the download is audited.

```text
exponetdb restore runbook <cluster> [flags]
```

Runs: against the server; effect: read; action: `restore.runbook.get`; scopes: `restore.plan`; output: `RestoreRunbook`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--repository <bkr_…>` | A backup repository id (bkr_…). (required) |
| `--out <file|->` | A new file for the script, or - for stdout. (required) |

```sh
exponetdb restore runbook cls_01J… --repository bkr_01J… --out ./restore.sh
```

### drill plan

Plan a restore drill into scratch on a node: the latest backup, an older one, a random point in time, or a named backup or time.

A drill always restores into a scratch directory, never over a cluster. Applying it is human only (restore.execute) with a fresh re-authentication in the browser.

```text
exponetdb drill plan <cluster> [flags]
```

Runs: against the server; effect: plan; action: `restore.drill.plan`; scopes: `restore.plan`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--repository <bkr_…>` | A backup repository id (bkr_…). Required unless --file is given. |
| `--selection <latest|older|pitr_random|backup:<bkp_…>|pitr:<time>>` | What to restore. Required unless --file is given. |
| `--node <nod_…>` | The node to restore on (default: the cluster’s own node). |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). |
| `--apply` | Apply the plan at once and wait until applied and verified. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

```sh
exponetdb drill plan cls_01J… --repository bkr_01J… --selection pitr_random
exponetdb drill plan cls_01J… --repository bkr_01J… --selection pitr:2026-10-20T08:00:00Z
```

### drill list

Drills of a cluster with their outcome and measured duration.

A drill recorded from the offline runbook is an attestation and shows as such.

```text
exponetdb drill list <cluster> [flags]
```

Runs: against the server; effect: read; action: `restore.list`; scopes: `backups.read`; output: `DrillList`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### drill record-offline

Record a drill you ran from the offline runbook with the Control Plane stopped: an attestation, shown as such.

Your statement of what you ran, where, and what you checked, with the runbook digest, the restore time, the duration and the outcome (no secrets in the notes). It is recorded as an attestation (mode offline_runbook), never as a drill ExponetDB observed. Human only (restore.execute) with a fresh re-authentication.

```text
exponetdb drill record-offline <cluster> [flags]
```

Runs: against the server; effect: mutation; action: `restore.drill.offline.record`; scopes: `restore.execute`; output: `Drill`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id (cls_…). |
| `--file <path>` | The request as a JSON or YAML file (checked against the contract). (required) |

```sh
exponetdb drill record-offline cls_01J… --file drill-record.yaml
```

## Access and audit

### audit list

Audit events, newest first (actors pseudonymous).

```text
exponetdb audit list [flags]
```

Runs: against the server; effect: read; action: `audit.search`; scopes: `audit.read`; output: `AuditEventList`.

| Argument or flag | Meaning |
|---|---|
| `--from <time>` | From this time (ISO 8601). |
| `--to <time>` | Before this time (ISO 8601). |
| `--target <tgt_…>` | Only events about this target. |
| `--action <action>` | Only this action, e.g. plan.apply. |
| `--mine` | Only your own events. |
| `--result <succeeded\|failed\|denied>` | Only this result. |
| `--client <cli_…>` | Only events made through this client (runbook RB-11, RB-15). |
| `--grant <grt_…>` | Only events made through this grant. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### audit show

One audit event by id (searched newest first within the filters).

```text
exponetdb audit show <event> [flags]
```

Runs: against the server; effect: read; action: `audit.search`; scopes: `audit.read`; output: `AuditEvent`.

| Argument or flag | Meaning |
|---|---|
| `event` (required) | The event id (aud_…). |
| `--from <time>` | Search from this time. |
| `--target <tgt_…>` | Search this target’s events. |

### access identities

Identities (people and service accounts).

```text
exponetdb access identities [flags]
```

Runs: against the server; effect: read; action: `identity.list`; scopes: `access.read`; output: `IdentityList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### access roles

The built-in roles and their permissions.

```text
exponetdb access roles
```

Runs: against the server; effect: read; action: `role.list`; scopes: `access.read`; output: `RoleList`.

### access bindings

Role bindings (who holds which role where).

```text
exponetdb access bindings [flags]
```

Runs: against the server; effect: read; action: `role_binding.list`; scopes: `access.read`; output: `RoleBindingList`.

| Argument or flag | Meaning |
|---|---|
| `--identity <idn_…>` | Only this identity. |
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

### access grants

Your own OAuth grants (applications you connected).

```text
exponetdb access grants
```

Runs: against the server; effect: read; action: `oauth.grant.list_own`; output: `GrantList`.

### access clients

Registered OAuth clients (names are untrusted text).

```text
exponetdb access clients [flags]
```

Runs: against the server; effect: read; action: `oauth.client.list`; scopes: `access.read`; output: `OAuthClientList`.

| Argument or flag | Meaning |
|---|---|
| `--limit <number>` | Items to show (1 to 10000). (default 50) |
| `--all` | Every page (at most 10000 items). |
| `--cursor <cursor>` | Continue after a previous page. |

## Local test lab

### dev up

Create or start a local lab: Control Store, staging and production targets, serve, worker and gateway.

Builds the server image from the source checkout at its current commit (or uses --image), then sets the installation up like an operator: the image’s bootstrap SQL, control-store migrate, a keyring, one login per role. A stopped lab starts again; a lab whose image is older than the source refuses until --rebuild or --keep-image.

```text
exponetdb dev up [flags]
```

Runs: locally; effect: local; output: `LabStatus`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--image <ref>` | Use this ExponetDB image instead of building one. |
| `--source <dir>` | The ExponetDB source checkout to build from (default: the one around the working directory). |
| `--postgres <16\|17\|18>` | PostgreSQL major of the targets (new lab only; default 17). |
| `--port <number>` | Loopback port of serve (new lab only; default 8480). |
| `--rebuild` | Move an existing lab to an image of the current source. |
| `--keep-image` | Start an existing lab with its image even though the source moved on. |

```sh
exponetdb dev up
exponetdb dev up --postgres 18 --lab pg18
exponetdb dev up --image exponetdb:ci
```

### dev status

The lab’s roles and readiness, its image against the source, the active and the last run (exit 0 only when ready).

```text
exponetdb dev status [flags]
```

Runs: locally; effect: read; output: `LabStatus`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |

### dev owner

Issue the first-owner setup link of the lab into a new private file (or open it in the browser).

Runs `bootstrap owner` of the lab’s image with the serve login. The link is a single-use secret valid 30 minutes: it is written to a new 0600 file in the lab’s state, never printed; --open hands it to the browser.

```text
exponetdb dev owner [flags]
```

Runs: locally; effect: local; output: `LabOwnerLink`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--email <address>` | The owner’s email address. (required) |
| `--display-name <text>` | The owner’s display name. |
| `--reissue` | Replace a pending setup link (the earlier one stops working). |
| `--open` | Open the setup link in the browser. |

### dev mcp-client

Register the lab’s local MCP client (usable at once; a person consents at sign-in).

Registers one public MCP client with the lab through Dynamic Client Registration, as any MCP client would: no secret, PKCE, loopback redirect URIs on any port (Claude Code, Codex, VS Code, the MCP Inspector, the SDK harness). The lab admits new clients openly like the default installation (EXPONETDB_OAUTH_CLIENT_REGISTRATION=open): the client is approved automatically, and a person still signs in and consents with a passkey before it gets a token. The client ID is kept in the lab’s state and printed; it is not a secret.

```text
exponetdb dev mcp-client [flags]
```

Runs: locally; effect: local; output: `LabMcpClient`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |

### dev logs

A role’s container log, or a test run’s own log.

```text
exponetdb dev logs [role] [flags]
```

Runs: locally; effect: read; output: `LabLog`.

| Argument or flag | Meaning |
|---|---|
| `role` | One of control, staging, production, serve, worker, gateway (or --run). |
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--run <run_…>` | Show the log of this test run instead. |
| `--follow` | Keep printing new lines (role logs, table output). |
| `--tail <number>` | Only the last lines. |
| `--since <time>` | Only lines since this time (e.g. 10m, 2026-10-12T10:00:00Z). |

### dev shell

A shell in one of the lab’s containers (a terminal is needed).

```text
exponetdb dev shell <role> [flags]
```

Runs: locally; effect: local; output: `none`.

| Argument or flag | Meaning |
|---|---|
| `role` (required) | One of control, staging, production, serve, worker, gateway. |
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |

### dev sql

psql in one of the lab’s own databases (control, staging, production), as its local superuser.

For the lab only: e.g. to apply the roles script a cluster registration generates, or to look at a test database. Interactive on a terminal; otherwise the SQL comes from --file or stdin. Never reaches a registered target or a server.

```text
exponetdb dev sql <database> [flags]
```

Runs: locally; effect: local; output: `LabSql`.

| Argument or flag | Meaning |
|---|---|
| `database` (required) | control, staging or production. |
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--file <path>` | Run this SQL file (ON_ERROR_STOP). |
| `--db <name>` | The database inside (default exponetdb_control or postgres). |

```sh
exponetdb dev sql staging --file roles.sql
exponetdb dev sql control
```

### dev test

Run a suite with its own run record and log: smoke (the lab), unit, integration, install, host:<scenario>.

smoke checks the running lab (every role, TLS on the targets, the server surface, no secret in a log). The other suites run the repository’s own entrypoints from the source checkout, like CI. One run holds the lab at a time; a missing environment ends lab_unavailable (exit 5), a failing suite failed (exit 1, its real exit code in the record).

```text
exponetdb dev test <suite> [flags]
```

Runs: locally; effect: local; output: `LabRun`.

| Argument or flag | Meaning |
|---|---|
| `suite` (required) | smoke, unit, integration, install, host:<scenario> |
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--source <dir>` | The source checkout (default: the lab’s, or the one around the working directory). |

```sh
exponetdb dev test smoke
exponetdb dev test unit
sudo -E exponetdb dev test host:config
```

### dev runs

The lab’s test runs, newest first, each with its own outcome.

```text
exponetdb dev runs [flags]
```

Runs: locally; effect: read; output: `LabRunList`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |

### dev export

Write the lab’s logs, container facts (no environment) and run records into a new directory.

```text
exponetdb dev export [flags]
```

Runs: locally; effect: local; output: `LabExport`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--output <dir>` | A new directory (default below the CLI’s lab-exports). |

### dev stop

Stop the lab’s containers; volumes, secrets and runs stay (dev up starts it again).

```text
exponetdb dev stop [flags]
```

Runs: locally; effect: local; output: `LabStatus`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--interrupt` | Stop a test run that holds the lab (recorded as interrupted) instead of refusing. |

### dev reset

Export, then replace the lab’s databases and containers with new ones (same lab ID, image and port).

```text
exponetdb dev reset [flags]
```

Runs: locally; effect: local; output: `LabStatus`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--interrupt` | Stop a test run that holds the lab (recorded as interrupted) instead of refusing. |
| `--yes` | Confirm deleting the lab’s databases. |

### dev destroy

Export, then remove every container, volume and the network of the lab, and its state.

```text
exponetdb dev destroy [flags]
```

Runs: locally; effect: local; output: `LabExport`.

| Argument or flag | Meaning |
|---|---|
| `--lab <id>` | The lab ID (default local, or EXPONETDB_LAB). |
| `--interrupt` | Stop a test run that holds the lab (recorded as interrupted) instead of refusing. |
| `--yes` | Confirm removing the lab. |

## Local secret utilities

### secrets scram-verifier

Turn a password into a PostgreSQL SCRAM-SHA-256 verifier, locally (the password never leaves this machine).

Reads the password from the terminal without echo (twice), or from stdin with --stdin; never from an argument or the environment. Writes the verifier to a new 0600 file (--file), or to stdout only with the explicit --stdout. A verifier is sensitive: it allows an offline guessing attack on the password.

```text
exponetdb secrets scram-verifier [flags]
```

Runs: locally; effect: local; output: `ScramVerifier`.

| Argument or flag | Meaning |
|---|---|
| `--file <path>` | A new file for the verifier (0600). |
| `--stdout` | Print the verifier to stdout instead (opt-in, for automation). |
| `--stdin` | Read the password from stdin (one line). |
| `--iterations <number>` | PBKDF2 iterations (4096 to 1000000). (default 4096) |

## Global flags

| Flag | Meaning |
|---|---|
| `--help` (`-h`) | Show help for the command. |
| `--version` | Show the CLI version and build (no network). |
| `--server <url>` | Server origin (https; http only on a loopback host). |
| `--profile <name>` | Use a named profile. |
| `--workdir <dir>` | Directory to search the project file from (default: the current one). |
| `--output <table\|json\|ndjson>` (`-o`) | Output format. |
| `--json` | Same as --output json. |
| `--color <auto\|always\|never>` | Color (auto follows the terminal, NO_COLOR and TERM). |
| `--no-color` | Same as --color never. |
| `--no-input` | Never prompt and never open a browser; end with the exit code instead. |
| `--yes` | Skip local, non-security confirmations (never a permission, approval, re-authentication or evidence). |
| `--quiet` (`-q`) | Results only, no hints. |
| `--verbose` (`-v`) | Safe diagnostics on stderr. |
| `--timeout <duration>` | Per-request deadline, e.g. 30s or 2m (default 30s). |
