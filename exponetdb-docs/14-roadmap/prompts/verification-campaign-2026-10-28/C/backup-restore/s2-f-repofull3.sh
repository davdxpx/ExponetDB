# Phase F1c: the loop repository (1.7 GB at /mnt/s2repo, repo1-path switched, a full and a differential in it, about 130 MB free) is mounted: fill it, observe, repair, clean up
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/f1c-repofull.log) 2>&1
IMG=/srv/work/s2/loop-repo.img; MNT=/mnt/s2repo; CONF=/etc/pgbackrest/pgbackrest.conf
mode owned; bind
echo "repository before: $(df -h $MNT | tail -1 | awk '{print $3" used, "$4" free"}'); $(ls $MNT/repo/backup/exdbnode | tr '\n' ' ')"
pkill pgbench; runuser -u postgres -- nice pgbench -n -c 4 -j 2 -R 300 -T 200 -p 55417 app > $LOGS/pgbench-f1c.log 2>&1 &
echo "== INCREMENTAL into the space that is left"
BKMAX=600 bk incremental
echo "run result: state=$LASTSTATE"
jq -c '.result|{state,exitCode,startedAt,finishedAt}' $LOGS/bk-$LASTRUN.result.json
jq -r .result.excerpt $LOGS/bk-$LASTRUN.result.json | grep -E "ERROR|No space|space|WARN" | head -4 | cut -c1-300
echo "repository after: $(df -h $MNT | tail -1 | awk '{print $3" used, "$4" free"}'); $(ls $MNT/repo/backup/exdbnode | tr '\n' ' ')"
echo "pgbackrest info: $(runuser -u postgres -- pgbackrest --stanza=exdbnode info 2>&1 | grep -E 'status|backup:' | tr -s ' ' | tr '\n' '|' | cut -c1-300)"
echo "== WAL archiving into the full repository, 90 s later"
sleep 90
DB=postgres psqlx "SELECT 'archived='||archived_count||' failed='||failed_count||' last_failed_wal='||coalesce(last_failed_wal,'-')||' last_failed_time='||coalesce(to_char(last_failed_time AT TIME ZONE 'UTC','HH24:MI:SS'),'-')||' last_archived_wal='||last_archived_wal FROM pg_stat_archiver"
echo "pg_wal files: $(ls /var/lib/postgresql/17/exdbnode/pg_wal | wc -l), .ready backlog: $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready)"
grep -E "archive command failed|No space" /var/log/postgresql/postgresql-17-exdbnode.log | tail -2 | cut -c1-260
echo "pgbackrest check: $(runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -4 | tr '\n' '|' | cut -c1-500)"
echo "helper backup.list still answers: $(c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -c '.error // {backups:(.result.backups|length)}')"
note "repofull" "incremental into 1.7 GB loop repo" "" "" "state=$LASTSTATE"
pkill pgbench; sleep 1
echo "== way forward: grow the filesystem online; the archive backlog must drain and the next backup must work"
truncate -s 4G $IMG; L=$(losetup -j $IMG | cut -d: -f1); losetup -c $L; resize2fs $L 2>&1 | tail -1
for i in $(seq 1 45); do n=$(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready); [ "$n" -le 1 ] && break; sleep 2; done
echo "backlog after growing: $(ls /var/lib/postgresql/17/exdbnode/pg_wal/archive_status | grep -c ready) ready; $(DB=postgres psqlx "SELECT 'failed='||failed_count||' last_archived='||last_archived_wal FROM pg_stat_archiver")"
BKMAX=600 bk incremental
echo "== cleanup"
cp -p /srv/work/s2/xfer/saved-pgbackrest.conf $CONF; umount $MNT; losetup -D; rm -f $IMG; systemctl stop exponetdb-node-helper.service 2>/dev/null
sleep 8; runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1
echo "main repository: $(runuser -u postgres -- pgbackrest --stanza=exdbnode info | grep -E 'min/max' | tr -s ' ')"
echo F1C-DONE
