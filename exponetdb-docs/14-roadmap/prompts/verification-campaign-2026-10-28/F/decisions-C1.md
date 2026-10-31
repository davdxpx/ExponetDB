# Open decisions raised by the static review of operations (agent C1)

1. **C1-D1 (worker redeploy):** the stop grace period and a drain policy: how long may a running apply delay a deploy, and what does a redeploy do to an apply that outlives the window?
2. **C1-D2 (audit gate scope):** does the invariant "if audit cannot be written, mutations stop" also cover bundle ingest and the ordering of data-read audit events? And which general REST rate-limit policy applies?
3. **C1-D3 (metrics):** how are metrics scraped (bind address, network rule, alert channel, given OD-21), and which gauges are added?
4. **C1-D4 (retention):** enact the data-retention table or amend it (plans, operations, events, sessions, tokens, snapshots are never pruned).
5. **C1-D5 (certificate warnings):** warning thresholds for gateway, CAs and target certificates (extends OD-62).

Everything in `F/findings-C1.md` is STATIC (code and docs, with the stack steps written out in `C/*.md`). C1-1 (head-of-line blocking) and C1-12 (redeploy kills an apply) depend on one worker and the documented single serve and are to be confirmed on the stack before they are called P1/P2 in the scorecard.
