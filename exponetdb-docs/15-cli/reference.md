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
| [`target list`](#target-list) | remote | read | List targets with tier, state and health. |
| [`target show`](#target-show) | remote | read | Show a target: placement, ledger, health, findings. |
| [`target register`](#target-register) | remote | plan | Plan registering a database of a cluster as a target of a project environment. |
| [`target suspend`](#target-suspend) | remote | plan | Plan to suspend a target (with a reason). |
| [`target resume`](#target-resume) | remote | plan | Plan to resume a target (with a reason). |
| [`target decommission`](#target-decommission) | remote | plan | Plan to decommission a target (with a reason). |
| [`server list`](#server-list) | remote | read | List servers. |
| [`server show`](#server-show) | remote | read | Show a server and the facts its node reported. |
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
| [`cluster database register`](#cluster-database-register) | remote | plan | Plan registering a database of a cluster. |
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
| [`migration import report`](#migration-import-report) | remote | read | An import report: every legacy file’s classification and the decisions so far. |
| [`migration import resolve`](#migration-import-resolve) | remote | mutation | Record your decision for one item of an import report (with a note). |
| [`migration import baseline`](#migration-import-baseline) | remote | plan | Plan the baseline of a resolved import report (records the legacy ledger; changes no schema). |
| [`plan show`](#plan-show) | remote | read | Show a plan: subject, decision, requirements, content and analysis. |
| [`plan list`](#plan-list) | remote | read | List plans you may read, newest first (filter by target, kind, state). |
| [`plan export`](#plan-export) | remote | read | Write a plan as JSON (to stdout, or to a new private file with --file). |
| [`plan apply`](#plan-apply) | remote | mutation | Apply a stored plan and wait until it is applied and verified. |
| [`plan withdraw`](#plan-withdraw) | remote | mutation | Withdraw your own active plan (it can no longer be applied). |
| [`operation list`](#operation-list) | remote | read | List operations you may read, newest first. |
| [`operation show`](#operation-show) | remote | read | Show an operation: state, apply and verification outcomes, steps and migrations. |
| [`operation watch`](#operation-watch) | remote | read | Watch an operation until it is final (exit 0 only when applied and verified). |
| [`operation cancel`](#operation-cancel) | remote | mutation | Cancel an operation that has not started (awaiting approval or queued). |
| [`approval list`](#approval-list) | remote | read | List operations awaiting approval that you may read. |
| [`approval show`](#approval-show) | remote | read | Show what an approval decides: the operation, its plan and the plan hash. |
| [`approval open`](#approval-open) | remote | read | Open the bound approval page in the browser. |
| [`approval approve`](#approval-approve) | remote | read | Open the approval page to approve (re-authentication there), then wait for the decision. |
| [`approval reject`](#approval-reject) | remote | read | Open the approval page to reject (re-authentication there), then wait for the decision. |
| [`health`](#health) | remote | read | A target’s health: probes, conditions, node and backups, with source and time. |
| [`finding list`](#finding-list) | remote | read | Findings of a target (drift, health, security), open by default. |
| [`finding show`](#finding-show) | remote | read | One finding of a target. |
| [`schema overview`](#schema-overview) | remote | read | The schemas of a target with object counts, its fingerprint and what is visible. |
| [`schema search`](#schema-search) | remote | read | Search a target’s catalog by name. |
| [`schema show`](#schema-show) | remote | read | One catalog object: columns, constraints, indexes, grants, policies (definitions are untrusted text). |
| [`schema fingerprint`](#schema-fingerprint) | remote | read | A target’s schema fingerprint (what plans and evidence bind). |
| [`schema diff`](#schema-diff) | remote | read | Compare two targets (or a target and a fingerprint) object by object. |
| [`drift check`](#drift-check) | remote | plan | Run a drift check of a target now (expected vs. live schema). |
| [`audit list`](#audit-list) | remote | read | Audit events, newest first (actors pseudonymous). |
| [`audit show`](#audit-show) | remote | read | One audit event by id (searched newest first within the filters). |
| [`access identities`](#access-identities) | remote | read | Identities (people and service accounts). |
| [`access roles`](#access-roles) | remote | read | The built-in roles and their permissions. |
| [`access bindings`](#access-bindings) | remote | read | Role bindings (who holds which role where). |
| [`access grants`](#access-grants) | remote | read | Your own OAuth grants (applications you connected). |
| [`access clients`](#access-clients) | remote | read | Registered OAuth clients (names are untrusted text). |
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

Opens the authorization page of the server (loopback redirect, PKCE S256). With --device the CLI shows a code to enter on another device; the device flow never carries a production or administrative scope. Production and administrative scopes need explicit consent in the browser.

```text
exponetdb login [flags]
```

Runs: against the server; effect: session; output: `SignIn`.

Aliases: `auth login`.

| Argument or flag | Meaning |
|---|---|
| `--scope <scopes>` | Scopes to ask for, space or comma separated (default targets.read). |
| `--device` | Use the device flow (a code to type elsewhere). |
| `--no-browser` | Print the sign-in URL without opening a browser. |

```sh
exponetdb login --server https://db.example.com
exponetdb login --scope "targets.read migrations.plan migrations.apply:nonprod"
exponetdb login --device
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
| `--scopes <a,b>` | Service account scopes. |
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
exponetdb product create <slug> [flags]
```

Runs: against the server; effect: plan; action: `registry.product.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `slug` (required) | Lowercase slug (the first segment of target paths). |
| `--name <text>` | Display name. (required) |
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
exponetdb environment create <product> <slug> [flags]
```

Runs: against the server; effect: plan; action: `registry.environment.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `slug` (required) | Lowercase slug. |
| `--name <text>` | Display name. (required) |
| `--tier <prod\|nonprod>` | The tier. (required) |
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
exponetdb project create <product> <slug> [flags]
```

Runs: against the server; effect: plan; action: `registry.project.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `product` (required) | A product id or slug. |
| `slug` (required) | Lowercase slug. |
| `--name <text>` | Display name. (required) |
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
| `--project <prj_…>` | The project. (required) |
| `--environment <env_…>` | The environment. (required) |
| `--database <dbs_…>` | The registered database. (required) |
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

### server create

Plan a server record.

```text
exponetdb server create <name> [flags]
```

Runs: against the server; effect: plan; action: `registry.server.create.plan`; scopes: `registry.manage`; output: `PlanView`.

| Argument or flag | Meaning |
|---|---|
| `name` (required) | Display name. |
| `--provider <hetzner_cloud\|hetzner_robot\|other\|unknown>` | Hosting provider. (default other) |
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

The SQL is the server’s, generated for this cluster; the CLI never runs it. Review it before a database administrator runs it by hand.

```text
exponetdb cluster bootstrap-sql <cluster> [flags]
```

Runs: against the server; effect: read; action: `cluster.bootstrap_sql.get`; scopes: `registry.manage`; output: `ClusterBootstrapSql`.

| Argument or flag | Meaning |
|---|---|
| `cluster` (required) | A cluster id. |
| `--file <path>` | A new file to write (0600). |

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
| `--label <text>` | Label. (required) |
| `--kind <private\|public\|local_socket\|pooler>` | Kind. (required) |
| `--host <host>` | Host name or address. (required) |
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
| `migration` (required) | The migration id (ULID). |
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

```text
exponetdb migration verify <migration> [flags]
```

Runs: against the server; effect: mutation; action: `migration.verify`; scopes: `migrations.read`; output: `Operation`.

| Argument or flag | Meaning |
|---|---|
| `migration` (required) | The migration id. |
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
| `--baseline <baseline:…>` | The baseline ref (default the project’s). |
| `--ledger <supabase,drizzle,applied_migrations>` | Legacy ledgers to read. |
| `--not-applicable <files>` | Legacy files that never apply to this target. |
| `--apply` | Apply the analysis plan at once and wait. |
| `--wait` | Wait until applied and verified (the default). |
| `--no-wait` | Return once the server accepted the operation. |
| `--timeout-wait <duration>` | How long to wait for the outcome (default 15m). (default 900000) |

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

Findings of a target (drift, health, security), open by default.

```text
exponetdb finding list [flags]
```

Runs: against the server; effect: read; action: `target.finding.list`; scopes: `diagnostics.read`; output: `FindingList`.

| Argument or flag | Meaning |
|---|---|
| `--target <target>` | A target id (tgt_…) or path (product/project/environment). (required) |
| `--include-resolved` | Also resolved findings. |
| `--severity <info\|warning\|critical>` | Only this severity. |
| `--kind <kind>` | Only this kind. |
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
