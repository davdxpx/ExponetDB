#!/usr/bin/env bash
# fail-closed step 8, second half: a node job dispatched while the agent is frozen (SIGSTOP), then released.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc8b.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json); C=$(jq -r .cluster_pg17 ${EXSTACK_STATE}/ids.json)
bearer
exdb_json node postgres reload $N --cluster $C --no-wait > $L6/fc8b-plan.json; PLAN=$(jq -r '.data.id // empty' $L6/fc8b-plan.json); echo "plan=$PLAN $(jq -c '{status,state:.data.state,error:.error}' $L6/fc8b-plan.json | head -c 200)"
PID=$(systemctl show -p MainPID --value exponetdb-node.service)
kill -STOP $PID; echo "agent frozen (SIGSTOP) at $(now)"
( exdb plan apply $PLAN --yes --no-wait > $L6/fc8b-apply.out 2>&1 ) &
for i in $(seq 1 30); do grep -q "Code:" $L6/fc8b-apply.out && break; sleep 1; done
SU=$(grep -o 'id=[A-Za-z0-9_]*' $L6/fc8b-apply.out | head -1 | cut -d= -f2); UC=$(grep -o 'Code: *[A-Z0-9-]*' $L6/fc8b-apply.out | head -1 | sed 's/Code: *//')
echo "step-up ${SU:-none}; confirm: $(human call POST /api/v1/step-ups/$SU/confirm "{\"userCode\":\"$UC\"}" 2>&1 | tail -1 | cut -c1-120)"
sleep 3
OP=$(ctl_sql "select operation_id from operations.operations where kind not like 'node.inspect' order by created_at desc limit 1"); echo "op=$OP kind=$(op_state $OP)"; cat $L6/fc8b-apply.out | sed 's/Code: .*/Code: <x>/' | head -5
t0; last=""
for i in $(seq 1 45); do
  cur="$(op_state $OP)"; job="$(ctl_sql "select string_agg(state,',') from nodes.jobs where operation_id='$OP'")"; nd=$(exdb_json node show $N | jq -r '.data.state'); k="$cur | job=$job | node=$nd"
  [ "$k" != "$last" ] && { echo "  t=$(el) $k"; last="$k"; }
  case "${cur%% *}" in succeeded|failed|needs_attention|canceled) break;; esac; sleep 4
done
kill -CONT $PID; echo "agent released at t=$(el)"
for i in $(seq 1 30); do cur="$(op_state $OP)"; job="$(ctl_sql "select string_agg(state,',') from nodes.jobs where operation_id='$OP'")"; k="$cur | job=$job"; [ "$k" != "$last" ] && { echo "  t=$(el) $k"; last="$k"; }; case "${cur%% *}" in succeeded|failed|needs_attention|canceled) break;; esac; sleep 3; done
echo "events: $(psql_control -At -c "select kind||':'||coalesce(to_state,'') from operations.operation_events where operation_id='$OP' order by event_id" | tr '\n' ';' | cut -c1-500)"
