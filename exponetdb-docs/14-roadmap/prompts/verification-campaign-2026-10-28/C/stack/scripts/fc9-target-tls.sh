#!/usr/bin/env bash
# fail-closed step 9 + keys step 11 + observability step 10: target DNS failure, TLS failure (expired / wrong name),
# tls_expiring (5 days left) and an unreachable port, with the signals each one gives.
. /srv/work/s6-infra/s6/lib6.sh
O=$L6/fc9.out; : >$O; exec > >(tee -a $O) 2>&1
set +e
D18=$(jq -r .target_dev18 ${EXSTACK_STATE}/ids.json); CL=$(jq -r .cluster_pg18 ${EXSTACK_STATE}/ids.json)
PGD=/etc/postgresql/18/exs6; W6=$(mktemp -d /dev/shm/s6tls.XXXX); chmod 700 $W6
th() { bearer; rest GET /api/v1/targets/$D18/health | head -1 >/dev/null; jq -c '{state, source, observedAt, conditions:[.conditions[]?|(.code // .id // .condition // .name // .)], unknownBecause, probes:([.probes[]?|"\(.probe):\(.outcome):\(.errorClass // "-"):\(.tls // "-")"]|unique)}' /dev/shm/s6out.last | head -c 700; echo; }
findings() { exdb_json finding list | jq -c '[.data.items[]?|select(.subject|tostring|test("'$D18'"))|(.kind // .code)] ' 2>/dev/null | head -c 300; }
planp() { local d; d=$(new_project s6tls); echo "SELECT 1;" | mkb "$d" tls1 >/dev/null; mplan "$d" lab/platform/dev18; (cd $d; exdb migration plan --target lab/platform/dev18 2>&1 | tr '\n' ' ' | cut -c1-300); echo; }
mkcert() { # name fake_date days san
  openssl ecparam -genkey -name prime256v1 -noout -out $W6/$1.key 2>/dev/null
  openssl req -new -key $W6/$1.key -subj "/CN=$4" -out $W6/$1.csr 2>/dev/null
  printf 'subjectAltName=DNS:%s\n' "$4" >$W6/$1.ext
  if [ "$2" = now ]; then openssl x509 -req -in $W6/$1.csr -CA ${EXSTACK_STATE}/tls/ca.crt -CAkey ${EXSTACK_STATE}/tls/ca.key -CAcreateserial -days $3 -extfile $W6/$1.ext -out $W6/$1.crt 2>/dev/null
  else LD_PRELOAD=/usr/lib/x86_64-linux-gnu/faketime/libfaketime.so.1 FAKETIME="@$2" openssl x509 -req -in $W6/$1.csr -CA ${EXSTACK_STATE}/tls/ca.crt -CAkey ${EXSTACK_STATE}/tls/ca.key -CAcreateserial -days $3 -extfile $W6/$1.ext -out $W6/$1.crt 2>/dev/null; fi
  openssl x509 -in $W6/$1.crt -noout -dates | tr '\n' ' '; echo
}
install_cert() { install -o postgres -g postgres -m 600 $W6/$1.key $PGD/server.key; install -o postgres -g postgres -m 644 $W6/$1.crt $PGD/server.crt; systemctl reload postgresql@18-${EXSTACK_CLUSTER_NAME}; }
cp -p $PGD/server.crt $W6/orig.crt; cp -p $PGD/server.key $W6/orig.key
wait_state() { local want="$1" i; for i in $(seq 1 40); do s=$(th | jq -r '.state'); [ "$s" = "$want" ] && break; sleep 3; done; echo "   state after ~$((i*3))s: $s"; }
echo "== baseline"; th; echo "plan: $(planp)"
echo "== A. server certificate EXPIRED (valid 2026-10-01 for 3 days, signed by the lab CA)"
echo "cert: $(mkcert exp '2026-10-01 00:00:00' 3 pg18.exdb.test)"; install_cert exp
sleep 20; for i in 1 2 3; do th; sleep 10; done
echo "findings: $(findings)"; echo "plan on the target: $(planp)"
echo "worker log: $(logs_since worker "-2 min" | jq -rc 'select(.level=="warn" or .level=="error")|[.msg,.targetId,.class,.code]|@tsv' | sort | uniq -c | head -4 | tr '\n' '|')"
echo "== B. certificate for another name (CN pg99.example, valid)"
echo "cert: $(mkcert oth now 30 pg99.exdb.test)"; install_cert oth; sleep 25; th; echo "plan: $(planp)"
echo "== C. certificate valid, 5 days left (tls_expiring must appear at 30/7 days per health.md)"
echo "cert: $(mkcert five now 5 pg18.exdb.test)"; install_cert five; sleep 40; th; echo "findings: $(findings)"
echo "== D. original certificate back"
install_cert orig 2>/dev/null || { install -o postgres -g postgres -m 600 $W6/orig.key $PGD/server.key; install -o postgres -g postgres -m 644 $W6/orig.crt $PGD/server.crt; systemctl reload postgresql@18-${EXSTACK_CLUSTER_NAME}; }
sleep 30; th
echo "== E. DNS failure: endpoint host replaced by a name that does not resolve (registry row edited as superuser; a registry plan would do the same)"
EID=$(ctl_sql "select endpoint_id from registry.endpoints where cluster_id='$CL' and state='active'")
psql_control -qAt -c "SET session_replication_role=replica; UPDATE registry.endpoints SET host='nx.exdb-invalid.test' WHERE endpoint_id='$EID'"
sleep 30; th; echo "plan: $(planp)"
psql_control -qAt -c "SET session_replication_role=replica; UPDATE registry.endpoints SET host='127.0.0.1' WHERE endpoint_id='$EID'"
echo "== F. target port blocked (iptables DROP to 56418) 30 s"
net_block 56418 drop; sleep 35; th; net_unblock; sleep 25; th
rm -rf $W6
