#!/usr/bin/env bash
cd /srv/work/s6-infra/s6
while ! grep -q "chain3 finished" /srv/work/logs-s6/chain3.log 2>/dev/null; do sleep 5; done
for s in gl-mcp kt-rb13; do
  echo "$(date -u +%T) start $s" >>/srv/work/logs-s6/chain4.log
  bash $s.sh >/dev/null 2>&1 </dev/null
  echo "$(date -u +%T) done $s rc=$?" >>/srv/work/logs-s6/chain4.log
  sleep 5
done
echo "$(date -u +%T) chain4 finished" >>/srv/work/logs-s6/chain4.log
