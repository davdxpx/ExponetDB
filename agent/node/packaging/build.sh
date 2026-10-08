#!/usr/bin/env bash
# Builds the release binaries of the node agent (Wave 5 Phase 6): the agent
# `exponetdb-node` and the root helper `exponetdb-node-helper`, statically
# linked for linux/amd64 and linux/arm64, with the version and the commit
# set, reproducible (-trimpath, no build ID); next to them the systemd units,
# the sysusers.d file and the installation runbook, and a SHA256SUMS file
# over all of it.
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
runbook="$here/../../exponetdb-docs/12-operations/node-runbook.md"
out="${2:-$here/dist}"
if ! printf '%s' "$version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$'; then
  echo "build.sh: $version is not a semantic version without build metadata" >&2
  exit 2
fi
commit="$(git -C "$here" rev-parse HEAD)"
if [ -n "$(git -C "$here" status --porcelain -- . "$runbook")" ]; then
  echo "build.sh: agent/node or the runbook has uncommitted changes; a release is built from a commit" >&2
  exit 2
fi
mkdir -p "$out"
cd "$here"
for arch in amd64 arm64; do
  for cmd in exponetdb-node exponetdb-node-helper; do
    # No inherited flags and no build tags: the e2e seams can never be
    # compiled into a release, whatever GOFLAGS or `go env -w` say.
    env -u GOFLAGS GOFLAGS= CGO_ENABLED=0 GOOS=linux GOARCH="$arch" go build -tags= -trimpath -buildvcs=false \
      -ldflags "-s -w -buildid= -X main.version=$version -X main.commit=$commit" \
      -o "$out/$cmd-$version-linux-$arch" "./cmd/$cmd"
    if go version -m "$out/$cmd-$version-linux-$arch" | grep -Eq '^[[:space:]]+build[[:space:]]+-tags='; then
      echo "build.sh: $cmd for $arch was built with tags" >&2
      exit 1
    fi
  done
done
mkdir -p "$out/systemd" "$out/sysusers.d" "$out/doc"
install -m 0644 packaging/systemd/exponetdb-node.service packaging/systemd/exponetdb-node-helper.service \
  packaging/systemd/exponetdb-node-helper.socket "$out/systemd/"
install -m 0644 packaging/sysusers.d/exponetdb-node.conf "$out/sysusers.d/"
install -m 0644 "$runbook" "$out/doc/node-runbook.md"
(cd "$out" && sha256sum -- *-"$version"-linux-* systemd/exponetdb-node.service \
  systemd/exponetdb-node-helper.service systemd/exponetdb-node-helper.socket \
  sysusers.d/exponetdb-node.conf doc/node-runbook.md > "SHA256SUMS-$version")
cat "$out/SHA256SUMS-$version"
