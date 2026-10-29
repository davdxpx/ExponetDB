#!/bin/bash
# Phase 8: image job again (BuildKit now installed on the VM), Go job again as a non-root user (as the CI runner is)
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
source /srv/work/env.sh
docker rm -f $(docker ps -aq --filter name=lab) >/dev/null 2>&1
nice $S n-image-build2 $N docker build --build-arg EXPONETDB_BUILD_COMMIT=d51da5d0d8832ebc569f23985c7e5176e4d450ad -t exponetdb:ci .
$S n-image-user2 $N bash -c 'test "$(docker image inspect exponetdb:ci --format "{{.Config.User}}")" = node'
nice $S n-image-roles2 $N bash tooling/smoke/roles.sh exponetdb:ci
EXDB_LAB_IMAGE=exponetdb:ci nice $S n-cli-lab2 $N bun run --cwd apps/cli test:lab
nice $S n-quickstart2 $N bash -c 'bun run --cwd apps/cli pack && prefix=/srv/work/exdb-cli2 && rm -rf $prefix && npm install --global --offline --no-audit --no-fund --prefix $prefix apps/cli/dist/artifacts/exponetdb-cli-*.tgz && EXDB_CLI_BIN=$prefix/bin/exponetdb EXDB_LAB_IMAGE=exponetdb:ci bun run --cwd apps/server test:lab'
# --- Go job as a non-root user (uid != 0), like the GitHub runner
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
rm -rf /home/runner/new /home/runner/rt
runuser -u runner -- git clone -q /srv/work/new /home/runner/new
runuser -u runner -- git -C /home/runner/new checkout -q --detach d51da5d0d8832ebc569f23985c7e5176e4d450ad
G=/home/runner/new/agent/node
R="runuser -u runner --"
nice $S n-gor-gofmt $G $R bash -c 'u="$(gofmt -l .)"; echo "[$u]"; test -z "$u"'
nice $S n-gor-vet $G $R bash -c 'go vet ./... && go vet -tags e2e ./cmd/... && go vet -tags pgit ./... && go vet -tags pglab ./... && go test -tags e2e -run E2E ./cmd/exponetdb-node'
nice $S n-gor-race $G $R go test -race -count=1 ./...
nice $S n-gor-fuzz $G $R bash -c 'go test -run=NONE -fuzz=FuzzOpen -fuzztime=20s ./internal/journal && go test -run=NONE -fuzz=FuzzHandle -fuzztime=20s ./internal/helper && go test -run=NONE -fuzz=FuzzReadFrame -fuzztime=10s ./internal/helper && go test -run=NONE -fuzz=FuzzSpliceHba -fuzztime=15s ./internal/pgfiles'
nice $S n-gor-govulncheck $G $R go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...
nice $S n-gor-release $G $R bash -c 'rm -rf /home/runner/rt/dist; mkdir -p /home/runner/rt; bash packaging/build.sh 0.0.0-ci.1 /home/runner/rt/dist && /home/runner/rt/dist/exponetdb-node-0.0.0-ci.1-linux-amd64 version && /home/runner/rt/dist/exponetdb-node-helper-0.0.0-ci.1-linux-amd64 version && bash packaging/verify-units.sh'
echo done-phase8 >> /srv/work/logs/summary.txt
