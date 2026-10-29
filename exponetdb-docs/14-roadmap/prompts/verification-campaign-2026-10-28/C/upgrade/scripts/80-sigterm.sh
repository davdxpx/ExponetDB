#!/usr/bin/env bash
# (f) A redeploy of the worker during a running 60 s apply, on the NEW release. The stop is the one `docker stop --time N` does
# (SIGTERM, SIGKILL after N seconds; the container's PID 1 is the node process, STOPSIGNAL SIGTERM): N=10 is Docker's default
# (no deploy file or runbook sets another), N=60 is what the C1 finding proposes. Adapted from B/failure/C1-hypotheses.sh (90 s there).
# Records: exit status, the process log, the heartbeat row, the target session, the ledger, the operation and its events after restart.
. /srv/work/s3-infra/s3/lib.sh
s3_release new
OUT="${S3_LOGS}/sigterm"; mkdir -p "$OUT"
PG=pg16; SECS="${SECS:-60}"
graceful_stop() { # role seconds
  local u pid t0 killed=no; u="$(_stk_unit "$1")"; pid="$(systemctl show -p MainPID --value "$u")"
  t0=$(date +%s.%N); kill -TERM "$pid"
  local i; for i in $(seq 1 $(( $2 * 10 ))); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; killed=yes; fi
  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  sleep 1
  echo "exit=$(systemctl show -p ExecMainStatus --value "$u") signal=$(systemctl show -p ExecMainStatus --value "$u" | awk '$1==137{print "KILL"}') result=$(systemctl show -p Result --value "$u") after $(printf '%.1f' "$(echo "$(date +%s.%N) - $t0" | bc)")s killed=${killed}"
}
sess() { PGDATABASE="$1" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(${SECS})%' AND pid <> pg_backend_pid()"; }
for grace in ${GRACES:-10 60}; do
  tag="${grace}${NONTX:+n}"; echo "=================== docker stop --time ${grace} (apply: ${SECS} s statement) $(now)"
  T="$(add_target "s3sig${tag}" "$PG" 2>/dev/null)"; db="lab_s3sig${tag}"
  PGDATABASE="$db" psql_target "$PG" -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
  dir="$(new_project "sig-${tag}")"
  id="$(mkb "$dir" "long-sleep" ${NONTX:+--nontransactional} <<SQL
SELECT nextval('public.exec_seq');
CREATE TABLE public.sig_first (id int PRIMARY KEY);
SELECT pg_sleep(${SECS});
CREATE TABLE public.sig_a (id int PRIMARY KEY);
GRANT SELECT ON public.sig_a TO lab_owner;
SQL
)"
  mplan "$dir" "$T" || { echo "plan refused"; continue; }
  mapply "$PLAN_ID" --no-wait; op="$OP_ID"
  k=0; while [ $k -lt 400 ]; do [ "$(sess "$db")" = 1 ] && break; sleep 0.1; k=$((k+1)); done
  sleep 10
  echo "statement running since ~10 s; op: $(op_state "$op")"
  wpid="$(systemctl show -p MainPID --value "$(_stk_unit worker)")"
  stopped="$(graceful_stop worker "$grace")"; echo "worker stopped: ${stopped}"
  echo "worker log tail:"; journal worker --since "-90 sec" | grep -E 'process\.(stopping|stopped|forced_exit)|error|warn' | cut -c1-300 | tail -6
  echo "right after the exit: op=[$(op_state "$op")] ledger=$(ledger_count_ "$db" "$id" 2>/dev/null || PGDATABASE="$db" psql_target "$PG" -Atc "select count(*) from exponetdb.schema_migrations where migration_id='$id'") target sessions in the statement=$(sess "$db")"
  echo "heartbeat rows of the worker: $(ctl_sql "select process_id, stopped_at is not null as stopped, heartbeat_at from control.process_heartbeats where role='worker' order by started_at desc limit 2" | tr '\n' ';')"
  sleep 5; systemctl start "$(_stk_unit worker)"; ts=$(date +%s)
  last=""; end=$(( ts + 300 ))
  while [ "$(date +%s)" -lt "$end" ]; do
    cur="$(op_state "$op")"; [ "$cur" != "$last" ] && { echo "  [+$(( $(date +%s) - ts ))s after restart] $cur"; last="$cur"; }
    case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac; sleep 2
  done
  led="$(PGDATABASE="$db" psql_target "$PG" -Atc "select count(*) from exponetdb.schema_migrations where migration_id='$id'")"
  tabs="$(PGDATABASE="$db" psql_target "$PG" -Atc "select coalesce(string_agg(relname, ','), '-') from pg_class where relnamespace='public'::regnamespace and relkind='r'")"
  execs="$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public.exec_seq")"
  echo "after restart: op=[${cur}] ledger rows=${led} tables=[${tabs}] first statement started ${execs}x"
  echo "operation events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'')||coalesce(left(detail::text,60),'') from operations.operation_events where operation_id='$op' order by event_id" | tr '\n' ';' | cut -c1-900)"
  echo "$grace	$stopped	$cur	ledger=$led	execs=$execs" >>"$OUT/summary.tsv"
done
