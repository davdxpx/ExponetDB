#!/usr/bin/env bash
# S7 task 1: TLS between the product and a target (always verify-full against the registered CA and name; no sslmode choice exists).
# Swaps the server certificate of the PG18 lab cluster (target lab/platform/dev18) for: expired, wrong name, untrusted CA, expiring in 2 days;
# restores the original at the end. Disposable lab only (normal operation: a certificate problem on a database server).
source /srv/work/s7/env.sh
L7=${L7:-/srv/work/logs-s7}; D=/etc/postgresql/18/exdbnode; W=$L7/tls; mkdir -p $W; chmod 700 $W
CA=${EXSTACK_STATE}/tls/ca.crt; CAK=${EXSTACK_STATE}/tls/ca.key
cp -a $D/server.crt $W/orig.crt; cp -a $D/server.key $W/orig.key
reload() { pg_ctlcluster 18 exdbnode reload; sleep 36; }   # 36 s: the product's circuit breaker (3 failures in 60 s open it for 30 s) must be closed before each probe
mkcert() { # name startdate enddate subjectCN(SAN) signer(ca|self)
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes -keyout $W/$1.key -out $W/$1.csr -subj "/CN=$4" 2>/dev/null
  printf 'subjectAltName=DNS:%s,IP:127.0.0.1\nextendedKeyUsage=serverAuth\n' "$4" > $W/$1.ext
  mkdir -p $W/ca-$1; : > $W/ca-$1/index.txt; echo 1000 > $W/ca-$1/serial
  cat > $W/ca-$1/ca.cnf <<CNF
[ca]
default_ca=x
[x]
dir=$W/ca-$1
database=\$dir/index.txt
new_certs_dir=\$dir
serial=\$dir/serial
default_md=sha256
policy=p
copy_extensions=none
[p]
commonName=supplied
CNF
  if [ "$5" = ca ]; then openssl ca -batch -config $W/ca-$1/ca.cnf -cert $CA -keyfile $CAK -in $W/$1.csr -out $W/$1.crt -startdate "$2" -enddate "$3" -extfile $W/$1.ext -notext 2>/dev/null
  else openssl req -x509 -key $W/$1.key -out $W/$1.crt -subj "/CN=$4" -days 30 -addext "subjectAltName=DNS:$4,IP:127.0.0.1" 2>/dev/null; fi
  openssl x509 -in $W/$1.crt -noout -subject -dates 2>&1 | tr '\n' ' ' | cut -c1-150; echo
}
install_cert() { install -o postgres -g postgres -m 0644 $W/$1.crt $D/server.crt; install -o postgres -g postgres -m 0600 $W/$1.key $D/server.key; reload; }
probe() {
  local label=$1; printf '%s\n' "--- $label"
  outj=$(exdb_json migration status --target lab/platform/dev18);
  out=$(exdb migration status --target lab/platform/dev18 2>&1); rc=$?; echo "   text: rc=$rc $(echo "$out" | grep -iE "error|TARGET_|tls|certificate|unavailable|Ledger" | head -2 | tr '\n' '|' | cut -c1-200)"
  echo "   target show: $(exdb target show lab/platform/dev18 2>&1 | grep -E 'Health' | tr -s ' ' | head -1)" echo "   json: code=$(jq -r '.error.code // "ok"' <<<"$outj") message=$(jq -r '.error.message // ""' <<<"$outj" | cut -c1-120) remedy=$(jq -r '.error.remediation // "-"' <<<"$outj" | cut -c1-120) details=$(jq -c '.error.details // {}' <<<"$outj" | cut -c1-120)"
  echo "   canary-ish check, the answer contains no password/secret word: $(echo "$outj" | grep -ciE 'password|secret' )"
}
echo "== baseline"; probe "original certificate"
echo "== T1 expired certificate (signed by the lab CA, valid 2026-01-01 .. 2026-01-02)"
mkcert t1 20260101000000Z 20260102000000Z pg18.exdb.test ca; install_cert t1; probe "expired"
echo "== T2 valid certificate for another name (other.exdb.test)"
mkcert t2 20260101000000Z 20270101000000Z other.exdb.test ca; install_cert t2; probe "wrong name"
echo "== T3 self-signed certificate (untrusted)"
mkcert t3 x x pg18.exdb.test self; install_cert t3; probe "untrusted CA"
echo "== T4 valid but expiring in 2 days"
mkcert t4 "$(date -u -d '-1 day' +%Y%m%d%H%M%SZ)" "$(date -u -d '+2 days' +%Y%m%d%H%M%SZ)" pg18.exdb.test ca; install_cert t4; probe "expires in 2 days"
echo "   does anything warn? findings of the target:"; exdb target show lab/platform/dev18 2>&1 | sed -n 1,30p | grep -iE "finding|cert|expir|warn|tls" | head -5
echo "   server-side TLS view, the product's PG session reports:"; PGDATABASE=postgres psql_target pg18 -Atc "select count(*) filter (where ssl) || ' of ' || count(*) || ' sessions use TLS' from pg_stat_ssl s join pg_stat_activity a using(pid) where a.application_name like 'exponetdb%'"
echo "== restore"; install -o postgres -g postgres -m 0644 $W/orig.crt $D/server.crt; install -o postgres -g postgres -m 0600 $W/orig.key $D/server.key; reload; probe "original restored"
