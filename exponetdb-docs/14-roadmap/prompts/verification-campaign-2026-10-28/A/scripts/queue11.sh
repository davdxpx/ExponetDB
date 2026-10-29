#!/bin/bash
# Phase 11 (extra, informational): shuffle files AND tests within files, seed 20261029
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
SEQ="--sequence.shuffle.files --sequence.shuffle.tests --sequence.seed=20261029"
TURBO_FORCE=true nice $S n-unit-run3 $N bun run test --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-unit-run3.json $SEQ
bash /srv/work/bin/infra-up.sh > /srv/work/logs/infra-up-run3.log 2>&1
source /srv/work/infra.env
TURBO_FORCE=true nice $S n-int-run3 $N bunx turbo run test:integration --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-int-run3.json $SEQ
echo done-phase11 >> /srv/work/logs/summary.txt
