#!/usr/bin/env bash
# keys/time steps 1 and 12 and "expired must say expired": API key, step-up, plan and enrollment token aged by data
# (UPDATE as the superuser with session_replication_role=replica, because the DB clock cannot be moved: S1 P1, audit chain guard).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ka1.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
hcall() { human call "$@" 2>&1 | tail -1; }
brief() { jq -c '{status, code:(.body.code // null), title:(.body.title // null)}' 2>/dev/null; }
KH=$(mktemp /dev/shm/s6key.XXXX); chmod 600 $KH
echo "== API key: create service account + key (1 day)"
SA=$(hcall POST /api/v1/service-accounts '{"displayName":"s6 expiry probe"}' | tee /dev/shm/s6sa.json | jq -r '.body.id // empty'); echo "service account: ${SA:-none} $(jq -c '{status, code:(.body.code // null)}' /dev/shm/s6sa.json)"
KEY=$(hcall POST /api/v1/service-accounts/$SA/api-keys '{"scopes":["targets.read"],"restrictions":{"tiers":["nonprod"],"targets":{"kind":"all"}},"label":"s6","lifetimeDays":1}')
printf 'Authorization: Bearer %s\n' "$(printf '%s' "$KEY" | jq -r '.body.secret // empty')" >$KH
KID=$(printf '%s' "$KEY" | jq -r '.body.apiKey.id // empty'); echo "key: ${KID:-none} state=$(printf '%s' "$KEY" | jq -r '.body.apiKey.state // .body.code') expiresAt=$(printf '%s' "$KEY" | jq -r '.body.apiKey.expiresAt // "-"')"
echo "bearer call before ageing: $(curl -s -o /dev/null -w '%{http_code}' -H @$KH $API/api/v1/targets)"
AGE() { psql_control -qAt -c "SET session_replication_role=replica; $1"; }
AGE "UPDATE oauth.api_keys SET created_at = created_at - interval '3 days', expires_at = expires_at - interval '3 days' WHERE api_key_id='$KID'" 2>&1 | head -2
echo "bearer call after ageing (expired 2 days ago): $(curl -s -o /dev/null -w '%{http_code}' -H @$KH $API/api/v1/targets) body: $(curl -s -H @$KH $API/api/v1/targets | jq -c '[.code,.title,.message]')"
echo "WWW-Authenticate: $(curl -s -D- -o /dev/null -H @$KH $API/api/v1/targets | grep -i www-authenticate | cut -c1-200)"
echo "list as owner: $(hcall GET /api/v1/service-accounts/$SA/api-keys | jq -c '.body.items[]? | {id:.id, state, expiresAt}')"
echo "all service accounts listing includes it: $(hcall GET /api/v1/service-accounts | jq -c '[.body.items[]?|select(.id=="'$SA'")|.apiKeys]' | head -c 300)"
echo "revoke the expired key: $(hcall POST /api/v1/api-keys/$KID/revoke '{"reason":"s6 test"}' | brief)"
echo "list after revoke: $(hcall GET /api/v1/service-accounts/$SA/api-keys | jq -c '.body.items[]? | {state}')"
echo "CLI/REST filters for expiring keys: query params on list: $(hcall GET '/api/v1/service-accounts/'$SA'/api-keys?expiresBefore=2027-01-01' | brief)"
echo
echo "== step-up: request, age, get"
SU=$(hcall POST /api/v1/step-ups '{"purpose":"s6"}' ); echo "create: $(printf '%s' "$SU" | brief)"
echo
echo "== enrollment tokens: routes and state after expiry"
for p in /api/v1/enrollment-tokens /api/v1/servers/$(jq -r .server ${EXSTACK_STATE}/ids.json)/enrollment-tokens; do echo "GET $p -> $(hcall GET $p | jq -c '{status, code:(.body.code // null)}')"; done
echo "tokens in the store: $(ctl_sql "select state||'='||count(*) from nodes.enrollment_tokens group by 1" | tr '\n' ' ')"
echo "token ageing: oldest token $(ctl_sql "select token_id, state, created_at, expires_at from nodes.enrollment_tokens order by created_at limit 1")"
echo "now: $(ctl_sql 'select now()')"
rm -f $KH /dev/shm/s6sa.json
