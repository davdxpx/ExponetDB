#!/usr/bin/env bash
# S4: fixtures.json for D1's run-matrix.ts (ids of real objects on the disposable stack), written to $S4/authz/fixtures.json.
# ids = real objects used where the credential is expected to reach them; foreign = real objects a lesser credential must not see.
source /srv/work/s4/env.sh
mkdir -p $S4/authz; cd $S4
T=$(cat $S4/creds/owner.token); A=http://127.0.0.1:58480/api/v1
g() { curl -s -H "Authorization: Bearer $T" "$A$1"; }
first() { jq -r "$1" 2>/dev/null | head -1; }
PLAN=$(g "/plans?limit=50" | first '.items[]|select(.state=="applied" or .state=="consumed" or .state=="active")|.id')
PLAN_CONSUMED=$(g "/plans?limit=50" | first '[.items[]|select(.kind=="migration.apply")][0].id')
OP=$(g "/operations?limit=50" | first '.items[0].id')
NODE=$(stack_id node); SRV=$(stack_id server); C17=$(stack_id cluster_pg17); PRJ=$(stack_id project); PRD=$(stack_id product); ENV=$(stack_id env_staging)
IDN=$(g "/identities" | first '[.items[]|select(.kind=="human")][0].id')
KEY=$(g "/api-keys" | first '.items[0].id')
CLI=$(g "/oauth-clients" | first '.items[0].id')
GRANT=$(g "/me/grants" | first '.items[0].id')
BIND=$(g "/role-bindings" | first '.items[0].id')
SES=$(g "/me/sessions" 2>/dev/null | first '.items[0].id')
DB=$(g "/clusters/$C17/databases" | first '.items[0].id')
EP=$(g "/clusters/$C17/endpoints" | first '.items[0].id')
jq -n --arg stg "$(stack_id target_staging)" --arg prd "$(stack_id target_production)" --arg plan "$PLAN_CONSUMED" --arg op "$OP" \
  --arg node "$NODE" --arg srv "$SRV" --arg cls "$C17" --arg prj "$PRJ" --arg prdct "$PRD" --arg env "$ENV" --arg key "$KEY" --arg cli "$CLI" --arg grant "$GRANT" --arg bind "$BIND" --arg db "$DB" --arg ep "$EP" \
  '{targets:{nonprod:$stg,prod:$prd}, ids:{planId:$plan, operationId:$op, nodeId:$node, serverId:$srv, clusterId:$cls, projectId:$prj, productId:$prdct, environmentId:$env, keyId:$key, oauthClientId:$cli, grantId:$grant, bindingId:$bind, databaseId:$db, endpointId:$ep}, foreign:{}}' > $S4/authz/fixtures.json
jq -c '.ids|map_values(length>0)' $S4/authz/fixtures.json
