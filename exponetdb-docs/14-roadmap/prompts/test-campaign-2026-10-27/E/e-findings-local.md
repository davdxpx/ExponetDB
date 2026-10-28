# Test campaign 2026-10-27, tester E: local verification of E1, E4, E5, E8, E9, E11

Target: worktree `/home/david/Development/ExponetDB-testcampaign` at `origin/main` d0229550 (detached, untouched; no
file was created in it). Scratch: `/tmp/claude-1000/-home-david-Development/57931673-29c9-4061-9f45-326970092611/scratchpad/e/`
(`<S>` below). No call to `db.exponet.cloud`; the CLI ran with `EXPONETDB_CONFIG_DIR=<S>/cfg-empty` (the variable of
`apps/cli/src/store.ts:44`), remote scenarios ran in-process against a fake `fetch` (`apps/cli/test/support.ts` seam),
the profile uses a dummy `exak_DUMMY…` key and the loopback origin `http://127.0.0.1:9`. No secret was printed.

| ID | Verdict | Severity | One line |
|---|---|---|---|
| E1 | REPRODUCED | P2 | `enroll` needs `/var/lib/exponetdb-node` (0700, agent-owned); nothing in the release or runbook creates it before `enroll` |
| E4 | REPRODUCED | P2 | no version negotiation; strict closed enums and strict response objects turn any additive change into `RESPONSE_INVALID`; the `incompatible_server` branch is dead code |
| E5 | PARTIAL | P3 | error text and exit 2 reproduce; `node job-keys` is a plan command; a read exists only indirectly (`node inspect agent.diagnostics@2` + `node observations`), not as REST/MCP/`node show` field |
| E8 | REPRODUCED | P3 | `-- covers:` is 0-based, undocumented; 1-based input gives a *blocking* (prod tier) `uncovered_statement`, out-of-range indexes are silently accepted |
| E9 | REPRODUCED | P2 | `migration lint` has no path, bundle or since filter; one flag-less all-or-nothing exit code; lint is ledger-blind |
| E11 | PARTIAL | P3 | `nodes.plan` IS in `operator:nonprod`/`operator:prod`, but not in `admin`/`developer:*`/`read`; presets cannot be combined; `auth presets` truncates the list; 5 commands declare a wrong scope |

---

## E1. `exponetdb-node enroll` fails with `state directory: lstat /var/lib/exponetdb-node` before the units ever started

**Verdict: REPRODUCED. Severity P2.** First contact for every host that follows the runbook literally; the workaround is one
command, but the error does not say what to do and the runbook has no step.

### Reproduction

Go toolchain from the scratchpad, release-style build (no tags), into scratch:

```
cd agent/node && PATH=<go>/bin:$PATH CGO_ENABLED=0 go build -trimpath -buildvcs=false -o <S>/bin/exponetdb-node ./cmd/exponetdb-node
```

`--config` overrides the config path; the config must be root-owned (`main.go:68` `configOwnerUID: 0`), so the binary ran
inside a user namespace (`unshare -Ur`, uid 0 inside, no real privilege). Config in a throwaway dir, `stateDirectory`
pointing at a directory that does not exist (exactly the state of a fresh host before `systemctl start`):

```
$ unshare -Ur <S>/bin/exponetdb-node enroll --config <S>/e1/etc/config.json --token-file <S>/e1/token
state directory: lstat <S>/e1/var/lib/exponetdb-node: no such file or directory
exit=1
$ unshare -Ur <S>/bin/exponetdb-node status --config <S>/e1/etc/config.json      # same for status / run / journal init
state directory: lstat <S>/e1/var/lib/exponetdb-node: no such file or directory
exit=1
```

Follow-on traps, same binary:

```
$ mkdir -m 755 <state>; ... enroll ...   -> state directory <state> is readable by others (0755)
$ chmod 700 <state>;     ... enroll ...   -> enroll: the token is not valid (invalid_format)    # state check passed; token was dummy
                                              (creates identity/ journal/ buffer/ and lock)
```

The sysusers file does not create the home directory either (ran `systemd-sysusers --root=<S>/e1/root` with the shipped
file: user created with home `/var/lib/exponetdb-node`, `ls <root>/var/lib` shows nothing).

### Root cause (proved from code and packaging)

- `agent/node/cmd/exponetdb-node/main.go:126` `state.Open(cfg.StateDirectory, os.Getuid())` runs before the command switch,
  so `enroll`, `run`, `status`, `journal init` all need the directory.
- `agent/node/internal/state/state.go:103-122` `Open` only checks and creates the three subdirectories; `fsutil.go:153-156`
  `CheckOwnedPrivate` starts with `os.Lstat` (the message). The agent runs as `exponetdb-node`, which cannot create a
  directory under root-owned `/var/lib`, so the code cannot fix this alone.
- `agent/node/packaging/systemd/exponetdb-node.service:34-35` `StateDirectory=exponetdb-node` / `StateDirectoryMode=0700`:
  systemd creates it only when the unit starts, but the runbook enrolls first and starts last
  (`exponetdb-docs/12-operations/node-runbook.md:119` enroll, `:139` `systemctl enable --now`) and the unit comment says
  "never enabled before the host is enrolled".
- `agent/node/packaging/sysusers.d/exponetdb-node.conf:2` names the home only. `tmpfiles.d/exponetdb-node-engine.conf` has no
  line for `/var/lib/exponetdb-node`.
- Runbook has **no step** for it: §2 step 1 (`node-runbook.md:34-46`) installs binaries, sysusers, units, doc,
  `daemon-reload`; no `install -d`, no `systemd-tmpfiles`. Related gap in the same block: `build.sh:44-52` and
  `packaging/README.md:14` ship `tmpfiles.d/exponetdb-node-engine.conf` (the `/var/lib/exponetdb-node-engine/{runs,scratch,reads}`
  dirs of the backup and restore runs), but §2 never installs it nor runs `systemd-tmpfiles --create`
  (`grep tmpfiles node-runbook.md` is empty); the helper unit tolerates the missing dir (`-/var/lib/…` in `ReadWritePaths`),
  so backups would fail later, not at install.
- The host test (`apps/server/test/agent-capabilities.host.test.ts:352`) swaps `StateDirectory=` for a pre-created
  `ReadWritePaths`, so CI never exercises the fresh-host order.

### Suggested fix

1. `agent/node/packaging/tmpfiles.d/exponetdb-node.conf` (new, installed by `build.sh` next to the engine file):
   `d /var/lib/exponetdb-node 0700 exponetdb-node exponetdb-node -` (syntax checked with `systemd-tmpfiles --root … --create`:
   the dir is created 0700; the chown only fails inside my unprivileged namespace because uid 999 is unmapped).
   `StateDirectory=` coexists (systemd adopts the existing directory).
2. `node-runbook.md` §2 step 1: add `install -m 0644 tmpfiles.d/*.conf /usr/lib/tmpfiles.d/` and `systemd-tmpfiles --create`
   after `systemd-sysusers` (this also fixes the engine dirs); list `tmpfiles.d/` in the paragraph after the block.
3. `state.Open` (`state.go:105`): on `ErrNotExist` return `state directory %s does not exist: create it as the agent user
   (mode 0700), see node-runbook.md §2` instead of the bare lstat text.

### Acceptance test

- Go: `agent/node/cmd/exponetdb-node/main_test.go` `TestEnrollMissingStateDirectoryExplainsFix`: `run(ctx, []string{"enroll","--config",cfg,"--token-file",tok}, d)`
  with `stateDirectory` absent returns 1 and stderr contains `does not exist` and `node-runbook.md`.
- Packaging: extend `agent/node/packaging/verify-units.sh` (already builds a scratch root): `systemd-sysusers --root` +
  `systemd-tmpfiles --root --create` (run under `unshare -r` or as root in CI job `node-pg`), then assert
  `stat -c '%a' $root/var/lib/exponetdb-node` is `700` and `grep -q 'd /var/lib/exponetdb-node 0700'` on the shipped file.
- Docs: a test or CI grep that `node-runbook.md` §2 contains `systemd-tmpfiles --create` (or an `install -d … /var/lib/exponetdb-node`).

---

## E4. An older CLI answers `RESPONSE_INVALID` against the new contract instead of saying it is too old

**Verdict: REPRODUCED (and wider than reported). Severity P2.** Every command of an older CLI breaks as soon as a newer
server adds a value to one of the 175 closed response enums, or a field to one of 27 strict response objects, and the user
gets a contract error with no "update the CLI" hint. The advertised `incompatible_server` check cannot fire.

### How the CLI validates

`apps/cli/src/cli/remote.ts:26` `matchesContract` = `ROUTES.get(op).response.schema.safeParse(body).success`, wired as
`validate` into the SDK at `remote.ts:182`; `packages/sdk/src/transport.ts:205-226` returns `RESPONSE_INVALID` (status +
`x-request-id`, no message) when the body fails. `connect()` first calls `sdk.installation.get()` (`remote.ts:198`), so a
failure of the installation body kills *every* remote command before the version check at `remote.ts:200-205`.

### Negotiation that exists / does not

- Exists: `GET /installation` carries `version`, `contracts.*` and `features[]` (`packages/contracts/src/rest/resources.ts:2032-2056`);
  the CLI sends `User-Agent: exponetdb-cli/<ver>` (`remote.ts:183`) and prints the server `version` in `whoami`/`doctor`
  (hard-coded text "REST v1", `tools.ts:~149`).
- Does not exist: no `x-exponetdb-api-version` header (grep over `apps/server`, `packages/contracts`: only the unrelated
  `x-exponetdb-wave` OpenAPI extension), no minimum-CLI field, the CLI never compares `version` with `CLI_VERSION`
  (`apps/cli/src/version.ts:11` `0.6.0`), and never reads `features`.

### Reproduction (in-process CLI, fake server, real validators; script `<S>/e4/run.ts`)

Walker over all 193 routes (`<S>/e4/walk.ts`): 27 response objects are `strictObject` (e.g. `listNodes` capability refs,
`getBackupPolicy`, `getMe`, `listMyGrants`, `listNodeObservations`, `revealEnrollmentToken`, `exportAuditEvents`, `getBundle`
revisions, `getPlan` policy rules), 176 response enums of which only 1 is marked `x-extensible-enum`.

```
[baseline whoami]                                         exit=0
[A unknown top-level key + unknown contracts key]         exit=0   (non-strict objects strip: the documented behavior)
[B installation.oauthClientRegistration = "invite"]       exit=5   {"code":"RESPONSE_INVALID","message":"The server answered something this CLI cannot read as the contract."}
[C installation.contracts.restApi = "v2"]                 exit=5   {"code":"RESPONSE_INVALID", ...same text}    <- not incompatible_server
[D installation.contracts.mcpCatalog = "exponetdb.mcp/v2"] exit=5 {"code":"RESPONSE_INVALID", ...}
[baseline node list]                                      exit=0
[E node gets additive field region]                       exit=0
[F node.state = "quarantined" (closed enum)]              exit=5   {"code":"RESPONSE_INVALID","message":"The server refused the request."}
[G capabilities[] entry gets additive field deprecated]   exit=5   {"code":"RESPONSE_INVALID","message":"The server refused the request."}

[F, human output]  (exit 5)
ExponetDB · nodes                                  Profile: p
Server: http://127.0.0.1:9
No nodes you may read.
0 nodes
Error RESPONSE_INVALID: The server refused the request.
  (request req_demo)
```

Observations:

1. `incompatible_server` (`remote.ts:200-205`, documented `15-cli/install.md:39,121`) is unreachable: `InstallationSchema`
   has `restApi: z.literal('v1')` (`resources.ts:2040`), so the schema check fails first (case C).
2. `versioning.md §2` (`exponetdb-docs/01-architecture/versioning.md:48`) says "clients must ignore unknown fields; the SDK does".
   True for plain `z.object`; false for the 27 strict response objects (G). New enum values are allowed only for open enums,
   but 175 of 176 response enums are closed, so most status-like fields cannot grow without breaking old CLIs (F).
3. List commands show the wrong text and a misleading empty table: `apps/cli/src/cli/lists.ts:92`
   `message: e.message ?? 'The server refused the request.'` for a `RESPONSE_INVALID` (the right text exists in
   `dispatch.ts:68-70` but `listingFailure` bypasses it), and the empty-state block ("No nodes you may read. 0 nodes") is
   printed above the error, contrary to "a failed read is an error, never an empty list" (principle 5). `nextFor`
   (`dispatch.ts:~43`) offers no next step for `RESPONSE_INVALID`.

### Suggested fix

1. Add an additive `Installation.minCliVersion` (optional) and send `X-Exponetdb-Api-Version`/`X-Exponetdb-Version` on every
   response (`apps/server/src/interfaces/http/app.ts` middleware). In `connect()` (`remote.ts:198-206`) parse the
   installation *tolerantly* first (a small hand-written check of `contracts.restApi` and `version`), raise
   `incompatible_server` for another REST major and a new `cli_outdated` ("this CLI 0.6.0 is older than the server; update to
   >= X") when `minCliVersion > CLI_VERSION`, then validate strictly.
2. In `packages/sdk/src/transport.ts:222` (and `lists.ts:92`, `dispatch.ts:68`) attach remediation when the server `version`
   (kept from the installation call) is newer than the client: "The server (X) is newer than this CLI (Y): update the CLI."
3. Contracts: make response objects non-strict (27 sites) and mark growing enums `x-extensible-enum` with a tolerant SDK
   parse (`z.enum([...]).or(z.string())` for those), per `versioning.md §2`.
4. `listingFailure` must not render an empty table; reuse `apiFailure`'s text.

### Acceptance test

`apps/cli/test/cli.test.ts` (fake-server style) plus `packages/contracts/test`:
- installation `restApi: 'v2'` -> exit 5, `error.code === 'incompatible_server'`, message names both versions;
- installation `version: '9.0.0'`, `minCliVersion: '9.0.0'` -> `error.code === 'cli_outdated'` with remediation naming `0.6.0`/`9.0.0`;
- `node list` with a capability entry carrying an extra field -> exit 0;
- `node list` with an unknown `state` on a server newer than the CLI -> exit 5, `RESPONSE_INVALID` text mentions updating the CLI, and
  no "No nodes" block is printed;
- contract test: no response schema of `ROUTE_LIST` is strict (walker in `<S>/e4/walk.ts` as a test) and every response enum is
  extensible or listed in an allowlist with a reason.

---

## E5. `exponetdb node job-keys <node>` without changes errors; there is no read form

**Verdict: PARTIAL. Severity P3.** The error reproduces (client-side, exit 2, no request sent). But the command is, by name and
help, a *plan* command, so the error is the contract refusing an empty plan; a read exists only indirectly.

### Reproduction (`<S>/e5/run.ts`, fake server records requests)

```
$ exponetdb node job-keys nod_01M5X2X3ARA75KSKZPANYYEHHW
exit=2
Error: The request does not match the contract: (body): a job-key change adds or removes at least one key
requests: []            <- nothing was sent; checkedBody (apps/cli/src/cli/planning.ts:66) applies the route's zod schema

$ exponetdb node job-keys --help
node job-keys: Plan adding or retiring job-signing keys a node trusts.     Effect: plan   Action: node.config.update.plan   Scopes: registry.manage
```

Same trap one step later: `--add key_01M5…` fails with `addJobKeys.0: Invalid string: must match pattern /^[a-z][a-z0-9_]{0,63}$/`
(upper-case ULID-style ids are refused; the error does not say what a key id looks like or where to find one).

### Is there a read?

- REST: the only route naming job keys is `planNodeConfigUpdate` (`routes.ts:~2150`, plan). `Node`/`NodeStatus`
  (`resources.ts:1891-1927`) and the MCP tools `nodes_list`/`node_status` (`mcp/tools.ts:799-825`) carry no job keys.
- `node show` / `node status`: no job-key field.
- Installation-level key states: only the worker-container command `exponetdb node-pki job-key list`
  (`apps/server/src/commands/index.ts:80`, runbook §5), not REST/MCP/CLI.
- What a node trusts: the node-signed result of `agent.diagnostics@2` (`capabilities.ts:1222-1235`: `jobKeys`, `helperJobKeys`).
  Read path: `exponetdb node inspect <node> --capability agent.diagnostics@2` (runs a job on the node, needs `nodes.plan`, see E11),
  then `exponetdb node observations <node> --capability agent.diagnostics@2 --output json`. Verified: the JSON output contains
  `result.jobKeys`; the default table (`node.ts:~298-318`) shows only capability/cluster/observed/operation, so the keys are not
  visible without `--output json`.

### Suggested fix

- `apps/cli/src/commands/node.ts:446-460`: with neither `--add` nor `--retire`, throw a `UsageError` with next steps:
  `Name --add or --retire. To read the keys a node trusts: exponetdb node inspect <node> --capability agent.diagnostics@2, then exponetdb node observations <node> --capability agent.diagnostics@2 --output json`.
  Better: a `node job-keys <node> --show` (or `node trust show`) that reads the latest `agent.diagnostics@2` observation and prints
  `jobKeys`/`helperJobKeys` in the table (`view` of `node observations`), and a read-only REST route for the installation's key
  states (`GET /node-pki/job-keys`, scope `nodes.read`) replacing the worker-only `job-key list` for rotation checks.
- State the key-id format in the `--add` flag description.

### Acceptance test

`apps/cli/test`: `node job-keys <node>` without flags -> exit 2, stderr contains `agent.diagnostics@2` and `node observations`;
`--add K1` where K1 is invalid -> message names the id format; `node observations … --capability agent.diagnostics@2` table
shows a `JOB KEYS` column for that capability (fake observation with `result.jobKeys`).

---

## E8. `-- covers:` in `verify.sql` counts statements from 0; docs do not say so

**Verdict: REPRODUCED. Severity P3** (documentation and diagnosability gap; but the consequence is a *blocking* finding in the
default prod tier, not just a warning).

### Parser

`packages/postgres/src/parser/verify-checks.ts:78-95` collects `-- covers:` entries as strings (comma separated);
`packages/migrations/src/lint/lint.ts:867-872` `covered.has(String(s.index))`, where `s.index` is the array index of the
statement (`lint.ts:874` `statements[index]`), i.e. 0-based, comments not counted. Unnamed checks are `check_<index>` (0-based too).

### Reproduction (`<S>/e8/`, project `acme/demo`, bundle with three `INSERT` statements = indexes 0,1,2)

```
variant none        (no -- covers:)        -> 3 x warn uncovered_statement stmt=0,1,2 blocking=true ; process exit 1
variant 0-based     (-- covers: 0 / 1 / 2) -> status ok ; exit 0
variant 1-based     (-- covers: 1 / 2 / 3) -> 1 x warn uncovered_statement stmt=0 blocking=true "INSERT: not derivable and not covered by a verify.sql check." ; exit 1
$ exponetdb migration lint --tier nonprod  (1-based variant)  -> exit 0
```

Human output for the 1-based variant:

```
LEVEL  RULE                 MIGRATION                   WHERE          MESSAGE
warn   uncovered_statement  01M5ZEVC3MXJZP7A53N3XBF5RY  up.sql line 1  INSERT: not derivable and not covered by a verify…
BLOCKED  1 findings, 1 blocking
```

- The finding is level `warn` but `blocking=true` at the default `--tier prod` (`rules.ts:267-273`, blocking `prod`), so the
  author who counted from 1 gets a red exit, and the message names a line, not the index to put into `-- covers:`.
- The entry `3` (no statement 3) is accepted silently: there is no "covers names a statement that does not exist" finding.
- Real-world check (REOSA event-platform, copy): 40 statements, covers use `1; 34, 35; 10, 11, 38, 39`; index 39 exists, so
  that author counted 0-based and its 5 `uncovered_statement` are genuine.
- Docs: `grep -rn -i "zero-based|0-based|1-based|from 0|statement index" exponetdb-docs/04-migrations exponetdb-docs/15-cli` finds nothing
  about covers numbering. `verification.md:159-160` says only "`-- covers: <statement index or object>`", the example
  (`verification.md:361`) `-- covers: 2` has no matching `up.sql`; `rules.ts:272` remediation says "`<statement index>`".
- Side note found on the way: `migration new` + a minimal project file (without `defaults.lockTimeout/statementTimeout`) lints
  as `parse_error MIGRATION_MANIFEST_INVALID: /execution The value cannot be materialized.` (opaque; P3, separate).

### Suggested fix

1. Docs: `verification.md:159` and `:361`, `migration-bundles.md:440`: "statement index = position of the top-level statement in
   `up.sql`, **counted from 0**, comments and empty statements not counted"; make the example self-contained (show the `up.sql`).
2. `packages/migrations/src/lint/lint.ts:867-882`: put `statement index N (counted from 0)` and the statement's line into the
   `uncovered_statement` message; add a rule `covers_out_of_range` (warn) for entries that are neither an index below
   `statements.length` nor a known object name. `rules.ts:272`: "…`-- covers: <statement index, from 0>`".
3. Optionally print the index in `migration show`/lint tables ("#0").

### Acceptance test

`packages/migrations/test/lint.test.ts`: three-statement bundle; covers `0,1,2` -> no `uncovered_statement`; covers `1,2,3` ->
`uncovered_statement` whose message contains `statement 0` and `from 0`, plus `covers_out_of_range` for `3`. A docs test
(`tooling` doc-lint) asserts `verification.md` contains "counted from 0".

---

## E9. `migration lint` over the bundle root blocks on already-applied bundles

**Verdict: REPRODUCED. Severity P2.** A project with one old, immutable bundle that has a prod-blocking finding can never get a
green `migration lint`, and no flag narrows the run.

### Reproduction (`<S>/e9/`; old bundle with `CREATE FUNCTION … SECURITY DEFINER` without `search_path`, new clean bundle depending on it)

```
$ exponetdb migration lint --output json     (whole root)
status: failed {"code":"MIGRATION_LINT_BLOCKED","message":"1 blocking finding."}
  01M5ZEY5DJ… error security_definer_without_search_path blocking=true      <- the old bundle
  bundle 01M5ZEY74S… findings: 0                                           <- the new bundle is clean
exit=1

$ exponetdb migration lint <new-bundle-dir>       -> Error: Unexpected argument …                       exit=2
$ exponetdb migration lint --bundle <dir>         -> Error: Unknown flag: --bundle                      exit=2
$ exponetdb migration lint --since <old id>       -> Error: Unknown flag: --since                       exit=2
$ exponetdb migration lint --only <dir>           -> Error: Unknown flag: --only                        exit=2
$ exponetdb migration lint --workdir <new-dir>    -> walks up to the project, lints both              exit=1
$ exponetdb migration lint --help                 -> flags: --postgres, --tier only
```

Workarounds tried, all fail:

- copy only the new bundle into its own project: `error unknown_dependency … depends on <old>, which th…` -> exit 1;
- `lint.rules.security_definer_without_search_path: warn` in `exponetdb.project.yaml`: still `error`/blocking, because the rule is
  `fixed` (`rules.ts:~120`, "a project override never lowers it");
- `--tier nonprod`: still blocked for `always` rules (here); it is green only for prod-tier blockers (see REOSA below);
- only `--output json` + per-bundle filtering by a script works, and the exit code is still 1.

### REOSA bundle (read-only source, lint run on a COPY: `/home/david/Development/REOSA/packages/db/bundles/01M5X2X3ARA75KSKZPANYYEHHW_event-platform`)

Copied with the project file into `<S>/e9r/proj/bundles/`; `migration lint` -> `MIGRATION_LINT_BLOCKED: 11 blocking findings`, exit 1.
Rule ids and counts (15 findings, 11 blocking, all level `warn`, all blocking only in the prod tier):

```
  5 uncovered_statement              (blocking 5)
  3 create_index_without_concurrently (blocking 3)
  3 table_without_grant              (blocking 3)
  3 conditional_ddl                  (blocking 0)
  1 compatibility_unknown            (blocking 0)
```

`migration lint --tier nonprod` on the same copy -> exit 0. (Note: the bundle is applied, so its text can no longer change
without a checksum mismatch, which makes the red permanent.)

### Root cause

`apps/cli/src/commands/migration.ts:242-333`: no argument or filter, `readBundles(project)` -> `lintBundles(all)`
(`:267`), exit from `findings.filter(f => f.blocking)` over all bundles (`:277-281`). The lint is offline and knows nothing
about applied state; `lintBundles` has no scope option. Server side the planner lints only the pending set
(`packages/migrations-engine/src/planner.ts:~615`), so the CLI is stricter than the gate that matters.

### Suggested fix

- `migration lint [<bundle dir|id>…]` and/or `--since <id>` / `--changed` (git) / `--exclude-applied` (needs a profile). The graph
  must still be built over all bundles (no `unknown_dependency`), but findings (and the exit code) count only the selected ones;
  the others are reported as `skipped`. Implement as a `scope?: ReadonlySet<string>` option of `lintBundles`
  (`packages/migrations/src/lint/lint.ts`) and flags in `migration.ts:245-258`.
- Alternatively a reviewed, per-bundle waiver in `exponetdb.project.yaml` (`lint.accepted: [{migration, rule, reason}]`),
  shown in plans like lowered rules.

### Acceptance test

`apps/cli/test/local.test.ts`: project with old bundle (`security_definer_without_search_path`) and clean new bundle:
`migration lint` -> exit 1 (unchanged); `migration lint <new>` -> exit 0, `data.bundles` lists the old as `skipped`, no
`unknown_dependency`; `migration lint <old>` -> exit 1; unknown bundle -> exit 2.

---

## E11. CLI login needed an explicit `--scope … nodes.plan`; presets did not include it

**Verdict: PARTIAL. Severity P3.** `nodes.plan` is in two presets (`operator:nonprod`, `operator:prod`), so the claim "presets did
not include it" is wrong as stated. What is true: it is in none of `read`, `developer:*` and **`admin`**, no single preset covers
node onboarding (`registry.manage`) plus node inspection (`nodes.plan`), and presets cannot be combined.

### Preset x scope (from `apps/cli/src/presets.ts:20-85`; generated by `<S>/e11/matrix.ts`)

| Scope | read | dev:nonprod | dev:prod | op:nonprod | op:prod | admin |
|---|---|---|---|---|---|---|
| targets/schema/migrations/diagnostics/backups/nodes `.read`, `audit.read` | x | x | x | x | x | x |
| migrations.plan, migrations.apply:nonprod |  | x | x | x | x | x |
| migrations.apply:prod |  |  | x |  | x |  |
| data.read:nonprod, connections.operate:nonprod, backups.run, restore.plan, **nodes.plan**, nodes.operate:nonprod |  |  |  | x | x |  |
| data.read:prod, connections.operate:prod, nodes.operate:prod |  |  |  |  | x |  |
| registry.manage, access.read, access.manage, policy.manage, migrations.import, schema.manage |  |  |  |  |  | x |
| restore.execute, operations.recover, breakglass.activate, diagnostics.read_sensitive, data.read_sensitive | in no preset (documented, `README.md §3`) |

### Command x preset (CLI-declared scopes, `Y` = all held; relevant rows of `<S>/e11/matrix.out`)

| Command | Scope | read | dev:* | op:nonprod | op:prod | admin |
|---|---|---|---|---|---|---|
| node list/show/status/capabilities/observations | nodes.read | Y | Y | Y | Y | Y |
| **node inspect** | nodes.plan | . | . | Y | Y | **.** |
| node postgres reload/restart/config/hba/roles/extensions/tls (plan) | nodes.plan (apply: nodes.operate:<tier>) | . | . | Y | Y | **.** |
| cluster credential rotate | nodes.plan declared, **registry.manage on the server** | . | . | Y (declared) | Y | . |
| node enrollment create, node job-keys, node revoke, node decommission | registry.manage | . | . | . | . | Y |
| backup overview/list/repositories/policy show/runs, restore list, drill list | backups.read | Y | Y | Y | Y | Y |
| backup refresh / run / verify | backups.run | . | . | Y | Y | . |
| restore plan, restore runbook, drill plan | restore.plan | . | . | Y | Y | . |
| restore discard, drill record-offline | restore.execute | . | . | . | . | . (named with `--scope` only) |
| backup adopt / ownership / retire-repository / policy set | registry.manage | . | . | . | . | Y |
| plan apply, operation cancel/retry-verification | scope of the plan's kind (server) | per plan | | | | |

Consequences:

- `admin` (the only preset with `registry.manage`, so the only one that can enroll nodes or plan job keys) lacks `nodes.plan`.
  A person who enrolls a node and then runs `node inspect` needs `--preset admin --scope nodes.plan`; the CLI's own hint for that
  is an explicit list, because no preset covers it: `scopeHint(admin, ['nodes.plan'])` -> `(none)` preset, one
  `exponetdb login --scope "targets.read … schema.manage nodes.plan"` line (checked).
- `--preset admin --preset operator:nonprod` is refused (`Error: --preset is given twice with different values.`), although the
  docs say presets combine only with `--scope`.
- `exponetdb auth presets` hides the answer: the SCOPES column is `flexible` and truncated at 120 columns
  (`apps/cli/src/commands/auth.ts:~423-426`), every row ends in `… nodes.read audit…`, so `nodes.plan` is not visible
  (`--output json` is needed). The README table (`README.md §3`) matches `presets.ts` exactly (checked), but says nothing about
  which commands need which scope; only the generated `reference.md` has per-command `Scopes:`.
- Declared-vs-server scope mismatch (help and reference say one scope, the server's action catalog requires another):
  `cluster endpoints` (`registry.ts:933`), `cluster databases` (`:968`), `cluster credentials` (`:1002`),
  `cluster credential submit` (`:1318`) declare `nodes.read` but their actions (`endpoint.list`, `database.list`, `credential.list`)
  are `registryRead`, scope `registry.manage` (`actions.ts:1493-1495`; the route summary says "registry.manage only");
  `cluster credential rotate` (`registry.ts:1422`) declares `nodes.plan`, action `credential.rotate.plan` needs `registry.manage`
  (`actions.ts:1297`). For these, `read` preset users get a server refusal naming `registry.manage` (explicit-consent, human-only).

### Suggested fix

1. `apps/cli/src/presets.ts:72`: add `nodes.plan` (and `restore.plan`, `backups.run` if admin should operate backups) to `admin`, or introduce
   `fleet:nonprod` = `admin` + `nodes.plan nodes.operate:nonprod`. Allow repeated `--preset` as a union (`auth.ts` `presetFrom`).
2. `auth presets`: wrap the SCOPES column (or print one scope per line with `--output table` at narrow widths); add a column or footer
   "commands that need more: …".
3. Fix the five declared scopes (`registry.ts:933,968,1002,1318,1422`) to `registry.manage`, and add a contract test comparing every
   remote command's `scopes` with `ACTIONS[action].scope` (fixed scopes).

### Acceptance test

- `apps/cli/test/presets.test.ts`: for every remote `CommandSpec` with a fixed server scope, `spec.scopes` equals the action's scope; a
  node-management scenario (`node enrollment create` + `node inspect`) is covered by at least one preset (or by two presets that `login`
  accepts together).
- `cli.test.ts`: `auth presets` at 120 columns prints `nodes.plan` in the operator row (no `…` truncation of scopes).

---

## Not checked / limits

- No live server was contacted; every remote scenario is a fake-`fetch` simulation of the server response shapes, so the exact
  wording of the real server's `VALIDATION_FAILED` for E5 was not observed (the CLI refuses first, exit 2, no request).
- E1 ran the agent unprivileged inside `unshare -Ur`; the chown of the proposed tmpfiles line could not be exercised (unmapped uid).
- `apps/cli/.turbo` in the worktree (git-ignored) has a modification time inside my window; I ran no turbo command, so it comes from
  the concurrently running suites.
