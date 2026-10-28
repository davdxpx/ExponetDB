source /root/lab/lib.sh
exec > >(tee $LOGS/t3b-hardreset-post.log) 2>&1
R=$(cat $LOGS/reboot-run2)
echo "boot at: $(uptime -s); now $(date -u +%H:%M:%S); record startedAt $(jq -r .startedAt /var/lib/exponetdb-node-engine/runs/$R/record.json)"
echo "units: $(systemctl list-units 'exponetdb-run-*' --all --no-legend | wc -l) exponetdb-run-*; pgbackrest procs: $(pgrep -fc 'pgbackrest|engine-run')"
prev=""
for i in $(seq 1 60); do
  o=$(status $R); s=$(echo "$o" | jq -c 'if .result then (.result|{state,finishedAt}) else .error end')
  [ "$s" != "$prev" ] && echo "$(date -u +%H:%M:%S) $s"; prev="$s"
  [ "$(echo "$o" | jq -r .result.state)" = lost ] && break; sleep 5
done
echo "$o" | jq -c .result
ls -la /var/lib/exponetdb-node-engine/runs/$R
echo "nothing restarted: units=$(systemctl list-units 'exponetdb-run-*' --all --no-legend | wc -l) procs=$(pgrep -fc 'pgbackrest|engine-run')"
echo "-- postgres recovered after crash:"; pg_lsclusters -h | grep exdbnode; tail -5 /var/log/postgresql/postgresql-17-exdbnode.log
echo "-- repo after hard reset"; runuser -u postgres -- pgbackrest --stanza=exdbnode info | grep -E "status|backup:" | tail -4
