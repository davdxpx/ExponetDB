export PATH=$PATH:/usr/local/go/bin
SOCK=/run/exponetdb-node/helper.sock
PGPORT=55417
REPO=bkr_01M70000000000000000000001
RESTIC=bkr_01M70000000000000000000002
LOGS=/root/lab/logs
c() { runuser -u exponetdb-node -- /usr/local/bin/labctl call $SOCK "$@"; }
rid() { echo "run_0$(tr -dc '0-9A-HJKMNP-TV-Z' </dev/urandom | head -c25)"; }
sysid() { runuser -u postgres -- psql -X -q -A -t -p $PGPORT -d postgres -c 'SELECT system_identifier FROM pg_control_system()'; }
psqlx() { runuser -u postgres -- psql -X -q -A -t -p $PGPORT -d "${DB:-app}" -c "$1"; }
SYSID=$(sysid 2>/dev/null || true)
CLUSTER='{"localName":"17/exdbnode","systemIdentifier":"'$SYSID'"}'
REPOJ='{"repositoryId":"'$REPO'","engine":"pgbackrest","stanza":"exdbnode","repoIndex":1}'
RESTICJ='{"repositoryId":"'$RESTIC'","engine":"restic","stanza":null,"repoIndex":null}'
mode() { install -d -m0755 /etc/exponetdb-node/repositories/$REPO; if [ "$1" = absent ]; then rm -f /etc/exponetdb-node/repositories/$REPO/mode; else echo "$1" > /etc/exponetdb-node/repositories/$REPO/mode; chmod 0644 /etc/exponetdb-node/repositories/$REPO/mode; fi; }
bind() { printf 'stanza=exdbnode\nrepo=1\n' > /etc/exponetdb-node/repositories/$REPO/pgbackrest; chmod 0644 /etc/exponetdb-node/repositories/$REPO/pgbackrest; }
ts() { date -u +%s.%N; }
now() { date -u +%H:%M:%S; }
# poll run.status until terminal; args: runid; reads record.json for startJobId/hash
status() { local r=$1; local rec=/var/lib/exponetdb-node-engine/runs/$r/record.json
  local jid=$(python3 -c "import json;d=json.load(open('$rec'));print(d['startJobId'])") ah=$(python3 -c "import json;d=json.load(open('$rec'));print(d['startArgsHash'])")
  c run.status '{"runId":"'$r'","startJobId":"'$jid'","startArgsHash":"'$ah'"}'; }
wait_run() { local r=$1 max=${2:-600} t0=$(date +%s) out st
  while :; do out=$(status $r); st=$(echo "$out" | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result',{}).get('state') or d.get('error'))")
    case "$st" in succeeded|failed|canceled|lost) echo "$out"; return;; esac
    [ $(( $(date +%s) - t0 )) -gt $max ] && { echo "TIMEOUT $out"; return 9; }; sleep 1; done; }
