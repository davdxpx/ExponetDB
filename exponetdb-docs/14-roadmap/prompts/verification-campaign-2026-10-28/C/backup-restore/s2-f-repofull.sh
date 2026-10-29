# Phase F1: repository full. A new empty repository on a 1.7 GB loop filesystem becomes repo1 (the main repository is untouched, configuration restored at the end).
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/f1-repofull.log) 2>&1
IMG=/srv/work/s2/loop-repo.img; MNT=/mnt/s2repo; CONF=/etc/pgbackrest/pgbackrest.conf
mode owned; bind
cp -p $CONF /srv/work/s2/xfer/saved-pgbackrest.conf
rm -f $IMG; truncate -s 1700M $IMG; mkfs.ext4 -q -F -m 0 $IMG; mkdir -p $MNT; mount -o loop $IMG $MNT; mkdir $MNT/repo; chown postgres:postgres $MNT/repo; chmod 750 $MNT/repo
echo "loop filesystem: $(df -h $MNT | tail -1)"
sed -i "s#^repo1-path=.*#repo1-path=$MNT/repo#" $CONF
systemctl stop exponetdb-node-helper.service; runuser -u postgres -- pgbackrest --stanza=exdbnode stanza-create 2>&1 | tail -1
runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1
bk full
echo "after full: $(df -h $MNT | tail -1)"
# WAL pressure: a short pgbench so that WAL keeps coming
runuser -u postgres -- nice pgbench -n -c 4 -j 2 -R 400 -T 240 -p 55417 app > $LOGS/pgbench-f1.log 2>&1 &
sleep 20
echo "== incremental into a repository that cannot hold it (files changed by pgbench ~1 GB compressed)"
BKMAX=900 bk incremental
echo "run result excerpt:"; jq -r .result.excerpt $LOGS/bk-$LASTRUN.result.json | tail -6 | cut -c1-260
echo "after failed incremental: $(df -h $MNT | tail -1)"
ls -la $MNT/repo/backup/exdbnode | head
echo "== archive state now"
DB=postgres psqlx "SELECT 'archived='||archived_count||' failed='||failed_count||' last_failed_wal='||coalesce(last_failed_wal,'-')||' last_failed_time='||coalesce(to_char(last_failed_time AT TIME ZONE 'UTC','HH24:MI:SS'),'-')||' last_archived_wal='||last_archived_wal FROM pg_stat_archiver"
sleep 30
echo "pg_wal files: $(ls /var/lib/postgresql/17/exdbnode/pg_wal | wc -l), .ready backlog: $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready)"
grep -E "archive command failed|could not|No space" /var/log/postgresql/postgresql-17-exdbnode.log | tail -3 | cut -c1-260
echo "pgbackrest check says: $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -2 | tr '\n' '|' | cut -c1-300)"
echo "pgbackrest info says:"; runuser -u postgres -- pgbackrest --stanza=exdbnode info 2>&1 | head -14
note "repofull" "incremental into 1.7 GB loop repo" "" "" "state=$LASTSTATE"
echo "== way forward: grow the filesystem online (truncate + losetup -c + resize2fs); archiving must resume and drain the backlog"
pkill -TERM pgbench; sleep 1
truncate -s 4G $IMG; losetup -c $(losetup -j $IMG | cut -d: -f1); resize2fs $(losetup -j $IMG | cut -d: -f1) 2>&1 | tail -1
for i in $(seq 1 60); do n=$(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready); [ "$n" -le 1 ] && break; sleep 2; done
echo "backlog after growing: $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready) ready; $(DB=postgres psqlx "SELECT 'failed='||failed_count||' last_archived='||last_archived_wal FROM pg_stat_archiver")"
BKMAX=900 bk incremental
echo "== cleanup: configuration back to the main repository"
cp -p /srv/work/s2/xfer/saved-pgbackrest.conf $CONF; sleep 5
runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1
umount $MNT; losetup -D; rm -f $IMG
runuser -u postgres -- pgbackrest --stanza=exdbnode info | grep -E "min/max|full backup" | head -4
echo F1-DONE
