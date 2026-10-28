# Rules for every tester agent of the verification campaign

The brief is `exponetdb-docs/14-roadmap/prompts/2026-10-28-post-fix-verification-campaign.md`
(copy at `/home/david/Development/ExponetDB-campaign-report/exponetdb-docs/14-roadmap/prompts/2026-10-28-post-fix-verification-campaign.md`).
Section 1 (ground rules) overrides anything you infer. The short version:

## Paths

| Name | Path |
|---|---|
| `T` (tree under test, detached, **read only for you locally**) | `/home/david/Development/ExponetDB-verify` at `d51da5d0d8832ebc569f23985c7e5176e4d450ad` (merge of fix PR #46) |
| `OLD` (pre-fix commit) | commit `d0229550` (make your own worktree or checkout, see your task) |
| `EV` (evidence folder, committed later) | `/home/david/Development/ExponetDB-verify-evidence/exponetdb-docs/14-roadmap/prompts/verification-campaign-2026-10-28/` with `R/ A/ B/ C/ D/ E/ F/` |
| First campaign evidence | `/home/david/Development/ExponetDB-verify-evidence/exponetdb-docs/14-roadmap/prompts/test-campaign-2026-10-27/` and the fix prompt `.../2026-10-27-test-campaign-fixes.md` |
| Disposable servers | `ssh -F /home/david/.local/share/exdb-vc-keys/ssh_config vc-1` (also `vc-2`, `vc-3`), Ubuntu 24.04, root, 4 vCPU, 8 GB, UTC. You may only use the server your task names. **Never create or delete servers or keys**; the lead does. Never print the contents of anything in `/home/david/.local/share/exdb-vc-keys/` or `~/.config/`. |
| Live installation | `https://db.exponet.cloud`, **reads without side effect only**, tokens in `~/.config/exponetdb/credentials.json`. Do not touch it unless your task says so. |

## Hard rules

1. **Do not change the repository.** No commits, no branches, no edits under `T` (not
   even build output: work in your own copy or on the server). Write only into your
   report files under `EV/` (and scripts/tests under `EV/<block>/...`). Do not `git add`,
   `commit` or `push`; the lead does that.
2. **No secrets in any file you write or any output you quote.** Pass secrets by file or
   stdin; show counts, hashes and ids. No IP addresses of real servers, no e-mail
   addresses, no raw dumps of the live installation. Keep raw logs on disk (on the server
   or under `/tmp`, not in `EV/`), and quote only the lines that matter. The repository is
   public; the whole evidence pull request must stay under 12,000 lines.
3. **A claim needs a reproduction you ran.** "The code looks right" is not a verdict. A
   check you could not run is `NOT RUN` with the reason, never a quiet pass.
4. **Never touch**: `reos-db-01`, `db.exponet.cloud` writes (no plans, no advisors_run, no
   applies, no approvals), `reosa/platform/staging|scratch` writes, Supabase, Coolify.
5. **If you find a P0** (data loss, secret exposure, a way to change production without
   the gates): stop, write what you have, and end your turn with the P0 first in your
   final message so the lead can tell the owner.
6. Severity: P0 data loss/security/outage; P1 wrong result, blocked core flow, or anything
   that makes a production apply, restore or upgrade unsafe or unrecoverable; P2 degraded
   with a workaround; P3 polish.
7. Pinned toolchain for anything whose result matters: Node 24.22.1, Bun 1.4.4, Go
   1.26.10, Ubuntu 24.04, UTC (the servers have it; the lead's machine runs Node 26.5 and
   Bun 1.3.14 and must not be used for verdicts). cx33 has 8 GB: `turbo --concurrency=2`,
   run heavy jobs under `nice`, serialise heavy jobs with `flock /tmp/heavy.lock`.
8. zsh on the lead's machine: quote globs, no `=====` lines as commands; prefer small
   wrapper scripts to long one-liners.
9. Another session runs containers named `exdb-tcf-*` and other ports on the lead's
   machine; never touch them. Prefer the servers for anything heavy.

## Findings format (exactly this, so `F/build.py` can assemble them)

```
### [P1] Short title
- **Area:** package or surface
- **Block:** R, A, B, C, D or E (the block that found it)
- **Reproduction:** exact steps and commands
- **Expected:** ...
- **Actual:** ...
- **Evidence:** relative paths
- **Root cause:** suspected, with file:line at the tested commit
- **Proposed fix:** ...
- **Acceptance test:** a test that fails before and passes after
```

Write findings into a file `EV/F/findings-<your-part>.md` (no ids; the lead numbers them
`VC-nnn` in severity order). Anything the owner must decide is an *open decision*, listed
in `EV/F/decisions-<your-part>.md`, not a finding.

## Your final message

Keep it under 25 lines: the verdict per item (counts), the P0/P1 findings in one line
each, the files you wrote, what is NOT RUN and why. The detail lives in the files.
