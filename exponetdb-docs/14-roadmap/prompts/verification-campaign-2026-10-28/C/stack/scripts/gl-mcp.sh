#!/usr/bin/env bash
# graceful-life step 4: many concurrent MCP requests. /mcp is stateless (no session table), so "sessions" are concurrent
# requests of one grant here (the per-grant rate limit applies; 1,000 distinct grants were not minted).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-mcp.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
MH=/dev/shm/s6mcp.hdr
bash /srv/work/s6-infra/s6/mcp-token.sh $MH
SP=$(systemctl show -p MainPID --value $(_stk_unit serve))
mem() { echo "rss=$(awk '/VmRSS/{print int($2/1024)}' /proc/$SP/status)MB fds=$(ls /proc/$SP/fd | wc -l) threads=$(awk '/Threads/{print $2}' /proc/$SP/status)"; }
hdrs=(-H @$MH -H 'content-type: application/json' -H 'accept: application/json, text/event-stream')
echo "== one request: initialize, tools/list"
curl -s -D- -o /dev/shm/s6mcp.out "${hdrs[@]}" -X POST $API/mcp -d '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"s6","version":"0"}}}' | grep -iE "^HTTP|mcp-|content-type" | tr -d '\r' | head -5; head -c 300 /dev/shm/s6mcp.out; echo
curl -s -o /dev/shm/s6mcp.out -w 'tools/list http=%{http_code} %{time_total}s bytes=%{size_download}\n' "${hdrs[@]}" -X POST $API/mcp -d '{"jsonrpc":"2.0","id":2,"method":"tools/list"}'; head -c 200 /dev/shm/s6mcp.out; echo
echo "before: $(mem)"
echo "== 1,000 concurrent tools/list requests for 30 s (same grant)"
( for i in $(seq 1 32); do printf 't=%s %s live=%s ' "$i" "$(mem)" "$(curl -s -o /dev/null -m 5 -w '%{http_code}/%{time_total}s' http://$S/healthz/live)"; echo; sleep 1; done ) > $L6/gl-mcp.mon &
MON=$!
node /srv/work/s6-infra/s6/load.mjs --url $API/mcp --method POST --headers $MH --bodystr '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' --c 1000 --seconds 30 --timeout-ms 60000 --label mcp1000
wait $MON
awk 'NR%4==1' $L6/gl-mcp.mon
echo "after: $(mem); 10 s later: $(sleep 10; mem)"
echo "serve ready: $(hc $S); serve log:"; logs_since serve "-2 min" | jq -rc 'select(.level=="error" or .level=="warn")|[.msg,.code,.reason]|@tsv' | sort | uniq -c | head -5
echo "metrics: $(curl -s http://$S/metrics | grep -E '^exdb_mcp_(requests_total|denied_total)' | head -10 | tr '\n' ' ')"
echo "== tools/call targets_list, 200 sequential, same grant: named rate-limit error"
node /srv/work/s6-infra/s6/load.mjs --url $API/mcp --method POST --headers $MH --bodystr '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"targets_list","arguments":{}}}' --c 20 --n 400 --label targets_list20
curl -s "${hdrs[@]}" -X POST $API/mcp -d '{"jsonrpc":"2.0","id":3,"method":"tools/call","params":{"name":"targets_list","arguments":{}}}' | head -c 600; echo
rm -f $MH
