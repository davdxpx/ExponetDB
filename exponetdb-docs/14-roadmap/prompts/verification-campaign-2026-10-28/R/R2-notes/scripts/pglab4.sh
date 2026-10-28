export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
rm -f /usr/bin/restic; cp /usr/local/bin/restic /usr/bin/restic; chmod 0755 /usr/bin/restic
echo "### TC-026: the backup-lab job's commands (restic is a real file at /usr/bin/restic, as the apt package installs it)"
(cd /srv/work/r2/new/agent/node && go test -tags pglab -count=1 -run TestPglab -v ./internal/helper > /srv/work/r2/logs/pglab4.full 2>&1; echo "go test rc=$?"; grep -aE "^(--- |\s+--- |ok|FAIL|PASS)" /srv/work/r2/logs/pglab4.full | head; grep -a "pglab_test.go:7[0-9][0-9]" /srv/work/r2/logs/pglab4.full | cut -c1-220 | head -8)
(cd /srv/work/r2/new && bun run --cwd packages/backups test:lab 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "✓|×|Test Files|Tests  |FAIL|Error" | head -8)
echo PGLAB4-DONE
