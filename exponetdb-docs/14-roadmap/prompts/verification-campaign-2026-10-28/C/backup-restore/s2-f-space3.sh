# Phase F2c: restore without disk space on the real filesystem: a filler file leaves 5 GB free where 7.7 GB (+10 %) are needed. A guard stops the run unit at 400 MB free.
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/f2c-space.log) 2>&1
E=/var/lib/exponetdb-node-engine; mode owned; bind
avail=$(df -B1 --output=avail $E | tail -1); fill=$(( avail - 5*1024*1024*1024 ))
fallocate -l $fill /var/lib/s2-filler && echo "filler $((fill/1048576)) MiB; free now: $(df -h $E | tail -1 | awk '{print $4}')"
R=$(rid); T0=$(ts); T='{"label":null,"time":null,"lsn":null,"timeline":null}'
prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$T}")
echo "restore.prepare ($(echo "$(ts) - $T0"|bc)s): $(echo "$prep" | jq -c '.error // .result')"
port=$(echo "$prep" | jq -r '.result.port // 55400')
echo "== restore.execute with the same run id (stale or hand-made request)"
T1=$(ts)
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$T,\"port\":$port,\"checks\":[\"recovery_target_reached\"],\"rowCounts\":[]}" | jq -c '.error // {started:.result.runId}'
for i in $(seq 1 60); do sleep 2; a=$(df -B1 --output=avail $E | tail -1); echo "  t+$((i*2))s free $((a/1048576)) MiB"
  [ "$a" -lt 419430400 ] && { echo "GUARD: stopping the run unit"; systemctl stop exponetdb-run-$R.service; break; }
  st=$(status $R 2>/dev/null | python3 -c "import sys,json;d=json.load(sys.stdin);print(d.get('result',{}).get('state') or d.get('error'))" 2>/dev/null); case "$st" in succeeded|failed|canceled|lost) break;; esac; done
out=$(status $R); echo "execute: state=$(echo "$out"|jq -r .result.state) exit=$(echo "$out"|jq -r .result.exitCode) after $(echo "$(ts) - $T1"|bc)s"
echo "$out" | jq -r .result.excerpt | grep -E "ERROR|No space|space|FATAL|panic" | head -4 | cut -c1-260
restore_discard $R
rm -f /var/lib/s2-filler; echo "filler removed; free: $(df -h $E | tail -1 | awk '{print $4}')"
echo F2C-DONE
