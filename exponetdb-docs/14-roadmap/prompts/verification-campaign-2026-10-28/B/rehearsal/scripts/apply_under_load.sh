#!/usr/bin/env bash
# Applies a plan while pgbench (read/write mix on the big tables of lab_rhstg) runs; reports p99 latency and failed queries.
# usage: apply_under_load.sh PLAN_ID TAG [pre_seconds] [post_seconds]    (PLAN_ID applied with the CLI as the owner)
source /srv/work/s5/rehearsal/rh-lib.sh
PLAN="${1:?plan}"; TAG="${2:?tag}"; PRE="${3:-40}"; POST="${4:-40}"
PGB=/usr/lib/postgresql/18/bin/pgbench
rm -f "$L"/pgb-$TAG.*
APPLY_MAX=${APPLY_MAX:-240}
TOTAL=$((PRE + APPLY_MAX + POST))
( cd /tmp; runuser -u postgres -- "$PGB" -h /var/run/postgresql -p 55417 -n -c 8 -j 2 -R 300 -T "$TOTAL" --continue-on-error -P 10 \
    -f "$RH/pgbench_read.sql@8" -f "$RH/pgbench_write.sql@2" -l --log-prefix "$L/pgb-$TAG" lab_rhstg >"$L/pgb-$TAG.out" 2>&1 ) &
PGBPID=$!
sleep "$PRE"
A0=$(date +%s.%N)
( cd "$PROJ"; exdb plan apply "$PLAN" --wait ${EXTRA:-} >"$L/apply-$TAG.log" 2>&1 ); RC=$?
A1=$(date +%s.%N)
printf 'apply-under-load-%s\t%s\t%s\t%.1f\t%s\n' "$TAG" "$(date -u +%FT%TZ)" "$(date -u +%FT%TZ)" "$(echo "$A1 - $A0" | bc)" "$RC" >>"$TIMINGS"
sleep "$POST"
pkill -INT -f "[p]gbench.*pgb-$TAG" ; wait $PGBPID 2>/dev/null
echo "apply rc=$RC wall=$(echo "$A1 - $A0" | bc) s window=[$A0, $A1]"
tail -25 "$L/pgb-$TAG.out" | grep -E "number of transactions|failures|latency average|tps|skipped" 
python3 "$RH/pgbench_summary.py" "$L/pgb-$TAG" "$A0" "$A1"
tail -22 "$L/apply-$TAG.log" | cut -c1-200
