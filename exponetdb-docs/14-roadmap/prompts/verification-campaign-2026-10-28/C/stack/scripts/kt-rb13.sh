#!/usr/bin/env bash
# keys step 5, recovery: RB-13 "certificate expired": decommission the node, move the state aside, enroll again with a new token.
# Needs the gateway clock past the node certificate (kt0.sh, kt-gw2.sh). Times each step and counts commands.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ktrb13.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json); SRV=$(jq -r .server ${EXSTACK_STATE}/ids.json); C=$(jq -r .cluster_pg17 ${EXSTACK_STATE}/ids.json)
ftg() { echo "$1" >/srv/work/s6/ft-gateway; sleep 1.2; }
CMDS=0; step() { CMDS=$((CMDS+1)); echo "[$(now)] step $CMDS: $*"; }
bearer
echo "== trigger: gateway clock +200 h, agent restarted: refused"; ftg +720000; systemctl restart exponetdb-node; sleep 75
echo "node: $(exdb_json node show $N | jq -c '.data|{state}')"
T_A=$(date +%s)
step "exponetdb node decommission $N --apply (plan, step-up, apply)"
( exdb node decommission $N --apply --yes > $L6/rb13-decom.out 2>&1 ) & DP=$!
for i in $(seq 1 30); do grep -q "Code:" $L6/rb13-decom.out && break; sleep 1; done
SU=$(grep -o 'id=[A-Za-z0-9_]*' $L6/rb13-decom.out | head -1 | cut -d= -f2); UC=$(grep -o 'Code: *[A-Z0-9-]*' $L6/rb13-decom.out | head -1 | sed 's/Code: *//')
if [ -n "$SU" ]; then step "confirm the step-up in the browser (scripted owner)"; human call POST /api/v1/step-ups/$SU/confirm "{\"userCode\":\"$UC\"}" 2>&1 | tail -1 | cut -c1-100; fi
sleep 8; OP=$(ctl_sql "select operation_id from operations.operations where kind like 'node.decommission%' order by created_at desc limit 1"); echo "op=$OP $(op_state $OP)"
if op_state $OP | grep -q awaiting_approval; then step "approve the operation (second person in production)"; human approve $OP 2>&1 | tail -1; fi
wait $DP; sed 's/Code: .*/Code: <x>/' $L6/rb13-decom.out | head -12 | cut -c1-200
echo "op after: $(op_state $OP); node: $(exdb_json node show $N | jq -c '.data|{state}')"
step "systemctl stop exponetdb-node; mv /var/lib/exponetdb-node aside; recreate it (0700)"
systemctl stop exponetdb-node; mv /var/lib/exponetdb-node /var/lib/exponetdb-node.old; install -d -m 0700 -o exponetdb-node -g exponetdb-node /var/lib/exponetdb-node
ftg +0
step "new enrollment token (plan node.enroll, step-up, reveal once)"
rm -f ${EXSTACK_STATE}/node-token
( cd ${EXSTACK_KIT} && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" bun --conditions=@exponetdb/source seed.ts enrollment ${EXSTACK_STATE}/node-token ) 2>&1 | tail -2 | cut -c1-200
step "exponetdb-node enroll --token-file -"
runuser -u exponetdb-node -- /usr/bin/exponetdb-node enroll --config /etc/exponetdb-node/config.json --token-file - <${EXSTACK_STATE}/node-token 2>&1 | tail -3 | cut -c1-200
shred -u ${EXSTACK_STATE}/node-token 2>/dev/null
FP=$(( EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_worker)" node_run node-pki job-key list 2>/dev/null ) | jq -r '[.. | objects | select(has("fingerprint")) | .fingerprint][0]')
step "exponetdb-node-helper trust --expect-key <fingerprint>"
/usr/sbin/exponetdb-node-helper trust --agent-state /var/lib/exponetdb-node --expect-key "$FP" 2>&1 | tail -1 | cut -c1-160
step "systemctl start exponetdb-node"; systemctl start exponetdb-node
sleep 20
NEWN=$(exdb_json node list | jq -r '[.data.items[]|select(.id!="'$N'")][0].id // empty'); echo "new node id: ${NEWN:-none}; old node: $(exdb_json node show $N | jq -c '.data|{state}'); new: $(exdb_json node show ${NEWN:-x} | jq -c '.data|{state,lastHeartbeatAt}')"
step "adopt the cluster for the new node (registry)"
( cd ${EXSTACK_KIT} && EXSTACK_OWNER_FILE="${EXSTACK_STATE}/owner.json" EXSTACK_STATE="${EXSTACK_STATE}" bun --conditions=@exponetdb/source seed.ts adopt ) 2>&1 | tail -3 | cut -c1-240
echo "== RB-13 total: $(( $(date +%s) - T_A )) s, $CMDS operator actions"
echo "cluster management: $(exdb_json node list | jq -c '[.data.items[]|{id,state}]')"
