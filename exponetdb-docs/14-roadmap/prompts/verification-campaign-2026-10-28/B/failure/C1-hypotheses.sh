#!/usr/bin/env bash
# Two static hypotheses of reviewer C1 (EV/F/findings-C1.md), confirmed or refuted on the running stack.
#
#   C1-hypotheses.sh hol         HEAD-OF-LINE BLOCKING: a parked (needs_attention) operation holds target A's schema domain; plan P1 on A
#                                queues behind it; plan P2 on another target B (disjoint domain) is applied. Does P2 run to succeeded,
#                                or is it never claimed while P1 is the oldest waiter? How many operation_events does P1 collect in 60 s?
#   C1-hypotheses.sh redeploy    REDEPLOY DURING AN APPLY: a migration with a 90 s pg_sleep, the worker is stopped after 10 s the way
#                                `docker stop --time N` does (SIGTERM, SIGKILL after N seconds), once with N=60 and once with N=10. Records the exit
#                                status, whether the apply finished, the ledger, the operation after the restart, and whether anything re-ran.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PG=pg16
OUT="${S1_LOGS}/C1"; mkdir -p "$OUT"

events_of() { ctl_sql "SELECT count(*) FROM operations.operation_events WHERE operation_id='$1'"; }

hol() {
  local log="${OUT}/hol.log"
  # target A: the target of the oldest parked migration operation whose schema domain is still held
  local parked a_tid a_path
  parked="$(ctl_sql "SELECT o.operation_id||'|'||l.domain_key FROM operations.operations o JOIN operations.operation_locks l USING (operation_id) WHERE o.state='needs_attention' AND l.domain_key LIKE 'target:%:schema' ORDER BY o.created_at LIMIT 1")"
  if [ -z "$parked" ]; then verdict C1.head_of_line NOT_RUN "no parked operation holding a schema domain (run I9-exits.sh first)"; return; fi
  a_tid="$(sed 's/.*target:\(tgt_[0-9A-Z]*\):schema/\1/' <<<"$parked")"
  a_path="$(exdb_json target list | jq -r --arg id "$a_tid" '.data.items[] | select(.id==$id) | .path // .name // empty')"
  [ -z "$a_path" ] && a_path="$a_tid"
  echo "A = ${a_path} (${a_tid}) parked by ${parked%%|*}: $(op_state "${parked%%|*}")"
  local B; B="$(fresh_target hol "$PG")"; echo "B = $B"
  local d1 d2 p1 p2
  d1="$(new_project hol-a-${RUN_TAG})"; d2="$(new_project hol-b-${RUN_TAG})"
  mkb "$d1" p1-on-a >/dev/null <<'SQL'
CREATE TABLE public.hol_a (id int PRIMARY KEY);
GRANT SELECT ON public.hol_a TO lab_owner;
SQL
  mkb "$d2" p2-on-b >/dev/null <<'SQL'
CREATE TABLE public.hol_b (id int PRIMARY KEY);
GRANT SELECT ON public.hol_b TO lab_owner;
SQL
  mplan "$d1" "$a_path" || { verdict C1.head_of_line NOT_RUN "P1 could not be planned on A: ${PLAN_STATE}"; return; }
  mapply "$PLAN_ID" --no-wait; p1="$OP_ID"
  mplan "$d2" "$B" || { verdict C1.head_of_line NOT_RUN "P2 could not be planned on B"; return; }
  mapply "$PLAN_ID" --no-wait; p2="$OP_ID"
  local t0 e0 st2="" st1="" t_run=""; t0=$(date +%s); e0="$(events_of "$p1")"
  echo "P1=$p1 (on A) P2=$p2 (on B); P1 events at start: $e0"
  local i
  for i in $(seq 1 30); do
    st1="$(op_state "$p1" | cut -d' ' -f1)"; st2="$(op_state "$p2" | cut -d' ' -f1)"
    [ -z "$t_run" ] && [ "$st2" != queued ] && t_run=$(( $(date +%s) - t0 ))
    printf '  [+%2ss] P1=%-8s P2=%-9s P1 events=%s\n' "$(( $(date +%s) - t0 ))" "$st1" "$st2" "$(events_of "$p1")"
    [ "$st2" = succeeded ] && [ $i -gt 6 ] && break
    sleep 2
  done
  local e1; e1="$(events_of "$p1")"
  echo "P1 operation_events: ${e0} -> ${e1} in $(( $(date +%s) - t0 )) s; waitingFor: $(exdb_json operation show "$p1" | jq -c '.data.waitingFor')"
  exdb_json operation cancel "$p1" >/dev/null 2>&1
  if [ "$st2" = succeeded ]; then
    verdict C1.head_of_line PASS "P2 on B ended succeeded${t_run:+ (left queued after ${t_run}s)} while P1 queued behind the parked operation on A; P1 collected $(( e1 - e0 )) events"
  else
    verdict C1.head_of_line FAIL "P2 on B (disjoint domain) is '${st2}' after $(( $(date +%s) - t0 )) s while P1 waits behind the parked operation on A; P1 events ${e0} -> ${e1}"
  fi
}

# stop a unit the way `docker stop --time N` does: SIGTERM, SIGKILL after N seconds; echoes "exit=<status> after <s>s killed=<yes|no>"
graceful_stop() { # role seconds
  local u pid t0 killed=no; u="$(_stk_unit "$1")"; pid="$(systemctl show -p MainPID --value "$u")"
  t0=$(date +%s.%N)
  kill -TERM "$pid"
  local i; for i in $(seq 1 $(( $2 * 10 ))); do kill -0 "$pid" 2>/dev/null || break; sleep 0.1; done
  if kill -0 "$pid" 2>/dev/null; then kill -KILL "$pid"; killed=yes; fi
  while kill -0 "$pid" 2>/dev/null; do sleep 0.1; done
  sleep 1
  echo "exit=$(systemctl show -p ExecMainStatus --value "$u") result=$(systemctl show -p Result --value "$u") after $(printf '%.0f' "$(echo "$(date +%s.%N) - $t0" | bc)")s killed=${killed}"
}

redeploy() {
  local grace
  for grace in 60 10; do
    local log="${OUT}/redeploy-${grace}.log"
    local T db dir id op
    T="$(fresh_target "rd${grace}" "$PG")"; db="$(target_db "$T")"; dir="$(new_project "rd-${grace}-${RUN_TAG}")"
    PGDATABASE="$db" psql_target "$PG" -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
    id="$(mkb "$dir" "long-sleep" <<'SQL'
SELECT nextval('public.exec_seq');
SELECT pg_sleep(90);
CREATE TABLE public.rd_a (id int PRIMARY KEY);
GRANT SELECT ON public.rd_a TO lab_owner;
SQL
)"
    mplan "$dir" "$T" || { verdict "C1.redeploy_${grace}" NOT_RUN "plan refused"; continue; }
    mapply "$PLAN_ID" --no-wait; op="$OP_ID"
    local k=0; while [ $k -lt 400 ]; do [ "$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(90)%' AND pid <> pg_backend_pid()")" = 1 ] && break; sleep 0.1; k=$((k+1)); done
    sleep 10
    echo "== grace ${grace}s: statement running since ~10 s; op: $(op_state "$op")"
    local stopped; stopped="$(graceful_stop worker "$grace")"
    echo "worker stopped: ${stopped}"
    local at_exit_op at_exit_led at_exit_sessions
    at_exit_op="$(op_state "$op")"; at_exit_led="$(ledger_count "$PG" "$db" "$id")"
    at_exit_sessions="$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(90)%' AND pid <> pg_backend_pid()")"
    echo "right after the worker exited: op=[${at_exit_op}] ledger=${at_exit_led} target sessions still in the statement=${at_exit_sessions}"
    sleep 5
    systemctl start "$(_stk_unit worker)"
    local end=$(( $(date +%s) + 300 )) cur last=""
    while [ "$(date +%s)" -lt "$end" ]; do
      cur="$(op_state "$op")"; [ "$cur" != "$last" ] && { echo "  [$(date -u +%T)] $cur"; last="$cur"; }
      case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac
      sleep 2
    done
    local led tabs execs
    led="$(ledger_count "$PG" "$db" "$id")"; tabs="$(tables_in "$PG" "$db")"
    execs="$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT CASE WHEN is_called THEN last_value ELSE 0 END FROM public.exec_seq")"
    echo "after restart: op=[${cur}] ledger=${led} objects=[${tabs}] first statement started ${execs}x"
    local v=PASS why="worker stopped ${stopped}"
    [ "${execs:-0}" -gt 1 ] 2>/dev/null && { v=FAIL; why="${why}; RE-EXECUTED: the first statement started ${execs} times"; }
    if [ "${cur%% *}" = succeeded ] && [ "$led" != 1 ]; then v=FAIL; why="${why}; succeeded without a ledger row"; fi
    if [ "$led" = 1 ] && [ "${cur%% *}" != succeeded ]; then v=FAIL; why="${why}; ledger row exists but operation is ${cur%% *}"; fi
    if [ "${cur%% *}" = needs_attention ]; then [ "$v" = PASS ] && v=PARTIAL; why="${why}; ends needs_attention"; fi
    case "${cur%% *}" in running|queued|verifying|needs_reconciliation) [ "$v" = PASS ] && v=PARTIAL; why="${why}; not at rest after 300 s (${cur%% *})" ;; esac
    verdict "C1.redeploy_${grace}" "$v" "${why}; at exit op=[${at_exit_op%% kind*}] ledger=${at_exit_led}; after restart op=[${cur%% kind*}] ledger=${led} objects=[${tabs}] execs=${execs}"
  done
}

for s in "${@:-hol redeploy}"; do
  for t in $s; do ( "$t" ) 2>&1 | tee "${OUT}/${t}.out"; done
done
