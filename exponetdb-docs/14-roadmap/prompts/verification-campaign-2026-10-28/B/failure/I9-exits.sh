#!/usr/bin/env bash
# I9 "every state has an exit": reproduce, on the running stack and through the CLI/REST, the dead ends the static
# reviewers found (EV/F/findings-B1.md first P1, findings-E1.md first two P1s, findings-D0.md first P2) and record what a
# human is offered in each state.
#
#   I9-exits.sh [scenario ...]    scenarios: rollback unknown reconcile accept endpoint supersede approval
#
# Each scenario runs on its own fresh target (PostgreSQL 16, so the roles and the agent-managed PG17 cluster are not
# touched), parks an operation in needs_attention by cutting the worker's path to the target at the moment the
# operation is `verifying` (a deterministic stand-in for "the target was unreachable during verification"), then tries
# every exit the CLI and the REST API offer and then plans a new change on the same target.
# Output: VERDICT I9.<scenario>: PASS|FAIL|PARTIAL|NOT_RUN - ...   Raw output: $S1_LOGS/I9/<scenario>.log
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
OUT="${S1_LOGS}/I9"; mkdir -p "$OUT"
PG=pg16; PGPORT=$(_stk_port "$PG")
BLOAT="${BLOAT:-1500}"

cut_target() { net_block "$PGPORT" reject; psql_target "$PG" -Atc "SELECT count(pg_terminate_backend(pid)) FROM pg_stat_activity WHERE usename LIKE 'exponetdb_%' AND pid <> pg_backend_pid()" >/dev/null 2>&1; }

# follow an operation's state until it is one of the end/park states; prints the transitions
follow() { # opid seconds
  local op="$1" end=$(( $(date +%s) + $2 )) last="" cur
  while [ "$(date +%s)" -lt "$end" ]; do
    cur="$(op_state "$op" 2>/dev/null)"
    [ "$cur" != "$last" ] && { echo "  [$(date -u +%T)] $cur"; last="$cur"; }
    case "${cur%% *}" in needs_attention|failed|verification_failed|succeeded|canceled) echo "$cur"; return 0 ;; esac
    sleep 1
  done
  echo "$cur"; return 1
}

# everything a human can try on a parked operation, then a new plan on the same target.
# sets: P_RETRY_RC P_RETRY_CODE P_CANCEL_RC P_CANCEL_CODE P_LOCKS P_NEXT_STATE
park_probe() { # opid target projectdir
  local op="$1" target="$2" dir="$3" j
  echo "--- parked: $(op_state "$op")"
  P_LOCKS="$(ctl_sql "SELECT string_agg(domain_key, ',') FROM operations.operation_locks WHERE operation_id='${op}'")"
  echo "locks held by the operation: ${P_LOCKS:-none}"
  j="$(exdb_json operation show "$op")"
  echo "operation show: retryable=$(jq -r '.data.retryable' <<<"$j") nextAction=$(jq -c '.data.nextAction' <<<"$j") waitingFor=$(jq -c '.data.waitingFor' <<<"$j") errorCode=$(jq -r '.data.errorCode' <<<"$j")"
  j="$(exdb_json operation retry-verification "$op")"; P_RETRY_RC=$?; P_RETRY_CODE="$(jq -r '.error.code // "-"' <<<"$j")"
  echo "retry-verification: rc=$P_RETRY_RC code=$P_RETRY_CODE"
  j="$(exdb_json operation cancel "$op")"; P_CANCEL_RC=$?; P_CANCEL_CODE="$(jq -r '.error.code // "-"' <<<"$j")"
  echo "cancel: rc=$P_CANCEL_RC code=$P_CANCEL_CODE"
  # REST: is there anything else under /operations/{id}/ ? (the contract lists cancel and retry-verification only)
  echo "REST operation routes in the contract: $(grep -o "path: '/operations[^']*'" /srv/work/s1/src/packages/contracts/src/rest/routes.ts | sort -u | tr '\n' ' ')"
  echo "operation.force_release anywhere in the server bundle's routes: $(grep -c 'force_release' /srv/work/s1/src/packages/contracts/src/rest/routes.ts) hits in routes.ts"
  # a new, innocent change on the same target (its own project dir: the parked bundle may be reverted)
  dir="$(new_project "park-${RANDOM}")"
  mkb "$dir" after-park >/dev/null <<'SQL'
CREATE TABLE public.after_park (id int PRIMARY KEY);
GRANT SELECT ON public.after_park TO lab_owner;
SQL
  mplan "$dir" "$target"; local planrc=$?
  if [ -n "${PLAN_ID:-}" ] && [ "$PLAN_STATE" = active ]; then
    mapply "$PLAN_ID" --no-wait; local nop="$OP_ID"
    sleep 15
    P_NEXT_STATE="$( [ -n "$nop" ] && op_state "$nop" || echo none)"
    echo "new plan applied 15 s later: $P_NEXT_STATE"
    echo "waitingFor: $(exdb_json operation show "$nop" | jq -c '.data.waitingFor')"
    [ -n "$nop" ] && exdb_json operation cancel "$nop" | jq -c '{cancel_new: .status, e: .error.code}'
  else
    P_NEXT_STATE="plan_refused(${PLAN_STATE:-?}/rc=$planrc)"
    echo "new plan: $P_NEXT_STATE"
  fi
}

verdict_parked() { # scenario  op
  local sc="$1" op="$2" st; st="$(op_state "$op")"
  if [ "${st%% *}" != needs_attention ]; then verdict "I9.${sc}" NOT_RUN "the operation did not park in needs_attention (it ended '${st}'): reproduction inconclusive"; return; fi
  if [ "$P_RETRY_RC" = 0 ]; then verdict "I9.${sc}" PASS "retry-verification works (${P_RETRY_CODE})"; return; fi
  local exit_found="no exit"
  [ "$P_CANCEL_RC" = 0 ] && exit_found="cancel works"
  case "$P_NEXT_STATE" in
    queued*|running*) verdict "I9.${sc}" FAIL "needs_attention with ${exit_found}: retry-verification ${P_RETRY_CODE}, cancel ${P_CANCEL_CODE}, domain(s) [${P_LOCKS}] still held; the next plan on the target stays ${P_NEXT_STATE%% *}" ;;
    *) verdict "I9.${sc}" PARTIAL "retry ${P_RETRY_CODE}, cancel ${P_CANCEL_CODE}, locks [${P_LOCKS}], next plan ${P_NEXT_STATE}" ;;
  esac
}

# ---------------------------------------------------------------------------------------------------------------
sc_rollback() { # B1 P1 (1): migration.rollback, verification cannot read the target
  local log="${OUT}/rollback.log"
  local T db dir id op
  T="$(fresh_target 9rb "$PG")"; db="$(target_db "$T")"; dir="$(new_project i9rb-${RUN_TAG})"
  bloat "$PG" "$db" "$BLOAT"   # before M: a rollback is bound to the fingerprint M left
  id="$(DOWN_SQL='DROP TABLE public.r1;' mkb "$dir" make-r1 <<'SQL'
CREATE TABLE public.r1 (id int PRIMARY KEY);
GRANT SELECT ON public.r1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T" && mapply "$PLAN_ID" --wait
  (cd "$dir" && exdb_json migration rollback --target "$T" "$id") >"${log}.rb.json"
  local plan; plan="$(jq -r '.data.id' "${log}.rb.json")"; echo "rollback plan $plan $(jq -r '.data.decision' "${log}.rb.json")"
  mapply "$plan" --no-wait; op="$OP_ID"
  inject_on_state "$op" verifying cut_target 120 || echo "injection window missed"
  follow "$op" 300; net_unblock
  park_probe "$op" "$T" "$dir"
  verdict_parked rollback "$op"
}

sc_unknown() { # B1 P1 (3) / E1 P1 #2: unknown apply outcome (the connection dies DURING COMMIT; the target stays away past the reconcile deadline)
  local log="${OUT}/unknown.log"
  local T db dir id op
  T="$(fresh_target 9un "$PG")"; db="$(target_db "$T")"; dir="$(new_project i9un-${RUN_TAG})"
  # a deferred constraint trigger makes COMMIT itself take 25 s: the window in which the outcome is unknowable
  PGDATABASE="$db" psql_target "$PG" -q -c "CREATE TABLE public.trig_tbl (id int); CREATE FUNCTION public.slow_commit() RETURNS trigger LANGUAGE plpgsql AS \$\$ BEGIN PERFORM pg_sleep(25); RETURN NULL; END \$\$; CREATE CONSTRAINT TRIGGER slow AFTER INSERT ON public.trig_tbl DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION public.slow_commit(); GRANT INSERT ON public.trig_tbl TO lab_owner"
  id="$(mkb "$dir" slow-commit <<'SQL'
INSERT INTO public.trig_tbl VALUES (1);
CREATE TABLE public.u1 (id int PRIMARY KEY);
GRANT SELECT ON public.u1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T" || { verdict I9.unknown NOT_RUN "plan refused: ${PLAN_STATE}"; return; }
  mapply "$PLAN_ID" --no-wait; op="$OP_ID"
  local k=0; while [ $k -lt 1200 ]; do
    [ "$(PGDATABASE="$db" psql_target "$PG" -Atc "SELECT count(*) FROM pg_stat_activity WHERE query = 'COMMIT' AND state = 'active' AND pid <> pg_backend_pid()" 2>/dev/null)" -ge 1 ] && break
    sleep 0.05; k=$((k+1)); done
  [ $k -ge 1200 ] && { verdict I9.unknown NOT_RUN "the COMMIT window was not seen; op: $(op_state "$op")"; return; }
  local pid; pid="$(head -1 "/var/lib/postgresql/16/${EXSTACK_CLUSTER_NAME}/postmaster.pid")"
  kill -QUIT "$pid"; sleep 1; systemctl stop "postgresql@16-${EXSTACK_CLUSTER_NAME}.service"
  echo "  target killed DURING COMMIT at $(date -u +%T) and kept down; op: $(op_state "$op")"
  follow "$op" 420
  systemctl start "postgresql@16-${EXSTACK_CLUSTER_NAME}.service"; sleep 5
  echo "  target back; ledger rows for the bundle: $(ledger_count "$PG" "$db" "$id"); tables: $(tables_in "$PG" "$db")"
  park_probe "$op" "$T" "$dir"
  echo "migration verify <id>: $(cd "$dir" && exdb_json migration verify "$id" --target "$T" | jq -c '{rc:.status, code:.error.code}')"
  verdict_parked unknown "$op"
}

sc_reconcile() { # E1 / B1 P1 (2): ledger.reconcile whose verification cannot read the target
  local log="${OUT}/reconcile.log"
  local T db dir id op
  T="$(fresh_target 9rc "$PG")"; db="$(target_db "$T")"; dir="$(new_project i9rc-${RUN_TAG})"
  bloat "$PG" "$db" "$BLOAT"
  id="$(mkb "$dir" one <<'SQL'
CREATE TABLE public.k1 (id int PRIMARY KEY);
GRANT SELECT ON public.k1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T" && mapply "$PLAN_ID" --wait
  # a hand change of the ledger (what a restore does): remove the row and its verification, as superuser
  PGDATABASE="$db" psql_target "$PG" -q -c "ALTER TABLE exponetdb.schema_migrations DISABLE TRIGGER ALL; ALTER TABLE exponetdb.migration_verifications DISABLE TRIGGER ALL; DELETE FROM exponetdb.migration_verifications; DELETE FROM exponetdb.schema_migrations WHERE migration_id='${id}'; ALTER TABLE exponetdb.schema_migrations ENABLE TRIGGER ALL; ALTER TABLE exponetdb.migration_verifications ENABLE TRIGGER ALL"
  echo "ledger now: $(ledger_count "$PG" "$db" "$id") row(s); status: $(cd "$dir" && exdb_json migration status --target "$T" | jq -c '{mirror: .data.mirror, pending: (.data.pending|length?)}' 2>/dev/null)"
  (cd "$dir" && exdb_json migration ledger reconcile --target "$T" --note "i9 reproduction: ledger edited by hand") >"${log}.rc.json"
  local plan; plan="$(jq -r '.data.id' "${log}.rc.json")"; echo "reconcile plan $plan state=$(jq -r '.data.state' "${log}.rc.json") err=$(jq -r '.error.code // "-"' "${log}.rc.json")"
  [ "$plan" = null ] && { verdict I9.reconcile NOT_RUN "no reconcile plan: $(jq -c .error "${log}.rc.json")"; return; }
  mapply "$plan" --no-wait; op="$OP_ID"
  inject_on_state "$op" verifying cut_target 120 || echo "injection window missed"
  follow "$op" 300; net_unblock
  park_probe "$op" "$T" "$dir"
  verdict_parked reconcile "$op"
}

sc_accept() { # E1 / B1 P1 (2): drift.accept whose verification cannot read the target
  local log="${OUT}/accept.log"
  local T db dir op
  T="$(fresh_target 9ac "$PG")"; db="$(target_db "$T")"; dir="$(new_project i9ac-${RUN_TAG})"
  bloat "$PG" "$db" "$BLOAT"
  mkb "$dir" one >/dev/null <<'SQL'
CREATE TABLE public.d1 (id int PRIMARY KEY);
GRANT SELECT ON public.d1 TO lab_owner;
SQL
  mplan "$dir" "$T" && mapply "$PLAN_ID" --wait
  PGDATABASE="$db" psql_target "$PG" -q -c "ALTER TABLE public.d1 ADD COLUMN oob integer"
  exdb drift check "$T" >/dev/null
  local f; f="$(exdb_json finding list --target "$T" --kind drift | jq -r '.data.items[0].id')"
  echo "drift finding $f"
  local planj; planj="$(human call POST "/api/v1/findings/${f}/accept" '{}')"
  local plan; plan="$(jq -r '.body.id' <<<"$planj")"; echo "accept plan $plan status=$(jq -r '.status' <<<"$planj") code=$(jq -r '.body.code // "-"' <<<"$planj")"
  [ "$plan" = null ] && { verdict I9.accept NOT_RUN "no accept plan: $(jq -c '.body' <<<"$planj" | cut -c1-300)"; return; }
  op="$(human apply "$plan" | head -1 | jq -r '.operationId')"; echo "operation $op"
  inject_on_state "$op" verifying cut_target 60 || echo "injection window missed"
  follow "$op" 300; net_unblock
  park_probe "$op" "$T" "$dir"
  verdict_parked accept "$op"
}

sc_endpoint() { # E1 P1 #1: a non-migration kind (registry.endpoint.add): the verification reads the cluster
  local log="${OUT}/endpoint.log"
  local cluster op dir; cluster="$(stack_id cluster_pg16)"; dir="$(new_project i9ep-${RUN_TAG})"
  local T; T="$(fresh_target 9ep "$PG")"
  local plan; plan="$(exdb_json cluster endpoint add "$cluster" --label "i9-${RUN_TAG}" --kind private --host 127.0.0.1 --port "$PGPORT" --tls-server-name "pg16.exdb.test" | jq -r '.data.id')"
  echo "endpoint plan $plan"
  [ -z "$plan" ] || [ "$plan" = null ] && { verdict I9.endpoint NOT_RUN "no plan"; return; }
  human apply "$plan" >/dev/null 2>&1; op="$(ctl_sql "SELECT operation_id FROM operations.operations WHERE kind='registry.endpoint.add' ORDER BY created_at DESC LIMIT 1")"
  echo "operation $op"
  inject_on_state "$op" verifying cut_target 30 || echo "(no verifying window: the kind finishes too fast to cut)"
  follow "$op" 200; net_unblock
  case "$(op_state "$op")" in needs_attention*) park_probe "$op" "$T" "$dir"; verdict_parked endpoint "$op" ;; *) verdict I9.endpoint NOT_RUN "did not park: $(op_state "$op")" ;; esac
}

# ---------------------------------------------------------------------------------------------------------------
sc_supersede() { # D0 P2: a refused recovery has already closed the needs_attention operation it names (driver.ts:178-186)
  local log="${OUT}/supersede.log"
  local T db dir id N V
  T="$(fresh_target 9ss "$PG")"; db="$(target_db "$T")"; dir="$(new_project i9ss-${RUN_TAG})"
  # M is applied but its verification cannot run (the check reads a table that is not there): N parks in needs_attention
  id="$(VERIFY_SQL='-- check: reads a table that does not exist
SELECT count(*) >= 0 AS ok FROM public.s1_missing;' mkb "$dir" parked <<'SQL'
CREATE TABLE public.s1 (id int PRIMARY KEY);
GRANT SELECT ON public.s1 TO lab_owner;
SQL
)"
  mplan "$dir" "$T"; echo "plan: ${PLAN_STATE}"
  mapply "$PLAN_ID" --wait; N="$OP_ID"
  echo "N = $N : $(op_state "$N")   locks: $(ctl_sql "SELECT string_agg(domain_key, ',') FROM operations.operation_locks WHERE operation_id='${N}'")"
  [ "$(op_state "$N" | cut -d' ' -f1)" = needs_attention ] || { verdict I9.supersede NOT_RUN "N is not parked: $(op_state "$N")"; return; }
  # the recovery: a verify revision that can pass, then `migration verify` (which names N and closes it when it starts).
  local bd; bd="$(ls -d "$dir"/migrations/${id}_*)"
  printf -- '-- check: the table exists\nSELECT count(*) >= 0 AS ok FROM public.s1;\n' >"$bd/verify.sql"
  # keep the worker from dispatching, accept the recovery, revoke the CLI's grant, let the worker go: admission refuses (GRANT_REVOKED)
  systemctl stop "$(_stk_unit worker)"
  (cd "$dir" && exdb_json migration verify "$id" --target "$T" --no-wait) >"${log}.v.json"
  V="$(jq -r '.data.id // empty' "${log}.v.json")"; echo "recovery operation V = ${V:-none} ($(jq -c '{s:.status,e:.error.code}' "${log}.v.json"))"
  [ -z "$V" ] && { systemctl start "$(_stk_unit worker)"; verdict I9.supersede NOT_RUN "the recovery was not accepted: $(jq -c .error "${log}.v.json")"; return; }
  echo "V: $(op_state "$V")"
  local gid; gid="$(human call GET /api/v1/me/grants | jq -r '[.body.items[] | select(.clientId=="exponetdb-cli")][0].id')"
  echo "revoking the CLI grant $gid: $(human call POST "/api/v1/me/grants/${gid}/revoke" '{}' | jq -c '.status')"
  systemctl start "$(_stk_unit worker)"
  follow "$V" 120 >/dev/null; echo "V after dispatch: $(op_state "$V")"
  local nstate nlocks
  nstate="$(op_state "$N")"; nlocks="$(ctl_sql "SELECT count(*) FROM operations.operation_locks WHERE operation_id='${N}'")"
  echo "N after the refused recovery: $nstate ; locks held by N: $nlocks"
  cli_login 2>&1 | tail -1
  case "${nstate%% *}" in
    needs_attention) verdict I9.supersede PASS "the refused recovery left N in needs_attention with its lock (V: $(op_state "$V" | cut -d' ' -f1))" ;;
    verification_failed|failed|canceled) verdict I9.supersede FAIL "V was refused ($(op_state "$V" | cut -d' ' -f1)) but N ended '${nstate%% *}' with ${nlocks} lock(s): the recovery closed N without doing anything" ;;
    *) verdict I9.supersede PARTIAL "N is '${nstate}', V is '$(op_state "$V")'" ;;
  esac
}

sc_approval() { # TC-034 / OD-64 and B1 P2: awaiting_approval, an expired plan, the approval window
  local log="${OUT}/approval.log"
  local dir; dir="$(new_project i9ap-${RUN_TAG})"
  mkb "$dir" prod-change >/dev/null <<'SQL'
CREATE TABLE public.ap1 (id int PRIMARY KEY);
GRANT SELECT ON public.ap1 TO lab_owner;
SQL
  verdict I9.approval NOT_RUN "not implemented in this iteration"
}

if [ $# -eq 0 ]; then set -- rollback unknown reconcile accept endpoint supersede approval; fi
for s in "$@"; do ( "sc_${s}" ) 2>&1 | tee "${OUT}/${s}.log"; done
