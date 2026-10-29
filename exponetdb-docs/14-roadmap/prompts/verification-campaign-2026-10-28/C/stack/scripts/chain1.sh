#!/usr/bin/env bash
# runs the independent stack tests one after the other (each writes its own log in /srv/work/logs-s6)
cd /srv/work/s6-infra/s6
for s in fc9b ka1 kr obs-seed obs-crash gl-sigterm gl-limits gl-mcp i11 fc3b kt0 kt1; do
  f=$s.sh; [ "$s" = kr ] && f=kr.sh; [ "$s" = obs-crash ] && f=obs-crash.sh
  echo "$(date -u +%T) start $s" >>/srv/work/logs-s6/chain1.log
  bash $f >/dev/null 2>&1 </dev/null
  echo "$(date -u +%T) done $s rc=$?" >>/srv/work/logs-s6/chain1.log
  sleep 5
done
echo "$(date -u +%T) chain1 finished" >>/srv/work/logs-s6/chain1.log
