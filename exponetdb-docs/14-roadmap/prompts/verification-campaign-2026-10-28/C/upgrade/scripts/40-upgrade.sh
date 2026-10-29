#!/usr/bin/env bash
# The upgrade exactly as upgrades.md and deployment.md section 6 / the 2026-10-21 record describe it, on the systemd stand-in for the
# owner's Coolify resources ("image" = the bundle of a commit; "set the tag" = point the unit at the new bundle):
#   1. backup (20-dump.sh, before this script)           2. the one-shot migration resource: `control-store migrate` as exdb_migrate
#   3. worker, 4. gateway, 5. serve deployed from the same build (the record's order)       6. readiness of each role
# Every role's readiness is sampled every 50 ms (sampler.mjs) so the downtime of each is measured, not estimated.
. /srv/work/s3-infra/s3/lib.sh
s3_release old
RUN="${1:-up1}"
SLOG="${S3_LOGS}/sampler-${RUN}.log"
sampler_start "$SLOG"; sleep 1
T0=$(epoch_ms); timing upgrade "start" 0 "run=$RUN"
echo "== 2. migration resource ($(now))"
t0=$(epoch_ms)
migrate_out="$(EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_migrate)" "${EXSTACK_NODE_BIN}" --liftoff-only ${NEW_ROOT}/build/bundle/bin/exponetdb.mjs control-store migrate 2>&1)"; rc=$?
t1=$(epoch_ms); timing upgrade "migrate" "$((t1 - t0))" "rc=$rc"
echo "$migrate_out" | jq -c '{status: .state.status, installationId, applied: (.applied // .state.applied // null), pending: (.state.pending // null)}' 2>/dev/null || echo "$migrate_out" | head -20
echo "$migrate_out" >"${S3_LOGS}/migrate-${RUN}.out"
echo "migrate exit $rc in $((t1 - t0)) ms"
sleep 3
echo "readiness of the OLD roles on the migrated store:"; role_versions
deploy_role() { # role
  local r="$1" unit="${EXSTACK_UNIT_PREFIX}-$1.service" ts0 ts1 ts2 port
  case "$r" in serve) port=$EXSTACK_PORT_INTERNAL_SERVE;; worker) port=$EXSTACK_PORT_INTERNAL_WORKER;; gateway) port=$EXSTACK_PORT_INTERNAL_GATEWAY;; esac
  ts0=$(epoch_ms); systemctl stop "$unit"; ts1=$(epoch_ms)
  sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) --liftoff-only ${NEW_ROOT}/build/bundle/bin/exponetdb.mjs ${r}|" "/etc/systemd/system/${unit}"; systemctl daemon-reload
  systemctl start "$unit"
  local i; for i in $(seq 1 600); do curl -fs -m 1 -o /dev/null "http://127.0.0.1:${port}/healthz/ready" && break; sleep 0.1; done
  ts2=$(epoch_ms)
  timing upgrade "deploy-${r}" "$((ts2 - ts0))" "stop=$((ts1 - ts0))ms start-to-ready=$((ts2 - ts1))ms ready_polls=$i"
  echo "deploy ${r}: stop $((ts1 - ts0)) ms, start to ready $((ts2 - ts1)) ms"
}
echo "== 3-5. worker, gateway, serve"
for r in worker gateway serve; do deploy_role "$r"; done
T1=$(epoch_ms); timing upgrade "end" "$((T1 - T0))" "migrate start to last role ready"
sleep 2; sampler_stop
echo "total: $((T1 - T0)) ms"; role_versions
echo "sampler log: $SLOG"
