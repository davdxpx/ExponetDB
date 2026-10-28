export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
. /srv/work/r2/ftlib.sh
echo "### TC-026: the backup-lab job's commands, as root, on vc-3 (pgBackRest $(pgbackrest version), $(restic version | head -1), PostgreSQL 17)"
(cd /srv/work/r2/new/agent/node && go test -tags pglab -count=1 -run TestPglab -v ./internal/helper 2>&1 | grep -aE "^(=== RUN|--- |ok|FAIL|PASS)" | head -30)
(cd /srv/work/r2/new && bun run --cwd packages/backups test:lab 2>&1 | sed -e 's/\x1b\[[0-9;]*m//g' | grep -aE "✓|×|Test Files|Tests  |FAIL|Error" | head -12)
echo PGLAB-DONE
