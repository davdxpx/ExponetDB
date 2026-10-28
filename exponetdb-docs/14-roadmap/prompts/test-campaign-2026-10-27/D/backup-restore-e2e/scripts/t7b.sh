source /root/lab/lib.sh
read TS1 TS2 ROWS < $LOGS/ts; SCR=/var/lib/exponetdb-node-engine/scratch
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000
ls -la /var/spool/pgbackrest/ /var/spool/pgbackrest/archive/exdbnode 2>&1 | head; 
SEG=$(ls $ARC | grep -E "^0000000100000000000000DA-" | head -1)
SZ=$(stat -c %s $ARC/$SEG); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$SEG bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null
NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
R=$(rid); c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT}" >/dev/null
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT,\"port\":55400,\"checks\":[\"recovery_target_reached\",\"row_counts\"],\"rowCounts\":[{\"database\":\"app\",\"schema\":\"public\",\"table\":\"accounts\",\"min\":$ROWS,\"max\":$ROWS}]}" >/dev/null
sleep 5
echo "restore_command in scratch postmaster cmdline:"; ps -eo args | grep "[p]ostgres -D $SCR/$R" | tr ' ' '\n' | grep -E "restore_command|recovery|archive" | head
wait_run $R 600 | jq -c '.result|{state,lsn:.outcome.recoveryReachedLsn,checks:[.outcome.checks[]|{check,outcome,detail}]}'
echo "--- scratch PG log"; ls $SCR/$R; ls $SCR/$R/log 2>/dev/null | head; cat $SCR/$R/log/* 2>/dev/null | grep -vE "^\s*$" | head -60 | cut -c1-250
echo "--- pgbackrest logs for archive-get"; ls -t /var/log/pgbackrest | head -5; grep -h "archive-get" /var/log/pgbackrest/exdbnode-archive-get*.log 2>/dev/null | tail -12 | cut -c1-250
echo $R > $LOGS/lastscratch
