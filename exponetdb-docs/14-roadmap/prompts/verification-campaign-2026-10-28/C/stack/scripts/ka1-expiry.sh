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
AGE "UPDATE oauth.api_keys SET created_at = created_at - interval '3 days', expires_at = expires_at - interval '3 days' WHERE key_id='$KID'" 2>&1 | head -2
echo "bearer call after ageing (expired 2 days ago): $(curl -s -o /dev/null -w '%{http_code}' -H @$KH $API/api/v1/targets) body: $(curl -s -H @$KH $API/api/v1/targets | jq -c '[.code,.title,.message]')"
echo "WWW-Authenticate: $(curl -s -D- -o /dev/null -H @$KH $API/api/v1/targets | grep -i www-authenticate | cut -c1-200)"
echo "list as owner: $(hcall GET /api/v1/service-accounts/$SA/api-keys | jq -c '.body.items[]? | {id:.id, state, expiresAt}')"
echo "all service accounts listing includes it: $(hcall GET /api/v1/service-accounts | jq -c '[.body.items[]?|select(.id=="'$SA'")|.apiKeys]' | head -c 300)"
echo "revoke the expired key: $(hcall POST /api/v1/api-keys/$KID/revoke '{"reason":"s6 test"}' | brief)"
echo "list after revoke: $(hcall GET /api/v1/service-accounts/$SA/api-keys | jq -c '.body.items[]? | {state}')"
echo "CLI/REST filters for expiring keys: query params on list: $(hcall GET '/api/v1/service-accounts/'$SA'/api-keys?expiresBefore=2027-01-01' | brief)"
echo
echo "== step-up: stored state vs what the API says after expiry (rows created by the CLI/Web flows earlier on this stack)"
ctl_sql "select state||' attempts='||attempts||' expired='||(expires_at < clock_timestamp())||' receipt_expired='||coalesce((receipt_expires_at < clock_timestamp())::text,'-') from stepup.step_ups order by created_at desc limit 5"
for id in $(ctl_sql "select step_up_id from stepup.step_ups where expires_at < clock_timestamp() order by created_at desc limit 2"); do echo "GET step-up $id: $(hcall GET /api/v1/step-ups/$id | jq -c '{status, state:.body.state, code:(.body.code // null)}')"; done
echo "stored state values present: $(ctl_sql "select string_agg(distinct state, ',') from stepup.step_ups")"
echo "list route: $(hcall GET /api/v1/step-ups | jq -c '{status, code:(.body.code // null)}')"
echo
echo "== enrollment tokens: routes and state after expiry"
for p in /api/v1/enrollment-tokens /api/v1/servers/$(jq -r .server ${EXSTACK_STATE}/ids.json)/enrollment-tokens; do echo "GET $p -> $(hcall GET $p | jq -c '{status, code:(.body.code // null)}')"; done
echo "tokens in the store (state, expired by the DB clock?): $(ctl_sql "select string_agg(state||'/'||(expires_at < clock_timestamp())::text||'='||n, ' ') from (select state, expires_at, count(*) n from nodes.enrollment_tokens group by 1,2) t")"
echo "token ageing: oldest token $(ctl_sql "select token_id, state, created_at, expires_at from nodes.enrollment_tokens order by created_at limit 1")"
echo "now: $(ctl_sql 'select now()')"
rm -f $KH /dev/shm/s6sa.json
