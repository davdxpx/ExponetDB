# CLI read sweep against https://db.exponet.cloud (campaign track C)

Date: 2026-10-27 (19:45 to 20:25 UTC). CLI: origin/main `d0229550` (worktree `ExponetDB-testcampaign`, not modified), run through the `xdb` wrapper with the owner's stored session (server 0.2.0, REST v1, installation `ins_01M49DS7JTXH5ZZEVWQW9FMTM6`). Targets: `reosa/platform/staging` (`tgt_01M5J5G1P2QETPENWYHDJ2F42J`) and `reosa/platform/scratch` (`tgt_01M5J5GJC3ZE921F2GZWF4CAES`), cluster `cls_01M5J4RDBP52B715X5HDFKDN5F`, node `nod_01M5XZ84V768SYCHZKRNGJFQP2`.

Raw redacted outputs (first 60 lines of stdout and 20 of stderr per run): `C/raw/<command-with-dashes>.txt`, one file per command (76 files). Run labels in each file: `gN` = valid args (table), `gN_json` = same with `--output json`, `bN` = deliberately wrong args, `bN_json` = first wrong-args run with `--output json`.

## 1. Result in numbers

| Item | Count |
|---|---|
| Read commands in the catalog (effect `read`) | 76 = 73 remote + 3 local; all 76 exercised |
| CLI invocations (table, json, wrong-args, cross-checks, robustness probes) | 727 |
| Remote reads functionally OK (correct output; P3 cosmetics may still apply) | 47 |
| Remote reads blocked by scope | 9 (8 need `backups.read`, 1 needs `restore.plan`) |
| Remote reads failing with valid args for a non-scope reason | 1 (`diagnose query-stats`, CAPABILITY_UNAVAILABLE) |
| Remote reads with at least one P2 defect (table below, verdict DEFECT) | 16 (6 more P2 touch scope-blocked commands, see D1) |
| Local reads | `dev runs` OK; `dev status` and `dev logs` end in `lab_not_found` because no lab `local` exists (expected on this host) |
| `--output json` runs | 242, all parse, all carry `"schema": "exponetdb.cli-output/v1"` (success and error envelopes) |
| Wrong-argument runs | 166: 146 end with exit != 0, a typed error and no stack trace; 20 are silently accepted with exit 0 (D8, D9) |
| Stack traces, `RESPONSE_INVALID`, `undefined`, `[object Object]`, `NaN` in any output | 0 |
| Secrets in any output | 0 (only public data: a CA bundle inside plan JSON). My redaction filter fired once as a false positive on a SQL temp-table name (`exdb_...` in `scratch-reset-sql`, marked `REDACTED_TOKEN` in raw) |
| Median latency of a valid call | 556 ms; slowest 3.5 s (`migration import scratch-check`); `finding show <unknown id>` 9.3 s (D21) |
| Defects | P0: 0, P1: 0, P2: 6, P3: 17 (D7 to D23) |

Exit codes seen match the documented ones: 0, 1, 2, 3, 4, 5.

### Scope facts (the stored session)

Granted: `targets.read schema.read migrations.read migrations.plan migrations.import migrations.apply:nonprod registry.manage diagnostics.read nodes.read nodes.plan audit.read access.read`.
Not granted: `backups.read` (missing from every preset: `read`, `developer:*`, `operator:*`, `admin`) and, for `operator:*`, `data.read:nonprod connections.operate:nonprod backups.run restore.plan nodes.o...`; `admin` also lacks `access.manage policy.manage schema.manage`.
Blocked commands (all exit 3, `INSUFFICIENT_SCOPE`, `details.requiredScope`): `backup overview`, `backup list`, `backup repositories`, `backup policy show`, `backup runs`, `restore list`, `drill list`, `cluster findings` need `backups.read`; `restore runbook` needs `restore.plan`. `data.read` is not needed by any read command (no command in the catalog asks for it). `login --preset read` would cover the eight `backups.read` commands; no `read` or `developer` preset covers `restore runbook` (D19).

## 2. Per-command results

Columns: valid-arg runs (table) with exit codes, JSON runs valid with the schema field / JSON runs, median ms, wrong-arg runs that exited non-zero / total wrong-arg runs. Verdict: OK, DEFECT (at least one P2), BLOCKED (scope), FEATURE-ERR (valid input, server refuses for a feature reason), LOCAL-ERR. D-numbers refer to section 3.

| Command | Loc. | Runs | Exit codes | JSON ok | ms | Bad args non-zero | Verdict | Notes |
|---|---|---|---|---|---|---|---|---|
| `whoami` | remote | 1 | 0 | 1/1 | 621 | 1/1 | OK | D10 Scope line and preset MISSING column cut with "…" (full list only in JSON). Session lacks backups.read. |
| `doctor` | remote | 1 | 0 | 1/1 | 637 | 1/1 | OK | All checks ok; reports CLI 0.6.0 (source) vs server 0.2.0 (different components). |
| `product list` | remote | 1 | 0 | 1/1 | 577 | 1/2 | OK | D8 --limit 0 ignored. |
| `product show` | remote | 2 | 0,0 | 2/2 | 840 | 3/3 | OK | D14 malformed id gives NOT_FOUND, unlike project/server (VALIDATION_FAILED). |
| `environment list` | remote | 1 | 0 | 1/1 | 1059 | 2/2 | DEFECT | D1 (prd_000.. => empty list body + NOT_FOUND). "-" vs "unknown" (D13). |
| `environment show` | remote | 2 | 0,0 | 2/2 | 642 | 2/2 | OK | D13 "Evidence from: unknown" vs "-" in list. |
| `project list` | remote | 1 | 0 | 1/1 | 485 | 0/1 | OK | D9 unknown --product returns empty list rc 0. |
| `project show` | remote | 1 | 0 | 1/1 | 656 | 2/2 | OK | Managed scope printed as raw JSON blob. |
| `project execution-roles` | remote | 1 | 0 | 1/1 | 510 | 2/2 | OK | Consistent with execution-role ops. |
| `target list` | remote | 4 | 0,0,0,0 | 4/4 | 518 | 2/3 | DEFECT | D1 (--state bogus => "No targets" body + exit 2). D8 --limit 0 => 1 item. |
| `target show` | remote | 3 | 0,0,0 | 3/3 | 681 | 3/3 | OK | D7 Ledger unknown though ledger live; D14 tgt_xyz error cites the path regex. |
| `server list` | remote | 1 | 0 | 1/1 | 727 | 0/1 | OK | D13 tier "-" (list) vs "unknown" (show); REOS-01 location "FSN!" (data). |
| `server show` | remote | 2 | 0,0 | 2/2 | 574 | 2/2 | OK | D7 OS/CPUs/Reported unknown; Next hint "node enrollment create" although an active node exists. |
| `cluster list` | remote | 1 | 0 | 1/1 | 537 | 1/1 | DEFECT | D1 (--cursor garbage => "No clusters" body + exit 2). Health unknown (D7). |
| `cluster show` | remote | 1 | 0 | 1/1 | 777 | 2/2 | OK | Matches list item exactly. |
| `cluster endpoints` | remote | 1 | 0 | 1/1 | 495 | 2/2 | OK |  |
| `cluster databases` | remote | 1 | 0 | 1/1 | 443 | 2/2 | OK | 2 databases map to the 2 targets. |
| `cluster credentials` | remote | 1 | 0 | 1/1 | 503 | 2/2 | OK | observer v3 failed / v2 active shown; no secret. |
| `cluster bootstrap-sql` | remote | 1 | 0 | 1/1 | 509 | 2/2 | OK | 122-line script, no password; stdout only (no --file used). |
| `cluster credential submit` | remote | 1 | 0 | 1/1 | 522 | 3/3 | OK | Run only with --no-input --no-wait (status requires_action, exit 0). D20 labelled read. |
| `node list` | remote | 3 | 0,0,0 | 3/3 | 539 | 0/2 | DEFECT | D3 --server filter ignored. |
| `node show` | remote | 1 | 0 | 1/1 | 498 | 2/2 | OK | D7 "No clusters reported". |
| `node status` | remote | 1 | 0 | 1/1 | 553 | 2/2 | OK | Same as show minus capabilities. |
| `node capabilities` | remote | 1 | 0 | 1/1 | 548 | 2/2 | OK | 41 capabilities, all "supported". |
| `node observations` | remote | 3 | 0,0,0 | 3/3 | 539 | 3/3 | OK | D14 invalid --capability message cut mid-token at 527 chars. |
| `node enrollment status` | remote | 2 | 0,0 | 2/2 | 606 | 0/2 | DEFECT | D3 unknown/invalid server id => rc 0 "No node has enrolled". |
| `migration status` | remote | 2 | 0,0 | 2/2 | 1762 | 3/3 | OK | Staging 567 applied (555 legacy + 11 + 1 baseline) + 1 pending; scratch 0/12. D11 layout flips between records and table. |
| `migration show` | remote | 4 | 0,0,0,2 | 4/4 | 1740 | 2/3 | OK | D11 legacy:* ids rejected; D9 unknown ULID => state unknown_to_target rc 0. |
| `migration evidence` | remote | 2 | 0,0 | 2/2 | 1764 | 2/3 | OK | D10 digest "sha256:c1:52…" cut; D9 unknown ULID => "No verification run". |
| `migration import scratch-reset-sql` | remote | 2 | 0,0 | 2/2 | 723 | 2/2 | OK | D16 prints a reset script for staging as well (script self-guards on ledger rows). |
| `migration import scratch-check` | remote | 2 | 0,0 | 2/2 | 3064 | 1/2 | DEFECT | D4 unknown scratch => rc 0 "not ready"; D10 DETAIL cut. 3 s. |
| `migration import scratch-copy-commands` | remote | 2 | 0,0 | 2/2 | 3112 | 1/2 | DEFECT | D4 unknown scratch => "nothing to copy" rc 0 and Next hint with empty --scratch. 3 s. |
| `migration import report` | remote | 3 | 0,0,1 | 2/2 | 1076 | 3/3 | OK | Valid ids found via plan JSON (imr_...); 5.8k lines table, vertical records. |
| `plan show` | remote | 1 | 0 | 1/1 | 622 | 2/2 | OK | D15 denied plan => exit 4; D6 consumed erase plan => requires_action. |
| `plan list` | remote | 5 | 0,0,0,0,0 | 5/5 | 525 | 2/3 | DEFECT | D1 (--target nope => empty body + exit 1). 50/50 items equal plan show. |
| `plan export` | remote | 1 | 0 | 1/1 | 746 | 2/2 | OK | JSON to stdout, 197 lines, no secret (CA bundle is public). |
| `operation list` | remote | 7 | 0,0,0,0,0,0,0 | 7/7 | 603 | 2/3 | DEFECT | D1; TARGET id cut (D10); subject.targetPath null (same in show). |
| `operation show` | remote | 6 | 0,0,0,0,0,0 | 6/6 | 526 | 2/2 | OK | 50/50 list items identical to show. |
| `operation watch` | remote | 2 | 0,1 | 2/2 | 554 | 2/2 | OK | Exit 0 on succeeded, 1 on failed; progress on stderr. |
| `approval list` | remote | 1 | 0 | 1/1 | 569 | 0/1 | DEFECT | D6 lists a stale approval (plan consumed, 1 of 1 given). |
| `approval show` | remote | 2 | 0,0 | 2/2 | 562 | 2/2 | DEFECT | D6 "Approvals: 1 of 1" while awaiting approval; plan state consumed; duplicated header blocks. |
| `approval open` | remote | 2 | 1,0 | 2/2 | 577 | 2/2 | OK | Run with --no-input; non-pending => APPROVAL_NOT_PENDING exit 1; D20. |
| `approval approve` | remote | 1 | 1 | 1/1 | 492 | 2/2 | OK | Only on non-pending op with --no-input --no-wait; D20 (effect read, but decision flow). |
| `approval reject` | remote | 1 | 1 | 1/1 | 503 | 2/2 | OK | Only on non-pending op with --no-input --no-wait; D20. |
| `health` | remote | 2 | 0,0 | 2/2 | 535 | 3/3 | OK | D7 "Node: unknown", "Backups: unknown". |
| `finding list` | remote | 6 | 0,0,0,0,0,0 | 6/6 | 562 | 3/3 | DEFECT | D1 (--target nope). 13.9k findings pageable. |
| `finding summary` | remote | 1 | 0 | 1/1 | 441 | 1/1 | OK | Totals consistent: 14183 = 13741 drift + 442 advisor (after my advisor runs). |
| `cluster findings` | remote | 2 | 3,3 | 2/2 | 516 | 3/3 | BLOCKED | backups.read missing (INSUFFICIENT_SCOPE, exit 3); D1 empty body; D19 odd scope. |
| `finding show` | remote | 1 | 0 | 1/1 | 504 | 4/4 | OK | D21 NOT_FOUND takes ~9.3 s on scratch; D13 "Resolution: unknown". |
| `schema overview` | remote | 2 | 0,0 | 2/2 | 1796 | 2/2 | OK | D10 object counts cut. Staging public: 559 tables. |
| `schema search` | remote | 3 | 0,0,0 | 3/3 | 755 | 2/3 | DEFECT | D1; D9 --kinds bogus => rc 0; D14 "Next: schema search --cursor d1_NQ" lacks target/query. |
| `schema show` | remote | 2 | 0,0 | 2/2 | 832 | 4/4 | OK | D13 "Comment: unknown". |
| `schema fingerprint` | remote | 2 | 0,0 | 2/2 | 1958 | 2/2 | OK | Entries 14084 (staging) / 13744 (scratch) agree with schema diff. |
| `schema diff` | remote | 2 | 0,0 | 2/2 | 1171 | 3/3 | OK | +10 -350 ~65 (=13669) reconciles with both fingerprints. D14 untyped error + help syntax. |
| `diagnose query-stats` | remote | 3 | 1,1,1 | 3/3 | 502 | 4/4 | FEATURE-ERR | CAPABILITY_UNAVAILABLE on both targets (exit 1); D22. |
| `diagnose table-stats` | remote | 3 | 0,0,0 | 3/3 | 759 | 2/3 | OK | D10 names cut ("public.commerce_intent_eve…"); D9 --schema nope => "No tables visible" rc 0. |
| `diagnose advisors` | remote | 3 | 0,0,0 | 3/3 | 848 | 2/2 | DEFECT | D2 persists 442 findings + 6 audit events under effect read. |
| `session list` | remote | 3 | 0,0,0 | 3/3 | 483 | 3/3 | OK | Shows other sessions' statements (untrusted text); empty on scratch. |
| `backup overview` | remote | 1 | 3 | 1/1 | 551 | 1/1 | BLOCKED | backups.read missing; D1. |
| `backup list` | remote | 1 | 3 | 1/1 | 574 | 2/2 | BLOCKED | backups.read missing; D1. |
| `backup repositories` | remote | 1 | 3 | 1/1 | 519 | 2/2 | BLOCKED | backups.read missing. |
| `backup policy show` | remote | 1 | 3 | 1/1 | 563 | 2/2 | BLOCKED | backups.read missing. |
| `backup runs` | remote | 1 | 3 | 1/1 | 547 | 2/2 | BLOCKED | backups.read missing; D1. |
| `restore list` | remote | 1 | 3 | 1/1 | 519 | 2/2 | BLOCKED | backups.read missing; D1. |
| `restore runbook` | remote | 1 | 3 | 1/1 | 511 | 3/3 | BLOCKED | restore.plan missing (not in read preset); D19. |
| `drill list` | remote | 1 | 3 | 1/1 | 499 | 2/2 | BLOCKED | backups.read missing; D1. |
| `audit list` | remote | 12 | 0,2,2,0,0,0,0,0,0,0,0,0 | 12/12 | 456 | 5/5 | DEFECT | D1; D14 --target accepts only tgt_ ids (path rejected); SUBJECT cut. |
| `audit show` | remote | 1 | 0 | 1/1 | 567 | 2/2 | OK | D14 malformed id => NOT_FOUND "among the newest 581". |
| `access identities` | remote | 1 | 0 | 1/1 | 455 | 1/1 | OK | D12 "2 identitys". |
| `access roles` | remote | 1 | 0 | 1/1 | 494 | 1/1 | OK | 6 roles; permissions column cut (D10). |
| `access bindings` | remote | 2 | 0,0 | 2/2 | 475 | 1/2 | OK | 1 owner binding; D9 unknown --identity => empty rc 0. |
| `access grants` | remote | 1 | 3 | 1/1 | 529 | 1/1 | DEFECT | D5 PERMISSION_DENIED for the owner (exit 3). |
| `access clients` | remote | 1 | 0 | 1/1 | 493 | 0/1 | OK | 4 clients. |
| `dev status` | local | 1 | 1 | 1/1 | 429 | 1/1 | LOCAL-ERR | No lab "local" => lab_not_found exit 1 (expected here); D23. |
| `dev logs` | local | 2 | 1,2 | 2/2 | 408 | 2/2 | LOCAL-ERR | No lab => lab_not_found; D23. |
| `dev runs` | local | 1 | 0 | 1/1 | 370 | 0/1 | OK | "No runs yet." |

Notes on exit codes in the table: `operation watch` on a failed operation exits 1 and `approval open|approve|reject` on a non-pending operation exits 1 (`APPROVAL_NOT_PENDING`), both as designed. `approval open|approve|reject` and `cluster credential submit` were only run with `--no-input --no-wait` (no browser opened; the first three were run on a succeeded operation, `approval open` also on the awaiting one, where it only printed the URL on stderr). Nothing was approved, rejected or submitted.

## 3. Defects

Severity scale: P0 data loss or secret leak, P1 wrong or unsafe result with no signal, P2 wrong or misleading result with a signal elsewhere (exit code, stderr) or a state/contract violation, P3 cosmetic or consistency. `xdb` is the wrapper (= `exponetdb`).

### P2

**D1. A failed list read still prints an empty-list body on stdout, and the JSON error envelope carries `data.items: []`.** Violates principle 5 ("a failed read is an error, never an empty list").
- Repro: `xdb backup list cls_01M5J4RDBP52B715X5HDFKDN5F` (also `backup overview`, `backup runs`, `restore list`, `drill list`, `cluster findings`, `environment list prd_00000000000000000000000000`, `target list --state bogus`, `cluster list --cursor garbage`, `plan list --target reosa/platform/nope`, `operation list --target reosa/platform/nope`, `finding list --target reosa/platform/nope`, `schema search reosa/platform/nope lead`, `audit list --target tgt_xyz`, `access bindings --identity idn_xyz`).
- Expected: nothing on stdout (as `show` commands do) and no `data.items` in an error envelope.
- Actual: exit 3 (or 1/2), stderr has the typed error, but stdout says e.g. `No backups in the catalog mirror.` / `No drills.` / `No clusters you may read.` / `0 findings`. `xdb cluster findings cls_01M5J4RDBP52B715X5HDFKDN5F --output json` gives `"status":"error", ... "data":{"items":[]}`. A script or agent that ignores the exit code reads "no backups", the worst false statement for the backup commands.

**D2. `diagnose advisors` is catalogued `effect: read` but records an advisor run and opens findings.**
- Repro: `xdb diagnose advisors reosa/platform/staging` then `xdb target show reosa/platform/staging` and `xdb finding summary`.
- Expected: no state change (or a catalog effect that says so).
- Actual: staging "Open findings" 0 -> 215, scratch 13741 -> 13968 (227 new), `finding summary` open 13741 -> 14183 (+442 advisor), and 6 `advisor.run` audit events (`xdb audit list --action advisor.run`). I ran the command 6 times (3 argument sets, table and json), so the live installation now carries these findings (they are re-observed, not duplicated, on later runs). Anyone following "run only read commands" changes live state.

**D3. `node list --server <srv>` ignores its filter and `node enrollment status` treats an unknown server as "not enrolled".**
- Repro: `xdb node list --server srv_01M5FARNQDD4BSM9S62CPRTB3J` (REOS-01, no node), `xdb node list --server srv_xyz`, `xdb node enrollment status srv_xyz`, `xdb node enrollment status srv_00000000000000000000000000`.
- Expected: empty list for REOS-01, a usage or NOT_FOUND error for a bad id.
- Actual: all four exit 0; the first two return the node of the other server (`nod_01M5XZ84...` on `srv_01M4WGQ...`), the last two print "No node has enrolled for this server yet." The flag is declared in `apps/cli/src/commands/node.ts` (`name: 'server'`) but the list command passes no query mapping.

**D4. `migration import scratch-check` and `scratch-copy-commands` accept a nonexistent scratch and report false reassurance.**
- Repro: `xdb migration import scratch-copy-commands --target reosa/platform/staging --scratch nope/nope/nope`; `xdb migration import scratch-check --target reosa/platform/staging --scratch nope/nope/nope`.
- Expected: `TARGET_NOT_FOUND`, exit 1.
- Actual: exit 0. `scratch-copy-commands` prints "nothing to copy: The scratch target holds every object outside the managed scope the checks name." and `Next: ... --scratch ` (empty value). `scratch-check` prints `not ready` with `scratch_usable fail not_found`.

**D5. `access grants` cannot work with the CLI's OAuth token.**
- Repro: `xdb access grants` (signed in as the owner, global `owner` binding).
- Expected: the caller's own OAuth grants.
- Actual: exit 3 `PERMISSION_DENIED: The identity lacks the permission at this scope. Ask an administrator for a role...` The route `listMyGrants` (`GET /me/grants`) declares only `SESSION_EXPIRED` in `packages/contracts/src/rest/routes.ts`, i.e. it is a browser-session endpoint; the command has no `Scopes:` line in its help and the message sends the owner to an administrator.

**D6. An operation stays `awaiting_approval` although its plan is consumed, approved 1 of 1 and expired.**
- Repro: `xdb approval list`, `xdb approval show op_01M5X74EJ0CD4BYGRZ9DM1KZYA --output json`, `xdb plan show pln_01M5X72JJMDT4ENZ3S73GWGEGA`.
- Expected: one coherent state (approved and running or done, or canceled/expired).
- Actual: operation `access.identity.erase` created 2026-10-26T23:01Z: `state awaiting_approval`, `applyOutcome not_started`, `nextAction approve`, live `approvalUrl`; its plan: `state consumed`, `approvals {required:1, given:1}`, `expiresAt 2026-10-26T23:15:07Z` (20 h ago). `approval show` prints "Approvals: 1 of 1" next to "Approve at: ...", `plan show` returns status `requires_action`. The target identity `idn_01M4H5XZ12G122Q9MCZHT5QKMA` (service #2 "Test") is still `active`. Looks like a stuck operation; an owner could be asked to approve something already approved.

### P3

**D7. Linkage facts shown as unknown although the data exists.** `xdb target show reosa/platform/staging` prints `Ledger: unknown` (JSON `ledger: null`) while `xdb migration status --target reosa/platform/staging` reports 567 applied, mirror in sync. `xdb health <target>`: `Node: unknown`, `Backups: unknown`. `xdb node show nod_...`: `No clusters reported.` although the cluster is `managementMode: agent` on the node's server and `node observations` has a cluster-bound observation. `xdb server show srv_01M4WGQAP67AQMY8Q16T6F7190`: `OS/CPUs/Reported unknown` (JSON `observedFacts: null`) although the node reports host load, memory and disk, and its Next hint is `node enrollment create` for a server that already has an active node. `cluster list/show`: `Health unknown`.

**D8. `--limit` is not validated.** `xdb target list --limit 0` and `xdb server list --limit -1` return one item plus a `Next:` cursor; `xdb product list --limit 0` and `xdb approval list --limit 0` exit 0 (no usage error); `xdb target list --limit 10001` is accepted. Help says "1 to 10000".

**D9. Unknown filter or id values are accepted silently (exit 0).** `schema search ... --kinds bogus`, `project list --product nope`, `operation list --kind nope.kind`, `plan list --kind nope.kind`, `diagnose table-stats <t> --schema nope_schema`, `access bindings --identity idn_000...`, `access clients --cursor garbage`, `migration show 01ZZZZZZZZZZZZZZZZZZZZZZZZ --target ...` (State `unknown_to_target`), `migration evidence <unknown ULID> --target ...` ("No verification run: production promotion needs one that passed ..."). Compare `environment list nope` (NOT_FOUND) and `cluster list --cursor garbage` (error).

**D10. Table values cut with "..." at a fixed width, independent of `COLUMNS`, even when piped.** `xdb whoami` (the Scope line stops at `registry.m...`; the preset MISSING column at `nodes.o...`), `operation list` (TARGET `tgt_01M5J5G1P2QETPENWYHDJ...`, not copyable), `migration evidence` (VERIFY DIGEST `sha256:c1:52...`, FINGERPRINT), `plan show` (APPLY CHECKSUM), `migration import scratch-check` (DETAIL), `audit list` (SUBJECT `reosa/platform/sc...`), `schema overview` (object counts end at `table 559...`), `diagnose table-stats` (`public.commerce_intent_eve...`), `access roles` (PERMISSIONS). Only `--output json` has the full value.

**D11. `migration` id and layout inconsistencies.** `migration status` lists `legacy:0009_status_rls` as MIGRATION but `xdb migration show legacy:0009_status_rls --target reosa/platform/staging` fails (`/migrationId must match ^baseline:...`; only ULIDs and `baseline:<slug>` are accepted). `migration status` renders vertical `MIGRATION:/NAME:` records for staging (567 rows, 3985 lines, unpaged) and a table for scratch (12 rows).

**D12. Wrong plural.** `xdb access identities` ends with `2 identitys`.

**D13. `unknown` used for an absent value.** `Evidence from: unknown` (show) vs `-` (list); `Baseline: unknown` for a target that simply has none; `Applied/Operation/Plan: unknown` for a pending migration; `Comment: unknown` (schema show); `Resolution: unknown` (open finding); audit `Plan/Plan hash/Operation/Reason: unknown`; server `Tier: unknown` (show) vs `-` (list). Absent, not-yet-known and not-applicable are not distinguished.

**D14. Error typing and message inconsistencies.** Malformed id: `product show prd_xyz` NOT_FOUND exit 1, `project show prj_xyz` VALIDATION_FAILED exit 2, `target show tgt_xyz` VALIDATION_FAILED citing the path regex only, `audit show aud_xyz` NOT_FOUND "among the newest 581". `schema diff reosa/platform/staging fingerprint:sha256:abc` gives an untyped `Error: The request does not match the contract: right.fingerprint: ...` and its help promises `fingerprint:sha256:...` while the accepted form is `fp1:17:<64 hex>`. `audit list --target` takes only `tgt_` ids (every other `--target` takes a path too). `node observations <n> --capability bogus` prints a 527-character message cut mid-token. `schema search` Next hint `exponetdb schema search --cursor d1_NQ` lacks target and query.

**D15. `plan show` mixes reading with the plan's decision.** `xdb plan show pln_01M5X397BQ5QMQ9WACRCQ0JQ9P` (a denied plan) prints the plan, then exits 4 with status `failed` / `PLAN_DENIED`; reading succeeded. Wording differs: `Decision: allowed/denied` (show) vs `allow/deny` (list, JSON).

**D16. `migration import scratch-reset-sql` accepts any nonprod target.** `xdb migration import scratch-reset-sql --scratch reosa/platform/staging` prints a full in-place reset script headed "reset the scratch target reosa/platform/staging". Only the script's own guard (`the database has ledger rows`) would stop it on staging (567 ledger rows); a fresh nonprod target would not be protected.

**D17. Client deadline reported as an unreachable server; unbounded echo.** `xdb target show reosa/platform/staging --timeout 1ms` -> exit 5 `TRANSPORT_FAILED: The server could not be reached.` (it is the per-request deadline). `xdb product show <3000 characters>` echoes all 3000 characters in the NOT_FOUND message.

**D18. Timestamps.** Fractional seconds are 6 digits in some commands (`plan show` Expires `...57.123000Z`, `operation show`, `audit`, `cluster show`) and 3 digits in others (`migration show` Applied `...50.756Z`, `node` heartbeat, findings); relative ("5d ago") and absolute forms alternate inside the same view (`node show`: Heartbeat relative, Certificate until absolute).

**D19. Scope and preset mapping.** `restore runbook` (effect read, generates a script) needs `restore.plan`, which only the `operator:*` presets carry; `cluster findings` is a diagnose/finding command but needs `backups.read` instead of `diagnostics.read`; `access grants` states no scope at all. The stored session lacks `backups.read`, which every preset (including `read`) lists as missing; the session was probably minted before the presets gained it.

**D20. Effect labels.** `approval open|approve|reject` and `cluster credential submit` are `effect: read` (action `operation.get`/`credential.list`) but are interactive flows that open a browser and wait up to 15 minutes by default; a script following the catalog would hang or open pages (`--no-input --no-wait` avoids both). `diagnose advisors` see D2.

**D21. `finding show <unknown id> --target reosa/platform/scratch` takes 9.3 s** (reproducible: 9298, 9616, 9396, 9310 ms), a known id 0.5 s; the target has 13.9k findings, so the lookup probably scans pages client-side.

**D22. `diagnose query-stats` is unavailable on both targets** (`CAPABILITY_UNAVAILABLE`, exit 1). The command's own description attributes it to `pg_stat_statements` not installed or preloaded; the error text says only "The node does not report this capability version, or the cluster is external", which is wrong for an agent-managed cluster and names no capability. Likely an environment fact of `reos-db-01` plus a misleading message.

**D23. `dev` errors.** Code `lab_not_found` is lower case (all others are upper case or `usage`), and `dev status` prints the message on stdout and again on stderr.

## 4. Cross-checks (all done on live data; JSON compared field by field)

| Check | Result |
|---|---|
| `operation list` (50 items) vs `operation show` for each id | 50/50 identical (state, outcomes, subject, actor, steps, timestamps) |
| `plan list` (50) vs `plan show` for each id | 50/50 identical; 2 differ only in command status (D15, D6) |
| `operation list --target T --all` vs the same subset taken from unfiltered `--all` (71 ops) | staging 23, scratch 1; id sets identical |
| `plan list --target T --all` vs the same subset taken from unfiltered `--all` (88 plans) | staging 24, scratch 1; id sets identical |
| `approval list` vs `operation list --state awaiting_approval` | same single operation (but see D6) |
| `target list` item vs `target show` (staging, scratch) | all shared fields equal, health `healthy` / `sampled` in list, show and `health` |
| `target show` Open findings vs `finding list --target` vs `finding summary` | staging 215 = 215 advisor findings; scratch 13968 = 13741 drift + 227 advisor; summary 14183 = 519 critical + 13258 warning + 406 info = 13741 drift + 442 advisor. Consistent. Before my advisor runs: 0 / 13741 / 13741 (D2) |
| `cluster list` vs `cluster show`; `node list` vs `node show` vs `node status` vs `node enrollment status` | identical fields (heartbeat differs only by time) |
| `migration status` (staging) vs `migration show` for the 11 exponetdb migrations, the baseline and the pending one | state, checksum, appliedAt, operationId equal; the latest of three verifications (failed, failed, passed) is what status shows |
| Staging ledger arithmetic | 567 applied = 555 legacy_import + 11 exponetdb + 1 baseline; 12 pending on scratch = 11 applied + 1 pending on staging |
| `schema fingerprint` vs `schema diff` staging vs scratch | 14084 and 13744 entries; diff +10 -350 ~65 (=13669) reconciles with both (13669+65+350 = 14084; 13669+65+10 = 13744) |
| `scratch-check` object count vs `schema fingerprint` / import report "Replay" fingerprint | scratch `objects:13739` matches; report replay fingerprint `fp1:17:b0385bf...` equals scratch's current fingerprint |
| `cluster databases` vs `target list` | 2 databases map to the 2 targets |
| `audit list` vs `audit show` (6 events) | all resolve with `status ok` |
| `migration status` scratch "Mirror: out of sync" | observed with 0 applied and 12 pending; the table does not say what differs (not judged a defect, worth an owner look) |

## 5. Side effects and caveats

- The sweep was read-only except D2: six `diagnose advisors` runs created 442 open advisor findings and 6 audit events (listed above); nothing else changed. No plan, operation, approval, credential or session command was run. No SSH, Coolify, Supabase, Hetzner access; no SQL (the SQL printed by `cluster bootstrap-sql` and `scratch-reset-sql` was only read).
- `--server http://...` redirection was deliberately not probed.
- Concurrent activity by other campaign tracks was visible during the sweep (operations 50 -> 71, plans 50 -> 88, `plan.created` audit events by `human #1 via cli`); counts in section 4 were taken within one call each.
- A first discovery batch used a wrong runner label and wrote junk files into the scratch directory `.../scratchpad/c/out/` (no effect on the installation); the real data is in `.../scratchpad/c/o/`.
- `migration import report` was run with valid ids only after finding `imr_...` ids inside plan JSON (no list command exists for import reports).
- Not covered: `--wait` variants (would block up to 15 minutes), `--file` / `--out <file>` outputs (would write files), `restore runbook` beyond the scope refusal, `backup *` data (scope), reads against production (none registered).
