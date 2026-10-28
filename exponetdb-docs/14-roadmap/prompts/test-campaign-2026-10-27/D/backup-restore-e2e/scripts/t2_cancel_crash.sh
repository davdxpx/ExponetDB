source /root/lab/lib.sh
exec > >(tee $LOGS/t2-cancel-helperkill.log) 2>&1
startfull() { local R=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"${1:-full}\",\"databases\":[]}" >/dev/null && echo $R; }
mode owned; bind
echo "=== A. uninterrupted full of $(psqlx "SELECT pg_size_pretty(pg_database_size(\$\$app\$\$))") for timing"
T0=$(ts); R=$(startfull); out=$(wait_run $R 900); T1=$(ts)
echo "full: $(echo "$T1 - $T0"|bc)s state=$(echo "$out"|jq -r .result.state) label=$(echo "$out"|jq -r .result.outcome.label)"
echo "=== B. run.cancel during a full backup"
T0=$(ts); R=$(startfull); sleep 3
systemctl is-active exponetdb-run-$R.service
c run.cancel "{\"runId\":\"$R\"}"; echo "cancel call at $(echo "$(ts) - $T0"|bc)s"
sleep 1; echo "-- units now:"; systemctl list-units 'exponetdb*' 'run-*' --all --no-pager | head -8
out=$(wait_run $R 300); echo "$out" | jq -c '.result|{state,exitCode,excerpt:(.excerpt|tostring|.[0:300])}'
echo "terminal after $(echo "$(ts) - $T0"|bc)s"
echo "-- processes after cancel:"; pgrep -fa 'pgbackrest|engine-run' || echo none
echo "-- record/result perms:"; stat -c '%U:%G %a %n' /var/lib/exponetdb-node-engine/runs/$R/*
ls /var/lib/exponetdb-node-engine/runs/$R/; cat /var/lib/exponetdb-node-engine/runs/$R/cancel.json 2>/dev/null | head -5
echo "-- cancel again (already finished):"; c run.cancel "{\"runId\":\"$R\"}"
echo "-- repo state: partial backup dirs"; ls -la /var/lib/pgbackrest/backup/exdbnode/ | tail -12
runuser -u postgres -- pgbackrest --stanza=exdbnode check && echo "pgbackrest check ok"
c backup.list "{\"cluster\":$CLUSTER,\"repository\":$REPOJ}" | jq -r '.result.backups|map(.label)|join("\n")'
echo "=== C. kill -9 the root helper mid-run (run unit must survive, status continues)"
T0=$(ts); R=$(startfull); sleep 3
HP=$(systemctl show -p MainPID --value exponetdb-node-helper.service); echo "helper pid $HP active=$(systemctl is-active exponetdb-node-helper.service)"
kill -9 $HP; sleep 1
echo "helper after kill: $(systemctl is-active exponetdb-node-helper.service); run unit: $(systemctl is-active exponetdb-run-$R.service)"
out=$(wait_run $R 900); T1=$(ts)
echo "helper restarted by socket: $(systemctl is-active exponetdb-node-helper.service) pid=$(systemctl show -p MainPID --value exponetdb-node-helper.service)"
echo "full (helper killed): $(echo "$T1 - $T0"|bc)s state=$(echo "$out"|jq -r .result.state) label=$(echo "$out"|jq -r .result.outcome.label)"
journalctl -u exponetdb-node-helper.service --no-pager -o cat | tail -8
