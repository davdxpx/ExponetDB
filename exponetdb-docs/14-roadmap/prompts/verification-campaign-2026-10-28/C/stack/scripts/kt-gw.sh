#!/usr/bin/env bash
# keys steps 5 and 9: node certificate renewal window and expiry, seen through the GATEWAY's clock (libfaketime on the gateway only;
# the agent is a Go binary and ignores LD_PRELOAD, and the VM clock must not move). Needs kt0.sh (drop-ins) first.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/ktgw.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
N=$(jq -r .node ${EXSTACK_STATE}/ids.json)
ftg() { echo "$1" >/srv/work/s6/ft-gateway; sleep 1.2; }
nodeinfo() { exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt,agentVersion,certificateExpiresAt,clockSkewMs}' 2>/dev/null; }
certs() { bearer; rest GET /api/v1/nodes/certificates | head -1 >/dev/null; jq -c '{authorities:[.authorities[]?|{kind:(.kind // .name),notAfter:(.notAfter // .expiresAt)}], nodes:[.nodes[]?|{state,certificateExpiresAt}]}' /dev/shm/s6out.last | head -c 700; }
ren() { ctl_sql "select count(*) from audit.audit_events where action like 'node.certificate%'"; }
agent_status() { runuser -u exponetdb-node -- /usr/bin/exponetdb-node status --config /etc/exponetdb-node/config.json 2>&1 | head -6 | tr '\n' '|'; }
alog() { journalctl --no-pager -o cat -u exponetdb-node --since "$1" | cut -c1-230 | tail -${2:-6}; }
glog() { logs_since gateway "$1" | jq -rc 'select(.level!="info" or (.msg|test("agent|cert|identity")))|[.ts,.level,.msg,.code,.reason]|@tsv' | sort -u | tail -${2:-6}; }
bearer
echo "== baseline $(now)"; nodeinfo; certs; echo; echo "agent status: $(agent_status)"; echo "renewal events so far: $(ren)"
echo "== PHASE 1: gateway clock +49 h (the node certificate has 23 h left in the gateway's view; renewal window = last 24 h) $(now)"
T1=$(date +%s); ftg +176400
for i in $(seq 1 14); do printf 't=%ss %s | renewals=%s\n' "$(( $(date +%s)-T1 ))" "$(nodeinfo)" "$(ren)"; sleep 4; done | awk '!seen[$0]++' | tail -6
echo "node after: $(nodeinfo)"; certs; echo
echo "agent journal (last 2 min):"; alog "-2 min" 8
echo "gateway log:"; glog "-2 min" 6
echo "agent status: $(agent_status)"
echo "audit: $(ctl_sql "select seq||' '||action||' '||occurred_at from audit.audit_events where action like 'node.certificate%' order by seq desc limit 3" | tr '\n' ';')"
echo "== PHASE 2: gateway clock +125 h (past the renewed certificate's end in the gateway's view) $(now)"
T2=$(date +%s); ftg +450000
for i in $(seq 1 20); do printf 't=%ss %s\n' "$(( $(date +%s)-T2 ))" "$(nodeinfo)"; sleep 4; done | awk '!seen[substr($0,index($0," "))]++' | tail -5
echo "agent journal:"; alog "-2 min" 8
echo "gateway log:"; glog "-2 min" 8
echo "REST node show: $(exdb_json node show $N | jq -c '.data|{state,lastHeartbeatAt}')"; certs; echo
echo "installation health gateway: $(rest GET /api/v1/installation/health | head -1 >/dev/null; jq -c '[.components[]|select((.id // .name)=="gateway")|{state,reasons}]' /dev/shm/s6out.last)"
echo "findings about nodes/certificates: $(exdb_json finding list | jq -c '[.data.items[]?|(.kind // .code)] | map(select(test("node|cert"))) ')"
echo "agent status: $(agent_status)"
echo "== PHASE 3: gateway clock back to real time $(now)"
ftg +0; sleep 25; echo "node: $(nodeinfo)"; echo "agent journal:"; alog "-40 sec" 4
