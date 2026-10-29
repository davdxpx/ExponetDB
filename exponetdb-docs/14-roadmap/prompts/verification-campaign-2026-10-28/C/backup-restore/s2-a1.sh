# Phase A1: archiving on, stanza, FULL backup on an idle 7 GB database (through the shipped helper, mode owned)
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/a1-full.log) 2>&1
set -x
cat > /etc/postgresql/17/exdbnode/conf.d/50-backup.conf <<CONF
archive_mode = on
archive_command = 'pgbackrest --stanza=exdbnode archive-push %p'
archive_timeout = 60
CONF
chown postgres:postgres /etc/postgresql/17/exdbnode/conf.d/50-backup.conf
pg_ctlcluster 17 exdbnode restart; sleep 3
runuser -u postgres -- pgbackrest --stanza=exdbnode stanza-create
runuser -u postgres -- pgbackrest --stanza=exdbnode check
set +x
mode owned; bind
psqlx "SELECT pg_size_pretty(pg_database_size('app')), pg_database_size('app')"
sync; echo 3 > /proc/sys/vm/drop_caches 2>/dev/null || true
bk full
$PGB info | head -20
echo "repo bytes: $(repo_bytes)"
