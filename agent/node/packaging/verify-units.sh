#!/usr/bin/env bash
# Checks the systemd units with `systemd-analyze verify` (syntax, directives,
# dependencies) in a scratch root that holds the host's own units and
# placeholder binaries at the installed paths, so nothing is installed on the
# machine that runs it. Their behavior under systemd is tested by the host
# test (apps/server/test/agent-capabilities.host.test.ts, CI job node-pg).
set -euo pipefail
here="$(cd "$(dirname "$0")" && pwd)"

# The agent must survive a helper outage (reads stay available, effects are
# refused): it names the helper socket only in Wants=/After=, so stopping the
# socket (an operator, a package's prerm/postinst, isolate) never stops it.
# The socket-activated helper is the one that Requires= its own socket.
agent="$here/systemd/exponetdb-node.service"
helper="$here/systemd/exponetdb-node-helper.service"
if grep -En '^(Requires|RequiresMountsFor|BindsTo|PartOf|Requisite|Upholds)=.*exponetdb-node-helper' "$agent"; then
  echo "$agent must name the helper only in Wants=/After=" >&2
  exit 1
fi
grep -Eq '^Wants=.*exponetdb-node-helper\.socket' "$agent" || { echo "$agent: Wants=exponetdb-node-helper.socket missing" >&2; exit 1; }
grep -Eq '^After=.*exponetdb-node-helper\.socket' "$agent" || { echo "$agent: After=exponetdb-node-helper.socket missing" >&2; exit 1; }
grep -Eq '^Requires=exponetdb-node-helper\.socket$' "$helper" || { echo "$helper: Requires=exponetdb-node-helper.socket missing" >&2; exit 1; }

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
