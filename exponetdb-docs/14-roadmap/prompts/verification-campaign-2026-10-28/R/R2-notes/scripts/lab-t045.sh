# TC-045: the restic runbook against a snapshot with and without globals.sql (first campaign t8b, trimmed)
source /root/lab/lab.env; source /root/lab/lib.sh
export PATH=$PATH:/usr/local/go/bin:/usr/local/bin
RR=/var/lib/restic-repo-r2; PW=/var/lib/c35/restic.pw
install -d -m0755 -o postgres -g postgres /var/lib/c35; rm -rf $RR /var/lib/c35/dump /var/lib/c35/noglobals /var/lib/c35/restic-restore /var/lib/c35/restic-noglobals
head -c 16 /dev/urandom | od -An -tx1 | tr -d ' \n' > $PW; chown postgres: $PW; chmod 600 $PW
install -d -m0700 -o postgres -g postgres $RR
cd /
runuser -u postgres -- restic init --no-cache --repo $RR --password-file $PW | tail -1
cat > /srv/work/r2/gen-runbook.ts <<'TS'
import { generateRunbook } from "/srv/work/r2/new/packages/backups/src/runbook.ts"
import { writeFileSync } from 'node:fs'
const r = generateRunbook({ repositoryId: 'bkr_01M70000000000000000000002', revision: 1, clusterId: 'cls_01M70000000000000000000009', engine: 'restic', provider: 'posix', endpointHost: null, region: null, bucket: null, prefix: 'var/lib/restic-repo-r2', stanza: null, repoIndex: null, cipher: 'restic', pinnedEngineVersion: null, postgresMajor: 17 })
writeFileSync('/var/lib/c35/recover-restic.sh', r.script, { mode: 0o755 })
console.log('digest', r.digest)
TS
(cd /srv/work/r2/new/apps/server && bun /srv/work/r2/gen-runbook.ts)
psqlx "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='appowner') THEN CREATE ROLE appowner NOLOGIN; END IF; IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='reader') THEN CREATE ROLE reader LOGIN; END IF; END \$\$" >/dev/null
psqlx "GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader" >/dev/null
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "source accounts=$ROWS"
runuser -u postgres -- sh -c "mkdir -p /var/lib/c35/dump && /usr/lib/postgresql/17/bin/pg_dump -Fc -h /var/run/postgresql -p 55417 -d app -f /var/lib/c35/dump/app.dump && /usr/lib/postgresql/17/bin/pg_dumpall --globals-only --no-role-passwords -h /var/run/postgresql -p 55417 -f /var/lib/c35/dump/globals.sql && restic backup --no-cache --repo $RR --password-file $PW --tag exponetdb /var/lib/c35/dump | tail -1 | cut -c1-120"
echo "CREATE ROLE statements in globals.sql: $(grep -c 'CREATE ROLE' /var/lib/c35/dump/globals.sql)"
RB() { runuser -u postgres -- env TARGET_DIR=$1 PG_BIN=/usr/lib/postgresql/17/bin PORT=${PORT:-55442} RESTIC_PASSWORD_FILE=$PW ${SNAPSHOT:+SNAPSHOT=$SNAPSHOT} sh /var/lib/c35/recover-restic.sh; }
echo "=== 1. restic runbook, snapshot with globals.sql"
RB /var/lib/c35/restic-restore 2>&1 | tail -8 | cut -c1-230; echo "rc=${PIPESTATUS[0]}"
SOCK=/var/lib/c35/restic-restore.exponetdb/socket
echo "restored accounts: $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d app -c 'SELECT count(*) FROM accounts' 2>&1 | tail -1) (source $ROWS)"
echo "roles in the restored cluster: $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d postgres -c "SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname),'(none)') FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'" 2>&1 | tail -1)  (source has appowner, reader)"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/restic-restore stop -m fast 2>&1 | tail -1
echo "=== 2. a snapshot holding only app.dump (no globals.sql): does the runbook stop?"
runuser -u postgres -- sh -c "rm -rf /var/lib/c35/noglobals && mkdir -p /var/lib/c35/noglobals && cp /var/lib/c35/dump/app.dump /var/lib/c35/noglobals/ && restic backup --no-cache --repo $RR --password-file $PW --tag exponetdb /var/lib/c35/noglobals | tail -1 | cut -c1-100"
NOG=$(runuser -u postgres -- restic snapshots --no-cache --repo $RR --password-file $PW --json | jq -r '.[-1].id')
SNAPSHOT=$NOG PORT=55443 RB /var/lib/c35/restic-noglobals 2>&1 | tail -6 | cut -c1-230; echo "rc=${PIPESTATUS[0]}  (M-5 expects: the runbook stops on a missing globals file)"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/restic-noglobals stop -m fast 2>&1 | tail -1
echo T045-DONE
