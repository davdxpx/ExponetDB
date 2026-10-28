source /root/lab/lib.sh
exec > >(tee $LOGS/t3-reboot-post.log) 2>&1
R=$(cat $LOGS/reboot-run)
echo "boot at: $(uptime -s); now $(date -u +%H:%M:%S); record startedAt $(jq -r .startedAt /var/lib/exponetdb-node-engine/runs/$R/record.json)"
echo "helper socket: $(systemctl is-active exponetdb-node-helper.socket); service: $(systemctl is-active exponetdb-node-helper.service)"
echo "units: $(systemctl list-units 'exponetdb-run-*' --all --no-legend | wc -l) exponetdb-run-* ; pgbackrest procs: $(pgrep -fc 'pgbackrest|engine-run')"
echo "pg cluster: $(pg_lsclusters -h | grep exdbnode)"
for i in $(seq 1 30); do
  echo "$(date -u +%H:%M:%S) status: $(status $R | jq -c '.result|{state,finishedAt,excerpt:(.excerpt|.[0:120])}')"
  st=$(status $R | jq -r .result.state); [ "$st" = lost ] && break; sleep 10
done
echo "units after: $(systemctl list-units 'exponetdb-run-*' --all --no-legend | wc -l); pgbackrest procs: $(pgrep -fc 'pgbackrest|engine-run')"
ls -la /var/lib/exponetdb-node-engine/runs/$R; stat -c '%U:%G %a %n' /var/lib/exponetdb-node-engine/runs/$R/*
echo "no automatic restart check: backup dirs"; ls /var/lib/pgbackrest/backup/exdbnode/ | tail -4
