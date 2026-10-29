#!/usr/bin/env bash
# S4: call every MCP tool that does not mutate with real ids (sample args from D1's authz-samples.json); bodies to $L4/mcp/.
source /srv/work/s4/env.sh
cd $S4
SC="targets.read schema.read diagnostics.read data.read:nonprod migrations.read migrations.plan connections.operate:nonprod backups.read nodes.read nodes.plan audit.read"
s4ts s4/mcp.ts login $SC 2>&1 | tail -1
T16=$(stack_id target_dev16); TST=$(stack_id target_staging)
for tool in $(jq -r '.mcp|keys[]' $S4/authz/authz-samples.json); do
  case $tool in plan_apply|plan_withdraw|operation_cancel|sql_cancel|migration_plan|migration_rollback_plan) continue;; esac
  args=$(jq -c --arg t "$tool" --arg tgt "$T16" --arg plan "$(jq -r .ids.planId $S4/authz/fixtures.json)" --arg op "$(jq -r .ids.operationId $S4/authz/fixtures.json)" --arg node "$(stack_id node)" \
    '.mcp[$t].args | walk(if . == "@id:tgt" then $tgt elif . == "@id:pln" then $plan elif . == "@id:op" then $op elif . == "@id:nod" then $node else . end)' $S4/authz/authz-samples.json)
  [ "$tool" = sql_query ] && args=$(jq -c --arg tgt "$T16" -n '{target:$tgt, sql:"select id, note from public.s4_rows"}')
  [ "$tool" = sql_explain ] && args=$(jq -c --arg tgt "$T16" -n '{target:$tgt, sql:"select id, note from public.s4_rows"}')
  s4ts s4/mcp.ts call mcp-$tool "$tool" "$args" 2>&1 | tail -1
done
