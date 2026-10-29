#!/usr/bin/env bash
# fail-closed step 4: Control Store unreachable (docker pause), plus an in-flight apply across the pause
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc4.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
PG=pg16
bearer
echo "== A. pause 60 s with idle roles $(now)"
t0
docker pause "$EXSTACK_CONTROL_NAME" >/dev/null
echo "paused at $(now)"
( sleep 60; docker unpause "$EXSTACK_CONTROL_NAME" >/dev/null; echo "unpaused at $(now) (t=$(el))" ) &
timeline 100 3 30
echo "-- serve log events:"; logs_since serve "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.errorCode,.errorName,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- worker log events:"; logs_since worker "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- gateway log events:"; logs_since gateway "-3 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.causeCode,.code]|@tsv' | sort | uniq -c | sort -rn | head
echo "-- after: ready serve=$(hc $S) worker=$(hc $W) gateway=$(hc $G); mutation: $(mut)"
echo "-- restarts needed? process start times:"; for r in serve worker gateway; do echo "$r active-since $(systemctl show -p ActiveEnterTimestamp --value $(_stk_unit $r))"; done
echo
echo "== B. in-flight apply (60 s statement), store paused 40 s mid-statement $(now)"
T="$(add_target s6pause $PG)"; db=lab_s6pause
PGDATABASE="$db" psql_target $PG -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
dir="$(new_project s6pause)"
id="$(mkb "$dir" long-sleep <<SQL
SELECT nextval('public.exec_seq');
CREATE TABLE public.pz_first (id int PRIMARY KEY);
SELECT pg_sleep(60);
CREATE TABLE public.pz_a (id int PRIMARY KEY);
GRANT SELECT ON public.pz_a TO lab_owner;
SQL
)"
mplan "$dir" "$T" || exit 1
mapply "$PLAN_ID" --no-wait; op="$OP_ID"
sleep 12; echo "op before pause: $(op_state $op)"
docker pause "$EXSTACK_CONTROL_NAME" >/dev/null; echo "paused at $(now)"; sleep 40; docker unpause "$EXSTACK_CONTROL_NAME" >/dev/null; echo "unpaused at $(now)"
ts=$(date +%s); last=""; end=$((ts+240))
while [ "$(date +%s)" -lt "$end" ]; do
  cur="$(op_state "$op")"; [ "$cur" != "$last" ] && { echo "  [+$(( $(date +%s) - ts ))s after unpause] $cur"; last="$cur"; }
  case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac; sleep 2
done
led="$(PGDATABASE="$db" psql_target $PG -Atc "select count(*) from exponetdb.schema_migrations where migration_id='$id'")"
execs="$(PGDATABASE="$db" psql_target $PG -Atc "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public.exec_seq")"
echo "result: op=[$cur] ledger rows=$led first statement executed ${execs}x"
echo "events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'') from operations.operation_events where operation_id='$op' order by event_id" | tr '\n' ';' | cut -c1-700)"
echo "worker log:"; logs_since worker "-4 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.ts,.msg,.code,.causeCode,.operationId]|@tsv' | head -12
