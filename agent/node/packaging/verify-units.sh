#!/usr/bin/env bash
# Checks the systemd units with `systemd-analyze verify` (syntax, directives,
# dependencies) in a scratch root that holds the host's own units and
# placeholder binaries at the installed paths, so nothing is installed on the
# machine that runs it. Their behavior under systemd is tested by the host
# test (apps/server/test/agent-capabilities.host.test.ts, CI job node-pg).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"
root="$(mktemp -d)"
trap 'rm -rf "$root"' EXIT
mkdir -p "$root/usr/lib" "$root/usr/bin" "$root/usr/sbin" "$root/etc/systemd/system"
cp -a /usr/lib/systemd "$root/usr/lib/"
for b in usr/bin/exponetdb-node usr/sbin/exponetdb-node-helper; do
  printf '#!/bin/sh\nexit 0\n' > "$root/$b"
  chmod 0755 "$root/$b"
done
cp "$here"/systemd/* "$root/etc/systemd/system/"
systemd-analyze verify --man=no --root="$root" \
  exponetdb-node.service exponetdb-node-helper.service exponetdb-node-helper.socket
echo "units verified"
