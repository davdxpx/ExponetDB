export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
bash /srv/work/r2/scripts/teardown.sh
echo "### TC-026 again on a clean machine state: the backup-lab job's first command, full output kept"
(cd /srv/work/r2/new/agent/node && go test -tags pglab -count=1 -run TestPglab -v ./internal/helper > /srv/work/r2/logs/pglab2.full 2>&1; echo "go test rc=$?"; grep -aE "^(=== RUN|--- |\s+--- |ok|FAIL|PASS)|pglab_test.go.*(error|fail|expected)" /srv/work/r2/logs/pglab2.full | head -30)
