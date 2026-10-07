#!/usr/bin/env bash
# Builds the release binaries of the node agent (Wave 5 Phase 6): the agent
# `exponetdb-node` and the root helper `exponetdb-node-helper`, statically
# linked for linux/amd64 and linux/arm64, with the version and the commit
# set, reproducible (-trimpath, no build ID), and a SHA256SUMS file.
#
# Never the e2e test seams: the release build has no build tags. The
# binaries carry no key, certificate or installation identity; a node gets
# those only at enrollment.
#
# Usage: agent/node/packaging/build.sh <version> [output directory]
#        (version: semantic version without build metadata, e.g. 1.0.0)
set -euo pipefail
version="${1:?usage: build.sh <version> [output directory]}"
here="$(cd "$(dirname "$0")/.." && pwd)"
out="${2:-$here/dist}"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "build.sh: $version is not a semantic version without build metadata" >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"
if [ -n "$(git -C "$here" status --porcelain -- .)" ]; then
  echo "build.sh: agent/node has uncommitted changes; a release is built from a commit" >&2
  exit 2
fi
mkdir -p "$out"
cd "$here"
for arch in amd64 arm64; do
  for cmd in exponetdb-node exponetdb-node-helper; do
    CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$version -X main.commit=$commit" \
      -o "$out/$cmd-$version-linux-$arch" "./cmd/$cmd"
  done
done
(cd "$out" && sha256sum -- *-"$version"-linux-* > "SHA256SUMS-$version")
cat "$out/SHA256SUMS-$version"
