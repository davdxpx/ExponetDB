#!/usr/bin/env bash
# S7 task 1: the gateway with a REVOKED node. Plans and applies `node revoke` for the stack's only node agent (a normal operation; the stack is
# disposable and the node cannot be re-enrolled cheaply: the agent mapping of the PG17 cluster is lost), then watches: the operation, the node
# state, the gateway and agent logs, the open HTTP/2 session, what node-bound operations answer, the audit trail. Run LAST on a stack.
set -u
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; NODE=$(stack_id node); CLUSTER=$(stack_id cluster_pg17); W=$L7/revoke; mkdir -p $W
since() { date -u +%Y-%m-%d\ %H:%M:%S; }
happly() { local plan=$1 out; out=$W/apply.out; : >"$out"
  ( timeout 150 env EXPONETDB_CONFIG_DIR="${EXSTACK_STATE}/cli" node --liftoff-only "${EXSTACK_CLI_BIN}" plan apply "$plan" --yes --wait >"$out" 2>&1; echo "cli-exit=$?" >>"$out" ) &
  local pid=$! stu="" code="" i
  for i in $(seq 1 40); do stu=$(grep -Eo 'stu_[0-9A-Z]{26}' "$out" | head -1); code=$(grep -Eo 'Code: [A-Z0-9-]+' "$out" | head -1 | cut -d' ' -f2); [ -n "$stu" ] && [ -n "$code" ] && break; grep -q cli-exit "$out" && break; sleep 1; done
  if [ -n "$stu" ]; then echo "   step-up requested: $(human call POST "/api/v1/step-ups/$stu/confirm" "{\"userCode\":\"$code\"}" 2>&1 | head -1 | cut -c1-70)"; fi
  wait $pid; echo "   cli: $(grep -E 'cli-exit|Succeeded|rror' "$out" | tr '\n' ' ' | cut -c1-200)"; }
echo "== before"; exdb node status "$NODE" 2>&1 | sed -n 3,12p | cut -c1-120
echo "   established sessions to the gateway port: $(ss -tn state established '( dport = :58443 )' 2>/dev/null | tail -n +2 | wc -l)"
T0=$(since)
echo "== plan the revocation"; exdb_json node revoke "$NODE" --no-wait > $W/plan.json; PLAN=$(jq -r '.data.id // empty' $W/plan.json)
jq -c '{plan:.data.id,class:.data.class,decision:.data.decision,approvals:.data.approvals,rules:[.data.policyRules[]?|select(.result!="pass")|{id,severity}]}' $W/plan.json | cut -c1-300
echo "== apply (step-up by the scripted owner)"; happly "$PLAN"; T1=$(since)
for i in 1 2 3 4 5 6; do echo "   t+$((i*5))s node state: $(exdb_json node status "$NODE" | jq -r '.data.state // .error.code')"; sleep 5; done
echo "== gateway log since the revocation (refusals, ids only)"
journalctl -u exstack-gateway --since "$T0" --no-pager 2>/dev/null | grep -E 'agent\.(refused|tls_refused)|NODE_|revok' | cut -c1-260 | tail -8
echo "   count of gateway log lines with a refusal: $(journalctl -u exstack-gateway --since "$T1" --no-pager 2>/dev/null | grep -cE 'agent\.refused|agent\.tls_refused')"
echo "== agent log since the revocation"
journalctl -u exponetdb-node --since "$T0" --no-pager 2>/dev/null | cut -c1-260 | tail -8
echo "   established sessions to the gateway port now: $(ss -tn state established '( dport = :58443 )' 2>/dev/null | tail -n +2 | wc -l)"
echo "== node-bound calls after the revocation"
for c in "node inspect $NODE --capability cpu.stats@1 --timeout-wait 20s" "backup refresh $CLUSTER --no-wait" "node show $NODE"; do
  out=$(exdb_json $c); echo "   $c -> code=$(jq -r '.error.code // "ok"' <<<"$out") state=$(jq -r '.data.state // .data.node.state // ""' <<<"$out") msg=$(jq -r '.error.message // ""' <<<"$out" | cut -c1-100) rem=$(jq -r '.error.remediation // "-"' <<<"$out" | cut -c1-80)"
done
echo "== the node's own credential against the gateway (what the agent itself sends, nothing else)"
journalctl -u exponetdb-node --since "$T1" --no-pager 2>/dev/null | grep -ciE 'revoked|refused|certificate|forbidden|401|403' | sed 's/^/   agent log lines naming a refusal: /'
echo "== audit trail since the revocation"
ctl_sql "select to_char(occurred_at,'HH24:MI:SS')||' '||action||' '||phase||' '||actor_kind from audit.audit_events where occurred_at >= '$T0' and (action like 'node.%' or action like 'agent.%' or action like 'operation.%' or action like 'plan.%') order by seq" | cut -c1-110 | tail -14
echo "   audit events whose action mentions a refused node request: $(ctl_sql "select count(*) from audit.audit_events where occurred_at >= '$T1' and (action like '%refus%' or action like '%revoked%' or action like 'agent.%')")"
