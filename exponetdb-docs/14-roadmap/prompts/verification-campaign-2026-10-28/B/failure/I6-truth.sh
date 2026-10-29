#!/usr/bin/env bash
# I6 "truth": applyOutcome is never reported as success before verificationOutcome, and an unknown state fails closed.
# Through the CLI and REST on the running stack. Cases (each on a fresh PostgreSQL 17 target unless noted):
#   order           samples (state, apply, verification) every ~40 ms from the Control Store AND through REST while a bundle whose
#                   verification takes ~4 s runs: no sample may be state=succeeded with verification != passed, and the
#                   REST view must not say succeeded/applied-and-verified before the verification ended
#   verify_false    verify.sql whose check returns false
#   verify_error    verify.sql whose check raises an error
#   verify_hang     verify.sql blocked on a lock beyond the verify timeout (the lock is held by an out-of-band session)
#   verify_insert / verify_nextval / verify_cte_insert / verify_advisory / verify_setconfig / verify_pgsleep
#                   verify.sql that writes or has side effects: refused at lint/plan, or run with no effect on the target
#   verify_missing  verify.sql deleted while the manifest names it; verify_none: manifest runtimeChecks none, no file
#
#   I6-truth.sh [case-regex]      raw logs: $S1_LOGS/I6/<case>.log
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
FILTER="${1:-.}"; OUT="${S1_LOGS}/I6"; mkdir -p "$OUT"; PG=pg17

# apply a one-table bundle with the given verify.sql; echoes facts, sets I6_OP, I6_LEDGER, I6_STATE
run_verify_case() { # name verify_sql [pre-psql]
  local name="$1" vsql="$2" pre="${3:-}"
  local log="${OUT}/${name}.log"; : >"$log"
  local T db dir id
  T="$(fresh_target "6${name//_/}" "$PG")" || { verdict "I6.${name}" NOT_RUN "no fresh target"; return 1; }
  db="$(target_db "$T")"; dir="$(new_project "i6-${name}-${RUN_TAG}")"
  [ -n "$pre" ] && PGDATABASE="$db" psql_target "$PG" -q -c "$pre" >>"$log" 2>&1
  id="$(VERIFY_SQL="$vsql" mkb "$dir" "v-${name//_/-}" <<'SQL'
CREATE TABLE public.v1 (id int PRIMARY KEY);
GRANT SELECT ON public.v1 TO lab_owner;
SQL
)"
  I6_LINT="$(lint_summary "$dir")"; echo "lint: $I6_LINT" >>"$log"
  mplan "$dir" "$T" >>"$log" 2>&1
  I6_PLAN="${PLAN_STATE:-?}"
  I6_TARGET="$T"; I6_DB="$db"; I6_DIR="$dir"; I6_ID="$id"; I6_OP=""; I6_STATE="-"
  if [ "$I6_PLAN" = active ]; then
    mapply "$PLAN_ID" --wait >>"$log" 2>&1; I6_OP="$OP_ID"
    I6_STATE="$( [ -n "$I6_OP" ] && op_state "$I6_OP" || echo -)"
  fi
  I6_LEDGER="$(ledger_count "$PG" "$db" "$id")"
  echo "plan=$I6_PLAN op=[$I6_STATE] ledger=$I6_LEDGER" >>"$log"
  return 0
}

c_order() {
  [[ order =~ $FILTER ]] || return 0
  local log="${OUT}/order.log"; : >"$log"
  local T db dir id
  T="$(fresh_target 6order "$PG")"; db="$(target_db "$T")"; dir="$(new_project "i6-order-${RUN_TAG}")"
  # a check that takes a few seconds: a self join on a table of 3 million rows
  PGDATABASE="$db" psql_target "$PG" -q -c "CREATE TABLE public.big AS SELECT g AS id FROM generate_series(1, 3000000) g; GRANT SELECT ON public.big TO exponetdb_verifier, exponetdb_reader, exponetdb_observer, lab_owner; ANALYZE public.big" >>"$log" 2>&1
  id="$(VERIFY_SQL='-- check: a slow count over the big table
SELECT count(*) > 0 AS ok FROM public.big a JOIN public.big b ON a.id = b.id + 1;' mkb "$dir" slow-verify <<'SQL'
CREATE TABLE public.v1 (id int PRIMARY KEY);
GRANT SELECT ON public.v1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T" >>"$log" 2>&1
  # Control Store sampler and REST sampler, both started before the apply
  local samples="${OUT}/order.samples" rest="${OUT}/order.rest"; : >"$samples"; : >"$rest"
  mapply "$PLAN_ID" --no-wait >>"$log" 2>&1; local op="$OP_ID"
  local end=$(( $(date +%s) + 90 )) cur last="" rlast="" r
  while [ "$(date +%s)" -lt "$end" ]; do
    cur="$(ctl_sql "SELECT state||'|'||apply_outcome||'|'||verification_outcome FROM operations.operations WHERE operation_id='${op}'")"
    [ "$cur" != "$last" ] && { printf '%s %s\n' "$(date -u +%T.%3N)" "$cur" >>"$samples"; last="$cur"; }
    r="$(human call GET "/api/v1/operations/${op}" 2>/dev/null | jq -r '.body | .state+"|"+.applyOutcome+"|"+.verificationOutcome' 2>/dev/null)"
    [ -n "$r" ] && [ "$r" != "$rlast" ] && { printf '%s %s\n' "$(date -u +%T.%3N)" "$r" >>"$rest"; rlast="$r"; }
    case "$cur" in succeeded*|failed*|verification_failed*|needs_attention*|canceled*) break ;; esac
    sleep 0.04
  done
  echo "Control Store transitions:"; cat "$samples"; echo "REST transitions:"; cat "$rest"
  { echo "Control Store transitions:"; cat "$samples"; echo "REST transitions:"; cat "$rest"; } >>"$log"
  local bad
  bad="$(awk '{split($2,a,"|"); if (a[1]=="succeeded" && a[3]!="passed") print}' "$samples" "$rest")"
  local early; early="$(awk '{split($2,a,"|"); if (a[2]=="applied" && a[3]=="pending" && a[1]!="verifying" && a[1]!="running") print}' "$samples" "$rest")"
  if [ -n "$bad" ]; then verdict I6.order FAIL "a sample reports succeeded before the verification passed: $bad"
  elif [ -n "$early" ]; then verdict I6.order PARTIAL "applied/pending shown outside running/verifying: $early"
  elif [ "$(wc -l <"$samples")" -lt 4 ]; then verdict I6.order PARTIAL "only $(wc -l <"$samples") distinct states were seen; the verification window was too short to prove ordering"
  else verdict I6.order PASS "$(awk '{print $2}' "$samples" | tr '\n' '>' | sed 's/>$//') (Control Store); REST saw $(wc -l <"$rest") states, none succeeded before verification passed"; fi
}

c_simple() { # name verify_sql expectation-fn-text [pre]
  local name="$1"; [[ "$name" =~ $FILTER ]] || return 0
  run_verify_case "$name" "$2" "${4:-}" || return
  local st="${I6_STATE%% *}" v=FAIL why
  case "$3" in
    refuse) # lint or plan must refuse; nothing on the target
      if [ "$I6_PLAN" != active ] && [ "$I6_LEDGER" = 0 ]; then v=PASS; why="refused before apply (plan ${I6_PLAN}); lint(${I6_LINT})"
      else v=FAIL; why="not refused: plan=${I6_PLAN} op=[${I6_STATE}] ledger=${I6_LEDGER}; lint(${I6_LINT})"; fi ;;
    not_success) # apply may happen, but the operation must not end succeeded/passed
      if [ "$st" = succeeded ]; then v=FAIL; why="the operation reports succeeded although the check cannot pass: [${I6_STATE}]"
      elif [ "$I6_PLAN" != active ]; then v=PASS; why="refused at plan (${I6_PLAN}); lint(${I6_LINT})"
      else v=PASS; why="operation [${I6_STATE}], ledger=${I6_LEDGER}"; fi ;;
  esac
  verdict "I6.${name}" "$v" "$why"
}

c_order
c_simple verify_false      '-- check: always false
SELECT false AS ok;' not_success
c_simple verify_error      '-- check: raises
SELECT 1/0 = 0 AS ok;' not_success
c_simple verify_insert     '-- check: writes
INSERT INTO public.v1 VALUES (1);' refuse
c_simple verify_cte_insert '-- check: a data-modifying CTE
WITH w AS (INSERT INTO public.v1 VALUES (1) RETURNING 1) SELECT count(*) > 0 AS ok FROM w;' refuse
c_simple verify_nextval    '-- check: a sequence side effect
SELECT nextval(public.vseq) > 0 AS ok;' refuse "CREATE SEQUENCE public.vseq"
c_simple verify_advisory   '-- check: an advisory lock
SELECT pg_advisory_lock(42) IS NOT NULL AS ok;' refuse
c_simple verify_setconfig  '-- check: a session setting
SELECT set_config($$statement_timeout$$, $$0$$, false) = $$0$$ AS ok;' refuse
c_simple verify_pgsleep    '-- check: sleeps
SELECT pg_sleep(1) IS NOT NULL AS ok;' not_success

c_hang() {
  [[ verify_hang =~ $FILTER ]] || return 0
  local log="${OUT}/verify_hang.log"; : >"$log"
  local T db dir id
  T="$(fresh_target 6hang "$PG")"; db="$(target_db "$T")"; dir="$(new_project "i6-hang-${RUN_TAG}")"
  PGDATABASE="$db" psql_target "$PG" -q -c "CREATE TABLE public.locked (id int); GRANT SELECT ON public.locked TO exponetdb_verifier, exponetdb_reader, exponetdb_observer, lab_owner" >>"$log" 2>&1
  id="$(VERIFY_SQL='-- check: reads a table another session holds exclusively
SELECT count(*) >= 0 AS ok FROM public.locked;' mkb "$dir" hang <<'SQL'
CREATE TABLE public.v1 (id int PRIMARY KEY);
GRANT SELECT ON public.v1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T" >>"$log" 2>&1
  # an out-of-band session holds ACCESS EXCLUSIVE on the table the check reads, for 10 minutes
  PGDATABASE="$db" psql_target "$PG" -q -c "BEGIN; LOCK TABLE public.locked IN ACCESS EXCLUSIVE MODE; SELECT pg_sleep(600); COMMIT" >/dev/null 2>&1 &
  local holder=$!
  sleep 1
  local t0; t0=$(date +%s)
  mapply "$PLAN_ID" --no-wait >>"$log" 2>&1; local op="$OP_ID"
  local last="" cur
  while [ $(( $(date +%s) - t0 )) -lt 240 ]; do
    cur="$(op_state "$op")"; [ "$cur" != "$last" ] && { echo "  [+$(( $(date +%s) - t0 ))s] $cur" | tee -a "$log"; last="$cur"; }
    case "${cur%% *}" in succeeded|failed|verification_failed|needs_attention|canceled) break ;; esac
    sleep 1
  done
  PGDATABASE="$db" psql_target "$PG" -Atc "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE query LIKE '%pg_sleep(600)%' AND pid <> pg_backend_pid()" >/dev/null 2>&1; kill "$holder" 2>/dev/null
  local led; led="$(ledger_count "$PG" "$db" "$id")"
  local took=$(( $(date +%s) - t0 ))
  case "${last%% *}" in
    succeeded) verdict I6.verify_hang FAIL "the operation succeeded although the check was blocked ($last) after ${took}s" ;;
    needs_attention|verification_failed) verdict I6.verify_hang PASS "blocked check ends '${last%% *}' after ${took}s (${last}); ledger=${led}; E10 documents needs_attention + retry-verification" ;;
    *) verdict I6.verify_hang PARTIAL "state '${last}' after ${took}s (no end within 240 s); ledger=${led}" ;;
  esac
  if [ "${last%% *}" = needs_attention ]; then
    local r; r="$(exdb_json operation retry-verification "$op")"; echo "retry-verification after the lock was released: $(jq -c '{s:.status,c:.error.code}' <<<"$r")" | tee -a "$log"
    sleep 5; echo "after retry: $(op_state "$op")" | tee -a "$log"
  fi
}
c_hang

c_missing() {
  [[ verify_missing =~ $FILTER ]] || return 0
  run_verify_case verify_missing '-- check: placeholder
SELECT true AS ok;' || return
  # (re-plan after deleting the file: run_verify_case already applied the placeholder; use a second bundle)
  local log="${OUT}/verify_missing.log" T="$I6_TARGET" dir="$I6_DIR"
  local id2; id2="$(mkb "$dir" no-verify-file <<'SQL'
CREATE TABLE public.v2 (id int PRIMARY KEY);
GRANT SELECT ON public.v2 TO lab_owner;
SQL
)"
  rm -f "$dir"/migrations/${id2}_*/verify.sql
  local ls2; ls2="$(lint_summary "$dir")"; mplan "$dir" "$T" >>"$log" 2>&1
  local p="${PLAN_STATE:-?}"
  if [ "$p" = active ]; then mapply "$PLAN_ID" --wait >>"$log" 2>&1; fi
  local st; st="$( [ "$p" = active ] && op_state "$OP_ID" || echo -)"
  if [ "$p" != active ]; then verdict I6.verify_missing PASS "refused: plan ${p}; ${ls2}"
  else verdict I6.verify_missing FAIL "a bundle whose manifest names a missing verify.sql was planned and applied: [${st}]; ${ls2}"; fi
  # runtimeChecks: none and no file (a documented option): what does the operation claim?
  local id3; id3="$(mkb "$dir" no-checks <<'SQL'
CREATE TABLE public.v3 (id int PRIMARY KEY);
GRANT SELECT ON public.v3 TO lab_owner;
SQL
)"
  local bd3; bd3="$(ls -d "$dir"/migrations/${id3}_*)"
  rm -f "$bd3/verify.sql"; sed -i 's/runtimeChecks: verify.sql/runtimeChecks: none/' "$bd3/migration.yaml"
  rm -rf "$dir"/migrations/${id2}_*    # keep the stream applicable: id2 was never applied
  sed -i "s/^dependsOn: .*/dependsOn: []/" "$bd3/migration.yaml"
  mplan "$dir" "$T" >>"$log" 2>&1
  local p3="${PLAN_STATE:-?}"
  if [ "$p3" = active ]; then
    mapply "$PLAN_ID" --wait >>"$log" 2>&1
    local st3; st3="$(op_state "$OP_ID")"
    local checks; checks="$(exdb_json operation show "$OP_ID" | jq -c '[.data.verifications[]? | {outcome, checks}]' | cut -c1-200)"
    verdict I6.verify_none PARTIAL "runtimeChecks none: operation [${st3}], verifications ${checks}; the claim 'verified' with zero runtime checks is by design (expectations auto)"
  else
    verdict I6.verify_none PASS "refused: ${p3}"
  fi
}
c_missing
