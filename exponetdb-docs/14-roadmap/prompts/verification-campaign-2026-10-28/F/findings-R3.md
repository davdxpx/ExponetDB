### [P3] The test-infrastructure fixes TC-049, TC-050 and TC-054 have no regression guard
- **Area:** `vitest.shared.ts`, `apps/server/test/mcp-evals.model.test.ts`, `apps/server/test/visual-regression.e2e.test.ts`
- **Block:** R
- **Reproduction:** in a `d51da5d0` tree delete `env: { TZ: 'UTC' },` from `vitest.shared.ts`; in `packages/ui-patterns` `TZ=UTC bunx vitest run test/metric-card` passes (14/14, what CI runs), `TZ=Europe/Berlin` fails (1/14).
- **Expected:** a test or CI step fails when the fix is removed.
- **Actual:** CI runs in UTC, so a revert is green; the evals skip (TC-050) and the visual hint (TC-054) are never exercised by any automatic run.
- **Evidence:** R/R3-notes/logs-index.md (tc049-guard-*.log); R/verdicts-R3.md rows TC-049, TC-050, TC-054.
- **Root cause:** configuration and message changes without a test; the only new test of the group is `toolchain.test.ts` (TC-051).
- **Proposed fix:** a tooling test that spawns vitest with `TZ=Europe/Berlin` on one date test (or asserts every config carries `TZ=UTC`); a test that runs the evals config without a key (14 skipped, exit 0); a unit test of `setHint()`.
- **Acceptance test:** deleting the TZ line, or restoring the throw in `mcp-evals.model.test.ts`, turns `bun run test` red in UTC.

### [P3] Two statements about the model evals are stale after TC-050
- **Area:** `tooling/checks/verify-host.ts`, `vitest.shared.ts`
- **Block:** R
- **Reproduction:** `bun run verify:host` says the evals need `ANTHROPIC_API_KEY`; the test reads `EXDB_EVAL_ANTHROPIC_API_KEY` (`mcp-evals.model.test.ts:26`). The comment above `modelEvalsConfig` still says tasks "fail as NOT RUN".
- **Expected:** the correct variable name and wording.
- **Actual:** an operator following the printed hint gets 14 skipped, exit 0 again.
- **Evidence:** `verify-host.ts` (MCP evals entry), `vitest.shared.ts` comment; R/verdicts-R3.md row TC-050.
- **Root cause:** text written for the old behaviour.
- **Proposed fix:** name `EXDB_EVAL_ANTHROPIC_API_KEY`, fix the comment, check the name in a tooling test.
- **Acceptance test:** a tooling test that the key name printed by `verify:host` appears in `mcp-evals.model.test.ts`.
