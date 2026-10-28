source /root/lab/lab.env; source /root/lab/lib.sh
exec > >(tee $LOGS/t8b-restic-runbook.log) 2>&1
RR=/var/lib/restic-repo; PW=/var/lib/c35/restic.pw
cat > /root/exdb/apps/server/zz-gen-runbook.ts <<'TS'
import { generateRunbook } from "/root/exdb/packages/backups/src/runbook.ts"
import { writeFileSync } from 'node:fs'
const r = generateRunbook({ repositoryId: 'bkr_01M70000000000000000000002', revision: 1, clusterId: 'cls_01M70000000000000000000009', engine: 'restic', provider: 'posix', endpointHost: null, region: null, bucket: null, prefix: 'var/lib/restic-repo', stanza: null, repoIndex: null, cipher: 'restic', pinnedEngineVersion: null, postgresMajor: 17 })
writeFileSync('/var/lib/c35/recover-restic.sh', r.script, { mode: 0o755 })
console.log(r.digest, r.placeholders.map((p) => p.name).join(','))
TS
(cd /root/exdb/apps/server && bun zz-gen-runbook.ts)
echo "=== populate the restic repository the way the helper's logical run would (pg_dump per database + globals), as postgres, outside the sandbox"
ROWS=$(psqlx "SELECT count(*) FROM accounts"); echo "source accounts=$ROWS"
psqlx "DO \$\$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='appowner') THEN CREATE ROLE appowner NOLOGIN; END IF; END \$\$" >/dev/null
runuser -u postgres -- sh -c "rm -rf /var/lib/c35/dump && mkdir -p /var/lib/c35/dump && /usr/lib/postgresql/17/bin/pg_dump -Fc -h /var/run/postgresql -p 55417 -d app -f /var/lib/c35/dump/app.dump && /usr/lib/postgresql/17/bin/pg_dumpall --globals-only --no-role-passwords -h /var/run/postgresql -p 55417 -f /var/lib/c35/dump/globals.sql && restic backup --no-cache --repo $RR --password-file $PW --tag exponetdb --json /var/lib/c35/dump | tail -1 | cut -c1-200"
grep -c "CREATE ROLE" /var/lib/c35/dump/globals.sql
RB() { runuser -u postgres -- env TARGET_DIR=$1 PG_BIN=/usr/lib/postgresql/17/bin PORT=${PORT:-55442} RESTIC_PASSWORD_FILE=${PASSF:-$PW} ${SNAPSHOT:+SNAPSHOT=$SNAPSHOT} sh /var/lib/c35/recover-restic.sh; }
echo "=== 1. restic runbook into an empty TARGET_DIR"
T0=$(ts); RB /var/lib/c35/restic-restore 2>&1 | tail -12 | cut -c1-230; echo "rc=${PIPESTATUS[0]} duration=$(echo "$(ts) - $T0"|bc)s"
SOCK=/var/lib/c35/restic-restore.exponetdb/socket
echo "restored accounts: $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d app -c 'SELECT count(*) FROM accounts') (source $ROWS); big: $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d app -c 'SELECT count(*) FROM big')"
echo "roles in the restored cluster (globals applied?): $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d postgres -c "SELECT coalesce(string_agg(rolname, ',' ORDER BY rolname),'(none)') FROM pg_roles WHERE rolname !~ '^pg_' AND rolname <> 'postgres'")"
echo "table owner in restored app: $(runuser -u postgres -- psql -X -A -t -h $SOCK -p 55442 -d app -c "SELECT tableowner FROM pg_tables WHERE tablename='accounts'")  (source: $(psqlx "SELECT tableowner FROM pg_tables WHERE tablename='accounts'"))"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/restic-restore stop -m fast 2>&1 | tail -1
echo "=== 2. missing globals: a snapshot holding only app.dump"
runuser -u postgres -- sh -c "rm -rf /var/lib/c35/noglobals && mkdir -p /var/lib/c35/noglobals && cp /var/lib/c35/dump/app.dump /var/lib/c35/noglobals/ && restic backup --no-cache --repo $RR --password-file $PW --tag exponetdb /var/lib/c35/noglobals | tail -1"
NOG=$(runuser -u postgres -- restic snapshots --no-cache --repo $RR --password-file $PW --json | jq -r '.[-1].id')
SNAPSHOT=$NOG PORT=55443 RB /var/lib/c35/restic-noglobals 2>&1 | tail -6 | cut -c1-230; echo "rc=${PIPESTATUS[0]}  (M-5 expects: the runbook stops on a missing globals file)"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/restic-noglobals stop -m fast 2>&1 | tail -1
echo "=== 3. restore role"
env TARGET_DIR=/var/lib/c35/restic-root PG_BIN=/usr/lib/postgresql/17/bin PORT=55444 RESTIC_PASSWORD_FILE=$PW sh /var/lib/c35/recover-restic.sh 2>&1 | tail -3 | cut -c1-230; echo "rc=${PIPESTATUS[0]} as root (over-privileged)"
runuser -u nobody -- env TARGET_DIR=/var/lib/c35/restic-nobody PG_BIN=/usr/lib/postgresql/17/bin RESTIC_PASSWORD_FILE=$PW sh /var/lib/c35/recover-restic.sh 2>&1 | tail -3 | cut -c1-230; echo "rc=${PIPESTATUS[0]} as nobody (under-privileged)"
echo "=== 4. wrong restic password"; printf wrong > /var/lib/c35/badrestic; chown postgres: /var/lib/c35/badrestic
PASSF=/var/lib/c35/badrestic PORT=55445 RB /var/lib/c35/restic-badpw 2>&1 | tail -3 | cut -c1-200; echo "rc=${PIPESTATUS[0]}"; ls -A /var/lib/c35/restic-badpw 2>&1 | head -2
echo "=== 5. non-empty TARGET_DIR"; RB /var/lib/c35/restic-restore 2>&1 | tail -2; echo "rc=${PIPESTATUS[0]}"
pgrep -fa "postgres -D /var/lib/c35" | cut -c1-120 || true
