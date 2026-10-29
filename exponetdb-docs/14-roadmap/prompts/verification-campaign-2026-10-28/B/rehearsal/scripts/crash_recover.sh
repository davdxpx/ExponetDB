#!/usr/bin/env bash
# Unplanned loss of the PG17 primary and recovery from base backup + WAL archive ONLY into a NEW cluster (rs1, port 55517):
# measures the achieved RPO (client-side marker log) and RTO. A bundle is applied ~8 s before the kill, inside the unarchived window.
source /srv/work/s5/rehearsal/rh-lib.sh
cd "$PROJ"
ts() { date -u +%FT%T.%3NZ; }
OLD=postgresql@17-exs5.service; NEWDIR=/var/lib/postgresql/17/rs1; ARCH=/srv/work/s5/walarchive
echo "phase 1: load for ${LOAD_SECONDS:-200} s (marker writer 1/s, pgbench -R 100)"
( cd /tmp; nohup /srv/work/s5/rehearsal/marker_writer.sh 55417 lab_rhstg "$L/marker2.log" >/dev/null 2>&1 < /dev/null & )
( cd /tmp; nohup runuser -u postgres -- /usr/lib/postgresql/18/bin/pgbench -h /var/run/postgresql -p 55417 -n -c 4 -j 1 -R 100 -T $((${LOAD_SECONDS:-200} + 30)) -f "$RH/pgbench_read.sql@8" -f "$RH/pgbench_write.sql@2" lab_rhstg >"$L/pgb-crash.out" 2>&1 < /dev/null & )
sleep "${LOAD_SECONDS:-200}"
E2=$(cat "$L/e2.id")
tm crash-plan-e2 exdb migration plan "$E2" --target lab/platform/rhstg
PL=$(grep -o "pln_[A-Z0-9]*" "$L/crash-plan-e2.log" | head -1)
tm crash-apply-e2 exdb plan apply "$PL" --wait
echo "bundle E2 applied at $(ts); waiting 8 s, then the primary is killed"
sleep 8
D=$(tail -1 "$L/marker2.log"); echo "last marker the client saw commit: $D"
echo "$D" > "$L/crash-last-marker"
T0=$(ts); echo "T0 kill -9 of the primary: $T0"
systemctl kill -s KILL "$OLD"; pkill -f '[m]arker_writer'; pkill -f '[p]gbench.*lab_rhstg'
sleep 1
echo "phase 2: new cluster rs1 from base backup b1 + archive, timeline latest"
pg_createcluster 17 rs1 -p 55517 -d "$NEWDIR" --start-conf=manual >/dev/null 2>&1
systemctl stop postgresql@17-rs1.service 2>/dev/null; rm -rf "$NEWDIR"
T1=$(ts); cp -a /srv/work/s5/base/b1 "$NEWDIR"; T2=$(ts); echo "T1->T2 base backup copied: $T1 -> $T2"
for f in postgresql.conf pg_hba.conf pg_ident.conf server.crt server.key; do sed -e 's/exs5/rs1/g' -e 's/55417/55517/g' /etc/postgresql/17/exs5/$f > /etc/postgresql/17/rs1/$f; done
chown postgres:postgres /etc/postgresql/17/rs1/*; chmod 600 /etc/postgresql/17/rs1/server.key /etc/postgresql/17/rs1/pg_hba.conf
rm -rf /etc/postgresql/17/rs1/conf.d; cp -a /etc/postgresql/17/exs5/conf.d /etc/postgresql/17/rs1/conf.d
cat > "$NEWDIR/postgresql.auto.conf" <<CONF
wal_level = 'logical'
archive_mode = 'off'
shared_preload_libraries = 'pg_stat_statements'
max_wal_senders = '10'
max_replication_slots = '10'
shared_buffers = '1GB'
restore_command = 'cp $ARCH/%f %p'
recovery_target_timeline = 'latest'
recovery_target_action = 'promote'
CONF
touch "$NEWDIR/recovery.signal"; chown -R postgres:postgres "$NEWDIR"
systemctl start postgresql@17-rs1.service
T3=$(ts)
for i in $(seq 1 1200); do r=$(runuser -u postgres -- psql -X -Atq -p 55517 -d postgres -c "select pg_is_in_recovery()" 2>/dev/null) && [ "$r" = f ] && break; sleep 0.5; done
T4=$(ts); echo "T3 started $T3; T4 accepting connections $T4"
LASTREC=$(runuser -u postgres -- psql -X -Atq -p 55517 -d lab_rhstg -c "select id||' '||to_char((payload->>'t')::timestamptz at time zone 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') from public.events_log where kind='rh-marker' order by id desc limit 1")
echo "last recovered marker: $LASTREC"
echo "ledger head of the recovered database: $(runuser -u postgres -- psql -X -Atq -p 55517 -d lab_rhstg -c 'select name from exponetdb.schema_migrations order by applied_seq desc limit 1')"
echo "timeline: $(runuser -u postgres -- psql -X -Atq -p 55517 -d postgres -c 'select timeline_id from pg_control_checkpoint()')"
DT=$(awk '{print $2}' "$L/crash-last-marker"); RT=$(awk '{print $2}' <<<"$LASTREC")
echo "RPO (time between the last marker the client saw commit and the last one recovered): $(echo "$(date -d $DT +%s.%N) - $(date -d $RT +%s.%N)" | bc) s"
echo "markers lost: $(awk -v r=$(awk '{print $1}' <<<"$LASTREC") '$1>r' "$L/marker2.log" | wc -l)"
echo "RTO (kill -> accepting connections on the new cluster): $(echo "$(date -d $T4 +%s.%N) - $(date -d $T0 +%s.%N)" | bc) s"
printf 'crash-recover-rs1\t%s\t%s\t%.1f\t0\n' "$T0" "$T4" "$(echo "$(date -d $T4 +%s.%N) - $(date -d $T0 +%s.%N)" | bc)" >> "$TIMINGS"
