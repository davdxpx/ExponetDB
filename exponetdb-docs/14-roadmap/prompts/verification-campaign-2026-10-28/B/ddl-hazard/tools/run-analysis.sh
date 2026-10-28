#!/usr/bin/env bash
# Regenerates results/*.json: both projects x {strict, standard} x {offline, plan-large, plan-small},
# plus the hazard project without `-- covers:` lines. Needs the pinned toolchain on PATH.
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
D="$here/.."
for p in hazard safe; do
  for prof in strict standard; do
    for mode in offline plan-large plan-small; do
      bun --conditions=@exponetdb/source "$here/analyze.ts" "$D/fixtures/$p" --profile "$prof" --mode "$mode" \
        --out "$D/results/$p-$prof-$mode.json" > "${TMPDIR:-/tmp}/b3-$p-$prof-$mode.txt"
    done
  done
done
bun --conditions=@exponetdb/source "$here/analyze.ts" "$D/fixtures/hazard" --profile strict --mode plan-large --no-covers \
  --out "$D/results/hazard-strict-plan-large-nocovers.json" > "${TMPDIR:-/tmp}/b3-hazard-nocovers.txt"
echo "results written to $D/results"
