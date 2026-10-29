#!/usr/bin/env bash
# keys step 4: an MCP cursor sealed with the current key survives one rotation (previous version opens) and not two.
# serve re-reads the key versions every 5 minutes (MCP_KEY_REFRESH_MS), so each rotation is followed by a 5.5 minute wait.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/kx2.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
E=${EXSTACK_STATE}/env; MH=/dev/shm/s6mcp2.hdr
rot() { EXPONETDB_LOG_LEVEL=warn EXPONETDB_CONTROL_STORE_URL="$(store_url exdb_serve)" EXPONETDB_KEYRING="$(grep '^EXPONETDB_KEYRING=' $E/serve.env | cut -d= -f2- | sed "s/^'//; s/'\$//")" node_run keyring rotate-mcp-key --purpose mcp.cursor_key 2>&1 | jq -c '{purpose,version}' 2>/dev/null | head -c 120; }
callmcp() { # args json -> prints compact result
  bash /srv/work/s6-infra/s6/mcp-token.sh $MH >/dev/null 2>&1
  curl -s -H @$MH -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' -X POST $API/mcp -d "$1"
}
R0=$(callmcp '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"targets_list","arguments":{"limit":2}}}')
echo "first page: $(printf '%s' "$R0" | head -c 300)"
CUR=$(printf '%s' "$R0" | jq -r '[.. | objects | select(has("nextCursor")) | .nextCursor][0] // empty' 2>/dev/null)
[ -z "$CUR" ] && CUR=$(printf '%s' "$R0" | grep -o '"nextCursor":"[^"]*"' | head -1 | cut -d'"' -f4)
echo "cursor obtained: ${CUR:+yes (length ${#CUR})}"
use() { callmcp "$(jq -nc --arg c "$CUR" '{jsonrpc:"2.0",id:2,method:"tools/call",params:{name:"targets_list",arguments:{limit:2,cursor:$c}}}')" | head -c 260; echo; }
echo "== rotation 1 $(now): $(rot)"; sleep 330; echo "old cursor after 1 rotation + 5.5 min: $(use)"
echo "== rotation 2 $(now): $(rot)"; sleep 330; echo "old cursor after 2 rotations + 5.5 min: $(use)"
rm -f $MH
