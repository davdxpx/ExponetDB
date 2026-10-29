#!/usr/bin/env bash
# observability steps 11-14 (read part): what the product says, long after the seed, about the hand-made ledger row on production,
# the operation parked in awaiting_approval, and which maintenance tasks exist (is there a backup/drill task?).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/obs-read.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
bearer
TP=$(jq -r .target_production ${EXSTACK_STATE}/ids.json)
echo "== $(now) maintenance tasks ($(ctl_sql 'select count(*) from control.maintenance_tasks')): $(ctl_sql "select string_agg(task, ' ' order by task) from control.maintenance_tasks")"
echo "backup/drill/certificate/divergence tasks: $(ctl_sql "select count(*) from control.maintenance_tasks where task ~ 'backup|drill|cert|diverg|ledger'")"
echo "== ledger divergence on production"
echo "target show (ledger part): $(exdb target show lab/platform/production 2>&1 | grep -iE 'ledger|diverg|applied|finding' | head -6 | tr '\n' '|')"
echo "ledger state in the store: $(ctl_sql "select * from migrations.ledger_state where target_id='$TP'" 2>&1 | head -3 | cut -c1-300)"
echo "findings (all): $(exdb_json finding list | jq -c '[.data.items[]?|(.kind // .code)] | group_by(.) | map({k:.[0],n:length})' | head -c 400)"
echo "drift checks on production: $(ctl_sql "select count(*)||' last '||max(created_at) from observation.drift_checks where target_id='$TP'" 2>&1 | head -1)"
d=$(new_project s6div); echo "SELECT 1;" | mkb "$d" div1 >/dev/null
echo "migration plan on production: $(cd $d; exdb migration plan --target lab/platform/production 2>&1 | tr '\n' ' ' | cut -c1-500)"
echo "== operation parked in awaiting_approval"
OP=$(ctl_sql "select operation_id from operations.operations where state='awaiting_approval' order by created_at limit 1")
echo "op $OP: $(ctl_sql "select state||' since '||created_at||' age='||(clock_timestamp()-created_at) from operations.operations where operation_id='$OP'")"
echo "events: $(ctl_sql "select kind from operations.operation_events where operation_id='$OP' order by event_id" | tr '\n' ';')"
echo "approval list: $(exdb_json approval list | jq -c '[.data.items[]?|{id:(.operationId // .id),state}]' | head -c 300)"
echo "fleet operations part: $(rest GET /api/v1/fleet | head -1 >/dev/null; jq -c '.operations // .awaitingApproval // keys' /dev/shm/s6out.last | head -c 300)"
echo "metrics mentioning approvals/awaiting: $(curl -s http://$S/metrics http://$W/metrics | grep -ci 'approval\|awaiting')"
echo "worker loop 'waiting' counter: $(curl -s http://$W/metrics | grep 'operations_loop_total{outcome="waiting"}')"
