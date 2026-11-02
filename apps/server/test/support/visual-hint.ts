/**
 * What a failing visual comparison says about the baseline set it ran against (test campaign
 * TC-054). The default set `local` matches only the machine that recorded it (fonts and
 * rasterization differ elsewhere), so a pixel difference on another machine is not a regression.
 */
export function baselineSetHint(set: string, explicit: boolean): string {
  return explicit
    ? `Compared against the baseline set \`${set}\`.`
    : `The baseline set was the default \`${set}\`, which matches only the machine that recorded it: on another machine set EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04 (a pinned Ubuntu 24.04 host with the CI fonts) or record your own set with EXDB_UPDATE_VISUAL=1 and review the diff (local-development.md).`
}
