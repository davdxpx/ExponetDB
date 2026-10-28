source /root/lab/lab.env; source /root/lab/lib.sh
exec > >(tee $LOGS/t46-space.log) 2>&1
NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
mode owned; bind
echo "=== T-NODE-4 too little space: engine directory on a 512 MB tmpfs"
systemctl stop exponetdb-node-helper.socket exponetdb-node-helper.service
mkdir -p /root/lab/engine-aside; cp -a /var/lib/exponetdb-node-engine/. /root/lab/engine-aside/ 2>/dev/null
mount -t tmpfs -o size=120m,mode=0711 tmpfs /var/lib/exponetdb-node-engine; systemd-tmpfiles --create /usr/lib/tmpfiles.d/exponetdb-node-engine.conf
df -h /var/lib/exponetdb-node-engine | tail -1
systemctl start exponetdb-node-helper.socket
R=$(rid); B="scratch=$(ls /var/lib/exponetdb-node-engine/scratch|wc -l) runs=$(ls /var/lib/exponetdb-node-engine/runs|wc -l)"
echo "prepare: $(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT}" | jq -c '.error // .result|{spaceAvailableBytes,spaceRequiredBytes,refusals,scratchFree}')"
echo "execute: $(c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT,\"port\":55400,\"checks\":[\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // .result')"
sleep 5; out=$(status $R 2>/dev/null | jq -c '.result|{state,excerpt:(.excerpt|.[0:240])}' 2>/dev/null); echo "run status if one started: $out"
echo "before $B; after scratch=$(ls /var/lib/exponetdb-node-engine/scratch|wc -l) runs=$(ls /var/lib/exponetdb-node-engine/runs|wc -l); tmpfs use: $(df -h /var/lib/exponetdb-node-engine | tail -1 | awk '{print $3"/"$2}')"
wait_run $R 120 >/dev/null 2>&1; c restore.discard "{\"runId\":\"$R\"}" | jq -c '.result'
systemctl stop exponetdb-node-helper.socket exponetdb-node-helper.service; umount /var/lib/exponetdb-node-engine; echo "umounted; real engine dir runs=$(ls /var/lib/exponetdb-node-engine/runs|wc -l)"
systemctl start exponetdb-node-helper.socket
