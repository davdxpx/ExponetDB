#!/usr/bin/env bash
# fail-closed step 5 (and observability steps): 200 concurrent reads against a Control Store whose hot table is locked
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc5.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
LD=/srv/work/s6-infra/s6/load.mjs
bearer
echo "== baseline: 200 concurrent GET /api/v1/targets for 10 s"
node $LD --url $API/api/v1/targets --headers $HDR --c 200 --seconds 10 --label baseline200
echo "readiness after: serve=$(hc $S)"
echo "== locked table: registry.targets ACCESS EXCLUSIVE for 40 s, load 200 concurrent for 55 s $(now)"
t0
node $LD --url $API/api/v1/targets --headers $HDR --c 200 --seconds 55 --timeout-ms 90000 --label locked200 > $L6/fc5.load 2>&1 &
LP=$!
( sleep 4; psql_control -qc "BEGIN; LOCK TABLE registry.targets IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(40); COMMIT" >/dev/null; echo "lock released at t=$(el)" ) &
timeline 100 8 30 48 70
wait $LP
echo "load result:"; cat $L6/fc5.load
echo "-- control store: pg_stat_activity of the roles at end: $(ctl_sql "select usename||'='||count(*) from pg_stat_activity where datname='exponetdb_control' group by usename" | tr '\n' ' ')"
echo "-- serve log events:"; logs_since serve "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.errorCode,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- /healthz/detail now: $(hdetail $S | jq -c '[.status, (.checks[]|select(.status!="pass")|{name,status,reason})]')"
echo "-- store histogram, readiness.ping:"; curl -s http://$S/metrics | grep 'query_class="readiness' | grep -E "_count|_sum" | head -6
