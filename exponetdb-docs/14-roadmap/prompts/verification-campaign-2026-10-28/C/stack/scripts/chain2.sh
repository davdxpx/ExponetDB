#!/usr/bin/env bash
cd /srv/work/s6-infra/s6
while ! grep -q "chain1 finished" /srv/work/logs-s6/chain1.log; do sleep 5; done
for s in ka1 obs-seed2 kt-gw obs-read; do
  echo "$(date -u +%T) start $s" >>/srv/work/logs-s6/chain2.log
  bash $s.sh >/dev/null 2>&1 </dev/null
  echo "$(date -u +%T) done $s rc=$?" >>/srv/work/logs-s6/chain2.log
  sleep 5
done
echo "$(date -u +%T) chain2 finished" >>/srv/work/logs-s6/chain2.log
