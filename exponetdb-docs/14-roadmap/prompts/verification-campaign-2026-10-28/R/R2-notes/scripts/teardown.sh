systemctl stop exponetdb-node-helper.socket exponetdb-node-helper.service 2>/dev/null
for u in $(systemctl list-units --no-legend 'exponetdb-run-*' | awk '{print $1}'); do systemctl stop $u 2>/dev/null; done
pg_dropcluster --stop 17 exdbnode 2>/dev/null
rm -rf /var/lib/pgbackrest /etc/pgbackrest /var/log/pgbackrest /var/spool/pgbackrest /var/lib/exponetdb-node-engine/runs/* /var/lib/exponetdb-node-engine/scratch/* /root/lab/logs/* /var/lib/c35 /var/lib/restic-repo-r2
rm -f /etc/exponetdb-node/repositories/*/mode
echo "teardown done: $(pg_lsclusters -h | wc -l) clusters, /etc/pgbackrest: $(ls /etc/pgbackrest 2>&1 | head -1)"
