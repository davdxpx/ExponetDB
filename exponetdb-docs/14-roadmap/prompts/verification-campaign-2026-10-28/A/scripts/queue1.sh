#!/bin/bash
# Phase 1 on the NEW clone: static checks, typecheck, chromium, unit run 1, build, conformance, check scripts
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
printf '.vr-*.json\n.exdb-dev-*\n' >> .git/info/exclude
nice $S n-biome $N bunx biome ci .
nice $S n-typecheck $N bun run typecheck --concurrency=2
nice $S n-chromium $N node apps/server/node_modules/playwright-core/cli.js install --with-deps chromium
TURBO_FORCE=true nice $S n-unit-run1 $N bun run test --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-unit-run1.json
nice $S n-build $N bun run build --concurrency=2
echo done-phase1 >> /srv/work/logs/summary.txt
