#!/usr/bin/env bash
# The loss: stop AND remove the Control Store container together with its data directory (the volume). The three roles are left running
# (as they would be on the owner's host: the Coolify PostgreSQL resource is gone, the applications are not). What does the operator see?
. /srv/work/s3-infra/s3/lib.sh
s3_release new
OUT="${S3_LOGS}/loss"; mkdir -p "$OUT"
snap() { # label
  echo "--- $1 (+$(( $(date +%s) - T0 )) s)"
  for r in serve:$EXSTACK_PORT_INTERNAL_SERVE worker:$EXSTACK_PORT_INTERNAL_WORKER gateway:$EXSTACK_PORT_INTERNAL_GATEWAY; do
    printf '  %s ready: %s | live: %s\n' "${r%%:*}" "$(curl -s -m 3 -w ' [%{http_code}]' "http://127.0.0.1:${r#*:}/healthz/ready" | cut -c1-200)" "$(curl -s -m 3 -o /dev/null -w '%{http_code}' "http://127.0.0.1:${r#*:}/healthz/live")"
  done
  echo "  public ready: $(curl -s -m 3 -w ' [%{http_code}]' "http://127.0.0.1:${EXSTACK_PORT_SERVE}/healthz/ready" | cut -c1-200)"
  echo "  CLI target list: $(exdb target list 2>&1 | head -2 | tr '\n' '|' | cut -c1-260)"
  echo "  systemd: $(for r in serve worker gateway; do printf '%s=%s ' $r "$(systemctl is-active "$(_stk_unit $r)")"; done)"
}
T0=$(date +%s); echo "destroying the Control Store at $(now)"
docker rm -f "${EXSTACK_CONTROL_NAME}" >/dev/null && rm -rf "${EXSTACK_CONTROL_DATA}"
echo "container: $(docker ps -a --filter name=${EXSTACK_CONTROL_NAME} --format '{{.Names}}' | wc -l) left; data dir: $(ls "${EXSTACK_CONTROL_DATA}" 2>&1 | head -1)"
sleep 3; snap "3 s after"
sleep 20; snap "23 s after"
sleep 40; snap "63 s after"
echo "--- logs of the roles in the last 70 s (errors and warnings, 4 lines each)"
for r in serve worker gateway; do echo "  [$r]"; journal "$r" --since "-70 sec" | grep -E '"level":"(error|warn)"' | cut -c1-260 | tail -4; done
echo "--- node agent (last 4 lines)"; journalctl --no-pager -o cat -u exponetdb-node --since "-70 sec" | cut -c1-260 | tail -4
echo "--- which signals would an alert get? metrics endpoint of serve (internal listener) lines mentioning store/ready:"
curl -s -m 3 "http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/metrics" 2>/dev/null | grep -iE "ready|store|up\b" | head -6
