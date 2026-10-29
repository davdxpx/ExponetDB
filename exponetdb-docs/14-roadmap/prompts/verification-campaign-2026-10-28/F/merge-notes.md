# Notes on how the findings files were produced and merged (lead)

## Provenance

- `findings-B1.md`, `decisions-B1.md`, `findings-D0.md`, `decisions-D0.md` were written by the lead from the
  agents' reports (the harness refused the sub-agents' writes of files in `F/`: "Subagents should return
  findings as text"). The lead checked the cited code lines it reports as "checked by the lead".
- `findings-E1.md`: the sub-agent E1 hit the same refusal and wrote the file through a shell heredoc instead.
  The lead read all of it, re-checked the third P1 (upgrade rollback) against `upgrades.md` and `role.ts`, removed
  the preamble so the assembler parses it, and adopts it as its own. The workaround itself is reported to the
  owner in the closing message.
- Sub-agent runs on the lead's machine used Bun 1.3.14 / Node 26.5 ("exploratory"); verdicts that matter are
  repeated on the pinned toolchain (`D/infra/bootstrap.sh`) before they are final.

## Duplicates to merge before `build.py` runs (same root cause found by two agents)

| Keep | Drop or fold in | Why |
|---|---|---|
| E1 P1 "needs_attention has no exit for any kind" + E1 P1 "unknown outcome" | B1 P1 "needs_attention without an exit" | same engine gap; B1's evidence (B/contract.md DF-02, DF-19) is added to E1's |
| B1 P2 "ledger divergence is noticed only when someone plans" | E1 P2 "ledger divergence is not monitored" | same |
| B1 P2 "approval window not implemented" | first campaign TC-034 / OD-64 (still open) | link, do not duplicate |

## More duplicates and corrections (lead, 2026-10-29)

| Keep | Drop or fold in | Why |
|---|---|---|
| R2 P3 "root-only branch of verify-units.sh always fails as root" | A's third finding (same file and line; A reproduced it independently: fails as root, passes unprivileged as in CI) | same defect; A's evidence is added to R2's finding |
| B2 P2 "DETACH PARTITION CONCURRENTLY unclassified" | B3 P2 "DETACH PARTITION ... CONCURRENTLY cannot be authored" | same defect, found by two agents |
| E1 P1 needs_attention (no exit) | B1 P1; plus D0 P2 and R1 P2 "recovery closes before its own checks" stay separate (different defect: ordering) | same engine gap |
| C1 P2 "no certificate expiry signal" | the TC-042 / OD-62 item in F/decisions-R2.md | link, do not duplicate |
| Corrected count | D0 "27 unpinned bundles" | 45 directories, 21 pinned, 24 unpinned (E2 recount, lead re-checked) |

## S1 confirmations (stack reproductions, filed as evidence lines on the existing findings)

- C1 P1 head-of-line blocking: confirmed (evidence line added to `findings-C1.md`).
- E1 P1 / B1 P1 `needs_attention` dead ends: confirmed for rollback, ledger.reconcile, drift.accept and unknown outcome (line added to `findings-E1.md`; `findings-B1.md` first P1 is dropped as a duplicate).
- D0 P2 close-before-checks: confirmed end to end (line added to `findings-D0.md`); R1's P2 on the same ordering is a duplicate, keep one.
- S1 P2 "approval after plan expiry accepted" is the stack evidence for B1's approval-window P2 and OD-64: keep S1's (stronger), fold B1's in.
