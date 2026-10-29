#!/usr/bin/env bash
# Disaster and point-in-time restore of the PG17 cluster in place (same data directory, same port, so the registry's endpoint stays valid).
# usage: restore_pitr.sh BASEBACKUP_DIR "TARGET_TIME"|latest      prints RTO milestones; the old directory is kept as <dir>.lost
source /srv/work/s5/rehearsal/rh-lib.sh
BASE="${1:?base backup dir}"; TT="${2:?target time or latest}"
DATA=/var/lib/postgresql/17/exs5; UNIT=postgresql@17-exs5.service; ARCH=/srv/work/s5/walarchive
ts() { date -u +%FT%T.%3NZ; }
pkill -f '[m]arker_writer' ; pkill -f '[p]gbench.*lab_rhstg'; sleep 1
echo "last marker before the disaster: $(tail -1 $L/marker.log)"
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select count(*) filter (where kind='rh-marker'), max(id) from public.events_log" > $L/pre-disaster-counts
T0=$(ts); echo "T0 decision (cluster stopped)    $T0"
systemctl stop $UNIT
rm -rf "$DATA.lost"; mv "$DATA" "$DATA.lost"
T1=$(ts); echo "T1 old directory moved away      $T1"
cp -a "$BASE" "$DATA"
T2=$(ts); echo "T2 base backup copied back       $T2"
touch "$DATA/recovery.signal"
{
  echo "restore_command = 'cp $ARCH/%f %p'"
  if [ "$TT" != latest ]; then echo "recovery_target_time = '$TT'"; echo "recovery_target_inclusive = on"; fi
  echo "recovery_target_action = 'promote'"
} >> "$DATA/postgresql.auto.conf"
systemctl start $UNIT
T3=$(ts); echo "T3 started (recovery running)    $T3"
for i in $(seq 1 600); do
  r=$(runuser -u postgres -- psql -X -Atq -p 55417 -d postgres -c "select pg_is_in_recovery()" 2>/dev/null) && [ "$r" = f ] && break
  sleep 0.5
done
T4=$(ts); echo "T4 accepting connections, promoted $T4"
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select count(*) filter (where kind='rh-marker'), max(id) from public.events_log" > $L/post-restore-counts
runuser -u postgres -- psql -X -Atq -p 55417 -d lab_rhstg -c "select 'last recovered marker: '||id||' '||to_char(max(payload->>'t')::timestamptz,'HH24:MI:SS.US') from public.events_log where kind='rh-marker' group by id order by id desc limit 1"
echo "pre-disaster counts (markers, max id): $(cat $L/pre-disaster-counts); restored: $(cat $L/post-restore-counts)"
echo "timeline of the restored cluster: $(runuser -u postgres -- psql -X -Atq -p 55417 -d postgres -c 'select timeline_id from pg_control_checkpoint()')"
echo "RTO database: stop->accepting = $(echo "$(date -d $T4 +%s.%N) - $(date -d $T0 +%s.%N)" | bc) s (copy $(echo "$(date -d $T2 +%s.%N) - $(date -d $T1 +%s.%N)" | bc) s, recovery $(echo "$(date -d $T4 +%s.%N) - $(date -d $T3 +%s.%N)" | bc) s)"
printf 'restore-pitr\t%s\t%s\t%.1f\t0\n' "$T0" "$T4" "$(echo "$(date -d $T4 +%s.%N) - $(date -d $T0 +%s.%N)" | bc)" >> "$TIMINGS"
