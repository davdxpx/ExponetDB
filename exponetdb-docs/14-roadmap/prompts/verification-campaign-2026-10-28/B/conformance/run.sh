#!/usr/bin/env bash
# Runs the B2 conformance tests in a THROWAWAY checkout. Never writes into the tree under test.
#
#   run.sh <checkout> [pure|int|all] [extra vitest args...]
#
# <checkout>  a checkout (git worktree) of the commit under test with `bun install` done.
#             The tests are COPIED to <checkout>/packages/b2-conformance (that folder is the only
#             change; it is not tracked by git there). The checkout's lockfile is not touched
#             unless the first install of this package is needed (it then runs `bun install`).
# Environment (int/all): EXDB_TEST_TARGETS (tooling/dev/targets.sh) and EXDB_TEST_PG_URL
#             (tooling/dev/control-store.sh), as for the product's own integration suites.
# Toolchain:  Node 24.22.1 + Bun 1.4.4, UTC (source tooling env first; CI has it).
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
checkout="${1:?usage: run.sh <checkout> [pure|int|all] [vitest args]}"
mode="${2:-all}"
shift $(( $# > 1 ? 2 : 1 )) || true
checkout="$(cd "$checkout" && pwd)"
dest="$checkout/packages/b2-conformance"
mkdir -p "$dest"
rsync -a --delete --exclude node_modules --exclude RESULTS.md --exclude README.md --exclude run.sh \
  --exclude 'out/' --exclude exploratory "$here/" "$dest/"
if [ ! -d "$dest/node_modules/@exponetdb" ]; then
  (cd "$checkout" && bun install)
fi
cd "$dest"
case "$mode" in
  pure) exec nice bunx vitest run --config vitest.pure.config.ts "$@" ;;
  int)  exec nice bunx vitest run --config vitest.int.config.ts "$@" ;;
  all)  exec nice bunx vitest run --config vitest.config.ts "$@" ;;
  *) echo "mode must be pure, int or all" >&2; exit 2 ;;
esac
