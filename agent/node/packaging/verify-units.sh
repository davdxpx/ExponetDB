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

# A fresh host enrolls the node before any unit started (node-runbook.md section 3), so the
# agent's state directory has to come from tmpfiles.d, not from StateDirectory= (test campaign
# TC-039). The configuration is always read back through systemd; with root privileges the
# directory is also created in the scratch root and its owner and mode are checked, as the agent
# checks them (state.Open: owned by its user, no access for group or others).
mkdir -p "$root/usr/lib/sysusers.d" "$root/usr/lib/tmpfiles.d" "$root/etc"
cp "$here"/sysusers.d/*.conf "$root/usr/lib/sysusers.d/"
cp "$here"/tmpfiles.d/*.conf "$root/usr/lib/tmpfiles.d/"
systemd-tmpfiles --root="$root" --cat-config 2>/dev/null \
  | grep -Eq '^d /var/lib/exponetdb-node 0700 exponetdb-node exponetdb-node -$' \
  || { echo "tmpfiles.d does not create /var/lib/exponetdb-node (0700, exponetdb-node)" >&2; exit 1; }
if [ "$(id -u)" -eq 0 ]; then
  systemd-sysusers --root="$root"
  systemd-tmpfiles --root="$root" --create
  [ "$(stat -c %a "$root/var/lib/exponetdb-node")" = 700 ] \
    || { echo "/var/lib/exponetdb-node is not mode 0700" >&2; exit 1; }
  [ "$(stat -c %U "$root/var/lib/exponetdb-node")" = exponetdb-node ] \
    || { echo "/var/lib/exponetdb-node is not owned by exponetdb-node" >&2; exit 1; }
  echo "state directory created with mode 0700"
else
  echo "state directory configuration verified (creation is checked when run as root)"
fi
