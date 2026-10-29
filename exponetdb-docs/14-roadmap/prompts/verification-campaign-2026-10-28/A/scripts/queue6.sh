#!/bin/bash
# Phase 6: OLD clone (d0229550): install, unit, integration (counts old vs new)
S=/srv/work/bin/step.sh; O=/srv/work/old
cd $O
printf '.vr-*.json\n.exdb-dev-*\n' >> .git/info/exclude
nice $S o-install $O bun install --frozen-lockfile
TURBO_FORCE=true nice $S o-unit $O bun run test --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-unit-old.json
bash /srv/work/bin/infra-up.sh > /srv/work/logs/infra-up-old.log 2>&1
source /srv/work/infra.env
TURBO_FORCE=true nice $S o-int $O bunx turbo run test:integration --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-int-old.json
echo done-phase6 >> /srv/work/logs/summary.txt
