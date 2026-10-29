#!/usr/bin/env bash
# Get an MCP access token (audience mcp) through DCR + device flow, approved by the scripted owner.
# Writes the header to $1 (0600), prints ids only. Scopes: read set only.
. /srv/work/s6-infra/s6/lib6.sh
OUT=${1:?header file}
SC="targets.read schema.read diagnostics.read migrations.read audit.read nodes.read"
R=$(curl -s -X POST $API/oauth/register -H 'content-type: application/json' -d "$(jq -nc --arg s "$SC" '{client_name:"s6 load client",redirect_uris:["http://127.0.0.1:53682/callback"],grant_types:["urn:ietf:params:oauth:grant-type:device_code","refresh_token"],response_types:[],token_endpoint_auth_method:"none",scope:$s}')")
CID=$(printf '%s' "$R" | jq -r '.client_id // empty'); echo "client_id: ${CID:-none} $(printf '%s' "$R" | jq -c '{error,error_description}' | head -c 200)"
D=$(curl -s -X POST $API/oauth/device_authorization --data-urlencode "client_id=$CID" --data-urlencode "scope=$SC" --data-urlencode "resource=$API/mcp")
UC=$(printf '%s' "$D" | jq -r '.user_code // empty'); DC=$(printf '%s' "$D" | jq -r '.device_code // empty'); echo "device: user_code ${UC:+set} $(printf '%s' "$D" | jq -c '{error,error_description,interval}')"
human device-approve "$UC" $SC 2>&1 | tail -1 | cut -c1-200
for i in 1 2 3 4; do
  T=$(curl -s -X POST $API/oauth/token --data-urlencode "grant_type=urn:ietf:params:oauth:grant-type:device_code" --data-urlencode "device_code=$DC" --data-urlencode "client_id=$CID" --data-urlencode "resource=$API/mcp")
  AT=$(printf '%s' "$T" | jq -r '.access_token // empty'); [ -n "$AT" ] && break; echo "token poll $i: $(printf '%s' "$T" | jq -c '{error,error_description}')"; sleep 6
done
( umask 077; printf 'Authorization: Bearer %s\n' "$AT" >"$OUT" ); echo "token: ${AT:+obtained} audience resource $(printf '%s' "$T" | jq -r '.scope // ""' | wc -w) scopes"
