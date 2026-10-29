#!/usr/bin/env bash
# upgrades.md section 1: "rolling back the application by one release works without a schema rollback". Try exactly that:
# stop the three new roles and start the OLD build (d0229550) against the MIGRATED Control Store. Capture what each role does
# (exit status, journal, readiness body) and for how long it is observed.
. /srv/work/s3-infra/s3/lib.sh
OUT="${S3_LOGS}/rollback-documented"; mkdir -p "$OUT"
for r in serve worker gateway; do systemctl stop "${EXSTACK_UNIT_PREFIX}-${r}.service"; done
s3_units old
echo "== start the old build against the migrated store ($(now)); store: $(ro control-store status 2>&1 | jq -c '{status,expected,applied}' 2>/dev/null)"
t0=$(epoch_ms)
for r in worker gateway serve; do systemctl start "${EXSTACK_UNIT_PREFIX}-${r}.service" || echo "systemctl start ${r}: rc=$?"; done
sleep 12
echo "elapsed $(( $(epoch_ms) - t0 )) ms"
for r in worker gateway serve; do
  u="${EXSTACK_UNIT_PREFIX}-${r}.service"
  echo "--- $r: active=$(systemctl is-active $u) result=$(systemctl show -p Result --value $u) exit=$(systemctl show -p ExecMainStatus --value $u) pid=$(systemctl show -p MainPID --value $u)"
  journalctl --no-pager -o cat -u "$u" --since "-40 sec" | grep -v 'Started\|Stopped\|Consumed' | cut -c1-500 | tee "$OUT/$r.journal" | head -12
done
echo "--- readiness bodies (internal ports)"; role_versions
echo "--- public readiness: $(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:${EXSTACK_PORT_SERVE}/healthz/ready)"
echo "--- internal readiness detail (serve):"; curl -s -m 3 "http://127.0.0.1:${EXSTACK_PORT_INTERNAL_SERVE}/healthz/ready"; echo
echo "--- what does the product say with the old CLI/REST? "; s3_release old; exdb whoami 2>&1 | head -5; exdb target list 2>&1 | head -4
