source /root/lab/lib.sh
exec > >(tee $LOGS/t3b-hardreset-pre.log) 2>&1
mode owned; bind
R=$(rid); T0=$(date -u +%H:%M:%S); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"kind\":\"full\",\"databases\":[]}" | jq -c .
echo $R > $LOGS/reboot-run2; echo "started $T0 (record startedAt: $(jq -r .startedAt /var/lib/exponetdb-node-engine/runs/$R/record.json))"
sleep 4; echo "unit: $(systemctl is-active exponetdb-run-$R.service); status: $(status $R | jq -c '.result|{state,startedAt}')"
echo "uptime: $(uptime -s); rebooting at $(date -u +%H:%M:%S)"
sync; echo 1 > /proc/sys/kernel/sysrq; (sleep 1; echo b > /proc/sysrq-trigger) &
