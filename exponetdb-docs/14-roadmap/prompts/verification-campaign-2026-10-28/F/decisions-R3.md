# Open decisions raised by the verification of TC-049 to TC-075 (agent R3)

- **R3-D1 (TC-054):** the default visual-regression baseline set. Today `local` matches no machine R3 tried (WSL2 and a pinned Ubuntu 24.04 host were both red). Options: default to `ci-ubuntu-24.04` on linux, or refuse before the pixel comparison when no set matches; the fix recorded neither.
- **R3-D2 (TC-050):** confirm that owner-run `*.model.test.ts` evals may report "skipped (NOT RUN)" although CLAUDE.md says never skip tests (`test-strategy.md` §9 now states it).
- **R3-D3 (TC-049):** the tests now pin UTC while the Web App formats times in the viewer's zone without a zone label (W-13). Decide whether the UI should show UTC or a labelled zone.
- **R3-D4:** OD-66 (G10.3 wording) and OD-67 (one step-up for node enrollment) remain open as the fix recorded them.
