source /root/lab/lib.sh
exec > >(tee $LOGS/t7-corrupt-wal-wrongkey.log) 2>&1
read TS1 TS2 ROWS < $LOGS/ts; F4=$(cat $LOGS/F4); SCR=/var/lib/exponetdb-node-engine/scratch
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
echo "archive segments D8..DD:"; ls -la $ARC | grep -E "0000000100000000000000D[89A-D]" 
NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
CHECKS='["recovery_target_reached","probe_simple","probe_extended","row_counts"]'
drill() { # name target expectedAccounts
  local name=$1 target=$2 want=$3 R=$(rid) T0=$(ts)
  local rc="[{\"database\":\"app\",\"schema\":\"public\",\"table\":\"accounts\",\"min\":$want,\"max\":$want}]"
  local prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target}"); local port=$(echo "$prep"|jq -r .result.port)
  echo "[$name] prepare: $(echo "$prep"|jq -c '.result|{engineCanRead,walContinuous,refusals}')"
  c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$target,\"port\":$port,\"checks\":$CHECKS,\"rowCounts\":$rc}" | jq -c '.error // .result|{runId}' >/dev/null
  local out=$(wait_run $R 900)
  echo "[$name] RESULT state=$(echo "$out"|jq -r .result.state) in $(echo "$(ts) - $T0"|bc)s reachedLsn=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) checks=$(echo "$out"|jq -c '[.result.outcome.checks[]?|{(.check):.outcome}]|add')"
  echo "[$name]   detail: $(echo "$out"|jq -c '[.result.outcome.checks[]?|select(.outcome!="passed")|.detail]')"
  echo "[$name]   excerpt tail: $(echo "$out"|jq -r .result.excerpt | tail -4 | cut -c1-260 | tr '\n' '|')"
  c restore.discard "{\"runId\":\"$R\"}" >/dev/null
}
echo "=== control: restore before corruption"; drill control-latest "$NULLT" $ROWS
SEG=$(ls $ARC | grep -E "^0000000100000000000000DA-" | head -1); echo "segment DA = $SEG ($(stat -c %s $ARC/$SEG) bytes)"
mkdir -p /root/lab/walsave; cp -a $ARC/$SEG /root/lab/walsave/
echo "=== corrupt: flip 16 bytes in the middle of $SEG"
SZ=$(stat -c %s $ARC/$SEG); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$SEG bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null
echo "pgbackrest archive-get directly: "; runuser -u postgres -- pgbackrest --stanza=exdbnode archive-get 0000000100000000000000DA /tmp/seg.out 2>&1 | tail -2; rm -f /tmp/seg.out
drill corrupt-pitr-TS2 "{\"label\":null,\"time\":\"$TS2\",\"lsn\":null,\"timeline\":null}" 320
drill corrupt-latest "$NULLT" $ROWS
echo "=== backup.verify (pgbackrest verify) over the repository with a corrupt WAL segment"
R=$(rid); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" | jq -c '.error // .result|{runId}'
out=$(wait_run $R 600); echo "verify: state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors) exit=$(echo "$out"|jq -r .result.exitCode)"; echo "$out"|jq -r .result.excerpt | grep -iE "ERROR|checksum|invalid" | head -5 | cut -c1-220
echo "=== restore the segment, repeat (control)"; cp -a /root/lab/walsave/$SEG $ARC/$SEG
drill after-repair-latest "$NULLT" $ROWS
echo "=== verify clean repository"; R=$(rid); c backup.verify "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"label\":null,\"snapshot\":null}" >/dev/null; out=$(wait_run $R 600); echo "verify: state=$(echo "$out"|jq -r .result.state) verifyErrors=$(echo "$out"|jq -r .result.outcome.verifyErrors)"
echo "=== WAL GAP: remove segment DA from the archive entirely"
rm -f $ARC/$SEG
echo "backup.list archive range: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.result.archive')"
drill gap-pitr-TS2 "{\"label\":null,\"time\":\"$TS2\",\"lsn\":null,\"timeline\":null}" 320
drill gap-latest "$NULLT" $ROWS
cp -a /root/lab/walsave/$SEG $ARC/$SEG
echo "=== WRONG KEY: change cipher-pass in the host pgbackrest configuration"
cp -a /etc/pgbackrest/pgbackrest.conf /root/lab/pgbackrest.conf.good
sed -i 's#^repo1-cipher-pass=.*#repo1-cipher-pass=wrongwrongwrongwrongwrongwrongwrongwrong#' /etc/pgbackrest/pgbackrest.conf
echo "backup.list: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.error // .result.stanza')"
echo "restore.prepare: $(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$(rid)\",\"purpose\":\"drill\",\"target\":$NULLT}" | jq -c '.error // .result|{engineCanRead,refusals}')"
R=$(rid); echo "backup.run (incremental): $(c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // .result|{runId}')"
echo "archive-push from PostgreSQL meanwhile: $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1 | cut -c1-200)"
cp -a /root/lab/pgbackrest.conf.good /etc/pgbackrest/pgbackrest.conf; chown root:postgres /etc/pgbackrest/pgbackrest.conf; chmod 0640 /etc/pgbackrest/pgbackrest.conf
echo "key restored; list: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.error // .result.stanza')"
