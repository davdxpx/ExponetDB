#!/usr/bin/env bash
# Failure injection around apply (brief, block B): one CELL = (bundle kind, phase, injection) on a fresh PostgreSQL 16 target.
#
#   F-matrix.sh cell <bundle> <phase> <injection>      one cell
#   F-matrix.sh list                                    the planned cells (see CELLS below)
#   F-matrix.sh run [name-regex]                        all planned cells whose "bundle:phase:injection" matches
#
#   bundle     tx | nontx        (the same four statements; nontx runs them in autocommit, alone in its plan)
#   phase      before_plan | between | lock | mid | incommit | commit | verify
#   injection  kill9_worker kill9_serve kill9_gateway kill9_agent sigterm_worker sigterm_serve control_restart
#              pg_immediate pg_fast terminate_backend net_drop net_delay clock_fwd3h clock_back3h retry_same_key retry_new_key
#
# The bundle: `SELECT nextval('public.exec_seq')` (a counter that survives rollback: it counts how often the first
# statement STARTED; superseded by the server log, see below) a second start is an automatic re-execution), CREATE TABLE f_a, `SELECT pg_sleep(8)` (the
# mid-statement window), CREATE TABLE f_b. Phase triggers read the Control Store (operation state) and the target
# (pg_stat_activity, ledger) every ~50 ms. "incommit": synchronous_standby_names names a standby that does not exist, so the
# COMMIT is flushed and visible but never returns to the client (the connection is lost "between COMMIT and the reply").
# "commit": the mirror table of the Control Store is locked by an
# out-of-band session, which holds the worker between the target's commit and the mirror write; "verify": the target
# database carries 1500 tables so the verification takes seconds.
#
# Per cell it records (RESULTS.tsv, rendered into RESULTS.md by render-results.sh):
#   state shown by the Control Store, state shown by the CLI/REST, ledger rows, objects, exec count (nextval calls),
#   a second plan on the same target (liveness), the product's pointer (nextAction, retryable), judgement.
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
PG=pg16; PGPORT=$(_stk_port "$PG"); PGMAJOR=16
OUT="${S1_LOGS}/F"; mkdir -p "$OUT"; RESULTS="${OUT}/RESULTS.tsv"
mono() { cut -d' ' -f1 /proc/uptime | cut -d. -f1; }   # monotonic seconds: the wall clock is stepped by some cells
SLEEP_S=8; SETTLE="${SETTLE:-10}"; FOLLOW_MAX="${FOLLOW_MAX:-300}"

# ----- injections -------------------------------------------------------------------------------------
inj_kill9_worker()      { kill_role worker KILL; }
inj_kill9_serve()       { kill_role serve KILL; }
inj_kill9_gateway()     { kill_role gateway KILL; }
inj_kill9_agent()       { kill_role agent KILL; }
inj_sigterm_worker()    { kill_role worker TERM; }
inj_sigterm_serve()     { kill_role serve TERM; }
inj_control_restart()   { docker restart -t 2 "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1 & }
inj_pg_immediate()      { pg_restart "$PG" immediate; }
inj_terminate_backend() { psql_target "$PG" -Atc "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename='exponetdb_migrator' AND pid <> pg_backend_pid()" >/dev/null; }
inj_net_drop()          { net_block "$PGPORT" drop; ( sleep 45; net_unblock ) >/dev/null 2>&1 & }
inj_net_delay()         { net_delay 400 20; ( sleep 45; net_clear ) >/dev/null 2>&1 & }
inj_clock_fwd3h()       { clock_jump 10800; }
inj_clock_back3h()      { clock_jump -10800; }
inj_pg_fast()           { pg_restart "$PG" fast; }
inj_retry_same_key()    { :; }   # handled by the client leg (see cell_client)
inj_retry_new_key()     { :; }

# put the services, the Control Store and the target cluster back (the injections of the network and the clock are kept)
recover_services() {
  local c r
  docker start "${EXSTACK_CONTROL_NAME}" >/dev/null 2>&1; _stk_wait_control >/dev/null 2>&1
  pg_lsclusters -h | awk -v v="$PGMAJOR" -v c="${EXSTACK_CLUSTER_NAME}" '$1==v && $2==c && $4!="online" {print "down"}' | grep -q down && systemctl start "postgresql@${PGMAJOR}-${EXSTACK_CLUSTER_NAME}.service"
  syncrep_off "$PG"
  for r in gateway worker serve agent; do systemctl is-active --quiet "$(_stk_unit "$r")" || systemctl start "$(_stk_unit "$r")"; done
  local i; for i in $(seq 1 60); do stack_ready && break; sleep 1; done
}
# everything back to normal: the clock, the loopback rules, then the services
recover_all() {
  clock_restore >/dev/null 2>&1
  net_unblock >/dev/null 2>&1; net_clear >/dev/null 2>&1
  recover_services
}

# ----- one cell ---------------------------------------------------------------------------------------
cell() {
  local bundle="$1" phase="$2" inj="$3" id="${1}:${2}:${3}"
  local log="${OUT}/${bundle}_${phase}_${inj}.log"; : >"$log"
  exec 3>&1; exec >>"$log" 2>&1
  recover_all
  local slug="f${RUN_TAG}${bundle:0:2}${phase:0:3}${inj//_/}"; slug="${slug:0:24}"
  local T db dir idm op="" planid=""
  T="$(fresh_target "$slug" "$PG")" || { echo "NOT_RUN no target" >&3; return; }
  db="$(target_db "$T")"; dir="$(new_project "f-${slug}")"
  PGDATABASE="$db" psql_target "$PG" -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
  # executions are counted from the server log (a sequence skips 32 values after a crash): every statement of this database is logged
  psql_target "$PG" -q -c "ALTER DATABASE ${db} SET log_statement = 'all'"
  PGLOG="/var/log/postgresql/postgresql-${PGMAJOR}-${EXSTACK_CLUSTER_NAME}.log"; LOG0=$(wc -l <"$PGLOG")
  if [ "$bundle" = nontx ]; then
    # The policy refuses procedural SQL (nextval, pg_sleep) in a non-transactional bundle, so: DDL only. The mid-statement
    # window is a CREATE INDEX CONCURRENTLY that waits for an out-of-band transaction older than it; executions are counted
    # from the target's event log (nontx_started).
    idm="$(VERIFY_SQL='-- check: both tables exist
SELECT count(*) >= 0 AS ok FROM public.f_b;' mkb "$dir" "cell-${bundle}" --nontransactional <<'SQL'
CREATE TABLE public.f_a (id int PRIMARY KEY);
CREATE INDEX CONCURRENTLY f_a_idx ON public.f_a (id);
CREATE TABLE public.f_b (id int PRIMARY KEY);
GRANT SELECT ON public.f_a, public.f_b TO lab_owner;
SQL
)"
  else
  idm="$(VERIFY_SQL='-- check: both tables exist
SELECT count(*) >= 0 AS ok FROM public.f_b;' mkb "$dir" "cell-${bundle}" <<SQL
SELECT nextval('public.exec_seq');
CREATE TABLE public.f_a (id int PRIMARY KEY);
SELECT pg_sleep(${SLEEP_S});
CREATE TABLE public.f_b (id int PRIMARY KEY);
GRANT SELECT ON public.f_a, public.f_b TO lab_owner;
SQL
)"
  fi
  [ "$phase" = verify ] && bloat "$PG" "$db" 1500
  [ "$phase" = incommit ] && syncrep_on "$PG"
  [ "$phase" = commit ] && { # hold the mirror write
    docker exec -i -e PGPASSWORD="$(cat "${EXSTACK_STATE}/control.superuser")" "${EXSTACK_CONTROL_NAME}" psql -X -q -h 127.0.0.1 -U "$(_stk_super)" -d exponetdb_control -c "BEGIN; LOCK TABLE migrations.ledger_mirror IN EXCLUSIVE MODE; SELECT pg_sleep(900); COMMIT" >/dev/null 2>&1 &
    HOLD=$!; sleep 1; }
  local HOLDER_PID=""
  if [ "$bundle" = nontx ] && [ "$phase" != verify ]; then   # an older transaction: the CIC waits for it (up to 90 s)
    PGDATABASE="$db" psql_target "$PG" -q -c "BEGIN; SELECT txid_current(); SELECT pg_sleep(90); COMMIT" >/dev/null 2>&1 &
    HOLDER_PID=$!; sleep 1
  fi
  local t0; t0=$(mono)
  echo "== cell ${id} target ${T} bundle ${idm}"
  local injected="no"
  fire() { "inj_${inj}"; injected="$(date -u +%T.%3N)"; echo "injected ${inj} at ${injected}"; }
  local lintrc
  case "$phase" in
    before_plan) fire; sleep 3; mplan "$dir" "$T"; ;;
    *) mplan "$dir" "$T" ;;
  esac
  if [ -z "${PLAN_ID:-}" ] || [ "${PLAN_STATE:-}" != active ]; then
    # the plan itself failed (serve down?) : recover and plan again, as a person would
    echo "plan failed under injection (${PLAN_STATE:-none}); recovering and planning again"
    sleep "$SETTLE"; recover_all; mplan "$dir" "$T"
  fi
  planid="$PLAN_ID"
  [ "$phase" = between ] && { fire; sleep 3; }
  if [ "$inj" = retry_same_key ] || [ "$inj" = retry_new_key ]; then cell_client "$inj" "$planid" "$log"; op="$OP_ID"; else
    mapply "$planid" --no-wait; op="$OP_ID"
    if [ -z "$op" ]; then   # the apply request failed (serve down)
      echo "apply request failed under injection; recovering and applying again"
      sleep "$SETTLE"; recover_all; mapply "$planid" --no-wait; op="$OP_ID"
    fi
    case "$phase" in
      lock)   inject_on_state "$op" running "fire" 60 ;;
      mid)    local k=0 q="%pg_sleep(${SLEEP_S})%"; [ "$bundle" = nontx ] && q="CREATE INDEX CONCURRENTLY%"; while [ $k -lt 400 ]; do
                [ "$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '${q}' AND state = 'active' AND pid <> pg_backend_pid()" 2>/dev/null)" = 1 ] && { fire; break; }
                sleep 0.05; k=$((k+1)); done ;;
      incommit) local k=0; while [ $k -lt 1200 ]; do
                [ "$(syncrep_waiting "$PG" "$db")" -ge 1 ] && { fire; break; }
                sleep 0.05; k=$((k+1)); done ;;
      commit) local k=0; while [ $k -lt 1200 ]; do
                [ "$(ledger_count "$PG" "$db" "$idm")" = 1 ] && { fire; break; }
                sleep 0.05; k=$((k+1)); done ;;
      verify) inject_on_state "$op" verifying "fire" 120 ;;
    esac
  fi
  [ "$phase" = commit ] && { sleep 5; kill "$HOLD" 2>/dev/null; docker exec "${EXSTACK_CONTROL_NAME}" true >/dev/null 2>&1; ctl_sql "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE query LIKE '%ledger_mirror IN EXCLUSIVE%' AND pid <> pg_backend_pid()" >/dev/null 2>&1; }
  sleep "$SETTLE"; recover_services
  # (the older out-of-band transaction of a non-transactional cell ends here, so the index build can finish or fail)
  [ -n "$HOLDER_PID" ] && { PGDATABASE="$db" psql_target "$PG" -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(90)%' AND pid <> pg_backend_pid()" >/dev/null 2>&1; kill "$HOLDER_PID" 2>/dev/null; }
  # follow the operation to rest
  local last="" cur st=""
  if [ -n "$op" ]; then
    while [ $(( $(mono) - t0 )) -lt "$FOLLOW_MAX" ]; do
      cur="$(op_state "$op" 2>/dev/null)"; [ "$cur" != "$last" ] && { echo "  [+$(( $(mono) - t0 ))s] $cur"; last="$cur"; }
      case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac
      # a clock step is undone when the operation rests or 90 s after the injection, whichever comes first
      case "$inj" in clock_*) [ $(( $(mono) - t0 )) -gt 90 ] && clock_restore >/dev/null 2>&1 ;; esac
      sleep 2
    done
    recover_all
  fi
  local took=$(( $(mono) - t0 ))
  record_cell "$id" "$bundle" "$phase" "$inj" "$T" "$db" "$idm" "$op" "$took" "$dir" >&3
  exec 1>&3 3>&-
}

# a client that times out and retries: leg one is aborted client-side after 300 ms (the request may still be processed),
# leg two repeats it with the SAME or a NEW Idempotency-Key; the question is whether two operations result.
# The plan is bound to the CLI's client, so the REST calls carry the CLI's own access token (never printed).
cell_client() { # inj planid log
  local inj="$1" plan="$2" mode=same k1 k2 tok first second
  [ "$inj" = retry_new_key ] && mode=new
  k1="idem-$(cat /proc/sys/kernel/random/uuid)"; k2="$k1"; [ "$mode" = new ] && k2="idem-$(cat /proc/sys/kernel/random/uuid)"
  exdb whoami >/dev/null 2>&1   # refreshes the token if needed
  tok="$(jq -r '.credentials | to_entries[0].value.accessToken' "${EXSTACK_STATE}/cli/credentials.json")"
  curl -s -m 0.3 -o /dev/null -X POST -H "authorization: Bearer ${tok}" -H "idempotency-key: ${k1}" -H 'content-type: application/json' -d '{}' "${EXSTACK_PUBLIC_URL}/api/v1/plans/${plan}/apply"
  first="aborted"
  second="$(curl -s -X POST -H "authorization: Bearer ${tok}" -H "idempotency-key: ${k2}" -H 'content-type: application/json' -d '{}' "${EXSTACK_PUBLIC_URL}/api/v1/plans/${plan}/apply" | jq -c '{op: .id, state: .state, code: .code, already: .alreadyAccepted}')"
  tok=""
  echo "retry-apply (${mode} key): first=${first} second=${second}"
  OP_ID="$(jq -r '.op // empty' <<<"$second")"
  echo "operations for the plan: $(ctl_sql "SELECT count(*) FROM operations.operations WHERE plan_id='${plan}'" 2>&1)"
}

record_cell() { # id bundle phase inj target db migid op took dir
  local id="$1" bundle="$2" phase="$3" inj="$4" T="$5" db="$6" mid="$7" op="$8" took="$9" dir="${10}"
  local store="-" rest="-" next="-" ptr="-" led tabs seq execs ops
  local w; for w in $(seq 1 40); do stack_ready && break; sleep 1; done   # the REST view needs serve (a killed serve is restarted by recover_all)
  [ -n "$op" ] && store="$(op_state "$op" 2>/dev/null | sed 's/ kind=.*//')"
  [ -n "$op" ] && { local j; j="$(exdb_json operation show "$op" 2>/dev/null)"; rest="$(jq -r '.data.state + " apply=" + .data.applyOutcome + " verify=" + .data.verificationOutcome' <<<"$j" 2>/dev/null)"; ptr="$(jq -r '"retryable=" + (.data.retryable|tostring) + " next=" + (.data.nextAction|tostring) + " err=" + (.data.errorCode|tostring)' <<<"$j" 2>/dev/null)"; }
  led="$(ledger_count "$PG" "$db" "$mid")"; tabs="$(tables_in "$PG" "$db" | tr ',' '\n' | grep -v '^bulk_' | paste -sd+ -)"; [ -z "$tabs" ] && tabs="-"
  if [ "$bundle" = nontx ]; then execs="$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM exponetdb.migration_events WHERE migration_id='${mid}' AND event='nontx_started'" 2>/dev/null)"
  else execs="$(tail -n +"$((LOG0 + 1))" "$PGLOG" | grep -F "exponetdb_migrator@${db} " | grep -c "LOG:  execute .*: SELECT pg_sleep(${SLEEP_S})")"; fi
  ops="$(ctl_sql "SELECT count(*) FROM operations.operations o WHERE o.kind LIKE 'migration.%' AND o.subject->>'targetId' = '$(target_id "$T")'" 2>/dev/null)"
  # liveness: an independent change on the same target must complete
  local d2; d2="$(new_project "f-next-${RANDOM}")"
  mkb "$d2" next >/dev/null <<'SQL'
CREATE TABLE public.f_next (id int PRIMARY KEY);
GRANT SELECT ON public.f_next TO lab_owner;
SQL
  if mplan "$d2" "$T" >/dev/null 2>&1 && [ "$PLAN_STATE" = active ]; then
    mapply "$PLAN_ID" --no-wait >/dev/null 2>&1; local nop="$OP_ID" w=0
    while [ $w -lt 60 ]; do case "$(op_state "$nop" 2>/dev/null | cut -d' ' -f1)" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac; sleep 2; w=$((w+2)); done
    next="$(op_state "$nop" 2>/dev/null | cut -d' ' -f1)"
    [ "$next" = queued ] && next="queued(blocked)"
    [ -n "$nop" ] && exdb_json operation cancel "$nop" >/dev/null 2>&1
  else next="plan_refused(${PLAN_STATE:-?})"; fi
  # judgement
  local ok=PASS why=()
  local both=0; [[ "$tabs" == *f_a* && "$tabs" == *f_b* ]] && both=1
  local none=1; [[ "$tabs" == *f_a* || "$tabs" == *f_b* ]] && none=0
  local sst="${store%% *}"
  if [ "$led" = 1 ] && [ "$both" = 0 ]; then ok=FAIL; why+=("ledger row without both objects"); fi
  if [ "$led" = 0 ] && [ "$bundle" = tx ] && [ "$none" = 0 ]; then ok=FAIL; why+=("objects without ledger row (transactional)"); fi
  if [ "$sst" = succeeded ] && [ "$led" != 1 ]; then ok=FAIL; why+=("operation succeeded without a ledger row"); fi
  if { [ "$sst" = failed ] || [ "$sst" = canceled ]; } && [ "$led" = 1 ]; then ok=FAIL; why+=("operation ${sst} but the change is committed"); fi
  if [ "${execs:-0}" != "?" ] && [ "${execs:-0}" -gt 1 ] 2>/dev/null; then ok=FAIL; why+=("re-executed automatically: first statement started ${execs} times"); fi
  case "$sst" in queued|running|verifying|needs_reconciliation|"-") [ "$ok" = PASS ] && ok=PARTIAL; why+=("operation not at rest after ${took}s (${store})") ;; esac
  case "$next" in succeeded) ;; *) [ "$ok" = PASS ] && ok=PARTIAL; why+=("next plan on the target: ${next}") ;; esac
  [ "$sst" = needs_attention ] && { [ "$ok" = PASS ] && ok=PARTIAL; why+=("needs_attention (${ptr})"); }
  [ -n "$op" ] && [ "$store" != "$rest" ] && [ "${rest%% *}" != "${store%% *}" ] && { ok=FAIL; why+=("CLI/REST state '${rest%% *}' differs from the Control Store '${store%% *}'"); }
  local reason; reason="$(IFS='; '; echo "${why[*]:-consistent; no re-execution; next plan ${next}}")"
  printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$id" "$store" "$rest" "$led" "$tabs" "$execs" "$next" "$ptr" "$took" "$ok" "$reason" "$op" >>"$RESULTS"
  verdict "F.${id}" "$ok" "store=[${store}] rest=[${rest%% *}] ledger=${led} objects=[${tabs}] execs=${execs} next=${next} t=${took}s; ${reason}"
}

# ----- the planned cells (priority order; edit or pass a regex to `run`) ----------------------------------
CELLS=(
  tx:mid:kill9_worker tx:commit:kill9_worker tx:verify:kill9_worker nontx:mid:kill9_worker nontx:verify:kill9_worker
  tx:mid:pg_immediate nontx:mid:pg_immediate tx:verify:pg_immediate tx:incommit:pg_immediate tx:mid:pg_fast
  tx:mid:kill9_serve tx:between:kill9_serve tx:mid:kill9_agent tx:mid:kill9_gateway
  tx:incommit:kill9_worker tx:incommit:terminate_backend tx:mid:terminate_backend
  tx:mid:control_restart tx:commit:control_restart tx:incommit:control_restart
  tx:mid:net_drop tx:verify:net_drop tx:mid:net_delay
  tx:mid:sigterm_worker nontx:mid:sigterm_worker tx:between:sigterm_serve
  tx:mid:retry_same_key tx:mid:retry_new_key
  tx:mid:clock_fwd3h tx:between:clock_fwd3h tx:before_plan:clock_back3h tx:mid:clock_back3h nontx:mid:clock_fwd3h
  tx:before_plan:kill9_worker tx:between:kill9_worker tx:lock:kill9_worker
)

case "${1:-list}" in
  cell) shift; cell "$@" ;;
  list) printf '%s\n' "${CELLS[@]}" ;;
  run) shift; re="${1:-.}"; for c in "${CELLS[@]}"; do [[ "$c" =~ $re ]] || continue; [ "${FORCE:-0}" = 1 ] || ! grep -q "^${c}	" "$RESULTS" 2>/dev/null || continue; IFS=: read -r b p i <<<"$c"; cell "$b" "$p" "$i"; done ;;
esac
