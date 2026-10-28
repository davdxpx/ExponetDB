#!/usr/bin/env bash
# Runs the product's CLI (`exponetdb migration lint`, from source) over both
# fixture projects with both lint profiles, PostgreSQL 17 grammar, prod rules,
# and writes evidence/cli-lint-<project>-<profile>.txt (table + exit code).
# EXDB_TREE = the tree under test; needs the pinned toolchain on PATH.
set -uo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
D="$here/.."
tree="${EXDB_TREE:-/home/david/Development/ExponetDB-verify-b3}"
work="$(mktemp -d)"
for p in hazard safe; do
  for prof in strict standard; do
    rm -rf "$work/$p-$prof"; cp -r "$D/fixtures/$p" "$work/$p-$prof"
    sed -i "s/^lintProfile: .*/lintProfile: $prof/" "$work/$p-$prof/exponetdb.project.yaml"
    out="$D/evidence/cli-lint-$p-$prof.txt"
    ( COLUMNS=200 bun --conditions=@exponetdb/source "$tree/apps/cli/src/main.ts" --workdir "$work/$p-$prof" \
        migration lint --postgres "${PG_MAJOR:-17}" --tier prod; echo "exit code: $?" ) > "$out" 2>&1
    # Show the fixture id (h04, s08, ...) instead of the ULID, padded to the ULID's width.
    for d in "$D/fixtures/$p"/*/; do
      b="$(basename "$d")"; ulid="${b%%_*}"; id="${b#*_}"; id="${id%%-*}"
      sed -i "s/$ulid/$(printf '%-26s' "$id")/g" "$out"
    done
    echo "$(basename "$out"): $(tail -n 3 "$out" | tr '\n' ' ')"
  done
done
rm -rf "$work"
