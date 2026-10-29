#!/usr/bin/env bash
# graceful-life step 3: SIGTERM of serve under load, of the gateway with a node connected, of the node agent.
# (The worker during an apply was measured by S1/S3.)
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/gl-sigterm.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
LD=/srv/work/s6-infra/s6/load.mjs
stopwatch() { local u="$1" t0 t1; t0=$(date +%s.%N); systemctl stop $u; t1=$(date +%s.%N); printf 'stopped in %.1fs; ExecMainStatus=%s Result=%s' "$(echo "$t1-$t0"|bc)" "$(systemctl show -p ExecMainStatus --value $u)" "$(systemctl show -p Result --value $u)"; }
bearer
echo "== serve: 20 concurrent GET /api/v1/targets for 25 s, systemctl stop (SIGTERM) after 8 s $(now)"
node $LD --url $API/api/v1/targets --headers $HDR --c 20 --seconds 25 --label serve-sigterm > $L6/gl-st-load.out &
LP=$!; sleep 8
echo "serve: $(stopwatch $(_stk_unit serve))"
logs_since serve "-1 min" | jq -rc 'select(.msg|test("process\\.")) | [.ts,.msg,.ok,.exitCode,.reason]|@tsv' | tail -5
wait $LP; cat $L6/gl-st-load.out
t0; systemctl start $(_stk_unit serve); for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && break; sleep 0.5; done; echo "serve ready again after $(el)s"
echo "== serve: SIGTERM with a request in flight that cannot finish (store paused 20 s): how long until exit?"
bearer
( REST_T=40 rest GET /api/v1/targets | head -1 > $L6/gl-st-inflight.out ) &
IP=$!
docker pause $EXSTACK_CONTROL_NAME >/dev/null; sleep 1; echo "serve (store paused): $(stopwatch $(_stk_unit serve))"; docker unpause $EXSTACK_CONTROL_NAME >/dev/null; wait $IP; echo "in-flight request result: $(cat $L6/gl-st-inflight.out)"
logs_since serve "-1 min" | jq -rc 'select(.msg|test("process\\.")) | [.ts,.msg,.ok,.exitCode,.reason]|@tsv' | tail -4
systemctl start $(_stk_unit serve); for i in $(seq 1 60); do [ "$(hc $S)" = 200 ] && break; sleep 1; done
echo "== gateway with the node connected $(now)"
N=$(jq -r .node ${EXSTACK_STATE}/ids.json)
echo "node before: $(exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt}')"
echo "gateway: $(stopwatch $(_stk_unit gateway))"
t0; systemctl start $(_stk_unit gateway)
for i in $(seq 1 90); do st=$(exdb_json node show $N | jq -r '.data.state'); hb=$(exdb_json node show $N | jq -r '.data.lastHeartbeatAt'); printf 't=%s node=%s hb=%s\n' "$(el)" "$st" "$hb"; [ "$st" = active ] && [ "$(echo "$hb" | cut -c1-16)" = "$(date -u +%Y-%m-%dT%H:%M)" ] && break; sleep 3; done | tail -4
echo "agent log (reconnect):"; journalctl --no-pager -o cat -u exponetdb-node --since "-3 min" | grep -iE "connect|retry|backoff|refus|lost|error" | cut -c1-220 | tail -6
echo "== node agent stop/start"
echo "agent: $(stopwatch exponetdb-node.service)"; systemctl start exponetdb-node.service; sleep 5
journalctl --no-pager -o cat -u exponetdb-node --since "-30 sec" | cut -c1-200 | tail -5
