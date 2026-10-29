#!/usr/bin/env bash
# keys steps 5 and 9, second part: a NEW handshake against a gateway whose clock is past the node certificate (the first part showed that
# an established HTTP/2 session is not re-verified). Then the gateway clock goes back: does the node recover?
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ktgw2.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json)
ftg() { echo "$1" >/srv/work/s6/ft-gateway; sleep 1.2; }
nodeinfo() { exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt,clockSkewMs}' 2>/dev/null; }
alog() { journalctl --no-pager -o cat -u exponetdb-node --since "$1" | cut -c1-260 | tail -${2:-8}; }
glog() { journalctl --no-pager -o cat -u exs6-gateway --since "$1" | jq -rc 'select(.level!="info")|[.ts,.level,.msg,.code,.reason]|@tsv' 2>/dev/null | sort -u | tail -${2:-6}; }
bearer
echo "== certificate the agent holds now (host view) and what the Control Plane lists"
runuser -u exponetdb-node -- /usr/bin/exponetdb-node status --config /etc/exponetdb-node/config.json 2>&1 | head -6 | tr '\n' '|'; echo
rest GET /api/v1/nodes/certificates | head -1 >/dev/null; jq -c '[.nodes[]|{state,certificateExpiresAt}]' /dev/shm/s6out.last
echo "== gateway clock +200 h (past the newest certificate in the gateway's view), then restart the agent (new handshake) $(now)"
ftg +720000; T0=$(date +%s); systemctl restart exponetdb-node
for i in $(seq 1 12); do printf 't=%ss %s\n' "$(( $(date +%s)-T0 ))" "$(nodeinfo)"; sleep 5; done | awk '!seen[substr($0,index($0," "))]++'
echo "agent journal:"; alog "-90 sec" 8
echo "gateway journal (non-info):"; glog "-90 sec" 8
echo "REST node show: $(exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt}')"
echo "installation health gateway: $(rest GET /api/v1/installation/health | head -1 >/dev/null; jq -c '[.components[]|select(.id=="gateway" or .name=="gateway")|{state,reasons}]' /dev/shm/s6out.last)"
echo "findings about node/certificate: $(exdb_json finding list | jq -c '[.data.items[]?|(.kind // .code)] | map(select(test("node|cert"))) | length')"
echo "agent status: $(runuser -u exponetdb-node -- /usr/bin/exponetdb-node status --config /etc/exponetdb-node/config.json 2>&1 | head -6 | tr '\n' '|')"
echo "== gateway clock back to real time $(now)"
ftg +0; T0=$(date +%s)
for i in $(seq 1 10); do printf 't=%ss %s\n' "$(( $(date +%s)-T0 ))" "$(nodeinfo)"; sleep 5; done | awk '!seen[substr($0,index($0," "))]++'
echo "agent journal:"; alog "-60 sec" 6
echo "gateway journal (non-info):"; glog "-60 sec" 6
