#!/usr/bin/env bash
# fail-closed step 2 (and observability step 4): Control Store read-only
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc2.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
echo "== baseline: $(mut) | $(read_probe)"
t0
echo "== T0 ALTER DATABASE ... SET default_transaction_read_only = on + terminate backends $(now)"
psql_control -qc "ALTER DATABASE exponetdb_control SET default_transaction_read_only = on"
echo "terminated backends: $(kill_cs_backends)"
timeline 130 2 20 60 120
echo "-- serve log: first lines per event (name causeCode)"
logs_since serve "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.errorCode,.errorName,.route]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- worker log"; logs_since worker "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- /healthz/detail serve:"; hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]'
echo "-- /installation/health (read still works?):"; bearer; rest GET /api/v1/installation/health | head -1; jq -c '{state:.state}' /dev/shm/s6out.last
echo "-- metrics store errors:"; curl -s http://$S/metrics | grep 'control_store_query_duration_seconds_count' | grep error | head -5
T1=$(date +%s.%N)
echo "== UNDO: RESET default_transaction_read_only (no backend termination) $(now)"
psql_control -qc "ALTER DATABASE exponetdb_control RESET default_transaction_read_only"
t0
timeline 60 15 40
echo "-- still not ready? terminate backends to force fresh sessions"
if [ "$(hc $S)" != 200 ]; then echo "terminated: $(kill_cs_backends)"; t0; timeline 90 10 30; fi
