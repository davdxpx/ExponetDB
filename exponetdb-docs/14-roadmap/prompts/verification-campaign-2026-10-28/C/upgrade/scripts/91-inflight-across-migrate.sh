#!/usr/bin/env bash
# upgrades.md section 1: "In-flight operations survive because workers stop at step boundaries and reconcile on start". An apply that is RUNNING
# (a 45 s statement) when `control-store migrate` commits and the roles are redeployed one by one: what does it do, and what does the old
# worker do between the migration and its own redeploy (it is not ready; does it keep claiming operations with the old kind registry)?
. /srv/work/s3-infra/s3/lib.sh
OUT="${S3_LOGS}/inflight"; mkdir -p "$OUT"
for r in serve worker gateway; do systemctl stop "$(_stk_unit $r)" 2>/dev/null; done
cs_wipe >/dev/null 2>&1; cs_restore "${EXSTACK_STATE}/dumps/control-pre-upgrade.sql.gz" || exit 1
s3_release old; s3_units old; for r in worker gateway serve; do systemctl start "$(_stk_unit $r)"; done
for i in $(seq 1 90); do stack_ready && break; sleep 1; done; cli_login >/dev/null 2>&1
T="$(add_target "s3if$(date +%H%M)" pg16 2>/dev/null)"; db="lab_${T#lab/platform/}"
PGDATABASE="$db" psql_target pg16 -q -c "CREATE SEQUENCE public.exec_seq; GRANT USAGE ON SEQUENCE public.exec_seq TO lab_owner"
d="$(new_project inflight)"
id="$(mkb "$d" long-run <<'SQL'
SELECT nextval('public.exec_seq');
SELECT pg_sleep(45);
CREATE TABLE public.inflight_a (id int PRIMARY KEY);
GRANT SELECT ON public.inflight_a TO lab_owner;
SQL
)"
mplan "$d" "$T" && mapply "$PLAN_ID" --no-wait; OP1="$OP_ID"
d2="$(new_project inflight2)"; mkb "$d2" queued-behind <<<"CREATE TABLE public.inflight_b (id int PRIMARY KEY); GRANT SELECT ON public.inflight_b TO lab_owner;" >/dev/null
sleep 8; echo "op1 running: $(op_state "$OP1")"
mplan "$d2" "$T" >/dev/null; mapply "$PLAN_ID" --no-wait >/dev/null; OP2="$OP_ID"; echo "op2 queued behind it (same target): $(op_state "$OP2")"
sleep 3
sampler_start "${OUT}/sampler.log"
echo "== control-store migrate (new build) at $(now) while op1 is running"
EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_migrate)" "${EXSTACK_NODE_BIN}" --liftoff-only ${NEW_ROOT}/build/bundle/bin/exponetdb.mjs control-store migrate 2>&1 | jq -c '{status: .state.status}'
# the OLD roles keep running (not ready) and are NOT redeployed for 70 s: what happens to the operations?
last=""; end=$(( $(date +%s) + 70 ))
while [ "$(date +%s)" -lt "$end" ]; do
  cur="1:$(op_state "$OP1" | cut -d' ' -f1-3) 2:$(op_state "$OP2" | cut -d' ' -f1-3)"; [ "$cur" != "$last" ] && { echo "  [$(date -u +%T)] $cur"; last="$cur"; }; sleep 1
done
echo "old roles after 70 s: $(role_versions | awk '{printf "%s=%s ", $1,$2}')"
echo "old worker log (claims after the migration?):"; journal worker --since "-90 sec" | grep -vE 'dataread|heartbeat' | cut -c1-200 | tail -5
echo "ledger of the target: $(PGDATABASE="$db" psql_target pg16 -Atc "select string_agg(name, ',' order by applied_seq) from exponetdb.schema_migrations")"
echo "== redeploy worker, gateway, serve from the new build"
for r in worker gateway serve; do systemctl stop "$(_stk_unit $r)"; sed -i "s|^ExecStart=.*|ExecStart=$(command -v node) --liftoff-only ${NEW_ROOT}/build/bundle/bin/exponetdb.mjs ${r}|" "/etc/systemd/system/$(_stk_unit $r)"; systemctl daemon-reload; systemctl start "$(_stk_unit $r)"; done
for i in $(seq 1 90); do stack_ready && break; sleep 1; done
s3_release new; last=""; end=$(( $(date +%s) + 120 ))
while [ "$(date +%s)" -lt "$end" ]; do
  cur="1:$(op_state "$OP1" | cut -d' ' -f1-3) 2:$(op_state "$OP2" | cut -d' ' -f1-3)"; [ "$cur" != "$last" ] && { echo "  [$(date -u +%T)] $cur"; last="$cur"; }
  case "$cur" in *succeeded*succeeded*|*failed*failed*) break;; esac; sleep 2
done
sampler_stop
echo "final: op1 [$(op_state "$OP1")] op2 [$(op_state "$OP2")]; ledger: $(PGDATABASE="$db" psql_target pg16 -Atc "select string_agg(name, ',' order by applied_seq) from exponetdb.schema_migrations"); first statement ran $(PGDATABASE="$db" psql_target pg16 -Atc "select last_value from public.exec_seq")x"
echo "op1 events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'') from operations.operation_events where operation_id='$OP1' order by event_id" | tr '\n' ' ')"
