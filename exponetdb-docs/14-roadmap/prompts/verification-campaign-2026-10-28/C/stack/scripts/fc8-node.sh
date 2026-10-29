#!/usr/bin/env bash
# fail-closed step 8 + observability step 9 (node part): node agent stopped; node stopped after a job was dispatched
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc8.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json); C=$(jq -r .cluster_pg17 ${EXSTACK_STATE}/ids.json)
bearer
echo "== baseline: node $(exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt}')"
echo "-- certificates: $(rest GET /api/v1/nodes/certificates | head -1) $(jq -c '{authorities:(.authorities|length // null), nodes:[.nodes[]?|{state,certificateExpiresAt}], serverCertificates:(.serverCertificates|length)}' /dev/shm/s6out.last 2>/dev/null | head -c 400)"
echo "== stop the agent $(now)"; systemctl stop exponetdb-node; t0
for s in 20 70 100; do while [ "$(echo "$(el) < $s" | bc)" = 1 ]; do sleep 1; done; echo "t=$(el): node state=$(exdb_json node show $N | jq -r '.data.state') heartbeatAge?=$(exdb_json node show $N | jq -r '.data.lastHeartbeatAt')"; done
echo "-- installation health: $(rest GET /api/v1/installation/health | head -1) gateway=$(jq -c '[.components[]|select((.id // .name // .component)=="gateway")|{state,reasons}]' /dev/shm/s6out.last)"
echo "-- plan postgres.reload with inspect:"; exdb node postgres reload $N --cluster $C --json 2>&1 | jq -c '{status, error:.error}' | head -c 500; echo
echo "-- plan without inspect (own observation <10 min):"; exdb_json node postgres reload $N --cluster $C --no-inspect --no-wait | jq -c '{status, state:.data.state, plan:.data.id, error:.error}' | head -c 500; echo
echo "-- findings for the node: $(exdb_json finding list | jq -c '[.data.items[]?|select(.kind|test("node|cert"))|.kind]')"
echo "-- gateway log:"; logs_since gateway "-3 min" | jq -rc 'select(.level=="warn" or .level=="error")|[.msg,.code]|@tsv' | sort | uniq -c | head -5
echo "== start the agent $(now)"; systemctl start exponetdb-node; t0
for i in $(seq 1 40); do st=$(exdb_json node show $N | jq -r '.data.state'); printf 't=%s %s\n' "$(el)" "$st"; [ "$st" = active ] && break; sleep 3; done | tail -3
echo
echo "== job dispatched, agent frozen (SIGSTOP) before it claims: $(now)"
PID=$(systemctl show -p MainPID --value exponetdb-node.service)
exdb_json node postgres reload $N --cluster $C --no-wait > $L6/fc8-plan.json; PLAN=$(jq -r '.data.id // empty' $L6/fc8-plan.json); echo "plan=$PLAN $(jq -c '{status,state:.data.state,error:.error}' $L6/fc8-plan.json | head -c 200)"
kill -STOP $PID
exdb_json plan apply $PLAN --no-wait > $L6/fc8-apply.json; OP=$(jq -r '.data.operationId // .operationId // .data.id // empty' $L6/fc8-apply.json); echo "op=$OP"
t0; last=""
for i in $(seq 1 60); do cur="$(op_state $OP)"; job="$(ctl_sql "select string_agg(state,',') from nodes.node_jobs where operation_id='$OP'" 2>/dev/null)"; k="$cur | jobs=$job"; [ "$k" != "$last" ] && { echo "  t=$(el) $k"; last="$k"; }; case "${cur%% *}" in succeeded|failed|needs_attention|canceled) break;; esac; sleep 3; done
kill -CONT $PID
for i in $(seq 1 40); do cur="$(op_state $OP)"; case "${cur%% *}" in succeeded|failed|needs_attention|canceled) break;; esac; sleep 3; done
echo "after SIGCONT: t=$(el) $cur | jobs=$(ctl_sql "select string_agg(state,',') from nodes.node_jobs where operation_id='$OP'")"
echo "events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'') from operations.operation_events where operation_id='$OP' order by event_id" | tr '\n' ';' | cut -c1-500)"
