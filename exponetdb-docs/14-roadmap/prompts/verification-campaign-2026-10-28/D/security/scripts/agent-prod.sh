#!/usr/bin/env bash
# S4 task 3: agent-initiated production changes over MCP (plan, apply, rollback, baseline) and foreign plans.
source /srv/work/s4/env.sh
cd $S4; refresh_creds
say() { printf '%-70s %s\n' "$1" "$2"; }
mc() { n=$1; shift; s4ts s4/mcp.ts call "agp-$n" "$@" 2>&1 | tail -1; }
sum() { jq -c '{isError:.body.result.isError, code:(.body.result.structuredContent.code//null), state:(.body.result.structuredContent.state//null), id:(.body.result.structuredContent.id//null), dec:(.body.result.structuredContent.decision//null), text:(.body.result.content[0].text//""|.[0:110])}' $L4/mcp/agp-$1.json; }
P=$(new_project s4promo6)
mkb $P s4-promo-g >/dev/null <<<"CREATE TABLE public.s4_g(id int primary key); GRANT SELECT ON public.s4_g TO lab_owner;"
mplan $P lab/platform/s4evi >/dev/null; mapply $PLAN_ID | cut -c1-120
IDG=$(ls $P/migrations | grep s4-promo-g | cut -d_ -f1)
SC="targets.read schema.read diagnostics.read migrations.read migrations.plan migrations.apply:nonprod migrations.apply:prod connections.operate:nonprod nodes.read backups.read"
s4ts s4/mcp.ts login --tiers nonprod,prod $SC 2>&1 | tail -1 | cut -c1-140
TP=$(stack_id target_s4prd); TE=$(stack_id target_s4evi)
echo "== production, agent-initiated"
mc plan-prod migration_plan "{\"target\":\"$TP\",\"migrationIds\":[\"$IDG\"]}" >/dev/null; sum plan-prod
PLP=$(jq -r '.body.result.structuredContent.id // empty' $L4/mcp/agp-plan-prod.json)
mc apply-prod plan_apply "{\"planId\":\"$PLP\"}" >/dev/null; sum apply-prod
OPP=$(jq -r '.body.result.structuredContent.operationId // .body.result.structuredContent.id // empty' $L4/mcp/agp-apply-prod.json)
[ -n "$OPP" ] && say "operation of the agent's production apply" "$(op_state $OPP)"
sleep 10; [ -n "$OPP" ] && say "after 10 s (nothing may run without a person)" "$(op_state $OPP)"
printf '  s4_g on s4prd: '; PGDATABASE=lab_s4prd psql_target pg17 -Atc "select to_regclass('public.s4_g') is not null"
say "agent approves via REST /approvals (MCP token)" "$(bq mcp-client POST /api/v1/approvals/${OPP:-op_x}/approve '{"planHash":"sha256:0000000000000000000000000000000000000000000000000000000000000000"}')"
mc approve-tool approval_approve "{\"operationId\":\"${OPP:-x}\"}" >/dev/null; sum approve-tool
echo "== a foreign plan (owner's F3: bound to the owner's CLI client)"
mc apply-foreign plan_apply "{\"planId\":\"$(cat rb3.plan)\"}" >/dev/null; sum apply-foreign
mc withdraw-foreign plan_withdraw "{\"planId\":\"$(cat rb3.plan)\"}" >/dev/null; sum withdraw-foreign
echo "== rollback and baseline"
mc rollback-prod migration_rollback_plan "{\"target\":\"$TP\",\"migrationId\":\"$(cat promo.ide)\"}" >/dev/null; sum rollback-prod
RBP=$(jq -r '.body.result.structuredContent.id // empty' $L4/mcp/agp-rollback-prod.json)
if [ -n "$RBP" ]; then mc rollback-apply plan_apply "{\"planId\":\"$RBP\"}" >/dev/null; sum rollback-apply; fi
printf 'tools that mention baseline/approve/reconcile/accept: '; jq -r '.result.tools[].name' $L4/mcp/tools.json | grep -ci 'baseline\|approv\|reconcil\|accept\|break'
echo "== nonprod contrast (agent-initiated, no human approval expected)"
P2=$(new_project s4promo7); mkb $P2 s4-promo-h >/dev/null <<<"CREATE TABLE public.s4_h(id int primary key); GRANT SELECT ON public.s4_h TO lab_owner;"
( cd $P2 && exdb migration plan --target lab/platform/s4evi >/dev/null 2>&1 ); IDH=$(ls $P2/migrations | grep s4-promo-h | cut -d_ -f1)
mc plan-np migration_plan "{\"target\":\"$TE\",\"migrationIds\":[\"$IDH\"]}" >/dev/null; sum plan-np
PLN=$(jq -r '.body.result.structuredContent.id // empty' $L4/mcp/agp-plan-np.json)
[ -n "$PLN" ] && { mc apply-np plan_apply "{\"planId\":\"$PLN\"}" >/dev/null; sum apply-np; sleep 12; OPN=$(ctl_sql "select operation_id from operations.operations where plan_id='$PLN'"); say "nonprod operation" "$(op_state $OPN)"; }
