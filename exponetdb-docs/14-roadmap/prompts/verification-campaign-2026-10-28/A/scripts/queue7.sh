#!/bin/bash
# Phase 7: NEW clone, shuffled file order (seed 20261028): unit run 2, integration run 2
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
SEQ="--sequence.shuffle.files --sequence.seed=20261028"
TURBO_FORCE=true nice $S n-unit-run2 $N bun run test --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-unit-run2.json $SEQ
bash /srv/work/bin/infra-up.sh > /srv/work/logs/infra-up-run2.log 2>&1
source /srv/work/infra.env
TURBO_FORCE=true nice $S n-int-run2 $N bunx turbo run test:integration --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-int-run2.json $SEQ
echo done-phase7 >> /srv/work/logs/summary.txt
