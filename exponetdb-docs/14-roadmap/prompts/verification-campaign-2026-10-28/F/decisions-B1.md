# Open decisions raised by the bundle contract review (agent B1)

Anything the owner must decide, not a finding. Source: `B/contract.md`.

- **B1-D1** Where do project settings (defaults, lintProfile, lint rules, invariants) live authoritatively: registry record, repo file (claimed today), or both with an equality check? Affects the defaults and lint-override findings. B1 leans to the registry.
- **B1-D2** What should invariant I1 say? The plan hash holds `id`, `createdAt` and `expiresAt` by design, so two plans of identical input never share a hash. Define determinism on `contentChecksum` and the pure digests (and drop the installation-local `revision` from `content`), or reword I1.
- **B1-D3** Approval window: implement (default 4 h, max 24 h) or remove from the docs. May any `plans.approve` holder cancel another actor's pending approval?
- **B1-D4** The exit for needs_attention beyond retry/supersede: a built `operation.force_release` (who, which re-auth, how the asserted outcome is audited), or per-kind retry/supersede rules?
- **B1-D5** Evidence strictness: require the mirror cross-check (cost: no evidence if the mirror is lost). What is the fallback?
- **B1-D6** Should open critical drift gate production plans (deny or require approval)? Today a plan applies on top of it and the baseline stays `drift_open`.
- **B1-D7** Generation after a restore: who bumps it and who re-stamps the marker? Must a bump force `ledger.reconcile`?
- **B1-D8** Bundle store lifecycle: withdrawn state, doctor, versioning of metadata edits (description, name), retention.
- **B1-D9** c1 sensitivity to whitespace presence, adjacency and case: accept it (document and lint), or plan a `c2` through an ADR?
- **B1-D10** Limits: CLI 5,000 vs request 50; a maximum number of migrations per plan; where they are documented.
- **B1-D11** Terminal state name when a later migration fails to execute (`failed` vs `verification_failed`), and the matching doc change.
- **B1-D12** Periodic ledger/mirror check: interval, finding severity, whether to suspend schema operations.
- **B1-D13** Hotfix follow-up: mark plus finding, or rely on the break-glass review.
- **B1-D14** Promotion and replay as first-class objects: a promotion record, a bundle replay or rehearsal on an empty database (I10), baseline materialization (legacy-import.md §4).

Not read in depth by B1 (stated by the agent): `legacy.ts` (2,992 lines), `rollback.ts`, `resume.ts`, the Web App, the Go agent. The P1 and the evidence finding rest on reading the claim predicates; the lead confirmed the predicates and the lookups in code, and the stack reproductions are still to be run (Block B failure injection).
