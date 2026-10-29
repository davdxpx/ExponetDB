#!/bin/bash
# Phase 9: Go job again as a non-root user (uid != 0), like the GitHub runner
S=/srv/work/bin/step.sh; N=/srv/work/new
cd $N
source /srv/work/env.sh
# --- backup-lab pglab again: the helper runs /usr/bin/restic (the CI job installs the distribution package there); the VM has the pinned binary in /usr/local/bin
ln -sf /usr/local/bin/restic /usr/bin/restic
nice $S n-backuplab-pglab2 $N/agent/node go test -tags pglab -count=1 -run TestPglab -v ./internal/helper
# --- Go job as a non-root user (uid != 0), like the GitHub runner
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
rm -rf /home/runner/new /home/runner/rt
git -c safe.directory='*' clone -q /srv/work/new /home/runner/new && git -C /home/runner/new -c safe.directory='*' checkout -q --detach d51da5d0d8832ebc569f23985c7e5176e4d450ad && chown -R runner:runner /home/runner/new
G=/home/runner/new/agent/node
R="runuser -u runner --"
nice $S n-gor-gofmt $G $R bash -c 'u="$(gofmt -l .)"; echo "[$u]"; test -z "$u"'
nice $S n-gor-vet $G $R bash -c 'go vet ./... && go vet -tags e2e ./cmd/... && go vet -tags pgit ./... && go vet -tags pglab ./... && go test -tags e2e -run E2E ./cmd/exponetdb-node'
nice $S n-gor-race $G $R go test -race -count=1 ./...
nice $S n-gor-fuzz $G $R bash -c 'go test -run=NONE -fuzz=FuzzOpen -fuzztime=20s ./internal/journal && go test -run=NONE -fuzz=FuzzHandle -fuzztime=20s ./internal/helper && go test -run=NONE -fuzz=FuzzReadFrame -fuzztime=10s ./internal/helper && go test -run=NONE -fuzz=FuzzSpliceHba -fuzztime=15s ./internal/pgfiles'
nice $S n-gor-govulncheck $G $R go run golang.org/x/vuln/cmd/govulncheck@v1.1.4 ./...
nice $S n-gor-release $G $R bash -c 'rm -rf /home/runner/rt/dist; mkdir -p /home/runner/rt; bash packaging/build.sh 0.0.0-ci.1 /home/runner/rt/dist && /home/runner/rt/dist/exponetdb-node-0.0.0-ci.1-linux-amd64 version && /home/runner/rt/dist/exponetdb-node-helper-0.0.0-ci.1-linux-amd64 version && bash packaging/verify-units.sh'
echo done-phase9 >> /srv/work/logs/summary.txt
