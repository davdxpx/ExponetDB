### [P2] A failed list read still prints an empty-list body on stdout and the JSON error envelope carries `data.items: []`
- **Area:** CLI output of list commands (principle 5, truthful reads)
- **Block:** C (CLI sweep D1)
- **Reproduction:** `exponetdb backup list cls_01M5J4RDBP52B715X5HDFKDN5F` with a session lacking `backups.read`: stderr has the typed `INSUFFICIENT_SCOPE`, exit 3, **stdout prints "No backups in the catalog mirror."** Same for `backup overview`, `backup runs`, `restore list`, `drill list`, `cluster findings`, `environment list prd_000...`, `target list --state bogus`, `cluster list --cursor garbage`, `plan list --target reosa/platform/nope`, `operation list --target reosa/platform/nope`, `finding list --target reosa/platform/nope`, `schema search reosa/platform/nope lead`, `audit list --target tgt_xyz`. `exponetdb cluster findings cls_... --output json` gives `"status":"error", ... "data":{"items":[]}`.
- **Expected:** nothing on stdout (as the `show` commands do) and no `data.items` in an error envelope.
- **Actual:** a script or agent that ignores the exit code reads "no backups", the worst false statement for backup commands.
- **Evidence:** `C/cli-read-sweep.md` section 3 (D1), raw outputs `C/raw/backup-list.txt` etc.
- **Root cause:** the shared list renderer prints the empty-state text before the error is raised (`apps/cli/src/cli/reads.ts` `listCommand`, empty-state path) and the envelope builder adds `data` from the default; locate with `grep -n "empty" apps/cli/src/cli/reads.ts`.
- **Proposed fix:** build output only from a successful response; on error emit the typed error alone (no `data` key).
- **Acceptance test:** CLI process test with a fake server answering 403 for each list command: stdout is empty, exit code non-zero, the JSON envelope has no `data` property.

### [P2] `node list --server` ignores its filter; `node enrollment status` treats an unknown server as "not enrolled"
- **Area:** CLI node commands
- **Block:** C (CLI sweep D3)
- **Reproduction:** `exponetdb node list --server srv_01M5FARNQDD4BSM9S62CPRTB3J` (REOS-01, which has no node), `exponetdb node list --server srv_xyz`, `exponetdb node enrollment status srv_xyz`, `exponetdb node enrollment status srv_00000000000000000000000000`.
- **Expected:** an empty list for REOS-01, a usage or `NOT_FOUND` error for a bad id.
- **Actual:** all four exit 0; the first two return the node of another server (`nod_01M5XZ84...` on `srv_01M4WGQ...`), the last two print "No node has enrolled for this server yet."
- **Evidence:** `C/cli-read-sweep.md` (D3).
- **Root cause:** `apps/cli/src/commands/node.ts` declares `name: 'server'` for `node list` but passes no query mapping; `node.ts:484-501` for enrollment status (not traced).
- **Proposed fix:** map `--server` to a `serverId` query on `GET /nodes` (add the filter to the contract; U8 lists `serverId` on `GET /nodes`) and validate the id on enrollment status.
- **Acceptance test:** CLI and REST test: the filter narrows; an unknown server id answers `NOT_FOUND`.

### [P2] `migration import scratch-check` and `scratch-copy-commands` accept a nonexistent scratch and give false reassurance
- **Area:** CLI import helpers
- **Block:** C (CLI sweep D4)
- **Reproduction:** `exponetdb migration import scratch-copy-commands --target reosa/platform/staging --scratch nope/nope/nope`; `exponetdb migration import scratch-check --target reosa/platform/staging --scratch nope/nope/nope`.
- **Expected:** `TARGET_NOT_FOUND`, exit 1.
- **Actual:** exit 0; the first prints "nothing to copy: The scratch target holds every object outside the managed scope the checks name." and `Next: ... --scratch ` with an empty value; the second prints `not ready` with `scratch_usable fail not_found`.
- **Evidence:** `C/cli-read-sweep.md` (D4).
- **Root cause:** traced in the CLI only (`apps/cli/src/commands/migration.ts` import helpers); the server path was not traced.
- **Proposed fix:** resolve the scratch target first and fail with `TARGET_NOT_FOUND`; make `scratch-check` exit non-zero when not ready.
- **Acceptance test:** CLI test with a fake server: unknown scratch exits 1 with the typed error and prints no "nothing to copy".

### [P2] `access grants` cannot work with the CLI's OAuth token
- **Area:** REST/CLI `GET /me/grants`
- **Block:** C (CLI sweep D5)
- **Reproduction:** `exponetdb access grants` signed in as the owner (global `owner` binding): exit 3 `PERMISSION_DENIED: The identity lacks the permission at this scope. Ask an administrator for a role...`
- **Expected:** the caller's own OAuth grants (or a clear "browser session only").
- **Actual:** the route `listMyGrants` declares only `SESSION_EXPIRED` (`packages/contracts/src/rest/routes.ts`): a browser-session endpoint; the command has no `Scopes:` line in its help and the message sends the owner to an administrator.
- **Evidence:** `C/cli-read-sweep.md` (D5).
- **Root cause:** the CLI exposes a browser-session-only route.
- **Proposed fix:** serve the route to bearer tokens with a `access.read` scope for the caller's own grants, or remove the command and say "use the Web App"; fix the message.
- **Acceptance test:** CLI integration test: the owner's token lists its own grants, or the command is absent from the catalog.

### [P2] An approval-gated erase operation stays `awaiting_approval` after its plan was consumed, approved 1 of 1 and expired (live data)
- **Area:** approvals/operations, access identity erase
- **Block:** C (CLI sweep D6; the editor's check suggests a designed cooling flow whose guidance is missing)
- **Reproduction:** `exponetdb approval list`; `exponetdb approval show op_01M5X74EJ0CD4BYGRZ9DM1KZYA --output json`; `exponetdb plan show pln_01M5X72JJMDT4ENZ3S73GWGEGA`. Operation `access.identity.erase` created 2026-10-26T23:01Z is `awaiting_approval`, apply `not_started`, `nextAction approve`, with a live `approvalUrl`; its plan is `consumed`, approvals `{required: 1, given: 1}`, `expiresAt 2026-10-26T23:15:07Z` (about 20 h ago); `approval show` prints "Approvals: 1 of 1" next to "Approve at: ...". The target identity `idn_01M4H5XZ12G122Q9MCZHT5QKMA` (service account #2 "Test") is still `active`.
- **Expected:** one coherent state (approved and running or done, canceled, or expired) and, for a self-approval cooling rule, text that says when it can run.
- **Actual:** the operation never expires and offers an approval URL for an already-given approval. It may be the designed critical-self-approval cooling flow (`packages/auth/src/approvals.ts:44-67,294-342`, `packages/application/src/application.ts:2392-2406`); not verified against the live row. An erasure left dangling is dangerous if it can be approved later.
- **Evidence:** `C/cli-read-sweep.md` (D6). **Owner: please look at this operation.**
- **Root cause:** missing guidance and no expiry for `awaiting_approval` operations whose plan expired.
- **Proposed fix:** an operation whose plan expired moves to `canceled` (reason `plan_expired`) with an audit event; the approval page and CLI state the cooling rule and the earliest apply time.
- **Acceptance test:** integration: a plan that expires while its operation awaits approval ends the operation `canceled`; the approval page for a consumed plan says so; an approve call after expiry is refused with a typed error.

### [P3] CLI read polish batch 1 (consistency of output and errors)
- **Area:** CLI usability
- **Block:** C (CLI sweep D7 to D15, D17, D18, D20, D21, D23)
- **Reproduction:** (1) `exponetdb target show reosa/platform/staging` prints `Ledger: unknown` (JSON `ledger: null`) while `migration status` reports 567 applied, mirror in sync; `health`: `Node: unknown`, `Backups: unknown`. (2) `--limit 0` and `server list --limit -1` return one item plus a `Next:` cursor; `target list --limit 10001` is accepted although help says "1 to 10000". (3) unknown filter or id values accepted silently with exit 0: `schema search ... --kinds bogus`, `project list --product nope`, `operation list --kind nope.kind`, `diagnose table-stats <t> --schema nope_schema`, `access bindings --identity idn_000...`, `migration show 01ZZ...` (State `unknown_to_target`), `migration evidence <unknown ULID>`. (4) table values cut with "..." at a fixed width regardless of `COLUMNS` and when piped: `whoami` Scope line, `operation list` TARGET `tgt_01M5J5G1P2QETPENWYHDJ...` (not copyable), `migration evidence` digests, `audit list` SUBJECT. (5) `migration status` lists `legacy:0009_status_rls` but `migration show legacy:0009_status_rls --target ...` fails (`/migrationId must match ^baseline:...`); `migration status` renders 567 vertical records (3,985 lines, unpaged) for staging and a table for scratch. (6) `exponetdb access identities` ends with "2 identitys". (7) `unknown` is used for absent, not-yet-known and not-applicable values (`Evidence from`, `Baseline`, `Applied/Operation/Plan`, `Comment`, `Resolution`, server `Tier`). (8) error typing: `product show prd_xyz` NOT_FOUND exit 1, `project show prj_xyz` VALIDATION_FAILED exit 2, `schema diff reosa/platform/staging fingerprint:sha256:abc` untyped `Error:` while its help promises `fingerprint:sha256:...`. (9) `plan show` of a denied plan prints the plan then exits 4 `PLAN_DENIED` although the read succeeded; wording `allowed/denied` vs `allow/deny`. (10) `target show --timeout 1ms` exits 5 "server could not be reached" (it is the client deadline); a 3,000-character id is echoed in full in the error. (11) timestamps have 6 fractional digits in some commands and 3 in others; relative and absolute forms alternate in `node show`. (12) `approval open|approve|reject` and `cluster credential submit` are catalogued `read` but are interactive flows that wait up to 15 minutes. (13) `finding show <unknown id> --target reosa/platform/scratch` takes 9.3 s (known id 0.5 s). (14) `dev` errors use the lower-case code `lab_not_found` and print twice.
- **Expected:** consistent typed errors, validated inputs, copyable ids, one "unknown" meaning.
- **Actual:** as listed.
- **Evidence:** `C/cli-read-sweep.md` section 3 (D7-D15, D17, D18, D20, D21, D23).
- **Root cause:** not individually traced (shared renderers in `apps/cli/src/output/views.ts`, `apps/cli/src/cli/reads.ts`, `apps/cli/src/cli/args.ts`); (13) probably a client-side page scan.
- **Proposed fix:** one change per numbered item in a "CLI consistency" commit series; add a `GET /findings/{id}` lookup for (13) (U8 follow-up).
- **Acceptance test:** one CLI test per numbered item (exit codes, typed errors, `--limit` bounds, no truncation when not a TTY).

### [P3] CLI read polish batch 2 (scopes, presets, import helper)
- **Area:** CLI presets and safety
- **Block:** C (CLI sweep D16, D19; E11)
- **Reproduction:** `exponetdb migration import scratch-reset-sql --scratch reosa/platform/staging` prints a full in-place reset script headed "reset the scratch target reosa/platform/staging" (only the script's own guard "the database has ledger rows" would stop it; staging has 567 ledger rows; a fresh nonprod target is not protected). `restore runbook` (effect read, generates a script) needs `restore.plan`, only in the `operator:*` presets; `cluster findings` is a diagnose command but needs `backups.read`; `access grants` states no scope; all six presets list `backups.read` as MISSING for the stored session (the session predates it).
- **Expected:** a script that resets a database is only offered for a target registered as scratch; commands name the scope they need; presets match what the commands need.
- **Actual:** as listed.
- **Evidence:** `C/cli-read-sweep.md` (D16, D19), `E/e-findings-local.md` (E11).
- **Root cause:** `apps/cli/src/commands/migration.ts` (scratch-reset-sql target check); `apps/cli/src/presets.ts:20-85`.
- **Proposed fix:** refuse `scratch-reset-sql` unless the target environment is declared scratch; align scopes and presets; print the missing scope on every `INSUFFICIENT_SCOPE`.
- **Acceptance test:** CLI test: `scratch-reset-sql --scratch <non-scratch>` is refused; a preset matrix test that every read command's declared scope is in at least one preset.
