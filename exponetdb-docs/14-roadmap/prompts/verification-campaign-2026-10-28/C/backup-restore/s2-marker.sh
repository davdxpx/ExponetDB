# runs as postgres: one marker row per second; logs "id|dbts|client_return_time_utc"
LOG=/srv/work/s2/logs/marker.log
while :; do
  r=$(psql -X -q -A -t -p 55417 -d app -c "INSERT INTO marker(note) VALUES ('w') RETURNING id, to_char(ts AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS.US')" 2>/dev/null)
  rc=$?
  [ $rc -eq 0 ] && [ -n "$r" ] && echo "${r%%|*}|${r##*|}|$(date -u +%Y-%m-%dT%H:%M:%S.%6NZ)" >> $LOG
  sleep 1
done
