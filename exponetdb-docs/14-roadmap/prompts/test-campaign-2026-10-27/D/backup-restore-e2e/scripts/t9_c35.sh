source /root/lab/lib.sh
exec > >(tee $LOGS/t9-c35-offline.log) 2>&1
echo "control plane stopped: control store container=$(docker ps --filter name=exdb-pg17 --format '{{.Status}}' | head -1) (empty = stopped); agent/helper units: $(systemctl list-units 'exdb-host-*' --no-legend | wc -l) running"
psqlx "SELECT pg_switch_wal()" >/dev/null; sleep 1; for i in 1 2 3 4 5; do runuser -u postgres -- pgbackrest --stanza=exdbnode check >/dev/null 2>&1 && break; sleep 2; done
ROWS=$(psqlx "SELECT count(*) FROM accounts"); LSN=$(psqlx "SELECT pg_current_wal_lsn()"); echo "source: accounts=$ROWS current_lsn=$LSN archive: $(runuser -u postgres -- pgbackrest --stanza=exdbnode info | grep 'wal archive min/max')"
install -d -m0755 /var/lib/c35; install -m0755 /root/lab/recover.sh /var/lib/c35/recover.sh
install -m0600 -o postgres -g postgres /root/lab/cipher.pass /var/lib/c35/pass
printf 'wrongwrongwrongwrongwrongwrongwrongwrong' > /var/lib/c35/badpass; chown postgres: /var/lib/c35/badpass; chmod 600 /var/lib/c35/badpass
chown postgres: /var/lib/c35
RB() { runuser -u postgres -- env TARGET_DIR=$1 PG_BIN=/usr/lib/postgresql/17/bin PORT=${PORT:-55440} CIPHER_PASS_FILE=${PASSF:-/var/lib/c35/pass} $2 sh /var/lib/c35/recover.sh; }
echo "=== 1. wrong passphrase file"
PASSF=/var/lib/c35/badpass RB /var/lib/c35/restore-bad 2>&1 | tail -4 | cut -c1-250; echo "rc=${PIPESTATUS[0]}; target after: $(ls -A /var/lib/c35/restore-bad 2>&1 | head -3 | tr '\n' ' ')"
rm -rf /var/lib/c35/restore-bad /var/lib/c35/restore-bad.exponetdb
echo "=== 2. run into an empty directory (TARGET_DIR absent)"
T0=$(ts); RB /var/lib/c35/restore 2>&1 | tail -25 | cut -c1-250; echo "rc=${PIPESTATUS[0]} duration=$(echo "$(ts) - $T0"|bc)s"
echo "=== cluster up? replayed everything?"
SOCK=/var/lib/c35/restore.exponetdb/socket
runuser -u postgres -- psql -X -A -t -h $SOCK -p 55440 -d app -c "SELECT 'accounts='||count(*)||' big='||(SELECT count(*) FROM big) FROM accounts"
runuser -u postgres -- psql -X -A -t -h $SOCK -p 55440 -d postgres -c "SELECT 'in_recovery='||pg_is_in_recovery(), pg_last_wal_replay_lsn()"
echo "source accounts=$ROWS (must equal)"
echo "=== 3. non-empty TARGET_DIR is refused (the restored one)"
RB /var/lib/c35/restore 2>&1 | tail -3; echo "rc=${PIPESTATUS[0]}"
echo "=== 4. TARGET_DIR existing but empty is accepted? (and CONF_DIR reuse refused)"
install -d -o postgres -g postgres -m0700 /var/lib/c35/empty; PORT=55441 RB /var/lib/c35/empty 2>&1 | tail -3 | cut -c1-200; echo "rc=${PIPESTATUS[0]}"
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/empty stop -m fast 2>&1 | tail -1
echo "=== runbook file/log hygiene"
ls -la /var/lib/c35/restore.exponetdb; grep -c . /var/lib/c35/restore.exponetdb/restore.log; grep -rl "$(cat /root/lab/cipher.pass)" /var/lib/c35/restore.exponetdb 2>/dev/null | head -3 || true
stat -c '%U:%G %a %n' /var/lib/c35/restore /var/lib/c35/restore.exponetdb
ps -eo user,args | grep -E "[p]ostgres -D /var/lib/c35" | cut -c1-200
runuser -u postgres -- /usr/lib/postgresql/17/bin/pg_ctl -D /var/lib/c35/restore stop -m fast 2>&1 | tail -1
