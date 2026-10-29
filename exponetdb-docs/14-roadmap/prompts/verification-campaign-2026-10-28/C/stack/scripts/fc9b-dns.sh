#!/usr/bin/env bash
# fail-closed step 9, DNS part: the endpoint of the pg18 cluster named by a host that does not resolve
# (host = tls_server_name is the only DNS form the registry accepts: endpoints_check1).
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc9b.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
D18=$(jq -r .target_dev18 ${EXSTACK_STATE}/ids.json); CL=$(jq -r .cluster_pg18 ${EXSTACK_STATE}/ids.json)
th() { bearer; rest GET /api/v1/targets/$D18/health | head -1 >/dev/null; jq -c '{state, conditions:[.conditions[]?|(.code // .id // .condition // .)], probes:([.probes[]?|"\(.probe):\(.outcome):\(.errorClass // "-"):\(.tls // "-")"]|unique)}' /dev/shm/s6out.last | head -c 500; echo; }
EID=$(ctl_sql "select endpoint_id from registry.endpoints where cluster_id='$CL' and state='active'")
OLD=$(ctl_sql "select host||'|'||tls_server_name from registry.endpoints where endpoint_id='$EID'")
psql_control -qAt -c "SET session_replication_role=replica; UPDATE registry.endpoints SET host='nx.exdb-invalid.test', tls_server_name='nx.exdb-invalid.test' WHERE endpoint_id='$EID'"
sleep 35; th
d=$(new_project s6dns); echo "SELECT 1;" | mkb "$d" dns1 >/dev/null; (cd $d; exdb migration plan --target lab/platform/dev18 2>&1 | tr '\n' ' ' | cut -c1-260); echo
echo "worker log: $(logs_since worker "-1 min" | jq -rc 'select(.level=="warn" or .level=="error")|[.msg,.targetId,.errorClass,.code]|@tsv' | sort | uniq -c | head -3 | tr '\n' '|')"
psql_control -qAt -c "SET session_replication_role=replica; UPDATE registry.endpoints SET host='${OLD%%|*}', tls_server_name='${OLD##*|}' WHERE endpoint_id='$EID'"
sleep 30; th
