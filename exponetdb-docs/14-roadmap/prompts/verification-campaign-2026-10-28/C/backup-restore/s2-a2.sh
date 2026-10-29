# Phase A2: continuous load (pgbench rate-limited + 1 Hz marker) with incremental, differential, full backups under load; records PITR targets
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/a2-load.log) 2>&1
TGT=$LOGS/targets.tsv
mon() { while :; do runuser -u postgres -- psql -X -q -A -t -F, -p 55417 -d postgres -c "SELECT to_char(now() AT TIME ZONE 'UTC','HH24:MI:SS'), pg_current_wal_lsn(), a.archived_count, a.last_archived_wal, to_char(a.last_archived_time AT TIME ZONE 'UTC','HH24:MI:SS'), a.failed_count, round(extract(epoch FROM now()-a.last_archived_time)::numeric,1), (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready') FROM pg_stat_archiver a" | tr -d '\n'; echo ",$(repo_bytes)"; sleep 15; done; }
settarget() { local name=$1 mt=$(marker_target); echo -e "$name\t${mt%%|*}\t${mt##*|}\t$(date -u +%FT%TZ)" >> $TGT; echo "TARGET $name id=${mt%%|*} at=${mt##*|}"; }
: > $LOGS/archiver.csv
mon >> $LOGS/archiver.csv & MONPID=$!
rm -f $MARKLOG; marker_up
runuser -u postgres -- nice pgbench -c 8 -j 4 -R ${RATE:-500} -T ${LOADSECS:-1500} -P 5 -p 55417 app > $LOGS/pgbench-a2.log 2>&1 &
PGBPID=$!
echo "load started $(date -u +%T): rate ${RATE:-500} tps, 1 Hz marker"
sleep 90
settarget T0-idle-load
bk incremental;  settarget T1-after-incr
sleep 45
bk differential; settarget T2-after-diff
sleep 45
bk full;         settarget T3-after-full2
sleep 60
settarget T4-load-plus-60s
sleep 30
echo "stopping load"
kill -INT $PGBPID 2>/dev/null; wait $PGBPID 2>/dev/null
marker_down
last=$(tail -1 $MARKLOG); echo "LAST MARKER $last"
echo "FINAL marker id=${last%%|*}" >> $TGT.final
echo "tpcb sums at end: $(tpcb_ok)"
archive_catchup
kill $MONPID 2>/dev/null
note "load.a2" "rate=${RATE:-500} tps secs=${LOADSECS:-1500}" "" "" "pgbench log $LOGS/pgbench-a2.log"
$PGB info | head -40
echo "repo bytes: $(repo_bytes)"
echo A2-DONE
