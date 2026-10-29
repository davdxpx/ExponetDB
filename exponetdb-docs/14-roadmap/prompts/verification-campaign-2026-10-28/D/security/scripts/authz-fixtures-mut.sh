source /srv/work/s4/env.sh; cd $S4/authz
refresh_creds
T=$(cat $S4/creds/owner.token); A=http://127.0.0.1:58480/api/v1
SA=$(cat $S4/sa.id)
s4ts s4/ident.ts apikey $SA throwaway nonprod,prod 2>&1 | tail -1
KEY=$(curl -s -H "Authorization: Bearer $T" $A/api-keys | jq -r '.items[]|select(.label=="throwaway")|.id')
CID=$(curl -s -X POST http://127.0.0.1:58480/oauth/register -H 'content-type: application/json' -d '{"client_name":"s4-throwaway","redirect_uris":["http://127.0.0.1:34999/callback"],"grant_types":["authorization_code"],"response_types":["code"],"token_endpoint_auth_method":"none"}' | jq -r .client_id)
OC=$(curl -s -H "Authorization: Bearer $T" "$A/oauth-clients" | jq -r --arg c "$CID" '.items[]|select(.clientId==$c)|.id')
REPO=$(curl -s -H "Authorization: Bearer $T" $A/clusters/$(stack_id cluster_pg17)/backup-repositories | jq -r '.items[0].id')
echo "key=$KEY client=$OC repo=$REPO" | sed 's/[a-z]*_[0-9A-Z]\{26\}/<id>/g'
jq --arg k "$KEY" --arg oc "$OC" --arg repo "$REPO" '.ids.keyId=$k | .ids.oauthClientId=$oc | .ids.repositoryId=$repo' fixtures.json > fixtures-mut.json
refresh_creds
bun run-matrix.ts --base http://127.0.0.1:58480 --creds $S4/creds --fixtures fixtures-mut.json --matrix authz-matrix.json --samples authz-samples.json --bodies bodies.json --only rest --allow-mutations --out $L4/authz/run-mut 2>&1 | tail -1
python3 /srv/work/s4/refine.py $L4/authz/run-mut.json | cut -c1-250
