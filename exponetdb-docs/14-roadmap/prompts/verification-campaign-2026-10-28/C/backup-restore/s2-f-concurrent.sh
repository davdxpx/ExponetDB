# Phase F3: a restore started while a backup runs, and a backup started while a restore runs (helper level, same repository)
source /srv/work/s2/scripts/s2-lib.sh
exec > >(tee -a $LOGS/f3-concurrent.log) 2>&1
mode owned; bind
T='{"label":null,"time":null,"lsn":null,"timeline":null}'
echo "== restore started 3 s after a full backup began"
RB=$(rid); T0=$(ts)
c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RB\",\"kind\":\"full\",\"databases\":[]}" | jq -c '.error // {backup:.result.runId}'
sleep 3
RR=$(rid)
prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RR\",\"purpose\":\"drill\",\"target\":$T}"); echo "prepare: $(echo "$prep"|jq -c '.error // {port:.result.port,refusals:.result.refusals}')"
port=$(echo "$prep"|jq -r '.result.port // empty')
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RR\",\"purpose\":\"drill\",\"target\":$T,\"port\":$port,\"checks\":[\"recovery_target_reached\",\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // {restore:.result.runId}'
ob=$(wait_run $RB 900); orr=$(wait_run $RR 900)
echo "backup: $(echo "$ob"|jq -c '.result|{state,exitCode,label:.outcome.label}'); restore: $(echo "$orr"|jq -c '.result|{state,exitCode,reached:.outcome.recoveryReachedLsn}') total $(echo "$(ts) - $T0"|bc)s"
restore_discard $RR
echo "== backup started 10 s after a restore began"
RR=$(rid); prep=$(c restore.prepare "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RR\",\"purpose\":\"drill\",\"target\":$T}"); port=$(echo "$prep"|jq -r .result.port)
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RR\",\"purpose\":\"drill\",\"target\":$T,\"port\":$port,\"checks\":[\"recovery_target_reached\",\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // {restore:.result.runId}'
sleep 10
RB=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RB\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // {backup:.result.runId}'
ob=$(wait_run $RB 900); orr=$(wait_run $RR 900)
echo "backup: $(echo "$ob"|jq -c '.result|{state,exitCode,label:.outcome.label}'); restore: $(echo "$orr"|jq -c '.result|{state,exitCode}')"
restore_discard $RR
echo "== second backup while a backup runs (domain exclusivity)"
RB=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RB\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // {backup:.result.runId}'
sleep 2; RB2=$(rid); c backup.run "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$RB2\",\"kind\":\"incremental\",\"databases\":[]}" | jq -c '.error // {second:.result.runId}'
wait_run $RB 900 | jq -c '.result|{state,exitCode}'
echo F3-DONE
