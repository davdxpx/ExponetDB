# Phase E0: fresh baseline for the failure cases: a new FULL (so a restore replays little WAL) and a short marker/pgbench period after it
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/e0-fprep.log) 2>&1
mode owned; bind
marker_up
runuser -u postgres -- nice pgbench -c 4 -j 2 -R 300 -T 100 -P 20 -p 55417 app > $LOGS/pgbench-e0.log 2>&1 &
sleep 8
bk full
sleep 95
marker_down
archive_catchup
runuser -u postgres -- pgbackrest --stanza=exdbnode check 2>&1 | tail -1
echo "final marker: $(tail -1 $MARKLOG)"
echo "backups: $($PGB info --output=json | jq -r '.[0].backup|map(.label)|join(" ")')"
echo E0-DONE
