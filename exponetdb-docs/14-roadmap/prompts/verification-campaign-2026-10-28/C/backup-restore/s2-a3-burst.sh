# Phase A3: unthrottled pgbench for LOADSECS (default 180) with archiver sampling every 5 s: WAL rate, archiver lag, .ready backlog
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/a3-burst.log) 2>&1
SECS=${LOADSECS:-180}
: > $LOGS/archiver-burst.csv
( while :; do runuser -u postgres -- psql -X -q -A -t -F, -p 55417 -d postgres -c "SELECT to_char(now() AT TIME ZONE 'UTC','HH24:MI:SS'), pg_current_wal_lsn(), a.archived_count, a.last_archived_wal, round(extract(epoch FROM now()-a.last_archived_time)::numeric,1), a.failed_count, (SELECT count(*) FROM pg_ls_archive_statusdir() WHERE name LIKE '%.ready'), (SELECT count(*) FROM pg_ls_waldir())" | tr -d '\n' >> $LOGS/archiver-burst.csv; echo ",$(repo_bytes)" >> $LOGS/archiver-burst.csv; sleep 5; done ) & MON=$!
LSN0=$(psqlx "SELECT pg_current_wal_lsn()"); T0=$(ts)
runuser -u postgres -- nice pgbench -n -c 8 -j 4 -T $SECS -P 10 -p 55417 app 2>&1 | tail -25 | tee $LOGS/pgbench-a3.log
LSN1=$(psqlx "SELECT pg_current_wal_lsn()"); T1=$(ts)
bytes=$(psqlx "SELECT pg_wal_lsn_diff('$LSN1','$LSN0')::bigint")
echo "WAL generated: $bytes bytes in $(echo "$T1 - $T0"|bc)s = $(echo "$bytes / ($T1 - $T0) / 1048576"|bc -l | cut -c1-6) MiB/s"
archive_catchup
kill $MON 2>/dev/null
note "wal.burst" "unthrottled pgbench -c8 ${SECS}s" "$(echo "$T1 - $T0"|bc)" "$bytes" "see archiver-burst.csv"
python3 - <<PY
rows=[l.strip().split(",") for l in open("$LOGS/archiver-burst.csv") if l.count(",")>=7]
print("samples",len(rows),"max lag s",max(float(r[4]) for r in rows),"max .ready backlog",max(int(r[6]) for r in rows),"max pg_wal files",max(int(r[7]) for r in rows),"failed_count",rows[-1][5],"archived",rows[0][2],"->",rows[-1][2],"repo bytes",rows[0][-1],"->",rows[-1][-1])
PY
echo A3-DONE
