
## 5. Suggested order of work

One branch, one pull request, but commit per finding (or per tight group) so the owner can review and revert pieces. Work in this order; stop and ask the owner (open decision) where a finding says "owner decision".

1. **Hostile-input and engine blockers (P1):** the single-quoted `DO` body bound, the quadratic `search_path` regex (both in `packages/postgres`), then the operations/migration engine P1s (a `needs_attention` operation that blocks the target for ever, the out-of-band change adopted into the drift baseline, a dangling stored bundle poisoning the project, `ledger.reconcile`). Each with its regression test first.
2. **Plan visibility and the CLI dead ends (P1):** `plan show` must return the change content for the `postgres.*` node plans; config and roles plans must be creatable from the CLI.
3. **Truthfulness of reads and errors (P2):** failed list reads print no empty body; typed errors that name the cause (`query_stats`, dependency ids, `sql_query` qualification, node plan errors); node view clusters; the findings/advisor/drift recording and counters (needs OD-57).
4. **Node agent and runbook (P2/P3):** fresh-host enrollment (tmpfiles, runbook steps, token path), certificate expiry visibility, clock and disk-full signalling, hba refusal codes, then the documentation of the downgrade rule.
5. **Test and CI wiring (P2/P3):** run `pglab` and `runbook.lab.test.ts` in CI, close the "regression test pending" rows, selection and 500-chain tests, time-zone-proof tests, toolchain check, platform-safe visual baselines.
6. **Web polish and CLI polish batches (P2/P3).**
7. **Docs and gates last:** update `PRE-WAVE-11-REVIEW.md` (new section), `gates/6.md` (E16/E18/E25 rows), `gates/9.md`, `acceptance-gates.md`, `test-strategy.md`, `open-decisions.md`.

### Owner decisions this campaign needs (do not decide them silently)

- **OD-57** (advisor and drift runs record data under a read scope): classify as record actions or keep read-only and stop recording. Affects the advisor/drift finding.
- **E16 and E18 waivers** (`gates/6.md`, expiry "before the first import of real REOSA data (Wave 10)"): the live staging target already carries 555 `legacy_import` ledger rows from the OD-7a import; is that "real data" and must detection exist before more imports?
- **G10.3 wording** versus OD-7b (production applies before Wave 11).
- **Step-up for enrollment**: one combined step-up for plan apply plus token reveal, or longer receipts.
- **Plan withdrawal scope** for node plans and whether withdrawing a revoke plan may need a fresh passkey.
- **Node certificate expiry warning thresholds** (proposed: warning 12 h before expiry without renewal).

### Things for the owner to look at now (not work for the fix session)

- Operation `op_01M5X74EJ0CD4BYGRZ9DM1KZYA` (`access.identity.erase`, target identity `idn_01M4H5XZ12G122Q9MCZHT5QKMA`) is `awaiting_approval` with a live approval URL although its plan was consumed and expired about 20 hours before the campaign. Decide whether it should be canceled.
- The live node certificate expires **2026-10-30T05:57:35Z**; the gateway asks for renewal from **2026-10-29T05:57:35Z**. Renewal was proven working on a disposable host with the real certificate (23 h left renews in under 1 s). An agent that is down for the whole window needs RB-13; nothing warns before the window closes.
- The campaign changed live state in two documented ways: advisor runs (`exponetdb diagnose advisors`, MCP `advisors_run`) recorded findings (staging 0 to 215 open advisor findings, scratch +228 to 13,968 total) and 10 node plans (reload x3, restart x2, hba x2, an extension no-op, revoke, decommission) were created and left to expire unapplied (withdrawing them was refused for scope reasons; the last one expired by 20:34 UTC on 2026-10-27; nothing was applied anywhere). One `auth.login` web event at 20:11:27Z coincides with the Web audit opening your signed-in Chrome.
