#!/usr/bin/env bash
# Tears the disposable stack down to nothing but the cached source and build (so stack-up.sh is quick again).
# Removes: the three services, the Control Store container and its data, the node agent (units, binaries, state,
# enrolled identity), the PostgreSQL clusters "exdbnode" 16/17/18, firewall/netem rules and loop mounts the failure
# scripts created, the lab CA, every secret and the CLI sign-in. Keeps: EXSTACK_ROOT/src, EXSTACK_ROOT/build, logs.
#
#   stack-down.sh [--purge]     --purge also removes the source checkout, the build and the logs
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=stack-env.sh
. "${HERE}/stack-env.sh"
[ "$(id -u)" -eq 0 ] || { echo "run as root" >&2; exit 1; }
say() { printf '[down] %s\n' "$*" >&2; }

# things the failure-injection scripts may have left behind
iptables -D OUTPUT -j EXSTACK_FAIL 2>/dev/null; iptables -F EXSTACK_FAIL 2>/dev/null; iptables -X EXSTACK_FAIL 2>/dev/null
tc qdisc del dev lo root 2>/dev/null
for m in $(findmnt -rn -o TARGET | grep "^${EXSTACK_ROOT}/loop" | sort -r); do umount -l "$m" 2>/dev/null; done
timedatectl set-ntp true 2>/dev/null

say "services"
for r in serve worker gateway; do systemctl disable --now "${EXSTACK_UNIT_PREFIX}-${r}.service" 2>/dev/null; rm -f "/etc/systemd/system/${EXSTACK_UNIT_PREFIX}-${r}.service"; done
say "node agent"
systemctl disable --now exponetdb-node.service exponetdb-node-helper.socket exponetdb-node-helper.service 2>/dev/null
rm -f /etc/systemd/system/exponetdb-node.service /etc/systemd/system/exponetdb-node-helper.service /etc/systemd/system/exponetdb-node-helper.socket \
      /usr/bin/exponetdb-node /usr/sbin/exponetdb-node-helper
rm -rf /etc/exponetdb-node /var/lib/exponetdb-node /var/lib/exponetdb-node-helper /var/lib/exponetdb-node-engine /usr/share/doc/exponetdb-node /run/exponetdb-node
systemctl daemon-reload
say "Control Store"
docker rm -f "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1
rm -rf "${EXSTACK_CONTROL_DATA}"
say "target clusters"
for v in 16 17 18; do
  if pg_lsclusters -h 2>/dev/null | awk '{print $1"/"$2}' | grep -qx "${v}/${EXSTACK_CLUSTER_NAME}"; then pg_dropcluster --stop "$v" "${EXSTACK_CLUSTER_NAME}" 2>/dev/null; fi
  rm -rf "/etc/postgresql/${v}/${EXSTACK_CLUSTER_NAME}" "/var/lib/postgresql/${v}/${EXSTACK_CLUSTER_NAME}"
done
say "secrets and state"
rm -rf "${EXSTACK_STATE}" "${EXSTACK_ROOT}/audit-export" "${EXSTACK_ROOT}/projects"
if [ "${1:-}" = "--purge" ]; then
  say "source, build and logs"
  rm -rf "${EXSTACK_SRC}" "${EXSTACK_BUILD}" "${EXSTACK_LOGS}"
fi
say "done"
