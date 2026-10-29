#!/bin/bash
# Phase 3 on the NEW clone: postgres job (integration run 1, packed CLI), then browser job
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
bash /srv/work/bin/infra-up.sh > /srv/work/logs/infra-up-postgres.log 2>&1
source /srv/work/infra.env
TURBO_FORCE=true nice $S n-int-run1 $N bunx turbo run test:integration --concurrency=2 -- --reporter=default --reporter=json --outputFile.json=.vr-int-run1.json
nice $S n-cli-install $N bun run --cwd apps/cli test:install
prefix=/srv/work/exdb-cli; rm -rf $prefix
nice $S n-cli-process $N bash -c "npm install --global --offline --no-audit --no-fund --prefix $prefix apps/cli/dist/artifacts/exponetdb-cli-*.tgz && cd apps/server && EXDB_CLI_BIN=$prefix/bin/exponetdb bunx vitest run --config vitest.integration.config.ts test/http-migrations.int.test.ts"
# browser job: fresh containers, no S3 (as in the CI job)
bash /srv/work/bin/infra-up.sh > /srv/work/logs/infra-up-browser.log 2>&1
source /srv/work/infra.env
unset EXDB_TEST_S3_ENDPOINT EXDB_TEST_S3_ACCESS_KEY EXDB_TEST_S3_SECRET_KEY
nice $S n-web-build $N bun run --cwd apps/web build
nice $S n-ds-build $N bun run --cwd apps/design-system build
nice $S n-cli-build $N bunx turbo run build --filter=@exponetdb/cli
rm -rf /srv/work/visual-actual
EXDB_VISUAL_BASELINE_SET=ci-ubuntu-24.04 EXDB_VISUAL_ACTUAL_DIR=/srv/work/visual-actual nice $S n-e2e $N bun run --cwd apps/server test:e2e
echo done-phase3 >> /srv/work/logs/summary.txt
