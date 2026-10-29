#!/usr/bin/env bash
# fail-closed step 1 (and step 7, data read before audit): detach the current month's audit partition
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc1.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
M=audit_events_y$(date -u +%Y)m$(date -u +%m)
D18=$(jq -r .target_dev18 ${EXSTACK_STATE}/ids.json)
echo "== baseline $(now)"; echo "audit head: $(audit_head)"; mut; read_probe; hc $S; echo
# target log for the data-read test
psql_target pg18 -qc "ALTER SYSTEM SET log_statement='all'" -c "select pg_reload_conf()" >/dev/null
rm -f $L6/fc1.ready; ( ready_sampler $L6/fc1.ready 240 ) &
SAMP=$!
HS0=$(ctl_sql "select count(*) from observation.health_samples")
echo "== T0 detach $M $(now)"
psql_control -qc "ALTER TABLE audit.audit_events DETACH PARTITION audit.$M"
sleep 1
echo "-- (a) mutation (plan create), JSON:";  mut
echo "-- (a') mutation, operator text:";     mut_text
echo "-- login by the scripted human (session create is audited):"; human call GET /api/v1/auth/session 2>&1 | head -c 300; echo
bearer; echo "-- (f) read GET /api/v1/targets:"; read_probe
echo "-- (b) serve log http.request_failed (field names as logged):"
logs_since serve "-2 min" | grep -m3 http.request_failed
echo "-- (c) readiness: serve=$(hc $S) worker=$(hc $W) gateway=$(hc $G) public=$(curl -s -m 3 -o /dev/null -w '%{http_code}' $API/healthz/ready)"
hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]'
echo "-- (d) /installation/health:"; rest GET /api/v1/installation/health | head -1; jq -c '{state:.state, comps:[.components[]?|{id:(.id // .name),state,reasons}]}' /dev/shm/s6out.last 2>/dev/null | head -c 1500; echo
echo "-- step 7: data read with the append failing (marker in the target log)"
MK=s6mark$RANDOM
rest POST /api/v1/targets/$D18/queries "$(jq -nc --arg m "select '$MK' as m" '{sql:$m}')" | head -1; head -c 300 /dev/shm/s6out.last; echo
sleep 1; echo "target log hits for marker: $(grep -c "$MK" /var/log/postgresql/postgresql-18-${EXSTACK_CLUSTER_NAME}.log)"
echo "-- worker side effects while appends fail:"
sleep 100
echo "health_samples before=$HS0 after=$(ctl_sql 'select count(*) from observation.health_samples')"
echo "audit head (rows readable via the parent): $(audit_head)"
echo "worker log (last 2 min, warn/error names):"; logs_since worker "-3 min" | jq -r 'select(.level=="warn" or .level=="error")|.event // .msg' 2>/dev/null | sort | uniq -c | head
echo "serve metrics 5xx:"; curl -s http://$S/metrics | grep 'exdb_http_requests_total' | grep 5xx
echo "== re-attach $(now)"
psql_control -qc "ALTER TABLE audit.audit_events ATTACH PARTITION audit.$M FOR VALUES FROM ('$(date -u +%Y-%m-01) 00:00:00+00') TO ('$(date -u -d "$(date -u +%Y-%m-01) +1 month" +%Y-%m-%d) 00:00:00+00')"
sleep 1; echo "-- first mutation after:"; mut
echo "audit head: $(audit_head)"
echo "-- audit verify:"; ro audit verify 2>&1 | tail -3
psql_target pg18 -qc "ALTER SYSTEM RESET log_statement" -c "select pg_reload_conf()" >/dev/null
kill $SAMP 2>/dev/null; sleep 1
echo "-- readiness transitions during the test (epoch serve worker gateway public):"; awk '{k=$2" "$3" "$4" "$5; if(k!=p){print; p=k}}' $L6/fc1.ready
