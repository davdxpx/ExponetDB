#!/bin/bash
# Phase 4 on the NEW clone: go job, image job
S=/srv/work/bin/step.sh; N=/srv/work/new; G=$N/agent/node
cd $N
nice $S n-go-gofmt $G bash -c 'u="$(gofmt -l .)"; echo "[$u]"; test -z "$u"'
nice $S n-go-vet $G bash -c 'go vet ./... && go vet -tags e2e ./cmd/... && go vet -tags pgit ./... && go vet -tags pglab ./... && go test -tags e2e -run E2E ./cmd/exponetdb-node'
nice $S n-go-race $G go test -race -count=1 ./...
nice $S n-go-fuzz $G bash -c 'go test -run=NONE -fuzz=FuzzOpen -fuzztime=20s ./internal/journal && go test -run=NONE -fuzz=FuzzHandle -fuzztime=20s ./internal/helper && go test -run=NONE -fuzz=FuzzReadFrame -fuzztime=10s ./internal/helper && go test -run=NONE -fuzz=FuzzSpliceHba -fuzztime=15s ./internal/pgfiles'
nice $S n-go-govulncheck $G go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...
nice $S n-go-release $G bash -c 'rm -rf /srv/work/rt/dist; bash packaging/build.sh 0.0.0-ci.1 /srv/work/rt/dist && /srv/work/rt/dist/exponetdb-node-0.0.0-ci.1-linux-amd64 version && /srv/work/rt/dist/exponetdb-node-helper-0.0.0-ci.1-linux-amd64 version && bash packaging/verify-units.sh'
# image job
nice $S n-image-build $N docker build --build-arg EXPONETDB_BUILD_COMMIT=d51da5d0d8832ebc569f23985c7e5176e4d450ad -t exponetdb:ci .
$S n-image-user $N bash -c 'test "$(docker image inspect exponetdb:ci --format "{{.Config.User}}")" = node'
nice $S n-image-roles $N bash tooling/smoke/roles.sh exponetdb:ci
EXDB_LAB_IMAGE=exponetdb:ci nice $S n-cli-lab $N bun run --cwd apps/cli test:lab
nice $S n-quickstart $N bash -c 'bun run --cwd apps/cli pack && prefix=/srv/work/exdb-cli2 && rm -rf $prefix && npm install --global --offline --no-audit --no-fund --prefix $prefix apps/cli/dist/artifacts/exponetdb-cli-*.tgz && EXDB_CLI_BIN=$prefix/bin/exponetdb EXDB_LAB_IMAGE=exponetdb:ci bun run --cwd apps/server test:lab'
echo done-phase4 >> /srv/work/logs/summary.txt
