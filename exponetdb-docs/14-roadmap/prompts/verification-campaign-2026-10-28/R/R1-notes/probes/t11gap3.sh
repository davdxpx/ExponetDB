source /root/lab/lib.sh
exec > >(tee $LOGS/${TAG:-new}-t11gap3.log) 2>&1
mode owned; bind
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
LBL=20261028-194616F
F=$(ls $ARC | grep "^000000010000000000000012"); cp -a $ARC/$F /root/lab/walsave/gap3; rm -f $ARC/$F
echo "--- wal.archive_status with the stop segment of $LBL deleted:"
c wal.archive_status "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.error // .result' | cut -c1-600
echo "--- restore of $LBL to the end (type default) with its stop segment missing:"
R=$(rid)
c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":{\"label\":\"$LBL\",\"time\":null,\"lsn\":null,\"timeline\":null}}" | jq -c '.error // (.result|{engineCanRead,walContinuous,refusals})'
PORT=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$(rid)\",\"purpose\":\"drill\",\"target\":{\"label\":null,\"time\":null,\"lsn\":null,\"timeline\":null}}" | jq -r .result.port)
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":{\"label\":\"$LBL\",\"time\":null,\"lsn\":null,\"timeline\":null},\"port\":$PORT,\"checks\":[\"recovery_target_reached\",\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // empty'
out=$(wait_run $R 300)
echo "restore: state=$(echo "$out"|jq -r .result.state) reached=$(echo "$out"|jq -r .result.outcome.recoveryReachedLsn) checks=$(echo "$out"|jq -c '[.result.outcome.checks[]?|{(.check):.outcome}]|add')"
echo "$out" | jq -r .result.excerpt | grep -iE "FATAL|ERROR|could not|WAL ends|consisten" | head -6 | cut -c1-220
c restore.discard "{\"runId\":\"$R\"}" >/dev/null
cp -a /root/lab/walsave/gap3 $ARC/$F
