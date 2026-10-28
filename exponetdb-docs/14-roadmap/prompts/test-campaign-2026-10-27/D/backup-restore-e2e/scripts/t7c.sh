source /root/lab/lib.sh
exec > >(tee $LOGS/t7c-corrupt-latest.log) 2>&1
ARC=/var/lib/pgbackrest/archive/exdbnode/17-1/0000000100000000; NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
mode owned; bind
echo "=== fresh incremental, then rows after it, then corrupt the segment holding them"
R=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"incremental\",\"databases\":[]}" >/dev/null; wait_run $R 600 | jq -r '"incr label "+.result.outcome.label'
psqlx "INSERT INTO public.accounts SELECT g,'m4_'||g FROM generate_series(4001,4010) g"; psqlx "SELECT pg_current_wal_lsn()"; psqlx "SELECT pg_switch_wal()" >/dev/null
sleep 1; psqlx "INSERT INTO public.accounts SELECT g,'m5_'||g FROM generate_series(5001,5010) g"; psqlx "SELECT pg_switch_wal()" >/dev/null; psqlx "SELECT pg_switch_wal()" >/dev/null
for i in 1 2 3 4 5; do runuser -u postgres -- pgbackrest --stanza=exdbnode check >/dev/null 2>&1 && break; sleep 2; done
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "rows=$ROWS"
echo "archive range: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.result.archive[0]')"
# the segment with m4 is the one right after the incremental's stop; find the 2nd newest-but-one by mtime order
LAST=$(psqlx "SELECT pg_walfile_name(pg_current_wal_lsn())"); echo "current segment $LAST"
SEGS=$(ls $ARC | grep -E '^0000000100000000000000[0-9A-F]{2}-' | sort | tail -4); echo "$SEGS"
SEG=$(echo "$SEGS" | head -2 | tail -1); echo "corrupting $SEG"; cp -a $ARC/$SEG /root/lab/walsave/
SZ=$(stat -c %s $ARC/$SEG); printf '\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef\xde\xad\xbe\xef' | dd of=$ARC/$SEG bs=1 seek=$((SZ/2)) conv=notrunc 2>/dev/null
R=$(rid); T0=$(ts)
c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT}" | jq -c '.result|{walContinuous,refusals}'
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT,\"port\":55400,\"checks\":[\"recovery_target_reached\",\"probe_simple\",\"probe_extended\"],\"rowCounts\":[]}" >/dev/null
out=$(wait_run $R 600); echo "$out" | jq -c '.result|{state,reached:.outcome.recoveryReachedLsn,checks:[.outcome.checks[]|{check,outcome,detail}]}'
echo "duration $(echo "$(ts) - $T0"|bc)s"
echo "rows in the restored scratch cluster: (start it? no - read via a reverify rowcount)"
RV=$(rid); c restore.verify "{\"runId\":\"$R\",\"verifyRunId\":\"$RV\",\"port\":55400,\"checks\":[\"row_counts\"]}" >/dev/null 2>&1; 
c restore.discard "{\"runId\":\"$R\"}" | jq -c '.result'
cp -a /root/lab/walsave/$SEG $ARC/$SEG
echo "ROWS expected=$ROWS" > $LOGS/rows-c
