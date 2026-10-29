# outside stopwatch: samples every 0.5 s whether a restore (pgbackrest restore), a scratch postmaster or a scratch directory exists
SC=/var/lib/exponetdb-node-engine/scratch
: > /srv/work/s2/logs/watch.log
while :; do
  d=$(ls $SC 2>/dev/null | wc -l)
  r=$(pgrep -fc 'pgbackrest.* restore' || true)
  p=$(pgrep -fc "postgres -D $SC" || true)
  v=$(pgrep -fc 'pgbackrest.* verify' || true)
  b=$(pgrep -fc 'pgbackrest.* backup' || true)
  printf '%s dirs=%s restore=%s scratch_pm=%s verify=%s backup=%s\n' "$(date -u +%s.%N)" "$d" "$r" "$p" "$v" "$b" >> /srv/work/s2/logs/watch.log
  sleep 0.5
done
