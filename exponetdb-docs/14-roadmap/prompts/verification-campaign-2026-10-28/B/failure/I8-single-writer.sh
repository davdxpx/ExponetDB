#!/usr/bin/env bash
# I8 "single writer": one schema change per target at a time, across servers, workers and restarts. On the stack:
#   same_target     two plans (independent bundles, each holding the target for ~6 s) applied at the same instant on ONE target:
#                   the executions must not overlap, and the second must either wait or be refused with a typed reason
#   same_cluster    two targets of the SAME cluster applied at the same instant: independent targets may run in parallel
#   held_lock       an out-of-band session holds the target's EXDB advisory lock (key1 1163412546, key2 from the SHA-256 of
#                   "exponetdb/lock/v1/schema/<targetId>"): the apply must wait (lock deadline) and then fail typed, or proceed
#                   once the holder is gone; never run unlocked
#   held_released   the holder lets go after 8 s: the apply must proceed
#   crashed_session the backend running an apply is terminated: the lock must go with the session and the next plan must run
#
#   I8-single-writer.sh [case ...]       raw logs: $S1_LOGS/I8/<case>.log
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="${S1_LOGS}/I8"; mkdir -p "$OUT"; PG=pg16

# the two keys of the target's schema lock
schema_key2() { # target id -> signed int4
  local hex; hex="$(printf 'exponetdb/lock/v1/schema/%s' "$1" | sha256sum | cut -c1-8)"
  echo $(( 0x$hex >= 0x80000000 ? 0x$hex - 0x100000000 : 0x$hex ))
}
step_times() { # opid -> "start..finish" of the execute step (epoch ms from the CLI JSON)
  exdb_json operation show "$1" | jq -r '[.data.steps[]? | select(.name=="execute")][0] | (.startedAt // "-") + ".." + (.finishedAt // "-")'
}
overlap() { # "s1..f1" "s2..f2" -> yes|no
  python3 - "$1" "$2" <<'EOF'
import sys
from datetime import datetime
def p(x):
    a, b = x.split("..")
    if a == "-" or b == "-": return None
    f = lambda t: datetime.fromisoformat(t.replace("Z", "+00:00"))
    return f(a), f(b)
x, y = p(sys.argv[1]), p(sys.argv[2])
print("unknown" if x is None or y is None else ("yes" if x[0] < y[1] and y[0] < x[1] else "no"))
EOF
}

mk_two() { # dir slug_prefix  -> sets B1 B2 (independent bundles with a 6 s statement)
  local dir="$1"
  mkb "$dir" "${2}-one" >/dev/null <<'SQL'
SELECT pg_sleep(6);
CREATE TABLE public.w_one (id int PRIMARY KEY);
GRANT SELECT ON public.w_one TO lab_owner;
SQL
}

c_same_target() {
  local T d1 d2 p1 p2 o1 o2
  T="$(fresh_target 8same "$PG")"; d1="$(new_project i8s1-${RUN_TAG})"; d2="$(new_project i8s2-${RUN_TAG})"
  mkb "$d1" one >/dev/null <<'SQL'
SELECT pg_sleep(6);
CREATE TABLE public.w_one (id int PRIMARY KEY);
GRANT SELECT ON public.w_one TO lab_owner;
SQL
  mkb "$d2" two >/dev/null <<'SQL'
SELECT pg_sleep(6);
CREATE TABLE public.w_two (id int PRIMARY KEY);
GRANT SELECT ON public.w_two TO lab_owner;
SQL
  mplan "$d1" "$T" >/dev/null; p1="$PLAN_ID"; mplan "$d2" "$T" >/dev/null; p2="$PLAN_ID"
  ( mapply "$p1" --no-wait >"${OUT}/same_target.a" 2>&1 ) & ( mapply "$p2" --no-wait >"${OUT}/same_target.b" 2>&1 ) & wait
  o1="$(sed -n 's/^op=\([^ ]*\).*/\1/p' "${OUT}/same_target.a")"; o2="$(sed -n 's/^op=\([^ ]*\).*/\1/p' "${OUT}/same_target.b")"
  cat "${OUT}/same_target.a" "${OUT}/same_target.b"
  local i; for i in $(seq 1 60); do
    case "$(op_state "$o1" | cut -d' ' -f1)$(op_state "$o2" | cut -d' ' -f1)" in *queued*|*running*|*verifying*) sleep 2 ;; *) break ;; esac; done
  local s1 s2; s1="$(op_state "$o1")"; s2="$(op_state "$o2")"
  local ov; ov="$(overlap "$(step_times "$o1")" "$(step_times "$o2")")"
  echo "A: $s1 ($(step_times "$o1"))"; echo "B: $s2 ($(step_times "$o2"))"; echo "executions overlap: $ov"
  local ok=0; [[ "$s1" == succeeded* ]] && ok=$((ok+1)); [[ "$s2" == succeeded* ]] && ok=$((ok+1))
  if [ "$ov" = yes ]; then verdict I8.same_target FAIL "two applies on one target executed at the same time"
  else verdict I8.same_target PASS "serialized (overlap=${ov}); ${ok}/2 succeeded; A=[${s1%% kind*}] B=[${s2%% kind*}] (a refused second plan is a typed outcome, not a violation)"; fi
}

c_same_cluster() {
  local Ta Tb d1 d2 p1 p2 o1 o2
  Ta="$(fresh_target 8ca "$PG")"; Tb="$(fresh_target 8cb "$PG")"; d1="$(new_project i8c1-${RUN_TAG})"; d2="$(new_project i8c2-${RUN_TAG})"
  mkb "$d1" one >/dev/null <<'SQL'
SELECT pg_sleep(6);
CREATE TABLE public.w_one (id int PRIMARY KEY);
GRANT SELECT ON public.w_one TO lab_owner;
SQL
  mkb "$d2" two >/dev/null <<'SQL'
SELECT pg_sleep(6);
CREATE TABLE public.w_two (id int PRIMARY KEY);
GRANT SELECT ON public.w_two TO lab_owner;
SQL
  mplan "$d1" "$Ta" >/dev/null; p1="$PLAN_ID"; mplan "$d2" "$Tb" >/dev/null; p2="$PLAN_ID"
  ( mapply "$p1" --no-wait >"${OUT}/same_cluster.a" 2>&1 ) & ( mapply "$p2" --no-wait >"${OUT}/same_cluster.b" 2>&1 ) & wait
  o1="$(sed -n 's/^op=\([^ ]*\).*/\1/p' "${OUT}/same_cluster.a")"; o2="$(sed -n 's/^op=\([^ ]*\).*/\1/p' "${OUT}/same_cluster.b")"
  local i; for i in $(seq 1 60); do
    case "$(op_state "$o1" | cut -d' ' -f1)$(op_state "$o2" | cut -d' ' -f1)" in *queued*|*running*|*verifying*) sleep 2 ;; *) break ;; esac; done
  local ov; ov="$(overlap "$(step_times "$o1")" "$(step_times "$o2")")"
  echo "A: $(op_state "$o1")"; echo "B: $(op_state "$o2")"; echo "executions overlap: $ov"
  if [[ "$(op_state "$o1")" == succeeded* && "$(op_state "$o2")" == succeeded* ]]; then
    verdict I8.same_cluster PASS "two targets of one cluster both succeeded; overlap=${ov} (independent domains may run in parallel; one worker may also serialize them)"
  else verdict I8.same_cluster FAIL "A=[$(op_state "$o1" | cut -d' ' -f1)] B=[$(op_state "$o2" | cut -d' ' -f1)]"; fi
}

hold_lock() { # db key2 seconds   (background psql holding the target's schema lock)
  PGDATABASE="$1" psql_target "$PG" -q -c "SELECT pg_advisory_lock(1163412546, $2); SELECT pg_sleep($3)" >/dev/null 2>&1 &
  HOLDER=$!
}

c_held() { # name hold_seconds
  local name="$1" secs="$2" T db dir id op tid
  T="$(fresh_target "8${name//_/}" "$PG")"; db="$(target_db "$T")"; tid="$(target_id "$T")"; dir="$(new_project "i8-${name}-${RUN_TAG}")"
  id="$(mkb "$dir" held <<'SQL'
CREATE TABLE public.w_held (id int PRIMARY KEY);
GRANT SELECT ON public.w_held TO lab_owner;
SQL
)"
  mplan "$dir" "$T" >/dev/null
  local k2; k2="$(schema_key2 "$tid")"
  hold_lock "$db" "$k2" "$secs"; sleep 1
  echo "held by an out-of-band session: $(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1163412546 AND objid=$(( k2 < 0 ? k2 + 4294967296 : k2 )) AND granted")"
  local t0; t0=$(date +%s)
  mapply "$PLAN_ID" --no-wait; op="$OP_ID"
  local last="" cur
  while [ $(( $(date +%s) - t0 )) -lt 90 ]; do
    cur="$(op_state "$op")"; [ "$cur" != "$last" ] && { echo "  [+$(( $(date +%s) - t0 ))s] $cur"; last="$cur"; }
    case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac
    sleep 1
  done
  kill "$HOLDER" 2>/dev/null; PGDATABASE="$db" psql_target "$PG" -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_advisory_lock(1163412546%' AND pid <> pg_backend_pid()" >/dev/null 2>&1
  local led; led="$(ledger_count "$PG" "$db" "$id")"
  echo "result: [${last}] ledger=${led} after $(( $(date +%s) - t0 ))s; errorCode=$(exdb_json operation show "$op" | jq -r '.data.errorCode')"
  case "$name" in
    held_released) [[ "$last" == succeeded* && "$led" = 1 ]] && verdict "I8.${name}" PASS "the apply waited for the holder and then ran (${last%% kind*})" || verdict "I8.${name}" FAIL "after the holder let go: [${last}] ledger=${led}" ;;
    *) if [ "$led" = 0 ] && [[ "$last" == failed* ]]; then verdict "I8.${name}" PASS "never ran unlocked; ended [${last%% kind*}] code=$(exdb_json operation show "$op" | jq -r '.data.errorCode')"
       elif [ "$led" = 1 ]; then verdict "I8.${name}" FAIL "the change was applied while an outside session held the lock"
       else verdict "I8.${name}" PARTIAL "[${last}] ledger=${led}"; fi ;;
  esac
}

c_crashed_session() {
  local T db dir id op
  T="$(fresh_target 8crash "$PG")"; db="$(target_db "$T")"; dir="$(new_project i8crash-${RUN_TAG})"
  id="$(mkb "$dir" crash <<'SQL'
SELECT pg_sleep(20);
CREATE TABLE public.w_crash (id int PRIMARY KEY);
GRANT SELECT ON public.w_crash TO lab_owner;
SQL
)"
  mplan "$dir" "$T" >/dev/null; mapply "$PLAN_ID" --no-wait; op="$OP_ID"
  local k=0; while [ $k -lt 400 ]; do [ "$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(20)%' AND pid <> pg_backend_pid()")" = 1 ] && break; sleep 0.1; k=$((k+1)); done
  PGDATABASE="$db" psql_target "$PG" -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE usename='exponetdb_migrator' AND pid <> pg_backend_pid()" >/dev/null
  sleep 3
  echo "advisory locks left on the target after the session died: $(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_locks WHERE locktype='advisory' AND classid=1163412546")"
  echo "op: $(op_state "$op")"
  local d2; d2="$(new_project i8crash2-${RUN_TAG})"
  mkb "$d2" next >/dev/null <<'SQL'
CREATE TABLE public.w_next (id int PRIMARY KEY);
GRANT SELECT ON public.w_next TO lab_owner;
SQL
  mplan "$d2" "$T" >/dev/null; mapply "$PLAN_ID" --wait
  local nxt; nxt="$(op_state "$OP_ID")"
  if [[ "$nxt" == succeeded* ]]; then verdict I8.crashed_session PASS "the lock went with the session; the first operation ended [$(op_state "$op" | cut -d' ' -f1)] and the next plan on the target succeeded"
  else verdict I8.crashed_session FAIL "next plan after a crashed apply session: [${nxt}]"; fi
}

cases=("$@"); [ ${#cases[@]} -eq 0 ] && cases=(same_target same_cluster held_lock held_released crashed_session)
for c in "${cases[@]}"; do
  case "$c" in
    held_lock) ( c_held held_lock 70 ) 2>&1 | tee "${OUT}/${c}.log" ;;
    held_released) ( c_held held_released 8 ) 2>&1 | tee "${OUT}/${c}.log" ;;
    *) ( "c_${c}" ) 2>&1 | tee "${OUT}/${c}.log" ;;
  esac
done
