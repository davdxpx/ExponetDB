#!/usr/bin/env bash
# I4 atomicity on the running stack: bundles that try to end the transaction early, change the session, run
# psql meta text, or contain statements that cannot run in a transaction, planned and applied through the CLI
# against a FRESH target per case (PostgreSQL TARGET_PG, default pg17).
#
# Expectation per case (brief, block B, I4): a clear refusal at lint or plan time, or a correct run; in every
# case the ledger row exists IFF the change is committed and nothing is left half applied with a lying ledger.
# Every transactional case that can end the transaction early ends in a trailing `SELECT 1/0` (an error): if the
# script could end the engine's transaction, the objects before that error survive without a ledger row.
#
#   I4-atomicity-stack.sh [case-name-regex]        (all cases by default)
# Prints  VERDICT I4.<case>: PASS|FAIL|PARTIAL - <what happened>. Raw output: $S1_LOGS/I4/<case>.log
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
TARGET_PG="${TARGET_PG:-pg17}"
FILTER="${1:-.}"
OUT="${S1_LOGS}/I4"; mkdir -p "$OUT"
N=0

# case NAME TX EXPECT   (up.sql on stdin)
#   TX      true|false (the bundle's execution.transactional)
#   EXPECT  the public tables that must exist if the change counts as applied; "-" none.
#           outcome classes: REFUSED (lint or plan said no, nothing touched), CLEAN_FAIL (apply failed, nothing left),
#           APPLIED_OK (ledger row and exactly EXPECT), PARTIAL_DOCUMENTED (non-transactional, event log + blocked target),
#           HALF_APPLIED (objects without ledger row, transactional), LYING_LEDGER (ledger row, objects differ)
case_() {
  local name="$1" tx="$2" expect="$3"
  [[ "$name" =~ $FILTER ]] || { cat >/dev/null; return 0; }
  N=$((N + 1))
  local log="${OUT}/${name}.log"; : >"$log"
  local sql; sql="$(cat)"
  local target db dir id flags=()
  target="$(fresh_target "4${name//_/}" "${TARGET_PG}")" || { verdict "I4.${name}" NOT_RUN "could not register a fresh target"; return; }
  db="$(target_db "$target")"
  dir="$(new_project "i4-${name}-${RUN_TAG}")"
  [ "$tx" = false ] && flags=(--nontransactional)
  id="$(printf '%s\n' "$sql" | mkb "$dir" "${name//_/-}" "${flags[@]}")"
  local lint plan_line plan_state="" op_line="-" opstate="-"
  lint="$(lint_summary "$dir")"
  mplan "$dir" "$target" >"${log}.plan" 2>&1; plan_line="$(cat "${log}.plan")"
  plan_state="${PLAN_STATE:-?}"
  echo "lint: $lint | $plan_line" >>"$log"
  local cls detail
  if [ "$plan_state" = denied ] || [ -z "${PLAN_ID:-}" ]; then
    # which rule denied it (plan show lists the rules)
    local why; why="$(exdb_json plan show "${PLAN_ID:-none}" 2>/dev/null | jq -r '[.data.policyRules[]? | select(.result=="fail") | .id] | join(",")')"
    cls=REFUSED; detail="plan denied by ${why:-?}"
  else
    mapply "$PLAN_ID" --wait >"${log}.apply" 2>&1; op_line="$(tail -1 "${log}.apply")"
    opstate="$( [ -n "${OP_ID:-}" ] && op_state "$OP_ID" || echo '-')"
    echo "apply: $op_line" >>"$log"
  fi
  local have led events
  have="$(tables_in "${TARGET_PG}" "$db")"; led="$(ledger_count "${TARGET_PG}" "$db" "$id")"
  events="$(event_summary "${TARGET_PG}" "$db" "$id")"
  echo "after: tables=[$have] ledger=$led events=[$events] op=[$opstate]" >>"$log"
  if [ -z "${cls:-}" ]; then
    case "$opstate" in
      succeeded*)
        if [ "$led" = 1 ] && [ "$have" = "$expect" ]; then cls=APPLIED_OK; detail="applied and verified, objects as the script says"
        elif [ "$led" = 1 ]; then cls=LYING_LEDGER; detail="ledger row exists but objects are [$have], script semantics say [$expect]"
        else cls=LYING_OPERATION; detail="operation succeeded without a ledger row"; fi ;;
      *)
        if [ "$led" = 0 ] && [ "$have" = "-" ]; then cls=CLEAN_FAIL; detail="apply ended '${opstate%% *}', nothing left"
        elif [ "$led" = 0 ] && [ "$tx" = true ]; then cls=HALF_APPLIED; detail="transactional bundle, no ledger row, but objects [$have] survive (op: ${opstate%% *})"
        elif [ "$led" = 0 ]; then cls=PARTIAL_DOCUMENTED; detail="non-transactional partial run: objects [$have], events [$events], op ${opstate%% *}"
        else cls=LYING_LEDGER; detail="operation ${opstate%% *} but a ledger row exists, objects [$have]"; fi ;;
    esac
  fi
  local v=FAIL
  case "$cls" in
    REFUSED|CLEAN_FAIL|APPLIED_OK) v=PASS ;;
    PARTIAL_DOCUMENTED) v=PARTIAL ;;
  esac
  # nothing may be left behind by a refusal
  if [ "$cls" = REFUSED ] && { [ "$led" != 0 ] || [ "$have" != "-" ]; }; then v=FAIL; detail="$detail but objects [$have] / ledger $led"; fi
  verdict "I4.${name}" "$v" "${cls}: ${detail}; lint(${lint}); ledger=${led}; tables=[${have}]"
}

SQLFAIL='SELECT 1/0;'
# ----- the transaction cannot be ended from inside up.sql -----
case_ commit_then_error        true  - <<SQL
CREATE TABLE c_a (i int);
COMMIT;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ commit_ok                true  c_a <<'SQL'
CREATE TABLE c_a (i int);
COMMIT;
SQL
case_ end_then_error           true  - <<SQL
CREATE TABLE c_a (i int);
END;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ commit_and_chain         true  - <<SQL
CREATE TABLE c_a (i int);
COMMIT AND CHAIN;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ rollback_then_error      true  - <<SQL
CREATE TABLE c_a (i int);
ROLLBACK;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ rollback_ok              true  c_b <<'SQL'
CREATE TABLE c_a (i int);
ROLLBACK;
CREATE TABLE c_b (i int);
SQL
case_ abort_then_error         true  - <<SQL
CREATE TABLE c_a (i int);
ABORT;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ nested_begin_commit      true  - <<SQL
BEGIN;
CREATE TABLE c_a (i int);
COMMIT;
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
case_ nested_begin_ok          true  c_a <<'SQL'
BEGIN;
CREATE TABLE c_a (i int);
SQL
case_ start_transaction_error  true  - <<SQL
START TRANSACTION;
CREATE TABLE c_a (i int);
$SQLFAIL
SQL
case_ prepare_transaction      true  - <<SQL
CREATE TABLE c_a (i int);
PREPARE TRANSACTION 'i4';
CREATE TABLE c_b (i int);
$SQLFAIL
SQL
# ----- savepoints stay inside the transaction -----
case_ savepoint_release_ok     true  c_a,c_b <<'SQL'
SAVEPOINT s;
CREATE TABLE c_a (i int);
RELEASE s;
CREATE TABLE c_b (i int);
SQL
case_ savepoint_rollback_to    true  c_b <<'SQL'
SAVEPOINT s;
CREATE TABLE c_a (i int);
ROLLBACK TO s;
CREATE TABLE c_b (i int);
SQL
case_ savepoint_then_error     true  - <<SQL
SAVEPOINT s;
CREATE TABLE c_a (i int);
RELEASE s;
$SQLFAIL
SQL
# ----- session and role changes -----
case_ set_session_auth         true  - <<SQL
SET SESSION AUTHORIZATION lab_owner;
CREATE TABLE c_a (i int);
$SQLFAIL
SQL
case_ reset_role_then_create   true  - <<SQL
RESET ROLE;
CREATE TABLE c_a (i int);
$SQLFAIL
SQL
case_ reset_role_ok            true  c_a <<'SQL'
RESET ROLE;
CREATE TABLE c_a (i int);
SQL
case_ set_role_ledger_owner    true  - <<SQL
SET ROLE exponetdb_ledger_owner;
CREATE TABLE c_a (i int);
$SQLFAIL
SQL
case_ reset_role_ledger_truncate true -  <<'SQL'
RESET ROLE;
TRUNCATE exponetdb.schema_migrations;
SQL
case_ drop_ledger_schema       true  - <<'SQL'
DROP SCHEMA exponetdb CASCADE;
SQL
case_ ledger_disable_trigger   true  - <<'SQL'
ALTER TABLE exponetdb.schema_migrations DISABLE TRIGGER ALL;
SQL
case_ set_search_path_error    true  - <<SQL
SET search_path = pg_catalog;
CREATE TABLE c_a (i int);
$SQLFAIL
SQL
case_ set_local_ok             true  c_a <<'SQL'
SET LOCAL search_path = public;
CREATE TABLE c_a (i int);
SQL
# ----- procedural code that commits -----
case_ do_block_commit          true  - <<'SQL'
DO $$ BEGIN CREATE TABLE c_a (i int); COMMIT; CREATE TABLE c_b (i int); END $$;
SELECT 1/0;
SQL
case_ procedure_commit         true  - <<'SQL'
CREATE PROCEDURE p_commit() LANGUAGE plpgsql AS $$ BEGIN CREATE TABLE c_a (i int); COMMIT; END $$;
CALL p_commit();
SELECT 1/0;
SQL
case_ do_block_execute_commit  true  - <<'SQL'
DO $$ BEGIN CREATE TABLE c_a (i int); EXECUTE 'COMMIT'; END $$;
SELECT 1/0;
SQL
# ----- psql meta text -----
case_ meta_connect             true  - <<'SQL'
CREATE TABLE c_a (i int);
\connect postgres
CREATE TABLE c_b (i int);
SQL
case_ meta_shell               true  - <<'SQL'
CREATE TABLE c_a (i int);
\! id
SQL
case_ meta_in_string_ok        true  c_a <<'SQL'
CREATE TABLE c_a (i int DEFAULT 1);
COMMENT ON TABLE c_a IS 'backslash \ and \connect postgres inside a string';
SQL
# ----- statements that cannot run in a transaction, in a TRANSACTIONAL bundle -----
case_ tx_create_index_concurrently true - <<'SQL'
CREATE TABLE c_a (i int);
CREATE INDEX CONCURRENTLY c_a_i ON c_a (i);
SQL
case_ tx_drop_index_concurrently true - <<'SQL'
CREATE TABLE c_a (i int);
CREATE INDEX c_a_i ON c_a (i);
DROP INDEX CONCURRENTLY c_a_i;
SQL
case_ tx_reindex_concurrently true - <<'SQL'
CREATE TABLE c_a (i int PRIMARY KEY);
REINDEX TABLE CONCURRENTLY c_a;
SQL
case_ tx_vacuum                true  - <<'SQL'
CREATE TABLE c_a (i int);
VACUUM c_a;
SQL
case_ tx_alter_system          true  - <<'SQL'
CREATE TABLE c_a (i int);
ALTER SYSTEM SET work_mem = '64MB';
SQL
case_ tx_create_database       true  - <<'SQL'
CREATE TABLE c_a (i int);
CREATE DATABASE i4_created;
SQL
case_ tx_drop_database         true  - <<'SQL'
CREATE TABLE c_a (i int);
DROP DATABASE IF EXISTS i4_never_there;
SQL
case_ tx_enum_add_value_use    true  - <<'SQL'
CREATE TYPE e AS ENUM ('a');
ALTER TYPE e ADD VALUE 'b';
CREATE TABLE c_a (x e DEFAULT 'b');
SQL
case_ tx_enum_add_value_alone  true  - <<'SQL'
CREATE TYPE e AS ENUM ('a');
ALTER TYPE e ADD VALUE 'b';
SQL
# ----- the same statements in a NON-transactional bundle: a correct run, alone in its plan -----
case_ nontx_create_index_concurrently false c_a <<'SQL'
CREATE TABLE c_a (i int);
CREATE INDEX CONCURRENTLY c_a_i ON c_a (i);
SQL
case_ nontx_vacuum             false c_a <<'SQL'
CREATE TABLE c_a (i int);
VACUUM c_a;
SQL
case_ nontx_alter_system       false - <<'SQL'
ALTER SYSTEM SET work_mem = '64MB';
SQL
case_ nontx_create_database    false - <<'SQL'
CREATE DATABASE i4_created_nontx;
SQL
case_ nontx_enum_add_value     false - <<'SQL'
CREATE TYPE e AS ENUM ('a');
ALTER TYPE e ADD VALUE 'b';
SQL
case_ nontx_commit_statement   false c_a,c_b <<'SQL'
CREATE TABLE c_a (i int);
COMMIT;
CREATE TABLE c_b (i int);
SQL
case_ nontx_midfail            false - <<'SQL'
CREATE TABLE c_a (i int);
CREATE INDEX CONCURRENTLY c_a_i ON c_a (i);
CREATE TABLE c_b (i int, i int);
SQL
case_ nontx_first_statement_fails false - <<'SQL'
CREATE TABLE c_b (i int, i int);
CREATE INDEX CONCURRENTLY c_b_i ON c_b (i);
SQL
case_ nontx_cic_invalid_index  false - <<'SQL'
CREATE TABLE c_a (i int);
INSERT INTO c_a VALUES (1), (1);
CREATE UNIQUE INDEX CONCURRENTLY c_a_u ON c_a (i);
SQL
echo "I4: ${N} cases ran; raw logs in ${OUT}"
