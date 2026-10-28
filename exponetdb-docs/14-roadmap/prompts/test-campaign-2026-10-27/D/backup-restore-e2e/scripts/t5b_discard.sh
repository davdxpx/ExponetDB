source /root/lab/lib.sh
exec > >(tee $LOGS/t5b-verify-discard.log) 2>&1
SCR=/var/lib/exponetdb-node-engine/scratch; RUNS=/var/lib/exponetdb-node-engine/runs
read LATEST PITR2 PITR1 < $LOGS/restore-runs
DATA=/var/lib/postgresql/17/exdbnode
fp() { echo "pid=$(head -1 $DATA/postmaster.pid) sysid=$(sysid) accounts=$(psqlx 'SELECT count(*) FROM accounts') datafiles=$(find $DATA -type f | wc -l) bigsize=$(du -sb $DATA | cut -f1)"; }
echo "registered cluster BEFORE: $(fp)"
echo "=== restore.verify of a stopped scratch (drill latest run)"
T0=$(ts); RV=$(rid); c restore.verify "{\"runId\":\"$LATEST\",\"verifyRunId\":\"$RV\",\"port\":55400,\"checks\":[\"probe_simple\",\"amcheck\",\"row_counts\"]}" | jq -c '.error // .result'
wait_run $RV 600 | jq -c '.result|{state,checks:[.outcome.checks[]|{check,outcome}]}'; echo "reverify took $(echo "$(ts) - $T0"|bc)s"
echo "=== discard"
ls $SCR
for R in $LATEST $PITR2; do T0=$(ts); echo "discard $R: $(c restore.discard "{\"runId\":\"$R\"}" | jq -c '.error // .result') in $(echo "$(ts) - $T0"|bc)s; exists after: $(test -e $SCR/$R && echo YES || echo no)"; done
echo "discard again (idempotent): $(c restore.discard "{\"runId\":\"$PITR2\"}" | jq -c '.error // .result')"
echo "discard of an unknown run id: $(c restore.discard "{\"runId\":\"$(rid)\"}" | jq -c '.error // .result')"
BK=$(cat $LOGS/last-full-run); echo "discard of a BACKUP run id ($BK): $(c restore.discard "{\"runId\":\"$BK\"}" | jq -c '.error // .result'); backup run dir still: $(test -d $RUNS/$BK && echo yes)"
echo "discard of a malformed id: $(c restore.discard '{"runId":"../../var/lib/postgresql"}' | jq -c '.error // .result')"
echo "=== symlink trap: scratch/<id> replaced by a symlink to a decoy directory"
install -d -o postgres -g postgres -m0700 /var/lib/decoy-data; echo precious > /var/lib/decoy-data/file; chown postgres: /var/lib/decoy-data/file
mv $SCR/$PITR1 /root/lab/aside-$PITR1; ln -s /var/lib/decoy-data $SCR/$PITR1
echo "discard through symlink: $(c restore.discard "{\"runId\":\"$PITR1\"}" | jq -c '.error // .result')"
echo "decoy intact: $(cat /var/lib/decoy-data/file 2>&1); symlink still: $(ls -ld $SCR/$PITR1 2>&1|cut -c1-90)"
rm -f $SCR/$PITR1; mv /root/lab/aside-$PITR1 $SCR/$PITR1; echo "discard restored dir: $(c restore.discard "{\"runId\":\"$PITR1\"}" | jq -c '.error // .result')"
echo "=== discard WHILE a restore runs (stops the scratch postmaster and unit)"
R=$(rid); NULLT='{"label":null,"time":null,"lsn":null,"timeline":null}'
c restore.execute "{\"cluster\":$CLUSTER,\"repository\":$REPOJ,\"runId\":\"$R\",\"purpose\":\"drill\",\"target\":$NULLT,\"port\":55400,\"checks\":[\"probe_simple\"],\"rowCounts\":[]}" | jq -c '.error // .result|{runId}'
sleep 6; echo "unit: $(systemctl is-active exponetdb-run-$R.service); scratch: $(ls $SCR/$R|head -3|tr '\n' ' ')"
T0=$(ts); echo "discard: $(c restore.discard "{\"runId\":\"$R\"}" | jq -c '.error // .result') in $(echo "$(ts) - $T0"|bc)s"
echo "after: unit=$(systemctl is-active exponetdb-run-$R.service) scratch=$(test -e $SCR/$R && echo YES || echo no) procs=$(pgrep -fc "$SCR/$R")"
echo "run.status after discard: $(status $R | jq -c '.result|{state}')"
echo "=== remaining scratch dirs: $(ls $SCR | tr '\n' ' ')"
echo "registered cluster AFTER: $(fp)"
