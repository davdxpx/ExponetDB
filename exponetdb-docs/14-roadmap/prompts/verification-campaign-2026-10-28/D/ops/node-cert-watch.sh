#!/usr/bin/env bash
# Read-only watch of one node's certificate and heartbeat (TC-042 / OD-62: the product does not warn yet).
# Uses only `exponetdb node show --output json`; changes nothing.
#
#   EXDB_CLI="exponetdb" ./node-cert-watch.sh nod_...            # installed CLI
#   EXDB_CLI="bun --conditions=@exponetdb/source apps/cli/src/main.ts" ./node-cert-watch.sh nod_...   # from a checkout
#   OLD_EXPIRY=2026-10-30T05:57:35.751Z ./node-cert-watch.sh nod_...   # to recognise a renewal
#
# Exit codes: 0 fine or renewed, 1 act now (offline or expired inside the renewal window), 2 cannot read.
# The agent renews when two thirds of the certificate's lifetime have passed (agent/node/internal/enroll
# DueForRenewal), with a 72 h certificate that is the last 24 h, and retries on every turn of its loop.
set -euo pipefail
NODE="${1:?node id (nod_...)}"
CLI="${EXDB_CLI:-exponetdb}"
LIFETIME_H="${CERT_LIFETIME_HOURS:-72}"
OFFLINE_AFTER_S="${OFFLINE_AFTER_SECONDS:-300}"

# shellcheck disable=SC2086
json="$($CLI node show "$NODE" --output json 2>/dev/null)" || { echo "UNREADABLE: the CLI failed (login expired? run: exponetdb auth login)"; exit 2; }
state="$(jq -r '.data.state' <<<"$json")"
expiry="$(jq -r '.data.nodeCertificateExpiresAt' <<<"$json")"
beat="$(jq -r '.data.lastHeartbeatAt' <<<"$json")"
now="$(date -u +%s)"
exp_s="$(date -u -d "$expiry" +%s)"
beat_s="$(date -u -d "$beat" +%s)"
left_h=$(( (exp_s - now) / 3600 ))
beat_age=$(( now - beat_s ))
window_opens_s=$(( exp_s - LIFETIME_H * 3600 / 3 ))

echo "node=$NODE state=$state heartbeat_age=${beat_age}s expires=$expiry (in ${left_h}h) renewal_window_opens=$(date -u -d "@$window_opens_s" +%FT%TZ)"

if [ -n "${OLD_EXPIRY:-}" ] && [ "$(date -u -d "$OLD_EXPIRY" +%s)" -lt "$exp_s" ]; then
  echo "RENEWED: expiry moved from $OLD_EXPIRY to $expiry"; exit 0
fi
if [ "$exp_s" -le "$now" ]; then
  echo "EXPIRED: follow RB-13 (node-runbook.md section 6): decommission, move /var/lib/exponetdb-node aside, enroll again"; exit 1
fi
if [ "$now" -lt "$window_opens_s" ]; then
  echo "WAIT: the renewal window has not opened"; exit 0
fi
if [ "$state" != "active" ] || [ "$beat_age" -gt "$OFFLINE_AFTER_S" ]; then
  echo "ACT NOW: inside the renewal window and the node is $state / silent for ${beat_age}s. On the host: systemctl status exponetdb-node; journalctl -u exponetdb-node --since -1h; sudo -u exponetdb-node exponetdb-node status. A node back inside the window renews within seconds; past the end it needs RB-13."
  exit 1
fi
echo "IN WINDOW, NOT RENEWED YET: the node heartbeats, the agent retries on every turn; check again in 15 minutes. Still unchanged after 2 h: read the agent journal for 'renew' errors (gateway or Control Plane side)."
exit 0
